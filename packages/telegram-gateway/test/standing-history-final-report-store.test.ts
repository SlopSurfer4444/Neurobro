import { REPORT_REVIEW_SERIALIZED_BYTES, snapshotStandingHistoryReportReview } from '../src/standing-history-report-quality.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openStandingHistoryFinalReportStore as openStore} from '../src/standing-history-final-report-store.js';
import type {StandingHistoryTaskIntent} from '../src/standing-history-task-store.js';
const binding={epochId:'1'.repeat(32),requestRef:'final-report-one',purpose:'history-analysis' as const};
async function fixture(t:TestContext,options:{contextHash?:string;bodyKind?:"review"}={}){
 const root=await mkdtemp(join(resolve(tmpdir()),'neurobro-final-report-')),directory=join(root,'reports');await mkdir(directory);
 t.after(async()=>{assert.ok(root.startsWith(join(resolve(tmpdir()),'neurobro-final-report-')));await rm(root,{recursive:true,force:true})});
 const intent:StandingHistoryTaskIntent={schema:'standing-history-task-v1',taskId:'htask_'+'4'.repeat(48),accountId:'123',chatId:'-100456',requesterId:'456',primaryMessageId:999,fromDate:1000,toDate:2000,timezone:'Europe/Moscow',objective:'Секретный итог месяца'};
 const args={directory,passphrase:'synthetic-final-report-passphrase',intent,sourceHead:'a'.repeat(64),analysisHead:'b'.repeat(64),rootRef:'hnode_'+'c'.repeat(48),...options};
 const store=await openStore({...args,mode:'create'});t.after(()=>store.close());return {args,store,slot:join(directory,intent.taskId)};
}
test('encrypted prepared output survives cold reopen and cannot grant a second dispatch',async t=>{
 const {args,store,slot}=await fixture(t);await store.reserve(binding);const body='Месячный отчёт. '+ 'Подробности. '.repeat(600);await store.prepare({body});await store.recordOutcome('observed');await store.close();
 for(const name of await readdir(slot))assert.equal((await readFile(join(slot,name),'utf8')).includes('Месячный'),false);
 const again=await openStore({...args,mode:'open'});t.after(()=>again.close());const s=await again.status();assert.equal(s.prepared?.body,body);assert.equal(s.modelOutcome,'observed');assert.equal(s.modelReplayAllowed,false);assert.equal(s.storage,'ready');await assert.rejects(again.reserve(binding),/CONSUMED/);
 assert.deepEqual(await again.prepare({body}),s);await assert.rejects(again.prepare({body:'Другой отчёт'}),/CONFLICT/);
});
test('UNKNOWN remains immutable while saved preparation can be recovered',async t=>{
 const {args,store}=await fixture(t);await store.reserve(binding);await store.prepare({body:'Сохранённый отчёт'});await store.recordOutcome('unknown');await store.close();const again=await openStore({...args,mode:'open'});t.after(()=>again.close());assert.equal((await again.status()).prepared?.body,'Сохранённый отчёт');await assert.rejects(again.recordOutcome('observed'),/CONFLICT/);await assert.rejects(again.reserve({...binding,requestRef:'new'}),/CONSUMED/);
});
test('reservation without result is consumed on reopen; refusal never authorizes replay',async t=>{
 const {args,store}=await fixture(t);await store.reserve(binding);await store.close();const again=await openStore({...args,mode:'open'});t.after(()=>again.close());await assert.rejects(again.reserve(binding),/CONSUMED/);await again.recordOutcome('refused');await assert.rejects(again.prepare({body:'late'}),/CONSUMED/);
});
test('head, root, and task changes cannot open prior report',async t=>{
 const {args,store}=await fixture(t);await store.close();for(const delta of [{sourceHead:'d'.repeat(64)},{analysisHead:'d'.repeat(64)},{rootRef:'hnode_'+'d'.repeat(48)},{intent:{...args.intent,objective:'different'}}])await assert.rejects(openStore({...args,...delta,mode:'open'}),/BINDING/);
});
test('corrupt prepared file and unexpected tail refuse all writes without repair',async t=>{
 const {args,store,slot}=await fixture(t);await store.reserve(binding);await store.close();await writeFile(join(slot,'prepared.enc'),'broken');const again=await openStore({...args,mode:'open'});t.after(()=>again.close());assert.equal((await again.status()).storage,'tail-refused');await assert.rejects(again.prepare({body:'repair'}),/TAIL/);assert.equal(await readFile(join(slot,'prepared.enc'),'utf8'),'broken');
});
test('body validation uses UTF8 bytes and rejects before persistence',async t=>{
 const {store,slot}=await fixture(t);await store.reserve(binding);await assert.rejects(store.prepare({body:'я'.repeat(16385)}),/INPUT/);await store.prepare({body:'я'.repeat(16384)});assert.equal((await readdir(slot)).includes('prepared.enc'),true);
});
test('aborted store joins actual operation and preserves reopen evidence',async t=>{
 const {args,store}=await fixture(t);await store.close();const controller=new AbortController();const again=await openStore({...args,mode:'open',signal:controller.signal});const pending=again.reserve(binding);controller.abort();await assert.rejects(pending);await again.close();const recovered=await openStore({...args,mode:'open'});t.after(()=>recovered.close());const s=await recovered.status();assert.equal(s.modelReplayAllowed,false);
});

