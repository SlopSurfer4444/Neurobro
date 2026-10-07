import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runDoctor, type DoctorConfig, type RuntimeBindings } from './doctor.ts';
import { prepareIsolatedProfile, readProfile, type SettlementProof } from './profile.ts';
import { backupStoppedProfile, restoreStoppedProfile } from './backup.ts';
import { createWindowsLaunchPlans } from './launch.ts';
import { prepareHermesProfile } from './engine-profile.ts';
import { absolute, noLinks, OpsError } from './paths.ts';

async function json<T>(path: string): Promise<T> {
  absolute(path); await noLinks(path);
  if ((await stat(path)).size > 1024 ** 2) throw new OpsError('input_file_limit');
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { throw new OpsError('input_json_invalid'); }
}
function parse(args: string[]): { command: string; flags: Map<string, string> } {
  const command = args[0] ?? '';
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--') || flags.has(name)) throw new OpsError('arguments_invalid');
    flags.set(name, value);
  }
  return { command, flags };
}
export async function opsMain(args: string[]): Promise<number> {
  try {
    const { command, flags } = parse(args);
    const allowed: Record<string, string[]> = {
      prepare: ['--state', '--profile-id'], 'prepare-engine': ['--state', '--plugin', '--model', '--provider', '--cron-url', '--hermes-source', '--cron-patch-receipt'], doctor: ['--config', '--runtime', '--probe-versions'],
      'launch-plans': ['--config', '--runtime', '--package', '--destination', '--bridge-bind', '--broker-url', '--bridge-key-env', '--provider-target', '--provider-source-env'],
      backup: ['--state', '--destination', '--settlement', '--key-env'], restore: ['--backup', '--state', '--key-env'],
    };
    if (!allowed[command] || [...flags.keys()].some(key => !allowed[command]!.includes(key))) throw new OpsError('arguments_invalid');
    const get = (name: string): string => { const value = flags.get(name); if (!value) throw new OpsError('argument_required'); return value; };
    const key = (): Buffer => {
      const name = get('--key-env'); if (!/^NEUROBRO_[A-Z0-9_]+$/.test(name)) throw new OpsError('credential_environment_name_invalid');
      const value = process.env[name]; if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new OpsError('backup_key_must_be_base64_32_bytes');
      return Buffer.from(value, 'base64');
    };
    if (command === 'prepare') {
      await prepareIsolatedProfile(get('--state'), { ...(flags.has('--profile-id') ? { profileId: get('--profile-id') } : {}) });
      console.log(JSON.stringify({ ok: true, operation: 'prepare', stopped: true }));
    } else if (command === 'prepare-engine') {
      const cron = flags.has('--cron-url') ? { url: get('--cron-url'), sourceRoot: get('--hermes-source'), patchReceipt: get('--cron-patch-receipt') } : undefined;
      if (!cron && (flags.has('--hermes-source') || flags.has('--cron-patch-receipt'))) throw new OpsError('cron_url_required');
      await prepareHermesProfile(get('--state'), { pluginSource: get('--plugin'), model: get('--model'), provider: get('--provider'), cron });
      console.log(JSON.stringify({ ok: true, operation: 'prepare-engine', launched: false }));
    } else if (command === 'doctor') {
      const config = await json<DoctorConfig>(get('--config'));
      const runtime = flags.has('--runtime') ? await json<RuntimeBindings>(get('--runtime')) : undefined;
      if (flags.has('--probe-versions') && !['true', 'false'].includes(get('--probe-versions'))) throw new OpsError('arguments_invalid');
      const report = await runDoctor(config, { runtime, probeVersions: flags.get('--probe-versions') === 'true' });
      console.log(JSON.stringify(report)); return report.checks.some(c => c.status === 'fail') ? 1 : 0;
    } else if (command === 'launch-plans') {
      const config = await json<DoctorConfig>(get('--config'));
      const runtime = await json<RuntimeBindings>(get('--runtime'));
      const profile = await readProfile(config.stateDirectory);
      const bridge = flags.has('--bridge-bind') ? { bind: get('--bridge-bind'), registrationKeyEnv: get('--bridge-key-env'), brokerUrl: get('--broker-url') } : undefined;
      const providerEnvironment = flags.has('--provider-target') ? { [get('--provider-target')]: get('--provider-source-env') } : undefined;
      await createWindowsLaunchPlans({ config, runtime, profile, packageRoot: get('--package'), configPath: get('--config'), destination: get('--destination'), bridge, providerEnvironment });
      console.log(JSON.stringify({ ok: true, operation: 'launch-plans', launched: false }));
    } else if (command === 'backup') {
      const backupKey = key();
      try {
        const result = await backupStoppedProfile(get('--state'), get('--destination'), { key: backupKey, settlement: await json<SettlementProof>(get('--settlement')) });
        console.log(JSON.stringify({ ok: true, operation: 'backup', files: result.files, bytes: result.bytes }));
      } finally { backupKey.fill(0); }
    } else if (command === 'restore') {
      const backupKey = key();
      try {
        const result = await restoreStoppedProfile(get('--backup'), get('--state'), { key: backupKey });
        console.log(JSON.stringify({ ok: true, operation: 'restore', files: result.files, reconciliationRequired: true }));
      } finally { backupKey.fill(0); }
    }
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error instanceof OpsError ? error.code : 'operation_failed' }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await opsMain(process.argv.slice(2));
