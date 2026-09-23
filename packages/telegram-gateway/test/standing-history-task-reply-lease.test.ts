import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { createStandingConversationAdapter, StandingAdapterError, type StandingIdleHistoryTicket, type StandingSelection } from "../src/standing-conversation-adapter.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { createEncryptedPilotStore, runPilotReply, type PilotSend, type PilotTransport, type PilotRecord } from "../src/pilot-outbox.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";

const gate = () => { let done!: () => void; const promise = new Promise<void>(r => { done = r; }); return { done, promise }; };
const tick = () => new Promise<void>(r => setImmediate(r));
const self = () => new Api.User({ id: bigInt(789), self: true });
const peer = (basic: boolean) => basic ? new Api.PeerChat({ chatId: bigInt(123) }) : new Api.PeerChannel({ channelId: bigInt(123) });
function message(id: number, text = "ordinary edited request", basic = false, author = "456"): Api.Message {
  return new Api.Message({ id, date: 100, message: text, peerId: peer(basic), fromId: new Api.PeerUser({ userId: bigInt(author) }), ...(author === "789" ? { out: true } : {}) });
}
function fixture(basic = false, initial = [message(80, undefined, basic)]) {
  const values = [...initial], calls: Api.AnyRequest[] = [], checkpoints: number[] = [], control = new AbortController();
  const binding = { accountId: "789", peerId: utils.getPeerId(peer(basic)) }, references = createConversationReferences(binding);
  let time = 0, override: ((r: Api.AnyRequest) => Promise<unknown>) | undefined;
  const batch = (rows: Api.TypeMessage[]) => new Api.messages.Messages({ messages: rows, users: [self(), new Api.User({ id: bigInt(456), firstName: "Саша" })], chats: [] });
  const respond = async (r: Api.AnyRequest): Promise<unknown> => {
    if (r instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({
      dialogs: [new Api.Dialog({ peer: peer(basic), topMessage: 80, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })],
      chats: [basic ? new Api.Chat({ id: bigInt(123), title: "Group", photo: new Api.ChatPhotoEmpty(), date: 1, participantsCount: 2, version: 1 }) :
        new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Group", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })], users: [], messages: [] });
    if (r instanceof Api.messages.GetHistory) return batch(values.filter(v => v.id > (r.minId ?? 0) && (!r.offsetId || v.id < r.offsetId) && (!r.offsetDate || v.date < r.offsetDate)).sort((a, b) => b.id - a.id).slice(0, r.limit));
    if (r instanceof Api.channels.GetMessages || r instanceof Api.messages.GetMessages) {
      const id = (r.id[0] as Api.InputMessageID).id; return batch([values.find(v => v.id === id) ?? new Api.MessageEmpty({ id })]);
    }
    if (r instanceof Api.messages.SendMessage) {
      const id = Math.max(90, ...values.map(v => v.id)) + 1, sent = message(id, r.message, basic, "789");
      if (r.replyTo) sent.replyTo = new Api.MessageReplyHeader({ replyToMsgId: (r.replyTo as Api.InputReplyToMessage).replyToMsgId });
      if (r.entities !== undefined) sent.entities = r.entities;
      values.push(sent);
      return new Api.UpdateShortSentMessage({ id, out: true, pts: 1, ptsCount: 1, date: 100 });
    }
    if (r instanceof Api.messages.SetTyping) return true;
    throw Error("unexpected synthetic request");
  };
  const options = { binding, references, self: self(), signal: control.signal, startedAt: 100, resumeCursor: 90,
    enableSelfHistory: true, enableGroupTools: true, enableBoundActions: true,
    checkpointCursor: async (id: number) => { checkpoints.push(id); }, clock: () => time,
    wait: async (ms: number, signal: AbortSignal) => { assert.equal(signal.aborted, false); time += ms; },
    client: { async invoke(r: Api.AnyRequest) { calls.push(r); assert.ok(r.getBytes().length > 0); return override ? override(r) : respond(r); } } };
  const intent = (): StandingHistoryTaskIntent => ({ schema: "standing-history-task-v1", taskId: "htask_" + "1".repeat(48), accountId: binding.accountId, chatId: binding.peerId,
    requesterId: "456", primaryMessageId: 80, fromDate: 1, toDate: 200, timezone: "Europe/Moscow", objective: "Read prior history" });
  const reply = (): PilotSend => ({ chatId: binding.peerId, replyToMessageId: 80, text: "History result", randomId: "112233" });
  return { values, calls, checkpoints, options, references, control, intent, reply, respond, batch, override: (value: typeof override) => { override = value; } };
}
type Adapter = Awaited<ReturnType<typeof createStandingConversationAdapter>>;
async function ticket(adapter: Adapter, signal: AbortSignal): Promise<StandingIdleHistoryTicket> {
  const value = await adapter.pollNext(signal); assert.equal(value.kind, "idle"); if (value.kind !== "idle") throw Error(); return value.ticket;
}
const sends = (f: ReturnType<typeof fixture>) => f.calls.filter(r => r instanceof Api.messages.SendMessage);
const exactReads = (f: ReturnType<typeof fixture>) => f.calls.filter(r => r instanceof Api.channels.GetMessages || r instanceof Api.messages.GetMessages);
async function answer(selection: StandingSelection, signal: AbortSignal) {
  const reply = { chatId: selection.primary.chatId, replyToMessageId: selection.primary.messageId, text: "Foreground answer", randomId: "223344" };
  const sent = await selection.transport.sendOnce(reply, signal); await selection.transport.readExact(reply.chatId, sent.messageId, signal);
}
async function foreground(f: ReturnType<typeof fixture>, adapter: Adapter) {
  f.values.push(message(101, "ПРОМПТ foreground continues"));
  const selected = await adapter.next(f.control.signal); assert.equal(selected.primary.messageId, 101); await answer(selected, f.control.signal);
}
async function privateDirectory(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "standing-task-reply-"));
  t.after(async () => { assert.equal(dirname(resolve(parent)), resolve(tmpdir())); await rm(parent, { recursive: true, force: true }); });
  return parent;
}
const phrase = "synthetic task reply store phrase";
function dispatch(f: ReturnType<typeof fixture>, transport: PilotTransport, directory: string, text = "History result") {
  return runPilotReply({ approved: { accountId: "789", chatId: f.options.binding.peerId, replyToMessageId: 80, maximumTextBytes: 4096 },
    reply: { chatId: f.options.binding.peerId, replyToMessageId: 80, text }, store: createEncryptedPilotStore(directory, phrase), transport,
    killSwitchEngaged: () => false, signal: f.control.signal });
}

test("task reply revalidates ordinary edited primary and verifies one actual basic/channel send through encrypted outbox", async t => {
  const parent = await privateDirectory(t);
  for (const basic of [false, true]) {
    const f = fixture(basic), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal);
    const before = f.calls.length, checkpoints = [...f.checkpoints], task = new AbortController();
    const lease = idle.openTaskReply({ intent: f.intent(), signal: task.signal });
    const directory = join(parent, basic ? "basic-final" : "channel-final");
    assert.deepEqual(await dispatch(f, lease.transport, directory), { state: "verified", code: "verified" }); await lease.close();
    const delivery = f.calls.slice(before); assert.equal(delivery.length, 3);
    assert.ok(basic ? delivery[0] instanceof Api.messages.GetMessages : delivery[0] instanceof Api.channels.GetMessages);
    assert.ok(delivery[1] instanceof Api.messages.SendMessage);
    assert.ok(basic ? delivery[2] instanceof Api.messages.GetMessages : delivery[2] instanceof Api.channels.GetMessages);
    assert.equal((delivery[0] as Api.messages.GetMessages).id.length, 1);
    assert.equal(((delivery[0] as Api.messages.GetMessages).id[0] as Api.InputMessageID).id, 80);
    assert.equal((delivery[1] as Api.messages.SendMessage).sendAs instanceof Api.InputPeerSelf, true);
    assert.equal((delivery[1] as Api.messages.SendMessage).allowPaidFloodskip, false);
    assert.deepEqual(f.checkpoints, checkpoints); assert.deepEqual((await readdir(directory)).sort(), ["planned.enc", "sending.enc", "terminal.enc"]);
    await assert.rejects(lease.transport.sendOnce(f.reply(), task.signal)); assert.equal(sends(f).length, 1);
    await adapter.closeCapabilities(); f.references.close();
  }
});

test("invalid task scope and executable input refuse locally without consuming valid ticket", async () => {
  const f = fixture(), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal), task = new AbortController(), before = f.calls.length;
  for (const patch of [{ chatId: "-999" }, { accountId: "999" }, { taskId: "bad" }, { requesterId: "0" }, { primaryMessageId: 0 }]) {
    assert.throws(() => idle.openTaskReply({ intent: { ...f.intent(), ...patch }, signal: task.signal }));
  }
  let accesses = 0; const hostile = { intent: f.intent(), signal: task.signal };
  Object.defineProperty(hostile, "intent", { enumerable: true, get() { accesses++; return f.intent(); } });
  assert.throws(() => idle.openTaskReply(hostile)); assert.equal(accesses, 0); assert.equal(f.calls.length, before);
  const lease = idle.openTaskReply({ intent: f.intent(), signal: task.signal }); await lease.close();
  await foreground(f, adapter); await adapter.closeCapabilities(); f.references.close();
});

