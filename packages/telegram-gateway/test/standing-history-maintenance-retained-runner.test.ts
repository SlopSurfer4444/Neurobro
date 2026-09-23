import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding, type StandingHistoryAnalysisAttemptPlan } from "../src/standing-history-analysis-attempt-store.js";
import { openStandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { createStandingHistoryTaskMemory } from "../src/standing-history-task-memory.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { openStandingHistoryTaskRunner, standingWaitCode, type StandingHistoryTaskRunner, type StandingHistoryTaskRunnerInput, type StandingHistoryTaskWork } from "../src/standing-history-task-runner.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import type { StandingPollWork, StandingSelection, StandingIdleHistoryTicket } from "../src/standing-conversation-adapter.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import { readStandingHistoryTaskDisposition, recordStandingHistoryTaskDisposition } from "../src/standing-history-task-disposition.js";
import { requireStandingChronicleNote } from "../src/standing-chronicle-note.js";
import { runStandingHistoryTaskDelivery, readStandingHistoryTaskDelivery } from "../src/standing-history-task-delivery.js";
import type { PilotSend } from "../src/pilot-outbox.js";
import { EpochTurnNotAdmitted } from "../src/standing-epoch-session.js";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { openStandingHistoryChronicleCache } from "../src/standing-history-chronicle-cache.js";
import { openStandingHistoryParallelWorkStore } from "../src/standing-history-parallel-work-store.js";
import { createStandingHistoryParallelMaintenance, hashStandingHistoryParallelMaintenanceJournal } from "../src/standing-history-parallel-maintenance.js";


import type { StandingHistoryParallelStepGroup } from "../src/standing-history-analysis-step.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function page(before: SelfHistoryTaskCheckpoint, empty = false): SelfHistoryTaskPage {
  const id = (before.offsetId || 1000) - 1, date = before.lastDate - 1, ref = "m_" + id.toString(16).padStart(24, "0");
  const next = empty ? { ...before, pages: before.pages + 1, status: "empty-page" as const } :
    { ...before, pages: before.pages + 1, offsetId: id, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date, upperBoundMessageId: before.upperBoundMessageId ?? id };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: empty ? [] : [{ messageId: id, date, disposition: "included", messageRef: ref, authorId: "456" }], page: {
    schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
    messages: empty ? [] : [{ ref, authorRef: "a_" + "4".repeat(24), author: "user", displayName: "Synthetic speaker", date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Synthetic source " + id + " x".repeat(4500) }],
    cursor: null, hasMore: !empty, status: empty ? "empty-page" : "more", coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: empty, undatedEntries: 0, pages: next.pages },
    excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-maintenance-retained-"));
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts") };
  for (const dir of Object.values(directories)) await mkdir(dir);
  const passphrase = "synthetic-task-runner-passphrase", binding = { accountId: "123", peerId: "-100456" }, controller = new AbortController();
  let runner: StandingHistoryTaskRunner | undefined, queued = true, selection: StandingSelection | undefined;
  let onPoll: (() => Promise<void>) | undefined, onRead: ((signal: AbortSignal) => Promise<void>) | undefined;
  let onPrepare: (() => Promise<void>) | undefined;
  let nativeMode: "commit" | "unknown" | "wait" | "observed-without-commit" | "refused" = "commit";
  let nativeEpoch = "a".repeat(32);
  const due: boolean[] = [], counts = { prepare: 0, acquired: 0, turns: 0, released: 0, aborted: 0, closed: 0, read: 0, readClosed: 0 };
  const nativeEntered = deferred(), nativeStopped = deferred(), nativeFinished = deferred();
  const settlements: StandingHistoryAnalysisNativeBinding[] = [];
  const manager = await openStandingHistoryTaskManager({ directories, passphrase, binding, signal: controller.signal,
    async onCancelled({ taskRef }) { await runner?.revoke(taskRef); } });
  const ticket: StandingIdleHistoryTicket = { openTaskReply() { throw Error("runner must not send"); }, openHistoryTask({ checkpoint, signal }) {
    let stopped = false;
    return { async readTaskPage() { counts.read++; await onRead?.(signal); if (stopped || signal.aborted) throw Error("synthetic revoked"); assert.ok(checkpoint); return page(checkpoint); },
      async close() { if (!stopped) { stopped = true; counts.readClosed++; } } };
  } };
  const args: StandingHistoryTaskRunnerInput = { directories, passphrase, binding, signal: controller.signal, manager,
    adapter: { async pollWork(_signal, options): Promise<StandingPollWork> {
      due.push(options.backgroundDue); await onPoll?.();
      if (selection) { const value = selection; selection = undefined; return { kind: "selected", selection: value }; }
      if (queued && !options.backgroundDue) return { kind: "more" };
      return { kind: queued ? "background" : "idle", ticket };
    } },
    async verifyOwnerSettled(nativeBinding) { settlements.push(nativeBinding); return { schema: "standing-analysis-owner-settlement-v1", nativeBinding,
      resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" }; },
    connection: { async prepare() { counts.prepare++; await onPrepare?.(); return { restoration: true }; }, async acquireAnalysisAdmission(requestRef) {
      counts.acquired++; const nativeBinding = { epochId: nativeEpoch, requestRef, purpose: "history-analysis" as const };
      return { nativeBinding, async turnAnalysis(req, input, tools) {
        counts.turns++; nativeEntered.resolve();
        try {
          assert.equal(JSON.parse(input).schema, "neurobro-history-analysis-input-v1");
          if (nativeMode === "wait") { await nativeStopped.promise; throw Error("synthetic abort joined"); }
          if (nativeMode === "unknown") throw Error("synthetic outcome lost");
          if (nativeMode === "refused") throw new EpochTurnNotAdmitted("time");
          if (nativeMode === "observed-without-commit") return { kind: "analysis", scope: { epochId: nativeBinding.epochId, purpose: "history-analysis", requestRef: req,
            threadId: "synthetic-thread", turnId: "turn", turnNumber: 1, threadTurnNumber: 1 }, answer: "Commit refused", toolCalls: 0, toolRefusals: 0 };
          const call = { requestRef: req, callRef: "material", signal: controller.signal };
          const material = await tools.analysisTools[0]!.call({}, call) as EpochToolResult; assert.equal(material.success, true);
          tools.onToolResultSent({ requestRef: req, callRef: "material", name: "neurobro_analysis_material", result: material });
          const committed = await tools.analysisTools[2]!.call({ output: { summary: "Synthetic summary", claims: [] } }, { ...call, callRef: "commit" }) as EpochToolResult;
          assert.equal(committed.success, true);
          return { kind: "analysis", scope: { epochId: nativeBinding.epochId, purpose: "history-analysis", requestRef: req,
            threadId: "synthetic-thread", turnId: "turn", turnNumber: 1, threadTurnNumber: 1 }, answer: "Recorded", toolCalls: 2, toolRefusals: 0 };
        } finally { nativeFinished.resolve(); }
      }, async releaseAnalysis() { counts.released++; }, async abortAndJoin() { counts.aborted++; nativeStopped.resolve(); if (counts.turns) await nativeFinished.promise; }, async close() { counts.closed++; } };
    } }
  };
  // Preseeded lifecycle fixtures are finite source snapshots. Empty tasks still
  // exercise real read-more tickets; an explicit false keeps a frontier open.
  async function create(letter: string, pages = 0, analyzed = 0, terminal = true, source?: StandingHistoryTaskIntent["source"], objective = "Synthetic task " + letter) {
    const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + letter.repeat(48), accountId: binding.accountId, chatId: binding.peerId,
      requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "UTC", objective, ...(source ? { source } : {}) };
    const stores = await openStores(intent, "create");
    try {
      for (let i = 0; i < pages; i++) {
        const before = (await stores.source.status()).readProgress.checkpoint;
        await stores.source.appendPage({ expectedCheckpoint: before, result: page(before, terminal && i === pages - 1) });
        if (i < analyzed) {
          const storedPage = (await stores.source.readPage(i + 1))!;
          const projected = projectStandingHistorySource({ intent, referenceKey: stores.analysis.referenceKey(), storedPage, maxBytes: 49152 });
          await stores.analysis.appendLeaf({ expectedHead: (await stores.analysis.status()).headHash,
            inputs: [{ pageIndex: i + 1, maxBytes: 49152, materialRef: projected.materialRef }], output: { summary: "Existing note " + i, claims: [] } });
        }
      }
    } finally { await stores.close(); }
    return intent;
  }
  async function openStores(intent: StandingHistoryTaskIntent, mode: "open" | "create" = "open") {
    const shared = { intent, passphrase, mode };
    const source = await openStandingHistoryTaskStore({ ...shared, directory: directories.pages });
    const control = await openStandingHistoryTaskControlStore({ ...shared, directory: directories.control });
    const analysis = await openStandingHistoryAnalysisStore({ ...shared, directory: directories.analysis, readSourcePage: i => source.readPage(i) });
    const attempts = await openStandingHistoryAnalysisAttemptStore({ ...shared, directory: directories.attempts, analysis });
    return { source, control, analysis, attempts, async close() { await attempts.close(); await analysis.close(); await source.close(); await control.close(); } };
  }
  async function start(input = args) { runner = await openStandingHistoryTaskRunner(input); return runner; }
  t.after(async () => { await runner?.close(); await manager.close(); assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-maintenance-retained-"))); await rm(root, { recursive: true, force: true }); });
  return { args, counts, due, settlements, create, openStores, start, manager, controller, nativeEntered,
    epoch(value: string) { nativeEpoch = value; },
    idle() { queued = false; }, select(value: StandingSelection) { selection = value; }, onPoll(value: typeof onPoll) { onPoll = value; }, onRead(value: typeof onRead) { onRead = value; }, onPrepare(value: typeof onPrepare) { onPrepare = value; }, mode(value: typeof nativeMode) { nativeMode = value; } };
}

async function files(directory: string) {
  return Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), "utf8")]));
}
async function pollUntil(runner: StandingHistoryTaskRunner, predicate: (work: StandingHistoryTaskWork) => boolean) {
  let last: StandingHistoryTaskWork | undefined;
  for (let i = 0; i < 3000; i++) { const result = await runner.poll(); last = result; if (predicate(result)) return result; }
  assert.fail("bounded synthetic runner did not reach the expected durable work: " + JSON.stringify(last));
}

