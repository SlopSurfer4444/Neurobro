import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { createPersonalAgent } from '../../src/core/index.ts';
import type { Effect, EnginePort, RunSnapshot, ToolContext } from '../../src/contracts.ts';
import { createScheduleDelivery, getScheduleDelivery, type ScheduleOutputManifest } from '../../src/schedule-delivery.ts';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext, options: { output?: Uint8Array; inline?: number; max?: number; media?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'neurobro-schedule-'));
  const home = join(root, 'hermes'); const outputRoot = join(home, 'cron', 'output');
  mkdirSync(outputRoot, { recursive: true });
  const path = join(outputRoot, 'native-result.txt');
  const output = options.output ?? Buffer.from('Useful schedule result with full original.'); writeFileSync(path, output);
  const encryptionKey = randomBytes(32); const artifacts = new ArtifactStore({ rootPath: join(root, 'artifacts'), encryptionKey });
  const effects: Effect[] = []; const snapshots = new Map<string, RunSnapshot>();
  let unknownDispatch = false; let proven = false;
  const engine: EnginePort = {
    async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
    async submit(input) { const snapshot: RunSnapshot = { binding: { taskId: input.taskId, intentRevision: input.intentRevision,
      idempotencyKey: input.idempotencyKey, runId: 'foreground', sessionId: 'session' }, state: 'running', observedAt: new Date().toISOString() };
      snapshots.set(snapshot.binding.runId, snapshot); return snapshot; },
    async inspect(binding) { return snapshots.get(binding.runId)!; },
    async cancel(binding) { const result: RunSnapshot = { ...snapshots.get(binding.runId)!, state: 'cancelled' }; snapshots.set(binding.runId, result); return result; },
  };
  const agent = createPersonalAgent({ databasePath: join(root, 'core.sqlite'), encryptionKey, accountId: 'account', ownerId: 'owner',
    privateRoute: { peerId: 'private', threadId: 'private-topic' }, engine,
    capabilityPolicy: () => [{ capability: 'telegram.send', resources: ['private', 'origin'] }, ...(options.media === false ? [] : [{ capability: 'telegram.media.send', resources: ['private'] }])],
    executor: { async dispatch(effect) { effects.push(effect); return unknownDispatch ? { state: 'unknown' } : { state: 'verified', receipt: { peerId: effect.resource, messageId: 'sent-' + effects.length } }; },
      async reconcile() { return proven ? { state: 'verified' } : { state: 'unknown' }; } },
  });
  const now = new Date().toISOString();
  const accepted = await agent.ingest({ id: 'command', kind: 'message', ref: { accountId: 'account', peerId: 'origin', messageId: 'owner-command' },
    authorId: 'owner', outgoing: true, text: '/бро --here run periodic task', sentAt: now, observedAt: now });
  const taskId = accepted.taskId!; const foreground = agent.issueToolContext(agent.status(taskId)!.run!.binding);
  const context: ToolContext = { ...agent.resolveToolContext(foreground), runId: 'cron:job:execution' };
  const token = agent.issueExecutionContext(context);
  const manifest: ScheduleOutputManifest = { job_id: 'job', execution_id: 'execution', task_id: context.runId,
    outcome: 'completed', output_file: path, output_sha256: hash(output) };
  const stages: string[] = [];
  const delivery = createScheduleDelivery({ agent, artifacts, hermesHome: home, privateRoute: { peerId: 'private', threadId: 'private-topic' },
    maxInlineCharacters: options.inline, maxOutputBytes: options.max,
    async artifactSend(ctx, id) {
      assert.equal(ctx.taskId, taskId);
      const stage = artifacts.stageTask({ ownerId: 'owner', taskId }, [id]); stages.push(stage.id);
      const input = stage.inputs[0]!;
      return { path: input.path, mimeType: input.artifact.mimeType, name: input.artifact.name, size: input.artifact.size };
    } });
  t.after(() => { agent.close(); artifacts.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { root, home, outputRoot, path, output, agent, artifacts, context, token, manifest, delivery, taskId, effects, stages,
    unknown() { unknownDispatch = true; }, prove() { proven = true; unknownDispatch = false; } };
}

test('native text is archived exactly and privately delivered with durable execution dedupe', async t => {
  const f = await fixture(t);
  await f.delivery(f.context, f.manifest, f.token);
  const record = getScheduleDelivery(f.agent, 'job', 'execution')!;
  assert.equal(record.state, 'verified'); assert.ok(record.artifactId);
  assert.deepEqual(f.artifacts.read({ ownerId: 'owner', taskId: f.taskId }, record.artifactId!), f.output);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0]?.capability, 'telegram.send'); assert.equal(f.effects[0]?.resource, 'private');
  const payload = f.effects[0]!.payload as { peerId: string; threadId: string; text: string };
  assert.equal(payload.peerId, 'private'); assert.equal(payload.threadId, 'private-topic'); assert.ok(payload.text.includes(f.output.toString()));
  await f.delivery(f.context, f.manifest, f.token); assert.equal(f.effects.length, 1);
  assert.equal(f.artifacts.list({ ownerId: 'owner', taskId: f.taskId }).length, 1);
});

