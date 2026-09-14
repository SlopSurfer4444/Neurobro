import { createDecipheriv, createHash, scrypt } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory, isPilotDeliveryDiagnostic, type PilotRecord, type PilotReply } from "./pilot-outbox.js";
import { decryptSession } from "./session-crypto.js";
import { decodeStandingActionSlot, standingActionKey, snapshotStandingActionJson, type StandingActionBinding, type StandingActionIntent, type StandingActionTerminal } from "./standing-action-journal.js";
import { projectStandingOwnAction, type StandingOwnActionSource, type StandingOwnActionView } from "./standing-own-action-projection.js";
import { copyTelegramTextEntities } from "./telegram-text-format.js";
import type { ImageDeliveryPlan, ImageDeliveryRecord } from "./generated-image-outbox.js";
import type { ArtifactDeliveryPlan, ArtifactDeliveryRecord } from "./standing-artifact-outbox.js";

export type StandingOwnActionFamily = StandingOwnActionSource["family"];
export type StandingOwnActionSourceGap = "root-absent" | "slot-absent" | "incomplete-records" | "compact-metadata-missing" |
  "source-unavailable" | "text-join-missing" | "text-join-unavailable" | "local-material-not-inspected";
export type StandingOwnActionReadResult = Readonly<{
  status: "ready" | "absent" | "incomplete" | "legacy" | "unavailable";
  view?: StandingOwnActionView;
  gaps: readonly StandingOwnActionSourceGap[];
}>;
export type StandingOwnActionReaderInput = Readonly<{
  directories: Readonly<{ pilot: string; images: string; artifacts: string; actions: string; dialogues?: string }>;
  binding: Readonly<{ accountId: string; chatId: string }>;
  passphrase: string;
  referenceKey: string;
  signal?: AbortSignal;
}>;
export type StandingOwnActionReader = Readonly<{
  read(input: Readonly<{ family: StandingOwnActionFamily; slot: string }>): Promise<StandingOwnActionReadResult>;
  close(): Promise<void>;
}>;
export class StandingOwnActionReaderError extends Error {
  constructor(readonly code: "input" | "closed" | "busy" | "storage") { super("STANDING_OWN_ACTION_READER_" + code.toUpperCase()); }
}
const fail = (code: StandingOwnActionReaderError["code"] = "storage"): never => { throw new StandingOwnActionReaderError(code); };
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const integer = (v: unknown, max: number, min = 1): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const messageId = (v: unknown) => integer(v, 2147483647);
const long = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,18}$/.test(v) && BigInt(v) < 2n ** 63n;
const text = (v: unknown, max: number, empty = false): v is string => typeof v === "string" && v.length <= max && (empty || v.length > 0) &&
  !v.includes("\0") && Buffer.byteLength(v) <= max && Buffer.from(v).toString() === v;
