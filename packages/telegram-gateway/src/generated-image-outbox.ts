import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { encryptSession, decryptSession } from "./session-crypto.js";
import { createGeneratedImageRegistry, type GeneratedImageArtifact, type GeneratedImageOrigin, type GeneratedImageRegistry } from "./generated-image-artifact.js";

export type ImageDeliveryDiagnostics = Readonly<{
  originalStage: "none" | "admission" | "revalidate-before" | "upload" | "revalidate-after" | "send-invoke" | "ack-parse" | "read-invoke" | "readback-parse" | "transport-wait" | "persistence";
  reason: "none" | "input" | "stopped" | "selection" | "invoke" | "proof" | "missing-message" | "consumed" | "storage" | "unexpected";
}>;
const DIAGNOSTIC_STAGES = ["none", "admission", "revalidate-before", "upload", "revalidate-after", "send-invoke", "ack-parse", "read-invoke", "readback-parse", "transport-wait", "persistence"];
const DIAGNOSTIC_REASONS = ["none", "input", "stopped", "selection", "invoke", "proof", "missing-message", "consumed", "storage", "unexpected"];
function diagnosticCopy(value: ImageDeliveryDiagnostics): ImageDeliveryDiagnostics {
  if (!exact(value, ["originalStage", "reason"]) || !DIAGNOSTIC_STAGES.includes(value.originalStage) || !DIAGNOSTIC_REASONS.includes(value.reason) ||
      ((value.originalStage === "none") !== (value.reason === "none"))) return fail("input");
  return Object.freeze({ originalStage: value.originalStage, reason: value.reason });
}
/** Trusted transport evidence only. Never carries raw Telegram errors or IDs. */
export class GeneratedImageTransportError extends Error {
  readonly diagnostics: ImageDeliveryDiagnostics;
  constructor(diagnostics: ImageDeliveryDiagnostics) {
    super("GENERATED_IMAGE_TELEGRAM_REFUSED_OR_UNKNOWN"); this.name = "GeneratedImageTransportError";
    this.diagnostics = diagnosticCopy(diagnostics); if (this.diagnostics.originalStage === "none") return fail("input"); Object.freeze(this);
  }
}

export type ImageDeliveryApproval = Readonly<{ chatId: string; accountId: string; replyToMessageId: number; origin: GeneratedImageOrigin }>;
type ImageDeliveryTarget = Pick<ImageDeliveryApproval, "chatId" | "accountId" | "replyToMessageId">;
export type VerifiedGeneratedImage = Readonly<{
  artifact: GeneratedImageArtifact; bytes: Buffer;
  /** Revokes this private byte copy only; never changes the stored delivery. */
  close(): void;
}>;
export type ImageDeliveryPlan = Readonly<{
  version: "generated-image-delivery-v1"; key: string; generation: "completed";
  approved: ImageDeliveryApproval; artifact: GeneratedImageArtifact; caption: string; randomId: string;
}>;
export type ImageDeliveryState = "planned" | "sending" | "verified" | "unknown" | "failed_terminal";
export type ImageDeliveryRecord = Readonly<{
  key: string; planHash: string; state: Exclude<ImageDeliveryState, "planned">;
  messageId?: number; photoId?: string;
  diagnostics?: ImageDeliveryDiagnostics;
}>;
export interface GeneratedImageMediaStore {
  reserve(plan: ImageDeliveryPlan, bytes: Buffer): Promise<void>;
  append(record: ImageDeliveryRecord): Promise<void>;
}
export type ImageMediaAcknowledgement = Readonly<{ messageId: number; photoId: string }>;
export type ImageMediaReadback = Readonly<ImageMediaAcknowledgement & { chatId: string; accountId: string; replyToMessageId: number; caption: string }>;
/** Sole existing bound client. sendOnce owns bounded upload and exactly one
 * SendMedia, with all retries disabled. It resolves/rejects only after its own
 * use of bytes ends. Never retain the supplied Buffer or clone it beyond that
 * lifetime. readExact performs one fresh exact-ID read of the acknowledged photo. */