test('maximally JSON-escaped32KiB report survives encrypted cold reopen',async t=>{
 const {args,store}=await fixture(t);await store.reserve(binding);const body='\u0001'.repeat(32768);await store.prepare({body});await store.recordOutcome('observed');await store.close();const again=await openStore({...args,mode:'open'});t.after(()=>again.close());assert.equal((await again.status()).prepared?.body,body);assert.equal((await again.status()).storage,'ready');
});

function reviewBody(character='x') {
 const field=character.repeat(Math.floor(1024/Buffer.byteLength(character)));
 return JSON.stringify(snapshotStandingHistoryReportReview({candidateHash:'a'.repeat(64),verdict:'revise',findings:Array.from({length:6},()=>({dimension:'readability',problem:field,correction:field}))}));
}
test('full six-finding ASCII and worst-escaped reviews use the derived budget',()=>{
 assert.equal(REPORT_REVIEW_SERIALIZED_BYTES,74752);
 assert.equal(Buffer.byteLength(reviewBody()),12746);
 assert.equal(Buffer.byteLength(reviewBody('\u0001')),74186);
 const invalid=JSON.parse(reviewBody());invalid.findings[0].problem+='x';assert.throws(()=>snapshotStandingHistoryReportReview(invalid));
});
test('review mode persists worst-escaped verdict and cold reopens without granting replay',async t=>{
 const {args,store}=await fixture(t,{contextHash:'d'.repeat(64),bodyKind:'review'});
 const body=reviewBody('\u0001');await store.reserve(binding);await store.prepare({body});await store.recordOutcome('observed');await store.close();
 const again=await openStore({...args,mode:'open'});t.after(()=>again.close());const status=await again.status();
 assert.equal(status.storage,'ready');assert.equal(status.prepared?.body,body);assert.equal(status.modelReplayAllowed,false);
 assert.equal(snapshotStandingHistoryReportReview(JSON.parse(status.prepared!.body)).findings.length,6);
 await assert.rejects(again.reserve(binding),/CONSUMED/);
});
test('review mode requires context binding and structural review while ordinary report bound stays32KiB',async t=>{
 const {args,store}=await fixture(t);await store.close();
 await assert.rejects(openStore({...args,mode:'open',bodyKind:'review'}),/INPUT/);
 const other=await fixture(t,{contextHash:'d'.repeat(64),bodyKind:'review'});await other.store.reserve(binding);
 await assert.rejects(other.store.prepare({body:'x'.repeat(32769)}),/INPUT/);
 await assert.rejects(other.store.prepare({body:' '.repeat(REPORT_REVIEW_SERIALIZED_BYTES)+reviewBody()}),/INPUT/);
 const plain=await fixture(t);await plain.store.reserve(binding);await assert.rejects(plain.store.prepare({body:reviewBody('\u0001')}),/INPUT/);
});
test('old small review header is unchanged and reopens under review mode',async t=>{
 const {args,store,slot}=await fixture(t,{contextHash:'d'.repeat(64)});await store.reserve(binding);
 const body=JSON.stringify({candidateHash:'a'.repeat(64),verdict:'accepted',findings:[]});await store.prepare({body});await store.close();
 const before=await readFile(join(slot,'intent.enc'));
 const again=await openStore({...args,mode:'open',bodyKind:'review'});t.after(()=>again.close());assert.equal((await again.status()).prepared?.body,body);
 assert.deepEqual(await readFile(join(slot,'intent.enc')),before);
});
