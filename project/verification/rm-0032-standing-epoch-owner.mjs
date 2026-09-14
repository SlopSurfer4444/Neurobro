// Source-bound host supplies the child and canonical compiled wire/session.
// No launch arguments, credentials, Telegram connection or source discovery here.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual,types} from 'node:util';
import {performance} from 'node:perf_hooks';
import {normalizeEpochResult,normalizeSupervisorResult,createEpochCustodyGate,epochSettlementProof} from './rm-0032-standing-epoch-receipt.mjs';

export const OWNER_LIMITS=Object.freeze({overallMs:1055000,stopMs:35000,bootstrapMs:10000,recordReserveMs:1000,stderrBytes:65536});
export class EpochOwnerError extends Error {constructor(code){super('STANDING_EPOCH_OWNER_'+code);this.code=code;}}
const fail=code=>{throw new EpochOwnerError(code);};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const TOOL_NAME=/^neurobro_[a-z][a-z0-9_]{0,54}$/u;
const ANALYSIS_NAMES=['neurobro_analysis_material','neurobro_analysis_notes','neurobro_analysis_commit'];
export function snapshotEpochSessionModeFromInput(input){
  if(!input||typeof input!=='object'||types.isProxy(input))return fail('CONFIG');
  const d=Object.getOwnPropertyDescriptor(input,'sessionMode');if(!d)return undefined;
  if(!Object.hasOwn(d,'value')||d.value!=='standing-scoped-epoch-v1')return fail('CONFIG');return d.value;
}
export function snapshotEpochAnalysisCallbacks(input){
  if(!input||typeof input!=='object'||types.isProxy(input))return fail('CONFIG');
  const fields=Object.getOwnPropertyDescriptors(input);
  for(const key of ['analysisTools','onToolResultSent'])if(!fields[key]||!Object.hasOwn(fields[key],'value'))return fail('CONFIG');
  const analysisTools=snapshotEpochExtraTools(fields.analysisTools.value),onToolResultSent=fields.onToolResultSent.value;
  if(!analysisTools||analysisTools.length!==3||analysisTools.some((tool,i)=>tool.name!==ANALYSIS_NAMES[i])||typeof onToolResultSent!=='function'||types.isProxy(onToolResultSent))return fail('CONFIG');
  return Object.freeze({analysisTools,onToolResultSent});
}
export function snapshotEpochExtraTools(value){
  if(value===undefined)return undefined;
  if(types.isProxy(value)||!Array.isArray(value)||value.length>31||Reflect.ownKeys(value).length!==value.length+1)return fail('CONFIG');
  const names=new Set(['neurobro_read_history']),result=[];
  for(let i=0;i<value.length;i++){
    const slot=Object.getOwnPropertyDescriptor(value,String(i));
    if(!slot||!Object.hasOwn(slot,'value'))return fail('CONFIG');
    const entry=slot.value;
    if(!entry||typeof entry!=='object'||types.isProxy(entry)||![Object.prototype,null].includes(Object.getPrototypeOf(entry)))return fail('CONFIG');
    const fields=Object.getOwnPropertyDescriptors(entry);
    if(Reflect.ownKeys(fields).length!==2||!['name','call'].every(key=>fields[key]&&Object.hasOwn(fields[key],'value')))return fail('CONFIG');
    const name=fields.name.value,call=fields.call.value;
    if(typeof name!=='string'||!TOOL_NAME.test(name)||names.has(name)||typeof call!=='function'||types.isProxy(call))return fail('CONFIG');
    names.add(name);result.push(Object.freeze({name,call}));
  }
  return Object.freeze(result);
}
export function snapshotEpochExtraToolsFromInput(input){
  if(!input||typeof input!=='object'||types.isProxy(input))return fail('CONFIG');
  const descriptor=Object.getOwnPropertyDescriptor(input,'extraTools');
  if(!descriptor)return undefined;
  if(!Object.hasOwn(descriptor,'value'))return fail('CONFIG');
  return snapshotEpochExtraTools(descriptor.value);
}
function envelope(value,kind,key){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)return fail('PROTOCOL');
  const d=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(d).length!==2||!["kind",key].every(k=>d[k]&&Object.hasOwn(d[k],'value'))||d.kind.value!==kind)return fail('PROTOCOL');
  return d[key].value;
}
function bootstrapValid(value){
  if(!Buffer.isBuffer(value)||value.length<70)return false;
  const size=value.readUInt32BE(0),hash=value.subarray(4,68).toString('ascii');
  return size>0&&size<=262144&&value.length===68+size&&/^[a-f0-9]{64}$/.test(hash)&&createHash('sha256').update(value.subarray(68)).digest('hex')===hash;
}

