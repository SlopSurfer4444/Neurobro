import { validateStandingContent, type CompletedStandingResult, type StandingImage } from "./standing-model-result.js";

export type NativeTurnScope = Readonly<{
  epochId: string; requestRef: string; threadId: string; turnId: string; turnNumber: number;
}>;
/** A completed turn in a still-running, custody-approved epoch. None of these
 * fields assert process exit, resource cleanup, or Telegram delivery. */
export type StandingNativeTurnReceipt = NativeTurnScope & Readonly<{
  version: "standing-native-turn-v1"; outcome: "observed"; kind: "text" | "image";
  custodyReady: true; turnCompleted: true; toolsSettled: true; transportHealthy: true;
  answerBytes: number;
}>;
export type StandingNativeTurnResult = Readonly<{
  answer: string | null; receipt: StandingNativeTurnReceipt; image?: StandingImage;
}>;
export class NativeTurnRefused extends Error {
  constructor() { super("STANDING_NATIVE_TURN_REFUSED"); }
}
const fail = (): never => { throw new NativeTurnRefused(); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors,key) || !("value" in descriptors[key]!))) return fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value) && Buffer.from(value,"utf8").toString("utf8") === value;
}
const scopeKeys = ["epochId","requestRef","threadId","turnId","turnNumber"] as const;
function scope(value: NativeTurnScope): NativeTurnScope {
  const v = record(value,scopeKeys);
  if (typeof v.epochId !== "string" || !/^[a-f0-9]{32}$/.test(v.epochId) ||
      !id(v.requestRef) || !id(v.threadId) || !id(v.turnId) || !Number.isSafeInteger(v.turnNumber) ||
      (v.turnNumber as number) < 1 || (v.turnNumber as number) > 16) return fail();
  return Object.freeze(v) as NativeTurnScope;
}

/** One-use admission, created by the duplex owner AFTER binding the exact native
 * thread/turn acknowledgement to the already persisted selected request. The
 * isEpochActive check is owned by that controller, never by model output.
 * Any failure consumes this admission. It cannot be retried with repaired data.
 * A failure does not release image buffers: the transport owner must first join
 * any actual in-flight upload, then close the scoped image registry.
 *
 * This is not a process-settlement receipt and cannot authorize epoch recovery.
 * Unknown native completion has no deliverable result through this interface.
 */
export function createNativeTurnAdmission(input: {
  scope: NativeTurnScope; signal: AbortSignal; isEpochActive(): boolean;
}): Readonly<{ accept(value: unknown): CompletedStandingResult; revoke(): void }> {
  const expected = scope(input.scope), signal = input.signal, active = input.isEpochActive.bind(input);
  let consumed = false, revoked = false;
  const usable = () => { if (revoked || signal.aborted || active() !== true || revoked || signal.aborted) return fail(); };
  return Object.freeze({
    revoke() { consumed = true; revoked = true; },
    accept(value: unknown): CompletedStandingResult {
      if (consumed) return fail();
      consumed = true;
      usable();
      // Inspect the optional field without invoking untrusted accessors.
      const hasImage = value !== null && typeof value === "object" && Object.hasOwn(value,"image");
      const v = record(value,["answer","receipt",...(hasImage ? ["image"] : [])]);
      const r = record(v.receipt,[...scopeKeys,"version","outcome","kind","custodyReady","turnCompleted","toolsSettled","transportHealthy","answerBytes"]);
      if (scopeKeys.some(key => r[key] !== expected[key]) || r.version !== "standing-native-turn-v1" ||
          r.outcome !== "observed" || (r.kind !== "text" && r.kind !== "image") ||
          !["custodyReady","turnCompleted","toolsSettled","transportHealthy"].every(key => r[key] === true) ||
          !Number.isSafeInteger(r.answerBytes) || (r.answerBytes as number) < 0 || (r.answerBytes as number) > 4096 ||
          r.answerBytes !== (v.answer === null ? 0 : typeof v.answer === "string" ? Buffer.byteLength(v.answer,"utf8") : -1)) return fail();
      const completed = validateStandingContent({kind:r.kind,answer:v.answer,...(hasImage ? {image:v.image} : {})});
      if (completed.kind === "image") {
        const origin = completed.image.artifact.origin;
        if (origin.requestRef !== expected.requestRef || origin.threadId !== expected.threadId || origin.turnId !== expected.turnId) return fail();
      }
      usable();
      return completed;
    },
  });
}
