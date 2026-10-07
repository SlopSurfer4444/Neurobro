import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { PersistentMemoryStore, type SourceInput } from '../../src/memory/index.ts';

const key=Buffer.alloc(32,42);
const access={ownerId:'owner',scopes:['chat:private','global'],accountId:'account'};
function setup(){const dir=mkdtempSync(join(tmpdir(),'neurobro-memory-'));const options={databasePath:join(dir,'archive.sqlite'),blobDirectory:join(dir,'blobs'),encryptionKey:key};return{dir,options,store:new PersistentMemoryStore(options)};}
function source(overrides:Partial<SourceInput>={}):SourceInput{return{ownerId:'owner',accountId:'account',scope:'chat:private',sourceId:'peer:001/message:1',version:'1',eventAt:'2026-01-01T01:00:00.000Z',text:'Тайный маркер UNIQUE_PRIVATE_MARKER предложение проекта',attribution:'owner_explicit',...overrides};}

test('durable encrypted Unicode originals, exact revisions, scoped FTS and restart',()=>{
 const f=setup();try{
  const original=Buffer.from([0,1,255,17]);const first=f.store.ingestSource(source({original}));
  assert.equal(f.store.ingestSource(source({original})).ref,first.ref);
  assert.throws(()=>f.store.ingestSource(source({text:'changed'})),/version conflict/);
  f.store.ingestSource(source({sourceId:'outside',scope:'chat:public',text:'UNIQUE_PRIVATE_MARKER публичное'}));
  f.store.ingestSource(source({sourceId:'otherowner',ownerId:'another',text:'UNIQUE_PRIVATE_MARKER'}));
  assert.deepEqual(Buffer.from(f.store.readOriginal(access,first.ref)),original);
  assert.equal(f.store.query(access,'UNIQUE_PRIVATE_MARKER').length,1);
  assert.equal(f.store.query({ownerId:'owner',scopes:['chat:public']},'UNIQUE_PRIVATE_MARKER').length,1);
  assert.equal(f.store.readSource({ownerId:'owner',scopes:['chat:public']},first.ref),undefined);
  f.store.close();
  for(const file of readdirSync(f.dir).filter(name=>name.startsWith('archive.sqlite')))assert.equal(readFileSync(join(f.dir,file)).includes(Buffer.from('UNIQUE_PRIVATE_MARKER')),false);
  for(const file of readdirSync(f.options.blobDirectory))assert.equal(readFileSync(join(f.options.blobDirectory,file)).includes(Buffer.from('UNIQUE_PRIVATE_MARKER')),false);
  f.store=new PersistentMemoryStore(f.options);assert.equal(f.store.query(access,'Тайный').at(0)?.source.ref,first.ref);
  assert.deepEqual(Buffer.from(f.store.readOriginal(access,first.ref)),original);
  assert.throws(()=>new PersistentMemoryStore({...f.options,encryptionKey:Buffer.alloc(32,7)}));
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('source edit invalidates preference, Hermes procedure and transcript references without replay',()=>{
 const f=setup();try{
  const first=f.store.ingestSource(source());
  const pref=f.store.putPreference({ownerId:'owner',scope:'global',key:'report-style',text:'Detailed reports',sourceRef:first.ref,explicitOwner:true,enduring:true});
  f.store.mirrorProcedureCandidate({ownerId:'owner',scope:'chat:private',hermesMemoryId:'hm1',hermesVersion:'1',text:'candidate lesson',sourceRefs:[first.ref],state:'candidate'});
  f.store.registerDerived('owner','artifact1','artifact',[first.ref]);
  const packet=f.store.buildContext({access,taskId:'task',instruction:'Read history',sourceRefs:[first.ref],budgetTokens:2000,countTokens:text=>text.length,tokenizerId:'fixture-codepoint'});
  assert.equal(packet.manifest.preferenceRefs[0]?.id,pref.id);
  const next=f.store.ingestSource(source({version:'2',revisionSequence:2,text:'Corrected new text'}));
  assert.equal(f.store.readSource(access,first.ref),undefined);assert.equal(f.store.readSource(access,first.ref,{historical:true})?.state,'superseded');
  assert.equal(f.store.query(access,'UNIQUE_PRIVATE_MARKER').length,0);assert.equal(f.store.query(access,'Corrected').at(0)?.source.ref,next.ref);
  assert.equal(f.store.preferences(access).length,0);assert.equal(f.store.procedures(access).length,0);
  assert.throws(()=>f.store.assertCurrent(packet.manifest),/invalidated/);
  const event=f.store.invalidations('owner').find(event=>event.reason==='source_edit')!;assert.ok(event.derivedRefs.includes('artifact:artifact1'));assert.ok(event.derivedRefs.some(ref=>ref.startsWith('transcript:')));
  f.store.close();f.store=new PersistentMemoryStore(f.options);assert.equal(f.store.invalidations('owner').length,2);assert.equal(f.store.query(access,'Corrected').length,1);
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('enduring explicit owner preference has optimistic revision and separate exact scopes',()=>{
 const f=setup();try{
  const a=f.store.ingestSource(source());
  assert.throws(()=>f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'X',sourceRef:a.ref,explicitOwner:true,enduring:false}),/Task correction/);
  const third=f.store.ingestSource(source({sourceId:'quote',forwarded:true}));
  assert.throws(()=>f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'X',sourceRef:third.ref,explicitOwner:true,enduring:true}),/explicit owner/);
  const p=f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'Detailed reports',sourceRef:a.ref,explicitOwner:true,enduring:true});
  assert.throws(()=>f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'X',sourceRef:a.ref,explicitOwner:true,enduring:true}),/revision conflict/);
  const local=f.store.putPreference({ownerId:'owner',scope:'chat:private',key:'style',text:'Short replies here',sourceRef:a.ref,explicitOwner:true,enduring:true});
  const updated=f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'Even more detail',sourceRef:a.ref,explicitOwner:true,enduring:true,expectedRevision:p.revision});
  assert.equal(updated.revision,2);assert.equal(updated.id,p.id);assert.equal(f.store.preferences(access).length,2);
  assert.equal(f.store.preferences({ownerId:'owner',scopes:['chat:private']})[0]?.id,local.id);
  f.store.close();f.store=new PersistentMemoryStore(f.options);assert.equal(f.store.preferences(access).find(p=>p.scope==='global')?.text,'Even more detail');
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('erase cascades every revision and derivation, survives reopen, tombstone prevents resurrection',()=>{
 const f=setup();try{
  const first=f.store.ingestSource(source());const second=f.store.ingestSource(source({version:'2',revisionSequence:2,text:'UNIQUE_PRIVATE_MARKER revised'}));
  f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'UNIQUE_PRIVATE_MARKER remembered',sourceRef:second.ref,explicitOwner:true,enduring:true});
  f.store.mirrorProcedureCandidate({ownerId:'owner',scope:'chat:private',hermesMemoryId:'hm1',hermesVersion:'1',text:'UNIQUE_PRIVATE_MARKER derived',sourceRefs:[second.ref],state:'candidate'});
  f.store.recordCoverage({ownerId:'owner',accountId:'account',scope:'chat:private',from:'2026-01-01T00:00:00.000Z',to:'2026-02-01T00:00:00.000Z',sourceGeneration:'v1',gaps:[{reason:'UNIQUE_PRIVATE_MARKER attachment',sourceId:second.sourceId}],complete:false});
  assert.throws(()=>f.store.forget({ownerId:'owner',scopes:['chat:public']},second.ref,'erase'),/outside scope/);
  const event=f.store.forget(access,second.ref,'erase');assert.equal(event.sourceRefs.length,2);
  assert.equal(f.store.query(access,'UNIQUE_PRIVATE_MARKER').length,0);assert.equal(readdirSync(f.options.blobDirectory).length,0);
  assert.equal(f.store.coverage(access)[0]?.complete,false);assert.equal(JSON.stringify(f.store.coverage(access)).includes('UNIQUE_PRIVATE_MARKER'),false);
  assert.equal(f.store.readSource(access,first.ref,{historical:true}),undefined);assert.equal(f.store.preferences(access).length,0);assert.equal(f.store.procedures(access).length,0);
  assert.throws(()=>f.store.ingestSource(source({version:'3'})),/tombstoned/);
  f.store.close();f.store=new PersistentMemoryStore(f.options);assert.equal(f.store.query(access,'UNIQUE_PRIVATE_MARKER').length,0);assert.throws(()=>f.store.ingestSource(source()),/tombstoned/);
  assert.equal(JSON.stringify(f.store.invalidations('owner')).includes('UNIQUE_PRIVATE_MARKER'),false);
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('budget preserves current correction, omits whole oversized sources, declares coverage gap',()=>{
 const f=setup();try{
  const a=f.store.ingestSource(source({text:'x'.repeat(5000)}));
  const coverage=f.store.recordCoverage({ownerId:'owner',accountId:'account',scope:'chat:private',from:'2026-01-01T00:00:00.000Z',to:'2026-02-01T00:00:00.000Z',sourceGeneration:'v1',gaps:[{reason:'deleted attachment',sourceId:'2'}],complete:false});
  const packet=f.store.buildContext({access,taskId:'task1',instruction:'Analyze month',currentCorrections:['Use this revised objective'],sourceRefs:[a.ref],budgetTokens:500,countTokens:text=>Array.from(text).length,tokenizerId:'fixture-codepoint'});
  assert.ok(packet.text.includes('Use this revised objective'));assert.equal(packet.manifest.primaryRefs.length,0);assert.ok(packet.manifest.tokenCount<=500);assert.equal(packet.manifest.omissions[0]?.ref,a.ref);assert.equal(packet.manifest.coverage[0]?.id,coverage.id);assert.equal(packet.manifest.gaps.length,1);
  assert.throws(()=>f.store.buildContext({access,taskId:'t',instruction:'x'.repeat(600),budgetTokens:500,countTokens:text=>text.length,tokenizerId:'fixture'}),/Mandatory/);
  assert.throws(()=>f.store.recordCoverage({ownerId:'owner',accountId:'account',scope:'chat:private',from:'2026-01-01',to:'2026-02-01',sourceGeneration:'v2',gaps:[{reason:'gap'}],complete:true}),/cannot be complete/);
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('retention erases old source, preserves new one and rejects source size overflow',()=>{
 const f=setup();try{
  const old=f.store.ingestSource(source());const fresh=f.store.ingestSource(source({sourceId:'fresh',eventAt:'2026-09-01T00:00:00.000Z',text:'fresh searchable'}));
  f.store.expireBefore(access,'2026-02-01T00:00:00.000Z');assert.equal(f.store.readSource(access,old.ref),undefined);assert.equal(f.store.readSource(access,fresh.ref)?.text,'fresh searchable');
  const small=new PersistentMemoryStore({...f.options,databasePath:join(f.dir,'small.sqlite'),blobDirectory:join(f.dir,'small-blobs'),maxSourceBytes:5});try{assert.throws(()=>small.ingestSource(source()),/not truncated/);}finally{small.close();}
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('archive rejects real disk junction in an ancestor',()=>{
 const f=setup();try{
  const outside=join(f.dir,'outside');mkdirSync(outside);const linked=join(f.dir,'linked');symlinkSync(outside,linked,'junction');
  assert.throws(()=>new PersistentMemoryStore({databasePath:join(linked,'archive.sqlite'),blobDirectory:join(f.dir,'safe'),encryptionKey:key}),/symlink/);
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('fresh Node process rebuilds FTS from encrypted archive and retains exact source identity',()=>{
 const f=setup();try{
  const original=f.store.ingestSource(source());f.store.close();
  const moduleUrl=pathToFileURL(join(import.meta.dirname,'../../src/memory/index.ts')).href;
  const code=`import {PersistentMemoryStore} from ${JSON.stringify(moduleUrl)};const store=new PersistentMemoryStore({...JSON.parse(process.env.MEMORY_FIXTURE_OPTIONS),encryptionKey:Buffer.alloc(32,42)});const result=store.query({ownerId:'owner',scopes:['chat:private']},'UNIQUE_PRIVATE_MARKER');console.log(JSON.stringify(result.map(hit=>({ref:hit.source.ref,sourceId:hit.source.sourceId}))));store.close();`;
  const processResult=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',code],{env:{...process.env,MEMORY_FIXTURE_OPTIONS:JSON.stringify({databasePath:f.options.databasePath,blobDirectory:f.options.blobDirectory})},encoding:'utf8'});
  assert.equal(processResult.status,0,processResult.stderr);assert.deepEqual(JSON.parse(processResult.stdout),[{ref:original.ref,sourceId:original.sourceId}]);
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('restart reconciles durable erase committed before physical blob deletion',()=>{
 const f=setup();try{
  const original=f.store.ingestSource(source());f.store.close();
  const db=new DatabaseSync(f.options.databasePath);db.prepare('UPDATE sources SET state=?,payload=NULL WHERE ref=?').run('erased',original.ref);db.close();
  assert.equal(readdirSync(f.options.blobDirectory).length,1);
  f.store=new PersistentMemoryStore(f.options);assert.equal(readdirSync(f.options.blobDirectory).length,0);assert.equal(f.store.readSource(access,original.ref,{historical:true}),undefined);
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('new preference invalidates prior engine context, revoked rule can only return with exact new revision',()=>{
 const f=setup();try{
  const a=f.store.ingestSource(source());const packet=f.store.buildContext({access,taskId:'task',instruction:'Report',budgetTokens:1000,countTokens:text=>text.length,tokenizerId:'fixture'});
  const preference=f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'Detailed reports',sourceRef:a.ref,explicitOwner:true,enduring:true});
  assert.throws(()=>f.store.assertCurrent(packet.manifest),/invalidated/);
  const b=f.store.ingestSource(source({version:'2',revisionSequence:2,text:'Owner revised preference'}));
  assert.throws(()=>f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'Concise report',sourceRef:b.ref,explicitOwner:true,enduring:true}),/revision conflict/);
  const revised=f.store.putPreference({ownerId:'owner',scope:'global',key:'style',text:'Concise report',sourceRef:b.ref,explicitOwner:true,enduring:true,expectedRevision:preference.revision});assert.equal(revised.revision,2);
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('late opaque old version cannot replace newer current source without trusted ordering',()=>{
 const f=setup();try{
  const current=f.store.ingestSource(source({version:'opaque-newer',revisionSequence:500,text:'Newest edit'}));
  assert.throws(()=>f.store.ingestSource(source({version:'opaque-late-old',revisionSequence:200,text:'Late old text'})),/Stale source/);
  assert.throws(()=>f.store.ingestSource(source({version:'opaque-unordered',text:'Ambiguous order'})),/Unordered source/);
  assert.equal(f.store.query(access,'Newest').at(0)?.source.ref,current.ref);assert.equal(f.store.query(access,'Late').length,0);
  f.store.close();f.store=new PersistentMemoryStore(f.options);assert.equal(f.store.readSource(access,current.ref)?.version,'opaque-newer');
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('retention can erase superseded version without tombstoning a fresh version of same logical source',()=>{
 const f=setup();try{
  const old=f.store.ingestSource(source());const fresh=f.store.ingestSource(source({version:'2',revisionSequence:2,eventAt:'2026-09-01T00:00:00.000Z',text:'Fresh corrected text'}));
  f.store.expireBefore(access,'2026-02-01T00:00:00.000Z');assert.equal(f.store.readSource(access,old.ref,{historical:true}),undefined);assert.equal(f.store.readSource(access,fresh.ref)?.text,'Fresh corrected text');
  assert.throws(()=>f.store.ingestSource(source()),/version was erased/);assert.equal(readdirSync(f.options.blobDirectory).length,1);
  const later=f.store.ingestSource(source({version:'3',revisionSequence:3,eventAt:'2026-09-02T00:00:00.000Z',text:'Freshest'}));assert.equal(f.store.readSource(access,later.ref)?.text,'Freshest');
 }finally{f.store.close();rmSync(f.dir,{recursive:true,force:true});}
});
