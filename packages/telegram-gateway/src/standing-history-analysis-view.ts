import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import type { StandingHistoryAnalysisNode, StandingHistoryAnalysisOutput, StandingHistoryAnalysisSpan } from "./standing-history-analysis-store.js";

type Claim = StandingHistoryAnalysisOutput["claims"][number];
export type StandingHistoryCoverageCommitment = Readonly<{ schema: "standing-history-analysis-coverage-v1";
  spanCount: number; sourceRows: number; emptyPageMarkers: number; commitment: string }>;
export type StandingHistoryNodeNotes = Readonly<{
  schema: "standing-history-node-notes-v1"; nodeRef: string; nodeHash: string; materialRef: string;
  coverage: StandingHistoryCoverageCommitment;
  summary: Readonly<{ text: string; range: Readonly<{ fromByte: number; toByte: number; totalBytes: number }>; complete: boolean }>;
  claims: readonly (Claim & Readonly<{ claimIndex: number }>)[];
  claimRange: Readonly<{ fromClaim: number; toClaim: number; totalClaims: number }>;
  omittedClaimIndices: readonly number[];
  /** Completeness of THIS view of stored notes, never semantic/task completion. */
  detailCoverage: "complete" | "partial";
  /** Null means no remaining notes AFTER this page, not that this page shows all notes. */
  nextPosition: string | null;
  modelAuthoredOmittedDetailCount: number | null;
  claimsStatus: "model-authored-unverified";
  supportScope: "immediate-node-claims-only";
}>;
export type StandingHistoryMergeView = Readonly<{ schema: "standing-history-merge-view-v1";
  children: readonly [StandingHistoryNodeNotes, StandingHistoryNodeNotes]; detailCoverage: "complete" | "partial";
  claimsStatus: "model-authored-unverified" }>;
