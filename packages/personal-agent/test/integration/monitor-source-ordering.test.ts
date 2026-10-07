import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from '../../src/core/store.ts';
import { createMonitorSource } from '../../src/monitor-source.ts';
import { JobService, type JobRecord, type JobSource, type JobStore } from '../../src/capabilities/jobs.ts';
import type { Observation, ToolContext } from '../../src/contracts.ts';

const source: JobSource = { id: 'ordered', kind: 'telegram', resource: '-100456' };
const context: ToolContext = { taskId: 'ordering-task', intentRevision: 1, grantId: 'ordering-grant', grantRevision: 1, runId: 'ordering-run' };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function row(id: string, text: string, revision?: number): Observation {
  const timestamp = `2026-10-05T00:00:0${revision ?? 0}Z`;
  return { id: `${id}/${revision ?? 0}`, kind: 'message', ref: { accountId: '42', peerId: source.resource, messageId: id },
    authorId: '7', outgoing: false, text, sentAt: '2026-10-05T00:00:00Z', observedAt: timestamp,
    ...(revision ? { editedAt: timestamp } : {}) };
}
function edit(id: string, text: string, revision: number): Observation { return { ...row(id, text, revision), kind: 'edit' }; }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neurobro-monitor-ordering-'));
  const databasePath = join(directory, 'state.sqlite'), encryptionKey = Buffer.alloc(32, 13);
  let store = new PersonalStore({ databasePath, encryptionKey });
  let messages: Observation[] = [], offline = false, onRead: (() => Promise<void>) | undefined;
  const telegram = { async readHistory(_peer: string, options: { before?: string; limit: number }): Promise<Observation[]> {
    if (offline) throw new Error('initial fixture outage');
    const snapshot = structuredClone(messages.filter(m => !options.before || BigInt(m.ref.messageId) < BigInt(options.before))
      .sort((a, b) => BigInt(a.ref.messageId) > BigInt(b.ref.messageId) ? -1 : 1).slice(0, options.limit));
    const hook = onRead; onRead = undefined;
    if (hook) await hook();
    return snapshot;
  } };
  const jobStore: JobStore = {
    async load(taskId, id) { return store.get<JobRecord>('ordering-jobs', `${taskId}/${id}`); },
    async list(taskId, limit) { return store.list<JobRecord>('ordering-jobs').filter(j => j.binding.taskId === taskId).slice(0, limit); },
    async save(record, expectedVersion) { return store.transaction(() => {
      const id = `${record.binding.taskId}/${record.id}`, previous = store.get<JobRecord>('ordering-jobs', id);
      if (previous?.version !== expectedVersion) return false;
      store.put('ordering-jobs', id, record); return true;
    }); },
  };
  const build = () => {
    const monitor = createMonitorSource({ store, telegram, accountId: '42', authorizeObservation: () => true });
    const jobs = new JobService({ store: jobStore, source: monitor, validateContext: async (_ctx, sources) => {
      assert.ok(sources.every(s => s.resource === source.resource));
    } });
    return { monitor, jobs };
  };
  let services = build();
  return { get monitor() { return services.monitor; }, get jobs() { return services.jobs; },
    setMessages(value: Observation[]) { messages = value; }, setOffline(value: boolean) { offline = value; },
    duringNextRead(hook: () => Promise<void>) { onRead = hook; },
    reopen() { store.close(); store = new PersonalStore({ databasePath, encryptionKey }); services = build(); },
    close() { store.close(); } };
}
async function create(f: Awaited<ReturnType<typeof fixture>>) {
  await f.jobs.create(context, { id: 'watch', name: 'ordered changes', sources: [source], pageSize: 1, maxPages: 1 });
}
async function drain(f: Awaited<ReturnType<typeof fixture>>, count = 8) {
  const texts: string[] = []; let job: JobRecord | undefined;
  for (let i = 0; i < count; i++) {
    const result = await f.jobs.poll(context, 'watch', 1); job = result.job;
    texts.push(...result.alerts.filter(a => a.itemId).map(a => a.text));
  }
  return { job: job!, texts };
}
function assertLatest(job: JobRecord, id: string, text: string) {
  assert.equal(job.sourceStates[digest(source.id)]!.items[digest(id)]!.fingerprint, digest(['edit', '', text]));
}

