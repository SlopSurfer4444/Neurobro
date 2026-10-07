import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Clock, Effect, EffectExecutor, EffectResult, EngineInput, EnginePort, MessageRef,
  Observation, RunBinding, RunSnapshot } from '../../src/contracts.ts';
import { AuthorityError } from '../../src/core/broker.ts';
import { createPersonalAgent, isCadenceFollowup, type PersonalAgent, type PersonalAgentOptions } from '../../src/core/controller.ts';

const accountId = 'account-owner';
const ownerId = 'owner';
const privateRoute = { peerId: 'private-owner' };

class FakeClock implements Clock {
  time = Date.parse('2026-10-04T12:00:00.000Z');
  now(): Date { return new Date(this.time); }
  advance(ms: number): void { this.time += ms; }
}

class FakeEngine implements EnginePort {
  submissions: EngineInput[] = [];
  inspections: RunBinding[] = [];
  cancellations: RunBinding[] = [];
  runs = new Map<string, RunSnapshot>();
  submitResult?: (input: EngineInput) => Promise<RunSnapshot>;
  inspectResult?: (binding: RunBinding) => Promise<RunSnapshot>;
  cancelResult?: (binding: RunBinding) => Promise<RunSnapshot>;
  readonly clock: Clock;
  constructor(clock: Clock) { this.clock = clock; }
  async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; }
  async submit(input: EngineInput): Promise<RunSnapshot> {
    this.submissions.push({ ...input });
    if (this.submitResult) return this.submitResult(input);
    const snapshot: RunSnapshot = { binding: { runId: 'run-' + this.submissions.length,
      sessionId: 'session-' + input.taskId, taskId: input.taskId, intentRevision: input.intentRevision,
      idempotencyKey: input.idempotencyKey }, state: 'running', observedAt: this.clock.now().toISOString() };
    this.runs.set(snapshot.binding.runId, snapshot);
    return snapshot;
  }
  async inspect(binding: RunBinding): Promise<RunSnapshot> {
    this.inspections.push({ ...binding });
    if (this.inspectResult) return this.inspectResult(binding);
    const snapshot = this.runs.get(binding.runId);
    assert.ok(snapshot, 'fixture must know inspected run');
    return snapshot;
  }
  async cancel(binding: RunBinding): Promise<RunSnapshot> {
    this.cancellations.push({ ...binding });
    if (this.cancelResult) return this.cancelResult(binding);
    const snapshot: RunSnapshot = { binding, state: 'cancelled', observedAt: this.clock.now().toISOString() };
    this.runs.set(binding.runId, snapshot);
    return snapshot;
  }
  complete(taskId: string, output = 'Completed private result'): void {
    const snapshot = [...this.runs.values()].find(run => run.binding.taskId === taskId && run.state === 'running');
    assert.ok(snapshot, 'fixture must have a live run to complete');
    this.runs.set(snapshot.binding.runId, { ...snapshot, state: 'completed', output,
      observedAt: this.clock.now().toISOString() });
  }
}

class FakeExecutor implements EffectExecutor {
  dispatches: Effect[] = [];
  reconciliations: Effect[] = [];
  dispatchResult: (effect: Effect) => Promise<EffectResult> = async effect => ({ state: 'verified',
    receipt: { peerId: effect.resource, messageId: 'sent-' + this.dispatches.length } });
  reconcileResult: (effect: Effect) => Promise<EffectResult> = async () => ({ state: 'unknown', reason: 'No remote proof' });
  async dispatch(effect: Effect): Promise<EffectResult> {
    this.dispatches.push({ ...effect }); return this.dispatchResult(effect);
  }
  async reconcile(effect: Effect): Promise<EffectResult> {
    this.reconciliations.push({ ...effect }); return this.reconcileResult(effect);
  }
}

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>(resolve => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}

