import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { AppServerTransport, RpcError } from '../../src/computer/transport.ts';

const fixture = fileURLToPath(new URL('./fixture-server.mjs', import.meta.url));
function transport(mode = 'normal', extra: Partial<ConstructorParameters<typeof AppServerTransport>[0]> = {}) {
  return new AppServerTransport({ command: process.execPath, args: [fixture, mode], cwd: dirname(fixture),
    env: { TRANSPORT_FIXTURE_MARKER: 'isolated' }, requestTimeoutMs: 1500, stopTimeoutMs: 200, ...extra });
}
const rpcError = (code: string, outcome: 'failed' | 'unknown') => (error: unknown) => {
  assert.ok(error instanceof RpcError);
  assert.equal(error.code, code);
  assert.equal(error.outcome, outcome);
  return true;
};

test('initializes once with fixed identity and experimental capabilities off', async t => {
  const client = transport();
  t.after(() => client.stop());
  assert.equal(client.state().state, 'new');
  await assert.rejects(client.request('echo', {}), rpcError('TRANSPORT_NOT_READY', 'failed'));
  const start = client.start();
  assert.equal(client.start(), start);
  await start;
  assert.equal(client.state().state, 'ready');
  assert.ok(client.state().pid);
  assert.deepEqual(await client.request('handshake', {}), { initialized: true,
    handshake: { clientInfo: { name: 'neurobro_personal', title: 'Personal Neurobro', version: '0.1.0' }, capabilities: { experimentalApi: false } },
    calls: 0, marker: 'isolated' });
  assert.deepEqual(await client.stop(), { processExited: true, forced: false });
  assert.equal(client.state().state, 'closed');
});

test('reassembles byte chunks including split UTF-8 and correlates reversed multi-frame responses', async t => {
  const client = transport(); t.after(() => client.stop()); await client.start();
  assert.equal(await client.request('chunked', {}), 'Привет 🚀');
  assert.deepEqual(await Promise.all([client.request('reverse', { value: 1 }), client.request('reverse', { value: 2 })]), [1, 2]);
  assert.equal(await client.request('unknown', {}), 'correct');
});

test('notifications have removable listeners, and every server request receives -32601', async t => {
  const client = transport(); t.after(() => client.stop()); await client.start();
  const notices: unknown[] = [];
  const unsubscribe = client.onNotification((method, params) => notices.push({ method, params }));
  client.onNotification(() => { throw new Error('consumer exception'); });
  assert.equal(await client.request('notifications', {}), true);
  unsubscribe();
  await client.request('notifications', {});
  assert.deepEqual(notices, [{ method: 'fixture/notice', params: { value: 1 } }]);
  assert.deepEqual(await client.request('server-request', {}), { id: 'server-approval', error: { code: -32601, message: 'Client requests are not supported' } });
});

test('server refusal is a known failure and leaves the transport usable', async t => {
  const client = transport(); t.after(() => client.stop()); await client.start();
  await assert.rejects(client.request('error', {}), rpcError('SERVER_ERROR_-32001', 'failed'));
  assert.deepEqual(await client.request('echo', { value: 4 }), { value: 4 });
});

test('timeout makes all pending outcomes unknown, stops process and prevents another dispatch', async t => {
  const client = transport('normal', { requestTimeoutMs: 1000 }); t.after(() => client.stop()); await client.start();
  const a = assert.rejects(client.request('hang', {}), rpcError('REQUEST_TIMEOUT', 'unknown'));
  const b = assert.rejects(client.request('hang', {}), rpcError('REQUEST_TIMEOUT', 'unknown'));
  await Promise.all([a, b]);
  assert.deepEqual(await client.stop(), { processExited: true, forced: false });
  assert.equal(client.state().state, 'failed');
  assert.equal(client.state().reason, 'REQUEST_TIMEOUT');
  await assert.rejects(client.request('echo', {}), rpcError('TRANSPORT_NOT_READY', 'failed'));
});

test('explicit cancellation settles pending records and forced stop waits for child close', async t => {
  const client = transport('ignore-eof', { stopTimeoutMs: 50 }); t.after(() => client.stop()); await client.start();
  const pending = assert.rejects(client.request('hang', {}), rpcError('TRANSPORT_STOPPED', 'unknown'));
  const stop = client.stop();
  assert.equal(client.stop(), stop);
  assert.deepEqual(await stop, { processExited: true, forced: true });
  await pending;
  assert.equal(client.state().state, 'closed');
});

test('process exit rejects every pending request with an unknown outcome', async t => {
  const client = transport(); t.after(() => client.stop()); await client.start();
  const hanging = assert.rejects(client.request('hang', {}), rpcError('PROCESS_EXITED', 'unknown'));
  const exit = assert.rejects(client.request('exit', {}), rpcError('PROCESS_EXITED', 'unknown'));
  await Promise.all([hanging, exit]);
  assert.equal((await client.stop()).processExited, true);
  assert.equal(client.state().reason, 'PROCESS_EXITED');
});

