// Canonical TS session/wire with controlled ChildProcess-shaped EventEmitter
// and actual Node private stream endpoints; no real process/model/Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,writeFileSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {startOwnedEpoch} from './rm-0032-standing-epoch-owner.mjs';
import {normalizeEpochOwnerRecord,normalizeSupervisorResult} from './rm-0032-standing-epoch-receipt.mjs';
import {scopedRuntimeFixture} from './rm-0032-standing-scoped-runtime-fixture.mjs';
const build=resolve(process.env.NEUROBRO_GATEWAY_BUILD??'packages/telegram-gateway/dist');
const {createEpochWire}=await import(pathToFileURL(resolve(build,'src/standing-epoch-wire.js')));
const {openStandingEpochSession}=await import(pathToFileURL(resolve(build,'src/standing-epoch-session.js')));
const {openStandingScopedEpochSession}=await import(pathToFileURL(resolve(build,'src/standing-scoped-epoch-session.js')));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const raw=Buffer.from('public source fixture'),length=Buffer.alloc(4);length.writeUInt32BE(raw.length);
const bootstrap=Buffer.concat([length,Buffer.from(createHash('sha256').update(raw).digest('hex')),raw]);
function proof(turns=0,unknown=false){
  const custody={initialize:true,profile:true,controlsPassed:true,relayAfter:true,probePass:Array(9).fill(true),probeExitCodes:[0,20,20,22,22,20,40,30,61],accountChatgpt:true,astraMedium:true};
  const capabilities={checked:true,imageGeneration:true,namespaceTools:false,webSearch:false};
  const facts={threadStarted:turns>0,poisoned:unknown,busy:false,turnsAttempted:turns,toolCalls:0,schema:'neurobro-native-image-epoch-v1',turnsAdmitted:turns,turnLimit:16,epochSeconds:900,turnSeconds:300,running:false,releasePending:false,closed:true,resourceSettlementObserved:false,unreleasedTurn:unknown};
  return {schema:'decadans.rm0032.standing-epoch.v1',outcome:unknown?'unknown':'observed',code:unknown?'SESSION_UNKNOWN':'OK',stage:'complete',injectedPorts:false,
    limits:{prepSeconds:120,epochSeconds:900,cleanupSeconds:35,turnLimit:16,threadLimit:1,history:true,images:true,syntheticOnly:false},custody,capabilities,
    native:{admitted:true,threadStartDispatches:Number(turns>0),turnStartDispatches:turns,threadAcknowledged:turns>0},
    session:{custodyPublished:true,ready:true,closed:true,code:'CLOSED',facts},
    diagnostics:{originalCode:unknown?'SESSION_UNKNOWN':'OK',originalStage:'complete',cleanupUnknown:false,rpcCode:unknown?'TRANSPORT_UNKNOWN':'OK',rpcSite:'none',rpcOperation:'none',idleFailure:null},
    appServer:{launched:true,stdinClosed:true,stdoutEof:true,reaped:true,exitCode:0,stderrBytes:0,stderrComplete:true,transportUnknown:unknown}};
}
function supervisor(client){return {schema:'standing-epoch-supervisor-v1',outcome:client.outcome==='observed'?'observed':'unknown',stage:'complete',preflight:true,custodyReady:true,clientNaturalSettlement:true,relaySettled:true,allProcessesSettled:true,settled:true,injectedPorts:false,
  clientExit:client.outcome==='observed'?0:1,relayExit:0,clientStdoutBytes:1000,clientStderrBytes:0,relayStdoutBytes:150,relayStderrBytes:0,client,
  relay:{version:1,settled:true,counters:{accepted:1,over_limit:0,refused:0,connected:1,completed:1,failed:0,cancelled:0,internal_error:0}}};}

class Child extends EventEmitter {
  constructor(mode='ok'){
    super();this.mode=mode;this.stdin=new PassThrough();this.stdout=new PassThrough();this.stderr=new PassThrough();
    this.bytes=Buffer.alloc(0);this.bootstrapped=false;this.sent=[];this.turns=0;this.pending=false;this.kills=0;this.exited=false;
    this.stdin.on('data',data=>this.consume(data));
    this.stdin.on('finish',()=>{
      this.stdout.end();this.stderr.end();
      setImmediate(()=>{this.exited=true;const code=this.mode==='unknown'?1:0;this.emit('exit',code,null);this.emit('close',code,null);});
    });
  }
  output(value){this.stdout.write(JSON.stringify(value)+'\n');}
  consume(data){
    this.bytes=Buffer.concat([this.bytes,data]);
    if(!this.bootstrapped){
      const expected=this.expectedBootstrap??bootstrap;
      if(this.bytes.length<expected.length)return;
      assert.deepEqual(this.bytes.subarray(0,expected.length),expected);this.bytes=this.bytes.subarray(expected.length);this.bootstrapped=true;
      const p=proof();this.output({kind:'custodyReady',proof:{custody:{...p.custody,relayAfter:false},capabilities:p.capabilities}});
      this.output(this.mode==='extra'?{kind:'ready',tools:['neurobro_read_history','neurobro_group_info']}:{kind:'ready'});
    }
    for(;;){const end=this.bytes.indexOf(10);if(end<0)return;const frame=JSON.parse(this.bytes.subarray(0,end));this.bytes=this.bytes.subarray(end+1);this.sent.push(frame);this.frame(frame);}
  }
  complete(requestRef){
    const scope={requestRef,threadId:'thread-1',turnId:'turn-'+this.turns,turnNumber:this.turns};
    this.output({kind:'scope',scope});this.output({kind:'completed',scope,answer:'Приватный ответ',kindOfAnswer:'text',toolCalls:['history','extra'].includes(this.mode)?1:0,toolRefusals:0});
  }
  frame(frame){
    if(frame.kind==='turn'){
      this.turns++;this.pending=true;
      if(this.mode==='history')this.output({kind:'tool',requestRef:frame.requestRef,callRef:'call-'+this.turns,arguments:{fromDate:1,toDate:200,cursor:null}});
      else if(this.mode==='extra')this.output({kind:'tool',requestRef:frame.requestRef,callRef:'call-'+this.turns,name:'neurobro_group_info',arguments:{group:true}});
      else this.complete(frame.requestRef);
    }else if(frame.kind==='toolResult')this.complete(frame.requestRef);
    else if(frame.kind==='release'){this.pending=false;this.output({kind:'released',requestRef:frame.requestRef,delivery:frame.delivery});}
    else if(frame.kind==='close'){
      const p=proof(this.turns,this.mode==='unknown'||this.pending),s=supervisor(p);
      this.output({kind:'closed',code:'CLOSED',facts:p.session.facts});
      this.output({kind:'epochResult',receipt:p});
      if(this.mode==='mismatch')s.client={...structuredClone(p),capabilities:{...p.capabilities,namespaceTools:true}};
      if(this.mode==='unsettled')s.outcome='unknown',s.settled=false,s.allProcessesSettled=false;
      if(this.mode==='injected')s.injectedPorts=true;
      this.output({kind:'supervisorResult',receipt:s});
      if(this.mode==='trailing')this.output({kind:'extra'});
      if(this.mode==='partial')this.stdout.write('{');
      if(this.mode==='late-error')queueMicrotask(()=>this.stdin.emit('error',new Error('private error')));
    }
  }
  kill(){this.kills++;return false;}
}
async function fixture(mode='ok',extras={}){
  const child=new Child(mode),records=[],control=new AbortController();let spawned=0;
  const owner=await startOwnedEpoch({epochId:'a'.repeat(32),bootstrap,signal:control.signal,history:{call:async()=>({success:true,contentItems:[{type:'inputText',text:'{}'}]})},
    spawnChild:()=>{spawned++;return child;},createWire:createEpochWire,openSession:openStandingEpochSession,
    recordFinal:async(value,timeout)=>{assert.ok(timeout>0&&timeout<=1000);records.push(normalizeEpochOwnerRecord(value,'a'.repeat(32)));},...extras});
  return {owner,child,records,control,spawned};
}