test('pending edits cannot regress a latest head snapshot across a cold restart', async () => {
  const f = await fixture(); try {
    f.setMessages([row('1', 'original')]); await create(f); await f.jobs.poll(context, 'watch', 1);
    for (const [text, revision] of [['A', 1], ['B', 2], ['C', 3]] as const) await f.monitor.recordObservation(edit('1', text, revision));
    f.setMessages([row('1', 'C', 3)]);
    const first = await f.jobs.poll(context, 'watch', 1); f.reopen();
    const rest = await drain(f);
    assert.deepEqual([...first.alerts.map(a => a.text), ...rest.texts], ['A', 'B', 'C']);
    assertLatest(rest.job, '1', 'C');
  } finally { f.close(); }
});

test('edits to a fresh catchup ID cannot be overwritten by older journal versions', async () => {
  const f = await fixture(); try {
    f.setMessages([row('1', 'boundary')]); await create(f); await f.jobs.poll(context, 'watch', 1);
    for (const [text, revision] of [['A', 1], ['B', 2], ['C', 3]] as const) await f.monitor.recordObservation(edit('2', text, revision));
    f.setMessages([row('2', 'C', 3), row('1', 'boundary')]);
    const result = await drain(f);
    assert.deepEqual(result.texts, ['A', 'B', 'C']); assertLatest(result.job, '2', 'C');
    const state = result.job.sourceStates[digest(source.id)]!;
    assert.equal(f.monitor.coverage(source, state.cursor).committedHead, '2');
  } finally { f.close(); }
});

test('journal events received during history await precede that newer history snapshot', async () => {
  const f = await fixture(); try {
    f.setMessages([row('1', 'original')]); await create(f); await f.jobs.poll(context, 'watch', 1);
    f.setMessages([row('1', 'C', 3)]);
    f.duringNextRead(async () => {
      await f.monitor.recordObservation(edit('1', 'B', 2));
      await f.monitor.recordObservation(edit('1', 'C', 3));
    });
    const result = await drain(f);
    assert.deepEqual(result.texts, ['B', 'C']); assertLatest(result.job, '1', 'C');
  } finally { f.close(); }
});

test('an edit retained after initial failure cannot bypass bounded bootstrap or strand its head at zero', async () => {
  const f = await fixture(); try {
    await create(f); f.setOffline(true);
    const lost = await f.jobs.poll(context, 'watch', 1); assert.equal(lost.job.sourceStates[digest(source.id)]!.status, 'lost');
    f.setOffline(false); f.setMessages([row('1', 'A', 1)]);
    await f.monitor.recordObservation(edit('1', 'A', 1)); f.reopen();
    const result = await drain(f);
    const state = result.job.sourceStates[digest(source.id)]!;
    assert.equal(state.status, 'ready'); assert.equal(f.monitor.coverage(source, state.cursor).committedHead, '1');
    assertLatest(result.job, '1', 'A');
  } finally { f.close(); }
});

test('an observation arriving during bootstrap await cannot be acknowledged behind an older captured snapshot', async () => {
  const f = await fixture(); try {
    f.setMessages([row('1', 'about to disappear')]); await create(f);
    f.duringNextRead(async () => {
      await f.monitor.recordObservation({ ...row('1', '', 1), kind: 'delete', text: undefined });
      f.setMessages([]);
    });
    const result = await drain(f, 5);
    const item = result.job.sourceStates[digest(source.id)]!.items[digest('1')];
    assert.ok(item === undefined || item.deleted, 'bootstrap must retry the stale snapshot or retain the intervening tombstone');
  } finally { f.close(); }
});
