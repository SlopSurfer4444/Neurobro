import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPersonalAgent, type PersonalAgent } from '../../src/core/controller.ts';
import { AuthorityError, canonicalJson } from '../../src/core/broker.ts';
import { OwnerControlService } from '../../src/owner-controls/service.ts';
import { ownerControlTools } from '../../src/owner-controls/tools.ts';
import { validate } from '../../src/capabilities/schema.ts';
import type { OwnerScopeProposal, ResolvedOwnerPeer } from '../../src/owner-controls/types.ts';
import type { Effect, EngineInput, EnginePort, Json, MessageRef, Observation, RunSnapshot, ToolContext } from '../../src/contracts.ts';

const keyOf = (ref: MessageRef) => JSON.stringify([ref.accountId, ref.peerId, ref.messageId]);
const payloadHash = (payload: Json) => createHash('sha256').update(canonicalJson(payload)).digest('hex');
const peer = (id: string): ResolvedOwnerPeer => ({ accountId: 'account', peerId: id, label: 'Fixture ' + id, kind: 'channel' });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'neurobro-owner-controls-'));
  const databasePath = join(directory, 'state.sqlite'); const encryptionKey = randomBytes(32);
  let instant = Date.parse('2026-10-04T12:00:00Z'); let sequence = 0; let sourceReads = 0;
  const messages = new Map<string, Observation>(); const inputs: EngineInput[] = []; const effects: Effect[] = [];
  const runs = new Map<string, RunSnapshot>(); const selectors = new Map([['@alpha', peer('source-a')], ['@bravo', peer('source-b')]]);
  let forwardedPeer: ResolvedOwnerPeer | undefined; let agent: PersonalAgent; let controls: OwnerControlService;
  let verifyHook: (() => Promise<void> | void) | undefined;
  let readHook: ((ref: MessageRef) => Promise<void> | void) | undefined;
  const clock = { now: () => new Date(instant) };
  const engine: EnginePort = {
    async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
    async submit(input) {
      inputs.push(input);
      const snapshot: RunSnapshot = { binding: { taskId: input.taskId, intentRevision: input.intentRevision,
        idempotencyKey: input.idempotencyKey, runId: 'run-' + inputs.length }, state: 'waiting', observedAt: clock.now().toISOString() };
      runs.set(snapshot.binding.runId, snapshot); return snapshot;
    },
    async inspect(binding) { return runs.get(binding.runId)!; },
    async cancel(binding) { const snapshot = { ...runs.get(binding.runId)!, state: 'cancelled' as const }; runs.set(binding.runId, snapshot); return snapshot; },
  };
  const baseCapabilities = () => [{ capability: 'telegram.history', resources: ['private'] }, { capability: 'telegram.send', resources: ['private'] }];
  function open() {
    agent = createPersonalAgent({ databasePath, encryptionKey, accountId: 'account', ownerId: 'owner', privateRoute: { peerId: 'private' },
      naturalControlPeerId: 'private', clock, engine, capabilityPolicy: baseCapabilities,
      prepareAuthority: intent => controls.prepareAuthority(intent),
      validateToolResource: (context, capability, resource) => controls.validateResource(context, capability, resource),
      validateEffect: (context, request) => controls.validateEffect(context, request),
      executor: { async dispatch(effect) { effects.push(effect); return { state: 'unknown' }; }, async reconcile() { return { state: 'unknown' }; } },
    });
    controls = new OwnerControlService({ store: agent.store, accountId: 'account', ownerId: 'owner', controlPeerId: 'private', now: clock.now,
      baseCapabilities, taskIntent: taskId => agent.status(taskId)?.intent,
      taskActive: taskId => !!agent.status(taskId) && !['paused', 'cancelled', 'failed'].includes(agent.status(taskId)!.state),
      validateAuthority: context => { agent.validateAuthority(context); },
      telegram: {
        async getMessage(ref) { await readHook?.(ref); return messages.get(keyOf(ref)); },
        async resolveSource(selector) { const value = selectors.get(selector); if (!value) throw new Error('Unknown fixture selector'); return value; },
        async resolveForwardSource() { return forwardedPeer; },
        async verifyPeer(candidate) { await verifyHook?.(); const value = [...selectors.values()].find(item => item.peerId === candidate.peerId && item.accountId === candidate.accountId); if (!value) throw new AuthorityError('Unknown proposed peer'); return value; },
      },
    });
  }
  open();
  function observation(text: string, patch: Partial<Observation> = {}): Observation {
    const id = String(++sequence);
    const value: Observation = { id: 'event-' + id, kind: 'message', ref: { accountId: 'account', peerId: 'private', messageId: id },
      authorId: 'owner', outgoing: true, text, sentAt: clock.now().toISOString(), observedAt: clock.now().toISOString(), ...patch };
    messages.set(keyOf(value.ref), value); return value;
  }
  async function admit(text: string, patch: Partial<Observation> = {}) {
    const source = observation(text, patch); const ownerEvent = await controls.prepareOwnerEvent(source); const result = await agent.ingest(source);
    assert.equal(result.disposition, 'accepted'); assert.ok(result.taskId);
    const input = inputs.at(-1)!; const token = input.toolContext!; const context = agent.resolveToolContext(token);
    return { taskId: result.taskId, source, ownerEvent, token, context };
  }
  function card(proposal: OwnerScopeProposal) {
    const output = observation('Concrete fixture proposal: ' + proposal.title, { authorId: 'agent' });
    agent.registerOwnOutput(output.ref, proposal.context.taskId); controls.registerCard(proposal.id, output.ref); return output;
  }
  async function refresh(taskId: string) {
    const context = await agent.refreshAuthority(taskId); const token = agent.issueExecutionContext(context); return { token, context };
  }
  return { get agent() { return agent; }, get controls() { return controls; }, messages, inputs, effects, databasePath,
    observation, admit, card, refresh, clock,
    async resolveSource(selector: string) { const value = selectors.get(selector); if (!value) throw new AuthorityError('Exact fixture selector is unavailable'); return value; },
    setForward(peerValue: ResolvedOwnerPeer | undefined) { forwardedPeer = peerValue; },
    advance(ms: number) { instant += ms; },
    readSource(token: string, sourceId: string) { agent.authorizeTool(token, 'telegram.history', sourceId); sourceReads++; return sourceReads; },
    sourceReads: () => sourceReads,
    setVerifyHook(hook?: () => Promise<void> | void) { verifyHook = hook; },
    setReadHook(hook?: (ref: MessageRef) => Promise<void> | void) { readHook = hook; },
    async restart() { agent.close(); open(); await agent.start(); },
    close() { agent.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('cancelled monitor scope disappears even when retained UNKNOWN effects mask the task state', async () => {
  const f = fixture();
  try {
    const task = await f.admit('наблюдай @alpha');
    assert.equal(f.controls.getMonitorPolicies(task.taskId).length, 1);
    await f.agent.executeEffect(task.token, { capability: 'telegram.send', resource: 'private', payload: { text: 'private pending alert' } });
    await f.agent.cancel(task.taskId);
    assert.equal(f.agent.status(task.taskId)!.state, 'unknown');
    assert.ok(f.agent.status(task.taskId)!.cancelledAt);
    assert.deepEqual(f.controls.getReadPeers(task.taskId), []);
    assert.deepEqual(f.controls.getMonitorPolicies(task.taskId), []);
    await f.restart(); assert.deepEqual(f.controls.getMonitorPolicies(task.taskId), []);
  } finally { f.close(); }
});

test('direct owner command only gains exact read scope at task authority preparation; monitor scope persists encrypted', async () => {
  const f = fixture();
  try {
    const source = f.observation('наблюдай @alpha @bravo');
    assert.equal((await f.controls.prepareOwnerEvent(source)).disposition, 'source-plan');
    assert.equal(f.controls.getMonitorPolicies().length, 0);
    const result = await f.agent.ingest(source); const taskId = result.taskId!; const token = f.inputs.at(-1)!.toolContext!;
    assert.deepEqual(f.controls.getReadPeers(taskId).sort(), ['source-a', 'source-b']);
    assert.deepEqual(f.controls.contextReadScopes(taskId).sort(), ['chat:source-a', 'chat:source-b']);
    assert.equal(f.controls.getMonitorPolicies(taskId).length, 2);
    assert.equal(f.readSource(token, 'source-a'), 1);
    assert.throws(() => f.agent.authorizeTool(token, 'telegram.history', 'other-source'), AuthorityError);
    await assert.rejects(f.agent.executeEffect(token, { capability: 'telegram.send', resource: 'source-a', payload: { text: 'unauthorized write' } }), AuthorityError);
    const inputCount = f.inputs.length; await f.restart();
    assert.equal(f.inputs.length, inputCount); assert.equal(f.controls.getMonitorPolicies(taskId).length, 2);
    assert.equal(f.readSource(token, 'source-b'), 2);
    assert.ok(!readFileSync(f.databasePath).includes(Buffer.from('source-a')));
    const readOnly = await f.admit('читай @alpha');
    assert.deepEqual(f.controls.getReadPeers(readOnly.taskId), ['source-a']); assert.equal(f.controls.getMonitorPolicies(readOnly.taskId).length, 0);
    f.advance(8 * 24 * 60 * 60 * 1000); assert.deepEqual(f.controls.getReadPeers(readOnly.taskId), []);
  } finally { f.close(); }
});

test('model source proposal grants nothing before current owner reply to a registered concrete card', async () => {
  const f = fixture();
  try {
    const task = await f.admit('find useful fixture sources');
    await assert.rejects(f.controls.proposeSources({ context: task.context, sources: [peer('unverified-model-peer')], monitor: true }), AuthorityError);
    const proposal = await f.controls.proposeSources({ context: task.context, sources: [peer('source-a')], monitor: true });
    assert.deepEqual(f.controls.getReadPeers(task.taskId), []);
    assert.throws(() => f.readSource(task.token, 'source-a'), AuthorityError); assert.equal(f.sourceReads(), 0);
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('yes'))).disposition, 'ambiguous');
    assert.equal(f.controls.proposal(proposal.id).state, 'pending');
    assert.throws(() => f.controls.registerCard(proposal.id, f.observation('fake card').ref), AuthorityError);
    const card = f.card(proposal);
    const wrongReply = f.observation('yes', { replyTo: { ...card.ref, messageId: 'unrelated' } });
    assert.equal((await f.controls.prepareOwnerEvent(wrongReply)).disposition, 'ambiguous');
    const accepted = await f.controls.prepareOwnerEvent(f.observation('yes', { replyTo: card.ref }));
    assert.equal(accepted.disposition, 'accepted');
    assert.deepEqual(f.controls.getReadPeers(task.taskId), ['source-a']);
    assert.throws(() => f.readSource(task.token, 'source-a'), AuthorityError);
    const fresh = await f.refresh(task.taskId); assert.equal(f.readSource(fresh.token, 'source-a'), 1);
  } finally { f.close(); }
});

