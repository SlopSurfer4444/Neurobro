import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Json, ToolContext } from '../../src/contracts.ts';
import type { ToolBroker } from '../../src/capabilities/types.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { artifactTools } from '../../src/artifacts/tools.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'neurobro-artifact-tools-test-'));
  const store = new ArtifactStore({ rootPath: root, encryptionKey: Buffer.alloc(32, 4) });
  const scope = { ownerId: 'owner', taskId: 'task' };
  let context: ToolContext = { taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' };
  const capabilities = new Set(['artifacts.read', 'artifacts.stage', 'artifacts.write']);
  const broker: ToolBroker = {
    resolveToolContext(token) { if (token !== 'issued-token') throw new Error('unissued token'); return context; },
    authorizeTool(token, capability, resource) { if (token !== 'issued-token' || !capabilities.has(capability) || resource !== context.taskId) throw new Error('denied capability'); },
    async executeEffect() { throw new Error('local artifact operations do not dispatch external effects'); },
  };
  const registry = new ToolRegistry(broker, artifactTools({ store, resolveScope: ctx => ({ ownerId: 'owner', taskId: ctx.taskId }) }));
  return { root, store, scope, registry, capabilities, setContext: (value: ToolContext) => { context = value; },
    invoke: (name: string, args: Record<string, Json> = {}, token = 'issued-token') => registry.invoke(token, { name, args }),
    cleanup: () => { store.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test('registered tools stage/read real text and media then import output with durable lineage', async () => {
  const f = fixture();
  try {
    const text = f.store.put({ ...f.scope, name: 'оригинал.txt', bytes: Buffer.from('привет владелец'), sourceRef: 'message-source' });
    const mediaBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const media = f.store.put({ ...f.scope, name: 'оригинал.png', bytes: mediaBytes });
    const listing = await f.invoke('artifacts.list', { offset: 0, limit: 1 }); assert.equal(listing.ok, true);
    const list = listing.value as { artifacts: { id: string }[]; more: boolean };
    assert.equal(list.artifacts[0]!.id, text.id); assert.equal(list.more, true);
    const staging = await f.invoke('artifacts.stage', { artifactIds: [text.id, media.id] }); assert.equal(staging.ok, true);
    const stage = staging.value as { id: string; outputsPath: string };
    const reading = await f.invoke('artifacts.read', { stageId: stage.id, artifactId: text.id, offset: 0, limit: 6 }); assert.equal(reading.ok, true);
    const read = reading.value as { text: string; span: { more: boolean; total: number }; artifact: { sha256: string } };
    assert.equal(read.text, 'привет'); assert.equal(read.span.more, true); assert.equal(read.span.total, 'привет владелец'.length); assert.equal(read.artifact.sha256, text.sha256);
    const mediaRead = await f.invoke('artifacts.read', { stageId: stage.id, artifactId: media.id }); assert.equal(mediaRead.ok, true);
    const binary = mediaRead.value as { preview: { data: string }; media: { mimeType: string; path: string } };
    assert.deepEqual(Buffer.from(binary.preview.data, 'base64'), mediaBytes); assert.equal(binary.media.mimeType, 'image/png');
    writeFileSync(join(stage.outputsPath, 'variant.png'), mediaBytes);
    const imported = await f.invoke('artifacts.import_output', { stageId: stage.id, fileName: 'variant.png', parentId: media.id }); assert.equal(imported.ok, true);
    const output = imported.value as { id: string; parentId: string };
    assert.equal(output.parentId, media.id);
    assert.deepEqual(f.store.dependencies(f.scope, output.id).map(row => row.id), [text.id, media.id]);
    assert.deepEqual(f.store.read(f.scope, output.id), mediaBytes);
  } finally { f.cleanup(); }
});

test('tool scopes and schemas reject forged owners/tasks/tokens/raw paths and grants before store writes', async () => {
  const f = fixture();
  try {
    const original = f.store.put({ ...f.scope, name: 'input.txt', bytes: Buffer.from('input') });
    const stage = f.store.stageTask(f.scope, [original.id]);
    for (const [name, args] of [
      ['artifacts.list', { ownerId: 'another' }], ['artifacts.list', { taskId: 'another' }],
      ['artifacts.stage', { artifactIds: [original.id], path: 'C:\\outside' }],
      ['artifacts.read', { stageId: stage.id, artifactId: original.id, path: 'C:\\outside' }],
      ['artifacts.import_output', { stageId: stage.id, fileName: '../outside' }],
      ['artifacts.import_output', { stageId: stage.id, fileName: 'a.txt', sourceRef: 'forged-source' }],
    ] as [string, Record<string, Json>][]) assert.equal((await f.invoke(name, args)).ok, false, name);
    assert.equal((await f.invoke('artifacts.list', {}, 'model-invented-token')).ok, false);
    f.setContext({ taskId: 'another-task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' });
    assert.equal((await f.invoke('artifacts.stage', { artifactIds: [original.id] })).ok, false);
    assert.equal((await f.invoke('artifacts.read', { stageId: stage.id, artifactId: original.id })).ok, false);
    f.setContext({ taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' });
    writeFileSync(join(stage.outputsPath, 'result.txt'), 'result');
    f.capabilities.delete('artifacts.write');
    assert.equal((await f.invoke('artifacts.import_output', { stageId: stage.id, fileName: 'result.txt' })).ok, false);
    assert.equal(f.store.list(f.scope).length, 1);
  } finally { f.cleanup(); }
});

test('staged reads reject output/noninput IDs, revoked source and misbound trusted host scope', async () => {
  const f = fixture();
  try {
    const original = f.store.put({ ...f.scope, name: 'original.txt', bytes: Buffer.from('original'), sourceRef: 'source' });
    const stage = f.store.stageTask(f.scope, [original.id]);
    const unrelated = f.store.put({ ...f.scope, name: 'unrelated.txt', bytes: Buffer.from('unrelated') });
    assert.equal((await f.invoke('artifacts.read', { stageId: stage.id, artifactId: unrelated.id })).ok, false);
    assert.equal((await f.invoke('artifacts.read', { stageId: stage.id, artifactId: original.id, offset: 100 })).ok, false);
    f.store.erase({ ownerId: f.scope.ownerId, sourceRef: 'source' });
    assert.equal((await f.invoke('artifacts.read', { stageId: stage.id, artifactId: original.id })).ok, false);
    const registry = new ToolRegistry({
      resolveToolContext: () => ({ taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' }),
      authorizeTool: () => {}, executeEffect: async () => { throw new Error('unused'); },
    }, artifactTools({ store: f.store, resolveScope: () => ({ ownerId: 'owner', taskId: 'forged-host-task' }) }));
    const response = await registry.invoke('issued-token', { name: 'artifacts.list', args: {} });
    assert.equal(response.ok, false); assert.match(response.error!, /misbound/);
  } finally { f.cleanup(); }
});
