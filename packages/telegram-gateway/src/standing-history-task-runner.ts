import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import type { StandingIdleHistoryTicket, StandingPollWork, StandingSelection } from "./standing-conversation-adapter.js";
import { openStandingHistoryTaskDiscovery, type StandingHistoryTaskDiscovery, type StandingHistoryTaskDiscoveryPage } from "./standing-history-task-discovery.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import type { StandingHistoryTaskManager, StandingHistoryManagedTaskStatus } from "./standing-history-task-manager.js";
import { runStandingHistoryReadStep, type StandingHistoryReadStepResult } from "./standing-history-read-step.js";
import { openStandingHistoryAnalysisStep, StandingHistoryAnalysisStepError, type StandingHistoryAnalysisStep, type StandingHistoryAnalysisStepConnection, type StandingHistoryAnalysisOwnerSettlement, type StandingHistoryAnalysisStepResult } from "./standing-history-analysis-step.js";
import type { StandingHistoryAnalysisNativeBinding } from "./standing-history-analysis-attempt-store.js";
import { readStandingHistoryTaskDelivery, readStandingDeliveredChronicleNote, StandingHistoryTaskDeliveryError } from "./standing-history-task-delivery.js";
import { readStandingHistoryTaskDisposition, type StandingHistoryTaskDispositionReason } from "./standing-history-task-disposition.js";
import type { StandingAnalysisReadyObserver } from "./standing-history-analysis-step.js";

type Recovery = Awaited<ReturnType<StandingHistoryAnalysisStep["recoverPrepared"]>>;
type Ready = Extract<StandingHistoryAnalysisStepResult, { kind: "analysis-ready" }>;
export type StandingHistoryTaskWork = Readonly<{ kind: "selected"; selection: StandingSelection } | { kind: "more" } | { kind: "idle" }> |
  Readonly<{ kind: "background"; outcome:
    Readonly<{ kind: "scan"; hasMore: boolean; coverage: StandingHistoryTaskDiscoveryPage["coverage"] }> |
    Readonly<{ kind: "read"; taskRef: string; result: StandingHistoryReadStepResult }> |
    Readonly<{ kind: "analysis"; taskRef: string; result: Exclude<StandingHistoryAnalysisStepResult, Ready> }> |
    Readonly<{ kind: "recovered"; taskRef: string; result: Recovery }> |
    Readonly<{ kind: "delivery-state"; taskRef: string; state: string }> |
    Readonly<{ kind: "task-blocked"; taskRef: string; reason: StandingHistoryTaskDispositionReason | "unavailable" }> |
    Readonly<{ kind: "ready"; intent: StandingHistoryTaskIntent; result: Ready; ticket: StandingIdleHistoryTicket }> |
    Readonly<{ kind: "stalled"; taskRef: string; reason: "cancelled" | "unavailable" | "consumed-without-prepared" | "unbound-attempt" | "source-page-quota" }> }>;