test("forty retained leaf and merge nodes survive authorized maintenance, large runner progress, and cold restart", async t => {
  const f = await fixture(t); f.idle(); f.onPoll(() => new Promise(resolve => setTimeout(resolve, 10)));
  const observedSource = { kind: "observed-source", sourceRef: "community", workspaceId: "synthetic-team-v1", peerId: "-100888" } as const;
  const intent = await f.create("a", 24, 21, true, observedSource);
  const parent = resolve(f.args.directories.pages, ".."), originalDirectory = join(parent, "parallel"), maintenanceDirectory = join(parent, "parallel-maintenance");
  await mkdir(originalDirectory); await mkdir(maintenanceDirectory);
  const stores = await f.openStores(intent);
  try {
    // Twenty-one saved leaves plus nineteen valid, disjoint chained merges
    // reproduce the retained 24-page / 40-node shape. Page 21 stays a second
    // frontier root; pages 22-24 remain uncovered (24 is the terminal marker).
    let merged = (await stores.analysis.readNodeAt(1))!.nodeRef;
    for (let i = 2; i <= 20; i++) {
      const node = await stores.analysis.appendMerge({ expectedHead: (await stores.analysis.status()).headHash,
        children: [merged, (await stores.analysis.readNodeAt(i))!.nodeRef], output: { summary: "Previously merged saved analysis through page " + i, claims: [] } });
      merged = node.nodeRef;
    }
    assert.equal((await stores.analysis.status()).analysisNodes, 40);
    const sourceHead = (await stores.source.status()).readProgress.chainHash, expectedHead = (await stores.analysis.status()).headHash;
    const works = [];
    for (const pageIndex of [22, 23]) {
      const material = projectStandingHistorySource({ intent, referenceKey: stores.analysis.referenceKey(), storedPage: (await stores.source.readPage(pageIndex))!, maxBytes: 49152 });
      const inputs = [{ pageIndex, maxBytes: 49152, materialRef: material.materialRef }];
      works.push({ kind: "leaf" as const, inputs, modelInputHash: prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead,
        inputs: inputs as [typeof inputs[number]], material }).modelInputHash,
        nativeBinding: { epochId: "b".repeat(32), requestRef: "old-unknown-" + pageIndex, purpose: "history-analysis" as const } });
    }
    const original = await openStandingHistoryParallelWorkStore({ directory: originalDirectory, intent, passphrase: f.args.passphrase, mode: "create", source: stores.source, analysis: stores.analysis });
    try { await original.reserveWave({ sourceHead, expectedHead, works }); } finally { await original.close(); }
    await createStandingHistoryParallelMaintenance({ directory: maintenanceDirectory, originalJournalDirectory: originalDirectory,
      directories: { pages: f.args.directories.pages, control: f.args.directories.control, analysis: f.args.directories.analysis },
      intent, passphrase: f.args.passphrase, signal: f.controller.signal,
      authorization: { generationRef: "hmaint_" + "9".repeat(48), requestHash: "1".repeat(64), sourceHead, analysisHead: expectedHead,
        controlHead: (await stores.control.status()).headHash,
        originalJournalHash: await hashStandingHistoryParallelMaintenanceJournal({ originalJournalDirectory: originalDirectory, intent, signal: f.controller.signal }) },
      async verifyOwnerSettled(nativeBinding) {
        assert.equal(nativeBinding.epochId, "b".repeat(32)); assert.match(nativeBinding.requestRef, /^old-unknown-2[23]$/);
        return { nativeBinding, windowsBeforeAbsent: true, guestAbsent: true, windowsAfterAbsent: true, exclusiveCustody: true, receiptHash: "2".repeat(64) };
      } });
  } finally { await stores.close(); }
  const originalBytes = await files(join(originalDirectory, intent.taskId)), baseNodes = await files(join(f.args.directories.analysis, intent.taskId));
  const sourceBytes = await files(join(f.args.directories.pages, intent.taskId));
  const cache = await openStandingHistoryChronicleCache({ directory: join(parent, "chronicle"), passphrase: f.args.passphrase }); t.after(() => cache.close());
  const released = new Set<string>(), workRefs = new Map<string, string>(), requests: string[] = [];
  let groups = 0, groupCloses = 0, turns = 0;
  const args: StandingHistoryTaskRunnerInput = { ...f.args, observedSource, concurrentAnalysis: true,
    parallel: { directory: originalDirectory, maintenanceDirectory, maxLeaves: 2 },
    chronicle: { cache, producer: { model: "synthetic", promptVersion: "p", projectionVersion: "s", outputVersion: "o" }, reuseDirectory: join(parent, "reuse") },
    connection: { ...f.args.connection, concurrentAnalysis: true,
      async acquireAnalysisAdmission(ref, previous, options) { assert.ok(!ref.startsWith("old-unknown")); requests.push(ref); return f.args.connection.acquireAnalysisAdmission(ref, previous, options); },
      async acquireParallelAnalysisAdmissions(refs): Promise<StandingHistoryParallelStepGroup> {
        groups++; assert.ok(refs.length >= 1 && refs.length <= 2);
        const leases = refs.map((requestRef, i) => {
          requests.push(requestRef); assert.ok(!requestRef.startsWith("old-unknown"));
          const nativeBinding = { epochId: "d".repeat(32), requestRef, purpose: "history-analysis" as const };
          return { workerId: "analysis-" + i, nativeBinding,
            async turnAnalysis(req: string, body: string, tools: Parameters<StandingHistoryParallelStepGroup["leases"][number]["turnAnalysis"]>[2]) {
              turns++; assert.equal(req, requestRef); assert.equal(JSON.parse(body).kind, "leaf");
              workRefs.set(req, tools.work.workRef); assert.equal(tools.work.taskRef, intent.taskId);
              const call = { requestRef: req, callRef: "material", signal: f.controller.signal };
              const material = await tools.analysisTools[0]!.call({}, call) as EpochToolResult; assert.equal(material.success, true);
              tools.onToolResultSent({ requestRef: req, callRef: "material", name: "neurobro_analysis_material", result: material });
              const commit = await tools.analysisTools[2]!.call({ output: { summary: "New uncovered source " + i, claims: [] } }, { ...call, callRef: "commit" }) as EpochToolResult;
              assert.equal(commit.success, true); tools.onToolResultSent({ requestRef: req, callRef: "commit", name: "neurobro_analysis_commit", result: commit });
              return { kind: "analysis" as const, workerId: "analysis-" + i,
                scope: { epochId: nativeBinding.epochId, requestRef: req, purpose: "history-analysis" as const, threadId: "synthetic-thread-" + i,
                  turnId: "synthetic-turn-" + i, turnNumber: 1, threadTurnNumber: 1 }, answer: "Saved", toolCalls: 2, toolRefusals: 0 };
            }, async releaseAnalysis(ref: string) { assert.equal(ref, requestRef); released.add(ref); } };
        });
        return { leases, async abortAndJoin() { assert.fail("successful synthetic work must settle normally"); }, async close() { groupCloses++; } };
      },
      async verifyAnalysisWorkReleased(nativeBinding, workRef) {
        assert.equal(released.has(nativeBinding.requestRef), true); assert.equal(workRefs.get(nativeBinding.requestRef), workRef);
        return { schema: "standing-analysis-work-release-v1", nativeBinding, workRef, releaseAcknowledged: true, callbacksJoined: true };
      } } };
  const runner = await f.start(args);
  const hasDurableNode = (v: StandingHistoryTaskWork) => v.kind === "background" && v.outcome.kind === "analysis" &&
    (v.outcome.result.kind === "parallel-wave" || v.outcome.result.kind === "attempt") && !!v.outcome.result.node;
  const first = await pollUntil(runner, hasDurableNode);
  assert.ok(first.kind === "background" && first.outcome.kind === "analysis" && (first.outcome.result.kind === "parallel-wave" || first.outcome.result.kind === "attempt"));
  assert.equal(first.outcome.result.release, "acknowledged");
  if (first.outcome.result.kind === "parallel-wave") assert.equal(first.outcome.result.recovered, false);
  const firstTurns = turns + f.counts.turns; assert.ok(firstTurns >= 1); assert.equal(groupCloses, groups);
  await runner.close();
  const saved = await f.openStores(intent);
  let firstNodeCount = 0;
  try {
    firstNodeCount = (await saved.analysis.status()).analysisNodes; assert.ok(firstNodeCount > 40);
    for (let i = 41; i <= firstNodeCount; i++) {
      const node = (await saved.analysis.readNodeAt(i))!; assert.ok(node.kind === "leaf" || node.kind === "merge");
      if (node.kind === "leaf") assert.ok(node.coverage.every(c => c.pageIndex > 21), "new leaves must not repeat retained source coverage");
    }
  } finally { await saved.close(); }
  const afterFirst = await files(join(f.args.directories.analysis, intent.taskId));
  assert.deepEqual(afterFirst.slice(0, baseNodes.length), baseNodes);
  assert.deepEqual(await files(join(originalDirectory, intent.taskId)), originalBytes);
  // New cold runner must use the persisted selector, retain completed successor
  // nodes, and continue uncovered material with a fresh request, not replay them.
  f.epoch("e".repeat(32)); const cold = await f.start(args);
  await pollUntil(cold, hasDurableNode);
  await cold.close();
  const latest = await f.openStores(intent);
  try { assert.ok((await latest.analysis.status()).analysisNodes > firstNodeCount); } finally { await latest.close(); }
  assert.ok(turns + f.counts.turns > firstTurns); assert.equal(new Set(requests).size, requests.length); assert.equal(groupCloses, groups);
  assert.deepEqual((await files(join(f.args.directories.analysis, intent.taskId))).slice(0, afterFirst.length), afterFirst);
  assert.deepEqual(await files(join(originalDirectory, intent.taskId)), originalBytes);
  assert.deepEqual(await files(join(f.args.directories.pages, intent.taskId)), sourceBytes);
  assert.equal(f.counts.read, 0, "retained source snapshot was not fetched again");
});
