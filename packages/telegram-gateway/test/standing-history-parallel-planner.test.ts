import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { createStandingHistoryAnalysisPlanner, type StandingHistoryAnalysisPlan, type StandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { snapshotStandingHistoryTaskPage, type StandingHistoryStoredPage, type StandingHistoryTaskIntent, type StandingHistoryTaskStatus } from "../src/standing-history-task-store.js";
import type { StandingHistoryAnalysisNode, StandingHistoryAnalysisStatus } from "../src/standing-history-analysis-store.js";
import { snapshotSelfHistoryTaskCheckpoint, type SelfHistoryTaskCheckpoint } from "../src/self-history-reader.js";

const hex = (n: number, length = 64) => n.toString(16).padStart(length, "0");
const referenceKey = "1".repeat(64);
const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "2".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Summarize synthetic discussion" };
function initial(): SelfHistoryTaskCheckpoint {
  return snapshotSelfHistoryTaskCheckpoint({ schema: "self-history-task-checkpoint-v1", accountId: intent.accountId, chatId: intent.chatId,
    fromDate: intent.fromDate, toDate: intent.toDate, offsetId: 0, lastDate: intent.toDate, oldestDate: null, newestDate: null, undated: 0, pages: 0,
    inexact: false, upperBoundMessageId: null, status: "more" });
}
function storedPage(before: SelfHistoryTaskCheckpoint, count = 1): StandingHistoryStoredPage {
  const sources = Array.from({ length: count }, (_, i) => ({ messageId: (before.offsetId || 10000) - i - 1, date: before.lastDate - i - 1,
    disposition: "included" as const, messageRef: "m_" + hex((before.offsetId || 10000) - i - 1, 24), authorId: "456" }));
  const next: SelfHistoryTaskCheckpoint = { ...before, offsetId: sources.at(-1)?.messageId ?? before.offsetId, lastDate: sources.at(-1)?.date ?? before.lastDate,
    oldestDate: sources.at(-1)?.date ?? before.oldestDate, newestDate: before.newestDate ?? sources[0]?.date ?? null, pages: before.pages + 1,
    upperBoundMessageId: before.upperBoundMessageId ?? sources[0]?.messageId ?? null, status: count ? "more" : "empty-page" };
  const result = snapshotStandingHistoryTaskPage({ beforeCheckpoint: before, nextCheckpoint: next, sources,
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: [...sources].reverse().map(s => ({ ref: s.messageRef, authorRef: "a_" + "3".repeat(24), author: "user", displayName: "Synthetic speaker", date: s.date,
        editedAt: null, replyRef: null, replyUnavailable: false, text: "Observed source " + s.messageId })), cursor: null, hasMore: count > 0, status: next.status,
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: count === 0,
        undatedEntries: 0, pages: next.pages }, excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } });
  return { index: next.pages, hash: hex(1000 + next.pages), result };
}
function leaf(page: StandingHistoryStoredPage, index: number, maxRows = 100, position?: string): StandingHistoryAnalysisNode {
  const material = projectStandingHistorySource({ intent, referenceKey, storedPage: page, maxBytes: 49152, maxRows, ...(position ? { position } : {}) });
  const supports = material.rows.filter(row => row.disposition === "included").map(row => ({ sourceRef: row.sourceRef, versionRef: row.versionRef }));
  const span = { materialRef: material.materialRef, pageIndex: page.index, pageHash: page.hash, range: material.range, coverage: material.coverage };
  return { nodeRef: "hnode_" + hex(index, 48), index, hash: hex(2000 + index), kind: "leaf", coverage: [span],
    inputs: { materials: [{ ...span, maxBytes: 49152, maxRows, ...(position ? { position } : {}), supports }] },
    output: { summary: "Stored unverified summary " + index, claims: supports.length ? [{ kind: "reported", text: "Stored claim", supports: supports.slice(0, 1) }] : [] } };
}
function fixture(counts: number[] = [1], analyzed = counts.length) {
  const pages: StandingHistoryStoredPage[] = []; let checkpoint = initial();
  for (const count of counts) { const page = storedPage(checkpoint, count); pages.push(page); checkpoint = page.result.nextCheckpoint; }
  const nodes: StandingHistoryAnalysisNode[] = pages.slice(0, analyzed).map((page, i) => leaf(page, i + 1));
  const state: { source: StandingHistoryTaskStatus; analysis: StandingHistoryAnalysisStatus } = {
    source: { storage: "ready", readProgress: { committedPages: pages.length, checkpoint, chainHash: hex(1000 + pages.length) }, modelProgress: "not-recorded",
      limits: { maximumPages: 1024, maximumPageBytes: 131072, maximumCiphertextBytes: 196608, pageQuotaReached: false } },
    analysis: { storage: "ready", headHash: hex(2000 + nodes.length), analysisNodes: nodes.length, leafNodes: nodes.length, claims: "model-authored-unverified",
      limits: { maximumNodes: 1024, maximumNodeBytes: 131072, maximumCiphertextBytes: 196608, nodeQuotaReached: false } },
  };
  const calls: { kind: string; index?: number }[] = [];
  const source = { async status() { calls.push({ kind: "source-status" }); return state.source; },
    async readPage(index: number) { calls.push({ kind: "page", index }); return pages[index - 1]; } };
  const analysis = { async status() { calls.push({ kind: "analysis-status" }); return state.analysis; },
    async readNodeAt(index: number) { calls.push({ kind: "node", index }); return nodes[index - 1]; }, referenceKey() { return referenceKey; } };
  const args = { intent, source, analysis };
  const appendNode = (node: StandingHistoryAnalysisNode) => { nodes.push(node); state.analysis = { ...state.analysis, headHash: node.hash,
    analysisNodes: nodes.length, leafNodes: nodes.filter(n => n.kind === "leaf").length }; };
  return { pages, nodes, state, calls, args, appendNode };
}
import { createStandingHistoryParallelPlanner, type StandingHistoryParallelPlanner, type StandingHistoryParallelPlan } from "../src/standing-history-parallel-planner.js";

