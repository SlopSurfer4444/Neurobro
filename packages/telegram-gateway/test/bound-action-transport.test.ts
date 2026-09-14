import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {Api,utils} from "telegram";
import {BinaryReader} from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import {createBoundActionTransportLease} from "../src/bound-action-transport.js";
import {createConversationReferences} from "../src/conversation-references.js";
import type {BoundPollSpec} from "../src/bound-poll-telegram.js";
import type {BoundActionOutcome} from "../src/standing-bound-action-runtime.js";
import {createStandingBoundActionRuntime} from "../src/standing-bound-action-runtime.js";
import {openStandingActionJournal, standingActionKey} from "../src/standing-action-journal.js";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import type {EpochToolResult} from "../src/standing-tool-dispatcher.js";
const wire=<T extends {getBytes():Buffer}>(v:T):T=>{const b=v.getBytes(),r=new BinaryReader(b);const decoded=r.tgReadObject() as T;assert.equal(r.tellPosition(),b.length);return decoded;};
const text=(s:string)=>new Api.TextWithEntities({text:s,entities:[]});
const spec=(type:BoundPollSpec['type']='single',anonymous=true):BoundPollSpec=>({question:'Where next?',options:['North','South'],anonymous,type,...(type==='quiz'?{correctOption:1,explanation:'South is correct'}:{})});
const gate=()=>{let done!:()=>void;const promise=new Promise<void>(r=>{done=r;});return{promise,done};};

test('profile lease uses fresh self, preserves omitted surname and shares exact selected primary boundary',async()=>{
  const f=fixture();let firstName='Old',lastName='Surname';
  const self=()=>wire(new Api.User({id:bigInt(789),self:true,firstName,lastName}));
  f.override(async r=>{
    if(r instanceof Api.users.GetUsers){assert.equal(r.id.length,1);assert.ok(r.id[0] instanceof Api.InputUserSelf);return[self()];}
    if(r instanceof Api.account.UpdateProfile){firstName=r.firstName!;lastName=r.lastName!;return self();}
    throw Error('unexpected-profile-request');
  });
  const inspect=f.lease();assert.equal(((await inspect.execute({kind:'read-self-profile'},'123456')).outcome).verdict,'verified');await inspect.close();
  const update=f.lease();const result=(await update.execute({kind:'set-display-name',firstName:'Нейробро'},'123457')).outcome;
  assert.deepEqual(result,{verdict:'verified',code:'verified',profile:{firstName:'Нейробро',lastName:'Surname',hasPhoto:false}});
  assert.equal(f.requests.filter(r=>r instanceof Api.account.UpdateProfile).length,1);await update.close();
  const count=f.requests.length;f.changePrimary();const stale=f.lease();
  assert.equal(((await stale.execute({kind:'set-display-name',firstName:'Other'},'123458')).outcome).verdict,'refused');
  assert.equal(f.requests.length,count);await stale.close();f.references.close();
});

