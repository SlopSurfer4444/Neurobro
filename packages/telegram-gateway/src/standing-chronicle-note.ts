import { createHmac } from "node:crypto";
import { types } from "node:util";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import type { StandingHistoryAnalysisPlan } from "./standing-history-analysis-planner.js";
import type { StandingHistoryAnalysisNode } from "./standing-history-analysis-store.js";
import { readNodeNotes, type StandingHistoryNodeNotes } from "./standing-history-analysis-view.js";

type Ready = Extract<StandingHistoryAnalysisPlan, { kind: "analysis-ready" }>;
export type StandingChronicleNote = Readonly<{
  kind: "model-analysis-notes"; sourceRef: string; versionRef: string; observedAt: null; taskRef: string;
  period: Readonly<{ fromDate: number; toDate: number; timezone: string }>;
  notes: Omit<StandingHistoryNodeNotes, "nextPosition">;
  hasMoreNotes: boolean;
  sourceCoverage: Ready["coverage"];
  sourceGaps: Ready["gaps"];
}>;
export type StandingChronicleNoteOwner = Readonly<{ accountId: string; peerId: string; requesterId: string }>;
const owners = new WeakMap<object, StandingChronicleNoteOwner>();
const fail = (): never => { throw new Error("STANDING_CHRONICLE_NOTE_REFUSED"); };
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const count = (v: unknown, max: number) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, any> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail();
  const out: Record<string, unknown> = {};
  for (const k of keys as string[]) { const d = ds[k]!; if (!("value" in d) || !d.enumerable) return fail(); out[k] = d.value; }
  return out;
}
function readyCopy(value: unknown): Ready & Readonly<{ rootRef: string }> {
  const r = data(value, ["kind", "sourceHead", "expectedHead", "rootRef", "coverage", "gaps"]);
  if (r.kind !== "analysis-ready" || !digest(r.sourceHead) || !digest(r.expectedHead) || typeof r.rootRef !== "string" || !/^hnode_[0-9a-f]{48}$/.test(r.rootRef)) return fail();
  const c = data(r.coverage, ["committedPages", "coveredPages", "sourceRows", "coveredRows", "readStatus", "readTraversalComplete", "excluded"]);
  if (!count(c.committedPages, 1024) || c.coveredPages !== c.committedPages || !count(c.sourceRows, 102400) || c.coveredRows !== c.sourceRows ||
      !["empty-page", "lower-bound-reached", "inaccessible"].includes(c.readStatus) || typeof c.readTraversalComplete !== "boolean") return fail();
  const excluded = data(c.excluded, ["nonText", "invalidText", "unavailable", "outsidePeriod"]);
  if (Object.values(excluded).some(v => !count(v, 102400))) return fail();
  if (!Array.isArray(r.gaps) || types.isProxy(r.gaps) || Object.getPrototypeOf(r.gaps) !== Array.prototype) return fail();
  const ds = Object.getOwnPropertyDescriptors(r.gaps), length = Object.getOwnPropertyDescriptor(r.gaps, "length")!.value;
  if (!count(length, 7) || Reflect.ownKeys(ds).length !== length + 1) return fail();
  const allowed = ["inaccessible-history", "inexact-history", "undated-entries", "nonText", "invalidText", "unavailable", "outsidePeriod"];
  const gaps: Ready["gaps"][number][] = [];
  for (let i = 0; i < length; i++) {
    const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail();
    const g = data(d.value, ["kind"], ["count"]);
    if (typeof g.kind !== "string" || !allowed.includes(g.kind) || Object.hasOwn(g, "count") && (!count(g.count, 102400) || g.count === 0)) return fail();
    gaps.push(Object.freeze({ kind: g.kind, ...(Object.hasOwn(g, "count") ? { count: g.count as number } : {}) }));
  }
  if (new Set(gaps.map(g => g.kind)).size !== gaps.length) return fail();
  return Object.freeze({ kind: "analysis-ready", sourceHead: r.sourceHead, expectedHead: r.expectedHead, rootRef: r.rootRef,
    coverage: Object.freeze({ ...c, excluded: Object.freeze(excluded) }) as Ready["coverage"], gaps: Object.freeze(gaps) });
}
/** Preflight inert metadata only. The existing view owns output/support validation
 * and truncation. This avoids invoking nested proxies through its array helpers;
 * it neither copies expanded coverage nor treats its claimed hash as proof. */
