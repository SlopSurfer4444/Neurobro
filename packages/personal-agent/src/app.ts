import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hkdfSync, randomUUID } from 'node:crypto';
import { encryptionKey, requiredSecret, type PersonalConfig } from './config.ts';
import { acquireLease } from './lease.ts';
import { PersonalHost } from './host.ts';
import { HermesEngine, HTTPScopedToolBridge } from './hermes/index.ts';
import { TdlibTelegram, JsonProcessTransport, FileTelegramStore } from './telegram/index.ts';
import { createToolServer, type JobStore, type JobRecord, type WebSearchProvider } from './capabilities/index.ts';
import { imageTools, OpenAiImageProvider } from './capabilities/images.ts';
import { AppServerTransport, CodexComputerAdapter, type ComputerProject, type ComputerTask } from './computer/index.ts';
import { createComputerTools } from './computer/tools.ts';
import { consumeObservations } from './ingress.ts';
import { readProfile } from '../tools/ops/index.ts';
import { createPersonalWorkflows } from './composition.ts';
export { createPersonalWorkflows } from './composition.ts';

export function minimalEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','LANG','LC_ALL']) if (env[key]) result[key] = env[key]!;
  return result;
}
export async function openTelegram(config: PersonalConfig, key: Uint8Array): Promise<TdlibTelegram> {
  const transport = new JsonProcessTransport({ command: config.telegram.command, args: config.telegram.args, env: minimalEnvironment() });
  const store = new FileTelegramStore(join(config.stateDirectory, 'telegram'), Buffer.from(key));
  const telegram = new TdlibTelegram({ accountId: config.account.id, transport, receipts: store, spool: store });
  transport.start();
  try {
    await transport.waitReady();
    const status = await telegram.authStatus();
    if (status['@type'] === 'authorizationStateWaitTdlibParameters') {
      const apiId = Number(requiredSecret(config.telegram.apiIdEnv));
      if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error('Telegram API ID must be a positive integer');
      await telegram.configureParameters({ ...config.telegram, apiId, apiHash: requiredSecret(config.telegram.apiHashEnv), databaseEncryptionKey: Buffer.from(hkdfSync('sha256', key, '', 'neurobro-tdlib-v1', 32)).toString('base64') });
    }
    return telegram;
  } catch (error) {
    try { await telegram.close(); }
    catch {
      await writeFile(join(config.stateDirectory, '.neurobro-reconciliation-required.json'), JSON.stringify({ schemaVersion: 1, reason: 'telegram_startup_closure_unknown', at: new Date().toISOString() }), { mode: 0o600 });
    }
    throw error;
  }
}

export function encryptedJobStore(host: PersonalHost): JobStore {
  return {
    async load(taskId, id) { return host.agent.store.get<JobRecord>('jobs', `${taskId}/${id}`); },
    async list(taskId, limit) { return host.agent.store.list<JobRecord>('jobs').filter(job => job.binding.taskId === taskId).slice(0, limit); },
    async save(record, expectedVersion) { return host.agent.store.transaction(() => {
      const key = `${record.binding.taskId}/${record.id}`;
      const old = host.agent.store.get<JobRecord>('jobs', key);
      if (old ? old.version !== expectedVersion : expectedVersion !== undefined) return false;
      host.agent.store.put('jobs', key, record); return true;
    }); },
  };
}

