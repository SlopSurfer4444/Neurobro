import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PersonalStore } from '../../src/core/store.ts';
import { createMonitorSource, type DurableMonitorSource } from '../../src/monitor-source.ts';
import { TdlibTelegram, FileTelegramStore, type TdObject, type TdJsonTransport } from '../../src/telegram/index.ts';
import { JobService, type JobRecord, type JobStore, type JobSource } from '../../src/capabilities/jobs.ts';
import { WebService } from '../../src/capabilities/web.ts';
import type { Observation, ToolContext } from '../../src/contracts.ts';

const peer = '-100123', source: JobSource = { id: 'channel', kind: 'telegram', resource: peer };
const context: ToolContext = { taskId: 'task', intentRevision: 1, grantId: 'g', grantRevision: 1, runId: 'r' };
const stateKey = createHash('sha256').update(JSON.stringify(source.id)).digest('hex');
function message(id: string, text = `item ${id}`): TdObject {
  return { '@type': 'message', id, chat_id: peer, sender_id: { '@type': 'messageSenderUser', user_id: '42' }, is_outgoing: false, date: 100,
    edit_date: 0, content: { '@type': 'messageText', text: { '@type': 'formattedText', text, entities: [] } }, can_be_saved: true };
}
class FakeRpc extends EventEmitter implements TdJsonTransport {
  messages: TdObject[] = []; calls: TdObject[] = []; offline = false; partial?: number; emptyBefore?: string;
  async invoke(request: TdObject): Promise<TdObject> {
    this.calls.push(structuredClone(request));
    if (request['@type'] === 'getMe') return { '@type': 'user', id: '42' };
    if (request['@type'] !== 'getChatHistory') return { '@type': 'ok' };
    if (this.offline) throw new Error('fixture offline');
    if (this.emptyBefore === String(request.from_message_id)) return { '@type': 'messages', messages: [] };
    const before = BigInt(request.from_message_id);
    const rows = this.messages.filter(m => before === 0n || BigInt(m.id) <= before).sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
    return { '@type': 'messages', total_count: rows.length, messages: rows.slice(0, this.partial ?? request.limit) };
  }
  async close(): Promise<void> {}
  add(from: number, to: number) { for (let n = from; n <= to; n++) this.messages.push(message(String(n))); }
}
async function fixture(authorizeObservation?: (o: Observation) => boolean, maxJournalEventsPerSource?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'neurobro-monitor-'));
  const database = join(directory, 'state.sqlite'), key = Buffer.alloc(32, 7), rpc = new FakeRpc();
  const telegram = new TdlibTelegram({ accountId: '42', transport: rpc, receipts: new FileTelegramStore(join(directory, 'telegram'), key) });
  let store = new PersonalStore({ databasePath: database, encryptionKey: key });
  const jobStore: JobStore = {
    async load(taskId, id) { return store.get<JobRecord>('jobs', `${taskId}/${id}`); },
    async list(taskId, limit) { return store.list<JobRecord>('jobs').filter(j => j.binding.taskId === taskId).slice(0, limit); },
    async save(record, version) { return store.transaction(() => {
      const id = `${record.binding.taskId}/${record.id}`, old = store.get<JobRecord>('jobs', id);
      if (old ? old.version !== version : version !== undefined) return false; store.put('jobs', id, record); return true;
    }); },
  };
  let monitor: DurableMonitorSource, jobs: JobService;
  const build = () => {
    monitor = createMonitorSource({ store, telegram, accountId: '42', authorizeObservation, maxJournalEventsPerSource });
    jobs = new JobService({ store: jobStore, source: monitor, validateContext: async (_ctx, sources) => { for (const s of sources) assert.equal(s.resource, peer); } });
  }; build();
  return { rpc, telegram, database, get store() { return store; }, get monitor() { return monitor; }, get jobs() { return jobs; },
    reopen() { store.close(); store = new PersonalStore({ databasePath: database, encryptionKey: key }); build(); },
    async close() { await telegram.close(); store.close(); } };
}
async function create(f: Awaited<ReturnType<typeof fixture>>, options: { pageSize?: number; maxPages?: number; maxTrackedItems?: number } = {}) {
  return f.jobs.create(context, { id: 'monitor', name: 'watch', sources: [source], pageSize: options.pageSize ?? 50, maxPages: options.maxPages ?? 1, maxTrackedItems: options.maxTrackedItems ?? 4096 });
}

