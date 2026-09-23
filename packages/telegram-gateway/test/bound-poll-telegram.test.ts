import test from "node:test";
import assert from "node:assert/strict";
import {Api,utils} from "telegram";
import {BinaryReader} from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import {createBoundPollTelegramTransport,BoundPollError,type BoundPollOperation,type BoundPollSpec} from "../src/bound-poll-telegram.js";
const wire=<T extends {getBytes():Buffer}>(v:T):T=>new BinaryReader(v.getBytes()).tgReadObject() as T;
const text=(s:string)=>new Api.TextWithEntities({text:s,entities:[]});
const spec=(type:BoundPollSpec["type"]="single",anonymous=true):BoundPollSpec=>({question:"Where next?",options:["North","South"],anonymous,type,...(type==="quiz"?{correctOption:1,explanation:"South is correct"}:{})});
const operation=(poll=spec()):BoundPollOperation=>({operationId:"fixture-poll-1",randomId:"123456",poll});
const reject=(code:string,unknown=false)=>(e:unknown)=>e instanceof BoundPollError&&e.code===code&&e.unknown===unknown&&!e.cause&&!e.message.includes("PRIVATE");
const gate=()=>{let done!:()=>void;const promise=new Promise<void>(r=>{done=r;});return{promise,done};};
function fixture(basic=false, primaryText="ПРОМПТ poll"){
  const signal=new AbortController(),requests:Api.AnyRequest[]=[],peer=basic?new Api.InputPeerChat({chatId:bigInt(123)}):new Api.InputPeerChannel({channelId:bigInt(123),accessHash:bigInt(987)});
  const binding={accountId:"789",peerId:utils.getPeerId(peer)},primary={chatId:binding.peerId,ownerId:"456",messageId:91,text:primaryText};
  const chat=basic?new Api.Chat({id:bigInt(123),title:"Group",photo:new Api.ChatPhotoEmpty(),date:1,participantsCount:1,version:1}):
    new Api.Channel({id:bigInt(123),accessHash:bigInt(987),title:"Group",photo:new Api.ChatPhotoEmpty(),date:1,megagroup:true});
  let current:Api.Message|undefined,active=true,override:((r:Api.AnyRequest)=>Promise<unknown>)|undefined,primaryValue={...primary};
  const results=(quiz=false)=>new Api.PollResults({totalVoters:3,results:[new Api.PollAnswerVoters({option:Buffer.from([0]),voters:1}),new Api.PollAnswerVoters({option:Buffer.from([1]),voters:2,...(quiz?{correct:true}:{})})],
    ...(quiz?{solution:"South is correct",solutionEntities:[]}:{}),recentVoters:[new Api.PeerUser({userId:bigInt(777)})]});
  function seed(p=spec(),own=true){
    const poll=new Api.Poll({id:bigInt(555),publicVoters:!p.anonymous,multipleChoice:p.type==="multiple",quiz:p.type==="quiz",question:text(p.question),answers:p.options.map((s,i)=>new Api.PollAnswer({text:text(s),option:Buffer.from([i])}))});
    current=new Api.Message({id:100,peerId:basic?new Api.PeerChat({chatId:bigInt(123)}):new Api.PeerChannel({channelId:bigInt(123)}),fromId:new Api.PeerUser({userId:bigInt(own?789:456)}),out:own,date:100,message:"",
      replyTo:new Api.MessageReplyHeader({replyToMsgId:91}),media:new Api.MessageMediaPoll({poll,results:results(p.type==="quiz")})});return current;
  }
  const full=()=>new Api.messages.ChatFull({chats:[chat],users:[],fullChat:basic?
    new Api.ChatFull({id:bigInt(123),about:"Bound group",participants:new Api.ChatParticipants({chatId:bigInt(123),version:1,participants:[new Api.ChatParticipant({userId:bigInt(789),inviterId:bigInt(456),date:1})]}),notifySettings:new Api.PeerNotifySettings({})}):
    new Api.ChannelFull({id:bigInt(123),about:"Bound group",readInboxMaxId:0,readOutboxMaxId:0,unreadCount:0,chatPhoto:new Api.PhotoEmpty({id:bigInt(1)}),notifySettings:new Api.PeerNotifySettings({}),botInfo:[],pts:1})});
  const batch=(updates:Api.TypeUpdate[])=>new Api.Updates({updates,users:[],chats:[],date:100,seq:1});
  async function respond(r:Api.AnyRequest):Promise<unknown>{
    if(r instanceof Api.channels.GetFullChannel||r instanceof Api.messages.GetFullChat)return wire(full());
    if(r instanceof Api.messages.SendMedia){assert.ok(r.sendAs instanceof Api.InputPeerSelf);assert.ok(r.media instanceof Api.InputMediaPoll);assert.equal(utils.getPeerId(r.peer),binding.peerId);
      const s=seed({question:r.media.poll.question.text,options:r.media.poll.answers.map(a=>a.text.text),type:r.media.poll.quiz?"quiz":r.media.poll.multipleChoice?"multiple":"single",anonymous:!r.media.poll.publicVoters,...(r.media.poll.quiz?{correctOption:1,explanation:"South is correct"}:{})});
      assert.ok(r.replyTo instanceof Api.InputReplyToMessage);assert.equal(r.replyTo.replyToMsgId,91);
      if(r.media.poll.quiz){assert.deepEqual(r.media.correctAnswers,[Buffer.from([1])]);assert.equal(r.media.solution,"South is correct");}
      return wire(batch([new Api.UpdateMessageID({id:100,randomId:r.randomId!}),basic?new Api.UpdateNewMessage({message:s,pts:1,ptsCount:1}):new Api.UpdateNewChannelMessage({message:s,pts:1,ptsCount:1})]));}
    if(r instanceof Api.channels.GetMessages||r instanceof Api.messages.GetMessages){assert.equal((r.id[0] as Api.InputMessageID).id,100);return wire(new Api.messages.Messages({messages:current?[current]:[new Api.MessageEmpty({id:100})],users:[],chats:[]}));}
    if(r instanceof Api.messages.GetPollResults){assert.equal(utils.getPeerId(r.peer),binding.peerId);assert.equal(r.msgId,100);assert.ok(current?.media instanceof Api.MessageMediaPoll);return wire(batch([new Api.UpdateMessagePoll({pollId:current.media.poll.id,poll:current.media.poll,results:current.media.results})]));}
    if(r instanceof Api.messages.EditMessage){assert.equal(r.id,100);assert.equal(utils.getPeerId(r.peer),binding.peerId);assert.ok(r.media instanceof Api.InputMediaPoll);assert.equal(r.media.poll.closed,true);
      assert.ok(current?.media instanceof Api.MessageMediaPoll);current.media.poll.closed=true;
      return wire(batch([new Api.UpdateMessagePoll({pollId:current.media.poll.id,poll:current.media.poll,results:current.media.results})]));}
    throw Error("unexpected request");
  }
  const input={binding,peer,self:new Api.User({id:bigInt(789),self:true}),selected:primary,signal:signal.signal,isSelectionActive:()=>active,revalidatePrimary:async()=>({...primaryValue}),
    client:{invoke:async(r:Api.AnyRequest)=>{requests.push(r);wire(r);return override?override(r):respond(r);}}};
  return{transport:createBoundPollTelegramTransport(input),input,signal,requests,chat,full,seed,respond,batch,results,current:()=>current!,override:(v:typeof override)=>{override=v;},inactive:()=>{active=false;},changePrimary:()=>{primaryValue={...primary,text:"changed"};}};
}

