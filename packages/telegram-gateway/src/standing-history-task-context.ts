import { createHash } from "node:crypto";
import { types } from "node:util";
import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { ConversationReferences } from "./conversation-references.js";
import type { StandingHistoryTaskDiscovery } from "./standing-history-task-discovery.js";
import type { StandingHistoryTaskManager, StandingHistoryManagedTaskStatus } from "./standing-history-task-manager.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import type { StandingSharedTask, StandingSharedContextCoverage } from "./standing-shared-context.js";

/** Opaque, single-use host continuation. Its actual discovery cursor never
 * enters a model packet and cannot be transplanted to another actor or reader. */
export type StandingHistoryTaskContextContinuation = Readonly<{ kind: "standing-task-context-continuation" }>;
export type StandingHistoryTaskContextPage = Readonly<{
  source: Readonly<{ items: readonly StandingSharedTask[]; coverage: StandingSharedContextCoverage }>;
  continuation?: StandingHistoryTaskContextContinuation;
  scan: Readonly<{ scanned: number; unavailable: number; foreign: number; actorExcluded: number; statusUnavailable: number;
    hasMore: boolean | null; completeTraversal: boolean; latestOrdering: false }>;
}>;
export type StandingHistoryTaskContextInput = Readonly<{
  binding: PilotBinding; primary: PilotPrimary; references: ConversationReferences; scopeRef: string; asOf: number; signal: AbortSignal;
  discovery: Pick<StandingHistoryTaskDiscovery, "find">; manager: Pick<StandingHistoryTaskManager, "status">;
  continuation?: StandingHistoryTaskContextContinuation;
}>;
type Owner = Readonly<{ binding: PilotBinding; primary: PilotPrimary; references: ConversationReferences; scopeRef: string; asOf: number; signal: AbortSignal }>;
type CursorOwner = Owner & Readonly<{ discovery: object; cursor: string }>;
const owners = new WeakMap<object, Owner>(), cursors = new WeakMap<object, CursorOwner>();
const active = new WeakSet<object>();
const fail = (): never => { throw new Error("STANDING_HISTORY_TASK_CONTEXT_REFUSED"); };
function record(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail();
  const out: Record<string, unknown> = {};
  for (const k of [...required, ...optional]) { const d = ds[k]; if (!d) continue; if (!("value" in d) || !d.enumerable) return fail(); out[k] = d.value; }
  return out;
}
function array(v: unknown, limit: number): unknown[] {
  if (!Array.isArray(v) || types.isProxy(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > limit) return fail();
  const ds = Object.getOwnPropertyDescriptors(v); if (Reflect.ownKeys(ds).length !== v.length + 1) return fail();
  return Array.from({ length: v.length }, (_, i) => { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail(); return d.value; });
}
function natural(v: unknown): number { if (!Number.isSafeInteger(v) || Number(v) < 0) return fail(); return v as number; }
function positive(v: unknown): number { const n = natural(v); if (!n || n > 253402300799) return fail(); return n; }
function boolean(v: unknown): boolean { if (typeof v !== "boolean") return fail(); return v; }
function member<T extends string>(v: unknown, values: readonly T[]): T { if (typeof v !== "string" || !values.includes(v as T)) return fail(); return v as T; }
function method<T>(value: unknown, key: string): T {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail();
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail(); return d.value.bind(value) as T;
}
function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const c of Object.values(v)) freeze(c); Object.freeze(v); } return v; }
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
function ref(prefix: string, v: unknown): string { return prefix + "_" + createHash("sha256").update(canonical(v)).digest("hex"); }
function check(owner: Owner): void {
  if (owner.signal.aborted || !owner.references.matches(owner.binding.peerId, owner.binding.accountId) || owner.references.speaker(owner.primary.ownerId) === "neurobro") return fail();
}
/** Bounded inert snapshot before inspecting host status. Authentication belongs
 * to manager.status; this copy neither authenticates a caller's JSON nor grants
 * task execution. No private status fields are forwarded. */
