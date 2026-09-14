import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";

/** A rebuildable discovery hint, never proof of object creation. Every consumer
 * must authenticate and bind the original intent and verified terminal. */
export type StandingObjectIndexHint = Readonly<{ schema: "standing-poll-index-v1"; objectRef: string; key: string; accountId: string; chatId: string }>;
const DOMAIN = "DecadansNeurobro/standing-poll-index/v1", MAX_CIPHER = 8192;
const fail = (): never => { throw new Error("STANDING_OBJECT_INDEX_STORAGE"); };
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).length !== keys.length || keys.some(k => !Object.hasOwn(ds, k) || !("value" in ds[k]!))) return fail();
  return Object.fromEntries(keys.map(k => [k, ds[k]!.value]));
}
function hintCopy(value: unknown): StandingObjectIndexHint {
  const h = data(value, ["schema", "objectRef", "key", "accountId", "chatId"]);
  if (h.schema !== "standing-poll-index-v1" || typeof h.objectRef !== "string" || !/^obj_[0-9a-f]{48}$/u.test(h.objectRef) ||
      typeof h.key !== "string" || !/^[0-9a-f]{64}$/u.test(h.key) || typeof h.accountId !== "string" || !/^[1-9]\d{0,18}$/u.test(h.accountId) || BigInt(h.accountId) >= 2n ** 63n ||
      typeof h.chatId !== "string" || !/^-[1-9]\d{0,19}$/u.test(h.chatId)) return fail();
  return Object.freeze({ schema: h.schema, objectRef: h.objectRef, key: h.key, accountId: h.accountId, chatId: h.chatId });
}
export function standingObjectIndexDirectory(journalDirectory: string): string {
  if (typeof journalDirectory !== "string" || !isAbsolute(journalDirectory) || resolve(journalDirectory) !== journalDirectory) return fail();
  return journalDirectory + "-poll-index-v1";
}
/** Caller invokes only after the primary terminal is synced. Any failure is
 * best-effort index loss, never a reason to replay or downgrade that terminal. */
export async function writeStandingObjectIndexHint(journalDirectory: string, passphrase: string, value: StandingObjectIndexHint, guard: () => Promise<void>): Promise<void> {
  const hint = hintCopy(value), directory = standingObjectIndexDirectory(journalDirectory);
  await guard(); const encrypted = await encryptSession(JSON.stringify({ domain: DOMAIN, hint }), passphrase);
  if (Buffer.byteLength(encrypted) > MAX_CIPHER) return fail();
  await guard(); await assertPilotPrivateDirectory(dirname(directory));
  try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  await assertPilotPrivateDirectory(directory); const before = await lstat(directory, { bigint: true });
  await guard(); const path = join(directory, hint.objectRef + ".enc"), file = await open(path, "wx", 0o600);
  try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
  await assertPilotPrivateDirectory(directory); const after = await lstat(directory, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino) return fail();
  await guard();
}
/** Exact fixed-name read. Does not create or repair the index. Guard joins the
 * caller's close/root custody checks before and after the real file operation. */
export async function readStandingObjectIndexHint(journalDirectory: string, passphrase: string, objectRef: string, guard: () => Promise<void>): Promise<StandingObjectIndexHint> {
  if (!/^obj_[0-9a-f]{48}$/u.test(objectRef)) return fail();
  const directory = standingObjectIndexDirectory(journalDirectory);
  await guard(); await assertPilotPrivateDirectory(directory); const root = await lstat(directory, { bigint: true });
  const path = join(directory, objectRef + ".enc"), before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail();
  const handle = await open(path, "r"); let bytes: Buffer | undefined;
  try {
    const inside = await handle.stat({ bigint: true });
    if (!inside.isFile() || inside.dev !== before.dev || inside.ino !== before.ino || inside.nlink !== 1n || inside.size !== before.size || inside.mtimeNs !== before.mtimeNs || inside.ctimeNs !== before.ctimeNs) return fail();
    bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) { const got = await handle.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
    if (count !== Number(before.size)) return fail();
    const envelope = data(JSON.parse(await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase)), ["domain", "hint"]), hint = hintCopy(envelope.hint);
    if (envelope.domain !== DOMAIN || hint.objectRef !== objectRef) return fail();
    const after = await lstat(path, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return fail();
    await assertPilotPrivateDirectory(directory); const current = await lstat(directory, { bigint: true });
    if (current.dev !== root.dev || current.ino !== root.ino) return fail();
    await guard(); return hint;
  } finally { bytes?.fill(0); await handle.close(); }
}
