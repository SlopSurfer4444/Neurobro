import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";

export type StandingCommunitySettingsEvidence = Readonly<{
  actorId: string;
  messageId: number;
  requestRef: string;
  changedAt: number;
}>;

export type StandingCommunityPolicy = Readonly<{
  revision: number;
  observationEnabled: boolean;
  alertsEnabled: boolean;
  alertGuidance: string;
  minAlertIntervalSeconds: number;
  observedSourcePeerId: string;
  lastChanged: StandingCommunitySettingsEvidence | null;
}>;

export type StandingCommunitySettingsUpdate = Readonly<{
  expectedRevision: number;
  observationEnabled: boolean;
  alertsEnabled: boolean;
  alertGuidance: string;
  minAlertIntervalSeconds: number;
  evidence: StandingCommunitySettingsEvidence;
}>;

export type StandingCommunitySettingsStore = Readonly<{
  /** Refreshes the fixed record before returning the active immutable policy. */
  policy(): Promise<StandingCommunityPolicy>;
  /** Full-state CAS. Disabling observation also disables alerts in one record. */
  update(input: StandingCommunitySettingsUpdate): Promise<StandingCommunityPolicy>;
  close(): Promise<void>;
}>;

export class StandingCommunitySettingsError extends Error {
  constructor(readonly code: "input" | "binding" | "conflict" | "storage" | "closed") {
    super("STANDING_COMMUNITY_SETTINGS_" + code.toUpperCase());
    this.name = "StandingCommunitySettingsError";
  }
}

const DOMAIN = "DecadansNeurobro/standing-community-settings/v1";
const FILE = "community-settings.enc";
const MAX_PLAIN = 8 * 1024;
const MAX_CIPHER = 32 * 1024;
const MAX_GUIDANCE_BYTES = 2048;
const DEFAULT_INTERVAL_SECONDS = 1800;
const ACCOUNT = /^[1-9]\d{0,19}$/u;
const PEER = /^-[1-9]\d{0,19}$/u;
const WORKSPACE = /^[a-z][a-z0-9_-]{0,127}$/u;
const REFERENCE = /^\S{1,256}$/u;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const fail = (code: StandingCommunitySettingsError["code"]): never => { throw new StandingCommunitySettingsError(code); };
const sameDirectory = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino;
const stamp = (value: BigIntStats): string => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.nlink].join(":");

type Namespace = Readonly<{
  directory: string;
  workspaceId: string;
  accountId: string;
  internalPeerId: string;
  observedSourcePeerId: string;
}>;

type PersistedSettings = Readonly<{
  domain: typeof DOMAIN;
  workspaceId: string;
  binding: Readonly<{ accountId: string; internalPeerId: string; observedSourcePeerId: string }>;
  revision: number;
  observationEnabled: boolean;
  alertsEnabled: boolean;
  alertGuidance: string;
  minAlertIntervalSeconds: number;
  lastChanged: StandingCommunitySettingsEvidence | null;
}>;

function data(value: unknown, required: readonly string[], code: StandingCommunitySettingsError["code"]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.length !== required.length ||
      keys.some(key => typeof key !== "string" || !required.includes(key)) ||
      Object.values(descriptors).some(descriptor => !("value" in descriptor) || !descriptor.enumerable)) return fail(code);
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
function validMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2147483647;
}
function validChangedAt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 253402300799;
}
function validInterval(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 60 && Number(value) <= 86400;
}
function validGuidance(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_GUIDANCE_BYTES &&
    Buffer.from(value, "utf8").toString("utf8") === value && !UNSAFE_TEXT.test(value) &&
    (value.length === 0 || value.trim() === value);
}

function evidenceCopy(value: unknown, code: StandingCommunitySettingsError["code"]): StandingCommunitySettingsEvidence {
  const item = data(value, ["actorId", "messageId", "requestRef", "changedAt"], code);
  if (typeof item.actorId !== "string" || !ACCOUNT.test(item.actorId) || !validMessageId(item.messageId) ||
      typeof item.requestRef !== "string" || !REFERENCE.test(item.requestRef) || Buffer.byteLength(item.requestRef, "utf8") > 256 ||
      Buffer.from(item.requestRef, "utf8").toString("utf8") !== item.requestRef || !validChangedAt(item.changedAt)) return fail(code);
  return Object.freeze({ actorId: item.actorId, messageId: item.messageId, requestRef: item.requestRef, changedAt: item.changedAt });
}

