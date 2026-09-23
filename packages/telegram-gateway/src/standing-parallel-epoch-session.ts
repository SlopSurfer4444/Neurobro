import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { EpochSessionError, type EpochClose, type EpochWire } from "./standing-epoch-session.js";
import { EpochWireTimeout } from "./standing-epoch-wire.js";
import { createStandingMultiplexEpochWire, type StandingPoolWorkBinding } from "./standing-multiplex-epoch-wire.js";
import { openStandingScopedEpochSession, type StandingParallelWorkerPurpose, type StandingToolResultSent } from "./standing-scoped-epoch-session.js";
import type { EpochExtraTool } from "./standing-tool-dispatcher.js";
import type { StandingVisualInput } from "./standing-visual-input.js";

type WorkerSession = Awaited<ReturnType<typeof openStandingScopedEpochSession>>;
export type StandingParallelCustodyChild = Readonly<{
  workerId: string; processId: number; purpose: StandingParallelWorkerPurpose; custody: unknown; capabilities: unknown;
}>;
export type StandingParallelToolResultSent = StandingToolResultSent & Readonly<{ workerId: string }>;
export type StandingParallelSessionClose = EpochClose & Readonly<{
  workers: readonly Readonly<{ workerId: string; close: EpochClose }>[];
  /** Outer frame shape only is checked here. Its receipt is NOT a settlement
   * proof until the process owner validates it against actual final records. */
  poolClosed: Readonly<{ kind: "poolClosed"; protocol: "standing-parallel-epoch-v1"; code: string; receipt: unknown }>;
}>;
const fail = (code: EpochSessionError["code"] = "protocol"): never => { throw new EpochSessionError(code); };
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v);
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || Object.getPrototypeOf(v) !== Object.prototype) return fail();
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(ds).length !== keys.length || keys.some(k => !ds[k] || !("value" in ds[k]!) || !ds[k]!.enumerable)) return fail();
  return Object.fromEntries(keys.map(k => [k, ds[k]!.value]));
}
function array(v: unknown, count: number): readonly unknown[] {
  if (types.isProxy(v) || !Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length !== count || Reflect.ownKeys(v).length !== count + 1) return fail();
  return Array.from({ length: count }, (_, i) => { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d || !("value" in d) || !d.enumerable) return fail(); return d.value as unknown; });
}
function workBinding(v: unknown): StandingPoolWorkBinding {
  const work = record(v, ["taskRef", "planRef", "workRef"]);
  if (!identifier(work.taskRef) || !identifier(work.planRef) || !identifier(work.workRef)) return fail("state");
  return Object.freeze({ taskRef: work.taskRef, planRef: work.planRef, workRef: work.workRef });
}
function method<T extends (...args: never[]) => unknown>(value: unknown, name: string): T {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail("state");
  const d = Object.getOwnPropertyDescriptor(value, name);
  if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail("state");
  return d.value.bind(value) as T;
}
function toolsSnapshot(value: unknown): readonly EpochExtraTool[] {
  if (types.isProxy(value) || !Array.isArray(value) || value.length > 32) return fail("state");
  return Object.freeze(array(value, value.length).map(entry => {
    const tool = record(entry, ["name", "call"]);
    if (typeof tool.name !== "string" || typeof tool.call !== "function" || types.isProxy(tool.call)) return fail("state");
    return Object.freeze({ name: tool.name, call: tool.call as EpochExtraTool["call"] });
  }));
}

/** Concrete parallel session over one already-owned wire. Custody children must
 * come from the owner's authenticated gate. This matches poolReady to that
 * exact identity set, then shares the real scoped consumer/dispatcher/image
 * implementation across independent worker ports. No aggregate admission or
 * process settlement is inferred from local counters or the raw pool receipt.
 */
