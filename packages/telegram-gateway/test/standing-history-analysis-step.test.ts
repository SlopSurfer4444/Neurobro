import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisAttemptPlan, type StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { openStandingHistoryAnalysisStep, type StandingHistoryAnalysisOwnerSettlement, type StandingHistoryAnalysisStepConnection, type StandingHistoryParallelStepGroup } from "../src/standing-history-analysis-step.js";
import { openStandingHistoryParallelWorkStore } from "../src/standing-history-parallel-work-store.js";
import { createStandingHistoryParallelPlanner } from "../src/standing-history-parallel-planner.js";
import type { CompletedAnalysisTurn } from "../src/standing-scoped-epoch-session.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { requireStandingChronicleNote } from "../src/standing-chronicle-note.js";
import { EpochTurnNotAdmitted } from "../src/standing-epoch-session.js";
import type { StandingIdleHistoryTicket } from "../src/standing-conversation-adapter.js";
import { openStandingHistoryChronicleCache, type StandingHistoryChronicleSelection } from "../src/standing-history-chronicle-cache.js";
import { openStandingHistoryChronicleReuseStore } from "../src/standing-history-chronicle-reuse-store.js";
import { openStandingHistoryPeriodChronicleStore } from "../src/standing-history-period-chronicle-store.js";

function parallelConnection(f: Awaited<ReturnType<typeof fixture>>, mode: "observed" | "unknown-output" | "missing-output" | "unknown-empty" | "blocked" = "observed", usePeriods = false, epochId = "d".repeat(32), expectedWorkers = 2) {
  const serial = connection(f), entered = deferred(), gate = deferred(), turnFinished = [deferred(), deferred()];
  const counts = { groups: 0, turns: 0, releases: 0, closes: 0, aborts: 0, active: 0, maximum: 0, neutralReads: 0, advisoryReads: 0 }, bindings = new Map<string, string>(), released = new Set<string>(), started = new Set<number>();
  const value: StandingHistoryAnalysisStepConnection = { ...serial.value,
    async acquireAnalysisAdmission(requestRef, previousBinding) {
      const lease = await serial.value.acquireAnalysisAdmission(requestRef, previousBinding);
      return { ...lease, async turnAnalysis(req, body, callbacks) {
        assert.equal(callbacks.work?.taskRef, f.binding.intent.taskId); assert.match(callbacks.work?.workRef ?? "", /^hattempt_/); assert.equal(callbacks.work?.planRef, callbacks.work?.workRef);
        return lease.turnAnalysis(req, body, callbacks);
      } };
    },
    async acquireParallelAnalysisAdmissions(requestRefs, previous, options): Promise<StandingHistoryParallelStepGroup> {
      counts.groups++; assert.equal(requestRefs.length, expectedWorkers);
      if (expectedWorkers === 1) { assert.ok(previous); assert.deepEqual(options, { requireNewEpoch: true }); }
      const leases = requestRefs.map((requestRef, i) => ({ workerId: "analysis-" + i, nativeBinding: { epochId, requestRef, purpose: "history-analysis" as const },
        async turnAnalysis(req: string, body: string, tools: Parameters<StandingHistoryParallelStepGroup["leases"][number]["turnAnalysis"]>[2]) {
          counts.turns++; counts.active++; counts.maximum = Math.max(counts.maximum, counts.active); started.add(i);
          if (counts.turns === expectedWorkers) entered.resolve();
          try {
            assert.equal(req, requestRef); assert.equal(JSON.parse(body).kind, "leaf"); assert.equal(tools.work.taskRef, f.binding.intent.taskId);
            if (expectedWorkers === 1) assert.match(JSON.parse(body).continuation, /previous settled analysis attempt produced no accepted node/);
            assert.match(tools.work.planRef, /^hwave_/); assert.match(tools.work.workRef, /^hwork_/); bindings.set(req, tools.work.workRef);
            await entered.promise;
            if (mode === "blocked") { await gate.promise; throw Error("synthetic group interrupted"); }
            if (!((mode === "missing-output" || mode === "unknown-empty") && i === expectedWorkers - 1)) {
              const material = await tools.analysisTools[0]!.call({}, { requestRef: req, callRef: "material", signal: f.controller.signal }) as EpochToolResult; assert.equal(material.success, true);
              tools.onToolResultSent({ requestRef: req, callRef: "material", name: "neurobro_analysis_material", result: material });
              let neutralOutput;
              if (usePeriods) {
                const advertised = JSON.parse(body).periodChronicle; assert.match(advertised.contextHash, /^[a-f0-9]{64}$/);
                const purpose = advertised.neutralPeriodNotesAvailable ? "neutral-period-notes" : "period-advisory";
                const period = await tools.analysisTools[0]!.call({ purpose }, { requestRef: req, callRef: "period", signal: f.controller.signal }) as EpochToolResult; assert.equal(period.success, true);
                tools.onToolResultSent({ requestRef: req, callRef: "period", name: "neurobro_analysis_material", result: period });
                const packet = JSON.parse(period.contentItems[0].text);
                if (purpose === "neutral-period-notes") { counts.neutralReads++; neutralOutput = { inputHash: packet.inputHash, output: { summary: "Neutral period notes " + i, claims: [] } }; }
                else { counts.advisoryReads++; assert.equal(packet.currentSourceRequired, true); assert.equal(packet.queryCoverage, "not-established"); assert.match(packet.summary, /^Neutral period notes /); }
              }
              const prepared = await tools.analysisTools[2]!.call({ output: { summary: "Parallel leaf " + i, claims: [] }, ...(neutralOutput ? { neutralOutput } : {}) }, { requestRef: req, callRef: "commit", signal: f.controller.signal }) as EpochToolResult;
              assert.equal(prepared.success, true); assert.equal(JSON.parse(prepared.contentItems[0].text).projectionPending, true);
              tools.onToolResultSent({ requestRef: req, callRef: "commit", name: "neurobro_analysis_commit", result: prepared });
            }
            if ((mode === "unknown-output" || mode === "unknown-empty") && i === expectedWorkers - 1) throw Error("synthetic result lost");
            return { kind: "analysis" as const, workerId: "analysis-" + i, scope: { epochId, purpose: "history-analysis" as const, requestRef: req,
              threadId: "parallel-thread-" + i, turnId: "parallel-turn-" + i, turnNumber: 1, threadTurnNumber: 1 }, answer: "Staged", toolCalls: 2, toolRefusals: 0 };
          } finally { counts.active--; turnFinished[i]!.resolve(); }
        },
        async releaseAnalysis(req: string) { counts.releases++; released.add(req); }
      }));
      return { leases, async abortAndJoin() { counts.aborts++; gate.resolve(); await Promise.all([...started].map(i => turnFinished[i]!.promise)); }, async close() { counts.closes++; assert.equal(counts.active, 0); } };
    },
    async verifyAnalysisWorkReleased(nativeBinding, workRef) {
      assert.equal(counts.closes, 1); assert.equal(counts.aborts, 0); assert.equal(released.has(nativeBinding.requestRef), true); assert.equal(bindings.get(nativeBinding.requestRef), workRef);
      return { schema: "standing-analysis-work-release-v1", nativeBinding, workRef, releaseAcknowledged: true, callbacksJoined: true };
    }
  };
  return { value, counts, serial, entered };
}
async function parallelNext(step: Step, f: Awaited<ReturnType<typeof fixture>>, connection: StandingHistoryAnalysisStepConnection, requestRef = "parallel-wave-request") {
  for (let i = 0; i < 80; i++) { const result = await step.next({ requestRef, connection, signal: f.controller.signal }); if (result.kind !== "scan-more") return result; }
  assert.fail("parallel fixture exhausted scan budget");
}

test("parallel opt-in reserves a real leaf wave, overlaps native leases, projects serially, then uses a legacy merge attempt", async t => {
  const f = await fixture(t, 16), native = parallelConnection(f), parallel = { directory: join(f.root, "parallel"), maxLeaves: 2 };
  const step = await openStandingHistoryAnalysisStep({ ...f.args, parallel, retainWorkingState: true }); t.after(() => step.close());
  const result = await parallelNext(step, f, native.value); assert.equal(result.kind, "parallel-wave"); if (result.kind !== "parallel-wave") assert.fail();
  assert.equal(result.node?.index, 2); assert.deepEqual(result.modelOutcomes, ["observed", "observed"]); assert.equal(result.release, "acknowledged"); assert.equal(result.recovered, false);
  assert.equal(native.counts.maximum, 2); assert.equal(native.counts.closes, 1); assert.equal(native.counts.aborts, 0); assert.equal(f.settlements.length, 0);
  const actual = await readback(f); assert.equal(actual.analysis.analysisNodes, 2); assert.equal(actual.attempts.attempts, 0);
  await step.close();
  const fresh = await stores(f);
  try { const before = (await fresh.source.status()).readProgress.checkpoint, empty = page(before), after = { ...before, pages: before.pages + 1, status: "empty-page" as const };
    await fresh.source.appendPage({ expectedCheckpoint: before, result: { ...empty, sources: [], nextCheckpoint: after, page: { ...empty.page, messages: [], hasMore: false, status: "empty-page", coverage: { ...empty.page.coverage, oldestExaminedDate: before.oldestDate, newestExaminedDate: before.newestDate, traversalComplete: true, pages: after.pages } } } });
  } finally { await fresh.close(); }
  const resumed = await openStandingHistoryAnalysisStep({ ...f.args, parallel, retainWorkingState: true }); t.after(() => resumed.close());
  // Empty terminal page is itself source coverage and may produce a serial leaf
  // before the native final merge. Both keep real v1 attempt identity.
  let last = await parallelNext(resumed, f, native.value, "terminal-leaf"); assert.equal(last.kind, "attempt");
  last = await parallelNext(resumed, f, native.value, "native-final-merge"); assert.equal(last.kind, "attempt");
  const saved = await readback(f); assert.equal(saved.attempts.attempts, 2); assert.equal(saved.attempts.last?.node?.index, saved.analysis.analysisNodes);
});

test("saved parallel outputs with unknown result settle the owner and remain separate from legacy attempts", async t => {
  const f = await fixture(t, 16), native = parallelConnection(f, "unknown-output"), step = await openStandingHistoryAnalysisStep({ ...f.args, parallel: { directory: join(f.root, "parallel"), maxLeaves: 2 } }); t.after(() => step.close());
  const result = await parallelNext(step, f, native.value); assert.equal(result.kind, "parallel-wave"); if (result.kind !== "parallel-wave") assert.fail();
  assert.ok(result.modelOutcomes.includes("unknown")); assert.equal(result.node?.index, 2); assert.equal(result.release, "not-acknowledged"); assert.equal(native.counts.aborts, 1); assert.ok(f.settlements.length >= 2);
  assert.equal((await readback(f)).attempts.attempts, 0);
});

