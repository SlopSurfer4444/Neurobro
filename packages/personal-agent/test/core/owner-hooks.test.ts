import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CapabilityGrant, Effect, EffectResult, EngineInput, Grant, Observation, RunBinding, RunSnapshot,
  TaskIntent, ToolContext } from '../../src/contracts.ts';
import { AuthorityError, type EffectRequest } from '../../src/core/broker.ts';
import { createPersonalAgent, type PersonalAgentOptions } from '../../src/core/controller.ts';

const stamp = '2026-10-04T12:00:00.000Z';
const accountId = 'owner-account';
const ownerId = 'owner-user';
const room = 'private-owner-room';
const baseCaps = (): CapabilityGrant[] => [{ capability: 'telegram.read', resources: [room] },
  { capability: 'telegram.send', resources: [room] }];

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>(resolve => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}
function observation(id: string, text = '/бро inspect private material', changes: Partial<Observation> = {}): Observation {
  return { id: 'event-' + id, kind: 'message', ref: { accountId, peerId: room, messageId: id },
    authorId: ownerId, outgoing: true, text, sentAt: stamp, observedAt: stamp, ...changes };
}
function fixture(t: TestContext, options: Partial<PersonalAgentOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'owner-hooks-'));
  const databasePath = join(directory, 'encrypted.sqlite');
  const encryptionKey = randomBytes(32);
  const submissions: EngineInput[] = [];
  const dispatches: Effect[] = [];
  const inspections: RunBinding[] = [];
  const cancellations: RunBinding[] = [];
  const runs = new Map<string, RunSnapshot>();
  const handlers = {
    inspect: (bound: RunBinding): RunSnapshot => {
      const result = runs.get(bound.runId); assert.ok(result); return result;
    },
    cancel: (bound: RunBinding): RunSnapshot => ({ binding: bound, state: 'cancelled', observedAt: stamp }),
    dispatch: async (effect: Effect): Promise<EffectResult> => ({ state: 'verified',
      receipt: { peerId: effect.resource, messageId: 'receipt-' + dispatches.length } }),
  };
  const agent = createPersonalAgent({ databasePath, encryptionKey, accountId, ownerId, privateRoute: { peerId: room },
    clock: { now: () => new Date(stamp) }, engine: {
      async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
      async submit(input) {
        submissions.push(input);
        const snapshot: RunSnapshot = { binding: { runId: 'run-' + submissions.length, sessionId: input.sessionId ?? 'initial-session',
          taskId: input.taskId, intentRevision: input.intentRevision, idempotencyKey: input.idempotencyKey }, state: 'running', observedAt: stamp };
        runs.set(snapshot.binding.runId, snapshot); return snapshot;
      },
      async inspect(bound) { inspections.push(bound); return handlers.inspect(bound); },
      async cancel(bound) { cancellations.push(bound); const result = handlers.cancel(bound); runs.set(bound.runId, result); return result; },
    }, executor: {
      async dispatch(effect) { dispatches.push(effect); return handlers.dispatch(effect); },
      async reconcile() { return { state: 'unknown', reason: 'fixture has no remote proof' }; },
    }, ...options });
  t.after(() => {
    agent.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('owner-hooks-'));
    rmSync(target, { recursive: true, force: true });
  });
  const accept = async (id: string, text?: string, changes?: Partial<Observation>) => {
    const result = await agent.ingest(observation(id, text, changes));
    assert.equal(result.disposition, 'accepted'); assert.ok(result.taskId); return result.taskId;
  };
  const binding = (taskId: string) => {
    const result = agent.status(taskId)?.run?.binding; assert.ok(result); return result;
  };
  return { agent, accept, binding, handlers, runs, submissions, inspections, cancellations, dispatches, databasePath };
}

test('legitimate native session rotation preserves task/run scope, delivers output, and leaves prior token authorized', async t => {
  const f = fixture(t);
  const taskId = await f.accept('rotation');
  const original = f.binding(taskId);
  const token = f.agent.issueToolContext(original);
  const context = f.agent.resolveToolContext(token);
  f.handlers.inspect = bound => ({ binding: { ...bound, sessionId: 'rotated-session' }, state: 'completed',
    output: 'result after native rotation', observedAt: stamp });
  await f.agent.poll();
  const rotated = f.binding(taskId);
  assert.equal(rotated.sessionId, 'rotated-session');
  assert.equal(rotated.runId, original.runId);
  assert.deepEqual(f.agent.authorizeTool(token, 'telegram.read', room), context);
  assert.equal(f.agent.status(taskId)?.intent.revision, 1);
  assert.equal(f.dispatches.length, 1);
  assert.match(JSON.stringify(f.dispatches[0]?.payload), /result after native rotation/);
  assert.equal(f.agent.resolveToolContext(f.agent.issueToolContext(rotated)).taskId, taskId);
  await f.agent.poll();
  assert.equal(f.dispatches.length, 1);
});

