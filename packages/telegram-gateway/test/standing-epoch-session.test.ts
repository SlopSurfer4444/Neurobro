import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {openStandingEpochSession,EpochTurnNotAdmitted} from "../src/standing-epoch-session.js";
import {EpochWireTimeout} from "../src/standing-epoch-wire.js";
import {createStandingToolDispatcher,StandingToolDispatchError} from "../src/standing-tool-dispatcher.js";
import { BOUND_GROUP_TOOL_SPECS } from "../src/bound-group-tools.js";
import { STANDING_ARTIFACT_TOOL_SPECS } from "../src/standing-artifact-tools.js";
import { BOUND_ACTION_TOOL_SPECS } from "../src/bound-action-tools.js";
import { REPOSITORY_TOOL_SPECS } from "../src/standing-repository-tools.js";
import { HISTORY_TASK_TOOL_SPECS } from "../src/standing-history-task-tools.js";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64");
class Peer {
  queue:unknown[]=[{kind:"ready"}]; sent:any[]=[];waiter:((value:unknown)=>void)|undefined;turns=0;calls=0;pending=false;
  plan:(frame:any)=>void = frame=>{
    if(frame.kind==="turn") {this.turns++;this.pending=true;if(this.turns===2){this.calls++;this.push({kind:"tool",requestRef:frame.requestRef,callRef:"call-2",arguments:{fromDate:1,toDate:200,cursor:null}});}else this.complete(frame.requestRef,this.turns===3);}
    else if(frame.kind==="toolResult")this.complete(frame.requestRef);
    else if(frame.kind==="release"){this.pending=false;this.push({kind:"released",requestRef:frame.requestRef,delivery:frame.delivery});if(frame.delivery==="unknown")this.closed("RELEASE_UNKNOWN");}
    else if(frame.kind==="close")this.closed();
  };
  push(value:unknown){if(this.waiter){const resolve=this.waiter;this.waiter=undefined;resolve(value);}else this.queue.push(value);}
  async send(value:unknown,timeout:number){assert.ok(Number.isInteger(timeout)&&timeout>0);this.sent.push(value);this.plan(value);}
  receive(timeout:number):Promise<unknown>{
    assert.ok(Number.isInteger(timeout)&&timeout>0);if(this.waiter)return Promise.reject(Error("concurrent receive"));
    if(this.queue.length)return Promise.resolve(this.queue.shift());
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiter=undefined;reject(new EpochWireTimeout("read"));},timeout);this.waiter=value=>{clearTimeout(timer);resolve(value);};});
  }
  closed(code="CLOSED") {this.push({kind:"closed",code,facts:{threadStarted:this.turns>0,poisoned:code!=="CLOSED",busy:false,turnsAttempted:this.turns,toolCalls:this.calls,
    schema:"neurobro-native-image-epoch-v1",turnsAdmitted:this.turns,turnLimit:16,epochSeconds:900,turnSeconds:300,running:false,releasePending:false,closed:true,resourceSettlementObserved:false,unreleasedTurn:this.pending}});}
  complete(requestRef:string,image=false,patch={}){
    const scope={requestRef,threadId:"thread-1",turnId:"turn-"+this.turns,turnNumber:this.turns,...patch};this.push({kind:"scope",scope});
    if(image){const ref="img_"+"ab".repeat(24),sha256=createHash("sha256").update(png).digest("hex");
      this.push({kind:"imageBegin",artifact:{schema:"neurobro-generated-image-artifact-v1",ref,origin:{requestRef,threadId:scope.threadId,turnId:scope.turnId,itemId:"image-3"},mimeType:"image/png",byteLength:png.length,sha256,width:1,height:1}});
      this.push({kind:"imageChunk",artifactRef:ref,sequence:0,dataBase64:png.toString("base64")});this.push({kind:"imageEnd",artifactRef:ref,chunkCount:1,byteLength:png.length,sha256});
    }
    this.push({kind:"completed",scope,answer:image?"Картинка":"Ответ",kindOfAnswer:image?"image":"text",toolCalls:this.turns===2?1:0,toolRefusals:0});
  }
}
async function setup(peer=new Peer(),history:((args:unknown)=>Promise<unknown>)=async()=>({success:true,contentItems:[{type:"inputText",text:"{}"}]}),clock?:()=>number){
  const control=new AbortController();let custody=true;
  const session=await openStandingEpochSession({epochId:"a".repeat(32),wire:peer,signal:control.signal,custodyReady:()=>custody,history:{call:history},...(clock?{clock}:{})});
  return {peer,session,control,revoke:()=>{custody=false;}};
}

