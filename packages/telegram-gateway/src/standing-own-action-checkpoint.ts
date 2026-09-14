import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import type { PilotBinding } from "./pilot-telegram-adapter.js";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { encryptSession, decryptSession } from "./session-crypto.js";
import { standingActionKey } from "./standing-action-journal.js";
import type { StandingOwnActionCaptureEvent } from "./standing-own-action-capture.js";
import { projectStandingOwnAction } from "./standing-own-action-projection.js";

export type StandingOwnActionCheckpoint = Readonly<{
  /** Oldest to newest observation; this bounded cache is not a full archive. */
  read(): readonly StandingOwnActionCaptureEvent[];
  stage(event: StandingOwnActionCaptureEvent): void;
  /** Concurrent callers join one admitted snapshot. Later staging needs another flush. */
  flush(): Promise<void>;
  /** Revokes read/stage/flush immediately, joins admitted I/O, never implicitly flushes. */
  close(): Promise<void>;
}>;
export class StandingOwnActionCheckpointError extends Error {
  constructor(readonly code: "input" | "storage" | "closed") { super("STANDING_OWN_ACTION_CHECKPOINT_" + code.toUpperCase()); }
}
const fail = (code: StandingOwnActionCheckpointError["code"] = "storage"): never => { throw new StandingOwnActionCheckpointError(code); };
const DOMAIN = "DecadansNeurobro/standing-own-action-checkpoint/v1", FILE = "checkpoint.enc";
const MAX_EVENT = 65536, MAX_PLAIN = 3 * 1024 * 1024, MAX_CIPHER = 4 * 1024 * 1024 + 4096;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fields(value: unknown, names: readonly string[]): Record<string, any> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (keys.length !== names.length || keys.some(k => typeof k !== "string" || !names.includes(k))) return fail("input");
  const out: Record<string, unknown> = {};
  for (const k of names) { const d = ds[k]; if (!d || !("value" in d) || !d.enumerable) return fail("input"); out[k] = d.value; }
  return out;
}
function snapshot(value: unknown): StandingOwnActionCaptureEvent {
  let bytes = 0, nodes = 0;
  const charge = (n: number) => { if ((bytes += n) > MAX_EVENT) return fail("input"); };
  const copy = (v: unknown, depth: number): any => {
    if (++nodes > 8192 || depth > 14) return fail("input");
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) { charge(JSON.stringify(v).length); return v; }
    if (typeof v === "string") { if (v.length > 16384) return fail("input"); charge(Buffer.byteLength(JSON.stringify(v))); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail("input");
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail("input");
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
    if (keys.length > 8193) return fail("input");
    if (array) {
      const length = Object.getOwnPropertyDescriptor(v, "length")!.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 8192 || keys.length !== length + 1) return fail("input");
      charge(2 + Math.max(0, length - 1)); const result: unknown[] = [];
      for (let i = 0; i < length; i++) { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail("input"); result.push(copy(d.value, depth + 1)); }
      return Object.freeze(result);
    }
    charge(2 + Math.max(0, keys.length - 1)); const result: Record<string, unknown> = {};
    for (const k of keys) {
      if (typeof k !== "string" || k.length > 128 || ["__proto__", "constructor", "prototype"].includes(k)) return fail("input");
      charge(Buffer.byteLength(JSON.stringify(k)) + 1); const d = ds[k]!;
      if (!("value" in d) || !d.enumerable) return fail("input"); result[k] = copy(d.value, depth + 1);
    }
    return Object.freeze(result);
  };
  return copy(value, 0) as StandingOwnActionCaptureEvent;
}
function eventCopy(value: unknown, binding: PilotBinding): StandingOwnActionCaptureEvent {
  const copy = snapshot(value), e = fields(copy, ["slot", "source"]);
  if (typeof e.slot !== "string" || !/^[0-9a-f]{64}$/.test(e.slot)) return fail("input");
  const source = copy.source;
  const view = projectStandingOwnAction({ binding: { accountId: binding.accountId, chatId: binding.peerId }, referenceKey: "0".repeat(64), slot: e.slot, source });
  if (view.verdict === "incomplete") return fail("input");
  const expected = source.family === "pilot" ? sha(["DecadansNeurobro/own-pilot-source/v1", source.record.idempotencyKey, source.record.randomId]) :
    source.family === "bound-action" ? standingActionKey(source.binding) : source.plan.key;
  if (e.slot !== expected) return fail("input"); return copy;
}
function cryptoEnvelope(serialized: string): void {
  const v = fields(JSON.parse(serialized), ["schemaVersion", "algorithm", "kdf", "salt", "iv", "authTag", "ciphertext"]);
  if (v.schemaVersion !== 1 || v.algorithm !== "aes-256-gcm" || v.kdf !== "scrypt") return fail();
  for (const [key, size] of [["salt", 16], ["iv", 12], ["authTag", 16], ["ciphertext", undefined]] as const) {
    const text = v[key]; if (typeof text !== "string" || text.length < 1 || text.length > MAX_CIPHER) return fail();
    const bytes = Buffer.from(text, "base64");
    try { if (bytes.toString("base64") !== text || size !== undefined && bytes.length !== size || key === "ciphertext" && bytes.length > MAX_PLAIN) return fail(); }
    finally { bytes.fill(0); }
  }
}