export async function openStandingParallelEpochSession(input: {
  epochId: string; wire: EpochWire; signal: AbortSignal; custodyReady(): boolean; clock?: () => number;
  sessionMode?: "standing-parallel-epoch-v1";
  custodyChildren: readonly StandingParallelCustodyChild[];
  parallelOptions: Readonly<{ analysisWorkers: number; communityAssessment: boolean }>;
  conversation: Readonly<{ history: Readonly<{ call(argumentsValue: unknown): Promise<unknown> }>; extraTools?: readonly EpochExtraTool[] }>;
  /** Shared callbacks route through the globally unique requestRef. */
  analysisTools: readonly EpochExtraTool[];
  onToolResultSent(event: StandingParallelToolResultSent): Promise<void> | void;
}) {
  if (!input || typeof input !== "object" || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail("state");
  const required = ["epochId", "wire", "signal", "custodyReady", "custodyChildren", "parallelOptions", "conversation", "analysisTools", "onToolResultSent"];
  const optional = ["clock", "sessionMode"].filter(key => Object.hasOwn(input, key));
  input = record(input, [...required, ...optional]) as typeof input;
  if (typeof input.epochId !== "string" || !/^[a-f0-9]{32}$/u.test(input.epochId) ||
      input.sessionMode !== undefined && input.sessionMode !== "standing-parallel-epoch-v1" || types.isProxy(input.signal) ||
      !(input.signal instanceof AbortSignal) || input.signal.aborted || typeof input.custodyReady !== "function" || types.isProxy(input.custodyReady) ||
      input.custodyReady() !== true || typeof input.onToolResultSent !== "function" || types.isProxy(input.onToolResultSent) ||
      input.clock !== undefined && (typeof input.clock !== "function" || types.isProxy(input.clock))) return fail("state");
  const options = record(input.parallelOptions, ["analysisWorkers", "communityAssessment"]);
  if (!Number.isSafeInteger(options.analysisWorkers) || (options.analysisWorkers as number) < 1 || typeof options.communityAssessment !== "boolean") return fail("state");
  const count = 1 + (options.analysisWorkers as number) + Number(options.communityAssessment);
  if (count > 8) return fail("state");
  const children = Object.freeze(array(input.custodyChildren, count).map(value => {
    const c = record(value, ["workerId", "processId", "purpose", "custody", "capabilities"]);
    if (!identifier(c.workerId) || !Number.isSafeInteger(c.processId) || (c.processId as number) <= 0 ||
        !["conversation", "history-analysis", "community-assessment"].includes(c.purpose as string)) return fail("state");
    return Object.freeze({ workerId: c.workerId, processId: c.processId as number, purpose: c.purpose as StandingParallelWorkerPurpose });
  }));
  if (new Set(children.map(c => c.workerId)).size !== count || new Set(children.map(c => c.processId)).size !== count ||
      children.filter(c => c.purpose === "conversation").length !== 1 || children.filter(c => c.purpose === "history-analysis").length !== options.analysisWorkers ||
      children.filter(c => c.purpose === "community-assessment").length !== Number(options.communityAssessment)) return fail("state");
  if (!input.conversation || typeof input.conversation !== "object" || types.isProxy(input.conversation)) return fail("state");
  const conversationInput = record(input.conversation, ["history", ...(Object.hasOwn(input.conversation, "extraTools") ? ["extraTools"] : [])]);
  const conversation = Object.freeze({ history: Object.freeze({ call: method<(argumentsValue: unknown) => Promise<unknown>>(conversationInput.history, "call") }),
    ...(conversationInput.extraTools === undefined ? {} : { extraTools: toolsSnapshot(conversationInput.extraTools) }) });
  const analysisTools = toolsSnapshot(input.analysisTools);
  const clock = input.clock ?? (() => performance.now()), started = clock();
  if (!Number.isFinite(started)) return fail("state");
  const wire = { send: method<EpochWire["send"]>(input.wire, "send"), receive: method<EpochWire["receive"]>(input.wire, "receive") }, custody = input.custodyReady.bind(input);
  const shown = input.onToolResultSent.bind(input), epochId = input.epochId, signal = input.signal;
  const remaining = (end: number) => { const ms = end - clock(); if (!Number.isFinite(ms) || ms <= 0) return fail("deadline"); return Math.ceil(ms); };
  const readyEnd = started + 120000;
  try {
    let value: unknown;
    for (;;) { try { value = await wire.receive(Math.min(1000, remaining(readyEnd))); break; } catch (error) { if (!(error instanceof EpochWireTimeout) || error.direction !== "read") throw error; } }
    const ready = record(value, ["kind", "protocol", "workers"]);
    if (ready.kind !== "poolReady" || ready.protocol !== "standing-parallel-epoch-v1" || signal.aborted || custody() !== true) return fail();
    const seen = new Set<string>();
    for (const value of array(ready.workers, count)) {
      const worker = record(value, ["workerId", "purpose"]), expected = children.find(c => c.workerId === worker.workerId);
      if (!expected || seen.has(expected.workerId) || worker.purpose !== expected.purpose) return fail();
      seen.add(expected.workerId);
    }
  } catch (error) { await wire.send({ kind: "close" }, 10000).catch(() => {}); throw error; }

  // Owner revocation must stop admissions while leaving the reader alive long
  // enough to drain final worker/pool receipts and hand it back after poolClosed.
  const muxControl = new AbortController(), mux = createStandingMultiplexEpochWire({ wire, workerIds: children.map(c => c.workerId), signal: muxControl.signal });
  const sessions = new Map<string, WorkerSession>(), requests = new Set<string>();
  const work = new Map<string, Readonly<{ requestRef: string; binding: StandingPoolWorkBinding }>>();
  let closing: Promise<StandingParallelSessionClose> | undefined, peerEnded = false, ready = false;
  let finishOpening!: () => void;
  const openingJoined = new Promise<void>(resolve => { finishOpening = resolve; });
  const close = (options?: Readonly<{ peerEnded?: boolean }>): Promise<StandingParallelSessionClose> => {
    if (options?.peerEnded === true) peerEnded = true;
    return closing ??= Promise.resolve().then(async () => {
      const end = clock() + 35000;
      try {
        const sent = peerEnded ? Promise.resolve() : mux.requestPoolClose(Math.min(10000, remaining(end)));
        // Install rejection handling immediately while opening tasks finish.
        void sent.catch(() => {});
        await openingJoined;
        const closedWorkers = [...sessions].map(async ([workerId, session]) => Object.freeze({ workerId, close: await session.close({ peerEnded: true }) }));
        const outer = mux.receivePoolClosed(remaining(end));
        const joined = await Promise.allSettled([sent, ...closedWorkers, outer]);
        const failed = joined.find((entry): entry is PromiseRejectedResult => entry.status === "rejected"); if (failed) throw failed.reason;
        if (sessions.size !== count) return fail("unknown");
        const workers = Object.freeze(await Promise.all(closedWorkers));
        const value = record(await outer, ["kind", "protocol", "code", "receipt"]);
        if (value.kind !== "poolClosed" || value.protocol !== "standing-parallel-epoch-v1" || typeof value.code !== "string" || !identifier(value.code)) return fail();
        const poolClosed = Object.freeze({ kind: "poolClosed" as const, protocol: "standing-parallel-epoch-v1" as const, code: value.code, receipt: value.receipt });
        return Object.freeze({ code: value.code, nativeLoopClosed: true as const, resourceSettlementObserved: false as const,
          unreleasedTurn: workers.some(w => w.close.unreleasedTurn), workers, poolClosed });
      } finally {
        signal.removeEventListener("abort", abort);
        // mux stops reading on poolClosed. Join that pump before the owner takes
        // the same wire to consume epochResult/supervisorResult and actual EOF.
        await mux.close(); muxControl.abort();
      }
    });
  };
  const requestClose = () => { void close().catch(() => {}); };
  const abort = () => requestClose(); signal.addEventListener("abort", abort, { once: true });
  const opening = children.map(async child => {
    const port = mux.port(child.workerId, frame => {
      if (frame.purpose !== "history-analysis") return undefined;
      const bound = work.get(child.workerId);
      if (!bound || frame.requestRef !== bound.requestRef) return fail("state");
      return bound.binding;
    });
    const workerWire: EpochWire = Object.freeze({
      async send(value: unknown, timeoutMs: number) {
        // Scoped session emits only host-created plain records here.
        const frame = value as Record<string, unknown>;
        if (frame.kind === "close") {
          const sent = mux.requestPoolClose(timeoutMs); requestClose(); return sent;
        }
        if (frame.kind === "turn") {
          if (closing || !ready || signal.aborted || custody() !== true || !identifier(frame.requestRef) || requests.has(frame.requestRef)) return fail("state");
          requests.add(frame.requestRef);
        }
        return port.send(value, timeoutMs);
      },
      receive: port.receive,
    });
    try {
      const session = await openStandingScopedEpochSession({ epochId, wire: workerWire, worker: { purpose: child.purpose }, signal,
        custodyReady: custody, clock, conversation, analysisTools,
        onToolResultSent: event => shown(Object.freeze({ ...event, workerId: child.workerId })) });
      sessions.set(child.workerId, session);
    } catch (error) { requestClose(); throw error; }
  });
  const opened = await Promise.allSettled(opening); finishOpening();
  const failed = opened.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (failed || closing || signal.aborted || custody() !== true) { await close().catch(() => {}); throw failed?.reason ?? new EpochSessionError("closed"); }
  ready = true;
  const conversationId = children.find(c => c.purpose === "conversation")!.workerId, assessmentId = children.find(c => c.purpose === "community-assessment")?.workerId;
  const workerIds = Object.freeze(children.map(c => c.workerId)), analysisWorkerIds = Object.freeze(children.filter(c => c.purpose === "history-analysis").map(c => c.workerId));
  function session(workerId: string, purpose: StandingParallelWorkerPurpose): WorkerSession {
    if (closing || signal.aborted || custody() !== true || !children.some(c => c.workerId === workerId && c.purpose === purpose)) return fail("state");
    return sessions.get(workerId)!;
  }
  return Object.freeze({
    workerIds: () => workerIds,
    analysisWorkerIds: () => analysisWorkerIds,
    turnConversation: (requestRef: string, body: string, images?: readonly StandingVisualInput[]) => session(conversationId, "conversation").turnConversation(requestRef, body, images),
    releaseConversation: (requestRef: string, delivery: "verified" | "not-sent" | "unknown") => session(conversationId, "conversation").releaseConversation(requestRef, delivery),
    async turnAnalysis(workerId: string, requestRef: string, body: string, binding: StandingPoolWorkBinding) {
      const target = session(workerId, "history-analysis"), fixed = workBinding(binding);
      if (target.state().phase !== "idle" || work.has(workerId)) return fail("state");
      work.set(workerId, Object.freeze({ requestRef, binding: fixed }));
      try { return Object.freeze({ ...await target.turnAnalysis(requestRef, body), workerId }); }
      catch (error) { work.delete(workerId); throw error; }
    },
    async releaseAnalysis(workerId: string, requestRef: string) {
      const target = session(workerId, "history-analysis");
      if (work.get(workerId)?.requestRef !== requestRef) return fail("state");
      await target.releaseAnalysis(requestRef); work.delete(workerId);
    },
    turnCommunityAssessment: (requestRef: string, body: string) => {
      if (!assessmentId) return fail("state"); return session(assessmentId, "community-assessment").turnCommunityAssessment(requestRef, body);
    },
    releaseCommunityAssessment: (requestRef: string) => {
      if (!assessmentId) return fail("state"); return session(assessmentId, "community-assessment").releaseCommunityAssessment(requestRef);
    },
    admission: (workerId = conversationId): "ready" | "rotate" | "unavailable" => closing || signal.aborted || custody() !== true ? "unavailable" : sessions.get(workerId)?.admission() ?? "unavailable",
    state: () => Object.freeze({ closing: !!closing, workers: Object.freeze(children.map(child => Object.freeze({ ...child, state: sessions.get(child.workerId)!.state() }))) }),
    close,
  });
}
