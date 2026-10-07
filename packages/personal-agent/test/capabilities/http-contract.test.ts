import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../src/artifacts/index.ts';
import { createArtifactTools } from '../../src/artifacts/create.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import { createToolServer } from '../../src/capabilities/server.ts';
import { obj, str } from '../../src/capabilities/schema.ts';
import { TdRequestError } from '../../src/telegram/transport.ts';
import type { ToolBroker, RegisteredTool } from '../../src/capabilities/types.ts';
import type { ArtifactRecord, ToolContext } from '../../src/contracts.ts';

const token = 'http_contract_issued_token_123456';
const context: ToolContext = { taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' };
function broker(): ToolBroker {
  return { resolveToolContext: () => context, authorizeTool() {}, async executeEffect() { throw new Error('No external effects in HTTP contract fixture'); } };
}
function call(address: string, name: string, args: object) {
  return fetch(address + '/tools/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ name, args }) });
}

test('installed HTTP boundary admits full legal artifact content with JSON escaping and retains semantic byte limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'neurobro-http-content-'));
  const store = new ArtifactStore({ rootPath: root, encryptionKey: Buffer.alloc(32, 12) });
  const scope = { ownerId: 'owner', taskId: context.taskId };
  const registry = new ToolRegistry(broker(), createArtifactTools({ store, resolveScope: () => scope }));
  const server = await createToolServer(registry);
  try {
    // 256 KiB of real content becomes over 1 MiB on the wire through JSON escapes.
    const text = '\u007f'.repeat(256 * 1024);
    const request = { name: 'escaped.txt', format: 'text', text };
    // Python's broker client uses ensure_ascii=True, including DEL escaping.
    const wire = JSON.stringify({ name: 'artifact.create', args: request }).replaceAll('\u007f', '\\u007f');
    assert.ok(Buffer.byteLength(wire) > 1024 * 1024);
    const response = await fetch(server.address + '/tools/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: wire });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true, result.error);
    const artifact = result.value as ArtifactRecord;
    assert.equal(artifact.size, 256 * 1024);
    assert.equal(store.read(scope, artifact.id).toString('utf8'), text);
    const oversized = await call(server.address, 'artifact.create', { ...request, text: text + 'x' });
    const denied = await oversized.json();
    assert.equal(denied.ok, false);
    assert.equal(denied.failure.code, 'invalid_arguments');
    assert.equal(denied.failure.outcome, 'not_dispatched');
    assert.equal(store.list(scope).length, 1, 'body allowance cannot weaken the tool content budget');
    const bodyLimit = await call(server.address, 'artifact.create', { ...request, text: 'a'.repeat(2 * 1024 * 1024) });
    assert.equal(bodyLimit.status, 413);
    assert.equal(store.list(scope).length, 1);
  } finally { await server.close(); store.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('HTTP errors distinguish schema, authority, rate limit and uncertain mutation without disclosing exception data', async () => {
  const secret = 'Bearer credential-in-native-exception C:/private/owner-documents';
  let mutations = 0, revoked = false;
  const trusted = broker();
  trusted.authorizeTool = () => { if (revoked) throw new Error(secret); };
  const tool = (name: string, mutates: boolean, execute: RegisteredTool['execute']): RegisteredTool => ({ name, mutates, capability: 'test.read', description: 'HTTP contract fixture', inputSchema: obj({ label: str(8) }), resources: () => [context.taskId], execute });
  const registry = new ToolRegistry(trusted, [
    tool('test.read', false, async () => { throw new Error(secret); }),
    tool('test.limited', false, async () => { throw new TdRequestError(secret, true, 429, 'FLOOD_WAIT_10'); }),
    tool('test.mutate', true, async () => { mutations++; throw new Error(secret); }),
    tool('test.revoke', true, async () => { mutations++; revoked = true; return { accepted: true }; }),
  ]);
  const server = await createToolServer(registry);
  async function failed(name: string, args: object, code: string, outcome: string) {
    const response = await call(server.address, name, args);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, false); assert.equal(result.failure.code, code); assert.equal(result.failure.outcome, outcome);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('credential-in-native-exception'), false);
    return result;
  }
  try {
    await failed('test.read', { label: 'way too long' }, 'invalid_arguments', 'not_dispatched');
    await failed('test.read', { label: 'ok', [secret]: true }, 'invalid_arguments', 'not_dispatched');
    await failed('test.absent', { label: 'ok' }, 'unknown_tool', 'not_dispatched');
    await failed('test.read', { label: 'ok' }, 'operation_failed', 'read_failed');
    const limited = await failed('test.limited', { label: 'ok' }, 'rate_limited', 'read_failed');
    assert.match(limited.error, /Stop Telegram requests/);
    await failed('test.mutate', { label: 'ok' }, 'operation_failed', 'unknown');
    assert.equal(mutations, 1);
    await failed('test.revoke', { label: 'ok' }, 'authority_denied', 'unknown');
    assert.equal(mutations, 2);
    await failed('test.mutate', { label: 'ok' }, 'authority_denied', 'not_dispatched');
    assert.equal(mutations, 2, 'denied predispatch call cannot execute');
  } finally { await server.close(); }
});
