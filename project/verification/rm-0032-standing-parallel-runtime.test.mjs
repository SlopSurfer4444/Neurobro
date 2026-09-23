import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SOURCE_NAMES,SOURCE_PINS,PARALLEL_SOURCE_NAMES,PARALLEL_SOURCE_PINS} from './rm-0032-standing-epoch-host.mjs';
import {prepareStandingParallelRuntime} from './rm-0032-standing-parallel-runtime.mjs';
import {createStandingEpochRecordStore} from './rm-0032-standing-epoch-runtime.mjs';
import {writeStandingEpochRecovery} from './rm-0032-standing-epoch-recovery.mjs';
const root=resolve('project/verification'),sources=Object.fromEntries(Object.entries({...SOURCE_NAMES,...PARALLEL_SOURCE_NAMES}).map(([key,name])=>[key,readFileSync(resolve(root,name),'utf8')]));
const pins={...SOURCE_PINS,...PARALLEL_SOURCE_PINS};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(done=>setImmediate(done));
const work=workRef=>({taskRef:'task',planRef:'wave',workRef});
const callbacks=(workRef,shown=async()=>{})=>({work:work(workRef),analysisTools:['neurobro_analysis_material','neurobro_analysis_notes','neurobro_analysis_commit'].map(name=>({name,call:async()=>({name})})),onToolResultSent:shown});
function receipt(epochId){
  // Unknown semantic outcome with exact physical-cleanup proof remains usable
  // for owner replacement, never as proof of a model answer.
  const physicalCleanup=Object.fromEntries(['clientLaunchCaptured','relayLaunchCaptured','creationsJoined','ownershipKnown','clientUnitAbsent','relayUnitAbsent','unitChecksAfterCreations','transportsJoined','stdinClosed','stdoutEof','stderrEof','sessionTasksJoined','complete'].map(k=>[k,true]));
  Object.assign(physicalCleanup,{clientStopRequested:true,relayStopRequested:true,transportKillRequested:false});
  const supervisor={schema:'standing-epoch-supervisor-v1',outcome:'unknown',stage:'settlement',preflight:true,custodyReady:true,clientNaturalSettlement:false,relaySettled:true,allProcessesSettled:true,settled:true,injectedPorts:false,clientExit:1,relayExit:0,clientStdoutBytes:0,clientStderrBytes:0,relayStdoutBytes:0,relayStderrBytes:0,client:null,relay:null,physicalCleanup};
  return {schema:'standing-epoch-owner-v1',epochId,outcome:'unknown',bootstrapJoined:true,activeJoined:true,sessionClosed:true,epochObserved:false,supervisorObserved:false,processSettled:true,exitObserved:true,closeObserved:true,stderrEnded:true,stdoutEnded:true,wireCleanEof:true,streamError:false,childError:false,terminationDispatched:true,successfulEpoch:false,resourcesSettled:true,replacementReady:true,exitCode:1,exitSignal:null,closeCode:1,closeSignal:null,stderrBytes:0,diagnostics:{epoch:null,supervisor}};
}
function fixture(options={}){
  const records=new Map(),events=[],actors=[],control=new AbortController();
  const parent=options.real?mkdtempSync(resolve(tmpdir(),'neurobro-parallel-runtime-')):resolve('synthetic-parallel-attempts');
  const store={reserve(path,intent){events.push('reserve');records.set(path,{intent});},controller(path,value){events.push('controller');records.get(path).controller=value;},async finish(path,actual){events.push('finish');if(options.finishGate)await options.finishGate.promise;if(options.finishFail)throw Error('finish');records.get(path).actual=actual;},async verify(path){const r=records.get(path);if(!r?.actual)throw Error('missing');return{intent:r.intent,actual:r.actual};}};
  const input={sources,pins,attemptParent:parent,workerToken:'a'.repeat(32),createWire:()=>{},openSession:()=>{},sessionMode:'standing-parallel-epoch-v1',parallelOptions:{analysisWorkers:2,communityAssessment:true},workProfile:'community-team',isTurnNotAdmitted:()=>false,isWorkerTurnNotAdmitted:e=>e?.code==='synthetic-refused'};
  const ports={...(options.real?{}:{store}),communityAssessmentTimeoutMs:options.timeout??30000,spawn:()=>{events.push('spawn');return{pid:1234};},openOwner:async input=>{
    input.spawnChild();const active=new Set(),retired=new Set();let closed=false,closing,rotate=false;
    const actor={input,closes:0,turns:[],retire:worker=>retired.add(worker),rotate:()=>{rotate=true;},admission:worker=>closed?'unavailable':retired.has(worker)||rotate&&(worker===undefined||options.rotateAnalysis)?'rotate':'ready',analysisWorkerIds:()=>['worker-1','worker-2'],
      async turnConversation(ref){events.push('conversation');if(options.conversationGate)await options.conversationGate.promise;return{kind:'text',answer:ref};},async releaseConversation(){events.push('conversation-release');},
      turnAnalysis(workerId,ref,body,binding){events.push('analysis');actor.turns.push({workerId,ref,body,binding});const number=actor.turns.filter(t=>t.workerId===workerId).length;
        const p=(async()=>{if(options.turnGate)await options.turnGate.promise;if(options.refuse){const e=Error('refused');e.code='synthetic-refused';throw e;}
          const toolCalls=await options.runAnalysis?.({input,workerId,ref,body,binding,signal:control.signal})??0;
          const completed={kind:'analysis',workerId,scope:{epochId:input.epochId,purpose:'history-analysis',requestRef:ref,threadId:'thread-'+workerId,turnId:'turn-'+number,turnNumber:number,threadTurnNumber:number},answer:'Bound analysis output',toolCalls,toolRefusals:0};
          return options.completed?options.completed(completed):completed;
        })();active.add(p);void p.finally(()=>active.delete(p)).catch(()=>{});return p;},
      async releaseAnalysis(workerId,ref){events.push('analysis-release');if(options.releaseFail)throw Error('release');},
      async turnCommunityAssessment(){events.push('assessment');if(options.assessmentGate)await options.assessmentGate.promise;return{kind:'community-assessment',decision:{decision:'silent'}};},async releaseCommunityAssessment(){events.push('assessment-release');},
      close(){if(!closing)closing=(async()=>{closed=true;actor.closes++;events.push('close');options.turnGate?.resolve();options.assessmentGate?.resolve();options.conversationGate?.resolve();await Promise.allSettled([...active]);if(options.closeGate)await options.closeGate.promise;await input.recordFinal(receipt(input.epochId),1000);return{resourcesSettled:true,persisted:true,replacementReady:true};})();return closing;},
    };actors.push(actor);return actor;
  }};
  const runtime=prepareStandingParallelRuntime(input,ports),connection=runtime.openConnection({signal:control.signal,history:{call:async()=>({})},workProfile:'community-team'});
  return {runtime,connection,input,ports,actors,events,records,parent,control,async cleanup(){await connection.close();if(options.real)rmSync(parent,{recursive:true,force:true});}};
}

