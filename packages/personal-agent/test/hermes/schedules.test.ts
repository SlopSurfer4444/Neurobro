import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPersonalAgent } from '../../src/core/index.ts';
import type { EnginePort, Grant, TaskIntent, ToolContext } from '../../src/contracts.ts';
import { HermesScheduleCoordinator, createScheduleServer, type ScheduleManifest } from '../../src/hermes/schedules.ts';

const scope: ToolContext = { taskId: 'task-A', intentRevision: 1, grantId: 'grant-A', grantRevision: 1, runId: 'foreground-A' };
const spec = { key: 'daily-check', name: 'Recurring research', schedule: '0 12 * * *', instruction: 'Inspect a read-only fixture' };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'neurobro-schedules-')), key = randomBytes(32), databasePath = join(dir, 'broker.sqlite');
  let now = Date.parse('2026-10-04T12:00:00Z'), submissions = 0, lostCreate = false, lostPause = false, callbackFailure = false;
  let preferencesRevision = 1, preparationFails = false;
  let lookupEnabled = false;
  let controlObserver: (() => void) | undefined;
  const preparations: ToolContext[] = [];
  const engine: EnginePort = { async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
    async submit() { submissions++; throw new Error('Cron must not submit foreground work'); }, async inspect() { throw new Error('No foreground inspection'); }, async cancel() { throw new Error('No foreground cancel'); } };
  const options = { databasePath, encryptionKey: key, accountId: 'account-A', ownerId: 'owner-A', privateRoute: { peerId: 'private' }, engine, clock: { now: () => new Date(now) },
    validateToolContext: (context: ToolContext) => {
      const projection = agent.store.get<{ context: ToolContext; preferencesRevision: number }>('scheduleContextFixtures', context.runId);
      if (!projection || projection.preferencesRevision !== preferencesRevision || JSON.stringify(projection.context) !== JSON.stringify(context)) throw new Error('Per-execution owner context is stale or missing');
    } };
  let agent = createPersonalAgent(options);
  const intent: TaskIntent = { id: scope.taskId, ownerId: 'owner-A', accountId: 'account-A', source: { accountId: 'account-A', peerId: 'private', messageId: '1' }, instruction: 'Owner-approved recurring task', revision: 1, route: { peerId: 'private' }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), contextRefs: [], artifactRefs: [], grantId: scope.grantId };
  const grant: Grant = { id: scope.grantId, taskId: scope.taskId, revision: 1, capabilities: [{ capability: 'web.search', resources: ['web'] }], expiresAt: new Date(now + 7 * 86400000).toISOString() };
  agent.store.put('tasks', intent.id, intent); agent.store.put('grants', grant.id, grant);
  const foreground = { runId: scope.runId, state: 'completed', output: 'Saved foreground output', observedAt: new Date(now).toISOString() };
  agent.store.put('runs', `${intent.id}:1`, foreground);
  const jobs = new Map<string, { id: string; key: string; schedule_context: string; state: string; spec: unknown }>();
  const manifests = new Map<string, ScheduleManifest>(), calls: { method?: string; path: string; body: any }[] = [], bindings = new Map<string, string>();
  const registrationKey = randomBytes(32).toString('base64url');
  const failedBindings = new Set<string>();
  const send = (response: ServerResponse, status: number, data: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
  const native = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${registrationKey}`) { send(response, 403, { ok: false }); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined, path = request.url!;
    calls.push({ method: request.method, path, body });
    if (path === '/cron/jobs') {
      let job = jobs.get(body.key);
      if (job && JSON.stringify(job.spec) !== JSON.stringify(body)) { send(response, 409, { ok: false }); return; }
      if (!job) { job = { id: 'native-job-' + jobs.size, key: body.key, schedule_context: body.schedule_context, state: 'active', spec: body }; jobs.set(body.key, job); }
      if (lostCreate) { lostCreate = false; request.socket.destroy(); return; }
      send(response, 200, { ok: true, job: { id: job.id, state: job.state } }); return;
    }
    if (path === '/cron/bindings') { const prior = bindings.get(body.key); if (!jobs.has(body.key) || failedBindings.has(body.key) || (prior && prior !== body.schedule_context)) { send(response, 409, { ok: false }); return; } bindings.set(body.key, body.schedule_context); send(response, 200, { ok: true }); return; }
    if (path.startsWith('/cron/lookup/') && lookupEnabled) {
      const key = path.slice('/cron/lookup/'.length), job = jobs.get(key);
      send(response, 200, job && job.state !== 'cancelled' ? { ok: true, key, scopeVerified: true, job: { id: job.id, required_admission: 'neurobro', admission_key: key } } : { ok: true, key, job: null, absenceVerified: true }); return;
    }
    if (path.startsWith('/cron/results/')) { const id = path.slice('/cron/results/'.length); const manifest = manifests.get(id); send(response, manifest ? 200 : 404, manifest ? { ok: true, manifest } : { ok: false }); return; }
    const [, , , jobId, action] = path.split('/'), job = [...jobs.values()].find(item => item.id === jobId);
    if (!job) { send(response, 404, { ok: false }); return; }
    if (action) { controlObserver?.(); job.state = action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'cancelled'; if (lostPause) { lostPause = false; request.socket.destroy(); return; } }
    send(response, 200, { ok: true, job: { id: job.id, state: job.state } });
  });
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(native.address() as { port: number }).port}`;
  const callbacks: ScheduleManifest[] = [];
  const core = () => ({ store: agent.store, validateScope: (context: ToolContext) => { agent.validateAuthority(context); }, issueToolContext: (context: ToolContext) => agent.issueExecutionContext(context), resolveToolContext: (token: string) => agent.resolveToolContext(token),
    revokeToolContext: (token: string) => agent.revokeToolContext(token) });
  const openCoordinator = () => new HermesScheduleCoordinator({ core: core(), native: { baseUrl, registrationKey, timeoutMs: 1000 },
    prepareExecution: context => {
      if (preparationFails) throw new Error('Fresh context is unavailable');
      assert.equal(agent.store.list('contexts').some((entry: any) => entry.context.runId === context.runId), false, 'Preparation must precede token issuance');
      agent.store.put('scheduleContextFixtures', context.runId, { context: { ...context }, preferencesRevision }); preparations.push({ ...context });
    },
    onComplete: async (_context, manifest) => { callbacks.push(manifest); if (callbackFailure) throw new Error('Effect outcome uncertain'); } });
  let coordinator = openCoordinator(); let broker = await createScheduleServer(coordinator);
  async function post(path: string, credential: string, body: unknown) {
    const response = await fetch(broker.address + path, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  return { dir, options, nativeOptions: { baseUrl, registrationKey }, jobs, manifests, calls, bindings, callbacks, foreground, preparations, changePreferences: () => { preferencesRevision++; }, failPreparation: (value = true) => { preparationFails = value; }, get agent() { return agent; }, get coordinator() { return coordinator; }, post,
    credential: () => [...jobs.values()][0]!.schedule_context, failBinding: (id: string, failed = true) => { if (failed) failedBindings.add(id); else failedBindings.delete(id); }, enableLookup: () => { lookupEnabled = true; }, observeControl: (callback: () => void) => { controlObserver = callback; }, loseCreate: () => { lostCreate = true; }, losePause: () => { lostPause = true; }, failCallback: () => { callbackFailure = true; }, advance: (ms: number) => { now += ms; }, submissions: () => submissions,
    async reopen() { await broker.close(); agent.close(); agent = createPersonalAgent(options); coordinator = openCoordinator(); broker = await createScheduleServer(coordinator); },
    async close() { await broker.close(); native.closeAllConnections(); await new Promise<void>(resolve => native.close(() => resolve())); agent.close(); await rm(dir, { recursive: true, force: true }); } };
}
const admission = (job: string, execution = 'execution-1') => ({ job_id: job, execution_id: execution, task_id: `cron:${job}:${execution}` });
const completed = (job: string, execution = 'execution-1'): ScheduleManifest => ({ ...admission(job, execution), outcome: 'completed', output_file: '/private/hermes/exact-output.txt', output_sha256: 'a'.repeat(64), output_size: 42 });

test('native creation uncertainty reconciles one job, durable separate credentials and foreground state remain intact', async () => {
  const f = await fixture();
  try {
    f.loseCreate(); await assert.rejects(f.coordinator.create(scope, spec));
    assert.equal(f.jobs.size, 1); await f.reopen();
    const schedule = await f.coordinator.create(scope, spec); assert.equal(f.jobs.size, 1);
    const credential = f.credential(); const admitted = await f.post('/schedules/admit', credential, admission(schedule.jobId!));
    assert.equal(admitted.status, 200); const token = admitted.body.tool_context;
    assert.equal(f.agent.resolveToolContext(token).runId, `cron:${schedule.jobId}:execution-1`);
    assert.notEqual(token, credential); assert.equal(f.submissions(), 0);
    assert.deepEqual(f.agent.store.get('runs', 'task-A:1'), f.foreground);
    assert.ok(!JSON.stringify(f.coordinator.list(scope)).includes(credential));
    await f.reopen(); await f.coordinator.restoreBindings();
    const repeat = await f.post('/schedules/admit', credential, admission(schedule.jobId!));
    assert.equal(repeat.body.tool_context, token); assert.equal(f.bindings.get(schedule.id), credential);
    for (const name of await readdir(f.dir)) {
      const bytes = await readFile(join(f.dir, name)); assert.ok(!bytes.includes(Buffer.from(token))); assert.ok(!bytes.includes(Buffer.from(credential))); assert.ok(!bytes.includes(Buffer.from(spec.instruction)));
    }
  } finally { await f.close(); }
});

test('restart preserves uncertain creation without restoring or replaying an unconfirmed native identity', async () => {
  const f = await fixture();
  try {
    f.loseCreate(); await assert.rejects(f.coordinator.create(scope, spec));
    const unresolved = f.coordinator.list(scope)[0]!, credential = f.credential();
    // Native registration may have been lost before its own durable insert.
    // Neither case may prevent the broker from starting for reconciliation.
    const nativeJob = [...f.jobs.values()][0]!; f.jobs.clear();
    await f.reopen(); const calls = f.calls.length;
    await f.coordinator.restoreBindings();
    assert.equal(f.calls.length, calls); assert.deepEqual(f.coordinator.list(scope)[0], unresolved);
    assert.equal((await f.post('/schedules/admit', credential, admission(nativeJob.id))).status, 403);
    f.jobs.set(nativeJob.key, nativeJob);
    const reconciled = await f.coordinator.create(scope, spec);
    assert.equal(reconciled.jobId, nativeJob.id); assert.equal(f.jobs.size, 1);
  } finally { await f.close(); }
});

test('failed known native restoration quarantines only that schedule and still restores healthy jobs across restart', async () => {
  const f = await fixture();
  try {
    const unhealthy = await f.coordinator.create(scope, spec), unhealthyCredential = f.credential();
    const healthy = await f.coordinator.create(scope, { ...spec, key: 'healthy' });
    const healthyCredential = f.jobs.get(healthy.id)!.schedule_context;
    f.failBinding(unhealthy.id); await f.reopen();
    assert.deepEqual(await f.coordinator.restoreBindings(), { restored: 1, degraded: 1, skipped: 0 });
    assert.equal(f.bindings.get(healthy.id), healthyCredential);
    assert.equal(f.coordinator.list(scope).find(entry => entry.id === unhealthy.id)!.nativeBinding!.state, 'unknown');
    assert.equal((await f.post('/schedules/admit', unhealthyCredential, admission(unhealthy.jobId!))).status, 403);
    assert.equal((await f.post('/schedules/admit', healthyCredential, admission(healthy.jobId!))).status, 200);
    await f.reopen();
    assert.equal((await f.post('/schedules/admit', unhealthyCredential, admission(unhealthy.jobId!))).status, 403);
    f.failBinding(unhealthy.id, false);
    assert.deepEqual(await f.coordinator.restoreBindings(), { restored: 2, degraded: 0, skipped: 0 });
    assert.equal((await f.post('/schedules/admit', unhealthyCredential, admission(unhealthy.jobId!))).status, 200);
    assert.equal(f.calls.filter(call => call.path === '/cron/jobs').length, 2, 'Restoration must not recreate either job');
  } finally { await f.close(); }
});

test('schedule cannot transfer scope, reuse immutable key for another spec, or admit wrong native job/task identity', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential();
    await assert.rejects(f.coordinator.create(scope, { ...spec, instruction: 'Different request' }));
    await assert.rejects(f.coordinator.inspect({ ...scope, taskId: 'task-B' }, schedule.id));
    for (const body of [{ ...admission(schedule.jobId!), job_id: 'different' }, { ...admission(schedule.jobId!), task_id: scope.taskId }, { ...admission(schedule.jobId!), grant_id: 'model-grant' }, admission(schedule.jobId!, '__proto__'), admission(schedule.jobId!, 'constructor')]) {
      assert.equal((await f.post('/schedules/admit', credential, body)).status, 403);
    }
    assert.equal((await f.post('/schedules/admit', 'forged-token', admission(schedule.jobId!))).status, 403);
    assert.equal(f.agent.store.list('contexts').length, 0);
  } finally { await f.close(); }
});