const toolResult=()=>({success:true,contentItems:[{type:"inputText",text:'{"observed":true}'}]});

test("complete history-control registry accepts exactly24 ordered names before any turn", async () => {
  const extras = [...BOUND_GROUP_TOOL_SPECS, ...STANDING_ARTIFACT_TOOL_SPECS, ...BOUND_ACTION_TOOL_SPECS,
    ...REPOSITORY_TOOL_SPECS, ...HISTORY_TASK_TOOL_SPECS];
  const names = ["neurobro_read_history", ...extras.map(spec => spec.name)];
  assert.equal(names.length, 24);
  const reordered = [...names]; [reordered[22], reordered[23]] = [reordered[23]!, reordered[22]!];
  for (const actual of [names, names.slice(0, 21), reordered]) {
    const peer = new Peer(); peer.queue = [{ kind: "ready", tools: actual }]; let calls = 0;
    const opening = openStandingEpochSession({ epochId: "a".repeat(32), wire: peer,
      signal: new AbortController().signal, custodyReady: () => true,
      history: { call: async () => { calls++; return toolResult(); } },
      extraTools: extras.map(spec => ({ name: spec.name, call: async () => { calls++; return toolResult(); } })) });
    if (actual === names) await (await opening).close();
    else await assert.rejects(opening);
    assert.equal(calls, 0); assert.equal(peer.sent.some(frame => frame.kind === "turn"), false);
  }
});

test("guest atomic refusal needs matching clean closure before safe not-admitted classification",async()=>{
  for(const mode of ["valid","wrong-ref","wrong-count","unreleased","poisoned","wrong-close","tool-first"]){
    const peer=new Peer();
    peer.plan=frame=>{
      if(frame.kind==="turn"){
        if(mode==="tool-first")peer.push({kind:"tool",requestRef:frame.requestRef,callRef:"call-1",arguments:{}});
        peer.push({kind:"notAdmitted",requestRef:mode==="wrong-ref"?"foreign":frame.requestRef,reason:"time",turnsAdmitted:mode==="wrong-count"?1:0});
        peer.closed(mode==="wrong-close"?"CLOSED":"EPOCH_LIMIT");
        const closed=peer.queue.at(-1) as any;
        closed.facts.poisoned=mode==="poisoned";closed.facts.unreleasedTurn=mode==="unreleased";
      }
    };
    const f=await setup(peer);
    await assert.rejects(f.session.turn("selected","question"),error=>mode==="valid"?error instanceof EpochTurnNotAdmitted:!(error instanceof EpochTurnNotAdmitted));
    const closed=await f.session.close();
    assert.equal(f.session.state().poisoned,mode!=="valid");assert.equal(closed.nativeLoopClosed,true);
    assert.equal(peer.sent.filter((value:any)=>value.kind==="turn").length,1);
  }
});
function namedPeer(names=["neurobro_read_history","neurobro_read_archive","neurobro_schedule_message"]){
  const peer=new Peer();peer.queue=[{kind:"ready",tools:names}];
  peer.plan=frame=>{
    if(frame.kind==="turn"){
      peer.turns++;peer.calls++;peer.pending=true;
      peer.push({kind:"tool",requestRef:frame.requestRef,callRef:"named-call-"+peer.turns,name:names[(peer.turns-1)%names.length],arguments:{example:peer.turns}});
    }else if(frame.kind==="toolResult"){
      peer.complete(frame.requestRef);(peer.queue.at(-1) as any).toolCalls=1;
    }else if(frame.kind==="release"){peer.pending=false;peer.push({kind:"released",requestRef:frame.requestRef,delivery:frame.delivery});}
    else if(frame.kind==="close")peer.closed();
  };return peer;
}

