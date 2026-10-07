import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ArtifactInspector } from '../../src/artifacts/inspect.ts';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { artifactTools } from '../../src/artifacts/tools.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import type { ArtifactRecord } from '../../src/contracts.ts';
const python=process.env.PERSONAL_AGENT_TEST_PYTHON??(process.platform==='win32'?join(process.env.LOCALAPPDATA??'','Programs/Python/Python314/python.exe'):'/usr/bin/python3');
const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function record(mimeType:string):ArtifactRecord{return{id:'fixture',taskId:'t',ownerId:'owner',name:'fixture',mimeType,sha256:'fixture',size:0,createdAt:new Date().toISOString()};}
function zip(parts:Record<string,string>,compressed=false):Buffer{
 const script="import sys,json,io,zipfile; parts=json.loads(sys.stdin.buffer.read().decode('utf-8')); buf=io.BytesIO(); z=zipfile.ZipFile(buf,'w',compression=zipfile.ZIP_DEFLATED if sys.argv[1]=='1' else zipfile.ZIP_STORED); [z.writestr(name,text) for name,text in parts.items()]; z.close(); sys.stdout.buffer.write(buf.getvalue())";
 const result=spawnSync(python,['-I','-B','-c',script,compressed?'1':'0'],{input:Buffer.from(JSON.stringify(parts)),maxBuffer:8*1024*1024,windowsHide:true});assert.equal(result.status,0,result.stderr?.toString()??result.error?.message);return result.stdout;
}
function workbook():Buffer{return zip({'[Content_Types].xml':'<Types/>','xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Main" sheetId="1" r:id="r1"/><sheet name="Hidden" state="hidden" sheetId="2" r:id="r2"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>','xl/sharedStrings.xml':'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>Привет </t></r><r><t>мир</t></r></si></sst>','xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Владелец</t></is></c><c r="C1"><f>1+2</f><v>3</v></c></row><row r="2"><c r="A2"><v>9007199254740993</v></c></row></sheetData></worksheet>','xl/worksheets/sheet2.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="5"><c r="A5" t="inlineStr"><is><t>hidden marker</t></is></c></row></sheetData></worksheet>'});}
function document():Buffer{return zip({'[Content_Types].xml':'<Types/>','word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Первая строка</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Ячейка таблицы</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>','word/header1.xml':'<header>Unread header</header>','word/media/image1.png':'not decoded pixels'});}

test('JSON preserves unsafe integer lexeme; CSV extracts quoted multiline exact rows with explicit pages',async()=>{
 const inspector=new ArtifactInspector();const json=await inspector.inspect(record('application/json'),Buffer.from('[{"id":9007199254740993},"next"]'),{limit:1});
 assert.deepEqual(json.items,[{id:{type:'exact-json-number',source:'9007199254740993'}}]);assert.equal(json.coverage.more,true);
 const csv=Buffer.from('name,value\r\n"Аня","line1\nline2"\r\n"quote ""inside""",42\r\n');
 const page=await inspector.inspect(record('text/csv'),csv,{offset:1,limit:1});assert.deepEqual(page.items,[['Аня','line1\nline2']]);assert.deepEqual(page.coverage,{start:1,end:2,total:3,more:true});
 await assert.rejects(inspector.inspect(record('text/csv'),Buffer.from('"unclosed')),/Unclosed CSV/);
 await assert.rejects(inspector.inspect(record('text/csv'),Buffer.from('"a"trailing,b')),/Malformed CSV/);
});

test('actual Python stdlib decodes XLSX shared/inline/cached cells, preserves IDs and declares unread sheets',async()=>{
 const inspector=new ArtifactInspector({pythonExecutable:python});const bytes=workbook();const first=await inspector.inspect(record(xlsx),bytes,{limit:1});
 const row=first.items[0] as {cells:{value:string;formula:string|null}[]};assert.equal(row.cells[0]?.value,'Привет мир');assert.equal(row.cells[1]?.value,'Владелец');assert.equal(row.cells[2]?.formula,'1+2');assert.equal(row.cells[2]?.value,'3');assert.equal(first.coverage.more,true);assert.equal(first.coverage.total,2);assert.ok(JSON.stringify(first.gaps).includes('Hidden'));
 const next=await inspector.inspect(record(xlsx),bytes,{offset:1,limit:1});assert.equal((next.items[0] as {cells:{value:string}[]}).cells[0]?.value,'9007199254740993');
 const hidden=await inspector.inspect(record(xlsx),bytes,{sheet:'Hidden'});assert.ok(JSON.stringify(hidden.items).includes('hidden marker'));assert.ok(JSON.stringify(hidden.sheets).includes('hidden'));
});