test('revision, revoked grant and expiration block fire and completion across cold restart', async () => {
  for (const mutation of ['revision', 'revoked', 'expired'] as const) {
    const f = await fixture();
    try {
      const schedule = await f.coordinator.create(scope, spec), credential = f.credential();
      assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 200);
      const grant = f.agent.store.get<Grant>('grants', scope.grantId)!;
      if (mutation === 'revision') { grant.revision++; f.agent.store.put('grants', grant.id, grant); }
      if (mutation === 'revoked') { grant.revokedAt = '2026-10-04T12:00:00Z'; f.agent.store.put('grants', grant.id, grant); }
      if (mutation === 'expired') f.advance(8 * 86400000);
      await f.reopen(); await f.coordinator.restoreBindings(); assert.equal(f.bindings.size, 0);
      assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!, 'execution-2'))).status, 403);
      const manifest = completed(schedule.jobId!); f.manifests.set(`${schedule.jobId}/execution-1`, manifest);
      assert.equal((await f.post('/schedules/complete', credential, manifest)).status, 403); assert.equal(f.callbacks.length, 0);
      assert.equal(f.agent.store.list('contexts').length, 1);
    } finally { await f.close(); }
  }
});

test('pause uncertainty blocks new admissions and revokes existing contexts; resume requires a fresh execution', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential();
    const token = (await f.post('/schedules/admit', credential, admission(schedule.jobId!))).body.tool_context;
    f.losePause(); await assert.rejects(f.coordinator.control(scope, schedule.id, 'pause'));
    assert.throws(() => f.agent.resolveToolContext(token));
    assert.equal(f.coordinator.list(scope)[0]!.state, 'pause-pending');
    const callsBeforeOpposite = f.calls.length;
    await assert.rejects(f.coordinator.control(scope, schedule.id, 'resume'), /same-action/);
    assert.equal(f.calls.length, callsBeforeOpposite, 'Opposite action must fail before native dispatch');
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!, 'execution-2'))).status, 403);
    await f.reopen(); const paused = await f.coordinator.control(scope, schedule.id, 'pause'); assert.equal(paused.state, 'paused'); assert.equal(paused.activeExecutionsMayRemain, true);
    await f.coordinator.control(scope, schedule.id, 'resume');
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 403);
    const fresh = await f.post('/schedules/admit', credential, admission(schedule.jobId!, 'execution-2')); assert.equal(fresh.status, 200); assert.notEqual(fresh.body.tool_context, token);
    const manifest = completed(schedule.jobId!); f.manifests.set(`${schedule.jobId}/execution-1`, manifest);
    assert.equal((await f.post('/schedules/complete', credential, manifest)).status, 200); assert.equal(f.callbacks.length, 0);
    await f.coordinator.control(scope, schedule.id, 'cancel'); assert.throws(() => f.agent.resolveToolContext(fresh.body.tool_context));
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!, 'execution-3'))).status, 403);
  } finally { await f.close(); }
});

