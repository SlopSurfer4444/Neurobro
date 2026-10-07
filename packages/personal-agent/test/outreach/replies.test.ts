import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalStore } from '../../src/core/store.ts';
import { canonicalJson, effectOperationId } from '../../src/core/broker.ts';
import { createHash } from 'node:crypto';
import { deliveryParts } from '../../src/core/controller.ts';
import { OutreachReplyService, outreachReplyTools } from '../../src/outreach/replies.ts';
import type { OutreachReplyTarget } from '../../src/outreach/index.ts';
import type { Effect, MessageRef, Observation, RunSnapshot, TaskIntent, ToolContext } from '../../src/contracts.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'employer-replies-')), path = join(root, 'state.sqlite'), encryptionKey = Buffer.alloc(32, 45);
  let store = new PersonalStore({ databasePath: path, encryptionKey });
  const context: ToolContext = { taskId: 'new-owner-query', intentRevision: 1, runId: 'query-run', grantId: 'grant', grantRevision: 1 };
  const task: TaskIntent = { id: context.taskId, revision: 1, ownerId: 'owner', accountId: 'account', source: { accountId: 'account', peerId: 'control', messageId: 'query' },
    instruction: '/бро какие новые ответы от работодателей', route: { peerId: 'control' }, grantId: 'grant', contextRefs: [], artifactRefs: [], createdAt: '', updatedAt: '' };
  store.put('tasks', task.id, task);
  const targets: OutreachReplyTarget[] = [{ batchId: 'prior-task-approved-batch', recipientId: 'employer', peerId: '100', messageId: '10', sentAt: '2026-10-05T10:00:00Z' }];
  const rows = new Map<string, Observation>(), calls: string[] = [];
  const make = (id: string, text: string, overrides: Partial<Observation> = {}): Observation => ({ id: 'incoming:' + id, kind: 'message', ref: { accountId: 'account', peerId: '100', messageId: id },
    authorId: '100', outgoing: false, text, sentAt: '2026-10-05T10:05:00Z', observedAt: '2026-10-05T10:05:01Z', ...overrides });
  let history = async (peer: string, _options: { before?: string; limit: number }): Promise<Observation[]> => [...rows.values()].filter(row => row.ref.peerId === peer);
  const telegram = { async resolvePeer(peer: string) { calls.push('resolve:' + peer); return { accountId: 'account', peerId: peer, kind: 'user' as const, userId: peer, title: 'Иван, компания Пример', username: 'example_hr' }; },
    async readHistory(peer: string, options: { before?: string; limit: number }) { calls.push('history:' + peer + ':' + (options.before ?? 'head')); return history(peer, options); },
    async getMessage(ref: MessageRef) { calls.push('message:' + ref.peerId + ':' + ref.messageId); const row = rows.get(ref.messageId); return row && structuredClone(row); } };
  const create = () => new OutreachReplyService({ store, telegram, accountId: 'account', controlPeerId: 'control', targets: () => targets, now: () => new Date('2026-10-05T10:10:00Z'), maxPagesPerPeer: 2 });
  let service = create();
  function finalEffects(output: string, state: Effect['state'] = 'verified'): string[] {
    const snapshot: RunSnapshot = { binding: { taskId: context.taskId, intentRevision: context.intentRevision, runId: context.runId, idempotencyKey: 'query' }, state: 'completed', observedAt: '', output };
    store.put('runs', context.taskId + ':1', snapshot);
    return deliveryParts(output).map((part, index) => {
      const request = { id: 'delivery:' + context.runId + ':part:' + index, capability: 'telegram.send', resource: 'control', payload: { peerId: 'control', text: part } };
      const id = effectOperationId(context, request);
      const effect: Effect = { id, taskId: context.taskId, intentRevision: 1, grantId: 'grant', grantRevision: 1, capability: 'telegram.send', resource: 'control',
        payload: request.payload, payloadHash: createHash('sha256').update(canonicalJson(request.payload)).digest('hex'), state, receipt: { peerId: 'control', messageId: String(1000 + index) }, createdAt: '', updatedAt: '' };
      store.put('effects', id, effect); return id;
    });
  }
  return { get store() { return store; }, get service() { return service; }, context, task, targets, rows, calls, make, finalEffects,
    setHistory: (reader: typeof history) => { history = reader; },
    reopen: () => { store.close(); store = new PersonalStore({ databasePath: path, encryptionKey }); service = create(); },
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('new private owner query reads only verified prior batch DMs with fresh identity/provenance and no employer send', async () => {
  const f = fixture();
  try {
    const valid = f.make('11', 'Спасибо! Пришлите удобное время.', { replyTo: { accountId: 'account', peerId: '100', messageId: '10' } });
    f.rows.set('11', valid); f.rows.set('12', f.make('12', 'Ожидаем вас завтра.'));
    f.rows.set('9', f.make('9', 'Старая беседа', { sentAt: '2026-10-05T09:00:00Z' }));
    f.rows.set('13', f.make('13', 'Пересланная чужая речь', { forwarded: true }));
    f.rows.set('14', f.make('14', 'Автор не соответствует личному диалогу', { authorId: 'attacker' }));
    f.rows.set('15', f.make('15', 'Ответ на другое письмо', { replyTo: { accountId: 'account', peerId: '100', messageId: '2' } }));
    f.rows.set('16', f.make('16', '/бро владельца', { outgoing: true }));
    assert.equal(await f.service.recordObservation(valid), true); assert.equal(await f.service.recordObservation(f.rows.get('16')!), false);
    assert.equal(await f.service.recordObservation(f.make('20', 'Чужой аккаунт', { ref: { accountId: 'other-account', peerId: '100', messageId: '20' } })), false);
    const digest = await f.service.digest(f.context);
    assert.deepEqual(digest.replies.map(reply => reply.ref.messageId), ['11', '12']);
    assert.deepEqual(digest.replies.map(reply => reply.attribution), ['exact-reply', 'private-dialogue-after-send']);
    assert.equal(digest.replies[0]!.batchId, 'prior-task-approved-batch'); assert.equal(digest.replies[0]!.destination.title, 'Иван, компания Пример');
    assert.equal(f.store.list('effects').length, 0); assert.ok(f.calls.every(call => !call.includes('unselected')));
    assert.equal(outreachReplyTools(f.service)[0]!.name, 'outreach.replies');
  } finally { f.close(); }
});
test('reading is not reporting; exact complete final delivery marks latest run digest once and persists across restart/new tasks', async () => {
  const f = fixture();
  try {
    f.rows.set('11', f.make('11', 'Первый ответ')); const first = await f.service.digest(f.context);
    assert.equal((await f.service.digest(f.context)).replies.length, 1);
    f.rows.set('12', f.make('12', 'Второй ответ')); const latest = await f.service.digest(f.context); assert.equal(latest.replies.length, 2);
    const unknown = f.finalEffects('a'.repeat(5000), 'unknown');
    assert.throws(() => f.service.acknowledgeDelivered(f.context.taskId, f.context.runId, unknown), /independently verified/u);
    assert.equal((await f.service.digest(f.context)).replies.length, 2);
    const finals = f.finalEffects('a'.repeat(5000)); assert.equal(finals.length, 2);
    assert.throws(() => f.service.acknowledgeDelivered(f.context.taskId, f.context.runId, [finals[0]!]), /every exact final/u);
    assert.throws(() => f.service.acknowledgeDelivered(f.context.taskId, f.context.runId, ['owner-ACK']), /every exact final/u);
    f.service.acknowledgeDelivered(f.context.taskId, f.context.runId, finals);
    assert.equal(f.store.get<{ deliveredAt?: string }>('outreach-reply-digests-v1', first.id)?.deliveredAt, undefined);
    f.service.acknowledgeDelivered(f.context.taskId, f.context.runId, finals); f.reopen();
    assert.equal((await f.service.digest(f.context)).replies.length, 0);
    const next = { ...f.context, taskId: 'another-owner-query', runId: 'another-run' }; f.store.put('tasks', next.taskId, { ...f.task, id: next.taskId });
    assert.equal((await f.service.digest(next)).replies.length, 0);
    f.rows.set('11', f.make('11', 'Изменили время встречи', { kind: 'edit' }));
    assert.deepEqual((await f.service.digest(next)).replies.map(reply => reply.text), ['Изменили время встречи']);
    assert.equal(f.store.list('grants').length, 0); // Reading prior sends does not reissue their permissions.
  } finally { f.close(); }
});
test('fresh invalid edit/deletion never resurrects old attributed text from the journal', async () => {
  const f = fixture();
  try {
    const initial = f.make('11', 'Приняты на работу'); f.rows.set('11', initial); await f.service.recordObservation(initial);
    f.rows.set('11', { ...initial, kind: 'edit', forwarded: true, text: 'Переотправлено другое сообщение' });
    assert.equal((await f.service.digest(f.context)).replies.length, 0);
    f.rows.set('11', initial); assert.equal((await f.service.digest(f.context)).replies.length, 1);
    f.rows.delete('11'); assert.equal((await f.service.digest(f.context)).replies.length, 0);
  } finally { f.close(); }
});
test('exact read pagination exposes partial/unavailable coverage and third party routes cannot query employer digest', async () => {
  const f = fixture();
  try {
    const row = f.make('70', 'Отклик'); f.rows.set('70', row);
    f.setHistory(async (_peer, options) => options.before ? [f.make('60', 'Вторая страница')] : [row]);
    const digest = await f.service.digest(f.context); assert.equal(digest.coverage[0]!.status, 'partial'); assert.equal(digest.coverage[0]!.pages, 2);
    assert.ok(f.calls.includes('history:100:70'));
    f.setHistory(async () => [{ ...row, ref: { ...row.ref, peerId: 'unapproved' } }]);
    const bad = await f.service.digest(f.context); assert.equal(bad.coverage[0]!.status, 'unavailable'); assert.equal(bad.replies.length, 0);
    f.store.put('tasks', f.task.id, { ...f.task, route: { peerId: 'public' } });
    await assert.rejects(f.service.digest(f.context), /owner control task/u);
  } finally { f.close(); }
});
test('native message ordering attributes a reply received in the same second as outbound dispatch', async () => {
  const f = fixture();
  try {
    f.targets[0]!.sentAt = '2026-10-05T10:00:00.750Z';
    f.rows.set('11', f.make('11', 'Моментальный ответ', { sentAt: '2026-10-05T10:00:00Z' }));
    f.rows.set('9', f.make('9', 'Предыдущее сообщение той же секунды', { sentAt: '2026-10-05T10:00:00Z' }));
    assert.deepEqual((await f.service.digest(f.context)).replies.map(reply => reply.text), ['Моментальный ответ']);
  } finally { f.close(); }
});
