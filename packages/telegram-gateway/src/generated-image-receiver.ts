import { createHash } from "node:crypto";
import { createGeneratedImageRegistry, GENERATED_IMAGE_MAX_BYTES, type GeneratedImageArtifact,
  type GeneratedImageOrigin, type GeneratedImageScope } from "./generated-image-artifact.js";

export const GENERATED_IMAGE_CHUNK_BYTES = 384 * 1024;
export const GENERATED_IMAGE_FRAME_BYTES = 768 * 1024;
export type GeneratedImageReceiver = Readonly<{
  accept(frame: unknown): GeneratedImageArtifact | undefined;
  artifact(): GeneratedImageArtifact;
  get(localRef: string): GeneratedImageArtifact;
  copyBytes(localRef: string): Buffer;
  close(): void;
}>;
type Code = "shape" | "binding" | "order" | "bounds" | "base64" | "integrity" | "not-ready" | "closed";
export class GeneratedImageReceiverError extends Error {
  constructor(readonly code: Code) { super("GENERATED_IMAGE_RECEIVER_" + code.toUpperCase()); }
}
const refuse = (code: Code): never => { throw new GeneratedImageReceiverError(code); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse("shape");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(k => typeof k !== "string" || !keys.includes(k)) ||
      keys.some(k => !Object.hasOwn(descriptors, k) || !("value" in descriptors[k]!))) return refuse("shape");
  return Object.fromEntries(keys.map(k => [k, descriptors[k]!.value]));
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value) && Buffer.from(value).toString() === value;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
type Begin = { ref: string; origin: GeneratedImageOrigin; byteLength: number; sha256: string; width: number; height: number };

/** Private, already decoded frame receiver. The outer decoder must bound bytes
 * before JSON parsing. This checks a canonical projection of every frame too.
 * Any malformed stream revokes the owned registry. Returned refs are locally
 * generated, never aliases for Python's transport ref. Caller closes on abort,
 * truncated EOF or lifecycle refusal, and clears any caller-owned byte copies. */
