import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, rename, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { encryptSession, decryptSession } from "../src/session-crypto.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskPage, StandingHistoryTaskStoreError, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";

const intent = (): StandingHistoryTaskIntent => ({ schema: "standing-history-task-v1", taskId: "htask_" + "1".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 789, fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Разобрать историю обсуждения" });
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(resolve(tmpdir()), "neurobro-history-store-"));
  t.after(async () => { assert.ok(directory.startsWith(join(resolve(tmpdir()), "neurobro-history-store-"))); await rm(directory, { recursive: true, force: true }); });
  const args = { directory, passphrase: "synthetic-history-task-passphrase", intent: intent() };
  return { args, slot: join(directory, args.intent.taskId) };
}
const code = (expected: string) => (e: unknown) => e instanceof StandingHistoryTaskStoreError && e.code === expected;
function nextPage(before: SelfHistoryTaskCheckpoint, messageId = 100, own = false): SelfHistoryTaskPage {
  const date = before.lastDate - 1, ref = "m_" + messageId.toString(16).padStart(24, "0"), authorId = own ? before.accountId : "456";
  const next = { ...before, offsetId: messageId, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date, pages: before.pages + 1,
    upperBoundMessageId: before.upperBoundMessageId ?? messageId };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: [{ messageId, date, disposition: "included", messageRef: ref, authorId }],
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: [{ ref, authorRef: own ? "neurobro" : "a_" + "2".repeat(24), author: own ? "self" : "user", displayName: own ? "Нейробро" : "Участник",
        date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Сохранённый исходный текст " + messageId }], cursor: null, hasMore: true, status: "more",
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: false, undatedEntries: next.undated, pages: next.pages },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
async function created(f: Awaited<ReturnType<typeof fixture>>) { return openStandingHistoryTaskStore({ ...f.args, mode: "create" }); }
test("immutable intent and full page/source/checkpoint chain reopen without claiming model progress", async t => {
  const f = await fixture(t), store = await created(f), initial = await store.status();
  assert.equal(initial.readProgress.committedPages, 0); assert.equal(initial.modelProgress, "not-recorded"); assert.equal(initial.storage, "ready");
  const first = nextPage(initial.readProgress.checkpoint, 100, true), saved = await store.appendPage({ expectedCheckpoint: initial.readProgress.checkpoint, result: first });
  const second = nextPage(saved.readProgress.checkpoint, 99); await store.appendPage({ expectedCheckpoint: saved.readProgress.checkpoint, result: second }); await store.close();
  const names = await readdir(f.slot); assert.deepEqual(names, ["intent.enc", "page-000001.enc", "page-000002.enc"]);
  const ciphertext = await readFile(join(f.slot, "page-000001.enc"), "utf8");
  for (const raw of ["Сохранённый исходный текст", "beforeCheckpoint", "messageId", "-100456", "neurobro-self-history-v1"]) assert.equal(ciphertext.includes(raw), false);
  const reopened = await openStandingHistoryTaskStore({ ...f.args, mode: "open" });
  const status = await reopened.status(); assert.equal(status.readProgress.committedPages, 2); assert.equal(status.modelProgress, "not-recorded");
  assert.deepEqual((await reopened.readPage(1))!.result, first); assert.deepEqual((await reopened.readPage(2))!.result, second);
  assert.equal(await reopened.readPage(3), undefined); await reopened.close();
});
test("append snapshots all caller-owned row/source graphs before awaiting filesystem work", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint, page = structuredClone(nextPage(before));
  const pending = store.appendPage({ expectedCheckpoint: before, result: page });
  (page.page.messages[0] as { text: string }).text = "changed"; (page.sources[0] as { messageId: number }).messageId = 999;
  await pending; const saved = (await store.readPage(1))!.result; assert.equal(saved.sources[0]!.messageId, 100); assert.notEqual(saved.page.messages[0]!.text, "changed");
  assert.ok(Object.isFrozen(saved.sources[0])); assert.ok(Object.isFrozen(saved.page.messages[0])); await store.close();
});
test("CAS refusal cannot advance checkpoint, overwrite a prior page, or append to a terminal frontier", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint, first = nextPage(before);
  const committed = await store.appendPage({ expectedCheckpoint: before, result: first });
  await assert.rejects(store.appendPage({ expectedCheckpoint: before, result: first }), code("conflict"));
  const empty: SelfHistoryTaskPage = { beforeCheckpoint: committed.readProgress.checkpoint, nextCheckpoint: { ...committed.readProgress.checkpoint, pages: 2, status: "empty-page" }, sources: [],
    page: { ...first.page, messages: [], hasMore: false, status: "empty-page", coverage: { ...first.page.coverage, traversalComplete: true, pages: 2 } } };
  const final = await store.appendPage({ expectedCheckpoint: committed.readProgress.checkpoint, result: empty });
  assert.equal(final.readProgress.checkpoint.status, "empty-page"); assert.equal(final.modelProgress, "not-recorded");
  await assert.rejects(store.appendPage({ expectedCheckpoint: final.readProgress.checkpoint, result: nextPage(final.readProgress.checkpoint, 98) }));
  assert.deepEqual(await readdir(f.slot), ["intent.enc", "page-000001.enc", "page-000002.enc"]); await store.close();
});
test("lost uncommitted result permits same read frontier, lost append acknowledgment recovers committed frontier", async t => {
  const f = await fixture(t), first = await created(f), before = (await first.status()).readProgress.checkpoint;
  nextPage(before); await first.close(); const second = await openStandingHistoryTaskStore({ ...f.args, mode: "open" });
  assert.deepEqual((await second.status()).readProgress.checkpoint, before);
  await second.appendPage({ expectedCheckpoint: before, result: nextPage(before) }); await second.close();
  const third = await openStandingHistoryTaskStore({ ...f.args, mode: "open" }); assert.equal((await third.status()).readProgress.checkpoint.offsetId, 100);
  await assert.rejects(third.appendPage({ expectedCheckpoint: before, result: nextPage(before) }), code("conflict")); await third.close();
});
test("partial/corrupt and gapped tails preserve last authenticated prefix and permanently refuse append", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint;
  const saved = await store.appendPage({ expectedCheckpoint: before, result: nextPage(before) }); await store.close();
  for (const filename of ["page-000002.enc", "page-000003.enc"]) {
    await writeFile(join(f.slot, filename), "retained partial ciphertext");
    const reopened = await openStandingHistoryTaskStore({ ...f.args, mode: "open" }), status = await reopened.status();
    assert.equal(status.storage, "tail-refused"); assert.equal(status.readProgress.committedPages, 1); assert.equal((await reopened.readPage(1))!.result.sources[0]!.messageId, 100);
    await assert.rejects(reopened.appendPage({ expectedCheckpoint: saved.readProgress.checkpoint, result: nextPage(saved.readProgress.checkpoint, 99) }), code("tail"));
    await reopened.close(); assert.equal(await readFile(join(f.slot, filename), "utf8"), "retained partial ciphertext");
    await rename(join(f.slot, filename), join(f.args.directory, "retained-" + filename));
  }
});
test("authenticated wrong prior hash or inconsistent consumed source never advances restored checkpoint", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint, first = await store.appendPage({ expectedCheckpoint: before, result: nextPage(before) });
  await store.appendPage({ expectedCheckpoint: first.readProgress.checkpoint, result: nextPage(first.readProgress.checkpoint, 99) }); await store.close();
  const path = join(f.slot, "page-000002.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  for (const mutate of [(v: typeof original) => { v.previousHash = "0".repeat(64); }, (v: typeof original) => { v.result.sources[0].messageId = 98; },
    (v: typeof original) => { v.intentHash = "0".repeat(64); }, (v: typeof original) => { v.result.beforeCheckpoint.chatId = "-100999"; }]) {
    const changed = structuredClone(original); mutate(changed); await writeFile(path, await encryptSession(JSON.stringify(changed), f.args.passphrase));
    const reopened = await openStandingHistoryTaskStore({ ...f.args, mode: "open" }); assert.equal((await reopened.status()).storage, "tail-refused");
    assert.equal((await reopened.status()).readProgress.committedPages, 1); await reopened.close();
  }
});
test("task intent binds requester/primary/objective/timezone and wrong passphrase cannot open it", async t => {
  const f = await fixture(t), store = await created(f); await store.close();
  for (const edit of [{ requesterId: "457" }, { primaryMessageId: 790 }, { objective: "Different objective" }, { timezone: "UTC" }, { accountId: "124" }, { toDate: 201 }])
    await assert.rejects(openStandingHistoryTaskStore({ ...f.args, mode: "open", intent: { ...intent(), ...edit } }), code("binding"));
  await assert.rejects(openStandingHistoryTaskStore({ ...f.args, mode: "open", passphrase: "wrong-but-long-passphrase" }), code("storage"));
  await assert.rejects(created(f), code("consumed"));
});
test("open is noncreating; incomplete intent remains consumed and untouched", async t => {
  const f = await fixture(t); await assert.rejects(openStandingHistoryTaskStore({ ...f.args, mode: "open" })); assert.deepEqual(await readdir(f.args.directory), []);
  await mkdir(f.slot); await writeFile(join(f.slot, "intent.enc"), "partial intent");
  await assert.rejects(openStandingHistoryTaskStore({ ...f.args, mode: "open" }), code("storage")); await assert.rejects(created(f), code("consumed"));
  assert.equal(await readFile(join(f.slot, "intent.enc"), "utf8"), "partial intent");
});
test("hardlinked pages, junction task directories and root substitution are refused", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint;
  await store.appendPage({ expectedCheckpoint: before, result: nextPage(before) }); await store.close();
  await link(join(f.slot, "page-000001.enc"), join(f.args.directory, "page-hardlink.enc"));
  const refused = await openStandingHistoryTaskStore({ ...f.args, mode: "open" }); assert.equal((await refused.status()).storage, "tail-refused"); assert.equal((await refused.status()).readProgress.committedPages, 0); await refused.close();
  const moved = join(f.args.directory, "real-task"); await rename(f.slot, moved); await symlink(moved, f.slot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(openStandingHistoryTaskStore({ ...f.args, mode: "open" }));
  const g = await fixture(t), current = await created(g); const relocated = join(g.args.directory, "original-task"); await rename(g.slot, relocated); await mkdir(g.slot);
  await assert.rejects(current.status(), code("storage")); await current.close();
});
test("two reopened stores cannot commit competing second pages", async t => {
  const f = await fixture(t), first = await created(f), before = (await first.status()).readProgress.checkpoint; await first.close();
  const a = await openStandingHistoryTaskStore({ ...f.args, mode: "open" }), b = await openStandingHistoryTaskStore({ ...f.args, mode: "open" });
  const results = await Promise.allSettled([a.appendPage({ expectedCheckpoint: before, result: nextPage(before, 100) }), b.appendPage({ expectedCheckpoint: before, result: nextPage(before, 99) })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); await a.close(); await b.close();
  const reopened = await openStandingHistoryTaskStore({ ...f.args, mode: "open" }); assert.equal((await reopened.status()).readProgress.committedPages, 1); await reopened.close();
});
test("aborted creation is noncreating; close revokes and joins admitted append", async t => {
  const f = await fixture(t), aborted = new AbortController(); aborted.abort();
  await assert.rejects(openStandingHistoryTaskStore({ ...f.args, mode: "create", signal: aborted.signal }), code("aborted")); assert.deepEqual(await readdir(f.args.directory), []);
  const store = await created(f), before = (await store.status()).readProgress.checkpoint; let settled = false;
  const pending = store.appendPage({ expectedCheckpoint: before, result: nextPage(before) }).then(() => { settled = true; }, e => { settled = true; assert.ok(code("closed")(e)); });
  await assert.rejects(store.status(), code("busy")); await immediate(); await store.close(); await pending; assert.equal(settled, true);
  await assert.rejects(store.status(), code("closed"));
  const reopened = await openStandingHistoryTaskStore({ ...f.args, mode: "open" }); const progress = await reopened.status(); assert.ok(progress.readProgress.committedPages <= 1); await reopened.close();
});
test("hostile page graphs execute no accessors and refuse before adding disk state", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint, valid = nextPage(before); let calls = 0;
  for (const value of [{ ...valid, get sources() { calls++; return []; } }, new Proxy(valid, { getPrototypeOf() { calls++; throw Error(); } }),
    { ...valid, page: { ...valid.page, messages: [{ ...valid.page.messages[0], get text() { calls++; return "bad"; } }] } }, { ...valid, sources: Array(2) }])
    await assert.rejects(store.appendPage({ expectedCheckpoint: before, result: value as never }));
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.slot), ["intent.enc"]); await store.close();
});
test("page/source/coverage mismatches and foreign own aliases are rejected while actual own alias is admitted", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint, valid = nextPage(before), own = nextPage(before, 100, true);
  assert.deepEqual(snapshotStandingHistoryTaskPage(own), own);
  for (const mutate of [(v: any) => { v.nextCheckpoint.offsetId = 99; }, (v: any) => { v.sources[0].messageRef = "m_" + "f".repeat(24); },
    (v: any) => { v.page.coverage.traversalComplete = true; }, (v: any) => { v.page.excluded.nonText = 1; }, (v: any) => { v.nextCheckpoint.upperBoundMessageId = 101; },
    (v: any) => { v.page.messages[0].authorRef = "neurobro"; }, (v: any) => { v.page.messages[0].author = "self"; },
    (v: any) => { v.page.cursor = "old-native-cursor"; }, (v: any) => { v.page.messages[0].text = "x".repeat(16385); }, (v: any) => { v.sources.push(v.sources[0]); }]) {
    const changed = structuredClone(valid); mutate(changed); assert.throws(() => snapshotStandingHistoryTaskPage(changed));
  }
  await store.close();
});
test("inaccessible durable read frontier is terminal reading state with no implied analysis", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint, template = nextPage(before);
  const result: SelfHistoryTaskPage = { beforeCheckpoint: before, nextCheckpoint: { ...before, status: "inaccessible" }, sources: [], page: { ...template.page,
    messages: [], hasMore: false, status: "inaccessible", coverage: { scope: "available-history-snapshot", oldestExaminedDate: null, newestExaminedDate: null, traversalComplete: false, undatedEntries: 0, pages: 0 } } };
  const status = await store.appendPage({ expectedCheckpoint: before, result }); assert.equal(status.readProgress.committedPages, 1); assert.equal(status.readProgress.checkpoint.pages, 0);
  assert.equal(status.readProgress.checkpoint.status, "inaccessible"); assert.equal(status.modelProgress, "not-recorded"); await store.close();
});
test("page-local reply endpoints and bidirectional author aliases must agree with raw source IDs", async t => {
  const f = await fixture(t), store = await created(f), before = (await store.status()).readProgress.checkpoint, first = nextPage(before, 100), second = nextPage(first.nextCheckpoint, 99);
  const result: SelfHistoryTaskPage = { beforeCheckpoint: before, nextCheckpoint: { ...second.nextCheckpoint, pages: 1 },
    sources: [{ ...first.sources[0]!, replyToMessageId: 99 }, second.sources[0]!], page: { ...first.page,
      messages: [second.page.messages[0]!, { ...first.page.messages[0]!, replyRef: second.page.messages[0]!.ref }], coverage: { ...second.page.coverage, pages: 1 } } };
  const mutations = [(v: any) => { v.page.messages[1].replyRef = "m_" + "f".repeat(24); },
    (v: any) => { v.sources[0].replyToMessageId = 98; }, (v: any) => { v.page.messages[1].authorRef = "a_" + "f".repeat(24); },
    (v: any) => { v.sources[0].authorId = "457"; }];
  for (const mutate of mutations) { const changed = structuredClone(result); mutate(changed); await assert.rejects(store.appendPage({ expectedCheckpoint: before, result: changed })); }
  assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
  await store.appendPage({ expectedCheckpoint: before, result }); await store.close();
  const path = join(f.slot, "page-000001.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  for (const mutate of mutations) {
    const changed = structuredClone(original); mutate(changed.result); await writeFile(path, await encryptSession(JSON.stringify(changed), f.args.passphrase));
    const reopened = await openStandingHistoryTaskStore({ ...f.args, mode: "open" }), status = await reopened.status();
    assert.equal(status.storage, "tail-refused"); assert.equal(status.readProgress.committedPages, 0); await reopened.close();
  }
});