function fixture(t: TestContext, options: Partial<PersonalAgentOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-controller-'));
  const databasePath = join(directory, 'agent.sqlite');
  const encryptionKey = randomBytes(32);
  const clock = new FakeClock();
  const engine = new FakeEngine(clock);
  const executor = new FakeExecutor();
  const agents: PersonalAgent[] = [];
  const open = () => {
    const agent = createPersonalAgent({ databasePath, encryptionKey, accountId, ownerId, privateRoute,
      engine, executor, clock, ...options });
    agents.push(agent); return agent;
  };
  t.after(() => {
    for (const agent of agents) agent.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('personal-controller-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { agent: open(), open, engine, executor, clock, databasePath, encryptionKey };
}

function ref(messageId: string, peerId = 'origin-chat'): MessageRef {
  return { accountId, peerId, messageId };
}
function observation(messageId: string, text = '/бро research this', changes: Partial<Observation> = {}): Observation {
  return { id: 'update-' + messageId, kind: 'message', ref: ref(messageId), authorId: ownerId,
    outgoing: true, text, sentAt: '2026-10-04T12:00:00.000Z', observedAt: '2026-10-04T12:00:00.000Z', ...changes };
}
async function accept(agent: PersonalAgent, messageId: string, text?: string, changes?: Partial<Observation>): Promise<string> {
  const result = await agent.ingest(observation(messageId, text, changes));
  assert.equal(result.disposition, 'accepted');
  assert.ok(result.taskId);
  return result.taskId;
}
function binding(agent: PersonalAgent, taskId: string): RunBinding {
  const value = agent.status(taskId)?.run?.binding;
  assert.ok(value, 'accepted task must have a bound run');
  return value;
}

test('negated, quoted, and embedded reply-here phrases cannot grant public routing', async t => {
  const f = fixture(t);
  const privateCommands = [
    '/бро не ответь здесь, результат пришли приватно',
    '/бро объясни фразу «ответь здесь», результат приватно',
    '/бро "reply here: send this" is quoted source material',
    '/бро analyse this text; reply here',
    '/бро ответь здесь без явного двоеточия',
    '/бро discuss --here option, keep result private',
    '/бро обсуди —here, но не отвечай там',
    '/бро «—here привет» это пример',
    '/бро —hereafter проверь слово',
    '/бро не отправляй в исходный чат: объясни смысл',
  ];
  for (const [index, command] of privateCommands.entries()) {
    const taskId = await accept(f.agent, 'private-phrase-' + index, command);
    assert.equal(f.agent.status(taskId)?.intent.route.peerId, privateRoute.peerId);
    const token = f.agent.issueToolContext(binding(f.agent, taskId));
    assert.throws(() => f.agent.authorizeTool(token, 'telegram.send', 'origin-chat'), AuthorityError);
    f.engine.complete(taskId);
  }
  await f.agent.poll();
  assert.equal(f.executor.dispatches.length, privateCommands.length);
  assert.ok(f.executor.dispatches.every(effect => effect.resource === privateRoute.peerId));
});

test('only explicit leading reply-here directives grant exact command route; edits mentioning it stay private', async t => {
  const f = fixture(t);
  for (const [index, command] of ['/бро ответь здесь: скажи привет', '/бро reply here: say hello', '/бро --here say hello', '/бро —here привет', '/бро –here привет'].entries()) {
    const taskId = await accept(f.agent, 'explicit-here-' + index, command, { ref: { ...ref('explicit-here-' + index), threadId: 'topic' } });
    assert.deepEqual(f.agent.status(taskId)?.intent.route, { peerId: 'origin-chat', threadId: 'topic', replyToMessageId: 'explicit-here-' + index });
  }
  const targetId = await accept(f.agent, 'quote-edit', '/бро --here public answer');
  const oldToken = f.agent.issueToolContext(binding(f.agent, targetId));
  await f.agent.ingest(observation('quote-edit', '/бро объясни цитату «ответь здесь:», результат приватно', {
    id: 'quoted-edit', kind: 'edit', version: '2', editedAt: f.clock.now().toISOString(),
  }));
  assert.equal(f.agent.status(targetId)?.intent.route.peerId, privateRoute.peerId);
  assert.throws(() => f.agent.resolveToolContext(oldToken), AuthorityError);
});

test('single cron context revocation persists and leaves sibling executions and task grant intact', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'schedule-context');
  const foreground = f.agent.issueToolContext(binding(f.agent, taskId));
  const context = f.agent.resolveToolContext(foreground);
  const first = f.agent.issueExecutionContext({ ...context, runId: 'cron:job-a:execution-1' });
  const second = f.agent.issueExecutionContext({ ...context, runId: 'cron:job-b:execution-1' });
  f.agent.revokeToolContext(first);
  f.agent.revokeToolContext(first); // Repeated native pause/cancel acknowledgment is harmless.
  assert.throws(() => f.agent.resolveToolContext(first), AuthorityError);
  f.agent.authorizeTool(second, 'telegram.send', privateRoute.peerId);
  f.agent.authorizeTool(foreground, 'telegram.send', privateRoute.peerId);
  assert.equal(f.agent.status(taskId)?.state, 'working');
  f.agent.close();
  const recovered = f.open(); await recovered.start();
  assert.throws(() => recovered.resolveToolContext(first), AuthorityError);
  assert.equal(recovered.resolveToolContext(second).runId, 'cron:job-b:execution-1');
  assert.equal(recovered.resolveToolContext(foreground).taskId, taskId);
});

test('only direct authenticated owner commands admit; registered and receipted agent output cannot loop', async t => {
  const { agent, engine, executor } = fixture(t);
  for (const [index, hostile] of [
    { authorId: 'other-owner' }, { outgoing: false }, { forwarded: true }, { viaBot: true },
    { ref: { ...ref('wrong-account'), accountId: 'different-account' } },
  ].entries()) {
    assert.equal((await agent.ingest(observation('hostile-' + index, '/бро do work', hostile))).disposition, 'ignored');
  }
  assert.equal(engine.submissions.length, 0);
  const taskId = await accept(agent, 'real-command');
  agent.registerOwnOutput(ref('own-card', privateRoute.peerId), taskId);
  assert.equal((await agent.ingest(observation('own-card', '/бро accidental loop', {
    ref: ref('own-card', privateRoute.peerId),
  }))).disposition, 'ignored');
  const token = agent.issueToolContext(binding(agent, taskId));
  const effect = await agent.executeEffect(token, { capability: 'telegram.send', resource: privateRoute.peerId,
    payload: { text: '/бро generated command text' } });
  assert.equal(effect.state, 'verified');
  assert.equal((await agent.ingest(observation('sent-1', '/бро generated command text', {
    ref: ref('sent-1', privateRoute.peerId),
  }))).disposition, 'ignored');
  assert.equal(engine.submissions.length, 1);
  assert.equal(executor.dispatches.length, 1);
});

test('same source observed under different update IDs admits one run across restart', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'source-one');
  assert.equal((await f.agent.ingest(observation('source-one', '/бро changed wire text', { id: 'different-wire-update' }))).disposition, 'duplicate');
  f.agent.close();
  const reopened = f.open();
  const repeated = await reopened.ingest(observation('source-one', '/бро research this', { id: 'restart-update' }));
  assert.equal(repeated.disposition, 'duplicate');
  assert.equal(repeated.taskId, taskId);
  assert.equal(reopened.status().length, 1);
  assert.equal(f.engine.submissions.length, 1);
});

test('results route privately by default; explicit reply-here binds thread and command anchor', async t => {
  const { agent, engine, executor } = fixture(t);
  const privateId = await accept(agent, 'private-task');
  const originId = await accept(agent, 'origin-task', '/бро reply here: research this', {
    ref: { ...ref('origin-task'), threadId: 'thread-17' },
  });
  engine.complete(privateId); engine.complete(originId);
  const result = await agent.poll();
  assert.equal(result.deliveries.length, 2);
  const privateSend = executor.dispatches.find(effect => effect.taskId === privateId)!;
  const originSend = executor.dispatches.find(effect => effect.taskId === originId)!;
  assert.equal(privateSend.resource, privateRoute.peerId);
  assert.deepEqual(originSend.payload, { peerId: 'origin-chat', threadId: 'thread-17', replyToMessageId: 'origin-task',
    text: '🤖 Нейробратик\n\nCompleted private result' });
  await agent.poll();
  assert.equal(executor.dispatches.length, 2, 'polling complete runs cannot send another copy');
});

test('two active tasks require precise status/cancel targeting and cancellation preserves the sibling', async t => {
  const { agent, engine } = fixture(t);
  const first = await accept(agent, 'task-a');
  const second = await accept(agent, 'task-b');
  assert.equal((await agent.ingest(observation('ambiguous-status', '/бро status'))).disposition, 'ambiguous');
  assert.equal((await agent.ingest(observation('ambiguous-cancel', '/бро cancel'))).disposition, 'ambiguous');
  assert.equal(engine.cancellations.length, 0);
  const precise = await agent.ingest(observation('precise-status', '/бро status #' + first));
  assert.equal(precise.disposition, 'status'); assert.equal(precise.taskId, first);
  agent.registerOwnOutput(ref('card-b', privateRoute.peerId), second);
  const cancelled = await agent.ingest(observation('precise-cancel', '/бро cancel', { replyTo: ref('card-b', privateRoute.peerId) }));
  assert.equal(cancelled.disposition, 'cancelled'); assert.equal(cancelled.taskId, second);
  assert.equal(agent.status(second)?.state, 'cancelled');
  assert.equal(agent.status(first)?.state, 'working');
  assert.deepEqual(engine.cancellations.map(value => value.taskId), [second]);
  assert.equal(engine.submissions.length, 2, 'control commands are never engine tasks');
});

