import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { PersonalAgent } from '../src/core/controller.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'neurobro-status-'));
  const forbidden = async (): Promise<never> => { throw new Error('Status must not invoke the engine'); };
  const agent = new PersonalAgent({ databasePath: join(directory, 'state.sqlite'), encryptionKey: randomBytes(32),
    accountId: 'fixture-account', ownerId: 'fixture-owner', privateRoute: { peerId: 'fixture-private' },
    engine: { capabilities: forbidden, submit: forbidden, inspect: forbidden, cancel: forbidden } });
  t.after(() => { agent.close(); rmSync(directory, { recursive: true, force: true }); });
  const task = (id: string, extra = {}) => agent.store.put('tasks', id, { id, revision: 1, ...extra });
  return { agent, task };
}

test('status preserves state precedence, effects, child holds and latest revision without executing work', t => {
  const { agent, task } = fixture(t);
  const cases: [string, string, string | undefined, object | undefined, string | undefined][] = [
    ['accepted', 'accepted', undefined, undefined, undefined],
    ['working', 'working', 'running', undefined, undefined],
    ['ready', 'ready', 'completed', undefined, undefined],
    ['failed', 'failed', 'failed', undefined, undefined],
    ['paused', 'paused', 'running', { heldAt: 'fixture-hold' }, undefined],
    ['cancelled', 'cancelled', 'completed', { cancelledAt: 'fixture-cancel' }, undefined],
    ['interrupted', 'unknown', 'interrupted', undefined, undefined],
    ['uncertain-run', 'unknown', 'unknown', { cancelledAt: 'fixture-cancel' }, undefined],
    ['uncertain-admission', 'unknown', undefined, { cancelledAt: 'fixture-cancel' }, 'unknown'],
    ['uncertain-effect', 'unknown', 'completed', { cancelledAt: 'fixture-cancel' }, undefined],
    ['dispatching-effect', 'unknown', 'completed', undefined, undefined],
    ['unsettled-child', 'unknown', 'completed', { reason: 'older reason' }, undefined],
    ['settled-child', 'ready', 'completed', undefined, undefined],
  ];
  for (const [id, , run, control, admission] of cases) {
    task(id);
    if (run) agent.store.put('runs', id + ':1', { state: run, binding: { taskId: id, intentRevision: 1 } });
    if (control) agent.store.put('controls', id, control);
    if (admission) agent.store.put('admissions', id + ':1', { state: admission, reason: 'fixed fixture reason' });
  }
  agent.store.put('effects', 'uncertain', { id: 'uncertain', taskId: 'uncertain-effect', state: 'unknown' });
  agent.store.put('effects', 'dispatching', { id: 'dispatching', taskId: 'dispatching-effect', state: 'dispatching' });
  agent.store.put('childStops', 'pending', { taskId: 'unsettled-child', state: 'pending', reason: 'child settlement unknown' });
  agent.store.put('childStops', 'settled', { taskId: 'settled-child', state: 'settled' });
  task('new-revision', { revision: 2 });
  agent.store.put('runs', 'new-revision:1', { state: 'unknown' });
  agent.store.put('runs', 'new-revision:2', { state: 'completed' });
  task('control-only', { controlOnly: true });
  const beforeEffects = agent.store.list('effects');
  const all = agent.status();
  for (const [id, expected] of cases) {
    assert.equal(agent.status(id)?.state, expected, id);
    assert.deepEqual(agent.status(id), all.find(s => s.intent.id === id), id);
  }
  assert.equal(agent.status('new-revision')?.state, 'ready');
  assert.equal(agent.status('unsettled-child')?.reason, 'child settlement unknown');
  assert.equal(agent.status('uncertain-admission')?.admission?.reason, 'fixed fixture reason');
  assert.equal(agent.status('control-only'), undefined);
  assert.equal(agent.status('missing'), undefined);
  assert.equal(all.length, cases.length + 1);
  assert.deepEqual(agent.store.list('effects'), beforeEffects);
  agent.store.put('effects', 'later-unknown', { taskId: 'ready', state: 'unknown' });
  assert.equal(agent.status('ready')?.state, 'unknown', 'later uncertainty must not be hidden by a cache');
});

test('one-task lookup has bounded store reads and list-all reads shared collections once', t => {
  const { agent, task } = fixture(t);
  for (let i = 0; i < 120; i++) {
    task('task-' + i);
    agent.store.put('effects', 'effect-' + i, { id: 'effect-' + i, taskId: 'task-' + i, state: i === 0 ? 'unknown' : 'verified' });
  }
  const calls: string[] = [];
  const get = agent.store.get.bind(agent.store), list = agent.store.list.bind(agent.store);
  agent.store.get = function<T>(collection: string, id: string): T | undefined { calls.push('get:' + collection + ':' + id); return get<T>(collection, id); };
  agent.store.list = function<T>(collection: string): T[] { calls.push('list:' + collection); return list<T>(collection); };
  assert.equal(agent.status('task-0')?.state, 'unknown');
  assert.equal(calls.length, 6);
  assert.equal(calls.filter(c => c === 'list:tasks').length, 0);
  assert.equal(calls.filter(c => c === 'list:effects').length, 1);
  assert.equal(calls.filter(c => c === 'list:childStops').length, 1);
  assert.ok(calls.filter(c => c.startsWith('get:')).every(c => c.endsWith(':task-0') || c.endsWith(':task-0:1')));
  calls.length = 0;
  assert.equal(agent.status().length, 120);
  for (const collection of ['tasks', 'effects', 'childStops']) assert.equal(calls.filter(c => c === 'list:' + collection).length, 1);
  calls.length = 0;
  assert.equal(agent.status('missing'), undefined);
  assert.deepEqual(calls, ['get:tasks:missing']);
});