test('actual TdlibTelegram plus encrypted JobService checks fresh head after every completed cycle and restart', async () => {
  const f = await fixture(); try {
    f.rpc.add(1, 3); await create(f); const initial = await f.jobs.poll(context, 'monitor', 1); assert.deepEqual(initial.alerts.map(a => a.itemId).sort(), ['1', '2', '3']);
    assert.equal(f.monitor.coverage(source, initial.job.sourceStates[stateKey]!.cursor).initialHistory, 'bounded-snapshot');
    f.rpc.add(4, 4); f.reopen(); const next = await f.jobs.poll(context, 'monitor', 1); assert.deepEqual(next.alerts.map(a => a.itemId), ['4']);
    const idle = await f.jobs.poll(context, 'monitor', 1); assert.deepEqual(idle.alerts, []);
    assert.equal(f.rpc.calls.filter(c => c['@type'] === 'getChatHistory').at(-1)!.from_message_id, '0');
    assert.equal(f.monitor.coverage(source, idle.job.sourceStates[stateKey]!.cursor).committedHead, '4');
  } finally { await f.close(); }
});
test('more than 100 arrivals catch up across bounded polls/restart; arrivals during scan wait for next fixed-head cycle', async () => {
  const f = await fixture(); try {
    f.rpc.add(1, 1); await create(f, { pageSize: 100 }); await f.jobs.poll(context, 'monitor', 1);
    f.rpc.add(2, 251); const seen = new Set<string>(); let result = await f.jobs.poll(context, 'monitor', 1);
    result.alerts.forEach(a => seen.add(a.itemId)); const cursor = result.job.sourceStates[stateKey]!.cursor;
    assert.equal(f.monitor.coverage(source, cursor).committedHead, '1'); assert.equal(f.monitor.coverage(source, cursor).scanHead, '251');
    f.reopen(); f.rpc.add(252, 350);
    for (let n = 0; n < 12 && seen.size < 349; n++) { result = await f.jobs.poll(context, 'monitor', 1); result.alerts.forEach(a => seen.add(a.itemId)); }
    assert.equal(seen.size, 349); for (let n = 2; n <= 350; n++) assert.ok(seen.has(String(n)));
    assert.equal(f.monitor.coverage(source, result.job.sourceStates[stateKey]!.cursor).committedHead, '350');
    assert.ok(f.rpc.calls.filter(c => c['@type'] === 'getChatHistory').every(c => c.limit <= 100));
  } finally { await f.close(); }
});
test('inclusive anchors, same-page boundary and deleted old watermark work with exact huge decimal IDs', async () => {
  const f = await fixture(); try {
    const base = 9007199254740989n; f.rpc.messages = [message(String(base)), message(String(base - 1n))];
    const initial = await f.monitor.read(source, undefined, 1); assert.equal(f.monitor.coverage(source, initial.cursor).committedHead, String(base));
    f.rpc.messages = [message(String(base + 2n)), message(String(base - 1n))];
    const added = await f.monitor.read(source, initial.cursor, 1); assert.equal(added.changes[0]!.itemId, String(base + 2n)); assert.equal(added.hasMore, true);
    const boundary = await f.monitor.read(source, added.cursor, 1); assert.equal(boundary.hasMore, false); assert.equal(f.monitor.coverage(source, boundary.cursor).committedHead, String(base + 2n));
    assert.equal(f.rpc.calls.at(-1)!.limit, 2);
  } finally { await f.close(); }
});
test('short and empty TDLib partial pages preserve the boundary and recover without declaring exhaustion', async () => {
  const f = await fixture(); try {
    f.rpc.add(1, 1); await create(f, { pageSize: 5 }); await f.jobs.poll(context, 'monitor', 1); f.rpc.add(2, 10); f.rpc.partial = 2;
    const first = await f.jobs.poll(context, 'monitor', 1); assert.equal(first.job.sourceStates[stateKey]!.status, 'catchup');
    const cursor = first.job.sourceStates[stateKey]!.cursor!; const scanBefore = f.monitor.coverage(source, cursor).scanBefore!;
    f.rpc.emptyBefore = scanBefore; const gap = await f.jobs.poll(context, 'monitor', 1);
    assert.equal(gap.job.sourceStates[stateKey]!.status, 'lost'); assert.equal(gap.job.sourceStates[stateKey]!.cursor, cursor);
    assert.ok(gap.alerts.some(a => a.kind === 'source-lost')); f.rpc.emptyBefore = undefined;
    const seen = new Set(first.alerts.map(a => a.itemId));
    for (let n = 0; n < 15; n++) { const next = await f.jobs.poll(context, 'monitor', 1); next.alerts.filter(a => a.itemId).forEach(a => seen.add(a.itemId)); if (f.monitor.coverage(source, next.job.sourceStates[stateKey]!.cursor).committedHead === '10') break; }
    assert.equal(seen.size, 9);
  } finally { await f.close(); }
});
test('an empty initial snapshot never silently rebases over later arrivals; unprovable zero boundary is explicit', async () => {
  const f = await fixture(); try {
    const empty = await f.monitor.read(source, undefined, 100); assert.equal(empty.changes.length, 0); f.rpc.add(1, 150);
    const first = await f.monitor.read(source, empty.cursor, 100); assert.equal(first.hasMore, true);
    const second = await f.monitor.read(source, first.cursor, 100); assert.equal(first.changes.length + second.changes.length, 150);
    const gap = await f.monitor.read(source, second.cursor, 100); assert.equal(gap.unavailable, true); assert.equal(gap.cursor, undefined);
    assert.equal(f.monitor.coverage(source, second.cursor).committedHead, '0');
  } finally { await f.close(); }
});
test('scope-authenticated opaque cursors and capacity replay cannot advance or redirect unadmitted history', async () => {
  const f = await fixture(); try {
    f.rpc.add(1, 1); await create(f, { pageSize: 2, maxTrackedItems: 1 }); const initial = await f.jobs.poll(context, 'monitor', 1);
    const cursor = initial.job.sourceStates[stateKey]!.cursor!;
    await assert.rejects(f.monitor.read({ ...source, resource: '-999' }, cursor, 2), /binding mismatch/);
    await assert.rejects(f.monitor.read(source, '1', 2), /opaque/);
    f.rpc.add(2, 3); const rejected = await f.jobs.poll(context, 'monitor', 1); assert.equal(rejected.job.sourceStates[stateKey]!.status, 'capacity'); assert.equal(rejected.job.sourceStates[stateKey]!.cursor, cursor);
    const calls = f.rpc.calls.length; f.rpc.add(4, 4); const replay = await f.jobs.poll(context, 'monitor', 1); assert.equal(replay.job.sourceStates[stateKey]!.cursor, cursor); assert.equal(f.rpc.calls.length, calls);
    assert.equal(f.monitor.coverage(source, cursor).committedHead, '1');
  } finally { await f.close(); }
});
test('only registered currently authorized source edits/deletes enter encrypted journal; versions ignore read timestamps', async () => {
  let authorized = true; const f = await fixture(o => authorized && o.ref.peerId === peer); try {
    f.rpc.add(1, 3); await create(f); const initial = await f.jobs.poll(context, 'monitor', 1);
    const original = (await f.telegram.readHistory(peer, { limit: 3 }))[0]!;
    const edit: Observation = { ...original, id: 'edit', kind: 'edit', text: 'private edit marker', editedAt: '2026-10-04T00:00:00Z' };
    await f.monitor.recordObservation({ ...edit, ref: { ...edit.ref, peerId: '-888' } }); assert.equal(f.store.list('monitor-source/journal').length, 0);
    await f.monitor.recordObservation(edit); await f.monitor.recordObservation({ ...edit, id: 'replayed', observedAt: '2026-10-04T01:00:00Z' });
    authorized = false; await f.monitor.recordObservation({ ...edit, id: 'revoked', text: 'not authorized' }); assert.equal(f.store.list('monitor-source/journal').length, 1);
    f.reopen(); const edited = await f.jobs.poll(context, 'monitor', 1); assert.ok(edited.alerts.some(a => a.kind === 'edit' && a.text === 'private edit marker'));
    authorized = true; await f.monitor.recordObservation({ ...edit, id: 'deleted', kind: 'delete', text: undefined });
    const firstDelete = await f.jobs.poll(context, 'monitor', 1), nextDelete = await f.jobs.poll(context, 'monitor', 1);
    assert.ok([...firstDelete.alerts, ...nextDelete.alerts].some(a => a.kind === 'delete'));
    assert.ok(!Buffer.from(await readFile(f.database)).includes(Buffer.from('private edit marker')));
    assert.equal(f.monitor.coverage(source, initial.job.sourceStates[stateKey]!.cursor).updates, 'authorized-host-journal');
  } finally { await f.close(); }
});

