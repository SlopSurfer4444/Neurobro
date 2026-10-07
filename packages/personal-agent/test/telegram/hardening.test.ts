import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TdlibTelegram, TdRequestError, validateTdObject, type TdObject, type TdJsonTransport, type TelegramReceipt, type TelegramReceiptStore } from '../../src/telegram/index.ts';
import { effectRequest } from '../../src/telegram/requests.ts';
import type { Effect } from '../../src/contracts.ts';

class Store implements TelegramReceiptStore {
  rows=new Map<string,TelegramReceipt>();
  async get(id:string){return this.rows.get(id);}
  async put(value:TelegramReceipt){this.rows.set(value.effectId,value);}
  async findMessage(peer:string,id:string){return [...this.rows.values()].find(value=>value.peerId===peer&&(value.messageId===id||value.tempMessageId===id));}
  async findSending(id:number){return [...this.rows.values()].find(value=>value.sendingId===id);}
}
class Fake extends EventEmitter implements TdJsonTransport {
  calls:TdObject[]=[];
  current:TdObject=message();
  handle:(request:TdObject)=>Promise<TdObject>=async()=>structuredClone(this.current);
  async invoke(request:TdObject){if(request['@type']==='getMe')return{'@type':'user',id:'42'};this.calls.push(request);return this.handle(request);}
  async close(){}
}
const message=():TdObject=>({'@type':'message',id:'900',chat_id:'12',date:10,is_outgoing:true,sender_id:{'@type':'messageSenderUser',user_id:'42'},content:{'@type':'messageText',text:{text:'wanted'}}});
const effect=(capability='telegram.send',payload:TdObject={text:'wanted'}):Effect=>({id:'e',taskId:'t',intentRevision:1,grantId:'g',grantRevision:1,capability,resource:'12',payload,payloadHash:'h',state:'dispatching',createdAt:'now',updatedAt:'now'});

test('integer vector items obey the exact pinned scalar range',()=>{
  for(const value of ['2147483648','-2147483649'])assert.throws(()=>validateTdObject({'@type':'setPollAnswer',chat_id:'12',message_id:'900',option_ids:[value]}),/out of range option_ids/);
  for(const value of ['9223372036854775808','-9223372036854775809'])assert.throws(()=>validateTdObject({'@type':'viewTrendingStickerSets',sticker_set_ids:[value]}),/out of range sticker_set_ids/);
  assert.throws(()=>validateTdObject({'@type':'deleteMessages',chat_id:'12',message_ids:['9007199254740992'],revoke:true}),/out of range message_ids/);
  assert.doesNotThrow(()=>validateTdObject({'@type':'setPollAnswer',chat_id:'12',message_id:'900',option_ids:['2147483647','-2147483648']}));
});

test('document profile retains file presentation even when bytes resemble another media type',()=>{
  const request=effectRequest('telegram.media.send','12',{mediaType:'document',path:'photo.jpg'});
  assert.equal(request.input_message_content.document.disable_content_type_detection,true);
  validateTdObject(request);
});

test('live interaction update replaces cached reactions and changes the source version',async()=>{
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()}),abort=new AbortController(),stream=port.observations(abort.signal)[Symbol.asyncIterator]();
  try{
    transport.emit('update',{'@type':'updateNewMessage',message:message()});const first=(await stream.next()).value!;
    transport.emit('update',{'@type':'updateMessageInteractionInfo',chat_id:'12',message_id:'900',interaction_info:{reactions:{reactions:[{type:{'@type':'reactionTypeEmoji',emoji:'👍'},total_count:2,is_chosen:true}]}}});
    const edited=(await stream.next()).value!;assert.equal(edited.kind,'edit');assert.notEqual(edited.version,first.version);assert.deepEqual(edited.messageDetails?.reactions,[{type:'emoji',emoji:'👍',count:2,chosen:true}]);
    transport.emit('update',{'@type':'updateMessageInteractionInfo',chat_id:'12',message_id:'900',interaction_info:null});assert.equal((await stream.next()).value?.messageDetails,undefined);
  }finally{abort.abort();await stream.return?.();await port.close();}
});

