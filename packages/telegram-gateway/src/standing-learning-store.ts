import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";

export type StandingLearningKind = "preference" | "lesson" | "procedure" | "decision";
export type StandingLearningScope = "self" | "team";
export type StandingLearningProvenance = Readonly<{
  requestRef: string;
  messageId: number;
  actorId: string;
}>;
export type StandingLearningNote = Readonly<{
  key: string;
  kind: StandingLearningKind;
  scope: StandingLearningScope;
  text: string;
  revision: number;
  provenance: StandingLearningProvenance;
  interpretation: "revisable-evidence";
  applicationAuthority: "none";
  sourceData: "not-instructions";
}>;
export type StandingLearningList = Readonly<{
  notes: readonly StandingLearningNote[];
  visible: number;
  matched: number;
}>;
export type StandingLearningUsage = Readonly<{
  visibility: "actor-visible";
  notes: Readonly<{ active: number; retired: number; total: number }>;
  projection: Readonly<{ bytes: number }>;
  /** Static format ceilings, never remaining capacity or pressure telemetry. */
  formatLimits: Readonly<{ hotSlotsMaximum: number; archivedRetiredMaximum: number; plaintextMaximumBytes: number }>;
}>;
export type StandingLearningRead = Readonly<{
  state: "absent" | "active" | "retired";
  key: string;
  scope: StandingLearningScope;
  revision: number | null;
  note: StandingLearningNote | null;
}>;
export type StandingLearningMutationResult = Readonly<{
  state: "saved" | "retired";
  key: string;
  scope: StandingLearningScope;
  revision: number;
  idempotent: boolean;
  note: StandingLearningNote | null;
}>;
export type StandingLearningMutation = Readonly<{
  actorId: string;
  requestRef: string;
  messageId: number;
  callRef: string;
  action: "save" | "retire";
  scope: StandingLearningScope;
  key: string;
  expectedRevision: number | null;
  kind?: StandingLearningKind;
  text?: string;
}>;
export type StandingLearningStore = Readonly<{
  read(input: Readonly<{ actorId: string; scope: StandingLearningScope; key: string }>): Promise<StandingLearningRead>;
  list(input: Readonly<{ actorId: string; query?: string; limit?: number }>): Promise<StandingLearningList>;
  duplicates(input: Readonly<{ actorId: string; scope: StandingLearningScope; kind: StandingLearningKind; text: string; limit?: number }>): Promise<StandingLearningList>;
  usage(input: Readonly<{ actorId: string }>): Promise<StandingLearningUsage>;
  mutate(input: StandingLearningMutation): Promise<StandingLearningMutationResult>;
  close(): Promise<void>;
}>;
export class StandingLearningStoreError extends Error {
  constructor(readonly code: "input" | "binding" | "conflict" | "limit" | "storage" | "closed") {
    super("STANDING_LEARNING_STORE_" + code.toUpperCase());
    this.name = "StandingLearningStoreError";
  }
}