function statusCopy(value: unknown): StandingHistoryManagedTaskStatus {
  let nodes = 0, bytes = 0;
  const take = (n: number) => { bytes += n; if (bytes > 65536) return fail(); };
  const string = (v: string, limit: number): string => {
    // Reject raw length before UTF-8 conversion/escaping can allocate. Count
    // escaped JSON bytes now, before copying any later branch of the tree.
    if (v.length > limit || Buffer.byteLength(v) > limit || v.includes("\0") || Buffer.from(v).toString() !== v) return fail();
    take(Buffer.byteLength(JSON.stringify(v))); return v;
  };
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 4096 || depth > 14) return fail();
    if (v === null || typeof v === "boolean") { take(v === null || v === true ? 4 : 5); return v; }
    if (typeof v === "string") return string(v, 8192);
    if (typeof v === "number") { if (!Number.isFinite(v)) return fail(); take(Buffer.byteLength(JSON.stringify(v))); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    if (Array.isArray(v)) { const values = array(v, 1024); take(2 + Math.max(0, values.length - 1)); return values.map(c => copy(c, depth + 1)); }
    const ds = Object.getOwnPropertyDescriptors(v);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
    const keys = Reflect.ownKeys(ds); if (keys.length > 256) return fail();
    take(2 + Math.max(0, keys.length - 1));
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const d = ds[key as string];
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key) || !d || !("value" in d) || !d.enumerable) return fail();
      string(key, 128); take(1);
      out[key] = copy(d.value, depth + 1);
    }
    return out;
  }
  const result = copy(value, 0);
  return result as StandingHistoryManagedTaskStatus;
}
function mapped(intent: StandingHistoryTaskIntent, raw: unknown, owner: Pick<Owner, "scopeRef">, asOf: number): StandingSharedTask {
  const status = raw === undefined ? undefined : statusCopy(raw);
  const sourceRef = ref("stask", ["standing-task-context-source-v1", owner.scopeRef, intent.taskId]);
  const base = { kind: "task-state" as const, sourceRef, versionRef: ref("sver", ["standing-task-context-version-v1", sourceRef, intent, status ?? "unavailable"]),
    observedAt: asOf, taskRef: intent.taskId,
    description: { objective: intent.objective, fromDate: intent.fromDate, toDate: intent.toDate, timezone: intent.timezone } };
  const unknown: StandingSharedTask = { ...base, control: "unavailable", read: "unavailable", analysis: "unavailable",
    outputPrepared: "unavailable", nodeCommitted: "unavailable", modelOutcome: "unavailable", delivery: "unavailable", disposition: "unavailable" };
  if (!status) return unknown;
  if (status.taskRef !== intent.taskId) return fail();
  const s = record(status, ["taskRef", "control", "read", "analysis"], ["attempts", "delivery", "disposition"]);
  const c = record(s.control, ["storage", "state", "revision", "headHash"]);
  member(c.storage, ["ready", "tail-refused"]); const control = member(c.state, ["queued", "cancelled"]);
  if (c.revision !== (control === "cancelled" ? 1 : 0) || typeof c.headHash !== "string" || !/^[0-9a-f]{64}$/u.test(c.headHash)) return fail();
  let read: StandingSharedTask["read"] = "unavailable", analysis: StandingSharedTask["analysis"] = "unavailable";
  if (status.read.storage === "ready") {
    const p = status.read.readProgress, checkpoint = p.checkpoint;
    natural(p.committedPages); boolean(checkpoint.inexact); natural(checkpoint.undated);
    member(checkpoint.status, ["more", "empty-page", "lower-bound-reached", "inaccessible"]);
    read = checkpoint.inexact || checkpoint.undated > 0 ? "inexact"
      : checkpoint.status === "empty-page" || checkpoint.status === "lower-bound-reached" ? "complete" : "partial";
  }
  if (status.analysis.storage === "ready") {
    if (status.analysis.claims !== "model-authored-unverified") return fail();
    analysis = natural(status.analysis.analysisNodes) > 0 ? "committed" : "none";
  }
  let outputPrepared: StandingSharedTask["outputPrepared"] = "unavailable", nodeCommitted: StandingSharedTask["nodeCommitted"] = "unavailable";
  let modelOutcome: StandingSharedTask["modelOutcome"] = "unavailable";
  if (status.attempts?.storage === "ready") {
    const a = status.attempts;
    if (a.modelReplayAllowed !== false || (natural(a.attempts) === 0) !== (a.last === undefined)) return fail();
    outputPrepared = a.last?.prepared !== undefined; nodeCommitted = a.last?.node !== undefined;
    modelOutcome = a.last?.modelOutcome === undefined ? "not-recorded" : member(a.last.modelOutcome, ["observed", "refused", "unknown"]);
  }
  const delivery = status.delivery === undefined ? "not-inspected" : member(status.delivery.state, ["verified", "unknown", "failed-terminal", "partial", "not-attempted", "unavailable"]);
  const disposition = status.disposition?.storage === "ready"
    ? member(status.disposition.reason, ["coverage", "stale", "consumed-without-prepared", "source-page-quota", "overflow"])
    : status.disposition?.storage === "absent" ? "none" : "unavailable";
  return { ...base, control, read, analysis, outputPrepared, nodeCommitted, modelOutcome, delivery, disposition };
}

