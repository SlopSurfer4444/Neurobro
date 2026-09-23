import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { createStandingHistoryAnalysisPlanner, type StandingHistoryAnalysisPlan, type StandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { projectMergeView, StandingHistoryAnalysisViewError } from "../src/standing-history-analysis-view.js";
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
test("source-aware planner uses observed checkpoint peer and refuses internal-page substitution", async t => {
  const f = fixture([3], 0), selectedIntent: StandingHistoryTaskIntent = { ...intent, source: {
    kind: "observed-source", sourceRef: "community", workspaceId: "synthetic-workspace", peerId: "-100987" } };
  f.pages[0] = { ...f.pages[0]!, result: { ...f.pages[0]!.result,
    beforeCheckpoint: { ...f.pages[0]!.result.beforeCheckpoint, chatId: selectedIntent.source!.peerId },
    nextCheckpoint: { ...f.pages[0]!.result.nextCheckpoint, chatId: selectedIntent.source!.peerId } } };
  f.state.source = { ...f.state.source, readProgress: { ...f.state.source.readProgress, checkpoint: f.pages[0]!.result.nextCheckpoint } };
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, intent: selectedIntent }); t.after(() => planner.close());
  const result = await selected(f, planner); assert.equal(result.kind, "leaf");
  if (result.kind === "leaf") { assert.equal(result.material.sourceRef, "community"); assert.equal(result.material.sourceInterpretation, "quoted-source-not-request"); }
  f.state.source = { ...f.state.source, readProgress: { ...f.state.source.readProgress,
    checkpoint: { ...f.state.source.readProgress.checkpoint, chatId: intent.chatId } } };
  assert.deepEqual(await planner.next(), { kind: "blocked", reason: "binding" });
});
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

function merged(f: ReturnType<typeof fixture>, children: readonly [StandingHistoryAnalysisNode, StandingHistoryAnalysisNode]): StandingHistoryAnalysisNode {
  const index = f.nodes.length + 1;
  return { nodeRef: "hnode_" + hex(index, 48), index, hash: hex(2000 + index), kind: "merge", inputs: { children: children.map(node => node.nodeRef) },
    coverage: children.flatMap(node => node.coverage), output: { summary: "Synthetic combined notes", claims: [] } };
}

test("sequential history forms a balanced tree, survives planner restart and retains every disjoint leaf", async t => {
  const f = fixture([], 0), planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
  const depth = new Map<string, number>(); let ready: Extract<StandingHistoryAnalysisPlan, { kind: "analysis-ready" }> | undefined;
  for (let pageIndex = 0; pageIndex < 33; pageIndex++) {
    const page = storedPage(f.state.source.readProgress.checkpoint, pageIndex === 32 ? 0 : 1); f.pages.push(page);
    f.state.source = { ...f.state.source, readProgress: { committedPages: f.pages.length, checkpoint: page.result.nextCheckpoint, chainHash: page.hash } };
    for (let iterations = 0; iterations < 100; iterations++) {
      const plan = await selected(f, planner);
      if (plan.kind === "read-more") { assert.ok(pageIndex < 32); break; }
      if (plan.kind === "analysis-ready") { ready = plan; break; }
      assert.ok(plan.kind === "leaf" || plan.kind === "merge");
      if (plan.kind === "leaf") {
        const node = leaf(f.pages[plan.material.pageIndex - 1]!, f.nodes.length + 1); depth.set(node.nodeRef, 0); f.appendNode(node);
      } else {
        const restarted = createStandingHistoryAnalysisPlanner(f.args);
        try { assert.deepEqual(await selected(f, restarted), plan); } finally { await restarted.close(); }
        const children = plan.children.map(ref => f.nodes.find(node => node.nodeRef === ref)!) as [StandingHistoryAnalysisNode, StandingHistoryAnalysisNode];
        const node = merged(f, children); depth.set(node.nodeRef, 1 + Math.max(...children.map(child => depth.get(child.nodeRef)!))); f.appendNode(node);
      }
    }
  }
  assert.ok(ready?.rootRef); assert.equal(ready.coverage.readTraversalComplete, true); assert.equal(ready.coverage.committedPages, 33);
  assert.ok(depth.get(ready.rootRef)! <= 6, "33 leaves must not form a 32-level left fold");
  const root = f.nodes.find(node => node.nodeRef === ready!.rootRef)!;
  assert.equal(root.coverage.length, 33); assert.equal(new Set(root.coverage.map(span => span.materialRef)).size, 33);
  assert.equal(root.coverage.reduce((total, span) => total + span.range.toRow - span.range.fromRow, 0), 32);
  assert.equal(f.nodes.length, 65);
});