test('missing predecessor actual blocks analysis without poisoning foreground or inventing settlement',async()=>{
  const f=fixture({real:true});try{
    await f.connection.prepare();
    const previous={epochId:f.actors[0].input.epochId,requestRef:'prior-not-released',purpose:'history-analysis'};
    await assert.rejects(f.connection.acquireAnalysisAdmission('blocked-next',previous),e=>e.code==='PRIOR_OWNER_UNAVAILABLE');
    assert.equal(f.connection.state().analysisLeases,0);assert.equal(f.runtime.state().blocked,false);
    assert.equal(f.actors[0].turns.length,0);
    await f.connection.prepare();await f.connection.turn('foreground-after-missing','question');await f.connection.release('foreground-after-missing','verified');
    assert.equal(f.events.filter(e=>e==='conversation').length,1);assert.equal(f.actors.length,1);
  }finally{await f.cleanup();}
});

test('explicit physical recovery admits a new request while the original native outcome stays absent',async()=>{
  const f=fixture({real:true});try{
    await f.connection.prepare();
    const current=f.actors[0].input.epochId,epochId='b'.repeat(32),directory=resolve(f.parent,epochId);
    const original={...JSON.parse(readFileSync(resolve(f.parent,current,'intent.json'),'utf8')),token:epochId};
    const old=createStandingEpochRecordStore(f.parent);old.reserve(directory,original);
    old.controller(directory,{version:'standing-controller-v1',workerToken:original.workerToken,token:epochId,pid:999999});
    const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
    const intentHash=digest(resolve(directory,'intent.json')),controllerHash=digest(resolve(directory,'controller.json'));
    const previous={epochId,requestRef:'saved-original-request',purpose:'history-analysis'};
    await assert.rejects(f.runtime.verifyAnalysisSettlement(previous),e=>e.code==='PRIOR_OWNER_UNAVAILABLE');
    await writeStandingEpochRecovery({directory,epochId,authorizationHash:'a'.repeat(64),intentHash,controllerHash,
      checkPhysicalSettlement:async binding=>{assert.equal(binding.epochId,epochId);return {exclusiveCustody:true,windowsBeforeAbsent:true,guestAbsent:true,windowsAfterAbsent:true,checkedAt:new Date().toISOString(),receiptHash:'c'.repeat(64)};}});
    const proof=await f.runtime.verifyAnalysisSettlement(previous);
    assert.equal(proof.resourcesSettled,true);assert.equal(proof.modelOutcome,'not-proven');
    const lease=await f.connection.acquireAnalysisAdmission('new-successor-request',previous);
    assert.notEqual(lease.nativeBinding.epochId,epochId);assert.equal(f.actors[0].turns.length,0);
    await lease.turnAnalysis('new-successor-request','new material',callbacks('new-work'));await lease.releaseAnalysis('new-successor-request');await lease.close();
    assert.deepEqual(f.actors[0].turns.map(x=>x.ref),['new-successor-request']);
    assert.equal(existsSync(resolve(directory,'actual.json')),false);
    assert.equal(digest(resolve(directory,'intent.json')),intentHash);assert.equal(digest(resolve(directory,'controller.json')),controllerHash);
  }finally{await f.cleanup();}
});

test('parallel configuration is explicit and source-pinned before any owner acquisition',async()=>{
  const f=fixture();try{assert.equal(f.events.length,0);assert.equal(f.connection.concurrentAnalysis,true);
    for(const edit of [{sessionMode:'standing-scoped-epoch-v2'},{parallelOptions:{analysisWorkers:8,communityAssessment:true}},{pins:{...pins,parallelPool:'0'.repeat(64)}}])assert.throws(()=>prepareStandingParallelRuntime({...f.input,...edit},f.ports));
    assert.equal(f.events.length,0);
  }finally{await f.cleanup();}
});

for(const timing of ['simultaneous','during-persistence'])test('known-empty retry rotates a released warm owner and '+timing+' requests share the replacement',async()=>{
  const finishGate=deferred(),f=fixture({finishGate});try{
    await f.connection.prepare();const prior=await f.connection.acquireAnalysisAdmission('prior-empty');
    await prior.turnAnalysis('prior-empty','body',callbacks('prior-work'));await prior.releaseAnalysis('prior-empty');await prior.close();
    const previous=prior.nativeBinding;
    const a=f.connection.acquireParallelAnalysisAdmissions(['retry-a'],previous,{requireNewEpoch:true});
    if(timing==='during-persistence'){
      await tick();assert.equal(f.actors[0].closes,1);assert.equal(f.events.at(-1),'finish');
      await assert.rejects(f.connection.verifyAnalysisReady(previous),e=>e.code==='STATE');
    }
    const b=f.connection.acquireAnalysisAdmission('retry-b',previous,{requireNewEpoch:true});
    await tick();assert.equal(f.actors[0].closes,1);assert.equal(f.actors.length,1);
    finishGate.resolve();const [group,next]=await Promise.all([a,b]);
    assert.equal(f.actors.length,2);assert.notEqual(next.nativeBinding.epochId,previous.epochId);
    assert.equal(group.leases[0].nativeBinding.epochId,next.nativeBinding.epochId);
    assert.equal((await f.runtime.verifyAnalysisSettlement(previous)).persisted,true);
    assert.equal(f.actors[1].turns.length,0);assert.ok(f.events.indexOf('finish')<f.events.lastIndexOf('reserve'));
    await group.close();await next.close();
  }finally{finishGate.resolve();await f.cleanup();}
});