test('late pending native update cannot regress terminal receipt or cross-bind another peer',async()=>{
  const transport=new Fake(),store=new Store(),port=new TdlibTelegram({accountId:'42',transport,receipts:store});
  const original:TelegramReceipt={effectId:'e',payloadHash:'h',capability:'telegram.send',peerId:'12',sendingId:123,tempMessageId:'-5',messageId:'900',state:'verified'};
  await store.put(original);
  try{
    transport.emit('update',{'@type':'updateNewMessage',message:{...message(),id:'-5',sending_state:{'@type':'messageSendingStatePending',sending_id:123}}});
    transport.emit('update',{'@type':'updateMessageSendFailed',message:{...message(),id:'-5',sending_state:{'@type':'messageSendingStateFailed',sending_id:123}},old_message_id:'-5',error:{code:403,message:'CHAT_ADMIN_REQUIRED'}});
    await port.reconcile(effect());assert.equal((await store.get('e'))?.state,'verified');assert.equal((await store.get('e'))?.messageId,'900');
    await store.put({...original,state:'dispatching',tempMessageId:undefined,messageId:undefined});
    transport.emit('update',{'@type':'updateNewMessage',message:{...message(),chat_id:'99',id:'-8',sending_state:{'@type':'messageSendingStatePending',sending_id:123}}});
    transport.emit('update',{'@type':'updateMessageSendFailed',message:{...message(),chat_id:'99',id:'-8',sending_state:{'@type':'messageSendingStateFailed',sending_id:123}},old_message_id:'-8',error:{code:403,message:'CHAT_ADMIN_REQUIRED'}});
    await port.reconcile(effect());assert.equal((await store.get('e'))?.state,'dispatching');assert.equal((await store.get('e'))?.tempMessageId,undefined);assert.equal((await store.get('e'))?.messageId,undefined);
  }finally{await port.close();}
});

test('round-video metadata absence is known predispatch and does not silently guess dimensions',async()=>{
  for(const length of [undefined,0,-1,641,1.5]){
    const transport=new Fake(),store=new Store(),port=new TdlibTelegram({accountId:'42',transport,receipts:store});
    try{await assert.rejects(port.dispatch(effect('telegram.media.send',{mediaType:'videoNote',path:'fixture.mp4',length})),/trusted dimensions/);assert.equal(store.rows.size,0);assert.equal(transport.calls.some(value=>value['@type']==='sendMessage'),false);}finally{await port.close();}
  }
});

test('foreign native send admission cannot provide a local message mapping even when readback could match',async()=>{
  const transport=new Fake(),store=new Store(),port=new TdlibTelegram({accountId:'42',transport,receipts:store});transport.handle=async request=>request['@type']==='sendMessage'?{...message(),chat_id:'99'}:message();
  try{assert.equal((await port.dispatch(effect())).state,'unknown');assert.equal((await store.get('e'))?.messageId,undefined);assert.equal((await port.dispatch(effect())).state,'unknown');assert.equal(transport.calls.filter(value=>value['@type']==='sendMessage').length,1);}finally{await port.close();}
});

test('same-peer incoming or wrong-user response cannot map or verify an account-owned send',async()=>{
  for(const scenario of ['incoming','other-user','other-chat','readback']){
    const transport=new Fake(),store=new Store(),port=new TdlibTelegram({accountId:'42',transport,receipts:store});
    const invalid={...message(),is_outgoing:scenario!=='incoming',sender_id:scenario==='other-chat'?{'@type':'messageSenderChat',chat_id:'99'}:{'@type':'messageSenderUser',user_id:'99'}};
    transport.handle=async()=>invalid;
    if(scenario==='readback')await store.put({effectId:'e',payloadHash:'h',capability:'telegram.send',peerId:'12',messageId:'900',state:'unknown'});
    try{assert.equal((await port.dispatch(effect())).state,'unknown');if(scenario!=='readback')assert.equal((await store.get('e'))?.messageId,undefined);assert.equal((await port.dispatch(effect())).state,'unknown');assert.equal(transport.calls.filter(value=>value['@type']==='sendMessage').length,scenario==='readback'?0:1);}finally{await port.close();}
  }
});

