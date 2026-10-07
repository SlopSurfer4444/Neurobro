import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexComputerAdapter, AppServerTransport, JsonFileComputerRegistry } from '../../src/computer/index.ts';
import type { ComputerProject, ExecutionSettlement } from '../../src/computer/types.ts';

async function fixture(mode = '', verification = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'neurobro-computer-')));
  const root = join(base, 'project'); await mkdir(root); const outside = join(base, 'outside.txt'); await writeFile(outside, 'secret fixture');
  const log = join(base, 'requests.jsonl'); const database = join(base, 'server.json'); const registryPath = join(base, 'registry.json');
  const project: ComputerProject = { id: 'allowed', root, permissions: { sandbox: 'workspace-write', networkAccess: false, approvalPolicy: 'never', ...(verification ? { verification: {
    id: 'fixture-boundary', executorId: 'fixture-executor', projectRoot: root, verifiedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-10T00:00:00Z', sandbox: 'workspace-write' as const, networkAccess: false, boundaryReceipt: 'test fixture only, not host acceptance',
  } } : {}) } };
  const make = (newMode = mode, settlement?: () => Promise<ExecutionSettlement>) => {
    const transport = new AppServerTransport({ command: process.execPath, args: [fileURLToPath(new URL('./adapter-server.mjs', import.meta.url))], cwd: base,
      env: { FIXTURE_MODE: newMode, FIXTURE_ROOT: root, FIXTURE_OUTSIDE: outside, FIXTURE_LOG: log, FIXTURE_DATABASE: database }, requestTimeoutMs: 5000, stopTimeoutMs: 1000 });
    const registry = new JsonFileComputerRegistry(registryPath);
    const adapter = new CodexComputerAdapter({ projects: [project], executorId: 'fixture-executor', registry, transport, now: () => new Date('2026-10-04T00:00:00Z'), interruptTimeoutMs: 80, settlement });
    return { adapter, registry, transport };
  };
  return { ...make(), make, root, outside, log, base, project, registryPath };
}
async function requests(log: string) { return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }

