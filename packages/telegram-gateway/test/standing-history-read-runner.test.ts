import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createStandingConversationAdapter, type StandingSelection } from "../src/standing-conversation-adapter.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryReadRunner, StandingHistoryReadRunnerError } from "../src/standing-history-read-runner.js";

const gate = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { done, promise }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const message = (id: number, text: string, own = false) => new Api.Message({ id, date: id <= 105 ? 80 : 100, message: text,
  peerId: new Api.PeerChannel({ channelId: bigInt(123) }), fromId: new Api.PeerUser({ userId: bigInt(own ? 789 : 456) }), ...(own ? { out: true } : {}) });
async function fixture(t: TestContext, addressed = 12) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-read-runner-"));
  const directories = { pages: join(root, "pages"), control: join(root, "control") };
  for (const path of Object.values(directories)) await mkdir(path, { mode: 0o700 });
  const signal = new AbortController(), binding = { accountId: "789", peerId: "-100123" }, references = createConversationReferences(binding);
  const passphrase = "synthetic-history-runner-passphrase", values = [
    ...Array.from({ length: 105 }, (_, i) => message(i + 1, "Synthetic historical source " + i)),
    ...Array.from({ length: addressed }, (_, i) => message(i + 1001, "ПРОМПТ synthetic request " + i))];
  const calls: Api.AnyRequest[] = [], checkpoints: number[] = [], due: boolean[] = [];
  let now = 0, active = 0, maximum = 0, taskCalls = 0, onTask: (() => Promise<void>) | undefined, onForeground: (() => Promise<void>) | undefined;
  const batch = (rows: Api.TypeMessage[]) => new Api.messages.Messages({ messages: rows, chats: [], users: [new Api.User({ id: bigInt(789), self: true }), new Api.User({ id: bigInt(456), firstName: "Synthetic" })] });
  const adapter = await createStandingConversationAdapter({ binding, references, signal: signal.signal, self: new Api.User({ id: bigInt(789), self: true }), startedAt: 100, resumeCursor: 1000,
    clock: () => now, wait: async ms => { now += ms; }, checkpointCursor: async id => { checkpoints.push(id); }, client: { async invoke(r: Api.AnyRequest) {
      calls.push(r); active++; maximum = Math.max(maximum, active); assert.ok(r.getBytes().length);
      try {
        await tick();
        if (r instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({ dialogs: [new Api.Dialog({ peer: new Api.PeerChannel({ channelId: bigInt(123) }), topMessage: 105,
          readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })],
          chats: [new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Synthetic group", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })], users: [], messages: [] });
        if (r instanceof Api.messages.GetHistory) {
          if (r.limit === 100 && !r.minId) { taskCalls++; await onTask?.(); }
          if (r.minId) await onForeground?.();
          return batch(values.filter(v => v.id > (r.minId ?? 0) && (!r.offsetId || v.id < r.offsetId) && (!r.offsetDate || v.date < r.offsetDate)).sort((a, b) => b.id - a.id).slice(0, r.limit));
        }
        if (r instanceof Api.channels.GetMessages) { const id = (r.id[0] as Api.InputMessageID).id; return batch([values.find(v => v.id === id) ?? new Api.MessageEmpty({ id })]); }
        if (r instanceof Api.messages.SendMessage) {
          const id = Math.max(...values.map(v => v.id)) + 1, sent = message(id, r.message, true);
          sent.replyTo = new Api.MessageReplyHeader({ replyToMsgId: (r.replyTo as Api.InputReplyToMessage).replyToMsgId }); values.push(sent);
          return new Api.UpdateShortSentMessage({ id, out: true, pts: 1, ptsCount: 1, date: 100 });
        }
        if (r instanceof Api.messages.SetTyping) return true;
        throw Error("unexpected fixture RPC");
      } finally { active--; }
    } } });
  t.after(async () => { await adapter.closeCapabilities(); references.close(); assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-read-runner-"))); await rm(root, { recursive: true, force: true }); });
  const args = { adapter: { async pollWork(s: AbortSignal, options: { backgroundDue: boolean }) { due.push(options.backgroundDue); return adapter.pollWork(s, options); } }, directories, passphrase, binding, signal: signal.signal };
  async function create(letter: string, foreign = false, source?: StandingHistoryTaskIntent["source"]) {
    const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + letter.repeat(48), accountId: binding.accountId, chatId: foreign ? "-100999" : binding.peerId,
      requesterId: "456", primaryMessageId: 1001, fromDate: 1, toDate: 99, timezone: "UTC", objective: "Synthetic historical task " + letter, ...(source ? { source } : {}) };
    const pages = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "create" }); await pages.close();
    const control = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "create" }); await control.close(); return intent;
  }
  async function cancel(intent: StandingHistoryTaskIntent) { const c = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open" }); try { await c.cancel({ expectedRevision: 0 }); } finally { await c.close(); } }
  async function status(intent: StandingHistoryTaskIntent) { const p = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" }); try { return await p.status(); } finally { await p.close(); } }
  return { root, args, adapter, values, signal, calls, due, checkpoints, create, cancel, status,
    taskCalls: () => taskCalls, maximum: () => maximum, onTask: (value: typeof onTask) => { onTask = value; },
    onForeground: (value: typeof onForeground) => { onForeground = value; } };
}
async function answer(selected: StandingSelection, signal: AbortSignal) {
  const input = { chatId: selected.primary.chatId, replyToMessageId: selected.primary.messageId, text: "Synthetic foreground answer", randomId: "112233" };
  const sent = await selected.transport.sendOnce(input, signal); await selected.transport.readExact(input.chatId, sent.messageId, signal);
}

test("source pin absence or mismatch is task-local and never opens a history lease", async t => {
  const source = { kind: "observed-source", sourceRef: "community", workspaceId: "synthetic-team-v1", peerId: "-100888" } as const;
  for (const pin of [undefined, { ...source, peerId: "-100889" }, { ...source, workspaceId: "other-team-v1" }]) {
    const f = await fixture(t, 0), intent = await f.create("a", false, source), before = await f.status(intent);
    const runner = await openStandingHistoryReadRunner({ ...f.args, ...(pin ? { observedSource: pin } : {}) });
    try {
      assert.deepEqual(await runner.poll(), { kind: "background", outcome: { kind: "stalled", taskRef: intent.taskId, reason: "source-unavailable" } });
      assert.equal(f.taskCalls(), 0); assert.deepEqual(await f.status(intent), before);
      await f.cancel(intent);
      const control = await openStandingHistoryTaskControlStore({ directory: f.args.directories.control, passphrase: f.args.passphrase, intent, mode: "open" });
      try { assert.equal((await control.status()).state, "cancelled"); } finally { await control.close(); }
      const internal = await f.create("b"); let found = false;
      for (let i = 0; i < 4; i++) { const work = await runner.poll();
        if (work.kind === "background" && work.outcome.kind === "read" && work.outcome.taskRef === internal.taskId) { found = true; break; }
      }
      assert.equal(found, true); assert.equal(f.taskCalls(), 1);
    } finally { await runner.close(); }
  }
});

test("matching source pin permits read-only task inspection and configuration is immutable", async t => {
  const source = { kind: "observed-source", sourceRef: "community", workspaceId: "synthetic-team-v1", peerId: "-100888" } as const;
  const f = await fixture(t, 0), intent = await f.create("a", false, source); await f.cancel(intent);
  const pin = { ...source }, runner = await openStandingHistoryReadRunner({ ...f.args, observedSource: pin });
  Object.assign(pin, { workspaceId: "other-team-v1" });
  try { assert.deepEqual(await runner.poll(), { kind: "background", outcome: { kind: "skipped", taskRef: intent.taskId, reason: "cancelled" } }); }
  finally { await runner.close(); }
  assert.equal(f.taskCalls(), 0);
});

test("read runner rejects malformed source pins without invoking hostile fields", async t => {
  const f = await fixture(t, 0); let evaluated = 0;
  const source = { kind: "observed-source", sourceRef: "community", workspaceId: "synthetic-team-v1", peerId: "-100888" } as const;
  const hostile = { ...source }; Object.defineProperty(hostile, "workspaceId", { enumerable: true, get() { evaluated++; return source.workspaceId; } });
  for (const pin of [undefined, null, { ...source, send: true }, hostile, new Proxy(source, {})]) {
    await assert.rejects(openStandingHistoryReadRunner({ ...f.args, observedSource: pin } as never), /INPUT/);
  }
  assert.equal(evaluated, 0); assert.equal(f.due.length, 0);
});

test("real work loop gives each task one page per cycle under a continuously addressed queue", async t => {
  const f = await fixture(t), a = await f.create("a"), b = await f.create("b"), runner = await openStandingHistoryReadRunner(f.args); t.after(() => runner.close());
  const selected: number[] = [], tasks: string[] = [];
  for (let i = 0; i < 12; i++) {
    const before = f.taskCalls(), work = await runner.poll();
    if (work.kind === "selected") { selected.push(work.selection.primary.messageId); await answer(work.selection, f.signal.signal); }
    else {
      assert.equal(work.kind, "background"); if (work.kind !== "background" || work.outcome.kind !== "read") throw Error();
      assert.equal(work.outcome.result.kind, "committed"); tasks.push(work.outcome.taskRef);
    }
    assert.ok(f.taskCalls() - before <= 1);
  }
  assert.deepEqual(selected, Array.from({ length: 8 }, (_, i) => i + 1001)); assert.deepEqual(f.checkpoints, selected);
  assert.deepEqual(new Set(tasks.slice(0, 2)), new Set([a.taskId, b.taskId])); assert.deepEqual(tasks.slice(2), tasks.slice(0, 2));
  assert.deepEqual(f.due, [false, false, true, false, false, true, false, false, true, false, false, true]);
  for (const intent of [a, b]) { const s = await f.status(intent); assert.equal(s.readProgress.committedPages, 2); assert.equal(s.readProgress.checkpoint.offsetId, 1); }
  assert.equal(f.taskCalls(), 4); assert.equal(f.maximum(), 1); assert.equal(f.calls.filter(r => r instanceof Api.messages.GetDialogs).length, 1);
});

test("discarded foreground candidates count toward credit so stale replies cannot starve reading", async t => {
  const f = await fixture(t, 3); await f.create("a");
  for (const id of [1001, 1002]) { const v = f.values.find(v => v.id === id)!; v.message = "reply to missing own anchor"; v.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 999 }); }
  const runner = await openStandingHistoryReadRunner(f.args); t.after(() => runner.close());
  assert.deepEqual(await runner.poll(), { kind: "more" }); assert.deepEqual(await runner.poll(), { kind: "more" });
  const read = await runner.poll(); assert.equal(read.kind, "background"); if (read.kind !== "background" || read.outcome.kind !== "read") throw Error();
  assert.equal(read.outcome.result.kind, "committed"); assert.equal(f.taskCalls(), 1); assert.deepEqual(f.checkpoints, []);
  const next = await runner.poll(); if (next.kind !== "selected") throw Error(); assert.equal(next.selection.primary.messageId, 1003); await answer(next.selection, f.signal.signal);
});