test("named session dispatches history archive and schedule distinctly across one thread with exact call scopes",async()=>{
  const peer=namedPeer(),calls:{name:string;request:string;call:string}[]=[],control=new AbortController();
  const session=await openStandingEpochSession({epochId:"a".repeat(32),wire:peer,signal:control.signal,custodyReady:()=>true,
    history:{call:async()=>{calls.push({name:"history",request:"legacy-history",call:"legacy-history"});return toolResult();}},
    extraTools:["neurobro_read_archive","neurobro_schedule_message"].map(name=>({name,call:async(args,scope)=>{
      assert.ok(Object.isFrozen(scope));assert.equal(scope.signal.aborted,false);assert.ok(args);calls.push({name,request:scope.requestRef,call:scope.callRef});return toolResult();
    }}))});
  for(let n=1;n<=3;n++){assert.equal((await session.turn("named-request-"+n,"conversation")).kind,"text");await session.release("named-request-"+n,"not-sent");}
  assert.deepEqual(calls.map(c=>c.name),["history","neurobro_read_archive","neurobro_schedule_message"]);
  assert.equal(calls[2]!.request,"named-request-3");assert.equal(calls[2]!.call,"named-call-3");await session.close();
});

test("named handshake mismatch, unregistered names and missing name never invoke a handler",async()=>{
  for(const mode of ["handshake","unknown","missing"]){
    const peer=namedPeer(["neurobro_read_history","neurobro_read_archive"]);let calls=0;
    if(mode==="handshake")peer.queue=[{kind:"ready",tools:["neurobro_read_history","neurobro_other_chat"]}];
    else{const plan=peer.plan;peer.plan=frame=>{plan(frame);if(frame.kind==="turn"){const tool=peer.queue.at(-1) as any;if(mode==="unknown")tool.name="neurobro_other_chat";else delete tool.name;}};}
    const opening=openStandingEpochSession({epochId:"a".repeat(32),wire:peer,signal:new AbortController().signal,custodyReady:()=>true,
      history:{call:async()=>{calls++;return toolResult();}},extraTools:[{name:"neurobro_read_archive",call:async()=>{calls++;return toolResult();}}]});
    if(mode==="handshake")await assert.rejects(opening);
    else{const session=await opening;await assert.rejects(session.turn("request","conversation"));await session.close();}
    assert.equal(calls,0);
  }
});

test("named dispatcher captures handler and excludes duplicates, accessors and malformed result objects",async()=>{
  let calls=0;const entry={name:"neurobro_read_archive",call:async()=>{calls++;return toolResult();}};
  const dispatcher=createStandingToolDispatcher({call:async()=>toolResult()},[entry]);
  entry.name="neurobro_other_chat";entry.call=async()=>{throw Error("replaced");};
  const scope={requestRef:"request",callRef:"call",signal:new AbortController().signal};
  assert.equal((await dispatcher.call("neurobro_read_archive",{},scope)).success,true);assert.equal(calls,1);
  await assert.rejects(dispatcher.call("neurobro_other_chat",{},scope),StandingToolDispatchError);await dispatcher.close();
  for(const value of [[{name:"neurobro_read_history",call:async()=>toolResult()}],[{name:"other",call:async()=>toolResult()}],
    [Object.defineProperty({call:async()=>toolResult()},"name",{get(){throw Error("getter executed");},enumerable:true})]]){
    assert.throws(()=>createStandingToolDispatcher({call:async()=>toolResult()},value as any),StandingToolDispatchError);
  }
  for(const value of [{success:true,contentItems:[{type:"inputText",text:"[]"}]},{success:true,contentItems:[{type:"inputText",text:"{}"}],extra:true},
    {success:true,contentItems:[{type:"inputText",text:JSON.stringify({body:"x".repeat(65536)})}]}]){
    const d=createStandingToolDispatcher({call:async()=>toolResult()},[{name:"neurobro_bad",call:async()=>value}]);
    await assert.rejects(d.call("neurobro_bad",{},scope),StandingToolDispatchError);await d.close();
  }
});

