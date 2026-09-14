import test from "node:test";
import assert from "node:assert/strict";
import { completedStandingResult, closeStandingImage, type StandingNativeReceipt, type StandingNativeModelResult } from "../src/standing-model-result.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
function receipt(kind: StandingNativeReceipt["kind"], answer: string | null): StandingNativeReceipt {
  return { version: "standing-native-host-v1", outcome: "observed", kind, exitCode: 0,
    transportError: false, timedOut: false, aborted: false, overflow: false,
    guestSettled: true, clientSettled: true, relaySettled: true, custodyReady: true,
    appServerSettled: true, turnCompleted: true, answerBytes: Buffer.byteLength(answer ?? "") };
}
function imageResult(answer: string | null = "Картинка") {
  const origin = { requestRef: "request-1", threadId: "thread-1", turnId: "turn-1", itemId: "image-1" };
  const registry = createGeneratedImageRegistry({requestRef:origin.requestRef,threadId:origin.threadId,turnId:origin.turnId});
  const artifact = registry.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: PNG });
  let closed = 0;
  const value: StandingNativeModelResult = { answer, receipt: receipt("image",answer), image: { artifact,
    registry: { get: registry.get, copyBytes: registry.copyBytes }, close() { closed++; registry.close(); } } };
  return { value, registry, closed: () => closed };
}

test("legacy text and settled unknown preserve the original receipt behavior", () => {
  const { kind: _, ...old } = receipt("text","ответ");
  assert.deepEqual(completedStandingResult({ answer:"ответ",receipt:{...old,version:"modeltext-host-v1"} }), {kind:"text",answer:"ответ"});
  for (const r of [null, {}, {...old,version:"modeltext-host-v1",outcome:"unknown"}]) {
    assert.deepEqual(completedStandingResult({answer:"discard",receipt:r}), {kind:"none",answer:null});
  }
});

test("native text requires exact settled receipt and image absence", () => {
  const value = { answer:"ответ",receipt:receipt("text","ответ") };
  assert.deepEqual(completedStandingResult(value),{kind:"text",answer:"ответ"});
  for (const field of ["guestSettled","clientSettled","relaySettled","appServerSettled","custodyReady","turnCompleted"]) {
    assert.throws(()=>completedStandingResult({...value,receipt:{...value.receipt,[field]:false}}),/STANDING_MODEL_RESULT_REFUSED/);
  }
  for (const patch of [{answerBytes:1},{exitCode:1},{transportError:true},{timedOut:true},{aborted:true},{overflow:true},{extra:true}]) {
    assert.throws(()=>completedStandingResult({...value,receipt:{...value.receipt,...patch}}));
  }
  assert.throws(()=>completedStandingResult({...value,image:undefined}));
  assert.throws(()=>completedStandingResult({...value,extra:true}));
});

test("native settled unknown permits a fixed notice only without partial content or unsettled resources", () => {
  const value = {answer:null,receipt:{...receipt("none",null),outcome:"unknown",custodyReady:false,turnCompleted:false,exitCode:1}};
  assert.deepEqual(completedStandingResult(value),{kind:"none",answer:null});
  for (const patch of [{answer:"partial"},{image:{}},{receipt:{...value.receipt,guestSettled:false}},{receipt:{...value.receipt,kind:"image"}}]) assert.throws(()=>completedStandingResult({...value,...patch}));
});

test("completed image keeps bytes in scoped registry and caption separate until explicit close", () => {
  for (const answer of [null,"Картинка"]) {
    const f = imageResult(answer), value = completedStandingResult(f.value);
    assert.equal(value.kind,"image"); assert.equal(value.answer,answer); assert.equal(f.closed(),0);
    assert.equal(f.registry.copyBytes(f.value.image!.artifact.ref).toString("base64"),PNG);
    closeStandingImage(f.value); assert.equal(f.closed(),1);
    assert.throws(()=>f.registry.get(f.value.image!.artifact.ref),/CLOSED/);
  }
});

