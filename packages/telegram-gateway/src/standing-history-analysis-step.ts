import { opendir, mkdir, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import { createHash } from "node:crypto";
import { LEGACY_MATERIAL_BYTES } from "./standing-history-analysis-limits.js";
import { EpochTurnNotAdmitted } from "./standing-epoch-session.js";
import type { CompletedAnalysisTurn } from "./standing-scoped-epoch-session.js";
import type { EpochExtraTool } from "./standing-tool-dispatcher.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskPage, type StandingHistoryTaskIntent, type StandingHistoryTaskStore } from "./standing-history-task-store.js";
import type { StandingIdleHistoryTicket, StandingIdleHistoryLease } from "./standing-conversation-adapter.js";
import type { StandingHistoryReadStepResult } from "./standing-history-read-step.js";
import { openStandingHistoryTaskControlStore, type StandingHistoryTaskControlStatus, type StandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisStore } from "./standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, isStandingHistoryAnalysisRetryableNoOutput, STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT, type StandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisAttemptPlan,
  type StandingHistoryAnalysisNativeBinding, type StandingHistoryAnalysisNodeEvidence, type StandingHistoryAnalysisModelOutcome } from "./standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner, type StandingHistoryAnalysisPlan, type StandingHistoryAnalysisPlanner } from "./standing-history-analysis-planner.js";
import { createStandingHistoryAnalysisRuntime, prepareStandingHistoryAnalysisMaterial, type StandingHistoryAnalysisRuntime } from "./standing-history-analysis-runtime.js";
import { projectStandingChronicleNote, type StandingChronicleNote } from "./standing-chronicle-note.js";
import { projectStandingHistorySource } from "./standing-history-source-projection.js";
import { projectMergeView } from "./standing-history-analysis-view.js";
import type { StandingHistoryChronicleCache, StandingHistoryChronicleProducer, StandingHistoryChronicleSelection } from "./standing-history-chronicle-cache.js";
import { openStandingHistoryChronicleReuseStore, type StandingHistoryChronicleReuseStore, type StandingHistoryChronicleReusePlan } from "./standing-history-chronicle-reuse-store.js";
import { createStandingHistoryParallelPlanner, type StandingHistoryParallelPlanner, type StandingHistoryParallelPlan } from "./standing-history-parallel-planner.js";
import { openStandingHistoryParallelWorkStore, type StandingHistoryParallelWorkStore, type StandingHistoryParallelWorkPlan, type StandingHistoryParallelWork } from "./standing-history-parallel-work-store.js";
import { createStandingHistoryParallelAnalysisRuntime, type StandingHistoryParallelAnalysisRuntime } from "./standing-history-parallel-analysis-runtime.js";
import { prepareStandingHistoryPeriodChronicle, consumeStandingHistoryPeriodChronicle, type StandingHistoryPeriodChronicleStore } from "./standing-history-period-chronicle.js";
import { createStandingHistoryPeriodChronicleTurn, type StandingHistoryPeriodChronicleTurn, type StandingHistoryPeriodChroniclePrepared } from "./standing-history-period-chronicle-turn.js";

export type StandingAnalysisReadyObserver = (event: Readonly<{ intent: StandingHistoryTaskIntent; note: StandingChronicleNote }>) => void;

export type StandingHistoryAnalysisOwnerSettlement = Readonly<{
  schema: "standing-analysis-owner-settlement-v1"; nativeBinding: StandingHistoryAnalysisNativeBinding;
  resourcesSettled: true; persisted: true; replacementReady: true; modelOutcome: "not-proven";
}>;
export type StandingHistoryAnalysisStepLease = Readonly<{
  nativeBinding: StandingHistoryAnalysisNativeBinding;
  turnAnalysis(requestRef: string, input: string, bindings: Readonly<{ analysisTools: readonly EpochExtraTool[]; onToolResultSent: StandingHistoryAnalysisRuntime["onToolResultSent"];
    work?: Readonly<{ taskRef: string; planRef: string; workRef: string }> }>): Promise<CompletedAnalysisTurn>;
  releaseAnalysis(requestRef: string): Promise<void>;
  abortAndJoin(): Promise<void>;
  close(): Promise<void>;
}>;
export type StandingHistoryParallelWorkRelease = Readonly<{ schema: "standing-analysis-work-release-v1"; nativeBinding: StandingHistoryAnalysisNativeBinding; workRef: string; releaseAcknowledged: true; callbacksJoined: true }>;
export type StandingHistoryParallelStepLease = Readonly<{
  workerId: string; nativeBinding: StandingHistoryAnalysisNativeBinding;
  turnAnalysis(requestRef: string, input: string, bindings: Readonly<{ analysisTools: readonly EpochExtraTool[]; onToolResultSent: StandingHistoryParallelAnalysisRuntime["onToolResultSent"];
    work: Readonly<{ taskRef: string; planRef: string; workRef: string }> }>): Promise<CompletedAnalysisTurn & Readonly<{ workerId?: string }>>;
  releaseAnalysis(requestRef: string): Promise<void>;
}>;
export type StandingHistoryParallelStepGroup = Readonly<{ leases: readonly StandingHistoryParallelStepLease[]; abortAndJoin(): Promise<void>; close(): Promise<void> }>;
export type StandingHistoryAnalysisStepConnection = Readonly<{
  acquireAnalysisAdmission(requestRef: string, previousNativeBinding?: StandingHistoryAnalysisNativeBinding, options?: Readonly<{ requireNewEpoch: true }>): Promise<StandingHistoryAnalysisStepLease>;
  acquireParallelAnalysisAdmissions?(requestRefs: readonly string[], previousNativeBinding?: StandingHistoryAnalysisNativeBinding, options?: Readonly<{ requireNewEpoch: true }>): Promise<StandingHistoryParallelStepGroup>;
  verifyAnalysisWorkReleased?(binding: StandingHistoryAnalysisNativeBinding, workRef: string): Promise<StandingHistoryParallelWorkRelease>;
}>;
type PassivePlan = Exclude<StandingHistoryAnalysisPlan, { kind: "leaf" | "merge" }>;
export type StandingHistoryAnalysisStepResult = PassivePlan | Readonly<{ kind: "cancelled" }> | Readonly<{
  kind: "attempt"; attemptRef: string; modelOutcome: StandingHistoryAnalysisModelOutcome; node?: StandingHistoryAnalysisNodeEvidence;
  release: "acknowledged" | "not-acknowledged"; cancelled: boolean;
}> | Readonly<{ kind: "reused"; reuseRef: string; node: StandingHistoryAnalysisNodeEvidence; recovered: boolean; cancelled: boolean }> |
  Readonly<{ kind: "parallel-wave"; waveRef: string; workRefs: readonly string[]; modelOutcomes: readonly StandingHistoryAnalysisModelOutcome[];
    node?: StandingHistoryAnalysisNodeEvidence; release: "acknowledged" | "not-acknowledged"; cancelled: boolean; recovered: boolean }>;
export type StandingHistoryAnalysisChronicle = Readonly<{ cache: StandingHistoryChronicleCache; producer: StandingHistoryChronicleProducer; reuseDirectory: string;
  periods?: Readonly<{ store: StandingHistoryPeriodChronicleStore; workspaceId: string }> }>;
