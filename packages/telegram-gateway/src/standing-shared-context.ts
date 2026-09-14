import { createHash } from "node:crypto";
import { types } from "node:util";
import { snapshotStandingOwnActionView, type StandingOwnActionView } from "./standing-own-action-projection.js";
import { snapshotStandingHistoryTaskIntent } from "./standing-history-task-store.js";
import { requireStandingChronicleNote, type StandingChronicleNote } from "./standing-chronicle-note.js";

export const STANDING_SHARED_CONTEXT_MAX_BYTES = 8192;
export type StandingSharedContextScope = Readonly<{ scopeRef: string; audience:
  Readonly<{ kind: "group" }> | Readonly<{ kind: "requester"; requesterRef: string }> }>;
export type StandingSharedContextCoverage = Readonly<{
  availability: "available" | "unavailable" | "not-configured";
  freshness: "current" | "stale" | "unknown";
  scanned: number; hasMore: boolean | null; omittedAtSource: number | null;
}>;
type Evidence = Readonly<{ sourceRef: string; versionRef: string; observedAt: number | null }>;
export type StandingSharedObservation = Evidence & Readonly<{
  kind: "observed-message" | "explicit-preference"; speakerRef: string; text: string;
}>;
export type StandingSharedDialogue = Evidence & Readonly<{
  kind: "verified-dialogue"; question: Readonly<{ speakerRef: string; text: string }>;
  answer: Readonly<{ text: string }>;
}>;
/** Independent source facts. In particular, a committed node does not imply an
 * observed native result, complete analysis, execution permission or delivery. */
export type StandingSharedTask = Evidence & Readonly<{
  kind: "task-state"; taskRef: string; control: "queued" | "cancelled" | "unavailable";
  description?: Readonly<{ objective: string; fromDate: number; toDate: number; timezone: string }>;
  read: "partial" | "complete" | "inexact" | "unavailable";
  analysis: "none" | "committed" | "unavailable";
  outputPrepared: boolean | "unavailable"; nodeCommitted: boolean | "unavailable";
  modelOutcome: "not-recorded" | "observed" | "refused" | "unknown" | "unavailable";
  delivery: "not-inspected" | "not-attempted" | "partial" | "verified" | "unknown" | "failed-terminal" | "unavailable";
  disposition: "none" | "coverage" | "stale" | "consumed-without-prepared" | "source-page-quota" | "overflow" | "unavailable";
}>;
type Source<T> = Readonly<{ items: readonly T[]; coverage: StandingSharedContextCoverage }>;
export type StandingSharedContextInput = Readonly<{
  scope: StandingSharedContextScope; asOf: number;
  chronicle: Source<StandingSharedObservation | StandingChronicleNote>; dialogues: Source<StandingSharedDialogue>;
  ownActions: Source<StandingOwnActionView>; tasks: Source<StandingSharedTask>;
}>;
type SourceName = "chronicle" | "dialogues" | "ownActions" | "tasks";
type IncludedItem = Readonly<{ source: SourceName; evidence:
  StandingSharedObservation | StandingChronicleNote | StandingSharedDialogue | StandingOwnActionView | StandingSharedTask }>;
