import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { normalizeEpochOwnerRecord } from './rm-0032-standing-epoch-receipt.mjs';
import { runInNewContext } from 'node:vm';
import { makeWorkerIntent, validateWorkerIntent, lockBytes, ownedLockPort, locateOwnedStaleLock,
  normalizeStandingResult, settledModelReceipt, verifyStandingBuild, readMetadata, MUTEX_SCRIPT, WINDOWS_CONTROLLERS_SCRIPT, statusWriter,
  reconcileStandingState, recoveryDisposition, classifyHostExit, preservePause, acquireHostMutex, publicHelper, prepareModel, BUILD } from './rm-0032-standing-host.mjs';
const HASH = 'a'.repeat(64), TOKEN = 'b'.repeat(32);
const historyModules = ['standing-scoped-epoch-session', 'standing-history-analysis-attempt-store', 'standing-history-analysis-planner',
  'standing-history-analysis-runtime', 'standing-history-analysis-step', 'standing-history-analysis-store', 'standing-history-analysis-view',
  'standing-history-read-runner', 'standing-history-read-step', 'standing-history-source-projection', 'standing-history-task-control-store',
  'standing-history-task-delivery', 'standing-history-task-discovery', 'standing-history-task-disposition', 'standing-history-task-manager',
  'standing-history-task-request', 'standing-history-task-runner', 'standing-history-task-runtime', 'standing-history-task-store', 'standing-history-task-tools',
  'standing-chronicle-note', 'standing-history-task-context', 'standing-history-task-memory',
  'standing-own-action-capture', 'standing-own-action-checkpoint', 'standing-own-action-memory', 'standing-own-action-projection',
  'standing-input-image', 'standing-visual-input', 'standing-media-read-port', 'standing-own-action-reader', 'standing-shared-context-binding', 'standing-shared-context-reader', 'standing-shared-context'];