test('only direct current account owner speech admits scope; hidden forward provenance remains ambiguous', async () => {
  const f = fixture();
  try {
    for (const patch of [{ authorId: 'stranger' }, { outgoing: false }, { viaBot: true }, { forwarded: true }, { agentEffectId: 'agent-effect' },
      { ref: { accountId: 'different-account', peerId: 'private', messageId: 'wrong-account' } },
    ]) assert.equal((await f.controls.prepareOwnerEvent(f.observation('наблюдай @alpha', patch))).disposition, 'none');
    const baseline = await f.admit('fixture baseline task');
    const ownOutput = f.observation('наблюдай @alpha'); f.agent.registerOwnOutput(ownOutput.ref, baseline.taskId);
    assert.equal((await f.controls.prepareOwnerEvent(ownOutput)).disposition, 'none');
    const material = f.observation('Quoted channel material', { authorId: 'stranger', outgoing: false, forwarded: true });
    const hidden = f.observation('наблюдай этот источник', { replyTo: material.ref });
    assert.equal((await f.controls.prepareOwnerEvent(hidden)).disposition, 'ambiguous');
    assert.equal(f.agent.store.list('ownerSourcePlans').length, 0); assert.equal(f.effects.length, 0);
    f.setForward(peer('source-a'));
    const actual = await f.admit('наблюдай этот источник', { replyTo: material.ref });
    assert.deepEqual(f.controls.getReadPeers(actual.taskId), ['source-a']);
  } finally { f.close(); }
});