test('completion accepts only native exact job/execution manifest, persists once and never changes foreground output', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential(), manifest = completed(schedule.jobId!);
    f.manifests.set(`${schedule.jobId}/execution-1`, manifest);
    assert.equal((await f.post('/schedules/complete', credential, manifest)).status, 403);
    await f.post('/schedules/admit', credential, admission(schedule.jobId!));
    for (const body of [{ ...manifest, output_file: '/different/file' }, { ...manifest, output_sha256: 'b'.repeat(64) }, { ...manifest, outcome: 'failed' }, { ...manifest, task_id: 'another-task' }]) assert.equal((await f.post('/schedules/complete', credential, body)).status, 403);
    const first = await f.post('/schedules/complete', credential, manifest); assert.deepEqual(first.body, { ok: true, replayed: false, callback: 'verified' }); assert.equal(f.callbacks.length, 1);
    await f.reopen(); const repeat = await f.post('/schedules/complete', credential, manifest); assert.deepEqual(repeat.body, { ok: true, replayed: true, callback: 'verified' }); assert.equal(f.callbacks.length, 1);
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 403);
    f.manifests.set(`${schedule.jobId}/execution-1`, { ...manifest, output_sha256: 'b'.repeat(64) });
    assert.equal((await f.post('/schedules/complete', credential, { ...manifest, output_sha256: 'b'.repeat(64) })).status, 403);
    assert.deepEqual(f.agent.store.get('runs', 'task-A:1'), f.foreground); assert.equal(f.submissions(), 0);
  } finally { await f.close(); }
});

