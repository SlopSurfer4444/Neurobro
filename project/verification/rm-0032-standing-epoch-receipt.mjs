// Windows-side boundary for the managed client's fixed metadata. No process,
// source, model answer or Telegram operation is admitted by importing this file.
import {isDeepStrictEqual} from 'node:util';
const fail=()=>{throw new Error('STANDING_EPOCH_RECEIPT_REFUSED');};
const need=v=>{if(!v)fail();};
function exact(v,keys){
  need(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype);
  const d=Object.getOwnPropertyDescriptors(v);
  need(Reflect.ownKeys(d).length===keys.length&&keys.every(k=>Object.hasOwn(d,k)&&Object.hasOwn(d[k],'value')&&d[k].enumerable));
}
const bool=v=>need(typeof v==='boolean');
const int=(v,max,min=0)=>need(Number.isSafeInteger(v)&&v>=min&&v<=max);
const one=(v,values)=>need(typeof v==='string'&&values.includes(v));
function frozen(v){if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
// Do not invoke toJSON/getters while capturing control evidence. The real wire
// yields plain JSON, and injected ports must meet the same inert-data contract.
function snapshot(v){
  if(v===null||typeof v==='boolean'||typeof v==='string')return v;
  if(typeof v==='number'){need(Number.isFinite(v));return v;}
  need(v&&typeof v==='object');
  const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(descriptors);
  if(Array.isArray(v)){
    need(Object.getPrototypeOf(v)===Array.prototype);
    const length=descriptors.length;
    need(length&&Object.hasOwn(length,'value')&&Number.isSafeInteger(length.value)&&length.value>=0&&keys.length===length.value+1);
    const result=[];
    for(let i=0;i<length.value;i++){
      const d=descriptors[String(i)];need(d&&Object.hasOwn(d,'value')&&d.enumerable);
      result.push(snapshot(d.value));
    }
    return Object.freeze(result);
  }
  need(Object.getPrototypeOf(v)===Object.prototype);
  const entries=keys.map(k=>{const d=descriptors[k];need(typeof k==='string'&&Object.hasOwn(d,'value')&&d.enumerable);return [k,snapshot(d.value)];});
  return Object.freeze(Object.fromEntries(entries));
}
const passCodes=[[0],...[...Array(5)].map(()=>[20,21,22]),[40],[30],[60,61]];
const custodyBools=['initialize','profile','controlsPassed','relayAfter','accountChatgpt','astraMedium'];
const capabilityKeys=['checked','imageGeneration','namespaceTools','webSearch'];
const codes=['NOT_RUN','OK','SOURCE_REFUSED','CONFIG_REFUSED','PREFLIGHT_REFUSED','LAUNCH_UNKNOWN','CUSTODY_REFUSED','CAPABILITIES_REFUSED','SESSION_UNKNOWN','TRANSPORT_UNKNOWN','INTERNAL_UNKNOWN','SHUTDOWN_UNKNOWN','CONTROL_REFUSED'];
const stages=['validate','preflight','launch','custody','capabilities','session','complete','shutdown'];
const sessionCodes=['NOT_RUN','CLOSED','EPOCH_LIMIT','TURN_LIMIT','INPUT_REFUSED','PROTOCOL_REFUSED','IO_UNKNOWN','NATIVE_UNKNOWN','RELEASE_UNKNOWN','INTERNAL_UNKNOWN'];
const idleMethods=["account/login/completed","account/rateLimits/updated","account/read","account/updated","app/list/updated","autoApprovalReview/strictReviewRequired","command/exec","command/exec/outputDelta","configWarning","deprecationNotice","error","externalAgentConfig/import/completed","externalAgentConfig/import/progress","fs/changed","fuzzyFileSearch/sessionCompleted","fuzzyFileSearch/sessionUpdated","guardianWarning","hook/completed","hook/started","initialize","item/agentMessage/delta","item/autoApprovalReview/completed","item/autoApprovalReview/started","item/commandExecution/outputDelta","item/commandExecution/terminalInteraction","item/completed","item/fileChange/outputDelta","item/fileChange/patchUpdated","item/mcpToolCall/progress","item/plan/delta","item/reasoning/summaryPartAdded","item/reasoning/summaryTextDelta","item/reasoning/textDelta","item/started","mcpServer/event/stream/notification","mcpServer/oauthLogin/completed","mcpServer/startupStatus/updated","model/list","model/rerouted","model/safetyBuffering/updated","model/verification","modelProvider/authRecoveryCompleted","modelProvider/authRecoveryStarted","none","other","permissionProfile/list","process/exited","process/outputDelta","project/changed","remoteControl/status/changed","serverRequest/resolved","skills/changed","thread/archived","thread/closed","thread/compacted","thread/deleted","thread/environment/connected","thread/environment/disconnected","thread/goal/cleared","thread/goal/updated","thread/name/updated","thread/project/updated","thread/queue/changed","thread/realtime/closed","thread/realtime/error","thread/realtime/item/completed","thread/realtime/item/started","thread/realtime/item/transcript/delta","thread/realtime/itemAdded","thread/realtime/outputAudio/delta","thread/realtime/sdp","thread/realtime/started","thread/realtime/transcript/delta","thread/realtime/transcript/done","thread/reverted","thread/settings/updated","thread/start","thread/started","thread/status/changed","thread/tokenUsage/updated","thread/unarchived","turn/completed","turn/diff/updated","turn/moderationMetadata","turn/plan/updated","turn/start","turn/started","warning","windows/worldWritableWarning","windowsSandbox/setupCompleted"];
const limits={prepSeconds:120,epochSeconds:900,cleanupSeconds:35,turnLimit:16,threadLimit:1,history:true,images:true,syntheticOnly:false};
const factBools=['threadStarted','poisoned','busy','running','releasePending','closed','resourceSettlementObserved','unreleasedTurn'];
const NATIVE_FAILURE_CODES = ['ANSWER_REFUSED', 'BOUNDS_REFUSED', 'CONFIG_REFUSED', 'CUSTODY_REFUSED', 'INPUT_REFUSED', 'PROTOCOL_REFUSED', 'SESSION_LIMIT', 'THREAD_REFUSED', 'TOOL_EVENT_REFUSED', 'TOOL_REFUSED', 'TRANSPORT_UNKNOWN', 'TURN_REFUSED', 'INTERNAL_UNKNOWN', 'BUSY', 'SESSION_POISONED'];
const NATIVE_FAILURE_SITES = ['answer', 'answer_changed', 'answer_missing', 'arguments', 'config', 'correlation', 'deadline', 'duplicate_call', 'duplicate_request', 'events', 'exchange', 'frame', 'input', 'item', 'item_timestamp', 'ports', 'request', 'request_id', 'resolved', 'session', 'source', 'spec', 'thread_ack', 'tool_calls', 'tool_item', 'tool_item_changed', 'tool_item_correlation', 'tool_item_missing', 'tool_item_result', 'tool_result', 'tool_wire', 'turn', 'turn_ack', 'web_changed', 'web_item', 'web_unfinished', 'none', 'observer_or_transport', 'other'];
const NATIVE_OBSERVER_SITES = ['account_shape', 'base_protocol', 'delta_shape', 'delta_utf8', 'error_shape', 'event_params', 'item_conflict', 'item_shape', 'item_text', 'item_utf8', 'model_metadata_shape', 'none', 'notification_expected', 'notification_item', 'notification_shape', 'rpc_after_model', 'rpc_budget', 'rpc_frame', 'rpc_id', 'rpc_json', 'rpc_method', 'rpc_result', 'settings_shape', 'status_shape', 'thread_event', 'thread_id', 'thread_response', 'turn_id', 'turn_response', 'turn_shape', 'warning_shape', 'other'];
const NATIVE_IMAGE_FAILURES = ['base64', 'budget', 'conflict', 'correlation', 'envelope', 'failure', 'image-required', 'item', 'lifecycle', 'missing-terminal', 'multiple-images', 'none', 'not-ready', 'png', 'revoked', 'scope', 'shape', 'size', 'status', 'turn-failed', 'other'];
function nativeFailure(v){
  if(v===null)return;
  exact(v,['purpose','code','site','observerSite','observerMethod','imageOutcome','imageFailure','imageFailureCode','eventCount','eventBytes']);
  one(v.purpose,['conversation','history-analysis']);one(v.code,NATIVE_FAILURE_CODES);one(v.site,NATIVE_FAILURE_SITES);
  one(v.observerSite,NATIVE_OBSERVER_SITES);one(v.observerMethod,idleMethods);
  one(v.imageOutcome,['not-requested','pending','completed','failed','revoked','other']);one(v.imageFailure,NATIVE_IMAGE_FAILURES);
  one(v.imageFailureCode,['none','usageLimitExceeded','generationFailed','other']);int(v.eventCount,513);int(v.eventBytes,262145);
}
function idleFailure(v){
  if(v===null)return;
  exact(v,['code','site','operation','method','phase','frames','bytes','poisoned','pendingResponses','lateRefusals']);
  one(v.code,['NOT_RUN','OK','CONFIG_REFUSED','PROTOCOL_REFUSED','PHASE_REFUSED','BOUNDS_REFUSED','TRANSPORT_UNKNOWN','CONCURRENT_REFUSED','CLOSED','CLOSE_UNKNOWN','SHUTDOWN_UNKNOWN','SESSION_POISONED','CUSTODY_REFUSED','TOOL_REFUSED','INTERNAL_UNKNOWN','DEADLINE_UNKNOWN']);
  one(v.site,['none','line','json','envelope','marker','unicode','payload','phase','deadline','read','write','selector','eof','response_id','other','warning','apps','mcp_status','scope','response_ids','poisoned','frame','budget','method','skills','remote_control','thread','status','turn','token_usage','resolved','request','request_id','correlation','call_id','refusal_budget','response_confirmation','rpc_state']);
  one(v.operation,['create','poll','observe','clear','respond','confirm']);one(v.method,idleMethods);one(v.phase,['before-first-turn','after-turn']);
  bool(v.poisoned);int(v.frames,513);int(v.bytes,262145);int(v.pendingResponses,4);int(v.lateRefusals,4);
}
function custody(v){
  exact(v,[...custodyBools,'probePass','probeExitCodes']);custodyBools.forEach(k=>bool(v[k]));
  need(Array.isArray(v.probePass)&&v.probePass.length===9&&Array.isArray(v.probeExitCodes)&&v.probeExitCodes.length===9);
  for(let i=0;i<9;i++){bool(v.probePass[i]);if(v.probeExitCodes[i]!==null)int(v.probeExitCodes[i],255,-255);}
}
function capabilities(v){exact(v,capabilityKeys);capabilityKeys.forEach(k=>bool(v[k]));}
function provedCustody(c,cap,final){
  need(custodyBools.filter(k=>final||k!=='relayAfter').every(k=>c[k]===true));
  need(c.probePass.every(v=>v===true)&&c.probeExitCodes.every((v,i)=>passCodes[i].includes(v)));
  need(cap.checked===true&&cap.imageGeneration===true);
}
function facts(v){
  exact(v,[...factBools,'turnsAttempted','toolCalls','schema','turnsAdmitted','turnLimit','epochSeconds','turnSeconds']);
  factBools.forEach(k=>bool(v[k]));int(v.turnsAttempted,16);int(v.turnsAdmitted,16);int(v.toolCalls,193);
  need(v.schema==='neurobro-native-image-epoch-v1'&&v.turnLimit===16&&v.epochSeconds===900&&v.turnSeconds===300&&v.resourceSettlementObserved===false);
}
const purposes=['conversation','history-analysis'];
const webCounts=['admitted','completed','search','openPage','findInPage','other'];
function scopedFacts(v){
  exact(v,[...factBools,'turnsAttempted','toolCalls','schema','turnsAdmitted','turnLimit','epochSeconds','turnSeconds',
    'threadLimit','threadStartDispatches','turnStartDispatches','slots']);
  factBools.forEach(k=>bool(v[k]));int(v.turnsAttempted,16);int(v.turnsAdmitted,16);int(v.toolCalls,193);
  int(v.threadStartDispatches,2);int(v.turnStartDispatches,16);
  need(v.schema==='neurobro-native-scoped-epoch-v1'&&v.threadLimit===2&&v.turnLimit===16&&
    v.epochSeconds===900&&v.turnSeconds===300&&v.resourceSettlementObserved===false);
  need(Array.isArray(v.slots)&&v.slots.length===2);
  for(const [i,s] of v.slots.entries()){
    exact(s,['purpose','threadStarted','turnsAdmitted','turnsAttempted','toolCalls','closed','poisoned']);
    need(s.purpose===purposes[i]);['threadStarted','closed','poisoned'].forEach(k=>bool(s[k]));
    int(s.turnsAdmitted,16);int(s.turnsAttempted,16);int(s.toolCalls,193);
  }
  need(v.slots.reduce((n,s)=>n+s.turnsAdmitted,0)<=v.turnsAdmitted&&
    v.slots.filter(s=>s.threadStarted).length<=v.threadStartDispatches);
}
function scopedNative(n){
  exact(n,['admitted','threadStartDispatches','turnStartDispatches','threadsAcknowledged','slotWeb']);
  bool(n.admitted);int(n.threadStartDispatches,2);int(n.turnStartDispatches,16);int(n.threadsAcknowledged,2);
  need(n.threadsAcknowledged<=n.threadStartDispatches&&Array.isArray(n.slotWeb)&&n.slotWeb.length===2);
  for(const [i,w] of n.slotWeb.entries()){
    exact(w,['purpose','turnsAttempted',...webCounts]);need(w.purpose===purposes[i]);
    int(w.turnsAttempted,16);webCounts.forEach(k=>int(w[k],512));
    need(w.completed<=w.admitted&&
      w.search+w.openPage+w.findInPage+w.other<=w.completed);
    if(w.turnsAttempted===0||i===1)need(webCounts.every(k=>w[k]===0));
  }
}
function scopedRelations(n,f){
  need(n.threadStartDispatches===f.threadStartDispatches&&n.turnStartDispatches===f.turnStartDispatches&&
    n.threadsAcknowledged===f.slots.filter(slot=>slot.threadStarted).length&&
    f.threadStarted===f.slots.some(slot=>slot.threadStarted)&&
    f.poisoned===f.slots.some(slot=>slot.poisoned)&&f.closed===f.slots.every(slot=>slot.closed)&&
    f.turnsAttempted===f.slots.reduce((sum,slot)=>sum+slot.turnsAttempted,0)&&
    f.toolCalls===f.slots.reduce((sum,slot)=>sum+slot.toolCalls,0)&&f.turnStartDispatches<=f.turnsAdmitted);
  f.slots.forEach((slot,i)=>need(slot.turnsAttempted<=slot.turnsAdmitted&&n.slotWeb[i].turnsAttempted<=slot.turnsAttempted));
}

export function normalizeEpochResult(v){
  v=snapshot(v);
  exact(v,['schema','outcome','code','stage','injectedPorts','limits','custody','capabilities','native','session','diagnostics','appServer']);
  one(v.schema,['decadans.rm0032.standing-epoch.v1','decadans.rm0032.standing-scoped-epoch.v1']);bool(v.injectedPorts);
  const scoped=v.schema==='decadans.rm0032.standing-scoped-epoch.v1';
  one(v.outcome,['observed','refused','unknown']);one(v.code,codes);one(v.stage,stages);
  exact(v.limits,Object.keys(limits));for(const [k,value] of Object.entries(limits))need(v.limits[k]===(scoped&&k==='threadLimit'?2:value));
  const c=v.custody,cap=v.capabilities,n=v.native,s=v.session,d=v.diagnostics,a=v.appServer;
  custody(c);capabilities(cap);
  need(n&&typeof n==='object');const hasWeb=Object.hasOwn(n,'lastTurnWeb');
  if(scoped)scopedNative(n);
  else{
  exact(n,['admitted','threadStartDispatches','turnStartDispatches','threadAcknowledged',...(hasWeb?['lastTurnWeb']:[])]);bool(n.admitted);bool(n.threadAcknowledged);int(n.threadStartDispatches,1);int(n.turnStartDispatches,16);
  if(hasWeb){
    const w=n.lastTurnWeb,counts=['admitted','completed','search','openPage','findInPage','other'];
    exact(w,['turnAttempted',...counts]);int(w.turnAttempted,16);counts.forEach(k=>int(w[k],512));
    need(w.turnAttempted<=n.turnStartDispatches&&w.completed<=w.admitted&&w.search+w.openPage+w.findInPage+w.other<=w.completed);
    if(w.turnAttempted===0)need(counts.every(k=>w[k]===0));
  }
  }
  exact(s,['custodyPublished','ready','closed','code','facts']);['custodyPublished','ready','closed'].forEach(k=>bool(s[k]));one(s.code,sessionCodes);
  if(s.facts!==null)(scoped?scopedFacts:facts)(s.facts);
  if(scoped&&s.facts!==null)scopedRelations(n,s.facts);
  exact(d,['originalCode','originalStage','cleanupUnknown','rpcCode','rpcSite','rpcOperation','idleFailure',...(Object.hasOwn(d,'nativeFailure')?['nativeFailure']:[])]);if(Object.hasOwn(d,'nativeFailure'))nativeFailure(d.nativeFailure);bool(d.cleanupUnknown);one(d.originalCode,codes);one(d.originalStage,stages);idleFailure(d.idleFailure);
  one(d.rpcCode,['NOT_RUN','OK','CONFIG_REFUSED','PROTOCOL_REFUSED','PHASE_REFUSED','BOUNDS_REFUSED','TRANSPORT_UNKNOWN','CONCURRENT_REFUSED','CLOSED','CLOSE_UNKNOWN','SHUTDOWN_UNKNOWN']);
  one(d.rpcSite,['none','line','json','envelope','marker','unicode','payload','phase','deadline','read','write','selector','eof','response_id']);
  one(d.rpcOperation,['none','other','initialize','initialized','permissionProfile/list','command/exec','account/read','model/list','modelProvider/capabilities/read','thread/start','turn/start','admit_model','next_frame','respond']);
  exact(a,['launched','stdinClosed','stdoutEof','reaped','exitCode','stderrBytes','stderrComplete','transportUnknown']);
  ['launched','stdinClosed','stdoutEof','reaped','stderrComplete','transportUnknown'].forEach(k=>bool(a[k]));
  if(a.exitCode!==null)int(a.exitCode,255,-255);int(a.stderrBytes,65537);
  if(s.closed)need(s.facts&&s.facts.closed&&!s.facts.running&&!s.facts.busy&&!s.facts.releasePending);
  if(v.outcome==='observed'){
    if(hasWeb||scoped)need(cap.webSearch===true);
    need(d.idleFailure===null);need(!Object.hasOwn(d,'nativeFailure')||d.nativeFailure===null);
    need(v.code==='OK'&&v.stage==='complete'&&d.originalCode==='OK'&&d.originalStage==='complete'&&!d.cleanupUnknown&&d.rpcCode==='OK');
    provedCustody(c,cap,true);
    need(n.admitted&&s.custodyPublished&&s.ready&&s.closed&&['CLOSED','EPOCH_LIMIT','TURN_LIMIT'].includes(s.code)&&!s.facts.poisoned&&!s.facts.unreleasedTurn);
    if(scoped){
      const f=s.facts;
      need(n.threadStartDispatches===n.threadsAcknowledged&&n.turnStartDispatches===f.turnsAttempted&&
        f.turnsAdmitted===f.slots.reduce((sum,slot)=>sum+slot.turnsAdmitted,0));
    }else need(n.threadStartDispatches===Number(s.facts.threadStarted)&&n.threadAcknowledged===s.facts.threadStarted&&n.turnStartDispatches===s.facts.turnsAttempted&&n.turnStartDispatches<=s.facts.turnsAdmitted);
    need(a.launched&&a.stdinClosed&&a.stdoutEof&&a.reaped&&a.stderrComplete&&a.exitCode===0&&a.stderrBytes<=65536&&!a.transportUnknown);
  }
  return frozen(v);
}

/** Final outer proof is separate from inner completed/closed and client EOF.
 * The Windows process owner must still observe its own WSL child close. */
export function normalizeSupervisorResult(v){
  v=snapshot(v);
  const flags=['preflight','custodyReady','clientNaturalSettlement','relaySettled','allProcessesSettled','settled','injectedPorts'];
  const hasPhysical=Object.hasOwn(v,'physicalCleanup');
  exact(v,['schema','outcome','stage',...flags,'clientExit','relayExit','clientStdoutBytes','clientStderrBytes','relayStdoutBytes','relayStderrBytes','client','relay',...(hasPhysical?['physicalCleanup']:[])]);
  need(v.schema==='standing-epoch-supervisor-v1');one(v.outcome,['observed','unknown']);
  one(v.stage,['preflight','relay_launch','client_launch','session','settlement','complete']);flags.forEach(k=>bool(v[k]));
  for(const k of ['clientExit','relayExit'])if(v[k]!==null)int(v[k],255,-255);
  int(v.clientStdoutBytes,203423744+65536);int(v.clientStderrBytes,65536);int(v.relayStdoutBytes,4096);int(v.relayStderrBytes,65536);
  if(v.client!==null)normalizeEpochResult(v.client);
  if(v.relay!==null){
    exact(v.relay,['version','settled','counters']);need(v.relay.version===1&&v.relay.settled===true);
    exact(v.relay.counters,['accepted','over_limit','refused','connected','completed','failed','cancelled','internal_error']);
    Object.values(v.relay.counters).forEach(n=>int(n,1000000));need(v.relay.counters.accepted<=64);
  }
  if(hasPhysical){
    const p=v.physicalCleanup;
    const evidence=['clientLaunchCaptured','relayLaunchCaptured','creationsJoined','ownershipKnown',
      'clientUnitAbsent','relayUnitAbsent','unitChecksAfterCreations','transportsJoined','stdinClosed','stdoutEof','stderrEof','sessionTasksJoined'];
    const methods=['clientStopRequested','relayStopRequested','transportKillRequested'];
    exact(p,[...evidence,...methods,'complete']);[...evidence,...methods,'complete'].forEach(k=>bool(p[k]));
    need(p.complete===evidence.every(k=>p[k]===true));
    if(p.complete)need(v.clientExit!==null&&v.relayExit!==null&&v.allProcessesSettled);
    // Physical termination never upgrades the semantic outcome or replaces the
    // Windows owner's own process/EOF/callback/persistence observations.
  }
  if(v.outcome==='observed'){
    need(v.stage==='complete'&&flags.filter(k=>k!=='injectedPorts').every(k=>v[k]===true));
    need(v.clientExit===0&&v.relayExit===0&&v.client?.outcome==='observed'&&v.relay!==null);
  }
  return frozen(v);
}

/** Resource proof only. The caller still owns Windows process/pipe, callback
 * joins and durable persistence. Never infer a completed answer from this. */
export function epochSettlementProof(epochValue,supervisorValue){
  try{
    const epoch=epochValue===null?null:normalizeEpochResult(epochValue);
    const supervisor=supervisorValue===null?null:normalizeSupervisorResult(supervisorValue);
    if(!supervisor||supervisor.injectedPorts!==false||epoch?.injectedPorts===true||supervisor.client?.injectedPorts===true||
      epoch!==null&&!isDeepStrictEqual(epoch,supervisor.client))return Object.freeze({legacy:false,physical:false});
    return Object.freeze({
      legacy:epoch!==null&&['clientNaturalSettlement','relaySettled','allProcessesSettled','settled'].every(k=>supervisor[k]===true),
      physical:supervisor.preflight===true&&supervisor.custodyReady===true&&supervisor.physicalCleanup?.complete===true,
    });
  }catch{return Object.freeze({legacy:false,physical:false});}
}

/** Exact metadata persisted by the Windows owner, before recordFinal resolves.
 * Reading this valid record proves the write exists now; persisted is deliberately
 * not a self-attested field inside the write being acknowledged. */
export function normalizeEpochOwnerRecord(value,epochId){
  const v=snapshot(value);
  const flags=['bootstrapJoined','activeJoined','sessionClosed','epochObserved','supervisorObserved','processSettled','exitObserved','closeObserved',
    'stderrEnded','stdoutEnded','wireCleanEof','streamError','childError','terminationDispatched','successfulEpoch','resourcesSettled','replacementReady'];
  const hasDiagnostics=Object.hasOwn(v,'diagnostics');
  exact(v,['schema','epochId','outcome',...flags,'exitCode','exitSignal','closeCode','closeSignal','stderrBytes',...(hasDiagnostics?['diagnostics']:[])]);
  need(v.schema==='standing-epoch-owner-v1'&&typeof v.epochId==='string'&&/^[a-f0-9]{32}$/u.test(v.epochId));
  if(epochId!==undefined)need(v.epochId===epochId);
  one(v.outcome,['observed','unknown']);flags.forEach(k=>bool(v[k]));int(v.stderrBytes,65537);
  for(const k of ['exitCode','closeCode'])if(v[k]!==null)int(v[k],0xffffffff,-0xffffffff);
  for(const k of ['exitSignal','closeSignal'])need(v[k]===null||v[k]==='signalled');
  need(v.replacementReady===v.resourcesSettled);
  if(v.resourcesSettled)need(['bootstrapJoined','activeJoined','processSettled','exitObserved','closeObserved','stderrEnded','stdoutEnded','wireCleanEof'].every(k=>v[k])&&
    !v.streamError&&!v.childError&&v.exitCode===v.closeCode&&v.exitSignal===v.closeSignal);
  need(v.successfulEpoch===(v.outcome==='observed'));
  if(v.successfulEpoch)need(v.resourcesSettled&&v.sessionClosed&&v.epochObserved&&v.supervisorObserved&&
    !v.terminationDispatched&&v.stderrBytes===0&&v.closeCode===0&&v.closeSignal===null);
  // Historical records remain readable, without inventing a missing cause.
  // New diagnostics reuse the exact fixed receipt schemas, not arbitrary logs.
  if(hasDiagnostics){
    const d=v.diagnostics;exact(d,['epoch','supervisor']);
    const epoch=d.epoch===null?null:normalizeEpochResult(d.epoch);
    const supervisor=d.supervisor===null?null:normalizeSupervisorResult(d.supervisor);
    need(v.epochObserved===(epoch?.outcome==='observed'));
    const observed=supervisor?.outcome==='observed'&&
      ['preflight','custodyReady','clientNaturalSettlement','relaySettled','allProcessesSettled','settled'].every(k=>supervisor[k]===true)&&
      supervisor.clientExit===0&&supervisor.relayExit===0&&supervisor.clientStderrBytes===0&&supervisor.relayStderrBytes===0&&supervisor.injectedPorts===false;
    need(v.supervisorObserved===observed);
    if(v.resourcesSettled){
      const proof=epochSettlementProof(epoch,supervisor);
      need(proof.legacy||proof.physical);
    }
  }
  return frozen(v);
}

/** The owner must read this from its exact source-pinned private child pipe.
 * Acceptance proves custody for inner turns, never process or unit settlement.
 * Abort/transport failure/final closure must revoke this gate before admitting
 * another turn. Duplicate or malformed proof also revokes permanently. */
export function createEpochCustodyGate(signal){
  need(signal instanceof AbortSignal);
  let state=signal.aborted?'revoked':'pending',proof;
  const revoke=()=>{state='revoked';signal.removeEventListener('abort',revoke);};
  if(state==='pending')signal.addEventListener('abort',revoke,{once:true});
  return Object.freeze({
    accept(frame){
      try{
        need(state==='pending'&&!signal.aborted);frame=snapshot(frame);exact(frame,['kind','proof']);need(frame.kind==='custodyReady');
        exact(frame.proof,['custody','capabilities']);custody(frame.proof.custody);capabilities(frame.proof.capabilities);
        provedCustody(frame.proof.custody,frame.proof.capabilities,false);
        proof=frame.proof;need(state==='pending'&&!signal.aborted);state='ready';return proof;
      }catch{revoke();fail();}
    },
    ready:()=>state==='ready'&&!signal.aborted,
    revoke,
  });
}