test('forced retry waits active sibling callbacks and foreground delivery without closing either early',async()=>{
  const conversationGate=deferred(),callbackGate=deferred(),f=fixture({conversationGate});try{
    await f.connection.prepare();const prior=await f.connection.acquireAnalysisAdmission('prior-empty');
    await prior.turnAnalysis('prior-empty','body',callbacks('prior-work'));await prior.releaseAnalysis('prior-empty');await prior.close();
    const group=await f.connection.acquireParallelAnalysisAdmissions(['sibling']);const sibling=group.leases[0];
    await sibling.turnAnalysis('sibling','body',callbacks('sibling-work',()=>callbackGate.promise));
    const shown=f.actors[0].input.onToolResultSent({purpose:'history-analysis',workerId:sibling.workerId,requestRef:'sibling',callRef:'callback',name:'neurobro_analysis_material',result:{}});
    const releasing=sibling.releaseAnalysis('sibling');
    const foreground=f.connection.turn('foreground','question');await tick();
    let acquired=false;const retry=f.connection.acquireAnalysisAdmission('retry',prior.nativeBinding,{requireNewEpoch:true}).then(value=>{acquired=true;return value;});
    await tick();assert.equal(acquired,false);assert.equal(f.actors[0].closes,0);
    callbackGate.resolve();await shown;await releasing;await group.close();await tick();
    assert.equal(f.actors[0].closes,0);conversationGate.resolve();await foreground;await tick();
    assert.equal(f.actors[0].closes,0);await f.connection.release('foreground','verified');
    const next=await retry;assert.equal(f.actors[0].closes,1);assert.notEqual(next.nativeBinding.epochId,prior.nativeBinding.epochId);await next.close();
  }finally{callbackGate.resolve();conversationGate.resolve();await f.cleanup();}
});

test('forced retry admits settled refusal without a nonexistent release and preserves normal warm reuse',async()=>{
  const f=fixture({refuse:true});try{
    await f.connection.prepare();const prior=await f.connection.acquireAnalysisAdmission('prior-refused');
    await assert.rejects(prior.turnAnalysis('prior-refused','body',callbacks('prior-work')));await prior.close();
    const next=await f.connection.acquireAnalysisAdmission('retry',prior.nativeBinding,{requireNewEpoch:true});
    assert.notEqual(next.nativeBinding.epochId,prior.nativeBinding.epochId);assert.equal(f.actors[0].closes,1);await next.close();
  }finally{await f.cleanup();}
  const warm=fixture();try{
    await warm.connection.prepare();const prior=await warm.connection.acquireAnalysisAdmission('prior');
    await prior.turnAnalysis('prior','body',callbacks('work'));await prior.releaseAnalysis('prior');await prior.close();
    const next=await warm.connection.acquireAnalysisAdmission('next',prior.nativeBinding);
    assert.equal(next.nativeBinding.epochId,prior.nativeBinding.epochId);assert.equal(warm.actors[0].closes,0);await next.close();
  }finally{await warm.cleanup();}
});

test('retry options reject accessors proxies missing previous and unknown fields without side effects',async()=>{
  const f=fixture();let reads=0;try{
    await f.connection.prepare();const previous={epochId:f.actors[0].input.epochId,requestRef:'prior',purpose:'history-analysis'};
    const getter={};Object.defineProperty(getter,'requireNewEpoch',{get(){reads++;return true;}});
    const proxy=new Proxy({requireNewEpoch:true},{getOwnPropertyDescriptor(){reads++;throw Error('trap');},getPrototypeOf(){reads++;throw Error('trap');}});
    for(const options of [null,{},false,{requireNewEpoch:false},{requireNewEpoch:true,extra:true},getter,proxy]){
      await assert.rejects(f.connection.acquireAnalysisAdmission('retry',previous,options));
      await assert.rejects(f.connection.acquireParallelAnalysisAdmissions(['retry'],previous,options));
    }
    await assert.rejects(f.connection.acquireAnalysisAdmission('retry',undefined,{requireNewEpoch:true}));
    assert.equal(reads,0);assert.equal(f.actors[0].closes,0);assert.equal(f.actors.length,1);
  }finally{await f.cleanup();}
});

test('forced retry never downgrades active owner persistence failure into task-local absence',async()=>{
  const f=fixture({finishFail:true});try{
    await f.connection.prepare();const prior=await f.connection.acquireAnalysisAdmission('prior-empty');
    await prior.turnAnalysis('prior-empty','body',callbacks('prior-work'));await prior.releaseAnalysis('prior-empty');await prior.close();
    await assert.rejects(f.connection.acquireAnalysisAdmission('retry',prior.nativeBinding,{requireNewEpoch:true}),e=>e.code==='SETTLEMENT_UNKNOWN');
    assert.equal(f.runtime.state().blocked,true);assert.equal(f.actors.length,1);
  }finally{await f.cleanup();}
});

