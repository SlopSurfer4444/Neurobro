import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareIsolatedProfile, prepareHermesProfile } from '../../tools/ops/index.ts';
import { opsMain } from '../../tools/ops/cli.ts';

test('engine preparation copies only reviewed source into fresh home and exposes broker-only toolset', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nb-engine-')), plugin = join(parent, 'plugin');
  await mkdir(plugin); await writeFile(join(plugin, 'plugin.yaml'), 'name: neurobro-trusted-bridge\n');
  await writeFile(join(plugin, '__init__.py'), '# trusted fixture');
  await mkdir(join(plugin, '__pycache__')); await writeFile(join(plugin, '__pycache__', 'cache.pyc'), 'not source');
  const profile = await prepareIsolatedProfile(join(parent, 'state'));
  await prepareHermesProfile(profile.stateDirectory, { pluginSource: plugin, provider: 'openai', model: 'owner-selected-model' });
  const config = await readFile(join(profile.hermesHome, 'config.yaml'), 'utf8');
  assert.ok(config.includes('auth:\n  adopt_external_logins: false\n'));
  assert.ok(config.includes('api_server: [neurobro]')); assert.ok(config.includes('enabled: [neurobro-trusted-bridge]'));
  assert.ok(config.includes('auxiliary:\n  title_generation:\n    model_upgrade_enabled: false\n'));
  assert.ok(config.includes('memory:\n  memory_enabled: false\n  user_profile_enabled: false\n'));
  assert.ok(config.includes('skills:\n  inline_shell: false\n  template_vars: false\n'));
  assert.equal(config.includes('session_search'), false); assert.equal(config.includes('[skills]'), false);
  assert.equal(config.includes('TELEGRAM'), false);
  assert.deepEqual((await readdir(join(profile.hermesHome, 'plugins', 'neurobro-trusted-bridge'))).sort(), ['__init__.py', 'plugin.yaml']);
  await assert.rejects(() => prepareHermesProfile(profile.stateDirectory, { pluginSource: plugin, provider: 'openai', model: 'other' }), { code: 'engine_profile_not_fresh' });
});
test('ops CLI contains invalid arguments without reflecting caller secrets', async () => {
  const outputs: string[] = []; const original = console.error;
  console.error = (value: string) => { outputs.push(value); };
  try { assert.equal(await opsMain(['unknown', '--secret', 'never-reflect-this-token']), 1); }
  finally { console.error = original; }
  assert.deepEqual(outputs, [JSON.stringify({ ok: false, code: 'arguments_invalid' })]);
});