/** Optional derived cache of trusted post-persistence capture facts, never a
 * send/replay grant or replacement for original journals. The host owns a sole
 * service writer. Absent roots are not created until flush. Corruption, unknown
 * entries and interrupted temporary files are preserved and refused, not repaired.
 * A crash before a successful flush loses only cache coverage, not delivery proof. */
export async function openStandingOwnActionCheckpoint(input: Readonly<{
  directory: string; passphrase: string; binding: PilotBinding;
}>): Promise<StandingOwnActionCheckpoint> {
  const args = fields(input, ["directory", "passphrase", "binding"]), b = fields(args.binding, ["accountId", "peerId"]);
  if (typeof args.directory !== "string" || args.directory.length > 32768 || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory || dirname(args.directory) === args.directory ||
      typeof args.passphrase !== "string" || args.passphrase.length < 16 || args.passphrase.length > 4096 || args.passphrase.includes("\0") || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString() !== args.passphrase ||
      typeof b.accountId !== "string" || !/^[1-9]\d{0,19}$/.test(b.accountId) || typeof b.peerId !== "string" || !/^-[1-9]\d{0,19}$/.test(b.peerId)) return fail("input");
  const directory = args.directory as string, parent = dirname(directory), path = join(directory, FILE), binding = Object.freeze({ accountId: b.accountId, peerId: b.peerId }) as PilotBinding;
  let passphrase = args.passphrase as string; delete args.passphrase;
  const entries = new Map<string, StandingOwnActionCaptureEvent>();
  let root: BigIntStats | undefined, saved: BigIntStats | undefined, active: Promise<void> | undefined, closing: Promise<void> | undefined;
  let closed = false, broken = false, revision = 0, committed = 0;
  const directoryStat = async (name: string) => { await assertPilotPrivateDirectory(name); const s = await lstat(name, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink()) return fail(); return s; };
  const parentIdentity = await directoryStat(parent);
  const parentGuard = async () => { if (!same(parentIdentity, await directoryStat(parent))) return fail(); };
  const fileStat = async (name: string): Promise<BigIntStats> => { const s = await lstat(name, { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.size < 1n || s.size > BigInt(MAX_CIPHER)) return fail(); return s; };
  const exists = async (name: string) => { try { await lstat(name); return true; } catch (e) { if (missing(e)) return false; throw e; } };
  const guard = async (temp?: Readonly<{ name: string; stat: BigIntStats }>) => {
    await parentGuard();
    if (!root) { if (await exists(directory)) return fail(); return; }
    if (!same(root, await directoryStat(directory))) return fail();
    const listing = await opendir(directory, { bufferSize: 1 }); let count = 0;
    try { for (;;) { const entry = await listing.read(); if (!entry) break;
      if (++count > (saved ? 1 : 0) + (temp ? 1 : 0) || !entry.isFile() || entry.isSymbolicLink() || entry.name !== FILE && entry.name !== temp?.name) return fail();
    } } finally { await listing.close(); }
    if (count !== (saved ? 1 : 0) + (temp ? 1 : 0)) return fail();
    if (saved && stamp(await fileStat(path)) !== stamp(saved)) return fail();
    if (temp && stamp(await fileStat(join(directory, temp.name))) !== stamp(temp.stat)) return fail();
    await parentGuard(); if (!same(root, await directoryStat(directory))) return fail();
  };
  const readCipher = async (expected: BigIntStats) => {
    const handle = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(expected)) return fail();
      bytes = Buffer.alloc(Number(expected.size) + 1); let count = 0;
      while (count < bytes.length) { const got = await handle.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(expected.size) || stamp(await handle.stat({ bigint: true })) !== stamp(expected)) return fail();
      const text = bytes.subarray(0, count).toString("utf8"); if (Buffer.byteLength(text) !== count || !bytes.subarray(0, count).equals(Buffer.from(text))) return fail();
      await guard(); return text;
    } finally { bytes?.fill(0); await handle.close(); }
  };
  try {
    if (await exists(directory)) { root = await directoryStat(directory); if (await exists(path)) saved = await fileStat(path); }
    await guard();
    if (saved) {
      const cipher = await readCipher(saved); cryptoEnvelope(cipher);
      const plain = await decryptSession(cipher, passphrase); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail();
      const decoded = fields(JSON.parse(plain), ["domain", "binding", "events"]), savedBinding = fields(decoded.binding, ["accountId", "peerId"]);
      if (decoded.domain !== DOMAIN || savedBinding.accountId !== binding.accountId || savedBinding.peerId !== binding.peerId || !Array.isArray(decoded.events) || decoded.events.length > 32) return fail();
      for (const value of decoded.events) { const event = eventCopy(value, binding), key = event.source.family + ":" + event.slot; if (entries.has(key)) return fail(); entries.set(key, event); }
      await guard();
    }
  } catch { passphrase = ""; entries.clear(); return fail(); }
  const live = () => { if (closed) return fail("closed"); if (broken) return fail(); };
  const writeSnapshot = async (events: readonly StandingOwnActionCaptureEvent[], version: number) => {
    await guard();
    const plaintext = JSON.stringify({ domain: DOMAIN, binding, events }); if (Buffer.byteLength(plaintext) > MAX_PLAIN) return fail();
    const cipher = await encryptSession(plaintext, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail();
    await guard();
    if (!root) { await mkdir(directory, { mode: 0o700 }); root = await directoryStat(directory); await guard(); }
    const name = "checkpoint_" + randomBytes(24).toString("hex") + ".tmp", temporary = join(directory, name);
    const handle = await open(temporary, "wx", 0o600); let temporaryStat: BigIntStats;
    try {
      const initial = await handle.stat({ bigint: true });
      if (!initial.isFile() || initial.nlink !== 1n || !same(initial, await lstat(temporary, { bigint: true }))) return fail();
      await parentGuard(); if (!same(root!, await directoryStat(directory))) return fail();
      await handle.writeFile(cipher, "utf8"); await handle.sync();
      temporaryStat = await handle.stat({ bigint: true });
      if (!temporaryStat.isFile() || temporaryStat.nlink !== 1n || temporaryStat.size !== BigInt(Buffer.byteLength(cipher)) || stamp(await fileStat(temporary)) !== stamp(temporaryStat)) return fail();
    } finally { await handle.close(); }
    await guard({ name, stat: temporaryStat });
    await rename(temporary, path);
    const replacement = await fileStat(path);
    if (!same(temporaryStat, replacement) || replacement.size !== temporaryStat.size) return fail();
    saved = replacement; await guard();
    if (await readCipher(saved) !== cipher) return fail();
    committed = version;
  };
  return Object.freeze({
    read() { live(); return Object.freeze([...entries.values()]); },
    stage(value: StandingOwnActionCaptureEvent) {
      live(); const event = eventCopy(value, binding), key = event.source.family + ":" + event.slot;
      entries.delete(key); entries.set(key, event); if (entries.size > 32) entries.delete(entries.keys().next().value!); revision++;
    },
    flush(): Promise<void> {
      try { live(); } catch (e) { return Promise.reject(e); }
      if (active) return active; if (revision === committed) return Promise.resolve();
      const events = Object.freeze([...entries.values()]), version = revision;
      active = writeSnapshot(events, version).catch(() => { broken = true; return fail(); }).finally(() => { active = undefined; });
      return active;
    },
    close(): Promise<void> {
      if (closing) return closing; closed = true;
      closing = Promise.resolve(active).finally(() => { entries.clear(); passphrase = ""; }); return closing;
    },
  });
}
