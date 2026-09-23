import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { requireStandingObservedSourcePageMetadata, STANDING_OBSERVED_SOURCE_TEXT_BYTES, type StandingObservedSourceItem,
  type StandingObservedSourcePage } from "./standing-observed-source-reader.js";

export const STANDING_COMMUNITY_OBSERVER_LIMITS = Object.freeze({ recentRows: 256, plaintextBytes: 1024 * 1024,
  ciphertextBytes: 2 * 1024 * 1024, readLimit: 30, pendingReadLimit: 64 });
/** Host processing outcome only. `alert` does not itself prove Telegram delivery
 * and `attempt-reserved` does not claim that model analysis occurred. */
export type StandingCommunityProcessingDisposition = "attempt-reserved" | "alerts-disabled" | "policy-suppressed" | "material-too-large" | "silent" | "alert" | "unknown";
export type StandingCommunityObserverBinding = Readonly<{
  workspaceId: string; accountId: string; internalPeerId: string; sourcePeerId: string;
}>;
export type StandingCommunityPendingRow = Readonly<{
  sequence: number; observedAt: number; ref: string; date: number; displayName: string; text: string; truncated: boolean;
  media: StandingObservedSourceItem["media"]; forwarded?: StandingObservedSourceItem["forwarded"];
}>;
export type StandingCommunityPendingPage = Readonly<{
  schema: "standing-community-pending-v1"; items: readonly StandingCommunityPendingRow[];
  range: Readonly<{ afterSequence: number; throughSequence: number | null }>;
  pendingRows: number; hasMore: boolean; ordering: "discovery-sequence-with-explicit-source-date";
  coverage: Readonly<{ observationsOnly: true; completeHistory: false }>;
}>;
/** Host-only scheduling checkpoint. `read.beforeMessageId` and cycle watermarks
 * are Telegram routing identifiers and must never enter model input/tool output. */
export type StandingCommunityObserverHostCheckpoint = Readonly<{
  schema: "standing-community-observer-checkpoint-v1"; revision: number;
  read: Readonly<{ beforeMessageId: number | null; limit: 30 }>;
  cycle: Readonly<{ status: "idle" | "catching-up" | "capacity-paused"; kind: "bootstrap" | "incremental" | null;
    priorHighWatermark: number | null; highWatermark: number | null; pages: number }>;
  recent: Readonly<{ rows: number; pendingRows: number; latestSequence: number; processedThrough: number }>;
  processing: Readonly<{ last: PersistedProcessing | null; totals: Readonly<Record<StandingCommunityProcessingDisposition, number>> }>;
  coverage: Readonly<{ observationsOnly: true; completeHistory: false; historyBeforeObservationNotRead: boolean;
    retentionEvictedRows: number; sourceWindowGaps: number; gaps: readonly Readonly<{ kind: string; count?: number }>[] }>;
}>;
export type StandingCommunityObserverState = Readonly<{
  checkpoint(): Promise<StandingCommunityObserverHostCheckpoint>;
  commitPage(input: Readonly<{ expectedRevision: number; observedAt: number; page: StandingObservedSourcePage }>):
    Promise<Readonly<{ checkpoint: StandingCommunityObserverHostCheckpoint; idempotent: boolean; admittedRows: number; duplicateRows: number }>>;
  readPending(input?: Readonly<{ limit?: number }>): Promise<StandingCommunityPendingPage>;
  markProcessed(input: Readonly<{ expectedRevision: number; throughSequence: number; disposition: StandingCommunityProcessingDisposition }>):
    Promise<Readonly<{ checkpoint: StandingCommunityObserverHostCheckpoint; idempotent: boolean }>>;
  close(): Promise<void>;
}>;
export class StandingCommunityObserverStateError extends Error {
  constructor(readonly code: "input" | "binding" | "conflict" | "limit" | "storage" | "closed" | "aborted") {
    super("STANDING_COMMUNITY_OBSERVER_STATE_" + code.toUpperCase()); this.name = "StandingCommunityObserverStateError";
  }
}