test("missing, foreign-peer, wrong-requester and own anchors never reach SendMessage or close foreground", async () => {
  for (const kind of ["missing", "foreign", "requester", "own", "post"] as const) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal), task = new AbortController();
    if (kind === "missing") f.values.length = 0;
    else if (kind === "foreign") f.values[0]!.peerId = new Api.PeerChannel({ channelId: bigInt(999) });
    else if (kind === "requester") f.values[0]!.fromId = new Api.PeerUser({ userId: bigInt(999) });
    else if (kind === "own") { f.values[0]!.fromId = new Api.PeerUser({ userId: bigInt(789) }); f.values[0]!.out = true; }
    else f.values[0]!.post = true;
    const lease = idle.openTaskReply({ intent: f.intent(), signal: task.signal });
    await assert.rejects(lease.transport.sendOnce(f.reply(), task.signal)); await lease.close(); assert.equal(sends(f).length, 0);
    assert.equal(exactReads(f).length, 1); await foreground(f, adapter); await adapter.closeCapabilities(); f.references.close();
  }
});

test("reply binding, byte, randomId and entity limits reject before anchor I/O", async () => {
  const invalid: Partial<PilotSend>[] = [{ chatId: "-999" }, { replyToMessageId: 81 }, { text: "я".repeat(2049) }, { text: "bad\0text" },
    { text: " " }, { randomId: "0" }, { randomId: "9223372036854775808" }, { entities: [{ type: "bold", offset: 0, length: 999 }] }];
  for (const patch of invalid) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal }), before = f.calls.length;
    await assert.rejects(lease.transport.sendOnce({ ...f.reply(), ...patch }, task.signal)); await lease.close(); assert.equal(f.calls.length, before);
    await foreground(f, adapter); await adapter.closeCapabilities(); f.references.close();
  }
});

