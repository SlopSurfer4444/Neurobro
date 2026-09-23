import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { openStandingParallelEpochSession, type StandingParallelCustodyChild, type StandingParallelToolResultSent } from "../src/standing-parallel-epoch-session.js";
import { StandingWorkerTurnNotAdmitted, type StandingParallelWorkerPurpose } from "../src/standing-scoped-epoch-session.js";
import { createEpochWire } from "../src/standing-epoch-wire.js";
import type { EpochToolScope } from "../src/standing-tool-dispatcher.js";

const protocol="standing-parallel-epoch-v1";
const names=["neurobro_analysis_material","neurobro_analysis_notes","neurobro_analysis_commit"];
const body=JSON.stringify({schema:"neurobro-history-analysis-input-v1",kind:"leaf",objective:"Inspect bound material",materialAvailable:true});
const result=()=>({success:true,contentItems:[{type:"inputText",text:'{"available":true}'}]});
const binding=(id:string)=>({taskRef:"task",planRef:"plan",workRef:"work-"+id});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
const tick=()=>new Promise<void>(r=>setImmediate(r));
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64");
type Slot={workerId:string;purpose:StandingParallelWorkerPurpose;turns:number;tools:number;pending:boolean;current:any};
class PoolPeer {
  readable=new PassThrough(); sent:any[]=[];
  slots:Slot[]; custody:readonly StandingParallelCustodyChild[];
  receipt:unknown={sentinel:"unvalidated-pool-receipt",resourcesSettled:false};
  constructor(readonly assessment=false){
    this.slots=(["conversation","history-analysis","history-analysis",...(assessment?["community-assessment"]:[])] as StandingParallelWorkerPurpose[])
      .map((purpose,i)=>({workerId:"worker-"+i,purpose,turns:0,tools:0,pending:false,current:undefined}));
    this.custody=this.slots.map((slot,i)=>({workerId:slot.workerId,purpose:slot.purpose,processId:100+i,custody:{authenticatedByOwner:true},capabilities:{authenticatedByOwner:true}}));
  }
  push(value:unknown){this.readable.write(JSON.stringify(value)+"\n");}
  output(slot:Slot,frame:unknown){this.push({workerId:slot.workerId,frame});}
  start(change?:(ready:any)=>void){const ready={kind:"poolReady",protocol,workers:this.slots.map(({workerId,purpose})=>({workerId,purpose}))};change?.(ready);this.push(ready);
    for(const slot of this.slots)this.output(slot,{kind:"ready",protocol,scopes:[{purpose:slot.purpose,tools:slot.purpose==="conversation"?["neurobro_read_history"]:slot.purpose==="history-analysis"?names:[]}]});
  }
  begin(slot:Slot,frame:any){slot.turns++;slot.current=frame;slot.pending=true;}
  tool(slot:Slot){slot.tools++;this.output(slot,{kind:"tool",purpose:slot.purpose,requestRef:slot.current.requestRef,callRef:"call-"+slot.turns,name:names[0],arguments:{}});}
  complete(slot:Slot,image=false){const scope={purpose:slot.purpose,requestRef:slot.current.requestRef,threadId:"thread-"+slot.workerId,turnId:"turn-"+slot.turns,turnNumber:slot.turns};this.output(slot,{kind:"scope",scope});
    if(image){const ref="img_"+"ab".repeat(24),sha256=createHash("sha256").update(png).digest("hex");
      this.output(slot,{kind:"imageBegin",artifact:{schema:"neurobro-generated-image-artifact-v1",ref,origin:{requestRef:scope.requestRef,threadId:scope.threadId,turnId:scope.turnId,itemId:"image"},mimeType:"image/png",byteLength:png.length,sha256,width:1,height:1}});
      this.output(slot,{kind:"imageChunk",artifactRef:ref,sequence:0,dataBase64:png.toString("base64")});this.output(slot,{kind:"imageEnd",artifactRef:ref,chunkCount:1,byteLength:png.length,sha256});}
    this.output(slot,{kind:"completed",scope,answer:slot.purpose==="community-assessment"?JSON.stringify({decision:"silent",caseKey:null,answer:null}):"Bound worker result",kindOfAnswer:image?"image":"text",toolCalls:slot.purpose==="history-analysis"?1:0,toolRefusals:0});
  }
  facts(slot:Slot){return {schema:"neurobro-native-image-epoch-v1",turnLimit:16,epochSeconds:900,turnSeconds:300,threadStarted:slot.turns>0,poisoned:false,busy:false,running:false,releasePending:false,closed:true,resourceSettlementObserved:false,turnsAdmitted:slot.turns,turnsAttempted:slot.turns,toolCalls:slot.tools,unreleasedTurn:slot.pending};}
  shutdown(omit?:string){for(const slot of this.slots)if(slot.workerId!==omit)this.output(slot,{kind:"closed",code:"CLOSED",facts:this.facts(slot)});
    this.push({kind:"poolClosed",protocol,code:"CLOSED",receipt:this.receipt});this.push({kind:"epochResult",receipt:{nextOwnerFrame:true}});
  }
  plan:(envelope:any)=>void=envelope=>{
    if(envelope.kind==="close"){this.shutdown();return;}
    const slot=this.slots.find(s=>s.workerId===envelope.workerId)!;assert.ok(slot);const frame=envelope.frame;
    assert.notEqual(frame.kind,"close","inner worker close must never hit the wire");
    if(frame.kind==="turn"){this.begin(slot,frame);if(slot.purpose==="history-analysis"){assert.deepEqual(envelope.work,binding(frame.requestRef));this.tool(slot);}else{assert.equal("work"in envelope,false);this.complete(slot);}}
    else if(frame.kind==="toolResult")this.complete(slot);
    else if(frame.kind==="release"){slot.pending=false;this.output(slot,{kind:"released",purpose:slot.purpose,requestRef:frame.requestRef,delivery:frame.delivery});}
  };
}
async function fixture(options:{peer?:PoolPeer;changeReady?:(ready:any)=>void;call?:(args:unknown,scope:EpochToolScope)=>Promise<unknown>;shown?:(event:StandingParallelToolResultSent)=>Promise<void>|void}={}){
  const peer=options.peer??new PoolPeer(),control=new AbortController(),events:StandingParallelToolResultSent[]=[];
  const writable=new Writable({write(bytes,_encoding,done){try{const value=JSON.parse(bytes.toString());peer.sent.push(value);peer.plan(value);done();}catch(error){done(error as Error);}}});
  const wire=createEpochWire({readable:peer.readable,writable,multiplexVisualInputs:true});let reads=0,maxReads=0;
  const tracked={send:wire.send,receive:async(timeout:number)=>{reads++;maxReads=Math.max(maxReads,reads);try{return await wire.receive(timeout);}finally{reads--;}}};
  peer.start(options.changeReady);
  try{
    const session=await openStandingParallelEpochSession({epochId:"a".repeat(32),wire:tracked,signal:control.signal,custodyReady:()=>!control.signal.aborted,
      custodyChildren:peer.custody,parallelOptions:{analysisWorkers:2,communityAssessment:peer.assessment},conversation:{history:{call:async()=>result()}},
      analysisTools:names.map(name=>({name,call:options.call??(async()=>result())})),onToolResultSent:async event=>{events.push(event);await options.shown?.(event);}});
    return{peer,session,events,control,wire,maxReads:()=>maxReads,close:async()=>{await session.close().catch(()=>{});wire.close();peer.readable.destroy();writable.destroy();}};
  }catch(error){wire.close();peer.readable.destroy();writable.destroy();throw error;}
}

