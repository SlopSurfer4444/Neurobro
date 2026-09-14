import { lstat, open } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { parseAuthConfig, type AuthConfig } from "./auth-config.js";
import { ask, askHidden } from "./prompt.js";
import { acquireProcessLock } from "./process-lock.js";
import { openExistingEncryptedSessionLease, type GatewayExistingEncryptedSessionLease } from "./existing-session-lease.js";
import { clientOptions } from "./telegram-client.js";
import { installBindingNetworkFence } from "./binding-network-fence.js";
import { createPilotTelegramAdapter, type PilotBinding, type PilotInvoker } from "./pilot-telegram-adapter.js";
import { assertPilotPrivateDirectory, createEncryptedPilotStore, runPilotReply, type PilotDirectoryInspection, type PilotReplyInput, type PilotResult, type PilotStore } from "./pilot-outbox.js";

export const PILOT_GREETING = "Нейробро на связи 🤝 Мозг — Astra, medium. Пока проверяем подключение.";
export const EXPECTED_MODEL_RECEIPT_VERSION = "astra-canary-v3";
export type GreetingPaths = Readonly<{ authConfigPath: string; bindingPath: string; modelReceiptPath: string; attemptDirectory: string; killSwitchPath: string }>;
export type GreetingPrepared = Readonly<{ paths: GreetingPaths; config: AuthConfig; binding: PilotBinding; ownerLock: string }>;
export type GreetingCredentials = { apiId: number; apiHash: string; passphrase: string };
export interface GreetingClient extends PilotInvoker {
  connect(): Promise<unknown>;
  getMe(): Promise<Api.User>;
  destroy(): Promise<unknown>;
}
export type GreetingResult = Readonly<{ status: "verified" | "refused" | "unknown"; code: "PILOT_GREETING_VERIFIED" | "PILOT_GREETING_REFUSED" | "PILOT_GREETING_UNKNOWN"; lockPreserved: boolean; clientSettled: boolean }>;
const refuse = (): never => { throw new Error("PILOT_GREETING_REFUSED"); };
type Data = Record<string, unknown>;
function object(value: unknown): Data { if (!value || typeof value !== "object" || Array.isArray(value)) return refuse(); return value as Data; }
function exact(value: unknown, keys: readonly string[]): Data {
  const result = object(value);
  if (Object.keys(result).sort().join("|") !== [...keys].sort().join("|")) return refuse();
  return result;
}
function allTrue(value: Data, names: readonly string[]): boolean { return names.every(name => value[name] === true); }
const canaryFlags = ["threadAttempted", "threadStarted", "turnAttempted", "turnStarted", "modelMatched", "effortMatched", "permissionsMatched", "ephemeralMatched", "turnCompleted", "answerExact"] as const;

