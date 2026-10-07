import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TdlibTelegram, FileTelegramStore, JsonProcessTransport, parseTdJson, stringifyTdJson, TdRequestError, validateTdObject } from '../../src/telegram/index.ts';
import type { TdObject, TdJsonTransport, TelegramReceipt, TelegramReceiptStore } from '../../src/telegram/index.ts';
import type { Effect,Json,Observation } from '../../src/contracts.ts';
import { effectRequest,readRequest } from '../../src/telegram/requests.ts';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
class Store implements TelegramReceiptStore { rows=new Map<string,TelegramReceipt>();async get(id:string){return this.rows.get(id);}async put(r:TelegramReceipt){this.rows.set(r.effectId,r);}async findMessage(p:string,id:string){return[...this.rows.values()].find(r=>r.peerId===p&&(r.tempMessageId===id||r.messageId===id));}async findSending(id:number){return[...this.rows.values()].find(r=>r.sendingId===id);} }
class Fake extends EventEmitter implements TdJsonTransport { calls:TdObject[]=[];handle:(v:TdObject)=>Promise<TdObject>=async()=>({'@type':'ok'});async invoke(v:TdObject){if(v['@type']==='getMe')return{'@type':'user',id:'42'};this.calls.push(v);return this.handle(v);}async close(){} }
const message=(id='100',text='/бро привет'):TdObject=>({'@type':'message',id,chat_id:'-100123',sender_id:{'@type':'messageSenderUser',user_id:'42'},is_outgoing:true,date:100,edit_date:0,content:{'@type':'messageText',text:{'@type':'formattedText',text,entities:[]}},reply_to:{'@type':'messageReplyToMessage',chat_id:'-100123',message_id:'88'},can_be_saved:true});
const effect=(id='e'):Effect=>({id,taskId:'t',intentRevision:1,grantId:'g',grantRevision:1,capability:'telegram.send',resource:'-100123',payload:{peerId:'-100123',text:'Нейробро · ответ'},payloadHash:'h',state:'dispatching',createdAt:'2026-10-04',updatedAt:'2026-10-04'});
test('lossless wire integers and pinned field validation',()=>{const parsed=parseTdJson('{"@type":"message","id":9223372036854775807,"chat_id":-100123}');assert.equal(parsed.id,'9223372036854775807');assert.match(stringifyTdJson({'@type':'getMessage',message_id:'9007199254740991',chat_id:'-100123'}),/"message_id":9007199254740991/);assert.throws(()=>validateTdObject({'@type':'sendMessage',message_thread_id:1}),/absent/);assert.throws(()=>validateTdObject({'@type':'getMessage',message_id:9007199254740992}),/lossy/);});
test('owner outgoing, forwarded flags, edits and permanent delete preserve exact identity',async()=>{const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()});const abort=new AbortController(),stream=port.observations(abort.signal)[Symbol.asyncIterator]();transport.emit('update',{'@type':'updateNewMessage',message:{...message(),forward_info:{origin:{}},via_bot_user_id:12}});const first=(await stream.next()).value!;assert.equal(first.authorId,'42');assert.equal(first.outgoing,true);assert.equal(first.forwarded,true);assert.equal(first.viaBot,true);assert.equal(first.replyTo?.messageId,'88');transport.emit('update',{'@type':'updateMessageContent',chat_id:'-100123',message_id:'100',new_content:message('100','edited').content});const edited=(await stream.next()).value!;assert.equal(edited.kind,'edit');assert.notEqual(edited.version,first.version);transport.emit('update',{'@type':'updateDeleteMessages',chat_id:'-100123',message_ids:['100'],is_permanent:true,from_cache:false});const deleted=(await stream.next()).value!;assert.equal(deleted.kind,'delete');assert.equal(deleted.authorId,'42');assert.equal(deleted.outgoing,true);abort.abort();await stream.return?.();await port.close();});
test('native temp send is not delivery; restart reconciles final bound update without duplicate',async()=>{const store=new Store(),transport=new Fake();transport.handle=async v=>v['@type']==='sendMessage'?{...message('-1','Нейробро · ответ'),sending_state:{'@type':'messageSendingStatePending',sending_id:v.options.sending_id}}:message('900','Нейробро · ответ');const port=new TdlibTelegram({accountId:'42',transport,receipts:store});const pending=await port.dispatch(effect());assert.equal(pending.state,'unknown');assert.equal(pending.receipt&&typeof pending.receipt==='object'&&!Array.isArray(pending.receipt)?pending.receipt.tempMessageId:undefined,'-1');transport.emit('update',{'@type':'updateMessageSendSucceeded',old_message_id:'-1',message:message('900','Нейробро · ответ')});assert.equal((await port.reconcile(effect())).state,'verified');assert.equal((await port.dispatch(effect())).state,'verified');assert.equal(transport.calls.filter(v=>v['@type']==='sendMessage').length,1);await port.close();});
test('send success arriving before request response is retained and correlated',async()=>{const store=new Store(),transport=new Fake();transport.handle=async v=>{if(v['@type']==='sendMessage'){transport.emit('update',{'@type':'updateMessageSendSucceeded',old_message_id:'-7',message:message('907','Нейробро · ответ')});return{...message('-7','Нейробро · ответ'),sending_state:{'@type':'messageSendingStatePending'}};}return message('907','Нейробро · ответ');};const port=new TdlibTelegram({accountId:'42',transport,receipts:store});assert.equal((await port.dispatch(effect())).state,'verified');await port.close();});
test('unknown send and forged peer never cause a blind retry',async()=>{const transport=new Fake();transport.handle=async()=>{throw new TdRequestError('lost',true);};const port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()});assert.equal((await port.dispatch(effect())).state,'unknown');assert.equal((await port.dispatch(effect())).state,'unknown');assert.equal(transport.calls.length,1);await assert.rejects(port.dispatch({...effect('forged'),payload:{tdlib:{'@type':'sendMessage',chat_id:'-100999',input_message_content:{'@type':'inputMessageText',text:{'@type':'formattedText',text:'oops'}}}}}),/raw TDLib/);await assert.rejects(port.dispatch({...effect('badpeer'),payload:{peerId:'-100999',text:'x'}}),/peer mismatch/);await port.close();});
test('protected media not issued as downloadable and stale token must recheck source',async()=>{const transport=new Fake();transport.handle=async()=>({...message(),can_be_saved:false,content:{'@type':'messageDocument',document:{file_name:'private.txt',mime_type:'text/plain',document:{'@type':'file',id:1,size:3}}}});const port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()});const ref={accountId:'42',peerId:'-100123',messageId:'100'};assert.equal((await port.getMessage(ref))?.attachments,undefined);await assert.rejects(port.download({id:'1',name:'x',mimeType:'text/plain',transportRef:'forged'},'ignored'),/unbound/);await port.close();});
test('encrypted durable journal survives cold reopen and rejects torn data',async()=>{const directory=await mkdtemp(join(tmpdir(),'neurobro-telegram-')),key=Buffer.alloc(32,7);const store=new FileTelegramStore(directory,key);await store.put({effectId:'secret-effect',payloadHash:'h',capability:'telegram.send',peerId:'-100123',state:'unknown'});await store.append({id:'secret-command',kind:'message',ref:{accountId:'42',peerId:'-100123',messageId:'100'},outgoing:true,text:'private text',sentAt:'now',observedAt:'now'});const raw=await readFile(join(directory,'telegram.enc.jsonl'),'utf8');assert.doesNotMatch(raw,/private text|secret-effect/);assert.equal((await new FileTelegramStore(directory,key).get('secret-effect'))?.state,'unknown');await writeFile(join(directory,'telegram.enc.jsonl'),raw+'{"torn":');await assert.rejects(new FileTelegramStore(directory,key).get('secret-effect'),/torn/);});
test('real supervised child correlates out of order requests, timeout then late update, closes',async(t)=>{const childPath=new URL('./fixture-sidecar.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');const transport=new JsonProcessTransport({command:process.execPath,args:[childPath],requestTimeoutMs:40,closeTimeoutMs:2000});t.after(()=>transport.close().catch(()=>{}));let update:TdObject|undefined;transport.on('update',v=>update=v);const lateUpdate=once(transport,'update',{signal:AbortSignal.timeout(30000)});transport.start();await transport.waitReady();const [a,b]=await Promise.all([transport.invoke({'@type':'fast',value:'one'},{timeoutMs:1000}),transport.invoke({'@type':'fast',value:'two'},{timeoutMs:1000})]);assert.equal(a.value,'one');assert.equal(b.value,'two');await assert.rejects(transport.invoke({'@type':'slow'}),/uncertain/);await lateUpdate;assert.equal(update?.['@type'],'updateConnectionState');await transport.close();});
test('late initial send response cannot erase matched final receipt',async()=>{const store=new Store(),transport=new Fake();let release:(v:TdObject)=>void=()=>{};transport.handle=async v=>{if(v['@type']==='sendMessage'){queueMicrotask(()=>{transport.emit('update',{'@type':'updateNewMessage',message:{...message('-5','Нейробро · ответ'),sending_state:{'@type':'messageSendingStatePending',sending_id:v.options.sending_id}}});transport.emit('update',{'@type':'updateMessageSendSucceeded',old_message_id:'-5',message:message('905','Нейробро · ответ')});});return new Promise(resolve=>release=resolve);}return message('905','Нейробро · ответ');};const port=new TdlibTelegram({accountId:'42',transport,receipts:store});const pending=port.dispatch(effect());while((await store.get('e'))?.messageId!=='905')await new Promise(resolve=>setImmediate(resolve));release({...message('-5','Нейробро · ответ'),sending_state:{'@type':'messageSendingStatePending'}});assert.equal((await pending).state,'verified');assert.equal((await store.get('e'))?.messageId,'905');await port.close();});

