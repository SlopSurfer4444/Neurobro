import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { createStandingConversationAdapter, StandingAdapterError, type StandingSelection, type StandingIdleHistoryTicket } from "../src/standing-conversation-adapter.js";
import { SelfHistoryReaderError } from "../src/self-history-reader.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { createConversationReferences } from "../src/conversation-references.js";

const gate = () => { let done!: () => void; const promise = new Promise<void>(r => { done = r; }); return { done, promise }; };
const tick = () => new Promise<void>(r => setImmediate(r));
const self = () => new Api.User({ id: bigInt(789), self: true });
const peer = (basic: boolean) => basic ? new Api.PeerChat({ chatId: bigInt(123) }) : new Api.PeerChannel({ channelId: bigInt(123) });
function message(id: number, text = "ordinary history", basic = false, author = "456"): Api.Message {
  return new Api.Message({ id, date: 100, message: text, peerId: peer(basic), fromId: new Api.PeerUser({ userId: bigInt(author) }), ...(author === "789" ? { out: true } : {}) });
}
function fixture(initial: Api.Message[] = [], basic = false) {
  const values = [...initial], calls: Api.AnyRequest[] = [], checkpoints: number[] = [], observed: unknown[] = [], control = new AbortController();
  const binding = { accountId: "789", peerId: utils.getPeerId(peer(basic)) }, references = createConversationReferences(binding);
  let time = 0, override: ((r: Api.AnyRequest) => Promise<unknown>) | undefined, waitOverride: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  const user = () => new Api.User({ id: bigInt(456), firstName: "Саша" });
  const batch = (rows: Api.TypeMessage[]) => new Api.messages.Messages({ messages: rows, users: [self(), user()], chats: [] });
  const respond = async (r: Api.AnyRequest): Promise<unknown> => {
    if (r instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({
      dialogs: [new Api.Dialog({ peer: peer(basic), topMessage: 50, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })],
      chats: [basic ? new Api.Chat({ id: bigInt(123), title: "Group", photo: new Api.ChatPhotoEmpty(), date: 1, participantsCount: 2, version: 1 }) :
        new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Group", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })], users: [], messages: [] });
    if (r instanceof Api.messages.GetHistory) return batch(values.filter(v => v.id > (r.minId ?? 0) && (!r.offsetId || v.id < r.offsetId) && (!r.offsetDate || v.date < r.offsetDate)).sort((a, b) => b.id - a.id).slice(0, r.limit));
    if (r instanceof Api.channels.GetMessages || r instanceof Api.messages.GetMessages) {
      const id = (r.id[0] as Api.InputMessageID).id; return batch([values.find(v => v.id === id) ?? new Api.MessageEmpty({ id })]);
    }
    if (r instanceof Api.messages.SendMessage) {
      const id = Math.max(90, ...values.map(v => v.id)) + 1, sent = message(id, r.message, basic, "789");
      sent.replyTo = new Api.MessageReplyHeader({ replyToMsgId: (r.replyTo as Api.InputReplyToMessage).replyToMsgId }); values.push(sent);
      return new Api.UpdateShortSentMessage({ id, out: true, pts: 1, ptsCount: 1, date: 100 });
    }
    if (r instanceof Api.messages.SetTyping) return true;
    throw Error("unexpected fixture call");
  };
  const options = { binding, references, self: self(), signal: control.signal, startedAt: 100, resumeCursor: 90,
    enableSelfHistory: true, enableGroupTools: true, enableBoundActions: true,
    checkpointCursor: async (id: number) => { checkpoints.push(id); }, clock: () => time,
    wait: async (ms: number, signal: AbortSignal) => { if (waitOverride) return waitOverride(ms, signal); assert.equal(signal.aborted, false); time += ms; },
    sourceObserver: { async observe(envelope: unknown) { observed.push(envelope); } },
    client: { async invoke(r: Api.AnyRequest) { calls.push(r); assert.ok(r.getBytes().length > 0); return override ? override(r) : respond(r); } } };
  const intent = (): StandingHistoryTaskIntent => ({ schema: "standing-history-task-v1", taskId: "htask_" + "1".repeat(48), accountId: binding.accountId, chatId: binding.peerId,
    requesterId: "456", primaryMessageId: 80, fromDate: 1, toDate: 200, timezone: "Europe/Moscow", objective: "Read prior history" });
  return { values, calls, checkpoints, observed, options, references, control, intent, respond, batch,
    override: (value: typeof override) => { override = value; }, waitOverride: (value: typeof waitOverride) => { waitOverride = value; }, advance: (ms: number) => { time += ms; } };
}
const adapterCode = (expected: string) => (e: unknown) => e instanceof StandingAdapterError && e.code === expected;
const readerCode = (expected: string) => (e: unknown) => e instanceof SelfHistoryReaderError && e.code === expected;
async function ticket(adapter: Awaited<ReturnType<typeof createStandingConversationAdapter>>, signal: AbortSignal): Promise<StandingIdleHistoryTicket> {
  const result = await adapter.pollNext(signal); assert.equal(result.kind, "idle"); if (result.kind !== "idle") throw Error(); return result.ticket;
}
async function answer(selection: StandingSelection, signal: AbortSignal) {
  const input = { chatId: selection.primary.chatId, replyToMessageId: selection.primary.messageId, text: "Answer", randomId: "112233" };
  const sent = await selection.transport.sendOnce(input, signal); await selection.transport.readExact(input.chatId, sent.messageId, signal);
}

test("one idle pulse issues a synchronously consumed ticket and one same-client task page before foreground continues", async () => {
  for (const basic of [false, true]) {
    const f = fixture([message(50, "earlier text", basic)], basic), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal);
    assert.equal(f.calls.filter(r => r instanceof Api.messages.GetHistory).length, 1);
    const task = new AbortController(), lease = idle.openHistoryTask({ intent: f.intent(), signal: task.signal }), before = f.calls.length, observed = f.observed.length;
    assert.throws(() => idle.openHistoryTask({ intent: f.intent(), signal: task.signal }), readerCode("busy"));
    await assert.rejects(adapter.pollNext(f.control.signal), adapterCode("protocol")); await assert.rejects(adapter.next(f.control.signal), adapterCode("protocol"));
    assert.equal((await adapter.selfHistory!.call({ fromDate: 1, toDate: 200, cursor: null })).success, false);
    const group = await adapter.extraTools![0]!.call({}, { requestRef: "task", callRef: "group", signal: task.signal }) as { success: boolean }; assert.equal(group.success, false);
    assert.equal(f.calls.length, before);
    const result = await lease.readTaskPage(); assert.deepEqual(result.sources.map(s => s.messageId), [50]); assert.equal(result.page.messages[0]!.text, "earlier text");
    assert.equal(result.beforeCheckpoint.offsetId, 0); assert.equal(result.nextCheckpoint.offsetId, 50); assert.equal(f.observed.length, observed);
    assert.equal(f.calls.length, before + 1); assert.equal(f.calls.filter(r => r instanceof Api.messages.GetDialogs).length, 1);
    await assert.rejects(lease.readTaskPage(), readerCode("busy")); await lease.close();
    assert.throws(() => idle.openHistoryTask({ intent: f.intent(), signal: task.signal }), readerCode("aborted"));
    f.values.push(message(91, "ПРОМПТ next", basic)); const selected = await adapter.pollNext(f.control.signal); assert.equal(selected.kind, "selected");
    if (selected.kind !== "selected") throw Error(); await answer(selected.selection, f.control.signal);
    assert.equal((await adapter.pollNext(f.control.signal)).kind, "idle"); await adapter.closeCapabilities(); f.references.close();
  }
});

test("a rejected candidate returns more and cannot turn remaining queued work or a stale collection into idle", async () => {
  const missing = message(91, "reply to unavailable anchor"); missing.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 20 });
  const f = fixture([missing, message(92, "ПРОМПТ real request")]), adapter = await createStandingConversationAdapter(f.options);
  assert.deepEqual(await adapter.pollNext(f.control.signal), { kind: "more" });
  const count = f.calls.filter(r => r instanceof Api.messages.GetHistory).length;
  const result = await adapter.pollNext(f.control.signal); assert.equal(result.kind, "selected"); if (result.kind !== "selected") throw Error();
  assert.equal(result.selection.primary.messageId, 92); assert.ok(f.calls.filter(r => r instanceof Api.messages.GetHistory).length <= count + 1); await answer(result.selection, f.control.signal);
  await adapter.closeCapabilities(); f.references.close();
  const only = fixture([missing]), a = await createStandingConversationAdapter(only.options);
  assert.deepEqual(await a.pollNext(only.control.signal), { kind: "more" }); const before = only.calls.length;
  assert.equal((await a.pollNext(only.control.signal)).kind, "idle"); assert.ok(only.calls.length > before); assert.deepEqual(only.checkpoints, [91]); await a.closeCapabilities(); only.references.close();
});

test("ordinary-only collection persists its exact scanned frontier before issuing idle and checkpoint failure yields no ticket", async () => {
  for (const failCheckpoint of [false, true]) {
    const f = fixture([message(95, "ordinary new traffic")]), entered = gate(), finish = gate();
    const adapter = await createStandingConversationAdapter({ ...f.options, checkpointCursor: async id => {
      assert.equal(id, 95); entered.done(); await finish.promise; if (failCheckpoint) throw Error("storage failure"); f.checkpoints.push(id);
    } });
    let returned = false; const polling = adapter.pollNext(f.control.signal).then(value => { returned = true; return value; });
    await entered.promise; await tick(); assert.equal(returned, false); assert.deepEqual(f.checkpoints, []); finish.done();
    if (failCheckpoint) { await assert.rejects(polling, adapterCode("checkpoint")); await assert.rejects(adapter.pollNext(f.control.signal), adapterCode("aborted")); }
    else { assert.equal((await polling).kind, "idle"); assert.deepEqual(f.checkpoints, [95]); }
    await adapter.closeCapabilities(); f.references.close();
  }
});

test("new polling invalidates an unused idle ticket and terminal or foreign task scope never consumes a valid one", async () => {
  const f = fixture(), adapter = await createStandingConversationAdapter(f.options), first = await ticket(adapter, f.control.signal), second = await ticket(adapter, f.control.signal);
  const task = new AbortController(); assert.throws(() => first.openHistoryTask({ intent: f.intent(), signal: task.signal }), readerCode("aborted"));
  const before = f.calls.length;
  assert.throws(() => second.openHistoryTask({ intent: { ...f.intent(), chatId: "-999" }, signal: task.signal }), readerCode("binding"));
  let accesses = 0; const hostile = { intent: f.intent(), signal: task.signal }; Object.defineProperty(hostile, "intent", { enumerable: true, get() { accesses++; return f.intent(); } });
  assert.throws(() => second.openHistoryTask(hostile), readerCode("input")); assert.equal(accesses, 0); assert.equal(f.calls.length, before);
  const lease = second.openHistoryTask({ intent: f.intent(), signal: task.signal }); const result = await lease.readTaskPage(); await lease.close();
  assert.equal(result.nextCheckpoint.status, "empty-page"); const third = await ticket(adapter, f.control.signal), calls = f.calls.length;
  assert.throws(() => third.openHistoryTask({ intent: f.intent(), checkpoint: result.nextCheckpoint, signal: task.signal }), readerCode("input")); assert.equal(f.calls.length, calls);
  const valid = third.openHistoryTask({ intent: f.intent(), signal: task.signal }); await valid.close(); await adapter.closeCapabilities(); f.references.close();
});

test("task cancellation during rate wait never invokes history and leaves foreground adapter alive", async () => {
  const f = fixture(), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal), task = new AbortController(), entered = gate();
  f.waitOverride(async (_ms, signal) => { entered.done(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true })); });
  const lease = idle.openHistoryTask({ intent: f.intent(), signal: task.signal }), before = f.calls.length, pending = lease.readTaskPage(); await entered.promise; task.abort();
  await assert.rejects(pending, readerCode("aborted")); await lease.close(); assert.equal(f.calls.length, before); f.waitOverride(undefined);
  f.values.push(message(91, "ПРОМПТ after cancelled background")); const selected = await adapter.next(f.control.signal); assert.equal(selected.primary.messageId, 91);
  await answer(selected, f.control.signal); await adapter.closeCapabilities(); f.references.close();
});