function searchProvider(config: PersonalConfig): WebSearchProvider | undefined {
  if (!config.web?.searchEndpoint) return undefined;
  return { async search(query, options) {
    const url = new URL(config.web!.searchEndpoint!); url.searchParams.set('q', query); url.searchParams.set('format','json');
    const secret = config.web?.apiKeyEnv ? requiredSecret(config.web.apiKeyEnv) : undefined;
    const response = await fetch(url, { headers: secret ? { Authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
    if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}`);
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error('Search provider returned an empty response');
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Search response exceeds configured limit'); chunks.push(chunk); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { results?: { title?: string; url?: string; content?: string; snippet?: string }[] };
    if (!Array.isArray(data.results)) throw new Error('Search endpoint must return a results array');
    return data.results.slice(0, options.limit).filter(item => typeof item.title === 'string' && typeof item.url === 'string').map(item => ({ title: item.title!, url: item.url!, snippet: item.snippet ?? item.content }));
  } };
}

/** The only installed-host composition. Calling this explicitly starts the configured new profile. */
export async function startApplication(config: PersonalConfig, signal: AbortSignal, log: (event: object) => void = event => process.stdout.write(JSON.stringify(event) + '\n')): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(config.account.id) || config.account.ownerId !== config.account.id || !/^-?[1-9][0-9]*$/.test(config.account.controlPeerId)) {
    throw new Error('Start blocked: enroll and confirm the owner account before starting');
  }
  const profile = await readProfile(config.stateDirectory);
  if (config.telegram.databaseDirectory !== profile.telegramDatabase || config.telegram.filesDirectory !== profile.telegramFiles) throw new Error('Telegram directories do not match isolated profile');
  const lease = acquireLease(config.stateDirectory);
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const active = controller.signal;
  let telegram: TdlibTelegram | undefined; let engine: HermesEngine | undefined; let host: PersonalHost | undefined;
  let server: Awaited<ReturnType<typeof createToolServer>> | undefined; let computer: CodexComputerAdapter | undefined;
  let intake: Promise<void> | undefined; let polling: Promise<void> | undefined;
  let workflows: ReturnType<typeof createPersonalWorkflows> | undefined;
  try {
    const key = encryptionKey(config);
    telegram = await openTelegram(config, key);
    const auth = await telegram.authStatus();
    if (auth['@type'] !== 'authorizationStateReady') throw new Error(`Telegram login required (${auth['@type']}); run login --config explicitly`);
    await telegram.verifyAccount();
    const bridge = new HTTPScopedToolBridge({ baseUrl: config.hermes.bridgeUrl ?? 'http://127.0.0.1:8788', registrationKey: requiredSecret(config.hermes.registrationKeyEnv ?? 'NEUROBRO_BRIDGE_REGISTRATION_KEY') });
    engine = new HermesEngine({ baseUrl: config.hermes.baseUrl, apiKey: requiredSecret(config.hermes.apiKeyEnv), statePath: join(config.stateDirectory, 'hermes-admissions.sqlite'), bridge, artifactRoot: join(config.stateDirectory, 'artifacts','stages'), requestTimeoutMs: config.hermes.requestTimeoutMs });
    host = new PersonalHost({ config, encryptionKey: key, telegram, engine, acknowledge: id => telegram!.acknowledgeObservation(id),
      onTaskStop: async (taskId, reason, revision) => {
        if(computer) return computer.stopTask(taskId, reason, revision);
        const previous=host?.agent.store.get<ComputerTask>('computer',taskId);
        return previous && previous.state!=='created' && !(previous.executionSettled && previous.effectsReconciled)
          ? {settled:false,reason:'Configured computer executor is unavailable; prior child requires reconciliation'} : {settled:true};
      },
      onFinalDelivery: ({ taskId, runId, effects }) => workflows!.replies.acknowledgeDelivered(taskId, runId, effects.map(effect => effect.id)),
      onOwnerControlEvent: (event, context) => workflows!.onOwnerControlEvent(event, context),
      isPrivateMonitorExecution: context => workflows?.monitors?.isMonitorExecution(context) === true });
    const owner = host;
    const computerTools = [];
    if (config.computer?.enabled) {
      const codexHome = join(config.stateDirectory, 'computer-home'); await mkdir(codexHome, { recursive: true, mode: 0o700 });
      let executorId = owner.agent.store.get<string>('metadata', 'computer-executor');
      if (!executorId) { executorId = randomUUID(); owner.agent.store.put('metadata', 'computer-executor', executorId); }
      computer = new CodexComputerAdapter({ executorId,
        projects: config.computer.projects as ComputerProject[],
        transport: new AppServerTransport({ command: config.computer.command, args: config.computer.args, cwd: config.stateDirectory, env: { ...minimalEnvironment(), CODEX_HOME: codexHome } }),
        registry: { async list() { return owner.agent.store.list<ComputerTask>('computer'); }, async get(id) { return owner.agent.store.get<ComputerTask>('computer', id); }, async put(task) { owner.agent.store.put('computer', task.taskId, task); } },
      });
      computerTools.push(...createComputerTools({ adapter: computer }));
    }
    workflows = createPersonalWorkflows({ host: owner, config, telegram, hermesHome: profile.hermesHome,
      nativeSchedules: config.hermes.cronUrl ? { baseUrl: config.hermes.cronUrl, registrationKey: requiredSecret(config.hermes.registrationKeyEnv ?? 'NEUROBRO_BRIDGE_REGISTRATION_KEY') } : undefined,
      jobs: encryptedJobStore(owner),
      web: { searchProvider: searchProvider(config), artifactSink: { async stage(context, input) { return owner.artifacts.put({ ownerId: config.account.ownerId, taskId: context.taskId, name: input.name, mimeType: input.mimeType, bytes: input.bytes, sourceRef: input.sourceUrl }); } } },
      extraTools: [...computerTools, ...(config.images ? imageTools({ broker: owner.agent, store: owner.agent.store, artifacts: owner.artifacts,
        scope: context => ({ ownerId: config.account.ownerId, taskId: context.taskId }),
        provider: new OpenAiImageProvider({ baseUrl: config.images.baseUrl, apiKey: requiredSecret(config.images.apiKeyEnv), model: config.images.model }) }) : [])],
    });
    const { registry, schedules, monitorSource } = workflows;
    server = await createToolServer(registry, { host: '127.0.0.1', port: config.tools?.port ?? 8787,
      routeHandler: schedules ? (request, response) => schedules.handleRequest(request, response) : undefined });
    await host.agent.start();
    const scheduleRestoration = await schedules?.restoreBindings();
    if(scheduleRestoration)log({event:'schedule_restoration',...scheduleRestoration});
    log({ event: 'ready', tools: registry.list().length, toolEndpoint: server.address, coverage: telegram.status().coverage });
    intake = consumeObservations(telegram, active, async observation => {
      await monitorSource.recordObservation(observation);
      const employerSource = await workflows!.replies.recordObservation(observation);
      if (employerSource && !observation.outgoing) {
        await telegram!.acknowledgeObservation(observation.id);
        return;
      }
      const result = await owner.ingest(observation);
      await workflows!.syncOwnerPolicies();
      if (result.disposition !== 'ignored' && result.disposition !== 'duplicate') log({ event: 'intake', disposition: result.disposition, taskId: result.taskId });
    });
    polling = (async () => { while (!active.aborted) {
      await owner.processInvalidations();
      await workflows!.syncOwnerPolicies();
      await owner.pollLifecycle();
      if (existsSync(join(config.stateDirectory, 'STOP'))) { controller.abort(); break; }
      try { await delay(750, undefined, { signal: active }); } catch { break; }
    } })();
    await Promise.race([intake, polling]);
    controller.abort();
    await Promise.all([intake, polling]);
  } finally {
    controller.abort(); signal.removeEventListener('abort', abort);
    await Promise.allSettled([intake, polling].filter(Boolean));
    const closures = await Promise.allSettled([server?.close(), telegram?.close(), computer?.close().then(receipt => {
      if (!receipt.processExited) throw new Error('Computer executor closure is not confirmed');
    })]);
    workflows?.dispose(); await host?.close(); engine?.close();
    if (closures.some(item => item.status === 'rejected')) {
      await writeFile(join(config.stateDirectory, '.neurobro-reconciliation-required.json'), JSON.stringify({ schemaVersion: 1, reason: 'connection_closure_unknown', leaseId: lease.id, at: new Date().toISOString() }), { mode: 0o600 });
      log({ event: 'shutdown_unknown', leaseRetained: true });
    } else { lease.close(); log({ event: 'stopped', nativeTasksCancelled: false }); }
  }
}
