import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";

export type StandingHistoryTaskControlStatus = Readonly<{
  storage: "ready" | "tail-refused"; state: "queued" | "cancelled"; revision: 0 | 1; headHash: string;
}>;
export type StandingHistoryTaskControlStore = Readonly<{
  status(): Promise<StandingHistoryTaskControlStatus>;
  cancel(input: Readonly<{ expectedRevision: 0 | 1 }>): Promise<StandingHistoryTaskControlStatus>;
  close(): Promise<void>;
}>;
export class StandingHistoryTaskControlStoreError extends Error {
  constructor(readonly code: "input" | "binding" | "consumed" | "conflict" | "tail" | "limit" | "storage" | "busy" | "closed" | "aborted") {
    super("STANDING_HISTORY_TASK_CONTROL_" + code.toUpperCase()); this.name = "StandingHistoryTaskControlStoreError";
  }
}
const fail = (code: StandingHistoryTaskControlStoreError["code"]): never => { throw new StandingHistoryTaskControlStoreError(code); };
const DOMAIN = "DecadansNeurobro/standing-history-task-control/v1";
const HEADER = "intent.enc", CANCEL = "cancel-000001.enc", MAX_PLAIN = 32 * 1024, MAX_CIPHER = 64 * 1024;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}

/** A cancellation admission record in a separate host-owned control parent.
 * Queued does not establish healthy read/analysis stores, a settled model owner,
 * or permission to deliver. The host authenticates the cancellation actor and
 * revokes/joins its own active task step. This module never closes those owners.
 * Completion is deliberately absent until final delivery evidence is defined.
 * Immutable sync/readback commits survive lost return acknowledgements. Damaged
 * tails are retained and permanently refuse writes; there is no repair/replay.
 * File data is synced, but power-loss directory durability is not promised. */
