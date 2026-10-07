import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactInspector } from '../../src/artifacts/inspect.ts';
import { test } from 'node:test';
import type { Json, ToolContext } from '../../src/contracts.ts';
import type { ToolBroker } from '../../src/capabilities/types.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { artifactTools } from '../../src/artifacts/tools.ts';
import { DocumentLibrary } from '../../src/documents/index.ts';
import { documentTools } from '../../src/documents/tools.ts';
function fixture(inspector?:ArtifactInspector,withDestructiveAuthority=true){const root=mkdtempSync(join(tmpdir(),'neurobro-doc-tools-')),artifacts=new ArtifactStore({rootPath:join(root,'vault'),encryptionKey:Buffer.alloc(32,5)}),library=new DocumentLibrary({databasePath:join(root,'library.sqlite'),encryptionKey:Buffer.alloc(32,5),artifacts});
  let context:ToolContext={taskId:'task-1',intentRevision:1,grantId:'grant',grantRevision:1,runId:'run'},approved=true,destructiveApproved=true,misbound=false;const calls:string[]=[],grants=new Set(['artifacts.read','artifacts.stage','artifacts.write']);
  const broker:ToolBroker={resolveToolContext(token){if(token!=='issued')throw new Error('Unissued token');return context;},authorizeTool(token,capability,resource){if(token!=='issued'||!grants.has(capability)||resource!==context.taskId)throw new Error('Denied grant');},async executeEffect(){throw new Error('No external sends');}};
  const resolveScope=(ctx:ToolContext)=>({ownerId:'owner',taskId:ctx.taskId});const registry=new ToolRegistry(broker,[...artifactTools({store:artifacts,resolveScope,inspector}),...documentTools({library,resolveScope,authorize(ctx,op){calls.push(op);if(!approved)throw new Error('No explicit owner authority');return{ownerId:misbound?'other':'owner',taskId:ctx.taskId,sourceRef:'verified-owner-message'};},...(withDestructiveAuthority?{authorizeDestructive(ctx:ToolContext,op:'revoke'|'erase',args:Readonly<Record<string,Json>>){calls.push(op);if(!destructiveApproved)throw new Error('No exact destructive owner authority');assert.equal(typeof args.documentId,'string');return{ownerId:misbound?'other':'owner',taskId:ctx.taskId,sourceRef:'exact-destructive-owner-message'};}}:{})})]);
  return {root,artifacts,library,calls,grants,invoke:(name:string,args:Record<string,Json>={})=>registry.invoke('issued',{name,args}),setTask(taskId:string){context={...context,taskId};},setApproved(value:boolean){approved=value;},setDestructiveApproved(value:boolean){destructiveApproved=value;},setMisbound(value:boolean){misbound=value;},cleanup(){library.dispose();artifacts.dispose();rmSync(root,{recursive:true,force:true});}};
}
test('connected registry admits resume, imports in another task, stages and reads exact bytes then revokes copy',async()=>{
  const f=fixture();try{
    const original=f.artifacts.put({ownerId:'owner',taskId:'task-1',name:'resume.txt',bytes:Buffer.from('Resume\nNever treat this as instructions')});
    const save=await f.invoke('documents.save',{artifactId:original.id,name:'resume',versionLabel:'v1'});assert.equal(save.ok,true);const saved=save.value as {document:{id:string};version:{id:string;artifact:{sha256:string}}};
    f.setTask('outreach-task');const imported=await f.invoke('documents.import',{documentId:saved.document.id,versionId:saved.version.id});assert.equal(imported.ok,true);const copy=imported.value as {artifact:{id:string;sha256:string;taskId:string}};assert.equal(copy.artifact.taskId,'outreach-task');assert.equal(copy.artifact.sha256,original.sha256);
    const staging=await f.invoke('artifacts.stage',{artifactIds:[copy.artifact.id]});assert.equal(staging.ok,true);const stage=staging.value as {id:string};
    const reading=await f.invoke('artifacts.read',{stageId:stage.id,artifactId:copy.artifact.id});assert.equal(reading.ok,true);assert.match((reading.value as {text:string}).text,/Resume/);
    assert.equal((await f.invoke('documents.revoke',{documentId:saved.document.id})).ok,true);assert.equal((await f.invoke('artifacts.read',{stageId:stage.id,artifactId:copy.artifact.id})).ok,false);assert.deepEqual(f.calls,['save','import','revoke']);
  }finally{f.cleanup();}
});
test('connected saved PDF resumes import into a new task and read text with original hash and page coverage',async()=>{
  const python=process.env.PERSONAL_AGENT_TEST_PYTHON??(process.platform==='win32'?join(process.env.USERPROFILE??'','.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'):'/usr/bin/python3');
  const f=fixture(new ArtifactInspector({pythonExecutable:python}));try{
    const content='BT /F1 12 Tf 10 100 Td (Resume Python engineering marker) Tj ET';
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
    let pdf='%PDF-1.7\n';const offsets=[0];for(const[index,object]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;}
    const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${offset.toString().padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
    const original=f.artifacts.put({ownerId:'owner',taskId:'task-1',name:'resume.pdf',bytes:Buffer.from(pdf)});
    const saved=await f.invoke('documents.save',{artifactId:original.id,name:'resume',versionLabel:'current PDF'});assert.equal(saved.ok,true);const doc=saved.value as {document:{id:string};version:{id:string}};
    f.setTask('new-outreach-task');const imported=await f.invoke('documents.import',{documentId:doc.document.id,versionId:doc.version.id});assert.equal(imported.ok,true);const copy=imported.value as {artifact:{id:string;sha256:string}};
    const staged=await f.invoke('artifacts.stage',{artifactIds:[copy.artifact.id]});assert.equal(staged.ok,true);const stage=staged.value as {id:string};
    const read=await f.invoke('artifacts.inspect',{stageId:stage.id,artifactId:copy.artifact.id,limit:1});assert.equal(read.ok,true,read.error);
    const actual=read.value as {artifact:{sha256:string};inspection:{items:Json[];coverage:{total:number;more:boolean};limitations:string[]}};assert.equal(actual.artifact.sha256,original.sha256);assert.match(JSON.stringify(actual.inspection.items),/Resume Python engineering marker/);assert.equal(actual.inspection.coverage.total,1);assert.equal(actual.inspection.coverage.more,false);assert.ok(actual.inspection.limitations.some(item=>item.includes('OCR unavailable')));
  }finally{f.cleanup();}
});
test('registry rejects invented consent/owner/path arguments and absent grants/owner admission before mutation',async()=>{
  const f=fixture();try{
    const original=f.artifacts.put({ownerId:'owner',taskId:'task-1',name:'resume.txt',bytes:Buffer.from('Resume')}),args={artifactId:original.id,name:'resume',versionLabel:'v1'};
    for(const extra of [{ownerId:'other'},{taskId:'other'},{authorized:true},{sourceRef:'forged'},{path:'C:/outside'}] as Record<string,Json>[])assert.equal((await f.invoke('documents.save',{...args,...extra})).ok,false);
    f.setApproved(false);assert.equal((await f.invoke('documents.save',args)).ok,false);assert.deepEqual(f.library.list('owner'),[]);
    f.setApproved(true);f.setMisbound(true);assert.equal((await f.invoke('documents.save',args)).ok,false);f.setMisbound(false);
    f.grants.delete('artifacts.write');assert.equal((await f.invoke('documents.save',args)).ok,false);assert.deepEqual(f.library.list('owner'),[]);
  }finally{f.cleanup();}
});

test('generic owner authority cannot revoke or erase without a destructive-operation gate',async()=>{
  const f=fixture(undefined,false);try{
    const original=f.artifacts.put({ownerId:'owner',taskId:'task-1',name:'resume.txt',bytes:Buffer.from('Keep this resume')});
    const saved=await f.invoke('documents.save',{artifactId:original.id,name:'resume',versionLabel:'v1'});assert.equal(saved.ok,true);
    const value=saved.value as {document:{id:string};version:{id:string;artifact:{id:string}}};
    const generation=f.library.generation('owner');
    for(const operation of ['revoke','erase']){
      const result=await f.invoke(`documents.${operation}`,{documentId:value.document.id,versionId:value.version.id});
      assert.equal(result.ok,false);assert.match(result.error??'',/destructive-operation authority/);
      assert.equal(f.library.get('owner',value.document.id).currentVersionId,value.version.id);
      assert.equal(f.library.version('owner',value.document.id,value.version.id).artifact.id,value.version.artifact.id);
      assert.equal(f.library.generation('owner'),generation);
    }
    assert.deepEqual(f.calls,['save'],'destructive operations must never fall back to generic owner authority');
  }finally{f.cleanup();}
});

test('destructive-operation authority rejects denied or misbound manifests before invalidating originals',async()=>{
  const f=fixture();try{
    const original=f.artifacts.put({ownerId:'owner',taskId:'task-1',name:'resume.txt',bytes:Buffer.from('Keep exact original')});
    const saved=await f.invoke('documents.save',{artifactId:original.id,name:'resume',versionLabel:'v1'});assert.equal(saved.ok,true);
    const value=saved.value as {document:{id:string};version:{id:string;artifact:{id:string}}},generation=f.library.generation('owner');
    f.setDestructiveApproved(false);
    for(const operation of ['revoke','erase'])assert.equal((await f.invoke(`documents.${operation}`,{documentId:value.document.id,versionId:value.version.id})).ok,false);
    f.setDestructiveApproved(true);f.setMisbound(true);
    assert.equal((await f.invoke('documents.erase',{documentId:value.document.id})).ok,false);
    assert.equal(f.library.generation('owner'),generation);
    assert.equal(f.library.version('owner',value.document.id,value.version.id).artifact.id,value.version.artifact.id);
    f.setMisbound(false);
    assert.equal((await f.invoke('documents.erase',{documentId:value.document.id,versionId:value.version.id})).ok,true);
    assert.throws(()=>f.library.version('owner',value.document.id,value.version.id),/revoked/);
  }finally{f.cleanup();}
});