test('safe native refusal category persists without copying arbitrary native diagnostic text',async()=>{
  for(const native of ['FLOOD_WAIT_37','secret phone +123456789']){
    const transport=new Fake(),store=new Store(),port=new TdlibTelegram({accountId:'42',transport,receipts:store});transport.handle=async()=>{throw new TdRequestError('TDLib rejected request',true,429,native);};
    try{assert.equal((await port.dispatch(effect())).state,'failed');const detail=(await store.get('e'))?.detail as TdObject;assert.equal(detail.code,429);assert.equal(detail.nativeReason,native.startsWith('FLOOD')?'FLOOD_WAIT':undefined);assert.doesNotMatch(JSON.stringify(detail),/secret phone|123456789/);}
    finally{await port.close();}
  }
});

test('media caption editing selects native caption method from fresh owned target',async()=>{
  const transport=new Fake(),store=new Store();transport.current.content={'@type':'messagePhoto',photo:{sizes:[]},caption:{text:'before'},show_caption_above_media:true};
  const port=new TdlibTelegram({accountId:'42',transport,receipts:store});
  const version=(await port.getMessage({accountId:'42',peerId:'12',messageId:'900'}))!.version;
  transport.handle=async request=>{if(request['@type']==='editMessageCaption'){transport.current.content.caption={text:request.caption.text};return structuredClone(transport.current);}return structuredClone(transport.current);};
  try{assert.equal((await port.dispatch(effect('telegram.message.edit',{text:'wanted',messageId:'900',expectedVersion:version}))).state,'verified');const request=transport.calls.find(value=>value['@type']==='editMessageCaption')!;assert.equal(request.caption.text,'wanted');assert.equal(request.show_caption_above_media,true);assert.equal(transport.calls.some(value=>value['@type']==='editMessageText'),false);}
  finally{await port.close();}
});

test('unsupported or incoming edit target is refused before durable/native mutation admission',async()=>{
  for(const invalid of ['incoming','sticker']){
    const transport=new Fake(),store=new Store(),port=new TdlibTelegram({accountId:'42',transport,receipts:store});if(invalid==='incoming')transport.current.is_outgoing=false;else transport.current.content={'@type':'messageSticker'};
    const version=(await port.getMessage({accountId:'42',peerId:'12',messageId:'900'}))!.version;
    try{await assert.rejects(port.dispatch(effect('telegram.message.edit',{text:'wanted',messageId:'900',expectedVersion:version})),/owned message|does not support/);assert.equal(store.rows.size,0);assert.equal(transport.calls.some(value=>value['@type'].startsWith('editMessage')),false);}
    finally{await port.close();}
  }
});

test('matching poll text cannot verify wrong visibility, answer policy or quiz type',async()=>{
  for(const scenario of ['matching','anonymous','multiple','quiz','hidden-answer','wrong-answer']){
    const transport=new Fake(),store=new Store(),payload={question:'wanted',options:['yes','no'],anonymous:false,multiple:false,...(scenario.includes('answer')?{quiz:true,correctOption:1,explanation:'proof'}:{})};
    const e=effect('telegram.poll.create',payload);await store.put({effectId:'e',payloadHash:'h',capability:e.capability,peerId:'12',messageId:'900',state:'pending'});
    transport.current.content={'@type':'messagePoll',poll:{question:{text:'wanted'},options:[{text:{text:'yes'}},{text:{text:'no'}}],is_anonymous:scenario==='anonymous',allows_multiple_answers:scenario==='multiple',type:scenario.includes('answer')?{'@type':'pollTypeQuiz',correct_option_ids:scenario==='hidden-answer'?[]:[0],explanation:{text:'proof'}}:{'@type':scenario==='quiz'?'pollTypeQuiz':'pollTypeRegular'}}};
    const port=new TdlibTelegram({accountId:'42',transport,receipts:store});try{assert.equal((await port.reconcile(e)).state,scenario==='matching'?'verified':'unknown');assert.equal(transport.calls.some(value=>value['@type']==='sendMessage'),false);}finally{await port.close();}
  }
});