test('owner evidence ignores transport projection changes but actual edit/delete revokes old-token reads', async () => {
  const f = fixture();
  try {
    const task = await f.admit('наблюдай @alpha');
    f.messages.set(keyOf(task.source.ref), { ...task.source, observedAt: '2026-10-04T12:00:05Z', version: 'projection-v2', contextRefs: ['trusted-projection'] });
    assert.equal((await f.controls.prepareOwnerEvent(task.source)).disposition, 'source-plan');
    assert.equal(f.readSource(task.token, 'source-a'), 1);
    const edit = { ...task.source, id: 'edit-event', kind: 'edit' as const, text: 'обычная исправленная фраза', editedAt: '2026-10-04T12:00:06Z' };
    f.messages.set(keyOf(edit.ref), edit); assert.equal((await f.controls.prepareOwnerEvent(edit)).disposition, 'none');
    assert.deepEqual(f.controls.getReadPeers(task.taskId), []);
    assert.throws(() => f.readSource(task.token, 'source-a'), AuthorityError);
    const second = await f.admit('наблюдай @bravo');
    const deletion = { ...second.source, id: 'delete-event', kind: 'delete' as const };
    assert.equal((await f.controls.prepareOwnerEvent({ ...deletion, authorId: 'stranger' })).disposition, 'none');
    assert.equal(f.readSource(second.token, 'source-b'), 2);
    f.messages.delete(keyOf(second.source.ref)); assert.equal((await f.controls.prepareOwnerEvent(deletion)).disposition, 'revoked');
    assert.throws(() => f.readSource(second.token, 'source-b'), AuthorityError);
    assert.equal(f.controls.getMonitorPolicies().length, 0);
  } finally { f.close(); }
});