const opaque = (v: unknown, max = 256) => text(v, max) && !/[\u0000-\u0020\u007f-\u009f]/u.test(v);
const hex = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
function fields(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, any> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (keys.length > required.length + optional.length || required.some(k => !Object.hasOwn(ds, k))) return fail();
  const out: Record<string, any> = {};
  for (const k of keys) { if (typeof k !== "string" || !required.includes(k) && !optional.includes(k)) return fail(); const d = ds[k]!; if (!("value" in d) || !d.enumerable) return fail(); out[k] = d.value; }
  return out;
}
function result(status: StandingOwnActionReadResult["status"], gaps: readonly StandingOwnActionSourceGap[], view?: StandingOwnActionView): StandingOwnActionReadResult {
  return Object.freeze({ status, ...(view ? { view } : {}), gaps: Object.freeze([...gaps]) });
}
function base64(value: unknown, size?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > 1398208 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || size !== undefined && bytes.length !== size) { bytes.fill(0); return fail(); }
  return bytes;
}
function encryptedEnvelope(serialized: string, pilot: boolean): Record<string, any> {
  const e = fields(JSON.parse(serialized), pilot ? ["version", "algorithm", "kdf", "salt", "iv", "tag", "ciphertext"] : ["schemaVersion", "algorithm", "kdf", "salt", "iv", "authTag", "ciphertext"]);
  if ((pilot ? e.version : e.schemaVersion) !== 1 || e.algorithm !== "aes-256-gcm" || e.kdf !== "scrypt") return fail();
  for (const [key, size] of [["salt", 16], ["iv", 12], [pilot ? "tag" : "authTag", 16]] as const) base64(e[key], size).fill(0);
  base64(e.ciphertext).fill(0);
  return e;
}
async function decryptPilot(serialized: string, passphrase: string): Promise<unknown> {
  const e = encryptedEnvelope(serialized, true), salt = base64(e.salt, 16), iv = base64(e.iv, 12), tag = base64(e.tag, 16), cipher = base64(e.ciphertext);
  let key: Buffer | undefined, clear: Buffer | undefined;
  try {
    key = await new Promise<Buffer>((resolve, reject) => scrypt(passphrase, salt, 32, (error, value) => error ? reject(error) : resolve(value)));
    const d = createDecipheriv("aes-256-gcm", key, iv); d.setAAD(Buffer.from("DecadansNeurobro/pilot-outbox/v1")); d.setAuthTag(tag);
    clear = Buffer.concat([d.update(cipher), d.final()]); if (clear.length > 49152 || Buffer.from(clear.toString()).compare(clear) !== 0) return fail();
    return JSON.parse(clear.toString());
  } finally { key?.fill(0); clear?.fill(0); salt.fill(0); iv.fill(0); tag.fill(0); cipher.fill(0); }
}
function pilotRecord(value: unknown): PilotRecord {
  const r = fields(value, ["version", "state", "idempotencyKey", "randomId", "chatId", "accountId", "replyToMessageId", "contentHash", "textBytes"], ["messageId"]);
  if (r.version !== "pilot-outbox-v1" || !["planned", "sending", "verified", "unknown", "failed_terminal"].includes(r.state) || !hex(r.idempotencyKey) || !hex(r.contentHash) ||
      !long(r.randomId) || !long(r.accountId) || typeof r.chatId !== "string" || !/^-[1-9]\d{0,19}$/.test(r.chatId) || !integer(r.textBytes, 4096) ||
      !(r.replyToMessageId === null || messageId(r.replyToMessageId)) || (r.state === "verified") !== Object.hasOwn(r, "messageId") || Object.hasOwn(r, "messageId") && !messageId(r.messageId)) return fail();
  return r as PilotRecord;
}
function pilotIdentity(r: PilotRecord): unknown {
  return [r.version, r.idempotencyKey, r.randomId, r.chatId, r.accountId, r.replyToMessageId, r.contentHash, r.textBytes];
}
/** Metadata syntax only. The original authenticated terminal commits to this
 * exact plan; no format/byte revalidation or local availability is claimed. */
function mediaPlan(value: unknown, image: boolean): ImageDeliveryPlan | ArtifactDeliveryPlan {
  const p = fields(value, image ? ["version", "key", "generation", "approved", "artifact", "caption", "randomId"] : ["version", "key", "approved", "artifact", "caption", "randomId"], image ? [] : ["mediaKind", "mediaProfile"]);
  const a = fields(p.approved, image ? ["chatId", "accountId", "replyToMessageId", "origin"] : ["accountId", "chatId", "replyToMessageId", "operationSlot", "requestRef"]);
  if (!hex(p.key) || !long(p.randomId) || !long(a.accountId) || typeof a.chatId !== "string" || !/^-[1-9]\d{0,19}$/.test(a.chatId) || !messageId(a.replyToMessageId) || !text(p.caption, 1024, true)) return fail();
  if (image) {
    const origin = (v: unknown) => { const o = fields(v, ["requestRef", "threadId", "turnId", "itemId"]); if (Object.values(o).some(v => !opaque(v))) return fail(); };
    origin(a.origin);
    const f = fields(p.artifact, ["version", "ref", "origin", "mimeType", "byteLength", "sha256", "width", "height"]); origin(f.origin);
    if (p.version !== "generated-image-delivery-v1" || p.generation !== "completed" || f.version !== "generated-image-v1" || !/^img_[a-f0-9]{48}$/.test(f.ref) || !hex(f.sha256)) return fail();
  } else {
    if (p.version !== "standing-artifact-delivery-v1" || !integer(a.operationSlot, 31, 0) || !opaque(a.requestRef)) return fail();
    const f = fields(p.artifact, ["version", "ref", "requestRef", "source", "filename", "mimeType", "byteLength", "sha256"], ["audio"]);
    const source = fields(f.source, ["kind", "reference"]);
    if (f.version !== "standing-artifact-v1" || typeof f.ref !== "string" || !/^art_[0-9a-f]{48}$/.test(f.ref) || f.requestRef !== a.requestRef || !hex(f.sha256) ||
        !["download", "generated", "attachment"].includes(source.kind) || !(source.kind === "download" ? text(source.reference, 4096) : opaque(source.reference))) return fail();
    if (Object.hasOwn(f, "audio")) {
      const audio = fields(f.audio, ["durationSeconds"], ["title", "performer"]);
      if (f.mimeType !== "audio/mpeg" || typeof audio.durationSeconds !== "number" || !Number.isFinite(audio.durationSeconds) || audio.durationSeconds < 0 ||
          Object.hasOwn(audio, "title") && !text(audio.title, 255) || Object.hasOwn(audio, "performer") && !text(audio.performer, 255)) return fail();
    }
    const special = ["video", "voice", "round-video"].includes(p.mediaKind);
    if (special !== Object.hasOwn(p, "mediaProfile") || p.mediaKind === "audio" && !f.audio) return fail();
    if (special) {
      const m = fields(p.mediaProfile, ["version", "kind", "mimeType", "sha256", "byteLength", "durationSeconds"], ["width", "height"]);
      if (m.version !== "standing-media-profile-v1" || m.kind !== p.mediaKind || m.sha256 !== f.sha256 || m.byteLength !== f.byteLength || m.mimeType !== f.mimeType ||
          typeof m.durationSeconds !== "number" || !Number.isFinite(m.durationSeconds) || m.durationSeconds < 0 ||
          (m.kind === "voice" ? m.mimeType !== "audio/ogg" || Object.hasOwn(m, "width") || Object.hasOwn(m, "height") : m.mimeType !== "video/mp4" || !integer(m.width, 8192) || !integer(m.height, 8192))) return fail();
    }
  }
  return value as ImageDeliveryPlan | ArtifactDeliveryPlan;
}

