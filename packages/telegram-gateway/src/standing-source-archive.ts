import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { encryptSession, decryptSession } from "./session-crypto.js";
import type { PilotBinding } from "./pilot-telegram-adapter.js";

export const SOURCE_ARCHIVE_LIMITS = Object.freeze({ batchBytes: 262144, messages: 100, fileBytes: 1048576,
  batches: 8192, storeBytes: 268435456, scanBatches: 32, outputBytes: 65536, cursors: 16 });
export type SourceObservationMessage = Readonly<{ messageId: number; authorId: string;
  authorKind: "user" | "chat" | "channel"; contentKind: "text" | "photo-caption" | "document-caption" | "other-caption";
  authorName: string; date: number; editedAt: number | null;
  replyToMessageId: number | null; text: string }>;
export type SourceObservationCapture = Readonly<{ captureId: string; observedAt: number;
  messages: readonly SourceObservationMessage[] }>;
export type SourceArchiveQuota = Readonly<{ batches: number; encryptedBytes: number;
  maximumBatches: 8192; maximumEncryptedBytes: 268435456 }>;
export type SourceObservationRow = Readonly<{ sequence: number; captureId: string; observedAt: number;
  message: SourceObservationMessage }>;
export type SourceArchivePage = Readonly<{ rows: readonly SourceObservationRow[]; cursor: string | null;
  coverage: { kind: "observations-only"; fromDate: number; toDate: number; throughSequence: number; inventoryBatches: number;
    scannedBatches: number; scannedMessages: number; returnedMessages: number;
    exhausted: "observations" | "scan" | "output"; completeChat: false }; quota: SourceArchiveQuota }>;
export interface StandingSourceArchive {
  append(capture: SourceObservationCapture, signal: AbortSignal): Promise<{ status: "stored" | "duplicate"; sequence: number; quota: SourceArchiveQuota }>;
  query(options: { fromDate: number; toDate: number; limit?: number; scanLimit?: number; cursor?: string }, signal: AbortSignal): Promise<SourceArchivePage>;
  /** Revokes immediately, then joins the actual active filesystem/crypto operation. */
  close(): Promise<void>;
}
export class StandingSourceArchiveError extends Error {
  constructor(readonly code: "storage" | "quota" | "input" | "cursor" | "closed" | "aborted" | "busy" = "storage") {
    super("STANDING_SOURCE_ARCHIVE_" + code.toUpperCase()); this.name = "StandingSourceArchiveError";
  }
}
const fail = (code: StandingSourceArchiveError["code"] = "storage"): never => { throw new StandingSourceArchiveError(code); };
const bytes = (v: string) => Buffer.byteLength(v, "utf8");
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype &&
  Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k) && "value" in Object.getOwnPropertyDescriptor(v, k)!);
const integer = (v: unknown, max = 2147483647): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max;
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function string(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max && bytes(v) <= max && !v.includes("\0") && Buffer.from(v, "utf8").toString("utf8") === v;
}
function capture(value: unknown): SourceObservationCapture {
  if (!exact(value, ["captureId", "observedAt", "messages"]) || !uuid(value.captureId) || !integer(value.observedAt, 253402300799) ||
      !Array.isArray(value.messages) || !value.messages.length || value.messages.length > SOURCE_ARCHIVE_LIMITS.messages) return fail();
  const seen = new Set<number>();
  const messages = value.messages.map((m: unknown): SourceObservationMessage => {
    if (!exact(m, ["messageId", "authorId", "authorKind", "contentKind", "authorName", "date", "editedAt", "replyToMessageId", "text"]) ||
        !integer(m.messageId) || seen.has(m.messageId) || typeof m.authorId !== "string" || !/^[1-9]\d{0,19}$/.test(m.authorId) ||
        !["user", "chat", "channel"].includes(m.authorKind as string) || !["text", "photo-caption", "document-caption", "other-caption"].includes(m.contentKind as string) ||
        !string(m.authorName, 1024) || !integer(m.date, 253402300799) ||
        !(m.editedAt === null || (integer(m.editedAt, 253402300799) && m.editedAt >= m.date)) ||
        !(m.replyToMessageId === null || integer(m.replyToMessageId)) || !string(m.text, 16384)) return fail();
    seen.add(m.messageId);
    const result = { messageId: m.messageId, authorId: m.authorId, authorKind: m.authorKind as SourceObservationMessage["authorKind"],
      contentKind: m.contentKind as SourceObservationMessage["contentKind"], authorName: m.authorName, date: m.date, editedAt: m.editedAt, replyToMessageId: m.replyToMessageId, text: m.text };
    // Escaped controls can expand in JSON. Every admitted row must fit a page.
    if (bytes(JSON.stringify(result)) > SOURCE_ARCHIVE_LIMITS.outputBytes - 3072) fail();
    return result;
  });
  const result = { captureId: value.captureId, observedAt: value.observedAt, messages };
  if (bytes(JSON.stringify(result)) > SOURCE_ARCHIVE_LIMITS.batchBytes - 512) fail();
  return result;
}
type Entry = { name: string; sequence: number; captureId: string; size: number; identity: string };
type Inventory = { entries: Entry[]; encryptedBytes: number };
type Cursor = { snapshot: number; next: number; offset: number; fromDate: number; toDate: number; fingerprint: string };

