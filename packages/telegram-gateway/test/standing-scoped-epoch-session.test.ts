import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { openStandingScopedEpochSession, type StandingEpochPurpose, type StandingToolResultSent } from "../src/standing-scoped-epoch-session.js";
import { EpochTurnNotAdmitted } from "../src/standing-epoch-session.js";
import { createEpochWire, EpochWireTimeout } from "../src/standing-epoch-wire.js";
const names=["neurobro_analysis_material","neurobro_analysis_notes","neurobro_analysis_commit"];
const purposes=["conversation","history-analysis"] as const;
const body=JSON.stringify({schema:"neurobro-history-analysis-input-v1",kind:"leaf",objective:"Read the supplied material",materialAvailable:true});
const result=()=>({success:true,contentItems:[{type:"inputText",text:'{"available":true}'}]});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise<void>(r=>setImmediate(r));
class Peer {
  queue:unknown[]=[{kind:"ready",protocol:"standing-scoped-epoch-v1",scopes:[{purpose:"conversation",tools:["neurobro_read_history"]},{purpose:"history-analysis",tools:names}]}];
  sent:any[]=[];waiter:((value:unknown)=>void)|undefined;reads=0;turns=0;pending=false;calls=0;
  local={conversation:0,"history-analysis":0};toolCounts={conversation:0,"history-analysis":0};current:any;
  plan:(frame:any)=>void=frame=>{
    if(frame.kind==="turn"){this.begin(frame);this.complete();}
    else if(frame.kind==="release"){this.pending=false;this.push({kind:"released",purpose:frame.purpose,requestRef:frame.requestRef,delivery:frame.delivery});if(frame.delivery==="unknown")this.closed("RELEASE_UNKNOWN");}
    else if(frame.kind==="close")this.closed();
  };
  begin(frame:any){this.turns++;this.local[frame.purpose as StandingEpochPurpose]++;this.pending=true;this.current=frame;this.calls=0;}
  scope(){const p=this.current.purpose as StandingEpochPurpose;return {purpose:p,requestRef:this.current.requestRef,threadId:p==="conversation"?"thread-c":"thread-a",turnId:"turn-"+this.turns,turnNumber:this.turns,threadTurnNumber:this.local[p]};}
  tool(name:string,patch={}){this.calls++;this.toolCounts[this.current.purpose as StandingEpochPurpose]++;this.push({kind:"tool",purpose:this.current.purpose,requestRef:this.current.requestRef,callRef:"call-"+this.calls,name,arguments:{},...patch});}
  complete(patch={},image=false){const scope={...this.scope(),...patch};this.push({kind:"scope",scope});if(image)this.images(scope);
    this.push({kind:"completed",scope,answer:"Internal completion",kindOfAnswer:image?"image":"text",toolCalls:this.calls,toolRefusals:0});}
  images(scope:any){const ref="img_"+"ab".repeat(24),sha256=createHash("sha256").update(png).digest("hex");
    this.push({kind:"imageBegin",artifact:{schema:"neurobro-generated-image-artifact-v1",ref,origin:{requestRef:scope.requestRef,threadId:scope.threadId,turnId:scope.turnId,itemId:"image"},mimeType:"image/png",byteLength:png.length,sha256,width:1,height:1}});
    this.push({kind:"imageChunk",artifactRef:ref,sequence:0,dataBase64:png.toString("base64")});this.push({kind:"imageEnd",artifactRef:ref,chunkCount:1,byteLength:png.length,sha256});}
  facts(){return {schema:"neurobro-native-scoped-epoch-v1",threadLimit:2,threadStarted:this.turns>0,threadStartDispatches:purposes.filter(p=>this.local[p]>0).length,turnStartDispatches:this.turns,
    poisoned:false,busy:false,turnsAttempted:this.turns,toolCalls:this.toolCounts.conversation+this.toolCounts["history-analysis"],turnsAdmitted:this.turns,turnLimit:16,epochSeconds:900,turnSeconds:300,
    running:false,releasePending:false,closed:true,resourceSettlementObserved:false,unreleasedTurn:this.pending,
    slots:purposes.map(p=>({purpose:p,threadStarted:this.local[p]>0,turnsAdmitted:this.local[p],turnsAttempted:this.local[p],toolCalls:this.toolCounts[p],closed:true,poisoned:false}))};}
  closed(code="CLOSED"){this.push({kind:"closed",code,facts:this.facts()});}
  push(value:unknown){if(this.waiter){const done=this.waiter;this.waiter=undefined;done(value);}else this.queue.push(value);}
  async send(value:unknown,timeout:number){assert.ok(Number.isInteger(timeout)&&timeout>0);this.sent.push(value);this.plan(value);}
  receive(timeout:number):Promise<unknown>{this.reads++;assert.ok(!this.waiter,"one reader only");if(this.queue.length)return Promise.resolve(this.queue.shift());
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiter=undefined;reject(new EpochWireTimeout("read"));},timeout);this.waiter=value=>{clearTimeout(timer);resolve(value);};});}
}
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64");
async function setup(peer=new Peer(),options:{call?:(name:string,args:unknown,signal:AbortSignal)=>Promise<unknown>;shown?:(event:StandingToolResultSent)=>Promise<void>|void;clock?:()=>number}={}){
  const control=new AbortController(),events:StandingToolResultSent[]=[];let custody=true;
  const session=await openStandingScopedEpochSession({epochId:"a".repeat(32),wire:peer,signal:control.signal,custodyReady:()=>custody,
    conversation:{history:{call:async args=>options.call?.("neurobro_read_history",args,control.signal)??result()}},
    analysisTools:names.map(name=>({name,call:async(args,scope)=>options.call?.(name,args,scope.signal)??result()})),
    onToolResultSent:async event=>{events.push(event);await options.shown?.(event);},...(options.clock?{clock:options.clock}:{})});
  return {peer,session,events,control,revoke:()=>{custody=false;}};
}
test("conversation analysis conversation keep two purpose-bound threads and separate result authority",async()=>{
  const peer=new Peer();const ordinary=peer.plan;peer.plan=f=>{
    if(f.kind==="turn"&&f.purpose==="history-analysis"){peer.begin(f);peer.tool(names[0]!);}
    else if(f.kind==="toolResult"){if(peer.calls<3)peer.tool(names[peer.calls]!);else peer.complete();}else ordinary(f);
  };
  const f=await setup(peer);assert.equal((await f.session.turnConversation("c1","conversation")).kind,"text");await f.session.releaseConversation("c1","verified");
  const value=await f.session.turnAnalysis("a1",body);assert.equal(value.kind,"analysis");assert.deepEqual(value.scope,{epochId:"a".repeat(32),purpose:"history-analysis",requestRef:"a1",threadId:"thread-a",turnId:"turn-2",turnNumber:2,threadTurnNumber:1});
  assert.equal("receipt"in value,false);assert.equal("image"in value,false);assert.equal(value.toolCalls,3);
  await assert.rejects(f.session.releaseConversation("a1","verified"));await f.session.releaseAnalysis("a1");
  assert.equal((await f.session.turnConversation("c2","conversation")).kind,"text");await f.session.releaseConversation("c2","not-sent");
  assert.deepEqual(f.events.map(e=>e.name),names);assert.ok(f.events.every(e=>e.purpose==="history-analysis"&&Object.isFrozen(e)&&Object.isFrozen(e.result)));
  assert.deepEqual(f.session.state(),{phase:"idle",poisoned:false,turns:3,conversationTurns:2,analysisTurns:1});
  assert.deepEqual(peer.sent.filter(v=>v.kind==="release").map(v=>v.delivery),["verified","not-sent","not-sent"]);
  assert.equal((await f.session.close()).resourceSettlementObserved,false);
});
test("exact scoped ready rejects legacy, swapped scopes and omitted analysis registration before a turn",async()=>{
  for(const ready of [{kind:"ready"},{kind:"ready",tools:["neurobro_read_history"]},
    {kind:"ready",protocol:"standing-scoped-epoch-v1",scopes:[{purpose:"history-analysis",tools:names},{purpose:"conversation",tools:["neurobro_read_history"]}]},
    {kind:"ready",protocol:"standing-scoped-epoch-v1",scopes:[{purpose:"conversation",tools:["neurobro_read_history"]},{purpose:"history-analysis",tools:names.slice(0,2)}]}]){
    const peer=new Peer();peer.queue=[ready];await assert.rejects(setup(peer));assert.equal(peer.sent.filter(v=>v.kind==="turn").length,0);
  }
});
test("wrong-purpose callbacks and analysis raw history fail without any handler or shown hook",async()=>{
  for(const patch of [{purpose:"conversation"},{requestRef:"foreign"},{name:"neurobro_read_history"},{callRef:"bad\n"}]){
    const peer=new Peer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.tool(names[0]!,patch);}else ordinary(f);};
    let calls=0;const f=await setup(peer,{call:async()=>{calls++;return result();}});await assert.rejects(f.session.turnAnalysis("a1",body));await f.session.close();assert.equal(calls,0);assert.equal(f.events.length,0);
  }
});
test("global and local scope counters, distinct threads and purpose cannot be forged",async()=>{
  for(const patch of [{turnNumber:1},{threadTurnNumber:2},{threadId:"thread-c"},{purpose:"conversation"},{requestRef:"c1"}]){
    const peer=new Peer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn"&&f.purpose==="history-analysis"){peer.begin(f);peer.complete(patch);}else ordinary(f);};
    const f=await setup(peer);await f.session.turnConversation("c1","question");await f.session.releaseConversation("c1","not-sent");
    await assert.rejects(f.session.turnAnalysis("a1",body));await f.session.close();assert.equal(f.session.state().poisoned,true);
  }
});
test("analysis has no image path while conversation image retains registry ownership through close",async()=>{
  for(const purpose of purposes){const peer=new Peer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.complete({},true);}else ordinary(f);};
    const f=await setup(peer);if(purpose==="history-analysis"){await assert.rejects(f.session.turnAnalysis("a1",body));await f.session.close();}
    else{const value=await f.session.turnConversation("c1","draw");assert.equal(value.kind,"image");await f.session.close();
      if(value.kind!=="image")throw Error();assert.deepEqual(value.image.registry.copyBytes(value.image.artifact.ref),png);value.image.close();assert.throws(()=>value.image.registry.get(value.image.artifact.ref));}
  }
});
test("actual EpochWire write callback settles before shown hook and next receive",async()=>{
  const peer=new Peer(),ordinary=peer.plan,readable=new PassThrough(),writeEntered=deferred(),writeDone=deferred(),hookEntered=deferred(),hookDone=deferred();
  peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.tool(names[0]!);}else if(f.kind==="toolResult")peer.complete();else ordinary(f);};
  const frames=peer.queue.splice(0);peer.push=value=>{readable.write(JSON.stringify(value)+"\n");};
  const writable=new Writable({write(chunk,_encoding,done){const frame=JSON.parse(chunk.toString());peer.sent.push(frame);peer.plan(frame);
    if(frame.kind==="toolResult"){writeEntered.resolve();void writeDone.promise.then(()=>done());}else done();}});
  const wire=createEpochWire({readable,writable});frames.forEach(v=>peer.push(v));let receives=0,shown=0;
  const session=await openStandingScopedEpochSession({epochId:"a".repeat(32),wire:{send:wire.send,receive:async bound=>{receives++;return wire.receive(bound);}},signal:new AbortController().signal,custodyReady:()=>true,
    conversation:{history:{call:async()=>result()}},analysisTools:names.map(name=>({name,call:async()=>result()})),onToolResultSent:async()=>{shown++;hookEntered.resolve();await hookDone.promise;}});
  const turning=session.turnAnalysis("a1",body);await writeEntered.promise;const reads=receives;assert.equal(shown,0);await tick();assert.equal(receives,reads);
  writeDone.resolve();await hookEntered.promise;assert.equal(shown,1);await tick();assert.equal(receives,reads);hookDone.resolve();assert.equal((await turning).kind,"analysis");
  await session.releaseAnalysis("a1");await session.close();wire.close();readable.destroy();writable.destroy();
});
test("failed wire result write never marks shown; failed shown hook consumes turn without replay",async()=>{
  for(const mode of ["write","hook"]){const peer=new Peer(),ordinary=peer.plan;
    peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.tool(names[0]!);}else if(f.kind!=="toolResult")ordinary(f);};
    if(mode==="write"){const send=peer.send.bind(peer);peer.send=async(v:any,b)=>{if(v.kind==="toolResult"){peer.sent.push(v);throw Error("uncertain write");}await send(v,b);};}
    const f=await setup(peer,{shown:()=>{throw Error("store rejected exposure");}});await assert.rejects(f.session.turnAnalysis("a1",body));await f.session.close();
    assert.equal(f.events.length,mode==="write"?0:1);assert.equal(peer.sent.filter(v=>v.kind==="toolResult").length,1);assert.equal(peer.sent.filter(v=>v.kind==="turn").length,1);await assert.rejects(f.session.turnAnalysis("a1",body));
  }
});
test("close revokes and joins actual analysis callback; no late result is sent",async()=>{
  const peer=new Peer(),ordinary=peer.plan,entered=deferred(),done=deferred();let signal:AbortSignal|undefined;
  peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.tool(names[0]!);}else ordinary(f);};
  const f=await setup(peer,{call:async(_name,_args,s)=>{signal=s;entered.resolve();await done.promise;return result();}});
  const turn=f.session.turnAnalysis("a1",body),failed=assert.rejects(turn);await entered.promise;let closed=false;const closing=f.session.close().then(()=>{closed=true;});
  await tick();assert.equal(signal!.aborted,true);assert.equal(closed,false);done.resolve();await failed;await closing;
  assert.equal(peer.sent.filter(v=>v.kind==="toolResult").length,0);assert.equal(f.events.length,0);assert.equal(peer.sent.filter(v=>v.kind==="close").length,1);
});
test("close joins an already sent result hook and suppresses late analysis completion",async()=>{
  const peer=new Peer(),ordinary=peer.plan,entered=deferred(),done=deferred();
  peer.plan=f=>{if(f.kind==="turn"){peer.begin(f);peer.tool(names[0]!);}else if(f.kind==="toolResult")peer.complete();else ordinary(f);};
  const f=await setup(peer,{shown:async()=>{entered.resolve();await done.promise;}});const failure=assert.rejects(f.session.turnAnalysis("a1",body));await entered.promise;
  let settled=false;const closing=f.session.close().then(()=>{settled=true;});await tick();assert.equal(settled,false);assert.equal(f.events.length,1);done.resolve();await failure;await closing;
});
test("safe scoped nonadmission requires unchanged both dispatch counters, slots and callback counts",async()=>{
  for(const mode of ["valid","new-thread","new-turn","slot-count","callback-count","purpose","poison"]){
    const peer=new Peer(),ordinary=peer.plan;const f=await setup(peer);
    await f.session.turnConversation("c1","question");await f.session.releaseConversation("c1","not-sent");
    peer.plan=value=>{if(value.kind==="turn"){
      peer.push({kind:"notAdmitted",purpose:mode==="purpose"?"conversation":"history-analysis",requestRef:value.requestRef,reason:"time",turnsAdmitted:1,turnStartDispatches:mode==="new-turn"?2:1});
      const facts=peer.facts();if(mode==="new-thread")facts.threadStartDispatches=2;if(mode==="slot-count")facts.slots[0]!.turnsAdmitted=2;
      if(mode==="callback-count"){facts.toolCalls++;facts.slots[0]!.toolCalls++;}if(mode==="poison"){facts.poisoned=true;facts.slots[0]!.poisoned=true;}
      peer.push({kind:"closed",code:"EPOCH_LIMIT",facts});
    }else ordinary(value);};
    await assert.rejects(f.session.turnAnalysis("a1",body),e=>mode==="valid"?e instanceof EpochTurnNotAdmitted:!(e instanceof EpochTurnNotAdmitted));
    await f.session.close().catch(()=>{});assert.equal(f.session.state().poisoned,mode!=="valid");assert.equal(peer.sent.filter(v=>v.kind==="turn").length,2);
  }
});
test("UNKNOWN before thread acknowledgement remains consumed and is never safe nonadmission",async()=>{
  const peer=new Peer(),ordinary=peer.plan;peer.plan=f=>{if(f.kind==="turn"){
    const facts=peer.facts();facts.threadStartDispatches=1;facts.turnsAdmitted=1;facts.unreleasedTurn=true;
    peer.push({kind:"closed",code:"NATIVE_UNKNOWN",facts});
  }else ordinary(f);};
  const f=await setup(peer);await assert.rejects(f.session.turnAnalysis("a1",body),e=>!(e instanceof EpochTurnNotAdmitted));
  const closed=await f.session.close();assert.equal(closed.code,"NATIVE_UNKNOWN");assert.equal(closed.unreleasedTurn,true);assert.equal(f.session.admission(),"unavailable");
});
test("initial analysis packet rejects duplicates, foreign schema, invalid objective and selectors before dispatch",async()=>{
  const f=await setup();for(const bad of ["{}",body.replace('"leaf"','"other"'),body.replace('true','false'),body.replace('"leaf"','"leaf","kind":"leaf"'),
    JSON.stringify({schema:"neurobro-history-analysis-input-v1",kind:"leaf",objective:"🦊".repeat(1025),materialAvailable:true}),
    JSON.stringify({schema:"neurobro-history-analysis-input-v1",kind:"merge",objective:"\uFEFF",materialAvailable:true}),
    body.slice(0,-1)+',"chatId":"other"}',body.replace("Read the supplied material","\\ud800")])await assert.rejects(f.session.turnAnalysis("a1",bad));
  for(const ref of ["x\n","_leading","x".repeat(129),"русский"])await assert.rejects(f.session.turnAnalysis(ref,body));
  assert.equal(f.peer.sent.length,0);assert.equal((await f.session.turnAnalysis("valid",body)).kind,"analysis");await f.session.releaseAnalysis("valid");await f.session.close();
});
test("proxy and getter wire records are refused without evaluating traps",async()=>{
  let traps=0;for(const value of [new Proxy({}, {getPrototypeOf(){traps++;throw Error();},ownKeys(){traps++;throw Error();}}),
    Object.defineProperty({},"kind",{get(){traps++;throw Error();},enumerable:true})]){
    const peer=new Peer();peer.queue=[value];await assert.rejects(setup(peer));
  }assert.equal(traps,0);
});
test("aggregate sixteen-turn budget spans both purposes and local time refusal never writes",async()=>{
  let now=0;const f=await setup(new Peer(),{clock:()=>now});
  for(let i=0;i<16;i++){if(i%2===0){await f.session.turnConversation("r"+i,"question");await f.session.releaseConversation("r"+i,"not-sent");}
    else{await f.session.turnAnalysis("r"+i,body);await f.session.releaseAnalysis("r"+i);}}
  assert.equal(f.session.admission(),"rotate");await assert.rejects(f.session.turnAnalysis("r16",body),EpochTurnNotAdmitted);assert.equal(f.peer.sent.filter(v=>v.kind==="turn").length,16);await f.session.close();
  const g=await setup(new Peer(),{clock:()=>now});now=600001;assert.equal(g.session.admission(),"rotate");await assert.rejects(g.session.turnAnalysis("late",body),EpochTurnNotAdmitted);assert.equal(g.peer.sent.length,0);await g.session.close();
});
test("global abort closes both registries and custody loss cannot admit another purpose",async()=>{
  const f=await setup();await f.session.turnAnalysis("a1",body);await f.session.releaseAnalysis("a1");f.control.abort();await f.session.close();
  await assert.rejects(f.session.turnConversation("c1","question"));assert.equal(f.peer.sent.filter(v=>v.kind==="close").length,1);
  const g=await setup();g.revoke();await assert.rejects(g.session.turnAnalysis("a1",body));await g.session.close();assert.equal(g.peer.sent.filter(v=>v.kind==="turn").length,0);
});

