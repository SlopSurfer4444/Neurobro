import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesEngine, HermesError, HTTPScopedToolBridge } from '../../src/hermes/index.ts';
import type { EngineInput, RunBinding } from '../../src/contracts.ts';

// Wire shapes copied from pinned api_server.py::_handle_capabilities and
// api_server_runs.py::_accepted_response/_set_run_status, never compat chat mocks.
const capabilities = { object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: { run_submission: true, runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 }, session_resources: true, run_stop: true, run_steer: true, run_events_sse: true } };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'neurobro-hermes-'));
  const runs = new Map<string, { run_id: string; status: string; session_id: string; output?: string; error?: string }>();
  const reservations = new Map<string, { body: string; run_id: string }>(), sessions = new Set<string>();
  const calls: { path: string; method: string; body: any; key: string | undefined }[] = [];
  let durable = true, loseNextAdmission = false, sseCount = 0;
  const lastEventIds: (string | undefined)[] = [];
  const json = (r: ServerResponse, status: number, body: unknown) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(body)); };
  const server = createServer(async (q, r) => {
    let raw = ''; for await (const chunk of q) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined, path = q.url!, key = q.headers['idempotency-key'] as string | undefined;
    calls.push({ path, method: q.method!, body, key });
    if (path === '/v1/capabilities') { json(r, 200, { ...capabilities, features: { ...capabilities.features, runs_idempotency: { ...capabilities.features.runs_idempotency, durable } } }); return; }
    if (path === '/api/sessions' || path.endsWith('/fork')) {
      if (sessions.has(body.id)) { json(r, 409, { error: { code: 'session_exists' } }); return; }
      sessions.add(body.id); json(r, 201, { object: 'hermes.session', session: { id: body.id } }); return;
    }
    if (path === '/v1/runs') {
      let prior = reservations.get(key!);
      if (prior && prior.body !== raw) { json(r, 409, { error: { code: 'idempotency_key_conflict' } }); return; }
      if (!prior) { prior = { body: raw, run_id: `run_${reservations.size}` }; reservations.set(key!, prior); runs.set(prior.run_id, { run_id: prior.run_id, status: 'running', session_id: body.session_id }); }
      if (loseNextAdmission) { loseNextAdmission = false; q.socket.destroy(); return; }
      json(r, 202, { run_id: prior.run_id, status: 'started', replayed: false }); return;
    }
    const id = path.split('/')[3]!, run = runs.get(id);
    if (!run) { json(r, 404, { error: { code: 'run_not_found' } }); return; }
    if (path.endsWith('/stop')) { run.status = 'stopping'; json(r, 200, { run_id: id, status: 'stopping' }); return; }
    if (path.endsWith('/steer')) { json(r, 200, { object: 'hermes.run.steer', run_id: id, accepted: true }); return; }
    if (path.endsWith('/events')) {
      lastEventIds.push(q.headers['last-event-id'] as string | undefined); r.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const seq = sseCount++; if (seq === 1) { run.status = 'completed'; run.output = 'done'; }
      r.end(`id: ${seq}\ndata: ${JSON.stringify({ run_id: id, event: seq ? 'run.completed' : 'run.running', seq })}\n\n`); return;
    }
    json(r, 200, { object: 'hermes.run', ...run, updated_at: Date.now() / 1000 });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, statePath: join(dir, 'admissions.sqlite'), requestTimeoutMs: 500, maxWaitMs: 70, pollIntervalMs: 10 };
  return { dir, options, runs, calls, reservations, lastEventIds, setDurable: (b: boolean) => durable = b, lose: () => loseNextAdmission = true, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}
const input: EngineInput = { taskId: 'taskA', intentRevision: 1, idempotencyKey: 'logical-operation-1', instruction: 'Compute fixture' };

test('native durable admission survives lost response/restart and rejects a conflicting request', async () => {
  const f = await fixture(); let engine = new HermesEngine(f.options);
  try {
    f.lose(); await assert.rejects(engine.submit(input), (e: any) => e.code === 'transport_unknown'); engine.close(); engine = new HermesEngine(f.options);
    const accepted = await engine.submit(input); assert.equal(f.reservations.size, 1);
    assert.equal(accepted.binding.taskId, input.taskId); assert.equal(accepted.binding.intentRevision, 1);
    await assert.rejects(engine.submit({ ...input, instruction: 'Different' }), (e: any) => e.code === 'idempotency_key_conflict');
    const repeat = await engine.submit(input); assert.equal(repeat.binding.runId, accepted.binding.runId); assert.equal(f.calls.filter(x => x.path === '/v1/runs').length, 2);
  } finally { engine.close(); await f.close(); }
});
test('memory-only upstream gate refuses admission; old uncertain key beyond retention cannot replay', async () => {
  const f = await fixture(); let now = 1; const engine = new HermesEngine({ ...f.options, now: () => now });
  try {
    f.setDurable(false); await assert.rejects(engine.submit(input), (e: any) => e.code === 'durability_unavailable'); assert.equal(f.reservations.size, 0);
    f.setDurable(true); f.lose(); await assert.rejects(engine.submit(input)); now += 86400000;
    await assert.rejects(engine.submit(input), (e: any) => e.code === 'idempotency_retention_expired'); assert.equal(f.calls.filter(x => x.path === '/v1/runs').length, 1);
  } finally { engine.close(); await f.close(); }
});
test('stop is cooperative, waits are bounded, changed-revision steering is refused', async () => {
  const f = await fixture(); const engine = new HermesEngine(f.options);
  try {
    const accepted = await engine.submit(input), binding = accepted.binding;
    const running = await engine.steer(binding, 'clarify', 1); assert.equal(running.state, 'running');
    await assert.rejects(engine.steer(binding, 'new grant', 2), (e: any) => e.code === 'scope_revision_changed');
    const stopped = await engine.cancel(binding); assert.equal(stopped.state, 'waiting'); assert.match(stopped.reason!, /settlement is not yet confirmed/);
    const start = Date.now(), bounded = await engine.wait(binding); assert.ok(Date.now() - start < 300); assert.match(bounded.reason!, /budget_exhausted/);
    await assert.rejects(engine.inspect({ ...binding, taskId: 'other' }), (e: any) => e.code === 'binding_mismatch');
  } finally { engine.close(); await f.close(); }
});
test('interrupted run stays interrupted until explicit reconciled distinct continuation', async () => {
  const f = await fixture(); const engine = new HermesEngine(f.options);
  try {
    const first = await engine.submit(input); f.runs.get(first.binding.runId)!.status = 'interrupted';
    assert.equal((await engine.submit(input)).state, 'interrupted'); assert.equal(f.reservations.size, 1);
    await assert.rejects(engine.continueInterrupted(first.binding, { ...input, idempotencyKey: 'continue-1' }, { oldExecutionSettled: true, effectsReconciled: false, checkpoint: 'one saved result' }), (e: any) => e.code === 'continuation_requires_reconciliation');
    const second = await engine.continueInterrupted(first.binding, { ...input, idempotencyKey: 'continue-1', instruction: 'Finish remaining calculation' }, { oldExecutionSettled: true, effectsReconciled: true, checkpoint: 'one saved result' });
    assert.notEqual(second.binding.runId, first.binding.runId); assert.equal(f.reservations.size, 2); assert.match(f.calls.filter(x => x.path === '/v1/runs').at(-1)!.body.input, /Continue from saved checkpoint/);
  } finally { engine.close(); await f.close(); }
});
test('scoped tools use immutable unique native sessions, credentials never enter model body', async () => {
  const f = await fixture(), registrations: unknown[] = []; const engine = new HermesEngine({ ...f.options, bridge: { register: async entry => { registrations.push(entry); } } });
  try {
    const first = await engine.submit({ ...input, toolContext: 'opaque-secret-token' });
    assert.equal(registrations.length, 1); assert.ok(!JSON.stringify(f.calls).includes('opaque-secret-token'));
    f.runs.get(first.binding.runId)!.status = 'completed';
    const next = await engine.submit({ ...input, idempotencyKey: 'revision-2', intentRevision: 2, toolContext: 'new-secret-token', sessionId: first.binding.sessionId });
    assert.notEqual(next.binding.sessionId, first.binding.sessionId); assert.ok(f.calls.some(c => c.path.endsWith('/fork')));
  } finally { engine.close(); await f.close(); }
});
test('tool context is refused without bridge; staged files require scoped root and hash manifest', async () => {
  const f = await fixture(); const engine = new HermesEngine({ ...f.options, artifactRoot: join(f.dir, 'allowed') });
  try {
    await assert.rejects(engine.submit({ ...input, toolContext: 'token' }), (e: any) => e.code === 'scoped_tools_unavailable');
    await mkdir(join(f.dir, 'allowed')); await writeFile(join(f.dir, 'allowed', 'doc.txt'), 'asset'); await writeFile(join(f.dir, 'outside'), 'secret');
    await assert.rejects(engine.submit({ ...input, stagedFiles: [join(f.dir, 'outside')] }), (e: any) => e.code === 'artifact_scope_violation');
    await engine.submit({ ...input, stagedFiles: [join(f.dir, 'allowed', 'doc.txt')] });
    assert.match(f.calls.find(c => c.path === '/v1/runs')!.body.input, /sha256/);
  } finally { engine.close(); await f.close(); }
});
test('native SSE reconnect sends last sequence and observes terminal snapshot', async () => {
  const f = await fixture(); const engine = new HermesEngine(f.options);
  try {
    const accepted = await engine.submit(input); const states = [];
    for await (const snapshot of engine.events(accepted.binding)) states.push(snapshot.state);
    assert.deepEqual(states, ['running', 'completed']); assert.deepEqual(f.lastEventIds, [undefined, '0']);
  } finally { engine.close(); await f.close(); }
});
test('plugin restart restoration verifies exact original token and immutable native identity', async () => {
  const f = await fixture(); const bindings = new Map<string, string>();
  const engine = new HermesEngine({ ...f.options, bridge: { register: async entry => { bindings.set(entry.sessionId, entry.toolContext); } } });
  try {
    const accepted = await engine.submit({ ...input, toolContext: 'original-scoped-token' });
    bindings.clear(); assert.equal(bindings.size, 0);
    await assert.rejects(engine.restoreToolBinding(accepted.binding, 'forged'), (e: any) => e.code === 'tool_binding_conflict');
    await engine.restoreToolBinding(accepted.binding, 'original-scoped-token');
    assert.equal(bindings.get(accepted.binding.sessionId!), 'original-scoped-token');
    const bytes = await import('node:fs/promises').then(fs => fs.readFile(f.options.statePath));
    assert.ok(!bytes.includes(Buffer.from('original-scoped-token'))); assert.ok(!bytes.includes(Buffer.from(input.instruction)));
  } finally { engine.close(); await f.close(); }
});
test('native compression rotates transcript pointer while original tool authority stays immutable', async () => {
  const f = await fixture(); const registrations: string[] = [];
  const engine = new HermesEngine({ ...f.options, bridge: { register: async entry => { registrations.push(entry.sessionId); } } });
  try {
    const first = await engine.submit({ ...input, toolContext: 'token' }), originalSession = first.binding.sessionId!;
    const native = f.runs.get(first.binding.runId)!; native.session_id = 'compressed-tip'; native.status = 'completed';
    const snapshot = await engine.inspect(first.binding); assert.equal(snapshot.binding.sessionId, 'compressed-tip');
    const context = { taskId: input.taskId, intentRevision: 1, runId: first.binding.runId, grantId: 'grant', grantRevision: 1 };
    assert.equal(engine.immutableAdmissionSession(context), originalSession);
    assert.throws(() => engine.immutableAdmissionSession({ ...context, taskId: 'foreign' }), (e: any) => e.code === 'binding_mismatch');
    assert.throws(() => engine.immutableAdmissionSession({ ...context, intentRevision: 2 }), (e: any) => e.code === 'binding_mismatch');
    await engine.restoreToolBinding(snapshot.binding, 'token'); assert.equal(registrations.at(-1), originalSession);
    const next = await engine.submit({ ...input, intentRevision: 2, idempotencyKey: 'new-revision', sessionId: snapshot.binding.sessionId, toolContext: 'token2' });
    assert.ok(f.calls.some(c => c.path === '/api/sessions/compressed-tip/fork')); assert.notEqual(next.binding.sessionId, originalSession);
  } finally { engine.close(); await f.close(); }
});
test('cron is explicitly unavailable without safe failure delivery and correlated result support', async () => {
  const f = await fixture(); const engine = new HermesEngine(f.options);
  try { await assert.rejects(engine.createLocalSchedule({ name: 'job', schedule: 'daily', instruction: 'compute' }), (e: any) => e.code === 'schedule_result_unavailable'); assert.equal(f.calls.length, 0); }
  finally { engine.close(); await f.close(); }
});
test('another task cannot inherit a credential session or fork its private history', async () => {
  const f = await fixture(); const engine = new HermesEngine({ ...f.options, bridge: { register: async () => {} } });
  try {
    const owner = await engine.submit({ ...input, toolContext: 'task-A-scope' }); f.runs.get(owner.binding.runId)!.status = 'completed';
    for (const toolContext of [undefined, 'task-B-scope']) {
      await assert.rejects(engine.submit({ ...input, taskId: 'task-B', idempotencyKey: toolContext ? 'B-with-token' : 'B-no-token', sessionId: owner.binding.sessionId, toolContext }), (e: any) => e.code === 'session_task_mismatch');
    }
    assert.equal(f.reservations.size, 1); assert.ok(!f.calls.some(c => c.path.endsWith('/fork')));
    const pure = await engine.submit({ ...input, idempotencyKey: 'A-pure-next', sessionId: owner.binding.sessionId });
    assert.notEqual(pure.binding.sessionId, owner.binding.sessionId);
  } finally { engine.close(); await f.close(); }
});
test('slow trusted registration crossing retention cannot dispatch a replay', async () => {
  const f = await fixture(); let now = 1, crossing = false;
  const engine = new HermesEngine({ ...f.options, now: () => now, bridge: { register: async () => { if (crossing) now += 2000; } } });
  try {
    f.lose(); await assert.rejects(engine.submit({ ...input, toolContext: 'token' }));
    now += 86400000 - 1000; crossing = true;
    await assert.rejects(engine.submit({ ...input, toolContext: 'token' }), (e: any) => e.code === 'idempotency_retention_expired');
    assert.equal(f.calls.filter(c => c.path === '/v1/runs').length, 1);
  } finally { engine.close(); await f.close(); }
});