test('per-source unsubscribe survives cold reopen without old plan rebinding in a new task', async () => {
  const f = fixture();
  try {
    const contextRef = 'source-command-fixture'; const task = await f.admit('наблюдай @alpha @bravo', { contextRefs: [contextRef] });
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('перестань наблюдать @alpha'))).disposition, 'revoked');
    assert.deepEqual(f.controls.getReadPeers(task.taskId), ['source-b']);
    assert.throws(() => f.readSource(task.token, 'source-a'), AuthorityError); assert.equal(f.readSource(task.token, 'source-b'), 1);
    await f.restart();
    await f.controls.prepareOwnerEvent(task.source);
    const oldIntent = f.agent.status(task.taskId)!.intent; f.controls.prepareAuthority(oldIntent);
    assert.deepEqual(f.controls.getReadPeers(task.taskId), ['source-b']);
    const continuation = await f.admit('continue fixture research', { contextRefs: [contextRef] });
    assert.deepEqual(f.controls.getReadPeers(continuation.taskId), []);
    assert.throws(() => f.readSource(continuation.token, 'source-a'), AuthorityError);
    assert.throws(() => f.readSource(continuation.token, 'source-b'), AuthorityError);
  } finally { f.close(); }
});

test('cancelled source task loses old-token scope while a separate new task requires its own owner plan', async () => {
  const f = fixture();
  try {
    const original = await f.admit('наблюдай @alpha');
    assert.equal(f.readSource(original.token, 'source-a'), 1);
    await f.agent.cancel(original.taskId);
    assert.deepEqual(f.controls.getReadPeers(original.taskId), []);
    assert.equal(f.controls.getMonitorPolicies(original.taskId).length, 0);
    assert.throws(() => f.readSource(original.token, 'source-a'), AuthorityError);
    await assert.rejects(f.agent.refreshAuthority(original.taskId), AuthorityError);
    const unrelated = await f.admit('new separate task');
    assert.deepEqual(f.controls.getReadPeers(unrelated.taskId), []);
    assert.throws(() => f.readSource(unrelated.token, 'source-a'), AuthorityError);
    const newPlan = await f.admit('наблюдай @bravo');
    assert.deepEqual(f.controls.getReadPeers(newPlan.taskId), ['source-b']);
    assert.throws(() => f.readSource(newPlan.token, 'source-a'), AuthorityError);
    assert.equal(f.readSource(newPlan.token, 'source-b'), 2);
  } finally { f.close(); }
});