type ProjectedCoverage = StandingSharedContextCoverage & Readonly<{
  scope: "observations-only" | "observations-and-analysis-notes" | "selected-dialogues" | "own-action-records" | "selected-task-statuses";
  provided: number; included: number; omittedByBudget: number;
}>;
export type StandingSharedContextSnapshot = Readonly<{
  schema: "standing-shared-context-v1"; scope: StandingSharedContextScope; asOf: number;
  revisionRef: string; items: readonly IncludedItem[];
  coverage: Readonly<Record<SourceName, ProjectedCoverage>>;
  completeChat: false; initiativeEligibility: "not-evaluated";
}>;
const issued = new WeakSet<object>();
const fail = (): never => { throw new Error("STANDING_SHARED_CONTEXT_REFUSED"); };
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) { const d = ds[key]; if (!d || !("value" in d) || !d.enumerable) return fail(); result[key] = d.value; }
  return result;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 32) return fail();
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).length !== value.length + 1) return fail();
  for (let i = 0; i < value.length; i++) { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail(); }
  return Array.from({ length: value.length }, (_, i) => ds[String(i)]!.value);
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}_[0-9a-f]{32,64}$/u.test(value)) return fail();
  return value;
}
function speaker(value: unknown, self = true): string {
  if (typeof value !== "string" || !(self && value === "neurobro") && !/^a_[0-9a-f]{24}$/u.test(value)) return fail();
  return value;
}
function natural(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail(); return value as number;
}
function time(value: unknown): number { const n = natural(value); if (!n || n > 253402300799) return fail(); return n; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") return fail(); return value; }
function taskFact(value: unknown): boolean | "unavailable" { return value === "unavailable" ? value : bool(value); }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) return fail(); return value as T;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value) return fail(); return value;
}
function evidence(v: Record<string, unknown>): Evidence {
  return { sourceRef: ref(v.sourceRef), versionRef: ref(v.versionRef), observedAt: v.observedAt === null ? null : time(v.observedAt) };
}
function scope(value: unknown): StandingSharedContextScope {
  const v = fields(value, ["scopeRef", "audience"]);
  // Read only a descriptor before selecting the exact union member.
  if (!v.audience || typeof v.audience !== "object" || types.isProxy(v.audience)) return fail();
  const kind = Object.getOwnPropertyDescriptor(v.audience, "kind");
  if (!kind || !("value" in kind)) return fail();
  const a = fields(v.audience, kind.value === "requester" ? ["kind", "requesterRef"] : ["kind"]);
  return { scopeRef: ref(v.scopeRef), audience: a.kind === "requester"
    ? { kind: "requester", requesterRef: speaker(a.requesterRef, false) }
    : { kind: choice(a.kind, ["group"]) } };
}
function coverage(value: unknown): StandingSharedContextCoverage {
  const v = fields(value, ["availability", "freshness", "scanned", "hasMore", "omittedAtSource"]);
  const result = { availability: choice(v.availability, ["available", "unavailable", "not-configured"]),
    freshness: choice(v.freshness, ["current", "stale", "unknown"]), scanned: natural(v.scanned),
    hasMore: v.hasMore === null ? null : bool(v.hasMore), omittedAtSource: v.omittedAtSource === null ? null : natural(v.omittedAtSource) };
  if (result.availability !== "available" && (result.freshness !== "unknown" || result.hasMore !== null || result.omittedAtSource !== null || result.scanned !== 0)) return fail();
  return result;
}
function observation(value: unknown): StandingSharedObservation {
  const v = fields(value, ["kind", "sourceRef", "versionRef", "observedAt", "speakerRef", "text"]);
  const kind = choice(v.kind, ["observed-message", "explicit-preference"]);
  return { kind, ...evidence(v), speakerRef: speaker(v.speakerRef, kind !== "explicit-preference"), text: text(v.text) };
}
function chronicleEvidence(value: unknown): StandingSharedObservation | StandingChronicleNote {
  if (value && typeof value === "object" && !types.isProxy(value)) {
    const kind = Object.getOwnPropertyDescriptor(value, "kind");
    if (kind && "value" in kind && kind.value === "model-analysis-notes") return requireStandingChronicleNote(value as StandingChronicleNote);
  }
  return observation(value);
}
function dialogue(value: unknown): StandingSharedDialogue {
  const v = fields(value, ["kind", "sourceRef", "versionRef", "observedAt", "question", "answer"]);
  const q = fields(v.question, ["speakerRef", "text"]), a = fields(v.answer, ["text"]);
  return { kind: choice(v.kind, ["verified-dialogue"]), ...evidence(v), question: { speakerRef: speaker(q.speakerRef, false), text: text(q.text) }, answer: { text: text(a.text) } };
}
function task(value: unknown): StandingSharedTask {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail();
  const hasDescription = Object.hasOwn(value, "description");
  const v = fields(value, ["kind", "sourceRef", "versionRef", "observedAt", "taskRef", "control", "read", "analysis", "outputPrepared", "nodeCommitted", "modelOutcome", "delivery", "disposition", ...(hasDescription ? ["description"] : [])]);
  if (typeof v.taskRef !== "string" || !/^htask_[0-9a-f]{48}$/u.test(v.taskRef)) return fail();
  let description: StandingSharedTask["description"];
  if (hasDescription) {
    const d = fields(v.description, ["objective", "fromDate", "toDate", "timezone"]);
    // Reuse the source's date/timezone/text contract. Placeholder identities
    // are discarded; validation neither authenticates nor creates a task.
    const intent = snapshotStandingHistoryTaskIntent({ schema: "standing-history-task-v1", taskId: v.taskRef,
      accountId: "1", chatId: "-1", requesterId: "2", primaryMessageId: 1, ...d });
    description = { objective: intent.objective, fromDate: intent.fromDate, toDate: intent.toDate, timezone: intent.timezone };
  }
  return { kind: choice(v.kind, ["task-state"]), ...evidence(v), taskRef: v.taskRef,
    ...(description ? { description } : {}),
    control: choice(v.control, ["queued", "cancelled", "unavailable"]), read: choice(v.read, ["partial", "complete", "inexact", "unavailable"]),
    analysis: choice(v.analysis, ["none", "committed", "unavailable"]), outputPrepared: taskFact(v.outputPrepared), nodeCommitted: taskFact(v.nodeCommitted),
    modelOutcome: choice(v.modelOutcome, ["not-recorded", "observed", "refused", "unknown", "unavailable"]),
    delivery: choice(v.delivery, ["not-inspected", "not-attempted", "partial", "verified", "unknown", "failed-terminal", "unavailable"]),
    disposition: choice(v.disposition, ["none", "coverage", "stale", "consumed-without-prepared", "source-page-quota", "overflow", "unavailable"]) };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const v = value as Record<string, unknown>;
  return "{" + Object.keys(v).sort().map(key => JSON.stringify(key) + ":" + canonical(v[key])).join(",") + "}";
}
const names = ["tasks", "ownActions", "dialogues", "chronicle"] as const;
const scopes = { chronicle: "observations-only", dialogues: "selected-dialogues", ownActions: "own-action-records", tasks: "selected-task-statuses" } as const;