const analysisNames=['neurobro_analysis_material','neurobro_analysis_notes','neurobro_analysis_commit'];
const analysisInput=JSON.stringify({schema:'neurobro-history-analysis-input-v1',kind:'leaf',objective:'Read bound material',materialAvailable:true});
class ScopedChild extends Child {
  constructor(mode='ok'){super(mode);this.local={conversation:0,'history-analysis':0};this.calls={conversation:0,'history-analysis':0};this.current=null;}
  output(value){
    if(value.kind==='ready')value={kind:'ready',protocol:'standing-scoped-epoch-v1',scopes:[{purpose:'conversation',tools:['neurobro_read_history']},{purpose:'history-analysis',tools:analysisNames}]};
    if(value.kind==='custodyReady')value.proof.capabilities.webSearch=true;
    super.output(value);
  }
  receipt(){
    const p=proof(this.turns,this.pending),started=Object.values(this.local).filter(n=>n>0).length;
    p.schema='decadans.rm0032.standing-scoped-epoch.v1';p.limits.threadLimit=2;p.capabilities.webSearch=true;
    p.native={admitted:true,threadStartDispatches:started,turnStartDispatches:this.turns,threadsAcknowledged:started,
      slotWeb:['conversation','history-analysis'].map(purpose=>({purpose,turnsAttempted:this.local[purpose],admitted:0,completed:0,search:0,openPage:0,findInPage:0,other:0}))};
    Object.assign(p.session.facts,{schema:'neurobro-native-scoped-epoch-v1',threadLimit:2,threadStartDispatches:started,turnStartDispatches:this.turns,
      toolCalls:this.calls.conversation+this.calls['history-analysis'],slots:['conversation','history-analysis'].map(purpose=>({purpose,threadStarted:this.local[purpose]>0,
        turnsAdmitted:this.local[purpose],turnsAttempted:this.local[purpose],toolCalls:this.calls[purpose],closed:true,poisoned:this.pending&&this.current.purpose===purpose}))});
    return p;
  }
  complete(){const f=this.current,scope={purpose:f.purpose,requestRef:f.requestRef,threadId:'thread-'+f.purpose,turnId:'turn-'+this.turns,turnNumber:this.turns,threadTurnNumber:this.local[f.purpose]};
    this.output({kind:'scope',scope});this.output({kind:'completed',scope,answer:'Bound internal result',kindOfAnswer:'text',toolCalls:f.purpose==='history-analysis'?1:0,toolRefusals:0});}
  frame(frame){
    if(frame.kind==='turn'){
      this.turns++;this.local[frame.purpose]++;this.current=frame;this.pending=true;
      if(frame.purpose==='history-analysis'){this.calls[frame.purpose]++;this.output({kind:'tool',purpose:frame.purpose,requestRef:frame.requestRef,callRef:'call-'+this.turns,name:analysisNames[0],arguments:{}});}
      else this.complete();
    }else if(frame.kind==='toolResult')this.complete();
    else if(frame.kind==='release'){this.pending=false;this.output({kind:'released',purpose:frame.purpose,requestRef:frame.requestRef,delivery:frame.delivery});}
    else if(frame.kind==='close'){
      const p=this.receipt();this.output({kind:'closed',code:'CLOSED',facts:p.session.facts});
      const terminal=this.mode==='wrong-tag'?proof(this.turns):p;
      this.output({kind:'epochResult',receipt:terminal});this.output({kind:'supervisorResult',receipt:supervisor(terminal)});
    }
  }
}
async function scopedFixture(options={}){
  const child=new ScopedChild(options.mode),records=[],control=new AbortController();
  const tools=analysisNames.map(name=>({name,call:options.call??(async()=>({success:true,contentItems:[{type:'inputText',text:'{}'}]}))}));
  const owner=await startOwnedEpoch({epochId:'b'.repeat(32),bootstrap,signal:control.signal,history:{call:async()=>({success:true,contentItems:[{type:'inputText',text:'{}'}]})},
    sessionMode:'standing-scoped-epoch-v1',analysisTools:tools,onToolResultSent:options.shown??(()=>{}),
    spawnChild:()=>child,createWire:createEpochWire,openSession:openStandingScopedEpochSession,recordFinal:async value=>{records.push(normalizeEpochOwnerRecord(value));}});
  return {owner,child,records,control};
}
test('scoped owner shares one child across C A C and persists tagged diagnostics after actual stream settlement',async()=>{
  let shown=0;const f=await scopedFixture({shown:event=>{assert.equal(event.purpose,'history-analysis');shown++;}});
  assert.equal(typeof f.owner.turn,'undefined');
  await f.owner.turnConversation('c1','question');await f.owner.releaseConversation('c1','verified');
  assert.equal((await f.owner.turnAnalysis('a1',analysisInput)).kind,'analysis');await f.owner.releaseAnalysis('a1');
  await f.owner.turnConversation('c2','question');await f.owner.releaseConversation('c2','not-sent');
  const result=await f.owner.close();assert.equal(result.persisted,true);assert.equal(result.resourcesSettled,true);assert.equal(result.successfulEpoch,true);
  assert.equal(shown,1);assert.equal(f.child.kills,0);assert.equal(f.records.length,1);
  assert.equal(f.records[0].diagnostics.epoch.schema,'decadans.rm0032.standing-scoped-epoch.v1');
  assert.deepEqual(f.records[0].diagnostics.epoch.session.facts.slots.map(s=>s.turnsAdmitted),[2,1]);
  assert.equal(JSON.stringify(f.records).includes('Bound internal result'),false);
});
test('scoped owner rejects mismatched receipt mode without turning physical cleanup into replacement permission',async()=>{
  const f=await scopedFixture({mode:'wrong-tag'});await f.owner.turnConversation('c1','question');await f.owner.releaseConversation('c1','not-sent');
  const result=await f.owner.close();assert.equal(result.persisted,true);assert.equal(result.resourcesSettled,false);assert.equal(result.replacementReady,false);assert.equal(result.outcome,'unknown');
});
test('scoped owner close joins actual task callback and shown acknowledgement before final recording',async()=>{
  for(const stage of ['handler','hook']){
    const entered=deferred(),done=deferred();let signal;
    const f=await scopedFixture(stage==='handler'?{call:async(_args,scope)=>{signal=scope.signal;entered.resolve();await done.promise;return {success:true,contentItems:[{type:'inputText',text:'{}'}]};}}:
      {shown:async()=>{entered.resolve();await done.promise;}});
    const failure=assert.rejects(f.owner.turnAnalysis('a1',analysisInput));await entered.promise;
    const closing=f.owner.close();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.records.length,0);if(signal)assert.equal(signal.aborted,true);
    done.resolve();await failure;const result=await closing;assert.equal(result.activeJoined,true);assert.equal(result.persisted,true);assert.equal(f.records.length,1);
    assert.equal(f.child.sent.filter(v=>v.kind==='toolResult').length,stage==='handler'?0:1);
  }
});
test('scoped mode and task callbacks are inert captured inputs before spawn',async()=>{
  let called=0;const base={epochId:'b'.repeat(32),bootstrap,signal:new AbortController().signal,history:{call:async()=>({})},spawnChild:()=>{called++;throw Error();},
    createWire:createEpochWire,openSession:openStandingScopedEpochSession,recordFinal:async()=>{},sessionMode:'standing-scoped-epoch-v1',
    analysisTools:analysisNames.map(name=>({name,call:async()=>({})})),onToolResultSent:()=>{}};
  for(const key of ['sessionMode','analysisTools','onToolResultSent']){
    const input={...base};Object.defineProperty(input,key,{get(){called++;throw Error();},enumerable:true});await assert.rejects(startOwnedEpoch(input));
  }
  for(const extra of [{sessionMode:undefined},{analysisTools:[]},{extraTools:[{name:analysisNames[0],call:async()=>({})}]},
    {extraTools:Array.from({length:29},(_,i)=>({name:'neurobro_extra_'+i,call:async()=>({})}))},
    {onToolResultSent:new Proxy(()=>{},{apply(){called++;throw Error();}})}])await assert.rejects(startOwnedEpoch({...base,...extra}));
  assert.equal(called,0);
});

