import { types } from "node:util";
import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { EpochExtraTool, EpochToolResult, EpochToolScope } from "./standing-tool-dispatcher.js";
import type { StandingHistoryTaskManager } from "./standing-history-task-manager.js";
import { HISTORY_TASK_TOOL_SPECS, parseStandingHistoryTaskTool } from "./standing-history-task-tools.js";
import { createStandingHistoryTaskRequest } from "./standing-history-task-request.js";
import { snapshotStandingActionJson } from "./standing-action-journal.js";

const fail = (): never => { throw new Error("STANDING_HISTORY_TASK_RUNTIME_INPUT"); };
function fields(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(ds);
  if (keys.some(k => !Object.hasOwn(ds, k)) || names.some(k => typeof k !== "string" || !keys.includes(k) && !optional.includes(k))) return fail();
  return Object.fromEntries(names.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail(); return [k, d.value]; }));
}
const validRef = (v: unknown): v is string => typeof v === "string" && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const output = (success: boolean, value: unknown): EpochToolResult => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 8192) return fail();
  return Object.freeze({ success, contentItems: Object.freeze([Object.freeze({ type: "inputText" as const, text })]) as EpochToolResult["contentItems"] });
};
const refused = (code: string) => output(false, { schema: "neurobro-history-task-error-v1", code });
function control(value: unknown) {
  const v = fields(value, ["storage", "state", "revision", "headHash"]);
  if (!["ready", "tail-refused"].includes(v.storage as string) || !["queued", "cancelled"].includes(v.state as string) ||
      v.revision !== (v.state === "cancelled" ? 1 : 0) || typeof v.headHash !== "string" || !/^[0-9a-f]{64}$/u.test(v.headHash)) return fail();
  return { storage: v.storage, state: v.state, revision: v.revision };
}
function publicResult(value: unknown, cancelled: boolean): unknown {
  // Detach inert host data before projection. Never forward raw checkpoints,
  // source IDs, account/requester IDs, heads or filesystem paths to the model.
  const v = fields(snapshotStandingActionJson(value), cancelled ? ["taskRef", "control", "revocationJoined"] : ["taskRef", "control", "read", "analysis"], cancelled ? [] : ["attempts", "delivery", "disposition"]);
  if (typeof v.taskRef !== "string" || !/^htask_[0-9a-f]{48}$/u.test(v.taskRef)) return fail();
  const c = control(v.control);
  if (cancelled) {
    if (v.revocationJoined !== true || c.state !== "cancelled" || c.storage !== "ready") return fail();
    return { schema: "neurobro-history-task-v1", taskRef: v.taskRef, control: c, revocationJoined: true };
  }
  const read = v.read as Record<string, unknown>, analysis = v.analysis as Record<string, unknown>;
  if (!read || !analysis || typeof read !== "object" || typeof analysis !== "object" ||
      !["ready", "tail-refused", "absent", "unavailable"].includes(read.storage as string) ||
      !["ready", "tail-refused", "absent", "unavailable"].includes(analysis.storage as string)) return fail();
  let readView: unknown = { storage: read.storage }, analysisView: unknown = { storage: analysis.storage };
  if (read.storage === "ready" || read.storage === "tail-refused") {
    const p = read.readProgress as Record<string, unknown>, checkpoint = p?.checkpoint as Record<string, unknown>;
    if (!p || !natural(p.committedPages) || !checkpoint || !["more", "empty-page", "lower-bound-reached", "inaccessible"].includes(checkpoint.status as string) ||
        typeof checkpoint.inexact !== "boolean" || !natural(checkpoint.undated)) return fail();
    readView = { storage: read.storage, committedPages: p.committedPages, frontier: checkpoint.status,
      inexact: checkpoint.inexact, undated: checkpoint.undated };
  }
  if (analysis.storage === "ready" || analysis.storage === "tail-refused") {
    if (!natural(analysis.analysisNodes) || !natural(analysis.leafNodes) || analysis.claims !== "model-authored-unverified") return fail();
    analysisView = { storage: analysis.storage, committedNodes: analysis.analysisNodes, leafNodes: analysis.leafNodes, claims: analysis.claims };
  }
  let attemptsView: unknown;
  if (Object.hasOwn(v, "attempts")) {
    const a = v.attempts as Record<string, unknown>;
    if (!a || typeof a !== "object" || !["ready", "tail-refused", "absent", "unavailable"].includes(a.storage as string)) return fail();
    attemptsView = { storage: a.storage };
    if (a.storage === "ready" || a.storage === "tail-refused") {
      if (!natural(a.attempts) || a.modelReplayAllowed !== false) return fail();
      const last = a.last as Record<string, unknown> | undefined;
      if ((a.attempts === 0) !== (last === undefined) || last !== undefined && (!last || typeof last !== "object" ||
          last.modelOutcome !== undefined && !["observed", "refused", "unknown"].includes(last.modelOutcome as string))) return fail();
      attemptsView = { storage: a.storage, reservedAttempts: a.attempts, modelReplayAllowed: false,
        ...(last === undefined ? {} : { last: { outputPrepared: last.prepared !== undefined, nodeCommitted: last.node !== undefined,
          modelOutcome: last.modelOutcome ?? "not-recorded" } }),
        execution: "not-inspected", ownerSettlement: "not-inspected" };
    }
  }
  let delivery: unknown = "not-inspected";
  if (Object.hasOwn(v, "delivery")) {
    const d = fields(v.delivery, ["state", "consumed"], ["partsTotal", "verifiedParts", "nextPart"]);
    if (!["verified", "unknown", "failed-terminal", "partial", "not-attempted", "unavailable"].includes(d.state as string) ||
        typeof d.consumed !== "boolean" || d.consumed !== (d.state !== "not-attempted")) return fail();
    delivery = { state: d.state, consumed: d.consumed };
    const multipart = Object.hasOwn(d, "partsTotal") || Object.hasOwn(d, "verifiedParts") || Object.hasOwn(d, "nextPart");
    if (!multipart && d.state === "partial") return fail();
    if (multipart) {
      if (d.partsTotal !== 2 || !Number.isInteger(d.verifiedParts) || Number(d.verifiedParts) < 0 || Number(d.verifiedParts) > 2 ||
          !["partial", "verified", "unknown", "failed-terminal"].includes(d.state as string) ||
          (d.state === "verified" ? d.verifiedParts !== 2 : Number(d.verifiedParts) >= 2) ||
          (d.state === "partial" ? !Object.hasOwn(d, "nextPart") || d.nextPart !== Number(d.verifiedParts) + 1 : Object.hasOwn(d, "nextPart"))) return fail();
      delivery = { state: d.state, consumed: d.consumed, partsTotal: d.partsTotal, verifiedParts: d.verifiedParts,
        ...(d.state === "partial" ? { nextPart: d.nextPart } : {}) };
    }
  }
  let disposition: unknown;
  if (Object.hasOwn(v, "disposition")) {
    const d = fields(v.disposition, ["storage"], ["reason"]);
    if (d.storage === "ready") {
      if (!["coverage", "stale", "consumed-without-prepared", "source-page-quota", "overflow"].includes(d.reason as string) || read.storage !== "ready" || analysis.storage !== "ready") return fail();
      disposition = { storage: "ready", reason: d.reason };
    } else {
      if (!["absent", "unavailable"].includes(d.storage as string) || Object.hasOwn(d, "reason")) return fail();
      disposition = { storage: d.storage };
    }
  }
  return { schema: "neurobro-history-task-v1", taskRef: v.taskRef, control: c, read: readView, analysis: analysisView,
    ...(attemptsView === undefined ? {} : { attempts: attemptsView }), delivery, ...(disposition === undefined ? {} : { disposition }) };
}

