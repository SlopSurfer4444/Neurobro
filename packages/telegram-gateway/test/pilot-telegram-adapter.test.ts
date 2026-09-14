import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils, type TelegramClient } from "telegram";
import bigInt from "big-integer";
import { createPilotTelegramAdapter, extractPilotSentId, parsePilotPrimary, resolvePilotPeer, type PilotInvoker } from "../src/pilot-telegram-adapter.js";

const self = () => new Api.User({ id: bigInt(789), self: true });
const ownerId = "456";
const channelPeer = () => new Api.PeerChannel({ channelId: bigInt(123) });
const groupPeer = () => new Api.PeerChat({ chatId: bigInt(123) });
const channelId = utils.getPeerId(channelPeer());
const groupId = utils.getPeerId(groupPeer());
const binding = (group = false) => ({ accountId: "789", peerId: group ? groupId : channelId });
const channel = () => new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Invented group", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true });
const group = () => new Api.Chat({ id: bigInt(123), title: "Invented group", photo: new Api.ChatPhotoEmpty(), date: 1, participantsCount: 2, version: 1 });
const dialog = (isGroup = false) => new Api.Dialog({ peer: isGroup ? groupPeer() : channelPeer(), topMessage: 55, readInboxMaxId: 0,
  readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) });
function message(id = 55, author = ownerId, text = "ПРОМПТ Invented request", isGroup = false): Api.Message {
  return new Api.Message({ id, peerId: isGroup ? groupPeer() : channelPeer(), fromId: new Api.PeerUser({ userId: bigInt(author) }), date: 1, message: text,
    ...(author === "789" ? { out: true, replyTo: new Api.MessageReplyHeader({ replyToMsgId: 55 }) } : {}) });
}
const dialogs = (isGroup = false) => new Api.messages.Dialogs({ dialogs: [dialog(isGroup)], chats: [isGroup ? group() : channel()], users: [], messages: [message()] });
const messages = (value = message()) => new Api.messages.Messages({ messages: [value], chats: [], users: [] });
const shortAck = () => new Api.UpdateShortSentMessage({ id: 66, out: true, pts: 1, ptsCount: 1, date: 1 });
const updatesAck = (updates: Api.TypeUpdate[]) => new Api.Updates({ updates, chats: [], users: [], date: 1, seq: 1 });
const mapping = (id = 66, randomId = "112233") => new Api.UpdateMessageID({ id, randomId: bigInt(randomId) });
const echo = (value = message(66, "789", "Invented reply")) => new Api.UpdateNewChannelMessage({ message: value, pts: 1, ptsCount: 1 });
const controller = () => new AbortController();
// Compile-time check: no wrapper or second TelegramClient is needed.
const existingClientCompatible = (client: TelegramClient): PilotInvoker => client;
void existingClientCompatible;

function wire(responses: unknown[]) {
  const requests: Api.AnyRequest[] = [];
  const client: PilotInvoker = { async invoke(request) {
    requests.push(request);
    assert.ok(request.getBytes().length > 0); // Exercise real installed TL serialization without a network.
    if (!responses.length) throw new Error("unexpected extra protocol call");
    const response = responses.shift(); if (response instanceof Error) throw response; return response;
  } };
  return { client, requests };
}

test("exact saved peer resolves channel access hash or normal group independently of title", () => {
  for (const isGroup of [false, true]) {
    const envelope = dialogs(isGroup); (envelope.chats[0] as Api.Chat | Api.Channel).title = "Renamed invented group";
    const peer = resolvePilotPeer(binding(isGroup), self(), envelope);
    if (isGroup) assert.ok(peer instanceof Api.InputPeerChat);
    else { assert.ok(peer instanceof Api.InputPeerChannel); assert.equal(peer.accessHash.toString(), "987"); }
  }
});

test("wrong self, absent/duplicate dialog, duplicate entity and non-dialog entity are refused", () => {
  assert.throws(() => resolvePilotPeer(binding(), new Api.User({ id: bigInt(790), self: true }), dialogs()));
  for (const change of [
    (e: Api.messages.Dialogs) => { e.dialogs.length = 0; },
    (e: Api.messages.Dialogs) => { e.dialogs.push(dialog()); },
    (e: Api.messages.Dialogs) => { e.chats.push(channel()); },
    (e: Api.messages.Dialogs) => { e.dialogs[0] = dialog(true); },
    (e: Api.messages.Dialogs) => { while (e.dialogs.length <= 100) e.dialogs.push(dialog()); },
  ]) { const e = dialogs(); change(e); assert.throws(() => resolvePilotPeer(binding(), self(), e)); }
});