/** Reads only the source-normalized metadata receipt, never model input/output or auth. */
export function assertAstraReady(raw: unknown): void {
  const host = object(raw); const guest = object(host.guest); const client = object(guest.client);
  const canary = exact(client.canary, [...canaryFlags, "answerBytes", "toolEvents", "serverRequests", "events"]);
  const app = object(client.appServer); const custody = object(client.custody); const model = object(custody.model); const account = object(custody.account);
  const controls = exact(custody.controls, ["authMetadata", "authOpenClosed", "parentFdClosed", "proxyEnvPresent", "relayBefore", "relayAfter"]);
  const limits = exact(client.limits, ["clientTurnStartLimit", "transportRetriesDisabled", "syntheticInputOnly", "telegram"]);
  const proofNames = ["public", "auth_direct", "auth_self_root", "auth_server_root", "auth_controller_root", "auth_init_root", "fd", "env", "network"];
  if (host.exitCode !== 0 || host.transportError !== false || host.timedOut !== false || host.overflow !== false || host.outcome !== "completed-review-client-verdict" ||
      guest.version !== EXPECTED_MODEL_RECEIPT_VERSION || guest.outcome !== "completed-review-client-verdict" || guest.stage !== "complete" || guest.telegram !== false ||
      !allTrue(guest, ["preflight", "relayReady", "modelTurnAdmitted", "settled", "relaySettled", "clientNaturalSettlement"]) || guest.clientExit !== 0 || guest.relayExit !== 0 ||
      client.schema !== "decadans.rm0032.astra-canary-client.v1" || client.outcome !== "observed" || client.code !== "OK" || client.stage !== "complete" ||
      !allTrue(canary, canaryFlags) || canary.answerBytes !== Buffer.byteLength("NEUROBRO_ASTRA_READY.") || canary.toolEvents !== 0 || canary.serverRequests !== 0 ||
      !Number.isSafeInteger(canary.events) || (canary.events as number) < 1 || (canary.events as number) > 128 ||
      !allTrue(app, ["launched", "stdinClosed", "reaped", "stderrComplete"]) || app.exitCode !== 0 ||
      !Number.isSafeInteger(app.stderrBytes) || (app.stderrBytes as number) < 0 || (app.stderrBytes as number) > 65536 ||
      custody.initialize !== true || custody.profile !== true || !Object.values(controls).every(value => value === true) ||
      !allTrue(account, ["checked", "chatgpt"]) || !allTrue(model, ["checked", "astraListedOnce", "mediumSupported"]) ||
      !Array.isArray(custody.probes) || custody.probes.length !== proofNames.length ||
      !custody.probes.every((value, index) => { const p = object(value); return p.name === proofNames[index] && p.attempted === true && p.verdict === "pass" && p.rpcCode === null && p.stdoutBytes === 0 && p.stderrBytes === 0; }) ||
      limits.clientTurnStartLimit !== 1 || limits.syntheticInputOnly !== true || limits.telegram !== false || limits.transportRetriesDisabled !== false) return refuse();
}

