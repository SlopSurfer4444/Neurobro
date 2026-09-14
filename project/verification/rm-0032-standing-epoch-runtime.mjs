// The outer worker admits the protected parent ACL and owns durable Telegram
// admission/outboxes. This factory owns one connection and one model process.
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants,lstatSync,realpathSync,mkdirSync,openSync,fstatSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {resolve,dirname,isAbsolute} from 'node:path';
import {types} from 'node:util';
import {preparePacket,frameSource,SOURCE_NAMES} from './rm-0032-standing-epoch-host.mjs';
import {snapshotEpochExtraToolsFromInput,snapshotEpochSessionModeFromInput,snapshotEpochAnalysisCallbacks,startOwnedEpoch} from './rm-0032-standing-epoch-owner.mjs';
import {normalizeEpochOwnerRecord} from './rm-0032-standing-epoch-receipt.mjs';

const TOKEN=/^[a-f0-9]{32}$/u;
const WSL='C:/Program Files/WSL/wsl.exe';
// Provisional churn mitigation, not a per-turn relay-capacity guarantee.
// Native hard limits stay unchanged; prepare rotates only after release.
const SOFT_EPOCH_TURNS=6;
export class StandingEpochRuntimeError extends Error{constructor(code){super('STANDING_EPOCH_RUNTIME_'+code);this.code=code;}}
const fail=code=>{throw new StandingEpochRuntimeError(code);};
function capture(record,keys){
  if(!record||typeof record!=='object'||types.isProxy(record)||Object.getPrototypeOf(record)!==Object.prototype)return fail('CONFIG');
  const d=Object.getOwnPropertyDescriptors(record);
  if(Reflect.ownKeys(d).length!==keys.length)return fail('CONFIG');
  const result={};for(const key of keys){if(!d[key]||!Object.hasOwn(d[key],'value'))return fail('CONFIG');result[key]=d[key].value;}
  return Object.freeze(result);
}
function directory(path){
  if(!isAbsolute(path)||resolve(path)!==path)return fail('DIRECTORY');
  for(let at=path;;at=dirname(at)){
    const s=lstatSync(at,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())return fail('DIRECTORY');
    if(dirname(at)===at)break;
  }
  if(realpathSync(path)!==path)return fail('DIRECTORY');
  const s=lstatSync(path,{bigint:true});if(s.ino<=0n)return fail('DIRECTORY');return s;
}
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function fileNew(path,value){
  const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>32768)return fail('RECORD');
  let fd;
  try{
    fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
    const own=fstatSync(fd,{bigint:true});if(!own.isFile()||own.nlink!==1n)return fail('RECORD');
    writeFileSync(fd,bytes);fsyncSync(fd);
    const after=lstatSync(path,{bigint:true});if(!after.isFile()||after.isSymbolicLink()||!same(own,after))return fail('RECORD');
  }finally{if(fd!==undefined)closeSync(fd);}
}
async function finalFileNew(path,value){
  const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>32768)return fail('RECORD');
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try{
    const own=await file.stat({bigint:true});if(!own.isFile()||own.nlink!==1n)return fail('RECORD');
    await file.writeFile(bytes);await file.sync();
    const after=await lstat(path,{bigint:true});if(!after.isFile()||after.isSymbolicLink()||!same(own,after))return fail('RECORD');
  }finally{await file.close();}
}
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
async function readFixedFile(path){
  const before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>32768n)return fail('RECORD');
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await file.stat({bigint:true});if(stamp(opened)!==stamp(before))return fail('RECORD');
    const bytes=Buffer.alloc(Number(opened.size)),read=await file.read(bytes,0,bytes.length,0);
    if(read.bytesRead!==bytes.length||stamp(await file.stat({bigint:true}))!==stamp(opened)||stamp(await lstat(path,{bigint:true}))!==stamp(opened))return fail('RECORD');
    const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))return fail('RECORD');
    const value=JSON.parse(text);if(JSON.stringify(value)+'\n'!==text)return fail('RECORD');return value;
  }finally{await file.close();}
}
function realStore(parent){
  const parentIdentity=directory(parent),attempts=new Map();
  const check=path=>{
    if(dirname(path)!==parent||!TOKEN.test(path.slice(parent.length+1))||!same(directory(parent),parentIdentity))return fail('DIRECTORY');
    const identity=attempts.get(path);if(!identity||!same(directory(path),identity))return fail('DIRECTORY');
  };
  return Object.freeze({
    reserve(path,intent){
      if(dirname(path)!==parent||!same(directory(parent),parentIdentity))return fail('DIRECTORY');
      mkdirSync(path,{mode:0o700});attempts.set(path,directory(path));check(path);fileNew(resolve(path,'intent.json'),intent);check(path);
    },
    controller(path,record){check(path);fileNew(resolve(path,'controller.json'),record);check(path);},
    async finish(path,record){check(path);await finalFileNew(resolve(path,'actual.json'),record);check(path);attempts.delete(path);},
    async verify(path){
      if(dirname(path)!==parent||!TOKEN.test(path.slice(parent.length+1))||!same(directory(parent),parentIdentity))return fail('DIRECTORY');
      const identity=directory(path),intent=await readFixedFile(resolve(path,'intent.json')),actual=await readFixedFile(resolve(path,'actual.json'));
      if(!same(directory(parent),parentIdentity)||!same(directory(path),identity))return fail('DIRECTORY');return {intent,actual};
    },
  });
}
const settled=value=>value?.resourcesSettled===true&&value.persisted===true&&value.replacementReady===true;
const REQUEST=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ANALYSIS_NAMES=['neurobro_analysis_material','neurobro_analysis_notes','neurobro_analysis_commit'];
function nativeBinding(value){
  const v=capture(value,['epochId','requestRef','purpose']);
  if(typeof v.epochId!=='string'||!TOKEN.test(v.epochId)||typeof v.requestRef!=='string'||!REQUEST.test(v.requestRef)||v.purpose!=='history-analysis')return fail('BINDING');return v;
}
const settlement=binding=>Object.freeze({schema:'standing-analysis-owner-settlement-v1',nativeBinding:binding,resourcesSettled:true,persisted:true,replacementReady:true,modelOutcome:'not-proven'});

