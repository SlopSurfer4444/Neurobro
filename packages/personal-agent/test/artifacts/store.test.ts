import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ArtifactStore, sniffMime } from '../../src/artifacts/index.ts';
import { fileName } from '../../src/artifacts/paths.ts';
import type { ArtifactScope, ArtifactStoreOptions } from '../../src/artifacts/index.ts';

const key = Buffer.alloc(32, 73);
const scope: ArtifactScope = { ownerId: 'owner-1', taskId: 'task-1' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
function fixture(options: Partial<ArtifactStoreOptions> = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'neurobro-artifacts-test-'));
  const rootPath = join(temporary, 'private');
  const store = new ArtifactStore({ rootPath, encryptionKey: key, ...options });
  return { temporary, rootPath, store, cleanup: () => { store.dispose(); rmSync(temporary, { recursive: true, force: true }); } };
}
function original(f: ReturnType<typeof fixture>, text = 'секретный-marker-original', sourceRef = 'source-1') {
  return f.store.put({ ...scope, name: 'исходник.txt', bytes: Buffer.from(text), sourceRef });
}

test('originals are encrypted, immutable and survive a separate-process restart with exact lineage', () => {
  const f = fixture();
  try {
    const first = original(f);
    const second = f.store.put({ ...scope, name: 'вариант-2.txt', bytes: Buffer.from('revision two'), parentId: first.id });
    const third = f.store.put({ ...scope, name: 'вариант-3.png', bytes: png, parentId: second.id });
    assert.equal(third.mimeType, 'image/png');
    assert.deepEqual(f.store.lineage(scope, third.id).map(row => row.id), [first.id, second.id, third.id]);
    assert.equal(second.sourceRef, 'source-1');
    assert.equal(first.sha256, createHash('sha256').update('секретный-marker-original').digest('hex'));
    const path = join(f.rootPath, 'originals', `${first.id}.aes`);
    const ciphertext = readFileSync(path);
    assert.equal(ciphertext.includes(Buffer.from('секретный-marker-original')), false);
    f.store.dispose();
    const script = `import {ArtifactStore} from ${JSON.stringify(new URL('../../src/artifacts/index.ts', import.meta.url).href)};
      const s=new ArtifactStore({rootPath:${JSON.stringify(f.rootPath)},encryptionKey:Buffer.alloc(32,73)});
      console.log(JSON.stringify({original:s.read(${JSON.stringify(scope)},${JSON.stringify(first.id)}).toString(),
        lineage:s.lineage(${JSON.stringify(scope)},${JSON.stringify(third.id)}).map(r=>r.id)})); s.dispose();`;
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { original: 'секретный-marker-original', lineage: [first.id, second.id, third.id] });
    assert.deepEqual(readFileSync(path), ciphertext);
  } finally { f.cleanup(); }
});

test('access, parent references and staging cannot cross owner or task', () => {
  const f = fixture();
  try {
    const first = original(f);
    for (const wrong of [{ ...scope, ownerId: 'owner-2' }, { ...scope, taskId: 'task-2' }]) {
      assert.throws(() => f.store.get(wrong, first.id), /scope/);
      assert.throws(() => f.store.read(wrong, first.id), /scope/);
      assert.throws(() => f.store.lineage(wrong, first.id), /scope/);
      assert.throws(() => f.store.stageTask(wrong, [first.id]), /scope/);
      assert.throws(() => f.store.put({ ...wrong, parentId: first.id, name: 'other.txt', bytes: Buffer.from('other') }), /scope/);
      assert.deepEqual(f.store.list(wrong), []);
    }
  } finally { f.cleanup(); }
});

test('staging separates originals and mutable outputs; media output and dependencies remain accessible', () => {
  const f = fixture();
  try {
    const first = original(f);
    const stage = f.store.stageTask(scope, [first.id]);
    assert.equal(readFileSync(stage.inputs[0]!.path).toString(), 'секретный-marker-original');
    writeFileSync(join(stage.outputsPath, 'новая.png'), png);
    const result = f.store.putOutput(scope, stage.id, 'новая.png');
    assert.equal(result.parentId, first.id);
    assert.equal(result.sourceRef, 'source-1');
    assert.deepEqual(f.store.dependencies(scope, result.id).map(row => row.id), [first.id]);
    assert.deepEqual(f.store.read(scope, result.id), png);
    assert.throws(() => f.store.putOutput({ ...scope, taskId: 'task-2' }, stage.id, 'новая.png'), /scope/);
    f.store.releaseStage(scope, stage.id);
    assert.equal(existsSync(stage.inputsPath), false);
    assert.deepEqual(f.store.read(scope, result.id), png);
    f.store.releaseStage(scope, stage.id);
  } finally { f.cleanup(); }
});