test('capability tokens are opaque, scoped to task resources, and invalid after cancellation', async t => {
  const { agent, executor } = fixture(t);
  const first = await accept(agent, 'a', '/бро reply here: work', { ref: ref('a', 'chat-a') });
  const second = await accept(agent, 'b', '/бро reply here: work', { ref: ref('b', 'chat-b') });
  const firstToken = agent.issueToolContext(binding(agent, first));
  const secondToken = agent.issueToolContext(binding(agent, second));
  assert.equal(agent.resolveToolContext(firstToken).taskId, first);
  assert.equal(agent.authorizeTool(firstToken, 'telegram.send', 'chat-a').taskId, first);
  assert.throws(() => agent.authorizeTool(firstToken, 'telegram.send', 'chat-b'), AuthorityError);
  assert.throws(() => agent.resolveToolContext(firstToken + '-tampered'), AuthorityError);
  await assert.rejects(agent.executeEffect(firstToken, { capability: 'telegram.send', resource: 'chat-b', payload: 'injected' }), AuthorityError);
  assert.equal(executor.dispatches.length, 0);
  await agent.cancel(first);
  assert.throws(() => agent.resolveToolContext(firstToken), AuthorityError);
  assert.equal(agent.authorizeTool(secondToken, 'telegram.send', 'chat-b').taskId, second);
});

test('parent cancellation revokes authority before child stop and retains unsettled child across restart', async t => {
  const stops: Array<{ taskId: string; revision: number }> = [];
  let activeToken = ''; let agent!: PersonalAgent;
  const f = fixture(t, { onTaskStop: async (taskId, _reason, revision) => {
    assert.throws(() => agent.resolveToolContext(activeToken), AuthorityError);
    stops.push({ taskId, revision }); return { settled: false, reason: 'Child effects not reconciled' };
  } });
  agent = f.agent; const id = await accept(agent, 'owned-child');
  activeToken = agent.issueToolContext(agent.status(id)!.run!.binding);
  const cancelled = await agent.cancel(id);
  assert.equal(cancelled?.state, 'unknown'); assert.ok(cancelled?.cancelledAt);
  assert.match(cancelled!.reason!, /Child effects/); assert.deepEqual(stops, [{ taskId: id, revision: 1 }]);
  assert.equal(f.engine.cancellations.length, 1);
  agent.close(); agent = f.open(); await agent.start();
  assert.equal(agent.status(id)?.state, 'unknown'); assert.equal(stops.length, 2);
  assert.equal(f.engine.submissions.length, 1);
});

test('correction waits for child execution/effect settlement before admitting fresh revision', async t => {
  let settled = false;
  const stoppedRevisions: number[] = [];
  const f = fixture(t, { onTaskStop: async (_id, _reason, revision) => {
    stoppedRevisions.push(revision); return { settled, reason: settled ? undefined : 'Child still unresolved' };
  } });
  const id = await accept(f.agent, 'child-correction');
  const changed = await f.agent.correct(id, 'new objective');
  assert.equal(changed?.intent.revision, 2); assert.equal(changed?.state, 'unknown');
  assert.equal(f.engine.submissions.length, 1); assert.deepEqual(stoppedRevisions, [1]);
  await f.agent.poll(); assert.equal(f.engine.submissions.length, 1);
  settled = true; await f.agent.poll();
  assert.equal(f.engine.submissions.length, 2); assert.equal(f.engine.submissions[1]?.intentRevision, 2);
});

test('source hold stops the child and a thrown child callback stays durably UNKNOWN', async t => {
  const stops: string[] = [];
  const f = fixture(t, { onTaskStop: async (id) => { stops.push(id); throw new Error('Child stop response lost'); } });
  const id = await accept(f.agent, 'child-hold');
  await f.agent.suspendTask(id, 'Owner access invalidated');
  assert.deepEqual(stops, [id]); assert.ok(f.agent.status(id)?.heldAt);
  assert.equal(f.agent.status(id)?.state, 'unknown'); assert.match(f.agent.status(id)!.reason!, /response lost/);
  await f.agent.correct(id, 'updated objective'); assert.equal(f.engine.submissions.length, 1);
});

test('context and grant deadlines separately revoke authority and prevent late completed delivery', async t => {
  const f = fixture(t, { toolContextTtlMs: 10, grantTtlMs: 100 });
  const taskId = await accept(f.agent, 'deadline');
  const token = f.agent.issueToolContext(binding(f.agent, taskId));
  f.clock.advance(10);
  assert.throws(() => f.agent.resolveToolContext(token), AuthorityError);
  const renewed = f.agent.issueToolContext(binding(f.agent, taskId));
  assert.equal(f.agent.resolveToolContext(renewed).taskId, taskId);
  f.clock.advance(90);
  assert.throws(() => f.agent.issueToolContext(binding(f.agent, taskId)), AuthorityError);
  f.engine.complete(taskId);
  assert.equal((await f.agent.poll()).deliveries.length, 0);
  assert.equal(f.executor.dispatches.length, 0);
});

test('UNKNOWN dispatch is not retried; restart reconciles it with original identity and captures verified output', async t => {
  const f = fixture(t);
  f.executor.dispatchResult = async () => { throw new Error('Connection lost after remote acceptance'); };
  const taskId = await accept(f.agent, 'unknown-send');
  const token = f.agent.issueToolContext(binding(f.agent, taskId));
  const request = { id: 'one-send', capability: 'telegram.send', resource: privateRoute.peerId, payload: { text: 'result' } };
  const first = await f.agent.executeEffect(token, request);
  assert.equal(first.state, 'unknown');
  assert.equal((await f.agent.executeEffect(token, request)).id, first.id);
  assert.equal(f.executor.dispatches.length, 1);
  assert.equal(f.agent.status(taskId)?.state, 'unknown');
  f.agent.close();
  f.executor.reconcileResult = async effect => ({ state: 'verified', receipt: { peerId: effect.resource, messageId: 'recovered-output' } });
  const reopened = f.open();
  await reopened.start();
  assert.deepEqual(f.executor.reconciliations.map(effect => effect.id), [first.id]);
  assert.equal(reopened.status(taskId)?.effects[0]?.state, 'verified');
  assert.equal(f.executor.dispatches.length, 1);
  assert.equal((await reopened.ingest(observation('recovered-output', '/бро loop', {
    ref: ref('recovered-output', privateRoute.peerId),
  }))).disposition, 'ignored');
  const reopenedToken = reopened.issueToolContext(binding(reopened, taskId));
  assert.equal((await reopened.executeEffect(reopenedToken, request)).state, 'verified');
  assert.equal(f.executor.dispatches.length, 1);
});

