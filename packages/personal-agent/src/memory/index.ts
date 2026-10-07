import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync, realpathSync, openSync, closeSync, fsyncSync, constants } from 'node:fs';
import { dirname, resolve, join, parse } from 'node:path';
import type { Clock, Preference } from '../contracts.ts';

export interface MemoryAccess { ownerId: string; scopes: string[]; accountId?: string }
export type Attribution = 'owner_explicit' | 'third_party' | 'assistant_proposal' | 'inferred';
export interface SourceInput {
  ownerId: string; accountId: string; scope: string; sourceId: string; version: string;
  eventAt: string; text: string; original?: Uint8Array; mimeType?: string;
  attribution?: Attribution; forwarded?: boolean; sourceMetadata?: Record<string, unknown>;
  /** Trusted monotonic transport edit/update sequence; required for changing an existing source. */
  revisionSequence?: number;
}
export interface SourceRevision {
  ref: string; ownerId: string; accountId: string; scope: string; sourceId: string;
  version: string; eventAt: string; ingestedAt: string; sha256: string; originalSha256: string;
  text: string; mimeType: string; attribution: Attribution; forwarded: boolean;
  sourceMetadata?: Record<string, unknown>; state: 'active' | 'superseded' | 'revoked' | 'erased';
  revisionSequence: number;
}
export interface MemoryHit { source: SourceRevision; score: number }
export interface CoverageRecord {
  id: string; ownerId: string; accountId: string; scope: string; from: string; to: string;
  sourceGeneration: string; gaps: { reason: string; from?: string; to?: string; sourceId?: string }[];
  complete: boolean; observedAt: string;
}
export interface ProcedureCandidate {
  id: string; ownerId: string; scope: string; hermesMemoryId: string; hermesVersion: string;
  text: string; sourceRefs: string[]; state: 'candidate' | 'disputed' | 'retracted'; updatedAt: string;
}
export interface Invalidation {
  generation: number; ownerId: string; sourceRefs: string[]; derivedRefs: string[];
  reason: 'source_edit' | 'preference_update' | 'stop_using' | 'retract' | 'erase' | 'retention'; at: string;
  /** Host must discard or regenerate any engine transcript containing these references. */
  transcriptInvalidationRequired: true;
}
export interface ContextManifest {
  taskId: string; ownerId: string; generation: number; builtAt: string; tokenCount: number;
  tokenBudget: number; tokenizerId: string; primaryRefs: { ref: string; sha256: string; version: string }[];
  preferenceRefs: { id: string; revision: number }[]; procedureRefs: string[];
  omissions: { ref: string; reason: string }[]; coverage: CoverageRecord[];
  gaps: CoverageRecord['gaps'];
}
export interface ContextRequest {
  access: MemoryAccess; taskId: string; instruction: string; checkpoint?: string;
  recentMessages?: string[]; currentCorrections?: string[]; query?: string; sourceRefs?: string[];
  budgetTokens: number; countTokens: (text: string) => number; tokenizerId: string; limit?: number;
  includeProcedures?: boolean;
}
export interface MemoryPort {
  ingestSource(input: SourceInput): SourceRevision;
  readSource(access: MemoryAccess, ref: string, options?: { historical?: boolean }): SourceRevision | undefined;
  readOriginal(access: MemoryAccess, ref: string): Uint8Array;
  currentSource(access:MemoryAccess,sourceId:string):SourceRevision|undefined;
  query(access: MemoryAccess, query: string, options?: { limit?: number; from?: string; to?: string }): MemoryHit[];
  preferences(access: MemoryAccess): Preference[];
  buildContext(request: ContextRequest): { text: string; manifest: ContextManifest };
  invalidations(ownerId: string, afterGeneration?: number): Invalidation[];
  generation(ownerId: string): number;
}
export interface MemoryStoreOptions {
  databasePath: string; blobDirectory: string; encryptionKey: Uint8Array; clock?: Clock;
  maxSourceBytes?: number;
}
type Row = Record<string, unknown>;
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
function required(value: string, field: string): void { if (!value || value.length > 4096) throw new Error(`Invalid ${field}`); }
function safeAncestors(path: string): void {
  const absolute = resolve(path); let cursor = parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if(existsSync(cursor)){
      const stat=lstatSync(cursor);if(stat.isSymbolicLink())throw new Error('Memory path contains symlink');
      if(stat.isFile() && stat.nlink!==1)throw new Error('Memory path contains hard-linked file');
    }
  }
}
function seal(key: Buffer, value: Uint8Array): Buffer {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([Buffer.from('NMB1'), nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
}
function open(key: Buffer, value: Uint8Array): Buffer {
  const bytes = Buffer.from(value); if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'NMB1') throw new Error('Invalid encrypted memory envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
  decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(16, -16)), decipher.final()]);
}