test('predispatch sending identity tags early echo while owner identical text stays owner data',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'neurobro-early-echo-')),store=new FileTelegramStore(directory,Buffer.alloc(32,12)),transport=new Fake();
  let release!:(value:TdObject)=>void;
  transport.handle=async request=>{if(request['@type']==='sendMessage'){
    assert.equal((await store.get('e'))?.sendingId,request.options.sending_id);
    transport.emit('update',{'@type':'updateNewMessage',message:{...message('-5','Нейробро · ответ'),sending_state:{'@type':'messageSendingStatePending',sending_id:request.options.sending_id}}});
    return new Promise(resolve=>{release=resolve;});
  }return message('905','Нейробро · ответ');};
  const port=new TdlibTelegram({accountId:'42',transport,receipts:store,spool:store}),abort=new AbortController(),stream=port.observations(abort.signal)[Symbol.asyncIterator]();
  try{
    const dispatch=port.dispatch(effect());const echo=(await stream.next()).value!;assert.equal(echo.agentEffectId,'e');assert.equal(echo.ref.messageId,'-5');
    transport.emit('update',{'@type':'updateMessageSendSucceeded',old_message_id:'-5',message:message('905','Нейробро · ответ')});
    const terminal=(await stream.next()).value!;assert.equal(terminal.agentEffectId,'e');
    release({...message('-5','Нейробро · ответ'),sending_state:{'@type':'messageSendingStatePending'}});assert.equal((await dispatch).state,'verified');
    transport.emit('update',{'@type':'updateNewMessage',message:message('906','Нейробро · ответ')});
    const owner=(await stream.next()).value!;assert.equal(owner.ref.messageId,'906');assert.equal(owner.agentEffectId,undefined);assert.equal(port.status().attributionHeld,0);
  }finally{abort.abort();await stream.return?.();await port.close();}
});

