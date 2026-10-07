import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWindowsLaunchPlans, prepareIsolatedProfile, hashFile, HERMES_COMMIT, TDLIB_COMMIT,
  runDoctor, verifyCronPatch, CRON_PATCH_FILES, prepareHermesProfile, type DoctorConfig, type RuntimeBindings } from '../../tools/ops/index.ts';

test('launch plans bind literal argv and hashes while engine gets no Telegram environment', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nb-plan-'));
  const profile = await prepareIsolatedProfile(join(parent, 'state'));
  const packageRoot = join(parent, 'package'), engine = join(parent, 'hermes');
  await mkdir(join(packageRoot, 'src'), { recursive: true }); await mkdir(join(packageRoot, 'tools')); await mkdir(engine);
  await writeFile(join(packageRoot, 'src', 'cli.ts'), '// immutable fixture');
  await writeFile(join(engine, 'uv.lock'), 'fixture lock');
  await writeFile(join(profile.hermesHome, 'config.yaml'), 'plugins:\n  enabled: [neurobro-trusted-bridge]\n');
  await mkdir(join(profile.hermesHome, 'plugins'));
  const config: DoctorConfig = { schemaVersion: 1, stateDirectory: profile.stateDirectory,
    account: { id: '1', ownerId: '1', controlPeerId: '1' }, encryptionKeyEnv: 'NEUROBRO_STATE_KEY',
    hermes: { baseUrl: 'http://127.0.0.1:8642', apiKeyEnv: 'NEUROBRO_HERMES_API_KEY' },
    web: { apiKeyEnv: 'NEUROBRO_WEB_API_KEY' }, images: { baseUrl: 'https://images.example.invalid', apiKeyEnv: 'NEUROBRO_IMAGES_API_KEY', model: 'explicit-model' },
    telegram: { command: process.execPath, args: [], databaseDirectory: profile.telegramDatabase, filesDirectory: profile.telegramFiles, apiIdEnv: 'NEUROBRO_TG_API_ID', apiHashEnv: 'NEUROBRO_TG_API_HASH' } };
  const runtime: RuntimeBindings = { schemaVersion: 1,
    node: { path: process.execPath, sha256: await hashFile(process.execPath), version: '24.15.0' },
    python: { path: process.execPath, sha256: await hashFile(process.execPath), version: '3.14.4' },
    hermesSource: { path: engine, commit: HERMES_COMMIT },
    tdjson: { path: process.execPath, sha256: await hashFile(process.execPath), version: '1.8.67', sourceCommit: TDLIB_COMMIT } };
  const configPath = join(parent, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  const plans = await createWindowsLaunchPlans({ configPath, config, runtime, profile, packageRoot, destination: parent,
    providerEnvironment: { OPENAI_API_KEY: 'NEUROBRO_PROVIDER_OPENAI_KEY' } });
  const broker = JSON.parse(await readFile(plans.brokerPlan, 'utf8'));
  const hermes = JSON.parse(await readFile(plans.hermesPlan, 'utf8'));
  assert.deepEqual(broker.arguments.slice(-3), ['start', '--config', configPath]);
  assert.equal(await hashFile(plans.brokerPlan), plans.brokerSha256);
  assert.ok(broker.evidenceFiles.some((file: { path: string }) => file.path === configPath));
  assert.ok(broker.environment.NEUROBRO_TG_API_HASH);
  assert.equal(hermes.environment.NEUROBRO_TG_API_HASH, undefined);
  assert.equal(hermes.environment.API_SERVER_KEY.fromEnvironment, 'NEUROBRO_HERMES_API_KEY');
  assert.equal(hermes.environment.OPENAI_API_KEY.fromEnvironment, 'NEUROBRO_PROVIDER_OPENAI_KEY');
  assert.equal(hermes.environment.HERMES_HOME.literal, profile.hermesHome);
  assert.equal(hermes.environment.NEUROBRO_BRIDGE_BIND.literal, '127.0.0.1:8788');
  assert.equal(hermes.environment.NEUROBRO_BROKER_URL.literal, 'http://127.0.0.1:8787/tools/call');
  assert.equal(hermes.environment.NEUROBRO_CRON_BIND, undefined);
  assert.equal(hermes.environment.NEUROBRO_STATE_KEY, undefined);
  assert.equal(hermes.environment.NEUROBRO_BRIDGE_REGISTRATION_KEY.fromEnvironment, 'NEUROBRO_BRIDGE_REGISTRATION_KEY');
  assert.equal(broker.environment.NEUROBRO_BRIDGE_REGISTRATION_KEY.fromEnvironment, 'NEUROBRO_BRIDGE_REGISTRATION_KEY');
  assert.equal(broker.environment.NEUROBRO_IMAGES_API_KEY.fromEnvironment, 'NEUROBRO_IMAGES_API_KEY');
  assert.equal(broker.environment.NEUROBRO_WEB_API_KEY.fromEnvironment, 'NEUROBRO_WEB_API_KEY');
  assert.equal(hermes.environment.NEUROBRO_IMAGES_API_KEY, undefined);
  assert.equal(hermes.environment.NEUROBRO_WEB_API_KEY, undefined);
  // Actual executable versions/API/identity are intentionally not accepted by this fixture.
  const report = await runDoctor(config, { runtime, env: {}, probeVersions: true });
  assert.equal(report.liveReady, false); assert.equal(report.sourceReady, false);
  assert.equal(report.checks.find(c => c.id === 'python')?.code, 'runtime_observed_version_mismatch');
  assert.equal(report.checks.find(c => c.id === 'hermes_source')?.status, 'fail');
});