test("unknown missing parallel output requires a fresh owner and preserves retained source read fencing", async t => {
  const f = await fixture(t, 16), native = parallelConnection(f, "unknown-empty"), parallel = { directory: join(f.root, "parallel"), maxLeaves: 2 };
  const step = await openStandingHistoryAnalysisStep({ ...f.args, parallel, retainWorkingState: true });
  const result = await parallelNext(step, f, native.value); assert.equal(result.kind, "parallel-wave"); if (result.kind !== "parallel-wave") assert.fail(); assert.equal(result.node, undefined); await step.close();
  const reopened = await openStandingHistoryAnalysisStep({ ...f.args, parallel, retainWorkingState: true }); t.after(() => reopened.close());
  await assert.rejects(parallelNext(reopened, f, native.value, "do-not-replay")); assert.equal(native.counts.turns, 2); assert.equal(native.serial.counts.turns, 0);
  await assert.rejects(reopened.readSourcePage({ ticket: { openHistoryTask() { throw Error("must not acquire source"); }, openTaskReply() { throw Error("must not acquire reply"); } }, signal: f.controller.signal }), /CONSUMED/);
  assert.equal((await readback(f)).attempts.attempts, 0);
});

for (const mode of ["missing-output", "unknown-empty"] as const) test(`${mode} parallel work continues only its ordinal after restart and preserves saved sibling and original journal`, async t => {
  const f = await fixture(t, 16), native = parallelConnection(f, mode), parallel = { directory: join(f.root, "parallel"), maxLeaves: 2 };
  const step = await openStandingHistoryAnalysisStep({ ...f.args, parallel });
  const first = await parallelNext(step, f, native.value); assert.equal(first.kind, "parallel-wave"); if (first.kind !== "parallel-wave") assert.fail();
  await step.close(); const slot = join(parallel.directory, f.binding.intent.taskId);
  const original = await Promise.all((await readdir(slot)).map(async name => [name, await readFile(join(slot, name), "utf8")] as const));
  const resumed = await openStandingHistoryAnalysisStep({ ...f.args, parallel }); t.after(() => resumed.close());
  const fresh = parallelConnection(f, "observed", false, "e".repeat(32), 1);
  const result = await parallelNext(resumed, f, fresh.value, "fresh-single-work");
  assert.equal(result.kind, "parallel-wave"); if (result.kind !== "parallel-wave") assert.fail();
  assert.equal(result.waveRef, first.waveRef); assert.equal(result.workRefs[0], first.workRefs[0]); assert.notEqual(result.workRefs[1], first.workRefs[1]);
  assert.equal(result.node?.index, 2); assert.equal(fresh.counts.turns, 1); assert.equal(fresh.serial.counts.turns, 0);
  assert.equal((await readback(f)).attempts.attempts, 0);
  for (const [name, bytes] of original) assert.equal(await readFile(join(slot, name), "utf8"), bytes);
});

for (const projectedPrefix of [false, true]) test(`known empty parallel retry retains ${projectedPrefix ? "projected sibling" : "prepared sibling with missing receipt"}`, async t => {
  const f = await fixture(t, 16), parallel = { directory: join(f.root, "parallel"), maxLeaves: 2 }; await mkdir(parallel.directory);
  const s = await stores(f), planner = createStandingHistoryParallelPlanner({ intent: f.binding.intent, source: s.source, analysis: s.analysis, maxLeaves: 2 });
  let oldRefs: readonly string[] = [];
  try {
    let plan = await planner.next(); for (let i = 0; plan.kind === "scan-more" && i < 80; i++) plan = await planner.next(); if (plan.kind !== "leaf-wave") assert.fail();
    const work = await openStandingHistoryParallelWorkStore({ ...f.binding, directory: parallel.directory, source: s.source, analysis: s.analysis, mode: "create" });
    try {
      const wave = await work.reserveWave({ sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, works: plan.plans.map((leaf, i) => ({ kind: "leaf", inputs: leaf.inputs,
        modelInputHash: prepareStandingHistoryAnalysisMaterial(leaf).modelInputHash, nativeBinding: { epochId: "b".repeat(32), requestRef: "mixed-cold-" + i, purpose: "history-analysis" } })) });
      oldRefs = wave.workRefs; await work.prepare({ workRef: oldRefs[0]!, output: { summary: "Keep original prepared sibling", claims: [] }, shownSupports: [] });
      if (projectedPrefix) { await work.recordModelOutcome({ workRef: oldRefs[0]!, outcome: "observed" }); await work.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: async binding => proof(binding) }); }
      await work.recordModelOutcome({ workRef: oldRefs[1]!, outcome: "observed" });
    } finally { await work.close(); }
  } finally { await planner.close(); await s.close(); }
  const step = await openStandingHistoryAnalysisStep({ ...f.args, parallel }); t.after(() => step.close());
  const native = parallelConnection(f, "observed", false, "e".repeat(32), 1), result = await parallelNext(step, f, native.value, "mixed-fresh");
  assert.equal(result.kind, "parallel-wave"); if (result.kind !== "parallel-wave") assert.fail();
  assert.equal(result.workRefs[0], oldRefs[0]); assert.notEqual(result.workRefs[1], oldRefs[1]); assert.equal(result.node?.index, 2);
  assert.deepEqual(result.modelOutcomes, [projectedPrefix ? "observed" : "unknown", "observed"]); assert.equal(native.counts.turns, 1);
});

test("cold complete prepared parallel wave recovers without acquiring any native lease", async t => {
  const f = await fixture(t, 16), parallel = { directory: join(f.root, "parallel"), maxLeaves: 2 }; await mkdir(parallel.directory);
  const s = await stores(f), planner = createStandingHistoryParallelPlanner({ intent: f.binding.intent, source: s.source, analysis: s.analysis, maxLeaves: 2 });
  let waveRef = "";
  try {
    let plan = await planner.next(); for (let i = 0; plan.kind === "scan-more" && i < 80; i++) plan = await planner.next(); if (plan.kind !== "leaf-wave") assert.fail();
    const work = await openStandingHistoryParallelWorkStore({ ...f.binding, directory: parallel.directory, source: s.source, analysis: s.analysis, mode: "create" });
    try {
      const wave = await work.reserveWave({ sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, works: plan.plans.map((leaf, i) => ({ kind: "leaf", inputs: leaf.inputs, modelInputHash: prepareStandingHistoryAnalysisMaterial(leaf).modelInputHash,
        nativeBinding: { epochId: "b".repeat(32), requestRef: "cold-parallel-" + i, purpose: "history-analysis" } })) }); waveRef = wave.waveRef;
      for (const workRef of wave.workRefs) await work.prepare({ workRef, output: { summary: "Cold staged output", claims: [] }, shownSupports: [] });
      // Missing native outcomes remain missing until actual old-owner settlement.
    } finally { await work.close(); }
  } finally { await planner.close(); await s.close(); }
  const native = parallelConnection(f), step = await openStandingHistoryAnalysisStep({ ...f.args, parallel }); t.after(() => step.close());
  const result = await parallelNext(step, f, native.value); assert.equal(result.kind, "parallel-wave"); if (result.kind !== "parallel-wave") assert.fail();
  assert.equal(result.waveRef, waveRef); assert.equal(result.recovered, true); assert.deepEqual(result.modelOutcomes, ["unknown", "unknown"]); assert.equal(result.node?.index, 2);
  assert.equal(native.counts.groups, 0); assert.equal(native.serial.counts.acquired, 0); assert.equal((await readback(f)).attempts.attempts, 0);
});

test("closing an active parallel wave joins both native workers and consumes their reservations", async t => {
  const f = await fixture(t, 16), native = parallelConnection(f, "blocked"), step = await openStandingHistoryAnalysisStep({ ...f.args, parallel: { directory: join(f.root, "parallel"), maxLeaves: 2 } });
  const running = parallelNext(step, f, native.value); await native.entered.promise; await step.close(); await running.catch(() => {});
  assert.equal(native.counts.active, 0); assert.equal(native.counts.aborts, 1); assert.equal(native.counts.closes, 1);
  const actual = await readback(f); assert.equal(actual.analysis.analysisNodes, 0); assert.equal(actual.attempts.attempts, 0);
});

test("parallel period notes capture after exact warm releases and advise a different query without relabeling its output", async t => {
  const a = await fixture(t, 16, undefined, "a"), b = await fixture(t, 16, undefined, "b", "Different question about the same period");
  const cache = await openStandingHistoryChronicleCache({ directory: join(a.root, "query-cache"), passphrase: a.binding.passphrase }); t.after(() => cache.close());
  const periodStore = await openStandingHistoryPeriodChronicleStore({ directory: join(a.root, "period-cache"), passphrase: a.binding.passphrase }); t.after(() => periodStore.close());
  let captures = 0;
  for (const [index, f] of [a, b].entries()) {
    const native = parallelConnection(f, "observed", true);
    const counted = { ...periodStore, async remember(value: Parameters<typeof periodStore.remember>[0]) {
      captures++; assert.equal(native.counts.closes, 1); assert.equal(native.counts.releases, 2); assert.equal(native.counts.aborts, 0);
      assert.equal("resourcesSettled" in value.generation, false); assert.ok("workRelease" in value.generation); assert.equal(value.output.summary.startsWith("Neutral period notes "), true);
      return periodStore.remember(value);
    } };
    const step = await openStandingHistoryAnalysisStep({ ...f.args, parallel: { directory: join(f.root, "parallel"), maxLeaves: 2 },
      chronicle: { cache, producer: chronicleProducer, reuseDirectory: join(f.root, "reuse"), periods: { store: counted, workspaceId: "synthetic-workspace" } } });
    try {
      const result = await parallelNext(step, f, native.value); assert.equal(result.kind, "parallel-wave"); if (result.kind !== "parallel-wave") assert.fail(); assert.equal(result.node?.index, 2);
      assert.equal(native.counts.turns, 2); assert.equal(native.counts.neutralReads, index === 0 ? 2 : 0); assert.equal(native.counts.advisoryReads, index === 1 ? 2 : 0);
      assert.equal((await readback(f)).node!.output.summary, "Parallel leaf 0"); assert.equal(f.settlements.length, 0);
    } finally { await step.close(); }
  }
  assert.equal(captures, 2);
});

