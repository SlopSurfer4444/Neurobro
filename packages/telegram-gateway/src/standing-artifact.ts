import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { types } from "node:util";

export const STANDING_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
export const STANDING_ARTIFACT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const STANDING_ARTIFACT_MAX_COUNT = 8;
export type StandingArtifactSource = Readonly<{ kind: "download" | "generated" | "attachment"; reference: string }>;
export type StandingArtifactAudio = Readonly<{ durationSeconds: number; title?: string; performer?: string }>;
export type StandingArtifact = Readonly<{
  version: "standing-artifact-v1"; ref: string; requestRef: string; source: StandingArtifactSource;
  filename: string; mimeType: string; byteLength: number; sha256: string; audio?: StandingArtifactAudio;
}>;
export type StandingArtifactInput = Readonly<{
  source: StandingArtifactSource; filename: string; mimeType: string; bytes: Buffer; audio?: StandingArtifactAudio;
}>;
export type StandingArtifactRegistry = Readonly<{
  accept(input: StandingArtifactInput): StandingArtifact;
  get(ref: string): StandingArtifact;
  copyBytes(ref: string): Buffer;
  close(): void;
}>;
type Refusal = "shape" | "binding" | "source" | "filename" | "mime" | "size" | "capacity" | "audio" | "closed" | "reference";
export class StandingArtifactError extends Error {
  constructor(readonly code: Refusal) { super("STANDING_ARTIFACT_" + code.toUpperCase()); this.name = "StandingArtifactError"; }
}
const refuse = (code: Refusal): never => { throw new StandingArtifactError(code); };
function record(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse("shape");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !allowed.includes(key)) ||
      Object.values(descriptors).some(d => !("value" in d)) || required.some(key => !Object.hasOwn(descriptors, key))) return refuse("shape");
  return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && Buffer.from(value, "utf8").toString("utf8") === value;
}
function opaque(value: unknown): value is string { return text(value, 256) && /^[A-Za-z0-9_-]+$/u.test(value); }
function sourceCopy(value: unknown): StandingArtifactSource {
  const data = record(value, ["kind", "reference"], ["kind", "reference"]);
  if (data.kind === "generated" || data.kind === "attachment") {
    if (!opaque(data.reference)) return refuse("source");
    return Object.freeze({ kind: data.kind, reference: data.reference });
  }
  if (data.kind !== "download" || !text(data.reference, 4096) || !/^https:\/\//iu.test(data.reference) ||
      /^[^:]+:\/\/[^/?#]*@/u.test(data.reference) || /[\s\\]/u.test(data.reference) || /%0[0-9a-f]|%1[0-9a-f]|%7f/iu.test(data.reference)) return refuse("source");
  let url: URL;
  try { url = new URL(data.reference); } catch { return refuse("source"); }
  const host = url.hostname.toLowerCase();
  // Provenance only: syntactically public DNS HTTPS. A downloader must separately
  // resolve/pin public addresses and validate every redirect; this grants no fetch.
  if (url.protocol !== "https:" || url.username || url.password || url.hash || data.reference.includes("#") ||
      url.port || isIP(host.replace(/^\[|\]$/gu, "")) || host.length > 253 ||
      !host.includes(".") || host.endsWith(".") || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/u.test(host)) return refuse("source");
  return Object.freeze({ kind: "download", reference: url.href });
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
function copyInput(value: unknown, available: number): Buffer {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Buffer.isBuffer(value)) return refuse("shape");
  const backing = bufferGetter.call(value) as ArrayBuffer;
  const offset = offsetGetter.call(value) as number;
  const length = lengthGetter.call(value) as number;
  if (types.isSharedArrayBuffer(backing) || resizableGetter?.call(backing)) return refuse("shape");
  if (length < 1 || length > STANDING_ARTIFACT_MAX_BYTES) return refuse("size");
  if (length > available) return refuse("capacity");
  // No caller-defined getters, iterator or Buffer methods run during the copy.
  return Buffer.from(new Uint8Array(backing, offset, length));
}

/** Layer III framing validation, not an MPEG decoder or an audibility claim.
 * Accepts bounded ID3v2.2/3/4 prefix and optional ID3v1 suffix; every intervening
 * byte must belong to a complete frame. Duration comes from frame sample counts.
 * Free-format frames, reserved headers, mixed sample rates/versions refuse. */
function mp3Duration(bytes: Buffer): number {
  let offset = 0, end = bytes.length;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") {
    if (end < 10 || ![2, 3, 4].includes(bytes[3]!) || bytes[4] === 255) return refuse("audio");
    const version = bytes[3]!, flags = bytes[5]!;
    if ((flags & (version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f)) !== 0) return refuse("audio");
    let size = 0;
    for (let i = 6; i < 10; i++) { if (bytes[i]! & 128) return refuse("audio"); size = size * 128 + bytes[i]!; }
    if (size > 1024 * 1024) return refuse("audio");
    offset = 10 + size;
    if (version === 4 && (flags & 0x10)) {
      if (offset + 10 > end || bytes.subarray(offset, offset + 3).toString("ascii") !== "3DI" ||
          !bytes.subarray(offset + 3, offset + 10).equals(bytes.subarray(3, 10))) return refuse("audio");
      offset += 10;
    }
    if (offset > end) return refuse("audio");
  }
  if (end - offset >= 128 && bytes.subarray(end - 128, end - 125).toString("ascii") === "TAG") end -= 128;
  let frames = 0, samples = 0, streamRate = 0, streamVersion = -1;
  while (offset < end) {
    if (end - offset < 4 || bytes[offset] !== 255 || (bytes[offset + 1]! & 0xe0) !== 0xe0) return refuse("audio");
    const b1 = bytes[offset + 1]!, b2 = bytes[offset + 2]!, b3 = bytes[offset + 3]!;
    const version = (b1 >> 3) & 3, layer = (b1 >> 1) & 3, bitrateIndex = b2 >> 4, rateIndex = (b2 >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || (b3 & 3) === 2) return refuse("audio");
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex]! * 1000;
    const rate = [44100,48000,32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + ((b2 >> 1) & 1);
    const sideInfo = version === 3 ? ((b3 >> 6) === 3 ? 17 : 32) : ((b3 >> 6) === 3 ? 9 : 17);
    if (length < 4 + ((b1 & 1) ? 0 : 2) + sideInfo || length > end - offset ||
        (frames && (streamRate !== rate || streamVersion !== version))) return refuse("audio");
    streamRate = rate; streamVersion = version; samples += version === 3 ? 1152 : 576; frames++; offset += length;
  }
  if (!frames) return refuse("audio");
  return samples / streamRate;
}
function audioCopy(value: unknown, mime: string, bytes: Buffer): StandingArtifactAudio {
  const data = record(value, ["durationSeconds", "title", "performer"], ["durationSeconds"]);
  if (mime !== "audio/mpeg" || typeof data.durationSeconds !== "number" || !Number.isFinite(data.durationSeconds) || data.durationSeconds < 0 ||
      (data.title !== undefined && (!text(data.title, 255) || Buffer.byteLength(data.title) > 255)) ||
      (data.performer !== undefined && (!text(data.performer, 255) || Buffer.byteLength(data.performer) > 255))) return refuse("audio");
  return Object.freeze({ durationSeconds: mp3Duration(bytes), ...(data.title === undefined ? {} : { title: data.title as string }),
    ...(data.performer === undefined ? {} : { performer: data.performer as string }) });
}

/** Ephemeral, request-scoped byte custody. Generic MIME is caller metadata, never
 * proof of a format. Supplying audio opts into the checked MP3 delivery profile.
 * No filesystem/network access, persistence, or Telegram delivery authority. */
export function createStandingArtifactRegistry(binding: { requestRef: string }): StandingArtifactRegistry {
  const scope = record(binding, ["requestRef"], ["requestRef"]);
  if (!text(scope.requestRef, 256) || /\s/u.test(scope.requestRef)) return refuse("binding");
  const requestRef = scope.requestRef;
  let closed = false, total = 0;
  const entries = new Map<string, { artifact: StandingArtifact; bytes: Buffer }>();
  const requireOpen = () => { if (closed) return refuse("closed"); };
  const lookup = (ref: string) => { requireOpen(); const entry = entries.get(ref); if (!entry) return refuse("reference"); return entry; };
  return Object.freeze({
    accept(input: StandingArtifactInput): StandingArtifact {
      requireOpen();
      const data = record(input, ["source", "filename", "mimeType", "bytes", "audio"], ["source", "filename", "mimeType", "bytes"]);
      const source = sourceCopy(data.source);
      if (!text(data.filename, 255) || Buffer.byteLength(data.filename) > 255 || /[\\/:*?"<>|]/u.test(data.filename) || data.filename.trim() !== data.filename ||
          data.filename.endsWith(".") || data.filename === "." || data.filename === ".." ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(data.filename)) return refuse("filename");
      if (!text(data.mimeType, 127) || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(data.mimeType)) return refuse("mime");
      let mimeType = data.mimeType.toLowerCase();
      if (entries.size >= STANDING_ARTIFACT_MAX_COUNT) return refuse("capacity");
      let bytes: Buffer | undefined = copyInput(data.bytes, STANDING_ARTIFACT_MAX_TOTAL_BYTES - total);
      try {
        // Public download endpoints often label every file as generic binary.
        // Only an explicit audio request plus complete MP3 frame validation
        // establishes audio/mpeg; extensions or the duration hint never do.
        const audioMime = mimeType === "application/octet-stream" ? "audio/mpeg" : mimeType;
        const audio = data.audio === undefined ? undefined : audioCopy(data.audio, audioMime, bytes);
        if (audio) mimeType = audioMime;
        const ref = "art_" + randomBytes(24).toString("hex");
        const artifact: StandingArtifact = Object.freeze({ version: "standing-artifact-v1", ref, requestRef, source,
          filename: data.filename, mimeType, byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"), ...(audio ? { audio } : {}) });
        // A hostile caller never runs between the initial open check and insertion.
        requireOpen(); entries.set(ref, { artifact, bytes }); total += bytes.length; bytes = undefined;
        return artifact;
      } finally { bytes?.fill(0); }
    },
    get(ref: string) { return lookup(ref).artifact; },
    copyBytes(ref: string) { return Buffer.from(lookup(ref).bytes); },
    close() { closed = true; for (const entry of entries.values()) entry.bytes.fill(0); entries.clear(); total = 0; },
  });
}

/** Revalidates a persisted descriptor against its bytes; grants no registry
 * membership or delivery authority. The returned descriptor owns no byte buffer. */
export function validateStandingArtifact(input: StandingArtifact, bytes: Buffer): StandingArtifact {
  const data = record(input, ["version", "ref", "requestRef", "source", "filename", "mimeType", "byteLength", "sha256", "audio"],
    ["version", "ref", "requestRef", "source", "filename", "mimeType", "byteLength", "sha256"]);
  if (data.version !== "standing-artifact-v1" || typeof data.ref !== "string" || !/^art_[0-9a-f]{48}$/u.test(data.ref) ||
      typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(data.sha256)) return refuse("shape");
  const registry = createStandingArtifactRegistry({ requestRef: data.requestRef as string });
  try {
    // Snapshot nested descriptors once; repeated reads of input cannot change validation.
    const source = sourceCopy(data.source);
    const audioData = data.audio === undefined ? undefined : record(data.audio, ["durationSeconds", "title", "performer"], ["durationSeconds"]);
    const artifact = registry.accept({ source, filename: data.filename as string, mimeType: data.mimeType as string, bytes,
      ...(audioData === undefined ? {} : { audio: audioData as StandingArtifactAudio }) });
    if (artifact.byteLength !== data.byteLength || artifact.sha256 !== data.sha256 ||
        (audioData !== undefined && artifact.mimeType !== data.mimeType) ||
        (audioData !== undefined && audioData.durationSeconds !== artifact.audio!.durationSeconds)) return refuse("binding");
    return Object.freeze({ ...artifact, ref: data.ref });
  } finally { registry.close(); }
}