const DOMAIN = "DecadansNeurobro/standing-learning-store/v1";
const FILE = "learning.enc";
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_ARCHIVED_RETIRED = 2048;
const DEFAULT_MAX_PLAIN = 1024 * 1024;
const MAX_CIPHER = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 4096;
const MAX_QUERY_BYTES = 256;
const KEY = /^[a-z0-9](?:[a-z0-9._:-]{0,94}[a-z0-9])?$/u;
const ACCOUNT = /^[1-9]\d{0,19}$/u;
const PEER = /^-[1-9]\d{0,19}$/u;
const WORKSPACE = /^[a-z][a-z0-9_-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const fail = (code: StandingLearningStoreError["code"]): never => { throw new StandingLearningStoreError(code); };
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");

type PersistedEntry = Readonly<{
  slot: string;
  key: string;
  kind: StandingLearningKind;
  scope: StandingLearningScope;
  ownerActorId: string | null;
  text: string | null;
  revision: number;
  sequence: number;
  retired: boolean;
  mutationRef: string;
  mutationHash: string;
  provenance: StandingLearningProvenance;
}>;
type PersistedRetiredHead = Readonly<Omit<PersistedEntry, "text" | "retired" | "provenance">>;

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors), allowed = [...required, ...optional];
  if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => typeof key !== "string" || !allowed.includes(key)) ||
      Object.values(descriptors).some(descriptor => !("value" in descriptor) || !descriptor.enumerable)) return fail("input");
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function cleanText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !CONTROL.test(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes && Buffer.from(value, "utf8").toString("utf8") === value;
}
function actor(value: unknown): value is string { return typeof value === "string" && ACCOUNT.test(value); }
function key(value: unknown): value is string { return typeof value === "string" && KEY.test(value); }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1; }
function messageId(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2147483647; }
function scope(value: unknown): value is StandingLearningScope { return value === "self" || value === "team"; }
function kind(value: unknown): value is StandingLearningKind { return ["preference", "lesson", "procedure", "decision"].includes(value as string); }
function reference(value: unknown): value is string { return cleanText(value, 256) && !/\s/u.test(value); }
function normalized(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim(); }
function tokens(value: string): readonly string[] {
  return Object.freeze([...new Set(normalized(value).match(/[\p{L}\p{N}]+/gu) ?? [])].filter(token => token.length > 0));
}
function slotFor(scopeValue: StandingLearningScope, actorId: string, noteKey: string): string {
  return scopeValue === "team" ? `team:${noteKey}` : `self:${actorId}:${noteKey}`;
}
function provenanceCopy(value: unknown): StandingLearningProvenance {
  const item = record(value, ["requestRef", "messageId", "actorId"]);
  if (!reference(item.requestRef) || !messageId(item.messageId) || !actor(item.actorId)) return fail("input");
  return Object.freeze({ requestRef: item.requestRef, messageId: item.messageId, actorId: item.actorId });
}
function entryCopy(value: unknown): PersistedEntry {
  const item = record(value, ["slot", "key", "kind", "scope", "ownerActorId", "text", "revision", "sequence", "retired", "mutationRef", "mutationHash", "provenance"]);
  if (typeof item.slot !== "string" || !key(item.key) || !kind(item.kind) || !scope(item.scope) ||
      (item.scope === "self" ? !actor(item.ownerActorId) : item.ownerActorId !== null) ||
      !revision(item.revision) || !revision(item.sequence) || typeof item.retired !== "boolean" ||
      typeof item.mutationRef !== "string" || !/^[0-9a-f]{64}$/u.test(item.mutationRef) ||
      typeof item.mutationHash !== "string" || !/^[0-9a-f]{64}$/u.test(item.mutationHash) ||
      (item.retired ? item.text !== null : !cleanText(item.text, MAX_TEXT_BYTES))) return fail("input");
  const provenance = provenanceCopy(item.provenance);
  if (item.slot !== slotFor(item.scope, (item.ownerActorId ?? provenance.actorId) as string, item.key as string)) return fail("input");
  return Object.freeze({ slot: item.slot, key: item.key, kind: item.kind, scope: item.scope,
    ownerActorId: item.ownerActorId as string | null, text: item.text as string | null, revision: item.revision,
    sequence: item.sequence, retired: item.retired, mutationRef: item.mutationRef, mutationHash: item.mutationHash, provenance });
}
function retiredHeadCopy(value: unknown): PersistedRetiredHead {
  const item = record(value, ["slot", "key", "kind", "scope", "ownerActorId", "revision", "sequence", "mutationRef", "mutationHash"]);
  if (typeof item.slot !== "string" || !key(item.key) || !kind(item.kind) || !scope(item.scope) ||
      (item.scope === "self" ? !actor(item.ownerActorId) : item.ownerActorId !== null) || !revision(item.revision) || !revision(item.sequence) ||
      typeof item.mutationRef !== "string" || !/^[0-9a-f]{64}$/u.test(item.mutationRef) ||
      typeof item.mutationHash !== "string" || !/^[0-9a-f]{64}$/u.test(item.mutationHash) ||
      item.slot !== slotFor(item.scope, (item.ownerActorId ?? "1") as string, item.key as string)) return fail("input");
  return Object.freeze({ slot: item.slot, key: item.key as string, kind: item.kind, scope: item.scope,
    ownerActorId: item.ownerActorId as string | null, revision: item.revision, sequence: item.sequence,
    mutationRef: item.mutationRef, mutationHash: item.mutationHash });
}
function archivedAsEntry(head: PersistedRetiredHead): PersistedEntry {
  return Object.freeze({ ...head, text: null, retired: true,
    provenance: Object.freeze({ requestRef: "archived", messageId: 1, actorId: head.ownerActorId ?? "1" }) });
}
function noteView(entry: PersistedEntry): StandingLearningNote {
  if (entry.retired || entry.text === null) return fail("storage");
  return Object.freeze({ key: entry.key, kind: entry.kind, scope: entry.scope, text: entry.text, revision: entry.revision,
    provenance: entry.provenance, interpretation: "revisable-evidence", applicationAuthority: "none", sourceData: "not-instructions" });
}
function mutationCopy(value: StandingLearningMutation): StandingLearningMutation {
  const item = record(value, ["actorId", "requestRef", "messageId", "callRef", "action", "scope", "key", "expectedRevision"], ["kind", "text"]);
  if (!actor(item.actorId) || !reference(item.requestRef) || !messageId(item.messageId) || !reference(item.callRef) ||
      (item.action !== "save" && item.action !== "retire") || !scope(item.scope) || !key(item.key) ||
      (item.expectedRevision !== null && !revision(item.expectedRevision))) return fail("input");
  if (item.action === "save") {
    if (!kind(item.kind) || !cleanText(item.text, MAX_TEXT_BYTES)) return fail("input");
  } else if (Object.hasOwn(item, "kind") || Object.hasOwn(item, "text") || item.expectedRevision === null) return fail("input");
  return Object.freeze({ actorId: item.actorId, requestRef: item.requestRef, messageId: item.messageId, callRef: item.callRef,
    action: item.action, scope: item.scope, key: item.key, expectedRevision: item.expectedRevision,
    ...(item.action === "save" ? { kind: item.kind as StandingLearningKind, text: item.text as string } : {}) });
}
function cryptoEnvelope(serialized: string): void {
  const value = record(JSON.parse(serialized), ["schemaVersion", "algorithm", "kdf", "salt", "iv", "authTag", "ciphertext"]);
  if (value.schemaVersion !== 1 || value.algorithm !== "aes-256-gcm" || value.kdf !== "scrypt") return fail("storage");
  for (const [name, size] of [["salt", 16], ["iv", 12], ["authTag", 16], ["ciphertext", undefined]] as const) {
    const encoded = value[name];
    if (typeof encoded !== "string" || encoded.length < 1 || encoded.length > MAX_CIPHER) return fail("storage");
    const bytes = Buffer.from(encoded, "base64");
    try { if (bytes.toString("base64") !== encoded || size !== undefined && bytes.length !== size || name === "ciphertext" && bytes.length > DEFAULT_MAX_PLAIN) return fail("storage"); }
    finally { bytes.fill(0); }
  }
}