for (const change of ["producer", "cache", "remove", "add"] as const)
  test(`cold UNKNOWN successor explicitly refreshes optional period context after ${change} drift while preserving primary plan and sibling`, async t => {
    const f = await fixture(t, 16), parallel = { directory: join(f.root, "parallel"), maxLeaves: 2 };
    const cache = await openStandingHistoryChronicleCache({ directory: join(f.root, "cache"), passphrase: f.binding.passphrase }); t.after(() => cache.close());
    const periodStore = await openStandingHistoryPeriodChronicleStore({ directory: join(f.root, "period-cache"), passphrase: f.binding.passphrase }); t.after(() => periodStore.close());
    const captured: Parameters<typeof periodStore.remember>[0]["request"][] = [];
    const periods = { store: { ...periodStore, async lookup(request: Parameters<typeof periodStore.lookup>[0]) { captured.push(request); return periodStore.lookup(request); } }, workspaceId: "synthetic-workspace" };
    const oldChronicle = { cache, producer: chronicleProducer, reuseDirectory: join(f.root, "reuse"), ...(change === "add" ? {} : { periods }) };
    const first = await openStandingHistoryAnalysisStep({ ...f.args, parallel, chronicle: oldChronicle });
    const original = await parallelNext(first, f, parallelConnection(f, "unknown-empty", change !== "add").value, "original-context");
    assert.equal(original.kind, "parallel-wave"); if (original.kind !== "parallel-wave") assert.fail(); await first.close();
    const slot = join(parallel.directory, f.binding.intent.taskId), encrypted = await Promise.all((await readdir(slot)).map(async name => [name, await readFile(join(slot, name), "utf8")] as const));
    const readWorks = async (refs: readonly string[]) => {
      const s = await stores(f), ledger = await openStandingHistoryParallelWorkStore({ ...f.binding, directory: parallel.directory, source: s.source, analysis: s.analysis, mode: "open" });
      try { return await Promise.all(refs.map(ref => ledger.readWork(ref))); } finally { await ledger.close(); await s.close(); }
    };
    const old = await readWorks(original.workRefs); assert.equal(old[1]!.modelOutcome, "unknown"); assert.ok(old[0]!.output); assert.equal(old[1]!.output, undefined);
    if (change === "cache") {
      const request = captured[1]!; assert.ok(request);
      assert.ok(await periodStore.remember({ request, output: { summary: "Neutral period notes saved by another settled analysis", claims: [] },
        generation: { purpose: "neutral-period-notes", inputHash: request.inputHash, requestRef: "other-neutral-generation", epochId: "9".repeat(32), modelOutcome: "observed", resourcesSettled: true }, capturedAt: 1 }));
    }
    const freshChronicle = { cache, producer: change === "producer" ? { ...chronicleProducer, promptVersion: "new-prompt-version" } : chronicleProducer,
      reuseDirectory: join(f.root, "reuse"), ...(change === "remove" ? {} : { periods }) };
    const nextStep = await openStandingHistoryAnalysisStep({ ...f.args, parallel, chronicle: freshChronicle }); t.after(() => nextStep.close());
    const native = parallelConnection(f, "observed", change !== "remove", "e".repeat(32), 1);
    const result = await parallelNext(nextStep, f, native.value, "new-context-successor");
    assert.equal(result.kind, "parallel-wave"); if (result.kind !== "parallel-wave") assert.fail(); assert.equal(result.node?.index, 2); assert.equal(native.counts.turns, 1);
    await nextStep.close();
    const saved = await readWorks([original.workRefs[0]!, original.workRefs[1]!, result.workRefs[1]!]);
    assert.deepEqual(saved[0]!.plan, old[0]!.plan); assert.deepEqual(saved[0]!.output, old[0]!.output);
    assert.deepEqual(saved[1], old[1]); assert.notEqual(saved[2]!.plan.contextHash, old[1]!.plan.contextHash);
    const { nativeBinding: oldBinding, contextHash: oldContext, ...oldPrimary } = old[1]!.plan;
    const { nativeBinding: newBinding, contextHash: newContext, ...newPrimary } = saved[2]!.plan;
    assert.deepEqual(newPrimary, oldPrimary); assert.notEqual(newBinding.epochId, oldBinding.epochId); assert.notEqual(newBinding.requestRef, oldBinding.requestRef);
    if (change === "remove") assert.equal(newContext, undefined); if (change === "add") assert.equal(oldContext, undefined);
    if (change === "cache") assert.equal(native.counts.advisoryReads, 1);
    for (const [name, bytes] of encrypted) assert.equal(await readFile(join(slot, name), "utf8"), bytes);
  });

type Step = Awaited<ReturnType<typeof openStandingHistoryAnalysisStep>>;

const chronicleProducer = { model: "synthetic-model", promptVersion: "synthetic-prompt-1", projectionVersion: "source-v1", outputVersion: "analysis-v1" };
async function chroniclePair(t: TestContext, pages = 1) {
  const a = await fixture(t, pages, undefined, "a"), b = await fixture(t, pages, undefined, "b");
  const cache = await openStandingHistoryChronicleCache({ directory: join(a.root, "chronicle"), passphrase: a.binding.passphrase }); t.after(() => cache.close());
  const options = (f: typeof a) => ({ cache, producer: chronicleProducer, reuseDirectory: join(f.root, "reuse") });
  const native = connection(a); let captures = 0;
  const captureCache = { ...cache, async remember(value: Parameters<typeof cache.remember>[0]) { captures++; assert.equal(native.counts.closed, 1); return cache.remember(value); } };
  const first = await openStandingHistoryAnalysisStep({ ...a.args, chronicle: { ...options(a), cache: captureCache } });
  try { assert.equal((await next(first, a, native)).kind, "attempt"); assert.equal(captures, 1); }
  finally { await first.close(); }
  return { a, b, cache, options };
}

test("optional chronicle captures only after native close and reuses fresh source in a different task without native attempt", async t => {
  const f = await chroniclePair(t), native = connection(f.b), step = await openStandingHistoryAnalysisStep({ ...f.b.args, chronicle: f.options(f.b) }); t.after(() => step.close());
  const result = await next(step, f.b, native); assert.equal(result.kind, "reused"); if (result.kind !== "reused") assert.fail();
  assert.equal(result.recovered, false); assert.equal(result.cancelled, false); assert.equal(native.counts.acquired, 0); assert.equal(native.counts.turns, 0);
  const stored = await readback(f.b); assert.equal(stored.analysis.analysisNodes, 1); assert.equal(stored.attempts.attempts, 0);
  assert.equal(stored.node!.output.summary, "Prepared synthetic summary"); assert.equal("modelOutcome" in result, false);
});

test("chronicle miss keeps the native path and optional capture failure cannot change the observed result", async t => {
  const f = await fixture(t, 1), native = connection(f); let looked = 0, captured = 0;
  const cache = await openStandingHistoryChronicleCache({ directory: join(f.root, "cache"), passphrase: f.binding.passphrase }); t.after(() => cache.close());
  const badCache = { ...cache, async lookup() { looked++; throw Error("optional read failed"); }, async remember() { captured++; assert.equal(native.counts.closed, 1); throw Error("optional capture failed"); } };
  const step = await openStandingHistoryAnalysisStep({ ...f.args, chronicle: { cache: badCache, producer: chronicleProducer, reuseDirectory: join(f.root, "reuse") } }); t.after(() => step.close());
  const result = await next(step, f, native); assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") assert.fail();
  assert.equal(result.modelOutcome, "observed"); assert.equal(result.release, "acknowledged"); assert.equal(looked, 1); assert.equal(captured, 1);
  assert.equal((await readback(f)).attempts.attempts, 1);
});

test("chronicle never captures a native turn whose owner close failed", async t => {
  const f = await fixture(t, 1), native = connection(f); let captured = 0;
  const cache = await openStandingHistoryChronicleCache({ directory: join(f.root, "cache"), passphrase: f.binding.passphrase }); t.after(() => cache.close());
  const counted = { ...cache, async remember(v: Parameters<typeof cache.remember>[0]) { captured++; return cache.remember(v); } };
  const step = await openStandingHistoryAnalysisStep({ ...f.args, chronicle: { cache: counted, producer: chronicleProducer, reuseDirectory: join(f.root, "reuse") } }); t.after(() => step.close());
  const badConnection = { ...native, value: { async acquireAnalysisAdmission(requestRef: string) { const lease = await native.value.acquireAnalysisAdmission(requestRef); return { ...lease, async close() { throw Error("owner close failed"); } }; } } };
  await assert.rejects(next(step, f, badConnection)); assert.equal(captured, 0);
});

test("fresh cancellation during cache lookup prevents both reuse preparation and native admission", async t => {
  const f = await chroniclePair(t), native = connection(f.b);
  const cancelling = { ...f.cache, async lookup(value: StandingHistoryChronicleSelection) {
    const hit = await f.cache.lookup(value), c = await openStandingHistoryTaskControlStore({ ...f.b.binding, directory: f.b.directories.control, mode: "open" });
    try { await c.cancel({ expectedRevision: 0 }); } finally { await c.close(); } return hit;
  } };
  const step = await openStandingHistoryAnalysisStep({ ...f.b.args, chronicle: { ...f.options(f.b), cache: cancelling } }); t.after(() => step.close());
  await assert.rejects(next(step, f.b, native), /STALE|CANCELLED/); const saved = await readback(f.b);
  assert.equal(saved.analysis.analysisNodes, 0); assert.equal(saved.attempts.attempts, 0); assert.equal(native.counts.acquired, 0);
  assert.equal((await readdir(f.b.root)).includes("reuse"), false);
});

test("pending cold reuse recovers before planning and never invokes native tools", async t => {
  const f = await chroniclePair(t), s = await stores(f.b), planner = createStandingHistoryAnalysisPlanner({ intent: f.b.binding.intent, source: s.source, analysis: s.analysis });
  try {
    let plan = await planner.next(); while (plan.kind === "scan-more") plan = await planner.next(); if (plan.kind !== "leaf") assert.fail();
    const materials = []; for (const request of plan.inputs) materials.push({ request, page: (await s.source.readPage(request.pageIndex))! });
    const hit = await f.cache.lookup({ intent: f.b.binding.intent, producer: chronicleProducer, referenceKey: s.analysis.referenceKey(), materials }); assert.ok(hit);
    const reuse = await openStandingHistoryChronicleReuseStore({ directory: join(f.b.root, "reuse"), ...f.b.binding, analysis: s.analysis });
    try { await reuse.prepare({ sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, nodeIndex: 1, inputs: plan.inputs, hit }); } finally { await reuse.close(); }
  } finally { await planner.close(); await s.close(); }
  const native = connection(f.b), step = await openStandingHistoryAnalysisStep({ ...f.b.args, chronicle: f.options(f.b) }); t.after(() => step.close());
  const result = await next(step, f.b, native); assert.equal(result.kind, "reused"); if (result.kind !== "reused") assert.fail();
  assert.equal(result.recovered, true); assert.equal(native.counts.acquired, 0); assert.equal((await readback(f.b)).attempts.attempts, 0);
});

