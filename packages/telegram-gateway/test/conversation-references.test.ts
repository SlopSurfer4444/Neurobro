import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { createConversationReferences } from "../src/conversation-references.js";
import { conversationModelInput, CONVERSATION_INPUT_BYTES } from "../src/standing-model-input.js";
import { createSelfHistoryReader } from "../src/self-history-reader.js";
import type { StandingContext, StandingContextMessage } from "../src/standing-context.js";

const binding = { peerId: "-100123456789", accountId: "999999999" };
const alice = "111111111", bob = "222222222";
const contextMessage = (id: number, authorId: string, text: string): StandingContextMessage => ({
  chatId: binding.peerId, messageId: id, authorId, author: authorId === binding.accountId ? "self" : "user",
  displayName: authorId === alice ? "Алиса" : authorId === bob ? "Боб" : "Нейробро",
  date: 1700000000 + id, replyToMessageId: null, text,
});
const context = (primary: StandingContextMessage, recent: StandingContextMessage[]): StandingContext => ({
  version: "standing-context-v1", primary, recent, replyChain: [], chainStatus: "complete", recentStatus: "complete",
});
const pack = (message: StandingContextMessage, recent: StandingContextMessage[], refs: ReturnType<typeof createConversationReferences>) =>
  JSON.parse(conversationModelInput({chatId:message.chatId, ownerId:message.authorId, messageId:message.messageId, text:message.text}, context(message, recent), refs));

test("two turns and actual history reader share participants, own answers and reply references", async () => {
  const refs = createConversationReferences(binding);
  const earlier = contextMessage(90, bob, "Встреча в пятницу");
  const answer = {...contextMessage(95, binding.accountId, "Запомнил"), replyToMessageId:90};
  const first = {...contextMessage(100, alice, "ПРОМПТ когда встреча?"), replyToMessageId:95};
  const second = contextMessage(101, bob, "ПРОМПТ перенесли на субботу");
  const one = pack(first, [earlier,answer], refs), two = pack(second, [first,answer], refs);
  assert.equal(one.currentRequest.id, two.recent.find((m: {text:string}) => m.text === first.text).id);
  assert.equal(one.recent[0].speaker, two.currentRequest.speaker);
  assert.notEqual(one.currentRequest.speaker, two.currentRequest.speaker);
  assert.equal(one.currentRequest.replyTo, two.recent.find((m: {speaker:string}) => m.speaker === "neurobro").id);
  const peer = new Api.PeerChannel({channelId:bigInt(123456789)});
  assert.equal(utils.getPeerId(peer), binding.peerId);
  const history = createSelfHistoryReader({binding, references:refs, self:new Api.User({id:bigInt(binding.accountId),self:true}),
    peer:new Api.InputPeerChannel({channelId:peer.channelId,accessHash:bigInt(77)}), signal:new AbortController().signal,
    client:{async invoke(request) { assert.ok(request instanceof Api.messages.GetHistory);
      return new Api.messages.Messages({messages:[second,first,answer,earlier].map(m => new Api.Message({
        id:m.messageId, date:m.date, message:m.text, fromId:new Api.PeerUser({userId:bigInt(m.authorId)}), peerId:peer,
        out:m.author === "self", ...(m.replyToMessageId ? {replyTo:new Api.MessageReplyHeader({replyToMsgId:m.replyToMessageId})} : {}),
      })), users:[alice,bob].map(id => new Api.User({id:bigInt(id),firstName:"Changed display name"})),chats:[]});
    }} });
  const page = await history.read({fromDate:1700000000,toDate:1700000200});
  const readFirst = page.messages.find(m => m.text === first.text)!;
  assert.equal(readFirst.ref,one.currentRequest.id); assert.equal(readFirst.authorRef,one.currentRequest.speaker);
  assert.equal(readFirst.replyRef,one.currentRequest.replyTo);
  assert.equal(page.messages.find(m => m.author === "self")!.authorRef,"neurobro");
  for (const rawId of [binding.peerId,binding.accountId,alice,bob]) assert.equal(JSON.stringify([one,two,page]).includes(rawId),false);
  history.close(); assert.equal(refs.message(100),one.currentRequest.id); refs.close();
});