test('input mutation is detected before output admission; cleanup remains available', () => {
  const f = fixture();
  try {
    const first = original(f);
    const stage = f.store.stageTask(scope, [first.id]);
    chmodSync(stage.inputs[0]!.path, 0o600);
    writeFileSync(stage.inputs[0]!.path, 'mutated by engine');
    writeFileSync(join(stage.outputsPath, 'result.txt'), 'result');
    assert.throws(() => f.store.putOutput(scope, stage.id, 'result.txt'), /input was modified/);
    assert.equal(f.store.read(scope, first.id).toString(), 'секретный-marker-original');
    f.store.releaseStage(scope, stage.id);
    assert.equal(existsSync(stage.inputsPath), false);
  } finally { f.cleanup(); }
});

test('deleted input prevents output admission but cannot prevent cleanup', () => {
  const f = fixture();
  try {
    const stage = f.store.stageTask(scope, [original(f).id]);
    chmodSync(stage.inputs[0]!.path, 0o600); unlinkSync(stage.inputs[0]!.path);
    writeFileSync(join(stage.outputsPath, 'result.txt'), 'result');
    assert.throws(() => f.store.putOutput(scope, stage.id, 'result.txt'));
    f.store.releaseStage(scope, stage.id);
    assert.equal(existsSync(stage.outputsPath), false);
  } finally { f.cleanup(); }
});

test('MIME is sniffed, spoofing/unknown binaries/executables/SVG are rejected; byte limits are explicit', () => {
  const f = fixture({ maxBytes: 32, allowedMimeTypes: ['image/png', 'text/plain', 'application/json'] });
  try {
    assert.equal(f.store.put({ ...scope, name: 'photo.bin', bytes: png }).mimeType, 'image/png');
    assert.throws(() => f.store.put({ ...scope, name: 'fake.png', bytes: Buffer.from('plain'), mimeType: 'image/png' }), /MIME mismatch/);
    assert.throws(() => f.store.put({ ...scope, name: 'too-big.txt', bytes: Buffer.alloc(33, 65) }), /byte limit/);
    assert.throws(() => f.store.put({ ...scope, name: 'unknown.bin', bytes: Buffer.from([0, 128, 255]) }), /binary/);
    assert.throws(() => sniffMime(Buffer.from('MZexecutable')), /executable/);
    assert.throws(() => sniffMime(Buffer.from([127, 69, 76, 70, 1])), /executable/);
    assert.throws(() => sniffMime(Buffer.from('<svg xmlns="x"></svg>')), /SVG/);
    assert.throws(() => sniffMime(Buffer.from(Buffer.from('%PDF-').map(byte => byte | 0x80))), /binary/);
    assert.throws(() => f.store.put({ ...scope, name: 'document.pdf', bytes: Buffer.from('%PDF-1.7') }), /disabled/);
    assert.throws(() => sniffMime(Buffer.from('{broken'), 'application/json'), /malformed JSON/);
    assert.equal(sniffMime(Buffer.from('{"valid":true}'), 'application/json'), 'application/json');
  } finally { f.cleanup(); }
});

test('aggregate staging limit prevents large repeated plaintext projections', () => {
  const f = fixture({ maxBytes: 10, maxStageBytes: 15 });
  try {
    const a = original(f, '1234567890', 'a'); const b = original(f, '0987654321', 'b');
    assert.throws(() => f.store.stageTask(scope, [a.id, b.id]), /aggregate/);
    assert.deepEqual(readdirSync(join(f.rootPath, 'stages')), []);
    assert.throws(() => f.store.stageTask(scope, [a.id, a.id]), /staging set/);
  } finally { f.cleanup(); }
});

test('flat file names reject traversal, NTFS ADS and Windows device aliases', () => {
  const f = fixture();
  try {
    for (const name of ['../escape', 'a/b', 'a\\b', 'C:\\file', 'a:stream', '..', 'NUL.txt', 'COM1', 'COM¹.txt', 'LPT².txt', 'CONIN$', 'CONOUT$.txt', ' trailing', 'trailing.', 'x\0y']) {
      assert.throws(() => fileName(name), /file name/, name);
      assert.throws(() => f.store.put({ ...scope, name, bytes: Buffer.from('x') }), /file name/, name);
    }
    assert.equal(fileName('результат 3.png'), 'результат 3.png');
    assert.throws(() => f.store.read(scope, '../escape'), /ID/);
    const stage = f.store.stageTask(scope, []);
    assert.throws(() => f.store.putOutput(scope, stage.id, '../escape'), /file name/);
  } finally { f.cleanup(); }
});