export interface GeneratedImageMediaTransport {
  sendOnce(input: Readonly<{ chatId: string; replyToMessageId: number; caption: string; randomId: string; mimeType: "image/png"; bytes: Buffer }>, signal: AbortSignal): Promise<ImageMediaAcknowledgement>;
  readExact(chatId: string, messageId: number, signal: AbortSignal): Promise<ImageMediaReadback | null>;
}
export type ImageDeliveryResult = Readonly<{
  generation: "completed" | "unknown"; delivery: "refused" | "verified" | "unknown" | "failed_terminal";
  code: "input-refused" | "stopped" | "consumed" | "persistence-unknown" | "delivery-unknown" | "verified";
  transportSettled: boolean;
  diagnostics: ImageDeliveryDiagnostics;
  /** Must be joined before closing/reusing the sole client. Abort is not settlement.
   * Resolves after every admitted transport promise and its byte cleanup settle. */
  settlement: Promise<void>;
}>;
export type ImageDeliveryInspection = Readonly<{
  generation: "completed" | "unknown"; delivery: ImageDeliveryState | "absent";
  artifact?: GeneratedImageArtifact; caption?: string; randomId?: string; messageId?: number; photoId?: string;
  diagnostics?: ImageDeliveryDiagnostics;
}>;
export class GeneratedImageOutboxError extends Error {
  constructor(readonly code: "input" | "consumed" | "storage" | "closed") { super("GENERATED_IMAGE_OUTBOX_" + code.toUpperCase()); }
}
const fail = (code: GeneratedImageOutboxError["code"]): never => { throw new GeneratedImageOutboxError(code); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2147483647;
const long = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) < 2n ** 63n;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key) && "value" in Object.getOwnPropertyDescriptor(value, key)!);
const captionValid = (value: unknown): value is string => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 1024 &&
  !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value;
function approvalCopy(value: ImageDeliveryApproval): ImageDeliveryApproval {
  if (!exact(value, ["chatId", "accountId", "replyToMessageId", "origin"]) || typeof value.chatId !== "string" ||
      !/^-[1-9]\d{0,19}$/.test(value.chatId) || typeof value.accountId !== "string" || !/^[1-9]\d{0,19}$/.test(value.accountId) || !id(value.replyToMessageId) ||
      !exact(value.origin, ["requestRef", "threadId", "turnId", "itemId"])) return fail("input");
  const origin = value.origin as unknown as GeneratedImageOrigin;
  if (Object.values(origin).some(part => typeof part !== "string" || !part.length || part.length > 256 || /[\u0000-\u0020\u007f]/u.test(part) || Buffer.from(part, "utf8").toString("utf8") !== part)) return fail("input");
  return Object.freeze({ chatId: value.chatId, accountId: value.accountId, replyToMessageId: value.replyToMessageId,
    origin: Object.freeze({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId, itemId: origin.itemId }) });
}
export function generatedImageDeliveryKey(approved: ImageDeliveryApproval): string {
  const binding = approvalCopy(approved);
  // Content, native epoch and opaque ref cannot evade a consumed request slot.
  return deliveryKey(binding);
}
const deliveryKey = (binding: ImageDeliveryTarget) => hash(["generated-image-delivery-v1", binding.accountId, binding.chatId, binding.replyToMessageId]);
export function generatedImagePlanHash(plan: ImageDeliveryPlan): string { return hash(plan); }
function artifactCopy(value: GeneratedImageArtifact, bytes: Buffer): GeneratedImageArtifact {
  if (!exact(value, ["version", "ref", "origin", "mimeType", "byteLength", "sha256", "width", "height"]) ||
      typeof value.ref !== "string" || !/^img_[a-f0-9]{48}$/.test(value.ref) || !Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) return fail("input");
  const origin = approvalCopy({ chatId: "-1", accountId: "1", replyToMessageId: 1, origin: value.origin as GeneratedImageOrigin }).origin;
  const registry = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  try {
    const checked = registry.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: bytes.toString("base64") });
    for (const key of ["version", "mimeType", "byteLength", "sha256", "width", "height"] as const) if (value[key] !== checked[key]) return fail("input");
    return Object.freeze({ ...checked, ref: value.ref, origin });
  } finally { registry.close(); }
}
function planCopy(value: ImageDeliveryPlan, bytes: Buffer): ImageDeliveryPlan {
  if (!exact(value, ["version", "key", "generation", "approved", "artifact", "caption", "randomId"]) ||
      value.version !== "generated-image-delivery-v1" || value.generation !== "completed" || !captionValid(value.caption) || !long(value.randomId)) return fail("input");
  const approved = approvalCopy(value.approved as ImageDeliveryApproval), artifact = artifactCopy(value.artifact as GeneratedImageArtifact, bytes);
  if (value.key !== generatedImageDeliveryKey(approved) || hash(approved.origin) !== hash(artifact.origin)) return fail("input");
  return Object.freeze({ version: "generated-image-delivery-v1", key: value.key as string, generation: "completed", approved, artifact, caption: value.caption, randomId: value.randomId });
}
function recordCopy(value: ImageDeliveryRecord, plan: ImageDeliveryPlan): ImageDeliveryRecord {
  const descriptor = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "state") : undefined;
  const verified = descriptor && "value" in descriptor && descriptor.value === "verified";
  const hasDiagnostics = value && typeof value === "object" && Object.hasOwn(value, "diagnostics");
  if (!exact(value, ["key", "planHash", "state", ...(verified ? ["messageId", "photoId"] : []), ...(hasDiagnostics ? ["diagnostics"] : [])]) || value.key !== plan.key || value.planHash !== hash(plan) ||
      !["sending", "verified", "unknown", "failed_terminal"].includes(value.state as string) || (verified && (!id(value.messageId) || !long(value.photoId)))) return fail("input");
  if (hasDiagnostics && value.state !== "unknown" && value.state !== "failed_terminal") return fail("input");
  const diagnostics = hasDiagnostics ? diagnosticCopy(value.diagnostics!) : undefined;
  if (diagnostics?.originalStage === "none") return fail("input");
  return Object.freeze({ ...value, ...(diagnostics ? { diagnostics } : {}) }) as ImageDeliveryRecord;
}

