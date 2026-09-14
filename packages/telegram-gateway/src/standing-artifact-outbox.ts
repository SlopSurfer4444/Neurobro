import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { encryptSession, decryptSession } from "./session-crypto.js";
import { validateStandingArtifact, type StandingArtifact, type StandingArtifactRegistry } from "./standing-artifact.js";
import { ArtifactTransportError, validateArtifactDiagnostics, type ArtifactDiagnostics, type ArtifactAcknowledgement, type ArtifactReadback } from "./standing-artifact-telegram.js";
import { inspectStandingMediaProfile, validateStandingMediaProfile, mediaProfileWire, type StandingMediaProfile } from "./standing-media-profile.js";

/** The application assigns a stable slot for a logical action in the selected
 * message. Never accept operationSlot/account/peer from model tool arguments.
 * A new native epoch or artifact ref must not reopen a consumed action. */
export type ArtifactDeliveryApproval = Readonly<{ accountId: string; chatId: string; replyToMessageId: number; operationSlot: number; requestRef: string }>;
export type ArtifactMediaKind = "file" | "audio" | "video" | "voice" | "round-video";
export type ArtifactDeliveryPlan = Readonly<{ version: "standing-artifact-delivery-v1"; key: string; approved: ArtifactDeliveryApproval; artifact: StandingArtifact; caption: string; randomId: string; mediaKind?: ArtifactMediaKind; mediaProfile?: StandingMediaProfile }>;
export type ArtifactDeliveryFailure = Readonly<{ stage: "prepare" | "persist" | "send" | "read"; reason: "invalid" | "stopped" | "consumed" | "unknown" | "pre-dispatch-refused"; transport?: ArtifactDiagnostics }>;
export type ArtifactDeliveryRecord = Readonly<{ key: string; planHash: string; state: "sending" | "verified" | "unknown" | "failed_terminal"; acknowledgement?: ArtifactAcknowledgement; failure?: ArtifactDeliveryFailure }>;
export interface ArtifactDeliveryStore { reserve(plan: ArtifactDeliveryPlan, bytes: Buffer): Promise<void>; append(record: ArtifactDeliveryRecord): Promise<void> }
export type ArtifactDeliveryTransport = Readonly<{
  sendOnce(input: Readonly<{ chatId: string; replyToMessageId: number; caption: string; randomId: string; filename: string; mimeType: string; bytes: Buffer; audio?: NonNullable<StandingArtifact["audio"]>; mediaProfile?: StandingMediaProfile }>, signal: AbortSignal): Promise<ArtifactAcknowledgement>;
  readExact(chatId: string, messageId: number, signal: AbortSignal): Promise<ArtifactReadback | null>;
}>;
export type ArtifactDeliveryResult = Readonly<{ delivery: "refused" | "verified" | "unknown" | "failed_terminal"; failure?: ArtifactDeliveryFailure; acknowledgement?: ArtifactAcknowledgement; transportSettled: boolean; settlement: Promise<void> }>;
export class ArtifactOutboxError extends Error { constructor(readonly code: "input" | "consumed" | "storage" | "closed") { super("ARTIFACT_OUTBOX_" + code.toUpperCase()); } }
const fail = (code: ArtifactOutboxError["code"]): never => { throw new ArtifactOutboxError(code); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !types.isProxy(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => plain(v) && Reflect.ownKeys(v).length === keys.length && keys.every(k => { const d = Object.getOwnPropertyDescriptor(v, k); return d && "value" in d; });
const identifier = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(v) && Buffer.from(v).toString() === v;
const id = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 2147483647;
const long = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,18}$/.test(v) && BigInt(v) < 2n ** 63n;
const captionValid = (v: unknown): v is string => typeof v === "string" && Buffer.byteLength(v) <= 1024 && !v.includes("\0") && Buffer.from(v).toString() === v;
function approvalCopy(value: ArtifactDeliveryApproval): ArtifactDeliveryApproval {
  if (!exact(value, ["accountId", "chatId", "replyToMessageId", "operationSlot", "requestRef"]) || !long(value.accountId) || typeof value.chatId !== "string" || !/^-[1-9]\d{0,19}$/.test(value.chatId) || !id(value.replyToMessageId) || !Number.isSafeInteger(value.operationSlot) || (value.operationSlot as number) < 0 || (value.operationSlot as number) > 31 || !identifier(value.requestRef)) return fail("input");
  return Object.freeze({ accountId: value.accountId, chatId: value.chatId, replyToMessageId: value.replyToMessageId, operationSlot: value.operationSlot as number, requestRef: value.requestRef });
}
export function artifactDeliveryKey(value: ArtifactDeliveryApproval): string { const a = approvalCopy(value); return hash(["standing-artifact-delivery-v1", a.accountId, a.chatId, a.replyToMessageId, a.operationSlot]); }
export const artifactDeliveryPlanHash = hash;
function planCopy(value: ArtifactDeliveryPlan, bytes: Buffer): ArtifactDeliveryPlan {
  const hasKind = plain(value) && Object.hasOwn(value, "mediaKind"), hasProfile = plain(value) && Object.hasOwn(value, "mediaProfile");
  if (!exact(value, ["version", "key", "approved", "artifact", "caption", "randomId", ...(hasKind ? ["mediaKind"] : []), ...(hasProfile ? ["mediaProfile"] : [])]) || value.version !== "standing-artifact-delivery-v1" || !captionValid(value.caption) || !long(value.randomId)) return fail("input");
  const approved = approvalCopy(value.approved as ArtifactDeliveryApproval), artifact = validateStandingArtifact(value.artifact as StandingArtifact, bytes);
  if (value.key !== artifactDeliveryKey(approved) || artifact.requestRef !== approved.requestRef) return fail("input");
  if (hasKind && !["file", "audio", "video", "voice", "round-video"].includes(value.mediaKind as string)) return fail("input");
  if (value.mediaKind === "audio" && !artifact.audio) return fail("input");
  const special = hasKind && !["file", "audio"].includes(value.mediaKind as string);
  if (hasProfile !== special) return fail("input");
  const mediaProfile = special ? validateStandingMediaProfile(value.mediaProfile, bytes, artifact.mimeType) : undefined;
  if (mediaProfile && mediaProfile.kind !== value.mediaKind) return fail("input");
  return Object.freeze({ version: "standing-artifact-delivery-v1", key: value.key as string, approved, artifact, caption: value.caption, randomId: value.randomId,
    ...(hasKind ? { mediaKind: value.mediaKind as ArtifactMediaKind } : {}), ...(mediaProfile ? { mediaProfile } : {}) });
}
function ackCopy(v: unknown): ArtifactAcknowledgement {
  if (!exact(v, ["messageId", "documentId"]) || !id(v.messageId) || !long(v.documentId)) return fail("input");
  return Object.freeze({ messageId: v.messageId, documentId: v.documentId });
}
function failureCopy(v: unknown): ArtifactDeliveryFailure {
  const extra = plain(v) && Object.hasOwn(v, "transport");
  if (!exact(v, ["stage", "reason", ...(extra ? ["transport"] : [])]) || !["prepare", "persist", "send", "read"].includes(v.stage as string) || !["invalid", "stopped", "consumed", "unknown", "pre-dispatch-refused"].includes(v.reason as string)) return fail("input");
  return Object.freeze({ stage: v.stage as ArtifactDeliveryFailure["stage"], reason: v.reason as ArtifactDeliveryFailure["reason"], ...(extra ? { transport: validateArtifactDiagnostics(v.transport) } : {}) });
}
function recordCopy(v: ArtifactDeliveryRecord, plan: ArtifactDeliveryPlan): ArtifactDeliveryRecord {
  const a = plain(v) && Object.hasOwn(v, "acknowledgement"), f = plain(v) && Object.hasOwn(v, "failure");
  if (!exact(v, ["key", "planHash", "state", ...(a ? ["acknowledgement"] : []), ...(f ? ["failure"] : [])]) || v.key !== plan.key || v.planHash !== hash(plan) || !["sending", "verified", "unknown", "failed_terminal"].includes(v.state as string) || (v.state === "verified") !== a || ((v.state === "unknown" || v.state === "failed_terminal") !== f)) return fail("input");
  return Object.freeze({ key: plan.key, planHash: hash(plan), state: v.state as ArtifactDeliveryRecord["state"], ...(a ? { acknowledgement: ackCopy(v.acknowledgement) } : {}), ...(f ? { failure: failureCopy(v.failure) } : {}) });
}
function audioMatches(value: unknown, expected: StandingArtifact["audio"]): boolean {
  if (!expected) return value === undefined;
  return exact(value, ["durationSeconds", ...(expected.title === undefined ? [] : ["title"]), ...(expected.performer === undefined ? [] : ["performer"])]) &&
    value.durationSeconds === expected.durationSeconds && value.title === expected.title && value.performer === expected.performer;
}

function transportDiagnostics(error: unknown): ArtifactDiagnostics | undefined {
  if (!error || typeof error !== "object" || types.isProxy(error) || !(error instanceof ArtifactTransportError)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "diagnostics");
  if (!descriptor || !("value" in descriptor)) return undefined;
  try { return validateArtifactDiagnostics(descriptor.value); } catch { return undefined; }
}

/** Actual in-flight promises remain owned after abort. The caller joins
 * settlement before closing/reusing the sole Telegram client. No replay. */
export async function runArtifactDelivery(input: { approved: ArtifactDeliveryApproval; registry: Pick<StandingArtifactRegistry, "get" | "copyBytes">; artifactRef: string; caption: string; mediaKind?: ArtifactMediaKind; store: ArtifactDeliveryStore; transport: ArtifactDeliveryTransport; signal: AbortSignal; killSwitchEngaged(): boolean }): Promise<ArtifactDeliveryResult> {
  let owned: Buffer | undefined, plan: ArtifactDeliveryPlan, failure: ArtifactDeliveryFailure | undefined, pending = 0;
  const settlements: Promise<void>[] = [];
  const stopped = () => { try { return input.signal.aborted || input.killSwitchEngaged() !== false; } catch { return true; } };
  const note = (stage: ArtifactDeliveryFailure["stage"], reason: ArtifactDeliveryFailure["reason"], error?: unknown) => {
    const transport = transportDiagnostics(error);
    failure ??= failureCopy({ stage, reason, ...(transport ? { transport } : {}) });
  };
  const result = (delivery: ArtifactDeliveryResult["delivery"], acknowledgement?: ArtifactAcknowledgement): ArtifactDeliveryResult => Object.freeze({ delivery, ...(failure ? { failure } : {}), ...(acknowledgement ? { acknowledgement } : {}), transportSettled: pending === 0, settlement: Promise.all(settlements).then(() => {}) });
  const invoke = async <T>(work: () => Promise<T>, clear?: () => void): Promise<T> => {
    pending++;
    const op = Promise.resolve().then(() => { if (stopped()) throw new Error("stopped"); return work(); });
    const settled = op.then(() => {}, () => {}).then(() => { clear?.(); pending--; }); settlements.push(settled);
    return new Promise<T>((resolveValue, reject) => {
      const abort = () => reject(new Error("aborted")); input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
      op.then(resolveValue, reject).finally(() => input.signal.removeEventListener("abort", abort));
    });
  };
  try {
    try {
      const approved = approvalCopy(input.approved), artifact = input.registry.get(input.artifactRef); owned = input.registry.copyBytes(input.artifactRef);
      const mediaKind = input.mediaKind;
      if (mediaKind !== undefined && !["file", "audio", "video", "voice", "round-video"].includes(mediaKind)) throw new Error("media-kind");
      if (mediaKind === "round-video" && input.caption !== "") throw new Error("round-caption");
      const mediaProfile = mediaKind && mediaKind !== "file" && mediaKind !== "audio" ? inspectStandingMediaProfile({ kind: mediaKind, mimeType: artifact.mimeType, bytes: owned }) : undefined;
      plan = planCopy({ version: "standing-artifact-delivery-v1", key: artifactDeliveryKey(approved), approved, artifact, caption: input.caption, randomId: (randomBytes(8).readBigUInt64BE() % (2n ** 63n - 1n) + 1n).toString(),
        ...(mediaKind === undefined ? {} : { mediaKind }), ...(mediaProfile ? { mediaProfile } : {}) }, owned);
    } catch { note("prepare", "invalid"); return result("refused"); }
    const append = async (state: ArtifactDeliveryRecord["state"], acknowledgement?: ArtifactAcknowledgement) => input.store.append(recordCopy({ key: plan.key, planHash: hash(plan), state, ...(acknowledgement ? { acknowledgement } : {}), ...(failure ? { failure } : {}) }, plan));
    if (stopped()) { note("prepare", "stopped"); return result("refused"); }
    try { await input.store.reserve(plan, owned!); }
    catch (error) { note("persist", error instanceof ArtifactOutboxError && error.code === "consumed" ? "consumed" : "unknown"); return result(failure!.reason === "consumed" ? "refused" : "unknown"); }
    if (stopped()) { note("prepare", "stopped"); try { await append("failed_terminal"); return result("failed_terminal"); } catch { return result("unknown"); } }
    try { await append("sending"); } catch { note("persist", "unknown"); return result("unknown"); }
    if (stopped()) { note("prepare", "stopped"); try { await append("failed_terminal"); return result("failed_terminal"); } catch { return result("unknown"); } }
    let stage: "send" | "read" = "send";
    try {
      const bytes = owned!; owned = undefined;
      // MP3 frame timing is fractional; Telegram's audio duration is integer seconds.
      const audio = plan.artifact.audio && (plan.mediaKind === undefined || plan.mediaKind === "audio") ? Object.freeze({ ...plan.artifact.audio, durationSeconds: Math.ceil(plan.artifact.audio.durationSeconds) }) : undefined;
      const media = plan.mediaProfile ? mediaProfileWire(plan.mediaProfile) : undefined;
      const acknowledgement = ackCopy(await invoke(() => input.transport.sendOnce({ chatId: plan.approved.chatId, replyToMessageId: plan.approved.replyToMessageId, caption: plan.caption, randomId: plan.randomId, filename: plan.artifact.filename, mimeType: plan.artifact.mimeType, bytes, ...(audio ? { audio } : {}), ...(plan.mediaProfile ? { mediaProfile: plan.mediaProfile } : {}) }, input.signal), () => bytes.fill(0)));
      if (stopped()) throw new Error("stopped"); stage = "read";
      const read = await invoke(() => input.transport.readExact(plan.approved.chatId, acknowledgement.messageId, input.signal));
      if (!exact(read, ["messageId", "documentId", "chatId", "accountId", "replyToMessageId", "caption", "filename", "mimeType", "byteLength", ...(audio ? ["audio"] : []), ...(media ? ["media"] : [])]) || read.messageId !== acknowledgement.messageId || read.documentId !== acknowledgement.documentId || read.chatId !== plan.approved.chatId || read.accountId !== plan.approved.accountId || read.replyToMessageId !== plan.approved.replyToMessageId || read.caption !== plan.caption || read.filename !== plan.artifact.filename || read.mimeType !== plan.artifact.mimeType || read.byteLength !== plan.artifact.byteLength || !audioMatches(read.audio, audio) || (media ? !exact(read.media, Object.keys(media)) || Object.entries(media).some(([k,v]) => (read.media as Record<string,unknown>)[k] !== v) : read.media !== undefined)) throw new Error("readback");
      if (stopped()) throw new Error("stopped");
      try { await append("verified", acknowledgement); } catch { note("persist", "unknown"); return result("unknown"); }
      return result("verified", acknowledgement);
    } catch (error) {
      const diagnostics = transportDiagnostics(error);
      // Only this trusted transport's pre-SendMedia stages prove no message
      // dispatch. A duplicate-call error, abort race, generic exception or any
      // failure after send-invoke remains UNKNOWN. Join the raw operation before
      // publishing the terminal; uploaded temporary parts are never replayed.
      if (stage === "send" && diagnostics && diagnostics.reason !== "consumed" &&
          ["admission", "revalidate-before", "upload", "revalidate-after"].includes(diagnostics.stage)) {
        await Promise.all(settlements);
        note(stage, "pre-dispatch-refused", error);
        try { await append("failed_terminal"); return result("failed_terminal"); }
        catch { return result("unknown"); }
      }
      note(stage, stopped() ? "stopped" : "unknown", error);
      try { await append("unknown"); } catch { /* First failure remains; persisted outcome may be unknown. */ }
      return result("unknown");
    }
  } finally { owned?.fill(0); }
}

export type ArtifactDeliveryInspection = Readonly<{ delivery: "absent" | "planned" | "sending" | "verified" | "unknown" | "failed_terminal"; artifact?: StandingArtifact; acknowledgement?: ArtifactAcknowledgement; failure?: ArtifactDeliveryFailure }>;
/** Trusted private root only; caller owns ACL and sole runtime admission.
 * Exclusive synced records preserve uncertain actions. Does not resend or
 * expose plaintext bytes. Directory-entry power-loss durability is not claimed. */
export async function openEncryptedArtifactOutbox(input: { directory: string; passphrase: string; approved: ArtifactDeliveryApproval }): Promise<ArtifactDeliveryStore & { inspect(): Promise<ArtifactDeliveryInspection>; close(): void }> {
  const approved = approvalCopy(input.approved), key = artifactDeliveryKey(approved), directory = input.directory;
  let passphrase = input.passphrase, closed = false, busy = false;
  if (typeof passphrase !== "string" || passphrase.length < 16 || passphrase.length > 4096 || !isAbsolute(directory) || resolve(directory) !== directory) return fail("input");
  await assertPilotPrivateDirectory(dirname(directory)); try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") return fail("storage"); }
  await assertPilotPrivateDirectory(directory);
  const root = await lstat(directory, { bigint: true }), attempt = join(directory, key);
  let owner: { dev: bigint; ino: bigint } | undefined, state = "unclaimed", plan: ArtifactDeliveryPlan | undefined;
  const check = async (own = false) => {
    if (closed) return fail("closed"); await assertPilotPrivateDirectory(directory); const now = await lstat(directory, { bigint: true });
    if (root.dev !== now.dev || root.ino !== now.ino) return fail("storage");
    if (own) { await assertPilotPrivateDirectory(attempt); const a = await lstat(attempt, { bigint: true }); if (owner && (a.dev !== owner.dev || a.ino !== owner.ino)) return fail("storage"); }
  };
  const limit = (kind: string) => kind === "artifact" ? 64 * 1024 * 1024 : 65536;
  const write = async (name: string, kind: string, payload: unknown) => {
    const plaintext = JSON.stringify({ domain: "DecadansNeurobro/artifact-outbox/v1", key, kind, payload });
    if (kind === "metadata" && Buffer.byteLength(plaintext) > 49152) return fail("storage");
    const encrypted = await encryptSession(plaintext, passphrase);
    if (Buffer.byteLength(encrypted) > limit(kind)) return fail("storage"); await check(true);
    const file = await open(join(attempt, name), "wx", 0o600); try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); } await check(true);
  };
  const read = async (name: string, kind: string): Promise<unknown> => {
    await check(true); const path = join(attempt, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(limit(kind))) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true }); if (!inside.isFile() || inside.dev !== before.dev || inside.ino !== before.ino || inside.size !== before.size || inside.nlink !== 1n) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let n = 0;
      while (n < bytes.length) { const r = await file.read(bytes, n, bytes.length - n, null); if (!r.bytesRead) break; n += r.bytesRead; }
      const after = await lstat(path, { bigint: true }); if (n !== Number(before.size) || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.nlink !== 1n) return fail("storage");
      const value = JSON.parse(await decryptSession(bytes.subarray(0, n).toString(), passphrase));
      if (!exact(value, ["domain", "key", "kind", "payload"]) || value.domain !== "DecadansNeurobro/artifact-outbox/v1" || value.key !== key || value.kind !== kind) return fail("storage"); await check(true); return value.payload;
    } finally { bytes?.fill(0); await file.close(); }
  };
  const operation = async <T>(work: () => Promise<T>): Promise<T> => { if (closed) return fail("closed"); if (busy) return fail("consumed"); busy = true; try { await check(); return await work(); } finally { busy = false; } };
  return Object.freeze({
    close() { closed = true; passphrase = ""; },
    async reserve(value: ArtifactDeliveryPlan, source: Buffer) {
      // Capture before the first await; caller mutation cannot change persisted bytes.
      if (!Buffer.isBuffer(source) || source.length > 32 * 1024 * 1024) return fail("input");
      const bytes = Buffer.from(source); let candidate: ArtifactDeliveryPlan;
      try { candidate = planCopy(value, bytes); } catch { bytes.fill(0); return fail("input"); }
      try { return await operation(async () => {
        if (state !== "unclaimed") return fail("consumed"); if (hash(candidate.approved) !== hash(approved)) return fail("input");
        try { await mkdir(attempt, { mode: 0o700 }); } catch (e) { state = "blocked"; if ((e as NodeJS.ErrnoException).code === "EEXIST") return fail("consumed"); return fail("storage"); }
        const own = await lstat(attempt, { bigint: true }); owner = { dev: own.dev, ino: own.ino }; plan = candidate;
        try { await write("artifact.enc", "artifact", { plan, fileBase64: bytes.toString("base64") }); state = "planned"; } catch { state = "blocked"; return fail("storage"); }
      }); } finally { bytes.fill(0); }
    },
    async append(value: ArtifactDeliveryRecord) {
      if (!plan) return fail("consumed"); const next = recordCopy(value, plan);
      return operation(async () => {
        if (!((state === "planned" && ["sending", "failed_terminal"].includes(next.state)) || (state === "sending" && ["verified", "unknown", "failed_terminal"].includes(next.state)))) return fail("consumed");
        try { await write(next.state === "sending" ? "sending.enc" : "terminal.enc", "delivery", next); state = next.state; } catch { state = "blocked"; return fail("storage"); }
        // Optional discovery companion follows the synced authoritative terminal.
        // Missing or failed metadata never changes the consumed delivery verdict.
        if (next.state !== "sending") { try { await write("metadata.enc", "metadata", { plan }); } catch { /* Best effort after terminal sync. */ } }
      });
    },
    async inspect(): Promise<ArtifactDeliveryInspection> {
      return operation(async () => {
        let verifiedPlan: ArtifactDeliveryPlan | undefined;
        try {
          try { const own = await lstat(attempt, { bigint: true }); if (!own.isDirectory() || own.isSymbolicLink() || (owner && (own.dev !== owner.dev || own.ino !== owner.ino))) return fail("storage"); owner = { dev: own.dev, ino: own.ino }; }
          catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ delivery: "absent" }); throw e; }
          const stored = await read("artifact.enc", "artifact"); if (!exact(stored, ["plan", "fileBase64"]) || typeof stored.fileBase64 !== "string" || stored.fileBase64.length > 4 * Math.ceil(32 * 1024 * 1024 / 3)) return fail("storage");
          const bytes = Buffer.from(stored.fileBase64, "base64");
          try { if (bytes.toString("base64") !== stored.fileBase64) return fail("storage"); verifiedPlan = planCopy(stored.plan as ArtifactDeliveryPlan, bytes); } finally { bytes.fill(0); }
          if (artifactDeliveryKey(verifiedPlan.approved) !== key) return fail("storage");
          let sending: ArtifactDeliveryRecord | undefined, terminal: ArtifactDeliveryRecord | undefined;
          try { sending = recordCopy(await read("sending.enc", "delivery") as ArtifactDeliveryRecord, verifiedPlan); if (sending.state !== "sending") return fail("storage"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          try { terminal = recordCopy(await read("terminal.enc", "delivery") as ArtifactDeliveryRecord, verifiedPlan); if (terminal.state === "sending" || (!sending && terminal.state !== "failed_terminal")) return fail("storage"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          return Object.freeze({ delivery: terminal?.state ?? (sending ? "sending" : "planned"), artifact: verifiedPlan.artifact, ...(terminal?.acknowledgement ? { acknowledgement: terminal.acknowledgement } : {}), ...(terminal?.failure ? { failure: terminal.failure } : {}) });
        } catch { return Object.freeze({ delivery: "unknown", ...(verifiedPlan ? { artifact: verifiedPlan.artifact } : {}) }); }
      });
    },
  });
}