function namespaceCopy(value: unknown): Namespace & { passphrase: string } {
  const input = data(value, ["directory", "passphrase", "workspaceId", "accountId", "internalPeerId", "observedSourcePeerId"], "input");
  if (typeof input.directory !== "string" || input.directory.length > 32768 || !isAbsolute(input.directory) ||
      resolve(input.directory) !== input.directory || dirname(input.directory) === input.directory ||
      typeof input.passphrase !== "string" || input.passphrase.length < 16 || input.passphrase.length > 4096 ||
      input.passphrase.includes("\0") || Buffer.byteLength(input.passphrase, "utf8") > 4096 || Buffer.from(input.passphrase, "utf8").toString("utf8") !== input.passphrase ||
      typeof input.workspaceId !== "string" || !WORKSPACE.test(input.workspaceId) ||
      typeof input.accountId !== "string" || !ACCOUNT.test(input.accountId) ||
      typeof input.internalPeerId !== "string" || !PEER.test(input.internalPeerId) ||
      typeof input.observedSourcePeerId !== "string" || !PEER.test(input.observedSourcePeerId) ||
      input.observedSourcePeerId === input.internalPeerId) return fail("input");
  return input as Namespace & { passphrase: string };
}

function policyView(value: PersistedSettings): StandingCommunityPolicy {
  return Object.freeze({ revision: value.revision, observationEnabled: value.observationEnabled,
    alertsEnabled: value.alertsEnabled, alertGuidance: value.alertGuidance,
    minAlertIntervalSeconds: value.minAlertIntervalSeconds, observedSourcePeerId: value.binding.observedSourcePeerId,
    lastChanged: value.lastChanged });
}

function defaultSettings(namespace: Namespace): PersistedSettings {
  return Object.freeze({ domain: DOMAIN, workspaceId: namespace.workspaceId,
    binding: Object.freeze({ accountId: namespace.accountId, internalPeerId: namespace.internalPeerId,
      observedSourcePeerId: namespace.observedSourcePeerId }), revision: 1, observationEnabled: true,
    alertsEnabled: false, alertGuidance: "", minAlertIntervalSeconds: DEFAULT_INTERVAL_SECONDS, lastChanged: null });
}

function persistedCopy(value: unknown, namespace: Namespace): PersistedSettings {
  const item = data(value, ["domain", "workspaceId", "binding", "revision", "observationEnabled", "alertsEnabled",
    "alertGuidance", "minAlertIntervalSeconds", "lastChanged"], "storage");
  const binding = data(item.binding, ["accountId", "internalPeerId", "observedSourcePeerId"], "storage");
  if (item.domain !== DOMAIN || item.workspaceId !== namespace.workspaceId || binding.accountId !== namespace.accountId ||
      binding.internalPeerId !== namespace.internalPeerId || binding.observedSourcePeerId !== namespace.observedSourcePeerId) return fail("binding");
  if (!validRevision(item.revision) || typeof item.observationEnabled !== "boolean" || typeof item.alertsEnabled !== "boolean" ||
      item.observationEnabled === false && item.alertsEnabled === true || !validGuidance(item.alertGuidance) ||
      !validInterval(item.minAlertIntervalSeconds) || item.lastChanged !== null && typeof item.lastChanged !== "object") return fail("storage");
  const lastChanged = item.lastChanged === null ? null : evidenceCopy(item.lastChanged, "storage");
  if (item.revision === 1) {
    if (item.observationEnabled !== true || item.alertsEnabled !== false || item.alertGuidance !== "" ||
        item.minAlertIntervalSeconds !== DEFAULT_INTERVAL_SECONDS || lastChanged !== null) return fail("storage");
  } else if (lastChanged === null) return fail("storage");
  return Object.freeze({ domain: DOMAIN, workspaceId: namespace.workspaceId,
    binding: Object.freeze({ accountId: namespace.accountId, internalPeerId: namespace.internalPeerId,
      observedSourcePeerId: namespace.observedSourcePeerId }), revision: item.revision,
    observationEnabled: item.observationEnabled, alertsEnabled: item.alertsEnabled,
    alertGuidance: item.alertGuidance, minAlertIntervalSeconds: item.minAlertIntervalSeconds, lastChanged });
}

function updateCopy(value: unknown): StandingCommunitySettingsUpdate {
  const item = data(value, ["expectedRevision", "observationEnabled", "alertsEnabled", "alertGuidance", "minAlertIntervalSeconds", "evidence"], "input");
  if (!validRevision(item.expectedRevision) || typeof item.observationEnabled !== "boolean" || typeof item.alertsEnabled !== "boolean" ||
      !validGuidance(item.alertGuidance) || !validInterval(item.minAlertIntervalSeconds)) return fail("input");
  return Object.freeze({ expectedRevision: item.expectedRevision, observationEnabled: item.observationEnabled,
    alertsEnabled: item.observationEnabled ? item.alertsEnabled : false, alertGuidance: item.alertGuidance,
    minAlertIntervalSeconds: item.minAlertIntervalSeconds, evidence: evidenceCopy(item.evidence, "input") });
}