test('a later job using the same source gets a fresh independent start-now baseline', async () => {
  const f=await fixture(); try {
    f.rpc.add(1,1); await create(f); const first=await f.jobs.poll(context,'monitor',1);
    assert.equal(f.monitor.coverage(source,first.job.sourceStates[stateKey]!.cursor).committedHead,'1');
    f.rpc.add(2,3); f.reopen();
    await f.jobs.create(context,{id:'new-monitor',name:'later watch',sources:[source],pageSize:50,maxPages:1});
    const next=await f.jobs.poll(context,'new-monitor',1);
    assert.equal(f.monitor.coverage(source,next.job.sourceStates[stateKey]!.cursor).committedHead,'3');
    assert.deepEqual(next.alerts.map(a=>a.itemId).sort(),['1','2','3']);
    const unchanged=await f.jobs.poll(context,'new-monitor',1); assert.equal(unchanged.alerts.length,0);
  } finally { await f.close(); }
});

test('removing and readding a source uses a fresh bootstrap without resetting unchanged sources', async () => {
  const f=await fixture(); try {
    f.rpc.add(1,1); await create(f); const initial=await f.jobs.poll(context,'monitor',1);
    const cursor=initial.job.sourceStates[stateKey]!.cursor;
    await f.jobs.update(context,'monitor',1,{pageSize:25});
    assert.equal((await f.jobs.inspect(context,'monitor')).sourceStates[stateKey]!.cursor,cursor);
    await f.jobs.update(context,'monitor',2,{sources:[{...source,id:'temporary-watch'}]});
    f.rpc.add(2,3); await f.jobs.poll(context,'monitor',3);
    await f.jobs.update(context,'monitor',3,{sources:[source]}); f.rpc.add(4,4); f.reopen();
    const readded=await f.jobs.poll(context,'monitor',4);
    assert.equal(f.monitor.coverage(source,readded.job.sourceStates[stateKey]!.cursor).committedHead,'4');
    assert.equal(readded.job.sourceStates[stateKey]!.bootstrapRevision,4);
  } finally { await f.close(); }
});

