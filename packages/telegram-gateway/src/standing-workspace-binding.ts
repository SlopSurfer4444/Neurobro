import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import { Api, TelegramClient, utils } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";
import { parseAuthConfig, type AuthConfig } from "./auth-config.js";
import { installBindingNetworkFence } from "./binding-network-fence.js";
import { openExistingEncryptedSessionLease, type GatewayExistingEncryptedSessionLease } from "./existing-session-lease.js";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { acquireProcessLock } from "./process-lock.js";
import { clientOptions } from "./telegram-client.js";
import { createWindowsCredentialVault } from "./windows-credential-vault.js";

const REFUSED = "STANDING_WORKSPACE_BINDING_REFUSED";
const OUTPUT_NAME = "gateway-binding.json";
const JSON_CAP = 8_192;
const SESSION_CAP = 65_536;

export type StandingWorkspaceBindingInput = Readonly<{
  authConfigPath: string;
  previousBindingPath: string;
  vaultPath: string;
  appRoot: string;
  workspaceId: string;
  title: string;
  signal: AbortSignal;
}>;

export type StandingWorkspaceBindingTarget = Readonly<{
  workspaceId: string;
  accountId: string;
  peerId: string;
  title: string;
}>;

export type StandingWorkspaceBindingRecord = Readonly<StandingWorkspaceBindingTarget & {
  version: "telegram-workspace-binding-v1";
  sessionReference: string;
  ownerLock: string;
  checkedAt: string;
  serving: false;
}>;

type PreparedBinding = Readonly<{
  workspaceId: string;
  title: string;
  expectedAccountId: string;
  sessionReference: string;
  ownerLock: string;
  outputPath: string;
  vaultPath: string;
}>;
type BindingCredentials = { apiId: number; apiHash: string; passphrase: string };
type BindingAccount = Readonly<{ id: string; usable: boolean }>;
export type StandingWorkspaceBindingDialog = Readonly<{ id: string; title: string; usable: boolean }>;
type BindingClient = Readonly<{
  connect(): Promise<unknown>;
  getMe(): Promise<Api.User>;
  invoke(request: Api.messages.GetDialogs): Promise<unknown>;
  destroy(): Promise<unknown>;
}>;

export interface StandingWorkspaceBindingPorts {
  prepare(input: StandingWorkspaceBindingInput): Promise<PreparedBinding>;
  acquireLock(path: string): Promise<() => Promise<void>>;
  loadCredentials(path: string): Promise<BindingCredentials>;
  openSession(reference: string, passphrase: string): Promise<GatewayExistingEncryptedSessionLease>;
  createClient(material: string, credentials: BindingCredentials): BindingClient;
  installFence(client: BindingClient): () => void;
  connect(client: BindingClient): Promise<void>;
  account(client: BindingClient): Promise<BindingAccount>;
  dialogs(client: BindingClient): Promise<readonly StandingWorkspaceBindingDialog[]>;
  settle(client: BindingClient, admitted: readonly Promise<unknown>[]): Promise<boolean>;
  save(path: string, binding: StandingWorkspaceBindingRecord): Promise<void>;
  now(): string;
}

const refuse = (): never => { throw new Error(REFUSED); };
const missing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
const inside = (child: string, parent: string): boolean => {
  const suffix = relative(parent, child);
  return suffix.length > 0 && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
const validAccountId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value);
const validPeerId = (value: unknown): value is string => typeof value === "string" && /^-[1-9]\d{0,19}$/u.test(value);
const validTitle = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const absolutePath = (value: unknown): string => {
  if (typeof value !== "string" || !isAbsolute(value)) return refuse();
  return resolve(value);
};

function plainRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) return refuse();
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) result[key] = descriptor.value;
  if (!exactKeys(result, expected)) return refuse();
  return result;
}

async function privateJson(path: string): Promise<unknown> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(JSON_CAP)) return refuse();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return refuse();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || bytes.length !== Number(opened.size) ||
        !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) return refuse();
    try { return JSON.parse(bytes.toString("utf8")); } catch { return refuse(); }
  } finally { await handle.close(); }
}