test("history and final reply are mutually exclusive consumers and polling invalidates stale tickets", async () => {
  const f = fixture(), adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
  const stale = await ticket(adapter, f.control.signal), current = await ticket(adapter, f.control.signal);
  assert.throws(() => stale.openTaskReply({ intent: f.intent(), signal: task.signal }));
  const reply = current.openTaskReply({ intent: f.intent(), signal: task.signal });
  assert.throws(() => current.openTaskReply({ intent: f.intent(), signal: task.signal }));
  assert.throws(() => current.openHistoryTask({ intent: f.intent(), signal: task.signal }));
  await assert.rejects(adapter.pollNext(f.control.signal), e => e instanceof StandingAdapterError && e.code === "protocol"); await reply.close();
  const next = await ticket(adapter, f.control.signal), history = next.openHistoryTask({ intent: f.intent(), signal: task.signal });
  assert.throws(() => next.openTaskReply({ intent: f.intent(), signal: task.signal })); await history.close();
  await adapter.closeCapabilities(); f.references.close();
});

test("background reply preserves existing foreground queue and checkpoint ordering", async () => {
  const f = fixture(false, [message(80), message(91, "ПРОМПТ first"), message(92, "ПРОМПТ second")]), adapter = await createStandingConversationAdapter(f.options);
  const first = await adapter.next(f.control.signal); assert.equal(first.primary.messageId, 91); await answer(first, f.control.signal);
  const before = [...f.checkpoints], pulse = await adapter.pollWork(f.control.signal, { backgroundDue: true }); assert.equal(pulse.kind, "background");
  if (pulse.kind !== "background") throw Error();
  const task = new AbortController(), lease = pulse.ticket.openTaskReply({ intent: f.intent(), signal: task.signal });
  const sent = await lease.transport.sendOnce(f.reply(), task.signal); await lease.transport.readExact(f.reply().chatId, sent.messageId, task.signal); await lease.close();
  assert.deepEqual(f.checkpoints, before); const second = await adapter.next(f.control.signal); assert.equal(second.primary.messageId, 92);
  await answer(second, f.control.signal); await adapter.closeCapabilities(); f.references.close();
});

