import { snapshotStandingVisualInputs, type StandingVisualInput } from "./standing-visual-input.js";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { createGeneratedImageReceiver, type GeneratedImageReceiver } from "./generated-image-receiver.js";
import { createNativeTurnAdmission, type NativeTurnScope } from "./standing-native-turn.js";
import type { CompletedStandingResult } from "./standing-model-result.js";
import { EpochWireTimeout } from "./standing-epoch-wire.js";
import { EpochSessionError, EpochTurnNotAdmitted, type EpochWire, type EpochClose } from "./standing-epoch-session.js";
import { createStandingToolDispatcher, createStandingNamedToolDispatcher, type EpochExtraTool, type EpochToolResult } from "./standing-tool-dispatcher.js";
import { parseStandingCommunityAssessmentInput, parseStandingCommunityAssessmentDecision, type StandingCommunityAssessmentDecision } from "./standing-community-assessment-contract.js";

export type StandingEpochPurpose = "conversation" | "history-analysis" | "community-assessment";
export type StandingScopedEpochMode = "standing-scoped-epoch-v1" | "standing-scoped-epoch-v2";
export type StandingParallelWorkerPurpose = StandingEpochPurpose;
/** Exact worker-local refusal only. Deliberately not EpochTurnNotAdmitted:
 * this does not authorize aggregate rotation/replay. The owner must join the
 * remaining workers and authenticate the final pool receipt and settlement. */
export class StandingWorkerTurnNotAdmitted extends EpochSessionError {
  constructor(readonly purpose:StandingParallelWorkerPurpose,readonly requestRef:string,
    readonly reason:"time"|"turns",readonly turnsAdmitted:number){super("closed");this.name="StandingWorkerTurnNotAdmitted";}
}
export type StandingScopedTurnScope = NativeTurnScope & Readonly<{ purpose:StandingEpochPurpose; threadTurnNumber:number }>;
/** Internal model output only: no delivery receipt, image registry or admission. */
export type CompletedAnalysisTurn = Readonly<{kind:"analysis";scope:StandingScopedTurnScope & Readonly<{purpose:"history-analysis"}>;answer:string;toolCalls:number;toolRefusals:number}>;
/** An internal assessment has neither participant authority nor a delivery receipt. */
export type CompletedCommunityAssessmentTurn = Readonly<{kind:"community-assessment";scope:StandingScopedTurnScope & Readonly<{purpose:"community-assessment"}>;decision:StandingCommunityAssessmentDecision;toolCalls:0;toolRefusals:0}>;
export type StandingToolResultSent = Readonly<{purpose:StandingEpochPurpose;requestRef:string;callRef:string;name:string;result:EpochToolResult}>;
const analysisNames = ["neurobro_analysis_material","neurobro_analysis_notes","neurobro_analysis_commit"];
const fail = (code:EpochSessionError["code"]="protocol"):never=>{throw new EpochSessionError(code);};
const id = (value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const integer = (value:unknown,max:number):value is number=>Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<=max;
const text = (value:unknown,max:number):value is string=>typeof value==="string"&&!!value.trim()&&!value.includes("\0")&&Buffer.byteLength(value)<=max&&Buffer.from(value).toString()===value;
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=="object"||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return fail();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==keys.length||keys.some(k=>!Object.hasOwn(descriptors,k)||!("value" in descriptors[k]!)))return fail();
  return Object.fromEntries(keys.map(k=>[k,descriptors[k]!.value]));
}
function array(value:unknown,length:number):unknown[]{
  if(!value||typeof value!=="object"||types.isProxy(value)||!Array.isArray(value)||value.length!==length||Reflect.ownKeys(value).length!==length+1)return fail();
  return Array.from({length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!("value"in d))return fail();return d.value as unknown;});
}
function analysisInput(value:string):void{
  let parsed:unknown;try{parsed=JSON.parse(value);}catch{return fail();}
  const source=!!parsed&&typeof parsed==="object"&&Object.hasOwn(parsed,"sourceRef");
  const period=!!parsed&&typeof parsed==="object"&&Object.hasOwn(parsed,"periodChronicle");
  const continuation=!!parsed&&typeof parsed==="object"&&Object.hasOwn(parsed,"continuation");
  const keys=["schema","kind","objective","materialAvailable",...(continuation?["continuation"]:[]),...(source?["sourceRef","sourceInterpretation"]:[]),...(period?["periodChronicle"]:[])];
  const v=record(parsed,keys);
  if(continuation&&!text(v.continuation,1024))return fail();
  if(period){const p=record(v.periodChronicle,["contextHash","neutralPeriodNotesAvailable","periodAdvisoryAvailable"]);
    if(typeof p.contextHash!=="string"||!/^[0-9a-f]{64}$/.test(p.contextHash)||typeof p.neutralPeriodNotesAvailable!=="boolean"||typeof p.periodAdvisoryAvailable!=="boolean"||
       !p.neutralPeriodNotesAvailable&&!p.periodAdvisoryAvailable)return fail();}
  // The packet has primitive fields and one fixed optional marker. Count unquoted colons to
  // reject duplicate keys that JSON.parse would otherwise silently overwrite.
  const tokens=value.match(/"(?:\\.|[^"\\])*"|:/gs)??[];
  if(tokens.filter(t=>t===":").length!==keys.length+(period?3:0)||v.schema!=="neurobro-history-analysis-input-v1"||
     source&&(v.sourceRef!=="community"||v.sourceInterpretation!=="quoted-source-not-request")||
     (v.kind!=="leaf"&&v.kind!=="merge"&&v.kind!=="final-report"&&v.kind!=="final-report-review")||
     (v.kind==="final-report"||v.kind==="final-report-review")&&period||!text(v.objective,4096)||v.materialAvailable!==true)return fail();
}
const scopeKeys=["purpose","requestRef","threadId","turnId","turnNumber","threadTurnNumber"];
const workerScopeKeys=["purpose","requestRef","threadId","turnId","turnNumber"];
const workerFactKeys=["threadStarted","poisoned","busy","turnsAttempted","toolCalls","schema","turnsAdmitted","turnLimit","epochSeconds","turnSeconds","running","releasePending","closed","resourceSettlementObserved","unreleasedTurn"];
const factKeys=["threadStarted","poisoned","busy","turnsAttempted","toolCalls","schema","turnsAdmitted","turnLimit","epochSeconds","turnSeconds","running","releasePending","closed","resourceSettlementObserved","unreleasedTurn","threadLimit","threadStartDispatches","turnStartDispatches","slots"];
const slotKeys=["purpose","threadStarted","turnsAdmitted","turnsAttempted","toolCalls","closed","poisoned"];
const closedCodes=new Set(["CLOSED","EPOCH_LIMIT","TURN_LIMIT","INPUT_REFUSED","PROTOCOL_REFUSED","IO_UNKNOWN","NATIVE_UNKNOWN","RELEASE_UNKNOWN","INTERNAL_UNKNOWN"]);