test('mapped native receipt survives actual cold reopen and tags edited output by identity',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'neurobro-mapped-echo-')),key=Buffer.alloc(32,13),before=new FileTelegramStore(directory,key);
  await before.put({effectId:'e',payloadHash:'h',capability:'telegram.send',peerId:'-100123',state:'unknown',sendingId:123,tempMessageId:'-5',messageId:'905'});
  const store=new FileTelegramStore(directory,key),transport=new Fake();transport.handle=async()=>message('905','owner edited the assistant message');
  const port=new TdlibTelegram({accountId:'42',transport,receipts:store,spool:store}),abort=new AbortController(),stream=port.observations(abort.signal)[Symbol.asyncIterator]();
  try{
    transport.emit('update',{'@type':'updateMessageEdited',chat_id:'-100123',message_id:'905',edit_date:200});
    const edited=(await stream.next()).value!;assert.equal(edited.agentEffectId,'e');assert.equal(edited.kind,'edit');assert.equal(edited.text,'owner edited the assistant message');
    transport.emit('update',{'@type':'updateNewMessage',message:message('906','owner edited the assistant message')});
    assert.equal((await stream.next()).value?.agentEffectId,undefined);assert.equal(transport.calls.filter(r=>r['@type']==='sendMessage').length,0);
  }finally{abort.abort();await stream.return?.();await port.close();}
});

