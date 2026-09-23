import { MATERIAL_BYTES, LEGACY_MATERIAL_BYTES, MAX_FRAGMENTS } from "./standing-history-analysis-limits.js";
import { types } from "node:util";
import { snapshotSelfHistoryTaskCheckpoint, type SelfHistoryTaskCheckpoint } from "./self-history-reader.js";
import { snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskPage, standingHistoryTaskSourcePeerId, type StandingHistoryTaskIntent, type StandingHistoryTaskStore, type StandingHistoryStoredPage } from "./standing-history-task-store.js";
import { type StandingHistoryAnalysisStore, type StandingHistoryAnalysisNode, type StandingHistoryAnalysisSpan, type StandingHistoryAnalysisMaterialRequest } from "./standing-history-analysis-store.js";
import { projectStandingHistorySource, type StandingHistorySourceFragment } from "./standing-history-source-projection.js";
import { projectMergeView, readNodeNotes, StandingHistoryAnalysisViewError, type StandingHistoryMergeView, type StandingHistoryNodeNotes } from "./standing-history-analysis-view.js";

type Heads = Readonly<{ sourceHead: string; expectedHead: string }>;
export type StandingHistorySourceBatch = Readonly<{ schema: "standing-history-source-batch-v1"; fragments: readonly StandingHistorySourceFragment[] }>;
export type StandingHistoryAnalysisPlan =
  | (Heads & Readonly<{ kind: "leaf"; inputs: readonly [StandingHistoryAnalysisMaterialRequest, ...StandingHistoryAnalysisMaterialRequest[]]; material: StandingHistorySourceFragment | StandingHistorySourceBatch }>)
  | (Heads & Readonly<{ kind: "merge"; viewMaxBytes?: number; children: readonly [string, string, ...string[]]; materials: StandingHistoryMergeView["children"] }>)
  | (Heads & Readonly<{ kind: "read-more"; checkpoint: SelfHistoryTaskCheckpoint }>)
  | (Heads & Readonly<{ kind: "analysis-ready"; rootRef?: string; coverage: Readonly<{ committedPages: number; coveredPages: number; sourceRows: number; coveredRows: number; readStatus: SelfHistoryTaskCheckpoint["status"]; readTraversalComplete: boolean; excluded: Readonly<{ nonText: number; invalidText: number; unavailable: number; outsidePeriod: number }> }>; gaps: readonly Readonly<{ kind: string; count?: number }>[] }>)
  | Readonly<{ kind: "scan-more"; progress: Readonly<{ nodesScanned: number; totalNodes: number; pagesScanned: number; totalPages: number }> }>
  | Readonly<{ kind: "blocked"; reason: string }>;
export type StandingHistoryAnalysisPlanner = Readonly<{ next(): Promise<StandingHistoryAnalysisPlan>; close(): Promise<void> }>;
type NodeMeta = Pick<StandingHistoryAnalysisNode, "nodeRef" | "index" | "hash"> & { first: number; weight: number; children: readonly string[] };
type PageMeta = { hash: string; total: number; excluded: StandingHistorySourceFragment["coverage"]["sourcePageExcluded"] };
const fail = (): never => { throw new Error("STANDING_HISTORY_PLANNER_INPUT"); };
// Trusted host capabilities still receive inert arguments and their returned data
// is detached before another await. Never invoke getters, proxies or toJSON.
function copy<T>(value: T): T {
  let budget = 16 * 1024 * 1024;
  function visit(v: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 40) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) return fail(); return v; }
    if (typeof v === "string") { budget -= Buffer.byteLength(v); if (budget < 0) return fail(); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    const a = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (a ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail();
    const result: Record<string, unknown> | unknown[] = a ? [] : {};
    for (const k of Reflect.ownKeys(v)) {
      if (a && k === "length") continue;
      if (typeof k !== "string" || k === "__proto__") return fail();
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!("value" in d) || !d.enumerable) return fail();
      Object.defineProperty(result, k, { value: visit(d.value, depth + 1), enumerable: true });
    }
    return Object.freeze(result);
  }
  return visit(value, 0) as T;
}
function method<T extends (...args: never[]) => unknown>(v: unknown, name: string): T {
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
  const d = Object.getOwnPropertyDescriptor(v, name);
  if (!d || !("value" in d) || typeof d.value !== "function") return fail();
  return d.value.bind(v) as T;
}
const digest = (v: string) => /^[0-9a-f]{64}$/u.test(v);

/** Host-private deterministic selector. At most eight host read/projection
 * calls per next call; stores may perform nested custody reads/projections.
 * Retains bounded metadata, one raw page and one policy-bounded source batch
 * or one bounded merge-note packet plus at most two raw nodes in large mode
 * (historical wide mode retains its bounded cohort). Issuing a plan
 * commits nothing and grants no model invocation/retry or delivery authority.
 * Ready means the stored available material has a reduction root, not that
 * model claims are true or a full Telegram archive has been reconstructed. */