test('session rotation never permits changed run, task, revision or idempotency binding', async t => {
  for (const mismatch of ['runId', 'taskId', 'intentRevision', 'idempotencyKey'] as const) {
    const f = fixture(t);
    const taskId = await f.accept('mismatch-' + mismatch);
    const original = f.binding(taskId);
    f.handlers.inspect = bound => ({ binding: { ...bound, sessionId: 'legitimate-session-change',
      [mismatch]: mismatch === 'intentRevision' ? bound.intentRevision + 1 : 'hostile-binding' },
      state: 'completed', output: 'foreign-output', observedAt: stamp });
    await f.agent.poll();
    assert.equal(f.agent.status(taskId)?.state, 'unknown', mismatch);
    assert.deepEqual(f.binding(taskId), original, mismatch);
    assert.equal(f.dispatches.length, 0, mismatch);
  }
});

test('cancellation and correction accept native session rotation only for the same exact execution', async t => {
  const cancelled = fixture(t);
  const cancelId = await cancelled.accept('cancel-rotation');
  cancelled.handlers.cancel = bound => ({ binding: { ...bound, sessionId: 'cancel-rotated' }, state: 'cancelled', observedAt: stamp });
  await cancelled.agent.cancel(cancelId);
  assert.equal(cancelled.agent.status(cancelId)?.state, 'cancelled');
  assert.equal(cancelled.binding(cancelId).sessionId, 'cancel-rotated');

  const corrected = fixture(t);
  const correctionId = await corrected.accept('correct-rotation');
  corrected.handlers.cancel = bound => ({ binding: { ...bound, sessionId: 'correct-rotated' }, state: 'cancelled', observedAt: stamp });
  const result = await corrected.agent.correct(correctionId, 'new objective');
  assert.equal(result?.state, 'working');
  assert.equal(result?.intent.revision, 2);
  assert.equal(corrected.submissions.length, 2);
  assert.equal(corrected.submissions[1]?.sessionId, 'correct-rotated');
});

test('authority preparation completes before token issuance and provider admission with durable encrypted intention', async t => {
  const entered = deferred<TaskIntent>();
  const release = deferred<{ capabilities: CapabilityGrant[] }>();
  const f = fixture(t, { prepareAuthority: async intent => { entered.resolve(intent); return release.promise; } });
  const accepting = f.agent.ingest(observation('secret-durable-intention', '/бро private-sensitive-owner-instruction-782611'));
  const intent = await entered.promise;
  assert.equal(f.agent.status(intent.id)?.intent.instruction, 'private-sensitive-owner-instruction-782611');
  assert.equal(f.agent.store.list('contexts').length, 0, 'authority must settle before first capability token');
  assert.equal(f.submissions.length, 0);
  assert.equal(readFileSync(f.databasePath).includes(Buffer.from('private-sensitive-owner-instruction-782611')), false);
  release.resolve({ capabilities: baseCaps() });
  assert.equal((await accepting).disposition, 'accepted');
  assert.equal(f.submissions.length, 1);
  assert.ok(f.submissions[0]?.toolContext);
  assert.equal(f.agent.authorizeTool(f.submissions[0]!.toolContext!, 'telegram.read', room).taskId, intent.id);
});

test('failed authority preparation preserves durable task but issues no token or model submit', async t => {
  const f = fixture(t, { prepareAuthority: async () => { throw new Error('scope unavailable'); } });
  const taskId = await f.accept('failed-preparation');
  assert.equal(f.agent.status(taskId)?.state, 'paused');
  assert.match(f.agent.status(taskId)!.reason!, /scope unavailable/);
  assert.equal(f.agent.store.list('contexts').length, 0);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.dispatches.length, 0);
});

test('owner cancellation during asynchronous authority preparation wins and prevents admission', async t => {
  const entered = deferred<TaskIntent>();
  const release = deferred<{ capabilities: CapabilityGrant[] }>();
  const f = fixture(t, { prepareAuthority: async intent => { entered.resolve(intent); return release.promise; } });
  const accepting = f.agent.ingest(observation('cancel-authority-race'));
  const intent = await entered.promise;
  await f.agent.cancel(intent.id);
  release.resolve({ capabilities: baseCaps() });
  await accepting;
  assert.equal(f.agent.status(intent.id)?.state, 'cancelled');
  assert.ok(f.agent.status(intent.id)?.cancelledAt);
  assert.equal(f.agent.store.list('contexts').length, 0);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.dispatches.length, 0);
});

