import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";

export type StandingCommunityAlertBinding = Readonly<{
  workspaceId: string;
  accountId: string;
  internalPeerId: string;
  observedSourcePeerId: string;
}>;

export type StandingCommunityAlertPolicySnapshot = Readonly<{
  revision: number;
  observationEnabled: boolean;
  alertsEnabled: boolean;
  observedSourcePeerId: string;
}>;

export type StandingCommunityAlertReadback = Readonly<{
  messageId: number;
  chatId: string;
  accountId: string;
  fromId: string;
  out: true;
  text: string;
  replyToMessageId: null;
  media: false;
  post: false;
}>;

/** The sole-account adapter binds the destination before returning this lease.
 * sendOnce performs one wire invocation and readExact one fresh exact-ID read.
 * It rejects forwarding/via-bot/media at its raw Telegram boundary; text
 * entities are intentionally irrelevant to this plain-text receipt. */
export type StandingCommunityAlertLease = Readonly<{
  info: Readonly<{ accountId: string; internalPeerId: string }>;
  sendOnce(input: Readonly<{ text: string; randomId: string }>): Promise<Readonly<{ messageId: number }>>;
  readExact(messageId: number): Promise<StandingCommunityAlertReadback | null>;
  close(): Promise<void>;
}>;

export type StandingCommunityAlertOutcome = Readonly<{
  schema: "standing-community-alert-outcome-v1";
  caseKey: string;
  policyRevision: number;
  textHash: string;
  state: "verified" | "not-sent" | "unknown";
  reason: "verified" | "cancelled" | "policy-disabled" | "policy-changed" | "policy-unavailable" |
    "lease-unavailable" | "lease-refused" | "interrupted-before-send" | "interrupted-after-dispatch-began" |
    "send-unknown" | "readback-unknown" | "close-unknown" | "persistence-unknown";
  reservedAt: number;
  settledAt: number;
  messageId?: number;
}>;

export type StandingCommunityAlertInspection = Readonly<{
  state: "absent" | "reserved" | "sending" | "verified" | "not-sent" | "unknown";
  outcome?: StandingCommunityAlertOutcome;
}>;

export type StandingCommunityAlertOutbox = Readonly<{
  deliver(input: Readonly<{
    caseKey: string;
    policyRevision: number;
    text: string;
    signal: AbortSignal;
    openAlert(input: Readonly<{ signal: AbortSignal }>): StandingCommunityAlertLease | Promise<StandingCommunityAlertLease>;
    refreshPolicy(): Promise<StandingCommunityAlertPolicySnapshot>;
  }>): Promise<StandingCommunityAlertOutcome>;
  inspect(caseKey: string): Promise<StandingCommunityAlertInspection>;
  recent(input: Readonly<{ limit: number }>): Promise<readonly StandingCommunityAlertOutcome[]>;
  status(): Promise<Readonly<{ used: number; maximum: 256; full: boolean }>>;
  close(): Promise<void>;
}>;

export class StandingCommunityAlertOutboxError extends Error {
  constructor(readonly code: "input" | "binding" | "conflict" | "capacity" | "storage" | "closed") {
    super("STANDING_COMMUNITY_ALERT_OUTBOX_" + code.toUpperCase());
    this.name = "StandingCommunityAlertOutboxError";
    Object.freeze(this);
  }
}

const DOMAIN = "DecadansNeurobro/standing-community-alert-outbox/v1";
const FILE = "community-alert-ledger.enc";
const MAX_CASES = 256 as const;
// 256 maximum-size (4 KiB) texts plus canonical metadata still fit, so the
// explicit case capacity is always reached before the byte ceiling.
const MAX_PLAIN = 2 * 1024 * 1024;
const MAX_CIPHER = 4 * 1024 * 1024;
const ACCOUNT = /^[1-9]\d{0,18}$/u;
const PEER = /^-[1-9]\d{0,19}$/u;
const WORKSPACE = /^[a-z][a-z0-9_-]{0,127}$/u;
const CASE = /^obs_[0-9a-f]{24}$/u;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const fail = (code: StandingCommunityAlertOutboxError["code"]): never => { throw new StandingCommunityAlertOutboxError(code); };
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const sameDirectory = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino;
const stamp = (value: BigIntStats): string => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.nlink].join(":");
const validMessageId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
const validTime = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 253_402_300_799_999;
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
const validRandomId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,18}$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;

