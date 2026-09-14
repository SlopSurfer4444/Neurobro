import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";

export type StandingHistoryTaskDispositionReason = "coverage" | "stale" | "consumed-without-prepared" | "source-page-quota" | "overflow";
export type StandingHistoryTaskDisposition = Readonly<{
  schema: "standing-history-task-disposition-v1"; reason: StandingHistoryTaskDispositionReason; sourceHead: string; analysisHead: string;
}>;
export type StandingHistoryTaskDispositionStatus = Readonly<{ storage: "absent" | "unavailable" }> |
  Readonly<{ storage: "ready"; disposition: StandingHistoryTaskDisposition }>;
export type StandingHistoryTaskDispositionInput = Readonly<{
  directory: string; passphrase: string; intent: StandingHistoryTaskIntent; sourceHead: string; analysisHead: string; signal?: AbortSignal;
}>;
export class StandingHistoryTaskDispositionError extends Error {
  constructor(readonly code: "input" | "storage" | "conflict" | "aborted") { super("STANDING_HISTORY_TASK_DISPOSITION_" + code.toUpperCase()); }
}
const fail = (code: StandingHistoryTaskDispositionError["code"]): never => { throw new StandingHistoryTaskDispositionError(code); };
const DOMAIN = "DecadansNeurobro/standing-history-task-disposition/v1";
const REASONS = ["coverage", "stale", "consumed-without-prepared", "source-page-quota", "overflow"] as const;
const MAX_PLAIN = 32768, MAX_CIPHER = 65536;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const identity = (s: BigIntStats) => [s.dev, s.ino].join(":");
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function config(value: unknown, writing: boolean): StandingHistoryTaskDispositionInput & { reason?: StandingHistoryTaskDispositionReason } {
  const v = data(value, ["directory", "passphrase", "intent", "sourceHead", "analysisHead", ...(writing ? ["reason"] : [])], ["signal"]);
  let intent: StandingHistoryTaskIntent; try { intent = snapshotStandingHistoryTaskIntent(v.intent); } catch { return fail("input"); }
  if (typeof v.directory !== "string" || !isAbsolute(v.directory) || resolve(v.directory) !== v.directory ||
      typeof v.passphrase !== "string" || v.passphrase.length < 16 || !v.passphrase.trim() || v.passphrase.includes("\0") ||
      Buffer.byteLength(v.passphrase) > 4096 || Buffer.from(v.passphrase).toString() !== v.passphrase ||
      typeof v.sourceHead !== "string" || !/^[0-9a-f]{64}$/.test(v.sourceHead) || typeof v.analysisHead !== "string" || !/^[0-9a-f]{64}$/.test(v.analysisHead) ||
      writing && !REASONS.includes(v.reason as StandingHistoryTaskDispositionReason) ||
      Object.hasOwn(v, "signal") && (types.isProxy(v.signal) || !(v.signal instanceof AbortSignal))) return fail("input");
  return Object.freeze({ directory: v.directory, passphrase: v.passphrase, intent, sourceHead: v.sourceHead, analysisHead: v.analysisHead,
    ...(writing ? { reason: v.reason as StandingHistoryTaskDispositionReason } : {}), ...(v.signal ? { signal: v.signal as AbortSignal } : {}) });
}

/** Host records a task-local fault only after its operation and cleanup joined.
 * This module does not prove that join, authorize a retry/send, or duplicate
 * cancellation/delivery records. Different heads select a different inspection
 * record; they never grant replay. One immutable reason per exact pair; sibling
 * head records are allowed and never enumerated. Reads do not create anything.
 * Parent must already exist. Partial slots/records are retained, not repaired.
 * File sync is used; power-loss directory durability is not claimed. */
