import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { AuthorityError, EffectBroker } from '../../src/core/broker.ts';
import { PersonalStore } from '../../src/core/store.ts';
import type { Effect, EffectResult, Grant, TaskIntent, ToolContext } from '../../src/contracts.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'neurobro-broker-'));
  const store = new PersonalStore({ databasePath: join(dir, 'state.sqlite'), encryptionKey: randomBytes(32) });
  const intent: TaskIntent = { id: 'task-a', ownerId: 'owner', accountId: 'account', source: { accountId: 'account', peerId: 'origin', messageId: '1' },
    instruction: 'research', revision: 1, route: { peerId: 'private' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    contextRefs: [], artifactRefs: [], grantId: 'grant-a' };
  const grant: Grant = { id: 'grant-a', taskId: 'task-a', revision: 1, capabilities: [
    { capability: 'web.fetch', resources: ['public-web'] }, { capability: 'web.download', resources: ['public-web'] },
    { capability: 'web.search', resources: ['web'] }, { capability: 'telegram.send', resources: ['private'] },
  ] };
  const context: ToolContext = { taskId: 'task-a', intentRevision: 1, grantId: 'grant-a', grantRevision: 1, runId: 'run-a' };
  store.put('tasks', intent.id, intent); store.put('grants', grant.id, grant);
  let dispatches = 0;
  const broker = new EffectBroker(store, { async dispatch() { dispatches++; return { state: 'unknown' }; }, async reconcile() { return { state: 'verified', receipt: { proven: true } }; } });
  const token = broker.issue(context);
  return { broker, token, store, dispatches: () => dispatches, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('public-web marker grants only credential-free exact HTTP origins to web fetch/download', () => {
  const f = fixture();
  try {
    f.broker.authorize(f.token, 'web.fetch', 'https://example.com');
    f.broker.authorize(f.token, 'web.download', 'http://example.net:8080');
    for (const resource of ['https://u:p@example.com', 'file:///C:/secret', 'https://example.com/path', 'https://example.com/', '*', 'example.com']) {
      assert.throws(() => f.broker.authorize(f.token, 'web.fetch', resource), AuthorityError);
    }
    assert.throws(() => f.broker.authorize(f.token, 'telegram.send', 'https://example.com'), AuthorityError);
    assert.throws(() => f.broker.authorize(f.token, 'telegram.send', '*'), AuthorityError);
    assert.throws(() => f.broker.authorize(f.token, 'web.search', 'https://example.com'), AuthorityError);
    f.broker.authorize(f.token, 'telegram.send', 'private');
  } finally { f.close(); }
});

test('canonical payload identity dedupes reordered object keys and never repeats UNKNOWN dispatch', async () => {
  const f = fixture();
  try {
    const first = await f.broker.execute(f.token, { capability: 'telegram.send', resource: 'private', payload: { text: 'hello', nested: { b: 2, a: 1 } } });
    const repeated = await f.broker.execute(f.token, { capability: 'telegram.send', resource: 'private', payload: { nested: { a: 1, b: 2 }, text: 'hello' } });
    assert.equal(first.id, repeated.id); assert.equal(repeated.state, 'unknown'); assert.equal(f.dispatches(), 1);
    await f.broker.recover();
    assert.equal(f.broker.effects()[0]?.state, 'verified'); assert.equal(f.dispatches(), 1);
  } finally { f.close(); }
});

test('explicit logical effect ID cannot be reused with changed payload; old grant revision rejects all tokens', async () => {
  const f = fixture();
  try {
    await f.broker.execute(f.token, { id: 'outbox', capability: 'telegram.send', resource: 'private', payload: { text: 'a' } });
    await assert.rejects(f.broker.execute(f.token, { id: 'outbox', capability: 'telegram.send', resource: 'private', payload: { text: 'b' } }), AuthorityError);
    const grant = f.store.get<Grant>('grants', 'grant-a')!; grant.revision++;
    f.store.put('grants', grant.id, grant);
    assert.throws(() => f.broker.authorize(f.token, 'telegram.send', 'private'), AuthorityError);
    assert.equal(f.dispatches(), 1);
  } finally { f.close(); }
});

test('native cron executions scope identical generic tool payloads separately while each execution dedupes retries', async () => {
  const f = fixture();
  try {
    const context = f.broker.resolve(f.token).context;
    const first = f.broker.issue({ ...context, runId: 'cron:job:execution-a' });
    const second = f.broker.issue({ ...context, runId: 'cron:job:execution-b' });
    const request = { capability: 'telegram.send', resource: 'private', payload: { text: 'same recurring notification' } };
    const a = await f.broker.execute(first, request);
    const b = await f.broker.execute(second, request);
    assert.notEqual(a.id, b.id); assert.equal(f.dispatches(), 2);
    assert.equal((await f.broker.execute(first, request)).id, a.id);
    assert.equal((await f.broker.execute(second, request)).id, b.id);
    assert.equal(f.dispatches(), 2);
  } finally { f.close(); }
});

test('verified reconciliation clears earlier pending reason in durable state and verified callback without redispatch',async()=>{
  const f=fixture();try{
    let dispatches=0;let verified:Effect|undefined;
    const broker=new EffectBroker(f.store,{async dispatch(){dispatches++;return{state:'unknown',receipt:{tempMessageId:'-5'},reason:'TDLib native admission pending terminal update/readback'};},async reconcile(){return{state:'verified',receipt:{messageId:'905'}};}},undefined,undefined,effect=>{verified=effect;});
    const token=broker.issue(f.broker.resolve(f.token).context),request={capability:'telegram.send',resource:'private',payload:{text:'hello'}};
    const pending=await broker.execute(token,request);assert.match(pending.reason!,/pending/);
    await broker.recover();const saved=broker.effects()[0]!;assert.equal(saved.state,'verified');assert.equal(saved.reason,undefined);assert.equal(Object.hasOwn(saved,'reason'),false);assert.deepEqual(saved.receipt,{messageId:'905'});assert.equal(verified?.reason,undefined);
    assert.equal((await broker.execute(token,request)).reason,undefined);assert.equal(dispatches,1);
  }finally{f.close();}
});

test('settlement preserves current unknown and failure reasons and does not erase an explicit fresh result reason',async()=>{
  const f=fixture();try{
    let outcome:EffectResult={state:'unknown',reason:'Initial native response uncertain'};
    const broker=new EffectBroker(f.store,{async dispatch(){return outcome;},async reconcile(){return outcome;}}),token=broker.issue(f.broker.resolve(f.token).context);
    await broker.execute(token,{capability:'telegram.send',resource:'private',payload:{text:'hello'}});
    outcome={state:'unknown',reason:'Current readback unavailable'};await broker.recover();assert.equal(broker.effects()[0]!.reason,outcome.reason);
    outcome={state:'failed',reason:'Native send rejected'};await broker.recover();assert.equal(broker.effects()[0]!.state,'failed');assert.equal(broker.effects()[0]!.reason,outcome.reason);
    outcome={state:'verified',reason:'Fresh explicit executor diagnostic'};
    const success=await broker.execute(token,{capability:'telegram.send',resource:'private',payload:{text:'second'}});assert.equal(success.reason,outcome.reason);
  }finally{f.close();}
});