/** The owner must prove the parent ACL and hold the sole gateway owner lock before open.
 * Directory checks establish identity, not Windows ACL ownership. Exclusive synced files
 * are immutable observations, not a complete chat mirror or a power-loss guarantee.
 * No partial-file repair, deletion, compaction, plaintext cache or resident derived key.
 * Authentication is lazy per accessed batch (and the latest batch at open/append).
 * Pagination fixes an observation-sequence ceiling only, never a Telegram snapshot.
 * Local file identity changes revoke continuation; owner deletion cannot be proven
 * absent across reopen. Failed/partial writes are preserved and never repaired.
 * A duplicate means matching authenticated bytes now exist; it does not recover
 * the original append's completion verdict. No automatic replay is provided.
 */
export async function openStandingSourceArchive(input: { directory: string; passphrase: string; binding: PilotBinding }): Promise<StandingSourceArchive> {
  const directory = input.directory, parent = dirname(directory), binding = { ...input.binding };
  let passphrase = input.passphrase, closed = false, poisoned = false, active: Promise<unknown> | null = null;
  const cursors = new Map<string, Cursor>();
  if (!string(passphrase, 4096) || passphrase.length < 16 || typeof binding.accountId !== "string" || typeof binding.peerId !== "string" ||
      !/^[1-9]\d{0,19}$/.test(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId)) fail("input");
  const healthy = (signal?: AbortSignal) => { if (closed) fail("closed"); if (poisoned) fail(); if (signal?.aborted) fail("aborted"); };
  try {
    await assertPilotPrivateDirectory(parent);
    try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    await assertPilotPrivateDirectory(directory);
    const initial = await lstat(directory, { bigint: true });
    async function check(signal?: AbortSignal) {
      healthy(signal); await assertPilotPrivateDirectory(parent); healthy(signal);
      await assertPilotPrivateDirectory(directory); healthy(signal);
      const now = await lstat(directory, { bigint: true }); healthy(signal);
      if (now.dev !== initial.dev || now.ino !== initial.ino) fail();
    }
    function quota(inv: Inventory): SourceArchiveQuota { return { batches: inv.entries.length, encryptedBytes: inv.encryptedBytes, maximumBatches: 8192, maximumEncryptedBytes: 268435456 }; }
    async function inventory(signal?: AbortSignal): Promise<Inventory> {
      await check(signal); const entries: Entry[] = []; let total = 0, headers = 0, count = 0;
      const listing = await opendir(directory);
      for await (const item of listing) {
        healthy(signal);
        if (++count > SOURCE_ARCHIVE_LIMITS.batches + 1) fail("quota");
        if (!item.isFile() || item.isSymbolicLink()) fail();
        const match = /^(\d{8})\.([0-9a-f-]{36})\.enc$/.exec(item.name);
        if (item.name === "archive.enc") headers++; else if (!match || !uuid(match[2]) || !integer(Number(match[1]), 99999999)) fail();
        const stat = await lstat(join(directory, item.name), { bigint: true }); healthy(signal);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(SOURCE_ARCHIVE_LIMITS.fileBytes)) fail();
        total += Number(stat.size); if (total > SOURCE_ARCHIVE_LIMITS.storeBytes) fail("quota");
        if (match) entries.push({ name: item.name, sequence: Number(match[1]), captureId: match[2]!, size: Number(stat.size), identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` });
      }
      entries.sort((a, b) => a.sequence - b.sequence);
      const ids = new Set<string>();
      if (entries.length > SOURCE_ARCHIVE_LIMITS.batches) fail("quota");
      if (headers !== 1) fail();
      for (let i = 0; i < entries.length; i++) { const e = entries[i]!; if (e.sequence !== i + 1 || ids.has(e.captureId)) fail(); ids.add(e.captureId); }
      await check(signal); return { entries, encryptedBytes: total };
    }
    async function read(name: string, signal?: AbortSignal): Promise<unknown> {
      await check(signal); const path = join(directory, name), before = await lstat(path, { bigint: true }); healthy(signal);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(SOURCE_ARCHIVE_LIMITS.fileBytes)) fail();
      const file = await open(path, "r"); let data: Buffer | undefined;
      try {
        healthy(signal); const stat = await file.stat({ bigint: true }); healthy(signal);
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.nlink !== 1n) fail();
        data = Buffer.alloc(Number(before.size) + 1); let offset = 0;
        while (offset < data.length) { const got = await file.read(data, offset, data.length - offset, offset); healthy(signal); if (!got.bytesRead) break; offset += got.bytesRead; }
        if (offset !== Number(before.size)) fail();
        const after = await lstat(path, { bigint: true }); healthy(signal);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.nlink !== 1n || after.isSymbolicLink()) fail();
        const plaintext = await decryptSession(data.subarray(0, offset).toString("utf8"), passphrase); healthy(signal);
        if (bytes(plaintext) > SOURCE_ARCHIVE_LIMITS.batchBytes) fail();
        const parsed: unknown = JSON.parse(plaintext);
        if (!exact(parsed, ["version", "accountId", "peerId", "sequence", "capture"]) || parsed.version !== "standing-source-archive-v1" || parsed.accountId !== binding.accountId || parsed.peerId !== binding.peerId) fail();
        return parsed;
      } finally { data?.fill(0); await file.close(); }
    }
    function envelope(sequence: number, value: SourceObservationCapture | null) { return { version: "standing-source-archive-v1", accountId: binding.accountId, peerId: binding.peerId, sequence, capture: value }; }
    async function readBatch(entry: Entry, signal?: AbortSignal) {
      try {
      const value = await read(entry.name, signal) as ReturnType<typeof envelope>;
      if (value.sequence !== entry.sequence) fail();
      const batch = capture(value.capture); if (batch.captureId !== entry.captureId) fail();
      return batch;
      } catch (e) { if (!closed && !signal?.aborted) poisoned = true; throw e; }
    }
    async function write(name: string, encrypted: string, signal?: AbortSignal) {
      await check(signal);
      try {
        const file = await open(join(directory, name), "wx", 0o600);
        try { healthy(signal); await file.writeFile(encrypted, "utf8"); healthy(signal); await file.sync(); healthy(signal); }
        finally { await file.close(); }
        await check(signal);
      }
      catch (e) { poisoned = true; throw e; }
    }
    // Only a newly empty directory may gain its binding header; an orphan batch refuses.
    const listing = await opendir(directory); let empty = true;
    for await (const _ of listing) { empty = false; break; }
    if (empty) await write("archive.enc", await encryptSession(JSON.stringify(envelope(0, null)), passphrase));
    const header = await read("archive.enc") as ReturnType<typeof envelope>;
    if (header.sequence !== 0 || header.capture !== null) fail();
    const startup = await inventory(); if (startup.entries.length) await readBatch(startup.entries.at(-1)!);
    function operation<T>(signal: AbortSignal, body: () => Promise<T>, commit?: (result: T) => void): Promise<T> {
      if (active) return Promise.reject(new StandingSourceArchiveError("busy"));
      const task = (async () => { try { await check(signal); const result = await body(); await check(signal); healthy(signal); commit?.(result); return result; }
        catch (e) { throw e instanceof StandingSourceArchiveError ? e : new StandingSourceArchiveError(); } })();
      active = task;
      void task.then(() => { if (active === task) active = null; }, () => { if (active === task) active = null; });
      return task;
    }
    const fingerprint = (inv: Inventory, n: number) => createHash("sha256").update(inv.entries.slice(0, n).map(e => `${e.name}:${e.identity}`).join("\n")).digest("hex");
    return {
      close: async () => { closed = true; passphrase = ""; cursors.clear(); try { await active; } catch { /* Failure remains consumed; no repair. */ } },
      append(value, signal) {
        let batch: SourceObservationCapture;
        try { batch = capture(value); } catch { return Promise.reject(new StandingSourceArchiveError("input")); }
        return operation(signal, async () => {
          const inv = await inventory(signal), previous = inv.entries.find(e => e.captureId === batch.captureId);
          if (previous) { if (JSON.stringify(await readBatch(previous, signal)) !== JSON.stringify(batch)) fail(); return { status: "duplicate" as const, sequence: previous.sequence, quota: quota(inv) }; }
          if (inv.entries.length >= SOURCE_ARCHIVE_LIMITS.batches) fail("quota");
          if (inv.entries.length) await readBatch(inv.entries.at(-1)!, signal);
          const sequence = inv.entries.length + 1, plain = JSON.stringify(envelope(sequence, batch));
          if (bytes(plain) > SOURCE_ARCHIVE_LIMITS.batchBytes) fail();
          const encrypted = await encryptSession(plain, passphrase); healthy(signal);
          if (bytes(encrypted) > SOURCE_ARCHIVE_LIMITS.fileBytes || inv.encryptedBytes + bytes(encrypted) > SOURCE_ARCHIVE_LIMITS.storeBytes) fail("quota");
          await write(`${String(sequence).padStart(8, "0")}.${batch.captureId}.enc`, encrypted, signal);
          const after = await inventory(signal);
          if (after.entries.length !== sequence || after.encryptedBytes !== inv.encryptedBytes + bytes(encrypted)) fail();
          return { status: "stored" as const, sequence, quota: quota(after) };
        });
      },
      query(options, signal) {
        const { fromDate, toDate, limit = 100, scanLimit = 32, cursor } = options;
        let admittedState: Cursor | undefined;
        return operation(signal, async () => {
          if (!integer(fromDate, 253402300799) || !integer(toDate, 253402300799) || fromDate > toDate || !integer(limit, 100) || !integer(scanLimit, 32) || (cursor !== undefined && !uuid(cursor))) fail("input");
          const inv = await inventory(signal);
          const saved = cursor === undefined ? undefined : cursors.get(cursor);
          if (cursor !== undefined && !saved) fail("cursor");
          if (!saved && cursors.size >= SOURCE_ARCHIVE_LIMITS.cursors) fail("quota");
          const state: Cursor = saved ? { ...saved } : { snapshot: inv.entries.length, next: 1, offset: 0, fromDate, toDate, fingerprint: fingerprint(inv, inv.entries.length) };
          if (state.fromDate !== fromDate || state.toDate !== toDate || inv.entries.length < state.snapshot || fingerprint(inv, state.snapshot) !== state.fingerprint) fail("cursor");
          const rows: SourceObservationRow[] = []; let scannedBatches = 0, scannedMessages = 0, rowBytes = 0;
          let exhausted: SourceArchivePage["coverage"]["exhausted"] = "observations";
          outer: while (state.next <= state.snapshot) {
            if (scannedBatches === scanLimit) { exhausted = "scan"; break; }
            const entry = inv.entries[state.next - 1]!; const batch = await readBatch(entry, signal); scannedBatches++;
            while (state.offset < batch.messages.length) {
              const message = batch.messages[state.offset]!; scannedMessages++;
              if (message.date >= fromDate && message.date <= toDate) {
                const row = { sequence: entry.sequence, captureId: batch.captureId, observedAt: batch.observedAt, message };
                const size = bytes(JSON.stringify(row)) + 1;
                if (rows.length === limit || rowBytes + size > SOURCE_ARCHIVE_LIMITS.outputBytes - 2048) { exhausted = "output"; break outer; }
                rows.push(row); rowBytes += size;
              }
              state.offset++;
            }
            state.next++; state.offset = 0;
          }
          await check(signal);
          const nextCursor = state.next <= state.snapshot ? randomUUID() : null;
          const result: SourceArchivePage = { rows, cursor: nextCursor, coverage: { kind: "observations-only", fromDate, toDate, throughSequence: state.snapshot, inventoryBatches: inv.entries.length,
            scannedBatches, scannedMessages, returnedMessages: rows.length, exhausted, completeChat: false }, quota: quota(inv) };
          if (bytes(JSON.stringify(result)) > SOURCE_ARCHIVE_LIMITS.outputBytes) fail();
          admittedState = state;
          return result;
        }, result => {
          if (cursor) cursors.delete(cursor); if (result.cursor) cursors.set(result.cursor, admittedState!);
        });
      },
    };
  } catch (e) { closed = true; passphrase = ""; throw e instanceof StandingSourceArchiveError ? e : new StandingSourceArchiveError(); }
}
