import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import { createScheduledTextTelegramTransport, ScheduledTextError, type OwnedScheduledText } from "../src/scheduled-text-telegram.js";
const binding = { accountId: "123", peerId: "-100456" };
const selected = { chatId: binding.peerId, ownerId: "321", messageId: 10, text: "ПРОМПТ напомни" };
const operation = { operationId: "fixture-1", randomId: "9223372036854775806", text: "Invented reminder", scheduleDate: 2000 };
const peer = () => new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(987) });
const message = (patch: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}) => new Api.Message({
  id: 77, out: true, peerId: new Api.PeerChannel({ channelId: bigInt(456) }), fromId: new Api.PeerUser({ userId: bigInt(123) }),
  date: operation.scheduleDate, message: operation.text, replyTo: new Api.MessageReplyHeader({ replyToMsgId: selected.messageId }), ...patch,
});
const updates = (list: Api.TypeUpdate[]) => new Api.Updates({ updates: list, chats: [], users: [], date: 1000, seq: 1 });
const ack = (m = message()) => updates([new Api.UpdateMessageID({ id: m.id, randomId: bigInt(operation.randomId) }), new Api.UpdateNewScheduledMessage({ message: m })]);
const queue = (messages: Api.TypeMessage[] = [message()]) => new Api.messages.Messages({ messages, chats: [], users: [] });
const deleted = (patch: Partial<ConstructorParameters<typeof Api.UpdateDeleteScheduledMessages>[0]> = {}) => updates([
  new Api.UpdateDeleteScheduledMessages({ peer: new Api.PeerChannel({ channelId: bigInt(456) }), messages: [77], ...patch }),
]);
function wire<T extends { getBytes(): Buffer }>(value: T): T {
  const bytes = value.getBytes(), reader = new BinaryReader(bytes), decoded = reader.tgReadObject();
  assert.equal(decoded.constructor, value.constructor); assert.equal(reader.tellPosition(), bytes.length);
  return decoded as T;
}
type Args = Parameters<typeof createScheduledTextTelegramTransport>[0];
function harness(responses: unknown[], overrides: Partial<Args> = {}) {
  const requests: Api.AnyRequest[] = [], stop = new AbortController(); let active = true;
  const args: Args = { binding, peer: peer(), self: new Api.User({ id: bigInt(123), self: true }), selected, signal: stop.signal,
    operation, clock: () => 1000_000, isSelectionActive: () => active, revalidatePrimary: async () => ({ ...selected }),
    client: { async invoke(request) {
      requests.push(wire(request)); if (!responses.length) throw new Error("UNEXPECTED private text");
      const value = responses.shift(); if (value instanceof Error) throw value;
      return value && typeof value === "object" && "getBytes" in value ? wire(value as Api.Updates) : value;
    } }, ...overrides };
  return { transport: createScheduledTextTelegramTransport(args), requests, stop, revoke: () => { active = false; }, args };
}
function saved(patch: Partial<OwnedScheduledText> = {}): OwnedScheduledText {
  return { schema: "owned-scheduled-text-v1", ...operation, chatId: binding.peerId, accountId: binding.accountId,
    replyToMessageId: selected.messageId, scheduledMessageId: 77, ...patch };
}
const refused = (unknown?: boolean) => (e: unknown) => e instanceof ScheduledTextError && (unknown === undefined || e.unknown === unknown) && !e.message.includes("private");

test("binary ACK + fresh scheduled read proves queue only and exact self/reply/date/randomId wire", async () => {
  const f = harness([ack(), queue()]); const result = await f.transport.scheduleOnce();
  assert.equal(result.state, "queued"); assert.equal(result.delivery, "unobserved"); assert.deepEqual(result.record, saved());
  assert.equal("messageId" in result.record, false); assert.equal("actualMessageId" in result.record, false);
  const send = f.requests[0] as Api.messages.SendMessage;
  assert.ok(send instanceof Api.messages.SendMessage); assert.ok(send.sendAs instanceof Api.InputPeerSelf);
  assert.ok(send.peer instanceof Api.InputPeerChannel); assert.equal(send.peer.channelId.toString(), "456");
  assert.equal(send.scheduleDate, 2000); assert.equal(send.randomId?.toString(), operation.randomId);
  assert.ok(send.replyTo instanceof Api.InputReplyToMessage); assert.equal(send.replyTo.replyToMsgId, 10);
  assert.ok(f.requests[1] instanceof Api.messages.GetScheduledMessages); assert.deepEqual(f.requests[1].id, [77]);
  assert.equal(wire(message()).media, null); assert.equal(wire(message()).ttlPeriod, null);
  await assert.rejects(f.transport.scheduleOnce(), refused()); assert.equal(f.requests.length, 2);
});