const make = () => makeWorkerIntent(HASH, 123, TOKEN, 1700000000000);
function fixture(t) {
  const parent = resolve(tmpdir()), dir = mkdtempSync(join(parent, 'standing-host-invented-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(parent + sep)); assert.ok(dir.includes('standing-host-invented-')); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
test('worker intent binds exact planned lock before lock creation and contains no credential fields', () => {
  const value = make(); assert.deepEqual(validateWorkerIntent(value), value);
  assert.equal(JSON.parse(lockBytes(value)).ownershipNonce, value.lock.ownershipNonce);
  assert.equal(value.lock.pid, value.pid); assert.equal(value.lock.processStartIdentity, value.startedAt);
  for (const key of ['apiId', 'apiHash', 'passphrase', 'text', 'answer']) assert.equal(JSON.stringify(value).includes('"' + key + '"'), false);
});
test('bad worker identity, extra fields and substituted lock cannot be admitted', () => {
  for (const change of [v => v.pid++, v => v.nodeSha256 = HASH, v => v.workerToken = '../bad', v => v.lock.bootNonce = 'bad',
    v => v.lock.processStartIdentity = 'bad', v => v.raw = 'private']) {
    const value = make(); change(value); assert.throws(() => validateWorkerIntent(value));
  }
});
test('exclusive lock refuses overlap, preserves replacement, releases only exact owned bytes', async t => {
  const dir = fixture(t), file = resolve(dir, 'session.enc.owner.lock'), value = make();
  const acquire = ownedLockPort(value, file); const release = await acquire(file);
  assert.equal(readFileSync(file, 'utf8'), lockBytes(value));
  await assert.rejects(acquire(file));
  writeFileSync(file, 'replacement'); await assert.rejects(release()); assert.equal(readFileSync(file, 'utf8'), 'replacement');
  writeFileSync(file, lockBytes(value)); await release(); assert.equal(existsSync(file), false); await release();
});
test('sticky marker and preexisting pilot lock are preserved without admission', async t => {
  const dir = fixture(t), file = resolve(dir, 'session.enc.owner.lock');
  writeFileSync(file + '.sticky', 'invented'); await assert.rejects(ownedLockPort(make(), file)(file));
  assert.equal(existsSync(file), false); assert.equal(readFileSync(file + '.sticky', 'utf8'), 'invented');
});
test('stale reconciliation selector requires exact historical lock bytes and dead owner', () => {
  const value = make(), bytes = lockBytes(value);
  assert.equal(locateOwnedStaleLock(bytes, [value], () => false), value);
  assert.throws(() => locateOwnedStaleLock(bytes, [value], () => true));
  assert.throws(() => locateOwnedStaleLock(bytes, [], () => false));
  assert.throws(() => locateOwnedStaleLock(bytes, [value, value], () => false));
  assert.throws(() => locateOwnedStaleLock(bytes.replace(value.lock.ownershipNonce, 'f'.repeat(64)), [value], () => false));
});
test('safe model settlement is separate from successful response', () => {
  const value = { version: 'modeltext-host-v1', outcome: 'unknown', guestSettled: true, exitCode: 0,
    transportError: false, timedOut: false, aborted: false, overflow: false };
  assert.equal(settledModelReceipt(value), true);
  for (const key of ['transportError', 'timedOut', 'aborted', 'overflow']) assert.equal(settledModelReceipt({ ...value, [key]: true }), false);
  assert.equal(settledModelReceipt({ ...value, guestSettled: false }), false);
});
test('result projection never retains raw code or private fields', () => {
  const value = normalizeStandingResult({ status: 'blocked', code: 'INVENTED PRIVATE ERROR', clientSettled: true, lockPreserved: true, verifiedReplies: 3, text: 'PRIVATE' });
  assert.equal(value.code, 'STANDING_BLOCKED'); assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  assert.throws(() => normalizeStandingResult({ status: 'stopped', clientSettled: 'yes', lockPreserved: false, verifiedReplies: 0 }));
});
test('metadata reader bounds regular JSON without interpreting secrets or malformed files', t => {
  const dir = fixture(t), file = resolve(dir, 'invented.json'); writeFileSync(file, JSON.stringify(make()));
  assert.equal(readMetadata(file).pid, 123); assert.throws(() => readMetadata(file, 2));
  writeFileSync(file, 'not-json'); assert.throws(() => readMetadata(file));
});
test('status snapshots retain only fixed events and reply counts, atomically replacing the previous state', t => {
  const dir = fixture(t), notify = statusWriter(dir, () => '2026-09-10T12:00:00.000Z');
  notify('STANDING_ONLINE'); assert.equal(readMetadata(resolve(dir, 'status.json')).verifiedReplies, 0);
  notify('STANDING_MODEL'); notify('STANDING_REPLY_VERIFIED'); notify('STANDING_ONLINE');
  assert.deepEqual(readMetadata(resolve(dir, 'status.json')), { version: 'standing-status-v1', code: 'STANDING_ONLINE', at: '2026-09-10T12:00:00.000Z', verifiedReplies: 1 });
  assert.throws(() => notify('PRIVATE RAW ERROR')); assert.equal(readMetadata(resolve(dir, 'status.json')).verifiedReplies, 1);
});
test('full build verifier checks dependencies and required standing entrypoints', t => {
  const dir = fixture(t), names = ['standing-host.mjs', 'standing-recovery.py', 'src/standing-service.js', 'src/windows-credential-vault.js', 'src/pilot-greeting.js',
    'model/rm-0032-standing-epoch-host.mjs', 'model/rm-0032-standing-epoch-runtime.mjs',
    'model/rm-0032-standing-epoch-owner.mjs', 'model/rm-0032-standing-epoch-receipt.mjs',
    'src/standing-epoch-session.js', 'src/standing-epoch-wire.js', 'src/standing-native-turn.js', 'src/standing-context-restoration.js',
    'src/self-history-reader.js', 'src/self-history-tool.js', 'src/standing-repository-tools.js', 'repository-snapshot.json', 'src/conversation-references.js',
    'src/generated-image-receiver.js', 'src/standing-model-result.js', 'package.json', ...historyModules.map(name => `src/${name}.js`)];
  mkdirSync(resolve(dir, 'src')); mkdirSync(resolve(dir, 'model'));
  const manifest = names.map(path => { const bytes = Buffer.from('invented file ' + path); writeFileSync(resolve(dir, path), bytes);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') }; });
  const bytes = Buffer.from(JSON.stringify(manifest)), hash = createHash('sha256').update(bytes).digest('hex');
  verifyStandingBuild(dir, bytes, hash);
  for (const module of historyModules) {
    const name = `src/${module}.js`, missing = manifest.filter(entry => entry.path !== name), absent = Buffer.from(JSON.stringify(missing));
    rmSync(resolve(dir, name));
    assert.throws(() => verifyStandingBuild(dir, absent, createHash('sha256').update(absent).digest('hex')));
    writeFileSync(resolve(dir, name), 'invented file ' + name);
  }
  writeFileSync(resolve(dir, 'unexpected.js'), 'invented'); assert.throws(() => verifyStandingBuild(dir, bytes, hash));
});

test('pure model preparation imports the scoped session and validates scoped capsule without opening runtime', async t => {
  const dir = fixture(t); mkdirSync(resolve(dir, 'src')); mkdirSync(resolve(dir, 'model'));
  const files = {
    'package.json': JSON.stringify({type:'module'}), 'repository-snapshot.json': JSON.stringify({invented:true}),
    'model/rm-0032-standing-epoch-runtime.mjs': 'export function prepareStandingEpochRuntime(){throw new Error("runtime must not open");}',
    'model/rm-0032-standing-epoch-host.mjs': `import assert from 'node:assert/strict'; import {createHash} from 'node:crypto';
      export const SOURCE_NAMES={client:'invented-client.py'};
      export function preparePacket(input){assert.deepEqual(Object.keys(input).sort(),['pins','sessionMode','sources','token']);
        assert.equal(input.sessionMode,'standing-scoped-epoch-v1');assert.equal(input.token,'0'.repeat(32));
        assert.deepEqual(input.sources,{client:'invented source'});assert.deepEqual(input.pins,{client:createHash('sha256').update('invented source').digest('hex')});}`,
    'model/invented-client.py':'invented source',
    'model/rm-0032-standing-epoch-receipt.mjs':'export function normalizeEpochOwnerRecord(){}',
    'src/standing-epoch-wire.js':'export function createEpochWire(){throw new Error("wire must not open");}',
    'src/standing-epoch-session.js':'export function isEpochTurnNotAdmitted(){return false;}',
    'src/standing-scoped-epoch-session.js':'export function openStandingScopedEpochSession(){throw new Error("session must not open");}',
    'src/standing-repository-tools.js':`import assert from 'node:assert/strict';
      export function createRepositoryTools({snapshot,signal}){assert.deepEqual(snapshot,{invented:true});assert.equal(signal.aborted,false);
        return {async close(){snapshot.closed=true;}};}`,
  };
  for (const [name, value] of Object.entries(files)) writeFileSync(resolve(dir, name), value);
  const prepared = await prepareModel(dir);
  assert.equal(prepared.openStandingScopedEpochSession.name, 'openStandingScopedEpochSession');
  assert.equal(Object.hasOwn(prepared, 'openStandingEpochSession'), false);
  assert.equal(prepared.repositorySnapshot.closed, true);
  assert.deepEqual(readdirSync(dir).sort(), ['model','package.json','repository-snapshot.json','src']);
});

test('V36 fixed public entrypoints couple scoped runtime with history service and preserve fixed production preparation', () => {
  const source = readFileSync(new URL('./rm-0032-standing-host.mjs', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('async function run(expectedHash)'), source.indexOf('if (process.argv[1]'));
  const prepare = source.slice(source.indexOf('export async function prepare(expectedHash)'), source.indexOf('function modelInventory'));
  assert.equal(BUILD, 'C:/Neurobro/build');
  assert.ok(run.includes('openSession: prepared.openStandingScopedEpochSession'));
  assert.ok(run.includes("sessionMode: 'standing-scoped-epoch-v1'"));
  assert.ok(run.includes('enableHistoryTasks: true'));
  assert.ok(run.includes('enableInitiative: true'));
  assert.ok(prepare.includes('verifyStandingBuild(BUILD, readFileSync(MANIFEST), expectedHash)'));
  assert.ok(prepare.includes('return prepareModel();'));
  for (const name of ['rm-0032-standing-host.mjs','rm-0032-standing-dialogues.mjs','rm-0032-standing-task.ps1']) {
    const text = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.ok(text.replaceAll('\\','/').includes('C:/Neurobro/build'));
    assert.equal(text.includes('20260910-v28'), false);
    if (name.endsWith('.mjs')) { assert.ok(text.includes('standing-build-v36.json')); assert.equal(text.includes('standing-build-v28.json'), false); }
  }
});
test('standing admission holds mutex and reconciles before credentials, with no finite service timer', () => {
  const source = readFileSync(new URL('./rm-0032-standing-host.mjs', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('async function run(expectedHash)'), source.indexOf("if (process.argv[1]"));
  assert.ok(run.indexOf('await acquireHostMutex(') < run.indexOf('await reconcileStandingState('));
  assert.ok(run.indexOf('await reconcileStandingState(') < run.indexOf('credentials ='));
  assert.equal(run.includes('900000'), false);
  assert.ok(MUTEX_SCRIPT.includes("'READY'")); assert.equal(MUTEX_SCRIPT.includes('apiHash'), false);
});

function recoveryFixture(t) {
  const dir = fixture(t), hostRoot = resolve(dir, 'host'), modelRoot = resolve(dir, 'models'), lockPath = resolve(dir, 'session.enc.owner.lock');
  mkdirSync(hostRoot); mkdirSync(modelRoot);
  const owner = make(), ownerDir = resolve(hostRoot, owner.workerToken); mkdirSync(ownerDir);
  writeFileSync(resolve(ownerDir, 'intent.json'), JSON.stringify(owner)); writeFileSync(lockPath, lockBytes(owner));
  const token = 'c'.repeat(32), attempt = resolve(modelRoot, token); mkdirSync(attempt);
  writeFileSync(resolve(attempt, 'intent.json'), '{"invented":true}');
  return { input: { hostRoot, modelRoot, lockPath, signal: new AbortController().signal }, owner, ownerDir, token, attempt };
}
test('actual recovery path consumes no attempts and clears only exact dead-owned lock after Windows and guest proofs', async t => {
  const f = recoveryFixture(t), calls = [];
  mkdirSync(resolve(f.input.hostRoot, 'd'.repeat(32))); // A prior crash before unrelated intent write.
  await reconcileStandingState(f.input, { alive: () => false, windowsAbsent: async tokens => { calls.push('windows'); assert.deepEqual(tokens, [f.token]); return true; },
    guestAbsent: async tokens => { calls.push('guest'); assert.deepEqual(tokens, [f.token]); return true; } });
  assert.deepEqual(calls, ['windows', 'guest', 'windows']); assert.equal(existsSync(f.input.lockPath), false);
  assert.equal(readFileSync(resolve(f.attempt, 'intent.json'), 'utf8'), '{"invented":true}');
  assert.equal(readdirSync(f.ownerDir).filter(name => name.startsWith('reconciled-')).length, 1);
});
test('warm epoch recovery binds persisted settlement to its token and still checks Windows ownership', async t => {
  for (const mode of ['settled', 'settled-service-model', 'no-normalizer', 'foreign', 'missing-eof', 'unsettled']) {
    const f = recoveryFixture(t), calls = [];
    const record = { schema:'standing-epoch-owner-v1', epochId:f.token, outcome:'unknown',
      bootstrapJoined:true, activeJoined:true, sessionClosed:true, epochObserved:false, supervisorObserved:false,
      processSettled:true, exitObserved:true, closeObserved:true, stderrEnded:true, stdoutEnded:true, wireCleanEof:true,
      streamError:false, childError:false, terminationDispatched:false, successfulEpoch:false, resourcesSettled:true,
      replacementReady:true, exitCode:1, exitSignal:null, closeCode:1, closeSignal:null, stderrBytes:0 };
    if (mode === 'foreign') record.epochId = 'e'.repeat(32);
    if (mode === 'missing-eof') delete record.stdoutEnded;
    if (mode === 'unsettled') record.resourcesSettled = record.replacementReady = false;
    writeFileSync(resolve(f.attempt,'actual.json'),JSON.stringify(record));
    if(mode==='settled-service-model'){
      const classified=classifyHostExit({version:'standing-host-result-v1',status:'blocked',code:'STANDING_BLOCKED',
        failureStage:'model',failureCode:'other',clientSettled:true,lockPreserved:true,verifiedReplies:54},
        {ownerStopped:false,mutexLost:false,modelBlocked:false});
      assert.equal(classified.exitCode,75);assert.equal(classified.final.recoveryDisposition,'model-settlement');
      writeFileSync(resolve(f.ownerDir,'result.json'),JSON.stringify(classified.final));
    }
    await reconcileStandingState({ ...f.input, normalizeEpochOwnerRecord: mode === 'no-normalizer' ? undefined : normalizeEpochOwnerRecord }, {
      alive:()=>false,
      windowsAbsent:async tokens=>{calls.push('windows');assert.deepEqual(tokens,[f.token]);return true;},
      guestAbsent:async tokens=>{calls.push('guest');assert.deepEqual(tokens,mode.startsWith('settled') ? [] : [f.token]);return true;}
    });
    assert.deepEqual(calls,['windows','guest','windows']);
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.attempt,'actual.json'),'utf8')),record);
    if(mode==='settled-service-model'){
      assert.equal(existsSync(f.input.lockPath),false);assert.equal(existsSync(resolve(f.input.hostRoot,'paused.json')),false);
      assert.equal(readFileSync(resolve(f.attempt,'intent.json'),'utf8'),'{"invented":true}');
      assert.equal(readdirSync(f.input.modelRoot).length,1); // No replay or new attempt during reconciliation.
    }
  }
});

test('old live host or unmatched pilot lock refuses before any helper and preserves bytes', async t => {
  for (const live of [true, false]) {
    const f = recoveryFixture(t); if (!live) writeFileSync(f.input.lockPath, '{"oldPilot":true}');
    const before = readFileSync(f.input.lockPath, 'utf8'); let probes = 0;
    await assert.rejects(reconcileStandingState(f.input, { alive: () => live, windowsAbsent: async () => { probes++; return true; } }));
    assert.equal(probes, 0); assert.equal(readFileSync(f.input.lockPath, 'utf8'), before);
  }
});
test('settled receipt cannot skip Windows parent absence; late controller defers recovery before guest', async t => {
  const f = recoveryFixture(t), calls = []; let queries = 0;
  writeFileSync(resolve(f.attempt, 'actual.json'), JSON.stringify({ version: 'modeltext-host-v1', guestSettled: true, exitCode: 0,
    transportError: false, timedOut: false, aborted: false, overflow: false }));
  await reconcileStandingState(f.input, { alive: () => false, windowsAbsent: async tokens => { calls.push('windows'); assert.deepEqual(tokens, [f.token]); return ++queries > 1; },
    guestAbsent: async tokens => { calls.push('guest'); assert.deepEqual(tokens, []); return true; }, wait: async () => { calls.push('wait'); } });
  assert.deepEqual(calls, ['windows', 'wait', 'windows', 'guest', 'windows']); assert.equal(existsSync(f.input.lockPath), false);
});
test('unsettled guest is bounded and never clears lock or unknown attempt', async t => {
  const f = recoveryFixture(t); let now = 0;
  await assert.rejects(reconcileStandingState(f.input, { alive: () => false, windowsAbsent: async () => true, guestAbsent: async () => false,
    wait: async () => { now += 330000; }, now: () => now }), { code: 'STANDING_RECOVERY_PENDING' });
  assert.equal(readFileSync(f.input.lockPath, 'utf8'), lockBytes(f.owner)); assert.equal(existsSync(resolve(f.attempt, 'intent.json')), true);
});
test('replacement lock during reconciliation remains untouched', async t => {
  const f = recoveryFixture(t); let calls = 0;
  await assert.rejects(reconcileStandingState(f.input, { alive: () => false, windowsAbsent: async () => { if (++calls === 2) writeFileSync(f.input.lockPath, 'replacement'); return true; }, guestAbsent: async () => true }));
  assert.equal(readFileSync(f.input.lockPath, 'utf8'), 'replacement');
});
test('permanent failure remains paused without a lock and old permanent result cannot be auto-cleared', async t => {
  const f = recoveryFixture(t);
  writeFileSync(resolve(f.ownerDir, 'result.json'), JSON.stringify({ version: 'standing-host-result-v1', status: 'blocked', failureCode: 'protocol' }));
  await assert.rejects(reconcileStandingState(f.input, { alive: () => false }), { code: 'STANDING_PERMANENTLY_BLOCKED' });
  assert.equal(existsSync(resolve(f.input.hostRoot, 'paused.json')), true);
  rmSync(f.input.lockPath);
  await assert.rejects(reconcileStandingState(f.input, { windowsAbsent: async () => { assert.fail('helper called'); } }), { code: 'STANDING_PERMANENTLY_BLOCKED' });
  preservePause(f.input.hostRoot, f.owner.workerToken);
});
test('resource/model uncertainty and settled model failure reconcile, STOP and permanent failures do not', () => {
  const base = { status: 'blocked', failureStage: 'model', failureCode: 'other', clientSettled: true };
  assert.equal(recoveryDisposition(base, true, false), 'model-settlement');
  assert.equal(recoveryDisposition(base, false, false), 'model-settlement');
  assert.equal(recoveryDisposition({ ...base, clientSettled: false }, false, false), 'resource-settlement');
  for (const failureCode of ['binding', 'protocol', 'backlog', 'checkpoint']) assert.equal(recoveryDisposition({ ...base, failureCode, clientSettled: false }, true, false), 'permanent');
  assert.equal(recoveryDisposition(base, true, true), 'none'); assert.equal(recoveryDisposition({ ...base, status: 'stopped' }, false, false), 'none');
  assert.equal(recoveryDisposition(base,false,true),'none');
  for(const failureStage of ['prepare','lock','session','state','connect','self','adapter','wait','send','settle','none'])
    assert.equal(recoveryDisposition({...base,failureStage},false,false),'permanent');
  for(const failureCode of ['binding','protocol','backlog','checkpoint','none','config','not_reported'])
    assert.equal(recoveryDisposition({...base,failureCode},false,false),'permanent');
  assert.equal(recoveryDisposition({...base,clientSettled:undefined},false,false),'permanent');
  // Historical permanent decisions and explicit pause files are not rewritten.
  assert.equal(classifyHostExit({...base,recoveryDisposition:'permanent'},
    {ownerStopped:false,mutexLost:false,modelBlocked:false}).final.recoveryDisposition,'permanent');
});
test('settled model transport and abort failures classify for future recovery with STOP and resource priority', () => {
  for (const failureCode of ['other', 'aborted', 'transport']) {
    for (const failureStage of ['model', 'adapter', 'send']) {
      for (const clientSettled of [true, false, undefined]) {
        for (const status of ['blocked', 'stopped']) {
          for (const ownerStopped of [true, false]) {
            const final = { status, code: status === 'blocked' ? 'STANDING_BLOCKED' : 'STANDING_STOPPED', failureStage, failureCode, clientSettled };
            const expected = ownerStopped || status === 'stopped' ? 'none' : clientSettled === false ? 'resource-settlement'
              : failureStage === 'model' && clientSettled === true ? 'model-settlement' : 'permanent';
            assert.equal(recoveryDisposition(final, false, ownerStopped), expected, JSON.stringify(final));
            const classified = classifyHostExit(final, { ownerStopped, mutexLost: false, modelBlocked: false });
            assert.equal(classified.final.recoveryDisposition, expected, JSON.stringify(final));
            assert.equal(classified.exitCode, ['model-settlement', 'resource-settlement'].includes(expected) ? 75 : 0);
            assert.equal(classified.final.status, ownerStopped ? 'stopped' : status);
          }
        }
      }
    }
    const historical = { status: 'blocked', failureStage: 'model', failureCode, clientSettled: true, recoveryDisposition: 'permanent' };
    assert.equal(classifyHostExit(historical, { ownerStopped: false, mutexLost: false }).exitCode, 0);
    assert.equal(classifyHostExit(historical, { ownerStopped: false, mutexLost: false }).final.recoveryDisposition, 'permanent');
  }
});
function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kills = 0;
  child.kill = () => { child.kills++; return true; }; return child;
}
test('public helper requires exact close and late success cannot undo timeout or overflow', async () => {
  for (const overflow of [true, false]) {
    const child = fakeChild(), pending = publicHelper('invented', [], '{}', new AbortController().signal, () => child, { workMs: 10, closeMs: 20 });
    const refused = assert.rejects(pending, { code: 'STANDING_RECOVERY_REFUSED' });
    if (overflow) child.stdout.write('x'.repeat(1025)); else await new Promise(done => setTimeout(done, 15));
    child.emit('close', 0, null); await refused; assert.equal(child.kills, 1);
  }
});
test('public helper missing close is explicit unknown; valid fixed output waits for close', async () => {
  const stuck = fakeChild(); await assert.rejects(publicHelper('invented', [], '{}', new AbortController().signal, () => stuck, { workMs: 5, closeMs: 5 }), { code: 'STANDING_HELPER_UNSETTLED' });
  const child = fakeChild(), pending = publicHelper('invented', [], '{}', new AbortController().signal, () => child, { workMs: 100 });
  child.stdout.write('{"fixed":true}'); let finished = false; void pending.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); child.emit('close', 0, null); assert.equal(await pending, '{"fixed":true}');
});
test('mutex loss cancels admission and normal release waits for helper close', async () => {
  const child = fakeChild(); let lost = 0;
  const acquiring = acquireHostMutex(() => { lost++; }, () => child, { readyMs: 100, closeMs: 20 });
  child.stdout.write('READY\n'); const release = await acquiring;
  child.emit('close', 1, null); assert.equal(lost, 1); await assert.rejects(release(), { code: 'STANDING_HELPER_UNSETTLED' });
  const okay = fakeChild(), second = acquireHostMutex(() => assert.fail('normal release lost'), () => okay, { readyMs: 100, closeMs: 100 });
  okay.stdout.write('READY\n'); const end = await second; const closing = end(); okay.emit('close', 0, null); await closing;
});
test('emitted PowerShell scripts parse and actual invented global mutex excludes overlap and releases', { skip: process.platform !== 'win32' }, async () => {
  const ps = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const parser = "$ErrorActionPreference='Stop';$s=[Console]::In.ReadToEnd();$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e)|Out-Null;if($e.Count){exit 1};Write-Output 'PARSE_OK'";
  for (const script of [MUTEX_SCRIPT, WINDOWS_CONTROLLERS_SCRIPT]) {
    const parsed = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parser], { input: script, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(parsed.status, 0); assert.equal(parsed.stdout.trim(), 'PARSE_OK');
  }
  const invented = 'DecadansStandingInvented-' + randomBytes(16).toString('hex');
  const launch = (file, argv, options) => spawn(file, argv.map(value => value === MUTEX_SCRIPT ? value.replace('DecadansNeurobroStandingV1-', invented + '-') : value), options);
  const release = await acquireHostMutex(() => assert.fail('first invented mutex lost'), launch);
  try { await assert.rejects(acquireHostMutex(() => assert.fail('unadmitted mutex lost'), launch), { code: 'STANDING_ALREADY_RUNNING' }); }
  finally { await release(); }
  await (await acquireHostMutex(() => assert.fail('third invented mutex lost'), launch))();
});
test('actual emitted Windows controller script uses exact token matches through invented CIM adapter', { skip: process.platform !== 'win32' }, async () => {
  const ps = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', token = 'e'.repeat(32);
  for (const [commandLine, expected] of [['wsl.exe --exec python -c invented decadans-standing-token=' + token, false],
    ['wsl.exe --exec python -c invented decadans-standing-token=' + token + 'suffix', true], ['wsl.exe other', true]]) {
    const fakeCim = "function Get-CimInstance { [pscustomobject]@{CommandLine='" + commandLine + "'} };";
    const raw = await publicHelper(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fakeCim + WINDOWS_CONTROLLERS_SCRIPT],
      JSON.stringify({ tokens: [token] }), new AbortController().signal);
    assert.deepEqual(JSON.parse(raw), { version: 'standing-windows-recovery-v1', controllersAbsent: expected, checked: 1 });
  }
});