test("local task/call abort and lease close join late SendMessage while foreground remains usable", async () => {
  for (const mode of ["task", "call", "close"] as const) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), task = new AbortController(), call = new AbortController(), entered = gate(), finish = gate();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal });
    f.override(async r => { if (r instanceof Api.messages.SendMessage) { entered.done(); await finish.promise; } return f.respond(r); });
    const pending = lease.transport.sendOnce(f.reply(), call.signal), rejected = assert.rejects(pending); await entered.promise;
    if (mode === "task") task.abort(); if (mode === "call") call.abort();
    let joined = false; const closing = lease.close().then(() => { joined = true; }); await tick(); assert.equal(joined, false);
    await assert.rejects(adapter.pollNext(f.control.signal), e => e instanceof StandingAdapterError && e.code === "protocol");
    finish.done(); await rejected; await closing; assert.equal(joined, true); assert.equal(sends(f).length, 1); assert.equal(f.control.signal.aborted, false);
    f.override(undefined); await foreground(f, adapter); await adapter.closeCapabilities(); f.references.close();
  }
});

test("global STOP or capability close joins late task SendMessage and permanently closes adapter", async () => {
  for (const stop of [false, true]) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), entered = gate(), finish = gate(), task = new AbortController();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal });
    f.override(async r => { if (r instanceof Api.messages.SendMessage) { entered.done(); await finish.promise; } return f.respond(r); });
    const pending = lease.transport.sendOnce(f.reply(), task.signal), rejected = assert.rejects(pending); await entered.promise;
    if (stop) f.control.abort(); let joined = false; const closing = adapter.closeCapabilities().then(() => { joined = true; }); await tick(); assert.equal(joined, false);
    finish.done(); await rejected; await closing; assert.equal(joined, true); assert.equal(sends(f).length, 1);
    await assert.rejects(adapter.pollNext(new AbortController().signal), e => e instanceof StandingAdapterError && e.code === "aborted");
    await lease.close(); f.references.close();
  }
});

test("exact readback refuses wrong message/peer/author/anchor/text/entities and never resends", async () => {
  for (const kind of ["id", "peer", "author", "anchor", "text", "entities"] as const) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal });
    const reply = { ...f.reply(), entities: [{ type: "bold" as const, offset: 0, length: 7 }] }, sent = await lease.transport.sendOnce(reply, task.signal);
    const row = f.values.find(v => v.id === sent.messageId)!;
    if (kind === "peer") row.peerId = new Api.PeerChannel({ channelId: bigInt(999) });
    if (kind === "author") row.fromId = new Api.PeerUser({ userId: bigInt(456) });
    if (kind === "anchor") row.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 79 });
    if (kind === "text") row.message = "Different result";
    if (kind === "entities") row.entities = [];
    if (kind === "entities") {
      // The transport may return the observed entities; the outbox performs exact comparison.
      const read = await lease.transport.readExact(reply.chatId, sent.messageId, task.signal).catch(() => null);
      if (read) assert.notDeepEqual(read.entities, reply.entities);
    } else await assert.rejects(lease.transport.readExact(reply.chatId, kind === "id" ? sent.messageId + 1 : sent.messageId, task.signal));
    await lease.close(); assert.equal(sends(f).length, 1); await adapter.closeCapabilities(); f.references.close();
  }
});

