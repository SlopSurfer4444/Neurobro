import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, type Dir, type Dirent } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession } from "./session-crypto.js";
import { decodeStandingActionSlot, standingActionKey } from "./standing-action-journal.js";
import type { StandingPollObjectEvidence } from "./standing-object-evidence.js";
import { readStandingObjectIndexHint, standingObjectIndexDirectory } from "./standing-object-index.js";

export type StandingObjectFind = Readonly<{ kind: "poll"; query?: string; cursor?: string; limit?: number }>;
export type StandingObjectView = Readonly<{ objectRef: string; question: string; options: readonly string[]; observedAt: number; provenance: "verified-own-poll" }>;
export type StandingObjectPage = Readonly<{ objects: readonly StandingObjectView[]; cursor?: string; hasMore: boolean;
  coverage: Readonly<{ complete: boolean; scanned: number; unavailable: number; legacy: number }> }>;
export type StandingObjectCatalog = Readonly<{
  find(input: StandingObjectFind): Promise<StandingObjectPage>;
  resolve(objectRef: string): Promise<StandingPollObjectEvidence | undefined>;
  close(): Promise<void>;
}>;
export class StandingObjectCatalogError extends Error {
  constructor(readonly code: "input" | "cursor" | "storage" | "busy" | "closed") { super("STANDING_OBJECT_CATALOG_" + code.toUpperCase()); this.name = "StandingObjectCatalogError"; }
}
const fail = (code: StandingObjectCatalogError["code"]): never => { throw new StandingObjectCatalogError(code); };
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const version = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
const MAX_CIPHER = 64 * 1024, SCAN_PAGE = 16, MAX_KNOWN_OBJECTS = 4096, MAX_CURSORS = 4, MAX_CACHE = 128, MAX_PAGE_BYTES = 12 * 1024;
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
type Found = { key: string; fingerprint: string; evidence: StandingPollObjectEvidence };
type Scan = { dir: Dir; phase: "index" | "journal"; query: string; limit: number; next: Dirent | null; pending?: Found; scanned: number; unavailable: number; legacy: number; seen: Map<string, Pick<Found, "key" | "fingerprint">> };

/** Read-only discovery over immutable encrypted terminal slots. Cursors own a
 * directory iterator, are single-use and scoped to their query and page limit.
 * A finite scan is not a filesystem snapshot: complete only describes this
 * traversal. No marker, directory, intent, migration or Telegram call is made. */