async function selected(f: ReturnType<typeof fixture>, planner: StandingHistoryParallelPlanner): Promise<StandingHistoryParallelPlan> {
  for (let i = 0; i < 300; i++) {
    const before = f.calls.length, result = await planner.next();
    assert.ok(f.calls.length - before <= 8, "quantum host calls exceed eight");
    if (result.kind !== "scan-more") return result;
  }
  return assert.fail("bounded planner did not finish");
}
const fragmentsOf = (plan: Extract<StandingHistoryAnalysisPlan, { kind: "leaf" }>) => plan.material.schema === "standing-history-source-batch-v1" ? plan.material.fragments : [plan.material];

test("large parallel planner gathers small incomplete history and emits one full-period leaf", async t => {
  for (const terminal of [false, true]) {
    const f = fixture([...Array<number>(32).fill(2), ...(terminal ? [0] : [])], 0);
    const planner = createStandingHistoryParallelPlanner({ ...f.args, packing: "large" }); t.after(() => planner.close());
    const result = await selected(f, planner);
    assert.equal(result.kind, terminal ? "leaf" : "read-more");
    if (result.kind === "leaf") { assert.equal(result.inputs.length, 33); assert.equal(fragmentsOf(result).flatMap(p => p.rows).length, 64); }
  }
});

test("large parallel waves preserve dense whole-message chunks and leave partial unfinished frontier for gathering", async t => {
  const f = fixture(Array<number>(48).fill(4), 0);
  for (let index = 0; index < f.pages.length; index++) {
    const page = f.pages[index]!;
    f.pages[index] = { ...page, result: { ...page.result, page: { ...page.result.page,
      messages: page.result.page.messages.map(m => ({ ...m, text: m.ref + "я".repeat(5900) })) } } };
  }
  const planner = createStandingHistoryParallelPlanner({ ...f.args, packing: "large" }); t.after(() => planner.close());
  const result = await selected(f, planner); assert.equal(result.kind, "leaf-wave"); if (result.kind !== "leaf-wave") return;
  assert.equal(result.plans.length, 2, "incomplete small remainder is not an extra model call");
  for (const plan of result.plans) { const bytes = Buffer.byteLength(JSON.stringify(plan.material)); assert.ok(bytes > 950000 && bytes <= 1048576); }
  const rows = result.plans.flatMap(fragmentsOf).flatMap(p => p.rows.map(r => r.sourceRef));
  assert.equal(new Set(rows).size, rows.length); assert.ok(rows.length < 192);
  const cold = createStandingHistoryParallelPlanner({ ...f.args, packing: "large" }); t.after(() => cold.close());
  assert.deepEqual(await selected(f, cold), result);
});