test("left, inaccessible, minimal, forbidden or migrated groups cannot become send peers", () => {
  for (const flags of [{ left: true }, { min: true }, { megagroup: false }, { broadcast: true }, { accessHash: bigInt.zero },
    { bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }) },
    { defaultBannedRights: new Api.ChatBannedRights({ untilDate: 0, sendMessages: true }) }]) {
    const e = dialogs(); e.chats[0] = Object.assign(channel(), flags); assert.throws(() => resolvePilotPeer(binding(), self(), e));
  }
  const noHash = dialogs(); delete (noHash.chats[0] as Api.Channel).accessHash; assert.throws(() => resolvePilotPeer(binding(), self(), noHash));
  const forbidden = dialogs(); forbidden.chats[0] = new Api.ChannelForbidden({ id: bigInt(123), accessHash: bigInt(987), title: "Invented" });
  assert.throws(() => resolvePilotPeer(binding(), self(), forbidden));
  const migrated = dialogs(true); (migrated.chats[0] as Api.Chat).migratedTo = new Api.InputChannel({ channelId: bigInt(123), accessHash: bigInt(987) });
  assert.throws(() => resolvePilotPeer(binding(true), self(), migrated));
});

test("one primary message preserves original body and rejects neighbors, author/chat/id changes", () => {
  assert.deepEqual(parsePilotPrimary(messages(), channelId, ownerId, 55), { chatId: channelId, ownerId, messageId: 55, text: "ПРОМПТ Invented request" });
  for (const m of [message(56), message(55, "457"), message(55, ownerId, "ПРОМПТ Invented request", true)]) {
    assert.throws(() => parsePilotPrimary(messages(m), channelId, ownerId, 55));
  }
  const extra = messages(); extra.messages.push(message(56)); assert.throws(() => parsePilotPrimary(extra, channelId, ownerId, 55));
});

test("primary requires explicit uppercase PROMPT, <=4KiB well formed text, no forward or attachment", () => {
  for (const text of ["not a prompt", "ПРОМПТОВЫЙ", "промпт lower", "ПРОМПТ " + "я".repeat(2048), "ПРОМПТ \ud800", "ПРОМПТ \0"]) {
    assert.throws(() => parsePilotPrimary(messages(message(55, ownerId, text)), channelId, ownerId, 55));
  }
  for (const fields of [{ fwdFrom: new Api.MessageFwdHeader({ date: 1 }) }, { media: new Api.MessageMediaPhoto({}) }, { viaBotId: bigInt(8) }, { groupedId: bigInt(8) }]) {
    assert.throws(() => parsePilotPrimary(messages(Object.assign(message(), fields)), channelId, ownerId, 55));
  }
});

test("short ack and correlated randomId update mapping produce only a candidate message ID", () => {
  assert.equal(extractPilotSentId(shortAck(), "112233", channelId), 66);
  assert.equal(extractPilotSentId(updatesAck([mapping(), echo()]), "112233", channelId), 66);
  assert.equal(extractPilotSentId(updatesAck([mapping()]), "112233", channelId), 66);
  const combined = new Api.UpdatesCombined({ updates: [mapping(), echo()], chats: [], users: [], date: 1, seq: 1, seqStart: 1 });
  assert.equal(extractPilotSentId(combined, "112233", channelId), 66);
});

test("uncorrelated, missing, duplicate, invalid or wrong-peer acknowledgements stay unknown", () => {
  for (const list of [[], [mapping(66, "999")], [mapping(), mapping()], [mapping(0)], [mapping(), echo(message(66, "789", "Invented reply", true))], [mapping(), echo(), echo()]]) {
    assert.throws(() => extractPilotSentId(updatesAck(list), "112233", channelId));
  }
  const short = shortAck(); short.out = false; assert.throws(() => extractPilotSentId(short, "112233", channelId));
  assert.throws(() => extractPilotSentId({ id: 66 }, "112233", channelId));
});

