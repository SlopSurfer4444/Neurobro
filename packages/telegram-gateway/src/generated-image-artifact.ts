import { createHash, randomBytes } from "node:crypto";

export const GENERATED_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const GENERATED_IMAGE_MAX_DIMENSION = 8192;
export const GENERATED_IMAGE_MAX_PIXELS = 16 * 1024 * 1024;
const MAX_BASE64 = 4 * Math.ceil(GENERATED_IMAGE_MAX_BYTES / 3);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type GeneratedImageScope = Readonly<{ requestRef: string; threadId: string; turnId: string }>;
export type GeneratedImageOrigin = Readonly<GeneratedImageScope & { itemId: string }>;
export type GeneratedImageArtifact = Readonly<{
  version: "generated-image-v1";
  ref: string;
  origin: GeneratedImageOrigin;
  mimeType: "image/png";
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
}>;
export type GeneratedImageRegistry = Readonly<{
  acceptCompleted(origin: GeneratedImageOrigin, item: unknown): GeneratedImageArtifact;
  get(ref: string): GeneratedImageArtifact;
  copyBytes(ref: string): Buffer;
  close(): void;
}>;

type Refusal = "shape" | "binding" | "not-completed" | "base64" | "size" | "png" | "capacity" | "conflict" | "closed" | "reference";
export class GeneratedImageArtifactError extends Error {
  constructor(readonly code: Refusal) { super("GENERATED_IMAGE_" + code.toUpperCase()); this.name = "GeneratedImageArtifactError"; }
}
const refuse = (code: Refusal): never => { throw new GeneratedImageArtifactError(code); };

/** Data properties only. Do not invoke getters on a provider/caller object. */
function record(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return refuse("shape");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key)) ||
      Object.values(descriptors).some(descriptor => !("value" in descriptor)) ||
      required.some(key => !Object.hasOwn(descriptors, key))) return refuse("shape");
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value) &&
    Buffer.from(value, "utf8").toString("utf8") === value;
}
function scopeCopy(value: GeneratedImageScope): GeneratedImageScope {
  const data = record(value, ["requestRef", "threadId", "turnId"], ["requestRef", "threadId", "turnId"]);
  if (!identifier(data.requestRef) || !identifier(data.threadId) || !identifier(data.turnId)) return refuse("binding");
  return Object.freeze({ requestRef: data.requestRef, threadId: data.threadId, turnId: data.turnId });
}
function originCopy(value: GeneratedImageOrigin): GeneratedImageOrigin {
  const data = record(value, ["requestRef", "threadId", "turnId", "itemId"], ["requestRef", "threadId", "turnId", "itemId"]);
  if (!identifier(data.itemId)) return refuse("binding");
  const scope = scopeCopy({ requestRef: data.requestRef as string, threadId: data.threadId as string, turnId: data.turnId as string });
  return Object.freeze({ ...scope, itemId: data.itemId });
}

/** Base64 is a payload, never a URL or filesystem path. Check encoded size before decoding. */
function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string") return refuse("base64");
  if (value.length > MAX_BASE64) return refuse("size");
  if (!value.length || value.length % 4 !== 0) return refuse("base64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length / 4 * 3 - padding > GENERATED_IMAGE_MAX_BYTES) return refuse("size");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) { bytes.fill(0); return refuse("base64"); }
  return bytes;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validates the PNG container, CRCs and bounded IHDR. This does not inflate IDAT
 * or certify decoded pixels; no claim of image rendering/visual validation. */
function inspectPng(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return refuse("png");
  let offset = 8, count = 0, width = 0, height = 0, color = -1, depth = 0;
  let palette = false, sawData = false, endedData = false, dataBytes = 0;
  while (offset < bytes.length) {
    if (++count > 4096 || bytes.length - offset < 12) return refuse("png");
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return refuse("png");
    const end = offset + 12 + length;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    for (let index = offset + 4; index < offset + 8; index++) {
      const ch = bytes[index]!;
      if (!((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122))) return refuse("png");
    }
    if ((bytes[offset + 6]! & 0x20) !== 0 || crc32(bytes, offset + 4, end - 4) !== bytes.readUInt32BE(end - 4)) return refuse("png");
    if (count === 1 && type !== "IHDR") return refuse("png");
    if (type === "IHDR") {
      if (count !== 1 || length !== 13) return refuse("png");
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      depth = bytes[offset + 16]!; color = bytes[offset + 17]!;
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > GENERATED_IMAGE_MAX_DIMENSION || height > GENERATED_IMAGE_MAX_DIMENSION ||
          width * height > GENERATED_IMAGE_MAX_PIXELS || !depths[color]?.includes(depth) ||
          bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || ![0, 1].includes(bytes[offset + 20]!)) return refuse("png");
    } else if (type === "PLTE") {
      if (palette || sawData || [0, 4].includes(color) || !length || length > 768 || length % 3 !== 0 || (color === 3 && length / 3 > 2 ** depth)) return refuse("png");
      palette = true;
    } else if (type === "IDAT") {
      if (endedData || (color === 3 && !palette)) return refuse("png");
      sawData = true; dataBytes += length;
    } else if (type === "IEND") {
      if (length !== 0 || !sawData || dataBytes === 0 || end !== bytes.length) return refuse("png");
      return { width, height };
    } else {
      if ((bytes[offset + 4]! & 0x20) === 0 || ["acTL", "fcTL", "fdAT"].includes(type)) return refuse("png");
    }
    if (sawData && type !== "IDAT") endedData = true;
    offset = end;
  }
  return refuse("png");
}