test('root and existing root ancestors cannot be junctions/symlinks on disk', () => {
  const f = fixture();
  try {
    const outside = join(f.temporary, 'outside'); mkdirSync(outside);
    const alias = join(f.temporary, 'alias'); symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => new ArtifactStore({ rootPath: join(alias, 'child'), encryptionKey: key }), /symbolic link|alias/);
    assert.equal(existsSync(join(outside, 'child')), false);
  } finally { f.cleanup(); }
});

test('runtime output directory junction is rejected without accessing the target', () => {
  const f = fixture();
  try {
    const stage = f.store.stageTask(scope, [original(f).id]);
    const outside = join(f.temporary, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'output.txt'), 'private-outside');
    rmSync(stage.outputsPath, { recursive: true });
    symlinkSync(outside, stage.outputsPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.store.putOutput(scope, stage.id, 'output.txt'), /symbolic link|alias/);
    assert.throws(() => f.store.releaseStage(scope, stage.id), /symbolic link|alias/);
    assert.equal(readFileSync(join(outside, 'output.txt')).toString(), 'private-outside');
    unlinkSync(stage.outputsPath); mkdirSync(stage.outputsPath);
    f.store.releaseStage(scope, stage.id); // Retry cleanup after unsafe alias is removed.
    assert.equal(existsSync(stage.inputsPath), false);
  } finally { f.cleanup(); }
});

test('output hard links are rejected and private originals reject added hard links', () => {
  const f = fixture();
  try {
    const first = original(f); const stage = f.store.stageTask(scope, [first.id]);
    const outside = join(f.temporary, 'outside.txt'); writeFileSync(outside, 'outside');
    const linked = join(stage.outputsPath, 'linked.txt'); linkSync(outside, linked);
    assert.throws(() => f.store.putOutput(scope, stage.id, 'linked.txt'), /hard links/);
    unlinkSync(linked);
    const blob = join(f.rootPath, 'originals', `${first.id}.aes`);
    const alias = join(f.temporary, 'alias.aes'); linkSync(blob, alias);
    assert.throws(() => f.store.read(scope, first.id), /hard links/);
    unlinkSync(alias);
    assert.equal(f.store.read(scope, first.id).toString(), 'секретный-marker-original');
  } finally { f.cleanup(); }
});

test('ciphertext and metadata are authenticated; incorrect key cannot open the store', () => {
  const f = fixture();
  try {
    const first = original(f);
    assert.throws(() => new ArtifactStore({ rootPath: f.rootPath, encryptionKey: Buffer.alloc(32, 1) }), /key does not match/);
    const path = join(f.rootPath, 'originals', `${first.id}.aes`);
    const bytes = readFileSync(path); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    chmodSync(path, 0o600); writeFileSync(path, bytes);
    assert.throws(() => f.store.read(scope, first.id), /authenticate|Unsupported state/);
    const second = f.store.put({ ...scope, name: 'second.txt', bytes: Buffer.from('second') });
    const database = new DatabaseSync(join(f.rootPath, 'metadata.sqlite'));
    database.prepare('UPDATE artifacts SET record=? WHERE id=?').run(JSON.stringify({ ...second, name: 'forged-name.txt' }), second.id);
    database.close();
    assert.throws(() => f.store.read(scope, second.id), /authenticate|Unsupported state/);
  } finally { f.cleanup(); }
});