test('unknown native result is recorded honestly without completion delivery callback', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential(); await f.post('/schedules/admit', credential, admission(schedule.jobId!));
    const manifest: ScheduleManifest = { ...admission(schedule.jobId!), outcome: 'unknown', output_file: null, output_sha256: null };
    f.manifests.set(`${schedule.jobId}/execution-1`, manifest); assert.equal((await f.post('/schedules/complete', credential, manifest)).status, 200);
    assert.equal(f.coordinator.list(scope)[0]!.executions[0]!.state, 'unknown'); assert.equal(f.callbacks.length, 0);
  } finally { await f.close(); }
});

test('multiline instructions survive native creation; expired execution tokens cannot be reissued by admission replay', async () => {
  const f = await fixture();
  try {
    const instruction = 'Read the source.\nReturn a table:\n\tdate, result';
    const schedule = await f.coordinator.create(scope, { ...spec, instruction });
    assert.equal(f.calls[0]!.body.instruction, instruction);
    const credential = f.credential(); const first = await f.post('/schedules/admit', credential, admission(schedule.jobId!)); assert.equal(first.status, 200);
    f.advance(2 * 86400000); await f.reopen();
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 403);
    const fresh = await f.post('/schedules/admit', credential, admission(schedule.jobId!, 'execution-2')); assert.equal(fresh.status, 200); assert.notEqual(fresh.body.tool_context, first.body.tool_context);
  } finally { await f.close(); }
});

