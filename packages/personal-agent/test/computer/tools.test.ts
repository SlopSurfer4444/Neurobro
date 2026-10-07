import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerTransport, CodexComputerAdapter, JsonFileComputerRegistry, createComputerTools } from '../../src/computer/index.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import type { ToolBroker } from '../../src/capabilities/types.ts';
import type { ComputerProject } from '../../src/computer/types.ts';
import type { Json, ToolContext, ToolResult } from '../../src/contracts.ts';

async function fixture(mode = '') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'neurobro-computer-tools-')));
  const root = join(base, 'project'); await mkdir(root); const outside = join(base, 'outside.txt'); await writeFile(outside, 'private fixture');
  const log = join(base, 'requests.jsonl'), database = join(base, 'server.json'), registryPath = join(base, 'registry.json');
  const contexts: Record<string, ToolContext> = {
    one: { taskId: 'broker-one', intentRevision: 1, grantId: 'g1', grantRevision: 1, runId: 'r1' },
    two: { taskId: 'broker-two', intentRevision: 1, grantId: 'g2', grantRevision: 1, runId: 'r2' },
  };
  let revoked = false; let readOnly = false; const authorization: Array<{ token: string; capability: string; resource: string }> = [];
  const broker: ToolBroker = {
    resolveToolContext(token) { if (!contexts[token] || revoked) throw new Error('expired or revoked broker token'); return contexts[token]; },
    authorizeTool(token, capability, resource) {
      const context = broker.resolveToolContext(token); authorization.push({ token, capability, resource });
      if (readOnly && !['computer.projects', 'computer.read', 'computer.artifact.read'].includes(capability)) throw new Error('computer mutation grant denied');
      if (resource !== 'allowed' && resource !== context.taskId) throw new Error('computer grant denied');
    },
    async executeEffect() { throw new Error('computer adapter owns its durable dispatch journal'); },
  };
  const project: ComputerProject = { id: 'allowed', root, permissions: { sandbox: 'workspace-write', networkAccess: false, approvalPolicy: 'never', verification: {
    id: 'fixture', executorId: 'fixture-executor', projectRoot: root, verifiedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-10T00:00:00Z', sandbox: 'workspace-write', networkAccess: false, boundaryReceipt: 'fixture only',
  } } };
  const make = (newMode = mode) => {
    const adapter = new CodexComputerAdapter({ projects: [project], executorId: 'fixture-executor', registry: new JsonFileComputerRegistry(registryPath), now: () => new Date('2026-10-04T00:00:00Z'),
      transport: new AppServerTransport({ command: process.execPath, args: [fileURLToPath(new URL('./adapter-server.mjs', import.meta.url))], cwd: base,
        env: { FIXTURE_MODE: newMode, FIXTURE_ROOT: root, FIXTURE_OUTSIDE: outside, FIXTURE_LOG: log, FIXTURE_DATABASE: database }, requestTimeoutMs: 5000, stopTimeoutMs: 1000 }) });
    const registry = new ToolRegistry(broker, createComputerTools({ adapter }));
    const invoke = (name: string, args: Record<string, Json> = {}, token = 'one') => registry.invoke(token, { name, args });
    return { adapter, registry, invoke };
  };
  const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { ...make(), make, requests, authorization, context: (binding: Partial<ToolContext>) => { contexts.one = { ...contexts.one!, ...binding }; }, revoke: () => { revoked = true; }, readOnly: () => { readOnly = true; } };
}
function value(result: ToolResult): Record<string, Json> {
  assert.equal(result.ok, true, result.error); return result.value as Record<string, Json>;
}