test('scope refresh changes grant only, revokes old token, stays stable for unchanged caps and cannot revive cancellation', async t => {
  let capabilities = baseCaps();
  const f = fixture(t, { prepareAuthority: async () => ({ capabilities: structuredClone(capabilities) }) });
  const taskId = await f.accept('refresh-scope');
  const original = f.agent.status(taskId)!.intent;
  const initialGrant = f.agent.store.get<Grant>('grants', original.grantId)!;
  const token = f.agent.issueToolContext(f.binding(taskId));
  capabilities = [...baseCaps(), { capability: 'artifact.read', resources: ['artifact-one'] }];
  const refreshed = await f.agent.refreshAuthority(taskId);
  assert.equal(refreshed.intentRevision, original.revision);
  assert.equal(refreshed.grantId, original.grantId);
  assert.equal(refreshed.grantRevision, initialGrant.revision + 1);
  assert.throws(() => f.agent.resolveToolContext(token), AuthorityError);
  const renewed = f.agent.issueToolContext(f.binding(taskId));
  assert.equal(f.agent.authorizeTool(renewed, 'artifact.read', 'artifact-one').grantRevision, refreshed.grantRevision);
  assert.deepEqual(await f.agent.refreshAuthority(taskId), refreshed);
  assert.equal(f.agent.status(taskId)?.intent.revision, original.revision);
  assert.equal(f.submissions.length, 1);
  await f.agent.cancel(taskId);
  await assert.rejects(f.agent.refreshAuthority(taskId), AuthorityError);
  assert.equal(f.submissions.length, 1);
});

test('read resource hook validates connected grant request and rejects stale resource before downstream use', async t => {
  const calls: Array<{ context: ToolContext; capability: string; resource: string }> = [];
  let allowed = true;
  const f = fixture(t, { validateToolResource(context, capability, resource) {
    calls.push({ context, capability, resource });
    if (!allowed) throw new AuthorityError('resource scope changed');
  } });
  const taskId = await f.accept('read-hook');
  const token = f.agent.issueToolContext(f.binding(taskId));
  assert.equal(f.agent.authorizeTool(token, 'telegram.read', room).taskId, taskId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.resource, room);
  assert.equal(calls[0]?.context.runId, f.binding(taskId).runId);
  allowed = false;
  assert.throws(() => f.agent.authorizeTool(token, 'telegram.read', room), /resource scope changed/);
  assert.throws(() => f.agent.authorizeTool(token, 'telegram.read', 'outside-room'), AuthorityError);
  assert.equal(calls.length, 2, 'outside trusted grant rejected before custom resource hook');
});

test('effect hooks run before dedupe including existing UNKNOWN and again at preparation transaction', async t => {
  const calls: string[] = [];
  let denyResource = false;
  let denyEffect = false;
  const f = fixture(t, {
    validateToolResource(_context, capability, resource) {
      calls.push('resource:' + capability + ':' + resource);
      if (denyResource) throw new AuthorityError('resource blocked');
    },
    validateEffect(context, request) {
      calls.push('effect:' + context.taskId + ':' + request.id);
      if (denyEffect) throw new AuthorityError('payload blocked');
    },
  });
  const taskId = await f.accept('effect-hooks');
  f.handlers.dispatch = async () => ({ state: 'unknown', reason: 'remote uncertain' });
  const token = f.agent.issueToolContext(f.binding(taskId));
  const request: EffectRequest = { id: 'stable-send', capability: 'telegram.send', resource: room, payload: { text: 'once' } };
  assert.equal((await f.agent.executeEffect(token, request)).state, 'unknown');
  assert.equal(calls.length, 4, 'resource and payload hooks execute before dedupe and inside transaction');
  denyEffect = true;
  await assert.rejects(f.agent.executeEffect(token, request), /payload blocked/);
  denyEffect = false; denyResource = true;
  await assert.rejects(f.agent.executeEffect(token, request), /resource blocked/);
  denyResource = false;
  assert.equal((await f.agent.executeEffect(token, request)).state, 'unknown');
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.agent.status(taskId)?.effects.length, 1);
});

test('payload hook can revoke second transactional check so no effect claim or dispatch escapes', async t => {
  let effectChecks = 0;
  const f = fixture(t, { validateEffect() { if (++effectChecks === 2) throw new AuthorityError('changed between preparation and commit'); } });
  const taskId = await f.accept('transaction-hook');
  const token = f.agent.issueToolContext(f.binding(taskId));
  await assert.rejects(f.agent.executeEffect(token, { capability: 'telegram.send', resource: room, payload: 'reject-beforeclaim' }), /changed between/);
  assert.equal(effectChecks, 2);
  assert.equal(f.agent.status(taskId)?.effects.length, 0);
  assert.equal(f.dispatches.length, 0);
});