async function operation(args: ReturnType<typeof config>, writing: boolean): Promise<StandingHistoryTaskDispositionStatus> {
  let passphrase = args.passphrase;
  const live = () => { if (args.signal?.aborted) return fail("aborted"); };
  const slot = join(args.directory, args.intent.taskId), name = "heads-" + hash([args.sourceHead, args.analysisHead]) + ".enc";
  const header = { domain: DOMAIN, kind: "intent", intent: args.intent };
  let root: BigIntStats, owner: BigIntStats, headerStamp: string | undefined;
  const directoryStat = async (path: string) => { live(); await assertPilotPrivateDirectory(path); const s = await lstat(path, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) return fail("storage"); live(); return s; };
  const guard = async () => {
    if (identity(await directoryStat(args.directory)) !== identity(root) || identity(await directoryStat(slot)) !== identity(owner)) return fail("storage");
    if (headerStamp !== undefined && stamp(await lstat(join(slot, "intent.enc"), { bigint: true })) !== headerStamp) return fail("storage"); live();
  };
  const read = async (fileName: string): Promise<{ value: unknown; version: string }> => {
    await guard(); const path = join(slot, fileName), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      if (stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { live(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size) || stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail("storage");
      const cipher = bytes.subarray(0, count).toString("utf8"); if (!Buffer.from(cipher).equals(bytes.subarray(0, count))) return fail("storage");
      const plain = await decryptSession(cipher, passphrase); live(); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("storage");
      if (stamp(await lstat(path, { bigint: true })) !== stamp(before) || stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail("storage");
      await guard(); return { value: JSON.parse(plain) as unknown, version: stamp(before) };
    } finally { bytes?.fill(0); await file.close(); }
  };
  const write = async (fileName: string, value: unknown) => {
    const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("storage");
    const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("storage"); await guard();
    const file = await open(join(slot, fileName), "wx", 0o600);
    try { await file.writeFile(cipher); await file.sync(); } finally { await file.close(); }
    const saved = await read(fileName); if (!equal(saved.value, value)) return fail("storage"); return saved.version;
  };
  const decode = (value: unknown): StandingHistoryTaskDisposition => {
    const v = data(value, ["domain", "kind", "intentHash", "disposition"]), d = data(v.disposition, ["schema", "reason", "sourceHead", "analysisHead"]);
    if (v.domain !== DOMAIN || v.kind !== "blocked" || v.intentHash !== hash(header) || d.schema !== "standing-history-task-disposition-v1" ||
        d.sourceHead !== args.sourceHead || d.analysisHead !== args.analysisHead || !REASONS.includes(d.reason as StandingHistoryTaskDispositionReason)) return fail("storage");
    return Object.freeze({ schema: "standing-history-task-disposition-v1", reason: d.reason as StandingHistoryTaskDispositionReason, sourceHead: args.sourceHead, analysisHead: args.analysisHead });
  };
  try {
    live(); root = await directoryStat(args.directory);
    let created = false;
    try { owner = await directoryStat(slot); } catch (e) {
      if (!missing(e)) throw e;
      if (identity(await directoryStat(args.directory)) !== identity(root)) return fail("storage");
      if (!writing) return Object.freeze({ storage: "absent" });
      try { await mkdir(slot, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      owner = await directoryStat(slot);
    }
    if (created) headerStamp = await write("intent.enc", header);
    else { const saved = await read("intent.enc"); if (!equal(saved.value, header)) return fail("storage"); headerStamp = saved.version; }
    let existing: StandingHistoryTaskDisposition | undefined;
    try { existing = decode((await read(name)).value); }
    catch (e) { if (!missing(e)) throw e; await guard(); }
    if (existing) {
      if (writing && existing.reason !== args.reason) return fail("conflict");
      await guard(); return Object.freeze({ storage: "ready", disposition: existing });
    }
    if (!writing) return Object.freeze({ storage: "absent" });
    const disposition: StandingHistoryTaskDisposition = Object.freeze({ schema: "standing-history-task-disposition-v1", reason: args.reason!, sourceHead: args.sourceHead, analysisHead: args.analysisHead });
    const record = { domain: DOMAIN, kind: "blocked", intentHash: hash(header), disposition };
    try { await write(name, record); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const raced = decode((await read(name)).value); if (raced.reason !== disposition.reason) return fail("conflict");
    }
    await guard(); return Object.freeze({ storage: "ready", disposition });
  } catch (e) {
    live();
    if (writing) { if (e instanceof StandingHistoryTaskDispositionError) throw e; return fail("storage"); }
    return Object.freeze({ storage: "unavailable" });
  } finally { passphrase = ""; }
}
export async function readStandingHistoryTaskDisposition(value: StandingHistoryTaskDispositionInput): Promise<StandingHistoryTaskDispositionStatus> {
  return operation(config(value, false), false);
}
export async function recordStandingHistoryTaskDisposition(value: StandingHistoryTaskDispositionInput & Readonly<{ reason: StandingHistoryTaskDispositionReason }>): Promise<Extract<StandingHistoryTaskDispositionStatus, { storage: "ready" }>> {
  const result = await operation(config(value, true), true); if (result.storage !== "ready") return fail("storage"); return result;
}