test('DOCX extracts body/table paragraphs and exposes nonbody/media gaps without claiming visual read',async()=>{
 const inspector=new ArtifactInspector({pythonExecutable:python});const result=await inspector.inspect(record(docx),document(),{offset:1,limit:1});assert.equal((result.items[0] as {text:string}).text,'Ячейка таблицы');assert.equal(result.coverage.total,2);assert.ok(JSON.stringify(result.gaps).includes('word/header1.xml'));assert.ok(JSON.stringify(result.gaps).includes('word/media/image1.png'));
});

test('unsupported PDF/media and absent Python are explicit; bounds reject whole output rather than silently truncating',async()=>{
 const inspector=new ArtifactInspector();await assert.rejects(inspector.inspect(record('application/pdf'),Buffer.from('%PDF-1.7')),/PDF inspection unsupported/);await assert.rejects(inspector.inspect(record('image/png'),Buffer.alloc(8)),/does not establish visual/);await assert.rejects(inspector.inspect(record(docx),document()),/configure.*Python/);
 const small=new ArtifactInspector({maxInputBytes:5});await assert.rejects(small.inspect(record('text/plain'),Buffer.from('123456')),/not truncated/);
 const output=new ArtifactInspector({maxOutputBytes:1024});await assert.rejects(output.inspect(record('text/plain'),Buffer.from('x'.repeat(2000))),/smaller explicit page/);
});

test('OOXML unsafe names, compression bombs, DTD/entities and malformed workbook references fail in actual helper',async()=>{
 const inspector=new ArtifactInspector({pythonExecutable:python});
 await assert.rejects(inspector.inspect(record(docx),zip({'../escape.xml':'<x/>','word/document.xml':'<x/>'})),/Unsafe/);
 await assert.rejects(inspector.inspect(record(docx),zip({'word/document.xml':'x'.repeat(100000)},true)),/expansion ratio/);
 await assert.rejects(inspector.inspect(record(docx),zip({'word/document.xml':'<!DOCTYPE doc [<!ENTITY e "secret">]><doc>&e;</doc>'})),/DTD\/entity/);
 await assert.rejects(new ArtifactInspector({pythonExecutable:python,maxEntries:1}).inspect(record(docx),document()),/entry count/);
});

test('registry inspection uses real vault bytes, excludes cross-task/rawpath input and rechecks revocation after async decoder',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'neurobro-inspect-'));const store=new ArtifactStore({rootPath:dir,encryptionKey:Buffer.alloc(32,8)});const scope={ownerId:'owner',taskId:'t'};
 try{
  const input=store.put({...scope,name:'book.xlsx',bytes:workbook(),mimeType:xlsx}),stage=store.stageTask(scope,[input.id]);
  const context={taskId:'t',intentRevision:1,grantId:'g',grantRevision:1,runId:'r'};let decoded=false;
  const inspector=new ArtifactInspector({pythonExecutable:python,pdfExtractor:async()=>{decoded=true;store.revoke(scope);return{format:'pdf',unit:'pages',items:[],coverage:{start:0,end:0,total:0,more:false},gaps:[],limitations:[]};}});
  const registry=new ToolRegistry({resolveToolContext(){return context;},authorizeTool(_token,cap,resource){assert.equal(cap,'artifacts.read');assert.equal(resource,'t');},async executeEffect(){throw new Error('No external effects');}},artifactTools({store,resolveScope:()=>scope,inspector}));
  const response=await registry.invoke('issued',{name:'artifacts.inspect',args:{stageId:stage.id,artifactId:input.id,limit:1}});assert.equal(response.ok,true);assert.ok(JSON.stringify(response.value).includes('Привет мир'));
  assert.equal((await registry.invoke('issued',{name:'artifacts.inspect',args:{stageId:stage.id,artifactId:input.id,path:'C:/secret'}})).ok,false);
  const other=store.put({ownerId:'owner',taskId:'other',name:'file.txt',bytes:Buffer.from('other')});assert.equal((await registry.invoke('issued',{name:'artifacts.inspect',args:{stageId:stage.id,artifactId:other.id}})).ok,false);
  const pdf=store.put({...scope,name:'sample.pdf',bytes:Buffer.from('%PDF-1.7\nfixture'),mimeType:'application/pdf'}),pdfStage=store.stageTask(scope,[pdf.id]);
  const revoked=await registry.invoke('issued',{name:'artifacts.inspect',args:{stageId:pdfStage.id,artifactId:pdf.id}});assert.equal(decoded,true);assert.equal(revoked.ok,false);
 }finally{store.dispose();rmSync(dir,{recursive:true,force:true});}
});