export async function openStandingObjectCatalog(input: Readonly<{ directory: string; passphrase: string; accountId: string; chatId: string }>): Promise<StandingObjectCatalog> {
  const args = data(input, ["directory", "passphrase", "accountId", "chatId"]);
  if (typeof args.directory !== "string" || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory ||
      typeof args.passphrase !== "string" || args.passphrase.length < 16 || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString("utf8") !== args.passphrase ||
      typeof args.accountId !== "string" || typeof args.chatId !== "string") return fail("input");
  try { standingActionKey({ accountId: args.accountId, chatId: args.chatId, primaryMessageId: 1, operationSlot: 0 }); } catch { return fail("input"); }
  const directory = args.directory, accountId = args.accountId, chatId = args.chatId;
  let passphrase = args.passphrase, root: BigIntStats | undefined, indexRoot: BigIntStats | undefined, closed = false, active: Promise<unknown> | undefined;
  const cursors = new Map<string, Scan>(), cache = new Map<string, Found>(), knownKeys = new Map<string, string>();
  let conflicted = false;
  const check = async (): Promise<boolean> => {
    if (closed) return fail("closed");
    if (conflicted) return fail("storage");
    let current: BigIntStats;
    try { current = await lstat(directory, { bigint: true }); } catch (e) { if (missing(e) && !root) return false; return fail("storage"); }
    await assertPilotPrivateDirectory(directory);
    if (root && !same(root, current)) return fail("storage");
    root ??= current;
    if (closed) return fail("closed");
    return true;
  };
  const operation = async <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return fail("closed"); if (active) return fail("busy");
    const pending = Promise.resolve().then(work); active = pending;
    try { return await pending; } catch (e) { if (e instanceof StandingObjectCatalogError) throw e; return fail("storage"); }
    finally { if (active === pending) active = undefined; }
  };
  const checkIndex = async (): Promise<boolean> => {
    await check(); const path = standingObjectIndexDirectory(directory); let current: BigIntStats;
    try { current = await lstat(path, { bigint: true }); } catch (e) { if (missing(e) && !indexRoot) return false; return fail("storage"); }
    await assertPilotPrivateDirectory(path);
    if (indexRoot && !same(indexRoot, current)) return fail("storage"); indexRoot ??= current;
    if (closed) return fail("closed"); return true;
  };
  const readSlot = async (key: string): Promise<{ found?: Found; legacy: boolean }> => {
    if (!/^[0-9a-f]{64}$/u.test(key)) return fail("storage");
    await check(); const slot = join(directory, key); await assertPilotPrivateDirectory(slot);
    const slotBefore = await lstat(slot, { bigint: true }), versions: string[] = [];
    const files: { path: string; before: BigIntStats }[] = [];
    const read = async (name: string): Promise<unknown> => {
      const path = join(slot, name), before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
      const handle = await open(path, "r"); let bytes: Buffer | undefined;
      try {
        const inside = await handle.stat({ bigint: true });
        if (!inside.isFile() || !same(before, inside) || version(before) !== version(inside) || inside.nlink !== 1n) return fail("storage");
        bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
        while (count < bytes.length) { if (closed) return fail("closed"); const got = await handle.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
        if (count !== Number(before.size)) return fail("storage");
        const decoded = JSON.parse(await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase));
        versions.push(version(before)); files.push({ path, before }); return decoded;
      } finally { bytes?.fill(0); await handle.close(); }
    };
    const intent = await read("intent.enc"), terminal = await read("terminal.enc");
    for (const file of files) {
      const after = await lstat(file.path, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || version(after) !== version(file.before)) return fail("storage");
    }
    await assertPilotPrivateDirectory(slot); const slotAfter = await lstat(slot, { bigint: true });
    if (!same(slotBefore, slotAfter)) return fail("storage");
    await check();
    const decoded = decodeStandingActionSlot(intent, terminal, key);
    if (decoded.binding.accountId !== accountId || decoded.binding.chatId !== chatId) return { legacy: false };
    if (decoded.terminal.state === "unknown") return fail("storage");
    const evidence = decoded.terminal.privateObjectEvidence;
    if (!evidence) return { legacy: decoded.terminal.state === "verified" && !!decoded.intent.action && typeof decoded.intent.action === "object" && !Array.isArray(decoded.intent.action) && (decoded.intent.action as Record<string, unknown>).kind === "create-poll" };
    return { legacy: false, found: { key, evidence, fingerprint: createHash("sha256").update([version(slotBefore), ...versions, JSON.stringify(evidence)].join("\n")).digest("hex") } };
  };
  const remember = (found: Found) => {
    const ref = found.evidence.objectRef, previous = knownKeys.get(ref);
    if (previous !== undefined && previous !== found.key || previous === undefined && knownKeys.size >= MAX_KNOWN_OBJECTS) { conflicted = true; cache.clear(); return fail("storage"); }
    knownKeys.set(ref, found.key); cache.delete(ref); cache.set(ref, found); while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  };
  const readIndexed = async (objectRef: string): Promise<Found | undefined> => {
    if (!await checkIndex()) return undefined;
    const hint = await readStandingObjectIndexHint(directory, passphrase, objectRef, async () => { await checkIndex(); });
    if (hint.accountId !== accountId || hint.chatId !== chatId) return undefined;
    const { found } = await readSlot(hint.key);
    if (!found || found.evidence.objectRef !== objectRef) return fail("storage");
    return found;
  };
  const stopScan = async (scan: Scan) => { await scan.dir.close().catch(() => {}); };
  const page = (objects: StandingObjectView[], scan?: Scan, cursor?: string): StandingObjectPage => Object.freeze({ objects: Object.freeze(objects), ...(cursor ? { cursor } : {}), hasMore: !!cursor,
    coverage: Object.freeze({ complete: !cursor && (!scan || scan.phase === "journal" && scan.next === null && !scan.pending && scan.unavailable === 0 && scan.legacy === 0), scanned: scan?.scanned ?? 0, unavailable: scan?.unavailable ?? 0, legacy: scan?.legacy ?? 0 }) });
  try { await check(); } catch (e) { passphrase = ""; if (e instanceof StandingObjectCatalogError) throw e; return fail("storage"); }
  return Object.freeze<StandingObjectCatalog>({
    find(value) {
      let query: string, limit: number, cursor: string | undefined;
      try {
        const v = data(value, ["kind"], ["query", "limit", "cursor"]);
        if (v.kind !== "poll" || Object.hasOwn(v, "query") && (typeof v.query !== "string" || v.query.length > 128 || Buffer.from(v.query).toString("utf8") !== v.query || /[\u0000-\u001f\u007f-\u009f]/u.test(v.query)) ||
            Object.hasOwn(v, "limit") && (!Number.isInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 10) ||
            Object.hasOwn(v, "cursor") && (typeof v.cursor !== "string" || !/^cur_[0-9a-f]{48}$/u.test(v.cursor))) return Promise.reject(new StandingObjectCatalogError("input"));
        query = ((v.query as string | undefined) ?? "").trim().toLowerCase(); limit = (v.limit as number | undefined) ?? 5; cursor = v.cursor as string | undefined;
      } catch { return Promise.reject(new StandingObjectCatalogError("input")); }
      return operation(async () => {
        let scan: Scan | undefined;
        if (cursor) { scan = cursors.get(cursor); if (!scan || scan.query !== query || scan.limit !== limit) return fail("cursor"); cursors.delete(cursor); }
        try {
          if (!await check()) return page([]);
          if (!scan) {
            if (cursors.size >= MAX_CURSORS) { const oldest = cursors.keys().next().value!; await stopScan(cursors.get(oldest)!); cursors.delete(oldest); }
            let indexed = false, indexGap = 0;
            try { indexed = await checkIndex(); } catch { if (closed) return fail("closed"); await check(); indexGap++; }
            const dir = await opendir(indexed ? standingObjectIndexDirectory(directory) : directory, { bufferSize: 1 });
            scan = { dir, phase: indexed ? "index" : "journal", query, limit, next: null, scanned: 0, unavailable: indexGap, legacy: 0, seen: new Map() };
            await check(); scan.next = await dir.read();
          }
          const objects: StandingObjectView[] = []; let worked = 0;
          while (objects.length < limit && (scan.pending || scan.next || scan.phase === "index") && worked < SCAN_PAGE) {
            if (!scan.pending && !scan.next && scan.phase === "index") {
              await stopScan(scan); await check(); scan.dir = await opendir(directory, { bufferSize: 1 }); scan.phase = "journal"; scan.next = await scan.dir.read(); continue;
            }
            await check(); let found = scan.pending; delete scan.pending;
            if (!found) {
              const entry = scan.next!; scan.next = await scan.dir.read(); scan.scanned++; worked++;
              const indexed = scan.phase === "index";
              if (entry.isSymbolicLink() || (indexed ? !entry.isFile() || !/^obj_[0-9a-f]{48}\.enc$/u.test(entry.name) : !entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name))) { scan.unavailable++; continue; }
              try {
                if (indexed) found = await readIndexed(entry.name.slice(0, -4));
                else { const read = await readSlot(entry.name); if (read.legacy) scan.legacy++; found = read.found; }
              }
              catch (e) { if (closed) return fail("closed"); await check(); scan.unavailable++; continue; }
            }
            if (!found) continue;
            const e = found.evidence, p = e.record.poll;
            const known = knownKeys.get(e.objectRef);
            if (known !== undefined && known !== found.key) { conflicted = true; cache.clear(); return fail("storage"); }
            if (query && ![p.question, ...p.options].some(s => s.toLowerCase().includes(query))) continue;
            const seen = scan.seen.get(e.objectRef);
            if (seen) {
              if (seen.key !== found.key || seen.fingerprint !== found.fingerprint) { conflicted = true; cache.clear(); return fail("storage"); }
              continue;
            }
            const view: StandingObjectView = Object.freeze({ objectRef: e.objectRef, question: p.question, options: p.options, observedAt: e.observedAt, provenance: "verified-own-poll" });
            if (Buffer.byteLength(JSON.stringify([...objects, view])) > MAX_PAGE_BYTES - 1024) { scan.pending = found; break; }
            scan.seen.set(e.objectRef, { key: found.key, fingerprint: found.fingerprint }); remember(found); objects.push(view);
          }
          await check();
          if (scan.next || scan.pending || scan.phase === "index") { const next = "cur_" + randomBytes(24).toString("hex"); cursors.set(next, scan); return page(objects, scan, next); }
          await stopScan(scan); return page(objects, scan);
        } catch (e) { if (scan) await stopScan(scan); throw e; }
      });
    },
    resolve(objectRef) {
      if (typeof objectRef !== "string" || !/^obj_[0-9a-f]{48}$/u.test(objectRef)) return Promise.reject(new StandingObjectCatalogError("input"));
      return operation(async () => {
        const cached = cache.get(objectRef);
        try {
          if (!cached) {
            const indexed = await readIndexed(objectRef); if (!indexed) return undefined;
            remember(indexed); return indexed.evidence;
          }
          const read = await readSlot(cached.key), found = read.found;
          if (!found || found.evidence.objectRef !== objectRef || found.fingerprint !== cached.fingerprint) { cache.delete(objectRef); return undefined; }
          return found.evidence;
        } catch (e) { cache.delete(objectRef); if (closed) return fail("closed"); await check(); return undefined; }
      });
    },
    async close() {
      closed = true;
      try { await active; } catch { /* Join the operation without replacing its result. */ }
      for (const scan of cursors.values()) await stopScan(scan);
      cursors.clear(); cache.clear(); knownKeys.clear(); passphrase = "";
    },
  });
}
