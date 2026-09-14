import { createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingPollObjectEvidence, validateStandingPollObjectEvidence, type StandingPollObjectEvidence } from "./standing-object-evidence.js";
import { writeStandingObjectIndexHint } from "./standing-object-index.js";

export type StandingActionJson = null | boolean | number | string | readonly StandingActionJson[] | { readonly [key: string]: StandingActionJson };
export type StandingActionBinding = Readonly<{ accountId: string; chatId: string; primaryMessageId: number; operationSlot: number }>;
export type StandingActionIntent = Readonly<{ requestRef: string; randomId: string; action: StandingActionJson }>;
export type StandingActionTerminal = Readonly<{ state: "verified" | "refused" | "unknown"; result: StandingActionJson; privateObjectEvidence?: StandingPollObjectEvidence }>;
export type StandingActionInspection = Readonly<{ state: "absent" | "reserved" | "verified" | "refused" | "unknown"; intent?: StandingActionIntent; terminal?: StandingActionTerminal }>;
export type StandingActionJournal = Readonly<{
  reserve(intent: Readonly<{ requestRef: string; randomId: string; action: unknown }>): Promise<void>;
  append(terminal: Readonly<{ state: "verified" | "refused" | "unknown"; result: unknown; privateObjectEvidence?: StandingPollObjectEvidence }>): Promise<void>;
  inspect(): Promise<StandingActionInspection>;
  close(): Promise<void>;
}>;
export class StandingActionJournalError extends Error {
  constructor(readonly code: "input" | "consumed" | "storage" | "closed") { super("STANDING_ACTION_JOURNAL_" + code.toUpperCase()); this.name = "StandingActionJournalError"; Object.freeze(this); }
}
const fail = (code: StandingActionJournalError["code"]): never => { throw new StandingActionJournalError(code); };
const DOMAIN = "DecadansNeurobro/standing-action-journal/v1";
const MAX_JSON = 16 * 1024, MAX_CIPHER = 64 * 1024;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(ds);
  if (keys.some(k => !Object.hasOwn(ds, k)) || actual.some(k => typeof k !== "string" || !keys.includes(k) && !optional.includes(k) || !("value" in ds[k]!))) return fail("input");
  return Object.fromEntries((actual as string[]).map(k => [k, ds[k]!.value]));
}
function cleanString(value: unknown, max: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= max && Buffer.from(value).toString("utf8") === value;
}
const long = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,18}$/u.test(value) && BigInt(value) < 2n ** 63n;
function bindingCopy(value: StandingActionBinding): StandingActionBinding {
  const b = record(value, ["accountId", "chatId", "primaryMessageId", "operationSlot"]);
  if (!long(b.accountId) || typeof b.chatId !== "string" || !/^-[1-9]\d{0,19}$/u.test(b.chatId) ||
      !Number.isSafeInteger(b.primaryMessageId) || (b.primaryMessageId as number) < 1 || (b.primaryMessageId as number) > 2147483647 ||
      !Number.isSafeInteger(b.operationSlot) || (b.operationSlot as number) < 0 || (b.operationSlot as number) > 31) return fail("input");
  return Object.freeze({ accountId: b.accountId, chatId: b.chatId, primaryMessageId: b.primaryMessageId as number, operationSlot: b.operationSlot as number });
}
export function standingActionKey(binding: StandingActionBinding): string {
  const b = bindingCopy(binding); return digest([DOMAIN, b.accountId, b.chatId, b.primaryMessageId, b.operationSlot]);
}
/** Small inert JSON snapshots: no getters, proxies, toJSON, sparse arrays,
 * special prototypes, shared references/cycles, invalid numbers or text. */
