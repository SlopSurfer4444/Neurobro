import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PersonalStore, StoreError } from '../../src/core/store.ts';

const moduleUrl = new URL('../../src/core/store.ts', import.meta.url).href;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'personal-store-'));
  const path = join(directory, 'store.sqlite');
  const key = randomBytes(32);
  return { directory, path, key, open: () => new PersonalStore({ databasePath: path, encryptionKey: key }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('encrypted values persist across reopen; collection separation, updates and deletes', () => {
  const f = fixture();
  let store = f.open();
  try {
    store.put('tasks', 'one', { text: 'secret', nested: [1, null, true], optional: undefined });
    store.put('effects', 'one', { state: 'prepared' });
    assert.equal(store.insert('tasks', 'one', { text: 'replacement' }), false);
    assert.equal(store.insert('tasks', 'two', { text: 'second' }), true);
    store.close();
    store = f.open();
    assert.deepEqual(store.get('tasks', 'one'), { text: 'secret', nested: [1, null, true] });
    assert.deepEqual(store.get('effects', 'one'), { state: 'prepared' });
    assert.equal(store.list('tasks').length, 2);
    store.put('tasks', 'one', { text: 'updated' });
    store.delete('tasks', 'two');
    assert.deepEqual(store.list('tasks'), [{ text: 'updated' }]);
    assert.equal(store.get('tasks', 'two'), undefined);
  } finally { store.close(); f.cleanup(); }
});

test('ciphertext and keyed identifiers reveal no sensitive text in DB or WAL', () => {
  const f = fixture();
  const store = f.open();
  try {
    const secret = 'unique-private-command-output-token-785726';
    store.put(secret, secret, { command: secret, output: secret, token: secret });
    for (const name of readdirSync(f.directory)) {
      assert.equal(readFileSync(join(f.directory, name)).includes(Buffer.from(secret)), false, name);
    }
  } finally { store.close(); f.cleanup(); }
});

test('missing or invalid key is rejected before database creation; wrong key fails on empty and populated stores', () => {
  const f = fixture();
  try {
    for (const key of [undefined, 'bad-key', new Uint8Array(31), new Uint8Array(33)]) {
      assert.throws(() => new PersonalStore({ databasePath: f.path, encryptionKey: key as Uint8Array }), StoreError);
    }
    assert.deepEqual(readdirSync(f.directory), []);
    const store = f.open();
    store.close();
    const wrong = randomBytes(32);
    assert.throws(() => new PersonalStore({ databasePath: f.path, encryptionKey: wrong }), /authentication failed/);
    const reopened = f.open();
    reopened.put('tasks', 'one', 'payload');
    reopened.close();
    assert.throws(() => new PersonalStore({ databasePath: f.path, encryptionKey: wrong }), /authentication failed/);
    f.open().close();
  } finally { f.cleanup(); }
});

test('transactions rollback all writes; nested savepoints can rollback independently', () => {
  const f = fixture();
  const store = f.open();
  try {
    store.put('tasks', 'original', { revision: 1 });
    assert.throws(() => store.transaction(() => {
      store.put('tasks', 'original', { revision: 2 });
      store.insert('effects', 'claim', { state: 'prepared' });
      throw new Error('cancel transaction');
    }), /cancel transaction/);
    assert.deepEqual(store.get('tasks', 'original'), { revision: 1 });
    assert.equal(store.get('effects', 'claim'), undefined);
    const result = store.transaction(() => {
      store.put('tasks', 'outer', 1);
      assert.throws(() => store.transaction(() => { store.put('tasks', 'inner', 2); throw new Error('inner'); }));
      assert.equal(store.get('tasks', 'inner'), undefined);
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(store.get('tasks', 'outer'), 1);
    assert.throws(() => store.transaction(async () => { store.put('tasks', 'async', 1); }), /synchronous/);
    assert.equal(store.get('tasks', 'async'), undefined);
    assert.throws(() => store.transaction(() => { store.put('tasks', 'promise', 1); return Promise.resolve(2); }), /promise/);
    assert.equal(store.get('tasks', 'promise'), undefined);
    assert.throws(() => store.transaction(() => store.close()), /inside a transaction/);
  } finally { store.close(); f.cleanup(); }
});

test('authenticated payload rejects byte corruption and swaps across record locations', () => {
  const f = fixture();
  let store = f.open();
  try {
    store.put('tasks', 'one', { token: 'one-secret' });
    store.put('tasks', 'two', { token: 'two-secret' });
    store.close();
    const db = new DatabaseSync(f.path);
    try {
      const rows = db.prepare('SELECT collection, id, payload FROM records ORDER BY id').all();
      const first = rows[0]!;
      const second = rows[1]!;
      db.prepare('UPDATE records SET payload = ? WHERE collection = ? AND id = ?').run(first.payload!, second.collection!, second.id!);
      const corrupted = Buffer.from(first.payload as Uint8Array);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
      db.prepare('UPDATE records SET payload = ? WHERE collection = ? AND id = ?').run(corrupted, first.collection!, first.id!);
    } finally { db.close(); }
    store = f.open();
    assert.throws(() => store.get('tasks', 'one'), /authentication failed/);
    assert.throws(() => store.get('tasks', 'two'), /authentication failed/);
    assert.throws(() => store.list('tasks'), /authentication failed/);
  } finally { store.close(); f.cleanup(); }
});

test('unsupported schema and missing sentinel fail closed without changing existing data', () => {
  const f = fixture();
  try {
    f.open().close();
    let db = new DatabaseSync(f.path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    assert.throws(() => f.open(), /schema version/);
    db = new DatabaseSync(f.path);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 99);
    db.exec('PRAGMA user_version = 1; DELETE FROM store_meta');
    db.close();
    assert.throws(() => f.open(), /authentication failed/);
  } finally { f.cleanup(); }
});

test('abrupt process exit preserves committed records and discards an unfinished transaction', () => {
  const f = fixture();
  try {
    const source = `import { PersonalStore } from ${JSON.stringify(moduleUrl)};
      const store = new PersonalStore({ databasePath: process.argv[1], encryptionKey: Buffer.from(process.argv[2], 'hex') });
      store.put('tasks', 'committed', { text: 'durable' });
      store.transaction(() => { store.put('tasks', 'partial', { text: 'must rollback' }); process.exit(17); });`;
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source, f.path, f.key.toString('hex')], { encoding: 'utf8' });
    assert.equal(child.status, 17, child.stderr);
    const store = f.open();
    try {
      assert.deepEqual(store.get('tasks', 'committed'), { text: 'durable' });
      assert.equal(store.get('tasks', 'partial'), undefined);
      assert.equal(store.insert('tasks', 'partial', 'recovered'), true);
    } finally { store.close(); }
  } finally { f.cleanup(); }
});

test('independent concurrent processes admit exactly one durable uniqueness claim', async () => {
  const f = fixture();
  try {
    f.open().close();
    const source = `import { PersonalStore } from ${JSON.stringify(moduleUrl)};
      const store = new PersonalStore({ databasePath: process.argv[1], encryptionKey: Buffer.from(process.argv[2], 'hex') });
      console.log(store.insert('claims', 'shared', { owner: process.argv[3] })); store.close();`;
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source, f.path, f.key.toString('hex'), String(index)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout += String(data); });
      child.stderr.on('data', data => { stderr += String(data); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    })));
    assert.equal(results.filter(value => value === 'true').length, 1);
    assert.equal(results.filter(value => value === 'false').length, 3);
    const store = f.open();
    try {
      assert.equal(store.list('claims').length, 1);
      assert.equal(store.insert('claims', 'shared', { owner: 'later' }), false);
    } finally { store.close(); }
  } finally { f.cleanup(); }
});

test('invalid payloads are rejected and close is idempotent', () => {
  const f = fixture();
  const store = f.open();
  try {
    for (const value of [undefined, NaN, Infinity, 1n, { fn: () => 1 }]) {
      assert.throws(() => store.put('tasks', 'bad', value), /JSON serializable/);
    }
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    assert.throws(() => store.put('tasks', 'bad', cycle), /JSON serializable/);
    assert.equal(store.list('tasks').length, 0);
    store.close(); store.close();
    assert.throws(() => store.get('tasks', 'x'), /closed/);
  } finally { store.close(); f.cleanup(); }
});
