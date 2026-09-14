import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat, link, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { decryptSession, encryptSession } from "../src/session-crypto.js";
import { openStandingActionJournal, standingActionKey } from "../src/standing-action-journal.js";
import { openStandingObjectCatalog, StandingObjectCatalogError, type StandingObjectPage } from "../src/standing-object-catalog.js";
import type { StandingPollObjectEvidence } from "../src/standing-object-evidence.js";
import { standingObjectIndexDirectory } from "../src/standing-object-index.js";

const binding = { accountId: "123", chatId: "-100456", primaryMessageId: 789, operationSlot: 0 };
async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(resolve(tmpdir()), "neurobro-object-catalog-"));
  t.after(async () => { assert.ok(parent.startsWith(join(resolve(tmpdir()), "neurobro-object-catalog-"))); await rm(parent, { recursive: true, force: true }); });
  return { parent, args: { directory: join(parent, "journal"), passphrase: "synthetic-object-catalog-passphrase", accountId: binding.accountId, chatId: binding.chatId } };
}
function evidence(n: number, question = "Какой день?"): StandingPollObjectEvidence {
  const randomId = String(123456789 + n);
  return { schema: "standing-poll-object-v1", kind: "poll", objectRef: "obj_" + n.toString(16).padStart(48, "0"), observedAt: 1789065600 + n,
    record: { schema: "owned-bound-poll-v1", operationId: "bound-action-" + randomId, randomId, ...{ accountId: binding.accountId, chatId: binding.chatId },
      replyToMessageId: binding.primaryMessageId + n, messageId: 1000 + n, pollId: String(900000000000000000n + BigInt(n)),
      poll: { question, options: ["Среда", "Четверг"], anonymous: true, type: "single" } } };
}
async function save(f: Awaited<ReturnType<typeof fixture>>, n: number, options: { evidence?: StandingPollObjectEvidence; terminal?: "verified" | "unknown" | "refused" | "absent"; legacy?: boolean; foreign?: boolean } = {}) {
  const e = options.evidence ?? evidence(n), b = { ...binding, primaryMessageId: binding.primaryMessageId + n, ...(options.foreign ? { accountId: "124" } : {}) },
    journal = await openStandingActionJournal({ ...{ directory: f.args.directory, passphrase: f.args.passphrase }, binding: b });
  const adjusted = options.foreign ? { ...e, record: { ...e.record, accountId: "124" } } : e;
  await journal.reserve({ requestRef: "request" + n, randomId: adjusted.record.randomId, action: { kind: "create-poll", poll: adjusted.record.poll } });
  const state = options.terminal ?? "verified";
  if (state !== "absent") await journal.append({ state, result: { verdict: state, poll: { messageRef: "old_connection_reference" } },
    ...(!options.legacy && state === "verified" ? { privateObjectEvidence: adjusted } : {}) });
  await journal.close(); return { key: standingActionKey(b), slot: join(f.args.directory, standingActionKey(b)), evidence: adjusted };
}
const code = (expected: string) => (e: unknown) => e instanceof StandingObjectCatalogError && e.code === expected;
async function allPages(catalog: Awaited<ReturnType<typeof openStandingObjectCatalog>>, query?: string, limit = 5) {
  const objects: StandingObjectPage["objects"][number][] = []; let cursor: string | undefined, last: StandingObjectPage | undefined;
  for (let step = 0; step < 20; step++) {
    last = await catalog.find({ kind: "poll", limit, ...(query === undefined ? {} : { query }), ...(cursor ? { cursor } : {}) });
    objects.push(...last.objects); if (!last.hasMore) return { objects, last }; assert.ok(last.cursor); cursor = last.cursor;
  }
  throw Error("pagination cycle");
}
test("missing root is empty and never creates storage; later first poll is discoverable", async t => {
  const f = await fixture(t), catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  assert.deepEqual(await catalog.find({ kind: "poll" }), { objects: [], hasMore: false, coverage: { complete: true, scanned: 0, unavailable: 0, legacy: 0 } });
  assert.deepEqual(await readdir(f.parent), []); await save(f, 1);
  assert.equal((await catalog.find({ kind: "poll" })).objects.length, 1);
});
test("fresh catalog after reconnect finds and resolves exact own verified poll without old references", async t => {
  const f = await fixture(t), a = await save(f, 1), b = await save(f, 2), catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  assert.deepEqual(await catalog.resolve(a.evidence.objectRef), a.evidence);
  const result = await allPages(catalog, undefined, 1); assert.equal(result.objects.length, 2); assert.equal(result.last.coverage.complete, true);
  assert.deepEqual(await catalog.resolve(a.evidence.objectRef), a.evidence); assert.deepEqual(await catalog.resolve(b.evidence.objectRef), b.evidence);
  const publicText = JSON.stringify(result.objects);
  for (const secret of ["messageId", "pollId", "accountId", "chatId", "randomId", "old_connection_reference", a.evidence.record.pollId, a.evidence.record.operationId]) assert.equal(publicText.includes(secret), false);
  assert.deepEqual(result.objects.map(v => v.question), ["Какой день?", "Какой день?"]);
});
test("cursor is scoped and single-use; query matches options and no page duplicates", async t => {
  const f = await fixture(t); await save(f, 1); await save(f, 2); await save(f, 3, { evidence: evidence(3, "Другой день?") });
  const catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  const page = await catalog.find({ kind: "poll", query: "ЧЕТВЕРГ", limit: 1 }); assert.ok(page.cursor); assert.match(page.cursor, /^cur_[0-9a-f]{48}$/u);
  await assert.rejects(catalog.find({ kind: "poll", query: "different", limit: 1, cursor: page.cursor }), code("cursor"));
  await assert.rejects(catalog.find({ kind: "poll", query: "ЧЕТВЕРГ", limit: 2, cursor: page.cursor }), code("cursor"));
  const second = await catalog.find({ kind: "poll", query: "ЧЕТВЕРГ", limit: 1, cursor: page.cursor });
  await assert.rejects(catalog.find({ kind: "poll", query: "ЧЕТВЕРГ", limit: 1, cursor: page.cursor }), code("cursor"));
  assert.notEqual(second.objects[0]!.objectRef, page.objects[0]!.objectRef);
  const matched = await allPages(catalog, "Другой"); assert.deepEqual(matched.objects.map(o => o.question), ["Другой день?"]);
});
test("bounded traversal continues across gaps and reports legacy, unknown and incomplete records", async t => {
  const f = await fixture(t); await save(f, 1); await save(f, 2, { legacy: true }); await save(f, 3, { terminal: "unknown" }); await save(f, 4, { terminal: "absent" });
  await save(f, 5, { terminal: "refused" }); await save(f, 6, { foreign: true });
  for (let i = 0; i < 18; i++) await mkdir(join(f.args.directory, "invalid-slot-" + i));
  const catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  const first = await catalog.find({ kind: "poll" }); assert.equal(first.coverage.scanned, 16); assert.equal(first.hasMore, true); assert.equal(first.coverage.complete, false);
  const second = await catalog.find({ kind: "poll", cursor: first.cursor! }); assert.equal(second.coverage.scanned, 26); assert.equal(second.hasMore, false);
  assert.equal(second.coverage.complete, false); assert.equal(second.coverage.legacy, 1); assert.equal(second.coverage.unavailable, 20);
  assert.equal(first.objects.length + second.objects.length, 1);
});
test("authenticated terminal tampering and transplanted key/hash/peer never enter catalog", async t => {
  const f = await fixture(t), saved = await save(f, 1), path = join(saved.slot, "terminal.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  for (const mutate of [(v: typeof original) => { v.key = "f".repeat(64); }, (v: typeof original) => { v.payload.intentHash = "0".repeat(64); },
    (v: typeof original) => { v.payload.terminal.privateObjectEvidence.record.chatId = "-100999"; },
    (v: typeof original) => { v.payload.terminal.state = "unknown"; }]) {
    const changed = structuredClone(original); mutate(changed); await writeFile(path, await encryptSession(JSON.stringify(changed), f.args.passphrase));
    const catalog = await openStandingObjectCatalog(f.args); const result = await catalog.find({ kind: "poll" });
    assert.equal(result.objects.length, 0); assert.equal(result.coverage.unavailable, 2); assert.equal(result.coverage.complete, false); await catalog.close();
  }
});
test("resolve rereads persistent exact key and rejects corruption or same-content file replacement", async t => {
  const f = await fixture(t), saved = await save(f, 1), catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  await catalog.find({ kind: "poll" }); const path = join(saved.slot, "terminal.enc"), bytes = await readFile(path);
  await rename(path, join(saved.slot, "terminal-old.enc")); await writeFile(path, bytes);
  assert.equal(await catalog.resolve(saved.evidence.objectRef), undefined);
  assert.equal((await catalog.find({ kind: "poll" })).objects.length, 1);
  await writeFile(path, "partial ciphertext"); assert.equal(await catalog.resolve(saved.evidence.objectRef), undefined);
  assert.equal(await readFile(path, "utf8"), "partial ciphertext");
});
test("hardlinks and junction slots are gaps, root substitution is a storage refusal", async t => {
  const f = await fixture(t), a = await save(f, 1), b = await save(f, 2);
  await link(join(a.slot, "terminal.enc"), join(f.parent, "linked.enc"));
  const bMoved = join(f.parent, "saved-slot"); await rename(b.slot, bMoved); await symlink(bMoved, b.slot, process.platform === "win32" ? "junction" : "dir");
  const catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  const result = await catalog.find({ kind: "poll" }); assert.equal(result.objects.length, 0); assert.equal(result.coverage.unavailable, 4);
  await rename(f.args.directory, join(f.parent, "old-journal")); await mkdir(f.args.directory);
  await assert.rejects(catalog.find({ kind: "poll" }), code("storage"));
});
test("long Unicode polls paginate below public JSON bound without dropping a pending object", async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 4; n++) {
    const e = evidence(n, "界".repeat(255));
    const poll = { ...e.record.poll, options: Array.from({ length: 10 }, (_, i) => String(i) + "界".repeat(99)) };
    await save(f, n, { evidence: { ...e, record: { ...e.record, poll } } });
  }
  const catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  const first = await catalog.find({ kind: "poll", limit: 10 }); assert.ok(first.hasMore); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 12 * 1024);
  const second = await catalog.find({ kind: "poll", limit: 10, cursor: first.cursor! }); assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 12 * 1024);
  assert.equal(second.hasMore, false); assert.equal(first.objects.length + second.objects.length, 4);
  assert.equal(new Set([...first.objects, ...second.objects].map(o => o.objectRef)).size, 4);
});
test("find arguments are inert, bounded, and never allow a peer/path selector", async t => {
  const f = await fixture(t), catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close()); let calls = 0;
  for (const value of [{ kind: "poll", query: "x".repeat(129) }, { kind: "poll", limit: 11 }, { kind: "poll", limit: 0 }, { kind: "poll", cursor: "../../" },
    { kind: "poll", chatId: "-999" }, { kind: "poll", get query() { calls++; return "x"; } }, new Proxy({}, { getPrototypeOf() { calls++; throw Error(); } })])
    await assert.rejects(catalog.find(value as never), code("input"));
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.parent), []);
});
test("close revokes synchronously and joins admitted filesystem work", async t => {
  const f = await fixture(t); await save(f, 1); const catalog = await openStandingObjectCatalog(f.args);
  let settled = false;
  const reading = catalog.find({ kind: "poll" }).then(() => { settled = true; }, e => { settled = true; assert.ok(code("closed")(e)); });
  await assert.rejects(catalog.find({ kind: "poll" }), code("busy")); await immediate();
  await catalog.close(); await reading; assert.equal(settled, true);
  await assert.rejects(catalog.find({ kind: "poll" }), code("closed")); await assert.rejects(catalog.resolve(evidence(1).objectRef), code("closed"));
  assert.deepEqual((await readdir(join(f.args.directory, standingActionKey({ ...binding, primaryMessageId: 790 })))).sort(), ["intent.enc", "terminal.enc"]);
});
test("directory cursor eviction is bounded and stale tokens refuse", async t => {
  const f = await fixture(t); await save(f, 1); await save(f, 2); const catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  const first = await catalog.find({ kind: "poll", limit: 1 }); assert.ok(first.cursor);
  for (let i = 0; i < 4; i++) await catalog.find({ kind: "poll", limit: 1 });
  await assert.rejects(catalog.find({ kind: "poll", limit: 1, cursor: first.cursor }), code("cursor"));
});
test("duplicate persisted objectRef across different query scans cannot rebind an existing capability", async t => {
  const f = await fixture(t), a = await save(f, 1, { evidence: evidence(1, "First only") });
  const catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  assert.equal((await catalog.find({ kind: "poll", query: "First" })).objects[0]!.objectRef, a.evidence.objectRef);
  await save(f, 2, { evidence: { ...evidence(2, "Second only"), objectRef: a.evidence.objectRef } });
  await assert.rejects(catalog.find({ kind: "poll", query: "Second" }), code("storage"));
  await assert.rejects(catalog.find({ kind: "poll", query: "First" }), code("storage"));
  // All previously handed-out capabilities become unusable on a confirmed collision.
  await assert.rejects(catalog.resolve(a.evidence.objectRef), code("storage"));
});
test("poll-only derived index reaches a new poll before more than 128 historical nonpoll slots", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 130; n++) {
    const journal = await openStandingActionJournal({ directory: f.args.directory, passphrase: f.args.passphrase, binding: { ...binding, primaryMessageId: 2000 + n } });
    await journal.reserve({ requestRef: "old" + n, randomId: String(10000 + n), action: { kind: "read-reactions", messageRef: "old-ref" } });
    await journal.append({ state: "verified", result: { verdict: "verified" } }); await journal.close();
  }
  const saved = await save(f, 200), catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  const first = await catalog.find({ kind: "poll" }); assert.equal(first.objects.length, 1); assert.equal(first.objects[0]!.objectRef, saved.evidence.objectRef);
  assert.equal(first.coverage.scanned, 16); assert.equal(first.coverage.complete, false); assert.equal(first.hasMore, true);
  const indexPath = join(standingObjectIndexDirectory(f.args.directory), saved.evidence.objectRef + ".enc");
  await rename(indexPath, join(f.parent, "lost-hint.enc"));
  const fresh = await openStandingObjectCatalog(f.args); t.after(() => fresh.close());
  assert.equal(await fresh.resolve(saved.evidence.objectRef), undefined);
  const fallback = await allPages(fresh); assert.equal(fallback.objects.length, 1); assert.equal(fallback.objects[0]!.objectRef, saved.evidence.objectRef);
  assert.equal(fallback.last.coverage.scanned, 131); assert.equal(fallback.last.coverage.complete, true);
  assert.deepEqual(await fresh.resolve(saved.evidence.objectRef), saved.evidence);
});
test("a failed hint write cannot downgrade verified terminal or enable another attempt", async t => {
  const f = await fixture(t); await writeFile(standingObjectIndexDirectory(f.args.directory), "blocked derived index");
  const saved = await save(f, 1), journal = await openStandingActionJournal({ directory: f.args.directory, passphrase: f.args.passphrase, binding: { ...binding, primaryMessageId: 790 } });
  const inspection = await journal.inspect(); assert.equal(inspection.state, "verified"); assert.deepEqual(inspection.terminal!.privateObjectEvidence, saved.evidence);
  await assert.rejects(journal.append({ state: "unknown", result: {} })); await journal.close();
  assert.equal(await readFile(standingObjectIndexDirectory(f.args.directory), "utf8"), "blocked derived index");
  const catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  const page = await catalog.find({ kind: "poll" }); assert.equal(page.objects.length, 1); assert.equal(page.coverage.unavailable, 1); assert.equal(page.coverage.complete, false);
});
test("encrypted hint substitution, foreign peer and invented raw key cannot authorize an object", async t => {
  const f = await fixture(t), first = await save(f, 1), second = await save(f, 2), index = standingObjectIndexDirectory(f.args.directory), path = join(index, first.evidence.objectRef + ".enc"),
    cipher = await readFile(path, "utf8"), original = JSON.parse(await decryptSession(cipher, f.args.passphrase));
  for (const secret of [first.key, binding.accountId, binding.chatId, "standing-poll-index-v1"]) assert.equal(cipher.includes(secret), false);
  for (const mutate of [(v: typeof original) => { v.hint.key = second.key; }, (v: typeof original) => { v.hint.chatId = "-100999"; },
    (v: typeof original) => { v.hint.key = "a".repeat(64); }, (v: typeof original) => { v.hint.objectRef = second.evidence.objectRef; },
    (v: typeof original) => { v.domain = "foreign"; }]) {
    const changed = structuredClone(original); mutate(changed); await writeFile(path, await encryptSession(JSON.stringify(changed), f.args.passphrase));
    const catalog = await openStandingObjectCatalog(f.args);
    assert.equal(await catalog.resolve(first.evidence.objectRef), undefined);
    const fallback = await allPages(catalog); assert.equal(fallback.objects.length, 2); assert.deepEqual(await catalog.resolve(first.evidence.objectRef), first.evidence);
    await catalog.close();
  }
});
test("hardlinked discovery hint is ignored and primary terminal remains discoverable", async t => {
  const f = await fixture(t), saved = await save(f, 1), indexPath = join(standingObjectIndexDirectory(f.args.directory), saved.evidence.objectRef + ".enc");
  await link(indexPath, join(f.parent, "hint-link.enc")); const catalog = await openStandingObjectCatalog(f.args); t.after(() => catalog.close());
  assert.equal(await catalog.resolve(saved.evidence.objectRef), undefined);
  const page = await catalog.find({ kind: "poll" }); assert.equal(page.objects.length, 1); assert.equal(page.coverage.unavailable, 1);
});