/** One discovery page and at most four serial status reads. The caller owns
 * scheduling (startup/idle/explicit status refresh), the borrowed handles and
 * their shutdown. Do not add this scan to every foreground turn. Abort prevents
 * further admission and waits for an already admitted real operation to settle.
 * Directory traversal is neither latest ordering nor an atomic inventory.
 */
export async function readStandingHistoryTaskContext(input: StandingHistoryTaskContextInput): Promise<StandingHistoryTaskContextPage> {
  const v = record(input, ["binding", "primary", "references", "scopeRef", "asOf", "signal", "discovery", "manager"], ["continuation"]);
  const b = record(v.binding, ["accountId", "peerId"]), p = record(v.primary, ["chatId", "ownerId", "messageId", "text"]);
  if (typeof b.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(b.accountId) || typeof b.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(b.peerId) ||
      p.chatId !== b.peerId || typeof p.ownerId !== "string" || !/^[1-9]\d{0,19}$/u.test(p.ownerId) || !Number.isInteger(p.messageId) || Number(p.messageId) < 1 || Number(p.messageId) > 2147483647 ||
      typeof p.text !== "string" || !p.text.length || p.text.includes("\0") || Buffer.byteLength(p.text) > 4096 || Buffer.from(p.text).toString() !== p.text ||
      typeof v.scopeRef !== "string" || !/^[a-z][a-z0-9-]{0,31}_[0-9a-f]{32,64}$/u.test(v.scopeRef) || types.isProxy(v.signal) || !(v.signal instanceof AbortSignal)) return fail();
  const asOf = positive(v.asOf), owner: Owner = { binding: freeze({ accountId: b.accountId, peerId: b.peerId }),
    primary: freeze({ chatId: p.chatId as string, ownerId: p.ownerId, messageId: Number(p.messageId), text: p.text }),
    references: v.references as ConversationReferences, scopeRef: v.scopeRef, asOf, signal: v.signal };
  if (!owner.references || types.isProxy(owner.references)) return fail();
  check(owner);
  const discovery = v.discovery as StandingHistoryTaskDiscovery, manager = v.manager as StandingHistoryTaskManager;
  const find = method<StandingHistoryTaskDiscovery["find"]>(discovery, "find"), status = method<StandingHistoryTaskManager["status"]>(manager, "status");
  if (active.has(discovery) || active.has(manager)) return fail();
  let cursor: string | undefined;
  if (Object.hasOwn(v, "continuation")) {
    if (!v.continuation || typeof v.continuation !== "object") return fail();
    const prior = cursors.get(v.continuation);
    if (!prior || prior.discovery !== discovery || prior.references !== owner.references || prior.scopeRef !== owner.scopeRef || prior.signal !== owner.signal ||
        prior.binding.accountId !== owner.binding.accountId || prior.binding.peerId !== owner.binding.peerId || prior.primary.ownerId !== owner.primary.ownerId) return fail();
    check(prior); cursor = prior.cursor; cursors.delete(v.continuation);
  }
  active.add(discovery); active.add(manager);
  try {
    let page: Awaited<ReturnType<StandingHistoryTaskDiscovery["find"]>>;
    try { page = await find({ limit: 4, ...(cursor ? { cursor } : {}) }); }
    catch { check(owner); const result = freeze<StandingHistoryTaskContextPage>({ source: { items: [], coverage: { availability: "unavailable", freshness: "unknown", scanned: 0, hasMore: null, omittedAtSource: null } },
      scan: { scanned: 0, unavailable: 0, foreign: 0, actorExcluded: 0, statusUnavailable: 0, hasMore: null, completeTraversal: false, latestOrdering: false } }); owners.set(result, owner); return result; }
    check(owner);
    const raw = record(page, ["tasks", "hasMore", "coverage"], ["cursor"]), coverage = record(raw.coverage, ["complete", "scanned", "unavailable", "foreign", "root"]);
    const hasMore = boolean(raw.hasMore), scanned = natural(coverage.scanned), unavailable = natural(coverage.unavailable), foreign = natural(coverage.foreign), complete = boolean(coverage.complete);
    member(coverage.root, ["absent", "present"]);
    if (hasMore !== Object.hasOwn(raw, "cursor") || hasMore && (typeof raw.cursor !== "string" || !/^hcur_[0-9a-f]{48}$/u.test(raw.cursor)) || complete && (hasMore || unavailable > 0 || foreign > 0)) return fail();
    const intents = array(raw.tasks, 4).map(snapshotStandingHistoryTaskIntent);
    if (new Set(intents.map(i => i.taskId)).size !== intents.length) return fail();
    const items: StandingSharedTask[] = []; let actorExcluded = 0, statusUnavailable = 0;
    for (const intent of intents) {
      // This exact filter precedes manager invocation and any public description.
      if (intent.accountId !== owner.binding.accountId || intent.chatId !== owner.binding.peerId || intent.requesterId !== owner.primary.ownerId) { actorExcluded++; continue; }
      check(owner); let item: StandingSharedTask;
      try { const result = await status({ taskRef: intent.taskId, requesterId: owner.primary.ownerId, signal: owner.signal }); check(owner); item = mapped(intent, result, owner, asOf); }
      catch { check(owner); statusUnavailable++; item = mapped(intent, undefined, owner, asOf); }
      items.push(item);
    }
    let continuation: StandingHistoryTaskContextContinuation | undefined;
    if (hasMore) { continuation = Object.freeze({ kind: "standing-task-context-continuation" }); cursors.set(continuation, { ...owner, discovery, cursor: raw.cursor as string }); }
    check(owner);
    const result = freeze<StandingHistoryTaskContextPage>({ source: { items, coverage: { availability: "available", freshness: statusUnavailable ? "unknown" : "current", scanned,
      hasMore, omittedAtSource: unavailable + foreign === 0 ? 0 : null } }, ...(continuation ? { continuation } : {}),
      scan: { scanned, unavailable, foreign, actorExcluded, statusUnavailable, hasMore, completeTraversal: complete && statusUnavailable === 0, latestOrdering: false } });
    owners.set(result, owner); return result;
  } finally { active.delete(discovery); active.delete(manager); }
}

