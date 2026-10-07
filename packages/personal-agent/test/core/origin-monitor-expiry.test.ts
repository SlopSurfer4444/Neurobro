import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPersonalAgent, type PersonalAgent } from '../../src/core/controller.ts';
import { AuthorityError } from '../../src/core/broker.ts';
import { OwnerControlService } from '../../src/owner-controls/service.ts';
import type { Effect, EngineInput, Grant, MessageRef, Observation, RunSnapshot, ToolContext } from '../../src/contracts.ts';

const refKey = (ref: MessageRef) => JSON.stringify([ref.accountId, ref.peerId, ref.messageId]);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'origin-monitor-expiry-'));
  const databasePath = join(directory, 'state.sqlite'); const encryptionKey = randomBytes(32);
  let time = Date.parse('2026-10-05T12:00:00Z'); let sequence = 0;
  let agent: PersonalAgent; let controls: OwnerControlService;
  const messages = new Map<string, Observation>(); const runs = new Map<string, RunSnapshot>();
  const inputs: EngineInput[] = []; const dispatches: Effect[] = [];
  const clock = { now: () => new Date(time) };
  const source = { accountId: 'account', peerId: 'watched-source', label: 'Exact source', kind: 'channel' as const };
  const capabilities = (intent: { route: { peerId: string } }) => [
    { capability: 'telegram.history', resources: ['private'] },
    ...['telegram.send', 'telegram.media.send'].map(capability => ({ capability, resources: [...new Set(['private', intent.route.peerId])] })),
  ];
  function open() {
    agent = createPersonalAgent({ databasePath, encryptionKey, accountId: 'account', ownerId: 'owner', privateRoute: { peerId: 'private' },
      naturalControlPeerId: 'private', clock, capabilityPolicy: capabilities,
      prepareAuthority: intent => controls.prepareAuthority(intent),
      validateToolResource: (context, capability, resource) => controls.validateResource(context, capability, resource),
      validateEffect: (context, request) => controls.validateEffect(context, request),
      engine: { async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
        async submit(input) { inputs.push(input); const snapshot: RunSnapshot = { binding: { taskId: input.taskId, intentRevision: input.intentRevision,
          idempotencyKey: input.idempotencyKey, runId: 'run-' + inputs.length }, state: 'waiting', observedAt: clock.now().toISOString() };
          runs.set(snapshot.binding.runId, snapshot); return snapshot; },
        async inspect(binding) { return runs.get(binding.runId)!; },
        async cancel(binding) { const ended = { ...runs.get(binding.runId)!, state: 'cancelled' as const }; runs.set(binding.runId, ended); return ended; } },
      executor: { async dispatch(effect) { dispatches.push(effect); return { state: 'verified', receipt: { peerId: effect.resource, messageId: 'sent-' + dispatches.length } }; },
        async reconcile() { return { state: 'unknown' }; } },
    });
    controls = new OwnerControlService({ store: agent.store, accountId: 'account', ownerId: 'owner', controlPeerId: 'private', now: clock.now,
      taskIntent: id => agent.status(id)?.intent, taskActive: id => !!agent.status(id) && !agent.status(id)?.cancelledAt && !agent.status(id)?.heldAt,
      validateAuthority: context => { agent.validateAuthority(context); }, baseCapabilities: capabilities,
      telegram: { async getMessage(ref) { return messages.get(refKey(ref)); },
        async resolveSource(selector) { assert.equal(selector, '@source'); return source; },
        async verifyPeer(peer) { assert.equal(peer.peerId, source.peerId); return source; }, async resolveForwardSource() { return undefined; } },
    });
  }
  open();
  function observation(text: string, peerId = 'private', patch: Partial<Observation> = {}): Observation {
    const id = String(++sequence); const value: Observation = { id: 'owner-' + id, kind: 'message', ref: { accountId: 'account', peerId, messageId: id },
      text, authorId: 'owner', outgoing: true, sentAt: clock.now().toISOString(), observedAt: clock.now().toISOString(), ...patch };
    messages.set(refKey(value.ref), value); return value;
  }
  async function monitoredOrigin() {
    const original = observation('/бро --here prepare report', 'origin');
    await controls.prepareOwnerEvent(original); const admitted = await agent.ingest(original); const taskId = admitted.taskId!;
    const initialToken = inputs.at(-1)!.toolContext!; const initialContext = agent.resolveToolContext(initialToken);
    const deadline = agent.store.get<{ expiresAt: string }>('originDeadlines', taskId)!.expiresAt;
    const proposal = await controls.proposeSources({ context: initialContext, sources: [source], monitor: true });
    const card = await agent.executeEffect(initialToken, { id: 'monitor-card', capability: 'telegram.send', resource: 'private', payload: { peerId: 'private', text: 'Monitor exact source #' + proposal.id } });
    const cardRef = { accountId: 'account', peerId: 'private', messageId: (card.receipt as { messageId: string }).messageId };
    messages.set(refKey(cardRef), { id: 'sent-card', kind: 'message', ref: cardRef, text: 'Monitor exact source #' + proposal.id,
      authorId: 'owner', outgoing: true, agentEffectId: card.id, sentAt: clock.now().toISOString(), observedAt: clock.now().toISOString() });
    controls.registerCard(proposal.id, cardRef);
    assert.equal((await controls.prepareOwnerEvent(observation('да', 'private', { replyTo: cardRef }))).disposition, 'accepted');
    const context = await agent.refreshAuthority(taskId); const token = agent.issueExecutionContext(context);
    assert.equal(agent.store.get<Grant>('grants', context.grantId)!.expiresAt, undefined);
    return { taskId, token, context, original, deadline };
  }
  function current(taskId: string): ToolContext {
    const intent = agent.status(taskId)!.intent; const grant = agent.store.get<Grant>('grants', intent.grantId)!;
    return { taskId, intentRevision: intent.revision, grantId: grant.id, grantRevision: grant.revision, runId: 'cron:monitor:execution-' + sequence };
  }
  return { get agent() { return agent; }, get controls() { return controls; }, dispatches, inputs, observation, monitoredOrigin, current,
    advance(ms: number) { time += ms; },
    async restart() { agent.close(); open(); await agent.start(); },
    close() { agent.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('monitor approval cannot extend origin text/media authority; private collection and alerts remain usable', async () => {
  const f = fixture();
  try {
    const task = await f.monitoredOrigin();
    for (const capability of ['telegram.send', 'telegram.media.send']) await f.agent.executeEffect(task.token, { id: capability,
      capability, resource: 'origin', payload: { peerId: 'origin', text: 'within original deadline' } });
    f.advance(16 * 60 * 1000); const sent = f.dispatches.length;
    for (const capability of ['telegram.send', 'telegram.media.send']) {
      assert.throws(() => f.agent.authorizeTool(task.token, capability, 'origin'), AuthorityError);
      await assert.rejects(f.agent.executeEffect(task.token, { id: capability, capability, resource: 'origin', payload: { peerId: 'origin', text: 'within original deadline' } }), AuthorityError);
    }
    assert.equal(f.dispatches.length, sent);
    f.agent.authorizeTool(task.token, 'telegram.history', 'watched-source');
    assert.equal((await f.agent.executeEffect(task.token, { id: 'private-alert', capability: 'telegram.send', resource: 'private', payload: { peerId: 'private', text: 'new classified post' } })).state, 'verified');
    const refreshed = await f.agent.refreshAuthority(task.taskId); const fresh = f.agent.issueExecutionContext({ ...refreshed, runId: 'cron:monitor:next' });
    for (const capability of ['telegram.send', 'telegram.media.send']) assert.throws(() => f.agent.authorizeTool(fresh, capability, 'origin'), AuthorityError);
    f.agent.authorizeTool(fresh, 'telegram.history', 'watched-source');
    assert.equal(f.agent.store.get<{ expiresAt: string }>('originDeadlines', task.taskId)!.expiresAt, task.deadline);
    await f.restart(); const recovered = f.agent.issueExecutionContext(f.current(task.taskId));
    await assert.rejects(f.agent.executeEffect(recovered, { capability: 'telegram.media.send', resource: 'origin', payload: { peerId: 'origin', artifactId: 'file' } }), AuthorityError);
    assert.equal((await f.agent.executeEffect(recovered, { capability: 'telegram.send', resource: 'private', payload: { peerId: 'private', text: 'recovered private alert' } })).state, 'verified');
  } finally { f.close(); }
});

test('origin review cannot be restored by scope/context refresh or restart; only fresh explicit owner route renews', async () => {
  const f = fixture();
  try {
    const task = await f.monitoredOrigin();
    await f.agent.ingest(f.observation('I already answered this.', 'origin'));
    assert.ok(f.agent.store.get('originReview', task.taskId));
    await f.agent.refreshAuthority(task.taskId); await f.agent.refreshContext(task.taskId);
    let token = f.agent.issueExecutionContext(f.current(task.taskId));
    for (const capability of ['telegram.send', 'telegram.media.send']) await assert.rejects(f.agent.executeEffect(token, { capability, resource: 'origin', payload: { peerId: 'origin', text: 'stale draft' } }), AuthorityError);
    f.agent.authorizeTool(token, 'telegram.history', 'watched-source');
    assert.equal(f.agent.store.get<{ expiresAt: string }>('originDeadlines', task.taskId)!.expiresAt, task.deadline);
    await f.restart(); await f.agent.refreshAuthority(task.taskId); token = f.agent.issueExecutionContext(f.current(task.taskId));
    assert.throws(() => f.agent.authorizeTool(token, 'telegram.media.send', 'origin'), AuthorityError);
    f.advance(16 * 60 * 1000);
    const correction = f.observation('/бро --origin #' + task.taskId + ' send the newly requested result');
    await f.controls.prepareOwnerEvent(correction); assert.equal((await f.agent.ingest(correction)).disposition, 'corrected');
    assert.equal(f.agent.store.get('originReview', task.taskId), undefined);
    assert.notEqual(f.agent.store.get<{ expiresAt: string }>('originDeadlines', task.taskId)!.expiresAt, task.deadline);
    token = f.inputs.at(-1)!.toolContext!;
    assert.equal((await f.agent.executeEffect(token, { capability: 'telegram.send', resource: 'origin', payload: { peerId: 'origin', text: 'fresh owner result' } })).state, 'verified');
  } finally { f.close(); }
});

test('unsubscribe restores the original bounded expiry across legacy migration, context refresh and restart', async () => {
  const f = fixture();
  try {
    const task = await f.monitoredOrigin();
    f.agent.store.delete('grantBaselines', task.context.grantId);
    const oldDeadline = f.agent.store.get<{ taskId: string; expiresAt: string }>('originDeadlines', task.taskId)!;
    f.agent.store.put('originDeadlines', task.taskId, { taskId: oldDeadline.taskId, expiresAt: oldDeadline.expiresAt });
    await f.restart(); await f.agent.refreshAuthority(task.taskId); await f.agent.refreshContext(task.taskId);
    assert.equal(f.agent.store.get<{ expiresAt: string }>('originDeadlines', task.taskId)!.expiresAt, task.deadline);
    f.advance(16 * 60 * 1000);
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('unsubscribe @source'))).disposition, 'revoked');
    const context = await f.agent.refreshAuthority(task.taskId);
    assert.equal(f.agent.store.get<Grant>('grants', context.grantId)!.expiresAt, task.deadline);
    assert.throws(() => f.agent.issueExecutionContext(context), AuthorityError);
    await f.restart();
    assert.equal(f.agent.store.get<Grant>('grants', context.grantId)!.expiresAt, task.deadline);
    assert.deepEqual(f.controls.getMonitorPolicies(task.taskId), []);
    assert.throws(() => f.agent.issueExecutionContext(f.current(task.taskId)), AuthorityError);
  } finally { f.close(); }
});