/** Host-owned bounded notes. Telegram/source text remains inert data: only an
 * explicit model tool call can propose a note, and a stored note grants no app,
 * repository, network or Telegram authority. Each mutation is encrypted,
 * synced, atomically replaced and read back before success is returned. */
export async function openStandingLearningStore(input: Readonly<{
  directory: string;
  passphrase: string;
  binding: Readonly<{ accountId: string; peerId: string }>;
  workspaceId: string;
  inspection?: Readonly<{ maxEntries?: number; maxPlaintextBytes?: number }>;
}>): Promise<StandingLearningStore> {
  const args = record(input, ["directory", "passphrase", "binding", "workspaceId"], ["inspection"]);
  const bindingValue = record(args.binding, ["accountId", "peerId"]);
  let maxEntries = DEFAULT_MAX_ENTRIES, maxPlaintextBytes = DEFAULT_MAX_PLAIN;
  if (Object.hasOwn(args, "inspection")) {
    const limits = record(args.inspection, [], ["maxEntries", "maxPlaintextBytes"]);
    if (Object.hasOwn(limits, "maxEntries")) {
      if (!Number.isSafeInteger(limits.maxEntries) || (limits.maxEntries as number) < 1 || (limits.maxEntries as number) > DEFAULT_MAX_ENTRIES) return fail("input");
      maxEntries = limits.maxEntries as number;
    }
    if (Object.hasOwn(limits, "maxPlaintextBytes")) {
      if (!Number.isSafeInteger(limits.maxPlaintextBytes) || (limits.maxPlaintextBytes as number) < 1024 || (limits.maxPlaintextBytes as number) > DEFAULT_MAX_PLAIN) return fail("input");
      maxPlaintextBytes = limits.maxPlaintextBytes as number;
    }
  }
  if (typeof args.directory !== "string" || args.directory.length > 32768 || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory || dirname(args.directory) === args.directory ||
      typeof args.passphrase !== "string" || args.passphrase.length < 16 || args.passphrase.length > 4096 || args.passphrase.includes("\0") || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString() !== args.passphrase ||
      typeof bindingValue.accountId !== "string" || !ACCOUNT.test(bindingValue.accountId) || typeof bindingValue.peerId !== "string" || !PEER.test(bindingValue.peerId) ||
      typeof args.workspaceId !== "string" || !WORKSPACE.test(args.workspaceId)) return fail("input");
  const directory = args.directory, parent = dirname(directory), path = join(directory, FILE);
  const binding = Object.freeze({ accountId: bindingValue.accountId, peerId: bindingValue.peerId });
  const workspaceId = args.workspaceId as string;
  let passphrase = args.passphrase as string;
  delete args.passphrase;
  const entries = new Map<string, PersistedEntry>();
  const retiredHeads = new Map<string, PersistedRetiredHead>();
  let sequence = 0, closed = false, broken = false, root: BigIntStats | undefined, saved: BigIntStats | undefined;
  let tail = Promise.resolve(), closing: Promise<void> | undefined;
  const directoryStat = async (name: string) => { await assertPilotPrivateDirectory(name); const stat = await lstat(name, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("storage"); return stat; };
  const parentIdentity = await directoryStat(parent);
  const parentGuard = async () => { if (!sameDirectory(parentIdentity, await directoryStat(parent))) return fail("storage"); };
  const exists = async (name: string) => { try { await lstat(name); return true; } catch (error) { if (missing(error)) return false; throw error; } };
  const fileStat = async (name: string) => { const stat = await lstat(name, { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(MAX_CIPHER)) return fail("storage"); return stat; };
  const guard = async (temporary?: Readonly<{ name: string; stat: BigIntStats }>) => {
    await parentGuard();
    if (!root) { if (await exists(directory)) return fail("storage"); return; }
    if (!sameDirectory(root, await directoryStat(directory))) return fail("storage");
    const listing = await opendir(directory, { bufferSize: 1 }); let count = 0;
    try { for (;;) { const entry = await listing.read(); if (!entry) break; count++;
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== FILE && entry.name !== temporary?.name) return fail("storage");
    } } finally { await listing.close(); }
    if (count !== (saved ? 1 : 0) + (temporary ? 1 : 0)) return fail("storage");
    if (saved && stamp(await fileStat(path)) !== stamp(saved)) return fail("storage");
    if (temporary && stamp(await fileStat(join(directory, temporary.name))) !== stamp(temporary.stat)) return fail("storage");
    await parentGuard();
  };
  const readCipher = async (expected: BigIntStats): Promise<string> => {
    const handle = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(expected)) return fail("storage");
      bytes = Buffer.alloc(Number(expected.size) + 1); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset !== Number(expected.size) || stamp(await handle.stat({ bigint: true })) !== stamp(expected)) return fail("storage");
      const text = bytes.subarray(0, offset).toString("utf8");
      if (Buffer.byteLength(text) !== offset || !bytes.subarray(0, offset).equals(Buffer.from(text))) return fail("storage");
      await guard(); return text;
    } finally { bytes?.fill(0); await handle.close(); }
  };
  try {
    if (await exists(directory)) { root = await directoryStat(directory); if (await exists(path)) saved = await fileStat(path); }
    await guard();
    if (saved) {
      const cipher = await readCipher(saved); cryptoEnvelope(cipher);
      const plain = await decryptSession(cipher, passphrase);
      if (Buffer.byteLength(plain) > maxPlaintextBytes) return fail("storage");
      const envelope = record(JSON.parse(plain), ["domain", "binding", "workspaceId", "sequence", "entries"], ["retiredHeads"]);
      const savedBinding = record(envelope.binding, ["accountId", "peerId"]);
      if (envelope.domain !== DOMAIN || savedBinding.accountId !== binding.accountId || savedBinding.peerId !== binding.peerId || envelope.workspaceId !== workspaceId) return fail("binding");
      if (!Number.isSafeInteger(envelope.sequence) || (envelope.sequence as number) < 0 || !Array.isArray(envelope.entries) || envelope.entries.length > maxEntries ||
          Object.hasOwn(envelope, "retiredHeads") && (!Array.isArray(envelope.retiredHeads) || envelope.retiredHeads.length > DEFAULT_MAX_ARCHIVED_RETIRED)) return fail("storage");
      sequence = envelope.sequence as number;
      for (const raw of envelope.entries) { const entry = entryCopy(raw); if (entry.sequence > sequence || entries.has(entry.slot)) return fail("storage"); entries.set(entry.slot, entry); }
      for (const raw of (envelope.retiredHeads as unknown[] | undefined) ?? []) {
        const head = retiredHeadCopy(raw);
        if (head.sequence > sequence || entries.has(head.slot) || retiredHeads.has(head.slot)) return fail("storage");
        retiredHeads.set(head.slot, head);
      }
      await guard();
    }
  } catch (error) {
    passphrase = ""; entries.clear(); retiredHeads.clear();
    if (error instanceof StandingLearningStoreError) throw error;
    return fail("storage");
  }
  const healthy = () => { if (broken) return fail("storage"); };
  const live = () => { if (closed) return fail("closed"); healthy(); };
  const envelopeValue = (candidate: ReadonlyMap<string, PersistedEntry>, archived: ReadonlyMap<string, PersistedRetiredHead>, nextSequence: number) =>
    ({ domain: DOMAIN, binding, workspaceId, sequence: nextSequence, entries: [...candidate.values()],
      ...(archived.size ? { retiredHeads: [...archived.values()] } : {}) });
  const writeSnapshot = async (candidate: ReadonlyMap<string, PersistedEntry>, archived: ReadonlyMap<string, PersistedRetiredHead>, nextSequence: number): Promise<void> => {
    await guard();
    const plaintext = JSON.stringify(envelopeValue(candidate, archived, nextSequence));
    if (Buffer.byteLength(plaintext) > maxPlaintextBytes) return fail("limit");
    const cipher = await encryptSession(plaintext, passphrase);
    if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("limit");
    await guard();
    if (!root) { await mkdir(directory, { mode: 0o700 }); root = await directoryStat(directory); await guard(); }
    const name = "learning_" + randomBytes(24).toString("hex") + ".tmp", temporary = join(directory, name);
    const handle = await open(temporary, "wx", 0o600); let temporaryStat: BigIntStats;
    try {
      const initial = await handle.stat({ bigint: true });
      if (!initial.isFile() || initial.nlink !== 1n || !sameDirectory(initial, await lstat(temporary, { bigint: true }))) return fail("storage");
      await handle.writeFile(cipher, "utf8"); await handle.sync(); temporaryStat = await handle.stat({ bigint: true });
      if (temporaryStat.size !== BigInt(Buffer.byteLength(cipher)) || stamp(await fileStat(temporary)) !== stamp(temporaryStat)) return fail("storage");
    } finally { await handle.close(); }
    await guard({ name, stat: temporaryStat }); await rename(temporary, path);
    const replacement = await fileStat(path);
    if (!sameDirectory(temporaryStat, replacement)) return fail("storage");
    saved = replacement; await guard();
    if (await readCipher(saved) !== cipher) return fail("storage");
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    try { live(); } catch (error) { return Promise.reject(error); }
    // Admission happens before close. A later close joins these calls, while a
    // storage failure in an earlier call prevents queued calls from observing
    // or mutating a store whose durable state is no longer trustworthy.
    const run = () => { healthy(); return operation(); };
    const admitted = tail.then(run, run);
    tail = admitted.then(() => undefined, () => undefined);
    return admitted;
  };
  return Object.freeze({
    read(inputValue: Readonly<{ actorId: string; scope: StandingLearningScope; key: string }>) {
      return enqueue(async () => {
        const input = record(inputValue, ["actorId", "scope", "key"]);
        if (!actor(input.actorId) || !scope(input.scope) || !key(input.key)) return fail("input");
        const slot = slotFor(input.scope, input.actorId, input.key), entry = entries.get(slot), archived = retiredHeads.get(slot);
        if (!entry && archived) return Object.freeze({ state: "retired", key: archived.key, scope: archived.scope, revision: archived.revision, note: null });
        if (!entry) return Object.freeze({ state: "absent", key: input.key, scope: input.scope, revision: null, note: null });
        if (entry.retired) return Object.freeze({ state: "retired", key: entry.key, scope: entry.scope, revision: entry.revision, note: null });
        return Object.freeze({ state: "active", key: entry.key, scope: entry.scope, revision: entry.revision, note: noteView(entry) });
      });
    },
    list(inputValue: Readonly<{ actorId: string; query?: string; limit?: number }>) {
      return enqueue(async () => {
        const input = record(inputValue, ["actorId"], ["query", "limit"]);
        if (!actor(input.actorId) || Object.hasOwn(input, "query") && !cleanText(input.query, MAX_QUERY_BYTES) ||
            Object.hasOwn(input, "limit") && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 16)) return fail("input");
        const visibleEntries = [...entries.values()].filter(entry => !entry.retired && (entry.scope === "team" || entry.ownerActorId === input.actorId));
        const query = input.query as string | undefined, queryNormalized = query === undefined ? undefined : normalized(query), queryTokens = query === undefined ? [] : tokens(query);
        const scored = visibleEntries.map(entry => {
          const keyNormalized = normalized(entry.key), kindNormalized = normalized(entry.kind), textNormalized = normalized(entry.text!);
          const fields = [keyNormalized, kindNormalized, textNormalized], fieldTokens = fields.map(tokens);
          let score = queryNormalized !== undefined && fields.some(field => field === queryNormalized) ? 64 :
            queryNormalized !== undefined && fields.some(field => field.includes(queryNormalized)) ? 24 : 0;
          let matchedTokens = 0;
          for (const token of queryTokens) {
            let tokenScore = 0;
            if (keyNormalized === token || kindNormalized === token) tokenScore = 16;
            else if (fieldTokens.some(values => values.includes(token))) tokenScore = 10;
            else if (fieldTokens.some(values => values.some(value => value.startsWith(token) || token.startsWith(value)))) tokenScore = 5;
            else if (fields.some(field => field.includes(token))) tokenScore = 2;
            if (tokenScore) { matchedTokens++; score += tokenScore; }
          }
          if (queryTokens.length && matchedTokens === queryTokens.length) score += 12;
          if (entry.kind === "preference") score += 1;
          return { entry, score, matchedTokens };
        }).filter(item => queryNormalized === undefined || item.score > Number(item.entry.kind === "preference"))
          .sort((a, b) => b.matchedTokens - a.matchedTokens || b.score - a.score || b.entry.sequence - a.entry.sequence || a.entry.slot.localeCompare(b.entry.slot));
        const limit = (input.limit as number | undefined) ?? 8;
        return Object.freeze({ notes: Object.freeze(scored.slice(0, limit).map(item => noteView(item.entry))), visible: visibleEntries.length, matched: scored.length });
      });
    },
    duplicates(inputValue: Readonly<{ actorId: string; scope: StandingLearningScope; kind: StandingLearningKind; text: string; limit?: number }>) {
      return enqueue(async () => {
        const input = record(inputValue, ["actorId", "scope", "kind", "text"], ["limit"]);
        if (!actor(input.actorId) || !scope(input.scope) || !kind(input.kind) || !cleanText(input.text, MAX_TEXT_BYTES) ||
            Object.hasOwn(input, "limit") && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 16)) return fail("input");
        const canonical = normalized(input.text as string);
        const visible = [...entries.values()].filter(entry => !entry.retired && entry.scope === input.scope &&
          (entry.scope === "team" || entry.ownerActorId === input.actorId));
        const matches = visible.filter(entry => entry.kind === input.kind && normalized(entry.text!) === canonical)
          .sort((a, b) => b.sequence - a.sequence || a.slot.localeCompare(b.slot));
        const limit = (input.limit as number | undefined) ?? 8;
        return Object.freeze({ notes: Object.freeze(matches.slice(0, limit).map(noteView)), visible: visible.length, matched: matches.length });
      });
    },
    usage(inputValue: Readonly<{ actorId: string }>) {
      return enqueue(async () => {
        const input = record(inputValue, ["actorId"]); if (!actor(input.actorId)) return fail("input");
        const visibleHot = [...entries.values()].filter(entry => entry.scope === "team" || entry.ownerActorId === input.actorId)
          .sort((a, b) => a.slot.localeCompare(b.slot));
        const visibleArchived = [...retiredHeads.values()].filter(entry => entry.scope === "team" || entry.ownerActorId === input.actorId)
          .sort((a, b) => a.slot.localeCompare(b.slot));
        const active = visibleHot.filter(entry => !entry.retired).length, retired = visibleHot.length - active + visibleArchived.length;
        const projection = Object.freeze({ active: Object.freeze(visibleHot.filter(entry => !entry.retired).map(noteView)),
          retired: Object.freeze([
            ...visibleHot.filter(entry => entry.retired).map(entry => Object.freeze({ key: entry.key, scope: entry.scope, revision: entry.revision })),
            ...visibleArchived.map(entry => Object.freeze({ key: entry.key, scope: entry.scope, revision: entry.revision })),
          ]) });
        return Object.freeze({ visibility: "actor-visible", notes: Object.freeze({ active, retired, total: active + retired }),
          projection: Object.freeze({ bytes: Buffer.byteLength(JSON.stringify(projection)) }),
          formatLimits: Object.freeze({ hotSlotsMaximum: maxEntries, archivedRetiredMaximum: DEFAULT_MAX_ARCHIVED_RETIRED,
            plaintextMaximumBytes: maxPlaintextBytes }) });
      });
    },
    mutate(inputValue: StandingLearningMutation) {
      return enqueue(async () => {
        const input = mutationCopy(inputValue), slot = slotFor(input.scope, input.actorId, input.key), hotCurrent = entries.get(slot), archivedCurrent = retiredHeads.get(slot),
          current = hotCurrent ?? (archivedCurrent ? archivedAsEntry(archivedCurrent) : undefined);
        const mutationRef = sha([DOMAIN, workspaceId, binding, input.actorId, input.requestRef, input.messageId, input.callRef]);
        const mutationHash = sha([input.action, input.scope, input.key, input.expectedRevision, input.kind ?? null, input.text ?? null]);
        const prior = [...entries.values(), ...[...retiredHeads.values()].map(archivedAsEntry)].find(entry => entry.mutationRef === mutationRef);
        if (prior) {
          if (prior.mutationHash !== mutationHash || prior.slot !== slot) return fail("conflict");
          return Object.freeze({ state: prior.retired ? "retired" : "saved", key: prior.key, scope: prior.scope, revision: prior.revision,
            idempotent: true, note: prior.retired ? null : noteView(prior) });
        }
        if (input.expectedRevision === null ? current !== undefined : !current || current.revision !== input.expectedRevision) return fail("conflict");
        if (sequence >= Number.MAX_SAFE_INTEGER) return fail("limit");
        const nextRevision = (current?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(nextRevision)) return fail("limit");
        const provenance = Object.freeze({ requestRef: input.requestRef, messageId: input.messageId, actorId: input.actorId });
        const retired = input.action === "retire";
        const entry: PersistedEntry = Object.freeze({ slot, key: input.key, scope: input.scope, ownerActorId: input.scope === "self" ? input.actorId : null,
          kind: retired ? current!.kind : input.kind!, text: retired ? null : input.text!, revision: nextRevision, sequence: sequence + 1,
          retired, mutationRef, mutationHash, provenance });
        const candidate = new Map(entries), archivedCandidate = new Map(retiredHeads);
        if (archivedCurrent) archivedCandidate.delete(slot);
        if (archivedCurrent && retired) {
          archivedCandidate.set(slot, Object.freeze({ slot: entry.slot, key: entry.key, kind: entry.kind, scope: entry.scope,
            ownerActorId: entry.ownerActorId, revision: entry.revision, sequence: entry.sequence, mutationRef: entry.mutationRef, mutationHash: entry.mutationHash }));
        } else {
          if (!hotCurrent && candidate.size >= maxEntries) {
            const reclaim = [...candidate.values()].filter(value => value.retired).sort((a, b) => a.sequence - b.sequence || a.slot.localeCompare(b.slot))[0];
            if (!reclaim || archivedCandidate.size >= DEFAULT_MAX_ARCHIVED_RETIRED) return fail("limit");
            candidate.delete(reclaim.slot);
            archivedCandidate.set(reclaim.slot, Object.freeze({ slot: reclaim.slot, key: reclaim.key, kind: reclaim.kind, scope: reclaim.scope,
              ownerActorId: reclaim.ownerActorId, revision: reclaim.revision, sequence: reclaim.sequence,
              mutationRef: reclaim.mutationRef, mutationHash: reclaim.mutationHash }));
          }
          candidate.set(slot, entry);
        }
        try { await writeSnapshot(candidate, archivedCandidate, sequence + 1); }
        catch (error) {
          if (error instanceof StandingLearningStoreError && error.code === "limit") throw error;
          broken = true;
          if (error instanceof StandingLearningStoreError) throw error;
          return fail("storage");
        }
        entries.clear(); for (const [name, value] of candidate) entries.set(name, value);
        retiredHeads.clear(); for (const [name, value] of archivedCandidate) retiredHeads.set(name, value); sequence++;
        return Object.freeze({ state: retired ? "retired" : "saved", key: entry.key, scope: entry.scope, revision: entry.revision,
          idempotent: false, note: retired ? null : noteView(entry) });
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = tail.finally(() => { entries.clear(); retiredHeads.clear(); passphrase = ""; });
      return closing;
    },
  });
}
