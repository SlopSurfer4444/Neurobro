import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertFreshStatePath, noLinks, OpsError, within, samePath } from './paths.ts';

export interface IsolatedProfile {
  schemaVersion: 1; profileId: string; stateDirectory: string; createdAt: string;
  hermesHome: string; telegramDatabase: string; telegramFiles: string;
  workspaces: string; artifacts: string; logs: string; temp: string;
}
export const PROFILE_MARKER = '.neurobro-profile.json';
export async function readProfile(stateDirectory: string): Promise<IsolatedProfile> {
  const root = assertFreshStatePath(stateDirectory); await noLinks(root);
  let profile: IsolatedProfile;
  try { profile = JSON.parse(await readFile(join(root, PROFILE_MARKER), 'utf8')) as IsolatedProfile; }
  catch { throw new OpsError('profile_marker_invalid'); }
  if (profile.schemaVersion !== 1 || typeof profile.stateDirectory !== 'string' || !samePath(profile.stateDirectory, root) || typeof profile.profileId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.profileId)) throw new OpsError('profile_binding_invalid');
  for (const field of ['hermesHome', 'telegramDatabase', 'telegramFiles', 'workspaces', 'artifacts', 'logs', 'temp'] as const) {
    if (typeof profile[field] !== 'string' || profile[field] === root || !within(root, profile[field])) throw new OpsError('profile_path_invalid');
    await noLinks(profile[field]);
  }
  return profile;
}
export async function prepareIsolatedProfile(stateDirectory: string, options: { profileId?: string } = {}): Promise<IsolatedProfile> {
  const root = assertFreshStatePath(stateDirectory); await noLinks(root);
  try { if ((await readdir(root)).length) throw new OpsError('profile_destination_not_empty'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const profileId = options.profileId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId)) throw new OpsError('profile_id_invalid');
  const profile: IsolatedProfile = {
    schemaVersion: 1, profileId, stateDirectory: root, createdAt: new Date().toISOString(),
    hermesHome: join(root, 'engine', 'home'), telegramDatabase: join(root, 'telegram', 'database'),
    telegramFiles: join(root, 'telegram', 'files'), workspaces: join(root, 'workspaces'),
    artifacts: join(root, 'artifacts'), logs: join(root, 'logs'), temp: join(root, 'temp'),
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const field of ['hermesHome', 'telegramDatabase', 'telegramFiles', 'workspaces', 'artifacts', 'logs', 'temp'] as const) await mkdir(profile[field], { recursive: true, mode: 0o700 });
  await writeFile(join(root, PROFILE_MARKER), JSON.stringify(profile, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'STOP'), 'Prepared offline. Explicit onboarding and readiness are required.\n', { flag: 'wx', mode: 0o600 });
  return profile;
}

const providerNames = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NOUS_API_KEY', 'GOOGLE_API_KEY']);
/** Internal spawn environment: callers must never log the returned object. */
export function buildHermesEnvironment(profile: IsolatedProfile, options: {
  apiKey: string; providerEnv?: Record<string, string>; systemEnv?: NodeJS.ProcessEnv; port?: number;
}): NodeJS.ProcessEnv {
  if (!options.apiKey || options.apiKey.length < 16 || /[\r\n\0]/.test(options.apiKey)) throw new OpsError('engine_api_key_invalid');
  const system = options.systemEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC']) if (system[name]) env[name] = system[name];
  if (system.SystemRoot) env.PATH = join(system.SystemRoot, 'System32');
  env.HOME = profile.hermesHome; env.USERPROFILE = profile.hermesHome;
  env.HERMES_HOME = profile.hermesHome;
  env.LOCALAPPDATA = join(profile.hermesHome, 'local'); env.APPDATA = join(profile.hermesHome, 'roaming');
  env.TEMP = profile.temp; env.TMP = profile.temp;
  env.API_SERVER_ENABLED = 'true'; env.API_SERVER_KEY = options.apiKey;
  env.API_SERVER_HOST = '127.0.0.1';
  const port = options.port ?? 8642;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new OpsError('engine_port_invalid');
  env.API_SERVER_PORT = String(port);
  env.PYTHONNOUSERSITE = '1'; env.PYTHONDONTWRITEBYTECODE = '1';
  env.HERMES_WRITE_SAFE_ROOT = profile.workspaces;
  for (const [name, value] of Object.entries(options.providerEnv ?? {})) {
    if (!providerNames.has(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new OpsError('provider_environment_forbidden');
    env[name] = value;
  }
  return env;
}

export interface SettlementProof {
  schemaVersion: 1; profileId: string; stateDirectory: string; stoppedAt: string;
  brokerSettled: true; engineSettled: true; telegramSettled: true;
}
export async function requireStopped(profile: IsolatedProfile, proof: SettlementProof): Promise<void> {
  if (proof.schemaVersion !== 1 || proof.profileId !== profile.profileId || proof.stateDirectory !== profile.stateDirectory ||
      proof.brokerSettled !== true || proof.engineSettled !== true || proof.telegramSettled !== true || !Number.isFinite(Date.parse(proof.stoppedAt))) throw new OpsError('settlement_proof_required');
  if (!(await lstat(join(profile.stateDirectory, 'STOP'))).isFile()) throw new OpsError('stop_required');
  for (const name of ['service.lock', 'broker.lock', 'telegram.lock', 'hermes.lock', '.ops.lock']) {
    try { await lstat(join(profile.stateDirectory, name)); throw new OpsError('process_lease_present'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
