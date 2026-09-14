// Current-user standing host. No text, credentials or raw child diagnostics are retained.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BUILD = 'C:/Neurobro/build';
export const PRIVATE = 'C:/Neurobro/state';
const NODE = 'C:/Program Files/DecadansNeurobro/node.exe';
const NODE_HASH = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5';
const RECEIPT_HASH = '632b9d19bbadea18d5a56dc8b36a64dfd250830960dde325a8b128d7ac546f6a';
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const WSL = 'C:/Program Files/WSL/wsl.exe';
const PS_ENV = Object.freeze({ SystemRoot: 'C:/Windows', WINDIR: 'C:/Windows', PATH: 'C:/Windows/System32', PSModulePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/Modules' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const TOKEN = /^[a-f0-9]{32}$/u, HASH = /^[a-f0-9]{64}$/u;
const HOST_ROOT = resolve(PRIVATE, 'standing-host-v1');
const MODEL_ROOT = resolve(PRIVATE, 'standing-model-attempts-v1');
const LOCK = resolve(PRIVATE, 'session.enc.owner.lock');
const MANIFEST = resolve(PRIVATE, 'standing-build-v36.json');
export const paths = Object.freeze({ authConfigPath: resolve(PRIVATE, 'auth-config.json'), bindingPath: resolve(PRIVATE, 'gateway-binding-v4.json'),
  modelReceiptPath: resolve(PRIVATE, 'model-ready-v3.json'), attemptDirectory: resolve(PRIVATE, 'standing-preflight-v1'), killSwitchPath: resolve(PRIVATE, 'STOP') });
const exact = (v, keys) => assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
const safePid = pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff;

export function verifyStandingBuild(build, bytes, expectedHash) {
  assert.match(expectedHash, HASH); assert.equal(sha(bytes), expectedHash);
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.ok(Array.isArray(manifest) && manifest.length > 0 && manifest.length < 10000);
  const actual = [], expected = [];
  function walk(relative) {
    const target = resolve(build, relative), stat = lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) for (const name of readdirSync(target)) walk(relative ? `${relative}/${name}` : name);
    else { assert.ok(stat.isFile()); actual.push(relative); }
  }
  walk('');
  for (const file of manifest) {
    exact(file, ['path', 'sha256']); assert.equal(typeof file.path, 'string');
    assert.ok(!file.path.includes('\\') && !file.path.includes(':') && file.path.split('/').every(p => p && p !== '.' && p !== '..'));
    assert.match(file.sha256, HASH); expected.push(file.path);
    assert.equal(sha(readFileSync(resolve(build, file.path))), file.sha256);
  }
  assert.equal(new Set(expected).size, expected.length); assert.deepEqual(actual.sort(), expected.sort());
  for (const name of ['standing-host.mjs', 'standing-recovery.py', 'src/standing-service.js', 'src/windows-credential-vault.js',
    'src/pilot-greeting.js', 'model/rm-0032-standing-epoch-host.mjs', 'model/rm-0032-standing-epoch-runtime.mjs',
    'model/rm-0032-standing-epoch-owner.mjs', 'model/rm-0032-standing-epoch-receipt.mjs',
    'src/standing-epoch-session.js', 'src/standing-epoch-wire.js', 'src/standing-native-turn.js', 'src/standing-context-restoration.js',
    'src/self-history-reader.js', 'src/self-history-tool.js', 'src/standing-repository-tools.js', 'repository-snapshot.json',
    'src/conversation-references.js', 'src/generated-image-receiver.js', 'src/standing-model-result.js', 'package.json']) assert.ok(expected.includes(name));
  for (const module of ['standing-scoped-epoch-session', 'standing-history-analysis-attempt-store', 'standing-history-analysis-planner',
    'standing-history-analysis-runtime', 'standing-history-analysis-step', 'standing-history-analysis-store', 'standing-history-analysis-view',
    'standing-history-read-runner', 'standing-history-read-step', 'standing-history-source-projection', 'standing-history-task-control-store',
    'standing-history-task-delivery', 'standing-history-task-discovery', 'standing-history-task-disposition', 'standing-history-task-manager',
    'standing-history-task-request', 'standing-history-task-runner', 'standing-history-task-runtime', 'standing-history-task-store',
    'standing-history-task-tools', 'standing-chronicle-note', 'standing-history-task-context', 'standing-history-task-memory',
    'standing-own-action-capture', 'standing-own-action-checkpoint', 'standing-own-action-memory', 'standing-own-action-projection',
    'standing-input-image', 'standing-visual-input', 'standing-media-read-port', 'standing-own-action-reader', 'standing-shared-context-binding', 'standing-shared-context-reader', 'standing-shared-context']) assert.ok(expected.includes(`src/${module}.js`));
}

// Every checked file may inherit the protected parent's owner/SYSTEM-only ACL.
export function checkPrivateAcl() {
  const script = "$ErrorActionPreference='Stop';$p='C:/Neurobro/state';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$items=@($p);foreach($n in @('session.enc','auth-config.json','gateway-binding-v4.json','model-ready-v3.json','standing-build-v36.json','windows-credentials-v1.json')){$items+=@(Join-Path $p $n)};foreach($n in @('standing-host-v1','standing-state-v1','standing-model-attempts-v1')){$x=Join-Path $p $n;if(Test-Path -LiteralPath $x){$items+=@($x);$items+=@(Get-ChildItem -LiteralPath $x -Recurse -Force -ErrorAction Stop | Select-Object -ExpandProperty FullName)}};$ok=$true;foreach($x in $items){$a=Get-Acl -LiteralPath $x;if($x -eq $p -and !$a.AreAccessRulesProtected){$ok=$false};foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18')){$ok=$false}}};if(!$ok){exit 1};Write-Output 'PRIVATE_OK'";
  const output = execFileSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: PS_ENV, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, maxBuffer: 1024, encoding: 'utf8' });
  assert.equal(output.trim(), 'PRIVATE_OK');
}

