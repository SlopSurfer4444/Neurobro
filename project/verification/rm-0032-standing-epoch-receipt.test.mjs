import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeEpochResult,createEpochCustodyGate,normalizeSupervisorResult} from './rm-0032-standing-epoch-receipt.mjs';

// Actual Python custody/native/session composition over anonymous Linux pipes,
// fake App Server only. Its emitted metadata crosses into these JS validators.
// No credentials, actual subprocess model launch, Telegram or remote network.
const command=spawnSync(process.execPath,[fileURLToPath(new URL('./rm-0032-standing-epoch-diagnostics-fixture.mjs',import.meta.url)),'--receipts'],{encoding:'utf8',timeout:45000,maxBuffer:131072,windowsHide:true});
assert.equal(command.error,undefined);assert.equal(command.status,0,command.stderr);
const lines=command.stdout.trim().split(/\r?\n/u).map(line=>JSON.parse(line));
const fixtures=lines.find(v=>v.schema==='epoch-client-host-fixture-v1');assert.ok(fixtures);
const byMode=Object.fromEntries(fixtures.records.map(v=>[v.mode,v]));
const clone=v=>structuredClone(v);

test('native failure diagnostics preserve bounded evidence without changing successful or legacy admission',()=>{
  const legacy=clone(byMode.ok.result);delete legacy.diagnostics.nativeFailure;
  assert.deepEqual(normalizeEpochResult(legacy),legacy);
  const failure={purpose:'conversation',code:'BOUNDS_REFUSED',site:'events',observerSite:'none',observerMethod:'none',
    imageOutcome:'completed',imageFailure:'none',imageFailureCode:'none',eventCount:12,eventBytes:262145};
  const value=clone(byMode.ok.result);value.outcome='unknown';value.code='SESSION_UNKNOWN';value.diagnostics.nativeFailure=failure;
  assert.deepEqual(normalizeEpochResult(value).diagnostics.nativeFailure,failure);
  for(const patch of [{code:'private text'},{imageFailure:'data:image/png;base64,SECRET'},{eventBytes:262146},{eventCount:true},{url:'secret'}]){
    const bad=clone(value);Object.assign(bad.diagnostics.nativeFailure,patch);assert.throws(()=>normalizeEpochResult(bad));
  }
  const analysis=clone(value);analysis.diagnostics.nativeFailure={...failure,purpose:'history-analysis',eventBytes:2097153};
  assert.equal(normalizeEpochResult(analysis).diagnostics.nativeFailure.eventBytes,2097153);
  analysis.diagnostics.nativeFailure.eventBytes=2097154;assert.throws(()=>normalizeEpochResult(analysis));
  const observed=clone(byMode.ok.result);observed.diagnostics.nativeFailure=failure;assert.throws(()=>normalizeEpochResult(observed));
});

function withWeb(){
  const value=clone(byMode.ok.result);value.capabilities.webSearch=true;
  value.native.lastTurnWeb={turnAttempted:2,admitted:3,completed:3,search:1,openPage:1,findInPage:1,other:0};
  return value;
}

test('last attempted web turn is immutable metadata while exact legacy receipts remain compatible',()=>{
  const legacy=clone(byMode.ok.result);delete legacy.native.lastTurnWeb;legacy.capabilities.webSearch=false;
  assert.deepEqual(normalizeEpochResult(legacy),legacy);
  const value=withWeb(),normalized=normalizeEpochResult(value);
  assert.deepEqual(normalized,value);assert.ok(Object.isFrozen(normalized.native.lastTurnWeb));
  value.native.lastTurnWeb.search=0;assert.equal(normalized.native.lastTurnWeb.search,1);
  const priorTurn=withWeb();priorTurn.native.lastTurnWeb.turnAttempted=1;
  assert.equal(normalizeEpochResult(priorTurn).native.lastTurnWeb.turnAttempted,1);
  const missingCapability=withWeb();missingCapability.capabilities.webSearch=false;
  assert.throws(()=>normalizeEpochResult(missingCapability),/RECEIPT_REFUSED/u);
  missingCapability.outcome='unknown';
  assert.equal(normalizeEpochResult(missingCapability).native.lastTurnWeb.completed,3);
});

