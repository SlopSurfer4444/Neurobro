import { createCipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { copyTelegramTextEntities, type TelegramTextEntity } from "./telegram-text-format.js";

export type PilotState = "planned" | "sending" | "verified" | "unknown" | "failed_terminal";
/** Private encrypted evidence only. Never copy these identifiers/hashes into Git. */
export type PilotRecord = Readonly<{
  version: "pilot-outbox-v1";
  state: PilotState;
  idempotencyKey: string;
  randomId: string;
  chatId: string;
  accountId: string;
  replyToMessageId: number | null;
  contentHash: string;
  textBytes: number;
  messageId?: number;
}>;
/** reserve must exclusively claim one durable attempt. append must sync before resolving.
 * Any existing, partial or unknown attempt must block reserve; no recovery/reset API. */
export interface PilotStore {
  reserve(record: PilotRecord): Promise<void>;
  append(record: PilotRecord): Promise<void>;
}
export type PilotReply = Readonly<{ chatId: string; replyToMessageId: number | null; text: string; entities?: readonly TelegramTextEntity[] }>;
export type PilotSend = PilotReply & Readonly<{ randomId: string }>;
export type PilotReadback = PilotReply & Readonly<{ messageId: number; accountId: string }>;
/** The runner supplies the sole gateway, with transport retries disabled. sendOnce must
 * perform exactly one send invocation; readExact must perform one fresh exact-ID read. */
export interface PilotTransport {
  sendOnce(reply: PilotSend, signal: AbortSignal): Promise<{ messageId: number }>;
  readExact(chatId: string, messageId: number, signal: AbortSignal): Promise<PilotReadback | null>;
}
/** Trusted transport evidence: throw only before invoking the remote send.
 * Never wrap a send RPC, its acknowledgement, observer or readback failure in
 * this error. A refused attempt is still durably consumed and cannot replay. */
export class PilotPreDispatchError extends Error {
  constructor() { super("PILOT_PRE_DISPATCH_REFUSED"); }
}
export interface PilotReplyInput {
  approved: Readonly<{ chatId: string; accountId: string; replyToMessageId: number | null; maximumTextBytes: number }>;
  reply: PilotReply;
  store: PilotStore;
  transport: PilotTransport;
  killSwitchEngaged(): boolean;
  signal: AbortSignal;
}
/** Fixed boundary metadata only: no error strings, message content or identities.
 * Only pre-dispatch-refused proves no send invocation; other values locate an
 * observation failure without determining whether a remote send took effect. */
export type PilotDeliveryDiagnostic = "send" | "send-result" | "readback" | "readback-shape" | "readback-mismatch"
  | "pre-dispatch-refused" | "persist-sending" | "persist-verified" | "persist-failed-terminal" | "persist-unknown";
export function isPilotDeliveryDiagnostic(value: unknown): value is PilotDeliveryDiagnostic {
  return typeof value === "string" && ["send", "send-result", "readback", "readback-shape", "readback-mismatch",
    "pre-dispatch-refused", "persist-sending", "persist-verified", "persist-failed-terminal", "persist-unknown"].includes(value);
}
export type PilotResult = Readonly<{
  state: "refused" | "verified" | "unknown" | "failed_terminal";
  code: "input-refused" | "stopped-before-send" | "pre-dispatch-refused" | "store-refused" | "verified" | "send-or-readback-unknown" | "persistence-unknown";
  deliveryDiagnostic?: PilotDeliveryDiagnostic;
}>;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const messageIdValid = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;

// Reject executable property access before copying untrusted message metadata.
function dataSnapshot(value: unknown, required?: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("pilot-input-refused");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (required && !required.includes(key) && !optional.includes(key))) throw new Error("pilot-input-refused");
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("pilot-input-refused");
    result[key] = descriptor.value;
  }
  if (required?.some(key => !Object.hasOwn(result, key))) throw new Error("pilot-input-refused");
  return result;
}
function snapshotReply(value: unknown, readback = false): PilotReply | PilotReadback {
  const snapshot = dataSnapshot(value, ["chatId", "replyToMessageId", "text", ...(readback ? ["messageId", "accountId"] : [])], ["entities"]);
  if (typeof snapshot.text !== "string") throw new Error("pilot-input-refused");
  if (Object.hasOwn(snapshot, "entities")) snapshot.entities = copyTelegramTextEntities(snapshot.text, snapshot.entities as readonly TelegramTextEntity[]);
  return Object.freeze({ ...snapshot }) as PilotReply | PilotReadback;
}

type DirectoryMetadata = Pick<BigIntStats, "dev" | "ino" | "isDirectory" | "isSymbolicLink">;
export interface PilotDirectoryInspection {
  platform: string;
  lstat(path: string): Promise<DirectoryMetadata>;
  realpath(path: string): Promise<string>;
  realpathSync(path: string): string;
}
const directoryInspection: PilotDirectoryInspection = {
  platform: process.platform,
  lstat: path => lstat(path, { bigint: true }),
  realpath,
  realpathSync,
};
/** Node's async/native realpath can expose the MSIX physical backing path while
 * non-native realpathSync retains the logical application path. Accept that Windows
 * alias only if the latter still matches (ordinary symlink ancestors do not), and
 * both non-symlink directories have the same positive device/inode identity.
 * This proves current directory identity, not ACL ownership or power-loss safety. */
