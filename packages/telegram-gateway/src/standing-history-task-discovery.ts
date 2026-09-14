import { randomBytes } from "node:crypto";
import { type BigIntStats, type Dir, type Dirent } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";

export type StandingHistoryTaskDiscoveryPage = Readonly<{
  tasks: readonly StandingHistoryTaskIntent[]; cursor?: string; hasMore: boolean;
  coverage: Readonly<{ complete: boolean; scanned: number; unavailable: number; foreign: number; root: "absent" | "present" }>;
}>;
export type StandingHistoryTaskDiscovery = Readonly<{
  find(input?: Readonly<{ cursor?: string; limit?: number }>): Promise<StandingHistoryTaskDiscoveryPage>;
  close(): Promise<void>;
}>;
export class StandingHistoryTaskDiscoveryError extends Error {
  constructor(readonly code: "input" | "cursor" | "storage" | "busy" | "closed" | "aborted") {
    super("STANDING_HISTORY_TASK_DISCOVERY_" + code.toUpperCase()); this.name = "StandingHistoryTaskDiscoveryError";
  }
}
const fail = (code: StandingHistoryTaskDiscoveryError["code"]): never => { throw new StandingHistoryTaskDiscoveryError(code); };
const DOMAIN = "DecadansNeurobro/standing-history-task/v1", MAX_CIPHER = 192 * 1024, MAX_OUTPUT = 32 * 1024, SCAN_PAGE = 16, MAX_CURSORS = 4;
const taskIdValid = (v: unknown): v is string => typeof v === "string" && /^htask_[0-9a-f]{48}$/u.test(v);
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const version = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
type Found = { intent: StandingHistoryTaskIntent; stamp: string };
type Scan = { dir: Dir; next: Dirent | null; pending?: Found; limit: number; scanned: number; unavailable: number; foreign: number };

/** Host-private intent discovery, not a model tool or proof of runnable status.
 * Exact store reopen still authenticates the page chain and refuses bad tails.
 * This noncreating iterator scans one known protected parent/account/chat only.
 * Coverage is a traversal observation, not a filesystem snapshot or a guarantee
 * of latest ordering. Single-use cursors retain progress without a total page
 * ceiling; old iterator eviction is explicit through a refused stale cursor. */
