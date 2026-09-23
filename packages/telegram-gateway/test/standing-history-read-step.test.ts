import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createSelfHistoryReader, type SelfHistoryTaskCheckpoint, type SelfHistoryTaskPage } from "../src/self-history-reader.js";
import { createConversationReferences } from "../src/conversation-references.js";
import type { StandingIdleHistoryTicket } from "../src/standing-conversation-adapter.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { runStandingHistoryReadStep, StandingHistoryReadStepError } from "../src/standing-history-read-step.js";

const gate = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { done, promise }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext, count = 105, observed = false) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-read-step-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-read-step-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), control: join(root, "control") };
  for (const path of Object.values(directories)) await mkdir(path, { mode: 0o700 });
  const passphrase = "synthetic-history-read-step-passphrase", signal = new AbortController();
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "a".repeat(48), accountId: "789", chatId: "-100123", requesterId: "456",
    primaryMessageId: 999, fromDate: 1, toDate: 200, timezone: "Europe/Moscow", objective: "Read synthetic source",
    ...(observed ? { source: { kind: "observed-source" as const, sourceRef: "community" as const, workspaceId: "test-team", peerId: "-100321" } } : {}) };
  const sourcePeerId = observed ? "-100321" : intent.chatId, sourceChannelId = observed ? 321 : 123;
  const control = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "create" });
  const initialControl = await control.status(); await control.close();
  const pages = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "create" });
  const initialRead = await pages.status(); await pages.close();
  let opened = 0, reads = 0, closes = 0;
  const offsets: number[] = [], events: string[] = [];
  const values = Array.from({ length: count }, (_, i) => new Api.Message({ id: i + 1, date: 100, message: "Synthetic observed row " + (i + 1),
    peerId: new Api.PeerChannel({ channelId: bigInt(sourceChannelId) }), fromId: new Api.PeerUser({ userId: bigInt(456) }) }));
  function source(taskSignal: AbortSignal, onInvoke?: () => Promise<void>) {
    const references = createConversationReferences({ accountId: intent.accountId, peerId: intent.chatId });
    const reader = createSelfHistoryReader({ binding: { accountId: intent.accountId, peerId: sourcePeerId }, signal: taskSignal, ...(observed ? { durableText: true } : { references }),
      self: new Api.User({ id: bigInt(789), self: true }), peer: new Api.InputPeerChannel({ channelId: bigInt(sourceChannelId), accessHash: bigInt(987) }),
      client: { async invoke(r: Api.AnyRequest) {
        assert.ok(r instanceof Api.messages.GetHistory); assert.ok(r.getBytes().length); offsets.push(r.offsetId); events.push("invoke"); await onInvoke?.();
        return new Api.messages.Messages({ messages: values.filter(v => !r.offsetId || v.id < r.offsetId).sort((a, b) => b.id - a.id).slice(0, r.limit),
          users: [new Api.User({ id: bigInt(456), firstName: "Synthetic" }), new Api.User({ id: bigInt(789), self: true })], chats: [] });
      } } });
    return { reader, close() { reader.close(); references.close(); } };
  }
  function ticket(options: { onInvoke?: () => Promise<void>; onClose?: () => Promise<void> } = {}): StandingIdleHistoryTicket {
    let used = false;
    const open: StandingIdleHistoryTicket["openHistoryTask"] = scope => {
      assert.equal(used, false); used = true; opened++; events.push("open"); assert.deepEqual(scope.intent, intent);
      const s = source(scope.signal, options.onInvoke); let work: Promise<SelfHistoryTaskPage> | undefined, closing: Promise<void> | undefined;
      return Object.freeze({ readTaskPage() { assert.equal(work, undefined); reads++;
        return work = s.reader.readTaskPage({ fromDate: scope.intent.fromDate, toDate: scope.intent.toDate, ...(scope.checkpoint ? { checkpoint: scope.checkpoint } : {}) });
      }, close() {
        if (!closing) { closes++; events.push("close"); s.reader.close(); closing = (async () => { try { await work; } catch {} await options.onClose?.(); s.close(); events.push("joined"); })(); }
        return closing;
      } });
    };
    return Object.freeze({ openTaskReply() { throw Error("unexpected task reply"); }, openHistoryTask: observed ? () => { throw Error("source must not borrow internal history"); } : open,
      ...(observed ? { openObservedHistoryTask: open } : {}) });
  }
  const base = { intent, directories, passphrase, signal: signal.signal, expectedControlHead: initialControl.headHash, expectedSourceHead: initialRead.readProgress.chainHash };
  async function openPages() { return openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" }); }
  async function cancel() { const c = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open" }); try { return await c.cancel({ expectedRevision: 0 }); } finally { await c.close(); } }
  async function read(checkpoint: SelfHistoryTaskCheckpoint) { const s = source(new AbortController().signal); try { return await s.reader.readTaskPage({ fromDate: intent.fromDate, toDate: intent.toDate, checkpoint }); } finally { s.close(); } }
  return { root, directories, passphrase, intent, initialRead, base, signal, ticket, openPages, cancel, read, offsets, events,
    counts: () => ({ opened, reads, closes }) };
}

test("one real reader page commits to encrypted disk, closes lease, and resumes through fresh stores", async t => {
  const f = await fixture(t); let head = f.base.expectedSourceHead;
  for (const [index, expected] of [[1, 100], [2, 5], [3, 0]] as const) {
    const result = await runStandingHistoryReadStep({ ...f.base, expectedSourceHead: head, ticket: f.ticket() });
    assert.equal(result.kind, "committed"); if (result.kind !== "committed") throw Error();
    assert.equal(result.read.readProgress.committedPages, index); assert.equal(result.read.modelProgress, "not-recorded");
    const p = await f.openPages(); try {
      assert.deepEqual(await p.status(), result.read); const saved = await p.readPage(index); assert.equal(saved!.result.sources.length, expected);
      assert.equal(saved!.result.page.messages.length, expected); head = result.read.readProgress.chainHash;
    } finally { await p.close(); }
    assert.equal(f.counts().reads, index); assert.equal(f.counts().closes, index); assert.equal(f.events.at(-1), "joined");
  }
  assert.deepEqual(f.offsets, [0, 6, 1]);
  assert.deepEqual(await runStandingHistoryReadStep({ ...f.base, expectedSourceHead: head, ticket: f.ticket() }), { kind: "stale" });
  assert.equal(f.counts().opened, 3);
  const cipher = await readFile(join(f.directories.pages, f.intent.taskId, "page-000001.enc"), "utf8"); assert.equal(cipher.includes("Synthetic observed row"), false);
});

test("legacy read-only ticket remains accepted without final-reply capability", async t => {
  const f = await fixture(t), current = f.ticket();
  const legacy = { openHistoryTask: current.openHistoryTask } as StandingIdleHistoryTicket;
  assert.equal((await runStandingHistoryReadStep({ ...f.base, ticket: legacy })).kind, "committed");
  assert.equal(f.counts().reads, 1);
});

test("shared background ticket preserves history reads without invoking observation or alert capabilities", async t => {
  for (const observed of [false, true]) {
    const f = await fixture(t); let otherCalls = 0;
    const unused = () => { otherCalls++; throw Error("history must not borrow another capability"); };
    const ticket = Object.freeze({ ...f.ticket(), openCommunityAlert: unused, ...(observed ? { openObservedSource: unused } : {}) });
    assert.equal((await runStandingHistoryReadStep({ ...f.base, ticket })).kind, "committed");
    assert.deepEqual(f.counts(), { opened: 1, reads: 1, closes: 1 }); assert.equal(otherCalls, 0);
  }
});

test("optional background capabilities remain inert exact functions and unknown members are refused", async t => {
  const f = await fixture(t); let accesses = 0;
  for (const name of ["openObservedSource", "openCommunityAlert"]) {
    const accessor = Object.defineProperty({ ...f.ticket() }, name, { enumerable: true, get() { accesses++; throw Error(); } });
    const proxy = new Proxy(() => { throw Error(); }, { apply() { accesses++; throw Error(); } });
    for (const ticket of [accessor, { ...f.ticket(), [name]: proxy }, { ...f.ticket(), [name]: undefined }, { ...f.ticket(), [name]: true }])
      await assert.rejects(runStandingHistoryReadStep({ ...f.base, ticket }), e => e instanceof StandingHistoryReadStepError && e.code === "input");
  }
  const unknownTicket = { ...f.ticket(), unrelatedCapability() { accesses++; } };
  await assert.rejects(runStandingHistoryReadStep({ ...f.base, ticket: unknownTicket }),
    e => e instanceof StandingHistoryReadStepError && e.code === "input");
  assert.equal(accesses, 0); assert.deepEqual(f.counts(), { opened: 0, reads: 0, closes: 0 });
});

test("stale heads and persisted cancellation refuse before ticket consumption", async t => {
  const f = await fixture(t);
  for (const key of ["expectedSourceHead", "expectedControlHead"] as const)
    assert.deepEqual(await runStandingHistoryReadStep({ ...f.base, [key]: "0".repeat(64), ticket: f.ticket() }), { kind: "stale" });
  await f.cancel(); assert.deepEqual(await runStandingHistoryReadStep({ ...f.base, ticket: f.ticket() }), { kind: "cancelled" });
  assert.deepEqual(f.counts(), { opened: 0, reads: 0, closes: 0 }); assert.deepEqual(f.offsets, []);
});

test("external cancellation during delayed read is recognized by fresh control reopen and writes no page", async t => {
  const f = await fixture(t), entered = gate(), finish = gate();
  const work = runStandingHistoryReadStep({ ...f.base, ticket: f.ticket({ onInvoke: async () => { entered.done(); await finish.promise; } }) });
  await entered.promise; await f.cancel(); finish.done(); assert.deepEqual(await work, { kind: "cancelled" });
  assert.deepEqual(f.counts(), { opened: 1, reads: 1, closes: 1 }); assert.equal(f.events.at(-1), "joined");
  assert.deepEqual(await readdir(join(f.directories.pages, f.intent.taskId)), ["intent.enc"]);
});

test("signal cancellation synchronously revokes lease but completion joins its actual late I/O", async t => {
  const f = await fixture(t), entered = gate(), finish = gate(); let settled = false;
  const work = runStandingHistoryReadStep({ ...f.base, ticket: f.ticket({ onInvoke: async () => { entered.done(); await finish.promise; } }) }).then(v => { settled = true; return v; });
  await entered.promise; f.signal.abort(); assert.equal(f.counts().closes, 1); await tick(); assert.equal(settled, false);
  finish.done(); assert.deepEqual(await work, { kind: "cancelled" }); assert.equal(f.events.at(-1), "joined");
  assert.deepEqual(await readdir(join(f.directories.pages, f.intent.taskId)), ["intent.enc"]);
});

test("lease close must actually join before rechecking control or committing a returned page", async t => {
  const f = await fixture(t), entered = gate(), finish = gate();
  const work = runStandingHistoryReadStep({ ...f.base, ticket: f.ticket({ onClose: async () => { entered.done(); await finish.promise; } }) });
  await entered.promise; assert.deepEqual(await readdir(join(f.directories.pages, f.intent.taskId)), ["intent.enc"]);
  await f.cancel(); finish.done(); assert.deepEqual(await work, { kind: "cancelled" }); assert.equal(f.counts().closes, 1);
});

test("another committed source page during I/O makes the read stale without replay or second append", async t => {
  const f = await fixture(t), entered = gate(), finish = gate();
  const work = runStandingHistoryReadStep({ ...f.base, ticket: f.ticket({ onInvoke: async () => { entered.done(); await finish.promise; } }) });
  await entered.promise;
  const page = await f.read(f.initialRead.readProgress.checkpoint), other = await f.openPages();
  try { await other.appendPage({ expectedCheckpoint: f.initialRead.readProgress.checkpoint, result: page }); } finally { await other.close(); }
  finish.done(); assert.deepEqual(await work, { kind: "stale" }); assert.deepEqual(f.counts(), { opened: 1, reads: 1, closes: 1 });
  const saved = await f.openPages(); try { assert.equal((await saved.status()).readProgress.committedPages, 1); } finally { await saved.close(); }
});

test("input snapshots reject hostile graphs before I/O and ignore later caller scope replacement", async t => {
  const f = await fixture(t); let accesses = 0;
  const hostile = Object.defineProperty({ ...f.base, ticket: f.ticket() }, "intent", { enumerable: true, get() { accesses++; return f.intent; } });
  const proxy = new Proxy(f.ticket(), { ownKeys() { accesses++; throw Error(); }, getPrototypeOf() { accesses++; throw Error(); } });
  const replyAccessor = { ...f.ticket(), get openTaskReply() { accesses++; return () => { throw Error("unexpected reply"); }; } };
  const replyProxy = new Proxy(() => { throw Error("unexpected reply"); }, { apply() { accesses++; throw Error(); } });
  for (const input of [hostile, { ...f.base, ticket: proxy }, { ...f.base, ticket: replyAccessor },
    { ...f.base, ticket: { ...f.ticket(), openTaskReply: replyProxy } }, { ...f.base, ticket: { ...f.ticket(), extra: true } },
    { ...f.base, ticket: f.ticket(), expectedSourceHead: "bad" },
    { ...f.base, ticket: f.ticket(), directories: { ...f.directories, control: f.directories.pages } }])
    await assert.rejects(runStandingHistoryReadStep(input), e => e instanceof StandingHistoryReadStepError && e.code === "input");
  assert.equal(accesses, 0); assert.equal(f.counts().opened, 0);
  const mutable = { ...f.base, intent: { ...f.intent }, directories: { ...f.directories }, ticket: f.ticket() };
  const work = runStandingHistoryReadStep(mutable); mutable.intent.chatId = "-999"; mutable.directories.pages = join(f.root, "replaced");
  mutable.ticket = { openTaskReply() { throw Error("unexpected task reply"); }, openHistoryTask() { throw Error("replaced callback"); } };
  assert.equal((await work).kind, "committed"); assert.equal(f.counts().reads, 1);
});

test("read errors and malformed persisted tails do not consume retries or create replacement stores", async t => {
  const f = await fixture(t);
  await assert.rejects(runStandingHistoryReadStep({ ...f.base, ticket: f.ticket({ onInvoke: async () => { throw Error("synthetic transport fault"); } }) }),
    e => e instanceof StandingHistoryReadStepError && e.code === "read");
  assert.deepEqual(f.counts(), { opened: 1, reads: 1, closes: 1 });
  await writeFile(join(f.directories.control, f.intent.taskId, "cancel-000001.enc"), "malformed preserved bytes");
  assert.deepEqual(await runStandingHistoryReadStep({ ...f.base, ticket: f.ticket() }), { kind: "stale" }); assert.equal(f.counts().opened, 1);
  await assert.rejects(runStandingHistoryReadStep({ ...f.base, ticket: f.ticket(), directories: { ...f.directories, control: join(f.root, "absent") } }),
    e => e instanceof StandingHistoryReadStepError && e.code === "storage");
  assert.deepEqual(await readdir(f.root), ["control", "pages"]); assert.deepEqual(await readdir(join(f.directories.pages, f.intent.taskId)), ["intent.enc"]);
});


test("source intent reads through its dedicated lease and persists checkpoints without changing internal delivery chat", async t => {
 const f=await fixture(t,105,true);let head=f.base.expectedSourceHead;
 for(let n=0;n<3;n++){
  const result=await runStandingHistoryReadStep({...f.base,expectedSourceHead:head,ticket:f.ticket()});assert.equal(result.kind,"committed");if(result.kind!=="committed")throw Error();
  assert.equal(result.read.readProgress.checkpoint.chatId,"-100321");head=result.read.readProgress.chainHash;
 }
 assert.equal(f.intent.chatId,"-100123");assert.deepEqual(f.offsets,[0,6,1]);
 const store=await f.openPages();try{assert.equal((await store.status()).readProgress.checkpoint.status,"empty-page");}finally{await store.close();}
});