const taskCallbacks=(call=async()=>({success:true,contentItems:[{type:'inputText',text:'{}'}]}),shown=()=>{})=>({analysisTools:analysisNames.map(name=>({name,call})),onToolResultSent:shown});
test('actual runtime owner session shares C A B C and locks epoch across reservation without rebinding stale callbacks',async()=>{
  const f=await scopedRuntimeFixture();let a=0,b=0,shown=0;
  try{
    await f.connection.prepare();await f.connection.turn('c1','question');await f.connection.release('c1','not-sent');
    const lease=await f.connection.acquireAnalysisAdmission('a1');assert.equal(f.connection.state().busy,true);
    await assert.rejects(f.connection.prepare());await assert.rejects(f.connection.turn('excluded','question'));await assert.rejects(f.connection.acquireAnalysisAdmission('other'));
    assert.equal(lease.nativeBinding.epochId,f.ownerInputs[0].epochId);
    const callbacks=taskCallbacks(async()=>{a++;return {success:true,contentItems:[{type:'inputText',text:'{}'}]};},event=>{shown++;assert.equal(Object.hasOwn(event,'purpose'),false);});
    const turning=lease.turnAnalysis('a1',analysisInput,callbacks);callbacks.analysisTools[0].call=async()=>{throw Error('mutated handler');};
    await turning;await lease.releaseAnalysis('a1');await lease.close();
    await assert.rejects(f.connection.acquireAnalysisAdmission('bad',{...lease.nativeBinding,requestRef:'never-released'}));
    const next=await f.connection.acquireAnalysisAdmission('b1',lease.nativeBinding);
    const work=next.turnAnalysis('b1',analysisInput,taskCallbacks(async()=>{b++;return {success:true,contentItems:[{type:'inputText',text:'{}'}]};}));await work;
    await assert.rejects(f.ownerInputs[0].analysisTools[0].call({}, {requestRef:'a1',callRef:'stale',signal:f.control.signal}));
    await next.releaseAnalysis('b1');await next.close();await f.connection.turn('c2','question');await f.connection.release('c2','verified');
    const result=await f.connection.close();assert.equal(result.resourcesSettled,true);assert.equal(result.persisted,true);
    assert.equal(f.children.length,1);assert.deepEqual([a,b,shown],[1,1,1]);
    const record=JSON.parse(readFileSync(resolve(f.parent,lease.nativeBinding.epochId,'actual.json'),'utf8'));
    assert.deepEqual(record.diagnostics.epoch.session.facts.slots.map(s=>s.turnsAdmitted),[2,2]);
    const verified=await f.runtime.verifyAnalysisSettlement(lease.nativeBinding);assert.equal(verified.modelOutcome,'not-proven');assert.deepEqual(verified.nativeBinding,lease.nativeBinding);
    assert.equal(JSON.stringify(record).includes('"requestRef"'),false);
  }finally{await f.connection.close();f.cleanup();}
});
test('unused lease close leaves owner prepared; consumed cancellation joins callback and exact persisted owner before restoration',async()=>{
  const f=await scopedRuntimeFixture(),entered=deferred(),done=deferred();let capturedSignal;
  try{
    await f.connection.prepare();const unused=await f.connection.acquireAnalysisAdmission('unused');await unused.close();await unused.close();
    assert.equal((await f.connection.prepare()).restoration,true);assert.equal(f.children.length,1);
    const lease=await f.connection.acquireAnalysisAdmission('a1'),failure=assert.rejects(lease.turnAnalysis('a1',analysisInput,taskCallbacks(async(_args,scope)=>{
      capturedSignal=scope.signal;entered.resolve();await done.promise;return {success:true,contentItems:[{type:'inputText',text:'{}'}]};})));
    await entered.promise;let settled=false;const stopping=lease.abortAndJoin().then(proof=>{settled=true;return proof;});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(capturedSignal.aborted,true);assert.equal(settled,false);await assert.rejects(f.connection.prepare());
    done.resolve();await failure;const proof=await stopping;assert.deepEqual(proof.nativeBinding,lease.nativeBinding);assert.equal(proof.modelOutcome,'not-proven');await lease.close();
    assert.equal(f.connection.state().failedTurn,false);assert.equal(f.connection.state().failedAnalysisTurn,true);
    assert.equal(f.children[0].sent.filter(v=>v.kind==='toolResult').length,0);
    assert.equal((await f.connection.prepare()).restoration,true);const next=await f.connection.acquireAnalysisAdmission('a2',lease.nativeBinding);await next.close();
    assert.equal(f.children.length,2);await f.connection.close();
  }finally{done.resolve();await f.connection.close();f.cleanup();}
});
test('cold owner verification binds strict stored scoped intent and actual record without claiming model observation',async()=>{
  const f=await scopedRuntimeFixture();let binding;
  try{
    await f.connection.prepare();const lease=await f.connection.acquireAnalysisAdmission('a1');binding=lease.nativeBinding;
    await lease.turnAnalysis('a1',analysisInput,taskCallbacks());await lease.releaseAnalysis('a1');await lease.close();await f.connection.close();
    const cold=f.make();assert.deepEqual((await cold.verifyAnalysisSettlement(binding)).nativeBinding,binding);
    const path=resolve(f.parent,binding.epochId,'actual.json'),bytes=readFileSync(path),record=JSON.parse(bytes.toString());
    writeFileSync(path,JSON.stringify({...record,epochId:'f'.repeat(32)})+'\n');await assert.rejects(cold.verifyAnalysisSettlement(binding));writeFileSync(path,bytes);
    const intentPath=resolve(f.parent,binding.epochId,'intent.json'),intentBytes=readFileSync(intentPath),intent=JSON.parse(intentBytes.toString());
    for(const patch of [{threadLimit:1},{sessionMode:'legacy'},{token:'f'.repeat(32)}]){writeFileSync(intentPath,JSON.stringify({...intent,...patch})+'\n');await assert.rejects(cold.verifyAnalysisSettlement(binding));}
    writeFileSync(intentPath,intentBytes);
    await assert.rejects(cold.verifyAnalysisSettlement({...binding,purpose:'conversation'}));await assert.rejects(cold.verifyAnalysisSettlement({...binding,epochId:'../foreign'}));
    const c=cold.openConnection({signal:new AbortController().signal,history:{call:async()=>({})}});await c.prepare();
    const next=await c.acquireAnalysisAdmission('next',binding);await next.close();await c.close();
  }finally{await f.connection.close();f.cleanup();}
});
test('background prepare preserves conversation restoration until successful foreground completion and resets on rotation',async()=>{
  const f=await scopedRuntimeFixture();
  try{
    assert.equal((await f.connection.prepare()).restoration,true);
    const first=await f.connection.acquireAnalysisAdmission('a1');await first.turnAnalysis('a1',analysisInput,taskCallbacks());await first.releaseAnalysis('a1');await first.close();
    assert.equal((await f.connection.prepare()).restoration,true);await f.connection.turn('c1','restored conversation');await f.connection.release('c1','verified');
    assert.equal((await f.connection.prepare()).restoration,false);
    for(let n=2;n<=5;n++){const lease=await f.connection.acquireAnalysisAdmission('a'+n);await lease.turnAnalysis('a'+n,analysisInput,taskCallbacks());await lease.releaseAnalysis('a'+n);await lease.close();}
    assert.equal((await f.connection.prepare()).restoration,true);assert.equal(f.children.length,2);
    assert.equal((await f.connection.prepare()).restoration,true);
  }finally{await f.connection.close();f.cleanup();}
});
test('analysis readiness distinguishes exact warm release from persisted owner settlement',async()=>{
  const f=await scopedRuntimeFixture();let coldConnection;
  try{
    await f.connection.prepare();const lease=await f.connection.acquireAnalysisAdmission('ready-a1'),binding=lease.nativeBinding;
    await assert.rejects(f.connection.verifyAnalysisReady(binding));
    await lease.turnAnalysis('ready-a1',analysisInput,taskCallbacks());await assert.rejects(f.connection.verifyAnalysisReady(binding));
    await lease.releaseAnalysis('ready-a1');await lease.close();
    const ready=await f.connection.verifyAnalysisReady(binding);
    assert.deepEqual(ready,{schema:'standing-analysis-owner-ready-v1',nativeBinding:binding,basis:'released-current-owner',modelOutcome:'not-proven'});
    assert.ok(Object.isFrozen(ready)&&Object.isFrozen(ready.nativeBinding));
    assert.equal(Object.hasOwn(ready,'resourcesSettled'),false);assert.equal(f.children[0].exited,false);
    for(const wrong of [{...binding,requestRef:'never-issued'},{...binding,epochId:'f'.repeat(32)},{...binding,purpose:'conversation'}])await assert.rejects(f.connection.verifyAnalysisReady(wrong));
    const unused=await f.connection.acquireAnalysisAdmission('unused');await unused.close();await assert.rejects(f.connection.verifyAnalysisReady(unused.nativeBinding));
    await f.connection.close();
    const cold=f.make();coldConnection=cold.openConnection({signal:new AbortController().signal,history:{call:async()=>({})}});
    const persisted=await coldConnection.verifyAnalysisReady(binding);
    assert.deepEqual(persisted,{schema:'standing-analysis-owner-ready-v1',nativeBinding:binding,basis:'persisted-owner-settlement',modelOutcome:'not-proven'});
    assert.equal(f.children.length,1); // Verification does not prepare another owner.
  }finally{await coldConnection?.close();await f.connection.close();f.cleanup();}
});