test("a consumed native refusal is never bypassed through chronicle reuse", async t => {
  const f = await chroniclePair(t); await seed(f.b, { outcome: "refused" }); let looked = 0;
  const counted = { ...f.cache, async lookup(v: StandingHistoryChronicleSelection) { looked++; return f.cache.lookup(v); } };
  const native = connection(f.b), step = await openStandingHistoryAnalysisStep({ ...f.b.args, chronicle: { ...f.options(f.b), cache: counted } }); t.after(() => step.close());
  assert.equal((await next(step, f.b, native, "fresh-refusal-successor")).kind, "attempt"); assert.equal(looked, 0); assert.equal(native.counts.acquired, 1);
  assert.equal((await readback(f.b)).attempts.attempts, 2);
});

test("terminal source with no analysis nodes keeps a native root for existing delivery ownership", async t => {
  const f = await chroniclePair(t), s = await stores(f.b);
  try {
    const before = (await s.source.status()).readProgress.checkpoint, initial = page(before), after = { ...before, pages: before.pages + 1, status: "empty-page" as const };
    await s.source.appendPage({ expectedCheckpoint: before, result: { ...initial, sources: [], nextCheckpoint: after, page: { ...initial.page, messages: [], hasMore: false, status: "empty-page",
      coverage: { ...initial.page.coverage, oldestExaminedDate: before.oldestDate, newestExaminedDate: before.newestDate, traversalComplete: true, pages: after.pages } } } });
  } finally { await s.close(); }
  let looked = 0; const counted = { ...f.cache, async lookup(v: StandingHistoryChronicleSelection) { looked++; return f.cache.lookup(v); } };
  const native = connection(f.b), step = await openStandingHistoryAnalysisStep({ ...f.b.args, chronicle: { ...f.options(f.b), cache: counted } }); t.after(() => step.close());
  assert.equal((await next(step, f.b, native)).kind, "attempt"); assert.equal(looked, 0); assert.equal(native.counts.acquired, 1);
});

test("cold observed predecessor still needs exact owner settlement before cached reuse", async t => {
  const f = await chroniclePair(t, 2), second = await openStandingHistoryAnalysisStep({ ...f.a.args, chronicle: f.options(f.a) });
  try { assert.equal((await next(second, f.a, connection(f.a), "second-source-page")).kind, "attempt"); } finally { await second.close(); }
  await seed(f.b, { node: "recorded", outcome: "observed" }); let verifications = 0;
  const native = connection(f.b), step = await openStandingHistoryAnalysisStep({ ...f.b.args, chronicle: f.options(f.b), async verifyOwnerSettled(binding) {
    verifications++; assert.deepEqual(binding, priorBinding); throw Error("synthetic prior owner not settled");
  } }); t.after(() => step.close());
  await assert.rejects(next(step, f.b, native), /not settled/); assert.equal(verifications, 1); assert.equal(native.counts.acquired, 0);
  const read = await readback(f.b); assert.equal(read.analysis.analysisNodes, 1); assert.equal(read.attempts.attempts, 1);
  assert.equal((await readdir(f.b.root)).includes("reuse"), false);
});

for (const mode of ["source-append", "attempt-append", "failed-close", "lost-append-readback"] as const) test(`retained page read rejects ${mode} and does not replay an uncertain append`, async t => {
  const f = await fixture(t, mode === "attempt-append" ? 1 : 0), step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true });
  t.after(() => step.close()); let reads = 0, closes = 0;
  const ticket: StandingIdleHistoryTicket = { openTaskReply() { throw Error("no send"); }, openHistoryTask({ checkpoint }) {
    assert.ok(checkpoint);
    return { async readTaskPage() {
      reads++;
      if (mode === "source-append") {
        const external = await stores(f);
        try { await external.source.appendPage({ expectedCheckpoint: checkpoint, result: page(checkpoint) }); } finally { await external.close(); }
      }
      if (mode === "attempt-append") await seed(f, { outcome: "unknown" });
      return page(checkpoint);
    }, async close() { closes++; if (mode === "failed-close") throw Error("synthetic read close failure"); } };
  } };
  const realOpen = fsPromises.open, pagePath = join(f.directories.pages, f.binding.intent.taskId, "page-000001.enc");
  let lost = false;
  const spy = t.mock.method(fsPromises, "open", (...args: Parameters<typeof realOpen>) => {
    if (mode === "lost-append-readback" && !lost && String(args[0]) === pagePath && args[1] === "r") {
      lost = true; throw Error("synthetic acknowledgement lost after sync");
    }
    return realOpen(...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(step.readSourcePage({ ticket, signal: f.controller.signal })); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(reads, 1); assert.equal(closes, 1);
  await assert.rejects(step.readSourcePage({ ticket, signal: f.controller.signal })); assert.equal(reads, 1);
  await step.close();
  const reopened = await stores(f);
  try { assert.equal((await reopened.source.status()).readProgress.committedPages, mode === "failed-close" ? 0 : 1);
    assert.equal((await reopened.attempts.status()).attempts, mode === "attempt-append" ? 1 : 0);
  } finally { await reopened.close(); }
});

test("persisted cancellation during retained page read stays task-local without a revoke callback", async t => {
  const f = await fixture(t, 0), step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true });
  t.after(() => step.close()); let closed = 0;
  const ticket: StandingIdleHistoryTicket = { openTaskReply() { throw Error("no send"); }, openHistoryTask({ checkpoint }) { assert.ok(checkpoint);
    return { async readTaskPage() {
      const control = await openStandingHistoryTaskControlStore({ ...f.binding, directory: f.directories.control, mode: "open" });
      try { await control.cancel({ expectedRevision: 0 }); } finally { await control.close(); }
      return page(checkpoint);
    }, async close() { closed++; } };
  } };
  assert.equal((await step.readSourcePage({ ticket, signal: f.controller.signal })).kind, "cancelled"); assert.equal(closed, 1);
  const reopened = await stores(f); try { assert.equal((await reopened.source.status()).readProgress.committedPages, 0); } finally { await reopened.close(); }
});

for (const settled of [true, false]) test(`retained page after reconciled UNKNOWN requires exact prior-owner settlement: ${settled}`, async t => {
  const f = await fixture(t, 1); await seed(f, { node: "recorded", outcome: "unknown" });
  let verifications = 0, reads = 0;
  const step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true, async verifyOwnerSettled(binding) {
    verifications++; assert.deepEqual(binding, priorBinding); if (!settled) throw Error("synthetic owner unsettled"); return proof(binding);
  } });
  t.after(() => step.close());
  const ticket: StandingIdleHistoryTicket = { openTaskReply() { throw Error("no send"); }, openHistoryTask({ checkpoint }) { assert.ok(checkpoint);
    return { async readTaskPage() { reads++; return page(checkpoint); }, async close() {} };
  } };
  if (settled) assert.equal((await step.readSourcePage({ ticket, signal: f.controller.signal })).kind, "committed");
  else await assert.rejects(step.readSourcePage({ ticket, signal: f.controller.signal }));
  assert.equal(reads, settled ? 1 : 0); assert.equal(verifications, 1);
  const reopened = await stores(f); try {
    assert.equal((await reopened.source.status()).readProgress.committedPages, settled ? 2 : 1);
    const attempts = await reopened.attempts.status(); assert.equal(attempts.attempts, 1); assert.equal(attempts.last?.modelOutcome, "unknown");
  } finally { await reopened.close(); }
});

test("retained page close revokes the ticket immediately and joins the in-flight read", async t => {
  const f = await fixture(t, 0), step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true });
  t.after(() => step.close()); const entered = deferred(), release = deferred(); let ticketClosed = 0, stepClosed = false;
  const ticket: StandingIdleHistoryTicket = { openTaskReply() { throw Error("no send"); }, openHistoryTask({ checkpoint, signal }) { assert.ok(checkpoint);
    return { async readTaskPage() { entered.resolve(); await release.promise; assert.equal(signal.aborted, true); return page(checkpoint); },
      async close() { ticketClosed++; } };
  } };
  const read = step.readSourcePage({ ticket, signal: f.controller.signal }); await entered.promise;
  const close = step.close().then(() => { stepClosed = true; }); await immediate();
  assert.equal(ticketClosed, 1); assert.equal(stepClosed, false); release.resolve();
  assert.equal((await read).kind, "cancelled"); await close; assert.equal(stepClosed, true);
  const reopened = await stores(f); try { assert.equal((await reopened.source.status()).readProgress.committedPages, 0); } finally { await reopened.close(); }
});
test("ready capture uses the authenticated stored root without native work and observer errors preserve readiness", async t => {
  const f = await readyFixture(t), events: unknown[] = [], native = connection(f);
  const step = await openStandingHistoryAnalysisStep({ ...f.args, onAnalysisReady(event) {
    const note = requireStandingChronicleNote(event.note, { accountId: "123", peerId: "-100456", requesterId: "456" });
    assert.equal(note.notes.summary.text, "Stored synthetic note"); assert.equal(note.notes.claimsStatus, "model-authored-unverified");
    assert.equal(event.intent.taskId, f.binding.intent.taskId); events.push(event);
    if (events.length === 1) throw Error("optional observer failed");
    return Promise.reject(Error("ordinary function violated synchronous callback contract"));
  } });
  try { assert.equal((await next(step, f, native)).kind, "analysis-ready"); assert.equal(events.length, 1);
    assert.equal((await next(step, f, native)).kind, "analysis-ready"); await immediate(); assert.equal(events.length, 2);
    assert.equal(native.counts.acquired, 0); assert.equal(native.counts.turns, 0); assert.equal((await readback(f)).attempts.attempts, 0);
  } finally { await step.close(); }
});

