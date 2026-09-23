import { isAbsolute, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import type { StandingIdleHistoryTicket, StandingPollWork, StandingSelection } from "./standing-conversation-adapter.js";
import { openStandingHistoryTaskDiscovery, type StandingHistoryTaskDiscovery, type StandingHistoryTaskDiscoveryPage } from "./standing-history-task-discovery.js";
import { openStandingHistoryTaskControlStore, type StandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskObservedSource, type StandingHistoryTaskIntent, type StandingHistoryTaskStore, type StandingHistoryTaskObservedSource } from "./standing-history-task-store.js";
import { runStandingHistoryReadStep, type StandingHistoryReadStepResult } from "./standing-history-read-step.js";

export type StandingHistoryReadWork = Readonly<{ kind: "selected"; selection: StandingSelection } | { kind: "more" } | { kind: "idle" }> |
  Readonly<{ kind: "background"; outcome:
    Readonly<{ kind: "stalled"; taskRef: string; reason: "source-unavailable" }> |
    Readonly<{ kind: "read"; taskRef: string; result: StandingHistoryReadStepResult }> |
    Readonly<{ kind: "scan"; hasMore: boolean; coverage: StandingHistoryTaskDiscoveryPage["coverage"] }> |
    Readonly<{ kind: "skipped"; taskRef: string; reason: "cancelled" | "terminal" | "limit" | "unavailable" }> }>;
export type StandingHistoryReadRunner = Readonly<{
  poll(): Promise<StandingHistoryReadWork>;
  /** Called only after the manager persisted cancellation. Revokes just this
   * task synchronously and joins its preflight/read/commit work, not this poll. */
  revoke(taskRef: string): Promise<void>;
  close(): Promise<void>;
}>;
export type StandingHistoryReadRunnerInput = Readonly<{
  adapter: Readonly<{ pollWork(signal: AbortSignal, options: Readonly<{ backgroundDue: boolean }>): Promise<StandingPollWork> }>;
  directories: Readonly<{ pages: string; control: string }>; passphrase: string;
  binding: Readonly<{ accountId: string; peerId: string }>; signal: AbortSignal; foregroundPulseLimit?: number;
  observedSource?: StandingHistoryTaskObservedSource;
}>;
export class StandingHistoryReadRunnerError extends Error {
  constructor(readonly code: "input" | "busy" | "closed" | "aborted" | "adapter" | "discovery" | "step" | "close") { super("STANDING_HISTORY_READ_RUNNER_" + code.toUpperCase()); }
}
const fail = (code: StandingHistoryReadRunnerError["code"]): never => { throw new StandingHistoryReadRunnerError(code); };
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}

/** Composable service work loop: call poll only after the previous foreground
 * native turn, delivery and release have settled. It calls adapter.pollWork once
 * per pulse. After N selected/more pulses (default 2, provisional host policy),
 * a background opportunity advances one discovery page and at most one read.
 * Existing idle opportunities need no foreground credit. Discovery limit 1 and
 * its incremental cursor retain no all-task or historical seen-ID collection.
 * Each finite traversal offers one page per discovered task before cycling.
 * This is bounded work cadence, not a latency or directory-snapshot guarantee.
 * No model, send or new client is created. Close revokes task work and joins;
 * the service still owns interrupting any borrowed foreground adapter I/O.
 * A selected primary admitted by an outstanding poll is handed to that caller
 * even after local close; the caller owns its normal foreground settlement.
 * Errors are explicit; a failed read step is never retried inside this pulse. */