test("composite uses actual multiplex streams for overlapping analysis workers and foreground",async()=>{
  const entered=deferred(),done=deferred();let callbacks=0;
  const f=await fixture({call:async()=>{if(++callbacks===2)entered.resolve();await done.promise;return result();}});
  try{
    assert.deepEqual(f.session.analysisWorkerIds(),["worker-1","worker-2"]);
    const a=f.session.turnAnalysis("worker-1","a1",body,binding("a1")),b=f.session.turnAnalysis("worker-2","a2",body,binding("a2"));await entered.promise;
    await assert.rejects(f.session.turnAnalysis("worker-1","again",body,binding("again")));
    const c=await f.session.turnConversation("c1","Question");assert.equal(c.kind,"text");await f.session.releaseConversation("c1","verified");
    assert.equal(f.session.admission("worker-1"),"unavailable");assert.equal(f.session.admission(),"ready");done.resolve();
    assert.equal((await a).workerId,"worker-1");assert.equal((await b).workerId,"worker-2");
    await Promise.all([f.session.releaseAnalysis("worker-1","a1"),f.session.releaseAnalysis("worker-2","a2")]);
    assert.deepEqual(f.events.map(e=>[e.workerId,e.requestRef]).sort(),[["worker-1","a1"],["worker-2","a2"]]);
    assert.equal(f.session.state().workers.length,3);assert.equal("turns"in f.session.state(),false);
    const [closed,same]=await Promise.all([f.session.close(),f.session.close()]);assert.equal(closed,same);
    assert.equal(closed.resourceSettlementObserved,false);assert.deepEqual(closed.poolClosed.receipt,f.peer.receipt);assert.equal(closed.workers.length,3);
    assert.equal(f.peer.sent.filter(v=>v.kind==="close").length,1);assert.equal(f.maxReads(),1);
    assert.deepEqual(await f.wire.receive(1000),{kind:"epochResult",receipt:{nextOwnerFrame:true}});
  }finally{done.resolve();await f.close();}
});

