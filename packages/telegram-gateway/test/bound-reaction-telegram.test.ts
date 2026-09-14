import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import { BoundReactionTelegramError, createBoundReactionTelegramTransport } from "../src/bound-reaction-telegram.js";

const binding = { accountId: "123", peerId: "-456" };
const selected = { chatId: binding.peerId, ownerId: "321", messageId: 10, text: "ПРОМПТ реакция" };
const peer = () => new Api.InputPeerChat({ chatId: bigInt(456) });
const availability = (reactions: Api.TypeReaction[] = [new Api.ReactionEmoji({ emoticon: "👍" }), new Api.ReactionEmoji({ emoticon: "❤️" })]) =>
  new Api.ChatReactionsSome({ reactions });
const full = (availableReactions: Api.TypeChatReactions | undefined = availability()) => new Api.messages.ChatFull({
  fullChat: new Api.ChatFull({ id: bigInt(456), about: "group", participants: new Api.ChatParticipants({ chatId: bigInt(456), participants: [], version: 1 }),
    notifySettings: new Api.PeerNotifySettings({}), ...(availableReactions === undefined ? {} : { availableReactions }) }),
  chats: [new Api.Chat({ id: bigInt(456), title: "Decadans", photo: new Api.ChatPhotoEmpty(), participantsCount: 2, date: 1, version: 1 })], users: [],
});
const reactionState = (items: readonly [string, number, number | null][] = []) => new Api.MessageReactions({ results: items.map(([emoticon, count, chosenOrder]) =>
  new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon }), count, ...(chosenOrder === null ? {} : { chosenOrder }) })) });
const message = (items: readonly [string, number, number | null][] = []) => new Api.Message({ id: 77, peerId: new Api.PeerChat({ chatId: bigInt(456) }),
  fromId: new Api.PeerUser({ userId: bigInt(321) }), date: 1, message: "hello", ...(items.length ? { reactions: reactionState(items) } : {}) });
const messages = (value: Api.TypeMessage = message()) => new Api.messages.Messages({ messages: [value], chats: [], users: [] });
const ack = (items: readonly [string, number, number | null][] = []) => new Api.Updates({ updates: [new Api.UpdateMessageReactions({
  peer: new Api.PeerChat({ chatId: bigInt(456) }), msgId: 77, reactions: reactionState(items) })], chats: [], users: [], date: 1, seq: 1 });
function wire<T extends { getBytes(): Buffer }>(value: T): T {
  const bytes = value.getBytes(), reader = new BinaryReader(bytes), decoded = reader.tgReadObject();
  assert.equal(decoded.constructor, value.constructor); assert.equal(reader.tellPosition(), bytes.length); return decoded as T;
}
type Args = Parameters<typeof createBoundReactionTelegramTransport>[0];
function harness(responses: unknown[], overrides: Partial<Args> = {}) {
  const requests: Api.AnyRequest[] = [], stop = new AbortController(); let active = true;
  const args: Args = { client: { async invoke(request) { requests.push(wire(request)); const value = responses.shift();
      if (value instanceof Error) throw value; if (value === undefined) throw new Error("UNEXPECTED private response"); return value; } },
    binding, peer: peer(), self: new Api.User({ id: bigInt(123), self: true }), selected, targetMessageId: 77, signal: stop.signal,
    isSelectionActive: () => active, revalidatePrimary: async () => ({ ...selected }), ...overrides };
  return { transport: createBoundReactionTelegramTransport(args), requests, stop, revoke: () => { active = false; }, args };
}
const refused = (code?: BoundReactionTelegramError["code"], unknown?: boolean) => (error: unknown) => error instanceof BoundReactionTelegramError &&
  (code === undefined || error.code === code) && (unknown === undefined || error.unknown === unknown) && !error.message.includes("private");

