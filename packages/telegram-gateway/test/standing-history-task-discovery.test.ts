import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rename, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { encryptSession, decryptSession } from "../src/session-crypto.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskDiscovery, StandingHistoryTaskDiscoveryError, type StandingHistoryTaskDiscoveryPage } from "../src/standing-history-task-discovery.js";

const intent = (n: number): StandingHistoryTaskIntent => ({ schema: "standing-history-task-v1", taskId: "htask_" + n.toString(16).padStart(48, "0"),
  accountId: "123", chatId: "-100456", requesterId: "456", primaryMessageId: 789 + n, fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Разобрать историю " + n });
async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(resolve(tmpdir()), "neurobro-history-discovery-"));
  t.after(async () => { assert.ok(parent.startsWith(join(resolve(tmpdir()), "neurobro-history-discovery-"))); await rm(parent, { recursive: true, force: true }); });
  return { parent, args: { directory: join(parent, "tasks"), passphrase: "synthetic-history-discovery-passphrase", accountId: "123", chatId: "-100456" } };
}
async function save(f: Awaited<ReturnType<typeof fixture>>, value: StandingHistoryTaskIntent) {
  await mkdir(f.args.directory, { recursive: true });
  const store = await openStandingHistoryTaskStore({ directory: f.args.directory, passphrase: f.args.passphrase, intent: value, mode: "create" }); await store.close();
  return join(f.args.directory, value.taskId, "intent.enc");
}
const code = (expected: string) => (e: unknown) => e instanceof StandingHistoryTaskDiscoveryError && e.code === expected;
async function all(discovery: Awaited<ReturnType<typeof openStandingHistoryTaskDiscovery>>, limit = 5) {
  let cursor: string | undefined; const tasks: StandingHistoryTaskIntent[] = []; let last: StandingHistoryTaskDiscoveryPage | undefined;
  for (let n = 0; n < 40; n++) {
    last = await discovery.find({ limit, ...(cursor ? { cursor } : {}) }); tasks.push(...last.tasks);
    if (!last.hasMore) return { tasks, last }; assert.ok(last.cursor); cursor = last.cursor;
  }
  throw Error("discovery pagination loop");
}
test("absent parent is noncreating and reports observed absence; later parent appears normally", async t => {
  const f = await fixture(t), discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close());
  assert.deepEqual(await discovery.find(), { tasks: [], hasMore: false, coverage: { complete: true, scanned: 0, unavailable: 0, foreign: 0, root: "absent" } });
  assert.deepEqual(await readdir(f.parent), []); await save(f, intent(1));
  const found = await discovery.find(); assert.deepEqual(found.tasks, [intent(1)]); assert.equal(found.coverage.root, "present"); assert.equal(found.coverage.complete, true);
});
test("real encrypted task intent discovery allows exact fresh store reopen without retained caller intent", async t => {
  const f = await fixture(t); await save(f, intent(1)); await save(f, intent(2));
  const discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close());
  const found = await all(discovery, 1); assert.deepEqual(found.tasks.map(i => i.taskId).sort(), [intent(1).taskId, intent(2).taskId]); assert.equal(found.last.coverage.complete, true);
  for (const discovered of found.tasks) {
    const reopened = await openStandingHistoryTaskStore({ directory: f.args.directory, passphrase: f.args.passphrase, intent: discovered, mode: "open" });
    assert.equal((await reopened.status()).readProgress.committedPages, 0); await reopened.close();
    assert.ok(Object.isFrozen(discovered));
  }
  for (const task of found.tasks) assert.deepEqual(await readdir(join(f.args.directory, task.taskId)), ["intent.enc"]);
});
test("foreign authenticated task bindings and invalid slots remain explicit coverage gaps", async t => {
  const f = await fixture(t); await save(f, intent(1)); await save(f, { ...intent(2), accountId: "124" }); await save(f, { ...intent(3), chatId: "-100457" });
  await mkdir(join(f.args.directory, intent(4).taskId)); await writeFile(join(f.args.directory, "unexpected.txt"), "unrelated");
  const discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close()); const result = await all(discovery);
  assert.deepEqual(result.tasks, [intent(1)]); assert.deepEqual(result.last.coverage, { complete: false, scanned: 5, unavailable: 2, foreign: 2, root: "present" });
});
test("cursor pagination crosses more than 128 prior entries without a total traversal ceiling", async t => {
  const f = await fixture(t); await save(f, intent(1));
  for (let n = 0; n < 145; n++) await mkdir(join(f.args.directory, "invalid-" + String(n).padStart(3, "0")));
  const discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close());
  const first = await discovery.find(); assert.equal(first.coverage.scanned, 16); assert.equal(first.hasMore, true); assert.equal(first.coverage.complete, false);
  const rest: StandingHistoryTaskIntent[] = [...first.tasks]; let page = first;
  for (let n = 0; page.hasMore && n < 20; n++) { page = await discovery.find({ cursor: page.cursor! }); rest.push(...page.tasks); }
  assert.equal(page.hasMore, false); assert.equal(page.coverage.scanned, 146); assert.equal(page.coverage.unavailable, 145); assert.deepEqual(rest, [intent(1)]);
});
test("continuations are opaque, single-use, scoped to limit and discovery instance", async t => {
  const f = await fixture(t); await save(f, intent(1)); await save(f, intent(2)); const discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close());
  const first = await discovery.find({ limit: 1 }); assert.ok(first.cursor); assert.match(first.cursor, /^hcur_[0-9a-f]{48}$/u);
  await assert.rejects(discovery.find({ limit: 2, cursor: first.cursor }), code("cursor"));
  const other = await openStandingHistoryTaskDiscovery(f.args); await assert.rejects(other.find({ limit: 1, cursor: first.cursor }), code("cursor")); await other.close();
  const second = await discovery.find({ limit: 1, cursor: first.cursor }); assert.notEqual(first.tasks[0]!.taskId, second.tasks[0]!.taskId);
  await assert.rejects(discovery.find({ limit: 1, cursor: first.cursor }), code("cursor"));
  const retained = await discovery.find({ limit: 1 }); for (let n = 0; n < 4; n++) await discovery.find({ limit: 1 });
  await assert.rejects(discovery.find({ limit: 1, cursor: retained.cursor! }), code("cursor"));
});
test("ciphertext task identity/domain/kind/schema must agree with the actual directory", async t => {
  const f = await fixture(t), path = await save(f, intent(1)), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  for (const mutate of [(v: typeof original) => { v.taskId = intent(2).taskId; }, (v: typeof original) => { v.intent.taskId = intent(2).taskId; },
    (v: typeof original) => { v.domain = "foreign"; }, (v: typeof original) => { v.kind = "page"; }, (v: typeof original) => { v.intent.schema = "other"; },
    (v: typeof original) => { v.extra = true; }]) {
    const changed = structuredClone(original); mutate(changed); await writeFile(path, await encryptSession(JSON.stringify(changed), f.args.passphrase));
    const discovery = await openStandingHistoryTaskDiscovery(f.args), found = await discovery.find(); assert.equal(found.tasks.length, 0); assert.equal(found.coverage.unavailable, 1); assert.equal(found.coverage.complete, false); await discovery.close();
  }
});
test("wrong password, partial cipher, oversized record and linked intent never become tasks", async t => {
  const f = await fixture(t), path = await save(f, intent(1)), original = await readFile(path);
  const wrong = await openStandingHistoryTaskDiscovery({ ...f.args, passphrase: "wrong-long-enough-passphrase" }); assert.equal((await wrong.find()).coverage.unavailable, 1); await wrong.close();
  for (const bytes of [Buffer.from("partial"), Buffer.alloc(192 * 1024 + 1, 65)]) {
    await writeFile(path, bytes); const discovery = await openStandingHistoryTaskDiscovery(f.args), found = await discovery.find();
    assert.equal(found.tasks.length, 0); assert.equal(found.coverage.unavailable, 1); await discovery.close(); assert.deepEqual(await readFile(path), bytes);
  }
  await writeFile(path, original); await link(path, join(f.parent, "linked-intent.enc"));
  const linked = await openStandingHistoryTaskDiscovery(f.args); assert.equal((await linked.find()).coverage.unavailable, 1); await linked.close();
});
test("junction slots cannot redirect intent reads and root substitution refuses further discovery", async t => {
  const f = await fixture(t); await save(f, intent(1)); const original = join(f.parent, "original-slot"), slot = join(f.args.directory, intent(1).taskId);
  await rename(slot, original); await symlink(original, slot, process.platform === "win32" ? "junction" : "dir");
  const discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close()); const found = await discovery.find();
  assert.equal(found.tasks.length, 0); assert.equal(found.coverage.unavailable, 1);
  await rename(f.args.directory, join(f.parent, "original-root")); await mkdir(f.args.directory);
  await assert.rejects(discovery.find(), code("storage"));
});
test("long escaped objectives stay under output bound, and a pending replaced intent is a gap", async t => {
  const f = await fixture(t); for (let n = 1; n <= 8; n++) await save(f, { ...intent(n), objective: '"'.repeat(4096) });
  const discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close());
  let page = await discovery.find({ limit: 10 }); assert.ok(page.hasMore); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32 * 1024); assert.equal(page.coverage.scanned, page.tasks.length + 1);
  const seen = new Set(page.tasks.map(i => i.taskId));
  for (let n = 1; n <= 8; n++) if (!seen.has(intent(n).taskId)) { const path = join(f.args.directory, intent(n).taskId, "intent.enc"); const bytes = await readFile(path); await rename(path, join(f.parent, "prior-" + n + ".enc")); await writeFile(path, bytes); }
  for (let n = 0; page.hasMore && n < 10; n++) { page = await discovery.find({ limit: 10, cursor: page.cursor! }); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32 * 1024); for (const task of page.tasks) { assert.equal(seen.has(task.taskId), false); seen.add(task.taskId); } }
  assert.equal(seen.size, 7); assert.equal(page.coverage.unavailable, 1); assert.equal(page.coverage.complete, false); assert.equal(page.coverage.scanned, 8);
});
test("discovery returns intent only and does not reinterpret a corrupt page tail as completion", async t => {
  const f = await fixture(t); await save(f, intent(1)); await writeFile(join(f.args.directory, intent(1).taskId, "page-000001.enc"), "retained corrupt tail");
  const discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close()); const result = await discovery.find(); assert.deepEqual(result.tasks, [intent(1)]);
  const reopened = await openStandingHistoryTaskStore({ directory: f.args.directory, passphrase: f.args.passphrase, intent: result.tasks[0]!, mode: "open" });
  assert.equal((await reopened.status()).storage, "tail-refused"); assert.equal((await reopened.status()).modelProgress, "not-recorded"); await reopened.close();
});
test("hostile arguments refuse without executing getters or choosing another peer/path", async t => {
  const f = await fixture(t), discovery = await openStandingHistoryTaskDiscovery(f.args); t.after(() => discovery.close()); let calls = 0;
  for (const value of [{ limit: 0 }, { limit: 11 }, { cursor: "../escape" }, { chatId: "-100999" }, { directory: f.parent },
    { get limit() { calls++; return 1; } }, new Proxy({}, { getPrototypeOf() { calls++; throw Error(); } })]) await assert.rejects(discovery.find(value as never), code("input"));
  await assert.rejects(openStandingHistoryTaskDiscovery({ ...f.args, get passphrase() { calls++; return f.args.passphrase; } }), code("input"));
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.parent), []);
});
test("close and abort revoke immediately, join active work, and invalidate retained cursors", async t => {
  const f = await fixture(t); await save(f, intent(1)); await save(f, intent(2));
  for (const useAbort of [false, true]) {
    const controller = new AbortController(), discovery = await openStandingHistoryTaskDiscovery({ ...f.args, signal: controller.signal }), retained = await discovery.find({ limit: 1 });
    let settled = false; const expected = useAbort ? "aborted" : "closed";
    const pending = discovery.find({ limit: 1, cursor: retained.cursor! }).then(() => { settled = true; }, e => { settled = true; assert.ok(code(expected)(e)); });
    await assert.rejects(discovery.find(), code("busy")); await immediate(); if (useAbort) controller.abort(); await discovery.close(); await pending;
    assert.equal(settled, true); await assert.rejects(discovery.find(), code(expected));
  }
  const controller = new AbortController(); controller.abort(); await assert.rejects(openStandingHistoryTaskDiscovery({ ...f.args, signal: controller.signal }), code("aborted"));
});