export async function openStandingHistoryTaskControlStore(input: Readonly<{
  directory: string; passphrase: string; intent: StandingHistoryTaskIntent; mode: "create" | "open"; signal?: AbortSignal;
}>): Promise<StandingHistoryTaskControlStore> {
  const args = data(input, ["directory", "passphrase", "intent", "mode"], ["signal"]);
  let intent: StandingHistoryTaskIntent;
  try { intent = snapshotStandingHistoryTaskIntent(args.intent); } catch { return fail("input"); }
  if (typeof args.directory !== "string" || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory ||
      typeof args.passphrase !== "string" || args.passphrase.length < 16 || !args.passphrase.trim() || args.passphrase.includes("\0") ||
      Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString("utf8") !== args.passphrase ||
      args.mode !== "create" && args.mode !== "open" ||
      Object.hasOwn(args, "signal") && (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal))) return fail("input");
  const directory = args.directory, slot = join(directory, intent.taskId), signal = args.signal as AbortSignal | undefined;
  const header = { domain: DOMAIN, taskId: intent.taskId, kind: "intent", intent, revision: 0, state: "queued" };
  const intentHash = hash(header);
  const cancellation = { domain: DOMAIN, taskId: intent.taskId, kind: "cancel", intentHash, previousHash: intentHash, revision: 1, state: "cancelled" };
  let passphrase = args.passphrase, tail = false, revision: 0 | 1 = 0, headHash = intentHash;
  let revoked: "closed" | "aborted" | undefined, active: Promise<unknown> | undefined, closing: Promise<void> | undefined, initializing = true;
  let root: BigIntStats, owner: BigIntStats;
  const versions = new Map<string, string>();
  const live = () => { if (revoked) return fail(revoked); if (signal?.aborted) return fail("aborted"); };
  const shutdown = (): Promise<void> => {
    closing ??= (async () => { try { await active; } catch { /* Join actual admitted I/O and crypto. */ }
      finally { passphrase = ""; signal?.removeEventListener("abort", abort); } })();
    return closing;
  };
  const abort = () => { revoked ??= "aborted"; if (!initializing) void shutdown(); };
  signal?.addEventListener("abort", abort, { once: true });
  const check = async (known = false) => {
    live(); await assertPilotPrivateDirectory(directory); await assertPilotPrivateDirectory(slot);
    if (!sameDirectory(root, await lstat(directory, { bigint: true })) || !sameDirectory(owner, await lstat(slot, { bigint: true }))) return fail("storage");
    if (known) for (const [name, expected] of versions) {
      live(); const s = await lstat(join(slot, name), { bigint: true });
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || stamp(s) !== expected) return fail("storage");
    }
    live();
  };
  const read = async (name: string): Promise<{ value: unknown; version: string }> => {
    await check(); const path = join(slot, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true });
      if (!inside.isFile() || stamp(inside) !== stamp(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { live(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size)) return fail("storage");
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); live();
      if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
      const value: unknown = JSON.parse(plain), after = await lstat(path, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || stamp(after) !== stamp(before)) return fail("storage");
      await check(); return { value, version: stamp(after) };
    } finally { bytes?.fill(0); await file.close(); }
  };
  const write = async (name: string, value: unknown): Promise<string> => {
    const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
    await check(); const cipher = await encryptSession(plain, passphrase);
    if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("limit"); await check();
    const file = await open(join(slot, name), "wx", 0o600);
    try { await file.writeFile(cipher); await file.sync(); } finally { await file.close(); }
    const verified = await read(name); if (!same(verified.value, value)) return fail("storage"); return verified.version;
  };
  // At most three directory entries are read: two canonical files plus one gap.
  const inventory = async (): Promise<boolean> => {
    await check(); const dir = await opendir(slot, { bufferSize: 1 });
    const expected = new Set(revision ? [HEADER, CANCEL] : [HEADER]);
    try {
      for (let n = 0; n < 3; n++) {
        live(); const entry = await dir.read();
        if (!entry) { await check(); return expected.size === 0; }
        if (!entry.isFile() || entry.isSymbolicLink() || !expected.delete(entry.name)) return false;
      }
      return false;
    } finally { await dir.close(); }
  };
  const status = (): StandingHistoryTaskControlStatus => Object.freeze({ storage: tail ? "tail-refused" : "ready", state: revision ? "cancelled" : "queued", revision, headHash });
  try {
    live(); await assertPilotPrivateDirectory(directory); root = await lstat(directory, { bigint: true }); live();
    if (args.mode === "create") {
      try { await mkdir(slot, { mode: 0o700 }); } catch (e) { return fail((e as NodeJS.ErrnoException)?.code === "EEXIST" ? "consumed" : "storage"); }
    }
    live(); await assertPilotPrivateDirectory(slot); owner = await lstat(slot, { bigint: true });
    if (args.mode === "create") versions.set(HEADER, await write(HEADER, header));
    else {
      const saved = await read(HEADER), decoded = data(saved.value, ["domain", "taskId", "kind", "intent", "revision", "state"]);
      if (decoded.domain !== DOMAIN || decoded.taskId !== intent.taskId || decoded.kind !== "intent" || decoded.revision !== 0 || decoded.state !== "queued") return fail("binding");
      let savedIntent: StandingHistoryTaskIntent;
      try { savedIntent = snapshotStandingHistoryTaskIntent(decoded.intent); } catch { return fail("binding"); }
      if (!same(savedIntent, intent)) return fail("binding"); versions.set(HEADER, saved.version);
      try {
        const savedCancel = await read(CANCEL);
        data(savedCancel.value, ["domain", "taskId", "kind", "intentHash", "previousHash", "revision", "state"]);
        if (!same(savedCancel.value, cancellation)) return fail("binding");
        versions.set(CANCEL, savedCancel.version); revision = 1; headHash = hash(cancellation);
      } catch (e) { live(); if (!missing(e)) tail = true; }
    }
    if (!await inventory()) tail = true;
    await check(true); initializing = false; live();
  } catch (e) {
    initializing = false; passphrase = ""; signal?.removeEventListener("abort", abort);
    if (e instanceof StandingHistoryTaskControlStoreError) throw e; return fail("storage");
  }
  const operation = <T>(work: () => Promise<T>): Promise<T> => {
    live(); if (active) return fail("busy");
    const pending = Promise.resolve().then(async () => { await check(true); return work(); }); active = pending;
    return pending.catch(e => { if (e instanceof StandingHistoryTaskControlStoreError) throw e; return fail("storage"); })
      .finally(() => { if (active === pending) active = undefined; });
  };
  return Object.freeze<StandingHistoryTaskControlStore>({
    async status() {
      return operation(async () => { if (!await inventory()) tail = true; await check(true); return status(); });
    },
    async cancel(value) {
      const request = data(value, ["expectedRevision"]), expected = request.expectedRevision;
      if (expected !== 0 && expected !== 1) return fail("input");
      return operation(async () => {
        if (!await inventory()) tail = true;
        if (tail) return fail("tail");
        // There is exactly one possible transition. Both a current revision and
        // the original expected revision identify the same idempotent retry.
        if (revision === 1) return status();
        if (expected !== revision) return fail("conflict");
        try {
          const version = await write(CANCEL, cancellation); await check(true);
          versions.set(CANCEL, version); revision = 1; headHash = hash(cancellation);
          if (!await inventory()) { tail = true; return fail("tail"); }
          await check(true); return status();
        } catch (e) { tail = true; throw e; }
      });
    },
    close() { revoked ??= "closed"; return shutdown(); }
  });
}