test("inspect returns only own ordinary choices and aggregate counts, never feedback authors", async () => {
  const f = harness([full(), messages(message([["👍", 4, 0], ["❤️", 2, null]]))]);
  const result = await f.transport.inspect();
  assert.deepEqual(result, { targetMessageId: 77, ownEmojis: ["👍"], ownStateComplete: true, unsupportedOwnReaction: false,
    counts: [{ emoji: "👍", count: 4, chosen: true, externalCount: 3 }, { emoji: "❤️", count: 2, chosen: false, externalCount: 2 }], aggregateComplete: true,
    availability: { mode: "some", emoji: ["👍", "❤️"] }, sendAs: "self" });
  assert.equal("authors" in result, false); assert.equal("recentReactions" in result, false);
  assert.ok(f.requests[0] instanceof Api.messages.GetFullChat); assert.ok(f.requests[1] instanceof Api.messages.GetMessages);
  assert.deepEqual((f.requests[1] as Api.messages.GetMessages).id.map(x => (x as Api.InputMessageID).id), [77]);
});

test("set uses one exact ordinary reaction call and independent fresh readback", async () => {
  const f = harness([full(), messages(), ack([["👍", 1, 0]]), full(), messages(message([["👍", 1, 0]]))]);
  const result = await f.transport.setOnce("👍");
  assert.equal(result.state, "set"); assert.deepEqual(result.after.ownEmojis, ["👍"]);
  const sends = f.requests.filter(x => x instanceof Api.messages.SendReaction) as Api.messages.SendReaction[];
  assert.equal(sends.length, 1); assert.equal(sends[0]!.msgId, 77); assert.equal(sends[0]!.big, false); assert.equal(sends[0]!.addToRecent, false);
  assert.equal(sends[0]!.reaction?.length, 1); assert.equal((sends[0]!.reaction![0] as Api.ReactionEmoji).emoticon, "👍");
  assert.equal(f.requests.filter(x => x instanceof Api.messages.GetMessages).length, 2);
  await assert.rejects(f.transport.setOnce("❤️"), refused("state", false)); assert.equal(sends.length, 1);
});

test("replace and clear expose fixed outcomes; clear sends the empty vector", async () => {
  const replace = harness([full(), messages(message([["❤️", 8, 0]])), ack([["👍", 3, 0], ["❤️", 7, null]]), full(), messages(message([["👍", 3, 0], ["❤️", 7, null]]))]);
  assert.equal((await replace.transport.setOnce("👍")).state, "replaced");
  const remove = harness([full(), messages(message([["❤️", 8, 0]])), ack([["❤️", 7, null]]), full(), messages(message([["❤️", 7, null]]))]);
  assert.equal((await remove.transport.setOnce(null)).state, "removed");
  const send = remove.requests.find(x => x instanceof Api.messages.SendReaction) as Api.messages.SendReaction;
  assert.deepEqual(send.reaction, []);
});

test("already selected state is unchanged and consumes without mutation", async () => {
  const f = harness([full(), messages(message([["👍", 2, 0]]))]);
  const result = await f.transport.setOnce("👍"); assert.equal(result.state, "unchanged"); assert.strictEqual(result.before, result.after);
  assert.equal(f.requests.some(x => x instanceof Api.messages.SendReaction), false);
  await assert.rejects(f.transport.setOnce("👍"), refused("state", false));
});

test("group availability is enforced and unsupported own reactions are not silently removed", async () => {
  const unavailable = harness([full(), messages()]);
  await assert.rejects(unavailable.transport.setOnce("🔥"), refused("permission", false)); assert.equal(unavailable.requests.length, 2);
  const custom = new Api.MessageReactions({ results: [new Api.ReactionCount({ reaction: new Api.ReactionCustomEmoji({ documentId: bigInt(9) }), count: 1, chosenOrder: 0 })] });
  const ownCustom = harness([full(), messages(new Api.Message({ id: 77, peerId: new Api.PeerChat({ chatId: bigInt(456) }), date: 1, message: "x", reactions: custom }))]);
  await assert.rejects(ownCustom.transport.setOnce(null), refused("state", false)); assert.equal(ownCustom.requests.length, 2);
});