test("invalid ready observers are refused before filesystem IO or callback evaluation", async t => {
  const f = await fixture(t, 0); let touched = 0;
  const realOpen = fsPromises.open;
  const spy = t.mock.method(fsPromises, "open", (...args: Parameters<typeof realOpen>) => { touched++; return realOpen(...args); });
  syncBuiltinESMExports();
  try {
    for (const onAnalysisReady of [undefined, null, 7, async () => {}, function* () {}, async function* () {}, new Proxy(() => {}, { apply() { touched++; throw Error(); } })]) {
      await assert.rejects(openStandingHistoryAnalysisStep({ ...f.args, onAnalysisReady } as never), /INPUT/);
    }
    const hostile = { ...f.args }; Object.defineProperty(hostile, "onAnalysisReady", { enumerable: true, get() { touched++; throw Error(); } });
    await assert.rejects(openStandingHistoryAnalysisStep(hostile), /INPUT/); assert.equal(touched, 0);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

for (const mode of ["read-error", "stale", "close"] as const) test(`ready capture ${mode} is joined and never publishes unchecked notes`, async t => {
  const f = await readyFixture(t), native = connection(f); let captures = 0;
  const step = await openStandingHistoryAnalysisStep({ ...f.args, onAnalysisReady() { captures++; } });
  const file = join(f.directories.analysis, f.binding.intent.taskId, "node-000001.enc"), gate = deferred(), release = deferred();
  let nodeReads = 0, finished = false;
  const realOpen = fsPromises.open;
  const spy = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof realOpen>) => {
    if (String(args[0]) === file && ++nodeReads === 2) {
      // The first read is planner inventory; the second is optional capture.
      gate.resolve(); await release.promise;
      if (mode === "read-error") throw Error("synthetic optional read failure");
      if (mode === "stale") await writeFile(file, "synthetic changed root");
    }
    return realOpen(...args);
  });
  syncBuiltinESMExports();
  const pending = next(step, f, native).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([gate.promise, pending.then(() => { throw Error("capture read gate was not reached"); })]);
    let closing: Promise<void> | undefined;
    if (mode === "close") { closing = step.close().then(() => { finished = true; }); await immediate(); assert.equal(finished, false); }
    release.resolve(); const result = await pending;
    if (mode === "close") { assert.ok("error" in result); await closing; assert.equal(finished, true); }
    else { assert.ok("value" in result); assert.equal(result.value.kind, "analysis-ready"); }
    assert.equal(captures, 0); assert.equal(native.counts.turns, 0); assert.equal(native.counts.acquired, 0);
  } finally { release.resolve(); await pending; spy.mock.restore(); syncBuiltinESMExports(); await step.close(); }
});
const priorBinding: StandingHistoryAnalysisNativeBinding = { epochId: "b".repeat(32), requestRef: "prior-request", purpose: "history-analysis" };
async function readyFixture(t: TestContext) {
  const f = await fixture(t, 0), s = await stores(f);
  const planner = createStandingHistoryAnalysisPlanner({ intent: f.binding.intent, source: s.source, analysis: s.analysis });
  try {
    const before = (await s.source.status()).readProgress.checkpoint, initial = page(before);
    const nextCheckpoint = { ...before, pages: 1, status: "empty-page" as const };
    await s.source.appendPage({ expectedCheckpoint: before, result: { ...initial, nextCheckpoint, sources: [], page: { ...initial.page,
      messages: [], hasMore: false, status: "empty-page", coverage: { ...initial.page.coverage,
        oldestExaminedDate: null, newestExaminedDate: null, traversalComplete: true } } } });
    for (let i = 0; i < 8; i++) {
      const plan = await planner.next(); if (plan.kind === "scan-more") continue;
      assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") assert.fail("expected empty-page leaf");
      await s.analysis.appendLeaf({ expectedHead: plan.expectedHead, inputs: plan.inputs, output: { summary: "Stored synthetic note", claims: [] } }); break;
    }
  } finally { await planner.close(); await s.close(); }
  return f;
}
function proof(nativeBinding: StandingHistoryAnalysisNativeBinding): StandingHistoryAnalysisOwnerSettlement {
  return { schema: "standing-analysis-owner-settlement-v1", nativeBinding, resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function page(before: SelfHistoryTaskCheckpoint): SelfHistoryTaskPage {
  const id = (before.offsetId || 1000) - 1, date = before.lastDate - 1, ref = "m_" + id.toString(16).padStart(24, "0");
  const next = { ...before, pages: before.pages + 1, offsetId: id, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date, upperBoundMessageId: before.upperBoundMessageId ?? id };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: [{ messageId: id, date, disposition: "included", messageRef: ref, authorId: "456" }], page: {
    schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
    messages: [{ ref, authorRef: "a_" + "4".repeat(24), author: "user", displayName: "Synthetic speaker", date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Private source " + id }],
    cursor: null, hasMore: true, status: "more", coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: false, undatedEntries: 0, pages: next.pages },
    excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
async function fixture(t: TestContext, pageCount = 2, sourceDescriptor?: StandingHistoryTaskIntent["source"], taskDigit = "6", objective = "Synthetic available history analysis") {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-analysis-step-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-analysis-step-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + taskDigit.repeat(48), accountId: "123", chatId: "-100456",
    requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective,
    ...(sourceDescriptor ? { source: sourceDescriptor } : {}) };
  const binding = { intent, passphrase: "synthetic-analysis-step-passphrase" }, controller = new AbortController();
  const source = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "create" });
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: directories.control, mode: "create" });
  const analysis = await openStandingHistoryAnalysisStore({ ...binding, directory: directories.analysis, mode: "create", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: directories.attempts, mode: "create", analysis });
  for (let i = 0; i < pageCount; i++) { const before = (await source.status()).readProgress.checkpoint; await source.appendPage({ expectedCheckpoint: before, result: page(before) }); }
  await attempts.close(); await analysis.close(); await source.close(); await control.close();
  const settlements: StandingHistoryAnalysisNativeBinding[] = [];
  const args = { ...binding, directories, signal: controller.signal, async verifyOwnerSettled(value: StandingHistoryAnalysisNativeBinding) { settlements.push(value); return proof(value); } };
  return { root, directories, binding, controller, args, settlements };
}
async function stores(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await openStandingHistoryTaskStore({ ...f.binding, directory: f.directories.pages, mode: "open" });
  const control = await openStandingHistoryTaskControlStore({ ...f.binding, directory: f.directories.control, mode: "open" });
  const analysis = await openStandingHistoryAnalysisStore({ ...f.binding, directory: f.directories.analysis, mode: "open", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...f.binding, directory: f.directories.attempts, mode: "open", analysis });
  return { source, control, analysis, attempts, async close() { await attempts.close(); await analysis.close(); await source.close(); await control.close(); } };
}
async function readback(f: Awaited<ReturnType<typeof fixture>>) {
  const s = await stores(f); try { return { attempts: await s.attempts.status(), analysis: await s.analysis.status(), node: await s.analysis.readNodeAt(1) }; } finally { await s.close(); }
}
async function opened(f: Awaited<ReturnType<typeof fixture>>, t: TestContext, verifier = f.args.verifyOwnerSettled) {
  const step = await openStandingHistoryAnalysisStep({ ...f.args, verifyOwnerSettled: verifier }); t.after(() => step.close()); return step;
}
function connection(f: Awaited<ReturnType<typeof fixture>>, mode: "commit" | "unknown" | "lost-commit" | "no-node" | "wrong-scope" | "blocked" | "refused" = "commit", afterTools?: () => Promise<void>, epochId = "a".repeat(32)) {
  const counts = { acquired: 0, turns: 0, released: 0, aborts: 0, closed: 0 }, previous: (StandingHistoryAnalysisNativeBinding | undefined)[] = [];
  const entered = deferred(), release = deferred(), turnDone = deferred(), requireNewEpoch: boolean[] = [];
  const value: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(requestRef, previousBinding, options) {
    counts.acquired++; previous.push(previousBinding);
    requireNewEpoch.push(options?.requireNewEpoch === true);
    const nativeBinding: StandingHistoryAnalysisNativeBinding = { epochId, requestRef, purpose: "history-analysis" };
    return { nativeBinding, async turnAnalysis(req, body, bindings): Promise<CompletedAnalysisTurn> {
      counts.turns++; entered.resolve();
      try {
        assert.equal(req, requestRef); assert.equal(JSON.parse(body).schema, "neurobro-history-analysis-input-v1");
        const packet = JSON.parse(body);
        if (options?.requireNewEpoch) assert.match(packet.continuation, /previous settled analysis attempt produced no accepted node/);
        if (f.binding.intent.source) {
          assert.equal(packet.sourceRef, "community"); assert.equal(packet.sourceInterpretation, "quoted-source-not-request");
          assert.equal(body.includes(f.binding.intent.source.peerId), false); assert.equal(body.includes(f.binding.intent.source.workspaceId), false);
        } else { assert.equal(Object.hasOwn(packet, "sourceRef"), false); assert.equal(Object.hasOwn(packet, "sourceInterpretation"), false); }
        assert.deepEqual(bindings.analysisTools.map(tool => tool.name), ["neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit"]);
        if (mode === "blocked") { await release.promise; throw Error("synthetic interrupted native turn"); }
        if (mode === "unknown") throw Error("synthetic native outcome missing");
        if (mode === "refused") throw new EpochTurnNotAdmitted("time");
        let calls = 0;
        if (mode !== "no-node") {
          const scope = { requestRef: req, callRef: "material", signal: f.controller.signal };
          const material = await bindings.analysisTools[0]!.call({}, scope) as EpochToolResult; assert.equal(material.success, true); calls++;
          bindings.onToolResultSent({ requestRef: req, callRef: "material", name: "neurobro_analysis_material", result: material });
          const commit = await bindings.analysisTools[2]!.call({ output: { summary: "Prepared synthetic summary", claims: [] } }, { ...scope, callRef: "commit" }) as EpochToolResult;
          assert.equal(commit.success, true); calls++;
          if (mode === "lost-commit") throw Error("synthetic lost commit response");
          bindings.onToolResultSent({ requestRef: req, callRef: "commit", name: "neurobro_analysis_commit", result: commit });
        }
        await afterTools?.();
        return { kind: "analysis", scope: { epochId: nativeBinding.epochId, purpose: "history-analysis", requestRef: mode === "wrong-scope" ? "other-request" : req,
          threadId: "existing-analysis-thread", turnId: "native-turn-1", turnNumber: 1, threadTurnNumber: 1 }, answer: "Synthetic response", toolCalls: calls, toolRefusals: 0 };
      } finally { turnDone.resolve(); }
    }, async releaseAnalysis(req) { assert.equal(req, requestRef); counts.released++; },
    async abortAndJoin() { counts.aborts++; if (counts.turns) await turnDone.promise; }, async close() { counts.closed++; } };
  } };
  return { value, counts, previous, entered, release, requireNewEpoch };
}
async function next(step: Step, f: Awaited<ReturnType<typeof fixture>>, native: ReturnType<typeof connection>, requestRef = "new-request", signal = f.controller.signal) {
  for (let i = 0; i < 20; i++) { const result = await step.next({ requestRef, connection: native.value, signal }); if (result.kind !== "scan-more") return result; }
  assert.fail("bounded fixture planning did not finish");
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, options: { bound?: boolean; prepared?: boolean; node?: "recorded" | "unacknowledged"; outcome?: "observed" | "unknown" | "refused" } = {}) {
  const s = await stores(f), planner = createStandingHistoryAnalysisPlanner({ intent: f.binding.intent, source: s.source, analysis: s.analysis });
  try {
    let selected = await planner.next(); for (let i = 0; selected.kind === "scan-more" && i < 10; i++) selected = await planner.next();
    assert.equal(selected.kind, "leaf"); if (selected.kind !== "leaf") throw Error("leaf required");
    const prepared = prepareStandingHistoryAnalysisMaterial(selected), plan: StandingHistoryAnalysisAttemptPlan = { kind: "leaf", sourceHead: selected.sourceHead,
      expectedHead: selected.expectedHead, nodeIndex: 1, modelInputHash: prepared.modelInputHash, inputs: selected.inputs };
    const reservation = await s.attempts.reserve({ plan, ...(options.bound === false ? {} : { nativeBinding: priorBinding }) });
    const output = { summary: "Already prepared private output", claims: [] };
    if (options.prepared || options.node) await s.attempts.prepare({ attemptRef: reservation.attemptRef, output });
    if (options.node === "recorded") await s.attempts.commitPrepared({ attemptRef: reservation.attemptRef });
    if (options.node === "unacknowledged") await s.analysis.appendLeaf({ expectedHead: plan.expectedHead, inputs: plan.inputs, output });
    if (options.outcome) await s.attempts.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome: options.outcome });
    return reservation;
  } finally { await planner.close(); await s.close(); }
}