test("composite authenticates pool identities and purposes against custody before any turn",async()=>{
  for(const edit of [(r:any)=>{r.protocol="wrong";},(r:any)=>{r.workers[1].workerId="foreign";},(r:any)=>{r.workers[1].purpose="conversation";},(r:any)=>{r.workers[1]=r.workers[2];},(r:any)=>{r.workers.pop();}]){
    const peer=new PoolPeer();await assert.rejects(fixture({peer,changeReady:edit}));assert.equal(peer.sent.filter(f=>f.frame?.kind==="turn").length,0);assert.equal(peer.sent.filter(f=>f.kind==="close").length,1);
  }
});

test("composite malformed worker readiness joins startup failure and sends one global close",async()=>{
  const peer=new PoolPeer(),output=peer.output.bind(peer);peer.output=(slot,frame:any)=>output(slot,slot.workerId==="worker-1"&&frame.kind==="ready"?{...frame,protocol:"wrong"}:frame);
  await assert.rejects(fixture({peer}));assert.equal(peer.sent.filter(v=>v.kind==="close").length,1);assert.equal(peer.sent.filter(v=>v.frame?.kind==="turn").length,0);
});

test("composite snapshots inert identity and callback inputs without invoking getters or proxy traps",async()=>{
  let touched=0,reads=0;
  const getter=(key:string)=>Object.defineProperty({},key,{enumerable:true,get(){touched++;throw Error();}});
  const proxy=(v:object)=>new Proxy(v,{getOwnPropertyDescriptor(){touched++;throw Error();},getPrototypeOf(){touched++;throw Error();},get(){touched++;throw Error();}});
  const base={epochId:"a".repeat(32),wire:{send:async()=>{},receive:async()=>{reads++;throw Error();}},signal:new AbortController().signal,custodyReady:()=>true,
    custodyChildren:new PoolPeer().custody,parallelOptions:{analysisWorkers:2,communityAssessment:false},conversation:{history:{call:async()=>result()}},
    analysisTools:names.map(name=>({name,call:async()=>result()})),onToolResultSent:()=>{}};
  const epochGetter={...base};Object.defineProperty(epochGetter,"epochId",Object.getOwnPropertyDescriptor(getter("epochId"),"epochId")!);
  const childGetter=Object.defineProperty({...base.custodyChildren[0]},"workerId",Object.getOwnPropertyDescriptor(getter("workerId"),"workerId")!);
  for(const input of [epochGetter,{...base,conversation:proxy(base.conversation)},{...base,wire:Object.assign(getter("send"),{receive:base.wire.receive})},
    {...base,analysisTools:[Object.assign(getter("call"),{name:names[0]}),...base.analysisTools.slice(1)]},
    {...base,custodyChildren:[childGetter,...base.custodyChildren.slice(1)]}]){
    await assert.rejects(openStandingParallelEpochSession(input as typeof base));
  }
  assert.equal(touched,0);assert.equal(reads,0);
});