test("deterministic same-head wave packs 17 pages into disjoint 8/8/1 batches including empty terminal marker", async t => {
  const f = fixture([...Array<number>(16).fill(2), 0], 0), planner = createStandingHistoryParallelPlanner(f.args);
  t.after(() => planner.close());
  const plan = await selected(f, planner); assert.equal(plan.kind, "leaf-wave"); if (plan.kind !== "leaf-wave") return;
  assert.deepEqual(plan.plans.map(p => p.inputs.length), [8, 8, 1]);
  assert.deepEqual(plan.plans.flatMap(p => p.inputs.map(i => i.pageIndex)), Array.from({ length: 17 }, (_, i) => i + 1));
  for (const p of plan.plans) {
    assert.equal(p.sourceHead, f.state.source.readProgress.chainHash); assert.equal(p.expectedHead, f.state.analysis.headHash);
    assert.ok(Buffer.byteLength(JSON.stringify(p.material)) <= 49152);
    for (const [i, fragment] of fragmentsOf(p).entries()) {
      const request = p.inputs[i]!;
      assert.deepEqual(fragment, projectStandingHistorySource({ intent, referenceKey, storedPage: f.pages[request.pageIndex - 1]!, maxBytes: request.maxBytes, maxRows: request.maxRows!, ...(request.position ? { position: request.position } : {}) }));
    }
  }
  assert.equal(plan.plans.flatMap(fragmentsOf).flatMap(p => p.rows).length, 32);
  assert.equal(plan.plans.at(-1)!.material.schema, "standing-history-source-fragment-v1");
  assert.deepEqual(await selected(f, planner), plan, "unchanged heads retain exact wave");
  const fresh = createStandingHistoryParallelPlanner(f.args); t.after(() => fresh.close()); assert.deepEqual(await selected(f, fresh), plan);
  assert.equal(f.nodes.length, 0, "planning creates no committed nodes");
});

test("wave width is bounded to configured two through eight packed leaves", async t => {
  const f = fixture(Array<number>(25).fill(1), 0), planner = createStandingHistoryParallelPlanner({ ...f.args, maxLeaves: 2 }); t.after(() => planner.close());
  const result = await selected(f, planner); assert.equal(result.kind, "leaf-wave");
  if (result.kind === "leaf-wave") { assert.equal(result.plans.length, 2); assert.equal(result.plans.flatMap(fragmentsOf).length, 16); }
  for (const maxLeaves of [0, 1, 9, 2.5]) assert.throws(() => createStandingHistoryParallelPlanner({ ...f.args, maxLeaves }));
});

test("coverage scan honors later committed gaps and merge descendants without inventing coverage", async t => {
  const f = fixture([...Array<number>(20).fill(3), 0], 0);
  f.appendNode(leaf(f.pages[1]!, 1)); f.appendNode(leaf(f.pages[6]!, 2));
  f.appendNode({ nodeRef: "hnode_" + hex(3, 48), index: 3, hash: hex(2003), kind: "merge", inputs: { children: f.nodes.map(n => n.nodeRef) }, coverage: f.nodes.flatMap(n => n.coverage), output: { summary: "merged", claims: [] } });
  const planner = createStandingHistoryParallelPlanner(f.args); t.after(() => planner.close());
  const result = await selected(f, planner); assert.equal(result.kind, "leaf-wave"); if (result.kind !== "leaf-wave") return;
  assert.deepEqual(result.plans.flatMap(p => p.inputs.map(i => i.pageIndex)), Array.from({ length: 21 }, (_, i) => i + 1).filter(i => i !== 2 && i !== 7));
  assert.equal(result.plans.flatMap(fragmentsOf).flatMap(p => p.rows).length, 54);
});

