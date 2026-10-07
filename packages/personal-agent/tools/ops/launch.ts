import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashFile, noLinks, walkFiles, absolute, OpsError, samePath } from './paths.ts';
import { buildHermesEnvironment, type IsolatedProfile } from './profile.ts';
import { HERMES_COMMIT, type DoctorConfig, type RuntimeBindings } from './doctor.ts';
import { verifyCronPatch } from './cron-patch.ts';

export interface LaunchPlan {
  schemaVersion: 1; role: 'broker' | 'hermes'; profileId: string; stateDirectory: string;
  executable: { path: string; sha256: string }; workingDirectory: string; arguments: string[];
  evidenceFiles: { path: string; sha256: string }[];
  environment: Record<string, { literal: string } | { fromEnvironment: string }>;
}
/** Writes data-only plans. Does not launch, activate, set autostart, or write credentials. */
export async function createWindowsLaunchPlans(options: {
  packageRoot: string; configPath: string; config: DoctorConfig; runtime: RuntimeBindings;
  profile: IsolatedProfile; destination: string; providerEnvironment?: Record<string, string>;
  bridge?: { bind: string; registrationKeyEnv: string; brokerUrl: string };
}): Promise<{ brokerPlan: string; hermesPlan: string; brokerSha256: string; hermesSha256: string }> {
  const packageRoot = absolute(options.packageRoot); await noLinks(packageRoot);
  const configPath = absolute(options.configPath); await noLinks(configPath);
  const destination = absolute(options.destination); await noLinks(destination);
  if (options.runtime.hermesSource.commit !== HERMES_COMMIT || !samePath(options.config.stateDirectory, options.profile.stateDirectory)) throw new OpsError('launch_profile_binding_invalid');
  if (await hashFile(options.runtime.node.path) !== options.runtime.node.sha256 || await hashFile(options.runtime.python.path) !== options.runtime.python.sha256) throw new OpsError('launch_runtime_hash_mismatch');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as DoctorConfig;
  if (JSON.stringify(config) !== JSON.stringify(options.config)) throw new OpsError('launch_config_binding_mismatch');
  const registrationKeyEnv = config.hermes.registrationKeyEnv ?? 'NEUROBRO_BRIDGE_REGISTRATION_KEY';
  const providerOnlyBrokerNames = new Set([config.web?.apiKeyEnv, config.images?.apiKeyEnv].filter((name): name is string => !!name));
  if ([config.encryptionKeyEnv, config.hermes.apiKeyEnv, config.telegram.apiIdEnv, config.telegram.apiHashEnv, registrationKeyEnv].some(name => providerOnlyBrokerNames.has(name))) throw new OpsError('credential_purpose_alias_forbidden');
  const bridgeUrl = new URL(config.hermes.bridgeUrl ?? 'http://127.0.0.1:8788');
  if (bridgeUrl.protocol !== 'http:' || bridgeUrl.hostname !== '127.0.0.1' || bridgeUrl.username || bridgeUrl.password || bridgeUrl.search || bridgeUrl.hash || bridgeUrl.pathname !== '/' || !bridgeUrl.port || Number(bridgeUrl.port) < 1024 || Number(bridgeUrl.port) > 65535) throw new OpsError('bridge_endpoint_invalid');
  const brokerPort = config.tools?.port ?? 8787;
  if (!Number.isInteger(brokerPort) || brokerPort < 1024 || brokerPort > 65535) throw new OpsError('broker_static_port_required');
  const enginePort = Number(new URL(config.hermes.baseUrl).port) || 8642;
  if (Number(bridgeUrl.port) === brokerPort || Number(bridgeUrl.port) === enginePort || brokerPort === enginePort) throw new OpsError('service_ports_overlap');
  const effectiveBridge = options.bridge ?? { bind: bridgeUrl.host, registrationKeyEnv, brokerUrl: `http://127.0.0.1:${brokerPort}/tools/call` };
  if (effectiveBridge.bind !== bridgeUrl.host || effectiveBridge.registrationKeyEnv !== registrationKeyEnv || effectiveBridge.brokerUrl !== `http://127.0.0.1:${brokerPort}/tools/call`) throw new OpsError('bridge_configuration_binding_mismatch');
  let cronEvidence: { path: string; sha256: string }[] = [];
  let cronBind: string | undefined;
  if (config.hermes.cronUrl !== undefined) {
    const cron = new URL(config.hermes.cronUrl);
    if (cron.protocol !== 'http:' || cron.hostname !== '127.0.0.1' || cron.username || cron.password || cron.search || cron.hash || cron.pathname !== '/' || !cron.port || Number(cron.port) < 1024 || Number(cron.port) > 65535 || Number(cron.port) === brokerPort || Number(cron.port) === enginePort || cron.host === bridgeUrl.host) throw new OpsError('cron_endpoint_invalid');
    if (!options.runtime.hermesSource.cronPatchReceipt) throw new OpsError('cron_patch_receipt_required');
    cronEvidence = await verifyCronPatch(options.runtime.hermesSource.path, options.runtime.hermesSource.cronPatchReceipt);
    cronBind = cron.host;
  }
  const evidence: { path: string; sha256: string }[] = [{ path: configPath, sha256: await hashFile(configPath) }];
  for (const directory of ['src', 'tools']) {
    for (const path of await walkFiles(join(packageRoot, directory))) {
      if (/\.(ts|py|yaml|json)$/.test(path) && !/[\\/](?:node_modules|bin|obj)[\\/]/.test(path)) evidence.push({ path, sha256: await hashFile(path) });
    }
  }
  const env: LaunchPlan['environment'] = {};
  for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = { literal: process.env[name]! };
  if (process.env.SystemRoot) env.PATH = { literal: join(process.env.SystemRoot, 'System32') };
  env.TEMP = { literal: options.profile.temp }; env.TMP = { literal: options.profile.temp };
  for (const name of [config.encryptionKeyEnv, config.hermes.apiKeyEnv, config.telegram.apiIdEnv, config.telegram.apiHashEnv, registrationKeyEnv,
    ...(config.web?.apiKeyEnv ? [config.web.apiKeyEnv] : []), ...(config.images?.apiKeyEnv ? [config.images.apiKeyEnv] : []), ...(config.github?.tokenEnv ? [config.github.tokenEnv] : [])]) {
    if (!/^NEUROBRO_[A-Z0-9_]+$/.test(name)) throw new OpsError('credential_environment_name_invalid');
    env[name] = { fromEnvironment: name };
  }
  const common = { schemaVersion: 1 as const, profileId: options.profile.profileId, stateDirectory: options.profile.stateDirectory };
  const broker: LaunchPlan = { ...common, role: 'broker', executable: options.runtime.node, workingDirectory: packageRoot,
    arguments: ['--disable-warning=ExperimentalWarning', join(packageRoot, 'src', 'cli.ts'), 'start', '--config', configPath], evidenceFiles: evidence, environment: env };
  const engineEnvironment = buildHermesEnvironment(options.profile, { apiKey: 'template-only-no-secret', port: Number(new URL(config.hermes.baseUrl).port) || 8642 });
  const engineEnv: LaunchPlan['environment'] = {};
  for (const [name, value] of Object.entries(engineEnvironment)) if (value !== undefined && name !== 'API_SERVER_KEY') engineEnv[name] = { literal: value };
  engineEnv.API_SERVER_KEY = { fromEnvironment: config.hermes.apiKeyEnv };
  {
    if (!/^127\.0\.0\.1:[1-9]\d{3,4}$/.test(effectiveBridge.bind) || !/^NEUROBRO_[A-Z0-9_]+$/.test(effectiveBridge.registrationKeyEnv)) throw new OpsError('bridge_environment_invalid');
    const url = new URL(effectiveBridge.brokerUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/tools/call') throw new OpsError('bridge_endpoint_invalid');
    engineEnv.NEUROBRO_BRIDGE_BIND = { literal: effectiveBridge.bind };
    engineEnv.NEUROBRO_BRIDGE_REGISTRATION_KEY = { fromEnvironment: effectiveBridge.registrationKeyEnv };
    engineEnv.NEUROBRO_BROKER_URL = { literal: effectiveBridge.brokerUrl };
  }
  if (cronBind !== undefined) engineEnv.NEUROBRO_CRON_BIND = { literal: cronBind };
  const allowedProviders = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'NOUS_API_KEY', 'GOOGLE_API_KEY']);
  for (const [target, source] of Object.entries(options.providerEnvironment ?? {})) {
    if (!allowedProviders.has(target) || !/^NEUROBRO_PROVIDER_[A-Z0-9_]+$/.test(source) || providerOnlyBrokerNames.has(source)) throw new OpsError('provider_environment_forbidden');
    engineEnv[target] = { fromEnvironment: source };
  }
  const engineConfig = join(options.profile.hermesHome, 'config.yaml');
  const engineEvidence = [...cronEvidence, { path: join(options.runtime.hermesSource.path, 'uv.lock'), sha256: await hashFile(join(options.runtime.hermesSource.path, 'uv.lock')) },
    { path: engineConfig, sha256: await hashFile(engineConfig) }];
  for (const path of await walkFiles(join(options.profile.hermesHome, 'plugins'))) if (/\.(py|yaml)$/.test(path)) engineEvidence.push({ path, sha256: await hashFile(path) });
  const hermes: LaunchPlan = { ...common, role: 'hermes', executable: options.runtime.python,
    workingDirectory: options.runtime.hermesSource.path, arguments: ['-m', 'hermes_cli.main', 'gateway'],
    evidenceFiles: engineEvidence, environment: engineEnv };
  const brokerPlan = join(destination, 'broker.launch.json'), hermesPlan = join(destination, 'hermes.launch.json');
  await writeFile(brokerPlan, JSON.stringify(broker, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(hermesPlan, JSON.stringify(hermes, null, 2), { flag: 'wx', mode: 0o600 });
  return { brokerPlan, hermesPlan, brokerSha256: await hashFile(brokerPlan), hermesSha256: await hashFile(hermesPlan) };
}