test("old unbalanced reductions remain readable and wait for comparable new source weight", async t => {
  const f = fixture([1, 1, 1, 1]);
  f.appendNode(merged(f, [f.nodes[0]!, f.nodes[1]!]));
  f.appendNode(merged(f, [f.nodes[4]!, f.nodes[2]!]));
  const planner = createStandingHistoryAnalysisPlanner(f.args); t.after(() => planner.close());
  assert.equal((await selected(f, planner)).kind, "read-more");
  const checkpoint = { ...f.state.source.readProgress.checkpoint, status: "lower-bound-reached" as const };
  f.state.source = { ...f.state.source, readProgress: { ...f.state.source.readProgress, checkpoint } };
  const restarted = createStandingHistoryAnalysisPlanner(f.args); t.after(() => restarted.close());
  const plan = await selected(f, restarted); assert.equal(plan.kind, "merge");
  if (plan.kind === "merge") assert.deepEqual(plan.children, [f.nodes[5]!.nodeRef, f.nodes[3]!.nodeRef]);
});

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

async function selectedWide(f: ReturnType<typeof fixture>, planner: StandingHistoryAnalysisPlanner) {
  for (let i = 0; i < 1200; i++) {
    const before = f.calls.length, plan = await planner.next();
    assert.ok(f.calls.length - before <= 8, "wide planning preserves the bounded host-call slice");
    if (plan.kind !== "scan-more") return plan;
  }
  assert.fail("wide planner did not finish bounded inventory");
}
function appendWideLeaf(f: ReturnType<typeof fixture>, plan: Extract<StandingHistoryAnalysisPlan, { kind: "leaf" }>, large = false) {
  const index = f.nodes.length + 1, fragments = plan.material.schema === "standing-history-source-batch-v1" ? plan.material.fragments : [plan.material];
  assert.equal(fragments.length, plan.inputs.length); assert.ok(fragments.length <= (large ? 128 : 8));
  assert.ok(Buffer.byteLength(JSON.stringify(plan.material)) <= (large ? 1048576 : 49152));
  const materials = fragments.map((material, i) => {
    const descriptor = plan.inputs[i]!;
    assert.deepEqual(material, projectStandingHistorySource({ intent, referenceKey, storedPage: f.pages[descriptor.pageIndex - 1]!,
      maxBytes: descriptor.maxBytes, ...(descriptor.maxRows === undefined ? {} : { maxRows: descriptor.maxRows }), ...(descriptor.position ? { position: descriptor.position } : {}) }));
    return { ...descriptor, pageHash: material.pageHash, range: material.range, coverage: material.coverage,
      supports: material.rows.filter(row => row.disposition === "included").map(row => ({ sourceRef: row.sourceRef, versionRef: row.versionRef })) };
  });
  const node: StandingHistoryAnalysisNode = { nodeRef: "hnode_" + hex(index, 48), index, hash: hex(2000 + index), kind: "leaf", inputs: { materials },
    coverage: materials.map(({ materialRef, pageIndex, pageHash, range, coverage }) => ({ materialRef, pageIndex, pageHash, range, coverage })),
    output: { summary: "Synthetic packed source", claims: [] } };
  f.appendNode(node); return node;
}

test("large packing gathers the available period into one leaf and resumes old covered nodes without replay", async t => {
  const f = fixture(Array<number>(40).fill(2), 0);
  f.appendNode(leaf(f.pages[2]!, 1));
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "large" }); t.after(() => planner.close());
  assert.equal((await selectedWide(f, planner)).kind, "read-more", "incomplete small corpus must be gathered first");
  const terminal = storedPage(f.state.source.readProgress.checkpoint, 0); f.pages.push(terminal);
  f.state.source = { ...f.state.source, readProgress: { committedPages: f.pages.length, checkpoint: terminal.result.nextCheckpoint, chainHash: terminal.hash } };
  const plan = await selectedWide(f, planner); assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") return;
  assert.equal(plan.inputs.length, 40); assert.ok(plan.inputs.every(i => i.pageIndex !== 3));
  const restarted = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "large" }); t.after(() => restarted.close());
  assert.deepEqual(await selectedWide(f, restarted), plan);
  appendWideLeaf(f, plan, true);
  const merge = await selectedWide(f, planner); assert.equal(merge.kind, "merge");
  if (merge.kind === "merge") { assert.equal(merge.viewMaxBytes, 1048576); assert.equal(merge.children.length, 2); }
  const oldInputs = f.nodes[0]!.inputs; assert.ok("materials" in oldInputs); assert.equal(oldInputs.materials[0]!.maxBytes, 49152);
});