/** No enumeration, creation, repair, media blob reads, send or replay authority.
 * Roots and immutable files remain pinned through crypto and projection. Caller
 * provides the existing protected state roots and stable private reference key.
 */
export async function openStandingOwnActionReader(value: StandingOwnActionReaderInput): Promise<StandingOwnActionReader> {
  let args: Record<string, any>, dirs: Record<string, any>, binding: { accountId: string; chatId: string };
  try {
    args = fields(value, ["directories", "binding", "passphrase", "referenceKey"], ["signal"]);
    dirs = fields(args.directories, ["pilot", "images", "artifacts", "actions"], ["dialogues"]);
    const b = fields(args.binding, ["accountId", "chatId"]);
    if (!long(b.accountId) || typeof b.chatId !== "string" || !/^-[1-9]\d{0,19}$/.test(b.chatId) || !text(args.passphrase, 4096) || args.passphrase.length < 16 || !hex(args.referenceKey) ||
        Object.values(dirs).some(v => !text(v, 32768) || !isAbsolute(v) || resolve(v) !== v) || args.signal !== undefined && (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal))) return fail("input");
    if (args.signal !== undefined) abortedGetter.call(args.signal);
    binding = Object.freeze({ accountId: b.accountId, chatId: b.chatId });
  } catch { return fail("input"); }
  let passphrase = args.passphrase as string, referenceKey = args.referenceKey as string, closed = false;
  const signal = args.signal as AbortSignal | undefined;
  const aborted = () => signal !== undefined && abortedGetter.call(signal) === true;
  let active: Promise<StandingOwnActionReadResult> | undefined, closing: Promise<void> | undefined;
  const roots = new Map<string, BigIntStats | null | "unavailable">();
  const check = () => { if (closed || aborted()) return fail("closed"); };
  for (const path of Object.values(dirs) as string[]) {
    check(); try { await assertPilotPrivateDirectory(path); roots.set(path, await lstat(path, { bigint: true })); }
    catch (e) { roots.set(path, missing(e) ? null : "unavailable"); }
  }
  const close = (): Promise<void> => {
    if (closing) return closing; closed = true;
    closing = Promise.resolve(active).then(() => {}, () => {}).finally(() => { passphrase = ""; referenceKey = ""; roots.clear(); if (signal) EventTarget.prototype.removeEventListener.call(signal, "abort", revoke); });
    return closing;
  };
  const revoke = () => { void close(); };
  if (signal) EventTarget.prototype.addEventListener.call(signal, "abort", revoke, { once: true });
  if (aborted()) { await close(); return fail("closed"); }
  async function guardRoot(path: string): Promise<boolean> {
    check(); const before = roots.get(path); if (before === "unavailable" || before === undefined) return fail();
    if (before === null) { try { await lstat(path); } catch (e) { if (missing(e)) return false; throw e; } return fail(); }
    await assertPilotPrivateDirectory(path); const after = await lstat(path, { bigint: true }); if (!same(before, after)) return fail(); check(); return true;
  }
  async function work(family: StandingOwnActionFamily, slot: string): Promise<StandingOwnActionReadResult> {
    const root = dirs[family === "pilot" ? "pilot" : family === "generated-image" ? "images" : family === "artifact" ? "artifacts" : "actions"] as string;
    if (!await guardRoot(root)) return result("absent", ["root-absent"]);
    const path = join(root, slot); let own: BigIntStats;
    try { await assertPilotPrivateDirectory(path); own = await lstat(path, { bigint: true }); }
    catch (e) { if (missing(e)) return result("absent", ["slot-absent"]); throw e; }
    const versions = new Map<string, string>();
    const usedRoots = new Set([root]);
    const guard = async () => {
      for (const used of usedRoots) await guardRoot(used);
      await assertPilotPrivateDirectory(path); if (!same(own, await lstat(path, { bigint: true }))) return fail();
      for (const [file, version] of versions) { const s = await lstat(file, { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || stamp(s) !== version) return fail(); }
      check();
    };
    const allowed = family === "pilot" ? ["planned.enc", "sending.enc", "terminal.enc"] : family === "bound-action" ? ["intent.enc", "terminal.enc"] : ["artifact.enc", "metadata.enc", "sending.enc", "terminal.enc"];
    const names = new Set<string>();
    const listing = await opendir(path, { bufferSize: 1 });
    try { for (;;) { check(); const entry = await listing.read(); if (!entry) break; if (names.size >= allowed.length || !allowed.includes(entry.name) || !entry.isFile() || entry.isSymbolicLink()) return fail();
      const file = join(path, entry.name), stat = await lstat(file, { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return fail(); names.add(entry.name); versions.set(file, stamp(stat));
    } } finally { await listing.close(); }
    await guard();
    const read = async (file: string, cap = 65536): Promise<string> => {
      await guard(); const before = await lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(cap)) return fail();
      const handle = await open(file, "r"); let bytes: Buffer | undefined;
      try {
        const inside = await handle.stat({ bigint: true }); if (!inside.isFile() || stamp(before) !== stamp(inside)) return fail();
        bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
        while (count < bytes.length) { check(); const n = await handle.read(bytes, count, bytes.length - count, null); if (!n.bytesRead) break; count += n.bytesRead; }
        const after = await lstat(file, { bigint: true }); if (count !== Number(before.size) || stamp(after) !== stamp(before) || !after.isFile() || after.isSymbolicLink()) return fail();
        const prior = versions.get(file); if (prior !== undefined && prior !== stamp(before)) return fail(); versions.set(file, stamp(before));
        const serialized = bytes.subarray(0, count).toString(); if (Buffer.from(serialized).compare(bytes.subarray(0, count)) !== 0) return fail(); await guard(); return serialized;
      } finally { bytes?.fill(0); await handle.close(); }
    };
    const session = async (file: string, cap = 65536, plainCap = 49152): Promise<any> => {
      const serialized = await read(file, cap); encryptedEnvelope(serialized, false);
      const clear = await decryptSession(serialized, passphrase); if (clear.length > plainCap || Buffer.byteLength(clear) > plainCap) return fail(); await guard(); return JSON.parse(clear);
    };
    const envelope = async (name: string, domain: string, kind: string) => {
      const e = fields(await session(join(path, name)), ["domain", "key", "kind", "payload"]);
      if (e.domain !== domain || e.key !== slot || e.kind !== kind) return fail(); return e.payload;
    };
    let source: StandingOwnActionSource, projectionSlot = slot;
    const gaps: StandingOwnActionSourceGap[] = [];
    if (family === "pilot") {
      if (!names.has("planned.enc")) return result(names.size ? "unavailable" : "incomplete", ["incomplete-records"]);
      const records = new Map<string, PilotRecord>();
      for (const name of ["planned.enc", "sending.enc", "terminal.enc"]) if (names.has(name)) {
        const r = pilotRecord(await decryptPilot(await read(join(path, name)), passphrase)); await guard();
        if (r.accountId !== binding.accountId || r.chatId !== binding.chatId || name === "planned.enc" && r.state !== "planned" || name === "sending.enc" && r.state !== "sending" || name === "terminal.enc" && !["verified", "unknown", "failed_terminal"].includes(r.state)) return fail(); records.set(name, r);
      }
      const planned = records.get("planned.enc")!, sending = records.get("sending.enc"), terminal = records.get("terminal.enc");
      if ([...records.values()].some(r => hash(pilotIdentity(r)) !== hash(pilotIdentity(planned))) || terminal && !sending && terminal.state !== "failed_terminal") return fail();
      const retained = terminal ?? sending ?? planned;
      // Old Pilot ciphertext never authenticated its random UUID directory. A
      // copied chain therefore retains one source identity, not another action.
      projectionSlot = hash(["DecadansNeurobro/own-pilot-source/v1", planned.idempotencyKey, planned.randomId]);
      let reply: PilotReply | undefined;
      if (dirs.dialogues && planned.replyToMessageId !== null) {
        try {
          if (!await guardRoot(dirs.dialogues)) gaps.push("text-join-missing");
          else {
            usedRoots.add(dirs.dialogues);
            const key = String(planned.replyToMessageId).padStart(10, "0");
            const dialogue = async (name: string, type: string, expectedKey: string) => {
              await guardRoot(dirs.dialogues); const e = fields(await session(join(dirs.dialogues, name), 1048576, 786432), ["version", "accountId", "peerId", "type", "key", "payload"]); await guardRoot(dirs.dialogues);
              if (e.version !== "standing-dialogue-journal-v1" || e.accountId !== binding.accountId || e.peerId !== binding.chatId || e.type !== type || e.key !== expectedKey) return fail(); return e.payload;
            };
            const marker = fields(await dialogue("journal.enc", "journal", "binding"), ["format"]); if (marker.format !== "immutable-source-events-v1") return fail();
            const q = fields(await dialogue(key + ".question.enc", "question", key), ["question", "recordedAt"]), question = fields(q.question, ["primary"], ["source", "context"]);
            const primary = fields(question.primary, ["chatId", "ownerId", "messageId", "text"]);
            if (!integer(q.recordedAt, 253402300799) || primary.chatId !== binding.chatId || primary.messageId !== planned.replyToMessageId || !long(primary.ownerId) || primary.ownerId === binding.accountId || !text(primary.text, 4096)) return fail();
            const o = fields(await dialogue(key + ".outcome.enc", "outcome", key), ["key", "delivery", "kind", "answer"], ["entities", "deliveryDiagnostic", "image"]);
            if (o.key !== key || !["verified", "unknown", "not-sent"].includes(o.delivery) || !["model", "deferred"].includes(o.kind) || !text(o.answer, 4096) || Object.hasOwn(o, "image") ||
                Object.hasOwn(o, "deliveryDiagnostic") && (o.delivery !== (o.deliveryDiagnostic === "pre-dispatch-refused" ? "not-sent" : "unknown") || !isPilotDeliveryDiagnostic(o.deliveryDiagnostic))) return fail();
            const entities = Object.hasOwn(o, "entities") ? copyTelegramTextEntities(o.answer, o.entities) : undefined;
            const joined: PilotReply = { chatId: binding.chatId, replyToMessageId: planned.replyToMessageId, text: o.answer, ...(entities === undefined ? {} : { entities }) };
            projectStandingOwnAction({ binding, referenceKey, slot: projectionSlot, source: { family, record: retained, reply: joined } }); reply = joined;
          }
        } catch (e) { if (closed || aborted()) throw e; gaps.push(missing(e) ? "text-join-missing" : "text-join-unavailable"); }
      } else gaps.push("text-join-missing");
      source = { family, record: retained, ...(reply ? { reply } : {}) };
    } else if (family === "bound-action") {
      if (!names.has("intent.enc")) return result(names.has("terminal.enc") ? "unavailable" : "incomplete", ["incomplete-records"]);
      if (!names.has("terminal.enc")) {
        const raw = fields(await session(join(path, "intent.enc")), ["domain", "key", "kind", "payload"]), p = fields(raw.payload, ["binding", "intent"]), i = fields(p.intent, ["requestRef", "randomId", "action"]);
        if (raw.domain !== "DecadansNeurobro/standing-action-journal/v1" || raw.key !== slot || raw.kind !== "intent" || standingActionKey(p.binding) !== slot ||
            p.binding.accountId !== binding.accountId || p.binding.chatId !== binding.chatId || !opaque(i.requestRef) || !long(i.randomId)) return fail();
        snapshotStandingActionJson(i.action); await guard(); return result("incomplete", ["incomplete-records"]);
      }
      const first = await session(join(path, "intent.enc")), last = await session(join(path, "terminal.enc"));
      const decoded = decodeStandingActionSlot(first, last, slot);
      if (decoded.binding.accountId !== binding.accountId || decoded.binding.chatId !== binding.chatId) return fail();
      source = { family, binding: decoded.binding as StandingActionBinding, intent: decoded.intent as StandingActionIntent, terminal: decoded.terminal as StandingActionTerminal };
    } else {
      const domain = family === "generated-image" ? "DecadansNeurobro/generated-image-outbox/v1" : "DecadansNeurobro/artifact-outbox/v1";
      if (!names.has("metadata.enc")) {
        // No attribution/view is possible without the bound plan. Still refuse
        // malformed existing small records instead of disguising them as legacy.
        let previous: any;
        for (const name of ["sending.enc", "terminal.enc"]) if (names.has(name)) {
          const r = fields(await envelope(name, domain, "delivery"), ["key", "planHash", "state"], family === "generated-image" ? ["messageId", "photoId", "diagnostics"] : ["acknowledgement", "failure"]);
          if (r.key !== slot || !hex(r.planHash) || (name === "sending.enc" ? r.state !== "sending" : !["verified", "unknown", "failed_terminal"].includes(r.state)) ||
              previous && r.planHash !== previous.planHash || name === "terminal.enc" && !previous && r.state !== "failed_terminal") return fail();
          previous = r;
        }
        await guard(); return result(names.size ? "legacy" : "incomplete", [names.size ? "compact-metadata-missing" : "incomplete-records"]);
      }
      if (!names.has("terminal.enc")) return result("incomplete", ["incomplete-records"]);
      const metadata = fields(await envelope("metadata.enc", domain, "metadata"), ["plan"]), plan = mediaPlan(metadata.plan, family === "generated-image");
      const terminal = await envelope("terminal.enc", domain, "delivery"), sending = names.has("sending.enc") ? await envelope("sending.enc", domain, "delivery") : undefined;
      if (!terminal || !["verified", "unknown", "failed_terminal"].includes(terminal.state) || !sending && terminal.state !== "failed_terminal") return fail();
      if (sending && (sending.state !== "sending" || sending.key !== terminal.key || sending.planHash !== terminal.planHash)) return fail();
      source = family === "generated-image" ? { family, plan: plan as ImageDeliveryPlan, terminal: terminal as ImageDeliveryRecord } : { family, plan: plan as ArtifactDeliveryPlan, terminal: terminal as ArtifactDeliveryRecord };
      // Both records independently pass the same exact plan/binding checks.
      if (sending) projectStandingOwnAction({ binding, referenceKey, slot, source: { ...source, terminal: sending } });
      gaps.push("local-material-not-inspected");
    }
    const view = projectStandingOwnAction({ binding, referenceKey, slot: projectionSlot, source });
    const finalListing = await opendir(path, { bufferSize: 1 }); let found = 0;
    try { for (;;) { check(); const entry = await finalListing.read(); if (!entry) break; if (++found > names.size || !names.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) return fail(); } }
    finally { await finalListing.close(); }
    if (found !== names.size) return fail(); await guard();
    return result(view.verdict === "incomplete" ? "incomplete" : "ready", gaps, view);
  }
  return Object.freeze({
    read(input: Readonly<{ family: StandingOwnActionFamily; slot: string }>): Promise<StandingOwnActionReadResult> {
      let family: StandingOwnActionFamily, slot: string;
      try { const r = fields(input, ["family", "slot"]); family = r.family; slot = r.slot;
        if (!["pilot", "generated-image", "artifact", "bound-action"].includes(family) || typeof slot !== "string" ||
            !(family === "pilot" ? /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(slot) : /^[0-9a-f]{64}$/.test(slot))) return Promise.reject(new StandingOwnActionReaderError("input"));
      } catch { return Promise.reject(new StandingOwnActionReaderError("input")); }
      if (closed || aborted()) return Promise.reject(new StandingOwnActionReaderError("closed"));
      if (active) return Promise.reject(new StandingOwnActionReaderError("busy"));
      active = work(family, slot).catch(error => { if (closed || aborted()) return fail("closed"); return result("unavailable", ["source-unavailable"]); }).finally(() => { active = undefined; });
      return active;
    }, close,
  });
}