const DOMAIN = "DecadansNeurobro/standing-community-observer-state/v1", FILE = "community-observer.enc";
const ACCOUNT = /^[1-9]\d{0,19}$/u, PEER = /^-[1-9]\d{0,19}$/u, WORKSPACE = /^[a-z][a-z0-9_-]{0,127}$/u;
const fail = (code: StandingCommunityObserverStateError["code"]): never => { throw new StandingCommunityObserverStateError(code); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const date = (value: unknown): value is number => integer(value, 1, 253402300799);
const disposition = (value: unknown): value is StandingCommunityProcessingDisposition =>
  ["attempt-reserved", "alerts-disabled", "policy-suppressed", "material-too-large", "silent", "alert", "unknown"].includes(value as string);
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors), allowed = [...required, ...optional];
  if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => typeof key !== "string" || !allowed.includes(key)) ||
      Object.values(descriptors).some(item => !("value" in item) || !item.enumerable)) return fail("input");
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= maximum && Buffer.from(value).toString("utf8") === value;
}
function bindingCopy(value: unknown): StandingCommunityObserverBinding {
  const item = record(value, ["workspaceId", "accountId", "internalPeerId", "sourcePeerId"]);
  if (typeof item.workspaceId !== "string" || !WORKSPACE.test(item.workspaceId) || typeof item.accountId !== "string" || !ACCOUNT.test(item.accountId) ||
      typeof item.internalPeerId !== "string" || !PEER.test(item.internalPeerId) || typeof item.sourcePeerId !== "string" || !PEER.test(item.sourcePeerId) ||
      item.internalPeerId === item.sourcePeerId) return fail("input");
  return Object.freeze({ workspaceId: item.workspaceId, accountId: item.accountId, internalPeerId: item.internalPeerId, sourcePeerId: item.sourcePeerId });
}
function mediaCopy(value: unknown): StandingObservedSourceItem["media"] {
  const item = record(value, ["kind", "pixelsProvided"]);
  if (!["none", "photo", "document", "poll", "other"].includes(item.kind as string) || item.pixelsProvided !== false) return fail("input");
  return Object.freeze({ kind: item.kind as StandingObservedSourceItem["media"]["kind"], pixelsProvided: false });
}
function forwardedCopy(value: unknown): NonNullable<StandingObservedSourceItem["forwarded"]> {
  const item = record(value, ["originalDate", "sourceName", "interpretation"]);
  if (!date(item.originalDate) || !(item.sourceName === null || text(item.sourceName, 128)) || item.interpretation !== "quoted-source-not-request") return fail("input");
  return Object.freeze({ originalDate: item.originalDate, sourceName: item.sourceName as string | null, interpretation: "quoted-source-not-request" });
}
function itemCopy(value: unknown): StandingObservedSourceItem {
  const item = record(value, ["ref", "date", "displayName", "text", "truncated", "media"], ["forwarded"]);
  if (typeof item.ref !== "string" || !/^obs_[0-9a-f]{24}$/u.test(item.ref) || !date(item.date) || !text(item.displayName, 128) ||
      !text(item.text, STANDING_OBSERVED_SOURCE_TEXT_BYTES) || typeof item.truncated !== "boolean") return fail("input");
  const media = mediaCopy(item.media), forwarded = Object.hasOwn(item, "forwarded") ? forwardedCopy(item.forwarded) : undefined;
  return Object.freeze({ ref: item.ref, date: item.date, displayName: item.displayName, text: item.text, truncated: item.truncated,
    media, ...(forwarded ? { forwarded } : {}) });
}
type PersistedRow = Readonly<{ messageId: number; sequence: number; observedAt: number; item: StandingObservedSourceItem }>;
type PersistedCycle = Readonly<{ kind: "bootstrap" | "incremental"; priorHighWatermark: number | null; highWatermark: number | null;
  beforeMessageId: number | null; remainingRows: number | null; pages: number }>;
type PersistedProcessing = Readonly<{ fromSequence: number; throughSequence: number; disposition: StandingCommunityProcessingDisposition; revision: number }>;
type PersistedOperation = Readonly<{ kind: "page" | "processed"; expectedRevision: number; digest: string }>;
type MutableState = { revision: number; nextSequence: number; initialized: boolean; settledHighWatermark: number | null; cycle: PersistedCycle | null;
  processedThrough: number; recent: PersistedRow[]; historyBeforeObservationNotRead: boolean; retentionEvictedRows: number;
  sourceWindowGaps: number; capacityPaused: boolean; processingTotals: Record<StandingCommunityProcessingDisposition, number>;
  lastProcessing: PersistedProcessing | null; lastOperation: PersistedOperation | null };

