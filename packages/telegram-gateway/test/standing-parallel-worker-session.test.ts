import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openStandingScopedEpochSession, StandingWorkerTurnNotAdmitted, type StandingParallelWorkerPurpose, type StandingToolResultSent } from "../src/standing-scoped-epoch-session.js";
import { EpochTurnNotAdmitted } from "../src/standing-epoch-session.js";
import { EpochWireTimeout } from "../src/standing-epoch-wire.js";

const names=["neurobro_analysis_material","neurobro_analysis_notes","neurobro_analysis_commit"];
const body=JSON.stringify({schema:"neurobro-history-analysis-input-v1",kind:"leaf",objective:"Analyze supplied source",materialAvailable:true});
const result=()=>({success:true,contentItems:[{type:"inputText",text:'{"available":true}'}]});
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64");
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise<void>(r=>setImmediate(r));
class WorkerPeer {
  queue:unknown[]; sent:any[]=[]; waiter:((value:unknown)=>void)|undefined;
  turns=0; tools=0; calls=0; pending=false; current:any;
  constructor(readonly purpose:StandingParallelWorkerPurpose="history-analysis"){
    this.queue=[{kind:"ready",protocol:"standing-parallel-epoch-v1",scopes:[{purpose,tools:purpose==="conversation"?["neurobro_read_history"]:purpose==="history-analysis"?names:[]}]}];
  }
  plan:(frame:any)=>void=frame=>{
    if(frame.kind==="turn"){this.begin(frame);this.complete();}
    else if(frame.kind==="release"){this.pending=false;this.push({kind:"released",purpose:this.purpose,requestRef:frame.requestRef,delivery:frame.delivery});if(frame.delivery==="unknown")this.closed("RELEASE_UNKNOWN");}
    else if(frame.kind==="close")this.closed();
  };
  begin(frame:any){this.current=frame;this.turns++;this.calls=0;this.pending=true;}
  scope(){return {purpose:this.purpose,requestRef:this.current.requestRef,threadId:"thread-"+this.purpose,turnId:"turn-"+this.turns,turnNumber:this.turns};}
  tool(name:string,patch={}){this.calls++;this.tools++;this.push({kind:"tool",purpose:this.purpose,requestRef:this.current.requestRef,callRef:"call-"+this.calls,name,arguments:{},...patch});}
  complete(patch={},image=false){const scope={...this.scope(),...patch};this.push({kind:"scope",scope});
    if(image){const ref="img_"+"ab".repeat(24),sha256=createHash("sha256").update(png).digest("hex");
      this.push({kind:"imageBegin",artifact:{schema:"neurobro-generated-image-artifact-v1",ref,origin:{requestRef:scope.requestRef,threadId:scope.threadId,turnId:scope.turnId,itemId:"image"},mimeType:"image/png",byteLength:png.length,sha256,width:1,height:1}});
      this.push({kind:"imageChunk",artifactRef:ref,sequence:0,dataBase64:png.toString("base64")});this.push({kind:"imageEnd",artifactRef:ref,chunkCount:1,byteLength:png.length,sha256});}
    this.push({kind:"completed",scope,answer:this.purpose==="community-assessment"?JSON.stringify({decision:"silent",caseKey:null,answer:null}):"Worker completion",kindOfAnswer:image?"image":"text",toolCalls:this.calls,toolRefusals:0});}
  facts(){return {schema:"neurobro-native-image-epoch-v1",turnLimit:16,epochSeconds:900,turnSeconds:300,threadStarted:this.turns>0,poisoned:false,busy:false,running:false,releasePending:false,closed:true,resourceSettlementObserved:false,turnsAdmitted:this.turns,turnsAttempted:this.turns,toolCalls:this.tools,unreleasedTurn:this.pending};}
  closed(code="CLOSED",patch={}){this.push({kind:"closed",code,facts:{...this.facts(),...patch}});}
  push(value:unknown){if(this.waiter){const done=this.waiter;this.waiter=undefined;done(value);}else this.queue.push(value);}
  async send(value:unknown,_timeout:number){this.sent.push(value);this.plan(value);}
  receive(timeout:number):Promise<unknown>{assert.ok(!this.waiter,"one worker reader");if(this.queue.length)return Promise.resolve(this.queue.shift());
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiter=undefined;reject(new EpochWireTimeout("read"));},timeout);this.waiter=value=>{clearTimeout(timer);resolve(value);};});}
}
async function setup(peer=new WorkerPeer(),options:{call?:(name:string,signal:AbortSignal)=>Promise<unknown>;shown?:(event:StandingToolResultSent)=>Promise<void>|void}={}){
  const control=new AbortController(),events:StandingToolResultSent[]=[];
  const session=await openStandingScopedEpochSession({epochId:"a".repeat(32),worker:{purpose:peer.purpose},wire:peer,signal:control.signal,custodyReady:()=>true,
    conversation:{history:{call:async()=>options.call?.("neurobro_read_history",control.signal)??result()}},
    analysisTools:names.map(name=>({name,call:async(_args,scope)=>options.call?.(name,scope.signal)??result()})),
    onToolResultSent:async event=>{events.push(event);await options.shown?.(event);}});
  return {session,events,control};
}