test('revocation cascades all staged dependencies and parents, preserves other scopes, and survives restart', () => {
  const f = fixture();
  let reopened: ArtifactStore | undefined;
  try {
    const a = original(f, 'A', 'source-A'); const b = original(f, 'B', 'source-B');
    const stage = f.store.stageTask(scope, [a.id, b.id]);
    writeFileSync(join(stage.outputsPath, 'combined.txt'), 'combined A+B');
    const combined = f.store.putOutput(scope, stage.id, 'combined.txt', { sourceRef: 'output-source' });
    const next = f.store.put({ ...scope, parentId: combined.id, name: 'next.txt', bytes: Buffer.from('next') });
    assert.deepEqual(f.store.dependencies(scope, combined.id).map(row => row.id), [a.id, b.id]);
    const unrelated = f.store.put({ ...scope, taskId: 'another-task', name: 'other.txt', bytes: Buffer.from('unrelated'), sourceRef: 'source-C' });
    const revoked = f.store.revoke({ ownerId: scope.ownerId, sourceRef: 'source-A' });
    assert.deepEqual(new Set(revoked.artifactIds), new Set([a.id, combined.id, next.id]));
    assert.equal(existsSync(stage.inputsPath), false); assert.equal(existsSync(stage.outputsPath), false);
    assert.throws(() => f.store.read(scope, combined.id), /revoked/);
    assert.throws(() => f.store.put({ ...scope, name: 'resurrection.txt', bytes: Buffer.from('A'), sourceRef: 'source-A' }), /revoked/);
    assert.equal(f.store.read(scope, b.id).toString(), 'B');
    assert.equal(f.store.read({ ...scope, taskId: 'another-task' }, unrelated.id).toString(), 'unrelated');
    assert.equal(f.store.revoke({ ownerId: scope.ownerId, sourceRef: 'source-A' }).generation, revoked.generation);
    f.store.dispose();
    reopened = new ArtifactStore({ rootPath: f.rootPath, encryptionKey: key });
    assert.equal(reopened.revocationGeneration(scope.ownerId), 1);
    assert.throws(() => reopened!.read(scope, a.id), /revoked/);
    assert.throws(() => reopened!.putOutput(scope, stage.id, 'combined.txt'), /revoked/);
  } finally { reopened?.dispose(); f.cleanup(); }
});

test('task revocation prevents new records/stages in exact task; owner revocation covers every owned task', () => {
  const f = fixture();
  try {
    const a = original(f); const b = f.store.put({ ...scope, taskId: 'task-2', name: 'two.txt', bytes: Buffer.from('2') });
    f.store.revoke(scope);
    assert.throws(() => f.store.put({ ...scope, name: 'new.txt', bytes: Buffer.from('new') }), /revoked/);
    assert.throws(() => f.store.stageTask(scope, []), /revoked/);
    assert.throws(() => f.store.read(scope, a.id), /revoked/);
    assert.equal(f.store.read({ ...scope, taskId: 'task-2' }, b.id).toString(), '2');
    f.store.revoke({ ownerId: scope.ownerId });
    assert.throws(() => f.store.read({ ...scope, taskId: 'task-2' }, b.id), /revoked/);
  } finally { f.cleanup(); }
});

test('erase removes encrypted originals, all dependent outputs, staged bytes and display names', () => {
  const f = fixture();
  let reopened: ArtifactStore | undefined;
  try {
    const marker = 'sensitive-name-unique-erase-marker';
    const a = f.store.put({ ...scope, name: `${marker}.txt`, bytes: Buffer.from('secret'), sourceRef: 'source-erase' });
    const stage = f.store.stageTask(scope, [a.id]); writeFileSync(join(stage.outputsPath, 'derived.txt'), 'secret-derivative');
    const b = f.store.putOutput(scope, stage.id, 'derived.txt', { sourceRef: 'different-source' });
    f.store.revoke({ ownerId: scope.ownerId, sourceRef: 'source-erase' });
    const erased = f.store.erase({ ownerId: scope.ownerId, sourceRef: 'source-erase' });
    assert.deepEqual(new Set(erased.artifactIds), new Set([a.id, b.id]));
    assert.deepEqual(readdirSync(join(f.rootPath, 'originals')), []);
    assert.deepEqual(readdirSync(join(f.rootPath, 'stages')), []);
    for (const suffix of ['', '-wal']) {
      const path = join(f.rootPath, `metadata.sqlite${suffix}`);
      if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from(marker)), false, path);
    }
    f.store.dispose();
    reopened = new ArtifactStore({ rootPath: f.rootPath, encryptionKey: key });
    assert.throws(() => reopened!.read(scope, a.id), /revoked/);
    assert.throws(() => reopened!.put({ ...scope, name: 'new.txt', bytes: Buffer.from('secret'), sourceRef: 'source-erase' }), /revoked/);
  } finally { reopened?.dispose(); f.cleanup(); }
});