test("real TL route is dialogs100 -> exact primary -> plaintext reply -> exact fresh readback", async () => {
  for (const isGroup of [false, true]) {
    const d = dialogs(isGroup); const primary = messages(message(55, ownerId, "ПРОМПТ Invented request", isGroup));
    const ack = updatesAck([mapping(), isGroup ? new Api.UpdateNewMessage({ message: message(66, "789", "Invented reply", true), pts: 1, ptsCount: 1 }) : echo()]);
    const readback = messages(message(66, "789", "Invented reply", isGroup));
    const f = wire([d, primary, ack, readback]); const signal = controller().signal;
    const adapter = await createPilotTelegramAdapter({ client: f.client, binding: binding(isGroup), self: self(), signal });
    assert.equal(d.messages.length, 0); assert.equal(d.users.length, 0); assert.equal(d.chats.length, 0);
    const request = f.requests[0] as Api.messages.GetDialogs; assert.equal(request.limit, 100); assert.equal(request.offsetId, 0);
    await adapter.readExactPrompt(ownerId, 55, signal); assert.equal(primary.messages.length, 0);
    const reply = { chatId: binding(isGroup).peerId, replyToMessageId: 55, text: "Invented reply", randomId: "112233" };
    assert.deepEqual(await adapter.transport.sendOnce(reply, signal), { messageId: 66 });
    const sent = f.requests[2] as Api.messages.SendMessage;
    assert.ok(sent instanceof Api.messages.SendMessage); assert.equal(sent.randomId!.toString(), reply.randomId);
    assert.equal(sent.noWebpage, true); assert.deepEqual(sent.entities, []); assert.equal(sent.clearDraft, false); assert.equal(sent.allowPaidFloodskip, false);
    assert.equal((sent.replyTo as Api.InputReplyToMessage).replyToMsgId, 55); assert.ok(sent.sendAs instanceof Api.InputPeerSelf);
    assert.equal(sent.message, reply.text); assert.equal(ack.updates.length, 0);
    assert.deepEqual(await adapter.transport.readExact(reply.chatId, 66, signal), { messageId: 66, chatId: reply.chatId, accountId: "789", replyToMessageId: 55, text: reply.text });
    assert.equal(readback.messages.length, 0);
    for (const exact of [f.requests[1], f.requests[3]]) {
      assert.ok(isGroup ? exact instanceof Api.messages.GetMessages : exact instanceof Api.channels.GetMessages);
      assert.equal((exact as Api.messages.GetMessages).id.length, 1);
    }
    await assert.rejects(adapter.readExactPrompt(ownerId, 55, signal));
    await assert.rejects(adapter.transport.sendOnce(reply, signal));
    await assert.rejects(adapter.transport.readExact(reply.chatId, 66, signal));
    assert.equal(f.requests.length, 4);
  }
});

test("wrong self and aborted creation make zero requests", async () => {
  const f = wire([]); const abort = controller(); abort.abort();
  await assert.rejects(createPilotTelegramAdapter({ client: f.client, binding: binding(), self: self(), signal: abort.signal }));
  await assert.rejects(createPilotTelegramAdapter({ client: f.client, binding: binding(), self: new Api.User({ id: bigInt(9), self: true }), signal: controller().signal }));
  assert.equal(f.requests.length, 0);
});

test("send is unavailable before the exact primary; wrong target and noncanonical randomId do not call Telegram", async () => {
  const f = wire([dialogs(), messages()]); const signal = controller().signal;
  const a = await createPilotTelegramAdapter({ client: f.client, binding: binding(), self: self(), signal });
  const reply = { chatId: channelId, replyToMessageId: 55, text: "Invented reply", randomId: "112233" };
  await assert.rejects(a.transport.sendOnce(reply, signal));
  await a.readExactPrompt(ownerId, 55, signal);
  for (const change of [{ chatId: groupId }, { replyToMessageId: 56 }, { randomId: "0" }, { randomId: "9223372036854775808" }, { text: "x".repeat(4097) }]) {
    await assert.rejects(a.transport.sendOnce({ ...reply, ...change }, signal));
  }
  assert.equal(f.requests.length, 2);
});

test("concurrent primary/send calls each consume only one protocol slot", async () => {
  const f = wire([dialogs(), messages(), shortAck()]); const signal = controller().signal;
  const a = await createPilotTelegramAdapter({ client: f.client, binding: binding(), self: self(), signal });
  const reads = await Promise.allSettled([a.readExactPrompt(ownerId, 55, signal), a.readExactPrompt(ownerId, 55, signal)]);
  assert.equal(reads.filter(r => r.status === "fulfilled").length, 1);
  const reply = { chatId: channelId, replyToMessageId: 55, text: "Invented reply", randomId: "112233" };
  const sends = await Promise.allSettled([a.transport.sendOnce(reply, signal), a.transport.sendOnce(reply, signal)]);
  assert.equal(sends.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.requests.length, 3);
});

test("lost or malformed send response is terminal and cannot retry or read arbitrary IDs", async () => {
  for (const ack of [new Error("private transport detail"), updatesAck([])]) {
    const f = wire([dialogs(), messages(), ack]); const signal = controller().signal;
    const a = await createPilotTelegramAdapter({ client: f.client, binding: binding(), self: self(), signal });
    await a.readExactPrompt(ownerId, 55, signal);
    const reply = { chatId: channelId, replyToMessageId: 55, text: "Invented reply", randomId: "112233" };
    await assert.rejects(a.transport.sendOnce(reply, signal), /^Error: PILOT_TELEGRAM_REFUSED_OR_UNKNOWN$/);
    await assert.rejects(a.transport.sendOnce(reply, signal)); await assert.rejects(a.transport.readExact(channelId, 66, signal));
    assert.equal(f.requests.length, 3);
  }
});