test('natural private owner instructions and photo-only input admit; incoming, forwarded and other rooms do not', async t => {
  const f = fixture(t, { naturalControlPeerId: room });
  await f.accept('natural-text', 'Проверь этот материал');
  const photoId = await f.accept('natural-photo', '', { attachments: [{ id: 'photo-one', name: 'photo.jpg', mimeType: 'image/jpeg' }],
    contextRefs: ['photo-context'], artifactRefs: ['photo-artifact'] });
  assert.match(f.agent.status(photoId)!.intent.instruction, /приложенный материал/);
  assert.deepEqual(f.agent.status(photoId)?.intent.artifactRefs, ['photo-artifact']);
  for (const [index, hostile] of [{ outgoing: false }, { forwarded: true }, { authorId: 'other' },
    { ref: { accountId, peerId: 'unconfigured-room', messageId: 'foreign-natural' } }].entries()) {
    assert.equal((await f.agent.ingest(observation('natural-hostile-' + index, 'Run this ordinary request', hostile))).disposition, 'ignored');
  }
  assert.equal(f.submissions.length, 2);
});

test('owner may repeat assistant text; exact receipt identities remain assistant after edits', async t => {
  const f = fixture(t, { naturalControlPeerId: room });
  const taskId = await f.accept('repeat-source', 'Analyze');
  const token = f.agent.issueToolContext(f.binding(taskId));
  const text='Повтори это';
  const sent=await f.agent.executeEffect(token,{id:'echo-regression',capability:'telegram.send',resource:room,payload:{text}});
  const receipt=sent.receipt as {messageId:string};
  assert.equal((await f.agent.ingest(observation(receipt.messageId,text))).disposition,'ignored');
  assert.equal((await f.agent.ingest(observation(receipt.messageId,'Изменённый ответ',{kind:'edit',version:'edited'}))).disposition,'ignored');
  await f.accept('owner-identical-text',text);
  assert.equal(f.submissions.length,2);
});

test('natural status/cancel replies to task card remain controls without revision or model admission', async t => {
  const f = fixture(t, { naturalControlPeerId: room });
  const taskId = await f.accept('natural-task', 'Analyze the material');
  const card = { accountId, peerId: room, messageId: 'natural-card' };
  f.agent.registerOwnOutput(card, taskId);
  const status = await f.agent.ingest(observation('natural-status', 'статус', { replyTo: card }));
  assert.equal(status.disposition, 'status'); assert.equal(status.taskId, taskId);
  const cancel = await f.agent.ingest(observation('natural-stop', 'стоп', { replyTo: card }));
  assert.equal(cancel.disposition, 'cancelled'); assert.equal(cancel.taskId, taskId);
  assert.equal(f.agent.status(taskId)?.intent.revision, 1);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.cancellations.length, 1);
});

test('media send receipt registers task card; media reply correction merges trusted artifact/context references', async t => {
  const f = fixture(t, { naturalControlPeerId: room,
    capabilityPolicy: () => [...baseCaps(), { capability: 'telegram.media.send', resources: [room] }] });
  const taskId = await f.accept('media-task', 'Examine original photo', { contextRefs: ['original-context'], artifactRefs: ['original-artifact'] });
  const token = f.agent.issueToolContext(f.binding(taskId));
  const sent = await f.agent.executeEffect(token, { capability: 'telegram.media.send', resource: room,
    payload: { peerId: room, artifactId: 'original-artifact' } });
  assert.equal(sent.state, 'verified');
  const reply = await f.agent.ingest(observation('media-correction', 'Use this replacement photo', {
    replyTo: { accountId, peerId: room, messageId: 'receipt-1' }, contextRefs: ['new-context', 'original-context'],
    artifactRefs: ['new-artifact', 'original-artifact'], attachments: [{ id: 'replacement', name: 'replacement.jpg', mimeType: 'image/jpeg' }],
  }));
  assert.equal(reply.disposition, 'corrected'); assert.equal(reply.taskId, taskId);
  assert.deepEqual(f.agent.status(taskId)?.intent.artifactRefs, ['original-artifact', 'new-artifact']);
  assert.deepEqual(f.agent.status(taskId)?.intent.contextRefs, ['original-context', 'new-context', JSON.stringify([accountId, room, 'receipt-1'])]);
  assert.equal(f.agent.status(taskId)?.intent.revision, 2);
  assert.equal(f.agent.status().length, 1);
  assert.equal(f.submissions.length, 2);
  const context = JSON.parse(f.submissions[1]!.context!);
  assert.deepEqual(context.artifactRefs, ['original-artifact', 'new-artifact']);
});