test("real binary mapping-free scheduled update and empty-media are admitted", async () => {
  const m = message({ media: new Api.MessageMediaEmpty() });
  const f = harness([updates([new Api.UpdateNewScheduledMessage({ message: m })]), queue([m])]);
  assert.equal((await f.transport.scheduleOnce()).state, "queued");
});

test("scheduled ID never goes to ordinary messages.GetMessages; inspection absent does not assert delivered", async () => {
  for (const absent of [queue([]), queue([new Api.MessageEmpty({ id: 77 })])]) {
    const f = harness([absent], { ownedRecord: saved() });
    assert.equal((await f.transport.inspect()).state, "absent"); assert.equal(f.requests.length, 1);
    assert.ok(f.requests[0] instanceof Api.messages.GetScheduledMessages);
  }
});

test("cancellation reads exact queue then delete then absent; null optional sentMessages is accepted", async () => {
  const f = harness([queue(), deleted(), queue([])], { ownedRecord: saved() });
  const result = await f.transport.cancelOnce();
  assert.equal(result.state, "removed-from-queue"); assert.equal(result.delivery, "unobserved");
  assert.ok(f.requests[1] instanceof Api.messages.DeleteScheduledMessages); assert.deepEqual(f.requests[1].id, [77]);
  assert.equal(wire(deleted()).updates[0] instanceof Api.UpdateDeleteScheduledMessages, true);
  await assert.rejects(f.transport.cancelOnce(), refused()); assert.equal(f.requests.length, 3);
});

test("already absent owned record sends no cancellation and is never marked delivered", async () => {
  const f = harness([queue([])], { ownedRecord: saved() });
  assert.equal((await f.transport.cancelOnce()).state, "already-absent"); assert.equal(f.requests.length, 1);
});

test("final invocation requires sixty seconds after awaited primary validation", async () => {
  for (const seconds of [59, -1]) {
    let now = 1000_000;
    const f = harness([], { clock: () => now, revalidatePrimary: async () => { now = (2000 - seconds) * 1000; return selected; } });
    await assert.rejects(f.transport.scheduleOnce(), e => e instanceof ScheduledTextError && e.code === "date" && !e.unknown);
    assert.equal(f.requests.length, 0);
  }
  const f = harness([ack(), queue()], { clock: () => 1940_000 }); assert.equal((await f.transport.scheduleOnce()).state, "queued");
});

test("constructor refuses foreign account/peer/record, bad date/randomId and private selector extras", () => {
  for (const patch of [{ scheduleDate: 0 }, { scheduleDate: 2147483647 }, { scheduleDate: 1.5 }, { randomId: "0" },
    { randomId: "9223372036854775808" }, { text: "x".repeat(4097) }, { text: "bad\ud800" }, { text: "" }]) {
    assert.throws(() => harness([], { operation: { ...operation, ...patch } }), refused(false));
  }
  assert.throws(() => harness([], { peer: new Api.InputPeerChat({ chatId: bigInt(456) }) }), refused(false));
  assert.throws(() => harness([], { self: new Api.User({ id: bigInt(124), self: true }) }), refused(false));
  for (const patch of [{ chatId: "-100457" }, { accountId: "124" }, { text: "other" }, { replyToMessageId: 11 }, { scheduleDate: 2001 }]) {
    assert.throws(() => harness([], { ownedRecord: saved(patch) }), refused(false));
  }
  assert.throws(() => harness([], { operation: { ...operation, peer: "other" } as typeof operation }), refused(false));
});

