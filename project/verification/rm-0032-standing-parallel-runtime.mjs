// Opt-in pool runtime: one persisted owner/relay, independent foreground and
// analysis lanes. Acquiring a lane never dispatches a model request.
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isAbsolute,resolve} from 'node:path';
import {types} from 'node:util';
import {preparePacket,frameSource,SOURCE_NAMES,PARALLEL_SOURCE_NAMES} from './rm-0032-standing-epoch-host.mjs';
import {snapshotEpochExtraToolsFromInput,snapshotEpochSessionModeFromInput,snapshotEpochParallelOptions,snapshotEpochAnalysisCallbacks,startOwnedEpoch} from './rm-0032-standing-epoch-owner.mjs';
import {normalizeEpochOwnerRecord} from './rm-0032-standing-epoch-receipt.mjs';
import {createStandingEpochRecordStore,COMMUNITY_ASSESSMENT_TIMEOUT_MS} from './rm-0032-standing-epoch-runtime.mjs';
import {readStandingEpochRecovery} from './rm-0032-standing-epoch-recovery.mjs';

const TOKEN=/^[a-f0-9]{32}$/u,REF=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,HASH=/^[a-f0-9]{64}$/u;
const NAMES=['neurobro_analysis_material','neurobro_analysis_notes','neurobro_analysis_commit'];
const MODE='standing-parallel-epoch-v1';
export class StandingParallelRuntimeError extends Error{constructor(code){super('STANDING_PARALLEL_RUNTIME_'+code);this.code=code;}}
const fail=code=>{throw new StandingParallelRuntimeError(code);};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function record(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return fail('CONFIG');
  const fields=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(fields).length!==keys.length)return fail('CONFIG');
  const out={};for(const key of keys){if(!fields[key]||!Object.hasOwn(fields[key],'value'))return fail('CONFIG');out[key]=fields[key].value;}
  return Object.freeze(out);
}
function profileOf(input){
  if(!input||types.isProxy(input))return fail('CONFIG');
  const d=Object.getOwnPropertyDescriptor(input,'workProfile');if(!d)return undefined;
  if(!Object.hasOwn(d,'value')||!['team-assistant','community-team'].includes(d.value))return fail('CONFIG');return d.value;
}
function bindingOf(value,purpose='history-analysis'){
  const v=record(value,['epochId','requestRef','purpose']);
  if(typeof v.epochId!=='string'||!TOKEN.test(v.epochId)||typeof v.requestRef!=='string'||!REF.test(v.requestRef)||v.purpose!==purpose)return fail('BINDING');return v;
}
function workOf(value){const v=record(value,['taskRef','planRef','workRef']);if(Object.values(v).some(x=>typeof x!=='string'||!REF.test(x)))return fail('BINDING');return v;}
const settled=v=>v?.resourcesSettled===true&&v.persisted===true&&v.replacementReady===true;
const proof=b=>Object.freeze({schema:b.purpose==='history-analysis'?'standing-analysis-owner-settlement-v1':'standing-community-assessment-owner-settlement-v1',nativeBinding:b,resourcesSettled:true,persisted:true,replacementReady:true,modelOutcome:'not-proven'});

