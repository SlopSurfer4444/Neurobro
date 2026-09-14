// One bounded, source-pinned invocation. Imports do not execute the operation.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(DIRECTORY, '../..');
const ATTEMPT = 'C:/Neurobro/scratch/managed-custody-20260910-v2';
const WSL = 'C:/Program Files/WSL/wsl.exe';
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function preparePacket(expected) {
  assert.deepEqual(Object.keys(expected).sort(), ['client', 'relay', 'supervisor']);
  const names = { client: 'rm-0032-managed-custody-client.py',
    relay: 'rm-0032-model-egress-relay.py', supervisor: 'rm-0032-managed-custody-supervisor.py' };
  const sources = {};
  for (const key of Object.keys(names)) {
    const bytes = readFileSync(resolve(DIRECTORY, names[key]));
    assert.match(expected[key], /^[a-f0-9]{64}$/u);
    assert.equal(sha256(bytes), expected[key]);
    sources[key] = { source: bytes.toString('utf8'), sha256: expected[key] };
  }
  const encoded = Buffer.from(JSON.stringify({ relay: sources.relay, client: sources.client })).toString('base64');
  return "__name__ = 'reviewed_guest_supervisor'\n" + sources.supervisor.source +
    '\nimport base64\nasyncio.run(main(json.loads(base64.b64decode("' + encoded + '"))))\n';
}

export async function execute(expected) {
  const payload = preparePacket(expected);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  assert.match(sourceCommit, /^[a-f0-9]{40}$/u);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }), '');
  assert.equal(existsSync(ATTEMPT), false, 'Preserve existing attempt; no replay');
  mkdirSync(ATTEMPT);
  writeFileSync(resolve(ATTEMPT, 'intent.json'), JSON.stringify({ operation: 'managed-custody-v2',
    sourceCommit, sources: expected, payloadSha256: sha256(payload), startedAt: new Date().toISOString(),
    modelTurn: false, telegram: false }, null, 2) + '\n', { flag: 'wx' });
  const child = spawn(WSL, ['--distribution', 'DecadansNeurobro', '--user', 'root', '--exec',
    '/usr/bin/python3.12', '-I', '-S', '-B', '-'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: 'C:/Windows/System32' },
  });
  let stdout = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0, timedOut = false, overflow = false;
  child.stdout.on('data', data => { stdoutBytes += data.length;
    if (stdoutBytes <= 65536) stdout = Buffer.concat([stdout, data]); else overflow = true; });
  child.stderr.on('data', data => { stderrBytes += data.length; });
  child.stdin.on('error', () => {});
  child.stdin.end(payload);
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 300000);
  const status = await new Promise(done => {
    child.once('error', () => done({ exitCode: null, transportError: true }));
    child.once('close', code => done({ exitCode: code, transportError: false }));
  });
  clearTimeout(timer);
  const actual = { ...status, timedOut, stdoutBytes, stderrBytes, overflow,
    endedAt: new Date().toISOString(), outcome: 'inconclusive' };
  if (!overflow && !timedOut && status.exitCode === 0) {
    try {
      const value = JSON.parse(stdout.toString('utf8'));
      assert.equal(value.version, 'managed-custody-v2');
      assert.equal(value.modelTurn, false);
      assert.equal(value.telegram, false);
      assert.equal(typeof value.settled, 'boolean');
      assert.ok(['refused', 'inconclusive', 'completed-review-client-verdict'].includes(value.outcome));
      // Guest source is hash-bound and strictly normalizes child metadata.
      actual.guest = value;
      actual.outcome = value.outcome;
    } catch { /* Never retain raw or malformed process output. */ }
  }
  writeFileSync(resolve(ATTEMPT, 'actual.json'), JSON.stringify(actual, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(actual) + '\n');
  return actual;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await execute(JSON.parse(process.argv[2]));
}
