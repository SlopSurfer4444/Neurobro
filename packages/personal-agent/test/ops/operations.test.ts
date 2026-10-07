import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { backupStoppedProfile, restoreStoppedProfile, prepareIsolatedProfile, readProfile, buildHermesEnvironment,
  runDoctor, OpsError, type SettlementProof, type DoctorConfig, type IsolatedProfile } from '../../tools/ops/index.ts';

async function fixture(): Promise<IsolatedProfile> {
  const parent = await mkdtemp(join(tmpdir(), 'nb-ops-'));
  return prepareIsolatedProfile(join(parent, 'personal'), { profileId: 'owner-personal' });
}
function proof(profile: IsolatedProfile): SettlementProof { return { schemaVersion: 1, profileId: profile.profileId,
  stateDirectory: profile.stateDirectory, stoppedAt: new Date().toISOString(), brokerSettled: true, engineSettled: true, telegramSettled: true }; }
function config(profile: IsolatedProfile): DoctorConfig {
  return { schemaVersion: 1, stateDirectory: profile.stateDirectory, account: { id: '1', ownerId: '1', controlPeerId: '1' },
    encryptionKeyEnv: 'NEUROBRO_STATE_KEY', hermes: { baseUrl: 'http://127.0.0.1:8642', apiKeyEnv: 'NEUROBRO_HERMES_API_KEY' },
    telegram: { command: process.execPath, args: [], databaseDirectory: profile.telegramDatabase, filesDirectory: profile.telegramFiles,
      apiIdEnv: 'NEUROBRO_TG_API_ID', apiHashEnv: 'NEUROBRO_TG_API_HASH' } };
}
test('new profile is independent, initially stopped, and refuses reuse', async () => {
  const profile = await fixture(); assert.deepEqual(await readProfile(profile.stateDirectory), profile);
  assert.equal((await lstat(join(profile.stateDirectory, 'STOP'))).isFile(), true);
  await assert.rejects(() => prepareIsolatedProfile(profile.stateDirectory), { code: 'profile_destination_not_empty' });
  const parent = await mkdtemp(join(tmpdir(), 'nb-ops-'));
  await assert.rejects(() => prepareIsolatedProfile(join(parent, '.hermes')), { code: 'historical_profile_forbidden' });
});
test('profile preparation denies junction/symlink ancestry without touching target', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nb-ops-')); const external = join(parent, 'external');
  await mkdir(external); const link = join(parent, 'link');
  await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => prepareIsolatedProfile(join(link, 'personal')), { code: 'symlink_or_junction_forbidden' });
  assert.deepEqual(await readdir(external), []);
});
test('engine spawn environment excludes Telegram, inherited credentials and old homes', async () => {
  const profile = await fixture();
  const env = buildHermesEnvironment(profile, { apiKey: 'new-engine-api-secret',
    systemEnv: { SystemRoot: 'C:\\Windows', HERMES_HOME: 'old', HOME: 'old', TELEGRAM_BOT_TOKEN: 'old-bot', NEUROBRO_TG_API_HASH: 'private', OPENAI_API_KEY: 'borrowed', PYTHONPATH: 'bad', CODEX_HOME: 'old' },
    providerEnv: { OPENAI_API_KEY: 'explicit-new-provider' } });
  assert.equal(env.HERMES_HOME, profile.hermesHome); assert.equal(env.API_SERVER_KEY, 'new-engine-api-secret');
  assert.equal(env.OPENAI_API_KEY, 'explicit-new-provider'); assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.NEUROBRO_TG_API_HASH, undefined); assert.equal(env.PYTHONPATH, undefined); assert.equal(env.CODEX_HOME, undefined);
  assert.throws(() => buildHermesEnvironment(profile, { apiKey: 'new-engine-api-secret', providerEnv: { TELEGRAM_BOT_TOKEN: 'bad' } }), { code: 'provider_environment_forbidden' });
});
test('offline doctor never declares live readiness or exposes secret values', async () => {
  const profile = await fixture(), cfg = config(profile); const sentinel = 'top-private-auth-material';
  const report = await runDoctor(cfg, { env: { NEUROBRO_STATE_KEY: sentinel, NEUROBRO_HERMES_API_KEY: sentinel, NEUROBRO_TG_API_ID: sentinel, NEUROBRO_TG_API_HASH: sentinel } });
  assert.equal(report.configurationValid, true); assert.equal(report.liveReady, false); assert.equal(report.sourceReady, false);
  assert.equal(JSON.stringify(report).includes(sentinel), false);
  assert.equal(report.checks.find(c => c.id === 'telegram_authorization')?.status, 'pending');
});
test('doctor contains errors from URL credentials and transport state escapes', async () => {
  const profile = await fixture(), cfg = config(profile);
  cfg.hermes.baseUrl = 'http://user:secret-in-url@127.0.0.1:8642';
  let report = await runDoctor(cfg); assert.equal(report.configurationValid, false); assert.equal(JSON.stringify(report).includes('secret-in-url'), false);
  cfg.hermes.baseUrl = 'http://127.0.0.1:8642'; cfg.telegram.filesDirectory = tmpdir();
  report = await runDoctor(cfg); assert.equal(report.configurationValid, false);
  assert.equal(report.checks[0]?.code, 'transport_state_not_isolated');
});
test('backup requires complete settlement and refuses lease/working overlap', async () => {
  const profile = await fixture(), key = randomBytes(32), destination = join(profile.stateDirectory, '..', 'backup');
  const incomplete = { ...proof(profile), telegramSettled: false } as unknown as SettlementProof;
  await assert.rejects(() => backupStoppedProfile(profile.stateDirectory, destination, { key, settlement: incomplete }), { code: 'settlement_proof_required' });
  await writeFile(join(profile.stateDirectory, 'service.lock'), 'active');
  await assert.rejects(() => backupStoppedProfile(profile.stateDirectory, destination, { key, settlement: proof(profile) }), { code: 'process_lease_present' });
});
test('encrypted backup restores exact ledger bytes without admitting or overwriting effects', async () => {
  const profile = await fixture(), key = randomBytes(32);
  const ledger = Buffer.from('effect-1 UNKNOWN: external-send-may-have-succeeded\n');
  await writeFile(join(profile.stateDirectory, 'ledger.db'), ledger);
  const destination = join(profile.stateDirectory, '..', 'backup');
  const backup = await backupStoppedProfile(profile.stateDirectory, destination, { key, settlement: proof(profile) });
  assert.ok(backup.files > 1); assert.ok(!(await readFile(join(destination, 'manifest.gcm'))).includes(ledger));
  assert.equal(JSON.stringify(JSON.parse(await readFile(backup.manifestPath, 'utf8'))).includes(profile.stateDirectory), false);
  const restored = join(profile.stateDirectory, '..', 'restored');
  const result = await restoreStoppedProfile(destination, restored, { key });
  assert.equal(result.reconciliationRequired, true); assert.deepEqual(await readFile(join(restored, 'ledger.db')), ledger);
  assert.deepEqual(await readFile(join(profile.stateDirectory, 'ledger.db')), ledger);
  assert.equal((await readProfile(restored)).stateDirectory, restored);
  assert.ok((await lstat(join(restored, 'STOP'))).isFile());
  const marker = JSON.parse(await readFile(join(restored, '.neurobro-reconciliation-required.json'), 'utf8'));
  assert.equal(marker.admissionBlocked, true);
  await assert.rejects(() => restoreStoppedProfile(destination, restored, { key }), { code: 'destination_already_exists' });
});
test('restore denies wrong key and corrupted payload, retaining source', async () => {
  const profile = await fixture(), key = randomBytes(32), backup = join(profile.stateDirectory, '..', 'backup');
  await backupStoppedProfile(profile.stateDirectory, backup, { key, settlement: proof(profile) });
  await assert.rejects(() => restoreStoppedProfile(backup, join(backup, '..', 'wrong'), { key: randomBytes(32) }), { code: 'backup_authentication_failed' });
  await writeFile(join(backup, 'blobs', '0.gcm'), 'corrupted');
  await assert.rejects(() => restoreStoppedProfile(backup, join(backup, '..', 'broken'), { key }), { code: 'backup_hash_mismatch' });
  assert.equal((await readProfile(profile.stateDirectory)).profileId, profile.profileId);
});
test('backup denies symlink inside state and releases its private lease after failure', async () => {
  const profile = await fixture(), external = join(profile.stateDirectory, '..', 'outside'); await mkdir(external);
  await symlink(external, join(profile.stateDirectory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => backupStoppedProfile(profile.stateDirectory, join(profile.stateDirectory, '..', 'backup'), { key: randomBytes(32), settlement: proof(profile) }), { code: 'symlink_or_junction_forbidden' });
  await assert.rejects(() => lstat(join(profile.stateDirectory, '.ops.lock')), { code: 'ENOENT' });
});