test('torn physical recovery proof is task-local unavailable and leaves foreground usable',async()=>{
  const f=fixture({real:true});try{
    await f.connection.prepare();const epochId='b'.repeat(32),directory=resolve(f.parent,epochId);mkdirSync(directory);
    writeFileSync(resolve(directory,'recovery.json'),'{');
    const previous={epochId,requestRef:'prior',purpose:'history-analysis'};
    await assert.rejects(f.connection.acquireAnalysisAdmission('retry',previous,{requireNewEpoch:true}),e=>e.code==='PRIOR_OWNER_UNAVAILABLE');
    assert.equal(f.runtime.state().blocked,false);assert.equal(f.actors.length,1);
    await f.connection.turn('foreground-after-torn','question');await f.connection.release('foreground-after-torn','verified');
  }finally{await f.cleanup();}
});
test('two reserved analysis workers overlap foreground and assessment in one owner',async()=>{
  const gate=deferred(),f=fixture({turnGate:gate});try{
    await f.connection.prepare();const group=await f.connection.acquireParallelAnalysisAdmissions(['a1','a2']);
    assert.deepEqual(f.events,['reserve','spawn','controller']);
    const runs=group.leases.map((l,i)=>l.turnAnalysis(l.nativeBinding.requestRef,'body',callbacks('work-'+i)));await tick();
    assert.equal(f.actors[0].turns.length,2);await f.connection.prepare();assert.equal((await f.connection.turn('c1','question')).kind,'text');await f.connection.release('c1','not-sent');
    const assessment=await f.connection.acquireCommunityAssessmentAdmission('observer');await assessment.turnCommunityAssessment('observer','body');await assessment.releaseCommunityAssessment('observer');await assessment.close();
    gate.resolve();await Promise.all(runs);await Promise.all(group.leases.map(l=>l.releaseAnalysis(l.nativeBinding.requestRef)));await group.close();
    assert.equal(f.actors[0].closes,0);assert.equal(f.runtime.state().attempts,1);
    for(const [i,l] of group.leases.entries()){const proof=await f.connection.verifyAnalysisWorkReleased(l.nativeBinding,'work-'+i);assert.equal(proof.callbacksJoined,true);assert.equal(Object.hasOwn(proof,'resourcesSettled'),false);}
    await f.connection.prepare();await f.connection.turn('c2','question');await f.connection.release('c2','verified');assert.equal(f.actors.length,1);
  }finally{await f.cleanup();}
});
test('atomic reservation rejects duplicate requests, busy workers and malformed work without dispatch',async()=>{
  const f=fixture();try{await f.connection.prepare();await assert.rejects(f.connection.acquireParallelAnalysisAdmissions(['same','same']));
    const group=await f.connection.acquireParallelAnalysisAdmissions(['a1','a2']);await assert.rejects(f.connection.acquireParallelAnalysisAdmissions(['a3']));
    let reads=0;const bad={...callbacks('w')};Object.defineProperty(bad,'work',{get(){reads++;return work('bad');}});
    await assert.rejects(group.leases[0].turnAnalysis('a1','body',bad));assert.equal(reads,0);assert.equal(f.actors[0].turns.length,0);
    await group.close();await assert.rejects(f.connection.acquireParallelAnalysisAdmissions(['a1']));
  }finally{await f.cleanup();}
});
test('analysis acquisition also overlaps an already active foreground conversation',async()=>{
  const gate=deferred(),f=fixture({conversationGate:gate});try{await f.connection.prepare();const conversation=f.connection.turn('foreground-first','question');await tick();
    const group=await f.connection.acquireParallelAnalysisAdmissions(['a1','a2']);await Promise.all(group.leases.map((l,i)=>l.turnAnalysis(l.nativeBinding.requestRef,'body',callbacks('w'+i))));
    await Promise.all(group.leases.map(l=>l.releaseAnalysis(l.nativeBinding.requestRef)));await group.close();assert.equal(f.actors[0].closes,0);
    gate.resolve();await conversation;await f.connection.release('foreground-first','verified');
  }finally{gate.resolve();await f.cleanup();}
});
test('foreground rotation waits existing wave close without interrupting work or losing its request',async()=>{
  const gate=deferred(),f=fixture({turnGate:gate});try{await f.connection.prepare();const group=await f.connection.acquireParallelAnalysisAdmissions(['a1','a2']);
    const runs=group.leases.map((l,i)=>l.turnAnalysis(l.nativeBinding.requestRef,'body',callbacks('w'+i)));await tick();f.actors[0].rotate();
    let prepared=false;const preparing=f.connection.prepare().then(value=>{prepared=true;return value;});await tick();
    assert.equal(prepared,false);assert.equal(f.actors[0].closes,0);await assert.rejects(f.connection.acquireParallelAnalysisAdmissions(['new-work']));await assert.rejects(f.connection.acquireCommunityAssessmentAdmission('new-assessment'));
    gate.resolve();await Promise.all(runs);await Promise.all(group.leases.map(l=>l.releaseAnalysis(l.nativeBinding.requestRef)));assert.equal(prepared,false);await group.close();
    assert.equal((await f.connection.verifyAnalysisWorkReleased(group.leases[0].nativeBinding,'w0')).releaseAcknowledged,true);await preparing;
    assert.equal((await f.connection.verifyAnalysisWorkReleased(group.leases[1].nativeBinding,'w1')).callbacksJoined,true);
    assert.equal(f.actors[0].closes,1);assert.equal(f.actors.length,2);assert.equal((await f.connection.turn('durable-foreground-request','question')).answer,'durable-foreground-request');await f.connection.release('durable-foreground-request','verified');
  }finally{gate.resolve();await f.cleanup();}
});
test('abort ends queued foreground rotation and joins the owner without waiting for caller lease close',async()=>{
  const gate=deferred(),f=fixture({turnGate:gate});try{await f.connection.prepare();const group=await f.connection.acquireParallelAnalysisAdmissions(['a']);const a=group.leases[0],run=a.turnAnalysis('a','body',callbacks('w'));await tick();f.actors[0].rotate();
    const preparing=f.connection.prepare();await tick();const stopped=assert.rejects(preparing,e=>e.code==='STOPPED');const closing=f.connection.close();await stopped;await closing;await run;await group.close();assert.equal(f.actors[0].closes,1);assert.equal(f.runtime.state().connectionOpen,false);
  }finally{gate.resolve();await f.cleanup();}
});
test('immediate close before queued prepare starts cannot miss the abort or wait for caller lease close',async()=>{
  const gate=deferred(),f=fixture({turnGate:gate});try{await f.connection.prepare();const group=await f.connection.acquireParallelAnalysisAdmissions(['a']);const a=group.leases[0],run=a.turnAnalysis('a','body',callbacks('w'));await tick();f.actors[0].rotate();
    const preparing=f.connection.prepare(),closing=f.connection.close();await assert.rejects(preparing,e=>e.code==='STOPPED');await closing;await run;
    assert.equal(f.runtime.state().connectionOpen,false);await group.close();assert.equal(f.actors[0].closes,1);
  }finally{gate.resolve();await f.cleanup();}
});
test('shown callbacks route by exact worker/request and warm proof waits their join',async()=>{
  const gate=deferred(),f=fixture();try{await f.connection.prepare();const group=await f.connection.acquireParallelAnalysisAdmissions(['a1','a2']),[a,b]=group.leases;
    await a.turnAnalysis('a1','body',callbacks('work-a',()=>gate.promise));await b.turnAnalysis('a2','body',callbacks('work-b'));
    assert.throws(()=>f.actors[0].input.onToolResultSent({purpose:'history-analysis',requestRef:'a1',workerId:b.workerId}));
    const shown=f.actors[0].input.onToolResultSent({purpose:'history-analysis',requestRef:'a1',workerId:a.workerId});await tick();let released=false;
    const releasing=a.releaseAnalysis('a1').then(()=>{released=true;});await tick();assert.equal(released,false);await assert.rejects(f.connection.verifyAnalysisWorkReleased(a.nativeBinding,'work-a'));
    gate.resolve();await shown;await releasing;await b.releaseAnalysis('a2');await group.close();assert.equal((await f.connection.verifyAnalysisWorkReleased(a.nativeBinding,'work-a')).releaseAcknowledged,true);
    await assert.rejects(f.connection.verifyAnalysisWorkReleased(a.nativeBinding,'work-b'));
  }finally{gate.resolve();await f.cleanup();}
});
test('cold owner verification requires exact durable record and never invents observed model output',async()=>{
  const f=fixture({real:true});try{await f.connection.prepare();const a=await f.connection.acquireAnalysisAdmission('serial');await a.turnAnalysis('serial','merge',callbacks('attempt-ref'));await a.releaseAnalysis('serial');await a.close();
    await assert.rejects(f.runtime.verifyAnalysisSettlement(a.nativeBinding));await f.connection.close();
    const cold=prepareStandingParallelRuntime(f.input,f.ports),proof=await cold.verifyAnalysisSettlement(a.nativeBinding);assert.equal(proof.modelOutcome,'not-proven');assert.equal(proof.persisted,true);
    await assert.rejects(cold.verifyAnalysisSettlement({...a.nativeBinding,epochId:'f'.repeat(32)}));
  }finally{await f.cleanup();}
});
test('failed release blocks warm proof, closes owner once and permits successor only after persistence',async()=>{
  const f=fixture({releaseFail:true});try{await f.connection.prepare();const group=await f.connection.acquireParallelAnalysisAdmissions(['a1']);const a=group.leases[0];await a.turnAnalysis('a1','body',callbacks('w'));await assert.rejects(a.releaseAnalysis('a1'));
    await assert.rejects(f.connection.verifyAnalysisWorkReleased(a.nativeBinding,'w'));await group.abortAndJoin();await group.close();assert.equal(f.actors[0].closes,1);
    assert.equal((await f.runtime.verifyAnalysisSettlement(a.nativeBinding)).replacementReady,true);await f.connection.prepare();assert.equal(f.actors.length,2);
  }finally{await f.cleanup();}
});
test('connection close joins active workers and durable final write before replacement',async()=>{
  const turnGate=deferred(),finishGate=deferred(),f=fixture({turnGate,finishGate});try{await f.connection.prepare();const group=await f.connection.acquireParallelAnalysisAdmissions(['a1','a2']);const runs=group.leases.map((l,i)=>l.turnAnalysis(l.nativeBinding.requestRef,'body',callbacks('w'+i)));await tick();
    let closed=false;const closing=f.connection.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);assert.equal(f.runtime.state().connectionOpen,true);
    finishGate.resolve();await closing;await Promise.allSettled(runs);await group.close();assert.equal(f.runtime.state().connectionOpen,false);assert.equal(f.events.filter(e=>e==='finish').length,1);
  }finally{finishGate.resolve();await f.cleanup();}
});
test('unknown final persistence never permits a replacement connection',async()=>{
  const f=fixture({finishFail:true});await f.connection.prepare();assert.equal((await f.connection.close()).persisted,false);assert.equal(f.runtime.state().blocked,true);
  assert.throws(()=>f.runtime.openConnection({signal:new AbortController().signal,history:{call:async()=>{}},workProfile:'community-team'}));
});
test('refused worker retains its request and disposition until owner join without replay',async()=>{
  const f=fixture({refuse:true});try{await f.connection.prepare();const g=await f.connection.acquireParallelAnalysisAdmissions(['a']);const a=g.leases[0];await assert.rejects(a.turnAnalysis('a','body',callbacks('w')));
    await assert.rejects(a.turnAnalysis('a','body',callbacks('w')));assert.equal(f.actors[0].turns.length,1);await g.abortAndJoin();await g.close();assert.equal((await f.runtime.verifyAnalysisSettlement(a.nativeBinding)).modelOutcome,'not-proven');
  }finally{await f.cleanup();}
});
test('assessment timeout joins background workers and owner before returning bounded failure',async()=>{
  const gate=deferred(),f=fixture({assessmentGate:gate,timeout:5});try{await f.connection.prepare();const g=await f.connection.acquireParallelAnalysisAdmissions(['a']),a=g.leases[0];await a.turnAnalysis('a','body',callbacks('w'));await a.releaseAnalysis('a');
    const assessment=await f.connection.acquireCommunityAssessmentAdmission('observer');await assert.rejects(assessment.turnCommunityAssessment('observer','body'),e=>e.code==='COMMUNITY_ASSESSMENT_TIMEOUT');
    await assessment.close();await g.close();assert.equal(f.actors[0].closes,1);assert.equal((await f.runtime.verifyAnalysisSettlement(a.nativeBinding)).replacementReady,true);
  }finally{gate.resolve();await f.cleanup();}
});