test("task cancel and lease close join late real I/O and keep new foreground polling blocked until settlement", async () => {
  for (const bySignal of [true, false]) {
    const f = fixture([message(50)]), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal), task = new AbortController(), entered = gate(), finish = gate();
    let returned: Api.messages.Messages | undefined;
    f.override(async r => { if (r instanceof Api.messages.GetHistory && r.offsetDate) { entered.done(); await finish.promise; returned = f.batch([message(50)]); return returned; } return f.respond(r); });
    const lease = idle.openHistoryTask({ intent: f.intent(), signal: task.signal }), pending = lease.readTaskPage(); await entered.promise;
    if (bySignal) task.abort(); let joined = false; const closing = lease.close().then(() => { joined = true; }); await tick(); assert.equal(joined, false);
    await assert.rejects(adapter.pollNext(f.control.signal), adapterCode("protocol")); finish.done(); await assert.rejects(pending, readerCode("aborted")); await closing;
    assert.equal(joined, true); assert.equal(returned!.messages.length, 0); f.values.push(message(91, "ПРОМПТ foreground survives"));
    const selected = await adapter.next(f.control.signal); await answer(selected, f.control.signal); await adapter.closeCapabilities(); f.references.close();
  }
});

test("global STOP and closeCapabilities revoke idle tickets and join pending task I/O before capability closure", async () => {
  for (const globalSignal of [false, true]) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal), entered = gate(), finish = gate();
    f.override(async r => { if (r instanceof Api.messages.GetHistory && r.offsetDate) { entered.done(); await finish.promise; } return f.respond(r); });
    const lease = idle.openHistoryTask({ intent: f.intent(), signal: new AbortController().signal }), work = lease.readTaskPage(); await entered.promise;
    if (globalSignal) f.control.abort(); let settled = false; const closing = adapter.closeCapabilities().then(() => { settled = true; }); await tick(); assert.equal(settled, false);
    finish.done(); await assert.rejects(work, readerCode("aborted")); await closing; assert.equal(settled, true);
    await assert.rejects(adapter.pollNext(new AbortController().signal), adapterCode("aborted"));
    assert.throws(() => idle.openHistoryTask({ intent: f.intent(), signal: new AbortController().signal }), readerCode("aborted")); f.references.close();
  }
});