/** One child/epoch. recordFinal(value,timeoutMs) must honor a hard deadline.
 * A returned final with replacementReady:false never authorizes a successor.
 * Process close, session closure and durable recording are separate facts.
 */
export async function startOwnedEpoch(input){
  if(!input)return fail('CONFIG');
  // Capture before any caller port runs or await yields. The validated public
  // capsule must be the same owned bytes later written to this one child.
  const extraTools=snapshotEpochExtraToolsFromInput(input);
  const sessionMode=snapshotEpochSessionModeFromInput(input),scoped=sessionMode!==undefined;
  const analysis=scoped?snapshotEpochAnalysisCallbacks(input):undefined;
  if(!scoped&&(Object.hasOwn(input,'analysisTools')||Object.hasOwn(input,'onToolResultSent')))return fail('CONFIG');
  if(scoped&&((extraTools?.length??0)+4>32||extraTools?.some(tool=>ANALYSIS_NAMES.includes(tool.name))))return fail('CONFIG');
  const {bootstrap:suppliedBootstrap,epochId,signal,spawnChild,createWire,openSession,recordFinal,history:historyPort,clock:clockPort}=input;
  const bootstrap=Buffer.isBuffer(suppliedBootstrap)?Buffer.from(suppliedBootstrap):null;
  const historyCall=historyPort?.call;
  if(!bootstrapValid(bootstrap)||!/^[a-f0-9]{32}$/.test(epochId)||!(signal instanceof AbortSignal)||signal.aborted)return fail('CONFIG');
  for(const port of [spawnChild,createWire,openSession,recordFinal])if(typeof port!=='function')return fail('CONFIG');
  if(typeof historyCall!=='function'||(clockPort!==undefined&&typeof clockPort!=='function'))return fail('CONFIG');
  const history=Object.freeze({call:(...args)=>Reflect.apply(historyCall,historyPort,args)});
  const clock=clockPort??(()=>performance.now()),started=clock(),overallEnd=started+OWNER_LIMITS.overallMs;
  if(!Number.isFinite(started))return fail('CONFIG');
  let child,wire,session,closing,stopEnd,final,active,bootstrapJoined=false,startupDone=false;
  let poisoned=false,killed=false,exitObserved=false,closeObserved=false,exitCode=null,exitSignal=null,closeCode=null,closeSignal=null;
  let stderrBytes=0,stderrEnded=false,stdoutEnded=false,peerInputClosed=false,wireCleanEof=false,streamError=false,childError=false,persisted=false;
  let epochResult=null,supervisorResult=null,sessionClosed=null;
  const epochReceipt=value=>{
    const fixed=normalizeEpochResult(value);
    if(fixed.schema!==(scoped?'decadans.rm0032.standing-scoped-epoch.v1':'decadans.rm0032.standing-epoch.v1'))return fail('MODE');
    return fixed;
  };
  const supervisorReceipt=value=>{
    const fixed=normalizeSupervisorResult(value);if(fixed.client!==null)epochReceipt(fixed.client);return fixed;
  };
  let diagnosticsOnly=false,controlFault=false,writesRevoked=false;
  const wireOperations=new Set();
  const initialized=deferred(),childClosed=deferred(),stdoutEof=deferred(),custodyControl=new AbortController();
  const gate=createEpochCustodyGate(custodyControl.signal);
  const now=()=>{const at=clock();if(!Number.isFinite(at)||at<started)return fail('CLOCK');return at;};
  const remaining=end=>{const left=end-now();if(left<=0)return fail('DEADLINE');return left;};
  const wait=async(promise,end)=>{
    let timer;
    try{
      const result=await Promise.race([promise,new Promise((_,reject)=>{
        const poll=()=>{try{timer=setTimeout(poll,Math.ceil(Math.min(50,remaining(end))));}catch{reject(new EpochOwnerError('DEADLINE'));}};
        poll();
      })]);
      remaining(end);return result;
    }finally{if(timer)clearTimeout(timer);}
  };
  const rememberError=()=>{streamError=true;poisoned=true;requestClose();};
  const bootstrapWrite=()=>new Promise((resolve,reject)=>{
    let callback=false,returned=false,needsDrain=false,drained=false,done=false;
    const finish=()=>{if(!done&&returned&&callback&&(!needsDrain||drained)){done=true;cleanup();resolve();}};
    const error=()=>{if(!done){done=true;cleanup();reject(new EpochOwnerError('BOOTSTRAP'));}};
    const drain=()=>{drained=true;finish();};
    const cleanup=()=>{child.stdin.off('drain',drain);child.stdin.off('error',error);};
    child.stdin.on('drain',drain);child.stdin.on('error',error);
    try{
      needsDrain=!child.stdin.write(bootstrap,e=>{if(e)return error();callback=true;finish();});returned=true;finish();
    }catch{error();}
  });
  function observeControl(value){
    const kind=value&&Object.getOwnPropertyDescriptor(value,'kind');
    if(!kind||!Object.hasOwn(kind,'value')||!['epochResult','supervisorResult'].includes(kind.value))return value;
    try{
      if(controlFault)return fail('PROTOCOL');
      if(kind.value==='epochResult'){
        if(epochResult||supervisorResult)return fail('PROTOCOL');
        epochResult=epochReceipt(envelope(value,'epochResult','receipt'));
      }else{
        if(supervisorResult)return fail('PROTOCOL');
        supervisorResult=supervisorReceipt(envelope(value,'supervisorResult','receipt'));
        if(epochResult&&!isDeepStrictEqual(epochResult,supervisorResult.client))return fail('PROOF_MISMATCH');
      }
    }catch(error){controlFault=true;throw error;}
    // Capture only fixed validated metadata. The session still receives the
    // original frame and rejects an unexpected terminal under its own parser.
    return value;
  }
  function trackWire(operation){
    const actual=Promise.resolve().then(operation);wireOperations.add(actual);
    void actual.then(()=>wireOperations.delete(actual),()=>wireOperations.delete(actual));
    return actual;
  }
  async function joinWire(end){
    while(wireOperations.size)await wait(Promise.allSettled([...wireOperations]),end);
  }
  async function receiveControl(end){
    for(;;){
      try{return await wire.receive(Math.ceil(Math.min(1000,remaining(end))));}
      catch(error){if(error?.constructor?.name==='EpochWireTimeout'&&error.direction==='read')continue;throw error;}
    }
  }
  async function requireCleanEof(end){
    for(;;){
      try{await wire.receive(Math.ceil(Math.min(1000,remaining(end))));return fail('TRAILING_FRAME');}
      catch(error){
        if(error?.constructor?.name==='EpochWireTimeout'&&error.direction==='read')continue;
        if(error?.constructor?.name==='EpochWireError'&&error.code==='eof'){remaining(end);return;}
        throw error;
      }
    }
  }
  function requestClose(){
    if(stopEnd===undefined)stopEnd=Math.min(overallEnd,now()+OWNER_LIMITS.stopMs);
    gate.revoke();
    if(!closing){closing=finishClose();void closing.catch(()=>{});}
    return closing;
  }
  async function finishClose(){
    let activeJoined=false,bootstrapSettled=false,sessionOperationJoined=false;
    const workEnd=()=>Math.min(overallEnd,stopEnd)-OWNER_LIMITS.recordReserveMs;
    try{
      await wait(initialized.promise,workEnd());bootstrapSettled=bootstrapJoined;
      // A closed input pipe is not stdout EOF. Keep the only reader and wait
      // for actual output completion inside the same existing cleanup budget.
      if(peerInputClosed&&!stdoutEnded)await wait(stdoutEof.promise,workEnd());
      if(session){
        // session.close joins its pending history callback and is the sole reader
        // until completion. Never steal frames or wipe exposed image buffers.
        const closingSession=session.close({peerEnded:stdoutEnded});
        void closingSession.then(()=>{sessionOperationJoined=true;},()=>{sessionOperationJoined=true;});
        sessionClosed=await wait(closingSession,workEnd());
        if(active)await wait(active.then(()=>{},()=>{}),workEnd());
        activeJoined=true;
      }else{
        activeJoined=true;
        if(wire&&bootstrapJoined&&!stdoutEnded)await wait(wire.send({kind:'close'},Math.ceil(Math.min(10000,remaining(workEnd())))),workEnd());
      }
      writesRevoked=true;
      await joinWire(workEnd());
      if(wire){
        if(!epochResult)epochResult=epochReceipt(envelope(await receiveControl(workEnd()),'epochResult','receipt'));
        if(!supervisorResult)supervisorResult=supervisorReceipt(envelope(await receiveControl(workEnd()),'supervisorResult','receipt'));
        if(!isDeepStrictEqual(epochResult,supervisorResult.client))return fail('PROOF_MISMATCH');
      }
      if(typeof wire?.sealWrites!=='function')return fail('WIRE_CONTRACT');
      wire.sealWrites(); // Keep queued/partial read data until exact clean EOF.
      if(!child.stdin.writableEnded)child.stdin.end();
      await requireCleanEof(workEnd());
      wireCleanEof=true;
      await wait(childClosed.promise,workEnd());
    }catch{
      poisoned=true;diagnosticsOnly=true;
      // A malformed final proof forbids replacement but is not permission to
      // kill early. Let this owned process consume EOF and settle within the
      // existing stop budget, only after actual callback/write joins.
      try{
        if(sessionOperationJoined){
          if(active)await wait(active.then(()=>{},()=>{}),workEnd());
          activeJoined=true;
        }
        if(child&&activeJoined&&bootstrapJoined){
          // Never compete with the session reader or a still-running callback.
          // A rejected close can precede the end of an actual queued write.
          writesRevoked=true;
          await joinWire(workEnd());
          let readable=true;
          try{wire.sealWrites();}catch{readable=false;}
          if(!child.stdin.writableEnded)child.stdin.end();
          if(readable&&!controlFault){
            // At most the two exact terminal controls may remain. Do not fish
            // through inner frames, malformed metadata or trailing output.
            while(!supervisorResult){
              const value=await receiveControl(workEnd());
              if(!['epochResult','supervisorResult'].includes(value?.kind))return fail('PROTOCOL');
            }
            await requireCleanEof(workEnd());wireCleanEof=true;
          }
        }
      }catch{}
      try{
        // A rejected drain is not permission to kill a process early.
        if(child&&!closeObserved)await wait(childClosed.promise,workEnd());
      }catch{}
    }
    finally{
      gate.revoke();
      if(!closeObserved&&child){
        // Only this owned transport is terminated. Dispatch is never settlement.
        // No manual stream destruction while a history handler may still run.
        killed=true;poisoned=true;
        try{child.kill();}catch{}
      }
      if(activeJoined&&closeObserved)wire?.close();
      clearTimeout(overallTimer);signal.removeEventListener('abort',abort);
    }
    const processSettled=exitObserved&&closeObserved&&exitCode===closeCode&&exitSignal===closeSignal;
    const supervisorObserved=supervisorResult?.outcome==='observed'&&['preflight','custodyReady','clientNaturalSettlement','relaySettled','allProcessesSettled','settled'].every(k=>supervisorResult[k]===true)&&
      supervisorResult.clientExit===0&&supervisorResult.relayExit===0&&supervisorResult.clientStderrBytes===0&&supervisorResult.relayStderrBytes===0&&supervisorResult.injectedPorts===false;
    const healthy=!poisoned&&!killed&&bootstrapSettled&&activeJoined&&sessionClosed?.nativeLoopClosed===true&&epochResult?.outcome==='observed'&&epochResult.injectedPorts===false&&
      supervisorObserved&&processSettled&&closeCode===0&&closeSignal===null&&stderrEnded&&stdoutEnded&&stderrBytes===0&&!streamError&&!childError;
    const resourceProof=epochSettlementProof(epochResult,supervisorResult);
    const resourcesSettled=!controlFault&&bootstrapSettled&&activeJoined&&processSettled&&wireCleanEof&&stderrEnded&&stdoutEnded&&!streamError&&!childError&&
      (resourceProof.physical||!diagnosticsOnly&&resourceProof.legacy);
    const record=Object.freeze({schema:'standing-epoch-owner-v1',epochId,outcome:healthy?'observed':'unknown',
      bootstrapJoined:bootstrapSettled,activeJoined,sessionClosed:sessionClosed?.nativeLoopClosed===true,
      epochObserved:epochResult?.outcome==='observed',supervisorObserved,processSettled,exitObserved,closeObserved,
      exitCode,exitSignal:exitSignal===null?null:'signalled',closeCode,closeSignal:closeSignal===null?null:'signalled',
      stderrBytes,stderrEnded,stdoutEnded,wireCleanEof,streamError,childError,terminationDispatched:killed,
      successfulEpoch:healthy,resourcesSettled,replacementReady:resourcesSettled,
      // Both receipts already passed the strict metadata-only validators. Keep
      // the original failure before process settlement reduces it to booleans.
      // No model text, tool arguments or raw exception/stderr enters this field.
      diagnostics:Object.freeze({epoch:epochResult,supervisor:supervisorResult})});
    try{
      const bound=Math.min(1000,remaining(Math.min(overallEnd,stopEnd)));
      await wait(Promise.resolve(recordFinal(record,Math.ceil(bound))),Math.min(overallEnd,stopEnd));persisted=true;
    }catch{poisoned=true;}
    final=Object.freeze({...record,persisted,replacementReady:resourcesSettled&&persisted});
    return final;
  }
  const abort=()=>{void requestClose();};
  // Reserve the final35s of the absolute lifetime for the same STOP/cleanup;
  // firing only at1055s would leave no budget to join or persist anything.
  const overallTimer=setTimeout(()=>{void requestClose();},Math.ceil(remaining(overallEnd-OWNER_LIMITS.stopMs)));
  signal.addEventListener('abort',abort,{once:true});
  try{
    child=spawnChild();
    if(!child?.stdin||!child.stdout||!child.stderr||typeof child.kill!=='function'||typeof child.once!=='function')return fail('CHILD');
    child.on('error',()=>{childError=true;poisoned=true;requestClose();});
    child.stdin.on('error',rememberError);child.stdout.on('error',rememberError);child.stderr.on('error',rememberError);
    // Install before canonical wire listeners: expected peer input closure
    // seals only writes, retaining all queued output and partial EOF checks.
    const inputClosed=()=>{
      peerInputClosed=true;
      try{wire?.sealWrites();}catch{rememberError();}
      if(!closing){poisoned=true;requestClose();}
    };
    child.stdin.on('finish',inputClosed);child.stdin.on('close',inputClosed);
    child.stdout.on('end',()=>{stdoutEnded=true;stdoutEof.resolve();if(!closing){poisoned=true;requestClose();}});
    child.stderr.on('end',()=>{stderrEnded=true;});
    child.stderr.on('data',chunk=>{
      if(!Buffer.isBuffer(chunk)){streamError=true;poisoned=true;requestClose();return;}
      stderrBytes=Math.min(65537,stderrBytes+chunk.length);
      if(stderrBytes>OWNER_LIMITS.stderrBytes){poisoned=true;requestClose();}
    });
    child.once('exit',(code,signal)=>{exitObserved=true;exitCode=Number.isSafeInteger(code)?code:null;exitSignal=signal??null;if(!closing){poisoned=true;requestClose();}});
    child.once('close',(code,signal)=>{closeObserved=true;closeCode=Number.isSafeInteger(code)?code:null;closeSignal=signal??null;childClosed.resolve();});
    await wait(bootstrapWrite(),Math.min(overallEnd,now()+OWNER_LIMITS.bootstrapMs));bootstrapJoined=true;
    const canonicalWire=createWire({readable:child.stdout,writable:child.stdin,onFault:rememberError});
    wire=Object.freeze({
      send:(value,timeout)=>trackWire(()=>{
        if(writesRevoked||epochResult||supervisorResult)return fail('TERMINAL');
        return canonicalWire.send(value,timeout);
      }),
      receive:timeout=>trackWire(async()=>observeControl(await canonicalWire.receive(timeout))),
      sealWrites:()=>canonicalWire.sealWrites(),close:()=>canonicalWire.close(),
    });
    if(stopEnd!==undefined)return fail('STOPPED');
    const custody=await receiveControl(Math.min(overallEnd,started+120000));
    if(custody?.kind==='epochResult'){
      epochResult=epochReceipt(envelope(custody,'epochResult','receipt'));
      return fail('PREP_REFUSED');
    }
    gate.accept(custody);
    if(stopEnd!==undefined)return fail('STOPPED');
    session=await openSession({epochId,wire,signal:custodyControl.signal,custodyReady:gate.ready,clock,
      ...(scoped?{conversation:{history,...(extraTools===undefined?{}:{extraTools})},...analysis}:{history,...(extraTools===undefined?{}:{extraTools})})});
    if(stopEnd!==undefined)return fail('STOPPED');
    startupDone=true;
  }catch{
    poisoned=true;initialized.resolve();await requestClose();throw new EpochOwnerError('START_UNKNOWN');
  }finally{initialized.resolve();}
  const operation=(name,args)=>{
    if(closing||poisoned||!startupDone)return Promise.reject(new EpochOwnerError('CLOSED'));
    if(scoped&&active)return Promise.reject(new EpochOwnerError('BUSY'));
    const value=Promise.resolve().then(()=>session[name](...args));active=value;
    if(scoped)void value.then(()=>{if(active===value)active=undefined;},()=>{if(active===value)active=undefined;requestClose();}).catch(()=>{});
    else void value.catch(()=>{requestClose();}).finally(()=>{if(active===value)active=undefined;}).catch(()=>{});
    return value;
  };
  return Object.freeze({
    ...(scoped?{
      turnConversation:(...args)=>operation('turnConversation',args),releaseConversation:(...args)=>operation('releaseConversation',args),
      turnAnalysis:(...args)=>operation('turnAnalysis',args),releaseAnalysis:(...args)=>operation('releaseAnalysis',args),
    }:{turn:(...args)=>operation('turn',args),release:(...args)=>operation('release',args)}),
    admission:()=>closing||poisoned?'unavailable':session.admission(),
    state:()=>Object.freeze({closing:!!closing,poisoned,persisted,final}),
    close:requestClose,
  });
}