test('top-level run restarts after lost mutex even when teardown reports STANDING_STOPPED', async () => {
  const source = readFileSync(new URL('./rm-0032-standing-host.mjs', import.meta.url), 'utf8');
  const runSource = source.slice(source.indexOf('async function run(expectedHash)'), source.indexOf('if (process.argv[1]'));
  for (const explicitStop of [false, true]) {
    const proc = new EventEmitter(); let output = '', releases = 0;
    proc.stdout = { write: value => { output += value; } }; proc.exitCode = null;
    const scope = { AbortController, process: proc, setInterval, clearInterval, paths: { killSwitchPath: 'invented-stop' }, LOCK: 'invented-lock',
      existsSync: () => false, classifyHostExit,
      acquireHostMutex: async onLost => { onLost(); if (explicitStop) proc.emit('SIGTERM'); return async () => { releases++; }; },
      prepare: async () => { throw Object.assign(new Error('invented'), { code: 'STANDING_STOPPED' }); } };
    await runInNewContext(runSource + "\nrun('" + HASH + "')", scope);
    assert.equal(proc.exitCode, explicitStop ? 0 : 75); assert.equal(releases, 1);
    assert.equal(output, explicitStop ? 'STANDING_STOPPED\n' : 'STANDING_BLOCKED\n');
    assert.equal(proc.listenerCount('SIGTERM'), 0);
  }
});

test('top-level exit classification keeps permanent refusals and explicit STOP above mutex loss', () => {
  const result = { status: 'stopped', code: 'STANDING_STOPPED', clientSettled: true };
  const loss = classifyHostExit(result, { ownerStopped: false, mutexLost: true });
  assert.equal(loss.exitCode, 75); assert.equal(loss.final.status, 'blocked'); assert.equal(loss.final.recoveryDisposition, 'resource-settlement');
  assert.equal(classifyHostExit(result, { ownerStopped: true, mutexLost: true }).exitCode, 0);
  for (const failureCode of ['binding', 'protocol', 'backlog', 'checkpoint']) {
    const blocked = classifyHostExit({ ...result, status: 'blocked', failureCode }, { ownerStopped: false, mutexLost: true });
    assert.equal(blocked.exitCode, 0); assert.equal(blocked.final.recoveryDisposition, 'permanent');
  }
});
