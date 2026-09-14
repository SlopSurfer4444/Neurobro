import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { ask, askHidden } from "./prompt.js";
import { acquireProcessLock } from "./process-lock.js";
import { openExistingEncryptedSessionLease, type GatewayExistingEncryptedSessionLease } from "./existing-session-lease.js";
import { clientOptions } from "./telegram-client.js";
import { installBindingNetworkFence } from "./binding-network-fence.js";
import { preparePilotGreeting, normalizeGreetingPaths, greetingKillSwitchEngaged,
  type GreetingPaths, type GreetingPrepared, type GreetingCredentials, type GreetingClient, type GreetingPorts } from "./pilot-greeting.js";
import { assertPilotPrivateDirectory, createEncryptedPilotStore, runPilotReply } from "./pilot-outbox.js";
import { createConversationAdapter } from "./pilot-conversation-adapter.js";

export type ConversationPaths = GreetingPaths & Readonly<{ modelAttemptDirectory: string }>;
export type ConversationPrepared = GreetingPrepared & Readonly<{ modelAttemptDirectory: string }>;
export type ConversationModelResult = Readonly<{ answer: string | null; receipt: unknown }>;
/** Only the selected literal text crosses this application-data boundary.
 * The caller closes over its source-bound model packet and private attempt path. */
export type ConversationModel = (text: string, signal: AbortSignal) => Promise<ConversationModelResult>;
/** Persistence is never enabled by default. The caller may supply a verified
 * credential hook only after the owner's explicit choice to save credentials. */
