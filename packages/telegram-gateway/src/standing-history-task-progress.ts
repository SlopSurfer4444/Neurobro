import { types } from "node:util";

export const STANDING_HISTORY_TASK_PHASES = ["reading", "planning", "analyzing", "recovering", "finalizing", "reviewing", "report-ready", "delivering", "delivered", "stalled", "cancelled"] as const;
export const STANDING_HISTORY_TASK_PROGRESS_REASONS = ["report-quality-required", "report-required", "prior-owner-unavailable", "consumed-without-prepared", "unbound-attempt", "unavailable", "cancelled", "source-unavailable", "source-page-quota", "coverage", "stale", "overflow", "delivery-unknown", "delivery-failed-terminal"] as const;
export type StandingHistoryTaskProgressEvent = Readonly<{
  taskRef: string; phase: typeof STANDING_HISTORY_TASK_PHASES[number];
  reason: typeof STANDING_HISTORY_TASK_PROGRESS_REASONS[number] | null;
}>;
export type StandingHistoryTaskProgress = Readonly<{
  phase: StandingHistoryTaskProgressEvent["phase"]; reason: StandingHistoryTaskProgressEvent["reason"];
  observedAt: number; freshness: "stale"; executionAuthorized: false;
  recovery: "none" | "preserve-progress" | "review-report" | "needs-settlement" | "check-source" | "refresh-status";
}>;
export type StandingHistoryTaskSavedProgress = Readonly<{
  committedPages: number | null; analysisNodes: number | null; observedAt: number; freshness: "stale";
}>;
const fail = (): never => { throw new Error("STANDING_HISTORY_TASK_PROGRESS_REFUSED"); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) return fail();
  const out: Record<string, unknown> = {};
  for (const k of keys) { const d = ds[k]; if (!d || !("value" in d) || !d.enumerable) return fail(); out[k] = d.value; }
  return out;
}
const natural = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 0) return fail(); return v as number; };
const time = (v: unknown): number => { const n = natural(v); if (!n || n > 253402300799) return fail(); return n; };
function state(phase: unknown, reason: unknown): Pick<StandingHistoryTaskProgress, "phase" | "reason" | "recovery"> {
  if (!STANDING_HISTORY_TASK_PHASES.includes(phase as never) || reason !== null && !STANDING_HISTORY_TASK_PROGRESS_REASONS.includes(reason as never)) return fail();
  // An observation describes a completed host boundary, never a live lease.
  if (phase === "stalled" ? reason === null || reason === "cancelled" : phase === "cancelled" ? reason !== "cancelled" : reason !== null) return fail();
  const recovery: StandingHistoryTaskProgress["recovery"] = reason === "report-quality-required" ? "review-report"
    : ["prior-owner-unavailable", "consumed-without-prepared", "unbound-attempt", "delivery-unknown"].includes(reason as string) ? "needs-settlement"
    : reason === "source-unavailable" ? "check-source" : reason === "unavailable" || reason === "stale" || reason === "report-required" ? "refresh-status"
    : reason !== null ? "preserve-progress" : "none";
  return { phase: phase as StandingHistoryTaskProgress["phase"], reason: reason as StandingHistoryTaskProgress["reason"], recovery };
}
/** Inert host observation only. No error text, model claims, paths, credentials,
 * admission handles or replay permission can enter this fixed schema. */
export function snapshotStandingHistoryTaskProgressEvent(value: unknown): StandingHistoryTaskProgressEvent {
  const v = record(value, ["taskRef", "phase", "reason"]);
  if (typeof v.taskRef !== "string" || !/^htask_[0-9a-f]{48}$/u.test(v.taskRef)) return fail();
  const s = state(v.phase, v.reason); return Object.freeze({ taskRef: v.taskRef, phase: s.phase, reason: s.reason });
}
export function projectStandingHistoryTaskProgress(event: StandingHistoryTaskProgressEvent, observedAt: number): StandingHistoryTaskProgress {
  const e = snapshotStandingHistoryTaskProgressEvent(event);
  return Object.freeze({ ...state(e.phase, e.reason), observedAt: time(observedAt), freshness: "stale", executionAuthorized: false });
}
export function snapshotStandingHistoryTaskProgress(value: unknown): StandingHistoryTaskProgress {
  const v = record(value, ["phase", "reason", "observedAt", "freshness", "executionAuthorized", "recovery"]), s = state(v.phase, v.reason);
  if (v.freshness !== "stale" || v.executionAuthorized !== false || v.recovery !== s.recovery) return fail();
  return Object.freeze({ ...s, observedAt: time(v.observedAt), freshness: "stale", executionAuthorized: false });
}
export function snapshotStandingHistoryTaskSavedProgress(value: unknown): StandingHistoryTaskSavedProgress {
  const v = record(value, ["committedPages", "analysisNodes", "observedAt", "freshness"]);
  if (v.freshness !== "stale") return fail();
  return Object.freeze({ committedPages: v.committedPages === null ? null : natural(v.committedPages),
    analysisNodes: v.analysisNodes === null ? null : natural(v.analysisNodes), observedAt: time(v.observedAt), freshness: "stale" });
}