test('web counters enforce turn association, unfinished bounds and action totals without inventing backend counts',()=>{
  const zero=withWeb();zero.native.lastTurnWeb={turnAttempted:0,admitted:0,completed:0,search:0,openPage:0,findInPage:0,other:0};
  assert.deepEqual(normalizeEpochResult(zero).native.lastTurnWeb,zero.native.lastTurnWeb);
  const maximum=withWeb();maximum.outcome='unknown';maximum.native.turnStartDispatches=16;
  maximum.native.lastTurnWeb={turnAttempted:16,admitted:512,completed:512,search:509,openPage:1,findInPage:1,other:1};
  assert.equal(normalizeEpochResult(maximum).native.lastTurnWeb.admitted,512);
  const unfinished=withWeb();unfinished.outcome='unknown';unfinished.native.lastTurnWeb.completed=1;
  unfinished.native.lastTurnWeb.openPage=0;unfinished.native.lastTurnWeb.findInPage=0;
  assert.equal(normalizeEpochResult(unfinished).native.lastTurnWeb.completed,1);
  for(const change of [w=>{w.turnAttempted=3;},w=>{w.turnAttempted=17;},w=>{w.turnAttempted=0;},
    w=>{w.completed=4;},w=>{w.other=1;},w=>{w.admitted=513;},w=>{w.search=-1;},
    w=>{w.completed=0.5;},w=>{w.turnAttempted=true;},w=>{w.search=NaN;},w=>{w.other=Infinity;}]){
    const value=withWeb();value.outcome='unknown';change(value.native.lastTurnWeb);
    assert.throws(()=>normalizeEpochResult(value),/RECEIPT_REFUSED/u);
  }
});

test('new web receipt shape rejects raw fields and accessors without widening RPC diagnostic sites',()=>{
  for(const change of [n=>{n.lastTurnWeb=null;},n=>{delete n.lastTurnWeb.completed;},
    n=>{n.lastTurnWeb.query='private';},n=>{n.lastTurnWeb.epochTotals={};},n=>{n.extra=true;}]){
    const value=withWeb();change(value.native);assert.throws(()=>normalizeEpochResult(value),/RECEIPT_REFUSED/u);
  }
  const getter=withWeb();let evaluated=false;
  Object.defineProperty(getter.native.lastTurnWeb,'search',{enumerable:true,get(){evaluated=true;return 1;}});
  assert.throws(()=>normalizeEpochResult(getter),/RECEIPT_REFUSED/u);assert.equal(evaluated,false);
  const site=withWeb();site.diagnostics.rpcSite='web_item';
  assert.throws(()=>normalizeEpochResult(site),/RECEIPT_REFUSED/u);
});

test('actual Python first idle failure retains fixed method/site/phase and matches Node mutation verdicts',()=>{
  assert.equal(byMode['startup-warnings'].result.outcome,'observed');assert.equal(byMode['startup-warnings'].result.diagnostics.idleFailure,null);
  const failure=normalizeEpochResult(byMode['startup-warning-invalid'].result).diagnostics.idleFailure;
  assert.equal(failure.method,'configWarning');assert.equal(failure.site,'warning');assert.equal(failure.operation,'observe');assert.equal(failure.phase,'before-first-turn');
  assert.equal(byMode['startup-other'].result.diagnostics.idleFailure.method,'other');assert.equal(byMode['after-warning-invalid'].result.diagnostics.idleFailure.phase,'after-turn');
  for(const {value,accepted} of fixtures.idleParity){
    if(accepted)assert.deepEqual(normalizeEpochResult(value),value);else assert.throws(()=>normalizeEpochResult(value));
  }
  const forged=clone(byMode.ok.result);forged.diagnostics.idleFailure=failure;assert.throws(()=>normalizeEpochResult(forged));
  assert.equal(JSON.stringify(byMode['startup-warning-invalid'].result).includes('private'),false);
});

function outer(client=byMode.ok.result){
  return {schema:'standing-epoch-supervisor-v1',outcome:'observed',stage:'complete',
    preflight:true,custodyReady:true,clientNaturalSettlement:true,relaySettled:true,allProcessesSettled:true,settled:true,injectedPorts:false,
    clientExit:0,relayExit:0,clientStdoutBytes:1000,clientStderrBytes:0,relayStdoutBytes:100,relayStderrBytes:0,client,
    relay:{version:1,settled:true,counters:{accepted:1,over_limit:0,refused:0,connected:1,completed:1,failed:0,cancelled:0,internal_error:0}}};
}