export type StandingHistoryTaskRunner = Readonly<{
  poll(): Promise<StandingHistoryTaskWork>;
  revoke(taskRef: string): Promise<void>;
  close(): Promise<void>;
}>;
export type StandingHistoryTaskRunnerInput = Readonly<{
  adapter: Readonly<{ pollWork(signal: AbortSignal, options: Readonly<{ backgroundDue: boolean }>): Promise<StandingPollWork> }>;
  directories: Readonly<{ pages: string; control: string; analysis: string; attempts: string; delivery?: string; disposition?: string }>;
  passphrase: string; binding: Readonly<{ accountId: string; peerId: string }>; signal: AbortSignal;
  manager: Pick<StandingHistoryTaskManager, "status">;
  /** prepare must retain conversation restoration until the next observed
   * conversation turn. Background preparation must not consume that latch. */
  connection: StandingHistoryAnalysisStepConnection & Readonly<{ prepare(): Promise<Readonly<{ restoration: boolean }>> }>;
  verifyOwnerSettled(binding: StandingHistoryAnalysisNativeBinding): Promise<StandingHistoryAnalysisOwnerSettlement>;
  /** Synchronous, non-reentrant host cache notification. Discovery proves
   * purpose and identity only, never task progress or delivery. */
  onDiscovered?(intent: StandingHistoryTaskIntent): void;
  onAnalysisReady?: StandingAnalysisReadyObserver;
}>;
export class StandingHistoryTaskRunnerError extends Error {
  constructor(readonly code: "input" | "busy" | "closed" | "aborted" | "adapter" | "discovery" | "step" | "close") { super("STANDING_HISTORY_TASK_RUNNER_" + code.toUpperCase()); }
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

/** One existing adapter and native owner; no send, timer, task creation or
 * model replay. Two foreground/more pulses earn one background opportunity;
 * an idle ticket also permits work. A retained task gets one planner step per
 * opportunity until one read/attempt/recovery/terminal quantum finishes, then
 * the single discovery cursor advances. Scan-more never reopens its planner.
 * Finite store bounds give finite traversal, not a wall-clock fairness promise.
 * Only one task's bounded planner metadata is retained, never an all-task map.
 * The service serializes foreground settlement and other task-data writes.
 * Cancellation may leave an admitted durable page/node; it never undoes it.
 * Ready is host-private delivery input, not a completion/delivery assertion.
 */
export async function openStandingHistoryTaskRunner(value: StandingHistoryTaskRunnerInput): Promise<StandingHistoryTaskRunner> {
  const args = data(value, ["adapter", "directories", "passphrase", "binding", "signal", "manager", "connection", "verifyOwnerSettled"], ["onDiscovered", "onAnalysisReady"]);
  if (Object.hasOwn(args, "onDiscovered") && (typeof args.onDiscovered !== "function" || types.isProxy(args.onDiscovered) ||
      types.isAsyncFunction(args.onDiscovered) || types.isGeneratorFunction(args.onDiscovered))) return fail("input");
  const onDiscovered = args.onDiscovered as StandingHistoryTaskRunnerInput["onDiscovered"];
  if (Object.hasOwn(args, "onAnalysisReady") && (typeof args.onAnalysisReady !== "function" || types.isProxy(args.onAnalysisReady) ||
      types.isAsyncFunction(args.onAnalysisReady) || types.isGeneratorFunction(args.onAnalysisReady))) return fail("input");
  const onAnalysisReady = args.onAnalysisReady as StandingAnalysisReadyObserver | undefined;
  const dirs = data(args.directories, ["pages", "control", "analysis", "attempts"], ["delivery", "disposition"]), bound = data(args.binding, ["accountId", "peerId"]);
  const pollWork = method<StandingHistoryTaskRunnerInput["adapter"]["pollWork"]>(args.adapter, "pollWork");
  const status = method<StandingHistoryTaskManager["status"]>(args.manager, "status");
  const prepare = method<StandingHistoryTaskRunnerInput["connection"]["prepare"]>(args.connection, "prepare");
  const acquire = method<StandingHistoryAnalysisStepConnection["acquireAnalysisAdmission"]>(args.connection, "acquireAnalysisAdmission");
  const verifyOwnerSettled = method<StandingHistoryTaskRunnerInput["verifyOwnerSettled"]>(value, "verifyOwnerSettled");
  for (const path of Object.values(dirs)) if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return fail("input");
  const paths = Object.values(dirs) as string[];
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
  // Bounded best-effort recall, not an archive inventory. Never repeatedly open
  // the same completed task or grow a per-task set without a connection limit.
  const recalledTasks = new Set<string>();
  const captureReady: StandingAnalysisReadyObserver | undefined = onAnalysisReady ? event => {
    if (recalledTasks.size < 32) recalledTasks.add(event.intent.taskId);
    const returned = onAnalysisReady(event);
    if (types.isPromise(returned)) void Promise.prototype.then.call(returned, undefined, () => {});
  } : undefined;
  type Task = { intent: StandingHistoryTaskIntent; abort: AbortController; signal: AbortSignal; requestRef: string;
    phase: "inspect" | "analysis" | "read"; step?: StandingHistoryAnalysisStep; work?: Promise<StandingHistoryTaskWork>; closing?: Promise<void> };
  let task: Task | undefined;
  const guard = () => { if (closed) return fail("closed"); if (signal.aborted) return fail("aborted"); };
  const shutdown = () => { stop.abort(); task?.abort.abort(); };
  signal.addEventListener("abort", shutdown, { once: true });
  const finish = (owned: Task): Promise<void> => {
    owned.closing ??= (async () => { try { await owned.step?.close(); } finally { if (task === owned) task = undefined; } })();
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
  const taskStatus = async (owned: Task): Promise<StandingHistoryManagedTaskStatus> => {
    const result = await status({ taskRef: owned.intent.taskId, requesterId: owned.intent.requesterId, signal: owned.signal });
    if (result.taskRef !== owned.intent.taskId) return fail("step"); return result;
  };
  async function quantum(owned: Task, ticket: StandingIdleHistoryTicket): Promise<StandingHistoryTaskWork> {
    let retain = false;
    try {
      if (owned.signal.aborted) return stalled(owned, "cancelled");
      if (owned.phase === "inspect" && directories.delivery) {
        const delivery = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent: owned.intent, signal: owned.signal });
        guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
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
      let snapshot: StandingHistoryManagedTaskStatus | undefined;
      if (owned.phase !== "analysis") {
        try { snapshot = await taskStatus(owned); } catch { guard(); return stalled(owned, owned.signal.aborted ? "cancelled" : "unavailable"); }
        guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
        if (snapshot.control.storage !== "ready") return stalled(owned, "unavailable");
        if (snapshot.control.state === "cancelled") return stalled(owned, "cancelled");
        if (snapshot.control.storage !== "ready" || snapshot.read.storage !== "ready" || snapshot.analysis.storage !== "ready" || snapshot.attempts?.storage !== "ready") return stalled(owned, "unavailable");
        if (directories.disposition) {
          const disposition = await readStandingHistoryTaskDisposition({ directory: directories.disposition, passphrase, intent: owned.intent,
            sourceHead: snapshot.read.readProgress.chainHash, analysisHead: snapshot.analysis.headHash, signal: owned.signal });
          guard(); if (owned.signal.aborted) return stalled(owned, "cancelled");
          if (disposition.storage !== "absent") return background({ kind: "task-blocked", taskRef: owned.intent.taskId,
            reason: disposition.storage === "ready" ? disposition.disposition.reason : "unavailable" });
        }
      }
      if (owned.phase === "read") {
        const s = snapshot!;
        if (s.read.storage !== "ready") return stalled(owned, "unavailable");
        if (s.read.limits.pageQuotaReached) return stalled(owned, "source-page-quota");
        const result = await runStandingHistoryReadStep({ intent: owned.intent, directories: { pages: directories.pages, control: directories.control }, passphrase, ticket,
          expectedSourceHead: s.read.readProgress.chainHash, expectedControlHead: s.control.headHash, signal: owned.signal });
        return background({ kind: "read", taskRef: owned.intent.taskId, result });
      }
      if (owned.phase === "inspect") {
        const attempts = snapshot!.attempts!;
        if (attempts.storage !== "ready") return stalled(owned, "unavailable");
        const last = attempts.last;
        if (last && !last.nativeBinding) return stalled(owned, "unbound-attempt");
        const pending = last && (!last.node || !last.modelOutcome);
        if (pending && !last.prepared) return stalled(owned, "consumed-without-prepared");
        owned.step = await openStandingHistoryAnalysisStep({ intent: owned.intent, directories: { pages: directories.pages, control: directories.control,
          analysis: directories.analysis, attempts: directories.attempts }, passphrase, signal: owned.signal, verifyOwnerSettled,
          ...(captureReady ? { onAnalysisReady: captureReady } : {}) });
        if (pending) {
          const result = await owned.step.recoverPrepared({ attemptRef: last.attemptRef, signal: owned.signal });
          return background({ kind: "recovered", taskRef: owned.intent.taskId, result });
        }
        owned.phase = "analysis";
      }
      const connection: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(requestRef, previous) {
        if (owned.signal.aborted) throw new StandingHistoryAnalysisStepError("cancelled");
        const prepared = data(await prepare(), ["restoration"]);
        if (typeof prepared.restoration !== "boolean") return fail("step");
        if (owned.signal.aborted) throw new StandingHistoryAnalysisStepError("cancelled");
        return acquire(requestRef, previous);
      } };
      const result = await owned.step!.next({ requestRef: owned.requestRef, connection, signal: owned.signal });
      if (result.kind === "scan-more") retain = true;
      if (result.kind === "read-more") { await owned.step!.close(); delete owned.step; owned.phase = "read"; retain = true; }
      if (result.kind === "analysis-ready") return background({ kind: "ready", intent: owned.intent, result, ticket });
      return background({ kind: "analysis", taskRef: owned.intent.taskId, result });
    } catch (error) {
      if (owned.abort.signal.aborted && error instanceof StandingHistoryAnalysisStepError && error.code === "cancelled") return stalled(owned, "cancelled");
      throw error;
    } finally {
      // In particular, owner/cleanup errors propagate instead of becoming an
      // ordinary per-task skip; the service must preserve its settlement gate.
      if (!retain || owned.signal.aborted) await finish(owned);
    }
  }
  async function doBackground(ticket: StandingIdleHistoryTicket, wasIdle: boolean): Promise<StandingHistoryTaskWork> {
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
      // Terminal delivery skips expensive status-chain reads. Still retain the
      // authenticated purpose for conversation memory without reopening them.
      try { onDiscovered?.(Object.freeze({ ...intent })); } catch { /* Optional memory cannot change task execution. */ }
      guard();
      const abort = new AbortController();
      task = { intent, abort, signal: AbortSignal.any([signal, stop.signal, abort.signal]), requestRef: "analysis-" + randomBytes(24).toString("hex"), phase: "inspect" };
    }
    const owned = task;
    const work = Promise.resolve().then(() => quantum(owned, ticket)); owned.work = work;
    try { return await work; } finally { if (owned.work === work) delete owned.work; }
  }
  async function pulse(): Promise<StandingHistoryTaskWork> {
    let result: StandingPollWork;
    try { result = await pollWork(signal, { backgroundDue: foreground >= 2 }); } catch { guard(); return fail("adapter"); }
    // Already admitted selection belongs to this caller even after local close.
    if (result.kind === "selected") { foreground++; return result; }
    guard(); if (result.kind === "more") { foreground++; return result; }
    foreground = 0; return doBackground(result.ticket, result.kind === "idle");
  }
  return Object.freeze({
    poll() {
      try { guard(); if (active) return fail("busy"); } catch (error) { return Promise.reject(error); }
      const work = Promise.resolve().then(pulse); active = work;
      return work.finally(() => { if (active === work) active = undefined; });
    },
    async revoke(taskRef: string) {
      if (typeof taskRef !== "string" || !/^htask_[0-9a-f]{48}$/u.test(taskRef)) return fail("input");
      const owned = task; if (!owned || owned.intent.taskId !== taskRef) return;
      owned.abort.abort();
      try { await owned.work; } catch { /* The active poll retains its error. */ }
      await finish(owned);
    },
    close() {
      if (!closing) {
        closed = true; shutdown();
        closing = (async () => {
          try { await active; } catch { /* Admitted caller retains its outcome. */ }
          finally { try { if (task) await finish(task); } finally { try { await discovery!.close(); } finally { recalledTasks.clear(); cursor = undefined; passphrase = ""; signal.removeEventListener("abort", shutdown); } } }
        })();
      }
      return closing;
    }
  });
}