test('serial adapter preserves exact legacy contracts and authenticates shown routing before narrowing',async()=>{
  const seen=[],f=fixture({runAnalysis:async({input,workerId,ref})=>{await input.onToolResultSent({purpose:'history-analysis',workerId,requestRef:ref,callRef:'shown',name:'neurobro_analysis_material',result:{success:true}});return 1;}});
  try{await f.connection.prepareAnalysis();const lease=await f.connection.acquireAnalysisAdmission('legacy');
    assert.deepEqual(Object.keys(lease).sort(),['abortAndJoin','close','nativeBinding','releaseAnalysis','turnAnalysis']);
    const actualWork={taskRef:'htask_real',planRef:'hattempt_real',workRef:'hattempt_real'};
    const result=await lease.turnAnalysis('legacy','merge',{...callbacks('unused',async event=>{assert.deepEqual(Object.keys(event).sort(),['callRef','name','requestRef','result']);seen.push(event);}),work:actualWork});
    assert.deepEqual(Object.keys(result).sort(),['answer','kind','scope','toolCalls','toolRefusals']);assert.deepEqual(f.actors[0].turns[0].binding,actualWork);assert.equal(seen.length,1);
    await lease.releaseAnalysis('legacy');await lease.close();assert.equal(f.actors[0].closes,0);
  }finally{await f.cleanup();}
});