test("outbound readback rejects wrong author/reply/foreign reply peer and missing message", async () => {
  for (const bad of [message(66, ownerId, "Invented reply"), message(66, "789", "Edited reply"), Object.assign(message(66, "789", "Invented reply"), { replyTo: new Api.MessageReplyHeader({ replyToMsgId: 54 }) }),
    Object.assign(message(66, "789", "Invented reply"), { replyTo: new Api.MessageReplyHeader({ replyToMsgId: 55, replyToPeerId: groupPeer() }) })]) {
    const f = wire([dialogs(), messages(), shortAck(), messages(bad)]); const signal = controller().signal;
    const a = await createPilotTelegramAdapter({ client: f.client, binding: binding(), self: self(), signal });
    await a.readExactPrompt(ownerId, 55, signal);
    await a.transport.sendOnce({ chatId: channelId, replyToMessageId: 55, text: "Invented reply", randomId: "112233" }, signal);
    await assert.rejects(a.transport.readExact(channelId, 66, signal)); await assert.rejects(a.transport.readExact(channelId, 66, signal));
    assert.equal(f.requests.length, 4);
  }
});

test("abort while request is outstanding discards its late body and latches no-retry", async () => {
  let done!: (response: unknown) => void; let entered!: () => void;
  const pendingStarted = new Promise<void>(resolve => { entered = resolve; });
  let count = 0; const client: PilotInvoker = { async invoke() { count++; if (count === 1) return dialogs(); entered(); return new Promise(resolve => { done = resolve; }); } };
  const abort = controller(); const a = await createPilotTelegramAdapter({ client, binding: binding(), self: self(), signal: abort.signal });
  const pending = a.readExactPrompt(ownerId, 55, abort.signal); await pendingStarted; abort.abort(); const body = messages(); done(body);
  await assert.rejects(pending); assert.equal(body.messages.length, 0);
  await assert.rejects(a.readExactPrompt(ownerId, 55, controller().signal)); assert.equal(count, 2);
});

test("explicit greeting mode performs no primary read and omits replyTo on the actual wire request", async () => {
  const returned = message(66, "789", "Invented off-platform greeting"); delete returned.replyTo;
  const f = wire([dialogs(), shortAck(), messages(returned)]); const signal = controller().signal;
  const a = await createPilotTelegramAdapter({ client: f.client, binding: binding(), self: self(), signal, mode: "greeting" });
  await assert.rejects(a.readExactPrompt(ownerId, 55, signal)); assert.equal(f.requests.length, 1);
  const greeting = { chatId: channelId, replyToMessageId: null, text: returned.message, randomId: "112233" };
  await assert.rejects(a.transport.sendOnce({ ...greeting, replyToMessageId: 55 }, signal));
  await assert.rejects(a.transport.sendOnce({ ...greeting, replyToMessageId: 0 }, signal));
  assert.deepEqual(await a.transport.sendOnce(greeting, signal), { messageId: 66 });
  const sent = f.requests[1] as Api.messages.SendMessage;
  assert.equal(sent.replyTo, undefined); assert.equal(sent.noWebpage, true); assert.deepEqual(sent.entities, []);
  assert.ok(sent.sendAs instanceof Api.InputPeerSelf);
  assert.deepEqual(await a.transport.readExact(channelId, 66, signal), { messageId: 66, chatId: channelId, accountId: "789", replyToMessageId: null, text: returned.message });
  assert.deepEqual(f.requests.map(r => r.className), ["messages.GetDialogs", "messages.SendMessage", "channels.GetMessages"]);
  await assert.rejects(a.transport.sendOnce(greeting, signal)); assert.equal(f.requests.length, 3);
});

test("greeting readback refuses unexpected reply headers while prompt mode refuses null anchor", async () => {
  const signal = controller().signal;
  const f = wire([dialogs(), shortAck(), messages(message(66, "789", "Invented greeting"))]);
  const a = await createPilotTelegramAdapter({ client: f.client, binding: binding(), self: self(), signal, mode: "greeting" });
  await a.transport.sendOnce({ chatId: channelId, replyToMessageId: null, text: "Invented greeting", randomId: "112233" }, signal);
  await assert.rejects(a.transport.readExact(channelId, 66, signal)); assert.equal(f.requests.length, 3);
  const g = wire([dialogs(), messages()]);
  const p = await createPilotTelegramAdapter({ client: g.client, binding: binding(), self: self(), signal });
  await p.readExactPrompt(ownerId, 55, signal);
  await assert.rejects(p.transport.sendOnce({ chatId: channelId, replyToMessageId: null, text: "Invented greeting", randomId: "112233" }, signal));
  assert.equal(g.requests.length, 2);
});