test("composite close revokes and joins analysis callback while keeping the sole receipt reader",async()=>{
  const entered=deferred(),done=deferred();let signal:AbortSignal|undefined;
  const f=await fixture({call:async(_args,scope)=>{signal=scope.signal;entered.resolve();await done.promise;return result();}});
  try{const failed=assert.rejects(f.session.turnAnalysis("worker-1","a1",body,binding("a1")));await entered.promise;
    let settled=false;const closing=f.session.close().then(value=>{settled=true;return value;});await tick();assert.equal(signal!.aborted,true);assert.equal(settled,false);
    done.resolve();await failed;const closed=await closing;assert.equal(closed.unreleasedTurn,true);assert.equal(closed.resourceSettlementObserved,false);
    assert.equal(f.peer.sent.filter(v=>v.frame?.kind==="toolResult").length,0);assert.equal(f.events.length,0);assert.equal(f.peer.sent.filter(v=>v.kind==="close").length,1);assert.equal(f.maxReads(),1);
    assert.deepEqual(await f.wire.receive(1000),{kind:"epochResult",receipt:{nextOwnerFrame:true}});
  }finally{done.resolve();await f.close();}
});

test("composite owner signal revocation preserves final drain and no duplicate close",async()=>{
  const f=await fixture();try{f.control.abort();const closed=await f.session.close();assert.equal(closed.nativeLoopClosed,true);
    assert.equal(f.peer.sent.filter(v=>v.kind==="close").length,1);assert.deepEqual(await f.wire.receive(1000),{kind:"epochResult",receipt:{nextOwnerFrame:true}});
  }finally{await f.close();}
});

test("composite worker refusal keeps other work alive until owner-controlled shutdown",async()=>{
  const peer=new PoolPeer(),ordinary=peer.plan;peer.plan=envelope=>{
    if(envelope.workerId==="worker-1"&&envelope.frame.kind==="turn")peer.output(peer.slots[1]!,{kind:"notAdmitted",purpose:"history-analysis",requestRef:envelope.frame.requestRef,reason:"time",turnsAdmitted:0});else ordinary(envelope);
  };
  const f=await fixture({peer});try{
    await assert.rejects(f.session.turnAnalysis("worker-1","a1",body,binding("a1")),StandingWorkerTurnNotAdmitted);
    assert.equal(peer.sent.filter(v=>v.kind==="close").length,0);assert.equal(f.session.admission("worker-1"),"unavailable");
    assert.equal((await f.session.turnAnalysis("worker-2","a2",body,binding("a2"))).kind,"analysis");await f.session.releaseAnalysis("worker-2","a2");
    assert.equal((await f.session.turnConversation("c1","Question")).kind,"text");await f.session.releaseConversation("c1","not-sent");
    await f.session.close();assert.equal(peer.sent.filter(v=>v.kind==="close").length,1);
  }finally{await f.close();}
});

test("composite preserves large foreground pixels and generated image ownership",async()=>{
  const peer=new PoolPeer(),ordinary=peer.plan;peer.plan=e=>{if(e.frame?.kind==="turn"&&e.workerId==="worker-0"){peer.begin(peer.slots[0]!,e.frame);peer.complete(peer.slots[0]!,true);}else ordinary(e);};
  const f=await fixture({peer});try{const pixels=Buffer.alloc(1024*1024);png.copy(pixels);
    const answer=await f.session.turnConversation("c1","Image",[{mimeType:"image/png",bytes:pixels}]);assert.equal(answer.kind,"image");
    assert.equal(peer.sent[0].frame.images[0].base64,pixels.toString("base64"));await f.session.close();
    if(answer.kind!=="image")throw Error();assert.deepEqual(answer.image.registry.copyBytes(answer.image.artifact.ref),png);answer.image.close();
  }finally{await f.close();}
});

test("composite optional assessment uses its authenticated independent tool-free worker",async()=>{
  const f=await fixture({peer:new PoolPeer(true)});try{
    const input=JSON.stringify({schema:"community-assessment-v1",assessmentRef:"m1",policyRevision:1,guidance:"Assess quoted source",
      observations:[{ref:"obs_"+"ab".repeat(12),date:1700000000,displayName:"Synthetic",text:"Quoted",truncated:false,media:{kind:"none",pixelsProvided:false}}],recentAlertSummary:""});
    const output=await f.session.turnCommunityAssessment("m1",input);assert.equal(output.kind,"community-assessment");await f.session.releaseCommunityAssessment("m1");
    assert.equal(f.events.length,0);assert.equal(f.peer.sent[0].workerId,"worker-3");await f.session.close();
  }finally{await f.close();}
});

