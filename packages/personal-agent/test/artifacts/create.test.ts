import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ArtifactRecord, Json, ToolContext } from '../../src/contracts.ts';
import type { ToolBroker } from '../../src/capabilities/types.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { ArtifactInspector } from '../../src/artifacts/inspect.ts';
import { createArtifactTools } from '../../src/artifacts/create.ts';

function fixture(maxContentBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), 'neurobro-artifact-create-'));
  const store = new ArtifactStore({ rootPath: root, encryptionKey: Buffer.alloc(32, 12) });
  const scope = { ownerId: 'owner', taskId: 'task' };
  let context: ToolContext = { taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' };
  let writable = true;
  const authorizations: { capability: string; resource: string }[] = [];
  const broker: ToolBroker = {
    resolveToolContext(token) { if (token !== 'issued') throw new Error('unissued context'); return context; },
    authorizeTool(token, capability, resource) {
      authorizations.push({ capability, resource });
      if (token !== 'issued' || !writable || capability !== 'artifacts.write' || resource !== context.taskId) throw new Error('creation grant is denied');
    },
    async executeEffect() { throw new Error('file creation must not dispatch external effects'); },
  };
  const registry = new ToolRegistry(broker, createArtifactTools({ store, resolveScope: ctx => ({ ...scope, taskId: ctx.taskId }), maxContentBytes }));
  return { root, store, scope, registry, authorizations,
    invoke: (args: Record<string, Json>, token = 'issued') => registry.invoke(token, { name: 'artifact.create', args }),
    setContext: (value: ToolContext) => { context = value; }, deny: () => { writable = false; },
    cleanup: () => { store.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('real registry creates encrypted UTF-8 text and returns saved artifact refs under the current task grant', async () => {
  const f = fixture();
  try {
    const text = 'Готовый файл — собственный результат\n😀\n';
    const result = await f.invoke({ name: 'ответ.txt', format: 'text', text });
    assert.equal(result.ok, true, result.error);
    const record = result.value as unknown as ArtifactRecord;
    assert.equal(record.name, 'ответ.txt'); assert.equal(record.mimeType, 'text/plain');
    assert.equal(record.size, Buffer.byteLength(text));
    assert.equal(record.sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(f.store.read(f.scope, record.id).toString('utf8'), text);
    assert.equal(f.store.list(f.scope)[0]!.id, record.id);
    const stage = f.store.stageTask(f.scope, [record.id]);
    assert.equal(readFileSync(stage.inputs[0]!.path).toString('utf8'), text);
    assert.equal(readFileSync(join(f.root, 'originals', `${record.id}.aes`)).includes(Buffer.from(text)), false);
    assert.deepEqual(f.authorizations, [{ capability: 'artifacts.write', resource: 'task' }, { capability: 'artifacts.write', resource: 'task' }]);
  } finally { f.cleanup(); }
});

test('JSON creation validates actual parsed data but retains the supplied lexemes and large IDs as strings', async () => {
  const f = fixture();
  try {
    const jsonText = '{\n  "id": "9007199254740993", "price": 1e3, "nested": {"flag": true, "values": [null, "я"]}\n}\n';
    const result = await f.invoke({ name: 'данные.json', format: 'json', jsonText });
    assert.equal(result.ok, true, result.error);
    const record = result.value as unknown as ArtifactRecord;
    assert.equal(record.mimeType, 'application/json');
    assert.equal(f.store.read(f.scope, record.id).toString('utf8'), jsonText);
    const inspected = await new ArtifactInspector().inspect(record, f.store.read(f.scope, record.id));
    assert.deepEqual(inspected.items[0], { key: 'id', value: '9007199254740993' });
    for (const invalid of ['{bad', '{"id":9007199254740993}', '{"n":1e999}']) {
      const rejected = await f.invoke({ name: 'invalid.json', format: 'json', jsonText: invalid });
      assert.equal(rejected.ok, false, invalid);
    }
    const scalar = await f.invoke({ name: 'null.json', format: 'json', jsonText: 'null' });
    assert.equal(scalar.ok, true, scalar.error);
  } finally { f.cleanup(); }
});

test('CSV exact strings, quotes, delimiters, embedded newlines and UTF-8 BOM roundtrip through real inspection', async () => {
  const f = fixture();
  try {
    const columns = ['ID', 'Сумма', 'Название', 'Комментарий'];
    const rows = [['001', '9007199254740993', 'with,"quotes"', 'строка\nвторая\r\nтретья'], ['002', '', '', '=1+1']];
    const result = await f.invoke({ name: 'таблица.csv', format: 'csv', rows, columns, bom: true });
    assert.equal(result.ok, true, result.error);
    const record = result.value as unknown as ArtifactRecord;
    const bytes = f.store.read(f.scope, record.id);
    assert.equal(record.mimeType, 'text/csv');
    assert.deepEqual(bytes.subarray(0, 3), Buffer.from([239, 187, 191]));
    const expected = '\uFEFFID,Сумма,Название,Комментарий\r\n001,9007199254740993,"with,""quotes""","строка\nвторая\r\nтретья"\r\n002,,,=1+1\r\n';
    assert.equal(bytes.toString('utf8'), expected);
    const inspected = await new ArtifactInspector().inspect(record, bytes);
    assert.deepEqual(inspected.items, [columns, ...rows]);
    assert.deepEqual(inspected.coverage, { start: 0, end: 3, total: 3, more: false });
    assert.equal(record.size, Buffer.byteLength(expected));
  } finally { f.cleanup(); }
});

test('CSV defaults have deterministic headers and trailing empty cells; malformed widths/types reject', async () => {
  const f = fixture();
  try {
    const result = await f.invoke({ name: 'default.csv', format: 'csv', rows: [['a', 'b'], ['c']] });
    assert.equal(result.ok, true, result.error);
    const record = result.value as unknown as ArtifactRecord;
    assert.equal(f.store.read(f.scope, record.id).toString(), 'column_1,column_2\r\na,b\r\nc,\r\n');
    for (const args of [
      { name: 'bad.csv', format: 'csv', columns: ['one'], rows: [['a', 'b']] },
      { name: 'bad.csv', format: 'csv', rows: [['a', 9007199254740993]] },
      { name: 'bad.csv', format: 'csv', rows: [{}] },
      { name: 'bad.csv', format: 'csv', rows: [[]] },
    ] as Record<string, Json>[]) assert.equal((await f.invoke(args)).ok, false);
    const empty = await f.invoke({ name: 'empty.csv', format: 'csv', rows: [] }); assert.equal(empty.ok, true, empty.error);
    const singleEmpty = await f.invoke({ name: 'empty-cell.csv', format: 'csv', columns: ['value'], rows: [['']] });
    assert.equal(singleEmpty.ok, true, singleEmpty.error);
    const emptyRecord = singleEmpty.value as unknown as ArtifactRecord;
    const emptyBytes = f.store.read(f.scope, emptyRecord.id);
    assert.equal(emptyBytes.toString(), 'value\r\n""\r\n');
    assert.deepEqual((await new ArtifactInspector().inspect(emptyRecord, emptyBytes)).items, [['value'], ['']]);
  } finally { f.cleanup(); }
});

test('explicit UTF-8 and serialized CSV byte limits reject without truncating or saving artifacts', async () => {
  const f = fixture(24);
  try {
    const cases: Record<string, Json>[] = [
      { name: 'text.txt', format: 'text', text: 'я'.repeat(13) },
      { name: 'text.txt', format: 'text', text: 'a'.repeat(25) },
      { name: 'json.json', format: 'json', jsonText: JSON.stringify({ value: 'я'.repeat(10) }) },
      { name: 'table.csv', format: 'csv', columns: ['title'], rows: [['"'.repeat(10)]] },
    ];
    for (const args of cases) assert.equal((await f.invoke(args)).ok, false);
    assert.deepEqual(f.store.list(f.scope), []);
    const invalidUnicode = await f.invoke({ name: 'unicode.txt', format: 'text', text: '\uD800' });
    assert.equal(invalidUnicode.ok, false); assert.match(invalidUnicode.error!, /surrogate/);
    const exact = await f.invoke({ name: 'exact.txt', format: 'text', text: 'я'.repeat(12) });
    assert.equal(exact.ok, true, exact.error); assert.equal((exact.value as unknown as ArtifactRecord).size, 24);
  } finally { f.cleanup(); }
});

test('issued-task lineage is immutable; another task parent, forged scope/path and denied grants cannot create files', async () => {
  const f = fixture();
  try {
    const parent = f.store.put({ ...f.scope, name: 'original.txt', bytes: Buffer.from('original'), sourceRef: 'source-origin' });
    const childResult = await f.invoke({ name: 'revised.txt', format: 'text', text: 'revised', parentId: parent.id }); assert.equal(childResult.ok, true, childResult.error);
    const child = childResult.value as unknown as ArtifactRecord;
    assert.deepEqual(f.store.lineage(f.scope, child.id).map(record => record.id), [parent.id, child.id]);
    assert.equal(child.sourceRef, 'source-origin'); assert.equal(f.store.read(f.scope, parent.id).toString(), 'original');
    const otherParent = f.store.put({ ...f.scope, taskId: 'other-task', name: 'other.txt', bytes: Buffer.from('other') });
    assert.equal((await f.invoke({ name: 'bad.txt', format: 'text', text: 'x', parentId: otherParent.id })).ok, false);
    for (const field of ['ownerId', 'taskId', 'path', 'destination', 'sourceRef', 'command']) {
      assert.equal((await f.invoke({ name: 'bad.txt', format: 'text', text: 'x', [field]: 'forged' })).ok, false, field);
    }
    for (const name of ['../outside', 'C:\\outside.txt', 'a:stream', 'CON.txt']) assert.equal((await f.invoke({ name, format: 'text', text: 'x' })).ok, false, name);
    assert.equal((await f.invoke({ name: 'unissued.txt', format: 'text', text: 'x' }, 'model-token')).ok, false);
    f.setContext({ taskId: 'other-task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' });
    assert.equal((await f.invoke({ name: 'wrongparent.txt', format: 'text', text: 'x', parentId: parent.id })).ok, false);
    f.deny(); assert.equal((await f.invoke({ name: 'denied.txt', format: 'text', text: 'x' })).ok, false);
    assert.equal(f.store.list(f.scope).length, 2);
    assert.equal(f.store.list({ ...f.scope, taskId: 'other-task' }).length, 1);
    f.store.erase({ ownerId: f.scope.ownerId, sourceRef: 'source-origin' });
    assert.throws(() => f.store.read(f.scope, child.id), /revoked/);
  } finally { f.cleanup(); }
});

test('mixed-format fields and a misbound trusted resolver reject before writing', async () => {
  const f = fixture();
  try {
    for (const args of [
      { name: 'missing.txt', format: 'text' }, { name: 'missing.json', format: 'json' }, { name: 'missing.csv', format: 'csv' },
      { name: 'mixed.txt', format: 'text', text: 'x', jsonText: '{}' },
      { name: 'mixed.json', format: 'json', jsonText: '{}', bom: false },
      { name: 'mixed.csv', format: 'csv', rows: [['x']], text: 'ignored' },
    ] as Record<string, Json>[]) assert.equal((await f.invoke(args)).ok, false);
    const tool = createArtifactTools({ store: f.store, resolveScope: () => ({ ...f.scope, taskId: 'misbound' }) })[0]!;
    await assert.rejects(() => tool.execute({ token: 'issued', context: { taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' }, args: { name: 'bad.txt', format: 'text', text: 'x' } }), /misbound/);
    assert.deepEqual(f.store.list(f.scope), []);
  } finally { f.cleanup(); }
});
