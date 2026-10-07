import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { hashFile, noLinks, assertFreshStatePath, within, OpsError, samePath } from './paths.ts';
import { readProfile, PROFILE_MARKER } from './profile.ts';
import { verifyCronPatch } from './cron-patch.ts';

const execute = promisify(execFile);
export const HERMES_COMMIT = '8d5e3e412138342e8bf30443e72bd4e6a9abd057';
export const HERMES_LOCK_SHA256 = '5f81d0f7057b13bac07a8ee663ee5f501f4f0d743b2beefd5ee1d1fd334c85a5';
export const TDLIB_COMMIT = '42e6a5259551178d1dab54a22ad96d14bd906e20';
export const TDLIB_VERSION = '1.8.67';
export interface RuntimeBinary { path: string; sha256: string; version: string }
export interface RuntimeBindings {
  schemaVersion: 1;
  node: RuntimeBinary; python: RuntimeBinary;
  hermesSource: { path: string; commit: string; cronPatchReceipt?: string };
  tdjson: RuntimeBinary & { sourceCommit: string };
  containment?: { accepted: boolean; evidencePath?: string };
}
/** Shape of the trusted root config. This module never reads credential files. */
export interface DoctorConfig {
  schemaVersion: number; stateDirectory: string;
  account: { id: string; ownerId: string; controlPeerId: string };
  encryptionKeyEnv: string;
  hermes: { baseUrl: string; apiKeyEnv: string; bridgeUrl?: string; registrationKeyEnv?: string; cronUrl?: string };
  telegram: { command: string; args: string[]; databaseDirectory: string; filesDirectory: string; apiIdEnv: string; apiHashEnv: string };
  computer?: { enabled: boolean };
  tools?: { port?: number };
  artifacts?: { pythonExecutable?: string };
  web?: { searchEndpoint?: string; apiKeyEnv?: string };
  images?: { baseUrl: string; apiKeyEnv: string; model: string };
  github?: { owner: string; tokenEnv?: string };
}
export interface DoctorCheck { id: string; status: 'pass' | 'pending' | 'fail'; code: string }
export interface DoctorReport {
  schemaVersion: 1; observedAt: string; mode: 'offline'; configurationValid: boolean;
  sourceReady: boolean; liveReady: false; checks: DoctorCheck[];
}
function credentialName(value: unknown): value is string { return typeof value === 'string' && /^NEUROBRO_[A-Z0-9_]+$/.test(value); }
function safeCode(error: unknown): string { return error instanceof OpsError ? error.code : 'inspection_failed'; }

