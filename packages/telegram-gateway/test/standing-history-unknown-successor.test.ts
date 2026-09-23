import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import { openStandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { openStandingHistoryParallelWorkStore, type StandingHistoryParallelWorkPlan } from "../src/standing-history-parallel-work-store.js";
import { createStandingHistoryParallelMaintenance, hashStandingHistoryParallelMaintenanceJournal, resolveStandingHistoryParallelMaintenance } from "../src/standing-history-parallel-maintenance.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { openStandingHistoryTaskRunner, type StandingHistoryTaskRunner, type StandingHistoryTaskRunnerInput, type StandingHistoryTaskWork } from "../src/standing-history-task-runner.js";
import type { StandingHistoryParallelStepGroup } from "../src/standing-history-analysis-step.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import { readStandingHistoryTaskDisposition, recordStandingHistoryTaskDisposition } from "../src/standing-history-task-disposition.js";
import { runStandingHistoryTaskDelivery } from "../src/standing-history-task-delivery.js";
import type { PilotSend } from "../src/pilot-outbox.js";

function page(before: SelfHistoryTaskCheckpoint, empty: boolean): SelfHistoryTaskPage {
  const id = (before.offsetId || 1000) - 1, date = before.lastDate - 1, ref = "m_" + id.toString(16).padStart(24, "0");
  const next = empty ? { ...before, pages: before.pages + 1, status: "empty-page" as const } :
    { ...before, pages: before.pages + 1, offsetId: id, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date, upperBoundMessageId: before.upperBoundMessageId ?? id };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: empty ? [] : [{ messageId: id, date, disposition: "included", messageRef: ref, authorId: "456" }], page: {
    schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
    messages: empty ? [] : [{ ref, authorRef: "a_" + "4".repeat(24), author: "user", displayName: "Synthetic speaker", date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Synthetic source " + id }],
    cursor: null, hasMore: !empty, status: empty ? "empty-page" : "more", coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: empty, undatedEntries: 0, pages: next.pages },
    excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
const proof = (nativeBinding: StandingHistoryAnalysisNativeBinding) => ({ schema: "standing-analysis-owner-settlement-v1", nativeBinding,
  resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" } as const);
async function hashes(directory: string) {
  return Promise.all((await readdir(directory)).sort().map(async name => [name, createHash("sha256").update(await readFile(join(directory, name))).digest("hex")]));
}
async function until(runner: StandingHistoryTaskRunner, predicate: (work: StandingHistoryTaskWork) => boolean) {
  let last: StandingHistoryTaskWork | undefined;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { last = await runner.poll(); if (predicate(last)) return last; await delay(5); }
  return assert.fail("runner did not reach expected durable state: " + JSON.stringify(last));
}
const analysisResult = (work: StandingHistoryTaskWork) => work.kind === "background" && work.outcome.kind === "analysis";
const readyResult = (work: StandingHistoryTaskWork) => work.kind === "background" && work.outcome.kind === "ready";

async function fixture(t: TestContext, firstOutcome: "unknown" | "missing" = "unknown") {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-unknown-successor-"));
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts"), disposition: join(root, "disposition"), delivery: join(root, "delivery") };
  const originalDirectory = join(root, "parallel"), maintenanceDirectory = join(root, "maintenance");
  for (const directory of [...Object.values(directories), originalDirectory, maintenanceDirectory]) await mkdir(directory);
  const passphrase = "synthetic-unknown-successor-passphrase", binding = { accountId: "123", peerId: "-100456" }, controller = new AbortController();
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "a".repeat(48), accountId: binding.accountId, chatId: binding.peerId,
    requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "UTC", objective: "Synthetic complete source analysis" };
  async function stores(mode: "create" | "open" = "open") {
    const common = { intent, passphrase, mode };
    const source = await openStandingHistoryTaskStore({ ...common, directory: directories.pages });
    const control = await openStandingHistoryTaskControlStore({ ...common, directory: directories.control });
    const analysis = await openStandingHistoryAnalysisStore({ ...common, directory: directories.analysis, readSourcePage: index => source.readPage(index) });
    const attempts = await openStandingHistoryAnalysisAttemptStore({ ...common, directory: directories.attempts, analysis });
    return { source, control, analysis, attempts, async close() { await attempts.close(); await analysis.close(); await control.close(); await source.close(); } };
  }
  const saved = await stores("create");
  let journalDirectory: string, failedRef: string, siblingRef: string;
  const maintenanceInput = { directory: maintenanceDirectory, originalJournalDirectory: originalDirectory, directories: { pages: directories.pages, control: directories.control, analysis: directories.analysis }, intent, passphrase, signal: controller.signal };
  try {
    for (let i = 1; i <= 3; i++) { const before = (await saved.source.status()).readProgress.checkpoint; await saved.source.appendPage({ expectedCheckpoint: before, result: page(before, i === 3) }); }
    const sourceHead = (await saved.source.status()).readProgress.chainHash, expectedHead = (await saved.analysis.status()).headHash;
    const plans: StandingHistoryParallelWorkPlan[] = [];
    for (const pageIndex of [1, 2]) {
      const material = projectStandingHistorySource({ intent, referenceKey: saved.analysis.referenceKey(), storedPage: (await saved.source.readPage(pageIndex))!, maxBytes: 49152 });
      const inputs = [{ pageIndex, maxBytes: 49152, materialRef: material.materialRef }] as const;
      plans.push({ kind: "leaf", inputs, modelInputHash: prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead, inputs, material }).modelInputHash,
        nativeBinding: { epochId: "b".repeat(32), requestRef: "original-" + pageIndex, purpose: "history-analysis" } });
    }
    const original = await openStandingHistoryParallelWorkStore({ directory: originalDirectory, intent, passphrase, mode: "create", source: saved.source, analysis: saved.analysis });
    try { await original.reserveWave({ sourceHead, expectedHead, works: plans }); } finally { await original.close(); }
    journalDirectory = await createStandingHistoryParallelMaintenance({ ...maintenanceInput,
      authorization: { generationRef: "hmaint_" + "9".repeat(48), requestHash: "1".repeat(64), sourceHead, analysisHead: expectedHead, controlHead: (await saved.control.status()).headHash,
        originalJournalHash: await hashStandingHistoryParallelMaintenanceJournal({ originalJournalDirectory: originalDirectory, intent, signal: controller.signal }) },
      async verifyOwnerSettled(nativeBinding) { return { nativeBinding, windowsBeforeAbsent: true, guestAbsent: true, windowsAfterAbsent: true, exclusiveCustody: true, receiptHash: "2".repeat(64) }; } });
    assert.equal(await resolveStandingHistoryParallelMaintenance(maintenanceInput), journalDirectory);
    const journal = await openStandingHistoryParallelWorkStore({ directory: journalDirectory, intent, passphrase, mode: "open", source: saved.source, analysis: saved.analysis });
    try {
      const wave = await journal.reserveWave({ sourceHead, expectedHead, works: plans.map((plan, index) => ({ ...plan, nativeBinding: { ...plan.nativeBinding, epochId: "c".repeat(32), requestRef: "maintenance-" + index } })) });
      [failedRef, siblingRef] = wave.workRefs as [string, string];
      if (firstOutcome === "unknown") await journal.recordModelOutcome({ workRef: failedRef, outcome: "unknown" });
      await journal.prepare({ workRef: siblingRef, output: { summary: "Preserved prepared sibling", claims: [] }, shownSupports: [] });
      await journal.recordModelOutcome({ workRef: siblingRef, outcome: "observed" });
    } finally { await journal.close(); }
  } finally { await saved.close(); }
  const baseline = { original: await hashes(join(originalDirectory, intent.taskId)), maintenance: await hashes(join(journalDirectory, intent.taskId)), source: await hashes(join(directories.pages, intent.taskId)) };
  let runner: StandingHistoryTaskRunner | undefined, mode: "commit" | "unknown" = "commit", epoch = "d".repeat(32), allowSettlement = true;
  const admissions: StandingHistoryAnalysisNativeBinding[] = [], settlements: StandingHistoryAnalysisNativeBinding[] = [], executed: { workRef: string; binding: StandingHistoryAnalysisNativeBinding }[] = [];
  const workRefs = new Map<string, string>(), released = new Set<string>(), counts = { turns: 0, reads: 0, groupAborted: 0, groupClosed: 0 };
  const manager = await openStandingHistoryTaskManager({ directories, passphrase, binding, signal: controller.signal, async onCancelled({ taskRef }) { await runner?.revoke(taskRef); } });
  const args: StandingHistoryTaskRunnerInput = { directories, passphrase, binding, signal: controller.signal, manager, concurrentAnalysis: true,
    parallel: { directory: originalDirectory, maintenanceDirectory, maxLeaves: 2 },
    adapter: { async pollWork() { return { kind: "idle", ticket: { openTaskReply() { throw Error("No external send"); }, openHistoryTask() { counts.reads++; throw Error("No external read"); } } }; } },
    async verifyOwnerSettled(nativeBinding) { settlements.push(nativeBinding); if (!allowSettlement) throw Object.assign(Error("Synthetic owner is not settled"), { code: "PRIOR_OWNER_UNAVAILABLE" }); return proof(nativeBinding); },
    connection: { concurrentAnalysis: true, async prepare() { return { restoration: true }; },
      async acquireAnalysisAdmission(requestRef) {
        const nativeBinding = { epochId: epoch, requestRef, purpose: "history-analysis" as const }; admissions.push(nativeBinding);
        return { nativeBinding, async turnAnalysis(req, _input, tools) {
          counts.turns++; const call = { requestRef: req, callRef: "material", signal: controller.signal };
          const result = await tools.analysisTools[0]!.call({}, call) as EpochToolResult; assert.equal(result.success, true);
          tools.onToolResultSent({ requestRef: req, callRef: "material", name: "neurobro_analysis_material", result });
          const committed = await tools.analysisTools[2]!.call({ output: { summary: "Complete synthetic root", claims: [] } }, { ...call, callRef: "commit" }) as EpochToolResult; assert.equal(committed.success, true);
          return { kind: "analysis", scope: { ...nativeBinding, threadId: "synthetic", turnId: "turn", turnNumber: 1, threadTurnNumber: 1 }, answer: "Saved", toolCalls: 2, toolRefusals: 0 };
        }, async releaseAnalysis() {}, async abortAndJoin() {}, async close() {} };
      },
      async acquireParallelAnalysisAdmissions(refs): Promise<StandingHistoryParallelStepGroup> {
        assert.equal(refs.length, 1, "only the failed ordinal may receive a successor admission");
        return { leases: refs.map(requestRef => {
          const nativeBinding = { epochId: epoch, requestRef, purpose: "history-analysis" as const }; admissions.push(nativeBinding);
          return { workerId: "synthetic-worker", nativeBinding, async turnAnalysis(req, _input, tools) {
            counts.turns++; executed.push({ workRef: tools.work.workRef, binding: nativeBinding });
            workRefs.set(req, tools.work.workRef);
            if (mode === "unknown") throw Error("Synthetic native result lost");
            const call = { requestRef: req, callRef: "material", signal: controller.signal };
            const result = await tools.analysisTools[0]!.call({}, call) as EpochToolResult; assert.equal(result.success, true);
            tools.onToolResultSent({ requestRef: req, callRef: "material", name: "neurobro_analysis_material", result });
            const committed = await tools.analysisTools[2]!.call({ output: { summary: "Recovered failed ordinal", claims: [] } }, { ...call, callRef: "commit" }) as EpochToolResult; assert.equal(committed.success, true);
            return { kind: "analysis", workerId: "synthetic-worker", scope: { ...nativeBinding, threadId: "synthetic", turnId: "turn", turnNumber: 1, threadTurnNumber: 1 }, answer: "Saved", toolCalls: 2, toolRefusals: 0 };
          }, async releaseAnalysis(req) { assert.equal(req, requestRef); released.add(req); } };
        }), async abortAndJoin() { counts.groupAborted++; }, async close() { counts.groupClosed++; } };
      },
      async verifyAnalysisWorkReleased(nativeBinding, workRef) { assert.equal(released.has(nativeBinding.requestRef), true); assert.equal(workRefs.get(nativeBinding.requestRef), workRef); return { schema: "standing-analysis-work-release-v1", nativeBinding, workRef, releaseAcknowledged: true, callbacksJoined: true }; }
    } };
  t.after(async () => { await runner?.close(); await manager.close(); assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-unknown-successor-"))); await rm(root, { recursive: true, force: true }); });
  async function start() { runner = await openStandingHistoryTaskRunner(args); return runner; }
  async function journal() { const s = await stores(); const j = await openStandingHistoryParallelWorkStore({ directory: journalDirectory, intent, passphrase, mode: "open", source: s.source, analysis: s.analysis }); return { s, j, async close() { await j.close(); await s.close(); } }; }
  async function preserved() {
    assert.deepEqual(await hashes(join(originalDirectory, intent.taskId)), baseline.original);
    const current = new Map((await hashes(join(journalDirectory, intent.taskId))).map(([name, hash]) => [name!, hash!]));
    for (const [name, hash] of baseline.maintenance) assert.equal(current.get(name!), hash);
    assert.deepEqual(await hashes(join(directories.pages, intent.taskId)), baseline.source);
  }
  return { args, intent, stores, start, journal, preserved, failedRef, siblingRef, admissions, settlements, executed, counts,
    epoch(value: string) { epoch = value.repeat(32); }, mode(value: typeof mode) { mode = value; }, settlement(value: boolean) { allowSettlement = value; } };
}

test("cold maintenance runner replaces only UNKNOWN ordinal and preserves sibling through full root and verified delivery", async t => {
  const f = await fixture(t), runner = await f.start();
  await until(runner, analysisResult); await runner.close();
  assert.equal(f.executed.length, 1); assert.notEqual(f.executed[0]!.workRef, f.failedRef); assert.notEqual(f.executed[0]!.workRef, f.siblingRef);
  assert.equal(f.executed[0]!.binding.epochId, "d".repeat(32)); assert.notEqual(f.executed[0]!.binding.requestRef, "maintenance-0");
  assert.ok(f.settlements.some(value => value.epochId === "c".repeat(32) && value.requestRef === "maintenance-0"));
  await f.preserved();
  const saved = await f.journal();
  try {
    const old = await saved.j.readWork(f.failedRef), sibling = await saved.j.readWork(f.siblingRef), replacement = await saved.j.readWork(f.executed[0]!.workRef);
    assert.equal(old.modelOutcome, "unknown"); assert.equal(old.output, undefined); assert.equal(old.node, undefined);
    assert.equal(sibling.modelOutcome, "observed"); assert.equal(sibling.output?.summary, "Preserved prepared sibling");
    assert.equal(replacement.ordinal, old.ordinal); assert.deepEqual(replacement.plan.kind === "leaf" && replacement.plan.inputs, old.plan.kind === "leaf" && old.plan.inputs);
  } finally { await saved.close(); }
  f.epoch("e"); const cold = await f.start(), ready = await until(cold, readyResult);
  assert.ok(ready.kind === "background" && ready.outcome.kind === "ready");
  assert.equal(ready.outcome.result.coverage.coveredRows, 2); assert.equal(ready.outcome.result.coverage.sourceRows, 2);
  assert.equal(ready.outcome.result.coverage.coveredPages, 3); assert.equal(ready.outcome.result.coverage.readTraversalComplete, true);
  assert.equal(f.counts.reads, 0); await f.preserved(); await cold.close();
  let sent: PilotSend | undefined;
  const delivered = await runStandingHistoryTaskDelivery({ intent: f.intent, readiness: ready.outcome.result,
    directories: { pages: f.args.directories.pages, control: f.args.directories.control, analysis: f.args.directories.analysis, attempts: f.args.directories.attempts, delivery: f.args.directories.delivery! },
    passphrase: f.args.passphrase, signal: f.args.signal,
    finalReport: { schema: "standing-history-final-report-v1", taskRef: f.intent.taskId, sourceHead: ready.outcome.result.sourceHead, analysisHead: ready.outcome.result.expectedHead, body: "Synthetic report from the recovered complete root." },
    async verifyOwnerReady(nativeBinding) { return { schema: "standing-analysis-owner-ready-v1", nativeBinding, basis: "released-current-owner", modelOutcome: "not-proven" }; },
    ticket: { openTaskReply() { return { transport: { async sendOnce(reply) { sent = reply; return { messageId: 2001 }; }, async readExact(chatId, messageId) { assert.ok(sent); return { chatId, messageId, accountId: f.intent.accountId, replyToMessageId: sent.replyToMessageId, text: sent.text }; } }, async close() {} }; } } });
  assert.equal(delivered.result.state, "verified"); assert.equal(delivered.deliveryComplete, true);
  const before = f.admissions.length, terminal = await f.start();
  for (let i = 0; i < 2; i++) await until(terminal, value => value.kind === "background" && value.outcome.kind === "delivery-state");
  assert.equal(f.admissions.length, before); await f.preserved();
});

test("mixed missing and UNKNOWN parallel attempts debit the same cap across cold runners", async t => {
  const f = await fixture(t, "missing"); f.mode("unknown");
  for (const epoch of ["d", "e"]) {
    f.epoch(epoch); const runner = await f.start(); await until(runner, analysisResult); await runner.close(); await f.preserved();
  }
  assert.equal(f.executed.length, 2);
  const stored = await f.journal();
  try { assert.equal((await stored.j.readWork(f.failedRef)).modelOutcome, undefined); assert.equal((await stored.j.readWork(f.executed.at(-1)!.workRef)).consecutiveNoOutput, 3); }
  finally { await stored.close(); }
  f.epoch("f"); f.mode("commit"); const runner = await f.start();
  await until(runner, value => value.kind === "background" && (value.outcome.kind === "task-blocked" || value.outcome.kind === "stalled"));
  await runner.close(); const again = await f.start();
  await until(again, value => value.kind === "background" && (value.outcome.kind === "task-blocked" || value.outcome.kind === "stalled"));
  assert.equal(f.executed.length, 2); assert.equal(f.admissions.length, 2); await f.preserved();
});

test("an unsettled old owner cannot authorize UNKNOWN successor dispatch or reservation", async t => {
  const f = await fixture(t); f.settlement(false); const runner = await f.start();
  await until(runner, value => value.kind === "background" && (value.outcome.kind === "task-blocked" || value.outcome.kind === "stalled"));
  assert.equal(f.counts.groupAborted, 1); assert.equal(f.counts.groupClosed, 1);
  assert.equal(f.counts.turns, 0); const stored = await f.journal();
  try { assert.equal((await stored.j.status()).works, 2); } finally { await stored.close(); }
  await f.preserved();
});

test("terminal coverage disposition prevents an otherwise recoverable maintenance wave from resurrecting", async t => {
  const f = await fixture(t), s = await f.stores();
  try { await recordStandingHistoryTaskDisposition({ directory: f.args.directories.disposition!, intent: f.intent, passphrase: f.args.passphrase,
    sourceHead: (await s.source.status()).readProgress.chainHash, analysisHead: (await s.analysis.status()).headHash, reason: "coverage" }); }
  finally { await s.close(); }
  for (let i = 0; i < 2; i++) { const runner = await f.start(); await until(runner, value => value.kind === "background" && value.outcome.kind === "task-blocked"); await runner.close(); }
  assert.equal(f.admissions.length, 0); assert.equal(f.counts.turns, 0); await f.preserved();
});

test("stale disposition requires explicit preserved operator archive before cold maintenance reentry", async t => {
  const f = await fixture(t), stores = await f.stores();
  const heads = { sourceHead: (await stores.source.status()).readProgress.chainHash, analysisHead: (await stores.analysis.status()).headHash };
  await stores.close();
  const disposition = { directory: f.args.directories.disposition!, intent: f.intent, passphrase: f.args.passphrase, ...heads };
  await recordStandingHistoryTaskDisposition({ ...disposition, reason: "stale" });
  const activeSlot = join(disposition.directory, f.intent.taskId), originalNames = (await readdir(activeSlot)).sort();
  const receiptNames = originalNames.filter(name => /^heads-[a-f0-9]{64}\.enc$/u.test(name));
  assert.equal(receiptNames.length, 1); assert.equal(originalNames.length, 2);
  const receiptPath = join(activeSlot, receiptNames[0]!), receiptBytes = await readFile(receiptPath);
  const headerPath = join(activeSlot, "intent.enc"), headerBytes = await readFile(headerPath);
  const blocked = await f.start();
  for (let i = 0; i < 2; i++) {
    const result = await until(blocked, value => value.kind === "background" && value.outcome.kind === "task-blocked");
    assert.deepEqual(result, { kind: "background", outcome: { kind: "task-blocked", taskRef: f.intent.taskId, reason: "stale" } });
  }
  assert.equal(f.admissions.length, 0); assert.equal(f.counts.turns, 0);
  assert.deepEqual(await readFile(receiptPath), receiptBytes); await f.preserved();
  await blocked.close();

  // This explicit fixture-only operator action happens with the runner closed.
  // Production discovery must never remove or bypass its stale disposition.
  const fixtureRoot = await realpath(resolve(f.args.directories.pages, ".."));
  assert.ok(fixtureRoot.startsWith(join(resolve(tmpdir()), "neurobro-unknown-successor-")));
  const archiveDirectory = join(fixtureRoot, "operator-preserved"); await mkdir(archiveDirectory);
  const source = await realpath(receiptPath), archive = join(await realpath(archiveDirectory), receiptNames[0]!);
  for (const target of [source, archive]) {
    const within = relative(fixtureRoot, target);
    assert.ok(within && !isAbsolute(within) && within !== ".." && !within.startsWith(".." + sep));
  }
  assert.equal(relative(await realpath(activeSlot), archive).startsWith(".." + sep), true);
  await rename(source, archive);
  assert.deepEqual(await readFile(archive), receiptBytes);
  assert.deepEqual(await readdir(activeSlot), ["intent.enc"]);
  assert.deepEqual(await readFile(headerPath), headerBytes);
  assert.deepEqual(await readStandingHistoryTaskDisposition(disposition), { storage: "absent" });

  f.epoch("e"); const cold = await f.start(), ready = await until(cold, readyResult);
  assert.ok(ready.kind === "background" && ready.outcome.kind === "ready");
  assert.equal(ready.outcome.result.coverage.coveredRows, 2); assert.equal(ready.outcome.result.coverage.sourceRows, 2);
  assert.equal(ready.outcome.result.coverage.coveredPages, 3); assert.equal(ready.outcome.result.coverage.readTraversalComplete, true);
  assert.equal(f.executed.length, 1); assert.notEqual(f.executed[0]!.workRef, f.failedRef); assert.notEqual(f.executed[0]!.workRef, f.siblingRef);
  assert.equal(f.executed[0]!.binding.epochId, "e".repeat(32)); assert.notEqual(f.executed[0]!.binding.requestRef, "maintenance-0");
  assert.equal(f.counts.reads, 0); await cold.close();
  const saved = await f.journal();
  try {
    const original = await saved.j.readWork(f.failedRef), sibling = await saved.j.readWork(f.siblingRef);
    assert.equal(original.modelOutcome, "unknown"); assert.equal(original.output, undefined); assert.equal(original.node, undefined);
    assert.equal(sibling.modelOutcome, "observed"); assert.equal(sibling.output?.summary, "Preserved prepared sibling"); assert.ok(sibling.node);
  } finally { await saved.close(); }
  await f.preserved(); assert.deepEqual(await readFile(archive), receiptBytes); assert.deepEqual(await readFile(headerPath), headerBytes);
});