test("persisted task cancellation revokes and joins delayed sole-client read without blocking later foreground", async t => {
  const f = await fixture(t, 0), intent = await f.create("a"), entered = gate(), finish = gate();
  const runner = await openStandingHistoryReadRunner(f.args); t.after(() => runner.close());
  f.onTask(async () => { entered.done(); await finish.promise; }); const work = runner.poll(); await entered.promise;
  await assert.rejects(runner.poll(), e => e instanceof StandingHistoryReadRunnerError && e.code === "busy");
  await f.cancel(intent); let joined = false; const revoke = runner.revoke(intent.taskId).then(() => { joined = true; }); await tick(); assert.equal(joined, false);
  finish.done(); const result = await work; await revoke;
  assert.equal(result.kind, "background"); if (result.kind !== "background" || result.outcome.kind !== "read") throw Error(); assert.equal(result.outcome.result.kind, "cancelled");
  assert.equal((await f.status(intent)).readProgress.committedPages, 0); assert.equal(f.taskCalls(), 1);
  f.values.push(message(1001, "ПРОМПТ after cancellation")); const next = await runner.poll(); if (next.kind !== "selected") throw Error();
  await answer(next.selection, f.signal.signal); assert.equal(f.maximum(), 1);
});

test("runner close joins actual read work but does not close its borrowed foreground adapter", async t => {
  const f = await fixture(t, 0), intent = await f.create("a"), entered = gate(), finish = gate();
  const runner = await openStandingHistoryReadRunner(f.args);
  f.onTask(async () => { entered.done(); await finish.promise; }); const work = runner.poll(); await entered.promise;
  let joined = false; const closing = runner.close().then(() => { joined = true; }); await tick(); assert.equal(joined, false);
  finish.done(); await assert.rejects(work, e => e instanceof StandingHistoryReadRunnerError && e.code === "closed"); await closing;
  assert.equal((await f.status(intent)).readProgress.committedPages, 0);
  await assert.rejects(runner.poll(), e => e instanceof StandingHistoryReadRunnerError && e.code === "closed");
  f.values.push(message(1001, "ПРОМПТ adapter remains owned by service")); const next = await f.adapter.pollNext(f.signal.signal);
  if (next.kind !== "selected") throw Error(); await answer(next.selection, f.signal.signal);
});

