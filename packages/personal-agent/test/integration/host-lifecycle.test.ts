import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalHost,type HostOptions} from '../../src/host.ts';
import {OwnerControlService} from '../../src/owner-controls/index.ts';
import type {PersonalConfig} from '../../src/config.ts';
import type {Effect,EffectResult,EngineInput,EnginePort,MessageRef,Observation,RunBinding,RunSnapshot,TelegramPort} from '../../src/contracts.ts';
const key=(ref:MessageRef)=>JSON.stringify([ref.accountId,ref.peerId,ref.messageId]);
class Engine implements EnginePort{
 inputs:EngineInput[]=[];runs=new Map<string,RunSnapshot>();
 async capabilities(){return{durable:true,sessions:true,cancel:true,steer:false};}
 async submit(input:EngineInput){this.inputs.push(input);const binding={taskId:input.taskId,intentRevision:input.intentRevision,idempotencyKey:input.idempotencyKey,runId:'run'+this.inputs.length,sessionId:'session'+this.inputs.length};const run:RunSnapshot={binding,state:'running',observedAt:new Date().toISOString()};this.runs.set(binding.runId,run);return run;}
 async inspect(binding:RunBinding){return this.runs.get(binding.runId)!;}
 async cancel(binding:RunBinding){const run={...this.runs.get(binding.runId)!,state:'cancelled' as const};this.runs.set(binding.runId,run);return run;}
}
class Telegram implements TelegramPort{
 messages=new Map<string,Observation>();effects:Effect[]=[];result:(effect:Effect)=>Promise<EffectResult>=async()=>({state:'verified',receipt:{messageId:String(9000+this.effects.length)}});
 async *observations(_signal:AbortSignal){}
 async readHistory(peerId:string){return[...this.messages.values()].filter(item=>item.ref.peerId===peerId);}
 async getMessage(ref:MessageRef){const item=this.messages.get(key(ref));return item?{...item,observedAt:new Date().toISOString()}:undefined;}
 async download(_attachment:unknown,path:string){await writeFile(path,'fixture');}
 async dispatch(effect:Effect){this.effects.push(effect);return this.result(effect);}
 async reconcile(){return{state:'unknown' as const,reason:'fixture awaiting exact readback'};}
 async close(){}
}
function message(id:string,text:string,extra:Partial<Observation>={}):Observation{const now=new Date().toISOString();return{id:'event'+id,kind:'message',ref:{accountId:'a',peerId:'control',messageId:id},authorId:'owner',outgoing:true,text,sentAt:now,observedAt:now,...extra};}
function effectText(effect:Effect):string{return typeof effect.payload==='object'&&effect.payload&&!Array.isArray(effect.payload)&&typeof effect.payload.text==='string'?effect.payload.text:'';}
async function fixture(options:Partial<HostOptions>={}){
 const dir=await mkdtemp(join(tmpdir(),'neurobro-host-lifecycle-')),telegram=new Telegram(),engine=new Engine();const config:PersonalConfig={schemaVersion:1,stateDirectory:dir,account:{id:'a',ownerId:'owner',controlPeerId:'control'},encryptionKeyEnv:'UNUSED_FIXTURE_KEY',hermes:{baseUrl:'http://127.0.0.1:1',apiKeyEnv:'UNUSED_FIXTURE_HERMES'},telegram:{command:process.execPath,args:[],databaseDirectory:join(dir,'td'),filesDirectory:join(dir,'files'),apiIdEnv:'UNUSED_FIXTURE_ID',apiHashEnv:'UNUSED_FIXTURE_HASH'}};
 let host=new PersonalHost({config,encryptionKey:Buffer.alloc(32,8),telegram,engine,...options});return{dir,telegram,engine,get host(){return host;},async reopen(){await host.close();host=new PersonalHost({...host.options});await host.agent.start();},async admit(observation:Observation){telegram.messages.set(key(observation.ref),observation);return host.ingest(observation);},async close(){await host.close();await rm(dir,{recursive:true,force:true});}};
}