for (const method of ['malformed', 'oversized', 'invalid-utf8', 'partial-exit']) {
  test(`${method} fails closed and settles the child`, async t => {
    const client = transport('normal', { maxLineBytes: 4096 }); t.after(() => client.stop()); await client.start();
    await assert.rejects(client.request(method, {}), rpcError('PROTOCOL_ERROR', 'unknown'));
    let receipt = await client.stop();
    if (!receipt.processExited) {
      // The initial 200ms grace/forced-close deadline can expire under aggregate load.
      // Require the original failure, then read exact owned closure rather than killing again.
      assert.equal(receipt.forced, true); assert.equal(client.state().reason, 'PROTOCOL_ERROR');
      const deadline = Date.now() + 1500;
      while (!receipt.processExited && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25)); receipt = await client.stop();
      }
    }
    assert.equal(receipt.processExited, true);
    assert.equal(client.state().reason, 'PROTOCOL_ERROR');
  });
}

test('retained partial buffer is bounded across chunks', async t => {
  const client = transport('normal', { maxLineBytes: 180 }); t.after(() => client.stop()); await client.start();
  await assert.rejects(client.request('oversized-chunks', {}), rpcError('PROTOCOL_ERROR', 'unknown'));
  assert.equal((await client.stop()).processExited, true);
});

for (const frame of [[], { id: 999, result: 1, error: { code: -1, message: 'bad' } }, { id: 999, error: 'bad' }, { method: 1 }]) {
  test(`invalid frame ${JSON.stringify(frame)} fails closed`, async t => {
    const client = transport(); t.after(() => client.stop()); await client.start();
    await assert.rejects(client.request('bad-frame', { frame }), rpcError('PROTOCOL_ERROR', 'unknown'));
    assert.equal((await client.stop()).processExited, true);
  });
}

test('initialization refusal closes the process and cannot be restarted', async t => {
  const client = transport('init-error'); t.after(() => client.stop());
  await assert.rejects(client.start(), rpcError('SERVER_ERROR_-32000', 'failed'));
  assert.equal((await client.stop()).processExited, true);
  assert.equal(client.state().state, 'failed');
  await assert.rejects(client.start(), rpcError('SERVER_ERROR_-32000', 'failed'));
});

test('stop before start closes transport without creating a process', async () => {
  const client = transport();
  assert.deepEqual(await client.stop(), { processExited: true, forced: false });
  await assert.rejects(client.start(), rpcError('TRANSPORT_NOT_READY', 'failed'));
  assert.equal(client.state().pid, undefined);
});

test('stop during handshake rejects initialization and waits for child close', async t => {
  const client = transport('init-hang'); t.after(() => client.stop());
  const start = assert.rejects(client.start(), rpcError('TRANSPORT_STOPPED', 'unknown'));
  assert.equal((await client.stop()).processExited, true);
  await start;
});

test('unserializable and oversized outgoing requests fail before dispatch', async t => {
  const client = transport('normal', { maxLineBytes: 500 }); t.after(() => client.stop()); await client.start();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  await assert.rejects(client.request('echo', cycle), rpcError('INVALID_REQUEST', 'failed'));
  await assert.rejects(client.request('echo', { text: 'x'.repeat(1000) }), rpcError('INVALID_REQUEST', 'failed'));
  assert.equal(client.state().state, 'ready');
});

test('spawn failure is known, closes transport, and does not leak pending requests', async t => {
  const client = transport('normal', { command: fileURLToPath(new URL('./does-not-exist.exe', import.meta.url)) });
  t.after(() => client.stop());
  await assert.rejects(client.start(), rpcError('SPAWN_FAILED', 'failed'));
  assert.equal((await client.stop()).processExited, true);
});

test('late owned child close reconciles an expired stop deadline without another kill or request', async () => {
  // Controlled child streams let the test withhold close independently of the OS scheduler.
  const child = Object.assign(new EventEmitter(), { pid: 42, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: (_signal: string) => { kills++; return true; } });
  let kills = 0; let requests = 0;
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line); requests++;
      if (request.method === 'initialize') setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: 'controlled fixture' } }) + '\n'));
      if (request.method === 'invalid-utf8') setImmediate(() => child.stdout.write(Buffer.from([0xff, 10])));
    }
  });
  const controlled = new AppServerTransport({ command: 'fixture', cwd: dirname(fixture), env: {}, stopTimeoutMs: 2 }, (() => child) as unknown as typeof spawn);
  await controlled.start();
  await assert.rejects(controlled.request('invalid-utf8', {}), rpcError('PROTOCOL_ERROR', 'unknown'));
  const original = await controlled.stop();
  assert.deepEqual(original, { processExited: false, forced: true });
  assert.equal(controlled.state().reason, 'PROTOCOL_ERROR');
  const requestCount = requests;
  child.emit('close', 0, null);
  assert.deepEqual(await controlled.stop(), { processExited: true, forced: true });
  assert.equal(original.processExited, false, 'original deadline receipt remains historical');
  assert.equal(kills, 1); assert.equal(requests, requestCount);
  await assert.rejects(controlled.request('echo', {}), rpcError('TRANSPORT_NOT_READY', 'failed'));
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});