/** One selected request + native turn, one generated image. Caller supplies the
 * trusted origin from its correlated native lifecycle (not from model prose).
 * The registry is ephemeral, not an outbox, durable store, or send authority.
 * Persist artifact bytes/binding before delivery; retain UNKNOWN sends elsewhere.
 * Unrelated or malformed event envelopes/statuses refuse without revocation.
 * Once a correlated completed body is admitted for inspection, a conflicting or
 * malformed later body revokes this registry. No old opaque ref can change bytes.
 * savedPath is inert metadata: no filesystem access or URL fetching occurs here. */
export function createGeneratedImageRegistry(binding: GeneratedImageScope): GeneratedImageRegistry {
  const scope = scopeCopy(binding);
  let closed = false;
  let artifact: GeneratedImageArtifact | undefined;
  let retained: Buffer | undefined;
  const requireOpen = () => { if (closed) return refuse("closed"); };
  const close = () => { closed = true; retained?.fill(0); retained = undefined; artifact = undefined; };
  const lookup = (ref: string) => { requireOpen(); if (!artifact || ref !== artifact.ref) return refuse("reference"); return artifact; };
  return Object.freeze({
    acceptCompleted(originInput: GeneratedImageOrigin, itemInput: unknown): GeneratedImageArtifact {
      requireOpen();
      const origin = originCopy(originInput);
      if (origin.requestRef !== scope.requestRef || origin.threadId !== scope.threadId || origin.turnId !== scope.turnId) return refuse("binding");
      const item = record(itemInput, ["id", "type", "status", "result", "failure", "savedPath", "revisedPrompt", "transparentBackground"], ["id", "type", "status", "result"]);
      if (item.id !== origin.itemId || item.type !== "imageGeneration") return refuse("binding");
      if (item.status !== "completed" || (item.failure !== undefined && item.failure !== null)) return refuse("not-completed");
      if ((item.savedPath !== undefined && item.savedPath !== null && typeof item.savedPath !== "string") ||
          (item.revisedPrompt !== undefined && item.revisedPrompt !== null && typeof item.revisedPrompt !== "string") ||
          (item.transparentBackground !== undefined && item.transparentBackground !== null && typeof item.transparentBackground !== "boolean")) return refuse("shape");
      if (artifact && artifact.origin.itemId !== origin.itemId) return refuse("capacity");
      let bytes: Buffer | undefined;
      try {
        bytes = decodeBase64(item.result);
        const dimensions = inspectPng(bytes);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (artifact) {
          if (digest !== artifact.sha256 || !retained!.equals(bytes)) { close(); return refuse("conflict"); }
          return artifact;
        }
        artifact = Object.freeze({ version: "generated-image-v1", ref: "img_" + randomBytes(24).toString("hex"), origin,
          mimeType: "image/png", byteLength: bytes.length, sha256: digest, ...dimensions });
        retained = bytes; bytes = undefined;
        return artifact;
      } catch (error) {
        // An accepted origin cannot acquire a malformed or different later body.
        if (artifact) close();
        throw error;
      } finally { bytes?.fill(0); }
    },
    get: lookup,
    copyBytes(ref: string) { lookup(ref); return Buffer.from(retained!); },
    close,
  });
}