function data(value: unknown, required: readonly string[], optional: readonly string[] = [], code: StandingCommunityAlertOutboxError["code"] = "input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key)) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !("value" in descriptor))) return fail(code);
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function textCopy(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 900 || value.trim() !== value ||
      Buffer.byteLength(value, "utf8") > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value || UNSAFE_TEXT.test(value)) return fail("input");
  return value;
}

function bindingCopy(value: unknown, code: StandingCommunityAlertOutboxError["code"] = "input"): StandingCommunityAlertBinding {
  const item = data(value, ["workspaceId", "accountId", "internalPeerId", "observedSourcePeerId"], [], code);
  if (typeof item.workspaceId !== "string" || !WORKSPACE.test(item.workspaceId) || typeof item.accountId !== "string" || !ACCOUNT.test(item.accountId) ||
      typeof item.internalPeerId !== "string" || !PEER.test(item.internalPeerId) || typeof item.observedSourcePeerId !== "string" || !PEER.test(item.observedSourcePeerId) ||
      item.internalPeerId === item.observedSourcePeerId) return fail(code);
  return Object.freeze({ workspaceId: item.workspaceId, accountId: item.accountId, internalPeerId: item.internalPeerId, observedSourcePeerId: item.observedSourcePeerId });
}

function policyCopy(value: unknown): StandingCommunityAlertPolicySnapshot {
  const item = data(value, ["revision", "observationEnabled", "alertsEnabled", "observedSourcePeerId"]);
  if (!validRevision(item.revision) || typeof item.observationEnabled !== "boolean" || typeof item.alertsEnabled !== "boolean" ||
      typeof item.observedSourcePeerId !== "string" || !PEER.test(item.observedSourcePeerId)) return fail("input");
  return Object.freeze({ revision: item.revision, observationEnabled: item.observationEnabled,
    alertsEnabled: item.alertsEnabled, observedSourcePeerId: item.observedSourcePeerId });
}

type OutcomeReason = StandingCommunityAlertOutcome["reason"];
type StoredCase = Readonly<{
  caseKey: string;
  policyRevision: number;
  text: string;
  textHash: string;
  randomId: string;
  reservedAt: number;
  state: "reserved" | "sending" | "verified" | "not-sent" | "unknown";
  settledAt?: number;
  reason?: OutcomeReason;
  messageId?: number;
}>;
type Ledger = Readonly<{
  domain: typeof DOMAIN;
  binding: StandingCommunityAlertBinding;
  generation: number;
  cases: readonly StoredCase[];
}>;