test("parallel workers retain independent local turns and actual named-tool exposure",async()=>{
  const a=new WorkerPeer(),b=new WorkerPeer("conversation"),ordinary=a.plan;
  a.plan=f=>{if(f.kind==="turn"){a.begin(f);a.tool(names[0]!);}else if(f.kind==="toolResult"){if(a.calls<3)a.tool(names[a.calls]!);else a.complete();}else ordinary(f);};
  const x=await setup(a),y=await setup(b);
  const [analysis,conversation]=await Promise.all([x.session.turnAnalysis("a1",body),y.session.turnConversation("c1","Question")]);
  assert.equal(analysis.kind,"analysis");assert.equal(analysis.scope.turnNumber,1);assert.equal(analysis.scope.threadTurnNumber,1);
  assert.equal("receipt"in analysis,false);assert.equal(conversation.kind,"text");assert.deepEqual(x.events.map(e=>e.name),names);
  assert.equal(x.session.admission(),"unavailable");await x.session.releaseAnalysis("a1");await y.session.releaseConversation("c1","verified");
  assert.equal((await x.session.turnAnalysis("a2",body)).scope.turnNumber,2);await x.session.releaseAnalysis("a2");
  for(const session of [x.session,y.session]){const close=await session.close();assert.equal(close.nativeLoopClosed,true);assert.equal(close.resourceSettlementObserved,false);}
});

for(const kind of ["leaf","merge","final-report","final-report-review"])for(const community of [false,true])test("parallel parser admits "+kind+" with "+(community?"community":"internal")+" source and enforces its period contract",async()=>{
  const peer=new WorkerPeer(),f=await setup(peer),packet={...JSON.parse(body),kind,...(community?{sourceRef:"community",sourceInterpretation:"quoted-source-not-request"}:{})};
  const before=f.session.state();
  const periodPacket=JSON.stringify({...packet,periodChronicle:{contextHash:"a".repeat(64),neutralPeriodNotesAvailable:true,periodAdvisoryAvailable:false}});
  const report=kind==="final-report"||kind==="final-report-review";
  if(report){
    await assert.rejects(f.session.turnAnalysis("period",periodPacket));
    assert.equal(peer.sent.length,0);assert.deepEqual(f.session.state(),before);
  }else{
    assert.equal((await f.session.turnAnalysis("period",periodPacket)).kind,"analysis");await f.session.releaseAnalysis("period");
  }
  const completed=await f.session.turnAnalysis("report",JSON.stringify(packet));
  assert.equal(completed.kind,"analysis");assert.equal(completed.scope.purpose,"history-analysis");
  const frame=peer.sent.filter(f=>f.kind==="turn").at(-1);
  assert.equal(frame.purpose,"history-analysis");assert.equal(frame.input,JSON.stringify(packet));
  assert.equal(peer.turns,report?1:2);await f.session.releaseAnalysis("report");await f.session.close();
});

test("parallel ready authenticates exact protocol, purpose, tools and mode",async()=>{
  for(const change of ["protocol","purpose","tools","extraScope"]){const peer=new WorkerPeer(),ready=peer.queue[0] as any;
    if(change==="protocol")ready.protocol="standing-scoped-epoch-v1";
    if(change==="purpose")ready.scopes[0].purpose="conversation";
    if(change==="tools")ready.scopes[0].tools=["neurobro_read_history"];
    if(change==="extraScope")ready.scopes.push({purpose:"conversation",tools:["neurobro_read_history"]});
    await assert.rejects(setup(peer));assert.equal(peer.sent.filter(f=>f.kind==="turn").length,0);
  }
  const peer=new WorkerPeer();await assert.rejects(openStandingScopedEpochSession({epochId:"a".repeat(32),worker:{purpose:"history-analysis"},sessionMode:"standing-scoped-epoch-v1",wire:peer,signal:new AbortController().signal,custodyReady:()=>true,conversation:{history:{call:async()=>result()}},analysisTools:[],onToolResultSent:()=>{}}));
  assert.equal(peer.sent.length,0);
});

test("parallel worker cannot acquire another purpose or analysis delivery authority",async()=>{
  const peer=new WorkerPeer(),f=await setup(peer);
  await assert.rejects(f.session.turnConversation("c1","Question"));await assert.rejects(f.session.turnCommunityAssessment("m1","{}"));assert.equal(peer.sent.length,0);
  await f.session.turnAnalysis("a1",body);await assert.rejects(f.session.releaseConversation("a1","verified"));
  await f.session.releaseAnalysis("a1");assert.equal(peer.sent.at(-1).delivery,"not-sent");await f.session.close();
});