test("close during named tool revokes its scope and joins actual handler before returning",async()=>{
  const peer=namedPeer(["neurobro_read_history","neurobro_read_archive"]);let entered!:()=>void,finish!:()=>void;
  const started=new Promise<void>(r=>{entered=r;}),pending=new Promise<void>(r=>{finish=r;});let toolSignal:AbortSignal|undefined;
  const session=await openStandingEpochSession({epochId:"a".repeat(32),wire:peer,signal:new AbortController().signal,custodyReady:()=>true,
    history:{call:async()=>toolResult()},extraTools:[{name:"neurobro_read_archive",call:async(_args,scope)=>{toolSignal=scope.signal;entered();await pending;return toolResult();}}]});
  await session.turn("first","conversation");await session.release("first","not-sent");
  const turn=session.turn("second","conversation"),turnFailure=assert.rejects(turn);await started;
  let settled=false;const closing=session.close().then(()=>{settled=true;});await new Promise<void>(r=>setImmediate(r));
  assert.equal(toolSignal!.aborted,true);assert.equal(settled,false);finish();await turnFailure;await closing;
  assert.equal(peer.sent.filter(f=>f.kind==="toolResult"&&f.requestRef==="second").length,0);
});
test("text history image text retain one thread and require exact delivery release",async()=>{
  let reads=0;const f=await setup(new Peer(),async args=>{reads++;assert.deepEqual(args,{fromDate:1,toDate:200,cursor:null});return{success:true,contentItems:[{type:"inputText",text:"{}"}]};});
  for(let index=1;index<=4;index++){
    const value=await f.session.turn("request-"+index,"conversation");assert.equal(value.kind,index===3?"image":"text");
    await assert.rejects(f.session.turn("blocked","other"));
    await assert.rejects(f.session.release("foreign","verified"));
    if(value.kind==="image")assert.deepEqual(value.image.registry.copyBytes(value.image.artifact.ref),png);
    await f.session.release("request-"+index,"verified");
    if(value.kind==="image")assert.throws(()=>value.image.registry.get(value.image.artifact.ref));
  }
  assert.equal(reads,1);assert.equal(f.session.state().turns,4);
  const [a,b]=await Promise.all([f.session.close(),f.session.close()]);assert.deepEqual(a,b);assert.equal(a.resourceSettlementObserved,false);
  assert.equal(f.peer.sent.filter(value=>value.kind==="close").length,1);
});
test("foreign scope or repeated callback poisons without returning content",async()=>{
  for(const wrong of ["scope","callback"]){
    const peer=new Peer();peer.plan=frame=>{if(frame.kind==="close")peer.closed();else if(frame.kind==="turn"){
      peer.turns++;
      if(wrong==="scope")peer.complete(frame.requestRef,false,{requestRef:"foreign"});
      else {const tool={kind:"tool",requestRef:frame.requestRef,callRef:"same",arguments:{}};peer.push(tool);peer.push(tool);}
    }};
    const f=await setup(peer);await assert.rejects(f.session.turn("one","request"));assert.equal(f.session.state().poisoned,true);await f.session.close();
  }
});
test("named method receiver preserves its registered route after caller mutation",async()=>{
  const entry={name:"neurobro_read_archive",async call(){return {success:true,contentItems:[{type:"inputText",text:JSON.stringify({route:this.name})}]};}};
  const dispatcher=createStandingToolDispatcher({call:async()=>({})},[entry]);
  entry.name="neurobro_schedule_text";
  const value=await dispatcher.call("neurobro_read_archive",{}, {requestRef:"one",callRef:"call-one",signal:new AbortController().signal});
  assert.deepEqual(JSON.parse(value.contentItems[0].text),{route:"neurobro_read_archive"});await dispatcher.close();
});