test('uncertain completion callback is durable and explicitly requires reconciliation without automatic replay', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential(), manifest = completed(schedule.jobId!);
    await f.post('/schedules/admit', credential, admission(schedule.jobId!)); f.manifests.set(`${schedule.jobId}/execution-1`, manifest); f.failCallback();
    const result = await f.post('/schedules/complete', credential, manifest); assert.deepEqual(result.body, { ok: true, replayed: false, callback: 'unknown', reconciliation_required: true }); assert.equal(f.callbacks.length, 1);
    await f.reopen(); const replay = await f.post('/schedules/complete', credential, manifest); assert.equal(replay.body.reconciliation_required, true); assert.equal(f.callbacks.length, 1);
    assert.equal(f.coordinator.list(scope)[0]!.executions[0]!.callbackState, 'unknown');
  } finally { await f.close(); }
});

test('failure saving admission rolls back both new tool credential and schedule execution atomically', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential();
    const original = f.agent.store.put.bind(f.agent.store); let fail = true;
    f.agent.store.put = <T>(collection: string, key: string, value: T) => {
      if (fail && collection === 'hermesSchedules') { fail = false; throw new Error('Injected commit failure'); }
      original(collection, key, value);
    };
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 403);
    assert.equal(f.agent.store.list('contexts').length, 0); assert.equal(f.coordinator.list(scope)[0]!.executions.length, 0);
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 200);
    assert.equal(f.agent.store.list('contexts').length, 1);
  } finally { await f.close(); }
});