test('long Unicode report uploads original document plus bounded excerpt with no 100-part spam', async t => {
  const f = await fixture(t, { output: Buffer.from('😀完整原文\n'.repeat(6000)), inline: 200 });
  await f.delivery(f.context, f.manifest, f.token);
  assert.equal(f.effects.length, 2); assert.equal(f.effects[0]?.capability, 'telegram.media.send'); assert.equal(f.effects[1]?.capability, 'telegram.send');
  const media = f.effects[0]!.payload as { path: string; mediaType: string; profile: string; artifactId: string };
  assert.equal(media.mediaType, 'document'); assert.equal(media.profile, 'file'); assert.deepEqual(readFileSync(media.path), f.output);
  const notice = (f.effects[1]!.payload as { text: string }).text;
  assert.ok(notice.length < 1600); assert.ok(notice.includes('Полный оригинал')); assert.ok(!/[\uD800-\uDBFF]$/.test(notice));
  await f.delivery(f.context, f.manifest, f.token); assert.equal(f.effects.length, 2); assert.equal(f.stages.length, 1);
});

test('supported binary is archived and uploaded as document through trusted artifact staging', async t => {
  const f = await fixture(t, { output: Buffer.from('%PDF-1.7\nfixture binary document\n') });
  await f.delivery(f.context, f.manifest, f.token);
  assert.equal(f.effects[0]?.capability, 'telegram.media.send');
  assert.ok((f.effects[1]!.payload as { text: string }).text.includes('Оригинал результата'));
  assert.ok(!(f.effects[1]!.payload as { text: string }).text.includes('Диагностика'));
  assert.equal(f.artifacts.get({ ownerId: 'owner', taskId: f.taskId }, getScheduleDelivery(f.agent, 'job', 'execution')!.artifactId!).mimeType, 'application/pdf');
  assert.ok(f.effects.every(effect => effect.resource === 'private'));
});

test('UNKNOWN document stops remaining sends and repeated callback never uploads again', async t => {
  const f = await fixture(t, { output: Buffer.from('long'.repeat(3000)), inline: 100 });
  f.unknown();
  await assert.rejects(f.delivery(f.context, f.manifest, f.token), /settlement is unknown/);
  const record = getScheduleDelivery(f.agent, 'job', 'execution')!; assert.equal(record.state, 'unknown'); assert.ok(record.artifactId);
  await assert.rejects(f.delivery(f.context, f.manifest, f.token), /settlement is unknown/);
  assert.equal(f.effects.length, 1); assert.equal(f.stages.length, 1);
  f.prove(); await f.agent.poll(); // Broker readback verifies original send; no native callback was blindly replayed.
  assert.equal(f.agent.store.get<Effect>('effects', record.effectIds[0]!)?.state, 'verified');
  await f.delivery(f.context, f.manifest, f.token);
  assert.equal(f.effects.length, 2); assert.equal(getScheduleDelivery(f.agent, 'job', 'execution')?.state, 'verified');
});