export type StandingHistoryNodeNotesRequest = Readonly<{ node: StandingHistoryAnalysisNode; referenceKey: string; position?: string; maxBytes?: number }>;
export type StandingHistoryMergeViewRequest = Readonly<{ children: readonly [StandingHistoryAnalysisNode, StandingHistoryAnalysisNode]; referenceKey: string; maxBytes?: number }>;
export class StandingHistoryAnalysisViewError extends Error {
  constructor(readonly code: "input" | "position" | "limit" | "binding") { super("STANDING_HISTORY_ANALYSIS_VIEW_" + code.toUpperCase()); }
}
const fail = (code: StandingHistoryAnalysisViewError["code"]): never => { throw new StandingHistoryAnalysisViewError(code); };
const DOMAIN = "DecadansNeurobro/standing-history-analysis-view/v1", MAX_BYTES = 49152;
const ref = (v: unknown, p: string): v is string => typeof v === "string" && new RegExp("^" + p + "_[0-9a-f]{48}$", "u").test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
function data(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function array(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || types.isProxy(v) || Object.getPrototypeOf(v) !== Array.prototype) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), length = Object.getOwnPropertyDescriptor(v, "length")!.value as number;
  if (length > max || Reflect.ownKeys(ds).length !== length + 1) return fail("input");
  return Array.from({ length }, (_, i) => { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail("input"); return d.value; });
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.includes("\0") || Buffer.byteLength(v) > max || Buffer.from(v).toString("utf8") !== v) return fail("input");
  return v;
}
// Coverage is authenticated by the caller's store. Copy inert JSON before hashing
// so getters, custom toJSON, prototypes or non-finite values cannot execute here.
function inert(v: unknown, depth = 0): unknown {
  if (depth > 8) return fail("input");
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") { if (!Number.isSafeInteger(v)) return fail("input"); return v; }
  if (Array.isArray(v)) return array(v, 32).map(x => inert(x, depth + 1));
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail("input");
  const keys = Object.keys(v); if (keys.length > 32) return fail("input");
  return Object.fromEntries(Object.entries(data(v, keys)).map(([k, x]) => [k, inert(x, depth + 1)]));
}
function snapshot(v: unknown) {
  const n = data(v, ["nodeRef", "kind", "index", "hash", "inputs", "coverage", "output"]);
  if (!ref(n.nodeRef, "hnode") || !digest(n.hash) || !["leaf", "merge"].includes(n.kind as string) || !Number.isInteger(n.index) || Number(n.index) < 1 || Number(n.index) > 1024) return fail("input");
  const o = data(n.output, ["summary", "claims"], ["omittedDetailCount"]), summary = text(o.summary, 4096);
  if (Object.hasOwn(o, "omittedDetailCount") && (!Number.isSafeInteger(o.omittedDetailCount) || Number(o.omittedDetailCount) < 0)) return fail("input");
  const claims = array(o.claims, 16).map(value => {
    const c = data(value, ["kind", "text", "supports"]);
    if (!["reported", "decision", "open-question", "inference"].includes(c.kind as string)) return fail("input");
    const supports = array(c.supports, 16).map(value => { const s = data(value, ["sourceRef", "versionRef"]);
      if (!ref(s.sourceRef, "hsrc") || !ref(s.versionRef, "hver")) return fail("input");
      return Object.freeze({ sourceRef: s.sourceRef, versionRef: s.versionRef }); });
    if (!supports.length || new Set(supports.map(s => s.sourceRef + ":" + s.versionRef)).size !== supports.length) return fail("input");
    return Object.freeze({ kind: c.kind as Claim["kind"], text: text(c.text, 1024), supports: Object.freeze(supports) });
  });
  const spans = array(n.coverage, 8192).map(value => {
    const s = data(value, ["materialRef", "pageIndex", "pageHash", "range", "coverage"]), r = data(s.range, ["fromRow", "toRow", "totalRows"]);
    if (!ref(s.materialRef, "hmat") || !digest(s.pageHash) || !Number.isInteger(s.pageIndex) || Number(s.pageIndex) < 1 || Number(s.pageIndex) > 1024 ||
        [r.fromRow, r.toRow, r.totalRows].some(x => !Number.isInteger(x)) || Number(r.fromRow) < 0 || Number(r.toRow) < Number(r.fromRow) || Number(r.totalRows) < Number(r.toRow) || Number(r.totalRows) > 100) return fail("input");
    return { ...s, range: r, coverage: inert(s.coverage) } as unknown as StandingHistoryAnalysisSpan;
  });
  const coverage: StandingHistoryCoverageCommitment = Object.freeze({ schema: "standing-history-analysis-coverage-v1", spanCount: spans.length,
    sourceRows: spans.reduce((sum, s) => sum + s.range.toRow - s.range.fromRow, 0), emptyPageMarkers: spans.filter(s => s.range.totalRows === 0).length, commitment: hash(spans) });
  return { nodeRef: n.nodeRef, nodeHash: n.hash, summary, claims, coverage,
    modelAuthoredOmittedDetailCount: Object.hasOwn(o, "omittedDetailCount") ? o.omittedDetailCount as number : null };
}
function budget(v: unknown) { if (v === undefined) return MAX_BYTES;
  if (!Number.isSafeInteger(v) || Number(v) < 1024 || Number(v) > MAX_BYTES) return fail("input"); return Number(v); }

/** Pure views of already authenticated store nodes; supplied hashes are NOT
 * authentication. Host resolves nodes and owns the key. No file/Telegram/model
 * capability is created. Claims prove immediate-node support membership only;
 * omitted descendants do not become admissible ancestor supports by reading. */