test('stale direct owner utterance and expired proposal cannot expand source scope', async () => {
  const f = fixture();
  try {
    const stale = f.observation('наблюдай @alpha', { sentAt: '2026-10-04T11:29:00Z' });
    assert.equal((await f.controls.prepareOwnerEvent(stale)).disposition, 'ambiguous');
    assert.equal(f.agent.store.list('ownerSourcePlans').length, 0);
    const task = await f.admit('current fixture task');
    const proposal = await f.controls.proposeSources({ context: task.context, sources: [peer('source-a')], monitor: true });
    const card = f.card(proposal); f.advance(31 * 60 * 1000);
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('yes', { replyTo: card.ref }))).disposition, 'ambiguous');
    assert.deepEqual(f.controls.getReadPeers(task.taskId), []);
    assert.throws(() => f.readSource(task.token, 'source-a'), AuthorityError);
    assert.equal(f.sourceReads(), 0);
  } finally { f.close(); }
});

test('source verification cannot outlive proposal expiry or overwrite a concurrent rejection', async () => {
  for (const race of ['expiry', 'rejection', 'revocation'] as const) {
    const f = fixture();
    try {
      const task = await f.admit('Наблюдай выбранный канал');
      const proposal = await f.controls.proposeSources({ context: task.context, sources: [peer('source-a')], monitor: true });
      const card = f.card(proposal), confirmation = f.observation('да, делай', { replyTo: card.ref });
      f.setVerifyHook(async () => {
        f.setVerifyHook();
        if (race === 'expiry') f.advance(31 * 60 * 1000);
        else if (race === 'revocation') f.controls.revokeOwnerSource(confirmation.ref, 'owner withdrew approval');
        else assert.equal((await f.controls.prepareOwnerEvent(f.observation('нет', { replyTo: card.ref }))).disposition, 'rejected');
      });
      assert.equal((await f.controls.prepareOwnerEvent(confirmation)).disposition, 'ambiguous');
      assert.deepEqual(f.controls.getReadPeers(task.taskId), []);
      assert.equal(f.controls.proposal(proposal.id).state, race === 'rejection' ? 'rejected' : 'pending');
      assert.equal(f.effects.length, 0);
    } finally { f.close(); }
  }
});

test('approval requires concrete published card and owner confirmation after its publication', async () => {
  const f = fixture();
  try {
    const task = await f.admit('Наблюдай выбранный канал');
    const proposal = await f.controls.proposeSources({ context: task.context, sources: [peer('source-a')], monitor: true });
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('да #' + proposal.id))).disposition, 'ambiguous');
    f.advance(1000); const card = f.card(proposal);
    const earlier = f.observation('подтверждаю.', { replyTo: card.ref, sentAt: '2026-10-04T12:00:00Z' });
    assert.equal((await f.controls.prepareOwnerEvent(earlier)).disposition, 'ambiguous');
    assert.deepEqual(f.controls.getReadPeers(task.taskId), []);
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('ага', { replyTo: card.ref }))).disposition, 'accepted');
  } finally { f.close(); }
});

