import { types } from "node:util";
import { snapshotSelfHistoryTaskCheckpoint, type SelfHistoryTaskCheckpoint } from "./self-history-reader.js";
import { snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskPage, type StandingHistoryTaskIntent, type StandingHistoryTaskStore, type StandingHistoryStoredPage } from "./standing-history-task-store.js";
import { type StandingHistoryAnalysisStore, type StandingHistoryAnalysisNode, type StandingHistoryAnalysisSpan, type StandingHistoryAnalysisMaterialRequest } from "./standing-history-analysis-store.js";
import { projectStandingHistorySource, type StandingHistorySourceFragment } from "./standing-history-source-projection.js";
import { projectMergeView, type StandingHistoryMergeView } from "./standing-history-analysis-view.js";

type Heads = Readonly<{ sourceHead: string; expectedHead: string }>;
export type StandingHistoryAnalysisPlan =
  | (Heads & Readonly<{ kind: "leaf"; inputs: readonly [StandingHistoryAnalysisMaterialRequest]; material: StandingHistorySourceFragment }>)
  | (Heads & Readonly<{ kind: "merge"; children: readonly [string, string]; materials: StandingHistoryMergeView["children"] }>)
  | (Heads & Readonly<{ kind: "read-more"; checkpoint: SelfHistoryTaskCheckpoint }>)
  | (Heads & Readonly<{ kind: "analysis-ready"; rootRef?: string; coverage: Readonly<{ committedPages: number; coveredPages: number; sourceRows: number; coveredRows: number; readStatus: SelfHistoryTaskCheckpoint["status"]; readTraversalComplete: boolean; excluded: Readonly<{ nonText: number; invalidText: number; unavailable: number; outsidePeriod: number }> }>; gaps: readonly Readonly<{ kind: string; count?: number }>[] }>)
  | Readonly<{ kind: "scan-more"; progress: Readonly<{ nodesScanned: number; totalNodes: number; pagesScanned: number; totalPages: number }> }>
  | Readonly<{ kind: "blocked"; reason: string }>;
export type StandingHistoryAnalysisPlanner = Readonly<{ next(): Promise<StandingHistoryAnalysisPlan>; close(): Promise<void> }>;
type NodeMeta = Pick<StandingHistoryAnalysisNode, "nodeRef" | "index" | "hash"> & { first: number; children: readonly string[] };
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
 * Retains bounded metadata and one raw page. Issuing a plan
 * commits nothing and grants no model invocation/retry or delivery authority.
 * Ready means the stored available material has a reduction root, not that
 * model claims are true or a full Telegram archive has been reconstructed. */
export function createStandingHistoryAnalysisPlanner(input: Readonly<{
  intent: StandingHistoryTaskIntent;
  source: Pick<StandingHistoryTaskStore, "status" | "readPage">;
  analysis: Pick<StandingHistoryAnalysisStore, "status" | "readNodeAt" | "referenceKey">;
  signal?: AbortSignal;
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
  const signal = ds.signal?.value as AbortSignal | undefined;
  if (signal && (types.isProxy(signal) || !(signal instanceof AbortSignal))) return fail();
  let closed = false, active: Promise<StandingHistoryAnalysisPlan> | undefined;
  let knownSourceHead = "", knownAnalysisHead = "", sourceCount = 0, nodeCount = 0;
  const nodes: NodeMeta[] = [], refs = new Map<string, NodeMeta>(), children = new Set<string>();
  const spans = new Map<number, StandingHistoryAnalysisSpan[]>(), pages = new Map<number, PageMeta>();
  let scanPage = 1, current: StandingHistoryStoredPage | undefined, position: string | undefined, offset = 0;
  let pending: StandingHistoryAnalysisPlan | undefined;
  let mergeFirst: StandingHistoryAnalysisNode | undefined;
  const guard = () => { if (closed || signal?.aborted) throw new Error("STANDING_HISTORY_PLANNER_CLOSED"); };
  const reset = () => { nodes.length = 0; refs.clear(); children.clear(); spans.clear(); pages.clear(); current = undefined; position = undefined; offset = 0; scanPage = 1; pending = undefined; mergeFirst = undefined; };
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
    const meta: NodeMeta = { nodeRef: node.nodeRef, index, hash: node.hash,
      first: Math.min(...node.coverage.map(v => v.pageIndex * 1000 + v.range.fromRow)),
      children: "children" in node.inputs ? node.inputs.children : [] };
    if (node.kind === "merge" && "children" in node.inputs) {
      for (const ref of node.inputs.children) { if (!refs.has(ref)) return fail(); children.add(ref); }
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
    if (checkpoint.accountId !== intent.accountId || checkpoint.chatId !== intent.chatId || checkpoint.fromDate !== intent.fromDate || checkpoint.toDate !== intent.toDate) return blocked("binding");
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
          current = Object.freeze({ index: p.index, hash: p.hash, result: snapshotStandingHistoryTaskPage(p.result) });
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
      if (roots.length >= 2) {
        if (a.limits.nodeQuotaReached) { candidate = blocked("analysis-node-quota"); break; }
        const pair = roots.slice(0, 2);
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