export function prepareStandingParallelRuntime(input,ports={}){
  if(snapshotEpochSessionModeFromInput(input)!==MODE)return fail('MODE');
  const parallelOptions=snapshotEpochParallelOptions(input),workProfile=profileOf(input),profile=workProfile===undefined?{}:{workProfile};
  const mode={sessionMode:MODE,parallelOptions},keys=Object.keys({...SOURCE_NAMES,...PARALLEL_SOURCE_NAMES});
  const {attemptParent,workerToken,createWire,openSession,isTurnNotAdmitted=()=>false,isWorkerTurnNotAdmitted}=input;
  const sources=record(input.sources,keys),pins=record(input.pins,keys);
  if(typeof attemptParent!=='string'||!isAbsolute(attemptParent)||resolve(attemptParent)!==attemptParent||typeof workerToken!=='string'||!TOKEN.test(workerToken)||[createWire,openSession,isTurnNotAdmitted,isWorkerTurnNotAdmitted].some(x=>typeof x!=='function'))return fail('CONFIG');
  preparePacket({sources,pins,token:'0'.repeat(32),...mode,...profile});
  const store=ports.store??createStandingEpochRecordStore(attemptParent),spawnPort=ports.spawn??spawn,openOwner=ports.openOwner??startOwnedEpoch;
  const reserve=store.reserve?.bind(store),controller=store.controller?.bind(store),finish=store.finish?.bind(store),verify=store.verify?.bind(store);
  if([reserve,controller,finish,spawnPort,openOwner].some(x=>typeof x!=='function'))return fail('CONFIG');
  const assessmentTimeoutMs=ports.communityAssessmentTimeoutMs??COMMUNITY_ASSESSMENT_TIMEOUT_MS;
  if(!Number.isSafeInteger(assessmentTimeoutMs)||assessmentTimeoutMs<1||assessmentTimeoutMs>COMMUNITY_ASSESSMENT_TIMEOUT_MS)return fail('CONFIG');
  const env=Object.freeze({SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:'C:/Windows/System32'});
  let blocked=false,connectionLease=null,attempts=0;
  async function recoveryFor(binding){
    try{return await readStandingEpochRecovery({directory:resolve(attemptParent,binding.epochId),epochId:binding.epochId});}
    catch{return fail('PRIOR_OWNER_UNAVAILABLE');}
  }
  async function verifyOwner(value,purpose){
    const binding=bindingOf(value,purpose);if(!verify)return fail('RECORD');
    let saved,recovery;
    try { saved=await verify(resolve(attemptParent,binding.epochId)); }
    catch(error) {
      // Missing prior evidence is not evidence of settlement. Keep that task
      // blocked without turning absence into replay or a new model admission.
      if(!error || types.isProxy(error) || Object.getOwnPropertyDescriptor(error,'code')?.value!=='ENOENT')throw error;
      // A separate recovery receipt proves physical resource settlement only.
      // It never rewrites the missing native outcome or grants request replay.
      recovery=await recoveryFor(binding);
      if(!recovery)return fail('PRIOR_OWNER_UNAVAILABLE');
      saved={intent:recovery.intent,actual:null};
    }
    const pair=record(saved,['intent','actual']);
    const d=Object.getOwnPropertyDescriptor(pair.intent,'sessionMode');if(!d||!Object.hasOwn(d,'value'))return fail('RECORD');
    const parallel=d.value===MODE,v2=d.value==='standing-scoped-epoch-v2';
    if(!parallel&&!v2&&d.value!=='standing-scoped-epoch-v1'||purpose==='community-assessment'&&!parallel&&!v2)return fail('MODE');
    const intent=record(pair.intent,['operation','workerToken','token','sourceSha256','sources','model','effort','threadLimit','turnLimit','sessionMode',...(parallel?['parallelOptions']:[]),...Object.keys(profile)]);
    const savedOptions=parallel?snapshotEpochParallelOptions(intent):null;
    if(intent.operation!=='standing-native-epoch-v1'||!TOKEN.test(intent.workerToken)||intent.token!==binding.epochId||!HASH.test(intent.sourceSha256)||intent.model!=='gpt-6-astra'||intent.effort!=='medium'||intent.turnLimit!==16||intent.workProfile!==workProfile||intent.threadLimit!==(parallel?1+savedOptions.analysisWorkers+Number(savedOptions.communityAssessment):v2?3:2)||purpose==='community-assessment'&&parallel&&!savedOptions.communityAssessment)return fail('RECORD');
    const oldPins=record(intent.sources,parallel?keys:Object.keys(SOURCE_NAMES));if(Object.values(oldPins).some(x=>typeof x!=='string'||!HASH.test(x)))return fail('RECORD');
    if(recovery)return proof(binding);
    const actual=normalizeEpochOwnerRecord(pair.actual,binding.epochId);
    if(!actual.resourcesSettled||!actual.replacementReady){
      recovery=await recoveryFor(binding);
      if(recovery)return proof(binding);
      return fail('PRIOR_OWNER_UNAVAILABLE');
    }
    if(!actual.diagnostics)return fail('SETTLEMENT_UNKNOWN');
    const schema=parallel?'decadans.rm0032.standing-parallel-epoch.v1':'decadans.rm0032.standing-scoped-epoch.'+(v2?'v2':'v1');
    for(const r of [actual.diagnostics.epoch,actual.diagnostics.supervisor?.client])if(r!=null&&(r.schema!==schema||parallel&&r.pool!=null&&r.pool.epochRef!==binding.epochId))return fail('MODE');
    return proof(binding);
  }
  const verifyAnalysisSettlement=value=>verifyOwner(value,'history-analysis');
  const verifyCommunityAssessmentSettlement=value=>verifyOwner(value,'community-assessment');
  function openConnection(value){
    if(blocked||connectionLease)return fail('STATE');if(profileOf(value)!==workProfile)return fail('CONFIG');
    const extraTools=snapshotEpochExtraToolsFromInput(value),signal=value.signal,historyPort=value.history,historyCall=historyPort?.call;
    if((extraTools?.length??0)+4>32||extraTools?.some(t=>NAMES.includes(t.name))||!(signal instanceof AbortSignal)||signal.aborted||typeof historyCall!=='function')return fail('CONFIG');
    const history=Object.freeze({call:(...args)=>Reflect.apply(historyCall,historyPort,args)}),control=new AbortController();
    const selectedLease={};connectionLease=selectedLease;
    const lanes=new Map(),routes=new Map(),seen=new Set(),released=new Map(),workReleases=new Map();
    let owner=null,attempt=null,opening=null,preparing=null,closing=null,settling=null,retiredReady=false,foregroundBusy=false,foregroundJob=null,foregroundKind=null,rotationPending=false,pending=null,assessment=null,restoration=false,localFault=false,failedTurn=false,failedAnalysisTurn=false,failedCommunityAssessmentTurn=false;
    let pendingReleased=Promise.resolve(),resolvePendingReleased=()=>{},foregroundObserved=false;
    // Match the native shared budget's one reserved foreground turn. A queued
    // foreground call is insufficient: its admission/dispatch may not yet have
    // reached native while a background worker is already being dispatched.
    const backgroundLimit=()=>foregroundObserved?16:15;
    const live=()=>{if(closing||settling||blocked||signal.aborted||control.signal.aborted)return fail('STATE');};
    const track=(held,operation)=>{
      const p=Promise.resolve().then(operation);held.callbacks.add(p);void p.finally(()=>held.callbacks.delete(p)).catch(()=>{});return p;
    };
    const route=ref=>{const held=routes.get(ref);if(!held||held.closed||held.revoked||!['turn','completed'].includes(held.phase)||control.signal.aborted||signal.aborted)return fail('ANALYSIS_SCOPE');return held;};
    const analysisTools=Object.freeze(NAMES.map(name=>Object.freeze({name,call:(args,scope)=>{
      const held=route(scope?.requestRef);return track(held,()=>held.handlers.find(t=>t.name===name).call(args,scope));
    }})));
    const onToolResultSent=event=>{
      if(event.purpose!=='history-analysis')return;
      const held=route(event.requestRef);if(event.workerId!==held.workerId)return fail('ANALYSIS_SCOPE');
      // Native routing fields authenticate the selected lane, then the material
      // runtime receives its established exact four-field exposure contract.
      return track(held,()=>held.shown(Object.freeze({requestRef:event.requestRef,callRef:event.callRef,name:event.name,result:event.result})));
    };
    const foreground=(operation,kind='turn')=>{
      // New foreground work joins background rotation before taking the busy
      // latch. An existing delivery can still release and unblock rotation.
      if(preparing&&kind!=='release')return preparing.then(()=>foreground(operation,kind));
      try{live();if(foregroundBusy)return fail('STATE');}catch(e){return Promise.reject(e);}
      foregroundBusy=true;foregroundKind=kind;
      const job=Promise.resolve().then(()=>{if(control.signal.aborted||signal.aborted)return fail('STOPPED');live();return operation();}).finally(()=>{foregroundBusy=false;foregroundJob=null;foregroundKind=null;});
      foregroundJob=job;return job;
    };
    const clearPending=()=>{pending=null;resolvePendingReleased();resolvePendingReleased=()=>{};pendingReleased=Promise.resolve();};
    const abortable=async operation=>{
      let onAbort;
      try{const aborted=new Promise((_resolve,reject)=>{onAbort=()=>reject(new StandingParallelRuntimeError('STOPPED'));control.signal.addEventListener('abort',onAbort,{once:true});if(control.signal.aborted)onAbort();});
        return await Promise.race([operation,aborted]);
      }finally{control.signal.removeEventListener('abort',onAbort);}
    };
    async function settleOwner(){
      if(settling)return settling;
      settling=(async()=>{
        if(opening)await opening.catch(()=>{});
        if(!attempt)return {resourcesSettled:!blocked,persisted:!blocked,replacementReady:!blocked};
        if(!owner){blocked=true;return {resourcesSettled:false,persisted:false,replacementReady:false};}
        for(const lane of lanes.values())lane.revoked=true;
        let result;try{result=await owner.close();}catch{blocked=true;return {resourcesSettled:false,persisted:false,replacementReady:false};}
        if(!settled(result)||!attempt.record?.resourcesSettled||!attempt.record?.replacementReady||localFault){blocked=true;return {resourcesSettled:result?.resourcesSettled===true,persisted:result?.persisted===true,replacementReady:false};}
        await Promise.allSettled([...lanes.values()].flatMap(lane=>[...(lane.active?[lane.active]:[]),...lane.callbacks]));
        retiredReady=true;return {resourcesSettled:true,persisted:true,replacementReady:true};
      })();return settling;
    }
    function resetOwner(){owner=null;attempt=null;settling=null;retiredReady=false;foregroundObserved=false;clearPending();seen.clear();released.clear();routes.clear();}
    function releaseRetiredOwner(){if(retiredReady&&!lanes.size&&!assessment&&!closing)resetOwner();}
    function close(){
      if(!closing){control.abort();closing=(async()=>{
        const result=await settleOwner();signal.removeEventListener('abort',abort);
        if(result.replacementReady&&connectionLease===selectedLease)connectionLease=null;
        return Object.freeze({resourcesSettled:result.resourcesSettled,persisted:result.persisted});
      })();}return closing;
    }
    const abort=()=>{void close();};signal.addEventListener('abort',abort,{once:true});
    async function createOwner(){
      const token=randomBytes(16).toString('hex'),path=resolve(attemptParent,token),packet=preparePacket({sources,pins,token,...mode,...profile});
      const ownedAttempt={token,path,record:null};attempt=ownedAttempt;attempts++;
      try{
        reserve(path,{operation:'standing-native-epoch-v1',workerToken,token,sourceSha256:packet.sourceSha256,sources:packet.pins,model:'gpt-6-astra',effort:'medium',threadLimit:1+parallelOptions.analysisWorkers+Number(parallelOptions.communityAssessment),turnLimit:16,...mode,...profile});
        if(control.signal.aborted)return fail('STOPPED');
        const result=await openOwner({epochId:token,bootstrap:frameSource(packet.source),signal:control.signal,history,createWire,openSession,isWorkerTurnNotAdmitted,...mode,...(extraTools===undefined?{}:{extraTools}),analysisTools,onToolResultSent,
          spawnChild:()=>{
            const child=spawnPort('C:/Program Files/WSL/wsl.exe',['--distribution','DecadansNeurobro','--user','root','--exec','/usr/bin/python3.12','-I','-S','-B','-c',packet.bootstrap,'decadans-standing-token='+token],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...env}});
            try{if(!Number.isSafeInteger(child?.pid)||child.pid<=0)return fail('CONTROLLER');controller(path,{version:'standing-controller-v1',workerToken,token,pid:child.pid});}
            catch{localFault=true;blocked=true;queueMicrotask(()=>control.abort());}return child;
          },
          recordFinal:async(record,timeoutMs)=>{if(!(timeoutMs>0&&timeoutMs<=1000))return fail('RECORD');const fixed=normalizeEpochOwnerRecord(record,token);await finish(path,fixed);ownedAttempt.record=fixed;},
        });owner=result;restoration=true;
        if(localFault||control.signal.aborted){await result.close();return fail('STOPPED');}
      }catch{if(!owner||localFault)blocked=true;return fail(localFault?'CONTROLLER_UNKNOWN':'PREPARE_UNKNOWN');}
    }
    const analysisReady=()=>owner&&seen.size+parallelOptions.analysisWorkers<=backgroundLimit()&&owner.analysisWorkerIds().filter(id=>!lanes.has(id)&&owner.admission(id)==='ready').length===parallelOptions.analysisWorkers;
    function prepareOwner(analysisOnly,previousForRotation){
      // A retry can arrive after the admitted transition began persisting the
      // old owner's close. It joins that transition without acquiring a lane
      // during settlement. Unrelated settlement and STOP remain inadmissible.
      if(previousForRotation!==undefined&&preparing){
        if(closing||blocked||signal.aborted||control.signal.aborted)return Promise.reject(new StandingParallelRuntimeError('STATE'));
        return preparing.then(()=>prepareOwner(analysisOnly,previousForRotation));
      }
      try{live();if(!analysisOnly&&pending!==null)return Promise.reject(new StandingParallelRuntimeError('RELEASE_REQUIRED'));}
      catch(e){return Promise.reject(e);}
      if(preparing)return preparing.then(()=>prepareOwner(analysisOnly,previousForRotation));
      const rotationRequired=()=>previousForRotation!==undefined&&attempt?.token===previousForRotation.epochId;
      // Concurrent retry callers share this transition. Once another caller
      // replaced the requested old epoch, do not wait for its new lease to
      // close merely to regain whole-pool readiness; acquireGroup checks each
      // caller's actual requested capacity atomically below.
      const rotationSatisfied=()=>previousForRotation!==undefined&&owner&&attempt?.token!==previousForRotation.epochId;
      const ready=rotationSatisfied()||!rotationRequired()&&(analysisOnly?analysisReady():owner&&seen.size<16&&owner.admission()==='ready');
      if(ready)return Promise.resolve(Object.freeze({restoration}));
      rotationPending=true;
      let current;
      current=Promise.resolve().then(async()=>{
        // Keep existing work on its owner. Background readiness also joins the
        // foreground response and its later delivery release before rotation.
        for(;;){
          const joins=[...lanes.values()].map(lane=>lane.done.promise);
          if(assessment)joins.push(assessment.done.promise);
          if(analysisOnly&&foregroundJob&&foregroundKind!=='prepare')joins.push(foregroundJob.catch(()=>{}));
          if(analysisOnly&&pending!==null)joins.push(pendingReleased);
          if(!joins.length)break;
          await abortable(Promise.all(joins));live();
        }
        live();
        // A busy analysis worker may have become reusable while we joined it.
        if(rotationSatisfied()||!rotationRequired()&&(analysisOnly?analysisReady():owner&&seen.size<16&&owner.admission()==='ready'))return Object.freeze({restoration});
        // Same-owner retries require a factual release after every caller and
        // callback has joined. A refused lease settles its owner when closed,
        // so it reaches this path only through persisted settlement instead.
        if(rotationRequired()&&!released.has(previousForRotation.requestRef))return fail('ANALYSIS_ADMISSION');
        if(owner){const result=await settleOwner();if(!result.replacementReady)return fail('SETTLEMENT_UNKNOWN');resetOwner();}
        if(previousForRotation)await verifyAnalysisSettlement(previousForRotation);
        live();opening=createOwner();try{await opening;}finally{opening=null;}
        return Object.freeze({restoration:true});
      }).finally(()=>{if(preparing===current){preparing=null;rotationPending=false;}});
      preparing=current;return current;
    }
    function makeAnalysis(workerId,requestRef){
      const selectedOwner=owner,selectedAttempt=attempt,nativeBinding=bindingOf({epochId:attempt.token,requestRef,purpose:'history-analysis'});
      const held={workerId,nativeBinding,phase:'unused',closed:false,revoked:false,active:null,callbacks:new Set(),closing:null,work:null,done:deferred()};
      lanes.set(workerId,held);seen.add(requestRef);
      const guard=()=>{live();if(held.closed||held.closing||held.revoked||owner!==selectedOwner||attempt!==selectedAttempt||lanes.get(workerId)!==held)return fail('ANALYSIS_ADMISSION');};
      const invoke=operation=>{if(held.active)return Promise.reject(new StandingParallelRuntimeError('STATE'));const p=Promise.resolve().then(operation);held.active=p;void p.finally(()=>{if(held.active===p)held.active=null;}).catch(()=>{});return p;};
      const abortAndJoin=async()=>{held.revoked=true;const result=await settleOwner();if(!result.replacementReady||!selectedAttempt.record?.replacementReady)return fail('SETTLEMENT_UNKNOWN');held.phase='settled';return proof(nativeBinding);};
      const closeHeld=()=>held.closing??=(async()=>{
        try{if(held.active||!['unused','released','settled'].includes(held.phase))await abortAndJoin();await Promise.all([...held.callbacks]);}
        finally{held.closed=true;routes.delete(requestRef);if(lanes.get(workerId)===held)lanes.delete(workerId);releaseRetiredOwner();held.done.resolve();}
      })();
      return Object.freeze({workerId,nativeBinding,
        turnAnalysis:(ref,body,callbacks)=>{
          let captured,work;try{captured=snapshotEpochAnalysisCallbacks(callbacks);const d=Object.getOwnPropertyDescriptor(callbacks,'work');if(!d||!Object.hasOwn(d,'value'))return Promise.reject(new StandingParallelRuntimeError('BINDING'));work=workOf(d.value);}catch(e){return Promise.reject(e);}
          return invoke(async()=>{guard();if(ref!==requestRef||held.phase!=='unused'||selectedOwner.admission(workerId)!=='ready')return fail('ANALYSIS_ADMISSION');
            held.phase='turn';held.work=work;held.handlers=captured.analysisTools;held.shown=captured.onToolResultSent;routes.set(ref,held);
            try{const result=await selectedOwner.turnAnalysis(workerId,ref,body,work);await Promise.all([...held.callbacks]);held.phase='completed';return result;}
            catch(e){held.phase=isWorkerTurnNotAdmitted(e)===true?'refused':'failed';if(held.phase==='failed')failedAnalysisTurn=true;throw e;}
          });
        },
        releaseAnalysis:ref=>invoke(async()=>{guard();if(ref!==requestRef||held.phase!=='completed')return fail('RELEASE_REQUIRED');
          try{await selectedOwner.releaseAnalysis(workerId,ref);held.phase='joining';await Promise.all([...held.callbacks]);held.phase='released';
            const witness=Object.freeze({nativeBinding,workRef:held.work.workRef});released.set(ref,witness);workReleases.set(nativeBinding.epochId+':'+ref,witness);
            // Retain recent factual releases across foreground owner rotation.
            // A missing old witness requires the separate persisted-owner path.
            while(workReleases.size>128)workReleases.delete(workReleases.keys().next().value);
          }
          catch(e){held.phase='failed';failedAnalysisTurn=true;throw e;}
        }),abortAndJoin,close:closeHeld,
      });
    }
    async function acquireGroup(requestRefs,previousValue,explicitWorkers,options){
      const requireNewEpoch=options===undefined?false:record(options,['requireNewEpoch']).requireNewEpoch;
      if(options!==undefined&&requireNewEpoch!==true)return fail('CONFIG');
      const previous=previousValue===undefined?undefined:bindingOf(previousValue);
      if(requireNewEpoch&&!previous)return fail('CONFIG');
      if(types.isProxy(requestRefs)||!Array.isArray(requestRefs)||requestRefs.length<1||requestRefs.length>parallelOptions.analysisWorkers||Reflect.ownKeys(requestRefs).length!==requestRefs.length+1)return fail('ANALYSIS_ADMISSION');
      const refs=[];for(let i=0;i<requestRefs.length;i++){const d=Object.getOwnPropertyDescriptor(requestRefs,String(i));if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string'||!REF.test(d.value)||seen.has(d.value)||refs.includes(d.value))return fail('ANALYSIS_ADMISSION');refs.push(d.value);}
      if(requireNewEpoch&&refs.includes(previous.requestRef))return fail('ANALYSIS_ADMISSION');
      if(requireNewEpoch){
        // Hold the existing preparation latch across joining and replacement.
        // Foreground delivery release remains allowed to unblock this wait.
        await prepareOwner(true,previous);
      }
      // Preparation can begin after the caller's readiness check. Join that
      // owner transition before claiming any lease, but never wait on another
      // lease that conflicts with this acquisition's requested capacity.
      if(preparing){if(owner&&(owner.analysisWorkerIds().filter(id=>!lanes.has(id)).length<refs.length||explicitWorkers?.some(id=>lanes.has(id))))return fail('ANALYSIS_ADMISSION');await preparing;}
      live();if(!owner||!attempt||opening||rotationPending||assessment?.phase==='settling'||refs.some(ref=>seen.has(ref)))return fail('ANALYSIS_ADMISSION');
      const idle=owner.analysisWorkerIds().filter(id=>!lanes.has(id));
      if(idle.length<refs.length||explicitWorkers?.some(id=>!idle.includes(id)))return fail('ANALYSIS_ADMISSION');
      // Foreground may use a remaining turn between background preparation and
      // this atomic claim. Rotate before any lease/model attempt is reserved,
      // preserving the requested references and verifying the previous owner.
      if(seen.size+refs.length>backgroundLimit()||idle.filter(id=>owner.admission(id)==='ready').length<refs.length||explicitWorkers?.some(id=>owner.admission(id)!=='ready')){
        await prepareOwner(true);live();if(!owner||!attempt||refs.some(ref=>seen.has(ref)))return fail('ANALYSIS_ADMISSION');
      }
      const available=owner.analysisWorkerIds().filter(id=>!lanes.has(id)&&owner.admission(id)==='ready');
      const workers=explicitWorkers??available.slice(0,refs.length);
      if(workers.length!==refs.length||workers.some(id=>!available.includes(id))||seen.size+refs.length>backgroundLimit())return fail('ANALYSIS_ADMISSION');
      // Claim all slots synchronously before the previous-owner verification can yield.
      const leases=workers.map((id,i)=>makeAnalysis(id,refs[i]));
      try{if(previous){if(requireNewEpoch&&previous.epochId===attempt.token)return fail('ANALYSIS_ADMISSION');if(requireNewEpoch||!(previous.epochId===attempt.token&&released.has(previous.requestRef)))await verifyAnalysisSettlement(previous);}live();}
      catch(e){const closed=await Promise.allSettled(leases.map(l=>l.close()));if(closed.some(result=>result.status==='rejected'))return fail('SETTLEMENT_UNKNOWN');throw e;}
      return Object.freeze({leases:Object.freeze(leases),abortAndJoin:async()=>{const result=await settleOwner();if(!result.replacementReady)return fail('SETTLEMENT_UNKNOWN');return result;},close:async()=>{await Promise.all(leases.map(l=>l.close()));}});
    }
    function legacyAnalysisLease(lease){
      // Serial v1 attempts borrow a real parallel lane, but the existing step
      // accepts an exact five-field lease and completion. Keep worker identity
      // private to this adapter and authenticate it before narrowing the result.
      const nativeBinding=bindingOf(lease.nativeBinding),workerId=lease.workerId;
      if(typeof workerId!=='string'||!REF.test(workerId))return fail('BINDING');
      return Object.freeze({nativeBinding,
        async turnAnalysis(ref,body,callbacks){
          const completed=await lease.turnAnalysis(ref,body,callbacks);
          try{
            const r=record(completed,['kind','workerId','scope','answer','toolCalls','toolRefusals']);
            const scope=record(r.scope,['epochId','purpose','requestRef','threadId','turnId','turnNumber','threadTurnNumber']);
            if(r.kind!=='analysis'||r.workerId!==workerId||scope.epochId!==nativeBinding.epochId||scope.requestRef!==nativeBinding.requestRef||scope.purpose!==nativeBinding.purpose||
              typeof scope.threadId!=='string'||!REF.test(scope.threadId)||typeof scope.turnId!=='string'||!REF.test(scope.turnId)||
              !Number.isSafeInteger(scope.turnNumber)||scope.turnNumber<1||scope.turnNumber>16||scope.threadTurnNumber!==scope.turnNumber||
              typeof r.answer!=='string'||!r.answer.trim()||r.answer.includes('\0')||Buffer.byteLength(r.answer)>4096||Buffer.from(r.answer).toString()!==r.answer||
              !Number.isSafeInteger(r.toolCalls)||r.toolCalls<0||r.toolCalls>8||!Number.isSafeInteger(r.toolRefusals)||r.toolRefusals<0||r.toolRefusals>4)return fail('BINDING');
            return Object.freeze({kind:'analysis',scope,answer:r.answer,toolCalls:r.toolCalls,toolRefusals:r.toolRefusals});
          }catch(error){
            // An observed-but-misbound completion cannot be released as healthy
            // or replayed. Join the real pool before exposing the failure.
            failedAnalysisTurn=true;await lease.abortAndJoin();throw error;
          }
        },
        releaseAnalysis:ref=>lease.releaseAnalysis(ref),abortAndJoin:()=>lease.abortAndJoin(),close:()=>lease.close(),
      });
    }
    async function acquireCommunityAssessmentAdmission(requestRef){
      const valid=()=>parallelOptions.communityAssessment&&owner&&attempt&&!assessment&&!rotationPending&&typeof requestRef==='string'&&REF.test(requestRef)&&!seen.has(requestRef);
      live();if(!valid())return fail('COMMUNITY_ASSESSMENT_ADMISSION');
      if(seen.size>=backgroundLimit()){await prepareOwner(true);live();if(!valid()||seen.size>=backgroundLimit())return fail('COMMUNITY_ASSESSMENT_ADMISSION');}
      const selectedOwner=owner,selectedAttempt=attempt,nativeBinding=bindingOf({epochId:attempt.token,requestRef,purpose:'community-assessment'},'community-assessment');
      const held={phase:'unused',active:null,closing:null,done:deferred()};assessment=held;seen.add(requestRef);
      const guard=()=>{live();if(assessment!==held||held.closing||owner!==selectedOwner)return fail('COMMUNITY_ASSESSMENT_ADMISSION');};
      const invoke=operation=>{if(held.active)return Promise.reject(new StandingParallelRuntimeError('STATE'));const p=Promise.resolve().then(operation);held.active=p;void p.finally(()=>{if(held.active===p)held.active=null;}).catch(()=>{});return p;};
      const abortAndJoin=async()=>{held.phase='settling';const p=await settleOwner();if(!p.replacementReady||!selectedAttempt.record?.replacementReady)return fail('SETTLEMENT_UNKNOWN');held.phase='settled';return proof(nativeBinding);};
      return Object.freeze({nativeBinding,
        turnCommunityAssessment:(ref,body)=>{
          let timer,timedOut=false,rejectDeadline;const deadline=new Promise((_resolve,reject)=>{rejectDeadline=reject;});
          const turning=invoke(async()=>{guard();if(ref!==requestRef||held.phase!=='unused')return fail('COMMUNITY_ASSESSMENT_ADMISSION');held.phase='turn';
            timer=setTimeout(()=>{timedOut=true;failedCommunityAssessmentTurn=true;void abortAndJoin().then(()=>rejectDeadline(new StandingParallelRuntimeError('COMMUNITY_ASSESSMENT_TIMEOUT')),()=>rejectDeadline(new StandingParallelRuntimeError('SETTLEMENT_UNKNOWN')));},assessmentTimeoutMs);
            try{const result=await selectedOwner.turnCommunityAssessment(ref,body);held.phase='completed';return result;}catch(e){held.phase='failed';failedCommunityAssessmentTurn=true;throw e;}finally{clearTimeout(timer);}
          });return Promise.race([deadline,turning.then(v=>timedOut?deadline:v,e=>{if(timedOut)return deadline;throw e;})]);
        },
        releaseCommunityAssessment:ref=>invoke(async()=>{guard();if(ref!==requestRef||held.phase!=='completed')return fail('RELEASE_REQUIRED');try{await selectedOwner.releaseCommunityAssessment(ref);held.phase='released';}catch(e){held.phase='failed';failedCommunityAssessmentTurn=true;throw e;}}),
        abortAndJoin,close:()=>held.closing??=(async()=>{try{if(held.active||!['unused','released','settled'].includes(held.phase))await abortAndJoin();}finally{if(assessment===held)assessment=null;releaseRetiredOwner();held.done.resolve();}})(),
      });
    }
    return Object.freeze({
      concurrentAnalysis:true,
      prepare:()=>foreground(()=>prepareOwner(false),'prepare'),
      prepareAnalysis:()=>prepareOwner(true),
      turn:(requestRef,text,images)=>foreground(async()=>{
        if(!owner||pending!==null||typeof requestRef!=='string'||!REF.test(requestRef)||seen.has(requestRef))return fail('TURN');
        if(owner.admission()==='rotate'||seen.size>=16)return Object.freeze({kind:'not-admitted',reason:'prepare'});
        if(owner.admission()!=='ready')return fail('TURN');seen.add(requestRef);pending=requestRef;const delivery=deferred();pendingReleased=delivery.promise;resolvePendingReleased=delivery.resolve;
        try{const result=await owner.turnConversation(requestRef,text,images);if(result.kind==='text'||result.kind==='image'){restoration=false;foregroundObserved=true;}return result;}
        catch(e){if(isTurnNotAdmitted(e)!==true){failedTurn=true;throw e;}clearPending();return Object.freeze({kind:'not-admitted',reason:'limit'});}
      }),
      release:(requestRef,delivery)=>foreground(async()=>{if(!owner||pending!==requestRef||!['verified','not-sent','unknown'].includes(delivery))return fail('RELEASE_REQUIRED');await owner.releaseConversation(requestRef,delivery);clearPending();},'release'),
      acquireParallelAnalysisAdmissions:(refs,previous,options)=>acquireGroup(refs,previous,undefined,options),
      acquireAnalysisAdmission:async(ref,previous,options)=>legacyAnalysisLease((await acquireGroup([ref],previous,undefined,options)).leases[0]),
      acquireParallelAnalysisAdmission:async(workerId,ref,previous)=>(await acquireGroup([ref],previous,[workerId])).leases[0],
      verifyAnalysisWorkReleased:async(value,workRef)=>{if(blocked||closing||signal.aborted||control.signal.aborted)return fail('STATE');const binding=bindingOf(value),saved=workReleases.get(binding.epochId+':'+binding.requestRef);if(!saved||saved.workRef!==workRef)return fail('RELEASE_REQUIRED');return Object.freeze({schema:'standing-analysis-work-release-v1',nativeBinding:binding,workRef,releaseAcknowledged:true,callbacksJoined:true});},
      verifyAnalysisReady:async(value)=>{live();const binding=bindingOf(value);let basis='released-current-owner';if(binding.epochId!==attempt?.token||!released.has(binding.requestRef)){await verifyAnalysisSettlement(binding);basis='persisted-owner-settlement';}live();return Object.freeze({schema:'standing-analysis-owner-ready-v1',nativeBinding:binding,basis,modelOutcome:'not-proven'});},
      verifyAnalysisSettlement,...(parallelOptions.communityAssessment?{acquireCommunityAssessmentAdmission,verifyCommunityAssessmentSettlement}:{}),close,
      state:()=>Object.freeze({blocked,closed:!!closing,busy:foregroundBusy,prepared:!!owner,pendingRelease:pending!==null,failedTurn,failedAnalysisTurn,failedCommunityAssessmentTurn,analysisLeases:lanes.size}),
    });
  }
  return Object.freeze({openConnection,verifyAnalysisSettlement,...(parallelOptions.communityAssessment?{verifyCommunityAssessmentSettlement}:{}),state:()=>Object.freeze({blocked,connectionOpen:connectionLease!==null,attempts})});
}