test('native second-resolution confirmation admits after card even when proposal was created later in that second', async () => {
  const f = fixture();
  try {
    const task = await f.admit('Наблюдай выбранный канал'); f.advance(500);
    const proposal = await f.controls.proposeSources({ context: task.context, sources: [peer('source-a')], monitor: true });
    const card = f.card(proposal); f.messages.set(keyOf(card.ref), { ...card, sentAt: '2026-10-04T12:00:00Z' });
    const confirmation = f.observation('да', { replyTo: card.ref, sentAt: '2026-10-04T12:00:00Z' });
    assert.equal((await f.controls.prepareOwnerEvent(confirmation)).disposition, 'accepted');
  } finally { f.close(); }
});

test('natural positive replies do not authorize quoted, qualified or unbound external sending', async () => {
  const f = fixture();
  try {
    const task = await f.admit('Подготовь отклик');
    const proposal = f.controls.proposeApproval({ context: task.context, objectId: 'batch', batchRevision: 1, manifestHash: 'f'.repeat(64),
      recipients: [{ id: 'one', peerId: 'recipient', payloadHash: 'e'.repeat(64) }] });
    const card = f.card(proposal);
    for (const text of ['да, но пока не отправляй', 'да, если получится', 'не подтверждаю', '«давай»']) {
      assert.equal((await f.controls.prepareOwnerEvent(f.observation(text, { replyTo: card.ref }))).disposition, 'none');
    }
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('ок'))).disposition, 'ambiguous');
    for (const kind of ['quote', 'code'] as const) {
      assert.equal((await f.controls.prepareOwnerEvent(f.observation('да', { replyTo: card.ref, authorityTextRanges: [{ offset: 0, length: 2, kind }] }))).disposition, 'none');
    }
    assert.deepEqual(f.agent.store.list('ownerApprovalReceipts'), []); assert.equal(f.effects.length, 0);
  } finally { f.close(); }
});

test('two pending source cards for one intention remain independently confirmable across grant refresh', async () => {
  const f = fixture();
  try {
    const task = await f.admit('research two sources');
    const first = await f.controls.proposeSources({ context: task.context, sources: [peer('source-a')], monitor: true });
    const second = await f.controls.proposeSources({ context: task.context, sources: [peer('source-b')], monitor: true });
    const firstCard = f.card(first); const secondCard = f.card(second);
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('yes', { replyTo: firstCard.ref }))).disposition, 'accepted');
    const intermediate = await f.refresh(task.taskId);
    assert.ok(intermediate.context.grantRevision > task.context.grantRevision);
    assert.throws(() => f.readSource(intermediate.token, 'source-b'), AuthorityError);
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('yes', { replyTo: secondCard.ref }))).disposition, 'accepted');
    const final = await f.refresh(task.taskId);
    assert.deepEqual(f.controls.getReadPeers(task.taskId).sort(), ['source-a', 'source-b']);
    assert.equal(f.readSource(final.token, 'source-a'), 1); assert.equal(f.readSource(final.token, 'source-b'), 2);
  } finally { f.close(); }
});