test('bootstrap custody two turns final proofs actual stream EOF/child events and one durable record',async()=>{
  const f=await fixture();
  for(let i=1;i<=2;i++){await f.owner.turn('request-'+i,'question');await f.owner.release('request-'+i,'verified');}
  const [a,b]=await Promise.all([f.owner.close(),f.owner.close()]);assert.equal(a,b);
  assert.equal(a.successfulEpoch,true);assert.equal(a.resourcesSettled,true);assert.equal(a.persisted,true);assert.equal(a.replacementReady,true);
  assert.equal(f.child.exited,true);assert.equal(f.child.kills,0);assert.equal(f.spawned,1);assert.equal(f.records.length,1);
  assert.equal(f.child.sent.filter(x=>x.kind==='close').length,1);assert.equal(a.wireCleanEof,true);
  assert.equal(JSON.stringify(f.records).includes('Приватный'),false);
});
test('unknown old turn with exact settled resources permits only a new epoch',async()=>{
  const f=await fixture('unknown');await f.owner.turn('old','question');await f.owner.release('old','verified');const result=await f.owner.close();
  assert.equal(result.successfulEpoch,false);assert.equal(result.outcome,'unknown');assert.equal(result.resourcesSettled,true);assert.equal(result.replacementReady,true);
  await assert.rejects(f.owner.turn('retry','old'));assert.equal(f.child.sent.filter(x=>x.kind==='turn').length,1);
});

// Actual canonical reader/session retain strict terminal metadata even when
// the inner sequence fails. Only separate complete physical proof may recover.
test('missing inner closure or receipt needs full physical proof before replacement',async()=>{
  for(const mode of ['missing-both','missing-epoch','missing-closed','physical-only']){
    const f=await fixture();const frame=f.child.frame.bind(f.child);
    f.child.frame=value=>{
      if(value.kind!=='close')return frame(value);
      const p=proof(),s=supervisor(p);
      s.outcome='unknown';s.stage='session';s.clientExit=1;
      if(mode!=='missing-closed'){
        s.client=null;s.clientNaturalSettlement=false;s.relaySettled=false;s.relay=null;
      }
      if(mode==='physical-only')s.physicalCleanup={clientLaunchCaptured:true,relayLaunchCaptured:true,creationsJoined:true,ownershipKnown:true,
        clientUnitAbsent:true,relayUnitAbsent:true,unitChecksAfterCreations:true,transportsJoined:true,stdinClosed:true,stdoutEof:true,
        stderrEof:true,sessionTasksJoined:true,clientStopRequested:false,relayStopRequested:true,transportKillRequested:false,complete:true};
      if(mode==='missing-epoch')f.child.output({kind:'closed',code:'CLOSED',facts:p.session.facts});
      if(mode==='missing-closed')f.child.output({kind:'epochResult',receipt:p});
      f.child.output({kind:'supervisorResult',receipt:normalizeSupervisorResult(s)});
      f.child.stdout.end();f.child.stderr.end();
    };
    const result=await f.owner.close();
    assert.equal(result.processSettled,true);assert.equal(result.terminationDispatched,false);
    assert.equal(result.resourcesSettled,mode==='physical-only');assert.equal(result.replacementReady,mode==='physical-only');
    assert.equal(result.persisted,true);assert.equal(f.records.length,1);
    assert.equal(result.successfulEpoch,false);assert.equal(result.wireCleanEof,true);
    assert.equal(f.records[0].diagnostics.supervisor.clientExit,1);
    assert.equal(f.records[0].diagnostics.epoch!==null,mode==='missing-closed');
    if(mode==='physical-only')assert.equal(f.records[0].diagnostics.supervisor.physicalCleanup.complete,true);
    assert.equal(f.child.sent.filter(value=>value.kind==='close').length,1);
    await assert.rejects(f.owner.turn('later-distinct','new question'));
  }
});

