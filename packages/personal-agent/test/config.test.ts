import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseConfig, encryptionKey, requiredSecret } from '../src/config.ts';

const valid = () => ({ schemaVersion: 1, stateDirectory: resolve('.test-state'), account: { id: 'a', ownerId: '1', controlPeerId: '1' }, encryptionKeyEnv: 'NB_KEY', hermes: { baseUrl: 'http://127.0.0.1:8080', apiKeyEnv: 'NB_API_KEY' }, telegram: { command: 'python', args: ['sidecar.py'], databaseDirectory: resolve('.test-state/td'), filesDirectory: resolve('.test-state/files'), apiIdEnv: 'NB_TG_ID', apiHashEnv: 'NB_TG_HASH' } });
test('configuration refuses credentialed, remote plaintext and relative state endpoints', () => {
  for (const baseUrl of ['http://remote.invalid', 'https://user:secret@remote.invalid', 'file:///tmp/a']) assert.throws(() => parseConfig({ ...valid(), hermes: { ...valid().hermes, baseUrl } }));
  assert.throws(() => parseConfig({ ...valid(), stateDirectory: 'relative' }));
  assert.throws(() => parseConfig({ ...valid(), schemaVersion: 2 }));
  assert.equal(parseConfig(valid()).hermes.baseUrl, 'http://127.0.0.1:8080');
});
test('state key validates canonical encoding and diagnostics never contain values', () => {
  const config = parseConfig(valid());
  assert.deepEqual(encryptionKey(config, { NB_KEY: '01'.repeat(32) }), Buffer.alloc(32, 1));
  assert.deepEqual(encryptionKey(config, { NB_KEY: Buffer.alloc(32, 2).toString('base64') }), Buffer.alloc(32, 2));
  for (const value of ['private-value', `${Buffer.alloc(32).toString('base64')}!`, 'aa']) {
    assert.throws(() => encryptionKey(config, { NB_KEY: value }), (error: Error) => !error.message.includes(value));
  }
  assert.throws(() => requiredSecret('NB_ABSENT', {}), /NB_ABSENT/);
});
test('personal context requires exact owner and explicit scope; GitHub cannot be an arbitrary endpoint', () => {
  const desktopContext = { enabled: true, codexHome: resolve('.codex-fixture'), ownerId: '1', scope: { allOwnerThreads: true } };
  assert.equal(parseConfig({ ...valid(), desktopContext, github: { owner: 'example-owner' }, documents: { enabled: true } }).desktopContext?.ownerId, '1');
  assert.throws(() => parseConfig({ ...valid(), desktopContext: { ...desktopContext, ownerId: 'other' } }), /owner/);
  assert.throws(() => parseConfig({ ...valid(), desktopContext: { ...desktopContext, scope: {} } }), /explicit/);
  assert.throws(() => parseConfig({ ...valid(), desktopContext: { ...desktopContext, codexHome: '../secret' } }), /absolute/);
  for (const owner of ['https://evil.example', '../other', 'owner/repo', '@me']) assert.throws(() => parseConfig({ ...valid(), github: { owner } }), /GitHub/);
});