export async function assertPilotPrivateDirectory(directory: string, inspection: PilotDirectoryInspection = directoryInspection): Promise<void> {
  const denied = () => { throw new Error("pilot-private-directory-refused"); };
  if (!isAbsolute(directory) || resolve(directory) !== directory) return denied();
  const logical = await inspection.lstat(directory);
  if (!logical.isDirectory() || logical.isSymbolicLink()) return denied();
  const physicalPath = resolve(await inspection.realpath(directory));
  if (physicalPath === directory) return;
  if (inspection.platform !== "win32" || resolve(inspection.realpathSync(directory)) !== directory) return denied();
  const physical = await inspection.lstat(physicalPath);
  if (!physical.isDirectory() || physical.isSymbolicLink() || logical.dev <= 0n || logical.ino <= 0n ||
      logical.dev !== physical.dev || logical.ino !== physical.ino) return denied();
}

/** One response and no retries. A crashed `sending` record remains permanently consumed. */
export async function runPilotReply(input: PilotReplyInput): Promise<PilotResult> {
  let approved: PilotReplyInput["approved"];
  let reply: PilotReply;
  try {
    input = Object.freeze({ ...dataSnapshot(input) }) as unknown as PilotReplyInput;
    approved = Object.freeze({ ...dataSnapshot(input.approved, ["chatId", "accountId", "replyToMessageId", "maximumTextBytes"]) }) as PilotReplyInput["approved"];
    reply = snapshotReply(input.reply);
  } catch { return { state: "refused", code: "input-refused" }; }
  if (typeof approved.chatId !== "string" || typeof approved.accountId !== "string" ||
      !/^-[1-9]\d{0,19}$/.test(approved.chatId) || !/^[1-9]\d{0,19}$/.test(approved.accountId) ||
      !(approved.replyToMessageId === null || messageIdValid(approved.replyToMessageId)) || !Number.isSafeInteger(approved.maximumTextBytes) ||
      approved.maximumTextBytes < 1 || approved.maximumTextBytes > 4096 ||
      reply.chatId !== approved.chatId || reply.replyToMessageId !== approved.replyToMessageId ||
      typeof reply.text !== "string" || !reply.text.trim() || reply.text.includes("\0") ||
      Buffer.from(reply.text, "utf8").toString("utf8") !== reply.text ||
      Buffer.byteLength(reply.text, "utf8") > approved.maximumTextBytes) {
    return { state: "refused", code: "input-refused" };
  }
  const stopped = () => {
    try { return input.signal.aborted || input.killSwitchEngaged() !== false; }
    catch { return true; }
  };
  if (stopped()) return { state: "refused", code: "stopped-before-send" };
  // Keep all historical plaintext-only identities unchanged. Explicit formatting
  // gets a separate domain even for [], and commits to the normalized spans.
  const contentHash = reply.entities === undefined ? hash(reply.text)
    : hash(JSON.stringify(["DecadansNeurobro/pilot-formatted-text/v1", reply.text, reply.entities]));
  const base = Object.freeze({
    version: "pilot-outbox-v1" as const,
    idempotencyKey: hash(JSON.stringify([approved.chatId, approved.replyToMessageId === null ? "owner-greeting" : "owner-prompt", approved.replyToMessageId, approved.replyToMessageId === null ? "message" : "reply", contentHash])),
    randomId: (randomBytes(8).readBigUInt64BE() % 9_223_372_036_854_775_807n + 1n).toString(),
    chatId: approved.chatId,
    accountId: approved.accountId,
    replyToMessageId: approved.replyToMessageId,
    contentHash,
    textBytes: Buffer.byteLength(reply.text, "utf8"),
  });
  const record = (state: PilotState, messageId?: number): PilotRecord => Object.freeze({ ...base, state, ...(messageId === undefined ? {} : { messageId }) });
  const persist = async (state: PilotState, messageId?: number) => {
    try { await input.store.append(record(state, messageId)); return true; }
    catch { return false; }
  };
  try { await input.store.reserve(record("planned")); }
  catch { return { state: "refused", code: "store-refused" }; }
  if (stopped()) return await persist("failed_terminal")
    ? { state: "failed_terminal", code: "stopped-before-send" }
    : { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-failed-terminal" };
  // Do not call transport until the durable sending marker has been synced.
  if (!await persist("sending")) return { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-sending" };
  if (stopped()) return await persist("failed_terminal")
    ? { state: "failed_terminal", code: "stopped-before-send" }
    : { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-failed-terminal" };
  let deliveryDiagnostic: PilotDeliveryDiagnostic = "send";
  try {
    const sent = await untilAborted(input.signal, () => {
      if (stopped()) throw new Error("stopped-before-transport");
      return input.transport.sendOnce(Object.freeze({ ...reply, randomId: base.randomId }), input.signal);
    });
    deliveryDiagnostic = "send-result";
    if (!sent || !messageIdValid(sent.messageId)) throw new Error("send-outcome-unknown");
    const sentId = sent.messageId;
    deliveryDiagnostic = "readback";
    const rawReceived = await untilAborted(input.signal, () => input.transport.readExact(base.chatId, sentId, input.signal));
    deliveryDiagnostic = "readback-shape";
    const received = snapshotReply(rawReceived, true) as PilotReadback;
    deliveryDiagnostic = "readback-mismatch";
    if (received.messageId !== sentId || received.chatId !== base.chatId ||
        received.accountId !== base.accountId || received.replyToMessageId !== base.replyToMessageId ||
        received.text !== reply.text || JSON.stringify(received.entities) !== JSON.stringify(reply.entities)) throw new Error("readback-mismatch");
    if (!await persist("verified", sentId)) return { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-verified" };
    return { state: "verified", code: "verified" };
  } catch (error) {
    // Only the trusted send boundary can prove no remote invocation occurred.
    // The same error from readback is too late; generic exceptions and abort
    // races retain UNKNOWN. Terminal persistence still consumes this attempt.
    if (deliveryDiagnostic === "send" && !types.isProxy(error) && error instanceof PilotPreDispatchError) {
      return await persist("failed_terminal")
        ? { state: "failed_terminal", code: "pre-dispatch-refused", deliveryDiagnostic: "pre-dispatch-refused" }
        : { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-failed-terminal" };
    }
    return await persist("unknown")
      ? { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic }
      : { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-unknown" };
  }
}

function untilAborted<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(new Error("operation-aborted"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new Error("operation-aborted");
      return operation();
    }).then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Creates no directory until reserve. Parent must already be a protected private
 * directory owned by the runner. Each pilot uses one fixed absent child directory;
 * the runner must never choose another directory to evade a consumed budget.
 * Ciphertext slots are exclusive and file-synced; no cleanup, overwrite or resume.
 * This provides process-crash safety, not a power-loss/filesystem durability claim. */
export function createEncryptedPilotStore(directory: string, passphrase: string, inspection?: PilotDirectoryInspection): PilotStore {
  if (!isAbsolute(directory) || directory !== resolve(directory) || passphrase.length < 16) throw new Error("pilot-store-config-refused");
  let busy = false;
  let state: PilotState | "unclaimed" | "blocked" = "unclaimed";
  let identity: string | undefined;
  let directoryIdentity: { dev: number; ino: number } | undefined;
  const signature = (record: PilotRecord) => JSON.stringify({ ...record, state: undefined, messageId: undefined });
  async function write(record: PilotRecord): Promise<void> {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !directoryIdentity ||
        metadata.dev !== directoryIdentity.dev || metadata.ino !== directoryIdentity.ino) throw new Error("pilot-store-directory-refused");
    const salt = randomBytes(16);
    const key = await new Promise<Buffer>((done, reject) => scrypt(passphrase, salt, 32, (error, derived) => error ? reject(error) : done(derived)));
    let bytes: string;
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("DecadansNeurobro/pilot-outbox/v1"));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
      bytes = JSON.stringify({ version: 1, algorithm: "aes-256-gcm", kdf: "scrypt", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
    } finally { key.fill(0); }
    const name = record.state === "planned" ? "planned.enc" : record.state === "sending" ? "sending.enc" : "terminal.enc";
    const file = await open(join(directory, name), "wx", 0o600);
    try { await file.writeFile(bytes, "utf8"); await file.sync(); }
    finally { await file.close(); }
  }
  async function operation(record: PilotRecord, reserve: boolean): Promise<void> {
    if (busy || state === "blocked") throw new Error("pilot-store-consumed");
    busy = true;
    try {
      if (reserve) {
        if (state !== "unclaimed" || record.state !== "planned") throw new Error("pilot-store-consumed");
        const parent = dirname(directory);
        await assertPilotPrivateDirectory(parent, inspection);
        await mkdir(directory, { mode: 0o700 }); // EEXIST always refuses, even if empty.
        const own = await lstat(directory);
        directoryIdentity = { dev: own.dev, ino: own.ino };
        identity = signature(record);
      } else if (identity !== signature(record) ||
          !((state === "planned" && (record.state === "sending" || record.state === "failed_terminal")) ||
          (state === "sending" && ["verified", "unknown", "failed_terminal"].includes(record.state)))) {
        throw new Error("pilot-store-transition-refused");
      }
      await write(record);
      state = record.state;
    } catch { state = "blocked"; throw new Error("pilot-store-refused"); }
    finally { busy = false; }
  }
  return Object.freeze({ reserve: (record: PilotRecord) => operation(record, true), append: (record: PilotRecord) => operation(record, false) });
}