function jsonCopy(value: unknown): StandingActionJson {
  const visited = new Set<object>(); let nodes = 0, textBytes = 0;
  function walk(v: unknown, depth: number): StandingActionJson {
    if (++nodes > 2048 || depth > 8) return fail("input");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) return fail("input"); return Object.is(v, -0) ? 0 : v; }
    if (typeof v === "string") { if (!cleanString(v, 4096) || (textBytes += Buffer.byteLength(v)) > MAX_JSON) return fail("input"); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v) || visited.has(v)) return fail("input");
    visited.add(v);
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) return fail("input");
      const ds = Object.getOwnPropertyDescriptors(v), length = Object.getOwnPropertyDescriptor(v, "length")!.value as number;
      if (!Number.isSafeInteger(length) || length < 0 || length > 2048 || Reflect.ownKeys(ds).length !== length + 1) return fail("input");
      const array: StandingActionJson[] = [];
      for (let i = 0; i < length; i++) { const d = ds[String(i)]; if (!d || !("value" in d)) return fail("input"); array.push(walk(d.value, depth + 1)); }
      return Object.freeze(array);
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
    if (keys.length > 256) return fail("input");
    const pairs: [string, StandingActionJson][] = [];
    for (const key of keys) {
      if (typeof key !== "string" || !cleanString(key, 128) || key === "__proto__" || key === "constructor" || key === "prototype" ||
          (textBytes += Buffer.byteLength(key)) > MAX_JSON) return fail("input");
      const d = ds[key]!; if (!("value" in d)) return fail("input"); pairs.push([key, walk(d.value, depth + 1)]);
    }
    return Object.freeze(Object.fromEntries(pairs));
  }
  const copy = walk(value, 0); if (Buffer.byteLength(JSON.stringify(copy)) > MAX_JSON) return fail("input"); return copy;
}
export { jsonCopy as snapshotStandingActionJson };
function intentCopy(value: unknown): StandingActionIntent {
  const i = record(value, ["requestRef", "randomId", "action"]);
  if (!cleanString(i.requestRef, 256) || !i.requestRef.length || /[\u0000-\u0020\u007f-\u009f]/u.test(i.requestRef) || !long(i.randomId)) return fail("input");
  return Object.freeze({ requestRef: i.requestRef, randomId: i.randomId, action: jsonCopy(i.action) });
}
function terminalCopy(value: unknown): StandingActionTerminal {
  const t = record(value, ["state", "result"], ["privateObjectEvidence"]);
  if (!["verified", "refused", "unknown"].includes(t.state as string)) return fail("input");
  if (!Object.hasOwn(t, "privateObjectEvidence")) return Object.freeze({ state: t.state as StandingActionTerminal["state"], result: jsonCopy(t.result) });
  const result = jsonCopy(t.result);
  if (t.state !== "verified" || !result || typeof result !== "object" || Array.isArray(result) || (result as Record<string, StandingActionJson>).verdict !== "verified") return fail("input");
  try { return Object.freeze({ state: "verified", result, privateObjectEvidence: snapshotStandingPollObjectEvidence(t.privateObjectEvidence) }); }
  catch { return fail("input"); }
}
/** Shared inert decoder for the noncreating catalog reader. Cipher authentication
 * and filesystem custody are the reader's responsibility. */