test('real child protocol creates, reads, lists, steers and interrupts only owned tasks', async () => {
  const f = await fixture(); try {
    const task = await f.adapter.createTask({ taskId: 'logical-one', projectId: 'allowed' }); assert.equal(task.threadId, 'thread-1');
    const started = await f.adapter.startTurn(task.taskId, 'Build fixture'); assert.equal(started.state, 'running');
    await assert.rejects(f.adapter.steer(task.taskId, 'wrong target', 'another-turn'), /STALE_TURN/);
    await f.adapter.steer(task.taskId, 'Focus fixture', started.turnId!);
    const page = await f.adapter.listTasks('allowed'); assert.equal(page.tasks.length, 1); assert.equal(page.nextCursor, 'next');
    const interrupted = await f.adapter.interrupt(task.taskId); assert.equal(interrupted.state, 'interrupted'); assert.match(interrupted.reason!, /settlement is unverified/); assert.notEqual(interrupted.executionSettled, true);
    const artifacts = await f.adapter.artifacts(task.taskId); assert.equal(artifacts.length, 1); assert.equal((await f.adapter.readArtifact(task.taskId, artifacts[0]!.path)).toString(), 'bounded fixture artifact');
    await assert.rejects(f.adapter.readArtifact(task.taskId, f.outside), /ARTIFACT_NOT_BOUND/);
    const rpc = await requests(f.log); assert.equal(rpc.find(r => r.method === 'thread/list').params.useStateDbOnly, true); assert.deepEqual(rpc.find(r => r.method === 'thread/list').params.sourceKinds, ['appServer']);
    assert.equal(rpc.some(r => r.method === 'thread/resume'), false); assert.equal(rpc.find(r => r.method === 'turn/steer').params.expectedTurnId, started.turnId);
  } finally { assert.equal((await f.adapter.close()).processExited, true); }
});
test('unknown root, outside cwd, forged ids and unverified policy fail before mutation', async () => {
  const f = await fixture('', false); try {
    assert.equal((await f.adapter.doctor()).projects[0]!.executable, false);
    await assert.rejects(f.adapter.createTask({ taskId: 'one', projectId: 'unknown' }), /PROJECT_NOT_REGISTERED/);
    await assert.rejects(f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }), /EXECUTOR_UNVERIFIED/);
    assert.equal((await requests(f.log)).some(r => r.method === 'thread/start'), false);
    await assert.rejects(f.adapter.readTask('foreign'), /TASK_NOT_OWNED/);
  } finally { await f.adapter.close(); }
  const g = await fixture(); try { await assert.rejects(g.adapter.createTask({ taskId: 'escape', projectId: 'allowed', cwd: g.base }), /OUTSIDE_ROOT/); }
  finally { await g.adapter.close(); }
});
test('effective policy mismatch is retained unknown and cannot rerun', async () => {
  const f = await fixture('bad-policy'); try {
    await assert.rejects(f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }), /POLICY_MISMATCH/);
    assert.equal((await f.registry.get('one'))!.pending!.state, 'unknown');
    await assert.rejects(f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }), /ALREADY_REGISTERED/);
    assert.equal((await requests(f.log)).filter(r => r.method === 'thread/start').length, 1);
  } finally { await f.adapter.close(); }
});
test('lost turn response survives restart and reconciles by persisted client operation id without replay', async () => {
  const f = await fixture('lost-start');
  await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' });
  await assert.rejects(f.adapter.startTurn('one', 'once'));
  const uncertain = await f.registry.get('one'); assert.equal(uncertain!.state, 'unknown'); assert.equal(uncertain!.pending!.state, 'unknown');
  await f.adapter.close();
  const recovered = f.make(''); try {
    await assert.rejects(recovered.adapter.startTurn('one', 'do not replay'), /BUSY_OR_UNKNOWN/);
    const task = await recovered.adapter.reconcileTask('one'); assert.equal(task.state, 'running'); assert.equal(task.turnId, 'turn-1'); assert.equal(task.pending, undefined);
    assert.equal((await requests(f.log)).filter(r => r.method === 'turn/start').length, 1);
  } finally { await recovered.adapter.close(); }
});
test('native task id mismatch and non-terminal interrupt cannot claim success', async () => {
  const f = await fixture('bad-binding'); try {
    await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }); await assert.rejects(f.adapter.readTask('one'), /THREAD_BINDING_MISMATCH/);
  } finally { await f.adapter.close(); }
  const g = await fixture('never-terminal'); try {
    await g.adapter.createTask({ taskId: 'one', projectId: 'allowed' }); await g.adapter.startTurn('one', 'active');
    const task = await g.adapter.interrupt('one'); assert.equal(task.state, 'unknown'); assert.match(task.reason!, /deadline/);
  } finally { await g.adapter.close(); }
});
test('server rejection preserves original task and registry corruption fails closed', async () => {
  const f = await fixture('reject-start'); try {
    await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }); await assert.rejects(f.adapter.startTurn('one', 'refused'));
    assert.equal((await f.registry.get('one'))!.pending, undefined);
    const valid = await readFile(f.registryPath); await writeFile(f.registryPath, '{broken'); await assert.rejects(f.registry.list()); await writeFile(f.registryPath, valid);
  } finally { await f.adapter.close(); }
});
test('verified settlement permits next turn; unverified settlement does not', async () => {
  const f = await fixture(); try {
    await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }); await f.adapter.startTurn('one', 'first'); await f.adapter.interrupt('one');
    await assert.rejects(f.adapter.startTurn('one', 'second'), /PREVIOUS_TURN_UNSETTLED/);
  } finally { await f.adapter.close(); }
  const g = await fixture(); await g.adapter.close();
  const verified = g.make('', async () => ({ executionSettled: true, effectsReconciled: true, receipt: 'fixture verifier only' })); try {
    await verified.adapter.createTask({ taskId: 'one', projectId: 'allowed' }); await verified.adapter.startTurn('one', 'first');
    const stopped = await verified.adapter.interrupt('one'); assert.equal(stopped.executionSettled, true); assert.equal(stopped.reason, undefined);
    assert.equal((await verified.adapter.startTurn('one', 'second')).turnId, 'turn-2');
  } finally { await verified.adapter.close(); }
});
test('registry ownership and symlink escapes are checked before reads or creation', async () => {
  const f = await fixture(); try {
    await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }); const task = (await f.registry.get('one'))!;
    await f.registry.put({ ...task, executorId: 'another-executor' }); await assert.rejects(f.adapter.readTask('one'), /TASK_NOT_OWNED/);
    await f.registry.put({ ...task, projectRoot: f.base }); await assert.rejects(f.adapter.readTask('one'), /TASK_BINDING_MISMATCH/);
    const link = join(f.root, 'escape'); await symlink(f.base, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.adapter.createTask({ taskId: 'two', projectId: 'allowed', cwd: link }), /REPARSE_ESCAPE/);
  } finally { await f.adapter.close(); }
});
test('persisted in-progress turn does not prove attachment to another active executor', async () => {
  const f = await fixture('not-loaded'); try {
    await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }); await f.adapter.startTurn('one', 'first');
    const task = await f.adapter.readTask('one'); assert.equal(task.state, 'unknown'); assert.equal(task.nativeStatus, 'notLoaded');
    await assert.rejects(f.adapter.steer('one', 'do not attach', task.turnId!), /STALE_TURN/);
    await assert.rejects(f.adapter.startTurn('one', 'do not duplicate'), /BUSY_OR_UNKNOWN/);
  } finally { await f.adapter.close(); }
});

