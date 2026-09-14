import { types } from "node:util";
import type { PilotPrimary } from "./pilot-telegram-adapter.js";
import type { StandingHistoryTaskContextEvent } from "./standing-history-task-manager.js";
import type { StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import { createStandingHistoryTaskContextProjection, type StandingHistoryTaskContextProjectionInput,
  type StandingHistoryTaskContextObservation, type StandingHistoryTaskContextPage } from "./standing-history-task-context.js";

export type StandingHistoryTaskMemory = Readonly<{
  observe(event: StandingHistoryTaskContextEvent, observedAt: number): void;
  /** Discovery supplies purpose only. Rediscovering the exact immutable intent
   * preserves an existing status snapshot and its original observation time. */
  remember(intent: StandingHistoryTaskIntent, observedAt: number): void;
  /** Neither argument means all cached observations. Last observed intent is
   * retained; status becomes unavailable until the next manager snapshot. */
  invalidate(taskRef?: string, requesterId?: string): void;
  forPrimary(input: Readonly<{ primary: PilotPrimary; asOf: number }>): StandingHistoryTaskContextPage;
  close(): void;
}>;
const fail = (): never => { throw new Error("STANDING_HISTORY_TASK_MEMORY_REFUSED"); };
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
  const ds = Object.getOwnPropertyDescriptors(v), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) return fail();
  const out: Record<string, unknown> = {};
  for (const key of keys) { const d = ds[key]; if (!d || !("value" in d) || !d.enumerable) return fail(); out[key] = d.value; }
  return out;
}
const taskId = (v: unknown): v is string => typeof v === "string" && /^htask_[0-9a-f]{48}$/u.test(v);
const actorId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d{0,19}$/u.test(v);

/** Passive, per-connection cache of at most 32 projected tasks. It retains no
 * raw manager status, source checkpoint, primary text or durable credentials.
 * A trusted manager observer supplies authenticated intent/status evidence.
 * This module issues neither read nor execution authority. Reads only project
 * up to four already cached same-actor observations and always mark them stale.
 * No timers, filesystem, Telegram, model calls, promises or background jobs. */
export function createStandingHistoryTaskMemory(input: StandingHistoryTaskContextProjectionInput): StandingHistoryTaskMemory {
  const projection = createStandingHistoryTaskContextProjection(input);
  const v = record(input, ["binding", "references", "scopeRef", "signal"]), b = record(v.binding, ["accountId", "peerId"]);
  const signal = v.signal as AbortSignal, references = v.references as StandingHistoryTaskContextProjectionInput["references"];
  const binding = { accountId: b.accountId as string, peerId: b.peerId as string };
  const entries = new Map<string, StandingHistoryTaskContextObservation>();
  let closed = false;
  const live = () => { if (closed || signal.aborted || !references.matches(binding.peerId, binding.accountId)) return fail(); };
  const invalidate = (taskRef?: string, requesterId?: string) => {
    if (closed) return;
    live();
    if (taskRef !== undefined && !taskId(taskRef) || requesterId !== undefined && !actorId(requesterId)) return fail();
    for (const [key, value] of entries) if ((taskRef === undefined || key === taskRef) && (requesterId === undefined || value.requesterId === requesterId)) entries.set(key, projection.invalidate(value));
  };
  const close = () => { if (closed) return; closed = true; entries.clear(); projection.close(); signal.removeEventListener("abort", close); };
  signal.addEventListener("abort", close, { once: true });
  return Object.freeze({
    observe(event: StandingHistoryTaskContextEvent, observedAt: number): void {
      if (closed) return;
      live();
      try {
        if (!event || typeof event !== "object" || types.isProxy(event)) return fail();
        const descriptor = Object.getOwnPropertyDescriptor(event, "kind");
        if (!descriptor || !("value" in descriptor)) return fail();
        if (descriptor.value === "invalidate") {
          const v = record(event, ["kind", "taskRef", "requesterId"]);
          if (!taskId(v.taskRef) || !actorId(v.requesterId)) return fail();
          invalidate(v.taskRef, v.requesterId); return;
        }
        const v = record(event, ["kind", "intent", "status"]);
        if (v.kind !== "snapshot") return fail();
        const observation = projection.capture({ intent: v.intent as Extract<StandingHistoryTaskContextEvent, {kind:"snapshot"}>["intent"],
          status: v.status as Extract<StandingHistoryTaskContextEvent, {kind:"snapshot"}>["status"], observedAt });
        const previous = entries.get(observation.taskRef);
        if (previous && (previous.requesterId !== observation.requesterId || previous.intentRef !== observation.intentRef)) return fail();
        entries.delete(observation.taskRef); entries.set(observation.taskRef, observation);
        if (entries.size > 32) entries.delete(entries.keys().next().value!);
      } catch { try { invalidate(); } catch { entries.clear(); } throw new Error("STANDING_HISTORY_TASK_MEMORY_REFUSED"); }
    },
    remember(intent: StandingHistoryTaskIntent, observedAt: number): void {
      if (closed) return;
      live();
      const observation = projection.captureIntent({ intent, observedAt }), previous = entries.get(observation.taskRef);
      if (previous && (previous.requesterId !== observation.requesterId || previous.intentRef !== observation.intentRef)) return fail();
      // Same-intent discovery touches LRU only; it cannot downgrade status or
      // renew the timestamp/version of an older authenticated observation.
      entries.delete(observation.taskRef); entries.set(observation.taskRef, previous ?? observation);
      if (entries.size > 32) entries.delete(entries.keys().next().value!);
    },
    invalidate,
    forPrimary(value: Readonly<{primary: PilotPrimary; asOf: number}>): StandingHistoryTaskContextPage {
      live(); const v = record(value, ["primary", "asOf"]), p = record(v.primary, ["chatId", "ownerId", "messageId", "text"]);
      if (!actorId(p.ownerId)) return fail();
      const selected = [...entries.values()].reverse().filter(entry => entry.requesterId === p.ownerId).slice(0, 4);
      const page = projection.issue({ primary: p as PilotPrimary, asOf: v.asOf as number, observations: selected });
      // Only successfully issued same-actor observations affect LRU order.
      for (const entry of [...selected].reverse()) { entries.delete(entry.taskRef); entries.set(entry.taskRef, entry); }
      return page;
    },
    close,
  });
}