function inertNode(value: unknown): void {
  let bytes = 0, nodes = 0;
  const charge = (n: number) => { if ((bytes += n) > 16 * 1024 * 1024) return fail(); };
  const walk = (v: unknown, depth: number): void => {
    if (++nodes > 524288 || depth > 14) return fail();
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) { charge(JSON.stringify(v).length); return; }
    if (typeof v === "string") { if (v.length > 16384) return fail(); charge(Buffer.byteLength(JSON.stringify(v))); return; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail();
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(v, "length")!.value;
      if (!count(length, 8192) || keys.length !== length + 1) return fail(); charge(2 + Math.max(0, length - 1));
      for (let i = 0; i < length; i++) { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail(); walk(d.value, depth + 1); }
    } else {
      if (keys.length > 64) return fail(); charge(2 + Math.max(0, keys.length - 1));
      for (const k of keys) { if (typeof k !== "string" || k.length > 128 || ["__proto__", "constructor", "prototype"].includes(k)) return fail();
        const d = ds[k]!; if (!("value" in d) || !d.enumerable) return fail(); charge(Buffer.byteLength(JSON.stringify(k)) + 1); walk(d.value, depth + 1); }
    }
  };
  walk(value, 0);
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}

/** Pure projection of a trusted host's authenticated store node and planner
 * readiness. Caller owns their correspondence to fresh source/analysis heads;
 * supplied hashes and a matching root reference do not authenticate a node or
 * prove complete source coverage, semantic accuracy, delivery, or task completion.
 * Notes remain model-authored-unverified and carry the original coverage gaps. */
export function projectStandingChronicleNote(input: Readonly<{
  intent: StandingHistoryTaskIntent; readiness: Ready; node: StandingHistoryAnalysisNode; referenceKey: string;
}>): StandingChronicleNote {
  const args = data(input, ["intent", "readiness", "node", "referenceKey"]);
  const intent = snapshotStandingHistoryTaskIntent(args.intent), readiness = readyCopy(args.readiness);
  if (!digest(args.referenceKey)) return fail();
  inertNode(args.node);
  const node = data(args.node, ["nodeRef", "kind", "index", "hash", "inputs", "coverage", "output"]);
  if (node.nodeRef !== readiness.rootRef) return fail();
  const projected = readNodeNotes({ node: args.node as StandingHistoryAnalysisNode, referenceKey: args.referenceKey, maxBytes: 4096 });
  const { nextPosition, ...remaining } = projected, notes = Object.freeze(remaining);
  const payload = { kind: "model-analysis-notes" as const, observedAt: null, taskRef: intent.taskId,
    period: Object.freeze({ fromDate: intent.fromDate, toDate: intent.toDate, timezone: intent.timezone }), notes,
    hasMoreNotes: nextPosition !== null, sourceCoverage: readiness.coverage, sourceGaps: readiness.gaps };
  const key = Buffer.from(args.referenceKey, "hex");
  try {
    const mac = (domain: string, value: unknown) => createHmac("sha256", key).update(canonical(["DecadansNeurobro/chronicle-note/v1", domain, value])).digest("hex").slice(0, 48);
    const sourceRef = "chron_" + mac("source", intent);
    const versionRef = "chver_" + mac("version", { sourceRef, sourceHead: readiness.sourceHead, analysisHead: readiness.expectedHead, rootRef: node.nodeRef, rootHash: node.hash, payload });
    const result = Object.freeze({ ...payload, sourceRef, versionRef });
    if (Buffer.byteLength(JSON.stringify(notes)) > 4096 || Buffer.byteLength(JSON.stringify(result)) > 6144) return fail();
    owners.set(result, Object.freeze({ accountId: intent.accountId, peerId: intent.chatId, requesterId: intent.requesterId }));
    return result;
  } finally { key.fill(0); }
}

/** Issuance is a host-context capability only, never a send or notes-page tool. */
export function requireStandingChronicleNote(note: StandingChronicleNote, owner?: StandingChronicleNoteOwner): StandingChronicleNote {
  if (!note || typeof note !== "object" || types.isProxy(note)) return fail();
  const actual = owners.get(note); if (!actual) return fail();
  if (owner !== undefined) {
    const expected = data(owner, ["accountId", "peerId", "requesterId"]);
    if (expected.accountId !== actual.accountId || expected.peerId !== actual.peerId || expected.requesterId !== actual.requesterId) return fail();
  }
  return note;
}