test('final-delivery callback excludes acknowledgements and waits for every multipart receipt across restart',async()=>{
 const observed:{taskId:string;runId:string;effects:Effect[]}[]=[],f=await fixture({onFinalDelivery:value=>{observed.push(value);}});
 try{
  const accepted=await f.admit(message('1','Какие новые ответы от работодателей?')),status=f.host.agent.status(accepted.taskId!)!;
  assert.equal(observed.length,0);
  f.telegram.result=async()=>({state:'unknown',reason:'native pending'});
  f.engine.runs.set(status.run!.binding.runId,{...status.run!,state:'completed',output:'А'.repeat(4000)});
  await f.host.pollLifecycle();assert.equal(observed.length,0);
  await f.reopen();await f.host.pollLifecycle();assert.equal(observed.length,0);
  f.telegram.reconcile=async()=>({state:'verified',receipt:{peerId:'control',messageId:'final'}} as any);
  f.telegram.result=async()=>({state:'verified',receipt:{peerId:'control',messageId:'next-final'}});
  await f.host.pollLifecycle();
  assert.ok(observed.length>0);assert.equal(observed.at(-1)!.taskId,accepted.taskId);
  assert.equal(observed.at(-1)!.runId,status.run!.binding.runId);assert.equal(observed.at(-1)!.effects.length,2);
  assert.ok(observed.at(-1)!.effects.every(effect=>effect.state==='verified'&&!effectText(effect).includes('Сейчас гляну')));
 }finally{await f.close();}
});

test('fresh private natural and prefixed commands get human-readable acknowledgement, private own-output mapping and current status progress',async()=>{
 const f=await fixture();try{
  const details={poll:{pollId:'opaque-poll',question:'Quoted poll question',options:[{id:'opaque-option',index:0,text:'Original option',votes:2}],resultsAvailable:true},buttons:[{row:0,column:0,label:'Quoted button label',type:'callback'}]} as const;
  const first=await f.admit(message('1','Разбери результат',{messageDetails:details}));assert.equal(first.disposition,'accepted');assert.equal(f.telegram.effects.length,1);assert.ok(!effectText(f.telegram.effects[0]!).includes(first.taskId!));assert.match(effectText(f.telegram.effects[0]!),/Понял, бро/);assert.equal(f.telegram.effects[0]!.resource,'control');assert.ok(f.engine.inputs[0]!.context?.includes('Quoted poll question'));assert.deepEqual(f.host.memory.currentSource({ownerId:'owner',accountId:'a',scopes:['chat:control']},'control/1')!.sourceMetadata?.messageDetails,details);
  const own=f.host.agent.store.list<{ref:MessageRef;taskId:string}>('ownOutputs')[0]!;assert.equal(own.taskId,first.taskId);
  const status=f.host.agent.status(first.taskId!)!;f.engine.runs.set(status.run!.binding.runId,{...status.run!,progress:'Прочитано 12 строк, проверяется формула'});await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,1);
  await f.admit(message('2','/бро статус'));assert.match(effectText(f.telegram.effects.at(-1)!),/Прочитано 12 строк/);
  const second=await f.admit(message('3','/бро подготовь файл'));assert.equal(second.disposition,'accepted');assert.equal(f.engine.inputs.length,2);assert.ok(!effectText(f.telegram.effects.at(-1)!).includes(second.taskId!));
  await f.host.pollLifecycle();const count=f.telegram.effects.length;await f.reopen();await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,count);
 }finally{await f.close();}
});

for(const state of ['failed','interrupted','unknown'] as const)test(`private ${state} transition is claimed once across concurrent polls, repeat and restart`,async()=>{
 const f=await fixture();try{
  const accepted=await f.admit(message('1','Проверь данные')),status=f.host.agent.status(accepted.taskId!)!;f.engine.runs.set(status.run!.binding.runId,{...status.run!,state,reason:'fixture execution state '+state,progress:'Источник прочитан, результат не подтверждён'});
  await Promise.all([f.host.pollLifecycle(),f.host.pollLifecycle()]);assert.equal(f.telegram.effects.length,2);assert.equal(f.telegram.effects[1]!.resource,'control');assert.match(effectText(f.telegram.effects[1]!),/fixture execution state/);assert.ok(!effectText(f.telegram.effects[1]!).includes('готово'));
  await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,2);await f.reopen();await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,2);assert.equal(f.host.agent.store.list('hostLifecycleNotices').length,2);
 }finally{await f.close();}
});