test("parallel assessment worker preserves tool-free structured decisions",async()=>{
  const body=JSON.stringify({schema:"community-assessment-v1",assessmentRef:"m1",policyRevision:1,guidance:"Assess supplied source only",
    observations:[{ref:"obs_"+"ab".repeat(12),date:1700000000,displayName:"Synthetic",text:"Quoted source",truncated:false,media:{kind:"none",pixelsProvided:false}}],recentAlertSummary:""});
  const peer=new WorkerPeer("community-assessment"),x=await setup(peer);
  const value=await x.session.turnCommunityAssessment("m1",body);assert.equal(value.kind,"community-assessment");
  assert.deepEqual(value.decision,{decision:"silent",caseKey:null,answer:null});assert.equal("receipt"in value,false);assert.equal(x.events.length,0);
  await x.session.releaseCommunityAssessment("m1");assert.equal(x.session.state().communityAssessmentTurns,1);await x.session.close();
  const hostile=new WorkerPeer("community-assessment"),ordinary=hostile.plan;hostile.plan=f=>{if(f.kind==="turn"){hostile.begin(f);hostile.tool(names[0]!);}else ordinary(f);};
  let calls=0;const y=await setup(hostile,{call:async()=>{calls++;return result();}});
  await assert.rejects(y.session.turnCommunityAssessment("m1",body));await y.session.close().catch(()=>{});assert.equal(calls,0);assert.equal(y.events.length,0);
});

test("parallel scopes reject legacy extra counters, cross-worker purpose and fabricated turn number",async()=>{
  for(const patch of [{threadTurnNumber:1},{turnNumber:2},{purpose:"conversation"},{requestRef:"foreign"}]){
    const peer=new WorkerPeer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.complete(patch);}else ordinary(f);};
    const x=await setup(peer);await assert.rejects(x.session.turnAnalysis("a1",body));await x.session.close();assert.equal(x.session.state().poisoned,true);
  }
});

test("parallel foreground keeps incoming pixels and generated-image registry lifetime",async()=>{
  const peer=new WorkerPeer("conversation"),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.complete({},true);}else ordinary(f);};
  const x=await setup(peer),input={mimeType:"image/png" as const,bytes:png};
  const output=await x.session.turnConversation("c1","Draw",[input]);assert.equal(output.kind,"image");
  assert.deepEqual(peer.sent[0].images,[{mimeType:"image/png",base64:png.toString("base64")}]);await x.session.close();
  if(output.kind!=="image")throw Error();assert.deepEqual(output.image.registry.copyBytes(output.image.artifact.ref),png);output.image.close();assert.throws(()=>output.image.registry.get(output.image.artifact.ref));
  const a=new WorkerPeer(),normal=a.plan;a.plan=f=>{if(f.kind==="turn"){a.begin(f);a.complete({},true);}else normal(f);};
  const y=await setup(a);await assert.rejects(y.session.turnAnalysis("a1",body));await y.session.close();
});

test("parallel callback result is shown only after wire write and hook settlement",async()=>{
  const peer=new WorkerPeer(),ordinary=peer.plan,writeEntered=deferred(),writeDone=deferred(),hookEntered=deferred(),hookDone=deferred();
  peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.tool(names[0]!);}else if(f.kind==="toolResult")peer.complete();else ordinary(f);};
  const send=peer.send.bind(peer);peer.send=async(v:any,b)=>{await send(v,b);if(v.kind==="toolResult"){writeEntered.resolve();await writeDone.promise;}};
  const x=await setup(peer,{shown:async()=>{hookEntered.resolve();await hookDone.promise;}});let completed=false;
  const turning=x.session.turnAnalysis("a1",body).then(value=>{completed=true;return value;});await writeEntered.promise;assert.equal(x.events.length,0);assert.equal(completed,false);
  writeDone.resolve();await hookEntered.promise;await tick();assert.equal(completed,false);hookDone.resolve();await turning;
  await x.session.releaseAnalysis("a1");await x.session.close();
});

test("parallel close joins and revokes active tool without late result or exposure",async()=>{
  const peer=new WorkerPeer(),ordinary=peer.plan,entered=deferred(),done=deferred();let toolSignal:AbortSignal|undefined;
  peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.tool(names[0]!);}else ordinary(f);};
  const x=await setup(peer,{call:async(_name,signal)=>{toolSignal=signal;entered.resolve();await done.promise;return result();}});
  const failure=assert.rejects(x.session.turnAnalysis("a1",body));await entered.promise;let settled=false;const closing=x.session.close().then(()=>{settled=true;});
  await tick();assert.equal(toolSignal!.aborted,true);assert.equal(settled,false);done.resolve();await failure;await closing;
  assert.equal(x.events.length,0);assert.equal(peer.sent.filter(f=>f.kind==="toolResult").length,0);
});

