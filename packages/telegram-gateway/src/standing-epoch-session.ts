import { snapshotStandingVisualInputs, type StandingVisualInput } from "./standing-visual-input.js";
import { performance } from "node:perf_hooks";
import { createGeneratedImageReceiver, type GeneratedImageReceiver } from "./generated-image-receiver.js";
import { createNativeTurnAdmission, type NativeTurnScope } from "./standing-native-turn.js";
import type { CompletedStandingResult } from "./standing-model-result.js";
import { EpochWireTimeout } from "./standing-epoch-wire.js";
import { createStandingToolDispatcher, type EpochExtraTool } from "./standing-tool-dispatcher.js";

export type EpochWire = Readonly<{ send(value: unknown, timeoutMs: number): Promise<void>; receive(timeoutMs: number): Promise<unknown> }>;
export type EpochClose = Readonly<{ code: string; unreleasedTurn: boolean; nativeLoopClosed: true; resourceSettlementObserved: false }>;
export class EpochSessionError extends Error { constructor(readonly code: "state" | "protocol" | "deadline" | "closed" | "unknown") { super("STANDING_EPOCH_"+code.toUpperCase()); } }
/** Only a locally detected limit before writing, or an exact guest refusal
 * followed by clean closure proving no native turn was admitted.
 * A managed owner may rotate after actual old-process settlement and retain
 * this selected Telegram question. Other errors never imply safe replay. */
export class EpochTurnNotAdmitted extends Error {
  constructor(readonly reason:"time"|"turns") { super("STANDING_EPOCH_TURN_NOT_ADMITTED_"+reason.toUpperCase()); }
}
export const isEpochTurnNotAdmitted = (error: unknown): error is EpochTurnNotAdmitted => error instanceof EpochTurnNotAdmitted;
const fail = (code: EpochSessionError["code"] = "protocol"): never => { throw new EpochSessionError(code); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(descriptors,key)||!("value" in descriptors[key]!)))return fail();
  return Object.fromEntries(keys.map(key=>[key,descriptors[key]!.value]));
}
const id = (value: unknown): value is string => typeof value==="string"&&value.length>0&&value.length<=256&&!/[\u0000-\u0020\u007f]/u.test(value)&&Buffer.from(value).toString()===value;
const integer = (value: unknown, limit: number): value is number => Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<=limit;
const closedCodes=new Set(["CLOSED","EPOCH_LIMIT","TURN_LIMIT","INPUT_REFUSED","PROTOCOL_REFUSED","IO_UNKNOWN","NATIVE_UNKNOWN","RELEASE_UNKNOWN","INTERNAL_UNKNOWN"]);
const factKeys=["threadStarted","poisoned","busy","turnsAttempted","toolCalls","schema","turnsAdmitted","turnLimit","epochSeconds","turnSeconds","running","releasePending","closed","resourceSettlementObserved","unreleasedTurn"];

/** Session protocol only. The managed host proves custody before opening, owns
 * OS/process settlement afterward and must poison/reconcile an uncertain epoch.
 * This never starts a client, creates another Telegram connection or persists a
 * private payload. Existing outboxes own actual delivery between turn/release.
 */