test('trusted host cancels an exact revoked schedule without grant renewal and withdraws tokens before native control', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential();
    await f.post('/schedules/admit', credential, admission(schedule.jobId!));
    const grant = f.agent.store.get<Grant>('grants', scope.grantId)!; grant.revokedAt = '2026-10-04T12:00:00Z'; f.agent.store.put('grants', grant.id, grant);
    await assert.rejects(f.coordinator.control(scope, schedule.id, 'cancel'));
    f.observeControl(() => {
      const tokens = f.agent.store.list<{ revokedAt?: string }>('contexts'); assert.equal(tokens.length, 1); assert.ok(tokens.every(token => token.revokedAt));
      const records = f.agent.store.list<any>('hermesSchedules'); assert.equal(records[0].state, 'cancelled'); assert.equal(records[0].pendingControl, 'cancel');
    });
    const result = await f.coordinator.cancelFromHost({ taskId: scope.taskId, scheduleId: schedule.id, key: spec.key, nativeJobId: schedule.jobId });
    assert.equal(result.nativeCleanup, 'verified'); assert.equal(result.schedule.state, 'cancelled');
    assert.deepEqual(f.agent.store.get('grants', grant.id), grant); assert.equal(f.agent.store.list('contexts').length, 1);
    const calls = f.calls.length; await f.reopen();
    assert.equal((await f.coordinator.cancelFromHost({ taskId: scope.taskId, key: spec.key })).nativeCleanup, 'verified'); assert.equal(f.calls.length, calls);
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!, 'execution-2'))).status, 403);
    assert.deepEqual(f.agent.store.get('runs', 'task-A:1'), f.foreground); assert.equal(f.submissions(), 0);
  } finally { await f.close(); }
});

test('host cancellation refuses cross-task, mismatched native identity and ambiguous immutable key before any mutation', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), calls = f.calls.length;
    for (const request of [{ taskId: 'other-task', scheduleId: schedule.id }, { taskId: scope.taskId, scheduleId: schedule.id, nativeJobId: 'wrong-native-job' }, { taskId: scope.taskId, key: 'wrong-key' }, { taskId: scope.taskId }]) await assert.rejects(f.coordinator.cancelFromHost(request));
    const original = f.agent.store.list<any>('hermesSchedules')[0];
    f.agent.store.put('hermesSchedules', 'duplicate-fixture', { ...original, id: 'duplicate-fixture' });
    await assert.rejects(f.coordinator.cancelFromHost({ taskId: scope.taskId, key: spec.key }));
    assert.equal(f.calls.length, calls);
    assert.ok(f.agent.store.list<any>('hermesSchedules').every(record => record.state === 'active' && !record.pendingControl));
  } finally { await f.close(); }
});

test('uncertain prepared creation is permanently blocked locally without creating or resuming a native job to cancel it', async () => {
  const f = await fixture();
  try {
    f.loseCreate(); await assert.rejects(f.coordinator.create(scope, spec)); assert.equal(f.jobs.size, 1);
    const mutations = f.calls.filter(call => call.method === 'POST').length, credential = f.credential();
    const result = await f.coordinator.cancelFromHost({ taskId: scope.taskId, key: spec.key });
    assert.equal(result.nativeCleanup, 'unknown'); assert.equal(result.reason, 'native_job_identity_unknown'); assert.equal(result.schedule.state, 'cancel-pending'); assert.equal(result.schedule.jobId, undefined);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, mutations); assert.equal(f.agent.store.list('contexts').length, 0);
    await f.reopen(); await f.coordinator.restoreBindings();
    const repeated = await f.coordinator.cancelFromHost({ taskId: scope.taskId, scheduleId: result.schedule.id }); assert.equal(repeated.nativeCleanup, 'unknown');
    const recreated = await f.coordinator.create(scope, spec); assert.equal(recreated.state, 'cancel-pending'); assert.equal(f.calls.filter(call => call.method === 'POST').length, mutations); assert.equal(f.jobs.size, 1);
    assert.equal((await f.post('/schedules/admit', credential, admission([...f.jobs.values()][0]!.id))).status, 403);
    assert.equal(f.agent.store.list('contexts').length, 0);
  } finally { await f.close(); }
});