test('UNKNOWN acknowledgement send and interrupted prepared claim never automatically dispatch again after restart',async()=>{
 const f=await fixture();try{
  f.telegram.result=async()=>({state:'unknown',reason:'fixture unknown send'});const command=message('1','Подготовь таблицу'),accepted=await f.admit(command);assert.equal(f.telegram.effects.length,1);assert.equal(f.host.agent.store.list<{state:string}>('hostLifecycleNotices')[0]!.state,'unknown');
  await f.admit({...command,id:'duplicate'});await f.host.pollLifecycle();await f.reopen();await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,1);
  const status=f.host.agent.status(accepted.taskId!)!,claim=`run:${accepted.taskId}:1:${status.run!.binding.runId}:failed`;f.host.agent.store.put('hostLifecycleNotices',claim,{key:claim,state:'prepared'});f.engine.runs.set(status.run!.binding.runId,{...status.run!,state:'failed',reason:'fixture failure after interrupted claim'});await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,1);
 }finally{await f.close();}
});

test('actual final delivery failure emits one private notice, exposes prepared versus delivered truth and does not replay the final effect',async()=>{
 const f=await fixture();try{
  const accepted=await f.admit(message('1','Подготовь результат')),status=f.host.agent.status(accepted.taskId!)!;f.telegram.result=async effect=>effectText(effect).includes('Фактический результат')?{state:'failed',reason:'fixture destination rejected'}:{state:'verified',receipt:{messageId:String(9000+f.telegram.effects.length)}};
  f.engine.runs.set(status.run!.binding.runId,{...status.run!,state:'completed',output:'Фактический результат'});await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,3);assert.match(effectText(f.telegram.effects[2]!),/Результат подготовлен, но отправка не выполнена/);await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,3);
  await f.admit(message('2','/бро статус'));const text=effectText(f.telegram.effects.at(-1)!);assert.match(text,/результат подготовлен/);assert.match(text,/подтверждено 0 из 1/);assert.match(text,/ошибка отправки/);assert.ok(!text.includes('доставлен'));await f.reopen();await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,4);
 }finally{await f.close();}
});

test('normal delayed Telegram receipt settles without warning or resend',async()=>{
 const now=new Date(),f=await fixture({now:()=>now});try{
  const accepted=await f.admit(message('1','Проверь связь')),status=f.host.agent.status(accepted.taskId!)!;
  f.telegram.result=async()=>({state:'unknown',reason:'TDLib native admission pending terminal update/readback'});
  f.engine.runs.set(status.run!.binding.runId,{...status.run!,state:'completed',output:'На связи'});
  await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,2);
  now.setTime(now.getTime()+2500);
  f.telegram.reconcile=async()=>({state:'verified',receipt:{peerId:'control',messageId:'confirmed'},reason:undefined} as any);
  await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,2);
  now.setTime(now.getTime()+60000);await f.reopen();await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,2);
 }finally{await f.close();}
});

test('persistent delivery uncertainty waits across restart then reports once in plain language',async()=>{
 const now=new Date(),f=await fixture({now:()=>now});try{
  const accepted=await f.admit(message('1','Подготовь ответ')),status=f.host.agent.status(accepted.taskId!)!;
  f.telegram.result=async effect=>effectText(effect).includes('Готовый ответ')?{state:'unknown',reason:'TDLib native admission pending terminal update/readback'}:{state:'verified',receipt:{peerId:'control',messageId:'notice'}};
  f.engine.runs.set(status.run!.binding.runId,{...status.run!,state:'completed',output:'Готовый ответ'});
  await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,2);
  const original=f.host.agent.status(accepted.taskId!)!.effects.find(e=>e.state==='unknown')!;
  now.setTime(Date.parse(original.createdAt)+20000);await f.reopen();await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,2);
  now.setTime(Date.parse(original.createdAt)+31000);await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,3);
  const text=effectText(f.telegram.effects[2]!);assert.match(text,/пока не подтвердил/);assert.ok(!text.includes('TDLib'));assert.ok(!text.includes('исход'));
  await f.reopen();await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,3);
 }finally{await f.close();}
});