test("normal, multiple and quiz polls use installed TL wire with exact own author/randomId/readback",async()=>{
  for(const basic of [false,true])for(const type of ["single","multiple","quiz"] as const)for(const anonymous of [true,false]){
    const f=fixture(basic),created=await f.transport.createOnce(operation(spec(type,anonymous)));
    assert.equal(created.record.messageId,100);assert.equal(created.record.pollId,"555");assert.equal(created.poll.own,true);assert.equal(created.poll.type,type);assert.equal(created.poll.anonymous,anonymous);
    assert.equal(created.poll.totalVoters,3);assert.deepEqual(created.poll.options.map(o=>o.voters),[1,2]);assert.equal(created.poll.coverage.voterIdentities,"not-read");
    assert.ok(!JSON.stringify(created.poll).includes("777"));assert.equal(f.requests.filter(r=>r instanceof Api.messages.SendMedia).length,1);assert.equal(f.transport.ownedRecord(),created.record);
    await assert.rejects(f.transport.createOnce(operation()),reject("consumed",true));await f.transport.close();
  }
});
test("long Russian incoming request can create a poll without shortening its bound primary", async () => {
  const f=fixture(false,"ПРОМПТ "+"я".repeat(4000)+" конец");
  try { assert.equal((await f.transport.createOnce(operation())).poll.own,true);
    assert.equal(f.requests.filter(r=>r instanceof Api.messages.SendMedia).length,1);
  } finally {await f.transport.close();}
});
test("permission preflight refuses actual default or own poll bans and permits observed administrator override",async()=>{
  for(const basic of [true,false])for(const admin of [false,true]){
    const f=fixture(basic);f.chat.defaultBannedRights=new Api.ChatBannedRights({sendPolls:true,untilDate:0});if(admin)f.chat.creator=true;
    if(admin)assert.equal((await f.transport.createOnce(operation())).poll.own,true);else{await assert.rejects(f.transport.createOnce(operation()),reject("permission"));assert.equal(f.requests.some(r=>r instanceof Api.messages.SendMedia),false);}await f.transport.close();
  }
  const f=fixture();assert.ok(f.chat instanceof Api.Channel);f.chat.bannedRights=new Api.ChatBannedRights({sendPolls:true,untilDate:0});f.chat.creator=true;
  await assert.rejects(f.transport.createOnce(operation()),reject("permission"));await f.transport.close();
});
test("foreign full-group response, missing basic membership and changed primary fail before mutation",async()=>{
  for(const mode of ["foreign","membership","primary"]){const f=fixture(mode==="membership");
    if(mode==="primary")f.changePrimary();else f.override(async r=>{if(r instanceof Api.channels.GetFullChannel||r instanceof Api.messages.GetFullChat){const e=f.full();if(mode==="foreign")e.fullChat.id=bigInt(999);else {assert.ok(e.fullChat instanceof Api.ChatFull);e.fullChat.participants=new Api.ChatParticipantsForbidden({chatId:bigInt(123)});}return e;}return f.respond(r);});
    await assert.rejects(f.transport.createOnce(operation()),reject(mode==="primary"?"primary":mode==="foreign"?"protocol":"permission"));assert.equal(f.requests.some(r=>r instanceof Api.messages.SendMedia),false);await f.transport.close();}
});
test("create ACK mapping, own author and options must match; no blind replay on uncertainty",async()=>{
  for(const mode of ["random","author","option","readback"]){const f=fixture();f.override(async r=>{const response=await f.respond(r);
    if(r instanceof Api.messages.SendMedia&&response instanceof Api.Updates){if(mode==="random")(response.updates[0] as Api.UpdateMessageID).randomId=bigInt(999);
      const m=(response.updates[1] as Api.UpdateNewChannelMessage).message as Api.Message;if(mode==="author")m.fromId=new Api.PeerUser({userId:bigInt(456)});
      if(mode==="option"){assert.ok(m.media instanceof Api.MessageMediaPoll);m.media.poll.answers[0]!.option=Buffer.from([8]);}}
    if(mode==="readback"&&r instanceof Api.channels.GetMessages)throw Error("PRIVATE_READ_FAILURE");return response;});
    await assert.rejects(f.transport.createOnce(operation()),reject(mode==="readback"?"transport":"protocol",true));assert.equal(!!f.transport.ownedRecord(),mode==="readback");
    await assert.rejects(f.transport.createOnce(operation()),reject("aborted",true));assert.equal(f.requests.filter(r=>r instanceof Api.messages.SendMedia).length,1);await f.transport.close();}
});
test("reading bound foreign polls is allowed but closing another author is refused",async()=>{
  const f=fixture();f.seed(spec(),false);const result=await f.transport.inspect(100);assert.equal(result.own,false);assert.equal(result.totalVoters,3);
  await assert.rejects(f.transport.closeOwnOnce(100),reject("permission"));assert.equal(f.requests.some(r=>r instanceof Api.messages.EditMessage),false);await f.transport.close();
});
test("close own poll verifies exact content and fresh server closed state; already closed is read-only",async()=>{
  for(const basic of [false,true])for(const already of [false,true]){const f=fixture(basic),m=f.seed();assert.ok(m.media instanceof Api.MessageMediaPoll);m.media.poll.closed=already;
    const result=await f.transport.closeOwnOnce(100);assert.equal(result.status,already?"already-closed":"closed");assert.equal(result.poll.closed,true);
    assert.equal(f.requests.filter(r=>r instanceof Api.messages.EditMessage).length,already?0:1);await f.transport.close();}
});
test("wrong poll result identity or missing counters remains refused or explicitly partial",async()=>{
  for(const wrong of [false,true]){const f=fixture();f.seed();f.override(async r=>{if(r instanceof Api.messages.GetPollResults)return f.batch([new Api.UpdateMessagePoll({pollId:bigInt(wrong?999:555),results:new Api.PollResults({min:true})})]);return f.respond(r);});
    if(wrong)await assert.rejects(f.transport.inspect(100),reject("protocol"));else {const p=await f.transport.inspect(100);assert.equal(p.totalVoters,null);assert.equal(p.coverage.complete,false);assert.ok(p.options.every(o=>o.voters===null&&o.chosen===null));}await f.transport.close();}
});
test("unknown edit never retries and a false closed readback cannot claim success",async()=>{
  for(const mode of ["throw","not-closed"]){const f=fixture();f.seed();f.override(async r=>{if(r instanceof Api.messages.EditMessage){if(mode==="throw")throw Error("PRIVATE_EDIT_FAILURE");return f.batch([]);}return f.respond(r);});
    await assert.rejects(f.transport.closeOwnOnce(100),reject(mode==="throw"?"transport":"protocol",true));await assert.rejects(f.transport.closeOwnOnce(100),reject("aborted",true));
    assert.equal(f.requests.filter(r=>r instanceof Api.messages.EditMessage).length,1);await f.transport.close();}
});
test("strict operation snapshots reject getters/proxies and survive immediate mutation",async()=>{
  const f=fixture();let reads=0;const v=operation();Object.defineProperty(v,"poll",{get(){reads++;return spec();},enumerable:true});await assert.rejects(f.transport.createOnce(v),reject("input"));assert.equal(reads,0);
  await assert.rejects(f.transport.createOnce(new Proxy(operation(),{ownKeys(){reads++;return[];}})),reject("input"));assert.equal(reads,0);
  const mutable={...operation(),poll:{...spec(),options:["North","South"]}},pending=f.transport.createOnce(mutable);mutable.poll.question="Changed";mutable.poll.options.length=0;
  assert.equal((await pending).poll.question,"Where next?");await f.transport.close();
});
test("invalid mode, quiz, size, duplicate options and raw target inputs invoke nothing",async()=>{
  const f=fixture();for(const poll of [{...spec(),type:"unknown"},{...spec(),options:["same","same"]},{...spec(),question:"q".repeat(256)},{...spec(),options:["one"]},
    {...spec(),correctOption:1},{...spec("quiz"),correctOption:2},{...spec(),type:{toString(){throw Error("must not run");}}}])await assert.rejects(f.transport.createOnce(operation(poll as BoundPollSpec)),reject("input"));
  await assert.rejects(f.transport.inspect("100" as never),reject("input"));assert.equal(f.requests.length,0);await f.transport.close();
});
test("STOP joins actual pending create and suppresses late publication; single-flight excludes other reads",async()=>{
  const f=fixture(),entered=gate(),end=gate();f.override(async r=>{if(r instanceof Api.messages.SendMedia){entered.done();await end.promise;}return f.respond(r);});
  const work=f.transport.createOnce(operation());await entered.promise;await assert.rejects(f.transport.inspect(100),reject("busy",true));let settled=false;const closing=f.transport.close().then(()=>{settled=true;});
  await new Promise<void>(done=>setImmediate(done));assert.equal(settled,false);end.done();await assert.rejects(work,reject("aborted",true));await closing;assert.equal(settled,true);
  assert.equal(f.requests.filter(r=>r instanceof Api.messages.SendMedia).length,1);assert.equal(f.requests.some(r=>r instanceof Api.messages.GetPollResults),false);
});
test("STOP before mutation and foreign bindings are known refusals",async()=>{
  const f=fixture(),entered=gate(),end=gate();f.override(async r=>{if(r instanceof Api.channels.GetFullChannel){entered.done();await end.promise;}return f.respond(r);});
  const work=f.transport.createOnce(operation());await entered.promise;f.signal.abort();end.done();await assert.rejects(work,reject("aborted"));await f.transport.close();assert.equal(f.requests.some(r=>r instanceof Api.messages.SendMedia),false);
  assert.throws(()=>createBoundPollTelegramTransport({...f.input,binding:{...f.input.binding,peerId:"-999"}}),reject("config"));
});
test("inconsistent counts, duplicate result options and unknown option IDs are protocol refusals",async()=>{
  for(const mode of ["count","duplicate","foreign"]){const f=fixture(),m=f.seed();assert.ok(m.media instanceof Api.MessageMediaPoll);const rows=m.media.results.results!;
    if(mode==="count")rows[0]!.voters=3;if(mode==="duplicate")rows[1]!.option=Buffer.from([0]);if(mode==="foreign")rows[1]!.option=Buffer.from([9]);
    await assert.rejects(f.transport.inspect(100),reject("protocol"));await f.transport.close();}
});
test("quiz creation cannot claim verified correct option when server omits the proof",async()=>{
  const f=fixture();f.override(async r=>{const value=await f.respond(r);if(r instanceof Api.messages.GetPollResults&&value instanceof Api.Updates){const u=value.updates[0] as Api.UpdateMessagePoll;for(const row of u.results.results??[])row.correct=false;}return value;});
  await assert.rejects(f.transport.createOnce(operation(spec("quiz"))),reject("protocol",true));assert.ok(f.transport.ownedRecord());await f.transport.close();
});
test("timed polls can be inspected and own closed state proved without creating a timer",async()=>{
  const f=fixture(),m=f.seed();assert.ok(m.media instanceof Api.MessageMediaPoll);m.media.poll.closeDate=1700000000;
  assert.equal((await f.transport.inspect(100)).closed,false);assert.equal((await f.transport.closeOwnOnce(100)).poll.closed,true);await f.transport.close();
});
test("replacing caller binding or active callback cannot retarget captured transport",async()=>{
  const f=fixture();f.input.binding.peerId="-999";f.input.peer=new Api.InputPeerChat({chatId:bigInt(999)});f.input.isSelectionActive=()=>false;
  // Fixture's responder also reads its original binding object; restore that
  // response-only expectation after proving the captured peer in the request.
  f.override(async r=>{if(r instanceof Api.messages.SendMedia)assert.equal(utils.getPeerId(r.peer),"-100123");f.input.binding.peerId="-100123";return f.respond(r);});
  assert.equal((await f.transport.createOnce(operation())).record.chatId,"-100123");await f.transport.close();
});