test("large packing splits dense source only at whole rows near the 1MiB material budget", async t => {
  const f = fixture([...Array<number>(48).fill(4), 0], 0);
  for (let index = 0; index < 48; index++) {
    const page = f.pages[index]!;
    f.pages[index] = { ...page, result: { ...page.result, page: { ...page.result.page,
      messages: page.result.page.messages.map(m => ({ ...m, text: m.ref + "я".repeat(5900) })) } } };
  }
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "large" }); t.after(() => planner.close());
  const rows: string[] = [];
  let leaves = 0;
  for (;;) {
    const plan = await selectedWide(f, planner);
    if (plan.kind !== "leaf") { assert.equal(plan.kind, "merge"); break; }
    leaves++;
    const encoded = Buffer.byteLength(JSON.stringify(plan.material));
    assert.ok(encoded <= 1048576); if (leaves <= 2) assert.ok(encoded > 950000);
    const fragments = plan.material.schema === "standing-history-source-batch-v1" ? plan.material.fragments : [plan.material];
    rows.push(...fragments.flatMap(fragment => fragment.rows.map(row => row.sourceRef)));
    appendWideLeaf(f, plan, true);
  }
  assert.equal(leaves, 3); assert.equal(rows.length, 192); assert.equal(new Set(rows).size, 192);
});

test("large merge packs the largest complete ordered prefix across bounded quanta", async t => {
  const f = fixture([...Array<number>(64).fill(1), 0]);
  for (let index = 0; index < f.nodes.length; index++) {
    const n = f.nodes[index]!;
    f.nodes[index] = { ...n, output: { summary: "я".repeat(16384), claims: Array.from({ length: 64 }, (_, i) => ({
      kind: "reported" as const, text: "я".repeat(500) + String(i), supports: [{ sourceRef: "hsrc_" + hex(index + 1, 48), versionRef: "hver_" + hex(index + 1, 48) }] })) } };
  }
  // Independent exhaustive oracle over a short fitting prefix, not the planner's search.
  let expected = 0;
  for (let count = 2; count <= f.nodes.length; count++) {
    try { const view = projectMergeView({ children: f.nodes.slice(0, count), referenceKey, maxBytes: 1048576, preferComplete: true });
      assert.equal(view.detailCoverage, "complete"); expected = count;
    } catch (error) { assert.ok(error instanceof StandingHistoryAnalysisViewError && error.code === "limit"); break; }
  }
  assert.ok(expected > 2 && expected < f.nodes.length);
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "large" }); t.after(() => planner.close());
  let quanta = 0, result: StandingHistoryAnalysisPlan;
  do { const before = f.calls.length; result = await planner.next(); assert.ok(f.calls.length - before <= 8); quanta++; } while (result.kind === "scan-more" && quanta < 100);
  assert.equal(result.kind, "merge"); if (result.kind !== "merge") return;
  assert.deepEqual(result.children, f.nodes.slice(0, expected).map(n => n.nodeRef));
  assert.ok(result.materials.every(n => n.detailCoverage === "complete"));
  assert.deepEqual(result.materials, projectMergeView({ children: f.nodes.slice(0, expected), referenceKey, maxBytes: 1048576, preferComplete: true }).children);
  assert.ok(quanta <= 52, "packing should stop reading children at the first byte-overflowing prefix");
});

test("large merge packs all 200 small frontier roots without a policy count cutoff", async t => {
  const f = fixture([...Array<number>(199).fill(1), 0]);
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "large" }); t.after(() => planner.close());
  const result = await selectedWide(f, planner); assert.equal(result.kind, "merge"); if (result.kind !== "merge") return;
  assert.equal(result.children.length, 200); assert.deepEqual(result.children, f.nodes.map(n => n.nodeRef));
  const expected = projectMergeView({ children: f.nodes, referenceKey, maxBytes: 1048576, preferComplete: true });
  assert.deepEqual(result.materials, expected.children); assert.ok(Buffer.byteLength(JSON.stringify(expected)) <= 1048576);
  const cold = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "large" }); t.after(() => cold.close());
  assert.deepEqual(await selectedWide(f, cold), result);
});

