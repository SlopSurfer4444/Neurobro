import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils, type TelegramClient } from "telegram";
import bigInt from "big-integer";
import type { PilotInvoker } from "../src/pilot-telegram-adapter.js";
import { createConversationAdapter } from "../src/pilot-conversation-adapter.js";
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


function timing() { let time = 0; const waits: number[] = []; return { clock: () => time, waits,
  wait: async (ms: number, signal: AbortSignal) => { assert.equal(signal.aborted, false); waits.push(ms); time += ms; } }; }
const primary = (id = 55, date = 100, fields: Partial<Api.Message> = {}, isGroup = false) => Object.assign(message(id, ownerId, "ПРОМПТ Invented request", isGroup), { date }, fields);
const batch = (values: Api.TypeMessage[], users: Api.TypeUser[] = []) => new Api.messages.Messages({ messages: values, users, chats: [] });
async function setup(responses: unknown[], isGroup = false) {
  const f = wire([dialogs(isGroup), ...responses]); const signal = controller().signal; const timer = timing();
  const adapter = await createConversationAdapter({ client: f.client, binding: binding(isGroup), self: self(), signal, startedAt: 100, ...timer });
  return { ...f, adapter, signal, timer };
}

test("real TL route uses one dialogs100, history10, exact selected read, self anchored send and fresh readback", async () => {
  for (const isGroup of [false, true]) {
    const history = batch([primary(56, 101, {}, isGroup), primary(55, 100, {}, isGroup)]);
    const reread = messages(primary(55, 100, {}, isGroup));
    const readback = messages(message(66, "789", "Invented reply", isGroup));
    const f = await setup([history, reread, shortAck(), readback], isGroup);
    const p = await f.adapter.waitForPrompt(f.signal);
    assert.deepEqual(p, { chatId: binding(isGroup).peerId, ownerId, messageId: 55, text: "ПРОМПТ Invented request" });
    assert.equal(history.messages.length, 0); assert.equal(reread.messages.length, 0);
    const dialogRequest = f.requests[0] as Api.messages.GetDialogs; assert.equal(dialogRequest.limit, 100);
    const historyRequest = f.requests[1] as Api.messages.GetHistory;
    assert.ok(historyRequest instanceof Api.messages.GetHistory); assert.equal(historyRequest.limit, 10);
    assert.equal(historyRequest.offsetId, 0); assert.equal(historyRequest.offsetDate, 0); assert.equal(historyRequest.addOffset, 0);
    assert.equal(historyRequest.minId, 0); assert.equal(historyRequest.maxId, 0);
    const reply = { chatId: p.chatId, replyToMessageId: p.messageId, text: "Invented reply", randomId: "112233" };
    await f.adapter.transport.sendOnce(reply, f.signal);
    const send = f.requests[3] as Api.messages.SendMessage;
    assert.ok(send.sendAs instanceof Api.InputPeerSelf); assert.ok(send.replyTo instanceof Api.InputReplyToMessage);
    assert.equal(send.replyTo.replyToMsgId, 55); assert.equal(send.noWebpage, true); assert.equal(send.allowPaidFloodskip, false);
    assert.deepEqual(await f.adapter.transport.readExact(p.chatId, 66, f.signal), { messageId: 66, chatId: p.chatId, accountId: "789", replyToMessageId: 55, text: reply.text });
    for (const index of [2, 4]) { const req = f.requests[index]; assert.ok(isGroup ? req instanceof Api.messages.GetMessages : req instanceof Api.channels.GetMessages); }
    await assert.rejects(f.adapter.waitForPrompt(f.signal)); await assert.rejects(f.adapter.transport.sendOnce(reply, f.signal));
    await assert.rejects(f.adapter.transport.readExact(p.chatId, 66, f.signal)); assert.equal(f.requests.length, 5);
  }
});

test("wrong peer, self/out, old, bot, channel author, forward/media, oversize and nontrigger are ignored", async () => {
  const excluded = [primary(1, 99), primary(2,100,{ out:true }), primary(3,100,{ fromId:new Api.PeerUser({userId:bigInt(789)}) }),
    primary(4,100,{ peerId:groupPeer() }), primary(5,100,{ fromId:new Api.PeerChannel({channelId:bigInt(8)}) }),
    primary(6,100,{ fwdFrom:new Api.MessageFwdHeader({date:1}) }), primary(7,100,{ media:new Api.MessageMediaPhoto({}) }),
    primary(8,100,{ message:"ПРОМПТ " + "я".repeat(2048) }), primary(9,100,{ message:"ПРОМПТОВЫЙ" }), primary(10,100,{ viaBotId:bigInt(1) }),
    primary(11,100,{ fromId:new Api.PeerUser({userId:bigInt(9)}) }), primary(12,100,{ post:true }), primary(13,100,{message:"ПРОМПТ \ud800"})];
  const first = batch(excluded.slice(0,10)); const second = batch(excluded.slice(10),[new Api.User({id:bigInt(9),bot:true})]);
  const f = await setup([first,second,batch([primary()]),messages(primary())]);
  assert.equal((await f.adapter.waitForPrompt(f.signal)).messageId,55);
  assert.deepEqual(f.timer.waits,[3000,3000]); assert.equal(first.messages.length,0);assert.equal(second.users.length,0);
});