test('physical recovery rejects lost custody, injected nested receipts, missing evidence and failed persistence',async()=>{
  const evidence=['clientLaunchCaptured','relayLaunchCaptured','creationsJoined','ownershipKnown','clientUnitAbsent','relayUnitAbsent',
    'unitChecksAfterCreations','transportsJoined','stdinClosed','stdoutEof','stderrEof','sessionTasksJoined'];
  for(const mode of ['valid','persist-failed','preflight','custodyReady','outer-injected','nested-injected','epoch-injected','mismatched','missing-nested',...evidence]){
    const f=await fixture('unknown',mode==='persist-failed'?{recordFinal:async()=>{throw Error('synthetic persistence failure');}}:{});
    const frame=f.child.frame.bind(f.child);
    f.child.frame=value=>{
      if(value.kind!=='close')return frame(value);
      const s=supervisor(proof());s.outcome='unknown';s.clientExit=1;s.client=null;
      s.clientNaturalSettlement=false;s.relaySettled=false;s.relay=null;
      s.physicalCleanup={...Object.fromEntries(evidence.map(k=>[k,true])),clientStopRequested:true,relayStopRequested:true,transportKillRequested:true,complete:true};
      if(evidence.includes(mode)){s.physicalCleanup[mode]=false;s.physicalCleanup.complete=false;}
      if(['preflight','custodyReady'].includes(mode))s[mode]=false;
      if(mode==='outer-injected')s.injectedPorts=true;
      if(mode==='nested-injected')s.client={...proof(),injectedPorts:true};
      if(['epoch-injected','mismatched','missing-nested'].includes(mode)){
        const p=proof();s.client=structuredClone(p);
        if(mode==='epoch-injected')p.injectedPorts=true;
        if(mode==='mismatched')s.client.capabilities.namespaceTools=true;
        if(mode==='missing-nested')s.client=null;
        f.child.output({kind:'epochResult',receipt:p});
      }
      f.child.output({kind:'supervisorResult',receipt:s});f.child.stdout.end();f.child.stderr.end();
    };
    const result=await f.owner.close();
    assert.equal(result.outcome,'unknown',mode);assert.equal(result.successfulEpoch,false,mode);
    assert.equal(result.resourcesSettled,['valid','persist-failed'].includes(mode),mode);
    assert.equal(result.replacementReady,mode==='valid',mode);
    assert.equal(result.persisted,mode!=='persist-failed',mode);
    assert.equal(f.child.kills,0,mode);
    if(mode==='valid'){
      for(const key of ['bootstrapJoined','activeJoined','processSettled','stdoutEnded','stderrEnded','wireCleanEof']){
        const invalid=structuredClone(f.records[0]);invalid[key]=false;
        assert.throws(()=>normalizeEpochOwnerRecord(invalid),key);
      }
    }
  }
});

test('diagnostic terminal capture rejects malformed duplicate reversed mismatched and trailing controls',async()=>{
  for(const mode of ['malformed','duplicate-supervisor','duplicate-epoch','reversed','mismatch','trailing','partial']){
    const f=await fixture(),original=f.child.frame.bind(f.child);
    f.child.frame=value=>{
      if(value.kind!=='close')return original(value);
      const p=proof(),s=supervisor(p);
      s.physicalCleanup={clientLaunchCaptured:true,relayLaunchCaptured:true,creationsJoined:true,ownershipKnown:true,
        clientUnitAbsent:true,relayUnitAbsent:true,unitChecksAfterCreations:true,transportsJoined:true,stdinClosed:true,stdoutEof:true,
        stderrEof:true,sessionTasksJoined:true,clientStopRequested:false,relayStopRequested:true,transportKillRequested:false,complete:true};
      // Missing closed deliberately selects only the diagnostic fallback.
      if(mode==='reversed'){
        f.child.output({kind:'supervisorResult',receipt:s});f.child.output({kind:'epochResult',receipt:p});
      }else{
        f.child.output({kind:'epochResult',receipt:p});
        if(mode==='duplicate-epoch')f.child.output({kind:'epochResult',receipt:p});
        if(mode==='mismatch')s.client={...structuredClone(p),capabilities:{...p.capabilities,namespaceTools:true}};
        if(mode==='malformed')s.rawText='private rejected metadata';
        f.child.output({kind:'supervisorResult',receipt:s});
        if(mode==='duplicate-supervisor')f.child.output({kind:'supervisorResult',receipt:s});
        if(mode==='trailing')f.child.output({kind:'ready'});
        if(mode==='partial')f.child.stdout.write('{');
      }
      f.child.stdout.end();f.child.stderr.end();
    };
    const result=await f.owner.close();
    assert.equal(result.resourcesSettled,false,mode);assert.equal(result.replacementReady,false,mode);
    assert.equal(result.successfulEpoch,false,mode);assert.equal(result.wireCleanEof,false,mode);
    assert.equal(result.persisted,true,mode);assert.equal(f.records.length,1,mode);
    assert.equal(JSON.stringify(f.records).includes('private rejected metadata'),false,mode);
    if(mode==='malformed')assert.equal(f.records[0].diagnostics.supervisor,null);
  }
});

test('failed session close joins active callback before diagnostic drain with one canonical reader',async()=>{
  const entered=deferred(),release=deferred();let readers=0,maximumReaders=0,terminalReads=0;
  const f=await fixture('history',{
    history:{call:async()=>{entered.resolve();await release.promise;return{success:true,contentItems:[{type:'inputText',text:'{}'}]};}},
    createWire:input=>{
      const wire=createEpochWire(input);
      return{...wire,send:(value,timeout)=>value.kind==='close'?Promise.reject(new Error('synthetic close write refusal')):wire.send(value,timeout),
        async receive(timeout){readers++;maximumReaders=Math.max(maximumReaders,readers);
          try{const value=await wire.receive(timeout);if(value.kind==='supervisorResult')terminalReads++;return value;}
          finally{readers--;}}
      };
    },
  });
  const rejected=assert.rejects(f.owner.turn('pending','question'));await entered.promise;
  const closing=f.owner.close();await new Promise(done=>setImmediate(done));
  const s=supervisor(proof());s.outcome='unknown';s.stage='session';s.client=null;s.clientExit=1;
  s.clientNaturalSettlement=false;s.relaySettled=false;s.relay=null;
  f.child.output({kind:'supervisorResult',receipt:s});f.child.stdout.end();f.child.stderr.end();
  await new Promise(done=>setImmediate(done));
  assert.equal(terminalReads,0);assert.equal(f.records.length,0);assert.equal(f.child.stdin.writableEnded,false);
  release.resolve();await rejected;const result=await closing;
  assert.equal(maximumReaders,1);assert.equal(terminalReads,1);assert.equal(readers,0);
  assert.equal(result.activeJoined,true);assert.equal(result.wireCleanEof,true);assert.equal(result.resourcesSettled,false);
  assert.equal(result.persisted,true);assert.equal(f.records[0].diagnostics.supervisor.clientExit,1);
  assert.equal(f.child.sent.some(value=>value.kind==='toolResult'),false);
});

