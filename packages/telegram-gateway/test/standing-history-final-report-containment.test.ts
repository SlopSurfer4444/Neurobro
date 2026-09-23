import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { openStandingHistoryFinalReportStore } from "../src/standing-history-final-report-store.js";
import { standingHistoryReportBodyHash, REPORT_REVIEW_SERIALIZED_BYTES } from "../src/standing-history-report-quality.js";
import type { StandingHistoryAnalysisStepConnection } from "../src/standing-history-analysis-step.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import type * as Finalizer from "../src/standing-history-final-report.js";
const nativeBinding: StandingHistoryAnalysisNativeBinding = { epochId: "a".repeat(32), requestRef: "final-report", purpose: "history-analysis" };
async function fixture(t: TestContext, mergeWidth = 1) {
  const outcome = "observed", objective = "Explain complaints and what to do next";
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-finalizer-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-finalizer-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts"), reports: join(root, "reports") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "7".repeat(48), accountId: "123", chatId: "-100456", requesterId: "456", primaryMessageId: 999,
    fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective };
  const passphrase = "synthetic-task-delivery-passphrase", binding = { intent, passphrase }, controller = new AbortController();
  const source = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "create" });
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: directories.control, mode: "create" });
  const analysis = await openStandingHistoryAnalysisStore({ ...binding, directory: directories.analysis, mode: "create", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: directories.attempts, mode: "create", analysis });
  const before = (await source.status()).readProgress.checkpoint;
  const sources = Array.from({ length: mergeWidth }, (_, i) => ({ messageId: 998 - i, date: 1500 - i, disposition: "included" as const,
    messageRef: "m_" + (i + 1).toString(16).padStart(24, "0"), authorId: "456" }));
  const after = { ...before, offsetId: sources.at(-1)!.messageId, lastDate: sources.at(-1)!.date, oldestDate: sources.at(-1)!.date, newestDate: 1500, upperBoundMessageId: 998, pages: 1, status: "lower-bound-reached" as const };
  await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: after,
    sources, page: {
      schema: "neurobro-self-history-v1", fromDate: 1000, toDate: 2000,
      messages: [...sources].reverse().map(s => ({ ref: s.messageRef, authorRef: "a_" + "2".repeat(24), author: "user" as const, displayName: "Synthetic speaker", date: s.date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Private source from disk" })),
      cursor: null, hasMore: false, status: "lower-bound-reached", coverage: { scope: "available-history-snapshot", oldestExaminedDate: after.oldestDate, newestExaminedDate: 1500, traversalComplete: true, undatedEntries: 0, pages: 1 },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } } });
  const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis });
  async function selected() { for (let i = 0; i < 20; i++) { const result = await planner.next(); if (result.kind !== "scan-more") return result; } throw Error("fixture planner did not finish"); }
  if (mergeWidth > 1) {
    const { projectStandingHistorySource } = await import("../src/standing-history-source-projection.js");
    const page = (await source.readPage(1))!, children: string[] = []; let position: string | undefined;
    for (let i = 0; i < mergeWidth; i++) {
      const material = projectStandingHistorySource({ intent, referenceKey: analysis.referenceKey(), storedPage: page, maxBytes: 49152, maxRows: 1, ...(position ? { position } : {}) });
      const leaf = await analysis.appendLeaf({ expectedHead: (await analysis.status()).headHash,
        inputs: [{ pageIndex: 1, materialRef: material.materialRef, maxBytes: 49152, maxRows: 1, ...(position ? { position } : {}) }],
        output: { summary: "Saved child " + i, claims: [] } });
      children.push(leaf.nodeRef); position = material.nextPosition ?? undefined;
    }
    assert.equal(position, undefined);
    await analysis.appendMerge({ expectedHead: (await analysis.status()).headHash, children, output: { summary: "Private root summary", claims: [] } });
  } else {
  const plan = await selected(); assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") throw Error("expected leaf");
  const material = prepareStandingHistoryAnalysisMaterial(plan);
  const reservation = await attempts.reserve({ plan: { kind: "leaf", sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, nodeIndex: 1, inputs: plan.inputs, modelInputHash: material.modelInputHash }, nativeBinding });
  await attempts.prepare({ attemptRef: reservation.attemptRef, output: { summary: "Private root summary", claims: [] } });
  const node = await attempts.commitPrepared({ attemptRef: reservation.attemptRef });
  await attempts.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome });
  }
  const readiness = await selected(); assert.equal(readiness.kind, "analysis-ready"); if (readiness.kind !== "analysis-ready") throw Error("expected ready");
  await planner.close(); await attempts.close(); await analysis.close(); await source.close(); await control.close();

  const args = { ...binding, directories, readiness, signal: controller.signal, requestRef: nativeBinding.requestRef,
    async verifyOwnerSettled(value: StandingHistoryAnalysisNativeBinding) { return { schema: "standing-analysis-owner-settlement-v1" as const, nativeBinding: value, persisted: true as const, resourcesSettled: true as const, replacementReady: true as const, modelOutcome: "not-proven" as const }; } };
  return { args, controller };
}