test('cold unseen old natural and prefixed private backlog remains context without task, repeat notices or automatic restart replay; fresh reply may act',async()=>{
 const f=await fixture();try{
  const sentAt=new Date(Date.now()-4*60*60*1000).toISOString(),old=message('1','/бро отправь старое поручение',{sentAt});assert.equal((await f.admit(old)).disposition,'held');assert.equal(f.engine.inputs.length,0);assert.equal(f.host.agent.status().length,0);assert.match(effectText(f.telegram.effects[0]!),/не запущено/);assert.equal(f.host.agent.store.list('staleOwnerEvents').length,1);
  await f.admit({...old,id:'second-arrival'});assert.equal(f.telegram.effects.length,1);await f.reopen();await f.admit({...old,id:'cold-arrival'});assert.equal(f.telegram.effects.length,1);
  assert.equal((await f.admit(message('2','Старое обычное поручение',{sentAt}))).disposition,'held');assert.equal(f.engine.inputs.length,0);
  const fresh=await f.admit(message('3','Проверь старый контекст, но ничего не отправляй',{replyTo:old.ref}));assert.equal(fresh.disposition,'accepted');assert.equal(f.engine.inputs.length,1);assert.equal(f.engine.inputs[0]!.instruction,'Проверь старый контекст, но ничего не отправляй');assert.ok(f.engine.inputs[0]!.context?.includes('отправь старое поручение'));
 }finally{await f.close();}
});

test('freshness horizon is explicit and rechecked after async source read before any engine or original effect',async()=>{
 const now=new Date(),f=await fixture({commandFreshnessMs:1000,now:()=>now});try{
  const command=message('1','Разбери данные',{sentAt:now.toISOString()}),get=f.telegram.getMessage.bind(f.telegram);let reads=0;f.telegram.getMessage=async ref=>{const current=await get(ref);if(++reads===2)now.setTime(now.getTime()+2000);return current;};const accepted=await f.admit(command);assert.equal(accepted.disposition,'accepted');assert.equal(f.engine.inputs.length,0);assert.equal(f.host.agent.status(accepted.taskId!)?.state,'paused');assert.ok(f.telegram.effects.every(effect=>effect.resource==='control'&&effectText(effect).startsWith('🤖 Нейробратик\n\n')));
 }finally{await f.close();}
});

test('deleted original source cannot deliver old result or trigger obsolete failure notice',async()=>{
 const f=await fixture();try{
  const command=message('1','Подготовь ответ'),accepted=await f.admit(command),status=f.host.agent.status(accepted.taskId!)!;await f.host.ingest({...command,kind:'delete',text:undefined,id:'deleted'});const count=f.telegram.effects.length;f.engine.runs.set(status.run!.binding.runId,{...status.run!,state:'completed',output:'OLD UNAPPROVED RESULT'});await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,count);assert.ok(f.telegram.effects.every(effect=>!effectText(effect).includes('OLD UNAPPROVED RESULT')));
 }finally{await f.close();}
});

test('racing duplicate intake admits one task and one durable acknowledgement',async()=>{
 const f=await fixture();try{
  const command=message('1','Проверь файл'),results=await Promise.all([f.admit(command),f.admit({...command,id:'racing-second-arrival'})]);assert.deepEqual(results.map(result=>result.disposition).sort(),['accepted','duplicate']);assert.equal(f.engine.inputs.length,1);assert.equal(f.host.agent.status().length,1);assert.equal(f.telegram.effects.length,1);assert.equal(f.host.agent.store.list('hostLifecycleNotices').length,1);
 }finally{await f.close();}
});