test('host withdrawal reconciles uncertain creation by read-only exact key and cancels without recreating or resuming', async () => {
  const f = await fixture();
  try {
    f.enableLookup(); f.loseCreate(); await assert.rejects(f.coordinator.create(scope, spec));
    const prepared = f.coordinator.list(scope)[0]!, native = [...f.jobs.values()][0]!, credential = f.credential();
    const grant = f.agent.store.get<Grant>('grants', scope.grantId)!; grant.revokedAt = '2026-10-04T12:00:00Z'; f.agent.store.put('grants', grant.id, grant);
    await f.reopen(); const before = f.calls.length;
    const result = await f.coordinator.cancelFromHost({ taskId: scope.taskId, scheduleId: prepared.id, key: spec.key });
    assert.equal(result.nativeCleanup, 'verified'); assert.equal(result.schedule.jobId, native.id); assert.equal(result.schedule.state, 'cancelled');
    assert.deepEqual(f.calls.slice(before).map(call => [call.method, call.path]), [['GET', `/cron/lookup/${prepared.id}`], ['POST', `/cron/jobs/${native.id}/cancel`]]);
    assert.equal(f.jobs.size, 1); assert.equal(native.state, 'cancelled'); assert.equal(f.agent.store.list('contexts').length, 0);
    assert.equal((await f.post('/schedules/admit', credential, admission(native.id))).status, 403);
    assert.deepEqual(f.agent.store.get('grants', grant.id), grant);
    const calls = f.calls.length; await f.reopen();
    assert.equal((await f.coordinator.cancelFromHost({ taskId: scope.taskId, scheduleId: prepared.id })).nativeCleanup, 'verified');
    assert.equal(f.calls.length, calls);
  } finally { await f.close(); }
});

test('host withdrawal accepts read-only exact absence without creating a missing native job', async () => {
  const f = await fixture();
  try {
    f.enableLookup(); f.loseCreate(); await assert.rejects(f.coordinator.create(scope, spec));
    const prepared = f.coordinator.list(scope)[0]!; f.jobs.clear(); const before = f.calls.length;
    const result = await f.coordinator.cancelFromHost({ taskId: scope.taskId, scheduleId: prepared.id });
    assert.equal(result.nativeCleanup, 'verified'); assert.equal(result.schedule.state, 'cancelled');
    assert.deepEqual(f.calls.slice(before).map(call => [call.method, call.path]), [['GET', `/cron/lookup/${prepared.id}`]]);
    assert.equal(f.jobs.size, 0);
  } finally { await f.close(); }
});

test('host withdrawal refuses a discovered native identity differing from independent readback before native cancel', async () => {
  const f = await fixture();
  try {
    f.enableLookup(); f.loseCreate(); await assert.rejects(f.coordinator.create(scope, spec));
    const prepared = f.coordinator.list(scope)[0]!, native = [...f.jobs.values()][0]!, before = f.calls.length;
    const result = await f.coordinator.cancelFromHost({ taskId: scope.taskId, scheduleId: prepared.id, expectedNativeJobId: 'another-native-job' });
    assert.equal(result.nativeCleanup, 'unknown'); assert.equal(result.reason, 'native_job_identity_unknown');
    assert.equal(result.schedule.jobId, undefined); assert.equal(native.state, 'active');
    assert.deepEqual(f.calls.slice(before).map(call => call.method), ['GET']);
    assert.equal(result.schedule.state, 'cancel-pending', 'Local tombstone must still deny admissions');
  } finally { await f.close(); }
});