function storedCaseCopy(value: unknown, code: StandingCommunityAlertOutboxError["code"] = "storage"): StoredCase {
  const item = data(value, ["caseKey", "policyRevision", "text", "textHash", "randomId", "reservedAt", "state"], ["settledAt", "reason", "messageId"], code);
  const text = code === "input" ? textCopy(item.text) : (() => {
    try { return textCopy(item.text); } catch { return fail(code); }
  })();
  const states = ["reserved", "sending", "verified", "not-sent", "unknown"] as const;
  if (typeof item.caseKey !== "string" || !CASE.test(item.caseKey) || !validRevision(item.policyRevision) || item.textHash !== sha(text) ||
      !validRandomId(item.randomId) || !validTime(item.reservedAt) || !states.includes(item.state as typeof states[number])) return fail(code);
  const terminal = ["verified", "not-sent", "unknown"].includes(item.state as string);
  if (terminal !== (Object.hasOwn(item, "settledAt") && Object.hasOwn(item, "reason")) || terminal && (!validTime(item.settledAt) || Number(item.settledAt) < Number(item.reservedAt)) ||
      !terminal && (Object.hasOwn(item, "settledAt") || Object.hasOwn(item, "reason") || Object.hasOwn(item, "messageId"))) return fail(code);
  if (terminal) {
    const allowed: Record<string, readonly OutcomeReason[]> = {
      verified: ["verified"],
      "not-sent": ["cancelled", "policy-disabled", "policy-changed", "policy-unavailable", "lease-unavailable", "lease-refused", "interrupted-before-send"],
      unknown: ["interrupted-after-dispatch-began", "send-unknown", "readback-unknown", "close-unknown", "persistence-unknown"],
    };
    if (typeof item.reason !== "string" || !allowed[item.state as string]!.includes(item.reason as OutcomeReason) ||
        (item.state === "verified" ? !validMessageId(item.messageId) : item.state === "not-sent" ? Object.hasOwn(item, "messageId") :
          Object.hasOwn(item, "messageId") && !validMessageId(item.messageId))) return fail(code);
  }
  return Object.freeze({ caseKey: item.caseKey, policyRevision: item.policyRevision, text, textHash: item.textHash, randomId: item.randomId,
    reservedAt: item.reservedAt, state: item.state as StoredCase["state"], ...(terminal ? { settledAt: item.settledAt as number, reason: item.reason as OutcomeReason } : {}),
    ...(Object.hasOwn(item, "messageId") ? { messageId: item.messageId as number } : {}) });
}

