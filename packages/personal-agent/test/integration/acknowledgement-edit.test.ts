import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalHost } from '../../src/host.ts';
import { TdlibTelegram, FileTelegramStore, TdRequestError, type TdObject, type TdJsonTransport } from '../../src/telegram/index.ts';
import type { PersonalConfig } from '../../src/config.ts';
import type { Effect, EngineInput, EnginePort, RunBinding, RunSnapshot } from '../../src/contracts.ts';

const acknowledgement='🤖 Нейробратик\n\nПонял, бро. Сейчас гляну.';
const nativeMessage=(id:string,text:string):TdObject=>({'@type':'message',id,chat_id:'-100123',sender_id:{'@type':'messageSenderUser',user_id:'42'},is_outgoing:true,date:Math.floor(Date.now()/1000),content:{'@type':'messageText',text:{'@type':'formattedText',text,entities:[]}}});
class Native extends EventEmitter implements TdJsonTransport {
  messages=new Map<string,TdObject>(); calls:TdObject[]=[]; next=1000; editLost=false; applyEdit=true; unavailable=false; pendingAck=false;
  async invoke(request:TdObject):Promise<TdObject>{
    this.calls.push(structuredClone(request));
    if(request['@type']==='getMe')return{'@type':'user',id:'42'};
    if(request['@type']==='getMessage'){
      if(this.unavailable)throw new TdRequestError('read unavailable',true,403);
      const result=this.messages.get(String(request.message_id));if(!result)throw new TdRequestError('not found',true,404);return structuredClone(result);
    }
    if(request['@type']==='sendMessage'){
      const result=nativeMessage(String(this.next++),request.input_message_content.text.text);
      if(this.pendingAck&&result.content.text.text===acknowledgement)result.sending_state={'@type':'messageSendingStatePending'};
      this.messages.set(result.id,result);return structuredClone(result);
    }
    if(request['@type']==='editMessageText'){
      const result=this.messages.get(String(request.message_id));assert.ok(result);
      if(this.applyEdit)result.content.text=structuredClone(request.input_message_content.text);
      if(this.editLost)throw new TdRequestError('edit response lost',true);
      return structuredClone(result);
    }
    throw new Error('unexpected fixture request '+request['@type']);
  }
  async close(){}
  count(method:string){return this.calls.filter(request=>request['@type']===method).length;}
}
class Engine implements EnginePort {
  inputs:EngineInput[]=[];runs=new Map<string,RunSnapshot>();
  async capabilities(){return{durable:true,sessions:true,cancel:true,steer:false};}
  async submit(input:EngineInput){this.inputs.push(input);const run:RunSnapshot={binding:{taskId:input.taskId,intentRevision:input.intentRevision,idempotencyKey:input.idempotencyKey,runId:'run'+this.inputs.length},state:'running',observedAt:new Date().toISOString()};this.runs.set(run.binding.runId,run);return run;}
  async inspect(binding:RunBinding){return this.runs.get(binding.runId)!;}
  async cancel(binding:RunBinding){const run={...this.runs.get(binding.runId)!,state:'cancelled' as const};this.runs.set(binding.runId,run);return run;}
  complete(taskId:string,text:string){const run=[...this.runs.values()].find(run=>run.binding.taskId===taskId)!;this.runs.set(run.binding.runId,{...run,state:'completed',output:text});}
}
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'neurobro-ack-edit-')),key=Buffer.alloc(32,20),native=new Native(),engine=new Engine(),delivered:Effect[][]=[];
  const config:PersonalConfig={schemaVersion:1,stateDirectory:directory,account:{id:'42',ownerId:'42',controlPeerId:'-100123'},encryptionKeyEnv:'UNUSED',hermes:{baseUrl:'http://127.0.0.1:1',apiKeyEnv:'UNUSED'},telegram:{command:process.execPath,args:[],databaseDirectory:join(directory,'td'),filesDirectory:join(directory,'files'),apiIdEnv:'UNUSED',apiHashEnv:'UNUSED'}};
  let receipts=new FileTelegramStore(join(directory,'receipts'),key),telegram=new TdlibTelegram({accountId:'42',transport:native,receipts});
  const createHost=()=>new PersonalHost({config,encryptionKey:key,telegram,engine,onFinalDelivery:delivery=>{delivered.push(delivery.effects);}});let host=createHost();
  return{native,engine,delivered,get host(){return host;},get telegram(){return telegram;},get receipts(){return receipts;},async admit(id:string,text='Подготовь результат'){native.messages.set(id,nativeMessage(id,text));const source=await telegram.getMessage({accountId:'42',peerId:'-100123',messageId:id});assert.ok(source);return (await host.ingest(source)).taskId!;},async reopen(){await host.close();await telegram.close();receipts=new FileTelegramStore(join(directory,'receipts'),key);telegram=new TdlibTelegram({accountId:'42',transport:native,receipts});host=createHost();await host.agent.start();},async close(){await host.close();await telegram.close();await rm(directory,{recursive:true,force:true});}};
}

test('verified acknowledgement becomes final answer by native edit with same message ID, no new notification and no self-command',async()=>{
  const f=await fixture();try{
    const task=await f.admit('1'),binding=f.host.agent.store.get<{effectId:string}>('taskAcknowledgements',task)!;assert.ok(binding);
    f.engine.complete(task,'Проверенный ответ');await f.host.pollLifecycle();
    assert.equal(f.native.count('sendMessage'),1);assert.equal(f.native.count('editMessageText'),1);assert.equal(f.native.count('deleteMessages'),0);
    assert.equal(f.native.messages.get('1000')!.content.text.text,'🤖 Нейробратик\n\nПроверенный ответ');assert.equal(f.delivered.length,1);assert.equal(f.delivered[0]![0]!.state,'verified');
    const edited=await f.telegram.getMessage({accountId:'42',peerId:'-100123',messageId:'1000'});assert.ok(edited?.agentEffectId);assert.equal((await f.host.ingest({...edited!,kind:'edit'})).disposition,'ignored');assert.equal(f.engine.inputs.length,1);
    await f.reopen();await f.host.pollLifecycle();assert.equal(f.native.count('sendMessage'),1);assert.equal(f.native.count('editMessageText'),1);
  }finally{await f.close();}
});