/** Pure read-side composition. The caller authenticates records and binds their
 * scope/audience before calling. Hashes and host-supplied provenance labels do
 * not authenticate records. No source/action/model/initiative authority is issued.
 * Tasks precede analysis notes, own actions, dialogues and observations; caller
 * order within each of those groups is priority order. Items are never shortened;
 * an item that does not fit is counted and later smaller items may still fit. */
export function projectStandingSharedContext(input: StandingSharedContextInput,
  options?: Readonly<{ maxBytes?: number }>): StandingSharedContextSnapshot {
  let cap = STANDING_SHARED_CONTEXT_MAX_BYTES;
  if (options !== undefined) {
    // The sole optional field must still be an inert own data property.
    if (!options || typeof options !== "object" || types.isProxy(options)) return fail();
    const keys = Reflect.ownKeys(options);
    const o = fields(options, keys.length === 0 ? [] : ["maxBytes"]);
    if (Object.hasOwn(o, "maxBytes")) cap = natural(o.maxBytes);
    if (cap < 2048 || cap > STANDING_SHARED_CONTEXT_MAX_BYTES) return fail();
  }
  const v = fields(input, ["scope", "asOf", "chronicle", "dialogues", "ownActions", "tasks"]);
  const canonicalScope = scope(v.scope), asOf = time(v.asOf);
  const projected = {} as Record<SourceName, ProjectedCoverage>;
  const inputs = {} as Record<SourceName, readonly IncludedItem["evidence"][]>;
  let provided = 0;
  for (const name of names) {
    const source = fields(v[name], ["items", "coverage"]), c = coverage(source.coverage), raw = list(source.items);
    provided += raw.length; if (provided > 32 || c.availability !== "available" && raw.length !== 0) return fail();
    const parse = name === "tasks" ? task : name === "dialogues" ? dialogue : name === "chronicle" ? chronicleEvidence : snapshotStandingOwnActionView;
    inputs[name] = raw.map(item => parse(item));
    projected[name] = { ...c, scope: scopes[name], provided: raw.length, included: 0, omittedByBudget: raw.length };
    if (name === "chronicle" && inputs[name].some(item => item.kind === "model-analysis-notes")) projected[name] = { ...projected[name], scope: "observations-and-analysis-notes" };
  }
  const seen = new Set<string>();
  const packingOrder: IncludedItem[] = [
    ...inputs.tasks.map(evidence => ({ source: "tasks" as const, evidence })),
    ...inputs.chronicle.filter(item => item.kind === "model-analysis-notes").map(evidence => ({ source: "chronicle" as const, evidence })),
    ...inputs.ownActions.map(evidence => ({ source: "ownActions" as const, evidence })),
    ...inputs.dialogues.map(evidence => ({ source: "dialogues" as const, evidence })),
    ...inputs.chronicle.filter(item => item.kind !== "model-analysis-notes").map(evidence => ({ source: "chronicle" as const, evidence })),
  ];
  for (const { evidence: item } of packingOrder) {
    const identity = "sourceRef" in item ? item.sourceRef : item.actionRef;
    // Conflicting versions must be reconciled by the source reader. Do not
    // quietly select a winner or accidentally double-count the same evidence.
    if (seen.has(identity)) return fail(); seen.add(identity);
    if (item.observedAt !== null && item.observedAt > asOf) return fail();
  }
  const items: IncludedItem[] = [];
  const body = { schema: "standing-shared-context-v1" as const, scope: canonicalScope, asOf, items, coverage: projected,
    completeChat: false as const, initiativeEligibility: "not-evaluated" as const };
  const finish = () => ({ ...body, revisionRef: "sctx_" + createHash("sha256").update(canonical(body)).digest("hex") });
  const fits = () => Buffer.byteLength(JSON.stringify(finish()), "utf8") <= cap;
  if (!fits()) return fail();
  for (const { source: name, evidence: item } of packingOrder) {
    if (items.length === 16) continue;
    items.push({ source: name, evidence: item });
    const prior = projected[name];
    projected[name] = { ...prior, included: prior.included + 1, omittedByBudget: prior.omittedByBudget - 1 };
    if (!fits()) { items.pop(); projected[name] = prior; }
  }
  const result = deepFreeze(finish());
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > cap) return fail();
  issued.add(result); return result;
}

/** Recognizes only deeply frozen snapshots issued here. This establishes
 * composer provenance and immutability, not authentication of source records. */
export function requireStandingSharedContextSnapshot(value: unknown): StandingSharedContextSnapshot {
  if (!value || typeof value !== "object" || !issued.has(value)) return fail();
  return value as StandingSharedContextSnapshot;
}