test('cancel during an in-flight send preserves actual verified outcome and blocks future effects', async t => {
  const f = fixture(t);
  const entered = deferred<void>();
  const receipt = deferred<EffectResult>();
  f.executor.dispatchResult = async () => { entered.resolve(); return receipt.promise; };
  const taskId = await accept(f.agent, 'cancel-race');
  const token = f.agent.issueToolContext(binding(f.agent, taskId));
  const sending = f.agent.executeEffect(token, { id: 'inflight', capability: 'telegram.send', resource: privateRoute.peerId,
    payload: { text: 'already dispatched' } });
  await entered.promise;
  await f.agent.cancel(taskId);
  assert.equal(f.agent.status(taskId)?.state, 'unknown', 'in-flight effect cannot be reported safely cancelled');
  receipt.resolve({ state: 'verified', receipt: { peerId: privateRoute.peerId, messageId: 'race-output' } });
  const effect = await sending;
  assert.equal(effect.state, 'verified');
  assert.equal(f.agent.status(taskId)?.state, 'cancelled');
  await assert.rejects(f.agent.executeEffect(token, { capability: 'telegram.send', resource: privateRoute.peerId, payload: 'another' }), AuthorityError);
  assert.equal(f.executor.dispatches.length, 1);
  assert.equal((await f.agent.ingest(observation('race-output', '/бро loop', { ref: ref('race-output', privateRoute.peerId) }))).disposition, 'ignored');
});

test('lost engine submit remains UNKNOWN after long offline restart without a new admission', async t => {
  const f = fixture(t);
  f.engine.submitResult = async () => { throw new Error('Engine accepted operation but connection died'); };
  const taskId = await accept(f.agent, 'lost-submit');
  assert.equal(f.agent.status(taskId)?.state, 'unknown');
  assert.equal(f.agent.status(taskId)?.run, undefined);
  const originalInput = f.engine.submissions[0]!;
  f.agent.close();
  f.clock.advance(30 * 24 * 60 * 60 * 1000);
  const reopened = f.open();
  await reopened.start(); await reopened.poll();
  assert.equal(reopened.status(taskId)?.admission?.state, 'unknown');
  assert.equal((await reopened.ingest(observation('lost-submit', '/бро same command', { id: 'after-offline' }))).disposition, 'duplicate');
  assert.equal(f.engine.submissions.length, 1);
  assert.equal(f.engine.submissions[0]?.idempotencyKey, originalInput.idempotencyKey);
  assert.equal(f.executor.dispatches.length, 0);
});

test('engine submit with a foreign task binding fails closed and cannot issue effect authority', async t => {
  const f = fixture(t);
  f.engine.submitResult = async input => ({ binding: { runId: 'foreign-run', taskId: 'different-task',
    intentRevision: input.intentRevision, idempotencyKey: input.idempotencyKey }, state: 'completed', output: 'unsafe',
    observedAt: f.clock.now().toISOString() });
  const taskId = await accept(f.agent, 'misbound-submit');
  assert.equal(f.agent.status(taskId)?.state, 'unknown');
  assert.equal(f.agent.status(taskId)?.run, undefined);
  assert.throws(() => f.agent.issueToolContext({ ...f.engine.submissions[0]!, runId: 'foreign-run' }), AuthorityError);
  await f.agent.poll();
  assert.equal(f.executor.dispatches.length, 0);
});

test('inspection of a registered run cannot substitute another run/session even with same task revision and key', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'misbound-inspect');
  const original = binding(f.agent, taskId);
  f.engine.inspectResult = async bound => ({ binding: { ...bound, runId: 'other-run', sessionId: 'other-session' },
    state: 'completed', output: 'foreign execution output', observedAt: f.clock.now().toISOString() });
  await f.agent.poll();
  assert.equal(f.agent.status(taskId)?.state, 'unknown');
  assert.deepEqual(f.agent.status(taskId)?.run?.binding, original);
  assert.equal(f.executor.dispatches.length, 0);
});

test('reply to an agent card corrects its existing task; reply to human message creates a distinct task', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'original');
  f.agent.registerOwnOutput(ref('agent-card', privateRoute.peerId), taskId);
  const correction = await f.agent.ingest(observation('correction', 'Use the revised figures', {
    replyTo: ref('agent-card', privateRoute.peerId),
  }));
  assert.equal(correction.disposition, 'corrected'); assert.equal(correction.taskId, taskId);
  assert.equal(f.agent.status(taskId)?.intent.revision, 2);
  assert.match(f.agent.status(taskId)!.intent.instruction, /Use the revised figures/);
  assert.equal(f.engine.cancellations.length, 1);
  assert.equal(f.engine.submissions.length, 2);
  const humanRef = ref('human-message');
  assert.equal((await f.agent.ingest(observation('human-reply-without-prefix', 'thanks', { replyTo: humanRef }))).disposition, 'ignored');
  const newTask = await accept(f.agent, 'human-reply-command', '/бро analyze the quoted discussion', { replyTo: humanRef });
  assert.notEqual(newTask, taskId);
  assert.deepEqual(f.agent.status(newTask)?.intent.contextRefs, [JSON.stringify([accountId, humanRef.peerId, humanRef.messageId])]);
  assert.equal(f.agent.status().length, 2);
  assert.equal(f.engine.submissions.length, 3);
});

test('editing an accepted command revokes old revision tokens and binds the replacement instruction', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'editable');
  const oldToken = f.agent.issueToolContext(binding(f.agent, taskId));
  const result = await f.agent.ingest(observation('editable', '/бро reply here: revised request', {
    id: 'edited-update', kind: 'edit', version: '2',
  }));
  assert.equal(result.disposition, 'corrected'); assert.equal(result.taskId, taskId);
  assert.equal(f.agent.status(taskId)?.intent.revision, 2);
  assert.throws(() => f.agent.resolveToolContext(oldToken), AuthorityError);
  const token = f.agent.issueToolContext(binding(f.agent, taskId));
  assert.equal(f.agent.authorizeTool(token, 'telegram.send', 'origin-chat').intentRevision, 2);
  assert.throws(() => f.agent.authorizeTool(token, 'telegram.send', privateRoute.peerId), AuthorityError);
});