export function createGeneratedImageReceiver(binding: GeneratedImageScope): GeneratedImageReceiver {
  const selected = record(binding, ["requestRef", "threadId", "turnId"]);
  if (!id(selected.requestRef) || !id(selected.threadId) || !id(selected.turnId)) return refuse("binding");
  const scope = Object.freeze({ requestRef: selected.requestRef, threadId: selected.threadId, turnId: selected.turnId });
  const registry = createGeneratedImageRegistry(scope);
  let state: "empty" | "receiving" | "complete" | "closed" = "empty";
  let begin: Begin | undefined;
  let chunks: Buffer[] = [];
  let total = 0;
  let result: GeneratedImageArtifact | undefined;
  const clearChunks = () => { for (const chunk of chunks) chunk.fill(0); chunks = []; total = 0; };
  const close = () => { clearChunks(); registry.close(); begin = undefined; result = undefined; state = "closed"; };
  const ready = () => { if (state === "closed") return refuse("closed"); if (state !== "complete" || !result) return refuse("not-ready"); return result; };
  const bounded = (frame: unknown) => { if (Buffer.byteLength(JSON.stringify(frame), "utf8") > GENERATED_IMAGE_FRAME_BYTES) refuse("bounds"); };
  return Object.freeze({
    accept(input: unknown): GeneratedImageArtifact | undefined {
      if (state === "closed") return refuse("closed");
      let decoded: Buffer | undefined;
      let joined: Buffer | undefined;
      try {
        // Read the discriminant without invoking a getter or accepting symbols.
        if (!input || typeof input !== "object") return refuse("shape");
        const discriminator = Object.getOwnPropertyDescriptor(input, "kind");
        if (!discriminator || !("value" in discriminator)) return refuse("shape");
        if (discriminator.value === "imageBegin") {
          if (state !== "empty") return refuse("order");
          const frame = record(input, ["kind", "artifact"]);
          const value = record(frame.artifact, ["schema", "ref", "origin", "mimeType", "byteLength", "sha256", "width", "height"]);
          const origin = record(value.origin, ["requestRef", "threadId", "turnId", "itemId"]);
          if (!id(origin.itemId) || origin.requestRef !== scope.requestRef || origin.threadId !== scope.threadId || origin.turnId !== scope.turnId) return refuse("binding");
          if (value.schema !== "neurobro-generated-image-artifact-v1" || value.mimeType !== "image/png" ||
              typeof value.ref !== "string" || !/^img_[0-9a-f]{48}$/.test(value.ref) ||
              typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return refuse("shape");
          if (!integer(value.byteLength, 57, GENERATED_IMAGE_MAX_BYTES) || !integer(value.width, 1, 8192) ||
              !integer(value.height, 1, 8192) || value.width * value.height > 16 * 1024 * 1024) return refuse("bounds");
          const copiedOrigin = Object.freeze({ ...scope, itemId: origin.itemId });
          bounded({ kind: "imageBegin", artifact: { ...value, origin: copiedOrigin } });
          begin = { ref: value.ref, origin: copiedOrigin, byteLength: value.byteLength, sha256: value.sha256, width: value.width, height: value.height };
          state = "receiving";
          return undefined;
        }
        if (state !== "receiving" || !begin) return refuse("order");
        if (discriminator.value === "imageChunk") {
          const frame = record(input, ["kind", "artifactRef", "sequence", "dataBase64"]);
          if (frame.artifactRef !== begin.ref) return refuse("binding");
          if (frame.sequence !== chunks.length) return refuse("order");
          const value = frame.dataBase64;
          if (typeof value !== "string" || !value.length || value.length % 4 !== 0) return refuse("base64");
          if (value.length > 4 * Math.ceil(GENERATED_IMAGE_CHUNK_BYTES / 3)) return refuse("bounds");
          bounded(frame);
          decoded = Buffer.from(value, "base64");
          if (decoded.toString("base64") !== value) return refuse("base64");
          // Collector uses full chunks except for the final remainder. This also
          // bounds observation count to ceil(8 MiB / 384 KiB), not millions.
          if (decoded.length !== Math.min(GENERATED_IMAGE_CHUNK_BYTES, begin.byteLength - total) || !decoded.length) return refuse("bounds");
          total += decoded.length;
          chunks.push(decoded); decoded = undefined;
          return undefined;
        }
        if (discriminator.value !== "imageEnd") return refuse("shape");
        const frame = record(input, ["kind", "artifactRef", "chunkCount", "byteLength", "sha256"]);
        if (frame.artifactRef !== begin.ref) return refuse("binding");
        if (frame.chunkCount !== chunks.length || !chunks.length || total !== begin.byteLength || frame.byteLength !== begin.byteLength || frame.sha256 !== begin.sha256) return refuse("integrity");
        bounded(frame);
        joined = Buffer.concat(chunks, total);
        if (createHash("sha256").update(joined).digest("hex") !== begin.sha256) return refuse("integrity");
        const validated = registry.acceptCompleted(begin.origin, { id: begin.origin.itemId, type: "imageGeneration", status: "completed", result: joined.toString("base64") });
        if (validated.byteLength !== begin.byteLength || validated.sha256 !== begin.sha256 || validated.width !== begin.width || validated.height !== begin.height) return refuse("integrity");
        result = validated;
        clearChunks(); state = "complete";
        return validated;
      } catch (error) {
        close();
        // Registry errors already use fixed codes and never embed payloads.
        throw error;
      } finally { decoded?.fill(0); joined?.fill(0); }
    },
    artifact: ready,
    get(localRef: string) { ready(); return registry.get(localRef); },
    copyBytes(localRef: string) { ready(); return registry.copyBytes(localRef); },
    close,
  });
}