test('diagnostic fallback joins the actual close-write callback before ending stdin or recording',async()=>{
  const f=await fixture(),original=f.child.stdin.write.bind(f.child.stdin);let written;
  const frame=f.child.frame.bind(f.child);
  f.child.frame=value=>{
    if(value.kind!=='close')return frame(value);
    const s=supervisor(proof());s.outcome='unknown';s.stage='session';s.client=null;s.clientExit=1;
    s.clientNaturalSettlement=false;s.relaySettled=false;s.relay=null;
    f.child.output({kind:'supervisorResult',receipt:s});
  };
  f.child.stdin.write=(bytes,callback)=>original(bytes,error=>{written=()=>callback(error);});
  const closing=f.owner.close();await new Promise(done=>setImmediate(done));
  assert.equal(typeof written,'function');assert.equal(f.child.stdin.writableEnded,false);assert.equal(f.records.length,0);
  written();const result=await closing;
  assert.equal(result.activeJoined,true);assert.equal(result.wireCleanEof,true);assert.equal(result.resourcesSettled,false);
  assert.equal(f.records[0].diagnostics.supervisor.clientExit,1);assert.equal(f.child.kills,0);
});

test('actual private-stream failure keeps original diagnostics through exclusive disk persistence',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'neurobro-owner-diagnostics-')),file=resolve(directory,'actual.json');
  try{
    const f=await fixture('unknown',{recordFinal:async value=>{
      const fixed=normalizeEpochOwnerRecord(value,'a'.repeat(32));
      writeFileSync(file,JSON.stringify(fixed),{flag:'wx',mode:0o600});
    }});
    const output=f.child.output.bind(f.child);
    f.child.output=value=>{
      const receipt=value.kind==='epochResult'?value.receipt:value.kind==='supervisorResult'?value.receipt.client:null;
      if(receipt){
        receipt.code='SHUTDOWN_UNKNOWN';receipt.stage='shutdown';
        receipt.diagnostics.originalCode='SESSION_UNKNOWN';receipt.diagnostics.originalStage='session';
        receipt.diagnostics.cleanupUnknown=true;
        receipt.diagnostics.rpcSite='deadline';receipt.diagnostics.rpcOperation='next_frame';
        receipt.diagnostics.idleFailure={code:'BOUNDS_REFUSED',site:'budget',operation:'observe',method:'thread/tokenUsage/updated',
          phase:'after-turn',frames:513,bytes:262145,poisoned:true,pendingResponses:0,lateRefusals:0};
      }
      output(value);
    };
    await f.owner.turn('one','private question');await f.owner.release('one','verified');
    const result=await f.owner.close();
    assert.equal(result.resourcesSettled,true);assert.equal(result.replacementReady,true);
    const bytes=readFileSync(file),saved=normalizeEpochOwnerRecord(JSON.parse(bytes),'a'.repeat(32));
    assert.ok(bytes.length<16384);assert.equal(bytes.includes('private question'),false);assert.equal(bytes.includes('Приватный ответ'),false);
    assert.equal(saved.diagnostics.epoch.code,'SHUTDOWN_UNKNOWN');
    assert.equal(saved.diagnostics.epoch.diagnostics.originalCode,'SESSION_UNKNOWN');
    assert.equal(saved.diagnostics.epoch.diagnostics.originalStage,'session');
    assert.equal(saved.diagnostics.epoch.diagnostics.idleFailure.site,'budget');
    assert.equal(saved.diagnostics.epoch.diagnostics.rpcSite,'deadline');
    assert.equal(saved.diagnostics.supervisor.clientExit,1);
    assert.deepEqual(saved.diagnostics.supervisor.client,saved.diagnostics.epoch);
    assert.equal(f.child.kills,0);assert.equal(f.child.exited,true);
  }finally{try{unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}rmdirSync(directory);}
});

test('legacy owner records stay unchanged while diagnostics reject raw fields and inconsistent proof',async()=>{
  const f=await fixture();await f.owner.close();const record=f.records[0];
  assert.ok(Object.isFrozen(record.diagnostics.epoch.diagnostics));
  const legacy=structuredClone(record);delete legacy.diagnostics;
  assert.deepEqual(normalizeEpochOwnerRecord(legacy),legacy);
  for(const mutate of [
    d=>{d.epoch.diagnostics.rawError='secret';},
    d=>{d.epoch.diagnostics.rpcSite='arbitrary private value';},
    d=>{d.supervisor.client.capabilities.namespaceTools=true;},
    d=>{d.epoch=null;},
    d=>{d.supervisor=null;},
  ]){
    const value=structuredClone(record);mutate(value.diagnostics);
    assert.throws(()=>normalizeEpochOwnerRecord(value),/RECEIPT_REFUSED/);
  }
  let read=false;const value=structuredClone(record);
  Object.defineProperty(value.diagnostics.epoch.diagnostics,'rpcSite',{get(){read=true;return 'none';},enumerable:true});
  assert.throws(()=>normalizeEpochOwnerRecord(value));assert.equal(read,false);
});
test('pending history handler is joined before consuming final control frames or ending stdin',async()=>{
  const entered=deferred(),release=deferred();
  const f=await fixture('history',{history:{call:async()=>{entered.resolve();await release.promise;return{success:true,contentItems:[{type:'inputText',text:'{}'}]};}}});
  const turn=f.owner.turn('one','question');const rejected=assert.rejects(turn);await entered.promise;
  const closing=f.owner.close();await new Promise(done=>setImmediate(done));assert.equal(f.child.stdin.writableEnded,false);assert.equal(f.records.length,0);
  release.resolve();await rejected;const result=await closing;
  assert.equal(result.activeJoined,true);assert.equal(result.resourcesSettled,true);assert.equal(result.successfulEpoch,false);
  assert.equal(f.child.sent.some(x=>x.kind==='toolResult'),false);
});
test('trailing complete or partial frames, mismatched receipts and missing settlement block replacement',async()=>{
  for(const mode of ['trailing','partial','mismatch','unsettled','injected','late-error']){
    const f=await fixture(mode);const result=await f.owner.close();
    assert.equal(result.replacementReady,false,mode);assert.equal(result.outcome,'unknown',mode);assert.equal(f.child.kills,0,mode);
  }
});
test('persistence failure blocks replacement even after successful resource settlement',async()=>{
  const f=await fixture('ok',{recordFinal:async()=>{throw new Error('private storage error');}});const result=await f.owner.close();
  assert.equal(result.resourcesSettled,true);assert.equal(result.persisted,false);assert.equal(result.replacementReady,false);
  assert.equal(JSON.stringify(result).includes('private'),false);
});
test('persisted owner metadata is bound to its epoch and cannot forge resource settlement',async()=>{
  const f=await fixture('ok');await f.owner.close();
  const record=f.records[0];assert.ok(Object.isFrozen(record));
  assert.throws(()=>normalizeEpochOwnerRecord(record,'b'.repeat(32)));
  for(const edit of [v=>{v.persisted=true;},v=>{v.stdoutEnded=false;},v=>{v.activeJoined=false;},
    v=>{v.closeObserved=false;},v=>{v.wireCleanEof=false;},v=>{v.closeCode=1;},v=>{v.streamError=true;},
    v=>{v.replacementReady=false;},v=>{v.epochObserved=false;}]){
    const invalid=structuredClone(record);edit(invalid);assert.throws(()=>normalizeEpochOwnerRecord(invalid));
  }
  let evaluated=false;const invalid=structuredClone(record);
  Object.defineProperty(invalid,'resourcesSettled',{enumerable:true,get(){evaluated=true;return true;}});
  assert.throws(()=>normalizeEpochOwnerRecord(invalid));assert.equal(evaluated,false);
  const unknown=await fixture('unknown');await unknown.owner.close();
  assert.equal(unknown.records[0].outcome,'unknown');assert.equal(unknown.records[0].resourcesSettled,true);
});

