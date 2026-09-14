import { completedModelAnswer, type ConversationModelResult } from "./pilot-conversation.js";
import type { GeneratedImageArtifact, GeneratedImageRegistry } from "./generated-image-artifact.js";

export type StandingImage = Readonly<{ artifact: GeneratedImageArtifact; registry: Pick<GeneratedImageRegistry, "get" | "copyBytes">; close(): void }>;
export type StandingNativeReceipt = Readonly<{
  version: "standing-native-host-v1"; outcome: "observed" | "unknown"; kind: "text" | "image" | "none";
  exitCode: number | null; transportError: boolean; timedOut: boolean; aborted: boolean; overflow: boolean;
  guestSettled: boolean; clientSettled: boolean; relaySettled: boolean; custodyReady: boolean; appServerSettled: boolean; turnCompleted: boolean; answerBytes: number;
}>;
export type StandingNativeModelResult = Readonly<{ answer: string | null; receipt: StandingNativeReceipt; image?: StandingImage }>;
export type StandingModelResult = ConversationModelResult | StandingNativeModelResult;
export type StandingModel = (text: string, signal: AbortSignal) => Promise<StandingModelResult>;
export type CompletedStandingResult = Readonly<{ kind: "none"; answer: null } | { kind: "text"; answer: string } | { kind: "image"; answer: string | null; image: StandingImage }>;
const fail = (): never => { throw new Error("STANDING_MODEL_RESULT_REFUSED"); };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every(key => typeof key === "string" && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)); }
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && !!value.trim() && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximum && Buffer.from(value, "utf8").toString("utf8") === value;
}
function captionPrefix(value: string | null): string | null {
  if (value === null) return null;
  let answer = "", bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character,"utf8");
    if (bytes + size > 1024) break;
    answer += character; bytes += size;
  }
  return answer;
}
/** Legacy modeltext receipt behavior remains unchanged. Native receipts have an
 * exact schema; an incomplete resource verdict must never become a text fallback.
 * Image bytes remain in the scoped registry and are fully revalidated by outbox. */
export function completedStandingResult(value: unknown): CompletedStandingResult {
  if (!record(value)) return fail();
  const r = value.receipt;
  if (record(r) && r.version === "standing-native-turn-v1") return fail();
  if (!record(r) || r.version !== "standing-native-host-v1") {
    if (Object.hasOwn(value, "image")) return fail();
    const answer = completedModelAnswer(value as unknown as ConversationModelResult);
    return answer === null ? Object.freeze({ kind: "none", answer: null }) : Object.freeze({ kind: "text", answer });
  }
  if (!exact(value, ["answer", "receipt", ...(Object.hasOwn(value,"image") ? ["image"] : [])]) ||
      !exact(r, ["version","outcome","kind","exitCode","transportError","timedOut","aborted","overflow","guestSettled","clientSettled","relaySettled","custodyReady","appServerSettled","turnCompleted","answerBytes"]) ||
      r.version !== "standing-native-host-v1" || (r.outcome !== "observed" && r.outcome !== "unknown") || (r.kind !== "text" && r.kind !== "image" && r.kind !== "none") ||
      !(r.exitCode === null || Number.isSafeInteger(r.exitCode) && (r.exitCode as number) >= -255 && (r.exitCode as number) <= 255) ||
      !Number.isSafeInteger(r.answerBytes) || (r.answerBytes as number) < 0 || (r.answerBytes as number) > 4096) return fail();
  for (const key of ["transportError","timedOut","aborted","overflow","guestSettled","clientSettled","relaySettled","custodyReady","appServerSettled","turnCompleted"]) if (typeof r[key] !== "boolean") return fail();
  if (!["guestSettled","clientSettled","relaySettled","appServerSettled"].every(k=>r[k] === true)) return fail();
  if (r.outcome === "unknown") {
    if (Object.hasOwn(value,"image") || r.kind !== "none" || value.answer !== null || r.answerBytes !== 0) return fail();
    return Object.freeze({ kind: "none", answer: null });
  }
  if (r.exitCode !== 0 || !["transportError","timedOut","aborted","overflow"].every(k=>r[k] === false) || r.custodyReady !== true || r.turnCompleted !== true ||
      r.answerBytes !== (value.answer === null ? 0 : typeof value.answer === "string" ? Buffer.byteLength(value.answer,"utf8") : -1)) return fail();
  return validateStandingContent({ kind:r.kind, answer:value.answer, ...(Object.hasOwn(value,"image") ? {image:value.image} : {}) });
}
/** Content integrity only, not permission to deliver. Both process-complete and
 * warm-turn owners must validate their own receipt before calling this function.
 * Keeping that proof separate avoids inventing process exits for a warm turn. */