test('multipart first part edits the exact task acknowledgement and remaining parts send after its proof',async()=>{
  const f=await fixture();try{
    const first=await f.admit('1'),second=await f.admit('2','Вторая задача');f.engine.complete(first,'А'.repeat(4000));await f.host.pollLifecycle();
    assert.equal(f.native.count('editMessageText'),1);assert.equal(f.native.calls.find(request=>request['@type']==='editMessageText')!.message_id,'1000');
    assert.match(f.native.messages.get('1000')!.content.text.text,/· 1\/2/);assert.equal(f.native.messages.get('1001')!.content.text.text,acknowledgement);assert.match(f.native.messages.get('1002')!.content.text.text,/· 2\/2/);
    assert.equal(f.delivered[0]!.length,2);assert.equal(f.host.agent.status(second)!.run!.state,'running');
  }finally{await f.close();}
});

test('unknown edit stops multipart; cold reopen reconciles applied bytes and never blindly edits or resends first part',async()=>{
  const f=await fixture();try{
    const task=await f.admit('1');f.native.editLost=true;f.engine.complete(task,'А'.repeat(4000));await f.host.pollLifecycle();
    assert.equal(f.delivered.length,0);assert.equal(f.native.count('sendMessage'),1);assert.equal(f.host.agent.status(task)!.effects[0]!.state,'unknown');
    await f.reopen();await f.host.pollLifecycle();assert.equal(f.delivered.length,1);assert.equal(f.native.count('editMessageText'),1);assert.equal(f.native.count('sendMessage'),2);
  }finally{await f.close();}
});

test('lost edit without remote application stays unknown across restart, no final delivery or replay',async()=>{
  const f=await fixture();try{
    const task=await f.admit('1');f.native.applyEdit=false;f.native.editLost=true;f.engine.complete(task,'Готовый ответ');await f.host.pollLifecycle();await f.reopen();await f.host.pollLifecycle();
    assert.equal(f.delivered.length,0);assert.equal(f.native.count('editMessageText'),1);assert.equal(f.native.count('sendMessage'),1);assert.equal(f.native.messages.get('1000')!.content.text.text,acknowledgement);
  }finally{await f.close();}
});

for(const modification of ['human','edited','missing','wrong-task','unknown-ack'] as const)test(`unsafe ${modification} acknowledgement falls back to normal final send without editing any message`,async()=>{
  const f=await fixture();try{
    if(modification==='unknown-ack')f.native.pendingAck=true;
    const task=await f.admit('1');
    if(modification==='human'){
      const original=f.native.messages.get('1000')!;original.sender_id.user_id='99';original.is_outgoing=false;
    }else if(modification==='edited')f.native.messages.get('1000')!.content.text.text='Владелец изменил текст';
    else if(modification==='missing')f.native.messages.delete('1000');
    else if(modification==='wrong-task'){
      const second=await f.admit('2','Другая задача'),other=f.host.agent.store.get('taskAcknowledgements',second)!;f.host.agent.store.put('taskAcknowledgements',task,other);
    }
    f.engine.complete(task,'Финальный результат');await f.host.pollLifecycle();assert.equal(f.native.count('editMessageText'),0);assert.ok(f.native.calls.filter(request=>request['@type']==='sendMessage').some(request=>request.input_message_content.text.text.includes('Финальный результат')));
  }finally{await f.close();}
});

test('model cannot request acknowledgement replacement even with copied durable IDs',async()=>{
  const f=await fixture();try{
    const task=await f.admit('1'),status=f.host.agent.status(task)!,token=f.host.agent.issueToolContext(status.run!.binding);
    await assert.rejects(f.host.agent.executeEffect(token,{id:'forged',capability:'telegram.send',resource:'-100123',payload:{peerId:'-100123',text:'forged',replaceAcknowledgement:{effectId:'copied'}}}),/reserved for host final delivery/);
    assert.equal(f.native.count('editMessageText'),0);
  }finally{await f.close();}
});

test('initially pending acknowledgement becomes editable when its native receipt settles before model completion',async()=>{
  const f=await fixture();try{
    f.native.pendingAck=true;const task=await f.admit('1');
    const binding=f.host.agent.store.get<{effectId:string}>('taskAcknowledgements',task)!;
    assert.equal(f.host.agent.store.get<Effect>('effects',binding.effectId)!.state,'unknown');
    const delivered=f.native.messages.get('1000')!;delete delivered.sending_state;
    f.native.emit('update',{'@type':'updateMessageSendSucceeded',old_message_id:'1000',message:structuredClone(delivered)});
    await f.host.pollLifecycle();assert.equal(f.host.agent.store.get<Effect>('effects',binding.effectId)!.state,'verified');assert.equal(f.engine.runs.values().next().value!.state,'running');
    f.engine.complete(task,'Финальный ответ после поздней квитанции');await f.host.pollLifecycle();
    assert.equal(f.native.count('sendMessage'),1);assert.equal(f.native.count('editMessageText'),1);assert.equal(f.delivered.length,1);
  }finally{await f.close();}
});