test("STOP during actual pending history waits for that handler and publishes no tool result",async()=>{
  let release!:()=>void,entered!:()=>void;const started=new Promise<void>(done=>{entered=done;}),pending=new Promise<void>(done=>{release=done;});
  const peer=new Peer();peer.turns=1; // first admitted host turn still must have turnNumber1; only tool is observed before STOP.
  const f=await setup(peer,async()=>{entered();await pending;return{success:true,contentItems:[{type:"inputText",text:"{}"}]};});
  const turn=f.session.turn("one","request");let settled=false;void turn.catch(()=>{}).finally(()=>{settled=true;});await started;
  f.control.abort();const closing=f.session.close();await new Promise(done=>setImmediate(done));assert.equal(settled,false);
  release();await assert.rejects(turn);const result=await closing;assert.equal(result.nativeLoopClosed,true);
  assert.equal(peer.sent.filter(value=>value.kind==="toolResult").length,0);
});
test("close after exposing image leaves upload-owned bytes for caller settlement",async()=>{
  const peer=new Peer();peer.plan=frame=>{if(frame.kind==="turn"){peer.turns++;peer.pending=true;peer.complete(frame.requestRef,true);}else if(frame.kind==="close")peer.closed();};
  const f=await setup(peer),value=await f.session.turn("image","draw");assert.equal(value.kind,"image");
  await f.session.close();if(value.kind!=="image")throw Error("image expected");
  assert.deepEqual(value.image.registry.copyBytes(value.image.artifact.ref),png);value.image.close();assert.throws(()=>value.image.registry.get(value.image.artifact.ref));
});

test("observed peer EOF consumes queued native closure without writing to the ended peer",async()=>{
  const f=await setup();f.peer.closed("EPOCH_LIMIT");
  f.peer.send=async()=>{throw Error("write to ended peer");};
  const closed=await f.session.close({peerEnded:true});
  assert.equal(closed.code,"EPOCH_LIMIT");assert.equal(closed.nativeLoopClosed,true);
  assert.equal(f.peer.sent.filter(value=>value.kind==="close").length,0);
});

test("peer expiry during image delivery retains the caller's bytes and truthful unreleased status",async()=>{
  const peer=new Peer();peer.plan=frame=>{if(frame.kind==="turn"){peer.turns++;peer.pending=true;peer.complete(frame.requestRef,true);}};
  const f=await setup(peer),value=await f.session.turn("draw","draw");assert.equal(value.kind,"image");
  peer.closed("EPOCH_LIMIT");peer.send=async()=>{throw Error("ended");};
  const closed=await f.session.close({peerEnded:true});assert.equal(closed.unreleasedTurn,true);
  if(value.kind!=="image")throw Error("expected image");
  assert.deepEqual(value.image.registry.copyBytes(value.image.artifact.ref),png);value.image.close();
});

test("peer-ended closure joins actual pending history without sending a late tool result",async()=>{
  let release!:()=>void,entered!:()=>void;
  const pending=new Promise<void>(done=>{release=done;}),started=new Promise<void>(done=>{entered=done;});
  const peer=new Peer();peer.turns=1;
  const f=await setup(peer,async()=>{entered();await pending;return{};});
  const turn=f.session.turn("one","question");void turn.catch(()=>{});await started;
  peer.closed("EPOCH_LIMIT");peer.send=async()=>{throw Error("ended");};
  let joined=false;const closing=f.session.close({peerEnded:true}).then(value=>{joined=true;return value;});
  await new Promise(done=>setImmediate(done));assert.equal(joined,false);
  release();await assert.rejects(turn);assert.equal((await closing).nativeLoopClosed,true);
  assert.equal(peer.sent.filter(value=>value.kind==="toolResult"||value.kind==="close").length,0);
});
test("unknown delivery waits for release acknowledgement then closes instead of replay",async()=>{
  const f=await setup();await f.session.turn("one","question");await f.session.release("one","unknown");
  assert.equal(f.session.state().phase,"closed");assert.equal(f.session.state().poisoned,true);
  await assert.rejects(f.session.turn("two","again"));assert.equal((await f.session.close()).code,"RELEASE_UNKNOWN");
});
test("expired work budget still permits native-loop close without process-settlement claims",async()=>{
  let now=0;const f=await setup(new Peer(),undefined,()=>now);now=900001;
  await assert.rejects(f.session.turn("one","question"));const result=await f.session.close();assert.equal(result.resourceSettlementObserved,false);
  assert.equal(f.peer.sent.filter(value=>value.kind==="turn").length,0);
});
test("custody loss prevents a new turn without interpreting readiness as custody",async()=>{
  const f=await setup();f.revoke();await assert.rejects(f.session.turn("one","request"));assert.equal(f.peer.sent.length,0);await f.session.close();
  await assert.rejects(openStandingEpochSession({epochId:"a".repeat(32),wire:new Peer(),signal:new AbortController().signal,custodyReady:()=>false,history:{call:async()=>({})}}));
});
test("closed native poison and unreleased work cannot disappear from host state",async()=>{
  const peer=new Peer();peer.plan=frame=>{if(frame.kind==="close"){
    peer.closed();const message=peer.queue.at(-1) as any;message.facts.poisoned=true;
  }};
  const f=await setup(peer);await f.session.close();assert.equal(f.session.state().poisoned,true);
});
test("cleanup uses one deadline including close write and active-loop waiting",async()=>{
  let now=0;const peer=new Peer();const send=peer.send.bind(peer);
  peer.send=async(frame:any,timeout:number)=>{await send(frame,timeout);if(frame.kind==="close")now=35001;};
  const f=await setup(peer,undefined,()=>now);await assert.rejects(f.session.close(),/DEADLINE/);assert.equal(f.session.state().poisoned,true);
});