test('a smaller retry drains the exact rejected page before reading a newer head', async () => {
  const f=await fixture(); try {
    f.rpc.add(1,1); const baseline=await f.monitor.read(source,undefined,2,'bounded-replay');
    f.rpc.add(2,3); const unadmitted=await f.monitor.read(source,baseline.cursor,2); assert.deepEqual(unadmitted.changes.map(c=>c.itemId),['3','2']);
    f.rpc.add(4,4); const calls=f.rpc.calls.length; f.reopen();
    const prefix=await f.monitor.read(source,baseline.cursor,1); assert.deepEqual(prefix.changes.map(c=>c.itemId),['3']); assert.equal(prefix.hasMore,true);
    assert.deepEqual(await f.monitor.read(source,baseline.cursor,1),prefix); assert.equal(f.rpc.calls.length,calls);
    const tail=await f.monitor.read(source,prefix.cursor,1); assert.deepEqual(tail.changes.map(c=>c.itemId),['2']); assert.equal(f.rpc.calls.length,calls);
    const boundary=await f.monitor.read(source,tail.cursor,1); assert.equal(boundary.changes.length,0);
    const newer=await f.monitor.read(source,boundary.cursor,1); assert.deepEqual(newer.changes.map(c=>c.itemId),['4']);
  } finally { await f.close(); }
});