test('uncertain native cancellation retains exact durable cancel intent and only reconciles that same native identity', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential();
    await f.post('/schedules/admit', credential, admission(schedule.jobId!));
    f.losePause(); const unknown = await f.coordinator.cancelFromHost({ taskId: scope.taskId, scheduleId: schedule.id });
    assert.equal(unknown.nativeCleanup, 'unknown'); assert.equal(unknown.reason, 'native_cancel_unconfirmed'); assert.equal(unknown.schedule.state, 'cancel-pending');
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!, 'execution-2'))).status, 403);
    await f.reopen(); const settled = await f.coordinator.cancelFromHost({ taskId: scope.taskId, scheduleId: schedule.id, nativeJobId: schedule.jobId }); assert.equal(settled.nativeCleanup, 'verified');
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/cancel')).map(call => call.path), Array(2).fill(`/cron/jobs/${schedule.jobId}/cancel`));
  } finally { await f.close(); }
});

test('new cron execution prepares current preferences after foreground completion without changing original authority', async () => {
  const f = await fixture();
  try {
    const authority = { task: f.agent.store.get('tasks', scope.taskId), grant: f.agent.store.get('grants', scope.grantId) };
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential();
    const first = await f.post('/schedules/admit', credential, admission(schedule.jobId!)); assert.equal(first.status, 200);
    assert.equal(f.preparations.length, 1);
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).body.tool_context, first.body.tool_context);
    assert.equal(f.preparations.length, 1, 'Duplicate admission must not refresh an old context');
    f.changePreferences();
    assert.throws(() => f.agent.resolveToolContext(first.body.tool_context), /stale/);
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 403);
    assert.equal(f.preparations.length, 1, 'Stale execution replay must not invoke preparation');
    const next = await f.post('/schedules/admit', credential, admission(schedule.jobId!, 'execution-2')); assert.equal(next.status, 200);
    const context = f.agent.resolveToolContext(next.body.tool_context);
    assert.deepEqual(context, { ...scope, runId: `cron:${schedule.jobId}:execution-2` });
    assert.equal(f.agent.store.get<any>('scheduleContextFixtures', context.runId).preferencesRevision, 2);
    assert.deepEqual(f.agent.store.get('tasks', scope.taskId), authority.task); assert.deepEqual(f.agent.store.get('grants', scope.grantId), authority.grant);
    assert.deepEqual(f.agent.store.get('runs', 'task-A:1'), f.foreground); assert.equal(f.submissions(), 0);
  } finally { await f.close(); }
});

test('fresh context preparation failure denies admission before token issuance and can retry only the unadmitted execution', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential(); f.failPreparation();
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 403);
    assert.equal(f.agent.store.list('contexts').length, 0); assert.equal(f.coordinator.list(scope)[0]!.executions.length, 0);
    f.failPreparation(false); assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 200);
    f.agent.revokeToolContext(f.agent.store.list<any>('hermesSchedules')[0].executions['execution-1'].token);
    assert.equal((await f.post('/schedules/admit', credential, admission(schedule.jobId!))).status, 403);
    assert.equal(f.preparations.length, 1);
  } finally { await f.close(); }
});

test('asynchronous preparation is rejected before an execution token can be issued', async () => {
  const f = await fixture();
  try {
    const schedule = await f.coordinator.create(scope, spec), credential = f.credential();
    const coordinator = new HermesScheduleCoordinator({
      native: f.nativeOptions,
      core: { store: f.agent.store, validateScope: context => { f.agent.validateAuthority(context); }, issueToolContext: context => f.agent.issueExecutionContext(context), resolveToolContext: token => f.agent.resolveToolContext(token), revokeToolContext: token => f.agent.revokeToolContext(token) },
      prepareExecution: async () => {},
    });
    assert.throws(() => coordinator.admit(credential, admission(schedule.jobId!)), /synchronous/);
    assert.equal(f.agent.store.list('contexts').length, 0);
  } finally { await f.close(); }
});