function samePolicy(left: PersistedSettings, right: PersistedSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Opens one encrypted settings record in a dedicated directory below the
 * workspace state root. The caller chooses the workspace and both peers; no
 * model/tool input can alter this namespace. The parent ACL must already be
 * private and is rechecked together with directory and file identity.
 */
export async function openStandingCommunitySettings(inputValue: Readonly<{
  directory: string;
  passphrase: string;
  workspaceId: string;
  accountId: string;
  internalPeerId: string;
  observedSourcePeerId: string;
}>): Promise<StandingCommunitySettingsStore> {
  const copied = namespaceCopy(inputValue), namespace: Namespace = Object.freeze({ directory: copied.directory,
    workspaceId: copied.workspaceId, accountId: copied.accountId, internalPeerId: copied.internalPeerId,
    observedSourcePeerId: copied.observedSourcePeerId });
  let passphrase = copied.passphrase;
  copied.passphrase = "";
  const directory = namespace.directory, parent = dirname(directory), path = join(directory, FILE);
  let parentIdentity: BigIntStats, rootIdentity: BigIntStats | undefined, savedStamp: string | undefined;
  let current = defaultSettings(namespace), closed = false, broken = false, tail = Promise.resolve(), closing: Promise<void> | undefined;

  const directoryStat = async (name: string): Promise<BigIntStats> => {
    await assertPilotPrivateDirectory(name);
    const value = await lstat(name, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink()) return fail("storage");
    return value;
  };
  const exists = async (name: string): Promise<boolean> => {
    try { await lstat(name); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  };
  const fileStat = async (name: string): Promise<BigIntStats> => {
    const value = await lstat(name, { bigint: true });
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || value.size < 1n || value.size > BigInt(MAX_CIPHER)) return fail("storage");
    return value;
  };
  const checkParent = async (): Promise<void> => {
    const observed = await directoryStat(parent);
    if (!sameDirectory(parentIdentity, observed)) return fail("storage");
  };
  const checkDirectory = async (): Promise<boolean> => {
    await checkParent();
    if (!await exists(directory)) {
      if (rootIdentity) return fail("storage");
      return false;
    }
    const observed = await directoryStat(directory);
    if (rootIdentity && !sameDirectory(rootIdentity, observed)) return fail("storage");
    rootIdentity ??= observed;
    await checkParent();
    return true;
  };
  const inventory = async (temporary?: string): Promise<void> => {
    if (!await checkDirectory()) return;
    const allowed = new Set([...(savedStamp === undefined ? [] : [FILE]), ...(temporary ? [temporary] : [])]);
    const listing = await opendir(directory, { bufferSize: 1 });
    try {
      for (;;) {
        const entry = await listing.read();
        if (!entry) break;
        if (!entry.isFile() || entry.isSymbolicLink() || !allowed.delete(entry.name)) return fail("storage");
      }
    } finally { await listing.close(); }
    if (allowed.size !== 0) return fail("storage");
    if (savedStamp !== undefined && stamp(await fileStat(path)) !== savedStamp) return fail("storage");
    await checkParent();
  };
  const readPersisted = async (): Promise<Readonly<{ value: PersistedSettings; stat: BigIntStats }> | undefined> => {
    if (!await checkDirectory()) return;
    let before: BigIntStats;
    try { before = await fileStat(path); }
    catch (error) { if (missing(error)) return; throw error; }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer | undefined;
    try {
      const opened = await handle.stat({ bigint: true });
      if (stamp(opened) !== stamp(before)) return fail("storage");
      bytes = Buffer.alloc(Number(opened.size) + 1); let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      if (offset !== Number(opened.size) || stamp(await handle.stat({ bigint: true })) !== stamp(opened) ||
          stamp(await fileStat(path)) !== stamp(opened)) return fail("storage");
      const cipher = bytes.subarray(0, offset).toString("utf8");
      if (Buffer.byteLength(cipher, "utf8") !== offset || !bytes.subarray(0, offset).equals(Buffer.from(cipher, "utf8"))) return fail("storage");
      const plain = await decryptSession(cipher, passphrase);
      if (Buffer.byteLength(plain, "utf8") > MAX_PLAIN || Buffer.from(plain, "utf8").toString("utf8") !== plain) return fail("storage");
      let decoded: unknown;
      try { decoded = JSON.parse(plain); } catch { return fail("storage"); }
      await checkParent();
      return Object.freeze({ value: persistedCopy(decoded, namespace), stat: opened });
    } finally { bytes?.fill(0); await handle.close(); }
  };
  const refresh = async (): Promise<PersistedSettings> => {
    const loaded = await readPersisted();
    if (!loaded) {
      if (savedStamp !== undefined || current.revision !== 1) return fail("storage");
      await inventory();
      return current;
    }
    if (loaded.value.revision < current.revision || loaded.value.revision === current.revision && !samePolicy(loaded.value, current)) return fail("storage");
    current = loaded.value; savedStamp = stamp(loaded.stat);
    await inventory();
    return current;
  };
  const ensureDirectory = async (): Promise<void> => {
    if (await checkDirectory()) return;
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
    const created = await directoryStat(directory);
    if (rootIdentity && !sameDirectory(rootIdentity, created)) return fail("storage");
    rootIdentity = created;
    await checkParent();
  };
  const write = async (candidate: PersistedSettings): Promise<void> => {
    const plain = JSON.stringify(candidate);
    if (Buffer.byteLength(plain, "utf8") > MAX_PLAIN) return fail("storage");
    const cipher = await encryptSession(plain, passphrase);
    if (Buffer.byteLength(cipher, "utf8") > MAX_CIPHER) return fail("storage");
    await ensureDirectory();
    const name = "community_" + randomBytes(24).toString("hex") + ".tmp", temporary = join(directory, name);
    let moved = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      let temporaryStamp: string;
      try {
        await handle.writeFile(cipher, "utf8"); await handle.sync();
        const observed = await handle.stat({ bigint: true });
        if (!observed.isFile() || observed.nlink !== 1n || observed.size !== BigInt(Buffer.byteLength(cipher, "utf8")) ||
            stamp(await fileStat(temporary)) !== stamp(observed)) return fail("storage");
        temporaryStamp = stamp(observed);
      } finally { await handle.close(); }
      await inventory(name);
      if (savedStamp === undefined) {
        if (await exists(path)) return fail("storage");
      } else if (stamp(await fileStat(path)) !== savedStamp) return fail("storage");
      if (stamp(await fileStat(temporary)) !== temporaryStamp!) return fail("storage");
      await rename(temporary, path); moved = true;
      const loaded = await readPersisted();
      if (!loaded || !samePolicy(loaded.value, candidate)) return fail("storage");
      current = loaded.value; savedStamp = stamp(loaded.stat); await inventory();
    } finally {
      if (!moved) try { await unlink(temporary); } catch (error) { if (!missing(error)) broken = true; }
    }
  };
  const live = (): void => { if (closed) return fail("closed"); if (broken) return fail("storage"); };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    try { live(); } catch (error) { return Promise.reject(error); }
    const admitted = tail.then(operation, operation);
    tail = admitted.then(() => undefined, () => undefined);
    return admitted.catch(error => {
      if (error instanceof StandingCommunitySettingsError) throw error;
      broken = true; return fail("storage");
    });
  };

  try {
    parentIdentity = await directoryStat(parent);
    await refresh();
  } catch (error) {
    passphrase = "";
    if (error instanceof StandingCommunitySettingsError) throw error;
    return fail("storage");
  }

  return Object.freeze({
    policy() {
      return enqueue(async () => policyView(await refresh()));
    },
    update(value: StandingCommunitySettingsUpdate) {
      return enqueue(async () => {
        const input = updateCopy(value), before = await refresh();
        const replay = before.revision === input.expectedRevision + 1 && before.observationEnabled === input.observationEnabled &&
          before.alertsEnabled === input.alertsEnabled && before.alertGuidance === input.alertGuidance &&
          before.minAlertIntervalSeconds === input.minAlertIntervalSeconds &&
          JSON.stringify(before.lastChanged) === JSON.stringify(input.evidence);
        if (replay) return policyView(before);
        if (before.revision !== input.expectedRevision) return fail("conflict");
        if (before.revision >= Number.MAX_SAFE_INTEGER) return fail("storage");
        const candidate: PersistedSettings = Object.freeze({ domain: DOMAIN, workspaceId: namespace.workspaceId,
          binding: before.binding, revision: before.revision + 1, observationEnabled: input.observationEnabled,
          alertsEnabled: input.alertsEnabled, alertGuidance: input.alertGuidance,
          minAlertIntervalSeconds: input.minAlertIntervalSeconds, lastChanged: input.evidence });
        try { await write(candidate); }
        catch (error) {
          if (error instanceof StandingCommunitySettingsError && error.code === "conflict") throw error;
          broken = true; throw error;
        }
        return policyView(current);
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = tail.finally(() => { passphrase = ""; });
      return closing;
    },
  });
}