test("large merge preserves the exact bounded pair fallback when full child notes cannot fit", async t => {
  const f = fixture([1, 1, 0]);
  for (let i = 0; i < 2; i++) {
    const n = f.nodes[i]!;
    f.nodes[i] = { ...n, output: { summary: "\u0001".repeat(32767) + "x", claims: Array.from({ length: 128 }, () => ({
      kind: "reported" as const, text: "\u0001".repeat(1023) + "x", supports: n.output.claims[0]!.supports })) } };
  }
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "large" }); t.after(() => planner.close());
  const result = await selectedWide(f, planner); assert.equal(result.kind, "merge"); if (result.kind !== "merge") return;
  const expected = projectMergeView({ children: f.nodes.slice(0, 2), referenceKey, maxBytes: 1048576, preferComplete: true });
  assert.equal(expected.detailCoverage, "partial"); assert.deepEqual(result.materials, expected.children);
  assert.deepEqual(result.children, f.nodes.slice(0, 2).map(n => n.nodeRef));
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) <= 1048576);
});

test("wide sequential packing gathers pages before analysis, preserves exact descriptors and reduces 33 pages in six nodes", async t => {
  const f = fixture([], 0), planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "wide" }); t.after(() => planner.close());
  let ready: Extract<StandingHistoryAnalysisPlan, { kind: "analysis-ready" }> | undefined;
  for (let pageIndex = 0; pageIndex < 33; pageIndex++) {
    const page = storedPage(f.state.source.readProgress.checkpoint, pageIndex === 32 ? 0 : 1); f.pages.push(page);
    f.state.source = { ...f.state.source, readProgress: { committedPages: f.pages.length, checkpoint: page.result.nextCheckpoint, chainHash: page.hash } };
    for (let iteration = 0; iteration < 100; iteration++) {
      const plan = await selectedWide(f, planner);
      if (plan.kind === "read-more") { assert.ok(pageIndex < 32); break; }
      if (plan.kind === "analysis-ready") { ready = plan; break; }
      assert.ok(plan.kind === "leaf" || plan.kind === "merge");
      const restarted = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "wide" });
      try { assert.deepEqual(await selectedWide(f, restarted), plan); } finally { await restarted.close(); }
      if (plan.kind === "leaf") appendWideLeaf(f, plan);
      else {
        const children = plan.children.map(ref => f.nodes.find(n => n.nodeRef === ref)!);
        assert.equal(children.length, 5); assert.ok(plan.materials.every(child => child.detailCoverage === "complete"));
        const index = f.nodes.length + 1;
        f.appendNode({ nodeRef: "hnode_" + hex(index, 48), index, hash: hex(2000 + index), kind: "merge", inputs: { children: plan.children },
          coverage: children.flatMap(n => n.coverage), output: { summary: "Complete available synthetic input", claims: [] } });
      }
    }
  }
  assert.ok(ready?.rootRef); assert.equal(ready.coverage.readTraversalComplete, true);
  assert.equal(f.nodes.length, 6); assert.equal(f.nodes.filter(n => n.kind === "leaf").length, 5);
  const root = f.nodes.at(-1)!;
  assert.equal(root.coverage.length, 33); assert.equal(new Set(root.coverage.map(s => s.materialRef)).size, 33);
  assert.equal(root.coverage.reduce((total, s) => total + s.range.toRow - s.range.fromRow, 0), 32);
});