/** Opt-in scoped protocol, not a process owner. One reader and write chain serve
 * purpose-bound native threads under unchanged aggregate turn budgets. V1
 * retains its two-slot contract; only explicit V2 adds the tool-free assessor.
 * The host retains
 * process settlement, task persistence and conversation delivery obligations.
 * A sent-result hook records exposure only after actual wire.send settlement;
 * its failure consumes this turn and closes the session without replay.
 */
export async function openStandingScopedEpochSession(input:{
  epochId:string;wire:EpochWire;signal:AbortSignal;custodyReady():boolean;clock?:()=>number;
  sessionMode?:StandingScopedEpochMode;
  /** A port of an authenticated parallel pool, restricted to this one purpose.
   * Counters and admission are worker-local. The caller owns aggregate budgets,
   * pool closure and process settlement. Mutually exclusive with sessionMode. */
  worker?:Readonly<{purpose:StandingParallelWorkerPurpose}>;
  conversation:Readonly<{history:Readonly<{call(argumentsValue:unknown):Promise<unknown>}>;extraTools?:readonly EpochExtraTool[]}>;
  analysisTools:readonly EpochExtraTool[];
  onToolResultSent(event:StandingToolResultSent):Promise<void>|void;
}){
  if(typeof input.epochId!=="string"||!/^[a-f0-9]{32}$/.test(input.epochId)||input.signal.aborted||input.custodyReady()!==true||typeof input.onToolResultSent!=="function")return fail("state");
  const mode=input.sessionMode===undefined?"standing-scoped-epoch-v1":input.sessionMode;
  if(mode!=="standing-scoped-epoch-v1"&&mode!=="standing-scoped-epoch-v2")return fail("state");
  const worker=input.worker===undefined?undefined:record(input.worker,["purpose"]);
  if(worker&&(input.sessionMode!==undefined||!["conversation","history-analysis","community-assessment"].includes(worker.purpose as string)))return fail("state");
  const v2=mode==="standing-scoped-epoch-v2",purposes:readonly StandingEpochPurpose[]=worker?[worker.purpose as StandingParallelWorkerPurpose]:v2?["conversation","history-analysis","community-assessment"]:["conversation","history-analysis"];
  const wireScopeKeys=worker?workerScopeKeys:scopeKeys;
  const epochId=input.epochId,signal=input.signal,clock=input.clock??(()=>performance.now()),custody=input.custodyReady.bind(input);
  const wire={send:input.wire.send.bind(input.wire),receive:input.wire.receive.bind(input.wire)},shown=input.onToolResultSent.bind(input);
  const dispatchers={conversation:createStandingToolDispatcher(input.conversation.history,input.conversation.extraTools??[]),
    "history-analysis":createStandingNamedToolDispatcher(input.analysisTools,"history-analysis"),
    // No fake disabled capability: every assessment tool frame is a protocol
    // violation before any handler or result-exposure callback can run.
    "community-assessment":{names:Object.freeze([] as string[]),call:async(..._args:unknown[])=>fail(),close:async()=>{}}};
  const allNames=[...dispatchers.conversation.names,...dispatchers["history-analysis"].names];
  if(allNames.length>32||new Set(allNames).size!==allNames.length||JSON.stringify(dispatchers["history-analysis"].names)!==JSON.stringify(analysisNames))return fail("state");
  const toolStop=new AbortController(),toolSignal=AbortSignal.any([signal,toolStop.signal]);
  const started=clock(),epochEnd=started+900000;if(!Number.isFinite(started))return fail("state");
  let phase="opening",poisoned=false,closing=false,closeSent=false,peerEnded=false,closed:EpochClose|undefined,closeEnd:number|undefined;
  let turns=0,request:string|undefined,currentPurpose:StandingEpochPurpose|undefined,receiver:GeneratedImageReceiver|undefined,contentExposed=false;
  let active:Promise<unknown>|undefined,closeOperation:Promise<EpochClose>|undefined,writeChain=Promise.resolve(),dispatcherClose:Promise<void>|undefined;
  let refusalPending=false;
  const seen=new Set<string>(),seenTurns=new Set<string>();
  const slots:Record<StandingEpochPurpose,{thread:string|undefined;turns:number;completed:number;tools:number}>={
    conversation:{thread:undefined,turns:0,completed:0,tools:0},"history-analysis":{thread:undefined,turns:0,completed:0,tools:0},"community-assessment":{thread:undefined,turns:0,completed:0,tools:0}};
  const remaining=(end:number)=>{const left=end-clock();if(!Number.isFinite(left)||left<=0)return fail("deadline");return left;};
  const send=(value:unknown,end:number)=>{
    const operation=writeChain.then(()=>wire.send(value,Math.ceil(Math.min(10000,remaining(end)))));
    writeChain=operation.catch(()=>{poisoned=true;});return operation;
  };
  const revoke=()=>{closing=true;toolStop.abort();dispatcherClose??=Promise.all(purposes.map(p=>dispatchers[p].close())).then(()=>{});closeEnd??=clock()+35000;};
  const sendClose=()=>{revoke();if(closeSent||closed||peerEnded)return writeChain;closeSent=true;return send({kind:"close"},closeEnd!);};
  const abort=()=>{void sendClose().catch(()=>{poisoned=true;});};signal.addEventListener("abort",abort,{once:true});
  const parseClosed=(value:unknown):EpochClose=>{
    if(worker){
      const v=record(value,["kind","code","facts"]),f=record(v.facts,workerFactKeys);
      if(v.kind!=="closed"||typeof v.code!=="string"||!closedCodes.has(v.code)||v.code==="TURN_LIMIT"||f.schema!=="neurobro-native-image-epoch-v1"||
         f.turnLimit!==16||f.epochSeconds!==900||f.turnSeconds!==300||f.closed!==true||f.running!==false||f.busy!==false||
         f.releasePending!==false||f.resourceSettlementObserved!==false||!integer(f.turnsAttempted,16)||!integer(f.turnsAdmitted,16)||!integer(f.toolCalls,193)||
         f.turnsAttempted>f.turnsAdmitted||worker.purpose==="community-assessment"&&f.toolCalls!==0)return fail();
      for(const k of ["threadStarted","poisoned","unreleasedTurn"])if(typeof f[k]!=="boolean")return fail();
      const clean=f.poisoned===false&&f.unreleasedTurn===false&&(v.code==="CLOSED"||v.code==="EPOCH_LIMIT");
      if(clean){const expected=slots[purposes[0]!];
        if(f.turnsAdmitted!==turns-(refusalPending?1:0)||f.turnsAttempted!==expected.completed||f.toolCalls!==expected.tools||f.threadStarted!==(expected.thread!==undefined))return fail();}
      closed=Object.freeze({code:v.code,unreleasedTurn:f.unreleasedTurn as boolean,nativeLoopClosed:true,resourceSettlementObserved:false});
      phase="closed";closing=true;poisoned||=!clean;signal.removeEventListener("abort",abort);return closed;
    }
    const v=record(value,["kind","code","facts"]),f=record(v.facts,factKeys);
    if(v.kind!=="closed"||typeof v.code!=="string"||!closedCodes.has(v.code)||f.schema!==(v2?"neurobro-native-scoped-epoch-v2":"neurobro-native-scoped-epoch-v1")||
       f.threadLimit!==purposes.length||f.turnLimit!==16||f.epochSeconds!==900||f.turnSeconds!==300||f.closed!==true||f.running!==false||f.busy!==false||
       f.releasePending!==false||f.resourceSettlementObserved!==false||!integer(f.turnsAttempted,16)||!integer(f.turnsAdmitted,16)||!integer(f.toolCalls,193)||
       !integer(f.threadStartDispatches,purposes.length)||!integer(f.turnStartDispatches,16)||f.turnStartDispatches>f.turnsAdmitted)return fail();
    for(const k of ["threadStarted","poisoned","unreleasedTurn"])if(typeof f[k]!=="boolean")return fail();
    const states=array(f.slots,purposes.length).map((entry,index)=>{
      const s=record(entry,slotKeys);if(s.purpose!==purposes[index]||typeof s.threadStarted!=="boolean"||typeof s.poisoned!=="boolean"||s.closed!==true||
        !integer(s.turnsAdmitted,16)||!integer(s.turnsAttempted,16)||s.turnsAttempted>s.turnsAdmitted||!integer(s.toolCalls,193)||s.purpose==="community-assessment"&&s.toolCalls!==0)return fail();return s;
    });
    const sum=(key:string)=>states.reduce((total,s)=>total+(s[key] as number),0);
    if(sum("turnsAdmitted")>f.turnsAdmitted||sum("turnsAttempted")!==f.turnsAttempted||sum("toolCalls")!==f.toolCalls||
       states.filter(s=>s.threadStarted).length>f.threadStartDispatches||states.some(s=>s.threadStarted)!==f.threadStarted||states.some(s=>s.poisoned)!==f.poisoned)return fail();
    const clean=f.poisoned===false&&f.unreleasedTurn===false&&["CLOSED","EPOCH_LIMIT","TURN_LIMIT"].includes(v.code);
    if(clean){
      if(f.turnsAdmitted!==turns-(refusalPending?1:0)||f.turnStartDispatches!==f.turnsAdmitted||f.turnsAttempted!==f.turnsAdmitted||
         f.threadStartDispatches!==purposes.filter(p=>slots[p].thread!==undefined).length)return fail();
      for(let i=0;i<purposes.length;i++){const s=states[i]!,expected=slots[purposes[i]!];
        if(s.turnsAdmitted!==expected.completed||s.turnsAttempted!==expected.completed||s.toolCalls!==expected.tools||s.threadStarted!==(expected.thread!==undefined))return fail();}
    }
    closed=Object.freeze({code:v.code,unreleasedTurn:f.unreleasedTurn as boolean,nativeLoopClosed:true,resourceSettlementObserved:false});
    phase="closed";closing=true;poisoned||=!clean;signal.removeEventListener("abort",abort);return closed;
  };
  const receive=async(end:number):Promise<Record<string,unknown>>=>{
    for(;;){try{
      const bound=closing&&closeEnd!==undefined?Math.min(end,closeEnd):end;
      const value=await wire.receive(Math.ceil(Math.min(1000,remaining(bound))));remaining(bound);
      if(!value||typeof value!=="object"||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return fail();
      const d=Object.getOwnPropertyDescriptor(value,"kind");if(!d||!("value"in d)||typeof d.value!=="string")return fail();
      if(d.value==="closed")parseClosed(value);return value as Record<string,unknown>;
    }catch(error){if(error instanceof EpochWireTimeout&&error.direction==="read")continue;throw error;}}
  };
  const awaitClosed=async(end:number)=>{
    let discarded=0;while(!closed){const f=await receive(end);if(f.kind!=="closed"){
      if(!closing||++discarded>64||!["scope","tool","imageBegin","imageChunk","imageEnd","completed","released"].includes(f.kind as string))return fail();poisoned=true;
    }}return closed;
  };
  try{
    const ready=record(await receive(Math.min(epochEnd,started+120000)),["kind","protocol","scopes"]);
    if(ready.kind!=="ready"||ready.protocol!==(worker?"standing-parallel-epoch-v1":mode)||signal.aborted||custody()!==true)return fail();
    array(ready.scopes,purposes.length).forEach((entry,index)=>{const s=record(entry,["purpose","tools"]),purpose=purposes[index]!;
      if(s.purpose!==purpose||array(s.tools,dispatchers[purpose].names.length).some((name,i)=>name!==dispatchers[purpose].names[i]))return fail();});
    phase="idle";
  }catch(error){poisoned=true;signal.removeEventListener("abort",abort);await sendClose().catch(()=>{});await dispatcherClose;throw error;}
  const run=<T>(operation:()=>Promise<T>):Promise<T>=>{
    if(active)return Promise.reject(new EpochSessionError("state"));
    const current=operation();active=current;void current.finally(()=>{if(active===current)active=undefined;}).catch(()=>{});return current;
  };
  const turn=(purpose:StandingEpochPurpose,requestRef:string,body:string,images?:readonly StandingVisualInput[]):Promise<CompletedStandingResult|CompletedAnalysisTurn|CompletedCommunityAssessmentTurn>=>run(async()=>{
    if(!purposes.includes(purpose)||phase!=="idle"||closing||poisoned||signal.aborted||custody()!==true||!id(requestRef)||seen.has(requestRef))return fail("state");
    if(!text(body,24576))return fail();if(purpose==="history-analysis")analysisInput(body);
    let assessment:ReturnType<typeof parseStandingCommunityAssessmentInput>|undefined;
    if(purpose==="community-assessment"){try{assessment=parseStandingCommunityAssessmentInput(body,requestRef);}catch{return fail();}}
    if(turns>=16)throw new EpochTurnNotAdmitted("turns");
    const left=epochEnd-clock();if(!Number.isFinite(left))return fail("deadline");if(left<300000)throw new EpochTurnNotAdmitted("time");
    const visuals=snapshotStandingVisualInputs(images);
    seen.add(requestRef);turns++;slots[purpose].turns++;request=requestRef;currentPurpose=purpose;phase="turn";
    const end=Math.min(epochEnd,clock()+300000),calls=new Set<string>();let scope:StandingScopedTurnScope|undefined;
    try{
      await send({kind:"turn",purpose,requestRef,input:body,...(visuals?{images:visuals}:{})},end);
      for(;;){
        const frame=await receive(end);if(frame.kind==="closed")return fail("closed");
        if(frame.kind==="notAdmitted"){
          if(worker){
            const f=record(frame,["kind","purpose","requestRef","reason","turnsAdmitted"]);
            if(scope||receiver||calls.size||f.purpose!==purpose||f.requestRef!==requestRef||
               !["time","turns"].includes(f.reason as string)||f.turnsAdmitted!==turns-1)return fail();
            // Native retired this worker but siblings may still hold useful
            // work. Do not release or send a pool close from this refusal.
            refusalPending=true;phase="retired";
            throw new StandingWorkerTurnNotAdmitted(purpose,requestRef,f.reason as "time"|"turns",f.turnsAdmitted as number);
          }
          const f=record(frame,["kind","purpose","requestRef","reason","turnsAdmitted","turnStartDispatches"]);
          if(scope||receiver||calls.size||f.purpose!==purpose||f.requestRef!==requestRef||!["time","turns"].includes(f.reason as string)||
             f.turnsAdmitted!==turns-1||f.turnStartDispatches!==turns-1)return fail();
          refusalPending=true;
          const final=await receive(end);
          if(final.kind!=="closed"||!closed||poisoned||closed.unreleasedTurn||closed.code!==(f.reason==="time"?"EPOCH_LIMIT":"TURN_LIMIT")||
             (f.reason==="turns"&&f.turnsAdmitted!==16))return fail();
          throw new EpochTurnNotAdmitted(f.reason as "time"|"turns");
        }
        if(frame.kind==="tool"){
          const f=record(frame,["kind","purpose","requestRef","callRef","name","arguments"]);
          if(scope||f.purpose!==purpose||f.requestRef!==requestRef||!id(f.callRef)||calls.has(f.callRef)||calls.size>=8||
             typeof f.name!=="string"||!dispatchers[purpose].names.includes(f.name))return fail();calls.add(f.callRef);
          if(closing)continue;
          const result=await dispatchers[purpose].call(f.name,f.arguments,Object.freeze({requestRef,callRef:f.callRef,signal:toolSignal}));
          if(!closing){
            await send({kind:"toolResult",purpose,requestRef,callRef:f.callRef,result},end);
            await shown(Object.freeze({purpose,requestRef,callRef:f.callRef,name:f.name,result}));
            remaining(end);
          }
        }else if(frame.kind==="scope"){
          const f=record(frame,["kind","scope"]),s=record(f.scope,wireScopeKeys),slot=slots[purpose];
          if(scope||s.purpose!==purpose||s.requestRef!==requestRef||!id(s.threadId)||!id(s.turnId)||s.turnNumber!==turns||!worker&&s.threadTurnNumber!==slot.turns||
             (slot.thread!==undefined&&s.threadId!==slot.thread)||purposes.some(other=>other!==purpose&&s.threadId===slots[other].thread)||seenTurns.has(s.threadId+"\0"+s.turnId))return fail();
          slot.thread=s.threadId;seenTurns.add(s.threadId+"\0"+s.turnId);
          scope=Object.freeze({epochId,purpose,requestRef,threadId:s.threadId,turnId:s.turnId,turnNumber:turns,threadTurnNumber:slot.turns});
        }else if(["imageBegin","imageChunk","imageEnd"].includes(frame.kind as string)){
          if(purpose!=="conversation"||!scope)return fail();
          if(frame.kind==="imageBegin"){if(receiver)return fail();receiver=createGeneratedImageReceiver({requestRef,threadId:scope.threadId,turnId:scope.turnId});}
          if(!receiver)return fail();receiver.accept(frame);
        }else if(frame.kind==="completed"){
          const f=record(frame,["kind","scope","answer","kindOfAnswer","toolCalls","toolRefusals"]),s=record(f.scope,wireScopeKeys);
          if(!scope||wireScopeKeys.some(k=>s[k]!==scope![k as keyof StandingScopedTurnScope])||f.toolCalls!==calls.size||!integer(f.toolRefusals,4)||
             !text(f.answer,purpose==="community-assessment"?8192:4096)||(f.kindOfAnswer!=="text"&&f.kindOfAnswer!=="image")||!!receiver!==(f.kindOfAnswer==="image")||
             closing||poisoned||signal.aborted||custody()!==true)return fail();
          slots[purpose].completed++;slots[purpose].tools+=calls.size+f.toolRefusals;
          if(purpose==="community-assessment"){
            if(f.kindOfAnswer!=="text"||f.toolCalls!==0||f.toolRefusals!==0)return fail();
            let decision:StandingCommunityAssessmentDecision;try{decision=parseStandingCommunityAssessmentDecision(f.answer,assessment!);}catch{return fail();}
            phase="delivery";return Object.freeze({kind:"community-assessment",scope:scope as CompletedCommunityAssessmentTurn["scope"],decision,toolCalls:0,toolRefusals:0});
          }
          if(purpose==="history-analysis"){
            if(f.kindOfAnswer!=="text")return fail();phase="delivery";
            return Object.freeze({kind:"analysis",scope:scope as CompletedAnalysisTurn["scope"],answer:f.answer,toolCalls:calls.size,toolRefusals:f.toolRefusals});
          }
          const nativeScope:NativeTurnScope={epochId,requestRef,threadId:scope.threadId,turnId:scope.turnId,turnNumber:scope.turnNumber};
          const admission=createNativeTurnAdmission({scope:nativeScope,signal,isEpochActive:()=>!poisoned&&!closing&&!closed&&custody()===true});
          const result=admission.accept({answer:f.answer,receipt:{...nativeScope,version:"standing-native-turn-v1",outcome:"observed",kind:f.kindOfAnswer,
            custodyReady:true,turnCompleted:true,toolsSettled:true,transportHealthy:true,answerBytes:Buffer.byteLength(f.answer)},
            ...(receiver?{image:{artifact:receiver.artifact(),registry:{get:receiver.get,copyBytes:receiver.copyBytes},close:receiver.close}}:{})});
          contentExposed=result.kind==="image";phase="delivery";return result;
        }else return fail();
      }
    }catch(error){if(error instanceof EpochTurnNotAdmitted||error instanceof StandingWorkerTurnNotAdmitted)throw error;poisoned=true;receiver?.close();receiver=undefined;void sendClose().catch(()=>{});throw error;}
  });
  const release=(purpose:StandingEpochPurpose,requestRef:string,delivery:"verified"|"not-sent"|"unknown")=>run(async()=>{
    if(phase!=="delivery"||currentPurpose!==purpose||request!==requestRef||closing||signal.aborted||custody()!==true||
       !["verified","not-sent","unknown"].includes(delivery)||(purpose!=="conversation"&&delivery!=="not-sent"))return fail("state");
    const end=clock()+35000;
    try{
      await send({kind:"release",purpose,requestRef,delivery},end);
      const ack=record(await receive(end),["kind","purpose","requestRef","delivery"]);
      if(ack.kind!=="released"||ack.purpose!==purpose||ack.requestRef!==requestRef||ack.delivery!==delivery)return fail();
      if(delivery==="unknown"){closing=true;poisoned=true;await awaitClosed(end);}else phase="idle";
    }catch(error){poisoned=true;void sendClose().catch(()=>{});throw error;}
    finally{receiver?.close();receiver=undefined;contentExposed=false;request=undefined;currentPurpose=undefined;}
  });
  return Object.freeze({
    turnConversation:(requestRef:string,body:string,images?:readonly StandingVisualInput[])=>turn("conversation",requestRef,body,images) as Promise<CompletedStandingResult>,
    turnAnalysis:(requestRef:string,body:string)=>turn("history-analysis",requestRef,body) as Promise<CompletedAnalysisTurn>,
    turnCommunityAssessment:(requestRef:string,body:string)=>turn("community-assessment",requestRef,body) as Promise<CompletedCommunityAssessmentTurn>,
    releaseConversation:(requestRef:string,delivery:"verified"|"not-sent"|"unknown")=>release("conversation",requestRef,delivery),
    releaseAnalysis:(requestRef:string)=>release("history-analysis",requestRef,"not-sent"),
    releaseCommunityAssessment:(requestRef:string)=>release("community-assessment",requestRef,"not-sent"),
    state:()=>Object.freeze({phase,poisoned,turns,conversationTurns:slots.conversation.turns,analysisTurns:slots["history-analysis"].turns,...(v2||worker?.purpose==="community-assessment"?{communityAssessmentTurns:slots["community-assessment"].turns}:{})}),
    admission:():"ready"|"rotate"|"unavailable"=>{
      if(active||phase!=="idle"||closing||poisoned||signal.aborted||custody()!==true)return "unavailable";
      const left=epochEnd-clock();return !Number.isFinite(left)?"unavailable":turns>=16||left<305000?"rotate":"ready";
    },
    close(options?:Readonly<{peerEnded?:boolean}>):Promise<EpochClose>{
      if(options?.peerEnded===true)peerEnded=true;
      return closeOperation??=(async()=>{
        revoke();
        try{
          await sendClose();
          // Join the active operation (including callback and exposure hook)
          // before borrowing its sole reader. Timeout never asserts settlement.
          if(active){let timer:ReturnType<typeof setTimeout>|undefined;
            try{const joined=await Promise.race([active.then(()=>true,()=>true),new Promise<boolean>(done=>{timer=setTimeout(()=>done(false),Math.ceil(remaining(closeEnd!)));})]);if(!joined)return fail("unknown");}
            finally{if(timer)clearTimeout(timer);}}
          const result=await awaitClosed(closeEnd!);await dispatcherClose;await writeChain;return result;
        }catch(error){poisoned=true;throw error;}
        finally{if(!contentExposed)receiver?.close();receiver=undefined;signal.removeEventListener("abort",abort);}
      })();
    },
  });
}