function ledgerCopy(value: unknown, binding: StandingCommunityAlertBinding): Ledger {
  const item = data(value, ["domain", "binding", "generation", "cases"], [], "storage");
  if (item.domain !== DOMAIN || !Number.isSafeInteger(item.generation) || Number(item.generation) < 1 || Number(item.generation) > Number.MAX_SAFE_INTEGER) return fail("storage");
  const savedBinding = bindingCopy(item.binding, "storage");
  if (JSON.stringify(savedBinding) !== JSON.stringify(binding) || !Array.isArray(item.cases) || types.isProxy(item.cases) ||
      Object.getPrototypeOf(item.cases) !== Array.prototype || item.cases.length > MAX_CASES || Reflect.ownKeys(item.cases).length !== item.cases.length + 1) return fail("binding");
  const cases = Array.from({ length: item.cases.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(item.cases as unknown[], String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail("storage");
    return storedCaseCopy(descriptor.value);
  });
  if (new Set(cases.map(entry => entry.caseKey)).size !== cases.length) return fail("storage");
  return Object.freeze({ domain: DOMAIN, binding, generation: item.generation as number, cases: Object.freeze(cases) });
}

function outcome(entry: StoredCase, now = entry.reservedAt): StandingCommunityAlertOutcome {
  const state = entry.state === "reserved" ? "not-sent" : entry.state === "sending" ? "unknown" : entry.state;
  const reason: OutcomeReason = entry.state === "reserved" ? "interrupted-before-send" : entry.state === "sending" ? "interrupted-after-dispatch-began" : entry.reason!;
  return Object.freeze({ schema: "standing-community-alert-outcome-v1", caseKey: entry.caseKey, policyRevision: entry.policyRevision,
    textHash: entry.textHash, state, reason, reservedAt: entry.reservedAt, settledAt: entry.settledAt ?? now,
    ...(entry.messageId !== undefined ? { messageId: entry.messageId } : {}) });
}

function signalCopy(value: unknown): AbortSignal {
  if (!value || typeof value !== "object" || types.isProxy(value) || !(value instanceof AbortSignal)) return fail("input");
  return value as AbortSignal;
}

function randomId(): string {
  for (;;) {
    const bytes = randomBytes(8); bytes[0] = bytes[0]! & 0x7f;
    const value = bytes.readBigUInt64BE().toString(); bytes.fill(0);
    if (value !== "0") return value;
  }
}

/** Encrypted fixed-capacity ledger for one exact workspace/account/internal/source
 * scope. A reservation is atomically persisted before any lease is opened. A
 * persisted `sending` state is written before the last policy refresh, so any
 * crash near the wire consumes the case as unknown. Cases are never evicted;
 * capacity exhaustion is an explicit typed failure and status, allowing the
 * host to surface alerting as unavailable. The caller owns the private parent,
 * sole-runtime admission and manual future migration. */
export async function openStandingCommunityAlertOutbox(input: Readonly<{
  directory: string;
  passphrase: string;
  binding: StandingCommunityAlertBinding;
}>): Promise<StandingCommunityAlertOutbox> {
  const args = data(input, ["directory", "passphrase", "binding"]), binding = bindingCopy(args.binding);
  if (typeof args.directory !== "string" || args.directory.length > 32768 || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory ||
      dirname(args.directory) === args.directory || typeof args.passphrase !== "string" || args.passphrase.length < 16 || args.passphrase.length > 4096 ||
      args.passphrase.includes("\0") || Buffer.byteLength(args.passphrase, "utf8") > 4096 || Buffer.from(args.passphrase, "utf8").toString("utf8") !== args.passphrase) return fail("input");
  const directory = args.directory, parent = dirname(directory), path = join(directory, FILE);
  let passphrase = args.passphrase, closed = false, broken = false, tail: Promise<void> = Promise.resolve();
  let parentIdentity: BigIntStats, rootIdentity: BigIntStats | undefined, savedStamp: string | undefined;
  let current: Ledger = Object.freeze({ domain: DOMAIN, binding, generation: 0, cases: Object.freeze([]) });
  const lifecycle = new AbortController();

  const directoryStat = async (target: string): Promise<BigIntStats> => {
    await assertPilotPrivateDirectory(target); const stat = await lstat(target, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("storage"); return stat;
  };
  const fileStat = async (target: string): Promise<BigIntStats> => {
    const stat = await lstat(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(MAX_CIPHER)) return fail("storage"); return stat;
  };
  const checkParent = async (): Promise<void> => { if (!sameDirectory(await directoryStat(parent), parentIdentity)) return fail("storage"); };
  const checkDirectory = async (): Promise<boolean> => {
    let stat: BigIntStats;
    try { stat = await directoryStat(directory); } catch (error) { if (missing(error) && !rootIdentity) { await checkParent(); return false; } throw error; }
    if (rootIdentity && !sameDirectory(stat, rootIdentity)) return fail("storage"); rootIdentity = stat; await checkParent(); return true;
  };
  const inventory = async (temporary?: string): Promise<void> => {
    if (!await checkDirectory()) return;
    const allowed = new Set([FILE, ...(temporary ? [temporary] : [])]), listing = await opendir(directory, { bufferSize: 1 });
    try { for (;;) { const entry = await listing.read(); if (!entry) break; if (!allowed.delete(entry.name)) return fail("storage"); } }
    finally { await listing.close(); }
    if (temporary && allowed.has(temporary) || savedStamp !== undefined && allowed.has(FILE)) return fail("storage");
    if (savedStamp !== undefined && stamp(await fileStat(path)) !== savedStamp) return fail("storage"); await checkParent();
  };
  const readLedger = async (): Promise<Readonly<{ value: Ledger; stat: BigIntStats }> | undefined> => {
    if (!await checkDirectory()) return;
    let before: BigIntStats; try { before = await fileStat(path); } catch (error) { if (missing(error)) return; throw error; }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let bytes: Buffer | undefined;
    try {
      const opened = await handle.stat({ bigint: true }); if (stamp(opened) !== stamp(before)) return fail("storage");
      bytes = Buffer.alloc(Number(opened.size) + 1); let offset = 0;
      while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, null); if (!part.bytesRead) break; offset += part.bytesRead; }
      if (offset !== Number(opened.size) || stamp(await handle.stat({ bigint: true })) !== stamp(opened) || stamp(await fileStat(path)) !== stamp(opened)) return fail("storage");
      const cipher = bytes.subarray(0, offset).toString("utf8"); if (Buffer.byteLength(cipher, "utf8") !== offset || !bytes.subarray(0, offset).equals(Buffer.from(cipher, "utf8"))) return fail("storage");
      const plain = await decryptSession(cipher, passphrase); if (Buffer.byteLength(plain, "utf8") > MAX_PLAIN || Buffer.from(plain, "utf8").toString("utf8") !== plain) return fail("storage");
      let decoded: unknown; try { decoded = JSON.parse(plain); } catch { return fail("storage"); }
      await checkParent(); return Object.freeze({ value: ledgerCopy(decoded, binding), stat: opened });
    } finally { bytes?.fill(0); await handle.close(); }
  };
  const refresh = async (): Promise<void> => {
    const loaded = await readLedger();
    if (!loaded) { if (savedStamp !== undefined || current.generation !== 0) return fail("storage"); await inventory(); return; }
    if (loaded.value.generation < current.generation || loaded.value.generation === current.generation && JSON.stringify(loaded.value) !== JSON.stringify(current)) return fail("storage");
    current = loaded.value; savedStamp = stamp(loaded.stat); await inventory();
  };
  const ensureDirectory = async (): Promise<void> => {
    if (await checkDirectory()) return;
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
    const created = await directoryStat(directory); if (rootIdentity && !sameDirectory(rootIdentity, created)) return fail("storage"); rootIdentity = created; await checkParent();
  };
  const writeLedger = async (cases: readonly StoredCase[]): Promise<void> => {
    const candidate: Ledger = Object.freeze({ domain: DOMAIN, binding, generation: current.generation + 1, cases: Object.freeze([...cases]) });
    const plain = JSON.stringify(candidate); if (Buffer.byteLength(plain, "utf8") > MAX_PLAIN) return fail("storage");
    const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher, "utf8") > MAX_CIPHER) return fail("storage"); await ensureDirectory();
    const name = "alert_" + randomBytes(24).toString("hex") + ".tmp", temporary = join(directory, name); let moved = false;
    try {
      const handle = await open(temporary, "wx", 0o600); let temporaryStamp: string;
      try { await handle.writeFile(cipher, "utf8"); await handle.sync(); const observed = await handle.stat({ bigint: true });
        if (!observed.isFile() || observed.nlink !== 1n || observed.size !== BigInt(Buffer.byteLength(cipher, "utf8")) || stamp(await fileStat(temporary)) !== stamp(observed)) return fail("storage");
        temporaryStamp = stamp(observed);
      } finally { await handle.close(); }
      await inventory(name);
      if (savedStamp === undefined) { try { await lstat(path); return fail("storage"); } catch (error) { if (!missing(error)) throw error; } }
      else if (stamp(await fileStat(path)) !== savedStamp) return fail("storage");
      if (stamp(await fileStat(temporary)) !== temporaryStamp!) return fail("storage");
      await rename(temporary, path); moved = true;
      const loaded = await readLedger(); if (!loaded || JSON.stringify(loaded.value) !== JSON.stringify(candidate)) return fail("storage");
      current = loaded.value; savedStamp = stamp(loaded.stat); await inventory();
    } finally { if (!moved) try { await unlink(temporary); } catch (error) { if (!missing(error)) broken = true; } }
  };
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new StandingCommunityAlertOutboxError("closed")); if (broken) return Promise.reject(new StandingCommunityAlertOutboxError("storage"));
    const admitted = tail.then(async () => { await refresh(); return work(); }); tail = admitted.then(() => undefined, () => undefined);
    return admitted.catch(error => { if (error instanceof StandingCommunityAlertOutboxError) { if (["storage", "binding"].includes(error.code)) broken = true; throw error; }
      broken = true; return fail("storage"); });
  };
  const replace = async (index: number, entry: StoredCase): Promise<void> => {
    const cases = [...current.cases]; cases[index] = entry; await writeLedger(cases);
  };
  const settle = async (index: number, state: "verified" | "not-sent" | "unknown", reason: OutcomeReason, messageId?: number): Promise<StandingCommunityAlertOutcome> => {
    const prior = current.cases[index]!; const settledAt = Date.now();
    const entry = storedCaseCopy({ ...prior, state, settledAt, reason, ...(messageId !== undefined ? { messageId } : {}) });
    try { await replace(index, entry); return outcome(entry); }
    catch { broken = true; return Object.freeze({ ...outcome(Object.freeze({ ...entry, state: "unknown", reason: "persistence-unknown" })), state: "unknown", reason: "persistence-unknown" }); }
  };
  const closeLease = async (close: (() => Promise<void>) | undefined): Promise<boolean> => {
    if (!close) return true; try { await close(); return true; } catch { return false; }
  };

  try { parentIdentity = await directoryStat(parent); await refresh(); }
  catch (error) { passphrase = ""; if (error instanceof StandingCommunityAlertOutboxError) throw error; return fail("storage"); }

  return Object.freeze<StandingCommunityAlertOutbox>({
    async deliver(value) {
      const inputValue = data(value, ["caseKey", "policyRevision", "text", "signal", "openAlert", "refreshPolicy"]);
      if (typeof inputValue.caseKey !== "string" || !CASE.test(inputValue.caseKey) || !validRevision(inputValue.policyRevision) ||
          typeof inputValue.openAlert !== "function" || typeof inputValue.refreshPolicy !== "function") return fail("input");
      const caseKey = inputValue.caseKey, policyRevision = inputValue.policyRevision, text = textCopy(inputValue.text), signal = signalCopy(inputValue.signal);
      const openAlert = inputValue.openAlert as (input: Readonly<{ signal: AbortSignal }>) => StandingCommunityAlertLease | Promise<StandingCommunityAlertLease>;
      const refreshPolicy = inputValue.refreshPolicy as () => Promise<StandingCommunityAlertPolicySnapshot>;
      return enqueue(async () => {
        let index = current.cases.findIndex(entry => entry.caseKey === caseKey), entry = current.cases[index];
        if (entry) {
          if (entry.policyRevision !== policyRevision || entry.text !== text || entry.textHash !== sha(text)) return fail("conflict");
          if (entry.state === "reserved") return settle(index, "not-sent", "interrupted-before-send");
          if (entry.state === "sending") return settle(index, "unknown", "interrupted-after-dispatch-began");
          return outcome(entry);
        }
        if (current.cases.length >= MAX_CASES) return fail("capacity");
        const reservedAt = Date.now(); entry = storedCaseCopy({ caseKey, policyRevision, text, textHash: sha(text), randomId: randomId(), reservedAt, state: "reserved" });
        await writeLedger([...current.cases, entry]); index = current.cases.length - 1;
        const combined = AbortSignal.any([signal, lifecycle.signal]);
        if (combined.aborted) return settle(index, "not-sent", "cancelled");
        let lease: StandingCommunityAlertLease | undefined;
        try { lease = await openAlert(Object.freeze({ signal: combined })); }
        catch { return settle(index, "not-sent", "lease-unavailable"); }
        let sendOnce: StandingCommunityAlertLease["sendOnce"], readExact: StandingCommunityAlertLease["readExact"], close: StandingCommunityAlertLease["close"] | undefined;
        try {
          const item = data(lease, ["info", "sendOnce", "readExact", "close"]), info = data(item.info, ["accountId", "internalPeerId"]);
          if (typeof item.close === "function") close = item.close as StandingCommunityAlertLease["close"];
          if (info.accountId !== binding.accountId || info.internalPeerId !== binding.internalPeerId || typeof item.sendOnce !== "function" || typeof item.readExact !== "function" || !close) throw new Error("lease");
          sendOnce = item.sendOnce as StandingCommunityAlertLease["sendOnce"]; readExact = item.readExact as StandingCommunityAlertLease["readExact"]; close = item.close as StandingCommunityAlertLease["close"];
          lease = Object.freeze({ info: Object.freeze({ accountId: binding.accountId, internalPeerId: binding.internalPeerId }), sendOnce, readExact, close });
        } catch {
          const joined = await closeLease(close); return settle(index, close && joined ? "not-sent" : "unknown", close && joined ? "lease-refused" : "close-unknown");
        }
        if (combined.aborted) { const joined = await closeLease(close); return settle(index, joined ? "not-sent" : "unknown", joined ? "cancelled" : "close-unknown"); }
        entry = storedCaseCopy({ ...current.cases[index]!, state: "sending" });
        try { await replace(index, entry); }
        catch (error) { await closeLease(close); throw error; }
        let policy: StandingCommunityAlertPolicySnapshot;
        try { policy = policyCopy(await refreshPolicy()); }
        catch { const joined = await closeLease(close); return settle(index, joined ? "not-sent" : "unknown", joined ? "policy-unavailable" : "close-unknown"); }
        if (combined.aborted) { const joined = await closeLease(close); return settle(index, joined ? "not-sent" : "unknown", joined ? "cancelled" : "close-unknown"); }
        if (!policy.observationEnabled || !policy.alertsEnabled) { const joined = await closeLease(close); return settle(index, joined ? "not-sent" : "unknown", joined ? "policy-disabled" : "close-unknown"); }
        if (policy.revision !== policyRevision || policy.observedSourcePeerId !== binding.observedSourcePeerId) { const joined = await closeLease(close); return settle(index, joined ? "not-sent" : "unknown", joined ? "policy-changed" : "close-unknown"); }
        let acknowledged: number | undefined;
        try { const sent = data(await sendOnce(Object.freeze({ text, randomId: entry.randomId })), ["messageId"]); if (!validMessageId(sent.messageId)) throw new Error("ack"); acknowledged = sent.messageId; }
        catch { const joined = await closeLease(close); return settle(index, "unknown", joined ? "send-unknown" : "close-unknown", acknowledged); }
        let readback: unknown;
        try { readback = await readExact(acknowledged); } catch { readback = null; }
        let verified = false;
        try {
          const exact = data(readback, ["messageId", "chatId", "accountId", "fromId", "out", "text", "replyToMessageId", "media", "post"]);
          verified = exact.messageId === acknowledged && exact.chatId === binding.internalPeerId && exact.accountId === binding.accountId && exact.fromId === binding.accountId &&
            exact.out === true && exact.text === text && exact.replyToMessageId === null && exact.media === false && exact.post === false;
        } catch { verified = false; }
        const joined = await closeLease(close);
        if (!joined) return settle(index, "unknown", "close-unknown", acknowledged);
        if (!verified) return settle(index, "unknown", "readback-unknown", acknowledged);
        return settle(index, "verified", "verified", acknowledged);
      });
    },
    async inspect(caseKey) {
      if (typeof caseKey !== "string" || !CASE.test(caseKey)) return fail("input");
      return enqueue(async () => { const entry = current.cases.find(item => item.caseKey === caseKey);
        return entry ? Object.freeze({ state: entry.state, outcome: outcome(entry) }) : Object.freeze({ state: "absent" }); });
    },
    async recent(value) {
      const inputValue = data(value, ["limit"]); if (!Number.isSafeInteger(inputValue.limit) || Number(inputValue.limit) < 1 || Number(inputValue.limit) > 32) return fail("input");
      return enqueue(async () => Object.freeze(current.cases.slice(-Number(inputValue.limit)).reverse().map(entry => outcome(entry))));
    },
    async status() { return enqueue(async () => Object.freeze({ used: current.cases.length, maximum: MAX_CASES, full: current.cases.length === MAX_CASES })); },
    async close() { if (closed) { await tail; return; } closed = true; lifecycle.abort(); await tail; passphrase = ""; },
  });
}