/** Exact selected-primary capability check. Cloning a page or changing actor,
 * connection or signal lifetime cannot turn it into model context. */
export function requireStandingHistoryTaskContext(value: StandingHistoryTaskContextPage, primary: PilotPrimary,
  references: ConversationReferences | undefined, expected?: Readonly<{scopeRef: string; asOf: number}>): StandingHistoryTaskContextPage {
  const owner = owners.get(value);
  if (!owner || references !== owner.references || primary.chatId !== owner.primary.chatId || primary.ownerId !== owner.primary.ownerId ||
      primary.messageId !== owner.primary.messageId || primary.text !== owner.primary.text) return fail();
  if (expected !== undefined) {
    const wanted = record(expected, ["scopeRef", "asOf"]);
    if (wanted.scopeRef !== owner.scopeRef || wanted.asOf !== owner.asOf) return fail();
  }
  check(owner); return value;
}

/** Host-only handle to one projected observation. The description and status
 * remain in the projector's private registry, not on an externally forgeable
 * record. This is local provenance; the manager authenticates its input. */
export type StandingHistoryTaskContextObservation = Readonly<{ taskRef: string; requesterId: string; observedAt: number; intentRef: string }>;
export type StandingHistoryTaskContextProjectionInput = Readonly<{
  binding: PilotBinding; references: ConversationReferences; scopeRef: string; signal: AbortSignal;
}>;