async function gitHead(source: string): Promise<string> {
  await noLinks(source);
  let gitDirectory = join(source, '.git');
  const stat = await lstat(gitDirectory);
  if (stat.isFile()) {
    const marker = (await readFile(gitDirectory, 'utf8')).trim();
    if (!marker.startsWith('gitdir: ')) throw new OpsError('source_git_invalid');
    gitDirectory = resolve(source, marker.slice(8)); await noLinks(gitDirectory);
  } else if (!stat.isDirectory()) throw new OpsError('source_git_invalid');
  const head = (await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim();
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  if (!/^ref: refs\/[a-zA-Z0-9_./-]+$/.test(head) || head.includes('..')) throw new OpsError('source_git_invalid');
  const ref = head.slice(5);
  let commonDirectory = gitDirectory;
  try { commonDirectory = resolve(gitDirectory, (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim()); await noLinks(commonDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { return (await readFile(join(commonDirectory, ref), 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const packed = await readFile(join(commonDirectory, 'packed-refs'), 'utf8');
  const entry = packed.split(/\r?\n/).find(line => line.endsWith(` ${ref}`));
  if (!entry) throw new OpsError('source_git_ref_missing');
  return entry.slice(0, 40);
}
async function binaryCheck(binary: RuntimeBinary, expectedVersion: string, probe: boolean): Promise<void> {
  if (!binary || !isAbsolute(binary.path) || !/^[a-f0-9]{64}$/.test(binary.sha256)) throw new OpsError('runtime_binding_invalid');
  if (binary.version !== expectedVersion) throw new OpsError('runtime_version_pin_mismatch');
  if (await hashFile(binary.path) !== binary.sha256) throw new OpsError('runtime_hash_mismatch');
  if (probe) {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
    const result = await execute(binary.path, ['--version'], { timeout: 3000, maxBuffer: 4096, windowsHide: true, env });
    const version = (result.stdout + result.stderr).trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
    if (version !== expectedVersion) throw new OpsError('runtime_observed_version_mismatch');
  }
}

export async function runDoctor(config: DoctorConfig, options: {
  runtime?: RuntimeBindings; env?: NodeJS.ProcessEnv; probeVersions?: boolean;
} = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const inspect = async (id: string, fn: () => Promise<void>, pass = 'verified'): Promise<void> => {
    try { await fn(); checks.push({ id, status: 'pass', code: pass }); }
    catch (error) { checks.push({ id, status: 'fail', code: safeCode(error) }); }
  };
  await inspect('configuration', async () => {
    if (config.schemaVersion !== 1 || !config.account || !['id', 'ownerId', 'controlPeerId'].every(field => typeof config.account[field as keyof typeof config.account] === 'string' && /^-?[1-9]\d*$/.test(config.account[field as keyof typeof config.account]))) throw new OpsError('configuration_invalid');
    const root = assertFreshStatePath(config.stateDirectory); await noLinks(root);
    if (!config.telegram || !isAbsolute(config.telegram.command) || !Array.isArray(config.telegram.args)) throw new OpsError('transport_command_invalid');
    for (const path of [config.telegram.databaseDirectory, config.telegram.filesDirectory]) {
      if (!isAbsolute(path) || path === root || !within(root, path)) throw new OpsError('transport_state_not_isolated'); await noLinks(path);
    }
    const url = new URL(config.hermes.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new OpsError('engine_endpoint_not_loopback');
    if (![config.encryptionKeyEnv, config.hermes.apiKeyEnv, config.telegram.apiIdEnv, config.telegram.apiHashEnv].every(credentialName)) throw new OpsError('credential_environment_name_invalid');
    if (config.hermes.bridgeUrl !== undefined || config.hermes.registrationKeyEnv !== undefined) {
      const bridge = new URL(config.hermes.bridgeUrl ?? 'http://127.0.0.1:8788');
      if (bridge.protocol !== 'http:' || bridge.hostname !== '127.0.0.1' || bridge.username || bridge.password || bridge.search || bridge.hash || bridge.pathname !== '/' || !credentialName(config.hermes.registrationKeyEnv ?? 'NEUROBRO_BRIDGE_REGISTRATION_KEY')) throw new OpsError('bridge_configuration_invalid');
    }
    if (config.hermes.cronUrl !== undefined) {
      const cron = new URL(config.hermes.cronUrl);
      if (cron.protocol !== 'http:' || cron.hostname !== '127.0.0.1' || cron.username || cron.password || cron.search || cron.hash || cron.pathname !== '/' || !cron.port || Number(cron.port) < 1024 || Number(cron.port) > 65535) throw new OpsError('cron_endpoint_invalid');
    }
    if (config.artifacts?.pythonExecutable !== undefined) {
      if (!isAbsolute(config.artifacts.pythonExecutable)) throw new OpsError('artifact_python_absolute_path_required');
      await noLinks(config.artifacts.pythonExecutable);
      if (!(await lstat(config.artifacts.pythonExecutable)).isFile()) throw new OpsError('artifact_python_regular_file_required');
    }
    if (config.web?.apiKeyEnv !== undefined && !credentialName(config.web.apiKeyEnv)) throw new OpsError('credential_environment_name_invalid');
    if (config.images !== undefined) {
      const endpoint = new URL(config.images.baseUrl);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !credentialName(config.images.apiKeyEnv) || !config.images.model || /[\r\n\0]/.test(config.images.model)) throw new OpsError('image_provider_configuration_invalid');
    }
  });
  const configValid = checks[0]?.status === 'pass';
  if (configValid) {
    await inspect('profile', async () => {
      try { await lstat(join(config.stateDirectory, PROFILE_MARKER)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OpsError('profile_not_prepared'); throw error; }
      const profile = await readProfile(config.stateDirectory);
      if (!samePath(profile.telegramDatabase, config.telegram.databaseDirectory) || !samePath(profile.telegramFiles, config.telegram.filesDirectory)) throw new OpsError('profile_transport_binding_mismatch');
    });
    const env = options.env ?? process.env;
    for (const [id, name] of [
      ['state_key', config.encryptionKeyEnv], ['engine_api_key', config.hermes.apiKeyEnv],
      ['telegram_api_id', config.telegram.apiIdEnv], ['telegram_api_hash', config.telegram.apiHashEnv],
    ] as const) checks.push({ id, status: env[name] ? 'pass' : 'pending', code: env[name] ? 'environment_present_not_authenticated' : 'owner_secret_not_provided' });
    const bridgeKeyEnv = config.hermes.registrationKeyEnv ?? 'NEUROBRO_BRIDGE_REGISTRATION_KEY';
    checks.push({ id: 'bridge_registration_key', status: env[bridgeKeyEnv] ? 'pass' : 'pending', code: env[bridgeKeyEnv] ? 'environment_present_not_authenticated' : 'owner_secret_not_provided' });
    for (const [id, name] of [['web_api_key', config.web?.apiKeyEnv], ['images_api_key', config.images?.apiKeyEnv]] as const) {
      if (name) checks.push({ id, status: env[name] ? 'pass' : 'pending', code: env[name] ? 'environment_present_not_authenticated' : 'owner_secret_not_provided' });
    }
    checks.push({ id: 'telegram_authorization', status: 'pending', code: 'explicit_account_onboarding_required' });
    checks.push({ id: 'hermes_handshake', status: 'pending', code: 'authenticated_durable_capabilities_not_probed' });
  }
  const runtime = options.runtime;
  if (!runtime) checks.push({ id: 'runtime', status: 'pending', code: 'runtime_bindings_not_provided' });
  else {
    await inspect('runtime_schema', async () => { if (runtime.schemaVersion !== 1) throw new OpsError('runtime_binding_invalid'); });
    await inspect('node', () => binaryCheck(runtime.node, '24.15.0', options.probeVersions ?? false), options.probeVersions ? 'hash_and_version_verified' : 'hash_verified_version_declared');
    await inspect('python', () => binaryCheck(runtime.python, '3.14.4', options.probeVersions ?? false), options.probeVersions ? 'hash_and_version_verified' : 'hash_verified_version_declared');
    await inspect('hermes_source', async () => {
      if (runtime.hermesSource.commit !== HERMES_COMMIT || await gitHead(runtime.hermesSource.path) !== HERMES_COMMIT) throw new OpsError('engine_source_pin_mismatch');
      if (await hashFile(join(runtime.hermesSource.path, 'uv.lock')) !== HERMES_LOCK_SHA256) throw new OpsError('engine_dependency_lock_mismatch');
    }, 'git_head_and_dependency_lock_verified');
    await inspect('tdjson', async () => {
      if (runtime.tdjson.sourceCommit !== TDLIB_COMMIT) throw new OpsError('tdlib_source_pin_mismatch');
      await binaryCheck(runtime.tdjson, TDLIB_VERSION, false);
    }, 'hash_verified_version_declared');
    if (config.hermes.cronUrl !== undefined) await inspect('hermes_cron_patch', async () => {
      if (!runtime.hermesSource.cronPatchReceipt) throw new OpsError('cron_patch_receipt_required');
      await verifyCronPatch(runtime.hermesSource.path, runtime.hermesSource.cronPatchReceipt);
    }, 'reviewed_overlay_files_verified_runtime_not_probed');
    checks.push({ id: 'tdlib_native_abi', status: 'pending', code: 'native_load_and_version_onboarding_required' });
    checks.push({ id: 'worker_containment', status: 'pending', code: runtime.containment?.accepted ? 'external_containment_evidence_requires_admission' : 'os_boundary_not_accepted' });
  }
  if (config.computer?.enabled) checks.push({ id: 'computer_runtime', status: 'pending', code: 'app_server_runtime_and_project_grants_require_admission' });
  const sourceIds = new Set(['configuration', 'profile', 'runtime_schema', 'node', 'python', 'hermes_source', 'tdjson', 'hermes_cron_patch']);
  return { schemaVersion: 1, observedAt: new Date().toISOString(), mode: 'offline', configurationValid: configValid,
    sourceReady: !!runtime && checks.filter(c => sourceIds.has(c.id)).every(c => c.status === 'pass'), liveReady: false, checks };
}