test('cadence-only private follow-up revises unique unfinished task and preserves the owner source chain', async t => {
  const f = fixture(t, { naturalControlPeerId: privateRoute.peerId });
  const taskId = await accept(f.agent, '10', 'Наблюдай выбранные источники', { ref: ref('10', privateRoute.peerId) });
  const oldToken = f.agent.issueToolContext(binding(f.agent, taskId));
  const result = await f.agent.ingest(observation('11', 'Давай только эт. Раз в пару часов', { ref: ref('11', privateRoute.peerId), contextRefs: ['fresh-owner-source'] }));
  assert.equal(result.disposition, 'corrected'); assert.equal(result.taskId, taskId);
  assert.equal(f.agent.status().length, 1); assert.equal(f.agent.status(taskId)?.intent.revision, 2);
  assert.ok(f.agent.status(taskId)?.intent.contextRefs.includes('fresh-owner-source'));
  assert.throws(() => f.agent.resolveToolContext(oldToken), AuthorityError);
  assert.equal(f.engine.cancellations.length, 1); assert.equal(f.engine.submissions.length, 2);
  const edit = await f.agent.ingest(observation('11', 'Раз в три часа', { ref: ref('11', privateRoute.peerId), kind: 'edit', version: 'edited', editedAt: '2026-10-04T12:00:01Z' }));
  assert.equal(edit.disposition, 'corrected'); assert.equal(edit.taskId, taskId);
  assert.equal(f.agent.status(taskId)?.intent.revision, 3);
  const reply = await f.agent.ingest(observation('12', 'Раз в четыре часа', { ref: ref('12', privateRoute.peerId), replyTo: ref('11', privateRoute.peerId), sentAt: '2026-10-04T12:00:02Z' }));
  assert.equal(reply.disposition, 'corrected'); assert.equal(reply.taskId, taskId);
});

test('implicit cadence is ambiguous between tasks and host can preserve existing schedule authority', async t => {
  const f = fixture(t, { naturalControlPeerId: privateRoute.peerId, canApplyImplicitCorrection: () => false });
  const taskId = await accept(f.agent, '20', 'Наблюдай источник', { ref: ref('20', privateRoute.peerId) });
  const amendment = await f.agent.ingest(observation('21', 'Раз в два часа', { ref: ref('21', privateRoute.peerId) }));
  assert.equal(amendment.disposition, 'accepted'); assert.notEqual(amendment.taskId, taskId);
  assert.equal(f.agent.status(taskId)?.intent.revision, 1); assert.equal(f.engine.cancellations.length, 0);
  const ambiguous = await f.agent.ingest(observation('22', 'Раз в три часа', { ref: ref('22', privateRoute.peerId) }));
  assert.equal(ambiguous.disposition, 'ambiguous'); assert.equal(f.engine.submissions.length, 2);
});

test('out-of-order older amendments cannot replace the latest owner cadence across restart', async t => {
  const f = fixture(t, { naturalControlPeerId: privateRoute.peerId });
  const taskId = await accept(f.agent, '30', 'Наблюдай источник', { ref: ref('30', privateRoute.peerId) });
  assert.equal((await f.agent.ingest(observation('32', 'Раз в два часа', { ref: ref('32', privateRoute.peerId) }))).disposition, 'corrected');
  f.agent.close(); const reopened = f.open(); await reopened.start();
  const old = await reopened.ingest(observation('31', 'Раз в 15 минут', { ref: ref('31', privateRoute.peerId) }));
  assert.equal(old.disposition, 'ignored'); assert.equal(reopened.status(taskId)?.intent.revision, 2);
  assert.doesNotMatch(reopened.status(taskId)!.intent.instruction, /15 минут/); assert.equal(f.engine.submissions.length, 2);
});

test('newer cadence during awaited old cancellation fences obsolete successor and retains only latest revision', async t => {
  const f = fixture(t, { naturalControlPeerId: privateRoute.peerId });
  const taskId = await accept(f.agent, '40', 'Наблюдай источник', { ref: ref('40', privateRoute.peerId) });
  const entered = deferred<void>(), cancelled = deferred<RunSnapshot>();
  f.engine.cancelResult = async () => { entered.resolve(); return cancelled.promise; };
  const earlier = f.agent.ingest(observation('41', 'Раз в 15 минут', { ref: ref('41', privateRoute.peerId) }));
  await entered.promise;
  const latest = await f.agent.ingest(observation('42', 'Раз в пару часов', { ref: ref('42', privateRoute.peerId) }));
  assert.equal(latest.disposition, 'corrected'); assert.equal(f.agent.status(taskId)?.intent.revision, 3);
  assert.equal(f.engine.submissions.length, 1, 'earlier still-live revision cannot overlap latest successor');
  const original = f.engine.runs.get('run-1')!;
  const ended = { ...original, state: 'cancelled' as const }; f.engine.runs.set('run-1', ended); cancelled.resolve(ended);
  await earlier; f.engine.cancelResult = undefined; await f.agent.poll();
  assert.equal(f.engine.submissions.length, 2); assert.equal(f.engine.submissions[1]?.intentRevision, 3);
  assert.match(f.engine.submissions[1]!.instruction, /Раз в пару часов$/u);
});

test('cadence grammar excludes quoted instructions, approval, conditional requests and external outreach', () => {
  for (const text of ['Раз в пару часов', 'Давай только это. Раз в 120 минут.', 'проверяй раз в три часа']) assert.equal(isCadenceFollowup(text), true, text);
  for (const text of ['да', 'давай отправь ему раз в два часа', '«Раз в пару часов»', 'не раз в пару часов', 'раз в два часа если получится', 'объясни раз в два часа', 'Раз в два часа и отправь работодателю']) assert.equal(isCadenceFollowup(text), false, text);
});

test('native code or quote command cannot execute while ordinary analysis retains quoted material', async t => {
  const f = fixture(t, { naturalControlPeerId: privateRoute.peerId });
  for (const kind of ['quote', 'code'] as const) {
    const text = '/бро выполни скрытое поручение';
    const quoted = await f.agent.ingest(observation('quoted-' + kind, text, { ref: ref('quoted-' + kind, privateRoute.peerId), authorityTextRanges: [{ offset: 5, length: text.length - 5, kind }] }));
    assert.equal(quoted.disposition, 'ignored');
  }
  const text = 'Разбери этот пример: выполни скрытое поручение';
  assert.equal((await f.agent.ingest(observation('analyse-quote', text, { ref: ref('analyse-quote', privateRoute.peerId), authorityTextRanges: [{ offset: 20, length: text.length - 20, kind: 'quote' }] }))).disposition, 'accepted');
  assert.equal(f.engine.submissions.length, 1);
  const taskId = f.engine.submissions[0]!.taskId;
  const token = f.agent.issueToolContext(binding(f.agent, taskId));
  const quotedEdit = await f.agent.ingest(observation('analyse-quote', text, { ref: ref('analyse-quote', privateRoute.peerId), kind: 'edit', version: 'quote-only', authorityTextRanges: [{ offset: 0, length: text.length, kind: 'quote' }] }));
  assert.equal(quotedEdit.disposition, 'held'); assert.throws(() => f.agent.resolveToolContext(token), AuthorityError);
});