const reviewedOverlay = fileURLToPath(new URL('../../tools/hermes/patches/native-overlay-v2-final', import.meta.url));
async function cronFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'nb-cron-plan-'));
  const profile = await prepareIsolatedProfile(join(parent, 'state'));
  const packageRoot = join(parent, 'package'), engine = join(parent, 'engine');
  await mkdir(join(packageRoot, 'src'), { recursive: true }); await mkdir(join(packageRoot, 'tools'));
  await mkdir(join(engine, 'cron'), { recursive: true }); await mkdir(join(engine, 'hermes_cli'));
  await writeFile(join(packageRoot, 'src', 'cli.ts'), '// fixture'); await writeFile(join(engine, 'uv.lock'), 'fixture');
  for (const file of Object.keys(CRON_PATCH_FILES)) await copyFile(join(reviewedOverlay, file), join(engine, file));
  const receipt = join(engine, 'cron-patch-receipt.json'); await copyFile(join(reviewedOverlay, 'patch-receipt.json'), receipt);
  await writeFile(join(profile.hermesHome, 'config.yaml'), 'plugins:\n  enabled: [neurobro-trusted-bridge]\n');
  await mkdir(join(profile.hermesHome, 'plugins'));
  const config: DoctorConfig = { schemaVersion: 1, stateDirectory: profile.stateDirectory,
    account: { id: '1', ownerId: '1', controlPeerId: '1' }, encryptionKeyEnv: 'NEUROBRO_STATE_KEY',
    hermes: { baseUrl: 'http://127.0.0.1:8642', apiKeyEnv: 'NEUROBRO_HERMES_API_KEY', cronUrl: 'http://127.0.0.1:8789' },
    telegram: { command: process.execPath, args: [], databaseDirectory: profile.telegramDatabase, filesDirectory: profile.telegramFiles, apiIdEnv: 'NEUROBRO_TG_API_ID', apiHashEnv: 'NEUROBRO_TG_API_HASH' } };
  const binary = { path: process.execPath, sha256: await hashFile(process.execPath) };
  const runtime: RuntimeBindings = { schemaVersion: 1, node: { ...binary, version: '24.15.0' }, python: { ...binary, version: '3.14.4' },
    hermesSource: { path: engine, commit: HERMES_COMMIT, cronPatchReceipt: receipt }, tdjson: { ...binary, version: '1.8.67', sourceCommit: TDLIB_COMMIT } };
  const configPath = join(parent, 'config.json'); await writeFile(configPath, JSON.stringify(config));
  return { parent, profile, packageRoot, engine, receipt, config, runtime, configPath };
}
test('cron enabled launch binds exact reviewed overlay and numeric port without inheriting credentials', async () => {
  const f = await cronFixture();
  const prior = process.env.NEUROBRO_TG_API_HASH; process.env.NEUROBRO_TG_API_HASH = 'inherited-must-not-appear';
  try {
    const plans = await createWindowsLaunchPlans({ ...f, destination: f.parent });
    const engine = JSON.parse(await readFile(plans.hermesPlan, 'utf8'));
    assert.equal(engine.environment.NEUROBRO_CRON_BIND.literal, '127.0.0.1:8789');
    assert.equal(engine.environment.NEUROBRO_TG_API_HASH, undefined);
    assert.equal(JSON.stringify(engine).includes('inherited-must-not-appear'), false);
    for (const file of Object.keys(CRON_PATCH_FILES)) assert.ok(engine.evidenceFiles.some((entry: { path: string }) => entry.path === join(f.engine, file)));
    const report = await runDoctor(f.config, { runtime: f.runtime, env: {} });
    assert.equal(report.checks.find(c => c.id === 'hermes_cron_patch')?.status, 'pass');
    assert.equal(report.liveReady, false);
  } finally { if (prior === undefined) delete process.env.NEUROBRO_TG_API_HASH; else process.env.NEUROBRO_TG_API_HASH = prior; }
});
test('cron configured rejects stock/missing or modified patch before producing launch plans', async () => {
  const f = await cronFixture(); delete f.runtime.hermesSource.cronPatchReceipt;
  await assert.rejects(() => createWindowsLaunchPlans({ ...f, destination: f.parent }), { code: 'cron_patch_receipt_required' });
  f.runtime.hermesSource.cronPatchReceipt = f.receipt;
  await writeFile(join(f.engine, 'cron', 'scheduler.py'), '# modified');
  await assert.rejects(() => createWindowsLaunchPlans({ ...f, destination: f.parent }), { code: 'cron_patch_not_applied_or_modified' });
  assert.equal((await readdir(f.parent)).includes('hermes.launch.json'), false);
});
test('reviewed receipt cannot substitute another patch generation or claimed hashes', async () => {
  const f = await cronFixture(); const receipt = JSON.parse(await readFile(f.receipt, 'utf8'));
  receipt.files['cron/jobs.py'].patchedSha256 = '0'.repeat(64); await writeFile(f.receipt, JSON.stringify(receipt));
  await assert.rejects(() => verifyCronPatch(f.engine, f.receipt), { code: 'cron_patch_receipt_mismatch' });
});
test('configured bridge and broker ports reject contradictory launch overrides', async () => {
  const f = await cronFixture(); delete f.config.hermes.cronUrl; await writeFile(f.configPath, JSON.stringify(f.config));
  await assert.rejects(() => createWindowsLaunchPlans({ ...f, destination: f.parent,
    bridge: { bind: '127.0.0.1:8864', registrationKeyEnv: 'NEUROBRO_BRIDGE_REGISTRATION_KEY', brokerUrl: 'http://127.0.0.1:8787/tools/call' } }), { code: 'bridge_configuration_binding_mismatch' });
});
test('cron disabled never enables an inherited cron bind or accepts ephemeral broker port', async () => {
  const f = await cronFixture(); delete f.config.hermes.cronUrl; await writeFile(f.configPath, JSON.stringify(f.config));
  const prior = process.env.NEUROBRO_CRON_BIND; process.env.NEUROBRO_CRON_BIND = '127.0.0.1:9999';
  try {
    const plans = await createWindowsLaunchPlans({ ...f, destination: f.parent });
    const plan = JSON.parse(await readFile(plans.hermesPlan, 'utf8')); assert.equal(plan.environment.NEUROBRO_CRON_BIND, undefined);
  } finally { if (prior === undefined) delete process.env.NEUROBRO_CRON_BIND; else process.env.NEUROBRO_CRON_BIND = prior; }
  f.config.tools = { port: 0 }; await writeFile(f.configPath, JSON.stringify(f.config));
  await assert.rejects(() => createWindowsLaunchPlans({ ...f, destination: f.parent }), { code: 'broker_static_port_required' });
});
test('Windows JSON forward-slash profile paths bind to the same prepared state', async () => {
  const f = await cronFixture(); delete f.config.hermes.cronUrl;
  f.config.stateDirectory = f.config.stateDirectory.replaceAll('\\', '/');
  f.config.telegram.databaseDirectory = f.config.telegram.databaseDirectory.replaceAll('\\', '/');
  f.config.telegram.filesDirectory = f.config.telegram.filesDirectory.replaceAll('\\', '/');
  await writeFile(f.configPath, JSON.stringify(f.config));
  const plans = await createWindowsLaunchPlans({ ...f, destination: f.parent });
  assert.ok(plans.brokerSha256);
  const report = await runDoctor(f.config, { env: {} });
  assert.equal(report.checks.find(c => c.id === 'profile')?.status, 'pass');
});
test('image/web broker-only credentials cannot alias engine or Telegram credential references', async () => {
  const f = await cronFixture(); delete f.config.hermes.cronUrl;
  f.config.images = { baseUrl: 'https://images.example.invalid', model: 'explicit', apiKeyEnv: 'NEUROBRO_PROVIDER_OPENAI_KEY' };
  await writeFile(f.configPath, JSON.stringify(f.config));
  await assert.rejects(() => createWindowsLaunchPlans({ ...f, destination: f.parent,
    providerEnvironment: { OPENAI_API_KEY: 'NEUROBRO_PROVIDER_OPENAI_KEY' } }), { code: 'provider_environment_forbidden' });
  f.config.images.apiKeyEnv = f.config.telegram.apiHashEnv; await writeFile(f.configPath, JSON.stringify(f.config));
  await assert.rejects(() => createWindowsLaunchPlans({ ...f, destination: f.parent }), { code: 'credential_purpose_alias_forbidden' });
});
test('cron profile preparation validates applied overlay and never applies it implicitly', async () => {
  const f = await cronFixture(), profile = await prepareIsolatedProfile(join(f.parent, 'fresh-state'));
  const plugin = join(f.parent, 'plugin'); await mkdir(plugin);
  await writeFile(join(plugin, 'plugin.yaml'), 'name: neurobro-trusted-bridge\n'); await writeFile(join(plugin, '__init__.py'), '# fixture');
  const originalHash = await hashFile(join(f.engine, 'cron', 'jobs.py'));
  await prepareHermesProfile(profile.stateDirectory, { pluginSource: plugin, provider: 'openai', model: 'selected',
    cron: { url: 'http://127.0.0.1:8789', sourceRoot: f.engine, patchReceipt: f.receipt } });
  assert.equal(await hashFile(join(f.engine, 'cron', 'jobs.py')), originalHash);
  const failed = await prepareIsolatedProfile(join(f.parent, 'rejected-state'));
  await writeFile(join(f.engine, 'cron', 'jobs.py'), '# stock-or-modified');
  await assert.rejects(() => prepareHermesProfile(failed.stateDirectory, { pluginSource: plugin, provider: 'openai', model: 'selected',
    cron: { url: 'http://127.0.0.1:8789', sourceRoot: f.engine, patchReceipt: f.receipt } }), { code: 'cron_patch_not_applied_or_modified' });
  assert.deepEqual(await readdir(failed.hermesHome), []);
});