export async function openStandingEpochSession(input: {
  epochId: string; wire: EpochWire; signal: AbortSignal; custodyReady(): boolean;
  history: Readonly<{call(argumentsValue: unknown): Promise<unknown>}>; clock?:()=>number;
  /** Explicit named mode; absent preserves the legacy history-only wire. */
  extraTools?:readonly EpochExtraTool[];
}): Promise<Readonly<{
  turn(requestRef: string, conversation: string, images?:readonly StandingVisualInput[]): Promise<CompletedStandingResult>;
  release(requestRef: string, delivery: "verified"|"not-sent"|"unknown"): Promise<void>;
  close(options?: Readonly<{ peerEnded?: boolean }>): Promise<EpochClose>;
  admission(): "ready"|"rotate"|"unavailable";
  state(): Readonly<{phase:string;poisoned:boolean;turns:number}>;
}>> {
  if(!/^[a-f0-9]{32}$/.test(input.epochId)||input.signal.aborted||input.custodyReady()!==true)return fail("state");
  const epochId=input.epochId,wire=input.wire,signal=input.signal,clock=input.clock??(()=>performance.now());
  const history=input.history.call.bind(input.history),custody=input.custodyReady.bind(input);
  const tools=input.extraTools===undefined?undefined:createStandingToolDispatcher({call:history},input.extraTools);
  const toolStop=new AbortController(),toolSignal=AbortSignal.any([signal,toolStop.signal]);
  const started=clock(),epochEnd=started+900000;
  if(!Number.isFinite(started))return fail("state");
  let phase="opening",poisoned=false,closing=false,closeSent=false,peerEnded=false,closed:EpochClose|undefined,closeEnd:number|undefined;
  let turns=0,threadId:string|undefined,request:string|undefined,receiver:GeneratedImageReceiver|undefined,contentExposed=false;
  let active:Promise<unknown>|undefined,closeOperation:Promise<EpochClose>|undefined,writeChain=Promise.resolve();
  const seen=new Set<string>();
  const remaining=(end:number)=>{const value=end-clock();if(!Number.isFinite(value)||value<=0)return fail("deadline");return value;};
  const send=(value:unknown,end:number)=>{
    const operation=writeChain.then(()=>wire.send(value,Math.ceil(Math.min(10000,remaining(end)))));
    writeChain=operation.catch(()=>{poisoned=true;});return operation;
  };
  const sendClose=()=>{closing=true;toolStop.abort();void tools?.close();closeEnd ??= clock()+35000;if(closeSent||closed||peerEnded)return writeChain;closeSent=true;return send({kind:"close"},closeEnd);};
  const abort=()=>{void sendClose().catch(()=>{poisoned=true;});};signal.addEventListener("abort",abort,{once:true});
  const parseClosed=(value:unknown):EpochClose=>{
    const v=record(value,["kind","code","facts"]),facts=record(v.facts,factKeys);
    if(v.kind!=="closed"||typeof v.code!=="string"||!closedCodes.has(v.code)||facts.schema!=="neurobro-native-image-epoch-v1"||
       facts.turnLimit!==16||facts.epochSeconds!==900||facts.turnSeconds!==300||facts.closed!==true||facts.running!==false||facts.busy!==false||
       facts.resourceSettlementObserved!==false||facts.releasePending!==false||!integer(facts.turnsAttempted,16)||!integer(facts.turnsAdmitted,16)||!integer(facts.toolCalls,193))return fail();
    for(const key of ["threadStarted","poisoned","unreleasedTurn"])if(typeof facts[key]!=="boolean")return fail();
    closed=Object.freeze({code:v.code,unreleasedTurn:facts.unreleasedTurn as boolean,nativeLoopClosed:true,resourceSettlementObserved:false});
    phase="closed";closing=true;poisoned ||= facts.poisoned===true||facts.unreleasedTurn===true||(v.code!=="CLOSED"&&v.code!=="EPOCH_LIMIT"&&v.code!=="TURN_LIMIT");
    signal.removeEventListener("abort",abort);return closed;
  };
  const receive=async(end:number):Promise<Record<string,unknown>>=>{
    for(;;){
      try{
        const bound=closing&&closeEnd!==undefined?Math.min(end,closeEnd):end;
        const value=await wire.receive(Math.ceil(Math.min(1000,remaining(bound))));
        remaining(bound);
        if(!value||typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype)return fail();
        const descriptor=Object.getOwnPropertyDescriptor(value,"kind");if(!descriptor||!("value" in descriptor)||typeof descriptor.value!=="string")return fail();
        if(descriptor.value==="closed")parseClosed(value);
        return value as Record<string,unknown>;
      }catch(error){if(error instanceof EpochWireTimeout&&error.direction==="read")continue;throw error;}
    }
  };
  const awaitClosed=async(end:number)=>{
    let discarded=0;
    while(!closed){
      const frame=await receive(end);
      if(frame.kind!=="closed"){
        // A close may cross already emitted turn frames. Quarantine/discard them
        // within a bounded cleanup drain; never reinterpret them as an answer.
        if(!closing||++discarded>64||!["scope","tool","imageBegin","imageChunk","imageEnd","completed","released"].includes(frame.kind as string))return fail();
        poisoned=true;
      }
    }
    return closed;
  };
  try{const ready=record(await receive(Math.min(epochEnd,started+120000)),tools?["kind","tools"]:["kind"]);
    if(ready.kind!=="ready"||custody()!==true||signal.aborted)return fail();
    if(tools){
      if(!Array.isArray(ready.tools)||ready.tools.length!==tools.names.length||Reflect.ownKeys(ready.tools).length!==tools.names.length+1)return fail();
      for(let i=0;i<tools.names.length;i++){const d=Object.getOwnPropertyDescriptor(ready.tools,String(i));if(!d||!("value"in d)||d.value!==tools.names[i])return fail();}
    }phase="idle";}
  catch(error){poisoned=true;signal.removeEventListener("abort",abort);void sendClose().catch(()=>{});throw error;}
  const run=<T>(operation:()=>Promise<T>):Promise<T>=>{
    if(active)return Promise.reject(new EpochSessionError("state"));
    const current=operation();active=current;
    void current.finally(()=>{if(active===current)active=undefined;}).catch(()=>{});return current;
  };
  return Object.freeze({
    state:()=>Object.freeze({phase,poisoned,turns}),
    admission:()=>{
      if(active||phase!=="idle"||closing||poisoned||signal.aborted||custody()!==true)return "unavailable";
      const left=epochEnd-clock();
      if(!Number.isFinite(left))return "unavailable";
      // Leave five seconds for packing/admission before the exact turn check.
      return turns>=16||left<305000?"rotate":"ready";
    },
    turn(requestRef:string,conversation:string,images?:readonly StandingVisualInput[]):Promise<CompletedStandingResult>{return run(async()=>{
      if(phase!=="idle"||closing||poisoned||signal.aborted||custody()!==true||!id(requestRef)||seen.has(requestRef))return fail("state");
      if(typeof conversation!=="string"||!conversation.trim()||conversation.includes("\0")||Buffer.byteLength(conversation)>24576||Buffer.from(conversation).toString()!==conversation)return fail();
      const visuals=snapshotStandingVisualInputs(images);
      if(turns>=16)throw new EpochTurnNotAdmitted("turns");
      const left=epochEnd-clock();if(!Number.isFinite(left))return fail("deadline");
      if(left<300000)throw new EpochTurnNotAdmitted("time");
      seen.add(requestRef);turns++;request=requestRef;phase="turn";
      const end=Math.min(epochEnd,clock()+300000),calls=new Set<string>();let scope:NativeTurnScope|undefined;
      try{
        await send({kind:"turn",requestRef,conversation,...(visuals?{images:visuals}:{})},end);
        for(;;){
          const frame=await receive(end);
          if(frame.kind==="closed")return fail("closed");
          if(frame.kind==="notAdmitted") {
            const refused=record(frame,["kind","requestRef","reason","turnsAdmitted"]);
            if(scope||receiver||calls.size||refused.requestRef!==requestRef||
                !["time","turns"].includes(refused.reason as string)||refused.turnsAdmitted!==turns-1)return fail();
            const final=await receive(end);
            if(final.kind!=="closed"||!closed||poisoned||closed.unreleasedTurn||
                closed.code!==(refused.reason==="time"?"EPOCH_LIMIT":"TURN_LIMIT"))return fail();
            const facts=record(final.facts,factKeys);
            if(facts.turnsAdmitted!==turns-1||facts.turnsAttempted!==turns-1||
                (refused.reason==="turns"&&facts.turnsAdmitted!==16))return fail();
            throw new EpochTurnNotAdmitted(refused.reason as "time"|"turns");
          }
          if(frame.kind==="tool"){
            const f=record(frame,tools?["kind","requestRef","callRef","name","arguments"]:["kind","requestRef","callRef","arguments"]);
            if(scope||f.requestRef!==requestRef||!id(f.callRef)||calls.has(f.callRef)||calls.size>=8)return fail();calls.add(f.callRef);
            if(closing)continue;
            if(tools&&(typeof f.name!=="string"||!tools.names.includes(f.name)))return fail();
            const result=tools?await tools.call(f.name as string,f.arguments,Object.freeze({requestRef,callRef:f.callRef,signal:toolSignal})):await history(f.arguments);
            if(!closing)await send({kind:"toolResult",requestRef,callRef:f.callRef,result},end);
          }else if(frame.kind==="scope"){
            const f=record(frame,["kind","scope"]),s=record(f.scope,["requestRef","threadId","turnId","turnNumber"]);
            if(scope||s.requestRef!==requestRef||!id(s.threadId)||!id(s.turnId)||s.turnNumber!==turns||(threadId!==undefined&&s.threadId!==threadId))return fail();
            threadId=s.threadId;scope={epochId,requestRef,threadId,turnId:s.turnId,turnNumber:turns};
          }else if(["imageBegin","imageChunk","imageEnd"].includes(frame.kind as string)){
            if(!scope)return fail();
            if(frame.kind==="imageBegin"){if(receiver)return fail();receiver=createGeneratedImageReceiver({requestRef,threadId:scope.threadId,turnId:scope.turnId});}
            if(!receiver)return fail();receiver.accept(frame);
          }else if(frame.kind==="completed"){
            const f=record(frame,["kind","scope","answer","kindOfAnswer","toolCalls","toolRefusals"]),s=record(f.scope,["requestRef","threadId","turnId","turnNumber"]);
            if(!scope||Object.keys(s).some(k=>s[k]!==scope![k as keyof NativeTurnScope])||f.toolCalls!==calls.size||!integer(f.toolRefusals,4)||
               (f.kindOfAnswer!=="text"&&f.kindOfAnswer!=="image")||!!receiver!==(f.kindOfAnswer==="image"))return fail();
            const admission=createNativeTurnAdmission({scope,signal,isEpochActive:()=>!poisoned&&!closing&&!closed&&custody()===true});
            const value={answer:f.answer,receipt:{...scope,version:"standing-native-turn-v1",outcome:"observed",kind:f.kindOfAnswer,
              custodyReady:true,turnCompleted:true,toolsSettled:true,transportHealthy:true,answerBytes:typeof f.answer==="string"?Buffer.byteLength(f.answer):0},
              ...(receiver?{image:{artifact:receiver.artifact(),registry:{get:receiver.get,copyBytes:receiver.copyBytes},close:receiver.close}}:{})};
            const completed=admission.accept(value);contentExposed=completed.kind==="image";phase="delivery";return completed;
          }else return fail();
        }
      }catch(error){
        if(error instanceof EpochTurnNotAdmitted)throw error;
        poisoned=true;receiver?.close();receiver=undefined;void sendClose().catch(()=>{});throw error;
      }
    });},
    release(requestRef:string,delivery:"verified"|"not-sent"|"unknown"):Promise<void>{return run(async()=>{
      if(phase!=="delivery"||requestRef!==request||closing||!["verified","not-sent","unknown"].includes(delivery))return fail("state");
      // Caller has joined actual outbox/upload settlement before release.
      const end=clock()+35000;
      try{
        await send({kind:"release",requestRef,delivery},end);
        const ack=record(await receive(end),["kind","requestRef","delivery"]);
        if(ack.kind!=="released"||ack.requestRef!==requestRef||ack.delivery!==delivery)return fail();
        if(delivery==="unknown"){closing=true;poisoned=true;await awaitClosed(end);}else phase="idle";
      }catch(error){poisoned=true;void sendClose().catch(()=>{});throw error;}
      finally{receiver?.close();receiver=undefined;contentExposed=false;request=undefined;}
    });},
    close(options?: Readonly<{ peerEnded?: boolean }>):Promise<EpochClose>{
      // Only the process owner supplies this after observing stdout EOF. Keep
      // the existing reader/parser to consume the already queued final proof.
      // Never send a redundant close into an ended peer and lose that proof.
      if(options?.peerEnded===true)peerEnded=true;
      return closeOperation ??= (async()=>{
      closing=true;toolStop.abort();void tools?.close();
      if(closed)return closed;
      await sendClose();
      // No competing receive: the active turn/release drains its own result.
      // Caller must separately join the managed processes even after this ends.
      if(active){
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{
          const joined=await Promise.race([active.then(()=>true,()=>true),new Promise<boolean>(done=>{timer=setTimeout(()=>done(false),Math.ceil(remaining(closeEnd!)));})]);
          if(!joined){poisoned=true;return fail("unknown");}
        }finally{if(timer)clearTimeout(timer);}
      }
      try{return await awaitClosed(closeEnd!);}
      catch(error){poisoned=true;throw error;}
      finally{
        // Once admitted, image ownership belongs to the caller's actual outbox.
        // Closing a native loop cannot wipe bytes of an unfinished upload.
        if(!contentExposed)receiver?.close();receiver=undefined;signal.removeEventListener("abort",abort);
      }
    })();},
  });
}