test("revocation binds during control preflight before any history ticket is consumed", async t => {
  const f = await fixture(t, 0), intent = await f.create("a"), entered = gate(), finish = gate();
  const runner = await openStandingHistoryReadRunner(f.args); t.after(() => runner.close());
  const original = fs.open, target = join(f.args.directories.control, intent.taskId, "intent.enc"); let intercepted = false;
  fs.open = async function(path, flags, mode) {
    if (String(path) === target && !intercepted) { intercepted = true; entered.done(); await finish.promise; }
    return original(path, flags, mode);
  } as typeof fs.open;
  syncBuiltinESMExports();
  try {
    const work = runner.poll(); await entered.promise; await f.cancel(intent);
    let joined = false; const revoking = runner.revoke(intent.taskId).then(() => { joined = true; }); await tick(); assert.equal(joined, false);
    assert.equal(f.taskCalls(), 0); finish.done(); const result = await work; await revoking;
    assert.deepEqual(result, { kind: "background", outcome: { kind: "skipped", taskRef: intent.taskId, reason: "cancelled" } });
    assert.equal(f.taskCalls(), 0); assert.equal((await f.status(intent)).readProgress.committedPages, 0);
  } finally { finish.done(); fs.open = original; syncBuiltinESMExports(); }
});

test("local close during real foreground collection preserves the checkpointed selection for its admitted caller", async t => {
  const f = await fixture(t, 2), entered = gate(), finish = gate();
  const runner = await openStandingHistoryReadRunner(f.args);
  f.onForeground(async () => { entered.done(); await finish.promise; });
  const work = runner.poll(); await entered.promise;
  let joined = false; const closing = runner.close().then(() => { joined = true; }); await tick();
  assert.equal(joined, false); assert.deepEqual(f.checkpoints, []);
  await assert.rejects(runner.poll(), e => e instanceof StandingHistoryReadRunnerError && e.code === "closed");
  finish.done(); const selected = await work; await closing;
  assert.equal(selected.kind, "selected"); if (selected.kind !== "selected") throw Error();
  assert.equal(selected.selection.primary.messageId, 1001); assert.deepEqual(f.checkpoints, [1001]);
  assert.equal(f.signal.signal.aborted, false); await answer(selected.selection, f.signal.signal);
  const next = await f.adapter.pollNext(f.signal.signal); if (next.kind !== "selected") throw Error();
  assert.equal(next.selection.primary.messageId, 1002); await answer(next.selection, f.signal.signal);
  assert.deepEqual(f.checkpoints, [1001, 1002]); assert.equal(f.maximum(), 1); assert.equal(f.taskCalls(), 0);
});