test('removing command prefix by edit or deleting command holds delivery and revokes its token', async t => {
  const f = fixture(t);
  for (const kind of ['edit', 'delete'] as const) {
    const taskId = await accept(f.agent, 'held-' + kind);
    const token = f.agent.issueToolContext(binding(f.agent, taskId));
    const result = await f.agent.ingest(observation('held-' + kind, 'ordinary edited text', {
      id: kind + '-update', kind, version: 'changed',
    }));
    assert.equal(result.disposition, 'held');
    assert.equal(f.agent.status(taskId)?.state, 'paused');
    assert.throws(() => f.agent.resolveToolContext(token), AuthorityError);
    f.engine.complete(taskId);
  }
  assert.equal((await f.agent.poll()).deliveries.length, 0);
  assert.equal(f.executor.dispatches.length, 0);
});

test('unauthenticated delete cannot revoke an accepted owner command', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'protected-command');
  const token = f.agent.issueToolContext(binding(f.agent, taskId));
  const hostile = await f.agent.ingest(observation('protected-command', undefined, {
    id: 'forged-delete', kind: 'delete', outgoing: false, authorId: 'attacker', forwarded: true,
  }));
  assert.equal(hostile.disposition, 'ignored');
  assert.equal(f.agent.status(taskId)?.state, 'working');
  assert.equal(f.agent.authorizeTool(token, 'telegram.send', privateRoute.peerId).taskId, taskId);
});

test('correction is saved but no successor is admitted while old run cancellation is UNKNOWN', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'blocked-correction');
  const oldToken = f.agent.issueToolContext(binding(f.agent, taskId));
  f.engine.inspectResult = async () => { throw new Error('old execution still unreachable'); };
  await f.agent.poll();
  f.engine.cancelResult = async () => { throw new Error('cancellation outcome unknown'); };
  const corrected = await f.agent.correct(taskId, 'change the objective');
  assert.equal(corrected?.state, 'paused');
  assert.equal(corrected?.intent.revision, 2);
  assert.match(corrected!.reason!, /cancellation is unknown/);
  assert.throws(() => f.agent.resolveToolContext(oldToken), AuthorityError);
  assert.equal(f.engine.submissions.length, 1);
  f.agent.close();
  const reopened = f.open();
  await reopened.start(); await reopened.poll();
  assert.equal(reopened.status(taskId)?.state, 'paused');
  assert.equal(f.engine.submissions.length, 1);
  assert.equal(f.executor.dispatches.length, 0);
});

test('correction cannot recreate an unresolved original engine admission or UNKNOWN external send', async t => {
  const admission = fixture(t);
  admission.engine.submitResult = async () => { throw new Error('lost submit receipt'); };
  const taskId = await accept(admission.agent, 'unknown-admission');
  const corrected = await admission.agent.correct(taskId, 'amended request');
  assert.equal(corrected?.state, 'paused');
  assert.match(corrected!.reason!, /admission is (unknown|unresolved)/);
  assert.equal(admission.engine.submissions.length, 1);

  const external = fixture(t);
  const externalId = await accept(external.agent, 'unknown-effect');
  external.executor.dispatchResult = async () => ({ state: 'unknown', reason: 'remote acceptance cannot be ruled out' });
  await external.agent.executeEffect(external.agent.issueToolContext(binding(external.agent, externalId)), {
    capability: 'telegram.send', resource: privateRoute.peerId, payload: 'possibly sent',
  });
  const held = await external.agent.correct(externalId, 'change result');
  assert.equal(held?.state, 'unknown');
  assert.ok(held?.heldAt);
  assert.match(held!.reason!, /external effects must be reconciled/);
  assert.equal(external.engine.submissions.length, 1);
});

test('owner manual speech in the origin revokes queued origin authority without affecting private tasks', async t => {
  const f = fixture(t);
  const originId = await accept(f.agent, 'origin-draft', '/бро reply here: prepare reply');
  const privateId = await accept(f.agent, 'private-draft');
  const originToken = f.agent.issueToolContext(binding(f.agent, originId));
  const privateToken = f.agent.issueToolContext(binding(f.agent, privateId));
  assert.equal((await f.agent.ingest(observation('manual-owner-answer', 'I have already answered them'))).disposition, 'ignored');
  assert.throws(() => f.agent.authorizeTool(originToken, 'telegram.send', 'origin-chat'), AuthorityError);
  assert.equal(f.agent.authorizeTool(privateToken, 'telegram.send', privateRoute.peerId).taskId, privateId);
  f.engine.complete(originId); f.engine.complete(privateId);
  await f.agent.poll();
  assert.deepEqual(f.executor.dispatches.map(effect => effect.taskId), [privateId]);
});

test('engine lacking durable session capability rejects admission before any source task or effect exists', async t => {
  const f = fixture(t);
  f.engine.capabilities = async () => ({ durable: false, sessions: true, cancel: true, steer: false });
  await assert.rejects(f.agent.ingest(observation('nondurable')), /durable runs and sessions/);
  assert.equal(f.agent.status().length, 0);
  assert.equal(f.engine.submissions.length, 0);
  assert.equal(f.executor.dispatches.length, 0);
});

test('account-bound authorless permanent tombstone holds only its exact accepted source', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'tdlib-delete');
  const unknownRef = await f.agent.ingest(observation('unaccepted-message', undefined, {
    kind: 'delete', authorId: undefined, outgoing: false,
  }));
  assert.equal(unknownRef.disposition, 'ignored');
  assert.equal(f.agent.status(taskId)?.state, 'working');
  const deleted = await f.agent.ingest(observation('tdlib-delete', undefined, {
    id: 'permanent-delete-update', kind: 'delete', authorId: undefined, outgoing: false,
  }));
  assert.equal(deleted.disposition, 'held');
  assert.equal(deleted.taskId, taskId);
  assert.equal(f.agent.status(taskId)?.state, 'paused');
  assert.equal(f.engine.submissions.length, 1);
});

