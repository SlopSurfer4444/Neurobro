import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { READ_AHEAD_PAGES } from "./standing-history-analysis-limits.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import type { StandingIdleHistoryTicket, StandingPollWork, StandingSelection } from "./standing-conversation-adapter.js";
import { openStandingHistoryTaskDiscovery, type StandingHistoryTaskDiscovery, type StandingHistoryTaskDiscoveryPage } from "./standing-history-task-discovery.js";
import { snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskObservedSource, type StandingHistoryTaskIntent, type StandingHistoryTaskObservedSource } from "./standing-history-task-store.js";
import type { StandingHistoryTaskManager, StandingHistoryManagedTaskStatus } from "./standing-history-task-manager.js";
import type { StandingHistoryReadStepResult } from "./standing-history-read-step.js";
import { openStandingHistoryAnalysisStep, StandingHistoryAnalysisStepError, type StandingHistoryAnalysisStep, type StandingHistoryAnalysisStepConnection, type StandingHistoryAnalysisOwnerSettlement, type StandingHistoryAnalysisStepResult } from "./standing-history-analysis-step.js";
import { isStandingHistoryAnalysisRetryableNoOutput, STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT,
  type StandingHistoryAnalysisNativeBinding, type StandingHistoryAnalysisAttemptStatus } from "./standing-history-analysis-attempt-store.js";
import { readStandingHistoryTaskDelivery, readStandingDeliveredChronicleNote, StandingHistoryTaskDeliveryError } from "./standing-history-task-delivery.js";
import { readStandingHistoryTaskDisposition, recordStandingHistoryTaskDisposition, type StandingHistoryTaskDispositionReason } from "./standing-history-task-disposition.js";
import type { StandingAnalysisReadyObserver, StandingHistoryAnalysisChronicle, StandingHistoryAnalysisParallelOptions } from "./standing-history-analysis-step.js";
import { resolveStandingHistoryParallelMaintenance } from "./standing-history-parallel-maintenance.js";
import { canContinueStandingHistoryReport } from "./standing-history-final-report.js";

type Recovery = Awaited<ReturnType<StandingHistoryAnalysisStep["recoverPrepared"]>>;
type Ready = Extract<StandingHistoryAnalysisStepResult, { kind: "analysis-ready" }>;
// Classification only. The analysis step/store still require actual prior-owner
// settlement, unchanged plan/heads, and a fresh epoch/request before reserving.
const canContinueNoOutput = (last: StandingHistoryAnalysisAttemptStatus["last"]) =>
  isStandingHistoryAnalysisRetryableNoOutput(last) && (last!.consecutiveNoOutput ?? 1) < STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT;
export type StandingHistoryTaskWork = Readonly<{ kind: "selected"; selection: StandingSelection } | { kind: "more" } | { kind: "idle" }> |
  Readonly<{ kind: "background"; outcome:
    Readonly<{ kind: "participant" }> |
    Readonly<{ kind: "analysis-running"; taskRef: string }> |
    Readonly<{ kind: "scan"; hasMore: boolean; coverage: StandingHistoryTaskDiscoveryPage["coverage"] }> |
    Readonly<{ kind: "read"; taskRef: string; result: StandingHistoryReadStepResult }> |
    Readonly<{ kind: "analysis"; taskRef: string; result: Exclude<StandingHistoryAnalysisStepResult, Ready> }> |
    Readonly<{ kind: "recovered"; taskRef: string; result: Recovery }> |
    Readonly<{ kind: "delivery-state"; taskRef: string; state: string }> |
    Readonly<{ kind: "task-blocked"; taskRef: string; reason: StandingHistoryTaskDispositionReason | "unavailable" }> |
    Readonly<{ kind: "ready"; intent: StandingHistoryTaskIntent; result: Ready; ticket: StandingIdleHistoryTicket }> |
    Readonly<{ kind: "stalled"; taskRef: string; reason: "cancelled" | "unavailable" | "consumed-without-prepared" | "unbound-attempt" | "source-page-quota" | "source-unavailable" | "prior-owner-unavailable" }> }>;