export function normalizeGreetingPaths(raw: GreetingPaths): GreetingPaths {
  const value = exact(raw, ["authConfigPath", "bindingPath", "modelReceiptPath", "attemptDirectory", "killSwitchPath"]);
  const normalized: Record<string, string> = {};
  for (const [key, path] of Object.entries(value)) {
    if (typeof path !== "string" || !isAbsolute(path)) return refuse();
    normalized[key] = resolve(path);
  }
  const paths = normalized as unknown as GreetingPaths;
  const entries = Object.values(paths);
  if (new Set(entries).size !== entries.length || !entries.every(path => dirname(path) === dirname(paths.authConfigPath))) return refuse();
  return Object.freeze(paths);
}
async function readPrivateJson(path: string, maxBytes: number): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes) return refuse();
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) return refuse();
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) return refuse();
    return JSON.parse(bytes.toString("utf8"));
  } finally { await handle.close(); }
}
export function greetingKillSwitchEngaged(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}
async function requireAbsent(path: string): Promise<void> {
  try { await lstat(path); return refuse(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
/** Caller owns protected ACLs. All five paths and the existing session share one
 * canonical private parent; no directory, config, key or receipt is created here. */
export async function preparePilotGreeting(raw: GreetingPaths, inspection?: PilotDirectoryInspection): Promise<GreetingPrepared> {
  const paths = normalizeGreetingPaths(raw); const parent = dirname(paths.authConfigPath);
  await assertPilotPrivateDirectory(parent, inspection);
  if (greetingKillSwitchEngaged(paths.killSwitchPath)) return refuse();
  await requireAbsent(paths.attemptDirectory);
  assertAstraReady(await readPrivateJson(paths.modelReceiptPath, 65536));
  const config = parseAuthConfig(await readPrivateJson(paths.authConfigPath, 8192), paths.authConfigPath);
  const b = exact(await readPrivateJson(paths.bindingPath, 8192), ["version", "accountId", "peerId", "title", "sessionReference", "ownerLock", "checkedAt", "serving"]);
  const session = config.account.sessionFile;
  if (dirname(session) !== parent || !isAbsolute(String(b.sessionReference)) || resolve(String(b.sessionReference)) !== session ||
      b.ownerLock !== `${session}.owner.lock` || b.version !== "telegram-account-binding-v1" || b.serving !== false ||
      typeof b.accountId !== "string" || !/^[1-9]\d{0,19}$/.test(b.accountId) || typeof b.peerId !== "string" || !/^-[1-9]\d{0,19}$/.test(b.peerId) ||
      typeof b.title !== "string" || !b.title.trim() || b.title.length > 256 || typeof b.checkedAt !== "string" || !Number.isFinite(Date.parse(b.checkedAt)) ||
      Object.values(paths).includes(session) || Object.values(paths).includes(b.ownerLock as string)) return refuse();
  const sessionMetadata = await lstat(session);
  if (!sessionMetadata.isFile() || sessionMetadata.isSymbolicLink() || sessionMetadata.size < 1 || sessionMetadata.size > 65536) return refuse();
  return Object.freeze({ paths, config, binding: Object.freeze({ accountId: b.accountId, peerId: b.peerId }), ownerLock: b.ownerLock as string });
}

export interface GreetingPorts {
  prepare(paths: GreetingPaths): Promise<GreetingPrepared>;
  absent(path: string): Promise<void>;
  acquireLock(path: string): Promise<() => Promise<void>>;
  prompt(): Promise<GreetingCredentials>;
  openSession(reference: string, passphrase: string): Promise<GatewayExistingEncryptedSessionLease>;
  createClient(material: string, credentials: GreetingCredentials): GreetingClient;
  installFence(client: GreetingClient): () => void;
  createAdapter: typeof createPilotTelegramAdapter;
  createStore(directory: string, passphrase: string): PilotStore;
  dispatch(input: PilotReplyInput): Promise<PilotResult>;
  killed(path: string): boolean;
  settle(client: GreetingClient): Promise<boolean>;
}
function result(status: GreetingResult["status"], lockPreserved: boolean, clientSettled: boolean): GreetingResult {
  return Object.freeze({ status, code: status === "verified" ? "PILOT_GREETING_VERIFIED" : status === "refused" ? "PILOT_GREETING_REFUSED" : "PILOT_GREETING_UNKNOWN", lockPreserved, clientSettled });
}
function checked(signal: AbortSignal): void { if (signal.aborted) throw new Error("PILOT_GREETING_ABORTED"); }
async function interruptible<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  checked(signal);
  return new Promise<T>((done, reject) => {
    const abort = () => reject(new Error("PILOT_GREETING_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { checked(signal); return operation(); }).then(done, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Injected one-client orchestration; no automatic retry/recovery and no model port. */
export async function runPilotGreetingWithPorts(paths: GreetingPaths, ports: GreetingPorts, signal: AbortSignal): Promise<GreetingResult> {
  let releaseLock: (() => Promise<void>) | undefined;
  let lease: GatewayExistingEncryptedSessionLease | undefined;
  let credentials: GreetingCredentials | undefined;
  let client: GreetingClient | undefined;
  let restoreFence: (() => void) | undefined;
  let connectionAttempted = false; let status: GreetingResult["status"] = "refused"; let clientSettled = true; let lockPreserved = false;
  try {
    const prepared = await interruptible(signal, () => ports.prepare(paths));
    checked(signal);
    releaseLock = await ports.acquireLock(prepared.ownerLock); lockPreserved = true;
    credentials = await interruptible(signal, () => ports.prompt());
    if (!Number.isSafeInteger(credentials.apiId) || credentials.apiId < 1 || !/^[a-fA-F0-9]{32}$/.test(credentials.apiHash) || credentials.passphrase.length < 16) return refuse();
    lease = await ports.openSession(prepared.config.account.sessionFile, credentials.passphrase);
    checked(signal);
    await ports.absent(prepared.paths.attemptDirectory);
    if (ports.killed(prepared.paths.killSwitchPath)) return refuse();
    client = ports.createClient(lease.material.value, credentials);
    restoreFence = ports.installFence(client);
    const ownedClient = client;
    connectionAttempted = true; clientSettled = false;
    await interruptible(signal, () => ownedClient.connect());
    const self = await interruptible(signal, () => ownedClient.getMe());
    const adapter = await interruptible(signal, () => ports.createAdapter({ client: ownedClient, binding: prepared.binding, self, signal, mode: "greeting" }));
    checked(signal);
    const verdict = await ports.dispatch({
      approved: { chatId: prepared.binding.peerId, accountId: prepared.binding.accountId, replyToMessageId: null, maximumTextBytes: 512 },
      reply: { chatId: prepared.binding.peerId, replyToMessageId: null, text: PILOT_GREETING },
      store: ports.createStore(prepared.paths.attemptDirectory, credentials.passphrase), transport: adapter.transport,
      killSwitchEngaged: () => ports.killed(prepared.paths.killSwitchPath), signal,
    });
    status = verdict.state === "verified" ? "verified" : verdict.state === "unknown" ? "unknown" : "refused";
  } catch { status = connectionAttempted || signal.aborted ? "unknown" : "refused"; }
  finally {
    if (client) {
      try { clientSettled = await ports.settle(client); } catch { clientSettled = false; }
      if (!clientSettled) status = "unknown";
    }
    if (signal.aborted) status = "unknown";
    if (clientSettled) {
      try { await lease?.release(); } catch { status = "unknown"; }
      try { restoreFence?.(); } catch { status = "unknown"; }
      if (status !== "unknown" && releaseLock) {
        try { await releaseLock(); lockPreserved = false; } catch { status = "unknown"; }
      }
    }
    if (credentials) { credentials.apiHash = ""; credentials.passphrase = ""; credentials.apiId = 0; }
  }
  return result(status, lockPreserved, clientSettled);
}

/** Actual foreground implementation. Root supplies an external owned-process deadline
 * as well: AbortSignal does not cancel GramJS I/O. No plaintext exceptions are printed. */
export async function runPilotGreeting(paths: GreetingPaths): Promise<GreetingResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15 * 60 * 1000);
  const onInterrupt = () => abort.abort(); process.once("SIGINT", onInterrupt);
  const ports: GreetingPorts = {
    prepare: preparePilotGreeting, absent: requireAbsent, acquireLock: acquireProcessLock,
    async prompt() { return { apiId: Number(await ask("Telegram api_id: ")), apiHash: await askHidden("Telegram api_hash: "), passphrase: await askHidden("Session encryption passphrase: ") }; },
    openSession: (reference, passphrase) => openExistingEncryptedSessionLease({ reference, passphrase }),
    createClient(material, credentials) {
      const client = new TelegramClient(new StringSession(material), credentials.apiId, credentials.apiHash, {
        ...clientOptions(), baseLogger: new Logger(LogLevel.NONE), requestRetries: 1, connectionRetries: 1, reconnectRetries: 0, autoReconnect: false,
      });
      client.setLogLevel(LogLevel.NONE);
      client.onError = async () => { abort.abort(); };
      return client;
    },
    installFence: client => installBindingNetworkFence(client as TelegramClient, () => {
      process.stdout.write("PILOT_GREETING_UNKNOWN\n"); process.exit(74);
    }),
    createAdapter: createPilotTelegramAdapter, createStore: createEncryptedPilotStore, dispatch: runPilotReply, killed: greetingKillSwitchEngaged,
    async settle(client) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([client.destroy().then(() => true, () => false), new Promise<false>(done => { deadline = setTimeout(() => done(false), 5000); })]); }
      finally { if (deadline) clearTimeout(deadline); }
    },
  };
  try { return await runPilotGreetingWithPorts(paths, ports, abort.signal); }
  finally { clearTimeout(timer); process.removeListener("SIGINT", onInterrupt); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) refuse();
    const value = await runPilotGreeting(normalizeGreetingPaths(JSON.parse(process.argv[2]!)));
    process.stdout.write(`${value.code}\n`);
    process.exitCode = value.status === "verified" ? 0 : value.status === "unknown" ? 74 : 1;
  } catch { process.stdout.write("PILOT_GREETING_REFUSED\n"); process.exitCode = 1; }
}