test("incremental discovery yields bounded scan coverage, skips foreign/cancelled/bad control tasks, and cycles", async t => {
  const f = await fixture(t, 0);
  for (let i = 0; i < 20; i++) await mkdir(join(f.args.directories.pages, "unavailable-" + String(i).padStart(2, "0")));
  const foreign = await f.create("a", true), cancelled = await f.create("b"), broken = await f.create("c"), ready = await f.create("d");
  await f.cancel(cancelled); await writeFile(join(f.args.directories.control, broken.taskId, "cancel-000001.enc"), "malformed fixture");
  const runner = await openStandingHistoryReadRunner(f.args); t.after(() => runner.close());
  const skips = new Map<string, string>(); let scans = 0, reads = 0;
  for (let i = 0; i < 12 && (!reads || skips.size < 2 || !scans); i++) {
    const work = await runner.poll(); assert.equal(work.kind, "background"); if (work.kind !== "background") throw Error();
    const outcome = work.outcome;
    if (outcome.kind === "scan") { scans++; assert.ok(outcome.coverage.unavailable > 0); }
    else if (outcome.kind === "skipped") skips.set(outcome.taskRef, outcome.reason);
    else { if (outcome.kind !== "read") assert.fail("internal task unexpectedly stalled"); reads++; assert.equal(outcome.taskRef, ready.taskId); assert.equal(outcome.result.kind, "committed"); }
  }
  assert.ok(scans); assert.equal(skips.get(cancelled.taskId), "cancelled"); assert.equal(skips.get(broken.taskId), "unavailable");
  assert.equal((await f.status(foreign)).readProgress.committedPages, 0); assert.ok(reads); assert.equal(f.taskCalls(), reads);
});