test("one actionable step uses a borrowed epoch, saves node and observed outcome, then remains consumed", async t => {
  const f = await fixture(t), step = await opened(f, t), native = connection(f), result = await next(step, f, native);
  assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(result.modelOutcome, "observed"); assert.equal(result.release, "acknowledged"); assert.equal(result.node?.index, 1); assert.equal(result.cancelled, false);
  assert.deepEqual(native.counts, { acquired: 1, turns: 1, released: 1, aborts: 0, closed: 1 });
  await assert.rejects(next(step, f, native)); await step.close();
  const saved = await readback(f); assert.equal(saved.attempts.last?.modelOutcome, "observed"); assert.deepEqual(saved.attempts.last?.node, result.node);
  assert.equal(saved.attempts.last?.nativeBinding?.requestRef, "new-request"); assert.equal(saved.analysis.analysisNodes, 1);
});

test("retained step admits distinct successful attempts and revokes old callbacks before the next turn", async t => {
  const f = await fixture(t), step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true }), native = connection(f);
  t.after(() => step.close());
  type Bindings = Parameters<Awaited<ReturnType<StandingHistoryAnalysisStepConnection["acquireAnalysisAdmission"]>>["turnAnalysis"]>[2];
  let old: Bindings | undefined;
  const wrapped: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(...args) {
    const lease = await native.value.acquireAnalysisAdmission(...args);
    return { ...lease, async turnAnalysis(requestRef, body, bindings) {
      if (old) {
        await assert.rejects(old.analysisTools[0]!.call({}, { requestRef, callRef: "stale-call", signal: f.controller.signal }), /CONSUMED/);
        assert.throws(() => old!.onToolResultSent({ requestRef, callRef: "stale-call", name: "neurobro_analysis_material",
          result: { success: true, contentItems: [{ type: "inputText", text: "synthetic stale result" }] } }), /CONSUMED/);
      }
      old = bindings; return lease.turnAnalysis(requestRef, body, bindings);
    } };
  } };
  const first = await next(step, f, { ...native, value: wrapped }, "retained-first");
  assert.equal(first.kind, "attempt");
  await assert.rejects(next(step, f, native, "retained-first"), /CONSUMED/);
  assert.equal(native.counts.acquired, 1);
  const second = await next(step, f, { ...native, value: wrapped }, "retained-second");
  assert.equal(second.kind, "attempt");
  if (first.kind !== "attempt" || second.kind !== "attempt") return;
  assert.notEqual(first.attemptRef, second.attemptRef); assert.equal(first.node?.index, 1); assert.equal(second.node?.index, 2);
  assert.equal(second.modelOutcome, "observed"); assert.equal(second.release, "acknowledged"); assert.equal(second.cancelled, false);
  assert.deepEqual(native.counts, { acquired: 2, turns: 2, released: 2, aborts: 0, closed: 2 });
  assert.equal(native.previous[1]?.requestRef, "retained-first");
  await step.close(); const saved = await readback(f); assert.equal(saved.attempts.attempts, 2); assert.equal(saved.analysis.analysisNodes, 2);
});

for (const mode of ["refused", "unknown", "lost-commit", "no-node"] as const) test(`retained step remains consumed after ${mode}`, async t => {
  const f = await fixture(t), step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true }), native = connection(f, mode);
  t.after(() => step.close());
  assert.equal((await next(step, f, native, "first-request")).kind, "attempt");
  await assert.rejects(next(step, f, native, "different-request"), /CONSUMED/);
  assert.equal(native.counts.turns, 1); assert.equal(native.counts.acquired, 1);
});

for (const mode of ["cancelled", "source-append", "source-extra", "analysis-extra", "attempt-extra", "known-file"] as const)
  test(`retained step detects parked ${mode} before acquiring another owner`, async t => {
    const f = await fixture(t), step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true }), native = connection(f);
    t.after(() => step.close());
    assert.equal((await next(step, f, native, "first-request")).kind, "attempt");
    if (mode === "cancelled" || mode === "source-append") {
      const s = await stores(f);
      try {
        if (mode === "cancelled") await s.control.cancel({ expectedRevision: 0 });
        else { const before = (await s.source.status()).readProgress.checkpoint; await s.source.appendPage({ expectedCheckpoint: before, result: page(before) }); }
      } finally { await s.close(); }
    } else {
      const dir = mode === "analysis-extra" ? f.directories.analysis : mode === "attempt-extra" ? f.directories.attempts : f.directories.pages;
      await writeFile(join(dir, f.binding.intent.taskId, mode === "known-file" ? "page-000001.enc" : "unexpected.enc"), "retained synthetic mutation");
    }
    await assert.rejects(next(step, f, native, "different-request")); assert.equal(f.controller.signal.aborted, false);
    assert.equal(native.counts.turns, 1); assert.equal(native.counts.acquired, 1);
  });

for (const mode of ["failed-close", "failed-release", "abort-on-close", "cancel-on-close"] as const)
  test(`retained step does not reuse after ${mode}`, async t => {
    const f = await fixture(t), step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true }), native = connection(f);
    t.after(() => step.close());
    const wrapped: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(...args) {
      const lease = await native.value.acquireAnalysisAdmission(...args);
      return { ...lease, async releaseAnalysis(requestRef) {
        if (mode === "failed-release") throw Error("synthetic release failure"); await lease.releaseAnalysis(requestRef);
      }, async close() {
        await lease.close();
        if (mode === "failed-close") throw Error("synthetic close failure");
        if (mode === "abort-on-close") f.controller.abort();
        if (mode === "cancel-on-close") {
          const control = await openStandingHistoryTaskControlStore({ ...f.binding, directory: f.directories.control, mode: "open" });
          try { await control.cancel({ expectedRevision: 0 }); } finally { await control.close(); }
        }
      } };
    } };
    const pending = next(step, f, { ...native, value: wrapped }, "first-request");
    if (mode === "failed-close") await assert.rejects(pending, /synthetic close failure/); else await pending;
    await assert.rejects(next(step, f, native, "different-request"));
    assert.equal(native.counts.turns, 1); assert.equal(native.counts.acquired, 1);
  });

test("retained step cannot admit while successful owner close is still outstanding", async t => {
  const f = await fixture(t), step = await openStandingHistoryAnalysisStep({ ...f.args, retainWorkingState: true }), native = connection(f);
  t.after(() => step.close()); const entered = deferred(), release = deferred();
  const wrapped: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(...args) {
    const lease = await native.value.acquireAnalysisAdmission(...args);
    return { ...lease, async close() { entered.resolve(); await release.promise; await lease.close(); } };
  } };
  const pending = next(step, f, { ...native, value: wrapped }, "first-request");
  try {
    await entered.promise; await assert.rejects(next(step, f, native, "different-request"), /BUSY/); assert.equal(native.counts.turns, 1);
  } finally { release.resolve(); }
  await pending; assert.equal((await next(step, f, native, "different-request")).kind, "attempt");
});

test("community step reopens source-bound stores and emits only sanitized source metadata to analysis", async t => {
  const f = await fixture(t, 1, { kind: "observed-source", sourceRef: "community", workspaceId: "synthetic-workspace", peerId: "-100987" });
  const step = await opened(f, t), native = connection(f), result = await next(step, f, native);
  assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(result.modelOutcome, "observed"); assert.equal(result.release, "acknowledged"); await step.close();
  const saved = await readback(f); assert.equal(saved.analysis.analysisNodes, 1); assert.equal(saved.attempts.last?.modelOutcome, "observed");
  assert.equal(f.binding.intent.chatId, "-100456"); assert.equal(f.binding.intent.requesterId, "456");
});

test("passive read-more planning never acquires a native admission lease", async t => {
  const f = await fixture(t, 0), step = await opened(f, t), native = connection(f);
  assert.equal((await next(step, f, native)).kind, "read-more"); assert.equal(native.counts.acquired, 0); assert.equal((await readback(f)).attempts.attempts, 0);
});

test("unknown native reservation is durable and never reuses its epoch or request", async t => {
  const f = await fixture(t), step = await opened(f, t), native = connection(f, "unknown"), result = await next(step, f, native);
  assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(result.modelOutcome, "unknown"); assert.equal(result.node, undefined); assert.equal(result.release, "not-acknowledged");
  assert.equal(native.counts.aborts, 1); await step.close();
  const again = await opened(f, t), other = connection(f); await assert.rejects(next(again, f, other));
  assert.equal(other.counts.acquired, 1); assert.equal(other.counts.turns, 0); assert.deepEqual(f.settlements, []);
  const saved = await readback(f); assert.equal(saved.attempts.attempts, 1); assert.equal(saved.attempts.last?.modelOutcome, "unknown"); assert.equal(saved.attempts.modelReplayAllowed, false);
});

