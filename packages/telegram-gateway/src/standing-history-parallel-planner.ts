import { MATERIAL_BYTES, LEGACY_MATERIAL_BYTES, MAX_FRAGMENTS } from "./standing-history-analysis-limits.js";
import { types } from "node:util";
import { snapshotSelfHistoryTaskCheckpoint } from "./self-history-reader.js";
import { createStandingHistoryAnalysisPlanner, type StandingHistoryAnalysisPlan, type StandingHistoryAnalysisPlanner, type StandingHistoryAnalysisPlannerInput, type StandingHistorySourceBatch } from "./standing-history-analysis-planner.js";
import { snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskPage, standingHistoryTaskSourcePeerId, type StandingHistoryStoredPage, type StandingHistoryTaskStore } from "./standing-history-task-store.js";
import { type StandingHistoryAnalysisStore, type StandingHistoryAnalysisSpan, type StandingHistoryAnalysisNode, type StandingHistoryAnalysisMaterialRequest } from "./standing-history-analysis-store.js";
import { projectStandingHistorySource, StandingHistorySourceProjectionError, type StandingHistorySourceFragment } from "./standing-history-source-projection.js";

export type StandingHistoryParallelLeafPlan = Extract<StandingHistoryAnalysisPlan, { kind: "leaf" }>;
export type StandingHistoryParallelPlan = StandingHistoryAnalysisPlan | Readonly<{
  kind: "leaf-wave"; sourceHead: string; expectedHead: string;
  plans: readonly [StandingHistoryParallelLeafPlan, StandingHistoryParallelLeafPlan, ...StandingHistoryParallelLeafPlan[]];
}>;
export type StandingHistoryParallelPlanner = Readonly<{ next(): Promise<StandingHistoryParallelPlan>; close(): Promise<void> }>;
const fail = (): never => { throw new Error("STANDING_HISTORY_PARALLEL_PLANNER_INPUT"); };
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
// Detach capability results before the next await without invoking accessors.
function copy<T>(value: T): T {
  let budget = 16 * 1024 * 1024;
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 40) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) return fail(); return v; }
    if (typeof v === "string") { budget -= Buffer.byteLength(v); if (budget < 0) return fail(); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail();
    const result = array ? [] : {};
    for (const k of Reflect.ownKeys(v)) {
      if (array && k === "length") continue;
      if (typeof k !== "string" || k === "__proto__") return fail();
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!("value" in d) || !d.enumerable) return fail();
      Object.defineProperty(result, k, { value: visit(d.value, depth + 1), enumerable: true });
    }
    return Object.freeze(result);
  };
  return visit(value, 0) as T;
}
function method<T extends (...args: never[]) => unknown>(v: unknown, name: string): T {
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
  const d = Object.getOwnPropertyDescriptor(v, name);
  if (!d || !("value" in d) || typeof d.value !== "function") return fail();
  return d.value.bind(v) as T;
}

/** Read-only leaf lookahead: four status calls plus at most four node/page reads
 * or source projections per quantum. Retains at most eight policy-bounded leaf batches,
 * one source page and bounded actual-ledger coverage. No speculative nodes are
 * inserted into the ledger. Every leaf in a wave uses the same original heads;
 * the executor must stage results and revalidate disjointness before publishing.
 * When fewer than two packed leaves exist, the unchanged wide planner selects
 * the serial plan in subsequent bounded quanta (including read-more/merge/ready).
 * Large mode gathers a partial unfinished frontier before a model turn; full
 * chunks may run while further durable source remains to be fetched.
 */