test("all trigger delimiters preserved and oldest tie uses message id", async () => {
  for(const text of ["ПРОМПТ", "ПРОМПТ: abc", "ПРОМПТ, abc", "ПРОМПТ\nabc"]) {
    const f=await setup([batch([primary(56),primary(55,100,{message:text})]),messages(primary(55,100,{message:text}))]);
    assert.equal((await f.adapter.waitForPrompt(f.signal)).text,text);
  }
});

test("selected text/author/peer/date/id or eligibility changes refuse without polling again", async () => {
  for(const fields of [{message:"ПРОМПТ changed"},{fromId:new Api.PeerUser({userId:bigInt(457)})},{peerId:groupPeer()},{date:101},{id:56},{out:true},
    {fwdFrom:new Api.MessageFwdHeader({date:1})}]) {
    const f=await setup([batch([primary()]),messages(primary(55,100,fields))]);
    await assert.rejects(f.adapter.waitForPrompt(f.signal),/PILOT_TELEGRAM_REFUSED_OR_UNKNOWN/);
    await assert.rejects(f.adapter.waitForPrompt(f.signal)); assert.equal(f.requests.length,3);
  }
});

test("thirty empty history polls only, spaced at least three seconds; second wait cannot retry", async () => {
  const f=await setup(Array.from({length:30},()=>batch([])));
  await assert.rejects(f.adapter.waitForPrompt(f.signal)); await assert.rejects(f.adapter.waitForPrompt(f.signal));
  assert.equal(f.requests.length,31); assert.equal(f.timer.waits.length,29);assert.ok(f.timer.waits.every(ms=>ms>=3000));
});

test("invalid self/start and aborted creation make no requests; bad group refuses on single resolution", async () => {
  for(const change of [{self:new Api.User({id:bigInt(8),self:true})},{startedAt:0},{startedAt:1.5}]) {
    const f=wire([]);await assert.rejects(createConversationAdapter({client:f.client,binding:binding(),self:self(),signal:controller().signal,startedAt:100,...change}));
    assert.equal(f.requests.length,0);
  }
  const f=wire([dialogs(true)]);await assert.rejects(createConversationAdapter({client:f.client,binding:binding(),self:self(),signal:controller().signal,startedAt:100}));assert.equal(f.requests.length,1);
  const a=controller();a.abort();const g=wire([]);await assert.rejects(createConversationAdapter({client:g.client,binding:binding(),self:self(),signal:a.signal,startedAt:100}));assert.equal(g.requests.length,0);
});

test("history failures and oversized envelopes latch unknown without retry; raw errors sanitized", async () => {
  for(const response of [new Error("PRIVATE RAW"),batch(Array.from({length:11},()=>primary())),{}]) {
    const f=await setup([response]);await assert.rejects(f.adapter.waitForPrompt(f.signal),error=>error instanceof Error && error.message==="PILOT_TELEGRAM_REFUSED_OR_UNKNOWN");
    await assert.rejects(f.adapter.waitForPrompt(f.signal));assert.equal(f.requests.length,2);
  }
});

test("send not available before selection; failed send and mismatched readback never retry", async () => {
  const reply={chatId:channelId,replyToMessageId:55,text:"Invented reply",randomId:"112233"};
  const f=await setup([batch([primary()]),messages(primary()),new Error("private")]);
  await assert.rejects(f.adapter.transport.sendOnce(reply,f.signal));await f.adapter.waitForPrompt(f.signal);
  await assert.rejects(f.adapter.transport.sendOnce({...reply,replyToMessageId:56},f.signal));
  await assert.rejects(f.adapter.transport.sendOnce(reply,f.signal));await assert.rejects(f.adapter.transport.sendOnce(reply,f.signal));assert.equal(f.requests.length,4);
  for(const change of [{out:false},{message:"wrong"},{fromId:new Api.PeerUser({userId:bigInt(9)})},{replyTo:new Api.MessageReplyHeader({replyToMsgId:56})}]) {
    const g=await setup([batch([primary()]),messages(primary()),shortAck(),messages(Object.assign(message(66,"789","Invented reply"),change))]);
    await g.adapter.waitForPrompt(g.signal);await g.adapter.transport.sendOnce(reply,g.signal);await assert.rejects(g.adapter.transport.readExact(channelId,66,g.signal));
    await assert.rejects(g.adapter.transport.readExact(channelId,66,g.signal));assert.equal(g.requests.length,5);
  }
});

test("abort during history discards late envelopes and prevents selected reread", async () => {
  const abort=controller();const late=batch([primary()]);let count=0;
  const client:PilotInvoker={async invoke(){count++;if(count===1)return dialogs();abort.abort();return late;}};
  const a=await createConversationAdapter({client,binding:binding(),self:self(),signal:abort.signal,startedAt:100,...timing()});
  await assert.rejects(a.waitForPrompt(abort.signal));assert.equal(late.messages.length,0);assert.equal(count,2);
});

test("injected clock cannot shorten poll spacing or exceed ninety seconds", async () => {
  for(const next of [0,90000,-1,NaN]) {
    let time=0;const f=wire([dialogs(),batch([])]);const signal=controller().signal;
    const a=await createConversationAdapter({client:f.client,binding:binding(),self:self(),signal,startedAt:100,clock:()=>time,wait:async()=>{time=next;}});
    await assert.rejects(a.waitForPrompt(signal));assert.equal(f.requests.length,2);
  }
});