async function requireAbsent(path: string): Promise<void> {
  try { await lstat(path); return refuse(); }
  catch (error) { if (!missing(error)) throw error; }
}

async function prepareBinding(input: StandingWorkspaceBindingInput): Promise<PreparedBinding> {
  const raw = plainRecord(input, ["authConfigPath", "previousBindingPath", "vaultPath", "appRoot", "workspaceId", "title", "signal"]);
  const authConfigPath = absolutePath(raw.authConfigPath);
  const previousBindingPath = absolutePath(raw.previousBindingPath);
  const vaultPath = absolutePath(raw.vaultPath);
  const appRoot = absolutePath(raw.appRoot);
  if (typeof raw.workspaceId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(raw.workspaceId) || !validTitle(raw.title) ||
      !(raw.signal instanceof AbortSignal)) return refuse();
  const custodyRoot = dirname(authConfigPath);
  if (dirname(previousBindingPath) !== custodyRoot || dirname(vaultPath) !== custodyRoot ||
      basename(vaultPath) !== "windows-credentials-v1.json" ||
      appRoot === custodyRoot || inside(appRoot, custodyRoot) || inside(custodyRoot, appRoot)) return refuse();
  await assertPilotPrivateDirectory(custodyRoot);
  await assertPilotPrivateDirectory(appRoot);
  const outputPath = join(appRoot, OUTPUT_NAME);
  await requireAbsent(outputPath);

  const config: AuthConfig = parseAuthConfig(await privateJson(authConfigPath), authConfigPath);
  const sessionReference = resolve(config.account.sessionFile);
  if (!isAbsolute(config.account.sessionFile) || dirname(sessionReference) !== custodyRoot ||
      [authConfigPath, previousBindingPath, vaultPath].includes(sessionReference)) return refuse();
  const session = await lstat(sessionReference, { bigint: true });
  if (!session.isFile() || session.isSymbolicLink() || session.nlink !== 1n || session.size < 1n || session.size > BigInt(SESSION_CAP)) return refuse();
  const ownerLock = `${sessionReference}.owner.lock`;
  const previous = plainRecord(await privateJson(previousBindingPath), ["version", "accountId", "peerId", "title", "sessionReference", "ownerLock", "checkedAt", "serving"]);
  if (previous.version !== "telegram-account-binding-v1" || !validAccountId(previous.accountId) || !validPeerId(previous.peerId) ||
      !validTitle(previous.title) || typeof previous.sessionReference !== "string" || !isAbsolute(previous.sessionReference) ||
      resolve(previous.sessionReference) !== sessionReference || previous.ownerLock !== ownerLock || previous.serving !== false ||
    typeof previous.checkedAt !== "string" || !Number.isFinite(Date.parse(previous.checkedAt))) return refuse();
  return Object.freeze({ workspaceId: raw.workspaceId, title: raw.title, expectedAccountId: previous.accountId,
    sessionReference, ownerLock, outputPath, vaultPath });
}