test('unseen stale edit of an accepted owner command suspends prior authority instead of continuing old objective',async()=>{
 const now=new Date(),f=await fixture({now:()=>now});try{
  const command=message('1','Проверь результат',{sentAt:now.toISOString()}),accepted=await f.admit(command),original=f.host.agent.status(accepted.taskId!)!;now.setTime(now.getTime()+4*60*60*1000);
  const edited={...command,kind:'edit' as const,id:'old-unseen-edit',text:'Старое изменённое поручение',editedAt:new Date(now.getTime()-60*60*1000).toISOString()};const result=await f.admit(edited);assert.equal(result.disposition,'held');assert.equal(result.taskId,accepted.taskId);assert.equal(f.host.agent.status(accepted.taskId!)?.state,'paused');assert.equal(f.engine.inputs.length,1);
  const count=f.telegram.effects.length;f.engine.runs.set(original.run!.binding.runId,{...original.run!,state:'completed',output:'OLD RESULT SHOULD NOT SEND'});await f.host.pollLifecycle();assert.equal(f.telegram.effects.length,count);assert.ok(f.telegram.effects.every(effect=>!effectText(effect).includes('OLD RESULT SHOULD NOT SEND')));
 }finally{await f.close();}
});

test('stale edit of a separate approval revokes source scope before any obsolete directive can run',async()=>{
 const now=new Date(),f=await fixture({now:()=>now});try{
  const controls=new OwnerControlService({store:f.host.agent.store,accountId:'a',ownerId:'owner',controlPeerId:'control',telegram:{getMessage:ref=>f.telegram.getMessage(ref),resolveSource:async()=>({accountId:'a',peerId:'remote',label:'Exact channel',kind:'channel'}),resolveForwardSource:async()=>undefined,verifyPeer:async peer=>peer},taskIntent:id=>f.host.agent.status(id)?.intent,taskActive:id=>{const status=f.host.agent.status(id);return!!status&&!status.cancelledAt&&!status.heldAt;},validateAuthority:context=>{f.host.agent.validateAuthority(context);},baseCapabilities:intent=>f.host.getBaseCapabilities(intent)});f.host.setOwnerControls(controls);
  const accepted=await f.admit(message('1','Подготовь обзор')),taskId=accepted.taskId!;const proposal=await controls.proposeSources({context:await f.host.agent.refreshAuthority(taskId),sources:[{accountId:'a',peerId:'remote',label:'Exact channel',kind:'channel'}],monitor:true});
  const card=message('card','Карточка источника',{agentEffectId:'card'});f.host.agent.store.put('ownOutputs',key(card.ref),{ref:card.ref,taskId,effectId:'card'});f.telegram.messages.set(key(card.ref),card);controls.registerCard(proposal.id,card.ref);const approval=message('2','да',{replyTo:card.ref});await f.admit(approval);assert.ok(f.host.getReadPeers(taskId).includes('remote'));
  now.setTime(now.getTime()+4*60*60*1000);const edit={...approval,kind:'edit' as const,id:'stale-approval-edit',text:'читай @another_source',editedAt:new Date(now.getTime()-60*60*1000).toISOString()};assert.equal((await f.admit(edit)).disposition,'held');assert.ok(!f.host.getReadPeers(taskId).includes('remote'));const grant=f.host.agent.store.get<{capabilities:{capability:string;resources:string[]}[]}>('grants',f.host.agent.status(taskId)!.intent.grantId)!;assert.ok(!grant.capabilities.some(item=>item.capability==='telegram.history'&&item.resources.includes('remote')));assert.ok(!f.host.getMonitorPolicies(taskId).length);
 }finally{await f.close();}
});