/** Passive manager-observation adapter. It performs no discovery, status read,
 * timer or asynchronous work. Only observations captured through this factory
 * can be issued as pages, always stale and explicitly incomplete on reuse. */
export function createStandingHistoryTaskContextProjection(input: StandingHistoryTaskContextProjectionInput) {
  const v = record(input, ["binding", "references", "scopeRef", "signal"]), b = record(v.binding, ["accountId", "peerId"]);
  if (typeof b.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(b.accountId) || typeof b.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(b.peerId) ||
      typeof v.scopeRef !== "string" || !/^[a-z][a-z0-9-]{0,31}_[0-9a-f]{32,64}$/u.test(v.scopeRef) || types.isProxy(v.signal) || !(v.signal instanceof AbortSignal) ||
      !v.references || typeof v.references !== "object" || types.isProxy(v.references)) return fail();
  const binding = freeze({ accountId: b.accountId, peerId: b.peerId }), references = v.references as ConversationReferences, scopeRef = v.scopeRef;
  const stop = new AbortController(), signal = AbortSignal.any([v.signal, stop.signal]);
  let saved = new WeakMap<StandingHistoryTaskContextObservation, Readonly<{task: StandingSharedTask; invalidated: boolean}>>();
  const live = () => { if (signal.aborted || !references.matches(binding.peerId, binding.accountId)) return fail(); };
  live();
  return Object.freeze({
    capture(value: Readonly<{ intent: StandingHistoryTaskIntent; status: StandingHistoryManagedTaskStatus; observedAt: number }>): StandingHistoryTaskContextObservation {
      live(); const c = record(value, ["intent", "status", "observedAt"]), intent = snapshotStandingHistoryTaskIntent(c.intent), observedAt = positive(c.observedAt);
      if (c.status === undefined || intent.accountId !== binding.accountId || intent.chatId !== binding.peerId || references.speaker(intent.requesterId) === "neurobro") return fail();
      const task = freeze(mapped(intent, c.status, { scopeRef }, observedAt));
      const observation = Object.freeze({ taskRef: task.taskRef, requesterId: intent.requesterId, observedAt,
        intentRef: ref("tintent", ["standing-task-context-intent-v1", scopeRef, intent]) });
      saved.set(observation, { task, invalidated: false }); return observation;
    },
    /** Authenticated bounded discovery proves the immutable request's purpose,
     * not control, progress, model outcome or delivery. No status read occurs. */
    captureIntent(value: Readonly<{intent: StandingHistoryTaskIntent; observedAt: number}>): StandingHistoryTaskContextObservation {
      live(); const c = record(value, ["intent", "observedAt"]), intent = snapshotStandingHistoryTaskIntent(c.intent), observedAt = positive(c.observedAt);
      if (intent.accountId !== binding.accountId || intent.chatId !== binding.peerId || references.speaker(intent.requesterId) === "neurobro") return fail();
      const task = freeze(mapped(intent, undefined, { scopeRef }, observedAt));
      const observation = Object.freeze({ taskRef: task.taskRef, requesterId: intent.requesterId, observedAt,
        intentRef: ref("tintent", ["standing-task-context-intent-v1", scopeRef, intent]) });
      saved.set(observation, { task, invalidated: true }); return observation;
    },
    invalidate(observation: StandingHistoryTaskContextObservation): StandingHistoryTaskContextObservation {
      live(); const previous = saved.get(observation); if (!previous) return fail();
      if (previous.invalidated) return observation;
      const task = freeze<StandingSharedTask>({ ...previous.task,
        versionRef: ref("sver", ["standing-task-context-invalidated-v1", previous.task.versionRef]),
        control: "unavailable", read: "unavailable", analysis: "unavailable", outputPrepared: "unavailable", nodeCommitted: "unavailable",
        modelOutcome: "unavailable", delivery: "unavailable", disposition: "unavailable" });
      const result = Object.freeze({ taskRef: observation.taskRef, requesterId: observation.requesterId, observedAt: observation.observedAt, intentRef: observation.intentRef });
      saved.set(result, { task, invalidated: true }); return result;
    },
    issue(value: Readonly<{ primary: PilotPrimary; asOf: number; observations: readonly StandingHistoryTaskContextObservation[] }>): StandingHistoryTaskContextPage {
      live(); const request = record(value, ["primary", "asOf", "observations"]), p = record(request.primary, ["chatId", "ownerId", "messageId", "text"]), asOf = positive(request.asOf);
      if (p.chatId !== binding.peerId || typeof p.ownerId !== "string" || !/^[1-9]\d{0,19}$/u.test(p.ownerId) || references.speaker(p.ownerId) === "neurobro" ||
          !Number.isInteger(p.messageId) || Number(p.messageId) < 1 || Number(p.messageId) > 2147483647 || typeof p.text !== "string" || !p.text.length || p.text.length > 4096 ||
          Buffer.byteLength(p.text) > 4096 || p.text.includes("\0") || Buffer.from(p.text).toString() !== p.text) return fail();
      const primary = freeze({ chatId: p.chatId, ownerId: p.ownerId, messageId: Number(p.messageId), text: p.text });
      const observations = array(request.observations, 4), items: StandingSharedTask[] = [], seen = new Set<string>();
      let invalidated = false;
      for (const observation of observations) {
        if (!observation || typeof observation !== "object" || types.isProxy(observation)) return fail();
        const entry = saved.get(observation as StandingHistoryTaskContextObservation), task = entry?.task;
        if (!task || (observation as StandingHistoryTaskContextObservation).requesterId !== primary.ownerId || task.observedAt === null || task.observedAt > asOf || seen.has(task.taskRef)) return fail();
        invalidated ||= entry!.invalidated;
        seen.add(task.taskRef); items.push(task);
      }
      const owner: Owner = { binding, primary, references, scopeRef, asOf, signal };
      check(owner);
      const result = freeze<StandingHistoryTaskContextPage>({ source: { items, coverage: {
        availability: items.length ? "available" : "unavailable", freshness: items.length && !invalidated ? "stale" : "unknown", scanned: 0, hasMore: null, omittedAtSource: null } },
        scan: { scanned: 0, unavailable: 0, foreign: 0, actorExcluded: 0, statusUnavailable: 0, hasMore: null, completeTraversal: false, latestOrdering: false } });
      owners.set(result, owner); return result;
    },
    close(): void { stop.abort(); saved = new WeakMap(); },
  });
}