test('registered computer tools execute real child lifecycle under broker resources', async () => {
  const f = await fixture(); try {
    assert.equal(value(await f.invoke('computer.projects', { projectId: 'allowed' })).desktopAttachment, false);
    const created = value(await f.invoke('computer.create', { projectId: 'allowed' })); assert.equal(created.taskId, 'broker-one');
    const duplicate = value(await f.invoke('computer.create', { projectId: 'allowed' })); assert.equal(duplicate.threadId, created.threadId);
    assert.equal((await f.requests()).filter(r => r.method === 'thread/start').length, 1);
    const started = value(await f.invoke('computer.start', { instruction: 'fixture work' }));
    value(await f.invoke('computer.steer', { instruction: 'focus tests', expectedTurnId: started.turnId! }));
    const stopped = value(await f.invoke('computer.interrupt')); assert.equal(stopped.state, 'interrupted'); assert.match(stopped.reason as string, /settlement is unverified/);
    const listed = await f.invoke('computer.artifacts'); assert.equal(listed.ok, true); const handles = listed.value as Array<Record<string, Json>>; assert.equal(handles.length, 1); assert.equal(Object.hasOwn(handles[0]!, 'path'), false);
    const handle = handles[0]!;
    const artifact = value(await f.invoke('computer.artifact_read', { itemId: handle.itemId!, turnId: handle.turnId!, index: handle.index! })); assert.equal(Buffer.from(artifact.content as string, 'base64').toString(), 'bounded fixture artifact');
    assert.ok(f.authorization.some(a => a.capability === 'computer.create' && a.resource === 'allowed'));
    assert.ok(f.authorization.some(a => a.capability === 'computer.steer' && a.resource === 'broker-one'));
  } finally { await f.adapter.close(); }
});
test('model cannot select another broker task, thread, host, grant, root or artifact path', async () => {
  const f = await fixture(); try {
    const hostile: Array<Record<string, Json>> = [{ taskId: 'broker-two' }, { threadId: 'foreign' }, { hostId: 'host' }, { grantId: 'admin' }, { path: 'outside' }];
    for (const args of hostile) {
      const result = await f.invoke('computer.read', args); assert.equal(result.ok, false);
    }
    assert.equal((await f.invoke('computer.create', { projectId: 'not-granted' })).ok, false);
    assert.equal((await f.invoke('computer.create', { projectId: 'allowed', cwd: '/' })).ok, false);
    value(await f.invoke('computer.create', { projectId: 'allowed' })); value(await f.invoke('computer.create', { projectId: 'allowed' }, 'two'));
    const page = value(await f.invoke('computer.tasks', { projectId: 'allowed' })); const tasks = page.tasks as Array<Record<string, Json>>;
    assert.deepEqual(tasks.map(t => t.taskId), ['broker-one']);
    assert.equal((await f.invoke('computer.artifact_read', { itemId: 'alien', turnId: 'alien', index: 0 })).ok, false);
    assert.equal(value(await f.invoke('computer.read')).threadId, 'thread-1');
    assert.equal(value(await f.invoke('computer.read', {}, 'two')).threadId, 'thread-2');
  } finally { await f.adapter.close(); }
});
test('revoked broker context stops dispatch; read grants do not authorize mutation', async () => {
  const f = await fixture(); try {
    value(await f.invoke('computer.create', { projectId: 'allowed' })); const before = (await f.requests()).length;
    f.readOnly(); assert.equal((await f.invoke('computer.start', { instruction: 'not granted by read scope' })).ok, false); assert.equal((await f.requests()).length, before);
    f.revoke(); assert.equal((await f.invoke('computer.start', { instruction: 'blocked' })).ok, false); assert.equal((await f.invoke('computer.read')).ok, false);
    assert.equal((await f.requests()).length, before);
    for (const definition of f.registry.list()) {
      assert.equal(definition.inputSchema.type, 'object');
      if (definition.inputSchema.type === 'object') for (const forbidden of ['taskId', 'threadId', 'hostId', 'token', 'context', 'grantId', 'path', 'cwd']) assert.equal(Object.hasOwn(definition.inputSchema.properties, forbidden), false);
    }
  } finally { await f.adapter.close(); }
});
test('lost dispatch becomes explicit UNKNOWN and tool reconciliation never duplicates model turn', async () => {
  const f = await fixture('lost-start');
  const created = value(await f.invoke('computer.create', { projectId: 'allowed' })); assert.equal(created.threadId, 'thread-1');
  const outcome = value(await f.invoke('computer.start', { instruction: 'once' })); assert.equal(outcome.state, 'unknown'); assert.equal(outcome.reconciliationRequired, true); assert.equal(typeof outcome.operationId, 'string'); await f.adapter.close();
  const recovered = f.make(''); try {
    assert.equal(value(await recovered.invoke('computer.read')).state, 'unknown');
    assert.equal((await recovered.invoke('computer.start', { instruction: 'do not retry' })).ok, false);
    assert.equal(value(await recovered.invoke('computer.reconcile')).state, 'running');
    assert.equal((await f.requests()).filter(r => r.method === 'turn/start').length, 1);
  } finally { await recovered.adapter.close(); }
});
test('initialization response loss cannot fabricate a retained task dispatch', async () => {
  const f = await fixture('exit-init'); try {
    const result = await f.invoke('computer.create', { projectId: 'allowed' });
    assert.equal(result.ok, false); assert.equal(result.value, undefined);
    assert.equal((await f.requests()).some(r => r.method === 'thread/start'), false);
  } finally { await f.adapter.close(); }
});

test('revised authority cannot read or reuse old child output, artifacts or pending dispatch', async () => {
  const f = await fixture(); try {
    value(await f.invoke('computer.create', { projectId: 'allowed' }));
    value(await f.invoke('computer.start', { instruction: 'old objective' }));
    value(await f.invoke('computer.interrupt'));
    f.context({ intentRevision: 2, grantId: 'g-next', grantRevision: 1, runId: 'r-next' });
    for (const name of ['computer.read', 'computer.reconcile', 'computer.artifacts', 'computer.interrupt']) assert.equal((await f.invoke(name)).ok, false, name);
    assert.deepEqual(value(await f.invoke('computer.tasks', { projectId: 'allowed' })).tasks, []);
    assert.equal((await f.invoke('computer.create', { projectId: 'allowed' })).ok, false);
    assert.equal((await f.requests()).filter(r => r.method === 'thread/start').length, 1);
  } finally { await f.adapter.close(); }
});