test('avatar lease resolves host bytes once and verifies returned photo identity without message send',async()=>{
  const f=fixture(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=','base64');
  let photo=false,copies=0;const copied=Buffer.from(png);
  f.override(async r=>{
    if(r instanceof Api.users.GetUsers)return[wire(new Api.User({id:bigInt(789),self:true,firstName:'Bro',
      ...(photo?{photo:new Api.UserProfilePhoto({photoId:bigInt(77),dcId:1})}:{})}))];
    if(r instanceof Api.upload.SaveFilePart){assert.deepEqual(r.bytes,png);return true;}
    if(r instanceof Api.photos.UploadProfilePhoto){photo=true;return wire(new Api.photos.Photo({photo:new Api.Photo({id:bigInt(77),accessHash:bigInt(88),fileReference:Buffer.alloc(0),date:1,sizes:[],dcId:1}),users:[]}));}
    throw Error('unexpected-profile-request');
  });
  const lease=createBoundActionTransportLease({...f.input,references:f.references,resolveAvatar:ref=>{
    assert.equal(ref,'art_'+'a'.repeat(48));copies++;return{bytes:copied,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')};}});
  assert.equal(((await lease.execute({kind:'set-avatar',artifactRef:'art_'+'a'.repeat(48)},'123456')).outcome).verdict,'verified');
  assert.equal(copies,1);assert.ok(copied.every(v=>v===0));assert.equal(f.requests.filter(r=>r instanceof Api.photos.UploadProfilePhoto).length,1);
  assert.equal(f.requests.some(r=>r instanceof Api.messages.SendMedia||r instanceof Api.messages.SendMessage),false);
  await lease.close();f.references.close();
});
function fixture(basic=false){
  const signal=new AbortController(),requests:Api.AnyRequest[]=[],peer=basic?new Api.InputPeerChat({chatId:bigInt(123)}):new Api.InputPeerChannel({channelId:bigInt(123),accessHash:bigInt(987)});
  const binding={accountId:"789",peerId:utils.getPeerId(peer)},primary={chatId:binding.peerId,ownerId:"456",messageId:91,text:"ПРОМПТ poll"};
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
  const references=createConversationReferences(binding);
  return{lease:()=>createBoundActionTransportLease({...input,references}),references,input,signal,requests,chat,full,seed,respond,batch,results,current:()=>current!,override:(v:typeof override)=>{override=v;},inactive:()=>{active=false;},changePrimary:()=>{primaryValue={...primary,text:"changed"};}};
}

test('group avatar named runtime reserves encrypted intent then same-client lease applies and fresh verifies; consumed slot never replays',async()=>{
  for(const lostAck of [false,true]){
    const f=fixture(),directory=await mkdtemp(join(tmpdir(),'neurobro-group-avatar-test-')),passphrase='synthetic group avatar journal passphrase';
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=','base64');
    let applied=false,resolutions=0;const resolvedBuffers:Buffer[]=[];
    f.override(async r=>{
      if(r instanceof Api.channels.GetChannels){
        assert.equal(r.id.length,1);assert.ok(r.id[0] instanceof Api.InputChannel);assert.equal(r.id[0].channelId.toString(),'123');
        const chat=new Api.Channel({id:bigInt(123),accessHash:bigInt(987),title:'Group',date:1,megagroup:true,
          photo:applied?new Api.ChatPhoto({photoId:bigInt(55),dcId:1}):new Api.ChatPhotoEmpty()});
        return wire(new Api.messages.Chats({chats:[chat]}));
      }
      if(r instanceof Api.upload.SaveFilePart){
        const journal=await openStandingActionJournal({directory:join(directory,'action-journal'),passphrase,binding:{accountId:f.input.binding.accountId,chatId:f.input.binding.peerId,primaryMessageId:91,operationSlot:0}});
        try{const state=await journal.inspect();assert.equal(state.state,'reserved');assert.deepEqual(state.intent?.action,{kind:'set-group-avatar',artifactRef:'art_'+'a'.repeat(48)});assert.equal(state.intent?.randomId,r.fileId.toString());}finally{await journal.close();}
        assert.deepEqual(r.bytes,png);return true;
      }
      if(r instanceof Api.channels.EditPhoto){
        applied=true;if(lostAck)throw Error('private lost reply');
        const message=new Api.MessageService({id:101,date:1,out:true,peerId:new Api.PeerChannel({channelId:bigInt(123)}),fromId:new Api.PeerUser({userId:bigInt(789)}),
          action:new Api.MessageActionChatEditPhoto({photo:new Api.Photo({id:bigInt(55),accessHash:bigInt(44),fileReference:Buffer.alloc(0),date:1,sizes:[],dcId:1})})});
        return wire(f.batch([new Api.UpdateNewChannelMessage({message,pts:1,ptsCount:1})]));
      }
      throw Error('unexpected group-avatar request');
    });
    const create=()=>createStandingBoundActionRuntime({binding:f.input.binding,stateDirectory:directory,passphrase,signal:f.signal.signal,killed:()=>false});
    const lease=()=>createBoundActionTransportLease({...f.input,references:f.references,resolveAvatar:ref=>{
      resolutions++;assert.equal(ref,'art_'+'a'.repeat(48));const bytes=Buffer.from(png);resolvedBuffers.push(bytes);return{bytes,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')};}});
    const call=async(runtime:ReturnType<typeof create>,requestRef:string)=>{
      const result=await runtime.handlers.find(h=>h.name==='neurobro_set_group_avatar')!.call({artifactRef:'art_'+'a'.repeat(48)},
        {requestRef,callRef:'avatar-call',signal:f.signal.signal}) as EpochToolResult;
      return JSON.parse(result.contentItems[0].text);
    };
    const runtime=create();
    try{
      runtime.begin({requestRef:'request-1',primary:f.input.selected,openActions:lease});
      const result=await call(runtime,'request-1');assert.equal(result.verdict,lostAck?'unknown':'verified');assert.equal(applied,true);
      assert.equal(resolvedBuffers.length,1);assert.ok(resolvedBuffers[0]!.every(value=>value===0));
      assert.equal(runtime.state().blocked,lostAck);assert.equal(f.requests.filter(r=>r instanceof Api.channels.EditPhoto).length,1);
      await runtime.close();
      const reopened=create();try{
        reopened.begin({requestRef:'request-2',primary:f.input.selected,openActions:lease});
        assert.equal((await call(reopened,'request-2')).verdict,'refused');assert.equal(reopened.state().blocked,true);assert.equal(resolutions,1);
      }finally{await reopened.close();}
    }finally{await runtime.close();f.references.close();await rm(directory,{recursive:true,force:true});}
  }
});

test('group avatar stale primary or missing artifact refuses before reading group or uploading',async()=>{
  const f=fixture();let resolved=0;f.changePrimary();
  const stale=createBoundActionTransportLease({...f.input,references:f.references,resolveAvatar:()=>{resolved++;throw Error();}});
  assert.equal(((await stale.execute({kind:'set-group-avatar',artifactRef:'art_'+'a'.repeat(48)},'1234')).outcome).code,'selection-changed');
  assert.equal(resolved,0);assert.equal(f.requests.length,0);await stale.close();f.references.close();
  const fresh=fixture(),missing=fresh.lease();
  assert.equal(((await missing.execute({kind:'set-group-avatar',artifactRef:'art_'+'a'.repeat(48)},'1234')).outcome).code,'avatar-unavailable');
  assert.equal(fresh.requests.length,0);await missing.close();fresh.references.close();
});
function publicPoll(outcome:BoundActionOutcome):Record<string,unknown>{
  assert.equal(outcome.verdict,'verified');assert.ok(outcome.poll&&typeof outcome.poll==='object'&&!Array.isArray(outcome.poll));
  const poll=outcome.poll as Record<string,unknown>;assert.equal(typeof poll.messageRef,'string');assert.match(poll.messageRef as string,/^m_[0-9a-f]{24}$/);
  function keys(value:unknown):void{if(value&&typeof value==='object'){for(const [key,child]of Object.entries(value)){assert.ok(!['messageId','pollId','chatId','peerId','accountId','authorId','recentVoters'].includes(key));keys(child);}}
    else { assert.notEqual(value,'777');assert.notEqual(value,777); }}
  keys(outcome);return poll;
}

test('poll privacy assertion accepts opaque refs containing ID digits but rejects raw fields and scalar IDs',()=>{
  const outcome:BoundActionOutcome={verdict:'verified',poll:{messageRef:'m_777'+'a'.repeat(21)}};
  assert.doesNotThrow(()=>publicPoll(outcome));
  for(const leak of [{pollId:'different'}, {unlabelled:'777'}, {unlabelled:777}])
    assert.throws(()=>publicPoll({...outcome,...leak}));
});
test('actual lease/poll transport returns opaque ref reusable across fresh inspect and close leases',async()=>{
  for(const basic of [false,true]){
    const f=fixture(basic),create=f.lease();const created=publicPoll((await create.execute({kind:'create-poll',poll:spec()},'123456')).outcome);
    const ref=created.messageRef as string;assert.equal(f.references.resolveMessage(ref),100);assert.equal(created.own,true);assert.equal(created.closed,false);await create.close();
    const inspect=f.lease(),inspected=publicPoll((await inspect.execute({kind:'read-poll',messageRef:ref},'123457')).outcome);assert.equal(inspected.messageRef,ref);assert.equal(inspected.question,'Where next?');await inspect.close();
    const close=f.lease(),closed=(await close.execute({kind:'close-poll',messageRef:ref},'123458')).outcome;assert.equal(publicPoll(closed).messageRef,ref);assert.equal(closed.change,'closed');assert.equal(publicPoll(closed).closed,true);await close.close();
    const repeat=f.lease(),already=(await repeat.execute({kind:'close-poll',messageRef:ref},'123459')).outcome;assert.equal(already.change,'already-closed');assert.equal(publicPoll(already).closed,true);await repeat.close();
    assert.equal(f.requests.filter(r=>r instanceof Api.messages.SendMedia).length,1);assert.equal(f.requests.filter(r=>r instanceof Api.messages.EditMessage).length,1);f.references.close();
  }
});
test('foreign connection refs malformed refs and evicted refs refuse without invocations',async()=>{
  for(const mode of ['foreign','evicted','raw'] as const){
    const f=fixture();let ref:string;
    if(mode==='foreign'){const other=createConversationReferences(f.input.binding);ref=other.message(100);other.close();}
    else if(mode==='evicted'){ref=f.references.message(100);for(let id=1000;id<9193;id++)f.references.message(id);assert.equal(f.references.resolveMessage(ref),undefined);}
    else ref='100';
    const lease=f.lease();assert.deepEqual((await lease.execute({kind:'read-poll',messageRef:ref},'123456')).outcome,{verdict:'refused',code:'unknown-message-reference'});assert.equal(f.requests.length,0);await lease.close();f.references.close();
  }
});
test('foreign-bound references cannot construct a lease',()=>{
  const f=fixture(),references=createConversationReferences({...f.input.binding,peerId:'-999'});
  assert.throws(()=>createBoundActionTransportLease({...f.input,references}),/BOUND_ACTION_BINDING/);assert.equal(f.requests.length,0);references.close();f.references.close();
});
test('fresh primary mismatch refuses create and close before mutation',async()=>{
  for(const kind of ['create-poll','close-poll'] as const){const f=fixture();f.seed();const ref=f.references.message(100);f.changePrimary();const lease=f.lease();
    const outcome=(await lease.execute(kind==='create-poll'?{kind,poll:spec()}:{kind,messageRef:ref},'123456')).outcome;assert.deepEqual(outcome,{verdict:'refused',code:'primary'});
    assert.equal(f.requests.some(r=>r instanceof Api.messages.SendMedia||r instanceof Api.messages.EditMessage),false);await lease.close();f.references.close();}
});
test('named foreign-author poll may be inspected but never closed by the own-poll action',async()=>{
  const f=fixture();f.seed(spec(),false);const ref=f.references.message(100),inspect=f.lease();assert.equal(publicPoll((await inspect.execute({kind:'read-poll',messageRef:ref},'123456')).outcome).own,false);await inspect.close();
  const close=f.lease();assert.deepEqual((await close.execute({kind:'close-poll',messageRef:ref},'123457')).outcome,{verdict:'refused',code:'permission'});assert.equal(f.requests.some(r=>r instanceof Api.messages.EditMessage),false);await close.close();f.references.close();
});
test('lease STOP joins actual SendMedia and blocks late result publication and duplicate execute',async()=>{
  const f=fixture(),started=gate(),finish=gate();f.override(async request=>{if(request instanceof Api.messages.SendMedia){started.done();await finish.promise;}return f.respond(request);});
  const lease=f.lease(),work=lease.execute({kind:'create-poll',poll:spec()},'123456');await started.promise;
  assert.deepEqual((await lease.execute({kind:'create-poll',poll:spec()},'123457')).outcome,{verdict:'refused',code:'stopped-or-consumed'});
  let settled=false;const closing=lease.close().then(()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);
  finish.done();const result=(await work).outcome;assert.equal(result.verdict,'unknown');assert.equal(result.code,'aborted');assert.equal(result.poll,undefined);await closing;assert.equal(settled,true);
  assert.equal(f.requests.filter(r=>r instanceof Api.messages.SendMedia).length,1);assert.equal(f.requests.some(r=>r instanceof Api.messages.GetPollResults||r instanceof Api.channels.GetMessages),false);f.references.close();
});
test('parent STOP while permission read is pending joins and prevents mutation',async()=>{
  const f=fixture(),started=gate(),finish=gate();f.override(async request=>{if(request instanceof Api.channels.GetFullChannel){started.done();await finish.promise;}return f.respond(request);});
  const lease=f.lease(),work=lease.execute({kind:'create-poll',poll:spec()},'123456');await started.promise;f.signal.abort();let settled=false;const closing=lease.close().then(()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);finish.done();assert.deepEqual((await work).outcome,{verdict:'refused',code:'aborted'});await closing;assert.equal(f.requests.some(r=>r instanceof Api.messages.SendMedia),false);f.references.close();
});

test('verified own poll evidence survives fresh references and selection for exact resolve then close',async()=>{
  for(const type of ['single','quiz'] as const){
    const f=fixture(),create=f.lease(),created=await create.execute({kind:'create-poll',poll:spec(type)},'123456');
    const evidence=created.privateObjectEvidence!;assert.equal(evidence.schema,'standing-poll-object-v1');assert.match(evidence.objectRef,/^obj_[0-9a-f]{48}$/);
    const oldRef=publicPoll(created.outcome).messageRef as string;assert.equal(publicPoll(created.outcome).objectRef,evidence.objectRef);
    assert.deepEqual(evidence.record.poll,spec(type));assert.equal(evidence.record.messageId,100);assert.equal(evidence.record.pollId,'555');
    assert.equal(JSON.stringify(created.outcome).includes('privateObjectEvidence'),false);await create.close();f.references.close();
    const restored=JSON.parse(JSON.stringify(evidence)),references=createConversationReferences(f.input.binding);
    const selected={...f.input.selected,messageId:92,text:'Read the earlier poll'};
    const next=()=>createBoundActionTransportLease({...f.input,selected,revalidatePrimary:async()=>({...selected}),references});
    assert.equal(references.resolveMessage(oldRef),undefined);
    const resolve=next(),resolved=await resolve.execute({kind:'resolve-poll-object',record:restored.record},'123457');
    const poll=publicPoll(resolved.outcome);assert.equal(poll.question,spec().question);assert.notEqual(poll.messageRef,oldRef);
    assert.equal(poll.totalVoters,3);assert.equal(resolved.privateObjectEvidence,undefined);assert.ok(Number.isSafeInteger(resolved.outcome.observedAt));await resolve.close();
    const close=next(),closed=(await close.execute({kind:'close-poll',messageRef:poll.messageRef as string},'123458')).outcome;
    assert.equal(closed.change,'closed');assert.equal(publicPoll(closed).closed,true);await close.close();
    assert.equal(f.requests.filter(r=>r instanceof Api.messages.SendMedia).length,1);assert.equal(f.requests.filter(r=>r instanceof Api.messages.EditMessage).length,1);references.close();
  }
});

test('real named runtime encrypted journal and GramJS transport recover a poll after reconnect then close without replay',async t=>{
  const f=fixture(),prefix=join(resolve(tmpdir()),'neurobro-poll-coupled-'),stateDirectory=await mkdtemp(prefix),passphrase='synthetic coupled poll lifecycle passphrase';
  const runtimes:ReturnType<typeof createStandingBoundActionRuntime>[]=[],references=[f.references];
  t.after(async()=>{for(const runtime of runtimes)await runtime.close();for(const refs of references)refs.close();
    assert.ok(resolve(stateDirectory).startsWith(prefix));await rm(stateDirectory,{recursive:true,force:true});});
  const make=()=>{const runtime=createStandingBoundActionRuntime({binding:f.input.binding,stateDirectory,passphrase,signal:f.signal.signal,killed:()=>false});runtimes.push(runtime);return runtime;};
  const caller=(runtime:ReturnType<typeof make>,requestRef:string)=>{let calls=0;return async(name:string,args:unknown)=>{
    const result=await runtime.handlers.find(h=>h.name===name)!.call(args,{requestRef,callRef:'coupled-'+ ++calls,signal:f.signal.signal}) as EpochToolResult;
    const value=JSON.parse(result.contentItems[0].text);assert.equal(result.success,value.verdict==='verified');return value;
  };};
  const first=make();first.begin({requestRef:'create-before-reconnect',primary:f.input.selected,openActions:f.lease});
  const created=await caller(first,'create-before-reconnect')('neurobro_create_poll',spec());
  const oldRef=publicPoll(created).messageRef as string;assert.equal(created.verdict,'verified');assert.equal(created.poll.totalVoters,3);
  const actionBinding={accountId:f.input.binding.accountId,chatId:f.input.binding.peerId,primaryMessageId:91,operationSlot:0};
  const terminalPath=join(stateDirectory,'action-journal',standingActionKey(actionBinding),'terminal.enc');
  const originalTerminal=await readFile(terminalPath);assert.equal(originalTerminal.includes(Buffer.from(spec().question)),false);
  const journal=await openStandingActionJournal({directory:join(stateDirectory,'action-journal'),passphrase,binding:actionBinding});
  const saved=await journal.inspect();await journal.close();assert.equal(saved.state,'verified');
  const evidence=saved.terminal!.privateObjectEvidence!;assert.equal(evidence.objectRef,created.poll.objectRef);
  assert.equal(evidence.record.messageId,100);assert.equal(evidence.record.pollId,'555');assert.equal(evidence.record.replyToMessageId,91);
  assert.deepEqual(evidence.record.poll,spec());assert.equal(evidence.record.randomId,saved.intent!.randomId);
  await first.close();f.references.close();
  const message=f.current();assert.equal(message.id,100);assert.ok(message.media instanceof Api.MessageMediaPoll);assert.equal(message.media.poll.id.toString(),'555');
  message.media.results=new Api.PollResults({totalVoters:5,results:[new Api.PollAnswerVoters({option:Buffer.from([0]),voters:2}),new Api.PollAnswerVoters({option:Buffer.from([1]),voters:3})]});
  const refs=createConversationReferences(f.input.binding);references.push(refs);assert.equal(refs.resolveMessage(oldRef),undefined);
  const selected={...f.input.selected,messageId:92,text:'Find the earlier poll and close it'},second=make();
  second.begin({requestRef:'resolve-after-reconnect',primary:selected,openActions:()=>createBoundActionTransportLease({...f.input,selected,revalidatePrimary:async()=>({...selected}),references:refs})});
  const call=caller(second,'resolve-after-reconnect'),beforeFind=f.requests.length;
  const found=await call('neurobro_find_objects',{kind:'poll',query:spec().question});
  assert.equal(found.verdict,'verified');assert.equal(found.objects.length,1);assert.equal(found.objects[0].objectRef,evidence.objectRef);
  assert.equal(found.objects[0].provenance,'verified-own-poll');assert.equal(f.requests.length,beforeFind);
  const resolved=await call('neurobro_resolve_object',{objectRef:found.objects[0].objectRef}),poll=publicPoll(resolved);
  assert.notEqual(poll.messageRef,oldRef);assert.equal(refs.resolveMessage(poll.messageRef as string),100);assert.equal(poll.totalVoters,5);
  assert.deepEqual((poll.options as {voters:number}[]).map(o=>o.voters),[2,3]);assert.ok(Number.isSafeInteger(resolved.observedAt));
  const closed=await call('neurobro_close_poll',{messageRef:poll.messageRef});assert.equal(closed.change,'closed');assert.equal(publicPoll(closed).closed,true);
  assert.equal(message.media.poll.closed,true);assert.equal(second.state().blocked,false);await second.close();refs.close();
  const publicJson=JSON.stringify({created,found,resolved,closed});
  assert.doesNotMatch(publicJson,/"(?:privateObjectEvidence|record|messageId|pollId|chatId|accountId|replyToMessageId|randomId|operationId)"/u);
  let reopenedLease=false;const replay=make();replay.begin({requestRef:'old-primary-again',primary:f.input.selected,openActions:()=>{reopenedLease=true;return f.lease();}});
  const refused=await caller(replay,'old-primary-again')('neurobro_create_poll',spec());assert.equal(refused.verdict,'refused');assert.equal(reopenedLease,false);
  assert.equal(replay.state().blocked,true);await replay.close();assert.deepEqual(await readFile(terminalPath),originalTerminal);
  assert.equal(f.requests.filter(r=>r instanceof Api.messages.SendMedia).length,1);assert.equal(f.requests.filter(r=>r instanceof Api.messages.EditMessage).length,1);
});

test('persisted poll resolver refuses foreign, unavailable and changed exact identities without mutation',async()=>{
  for(const mode of ['account','chat','foreign-author','poll-id','question','option-bytes','anchor','timer','deleted','unavailable','primary'] as const){
    const f=fixture(),create=f.lease(),created=await create.execute({kind:'create-poll',poll:spec()},'123456');await create.close();
    let record=created.privateObjectEvidence!.record;const message=f.current();assert.ok(message.media instanceof Api.MessageMediaPoll);
    if(mode==='account')record={...record,accountId:'888'};
    if(mode==='chat')record={...record,chatId:'-999'};
    if(mode==='foreign-author'){message.fromId=new Api.PeerUser({userId:bigInt(456)});message.out=false;}
    if(mode==='poll-id')message.media.poll.id=bigInt(556);
    if(mode==='question')message.media.poll.question=text('Another poll');
    if(mode==='option-bytes'){message.media.poll.answers[0]!.option=Buffer.from([9]);message.media.results.results![0]!.option=Buffer.from([9]);}
    if(mode==='anchor')message.replyTo=new Api.MessageReplyHeader({replyToMsgId:90});
    if(mode==='timer')message.media.poll.closeDate=200;
    if(mode==='deleted')f.override(async r=>r instanceof Api.channels.GetMessages?wire(new Api.messages.Messages({messages:[new Api.MessageEmpty({id:100})],users:[],chats:[]})):f.respond(r));
    if(mode==='unavailable')f.override(async()=>{throw Error('private transport details');});
    if(mode==='primary')f.changePrimary();
    const before=f.requests.length,resolve=f.lease(),result=await resolve.execute({kind:'resolve-poll-object',record},'123457');
    const code=['account','chat','foreign-author'].includes(mode)?'permission':mode==='deleted'?'not-available':mode==='unavailable'?'transport':mode==='primary'?'primary':'definition-changed';
    assert.deepEqual(result,{outcome:{verdict:'refused',code}},mode);
    if(mode==='account'||mode==='chat'||mode==='primary')assert.equal(f.requests.length,before);
    assert.equal(f.requests.slice(before).some(r=>r instanceof Api.messages.SendMedia||r instanceof Api.messages.EditMessage),false);await resolve.close();f.references.close();
  }
});

test('STOP during persisted poll resolution joins exact read and cannot publish late refs',async()=>{
  const f=fixture(),create=f.lease(),created=await create.execute({kind:'create-poll',poll:spec()},'123456');await create.close();
  const started=gate(),finish=gate();f.override(async r=>{if(r instanceof Api.channels.GetMessages){started.done();await finish.promise;}return f.respond(r);});
  const resolve=f.lease(),work=resolve.execute({kind:'resolve-poll-object',record:created.privateObjectEvidence!.record},'123457');await started.promise;
  let joined=false;const closing=resolve.close().then(()=>{joined=true;});await new Promise<void>(r=>setImmediate(r));assert.equal(joined,false);finish.done();
  assert.deepEqual(await work,{outcome:{verdict:'refused',code:'aborted'}});await closing;assert.equal(joined,true);f.references.close();
});

test('persisted resolve snapshots host record before I/O and preserves unknown counts without guessing',async()=>{
  const f=fixture(),create=f.lease(),created=await create.execute({kind:'create-poll',poll:spec()},'123456');await create.close();
  const record=JSON.parse(JSON.stringify(created.privateObjectEvidence!.record));
  f.override(async r=>r instanceof Api.messages.GetPollResults?wire(f.batch([new Api.UpdateMessagePoll({pollId:bigInt(555),results:new Api.PollResults({min:true})})])):f.respond(r));
  const resolve=f.lease(),work=resolve.execute({kind:'resolve-poll-object',record},'123457');record.messageId=999;record.poll.question='changed';record.poll.options.length=0;
  const poll=publicPoll((await work).outcome);assert.equal(poll.totalVoters,null);assert.equal((poll.coverage as {complete:boolean}).complete,false);await resolve.close();
  let accesses=0;const accessor=JSON.parse(JSON.stringify(created.privateObjectEvidence!.record));Object.defineProperty(accessor,'poll',{get(){accesses++;return spec();},enumerable:true});
  const invalid=f.lease(),before=f.requests.length;assert.deepEqual(await invalid.execute({kind:'resolve-poll-object',record:accessor},'123458'),{outcome:{verdict:'refused',code:'input'}});
  assert.equal(accesses,0);assert.equal(f.requests.length,before);await invalid.close();f.references.close();
});
