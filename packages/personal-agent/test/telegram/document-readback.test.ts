import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {TdlibTelegram,type TdObject,type TdJsonTransport,type TelegramReceipt} from '../../src/telegram/index.ts';
import type {Effect} from '../../src/contracts.ts';

for(const scenario of ['renamed','wrong-bytes','wrong-file','incomplete','missing-hash'] as const)test(`document rename reconciliation: ${scenario}`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'neurobro-document-proof-'));
 const source=join(directory,'long-original-proposal-name.json'),download=join(directory,'remote.json'),bytes=Buffer.from('{"a":1}');
 await writeFile(source,bytes);await writeFile(download,scenario==='wrong-bytes'?Buffer.from('{"b":2}'):bytes);
 const effect:Effect={id:'document',taskId:'t',intentRevision:1,grantId:'g',grantRevision:1,capability:'telegram.media.send',resource:'12',payload:{mediaType:'document',path:source,name:'proposal.json',size:bytes.length,...(scenario==='missing-hash'?{}:{sha256:createHash('sha256').update(bytes).digest('hex')})},payloadHash:'hash',state:'unknown',createdAt:'now',updatedAt:'now'};
 const rows=new Map<string,TelegramReceipt>([['document',{effectId:'document',capability:effect.capability,peerId:'12',payloadHash:'hash',state:'unknown',messageId:'9'}]]);
 class Transport extends EventEmitter implements TdJsonTransport{
  calls:string[]=[];
  async invoke(request:TdObject){this.calls.push(request['@type']);
   if(request['@type']==='getMe')return{'@type':'user',id:'42'};
   if(request['@type']==='getMessage')return{'@type':'message',id:'9',chat_id:'12',is_outgoing:true,sender_id:{'@type':'messageSenderUser',user_id:'42'},content:{'@type':'messageDocument',caption:{text:''},document:{file_name:'short_name.json',document:{id:'11',size:bytes.length}}}};
   if(request['@type']==='downloadFile')return{'@type':'file',id:scenario==='wrong-file'?'99':'11',size:bytes.length,local:{path:download,is_downloading_completed:scenario!=='incomplete'}};
   throw new Error('Unexpected native mutation');
  }
  async close(){}
 }
 const transport=new Transport(),port=new TdlibTelegram({accountId:'42',transport,receipts:{async get(id){return rows.get(id)},async put(row){rows.set(row.effectId,row)},async findMessage(){return undefined}}});
 try{const result=await port.reconcile(effect);assert.equal(result.state,scenario==='renamed'?'verified':'unknown');assert.equal(transport.calls.includes('sendMessage'),false);if(scenario==='missing-hash')assert.equal(transport.calls.includes('downloadFile'),false);}
 finally{await port.close();await rm(directory,{recursive:true,force:true});}
});