function createWideStandingHistoryAnalysisPlanner(input: Readonly<{
  intent: StandingHistoryTaskIntent;
  source: Pick<StandingHistoryTaskStore, "status" | "readPage">;
  analysis: Pick<StandingHistoryAnalysisStore, "status" | "readNodeAt" | "referenceKey">;
  signal?: AbortSignal; packing?: "wide" | "large";
}>): StandingHistoryAnalysisPlanner {
  if (!input || types.isProxy(input)) return fail();
  const ds = Object.getOwnPropertyDescriptors(input);
  for (const d of Object.values(ds)) if (!("value" in d)) return fail();
  const intent = snapshotStandingHistoryTaskIntent(ds.intent?.value);
  const sourceStatus = method<StandingHistoryTaskStore["status"]>(ds.source?.value, "status");
  const readPage = method<StandingHistoryTaskStore["readPage"]>(ds.source?.value, "readPage");
  const analysisStatus = method<StandingHistoryAnalysisStore["status"]>(ds.analysis?.value, "status");
  const readNodeAt = method<StandingHistoryAnalysisStore["readNodeAt"]>(ds.analysis?.value, "readNodeAt");
  let key = method<StandingHistoryAnalysisStore["referenceKey"]>(ds.analysis?.value, "referenceKey")();
  if (typeof key !== "string" || !digest(key)) return fail();
  const large = ds.packing?.value === "large", materialBytes = large ? MATERIAL_BYTES : LEGACY_MATERIAL_BYTES, maxFragments = large ? MAX_FRAGMENTS : 8;
  const signal = ds.signal?.value as AbortSignal | undefined;
  if (signal && (types.isProxy(signal) || !(signal instanceof AbortSignal))) return fail();
  let closed = false, active: Promise<StandingHistoryAnalysisPlan> | undefined;
  let knownSourceHead = "", knownAnalysisHead = "", sourceCount = 0, nodeCount = 0;
  const nodes: NodeMeta[] = [], refs = new Map<string, NodeMeta>(), children = new Set<string>();
  const spans = new Map<number, StandingHistoryAnalysisSpan[]>(), pages = new Map<number, PageMeta>();
  let scanPage = 1, current: StandingHistoryStoredPage | undefined, position: string | undefined, offset = 0;
  let pending: StandingHistoryAnalysisPlan | undefined;
  const mergeNodes: StandingHistoryAnalysisNode[] = [];
  let mergeCount = 0;
  const largeMergeNotes: StandingHistoryNodeNotes[] = [];
  let largeMergeFirst: StandingHistoryAnalysisNode | undefined, largeMergePending: StandingHistoryAnalysisNode | undefined, largeMergeBytes = 0;
  const mergeEnvelopeBytes = Buffer.byteLength(JSON.stringify({ schema: "standing-history-merge-view-v1", children: [], detailCoverage: "complete", claimsStatus: "model-authored-unverified" }));
  const leafInputs: StandingHistoryAnalysisMaterialRequest[] = [], leafFragments: StandingHistorySourceFragment[] = [];
  const guard = () => { if (closed || signal?.aborted) throw new Error("STANDING_HISTORY_PLANNER_CLOSED"); };
  const resetMerge = () => { mergeNodes.length = 0; mergeCount = 0; largeMergeNotes.length = 0; largeMergeFirst = undefined; largeMergePending = undefined; largeMergeBytes = 0; };
  const resetPacking = () => { resetMerge(); leafInputs.length = 0; leafFragments.length = 0; };
  const reset = () => { nodes.length = 0; refs.clear(); children.clear(); spans.clear(); pages.clear(); current = undefined; position = undefined; offset = 0; scanPage = 1; pending = undefined; resetPacking(); };
  const scan = (): StandingHistoryAnalysisPlan => ({ kind: "scan-more", progress: { nodesScanned: nodes.length, totalNodes: nodeCount, pagesScanned: pages.size, totalPages: sourceCount } });
  const blocked = (reason: string): StandingHistoryAnalysisPlan => ({ kind: "blocked", reason });
  function covered(index: number, total: number): boolean {
    const list = spans.get(index) ?? [];
    if (!total) return list.length === 1 && list[0]!.range.totalRows === 0;
    let end = 0;
    for (const s of [...list].sort((a, b) => a.range.fromRow - b.range.fromRow)) { if (s.range.fromRow !== end) return false; end = s.range.toRow; }
    return end === total;
  }
  function admit(node: StandingHistoryAnalysisNode, index: number) {
    if (node.index !== index || !digest(node.hash) || !/^hnode_[0-9a-f]{48}$/u.test(node.nodeRef) || refs.has(node.nodeRef)) return fail();
    const meta: NodeMeta = { nodeRef: node.nodeRef, index, hash: node.hash, weight: 1,
      first: Math.min(...node.coverage.map(v => v.pageIndex * 1000 + v.range.fromRow)),
      children: "children" in node.inputs ? node.inputs.children : [] };
    if (node.kind === "merge" && "children" in node.inputs) {
      for (const ref of node.inputs.children) { if (!refs.has(ref)) return fail(); children.add(ref); }
      meta.weight = node.inputs.children.reduce((total, ref) => total + refs.get(ref)!.weight, 0);
    } else if (node.kind === "leaf" && "materials" in node.inputs) {
      for (const s of node.coverage) {
        if (s.pageIndex < 1 || s.pageIndex > sourceCount) return fail();
        const list = spans.get(s.pageIndex) ?? [];
        if (list.some(p => p.pageHash !== s.pageHash || p.range.totalRows !== s.range.totalRows || s.range.totalRows === 0 || Math.max(p.range.fromRow, s.range.fromRow) < Math.min(p.range.toRow, s.range.toRow))) return fail();
        list.push(s); spans.set(s.pageIndex, list);
      }
    } else return fail();
    nodes.push(meta); refs.set(meta.nodeRef, meta);
  }
  async function run(): Promise<StandingHistoryAnalysisPlan> {
    guard();
    const s = copy(await sourceStatus()); guard();
    const a = copy(await analysisStatus()); guard();
    const checkpoint = snapshotSelfHistoryTaskCheckpoint(s.readProgress.checkpoint);
    if (checkpoint.accountId !== intent.accountId || checkpoint.chatId !== standingHistoryTaskSourcePeerId(intent) || checkpoint.fromDate !== intent.fromDate || checkpoint.toDate !== intent.toDate) return blocked("binding");
    if (s.storage !== "ready" || a.storage !== "ready") return blocked("tail-refused");
    if (!digest(s.readProgress.chainHash) || !digest(a.headHash) || !Number.isInteger(s.readProgress.committedPages) || s.readProgress.committedPages < 0 || s.readProgress.committedPages > 1024 || !Number.isInteger(a.analysisNodes) || a.analysisNodes < 0 || a.analysisNodes > 1024) return blocked("binding");
    const changed = knownSourceHead !== s.readProgress.chainHash || knownAnalysisHead !== a.headHash;
    if (changed) {
      if (s.readProgress.committedPages < sourceCount || a.analysisNodes < nodeCount || knownSourceHead && s.readProgress.committedPages === sourceCount && knownSourceHead !== s.readProgress.chainHash || knownAnalysisHead && a.analysisNodes === nodeCount && knownAnalysisHead !== a.headHash) reset();
      pending = undefined; resetPacking(); scanPage = 1; position = undefined; offset = 0;
      if (current?.index !== scanPage) current = undefined;
    }
    knownSourceHead = s.readProgress.chainHash; knownAnalysisHead = a.headHash;
    sourceCount = s.readProgress.committedPages; nodeCount = a.analysisNodes;
    const heads = { sourceHead: knownSourceHead, expectedHead: knownAnalysisHead };
    const leafMaterial = (): StandingHistorySourceFragment | StandingHistorySourceBatch => leafFragments.length === 1 ? leafFragments[0]!
      : { schema: "standing-history-source-batch-v1", fragments: [...leafFragments] };
    const leafPlan = (): StandingHistoryAnalysisPlan => ({ kind: "leaf", ...heads, inputs: [...leafInputs] as [StandingHistoryAnalysisMaterialRequest, ...StandingHistoryAnalysisMaterialRequest[]], material: leafMaterial() });
    let budget = 4, candidate = pending;
    while (!candidate && budget > 0) {
      if (nodes.length < nodeCount) {
        budget--; const node = copy(await readNodeAt(nodes.length + 1)); guard();
        if (!node) { candidate = blocked("node-unavailable"); break; }
        admit(node, nodes.length + 1); continue;
      }
      if (scanPage <= sourceCount) {
        const meta = pages.get(scanPage);
        if (meta && covered(scanPage, meta.total)) { scanPage++; current = undefined; position = undefined; offset = 0; continue; }
        if (!current || current.index !== scanPage) {
          budget--; const p = copy(await readPage(scanPage)); guard();
          if (!p || p.index !== scanPage || !digest(p.hash)) { candidate = blocked("page-unavailable"); break; }
          current = Object.freeze({ index: p.index, hash: p.hash, result: snapshotStandingHistoryTaskPage(p.result, intent) });
          if ((spans.get(scanPage) ?? []).some(v => v.pageHash !== p.hash || v.range.totalRows !== p.result.sources.length)) { candidate = blocked("page-binding"); break; }
          pages.set(scanPage, { hash: p.hash, total: p.result.sources.length, excluded: p.result.page.excluded });
          position = undefined; offset = 0; continue;
        }
        const total = current.result.sources.length, list = spans.get(scanPage) ?? [];
        const existing = list.find(v => v.range.fromRow <= offset && v.range.toRow > offset);
        const boundary = existing?.range.toRow ?? Math.min(total, ...list.filter(v => v.range.fromRow > offset).map(v => v.range.fromRow));
        const maxRows = Math.max(1, Math.min(100, boundary - offset));
        // Descriptors carry the exact projection budget, so the existing store
        // can reproduce every fragment without a new persistent schema. No row
        // is cropped, flattened, skipped or stripped of source metadata.
        const envelopeBytes = Buffer.byteLength(JSON.stringify({ schema: "standing-history-source-batch-v1", fragments: leafFragments }));
        const maxBytes = existing || !leafFragments.length ? materialBytes : materialBytes - envelopeBytes - 1;
        if (!existing && maxBytes < 1024) { candidate = leafPlan(); break; }
        let material: StandingHistorySourceFragment;
        budget--;
        try { material = projectStandingHistorySource({ intent, referenceKey: key, storedPage: current, maxBytes, maxRows, ...(position ? { position } : {}) }); }
        catch (error) {
          if (leafFragments.length && !existing && error instanceof Error && error.message === "STANDING_HISTORY_SOURCE_LIMIT") { candidate = leafPlan(); break; }
          throw error;
        }
        if (!existing && !(total === 0 && covered(scanPage, total))) {
          if (a.limits.nodeQuotaReached) { candidate = blocked("analysis-node-quota"); break; }
          const descriptor = { pageIndex: scanPage, maxBytes, maxRows, materialRef: material.materialRef, ...(position ? { position } : {}) };
          leafInputs.push(descriptor); leafFragments.push(material);
        }
        position = material.nextPosition ?? undefined; offset = material.range.toRow;
        if (!material.nextPosition) { scanPage++; current = undefined; offset = 0; }
        // A fragmented page already filled the available budget. Flush before
        // its next row rather than splitting one message to fill a batch.
        if (leafFragments.length && (leafFragments.length === maxFragments || !existing && material.nextPosition !== null)) { candidate = leafPlan(); break; }
        continue;
      }
      if (leafFragments.length) {
        // Gather more source before spending a model turn on a small partial
        // batch. The fragment count and byte budget bound lookahead.
        if (checkpoint.status === "more" && !s.limits.pageQuotaReached) candidate = { kind: "read-more", ...heads, checkpoint };
        else candidate = leafPlan();
        break;
      }
      if (large && checkpoint.status === "more" && !s.limits.pageQuotaReached) { candidate = { kind: "read-more", ...heads, checkpoint }; break; }
      const roots = nodes.filter(n => !children.has(n.nodeRef)).sort((x, y) => x.first - y.first);
      // A ledger may retain alternate reductions of the same children. Such a
      // DAG is valid storage, but cannot be treated as a disjoint ready forest.
      const ownedLeaves = new Set<string>();
      const visit = (n: NodeMeta): boolean => {
        if (!n.children.length) { if (ownedLeaves.has(n.nodeRef)) return false; ownedLeaves.add(n.nodeRef); return true; }
        return n.children.every(ref => visit(refs.get(ref)!));
      };
      if (!roots.every(visit)) { candidate = blocked("overlapping-analysis-roots"); break; }
      // Production considers the entire actual frontier. The legacy wide route
      // retains its historical scheduling for old callers; neither its cohort
      // size nor the structural ledger capacity limits new byte-based packing.
      let group: readonly NodeMeta[] | undefined = large && roots.length >= 2 ? roots : undefined;
      for (let i = 0; !large && i + 1 < roots.length; i++) {
        const candidateGroup = roots.slice(i, i + 8);
        if (checkpoint.status === "more" && (candidateGroup.length !== 8 || candidateGroup.some(n => Math.floor(Math.log(n.weight) / Math.log(8)) !== Math.floor(Math.log(candidateGroup[0]!.weight) / Math.log(8))))) continue;
        if (!group || candidateGroup.length > group.length || candidateGroup.length === group.length && candidateGroup.reduce((sum, n) => sum + n.weight, 0) < group.reduce((sum, n) => sum + n.weight, 0)) group = candidateGroup;
      }
      if (group) {
        if (a.limits.nodeQuotaReached) { candidate = blocked("analysis-node-quota"); break; }
        if (large) {
          // Keep only projected notes that fit the actual packet, plus at most
          // the first/pending raw nodes needed for the existing pair fallback.
          // One read or pure projection consumes each bounded work slot.
          if (!largeMergePending) {
            budget--; const meta = group[largeMergeNotes.length]!, node = copy(await readNodeAt(meta.index)); guard();
            if (!node || node.hash !== meta.hash || node.nodeRef !== meta.nodeRef) { candidate = blocked("node-unavailable"); break; }
            largeMergePending = node; continue;
          }
          budget--;
          let selected: readonly StandingHistoryNodeNotes[] | undefined;
          if (largeMergeNotes.length === 1) {
            const pair = projectMergeView({ children: [largeMergeFirst!, largeMergePending], referenceKey: key, maxBytes: materialBytes, preferComplete: true });
            largeMergeNotes.splice(0, 1, ...pair.children);
            largeMergeBytes = pair.children.reduce((sum, note) => sum + Buffer.byteLength(JSON.stringify(note)), 0);
            if (pair.detailCoverage !== "complete") selected = pair.children;
            largeMergeFirst = undefined;
          } else {
            const note = readNodeNotes({ node: largeMergePending, referenceKey: key, maxBytes: materialBytes });
            const noteBytes = Buffer.byteLength(JSON.stringify(note));
            const fits = note.detailCoverage === "complete" && mergeEnvelopeBytes + largeMergeBytes + noteBytes + largeMergeNotes.length <= materialBytes;
            if (largeMergeNotes.length >= 2 && !fits) selected = largeMergeNotes;
            else { if (!largeMergeNotes.length) largeMergeFirst = largeMergePending; largeMergeNotes.push(note); largeMergeBytes += noteBytes; }
          }
          largeMergePending = undefined;
          if (!selected && largeMergeNotes.length === group.length) selected = largeMergeNotes;
          if (selected) {
            candidate = { kind: "merge", ...heads, viewMaxBytes: materialBytes, children: selected.map(n => n.nodeRef) as [string, string, ...string[]], materials: [selected[0]!, selected[1]!, ...selected.slice(2)] };
            resetMerge(); break;
          }
          continue;
        }
        if (mergeNodes.some((n, i) => n.nodeRef !== group![i]?.nodeRef || n.hash !== group![i]?.hash)) resetMerge();
        if (mergeNodes.length < group.length) {
          budget--; const meta = group[mergeNodes.length]!, node = copy(await readNodeAt(meta.index)); guard();
          if (!node || node.hash !== meta.hash || node.nodeRef !== meta.nodeRef) { candidate = blocked("node-unavailable"); break; }
          mergeNodes.push(node); continue;
        }
        // Preserve historical wide selection and omission/continuation exactly.
        budget--;
        if (!mergeCount) mergeCount = mergeNodes.length;
        let view: StandingHistoryMergeView | undefined;
        try { view = projectMergeView({ children: mergeNodes.slice(0, mergeCount), referenceKey: key, preferComplete: true, ...(large ? { maxBytes: materialBytes } : {}) }); }
        catch (error) {
          if (!(error instanceof StandingHistoryAnalysisViewError) || error.code !== "limit") throw error;
        }
        if (!view && mergeCount > 2) { mergeCount--; continue; }
        if (!view) throw new StandingHistoryAnalysisViewError("limit");
        candidate = { kind: "merge", ...heads, ...(large ? { viewMaxBytes: materialBytes } : {}), children: view.children.map(n => n.nodeRef) as [string, string, ...string[]], materials: view.children }; resetMerge(); break;
      }
      if (checkpoint.status === "more") {
        candidate = s.limits.pageQuotaReached ? blocked("source-page-quota") : { kind: "read-more", ...heads, checkpoint }; break;
      }
      const excluded = { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 };
      let sourceRows = 0;
      for (const p of pages.values()) { sourceRows += p.total; for (const k of Object.keys(excluded) as (keyof typeof excluded)[]) excluded[k] += p.excluded[k]; }
      const terminal = checkpoint.status === "empty-page" || checkpoint.status === "lower-bound-reached";
      const complete = terminal && !checkpoint.inexact && checkpoint.undated === 0;
      const gaps: { kind: string; count?: number }[] = [];
      if (!terminal) gaps.push({ kind: "inaccessible-history" });
      if (checkpoint.inexact) gaps.push({ kind: "inexact-history" });
      if (checkpoint.undated) gaps.push({ kind: "undated-entries", count: checkpoint.undated });
      for (const [kind, count] of Object.entries(excluded)) if (count) gaps.push({ kind, count });
      candidate = { kind: "analysis-ready", ...heads, ...(roots[0] ? { rootRef: roots[0].nodeRef } : {}), coverage: { committedPages: sourceCount, coveredPages: pages.size, sourceRows, coveredRows: sourceRows, readStatus: checkpoint.status, readTraversalComplete: complete, excluded }, gaps };
    }
    const endSource = copy(await sourceStatus()); guard(); const endAnalysis = copy(await analysisStatus()); guard();
    if (endSource.storage !== "ready" || endAnalysis.storage !== "ready") return blocked("tail-refused");
    if (endSource.readProgress.chainHash !== heads.sourceHead || endAnalysis.headHash !== heads.expectedHead) { pending = undefined; resetPacking(); return copy(scan()); }
    pending = candidate ? copy(candidate) : undefined;
    return pending ?? copy(scan());
  }
  const close = async () => { closed = true; try { await active; } catch {} finally { reset(); key = ""; signal?.removeEventListener("abort", onAbort); } };
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) void close();
  return Object.freeze({
    next() {
      if (closed || signal?.aborted) return Promise.reject(new Error("STANDING_HISTORY_PLANNER_CLOSED"));
      if (active) return Promise.reject(new Error("STANDING_HISTORY_PLANNER_BUSY"));
      // Register the operation before invoking any host capability, including
      // callbacks which synchronously initiate shutdown.
      const operation = Promise.resolve().then(run).catch(error => { if (closed || signal?.aborted) throw error; reset(); return copy(blocked("host-read-refused")); });
      active = operation;
      void operation.finally(() => { if (active === operation) active = undefined; }).catch(() => {});
      return operation;
    },
    close
  });
}