test("idle task checkpoints resume on a new pulse and reader while fresh foreground polls retain priority", async () => {
  const f = fixture(Array.from({ length: 105 }, (_, i) => message(i + 1))), adapter = await createStandingConversationAdapter({ ...f.options, resumeCursor: 200 });
  const task = new AbortController(), one = (await ticket(adapter, f.control.signal)).openHistoryTask({ intent: f.intent(), signal: task.signal });
  const first = await one.readTaskPage(); await one.close(); assert.equal(first.sources.length, 100); assert.equal(first.nextCheckpoint.offsetId, 6);
  const two = (await ticket(adapter, f.control.signal)).openHistoryTask({ intent: f.intent(), checkpoint: JSON.parse(JSON.stringify(first.nextCheckpoint)), signal: task.signal });
  const last = await two.readTaskPage(); await two.close(); assert.deepEqual(last.sources.map(row => row.messageId), [5, 4, 3, 2, 1]);
  assert.equal(last.beforeCheckpoint.offsetId, 6); assert.equal(last.nextCheckpoint.upperBoundMessageId, 105); assert.equal(f.checkpoints.length, 0);
  await adapter.closeCapabilities(); f.references.close();
});

test("cancel before starting a task releases its reservation without consuming a foreground cursor or calling Telegram", async () => {
  const f = fixture(), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal), task = new AbortController();
  const lease = idle.openHistoryTask({ intent: f.intent(), signal: task.signal }), before = f.calls.length; task.abort(); await lease.close();
  await assert.rejects(lease.readTaskPage(), readerCode("aborted")); assert.equal(f.calls.length, before); assert.deepEqual(f.checkpoints, []);
  f.values.push(message(91, "ПРОМПТ after unused cancellation")); const result = await adapter.pollNext(f.control.signal); assert.equal(result.kind, "selected");
  if (result.kind !== "selected") throw Error(); await answer(result.selection, f.control.signal); await adapter.closeCapabilities(); f.references.close();
});