test("parallel close rejects invented aggregate facts and cannot synthesize safe nonadmission",async()=>{
  for(const patch of [{resourceSettlementObserved:true},{turnStartDispatches:0},{turnsAdmitted:1},{schema:"neurobro-native-scoped-epoch-v1"}]){
    const peer=new WorkerPeer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="close")peer.closed("CLOSED",patch);else ordinary(f);};
    const x=await setup(peer);await assert.rejects(x.session.close());
  }
  const peer=new WorkerPeer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn")peer.push({kind:"notAdmitted",purpose:peer.purpose,requestRef:f.requestRef,reason:"time",turnsAdmitted:0,turnStartDispatches:0});else ordinary(f);};
  const x=await setup(peer);await assert.rejects(x.session.turnAnalysis("a1",body),e=>!(e instanceof EpochTurnNotAdmitted));await x.session.close().catch(()=>{});
  assert.equal(peer.sent.filter(f=>f.kind==="turn").length,1);
});

test("exact worker refusal retires only its local session until final pool closure",async()=>{
  for(const previous of [0,1])for(const reason of ["time","turns"] as const){
    const peer=new WorkerPeer(),other=new WorkerPeer("conversation"),x=await setup(peer),y=await setup(other);
    if(previous){await x.session.turnAnalysis("previous",body);await x.session.releaseAnalysis("previous");}
    const ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn")peer.push({kind:"notAdmitted",purpose:peer.purpose,requestRef:f.requestRef,reason,turnsAdmitted:previous});else ordinary(f);};
    let refusal:StandingWorkerTurnNotAdmitted|undefined;
    await assert.rejects(x.session.turnAnalysis("refused",body),error=>{
      assert.ok(error instanceof StandingWorkerTurnNotAdmitted);assert.equal(error instanceof EpochTurnNotAdmitted,false);refusal=error;return true;
    });
    assert.equal(refusal!.purpose,"history-analysis");assert.equal(refusal!.requestRef,"refused");assert.equal(refusal!.reason,reason);assert.equal(refusal!.turnsAdmitted,previous);
    assert.equal(x.session.state().phase,"retired");assert.equal(x.session.state().poisoned,false);assert.equal(x.session.admission(),"unavailable");
    const sent=peer.sent.length;await assert.rejects(x.session.turnAnalysis("retry",body));await assert.rejects(x.session.releaseAnalysis("refused"));assert.equal(peer.sent.length,sent);
    assert.equal(peer.sent.filter(f=>f.kind==="close").length,0);
    assert.equal((await y.session.turnConversation("c1","Unrelated foreground")).kind,"text");await y.session.releaseConversation("c1","not-sent");
    peer.closed();const final=await x.session.close({peerEnded:true});assert.equal(final.resourceSettlementObserved,false);assert.equal(final.unreleasedTurn,false);
    assert.equal(peer.sent.filter(f=>f.kind==="close").length,0);await y.session.close();
  }
});

test("worker refusal requires untouched matching local turn and later exact closure counters",async()=>{
  for(const patch of [{purpose:"conversation"},{requestRef:"other"},{turnsAdmitted:1},{reason:"unknown"},{turnStartDispatches:0}]){
    const peer=new WorkerPeer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn")peer.push({kind:"notAdmitted",purpose:peer.purpose,requestRef:f.requestRef,reason:"time",turnsAdmitted:0,...patch});else ordinary(f);};
    const x=await setup(peer);await assert.rejects(x.session.turnAnalysis("a1",body),error=>!(error instanceof StandingWorkerTurnNotAdmitted));await x.session.close().catch(()=>{});
    assert.equal(x.session.state().poisoned,true);
  }
  const peer=new WorkerPeer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn")peer.push({kind:"notAdmitted",purpose:peer.purpose,requestRef:f.requestRef,reason:"time",turnsAdmitted:0});else ordinary(f);};
  const x=await setup(peer);await assert.rejects(x.session.turnAnalysis("a1",body),StandingWorkerTurnNotAdmitted);
  peer.closed("CLOSED",{turnsAdmitted:1});await assert.rejects(x.session.close({peerEnded:true}));
  const called=new WorkerPeer(),normal=called.plan;called.plan=f=>{if(f.kind==="turn"){called.begin(f);called.tool(names[0]!);}else if(f.kind==="toolResult")called.push({kind:"notAdmitted",purpose:called.purpose,requestRef:f.requestRef,reason:"time",turnsAdmitted:0});else normal(f);};
  const y=await setup(called);await assert.rejects(y.session.turnAnalysis("a1",body),error=>!(error instanceof StandingWorkerTurnNotAdmitted));await y.session.close();assert.equal(y.events.length,1);
});