test('wrong native binding, substituted token, changed immutable manifest and missing/hash-bad files cannot dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.delivery(f.context, { ...f.manifest, task_id: 'cron:other:execution' }, f.token), /trusted execution/);
  const other = f.agent.issueExecutionContext({ ...f.context, runId: 'cron:other:execution' });
  await assert.rejects(f.delivery(f.context, f.manifest, other), /trusted execution/);
  await assert.rejects(f.delivery(f.context, { ...f.manifest, output_sha256: 'f'.repeat(64) }, f.token), /SHA256/);
  assert.equal(f.effects.length, 0);
  await assert.rejects(f.delivery(f.context, f.manifest, f.token), /identity changed/);
  const missing = { ...f.manifest, job_id: 'missing', task_id: 'cron:missing:execution', output_file: join(f.outputRoot, 'absent.txt') };
  const missingContext = { ...f.context, runId: missing.task_id }; const missingToken = f.agent.issueExecutionContext(missingContext);
  await assert.rejects(f.delivery(missingContext, missing, missingToken)); assert.equal(f.effects.length, 0);
});

test('outside-root, linked ancestors, hardlink leaf and oversized file are rejected before archive/effect', async t => {
  const f = await fixture(t, { max: 64 });
  const external = join(f.root, 'outside.txt'); writeFileSync(external, f.output);
  const alias = join(f.outputRoot, 'linked'); symlinkSync(f.root, alias, 'junction');
  const hardlink = join(f.outputRoot, 'hardlink.txt'); linkSync(external, hardlink);
  const huge = join(f.outputRoot, 'huge.txt'); writeFileSync(huge, Buffer.alloc(100, 65));
  for (const [index, path] of [external, join(alias, 'outside.txt'), hardlink, huge].entries()) {
    const context = { ...f.context, runId: `cron:reject-${index}:execution` }; const token = f.agent.issueExecutionContext(context);
    const manifest = { ...f.manifest, job_id: 'reject-' + index, task_id: context.runId, output_file: path,
      output_sha256: hash(readFileSync(path)) };
    await assert.rejects(f.delivery(context, manifest, token));
  }
  assert.equal(f.effects.length, 0); assert.equal(f.artifacts.list({ ownerId: 'owner', taskId: f.taskId }).length, 0);
});

test('failed/cancelled/interrupted outcomes deliver honest private status and never report success', async t => {
  const f = await fixture(t);
  for (const [index, outcome] of ['failed', 'cancelled', 'interrupted'].entries()) {
    const context = { ...f.context, runId: `cron:outcome-${index}:execution` }; const token = f.agent.issueExecutionContext(context);
    const manifest: ScheduleOutputManifest = { ...f.manifest, job_id: 'outcome-' + index, task_id: context.runId,
      outcome: outcome as ScheduleOutputManifest['outcome'] };
    await f.delivery(context, manifest, token);
  }
  assert.equal(f.effects.length, 3);
  assert.ok(f.effects.every(effect => effect.capability === 'telegram.send' && !(effect.payload as { text: string }).text.includes('Результат по расписанию')));
  assert.ok((f.effects[0]!.payload as { text: string }).text.includes('ошибкой'));
  assert.ok((f.effects[1]!.payload as { text: string }).text.includes('отменено'));
  assert.ok((f.effects[2]!.payload as { text: string }).text.includes('прервано'));
});

test('revocation before callback or racing trusted staging prevents any new result send', async t => {
  const f = await fixture(t, { output: Buffer.from('long'.repeat(3000)), inline: 100 });
  const racing = createScheduleDelivery({ agent: f.agent, artifacts: f.artifacts, hermesHome: f.home, privateRoute: { peerId: 'private' }, maxInlineCharacters: 100,
    async artifactSend() { f.agent.revokeToolContext(f.token); return { path: f.path, mimeType: 'text/plain', name: 'native-result.txt', size: f.output.length }; } });
  await assert.rejects(racing(f.context, f.manifest, f.token), /revoked/); assert.equal(f.effects.length, 0);
  assert.ok(getScheduleDelivery(f.agent, 'job', 'execution')?.artifactId);
  await assert.rejects(f.delivery(f.context, f.manifest, f.token), /revoked/); assert.equal(f.effects.length, 0);
});

test('executable/arbitrary binary is rejected explicitly without execution or outbound effect', async t => {
  const f = await fixture(t, { output: Buffer.from('MZnever execute me') });
  await assert.rejects(f.delivery(f.context, f.manifest, f.token), /executable artifacts are unsupported/);
  assert.equal(f.effects.length, 0); assert.equal(f.artifacts.list({ ownerId: 'owner', taskId: f.taskId }).length, 0);
  assert.ok(existsSync(f.path));
});
