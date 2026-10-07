import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from '../../src/core/store.ts';
import { createMonitorSource } from '../../src/monitor-source.ts';
import { ContinuousMonitorCoordinator, createObservationTools, type MonitorCandidate, type MonitorDigest } from '../../src/observation/index.ts';
import { HermesScheduleCoordinator } from '../../src/hermes/schedules.ts';
import { TdlibTelegram, FileTelegramStore, type TdObject, type TdJsonTransport } from '../../src/telegram/index.ts';
import type { EffectResult, ToolContext, Observation } from '../../src/contracts.ts';
import type { ToolCall } from '../../src/capabilities/types.ts';

const peer = '-100123', context: ToolContext = { taskId: 'vacancy-task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'foreground' };
const call = (runId = 'foreground'): ToolCall => ({ token: 'trusted', context: { ...context, runId }, args: {} });
const spec = { key: 'vacancies', name: 'vacancies', sources: [{ id: 'channel', kind: 'telegram' as const, resource: peer }], criteria: 'Remote Node.js engineer vacancies; exclude onsite sales and courses.', schedule: '*/5 * * * *', pageSize: 100, maxPages: 1 };
function message(id: number, text = `post ${id}`): TdObject { return { '@type': 'message', id: String(id), chat_id: peer, sender_id: { '@type': 'messageSenderUser', user_id: '42' }, is_outgoing: false, date: 100 + id, edit_date: 0, content: { '@type': 'messageText', text: { '@type': 'formattedText', text, entities: [] } }, can_be_saved: true }; }
class Rpc extends EventEmitter implements TdJsonTransport {
  messages: TdObject[] = [message(1, 'old vacancy')]; offline = false; calls = 0; hold?: Promise<void>; entered?: () => void;
  async invoke(request: TdObject): Promise<TdObject> {
    if (request['@type'] === 'getMe') return { '@type': 'user', id: '42' };
    if (request['@type'] !== 'getChatHistory') return { '@type': 'ok' };
    this.calls++; this.entered?.(); if (this.hold) await this.hold;
    if (this.offline) throw new Error('source offline');
    const before = BigInt(request.from_message_id); return { '@type': 'messages', messages: this.messages.filter(m => !before || BigInt(m.id) <= before).sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0,request.limit) };
  }
  async close() {}
}
async function fixture(options: { maxPendingCandidates?: number; candidateByteBudget?: number; ownerControls?: boolean; hostManagement?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'neurobro-continuous-')), db = join(dir,'state.sqlite'), key = Buffer.alloc(32,11), rpc = new Rpc();
  const telegram = new TdlibTelegram({ accountId: '42', transport: rpc, receipts: new FileTelegramStore(join(dir,'tg'),key) });
  let store = new PersonalStore({ databasePath: db, encryptionKey: key }), allowed = true, coverage: 'snapshot-only'|'gap' = 'snapshot-only';
  const native = new Map<string,{ id: string; key: string; state: string; instruction: string; schedule: string }>(); let creations = 0, cancelFail = false, loseCreate = false;
  const nativeRequests: { method: string; path: string; schedule?: string }[] = [];
  const server = createServer(async (request,response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    nativeRequests.push({method:request.method!,path:request.url!,...(input.schedule ? {schedule:input.schedule} : {})});
    let value: unknown = { ok: true };
    if (request.url === '/cron/jobs') {
      let job = native.get(input.key); if (!job) { job = { id: `native-${++creations}`, key: input.key, state: 'active', instruction: input.instruction, schedule:input.schedule }; native.set(input.key, job); }
      if (loseCreate) { loseCreate = false; request.socket.destroy(); return; }
      value = { ok: true, job };
    } else if (request.url?.startsWith('/cron/lookup/')) {
      const key=decodeURIComponent(request.url.slice('/cron/lookup/'.length)), job=native.get(key);
      value=job ? {ok:true,key,scopeVerified:true,job:{...job,required_admission:'neurobro',admission_key:key}} : {ok:true,key,job:null,absenceVerified:true};
    } else if (/\/(cancel|pause|resume)$/u.test(request.url ?? '')) {
      if (cancelFail) { response.writeHead(500); response.end(JSON.stringify({ ok: false })); return; }
      const id = request.url!.split('/')[3]; for (const job of native.values()) if (job.id === id) job.state = request.url!.endsWith('/resume') ? 'active' : request.url!.endsWith('/pause') ? 'paused' : 'cancelled';
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const nativeUrl = `http://127.0.0.1:${address.port}`;
  const effects = new Map<string, MonitorCandidate>(), sent: MonitorCandidate[] = []; let result: EffectResult = { state: 'verified', receipt: { messageId: 'private-result' } }, throwSend = false;
  const digests: { summary: MonitorDigest; candidates: MonitorCandidate[] }[] = []; let ownerAllowed = true;
  let ownerHook: (()=>void) | undefined, executionHook: (()=>void) | undefined;
  let monitor: ReturnType<typeof createMonitorSource>, coordinator: ContinuousMonitorCoordinator, schedules: HermesScheduleCoordinator;
  const authorize = async (tool: ToolCall, sources: readonly {resource:string}[]) => { if (!allowed || !(options.ownerControls && !sources.length && tool.context.taskId === 'owner-control-task') && (tool.context.taskId !== context.taskId || tool.context.grantId !== context.grantId || tool.context.grantRevision !== context.grantRevision)) throw new Error('current authority denied'); for (const source of sources) assert.equal(source.resource,peer); executionHook?.(); };
  function build() {
    monitor = createMonitorSource({ store, telegram, accountId: '42', authorizeObservation: o => allowed && o.ref.peerId === peer });
    schedules = new HermesScheduleCoordinator({ core: { store, validateScope: scope => { if (!allowed || scope.taskId !== context.taskId || scope.grantId !== context.grantId || scope.grantRevision !== context.grantRevision) throw new Error('authority denied'); }, issueToolContext: () => 'execution-token', revokeToolContext: () => {}, resolveToolContext: () => context }, native: { baseUrl: nativeUrl, registrationKey: 'test-registration-key-longer-than-thirtytwo' } });
    coordinator = new ContinuousMonitorCoordinator({ store, sourceForCall: () => monitor, authorize, schedules, ...options, sourceCoverage: () => coverage,
      ...(options.ownerControls ? { authorizeOwnerControl: async (tool: ToolCall) => { if (!ownerAllowed || !allowed || !['vacancy-task','owner-control-task'].includes(tool.context.taskId) || tool.token !== 'trusted') throw new Error('private owner control denied'); ownerHook?.(); } } : {}),
      ...(options.hostManagement ? { manageSchedule: async (_tool:ToolCall,sub:Readonly<import('../../src/observation/index.ts').Subscription>,action:'pause'|'resume'|'cancel') => action === 'cancel' ? (await schedules.cancelFromHost({ taskId:sub.binding.taskId,scheduleId:sub.scheduleId,key:sub.scheduleKey ?? `monitor-${sub.id}`,nativeJobId:sub.nativeJobId })).schedule : schedules.control({...sub.binding,runId:'trusted-owner-management'},sub.scheduleId!,action) } : {}),
      deliverDigest: async (_tool,summary,candidates,_sub,effectId) => { assert.equal(summary.delivery.effectId,effectId); digests.push({ summary:structuredClone(summary), candidates:structuredClone(candidates) as MonitorCandidate[] }); if (throwSend) throw new Error('digest response lost after dispatch'); return result; },
      deliver: async (_tool,candidate,_sub,effectId) => { assert.ok(candidate.decision?.match); assert.equal(candidate.delivery?.effectId,effectId); if (effects.has(effectId)) return result; effects.set(effectId,structuredClone(candidate)); sent.push(structuredClone(candidate)); if (throwSend) throw new Error('response lost after dispatch'); return result; } });
  } build();
  return { rpc, telegram, native, nativeRequests, effects, sent, digests, db, get monitor() { return monitor; }, get coordinator() { return coordinator; }, get store() { return store; }, get creations() { return creations; },
    async trustedCancel(nativeJobId:string) { const response=await fetch(`${nativeUrl}/cron/jobs/${nativeJobId}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); if(!response.ok)throw new Error('trusted cancellation unknown'); },
    set allowed(value:boolean) { allowed = value; }, set gap(value:boolean) { coverage = value ? 'gap' : 'snapshot-only'; }, set result(value:EffectResult) { result = value; }, set throwSend(value:boolean) { throwSend = value; }, set cancelFail(value:boolean) { cancelFail = value; },
    set ownerAllowed(value:boolean) { ownerAllowed = value; },
    loseCreate() { loseCreate = true; },
    ownerHook(hook:(()=>void)|undefined) { ownerHook = hook; }, executionHook(hook:(()=>void)|undefined) { executionHook = hook; },
    reopen() { store.close(); store = new PersonalStore({ databasePath: db,encryptionKey:key }); build(); },
    async close() { await telegram.close(); store.close(); await new Promise<void>((resolve,reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); } };
}

test('native cron subscription baseline is quiet; semantic decisions privately alert matches and stay deduped after restart', async () => {
  const f = await fixture(); try {
    const sub = await f.coordinator.subscribe(call(),spec); assert.equal(sub.state,'active'); assert.equal(f.sent.length,0); assert.equal(f.creations,1);
    assert.deepEqual(await f.coordinator.subscribe(call('new-foreground'),{ schedule: spec.schedule, criteria: spec.criteria, sources: spec.sources, name: spec.name, key: spec.key, maxPages: spec.maxPages, pageSize: spec.pageSize }),sub); assert.equal(f.creations,1);
    assert.match([...f.native.values()][0]!.instruction,/semantically/);
    const recurring = call(`cron:${sub.nativeJobId}:execution-1`); assert.equal(f.coordinator.isMonitorExecution(recurring.context),true);
    f.rpc.messages.push(message(2,'Distributed server-side JavaScript team hiring across time zones; work from anywhere.'),message(3,'Remote Node.js bootcamp course, not a vacancy'),message(4,'Onsite sales manager'));
    const gathered = await f.coordinator.collect(recurring,sub.id); assert.equal(gathered.candidates.length,3); assert.equal(gathered.criteria,spec.criteria); assert.equal(f.sent.length,0);
    assert.ok(gathered.candidates.every(c => c.state === 'pending')); f.reopen();
    const recovered = await f.coordinator.collect(call('cron:native-1:execution-2'),sub.id); assert.deepEqual(recovered.candidates.map(c=>c.id),gathered.candidates.map(c=>c.id));
    const decisions = recovered.candidates.map(c => ({candidateId:c.id,match:c.alert.itemId==='2',reason:c.alert.itemId==='2'?'Remote engineering vacancy matches the meaning':'Course or onsite non-engineering role'}));
    await f.coordinator.decide(recurring,sub.id,decisions); assert.deepEqual(f.sent.map(c=>c.alert.itemId),['2']);
    await f.coordinator.decide(recurring,sub.id,decisions); f.reopen(); await f.coordinator.collect(call('cron:native-1:execution-3'),sub.id); assert.equal(f.sent.length,1);
    assert.equal((await f.coordinator.collect(recurring,sub.id)).pending,0); await f.coordinator.unsubscribe(call(),sub.id);
    assert.equal([...f.native.values()][0]!.state,'cancelled'); f.rpc.messages.push(message(5,'Remote Node.js developer vacancy'));
    await assert.rejects(f.coordinator.collect(recurring,sub.id),/inactive/); assert.equal(f.sent.length,1);
    assert.equal((await readFile(f.db)).includes(Buffer.from('Distributed server-side')),false);
  } finally { await f.close(); }
});

test('over 100 new posts and arrivals during catchup survive reopen without keyword exclusion or cursor loss', async () => {
  const f = await fixture(); try {
    const sub = await f.coordinator.subscribe(call(),spec);
    for (let id=2;id<=251;id++) f.rpc.messages.push(message(id,`Potential engineer post ${id}`));
    const first = await f.coordinator.collect(call(),sub.id); assert.equal(first.poll?.catchup,true); f.reopen(); f.rpc.messages.push(message(252,'newest'));
    const handled = new Set<string>();
    for (let run=0;run<12;run++) {
      const batch = await f.coordinator.collect(call(`cron:native-1:execution-${run}`),sub.id);
      if (batch.candidates.length) { for (const c of batch.candidates) handled.add(c.alert.itemId); await f.coordinator.decide(call(),sub.id,batch.candidates.map(c=>({candidateId:c.id,match:false,reason:'Semantic assessment: insufficient vacancy details'}))); }
      if (handled.size===251) break;
    }
    assert.equal(handled.size,251); assert.equal(f.sent.length,0); assert.equal(f.creations,1);
  } finally { await f.close(); }
});

test('host journal edits and deletes create new semantic candidates, transport gaps remain explicit across restart', async () => {
  const f = await fixture(); try {
    const sub = await f.coordinator.subscribe(call(),spec); f.rpc.messages.push(message(2,'Remote Node.js developer'));
    const first = await f.coordinator.collect(call(),sub.id); const original = first.candidates[0]!; await f.coordinator.decide(call(),sub.id,[{candidateId:original.id,match:true,reason:'Matches vacancy criteria'}]);
    const edit: Observation = { id:'edit-observation',kind:'edit',ref:{accountId:'42',peerId:peer,messageId:'2'},outgoing:false,sentAt:new Date(102000).toISOString(),observedAt:new Date().toISOString(),editedAt:new Date().toISOString(),text:'Position filled; no longer hiring' };
    await f.monitor.recordObservation(edit); f.gap=true; f.reopen();
    const edited = await f.coordinator.collect(call(),sub.id); assert.equal(edited.sourceCoverage,'gap'); assert.ok(edited.candidates.some(c=>c.alert.kind==='edit'));
    const editedCandidate=edited.candidates.find(c=>c.alert.kind==='edit')!; await f.coordinator.decide(call(),sub.id,[{candidateId:editedCandidate.id,match:false,reason:'No longer hiring'}]);
    await f.monitor.recordObservation({...edit,id:'delete-observation',kind:'delete',text:undefined}); let deleted=await f.coordinator.collect(call(),sub.id); if (!deleted.candidates.some(c=>c.alert.kind==='delete')) deleted=await f.coordinator.collect(call(),sub.id); assert.ok(deleted.candidates.some(c=>c.alert.kind==='delete'));
    f.gap=false; f.reopen(); assert.equal((await f.coordinator.collect(call(),sub.id)).sourceCoverage,'gap'); assert.equal(f.sent.length,1);
  } finally { await f.close(); }
});

test('lost delivery remains UNKNOWN and changed verdict cannot replay after reopen', async () => {
  const f = await fixture(); try {
    const sub=await f.coordinator.subscribe(call(),spec); f.rpc.messages.push(message(2,'Remote developer')); const c=(await f.coordinator.collect(call(),sub.id)).candidates[0]!;
    f.throwSend=true; const verdict={candidateId:c.id,match:true,reason:'Remote development vacancy'}; const delivered=await f.coordinator.decide(call(),sub.id,[verdict]); assert.equal(delivered[0]!.delivery?.state,'unknown'); f.reopen();
    await f.coordinator.decide(call(),sub.id,[verdict]); await f.coordinator.flush(call(),sub.id); assert.equal(f.sent.length,1);
    await assert.rejects(f.coordinator.decide(call(),sub.id,[{...verdict,match:false}]),/immutable/);
    const other={...call(),context:{...context,taskId:'other'}}; await assert.rejects(f.coordinator.decide(other,sub.id,[verdict]),/bound/);
    f.allowed=false; await assert.rejects(f.coordinator.collect(call(),sub.id),/authority/);
  } finally { await f.close(); }
});

test('restart classifies interrupted alert dispatch as UNKNOWN and never retries it', async () => {
  const f=await fixture(); try {
    const sub=await f.coordinator.subscribe(call(),spec); f.rpc.messages.push(message(2,'Remote developer'));
    const candidate=(await f.coordinator.collect(call(),sub.id)).candidates[0]!;
    candidate.state='decided'; candidate.decision={match:true,reason:'Matching vacancy',decidedAt:new Date().toISOString()};
    candidate.delivery={effectId:'exact-interrupted-alert',state:'dispatching'};
    f.store.put('observation/candidates',candidate.id,candidate); f.reopen();
    const inspected=await f.coordinator.inspect(call(),sub.id); assert.equal(inspected.deliveries.unknown,1); assert.equal(inspected.deliveries.dispatching,0);
    const recovered=f.store.get<MonitorCandidate>('observation/candidates',candidate.id)!;
    assert.equal(recovered.delivery?.effectId,'exact-interrupted-alert'); assert.match(recovered.delivery?.reason ?? '',/independent reconciliation/);
    await f.coordinator.flush(call(),sub.id);
    await f.coordinator.decide(call(),sub.id,[{candidateId:candidate.id,match:true,reason:'Matching vacancy'}]);
    assert.equal(f.sent.length,0); assert.equal(f.store.get<MonitorCandidate>('observation/candidates',candidate.id)!.delivery?.state,'unknown');
  } finally { await f.close(); }
});

test('superseded owner authority is checked after baseline before native schedule creation', async () => {
  const f=await fixture(); try {
    f.executionHook(()=>{ if(f.store.list<{baselineComplete:boolean}>('observation/subscriptions').some(s=>s.baselineComplete)) throw new Error('newer owner cadence superseded this execution'); });
    await assert.rejects(f.coordinator.subscribe(call(),spec),/newer owner cadence/);
    f.executionHook(undefined); assert.equal(f.creations,0);
    const prepared=(await f.coordinator.list(call()))[0]!; assert.equal(prepared.state,'prepared'); assert.equal(prepared.baselineComplete,true); assert.equal(prepared.scheduleAttempted,undefined);
  } finally { await f.close(); }
});

test('fresh owner cadence recovers prepared uncertain creation by cancelling its exact key before successor creation', async () => {
  const f=await fixture({ownerControls:true,hostManagement:true}); try {
    const oldSpec={...spec,schedule:'*/15 * * * *'}; f.loseCreate(); await assert.rejects(f.coordinator.subscribe(call(),oldSpec));
    const prepared=(await f.coordinator.list(call()))[0]!;
    assert.equal(prepared.state,'prepared'); assert.equal(prepared.baselineComplete,true); assert.equal(prepared.scheduleAttempted,true); assert.equal(prepared.nativeJobId,undefined);
    const readCalls=f.rpc.calls; f.rpc.messages.push(message(2,'Arrived after original baseline')); f.reopen();
    const owner={...call(),context:{...context,taskId:'owner-control-task',grantId:'fresh-owner-grant'}};
    const successor=await f.coordinator.reschedule(owner,prepared.id,'0 */2 * * *');
    assert.equal(successor.state,'active'); assert.deepEqual(successor.binding,prepared.binding); assert.equal(successor.baselineComplete,true); assert.equal(f.rpc.calls,readCalls);
    assert.equal(successor.scheduleGeneration,2); assert.equal(successor.spec.schedule,'0 */2 * * *'); assert.equal(successor.nativeJobId,'native-2');
    const predecessor=successor.scheduleHistory![0]!; assert.equal(predecessor.nativeJobId,'native-1'); assert.ok(predecessor.scheduleId); assert.equal(predecessor.key,prepared.scheduleKey); assert.equal(predecessor.schedule,'*/15 * * * *');
    assert.deepEqual(f.nativeRequests.filter(r=>r.method==='POST'&&r.path==='/cron/jobs').map(r=>r.schedule),['*/15 * * * *','0 */2 * * *']);
    const lookup=f.nativeRequests.findIndex(r=>r.method==='GET'&&r.path.startsWith('/cron/lookup/'));
    const cancellation=f.nativeRequests.findIndex(r=>r.path==='/cron/jobs/native-1/cancel');
    const creation=f.nativeRequests.findIndex(r=>r.path==='/cron/jobs'&&r.schedule==='0 */2 * * *');
    assert.ok(lookup>=0&&lookup<cancellation&&cancellation<creation);
    assert.equal([...f.native.values()][0]!.state,'cancelled');
    const batch=await f.coordinator.collect(call(`cron:${successor.nativeJobId}:after-recovery`),successor.id);
    assert.deepEqual(batch.candidates.map(c=>c.alert.itemId),['2'],'Original baseline and cursor survive recovery');
  } finally { await f.close(); }
});

test('UNKNOWN predecessor cancellation holds prepared cadence recovery without creating any successor', async () => {
  const f=await fixture({ownerControls:true,hostManagement:true}); try {
    const oldSpec={...spec,schedule:'*/15 * * * *'}; f.loseCreate(); await assert.rejects(f.coordinator.subscribe(call(),oldSpec));
    const prepared=(await f.coordinator.list(call()))[0]!, owner={...call(),context:{...context,taskId:'owner-control-task'}};
    f.cancelFail=true; await assert.rejects(f.coordinator.reschedule(owner,prepared.id,'0 */2 * * *'),/cancellation unconfirmed/);
    f.reopen(); const held=(await f.coordinator.inspect(owner,prepared.id)).subscription;
    assert.equal(held.state,'rescheduling'); assert.equal(held.control?.state,'unknown'); assert.equal(held.control?.predecessorCancelled,undefined); assert.equal(held.scheduleGeneration,1); assert.equal(held.scheduleHistory,undefined);
    assert.equal(f.creations,1); assert.equal(f.nativeRequests.filter(r=>r.path==='/cron/jobs').length,1);
    await assert.rejects(f.coordinator.reschedule(owner,prepared.id,'0 */3 * * *'),/same-action/);
    f.cancelFail=false; const successor=await f.coordinator.reschedule(owner,prepared.id,'0 */2 * * *');
    assert.equal(successor.state,'active'); assert.equal(successor.scheduleGeneration,2); assert.equal(f.creations,2);
    assert.deepEqual(f.nativeRequests.filter(r=>r.path==='/cron/jobs').map(r=>r.schedule),['*/15 * * * *','0 */2 * * *']);
  } finally { await f.close(); }
});

test('candidate capacity rejects whole source page atomically; later semantic decisions resume the same cursor', async () => {
  const f=await fixture({maxPendingCandidates:2}); try {
    const sub=await f.coordinator.subscribe(call(),{...spec,pageSize:2}); f.rpc.messages.push(message(2),message(3),message(4));
    const first=await f.coordinator.collect(call(),sub.id); assert.equal(first.pending,2);
    const blocked=await f.coordinator.collect(call(),sub.id); assert.match(blocked.blocked!,/cursor preserved/); assert.equal(blocked.pending,2);
    await f.coordinator.decide(call(),sub.id,first.candidates.map(c=>({candidateId:c.id,match:false,reason:'Not a vacancy'})));
    const next=await f.coordinator.collect(call(),sub.id); assert.deepEqual(next.candidates.map(c=>c.alert.itemId),['2']);
  } finally { await f.close(); }
});

test('normal long posts are whole in generous batches; actual oversized post requires complete read before exclusion', async () => {
  const f=await fixture({candidateByteBudget:32768}); try {
    const sub=await f.coordinator.subscribe(call(),spec); const text='x'.repeat(60000)+' remote Node.js vacancy'; f.rpc.messages.push(message(2,text));
    const batch=await f.coordinator.collect(call(),sub.id), c=batch.candidates[0]!; assert.equal(c.alert.excerpts.text.truncated,true);
    await assert.rejects(f.coordinator.decide(call(),sub.id,[{candidateId:c.id,match:false,reason:'No relevance seen'}]),/complete saved/);
    f.reopen(); let offset=0, full=''; do { const part=await f.coordinator.readCandidate(call(),sub.id,c.id,offset,16384); full+=part.text; offset=part.nextOffset; if(part.complete)break; } while(offset<100000);
    assert.equal(full,'\n'+text); await f.coordinator.decide(call(),sub.id,[{candidateId:c.id,match:false,reason:'Read complete version; not actually a vacancy'}]);
  } finally { await f.close(); }
  const generous=await fixture(); try {
    const sub=await generous.coordinator.subscribe(call(),spec); const text='Post context '.repeat(3000)+'Remote Node.js vacancy'; generous.rpc.messages.push(message(2,text)); const c=(await generous.coordinator.collect(call(),sub.id)).candidates[0]!;
    assert.equal(c.alert.text,text); assert.equal(c.alert.excerpts.text.truncated,false); await generous.coordinator.decide(call(),sub.id,[{candidateId:c.id,match:false,reason:'Full-post semantic decision'}]);
  } finally { await generous.close(); }
});

test('unsubscribe racing source read withdraws admission before native cancellation response; failure stays cancelling', async () => {
  const f=await fixture(); try {
    const sub=await f.coordinator.subscribe(call(),spec); f.rpc.messages.push(message(2,'Remote vacancy'));
    let release!:()=>void, entered!:()=>void; f.rpc.hold=new Promise<void>(resolve=>{release=resolve;}); const readEntered=new Promise<void>(resolve=>{entered=resolve;}); f.rpc.entered=entered;
    const collect=f.coordinator.collect(call(),sub.id); await readEntered; f.cancelFail=true; const cancel=f.coordinator.unsubscribe(call(),sub.id); await new Promise(resolve=>setImmediate(resolve)); release();
    await assert.rejects(collect,/withdrawn/); await assert.rejects(cancel,/rejected/); assert.equal((await f.coordinator.inspect(call(),sub.id)).subscription.state,'cancelling'); assert.equal(f.sent.length,0);
    await assert.rejects(f.coordinator.collect(call(),sub.id),/inactive/); f.cancelFail=false; assert.equal((await f.coordinator.unsubscribe(call(),sub.id)).state,'cancelled');
  } finally { await f.close(); }
});

test('tool schemas expose semantic verdict lifecycle without model-selected private destinations or host IDs', async()=>{
  const f=await fixture(); try { const tools=createObservationTools(f.coordinator); assert.deepEqual(tools.map(t=>t.name),['monitors.subscribe','monitors.list','monitors.inspect','monitors.collect','monitors.candidate_read','monitors.decide','monitors.unsubscribe','monitors.pause','monitors.resume','monitors.reschedule']); for(const tool of tools) { assert.deepEqual(tool.resources({},context),[context.taskId]); const serialized=JSON.stringify(tool.inputSchema); assert.doesNotMatch(serialized,/peerId|hostId|path|destination/); } } finally { await f.close(); }
});

test('trusted policy withdrawal fences a revoked in-flight read synchronously; UNKNOWN native cleanup survives restart without renewing authority', async()=>{
  const f=await fixture(); try {
    const sub=await f.coordinator.subscribe(call(),spec); f.rpc.messages.push(message(2,'Remote engineering vacancy')); const pending=await f.coordinator.collect(call(),sub.id); assert.equal(pending.pending,1);
    let release!:()=>void, entered!:()=>void; f.rpc.hold=new Promise<void>(resolve=>{release=resolve;}); const readEntered=new Promise<void>(resolve=>{entered=resolve;}); f.rpc.entered=entered;
    const collecting=f.coordinator.collect(call(),sub.id); await readEntered; f.allowed=false;
    const withdrawn=f.coordinator.withdrawInvalidSubscriptions(()=>false); assert.equal(withdrawn[0]!.state,'cancelling');
    const cleaning=f.coordinator.cancelWithdrawn(async record=>{ await f.trustedCancel(record.nativeJobId!); throw new Error('cancellation response lost'); }); release();
    await assert.rejects(collecting,/authority|withdrawn/); const unknown=await cleaning; assert.equal(unknown[0]!.cancellation?.state,'unknown'); assert.equal(unknown[0]!.state,'cancelling');
    f.reopen(); await assert.rejects(f.coordinator.decide(call(),sub.id,[{candidateId:pending.candidates[0]!.id,match:true,reason:'match'}]),/authority/);
    const settled=await f.coordinator.cancelWithdrawn(async record=>{ assert.equal(record.binding.grantRevision,1); await f.trustedCancel(record.nativeJobId!); }); assert.equal(settled[0]!.state,'cancelled'); assert.equal(f.sent.length,0);
    assert.equal(f.coordinator.withdrawInvalidSubscriptions(()=>false).length,0); assert.equal(f.coordinator.isMonitorExecution(call('cron:native-1:after-cancel').context),true);
  } finally { await f.close(); }
});

test('digest freezes only semantic matches once per completed assessment; restart and empty cycles stay quiet', async () => {
  const f = await fixture(); try {
    const sub = await f.coordinator.subscribe(call(), { ...spec, deliveryMode: 'digest' });
    const run = call(`cron:${sub.nativeJobId}:digest-1`);
    f.rpc.messages.push(message(2,'Remote Node vacancy'), message(3,'Onsite sales'), message(4,'Remote engineering vacancy'));
    const batch = await f.coordinator.collect(run, sub.id);
    await f.coordinator.decide(run, sub.id, batch.candidates.slice(0,1).map(c => ({ candidateId:c.id, match:true, reason:'Owner criteria match' })));
    await f.coordinator.completeExecution(run); assert.equal(f.digests.length,0, 'Unassessed candidates block a complete digest');
    await f.coordinator.decide(run, sub.id, batch.candidates.slice(1).map(c => ({ candidateId:c.id, match:c.alert.itemId !== '3', reason:'Semantic assessment' })));
    assert.equal(f.sent.length,0); assert.equal(f.digests.length,0);
    f.reopen(); await f.coordinator.completeExecution(run);
    assert.equal(f.digests.length,1); assert.deepEqual(f.digests[0]!.candidates.map(c=>c.alert.itemId).sort(),['2','4']);
    assert.ok(f.digests[0]!.candidates.every(c=>c.delivery?.effectId===f.digests[0]!.summary.delivery.effectId));
    await f.coordinator.completeExecution(run); f.reopen(); await f.coordinator.completeExecution(run); assert.equal(f.digests.length,1);
    f.rpc.messages.push(message(5,'New remote Node vacancy')); const late=await f.coordinator.collect(run,sub.id); await f.coordinator.decide(run,sub.id,late.candidates.map(c=>({candidateId:c.id,match:true,reason:'Late matching version'}))); await f.coordinator.completeExecution(run); assert.equal(f.digests.length,1,'A closed execution cannot send a second digest');
    const next=call(`cron:${sub.nativeJobId}:digest-next`); await f.coordinator.collect(next,sub.id); await f.coordinator.completeExecution(next); assert.equal(f.digests.length,2);
    const unchanged = call(`cron:${sub.nativeJobId}:digest-2`); await f.coordinator.collect(unchanged,sub.id); await f.coordinator.completeExecution(unchanged); assert.equal(f.digests.length,2);
    assert.equal((await f.coordinator.inspect(call(),sub.id)).digests[0]!.delivery.state,'verified');
  } finally { await f.close(); }
});

test('uncertain successor creation reconciles the same generation after restart without re-baseline or duplicate native jobs', async () => {
  const f=await fixture({ownerControls:true}); try {
    const sub=await f.coordinator.subscribe(call(),{...spec,deliveryMode:'digest'}); f.rpc.messages.push(message(2));
    const batch=await f.coordinator.collect(call(),sub.id); const owner={...call(),context:{...context,taskId:'owner-control-task'}};
    f.loseCreate(); await assert.rejects(f.coordinator.reschedule(owner,sub.id,'0 */2 * * *'));
    assert.equal(f.creations,2); f.reopen(); const uncertain=(await f.coordinator.inspect(owner,sub.id)).subscription;
    assert.equal(uncertain.state,'rescheduling'); assert.equal(uncertain.control?.state,'unknown'); assert.equal(uncertain.scheduleGeneration,2);
    await assert.rejects(f.coordinator.reschedule(owner,sub.id,'0 */4 * * *'),/same-action/);
    const repaired=await f.coordinator.reschedule(owner,sub.id,'0 */2 * * *'); assert.equal(repaired.state,'active'); assert.equal(f.creations,2); assert.equal(repaired.scheduleHistory?.length,1);
    const recovered=await f.coordinator.collect(call(`cron:${repaired.nativeJobId}:fresh`),sub.id); assert.deepEqual(recovered.candidates.map(c=>c.id),batch.candidates.map(c=>c.id)); assert.equal(f.digests.length,0);
  } finally { await f.close(); }
});

test('UNKNOWN digest is never rebatched or retried; later independent versions form a new digest', async () => {
  const f = await fixture(); try {
    const sub = await f.coordinator.subscribe(call(), { ...spec, deliveryMode: 'digest' }); const run=call(`cron:${sub.nativeJobId}:unknown-1`);
    f.rpc.messages.push(message(2,'Remote Node vacancy')); const batch=await f.coordinator.collect(run,sub.id);
    await f.coordinator.decide(run,sub.id,batch.candidates.map(c=>({candidateId:c.id,match:true,reason:'Matches'}))); f.throwSend=true;
    await f.coordinator.completeExecution(run); assert.equal(f.digests.length,1); f.reopen(); f.throwSend=false;
    await f.coordinator.completeExecution(run); const next=call(`cron:${sub.nativeJobId}:unknown-2`); await f.coordinator.collect(next,sub.id); await f.coordinator.completeExecution(next); assert.equal(f.digests.length,1);
    const fresh=call(`cron:${sub.nativeJobId}:unknown-3`); f.rpc.messages.push(message(3,'Remote engineer vacancy')); const newBatch=await f.coordinator.collect(fresh,sub.id);
    await f.coordinator.decide(fresh,sub.id,newBatch.candidates.map(c=>({candidateId:c.id,match:true,reason:'New exact version matches'}))); await f.coordinator.completeExecution(fresh);
    assert.equal(f.digests.length,2); assert.deepEqual(f.digests[1]!.candidates.map(c=>c.alert.itemId),['3']);
    const saved=await f.coordinator.inspect(call(),sub.id); assert.equal(saved.deliveries.unknown,1); assert.equal(saved.deliveries.verified,1);
  } finally { await f.close(); }
});

test('digest waits for bounded catchup; paused monitor retains decisions and original cursor through resume and reschedule', async () => {
  const f=await fixture({ownerControls:true}); try {
    const sub=await f.coordinator.subscribe(call(),{...spec,deliveryMode:'digest',pageSize:2}); const run=call(`cron:${sub.nativeJobId}:catchup-1`);
    f.rpc.messages.push(message(2),message(3),message(4)); const first=await f.coordinator.collect(run,sub.id); assert.equal(first.poll?.catchup,true);
    await f.coordinator.decide(run,sub.id,first.candidates.map(c=>({candidateId:c.id,match:true,reason:'Matches'}))); await f.coordinator.completeExecution(run); assert.equal(f.digests.length,0);
    const owner={...call(),context:{...context,taskId:'owner-control-task',grantId:'fresh-owner-grant'}};
    assert.equal((await f.coordinator.list(owner))[0]!.id,sub.id);
    await f.coordinator.control(owner,sub.id,'pause'); await assert.rejects(f.coordinator.collect(run,sub.id),/inactive/);
    f.reopen(); assert.equal((await f.coordinator.inspect(owner,sub.id)).subscription.state,'paused');
    await f.coordinator.control(owner,sub.id,'resume'); const changed=await f.coordinator.reschedule(owner,sub.id,'0 */2 * * *');
    assert.deepEqual(changed.binding,sub.binding); assert.equal(changed.spec.schedule,'0 */2 * * *'); assert.equal(f.creations,2); assert.equal(changed.scheduleHistory?.length,1);
    assert.equal(f.coordinator.isMonitorExecution(run.context),true,'Old monitor completion must not become ordinary scheduled output');
    assert.equal([...f.native.values()][0]!.state,'cancelled'); assert.equal(changed.nativeJobId,'native-2');
    assert.equal((await f.coordinator.reschedule(owner,sub.id,'0 */2 * * *')).id,sub.id); assert.equal(f.creations,2);
    const successor=call(`cron:${changed.nativeJobId}:catchup-2`);
    for (let round=0;round<4;round++) { const batch=await f.coordinator.collect(successor,sub.id); if(batch.candidates.length)await f.coordinator.decide(successor,sub.id,batch.candidates.map(c=>({candidateId:c.id,match:true,reason:'Matches'}))); if(!batch.poll?.catchup)break; }
    await f.coordinator.completeExecution(successor); assert.equal(f.digests.length,1); assert.deepEqual(f.digests[0]!.candidates.map(c=>c.alert.itemId).sort(),['2','3','4']);
    f.ownerAllowed=false; assert.deepEqual(await f.coordinator.list(owner),[]); await assert.rejects(f.coordinator.control(owner,sub.id,'pause'),/owner control/);
    f.ownerAllowed=true; await f.coordinator.unsubscribe(owner,sub.id); assert.equal([...f.native.values()][1]!.state,'cancelled');
  } finally { await f.close(); }
});

test('pause fences a read before native response; opposite transition cannot bypass UNKNOWN control after restart', async () => {
  const f=await fixture({ownerControls:true}); try {
    const sub=await f.coordinator.subscribe(call(),spec); f.rpc.messages.push(message(2)); let release!:()=>void, entered!:()=>void;
    f.rpc.hold=new Promise<void>(resolve=>{release=resolve;}); const readEntered=new Promise<void>(resolve=>{entered=resolve;}); f.rpc.entered=entered;
    const collecting=f.coordinator.collect(call(),sub.id); await readEntered; f.cancelFail=true;
    const owner={...call(),context:{...context,taskId:'owner-control-task'}}; const pause=f.coordinator.control(owner,sub.id,'pause'); await new Promise(resolve=>setImmediate(resolve)); release();
    await assert.rejects(collecting,/withdrawn/); await assert.rejects(pause,/rejected/); f.reopen();
    assert.equal((await f.coordinator.inspect(owner,sub.id)).subscription.control?.state,'unknown');
    await assert.rejects(f.coordinator.control(owner,sub.id,'resume'),/same-action/); f.cancelFail=false;
    assert.equal((await f.coordinator.control(owner,sub.id,'pause')).state,'paused'); assert.equal((await f.coordinator.control(owner,sub.id,'resume')).state,'active');
    assert.equal(f.sent.length,0); assert.equal(f.creations,1);
  } finally { await f.close(); }
});

test('trusted cancellation UNKNOWN never becomes verified; prepared-generation route classification uses the saved native key', async () => {
  const f=await fixture({ownerControls:true,hostManagement:true}); try {
    const sub=await f.coordinator.subscribe(call(),spec), execution=call(`cron:${sub.nativeJobId}:activation-gap`);
    const pending={...sub,state:'prepared' as const}; delete pending.nativeJobId; f.store.put('observation/subscriptions',sub.id,pending);
    assert.equal(f.coordinator.isMonitorExecution(execution.context),true,'Durable native key covers activation readback gap');
    assert.equal(f.coordinator.isMonitorExecution({...execution.context,grantRevision:2}),false);
    f.store.put('observation/subscriptions',sub.id,sub); f.cancelFail=true;
    await assert.rejects(f.coordinator.unsubscribe(call(),sub.id),/reconciliation/); assert.equal((await f.coordinator.inspect(call(),sub.id)).subscription.cancellation?.state,'unknown');
    f.reopen(); assert.equal((await f.coordinator.inspect(call(),sub.id)).subscription.state,'cancelling'); f.cancelFail=false;
    assert.equal((await f.coordinator.unsubscribe(call(),sub.id)).state,'cancelled');
  } finally { await f.close(); }
});

test('withdrawal between owner helper return and caller continuation cannot revive a monitor control', async () => {
  for (const action of ['pause','reschedule'] as const) {
    const f=await fixture({ownerControls:true}); try {
      const sub=await f.coordinator.subscribe(call(),spec); const owner={...call(),context:{...context,taskId:'owner-control-task'}};
      f.ownerHook(()=>{ f.ownerHook(undefined); queueMicrotask(()=>queueMicrotask(()=>{f.coordinator.withdrawInvalidSubscriptions(()=>false);})); });
      await assert.rejects(action==='pause'?f.coordinator.control(owner,sub.id,'pause'):f.coordinator.reschedule(owner,sub.id,'0 */2 * * *'),/current state|before changing/);
      assert.equal((await f.coordinator.inspect(owner,sub.id)).subscription.state,'cancelling'); assert.equal(f.creations,1); assert.equal(f.sent.length,0);
    } finally { await f.close(); }
  }
});

test('withdrawal after digest freeze cancels preparation before the dispatch transaction', async () => {
  const f=await fixture(); try {
    const sub=await f.coordinator.subscribe(call(),{...spec,deliveryMode:'digest'}),run=call(`cron:${sub.nativeJobId}:digest-race`);
    f.rpc.messages.push(message(2)); const batch=await f.coordinator.collect(run,sub.id); await f.coordinator.decide(run,sub.id,batch.candidates.map(c=>({candidateId:c.id,match:true,reason:'Matches'})));
    let checks=0; f.executionHook(()=>{ if(++checks===2)queueMicrotask(()=>queueMicrotask(()=>{f.coordinator.withdrawInvalidSubscriptions(()=>false);})); });
    await assert.rejects(f.coordinator.completeExecution(run),/withdrawn/); f.executionHook(undefined);
    const saved=await f.coordinator.inspect(call(),sub.id); assert.equal(saved.subscription.state,'cancelling'); assert.equal(saved.digests[0]!.delivery.state,'cancelled'); assert.equal(f.digests.length,0);
  } finally { await f.close(); }
});