/** No model process starts until connection.prepare(). No selected turn is
 * retried here. Parent must not replay consumed requests on a new connection.
 * Injected ports are test-only; production supplies its admitted parent ACL. */
export function prepareStandingEpochRuntime(input,ports={}){
  const sessionMode=snapshotEpochSessionModeFromInput(input),scoped=sessionMode!==undefined,mode=scoped?{sessionMode}:{};
  const {sources:sourceInput,pins:pinInput,attemptParent,workerToken,createWire,openSession,isTurnNotAdmitted=()=>false}=input??{};
  const sources=capture(sourceInput,Object.keys(SOURCE_NAMES)),pins=capture(pinInput,Object.keys(SOURCE_NAMES));
  if(!isAbsolute(attemptParent)||resolve(attemptParent)!==attemptParent||!TOKEN.test(workerToken)||typeof createWire!=='function'||typeof openSession!=='function'||typeof isTurnNotAdmitted!=='function')return fail('CONFIG');
  preparePacket({sources,pins,token:'0'.repeat(32),...mode});
  const storePort=ports.store??realStore(attemptParent),spawnPort=ports.spawn??spawn,openOwner=ports.openOwner??startOwnedEpoch;
  const reserve=storePort.reserve?.bind(storePort),controller=storePort.controller?.bind(storePort),finish=storePort.finish?.bind(storePort);
  if([reserve,controller,finish,spawnPort,openOwner].some(p=>typeof p!=='function'))return fail('CONFIG');
  const env=Object.freeze({SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:'C:/Windows/System32'});
  let blocked=false,lease=null,attemptCount=0;
  async function verifyAnalysisSettlement(value){
    if(!scoped)return fail('MODE');const binding=nativeBinding(value);
    if(typeof storePort.verify!=='function')return fail('RECORD');
    const record=await storePort.verify(resolve(attemptParent,binding.epochId));
    const pair=capture(record,['intent','actual']);
    const intent=capture(pair.intent,['operation','workerToken','token','sourceSha256','sources','model','effort','threadLimit','turnLimit','sessionMode']);
    if(intent.operation!=='standing-native-epoch-v1'||typeof intent.workerToken!=='string'||!TOKEN.test(intent.workerToken)||intent.token!==binding.epochId||
       typeof intent.sourceSha256!=='string'||!/^[a-f0-9]{64}$/u.test(intent.sourceSha256)||intent.sessionMode!==sessionMode||
       intent.model!=='gpt-6-astra'||intent.effort!=='medium'||intent.threadLimit!==2||intent.turnLimit!==16)return fail('RECORD');
    const oldPins=capture(intent.sources,Object.keys(SOURCE_NAMES));if(Object.values(oldPins).some(pin=>typeof pin!=='string'||!/^[a-f0-9]{64}$/u.test(pin)))return fail('RECORD');
    const actual=normalizeEpochOwnerRecord(pair.actual,binding.epochId);
    if(!actual.resourcesSettled||!actual.replacementReady||!actual.diagnostics)return fail('SETTLEMENT_UNKNOWN');
    for(const receipt of [actual.diagnostics.epoch,actual.diagnostics.supervisor?.client]){
      if(receipt!=null&&receipt.schema!=='decadans.rm0032.standing-scoped-epoch.v1')return fail('MODE');
    }
    // Request membership comes from the encrypted lease-produced reservation.
    // This record proves its OWNER settled, not request dispatch or observation.
    return settlement(binding);
  }
  function openConnection(input){
    if(blocked||lease)return fail('STATE');
    let extraTools;try{extraTools=snapshotEpochExtraToolsFromInput(input);}catch{return fail('CONFIG');}
    if(scoped&&((extraTools?.length??0)+4>32||extraTools?.some(tool=>ANALYSIS_NAMES.includes(tool.name))))return fail('CONFIG');
    const signal=input?.signal,historyPort=input?.history,historyCall=historyPort?.call;
    if(!(signal instanceof AbortSignal)||signal.aborted||typeof historyCall!=='function')return fail('CONFIG');
    const history=Object.freeze({call:(...args)=>Reflect.apply(historyCall,historyPort,args)});
    const control=new AbortController(),seen=new Set(),releasedAnalysis=new Set();let owner=null,opening=null,closing=null,busy=false,pending=null,attempt=null,localFault=false,failedTurn=false;
    let analysisLease=null,analysisBinding=null,failedAnalysisTurn=false,conversationRestorationPending=false;
    const route=()=>{
      if(!analysisBinding||analysisBinding.revoked||!analysisLease||analysisLease.closed||control.signal.aborted||signal.aborted)return fail('ANALYSIS_SCOPE');
      return analysisBinding;
    };
    const analysisTools=Object.freeze(ANALYSIS_NAMES.map(name=>Object.freeze({name,call:async(args,scope)=>{
      const selected=route();if(scope.requestRef!==selected.nativeBinding.requestRef)return fail('ANALYSIS_SCOPE');
      return selected.handlers.find(tool=>tool.name===name).call(args,scope);
    }})));
    const onToolResultSent=async event=>{
      if(event.purpose==='conversation')return;
      // A completed write must acknowledge its original handler even if STOP
      // revoked subsequent calls while that write was pending.
      const selected=analysisBinding;
      if(!selected||event.purpose!=='history-analysis'||event.requestRef!==selected.nativeBinding.requestRef)return fail('ANALYSIS_SCOPE');
      await selected.shown(Object.freeze({requestRef:event.requestRef,callRef:event.callRef,name:event.name,result:event.result}));
    };
    lease={};const ownLease=lease;
    function exclusive(operation){
      if(busy||analysisLease||closing||blocked||signal.aborted)return Promise.reject(new StandingEpochRuntimeError('STATE'));
      busy=true;return Promise.resolve().then(()=>{if(closing||blocked||signal.aborted)return fail('STATE');return operation();}).finally(()=>{busy=false;});
    }
    async function settleOwner(){
      if(opening)try{await opening;}catch{}
      const selectedOwner=owner,selectedAttempt=attempt;
      if(!selectedAttempt)return {resourcesSettled:true,persisted:true,replacementReady:true};
      if(!selectedOwner){blocked=true;return {resourcesSettled:false,persisted:selectedAttempt.record!==null,replacementReady:false};}
      try{
        const result=await selectedOwner.close();
        if(!settled(result)||!selectedAttempt.record?.resourcesSettled||!selectedAttempt.record?.replacementReady||localFault)blocked=true;
        return {resourcesSettled:result.resourcesSettled===true,persisted:result.persisted===true&&selectedAttempt.record!==null,replacementReady:!blocked&&settled(result)};
      }catch{blocked=true;return {resourcesSettled:false,persisted:selectedAttempt.record!==null,replacementReady:false};}
    }
    function close(){
      if(!closing){
        if(analysisBinding)analysisBinding.revoked=true;
        control.abort();
        closing=(async()=>{const result=await settleOwner();signal.removeEventListener('abort',abort);if(lease===ownLease&&result.replacementReady)lease=null;return Object.freeze({resourcesSettled:result.resourcesSettled,persisted:result.persisted});})();
      }
      return closing;
    }
    const abort=()=>{void close();};signal.addEventListener('abort',abort,{once:true});
    async function createOwner(){
      const token=randomBytes(16).toString('hex'),path=resolve(attemptParent,token),packet=preparePacket({sources,pins,token,...mode});
      const ownedAttempt={token,path,record:null};attempt=ownedAttempt;attemptCount++;
      try{
        reserve(path,{operation:'standing-native-epoch-v1',workerToken,token,sourceSha256:packet.sourceSha256,sources:packet.pins,model:'gpt-6-astra',effort:'medium',threadLimit:scoped?2:1,turnLimit:16,...mode});
        if(control.signal.aborted)return fail('STOPPED');
        const value=await openOwner({epochId:token,bootstrap:frameSource(packet.source),signal:control.signal,history,createWire,openSession,
          ...(extraTools===undefined?{}:{extraTools}),
          ...mode,...(scoped?{analysisTools,onToolResultSent}:{}),
          spawnChild:()=>{
            const child=spawnPort(WSL,['--distribution','DecadansNeurobro','--user','root','--exec','/usr/bin/python3.12','-I','-S','-B','-c',packet.bootstrap,'decadans-standing-token='+token],
              {windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...env}});
            try{
              if(!Number.isSafeInteger(child?.pid)||child.pid<=0)return fail('CONTROLLER');
              controller(path,{version:'standing-controller-v1',workerToken,token,pid:child.pid});
            }catch{
              // Return the exact spawned child before scheduling cancellation:
              // owner must install listeners and retain the actual handle.
              localFault=true;blocked=true;queueMicrotask(()=>control.abort());
            }
            return child;
          },
          recordFinal:async(record,timeoutMs)=>{
            if(!(timeoutMs>0&&timeoutMs<=1000))return fail('RECORD');
            const fixed=normalizeEpochOwnerRecord(record,token);await finish(path,fixed);ownedAttempt.record=fixed;
          }});
        owner=value;
        if(scoped)conversationRestorationPending=true;
        if(localFault||control.signal.aborted){await value.close();return fail('STOPPED');}
        return value;
      }catch{
        if(!owner||localFault)blocked=true;
        throw new StandingEpochRuntimeError(localFault?'CONTROLLER_UNKNOWN':control.signal.aborted&&owner?'PREPARE_STOPPED':'PREPARE_UNKNOWN');
      }
    }
    return Object.freeze({
      prepare:()=>exclusive(async()=>{
        if(pending!==null)return fail('RELEASE_REQUIRED');
        if(owner&&owner.admission()==='ready'&&seen.size<SOFT_EPOCH_TURNS)return Object.freeze({restoration:scoped&&conversationRestorationPending});
        if(owner){
          const proof=await settleOwner();if(!proof.replacementReady)return fail('SETTLEMENT_UNKNOWN');
          // Parent's durable question admission prevents cross-epoch replay.
          // This bounded ledger guards only the current native thread.
          owner=null;attempt=null;seen.clear();releasedAnalysis.clear();
        }
        if(closing||control.signal.aborted)return fail('STOPPED');
        opening=createOwner();try{await opening;}finally{opening=null;}
        return Object.freeze({restoration:true});
      }),
      turn:(requestRef,conversation,images)=>exclusive(async()=>{
        if(!owner||pending!==null)return fail('PREPARE_REQUIRED');
        if(typeof requestRef!=='string'||seen.has(requestRef)||seen.size>=16)return fail('REQUEST');
        const admission=owner.admission();
        if(admission==='rotate'||seen.size>=SOFT_EPOCH_TURNS)return Object.freeze({kind:'not-admitted',reason:'prepare'});
        if(admission!=='ready')return fail('PREPARE_REQUIRED');
        seen.add(requestRef);pending=requestRef;
        try{
          const result=await (scoped?owner.turnConversation(requestRef,conversation,images):owner.turn(requestRef,conversation,images));
          if(scoped&&(result.kind==='text'||result.kind==='image'))conversationRestorationPending=false;
          return result;
        }
        catch(error){
          if(isTurnNotAdmitted(error)!==true){failedTurn=true;throw error;}
          // Source-branded proof, never an arbitrary SESSION_LIMIT or error name.
          // Next prepare must still settle and persist this old owner before reuse.
          pending=null;seen.delete(requestRef);
          const proof=await settleOwner();if(!proof.replacementReady)return fail('SETTLEMENT_UNKNOWN');
          owner=null;attempt=null;seen.clear();releasedAnalysis.clear();
          return Object.freeze({kind:'not-admitted',reason:'limit'});
        }
      }),
      release:(requestRef,delivery)=>exclusive(async()=>{
        if(!owner||pending!==requestRef||!['verified','not-sent','unknown'].includes(delivery))return fail('RELEASE_REQUIRED');
        await (scoped?owner.releaseConversation(requestRef,delivery):owner.release(requestRef,delivery));pending=null;
      }),
      ...(scoped?{
        verifyAnalysisSettlement,
        verifyAnalysisReady(value){
          let binding;try{binding=nativeBinding(value);}catch(error){return Promise.reject(error);}
          return exclusive(async()=>{
            // This is readiness of the saved request's owner, not proof of
            // model observation or physical settlement of a still-warm epoch.
            let basis='released-current-owner';
            if(!owner||attempt?.token!==binding.epochId||pending!==null||!releasedAnalysis.has(binding.requestRef)||owner.admission()!=='ready'){
              await verifyAnalysisSettlement(binding);basis='persisted-owner-settlement';
            }
            if(closing||blocked||signal.aborted||control.signal.aborted)return fail('STATE');
            return Object.freeze({schema:'standing-analysis-owner-ready-v1',nativeBinding:binding,basis,modelOutcome:'not-proven'});
          });
        },
        async acquireAnalysisAdmission(requestRef,previousValue){
          if(typeof requestRef!=='string'||!REQUEST.test(requestRef)||seen.has(requestRef)||busy||analysisLease||closing||blocked||signal.aborted||control.signal.aborted||
             !owner||!attempt||pending!==null||owner.admission()!=='ready'||seen.size>=SOFT_EPOCH_TURNS)return fail('ANALYSIS_ADMISSION');
          const previous=previousValue===undefined?undefined:nativeBinding(previousValue);
          const selectedOwner=owner,selectedAttempt=attempt,binding=nativeBinding({epochId:attempt.token,requestRef,purpose:'history-analysis'});
          const held={closed:false,phase:'unused',active:null,closing:null,settling:null};analysisLease=held;
          const guard=()=>{
            if(held.closed||held.closing||held.settling||analysisLease!==held||owner!==selectedOwner||attempt!==selectedAttempt||closing||blocked||signal.aborted||control.signal.aborted)return fail('ANALYSIS_ADMISSION');
          };
          const invoke=operation=>{
            if(held.active)return Promise.reject(new StandingEpochRuntimeError('STATE'));
            const actual=Promise.resolve().then(operation);held.active=actual;
            void actual.finally(()=>{if(held.active===actual)held.active=null;}).catch(()=>{});return actual;
          };
          const abortAndJoin=()=>{
            if(held.closed)return Promise.reject(new StandingEpochRuntimeError('ANALYSIS_ADMISSION'));
            if(analysisBinding)analysisBinding.revoked=true;
            return held.settling??=(async()=>{
              const proof=await settleOwner();
              if(!proof.replacementReady||!selectedAttempt.record?.resourcesSettled||!selectedAttempt.record?.replacementReady)return fail('SETTLEMENT_UNKNOWN');
              if(held.active)await held.active.catch(()=>{});
              if(owner===selectedOwner){owner=null;attempt=null;pending=null;seen.clear();releasedAnalysis.clear();}
              analysisBinding=null;held.phase='settled';return settlement(binding);
            })();
          };
          const releaseHeld=()=>held.closing??=(async()=>{
            try{
              if(held.active||!['unused','released','settled'].includes(held.phase))await abortAndJoin();
              else if(held.settling)await held.settling;
              if(held.phase==='released')analysisBinding=null;
            }finally{held.closed=true;if(analysisLease===held)analysisLease=null;}
          })();
          try{
            if(previous&&!(previous.epochId===selectedAttempt.token&&releasedAnalysis.has(previous.requestRef)))await verifyAnalysisSettlement(previous);
            guard();
          }catch(error){held.closed=true;if(analysisLease===held)analysisLease=null;throw error;}
          return Object.freeze({nativeBinding:binding,
            turnAnalysis:(ref,body,callbacks)=>{
              let captured;try{captured=snapshotEpochAnalysisCallbacks(callbacks);}catch{return Promise.reject(new StandingEpochRuntimeError('CONFIG'));}
              return invoke(async()=>{
                guard();if(held.phase!=='unused'||ref!==requestRef||pending!==null||owner.admission()!=='ready'||seen.size>=SOFT_EPOCH_TURNS)return fail('ANALYSIS_ADMISSION');
                held.phase='turn';seen.add(requestRef);pending=requestRef;
                analysisBinding={nativeBinding:binding,handlers:captured.analysisTools,shown:captured.onToolResultSent,revoked:false};
                try{const result=await selectedOwner.turnAnalysis(requestRef,body);held.phase='completed';return result;}
                catch(error){failedAnalysisTurn=true;held.phase='failed';throw error;}
              });
            },
            releaseAnalysis:ref=>invoke(async()=>{
              guard();if(ref!==requestRef||held.phase!=='completed'||pending!==requestRef)return fail('RELEASE_REQUIRED');
              try{await selectedOwner.releaseAnalysis(ref);pending=null;held.phase='released';releasedAnalysis.add(ref);}
              catch(error){failedAnalysisTurn=true;held.phase='failed';throw error;}
            }),
            abortAndJoin,close:releaseHeld,
          });
        },
      }:{}),
      close,
      state:()=>Object.freeze({blocked,closed:!!closing,busy:busy||analysisLease!==null,prepared:!!owner,pendingRelease:pending!==null,failedTurn,...(scoped?{failedAnalysisTurn}:{})}),
    });
  }
  return Object.freeze({openConnection,...(scoped?{verifyAnalysisSettlement}:{}),state:()=>Object.freeze({blocked,connectionOpen:lease!==null,attempts:attemptCount})});
}