/** Generation has already completed. This function never calls a model and has
 * no regeneration/retry path. Durable sending covers upload as well as SendMedia:
 * after a crash during either, this same selected request stays consumed. */
export async function runGeneratedImageDelivery(input: {
  approved: ImageDeliveryApproval; registry: Pick<GeneratedImageRegistry, "get" | "copyBytes">; artifactRef: string; caption: string;
  store: GeneratedImageMediaStore; transport: GeneratedImageMediaTransport; signal: AbortSignal; killSwitchEngaged(): boolean;
}): Promise<ImageDeliveryResult> {
  let pending = 0, generated = false; const settlements: Promise<void>[] = [];
  let diagnostics: ImageDeliveryDiagnostics = Object.freeze({ originalStage: "none", reason: "none" });
  const recordFailure = (stage: ImageDeliveryDiagnostics["originalStage"], reason: ImageDeliveryDiagnostics["reason"], error?: unknown) => {
    if (diagnostics.originalStage !== "none") return;
    diagnostics = error instanceof GeneratedImageTransportError ? diagnosticCopy(error.diagnostics) : diagnosticCopy({ originalStage: stage, reason });
  };
  const result = (delivery: ImageDeliveryResult["delivery"], code: ImageDeliveryResult["code"]): ImageDeliveryResult => Object.freeze({
    generation: generated ? "completed" : "unknown", delivery, code, diagnostics, transportSettled: pending === 0, settlement: Promise.all(settlements).then(() => {}),
  });
  const stopped = () => { try { return input.signal.aborted || input.killSwitchEngaged() !== false; } catch { return true; } };
  let ownedBytes: Buffer | undefined, plan: ImageDeliveryPlan;
  try {
    const approved = approvalCopy(input.approved); if (!captionValid(input.caption)) { recordFailure("admission", "input"); return result("refused", "input-refused"); }
    const artifact = input.registry.get(input.artifactRef); ownedBytes = input.registry.copyBytes(input.artifactRef);
    plan = planCopy({ version: "generated-image-delivery-v1", key: generatedImageDeliveryKey(approved), generation: "completed", approved,
      artifact, caption: input.caption, randomId: (randomBytes(8).readBigUInt64BE() % (2n ** 63n - 1n) + 1n).toString() }, ownedBytes);
    generated = true;
  } catch { recordFailure("admission", "input"); ownedBytes?.fill(0); return result("refused", "input-refused"); }
  const append = async (state: ImageDeliveryRecord["state"], ack?: ImageMediaAcknowledgement) => {
    await input.store.append(Object.freeze({ key: plan.key, planHash: hash(plan), state, ...(ack ? { messageId: ack.messageId, photoId: ack.photoId } : {}),
      ...((state === "unknown" || state === "failed_terminal") && diagnostics.originalStage !== "none" ? { diagnostics } : {}) }));
  };
  // Track actual promise settlement separately from the abort race. A pending
  // upload must keep its buffer intact until its transport lifetime ends.
  const invoke = async <T>(work: () => Promise<T>, clear?: () => void): Promise<T> => {
    pending++;
    const operation = Promise.resolve().then(() => { if (stopped()) throw new Error("stopped"); return work(); });
    const settled = operation.then(() => {}, () => {}).then(() => { clear?.(); pending--; }); settlements.push(settled);
    return new Promise<T>((done, reject) => {
      const abort = () => reject(new Error("aborted"));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      operation.then(done, reject).finally(() => input.signal.removeEventListener("abort", abort));
    });
  };
  try {
    if (stopped()) { recordFailure("admission", "stopped"); return result("refused", "stopped"); }
    try { await input.store.reserve(plan, ownedBytes); }
    catch (error) { recordFailure("persistence", error instanceof GeneratedImageOutboxError && error.code === "consumed" ? "consumed" : "storage"); return result(error instanceof GeneratedImageOutboxError && error.code === "consumed" ? "refused" : "unknown",
      error instanceof GeneratedImageOutboxError && error.code === "consumed" ? "consumed" : "persistence-unknown"); }
    if (stopped()) { recordFailure("admission", "stopped"); try { await append("failed_terminal"); return result("failed_terminal", "stopped"); } catch { return result("unknown", "persistence-unknown"); } }
    try { await append("sending"); } catch { recordFailure("persistence", "storage"); return result("unknown", "persistence-unknown"); }
    if (stopped()) { recordFailure("admission", "stopped"); try { await append("failed_terminal"); return result("failed_terminal", "stopped"); } catch { return result("unknown", "persistence-unknown"); } }
    const transportBytes = ownedBytes; ownedBytes = undefined;
    try {
      const sent = await invoke(() => input.transport.sendOnce(Object.freeze({ chatId: plan.approved.chatId, replyToMessageId: plan.approved.replyToMessageId,
        caption: plan.caption, randomId: plan.randomId, mimeType: "image/png", bytes: transportBytes }), input.signal), () => transportBytes.fill(0));
      if (!exact(sent, ["messageId", "photoId"]) || !id(sent.messageId) || !long(sent.photoId)) { recordFailure("ack-parse", "proof"); throw new Error("ack"); }
      if (stopped()) throw new Error("stopped");
      const ack = Object.freeze({ messageId: sent.messageId, photoId: sent.photoId });
      const read = await invoke(() => input.transport.readExact(plan.approved.chatId, ack.messageId, input.signal));
      if (!exact(read, ["messageId", "photoId", "chatId", "accountId", "replyToMessageId", "caption"]) ||
          read.messageId !== ack.messageId || read.photoId !== ack.photoId || read.chatId !== plan.approved.chatId || read.accountId !== plan.approved.accountId ||
          read.replyToMessageId !== plan.approved.replyToMessageId || read.caption !== plan.caption) { recordFailure("readback-parse", read === null ? "missing-message" : "proof"); throw new Error("readback"); }
      if (stopped()) throw new Error("stopped");
      try { await append("verified", ack); } catch { recordFailure("persistence", "storage"); return result("unknown", "persistence-unknown"); }
      return result("verified", "verified");
    } catch (error) {
      recordFailure("transport-wait", stopped() ? "stopped" : "unexpected", error);
      try { await append("unknown"); return result("unknown", "delivery-unknown"); } catch { return result("unknown", "persistence-unknown"); }
    }
  } finally { ownedBytes?.fill(0); }
}