export type ConversationCredentialOptions = Readonly<{
  credentials?: () => Promise<GreetingCredentials>;
  credentialsVerified?: (credentials: GreetingCredentials) => Promise<void>;
}>;
export type ConversationStatus = "verified" | "refused" | "unknown";
export type ConversationCode = "PILOT_CONVERSATION_VERIFIED" | "PILOT_CONVERSATION_REFUSED" | "PILOT_CONVERSATION_UNKNOWN";
export type ConversationResult = Readonly<{ status: ConversationStatus; code: ConversationCode; lockPreserved: boolean; clientSettled: boolean }>;
export interface ConversationPorts extends Omit<GreetingPorts, "prepare" | "createAdapter"> {
  prepare(paths: ConversationPaths): Promise<ConversationPrepared>;
  createAdapter: typeof createConversationAdapter;
  model: ConversationModel;
  credentialsVerified?(credentials: GreetingCredentials): Promise<void>;
  now(): number;
  notify(code: ConversationCode | "PILOT_CONVERSATION_WAITING" | "PILOT_CONVERSATION_MODEL"): void;
}
const refuse = (): never => { throw new Error("PILOT_CONVERSATION_REFUSED"); };
async function absent(path: string): Promise<void> {
  try { await lstat(path); return refuse(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function normalizeConversationPaths(raw: ConversationPaths): ConversationPaths {
  if (!raw || typeof raw !== "object" || Object.keys(raw).sort().join("|") !==
      ["authConfigPath", "bindingPath", "modelReceiptPath", "attemptDirectory", "killSwitchPath", "modelAttemptDirectory"].sort().join("|")) return refuse();
  const { modelAttemptDirectory, ...five } = raw;
  const greeting = normalizeGreetingPaths(five);
  if (typeof modelAttemptDirectory !== "string" || !isAbsolute(modelAttemptDirectory)) return refuse();
  const modelPath = resolve(modelAttemptDirectory);
  if (Object.values(greeting).includes(modelPath) || modelPath === dirname(greeting.authConfigPath)) return refuse();
  return Object.freeze({ ...greeting, modelAttemptDirectory: modelPath });
}
/** The model attempt has its own root-owned protected parent. It is deliberately
 * excluded from the greeting's same-parent rule and never created by preparation. */
export async function preparePilotConversation(raw: ConversationPaths): Promise<ConversationPrepared> {
  const { modelAttemptDirectory, ...five } = normalizeConversationPaths(raw);
  const prepared = await preparePilotGreeting(five);
  if ([prepared.ownerLock, prepared.config.account.sessionFile].includes(modelAttemptDirectory)) return refuse();
  await assertPilotPrivateDirectory(dirname(modelAttemptDirectory));
  await absent(modelAttemptDirectory);
  return Object.freeze({ ...prepared, modelAttemptDirectory });
}
function textValid(text: unknown): text is string {
  return typeof text === "string" && !!text.trim() && !text.includes("\0") &&
    Buffer.byteLength(text) <= 4096 && Buffer.from(text, "utf8").toString("utf8") === text;
}
export function completedModelAnswer(value: ConversationModelResult): string | null {
  if (!value || !textValid(value.answer) || !value.receipt || typeof value.receipt !== "object") return null;
  const r = value.receipt as Record<string, unknown>;
  if (r.version !== "modeltext-host-v1" || r.outcome !== "observed" || r.exitCode !== 0 ||
      r.transportError !== false || r.timedOut !== false || r.aborted !== false || r.overflow !== false ||
      !["guestSettled", "clientSettled", "relaySettled", "custodyReady", "appServerSettled", "turnCompleted"].every(k => r[k] === true) ||
      r.answerBytes !== Buffer.byteLength(value.answer)) return null;
  return value.answer;
}
function checked(signal: AbortSignal): void { if (signal.aborted) refuse(); }
function interrupted<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  checked(signal);
  return new Promise<T>((done, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("PILOT_CONVERSATION_ABORTED")); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { checked(signal); return operation(); }).then(done, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function result(status: ConversationStatus, lockPreserved: boolean, clientSettled: boolean): ConversationResult {
  return Object.freeze({ status, code: status === "verified" ? "PILOT_CONVERSATION_VERIFIED" : status === "refused" ? "PILOT_CONVERSATION_REFUSED" : "PILOT_CONVERSATION_UNKNOWN", lockPreserved, clientSettled });
}

/** Exactly one fresh trigger, one model callback, and one guarded anchored reply.
 * An unresolved model call preserves the Telegram owner lock as well. */
export async function runPilotConversationWithPorts(paths: ConversationPaths, ports: ConversationPorts, signal: AbortSignal): Promise<ConversationResult> {
  let releaseLock: (() => Promise<void>) | undefined, restoreFence: (() => void) | undefined;
  let lease: GatewayExistingEncryptedSessionLease | undefined, credentials: GreetingCredentials | undefined, client: GreetingClient | undefined;
  let status: ConversationStatus = "refused", lockPreserved = false, clientSettled = true, connectionAttempted = false;
  const notify = (code: Parameters<ConversationPorts["notify"]>[0]) => { try { ports.notify(code); } catch { /* No private fallback logging. */ } };
  try {
    const prepared = await interrupted(signal, () => ports.prepare(paths));
    checked(signal);
    releaseLock = await ports.acquireLock(prepared.ownerLock); lockPreserved = true;
    credentials = await interrupted(signal, () => ports.prompt());
    if (!Number.isSafeInteger(credentials.apiId) || credentials.apiId < 1 || !/^[a-fA-F0-9]{32}$/.test(credentials.apiHash) || credentials.passphrase.length < 16) refuse();
    lease = await ports.openSession(prepared.config.account.sessionFile, credentials.passphrase);
    checked(signal);
    await ports.absent(prepared.paths.attemptDirectory);
    await ports.absent(prepared.modelAttemptDirectory);
    if (ports.killed(prepared.paths.killSwitchPath)) refuse();
    client = ports.createClient(lease.material.value, credentials);
    restoreFence = ports.installFence(client);
    const owned = client;
    connectionAttempted = true; clientSettled = false;
    await interrupted(signal, () => owned.connect());
    const self = await interrupted(signal, () => owned.getMe());
    const startedAt = Math.floor(ports.now() / 1000);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) refuse();
    const adapter = await interrupted(signal, () => ports.createAdapter({ client: owned, binding: prepared.binding, self, signal, startedAt }));
    const credentialsVerified = ports.credentialsVerified;
    if (credentialsVerified) {
      const verifiedCredentials = credentials;
      await interrupted(signal, () => credentialsVerified(verifiedCredentials));
    }
    notify("PILOT_CONVERSATION_WAITING");
    const waiting = new AbortController(), waitSignal = AbortSignal.any([signal, waiting.signal]);
    const waitDeadline = setTimeout(() => waiting.abort(), 90_000);
    let primary: Awaited<ReturnType<typeof adapter.waitForPrompt>>;
    try { primary = await interrupted(waitSignal, () => adapter.waitForPrompt(waitSignal)); }
    finally { clearTimeout(waitDeadline); }
    checked(signal);
    if (primary.chatId !== prepared.binding.peerId || !/^[1-9]\d{0,19}$/.test(primary.ownerId) ||
        primary.ownerId === prepared.binding.accountId || !Number.isSafeInteger(primary.messageId) || primary.messageId < 1 ||
        primary.messageId > 2147483647 || !textValid(primary.text)) refuse();
    await ports.absent(prepared.modelAttemptDirectory);
    if (ports.killed(prepared.paths.killSwitchPath)) refuse();
    notify("PILOT_CONVERSATION_MODEL");
    const model = await interrupted(signal, () => ports.model(primary.text, signal));
    checked(signal);
    const answer = completedModelAnswer(model);
    if (answer === null) { status = "unknown"; }
    else {
      const verdict = await ports.dispatch({
        approved: { chatId: prepared.binding.peerId, accountId: prepared.binding.accountId, replyToMessageId: primary.messageId, maximumTextBytes: 4096 },
        reply: { chatId: prepared.binding.peerId, replyToMessageId: primary.messageId, text: answer },
        store: ports.createStore(prepared.paths.attemptDirectory, credentials.passphrase), transport: adapter.transport,
        killSwitchEngaged: () => ports.killed(prepared.paths.killSwitchPath), signal,
      });
      status = verdict.state === "verified" ? "verified" : verdict.state === "unknown" ? "unknown" : "refused";
    }
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
  const outcome = result(status, lockPreserved, clientSettled);
  notify(outcome.code);
  return outcome;
}

/** Caller supplies the source-bound model closure and an external 15-minute
 * owned-process deadline. No primary text is accepted from CLI arguments. */
export async function runPilotConversation(paths: ConversationPaths, model: ConversationModel, options: ConversationCredentialOptions = {}): Promise<ConversationResult> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15 * 60 * 1000);
  const onInterrupt = () => abort.abort(); process.once("SIGINT", onInterrupt);
  const ports: ConversationPorts = {
    prepare: preparePilotConversation, absent, acquireLock: acquireProcessLock,
    prompt: options.credentials ?? (async () => ({ apiId: Number(await ask("Telegram api_id: ")), apiHash: await askHidden("Telegram api_hash: "), passphrase: await askHidden("Session encryption passphrase: ") })),
    ...(options.credentialsVerified ? { credentialsVerified: options.credentialsVerified } : {}),
    openSession: (reference, passphrase) => openExistingEncryptedSessionLease({ reference, passphrase }),
    createClient(material, credentials) {
      const client = new TelegramClient(new StringSession(material), credentials.apiId, credentials.apiHash, {
        ...clientOptions(), baseLogger: new Logger(LogLevel.NONE), requestRetries: 1, connectionRetries: 1, reconnectRetries: 0, autoReconnect: false,
      });
      client.setLogLevel(LogLevel.NONE); client.onError = async () => { abort.abort(); };
      return client;
    },
    installFence: client => installBindingNetworkFence(client as TelegramClient, () => { process.stdout.write("PILOT_CONVERSATION_UNKNOWN\n"); process.exit(74); }),
    createAdapter: createConversationAdapter, createStore: createEncryptedPilotStore, dispatch: runPilotReply, killed: greetingKillSwitchEngaged,
    model, now: Date.now, notify: code => { process.stdout.write(code === "PILOT_CONVERSATION_WAITING"
      ? "PILOT_CONVERSATION_WAITING — напиши в группе новое сообщение, начинающееся с ПРОМПТ.\n" : `${code}\n`); },
    async settle(client) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([client.destroy().then(() => true, () => false), new Promise<false>(done => { deadline = setTimeout(() => done(false), 5000); })]); }
      finally { if (deadline) clearTimeout(deadline); }
    },
  };
  try { return await runPilotConversationWithPorts(paths, ports, abort.signal); }
  finally { clearTimeout(timer); process.removeListener("SIGINT", onInterrupt); }
}
