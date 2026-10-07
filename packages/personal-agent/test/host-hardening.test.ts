import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalHost } from '../src/host.ts';
import type { PersonalConfig } from '../src/config.ts';
import type { Effect, EngineInput, Observation, RunBinding, RunSnapshot, MessageRef } from '../src/contracts.ts';

const refKey = (ref: MessageRef) => JSON.stringify([ref.accountId, ref.peerId, ref.messageId]);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'personal-host-hardening-'));
  const messages = new Map<string, Observation>(), runs = new Map<string, RunSnapshot>();
  const inputs: EngineInput[] = [], cancellations: RunBinding[] = [];
  const config: PersonalConfig = { schemaVersion: 1, stateDirectory: directory, account: { id: 'account', ownerId: 'owner', controlPeerId: 'private' },
    encryptionKeyEnv: 'FIXTURE_KEY', hermes: { baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'FIXTURE_HERMES' },
    telegram: { command: process.execPath, args: [], databaseDirectory: join(directory, 'td'), filesDirectory: join(directory, 'files'), apiIdEnv: 'FIXTURE_API_ID', apiHashEnv: 'FIXTURE_API_HASH' } };
  const host = new PersonalHost({ config, encryptionKey: Buffer.alloc(32, 3), naturalConversation: true,
    engine: { async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
      async submit(input) { inputs.push(input); const snapshot: RunSnapshot = { binding: { taskId: input.taskId, intentRevision: input.intentRevision,
        idempotencyKey: input.idempotencyKey, runId: 'run-' + inputs.length }, state: 'running', observedAt: new Date().toISOString() }; runs.set(snapshot.binding.runId, snapshot); return snapshot; },
      async inspect(binding) { return runs.get(binding.runId)!; },
      async cancel(binding) { cancellations.push(binding); const snapshot: RunSnapshot = { ...runs.get(binding.runId)!, state: 'cancelled' }; runs.set(binding.runId, snapshot); return snapshot; } },
    telegram: { async *observations() {}, async readHistory(peerId) { return [...messages.values()].filter(item => item.ref.peerId === peerId); },
      async getMessage(ref) { return messages.get(refKey(ref)); }, async download(_attachment, destination) { await writeFile(destination, 'fixture'); },
      async dispatch(effect: Effect) { return { state: 'verified', receipt: { peerId: effect.resource, messageId: 'effect-' + effect.id } }; },
      async reconcile() { return { state: 'unknown' }; }, async close() {} },
  });
  function message(id: string, text: string, extra: Partial<Observation> = {}): Observation {
    const now = new Date().toISOString(); return { id: 'event-' + id, kind: 'message', ref: { accountId: 'account', peerId: 'private', messageId: id },
      authorId: 'owner', outgoing: true, text, sentAt: now, observedAt: now, ...extra };
  }
  async function ingest(value: Observation) { messages.set(refKey(value.ref), value); return host.ingest(value); }
  return { host, inputs, cancellations, message, ingest, async close() { await host.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('host folds newest cadence into unbound original task and projects latest owner precedence', async () => {
  const f = await fixture();
  try {
    const first = await f.ingest(f.message('1', 'Наблюдай выбранные источники раз в 15 минут'));
    const latest = await f.ingest(f.message('2', 'Давай только эт. Раз в пару часов'));
    assert.equal(latest.disposition, 'corrected'); assert.equal(latest.taskId, first.taskId);
    assert.equal(f.host.agent.status().length, 1); assert.equal(f.cancellations.length, 1);
    assert.equal(f.inputs.at(-1)?.intentRevision, 2); assert.match(f.inputs.at(-1)!.instruction, /Раз в пару часов$/u);
    assert.match(f.inputs.at(-1)!.context!, /последн[^\n]{0,180}(?:уточнен|редакц)|уточнен[^\n]{0,180}(?:приоритет|преимущество)|latest[^\n]{0,180}(?:correction|precedence)/iu);
  } finally { await f.close(); }
});

test('host preserves durable schedule/monitor binding and creates fresh cadence management task', async () => {
  for (const [namespace, state] of [['observation/subscriptions', 'active'], ['observation/subscriptions', 'creating'], ['hermesSchedules', 'unknown']] as const) {
    const f = await fixture();
    try {
      const first = await f.ingest(f.message('1', 'Наблюдай источник'));
      f.host.agent.store.put(namespace, 'existing', { id: 'existing', state, binding: { taskId: first.taskId } });
      const latest = await f.ingest(f.message('2', 'Раз в два часа'));
      assert.equal(latest.disposition, 'accepted', namespace + ':' + state); assert.notEqual(latest.taskId, first.taskId);
      assert.equal(f.host.agent.status(first.taskId!)?.intent.revision, 1); assert.equal(f.cancellations.length, 0);
    } finally { await f.close(); }
  }
});

test('host archives native quote/code ranges and includes them in source version and trusted model roles', async () => {
  const f = await fixture();
  try {
    const text = 'Разбери пример: да';
    const original = f.message('1', text);
    await f.ingest(original);
    const access = { ownerId: 'owner', accountId: 'account', scopes: ['chat:private'] };
    const prior = f.host.memory.currentSource(access, 'private/1')!;
    const spans = [{ offset: 16, length: 2, kind: 'quote' as const }];
    const edited = f.message('1', text, { kind: 'edit', editedAt: new Date(Date.now() + 10).toISOString(), authorityTextRanges: spans });
    await f.ingest(edited);
    const current = f.host.memory.currentSource(access, 'private/1')!;
    assert.notEqual(current.ref, prior.ref); assert.deepEqual(current.sourceMetadata?.authorityTextRanges, spans);
    assert.match(f.inputs.at(-1)!.context!, /"authorityTextRanges":\[\{"offset":16,"length":2,"kind":"quote"\}\]/u);
    const quoteOnly = await f.ingest(f.message('2', 'да', { authorityTextRanges: [{ offset: 0, length: 2, kind: 'quote' }] }));
    assert.equal(quoteOnly.disposition, 'ignored'); assert.equal(f.host.agent.status().length, 1);
  } finally { await f.close(); }
});

test('document destruction needs exact current direct owner command and exact opaque document/version identities', async () => {
  const f = await fixture();
  try {
    await f.ingest(f.message('1', 'удали навсегда документ DOC-A версию VER-B'));
    const context = f.host.agent.resolveToolContext(f.inputs[0]!.toolContext!);
    assert.equal((await f.host.authorizeDocumentDestruction(context, 'erase', { documentId: 'DOC-A', versionId: 'VER-B' })).ownerId, 'owner');
    await assert.rejects(f.host.authorizeDocumentDestruction(context, 'erase', { documentId: 'doc-a', versionId: 'VER-B' }));
    await assert.rejects(f.host.authorizeDocumentDestruction(context, 'erase', { documentId: 'DOC-A', versionId: 'ver-b' }));
    await assert.rejects(f.host.authorizeDocumentDestruction(context, 'revoke', { documentId: 'DOC-A', versionId: 'VER-B' }));
    const edited = f.message('1', 'удали навсегда документ DOC-A версию VER-B', { kind: 'edit', editedAt: new Date(Date.now() + 10).toISOString(), authorityTextRanges: [{ offset: 0, length: 42, kind: 'quote' }] });
    await f.ingest(edited);
    await assert.rejects(f.host.authorizeDocumentDestruction(context, 'erase', { documentId: 'DOC-A', versionId: 'VER-B' }));
  } finally { await f.close(); }
});