function regular(stat, cap) { assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= cap); }
export function readMetadata(file, cap = 16384) {
  const before = lstatSync(file); regular(before, cap);
  const handle = openSync(file, 'r');
  try {
    const opened = fstatSync(handle); regular(opened, cap);
    assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
    const bytes = readFileSync(handle); assert.equal(bytes.length, opened.size);
    const after = lstatSync(file); regular(after, cap);
    assert.equal(after.dev, opened.dev); assert.equal(after.ino, opened.ino); assert.equal(after.size, opened.size);
    assert.equal(Buffer.from(bytes.toString('utf8')).equals(bytes), true);
    return JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(handle); }
}
function writeNew(file, value) {
  const handle = openSync(file, 'wx', 0o600);
  try { writeFileSync(handle, JSON.stringify(value) + '\n'); fsyncSync(handle); } finally { closeSync(handle); }
}
function safeDirectory(dir, create = false) {
  if (!existsSync(dir) && create) mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
}
function processAlive(pid) {
  assert.ok(safePid(pid));
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export function makeWorkerIntent(expectedHash, pid = process.pid, token = randomBytes(16).toString('hex'), now = Date.now()) {
  assert.match(expectedHash, HASH); assert.ok(safePid(pid)); assert.match(token, TOKEN);
  const startedAt = new Date(now).toISOString();
  return { version: 'standing-worker-v1', workerToken: token, buildManifestSha256: expectedHash, nodeSha256: NODE_HASH, pid, startedAt,
    lock: { version: 'telegram-gateway-process-lock-v1', pid, processStartIdentity: startedAt,
      bootNonce: randomBytes(32).toString('hex'), ownershipNonce: randomBytes(32).toString('hex') } };
}
export function validateWorkerIntent(value) {
  exact(value, ['version', 'workerToken', 'buildManifestSha256', 'nodeSha256', 'pid', 'startedAt', 'lock']);
  assert.equal(value.version, 'standing-worker-v1'); assert.match(value.workerToken, TOKEN); assert.match(value.buildManifestSha256, HASH);
  assert.equal(value.nodeSha256, NODE_HASH); assert.ok(safePid(value.pid)); assert.equal(new Date(value.startedAt).toISOString(), value.startedAt);
  exact(value.lock, ['version', 'pid', 'processStartIdentity', 'bootNonce', 'ownershipNonce']);
  assert.equal(value.lock.version, 'telegram-gateway-process-lock-v1'); assert.equal(value.lock.pid, value.pid);
  assert.equal(value.lock.processStartIdentity, value.startedAt); assert.match(value.lock.bootNonce, HASH); assert.match(value.lock.ownershipNonce, HASH);
  return value;
}
export function lockBytes(intent) { validateWorkerIntent(intent); return JSON.stringify(intent.lock) + '\n'; }

/** Worker intent has been persisted before this callback is made available to the runner. */
export function ownedLockPort(intent, lockPath = LOCK) {
  const owned = lockBytes(intent); let acquired = false;
  return async requested => {
    assert.equal(requested, lockPath); assert.equal(acquired, false); assert.equal(existsSync(lockPath + '.sticky'), false);
    const handle = openSync(lockPath, 'wx', 0o600);
    try { writeFileSync(handle, owned); fsyncSync(handle); } finally { closeSync(handle); }
    assert.equal(readFileSync(lockPath, 'utf8'), owned); acquired = true;
    let released = false;
    return async () => {
      if (released) return;
      assert.equal(readFileSync(lockPath, 'utf8'), owned); unlinkSync(lockPath); released = true; acquired = false;
    };
  };
}

export function locateOwnedStaleLock(bytes, intents, alive) {
  const matches = intents.filter(intent => lockBytes(intent) === bytes);
  assert.equal(matches.length, 1); const owner = matches[0];
  assert.equal(alive(owner.pid), false); return owner;
}
export function settledModelReceipt(value, token, normalizeOwnerRecord) {
  if (value?.schema === 'standing-epoch-owner-v1') {
    if (!TOKEN.test(token ?? '') || typeof normalizeOwnerRecord !== 'function') return false;
    try {
      const record = normalizeOwnerRecord(value, token);
      return record.resourcesSettled === true && record.replacementReady === true;
    } catch { return false; }
  }
  return ['modeltext-host-v1', 'standing-native-host-v1'].includes(value?.version) && value.guestSettled === true && value.exitCode === 0 &&
    ['transportError', 'timedOut', 'aborted', 'overflow'].every(key => value[key] === false);
}

// A named mutex serializes recovery even when someone manually starts the same task.
// Its helper holds no secrets, reads no host input and releases on parent-pipe EOF.
export const MUTEX_SCRIPT = "$ErrorActionPreference='Stop';$m=$null;$held=$false;try{$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$m=[Threading.Mutex]::new($false,('Global\\DecadansNeurobroStandingV1-'+$sid));try{$held=$m.WaitOne(0)}catch [Threading.AbandonedMutexException]{$held=$true};if(!$held){exit 2};[Console]::Out.WriteLine('READY');[Console]::Out.Flush();$s=[Console]::OpenStandardInput();$b=New-Object byte[] 1;while($s.Read($b,0,1) -gt 0){};exit 0}catch{exit 1}finally{if($held){$m.ReleaseMutex()};if($m){$m.Dispose()}}";
function hostError(code) { const error = new Error(code); error.code = code; return error; }
async function boundedClose(close, child, milliseconds = 5000) {
  let timer;
  const outcome = await Promise.race([close, new Promise(done => { timer = setTimeout(() => done(null), milliseconds); })]);
  clearTimeout(timer);
  if (outcome === null) { try { child.kill(); } catch {} }
  return outcome;
}
export async function acquireHostMutex(onLost, spawnPort = spawn, limits = {}) {
  const child = spawnPort(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', MUTEX_SCRIPT], {
    env: PS_ENV, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let closing = false, closed = false, admitted = false, count = 0, output = '', lost = false;
  const markLost = () => { if (admitted && !closing && !lost) { lost = true; onLost(); } };
  let finishClose; const close = new Promise(done => { finishClose = done; });
  const ready = new Promise((done, fail) => {
    const reject = () => { markLost(); try { child.kill(); } catch {} fail(hostError('STANDING_MUTEX_REFUSED')); };
    const timer = setTimeout(reject, limits.readyMs ?? 10000);
    child.stdout.on('data', bytes => { count += bytes.length; output += bytes.toString('ascii');
      if (count > 8 || !'READY\r\n'.startsWith(output) && !'READY\n'.startsWith(output)) { clearTimeout(timer); reject(); }
      else if (output === 'READY\n' || output === 'READY\r\n') { clearTimeout(timer); admitted = true; done(); } });
    child.once('error', () => { clearTimeout(timer); reject(); });
    child.once('close', (code, signal) => { closed = true; clearTimeout(timer); finishClose(code === 0 && signal === null);
      markLost(); fail(hostError(code === 2 ? 'STANDING_ALREADY_RUNNING' : 'STANDING_MUTEX_REFUSED')); });
    child.stdin.on('error', reject);
    child.stdout.on('error', reject);
  });
  try { await ready; } catch (error) {
    closing = true; try { child.stdin.end(); if (!closed) child.kill(); } catch {}
    if (await boundedClose(close, child, limits.closeMs) === null) throw hostError('STANDING_HELPER_UNSETTLED');
    throw error;
  }
  return async () => { closing = true; if (!closed) child.stdin.end();
    const settled = await boundedClose(close, child, limits.closeMs);
    if (settled !== true) throw hostError('STANDING_HELPER_UNSETTLED'); };
}

/** Fixed public-helper subprocess. A timeout/abort/output error never promotes
 * a late success; close must be observed before any absence result is used. */
export async function publicHelper(file, argv, input, signal, spawnPort = spawn, limits = {}) {
  const child = spawnPort(file, argv, { env: PS_ENV, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let stopped = false, closed = false, bytes = 0, output = '', finish;
  const close = new Promise(done => { finish = done; });
  const stop = () => { if (!stopped) { stopped = true; try { child.kill(); } catch {} } };
  const timer = setTimeout(stop, limits.workMs ?? 60000);
  signal.addEventListener('abort', stop, { once: true });
  child.stdout.on('data', part => { bytes += part.length; if (bytes <= 1024 && !stopped) output += part.toString('utf8'); else stop(); });
  child.stdout.on('error', stop); child.stdin.on('error', stop); child.on('error', stop);
  child.once('close', (code, sig) => { closed = true; finish(code === 0 && sig === null); });
  try {
    if (signal.aborted) stop(); else { try { child.stdin.end(input); } catch { stop(); } }
    // A separate final deadline handles transports that never deliver close.
    const outcome = await boundedClose(close, child, (limits.workMs ?? 60000) + (limits.closeMs ?? 5000));
    if (outcome === null || !closed) throw hostError('STANDING_HELPER_UNSETTLED');
    if (outcome !== true || stopped || signal.aborted) throw hostError('STANDING_RECOVERY_REFUSED');
    return output;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
}

// Windows wsl.exe can still be starting before its guest controller appears.
// Check its public token marker as well as the subsequent Linux /proc proof.
export const WINDOWS_CONTROLLERS_SCRIPT = "$ErrorActionPreference='Stop';try{$raw=[Console]::In.ReadToEnd();if($raw.Length -gt 400000){exit 1};$v=ConvertFrom-Json $raw;if(@($v.PSObject.Properties).Count -ne 1 -or @($v.PSObject.Properties)[0].Name -ne 'tokens'){exit 1};$set=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($t in @($v.tokens)){if($t -isnot [string] -or $t -cnotmatch '^[a-f0-9]{32}$' -or !$set.Add($t)){exit 1}};if($set.Count -gt 10000){exit 1};$clear=$true;$procs=@(Get-CimInstance Win32_Process -Filter \"Name='wsl.exe'\" -ErrorAction Stop);foreach($p in $procs){if($null -eq $p.CommandLine){exit 1};foreach($m in [regex]::Matches($p.CommandLine,'(?:^|[\\s\"])decadans-standing-token=([a-f0-9]{32})(?=$|[\\s\"])')){if($set.Contains($m.Groups[1].Value)){$clear=$false}}};[Console]::Out.WriteLine((@{version='standing-windows-recovery-v1';controllersAbsent=$clear;checked=$set.Count}|ConvertTo-Json -Compress));exit 0}catch{exit 1}";

export async function prepareModel(build = BUILD) {
  const module = await import(pathToFileURL(resolve(build, 'model/rm-0032-standing-epoch-runtime.mjs')).href);
  const { SOURCE_NAMES, preparePacket } = await import(pathToFileURL(resolve(build, 'model/rm-0032-standing-epoch-host.mjs')).href);
  const { normalizeEpochOwnerRecord } = await import(pathToFileURL(resolve(build, 'model/rm-0032-standing-epoch-receipt.mjs')).href);
  const { createEpochWire } = await import(pathToFileURL(resolve(build, 'src/standing-epoch-wire.js')).href);
  const { isEpochTurnNotAdmitted } = await import(pathToFileURL(resolve(build, 'src/standing-epoch-session.js')).href);
  const { openStandingScopedEpochSession } = await import(pathToFileURL(resolve(build, 'src/standing-scoped-epoch-session.js')).href);
  const { createRepositoryTools } = await import(pathToFileURL(resolve(build, 'src/standing-repository-tools.js')).href);
  // Read only the immutable manifest-verified source snapshot, never the user's
  // working directory or private runtime files on behalf of a model request.
  const repositorySnapshot = readMetadata(resolve(build, 'repository-snapshot.json'), 64 * 1024 * 1024);
  const repository = createRepositoryTools({ snapshot: repositorySnapshot, signal: new AbortController().signal });
  await repository.close();
  const sources = Object.fromEntries(Object.entries(SOURCE_NAMES).map(([key, name]) => [key, readFileSync(resolve(build, 'model', name), 'utf8')]));
  const pins = Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, sha(source)]));
  // Pure source/capsule validation. The protected attempts directory and worker
  // identity do not exist yet, and preparation must not spawn a model process.
  preparePacket({ sources, pins, token: '0'.repeat(32), sessionMode: 'standing-scoped-epoch-v1' });
  return { module, sources, pins, normalizeEpochOwnerRecord, createEpochWire, openStandingScopedEpochSession, isEpochTurnNotAdmitted, repositorySnapshot };
}
export async function prepare(expectedHash) {
  verifyStandingBuild(BUILD, readFileSync(MANIFEST), expectedHash);
  const stat = lstatSync(NODE); assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(sha(readFileSync(NODE)), NODE_HASH);
  checkPrivateAcl(); assert.equal(sha(readFileSync(paths.modelReceiptPath)), RECEIPT_HASH);
  assert.equal(existsSync(paths.attemptDirectory), false); assert.equal(existsSync(paths.killSwitchPath), false);
  const { preparePilotGreeting } = await import(pathToFileURL(resolve(BUILD, 'src/pilot-greeting.js')).href);
  await preparePilotGreeting(paths);
  return prepareModel();
}

function modelInventory(modelRoot, normalizeOwnerRecord) {
  safeDirectory(modelRoot); const names = readdirSync(modelRoot); assert.ok(names.length <= 10000);
  const pending = [];
  for (const token of names) {
    assert.match(token, TOKEN); const dir = resolve(modelRoot, token); safeDirectory(dir);
    // Missing, torn or refused metadata is not a reason to replay the attempt.
    // It requires fresh process/unit absence instead of using a prior receipt.
    try { if (settledModelReceipt(readMetadata(resolve(dir, 'actual.json')), token, normalizeOwnerRecord)) continue; } catch {}
    pending.push(token);
  }
  return { all: names, pending };
}
async function probeGuest(tokens, signal) {
  if (!tokens.length) return true;
  const source = readFileSync(resolve(BUILD, 'standing-recovery.py'), 'utf8');
  const output = await publicHelper(WSL, ['--distribution', 'DecadansNeurobro', '--user', 'root', '--exec',
    '/usr/bin/python3.12', '-I', '-S', '-B', '-c', source], JSON.stringify({ tokens }), signal);
  const value = JSON.parse(output); exact(value, ['version', 'settled', 'controllersAbsent', 'unitsAbsent', 'checked']);
  assert.equal(value.version, 'standing-recovery-v1'); assert.equal(value.checked, tokens.length);
  return value.settled === true && value.controllersAbsent === true && value.unitsAbsent === true;
}
async function probeWindows(tokens, signal) {
  if (!tokens.length) return true;
  const output = await publicHelper(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_CONTROLLERS_SCRIPT], JSON.stringify({ tokens }), signal);
  const value = JSON.parse(output); exact(value, ['version', 'controllersAbsent', 'checked']);
  assert.equal(value.version, 'standing-windows-recovery-v1'); assert.equal(value.checked, tokens.length);
  assert.equal(typeof value.controllersAbsent, 'boolean'); return value.controllersAbsent;
}
function waitForRetry(milliseconds, signal) {
  return new Promise(done => {
    if (signal.aborted) return done();
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
    const timer = setTimeout(finish, milliseconds); signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
export function recoveryDisposition(result, modelBlocked, stopped) {
  if (stopped || result.status !== 'blocked') return 'none';
  if (['binding', 'protocol', 'backlog', 'checkpoint'].includes(result.failureCode)) return 'permanent';
  if (modelBlocked === true && result.failureStage === 'model') return 'model-settlement';
  if (result.clientSettled === false) return 'resource-settlement';
  // A failed native turn can settle fully, leaving modelBlocked=false. Admit
  // recovery reconciliation for future inputs; the consumed turn is not retried.
  // Reconciliation still requires dead ownership and all resource proofs.
  if (result.failureStage === 'model' && ['other', 'aborted', 'transport'].includes(result.failureCode) && result.clientSettled === true) return 'model-settlement';
  return 'permanent';
}
export function preservePause(hostRoot, workerToken) {
  assert.match(workerToken, TOKEN);
  const file = resolve(hostRoot, 'paused.json');
  if (!existsSync(file)) writeNew(file, { version: 'standing-pause-v1', workerToken, code: 'STANDING_BLOCKED' });
}
/** Called only while the host owns the named mutex. All subprocess adapters
 * are read-only; fixtures inject absence and time without launching anything. */
export async function reconcileStandingState({ lockPath = LOCK, hostRoot = HOST_ROOT, modelRoot = MODEL_ROOT, signal, normalizeEpochOwnerRecord }, ports = {}) {
  const alive = ports.alive ?? processAlive, windowsAbsent = ports.windowsAbsent ?? probeWindows,
    guestAbsent = ports.guestAbsent ?? probeGuest, wait = ports.wait ?? waitForRetry, now = ports.now ?? Date.now;
  if (existsSync(resolve(hostRoot, 'paused.json'))) throw hostError('STANDING_PERMANENTLY_BLOCKED');
  assert.equal(existsSync(lockPath + '.sticky'), false);
  let bytes, owner;
  if (existsSync(lockPath)) {
    regular(lstatSync(lockPath), 8192); bytes = readFileSync(lockPath, 'utf8');
    const names = readdirSync(hostRoot); assert.ok(names.length <= 10000);
    const intents = names.filter(name => TOKEN.test(name)).flatMap(name => {
      const dir = resolve(hostRoot, name); safeDirectory(dir);
      // A crash before writing some unrelated worker's intent cannot own this
      // lock. Only an exact complete recorded intent may authorize deletion.
      try { const intent = validateWorkerIntent(readMetadata(resolve(dir, 'intent.json')));
        assert.equal(intent.workerToken, name); return [intent]; } catch { return []; }
    });
    owner = locateOwnedStaleLock(bytes, intents, alive);
    const resultFile = resolve(hostRoot, owner.workerToken, 'result.json');
    if (existsSync(resultFile)) {
      const previous = readMetadata(resultFile);
      assert.equal(previous.version, 'standing-host-result-v1');
      assert.ok(['stopped', 'blocked'].includes(previous.status));
      if (previous.status === 'blocked' && !['model-settlement', 'resource-settlement'].includes(previous.recoveryDisposition)) {
        preservePause(hostRoot, owner.workerToken); throw hostError('STANDING_PERMANENTLY_BLOCKED');
      }
    }
  }
  const { all, pending } = modelInventory(modelRoot, normalizeEpochOwnerRecord), deadline = now() + 330000;
  while (true) {
    if (signal.aborted) throw hostError('STANDING_STOPPED');
    // Check ALL tracked Windows markers even for receipts that already report
    // guest settlement; no late-starting WSL parent may survive admission.
    if (await windowsAbsent(all, signal) && await guestAbsent(pending, signal) && await windowsAbsent(all, signal)) break;
    if (now() >= deadline) throw hostError('STANDING_RECOVERY_PENDING');
    await wait(5000, signal);
  }
  if (!owner) return;
  if (signal.aborted) throw hostError('STANDING_STOPPED');
  writeNew(resolve(hostRoot, owner.workerToken, 'reconciled-' + randomBytes(16).toString('hex') + '.json'),
    { version: 'standing-reconcile-v1', workerToken: owner.workerToken, lockSha256: sha(bytes), processesAbsent: true, attemptsPreserved: true });
  assert.equal(readFileSync(lockPath, 'utf8'), bytes); assert.equal(alive(owner.pid), false); unlinkSync(lockPath);
}

export function trackedModelExecute(execute, workerToken, spawnPort = spawn) {
  assert.match(workerToken, TOKEN);
  return request => {
    const token = basename(request.attemptDirectory); assert.match(token, TOKEN);
    assert.equal(resolve(request.attemptDirectory), resolve(MODEL_ROOT, token));
    return execute(request, { spawn: (file, argv, options) => {
      assert.equal(file, WSL); assert.equal(argv.at(-2), '-c');
      const child = spawnPort(file, [...argv, 'decadans-standing-token=' + token], options);
      try { writeNew(resolve(request.attemptDirectory, 'controller.json'), { version: 'standing-controller-v1', workerToken, token, pid: child.pid ?? null }); }
      catch { try { child.kill(); } catch {} throw new Error('STANDING_CONTROLLER_REFUSED'); }
      return child;
    } });
  };
}

export function normalizeStandingResult(value) {
  assert.ok(value && typeof value === 'object'); assert.ok(['stopped', 'blocked'].includes(value.status));
  assert.equal(typeof value.clientSettled, 'boolean'); assert.equal(typeof value.lockPreserved, 'boolean');
  assert.ok(Number.isSafeInteger(value.verifiedReplies) && value.verifiedReplies >= 0);
  return { version: 'standing-host-result-v1', status: value.status, code: value.status === 'stopped' ? 'STANDING_STOPPED' : 'STANDING_BLOCKED',
    clientSettled: value.clientSettled, lockPreserved: value.lockPreserved, verifiedReplies: value.verifiedReplies,
    failureStage: ['prepare','lock','session','state','connect','self','adapter','wait','model','send','settle','none'].includes(value.failureStage) ? value.failureStage : 'not_reported',
    failureCode: ['none','transport','binding','protocol','backlog','checkpoint','aborted','other'].includes(value.failureCode) ? value.failureCode : 'not_reported' };
}

export function statusWriter(workerDirectory, now = () => new Date().toISOString()) {
  const codes = new Set(['STANDING_CONNECTING', 'STANDING_ONLINE', 'STANDING_MODEL', 'STANDING_REPLY_VERIFIED', 'STANDING_RECONNECTING', 'STANDING_UNKNOWN_CONSUMED', 'STANDING_BLOCKED', 'STANDING_STOPPED']);
  let verifiedReplies = 0;
  return code => {
    assert.ok(codes.has(code));
    if (code === 'STANDING_REPLY_VERIFIED') verifiedReplies++;
    const at = now(); assert.equal(new Date(at).toISOString(), at);
    safeDirectory(workerDirectory);
    const target = resolve(workerDirectory, 'status.json'), temp = resolve(workerDirectory, 'status-' + randomBytes(16).toString('hex') + '.tmp');
    if (existsSync(target)) regular(lstatSync(target), 1024);
    writeNew(temp, { version: 'standing-status-v1', code, at, verifiedReplies });
    renameSync(temp, target);
  };
}

export function classifyHostExit(final, { ownerStopped, mutexLost, modelBlocked = false }) {
  const permanent = final.status === 'blocked' && ['binding', 'protocol', 'backlog', 'checkpoint'].includes(final.failureCode);
  let disposition = ownerStopped ? 'none' : permanent ? 'permanent' : mutexLost ? 'resource-settlement'
    : final.recoveryDisposition ?? recoveryDisposition(final, modelBlocked, false);
  if (ownerStopped) final = { ...final, status: 'stopped', code: 'STANDING_STOPPED' };
  else if (mutexLost) final = { ...final, status: 'blocked', code: 'STANDING_BLOCKED' };
  return { final: { ...final, recoveryDisposition: disposition },
    exitCode: ['model-settlement', 'resource-settlement'].includes(disposition) ? 75 : 0 };
}

async function run(expectedHash) {
  const controller = new AbortController(); let releaseMutex, worker, credentials, final, model;
  let ownerStopped = false, mutexLost = false;
  const abort = () => { ownerStopped = true; controller.abort(); };
  const loseMutex = () => { mutexLost = true; controller.abort(); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const stopTimer = setInterval(() => { if (existsSync(paths.killSwitchPath)) abort(); }, 1000);
  try {
    if (existsSync(paths.killSwitchPath)) { abort(); throw hostError('STANDING_STOPPED'); }
    releaseMutex = await acquireHostMutex(loseMutex);
    const prepared = await prepare(expectedHash);
    safeDirectory(HOST_ROOT, true); safeDirectory(MODEL_ROOT, true);
    await reconcileStandingState({ signal: controller.signal, normalizeEpochOwnerRecord: prepared.normalizeEpochOwnerRecord });
    assert.equal(controller.signal.aborted, false);
    worker = makeWorkerIntent(expectedHash); const dir = resolve(HOST_ROOT, worker.workerToken); mkdirSync(dir, { mode: 0o700 });
    writeNew(resolve(dir, 'intent.json'), worker);
    const { createWindowsCredentialVault } = await import(pathToFileURL(resolve(BUILD, 'src/windows-credential-vault.js')).href);
    credentials = { ...await createWindowsCredentialVault({ path: resolve(PRIVATE, 'windows-credentials-v1.json') }).load() };
    model = prepared.module.prepareStandingEpochRuntime({ sources: prepared.sources, pins: prepared.pins, attemptParent: MODEL_ROOT,
      workerToken: worker.workerToken, createWire: prepared.createEpochWire, openSession: prepared.openStandingScopedEpochSession, sessionMode: 'standing-scoped-epoch-v1',
      isTurnNotAdmitted: prepared.isEpochTurnNotAdmitted });
    const { runStandingService } = await import(pathToFileURL(resolve(BUILD, 'src/standing-service.js')).href);
    final = normalizeStandingResult(await runStandingService({ paths, stateDirectory: resolve(PRIVATE, 'standing-state-v1'), credentials,
      model: async () => { throw hostError('STANDING_LEGACY_MODEL_DISABLED'); }, openConversation: input => model.openConnection(input),
      enableImages: true, enableGroupTools: true, enableArtifacts: true, enableFormatting: true, enableBoundActions: true, enableHistoryTasks: true, enableInitiative: true,
      repositorySnapshot: prepared.repositorySnapshot,
      modelState: () => model.state(), signal: controller.signal, acquireLock: ownedLockPort(worker), notify: statusWriter(dir) }));
  } catch (error) {
    const stopped = ownerStopped || existsSync(paths.killSwitchPath);
    final = { version: 'standing-host-result-v1', status: stopped ? 'stopped' : 'blocked', code: stopped ? 'STANDING_STOPPED' : 'STANDING_BLOCKED',
      clientSettled: false, lockPreserved: existsSync(LOCK), verifiedReplies: 0, recoveryDisposition: stopped ? 'none' : 'permanent' };
    if (!stopped && ['STANDING_RECOVERY_PENDING', 'STANDING_RECOVERY_REFUSED', 'STANDING_HELPER_UNSETTLED'].includes(error?.code)) {
      final.recoveryDisposition = 'resource-settlement';
    }
  } finally {
    if (credentials) { credentials.apiId = 0; credentials.apiHash = ''; credentials.passphrase = ''; }
    // Persist a permanent pause while still owning the mutex, before another
    // host could admit itself. This receipt describes the settled service.
    final = classifyHostExit(final, { ownerStopped: ownerStopped || existsSync(paths.killSwitchPath), mutexLost, modelBlocked: model?.state().blocked === true }).final;
    if (worker) { try {
      if (final.recoveryDisposition === 'permanent') preservePause(HOST_ROOT, worker.workerToken);
      writeNew(resolve(HOST_ROOT, worker.workerToken, 'result.json'), final);
    } catch { final = { ...final, status: 'blocked', code: 'STANDING_BLOCKED' }; } }
    try { await releaseMutex?.(); } catch { mutexLost = true; }
    clearInterval(stopTimer); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
  // Helper loss aborts the same teardown, but only owner signals/STOP suppress restart.
  const classified = classifyHostExit(final, { ownerStopped: ownerStopped || existsSync(paths.killSwitchPath), mutexLost, modelBlocked: model?.state().blocked === true });
  final = classified.final;
  process.stdout.write(final.code + '\n'); process.exitCode = classified.exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 4); const [mode, expectedHash] = process.argv.slice(2); assert.match(expectedHash, HASH);
    if (mode === '--prepare') { await prepare(expectedHash); process.stdout.write('STANDING_PREPARED\n'); }
    else { assert.equal(mode, '--run'); await run(expectedHash); }
  } catch { process.stdout.write('STANDING_REFUSED\n'); process.exitCode = 1; }
}