test("image validation rejects mismatched provenance, unavailable registry and overlong native answers", () => {
  const f = imageResult(); const image = f.value.image!;
  try {
    for (const artifact of [{...image.artifact,sha256:"a".repeat(64)},{...image.artifact,origin:{...image.artifact.origin,turnId:"foreign"}},{...image.artifact,width:8193},{...image.artifact,extra:true}]) {
      assert.throws(()=>completedStandingResult({...f.value,image:{...image,artifact}}));
    }
    assert.throws(()=>completedStandingResult({...f.value,image:{...image,registry:{get:()=>null,copyBytes:image.registry.copyBytes}}}));
    const answer = "я".repeat(2049);
    assert.throws(()=>completedStandingResult({...f.value,answer,receipt:receipt("image",answer)}));
    assert.throws(()=>completedStandingResult({...f.value,receipt:{...f.value.receipt,kind:"text"}}));
    assert.throws(()=>completedStandingResult({...f.value,receipt:{version:"modeltext-host-v1"}}));
  } finally { closeStandingImage(f.value); }
});

test("image caption projection validates full native receipt then truncates Cyrillic and emoji at codepoint boundaries",()=>{
  for(const [answer,expected] of [["я".repeat(513),"я".repeat(512)],["а".repeat(511)+"🦈 хвост","а".repeat(511)],["🦈".repeat(300),"🦈".repeat(256)]]){
    const f=imageResult(answer!);
    try {
      const completed=completedStandingResult(f.value);assert.equal(completed.answer,expected);
      assert.ok(Buffer.byteLength(completed.answer!)<=1024);assert.equal(Buffer.from(completed.answer!).toString("utf8"),completed.answer);
      assert.throws(()=>completedStandingResult({...f.value,receipt:{...f.value.receipt,answerBytes:Buffer.byteLength(expected!)}}));
      assert.equal(completedStandingResult({answer,receipt:receipt("text",answer!)}).answer,answer);
    } finally {closeStandingImage(f.value);}
  }
});

test("metadata property order is irrelevant and no data accessor is evaluated", () => {
  const f = imageResult(), image = f.value.image!;
  try {
    const artifact = Object.fromEntries(Object.entries(image.artifact).reverse());
    assert.equal(completedStandingResult({...f.value,image:{...image,artifact}}).kind,"image");
    let calls = 0;
    const hostile = {...f.value,image:{...image,get artifact() { calls++; throw Error("getter"); }}};
    assert.throws(()=>completedStandingResult(hostile)); closeStandingImage(hostile); assert.equal(calls,0);assert.equal(f.closed(),1);
  } finally { closeStandingImage(f.value); }
});

test("invalid receipts still allow resource close without reading image bytes", () => {
  const f = imageResult(), value = {...f.value,receipt:{...f.value.receipt,clientSettled:false}};
  assert.throws(()=>completedStandingResult(value)); closeStandingImage(value); assert.equal(f.closed(),1);
});

test("accepted image snapshots survive mutation during lookup and after admission",()=>{
  const f=imageResult(),original=f.value.image!,get=original.registry.get,copy=original.registry.copyBytes;
  const mutable={artifact:{...original.artifact,origin:{...original.artifact.origin}},registry:{get,copyBytes:copy},close:original.close};
  const value={answer:"Исходная подпись",receipt:receipt("image","Исходная подпись"),image:mutable};
  mutable.registry.get=(ref)=>{
    mutable.artifact={...mutable.artifact,width:2};value.answer="Подменено";
    return get(ref);
  };
  const accepted=completedStandingResult(value);assert.equal(accepted.kind,"image");
  if(accepted.kind!=="image")throw Error("expected image");
  assert.equal(accepted.answer,"Исходная подпись");assert.equal(accepted.image.artifact.width,1);
  mutable.artifact.origin.turnId="foreign";mutable.registry.copyBytes=()=>Buffer.alloc(0);mutable.close=()=>{};
  assert.equal(accepted.image.artifact.origin.turnId,"turn-1");
  assert.ok(accepted.image.registry.copyBytes(accepted.image.artifact.ref).length>0);
  assert.ok(Object.isFrozen(accepted.image)&&Object.isFrozen(accepted.image.artifact)&&Object.isFrozen(accepted.image.artifact.origin)&&Object.isFrozen(accepted.image.registry));
  accepted.image.close();assert.equal(f.closed(),1);assert.throws(()=>get(original.artifact.ref));
});