test('an immutable page captured in the prior cache format survives upgrade, smaller limits and restart', async () => {
  const f=await fixture(); try {
    const hash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
    f.rpc.add(1,1); const baseline=await f.monitor.read(source,undefined,2); f.rpc.add(2,3);
    const original=await f.monitor.read(source,baseline.cursor,2), sourceKey=hash({accountId:'42',id:source.id,kind:source.kind,resource:source.resource});
    const legacyKey=hash([sourceKey,baseline.cursor,2]); f.store.put('monitor-source/pages',legacyKey,original);
    f.store.delete('monitor-source/pages',hash([sourceKey,baseline.cursor])); f.rpc.add(4,4); const calls=f.rpc.calls.length; f.reopen();
    const prefix=await f.monitor.read(source,baseline.cursor,1); assert.deepEqual(prefix.changes.map(c=>c.itemId),['3']);
    const tail=await f.monitor.read(source,prefix.cursor,1); assert.deepEqual(tail.changes.map(c=>c.itemId),['2']); assert.equal(f.rpc.calls.length,calls);
    assert.deepEqual(f.store.get('monitor-source/pages',legacyKey),original,'Prior receipt remains unchanged');
  } finally { await f.close(); }
});
test('default observation authorization denies retention; journal bound advertises a gap and never silently evicts', async () => {
  const f = await fixture(undefined); try {
    f.rpc.add(1, 1); const page = await f.monitor.read(source, undefined, 2); const row = (await f.telegram.readHistory(peer, { limit: 1 }))[0]!;
    await f.monitor.recordObservation({ ...row, kind: 'edit' }); assert.equal(f.store.list('monitor-source/journal').length, 0);
    assert.equal(f.monitor.coverage(source, page.cursor).updates, 'head-snapshots-only');
  } finally { await f.close(); }
  const g = await fixture(() => true, 1); try {
    g.rpc.add(1, 1); const page = await g.monitor.read(source, undefined, 2); const row = (await g.telegram.readHistory(peer, { limit: 1 }))[0]!;
    await g.monitor.recordObservation({ ...row, kind: 'edit', text: 'first' }); await g.monitor.recordObservation({ ...row, kind: 'edit', text: 'second' });
    assert.equal(g.store.list('monitor-source/journal').length, 1); assert.match(g.monitor.coverage(source, page.cursor).gap!, /capacity/);
  } finally { await g.close(); }
});
test('coverage inspection never registers a new watch and unregistered/foreign-account observations are discarded', async () => {
  const f = await fixture(() => true); try {
    f.monitor.coverage(source); assert.equal(f.store.list('monitor-source/registrations').length, 0);
    const row: Observation = { id: 'unregistered', kind: 'edit', ref: { accountId: '42', peerId: peer, messageId: '1' }, outgoing: false, text: 'do not archive', sentAt: '2026-10-04T00:00:00Z', observedAt: '2026-10-04T00:00:00Z' };
    await f.monitor.recordObservation(row); assert.equal(f.store.list('monitor-source/journal').length, 0);
    f.rpc.add(1, 1); await f.monitor.read(source, undefined, 2);
    await f.monitor.recordObservation({ ...row, ref: { ...row.ref, accountId: 'foreign' } }); assert.equal(f.store.list('monitor-source/journal').length, 0);
  } finally { await f.close(); }
});
test('optional web snapshots call scoped WebService, preserve stable hashes and reject private resources before transport', async () => {
  const f = await fixture(); let content = 'first', reads = 0; try {
    const web = new WebService({ authority: async (ctx, capability, resource) => { assert.equal(ctx.taskId, context.taskId); assert.equal(capability, 'web.fetch'); assert.equal(resource, 'https://example.com'); },
      resolver: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => { reads++; return { status: 200, headers: { 'content-type': 'text/plain' }, bytes: Buffer.from(content) }; } });
    const monitor = createMonitorSource({ store: f.store, telegram: f.telegram, accountId: '42', web: { fetch: source => web.fetch(context, { url: source.resource }) } });
    const resource: JobSource = { id: 'web', kind: 'web', resource: 'https://example.com/news' };
    const first = await monitor.read(resource, undefined, 2); assert.equal(first.changes.length, 1);
    const unchanged = await monitor.read(resource, first.cursor, 2); assert.equal(unchanged.changes.length, 0);
    content = 'second'; const edit = await monitor.read(resource, unchanged.cursor, 2); assert.equal(edit.changes[0]!.kind, 'edit'); assert.notEqual(first.changes[0]!.version, edit.changes[0]!.version);
    content = 'first'; const reverted = await monitor.read(resource, edit.cursor, 2); assert.equal(reverted.changes[0]!.kind, 'edit'); assert.notEqual(reverted.changes[0]!.version, first.changes[0]!.version);
    const prior = reads; await assert.rejects(monitor.read({ ...resource, resource: 'http://127.0.0.1/private' }, undefined, 2)); assert.equal(reads, prior);
  } finally { await f.close(); }
});
test('generic monitor comparison keeps int64 decimal IDs exact beyond the installed TDLib int53 request gate', async () => {
  const f = await fixture(); try {
    const base = 9223372036854775800n; const observedAt = new Date().toISOString(); let newest = base;
    const calls: Array<string | undefined> = [];
    const monitor = createMonitorSource({ store: f.store, accountId: '42', telegram: { async readHistory(_peer, options) {
      calls.push(options.before);
      const ids = [newest, base - 1n].filter(id => !options.before || id < BigInt(options.before)).slice(0, options.limit);
      return ids.map(id => ({ id: id.toString(), kind: 'message', ref: { accountId: '42', peerId: peer, messageId: id.toString() }, outgoing: false, text: 'exact ID', sentAt: observedAt, observedAt }));
    } } });
    const first = await monitor.read(source, undefined, 1); newest = base + 1n;
    const added = await monitor.read(source, first.cursor, 1); const settled = await monitor.read(source, added.cursor, 1);
    assert.equal(calls.at(-1), newest.toString()); assert.equal(monitor.coverage(source, settled.cursor).committedHead, newest.toString());
  } finally { await f.close(); }
});