export async function openStandingHistoryReadRunner(value: StandingHistoryReadRunnerInput): Promise<StandingHistoryReadRunner> {
  const args = data(value, ["adapter", "directories", "passphrase", "binding", "signal"], ["foregroundPulseLimit", "observedSource"]);
  let observedSource: StandingHistoryTaskObservedSource | undefined;
  if (Object.hasOwn(args, "observedSource")) {
    try { observedSource = snapshotStandingHistoryTaskObservedSource(args.observedSource); } catch { return fail("input"); }
  }
  const dirs = data(args.directories, ["pages", "control"]), bound = data(args.binding, ["accountId", "peerId"]);
  if (!args.adapter || typeof args.adapter !== "object" || types.isProxy(args.adapter)) return fail("input");
  const descriptor = Object.getOwnPropertyDescriptor(args.adapter, "pollWork");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || types.isProxy(descriptor.value)) return fail("input");
  const pollWork = descriptor.value as StandingHistoryReadRunnerInput["adapter"]["pollWork"], adapter = args.adapter;
  for (const path of Object.values(dirs)) if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return fail("input");
  const directories = Object.freeze({ pages: dirs.pages as string, control: dirs.control as string });
  for (const [a, b] of [[directories.pages, directories.control], [directories.control, directories.pages]] as const) {
    const rel = relative(a, b); if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) return fail("input");
  }
  if (typeof bound.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(bound.accountId) || typeof bound.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(bound.peerId) ||
      typeof args.passphrase !== "string" || args.passphrase.length < 16 || !args.passphrase.trim() || args.passphrase.includes("\0") || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString("utf8") !== args.passphrase ||
      types.isProxy(args.signal) || !(args.signal instanceof AbortSignal) ||
      Object.hasOwn(args, "foregroundPulseLimit") && (!Number.isInteger(args.foregroundPulseLimit) || Number(args.foregroundPulseLimit) < 1 || Number(args.foregroundPulseLimit) > 8)) return fail("input");
  const signal = args.signal, limit = (args.foregroundPulseLimit as number | undefined) ?? 2;
  const binding = Object.freeze({ accountId: bound.accountId, peerId: bound.peerId }), stop = new AbortController();
  let passphrase = args.passphrase, closed = false, active: Promise<StandingHistoryReadWork> | undefined, closing: Promise<void> | undefined;
  let cursor: string | undefined, foreground = 0, discovery: StandingHistoryTaskDiscovery | undefined;
  let task: { taskRef: string; abort: AbortController; settled: Promise<void> } | undefined;
  const guard = () => { if (closed) return fail("closed"); if (signal.aborted) return fail("aborted"); };
  const shutdown = () => { stop.abort(); task?.abort.abort(); };
  signal.addEventListener("abort", shutdown, { once: true });
  try {
    guard(); discovery = await openStandingHistoryTaskDiscovery({ directory: directories.pages, passphrase, accountId: binding.accountId, chatId: binding.peerId,
      signal: AbortSignal.any([signal, stop.signal]) }); guard();
  } catch {
    stop.abort(); try { await discovery?.close(); } finally { signal.removeEventListener("abort", shutdown); passphrase = ""; }
    if (signal.aborted) return fail("aborted"); return fail("discovery");
  }
  const skipped = (taskRef: string, reason: "cancelled" | "terminal" | "limit" | "unavailable"): StandingHistoryReadWork =>
    Object.freeze({ kind: "background", outcome: Object.freeze({ kind: "skipped", taskRef, reason }) });
  async function readTask(intent: StandingHistoryTaskIntent, ticket: StandingIdleHistoryTicket): Promise<StandingHistoryReadWork> {
    const source = intent.source;
    if (source && (!observedSource || source.kind !== observedSource.kind || source.sourceRef !== observedSource.sourceRef ||
        source.workspaceId !== observedSource.workspaceId || source.peerId !== observedSource.peerId)) {
      return Object.freeze({ kind: "background", outcome: Object.freeze({ kind: "stalled", taskRef: intent.taskId, reason: "source-unavailable" }) });
    }
    let settled!: () => void;
    const owned = { taskRef: intent.taskId, abort: new AbortController(), settled: new Promise<void>(resolveDone => { settled = resolveDone; }) };
    // Bind revocation before any task store is opened or awaited.
    task = owned;
    const taskSignal = AbortSignal.any([signal, stop.signal, owned.abort.signal]);
    let control: StandingHistoryTaskControlStore | undefined, pages: StandingHistoryTaskStore | undefined;
    const closeStores = async () => {
      const stores = [control, pages]; control = undefined; pages = undefined;
      const result = await Promise.allSettled(stores.map(store => store?.close()));
      if (result.some(v => v.status === "rejected")) return fail("close");
    };
    try {
      let expectedControlHead: string, expectedSourceHead: string;
      try {
        control = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open", signal: taskSignal });
        const state = await control.status(); guard();
        if (owned.abort.signal.aborted || state.state === "cancelled" && state.storage === "ready") return skipped(intent.taskId, "cancelled");
        if (state.storage !== "ready") return skipped(intent.taskId, "unavailable");
        expectedControlHead = state.headHash;
        pages = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open", signal: taskSignal });
        const read = await pages.status(); guard();
        if (owned.abort.signal.aborted) return skipped(intent.taskId, "cancelled");
        if (read.storage !== "ready") return skipped(intent.taskId, "unavailable");
        if (read.readProgress.checkpoint.status !== "more") return skipped(intent.taskId, "terminal");
        if (read.limits.pageQuotaReached) return skipped(intent.taskId, "limit");
        expectedSourceHead = read.readProgress.chainHash;
      } catch { guard(); return skipped(intent.taskId, owned.abort.signal.aborted ? "cancelled" : "unavailable"); }
      await closeStores(); guard();
      if (owned.abort.signal.aborted) return skipped(intent.taskId, "cancelled");
      try {
        const result = await runStandingHistoryReadStep({ intent, directories, passphrase, ticket, expectedSourceHead, expectedControlHead, signal: taskSignal });
        guard(); return Object.freeze({ kind: "background", outcome: Object.freeze({ kind: "read", taskRef: intent.taskId, result }) });
      } catch { guard(); return fail("step"); }
    } finally {
      try { await closeStores(); } finally { if (task === owned) task = undefined; settled(); }
    }
  }
  async function background(ticket: StandingIdleHistoryTicket, wasIdle: boolean): Promise<StandingHistoryReadWork> {
    let found: StandingHistoryTaskDiscoveryPage;
    try { found = await discovery!.find({ ...(cursor ? { cursor } : {}), limit: 1 }); guard(); }
    catch { guard(); return fail("discovery"); }
    cursor = found.cursor;
    const candidate = found.tasks[0];
    if (!candidate) {
      if (wasIdle && !found.hasMore && found.coverage.unavailable === 0 && found.coverage.foreign === 0) return Object.freeze({ kind: "idle" });
      return Object.freeze({ kind: "background", outcome: Object.freeze({ kind: "scan", hasMore: found.hasMore, coverage: found.coverage }) });
    }
    const intent = snapshotStandingHistoryTaskIntent(candidate);
    if (intent.accountId !== binding.accountId || intent.chatId !== binding.peerId) return fail("discovery");
    return readTask(intent, ticket);
  }
  async function pulse(): Promise<StandingHistoryReadWork> {
    let result: StandingPollWork;
    try { result = await Reflect.apply(pollWork, adapter, [signal, { backgroundDue: foreground >= limit }]); }
    catch { guard(); return fail("adapter"); }
    // Adapter selection already persisted the primary and owns a live lease.
    // Local runner closure cannot discard that admitted foreground handoff.
    if (result.kind === "selected") { foreground++; return result; }
    guard();
    if (result.kind === "more") { foreground++; return result; }
    foreground = 0;
    return background(result.ticket, result.kind === "idle");
  }
  return Object.freeze({
    poll(): Promise<StandingHistoryReadWork> {
      try { guard(); if (active) return fail("busy"); } catch (error) { return Promise.reject(error); }
      const work = Promise.resolve().then(pulse); active = work;
      return work.finally(() => { if (active === work) active = undefined; });
    },
    revoke(taskRef: string): Promise<void> {
      if (typeof taskRef !== "string" || !/^htask_[0-9a-f]{48}$/u.test(taskRef)) return Promise.reject(new StandingHistoryReadRunnerError("input"));
      const current = task;
      if (!current || current.taskRef !== taskRef) return Promise.resolve();
      current.abort.abort(); return current.settled;
    },
    close(): Promise<void> {
      if (!closing) {
        closed = true; shutdown();
        closing = (async () => { try { await active; } catch { /* The admitted caller retains its outcome. */ }
          finally { try { await discovery!.close(); } finally { cursor = undefined; passphrase = ""; signal.removeEventListener("abort", shutdown); } } })();
      }
      return closing;
    },
  });
}
