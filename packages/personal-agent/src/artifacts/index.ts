import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactRecord, Clock } from '../contracts.ts';
import { systemClock } from '../contracts.ts';
import { boundedRead, contained, directory, fileName, immutableWrite, safePath } from './paths.ts';
import { sniffMime } from './mime.ts';

export type { ArtifactRecord } from '../contracts.ts';
export { sniffMime } from './mime.ts';
export interface ArtifactScope { ownerId: string; taskId: string }
export interface ArtifactInput extends ArtifactScope {
  name: string; bytes: Uint8Array; mimeType?: string; parentId?: string; sourceRef?: string;
}
export interface ArtifactStage {
  id: string; inputsPath: string; outputsPath: string;
  inputs: { artifact: ArtifactRecord; path: string }[];
}
export interface ArtifactRevocation { ownerId: string; taskId?: string; sourceRef?: string }
export interface ArtifactRevocationResult { artifactIds: string[]; revokedAt: string; generation: number }
export interface ArtifactStoreOptions {
  rootPath: string;
  /** Supplied by trusted host; the store never persists this key or provisions secrets. */
  encryptionKey: Uint8Array;
  maxBytes?: number; maxStageBytes?: number; allowedMimeTypes?: readonly string[]; clock?: Clock;
}
export interface ArtifactPort {
  put(input: ArtifactInput): ArtifactRecord;
  /** Trusted same-owner admission across task scopes, preserving deletion/revocation ancestry. */
  copyIntoTask(sourceScope: ArtifactScope, id: string, targetScope: ArtifactScope,
    options?: { name?: string; sourceRef?: string }): ArtifactRecord;
  get(scope: ArtifactScope, id: string): ArtifactRecord;
  read(scope: ArtifactScope, id: string): Buffer;
  list(scope: ArtifactScope): ArtifactRecord[];
  lineage(scope: ArtifactScope, id: string): ArtifactRecord[];
  dependencies(scope: ArtifactScope, id: string): ArtifactRecord[];
  stageTask(scope: ArtifactScope, artifactIds: readonly string[]): ArtifactStage;
  getStage(scope: ArtifactScope, stageId: string): ArtifactStage;
  putOutput(scope: ArtifactScope, stageId: string, file: string,
    options?: { name?: string; parentId?: string; sourceRef?: string; mimeType?: string }): ArtifactRecord;
  revoke(selector: ArtifactRevocation): ArtifactRevocationResult;
  /** Removes encrypted originals and staging; retains IDs/hash/tombstones only. */
  erase(selector: ArtifactRevocation): ArtifactRevocationResult;
  revocationGeneration(ownerId: string): number;
  releaseStage(scope: ArtifactScope, stageId: string): void;
  dispose(): void;
}

