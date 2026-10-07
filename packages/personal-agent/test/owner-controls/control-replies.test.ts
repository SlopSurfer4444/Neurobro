import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPersonalAgent } from '../../src/core/controller.ts';
import { OwnerControlService } from '../../src/owner-controls/service.ts';

test('owner effect hook permits core private control replies hidden from ordinary task status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'neurobro-control-hook-'));
  let controls: OwnerControlService; let submits = 0; let sends = 0;
  const agent = createPersonalAgent({ databasePath: join(directory, 'state.sqlite'), encryptionKey: randomBytes(32),
    accountId: 'account', ownerId: 'owner', privateRoute: { peerId: 'private' },
    validateEffect: (context, request) => controls.validateEffect(context, request),
    engine: { async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
      async submit() { submits++; throw new Error('Control replies must not invoke engine'); },
      async inspect() { throw new Error('No engine run'); }, async cancel() { throw new Error('No engine run'); } },
    executor: { async dispatch(effect) { sends++; assert.equal(effect.resource, 'private'); return { state: 'verified', receipt: { peerId: 'private', messageId: 'receipt' } }; },
      async reconcile() { return { state: 'unknown' }; } },
  });
  controls = new OwnerControlService({ store: agent.store, accountId: 'account', ownerId: 'owner', controlPeerId: 'private',
    taskIntent: id => agent.status(id)?.intent, taskActive: id => !!agent.status(id), validateAuthority: context => { agent.validateAuthority(context); },
    baseCapabilities: () => [], telegram: { async getMessage() { return undefined; }, async resolveSource() { throw new Error('unused'); }, async resolveForwardSource() { return undefined; } },
  });
  try {
    const now = new Date().toISOString();
    const observation = { id: 'status-request', kind: 'message' as const, ref: { accountId: 'account', peerId: 'origin', messageId: 'owner-command' },
      authorId: 'owner', outgoing: true, text: '/бро статус', sentAt: now, observedAt: now };
    const response = await agent.journalControlReply(observation, 'Текущих задач нет.');
    assert.equal(response.state, 'verified'); assert.equal(sends, 1); assert.equal(submits, 0); assert.deepEqual(agent.status(), []);
    assert.equal((await agent.journalControlReply(observation, 'Changed snapshot')).id, response.id); assert.equal(sends, 1);
  } finally { agent.close(); rmSync(directory, { recursive: true, force: true }); }
});