test("minimum reaction projections cannot authorize mutation and omitted custom counts mark coverage incomplete", async () => {
  const minimum = new Api.MessageReactions({ min: true, results: [new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: "👍" }), count: 2 })] });
  const minMessage = new Api.Message({ id: 77, peerId: new Api.PeerChat({ chatId: bigInt(456) }), date: 1, message: "x", reactions: minimum });
  const min = harness([full(), messages(minMessage)]); const snapshot = await min.transport.inspect();
  assert.equal(snapshot.ownStateComplete, false); assert.equal(snapshot.aggregateComplete, false);
  assert.deepEqual(snapshot.counts, [{ emoji: "👍", count: 2, chosen: null, externalCount: null }]);
  const minMutation = harness([full(), messages(minMessage)]);
  await assert.rejects(minMutation.transport.setOnce("👍"), refused("state", false));
  assert.equal(minMutation.requests.some(x => x instanceof Api.messages.SendReaction), false);

  const mixed = new Api.MessageReactions({ results: [
    new Api.ReactionCount({ reaction: new Api.ReactionEmoji({ emoticon: "👍" }), count: 2 }),
    new Api.ReactionCount({ reaction: new Api.ReactionCustomEmoji({ documentId: bigInt(9) }), count: 4 }),
  ] });
  const mixedMessage = new Api.Message({ id: 77, peerId: new Api.PeerChat({ chatId: bigInt(456) }), date: 1, message: "x", reactions: mixed });
  const mixedResult = await harness([full(), messages(mixedMessage)]).transport.inspect();
  assert.equal(mixedResult.aggregateComplete, false);
  assert.deepEqual(mixedResult.counts, [{ emoji: "👍", count: 2, chosen: false, externalCount: 2 }]);
});

test("all mode is narrowed to active non-premium installed ordinary reactions", async () => {
  const document = new Api.DocumentEmpty({ id: bigInt(1) });
  const catalog = new Api.messages.AvailableReactions({ hash: 1, reactions: [
    new Api.AvailableReaction({ reaction: "👍", title: "thumb", staticIcon: document, appearAnimation: document, selectAnimation: document, activateAnimation: document, effectAnimation: document }),
    new Api.AvailableReaction({ inactive: true, reaction: "❤️", title: "heart", staticIcon: document, appearAnimation: document, selectAnimation: document, activateAnimation: document, effectAnimation: document }),
    new Api.AvailableReaction({ premium: true, reaction: "🔥", title: "fire", staticIcon: document, appearAnimation: document, selectAnimation: document, activateAnimation: document, effectAnimation: document }),
  ] });
  const f = harness([full(new Api.ChatReactionsAll({})), catalog, messages()]);
  assert.deepEqual((await f.transport.inspect()).availability, { mode: "all", emoji: ["👍"] });
  assert.ok(f.requests[1] instanceof Api.messages.GetAvailableReactions); assert.equal((f.requests[1] as Api.messages.GetAvailableReactions).hash, 0);
});