const controllerUrl = new URL('../../src/core/controller.ts', import.meta.url).href;
function crashChild(f: ReturnType<typeof fixture>, boundary: 'logged' | 'reserved' | 'correction' | 'logged-delete' | 'logged-cancel'): void {
  f.agent.close();
  const source = `import { createPersonalAgent } from ${JSON.stringify(controllerUrl)};
    const stamp = '2026-10-04T12:00:00.000Z';
    const boundary = process.argv[3];
    const engine = {
      async capabilities() { return { durable:true, sessions:true, cancel:true, steer:false }; },
      async submit(input) {
        if (boundary === 'reserved') process.exit(81);
        return { binding: {runId:'child-original-run',sessionId:'child-session',taskId:input.taskId,
          intentRevision:input.intentRevision,idempotencyKey:input.idempotencyKey},state:'running',observedAt:stamp };
      },
      async inspect() { throw new Error('original run is unreachable'); },
      async cancel() { process.exit(81); }
    };
    const agent=createPersonalAgent({databasePath:process.argv[1],encryptionKey:Buffer.from(process.argv[2],'hex'),
      accountId:'account-owner',ownerId:'owner',privateRoute:{peerId:'private-owner'},engine});
    await agent.start();
    if(boundary==='logged') {
      const transaction=agent.store.transaction.bind(agent.store);
      let transactions=0;
      agent.store.transaction=fn=>{
        transactions++;
        if(transactions===2) process.exit(81);
        return transaction(fn);
      };
    }
    const command={id:'crash-source-event',kind:'message',ref:{accountId:'account-owner',peerId:'origin-chat',messageId:'crash-source'},
      authorId:'owner',outgoing:true,text:'/бро original crash objective',sentAt:stamp,observedAt:stamp};
    if(boundary==='logged-delete'||boundary==='logged-cancel') {
      const insert=agent.store.insert.bind(agent.store);
      agent.store.insert=(collection,key,value)=>{
        if(collection==='admissions') {
          const pending=boundary==='logged-delete' ? {...command,id:'crash-revocation',kind:'delete',text:undefined,
            authorId:undefined,outgoing:false} : {...command,id:'crash-revocation',ref:{...command.ref,messageId:'crash-cancel'},text:'/бро cancel'};
          const eventKey=JSON.stringify([pending.id,pending.kind,pending.version??pending.text??'']);
          agent.store.put('observations',eventKey,{key:eventKey,observation:pending,receivedAt:stamp});
          process.exit(81);
        }
        return insert(collection,key,value);
      };
    }
    const result=await agent.ingest(command);
    if(boundary==='correction') await agent.correct(result.taskId,'corrected crash objective');
    process.exit(82);`;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    source, f.databasePath, f.encryptionKey.toString('hex'), boundary], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 81, child.stderr);
}

test('actual process exit after observation log but before source transaction replays one task', async t => {
  const f = fixture(t);
  crashChild(f, 'logged');
  const reopened = f.open();
  await reopened.start();
  assert.equal(reopened.status().length, 1);
  assert.equal(f.engine.submissions.length, 1);
  const repeated = await reopened.ingest(observation('crash-source', '/бро original crash objective', { id: 'crash-source-event' }));
  assert.equal(repeated.disposition, 'duplicate');
  assert.equal(f.engine.submissions.length, 1);
});

test('actual process exit inside engine submit leaves reservation UNKNOWN with zero replacement submits', async t => {
  const f = fixture(t);
  crashChild(f, 'reserved');
  const reopened = f.open();
  await reopened.start(); await reopened.poll();
  assert.equal(reopened.status().length, 1);
  assert.equal(reopened.status()[0]?.state, 'unknown');
  assert.equal(reopened.status()[0]?.admission?.state, 'unknown');
  assert.equal(f.engine.submissions.length, 0);
  assert.equal(f.executor.dispatches.length, 0);
});

test('actual process exit after correction commit cannot admit successor beside unresolved original run', async t => {
  const f = fixture(t);
  crashChild(f, 'correction');
  f.engine.inspectResult = async () => { throw new Error('original execution still unreachable'); };
  const reopened = f.open();
  await reopened.start(); await reopened.poll();
  const status = reopened.status()[0]!;
  assert.equal(status.intent.revision, 2);
  assert.match(status.intent.instruction, /corrected crash objective/);
  assert.ok(status.heldAt, 'unresolved prior run must hold the saved correction');
  assert.equal(f.engine.submissions.length, 0, 'replacement submit would overlap the unknown original');
  assert.equal(f.executor.dispatches.length, 0);
});

test('misbound cancellation cannot release old execution and admit a corrected successor', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'misbound-cancellation');
  const original = binding(f.agent, taskId);
  f.engine.cancelResult = async bound => ({ binding: { ...bound, runId: 'cancelled-different-run', sessionId: 'different-session' },
    state: 'cancelled', observedAt: f.clock.now().toISOString() });
  const result = await f.agent.correct(taskId, 'revised objective');
  assert.equal(result?.state, 'paused');
  assert.equal(f.engine.submissions.length, 1, 'other run cancellation does not settle the original');
  assert.deepEqual(f.agent.store.get<RunSnapshot>('runs', taskId + ':1')?.binding, original);
  assert.equal(f.executor.dispatches.length, 0);
});

test('correction while original submit is pending waits for exact original settlement before successor admission', async t => {
  const f = fixture(t);
  const entered = deferred<EngineInput>();
  const response = deferred<RunSnapshot>();
  f.engine.submitResult = async input => { entered.resolve(input); return response.promise; };
  const accepting = f.agent.ingest(observation('pending-admission'));
  const input = await entered.promise;
  const taskId = input.taskId;
  const correction = await f.agent.correct(taskId, 'use the corrected objective');
  assert.equal(correction?.state, 'paused');
  assert.equal(f.engine.submissions.length, 1);
  await f.agent.poll();
  assert.equal(f.engine.submissions.length, 1, 'reserved admission cannot be recreated by poll');
  const snapshot: RunSnapshot = { binding: { runId: 'pending-original', sessionId: 'original-session', taskId,
    intentRevision: 1, idempotencyKey: input.idempotencyKey }, state: 'running', observedAt: f.clock.now().toISOString() };
  f.engine.runs.set(snapshot.binding.runId, snapshot);
  response.resolve(snapshot);
  await accepting;
  assert.deepEqual(f.engine.cancellations.map(run => run.runId), ['pending-original']);
  assert.equal(f.engine.submissions.length, 1);
  f.engine.submitResult = undefined;
  await f.agent.poll();
  assert.equal(f.engine.submissions.length, 2);
  assert.equal(f.engine.submissions[1]?.intentRevision, 2);
  assert.equal(f.engine.submissions[1]?.sessionId, 'original-session');
  assert.match(f.engine.submissions[1]!.instruction, /corrected objective/);
  assert.equal(f.agent.status(taskId)?.state, 'working');
});

