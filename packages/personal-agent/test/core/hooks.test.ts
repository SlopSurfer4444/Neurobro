import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPersonalAgent, AuthorityError } from '../../src/core/index.ts';
import type { Effect, EngineInput, EnginePort, RunSnapshot, ToolContext } from '../../src/contracts.ts';

test('fresh session input suppresses prior session/checkpoint; host context invalidation blocks tools and implicit delivery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'neurobro-hooks-'));
  const inputs: EngineInput[] = []; const effects: Effect[] = []; let invalid = false;
  const snapshots = new Map<string, RunSnapshot>();
  const engine: EnginePort = {
    async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
    async submit(input) {
      inputs.push(input);
      const snapshot: RunSnapshot = { binding: { taskId: input.taskId, intentRevision: input.intentRevision, idempotencyKey: input.idempotencyKey,
        runId: 'run-' + inputs.length, sessionId: 'session-' + inputs.length }, state: 'completed', output: 'ready output', observedAt: new Date().toISOString() };
      snapshots.set(snapshot.binding.runId, snapshot); return snapshot;
    },
    async inspect(binding) { return snapshots.get(binding.runId)!; },
    async cancel(binding) { return { ...snapshots.get(binding.runId)!, state: 'cancelled' }; },
  };
  const agent = createPersonalAgent({ databasePath: join(directory, 'state.sqlite'), encryptionKey: randomBytes(32),
    accountId: 'account', ownerId: 'owner', privateRoute: { peerId: 'private' }, engine,
    async prepareInput(intent) { return { freshSession: intent.revision > 1, context: 'scoped clean material', stagedFiles: ['fixture.txt'] }; },
    validateToolContext() { if (invalid) throw new Error('source revoked'); },
    executor: { async dispatch(effect) { effects.push(effect); return { state: 'verified' }; }, async reconcile() { return { state: 'unknown' }; } },
  });
  try {
    const now = new Date().toISOString();
    const result = await agent.ingest({ id: 'source-event', kind: 'message', ref: { accountId: 'account', peerId: 'origin', messageId: '1' },
      authorId: 'owner', outgoing: true, text: '/бро do a task', sentAt: now, observedAt: now, artifactRefs: ['artifact-1'], contextRefs: ['source-1'] });
    const id = result.taskId!;
    assert.deepEqual(agent.status(id)?.intent.artifactRefs, ['artifact-1']);
    await agent.correct(id, 'remove source and start clean');
    assert.equal(inputs[1]?.sessionId, undefined); assert.equal(inputs[1]?.context, 'scoped clean material');
    assert.deepEqual(inputs[1]?.stagedFiles, ['fixture.txt']);
    const token = inputs[1]!.toolContext!;
    const trusted = agent.resolveToolContext(token);
    const schedule: ToolContext = { ...trusted, runId: 'cron:schedule:execution' };
    const scheduledToken = agent.issueExecutionContext(schedule);
    assert.equal(agent.resolveToolContext(scheduledToken).runId, schedule.runId);
    invalid = true;
    assert.throws(() => agent.validateExecutionContext(schedule), AuthorityError);
    await assert.rejects(agent.executeEffect(token, { capability: 'telegram.send', resource: 'private', payload: { text: 'tainted' } }), AuthorityError);
    const poll = await agent.poll(); assert.equal(poll.deliveries.length, 0); assert.equal(effects.length, 0);
  } finally { agent.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('multipart result preserves every Unicode character and waits for UNKNOWN part reconciliation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'neurobro-parts-'));
  const effects: Effect[] = []; let snapshot: RunSnapshot; let settled = false;
  const output = '😀漢字\n'.repeat(2400);
  const agent = createPersonalAgent({ databasePath: join(directory, 'state.sqlite'), encryptionKey: randomBytes(32),
    accountId: 'account', ownerId: 'owner', privateRoute: { peerId: 'private' },
    engine: { async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
      async submit(input) { snapshot = { binding: { runId: 'run', sessionId: 'session', taskId: input.taskId,
        intentRevision: input.intentRevision, idempotencyKey: input.idempotencyKey }, state: 'completed', output, observedAt: new Date().toISOString() }; return snapshot; },
      async inspect() { return snapshot; }, async cancel() { return { ...snapshot, state: 'cancelled' }; } },
    executor: { async dispatch(effect) { effects.push(effect); return effects.length === 1 ? { state: 'unknown' } : { state: 'verified' }; },
      async reconcile() { return settled ? { state: 'verified' } : { state: 'unknown' }; } },
  });
  try {
    const now = new Date().toISOString();
    await agent.ingest({ id: 'event', kind: 'message', ref: { accountId: 'account', peerId: 'origin', messageId: '1' },
      authorId: 'owner', outgoing: true, text: '/бро write report', sentAt: now, observedAt: now });
    await agent.poll(); assert.equal(effects.length, 1);
    await agent.poll(); assert.equal(effects.length, 1);
    settled = true; const completed = await agent.poll();
    assert.ok(effects.length > 1); assert.ok(completed.deliveries.every(e => e.state === 'verified'));
    const texts = effects.map(effect => {
      const payload = effect.payload as { text: string }; assert.ok(payload.text.length <= 4096);
      const header = /^🤖 Нейробратик(?: · \d+\/\d+)?\n\n/u.exec(payload.text);
      assert.ok(header, 'Human-readable delivery header is separate from original result bytes');
      return payload.text.slice(header[0].length);
    });
    assert.equal(texts.join(''), output);
    assert.ok(texts.every(text => !/[\uD800-\uDBFF]$/.test(text) && !/^[\uDC00-\uDFFF]/.test(text)));
    const count = effects.length; await agent.poll(); assert.equal(effects.length, count);
  } finally { agent.close(); rmSync(directory, { recursive: true, force: true }); }
});