/** New media-domain payload; session crypto is reused, not the text outbox's
 * schema. Caller provides a trusted root and proves its ACL/sole-client ownership.
 * Files are exclusive and synced; directory entry power-loss durability and
 * malicious deletion by an ACL owner are not claimed. JS plaintext strings from
 * encryption/decryption cannot be reliably zeroed; resident Buffer copies are. */
export async function openEncryptedGeneratedImageOutbox(input: {
  directory: string; passphrase: string; approved: ImageDeliveryApproval;
}): Promise<GeneratedImageMediaStore & { inspect(): Promise<ImageDeliveryInspection>; close(): void }> {
  const approved = approvalCopy(input.approved);
  const store = await openImageOutbox({ directory: input.directory, passphrase: input.passphrase, target: approved, approved }, false);
  return Object.freeze({ reserve: store.reserve, append: store.append, inspect: store.inspect, close: store.close });
}

/** Host-only exact lookup using an independently read own-photo anchor. No
 * directory enumeration, creation, repair or send capability. Origin comes from
 * the authenticated plan, not a newly invented epoch. The caller owns private
 * directory ACL admission. A reconnect does not change this deterministic slot. */
export async function readVerifiedGeneratedImage(input: Readonly<{
  directory: string; passphrase: string; accountId: string; chatId: string;
  replyToMessageId: number; messageId: number; photoId: string; signal?: AbortSignal;
}>): Promise<VerifiedGeneratedImage> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail("input");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const required = ["directory", "passphrase", "accountId", "chatId", "replyToMessageId", "messageId", "photoId"];
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || ![...required, "signal"].includes(key)) ||
      required.some(key => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some(d => !("value" in d) || !d.enumerable)) return fail("input");
  const value = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as unknown as typeof input;
  if (typeof value.directory !== "string" || typeof value.accountId !== "string" || !/^[1-9]\d{0,19}$/.test(value.accountId) ||
      typeof value.chatId !== "string" || !/^-[1-9]\d{0,19}$/.test(value.chatId) || !id(value.replyToMessageId) || !id(value.messageId) || !long(value.photoId) ||
      (value.signal !== undefined && (types.isProxy(value.signal) || !(value.signal instanceof AbortSignal)))) return fail("input");
  const signal = value.signal, target = Object.freeze({ accountId: value.accountId, chatId: value.chatId, replyToMessageId: value.replyToMessageId });
  let store: Awaited<ReturnType<typeof openImageOutbox>> | undefined, bytes: Buffer | undefined;
  const stopped = () => { if (signal?.aborted) return fail("closed"); };
  const abort = () => { store?.close(); bytes?.fill(0); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    stopped();
    store = await openImageOutbox({ directory: value.directory, passphrase: value.passphrase, target }, true);
    stopped();
    const loaded = await store.readVerified(value.messageId, value.photoId); bytes = loaded.bytes;
    stopped();
    const owned = bytes; bytes = undefined;
    let closed = false;
    const close = () => { if (closed) return; closed = true; owned.fill(0); signal?.removeEventListener("abort", close); };
    signal?.addEventListener("abort", close, { once: true });
    return Object.freeze({ artifact: loaded.artifact, bytes: owned, close });
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof GeneratedImageOutboxError) throw error;
    return fail("storage");
  } finally { signal?.removeEventListener("abort", abort); store?.close(); }
}