function expectedRef(peerId: string, messageId: number): string {
  return "obs_" + createHash("sha256").update(JSON.stringify(["observed-source-v1", peerId, messageId])).digest("hex").slice(0, 24);
}
function rowCopy(value: unknown, sourcePeerId: string): PersistedRow {
  const row = record(value, ["messageId", "sequence", "observedAt", "item"]), item = itemCopy(row.item);
  if (!integer(row.messageId, 1, 2147483647) || !integer(row.sequence, 1) || !date(row.observedAt) || item.ref !== expectedRef(sourcePeerId, row.messageId)) return fail("input");
  return Object.freeze({ messageId: row.messageId, sequence: row.sequence, observedAt: row.observedAt, item });
}
function cycleCopy(value: unknown): PersistedCycle | null {
  if (value === null) return null;
  const item = record(value, ["kind", "priorHighWatermark", "highWatermark", "beforeMessageId", "remainingRows", "pages"]);
  if (item.kind !== "bootstrap" && item.kind !== "incremental" || !(item.priorHighWatermark === null || integer(item.priorHighWatermark, 1, 2147483647)) ||
      !(item.highWatermark === null || integer(item.highWatermark, 1, 2147483647)) || !(item.beforeMessageId === null || integer(item.beforeMessageId, 1, 2147483647)) ||
      !(item.remainingRows === null || integer(item.remainingRows, 0, 30)) || !integer(item.pages, 0)) return fail("input");
  if (item.kind === "bootstrap" ? item.priorHighWatermark !== null || item.remainingRows === null : item.remainingRows !== null) return fail("input");
  return Object.freeze(item as unknown as PersistedCycle);
}
function processingCopy(value: unknown): PersistedProcessing | null {
  if (value === null) return null;
  const item = record(value, ["fromSequence", "throughSequence", "disposition", "revision"]);
  if (!integer(item.fromSequence, 1) || !integer(item.throughSequence, item.fromSequence as number) || !disposition(item.disposition) || !integer(item.revision, 1)) return fail("input");
  return Object.freeze(item as unknown as PersistedProcessing);
}
function operationCopy(value: unknown): PersistedOperation | null {
  if (value === null) return null;
  const item = record(value, ["kind", "expectedRevision", "digest"]);
  if (item.kind !== "page" && item.kind !== "processed" || !integer(item.expectedRevision) || typeof item.digest !== "string" || !/^[0-9a-f]{64}$/u.test(item.digest)) return fail("input");
  return Object.freeze(item as unknown as PersistedOperation);
}
function totalsCopy(value: unknown): Record<StandingCommunityProcessingDisposition, number> {
  const names: StandingCommunityProcessingDisposition[] = ["attempt-reserved", "alerts-disabled", "policy-suppressed", "silent", "alert", "unknown"];
  const item = record(value, names, ["material-too-large"]); for (const name of names) if (!integer(item[name])) return fail("input");
  // Earlier encrypted snapshots predate this explicit unanalysed-material
  // outcome. Missing means zero; malformed or negative counts still refuse.
  if (Object.hasOwn(item, "material-too-large") && !integer(item["material-too-large"])) return fail("input");
  return { ...Object.fromEntries(names.map(name => [name, item[name]])), "material-too-large": item["material-too-large"] ?? 0 } as Record<StandingCommunityProcessingDisposition, number>;
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

/** Bounded encrypted observation state only. It records read progress and inert
 * projected rows; it owns no Telegram client, model invocation or alert send.
 * Page commits never advance past a row which could not be retained. */
export async function openStandingCommunityObserverState(inputValue: Readonly<{
  directory: string; passphrase: string; binding: StandingCommunityObserverBinding; signal?: AbortSignal;
  inspection?: Readonly<{ maxRecentRows?: number; maxPlaintextBytes?: number }>;
}>): Promise<StandingCommunityObserverState> {
  const input = record(inputValue, ["directory", "passphrase", "binding"], ["signal", "inspection"]), binding = bindingCopy(input.binding);
  let maxRecentRows: number = STANDING_COMMUNITY_OBSERVER_LIMITS.recentRows, maxPlaintextBytes: number = STANDING_COMMUNITY_OBSERVER_LIMITS.plaintextBytes;
  if (Object.hasOwn(input, "inspection")) {
    const limits = record(input.inspection, [], ["maxRecentRows", "maxPlaintextBytes"]);
    if (Object.hasOwn(limits, "maxRecentRows")) { if (!integer(limits.maxRecentRows, 1, maxRecentRows)) return fail("input"); maxRecentRows = limits.maxRecentRows as number; }
    if (Object.hasOwn(limits, "maxPlaintextBytes")) { if (!integer(limits.maxPlaintextBytes, 8192, maxPlaintextBytes)) return fail("input"); maxPlaintextBytes = limits.maxPlaintextBytes as number; }
  }
  if (typeof input.directory !== "string" || !isAbsolute(input.directory) || resolve(input.directory) !== input.directory || dirname(input.directory) === input.directory ||
      typeof input.passphrase !== "string" || input.passphrase.length < 16 || input.passphrase.length > 4096 || input.passphrase.includes("\0") || Buffer.byteLength(input.passphrase) > 4096 ||
      Buffer.from(input.passphrase).toString("utf8") !== input.passphrase ||
      Object.hasOwn(input, "signal") && (types.isProxy(input.signal) || !(input.signal instanceof AbortSignal))) return fail("input");
  const directory = input.directory, path = join(directory, FILE), parent = dirname(directory), signal = input.signal as AbortSignal | undefined;
  let passphrase = input.passphrase as string; delete input.passphrase;
  let state: MutableState = { revision: 0, nextSequence: 0, initialized: false, settledHighWatermark: null, cycle: null, processedThrough: 0, recent: [],
    historyBeforeObservationNotRead: false, retentionEvictedRows: 0, sourceWindowGaps: 0, capacityPaused: false,
    processingTotals: { "attempt-reserved": 0, "alerts-disabled": 0, "policy-suppressed": 0, "material-too-large": 0, silent: 0, alert: 0, unknown: 0 },
    lastProcessing: null, lastOperation: null };
  let root: BigIntStats | undefined, saved: BigIntStats | undefined, closed = false, broken = false, tail = Promise.resolve(), closing: Promise<void> | undefined;
  const directoryStat = async (name: string) => { await assertPilotPrivateDirectory(name); const stat = await lstat(name, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("storage"); return stat; };
  const parentIdentity = await directoryStat(parent);
  const exists = async (name: string) => { try { await lstat(name); return true; } catch (error) { if (missing(error)) return false; throw error; } };
  const fileStat = async (name: string) => { const stat = await lstat(name, { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(STANDING_COMMUNITY_OBSERVER_LIMITS.ciphertextBytes)) return fail("storage"); return stat; };
  const guard = async (temporary?: Readonly<{ name: string; stat: BigIntStats }>) => {
    if (!sameDirectory(parentIdentity, await directoryStat(parent))) return fail("storage");
    if (!root) { if (await exists(directory)) return fail("storage"); return; }
    if (!sameDirectory(root, await directoryStat(directory))) return fail("storage");
    const listing = await opendir(directory, { bufferSize: 1 }); let count = 0;
    try { for (;;) { const entry = await listing.read(); if (!entry) break; count++;
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== FILE && entry.name !== temporary?.name) return fail("storage");
    } } finally { await listing.close(); }
    if (count !== (saved ? 1 : 0) + (temporary ? 1 : 0)) return fail("storage");
    if (saved && stamp(await fileStat(path)) !== stamp(saved)) return fail("storage");
    if (temporary && stamp(await fileStat(join(directory, temporary.name))) !== stamp(temporary.stat)) return fail("storage");
  };
  const readCipher = async (expected: BigIntStats) => {
    const handle = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(expected)) return fail("storage");
      bytes = Buffer.alloc(Number(expected.size) + 1); let offset = 0;
      while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, null); if (!part.bytesRead) break; offset += part.bytesRead; }
      if (offset !== Number(expected.size) || stamp(await handle.stat({ bigint: true })) !== stamp(expected)) return fail("storage");
      const result = bytes.subarray(0, offset).toString("utf8"); if (Buffer.byteLength(result) !== offset) return fail("storage"); await guard(); return result;
    } finally { bytes?.fill(0); await handle.close(); }
  };
  const envelope = (candidate: MutableState) => ({ domain: DOMAIN, binding, revision: candidate.revision, nextSequence: candidate.nextSequence,
    initialized: candidate.initialized, settledHighWatermark: candidate.settledHighWatermark, cycle: candidate.cycle, processedThrough: candidate.processedThrough,
    recent: candidate.recent, historyBeforeObservationNotRead: candidate.historyBeforeObservationNotRead, retentionEvictedRows: candidate.retentionEvictedRows,
    sourceWindowGaps: candidate.sourceWindowGaps, capacityPaused: candidate.capacityPaused, processingTotals: candidate.processingTotals,
    lastProcessing: candidate.lastProcessing, lastOperation: candidate.lastOperation });
  const decode = (value: unknown): MutableState => {
    const item = record(value, ["domain", "binding", "revision", "nextSequence", "initialized", "settledHighWatermark", "cycle", "processedThrough", "recent",
      "historyBeforeObservationNotRead", "retentionEvictedRows", "sourceWindowGaps", "capacityPaused", "processingTotals", "lastProcessing", "lastOperation"]);
    const savedBinding = bindingCopy(item.binding); if (item.domain !== DOMAIN || JSON.stringify(savedBinding) !== JSON.stringify(binding)) return fail("binding");
    if (!integer(item.revision) || !integer(item.nextSequence) || typeof item.initialized !== "boolean" || !(item.settledHighWatermark === null || integer(item.settledHighWatermark, 1, 2147483647)) ||
        !integer(item.processedThrough) || item.processedThrough > item.nextSequence || !Array.isArray(item.recent) || item.recent.length > maxRecentRows ||
        typeof item.historyBeforeObservationNotRead !== "boolean" || !integer(item.retentionEvictedRows) || !integer(item.sourceWindowGaps) || typeof item.capacityPaused !== "boolean") return fail("storage");
    const recent = item.recent.map(value => rowCopy(value, binding.sourcePeerId)), refs = new Set<string>(), ids = new Set<number>(), sequences = new Set<number>();
    for (const row of recent) if (row.sequence > item.nextSequence || refs.has(row.item.ref) || ids.has(row.messageId) || sequences.has(row.sequence)) return fail("storage");
      else { refs.add(row.item.ref); ids.add(row.messageId); sequences.add(row.sequence); }
    const cycle = cycleCopy(item.cycle), totals = totalsCopy(item.processingTotals), lastProcessing = processingCopy(item.lastProcessing), lastOperation = operationCopy(item.lastOperation);
    const pendingSequences = recent.filter(row => row.sequence > (item.processedThrough as number)).map(row => row.sequence).sort((a, b) => a - b);
    if ((item.nextSequence as number) - (item.processedThrough as number) !== pendingSequences.length ||
        pendingSequences.some((sequence, index) => sequence !== (item.processedThrough as number) + index + 1) ||
        Object.values(totals).reduce((sum, count) => sum + count, 0) !== item.processedThrough) return fail("storage");
    if (!item.initialized && item.settledHighWatermark !== null || cycle?.kind === "bootstrap" && item.initialized || cycle?.kind === "incremental" && !item.initialized ||
        item.capacityPaused && !cycle || lastProcessing && (lastProcessing.throughSequence > item.processedThrough || lastProcessing.revision > item.revision) ||
        lastProcessing?.disposition === "attempt-reserved" && (lastProcessing.throughSequence !== item.processedThrough ||
          totals["attempt-reserved"] < lastProcessing.throughSequence - lastProcessing.fromSequence + 1)) return fail("storage");
    return { revision: item.revision, nextSequence: item.nextSequence, initialized: item.initialized, settledHighWatermark: item.settledHighWatermark as number | null,
      cycle, processedThrough: item.processedThrough, recent, historyBeforeObservationNotRead: item.historyBeforeObservationNotRead,
      retentionEvictedRows: item.retentionEvictedRows, sourceWindowGaps: item.sourceWindowGaps, capacityPaused: item.capacityPaused,
      processingTotals: totals, lastProcessing, lastOperation };
  };
  try {
    if (await exists(directory)) { root = await directoryStat(directory); if (await exists(path)) saved = await fileStat(path); }
    await guard();
    if (saved) {
      const cipher = await readCipher(saved), plain = await decryptSession(cipher, passphrase); if (Buffer.byteLength(plain) > maxPlaintextBytes) return fail("storage");
      state = decode(JSON.parse(plain)); await guard();
    }
  } catch (error) { passphrase = ""; if (error instanceof StandingCommunityObserverStateError) throw error; return fail("storage"); }
  const healthy = () => { if (broken) return fail("storage"); if (signal?.aborted) return fail("aborted"); };
  const live = () => { if (closed) return fail("closed"); healthy(); };
  const writeSnapshot = async (candidate: MutableState) => {
    await guard(); const plain = JSON.stringify(envelope(candidate)); if (Buffer.byteLength(plain) > maxPlaintextBytes) return fail("limit");
    const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > STANDING_COMMUNITY_OBSERVER_LIMITS.ciphertextBytes) return fail("limit"); await guard();
    if (!root) { await mkdir(directory, { mode: 0o700 }); root = await directoryStat(directory); await guard(); }
    const name = "community_" + randomBytes(24).toString("hex") + ".tmp", temporary = join(directory, name);
    const handle = await open(temporary, "wx", 0o600); let temporaryStat: BigIntStats;
    try { await handle.writeFile(cipher, "utf8"); await handle.sync(); temporaryStat = await handle.stat({ bigint: true }); }
    finally { await handle.close(); }
    await guard({ name, stat: temporaryStat }); await rename(temporary, path); saved = await fileStat(path);
    if (!sameDirectory(temporaryStat, saved)) return fail("storage"); await guard(); if (await readCipher(saved) !== cipher) return fail("storage");
  };
  const clone = (): MutableState => ({ ...state, recent: [...state.recent], processingTotals: { ...state.processingTotals } });
  const gaps = (candidate: MutableState) => Object.freeze([
    ...(candidate.historyBeforeObservationNotRead ? [Object.freeze({ kind: "history-before-observation-not-read" })] : []),
    ...(candidate.retentionEvictedRows ? [Object.freeze({ kind: "retention-evicted", count: candidate.retentionEvictedRows })] : []),
    ...(candidate.sourceWindowGaps ? [Object.freeze({ kind: "source-window-gap", count: candidate.sourceWindowGaps })] : []),
    ...(candidate.processingTotals["material-too-large"] ? [Object.freeze({ kind: "assessment-material-too-large-not-analyzed", count: candidate.processingTotals["material-too-large"] })] : []),
    ...(candidate.capacityPaused ? [Object.freeze({ kind: "capacity-paused" })] : []),
  ]);
  const checkpoint = (candidate = state): StandingCommunityObserverHostCheckpoint => freeze({ schema: "standing-community-observer-checkpoint-v1" as const,
    revision: candidate.revision, read: { beforeMessageId: candidate.cycle?.beforeMessageId ?? null, limit: 30 as const },
    cycle: { status: candidate.capacityPaused ? "capacity-paused" as const : candidate.cycle ? "catching-up" as const : "idle" as const,
      kind: candidate.cycle?.kind ?? null, priorHighWatermark: candidate.cycle?.priorHighWatermark ?? null,
      highWatermark: candidate.cycle?.highWatermark ?? null, pages: candidate.cycle?.pages ?? 0 },
    recent: { rows: candidate.recent.length, pendingRows: candidate.recent.filter(row => row.sequence > candidate.processedThrough).length,
      latestSequence: candidate.nextSequence, processedThrough: candidate.processedThrough },
    processing: { last: candidate.lastProcessing, totals: { ...candidate.processingTotals } },
    coverage: { observationsOnly: true as const, completeHistory: false as const,
      historyBeforeObservationNotRead: candidate.historyBeforeObservationNotRead, retentionEvictedRows: candidate.retentionEvictedRows,
      sourceWindowGaps: candidate.sourceWindowGaps, gaps: gaps(candidate) } });
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    try { live(); } catch (error) { return Promise.reject(error); }
    const run = () => { healthy(); return work(); }, admitted = tail.then(run, run); tail = admitted.then(() => undefined, () => undefined); return admitted;
  };
  const persist = async (candidate: MutableState) => {
    try { await writeSnapshot(candidate); state = candidate; }
    catch (error) { if (!(error instanceof StandingCommunityObserverStateError) || error.code !== "limit") broken = true; throw error; }
  };
  return Object.freeze({
    checkpoint: () => enqueue(async () => checkpoint()),
    readPending(inputValue: Readonly<{ limit?: number }> = {}) {
      let limit: number;
      try { const input = record(inputValue, [], ["limit"]); limit = Object.hasOwn(input, "limit") ? input.limit as number : 32;
        if (!integer(limit, 1, STANDING_COMMUNITY_OBSERVER_LIMITS.pendingReadLimit)) return fail("input"); }
      catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const pending = state.recent.filter(row => row.sequence > state.processedThrough).sort((a, b) => a.sequence - b.sequence), selected = pending.slice(0, limit);
        const items = selected.map(row => freeze({ sequence: row.sequence, observedAt: row.observedAt, ...row.item }));
        return freeze({ schema: "standing-community-pending-v1" as const, items, range: { afterSequence: state.processedThrough,
          throughSequence: selected.at(-1)?.sequence ?? null }, pendingRows: pending.length, hasMore: selected.length < pending.length,
          ordering: "discovery-sequence-with-explicit-source-date" as const, coverage: { observationsOnly: true as const, completeHistory: false as const } });
      });
    },
    commitPage(inputValue: Readonly<{ expectedRevision: number; observedAt: number; page: StandingObservedSourcePage }>) {
      let expectedRevision: number, observedAt: number, page: StandingObservedSourcePage, metadata: ReturnType<typeof requireStandingObservedSourcePageMetadata>, operationDigest: string;
      try {
        const input = record(inputValue, ["expectedRevision", "observedAt", "page"]); if (!integer(input.expectedRevision) || !date(input.observedAt)) return Promise.reject(new StandingCommunityObserverStateError("input"));
        expectedRevision = input.expectedRevision as number; observedAt = input.observedAt as number; page = input.page as StandingObservedSourcePage;
        metadata = requireStandingObservedSourcePageMetadata(page);
        if (metadata.peerId !== binding.sourcePeerId || metadata.requestedLimit !== 30 || metadata.coveredRows !== metadata.rowIds.length || metadata.rawRows !== metadata.coveredRows + metadata.omittedByBudget ||
            page.coverage.rawRows !== metadata.rawRows || page.coverage.coveredRows !== metadata.coveredRows || page.coverage.omittedByBudget !== metadata.omittedByBudget || page.nextBeforeMessageId !== metadata.lowestCoveredMessageId) return Promise.reject(new StandingCommunityObserverStateError("binding"));
        operationDigest = digest(["page", observedAt, metadata, page]);
      } catch (error) { return Promise.reject(error instanceof StandingCommunityObserverStateError ? error : new StandingCommunityObserverStateError("input")); }
      return enqueue(async () => {
        if (state.lastOperation?.kind === "page" && state.lastOperation.expectedRevision === expectedRevision && state.lastOperation.digest === operationDigest)
          return Object.freeze({ checkpoint: checkpoint(), idempotent: true, admittedRows: 0, duplicateRows: 0 });
        if (state.revision !== expectedRevision) return fail("conflict");
        if (state.revision >= Number.MAX_SAFE_INTEGER) return fail("limit");
        const candidate = clone(), expectedBefore = candidate.cycle?.beforeMessageId ?? null;
        if (metadata.requestedBeforeMessageId !== expectedBefore) return fail("conflict");
        const pageItems = new Map<string, StandingObservedSourceItem>();
        for (const raw of page.items) { const item = itemCopy(raw); if (pageItems.has(item.ref)) return fail("input"); pageItems.set(item.ref, item); }
        const validRefs = new Set(metadata.rowIds.map(id => expectedRef(binding.sourcePeerId, id)));
        if ([...pageItems.keys()].some(ref => !validRefs.has(ref))) return fail("binding");
        if (!candidate.cycle) {
          if (!candidate.initialized) candidate.cycle = Object.freeze({ kind: "bootstrap", priorHighWatermark: null, highWatermark: metadata.highestMessageId,
            beforeMessageId: null, remainingRows: metadata.rawRows, pages: 0 });
          else if (metadata.highestMessageId !== null && (candidate.settledHighWatermark === null || metadata.highestMessageId > candidate.settledHighWatermark))
            candidate.cycle = Object.freeze({ kind: "incremental", priorHighWatermark: candidate.settledHighWatermark,
              highWatermark: metadata.highestMessageId, beforeMessageId: null, remainingRows: null, pages: 0 });
        }
        let admittedRows = 0, duplicateRows = 0, blocked = false, complete = false;
        let cycle = candidate.cycle;
        if (cycle) {
          if (cycle.beforeMessageId !== metadata.requestedBeforeMessageId) return fail("conflict");
          if (cycle.pages >= Number.MAX_SAFE_INTEGER) return fail("limit");
          cycle = Object.freeze({ ...cycle, pages: cycle.pages + 1 }); candidate.cycle = cycle;
          if (cycle.kind === "bootstrap" && cycle.remainingRows === 0) complete = true;
          if (cycle.kind === "bootstrap" && cycle.remainingRows! > 0 && metadata.rawRows === 0) {
            if (candidate.sourceWindowGaps >= Number.MAX_SAFE_INTEGER) return fail("limit"); candidate.sourceWindowGaps++; complete = true;
          }
          if (cycle.kind === "incremental" && metadata.rawRows === 0) {
            if (cycle.priorHighWatermark !== null) { if (candidate.sourceWindowGaps >= Number.MAX_SAFE_INTEGER) return fail("limit"); candidate.sourceWindowGaps++; }
            complete = true;
          }
          for (const messageId of metadata.rowIds) {
            if (cycle.kind === "bootstrap" && cycle.remainingRows === 0) { complete = true; break; }
            if (cycle.kind === "incremental" && cycle.priorHighWatermark !== null && messageId <= cycle.priorHighWatermark) { complete = true; break; }
            const ref = expectedRef(binding.sourcePeerId, messageId), item = pageItems.get(ref);
            if (item) {
              const prior = candidate.recent.find(row => row.messageId === messageId);
              if (prior) {
                if (JSON.stringify(prior.item) !== JSON.stringify(item)) return fail("conflict");
                duplicateRows++;
              } else {
                const beforeRows = candidate.recent, beforeSequence = candidate.nextSequence, beforeEvicted = candidate.retentionEvictedRows;
                if (candidate.nextSequence >= Number.MAX_SAFE_INTEGER) return fail("limit");
                candidate.nextSequence++; candidate.recent = [...candidate.recent, Object.freeze({ messageId, sequence: candidate.nextSequence, observedAt, item })];
                while (candidate.recent.length > maxRecentRows || Buffer.byteLength(JSON.stringify(envelope(candidate))) > maxPlaintextBytes) {
                  const evict = candidate.recent.filter(row => row.sequence <= candidate.processedThrough).sort((a, b) => a.messageId - b.messageId)[0];
                  if (!evict) { candidate.recent = beforeRows; candidate.nextSequence = beforeSequence; candidate.retentionEvictedRows = beforeEvicted; blocked = true; break; }
                  if (candidate.retentionEvictedRows >= Number.MAX_SAFE_INTEGER) return fail("limit");
                  candidate.recent = candidate.recent.filter(row => row !== evict); candidate.retentionEvictedRows++;
                }
                if (blocked) break; admittedRows++;
              }
            }
            const remainingRows: number | null = cycle.kind === "bootstrap" ? cycle.remainingRows! - 1 : null;
            cycle = Object.freeze({ ...cycle, beforeMessageId: messageId, remainingRows }); candidate.cycle = cycle;
            if (cycle.kind === "bootstrap" && remainingRows === 0) { complete = true; break; }
          }
          if (!blocked && !complete && metadata.rowIds.length === 0 && metadata.rawRows > 0) return fail("input");
          if (complete) {
            candidate.initialized = true; candidate.historyBeforeObservationNotRead = true; candidate.settledHighWatermark = cycle.highWatermark;
            candidate.cycle = null; candidate.capacityPaused = false;
          } else { candidate.cycle = cycle; candidate.capacityPaused = blocked; }
        }
        candidate.recent.sort((a, b) => b.messageId - a.messageId);
        candidate.revision++; candidate.lastOperation = Object.freeze({ kind: "page", expectedRevision, digest: operationDigest });
        if (!candidate.cycle && !candidate.initialized && metadata.rawRows === 0) { candidate.initialized = true; candidate.historyBeforeObservationNotRead = true; }
        await persist(candidate);
        return Object.freeze({ checkpoint: checkpoint(), idempotent: false, admittedRows, duplicateRows });
      });
    },
    markProcessed(inputValue: Readonly<{ expectedRevision: number; throughSequence: number; disposition: StandingCommunityProcessingDisposition }>) {
      let expectedRevision: number, throughSequence: number, selectedDisposition: StandingCommunityProcessingDisposition, operationDigest: string;
      try { const input = record(inputValue, ["expectedRevision", "throughSequence", "disposition"]);
        if (!integer(input.expectedRevision) || !integer(input.throughSequence, 1) || !disposition(input.disposition)) return Promise.reject(new StandingCommunityObserverStateError("input"));
        expectedRevision = input.expectedRevision as number; throughSequence = input.throughSequence as number; selectedDisposition = input.disposition as StandingCommunityProcessingDisposition;
        operationDigest = digest(["processed", throughSequence, selectedDisposition]);
      } catch (error) { return Promise.reject(error instanceof StandingCommunityObserverStateError ? error : new StandingCommunityObserverStateError("input")); }
      return enqueue(async () => {
        if (state.lastOperation?.kind === "processed" && state.lastOperation.expectedRevision === expectedRevision && state.lastOperation.digest === operationDigest)
          return Object.freeze({ checkpoint: checkpoint(), idempotent: true });
        if (state.revision !== expectedRevision || throughSequence > state.nextSequence) return fail("conflict");
        if (state.revision >= Number.MAX_SAFE_INTEGER) return fail("limit");
        const candidate = clone(), previous = candidate.lastProcessing;
        if (throughSequence > candidate.processedThrough) {
          if (previous?.disposition === "attempt-reserved") return fail("conflict");
          const fromSequence = candidate.processedThrough + 1, amount = candidate.recent.filter(row => row.sequence >= fromSequence && row.sequence <= throughSequence).length;
          if (amount !== throughSequence - candidate.processedThrough) return fail("conflict");
          if (candidate.processingTotals[selectedDisposition] > Number.MAX_SAFE_INTEGER - amount) return fail("limit");
          candidate.processedThrough = throughSequence; candidate.processingTotals[selectedDisposition] += amount;
          candidate.lastProcessing = Object.freeze({ fromSequence, throughSequence, disposition: selectedDisposition, revision: candidate.revision + 1 });
        } else if (throughSequence === candidate.processedThrough && previous?.throughSequence === throughSequence && previous.disposition === "attempt-reserved" &&
            ["silent", "alert", "unknown"].includes(selectedDisposition)) {
          const amount = previous.throughSequence - previous.fromSequence + 1;
          candidate.processingTotals["attempt-reserved"] -= amount; candidate.processingTotals[selectedDisposition] += amount;
          candidate.lastProcessing = Object.freeze({ ...previous, disposition: selectedDisposition, revision: candidate.revision + 1 });
        } else return fail("conflict");
        candidate.capacityPaused = false; candidate.revision++;
        candidate.lastOperation = Object.freeze({ kind: "processed", expectedRevision, digest: operationDigest }); await persist(candidate);
        return Object.freeze({ checkpoint: checkpoint(), idempotent: false });
      });
    },
    close() { if (closing) return closing; closed = true; closing = tail.finally(() => { state.recent.length = 0; passphrase = ""; }); return closing; },
  });
}