// Fault injection changes only the material factory and optionally a joined
// store close. The finalizer and encrypted source/report stores remain real.
async function injectedFinalizer(materialFailure: "branded" | "lookalike" | "storage", closeFailure = false) {
  const target = new URL("../src/standing-history-final-report.js?containment=" + randomUUID(), import.meta.url).href;
  const material = new URL("../src/standing-history-final-report-material.js", import.meta.url).href;
  const analysis = new URL("../src/standing-history-analysis-store.js", import.meta.url).href;
  const encode = (source: string) => "data:text/javascript," + encodeURIComponent(source);
  const failingMaterial = encode(`import {StandingHistoryFinalReportMaterialError} from ${JSON.stringify(material)};
    export {StandingHistoryFinalReportMaterialError};
    export async function createStandingHistoryFinalReportMaterial(){throw ${materialFailure === "branded" ? "new StandingHistoryFinalReportMaterialError()" : materialFailure === "lookalike" ? "new Error('STANDING_HISTORY_FINAL_REPORT_MATERIAL_INPUT')" : "Object.assign(new Error('synthetic storage failure'),{code:'EIO'})"};}`);
  const failingClose = encode(`export * from ${JSON.stringify(analysis)};
    import {openStandingHistoryAnalysisStore as actual} from ${JSON.stringify(analysis)};
    export async function openStandingHistoryAnalysisStore(args){const store=await actual(args);return {...store,async close(){await store.close();throw Error('synthetic joined store close failure');}};}`);
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === target && specifier === "./standing-history-final-report-material.js") return { url: failingMaterial, shortCircuit: true };
    if (closeFailure && context.parentURL === target && specifier === "./standing-history-analysis-store.js") return { url: failingClose, shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  try { return await import(target) as typeof Finalizer; } finally { hooks.deregister(); }
}

test("deterministic prelease material refusal stays task-local with only an immutable report intent", async t => {
  const f = await fixture(t), finalizer = await injectedFinalizer("branded"); let admissions = 0;
  const args = { ...f.args, connection: { async acquireAnalysisAdmission(): Promise<never> { admissions++; throw Error("admission forbidden"); } } };
  assert.deepEqual(await finalizer.finalizeStandingHistoryReport(args), { kind: "blocked", reason: "material-unavailable" });
  const slot = join(f.args.directories.reports, f.args.intent.taskId);
  assert.deepEqual(await readdir(slot), ["intent.enc"]); const original = await readFile(join(slot, "intent.enc"));
  assert.deepEqual(await finalizer.finalizeStandingHistoryReport(args), { kind: "blocked", reason: "material-unavailable" });
  assert.equal(admissions, 0); assert.deepEqual(await readFile(join(slot, "intent.enc")), original);
  assert.equal(await finalizer.canContinueStandingHistoryReport({ intent: f.args.intent, passphrase: f.args.passphrase,
    directory: f.args.directories.reports, sourceHead: f.args.readiness.sourceHead, analysisHead: f.args.readiness.expectedHead }), false);
  const store = await openStandingHistoryFinalReportStore({ intent: f.args.intent, passphrase: f.args.passphrase, directory: f.args.directories.reports,
    sourceHead: f.args.readiness.sourceHead, analysisHead: f.args.readiness.expectedHead, rootRef: f.args.readiness.rootRef!, mode: "open" });
  try { const status = await store.status(); assert.equal(status.reserved, false); assert.equal(status.nativeBinding, undefined); } finally { await store.close(); }
});