test("within-page fragmented coverage preserves whole long Unicode messages and both uncovered sides", async t => {
  const f = fixture([8, 0], 0), original = f.pages[0]!;
  f.pages[0] = { ...original, result: { ...original.result, page: { ...original.result.page, messages: original.result.page.messages.map((m, i) => ({ ...m, text: `${i} ${"🙂я".repeat(1300)}` })) } } };
  const prefix = projectStandingHistorySource({ intent, referenceKey, storedPage: f.pages[0]!, maxRows: 2, maxBytes: 49152 });
  f.appendNode(leaf(f.pages[0]!, 1, 1, prefix.nextPosition!));
  const planner = createStandingHistoryParallelPlanner(f.args); t.after(() => planner.close());
  const result = await selected(f, planner); assert.equal(result.kind, "leaf-wave"); if (result.kind !== "leaf-wave") return;
  const all = result.plans.flatMap(fragmentsOf), spans = all.filter(p => p.pageIndex === 1).map(p => [p.range.fromRow, p.range.toRow]);
  assert.deepEqual(spans, [[0, 2], [3, 8]]);
  assert.equal(all.flatMap(p => p.rows).length, 7);
  for (const p of result.plans) assert.ok(Buffer.byteLength(JSON.stringify(p.material)) <= 49152);
  for (const row of all.flatMap(p => p.rows)) if (row.disposition === "included") assert.ok(f.pages[0]!.result.page.messages.some(m => m.text === row.text));
});

test("single leaf/read-more and all-covered merge/ready are unchanged wide fallbacks", async t => {
  for (const [counts, analyzed] of [[[3], 0], [[3, 0], 0], [[1, 1, 0], 3], [[1, 0], 1]] as const) {
    const f = fixture([...counts], analyzed), parallel = createStandingHistoryParallelPlanner(f.args), serial = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "wide" });
    t.after(() => parallel.close()); t.after(() => serial.close());
    assert.deepEqual(await selected(f, parallel), await selected(f, serial));
  }
});

test("source or analysis changes during await invalidate accumulated wave and force authentic rescan", async t => {
  for (const changed of ["source", "analysis"] as const) {
    const f = fixture([...Array<number>(16).fill(1), 0], 0), originalRead = f.args.source.readPage;
    let mutate = true;
    f.args.source.readPage = async index => {
      const page = await originalRead(index);
      if (index === 15 && mutate) {
        mutate = false;
        if (changed === "source") f.state.source = { ...f.state.source, readProgress: { ...f.state.source.readProgress, chainHash: hex(9990) } };
        else f.appendNode(leaf(f.pages[0]!, 1));
      }
      return page;
    };
    const planner = createStandingHistoryParallelPlanner(f.args); t.after(() => planner.close());
    const result = await selected(f, planner); assert.equal(result.kind, "leaf-wave"); if (result.kind !== "leaf-wave") continue;
    assert.equal(result.sourceHead, f.state.source.readProgress.chainHash); assert.equal(result.expectedHead, f.state.analysis.headHash);
    assert.ok(f.calls.filter(c => c.kind === "page" && c.index === 1).length >= 2);
    if (changed === "analysis") assert.ok(result.plans.every(p => p.inputs.every(i => i.pageIndex !== 1)));
  }
});

test("tail refusal, overlap, page hash mismatch and remaining node quota refuse wave admission", async t => {
  for (const defect of ["tail", "overlap", "page-hash", "quota"] as const) {
    const f = fixture([...Array<number>(16).fill(1), 0], 0);
    if (defect === "tail") f.state.analysis = { ...f.state.analysis, storage: "tail-refused" };
    if (defect === "overlap") { f.appendNode(leaf(f.pages[0]!, 1)); f.appendNode(leaf(f.pages[0]!, 2)); }
    if (defect === "page-hash") { f.appendNode(leaf(f.pages[0]!, 1)); f.pages[0] = { ...f.pages[0]!, hash: hex(9000) }; }
    if (defect === "quota") f.state.analysis = { ...f.state.analysis, limits: { ...f.state.analysis.limits, maximumNodes: 2 } };
    const planner = createStandingHistoryParallelPlanner(f.args); t.after(() => planner.close());
    assert.equal((await selected(f, planner)).kind, "blocked", defect);
  }
});

test("close joins in-flight host read, revokes output and refuses concurrent next", async () => {
  const f = fixture(Array<number>(17).fill(1), 0);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { entered = resolve; });
  f.args.source.readPage = async index => { entered(); await gate; return f.pages[index - 1]; };
  const planner = createStandingHistoryParallelPlanner(f.args), pending = planner.next();
  await observed; await assert.rejects(planner.next(), /BUSY/);
  let settled = false; const closing = planner.close().then(() => { settled = true; });
  await immediate(); assert.equal(settled, false); release();
  await assert.rejects(pending, /CLOSED/); await closing; await assert.rejects(planner.next(), /CLOSED/);
});