/** Canonical source/preference store. FTS is process-memory only; private text is never persisted in an index. */
export class PersistentMemoryStore implements MemoryPort {
  private readonly db: DatabaseSync; private readonly index: DatabaseSync; private readonly key: Buffer;
  private readonly blobs: string; private readonly clock?: Clock; private readonly maxBytes: number;
  private closed = false;
  constructor(options: MemoryStoreOptions) {
    if (options.encryptionKey.byteLength !== 32) throw new Error('Memory encryption key must be exactly 32 bytes');
    this.key = Buffer.from(options.encryptionKey); this.clock = options.clock; this.maxBytes = options.maxSourceBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error('Invalid maxSourceBytes');
    const database = resolve(options.databasePath); this.blobs = resolve(options.blobDirectory);
    safeAncestors(database); safeAncestors(this.blobs); mkdirSync(dirname(database), { recursive: true }); mkdirSync(this.blobs, { recursive: true });
    safeAncestors(database); safeAncestors(this.blobs); this.db = new DatabaseSync(database);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(ref TEXT PRIMARY KEY,owner TEXT NOT NULL,account TEXT NOT NULL,scope TEXT NOT NULL,source_id TEXT NOT NULL,version TEXT NOT NULL,event_at TEXT NOT NULL,ingested_at TEXT NOT NULL,hash TEXT NOT NULL,original_hash TEXT NOT NULL,blob TEXT, state TEXT NOT NULL,payload BLOB,UNIQUE(owner,account,source_id,version));
      CREATE INDEX IF NOT EXISTS source_scope ON sources(owner,scope,state,event_at);
      CREATE TABLE IF NOT EXISTS source_tombstones(owner TEXT NOT NULL,account TEXT NOT NULL,source_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(owner,account,source_id));
      CREATE TABLE IF NOT EXISTS preferences(id TEXT NOT NULL,revision INTEGER NOT NULL,owner TEXT NOT NULL,scope TEXT NOT NULL,rule_key TEXT NOT NULL,source_ref TEXT NOT NULL,state TEXT NOT NULL,payload BLOB,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS procedures(id TEXT PRIMARY KEY,owner TEXT NOT NULL,scope TEXT NOT NULL,hermes_id TEXT NOT NULL,hermes_version TEXT NOT NULL,state TEXT NOT NULL,payload BLOB,UNIQUE(owner,hermes_id));
      CREATE TABLE IF NOT EXISTS derivations(id TEXT NOT NULL,kind TEXT NOT NULL,owner TEXT NOT NULL,source_ref TEXT NOT NULL,PRIMARY KEY(id,kind,source_ref));
      CREATE TABLE IF NOT EXISTS coverage(id TEXT PRIMARY KEY,owner TEXT NOT NULL,scope TEXT NOT NULL,payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS invalidations(owner TEXT NOT NULL,generation INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(owner,generation));`);
    const keyCheck = this.db.prepare('SELECT value FROM memory_meta WHERE key=?').get('key-check') as Row | undefined;
    try {
      if (keyCheck) { if (open(this.key, keyCheck.value as Uint8Array).toString() !== 'neurobro-memory-v1') throw new Error('Wrong memory key'); }
      else this.db.prepare('INSERT INTO memory_meta VALUES(?,?)').run('key-check', seal(this.key, Buffer.from('neurobro-memory-v1')));
    } catch(error) { this.db.close(); this.key.fill(0); throw error; }
    this.index = new DatabaseSync(':memory:');
    try {
      this.finishErasures();
      this.index.exec('PRAGMA temp_store=MEMORY; CREATE VIRTUAL TABLE source_fts USING fts5(ref UNINDEXED, text, tokenize="unicode61");');
      // One restart rebuild, never a whole-archive prompt or model call.
      for (const row of this.db.prepare('SELECT ref,payload FROM sources WHERE state=?').all('active') as Row[]) {
        const source = this.decode<SourceRevision>(row.payload); this.index.prepare('INSERT INTO source_fts(ref,text) VALUES(?,?)').run(row.ref as string, source.text);
      }
    } catch(error) { this.index.close();this.db.close();this.key.fill(0);throw error; }
  }
  private now(): string { return (this.clock?.now() ?? new Date()).toISOString(); }
  private encode(value: unknown): Buffer { return seal(this.key, Buffer.from(JSON.stringify(value))); }
  private decode<T>(value: unknown): T { return JSON.parse(open(this.key, value as Uint8Array).toString('utf8')) as T; }
  private transaction<T>(operation: () => T): T {
    if (this.closed) throw new Error('Memory store closed'); this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private permits(access: MemoryAccess, row: Row): boolean {
    return row.owner === access.ownerId && access.scopes.includes(row.scope as string) && (!access.accountId || row.account === access.accountId);
  }
  private sourceRow(ref: string): Row | undefined { return this.db.prepare('SELECT * FROM sources WHERE ref=?').get(ref) as Row | undefined; }
  ingestSource(input: SourceInput): SourceRevision {
    for (const field of ['ownerId','accountId','scope','sourceId','version'] as const) required(input[field], field);
    if (!Number.isFinite(Date.parse(input.eventAt))) throw new Error('Invalid source eventAt');
    if(input.sourceMetadata && Buffer.byteLength(JSON.stringify(input.sourceMetadata))>64*1024)throw new Error('Source metadata exceeds configured 64KiB limit; not truncated');
    if(input.revisionSequence!==undefined && (!Number.isSafeInteger(input.revisionSequence)||input.revisionSequence<0))throw new Error('Invalid source revisionSequence');
    const bytes = input.original ?? Buffer.from(input.text, 'utf8');
    if (bytes.byteLength > this.maxBytes || Buffer.byteLength(input.text) > this.maxBytes) throw new Error('Source exceeds configured byte limit; content was not truncated');
    if (this.db.prepare('SELECT 1 FROM source_tombstones WHERE owner=? AND account=? AND source_id=?').get(input.ownerId,input.accountId,input.sourceId)) throw new Error('Source is tombstoned');
    const old = this.db.prepare('SELECT * FROM sources WHERE owner=? AND account=? AND source_id=? AND version=?').get(input.ownerId,input.accountId,input.sourceId,input.version) as Row | undefined;
    const textHash = hash(input.text), originalHash = hash(bytes);
    if (old) { if(old.state==='erased')throw new Error('Source version was erased');if (old.hash !== textHash || old.original_hash !== originalHash || old.scope !== input.scope || old.event_at !== input.eventAt) throw new Error('Source version conflict'); return {...this.decode<SourceRevision>(old.payload),state:old.state as SourceRevision['state']}; }
    const active=this.db.prepare('SELECT payload FROM sources WHERE owner=? AND account=? AND source_id=? AND state=?').get(input.ownerId,input.accountId,input.sourceId,'active') as Row|undefined;
    if(active && input.revisionSequence===undefined)throw new Error('Unordered source update requires trusted revisionSequence');
    if(active && input.revisionSequence!<=this.decode<SourceRevision>(active.payload).revisionSequence)throw new Error('Stale source revisionSequence; current version preserved');
    const ref = randomUUID(); const source: SourceRevision = { ref,ownerId:input.ownerId,accountId:input.accountId,scope:input.scope,sourceId:input.sourceId,version:input.version,revisionSequence:input.revisionSequence??0,eventAt:input.eventAt,ingestedAt:this.now(),sha256:textHash,originalSha256:originalHash,text:input.text,mimeType:input.mimeType??'text/plain',attribution:input.attribution??'third_party',forwarded:input.forwarded??false,sourceMetadata:input.sourceMetadata,state:'active' };
    const blob = `${ref}.enc`; safeAncestors(this.blobs);
    const file=openSync(join(this.blobs,blob),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
    try{writeFileSync(file,seal(this.key,bytes));fsyncSync(file);}finally{closeSync(file);}
    try { this.transaction(() => {
      const previous = this.db.prepare('SELECT ref FROM sources WHERE owner=? AND account=? AND source_id=? AND state=?').all(input.ownerId,input.accountId,input.sourceId,'active') as Row[];
      if (previous.length) this.invalidate(input.ownerId,previous.map(row=>row.ref as string),'source_edit','superseded');
      this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(ref,input.ownerId,input.accountId,input.scope,input.sourceId,input.version,input.eventAt,source.ingestedAt,textHash,originalHash,blob,'active',this.encode(source));
    }); } catch (error) { unlinkSync(join(this.blobs,blob)); throw error; }
    this.index.prepare('INSERT INTO source_fts(ref,text) VALUES(?,?)').run(ref,input.text); return source;
  }
  readSource(access: MemoryAccess, ref: string, options: {historical?:boolean} = {}): SourceRevision | undefined {
    const row = this.sourceRow(ref); if (!row || !this.permits(access,row) || row.state === 'erased' || (!options.historical && row.state !== 'active')) return undefined;
    return { ...this.decode<SourceRevision>(row.payload), state: row.state as SourceRevision['state'] };
  }
  currentSource(access:MemoryAccess,sourceId:string):SourceRevision|undefined {
    const rows=this.db.prepare('SELECT * FROM sources WHERE owner=? AND source_id=? AND state=?').all(access.ownerId,sourceId,'active') as Row[];
    const permitted=rows.filter(row=>this.permits(access,row));if(permitted.length>1)throw new Error('Current source is ambiguous across accounts; bind accountId');
    return permitted.length?this.readSource(access,permitted[0]!.ref as string):undefined;
  }
  /** Content-free identity remains available to the trusted owner host after erasure. */
  sourceIdentity(ownerId:string,ref:string):{accountId:string;scope:string;sourceId:string;state:SourceRevision['state']}|undefined{
    const row=this.sourceRow(ref);return row?.owner===ownerId?{accountId:row.account as string,scope:row.scope as string,sourceId:row.source_id as string,state:row.state as SourceRevision['state']}:undefined;
  }
  readOriginal(access: MemoryAccess, ref: string): Uint8Array {
    const row = this.sourceRow(ref); if (!row || !this.permits(access,row) || row.state !== 'active' || !row.blob) throw new Error('Original unavailable or outside scope');
    const path = join(this.blobs,row.blob as string); safeAncestors(path);
    if (realpathSync(dirname(path)) !== realpathSync(this.blobs)) throw new Error('Original path escaped archive');
    const bytes = open(this.key,readFileSync(path)); if (hash(bytes) !== row.original_hash) throw new Error('Original hash mismatch'); return bytes;
  }
  query(access: MemoryAccess, query: string, options: {limit?:number;from?:string;to?:string} = {}): MemoryHit[] {
    const limit = options.limit??20; if (!Number.isSafeInteger(limit) || limit<1 || limit>1000) throw new Error('Query limit must be 1..1000');
    const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? []; if (!tokens.length) return [];
    const expression = tokens.map(token=>`"${token}"`).join(' AND ');
    const hits: MemoryHit[] = [];
    // Scope is checked before returning any text, including stale FTS rows after revocation.
    for (const result of this.index.prepare('SELECT ref,bm25(source_fts) AS score FROM source_fts WHERE source_fts MATCH ? ORDER BY score').iterate(expression) as Iterable<Row>) {
      const source = this.readSource(access,result.ref as string);
      if (!source || (options.from && source.eventAt<options.from) || (options.to && source.eventAt>options.to)) continue;
      hits.push({ source, score:Number(result.score) }); if (hits.length===limit) break;
    }
    return hits;
  }
  putPreference(input: {ownerId:string;scope:string;key:string;text:string;sourceRef:string;explicitOwner:boolean;enduring:boolean;expectedRevision?:number}): Preference {
    if (!input.explicitOwner || !input.enduring) throw new Error('Task correction or inferred statement cannot become an enduring preference');
    required(input.key,'preference key'); required(input.text,'preference text');required(input.scope,'preference scope');
    const source = this.sourceRow(input.sourceRef); if (!source || source.owner!==input.ownerId || source.state!=='active') throw new Error('Preference source is unavailable');
    const original = this.decode<SourceRevision>(source.payload);
    if (original.attribution!=='owner_explicit' || original.forwarded) throw new Error('Preference requires an exact explicit owner source');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM preferences WHERE owner=? AND scope=? AND rule_key=? ORDER BY revision DESC LIMIT 1').get(input.ownerId,input.scope,input.key) as Row | undefined;
      const revision = previous ? Number(previous.revision) : 0;
      if ((input.expectedRevision??0)!==revision) throw new Error('Preference revision conflict');
      const at=this.now(); const preference: Preference = {id:previous?.id as string??randomUUID(),ownerId:input.ownerId,scope:input.scope,text:input.text,sourceRef:input.sourceRef,revision:revision+1,createdAt:previous?.payload?this.decode<Preference>(previous.payload).createdAt:at,updatedAt:at};
      if (previous) this.db.prepare('UPDATE preferences SET state=? WHERE id=? AND state=?').run('superseded',previous.id as string,'active');
      this.db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?,?,?,?)').run(preference.id,preference.revision,input.ownerId,input.scope,input.key,input.sourceRef,'active',this.encode(preference));
      this.registerDerived(input.ownerId,`${preference.id}:${preference.revision}`,'preference',[input.sourceRef]);
      this.emitInvalidation(input.ownerId,[input.sourceRef],[], 'preference_update');return preference;
    });
  }
  preferences(access: MemoryAccess): Preference[] {
    return (this.db.prepare('SELECT * FROM preferences WHERE owner=? AND state=? ORDER BY scope,rule_key').all(access.ownerId,'active') as Row[]).filter(row=>access.scopes.includes(row.scope as string)).filter(row=>{const source=this.sourceRow(row.source_ref as string);return source?.state==='active' && (!access.accountId || source.account===access.accountId);}).map(row=>this.decode<Preference>(row.payload));
  }
  mirrorProcedureCandidate(input: Omit<ProcedureCandidate,'id'|'updatedAt'>): ProcedureCandidate {
    required(input.hermesMemoryId,'Hermes memory ID'); required(input.hermesVersion,'Hermes memory version');
    required(input.text,'procedure text');if(input.sourceRefs.length>1000)throw new Error('Procedure source reference limit exceeded');
    if (!input.sourceRefs.length || input.sourceRefs.some(ref=>{ const source=this.sourceRow(ref); return !source || source.owner!==input.ownerId || source.scope!==input.scope || source.state!=='active'; })) throw new Error('Procedure support is unavailable or outside scope');
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM procedures WHERE owner=? AND hermes_id=?').get(input.ownerId,input.hermesMemoryId) as Row|undefined;
      if(old && old.scope!==input.scope)throw new Error('Hermes candidate scope conflict');
      if (old && old.hermes_version===input.hermesVersion) { if(!old.payload)throw new Error('Hermes candidate version was invalidated');const record=this.decode<ProcedureCandidate>(old.payload); if(record.text!==input.text || record.state!==input.state || JSON.stringify(record.sourceRefs)!==JSON.stringify(input.sourceRefs))throw new Error('Hermes candidate version conflict'); return record; }
      const record:ProcedureCandidate={...input,id:old?.id as string??randomUUID(),updatedAt:this.now()};
      this.db.prepare('INSERT OR REPLACE INTO procedures VALUES(?,?,?,?,?,?,?)').run(record.id,input.ownerId,input.scope,input.hermesMemoryId,input.hermesVersion,input.state,this.encode(record));
      this.db.prepare('DELETE FROM derivations WHERE id=? AND kind=?').run(record.id,'procedure');this.registerDerived(input.ownerId,record.id,'procedure',input.sourceRefs);return record;
    });
  }
  procedures(access:MemoryAccess):ProcedureCandidate[] {
    return (this.db.prepare('SELECT * FROM procedures WHERE owner=? AND state IN (?,?)').all(access.ownerId,'candidate','disputed') as Row[]).filter(row=>access.scopes.includes(row.scope as string)).map(row=>this.decode<ProcedureCandidate>(row.payload)).filter(record=>record.sourceRefs.every(ref=>this.readSource(access,ref)));
  }
  registerDerived(ownerId:string,id:string,kind:'artifact'|'transcript'|'summary'|'preference'|'procedure',sourceRefs:string[]):void {
    required(id,'derived ID'); for(const ref of sourceRefs) {const row=this.sourceRow(ref);if(!row || row.owner!==ownerId || row.state!=='active')throw new Error('Derived source is unavailable');}
    for(const ref of sourceRefs)this.db.prepare('INSERT OR IGNORE INTO derivations VALUES(?,?,?,?)').run(id,kind,ownerId,ref);
  }
  recordCoverage(input:Omit<CoverageRecord,'id'|'observedAt'>):CoverageRecord {
    if(!Number.isFinite(Date.parse(input.from)) || !Number.isFinite(Date.parse(input.to)) || input.from>input.to)throw new Error('Invalid coverage range');
    if(input.complete && input.gaps.length)throw new Error('Coverage with gaps cannot be complete');
    const record={...input,id:randomUUID(),observedAt:this.now()};this.db.prepare('INSERT INTO coverage VALUES(?,?,?,?)').run(record.id,input.ownerId,input.scope,this.encode(record));return record;
  }
  coverage(access:MemoryAccess):CoverageRecord[]{return(this.db.prepare('SELECT * FROM coverage WHERE owner=?').all(access.ownerId) as Row[]).filter(row=>access.scopes.includes(row.scope as string)).map(row=>this.decode<CoverageRecord>(row.payload)).filter(row=>!access.accountId || row.accountId===access.accountId);}
  generation(ownerId:string):number{return Number((this.db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM invalidations WHERE owner=?').get(ownerId) as Row).n);}
  invalidations(ownerId:string,afterGeneration=0):Invalidation[]{return(this.db.prepare('SELECT payload FROM invalidations WHERE owner=? AND generation>? ORDER BY generation').all(ownerId,afterGeneration) as Row[]).map(row=>this.decode<Invalidation>(row.payload));}
  private invalidate(ownerId:string,refs:string[],reason:Invalidation['reason'],state:SourceRevision['state']):Invalidation {
    const derived = new Set<string>();
    for(const ref of refs){
      for(const row of this.db.prepare('SELECT id,kind FROM derivations WHERE owner=? AND source_ref=?').all(ownerId,ref) as Row[]){
        derived.add(`${row.kind}:${row.id}`);
        if(row.kind==='procedure')this.db.prepare('UPDATE procedures SET state=?,payload=NULL WHERE id=?').run('retracted',row.id as string);
        if(row.kind==='preference')this.db.prepare('UPDATE preferences SET state=?,payload=NULL WHERE source_ref=?').run('revoked',ref);
      }
      this.db.prepare('UPDATE sources SET state=? WHERE ref=?').run(state,ref); this.index.prepare('DELETE FROM source_fts WHERE ref=?').run(ref);
    }
    return this.emitInvalidation(ownerId,refs,[...derived],reason);
  }
  private emitInvalidation(ownerId:string,refs:string[],derivedRefs:string[],reason:Invalidation['reason']):Invalidation {
    const invalidation:Invalidation={generation:this.generation(ownerId)+1,ownerId,sourceRefs:refs,derivedRefs,reason,at:this.now(),transcriptInvalidationRequired:true};
    this.db.prepare('INSERT INTO invalidations VALUES(?,?,?)').run(ownerId,invalidation.generation,this.encode(invalidation));return invalidation;
  }
  private finishErasures():void {
    const rows=this.db.prepare('SELECT ref,blob FROM sources WHERE state=? AND blob IS NOT NULL').all('erased') as Row[];
    for(const row of rows){const path=join(this.blobs,row.blob as string);safeAncestors(path);if(existsSync(path))unlinkSync(path);this.db.prepare('UPDATE sources SET blob=NULL WHERE ref=?').run(row.ref as string);}
    if(rows.length)this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
  }
  private withdrawCoverage(ownerId:string,related:Row[],reason:string):void {
    for(const coverageRow of this.db.prepare('SELECT * FROM coverage WHERE owner=?').all(ownerId) as Row[]){
      const record=this.decode<CoverageRecord>(coverageRow.payload);
      const affected=related.filter(source=>source.account===record.accountId && source.scope===record.scope && (source.event_at as string)>=record.from && (source.event_at as string)<=record.to);
      if(!affected.length)continue;
      const sourceIds=new Set(affected.map(source=>source.source_id as string));
      record.gaps=record.gaps.filter(gap=>!gap.sourceId || !sourceIds.has(gap.sourceId));
      for(const sourceId of sourceIds)record.gaps.push({reason,sourceId});record.complete=false;record.observedAt=this.now();
      this.db.prepare('UPDATE coverage SET payload=? WHERE id=?').run(this.encode(record),record.id);
    }
  }
  forget(access:MemoryAccess,ref:string,mode:'stop_using'|'retract'|'erase'='stop_using'):Invalidation {
    const row=this.sourceRow(ref);if(!row || !this.permits(access,row))throw new Error('Forget target is unavailable or outside scope');
    const related=this.db.prepare('SELECT * FROM sources WHERE owner=? AND account=? AND source_id=?').all(row.owner as string,row.account as string,row.source_id as string) as Row[];
    const event=this.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO source_tombstones VALUES(?,?,?,?)').run(row.owner as string,row.account as string,row.source_id as string,this.now());
      const event=this.invalidate(access.ownerId,related.map(source=>source.ref as string),mode,mode==='erase'?'erased':'revoked');
      if(mode==='erase')for(const source of related)this.db.prepare('UPDATE sources SET payload=NULL WHERE ref=?').run(source.ref as string);
      this.withdrawCoverage(access.ownerId,related,mode==='erase'?'Source erased by owner':'Source withdrawn from use');
      return event;
    });
    if(mode==='erase')this.finishErasures();
    return event;
  }
  expireBefore(access:MemoryAccess,cutoff:string):Invalidation[] {
    if(!Number.isFinite(Date.parse(cutoff)))throw new Error('Invalid retention cutoff');
    const refs=(this.db.prepare('SELECT * FROM sources WHERE owner=? AND event_at<? AND state<>?').all(access.ownerId,cutoff,'erased') as Row[]).filter(row=>this.permits(access,row)).map(row=>row.ref as string);
    const seen=new Set<string>(),events:Invalidation[]=[];
    for(const ref of refs){
      const row=this.sourceRow(ref)!;const key=JSON.stringify([row.account,row.source_id]);if(seen.has(key))continue;seen.add(key);
      const related=this.db.prepare('SELECT * FROM sources WHERE owner=? AND account=? AND source_id=? AND state<>?').all(row.owner as string,row.account as string,row.source_id as string,'erased') as Row[];
      if(related.every(source=>(source.event_at as string)<cutoff))events.push(this.forget(access,ref,'erase'));
      else{
        const expired=related.filter(source=>this.permits(access,source)&&(source.event_at as string)<cutoff).map(source=>source.ref as string);
        events.push(this.transaction(()=>{const event=this.invalidate(access.ownerId,expired,'retention','erased');for(const sourceRef of expired)this.db.prepare('UPDATE sources SET payload=NULL WHERE ref=?').run(sourceRef);this.withdrawCoverage(access.ownerId,related.filter(source=>expired.includes(source.ref as string)),'Source erased by retention');return event;}));
        this.finishErasures();
      }
    }return events;
  }
  buildContext(request:ContextRequest):{text:string;manifest:ContextManifest} {
    if(!Number.isSafeInteger(request.budgetTokens)||request.budgetTokens<1)throw new Error('Invalid context token budget');required(request.tokenizerId,'tokenizer ID');
    const count=(text:string)=>{const n=request.countTokens(text);if(!Number.isSafeInteger(n)||n<0)throw new Error('Tokenizer returned invalid token count');return n;};
    let text=`[CURRENT TASK ${request.taskId}]\n${request.instruction}`;
    if(request.checkpoint)text+=`\n[CHECKPOINT]\n${request.checkpoint}`;
    for(const correction of request.currentCorrections??[])text+=`\n[CURRENT TASK CORRECTION]\n${correction}`;
    if(count(text)>request.budgetTokens)throw new Error('Mandatory current instruction/correction exceeds context budget');
    const manifest:ContextManifest={taskId:request.taskId,ownerId:request.access.ownerId,generation:this.generation(request.access.ownerId),builtAt:this.now(),tokenCount:0,tokenBudget:request.budgetTokens,tokenizerId:request.tokenizerId,primaryRefs:[],preferenceRefs:[],procedureRefs:[],omissions:[],coverage:this.coverage(request.access),gaps:[]};
    manifest.gaps=manifest.coverage.flatMap(item=>item.gaps);if(!manifest.coverage.length)manifest.gaps.push({reason:'Coverage has not been recorded; search hits do not prove completeness'});
    const add=(ref:string,section:string,onAdded?:()=>void)=>{const candidate=`${text}\n${section}`;if(count(candidate)>request.budgetTokens)manifest.omissions.push({ref,reason:'whole_item_exceeds_remaining_token_budget'});else{text=candidate;onAdded?.();}};
    for(const preference of this.preferences(request.access))add(`preference:${preference.id}:${preference.revision}`,`[SCOPED OWNER PREFERENCE ${preference.scope} source=${preference.sourceRef}]\n${preference.text}`,()=>manifest.preferenceRefs.push({id:preference.id,revision:preference.revision}));
    for(const [i,message]of(request.recentMessages??[]).entries())add(`recent:${i}`,`[RECENT TASK DIALOGUE]\n${message}`);
    const sources=new Map<string,SourceRevision>();
    for(const ref of request.sourceRefs??[]){const source=this.readSource(request.access,ref);if(source)sources.set(ref,source);else manifest.omissions.push({ref,reason:'unavailable_revoked_or_outside_scope'});}
    if(request.query)for(const hit of this.query(request.access,request.query,{limit:request.limit??20}))sources.set(hit.source.ref,hit.source);
    for(const source of sources.values())add(source.ref,`[UNTRUSTED PRIMARY SOURCE ref=${source.ref} version=${source.version} scope=${source.scope} date=${source.eventAt}]\n${source.text}`,()=>manifest.primaryRefs.push({ref:source.ref,sha256:source.sha256,version:source.version}));
    if(request.includeProcedures)for(const procedure of this.procedures(request.access))add(`procedure:${procedure.id}`,`[HERMES PROCEDURE ${procedure.state}; SUPPORT ${procedure.sourceRefs.join(',')}; NO AUTHORITY]\n${procedure.text}`,()=>manifest.procedureRefs.push(procedure.id));
    for(const gap of manifest.gaps)add('coverage-gap',`[COVERAGE GAP] ${JSON.stringify(gap)}`);
    manifest.tokenCount=count(text); this.registerDerived(request.access.ownerId,`${request.taskId}:${randomUUID()}`,'transcript',manifest.primaryRefs.map(ref=>ref.ref));
    return {text,manifest};
  }
  assertCurrent(manifest:ContextManifest):void{if(this.generation(manifest.ownerId)!==manifest.generation)throw new Error('Context was invalidated; rebuild context and engine transcript before reuse');for(const ref of manifest.primaryRefs){const row=this.sourceRow(ref.ref);if(!row||row.state!=='active'||row.hash!==ref.sha256)throw new Error('Context source became unavailable');}}
  close():void{if(!this.closed){this.closed=true;this.index.close();this.db.close();this.key.fill(0);}}
}