test('bad bootstrap never spawns',async()=>{
  let count=0;await assert.rejects(startOwnedEpoch({epochId:'a'.repeat(32),bootstrap:Buffer.from('bad'),signal:new AbortController().signal,spawnChild:()=>count++}));assert.equal(count,0);
});

test('bootstrap bytes and callable ports are captured before spawn or caller mutation',async()=>{
  const child=new Child('history'),control=new AbortController(),records=[];
  const supplied=Buffer.from(bootstrap);let calls=0,redirected=0;
  const wrong=()=>{redirected++;throw new Error('redirected caller port');};
  const history={call:async function(){assert.equal(this,history);calls++;return{success:true,contentItems:[{type:'inputText',text:'{}'}]};}};
  const canonicalSession=args=>{assert.equal(Object.hasOwn(args,'extraTools'),false);return openStandingEpochSession(args);};
  const input={bootstrap:supplied,epochId:'c'.repeat(32),signal:control.signal,history,
    createWire:createEpochWire,openSession:canonicalSession,recordFinal:async value=>records.push(value),
    spawnChild:()=>{
      supplied.fill(0);input.bootstrap=Buffer.from('changed');
      input.createWire=wrong;input.openSession=wrong;input.recordFinal=wrong;
      input.spawnChild=wrong;input.clock=wrong;input.epochId='d'.repeat(32);
      input.signal=new AbortController().signal;input.history={call:wrong};history.call=wrong;
      return child;
    }};
  const starting=startOwnedEpoch(input);
  await new Promise(done=>setImmediate(done));input.recordFinal=wrong;input.epochId='e'.repeat(32);
  const owner=await starting;await owner.turn('captured','question');await owner.release('captured','verified');
  control.abort();const result=await owner.close();
  assert.equal(result.successfulEpoch,true);assert.equal(result.epochId,'c'.repeat(32));
  assert.equal(records.length,1);assert.equal(records[0].epochId,'c'.repeat(32));
  assert.equal(calls,1);assert.equal(redirected,0);assert.equal(child.bootstrapped,true);
});
test('extra tool registry is snapshotted before spawn and passed unchanged to the canonical session',async()=>{
  const child=new Child('extra'),control=new AbortController(),records=[],calls=[];let sessionRegistry;
  const call=async function(args,scope){calls.push({receiver:this,args,scope});return{success:true,contentItems:[{type:'inputText',text:'{}'}]};};
  const entry={name:'neurobro_group_info',call},registry=[entry];
  const input={epochId:'7'.repeat(32),bootstrap,signal:control.signal,history:{call:async()=>({})},extraTools:registry,
    spawnChild:()=>{entry.name='neurobro_changed';entry.call=()=>{throw Error('mutated');};registry.length=0;input.extraTools=[];return child;},
    createWire:createEpochWire,openSession:args=>{sessionRegistry=args.extraTools;return openStandingEpochSession(args);},recordFinal:async value=>records.push(value)};
  const owner=await startOwnedEpoch(input);
  assert.ok(Object.isFrozen(sessionRegistry));assert.ok(Object.isFrozen(sessionRegistry[0]));assert.equal(sessionRegistry.length,1);
  assert.equal(sessionRegistry[0].name,'neurobro_group_info');assert.equal(sessionRegistry[0].call,call);
  await owner.turn('tool-request','question');await owner.release('tool-request','verified');const result=await owner.close();
  assert.equal(result.successfulEpoch,true);assert.equal(records.length,1);assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args,{group:true});assert.equal(calls[0].scope.requestRef,'tool-request');assert.equal(calls[0].scope.callRef,'call-1');
  assert.ok(Object.isFrozen(calls[0].receiver));assert.equal(calls[0].receiver.name,'neurobro_group_info');assert.equal(calls[0].receiver.call,call);
});
test('malformed, accessor and proxy owner registries fail before spawn or caller ports',async()=>{
  let accessorReads=0,proxyTraps=0;
  const accessor=[];Object.defineProperty(accessor,'0',{enumerable:true,get(){accessorReads++;return{name:'neurobro_group_info',call:async()=>{}};}});
  const proxyArray=new Proxy([],{ownKeys(){proxyTraps++;throw Error('trap');}});
  const proxyEntry=new Proxy({name:'neurobro_group_info',call:async()=>{}},{getPrototypeOf(){proxyTraps++;throw Error('trap');}});
  const proxyCall=new Proxy(async()=>{},{apply(){proxyTraps++;throw Error('trap');}});
  const malformed=[{},new Array(1),accessor,proxyArray,[proxyEntry],[{name:'neurobro_group_info',call:proxyCall}],
    [{name:'neurobro_read_history',call:async()=>{}}],[{name:'neurobro_group_info',call:async()=>{}},{name:'neurobro_group_info',call:async()=>{}}]];
  for(const extraTools of malformed){let spawned=0,wireCalls=0,sessionCalls=0,recordCalls=0;
    await assert.rejects(startOwnedEpoch({epochId:'8'.repeat(32),bootstrap,signal:new AbortController().signal,history:{call:async()=>({})},extraTools,
      spawnChild:()=>{spawned++;},createWire:()=>{wireCalls++;},openSession:()=>{sessionCalls++;},recordFinal:async()=>{recordCalls++;}}),error=>error.code==='CONFIG');
    assert.deepEqual([spawned,wireCalls,sessionCalls,recordCalls],[0,0,0,0]);}
  for(const topLevel of [Object.defineProperty({epochId:'8'.repeat(32)},'extraTools',{get(){accessorReads++;return[];}}),
    new Proxy({epochId:'8'.repeat(32)},{getOwnPropertyDescriptor(){proxyTraps++;throw Error('trap');}})]){
    await assert.rejects(startOwnedEpoch(topLevel),error=>error.code==='CONFIG');
  }
  assert.equal(accessorReads,0);assert.equal(proxyTraps,0);
});