test('source tool factory uses schema, trusted token and exact resolver, and creates only a pending private card', async () => {
  const f = fixture();
  try {
    const task = await f.admit('select useful sources naturally'); const resolved: string[] = []; const cards: MessageRef[] = [];
    const tools = ownerControlTools({ service: f.controls,
      async resolveSource(selector) { resolved.push(selector); return f.resolveSource(selector); },
      async onProposal(proposal) { cards.push(f.card(proposal).ref); },
    });
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['owner.sources.inspect', 'owner.sources.propose']);
    async function execute(name: string, args: Record<string, Json>, token = task.token) {
      const tool = tools.find(item => item.name === name)!; validate(tool.inputSchema, args);
      const context = f.agent.resolveToolContext(token);
      for (const resource of tool.resources(args, context)) await f.agent.authorizeTool(token, tool.capability, resource);
      return tool.execute({ token, context, args });
    }
    await assert.rejects(execute('owner.sources.propose', { selectors: ['@alpha'], monitor: true, taskId: 'spoofed-task' }));
    await assert.rejects(execute('owner.sources.propose', { selectors: ['@alpha'], monitor: true }, 'forged-token'), AuthorityError);
    assert.deepEqual(resolved, []);
    await assert.rejects(execute('owner.sources.propose', { selectors: ['a vague source'], monitor: true }), AuthorityError);
    assert.equal(cards.length, 0);
    const pending = await execute('owner.sources.propose', { selectors: ['@alpha'], monitor: true, title: 'Exact fixture source' }) as { proposalId: string; state: string };
    assert.equal(pending.state, 'pending'); assert.equal(cards.length, 1);
    assert.deepEqual(f.controls.proposal(pending.proposalId).cardRef, cards[0]);
    assert.deepEqual(f.controls.getReadPeers(task.taskId), []); assert.throws(() => f.readSource(task.token, 'source-a'), AuthorityError);
    const inspected = await execute('owner.sources.inspect', {}) as { readPeers: string[]; proposals: { id: string; state: string }[] };
    assert.deepEqual(inspected.readPeers, []); assert.equal(inspected.proposals[0]!.id, pending.proposalId);
    assert.equal((await f.controls.prepareOwnerEvent(f.observation('yes', { replyTo: cards[0] }))).disposition, 'accepted');
    const fresh = await f.refresh(task.taskId); assert.equal(f.readSource(fresh.token, 'source-a'), 1);
  } finally { f.close(); }
});

async function outreach(f: ReturnType<typeof fixture>) {
  const task = await f.admit('prepare outreach draft'); const payloadA = { text: 'Exact approved A', batchId: 'batch-1' }; const payloadB = { text: 'Exact approved B', batchId: 'batch-1' };
  const manifestHash = payloadHash({ batch: 'fixture batch', revision: 1 });
  const proposal = f.controls.proposeApproval({ context: task.context, objectId: 'batch-1', batchRevision: 1, manifestHash,
    recipients: [{ id: 'a', peerId: 'recipient-a', payloadHash: payloadHash(payloadA) }, { id: 'b', peerId: 'recipient-b', payloadHash: payloadHash(payloadB) }] });
  assert.throws(() => f.agent.authorizeTool(task.token, 'telegram.send', 'recipient-a'), AuthorityError);
  assert.equal(f.agent.store.list('ownerApprovalReceipts').length, 0);
  const card = f.card(proposal); const confirmation = f.observation('да только a', { replyTo: card.ref });
  const accepted = await f.controls.prepareOwnerEvent(confirmation); assert.equal(accepted.disposition, 'accepted'); assert.ok(accepted.receipt);
  const fresh = await f.refresh(task.taskId);
  return { ...task, ...fresh, payloadA, payloadB, manifestHash, proposal, confirmation, receipt: accepted.receipt };
}

test('outreach readback rechecks durable receipt withdrawal and expiry after awaiting Telegram', async () => {
  for (const race of ['revocation', 'expiry'] as const) {
    const f = fixture();
    try {
      const value = await outreach(f);
      f.setReadHook(() => {
        f.setReadHook();
        if (race === 'revocation') f.controls.revokeOwnerSource(value.confirmation.ref, 'owner withdrew approval');
        else f.advance(31 * 60 * 1000);
      });
      await assert.rejects(f.controls.getOutreachApproval(value.context, value.receipt.id, 'batch-1', 1, value.manifestHash, ['a']), AuthorityError);
      assert.equal(f.effects.length, 0);
    } finally { f.close(); }
  }
});