test('serial adapter rejects misbound or active completion fields and joins without healthy release or replay',async()=>{
  let reads=0;const mutations=[r=>({...r,workerId:'other'}),r=>({...r,scope:{...r.scope,epochId:'f'.repeat(32)}}),r=>({...r,scope:{...r.scope,requestRef:'other'}}),r=>({...r,scope:{...r.scope,purpose:'conversation'}}),r=>({...r,extra:true}),r=>Object.defineProperty({...r},'answer',{get(){reads++;return 'active';}})];
  for(const completed of mutations){const f=fixture({completed});try{await f.connection.prepareAnalysis();const lease=await f.connection.acquireAnalysisAdmission('bound');await assert.rejects(lease.turnAnalysis('bound','merge',callbacks('actual-attempt')));
    assert.equal(f.actors[0].closes,1);assert.equal(f.connection.state().failedAnalysisTurn,true);assert.equal(f.events.includes('analysis-release'),false);await assert.rejects(lease.turnAnalysis('bound','again',callbacks('actual-attempt')));assert.equal(f.actors[0].turns.length,1);await lease.close();
  }finally{await f.cleanup();}}assert.equal(reads,0);
});

test('cold background and foreground preparation share one owner and preserve restoration',async()=>{
  const f=fixture();try{const results=await Promise.all([f.connection.prepareAnalysis(),f.connection.prepareAnalysis(),f.connection.prepare()]);assert.deepEqual(results,[{restoration:true},{restoration:true},{restoration:true}]);assert.equal(f.actors.length,1);
    await f.connection.turn('consume-restoration','body');await f.connection.release('consume-restoration','verified');assert.deepEqual(await f.connection.prepareAnalysis(),{restoration:false});assert.deepEqual(await f.connection.prepare(),{restoration:false});
  }finally{await f.cleanup();}
});

test('background preparation reuses analysis capacity during an active foreground turn',async()=>{
  const gate=deferred(),f=fixture({conversationGate:gate});try{await f.connection.prepare();const foreground=f.connection.turn('foreground','body');await tick();await f.connection.prepareAnalysis();
    const lease=await f.connection.acquireAnalysisAdmission('background');await lease.turnAnalysis('background','body',callbacks('attempt'));await lease.releaseAnalysis('background');await lease.close();assert.equal(f.actors[0].closes,0);
    gate.resolve();await foreground;await f.connection.release('foreground','verified');
  }finally{gate.resolve();await f.cleanup();}
});

test('background rotation needs the full configured wave and waits foreground delivery release',async()=>{
  const gate=deferred(),f=fixture({conversationGate:gate});try{await f.connection.prepare();const foreground=f.connection.turn('foreground','body');await tick();f.actors[0].retire('worker-2');
    let ready=false;const background=f.connection.prepareAnalysis().then(r=>{ready=true;return r;});const queuedForeground=f.connection.prepare();await tick();assert.equal(ready,false);assert.equal(f.actors[0].closes,0);
    gate.resolve();await foreground;await tick();assert.equal(ready,false);assert.equal(f.actors[0].closes,0);await f.connection.release('foreground','verified');await background;await queuedForeground;
    assert.equal(f.actors[0].closes,1);assert.equal(f.actors.length,2);assert.equal(f.events.filter(e=>e==='conversation').length,1);
    const group=await f.connection.acquireParallelAnalysisAdmissions(['new-a','new-b']);await group.close();
  }finally{gate.resolve();await f.cleanup();}
});

test('background preparation can be cancelled while waiting for foreground delivery',async()=>{
  const f=fixture();try{await f.connection.prepare();await f.connection.turn('foreground','body');f.actors[0].retire('worker-1');const preparing=f.connection.prepareAnalysis();await tick();const rejected=assert.rejects(preparing,e=>e.code==='STOPPED');await f.connection.close();await rejected;assert.equal(f.actors[0].closes,1);assert.equal(f.actors.length,1);
  }finally{await f.cleanup();}
});