export type StandingHistoryTaskRunner = Readonly<{
  poll(): Promise<StandingHistoryTaskWork>;
  revoke(taskRef: string): Promise<void>;
  close(): Promise<void>;
}>;
export type StandingHistoryTaskRunnerInput = Readonly<{
  adapter: Readonly<{ pollWork(signal: AbortSignal, options: Readonly<{ backgroundDue: boolean }>): Promise<StandingPollWork> }>;
  directories: Readonly<{ pages: string; control: string; analysis: string; attempts: string; delivery?: string; disposition?: string; reports?: string }>;
  passphrase: string; binding: Readonly<{ accountId: string; peerId: string }>; signal: AbortSignal;
  /** Host-pinned read source; task ownership and delivery remain internal. */
  observedSource?: StandingHistoryTaskObservedSource;
  manager: Pick<StandingHistoryTaskManager, "status">;
  /** prepare must retain conversation restoration until the next observed
   * conversation turn. Background preparation must not consume that latch. */
  connection: StandingHistoryAnalysisStepConnection & Readonly<{ prepare(): Promise<Readonly<{ restoration: boolean }>>;
    prepareAnalysis?(): Promise<Readonly<{ restoration: boolean }>>; concurrentAnalysis?: true }>;
  verifyOwnerSettled(binding: StandingHistoryAnalysisNativeBinding): Promise<StandingHistoryAnalysisOwnerSettlement>;
  /** Only a connection with an independent foreground native worker may opt in. */
  concurrentAnalysis?: true;
  parallel?: StandingHistoryAnalysisParallelOptions & Readonly<{ maintenanceDirectory?: string }>;
  /** Synchronous, non-reentrant host cache notification. Discovery proves
   * purpose and identity only, never task progress or delivery. */
  onDiscovered?(intent: StandingHistoryTaskIntent): void;
  onAnalysisReady?: StandingAnalysisReadyObserver;
  /** Explicit service-owned cache capability; default history behavior unchanged. */
  chronicle?: StandingHistoryAnalysisChronicle;
  /** One bounded host-owned quantum on the existing sole-client ticket.
   * due is sampled synchronously once per background opportunity. step must
   * join its admitted work before settling, including after signal abort. */
  backgroundParticipant?: Readonly<{
    due(): boolean;
    step(ticket: StandingIdleHistoryTicket, signal: AbortSignal): Promise<void>;
  }>;
}>;
export class StandingHistoryTaskRunnerError extends Error {
  constructor(readonly code: "input" | "busy" | "closed" | "aborted" | "adapter" | "discovery" | "step" | "close",
    readonly origin?: "adapter-poll" | "participant-due" | "participant-step", readonly childCode?: string) { super("STANDING_HISTORY_TASK_RUNNER_" + code.toUpperCase()); }
}
export const STANDING_WAIT_CODES = ["input", "busy", "closed", "aborted", "adapter", "discovery", "step", "close", "storage", "binding", "conflict", "capacity", "limit", "consumed", "stale", "cancelled", "owner", "outcome", "settlement", "settlement_unknown", "failed", "community_assessment_timeout", "parallel-consumed-without-prepared", "transport", "protocol", "checkpoint", "backlog", "state", "analysis_admission", "analysis_scope", "prepare_unknown", "controller_unknown", "record", "release_required", "mode", "config", "turn", "stopped", "start_unknown"] as const;
export function standingWaitCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || types.isProxy(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof value === "string" && STANDING_WAIT_CODES.includes(value.toLowerCase() as typeof STANDING_WAIT_CODES[number]) ? value.toLowerCase() : undefined;
}
const fail = (code: StandingHistoryTaskRunnerError["code"]): never => { throw new StandingHistoryTaskRunnerError(code); };
function data(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(ds);
  if (keys.some(k => !Object.hasOwn(ds, k)) || names.some(k => typeof k !== "string" || !keys.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(names.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function method<T>(value: unknown, key: string): T {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail("input");
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail("input");
  return d.value.bind(value) as T;
}

/** One existing adapter and native owner; the runner adds no timer, task
 * creation or model replay. Two foreground/more pulses earn one background
 * opportunity; an idle ticket also permits work. A due host participant and
 * history alternate opportunities, each owning its whole ticket with no
 * fallback after admission. A retained task gets one planner step per
 * opportunity until one read/attempt/recovery/terminal quantum finishes, then
 * the single discovery cursor advances. Scan-more never reopens its planner.
 * Finite store bounds give finite traversal, not a wall-clock fairness promise.
 * One completed, cleanly released analysis workspace may be parked between
 * discovery quanta. The cursor still advances after every attempt; exact same
 * task reuse does not acquire a new model lease or bypass fresh control gates.
 * Admitting another runnable task evicts it; terminal discovery does not.
 * There is no all-task cache.
 * At read-more, retain the same authenticated workspace for at most two
 * additional pages before planning again. Each page consumes a separate ticket
 * and advances discovery; no background source lease overlaps a model turn.
 * The service serializes foreground settlement and other task-data writes.
 * Cancellation may leave an admitted durable page/node; it never undoes it.
 * Ready is host-private delivery input, not a completion/delivery assertion.
 */
export async function openStandingHistoryTaskRunner(value: StandingHistoryTaskRunnerInput): Promise<StandingHistoryTaskRunner> {
  const args = data(value, ["adapter", "directories", "passphrase", "binding", "signal", "manager", "connection", "verifyOwnerSettled"], ["onDiscovered", "onAnalysisReady", "backgroundParticipant", "observedSource", "chronicle", "concurrentAnalysis", "parallel"]);
  if (Object.hasOwn(args, "concurrentAnalysis") && args.concurrentAnalysis !== true) return fail("input");
  const concurrentAnalysis = args.concurrentAnalysis === true;
  if (concurrentAnalysis && (!args.connection || typeof args.connection !== "object" || types.isProxy(args.connection) ||
    Object.getOwnPropertyDescriptor(args.connection, "concurrentAnalysis")?.value !== true)) return fail("input");
  let parallel: StandingHistoryAnalysisParallelOptions | undefined;
  let maintenanceDirectory: string | undefined;
  let acquireParallel: StandingHistoryAnalysisStepConnection["acquireParallelAnalysisAdmissions"];
  let verifyWork: StandingHistoryAnalysisStepConnection["verifyAnalysisWorkReleased"];
  if (Object.hasOwn(args, "parallel")) {
    const p = data(args.parallel, ["directory", "maxLeaves"], ["maintenanceDirectory"]);
    if (!concurrentAnalysis || typeof p.directory !== "string" || !isAbsolute(p.directory) || resolve(p.directory) !== p.directory ||
      !Number.isSafeInteger(p.maxLeaves) || Number(p.maxLeaves) < 2 || Number(p.maxLeaves) > 8) return fail("input");
    parallel = Object.freeze({ directory: p.directory, maxLeaves: Number(p.maxLeaves) });
    if (Object.hasOwn(p, "maintenanceDirectory")) {
      if (typeof p.maintenanceDirectory !== "string" || !isAbsolute(p.maintenanceDirectory) || resolve(p.maintenanceDirectory) !== p.maintenanceDirectory) return fail("input");
      maintenanceDirectory = p.maintenanceDirectory;
    }
    acquireParallel = method<NonNullable<typeof acquireParallel>>(args.connection, "acquireParallelAnalysisAdmissions");
    verifyWork = method<NonNullable<typeof verifyWork>>(args.connection, "verifyAnalysisWorkReleased");
  }
  let chronicle: StandingHistoryAnalysisChronicle | undefined;
  if (Object.hasOwn(args, "chronicle")) {
    const c = data(args.chronicle, ["cache", "producer", "reuseDirectory"], ["periods"]), producer = data(c.producer, ["model", "promptVersion", "projectionVersion", "outputVersion"]);
    if (typeof c.reuseDirectory !== "string" || !isAbsolute(c.reuseDirectory) || resolve(c.reuseDirectory) !== c.reuseDirectory ||
      Object.values(producer).some(v => typeof v !== "string" || !v.trim() || v.includes("\0") || Buffer.byteLength(v) > 256)) return fail("input");
    const cache = Object.freeze({ lookup: method<StandingHistoryAnalysisChronicle["cache"]["lookup"]>(c.cache, "lookup"),
      remember: method<StandingHistoryAnalysisChronicle["cache"]["remember"]>(c.cache, "remember"), catalog: method<StandingHistoryAnalysisChronicle["cache"]["catalog"]>(c.cache, "catalog"),
      close: method<StandingHistoryAnalysisChronicle["cache"]["close"]>(c.cache, "close") });
    let periods: StandingHistoryAnalysisChronicle["periods"];
    if (Object.hasOwn(c, "periods")) {
      const p = data(c.periods, ["store", "workspaceId"]);
      if (typeof p.workspaceId !== "string" || !p.workspaceId.trim() || p.workspaceId.includes("\0") || Buffer.byteLength(p.workspaceId) > 256) return fail("input");
      type Store = NonNullable<StandingHistoryAnalysisChronicle["periods"]>["store"];
      periods = Object.freeze({ workspaceId: p.workspaceId, store: Object.freeze({
        lookup: method<Store["lookup"]>(p.store, "lookup"), remember: method<Store["remember"]>(p.store, "remember"), close: method<Store["close"]>(p.store, "close"),
      }) });
    }
    chronicle = Object.freeze({ cache, producer: Object.freeze(producer) as StandingHistoryAnalysisChronicle["producer"], reuseDirectory: c.reuseDirectory,
      ...(periods ? { periods } : {}) });
  }
  let observedSource: StandingHistoryTaskObservedSource | undefined;
  if (Object.hasOwn(args, "observedSource")) {
    try { observedSource = snapshotStandingHistoryTaskObservedSource(args.observedSource); } catch { return fail("input"); }
  }
  type Participant = NonNullable<StandingHistoryTaskRunnerInput["backgroundParticipant"]>;
  let participant: Participant | undefined;
  if (Object.hasOwn(args, "backgroundParticipant")) {
    const fields = data(args.backgroundParticipant, ["due", "step"]);
    if (types.isAsyncFunction(fields.due) || types.isGeneratorFunction(fields.due) || types.isGeneratorFunction(fields.step)) return fail("input");
    participant = Object.freeze({ due: method<Participant["due"]>(args.backgroundParticipant, "due"),
      step: method<Participant["step"]>(args.backgroundParticipant, "step") });
  }
  if (Object.hasOwn(args, "onDiscovered") && (typeof args.onDiscovered !== "function" || types.isProxy(args.onDiscovered) ||
      types.isAsyncFunction(args.onDiscovered) || types.isGeneratorFunction(args.onDiscovered))) return fail("input");
  const onDiscovered = args.onDiscovered as StandingHistoryTaskRunnerInput["onDiscovered"];
  if (Object.hasOwn(args, "onAnalysisReady") && (typeof args.onAnalysisReady !== "function" || types.isProxy(args.onAnalysisReady) ||
      types.isAsyncFunction(args.onAnalysisReady) || types.isGeneratorFunction(args.onAnalysisReady))) return fail("input");
  const onAnalysisReady = args.onAnalysisReady as StandingAnalysisReadyObserver | undefined;
  const dirs = data(args.directories, ["pages", "control", "analysis", "attempts"], ["delivery", "disposition", "reports"]), bound = data(args.binding, ["accountId", "peerId"]);
  const pollWork = method<StandingHistoryTaskRunnerInput["adapter"]["pollWork"]>(args.adapter, "pollWork");
  const status = method<StandingHistoryTaskManager["status"]>(args.manager, "status");
  const prepare = method<StandingHistoryTaskRunnerInput["connection"]["prepare"]>(args.connection, "prepare");
  const prepareAnalysis = Object.hasOwn(args.connection as object, "prepareAnalysis")
    ? method<StandingHistoryTaskRunnerInput["connection"]["prepare"]>(args.connection, "prepareAnalysis") : prepare;
  const acquire = method<StandingHistoryAnalysisStepConnection["acquireAnalysisAdmission"]>(args.connection, "acquireAnalysisAdmission");
  const verifyOwnerSettled = method<StandingHistoryTaskRunnerInput["verifyOwnerSettled"]>(value, "verifyOwnerSettled");
  for (const path of Object.values(dirs)) if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return fail("input");
  const paths = [...Object.values(dirs), ...(chronicle ? [chronicle.reuseDirectory] : []), ...(parallel ? [parallel.directory] : []), ...(maintenanceDirectory ? [maintenanceDirectory] : [])] as string[];
  for (let i = 0; i < paths.length; i++) for (let j = 0; j < paths.length; j++) if (i !== j) {
    const rel = relative(paths[i]!, paths[j]!); if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) return fail("input");
  }
  if (typeof bound.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(bound.accountId) || typeof bound.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(bound.peerId) ||
      typeof args.passphrase !== "string" || args.passphrase.length < 16 || !args.passphrase.trim() || args.passphrase.includes("\0") || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString("utf8") !== args.passphrase ||
      types.isProxy(args.signal) || !(args.signal instanceof AbortSignal)) return fail("input");
  const directories = Object.freeze(dirs) as StandingHistoryTaskRunnerInput["directories"], signal = args.signal, stop = new AbortController();
  const binding = Object.freeze({ accountId: bound.accountId, peerId: bound.peerId });
  let passphrase = args.passphrase, closed = false, active: Promise<StandingHistoryTaskWork> | undefined, closing: Promise<void> | undefined;
  let cursor: string | undefined, foreground = 0, discovery: StandingHistoryTaskDiscovery | undefined;
  let participantNext = true;
  // Bounded best-effort recall, not an archive inventory. Never repeatedly open
  // the same completed task or grow a per-task set without a connection limit.
  const recalledTasks = new Set<string>();
  const captureReady: StandingAnalysisReadyObserver | undefined = onAnalysisReady ? event => {
    if (recalledTasks.size < 32) recalledTasks.add(event.intent.taskId);
    const returned = onAnalysisReady(event);
    if (types.isPromise(returned)) void Promise.prototype.then.call(returned, undefined, () => {});
  } : undefined;
  type Task = { intent: StandingHistoryTaskIntent; abort: AbortController; signal: AbortSignal; requestRef: string;
    phase: "inspect" | "analysis" | "read"; step?: StandingHistoryAnalysisStep; work?: Promise<StandingHistoryTaskWork>; closing?: Promise<void>;
    sourceHead?: string; readAnalysisHead?: string; readAheadRemaining?: number;
    resumeHeads?: Readonly<{ sourceHead: string; analysisHead: string }> };
  let task: Task | undefined, parked: Task | undefined;
  type InFlight = { owned: Task; work: Promise<StandingHistoryTaskWork>; result?: StandingHistoryTaskWork; error?: unknown; done: boolean; failed: boolean };
  let inFlight: InFlight | undefined;
  const guard = () => { if (closed) return fail("closed"); if (signal.aborted) return fail("aborted"); };
  const unavailableOwners = new Set<string>();
  const shutdown = () => { stop.abort(); task?.abort.abort(); parked?.abort.abort(); inFlight?.owned.abort.abort(); };
  signal.addEventListener("abort", shutdown, { once: true });
  const finish = (owned: Task): Promise<void> => {
    owned.closing ??= (async () => { try { await owned.step?.close(); } finally {
      if (task === owned) task = undefined; if (parked === owned) parked = undefined;
    } })();
    return owned.closing;
  };
  try {
    guard(); discovery = await openStandingHistoryTaskDiscovery({ directory: directories.pages, passphrase, accountId: binding.accountId, chatId: binding.peerId, signal: AbortSignal.any([signal, stop.signal]) }); guard();
  } catch {
    stop.abort(); try { await discovery?.close(); } finally { signal.removeEventListener("abort", shutdown); passphrase = ""; }
    if (signal.aborted) return fail("aborted"); return fail("discovery");
  }
  type Outcome = Extract<StandingHistoryTaskWork, { kind: "background" }>["outcome"];
  const background = (outcome: Outcome): StandingHistoryTaskWork => Object.freeze({ kind: "background", outcome: Object.freeze(outcome) });
  const stalled = (owned: Task, reason: Extract<Outcome, { kind: "stalled" }>["reason"]) => background({ kind: "stalled", taskRef: owned.intent.taskId, reason });
  const sourceAvailable = (intent: StandingHistoryTaskIntent): boolean => !intent.source || !!observedSource &&
    intent.source.kind === observedSource.kind && intent.source.sourceRef === observedSource.sourceRef &&
    intent.source.workspaceId === observedSource.workspaceId && intent.source.peerId === observedSource.peerId;
  const taskStatus = async (owned: Task): Promise<StandingHistoryManagedTaskStatus> => {
    const result = await status({ taskRef: owned.intent.taskId, requesterId: owned.intent.requesterId, signal: owned.signal });
    if (result.taskRef !== owned.intent.taskId) return fail("step"); return result;
  };
  const blockConsumed = async (owned: Task, snapshot: StandingHistoryManagedTaskStatus): Promise<StandingHistoryTaskWork> => {
    guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
    if (snapshot.control.storage !== "ready" || snapshot.read.storage !== "ready" || snapshot.analysis.storage !== "ready" || snapshot.attempts?.storage !== "ready") return stalled(owned, "unavailable");
    if (snapshot.control.state === "cancelled") return stalled(owned, "cancelled");
    const last = snapshot.attempts.last;
    if (!last?.nativeBinding || last.prepared || last.node) return fail("step");
    if (!directories.disposition) return stalled(owned, "consumed-without-prepared");
    // This is a status disposition, never retry authority. The current step's
    // operation and cleanup have joined, or discovery found an already consumed
    // reservation. Preserve UNKNOWN and every original attempt record. Recording
    // the exact heads makes this terminal blockage visible through task status
    // instead of presenting an unchanged queued task as ongoing work forever.
    await recordStandingHistoryTaskDisposition({ directory: directories.disposition, passphrase, intent: owned.intent,
      sourceHead: snapshot.read.readProgress.chainHash, analysisHead: snapshot.analysis.headHash,
      reason: "consumed-without-prepared", signal: owned.signal });
    guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
    return background({ kind: "task-blocked", taskRef: owned.intent.taskId, reason: "consumed-without-prepared" });
  };
  async function quantum(owned: Task, ticket: StandingIdleHistoryTicket): Promise<StandingHistoryTaskWork> {
    let retain = false, parkAfterAttempt = false;
    try {
      if (owned.signal.aborted) return stalled(owned, "cancelled");
      // A persisted task cannot acquire authority from a later workspace or
      // source rebind. Check before delivery recovery, analysis or any lease.
      if (!sourceAvailable(owned.intent)) return stalled(owned, "source-unavailable");
      if ((owned.phase === "inspect" || owned.resumeHeads) && directories.delivery) {
        const delivery = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent: owned.intent, signal: owned.signal });
        guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
        // A newly created delivery slot takes the ordinary cold recovery path.
        if (owned.resumeHeads && (delivery.storage !== "absent" || delivery.consumed)) {
          await owned.step!.close(); delete owned.step; delete owned.resumeHeads; owned.phase = "inspect";
        }
        // A final slot is independent of read/analysis counters. Inspect it
        // before reopening those chains; only an authenticated unclaimed next
        // part can require more delivery work after reservation.
        if ((delivery.storage !== "absent" || delivery.consumed) && !("nextPart" in delivery && typeof delivery.nextPart === "number")) {
          if (captureReady && delivery.storage === "ready" && delivery.consumed &&
              !recalledTasks.has(owned.intent.taskId) && recalledTasks.size < 32) {
            recalledTasks.add(owned.intent.taskId);
            let note: Awaited<ReturnType<typeof readStandingDeliveredChronicleNote>>;
            try {
              note = await readStandingDeliveredChronicleNote({ intent: owned.intent,
                directories: { pages: directories.pages, analysis: directories.analysis, delivery: directories.delivery },
                passphrase, signal: owned.signal });
            } catch (error) {
              // Optional memory may be unavailable, but an unjoined reader is
              // still a resource-settlement failure owned by this runner.
              if (error instanceof StandingHistoryTaskDeliveryError && error.code === "close") throw error;
            }
            guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
            if (note) {
              try { captureReady(Object.freeze({ intent: owned.intent, note })); }
              catch { /* Observer errors cannot become reader cleanup failures. */ }
            }
            guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
          }
          return background({ kind: "delivery-state", taskRef: owned.intent.taskId, state: delivery.delivery });
        }
      }
      if (owned.resumeHeads) {
        if (directories.disposition) {
          const disposition = await readStandingHistoryTaskDisposition({ directory: directories.disposition, passphrase, intent: owned.intent,
            sourceHead: owned.resumeHeads.sourceHead, analysisHead: owned.resumeHeads.analysisHead, signal: owned.signal });
          guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
          const recoverableReport = disposition.storage === "ready" && disposition.disposition.reason === "report-required" && directories.reports &&
            await canContinueStandingHistoryReport({ intent: owned.intent, sourceHead: owned.resumeHeads.sourceHead,
              analysisHead: owned.resumeHeads.analysisHead, directory: directories.reports, passphrase, signal: owned.signal });
          if (disposition.storage !== "absent" && !recoverableReport) return background({ kind: "task-blocked", taskRef: owned.intent.taskId,
            reason: disposition.storage === "ready" ? disposition.disposition.reason : "unavailable" });
        }
        // These heads only select a disposition. Step.next revalidates retained
        // stores and freshly opens control before granting a new admission.
        delete owned.resumeHeads;
      }
      let snapshot: StandingHistoryManagedTaskStatus | undefined;
      if (owned.phase === "inspect") {
        try { snapshot = await taskStatus(owned); } catch { guard(); return stalled(owned, owned.signal.aborted ? "cancelled" : "unavailable"); }
        guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
        if (snapshot.control.storage !== "ready") return stalled(owned, "unavailable");
        if (snapshot.control.state === "cancelled") return stalled(owned, "cancelled");
        if (snapshot.control.storage !== "ready" || snapshot.read.storage !== "ready" || snapshot.analysis.storage !== "ready" || snapshot.attempts?.storage !== "ready") return stalled(owned, "unavailable");
        if (directories.disposition) {
          const disposition = await readStandingHistoryTaskDisposition({ directory: directories.disposition, passphrase, intent: owned.intent,
            sourceHead: snapshot.read.readProgress.chainHash, analysisHead: snapshot.analysis.headHash, signal: owned.signal });
          guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
          const recoverableRefusal = disposition.storage === "ready" && disposition.disposition.reason === "consumed-without-prepared" &&
            canContinueNoOutput(snapshot.attempts.last);
          const recoverableReport = disposition.storage === "ready" && disposition.disposition.reason === "report-required" && directories.reports &&
            await canContinueStandingHistoryReport({ intent: owned.intent, sourceHead: snapshot.read.readProgress.chainHash,
              analysisHead: snapshot.analysis.headHash, directory: directories.reports, passphrase, signal: owned.signal });
          if (disposition.storage !== "absent" && !recoverableRefusal && !recoverableReport) return background({ kind: "task-blocked", taskRef: owned.intent.taskId,
            reason: disposition.storage === "ready" ? disposition.disposition.reason : "unavailable" });
        }
      }
      if (owned.phase === "read") {
        const result = await owned.step!.readSourcePage({ ticket, signal: owned.signal });
        if (result.kind === "committed" && result.read.storage === "ready") {
          owned.sourceHead = result.read.readProgress.chainHash;
          owned.resumeHeads = Object.freeze({ sourceHead: owned.sourceHead, analysisHead: owned.readAnalysisHead! });
          owned.readAheadRemaining = (owned.readAheadRemaining ?? 1) - 1;
          if (owned.readAheadRemaining <= 0 || result.read.readProgress.checkpoint.status !== "more" || result.read.limits.pageQuotaReached) owned.phase = "analysis";
          parkAfterAttempt = true;
        }
        return background({ kind: "read", taskRef: owned.intent.taskId, result });
      }
      if (owned.phase === "inspect") {
        const attempts = snapshot!.attempts!;
        if (attempts.storage !== "ready") return stalled(owned, "unavailable");
        const last = attempts.last;
        if (last && !last.nativeBinding) return stalled(owned, "unbound-attempt");
        const pending = last && (!last.node || !last.modelOutcome) && !canContinueNoOutput(last);
        if (pending && !last.prepared) return await blockConsumed(owned, snapshot!);
        const sourceStatus = snapshot!.read;
        if (sourceStatus.storage !== "ready") return stalled(owned, "unavailable");
        if (parked && parked !== owned) { await finish(parked); guard(); }
        if (owned.signal.aborted) return stalled(owned, "cancelled");
        const generationDirectory = parallel && maintenanceDirectory ? await resolveStandingHistoryParallelMaintenance({ directory: maintenanceDirectory,
          originalJournalDirectory: parallel.directory, intent: owned.intent, passphrase, signal: owned.signal,
          directories: { pages: directories.pages, control: directories.control, analysis: directories.analysis } }) : undefined;
        guard();
        owned.step = await openStandingHistoryAnalysisStep({ intent: owned.intent, directories: { pages: directories.pages, control: directories.control,
          analysis: directories.analysis, attempts: directories.attempts }, passphrase, signal: owned.signal, verifyOwnerSettled,
          retainWorkingState: true,
          packing: "large",
          ...(chronicle ? { chronicle } : {}),
          ...(parallel ? { parallel: { ...parallel, ...(generationDirectory ? { directory: generationDirectory } : {}) } } : {}),
          ...(captureReady ? { onAnalysisReady: captureReady } : {}) });
        owned.sourceHead = sourceStatus.readProgress.chainHash;
        if (pending) {
          const result = await owned.step.recoverPrepared({ attemptRef: last.attemptRef, signal: owned.signal });
          return background({ kind: "recovered", taskRef: owned.intent.taskId, result });
        }
        owned.phase = "analysis";
        if (concurrentAnalysis) {
          retain = true;
          return background({ kind: "analysis-running", taskRef: owned.intent.taskId });
        }
      }
      const prepareBackground = async () => {
        if (owned.signal.aborted) throw new StandingHistoryAnalysisStepError("cancelled");
        const prepared = data(await prepareAnalysis(), ["restoration"]);
        if (typeof prepared.restoration !== "boolean") return fail("step");
        if (owned.signal.aborted) throw new StandingHistoryAnalysisStepError("cancelled");
      };
      const connection: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(requestRef, previous, options) {
        await prepareBackground();
        return acquire(requestRef, previous, options);
      }, ...(acquireParallel && verifyWork ? { async acquireParallelAnalysisAdmissions(refs: readonly string[], previous?: StandingHistoryAnalysisNativeBinding, options?: Readonly<{ requireNewEpoch: true }>) {
        await prepareBackground(); return acquireParallel!(refs, previous, options);
      }, verifyAnalysisWorkReleased: verifyWork } : {}) };
      let result = await owned.step!.next({ requestRef: owned.requestRef, connection, signal: owned.signal });
      // Local planning does not need another Telegram poll or a fresh model turn.
      // Yield between quanta so foreground work and cancellation remain responsive.
      const scanStarted = performance.now();
      for (let scans = 1; result.kind === "scan-more" && scans < 64 && performance.now() - scanStarted < 2000; scans++) {
        await yieldImmediate();
        if (owned.signal.aborted) throw new StandingHistoryAnalysisStepError("cancelled");
        result = await owned.step!.next({ requestRef: owned.requestRef, connection, signal: owned.signal });
      }
      if (result.kind === "attempt" && !result.node && !result.cancelled && directories.disposition) {
        // A completed model turn is not a committed analysis node. Reopen the
        // stores after step cleanup; prepared output must remain recoverable.
        const saved = await taskStatus(owned);
        if (saved.attempts?.storage === "ready" && saved.attempts.last?.attemptRef === result.attemptRef &&
            !saved.attempts.last.prepared && !saved.attempts.last.node && !canContinueNoOutput(saved.attempts.last)) return await blockConsumed(owned, saved);
      }
      if (result.kind === "scan-more") retain = true;
      if (result.kind === "read-more") {
        owned.phase = "read"; owned.readAheadRemaining = READ_AHEAD_PAGES; owned.readAnalysisHead = result.expectedHead; retain = true;
      }
      if (result.kind === "analysis-ready") return background({ kind: "ready", intent: owned.intent, result, ticket });
      if (result.kind === "attempt" && result.modelOutcome === "observed" && result.node &&
          result.release === "acknowledged" && !result.cancelled && owned.sourceHead) {
        owned.resumeHeads = Object.freeze({ sourceHead: owned.sourceHead, analysisHead: result.node.hash });
        parkAfterAttempt = true;
      }
      if (result.kind === "reused" && !result.cancelled && owned.sourceHead) {
        owned.resumeHeads = Object.freeze({ sourceHead: owned.sourceHead, analysisHead: result.node.hash });
        parkAfterAttempt = true;
      }
      if (result.kind === "parallel-wave" && result.node && result.release === "acknowledged" && !result.cancelled && owned.sourceHead) {
        owned.resumeHeads = Object.freeze({ sourceHead: owned.sourceHead, analysisHead: result.node.hash });
        parkAfterAttempt = true;
      }
      return background({ kind: "analysis", taskRef: owned.intent.taskId, result });
    } catch (error) {
      // A persisted cancellation can precede (or outlive) its revoke callback.
      // The step's fresh control read is authoritative even without local abort.
      if (error instanceof StandingHistoryAnalysisStepError && error.code === "cancelled") return stalled(owned, "cancelled");
      if (error instanceof StandingHistoryAnalysisStepError && error.code === "stale") {
        // A changed plan/context is task-local. The finally still closes all
        // owned resources; failed settlement must remain fatal.
        const snapshot = await taskStatus(owned);
        if (owned.signal.aborted) return stalled(owned, "cancelled");
        if (directories.disposition && snapshot.read.storage === "ready" && snapshot.analysis.storage === "ready") {
          await recordStandingHistoryTaskDisposition({ directory: directories.disposition, passphrase, intent: owned.intent,
            sourceHead: snapshot.read.readProgress.chainHash, analysisHead: snapshot.analysis.headHash, reason: "stale", signal: owned.signal });
        }
        return background({ kind: "task-blocked", taskRef: owned.intent.taskId, reason: "stale" });
      }
      if (error instanceof StandingHistoryAnalysisStepError && error.code === "parallel-consumed-without-prepared") return stalled(owned, "consumed-without-prepared");
      if (error && typeof error === "object" && !types.isProxy(error) && Object.getOwnPropertyDescriptor(error, "code")?.value === "PRIOR_OWNER_UNAVAILABLE") {
        unavailableOwners.add(owned.intent.taskId);
        // This is only a bounded connection-local suppression cache. Eviction
        // may recheck evidence; it never bypasses predecessor verification.
        if (unavailableOwners.size > 128) unavailableOwners.delete(unavailableOwners.values().next().value!);
        return stalled(owned, "prior-owner-unavailable");
      }
      throw error;
    } finally {
      // In particular, owner/cleanup errors propagate instead of becoming an
      // ordinary per-task skip; the service must preserve its settlement gate.
      if (!retain || owned.signal.aborted) {
        if (parkAfterAttempt && !owned.signal.aborted && !closed && task === owned && !parked) {
          // Step.next has joined and closed its native lease; only local state remains.
          parked = owned; task = undefined;
        } else await finish(owned);
      }
    }
  }
  async function doBackground(ticket: StandingIdleHistoryTicket, wasIdle: boolean): Promise<StandingHistoryTaskWork> {
    if (inFlight) {
      const pending = inFlight;
      if (!pending.done) return background({ kind: "analysis-running", taskRef: pending.owned.intent.taskId });
      inFlight = undefined;
      if (pending.failed) throw pending.error;
      if (pending.owned.signal.aborted) return stalled(pending.owned, "cancelled");
      const result = pending.result!;
      // The old unused ticket expired while foreground continued. Only the
      // current caller's freshly admitted ticket may deliver a completed task.
      return result.kind === "background" && result.outcome.kind === "ready"
        ? background({ ...result.outcome, ticket }) : result;
    }
    if (!task) {
      let found: StandingHistoryTaskDiscoveryPage;
      try { found = await discovery!.find({ ...(cursor ? { cursor } : {}), limit: 1 }); guard(); } catch { guard(); return fail("discovery"); }
      cursor = found.cursor;
      if (!found.tasks[0]) {
        if (wasIdle && !found.hasMore && !found.coverage.unavailable && !found.coverage.foreign) return Object.freeze({ kind: "idle" });
        return background({ kind: "scan", hasMore: found.hasMore, coverage: found.coverage });
      }
      const intent = snapshotStandingHistoryTaskIntent(found.tasks[0]);
      if (intent.accountId !== binding.accountId || intent.chatId !== binding.peerId) return fail("discovery");
      if (unavailableOwners.has(intent.taskId)) return background({ kind: "stalled", taskRef: intent.taskId, reason: "prior-owner-unavailable" });
      if (parked?.signal.aborted) {
        await finish(parked); guard();
      }
      if (!sourceAvailable(intent)) return background({ kind: "stalled", taskRef: intent.taskId, reason: "source-unavailable" });
      // Terminal delivery skips expensive status-chain reads. Still retain the
      // authenticated purpose for conversation memory without reopening them.
      try { onDiscovered?.(Object.freeze({ ...intent })); } catch { /* Optional memory cannot change task execution. */ }
      guard();
      if (parked && !parked.signal.aborted && JSON.stringify(parked.intent) === JSON.stringify(intent)) {
        task = parked; parked = undefined; task.requestRef = "analysis-" + randomBytes(24).toString("hex");
      } else {
        const abort = new AbortController();
        task = { intent, abort, signal: AbortSignal.any([signal, stop.signal, abort.signal]), requestRef: "analysis-" + randomBytes(24).toString("hex"), phase: "inspect" };
      }
    }
    const owned = task;
    const work = Promise.resolve().then(() => quantum(owned, ticket)); owned.work = work;
    if (concurrentAnalysis && owned.phase === "analysis") {
      const pending: InFlight = { owned, work, done: false, failed: false };
      inFlight = pending;
      void work.then(result => { pending.result = result; }, error => { pending.error = error; pending.failed = true; })
        .finally(() => { pending.done = true; if (owned.work === work) delete owned.work; });
      return background({ kind: "analysis-running", taskRef: owned.intent.taskId });
    }
    try { return await work; } finally { if (owned.work === work) delete owned.work; }
  }
  async function pulse(): Promise<StandingHistoryTaskWork> {
    let result: StandingPollWork;
    try { result = await pollWork(signal, { backgroundDue: foreground >= 2 }); } catch (error) { guard(); throw new StandingHistoryTaskRunnerError("adapter", "adapter-poll", standingWaitCode(error)); }
    // Already admitted selection belongs to this caller even after local close.
    if (result.kind === "selected") { foreground++; return result; }
    guard(); if (result.kind === "more") { foreground++; return result; }
    foreground = 0;
    if (participant) {
      let due: unknown;
      try { due = participant.due(); } catch (error) { guard(); throw new StandingHistoryTaskRunnerError("step", "participant-due", standingWaitCode(error)); }
      // A dishonest synchronous signature cannot admit work or leak an
      // unhandled native Promise rejection. Never await a due decision.
      if (types.isPromise(due)) void Promise.prototype.then.call(due, undefined, () => {});
      guard(); if (typeof due !== "boolean") return fail("step");
      if (due && participantNext) {
        participantNext = false;
        try { await participant.step(result.ticket, stop.signal); } catch (error) { guard(); throw new StandingHistoryTaskRunnerError("step", "participant-step", standingWaitCode(error)); }
        guard(); return background({ kind: "participant" });
      }
      participantNext = true;
    }
    return doBackground(result.ticket, result.kind === "idle");
  }
  return Object.freeze({
    poll() {
      try { guard(); if (active) return fail("busy"); } catch (error) { return Promise.reject(error); }
      const work = Promise.resolve().then(pulse); active = work;
      return work.finally(() => { if (active === work) active = undefined; });
    },
    async revoke(taskRef: string) {
      if (typeof taskRef !== "string" || !/^htask_[0-9a-f]{48}$/u.test(taskRef)) return fail("input");
      const owned = task?.intent.taskId === taskRef ? task : parked?.intent.taskId === taskRef ? parked : inFlight?.owned.intent.taskId === taskRef ? inFlight.owned : undefined;
      if (!owned) return;
      owned.abort.abort();
      try { await owned.work; } catch { /* The active poll retains its error. */ }
      await finish(owned);
    },
    close() {
      if (!closing) {
        closed = true; shutdown();
        closing = (async () => {
          try { await active; } catch { /* Admitted caller retains its outcome. */ }
          finally { try { if (inFlight) { try { await inFlight.work; } catch { /* Saved asynchronous outcome is not replay authority. */ } await finish(inFlight.owned); inFlight = undefined; } }
            finally { try { if (task) await finish(task); } finally { try { if (parked) await finish(parked); }
            finally { try { await discovery!.close(); } finally { recalledTasks.clear(); cursor = undefined; passphrase = ""; signal.removeEventListener("abort", shutdown); } } } }
          }
        })();
      }
      return closing;
    }
  });
}
