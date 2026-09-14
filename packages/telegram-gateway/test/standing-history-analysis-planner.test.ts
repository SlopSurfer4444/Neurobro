import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { createStandingHistoryAnalysisPlanner, type StandingHistoryAnalysisPlan } from "../src/standing-history-analysis-planner.js";
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
type Planner = ReturnType<typeof createStandingHistoryAnalysisPlanner>;
async function next(f: ReturnType<typeof fixture>, planner: Planner) {
  const before = f.calls.length, plan = await planner.next(), calls = f.calls.slice(before);
  assert.ok(calls.length <= 8, JSON.stringify(calls));
  // A returned leaf/merge requires one pure projection in addition to callbacks.
  if (plan.kind === "leaf" || plan.kind === "merge") assert.ok(calls.length + 1 <= 8);
  return plan;
}
async function selected(f: ReturnType<typeof fixture>, planner: Planner) {
  for (let i = 0; i < 100; i++) { const plan = await next(f, planner); if (plan.kind !== "scan-more") return plan; }
  assert.fail("planner did not finish its bounded synthetic inventory");
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("uncovered source yields actual projected leaf and stable plan until analysis head advances", async t => {
  const f = fixture([3], 0), planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
  const plan = await selected(f, planner); assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") return;
  assert.deepEqual(plan.material, projectStandingHistorySource({ intent, referenceKey, storedPage: f.pages[0]!, maxBytes: plan.inputs[0].maxBytes, maxRows: plan.inputs[0].maxRows! }));
  assert.equal(plan.expectedHead, f.state.analysis.headHash); assert.equal(plan.sourceHead, f.state.source.readProgress.chainHash);
  const before = f.calls.length; assert.deepEqual(await next(f, planner), plan);
  assert.deepEqual(f.calls.slice(before).map(c => c.kind), ["source-status", "analysis-status", "source-status", "analysis-status"]);
  f.appendNode(leaf(f.pages[0]!, 1)); const after = await selected(f, planner); assert.equal(after.kind, "read-more");
});

test("inventory beyond eight nodes continues through bounded reads and selects earliest reduction roots", async t => {
  const f = fixture(Array(12).fill(1)), planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
  const progress: number[] = []; let plan: StandingHistoryAnalysisPlan;
  do { plan = await next(f, planner); if (plan.kind === "scan-more") progress.push(plan.progress.nodesScanned); } while (plan.kind === "scan-more");
  assert.ok(progress.length >= 3); assert.ok(progress.some(n => n > 8)); assert.equal(plan.kind, "merge");
  if (plan.kind !== "merge") return;
  assert.deepEqual(plan.children, [f.nodes[0]!.nodeRef, f.nodes[1]!.nodeRef]);
  assert.deepEqual(plan.materials.map(m => m.nodeHash), [f.nodes[0]!.hash, f.nodes[1]!.hash]);
  assert.ok(plan.materials.every(m => m.claimsStatus === "model-authored-unverified"));
  assert.deepEqual(f.calls.filter(c => c.kind === "node").slice(0, 12).map(c => c.index), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(await next(f, planner), plan);
});

test("partial page leaves plan only the uncovered row gap, including gaps before retained suffixes", async t => {
  const f = fixture([5], 0), page = f.pages[0]!, firstFragment = projectStandingHistorySource({ intent, referenceKey, storedPage: page, maxRows: 2 });
  assert.ok(firstFragment.nextPosition);
  f.appendNode(leaf(page, 1, 2, firstFragment.nextPosition));
  const planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
  const plan = await selected(f, planner); assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") return;
  assert.deepEqual(plan.material.range, { fromRow: 0, toRow: 2, totalRows: 5 });
  assert.equal(plan.inputs[0].maxRows, 2); assert.notEqual(plan.material.materialRef, f.nodes[0]!.coverage[0]!.materialRef);
});

test("missing pages/nodes, malformed returned data and changed page hashes block without readiness", async t => {
  for (const broken of ["missing-page", "missing-node", "malformed-page", "page-binding"] as const) {
    const f = fixture([1], broken === "missing-page" || broken === "malformed-page" ? 0 : 1);
    if (broken === "missing-page") f.args.source.readPage = async () => undefined;
    if (broken === "missing-node") f.args.analysis.readNodeAt = async () => undefined;
    if (broken === "malformed-page") f.args.source.readPage = async () => ({ ...f.pages[0]!, result: {} as never });
    if (broken === "page-binding") f.args.source.readPage = async () => ({ ...f.pages[0]!, hash: hex(99999) });
    const planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
    const plan = await selected(f, planner); assert.equal(plan.kind, "blocked", broken);
  }
});

test("source or analysis tail refusal is rechecked even after caching a leaf plan", async t => {
  for (const side of ["source", "analysis"] as const) {
    const f = fixture([1], 0), planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
    assert.equal((await selected(f, planner)).kind, "leaf");
    f.state[side] = { ...f.state[side], storage: "tail-refused" } as never;
    assert.deepEqual(await next(f, planner), { kind: "blocked", reason: "tail-refused" });
  }
});

test("head changes while reading discard stale candidates before returning them", async t => {
  const f = fixture([1], 0), original = f.args.source.readPage;
  f.args.source.readPage = async index => { const page = await original(index); f.state.source = { ...f.state.source,
    readProgress: { ...f.state.source.readProgress, chainHash: hex(98765) } }; return page; };
  const planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
  assert.equal((await next(f, planner)).kind, "scan-more");
  f.args.source.readPage = original; // The planner retains the original method capability; its next head is stable now.
  const plan = await selected(f, planner); assert.equal(plan.kind, "leaf");
  if (plan.kind === "leaf") assert.equal(plan.sourceHead, hex(98765));
});

test("more source history always yields read-more, never analysis-ready for an empty or covered frontier", async t => {
  for (const counts of [[], [1]]) {
    const f = fixture(counts), planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
    const plan = await selected(f, planner); assert.equal(plan.kind, "read-more");
    if (plan.kind === "read-more") assert.deepEqual(plan.checkpoint, f.state.source.readProgress.checkpoint);
  }
});

test("terminal inaccessible/inexact/undated gaps remain explicit and cannot claim traversal completeness", async t => {
  for (const terminalStatus of ["inaccessible", "empty-page"] as const) {
  const f = fixture([2, 0], 0), original = f.pages[0]!, originalLast = f.pages[1]!;
  const nextCheckpoint: SelfHistoryTaskCheckpoint = { ...original.result.nextCheckpoint, lastDate: 1999, oldestDate: 1999, newestDate: 1999, undated: 1, inexact: true };
  const first = snapshotStandingHistoryTaskPage({ ...original.result, nextCheckpoint,
    sources: [{ messageId: 9999, date: 1999, disposition: "nonText" }, { messageId: 9998, date: null, disposition: "unavailable" }],
    page: { ...original.result.page, messages: [], excluded: { nonText: 1, invalidText: 0, unavailable: 1, outsidePeriod: 0 },
      coverage: { ...original.result.page.coverage, oldestExaminedDate: 1999, newestExaminedDate: 1999, undatedEntries: 1 } } });
  const terminalPages = terminalStatus === "empty-page" ? 2 : 1;
  const last = snapshotStandingHistoryTaskPage({ ...originalLast.result, beforeCheckpoint: nextCheckpoint, nextCheckpoint: { ...nextCheckpoint, pages: terminalPages, status: terminalStatus },
    page: { ...originalLast.result.page, status: terminalStatus, coverage: { ...first.page.coverage, pages: terminalPages, traversalComplete: false } } });
  f.pages[0] = { ...original, result: first }; f.pages[1] = { ...originalLast, result: last };
  f.state.source = { ...f.state.source, readProgress: { ...f.state.source.readProgress, checkpoint: last.nextCheckpoint } };
  f.appendNode(leaf(f.pages[0], 1)); f.appendNode(leaf(f.pages[1], 2));
  const planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
  const merge = await selected(f, planner); assert.equal(merge.kind, "merge"); if (merge.kind !== "merge") return;
  f.appendNode({ nodeRef: "hnode_" + hex(3, 48), index: 3, hash: hex(2003), kind: "merge", inputs: { children: merge.children },
    coverage: f.nodes.flatMap(n => n.coverage), output: { summary: "Incomplete available history", claims: [] } });
  const plan = await selected(f, planner); assert.equal(plan.kind, "analysis-ready"); if (plan.kind !== "analysis-ready") return;
  assert.equal(plan.coverage.readTraversalComplete, false); assert.equal(plan.rootRef, f.nodes[2]!.nodeRef); assert.equal(plan.coverage.committedPages, 2);
  assert.deepEqual(plan.gaps, [...(terminalStatus === "inaccessible" ? [{ kind: "inaccessible-history" }] : []), { kind: "inexact-history" }, { kind: "undated-entries", count: 1 }, { kind: "nonText", count: 1 }, { kind: "unavailable", count: 1 }]);
  }
});

test("terminal empty coverage requires its leaf marker and reports the retained root", async t => {
  const f = fixture([0], 0), planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
  assert.equal((await selected(f, planner)).kind, "leaf"); f.appendNode(leaf(f.pages[0]!, 1));
  const plan = await selected(f, planner); assert.equal(plan.kind, "analysis-ready"); if (plan.kind !== "analysis-ready") return;
  assert.equal(plan.rootRef, f.nodes[0]!.nodeRef); assert.equal(plan.coverage.coveredPages, 1); assert.equal(plan.coverage.coveredRows, 0);
  assert.equal(plan.coverage.readTraversalComplete, true); assert.deepEqual(plan.gaps, []);
});

test("local quotas produce explicit blockers rather than implying reading or analysis completion", async t => {
  for (const mode of ["leaf", "merge", "read"] as const) {
    const f = mode === "leaf" ? fixture([1], 0) : mode === "merge" ? fixture([1, 1]) : fixture([]);
    if (mode === "read") f.state.source = { ...f.state.source, limits: { ...f.state.source.limits, pageQuotaReached: true } };
    else f.state.analysis = { ...f.state.analysis, limits: { ...f.state.analysis.limits, nodeQuotaReached: true } };
    const planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
    assert.deepEqual(await selected(f, planner), { kind: "blocked", reason: mode === "read" ? "source-page-quota" : "analysis-node-quota" });
  }
});

test("close and abort join pending host callbacks and refuse simultaneous or later planning", async t => {
  for (const cancel of ["close", "abort"] as const) {
    const f = fixture([1], 0), entered = deferred(), release = deferred(), controller = new AbortController();
    f.args.source.readPage = async () => { entered.resolve(); await release.promise; return f.pages[0]; };
    const planner = createStandingHistoryAnalysisPlanner({ ...f.args, signal: controller.signal }); t.after(() => planner.close());
    const pending = planner.next(), outcome = pending.then(() => "resolved", () => "rejected"); await entered.promise;
    await assert.rejects(planner.next(), /BUSY/u); if (cancel === "abort") controller.abort();
    let closed = false; const closing = planner.close().then(() => { closed = true; }); await immediate(); assert.equal(closed, false);
    release.resolve(); await closing; assert.equal(await outcome, "rejected"); await assert.rejects(planner.next(), /CLOSED/u);
  }
});

test("constructor and callback getters/proxies execute no user code", async t => {
  const f = fixture([1], 0); let calls = 0;
  for (const args of [{ ...f.args, get intent() { calls++; return intent; } },
    new Proxy(f.args, { ownKeys() { calls++; throw Error("trap"); } }),
    { ...f.args, source: { ...f.args.source, get readPage() { calls++; return f.args.source.readPage; } } },
    { ...f.args, analysis: new Proxy(f.args.analysis, { getOwnPropertyDescriptor() { calls++; throw Error("trap"); } }) }])
    assert.throws(() => createStandingHistoryAnalysisPlanner(args));
  assert.equal(calls, 0);
  for (const returned of [{ ...f.pages[0]!, get result() { calls++; return f.pages[0]!.result; } },
    new Proxy(f.pages[0]!, { getPrototypeOf() { calls++; throw Error("trap"); } })]) {
    const local = fixture([1], 0); local.args.source.readPage = async () => returned;
    const planner = createStandingHistoryAnalysisPlanner(local.args); t.after(() => planner.close());
    assert.equal((await selected(local, planner)).kind, "blocked"); assert.equal(calls, 0);
  }
});
