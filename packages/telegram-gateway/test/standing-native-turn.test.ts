import test from "node:test";
import assert from "node:assert/strict";
import { createNativeTurnAdmission, type NativeTurnScope, type StandingNativeTurnReceipt } from "../src/standing-native-turn.js";
import { completedStandingResult, closeStandingImage } from "../src/standing-model-result.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";

const scope: NativeTurnScope = {epochId:"a".repeat(32),requestRef:"request-1",threadId:"thread-1",turnId:"turn-1",turnNumber:1};
const receipt = (answer: string | null, kind: "text" | "image" = "text"): StandingNativeTurnReceipt => ({
  ...scope,version:"standing-native-turn-v1",outcome:"observed",kind,custodyReady:true,
  turnCompleted:true,toolsSettled:true,transportHealthy:true,answerBytes:Buffer.byteLength(answer ?? ""),
});
function gate(expected = scope) {
  const control = new AbortController(); let alive = true;
  return {control, dead:()=>{alive=false;}, admission:createNativeTurnAdmission({scope:expected,signal:control.signal,isEpochActive:()=>alive})};
}
function picture(answer: string | null = "Подпись", originPatch = {}) {
  const origin={requestRef:scope.requestRef,threadId:scope.threadId,turnId:scope.turnId,itemId:"image-1",...originPatch};
  const registry=createGeneratedImageRegistry({requestRef:origin.requestRef,threadId:origin.threadId,turnId:origin.turnId});
  const artifact=registry.acceptCompleted(origin,{id:origin.itemId,type:"imageGeneration",status:"completed",
    result:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="});
  return {answer,receipt:receipt(answer,"image"),image:{artifact,registry:{get:registry.get,copyBytes:registry.copyBytes},close:registry.close}};
}

test("a warm completed turn authorizes content once without claiming any process exited",()=>{
  const result={answer:"Привет",receipt:receipt("Привет")}; const g=gate();
  assert.deepEqual(g.admission.accept(result),{kind:"text",answer:"Привет"});
  assert.throws(()=>g.admission.accept(result),/STANDING_NATIVE_TURN_REFUSED/);
  assert.throws(()=>completedStandingResult(result),/STANDING_MODEL_RESULT_REFUSED/);
  assert.ok(!Object.keys(result.receipt).some(key=>key.endsWith("Settled")&&key!=="toolsSettled"));
});

test("receipt matches the owner-held epoch, selected request and exact native turn",()=>{
  for(const patch of [{epochId:"b".repeat(32)},{requestRef:"request-2"},{threadId:"thread-2"},{turnId:"turn-2"},{turnNumber:2}]){
    const g=gate(),result={answer:"ok",receipt:{...receipt("ok"),...patch}};
    assert.throws(()=>g.admission.accept(result));
    assert.throws(()=>g.admission.accept({answer:"ok",receipt:receipt("ok")}));
  }
  const mutable={...scope}; const g=gate(mutable);mutable.turnId="changed";
  assert.equal(g.admission.accept({answer:"ok",receipt:receipt("ok")}).kind,"text");
});

test("unknown, unhealthy, incomplete tools, forged cleanup and extra fields never yield content",()=>{
  const patches=[{outcome:"unknown"},{transportHealthy:false},{custodyReady:false},{turnCompleted:false},{toolsSettled:false},
    {guestSettled:true},{appServerSettled:true},{exitCode:0},{answerBytes:999},{version:"standing-native-host-v1"},{kind:"none"}];
  for(const patch of patches)assert.throws(()=>gate().admission.accept({answer:"ok",receipt:{...receipt("ok"),...patch}}));
  assert.throws(()=>gate().admission.accept({answer:"ok",receipt:receipt("ok"),extra:true}));
  assert.throws(()=>gate().admission.accept({answer:null,receipt:{...receipt(null),outcome:"unknown",kind:"none"}}));
});

test("aborted, dead or explicitly revoked epochs consume the pending admission",()=>{
  for(const method of ["abort","dead","revoke"]){
    const g=gate();if(method==="abort")g.control.abort();else if(method==="dead")g.dead();else g.admission.revoke();
    assert.throws(()=>g.admission.accept({answer:"ok",receipt:receipt("ok")}));
  }
});

test("real image registry is accepted only for the same request/thread/turn",()=>{
  for(const patch of [{},{requestRef:"other-request"},{threadId:"other-thread"},{turnId:"other-turn"}]){
    const value=picture("Подпись",patch);
    try {
      if(Object.keys(patch).length)assert.throws(()=>gate().admission.accept(value));
      else {const answer=gate().admission.accept(value);assert.equal(answer.kind,"image");assert.equal(answer.answer,"Подпись");}
      // Acceptance/refusal does not wipe a potentially in-flight upload buffer.
      assert.ok(value.image.registry.copyBytes(value.image.artifact.ref).length>0);
    } finally {closeStandingImage(value);}
    assert.throws(()=>value.image.registry.get(value.image.artifact.ref));
  }
});

test("caption projection preserves Unicode while receipt authenticates full answer bytes",()=>{
  const value=picture("🦈".repeat(300));
  try {assert.equal(gate().admission.accept(value).answer,"🦈".repeat(256));
    assert.throws(()=>gate().admission.accept({...value,receipt:{...value.receipt,answerBytes:1024}}));
  } finally {closeStandingImage(value);}
});

test("registry lookup cannot race an epoch invalidation into a usable result",()=>{
  for(const invalidate of ["dead","revoke","abort"]){
    const value=picture(),g=gate(),get=value.image.registry.get;
    value.image.registry.get=(ref)=>{const artifact=get(ref);if(invalidate==="dead")g.dead();else if(invalidate==="revoke")g.admission.revoke();else g.control.abort();return artifact;};
    try {assert.throws(()=>g.admission.accept(value));assert.ok(value.image.registry.copyBytes(value.image.artifact.ref).length>0);}
    finally {closeStandingImage(value);}
  }
});

test("accessor payloads are never evaluated, malformed scope is refused before admission",()=>{
  let evaluated=0;
  assert.throws(()=>gate().admission.accept({answer:"ok",get receipt(){evaluated++;throw Error("secret");}}));
  assert.throws(()=>gate().admission.accept({answer:"ok",receipt:{...receipt("ok"),get turnId(){evaluated++;throw Error("secret");}}}));
  assert.equal(evaluated,0);
  for(const patch of [{epochId:"bad"},{requestRef:"contains space"},{turnNumber:0},{turnNumber:17},{turnNumber:1.5}])
    assert.throws(()=>gate({...scope,...patch}));
});