export function validateStandingContent(value: unknown): CompletedStandingResult {
  if (!record(value) || !exact(value,["kind","answer",...(Object.hasOwn(value,"image") ? ["image"] : [])])) return fail();
  if (value.kind === "text") {
    if (Object.hasOwn(value,"image") || !text(value.answer,4096)) return fail();
    return Object.freeze({ kind: "text", answer: value.answer });
  }
  const image = value.image;
  if (value.kind !== "image" || !record(image) || !exact(image,["artifact","registry","close"]) || typeof image.close !== "function" ||
      !record(image.registry) || typeof image.registry.get !== "function" || typeof image.registry.copyBytes !== "function" || !record(image.artifact) ||
      !exact(image.artifact,["version","ref","origin","mimeType","byteLength","sha256","width","height"]) ||
      !(value.answer === null || text(value.answer,4096))) return fail();
  const artifact = image.artifact;
  if (artifact.version !== "generated-image-v1" || artifact.mimeType !== "image/png" || typeof artifact.ref !== "string" || !/^img_[0-9a-f]{48}$/.test(artifact.ref) ||
      typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256) || !record(artifact.origin) || !exact(artifact.origin,["requestRef","threadId","turnId","itemId"]) ||
      !Object.values(artifact.origin).every(v=>typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(v) && Buffer.from(v,"utf8").toString("utf8") === v) ||
      !Number.isSafeInteger(artifact.byteLength) || (artifact.byteLength as number) < 1 || (artifact.byteLength as number) > 8*1024*1024 ||
      !Number.isSafeInteger(artifact.width) || !Number.isSafeInteger(artifact.height) || (artifact.width as number) < 1 || (artifact.height as number) < 1 ||
      (artifact.width as number) > 8192 || (artifact.height as number) > 8192 || (artifact.width as number)*(artifact.height as number) > 16*1024*1024) return fail();
  // Capture validated values and capability methods before invoking a registry
  // port. Neither a reentrant lookup nor caller mutation may replace the image
  // that this result admits. The shared byte registry itself remains scoped.
  const admittedArtifact: Readonly<Record<string, unknown> & {origin:Readonly<Record<string,unknown>>}> = Object.freeze({...artifact,origin:Object.freeze({...artifact.origin})});
  const answer = value.answer as string | null;
  const get = image.registry.get.bind(image.registry), copyBytes = image.registry.copyBytes.bind(image.registry), close = image.close.bind(image);
  const stored = get(admittedArtifact.ref);
  if (!record(stored) || !exact(stored,Object.keys(admittedArtifact)) || !record(stored.origin) || !exact(stored.origin,Object.keys(admittedArtifact.origin)) ||
      Object.keys(admittedArtifact).some(k=>k !== "origin" && stored[k] !== admittedArtifact[k])) return fail();
  const storedOrigin = stored.origin, origin = admittedArtifact.origin;
  if (Object.keys(origin).some(k=>storedOrigin[k] !== origin[k])) return fail();
  // Receipt proof covers the complete native answer. Telegram's existing caption
  // bound is a separate projection, truncated only at Unicode codepoint edges.
  const admittedImage = Object.freeze({artifact:admittedArtifact,registry:Object.freeze({get,copyBytes}),close}) as unknown as StandingImage;
  return Object.freeze({ kind: "image", answer: captionPrefix(answer), image:admittedImage });
}
/** Resource cleanup even if receipt validation fails; never evaluate accessors. */
export function closeStandingImage(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return;
  const image = Object.getOwnPropertyDescriptor(value,"image")?.value as unknown;
  if (image === null || typeof image !== "object" || Object.getPrototypeOf(image) !== Object.prototype) return;
  const close = Object.getOwnPropertyDescriptor(image,"close")?.value as unknown;
  if (typeof close === "function") close.call(image);
}