test('outer proof remains distinct from actual Python client completion and is immutable',()=>{
  const value=outer(),normalized=normalizeSupervisorResult(value);
  assert.deepEqual(normalized,value);assert.ok(Object.isFrozen(normalized.client.session.facts));
  assert.ok(Object.isFrozen(normalized.relay.counters));
  value.relay.counters.accepted=2;assert.equal(normalized.relay.counters.accepted,1);
  for(const key of ['preflight','custodyReady','clientNaturalSettlement','relaySettled','allProcessesSettled','settled']){
    const invalid=outer();invalid[key]=false;assert.throws(()=>normalizeSupervisorResult(invalid));
    invalid.outcome='unknown';assert.equal(normalizeSupervisorResult(invalid).outcome,'unknown');
  }
});

test('outer observed cannot hide unknown inner completion, absent relay or malformed transport facts',()=>{
  for(const edit of [v=>{v.client=byMode['not-reaped'].result;},v=>{v.relay=null;},v=>{v.clientExit=1;},v=>{v.relayExit=null;},
    v=>{v.clientStdoutBytes=203423744+65537;},v=>{v.relay.counters.accepted=65;},v=>{v.relay.settled=false;},
    v=>{v.relay.counters.failed=1.5;},v=>{v.injectedPorts=1;},v=>{v.stderr='private';}]){
    const value=outer();edit(value);assert.throws(()=>normalizeSupervisorResult(value),/RECEIPT_REFUSED/u);
  }
  const value=outer();let invoked=false;
  Object.defineProperty(value.relay,'settled',{enumerable:true,get(){invoked=true;return true;}});
  assert.throws(()=>normalizeSupervisorResult(value));assert.equal(invoked,false);
});

test('actual observed and unknown Python receipts preserve separate settlement facts',()=>{
  for(const item of fixtures.records)assert.deepEqual(normalizeEpochResult(item.result),item.result);
  const observed=normalizeEpochResult(byMode.ok.result);
  assert.equal(observed.outcome,'observed');assert.equal(observed.native.turnStartDispatches,2);
  assert.equal(observed.appServer.reaped,true);assert.equal(observed.session.facts.resourceSettlementObserved,false);
  assert.equal(normalizeEpochResult(byMode['not-reaped'].result).outcome,'unknown');
  assert.equal(normalizeEpochResult(byMode['idle-stop'].result).code,'TRANSPORT_UNKNOWN');
});

test('successful turns cannot forge epoch observation when actual cleanup or transport is unknown',()=>{
  for(const mode of ['not-reaped','idle-stop']){
    const value=clone(byMode[mode].result);value.outcome='observed';value.code='OK';value.stage='complete';
    assert.throws(()=>normalizeEpochResult(value),/RECEIPT_REFUSED/u);
  }
  for(const field of ['reaped','stdoutEof','stderrComplete']){
    const value=clone(byMode.ok.result);value.appServer[field]=false;
    assert.throws(()=>normalizeEpochResult(value),/RECEIPT_REFUSED/u);
  }
});

test('unreleased delivery or inconsistent turn counts cannot become an observed epoch',()=>{
  for(const change of [v=>{v.session.facts.unreleasedTurn=true;},v=>{v.native.turnStartDispatches=1;},v=>{v.session.facts.resourceSettlementObserved=true;},v=>{v.custody.probeExitCodes[3]=0;}]){
    const value=clone(byMode.ok.result);change(value);assert.throws(()=>normalizeEpochResult(value),/RECEIPT_REFUSED/u);
  }
});

test('normalization snapshots nested metadata and rejects payload or invalid value shapes',()=>{
  const original=clone(byMode.ok.result),normalized=normalizeEpochResult(original);
  original.custody.probePass[0]=false;assert.equal(normalized.custody.probePass[0],true);
  assert.ok(Object.isFrozen(normalized.session.facts));assert.ok(Object.isFrozen(normalized.custody.probeExitCodes));
  for(const change of [v=>{v.answer='private';},v=>{v.limits.threadLimit=true;},v=>{v.session.facts.turnsAdmitted=NaN;},v=>{v.appServer.exitCode=1.5;},v=>{delete v.custody.probePass[3];}]){
    const value=clone(byMode.ok.result);change(value);assert.throws(()=>normalizeEpochResult(value),/RECEIPT_REFUSED/u);
  }
});