export function createStandingHistoryParallelPlanner(input: StandingHistoryAnalysisPlannerInput & Readonly<{ maxLeaves?: number }>): StandingHistoryParallelPlanner {
  if (!input || types.isProxy(input)) return fail();
  const ds = Object.getOwnPropertyDescriptors(input);
  for (const d of Object.values(ds)) if (!("value" in d)) return fail();
  const intent = snapshotStandingHistoryTaskIntent(ds.intent?.value);
  const sourceStatus = method<StandingHistoryTaskStore["status"]>(ds.source?.value, "status");
  const readPage = method<StandingHistoryTaskStore["readPage"]>(ds.source?.value, "readPage");
  const analysisStatus = method<StandingHistoryAnalysisStore["status"]>(ds.analysis?.value, "status");
  const readNode = method<StandingHistoryAnalysisStore["readNodeAt"]>(ds.analysis?.value, "readNodeAt");
  let key = method<StandingHistoryAnalysisStore["referenceKey"]>(ds.analysis?.value, "referenceKey")();
  if (!digest(key)) return fail();
  const maxLeaves = ds.maxLeaves?.value ?? 8;
  if (!Number.isInteger(maxLeaves) || maxLeaves < 2 || maxLeaves > 8 || ds.packing && ds.packing.value !== "wide" && ds.packing.value !== "large") return fail();
  const large = ds.packing?.value === "large", materialBytes = large ? MATERIAL_BYTES : LEGACY_MATERIAL_BYTES, maxFragments = large ? MAX_FRAGMENTS : 8;
  const signal = ds.signal?.value as AbortSignal | undefined;
  if (signal && (types.isProxy(signal) || !(signal instanceof AbortSignal))) return fail();
  const serialInput = { intent, source: { status: sourceStatus, readPage }, analysis: { status: analysisStatus, readNodeAt: readNode, referenceKey: () => key }, packing: large ? "large" as const : "wide" as const, ...(signal ? { signal } : {}) };
  let serial: StandingHistoryAnalysisPlanner | undefined, useSerial = false;
  let closed = false, active: Promise<StandingHistoryParallelPlan> | undefined;
  let generation = "", sourceHead = "", expectedHead = "", totalPages = 0, totalNodes = 0, scannedNodes = 0, pageIndex = 1;
  let current: StandingHistoryStoredPage | undefined, position: string | undefined, offset = 0;
  const coverage = new Map<number, StandingHistoryAnalysisSpan[]>(), refs = new Set<string>();
  const plans: StandingHistoryParallelLeafPlan[] = [], fragments: StandingHistorySourceFragment[] = [], inputs: StandingHistoryAnalysisMaterialRequest[] = [];
  const guard = () => { if (closed || signal?.aborted) throw new Error("STANDING_HISTORY_PARALLEL_PLANNER_CLOSED"); };
  const reset = () => { generation = ""; scannedNodes = 0; pageIndex = 1; current = undefined; position = undefined; offset = 0; coverage.clear(); refs.clear(); plans.length = 0; fragments.length = 0; inputs.length = 0; };
  const scan = (): StandingHistoryAnalysisPlan => ({ kind: "scan-more", progress: { nodesScanned: scannedNodes, totalNodes, pagesScanned: pageIndex - 1, totalPages } });
  const material = (): StandingHistorySourceFragment | StandingHistorySourceBatch => fragments.length === 1 ? fragments[0]! : { schema: "standing-history-source-batch-v1", fragments: [...fragments] };
  const flush = () => {
    if (!fragments.length) return;
    const leafMaterial = material();
    if (Buffer.byteLength(JSON.stringify(leafMaterial)) > materialBytes) return fail();
    plans.push({ kind: "leaf", sourceHead, expectedHead, inputs: [...inputs] as [StandingHistoryAnalysisMaterialRequest, ...StandingHistoryAnalysisMaterialRequest[]], material: leafMaterial });
    fragments.length = 0; inputs.length = 0;
  };
  const admit = (node: StandingHistoryAnalysisNode) => {
    if (node.index !== scannedNodes + 1 || !digest(node.hash) || !/^hnode_[0-9a-f]{48}$/u.test(node.nodeRef) || refs.has(node.nodeRef)) return fail();
    if (node.kind === "merge" && "children" in node.inputs) {
      if (node.inputs.children.some(ref => !refs.has(ref))) return fail();
    } else if (node.kind === "leaf" && "materials" in node.inputs) {
      if (!node.coverage.length) return fail();
      for (const span of node.coverage) {
        const r = span.range;
        if (!Number.isInteger(span.pageIndex) || span.pageIndex < 1 || span.pageIndex > totalPages || !digest(span.pageHash) ||
            ![r.fromRow, r.toRow, r.totalRows].every(Number.isInteger) || r.fromRow < 0 || r.toRow < r.fromRow || r.toRow > r.totalRows || r.totalRows > 100 || r.totalRows > 0 && r.fromRow === r.toRow) return fail();
        const list = coverage.get(span.pageIndex) ?? [];
        if (list.some(p => p.pageHash !== span.pageHash || p.range.totalRows !== r.totalRows || r.totalRows === 0 || Math.max(p.range.fromRow, r.fromRow) < Math.min(p.range.toRow, r.toRow))) return fail();
        list.push(span); coverage.set(span.pageIndex, list);
      }
    } else return fail();
    refs.add(node.nodeRef); scannedNodes++;
  };
  async function run(): Promise<StandingHistoryParallelPlan> {
    guard();
    if (useSerial) {
      serial ??= createStandingHistoryAnalysisPlanner(serialInput);
      const plan = await serial.next(); guard();
      if (plan.kind !== "scan-more") { useSerial = false; reset(); }
      return plan;
    }
    const s = copy(await sourceStatus()); guard();
    const a = copy(await analysisStatus()); guard();
    if (s.storage !== "ready" || a.storage !== "ready") { reset(); return { kind: "blocked", reason: "tail-refused" }; }
    const checkpoint = snapshotSelfHistoryTaskCheckpoint(s.readProgress.checkpoint);
    if (checkpoint.accountId !== intent.accountId || checkpoint.chatId !== standingHistoryTaskSourcePeerId(intent) || checkpoint.fromDate !== intent.fromDate || checkpoint.toDate !== intent.toDate ||
        !digest(s.readProgress.chainHash) || !digest(a.headHash) || !Number.isInteger(s.readProgress.committedPages) || s.readProgress.committedPages < 0 || s.readProgress.committedPages > 1024 ||
        !Number.isInteger(a.analysisNodes) || a.analysisNodes < 0 || a.analysisNodes > 1024) { reset(); return { kind: "blocked", reason: "binding" }; }
    const signature = JSON.stringify([s, a]);
    if (generation !== signature) { reset(); generation = signature; }
    sourceHead = s.readProgress.chainHash; expectedHead = a.headHash; totalPages = s.readProgress.committedPages; totalNodes = a.analysisNodes;
    let budget = 4;
    while (budget > 0 && plans.length < maxLeaves) {
      if (scannedNodes < totalNodes) {
        budget--; const node = copy(await readNode(scannedNodes + 1)); guard();
        if (!node) return fail(); admit(node); continue;
      }
      if (pageIndex > totalPages) { if (!large || checkpoint.status !== "more" || s.limits.pageQuotaReached) flush(); break; }
      if (!current) {
        budget--; const page = copy(await readPage(pageIndex)); guard();
        if (!page || page.index !== pageIndex || !digest(page.hash)) return fail();
        current = { index: page.index, hash: page.hash, result: snapshotStandingHistoryTaskPage(page.result, intent) };
        if ((coverage.get(pageIndex) ?? []).some(span => span.pageHash !== current!.hash || span.range.totalRows !== current!.result.sources.length)) return fail();
        continue;
      }
      const total = current.result.sources.length, list = coverage.get(pageIndex) ?? [];
      const existing = list.find(span => total === 0 || span.range.fromRow <= offset && span.range.toRow > offset);
      const boundary = existing?.range.toRow ?? Math.min(total, ...list.filter(span => span.range.fromRow > offset).map(span => span.range.fromRow));
      const maxRows = Math.max(1, boundary - offset);
      const maxBytes = existing || !fragments.length ? materialBytes : materialBytes - Buffer.byteLength(JSON.stringify({ schema: "standing-history-source-batch-v1", fragments })) - 1;
      if (!existing && maxBytes < 1024) { flush(); continue; }
      budget--;
      let fragment: StandingHistorySourceFragment;
      try { fragment = projectStandingHistorySource({ intent, referenceKey: key, storedPage: current, maxBytes, maxRows, ...(position ? { position } : {}) }); }
      catch (error) {
        if (!existing && fragments.length && error instanceof StandingHistorySourceProjectionError && error.code === "limit") { flush(); continue; }
        throw error;
      }
      if (!existing) {
        inputs.push({ pageIndex, materialRef: fragment.materialRef, maxBytes, maxRows, ...(position ? { position } : {}) }); fragments.push(fragment);
      }
      offset = fragment.range.toRow; position = fragment.nextPosition ?? undefined;
      if (fragment.nextPosition === null) { pageIndex++; current = undefined; offset = 0; }
      if (fragments.length === maxFragments || !existing && fragment.nextPosition !== null) flush();
    }
    const endSource = copy(await sourceStatus()); guard();
    const endAnalysis = copy(await analysisStatus()); guard();
    if (endSource.storage !== "ready" || endAnalysis.storage !== "ready") { reset(); return { kind: "blocked", reason: "tail-refused" }; }
    if (signature !== JSON.stringify([endSource, endAnalysis])) { reset(); return copy(scan()); }
    if (plans.length >= 2 && (plans.length === maxLeaves || pageIndex > totalPages)) {
      if (a.limits.nodeQuotaReached || a.analysisNodes + plans.length > a.limits.maximumNodes) { reset(); return { kind: "blocked", reason: "analysis-node-quota" }; }
      return copy({ kind: "leaf-wave", sourceHead, expectedHead, plans: plans as [StandingHistoryParallelLeafPlan, StandingHistoryParallelLeafPlan, ...StandingHistoryParallelLeafPlan[]] });
    }
    if (pageIndex > totalPages) { useSerial = true; reset(); }
    return copy(scan());
  }
  const close = async () => { closed = true; try { await active; } catch {} finally { await serial?.close(); reset(); key = ""; signal?.removeEventListener("abort", onAbort); } };
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) void close();
  return Object.freeze({ next() {
    if (closed || signal?.aborted) return Promise.reject(new Error("STANDING_HISTORY_PARALLEL_PLANNER_CLOSED"));
    if (active) return Promise.reject(new Error("STANDING_HISTORY_PARALLEL_PLANNER_BUSY"));
    const operation = Promise.resolve().then(run).catch(error => { if (closed || signal?.aborted) throw error; reset(); return { kind: "blocked" as const, reason: "host-read-refused" }; });
    active = operation; void operation.finally(() => { if (active === operation) active = undefined; }).catch(() => {}); return operation;
  }, close });
}