test("composite refuses missing worker closure even when pool receipt claims settlement",async()=>{
  const peer=new PoolPeer(),ordinary=peer.plan;peer.receipt={resourcesSettled:true};peer.plan=e=>{if(e.kind==="close")peer.shutdown("worker-2");else ordinary(e);};
  const f=await fixture({peer});try{await assert.rejects(f.session.close());assert.deepEqual(await f.wire.receive(1000),{kind:"epochResult",receipt:{nextOwnerFrame:true}});}finally{await f.close();}
});

test("composite denies global duplicate request ids and forged work binding before another native turn",async()=>{
  const f=await fixture();try{
    await assert.rejects(f.session.turnAnalysis("worker-1","a1",body,{...binding("a1"),workRef:"bad\n"}));assert.equal(f.peer.sent.length,0);
    await f.session.turnConversation("same","Question");await f.session.releaseConversation("same","not-sent");
    await assert.rejects(f.session.turnAnalysis("worker-1","same",body,binding("same")));await f.session.close().catch(()=>{});
    assert.equal(f.peer.sent.filter(v=>v.frame?.kind==="turn").length,1);
  }finally{await f.close();}
});

// Actual production owner + concrete composite/wire, with only the OS/native
// boundary substituted by private Node streams and explicit fixture receipts.
const verification=new URL("../../../../project/verification/",import.meta.url);
const ownerModule=await import(new URL("rm-0032-standing-epoch-owner.mjs",verification).href);
const receiptModule=await import(new URL("rm-0032-standing-epoch-receipt.mjs",verification).href);
const bootstrapPayload=Buffer.from("synthetic source-bound parallel owner fixture"),bootstrapLength=Buffer.alloc(4);bootstrapLength.writeUInt32BE(bootstrapPayload.length);
const bootstrap=Buffer.concat([bootstrapLength,Buffer.from(createHash("sha256").update(bootstrapPayload).digest("hex")),bootstrapPayload]);
class OwnedPoolChild extends EventEmitter {
  readonly peer=new PoolPeer();readonly stdin=new PassThrough();readonly stdout=this.peer.readable;readonly stderr=new PassThrough();
  bytes:Buffer=Buffer.alloc(0);bootstrapped=false;kills=0;exitCode=0;
  refused=new Map<string,any>();
  constructor(readonly mismatch:"none"|"pool"|"custody"|"population"="none",readonly physical=false){
    super();
    this.peer.custody=this.peer.custody.map(c=>({...c,custody:{initialize:true,profile:true,controlsPassed:true,relayAfter:false,accountChatgpt:true,astraMedium:true,
      probePass:Array(9).fill(true),probeExitCodes:[0,20,20,20,20,20,40,30,60]},capabilities:{checked:true,imageGeneration:true,namespaceTools:true,webSearch:true}}));
    this.peer.shutdown=()=>{
      const unknown=this.peer.slots.some(s=>s.pending)||this.mismatch==="population";this.exitCode=unknown?1:0;
      const children=this.peer.custody.map(c=>{const slot=this.peer.slots.find(s=>s.workerId===c.workerId)!;
        const turn=[...this.peer.sent].reverse().find(e=>e.workerId===c.workerId&&e.frame?.kind==="turn");
        const current=slot.pending?slot.current:this.refused.get(c.workerId);
        return {workerId:c.workerId,processId:c.processId,turnJoined:true,resourcesSettled:true,pendingBinding:current?{
          epochRef:"a".repeat(32),workerId:c.workerId,processId:c.processId,purpose:c.purpose,requestRef:current.requestRef,
          ...(turn.work??{taskRef:"foreground",planRef:"foreground",workRef:current.requestRef}),inputSha256:createHash("sha256").update(current.input).digest("hex")}:null,pendingOutcome:slot.pending?"unknown":current?"not-admitted":null};});
      if(this.mismatch==="population")children.push({workerId:"extra-worker",processId:999,turnJoined:true,resourcesSettled:true,pendingBinding:null,pendingOutcome:null});
      const turns=this.peer.slots.reduce((n,s)=>n+s.turns,0)+this.refused.size,foreground=this.peer.slots[0]!.turns;
      const pool={schema:"history-parallel-native-pool-v1",epochRef:"a".repeat(32),resourcesSettled:true,replacementReady:true,relaySettlementObserved:false,children,
        budget:{turnStartDispatches:turns,foregroundDispatches:foreground,turnsAdmitted:turns,foregroundAdmissions:foreground,reservedReadBytes:0,reservedWriteBytes:0,closed:true}};
      const epoch={schema:"decadans.rm0032.standing-parallel-epoch.v1",outcome:unknown?"unknown":"observed",code:unknown?"SESSION_UNKNOWN":"OK",stage:"complete",injectedPorts:false,custodyChildren:this.peer.custody,pool};
      for(const slot of this.peer.slots)this.peer.output(slot,{kind:"closed",code:"CLOSED",facts:this.peer.facts(slot)});
      this.peer.push({kind:"poolClosed",protocol,code:"CLOSED",receipt:this.mismatch==="pool"?{...pool,budget:{...pool.budget,reservedReadBytes:1}}:pool});
      if(this.mismatch==="custody")epoch.custodyChildren=epoch.custodyChildren.map((c,i)=>i?c:{...c,capabilities:{...(c.capabilities as object),namespaceTools:false}});
      this.peer.push({kind:"epochResult",receipt:epoch});
      this.peer.push({kind:"supervisorResult",receipt:{schema:"standing-epoch-supervisor-v1",outcome:epoch.outcome,stage:"complete",preflight:true,custodyReady:true,
        clientNaturalSettlement:true,relaySettled:true,allProcessesSettled:true,settled:true,injectedPorts:false,clientExit:this.exitCode,relayExit:0,
        clientStdoutBytes:1000,clientStderrBytes:0,relayStdoutBytes:150,relayStderrBytes:0,client:epoch,
        relay:{version:1,settled:true,counters:{accepted:1,over_limit:0,refused:0,connected:1,completed:1,failed:0,cancelled:0,internal_error:0}},
        ...(this.physical?{physicalCleanup:{clientLaunchCaptured:true,relayLaunchCaptured:true,creationsJoined:true,ownershipKnown:true,
          clientUnitAbsent:true,relayUnitAbsent:true,unitChecksAfterCreations:true,transportsJoined:true,stdinClosed:true,stdoutEof:true,stderrEof:true,
          sessionTasksJoined:true,clientStopRequested:false,relayStopRequested:false,transportKillRequested:false,complete:true}}:{})}});
    };
    this.stdin.on("data",(data:Buffer)=>{
      this.bytes=Buffer.concat([this.bytes,data]);
      if(!this.bootstrapped){if(this.bytes.length<bootstrap.length)return;assert.deepEqual(this.bytes.subarray(0,bootstrap.length),bootstrap);
        this.bytes=this.bytes.subarray(bootstrap.length);this.bootstrapped=true;this.peer.push({kind:"poolCustodyReady",proof:this.peer.custody});this.peer.start();}
      for(;;){const end=this.bytes.indexOf(10);if(end<0)return;const envelope=JSON.parse(this.bytes.subarray(0,end).toString());this.bytes=this.bytes.subarray(end+1);this.peer.sent.push(envelope);this.peer.plan(envelope);}
    });
    this.stdin.on("finish",()=>{this.stdout.end();this.stderr.end();setImmediate(()=>{this.emit("exit",this.exitCode,null);this.emit("close",this.exitCode,null);});});
  }
  kill(){this.kills++;return false;}
}
async function ownedFixture(options:{call?:(args:unknown,scope:EpochToolScope)=>Promise<unknown>;mismatch?:"pool"|"custody"|"population";physical?:boolean;refuseWorker?:string}={}){
  const child=new OwnedPoolChild(options.mismatch,options.physical),records:any[]=[],events:StandingParallelToolResultSent[]=[];
  if(options.refuseWorker){const ordinary=child.peer.plan;child.peer.plan=e=>{
    if(e.workerId===options.refuseWorker&&e.frame?.kind==="turn"){
      child.refused.set(e.workerId,e.frame);const slot=child.peer.slots.find(s=>s.workerId===e.workerId)!;
      child.peer.output(slot,{kind:"notAdmitted",purpose:slot.purpose,requestRef:e.frame.requestRef,reason:"time",turnsAdmitted:slot.turns});
    }else ordinary(e);
  };}
  const owner=await ownerModule.startOwnedEpoch({epochId:"a".repeat(32),bootstrap,signal:new AbortController().signal,history:{call:async()=>result()},
    sessionMode:protocol,parallelOptions:{analysisWorkers:2,communityAssessment:false},analysisTools:names.map(name=>({name,call:options.call??(async()=>result())})),
    onToolResultSent:(event:StandingParallelToolResultSent)=>{events.push(event);},isWorkerTurnNotAdmitted:(error:unknown)=>error instanceof StandingWorkerTurnNotAdmitted,
    spawnChild:()=>child,createWire:createEpochWire,openSession:openStandingParallelEpochSession,
    recordFinal:async(value:unknown)=>{records.push(receiptModule.normalizeEpochOwnerRecord(value,"a".repeat(32)));}});
  return{owner,child,records,events};
}