test("empty source directory stays idle, invalid options are inert, and caller replacements cannot change binding", async t => {
  const f = await fixture(t, 0); let accesses = 0;
  const hostile = Object.defineProperty({ ...f.args }, "binding", { enumerable: true, get() { accesses++; return f.args.binding; } });
  for (const args of [hostile, { ...f.args, foregroundPulseLimit: 0 }, { ...f.args, foregroundPulseLimit: 9 }, { ...f.args, foregroundPulseLimit: undefined },
    { ...f.args, adapter: new Proxy(f.args.adapter, { getOwnPropertyDescriptor() { accesses++; throw Error(); } }) }])
    await assert.rejects(openStandingHistoryReadRunner(args as Parameters<typeof openStandingHistoryReadRunner>[0]), e => e instanceof StandingHistoryReadRunnerError && e.code === "input");
  assert.equal(accesses, 0);
  const mutable = { ...f.args, binding: { ...f.args.binding }, directories: { ...f.args.directories }, adapter: { ...f.args.adapter } };
  const opening = openStandingHistoryReadRunner(mutable); mutable.binding.peerId = "-100999"; mutable.directories.pages = join(f.root, "replaced");
  mutable.adapter.pollWork = async () => { throw Error("replaced adapter"); }; const runner = await opening; t.after(() => runner.close());
  assert.deepEqual(await runner.poll(), { kind: "idle" }); assert.equal(f.taskCalls(), 0);
  const task = await f.create("a"); const read = await runner.poll(); if (read.kind !== "background" || read.outcome.kind !== "read") throw Error();
  assert.equal(read.outcome.taskRef, task.taskId); assert.equal(read.outcome.result.kind, "committed");
  await assert.rejects(runner.revoke("bad"), e => e instanceof StandingHistoryReadRunnerError && e.code === "input");
  assert.deepEqual(await readdir(f.root), ["control", "pages"]);
});
