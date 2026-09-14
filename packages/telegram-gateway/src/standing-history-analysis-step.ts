import { isAbsolute, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import { EpochTurnNotAdmitted } from "./standing-epoch-session.js";
import type { CompletedAnalysisTurn } from "./standing-scoped-epoch-session.js";
import type { EpochExtraTool } from "./standing-tool-dispatcher.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent, type StandingHistoryTaskStore } from "./standing-history-task-store.js";
import { openStandingHistoryTaskControlStore, type StandingHistoryTaskControlStatus, type StandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisStore } from "./standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisAttemptPlan,
  type StandingHistoryAnalysisNativeBinding, type StandingHistoryAnalysisNodeEvidence, type StandingHistoryAnalysisModelOutcome } from "./standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner, type StandingHistoryAnalysisPlan, type StandingHistoryAnalysisPlanner } from "./standing-history-analysis-planner.js";
import { createStandingHistoryAnalysisRuntime, prepareStandingHistoryAnalysisMaterial, type StandingHistoryAnalysisRuntime } from "./standing-history-analysis-runtime.js";
import { projectStandingChronicleNote, type StandingChronicleNote } from "./standing-chronicle-note.js";

export type StandingAnalysisReadyObserver = (event: Readonly<{ intent: StandingHistoryTaskIntent; note: StandingChronicleNote }>) => void;