test("production owner persists actual composite closure only after final receipts, EOF and child close",async()=>{
  const f=await ownedFixture();
  const [a,b]=await Promise.all([f.owner.turnAnalysis("worker-1","a1",body,binding("a1")),f.owner.turnAnalysis("worker-2","a2",body,binding("a2"))]);
  assert.equal(a.workerId,"worker-1");assert.equal(b.workerId,"worker-2");
  await Promise.all([f.owner.releaseAnalysis("worker-1","a1"),f.owner.releaseAnalysis("worker-2","a2")]);
  await f.owner.turnConversation("c1","Question");await f.owner.releaseConversation("c1","verified");
  const closed=await f.owner.close();assert.equal(closed.successfulEpoch,true);assert.equal(closed.activeJoined,true);assert.equal(closed.wireCleanEof,true);
  assert.equal(closed.resourcesSettled,true);assert.equal(closed.persisted,true);assert.equal(f.records.length,1);assert.equal(f.child.kills,0);
  assert.equal(f.child.peer.sent.filter(v=>v.kind==="close").length,1);assert.equal(f.events.length,2);
});

test("production owner joins active worker callback before recording an interrupted pool",async()=>{
  const entered=deferred(),done=deferred();let signal:AbortSignal|undefined;
  const f=await ownedFixture({call:async(_args,scope)=>{signal=scope.signal;entered.resolve();await done.promise;return result();}});
  const failed=assert.rejects(f.owner.turnAnalysis("worker-1","a1",body,binding("a1")));await entered.promise;
  const closing=f.owner.close();await tick();assert.equal(signal!.aborted,true);assert.equal(f.records.length,0);done.resolve();await failed;
  const closed=await closing;assert.equal(closed.activeJoined,true);assert.equal(closed.persisted,true);assert.equal(closed.successfulEpoch,false);assert.equal(f.records.length,1);
  assert.equal(f.child.kills,0);assert.equal(f.events.length,0);assert.equal(f.child.peer.sent.filter(v=>v.frame?.kind==="toolResult").length,0);
});