test('mutation receipt cannot turn original owner source into assistant output',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'neurobro-mutation-source-')),store=new FileTelegramStore(directory,Buffer.alloc(32,15)),transport=new Fake();
  await store.put({effectId:'reaction',payloadHash:'h',capability:'telegram.reaction.set',peerId:'-100123',state:'verified',messageId:'906'});
  await store.put({effectId:'edit',payloadHash:'h2',capability:'telegram.message.edit',peerId:'-100123',state:'verified',messageId:'907'});
  const port=new TdlibTelegram({accountId:'42',transport,receipts:store,spool:store}),abort=new AbortController(),stream=port.observations(abort.signal)[Symbol.asyncIterator]();
  try{for(const id of ['906','907']){transport.emit('update',{'@type':'updateNewMessage',message:message(id,'owner command')});assert.equal((await stream.next()).value?.agentEffectId,undefined);}}finally{abort.abort();await stream.return?.();await port.close();}
});

test('unmapped cold send durably withholds only ambiguous outgoing exact peer until native reconciliation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'neurobro-unmapped-echo-')),key=Buffer.alloc(32,14),before=new FileTelegramStore(directory,key);
  await before.put({effectId:'e',payloadHash:'h',capability:'telegram.send',peerId:'-100123',state:'unknown',sendingId:123});
  await before.put({effectId:'known',payloadHash:'h2',capability:'telegram.send',peerId:'-100123',state:'verified',messageId:'910'});
  const store=new FileTelegramStore(directory,key),transport=new Fake();transport.handle=async()=>message('905','ambiguous command');
  let port=new TdlibTelegram({accountId:'42',transport,receipts:store,spool:store});
  transport.emit('update',{'@type':'updateNewMessage',message:message('905','ambiguous command')});
  transport.emit('update',{'@type':'updateNewMessage',message:message('906','owner instruction')});
  transport.emit('update',{'@type':'updateNewMessage',message:{...message('907','incoming'),is_outgoing:false,sender_id:{'@type':'messageSenderUser',user_id:'99'}}});
  transport.emit('update',{'@type':'updateNewMessage',message:{...message('908','other peer'),chat_id:'-100999'}});
  transport.emit('update',{'@type':'updateNewMessage',message:message('910','known assistant')});
  await port.reconcile(effect());assert.equal(port.status().attributionHeld,2);assert.equal(port.status().buffered,3);assert.equal(port.status().coverage,'gap');assert.match(port.status().attributionDiagnostic!,/unresolved send/);
  assert.deepEqual((await store.pending(20)).map(o=>o.ref.messageId),['907','908','910']);assert.deepEqual((await store.heldAttribution()).map(o=>o.ref.messageId),['905','906']);await port.close();
  const reopened=new FileTelegramStore(directory,key),nextTransport=new Fake();nextTransport.handle=async()=>message('905','ambiguous command');
  port=new TdlibTelegram({accountId:'42',transport:nextTransport,receipts:reopened,spool:reopened});const abort=new AbortController(),stream=port.observations(abort.signal)[Symbol.asyncIterator]();
  try{
    const incoming=(await stream.next()).value!;assert.equal(incoming.ref.messageId,'907');assert.equal(incoming.agentEffectId,undefined);
    assert.equal((await stream.next()).value?.ref.messageId,'908');assert.equal((await stream.next()).value?.agentEffectId,'known');assert.equal(port.status().attributionHeld,2);
    // Operator/native reconciliation supplies identity; it never infers it from content or retries.
    await reopened.put({effectId:'e',payloadHash:'h',capability:'telegram.send',peerId:'-100123',state:'unknown',sendingId:123,tempMessageId:'-5'});
    nextTransport.emit('update',{'@type':'updateMessageSendSucceeded',old_message_id:'-5',message:message('905','ambiguous command')});await port.reconcile(effect());
    const released:Observation[]=[];for(let i=0;i<3;i++)released.push((await stream.next()).value!);
    assert.equal(released.find(o=>o.ref.messageId==='905')?.agentEffectId,'e');assert.equal(released.find(o=>o.ref.messageId==='906')?.agentEffectId,undefined);
    assert.equal(port.status().attributionHeld,0);assert.deepEqual(await new FileTelegramStore(directory,key).heldAttribution(),[]);assert.equal(nextTransport.calls.filter(r=>r['@type']==='sendMessage').length,0);
  }finally{abort.abort();await stream.return?.();await port.close();}
});
test('all host request families match pinned official schema constructor types',()=>{const fixtures:[string,TdObject][]=[['telegram.message.send',{text:'hi',replyToMessageId:'1',threadId:'2'}],['telegram.message.edit',{text:'edit',messageId:'3'}],['telegram.message.delete',{messageIds:['3']}],['telegram.poll.create',{question:'why',options:['a','b'],quiz:true,correctOption:0}],['telegram.poll.vote',{messageId:'3',optionIds:[0]}],['telegram.poll.stop',{messageId:'3'}],['telegram.reaction.set',{messageId:'3',emoji:'👍'}],['telegram.profile.update',{bio:'hi'}],['telegram.profile.avatar',{path:'fixture.png'}],['telegram.bot.click',{messageId:'3',data:'AQ=='}],['telegram.schedule.create',{text:'hi',sendAt:123}],['telegram.schedule.edit',{messageId:'3',sendAt:123}],['telegram.source.join',{}]];for(const mediaType of ['photo','video','document','audio','voice','animation','sticker','videoNote'])fixtures.push(['telegram.media.send',{mediaType,path:'fixture.bin',caption:'hi',length:384}]);for(const[cap,args]of fixtures)assert.doesNotThrow(()=>validateTdObject(effectRequest(cap,'42',args)),cap);assert.throws(()=>validateTdObject({'@type':'inputMessagePhoto',photo:{'@type':'inputFileLocal',path:'x'}}),/type mismatch/);for(const cap of ['telegram.history.read','telegram.search','telegram.context.read','telegram.poll.results','telegram.participants.read','telegram.profile.read','telegram.bot.buttons','telegram.scheduled.list','telegram.source.discover'])assert.doesNotThrow(()=>validateTdObject(readRequest(cap,'42',{messageId:'1',query:'x',supergroupId:'50'})),cap);});
test('account mismatch blocks observations and dispatch before effect prepare',async()=>{const transport=new Fake();transport.invoke=async()=>({'@type':'user',id:'999'});const store=new Store(),port=new TdlibTelegram({accountId:'42',transport,receipts:store});await assert.rejects(port.dispatch(effect()),/account does not match/);assert.equal(store.rows.size,0);const abort=new AbortController();await assert.rejects(port.observations(abort.signal)[Symbol.asyncIterator]().next(),/account does not match/);await port.close();});
test('encrypted observation spool replays only until explicit durable admission acknowledgement',async()=>{const directory=await mkdtemp(join(tmpdir(),'neurobro-spool-')),key=Buffer.alloc(32,9),store=new FileTelegramStore(directory,key);const original={id:'replay-me',kind:'message' as const,ref:{accountId:'42',peerId:'-100123',messageId:'100'},outgoing:true,text:'/бро replay',sentAt:'now',observedAt:'now'};await store.append(original);const port=new TdlibTelegram({accountId:'42',transport:new Fake(),receipts:store,spool:store});const abort=new AbortController(),stream=port.observations(abort.signal)[Symbol.asyncIterator]();assert.equal((await stream.next()).value?.id,'replay-me');await port.acknowledgeObservation('replay-me');assert.deepEqual(await new FileTelegramStore(directory,key).pending(10),[]);abort.abort();await stream.return?.();await port.close();});
test('actual Python sidecar protocol runs against fake ABI; no native library or auth', {skip:!process.env.NEUROBRO_TEST_PYTHON},async(t)=>{
  const fixture=fileURLToPath(new URL('./fixture-tdjson.py',import.meta.url));const hash=createHash('sha256').update(await readFile(fixture)).digest('hex');
  const transport=new JsonProcessTransport({command:process.env.NEUROBRO_TEST_PYTHON!,args:[fixture,'--library',fixture,'--expected-sha256',hash,'--close-timeout-seconds','1'],requestTimeoutMs:3000,closeTimeoutMs:2000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  const started=performance.now(),phases:{state:string;afterMs:number}[]=[];transport.on('status',s=>phases.push({state:s.state,afterMs:Math.round(performance.now()-started)}));
  transport.start();let failure:unknown;
  try{
    await transport.waitReady();
    const response=await transport.invoke({'@type':'getMessage',chat_id:'-100123',message_id:'9007199254740991'});
    assert.equal(response.id,9007199254740991);assert.equal(response.media_album_id,'9223372036854775807');assert.equal(response.content.text.text,'Привет 😀');
  }catch(error){failure=error;}
  try{await transport.close();}catch(error){failure=failure?new AggregateError([failure,error],'fake ABI operation and cleanup both failed'):error;}
  if(failure){t.diagnostic(JSON.stringify({phases,elapsedMs:Math.round(performance.now()-started)}));throw failure;}
});
test('correct message IDs cannot verify mismatched media caption/type or poll semantics',async()=>{const payloads:Record<string,Json>[]=[{mediaType:'photo',path:'image.png',caption:'wanted'},{question:'wanted question',options:['yes','no']}];for(const payload of payloads){const store=new Store(),transport=new Fake(),capability='mediaType'in payload?'telegram.media.send':'telegram.poll.create';const e={...effect(),capability,payload};await store.put({effectId:'e',payloadHash:'h',capability,peerId:'-100123',state:'pending',messageId:'900'});transport.handle=async()=>message('900','different content');const port=new TdlibTelegram({accountId:'42',transport,receipts:store});assert.equal((await port.reconcile(e)).state,'unknown');await port.close();}});
test('fresh bot callback selects markup and rejects changed version or dangerous button type',async()=>{const transport=new Fake(),store=new Store();let current={...message(),reply_markup:{'@type':'replyMarkupInlineKeyboard',rows:[[{text:'button',type:{'@type':'inlineKeyboardButtonTypeCallback',data:'AQ=='}}]]}};transport.handle=async v=>v['@type']==='getMessage'?current:{'@type':'callbackQueryAnswer',text:'accepted'};const port=new TdlibTelegram({accountId:'42',transport,receipts:store}),ref={accountId:'42',peerId:'-100123',messageId:'100'},version=(await port.getMessage(ref))!.version!;const e={...effect(),capability:'telegram.bot.click',payload:{messageId:'100',row:0,column:0,expectedVersion:version}};await port.dispatch(e);assert.equal(transport.calls.find(v=>v['@type']==='getCallbackQueryAnswer')?.payload.data,'AQ==');current={...current,reply_markup:{...current.reply_markup,rows:[[{text:'login',type:{'@type':'inlineKeyboardButtonTypeLoginUrl',data:''}}]]}};await assert.rejects(port.dispatch({...e,id:'changed'}),/target changed/);assert.equal(transport.calls.filter(v=>v['@type']==='getCallbackQueryAnswer').length,1);await port.close();});
test('post-dispatch cancellation preserves late updates; pre-dispatch cancelled request never writes',async(t)=>{const childPath=fileURLToPath(new URL('./fixture-sidecar.mjs',import.meta.url));const transport=new JsonProcessTransport({command:process.execPath,args:[childPath],requestTimeoutMs:1000,closeTimeoutMs:2000});t.after(()=>transport.close().catch(()=>{}));transport.start();await transport.waitReady();await transport.invoke({'@type':'fast'});let seen=false;transport.on('update',()=>seen=true);const lateUpdate=once(transport,'update',{signal:AbortSignal.timeout(30000)});const before=new AbortController();before.abort();await assert.rejects(transport.invoke({'@type':'slow'},{signal:before.signal}),e=>e instanceof TdRequestError&&!e.dispatched);const after=new AbortController(),pending=transport.invoke({'@type':'slow'},{signal:after.signal});after.abort();await assert.rejects(pending,e=>e instanceof TdRequestError&&e.dispatched);await lateUpdate;assert.equal(seen,true);await transport.close();});
test('participant reads resolve group identity and cannot substitute foreign IDs',async()=>{const transport=new Fake();transport.handle=async v=>v['@type']==='getChat'?{'@type':'chat',id:'-100123',type:{'@type':'chatTypeSupergroup',supergroup_id:'123'}}:{'@type':'chatMembers',members:[]};const port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()});await port.readCapability('telegram.participants.read',{peerId:'-100123',query:'alice'});assert.equal(transport.calls.find(v=>v['@type']==='getSupergroupMembers')?.supergroup_id,'123');assert.equal(transport.calls.find(v=>v['@type']==='getSupergroupMembers')?.filter.query,'alice');await assert.rejects(port.readCapability('telegram.participants.read',{peerId:'-100123',supergroupId:'999'}),/trusted Telegram host/);await assert.rejects(port.readCapability('telegram.profile.read',{peerId:'42',userId:'999'}),/escaped resource/);await port.close();});
test('malformed sidecar frame then immediate close retains cause without unhandled EPIPE',async()=>{
  const childPath=fileURLToPath(new URL('./fixture-sidecar.mjs',import.meta.url));
  const transport=new JsonProcessTransport({command:process.execPath,args:[childPath],requestTimeoutMs:1000,closeTimeoutMs:1000});
  const faults:Error[]=[];transport.on('fault',e=>faults.push(e));transport.start();
  await assert.rejects(transport.invoke({'@type':'malformed'}),e=>e instanceof TdRequestError&&e.dispatched&&e.message==='invalid sidecar frame');
  const closing=transport.close();assert.equal(transport.close(),closing,'concurrent close joins same actual settlement');
  await assert.rejects(closing,/invalid sidecar frame; TDLib authorization closure unverified/);
  await assert.rejects(transport.invoke({'@type':'fast'}),e=>e instanceof TdRequestError&&!e.dispatched&&e.message==='invalid sidecar frame');
  assert.equal(faults.length,1,'later exit/pipe errors cannot replace or duplicate the original fault');
  await new Promise(resolve=>setImmediate(resolve)); // stream errors are delivered without becoming uncaught errors
});
test('native readiness has separate pre-dispatch deadline and cancellation from RPC processing',async(t)=>{
  const childPath=fileURLToPath(new URL('./fixture-sidecar.mjs',import.meta.url));
  const transport=new JsonProcessTransport({command:process.execPath,args:[childPath,'--ready-delay=150'],requestTimeoutMs:40,closeTimeoutMs:1000});
  t.after(()=>transport.close().catch(()=>{}));
  transport.start();
  await assert.rejects(transport.waitReady(5),e=>e instanceof TdRequestError&&!e.dispatched&&/startup timeout/.test(e.message));
  const abort=new AbortController(),cancelled=transport.waitReady(1000,abort.signal);abort.abort();
  await assert.rejects(cancelled,e=>e instanceof TdRequestError&&!e.dispatched&&/startup cancelled/.test(e.message));
  await transport.waitReady();
  // Startup cancellation/deadline is tested above; this read uses its own RPC
  // deadline, so host scheduling does not become an accidental 40ms speed test.
  assert.equal((await transport.invoke({'@type':'fast',value:'after-ready'},{timeoutMs:1000})).value,'after-ready');
  await transport.close();
});
test('exit notification does not discard final native closure frame before stdout closes',async()=>{
  const transport=new JsonProcessTransport({command:process.execPath,args:[fileURLToPath(new URL('./fixture-sidecar.mjs',import.meta.url)),'--late-close-frame'],closeTimeoutMs:2000});
  transport.start();await transport.waitReady();await transport.invoke({'@type':'fast'});
  const observed:string[]=[];transport.on('fault',()=>observed.push('exit'));transport.on('update',v=>{if(v.authorization_state?.['@type']==='authorizationStateClosed')observed.push('auth-closed');});
  // Deterministically place the exit notification before draining the actual
  // child pipe, the ordering explicitly permitted by Node's child_process API.
  // The fixture keeps its pipe alive long enough to exercise the real reader.
  const child=Reflect.get(transport,'child');child.emit('exit',0,null);
  await transport.close();assert.deepEqual(observed,['exit','auth-closed']);
});