export async function openStandingHistoryTaskDiscovery(input: Readonly<{
  directory: string; passphrase: string; accountId: string; chatId: string; signal?: AbortSignal;
}>): Promise<StandingHistoryTaskDiscovery> {
  const args = data(input, ["directory", "passphrase", "accountId", "chatId"], ["signal"]);
  if (typeof args.directory !== "string" || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory ||
      typeof args.passphrase !== "string" || args.passphrase.length < 16 || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString("utf8") !== args.passphrase ||
      typeof args.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(args.accountId) || typeof args.chatId !== "string" || !/^-[1-9]\d{0,19}$/u.test(args.chatId) ||
      Object.hasOwn(args, "signal") && (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal))) return fail("input");
  const directory = args.directory, accountId = args.accountId, chatId = args.chatId, signal = args.signal as AbortSignal | undefined;
  let passphrase = args.passphrase, root: BigIntStats | undefined, revoked: "closed" | "aborted" | undefined;
  let active: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  const cursors = new Map<string, Scan>();
  const live = () => { if (revoked) return fail(revoked); if (signal?.aborted) return fail("aborted"); };
  const check = async (): Promise<boolean> => {
    live(); let current: BigIntStats;
    try { current = await lstat(directory, { bigint: true }); } catch (e) { live(); if (missing(e) && !root) return false; return fail("storage"); }
    await assertPilotPrivateDirectory(directory); if (root && !sameDirectory(root, current)) return fail("storage"); root ??= current;
    live(); return true;
  };
  const stopScan = async (scan: Scan) => { delete scan.pending; await scan.dir.close().catch(() => {}); };
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      try { await active; } catch { /* Join without replacing the operation result. */ }
      for (const scan of cursors.values()) await stopScan(scan);
      cursors.clear(); passphrase = ""; signal?.removeEventListener("abort", abort);
    })();
    return closing;
  };
  const abort = () => { revoked = "aborted"; void shutdown(); };
  signal?.addEventListener("abort", abort, { once: true });
  const operation = async <T>(work: () => Promise<T>): Promise<T> => {
    live(); if (active) return fail("busy"); const pending = Promise.resolve().then(work); active = pending;
    try { return await pending; } catch (e) { if (e instanceof StandingHistoryTaskDiscoveryError) throw e; return fail("storage"); }
    finally { if (active === pending) active = undefined; }
  };
  const readIntent = async (taskId: string): Promise<Found> => {
    if (!taskIdValid(taskId)) return fail("storage"); await check();
    const slot = join(directory, taskId); await assertPilotPrivateDirectory(slot); const owner = await lstat(slot, { bigint: true });
    const path = join(slot, "intent.enc"), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true }); if (!inside.isFile() || version(inside) !== version(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { live(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size)) return fail("storage");
      const decoded = data(JSON.parse(await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase)), ["domain", "taskId", "kind", "intent"]);
      const intent = snapshotStandingHistoryTaskIntent(decoded.intent);
      if (decoded.domain !== DOMAIN || decoded.taskId !== taskId || decoded.kind !== "intent" || intent.taskId !== taskId) return fail("storage");
      const after = await lstat(path, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || version(after) !== version(before)) return fail("storage");
      await assertPilotPrivateDirectory(slot); const current = await lstat(slot, { bigint: true }); if (!sameDirectory(owner, current)) return fail("storage");
      await check(); return { intent, stamp: [owner.dev, owner.ino, version(after)].join(":") };
    } finally { bytes?.fill(0); await file.close(); }
  };
  const page = (tasks: StandingHistoryTaskIntent[], scan?: Scan, cursor?: string): StandingHistoryTaskDiscoveryPage => Object.freeze({ tasks: Object.freeze(tasks), ...(cursor ? { cursor } : {}), hasMore: !!cursor,
    coverage: Object.freeze({ complete: !cursor && (!scan || scan.unavailable === 0 && scan.foreign === 0 && !scan.next && !scan.pending),
      scanned: scan?.scanned ?? 0, unavailable: scan?.unavailable ?? 0, foreign: scan?.foreign ?? 0, root: root ? "present" : "absent" }) });
  try { await operation(async () => { await check(); }); }
  catch (e) { signal?.removeEventListener("abort", abort); passphrase = ""; if (e instanceof StandingHistoryTaskDiscoveryError) throw e; return fail("storage"); }
  return Object.freeze<StandingHistoryTaskDiscovery>({
    async find(value = {}) {
      const request = data(value, [], ["cursor", "limit"]);
      if (Object.hasOwn(request, "cursor") && (typeof request.cursor !== "string" || !/^hcur_[0-9a-f]{48}$/u.test(request.cursor)) ||
          Object.hasOwn(request, "limit") && (!Number.isInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 10)) return fail("input");
      const cursor = request.cursor as string | undefined, limit = (request.limit as number | undefined) ?? 5;
      return operation(async () => {
        let scan: Scan | undefined;
        if (cursor) { scan = cursors.get(cursor); if (!scan || scan.limit !== limit) return fail("cursor"); cursors.delete(cursor); }
        try {
          if (!await check()) return page([]);
          if (!scan) {
            if (cursors.size >= MAX_CURSORS) { const oldest = cursors.keys().next().value!; await stopScan(cursors.get(oldest)!); cursors.delete(oldest); }
            const dir = await opendir(directory, { bufferSize: 1 });
            scan = { dir, next: null, limit, scanned: 0, unavailable: 0, foreign: 0 }; await check(); scan.next = await dir.read();
          }
          const tasks: StandingHistoryTaskIntent[] = []; let worked = 0;
          while (tasks.length < limit && (scan.next || scan.pending) && worked < SCAN_PAGE) {
            await check(); let found: Found;
            if (scan.pending) {
              const pending = scan.pending; delete scan.pending; worked++;
              try { found = await readIntent(pending.intent.taskId); if (found.stamp !== pending.stamp) return fail("storage"); }
              catch { live(); await check(); scan.unavailable++; continue; }
            } else {
              const entry = scan.next!; scan.next = await scan.dir.read(); scan.scanned++; worked++;
              if (!entry.isDirectory() || entry.isSymbolicLink() || !taskIdValid(entry.name)) { scan.unavailable++; continue; }
              try { found = await readIntent(entry.name); } catch { live(); await check(); scan.unavailable++; continue; }
            }
            if (found.intent.accountId !== accountId || found.intent.chatId !== chatId) { scan.foreign++; continue; }
            if (Buffer.byteLength(JSON.stringify([...tasks, found.intent])) > MAX_OUTPUT - 1024) { scan.pending = found; break; }
            tasks.push(found.intent);
          }
          await check();
          if (scan.next || scan.pending) { const next = "hcur_" + randomBytes(24).toString("hex"); cursors.set(next, scan); return page(tasks, scan, next); }
          await stopScan(scan); return page(tasks, scan);
        } catch (e) { if (scan) await stopScan(scan); throw e; }
      });
    },
    close() { revoked ??= "closed"; return shutdown(); },
  });
}