export type StandingHistoryAnalysisOwnerSettlement = Readonly<{
  schema: "standing-analysis-owner-settlement-v1"; nativeBinding: StandingHistoryAnalysisNativeBinding;
  resourcesSettled: true; persisted: true; replacementReady: true; modelOutcome: "not-proven";
}>;
export type StandingHistoryAnalysisStepLease = Readonly<{
  nativeBinding: StandingHistoryAnalysisNativeBinding;
  turnAnalysis(requestRef: string, input: string, bindings: Readonly<{ analysisTools: readonly EpochExtraTool[]; onToolResultSent: StandingHistoryAnalysisRuntime["onToolResultSent"] }>): Promise<CompletedAnalysisTurn>;
  releaseAnalysis(requestRef: string): Promise<void>;
  abortAndJoin(): Promise<void>;
  close(): Promise<void>;
}>;
export type StandingHistoryAnalysisStepConnection = Readonly<{ acquireAnalysisAdmission(requestRef: string, previousNativeBinding?: StandingHistoryAnalysisNativeBinding): Promise<StandingHistoryAnalysisStepLease> }>;
type PassivePlan = Exclude<StandingHistoryAnalysisPlan, { kind: "leaf" | "merge" }>;
export type StandingHistoryAnalysisStepResult = PassivePlan | Readonly<{ kind: "cancelled" }> | Readonly<{
  kind: "attempt"; attemptRef: string; modelOutcome: StandingHistoryAnalysisModelOutcome; node?: StandingHistoryAnalysisNodeEvidence;
  release: "acknowledged" | "not-acknowledged"; cancelled: boolean;
}>;
export type StandingHistoryAnalysisStep = Readonly<{
  next(input: Readonly<{ requestRef: string; connection: StandingHistoryAnalysisStepConnection; signal: AbortSignal }>): Promise<StandingHistoryAnalysisStepResult>;
  recoverPrepared(input: Readonly<{ attemptRef: string; signal: AbortSignal }>): Promise<Readonly<{
    kind: "recovered"; attemptRef: string; node: StandingHistoryAnalysisNodeEvidence; modelOutcome: StandingHistoryAnalysisModelOutcome;
  }>>;
  close(): Promise<void>;
}>;
export class StandingHistoryAnalysisStepError extends Error {
  constructor(readonly code: "input" | "storage" | "stale" | "consumed" | "cancelled" | "busy" | "closed" | "owner" | "outcome" | "close") {
    super("STANDING_HISTORY_ANALYSIS_STEP_" + code.toUpperCase());
  }
}
const fail = (code: StandingHistoryAnalysisStepError["code"]): never => { throw new StandingHistoryAnalysisStepError(code); };
function data(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(ds);
  if (keys.some(k => !Object.hasOwn(ds, k)) || names.some(k => typeof k !== "string" || !keys.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(names.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function method<T extends (...args: never[]) => unknown>(value: unknown, name: string): T {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail("input");
  const d = Object.getOwnPropertyDescriptor(value, name);
  if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail("input");
  return d.value.bind(value) as T;
}
function availableCleanup(value: unknown, name: "abortAndJoin" | "close"): (() => Promise<void>) | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, name);
  return d && "value" in d && typeof d.value === "function" && !types.isProxy(d.value) ? d.value.bind(value) as () => Promise<void> : undefined;
}
const scopedRef = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
function bindingCopy(value: unknown): StandingHistoryAnalysisNativeBinding {
  const b = data(value, ["epochId", "requestRef", "purpose"]);
  if (typeof b.epochId !== "string" || !/^[0-9a-f]{32}$/.test(b.epochId) || !scopedRef(b.requestRef) || b.purpose !== "history-analysis") return fail("input");
  return Object.freeze({ epochId: b.epochId, requestRef: b.requestRef, purpose: "history-analysis" });
}
function signalCopy(value: unknown): AbortSignal { if (types.isProxy(value) || !(value instanceof AbortSignal)) return fail("input"); return value; }

/** One task-private analysis execution, borrowing the host's existing epoch.
 * Each next call makes one bounded planner step; this handle can reserve only
 * once. Stores must already exist. The host serializes source/analysis writes.
 * Control is freshly reopened at every admission/commit check, never inferred
 * from a cached queued handle. The lease pins the actual owner across reserve,
 * tool callbacks and release. Only the executor's fresh reserve return admits
 * a model call; old reservations are consumed, even when their outcome is lost.
 * Owner settlement proves cleanup, not dispatch or model observation. Recovery
 * never invokes a model. A raced cancellation does not roll back saved nodes.
 * No task completion, final delivery, or model-claim truth is asserted here. */
export async function openStandingHistoryAnalysisStep(value: Readonly<{
  intent: StandingHistoryTaskIntent; directories: Readonly<{ pages: string; control: string; analysis: string; attempts: string }>;
  passphrase: string; signal: AbortSignal;
  verifyOwnerSettled(binding: StandingHistoryAnalysisNativeBinding): Promise<StandingHistoryAnalysisOwnerSettlement>;
  /** Optional synchronous host cache capture; no new model or delivery authority. */
  onAnalysisReady?: StandingAnalysisReadyObserver;
}>): Promise<StandingHistoryAnalysisStep> {
  const args = data(value, ["intent", "directories", "passphrase", "signal", "verifyOwnerSettled"], ["onAnalysisReady"]);
  if (Object.hasOwn(args, "onAnalysisReady") && (typeof args.onAnalysisReady !== "function" || types.isProxy(args.onAnalysisReady) ||
      types.isAsyncFunction(args.onAnalysisReady) || types.isGeneratorFunction(args.onAnalysisReady))) return fail("input");
  const onAnalysisReady = args.onAnalysisReady as StandingAnalysisReadyObserver | undefined;
  const intent = snapshotStandingHistoryTaskIntent(args.intent), dirs = data(args.directories, ["pages", "control", "analysis", "attempts"]);
  for (const path of Object.values(dirs)) if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return fail("input");
  const directories = Object.freeze(dirs) as Readonly<{ pages: string; control: string; analysis: string; attempts: string }>;
  for (const a of Object.values(directories)) for (const b of Object.values(directories)) if (a !== b) {
    const rel = relative(a, b); if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) return fail("input");
  }
  if (new Set(Object.values(directories)).size !== 4 || typeof args.passphrase !== "string" || args.passphrase.length < 16 ||
      !args.passphrase.trim() || args.passphrase.includes("\0") || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString() !== args.passphrase) return fail("input");
  const signal = signalCopy(args.signal), verifyOwnerSettled = method<typeof value.verifyOwnerSettled>(value, "verifyOwnerSettled");
  let passphrase = args.passphrase, source: StandingHistoryTaskStore | undefined, analysis: StandingHistoryAnalysisStore | undefined;
  let controlAnchor: StandingHistoryTaskControlStore | undefined;
  let attempts: StandingHistoryAnalysisAttemptStore | undefined, planner: StandingHistoryAnalysisPlanner | undefined, runtime: StandingHistoryAnalysisRuntime | undefined;
  const stop = new AbortController(), joinedSignal = AbortSignal.any([signal, stop.signal]);
  let closed = false, consumed = false, active: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  let joining: Promise<void> | undefined, closingLease: Promise<void> | undefined;
  let cleanupLease: Partial<Pick<StandingHistoryAnalysisStepLease, "abortAndJoin" | "close">> | undefined;
  const closeOwnerLease = (): Promise<void> => {
    if (!closingLease) {
      try { closingLease = cleanupLease?.close ? Promise.resolve(cleanupLease.close()) : Promise.reject(new StandingHistoryAnalysisStepError("owner")); }
      catch { closingLease = Promise.reject(new StandingHistoryAnalysisStepError("owner")); }
      void closingLease.catch(() => {});
    }
    return closingLease;
  };
  const abortOwner = (): Promise<void> => {
    if (!cleanupLease) return Promise.resolve();
    if (!joining) { try { joining = cleanupLease.abortAndJoin ? Promise.resolve(cleanupLease.abortAndJoin()) : closeOwnerLease(); } catch { joining = Promise.reject(new StandingHistoryAnalysisStepError("owner")); } void joining.catch(() => {}); }
    return joining;
  };
  const abort = () => { void abortOwner(); };
  joinedSignal.addEventListener("abort", abort, { once: true });
  const guard = (callSignal?: AbortSignal) => { if (closed || joinedSignal.aborted || callSignal?.aborted) return fail("cancelled"); };
  const controlStatus = async (): Promise<StandingHistoryTaskControlStatus> => {
    // The original handle pins root/slot/file custody while the fresh handle
    // observes cancellation appended by another authorized task controller.
    await controlAnchor?.status();
    const control = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open" });
    try { const status = await control.status(); await controlAnchor?.status(); return status; } finally { await control.close(); }
  };
  const queued = async (callSignal: AbortSignal, head?: string) => {
    guard(callSignal); const c = await controlStatus(); guard(callSignal);
    if (c.storage !== "ready" || head !== undefined && c.headHash !== head) return fail("stale");
    if (c.state !== "queued") return fail("cancelled"); return c;
  };
  const verifiedSettlement = async (binding: StandingHistoryAnalysisNativeBinding, callSignal: AbortSignal) => {
    guard(callSignal); const p = data(await verifyOwnerSettled(binding), ["schema", "nativeBinding", "resourcesSettled", "persisted", "replacementReady", "modelOutcome"]);
    guard(callSignal); const b = bindingCopy(p.nativeBinding);
    if (p.schema !== "standing-analysis-owner-settlement-v1" || p.resourcesSettled !== true || p.persisted !== true || p.replacementReady !== true ||
        p.modelOutcome !== "not-proven" || b.epochId !== binding.epochId || b.requestRef !== binding.requestRef || b.purpose !== binding.purpose) return fail("owner");
  };
  const closeStores = async () => {
    const results = await Promise.allSettled([attempts?.close(), analysis?.close(), source?.close(), controlAnchor?.close()]);
    if (results.some(r => r.status === "rejected")) return fail("close");
  };
  try {
    guard(); controlAnchor = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open" }); await queued(joinedSignal);
    source = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" });
    analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", readSourcePage: i => source!.readPage(i) });
    attempts = await openStandingHistoryAnalysisAttemptStore({ directory: directories.attempts, passphrase, intent, mode: "open", analysis });
    planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis, signal: joinedSignal });
    runtime = createStandingHistoryAnalysisRuntime({ intent, source, control: { status: controlStatus }, analysis, attempts, signal: joinedSignal });
    guard();
  } catch (error) {
    joinedSignal.removeEventListener("abort", abort);
    try { await Promise.allSettled([runtime?.close(), planner?.close()]); await closeStores(); }
    finally { passphrase = ""; }
    throw error;
  }
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new StandingHistoryAnalysisStepError("closed"));
    if (active) return Promise.reject(new StandingHistoryAnalysisStepError("busy"));
    const operation = Promise.resolve().then(work); active = operation;
    return operation.finally(() => { if (active === operation) active = undefined; });
  };
  return Object.freeze<StandingHistoryAnalysisStep>({
    next(input) {
      const v = data(input, ["requestRef", "connection", "signal"]); if (!scopedRef(v.requestRef)) return fail("input");
      const requestRef = v.requestRef, callSignal = signalCopy(v.signal), acquire = method<StandingHistoryAnalysisStepConnection["acquireAnalysisAdmission"]>(v.connection, "acquireAnalysisAdmission");
      return run(async () => {
        if (consumed) return fail("consumed");
        if (joinedSignal.aborted || callSignal.aborted) return Object.freeze({ kind: "cancelled" });
        const c = await queued(callSignal), status = await attempts!.status(); guard(callSignal);
        if (status.storage !== "ready") return fail("storage");
        if (status.last && (!status.last.nativeBinding || !status.last.node || !status.last.modelOutcome)) return fail("consumed");
        const plan = await planner!.next(); guard(callSignal);
        if (plan.kind === "analysis-ready" && plan.rootRef && onAnalysisReady) {
          // These optional reads share the already-open stores and this active
          // step operation: close/cancellation joins them, never a detached job.
          // Capture errors cannot replace the original planner/delivery result.
          try {
            const node = await analysis!.readNode(plan.rootRef); guard(callSignal);
            const s = await source!.status(); guard(callSignal);
            const a = await analysis!.status(); guard(callSignal);
            if (!node || s.storage !== "ready" || a.storage !== "ready" ||
                s.readProgress.chainHash !== plan.sourceHead || a.headHash !== plan.expectedHead || node.hash !== a.headHash) return plan;
            await queued(callSignal, c.headHash);
            const note = projectStandingChronicleNote({ intent, readiness: plan, node, referenceKey: analysis!.referenceKey() });
            guard(callSignal);
            const returned = onAnalysisReady(Object.freeze({ intent, note }));
            // A regular function can still violate the synchronous contract by
            // returning a Promise. Never await it or grant asynchronous work;
            // consume its rejection without reading an arbitrary thenable.
            if (types.isPromise(returned)) void Promise.prototype.then.call(returned, undefined, () => {});
          } catch { /* Optional read-side memory cannot change task execution. */ }
          guard(callSignal);
        }
        if (plan.kind !== "leaf" && plan.kind !== "merge") return plan;
        const prepared = prepareStandingHistoryAnalysisMaterial(plan), a = await analysis!.status(); guard(callSignal);
        if (a.storage !== "ready" || a.headHash !== plan.expectedHead) return fail("stale");
        const attemptPlan: StandingHistoryAnalysisAttemptPlan = Object.freeze({ kind: plan.kind, sourceHead: plan.sourceHead, expectedHead: plan.expectedHead,
          nodeIndex: a.analysisNodes + 1, modelInputHash: prepared.modelInputHash, ...(plan.kind === "leaf" ? { inputs: plan.inputs } : { children: plan.children }) }) as StandingHistoryAnalysisAttemptPlan;
        const body = JSON.stringify({ schema: "neurobro-history-analysis-input-v1", kind: plan.kind, objective: intent.objective, materialAvailable: true });
        if (Buffer.byteLength(intent.objective) > 4096 || Buffer.byteLength(body) > 24576) return fail("input");
        let reserved: Awaited<ReturnType<StandingHistoryAnalysisAttemptStore["reserve"]>> | undefined;
        let outcome: StandingHistoryAnalysisModelOutcome = "unknown", release: "acknowledged" | "not-acknowledged" = "not-acknowledged", turnCalled = false;
        const callAbort = () => { void abortOwner(); };
        callSignal.addEventListener("abort", callAbort, { once: true });
        try {
          const raw = await acquire(requestRef, status.last?.nativeBinding);
          // Retain the inert cleanup capabilities before validating any binding
          // or turn fields: malformed host data must not leak an acquired owner.
          const abortCleanup = availableCleanup(raw, "abortAndJoin"), closeCleanup = availableCleanup(raw, "close");
          cleanupLease = Object.freeze({ ...(abortCleanup ? { abortAndJoin: abortCleanup } : {}), ...(closeCleanup ? { close: closeCleanup } : {}) });
          const l = data(raw, ["nativeBinding", "turnAnalysis", "releaseAnalysis", "abortAndJoin", "close"]);
          const nativeBinding = bindingCopy(l.nativeBinding);
          const currentLease: StandingHistoryAnalysisStepLease = Object.freeze({ nativeBinding,
            turnAnalysis: method<StandingHistoryAnalysisStepLease["turnAnalysis"]>(raw, "turnAnalysis"), releaseAnalysis: method<StandingHistoryAnalysisStepLease["releaseAnalysis"]>(raw, "releaseAnalysis"),
            abortAndJoin: method<StandingHistoryAnalysisStepLease["abortAndJoin"]>(raw, "abortAndJoin"), close: method<StandingHistoryAnalysisStepLease["close"]>(raw, "close") });
          if (nativeBinding.requestRef !== requestRef) return fail("owner"); guard(callSignal);
          if (status.last) {
            const previous = status.last.nativeBinding!;
            // acquire validates exact prior release on the current owner, or
            // persisted prior-owner settlement. UNKNOWN/refused requires the
            // latter explicitly even if this owner advertises ready again.
            if (status.last.modelOutcome !== "observed") await verifiedSettlement(previous, callSignal);
          }
          await queued(callSignal, c.headHash); consumed = true;
          reserved = await attempts!.reserve({ plan: attemptPlan, nativeBinding });
          guard(callSignal); await queued(callSignal, c.headHash);
          await runtime!.begin({ requestRef, attemptRef: reserved.attemptRef, plan: attemptPlan, material: prepared.material, controlHead: c.headHash,
            signal: AbortSignal.any([joinedSignal, callSignal]) });
          guard(callSignal); turnCalled = true;
          try {
            const completed = await currentLease.turnAnalysis(requestRef, body, { analysisTools: runtime!.handlers, onToolResultSent: runtime!.onToolResultSent });
            const result = data(completed, ["kind", "scope", "answer", "toolCalls", "toolRefusals"]);
            const scope = data(result.scope, ["epochId", "purpose", "requestRef", "threadId", "turnId", "turnNumber", "threadTurnNumber"]);
            if (result.kind !== "analysis" || scope.epochId !== nativeBinding.epochId || scope.requestRef !== requestRef || scope.purpose !== "history-analysis") return fail("owner");
            outcome = "observed";
          } catch (error) { outcome = error instanceof EpochTurnNotAdmitted ? "refused" : "unknown"; }
          try { await attempts!.recordModelOutcome({ attemptRef: reserved.attemptRef, outcome }); } catch { return fail("outcome"); }
          const afterControl = await controlStatus();
          if (afterControl.storage !== "ready") return fail("stale");
          const cancelled = afterControl.state === "cancelled" || joinedSignal.aborted || callSignal.aborted;
          if (outcome === "observed" && !cancelled) {
            try { await currentLease.releaseAnalysis(requestRef); release = "acknowledged"; } catch { await abortOwner(); }
          } else await abortOwner();
          await runtime!.finish();
          const saved = await attempts!.status();
          if (saved.storage !== "ready" || saved.last?.attemptRef !== reserved.attemptRef || saved.last.modelOutcome !== outcome) return fail("outcome");
          return Object.freeze({ kind: "attempt", attemptRef: reserved.attemptRef, modelOutcome: outcome,
            ...(saved.last.node ? { node: saved.last.node } : {}), release, cancelled });
        } catch (error) {
          if (reserved && !turnCalled) {
            // The reservation is consumed even though this executor never called
            // the turn capability. UNKNOWN remains conservative across crashes.
            try { await attempts!.recordModelOutcome({ attemptRef: reserved.attemptRef, outcome: "unknown" }); } catch { return fail("outcome"); }
          }
          throw error;
        } finally {
          try {
            try { await runtime!.finish(); }
            finally {
              if (cleanupLease) {
                try { if (release !== "acknowledged" || joinedSignal.aborted || callSignal.aborted) await abortOwner(); await joining; }
                finally { await closeOwnerLease(); }
              }
            }
          } finally { cleanupLease = undefined; joining = undefined; closingLease = undefined; callSignal.removeEventListener("abort", callAbort); }
        }
      });
    },
    recoverPrepared(input) {
      const v = data(input, ["attemptRef", "signal"]), callSignal = signalCopy(v.signal);
      if (typeof v.attemptRef !== "string" || !/^hattempt_[0-9a-f]{48}$/.test(v.attemptRef)) return fail("input"); const attemptRef = v.attemptRef;
      return run(async () => {
        if (consumed) return fail("consumed"); const c = await queued(callSignal), status = await attempts!.status(); guard(callSignal);
        if (status.storage !== "ready") return fail("storage"); const last = status.last;
        if (!last || last.attemptRef !== attemptRef || !last.prepared || !last.nativeBinding) return fail("consumed");
        await verifiedSettlement(last.nativeBinding, callSignal); await queued(callSignal, c.headHash); consumed = true;
        const modelOutcome = last.modelOutcome ?? "unknown";
        if (!last.modelOutcome) await attempts!.recordModelOutcome({ attemptRef, outcome: modelOutcome });
        await queued(callSignal, c.headHash);
        const node = await attempts!.commitPrepared({ attemptRef });
        return Object.freeze({ kind: "recovered", attemptRef, node, modelOutcome });
      });
    },
    close() {
      if (!closing) {
        closed = true; stop.abort();
        closing = (async () => {
          try { if (active) await active.catch(() => {}); await joining; await runtime!.close(); await planner!.close(); }
          finally { try { await closeStores(); } finally { passphrase = ""; joinedSignal.removeEventListener("abort", abort); } }
        })();
      }
      return closing;
    }
  });
}
