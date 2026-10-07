import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { TdlibTelegram, type TdJsonTransport, type TdObject, type TelegramReceipt, type TelegramReceiptStore } from '../../src/telegram/index.ts';
import type { Effect } from '../../src/contracts.ts';

const original=Buffer.from('approved CV bytes');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const barrier=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};};
class Store implements TelegramReceiptStore{
  rows=new Map<string,TelegramReceipt>();beforePut?:(receipt:TelegramReceipt)=>Promise<void>;
  async get(id:string){return this.rows.get(id);}
  async put(receipt:TelegramReceipt){await this.beforePut?.(receipt);this.rows.set(receipt.effectId,receipt);}
  async findMessage(peerId:string,id:string){return[...this.rows.values()].find(receipt=>receipt.peerId===peerId&&(receipt.messageId===id||receipt.tempMessageId===id));}
}
class Fake extends EventEmitter implements TdJsonTransport{
  calls:TdObject[]=[];handle!:(request:TdObject)=>Promise<TdObject>;
  async invoke(request:TdObject){this.calls.push(request);return this.handle(request);}
  async close(){}
}
async function fixture(context:{after(callback:()=>Promise<void>):void},mediaType='document'){
  const directory=await mkdtemp(join(tmpdir(),'neurobro-approved-media-')),path=join(directory,'artifact-id-cv.pdf');
  context.after(()=>rm(directory,{recursive:true,force:true}));await writeFile(path,original);
  const transport=new Fake(),receipts=new Store(),port=new TdlibTelegram({accountId:'42',transport,receipts});
  context.after(()=>port.close());
  const effect:Effect={id:'approved-media',taskId:'task',intentRevision:1,grantId:'grant',grantRevision:1,capability:'telegram.media.send',resource:'77',
    payload:{peerId:'77',path,mediaType,name:'cv.pdf',sha256:hash(original),size:original.length},payloadHash:'host-bound-approved-payload',state:'dispatching',createdAt:'2026-10-05',updatedAt:'2026-10-05'};
  const nativeMessage:TdObject={'@type':'message',id:'901',chat_id:'77',sender_id:{'@type':'messageSenderUser',user_id:'42'},is_outgoing:true,date:1,
    content:mediaType==='document'?{'@type':'messageDocument',caption:{text:''},document:{file_name:basename(path),document:{'@type':'file',id:5,size:original.length}}}:{'@type':'messagePhoto',caption:{text:''},photo:{sizes:[{photo:{id:5,size:3}}]}}};
  transport.handle=async request=>request['@type']==='getMe'?{'@type':'user',id:'42'}:structuredClone(nativeMessage);
  return{path,transport,receipts,port,effect,nativeMessage};
}

test('approved document with matching staged bytes, actual basename and native size verifies',async context=>{
  const f=await fixture(context),result=await f.port.dispatch(f.effect);assert.equal(result.state,'verified');
  const sent=f.transport.calls.find(request=>request['@type']==='sendMessage');assert.equal(sent?.input_message_content.document.document.path,f.path);
  assert.equal(sent?.input_message_content.document.file_name,undefined);assert.notEqual(basename(f.path),'cv.pdf');
  assert.equal(f.transport.calls.filter(request=>request['@type']==='sendMessage').length,1);
});

test('file changed during account verification is rejected before native admission, even at same size',async context=>{
  const f=await fixture(context),entered=barrier(),resume=barrier(),fallback=f.transport.handle;
  f.transport.handle=async request=>{if(request['@type']==='getMe'){entered.release();await resume.promise;}return fallback(request);};
  const dispatched=f.port.dispatch(f.effect);await entered.promise;await writeFile(f.path,Buffer.alloc(original.length,120));resume.release();
  const result=await dispatched;assert.equal(result.state,'failed');assert.equal(f.transport.calls.some(request=>request['@type']==='sendMessage'),false);
  assert.equal(((await f.receipts.get(f.effect.id))?.detail as TdObject)?.notDispatched,true);assert.equal((await f.port.dispatch(f.effect)).state,'failed');
  assert.equal(f.transport.calls.some(request=>request['@type']==='sendMessage'),false);
});

test('file changed during durable receipt write is also checked immediately before native admission',async context=>{
  const f=await fixture(context),entered=barrier(),resume=barrier();
  f.receipts.beforePut=async receipt=>{if(receipt.state==='dispatching'){entered.release();await resume.promise;}};
  const dispatched=f.port.dispatch(f.effect);await entered.promise;await writeFile(f.path,'changed length');resume.release();
  assert.equal((await dispatched).state,'failed');assert.equal(f.transport.calls.some(request=>request['@type']==='sendMessage'),false);
  assert.equal(((await f.receipts.get(f.effect.id))?.detail as TdObject)?.notDispatched,true);
});

test('file changed during target refresh cannot pass an earlier hash check',async context=>{
  const f=await fixture(context),anchor={accountId:'42',peerId:'77',messageId:'901'};
  const observation=await f.port.getMessage(anchor);assert.ok(observation);assert.ok(observation.version);
  f.effect.payload={...(f.effect.payload as TdObject),messageId:'901',expectedVersion:observation.version};
  const entered=barrier(),resume=barrier(),fallback=f.transport.handle;
  f.transport.handle=async request=>{if(request['@type']==='getMessage'){entered.release();await resume.promise;}return fallback(request);};
  const dispatched=f.port.dispatch(f.effect);await entered.promise;await writeFile(f.path,Buffer.alloc(original.length,121));resume.release();
  assert.equal((await dispatched).state,'failed');assert.equal(f.transport.calls.some(request=>request['@type']==='sendMessage'),false);
});

test('wrong native document filename, logical label, or size remains UNKNOWN without a second send',async context=>{
  for(const mismatch of ['filename','logical-label','size','missing-size']){
    const f=await fixture(context),document=f.nativeMessage.content.document;
    if(mismatch==='filename')document.file_name='different.pdf';
    if(mismatch==='logical-label')document.file_name='cv.pdf';
    if(mismatch==='size')document.document.size=original.length+1;
    if(mismatch==='missing-size')delete document.document.size;
    assert.equal((await f.port.dispatch(f.effect)).state,'unknown');assert.equal((await f.port.reconcile(f.effect)).state,'unknown');
    assert.equal(f.transport.calls.filter(request=>request['@type']==='sendMessage').length,1);
  }
});

test('photo source integrity is checked on admission; compressed native photo size is not an exact-byte claim',async context=>{
  const f=await fixture(context,'photo');assert.equal((await f.port.dispatch(f.effect)).state,'verified');
  const changed=await fixture(context,'photo');await writeFile(changed.path,Buffer.alloc(original.length,122));
  assert.equal((await changed.port.dispatch(changed.effect)).state,'failed');assert.equal(changed.transport.calls.some(request=>request['@type']==='sendMessage'),false);
});

test('missing file or incomplete integrity metadata cannot invoke sendMessage',async context=>{
  for(const failure of ['missing-file','missing-hash','bad-size']){
    const f=await fixture(context);
    if(failure==='missing-file')await rm(f.path);
    if(failure==='missing-hash')delete(f.effect.payload as TdObject).sha256;
    if(failure==='bad-size')(f.effect.payload as TdObject).size='17';
    assert.equal((await f.port.dispatch(f.effect)).state,'failed');assert.equal(f.transport.calls.some(request=>request['@type']==='sendMessage'),false);
    assert.equal(((await f.receipts.get(f.effect.id))?.detail as TdObject)?.notDispatched,true);
  }
});
