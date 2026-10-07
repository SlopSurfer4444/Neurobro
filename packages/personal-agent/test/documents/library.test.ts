import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { DocumentLibrary } from '../../src/documents/index.ts';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'neurobro-documents-')),key=Buffer.alloc(32,7),scope={ownerId:'owner',taskId:'task-1'},authority={...scope,sourceRef:'explicit-owner-intent'};
  const artifacts=new ArtifactStore({rootPath:join(root,'vault'),encryptionKey:key}),options={databasePath:join(root,'catalog.sqlite'),encryptionKey:key,artifacts};
  let library=new DocumentLibrary(options);
  const resume=(text='Resume version 1')=>artifacts.put({...scope,name:'resume.txt',bytes:Buffer.from(text)});
  return {root,key,scope,authority,artifacts,options,resume,get library(){return library;},reopen(){library.dispose();library=new DocumentLibrary(options);},cleanup(){library.dispose();artifacts.dispose();rmSync(root,{recursive:true,force:true});}};
}
test('owner document versions survive cold reopen; current selection uses exact precondition and imports pin bytes',()=>{
  const f=fixture();try{
    const original=f.resume(),v1=f.library.save(f.authority,{artifactId:original.id,name:'My resume',versionLabel:'initial'});
    const first=f.library.importIntoTask({...f.authority,taskId:'batch-1'},v1.document.id);
    const newer=f.resume('Resume version 2'),v2=f.library.save(f.authority,{artifactId:newer.id,name:'My resume',versionLabel:'revised',documentId:v1.document.id,expectedCurrentVersionId:v1.version.id});
    assert.equal(v2.version.ordinal,2);assert.notEqual(v2.version.artifact.id,original.id);assert.equal(v2.version.original.sha256,newer.sha256);
    assert.throws(()=>f.library.save(f.authority,{artifactId:newer.id,name:'resume',versionLabel:'stale',documentId:v1.document.id,expectedCurrentVersionId:v1.version.id}),/changed/);
    f.reopen();assert.equal(f.library.get('owner',v1.document.id).currentVersionId,v2.version.id);assert.equal(f.library.versions('owner',v1.document.id).length,2);
    assert.equal(f.artifacts.read({ownerId:'owner',taskId:'batch-1'},first.artifact.id).toString(),'Resume version 1');
    const current=f.library.importIntoTask({...f.authority,taskId:'batch-2'},v1.document.id);assert.equal(current.version.id,v2.version.id);assert.equal(f.artifacts.read({ownerId:'owner',taskId:'batch-2'},current.artifact.id).toString(),'Resume version 2');
    assert.equal(f.library.importIntoTask({...f.authority,taskId:'batch-2'},v1.document.id).artifact.id,current.artifact.id);
    assert.throws(()=>f.library.selectCurrent(f.authority,v1.document.id,v1.version.id,v1.version.id),/changed/);
    assert.equal(f.library.selectCurrent(f.authority,v1.document.id,v1.version.id,v2.version.id).currentVersionId,v1.version.id);
    assert.equal(f.artifacts.read(f.scope,original.id).toString(),'Resume version 1');
  }finally{f.cleanup();}
});
test('cross-owner and cross-task IDs cannot admit/read/select/revoke documents; labels are encrypted',()=>{
  const f=fixture();try{
    const original=f.resume(),saved=f.library.save(f.authority,{artifactId:original.id,name:'PRIVATE RESUME LABEL 984',versionLabel:'PRIVATE VERSION LABEL 847'});
    const other={ownerId:'other-owner',taskId:'task-1',sourceRef:'other-owner-intent'};
    assert.deepEqual(f.library.list(other.ownerId),[]);
    assert.throws(()=>f.library.get(other.ownerId,saved.document.id),/owner scope/);
    assert.throws(()=>f.library.version(other.ownerId,saved.document.id,saved.version.id),/owner scope/);
    assert.throws(()=>f.library.importIntoTask(other,saved.document.id),/owner scope/);
    assert.throws(()=>f.library.invalidate(other,saved.document.id),/owner scope/);
    assert.throws(()=>f.library.save(other,{artifactId:original.id,name:'forged',versionLabel:'one'}),/scope/);
    assert.throws(()=>f.library.save({...f.authority,taskId:'wrong-task'},{artifactId:original.id,name:'forged',versionLabel:'one'}),/scope/);
    assert.throws(()=>f.library.save({...f.authority,sourceRef:''},{artifactId:original.id,name:'bad',versionLabel:'one'}),/intent source/);
    for(const suffix of ['','-wal'])if(existsSync(f.options.databasePath+suffix)){const bytes=readFileSync(f.options.databasePath+suffix);assert.equal(bytes.includes(Buffer.from('PRIVATE RESUME LABEL 984')),false);assert.equal(bytes.includes(Buffer.from('PRIVATE VERSION LABEL 847')),false);}
    assert.throws(()=>new DocumentLibrary({...f.options,encryptionKey:Buffer.alloc(32,3)}));
  }finally{f.cleanup();}
});
test('revoking a version invalidates imported copies, derived outputs and stages without switching current',()=>{
  const f=fixture();try{
    const original=f.resume(),saved=f.library.save(f.authority,{artifactId:original.id,name:'resume',versionLabel:'one'}),batch={...f.authority,taskId:'outreach-task'};
    const imported=f.library.importIntoTask(batch,saved.document.id),stage=f.artifacts.stageTask(batch,[imported.artifact.id]);
    writeFileSync(join(stage.outputsPath,'edited.txt'),'derived resume');const derived=f.artifacts.putOutput({ownerId:batch.ownerId,taskId:batch.taskId},stage.id,'edited.txt');
    assert.equal(f.library.importIntoTask(batch,saved.document.id).artifact.id,imported.artifact.id);
    const result=f.library.invalidate(f.authority,saved.document.id,{versionId:saved.version.id});assert.deepEqual(result.versionIds,[saved.version.id]);
    assert.throws(()=>f.library.importIntoTask(batch,saved.document.id),/revoked/);
    assert.throws(()=>f.artifacts.read(batch,imported.artifact.id),/revoked/);assert.throws(()=>f.artifacts.read(batch,derived.id),/revoked/);assert.throws(()=>f.artifacts.getStage(batch,stage.id),/revoked/);
    assert.equal(existsSync(stage.inputsPath),false);assert.equal(f.library.get('owner',saved.document.id).currentVersionId,saved.version.id);
    assert.equal(f.artifacts.read(f.scope,original.id).toString(),'Resume version 1');f.reopen();assert.throws(()=>f.library.version('owner',saved.document.id),/revoked/);
  }finally{f.cleanup();}
});
test('erasing document deletes vault originals and all imports; cold tombstones prohibit resurrection',()=>{
  const f=fixture();try{
    const saved=f.library.save(f.authority,{artifactId:f.resume().id,name:'Private',versionLabel:'v1'}),batch={...f.authority,taskId:'batch'};
    const imported=f.library.importIntoTask(batch,saved.document.id);f.library.invalidate(f.authority,saved.document.id,{erase:true});
    for(const id of [saved.version.artifact.id,imported.artifact.id])assert.equal(existsSync(join(f.artifacts.rootPath,'originals',id+'.aes')),false);
    assert.deepEqual(f.library.list('owner'),[]);f.reopen();assert.throws(()=>f.library.importIntoTask(batch,saved.document.id),/revoked/);
    assert.throws(()=>f.library.save(f.authority,{artifactId:f.resume().id,name:'Private',versionLabel:'v2',documentId:saved.document.id,expectedCurrentVersionId:saved.version.id}),/revoked/);
    f.library.invalidate(f.authority,saved.document.id,{erase:true});
  }finally{f.cleanup();}
});
test('wrong document version cannot be selected/imported and original ciphertext corruption fails before import',()=>{
  const f=fixture();try{
    const one=f.library.save(f.authority,{artifactId:f.resume().id,name:'one',versionLabel:'v1'}),two=f.library.save(f.authority,{artifactId:f.resume('other').id,name:'two',versionLabel:'v1'});
    assert.throws(()=>f.library.selectCurrent(f.authority,one.document.id,two.version.id,one.version.id),/version absent/);
    assert.throws(()=>f.library.importIntoTask(f.authority,one.document.id,two.version.id),/version absent/);
    const blob=join(f.artifacts.rootPath,'originals',one.version.artifact.id+'.aes'),bytes=readFileSync(blob);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;chmodSync(blob,0o600);writeFileSync(blob,bytes);
    assert.throws(()=>f.library.importIntoTask({...f.authority,taskId:'batch'},one.document.id));assert.deepEqual(f.artifacts.list({ownerId:'owner',taskId:'batch'}),[]);
  }finally{f.cleanup();}
});
test('re-saved edited documents retain cross-task revocation ancestry across cold reopen and later imports',()=>{
  for(const erase of [false,true]){const f=fixture();try{
    const saved=f.library.save(f.authority,{artifactId:f.resume().id,name:'resume',versionLabel:'one'}),editing={ownerId:'owner',taskId:'editing'},editingAuthority={...editing,sourceRef:'explicit-resume-update'};
    const imported=f.library.importIntoTask(editingAuthority,saved.document.id),stage=f.artifacts.stageTask(editing,[imported.artifact.id]);writeFileSync(join(stage.outputsPath,'update.txt'),'Edited private resume');const output=f.artifacts.putOutput(editing,stage.id,'update.txt');
    const updated=f.library.save(editingAuthority,{artifactId:output.id,name:'Updated resume',versionLabel:'two'}),future={ownerId:'owner',taskId:'future-batch'},later=f.library.importIntoTask({...future,sourceRef:'explicit-batch'},updated.document.id);
    assert.equal(f.artifacts.read(future,later.artifact.id).toString(),'Edited private resume');f.library.invalidate(f.authority,saved.document.id,{erase});f.reopen();
    assert.throws(()=>f.library.importIntoTask({...future,sourceRef:'explicit-batch'},updated.document.id),/revoked/);assert.throws(()=>f.artifacts.read(future,later.artifact.id),/revoked/);
    if(erase)for(const id of [saved.version.artifact.id,updated.version.artifact.id,later.artifact.id])assert.equal(existsSync(join(f.artifacts.rootPath,'originals',id+'.aes')),false);
  }finally{f.cleanup();}}
});
test('original source revocation cascades owner-global copies and cross-task imports, never another owner',()=>{
  const f=fixture();try{
    const original=f.artifacts.put({...f.scope,name:'source.txt',bytes:Buffer.from('private'),sourceRef:'original-message'}),saved=f.library.save(f.authority,{artifactId:original.id,name:'resume',versionLabel:'one'}),batch={ownerId:'owner',taskId:'batch'},copy=f.library.importIntoTask({...batch,sourceRef:'explicit-batch'},saved.document.id);
    const other=f.artifacts.put({ownerId:'other',taskId:'batch',name:'other.txt',bytes:Buffer.from('independent'),sourceRef:'original-message'});
    assert.throws(()=>f.artifacts.copyIntoTask(f.scope,original.id,{ownerId:'other',taskId:'batch'}),/cross owners/);
    f.artifacts.revoke({ownerId:'owner',sourceRef:'original-message'});assert.throws(()=>f.library.version('owner',saved.document.id),/revoked/);assert.throws(()=>f.artifacts.read(batch,copy.artifact.id),/revoked/);assert.equal(f.artifacts.read({ownerId:'other',taskId:'batch'},other.id).toString(),'independent');
  }finally{f.cleanup();}
});
test('version listing exposes upstream-revoked gaps while preserving independently admitted current versions',()=>{
  const f=fixture();try{
    const original=f.artifacts.put({...f.scope,name:'old.txt',bytes:Buffer.from('old'),sourceRef:'old-owner-message'}),one=f.library.save(f.authority,{artifactId:original.id,name:'resume',versionLabel:'old'});
    const two=f.library.save(f.authority,{artifactId:f.resume('independent updated resume').id,name:'resume',versionLabel:'new',documentId:one.document.id,expectedCurrentVersionId:one.version.id});
    f.artifacts.revoke({ownerId:'owner',sourceRef:'old-owner-message'});const listing=f.library.versionIndex('owner',one.document.id);assert.deepEqual(listing.versions.map(item=>item.id),[two.version.id]);assert.deepEqual(listing.gaps.map(item=>item.versionId),[one.version.id]);assert.equal(f.library.importIntoTask({...f.authority,taskId:'batch'},one.document.id).version.id,two.version.id);
  }finally{f.cleanup();}
});
test('cold reopen completes an interrupted uncommitted library admission cleanup',()=>{
  const f=fixture();try{
    const versionId='11111111-1111-4111-8111-111111111111',artifact=f.artifacts.put({ownerId:'owner',taskId:'__personal_document_library_v1__',name:'orphan.txt',bytes:Buffer.from('uncommitted'),sourceRef:'document-version:'+versionId});
    const db=new DatabaseSync(f.options.databasePath);db.prepare('INSERT INTO document_admissions VALUES(?,?)').run(versionId,'owner');db.close();f.reopen();
    assert.equal(existsSync(join(f.artifacts.rootPath,'originals',artifact.id+'.aes')),false);assert.deepEqual(f.library.list('owner'),[]);
  }finally{f.cleanup();}
});
test('cold reopen settles an interrupted catalog erasure without reviving access or originals',()=>{
  const f=fixture();try{
    const saved=f.library.save(f.authority,{artifactId:f.resume().id,name:'resume',versionLabel:'one'}),copy=f.library.importIntoTask({...f.authority,taskId:'batch'},saved.document.id);
    const erase=f.artifacts.erase.bind(f.artifacts);f.artifacts.erase=(selector)=>{const result=erase(selector);throw new Error('interrupted after vault erase before catalog cleanup receipt');};
    assert.throws(()=>f.library.invalidate(f.authority,saved.document.id,{erase:true}),/interrupted/);assert.throws(()=>f.library.get('owner',saved.document.id),/revoked/);
    f.artifacts.erase=erase;f.reopen();assert.deepEqual(f.library.list('owner'),[]);assert.throws(()=>f.artifacts.read({ownerId:'owner',taskId:'batch'},copy.artifact.id),/revoked/);assert.equal(existsSync(join(f.artifacts.rootPath,'originals',saved.version.artifact.id+'.aes')),false);
  }finally{f.cleanup();}
});