interface StageRow { id: string; owner_id: string; task_id: string; input_ids: string; revoked_at: string | null }
interface ArtifactRow { record: string; revoked_at: string | null }
const MAX_BYTES = 64 * 1024 * 1024;
const FORMAT = Buffer.from('NART01');
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error(`invalid artifact ${label}`);
  return value;
}
function artifactId(id: string): string {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('invalid artifact or stage ID');
  return id;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * One trusted local process owns this root. SQLite holds metadata only; originals are
 * AES-256-GCM files with scope, lineage and digest authenticated as AAD. Source bytes
 * are never overwritten. Staging exposes explicit plaintext copies to the task runtime.
 * These checks defend against existing symlinks/junctions/hard links, not an adversary
 * concurrently replacing parent directories or reading already-open engine handles.
 */
export class ArtifactStore implements ArtifactPort {
  readonly rootPath: string;
  readonly maxBytes: number;
  readonly maxStageBytes: number;
  private readonly key: Buffer;
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly allowed: Set<string> | undefined;
  private closed = false;

  constructor(options: ArtifactStoreOptions) {
    if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.byteLength !== 32) throw new Error('artifact encryption key must contain 32 bytes');
    const max = options.maxBytes ?? MAX_BYTES;
    if (!Number.isSafeInteger(max) || max < 1 || max > 1024 * 1024 * 1024) throw new Error('invalid artifact byte limit');
    if (typeof options.rootPath !== 'string' || !options.rootPath) throw new Error('artifact root is required');
    this.rootPath = resolve(options.rootPath);
    this.maxBytes = max;
    const stageMax = options.maxStageBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(stageMax) || stageMax < 1 || stageMax > 1024 * 1024 * 1024) throw new Error('invalid artifact staging byte limit');
    this.maxStageBytes = stageMax;
    this.key = Buffer.from(options.encryptionKey);
    this.clock = options.clock ?? systemClock;
    this.allowed = options.allowedMimeTypes ? new Set(options.allowedMimeTypes) : undefined;
    directory(this.rootPath);
    directory(join(this.rootPath, 'originals'));
    directory(join(this.rootPath, 'stages'));
    this.checkPaths();
    this.database = new DatabaseSync(join(this.rootPath, 'metadata.sqlite'));
    try {
      chmodSync(join(this.rootPath, 'metadata.sqlite'), 0o600);
      this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
          parent_id TEXT REFERENCES artifacts(id), source_ref TEXT,
          record TEXT NOT NULL, revoked_at TEXT, erased_at TEXT);
        CREATE INDEX IF NOT EXISTS artifact_scope ON artifacts(owner_id, task_id);
        CREATE INDEX IF NOT EXISTS artifact_source ON artifacts(owner_id, source_ref);
        CREATE TABLE IF NOT EXISTS artifact_dependencies (
          artifact_id TEXT NOT NULL REFERENCES artifacts(id), input_id TEXT NOT NULL REFERENCES artifacts(id),
          PRIMARY KEY(artifact_id,input_id));
        CREATE TABLE IF NOT EXISTS stages (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
          input_ids TEXT NOT NULL, revoked_at TEXT);
        CREATE TABLE IF NOT EXISTS tombstones (
          owner_id TEXT NOT NULL, task_id TEXT NOT NULL, source_ref TEXT NOT NULL, revoked_at TEXT NOT NULL,
          PRIMARY KEY(owner_id, task_id, source_ref));
        CREATE TABLE IF NOT EXISTS generations (owner_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pending_erasure (id TEXT PRIMARY KEY REFERENCES artifacts(id), erased_at TEXT NOT NULL);`);
      const columns = this.database.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'erased_at')) this.database.exec('ALTER TABLE artifacts ADD COLUMN erased_at TEXT');
      const verifier = createHmac('sha256', this.key).update('personal-agent-artifact-key-v1').digest('hex');
      const existing = this.database.prepare('SELECT value FROM settings WHERE key = ?').get('key-verifier') as { value: string } | undefined;
      if (existing && existing.value !== verifier) throw new Error('artifact encryption key does not match this store');
      this.database.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run('key-verifier', verifier);
      this.cleanupRevokedStages();
      this.finishErasures();
    } catch (error) { this.database.close(); this.key.fill(0); throw error; }
  }

  private checkPaths(): void {
    safePath(this.rootPath, 'directory');
    safePath(join(this.rootPath, 'originals'), 'directory');
    safePath(join(this.rootPath, 'stages'), 'directory');
    for (const suffix of ['', '-wal', '-shm', '-journal']) safePath(join(this.rootPath, `metadata.sqlite${suffix}`), 'file');
  }
  private ready(): void { if (this.closed) throw new Error('artifact store is closed'); this.checkPaths(); }
  private scope(scope: ArtifactScope): void { identifier(scope.ownerId, 'owner ID'); identifier(scope.taskId, 'task ID'); }
  private now(): string { return this.clock.now().toISOString(); }
  private blob(id: string): string { return join(this.rootPath, 'originals', `${artifactId(id)}.aes`); }
  private aad(record: ArtifactRecord): Buffer {
    return Buffer.from(JSON.stringify([record.id, record.ownerId, record.taskId, record.name, record.mimeType,
      record.sha256, record.size, record.createdAt, record.parentId ?? null, record.sourceRef ?? null]));
  }
  private isTombstoned(scope: ArtifactScope, sourceRef?: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM tombstones WHERE owner_id=?
      AND (task_id='' OR task_id=?) AND (source_ref='' OR source_ref=?) LIMIT 1`).get(scope.ownerId, scope.taskId, sourceRef ?? ''));
  }
  private row(scope: ArtifactScope, id: string): ArtifactRecord {
    this.scope(scope); artifactId(id);
    const row = this.database.prepare('SELECT record, revoked_at FROM artifacts WHERE id=? AND owner_id=? AND task_id=?').get(id, scope.ownerId, scope.taskId) as ArtifactRow | undefined;
    if (!row) throw new Error('artifact does not exist in this owner/task scope');
    const record = JSON.parse(row.record) as ArtifactRecord;
    if (row.revoked_at || this.isTombstoned(scope, record.sourceRef)) throw new Error('artifact has been revoked');
    return record;
  }

  put(input: ArtifactInput): ArtifactRecord { return this.save(input); }
  copyIntoTask(sourceScope: ArtifactScope, id: string, targetScope: ArtifactScope,
    options: {name?: string;sourceRef?: string} = {}): ArtifactRecord {
    this.ready(); this.scope(sourceScope); this.scope(targetScope);
    if(sourceScope.ownerId!==targetScope.ownerId)throw new Error('artifact copy cannot cross owners');
    const source=this.row(sourceScope,id), bytes=this.read(sourceScope,id);
    return this.save({ownerId:targetScope.ownerId,taskId:targetScope.taskId,name:options.name??source.name,mimeType:source.mimeType,bytes,
      ...(options.sourceRef?{sourceRef:options.sourceRef}:source.sourceRef?{sourceRef:source.sourceRef}:{})},[],[source]);
  }
  private save(input: ArtifactInput, dependencies: readonly string[] = [], linkedSources: readonly ArtifactRecord[] = []): ArtifactRecord {
    this.ready(); this.scope(input); fileName(input.name);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > this.maxBytes) throw new Error('artifact exceeds byte limit');
    if (input.sourceRef !== undefined) identifier(input.sourceRef, 'source reference');
    // Copy caller-owned bytes before sniffing/hashing/encrypting.
    const bytes = Buffer.from(input.bytes);
    const mimeType = sniffMime(bytes, input.mimeType);
    if (this.allowed && !this.allowed.has(mimeType)) throw new Error('artifact MIME type is disabled by policy');
    const parent = input.parentId ? this.row(input, input.parentId) : undefined;
    for (const dependency of dependencies) this.row(input, dependency);
    for(const source of linkedSources){if(source.ownerId!==input.ownerId)throw new Error('artifact linked source cannot cross owners');this.row({ownerId:source.ownerId,taskId:source.taskId},source.id);}
    const sourceRef = input.sourceRef ?? parent?.sourceRef;
    if (this.isTombstoned(input, sourceRef)) throw new Error('artifact source or scope has been revoked');
    const record: ArtifactRecord = {
      id: randomUUID(), ownerId: input.ownerId, taskId: input.taskId, name: input.name,
      mimeType, sha256: digest(bytes), size: bytes.length, createdAt: this.now(),
      ...(input.parentId ? { parentId: input.parentId } : {}), ...(sourceRef ? { sourceRef } : {}),
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.aad(record));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const encrypted = Buffer.concat([FORMAT, nonce, cipher.getAuthTag(), ciphertext]);
    immutableWrite(this.blob(record.id), encrypted);
    try {
      this.database.exec('BEGIN IMMEDIATE');
      this.database.prepare('INSERT INTO artifacts(id, owner_id, task_id, parent_id, source_ref, record) VALUES(?,?,?,?,?,?)')
        .run(record.id, record.ownerId, record.taskId, record.parentId ?? null, record.sourceRef ?? null, JSON.stringify(record));
      const edge = this.database.prepare('INSERT INTO artifact_dependencies(artifact_id,input_id) VALUES(?,?)');
      for (const inputId of new Set([...dependencies, ...linkedSources.map(source=>source.id), ...(parent ? [parent.id] : [])])) edge.run(record.id, inputId);
      this.database.exec('COMMIT');
    } catch (error) { if (this.database.isTransaction) this.database.exec('ROLLBACK'); this.removeFile(this.blob(record.id)); throw error; }
    return { ...record };
  }
  get(scope: ArtifactScope, id: string): ArtifactRecord { this.ready(); return this.row(scope, id); }
  read(scope: ArtifactScope, id: string): Buffer {
    this.ready(); const record = this.row(scope, id);
    const encrypted = boundedRead(this.blob(record.id), this.maxBytes + 34);
    if (encrypted.length < 34 || !encrypted.subarray(0, 6).equals(FORMAT)) throw new Error('artifact ciphertext format is invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(6, 18));
    decipher.setAAD(this.aad(record)); decipher.setAuthTag(encrypted.subarray(18, 34));
    const bytes = Buffer.concat([decipher.update(encrypted.subarray(34)), decipher.final()]);
    if (bytes.length !== record.size || digest(bytes) !== record.sha256) throw new Error('artifact original hash mismatch');
    return bytes;
  }
  list(scope: ArtifactScope): ArtifactRecord[] {
    this.ready(); this.scope(scope);
    const rows = this.database.prepare('SELECT id FROM artifacts WHERE owner_id=? AND task_id=? AND revoked_at IS NULL ORDER BY rowid').all(scope.ownerId, scope.taskId) as { id: string }[];
    return rows.map(({ id }) => this.row(scope, id));
  }
  lineage(scope: ArtifactScope, id: string): ArtifactRecord[] {
    this.ready(); const lineage: ArtifactRecord[] = []; const seen = new Set<string>();
    let current: string | undefined = id;
    while (current) {
      if (seen.has(current)) throw new Error('artifact lineage cycle');
      seen.add(current); const record = this.row(scope, current); lineage.push(record); current = record.parentId;
    }
    return lineage.reverse();
  }
  dependencies(scope: ArtifactScope, id: string): ArtifactRecord[] {
    this.ready(); this.row(scope, id);
    const rows = this.database.prepare('SELECT a.id,a.task_id FROM artifact_dependencies d JOIN artifacts a ON a.id=d.input_id WHERE d.artifact_id=? AND a.owner_id=? ORDER BY d.rowid').all(id,scope.ownerId) as { id: string; task_id:string }[];
    return rows.map(row => this.row({ownerId:scope.ownerId,taskId:row.task_id},row.id));
  }

  stageTask(scope: ArtifactScope, artifactIds: readonly string[]): ArtifactStage {
    this.ready(); this.scope(scope);
    if (!Array.isArray(artifactIds) || artifactIds.length > 256 || new Set(artifactIds).size !== artifactIds.length) throw new Error('invalid artifact staging set');
    if (this.isTombstoned(scope)) throw new Error('artifact scope has been revoked');
    const records = artifactIds.map(id => this.row(scope, id));
    if (records.reduce((total, record) => total + record.size, 0) > this.maxStageBytes) throw new Error('artifact staging set exceeds aggregate byte limit');
    const stageId = randomUUID(); const root = this.stageRoot(stageId);
    const inputsPath = join(root, 'inputs'); const outputsPath = join(root, 'outputs');
    // Persist a cleanup intent before writing any plaintext. Pending stages use
    // revoked_at until construction succeeds and are cleaned on cold reopen.
    this.database.prepare('INSERT INTO stages(id, owner_id, task_id, input_ids, revoked_at) VALUES(?,?,?,?,?)')
      .run(stageId, scope.ownerId, scope.taskId, JSON.stringify(artifactIds), this.now());
    try {
      directory(inputsPath); directory(outputsPath);
      const inputs = records.map(artifact => {
        const path = join(inputsPath, `${artifact.id}_${fileName(artifact.name)}`);
        immutableWrite(path, this.read(scope, artifact.id));
        return { artifact, path };
      });
      this.database.prepare('UPDATE stages SET revoked_at=NULL WHERE id=?').run(stageId);
      return { id: stageId, inputsPath, outputsPath, inputs };
    } catch (error) { this.removeStage(stageId); throw error; }
  }
  private stageRoot(id: string): string { return contained(join(this.rootPath, 'stages'), join(this.rootPath, 'stages', artifactId(id))); }
  private stage(scope: ArtifactScope, id: string): StageRow {
    this.scope(scope); artifactId(id);
    const row = this.database.prepare('SELECT * FROM stages WHERE id=? AND owner_id=? AND task_id=?').get(id, scope.ownerId, scope.taskId) as StageRow | undefined;
    if (!row || row.revoked_at || this.isTombstoned(scope)) throw new Error('artifact stage is absent or revoked in this scope');
    for (const inputId of JSON.parse(row.input_ids) as string[]) {
      const input = this.row(scope, inputId);
      const path = join(this.stageRoot(id), 'inputs', `${input.id}_${fileName(input.name)}`);
      const bytes = boundedRead(path, this.maxBytes);
      if (bytes.length !== input.size || digest(bytes) !== input.sha256) throw new Error('staged artifact input was modified');
    }
    safePath(this.stageRoot(id), 'directory');
    for (const name of ['inputs', 'outputs']) {
      const directoryPath = join(this.stageRoot(id), name);
      safePath(directoryPath, 'directory');
      if (!existsSync(directoryPath)) throw new Error('artifact stage directory is unavailable');
    }
    return row;
  }
  getStage(scope: ArtifactScope, stageId: string): ArtifactStage {
    this.ready(); const stage = this.stage(scope, stageId); const root = this.stageRoot(stageId);
    return { id: stageId, inputsPath: join(root, 'inputs'), outputsPath: join(root, 'outputs'),
      inputs: (JSON.parse(stage.input_ids) as string[]).map(id => {
        const artifact = this.row(scope, id);
        return { artifact, path: join(root, 'inputs', `${artifact.id}_${fileName(artifact.name)}`) };
      }),
    };
  }
  putOutput(scope: ArtifactScope, stageId: string, file: string,
    options: { name?: string; parentId?: string; sourceRef?: string; mimeType?: string } = {}): ArtifactRecord {
    this.ready(); const stage = this.stage(scope, stageId); fileName(file);
    const inputs = JSON.parse(stage.input_ids) as string[];
    const parentId = options.parentId ?? (inputs.length === 1 ? inputs[0] : undefined);
    const path = contained(this.stageRoot(stageId), join(this.stageRoot(stageId), 'outputs', file));
    return this.save({ ...scope, name: options.name ?? file, bytes: boundedRead(path, this.maxBytes),
      ...(parentId ? { parentId } : {}),
      ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
      ...(options.mimeType ? { mimeType: options.mimeType } : {}),
    }, inputs);
  }

  revoke(selector: ArtifactRevocation): ArtifactRevocationResult { return this.invalidate(selector, false); }
  erase(selector: ArtifactRevocation): ArtifactRevocationResult { return this.invalidate(selector, true); }
  private invalidate(selector: ArtifactRevocation, erase: boolean): ArtifactRevocationResult {
    this.ready(); identifier(selector.ownerId, 'owner ID');
    if (selector.taskId !== undefined) identifier(selector.taskId, 'task ID');
    if (selector.sourceRef !== undefined) identifier(selector.sourceRef, 'source reference');
    const revokedAt = this.now();
    const rows = this.database.prepare('SELECT id, task_id, parent_id, source_ref, revoked_at FROM artifacts WHERE owner_id=? AND erased_at IS NULL').all(selector.ownerId) as { id: string; task_id: string; parent_id: string | null; source_ref: string | null; revoked_at: string | null }[];
    const ids = new Set(rows.filter(row => (!selector.taskId || row.task_id === selector.taskId) && (!selector.sourceRef || row.source_ref === selector.sourceRef)).map(row => row.id));
    const edges = this.database.prepare(`SELECT artifact_id,input_id FROM artifact_dependencies
      WHERE artifact_id IN (SELECT id FROM artifacts WHERE owner_id=?)`).all(selector.ownerId) as { artifact_id: string; input_id: string }[];
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (row.parent_id && ids.has(row.parent_id) && !ids.has(row.id)) { ids.add(row.id); changed = true; }
      for (const edge of edges) if (ids.has(edge.input_id) && !ids.has(edge.artifact_id)) { ids.add(edge.artifact_id); changed = true; }
    }
    const stages = this.database.prepare('SELECT * FROM stages WHERE owner_id=? AND revoked_at IS NULL').all(selector.ownerId) as unknown as StageRow[];
    const affectedStages = stages.filter(row =>
      ((!selector.taskId || row.task_id === selector.taskId) && !selector.sourceRef) ||
      (JSON.parse(row.input_ids) as string[]).some(id => ids.has(id)));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const tombstone = this.database.prepare('INSERT OR IGNORE INTO tombstones(owner_id,task_id,source_ref,revoked_at) VALUES(?,?,?,?)')
        .run(selector.ownerId, selector.taskId ?? '', selector.sourceRef ?? '', revokedAt);
      const revokeArtifact = this.database.prepare('UPDATE artifacts SET revoked_at=? WHERE id=? AND revoked_at IS NULL');
      for (const id of ids) revokeArtifact.run(revokedAt, id);
      const revokeStage = this.database.prepare('UPDATE stages SET revoked_at=? WHERE id=?');
      for (const row of affectedStages) revokeStage.run(revokedAt, row.id);
      if (erase) {
        // Erasure intent is committed with access revocation, before any disk cleanup.
        const pending = this.database.prepare('INSERT OR IGNORE INTO pending_erasure(id,erased_at) VALUES(?,?)');
        for (const id of ids) pending.run(id, revokedAt);
      }
      if (rows.some(row => ids.has(row.id) && !row.revoked_at) || affectedStages.length || Number(tombstone.changes)) this.database.prepare(`INSERT INTO generations(owner_id,generation) VALUES(?,1)
        ON CONFLICT(owner_id) DO UPDATE SET generation=generation+1`).run(selector.ownerId);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    // Access is revoked durably before cleanup. A cleanup exception reports incomplete
    // plaintext deletion honestly; re-running this selector retries revoked stages.
    this.cleanupRevokedStages(selector.ownerId);
    if (erase) this.finishErasures();
    return { artifactIds: [...ids], revokedAt, generation: this.revocationGeneration(selector.ownerId) };
  }
  private cleanupRevokedStages(ownerId?: string): void {
    const rows = (ownerId ? this.database.prepare('SELECT id FROM stages WHERE owner_id=? AND revoked_at IS NOT NULL').all(ownerId)
      : this.database.prepare('SELECT id FROM stages WHERE revoked_at IS NOT NULL').all()) as { id: string }[];
    for (const row of rows) this.removeStage(row.id);
  }
  revocationGeneration(ownerId: string): number {
    this.ready(); identifier(ownerId, 'owner ID');
    return (this.database.prepare('SELECT generation FROM generations WHERE owner_id=?').get(ownerId) as { generation: number } | undefined)?.generation ?? 0;
  }
  private finishErasures(): void {
    const rows = this.database.prepare('SELECT id, erased_at FROM pending_erasure').all() as { id: string; erased_at: string }[];
    for (const pending of rows) {
      this.removeFile(this.blob(pending.id));
      const row = this.database.prepare('SELECT record FROM artifacts WHERE id=?').get(pending.id) as { record: string };
      const record = JSON.parse(row.record) as ArtifactRecord;
      // Redact user-provided names. Exact IDs, hash and scope remain for audit/tombstones.
      record.name = '[erased]';
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.prepare('UPDATE artifacts SET record=?,erased_at=? WHERE id=?').run(JSON.stringify(record), pending.erased_at, pending.id);
        this.database.exec('COMMIT');
      } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    }
    if (rows.length) {
      // Scrub replaced display names from this live DB and WAL, not independent backups.
      this.database.exec('PRAGMA secure_delete=ON; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
      // Pending records survive crashes until after physical DB/WAL scrubbing.
      const finish = this.database.prepare('DELETE FROM pending_erasure WHERE id=?');
      this.database.exec('BEGIN IMMEDIATE');
      try { for (const row of rows) finish.run(row.id); this.database.exec('COMMIT'); }
      catch (error) { this.database.exec('ROLLBACK'); throw error; }
    }
  }
  private removeFile(path: string): void {
    safePath(path, 'file'); if (!existsSync(path)) return;
    chmodSync(path, 0o600); rmSync(path);
  }
  private removeStage(id: string): void {
    const root = this.stageRoot(id);
    safePath(root, 'directory'); if (!existsSync(root)) return;
    // Never traverse a runtime-created symlink, even during cleanup.
    const verify = (path: string): void => {
      safePath(path);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name); safePath(child);
        if (entry.isDirectory()) verify(child); else { safePath(child, 'file'); chmodSync(child, 0o600); }
      }
    };
    verify(root); rmSync(root, { recursive: true });
  }
  releaseStage(scope: ArtifactScope, stageId: string): void {
    this.ready(); this.scope(scope); artifactId(stageId);
    const row = this.database.prepare('SELECT id FROM stages WHERE id=? AND owner_id=? AND task_id=?').get(stageId, scope.ownerId, scope.taskId);
    if (!row) throw new Error('artifact stage is absent in this scope');
    this.database.prepare('UPDATE stages SET revoked_at=? WHERE id=?').run(this.now(), stageId);
    this.removeStage(stageId);
  }
  dispose(): void {
    if (this.closed) return;
    this.database.close(); this.key.fill(0); this.closed = true;
  }
}