test("uncertain actual send consumes fixed encrypted task slot across fresh adapter/store even with changed answer", async t => {
  const parent = await privateDirectory(t), directory = join(parent, "task-final"), f = fixture();
  const adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
  const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal });
  f.override(async r => { const value = await f.respond(r); if (r instanceof Api.messages.SendMessage) throw Error("synthetic lost send acknowledgement"); return value; });
  assert.deepEqual(await dispatch(f, lease.transport, directory), { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: "task-send-rpc" }); await lease.close();
  assert.equal(sends(f).length, 1); assert.equal(f.values.filter(v => v.out).length, 1);
  const before = await readFile(join(directory, "terminal.enc")); await adapter.closeCapabilities(); f.references.close();
  const restarted = fixture(), nextAdapter = await createStandingConversationAdapter(restarted.options);
  const next = (await ticket(nextAdapter, restarted.control.signal)).openTaskReply({ intent: restarted.intent(), signal: new AbortController().signal });
  assert.deepEqual(await dispatch(restarted, next.transport, directory, "Changed result after restart"), { state: "refused", code: "store-refused" });
  await next.close(); assert.equal(sends(restarted).length, 0); assert.equal(exactReads(restarted).length, 0);
  assert.deepEqual(await readFile(join(directory, "terminal.enc")), before); await nextAdapter.closeCapabilities(); restarted.references.close();
});

test("task send failure stages distinguish preflight, anchor read, anchor validation and acknowledgement parsing without proving no send", async () => {
  for (const diagnostic of ["task-preflight", "task-anchor-read", "task-anchor-validation", "task-ack-parse"] as const) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal });
    if (diagnostic === "task-preflight") await lease.close();
    f.override(async r => {
      if (r instanceof Api.channels.GetMessages && diagnostic === "task-anchor-read") throw Error("PRIVATE anchor RPC failure");
      if (r instanceof Api.channels.GetMessages && diagnostic === "task-anchor-validation") return f.batch([new Api.MessageEmpty({ id: 80 })]);
      const response = await f.respond(r);
      if (r instanceof Api.messages.SendMessage && diagnostic === "task-ack-parse") return {};
      return response;
    });
    const records: string[] = []; let claimed = false;
    const input = { approved: { accountId: "789", chatId: f.options.binding.peerId, replyToMessageId: 80, maximumTextBytes: 4096 },
      reply: { chatId: f.options.binding.peerId, replyToMessageId: 80, text: "PRIVATE report" }, transport: lease.transport,
      store: { async reserve() { if (claimed) throw Error("consumed"); claimed = true; }, async append(record: { state: string }) { records.push(record.state); } },
      killSwitchEngaged: () => false, signal: task.signal };
    assert.deepEqual(await runPilotReply(input), { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: diagnostic });
    assert.deepEqual(records, ["sending", "unknown"]);
    assert.equal(sends(f).length, diagnostic === "task-ack-parse" ? 1 : 0);
    assert.equal(f.values.filter(row => row.out).length, diagnostic === "task-ack-parse" ? 1 : 0);
    assert.deepEqual(await runPilotReply(input), { state: "refused", code: "store-refused" });
    assert.equal(sends(f).length, diagnostic === "task-ack-parse" ? 1 : 0);
    await lease.close(); await adapter.closeCapabilities(); f.references.close();
  }
});