export function readNodeNotes(value: StandingHistoryNodeNotesRequest): StandingHistoryNodeNotes {
  const args = data(value, ["node", "referenceKey"], ["position", "maxBytes"]), maxBytes = budget(args.maxBytes);
  if (!digest(args.referenceKey) || Object.hasOwn(args, "position") && (typeof args.position !== "string" || !/^hnpos_(?:0|[1-9]\d{0,3})_(?:0|[1-9]\d?)_[0-9a-f]{48}$/u.test(args.position))) return fail("input");
  const n = snapshot(args.node), key = Buffer.from(args.referenceKey, "hex");
  try {
    const scope = hash(n), mac = (kind: string, offsets: readonly number[]) => createHmac("sha256", key).update(canonical([DOMAIN, kind, scope, offsets])).digest("hex").slice(0, 48);
    const token = (s: number, c: number) => "hnpos_" + s + "_" + c + "_" + mac("position", [s, c]);
    const utf8 = Buffer.from(n.summary), boundaries = [0]; let offset = 0;
    for (const ch of n.summary) { offset += Buffer.byteLength(ch); boundaries.push(offset); }
    let startByte = 0, startClaim = 0;
    if (Object.hasOwn(args, "position")) {
      const supplied = args.position as string; startByte = Number(supplied.split("_")[1]); startClaim = Number(supplied.split("_")[2]);
      const expected = token(startByte, startClaim);
      if (!boundaries.includes(startByte) || startClaim > n.claims.length || startByte === utf8.length && startClaim === n.claims.length ||
          supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return fail("position");
    }
    const page = (endByte: number, endClaim: number): StandingHistoryNodeNotes => {
      const summaryComplete = startByte === 0 && endByte === utf8.length, allClaims = startClaim === 0 && endClaim === n.claims.length;
      return Object.freeze({ schema: "standing-history-node-notes-v1", nodeRef: n.nodeRef, nodeHash: n.nodeHash,
        materialRef: "hnote_" + mac("material", [startByte, endByte, startClaim, endClaim]), coverage: n.coverage,
        summary: Object.freeze({ text: utf8.subarray(startByte, endByte).toString("utf8"), range: Object.freeze({ fromByte: startByte, toByte: endByte, totalBytes: utf8.length }), complete: summaryComplete }),
        claims: Object.freeze(n.claims.slice(startClaim, endClaim).map((claim, i) => Object.freeze({ claimIndex: startClaim + i, ...claim }))),
        claimRange: Object.freeze({ fromClaim: startClaim, toClaim: endClaim, totalClaims: n.claims.length }),
        omittedClaimIndices: Object.freeze(n.claims.flatMap((_, i) => i < startClaim || i >= endClaim ? [i] : [])),
        detailCoverage: summaryComplete && allClaims ? "complete" : "partial",
        nextPosition: endByte === utf8.length && endClaim === n.claims.length ? null : token(endByte, endClaim),
        modelAuthoredOmittedDetailCount: n.modelAuthoredOmittedDetailCount, claimsStatus: "model-authored-unverified", supportScope: "immediate-node-claims-only" });
    };
    // Reserve room for atomic claims even when summary JSON escaping expands 6x.
    // Offsets advance independently, so subsequent pages retrieve BOTH suffixes.
    let endByte = startByte, endClaim = startClaim;
    const summaryBudget = Math.min(8192, Math.floor(maxBytes / 3));
    const candidates = boundaries.filter(b => b > startByte);
    let low = 0, high = candidates.length;
    while (low < high) { const middle = Math.ceil((low + high) / 2), b = candidates[middle - 1]!;
      const candidate = page(b, endClaim);
      if (bytes(candidate.summary) <= summaryBudget && bytes(candidate) <= maxBytes) low = middle; else high = middle - 1;
    }
    if (low) endByte = candidates[low - 1]!;
    while (endClaim < n.claims.length && bytes(page(endByte, endClaim + 1)) <= maxBytes) endClaim++;
    const result = page(endByte, endClaim);
    if (endByte === startByte && endClaim === startClaim || bytes(result) > maxBytes) return fail("limit");
    return result;
  } finally { key.fill(0); }
}

/** Both children remain represented, including independent omission metadata.
 * Original notes stay in the ledger. Use each child's nextPosition with the
 * authenticated same child and readNodeNotes; no child-selector authority here. */
export function projectMergeView(value: StandingHistoryMergeViewRequest): StandingHistoryMergeView {
  const args = data(value, ["children", "referenceKey"], ["maxBytes"]), maxBytes = budget(args.maxBytes), nodes = array(args.children, 2);
  if (nodes.length !== 2 || !digest(args.referenceKey)) return fail("input");
  // Account for the entire wrapper before fairly allocating the remaining bytes.
  const envelope = { schema: "standing-history-merge-view-v1", children: [] as unknown[], detailCoverage: "complete", claimsStatus: "model-authored-unverified" };
  const childBudget = Math.floor((maxBytes - bytes(envelope) - 1) / 2);
  if (childBudget < 1024) return fail("limit");
  const children = nodes.map(node => readNodeNotes({ node: node as StandingHistoryAnalysisNode, referenceKey: args.referenceKey as string, maxBytes: childBudget })) as [StandingHistoryNodeNotes, StandingHistoryNodeNotes];
  if (children[0].nodeRef === children[1].nodeRef) return fail("binding");
  const result: StandingHistoryMergeView = Object.freeze({ schema: "standing-history-merge-view-v1", children: Object.freeze(children),
    detailCoverage: children.every(c => c.detailCoverage === "complete") ? "complete" : "partial", claimsStatus: "model-authored-unverified" });
  if (bytes(result) > maxBytes) return fail("limit"); return result;
}