/** Borrowed manager outlives selected turns. finish/close revoke only this
 * wrapper's admitted operations and join them; the service closes the manager.
 * Current actor comes from host selection, never from model tool arguments. */
export function createStandingHistoryTaskRuntime(input: Readonly<{
  binding: PilotBinding; signal: AbortSignal; manager: StandingHistoryTaskManager;
}>) {
  const args = fields(input, ["binding", "signal", "manager"]), b = fields(args.binding, ["accountId", "peerId"]);
  if (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal)) return fail();
  const signal: AbortSignal = args.signal;
  const binding = Object.freeze({ accountId: b.accountId as string, peerId: b.peerId as string });
  const manager = args.manager as StandingHistoryTaskManager;
  if (!manager || types.isProxy(manager)) return fail();
  const methods = {} as Pick<StandingHistoryTaskManager, "create" | "status" | "cancel">;
  for (const name of ["create", "status", "cancel"] as const) {
    const d = Object.getOwnPropertyDescriptor(manager, name); if (!d || !("value" in d) || typeof d.value !== "function") return fail();
    Object.defineProperty(methods, name, { value: d.value.bind(manager), enumerable: true });
  }
  type Turn = { requestRef: string; primary: PilotPrimary; controller: AbortController; active?: Promise<EpochToolResult>; closing?: Promise<void>; calls: number };
  let current: Turn | undefined, closed = false;
  const stopped = () => closed || signal.aborted;
  function finish(): Promise<void> {
    const turn = current; if (!turn) return Promise.resolve();
    turn.controller.abort();
    return turn.closing ??= (async () => { try { await turn.active; } catch {} finally { if (current === turn) current = undefined; } })();
  }
  const abort = () => { void finish(); };
  signal.addEventListener("abort", abort, { once: true });
  async function call(name: string, value: unknown, scope: EpochToolScope): Promise<EpochToolResult> {
    const turn = current;
    if (stopped() || !turn || turn.controller.signal.aborted || turn.active) return refused("unavailable");
    let request: ReturnType<typeof parseStandingHistoryTaskTool>, callSignal: AbortSignal;
    try {
      const s = fields(scope, ["requestRef", "callRef", "signal"]);
      if (s.requestRef !== turn.requestRef || !validRef(s.callRef) || types.isProxy(s.signal) || !(s.signal instanceof AbortSignal) || s.signal.aborted) return refused("invalid-scope");
      request = parseStandingHistoryTaskTool(name, value);
      callSignal = AbortSignal.any([signal, turn.controller.signal, s.signal]);
    } catch { return refused("invalid-arguments"); }
    if (turn.calls >= 8) return refused("turn-call-limit"); turn.calls++;
    const pending = Promise.resolve().then(async () => {
      if (callSignal.aborted || current !== turn) return refused("stopped");
      const result = request.kind === "create" ? await methods.create({ primary: turn.primary, request: request.request, signal: callSignal }) :
        request.kind === "status" ? await methods.status({ taskRef: request.taskRef, requesterId: turn.primary.ownerId, signal: callSignal }) :
          await methods.cancel({ taskRef: request.taskRef, requesterId: turn.primary.ownerId, signal: callSignal });
      if (callSignal.aborted || current !== turn) return refused("stopped");
      return output(true, publicResult(result, request.kind === "cancel"));
    }).catch(() => refused("unavailable"));
    turn.active = pending;
    try { return await pending; } finally { if (turn.active === pending) delete turn.active; }
  }
  return Object.freeze({ specs: HISTORY_TASK_TOOL_SPECS,
    handlers: Object.freeze(HISTORY_TASK_TOOL_SPECS.map(spec => Object.freeze({ name: spec.name, call: (value: unknown, scope: EpochToolScope) => call(spec.name, value, scope) }))) as readonly EpochExtraTool[],
    begin(value: Readonly<{ requestRef: string; primary: PilotPrimary }>) {
      if (stopped() || current) return fail();
      const v = fields(value, ["requestRef", "primary"]), p = fields(v.primary, ["chatId", "ownerId", "messageId", "text"]);
      if (!validRef(v.requestRef)) return fail();
      const primary = Object.freeze({ chatId: p.chatId, ownerId: p.ownerId, messageId: p.messageId, text: p.text }) as PilotPrimary;
      createStandingHistoryTaskRequest({ identityKey: "0".repeat(64), binding, primary,
        request: { fromDate: 1, toDate: 1, timezone: "UTC", objective: "Validate host selection" } });
      current = { requestRef: v.requestRef, primary, controller: new AbortController(), calls: 0 };
    }, finish,
    async close() { closed = true; await finish(); signal.removeEventListener("abort", abort); },
  });
}