test("production owner rejects pool receipt or final custody drift despite individually valid records",async()=>{
  for(const mismatch of ["pool","custody","population"] as const)for(const physical of [false,true]){const f=await ownedFixture({mismatch,physical});const closed=await f.owner.close();
    assert.equal(closed.successfulEpoch,false);assert.equal(closed.persisted,true);assert.equal(closed.replacementReady,false);assert.equal(f.records.length,1);
  }
});

test("production owner keeps sibling and foreground running after a bound worker refusal",async()=>{
  const entered=deferred(),done=deferred();const f=await ownedFixture({refuseWorker:"worker-1",call:async()=>{entered.resolve();await done.promise;return result();}});
  const refusal=assert.rejects(f.owner.turnAnalysis("worker-1","a1",body,binding("a1")),StandingWorkerTurnNotAdmitted);
  const sibling=f.owner.turnAnalysis("worker-2","a2",body,binding("a2"));await entered.promise;await refusal;
  assert.equal(f.owner.state().closing,false);assert.equal(f.child.peer.sent.filter(v=>v.kind==="close").length,0);
  await f.owner.turnConversation("c1","Foreground still available");await f.owner.releaseConversation("c1","verified");done.resolve();await sibling;await f.owner.releaseAnalysis("worker-2","a2");
  const closed=await f.owner.close();assert.equal(closed.successfulEpoch,true);assert.equal(closed.persisted,true);assert.equal(f.child.kills,0);
  const retained=f.records[0].diagnostics.epoch.pool.children.find((c:any)=>c.workerId==="worker-1");
  assert.equal(retained.pendingOutcome,"not-admitted");assert.equal(retained.pendingBinding.requestRef,"a1");assert.equal(retained.pendingBinding.workRef,"work-a1");
});
