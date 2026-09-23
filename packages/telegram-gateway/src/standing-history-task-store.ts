import { createHash } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotSelfHistoryTaskCheckpoint, type SelfHistoryTaskCheckpoint, type SelfHistoryTaskPage, type SelfHistoryPage,
  type SelfHistoryMessage, type SelfHistoryTaskSource } from "./self-history-reader.js";

export type StandingHistoryTaskObservedSource = Readonly<{ kind: "observed-source"; sourceRef: "community"; workspaceId: string; peerId: string }>;
export type StandingHistoryTaskIntent = Readonly<{ schema: "standing-history-task-v1"; taskId: string; accountId: string; chatId: string;
  requesterId: string; primaryMessageId: number; fromDate: number; toDate: number; timezone: string; objective: string;
  source?: StandingHistoryTaskObservedSource }>;
export type StandingHistoryTaskStatus = Readonly<{ storage: "ready" | "tail-refused";
  readProgress: Readonly<{ committedPages: number; checkpoint: SelfHistoryTaskCheckpoint; chainHash: string }>;
  modelProgress: "not-recorded"; limits: Readonly<{ maximumPages: number; maximumPageBytes: number; maximumCiphertextBytes: number; pageQuotaReached: boolean }> }>;
export type StandingHistoryStoredPage = Readonly<{ index: number; hash: string; result: SelfHistoryTaskPage }>;
export type StandingHistoryTaskStore = Readonly<{
  appendPage(input: Readonly<{ expectedCheckpoint: SelfHistoryTaskCheckpoint; result: SelfHistoryTaskPage }>): Promise<StandingHistoryTaskStatus>;
  readPage(index: number): Promise<StandingHistoryStoredPage | undefined>;
  status(): Promise<StandingHistoryTaskStatus>;
  close(): Promise<void>;
}>;
export class StandingHistoryTaskStoreError extends Error {
  constructor(readonly code: "input" | "binding" | "consumed" | "conflict" | "tail" | "limit" | "storage" | "busy" | "closed" | "aborted") {
    super("STANDING_HISTORY_TASK_" + code.toUpperCase()); this.name = "StandingHistoryTaskStoreError";
  }
}
const fail = (code: StandingHistoryTaskStoreError["code"]): never => { throw new StandingHistoryTaskStoreError(code); };
const DOMAIN = "DecadansNeurobro/standing-history-task/v1", MAX_PAGES = 1024, MAX_PAGE = 128 * 1024, MAX_CIPHER = 192 * 1024;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const version = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const positive = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,19}$/u.test(v);
const signedPeer = (v: unknown): v is string => typeof v === "string" && /^-?[1-9]\d{0,19}$/u.test(v);
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const date = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) < 2147483647;
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown, bytes: number): v is string => typeof v === "string" && v.trim().length > 0 && !v.includes("\0") && Buffer.byteLength(v) <= bytes && Buffer.from(v).toString("utf8") === v;
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function array(value: unknown, maximum: number): unknown[] {
  if (!value || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
  if (length > maximum || Reflect.ownKeys(ds).length !== length + 1) return fail("input");
  const result: unknown[] = [];
  for (let n = 0; n < length; n++) { const d = ds[String(n)]; if (!d || !("value" in d)) return fail("input"); result.push(d.value); }
  return result;
}
export function snapshotStandingHistoryTaskObservedSource(value: unknown): StandingHistoryTaskObservedSource {
  const source = data(value, ["kind", "sourceRef", "workspaceId", "peerId"]);
  if (source.kind !== "observed-source" || source.sourceRef !== "community" || typeof source.workspaceId !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(source.workspaceId) || typeof source.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(source.peerId)) return fail("input");
  return Object.freeze({ kind: "observed-source", sourceRef: "community", workspaceId: source.workspaceId, peerId: source.peerId });
}
function intentCopy(value: unknown): StandingHistoryTaskIntent {
  const i = data(value, ["schema", "taskId", "accountId", "chatId", "requesterId", "primaryMessageId", "fromDate", "toDate", "timezone", "objective"], ["source"]);
  if (i.schema !== "standing-history-task-v1" || typeof i.taskId !== "string" || !/^htask_[0-9a-f]{48}$/u.test(i.taskId) || !positive(i.accountId) || !positive(i.requesterId) ||
      typeof i.chatId !== "string" || !/^-[1-9]\d{0,19}$/u.test(i.chatId) || !id(i.primaryMessageId) || !date(i.fromDate) || !date(i.toDate) || i.fromDate > i.toDate ||
      !text(i.timezone, 64) || !/^[A-Za-z0-9_+/-]+$/u.test(i.timezone) || !text(i.objective, 4096)) return fail("input");
  const source = Object.hasOwn(i, "source") ? snapshotStandingHistoryTaskObservedSource(i.source) : undefined;
  if (source?.peerId === i.chatId) return fail("input");
  try { new Intl.DateTimeFormat("en", { timeZone: i.timezone }); } catch { return fail("input"); }
  return Object.freeze({ schema: i.schema, taskId: i.taskId, accountId: i.accountId, chatId: i.chatId, requesterId: i.requesterId,
    primaryMessageId: i.primaryMessageId, fromDate: i.fromDate, toDate: i.toDate, timezone: i.timezone, objective: i.objective,
    ...(source === undefined ? {} : { source }) });
}
export { intentCopy as snapshotStandingHistoryTaskIntent };
export const standingHistoryTaskSourcePeerId = (value: StandingHistoryTaskIntent): string => {
  const intent = intentCopy(value); return intent.source?.peerId ?? intent.chatId;
};
const initial = (i: StandingHistoryTaskIntent) => snapshotSelfHistoryTaskCheckpoint({ schema: "self-history-task-checkpoint-v1", accountId: i.accountId, chatId: standingHistoryTaskSourcePeerId(i),
  fromDate: i.fromDate, toDate: i.toDate, offsetId: 0, lastDate: i.toDate, oldestDate: null, newestDate: null, undated: 0, pages: 0, inexact: false, upperBoundMessageId: null, status: "more" });
const limitations: SelfHistoryPage["limitations"] = Object.freeze(["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"]);

/** Snapshot the reader's whole inert result before I/O. Raw source identities
 * and public rows are validated together; a model summary is never source proof. */
export function snapshotStandingHistoryTaskPage(value: unknown, expectedIntent?: StandingHistoryTaskIntent): SelfHistoryTaskPage {
  const v = data(value, ["page", "sources", "beforeCheckpoint", "nextCheckpoint"]), before = snapshotSelfHistoryTaskCheckpoint(v.beforeCheckpoint), next = snapshotSelfHistoryTaskCheckpoint(v.nextCheckpoint);
  if (before.status !== "more" || before.accountId !== next.accountId || before.chatId !== next.chatId || before.fromDate !== next.fromDate || before.toDate !== next.toDate || before.inexact && !next.inexact) return fail("input");
  if (expectedIntent !== undefined) {
    const intent = intentCopy(expectedIntent);
    if (before.accountId !== intent.accountId || before.chatId !== standingHistoryTaskSourcePeerId(intent) || before.fromDate !== intent.fromDate || before.toDate !== intent.toDate) return fail("binding");
  }
  const p = data(v.page, ["schema", "fromDate", "toDate", "messages", "cursor", "hasMore", "status", "coverage", "excluded", "limitations"]),
    c = data(p.coverage, ["scope", "oldestExaminedDate", "newestExaminedDate", "traversalComplete", "undatedEntries", "pages"]),
    x = data(p.excluded, ["nonText", "invalidText", "unavailable", "outsidePeriod"]);
  if (p.schema !== "neurobro-self-history-v1" || p.fromDate !== before.fromDate || p.toDate !== before.toDate || p.cursor !== null || p.status !== next.status || p.hasMore !== (p.status === "more") ||
      c.scope !== "available-history-snapshot" || c.oldestExaminedDate !== next.oldestDate || c.newestExaminedDate !== next.newestDate || c.undatedEntries !== next.undated || c.pages !== next.pages ||
      c.traversalComplete !== (["lower-bound-reached", "empty-page"].includes(next.status) && next.undated === 0 && !next.inexact) ||
      !same(array(p.limitations, 4), limitations) || Object.values(x).some(n => !natural(n) || n > 100)) return fail("input");
  const messages = array(p.messages, 100).map(value => {
    const m = data(value, ["ref", "authorRef", "author", "displayName", "date", "editedAt", "replyRef", "replyUnavailable", "text"], ["forwarded"]);
    if (typeof m.ref !== "string" || !/^m_[0-9a-f]{24}$/u.test(m.ref) || typeof m.authorRef !== "string" || !(m.authorRef === "neurobro" || /^a_[0-9a-f]{24}$/u.test(m.authorRef)) ||
        !["self", "user", "bot", "unknown"].includes(m.author as string) || !text(m.displayName, 512) || !date(m.date) || m.date < before.fromDate || m.date > before.toDate ||
        !(m.editedAt === null || date(m.editedAt)) || !(m.replyRef === null || typeof m.replyRef === "string" && /^m_[0-9a-f]{24}$/u.test(m.replyRef)) ||
        typeof m.replyUnavailable !== "boolean" || m.replyRef !== null && m.replyUnavailable || !text(m.text, 16384)) return fail("input");
    let forwarded: Readonly<{ originalDate: number; sourceName: string | null; interpretation: "quoted-source-not-request" }> | undefined;
    if (Object.hasOwn(m, "forwarded")) {
      const f = data(m.forwarded, ["originalDate", "sourceName", "interpretation"]);
      if (!date(f.originalDate) || !(f.sourceName === null || text(f.sourceName, 128)) || f.interpretation !== "quoted-source-not-request") return fail("input");
      forwarded = Object.freeze({ originalDate: f.originalDate, sourceName: f.sourceName as string | null, interpretation: "quoted-source-not-request" });
    }
    return Object.freeze({ ref: m.ref, authorRef: m.authorRef, author: m.author, displayName: m.displayName, date: m.date, editedAt: m.editedAt,
      replyRef: m.replyRef, replyUnavailable: m.replyUnavailable, text: m.text, ...(forwarded === undefined ? {} : { forwarded }) }) as unknown as SelfHistoryMessage;
  });
  const byRef = new Map(messages.map(m => [m.ref, m])); if (byRef.size !== messages.length) return fail("input");
  const counts = { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, included: string[] = [];
  const messageRefs = new Map<number, string>(), messageIds = new Map<string, number>(), authorRefs = new Map<string, string>(), authorIds = new Map<string, string>();
  const replies: { id: number; ref: string }[] = [];
  let offset = before.offsetId, lastDate = before.lastDate, oldest = before.oldestDate, newest = before.newestDate, undated = before.undated;
  const sources = array(v.sources, 100).map(value => {
    const s = data(value, ["messageId", "date", "disposition"], ["messageRef", "authorId", "replyToMessageId"]);
    if (!id(s.messageId) || s.messageId >= (offset || 2147483648) || !(s.date === null || date(s.date) && s.date >= before.fromDate && s.date <= lastDate) ||
        !["included", "nonText", "invalidText", "unavailable", "outsidePeriod"].includes(s.disposition as string)) return fail("input");
    offset = s.messageId;
    if (s.date === null) { if (s.disposition !== "unavailable") return fail("input"); undated++; }
    else { lastDate = s.date; oldest = oldest === null ? s.date : Math.min(oldest, s.date); newest = newest === null ? s.date : Math.max(newest, s.date); }
    if (s.disposition === "included") {
      const m = typeof s.messageRef === "string" ? byRef.get(s.messageRef) : undefined;
      if (!m || !signedPeer(s.authorId) || m.date !== s.date || (m.author === "self") !== (s.authorId === before.accountId) || m.authorRef === "neurobro" && (m.author !== "self" || s.authorId !== before.accountId) ||
          (m.replyRef !== null) !== Object.hasOwn(s, "replyToMessageId") || Object.hasOwn(s, "replyToMessageId") && (!id(s.replyToMessageId) || s.replyToMessageId >= s.messageId)) return fail("input");
      if (authorRefs.has(s.authorId) && authorRefs.get(s.authorId) !== m.authorRef || authorIds.has(m.authorRef) && authorIds.get(m.authorRef) !== s.authorId) return fail("input");
      authorRefs.set(s.authorId, m.authorRef); authorIds.set(m.authorRef, s.authorId); messageRefs.set(s.messageId, m.ref); messageIds.set(m.ref, s.messageId);
      if (m.replyRef !== null) replies.push({ id: s.replyToMessageId as number, ref: m.replyRef });
      included.push(m.ref);
    } else {
      if (Object.hasOwn(s, "messageRef") || Object.hasOwn(s, "authorId") || Object.hasOwn(s, "replyToMessageId")) return fail("input");
      counts[s.disposition as keyof typeof counts]++;
    }
    return Object.freeze(s) as unknown as SelfHistoryTaskSource;
  });
  for (const reply of replies) {
    if (messageRefs.has(reply.id) && messageRefs.get(reply.id) !== reply.ref || messageIds.has(reply.ref) && messageIds.get(reply.ref) !== reply.id) return fail("input");
  }
  if (!same(included.reverse(), messages.map(m => m.ref)) || !same(counts, x) || next.offsetId !== offset || next.lastDate !== lastDate || next.oldestDate !== oldest || next.newestDate !== newest || next.undated !== undated ||
      next.upperBoundMessageId !== (before.upperBoundMessageId ?? sources[0]?.messageId ?? null) || next.pages !== before.pages + (next.status === "inaccessible" ? 0 : 1) ||
      next.status === "more" && sources.length === 0 || ["empty-page", "inaccessible"].includes(next.status) && sources.length !== 0 ||
      next.status === "inaccessible" && next.inexact !== before.inexact) return fail("input");
  const page: SelfHistoryPage = Object.freeze({ schema: p.schema, fromDate: before.fromDate, toDate: before.toDate, messages: Object.freeze(messages), cursor: null,
    hasMore: p.hasMore as boolean, status: next.status, coverage: Object.freeze({ scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate,
      traversalComplete: c.traversalComplete as boolean, undatedEntries: next.undated, pages: next.pages }), excluded: Object.freeze(counts), limitations });
  const result = Object.freeze({ page, sources: Object.freeze(sources), beforeCheckpoint: before, nextCheckpoint: next });
  if (Buffer.byteLength(JSON.stringify(page)) > 65536 || Buffer.byteLength(JSON.stringify(result)) > MAX_PAGE) return fail("limit");
  return result;
}

/** One explicitly identified history-read task. Caller owns request authority,
 * protected parent and scheduling. Pages record durable reading only, never
 * analysis/delivery/completion. No write/send action is replayed. A readable
 * immutable prefix survives a damaged tail; that task then refuses all appends.
 * Synced file data is verified; atomic directory durability on power loss is not
 * promised. Quotas are local limits, not a guarantee of full-period coverage. */
export async function openStandingHistoryTaskStore(input: Readonly<{ directory: string; passphrase: string; intent: StandingHistoryTaskIntent; mode: "create" | "open"; signal?: AbortSignal }>): Promise<StandingHistoryTaskStore> {
  const args = data(input, ["directory", "passphrase", "intent", "mode"], ["signal"]), intent = intentCopy(args.intent);
  if (typeof args.directory !== "string" || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory || !text(args.passphrase, 4096) || args.passphrase.length < 16 ||
      !["create", "open"].includes(args.mode as string) || Object.hasOwn(args, "signal") && (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal))) return fail("input");
  const directory = args.directory, slot = join(directory, intent.taskId), signal = args.signal as AbortSignal | undefined;
  let passphrase = args.passphrase, closed = false, active: Promise<unknown> | undefined, tail = false, checkpoint = initial(intent);
  const intentEnvelope = { domain: DOMAIN, taskId: intent.taskId, kind: "intent", intent }, intentHash = hash(intentEnvelope);
  let chainHash = intentHash;
  const versions = new Map<string, string>(), pages: { hash: string; before: SelfHistoryTaskCheckpoint; next: SelfHistoryTaskCheckpoint }[] = [];
  const live = () => { if (closed) return fail("closed"); if (signal?.aborted) return fail("aborted"); };
  live(); await assertPilotPrivateDirectory(directory); const root = await lstat(directory, { bigint: true });
  if (args.mode === "create") { live(); try { await mkdir(slot, { mode: 0o700 }); } catch (e) { return fail((e as NodeJS.ErrnoException).code === "EEXIST" ? "consumed" : "storage"); } }
  await assertPilotPrivateDirectory(slot); const owner = await lstat(slot, { bigint: true });
  const check = async (known = false) => {
    live(); await assertPilotPrivateDirectory(directory); await assertPilotPrivateDirectory(slot);
    if (!sameDirectory(root, await lstat(directory, { bigint: true })) || !sameDirectory(owner, await lstat(slot, { bigint: true }))) return fail("storage");
    if (known) for (const [name, expected] of versions) { live(); const s = await lstat(join(slot, name), { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || version(s) !== expected) return fail("storage"); }
    live();
  };
  const name = (index: number) => "page-" + String(index).padStart(6, "0") + ".enc";
  const read = async (filename: string): Promise<{ value: unknown; stamp: string }> => {
    await check(); const path = join(slot, filename), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true }); if (!inside.isFile() || version(inside) !== version(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { live(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size)) return fail("storage");
      const value: unknown = JSON.parse(await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase));
      const after = await lstat(path, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || version(after) !== version(before)) return fail("storage");
      await check(); return { value, stamp: version(after) };
    } finally { bytes?.fill(0); await file.close(); }
  };
  const write = async (filename: string, value: unknown): Promise<string> => {
    await check(); const cipher = await encryptSession(JSON.stringify(value), passphrase);
    if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("limit"); await check();
    const file = await open(join(slot, filename), "wx", 0o600);
    try { await file.writeFile(cipher); await file.sync(); } finally { await file.close(); }
    const verified = await read(filename); if (!same(verified.value, value)) return fail("storage"); return verified.stamp;
  };
  const inventory = async (): Promise<Set<string>> => {
    await check(); const dir = await opendir(slot, { bufferSize: 1 }), names = new Set<string>();
    try { for (;;) { live(); const entry = await dir.read(); if (!entry) break; if (names.size >= MAX_PAGES + 1 || !entry.isFile() || entry.isSymbolicLink() || entry.name !== "intent.enc" && !/^page-\d{6}\.enc$/u.test(entry.name)) return fail("tail"); names.add(entry.name); } }
    finally { await dir.close(); }
    await check(); return names;
  };
  const decode = (value: unknown, index: number, previousHash: string, before: SelfHistoryTaskCheckpoint): { hash: string; result: SelfHistoryTaskPage } => {
    const e = data(value, ["domain", "taskId", "kind", "intentHash", "index", "previousHash", "result"]);
    if (e.domain !== DOMAIN || e.taskId !== intent.taskId || e.kind !== "page" || e.intentHash !== intentHash || e.index !== index || e.previousHash !== previousHash) return fail("binding");
    const result = snapshotStandingHistoryTaskPage(e.result, intent); if (!same(result.beforeCheckpoint, before)) return fail("conflict");
    return { result, hash: hash({ domain: DOMAIN, taskId: intent.taskId, kind: "page", intentHash, index, previousHash, result }) };
  };
  const status = (): StandingHistoryTaskStatus => Object.freeze({ storage: tail ? "tail-refused" : "ready", readProgress: Object.freeze({ committedPages: pages.length, checkpoint, chainHash }),
    modelProgress: "not-recorded", limits: Object.freeze({ maximumPages: MAX_PAGES, maximumPageBytes: MAX_PAGE, maximumCiphertextBytes: MAX_CIPHER, pageQuotaReached: pages.length >= MAX_PAGES }) });
  try {
    if (args.mode === "create") versions.set("intent.enc", await write("intent.enc", intentEnvelope));
    else {
      const saved = await read("intent.enc"), decoded = data(saved.value, ["domain", "taskId", "kind", "intent"]);
      if (decoded.domain !== DOMAIN || decoded.taskId !== intent.taskId || decoded.kind !== "intent" || !same(intentCopy(decoded.intent), intent)) return fail("binding");
      versions.set("intent.enc", saved.stamp);
      let names: Set<string> | undefined;
      try { names = await inventory(); } catch (e) { live(); if (!(e instanceof StandingHistoryTaskStoreError) || e.code !== "tail") throw e; tail = true; }
      for (let index = 1; index <= MAX_PAGES; index++) {
        if (names && !names.has(name(index))) { if (names.size !== index) tail = true; break; }
        try {
          const saved = await read(name(index)), page = decode(saved.value, index, chainHash, checkpoint);
          versions.set(name(index), saved.stamp); pages.push({ hash: page.hash, before: checkpoint, next: page.result.nextCheckpoint }); checkpoint = page.result.nextCheckpoint; chainHash = page.hash;
        } catch (e) { live(); if ((e as NodeJS.ErrnoException)?.code !== "ENOENT" || names?.has(name(index))) tail = true; break; }
      }
    }
    await check(true);
  } catch (e) { passphrase = ""; if (e instanceof StandingHistoryTaskStoreError) throw e; return fail("storage"); }
  const operation = async <T>(work: () => Promise<T>): Promise<T> => {
    live(); if (active) return fail("busy"); const pending = Promise.resolve().then(async () => { await check(true); return work(); }); active = pending;
    try { return await pending; } catch (e) { if (e instanceof StandingHistoryTaskStoreError) throw e; return fail("storage"); } finally { if (active === pending) active = undefined; }
  };
  return Object.freeze<StandingHistoryTaskStore>({
    async appendPage(value) {
      const request = data(value, ["expectedCheckpoint", "result"]), expected = snapshotSelfHistoryTaskCheckpoint(request.expectedCheckpoint), result = snapshotStandingHistoryTaskPage(request.result, intent);
      return operation(async () => {
        if (tail) return fail("tail"); if (pages.length >= MAX_PAGES) return fail("limit");
        if (!same(expected, checkpoint) || !same(result.beforeCheckpoint, checkpoint)) return fail("conflict");
        let names: Set<string>; try { names = await inventory(); } catch { tail = true; return fail("tail"); }
        if (names.size !== pages.length + 1 || !names.has("intent.enc") || pages.some((_, i) => !names.has(name(i + 1)))) { tail = true; return fail("tail"); }
        const index = pages.length + 1, envelope = { domain: DOMAIN, taskId: intent.taskId, kind: "page", intentHash, index, previousHash: chainHash, result };
        try {
          const stamp = await write(name(index), envelope), nextHash = hash(envelope); await check(true);
          versions.set(name(index), stamp); pages.push({ hash: nextHash, before: checkpoint, next: result.nextCheckpoint }); checkpoint = result.nextCheckpoint; chainHash = nextHash;
          return status();
        } catch (e) { tail = true; throw e; }
      });
    },
    readPage(index) {
      if (!Number.isSafeInteger(index) || index < 1 || index > MAX_PAGES) return Promise.reject(new StandingHistoryTaskStoreError("input"));
      return operation(async () => {
        const metadata = pages[index - 1]; if (!metadata) return undefined;
        const saved = await read(name(index)), decoded = decode(saved.value, index, index === 1 ? intentHash : pages[index - 2]!.hash, metadata.before);
        if (decoded.hash !== metadata.hash) return fail("storage"); return Object.freeze({ index, hash: decoded.hash, result: decoded.result });
      });
    },
    status: () => operation(async () => status()),
    async close() { closed = true; try { await active; } catch { /* Join admitted disk work. */ } finally { passphrase = ""; } },
  });
}