test('outreach approval binds exact batch revision, manifest, selected set and payload; UNKNOWN never replays', async () => {
  const f = fixture();
  try {
    const value = await outreach(f);
    const approval = await f.controls.getOutreachApproval(value.context, value.receipt.id, 'batch-1', 1, value.manifestHash, ['a']);
    assert.deepEqual(approval.selectedRecipientIds, ['a']);
    for (const [objectId, revision, hash, selection] of [
      ['different-batch', 1, value.manifestHash, ['a']], ['batch-1', 2, value.manifestHash, ['a']],
      ['batch-1', 1, 'f'.repeat(64), ['a']], ['batch-1', 1, value.manifestHash, ['b']], ['batch-1', 1, value.manifestHash, ['a', 'b']],
    ] as const) await assert.rejects(f.controls.getOutreachApproval(value.context, value.receipt.id, objectId, revision, hash, selection), AuthorityError);
    const exactId = 'outreach:batch-1:revision:1:recipient:a';
    await assert.rejects(f.agent.executeEffect(value.token, { id: 'outreach:batch-1:revision:1:recipient:b', capability: 'telegram.send', resource: 'recipient-b', payload: value.payloadB }), AuthorityError);
    await assert.rejects(f.agent.executeEffect(value.token, { id: exactId, capability: 'telegram.send', resource: 'recipient-a', payload: { ...value.payloadA, text: 'mutated' } }), AuthorityError);
    await assert.rejects(f.agent.executeEffect(value.token, { id: 'outreach:batch-1:revision:2:recipient:a', capability: 'telegram.send', resource: 'recipient-a', payload: value.payloadA }), AuthorityError);
    await assert.rejects(f.agent.executeEffect(value.token, { capability: 'telegram.media.send', resource: 'recipient-a', payload: value.payloadA }), AuthorityError);
    assert.equal(f.effects.length, 0);
    const request = { id: exactId, capability: 'telegram.send', resource: 'recipient-a', payload: value.payloadA };
    const first = await f.agent.executeEffect(value.token, request); assert.equal(first.state, 'unknown');
    await f.restart(); const repeated = await f.agent.executeEffect(value.token, request);
    assert.equal(repeated.id, first.id); assert.equal(repeated.state, 'unknown'); assert.equal(f.effects.length, 1);
    f.advance(31 * 60 * 1000);
    await assert.rejects(f.controls.getOutreachApproval(value.context, value.receipt.id, 'batch-1', 1, value.manifestHash, ['a']), AuthorityError);
    await assert.rejects(f.agent.executeEffect(value.token, request), AuthorityError);
    assert.equal(f.effects.length, 1); assert.equal(f.agent.status(value.taskId)!.effects[0]!.state, 'unknown');
  } finally { f.close(); }
});

test('edited or deleted confirmation invalidates receipts and current effect hooks; fresh readback catches unobserved edits', async () => {
  for (const kind of ['edit', 'delete', 'readback'] as const) {
    const f = fixture();
    try {
      const value = await outreach(f);
      const changed = { ...value.confirmation, id: 'changed-' + kind, kind: 'edit' as const, text: 'нет', editedAt: '2026-10-04T12:00:05Z' };
      if (kind === 'delete') { f.messages.delete(keyOf(changed.ref)); await f.controls.prepareOwnerEvent({ ...changed, kind: 'delete' }); }
      else { f.messages.set(keyOf(changed.ref), changed); if (kind === 'edit') await f.controls.prepareOwnerEvent(changed); }
      await assert.rejects(f.controls.getOutreachApproval(value.context, value.receipt.id, 'batch-1', 1, value.manifestHash, ['a']), AuthorityError);
      await assert.rejects(f.agent.executeEffect(value.token, { id: 'outreach:batch-1:revision:1:recipient:a', capability: 'telegram.send', resource: 'recipient-a', payload: value.payloadA }), AuthorityError);
      assert.equal(f.effects.length, 0); assert.ok(f.agent.store.get<{ revokedAt?: string }>('ownerApprovalReceipts', value.receipt.id)!.revokedAt);
    } finally { f.close(); }
  }
});