test("idle task uses captured client and task checkpoint snapshot; a private read refusal does not close foreground", async () => {
  const f = fixture([message(50)]), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal), task = new AbortController();
  const mutableIntent = { ...f.intent() }, lease = idle.openHistoryTask({ intent: mutableIntent, signal: task.signal });
  mutableIntent.fromDate = 150; mutableIntent.chatId = "-999";
  f.options.client = { async invoke() { throw Error("replaced client must not be called"); } };
  const page = await lease.readTaskPage(); await lease.close(); assert.equal(page.beforeCheckpoint.fromDate, 1); assert.equal(page.beforeCheckpoint.chatId, f.intent().chatId);
  assert.deepEqual(page.sources.map(row => row.messageId), [50]);
  const nextTicket = await ticket(adapter, f.control.signal), mutableCheckpoint = { ...page.nextCheckpoint };
  const next = nextTicket.openHistoryTask({ intent: f.intent(), checkpoint: mutableCheckpoint, signal: task.signal }); mutableCheckpoint.offsetId = 999;
  f.override(async r => { if (r instanceof Api.messages.GetHistory && r.offsetDate === 0 && r.minId === 0) { assert.equal(r.offsetId, 50); throw Error("private transport detail"); } return f.respond(r); });
  await assert.rejects(next.readTaskPage(), readerCode("transport")); await next.close(); f.override(undefined);
  f.values.push(message(91, "ПРОМПТ after failed readonly page")); const selected = await adapter.next(f.control.signal); await answer(selected, f.control.signal);
  await adapter.closeCapabilities(); f.references.close();
});