test('pending erasure finishes after cold reopen rather than reviving a revoked source', () => {
  const f = fixture();
  let reopened: ArtifactStore | undefined;
  try {
    const a = original(f); f.store.revoke({ ownerId: scope.ownerId, sourceRef: 'source-1' }); f.store.dispose();
    const database = new DatabaseSync(join(f.rootPath, 'metadata.sqlite'));
    database.prepare('INSERT INTO pending_erasure(id,erased_at) VALUES(?,?)').run(a.id, '2026-10-04T00:00:00Z'); database.close();
    assert.equal(existsSync(join(f.rootPath, 'originals', `${a.id}.aes`)), true);
    reopened = new ArtifactStore({ rootPath: f.rootPath, encryptionKey: key });
    assert.equal(existsSync(join(f.rootPath, 'originals', `${a.id}.aes`)), false);
    assert.throws(() => reopened!.read(scope, a.id), /revoked/);
    const check = new DatabaseSync(join(f.rootPath, 'metadata.sqlite'));
    assert.equal((check.prepare('SELECT COUNT(*) AS count FROM pending_erasure').get() as { count: number }).count, 0);
    const metadata = check.prepare('SELECT record FROM artifacts WHERE id=?').get(a.id) as { record: string };
    assert.equal(JSON.parse(metadata.record).name, '[erased]'); check.close();
  } finally { reopened?.dispose(); f.cleanup(); }
});

test('construction intent precedes plaintext writes and an interrupted stage is cleaned on cold reopen', () => {
  const f = fixture();
  let reopened: ArtifactStore | undefined;
  try {
    const a = original(f); const b = original(f, 'second original', 'source-2');
    f.store.dispose();
    const script = `import {ArtifactStore} from ${JSON.stringify(new URL('../../src/artifacts/index.ts', import.meta.url).href)};
      const s=new ArtifactStore({rootPath:${JSON.stringify(f.rootPath)},encryptionKey:Buffer.alloc(32,73)});
      const read=s.read.bind(s);let reads=0;
      s.read=(scope,id)=>{if(++reads===2)process.exit(42);return read(scope,id);};
      s.stageTask(${JSON.stringify(scope)},${JSON.stringify([a.id, b.id])});`;
    // Abort a real store process after the first plaintext copy, before activation.
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 42, child.stderr);
    const database = new DatabaseSync(join(f.rootPath, 'metadata.sqlite'));
    const pending = database.prepare('SELECT id,revoked_at FROM stages').get() as { id: string; revoked_at: string };
    assert.ok(pending.revoked_at);
    database.close();
    const stageId = pending.id; const stagePath = join(f.rootPath, 'stages', stageId); const inputs = join(stagePath, 'inputs');
    assert.equal(existsSync(inputs), true);
    assert.equal(readdirSync(inputs).length, 1);
    assert.equal(readFileSync(join(inputs, `${a.id}_${a.name}`)).toString(), 'секретный-marker-original');
    reopened = new ArtifactStore({ rootPath: f.rootPath, encryptionKey: key });
    assert.equal(existsSync(stagePath), false);
    assert.equal(reopened.read(scope, a.id).toString(), 'секретный-marker-original');
    assert.throws(() => reopened!.getStage(scope, stageId), /revoked/);
    reopened.erase({ ownerId: scope.ownerId, sourceRef: 'source-1' });
    assert.deepEqual(readdirSync(join(f.rootPath, 'originals')), [`${b.id}.aes`]);
  } finally { reopened?.dispose(); f.cleanup(); }
});

test('erase cleanup refuses a malicious stage junction; durable access revoke remains and retry completes', () => {
  const f = fixture();
  let reopened: ArtifactStore | undefined;
  try {
    const a = original(f); const stage = f.store.stageTask(scope, [a.id]);
    const outside = join(f.temporary, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'keep');
    rmSync(stage.outputsPath, { recursive: true }); symlinkSync(outside, stage.outputsPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.store.erase({ ownerId: scope.ownerId, sourceRef: 'source-1' }), /symbolic link|alias/);
    assert.throws(() => f.store.read(scope, a.id), /revoked/);
    assert.equal(readFileSync(join(outside, 'keep.txt')).toString(), 'keep');
    const database = new DatabaseSync(join(f.rootPath, 'metadata.sqlite'));
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM pending_erasure').get() as { count: number }).count, 1);
    database.close();
    f.store.dispose();
    unlinkSync(stage.outputsPath); mkdirSync(stage.outputsPath);
    reopened = new ArtifactStore({ rootPath: f.rootPath, encryptionKey: key });
    assert.deepEqual(readdirSync(join(f.rootPath, 'originals')), []);
    assert.deepEqual(readdirSync(join(f.rootPath, 'stages')), []);
    assert.throws(() => reopened!.read(scope, a.id), /revoked/);
  } finally { reopened?.dispose(); f.cleanup(); }
});