test("effective channel send-as must be self and is never changed", async () => {
  const channelBinding = { accountId: "123", peerId: "-100456" }, channelSelected = { ...selected, chatId: "-100456" };
  const channelPeer = new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(987) });
  const envelope = new Api.messages.ChatFull({ fullChat: new Api.ChannelFull({ id: bigInt(456), about: "", readInboxMaxId: 0, readOutboxMaxId: 0,
    unreadCount: 0, chatPhoto: new Api.PhotoEmpty({ id: bigInt(1) }), notifySettings: new Api.PeerNotifySettings({}), botInfo: [], pts: 1,
    defaultSendAs: new Api.PeerChannel({ channelId: bigInt(456) }), availableReactions: availability() }),
    chats: [new Api.Channel({ id: bigInt(456), accessHash: bigInt(987), title: "Decadans", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })], users: [] });
  const f = harness([envelope], { binding: channelBinding, selected: channelSelected, peer: channelPeer, revalidatePrimary: async () => channelSelected });
  await assert.rejects(f.transport.inspect(), refused("permission", false));
  const request = f.requests[0] as Api.channels.GetFullChannel;
  assert.ok(request instanceof Api.channels.GetFullChannel); assert.ok(request.channel instanceof Api.InputChannel);
  assert.equal(request.channel.channelId.toString(), "456"); assert.equal(request.channel.accessHash.toString(), "987");
  assert.equal(f.requests.some(x => x instanceof Api.messages.SaveDefaultSendAs), false);

  const allowedEnvelope = new Api.messages.ChatFull({ fullChat: new Api.ChannelFull({ id: bigInt(456), about: "", readInboxMaxId: 0, readOutboxMaxId: 0,
    unreadCount: 0, chatPhoto: new Api.PhotoEmpty({ id: bigInt(1) }), notifySettings: new Api.PeerNotifySettings({}), botInfo: [], pts: 1,
    defaultSendAs: new Api.PeerUser({ userId: bigInt(123) }), availableReactions: availability() }),
    chats: [new Api.Channel({ id: bigInt(456), accessHash: bigInt(987), title: "Decadans", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })], users: [] });
  const channelMessage = new Api.Message({ id: 77, peerId: new Api.PeerChannel({ channelId: bigInt(456) }), date: 1, message: "x" });
  const allowed = harness([allowedEnvelope, messages(channelMessage)], { binding: channelBinding, selected: channelSelected, peer: channelPeer,
    revalidatePrimary: async () => channelSelected });
  assert.equal((await allowed.transport.inspect()).sendAs, "self");
  const get = allowed.requests[1] as Api.channels.GetMessages;
  assert.ok(get instanceof Api.channels.GetMessages); assert.ok(get.channel instanceof Api.InputChannel);
});

test("mutation error or mismatched ACK is unknown and never retried", async () => {
  for (const response of [new Error("private network detail"), new Api.Updates({ updates: [], chats: [], users: [], date: 1, seq: 1 }),
    ack([["❤️", 1, 0]])]) {
    const f = harness([full(), messages(), response]);
    await assert.rejects(f.transport.setOnce("👍"), refused(undefined, true));
    await assert.rejects(f.transport.setOnce("👍"), refused("state", true));
    assert.equal(f.requests.filter(x => x instanceof Api.messages.SendReaction).length, 1);
  }
});

test("constructor and target read refuse foreign state before mutation", async () => {
  assert.throws(() => harness([], { targetMessageId: 0 }), refused("config", false));
  assert.throws(() => harness([], { peer: new Api.InputPeerChat({ chatId: bigInt(457) }) }), refused("config", false));
  const foreign = harness([full(), messages(new Api.Message({ id: 77, peerId: new Api.PeerChat({ chatId: bigInt(457) }), date: 1, message: "x" }))]);
  await assert.rejects(foreign.transport.inspect(), refused("target", false));
});

test("close and abort revoke publication and close joins actual pending invoke", async () => {
  let resolve!: (value: unknown) => void, calls = 0;
  const gate = new Promise<unknown>(r => { resolve = r; });
  const f = harness([], { client: { invoke: async () => { calls++; return gate; } } });
  let ended = false; const operation = f.transport.inspect().finally(() => { ended = true; });
  await new Promise(r => setImmediate(r)); assert.equal(calls, 1);
  const close = f.transport.close(); await new Promise(r => setImmediate(r)); assert.equal(ended, false);
  resolve(full()); await assert.rejects(operation, refused("aborted", false)); await close; assert.equal(ended, true); assert.equal(calls, 1);
  const aborted = harness([]); aborted.stop.abort(); await assert.rejects(aborted.transport.inspect(), refused("aborted", false));
});
