import { copyFile, mkdir, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { hashFile, noLinks, OpsError, walkFiles } from './paths.ts';
import { readProfile } from './profile.ts';
import { HERMES_COMMIT } from './doctor.ts';
import { verifyCronPatch, CRON_PATCH_ID } from './cron-patch.ts';

/** Offline placement only. Never imports Python code, authenticates, or starts a gateway. */
export async function prepareHermesProfile(stateDirectory: string, options: {
  pluginSource: string; model: string; provider: string;
  cron?: { url: string; sourceRoot: string; patchReceipt: string };
}): Promise<void> {
  const profile = await readProfile(stateDirectory);
  if ((await readdir(profile.hermesHome)).length) throw new OpsError('engine_profile_not_fresh');
  if (!(await lstat(join(profile.stateDirectory, 'STOP'))).isFile()) throw new OpsError('stop_required');
  for (const name of ['service.lock', 'broker.lock', 'hermes.lock', 'telegram.lock', '.ops.lock']) {
    try { await lstat(join(profile.stateDirectory, name)); throw new OpsError('process_lease_present'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!options.model || options.model.length > 200 || /[\r\n\0]/.test(options.model) || !/^[a-z0-9_-]{1,50}$/.test(options.provider) || options.provider === 'auto') throw new OpsError('explicit_provider_and_model_required');
  if (options.cron) {
    const cronUrl = new URL(options.cron.url);
    if (cronUrl.protocol !== 'http:' || cronUrl.hostname !== '127.0.0.1' || cronUrl.username || cronUrl.password || cronUrl.pathname !== '/' || cronUrl.search || cronUrl.hash || !cronUrl.port || Number(cronUrl.port) < 1024 || Number(cronUrl.port) > 65535) throw new OpsError('cron_endpoint_invalid');
    await verifyCronPatch(options.cron.sourceRoot, options.cron.patchReceipt);
  }
  await noLinks(options.pluginSource);
  const pluginRoot = await realpath(options.pluginSource);
  const files = (await walkFiles(pluginRoot)).filter(path => /\.(py|yaml)$/.test(path) && dirname(path) === pluginRoot);
  if (!files.some(path => path === join(pluginRoot, 'plugin.yaml')) || !files.some(path => path === join(pluginRoot, '__init__.py'))) throw new OpsError('bridge_plugin_source_invalid');
  const destination = join(profile.hermesHome, 'plugins', 'neurobro-trusted-bridge');
  await mkdir(destination, { recursive: false, mode: 0o700 }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await mkdir(destination, { mode: 0o700 });
  });
  const copied: { path: string; sha256: string }[] = [];
  for (const path of files) {
    const rel = relative(pluginRoot, path), target = join(destination, rel);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path, target); const hash = await hashFile(path);
    if (await hashFile(target) !== hash) throw new OpsError('bridge_plugin_copy_mismatch');
    copied.push({ path: rel, sha256: hash });
  }
  const yaml = `# Isolated personal profile. Secrets supplied through the narrow spawn environment.\nauth:\n  adopt_external_logins: false\nauxiliary:\n  title_generation:\n    model_upgrade_enabled: false\nmemory:\n  memory_enabled: false\n  user_profile_enabled: false\nskills:\n  inline_shell: false\n  template_vars: false\nmodel:\n  provider: ${JSON.stringify(options.provider)}\n  default: ${JSON.stringify(options.model)}\nplugins:\n  isolation: in_process\n  enabled: [neurobro-trusted-bridge]\nplatform_toolsets:\n  api_server: [neurobro]\n  cli: []\n  cron: []\ngateway:\n  multiplex_profiles: false\n  api_server:\n    enabled: true\n    host: 127.0.0.1\n    port: 8642\n`;
  await writeFile(join(profile.hermesHome, 'config.yaml'), yaml, { flag: 'wx', mode: 0o600 });
  await writeFile(join(profile.hermesHome, '.neurobro-engine-profile.json'), JSON.stringify({ schemaVersion: 1, sourceCommit: HERMES_COMMIT, createdAt: new Date().toISOString(), files: copied, directMessagingEnabled: false, toolsets: ['neurobro'], cronPatch: options.cron ? CRON_PATCH_ID : null }, null, 2), { flag: 'wx', mode: 0o600 });
}