test('poll reconciles later-proven UNKNOWN send without restart or redispatch', async t => {
  const f = fixture(t);
  f.executor.dispatchResult = async () => ({ state: 'unknown', reason: 'receipt delayed' });
  const taskId = await accept(f.agent, 'poll-reconcile');
  const token = f.agent.issueToolContext(binding(f.agent, taskId));
  const request = { id: 'one-operation', capability: 'telegram.send', resource: privateRoute.peerId, payload: { text: 'delayed output' } };
  const first = await f.agent.executeEffect(token, request);
  await f.agent.poll();
  assert.equal(f.agent.status(taskId)?.state, 'unknown');
  f.executor.reconcileResult = async effect => ({ state: 'verified', receipt: { peerId: effect.resource, messageId: 'later-proven' } });
  await f.agent.poll();
  assert.equal(f.agent.status(taskId)?.effects[0]?.state, 'verified');
  assert.equal((await f.agent.executeEffect(token, request)).id, first.id);
  assert.equal(f.executor.dispatches.length, 1);
  assert.deepEqual(f.executor.reconciliations.map(effect => effect.id), [first.id, first.id]);
  assert.equal((await f.agent.ingest(observation('later-proven', '/бро generated loop', {
    ref: ref('later-proven', privateRoute.peerId),
  }))).disposition, 'ignored');
});

test('formatting upgrade preserves previously prepared delivery payload and never sends it twice', async t => {
  const f=fixture(t),taskId=await accept(f.agent,'legacy-layout');
  const run=binding(f.agent,taskId),token=f.agent.issueToolContext(run);
  const oldText='[Нейробро #'+taskId+']\nCompleted private result';
  await f.agent.executeEffect(token,{id:'delivery:'+run.runId+':part:0',capability:'telegram.send',resource:privateRoute.peerId,payload:{peerId:privateRoute.peerId,text:oldText}});
  f.engine.complete(taskId);await f.agent.poll();
  assert.equal(f.executor.dispatches.length,1);
  assert.equal((f.executor.dispatches[0]!.payload as {text:string}).text,oldText);
  const reopened=f.open();await reopened.poll();assert.equal(f.executor.dispatches.length,1);
});

test('stale reply-here is held before engine admission while equally old private work remains eligible', async t => {
  const f = fixture(t);
  const oldTimestamp = new Date(f.clock.time - 16 * 60 * 1000).toISOString();
  const originId = await accept(f.agent, 'stale-public', '/бро reply here: prepare answer', { sentAt: oldTimestamp });
  assert.equal(f.agent.status(originId)?.state, 'paused');
  assert.match(f.agent.status(originId)!.reason!, /expired/);
  assert.equal(f.engine.submissions.length, 0);
  const privateId = await accept(f.agent, 'old-private', '/бро analyze privately', { sentAt: oldTimestamp });
  assert.equal(f.agent.status(privateId)?.state, 'working');
  await f.agent.poll();
  assert.equal(f.engine.submissions.length, 1);
  assert.equal(f.executor.dispatches.length, 0);
});

test('TDLib reply and tombstone without thread still bind the exact topic message', async t => {
  const f = fixture(t);
  const topicId = await accept(f.agent, 'topic-source', '/бро analyze topic', { ref: { ...ref('topic-source'), threadId: 'topic-7' } });
  f.agent.registerOwnOutput({ ...ref('topic-card', privateRoute.peerId), threadId: 'private-topic' }, topicId);
  const corrected = await f.agent.ingest(observation('topic-correction', 'revise it', { replyTo: ref('topic-card', privateRoute.peerId) }));
  assert.equal(corrected.disposition, 'corrected'); assert.equal(corrected.taskId, topicId);
  assert.equal(f.agent.status(topicId)?.intent.revision, 2);
  const held = await f.agent.ingest(observation('topic-source', undefined, { id: 'topic-delete', kind: 'delete',
    outgoing: false, authorId: undefined, ref: ref('topic-source') }));
  assert.equal(held.disposition, 'held'); assert.equal(held.taskId, topicId);
  assert.equal(f.agent.status(topicId)?.state, 'paused');
});

test('durably logged delete or cancel revokes an unadmitted task before crash recovery can submit it', async t => {
  for (const operation of ['logged-delete', 'logged-cancel'] as const) {
    const f = fixture(t);
    crashChild(f, operation);
    const reopened = f.open();
    await reopened.start(); await reopened.poll();
    assert.equal(reopened.status().length, 1);
    assert.equal(reopened.status()[0]?.state, operation === 'logged-delete' ? 'paused' : 'cancelled');
    assert.equal(f.engine.submissions.length, 0, operation);
    assert.equal(f.executor.dispatches.length, 0, operation);
  }
});

test('journaled control reply stays private, dedupes across update IDs/restart, consumes no run and stays out of task status', async t => {
  const f = fixture(t);
  const control = observation('control-query', '/бро status', { ref: { ...ref('control-query'), threadId: 'public-topic' } });
  const first = await f.agent.journalControlReply(control, 'No active tasks');
  assert.equal(first.state, 'verified');
  assert.equal(first.resource, privateRoute.peerId);
  assert.deepEqual(first.payload, { peerId: privateRoute.peerId, text: '🤖 Нейробратик\n\nNo active tasks' });
  const repeated = await f.agent.journalControlReply({ ...control, id: 'different-tdlib-update' }, 'A changed status result');
  assert.equal(repeated.id, first.id);
  assert.equal(f.executor.dispatches.length, 1);
  assert.equal(f.engine.submissions.length, 0);
  assert.deepEqual(f.agent.status(), []);
  assert.equal((await f.agent.ingest(observation('control-echo', '/бро loop', { ref: ref('sent-1', privateRoute.peerId) }))).disposition, 'ignored');
  assert.equal((await f.agent.ingest(observation('control-only-reply', 'revise', { replyTo: ref('sent-1', privateRoute.peerId) }))).disposition, 'ignored');
  await assert.rejects(f.agent.journalControlReply({ ...control, authorId: 'attacker' }, 'injected reply'), AuthorityError);
  f.agent.close();
  const reopened = f.open();
  await reopened.start(); await reopened.poll();
  assert.equal((await reopened.journalControlReply(control, 'post-restart changed status')).id, first.id);
  assert.deepEqual(reopened.status(), []);
  assert.equal(f.engine.submissions.length, 0);
  assert.equal(f.executor.dispatches.length, 1);
});

test('task-targeted private control reply becomes a correction card for that task, even after cancellation', async t => {
  const f = fixture(t);
  const taskId = await accept(f.agent, 'control-target');
  await f.agent.cancel(taskId);
  const effect = await f.agent.journalControlReply(observation('cancel-control', '/бро cancel #' + taskId), 'Task cancelled', taskId);
  assert.equal(effect.state, 'verified');
  assert.equal(f.agent.status().length, 1, 'internal reply ledger cannot create a second visible task');
  const correction = await f.agent.ingest(observation('cancelled-task-correction', 'Reopen with amended objective', {
    replyTo: ref('sent-1', privateRoute.peerId),
  }));
  assert.equal(correction.disposition, 'corrected'); assert.equal(correction.taskId, taskId);
  assert.equal(f.agent.status(taskId)?.intent.revision, 2);
  assert.equal(f.engine.submissions.length, 2);
  assert.equal(f.agent.status().length, 1);
});