/** Host-private deterministic selector. At most eight host read/projection
 * calls per next call; stores may perform nested custody reads/projections.
 * Retains bounded metadata and one raw page. Issuing a plan
 * commits nothing and grants no model invocation/retry or delivery authority.
 * Ready means the stored available material has a reduction root, not that
 * model claims are true or a full Telegram archive has been reconstructed. */
function createLegacyStandingHistoryAnalysisPlanner(input: Readonly<{
  intent: StandingHistoryTaskIntent;
  source: Pick<StandingHistoryTaskStore, "status" | "readPage">;
  analysis: Pick<StandingHistoryAnalysisStore, "status" | "readNodeAt" | "referenceKey">;
  signal?: AbortSignal;
}>): LegacyStandingHistoryAnalysisPlanner {
  if (!input || types.isProxy(input)) return fail();
  const ds = Object.getOwnPropertyDescriptors(input);
  for (const d of Object.values(ds)) if (!("value" in d)) return fail();
  const intent = snapshotStandingHistoryTaskIntent(ds.intent?.value);
  const sourceStatus = method<StandingHistoryTaskStore["status"]>(ds.source?.value, "status");
  const readPage = method<StandingHistoryTaskStore["readPage"]>(ds.source?.value, "readPage");
  const analysisStatus = method<StandingHistoryAnalysisStore["status"]>(ds.analysis?.value, "status");
  const readNodeAt = method<StandingHistoryAnalysisStore["readNodeAt"]>(ds.analysis?.value, "readNodeAt");
  let key = method<StandingHistoryAnalysisStore["referenceKey"]>(ds.analysis?.value, "referenceKey")();
  if (typeof key !== "string" || !digest(key)) return fail();
  const signal = ds.signal?.value as AbortSignal | undefined;
  if (signal && (types.isProxy(signal) || !(signal instanceof AbortSignal))) return fail();
  let closed = false, active: Promise<LegacyStandingHistoryAnalysisPlan> | undefined;
  let knownSourceHead = "", knownAnalysisHead = "", sourceCount = 0, nodeCount = 0;
  const nodes: NodeMeta[] = [], refs = new Map<string, NodeMeta>(), children = new Set<string>();
  const spans = new Map<number, StandingHistoryAnalysisSpan[]>(), pages = new Map<number, PageMeta>();
  let scanPage = 1, current: StandingHistoryStoredPage | undefined, position: string | undefined, offset = 0;
  let pending: LegacyStandingHistoryAnalysisPlan | undefined;
  let mergeFirst: StandingHistoryAnalysisNode | undefined;
  const guard = () => { if (closed || signal?.aborted) throw new Error("STANDING_HISTORY_PLANNER_CLOSED"); };
  const reset = () => { nodes.length = 0; refs.clear(); children.clear(); spans.clear(); pages.clear(); current = undefined; position = undefined; offset = 0; scanPage = 1; pending = undefined; mergeFirst = undefined; };
  const scan = (): LegacyStandingHistoryAnalysisPlan => ({ kind: "scan-more", progress: { nodesScanned: nodes.length, totalNodes: nodeCount, pagesScanned: pages.size, totalPages: sourceCount } });
  const blocked = (reason: string): LegacyStandingHistoryAnalysisPlan => ({ kind: "blocked", reason });
  function covered(index: number, total: number): boolean {
    const list = spans.get(index) ?? [];
    if (!total) return list.length === 1 && list[0]!.range.totalRows === 0;
    let end = 0;
    for (const s of [...list].sort((a, b) => a.range.fromRow - b.range.fromRow)) { if (s.range.fromRow !== end) return false; end = s.range.toRow; }
    return end === total;
  }
  function admit(node: StandingHistoryAnalysisNode, index: number) {
    if (node.index !== index || !digest(node.hash) || !/^hnode_[0-9a-f]{48}$/u.test(node.nodeRef) || refs.has(node.nodeRef)) return fail();
    const meta: NodeMeta = { nodeRef: node.nodeRef, index, hash: node.hash, weight: 1,
      first: Math.min(...node.coverage.map(v => v.pageIndex * 1000 + v.range.fromRow)),
      children: "children" in node.inputs ? node.inputs.children : [] };
    if (node.kind === "merge" && "children" in node.inputs) {
      for (const ref of node.inputs.children) { if (!refs.has(ref)) return fail(); children.add(ref); }
      meta.weight = node.inputs.children.reduce((total, ref) => total + refs.get(ref)!.weight, 0);
    } else if (node.kind === "leaf" && "materials" in node.inputs) {
      for (const s of node.coverage) {
        if (s.pageIndex < 1 || s.pageIndex > sourceCount) return fail();
        const list = spans.get(s.pageIndex) ?? [];
        if (list.some(p => p.pageHash !== s.pageHash || p.range.totalRows !== s.range.totalRows || s.range.totalRows === 0 || Math.max(p.range.fromRow, s.range.fromRow) < Math.min(p.range.toRow, s.range.toRow))) return fail();
        list.push(s); spans.set(s.pageIndex, list);
      }
    } else return fail();
    nodes.push(meta); refs.set(meta.nodeRef, meta);
  }
  async function run(): Promise<LegacyStandingHistoryAnalysisPlan> {
    guard();
    const s = copy(await sourceStatus()); guard();
    const a = copy(await analysisStatus()); guard();
    const checkpoint = snapshotSelfHistoryTaskCheckpoint(s.readProgress.checkpoint);
    if (checkpoint.accountId !== intent.accountId || checkpoint.chatId !== standingHistoryTaskSourcePeerId(intent) || checkpoint.fromDate !== intent.fromDate || checkpoint.toDate !== intent.toDate) return blocked("binding");
    if (s.storage !== "ready" || a.storage !== "ready") return blocked("tail-refused");
    if (!digest(s.readProgress.chainHash) || !digest(a.headHash) || !Number.isInteger(s.readProgress.committedPages) || s.readProgress.committedPages < 0 || s.readProgress.committedPages > 1024 || !Number.isInteger(a.analysisNodes) || a.analysisNodes < 0 || a.analysisNodes > 1024) return blocked("binding");
    const changed = knownSourceHead !== s.readProgress.chainHash || knownAnalysisHead !== a.headHash;
    if (changed) {
      if (s.readProgress.committedPages < sourceCount || a.analysisNodes < nodeCount || knownSourceHead && s.readProgress.committedPages === sourceCount && knownSourceHead !== s.readProgress.chainHash || knownAnalysisHead && a.analysisNodes === nodeCount && knownAnalysisHead !== a.headHash) reset();
      pending = undefined; mergeFirst = undefined; scanPage = 1; position = undefined; offset = 0;
      if (current?.index !== scanPage) current = undefined;
    }
    knownSourceHead = s.readProgress.chainHash; knownAnalysisHead = a.headHash;
    sourceCount = s.readProgress.committedPages; nodeCount = a.analysisNodes;
    const heads = { sourceHead: knownSourceHead, expectedHead: knownAnalysisHead };
    let budget = 4, candidate = pending;
    while (!candidate && budget > 0) {
      if (nodes.length < nodeCount) {
        budget--; const node = copy(await readNodeAt(nodes.length + 1)); guard();
        if (!node) { candidate = blocked("node-unavailable"); break; }
        admit(node, nodes.length + 1); continue;
      }
      if (scanPage <= sourceCount) {
        const meta = pages.get(scanPage);
        if (meta && covered(scanPage, meta.total)) { scanPage++; current = undefined; position = undefined; offset = 0; continue; }
        if (!current || current.index !== scanPage) {
          budget--; const p = copy(await readPage(scanPage)); guard();
          if (!p || p.index !== scanPage || !digest(p.hash)) { candidate = blocked("page-unavailable"); break; }
          current = Object.freeze({ index: p.index, hash: p.hash, result: snapshotStandingHistoryTaskPage(p.result, intent) });
          if ((spans.get(scanPage) ?? []).some(v => v.pageHash !== p.hash || v.range.totalRows !== p.result.sources.length)) { candidate = blocked("page-binding"); break; }
          pages.set(scanPage, { hash: p.hash, total: p.result.sources.length, excluded: p.result.page.excluded });
          position = undefined; offset = 0; continue;
        }
        const total = current.result.sources.length, list = spans.get(scanPage) ?? [];
        const existing = list.find(v => v.range.fromRow <= offset && v.range.toRow > offset);
        const boundary = existing?.range.toRow ?? Math.min(total, ...list.filter(v => v.range.fromRow > offset).map(v => v.range.fromRow));
        const maxRows = Math.max(1, Math.min(100, boundary - offset));
        budget--; const material = projectStandingHistorySource({ intent, referenceKey: key, storedPage: current, maxBytes: 49152, maxRows, ...(position ? { position } : {}) });
        if (!existing && !(total === 0 && covered(scanPage, total))) {
          if (a.limits.nodeQuotaReached) { candidate = blocked("analysis-node-quota"); break; }
          const descriptor = { pageIndex: scanPage, maxBytes: 49152, maxRows, materialRef: material.materialRef, ...(position ? { position } : {}) };
          candidate = { kind: "leaf", ...heads, inputs: [descriptor], material }; break;
        }
        position = material.nextPosition ?? undefined; offset = material.range.toRow;
        if (!material.nextPosition) { scanPage++; current = undefined; offset = 0; }
        continue;
      }
      const roots = nodes.filter(n => !children.has(n.nodeRef)).sort((x, y) => x.first - y.first);
      // A ledger may retain alternate reductions of the same children. Such a
      // DAG is valid storage, but cannot be treated as a disjoint ready forest.
      const ownedLeaves = new Set<string>();
      const visit = (n: NodeMeta): boolean => {
        if (!n.children.length) { if (ownedLeaves.has(n.nodeRef)) return false; ownedLeaves.add(n.nodeRef); return true; }
        return n.children.every(ref => visit(refs.get(ref)!));
      };
      if (!roots.every(visit)) { candidate = blocked("overlapping-analysis-roots"); break; }
      // Keep adjacent source ranges together. While reading, only combine
      // similarly sized subtrees; repeatedly merging the accumulated root with
      // each new leaf would re-compress old evidence once per page. At a
      // terminal frontier, reduce the lightest adjacent pair until one remains.
      let pair: readonly [NodeMeta, NodeMeta] | undefined;
      for (let i = 0; i + 1 < roots.length; i++) {
        const left = roots[i]!, right = roots[i + 1]!;
        if (checkpoint.status === "more" && Math.floor(Math.log2(left.weight)) !== Math.floor(Math.log2(right.weight))) continue;
        if (!pair || left.weight + right.weight < pair[0].weight + pair[1].weight) pair = [left, right];
      }
      if (pair) {
        if (a.limits.nodeQuotaReached) { candidate = blocked("analysis-node-quota"); break; }
        if (!mergeFirst) { budget--; mergeFirst = copy(await readNodeAt(pair[0]!.index)); guard(); if (!mergeFirst || mergeFirst.hash !== pair[0]!.hash) { candidate = blocked("node-unavailable"); break; } continue; }
        // Pair projection is a step as well as each authenticated child read.
        if (budget < 2) break;
        budget -= 2; const second = copy(await readNodeAt(pair[1]!.index)); guard();
        if (!second || second.hash !== pair[1]!.hash) { candidate = blocked("node-unavailable"); break; }
        const view = projectMergeView({ children: [mergeFirst, second], referenceKey: key });
        candidate = { kind: "merge", ...heads, children: [mergeFirst.nodeRef, second.nodeRef], materials: view.children }; mergeFirst = undefined; break;
      }
      if (checkpoint.status === "more") {
        candidate = s.limits.pageQuotaReached ? blocked("source-page-quota") : { kind: "read-more", ...heads, checkpoint }; break;
      }
      const excluded = { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 };
      let sourceRows = 0;
      for (const p of pages.values()) { sourceRows += p.total; for (const k of Object.keys(excluded) as (keyof typeof excluded)[]) excluded[k] += p.excluded[k]; }
      const terminal = checkpoint.status === "empty-page" || checkpoint.status === "lower-bound-reached";
      const complete = terminal && !checkpoint.inexact && checkpoint.undated === 0;
      const gaps: { kind: string; count?: number }[] = [];
      if (!terminal) gaps.push({ kind: "inaccessible-history" });
      if (checkpoint.inexact) gaps.push({ kind: "inexact-history" });
      if (checkpoint.undated) gaps.push({ kind: "undated-entries", count: checkpoint.undated });
      for (const [kind, count] of Object.entries(excluded)) if (count) gaps.push({ kind, count });
      candidate = { kind: "analysis-ready", ...heads, ...(roots[0] ? { rootRef: roots[0].nodeRef } : {}), coverage: { committedPages: sourceCount, coveredPages: pages.size, sourceRows, coveredRows: sourceRows, readStatus: checkpoint.status, readTraversalComplete: complete, excluded }, gaps };
    }
    const endSource = copy(await sourceStatus()); guard(); const endAnalysis = copy(await analysisStatus()); guard();
    if (endSource.storage !== "ready" || endAnalysis.storage !== "ready") return blocked("tail-refused");
    if (endSource.readProgress.chainHash !== heads.sourceHead || endAnalysis.headHash !== heads.expectedHead) { pending = undefined; mergeFirst = undefined; return copy(scan()); }
    pending = candidate ? copy(candidate) : undefined;
    return pending ?? copy(scan());
  }
  const close = async () => { closed = true; try { await active; } catch {} finally { reset(); key = ""; signal?.removeEventListener("abort", onAbort); } };
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) void close();
  return Object.freeze({
    next() {
      if (closed || signal?.aborted) return Promise.reject(new Error("STANDING_HISTORY_PLANNER_CLOSED"));
      if (active) return Promise.reject(new Error("STANDING_HISTORY_PLANNER_BUSY"));
      // Register the operation before invoking any host capability, including
      // callbacks which synchronously initiate shutdown.
      const operation = Promise.resolve().then(run).catch(error => { if (closed || signal?.aborted) throw error; reset(); return copy(blocked("host-read-refused")); });
      active = operation;
      void operation.finally(() => { if (active === operation) active = undefined; }).catch(() => {});
      return operation;
    },
    close
  });
}