test('public-origin private monitor context requires exact trusted job plus current owner policy, preserving expired public write fence',async()=>{
 const runId='cron:exact-native-job:known-execution',f=await fixture({isPrivateMonitorExecution:context=>context.runId===runId});try{
  const controls=new OwnerControlService({store:f.host.agent.store,accountId:'a',ownerId:'owner',controlPeerId:'control',telegram:{getMessage:ref=>f.telegram.getMessage(ref),resolveSource:async()=>({accountId:'a',peerId:'remote',label:'Exact channel',kind:'channel'}),resolveForwardSource:async()=>undefined,verifyPeer:async peer=>peer},taskIntent:id=>f.host.agent.status(id)?.intent,taskActive:id=>{const status=f.host.agent.status(id);return!!status&&!status.cancelledAt&&!status.heldAt;},validateAuthority:context=>{f.host.agent.validateAuthority(context);},baseCapabilities:intent=>f.host.getBaseCapabilities(intent)});f.host.setOwnerControls(controls);
  const accepted=await f.admit(message('1','/бро --here Подготовь сводку',{ref:{accountId:'a',peerId:'public-origin',messageId:'1'}})),taskId=accepted.taskId!;
  const context=await f.host.agent.refreshAuthority(taskId),proposal=await controls.proposeSources({context,sources:[{accountId:'a',peerId:'remote',label:'Exact channel',kind:'channel'}],monitor:true});
  const card=message('card','Карточка наблюдения',{agentEffectId:'card'});f.host.agent.store.put('ownOutputs',key(card.ref),{ref:card.ref,taskId,effectId:'card'});f.telegram.messages.set(key(card.ref),card);controls.registerCard(proposal.id,card.ref);await f.admit(message('2','да',{replyTo:card.ref}));
  const current=await f.host.agent.refreshAuthority(taskId),execution={...current,runId};assert.throws(()=>f.host.prepareExecutionContext(execution),/private|authorized/);assert.throws(()=>f.host.prepareExecutionContext({...execution,runId:'cron:forged-job:execution'},{privateMonitor:true}),/private|authorized/);
  const intent=f.host.agent.status(taskId)!.intent,grant=f.host.agent.store.get('grants',intent.grantId);f.host.agent.store.put('originDeadlines',taskId,{taskId,peerId:'public-origin',expiresAt:new Date(Date.now()-1).toISOString()});f.host.prepareExecutionContext(execution,{privateMonitor:true});assert.match(f.host.getExecutionContext(execution).text,/маршрут control/);assert.equal(f.host.agent.status(taskId)!.intent.route.peerId,'public-origin');assert.deepEqual(f.host.agent.store.get('grants',intent.grantId),grant);
  const token=f.host.agent.issueExecutionContext(execution);await assert.rejects(f.host.agent.executeEffect(token,{id:'blocked-public-write',capability:'telegram.send',resource:'public-origin',payload:{peerId:'public-origin',text:'must not send'}}),/deadline|expired/);const notice=await f.host.agent.executeEffect(token,{id:'private-monitor-alert',capability:'telegram.send',resource:'control',payload:{peerId:'control',text:'Current private observation'}});assert.equal(notice.state,'verified');assert.ok(f.telegram.effects.every(effect=>effect.resource==='control'));
 }finally{await f.close();}
});

test('durably accepted task acknowledgement precedes a slow engine admission and is not sent again after binding',async()=>{
 const f=await fixture();let release!:()=>void;try{
  const submitted=f.engine.submit.bind(f.engine),gate=new Promise<void>(resolve=>{release=resolve;});f.engine.submit=async input=>{const snapshot=await submitted(input);await gate;return snapshot;};const pending=f.admit(message('1','Подготовь материал'));
  for(let attempt=0;attempt<100&&f.engine.inputs.length===0;attempt++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(f.engine.inputs.length,1);assert.equal(f.telegram.effects.length,1);const taskId=f.host.agent.status()[0]!.intent.id;assert.ok(!effectText(f.telegram.effects[0]!).includes(taskId));assert.match(effectText(f.telegram.effects[0]!),/Понял, бро/);assert.equal(f.host.agent.status(taskId)!.admission?.state,'reserved');assert.equal(f.host.agent.store.list<{state:string}>('hostLifecycleNotices')[0]!.state,'verified');release();assert.equal((await pending).taskId,taskId);assert.equal(f.telegram.effects.length,1);
 }finally{release?.();await f.close();}
});