test('custody proof precedes inner ready and is revoked on abort without asserting final settlement',()=>{
  const abort=new AbortController(),gate=createEpochCustodyGate(abort.signal);
  assert.equal(gate.ready(),false);
  const input=clone(byMode.ok.custodyFrame),proof=gate.accept(input);
  assert.equal(proof.custody.relayAfter,false);assert.equal(gate.ready(),true);
  input.proof.custody.controlsPassed=false;assert.equal(proof.custody.controlsPassed,true);
  abort.abort();assert.equal(gate.ready(),false);assert.throws(()=>gate.accept(byMode.ok.custodyFrame));
});

test('duplicate, missing or malformed custody proof permanently revokes the gate',()=>{
  const gate=createEpochCustodyGate(new AbortController().signal);gate.accept(byMode.ok.custodyFrame);
  assert.throws(()=>gate.accept(byMode.ok.custodyFrame));assert.equal(gate.ready(),false);
  for(const frame of [{kind:'ready'},null,{...clone(byMode.ok.custodyFrame),extra:'private'}]){
    const invalid=createEpochCustodyGate(new AbortController().signal);
    assert.throws(()=>invalid.accept(frame));assert.equal(invalid.ready(),false);
    assert.throws(()=>invalid.accept(byMode.ok.custodyFrame));
  }
});

test('failed capability and any individual custody probe cannot admit native turns',()=>{
  for(let i=0;i<9;i++){
    const gate=createEpochCustodyGate(new AbortController().signal),frame=clone(byMode.ok.custodyFrame);
    frame.proof.custody.probePass[i]=false;assert.throws(()=>gate.accept(frame));assert.equal(gate.ready(),false);
  }
  const gate=createEpochCustodyGate(new AbortController().signal),frame=clone(byMode.ok.custodyFrame);
  frame.proof.capabilities.imageGeneration=false;assert.throws(()=>gate.accept(frame));assert.equal(gate.ready(),false);
});

test('accessors are not evaluated as metadata',()=>{
  const value=clone(byMode.ok.result);let reads=0;
  Object.defineProperty(value.native,'admitted',{enumerable:true,get(){reads++;return true;}});
  assert.throws(()=>normalizeEpochResult(value));assert.equal(reads,0);
});

test('array serialization hooks cannot revoke and then reopen custody or forge its snapshot',()=>{
  const gate=createEpochCustodyGate(new AbortController().signal),frame=clone(byMode.ok.custodyFrame);let invoked=0;
  frame.proof.custody.probePass.toJSON=()=>{invoked++;gate.revoke();return Array(9).fill(false);};
  assert.throws(()=>gate.accept(frame));assert.equal(invoked,0);assert.equal(gate.ready(),false);
  const value=clone(byMode.ok.result);value.custody.probePass.toJSON=()=>{invoked++;return Array(9).fill(false);};
  assert.throws(()=>normalizeEpochResult(value));assert.equal(invoked,0);
});

test('array getters, symbols, inherited hooks and extra properties are rejected without evaluation',()=>{
  for(const change of [a=>Object.defineProperty(a,'0',{enumerable:true,get(){throw new Error('EVALUATED');}}),
    a=>{a[Symbol('private')]=1;},a=>{a.extra=1;},a=>Object.setPrototypeOf(a,{toJSON(){throw new Error('EVALUATED');}})]){
    const value=clone(byMode.ok.result);change(value.custody.probeExitCodes);
    assert.throws(()=>normalizeEpochResult(value),/RECEIPT_REFUSED/u);
  }
});

test('replaced every cannot accept failed probes and reentrant capture cannot reopen a revoked gate',()=>{
  const denied=createEpochCustodyGate(new AbortController().signal),bad=clone(byMode.ok.custodyFrame);
  bad.proof.custody.probePass=Array(9).fill(false);bad.proof.custody.probePass.every=()=>true;
  assert.throws(()=>denied.accept(bad));assert.equal(denied.ready(),false);
  const gate=createEpochCustodyGate(new AbortController().signal),frame=clone(byMode.ok.custodyFrame);
  const proxy=new Proxy(frame,{ownKeys(target){gate.revoke();return Reflect.ownKeys(target);}});
  assert.throws(()=>gate.accept(proxy));assert.equal(gate.ready(),false);
});