test("outbox persists UNKNOWN on local abort before late send settles while lease still joins actual I/O", async t => {
  const parent = await privateDirectory(t), directory = join(parent, "cancelled-final"), f = fixture();
  const adapter = await createStandingConversationAdapter(f.options), task = new AbortController(), entered = gate(), finish = gate();
  const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal });
  let rpcReturned = false;
  f.override(async r => {
    if (r instanceof Api.messages.SendMessage) {
      entered.done(); await finish.promise; const result = await f.respond(r); rpcReturned = true; return result;
    }
    return f.respond(r);
  });
  const result = runPilotReply({ approved: { accountId: "789", chatId: f.options.binding.peerId, replyToMessageId: 80, maximumTextBytes: 4096 },
    reply: { chatId: f.options.binding.peerId, replyToMessageId: 80, text: "Result interrupted during delivery" },
    store: createEncryptedPilotStore(directory, phrase), transport: lease.transport, killSwitchEngaged: () => false, signal: task.signal });
  try {
    await entered.promise; task.abort();
    const received = await result;
    assert.equal(received.state, "unknown"); assert.equal(received.code, "send-or-readback-unknown"); assert.equal(received.deliveryDiagnostic, "send");
    assert.equal(rpcReturned, false); assert.ok((await readFile(join(directory, "terminal.enc"))).length > 0);
    let joined = false; const closing = lease.close().then(() => { joined = true; }); await tick(); assert.equal(joined, false);
    await assert.rejects(adapter.pollNext(f.control.signal), e => e instanceof StandingAdapterError && e.code === "protocol");
    assert.equal(f.control.signal.aborted, false); assert.equal(sends(f).length, 1);
    finish.done(); await closing; assert.equal(joined, true); assert.equal(rpcReturned, true);
    assert.equal(exactReads(f).length, 1); // Only the primary read: no readback after uncertain send.
    f.override(undefined); await foreground(f, adapter);
  } finally {
    finish.done(); await result; await lease.close(); await adapter.closeCapabilities(); f.references.close();
  }
});

const missingPolicy = "standalone-if-exact-missing" as const;

test("explicit task policy sends a missing-anchor result standalone and persists actual null wire target", async t => {
  const parent = await privateDirectory(t);
  for (const basic of [false, true]) {
    const f = fixture(basic), adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal, taskReplyPolicy: missingPolicy });
    f.values.length = 0;
    const records: PilotRecord[] = [], store = createEncryptedPilotStore(join(parent, basic ? "missing-basic" : "missing-channel"), phrase);
    const result = await runPilotReply({ approved: { accountId: "789", chatId: f.options.binding.peerId, replyToMessageId: 80, maximumTextBytes: 4096, taskReplyPolicy: missingPolicy },
      reply: { chatId: f.options.binding.peerId, replyToMessageId: 80, text: "History result" }, transport: lease.transport,
      store: { reserve: r => store.reserve(r), async append(r) { records.push(r); await store.append(r); } }, killSwitchEngaged: () => false, signal: task.signal });
    assert.deepEqual(result, { state: "verified", code: "verified" });
    assert.equal(sends(f).length, 1); assert.equal(sends(f)[0]!.replyTo, undefined);
    assert.equal(records.at(-1)!.replyToMessageId, 80); assert.equal(records.at(-1)!.wireReplyToMessageId, null);
    assert.equal(records.at(-1)!.state, "verified"); assert.equal(exactReads(f).length, 2);
    await lease.close(); await adapter.closeCapabilities(); f.references.close();
  }
});

test("missing-anchor policy readback reports actual null or exact prior anchor, never fabricates the origin", async () => {
  for (const priorAnchor of [false, true]) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal, taskReplyPolicy: missingPolicy });
    f.values.length = 0;
    f.override(async r => {
      if (r instanceof Api.channels.GetMessages && (r.id[0] as Api.InputMessageID).id === 80)
        return f.batch([new Api.MessageEmpty({ id: 80, peerId: peer(false) })]);
      const response = await f.respond(r);
      if (priorAnchor && r instanceof Api.messages.SendMessage) f.values.at(-1)!.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 80 });
      return response;
    });
    const sent = await lease.transport.sendOnce(f.reply(), task.signal);
    const observed = await lease.transport.readExact(f.reply().chatId, sent.messageId, task.signal);
    assert.equal(observed!.replyToMessageId, priorAnchor ? 80 : null);
    if (priorAnchor) assert.equal(Object.hasOwn(observed!, "taskReplyOriginMessageId"), false);
    else assert.equal(observed!.taskReplyOriginMessageId, 80);
    assert.equal(sends(f)[0]!.replyTo, undefined); assert.equal(sends(f)[0]!.randomId!.toString(), f.reply().randomId);
    await lease.close(); await adapter.closeCapabilities(); f.references.close();
  }
});