test("binary queue proof rejects edited text/date/author/peer/anchor and ordinary immediate ACK", async () => {
  const invalid = [message({ message: "changed" }), message({ date: 2001 }), message({ out: false }),
    message({ fromId: new Api.PeerUser({ userId: bigInt(999) }) }), message({ peerId: new Api.PeerChannel({ channelId: bigInt(457) }) }),
    message({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 11 }) }),
    message({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 10, replyToScheduled: true }) }),
    message({ ttlPeriod: 0 }), message({ fromScheduled: true }), message({ fwdFrom: new Api.MessageFwdHeader({ date: 1 }) }),
    message({ media: new Api.MessageMediaPhoto({}) })];
  for (const value of invalid) {
    const f = harness([ack(), queue([value])]); await assert.rejects(f.transport.scheduleOnce(), refused(true));
    assert.deepEqual(f.transport.ownedRecord(), saved());
  }
  for (const bad of [new Api.UpdateShortSentMessage({ id: 77, out: true, pts: 1, ptsCount: 1, date: 1000 }),
    updates([new Api.UpdateNewMessage({ message: message(), pts: 1, ptsCount: 1 })]),
    updates([new Api.UpdateNewScheduledMessage({ message: message() }), new Api.UpdateNewScheduledMessage({ message: message() })]),
    updates([new Api.UpdateMessageID({ id: 77, randomId: bigInt(4) }), new Api.UpdateNewScheduledMessage({ message: message() })])]) {
    const f = harness([bad]); await assert.rejects(f.transport.scheduleOnce(), refused(true)); assert.equal(f.requests.length, 1);
  }
});

test("cancellation race or mismatched ACK remains unknown, never blindly repeats", async () => {
  for (const response of [deleted({ sentMessages: [88] }), deleted({ messages: [78] }),
    deleted({ peer: new Api.PeerChannel({ channelId: bigInt(457) }) }), updates([])]) {
    const f = harness([queue(), response], { ownedRecord: saved() });
    await assert.rejects(f.transport.cancelOnce(), refused(true)); await assert.rejects(f.transport.cancelOnce(), refused(true));
    assert.equal(f.requests.length, 2);
  }
  const f = harness([queue(), deleted(), queue()], { ownedRecord: saved() });
  await assert.rejects(f.transport.cancelOnce(), refused(true)); assert.equal(f.requests.length, 3);
});

test("reopened record cannot schedule; close/STOP/revoked selection prevent new calls", async () => {
  const f = harness([], { ownedRecord: saved() }); await assert.rejects(f.transport.scheduleOnce(), refused());
  for (const stop of [(f: ReturnType<typeof harness>) => f.stop.abort(), (f: ReturnType<typeof harness>) => f.revoke(),
    (f: ReturnType<typeof harness>) => f.transport.close()]) {
    const q = harness([]); stop(q); await assert.rejects(q.transport.scheduleOnce(), refused(false)); assert.equal(q.requests.length, 0);
  }
  const changed = harness([], { revalidatePrimary: async () => ({ ...selected, text: "edited" }) });
  await assert.rejects(changed.transport.scheduleOnce(), refused(false)); assert.equal(changed.requests.length, 0);
});

test("possibly sent failure does not retry; close while invocation pending still joins real promise", async () => {
  let resolve!: (v: unknown) => void, calls = 0;
  const gate = new Promise<unknown>(r => { resolve = r; });
  const f = harness([], { client: { invoke: async () => { calls++; return gate; } } });
  let ended = false; const p = f.transport.scheduleOnce().finally(() => { ended = true; });
  await new Promise(r => setImmediate(r)); assert.equal(calls, 1);
  f.transport.close(); await new Promise(r => setImmediate(r)); assert.equal(ended, false);
  resolve(wire(ack())); await assert.rejects(p, refused(true)); assert.equal(ended, true);
  await assert.rejects(f.transport.scheduleOnce(), refused(true)); assert.equal(calls, 1);
  const q = harness([new Error("private server error")]); await assert.rejects(q.transport.scheduleOnce(), refused(true));
});

test("captured peer/operation/callable ports cannot be retargeted after construction", async () => {
  const p = peer(), op = { ...operation }; const f = harness([ack(), queue()], { peer: p, operation: op });
  p.channelId = bigInt(999); op.text = "changed"; f.args.client.invoke = async () => { throw new Error("redirected"); };
  f.args.revalidatePrimary = async () => ({ ...selected, text: "changed" });
  assert.equal((await f.transport.scheduleOnce()).state, "queued");
});
