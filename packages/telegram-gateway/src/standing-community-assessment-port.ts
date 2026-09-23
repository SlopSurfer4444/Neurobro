import { types } from "node:util";
import type { CompletedCommunityAssessmentTurn } from "./standing-scoped-epoch-session.js";
import { parseStandingCommunityAssessmentInput, parseStandingCommunityAssessmentDecision,
  type StandingCommunityAssessmentDecision, type StandingCommunityAssessmentInput } from "./standing-community-assessment-contract.js";

export type StandingCommunityAssessmentNativeBinding = Readonly<{ epochId: string; requestRef: string; purpose: "community-assessment" }>;
export type StandingCommunityAssessmentSettlement = Readonly<{
  schema: "standing-community-assessment-owner-settlement-v1"; nativeBinding: StandingCommunityAssessmentNativeBinding;
  resourcesSettled: true; persisted: true; replacementReady: true; modelOutcome: "not-proven";
}>;
export type StandingCommunityAssessmentLease = Readonly<{
  nativeBinding: StandingCommunityAssessmentNativeBinding;
  turnCommunityAssessment(ref: string, body: string): Promise<CompletedCommunityAssessmentTurn>;
  releaseCommunityAssessment(ref: string): Promise<void>;
  abortAndJoin(): Promise<StandingCommunityAssessmentSettlement | void>;
  close(): Promise<void>;
}>;
/** Borrowed native connection. The port never closes the connection itself or
 * changes its three-purpose routing, tools, provider or process ownership. */
