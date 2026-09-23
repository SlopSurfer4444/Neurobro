import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory, type PilotResult, type PilotTransport } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";

/** Identity of an authenticated original UNKNOWN operation, never a new send. */
export type StandingHistoryDeliveryRecoveryBinding = Readonly<{
  taskRef: string; intentHash: string; descriptorHash: string; partIndex: number;
  originalRecordsHash: string; idempotencyKey: string; randomId: string;
  accountId: string; chatId: string; replyToMessageId: number; contentHash: string; textBytes: number;
}>;
export type StandingHistoryDeliveryRecoveryAuthorization = Readonly<{
  schema: "standing-history-delivery-recovery-authorization-v1";
  binding: StandingHistoryDeliveryRecoveryBinding; ownerReceiptHash: string;
}>;
const DOMAIN = "DecadansNeurobro/standing-history-task-delivery-recovery/v1";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hashValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (): never => { throw new Error("STANDING_HISTORY_DELIVERY_RECOVERY_REFUSED"); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const fields = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== "string" || !fields[key]!.enumerable || !("value" in fields[key]!)) return fail();
    result[key] = fields[key]!.value;
  }
  return result;
}
export function snapshotStandingHistoryDeliveryRecoveryAuthorization(value: unknown, binding: StandingHistoryDeliveryRecoveryBinding): StandingHistoryDeliveryRecoveryAuthorization {
  const v = object(value), b = object(v.binding);
  if (v.schema !== "standing-history-delivery-recovery-authorization-v1" || !hashValid(v.ownerReceiptHash) ||
      Object.keys(b).sort().join() !== Object.keys(binding).sort().join() || Object.entries(binding).some(([key, expected]) => b[key] !== expected) ||
      Object.keys(v).sort().join() !== "binding,ownerReceiptHash,schema") return fail();
  return Object.freeze({ schema: v.schema, binding: Object.freeze({ ...binding }), ownerReceiptHash: v.ownerReceiptHash });
}
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
async function namesIn(directory: string): Promise<string[]> {
  const dir = await opendir(directory, { bufferSize: 1 }), names: string[] = [];
  try { for (;;) { const entry = await dir.read(); if (!entry) return names.sort(); if (names.length === 3) return fail(); names.push(entry.name); } }
  finally { await dir.close(); }
}
async function io(directory: string, passphrase: string, parentGuard: () => Promise<void>) {
  await parentGuard(); await assertPilotPrivateDirectory(directory);
  const own = await lstat(directory, { bigint: true }), seen = new Map<string, string>();
  async function guard() {
    await parentGuard(); const now = await lstat(directory, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== own.dev || now.ino !== own.ino) return fail();
    for (const [path, version] of seen) if (stamp(await lstat(path, { bigint: true })) !== version) return fail();
  }
  async function read(name: string) {
    await guard(); const path = join(directory, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 16384n) return fail();
    const file = await open(path, "r"); let bytes: string;
    try { if (stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail(); bytes = await file.readFile("utf8"); if (stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail(); }
    finally { await file.close(); }
    if (stamp(await lstat(path, { bigint: true })) !== stamp(before)) return fail(); seen.set(path, stamp(before));
    const value: unknown = JSON.parse(await decryptSession(bytes, passphrase)); await guard(); return value;
  }
  async function write(name: string, value: unknown) {
    const bytes = await encryptSession(canonical(value), passphrase); await guard();
    const file = await open(join(directory, name), "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (canonical(await read(name)) !== canonical(value)) return fail();
  }
  return { guard, read, write };
}
/** No generation creation here. A complete verified AND joined receipt alone
 * supersedes the delivery observation, never the original UNKNOWN record. */
export async function readStandingHistoryDeliveryRecovery(input: Readonly<{
  directory: string; passphrase: string; binding: StandingHistoryDeliveryRecoveryBinding; guard(): Promise<void>;
}>): Promise<Readonly<{ messageId: number; wireReplyToMessageId?: null }> | undefined> {
  const store = await io(input.directory, input.passphrase, input.guard), names = await namesIn(input.directory);
  if (names.length > 3 || names.some(name => !["intent.enc", "dispatch.enc", "result.enc"].includes(name))) return fail();
  if (!names.includes("intent.enc")) { if (names.length) return fail(); return undefined; }
  const intent = object(await store.read("intent.enc"));
  const policy = Object.hasOwn(intent, "taskReplyPolicy") ? { taskReplyPolicy: intent.taskReplyPolicy } : {};
  if (Object.hasOwn(intent, "taskReplyPolicy") && intent.taskReplyPolicy !== "standalone-if-exact-missing" ||
      !hashValid(intent.ownerReceiptHash) || canonical(intent) !== canonical({ domain: DOMAIN, kind: "intent", binding: input.binding, ownerReceiptHash: intent.ownerReceiptHash, ...policy })) return fail();
  const intentHash = digest(canonical(intent));
  if (!names.includes("dispatch.enc")) { if (names.includes("result.enc")) return fail(); return undefined; }
  if (canonical(await store.read("dispatch.enc")) !== canonical({ domain: DOMAIN, kind: "dispatch", intentHash })) return fail();
  if (!names.includes("result.enc")) return undefined;
  const result = object(await store.read("result.enc"));
  const standalone = Object.hasOwn(result, "wireReplyToMessageId");
  if (!["verified", "unknown"].includes(result.state as string) || result.leaseJoined !== true ||
      result.state === "verified" && (!Number.isSafeInteger(result.messageId) || Number(result.messageId) < 1 || Number(result.messageId) > 2147483647) ||
      standalone && (result.state !== "verified" || result.wireReplyToMessageId !== null || intent.taskReplyPolicy !== "standalone-if-exact-missing") ||
      canonical(result) !== canonical({ domain: DOMAIN, kind: "result", intentHash, state: result.state, leaseJoined: true, ...(result.state === "verified" ? { messageId: result.messageId } : {}), ...(standalone ? { wireReplyToMessageId: null } : {}) })) return fail();
  await store.guard(); if (canonical(await namesIn(input.directory)) !== canonical(names)) return fail();
  return result.state === "verified" ? { messageId: result.messageId as number, ...(standalone ? { wireReplyToMessageId: null } : {}) } : undefined;
}
/** Explicit maintenance only: one fixed exclusive generation, original ID and
 * payload. An incomplete/failed generation cannot automatically dispatch again. */
export async function runStandingHistoryDeliveryRecovery(input: Readonly<{
  directory: string; passphrase: string; binding: StandingHistoryDeliveryRecoveryBinding;
  authorization: StandingHistoryDeliveryRecoveryAuthorization; text: string; transport: PilotTransport;
  taskReplyPolicy?: "standalone-if-exact-missing";
  signal: AbortSignal; guard(): Promise<void>; settle(): Promise<void>;
}>): Promise<PilotResult> {
  const authorization = snapshotStandingHistoryDeliveryRecoveryAuthorization(input.authorization, input.binding), b = authorization.binding;
  if (digest(input.text) !== b.contentHash || Buffer.byteLength(input.text) !== b.textBytes || input.signal.aborted ||
      input.taskReplyPolicy !== undefined && input.taskReplyPolicy !== "standalone-if-exact-missing") return fail();
  await input.guard(); await mkdir(input.directory, { mode: 0o700 });
  const store = await io(input.directory, input.passphrase, input.guard);
  const intent = { domain: DOMAIN, kind: "intent", binding: b, ownerReceiptHash: authorization.ownerReceiptHash,
    ...(input.taskReplyPolicy ? { taskReplyPolicy: input.taskReplyPolicy } : {}) };
  await store.write("intent.enc", intent); const intentHash = digest(canonical(intent));
  if (input.signal.aborted) return fail();
  await store.write("dispatch.enc", { domain: DOMAIN, kind: "dispatch", intentHash });
  let messageId: number | undefined, standalone = false;
  try {
    await store.guard(); if (input.signal.aborted) return fail();
    const sent = object(await input.transport.sendOnce({ chatId: b.chatId, replyToMessageId: b.replyToMessageId, text: input.text, randomId: b.randomId }, input.signal));
    if (!Number.isSafeInteger(sent.messageId) || Number(sent.messageId) < 1 || Number(sent.messageId) > 2147483647) return fail();
    const received = object(await input.transport.readExact(b.chatId, Number(sent.messageId), input.signal));
    const missingAnchor = input.taskReplyPolicy === "standalone-if-exact-missing" && received.replyToMessageId === null && received.taskReplyOriginMessageId === b.replyToMessageId;
    const expected = { messageId: sent.messageId, chatId: b.chatId, accountId: b.accountId, replyToMessageId: missingAnchor ? null : b.replyToMessageId, text: input.text,
      ...(missingAnchor ? { taskReplyOriginMessageId: b.replyToMessageId } : {}) };
    if (Object.keys(received).sort().join() !== Object.keys(expected).sort().join() || Object.entries(expected).some(([key, value]) => received[key] !== value)) return fail();
    messageId = Number(sent.messageId); standalone = missingAnchor;
  } catch { /* The new observation remains UNKNOWN; never reset old evidence. */ }
  await input.settle(); await store.guard();
  const state = messageId === undefined ? "unknown" : "verified";
  await store.write("result.enc", { domain: DOMAIN, kind: "result", intentHash, state, leaseJoined: true, ...(messageId === undefined ? {} : { messageId }), ...(standalone ? { wireReplyToMessageId: null } : {}) });
  return state === "verified" ? { state, code: "verified" } : { state, code: "send-or-readback-unknown" };
}
