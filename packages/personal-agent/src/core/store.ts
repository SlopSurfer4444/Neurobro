import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';

export interface PersonalStoreOptions {
  databasePath: string;
  /** Caller-managed, explicit 256-bit key. The store never persists it. */
  encryptionKey: Uint8Array;
}

export class StoreError extends Error {
  constructor(message: string) { super(message); this.name = 'StoreError'; }
}

const SCHEMA_VERSION = 1;
const SENTINEL_AAD = 'personal-agent/store/key-check/v1';
const SENTINEL = 'personal-agent encrypted store v1';
type StoredRow = { collection: string; id: string; payload: Uint8Array };

/** All payloads and lookup identifiers are protected at rest, including WAL data.
 * Reads authenticate both ciphertext and record location. No fallback plaintext mode.
 */
export class PersonalStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private closed = false;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(options: PersonalStoreOptions) {
    if (!(options?.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32) {
      throw new StoreError('An explicit 32-byte encryption key is required');
    }
    if (typeof options.databasePath !== 'string' || !options.databasePath) {
      throw new StoreError('A database path is required');
    }
    this.key = Buffer.from(options.encryptionKey);
    try {
      this.db = new DatabaseSync(options.databasePath);
    } catch (error) {
      this.key.fill(0);
      throw error;
    }
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      // Acquire the write lock before deciding whether this is a new store.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
        if (version === 0) {
          const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
          if (existing.length) throw new StoreError('Unrecognized database schema');
          this.db.exec(`CREATE TABLE store_meta (id INTEGER PRIMARY KEY CHECK (id = 1), payload BLOB NOT NULL) STRICT;
            CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL,
              PRIMARY KEY (collection, id)) STRICT, WITHOUT ROWID;
            PRAGMA user_version = ${SCHEMA_VERSION}`);
          this.db.prepare('INSERT INTO store_meta (id, payload) VALUES (1, ?)').run(this.encrypt(SENTINEL, SENTINEL_AAD));
        } else if (version !== SCHEMA_VERSION) {
          throw new StoreError('Unsupported database schema version');
        }
        const sentinel = this.db.prepare('SELECT payload FROM store_meta WHERE id = 1').get();
        if (!sentinel || this.decrypt(sentinel.payload as Uint8Array, SENTINEL_AAD) !== SENTINEL) {
          throw new StoreError('Encrypted store authentication failed');
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF');
    } catch (error) {
      this.db.close();
      this.key.fill(0);
      this.closed = true;
      throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    this.assertOpen();
    if (types.isAsyncFunction(fn)) throw new StoreError('Transactions require a synchronous callback');
    const savepoint = `store_sp_${++this.savepointSequence}`;
    const outer = this.transactionDepth === 0;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try {
      const result = fn();
      if (result && (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function') {
        // Observe rejected promises to avoid an unrelated unhandled rejection.
        void Promise.resolve(result).catch(() => {});
        throw new StoreError('Transactions cannot return a promise');
      }
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (outer) this.db.exec('ROLLBACK');
      else this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  get<T>(collection: string, id: string): T | undefined {
    this.assertOpen();
    const location = this.location(collection, id);
    const row = this.db.prepare('SELECT payload FROM records WHERE collection = ? AND id = ?').get(...location);
    return row ? this.decrypt(row.payload as Uint8Array, this.aad(...location)) as T : undefined;
  }

  put<T>(collection: string, id: string, value: T): void {
    this.assertOpen();
    const location = this.location(collection, id);
    const payload = this.encrypt(value, this.aad(...location));
    this.db.prepare(`INSERT INTO records (collection, id, payload) VALUES (?, ?, ?)
      ON CONFLICT (collection, id) DO UPDATE SET payload = excluded.payload`).run(...location, payload);
  }

  /** An atomic uniqueness claim. Existing values are never overwritten. */
  insert<T>(collection: string, id: string, value: T): boolean {
    this.assertOpen();
    const location = this.location(collection, id);
    const payload = this.encrypt(value, this.aad(...location));
    const result = this.db.prepare('INSERT INTO records (collection, id, payload) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO NOTHING').run(...location, payload);
    return result.changes === 1;
  }

  list<T>(collection: string): T[] {
    this.assertOpen();
    const collectionHash = this.index('collection', collection);
    const rows = this.db.prepare('SELECT collection, id, payload FROM records WHERE collection = ? ORDER BY id').all(collectionHash) as StoredRow[];
    return rows.map(row => this.decrypt(row.payload, this.aad(row.collection, row.id)) as T);
  }

  delete(collection: string, id: string): void {
    this.assertOpen();
    this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(...this.location(collection, id));
  }

  close(): void {
    if (this.closed) return;
    if (this.transactionDepth) throw new StoreError('Cannot close a store inside a transaction');
    this.db.close();
    this.key.fill(0);
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new StoreError('Store is closed');
  }

  private index(domain: string, value: string): string {
    if (typeof value !== 'string' || !value) throw new StoreError('Collection and record identifiers must be nonempty strings');
    return createHmac('sha256', this.key).update(`personal-agent/store/index/v1/${domain}\0`).update(value).digest('hex');
  }

  private location(collection: string, id: string): [string, string] {
    return [this.index('collection', collection), this.index(`record/${collection}`, id)];
  }

  private aad(collection: string, id: string): string {
    return `personal-agent/store/record/v1/${collection}/${id}`;
  }

  private encrypt(value: unknown, aad: string): Buffer {
    let json: string | undefined;
    try {
      json = JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'function' || typeof item === 'symbol' ||
            typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) {
          throw new Error('Non-JSON value');
        }
        return item;
      });
    } catch {
      throw new StoreError('Payload must be JSON serializable');
    }
    if (json === undefined) throw new StoreError('Payload must be JSON serializable');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  }

  private decrypt(payload: Uint8Array, aad: string): unknown {
    try {
      const blob = Buffer.from(payload);
      if (blob.length < 30 || blob[0] !== 1) throw new Error('Invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(1, 13));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(blob.subarray(13, 29));
      const plaintext = Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch {
      throw new StoreError('Encrypted store authentication failed');
    }
  }
}