for (const mode of ["refused", "no-node", "unknown"] as const) for (const packing of [undefined, "wide"] as const) test(`${mode} resumes the exact old plan after restart under ${packing ?? "legacy"} packing`, async t => {
  const f = await fixture(t), first = await opened(f, t), refused = connection(f, mode);
  const result = await next(first, f, refused, "refused-request");
  assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(result.modelOutcome, mode === "refused" ? "refused" : mode === "unknown" ? "unknown" : "observed"); assert.equal(result.node, undefined); await first.close();
  const slot = join(f.directories.attempts, f.binding.intent.taskId), originals = await Promise.all((await readdir(slot)).map(async name => [name, await readFile(join(slot, name), "utf8")] as const));
  const before = await readback(f), again = await openStandingHistoryAnalysisStep({ ...f.args, ...(packing ? { packing } : {}) }), fresh = connection(f, "commit", undefined, "c".repeat(32));
  t.after(() => again.close());
  const completed = await next(again, f, fresh, "successor-request"); assert.equal(completed.kind, "attempt"); if (completed.kind !== "attempt") return;
  assert.equal(completed.modelOutcome, "observed"); assert.equal(completed.node?.index, 1); assert.notEqual(completed.attemptRef, result.attemptRef);
  assert.deepEqual(f.settlements, [before.attempts.last!.nativeBinding]); assert.deepEqual(fresh.previous, [before.attempts.last!.nativeBinding]);
  assert.deepEqual(fresh.requireNewEpoch, [true]);
  await again.close(); const after = await readback(f); assert.equal(after.attempts.attempts, 2); assert.equal(after.attempts.storage, "ready");
  assert.equal(after.attempts.last?.planHash, before.attempts.last?.planHash);
  for (const [name, content] of originals) assert.equal(await readFile(join(slot, name), "utf8"), content);
});

for (const kind of ["leaf", "merge"] as const) test(`wide ${kind} admission refusal restores all eight inputs after restart`, async t => {
  const f = await fixture(t, 8);
  if (kind === "merge") {
    const s = await stores(f);
    try {
      for (let i = 1; i <= 8; i++) {
        const material = projectStandingHistorySource({ intent: f.binding.intent, referenceKey: s.analysis.referenceKey(), storedPage: (await s.source.readPage(i))! });
        await s.analysis.appendLeaf({ expectedHead: (await s.analysis.status()).headHash,
          inputs: [{ pageIndex: i, maxBytes: 49152, materialRef: material.materialRef }], output: { summary: `Page ${i}`, claims: [] } });
      }
    } finally { await s.close(); }
  }
  const first = await openStandingHistoryAnalysisStep({ ...f.args, packing: "wide" }); t.after(() => first.close());
  const refused = await next(first, f, connection(f, "refused"), "wide-refused");
  assert.equal(refused.kind, "attempt"); if (refused.kind !== "attempt") return;
  assert.equal(refused.modelOutcome, "refused"); await first.close();
  const s = await stores(f); let plan;
  try { plan = await s.attempts.readNotAdmittedPlan(refused.attemptRef); } finally { await s.close(); }
  assert.equal(plan.kind, kind); assert.equal(plan.kind === "leaf" ? plan.inputs.length : plan.children.length, 8);
  const before = await readback(f), second = await openStandingHistoryAnalysisStep({ ...f.args, packing: "wide" }); t.after(() => second.close());
  const completed = await next(second, f, connection(f, "commit", undefined, "c".repeat(32)), "wide-successor");
  assert.equal(completed.kind, "attempt"); if (completed.kind !== "attempt") return;
  assert.equal(completed.modelOutcome, "observed"); assert.ok(completed.node); await second.close();
  const after = await readback(f); assert.equal(after.attempts.last?.planHash, before.attempts.last?.planHash);
  assert.equal(after.attempts.attempts, 2); assert.equal(after.analysis.analysisNodes, kind === "leaf" ? 1 : 9);
});

test("legacy asymmetric merge refusal keeps its original partial view when wide packing could show more", async t => {
  const f = await fixture(t, 2), s = await stores(f);
  try {
    for (let i = 1; i <= 2; i++) {
      const material = projectStandingHistorySource({ intent: f.binding.intent, referenceKey: s.analysis.referenceKey(), storedPage: (await s.source.readPage(i))! });
      const row = material.rows[0]!;
      await s.analysis.appendLeaf({ expectedHead: (await s.analysis.status()).headHash,
        inputs: [{ pageIndex: i, maxBytes: 49152, materialRef: material.materialRef }],
        output: { summary: i === 1 ? "x".repeat(4000) : "Small second child", claims: i === 1 ? Array.from({ length: 4 }, () => ({ kind: "reported" as const,
          text: "\u0001".repeat(1000), supports: [{ sourceRef: row.sourceRef, versionRef: row.versionRef }] })) : [] } });
    }
  } finally { await s.close(); }
  const first = await opened(f, t), declined = await next(first, f, connection(f, "refused"), "old-pair");
  assert.equal(declined.kind, "attempt"); if (declined.kind !== "attempt") return; await first.close();
  const before = await readback(f), second = await openStandingHistoryAnalysisStep({ ...f.args, packing: "wide" }); t.after(() => second.close());
  const result = await next(second, f, connection(f, "commit", undefined, "d".repeat(32)), "new-pair");
  assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(result.modelOutcome, "observed"); assert.equal(result.node?.index, 3); await second.close();
  const after = await readback(f); assert.equal(after.attempts.last?.planHash, before.attempts.last?.planHash);
  assert.equal(after.attempts.attempts, 2);
});

for (const outcome of ["refused", "observed", "unknown", undefined] as const) test(`${outcome ?? "missing"} empty continuation with unknown settlement, old epoch or old request creates no reservation`, async t => {
  for (const mode of ["unknown-settlement", "old-epoch", "old-request"] as const) {
    const f = await fixture(t); await seed(f, { ...(outcome ? { outcome } : {}) });
    const verifier = mode === "unknown-settlement" ? async () => { throw Error("settlement is unknown"); } : f.args.verifyOwnerSettled;
    const step = await opened(f, t, verifier), native = connection(f, "commit", undefined, mode === "old-epoch" ? priorBinding.epochId : "c".repeat(32));
    await assert.rejects(next(step, f, native, mode === "old-request" ? priorBinding.requestRef : "fresh-request"));
    assert.equal(native.counts.turns, 0); await step.close(); assert.equal((await readback(f)).attempts.attempts, 1);
  }
});

test("refused continuation blocks changed source heads, cancellation and contradictory output", async t => {
  for (const mode of ["source", "cancelled", "prepared", "node", "unbound"] as const) {
    const f = await fixture(t); const seeded = await seed(f, { outcome: "refused", ...(mode === "prepared" ? { prepared: true } : {}),
      ...(mode === "node" ? { node: "recorded" as const } : {}), ...(mode === "unbound" ? { bound: false } : {}) });
    if (mode === "source" || mode === "cancelled") {
      const s = await stores(f); try {
        if (mode === "source") { const before = (await s.source.status()).readProgress.checkpoint; await s.source.appendPage({ expectedCheckpoint: before, result: page(before) }); }
        else await s.control.cancel({ expectedRevision: 0 });
      } finally { await s.close(); }
    }
    const native = connection(f); let step: Step | undefined;
    try {
      await assert.rejects(async () => { step = await opened(f, t); await next(step, f, native); });
      if (mode === "prepared" || mode === "node") await assert.rejects(step!.recoverPrepared({ attemptRef: seeded.attemptRef, signal: f.controller.signal }));
    } finally { await step?.close(); }
    assert.equal(native.counts.turns, 0); assert.equal((await readback(f)).attempts.attempts, 1);
  }
});

for (const outcome of ["unknown", undefined] as const) for (const change of ["source", "cancelled"] as const)
  test(`${outcome ?? "missing"} successor rechecks ${change} after physical settlement and before reservation`, async t => {
    const f = await fixture(t); await seed(f, { ...(outcome ? { outcome } : {}) });
    const step = await opened(f, t, async binding => {
      const s = await stores(f);
      try {
        if (change === "cancelled") await s.control.cancel({ expectedRevision: 0 });
        else { const before = (await s.source.status()).readProgress.checkpoint; await s.source.appendPage({ expectedCheckpoint: before, result: page(before) }); }
      } finally { await s.close(); }
      return proof(binding);
    });
    const native = connection(f, "commit", undefined, "e".repeat(32));
    await assert.rejects(next(step, f, native, "changed-after-settlement")); await step.close();
    assert.equal(native.counts.turns, 0); assert.equal((await readback(f)).attempts.attempts, 1);
  });

test("lost commit response preserves node independently of UNKNOWN; malformed completed scope stays unknown", async t => {
  for (const mode of ["lost-commit", "wrong-scope"] as const) {
    const f = await fixture(t), step = await opened(f, t), native = connection(f, mode), result = await next(step, f, native);
    assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
    assert.equal(result.modelOutcome, "unknown"); assert.equal(result.node?.index, 1); assert.equal(native.counts.released, 0); assert.equal(native.counts.aborts, 1);
    await step.close(); const saved = await readback(f); assert.equal(saved.analysis.analysisNodes, 1); assert.equal(saved.attempts.last?.modelOutcome, "unknown");
    assert.deepEqual(saved.attempts.last?.node, result.node);
  }
});

test("partial native-outcome file after actual commit prevents success and preserves the saved node", async t => {
  const f = await fixture(t), step = await opened(f, t), path = join(f.directories.attempts, f.binding.intent.taskId, "attempt-000001.native.enc");
  const native = connection(f, "commit", async () => {
    // Runtime already committed to the actual analysis and attempt stores; only
    // the subsequent native-outcome append is made unreadable here.
    assert.equal((await readback(f)).analysis.analysisNodes, 1);
    await writeFile(path, "retained partial native outcome");
  });
  await assert.rejects(next(step, f, native));
  assert.deepEqual(native.counts, { acquired: 1, turns: 1, released: 0, aborts: 1, closed: 1 });
  await step.close(); const saved = await readback(f);
  assert.equal(saved.analysis.analysisNodes, 1); assert.equal(saved.attempts.storage, "tail-refused");
  assert.equal(saved.attempts.last?.node?.index, 1); assert.equal(saved.attempts.last?.modelOutcome, undefined);
  assert.equal(await readFile(path, "utf8"), "retained partial native outcome");
});