test('analysis reservation rotates safely if foreground consumed the prepared remaining wave budget',async()=>{
  const f=fixture();try{await f.connection.prepare();for(let i=0;i<14;i++){await f.connection.turn('foreground-'+i,'body');await f.connection.release('foreground-'+i,'verified');}
    await f.connection.prepareAnalysis();assert.equal(f.actors.length,1);await f.connection.turn('foreground-14','body');await f.connection.release('foreground-14','verified');
    const group=await f.connection.acquireParallelAnalysisAdmissions(['preserved-a','preserved-b']);assert.equal(f.actors.length,2);assert.equal(f.actors[0].closes,1);assert.deepEqual(group.leases.map(l=>l.nativeBinding.requestRef),['preserved-a','preserved-b']);await group.close();
  }finally{await f.cleanup();}
});

test('analysis acquisition joins a foreground rotation started after background preparation',async()=>{
  const closeGate=deferred(),f=fixture({closeGate});try{await f.connection.prepareAnalysis();f.actors[0].rotate();const foreground=f.connection.prepare();await tick();assert.equal(f.events.includes('close'),true);
    const refs=['retained-a','retained-b'],acquiring=f.connection.acquireParallelAnalysisAdmissions(refs);refs[0]='mutated-after-call';let acquired=false;void acquiring.then(()=>{acquired=true;});await tick();assert.equal(acquired,false);closeGate.resolve();await foreground;
    const group=await acquiring;assert.deepEqual(group.leases.map(l=>l.nativeBinding.requestRef),['retained-a','retained-b']);assert.equal(f.actors.length,2);assert.equal(f.actors[0].closes,1);await group.close();
  }finally{closeGate.resolve();await f.cleanup();}
});

test('analysis acquisition rotates expired idle workers after a successful readiness check',async()=>{
  const f=fixture();try{await f.connection.prepareAnalysis();f.actors[0].retire('worker-2');const group=await f.connection.acquireParallelAnalysisAdmissions(['expired-a','expired-b']);
    assert.equal(f.actors[0].closes,1);assert.equal(f.actors.length,2);assert.deepEqual(group.leases.map(l=>l.nativeBinding.requestRef),['expired-a','expired-b']);await group.close();
  }finally{await f.cleanup();}
});

test('background-only readiness and acquisition retain the native foreground reserve and count assessments',async()=>{
  for(const prepareFirst of [true,false]){const f=fixture();try{await f.connection.prepareAnalysis();
    const assessment=await f.connection.acquireCommunityAssessmentAdmission('assessment');await assessment.turnCommunityAssessment('assessment','body');await assessment.releaseCommunityAssessment('assessment');await assessment.close();
    for(let i=0;i<13;i++){const ref='cold-'+i,lease=await f.connection.acquireAnalysisAdmission(ref);await lease.turnAnalysis(ref,'body',callbacks('attempt-'+i));await lease.releaseAnalysis(ref);await lease.close();}
    assert.equal(f.actors.length,1);assert.equal(f.events.includes('conversation'),false);
    if(prepareFirst)await f.connection.prepareAnalysis();const group=await f.connection.acquireParallelAnalysisAdmissions(['reserved-a','reserved-b']);assert.equal(f.actors.length,2);assert.equal(f.actors[0].closes,1);assert.deepEqual(group.leases.map(l=>l.nativeBinding.requestRef),['reserved-a','reserved-b']);await group.close();
  }finally{await f.cleanup();}}
});

test('assessment admission rotates at the background cap without consuming the foreground reservation',async()=>{
  const f=fixture();try{await f.connection.prepareAnalysis();for(let i=0;i<15;i++){const ref='cold-'+i,lease=await f.connection.acquireAnalysisAdmission(ref);await lease.turnAnalysis(ref,'body',callbacks('attempt-'+i));await lease.releaseAnalysis(ref);await lease.close();}
    assert.equal(f.actors.length,1);const assessment=await f.connection.acquireCommunityAssessmentAdmission('assessment');assert.equal(f.actors.length,2);assert.equal(f.actors[0].closes,1);await assessment.turnCommunityAssessment('assessment','body');await assessment.releaseCommunityAssessment('assessment');await assessment.close();
  }finally{await f.cleanup();}
});

test('queued foreground work cannot prematurely spend the native foreground reserve',async()=>{
  const gate=deferred(),f=fixture({conversationGate:gate});try{await f.connection.prepareAnalysis();for(let i=0;i<13;i++){const ref='cold-'+i,lease=await f.connection.acquireAnalysisAdmission(ref);await lease.turnAnalysis(ref,'body',callbacks('attempt-'+i));await lease.releaseAnalysis(ref);await lease.close();}
    const foreground=f.connection.turn('foreground','body');await tick();let acquired=false;const acquiring=f.connection.acquireParallelAnalysisAdmissions(['after-foreground-a','after-foreground-b']).then(group=>{acquired=true;return group;});await tick();assert.equal(acquired,false);
    gate.resolve();await foreground;await tick();assert.equal(acquired,false);await f.connection.release('foreground','verified');const group=await acquiring;assert.equal(f.actors.length,1);assert.equal(f.actors[0].closes,0);await group.close();
  }finally{gate.resolve();await f.cleanup();}
});

