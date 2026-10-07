import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactRecord, Clock } from '../contracts.ts';
import type { ArtifactPort, ArtifactScope } from '../artifacts/index.ts';
import { directory, safePath } from '../artifacts/paths.ts';

/** Reserved scope is never exposed as a task to the cognition engine. */
const libraryTask = '__personal_document_library_v1__';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sourceRef = (versionId: string) => `document-version:${versionId}`;
function identifier(value: string, label: string): void {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error(`Invalid document ${label}`);
}
function opaque(value: string): void { if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid document/version ID'); }
function label(value: string): void { identifier(value, 'label'); if (value.length > 180 || value !== value.trim()) throw new Error('Invalid document label'); }
export interface DocumentRecord {
  id: string; ownerId: string; name: string; currentVersionId: string; createdAt: string; updatedAt: string;
}
export interface DocumentVersion {
  id: string; documentId: string; ownerId: string; ordinal: number; label: string; artifact: ArtifactRecord;
  admittedAt: string; ownerIntentSourceRef: string;
  original: { taskId: string; artifactId: string; sha256: string; sourceRef?: string };
}
/** Only the trusted host may construct this receipt after checking explicit current owner intent. */
export interface DocumentAuthority extends ArtifactScope { sourceRef: string }
export interface DocumentLibraryOptions {
  databasePath: string; encryptionKey: Uint8Array; artifacts: ArtifactPort; clock?: Clock;
}
export interface SaveDocumentRequest {
  artifactId: string; name: string; versionLabel: string; documentId?: string; expectedCurrentVersionId?: string;
}
export interface DocumentImport { document: DocumentRecord; version: DocumentVersion; artifact: ArtifactRecord }
type Row = { id: string; owner_id: string; state: string; payload: Uint8Array };

/** Owner-global encrypted catalog; original bytes use the existing authenticated immutable artifact vault.
 * One trusted local process owns catalog and vault. Imports pin a version/hash, never a mutable alias.
 * No document contents confer authority, grants, recipients, or permission to send.
 */
export class DocumentLibrary {
  private readonly db: DatabaseSync; private readonly key: Buffer; private readonly options: DocumentLibraryOptions;
  private readonly path: string; private closed = false;
  constructor(options: DocumentLibraryOptions) {
    if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw new Error('Document encryption key must contain 32 bytes');
    this.options = options; this.key = Buffer.from(options.encryptionKey); this.path = resolve(options.databasePath);
    directory(dirname(this.path)); this.paths(); this.db = new DatabaseSync(this.path); chmodSync(this.path, 0o600);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS document_meta(key TEXT PRIMARY KEY,payload BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,state TEXT NOT NULL,payload BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS document_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),owner_id TEXT NOT NULL,ordinal INTEGER NOT NULL,state TEXT NOT NULL,payload BLOB NOT NULL,UNIQUE(document_id,ordinal));
        CREATE TABLE IF NOT EXISTS document_cleanup(version_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,erase INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS document_admissions(version_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS document_generations(owner_id TEXT PRIMARY KEY,generation INTEGER NOT NULL);`);
      const check = this.db.prepare('SELECT payload FROM document_meta WHERE key=?').get('key-check') as {payload: Uint8Array} | undefined;
      if (check) { if (this.decode<string>(check.payload, 'key-check') !== 'document-library-v1') throw new Error('Wrong document library key'); }
      else this.db.prepare('INSERT INTO document_meta VALUES(?,?)').run('key-check', this.encode('document-library-v1', 'key-check'));
      this.finishCleanup(); this.finishAdmissions();
    } catch (error) { this.db.close(); this.key.fill(0); throw error; }
  }
  private paths(): void { for (const suffix of ['', '-wal', '-shm', '-journal']) safePath(this.path + suffix, 'file'); }
  private ready(): void { if (this.closed) throw new Error('Document library closed'); this.paths(); }
  private now(): string { return (this.options.clock?.now() ?? new Date()).toISOString(); }
  private encode(value: unknown, aad: string): Buffer {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce); cipher.setAAD(Buffer.from(aad));
    return Buffer.concat([nonce, cipher.update(Buffer.from(JSON.stringify(value))), cipher.final(), cipher.getAuthTag()]);
  }
  private decode<T>(value: Uint8Array, aad: string): T {
    const bytes = Buffer.from(value); if (bytes.length < 28) throw new Error('Invalid document ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0,12)); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)), decipher.final()]).toString('utf8')) as T;
  }
  private tx<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE'); try { const value=operation(); this.db.exec('COMMIT'); return value; } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private authority(authority: DocumentAuthority): void {
    identifier(authority.ownerId,'owner'); identifier(authority.taskId,'task'); identifier(authority.sourceRef,'owner intent source');
    if (authority.taskId === libraryTask) throw new Error('Document library cannot be an authorized task');
  }
  private aad(kind: string, owner: string, id: string): string { return JSON.stringify([kind,owner,id]); }
  private document(ownerId: string, id: string): DocumentRecord {
    identifier(ownerId,'owner'); opaque(id);
    const row=this.db.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(id,ownerId) as Row | undefined;
    if(!row || row.state!=='active') throw new Error('Document absent or revoked in owner scope');
    return this.decode<DocumentRecord>(row.payload,this.aad('document',ownerId,id));
  }
  get(ownerId: string, id: string): DocumentRecord { this.ready(); return this.document(ownerId,id); }
  list(ownerId: string): DocumentRecord[] {
    this.ready(); identifier(ownerId,'owner');
    const rows=this.db.prepare("SELECT * FROM documents WHERE owner_id=? AND state='active' ORDER BY rowid").all(ownerId) as Row[];
    return rows.map(row=>this.decode<DocumentRecord>(row.payload,this.aad('document',ownerId,row.id)));
  }
  version(ownerId: string, documentId: string, versionId?: string): DocumentVersion {
    this.ready(); const doc=this.document(ownerId,documentId), id=versionId??doc.currentVersionId; opaque(id);
    const row=this.db.prepare('SELECT * FROM document_versions WHERE id=? AND document_id=? AND owner_id=?').get(id,documentId,ownerId) as Row | undefined;
    if(!row || row.state!=='active') throw new Error('Document version absent or revoked in owner scope');
    const version=this.decode<DocumentVersion>(row.payload,this.aad('version',ownerId,id));
    this.options.artifacts.get({ownerId,taskId:libraryTask},version.artifact.id); return version;
  }
  versions(ownerId: string, documentId: string): DocumentVersion[] {
    return this.versionIndex(ownerId,documentId).versions;
  }
  versionIndex(ownerId:string,documentId:string):{versions:DocumentVersion[];gaps:{versionId:string;reason:string}[]} {
    this.ready(); this.document(ownerId,documentId);
    const rows=this.db.prepare("SELECT id FROM document_versions WHERE document_id=? AND owner_id=? AND state='active' ORDER BY ordinal").all(documentId,ownerId) as {id:string}[];
    const versions:DocumentVersion[]=[],gaps:{versionId:string;reason:string}[]=[];
    for(const row of rows){try{versions.push(this.version(ownerId,documentId,row.id));}catch(error){
      if(error instanceof Error && error.message==='artifact has been revoked')gaps.push({versionId:row.id,reason:'Original revoked through its source/task or document ancestry; no automatic fallback'});
      else throw error;
    }}return{versions,gaps};
  }
  save(authority: DocumentAuthority, request: SaveDocumentRequest): {document:DocumentRecord;version:DocumentVersion} {
    this.ready(); this.authority(authority); label(request.name); label(request.versionLabel);
    if(!request.documentId && request.expectedCurrentVersionId) throw new Error('Unexpected document current version precondition');
    const prior=request.documentId?this.document(authority.ownerId,request.documentId):undefined;
    if(prior && prior.currentVersionId!==request.expectedCurrentVersionId) throw new Error('Document current version changed; reread before saving');
    const original=this.options.artifacts.get(authority,request.artifactId), bytes=this.options.artifacts.read(authority,request.artifactId);
    const documentId=prior?.id??randomUUID(), versionId=randomUUID(), at=this.now();
    const ordinal=(this.db.prepare('SELECT MAX(ordinal) AS n FROM document_versions WHERE document_id=?').get(documentId) as {n:number|null}).n??0;
    // Durable intent precedes the separate vault commit, so crashes cannot strand private originals.
    this.db.prepare('INSERT INTO document_admissions VALUES(?,?)').run(versionId,authority.ownerId);
    const artifact=this.options.artifacts.copyIntoTask(authority,original.id,{ownerId:authority.ownerId,taskId:libraryTask},{sourceRef:sourceRef(versionId)});
    const version:DocumentVersion={id:versionId,documentId,ownerId:authority.ownerId,ordinal:ordinal+1,label:request.versionLabel,artifact,admittedAt:at,ownerIntentSourceRef:authority.sourceRef,
      original:{taskId:original.taskId,artifactId:original.id,sha256:original.sha256,...(original.sourceRef?{sourceRef:original.sourceRef}:{})}};
    const document:DocumentRecord={id:documentId,ownerId:authority.ownerId,name:request.name,currentVersionId:versionId,createdAt:prior?.createdAt??at,updatedAt:at};
    try { this.tx(()=>{
      this.db.prepare('INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(documentId,authority.ownerId,'active',this.encode(document,this.aad('document',authority.ownerId,documentId)));
      this.db.prepare('INSERT INTO document_versions VALUES(?,?,?,?,?,?)').run(versionId,documentId,authority.ownerId,ordinal+1,'active',this.encode(version,this.aad('version',authority.ownerId,versionId)));
      this.db.prepare('DELETE FROM document_admissions WHERE version_id=?').run(versionId);
      this.bump(authority.ownerId);
    }); } catch(error) { this.finishAdmissions(); throw error; }
    return {document,version};
  }
  selectCurrent(authority: DocumentAuthority, documentId: string, versionId: string, expectedCurrentVersionId: string): DocumentRecord {
    this.ready(); this.authority(authority); const doc=this.document(authority.ownerId,documentId); this.version(authority.ownerId,documentId,versionId);
    if(doc.currentVersionId!==expectedCurrentVersionId) throw new Error('Document current version changed; reread before selecting');
    doc.currentVersionId=versionId;doc.updatedAt=this.now();this.tx(()=>{this.db.prepare('UPDATE documents SET payload=? WHERE id=?').run(this.encode(doc,this.aad('document',authority.ownerId,doc.id)),doc.id);this.bump(authority.ownerId);});return doc;
  }
  importIntoTask(authority: DocumentAuthority, documentId: string, versionId?: string): DocumentImport {
    this.ready(); this.authority(authority); const document=this.document(authority.ownerId,documentId),version=this.version(authority.ownerId,documentId,versionId);
    const bytes=this.options.artifacts.read({ownerId:authority.ownerId,taskId:libraryTask},version.artifact.id);
    if(createHash('sha256').update(bytes).digest('hex')!==version.artifact.sha256) throw new Error('Document original hash mismatch');
    // Source marker is also the durable revocation edge; imports recover without a cross-database receipt.
    const existing=this.options.artifacts.list(authority).filter(item=>item.sourceRef===sourceRef(version.id)&&!item.parentId&&item.sha256===version.artifact.sha256&&item.size===version.artifact.size
      &&this.options.artifacts.dependencies(authority,item.id).some(source=>source.id===version.artifact.id));
    if(existing.length>1) throw new Error('Ambiguous document import; no duplicate admission');
    const artifact=existing[0]??this.options.artifacts.copyIntoTask({ownerId:authority.ownerId,taskId:libraryTask},version.artifact.id,authority,{sourceRef:sourceRef(version.id)});
    if(artifact.sha256!==version.artifact.sha256 || artifact.size!==version.artifact.size) throw new Error('Imported document hash mismatch');
    return {document,version,artifact};
  }
  invalidate(authority: DocumentAuthority, documentId: string, options: {versionId?:string;erase?:boolean}={}): {versionIds:string[];generation:number} {
    this.ready(); this.authority(authority); opaque(documentId); if(options.versionId)opaque(options.versionId);
    // Repeated cleanup retries are valid after access is durably removed; no tombstone resurrection.
    const docRow=this.db.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(documentId,authority.ownerId) as Row|undefined;
    if(!docRow)throw new Error('Document absent in owner scope');
    const rows=this.db.prepare('SELECT id FROM document_versions WHERE document_id=? AND owner_id=?'+(options.versionId?' AND id=?':'')).all(documentId,authority.ownerId,...(options.versionId?[options.versionId]:[])) as {id:string}[];
    if(options.versionId && !rows.length)throw new Error('Document version absent in owner scope');
    this.tx(()=>{
      for(const row of rows){this.db.prepare('UPDATE document_versions SET state=? WHERE id=?').run(options.erase?'erased':'revoked',row.id);this.db.prepare('INSERT INTO document_cleanup VALUES(?,?,?) ON CONFLICT(version_id) DO UPDATE SET erase=MAX(erase,excluded.erase)').run(row.id,authority.ownerId,options.erase?1:0);}
      if(!options.versionId)this.db.prepare('UPDATE documents SET state=? WHERE id=?').run(options.erase?'erased':'revoked',documentId);
      this.bump(authority.ownerId);
    });this.finishCleanup();
    if(options.erase){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');}
    return{versionIds:rows.map(row=>row.id),generation:this.generation(authority.ownerId)};
  }
  private finishCleanup(): void {
    const rows=this.db.prepare('SELECT * FROM document_cleanup').all() as {version_id:string;owner_id:string;erase:number}[];
    for(const row of rows){const selector={ownerId:row.owner_id,sourceRef:sourceRef(row.version_id)};
      if(row.erase)this.options.artifacts.erase(selector);else this.options.artifacts.revoke(selector);
      if(row.erase)this.db.prepare('UPDATE document_versions SET payload=? WHERE id=?').run(this.encode({erased:true},this.aad('version',row.owner_id,row.version_id)),row.version_id);
      this.db.prepare('DELETE FROM document_cleanup WHERE version_id=?').run(row.version_id);
    }
    // Redact document labels once the whole catalog entry is erased.
    const erased=this.db.prepare("SELECT id,owner_id FROM documents WHERE state='erased'").all() as {id:string;owner_id:string}[];
    for(const doc of erased)this.db.prepare('UPDATE documents SET payload=? WHERE id=?').run(this.encode({erased:true},this.aad('document',doc.owner_id,doc.id)),doc.id);
    if(rows.some(row=>row.erase) || erased.length)this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  }
  private finishAdmissions():void {
    const pending=this.db.prepare('SELECT * FROM document_admissions').all() as {version_id:string;owner_id:string}[];
    for(const row of pending){this.options.artifacts.erase({ownerId:row.owner_id,sourceRef:sourceRef(row.version_id)});this.db.prepare('DELETE FROM document_admissions WHERE version_id=?').run(row.version_id);}
  }
  private bump(ownerId:string):void{this.db.prepare('INSERT INTO document_generations VALUES(?,1) ON CONFLICT(owner_id) DO UPDATE SET generation=generation+1').run(ownerId);}
  generation(ownerId:string):number{this.ready();identifier(ownerId,'owner');return(this.db.prepare('SELECT generation FROM document_generations WHERE owner_id=?').get(ownerId) as {generation:number}|undefined)?.generation??0;}
  dispose():void{if(this.closed)return;this.db.close();this.key.fill(0);this.closed=true;}
}