export function decodeStandingActionSlot(intentEnvelope: unknown, terminalEnvelope: unknown, key: string): Readonly<{
  binding: StandingActionBinding; intent: StandingActionIntent; terminal: StandingActionTerminal;
}> {
  const first = record(intentEnvelope, ["domain", "key", "kind", "payload"]), last = record(terminalEnvelope, ["domain", "key", "kind", "payload"]);
  if (first.domain !== DOMAIN || last.domain !== DOMAIN || first.key !== key || last.key !== key || first.kind !== "intent" || last.kind !== "terminal") return fail("input");
  const payload = record(first.payload, ["binding", "intent"]), binding = bindingCopy(payload.binding as StandingActionBinding), intent = intentCopy(payload.intent);
  const ending = record(last.payload, ["intentHash", "terminal"]), terminal = terminalCopy(ending.terminal);
  if (standingActionKey(binding) !== key || ending.intentHash !== digest(intent)) return fail("input");
  if (terminal.privateObjectEvidence) validateStandingPollObjectEvidence(terminal.privateObjectEvidence, binding, intent);
  return Object.freeze({ binding, intent, terminal });
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Trusted private parent/root: caller owns Windows ACL and sole-runtime
 * admission. This journal creates only fixed encrypted names under a derived
 * slot; action JSON never selects paths or executes anything. mkdir consumes
 * the slot before intent persistence, including incomplete/uncertain attempts.
 * Reopen is inspection only; it never resumes mutation or appends a new outcome.
 * close revokes immediately and joins already admitted I/O. Synced file content
 * is checked; directory-entry durability across power loss is not claimed. */
export async function openStandingActionJournal(input: Readonly<{ directory: string; passphrase: string; binding: StandingActionBinding }>): Promise<StandingActionJournal> {
  const args = record(input, ["directory", "passphrase", "binding"]), binding = bindingCopy(args.binding as StandingActionBinding), key = standingActionKey(binding);
  if (typeof args.directory !== "string" || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory ||
      !cleanString(args.passphrase, 4096) || args.passphrase.length < 16) return fail("input");
  const directory = args.directory, slot = join(directory, key);
  let passphrase = args.passphrase, closed = false, active: Promise<unknown> | undefined;
  let state: "unclaimed" | "reserved" | "terminal" | "blocked" = "unclaimed", retainedIntent: StandingActionIntent | undefined;
  let owner: { dev: bigint; ino: bigint } | undefined;
  try {
    await assertPilotPrivateDirectory(dirname(directory));
    try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    await assertPilotPrivateDirectory(directory);
  } catch { return fail("storage"); }
  const root = await lstat(directory, { bigint: true }).catch(() => fail("storage"));
  const check = async (own = false): Promise<void> => {
    if (closed) return fail("closed");
    await assertPilotPrivateDirectory(directory); const current = await lstat(directory, { bigint: true });
    if (current.dev !== root.dev || current.ino !== root.ino) return fail("storage");
    if (own) { await assertPilotPrivateDirectory(slot); const s = await lstat(slot, { bigint: true }); if (!owner || s.dev !== owner.dev || s.ino !== owner.ino) return fail("storage"); }
    if (closed) return fail("closed");
  };
  const operation = async <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return fail("closed"); if (active) return fail("consumed");
    const pending = Promise.resolve().then(async () => { await check(); return work(); }); active = pending;
    try { return await pending; } catch (e) { if (e instanceof StandingActionJournalError) throw e; return fail("storage"); }
    finally { if (active === pending) active = undefined; }
  };
  const write = async (name: "intent.enc" | "terminal.enc", kind: "intent" | "terminal", payload: unknown): Promise<void> => {
    const encrypted = await encryptSession(JSON.stringify({ domain: DOMAIN, key, kind, payload }), passphrase);
    if (Buffer.byteLength(encrypted) > MAX_CIPHER) return fail("storage");
    await check(true); const file = await open(join(slot, name), "wx", 0o600);
    try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
    await check(true);
  };
  const read = async (name: "intent.enc" | "terminal.enc", kind: "intent" | "terminal"): Promise<unknown> => {
    await check(true); const path = join(slot, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true });
      if (!inside.isFile() || inside.dev !== before.dev || inside.ino !== before.ino || inside.size !== before.size || inside.nlink !== 1n) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      const after = await lstat(path, { bigint: true });
      if (count !== Number(before.size) || !after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
          after.size !== before.size || after.nlink !== 1n || after.mtimeNs !== before.mtimeNs) return fail("storage");
      const envelope = record(JSON.parse(await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase)), ["domain", "key", "kind", "payload"]);
      if (envelope.domain !== DOMAIN || envelope.key !== key || envelope.kind !== kind) return fail("storage");
      await check(true); return envelope.payload;
    } finally { bytes?.fill(0); await file.close(); }
  };
  return Object.freeze<StandingActionJournal>({
    async reserve(value) {
      const intent = intentCopy(value); // Entire caller graph captured before any await.
      return operation(async () => {
        if (state !== "unclaimed") return fail("consumed");
        try { await mkdir(slot, { mode: 0o700 }); } catch (e) { state = "blocked"; return fail((e as NodeJS.ErrnoException).code === "EEXIST" ? "consumed" : "storage"); }
        state = "blocked"; const s = await lstat(slot, { bigint: true }); owner = { dev: s.dev, ino: s.ino };
        await write("intent.enc", "intent", { binding, intent }); retainedIntent = intent; state = "reserved";
      });
    },
    async append(value) {
      const terminal = terminalCopy(value);
      return operation(async () => {
        if (state !== "reserved" || !retainedIntent) return fail("consumed");
        if (terminal.privateObjectEvidence) {
          try { validateStandingPollObjectEvidence(terminal.privateObjectEvidence, binding, retainedIntent); } catch { return fail("input"); }
        }
        state = "blocked"; await write("terminal.enc", "terminal", { intentHash: digest(retainedIntent), terminal }); state = "terminal";
        if (terminal.privateObjectEvidence) {
          // The terminal is already authoritative. An absent, stale or partial
          // derived hint only costs discovery speed; it must never retry send.
          try { await writeStandingObjectIndexHint(directory, passphrase, { schema: "standing-poll-index-v1", key, objectRef: terminal.privateObjectEvidence.objectRef,
            accountId: binding.accountId, chatId: binding.chatId }, () => check(true)); } catch { /* Best-effort rebuildable index. */ }
        }
      });
    },
    async inspect() {
      return operation(async (): Promise<StandingActionInspection> => {
        let intent: StandingActionIntent | undefined;
        try {
          let found;
          try { found = await lstat(slot, { bigint: true }); } catch (e) { if (missing(e)) return Object.freeze({ state: "absent" }); throw e; }
          if (!found.isDirectory() || found.isSymbolicLink() || (owner && (owner.dev !== found.dev || owner.ino !== found.ino))) return fail("storage");
          owner = { dev: found.dev, ino: found.ino };
          const payload = record(await read("intent.enc", "intent"), ["binding", "intent"]);
          if (digest(bindingCopy(payload.binding as StandingActionBinding)) !== digest(binding)) return fail("storage");
          intent = intentCopy(payload.intent);
          let raw: unknown;
          try { raw = await read("terminal.enc", "terminal"); } catch (e) { if (missing(e)) return Object.freeze({ state: "reserved", intent }); throw e; }
          const terminalPayload = record(raw, ["intentHash", "terminal"]);
          if (terminalPayload.intentHash !== digest(intent)) return fail("storage");
          const terminal = terminalCopy(terminalPayload.terminal);
          if (terminal.privateObjectEvidence) validateStandingPollObjectEvidence(terminal.privateObjectEvidence, binding, intent);
          return Object.freeze({ state: terminal.state, intent, terminal });
        } catch { return Object.freeze({ state: "unknown", ...(intent ? { intent } : {}) }); }
      });
    },
    async close() { closed = true; try { await active; } catch { /* Preserve the admitted operation's failure. */ } finally { passphrase = ""; retainedIntent = undefined; } },
  });
}