test('actual runtime factory drives a persisted parallel wave then exact legacy terminal leaf and final merge',async()=>{
  const compiled=resolve(process.env.NEUROBRO_GATEWAY_BUILD??'packages/telegram-gateway/dist');
  const modules=await Promise.all(['standing-history-task-store','standing-history-task-control-store','standing-history-analysis-store','standing-history-analysis-attempt-store','standing-history-analysis-step'].map(name=>import(pathToFileURL(resolve(compiled,'src',name+'.js')).href)));
  const [{openStandingHistoryTaskStore},{openStandingHistoryTaskControlStore},{openStandingHistoryAnalysisStore},{openStandingHistoryAnalysisAttemptStore},{openStandingHistoryAnalysisStep}]=modules;
  const intent={schema:'standing-history-task-v1',taskId:'htask_'+'6'.repeat(48),accountId:'123',chatId:'-100456',requesterId:'456',primaryMessageId:999,fromDate:1000,toDate:2000,timezone:'Europe/Moscow',objective:'Synthetic available history analysis'};
  const binding={intent,passphrase:'synthetic-analysis-step-passphrase'},kinds=[],works=[];
  const f=fixture({runAnalysis:async({input,workerId,ref,body,binding:actualWork,signal})=>{
    kinds.push(JSON.parse(body).kind);works.push(actualWork);
    const material=await input.analysisTools[0].call({},{requestRef:ref,callRef:'material',signal});assert.equal(material.success,true);
    await input.onToolResultSent({purpose:'history-analysis',workerId,requestRef:ref,callRef:'material',name:'neurobro_analysis_material',result:material});
    const prepared=await input.analysisTools[2].call({output:{summary:'Synthetic bound '+ref,claims:[]}},{requestRef:ref,callRef:'commit',signal});assert.equal(prepared.success,true);
    await input.onToolResultSent({purpose:'history-analysis',workerId,requestRef:ref,callRef:'commit',name:'neurobro_analysis_commit',result:prepared});return 2;
  }});
  const temporary=mkdtempSync(resolve(tmpdir(),'neurobro-runtime-step-')),directories=Object.fromEntries(['pages','control','analysis','attempts'].map(name=>[name,resolve(temporary,name)]));for(const directory of Object.values(directories))mkdirSync(directory);
  async function stores(mode='open'){
    const source=await openStandingHistoryTaskStore({...binding,directory:directories.pages,mode}),control=await openStandingHistoryTaskControlStore({...binding,directory:directories.control,mode});
    const analysis=await openStandingHistoryAnalysisStore({...binding,directory:directories.analysis,mode,readSourcePage:i=>source.readPage(i)}),attempts=await openStandingHistoryAnalysisAttemptStore({...binding,directory:directories.attempts,mode,analysis});
    return{source,analysis,attempts,async close(){await attempts.close();await analysis.close();await source.close();await control.close();}};
  }
  function page(before){const id=(before.offsetId||1000)-1,date=before.lastDate-1,ref='m_'+id.toString(16).padStart(24,'0');const next={...before,pages:before.pages+1,offsetId:id,lastDate:date,oldestDate:date,newestDate:before.newestDate??date,upperBoundMessageId:before.upperBoundMessageId??id};
    return{beforeCheckpoint:before,nextCheckpoint:next,sources:[{messageId:id,date,disposition:'included',messageRef:ref,authorId:'456'}],page:{schema:'neurobro-self-history-v1',fromDate:before.fromDate,toDate:before.toDate,messages:[{ref,authorRef:'a_'+'4'.repeat(24),author:'user',displayName:'Synthetic speaker',date,editedAt:null,replyRef:null,replyUnavailable:false,text:'Private source '+id}],cursor:null,hasMore:true,status:'more',coverage:{scope:'available-history-snapshot',oldestExaminedDate:next.oldestDate,newestExaminedDate:next.newestDate,traversalComplete:false,undatedEntries:0,pages:next.pages},excluded:{nonText:0,invalidText:0,unavailable:0,outsidePeriod:0},limitations:['text-only','not-a-full-archive','deleted-or-hidden-content-not-recoverable','edits-may-change-between-pages']}};
  }
  let step;
  try{
    const initial=await stores('create');try{for(let i=0;i<16;i++){const before=(await initial.source.status()).readProgress.checkpoint;await initial.source.appendPage({expectedCheckpoint:before,result:page(before)});}}finally{await initial.close();}
    const args={...binding,directories,signal:f.control.signal,verifyOwnerSettled:f.runtime.verifyAnalysisSettlement,parallel:{directory:resolve(temporary,'parallel'),maxLeaves:2},retainWorkingState:true};
    const next=async requestRef=>{await f.connection.prepareAnalysis();for(let i=0;i<80;i++){const r=await step.next({requestRef,connection:f.connection,signal:f.control.signal});if(r.kind!=='scan-more')return r;}assert.fail('scan budget');};
    step=await openStandingHistoryAnalysisStep(args);const wave=await next('real-wave');assert.equal(wave.kind,'parallel-wave');assert.deepEqual(wave.modelOutcomes,['observed','observed']);assert.equal(wave.release,'acknowledged');assert.equal(wave.node.index,2);await step.close();step=null;
    const tail=await stores();try{const before=(await tail.source.status()).readProgress.checkpoint,empty=page(before),after={...before,pages:before.pages+1,status:'empty-page'};
      await tail.source.appendPage({expectedCheckpoint:before,result:{...empty,sources:[],nextCheckpoint:after,page:{...empty.page,messages:[],hasMore:false,status:'empty-page',coverage:{...empty.page.coverage,oldestExaminedDate:before.oldestDate,newestExaminedDate:before.newestDate,traversalComplete:true,pages:after.pages}}}});
    }finally{await tail.close();}
    step=await openStandingHistoryAnalysisStep(args);for(const ref of ['terminal-leaf','native-final-merge']){const result=await next(ref);assert.equal(result.kind,'attempt');assert.equal(result.modelOutcome,'observed');assert.equal(result.release,'acknowledged');}await step.close();step=null;
    const saved=await stores();try{const attempts=await saved.attempts.status(),analysis=await saved.analysis.status();assert.equal(attempts.attempts,2);assert.equal(attempts.last.node.index,analysis.analysisNodes);}finally{await saved.close();}
    assert.deepEqual(kinds,['leaf','leaf','leaf','merge']);assert.equal(works.length,4);for(const w of works){assert.equal(w.taskRef,intent.taskId);}for(const w of works.slice(2)){assert.match(w.workRef,/^hattempt_/);assert.equal(w.workRef,w.planRef);}assert.equal(f.actors.length,1);assert.equal(f.actors[0].closes,0);
  }finally{await step?.close();await f.cleanup();assert.ok(temporary.startsWith(resolve(tmpdir(),'neurobro-runtime-step-')));rmSync(temporary,{recursive:true,force:true});}
});