test('parent stop fences an in-flight start and awaits its exact owned turn without replay', async () => {
  const f = await fixture('slow-start'); try {
    await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' });
    const start = f.adapter.startTurn('one', 'once');
    while (!(await requests(f.log)).some(r => r.method === 'turn/start')) await new Promise(resolve => setTimeout(resolve, 5));
    const stop = f.adapter.stopTask('one', 'Owner cancelled');
    await start; const result = await stop;
    assert.equal(result.task?.state, 'interrupted'); assert.equal(result.settled, false);
    await assert.rejects(f.adapter.startTurn('one', 'after cancellation'), /PARENT_STOPPED/);
    await f.adapter.stopTask('one');
    const rpc = await requests(f.log);
    assert.equal(rpc.filter(r => r.method === 'turn/start').length, 1);
    assert.equal(rpc.filter(r => r.method === 'turn/interrupt').length, 1);
    const restarted = f.make(); await f.adapter.close();
    try { await assert.rejects(restarted.adapter.startTurn('one', 'restart bypass'), /PARENT_STOPPED/); }
    finally { await restarted.adapter.close(); }
  } finally { await f.adapter.close(); }
});

test('parent stop does not start transport for absent child, or retry acknowledged nonterminal interruption', async () => {
  const f = await fixture('never-terminal'); try {
    assert.equal((await f.adapter.stopTask('absent', 'Cancel', 1)).settled, true);
    assert.equal(f.transport.state().state, 'new');
    await assert.rejects(f.adapter.createTask({ taskId: 'absent', projectId: 'allowed', binding: { intentRevision: 1, grantId: 'g1', grantRevision: 1 } }), /PARENT_STOPPED/);
    await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' }); await f.adapter.startTurn('one', 'active');
    assert.equal((await f.adapter.stopTask('one')).settled, false);
    assert.equal((await f.adapter.stopTask('one')).settled, false);
    assert.equal((await requests(f.log)).filter(r => r.method === 'turn/interrupt').length, 1);
  } finally { await f.adapter.close(); }
});

test('new parent authority generation requires settled prior child and retains its evidence', async () => {
  const f = await fixture(); await f.adapter.close();
  const g = f.make('', async () => ({ executionSettled: true, effectsReconciled: true, receipt: 'fixture only' }));
  const first = { intentRevision: 1, grantId: 'grant-one', grantRevision: 1 };
  const next = { intentRevision: 2, grantId: 'grant-two', grantRevision: 1 };
  try {
    await g.adapter.createTask({ taskId: 'one', projectId: 'allowed', binding: first });
    await g.adapter.startTurn('one', 'first', first);
    await assert.rejects(g.adapter.createTask({ taskId: 'one', projectId: 'allowed', binding: next }), /PREVIOUS_GENERATION_UNSETTLED/);
    assert.equal((await g.adapter.stopTask('one', 'Correction', 1)).settled, true);
    const replacement = await g.adapter.createTask({ taskId: 'one', projectId: 'allowed', binding: next });
    assert.equal(replacement.threadId, 'thread-2'); assert.equal(replacement.output, undefined);
    assert.equal(replacement.priorExecutions?.[0]?.output, 'Stopped fixture.');
    await assert.rejects(g.adapter.readTask('one', first), /PARENT_BINDING_MISMATCH/);
    await g.adapter.stopTask('one', 'Late old stop', 1);
    assert.equal((await g.adapter.startTurn('one', 'new authorized objective', next)).state, 'running');
    await g.adapter.stopTask('one', 'Finish', 2);
  } finally { await g.adapter.close(); }
});

test('completed output excludes commentary and a new turn cannot reuse the previous answer', async () => {
  const f = await fixture('terminal-start'); await f.adapter.close();
  const g = f.make('terminal-start', async () => ({ executionSettled: true, effectsReconciled: true, receipt: 'fixture only' }));
  try {
    await g.adapter.createTask({ taskId: 'one', projectId: 'allowed' });
    await g.adapter.startTurn('one', 'first');
    assert.equal((await g.adapter.readTask('one')).output, 'Final fixture.');
    const started = await g.adapter.startTurn('one', 'second');
    assert.equal(started.output, undefined); assert.equal(started.executionSettled, undefined);
  } finally { await g.adapter.close(); }
});

test('executor closure waits for an in-flight durable UNKNOWN write and rejects further work', async () => {
  const f = await fixture('slow-start'); try {
    await f.adapter.createTask({ taskId: 'one', projectId: 'allowed' });
    const outcome = f.adapter.startTurn('one', 'once').catch(error => error);
    while (!(await requests(f.log)).some(r => r.method === 'turn/start')) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await f.adapter.close()).processExited, true);
    assert.ok((await outcome) instanceof Error);
    const saved = await f.registry.get('one'); assert.equal(saved?.state, 'unknown'); assert.equal(saved?.pending?.state, 'unknown');
    await assert.rejects(f.adapter.startTurn('one', 'after close'), /EXECUTOR_CLOSED/);
  } finally { await f.adapter.close(); }
});