test("separate persisted cancellation after commit is reread before release without relying on signal abort", async t => {
  const f = await fixture(t), step = await opened(f, t), native = connection(f, "commit", async () => {
    assert.equal((await readback(f)).analysis.analysisNodes, 1);
    const external = await openStandingHistoryTaskControlStore({ ...f.binding, directory: f.directories.control, mode: "open" });
    try { assert.equal((await external.cancel({ expectedRevision: 0 })).state, "cancelled"); } finally { await external.close(); }
  });
  const result = await next(step, f, native); assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(f.controller.signal.aborted, false); assert.equal(result.cancelled, true); assert.equal(result.modelOutcome, "observed");
  assert.equal(result.node?.index, 1); assert.equal(result.release, "not-acknowledged");
  assert.deepEqual(native.counts, { acquired: 1, turns: 1, released: 0, aborts: 1, closed: 1 });
  await step.close(); const saved = await readback(f); assert.equal(saved.analysis.analysisNodes, 1); assert.equal(saved.attempts.last?.modelOutcome, "observed");
});

test("observed completion without a saved node cannot reuse the same epoch", async t => {
  const f = await fixture(t), step = await opened(f, t), native = connection(f, "no-node"), result = await next(step, f, native);
  assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(result.modelOutcome, "observed"); assert.equal(result.node, undefined); await step.close();
  const again = await opened(f, t), other = connection(f); await assert.rejects(next(again, f, other)); assert.equal(other.counts.turns, 0);
});

test("prepared recovery requires exact persisted settlement and never needs a connection or native invocation", async t => {
  for (const node of [undefined, "unacknowledged"] as const) {
    const f = await fixture(t), reservation = await seed(f, { prepared: true, ...(node ? { node } : {}) });
    for (const corrupt of ["persisted", "binding"] as const) {
      const step = await opened(f, t, async value => corrupt === "persisted" ? { ...proof(value), persisted: false } as never : { ...proof(value), nativeBinding: { ...value, requestRef: "foreign-owner" } });
      await assert.rejects(step.recoverPrepared({ attemptRef: reservation.attemptRef, signal: f.controller.signal })); await step.close();
      assert.equal((await readback(f)).attempts.last?.modelOutcome, undefined);
    }
    const recovered = await opened(f, t), result = await recovered.recoverPrepared({ attemptRef: reservation.attemptRef, signal: f.controller.signal });
    assert.equal(result.kind, "recovered"); assert.equal(result.node.index, 1); assert.equal(result.modelOutcome, "unknown"); assert.deepEqual(f.settlements, [priorBinding]);
    await recovered.close(); const saved = await readback(f); assert.equal(saved.analysis.analysisNodes, 1); assert.deepEqual(saved.attempts.last?.node, result.node); assert.equal(saved.attempts.last?.modelOutcome, "unknown");
  }
});

test("prior UNKNOWN with a saved node still requires exact settlement before a fresh reservation", async t => {
  const f = await fixture(t); await seed(f, { node: "recorded", outcome: "unknown" });
  const rejected = await opened(f, t, async value => ({ ...proof(value), replacementReady: false }) as never), first = connection(f);
  await assert.rejects(next(rejected, f, first)); assert.equal(first.counts.turns, 0); assert.equal((await readback(f)).attempts.attempts, 1); await rejected.close();
  const allowed = await opened(f, t), second = connection(f), result = await next(allowed, f, second, "successor-request");
  assert.equal(result.kind, "attempt"); if (result.kind === "attempt") assert.equal(result.node?.index, 2);
  assert.deepEqual(second.previous, [priorBinding]); assert.deepEqual(f.settlements, [priorBinding]);
});

test("observed predecessor binding is handed to admission; legacy unbound journals remain blocked", async t => {
  const f = await fixture(t); await seed(f, { node: "recorded", outcome: "observed" });
  const step = await opened(f, t, async () => { assert.fail("observed predecessor release belongs to admission capability"); }), native = connection(f);
  assert.equal((await next(step, f, native)).kind, "attempt"); assert.deepEqual(native.previous, [priorBinding]);
  const g = await fixture(t), reserved = await seed(g, { bound: false, node: "recorded", outcome: "observed" });
  const legacy = await opened(g, t), other = connection(g); await assert.rejects(next(legacy, g, other));
  await assert.rejects(legacy.recoverPrepared({ attemptRef: reserved.attemptRef, signal: g.controller.signal })); assert.equal(other.counts.acquired, 0);
});

test("cancelled or corrupt existing stores refuse admission and factory never creates absent slots", async t => {
  for (const mode of ["cancelled", "corrupt"] as const) {
    const f = await fixture(t), native = connection(f);
    if (mode === "cancelled") { const s = await stores(f); await s.control.cancel({ expectedRevision: 0 }); await s.close(); }
    else await writeFile(join(f.directories.attempts, f.binding.intent.taskId, "intent.enc"), "retained corrupt intent");
    await assert.rejects(openStandingHistoryAnalysisStep(f.args)); assert.equal(native.counts.acquired, 0);
    if (mode === "corrupt") assert.equal(await readFile(join(f.directories.attempts, f.binding.intent.taskId, "intent.enc"), "utf8"), "retained corrupt intent");
  }
  const f = await fixture(t), missingIntent = { ...f.binding.intent, taskId: "htask_" + "f".repeat(48) };
  await assert.rejects(openStandingHistoryAnalysisStep({ ...f.args, intent: missingIntent }));
  for (const directory of Object.values(f.directories)) assert.deepEqual(await readdir(directory), [f.binding.intent.taskId]);
});

test("close and call cancellation join the actual outstanding turn before releasing owned stores", async t => {
  for (const stop of ["close", "call-abort"] as const) {
    const f = await fixture(t), step = await opened(f, t), native = connection(f, "blocked"), callController = new AbortController();
    let settled = false; const pending = next(step, f, native, "blocked-request", callController.signal).then(value => { settled = true; return value; });
    await native.entered.promise;
    let closed = false; const closing = stop === "close" ? step.close().then(() => { closed = true; }) : undefined;
    if (stop === "call-abort") callController.abort(); await immediate(); assert.equal(settled, false); assert.equal(closed, false); assert.equal(native.counts.aborts, 1);
    native.release.resolve(); const result = await pending; await closing; assert.equal(result.kind, "attempt");
    if (result.kind === "attempt") { assert.equal(result.cancelled, true); assert.equal(result.modelOutcome, "unknown"); }
    assert.equal(native.counts.closed, 1); await step.close(); const saved = await readback(f); assert.equal(saved.attempts.last?.modelOutcome, "unknown");
  }
});

test("getter/proxy inputs and callbacks are refused before admission without executing them", async t => {
  const f = await fixture(t); let getters = 0;
  await assert.rejects(openStandingHistoryAnalysisStep({ ...f.args, get directories() { getters++; return f.directories; } }));
  const step = await opened(f, t), native = connection(f);
  await assert.rejects(async () => step.next({ requestRef: "request", signal: f.controller.signal, get connection() { getters++; return native.value; } }));
  await assert.rejects(async () => step.next({ requestRef: "request", signal: f.controller.signal, connection: new Proxy(native.value, { getOwnPropertyDescriptor() { getters++; throw Error("trap"); } }) }));
  assert.equal(getters, 0); assert.equal(native.counts.acquired, 0); assert.equal((await readback(f)).attempts.attempts, 0);
});

test("malformed acquired native binding still joins and closes its lease without reserving or invoking a turn", async t => {
  const f = await fixture(t), step = await opened(f, t), native = connection(f);
  const malformed: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(requestRef) {
    native.counts.acquired++;
    return { nativeBinding: { epochId: "invalid-epoch-id", requestRef, purpose: "history-analysis" },
      async turnAnalysis() { native.counts.turns++; throw Error("malformed lease must not start a turn"); },
      async releaseAnalysis() { native.counts.released++; }, async abortAndJoin() { native.counts.aborts++; }, async close() { native.counts.closed++; } };
  } };
  await assert.rejects(next(step, f, { ...native, value: malformed }));
  assert.deepEqual(native.counts, { acquired: 1, turns: 0, released: 0, aborts: 1, closed: 1 });
  assert.equal((await readback(f)).attempts.attempts, 0);
});

for (const validMethod of ["abortAndJoin", "close"] as const) {
  test(`malformed acquired lease joins its valid ${validMethod} even when the other cleanup is invalid or an accessor`, async t => {
    for (const malformedKind of ["value", "getter"] as const) {
      const f = await fixture(t), step = await opened(f, t), native = connection(f), entered = deferred(), release = deferred();
      let getters = 0, cleanupCalls = 0, settled = false;
      const invalidMethod = validMethod === "abortAndJoin" ? "close" : "abortAndJoin";
      const malformed: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(requestRef) {
        native.counts.acquired++;
        const raw = { nativeBinding: { epochId: "a".repeat(32), requestRef, purpose: "history-analysis" },
          async turnAnalysis() { native.counts.turns++; throw Error("malformed lease must not start a turn"); },
          async releaseAnalysis() { native.counts.released++; },
          async [validMethod]() { cleanupCalls++; entered.resolve(); await release.promise; } };
        Object.defineProperty(raw, invalidMethod, malformedKind === "getter"
          ? { enumerable: true, get() { getters++; throw Error("cleanup accessor must remain inert"); } }
          : { enumerable: true, value: 17 });
        return raw as never;
      } };
      const pending = next(step, f, { ...native, value: malformed }).then(
        () => { settled = true; return "unexpected-success"; },
        () => { settled = true; return "rejected"; });
      try {
        await Promise.race([entered.promise, pending]);
        assert.equal(cleanupCalls, 1); await immediate(); assert.equal(settled, false);
        assert.equal(getters, 0); assert.equal(native.counts.turns, 0); assert.equal(native.counts.released, 0);
      } finally { release.resolve(); }
      assert.equal(await pending, "rejected");
      await step.close(); assert.equal(cleanupCalls, 1); assert.equal(getters, 0);
      const saved = await readback(f); assert.equal(saved.attempts.attempts, 0); assert.equal(saved.analysis.analysisNodes, 0);
      assert.deepEqual(await readdir(join(f.directories.attempts, f.binding.intent.taskId)), ["intent.enc"]);
    }
  });
}