test("scoped conversation sends pixels but analysis has no visual input",async()=>{
 const {peer,session}=await setup();
 await session.turnConversation("photo","Describe",[{mimeType:"image/png",bytes:png}]);
 assert.deepEqual(peer.sent.find(x=>x.kind==="turn").images,[{mimeType:"image/png",base64:png.toString("base64")}]);
 await session.releaseConversation("photo","not-sent");await session.turnAnalysis("analysis",body);
 assert.equal(peer.sent.filter(x=>x.kind==="turn")[1].images,undefined);
 await session.releaseAnalysis("analysis");await session.close();
});

test("invalid visual input cannot consume scoped admission or strand session",async()=>{
 const {peer,session}=await setup();const before=session.state();
 let trapped=false;
 const accessor=Object.defineProperty({mimeType:"image/png"},"bytes",{get(){trapped=true;return png;}});
 for(const invalid of [[],new Array(1),[accessor],[{mimeType:"image/png",bytes:Buffer.alloc(8*1024*1024+1)}]]){
   await assert.rejects(session.turnConversation("photo","Describe",invalid as any));
 }
 for(const key of ["length","subarray","toString"]){
   const bytes=Buffer.from(png);Object.defineProperty(bytes,key,{get(){trapped=true;throw new Error("callback");}});
   await assert.rejects(session.turnConversation("photo","Describe",[{mimeType:"image/png",bytes}]));
 }
 assert.equal(trapped,false);
 assert.deepEqual(session.state(),before);assert.equal(peer.sent.length,0);
 await session.turnConversation("photo","Describe",[{mimeType:"image/png",bytes:png}]);
 await session.releaseConversation("photo","not-sent");await session.close();
});