function checked(signal: AbortSignal): void { if (signal.aborted) return refuse(); }
async function interruptible<T>(admitted: Set<Promise<unknown>>, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  checked(signal);
  const pending = Promise.resolve().then(() => { checked(signal); return operation(); });
  admitted.add(pending);
  void pending.then(() => admitted.delete(pending), () => admitted.delete(pending));
  return new Promise<T>((done, reject) => {
    const abort = () => reject(new Error(REFUSED));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(done, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function validateCredentials(value: BindingCredentials): void {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Number.isSafeInteger(value.apiId) || value.apiId < 1 ||
      value.apiId > 2_147_483_647 || typeof value.apiHash !== "string" || !/^[a-fA-F0-9]{32}$/u.test(value.apiHash) ||
      typeof value.passphrase !== "string" || value.passphrase.length < 16 || value.passphrase.includes("\0")) return refuse();
}

/** Pure one-client lifecycle. Saving is deliberately outside the client/lease/lock lifetime. */
export async function bindStandingWorkspaceWithPorts(
  input: StandingWorkspaceBindingInput,
  ports: StandingWorkspaceBindingPorts,
): Promise<StandingWorkspaceBindingTarget> {
  let releaseLock: (() => Promise<void>) | undefined;
  let lease: GatewayExistingEncryptedSessionLease | undefined;
  let credentials: BindingCredentials | undefined;
  let client: BindingClient | undefined;
  let restoreFence: (() => void) | undefined;
  let target: StandingWorkspaceBindingTarget | undefined;
  let failed = false;
  let clientSettled = true;
  let cleanupSettled = true;
  let prepared: PreparedBinding | undefined;
  const admitted = new Set<Promise<unknown>>();
  try {
    prepared = await ports.prepare(input);
    checked(input.signal);
    releaseLock = await ports.acquireLock(prepared.ownerLock);
    checked(input.signal);
    credentials = await ports.loadCredentials(prepared.vaultPath);
    validateCredentials(credentials);
    lease = await ports.openSession(prepared.sessionReference, credentials.passphrase);
    checked(input.signal);
    client = ports.createClient(lease.material.value, credentials);
    clientSettled = false;
    restoreFence = ports.installFence(client);
    await interruptible(admitted, input.signal, () => ports.connect(client!));
    const account = await interruptible(admitted, input.signal, () => ports.account(client!));
    if (!account.usable || !validAccountId(account.id) || account.id !== prepared.expectedAccountId) return refuse();
    const dialogs = await interruptible(admitted, input.signal, () => ports.dialogs(client!));
    if (!Array.isArray(dialogs) || dialogs.length > 100) return refuse();
    const matches = dialogs.filter(dialog => dialog.title === prepared!.title);
    if (matches.length !== 1) return refuse();
    const selected = matches[0]!;
    if (!selected.usable || !validPeerId(selected.id) || !validTitle(selected.title)) return refuse();
    target = Object.freeze({ workspaceId: prepared.workspaceId, accountId: account.id, peerId: selected.id, title: prepared.title });
  } catch { failed = true; }
  finally {
    if (client) {
      try { clientSettled = await ports.settle(client, [...admitted]); } catch { clientSettled = false; }
      if (!clientSettled) cleanupSettled = false;
    }
    if (clientSettled) {
      try { await lease?.release(); } catch { cleanupSettled = false; }
      if (cleanupSettled) { try { restoreFence?.(); } catch { cleanupSettled = false; } }
      if (cleanupSettled && releaseLock) { try { await releaseLock(); } catch { cleanupSettled = false; } }
    }
    if (credentials) { credentials.apiId = 0; credentials.apiHash = ""; credentials.passphrase = ""; }
  }
  if (failed || !clientSettled || !cleanupSettled || input.signal.aborted || !prepared || !target) return refuse();
  const checkedAt = ports.now();
  if (typeof checkedAt !== "string" || !Number.isFinite(Date.parse(checkedAt))) return refuse();
  const binding: StandingWorkspaceBindingRecord = Object.freeze({ version: "telegram-workspace-binding-v1", ...target,
    sessionReference: prepared.sessionReference, ownerLock: prepared.ownerLock, checkedAt, serving: false });
  try { await ports.save(prepared.outputPath, binding); }
  catch { return refuse(); }
  return target;
}

/** One bounded dialog response. Raw top messages and users are discarded before return. */
export async function readStandingWorkspaceBindingDialogs(client: BindingClient): Promise<readonly StandingWorkspaceBindingDialog[]> {
  const envelope = await client.invoke(new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0,
    offsetPeer: new Api.InputPeerEmpty(), limit: 100, hash: bigInt.zero }));
  try {
    if (!envelope || typeof envelope !== "object" || !("dialogs" in envelope) || !("chats" in envelope) ||
        !Array.isArray(envelope.dialogs) || !Array.isArray(envelope.chats) || envelope.dialogs.length > 100) return refuse();
    const dialogIds = new Set(envelope.dialogs.filter(dialog => dialog instanceof Api.Dialog).map(dialog => utils.getPeerId(dialog.peer)));
    return Object.freeze(envelope.chats.filter(entity => {
      try { return dialogIds.has(utils.getPeerId(entity)); } catch { return false; }
    }).map(entity => {
      if (entity instanceof Api.Chat) return Object.freeze({ id: utils.getPeerId(entity), title: entity.title,
        usable: !entity.left && !entity.deactivated && !entity.migratedTo });
      if (entity instanceof Api.Channel) return Object.freeze({ id: utils.getPeerId(entity), title: entity.title,
        usable: !entity.left && Boolean(entity.megagroup || entity.gigagroup) && !entity.min && Boolean(entity.accessHash) &&
          entity.accessHash!.neq(bigInt.zero) && !entity.bannedRights?.viewMessages });
      return Object.freeze({ id: "", title: "title" in entity && typeof entity.title === "string" ? entity.title : "", usable: false });
    }));
  } finally {
    if (envelope && typeof envelope === "object") {
      if ("messages" in envelope && Array.isArray(envelope.messages)) envelope.messages.length = 0;
      if ("users" in envelope && Array.isArray(envelope.users)) envelope.users.length = 0;
      if ("chats" in envelope && Array.isArray(envelope.chats)) envelope.chats.length = 0;
    }
  }
}

async function settleClient(client: BindingClient, admitted: readonly Promise<unknown>[]): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const destroyed = client.destroy().then(() => true, () => false);
    const joined = Promise.allSettled(admitted);
    return await Promise.race([
      Promise.all([destroyed, joined]).then(([destroyedSuccessfully]) => destroyedSuccessfully),
      new Promise<false>(done => { timer = setTimeout(() => done(false), 5_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function writeBinding(path: string, binding: StandingWorkspaceBindingRecord): Promise<void> {
  const parent = dirname(path);
  await assertPilotPrivateDirectory(parent);
  const before = await lstat(parent, { bigint: true });
  const bytes = Buffer.from(JSON.stringify(binding), "utf8");
  if (bytes.length < 1 || bytes.length > JSON_CAP) return refuse();
  const handle = await open(path, "wx", 0o600);
  let created: BigIntStats;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    created = await handle.stat({ bigint: true });
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1n || created.size !== BigInt(bytes.length)) return refuse();
  } finally { await handle.close(); }
  const after = await lstat(parent, { bigint: true });
  const named = await lstat(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1n ||
      named.dev !== created.dev || named.ino !== created.ino || named.size !== created.size) return refuse();
  const readback = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await readback.stat({ bigint: true });
    if (opened.dev !== created.dev || opened.ino !== created.ino || opened.size !== created.size ||
        !Buffer.from(await readback.readFile()).equals(bytes)) return refuse();
  } finally { await readback.close(); }
}

const actualPorts: StandingWorkspaceBindingPorts = {
  prepare: prepareBinding,
  acquireLock: acquireProcessLock,
  async loadCredentials(path) { return { ...await createWindowsCredentialVault({ path }).load() }; },
  openSession: (reference, passphrase) => openExistingEncryptedSessionLease({ reference, passphrase }),
  createClient(material, credentials) {
    const client = new TelegramClient(new StringSession(material), credentials.apiId, credentials.apiHash, {
      ...clientOptions(), baseLogger: new Logger(LogLevel.NONE), requestRetries: 1, connectionRetries: 1,
      reconnectRetries: 0, autoReconnect: false,
    });
    client.setLogLevel(LogLevel.NONE);
    return client as BindingClient;
  },
  installFence(client) { return installBindingNetworkFence(client as TelegramClient, () => refuse()); },
  async connect(client) { await client.connect(); },
  async account(client) {
    const self = await client.getMe();
    return Object.freeze({ id: self.id.toString(), usable: Boolean(self.self && !self.bot && !self.deleted) });
  },
  dialogs: readStandingWorkspaceBindingDialogs,
  settle: settleClient,
  save: writeBinding,
  now: () => new Date().toISOString(),
};
Object.freeze(actualPorts);

/**
 * Reuses an existing encrypted session and DPAPI vault to bind one fresh standing
 * workspace. It reads no conversation history, sends nothing and starts no runtime.
 * The caller separately verifies the protected ACL of both parent directories.
 */
export async function bindStandingWorkspace(input: StandingWorkspaceBindingInput): Promise<StandingWorkspaceBindingTarget> {
  try { return await bindStandingWorkspaceWithPorts(input, actualPorts); }
  catch { return refuse(); }
}