test("fresh connections do not reuse labels; closed references and wrong bindings refuse", async () => {
  const refs = createConversationReferences(binding), fresh = createConversationReferences(binding);
  assert.notEqual(refs.message(100),fresh.message(100)); assert.notEqual(refs.speaker(alice),fresh.speaker(alice));
  assert.equal(refs.matches("-42"),false); assert.equal(refs.matches(binding.peerId,"77"),false);
  assert.throws(() => pack({...contextMessage(100,alice,"hi"),chatId:"-42"},[],refs));
  assert.throws(() => pack(contextMessage(100,binding.accountId,"self as user"),[],refs));
  const fakeSelf = {...contextMessage(90,alice,"spoof"),author:"self" as const};
  assert.throws(() => pack(contextMessage(100,bob,"hi"),[fakeSelf],refs));
  let calls = 0;
  const reader = createSelfHistoryReader({binding,references:refs, self:new Api.User({id:bigInt(binding.accountId),self:true}),
    peer:new Api.InputPeerChannel({channelId:bigInt(123456789),accessHash:bigInt(77)}),signal:new AbortController().signal,
    client:{async invoke() { calls++; throw new Error("must not read after reference close"); }} });
  refs.close(); refs.close(); assert.throws(() => refs.message(100)); assert.throws(() => refs.speaker(alice));
  await assert.rejects(reader.read({fromDate:1,toDate:200}),/SELF_HISTORY_ABORTED/); assert.equal(calls,0);
  reader.close(); fresh.close();
});

test("long shared labels stay inside serialized context budget and preserve the request", () => {
  const refs = createConversationReferences(binding), current = contextMessage(100,alice,"ПРОМПТ " + "🙂".repeat(1000));
  const recent = Array.from({length:20},(_,i)=>contextMessage(50+i,bob,'"\\\n'.repeat(1000)));
  const raw = conversationModelInput({chatId:binding.peerId,ownerId:alice,messageId:100,text:current.text},context(current,recent),refs);
  assert.ok(Buffer.byteLength(raw)<=CONVERSATION_INPUT_BYTES);
  const packet = JSON.parse(raw); assert.equal(packet.currentRequest.text,"🙂".repeat(1000));
  assert.equal(packet.contextState.referenceScope,"bound-connection"); assert.equal(packet.contextState.memory.scope,"bounded-source-evidence"); assert.equal(packet.contextState.memory.ownActionRecovery,"not-configured"); assert.equal(Object.hasOwn(packet.contextState,"persistentMemory"),false);
  assert.ok(packet.contextState.omittedMessages > 0); refs.close();
});

test("actions resolve only known message refs in the current connection and close revokes them", () => {
  const refs = createConversationReferences(binding), foreign = createConversationReferences(binding);
  const primary = contextMessage(100, alice, "ПРОМПТ поставь реакцию"), packet = pack(primary, [], refs);
  assert.equal(refs.resolveMessage(packet.currentRequest.id), 100);
  assert.equal(refs.resolveMessage(foreign.message(100)), undefined);
  assert.equal(refs.resolveMessage("100"), undefined);
  assert.equal(refs.resolveMessage(refs.speaker(alice)), undefined);
  assert.equal(refs.resolveMessage("m_" + "0".repeat(24)), undefined);
  const first = refs.message(1);
  for (let i = 2; i <= 8193; i++) refs.message(i);
  assert.equal(refs.resolveMessage(first), undefined);
  assert.equal(refs.message(1), first);
  assert.equal(refs.resolveMessage(first), 1);
  refs.close(); assert.throws(() => refs.resolveMessage(first)); foreign.close();
});