test("closing drain accepts exactly 64 crossed frames but refuses the 65th or an unknown kind",async()=>{
  for(const variant of [64,65,"invalid"] as const){
    const peer=new Peer();peer.plan=frame=>{if(frame.kind==="close"){
      for(let n=0;n<(typeof variant==="number"?variant:1);n++)peer.push({kind:variant==="invalid"?"unrecognized":"scope"});
      peer.closed();
    }};
    const f=await setup(peer);
    if(variant===64)assert.equal((await f.session.close()).nativeLoopClosed,true);
    else await assert.rejects(f.session.close(),/PROTOCOL/);
    assert.equal(f.session.state().poisoned,true);
  }
});

test("closed native call ledger includes bounded local refusals, separately from 128 host callbacks",async()=>{
  for(const count of [192,193,194]){
    const peer=new Peer();peer.plan=frame=>{if(frame.kind==="close"){
      peer.closed();const message=peer.queue.at(-1) as any;message.facts.toolCalls=count;
    }};
    const f=await setup(peer);
    if(count<=193)assert.equal((await f.session.close()).nativeLoopClosed,true);
    else await assert.rejects(f.session.close(),/PROTOCOL/);
  }
});

test("rotation distinguishes a never-dispatched selected question from an uncertain written turn",async()=>{
  let now=0;const f=await setup(new Peer(),undefined,()=>now);assert.equal(f.session.admission(),"ready");
  now=596000;assert.equal(f.session.admission(),"rotate");
  now=600001;await assert.rejects(f.session.turn("selected","question"),error=>error instanceof EpochTurnNotAdmitted&&error.reason==="time");
  assert.equal(f.session.state().turns,0);assert.equal(f.peer.sent.length,0);await f.session.close();
  // A successor may retain that selected question only after its managed owner
  // separately settles the old processes. This fixture has no process owner.
  const successor=await setup();await successor.session.turn("selected","question");
  assert.equal(successor.session.admission(),"unavailable");await successor.session.release("selected","verified");await successor.session.close();
  const peer=new Peer(),original=peer.send.bind(peer);peer.send=async(value:any,timeout)=>{
    if(value.kind==="turn"){peer.sent.push(value);throw Error("uncertain write");}await original(value,timeout);
  };
  const failed=await setup(peer);await assert.rejects(failed.session.turn("selected","question"),error=>!(error instanceof EpochTurnNotAdmitted));
  assert.equal(failed.session.state().turns,1);assert.equal(failed.session.admission(),"unavailable");await failed.session.close();
});

test("incoming photo pixels use same admitted turn and do not leak into next turn",async()=>{
 const {peer,session}=await setup();
 await session.turn("photo","Describe",[{mimeType:"image/png",bytes:png}]);
 assert.deepEqual(peer.sent.find(x=>x.kind==="turn").images,[{mimeType:"image/png",base64:png.toString("base64")}]);
 await session.release("photo","not-sent");await session.turn("ordinary","Next");
 assert.equal(peer.sent.filter(x=>x.kind==="turn")[1].images,undefined);
 await session.release("ordinary","not-sent");await session.close();
});