async function openImageOutbox(input: {
  directory: string; passphrase: string; target: ImageDeliveryTarget; approved?: ImageDeliveryApproval;
}, existingOnly: boolean) {
  const approved = input.approved, target = input.target, key = deliveryKey(target), directory = input.directory;
  let passphrase = input.passphrase, closed = false, busy = false;
  if (typeof passphrase !== "string" || passphrase.length < 16 || passphrase.length > 4096 || !isAbsolute(directory) || resolve(directory) !== directory) return fail("input");
  await assertPilotPrivateDirectory(dirname(directory));
  if (!existingOnly) { try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  await assertPilotPrivateDirectory(directory);
  const rootIdentity = await lstat(directory, { bigint: true }), attempt = join(directory, key);
  let attemptIdentity: { dev: bigint; ino: bigint } | undefined;
  let state: ImageDeliveryState | "unclaimed" | "blocked" = "unclaimed", plan: ImageDeliveryPlan | undefined;
  const check = async (own = false) => {
    if (closed) return fail("closed");
    await assertPilotPrivateDirectory(directory); const rootNow = await lstat(directory, { bigint: true });
    if (rootNow.dev !== rootIdentity.dev || rootNow.ino !== rootIdentity.ino) return fail("storage");
    if (own) { await assertPilotPrivateDirectory(attempt); const now = await lstat(attempt, { bigint: true });
      if (attemptIdentity && (now.dev !== attemptIdentity.dev || now.ino !== attemptIdentity.ino)) return fail("storage"); }
  };
  const wrap = (kind: string, payload: unknown) => ({ domain: "DecadansNeurobro/generated-image-outbox/v1", key, kind, payload });
  const write = async (name: string, kind: string, payload: unknown) => {
    if (existingOnly) return fail("input");
    const plaintext = JSON.stringify(wrap(kind, payload));
    if (kind === "metadata" && Buffer.byteLength(plaintext) > 49152) return fail("storage");
    const encrypted = await encryptSession(plaintext, passphrase);
    if (Buffer.byteLength(encrypted) > (kind === "artifact" ? 16 * 1024 * 1024 : 65536)) return fail("storage");
    await check(true); const file = await open(join(attempt, name), "wx", 0o600);
    try { await file.writeFile(encrypted, "utf8"); await file.sync(); } finally { await file.close(); }
    await check(true);
  };
  const read = async (name: string, kind: string): Promise<unknown> => {
    await check(true); const path = join(attempt, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0 || before.size > BigInt(kind === "artifact" ? 16 * 1024 * 1024 : 65536)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true }); if (inside.dev !== before.dev || inside.ino !== before.ino || inside.size !== before.size || inside.nlink !== 1n || !inside.isFile()) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
      if (length !== Number(before.size)) return fail("storage");
      const after = await lstat(path, { bigint: true });
      if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.nlink !== 1n) return fail("storage");
      const data = JSON.parse(await decryptSession(bytes.subarray(0, length).toString("utf8"), passphrase));
      if (!exact(data, ["domain", "key", "kind", "payload"]) || data.domain !== "DecadansNeurobro/generated-image-outbox/v1" || data.key !== key || data.kind !== kind) return fail("storage");
      await check(true); return data.payload;
    } finally { bytes?.fill(0); await file.close(); }
  };
  const operation = async <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return fail("closed"); if (busy) return fail("consumed"); busy = true;
    try { await check(); return await work(); } finally { busy = false; }
  };
  return Object.freeze({
    close() { closed = true; passphrase = ""; },
    async readVerified(messageId: number, photoId: string): Promise<{ artifact: GeneratedImageArtifact; bytes: Buffer }> {
      return operation(async () => {
        let bytes: Buffer | undefined;
        try {
          const own = await lstat(attempt, { bigint: true });
          if (!own.isDirectory() || own.isSymbolicLink()) return fail("storage");
          attemptIdentity = { dev: own.dev, ino: own.ino };
          const stored = await read("artifact.enc", "artifact");
          if (!exact(stored, ["plan", "imageBase64"]) || typeof stored.imageBase64 !== "string" || stored.imageBase64.length > 4 * Math.ceil(8 * 1024 * 1024 / 3)) return fail("storage");
          bytes = Buffer.from(stored.imageBase64, "base64");
          if (bytes.toString("base64") !== stored.imageBase64) return fail("storage");
          const verifiedPlan = planCopy(stored.plan as ImageDeliveryPlan, bytes);
          if (verifiedPlan.approved.accountId !== target.accountId || verifiedPlan.approved.chatId !== target.chatId ||
              verifiedPlan.approved.replyToMessageId !== target.replyToMessageId) return fail("storage");
          const sending = recordCopy(await read("sending.enc", "delivery") as ImageDeliveryRecord, verifiedPlan);
          const terminal = recordCopy(await read("terminal.enc", "delivery") as ImageDeliveryRecord, verifiedPlan);
          if (sending.state !== "sending" || terminal.state !== "verified" || terminal.messageId !== messageId || terminal.photoId !== photoId) return fail("storage");
          await check(true); if (closed) return fail("closed");
          const result = { artifact: verifiedPlan.artifact, bytes }; bytes = undefined; return result;
        } finally { bytes?.fill(0); }
      });
    },
    async reserve(value: ImageDeliveryPlan, source: Buffer) {
      if (existingOnly || !approved) return fail("input");
      return operation(async () => {
        if (state !== "unclaimed") return fail("consumed");
        if (!Buffer.isBuffer(source) || source.length > 8 * 1024 * 1024) return fail("input");
        const bytes = Buffer.from(source);
        try {
          const candidate = planCopy(value, bytes); if (hash(candidate.approved) !== hash(approved)) return fail("input");
          try { await mkdir(attempt, { mode: 0o700 }); }
          catch (error) { state = "blocked"; if ((error as NodeJS.ErrnoException).code === "EEXIST") return fail("consumed"); throw error; }
          const own = await lstat(attempt, { bigint: true }); attemptIdentity = { dev: own.dev, ino: own.ino };
          plan = candidate;
          await write("artifact.enc", "artifact", { plan, imageBase64: bytes.toString("base64") }); state = "planned";
        } catch (error) { state = "blocked"; if (error instanceof GeneratedImageOutboxError) throw error; return fail("storage"); }
        finally { bytes.fill(0); }
      });
    },
    async append(value: ImageDeliveryRecord) {
      if (existingOnly) return fail("input");
      return operation(async () => {
        try {
          if (!plan || state === "blocked" || state === "unclaimed") return fail("consumed");
          const next = recordCopy(value, plan);
          if (!((state === "planned" && ["sending", "failed_terminal"].includes(next.state)) || (state === "sending" && ["verified", "unknown", "failed_terminal"].includes(next.state)))) return fail("consumed");
          await write(next.state === "sending" ? "sending.enc" : "terminal.enc", "delivery", next); state = next.state;
          // Optional discovery companion: the synced terminal remains authoritative.
          // Failure cannot change the verdict, consumed slot or retry admission.
          if (next.state !== "sending") { try { await write("metadata.enc", "metadata", { plan }); } catch { /* Best effort after terminal sync. */ } }
        } catch (error) { state = "blocked"; if (error instanceof GeneratedImageOutboxError) throw error; return fail("storage"); }
      });
    },
    async inspect(): Promise<ImageDeliveryInspection> {
      if (!approved) return fail("input");
      return operation(async () => {
        let verifiedPlan: ImageDeliveryPlan | undefined;
        try {
          try {
            const own = await lstat(attempt, { bigint: true });
            if (!own.isDirectory() || own.isSymbolicLink()) return fail("storage");
            if (attemptIdentity && (attemptIdentity.dev !== own.dev || attemptIdentity.ino !== own.ino)) return fail("storage");
            attemptIdentity = { dev: own.dev, ino: own.ino };
          } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ generation: "unknown", delivery: "absent" }); throw error; }
          const stored = await read("artifact.enc", "artifact");
          if (!exact(stored, ["plan", "imageBase64"]) || typeof stored.imageBase64 !== "string" || stored.imageBase64.length > 4 * Math.ceil(8 * 1024 * 1024 / 3)) return fail("storage");
          const bytes = Buffer.from(stored.imageBase64, "base64");
          try { if (bytes.toString("base64") !== stored.imageBase64) return fail("storage"); verifiedPlan = planCopy(stored.plan as ImageDeliveryPlan, bytes); }
          finally { bytes.fill(0); }
          if (hash(verifiedPlan.approved) !== hash(approved)) return fail("storage");
          const base = { generation: "completed" as const, artifact: verifiedPlan.artifact, caption: verifiedPlan.caption, randomId: verifiedPlan.randomId };
          let sending: ImageDeliveryRecord | undefined, terminal: ImageDeliveryRecord | undefined;
          try { sending = recordCopy(await read("sending.enc", "delivery") as ImageDeliveryRecord, verifiedPlan); if (sending.state !== "sending") return fail("storage"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          try { terminal = recordCopy(await read("terminal.enc", "delivery") as ImageDeliveryRecord, verifiedPlan); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (terminal && (!sending && terminal.state !== "failed_terminal" || !["verified", "unknown", "failed_terminal"].includes(terminal.state))) return fail("storage");
          return Object.freeze({ ...base, delivery: terminal?.state ?? (sending ? "sending" : "planned"), ...(terminal?.diagnostics ? { diagnostics: terminal.diagnostics } : {}), ...(terminal?.state === "verified" ? { messageId: terminal.messageId!, photoId: terminal.photoId! } : {}) });
        } catch { return Object.freeze({ generation: verifiedPlan ? "completed" : "unknown", delivery: "unknown" }); }
      });
    },
  });
}