export type StandingCommunityAssessmentConnection = Readonly<{
  prepare(): Promise<Readonly<{ restoration: boolean }>>;
  acquireCommunityAssessmentAdmission(ref: string): Promise<StandingCommunityAssessmentLease>;
  verifyCommunityAssessmentSettlement(binding: StandingCommunityAssessmentNativeBinding): Promise<StandingCommunityAssessmentSettlement>;
}>;
export type StandingCommunityAssessmentPort = Readonly<{
  assess(ref: string, body: string, signal: AbortSignal): Promise<StandingCommunityAssessmentDecision>;
  close(): Promise<void>;
}>;
export class StandingCommunityAssessmentPortError extends Error {
  constructor(readonly code: "INPUT" | "BUSY" | "CLOSED" | "CANCELLED" | "FAILED" | "COMMUNITY_ASSESSMENT_TIMEOUT" | "SETTLEMENT_UNKNOWN") {
    super("STANDING_COMMUNITY_ASSESSMENT_PORT_" + code);
  }
}
type Code = StandingCommunityAssessmentPortError["code"];
const fail = (code: Code): never => { throw new StandingCommunityAssessmentPortError(code); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("INPUT");
  const fields = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(fields);
  if (names.length !== keys.length || keys.some(key => !Object.hasOwn(fields, key)) ||
      Object.values(fields).some(field => !("value" in field) || !field.enumerable)) return fail("INPUT");
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value]));
}
function method<T>(value: unknown, name: string): T {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail("INPUT");
  const field = Object.getOwnPropertyDescriptor(value, name);
  if (!field || !("value" in field) || typeof field.value !== "function" || types.isProxy(field.value)) return fail("INPUT");
  return field.value.bind(value) as T;
}
function optionalMethod<T>(value: unknown, name: string): T | undefined {
  try { return method<T>(value, name); } catch { return undefined; }
}
function signalCopy(value: unknown): AbortSignal {
  if (types.isProxy(value) || !(value instanceof AbortSignal)) return fail("INPUT"); return value;
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
function bindingCopy(value: unknown, ref: string): StandingCommunityAssessmentNativeBinding {
  const b = record(value, ["epochId", "requestRef", "purpose"]);
  if (typeof b.epochId !== "string" || !/^[0-9a-f]{32}$/u.test(b.epochId) || b.requestRef !== ref || b.purpose !== "community-assessment") return fail("INPUT");
  return Object.freeze(b) as StandingCommunityAssessmentNativeBinding;
}
function settlement(value: unknown, expected: StandingCommunityAssessmentNativeBinding): void {
  const s = record(value, ["schema", "nativeBinding", "resourcesSettled", "persisted", "replacementReady", "modelOutcome"]);
  const b = bindingCopy(s.nativeBinding, expected.requestRef);
  if (s.schema !== "standing-community-assessment-owner-settlement-v1" || b.epochId !== expected.epochId ||
      s.resourcesSettled !== true || s.persisted !== true || s.replacementReady !== true || s.modelOutcome !== "not-proven") return fail("SETTLEMENT_UNKNOWN");
}
function safeCode(error: unknown): Code {
  if (error && typeof error === "object" && !types.isProxy(error)) {
    const field = Object.getOwnPropertyDescriptor(error, "code");
    if (field && "value" in field && ["SETTLEMENT_UNKNOWN", "COMMUNITY_ASSESSMENT_TIMEOUT"].includes(field.value)) return field.value as Code;
    if (error instanceof StandingCommunityAssessmentPortError && field && "value" in field) return field.value as Code;
  }
  return "FAILED";
}
function decisionCopy(value: unknown, expected: StandingCommunityAssessmentNativeBinding, input: StandingCommunityAssessmentInput): StandingCommunityAssessmentDecision {
  const turn = record(value, ["kind", "scope", "decision", "toolCalls", "toolRefusals"]);
  const scope = record(turn.scope, ["epochId", "purpose", "requestRef", "threadId", "turnId", "turnNumber", "threadTurnNumber"]);
  if (turn.kind !== "community-assessment" || turn.toolCalls !== 0 || turn.toolRefusals !== 0 || scope.purpose !== expected.purpose ||
      scope.epochId !== expected.epochId || scope.requestRef !== expected.requestRef || !identifier(scope.threadId) || !identifier(scope.turnId) ||
      !Number.isSafeInteger(scope.turnNumber) || Number(scope.turnNumber) < 1 || Number(scope.turnNumber) > 16 ||
      !Number.isSafeInteger(scope.threadTurnNumber) || Number(scope.threadTurnNumber) < 1 || Number(scope.threadTurnNumber) > Number(scope.turnNumber)) return fail("FAILED");
  // Snapshot primitives before serialization; never invoke a provider-owned
  // toJSON/accessor. The shared contract alone owns decision/source validation.
  const decision = record(turn.decision, ["decision", "caseKey", "answer"]);
  if (Object.values(decision).some(v => v !== null && typeof v !== "string")) return fail("FAILED");
  return parseStandingCommunityAssessmentDecision(JSON.stringify(decision), input);
}

/** One host-selected assessment at a time. Success releases the scoped turn and
 * its lease, retaining the warm epoch. Cancellation actively aborts the native
 * owner and returns only after joined settlement; unknown settlement is fatal.
 * No delivery, observation checkpoint, policy authority or replay is granted. */
export function createStandingCommunityAssessmentPort(connection: StandingCommunityAssessmentConnection, value: AbortSignal): StandingCommunityAssessmentPort {
  const signal = signalCopy(value), stop = new AbortController();
  const prepare = method<StandingCommunityAssessmentConnection["prepare"]>(connection, "prepare");
  const acquire = method<StandingCommunityAssessmentConnection["acquireCommunityAssessmentAdmission"]>(connection, "acquireCommunityAssessmentAdmission");
  const verify = method<StandingCommunityAssessmentConnection["verifyCommunityAssessmentSettlement"]>(connection, "verifyCommunityAssessmentSettlement");
  let closed = false, poisoned = false, active: Promise<StandingCommunityAssessmentDecision> | undefined, closing: Promise<void> | undefined;
  const stopped = () => { stop.abort(); };
  signal.addEventListener("abort", stopped, { once: true });
  if (signal.aborted) stop.abort();
  async function assess(ref: string, body: string, callSignal: AbortSignal, input: StandingCommunityAssessmentInput): Promise<StandingCommunityAssessmentDecision> {
    const joinedSignal = AbortSignal.any([signal, stop.signal, callSignal]);
    let rawLease: unknown, admitted = false, binding: StandingCommunityAssessmentNativeBinding | undefined;
    let abortLease: StandingCommunityAssessmentLease["abortAndJoin"] | undefined, closeLease: StandingCommunityAssessmentLease["close"] | undefined;
    let joining: Promise<void> | undefined, leaseClosing: Promise<void> | undefined, released = false, closingReleased = false, leaseClosed = false;
    const guard = () => { if (joinedSignal.aborted || closed) return fail("CANCELLED"); };
    const join = (): Promise<void> => {
      if (!joining) {
        joining = (async () => {
          if (!abortLease) return fail("SETTLEMENT_UNKNOWN");
          const proof = await abortLease();
          if (!binding) return fail("SETTLEMENT_UNKNOWN");
          // Some compatible owners expose proof through the separate persisted
          // verifier after a void join. No timeout/cancel is safe without proof.
          settlement(proof === undefined ? await verify(binding) : proof, binding);
        })().catch(() => { poisoned = true; return fail("SETTLEMENT_UNKNOWN"); });
        void joining.catch(() => {});
      }
      return joining;
    };
    let interrupt!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
    void interrupted.catch(() => {});
    const abort = () => {
      if (!admitted || closingReleased) return;
      void join().then(() => interrupt(new StandingCommunityAssessmentPortError("CANCELLED")), error => interrupt(error));
    };
    joinedSignal.addEventListener("abort", abort, { once: true });
    const closeOwned = (): Promise<void> => {
      leaseClosing ??= Promise.resolve().then(() => { if (!closeLease) return fail("SETTLEMENT_UNKNOWN"); return closeLease(); });
      return leaseClosing;
    };
    try {
      guard(); const prepared = record(await prepare(), ["restoration"]); guard();
      if (typeof prepared.restoration !== "boolean") return fail("FAILED");
      rawLease = await acquire(ref); admitted = true;
      // Capture available cleanup before validating the rest of an admitted
      // lease, so malformed success envelopes cannot strand an actual owner.
      abortLease = optionalMethod(rawLease, "abortAndJoin"); closeLease = optionalMethod(rawLease, "close");
      const fields = record(rawLease, ["nativeBinding", "turnCommunityAssessment", "releaseCommunityAssessment", "abortAndJoin", "close"]);
      binding = bindingCopy(fields.nativeBinding, ref);
      const turn = method<StandingCommunityAssessmentLease["turnCommunityAssessment"]>(rawLease, "turnCommunityAssessment");
      const release = method<StandingCommunityAssessmentLease["releaseCommunityAssessment"]>(rawLease, "releaseCommunityAssessment");
      if (!abortLease || !closeLease) return fail("SETTLEMENT_UNKNOWN");
      if (joinedSignal.aborted) abort(); guard();
      const completed = await Promise.race([Promise.resolve().then(() => { guard(); return turn(ref, body); }), interrupted]);
      guard(); const decision = decisionCopy(completed, binding, input); guard();
      await Promise.race([Promise.resolve().then(() => { guard(); return release(ref); }), interrupted]); released = true; guard();
      // Once a release is acknowledged, closing only drops the scoped lease.
      // A cancel during that close still suppresses the decision, but must not
      // try abortAndJoin on a lease that the runtime has already marked closed.
      closingReleased = true; await closeOwned(); leaseClosed = true; guard(); return decision;
    } catch (error) {
      let code = safeCode(error);
      if (admitted && !(released && leaseClosed)) {
        try { await join(); } catch { code = "SETTLEMENT_UNKNOWN"; }
        try { await closeOwned(); } catch { code = "SETTLEMENT_UNKNOWN"; }
      }
      if (code === "SETTLEMENT_UNKNOWN") poisoned = true;
      else if (joinedSignal.aborted && code !== "COMMUNITY_ASSESSMENT_TIMEOUT") code = "CANCELLED";
      return fail(code);
    } finally {
      joinedSignal.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    assess(ref, body, suppliedSignal) {
      try {
        if (poisoned) return fail("SETTLEMENT_UNKNOWN"); if (closed) return fail("CLOSED"); if (active) return fail("BUSY");
        const callSignal = signalCopy(suppliedSignal); if (!identifier(ref)) return fail("INPUT");
        let input: StandingCommunityAssessmentInput; try { input = parseStandingCommunityAssessmentInput(body, ref); } catch { return fail("INPUT"); }
        const work = assess(ref, body, callSignal, input); active = work;
        return work.finally(() => { if (active === work) active = undefined; });
      } catch (error) { return Promise.reject(error); }
    },
    close() {
      if (!closing) {
        closed = true; stop.abort();
        closing = (async () => {
          try { await active; } catch { /* The admitted caller retains its error. */ }
          finally { signal.removeEventListener("abort", stopped); }
          if (poisoned) return fail("SETTLEMENT_UNKNOWN");
        })();
      }
      return closing;
    }
  });
}