test('native quote/code ranges preserve UTF-16 provenance through text, caption and entity-only revision',async()=>{
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()}),ref={accountId:'42',peerId:'12',messageId:'900'};
  const text='😀\nда /бро',entities=[{offset:3,length:2,type:{'@type':'textEntityTypeExpandableBlockQuote'}},{offset:6,length:4,type:{'@type':'textEntityTypePreCode',language:'text'}}];
  transport.current.content={...transport.current.content,text:{text,entities}};
  try{
    const quoted=(await port.getMessage(ref))!;assert.deepEqual(quoted.authorityTextRanges,[{offset:3,length:2,kind:'quote'},{offset:6,length:4,kind:'code'}]);
    transport.current.content.text.entities=[];const direct=(await port.getMessage(ref))!;assert.equal(direct.authorityTextRanges,undefined);assert.notEqual(direct.version,quoted.version);
    transport.current.content={'@type':'messagePhoto',photo:{sizes:[]},caption:{text,entities}};assert.deepEqual((await port.getMessage(ref))?.authorityTextRanges,quoted.authorityTextRanges);
    transport.current.content.caption.entities=[{offset:-1,length:2,type:{'@type':'textEntityTypeBlockQuote'}}];assert.deepEqual((await port.getMessage(ref))?.authorityTextRanges,[{offset:0,length:text.length,kind:'quote'}]);
  }finally{await port.close();}
});

test('direct message/history reads verify account before reading private content',async()=>{
  for(const method of ['message','history']){const transport=new Fake();transport.invoke=async request=>{transport.calls.push(request);return{'@type':'user',id:'99'};};const port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()});
    try{await assert.rejects(method==='message'?port.getMessage({accountId:'42',peerId:'12',messageId:'900'}):port.readHistory('12',{limit:10}),/account does not match/);assert.deepEqual(transport.calls.map(value=>value['@type']),['getMe']);}finally{await port.close();}
  }
});

test('fatal transport event wakes an idle observation consumer and preserves a safe failure',async()=>{
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()}),abort=new AbortController(),stream=port.observations(abort.signal)[Symbol.asyncIterator]();
  const waiting=stream.next();await new Promise(resolve=>setImmediate(resolve));
  transport.emit('fault',new Error('secret provider diagnostic'));
  try{await assert.rejects(waiting,/Telegram transport failed/);assert.equal(port.status().coverage,'gap');assert.doesNotMatch(port.status().fault!,/secret/);await assert.rejects(port.dispatch(effect()),/unavailable/);assert.equal(transport.calls.some(value=>value['@type']==='sendMessage'),false);}finally{abort.abort();await stream.return?.();await port.close();}
});

test('download requires exact native file identity and complete local byte count before copying',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'neurobro-download-hardening-')),source=join(directory,'source.bin'),destination=join(directory,'download.bin');await writeFile(source,'abc');
  t.after(async()=>{await unlink(source);await unlink(destination).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(directory);});
  for(const scenario of ['matching','foreign','size','truncated']){
    const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts:new Store()});transport.current.content={'@type':'messageDocument',document:{file_name:'source.bin',document:{id:11,size:3}}};
    transport.handle=async request=>request['@type']==='downloadFile'?{'@type':'file',id:scenario==='foreign'?12:11,size:scenario==='size'?4:3,local:{is_downloading_completed:true,path:source}}:structuredClone(transport.current);
    try{const attachment=(await port.getMessage({accountId:'42',peerId:'12',messageId:'900'}))!.attachments![0]!;if(scenario==='truncated')await writeFile(source,'ab');
      if(scenario==='matching'){await port.download(attachment,destination);assert.equal(await readFile(destination,'utf8'),'abc');await unlink(destination);}else await assert.rejects(port.download(attachment,destination),/identity or size mismatch|bytes incomplete/);
    }finally{await port.close();}
  }
});