test("explicit missing-anchor policy cannot bypass malformed empty responses or existing anchor protections", async () => {
  for (const kind of ["wrong-empty-id", "foreign-empty-peer", "empty-batch", "multiple", "foreign", "requester", "own", "post", "media"] as const) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal, taskReplyPolicy: missingPolicy });
    if (kind === "foreign") f.values[0]!.peerId = new Api.PeerChannel({ channelId: bigInt(999) });
    if (kind === "requester") f.values[0]!.fromId = new Api.PeerUser({ userId: bigInt(999) });
    if (kind === "own") f.values[0]!.out = true;
    if (kind === "post") f.values[0]!.post = true;
    if (kind === "media") f.values[0]!.media = new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(1) }) });
    f.override(async r => {
      if (r instanceof Api.channels.GetMessages) {
        if (kind === "wrong-empty-id") return f.batch([new Api.MessageEmpty({ id: 81 })]);
        if (kind === "foreign-empty-peer") return f.batch([new Api.MessageEmpty({ id: 80, peerId: new Api.PeerChannel({ channelId: bigInt(999) }) })]);
        if (kind === "empty-batch") return f.batch([]);
        if (kind === "multiple") return f.batch([new Api.MessageEmpty({ id: 80 }), new Api.MessageEmpty({ id: 81 })]);
      }
      return f.respond(r);
    });
    await assert.rejects(lease.transport.sendOnce(f.reply(), task.signal)); assert.equal(sends(f).length, 0);
    await lease.close(); await adapter.closeCapabilities(); f.references.close();
  }
});

test("standalone readback refuses unrelated or scheduled reply headers and needs an exact missing proof", async () => {
  for (const kind of ["foreign-anchor", "foreign-peer", "scheduled", "no-missing-proof"] as const) {
    const f = fixture(), adapter = await createStandingConversationAdapter(f.options), task = new AbortController();
    const lease = (await ticket(adapter, f.control.signal)).openTaskReply({ intent: f.intent(), signal: task.signal, taskReplyPolicy: missingPolicy });
    if (kind !== "no-missing-proof") f.values.length = 0;
    const sent = await lease.transport.sendOnce(f.reply(), task.signal), row = f.values.find(v => v.id === sent.messageId)!;
    if (kind === "foreign-anchor") row.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 81 });
    if (kind === "foreign-peer") row.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 80, replyToPeerId: new Api.PeerChannel({ channelId: bigInt(999) }) });
    if (kind === "scheduled") row.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 80, replyToScheduled: true });
    if (kind === "no-missing-proof") delete row.replyTo;
    await assert.rejects(lease.transport.readExact(f.reply().chatId, sent.messageId, task.signal)); assert.equal(sends(f).length, 1);
    await lease.close(); await adapter.closeCapabilities(); f.references.close();
  }
});

test("invalid or executable missing-anchor policy does not consume task reply authority", async () => {
  const f = fixture(), adapter = await createStandingConversationAdapter(f.options), idle = await ticket(adapter, f.control.signal); let reads = 0;
  for (const policy of [undefined, null, false, "allow-any-missing"]) assert.throws(() => idle.openTaskReply({ intent: f.intent(), signal: f.control.signal, taskReplyPolicy: policy } as never));
  await assert.rejects(async () => idle.openTaskReply({ intent: f.intent(), signal: f.control.signal, get taskReplyPolicy() { reads++; return missingPolicy; } }));
  assert.equal(reads, 0); const lease = idle.openTaskReply({ intent: f.intent(), signal: f.control.signal }); await lease.close();
  await adapter.closeCapabilities(); f.references.close();
});
