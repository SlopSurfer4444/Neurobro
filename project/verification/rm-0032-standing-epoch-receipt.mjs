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
const RPC_CODES=['NOT_RUN','OK','CONFIG_REFUSED','PROTOCOL_REFUSED','PHASE_REFUSED','BOUNDS_REFUSED','TRANSPORT_UNKNOWN','CONCURRENT_REFUSED','CLOSED','CLOSE_UNKNOWN','SHUTDOWN_UNKNOWN'];
const RPC_SITES=['none','line','json','envelope','marker','unicode','payload','phase','deadline','cancelled','read','write','selector','eof','response_id'];
const RPC_OPERATIONS=['none','other','initialize','initialized','permissionProfile/list','command/exec','account/read','model/list','modelProvider/capabilities/read','thread/start','turn/start','admit_model','next_frame','respond'];
const STARTUP_FAILURE_CODES=['CONFIG_REFUSED','PREFLIGHT_REFUSED','LAUNCH_UNKNOWN','PROCESS_UNKNOWN','PROCESS_ALIAS_REFUSED','READER_ALIAS_REFUSED','CUSTODY_REFUSED','CAPABILITIES_REFUSED','PROTOCOL_REFUSED','PROBE_REFUSED','RPC_REFUSED','ACCOUNT_REFUSED','MODEL_UNAVAILABLE','BOUNDS_REFUSED','PHASE_REFUSED','TRANSPORT_UNKNOWN','DEADLINE_UNKNOWN','CANCELLED_UNKNOWN','BYTES_REFUSED','INTERNAL_UNKNOWN'];
const sessionCodes=['NOT_RUN','CLOSED','EPOCH_LIMIT','TURN_LIMIT','INPUT_REFUSED','PROTOCOL_REFUSED','IO_UNKNOWN','NATIVE_UNKNOWN','RELEASE_UNKNOWN','INTERNAL_UNKNOWN'];
const idleMethods=["account/login/completed","account/rateLimits/updated","account/read","account/updated","app/list/updated","autoApprovalReview/strictReviewRequired","command/exec","command/exec/outputDelta","configWarning","deprecationNotice","error","externalAgentConfig/import/completed","externalAgentConfig/import/progress","fs/changed","fuzzyFileSearch/sessionCompleted","fuzzyFileSearch/sessionUpdated","guardianWarning","hook/completed","hook/started","initialize","item/agentMessage/delta","item/autoApprovalReview/completed","item/autoApprovalReview/started","item/commandExecution/outputDelta","item/commandExecution/terminalInteraction","item/completed","item/fileChange/outputDelta","item/fileChange/patchUpdated","item/mcpToolCall/progress","item/plan/delta","item/reasoning/summaryPartAdded","item/reasoning/summaryTextDelta","item/reasoning/textDelta","item/started","mcpServer/event/stream/notification","mcpServer/oauthLogin/completed","mcpServer/startupStatus/updated","model/list","model/rerouted","model/safetyBuffering/updated","model/verification","modelProvider/authRecoveryCompleted","modelProvider/authRecoveryStarted","none","other","permissionProfile/list","process/exited","process/outputDelta","project/changed","remoteControl/status/changed","serverRequest/resolved","skills/changed","thread/archived","thread/closed","thread/compacted","thread/deleted","thread/environment/connected","thread/environment/disconnected","thread/goal/cleared","thread/goal/updated","thread/name/updated","thread/project/updated","thread/queue/changed","thread/realtime/closed","thread/realtime/error","thread/realtime/item/completed","thread/realtime/item/started","thread/realtime/item/transcript/delta","thread/realtime/itemAdded","thread/realtime/outputAudio/delta","thread/realtime/sdp","thread/realtime/started","thread/realtime/transcript/delta","thread/realtime/transcript/done","thread/reverted","thread/settings/updated","thread/start","thread/started","thread/status/changed","thread/tokenUsage/updated","thread/unarchived","turn/completed","turn/diff/updated","turn/moderationMetadata","turn/plan/updated","turn/start","turn/started","warning","windows/worldWritableWarning","windowsSandbox/setupCompleted"];
const limits={prepSeconds:120,epochSeconds:900,cleanupSeconds:35,turnLimit:16,threadLimit:1,history:true,images:true,syntheticOnly:false};
const factBools=['threadStarted','poisoned','busy','running','releasePending','closed','resourceSettlementObserved','unreleasedTurn'];
const NATIVE_FAILURE_CODES = ['ANSWER_REFUSED', 'BOUNDS_REFUSED', 'CONFIG_REFUSED', 'CUSTODY_REFUSED', 'INPUT_REFUSED', 'PROTOCOL_REFUSED', 'SESSION_LIMIT', 'THREAD_REFUSED', 'TOOL_EVENT_REFUSED', 'TOOL_REFUSED', 'TRANSPORT_UNKNOWN', 'TURN_REFUSED', 'INTERNAL_UNKNOWN', 'BUSY', 'SESSION_POISONED'];
const NATIVE_FAILURE_SITES = ['answer', 'answer_changed', 'answer_missing', 'arguments', 'config', 'correlation', 'deadline', 'cancelled', 'duplicate_call', 'duplicate_request', 'events', 'exchange', 'frame', 'input', 'item', 'item_timestamp', 'ports', 'request', 'request_id', 'resolved', 'session', 'source', 'spec', 'thread_ack', 'tool_calls', 'tool_item', 'tool_item_changed', 'tool_item_correlation', 'tool_item_missing', 'tool_item_result', 'tool_result', 'tool_wire', 'turn', 'turn_ack', 'web_changed', 'web_item', 'web_unfinished', 'none', 'observer_or_transport', 'other'];
const NATIVE_OBSERVER_SITES = ['account_shape', 'base_protocol', 'delta_shape', 'delta_utf8', 'error_shape', 'event_params', 'item_conflict', 'item_shape', 'item_text', 'item_utf8', 'model_metadata_shape', 'none', 'notification_expected', 'notification_item', 'notification_shape', 'rpc_after_model', 'rpc_budget', 'rpc_frame', 'rpc_id', 'rpc_json', 'rpc_method', 'rpc_result', 'settings_shape', 'status_shape', 'thread_event', 'thread_id', 'thread_response', 'turn_id', 'turn_response', 'turn_shape', 'warning_shape', 'other'];
const NATIVE_IMAGE_FAILURES = ['base64', 'budget', 'conflict', 'correlation', 'envelope', 'failure', 'image-required', 'item', 'lifecycle', 'missing-terminal', 'multiple-images', 'none', 'not-ready', 'png', 'revoked', 'scope', 'shape', 'size', 'status', 'turn-failed', 'other'];
function nativeFailure(v,purposes=['conversation','history-analysis']){
  if(v===null)return;
  exact(v,['purpose','code','site','observerSite','observerMethod','imageOutcome','imageFailure','imageFailureCode','eventCount','eventBytes']);
  one(v.purpose,purposes);one(v.code,NATIVE_FAILURE_CODES);one(v.site,NATIVE_FAILURE_SITES);
  one(v.observerSite,NATIVE_OBSERVER_SITES);one(v.observerMethod,idleMethods);
  one(v.imageOutcome,['not-requested','pending','completed','failed','revoked','other']);one(v.imageFailure,NATIVE_IMAGE_FAILURES);
  one(v.imageFailureCode,['none','usageLimitExceeded','generationFailed','other']);int(v.eventCount,513);int(v.eventBytes,v.purpose==='history-analysis'?2097153:262145);
}
function idleFailure(v){
  if(v===null)return;
  exact(v,['code','site','operation','method','phase','frames','bytes','poisoned','pendingResponses','lateRefusals']);
  one(v.code,['NOT_RUN','OK','CONFIG_REFUSED','PROTOCOL_REFUSED','PHASE_REFUSED','BOUNDS_REFUSED','TRANSPORT_UNKNOWN','CONCURRENT_REFUSED','CLOSED','CLOSE_UNKNOWN','SHUTDOWN_UNKNOWN','SESSION_POISONED','CUSTODY_REFUSED','TOOL_REFUSED','INTERNAL_UNKNOWN','DEADLINE_UNKNOWN']);
  one(v.site,['none','line','json','envelope','marker','unicode','payload','phase','deadline','cancelled','read','write','selector','eof','response_id','other','warning','apps','mcp_status','scope','response_ids','poisoned','frame','budget','method','skills','remote_control','thread','status','turn','token_usage','resolved','request','request_id','correlation','call_id','refusal_budget','response_confirmation','rpc_state']);
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
function scopedFacts(v,purposes,version){
  exact(v,[...factBools,'turnsAttempted','toolCalls','schema','turnsAdmitted','turnLimit','epochSeconds','turnSeconds',
    'threadLimit','threadStartDispatches','turnStartDispatches','slots']);
  factBools.forEach(k=>bool(v[k]));int(v.turnsAttempted,16);int(v.turnsAdmitted,16);int(v.toolCalls,193);
  int(v.threadStartDispatches,purposes.length);int(v.turnStartDispatches,16);
  need(v.schema==='neurobro-native-scoped-epoch-'+version&&v.threadLimit===purposes.length&&v.turnLimit===16&&
    v.epochSeconds===900&&v.turnSeconds===300&&v.resourceSettlementObserved===false);
  need(Array.isArray(v.slots)&&v.slots.length===purposes.length);
  for(const [i,s] of v.slots.entries()){
    exact(s,['purpose','threadStarted','turnsAdmitted','turnsAttempted','toolCalls','closed','poisoned']);
    need(s.purpose===purposes[i]);['threadStarted','closed','poisoned'].forEach(k=>bool(s[k]));
    int(s.turnsAdmitted,16);int(s.turnsAttempted,16);int(s.toolCalls,193);
    if(s.purpose==='community-assessment')need(s.toolCalls===0);
  }
  need(v.slots.reduce((n,s)=>n+s.turnsAdmitted,0)<=v.turnsAdmitted&&
    v.slots.filter(s=>s.threadStarted).length<=v.threadStartDispatches);
}
function scopedNative(n,purposes){
  exact(n,['admitted','threadStartDispatches','turnStartDispatches','threadsAcknowledged','slotWeb']);
  bool(n.admitted);int(n.threadStartDispatches,purposes.length);int(n.turnStartDispatches,16);int(n.threadsAcknowledged,purposes.length);
  need(n.threadsAcknowledged<=n.threadStartDispatches&&Array.isArray(n.slotWeb)&&n.slotWeb.length===purposes.length);
  for(const [i,w] of n.slotWeb.entries()){
    exact(w,['purpose','turnsAttempted',...webCounts]);need(w.purpose===purposes[i]);
    int(w.turnsAttempted,16);webCounts.forEach(k=>int(w[k],512));
    need(w.completed<=w.admitted&&
      w.search+w.openPage+w.findInPage+w.other<=w.completed);
    if(w.turnsAttempted===0||i>0)need(webCounts.every(k=>w[k]===0));
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
  if(v?.schema==='decadans.rm0032.standing-parallel-epoch.v1')return normalizeParallelEpochResult(v);
  exact(v,['schema','outcome','code','stage','injectedPorts','limits','custody','capabilities','native','session','diagnostics','appServer']);
  one(v.schema,['decadans.rm0032.standing-epoch.v1','decadans.rm0032.standing-scoped-epoch.v1','decadans.rm0032.standing-scoped-epoch.v2']);bool(v.injectedPorts);
  const v2=v.schema==='decadans.rm0032.standing-scoped-epoch.v2',scoped=v2||v.schema==='decadans.rm0032.standing-scoped-epoch.v1';
  const selectedPurposes=v2?[...purposes,'community-assessment']:purposes;
  one(v.outcome,['observed','refused','unknown']);one(v.code,codes);one(v.stage,stages);
  exact(v.limits,Object.keys(limits));for(const [k,value] of Object.entries(limits))need(v.limits[k]===(scoped&&k==='threadLimit'?selectedPurposes.length:value));
  const c=v.custody,cap=v.capabilities,n=v.native,s=v.session,d=v.diagnostics,a=v.appServer;
  custody(c);capabilities(cap);
  need(n&&typeof n==='object');const hasWeb=Object.hasOwn(n,'lastTurnWeb');
  if(scoped)scopedNative(n,selectedPurposes);
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
  if(s.facts!==null){if(scoped)scopedFacts(s.facts,selectedPurposes,v2?'v2':'v1');else facts(s.facts);}
  if(scoped&&s.facts!==null)scopedRelations(n,s.facts);
  exact(d,['originalCode','originalStage','cleanupUnknown','rpcCode','rpcSite','rpcOperation','idleFailure',...(Object.hasOwn(d,'nativeFailure')?['nativeFailure']:[])]);if(Object.hasOwn(d,'nativeFailure'))nativeFailure(d.nativeFailure,selectedPurposes);bool(d.cleanupUnknown);one(d.originalCode,codes);one(d.originalStage,stages);idleFailure(d.idleFailure);
  one(d.rpcCode,RPC_CODES);one(d.rpcSite,RPC_SITES);one(d.rpcOperation,RPC_OPERATIONS);
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

/** Source-pinned guest evidence for distinct workers under one outer owner.
 * Child settlement never asserts relay or Windows supervisor settlement. */
export function normalizeParallelEpochResult(value){
  const v=snapshot(value);
  exact(v,['schema','outcome','code','stage','injectedPorts','custodyChildren','pool',...(Object.hasOwn(v,'sessionCode')?['sessionCode']:[]),...(Object.hasOwn(v,'sessionFailure')?['sessionFailure']:[])]);
  if(Object.hasOwn(v,'sessionCode'))one(v.sessionCode,sessionCodes.filter(code=>code!=='NOT_RUN'));
  if(Object.hasOwn(v,'sessionFailure')){
    const f=v.sessionFailure;exact(f,['site','purpose','toolName']);
    need(v.sessionCode==='IO_UNKNOWN'&&v.outcome==='unknown');
    one(f.site,['tool_wait','wire_emit','receive_eof','receive_exception']);
    if(f.site==='tool_wait'){
      one(f.purpose,['conversation','history-analysis']);
      const names=f.purpose==='history-analysis'?['neurobro_analysis_material','neurobro_analysis_notes','neurobro_analysis_commit']:
        ['neurobro_read_history','neurobro_search_chat','neurobro_group_info','neurobro_list_participants','neurobro_fetch_artifact','neurobro_send_artifact','neurobro_create_text_file','neurobro_plan_generated_image_use','neurobro_create_poll','neurobro_read_poll','neurobro_close_poll','neurobro_read_reactions','neurobro_set_reaction','neurobro_self_profile','neurobro_set_display_name','neurobro_set_avatar','neurobro_set_group_avatar','neurobro_find_objects','neurobro_resolve_object','neurobro_repo_info','neurobro_repo_search','neurobro_repo_read','neurobro_create_history_task','neurobro_history_task_status','neurobro_cancel_history_task','neurobro_memory','neurobro_community','neurobro_observation'];
      one(f.toolName,names);
    }else need(f.purpose===null&&f.toolName===null);
  }
  need(v.schema==='decadans.rm0032.standing-parallel-epoch.v1');
  one(v.outcome,['observed','refused','unknown']);one(v.code,codes);one(v.stage,stages);bool(v.injectedPorts);
  const children=normalizeParallelCustodyChildren(v.custodyChildren);
  if(v.pool!==null){
    const p=v.pool;
    const hasStartupFailure=Object.hasOwn(p,'startupFailure');
    exact(p,['schema','epochRef','resourcesSettled','replacementReady','relaySettlementObserved','children','budget',...(hasStartupFailure?['startupFailure']:[])]);
    need(p.schema==='history-parallel-native-pool-v1'&&typeof p.epochRef==='string'&&/^[a-f0-9]{32}$/.test(p.epochRef));
    bool(p.resourcesSettled);bool(p.replacementReady);need(p.replacementReady===p.resourcesSettled&&p.relaySettlementObserved===false);
    need(Array.isArray(p.children)&&p.children.length<=8);
    const ids=new Set(),pids=new Set();
    for(const child of p.children){
      const hasCleanup=Object.hasOwn(child,'cleanup');
      exact(child,['workerId','processId','turnJoined','resourcesSettled','pendingBinding','pendingOutcome',...(hasCleanup?['cleanup']:[]),...(Object.hasOwn(child,'turnFailure')?['turnFailure']:[])]);
      need(typeof child.workerId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(child.workerId)&&!ids.has(child.workerId));ids.add(child.workerId);
      if(child.processId!==null){int(child.processId,Number.MAX_SAFE_INTEGER,1);need(!pids.has(child.processId));pids.add(child.processId);}
      bool(child.turnJoined);bool(child.resourcesSettled);
      if(child.resourcesSettled)need(child.turnJoined&&child.processId!==null);
      if(hasCleanup){
        const c=child.cleanup,flags=['attempted','stdinClosed','stdoutEof','reaped','stderrJoined'];
        exact(c,[...flags,'exitCode']);flags.forEach(k=>bool(c[k]));
        if(c.exitCode!==null)int(c.exitCode,2147483647,-2147483648);
        if(child.resourcesSettled)need(flags.every(k=>c[k])&&c.exitCode===0);
        if(!c.attempted)need(!c.stdoutEof&&!c.reaped&&!c.stderrJoined&&c.exitCode===null);
      }
      if(child.pendingOutcome!==null)one(child.pendingOutcome,['observed','unknown','not-admitted']);
      if(child.pendingBinding===null)need(child.pendingOutcome===null);
      else{
        const b=child.pendingBinding;
        need(child.processId!==null);
        exact(b,['epochRef','workerId','processId','purpose','requestRef','taskRef','planRef','workRef','inputSha256']);
        need(b.epochRef===p.epochRef&&b.workerId===child.workerId&&b.processId===child.processId&&child.pendingOutcome!==null);
        one(b.purpose,['conversation','history-analysis','community-assessment']);
        for(const key of ['requestRef','taskRef','planRef','workRef'])need(typeof b[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(b[key]));
        need(typeof b.inputSha256==='string'&&/^[a-f0-9]{64}$/.test(b.inputSha256));
      }
      if(Object.hasOwn(child,'turnFailure')){
        const f=child.turnFailure;
        exact(f,['stage','code','nativeFailure','rpcFailure',...(Object.hasOwn(f,'timing')?['timing']:[])]);
        need(child.pendingOutcome==='unknown'&&child.pendingBinding!==null);
        one(f.stage,['admit','prepare','actor','result']);
        one(f.code,['CLOCK_UNKNOWN','DEADLINE_UNKNOWN','CANCELLED_UNKNOWN','IDLE_UNKNOWN','RESULT_UNKNOWN','INTERNAL_UNKNOWN','TRANSPORT_UNKNOWN','BOUNDS_REFUSED','BYTES_REFUSED','PHASE_REFUSED','RPC_REFUSED','PROTOCOL_REFUSED','INPUT_REFUSED','WORK_SCOPE_REFUSED','THREAD_UNKNOWN','TURNS_REFUSED']);
        nativeFailure(f.nativeFailure,['conversation','history-analysis','community-assessment']);
        if(f.nativeFailure!==null)need(f.nativeFailure.purpose===child.pendingBinding.purpose);
        if(Object.hasOwn(f,'timing')){
          const t=f.timing;exact(t,['cause','turnElapsedMs','turnBudgetMs','epochElapsedMs','epochBudgetMs','closeElapsedMs']);
          one(t.cause,['cancelled','turn-deadline','epoch-deadline','rpc-deadline','clock-regressed','other']);
          for(const key of ['turnElapsedMs','epochElapsedMs','closeElapsedMs'])if(t[key]!==null)int(t[key],86400000);
          int(t.turnBudgetMs,300000);need(t.turnBudgetMs===(child.pendingBinding.purpose==='community-assessment'?30000:300000));
          int(t.epochBudgetMs,900000,1);
          if(t.closeElapsedMs!==null&&t.epochElapsedMs!==null)need(t.closeElapsedMs<=t.epochElapsedMs);
          if(t.cause==='clock-regressed')need(f.code==='CLOCK_UNKNOWN');
          if(t.cause==='cancelled')need(f.code==='CANCELLED_UNKNOWN'||f.nativeFailure?.site==='cancelled'||f.rpcFailure?.site==='cancelled');
          if(['turn-deadline','epoch-deadline','rpc-deadline'].includes(t.cause))need(f.code==='DEADLINE_UNKNOWN'||f.nativeFailure?.site==='deadline'||f.rpcFailure?.site==='deadline');
          if(t.cause==='turn-deadline')need(t.turnElapsedMs!==null&&t.turnElapsedMs>=t.turnBudgetMs);
          if(t.cause==='epoch-deadline')need(t.epochElapsedMs!==null&&t.epochElapsedMs>=t.epochBudgetMs);
        }
        if(f.rpcFailure!==null){
          const r=f.rpcFailure;exact(r,['code','site','operation','phase']);
          one(r.code,RPC_CODES);one(r.site,RPC_SITES);one(r.operation,RPC_OPERATIONS);one(r.phase,['custody','model','poisoned','shutdown']);
        }
      }
      const custodyChild=children.find(c=>c.workerId===child.workerId);
      if(custodyChild)need(custodyChild.processId===child.processId&&(!child.pendingBinding||custodyChild.purpose===child.pendingBinding.purpose));
    }
    for(const child of children)need(p.children.some(c=>c.workerId===child.workerId&&c.processId===child.processId));
    const b=p.budget;
    exact(b,['turnStartDispatches','foregroundDispatches','turnsAdmitted','foregroundAdmissions','reservedReadBytes','reservedWriteBytes','closed']);
    for(const key of ['turnStartDispatches','foregroundDispatches','turnsAdmitted','foregroundAdmissions'])int(b[key],16);
    int(b.reservedReadBytes,16*(66*1024*1024)+8*1024*1024);
    int(b.reservedWriteBytes,16*(18*1024*1024+65536)+1024*1024+16*12*1024*1024);
    bool(b.closed);
    need(b.turnStartDispatches<=b.turnsAdmitted&&b.foregroundDispatches<=b.turnStartDispatches&&b.foregroundAdmissions<=b.turnsAdmitted&&b.foregroundDispatches<=b.foregroundAdmissions);
    if(hasStartupFailure){
      const s=p.startupFailure;
      exact(s,['workerId','stage','code','custodyStage','probeIndex','rpcFailure']);
      need(typeof s.workerId==='string'&&/^worker-[0-7]$/.test(s.workerId));
      one(s.stage,['launch','rpc','custody','admit','actor']);one(s.code,STARTUP_FAILURE_CODES);
      if(s.custodyStage!==null)one(s.custodyStage,['initialize','profile','probes','account','models']);
      if(s.probeIndex!==null){int(s.probeIndex,8);need(s.custodyStage==='probes');}
      if(s.rpcFailure!==null){
        const r=s.rpcFailure;exact(r,['code','site','operation','phase']);
        one(r.code,RPC_CODES);one(r.site,RPC_SITES);one(r.operation,RPC_OPERATIONS);one(r.phase,['custody','model','poisoned','shutdown']);
      }
      need(v.outcome!=='observed'&&['turnStartDispatches','foregroundDispatches','turnsAdmitted','foregroundAdmissions'].every(k=>b[k]===0));
      need(p.children.every(c=>c.pendingBinding===null));
      need(ids.has(s.workerId)||(s.stage==='launch'&&p.children.length<8&&s.workerId==='worker-'+p.children.length));
    }
    if(p.resourcesSettled)need(b.closed&&p.children.length>0&&v.code!=='LAUNCH_UNKNOWN'&&p.children.every(c=>c.resourcesSettled));
  }
  if(v.outcome==='observed'){
    need(v.code==='OK'&&v.stage==='complete'&&v.pool?.resourcesSettled===true&&children.length>=2&&v.pool.children.length===children.length);
    need(children.filter(c=>c.purpose==='conversation').length===1&&children.some(c=>c.purpose==='history-analysis'));
    need(v.pool.children.every(c=>c.pendingBinding===null||c.pendingOutcome==='not-admitted'));
  }
  return frozen(v);
}

export function normalizeParallelCustodyChildren(value){
  const children=snapshot(value);
  need(Array.isArray(children)&&children.length<=8);
  const ids=new Set(),pids=new Set();
  for(const child of children){
    exact(child,['workerId','processId','purpose','custody','capabilities']);
    need(typeof child.workerId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(child.workerId)&&!ids.has(child.workerId));ids.add(child.workerId);
    int(child.processId,Number.MAX_SAFE_INTEGER,1);need(!pids.has(child.processId));pids.add(child.processId);
    one(child.purpose,['conversation','history-analysis','community-assessment']);
    custody(child.custody);capabilities(child.capabilities);provedCustody(child.custody,child.capabilities,false);
    need(child.custody.relayAfter===false&&child.capabilities.webSearch===true);
  }
  need(children.filter(c=>c.purpose==='conversation').length<=1&&children.filter(c=>c.purpose==='community-assessment').length<=1);
  return frozen(children);
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
    const hasRelayDiagnostics=Object.hasOwn(v.relay,'diagnostics');
    exact(v.relay,['version','settled','counters',...(hasRelayDiagnostics?['diagnostics']:[])]);need(v.relay.version===1&&v.relay.settled===true);
    exact(v.relay.counters,['accepted','over_limit','refused','connected','completed','failed','cancelled','internal_error']);
    const counts=v.relay.counters;Object.values(counts).forEach(n=>int(n,1000000));
    if(!hasRelayDiagnostics)need(counts.accepted<=64);
    else{
      const d=v.relay.diagnostics;
      exact(d,['schema','workerCount','turnLimit','toolCallLimit','toolRefusalLimit','maxAccepted','maxConcurrent','reservedBytes','rejections','failures']);
      need(d.schema==='standing-relay-budget-v1');int(d.workerCount,8,1);
      need(d.turnLimit===16&&d.toolCallLimit===8&&d.toolRefusalLimit===4);
      need(d.maxAccepted===8+8*d.workerCount+4*16*(1+8+4)&&d.maxConcurrent===Math.max(8,4*d.workerCount));
      int(d.reservedBytes,1024*1024*1024);need(counts.accepted<=d.maxAccepted);
      exact(d.rejections,['closing','concurrent','acceptedLimit']);
      exact(d.failures,['header','dns','connect','response','tunnelIdle','tunnelDuration','tunnelBytes','aggregateBytes','tunnelIo','tunnelOther']);
      for(const group of [d.rejections,d.failures])Object.values(group).forEach(n=>int(n,1000000));
      need(Object.values(d.rejections).reduce((a,b)=>a+b,0)===counts.over_limit);
      need(Object.values(d.failures).reduce((a,b)=>a+b,0)===counts.failed+counts.refused);
      need(counts.completed<=counts.connected&&counts.connected<=counts.accepted-counts.refused);
      need(counts.completed+counts.failed+counts.refused+counts.cancelled<=counts.accepted);
      if(v.client!==null){
        if(v.client.schema==='decadans.rm0032.standing-parallel-epoch.v1'){
          need(v.client.custodyChildren.length<=d.workerCount);
          if(v.client.outcome==='observed')need(v.client.custodyChildren.length===d.workerCount);
        }else need(d.workerCount===1);
      }
    }
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
export function createEpochCustodyGate(signal,parallelOptions){
  need(signal instanceof AbortSignal);
  if(parallelOptions!==undefined){
    parallelOptions=snapshot(parallelOptions);exact(parallelOptions,['analysisWorkers','communityAssessment']);
    int(parallelOptions.analysisWorkers,7,1);bool(parallelOptions.communityAssessment);
    need(parallelOptions.analysisWorkers+1+Number(parallelOptions.communityAssessment)<=8);
  }
  let state=signal.aborted?'revoked':'pending',proof;
  const revoke=()=>{state='revoked';signal.removeEventListener('abort',revoke);};
  if(state==='pending')signal.addEventListener('abort',revoke,{once:true});
  return Object.freeze({
    accept(frame){
      try{
        need(state==='pending'&&!signal.aborted);frame=snapshot(frame);exact(frame,['kind','proof']);
        if(parallelOptions!==undefined){
          need(frame.kind==='poolCustodyReady');
          const children=normalizeParallelCustodyChildren(frame.proof);
          need(children.length===parallelOptions.analysisWorkers+1+Number(parallelOptions.communityAssessment)&&
            children.filter(c=>c.purpose==='conversation').length===1&&
            children.filter(c=>c.purpose==='history-analysis').length===parallelOptions.analysisWorkers&&
            children.filter(c=>c.purpose==='community-assessment').length===Number(parallelOptions.communityAssessment));
        }else{
          need(frame.kind==='custodyReady');
          exact(frame.proof,['custody','capabilities']);custody(frame.proof.custody);capabilities(frame.proof.capabilities);
          provedCustody(frame.proof.custody,frame.proof.capabilities,false);
        }
        proof=frame.proof;need(state==='pending'&&!signal.aborted);state='ready';return proof;
      }catch{revoke();fail();}
    },
    ready:()=>state==='ready'&&!signal.aborted,
    revoke,
  });
}
