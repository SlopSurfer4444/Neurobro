import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApplication } from '../../src/app.ts';
import { HERMES_SOURCE_PIN } from '../../src/hermes/index.ts';
import { prepareIsolatedProfile } from '../../tools/ops/profile.ts';
import type { PersonalConfig } from '../../src/config.ts';

test('unbound or mismatched owner is rejected before filesystem or native launch', async () => {
  for (const account of [{ id: '0', ownerId: '0', controlPeerId: '0' }, { id: '1', ownerId: '2', controlPeerId: '1' }, { id: '1', ownerId: '1', controlPeerId: '0' }]) {
    await assert.rejects(startApplication({ account } as PersonalConfig, new AbortController().signal), /Start blocked: enroll/);
  }
});

test('actual application composition reaches readiness and settles only its isolated child/profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neurobro-app-'));
  const profile = await prepareIsolatedProfile(directory, { profileId: 'integration-fixture' });
  await rm(join(directory, 'STOP'));
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url!);
    for await (const _part of request) { /* fixture body deliberately ignored */ }
    const result = request.url === '/v1/capabilities'
      ? { object: 'hermes.api_server.capabilities', platform: 'hermes-agent', features: { run_submission: true, runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 }, session_resources: true, run_stop: true, run_steer: true } }
      : request.url === '/ready' ? { ok: true, hermesPin: HERMES_SOURCE_PIN, trustedIdentity: 'native_handler_task_id', requiresUniqueAdmissionSession: true } : { ok: false };
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const names = ['NEUROBRO_TEST_STATE', 'NEUROBRO_TEST_API', 'NEUROBRO_TEST_BRIDGE'];
  const prior = names.map(name => process.env[name]);
  process.env[names[0]!] = Buffer.alloc(32, 6).toString('hex');
  process.env[names[1]!] = 'fixture-api-key-irrelevant';
  process.env[names[2]!] = 'fixture-registration-key'.repeat(3);
  const config: PersonalConfig = {
    schemaVersion: 1, stateDirectory: directory, account: { id: '1', ownerId: '1', controlPeerId: '1' }, encryptionKeyEnv: names[0]!,
    hermes: { baseUrl, bridgeUrl: baseUrl, apiKeyEnv: names[1]!, registrationKeyEnv: names[2]! },
    telegram: { command: process.execPath, args: [fileURLToPath(new URL('./tdlib-fixture.mjs', import.meta.url))], databaseDirectory: profile.telegramDatabase, filesDirectory: profile.telegramFiles, apiIdEnv: 'NOT_READ', apiHashEnv: 'NOT_READ' },
    tools: { port: 0 },
  };
  const abort = new AbortController(); const events: Record<string, unknown>[] = [];
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    await startApplication(config, abort.signal, raw => { const event = raw as Record<string, unknown>; events.push(event); if (event.event === 'ready') abort.abort(); });
    assert.equal(events.filter(event => event.event === 'ready').length, 1);
    assert.ok((events.find(event => event.event === 'ready')!.tools as number) >= 40);
    assert.equal(events.at(-1)!.event, 'stopped');
    assert.equal(events.at(-1)!.nativeTasksCancelled, false);
    assert.ok(requests.includes('/v1/capabilities'));
    assert.ok(!requests.includes('/v1/runs'));
    await assert.rejects(access(join(directory, 'service.lock')));
    await assert.rejects(access(join(directory, '.neurobro-reconciliation-required.json')));
  } finally {
    clearTimeout(timer); abort.abort();
    names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(directory.startsWith(join(tmpdir(), 'neurobro-app-'))); await rm(directory, { recursive: true, force: true });
  }
});