test("wide fulltext packing retains every Unicode message once within the actual serialized wire budget", async t => {
  const f = fixture([6], 0), original = f.pages[0]!;
  const result = snapshotStandingHistoryTaskPage({ ...original.result, page: { ...original.result.page,
    messages: original.result.page.messages.map((m, i) => ({ ...m, text: String(i) + "Я🙂".repeat(1600) })) } });
  f.pages[0] = { ...original, result };
  f.state.source = { ...f.state.source, readProgress: { ...f.state.source.readProgress, checkpoint: { ...result.nextCheckpoint, status: "lower-bound-reached" } } };
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "wide" }); t.after(() => planner.close());
  const texts: string[] = [], ranges: { fromRow: number; toRow: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const plan = await selectedWide(f, planner);
    if (plan.kind !== "leaf") { assert.equal(plan.kind, "merge"); break; }
    const fragments = plan.material.schema === "standing-history-source-batch-v1" ? plan.material.fragments : [plan.material];
    for (const fragment of fragments) {
      ranges.push(fragment.range); for (const row of fragment.rows) if (row.disposition === "included") texts.push(row.text);
    }
    appendWideLeaf(f, plan);
  }
  assert.equal(texts.length, 6); assert.deepEqual([...texts].sort(), result.page.messages.map(m => m.text).sort());
  assert.equal(ranges[0]!.fromRow, 0); assert.equal(ranges.at(-1)!.toRow, 6);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i - 1]!.toRow, ranges[i]!.fromRow);
});

test("wide reading waits for eight comparable roots and resumes all child reads before complete merge", async t => {
  const seven = fixture(Array(7).fill(1)), waiting = createStandingHistoryAnalysisPlanner({ ...seven.args, packing: "wide" }); t.after(() => waiting.close());
  assert.equal((await selectedWide(seven, waiting)).kind, "read-more");
  const f = fixture(Array(8).fill(1)), planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "wide" }); t.after(() => planner.close());
  const plan = await selectedWide(f, planner); assert.equal(plan.kind, "merge"); if (plan.kind !== "merge") return;
  assert.deepEqual(plan.children, f.nodes.map(n => n.nodeRef)); assert.ok(plan.materials.every(n => n.detailCoverage === "complete"));
  assert.equal(f.calls.filter(c => c.kind === "node").length, 16, "eight inventory reads plus eight bound material reads");
  assert.deepEqual(await selectedWide(f, planner), plan);
});

test("wide cross-page batches account for their wrapper and continue before the next whole row", async t => {
  const f = fixture([2, 2, 0], 0), expected: string[] = [];
  for (let i = 0; i < 2; i++) {
    const page = f.pages[i]!;
    const messages = page.result.page.messages.map((m, j) => ({ ...m, text: `${i}:${j}:` + "🙂".repeat(3200) }));
    expected.push(...messages.map(m => m.text));
    f.pages[i] = { ...page, result: snapshotStandingHistoryTaskPage({ ...page.result, page: { ...page.result.page, messages } }) };
  }
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "wide" }); t.after(() => planner.close());
  const observed: string[] = []; let batches = 0, emptyMarkers = 0;
  for (let i = 0; i < 10; i++) {
    const plan = await selectedWide(f, planner); if (plan.kind !== "leaf") { assert.equal(plan.kind, "merge"); break; }
    const fragments = plan.material.schema === "standing-history-source-batch-v1" ? (batches++, plan.material.fragments) : [plan.material];
    for (const fragment of fragments) {
      if (!fragment.range.totalRows) emptyMarkers++;
      for (const row of fragment.rows) if (row.disposition === "included") observed.push(row.text);
    }
    appendWideLeaf(f, plan);
  }
  assert.ok(batches >= 1); assert.equal(emptyMarkers, 1); assert.deepEqual(observed.sort(), expected.sort());
});

test("wide fan-in shrinks to complete notes without hiding more claims and retains stale-head fencing", async t => {
  const f = fixture(Array(8).fill(1));
  for (let i = 0; i < f.nodes.length; i++) {
    const n = f.nodes[i]!, support = n.output.claims[0]!.supports;
    f.nodes[i] = { ...n, output: { summary: "Summary".repeat(500), claims: Array.from({ length: 16 }, () => ({ kind: "reported" as const, text: "Claim".repeat(180), supports: support })) } };
  }
  const planner = createStandingHistoryAnalysisPlanner({ ...f.args, packing: "wide" }); t.after(() => planner.close());
  const plan = await selectedWide(f, planner); assert.equal(plan.kind, "merge"); if (plan.kind !== "merge") return;
  assert.equal(plan.children.length, 2); assert.ok(plan.materials.every(n => n.detailCoverage === "complete" && n.claims.length === 16));
  f.state.analysis = { ...f.state.analysis, storage: "tail-refused" };
  assert.deepEqual(await planner.next(), { kind: "blocked", reason: "tail-refused" });
});