export type StandingHistoryAnalysisParallelOptions = Readonly<{ directory: string; maxLeaves: number }>;
export type StandingHistoryAnalysisStep = Readonly<{
  next(input: Readonly<{ requestRef: string; connection: StandingHistoryAnalysisStepConnection; signal: AbortSignal }>): Promise<StandingHistoryAnalysisStepResult>;
  /** One serialized read on the retained source handle; no native admission. */
  readSourcePage(input: Readonly<{ ticket: StandingIdleHistoryTicket; signal: AbortSignal }>): Promise<StandingHistoryReadStepResult>;
  recoverPrepared(input: Readonly<{ attemptRef: string; signal: AbortSignal }>): Promise<Readonly<{
    kind: "recovered"; attemptRef: string; node: StandingHistoryAnalysisNodeEvidence; modelOutcome: StandingHistoryAnalysisModelOutcome;
  }>>;
  close(): Promise<void>;
}>;
export class StandingHistoryAnalysisStepError extends Error {
  constructor(readonly code: "input" | "storage" | "stale" | "consumed" | "parallel-consumed-without-prepared" | "cancelled" | "busy" | "closed" | "owner" | "outcome" | "close") {
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
function boundedArray(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return fail("input");
  return Array.from({ length: value.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !("value" in d) || !d.enumerable) return fail("input"); return d.value as unknown; });
}

/** One task-private analysis execution, borrowing the host's existing epoch.
 * Each next call makes one bounded planner step; this handle can reserve only
 * once by default. Opt-in retention admits fresh requests only after a saved,
 * observed turn is released and all cleanup succeeds. Stores must already exist.
 * The host serializes source/analysis writes and evicts before external writes.
 * Control is freshly reopened at every admission/commit check, never inferred
 * from a cached queued handle. The lease pins the actual owner across reserve,
 * tool callbacks and release. Only the executor's fresh reserve return admits
 * a model call; old reservations are consumed, even when their outcome is lost.
 * A bound, known observed/refused output-free analysis may have a bounded fresh successor
 * for the exact plan, after old-owner settlement and a new epoch/request.
 * Owner settlement proves cleanup, not dispatch or model observation. Recovery
 * never invokes a model. A raced cancellation does not roll back saved nodes.
 * No task completion, final delivery, or model-claim truth is asserted here. */
export async function openStandingHistoryAnalysisStep(value: Readonly<{
  intent: StandingHistoryTaskIntent; directories: Readonly<{ pages: string; control: string; analysis: string; attempts: string }>;
  passphrase: string; signal: AbortSignal;
  verifyOwnerSettled(binding: StandingHistoryAnalysisNativeBinding): Promise<StandingHistoryAnalysisOwnerSettlement>;
  /** Optional synchronous host cache capture; no new model or delivery authority. */
  onAnalysisReady?: StandingAnalysisReadyObserver;
  /** Reuse authenticated stores/planner after fully settled successful turns. */
  retainWorkingState?: boolean;
  packing?: "wide" | "large";
  /** Service-owned optional cache; reuse receipts remain task-private. */
  chronicle?: StandingHistoryAnalysisChronicle;
  parallel?: StandingHistoryAnalysisParallelOptions;
}>): Promise<StandingHistoryAnalysisStep> {
  const args = data(value, ["intent", "directories", "passphrase", "signal", "verifyOwnerSettled"], ["onAnalysisReady", "retainWorkingState", "packing", "chronicle", "parallel"]);
  if (Object.hasOwn(args, "packing") && args.packing !== "wide" && args.packing !== "large") return fail("input");
  if (Object.hasOwn(args, "retainWorkingState") && typeof args.retainWorkingState !== "boolean") return fail("input");
  const retainWorkingState = args.retainWorkingState === true, usedRequests = new Set<string>();
  if (Object.hasOwn(args, "onAnalysisReady") && (typeof args.onAnalysisReady !== "function" || types.isProxy(args.onAnalysisReady) ||
      types.isAsyncFunction(args.onAnalysisReady) || types.isGeneratorFunction(args.onAnalysisReady))) return fail("input");
  const onAnalysisReady = args.onAnalysisReady as StandingAnalysisReadyObserver | undefined;
  const intent = snapshotStandingHistoryTaskIntent(args.intent), dirs = data(args.directories, ["pages", "control", "analysis", "attempts"]);
  for (const path of Object.values(dirs)) if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return fail("input");
  const directories = Object.freeze(dirs) as Readonly<{ pages: string; control: string; analysis: string; attempts: string }>;
  let chronicle: Readonly<{ lookup: StandingHistoryChronicleCache["lookup"]; remember: StandingHistoryChronicleCache["remember"]; producer: StandingHistoryChronicleProducer; reuseDirectory: string }> | undefined;
  let periods: Readonly<{ lookup: StandingHistoryPeriodChronicleStore["lookup"]; remember: StandingHistoryPeriodChronicleStore["remember"]; workspaceId: string }> | undefined;
  if (Object.hasOwn(args, "chronicle")) {
    const ch = data(args.chronicle, ["cache", "producer", "reuseDirectory"], ["periods"]), p = data(ch.producer, ["model", "promptVersion", "projectionVersion", "outputVersion"]);
    if (Object.values(p).some(v => typeof v !== "string" || !v.trim() || v.includes("\0") || Buffer.byteLength(v) > 256) ||
      typeof ch.reuseDirectory !== "string" || !isAbsolute(ch.reuseDirectory) || resolve(ch.reuseDirectory) !== ch.reuseDirectory) return fail("input");
    for (const directory of Object.values(directories)) for (const [a, b] of [[directory, ch.reuseDirectory], [ch.reuseDirectory, directory]]) {
      const rel = relative(a!, b!); if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) return fail("input");
    }
    chronicle = Object.freeze({ lookup: method<StandingHistoryChronicleCache["lookup"]>(ch.cache, "lookup"), remember: method<StandingHistoryChronicleCache["remember"]>(ch.cache, "remember"),
      producer: Object.freeze(p) as StandingHistoryChronicleProducer, reuseDirectory: ch.reuseDirectory });
    if (Object.hasOwn(ch, "periods")) {
      const ps = data(ch.periods, ["store", "workspaceId"]);
      if (typeof ps.workspaceId !== "string" || !ps.workspaceId.trim() || ps.workspaceId.includes("\0") || Buffer.byteLength(ps.workspaceId) > 256) return fail("input");
      periods = Object.freeze({ lookup: method<StandingHistoryPeriodChronicleStore["lookup"]>(ps.store, "lookup"),
        remember: method<StandingHistoryPeriodChronicleStore["remember"]>(ps.store, "remember"), workspaceId: ps.workspaceId });
    }
  }
  let parallel: StandingHistoryAnalysisParallelOptions | undefined;
  if (Object.hasOwn(args, "parallel")) {
    const p = data(args.parallel, ["directory", "maxLeaves"]);
    if (typeof p.directory !== "string" || !isAbsolute(p.directory) || resolve(p.directory) !== p.directory || !Number.isSafeInteger(p.maxLeaves) || Number(p.maxLeaves) < 2 || Number(p.maxLeaves) > 8) return fail("input");
    for (const directory of [...Object.values(directories), ...(chronicle ? [chronicle.reuseDirectory] : [])]) for (const [a, b] of [[directory, p.directory], [p.directory, directory]]) {
      const rel = relative(a!, b!); if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) return fail("input");
    }
    parallel = Object.freeze({ directory: p.directory, maxLeaves: Number(p.maxLeaves) });
  }
  for (const a of Object.values(directories)) for (const b of Object.values(directories)) if (a !== b) {
    const rel = relative(a, b); if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) return fail("input");
  }
  if (new Set(Object.values(directories)).size !== 4 || typeof args.passphrase !== "string" || args.passphrase.length < 16 ||
      !args.passphrase.trim() || args.passphrase.includes("\0") || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString() !== args.passphrase) return fail("input");
  const signal = signalCopy(args.signal), verifyOwnerSettled = method<typeof value.verifyOwnerSettled>(value, "verifyOwnerSettled");
  let passphrase = args.passphrase, source: StandingHistoryTaskStore | undefined, analysis: StandingHistoryAnalysisStore | undefined;
  let controlAnchor: StandingHistoryTaskControlStore | undefined;
  let attempts: StandingHistoryAnalysisAttemptStore | undefined, planner: StandingHistoryAnalysisPlanner | StandingHistoryParallelPlanner | undefined, runtime: StandingHistoryAnalysisRuntime | undefined;
  let parallelStore: StandingHistoryParallelWorkStore | undefined;
  let parallelAdmission: Readonly<{ signal: AbortSignal; controlHead: string; sourceHead: string; nativeStatus: string }> | undefined;
  let parallelAbort: (() => Promise<void>) | undefined;
  let reuseStore: StandingHistoryChronicleReuseStore | undefined;
  let reuseAdmission: Readonly<{ signal: AbortSignal; controlHead: string; sourceHead: string; nativeStatus: string }> | undefined;
  // Only this handle's completed release/close, or the exact persisted owner
  // settlement verifier, can establish this proof. An observed node cannot.
  let settledForReuse: StandingHistoryAnalysisNativeBinding | undefined;
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
  const abort = () => { void abortOwner(); if (parallelAbort) void parallelAbort().catch(() => {}); };
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
  const retainedInventory = async (callSignal: AbortSignal, force = false) => {
    if (!retainWorkingState && !force) return;
    // Known-file stamps authenticate existing entries without decrypting the
    // archive again. Exact bounded listings also detect new unobserved entries;
    // directory timestamps alone cannot reliably establish a generation.
    const s = await source!.status(), a = await analysis!.status(); guard(callSignal);
    if (s.storage !== "ready" || a.storage !== "ready") return fail("storage");
    for (const [directory, prefix, count] of [[directories.pages, "page", s.readProgress.committedPages],
      [directories.analysis, "node", a.analysisNodes]] as const) {
      const expected = new Set(["intent.enc", ...Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(6, "0")}.enc`)]);
      const listing = await opendir(join(directory, intent.taskId));
      try {
        for (;;) {
          guard(callSignal); const entry = await listing.read(); if (!entry) break;
          if (!entry.isFile() || entry.isSymbolicLink() || !expected.delete(entry.name)) return fail("stale");
        }
        if (expected.size) return fail("stale");
      } finally { await listing.close(); }
    }
    // Recheck custody and known file stamps after reading the directory entries.
    await source!.status(); await analysis!.status(); guard(callSignal);
  };
  const verifiedSettlement = async (binding: StandingHistoryAnalysisNativeBinding, callSignal: AbortSignal) => {
    guard(callSignal); const p = data(await verifyOwnerSettled(binding), ["schema", "nativeBinding", "resourcesSettled", "persisted", "replacementReady", "modelOutcome"]);
    guard(callSignal); const b = bindingCopy(p.nativeBinding);
    if (p.schema !== "standing-analysis-owner-settlement-v1" || p.resourcesSettled !== true || p.persisted !== true || p.replacementReady !== true ||
        p.modelOutcome !== "not-proven" || b.epochId !== binding.epochId || b.requestRef !== binding.requestRef || b.purpose !== binding.purpose) return fail("owner");
    return Object.freeze({ schema: "standing-analysis-owner-settlement-v1" as const, nativeBinding: b, resourcesSettled: true as const, persisted: true as const, replacementReady: true as const, modelOutcome: "not-proven" as const });
  };
  const closeStores = async () => {
    const results = await Promise.allSettled([parallelStore?.close(), reuseStore?.close(), attempts?.close(), analysis?.close(), source?.close(), controlAnchor?.close()]);
    if (results.some(r => r.status === "rejected")) return fail("close");
  };
  // A proven no-admission reservation belongs to its exact old material, even
  // when a newer planner would pack different rows or choose wider children.
  // Reconstruct from authenticated descriptors and require the persisted hash;
  // this never substitutes a new plan or authorizes an uncertain model replay.
  const restoreRetryablePlan = async (saved: StandingHistoryAnalysisAttemptPlan, callSignal: AbortSignal): Promise<Extract<StandingHistoryAnalysisPlan, { kind: "leaf" | "merge" }>> => {
    const s = await source!.status(), a = await analysis!.status(); guard(callSignal);
    if (s.storage !== "ready" || a.storage !== "ready" || s.readProgress.chainHash !== saved.sourceHead ||
        a.headHash !== saved.expectedHead || a.analysisNodes + 1 !== saved.nodeIndex) return fail("stale");
    const heads = { sourceHead: saved.sourceHead, expectedHead: saved.expectedHead };
    if (saved.kind === "leaf") {
      const fragments = [];
      for (const descriptor of saved.inputs) {
        const page = await source!.readPage(descriptor.pageIndex); guard(callSignal); if (!page) return fail("storage");
        const fragment = projectStandingHistorySource({ intent, referenceKey: analysis!.referenceKey(), storedPage: page,
          maxBytes: descriptor.maxBytes, ...(descriptor.maxRows === undefined ? {} : { maxRows: descriptor.maxRows }),
          ...(descriptor.position === undefined ? {} : { position: descriptor.position }) });
        if (fragment.materialRef !== descriptor.materialRef) return fail("stale"); fragments.push(fragment);
      }
      const plan = { kind: "leaf" as const, ...heads, inputs: [saved.inputs[0]!, ...saved.inputs.slice(1)] as const,
        material: fragments.length === 1 ? fragments[0]! : { schema: "standing-history-source-batch-v1" as const, fragments } };
      if (prepareStandingHistoryAnalysisMaterial(plan).modelInputHash !== saved.modelInputHash) return fail("stale");
      return plan;
    }
    if (saved.children.length < 2) return fail("stale");
    const children = [];
    for (const reference of saved.children) {
      const child = await analysis!.readNode(reference); guard(callSignal); if (!child) return fail("storage"); children.push(child);
    }
    for (const preferComplete of children.length === 2 ? [false, true] : [true]) {
      const view = projectMergeView({ children, referenceKey: analysis!.referenceKey(), maxBytes: saved.viewMaxBytes ?? LEGACY_MATERIAL_BYTES, ...(preferComplete ? { preferComplete: true } : {}) });
      const plan = { kind: "merge" as const, ...heads, children: [saved.children[0]!, saved.children[1]!, ...saved.children.slice(2)] as const, materials: view.children,
        ...(saved.viewMaxBytes === undefined ? {} : { viewMaxBytes: saved.viewMaxBytes }) };
      if (prepareStandingHistoryAnalysisMaterial(plan).modelInputHash === saved.modelInputHash) return plan;
    }
    return fail("stale");
  };
  const chronicleSelection = async (inputs: Extract<StandingHistoryAnalysisPlan, { kind: "leaf" }>["inputs"], callSignal: AbortSignal): Promise<StandingHistoryChronicleSelection> => {
    const materials: StandingHistoryChronicleSelection["materials"][number][] = [];
    for (const request of inputs) { const page = await source!.readPage(request.pageIndex); guard(callSignal); if (!page) return fail("storage"); materials.push({ request, page }); }
    return Object.freeze({ intent, producer: chronicle!.producer, referenceKey: analysis!.referenceKey(), materials: Object.freeze(materials) });
  };
  const runReuse = async (saved: StandingHistoryChronicleReusePlan, reuseRef: string | undefined, callSignal: AbortSignal, controlHead: string, nativeStatus: string,
    priorBinding?: StandingHistoryAnalysisNativeBinding) => {
    if (priorBinding && (!settledForReuse || settledForReuse.epochId !== priorBinding.epochId || settledForReuse.requestRef !== priorBinding.requestRef)) {
      await verifiedSettlement(priorBinding, callSignal); settledForReuse = priorBinding;
    }
    await queued(callSignal, controlHead); const s = await source!.status(); guard(callSignal);
    if (s.storage !== "ready" || s.readProgress.chainHash !== saved.sourceHead) return fail("stale");
    reuseAdmission = { signal: callSignal, controlHead, sourceHead: saved.sourceHead, nativeStatus }; consumed = true;
    try {
      const prepared = reuseRef ? { reuseRef } : await reuseStore!.prepare(saved);
      await queued(callSignal, controlHead);
      const node = await reuseStore!.commitPrepared(prepared);
      const after = await controlStatus(), cancelled = after.state !== "queued" || joinedSignal.aborted || callSignal.aborted;
      if (after.storage !== "ready") return fail("stale");
      if (retainWorkingState && !cancelled) consumed = false;
      return Object.freeze({ kind: "reused" as const, reuseRef: prepared.reuseRef, node, recovered: reuseRef !== undefined, cancelled });
    } finally { reuseAdmission = undefined; }
  };
  const parallelPending = async (callSignal: AbortSignal) => {
    if (!parallelStore) return undefined; const p = await parallelStore.status(); guard(callSignal);
    if (p.storage !== "ready") return fail("storage"); return p.activeWave;
  };
  const projectParallel = async (wave: Readonly<{ waveRef: string; workRefs: readonly string[] }>, callSignal: AbortSignal, controlHead: string, nativeStatus: string,
    warm?: NonNullable<StandingHistoryAnalysisStepConnection["verifyAnalysisWorkReleased"]>, warmWorkRef?: string) => {
    const works = [];
    for (const workRef of wave.workRefs) { const work = await parallelStore!.readWork(workRef); guard(callSignal); works.push(work); }
    if (works.some(w => !w.output || w.modelOutcome === "refused")) return undefined;
    // Missing native receipts after restart remain UNKNOWN. A saved output can
    // still be projected only after the exact old owner is physically settled.
    for (const work of works) if (!work.modelOutcome) {
      if (warm && (!warmWorkRef || work.workRef === warmWorkRef)) return fail("outcome"); await verifiedSettlement(work.plan.nativeBinding, callSignal);
      await parallelStore!.recordModelOutcome({ workRef: work.workRef, outcome: "unknown" });
    }
    parallelAdmission = { signal: callSignal, controlHead, sourceHead: works[0]!.sourceHead, nativeStatus };
    try {
      for (;;) {
        await queued(callSignal, controlHead);
        let useWarm = !!warm;
        if (warmWorkRef) { useWarm = false; for (const ref of wave.workRefs) { const w = await parallelStore!.readWork(ref); if (!w.node) { useWarm = ref === warmWorkRef; break; } } }
        const projected = useWarm ? await parallelStore!.projectNext({ waveRef: wave.waveRef, verifyWorkReleased: warm! }) :
          await parallelStore!.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: b => verifiedSettlement(b, callSignal) });
        if (projected.kind === "complete") break;
      }
      const last = await parallelStore!.readWork(wave.workRefs.at(-1)!); guard(callSignal);
      if (!last.node) return fail("outcome"); return last.node;
    } finally { parallelAdmission = undefined; }
  };
  const recoverParallel = async (wave: Readonly<{ waveRef: string; workRefs: readonly string[] }>, callSignal: AbortSignal, controlHead: string, nativeStatus: string) => {
    consumed = true;
    const node = await projectParallel(wave, callSignal, controlHead, nativeStatus);
    // A cold, authenticated outputless reservation is task-local. No native
    // admission occurred; storage and owner-settlement failures still throw.
    if (!node) return fail("parallel-consumed-without-prepared");
    const modelOutcomes: StandingHistoryAnalysisModelOutcome[] = [];
    for (const workRef of wave.workRefs) { const work = await parallelStore!.readWork(workRef); if (!work.modelOutcome) return fail("outcome"); modelOutcomes.push(work.modelOutcome); }
    await queued(callSignal, controlHead); if (retainWorkingState) consumed = false;
    return Object.freeze({ kind: "parallel-wave" as const, ...wave, modelOutcomes: Object.freeze(modelOutcomes), node, release: "not-acknowledged" as const, cancelled: false, recovered: true });
  };
  const runParallel = async (plan: Readonly<{ kind: "leaf-wave"; sourceHead: string; expectedHead: string; plans: readonly Extract<StandingHistoryAnalysisPlan, { kind: "leaf" }>[] }>, requestRef: string, connection: unknown,
    callSignal: AbortSignal, controlHead: string, nativeStatus: string, priorBinding?: StandingHistoryAnalysisNativeBinding, priorOutcome?: StandingHistoryAnalysisModelOutcome,
    retry?: StandingHistoryParallelWork) => {
    const acquire = method<NonNullable<StandingHistoryAnalysisStepConnection["acquireParallelAnalysisAdmissions"]>>(connection, "acquireParallelAnalysisAdmissions");
    const verifyWarm = method<NonNullable<StandingHistoryAnalysisStepConnection["verifyAnalysisWorkReleased"]>>(connection, "verifyAnalysisWorkReleased");
    const requests = Object.freeze(plan.plans.map((_, i) => "ph-" + createHash("sha256").update(intent.taskId + ":" + requestRef).digest("hex") + "-" + i));
    const runtimes: StandingHistoryParallelAnalysisRuntime[] = [], outcomes: StandingHistoryAnalysisModelOutcome[] = requests.map(() => "unknown");
    const periodTurns: (StandingHistoryPeriodChronicleTurn | undefined)[] = requests.map(() => undefined);
    const periodOutputs: (StandingHistoryPeriodChroniclePrepared | undefined)[] = requests.map(() => undefined);
    const releases: boolean[] = requests.map(() => false); const turnSignal = AbortSignal.any([joinedSignal, callSignal]);
    let groupCleanup: Partial<Pick<StandingHistoryParallelStepGroup, "abortAndJoin" | "close">> | undefined, aborted: Promise<void> | undefined, groupClosed: Promise<void> | undefined;
    let wave: Readonly<{ waveRef: string; workRefs: readonly string[] }> | undefined, callbacksLive = true, succeeded = false;
    const abortGroup = () => {
      if (!groupCleanup) return Promise.resolve();
      if (!aborted) { try { aborted = groupCleanup?.abortAndJoin ? Promise.resolve(groupCleanup.abortAndJoin()) : Promise.resolve(); } catch (error) { aborted = Promise.reject(error); } void aborted.catch(() => {}); }
      return aborted;
    };
    const closeGroup = () => {
      if (!groupClosed) { try { groupClosed = groupCleanup?.close ? Promise.resolve(groupCleanup.close()) : Promise.reject(new StandingHistoryAnalysisStepError("owner")); } catch (error) { groupClosed = Promise.reject(error); } void groupClosed.catch(() => {}); }
      return groupClosed;
    };
    const abortCall = () => { void abortGroup().catch(() => {}); }; callSignal.addEventListener("abort", abortCall, { once: true }); parallelAbort = abortGroup;
    try {
      if (priorBinding && !retry && priorOutcome !== "observed") await verifiedSettlement(priorBinding, callSignal);
      const raw = await acquire(requests, priorBinding, retry ? { requireNewEpoch: true } : undefined);
      const abortCleanup = availableCleanup(raw, "abortAndJoin"), closeCleanup = availableCleanup(raw, "close");
      groupCleanup = Object.freeze({ ...(abortCleanup ? { abortAndJoin: abortCleanup } : {}), ...(closeCleanup ? { close: closeCleanup } : {}) });
      const group = data(raw, ["leases", "abortAndJoin", "close"]); method(raw, "abortAndJoin"); method(raw, "close");
      const leases = boundedArray(group.leases, requests.length, requests.length).map((raw, i) => {
        const l = data(raw, ["workerId", "nativeBinding", "turnAnalysis", "releaseAnalysis"], ["abortAndJoin", "close"]), nativeBinding = bindingCopy(l.nativeBinding);
        if (!scopedRef(l.workerId) || nativeBinding.requestRef !== requests[i]) return fail("owner");
        return Object.freeze({ workerId: l.workerId, nativeBinding, turnAnalysis: method<StandingHistoryParallelStepLease["turnAnalysis"]>(raw, "turnAnalysis"), releaseAnalysis: method<StandingHistoryParallelStepLease["releaseAnalysis"]>(raw, "releaseAnalysis") });
      });
      if (new Set(leases.map(l => l.workerId)).size !== leases.length || new Set(leases.map(l => l.nativeBinding.epochId)).size !== 1) return fail("owner");
      if (retry) {
        if (leases.some(l => l.nativeBinding.epochId === retry.plan.nativeBinding.epochId)) return fail("owner");
      }
      guard(callSignal); await queued(callSignal, controlHead); await retainedInventory(callSignal);
      if (JSON.stringify(await attempts!.status()) !== nativeStatus) return fail("stale");
      const prepared = plan.plans.map(p => prepareStandingHistoryAnalysisMaterial(p));
      if (periods) for (let i = 0; i < plan.plans.length; i++) {
        try {
          const material = prepared[i]!.material;
          const rows = material.schema === "standing-history-source-batch-v1" ? material.fragments.flatMap(f => f.rows) : material.schema === "standing-history-source-fragment-v1" ? material.rows : [];
          const dated = rows.find(row => row.date !== null); if (!dated) continue;
          const parts = new Intl.DateTimeFormat("en-US", { timeZone: intent.timezone, year: "numeric", month: "2-digit" }).formatToParts(new Date(dated.date! * 1000));
          const key = parts.find(p => p.type === "year")!.value + "-" + parts.find(p => p.type === "month")!.value;
          const selection = await chronicleSelection(plan.plans[i]!.inputs, callSignal);
          const request = prepareStandingHistoryPeriodChronicle({ ...selection, workspaceId: periods.workspaceId, period: { kind: "month", key } });
          if (!request) continue;
          let note; try { note = await periods.lookup(request); } catch { /* Optional cache miss. */ }
          const advisory = note ? consumeStandingHistoryPeriodChronicle({ request, note }) : undefined;
          periodTurns[i] = createStandingHistoryPeriodChronicleTurn({ requestRef: requests[i]!, signal: turnSignal,
            ...(advisory ? { advisory } : { neutralRequest: request }) });
        } catch { /* Optional period context cannot prevent primary analysis. */ }
        guard(callSignal);
      }
      await queued(callSignal, controlHead);
      const plans: StandingHistoryParallelWorkPlan[] = plan.plans.map((p, i) => ({ kind: "leaf", inputs: p.inputs, modelInputHash: prepared[i]!.modelInputHash, nativeBinding: leases[i]!.nativeBinding,
        ...(periodTurns[i] ? { contextHash: periodTurns[i]!.contextHash } : {}) }));
      if (retry && (plans.length !== 1 || plans[0]!.modelInputHash !== retry.plan.modelInputHash)) return fail("stale");
      // The primary saved material remains exact. Optional period context is
      // rebuilt from the current producer/cache; its change belongs to the new
      // attempt and must be explicitly recorded, never relabeled on the old one.
      const contextRefresh = retry && plans[0]!.contextHash !== retry.plan.contextHash
        ? { previousContextHash: retry.plan.contextHash ?? null, contextHash: plans[0]!.contextHash ?? null } : undefined;
      consumed = true; usedRequests.add(requestRef);
      if (retry) {
        const successor = await parallelStore!.reserveSuccessor({ workRef: retry.workRef, nativeBinding: leases[0]!.nativeBinding,
          ...(contextRefresh ? { contextRefresh } : {}), verifyOwnerSettled: async b => {
          const proof = await verifiedSettlement(b, callSignal);
          await queued(callSignal, controlHead); await retainedInventory(callSignal, true);
          return proof;
        } });
        wave = { waveRef: successor.waveRef, workRefs: [successor.workRef] };
      } else wave = await parallelStore!.reserveWave({ sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, works: plans }); guard(callSignal);
      const controlPort = Object.freeze({ status: controlStatus });
      for (const _ of leases) runtimes.push(createStandingHistoryParallelAnalysisRuntime({ intent, signal: joinedSignal, source: source!, control: controlPort, workStore: parallelStore! }));
      const bodies = periodTurns.map(period => JSON.stringify({ schema: "neurobro-history-analysis-input-v1", kind: "leaf", objective: intent.objective, materialAvailable: true,
        ...(retry ? { continuation: "The previous settled analysis attempt produced no accepted node. Reuse this exact saved plan and commit an accepted analysis node; no source or transport failure is inferred." } : {}),
        ...(intent.source ? { sourceRef: "community", sourceInterpretation: "quoted-source-not-request" } : {}), ...(period ? { periodChronicle: period.advertised } : {}) }));
      if (bodies.some(body => Buffer.byteLength(body) > 24576)) return fail("input");
      // All durable work reservations exist before the first native turn. Each
      // task invokes its unique lease once, even if sibling preparation fails.
      const results = await Promise.allSettled(leases.map(async (lease, i) => {
        const runtime = runtimes[i]!, workRef = wave!.workRefs[i]!, material = prepared[i]!.material;
        try {
          if (material.schema === "standing-history-merge-view-v1") return fail("input");
          await runtime.begin({ requestRef: requests[i]!, workRef, material, controlHead, signal: turnSignal,
            ...(periodTurns[i] ? { periodChronicle: periodTurns[i]! } : {}) }); guard(callSignal);
          const completed = await lease.turnAnalysis(requests[i]!, bodies[i]!, {
            work: Object.freeze({ taskRef: intent.taskId, planRef: wave!.waveRef, workRef }),
            analysisTools: Object.freeze(runtime.handlers.map(tool => Object.freeze({ name: tool.name, call: async (...args: Parameters<EpochExtraTool["call"]>) => { if (!callbacksLive) return fail("consumed"); return tool.call(...args); } }))),
            onToolResultSent(event) { if (!callbacksLive) return fail("consumed"); runtime.onToolResultSent(event); }
          });
          const c = data(completed, ["kind", "scope", "answer", "toolCalls", "toolRefusals"], ["workerId"]), scope = data(c.scope, ["epochId", "purpose", "requestRef", "threadId", "turnId", "turnNumber", "threadTurnNumber"]);
          if (c.kind !== "analysis" || scope.epochId !== lease.nativeBinding.epochId || scope.purpose !== "history-analysis" || scope.requestRef !== requests[i] || Object.hasOwn(c, "workerId") && c.workerId !== lease.workerId) return fail("owner");
          outcomes[i] = "observed";
          periodOutputs[i] = runtime.preparedPeriodChronicle();
        } catch (error) { outcomes[i] = error instanceof EpochTurnNotAdmitted ? "refused" : "unknown"; void abortGroup().catch(() => {}); }
        finally { await runtime.finish(); }
        await parallelStore!.recordModelOutcome({ workRef, outcome: outcomes[i]! });
        if (outcomes[i] === "observed" && !turnSignal.aborted && !aborted) {
          try { await lease.releaseAnalysis(requests[i]!); releases[i] = true; } catch { void abortGroup().catch(() => {}); }
        }
      }));
      callbacksLive = false;
      if (results.some(r => r.status === "rejected")) { await abortGroup(); return fail("outcome"); }
      const after = await controlStatus(), cancelled = after.state !== "queued" || turnSignal.aborted;
      if (after.storage !== "ready") return fail("stale");
      if (cancelled || releases.some(v => !v)) await abortGroup();
      if (aborted) await aborted; await closeGroup();
      const warm = !aborted && releases.every(Boolean);
      const completeWave = retry ? (await parallelStore!.status()).activeWave : wave;
      if (!completeWave) return fail("outcome");
      const node = cancelled ? undefined : await projectParallel(completeWave, callSignal, controlHead, nativeStatus, warm ? verifyWarm : undefined, retry && warm ? wave.workRefs[0] : undefined);
      if (node && periods && warm && !cancelled) for (let i = 0; i < periodOutputs.length; i++) {
        const output = periodOutputs[i]; if (!output || outcomes[i] !== "observed" || !releases[i]) continue;
        try {
          const binding = leases[i]!.nativeBinding, workRef = wave.workRefs[i]!;
          const receipt = data(await verifyWarm(binding, workRef), ["schema", "nativeBinding", "workRef", "releaseAcknowledged", "callbacksJoined"]);
          const b = bindingCopy(receipt.nativeBinding);
          if (receipt.schema !== "standing-analysis-work-release-v1" || receipt.workRef !== workRef || receipt.releaseAcknowledged !== true || receipt.callbacksJoined !== true ||
              b.epochId !== binding.epochId || b.requestRef !== binding.requestRef) continue;
          await queued(callSignal, controlHead);
          await periods.remember({ ...output, generation: { purpose: "neutral-period-notes", inputHash: output.request.inputHash,
            requestRef: binding.requestRef, epochId: binding.epochId, modelOutcome: "observed", workRelease: Object.freeze({ schema: "standing-analysis-work-release-v1", nativeBinding: b, workRef, releaseAcknowledged: true, callbacksJoined: true }) },
            capturedAt: Math.floor(Date.now() / 1000) });
        } catch { /* A derived note loss is a cache miss, never a work replay. */ }
      }
      if (node && chronicle && !cancelled) for (let i = 0; i < plan.plans.length; i++) if (outcomes[i] === "observed") {
        try { const selection = await chronicleSelection(plan.plans[i]!.inputs, callSignal), work = await parallelStore!.readWork(wave.workRefs[i]!); await queued(callSignal, controlHead);
          const saved = work.node ? await analysis!.readNode(work.node.nodeRef) : undefined;
          if (saved && saved.kind === "leaf" && saved.hash === work.node!.hash) await chronicle.remember({ ...selection, node: saved, capturedAt: Math.floor(Date.now() / 1000) });
        } catch { /* Optional capture cannot alter durable parallel results. */ }
      }
      succeeded = !!node && !cancelled;
      if (retainWorkingState && succeeded) consumed = false;
      const completeOutcomes = retry ? await Promise.all(completeWave.workRefs.map(async ref => (await parallelStore!.readWork(ref)).modelOutcome ?? "unknown")) : outcomes;
      return Object.freeze({ kind: "parallel-wave" as const, ...completeWave, modelOutcomes: Object.freeze([...completeOutcomes]), ...(node ? { node } : {}), release: warm ? "acknowledged" as const : "not-acknowledged" as const, cancelled, recovered: false });
    } finally {
      callbacksLive = false;
      try {
        periodTurns.forEach(turn => turn?.close());
        if (!succeeded && groupCleanup) await abortGroup();
        const finished = await Promise.allSettled(runtimes.map(r => r.close()));
        if (groupCleanup) { if (aborted) await aborted; await closeGroup(); }
        if (finished.some(r => r.status === "rejected")) return fail("close");
      } catch (error) { consumed = true; throw error; }
      finally { parallelAbort = undefined; callSignal.removeEventListener("abort", abortCall); }
    }
  };
  try {
    guard(); controlAnchor = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open" }); await queued(joinedSignal);
    source = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" });
    analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", readSourcePage: i => source!.readPage(i) });
    attempts = await openStandingHistoryAnalysisAttemptStore({ directory: directories.attempts, passphrase, intent, mode: "open", analysis });
    if (chronicle) reuseStore = await openStandingHistoryChronicleReuseStore({ directory: chronicle.reuseDirectory, passphrase, intent,
      analysis: { status: () => analysis!.status(), readNodeAt: i => analysis!.readNodeAt(i), async appendLeaf(input) {
        const admission = reuseAdmission; if (!admission) return fail("consumed");
        await queued(admission.signal, admission.controlHead);
        const s = await source!.status(), a = await attempts!.status(); guard(admission.signal);
        if (s.storage !== "ready" || s.readProgress.chainHash !== admission.sourceHead || JSON.stringify(a) !== admission.nativeStatus) return fail("stale");
        await retainedInventory(admission.signal); guard(admission.signal); return analysis!.appendLeaf(input);
      } } });
    if (parallel) {
      await mkdir(parallel.directory, { recursive: true, mode: 0o700 });
      let mode: "open" | "create" = "open";
      try { await lstat(join(parallel.directory, intent.taskId)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; mode = "create"; }
      parallelStore = await openStandingHistoryParallelWorkStore({ directory: parallel.directory, passphrase, intent, mode, source,
        analysis: { status: () => analysis!.status(), readNodeAt: i => analysis!.readNodeAt(i), readNode: ref => analysis!.readNode(ref), referenceKey: () => analysis!.referenceKey(),
          async appendLeaf(input) {
            const admission = parallelAdmission; if (!admission) return fail("consumed");
            await queued(admission.signal, admission.controlHead);
            const s = await source!.status(), a = await attempts!.status(); guard(admission.signal);
            if (s.storage !== "ready" || s.readProgress.chainHash !== admission.sourceHead || JSON.stringify(a) !== admission.nativeStatus) return fail("stale");
            await retainedInventory(admission.signal); guard(admission.signal); return analysis!.appendLeaf(input);
          },
          async appendMerge() { return fail("consumed"); }
        } });
    }
    planner = parallel ? createStandingHistoryParallelPlanner({ intent, source, analysis, signal: joinedSignal, maxLeaves: parallel.maxLeaves,
      ...(args.packing === "large" ? { packing: "large" as const } : {}) }) :
      createStandingHistoryAnalysisPlanner({ intent, source, analysis, signal: joinedSignal,
        ...(args.packing === "wide" || args.packing === "large" ? { packing: args.packing } : {}) });
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
    readSourcePage(input) {
      const v = data(input, ["ticket", "signal"]), callSignal = signalCopy(v.signal);
      const ticket = data(v.ticket, ["openHistoryTask"], ["openTaskReply", "openObservedSource", "openObservedHistoryTask", "openCommunityAlert"]);
      for (const key of Object.keys(ticket)) method(v.ticket, key);
      const openTask = method<NonNullable<StandingIdleHistoryTicket["openHistoryTask"]>>(v.ticket, intent.source ? "openObservedHistoryTask" : "openHistoryTask");
      return run(async () => {
        if (!retainWorkingState || consumed) return fail("consumed");
        const readSignal = AbortSignal.any([joinedSignal, callSignal]);
        let closeTask: (() => Promise<void>) | undefined, closingTask: Promise<void> | undefined, appendAdmitted = false;
        const closeRead = () => {
          if (!closeTask) return Promise.resolve();
          if (!closingTask) { try { closingTask = Promise.resolve(closeTask()); } catch (error) { closingTask = Promise.reject(error); } void closingTask.catch(() => {}); }
          return closingTask;
        };
        const abortRead = () => { void closeRead(); };
        readSignal.addEventListener("abort", abortRead, { once: true });
        try {
          await retainedInventory(callSignal);
          const c = await queued(callSignal), initial = await source!.status(), prior = await attempts!.status(); guard(callSignal);
          if (initial.storage !== "ready" || prior.storage !== "ready") return fail("storage");
          if (await parallelPending(callSignal)) return fail("consumed");
          if (reuseStore) { const reuse = await reuseStore.status(); guard(callSignal);
            if (reuse.storage !== "ready") return fail("storage"); if (reuse.last && !reuse.last.node) return fail("consumed"); }
          // Advancing the source would invalidate an exact pending/refused plan.
          // A reconciled UNKNOWN node is already committed, but its old owner
          // must be proved settled before advancing to different source work.
          if (prior.last) {
            if (!prior.last.nativeBinding || !prior.last.node || !prior.last.modelOutcome || prior.last.modelOutcome === "refused") return fail("consumed");
            if (prior.last.modelOutcome !== "observed") await verifiedSettlement(prior.last.nativeBinding, callSignal);
          }
          if (initial.readProgress.checkpoint.status !== "more" || initial.limits.pageQuotaReached) return Object.freeze({ kind: "stale" });
          const lease = openTask({ intent, checkpoint: initial.readProgress.checkpoint, signal: readSignal });
          // Capture cleanup before inspecting the read capability.
          closeTask = method<StandingIdleHistoryLease["close"]>(lease, "close");
          data(lease, ["readTaskPage", "close"]);
          const read = method<StandingIdleHistoryLease["readTaskPage"]>(lease, "readTaskPage"); guard(callSignal);
          const page = snapshotStandingHistoryTaskPage(await read(), intent);
          await closeRead();
          await retainedInventory(callSignal);
          const currentControl = await queued(callSignal);
          if (currentControl.headHash !== c.headHash) return fail("stale");
          // A reservation or outcome added while the read was outstanding must
          // not acquire a different source head beneath its immutable plan.
          const currentAttempts = await attempts!.status(); guard(callSignal);
          if (currentAttempts.storage !== "ready" || JSON.stringify(currentAttempts) !== JSON.stringify(prior)) return fail("stale");
          if (await parallelPending(callSignal)) return fail("consumed");
          const current = await source!.status(); guard(callSignal);
          if (current.storage !== "ready" || current.readProgress.chainHash !== initial.readProgress.chainHash) return fail("stale");
          // Conservatively poison this handle until append returns. An uncertain
          // append cannot be retried through the retained workspace.
          consumed = true; appendAdmitted = true;
          const committed = await source!.appendPage({ expectedCheckpoint: current.readProgress.checkpoint, result: page });
          consumed = false;
          return Object.freeze({ kind: "committed", read: committed });
        } catch (error) {
          if (!appendAdmitted && (readSignal.aborted || error instanceof StandingHistoryAnalysisStepError && error.code === "cancelled")) return Object.freeze({ kind: "cancelled" });
          throw error;
        } finally {
          try { await closeRead(); } catch { consumed = true; return fail("close"); }
          finally { readSignal.removeEventListener("abort", abortRead); }
        }
      });
    },
    next(input) {
      const v = data(input, ["requestRef", "connection", "signal"]); if (!scopedRef(v.requestRef)) return fail("input");
      const requestRef = v.requestRef, callSignal = signalCopy(v.signal), acquire = method<StandingHistoryAnalysisStepConnection["acquireAnalysisAdmission"]>(v.connection, "acquireAnalysisAdmission");
      return run(async () => {
        if (consumed || usedRequests.has(requestRef)) return fail("consumed");
        if (joinedSignal.aborted || callSignal.aborted) return Object.freeze({ kind: "cancelled" });
        await retainedInventory(callSignal);
        const c = await queued(callSignal), status = await attempts!.status(); guard(callSignal);
        if (status.storage !== "ready") return fail("storage");
        const retryableNoOutput = isStandingHistoryAnalysisRetryableNoOutput(status.last);
        if (status.last && (retryableNoOutput ? (status.last.consecutiveNoOutput ?? STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT) >= STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT :
          !status.last.nativeBinding || !status.last.node || !status.last.modelOutcome || status.last.modelOutcome === "refused")) return fail("consumed");
        const cleanNativeHistory = !status.last || status.last.modelOutcome === "observed" && !!status.last.node && !!status.last.nativeBinding;
        const pendingParallel = await parallelPending(callSignal);
        if (pendingParallel && retryableNoOutput) return fail("consumed");
        if (reuseStore) {
          const reuse = await reuseStore.status(); guard(callSignal); if (reuse.storage !== "ready") return fail("storage");
          if (reuse.last && !reuse.last.node) {
            if (pendingParallel) return fail("consumed");
            if (!cleanNativeHistory) return fail("consumed");
            const saved = await reuseStore.readPrepared(reuse.last.reuseRef); guard(callSignal);
            if (retainWorkingState) usedRequests.add(requestRef);
            return runReuse(saved, reuse.last.reuseRef, callSignal, c.headHash, JSON.stringify(status), status.last?.nativeBinding);
          }
        }
        if (pendingParallel) {
          if (status.last && status.last.modelOutcome !== "observed") await verifiedSettlement(status.last.nativeBinding!, callSignal);
          const pendingWorks = await Promise.all(pendingParallel.workRefs.map(ref => parallelStore!.readWork(ref)));
          const missing = pendingWorks.filter(w => !w.output);
          if (missing.length && missing.every(w => !w.projection && !w.node &&
              (w.modelOutcome === undefined || w.modelOutcome === "unknown" || w.modelOutcome === "observed" || w.modelOutcome === "refused") &&
              (w.consecutiveNoOutput ?? STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT) < STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT)) {
            const old = missing[0]!, current = await analysis!.status();
            if (old.plan.kind !== "leaf" || current.storage !== "ready") return fail("parallel-consumed-without-prepared");
            const restored = await restoreRetryablePlan({ ...old.plan, sourceHead: old.sourceHead, expectedHead: current.headHash, nodeIndex: current.analysisNodes + 1 }, callSignal);
            if (restored.kind !== "leaf") return fail("stale");
            return runParallel({ kind: "leaf-wave", sourceHead: old.sourceHead, expectedHead: current.headHash, plans: [restored] }, requestRef, v.connection,
              callSignal, c.headHash, JSON.stringify(status), old.plan.nativeBinding, old.modelOutcome, old);
          }
          usedRequests.add(requestRef); return recoverParallel(pendingParallel, callSignal, c.headHash, JSON.stringify(status));
        }
        const plan = retryableNoOutput ? await restoreRetryablePlan(await attempts!.readRetryablePlan(status.last!.attemptRef), callSignal) : await planner!.next(); guard(callSignal);
        if (plan.kind === "leaf-wave") {
          // Existing reusable leaves remain an optimization before a new wave.
          // Commit one exact cache hit, then let the planner re-read real heads.
          if (chronicle && cleanNativeHistory) for (const leaf of plan.plans) {
            let selection: StandingHistoryChronicleSelection | undefined;
            try { selection = await chronicleSelection(leaf.inputs, callSignal); } catch { /* Optional miss. */ }
            guard(callSignal); if (!selection) continue;
            let hit; try { hit = await chronicle.lookup(selection); } catch { /* Optional miss. */ }
            guard(callSignal); if (hit) {
              const a = await analysis!.status(); guard(callSignal); if (a.storage !== "ready" || a.headHash !== plan.expectedHead) return fail("stale");
              usedRequests.add(requestRef); return runReuse({ sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, nodeIndex: a.analysisNodes + 1, inputs: leaf.inputs, hit }, undefined,
                callSignal, c.headHash, JSON.stringify(status), status.last?.nativeBinding);
            }
          }
          return runParallel(plan, requestRef, v.connection, callSignal, c.headHash, JSON.stringify(status), status.last?.nativeBinding, status.last?.modelOutcome);
        }
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
        let selection: StandingHistoryChronicleSelection | undefined;
        if (chronicle && plan.kind === "leaf") {
          try { selection = await chronicleSelection(plan.inputs, callSignal); } catch { /* Optional capture/lookup is a miss. */ }
          guard(callSignal);
          const sourceStatus = await source!.status(); guard(callSignal);
          // Existing final delivery requires a real native root owner. A sole
          // cached terminal leaf would lack one, so keep that leaf native.
          if (selection && cleanNativeHistory && !(a.analysisNodes === 0 && sourceStatus.readProgress.checkpoint.status !== "more")) {
            let hit; try { hit = await chronicle.lookup(selection); } catch { /* Corrupt optional cache is a miss. */ }
            guard(callSignal);
            if (hit) { if (retainWorkingState) usedRequests.add(requestRef);
              return runReuse({ sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, nodeIndex: a.analysisNodes + 1, inputs: plan.inputs, hit }, undefined,
                callSignal, c.headHash, JSON.stringify(status), status.last?.nativeBinding); }
          }
        }
        const attemptPlan: StandingHistoryAnalysisAttemptPlan = Object.freeze({ kind: plan.kind, sourceHead: plan.sourceHead, expectedHead: plan.expectedHead,
          nodeIndex: a.analysisNodes + 1, modelInputHash: prepared.modelInputHash, ...(plan.kind === "leaf" ? { inputs: plan.inputs } : { children: plan.children,
            ...(plan.viewMaxBytes === undefined ? {} : { viewMaxBytes: plan.viewMaxBytes }) }) }) as StandingHistoryAnalysisAttemptPlan;
        const body = JSON.stringify({ schema: "neurobro-history-analysis-input-v1", kind: plan.kind, objective: intent.objective, materialAvailable: true,
          ...(retryableNoOutput ? { continuation: "The previous settled analysis attempt produced no accepted node. Reuse this exact saved plan and commit an accepted analysis node; no source or transport failure is inferred." } : {}),
          ...(intent.source ? { sourceRef: "community", sourceInterpretation: "quoted-source-not-request" } : {}) });
        if (Buffer.byteLength(intent.objective) > 4096 || Buffer.byteLength(body) > 24576) return fail("input");
        let reserved: Awaited<ReturnType<StandingHistoryAnalysisAttemptStore["reserve"]>> | undefined;
        let outcome: StandingHistoryAnalysisModelOutcome = "unknown", release: "acknowledged" | "not-acknowledged" = "not-acknowledged", turnCalled = false;
        let reusable = false, toolsLive = true;
        let acquiredBinding: StandingHistoryAnalysisNativeBinding | undefined;
        const callAbort = () => { void abortOwner(); };
        callSignal.addEventListener("abort", callAbort, { once: true });
        try {
          const raw = await acquire(requestRef, status.last?.nativeBinding, retryableNoOutput ? { requireNewEpoch: true } : undefined);
          // Retain the inert cleanup capabilities before validating any binding
          // or turn fields: malformed host data must not leak an acquired owner.
          const abortCleanup = availableCleanup(raw, "abortAndJoin"), closeCleanup = availableCleanup(raw, "close");
          cleanupLease = Object.freeze({ ...(abortCleanup ? { abortAndJoin: abortCleanup } : {}), ...(closeCleanup ? { close: closeCleanup } : {}) });
          const l = data(raw, ["nativeBinding", "turnAnalysis", "releaseAnalysis", "abortAndJoin", "close"]);
          const nativeBinding = bindingCopy(l.nativeBinding);
          acquiredBinding = nativeBinding;
          const currentLease: StandingHistoryAnalysisStepLease = Object.freeze({ nativeBinding,
            turnAnalysis: method<StandingHistoryAnalysisStepLease["turnAnalysis"]>(raw, "turnAnalysis"), releaseAnalysis: method<StandingHistoryAnalysisStepLease["releaseAnalysis"]>(raw, "releaseAnalysis"),
            abortAndJoin: method<StandingHistoryAnalysisStepLease["abortAndJoin"]>(raw, "abortAndJoin"), close: method<StandingHistoryAnalysisStepLease["close"]>(raw, "close") });
          if (nativeBinding.requestRef !== requestRef) return fail("owner"); guard(callSignal);
          if (retryableNoOutput && (nativeBinding.epochId === status.last!.nativeBinding!.epochId || nativeBinding.requestRef === status.last!.nativeBinding!.requestRef)) return fail("owner");
          if (status.last) {
            const previous = status.last.nativeBinding!;
            // acquire validates exact prior release on the current owner, or
            // persisted prior-owner settlement. Every no-output successor
            // requires the latter even if the old owner advertised ready.
            if (!retryableNoOutput && status.last.modelOutcome !== "observed") await verifiedSettlement(previous, callSignal);
          }
          await queued(callSignal, c.headHash);
          const sourceStatus = await source!.status(); guard(callSignal);
          if (sourceStatus.storage !== "ready" || sourceStatus.readProgress.chainHash !== plan.sourceHead) return fail("stale");
          await retainedInventory(callSignal);
          consumed = true;
          if (retainWorkingState) usedRequests.add(requestRef);
          reserved = retryableNoOutput ? await attempts!.reserveSuccessor({ attemptRef: status.last!.attemptRef, plan: attemptPlan, nativeBinding,
            verifyOwnerSettled: async previous => {
              const proof = await verifiedSettlement(previous, callSignal);
              await queued(callSignal, c.headHash); await retainedInventory(callSignal, true);
              const freshSource = await source!.status(); guard(callSignal);
              if (freshSource.storage !== "ready" || freshSource.readProgress.chainHash !== plan.sourceHead) return fail("stale");
              return proof;
            } }) : await attempts!.reserve({ plan: attemptPlan, nativeBinding });
          guard(callSignal); await queued(callSignal, c.headHash);
          await runtime!.begin({ requestRef, attemptRef: reserved.attemptRef, plan: attemptPlan, material: prepared.material, controlHead: c.headHash,
            signal: AbortSignal.any([joinedSignal, callSignal]) });
          guard(callSignal); turnCalled = true;
          try {
            // A previously exposed callback must not acquire the next turn's
            // runtime authority, even if invoked with that turn's requestRef.
            const bindings = retainWorkingState ? {
              analysisTools: Object.freeze(runtime!.handlers.map(tool => Object.freeze({ name: tool.name,
                async call(...args: Parameters<EpochExtraTool["call"]>) { if (!toolsLive) return fail("consumed"); return tool.call(...args); } }))),
              onToolResultSent(...args: Parameters<StandingHistoryAnalysisRuntime["onToolResultSent"]>) {
                if (!toolsLive) return fail("consumed"); runtime!.onToolResultSent(...args);
              }
            } : { analysisTools: runtime!.handlers, onToolResultSent: runtime!.onToolResultSent };
            const completed = await currentLease.turnAnalysis(requestRef, body, { ...bindings,
              ...(parallel && Object.hasOwn(v.connection as object, "acquireParallelAnalysisAdmissions") ? { work: { taskRef: intent.taskId, planRef: reserved.attemptRef, workRef: reserved.attemptRef } } : {}) });
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
          reusable = outcome === "observed" && !!saved.last.node && release === "acknowledged" && !cancelled;
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
          toolsLive = false;
          try {
            try { await runtime!.finish(); }
            finally {
              if (cleanupLease) {
                try { if (release !== "acknowledged" || joinedSignal.aborted || callSignal.aborted) await abortOwner(); await joining; }
                finally { await closeOwnerLease(); }
              }
            }
            if (reusable && acquiredBinding && !closed && !joinedSignal.aborted && !callSignal.aborted) settledForReuse = acquiredBinding;
            // A reusable leaf is published only after the actual native owner
            // closed successfully. Capture remains joined and optional; it does
            // not alter the saved node, attempt outcome or source coverage.
            if (chronicle && selection && reusable && !closed && !joinedSignal.aborted && !callSignal.aborted) {
              try {
                await queued(callSignal, c.headHash);
                const saved = await attempts!.status(); guard(callSignal);
                if (saved.storage === "ready" && saved.last?.attemptRef === reserved?.attemptRef && saved.last?.modelOutcome === "observed" && saved.last.node) {
                  const node = await analysis!.readNode(saved.last.node.nodeRef); guard(callSignal);
                  if (node && node.hash === saved.last.node.hash && node.kind === "leaf") await chronicle.remember({ ...selection, node, capturedAt: Math.floor(Date.now() / 1000) });
                }
              } catch { /* Failed optional capture cannot change native completion. */ }
            }
            if (retainWorkingState && reusable && !closed && !joinedSignal.aborted && !callSignal.aborted) consumed = false;
          } catch (error) { if (retainWorkingState) consumed = true; throw error; }
          finally { cleanupLease = undefined; joining = undefined; closingLease = undefined; callSignal.removeEventListener("abort", callAbort); }
        }
      });
    },
    recoverPrepared(input) {
      const v = data(input, ["attemptRef", "signal"]), callSignal = signalCopy(v.signal);
      if (typeof v.attemptRef !== "string" || !/^hattempt_[0-9a-f]{48}$/.test(v.attemptRef)) return fail("input"); const attemptRef = v.attemptRef;
      return run(async () => {
        if (consumed) return fail("consumed"); const c = await queued(callSignal), status = await attempts!.status(); guard(callSignal);
        if (status.storage !== "ready") return fail("storage"); const last = status.last;
        if (reuseStore) { const reuse = await reuseStore.status(); guard(callSignal);
          if (reuse.storage !== "ready") return fail("storage"); if (reuse.last && !reuse.last.node) return fail("consumed"); }
        if (await parallelPending(callSignal)) return fail("consumed");
        if (!last || last.attemptRef !== attemptRef || !last.prepared || !last.nativeBinding || last.modelOutcome === "refused") return fail("consumed");
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
