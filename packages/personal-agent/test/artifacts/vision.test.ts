import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Json, ToolContext } from '../../src/contracts.ts';
import type { ToolBroker } from '../../src/capabilities/types.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import { ArtifactStore, type ArtifactPort } from '../../src/artifacts/index.ts';
import { createArtifactVisionTools, type ArtifactImageEnvelope, MAX_ARTIFACT_IMAGE_BYTES } from '../../src/artifacts/vision.ts';

// Complete encoded 1x1 PNG fixture, not a path marker or truncated byte preview.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ9sAAAAASUVORK5CYII=', 'base64');
const context: ToolContext = { taskId: 'task-A', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'neurobro-image-view-'));
  const store = new ArtifactStore({ rootPath: root, encryptionKey: Buffer.alloc(32, 6) });
  const scope = { ownerId: 'owner', taskId: context.taskId };
  let authorized = true;
  const broker: ToolBroker = {
    resolveToolContext(token) { if (!authorized || token !== 'issued-token') throw new Error('scope unavailable'); return context; },
    authorizeTool(token, capability, resource) { if (!authorized || token !== 'issued-token' || capability !== 'artifacts.read' || resource !== context.taskId) throw new Error('denied'); },
    async executeEffect() { throw new Error('Image viewing is read-only'); },
  };
  const registryFor = (port: ArtifactPort = store) => new ToolRegistry(broker, createArtifactVisionTools(port, ctx => ({ ownerId: scope.ownerId, taskId: ctx.taskId })));
  const registry = registryFor();
  return { store, scope, registry, registryFor, revokeGrant: () => { authorized = false; },
    invoke: (args: Record<string, Json>, token = 'issued-token') => registry.invoke(token, { name: 'artifacts.view_image', args }),
    close: () => { store.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test('authorized image tool returns genuine native content envelope with exact bytes/hash and selected revision', async () => {
  const f = fixture();
  try {
    const original = f.store.put({ ...f.scope, name: 'original.png', bytes: png });
    const revisedBytes = Buffer.concat([png, Buffer.from('revision fixture metadata')]);
    const revised = f.store.put({ ...f.scope, name: 'revision.png', bytes: revisedBytes, parentId: original.id });
    for (const [record, expected] of [[original, png], [revised, revisedBytes]] as const) {
      const result = await f.invoke({ artifactId: record.id }); assert.equal(result.ok, true);
      const envelope = result.value as unknown as ArtifactImageEnvelope;
      assert.equal(envelope._multimodal, true); assert.equal(envelope.content[1].type, 'image_url');
      const url = envelope.content[1].image_url.url; assert.ok(url.startsWith('data:image/png;base64,'));
      assert.deepEqual(Buffer.from(url.split(',')[1]!, 'base64'), expected);
      assert.ok(envelope.text_summary.includes(createHash('sha256').update(expected).digest('hex')));
      assert.ok(envelope.text_summary.includes(record.id)); assert.ok(!envelope.text_summary.includes('originals'));
    }
    assert.deepEqual(f.store.read(f.scope, original.id), png);
  } finally { f.close(); }
});
test('image viewing rejects invented credentials, arbitrary paths/data/URLs and another task artifact', async () => {
  const f = fixture();
  try {
    const record = f.store.put({ ...f.scope, name: 'image.png', bytes: png });
    const extras: Record<string, Json>[] = [{ path: 'C:/secret.png' }, { url: 'https://example.invalid/image.png' }, { data: png.toString('base64') }, { ownerId: 'someone' }, { taskId: 'other' }];
    for (const extra of extras) assert.equal((await f.invoke({ artifactId: record.id, ...extra })).ok, false);
    assert.equal((await f.invoke({ artifactId: record.id }, 'forged-token')).ok, false);
    const foreign = f.store.put({ ownerId: 'owner', taskId: 'other-task', name: 'image.png', bytes: png });
    assert.equal((await f.invoke({ artifactId: foreign.id })).ok, false);
    f.revokeGrant(); assert.equal((await f.invoke({ artifactId: record.id })).ok, false);
  } finally { f.close(); }
});
test('non-images and oversized images are explicit errors, never text pretending to be pixels', async () => {
  const f = fixture();
  try {
    const doc = f.store.put({ ...f.scope, name: 'data.txt', bytes: Buffer.from('text') });
    assert.equal((await f.invoke({ artifactId: doc.id })).ok, false);
    const large = Buffer.alloc(MAX_ARTIFACT_IMAGE_BYTES + 1); png.copy(large);
    const image = f.store.put({ ...f.scope, name: 'large.png', bytes: large });
    const result = await f.invoke({ artifactId: image.id }); assert.equal(result.ok, false); assert.match(result.error!, /byte limit/);
  } finally { f.close(); }
});
test('store readback/hash/revocation and broker post-read authority fence prevent pixel disclosure', async () => {
  const f = fixture();
  try {
    const image = f.store.put({ ...f.scope, name: 'image.png', bytes: png });
    const bad = new Proxy(f.store, { get(target, property) { if (property === 'read') return () => Buffer.concat([png, Buffer.from('corruption')]); const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    assert.equal((await f.registryFor(bad).invoke('issued-token', { name: 'artifacts.view_image', args: { artifactId: image.id } })).ok, false);
    const race = new Proxy(f.store, { get(target, property) { if (property === 'read') return (...args: Parameters<ArtifactPort['read']>) => { const bytes = target.read(...args); f.revokeGrant(); return bytes; }; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    assert.equal((await f.registryFor(race).invoke('issued-token', { name: 'artifacts.view_image', args: { artifactId: image.id } })).ok, false);
  } finally { f.close(); }
});
test('revoked artifact and misbound trusted resolver do not yield native image blocks', async () => {
  const f = fixture();
  try {
    const image = f.store.put({ ...f.scope, name: 'image.png', bytes: png, sourceRef: 'source-message' });
    const tool = createArtifactVisionTools(f.store, () => ({ ownerId: 'owner', taskId: 'other' }))[0]!;
    await assert.rejects(async () => tool.execute({ token: 'issued-token', context, args: { artifactId: image.id } }), /misbound/);
    f.store.revoke({ ...f.scope, sourceRef: 'source-message' });
    assert.equal((await f.invoke({ artifactId: image.id })).ok, false);
  } finally { f.close(); }
});