type LegacyStandingHistoryAnalysisPlan = Exclude<StandingHistoryAnalysisPlan, { kind: "leaf" | "merge" }>
  | (Heads & Readonly<{ kind: "leaf"; inputs: readonly [StandingHistoryAnalysisMaterialRequest]; material: StandingHistorySourceFragment }>)
  | (Heads & Readonly<{ kind: "merge"; children: readonly [string, string]; materials: StandingHistoryMergeView["children"] }>);
type LegacyStandingHistoryAnalysisPlanner = Readonly<{ next(): Promise<LegacyStandingHistoryAnalysisPlan>; close(): Promise<void> }>;
export type StandingHistoryAnalysisPlannerInput = Parameters<typeof createWideStandingHistoryAnalysisPlanner>[0] & Readonly<{ packing?: "wide" | "large" }>;
/** Legacy selection remains the default for callers and saved-work recovery.
 * Production opts into wider whole-record packing explicitly. This is a host
 * planning policy, never model authority or a change to persisted identities. */
export function createStandingHistoryAnalysisPlanner(input: StandingHistoryAnalysisPlannerInput & Readonly<{ packing: "wide" | "large" }>): StandingHistoryAnalysisPlanner;
export function createStandingHistoryAnalysisPlanner(input: Omit<StandingHistoryAnalysisPlannerInput, "packing">): LegacyStandingHistoryAnalysisPlanner;
export function createStandingHistoryAnalysisPlanner(input: StandingHistoryAnalysisPlannerInput): StandingHistoryAnalysisPlanner {
  if (!input || typeof input !== "object" || types.isProxy(input)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const descriptor of Object.values(descriptors)) if (!("value" in descriptor)) return fail();
  if (Object.hasOwn(descriptors, "packing") && descriptors.packing!.value !== "wide" && descriptors.packing!.value !== "large") return fail();
  return descriptors.packing?.value === "wide" || descriptors.packing?.value === "large" ? createWideStandingHistoryAnalysisPlanner(input) : createLegacyStandingHistoryAnalysisPlanner(input);
}
