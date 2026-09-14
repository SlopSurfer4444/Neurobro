import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { createStandingConversationAdapter, StandingAdapterError, type StandingSelection } from "../src/standing-conversation-adapter.js";
import { SelfHistoryReaderError } from "../src/self-history-reader.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { createConversationReferences } from "../src/conversation-references.js";

const gate = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { done, promise }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const peer = () => new Api.PeerChannel({ channelId: bigInt(123) });
const self = () => new Api.User({ id: bigInt(789), self: true });
const message = (id: number, text = "ПРОМПТ question " + id, own = false) => new Api.Message({ id, date: id < 90 ? 80 : 100, message: text,
  peerId: peer(), fromId: new Api.PeerUser({ userId: bigInt(own ? 789 : 456) }), ...(own ? { out: true } : {}) });
function fixture(ids: number[] = []) {
  const values = [message(50, "saved history"), ...ids.map(id => message(id))], calls: Api.AnyRequest[] = [], checkpoints: number[] = [], questions: number[] = [];
  const control = new AbortController(), binding = { accountId: "789", peerId: utils.getPeerId(peer()) }, references = createConversationReferences(binding);
  let now = 0, active = 0, maximum = 0, override: ((r: Api.AnyRequest) => Promise<unknown>) | undefined;
  const batch = (messages: Api.TypeMessage[]) => new Api.messages.Messages({ messages, users: [self(), new Api.User({ id: bigInt(456), firstName: "Person" })], chats: [] });
  async function respond(r: Api.AnyRequest): Promise<unknown> {
    if (r instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({ dialogs: [new Api.Dialog({ peer: peer(), topMessage: 50,
      readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })],
      chats: [new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Group", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })], users: [], messages: [] });
    if (r instanceof Api.messages.GetHistory) return batch(values.filter(v => v.id > (r.minId ?? 0) && (!r.offsetId || v.id < r.offsetId) && (!r.offsetDate || v.date < r.offsetDate)).sort((a, b) => b.id - a.id).slice(0, r.limit));
    if (r instanceof Api.channels.GetMessages) { const id = (r.id[0] as Api.InputMessageID).id; return batch([values.find(v => v.id === id) ?? new Api.MessageEmpty({ id })]); }
    if (r instanceof Api.messages.SendMessage) {
      const id = Math.max(...values.map(v => v.id)) + 1, sent = message(id, r.message, true);
      sent.replyTo = new Api.MessageReplyHeader({ replyToMsgId: (r.replyTo as Api.InputReplyToMessage).replyToMsgId }); values.push(sent);
      return new Api.UpdateShortSentMessage({ id, out: true, pts: 1, ptsCount: 1, date: 100 });
    }
    if (r instanceof Api.messages.SetTyping) return true;
    throw Error("unexpected RPC");
  }
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "1".repeat(48), accountId: binding.accountId,
    chatId: binding.peerId, requesterId: "456", primaryMessageId: 80, fromDate: 1, toDate: 99, timezone: "Europe/Moscow", objective: "History" };
  return { values, calls, checkpoints, questions, control, references, intent, respond, batch,
    maximum: () => maximum, override: (value: typeof override) => { override = value; },
    options: { binding, references, self: self(), signal: control.signal, startedAt: 100, resumeCursor: 90, enableSelfHistory: true,
      checkpointCursor: async (id: number) => { checkpoints.push(id); }, checkpointQuestion: async (p: { messageId: number }) => { questions.push(p.messageId); },
      clock: () => now, wait: async (ms: number, signal: AbortSignal) => { assert.equal(signal.aborted, false); now += ms; },
      client: { async invoke(r: Api.AnyRequest) { calls.push(r); assert.ok(r.getBytes().length); active++; maximum = Math.max(maximum, active);
        try { await tick(); return await (override ? override(r) : respond(r)); } finally { active--; } } } } };
}
const adapterError = (code: string) => (e: unknown) => e instanceof StandingAdapterError && e.code === code;
const readerError = (code: string) => (e: unknown) => e instanceof SelfHistoryReaderError && e.code === code;
async function answer(selection: StandingSelection, signal: AbortSignal) {
  const input = { chatId: selection.primary.chatId, replyToMessageId: selection.primary.messageId, text: "Answer", randomId: "112233" };
  const sent = await selection.transport.sendOnce(input, signal); await selection.transport.readExact(input.chatId, sent.messageId, signal);
}

test("host credit runs history between continuously queued requests without consuming the next primary", async () => {
  const f = fixture([91, 92, 93, 94]), adapter = await createStandingConversationAdapter(f.options);
  const first = await adapter.pollNext(f.control.signal); assert.equal(first.kind, "selected"); if (first.kind !== "selected") throw Error();
  assert.equal(first.selection.primary.messageId, 91); await answer(first.selection, f.control.signal);
  for (const nextId of [92, 93, 94]) {
    const calls = f.calls.length, checkpoints = [...f.checkpoints], questions = [...f.questions];
    const pulse = await adapter.pollWork(f.control.signal, { backgroundDue: true }); assert.equal(pulse.kind, "background"); if (pulse.kind !== "background") throw Error();
    assert.equal(f.calls.length, calls); assert.deepEqual(f.checkpoints, checkpoints); assert.deepEqual(f.questions, questions);
    const lease = pulse.ticket.openHistoryTask({ intent: f.intent, signal: f.control.signal });
    assert.deepEqual(Object.keys(lease).sort(), ["close", "readTaskPage"]);
    const page = await lease.readTaskPage(); assert.deepEqual(page.sources.map(s => s.messageId), [50]); await lease.close();
    assert.equal(f.calls.length, calls + 1); assert.deepEqual(f.checkpoints, checkpoints); assert.deepEqual(f.questions, questions);
    const selected = await adapter.pollWork(f.control.signal, { backgroundDue: false }); assert.equal(selected.kind, "selected"); if (selected.kind !== "selected") throw Error();
    assert.equal(selected.selection.primary.messageId, nextId); await answer(selected.selection, f.control.signal);
  }
  assert.deepEqual(f.questions, [91, 92, 93, 94]); assert.equal(f.maximum(), 1); assert.equal(f.calls.filter(r => r instanceof Api.messages.GetDialogs).length, 1);
  await adapter.closeCapabilities(); f.references.close();
});

test("false work pulse preserves idle/more/selected outcomes and legacy next invalidates a model-only unused ticket", async () => {
  const f = fixture(), adapter = await createStandingConversationAdapter(f.options);
  const idle = await adapter.pollWork(f.control.signal, { backgroundDue: false }); assert.equal(idle.kind, "idle"); if (idle.kind !== "idle") throw Error();
  const calls = f.calls.length, background = await adapter.pollWork(f.control.signal, { backgroundDue: true }); assert.equal(background.kind, "background"); if (background.kind !== "background") throw Error();
  assert.equal(f.calls.length, calls); assert.throws(() => idle.ticket.openHistoryTask({ intent: f.intent, signal: f.control.signal }), readerError("aborted"));
  const stale = message(91, "reply to absent anchor"); stale.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 20 }); f.values.push(stale, message(92));
  assert.deepEqual(await adapter.pollWork(f.control.signal, { backgroundDue: false }), { kind: "more" });
  assert.throws(() => background.ticket.openHistoryTask({ intent: f.intent, signal: f.control.signal }), readerError("aborted"));
  const unused = await adapter.pollWork(f.control.signal, { backgroundDue: true }); if (unused.kind !== "background") throw Error();
  const selected = await adapter.next(f.control.signal); assert.equal(selected.primary.messageId, 92);
  assert.throws(() => unused.ticket.openHistoryTask({ intent: f.intent, signal: f.control.signal }), readerError("busy"));
  await answer(selected, f.control.signal); assert.throws(() => unused.ticket.openHistoryTask({ intent: f.intent, signal: f.control.signal }), readerError("aborted"));
  await adapter.closeCapabilities(); f.references.close();
});

test("task cancellation joins real shared-client I/O and preserves foreground admission", async () => {
  const f = fixture([91]), adapter = await createStandingConversationAdapter(f.options), task = new AbortController(), entered = gate(), finish = gate();
  const pulse = await adapter.pollWork(f.control.signal, { backgroundDue: true }); if (pulse.kind !== "background") throw Error();
  f.override(async r => { if (r instanceof Api.messages.GetHistory && r.offsetDate) { entered.done(); await finish.promise; } return f.respond(r); });
  const lease = pulse.ticket.openHistoryTask({ intent: f.intent, signal: task.signal }), pending = lease.readTaskPage(); await entered.promise;
  await assert.rejects(adapter.pollWork(f.control.signal, { backgroundDue: true }), adapterError("protocol"));
  assert.throws(() => pulse.ticket.openHistoryTask({ intent: f.intent, signal: task.signal }), readerError("busy"));
  task.abort(); let joined = false; const closing = lease.close().then(() => { joined = true; }); await tick(); assert.equal(joined, false);
  await assert.rejects(adapter.pollNext(f.control.signal), adapterError("protocol")); finish.done(); await assert.rejects(pending, readerError("aborted")); await closing;
  const selected = await adapter.pollWork(f.control.signal, { backgroundDue: false }); if (selected.kind !== "selected") throw Error();
  assert.equal(selected.selection.primary.messageId, 91); await assert.rejects(adapter.pollWork(f.control.signal, { backgroundDue: true }), adapterError("protocol"));
  await answer(selected.selection, f.control.signal); assert.equal(f.maximum(), 1); await adapter.closeCapabilities(); f.references.close();
});

test("global STOP or capability closure revokes background work and joins late I/O", async () => {
  for (const stop of [false, true]) {
    const f = fixture([91]), adapter = await createStandingConversationAdapter(f.options), entered = gate(), finish = gate();
    const pulse = await adapter.pollWork(f.control.signal, { backgroundDue: true }); if (pulse.kind !== "background") throw Error();
    f.override(async r => { if (r instanceof Api.messages.GetHistory) { entered.done(); await finish.promise; } return f.respond(r); });
    const lease = pulse.ticket.openHistoryTask({ intent: f.intent, signal: new AbortController().signal }), pending = lease.readTaskPage(); await entered.promise;
    if (stop) f.control.abort(); let settled = false; const closing = adapter.closeCapabilities().then(() => { settled = true; }); await tick(); assert.equal(settled, false);
    finish.done(); await assert.rejects(pending, readerError("aborted")); await closing;
    await assert.rejects(adapter.pollWork(new AbortController().signal, { backgroundDue: true }), adapterError("aborted"));
    assert.throws(() => pulse.ticket.openHistoryTask({ intent: f.intent, signal: new AbortController().signal }), readerError("aborted"));
    assert.deepEqual(f.questions, []); assert.deepEqual(f.checkpoints, []); f.references.close();
  }
});

test("background admission cannot race an admitted foreground collection", async () => {
  const f = fixture([91]), adapter = await createStandingConversationAdapter(f.options), entered = gate(), finish = gate();
  f.override(async r => { if (r instanceof Api.messages.GetHistory && r.minId) { entered.done(); await finish.promise; } return f.respond(r); });
  const polling = adapter.pollWork(f.control.signal, { backgroundDue: false }); await entered.promise;
  const before = f.calls.length; await assert.rejects(adapter.pollWork(f.control.signal, { backgroundDue: true }), adapterError("protocol"));
  assert.equal(f.calls.length, before); assert.deepEqual(f.questions, []); finish.done();
  const selected = await polling; if (selected.kind !== "selected") throw Error(); assert.equal(selected.selection.primary.messageId, 91);
  await answer(selected.selection, f.control.signal); assert.equal(f.maximum(), 1); await adapter.closeCapabilities(); f.references.close();
});

test("invalid host scheduling shapes execute no getters or proxy traps and do not close the adapter", async () => {
  const f = fixture(), adapter = await createStandingConversationAdapter(f.options), before = f.calls.length;
  let accessed = 0; const hostile = Object.defineProperty({}, "backgroundDue", { enumerable: true, get() { accessed++; return true; } });
  const proxy = new Proxy({ backgroundDue: true }, { ownKeys() { accessed++; throw Error(); }, getPrototypeOf() { accessed++; throw Error(); } });
  for (const options of [null, {}, { backgroundDue: 1 }, { backgroundDue: true, extra: true }, hostile, proxy]) {
    await assert.rejects(adapter.pollWork(f.control.signal, options as { backgroundDue: boolean }), adapterError("protocol"));
  }
  assert.equal(accessed, 0); assert.equal(f.calls.length, before);
  const one = await adapter.pollWork(f.control.signal, { backgroundDue: true }), two = await adapter.pollWork(f.control.signal, { backgroundDue: true });
  if (one.kind !== "background" || two.kind !== "background") throw Error();
  assert.throws(() => one.ticket.openHistoryTask({ intent: f.intent, signal: f.control.signal }), readerError("aborted"));
  const lease = two.ticket.openHistoryTask({ intent: f.intent, signal: f.control.signal }); await lease.close();
  assert.equal(f.calls.length, before); await adapter.closeCapabilities(); f.references.close();
});