for (const failure of ["lookalike", "storage"] as const) test(failure + " errors are not hidden by material containment", async t => {
  const f = await fixture(t), finalizer = await injectedFinalizer(failure); let admissions = 0;
  await assert.rejects(finalizer.finalizeStandingHistoryReport({ ...f.args, connection: { async acquireAnalysisAdmission(): Promise<never> { admissions++; throw Error("admission forbidden"); } } }),
    error => error instanceof Error && (failure === "storage" ? (error as NodeJS.ErrnoException).code === "EIO" : error.message === "STANDING_HISTORY_FINAL_REPORT_MATERIAL_INPUT"));
  assert.equal(admissions, 0);
});

test("failed store close overrides task-local material refusal and remains fatal", async t => {
  const f = await fixture(t), finalizer = await injectedFinalizer("branded", true); let admissions = 0;
  await assert.rejects(finalizer.finalizeStandingHistoryReport({ ...f.args, connection: { async acquireAnalysisAdmission(): Promise<never> { admissions++; throw Error("admission forbidden"); } } }),
    error => error instanceof finalizer.StandingHistoryFinalReportError && error.code === "close");
  assert.equal(admissions, 0);
});

test("maximally escaped review survives encrypted stages, revision feedback and cold reopen", async t => {
  const f = await fixture(t), finalizer = await import("../src/standing-history-final-report.js");
  const findings = Array.from({ length: 6 }, () => ({ dimension: "evidence" as const,
    problem: "\u0001".repeat(1023) + "p", correction: "\u0002".repeat(1023) + "c" }));
  const original = "Initial report", revised = "Revised report";
  const review = { candidateHash: standingHistoryReportBodyHash(original), verdict: "revise", findings };
  assert.ok(Buffer.byteLength(JSON.stringify(review)) > 32768);
  assert.ok(Buffer.byteLength(JSON.stringify(review)) <= REPORT_REVIEW_SERIALIZED_BYTES);
  let stages = 0, sawFeedback = false;
  const connection: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(requestRef, previous, options) {
    const stage = ++stages, nativeBinding = { epochId: stage.toString(16).padStart(32, "0"), requestRef, purpose: "history-analysis" as const };
    if (previous) assert.deepEqual(options, { requireNewEpoch: true });
    return { nativeBinding, async turnAnalysis(_ref, body, callbacks) {
      const packet = JSON.parse(body); let calls = 0;
      const tool = async (name: string, args: unknown) => {
        const callRef = "call-" + ++calls;
        const result = await callbacks.analysisTools.find(t => t.name === name)!.call(args, { requestRef, callRef, signal: f.args.signal }) as EpochToolResult;
        callbacks.onToolResultSent({ requestRef, callRef, name, result }); assert.equal(result.success, true); return JSON.parse(result.contentItems[0]!.text);
      };
      const material = await tool("neurobro_analysis_material", {});
      if (stage === 3) { assert.deepEqual(material.feedback, review); assert.ok(Buffer.byteLength(JSON.stringify(material)) > 49152); sawFeedback = true; }
      if (material.candidate) for (let pageIndex = 1; pageIndex <= material.candidate.pages; pageIndex++) await tool("neurobro_analysis_material", { purpose: "final-report-candidate", pageIndex, position: null });
      await tool("neurobro_analysis_commit", packet.kind === "final-report-review"
        ? { reportReview: stage === 2 ? review : { candidateHash: standingHistoryReportBodyHash(revised), verdict: "accepted", findings: [] } }
        : { finalReport: { body: stage === 1 ? original : revised } });
      return { kind: "analysis", scope: { ...nativeBinding, threadId: "thread", turnId: "turn", turnNumber: 1, threadTurnNumber: 1 }, answer: "Saved", toolCalls: calls, toolRefusals: 0 };
    }, async releaseAnalysis() {}, async abortAndJoin() {}, async close() {} };
  } };
  const first = await finalizer.finalizeStandingHistoryReport({ ...f.args, connection });
  assert.equal(first.kind, "ready"); if (first.kind !== "ready") assert.fail(); assert.equal(first.report.body, revised); assert.equal(stages, 4); assert.equal(sawFeedback, true);
  const cold = await finalizer.finalizeStandingHistoryReport({ ...f.args, connection: { async acquireAnalysisAdmission(): Promise<never> { assert.fail("cold report must not acquire a provider"); } } });
  assert.equal(cold.kind, "ready"); if (cold.kind !== "ready") assert.fail(); assert.equal(cold.recovered, true); assert.deepEqual(cold.report, first.report);
});