test('actual local Node child joins two turns, clean pipe EOF and real exit/close', {timeout:15000},async()=>{
  // Reuse the controlled peer's protocol verbatim inside a real public fixture
  // process. Only the OS stdin/stdout/stderr and exit/close ownership differ.
  const script=`import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
const bootstrap=Buffer.from('${bootstrap.toString('hex')}','hex');
${proof.toString()}
${supervisor.toString()}
${Child.toString()}
const peer=new Child();peer.stdout.pipe(process.stdout);peer.stderr.pipe(process.stderr);process.stdin.pipe(peer.stdin);`;
  let child,closed=false;const records=[];
  const watchdog=setTimeout(()=>{if(child&&!closed)child.kill();},8000);
  try{
    const owner=await startOwnedEpoch({epochId:'f'.repeat(32),bootstrap,signal:new AbortController().signal,history:{call:async()=>({})},
      spawnChild:()=>{child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});child.once('close',()=>{closed=true;});return child;},
      createWire:createEpochWire,openSession:openStandingEpochSession,recordFinal:async record=>records.push(record)});
    for(let i=1;i<=2;i++){await owner.turn('os-'+i,'synthetic question');await owner.release('os-'+i,'verified');}
    const result=await owner.close();
    assert.equal(result.successfulEpoch,true);assert.equal(result.resourcesSettled,true);assert.equal(result.replacementReady,true);
    assert.equal(result.exitObserved,true);assert.equal(result.closeObserved,true);assert.equal(result.wireCleanEof,true);
    assert.equal(result.exitCode,0);assert.equal(result.closeCode,0);assert.equal(result.stderrBytes,0);
    assert.equal(result.terminationDispatched,false);assert.equal(closed,true);assert.equal(records.length,1);
  }finally{clearTimeout(watchdog);if(child&&!closed){const joined=new Promise(done=>child.once('close',done));child.kill();await Promise.race([joined,new Promise((_,reject)=>setTimeout(()=>reject(new Error('fixture child close unknown')),2000))]);}}
});
test('bootstrap joins both write callback and drain before opening the session wire',async()=>{
  const child=new Child(),original=child.stdin.write.bind(child.stdin);let callback,wireCreated=0;
  child.stdin.write=(bytes,done)=>{original(bytes,()=>{});callback=done;return false;};
  const starting=startOwnedEpoch({epochId:'b'.repeat(32),bootstrap,signal:new AbortController().signal,history:{call:async()=>({})},spawnChild:()=>child,
    createWire:ports=>{wireCreated++;child.stdin.write=original;return createEpochWire(ports);},openSession:openStandingEpochSession,recordFinal:async()=>{}});
  await new Promise(done=>setImmediate(done));assert.equal(child.bootstrapped,true);assert.equal(wireCreated,0);
  callback();await new Promise(done=>setImmediate(done));assert.equal(wireCreated,0);
  child.stdin.emit('drain');const owner=await starting;assert.equal(wireCreated,1);assert.equal((await owner.close()).replacementReady,true);
});
test('input closes first: actual EOF and pending history join precede final proof',async()=>{
  const entered=deferred(),release=deferred();
  const f=await fixture('history',{history:{call:async()=>{entered.resolve();await release.promise;return{success:true,contentItems:[{type:'inputText',text:'{}'}]};}}});
  const turn=f.owner.turn('pending','question'),rejected=assert.rejects(turn);await entered.promise;
  f.child.stdin.emit('close');await new Promise(done=>setImmediate(done));
  assert.equal(f.child.sent.some(x=>x.kind==='close'),false);assert.equal(f.records.length,0);
  // Input closure above is not EOF: only now emit terminal frames and EOF.
  f.child.frame({kind:'close'});f.child.stdout.end();f.child.stderr.end();
  await new Promise(done=>setImmediate(done));assert.equal(f.records.length,0);
  release.resolve();await rejected;const final=await f.owner.close();
  assert.equal(final.resourcesSettled,true);assert.equal(final.replacementReady,true);assert.equal(final.successfulEpoch,false);
  assert.equal(f.child.sent.some(x=>x.kind==='close'||x.kind==='toolResult'),false);
});

test('actual Node peer expires naturally while idle or history callback is pending', {timeout:15000},async()=>{
  for(const mode of ['ok','history']){
    const script=`import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
const bootstrap=Buffer.from('${bootstrap.toString('hex')}','hex');
${proof.toString()}
${supervisor.toString()}
${Child.toString()}
const peer=new Child('${mode}');peer.stdout.pipe(process.stdout);peer.stderr.pipe(process.stderr);
const consume=peer.consume.bind(peer);let expiry;
peer.consume=data=>{consume(data);if(peer.bootstrapped&&!expiry)expiry=setTimeout(()=>{peer.frame({kind:'close'});peer.stdout.end();peer.stderr.end();process.stdin.destroy();},200);};
process.stdin.pipe(peer.stdin);`;
    let child,closed=false;const records=[],eof=deferred(),entered=deferred(),release=deferred();
    const watchdog=setTimeout(()=>{if(child&&!closed)child.kill();},8000);
    try{
      const owner=await startOwnedEpoch({epochId:'9'.repeat(32),bootstrap,signal:new AbortController().signal,
        history:{call:async()=>{entered.resolve();await release.promise;return{success:true,contentItems:[{type:'inputText',text:'{}'}]};}},
        spawnChild:()=>{child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdout.once('end',eof.resolve);child.once('close',()=>{closed=true;});return child;},
        createWire:createEpochWire,openSession:openStandingEpochSession,recordFinal:async record=>records.push(record)});
      let rejected;
      if(mode==='history'){rejected=assert.rejects(owner.turn('pending','synthetic question'));await entered.promise;}
      await eof.promise;
      if(mode==='history'){await new Promise(done=>setImmediate(done));assert.equal(records.length,0);release.resolve();await rejected;}
      const final=await owner.close();
      assert.equal(final.resourcesSettled,true,mode);assert.equal(final.persisted,true,mode);assert.equal(final.replacementReady,true,mode);
      assert.equal(final.successfulEpoch,false,mode);assert.equal(final.exitCode,0,mode);assert.equal(final.closeCode,0,mode);
      assert.equal(final.wireCleanEof,true,mode);assert.equal(final.streamError,false,mode);assert.equal(final.terminationDispatched,false,mode);
      assert.equal(records.length,1);assert.equal(closed,true);
    }finally{release.resolve();clearTimeout(watchdog);if(child&&!closed){const joined=new Promise(done=>child.once('close',done));child.kill();await Promise.race([joined,new Promise((_,reject)=>setTimeout(()=>reject(new Error('fixture child close unknown')),2000))]);}}
  }
});

test('kill dispatch at exhausted work budget cannot fabricate child settlement',async()=>{
  let now=0;const child=new Child(),original=child.frame.bind(child),records=[];
  child.frame=frame=>{if(frame.kind==='close'){now=34001;return;}original(frame);};
  const f=await fixture('ok',{clock:()=>now,spawnChild:()=>child,recordFinal:async v=>{records.push(v);}});
  const value=await f.owner.close();
  assert.equal(value.terminationDispatched,true);assert.equal(child.kills,1);assert.equal(value.closeObserved,false);
  assert.equal(value.resourcesSettled,false);assert.equal(value.replacementReady,false);assert.equal(records.length,1);
  // Controlled streams have no OS process. End them only after recording the
  // unknown result so the deliberately pending session receive can unwind.
  child.stdout.end();child.stderr.end();child.stdin.destroy();
  await new Promise(done=>setImmediate(done));
});
