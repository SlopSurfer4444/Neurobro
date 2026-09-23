import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisOutput } from "../src/standing-history-analysis-store.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { projectMergeView } from "../src/standing-history-analysis-view.js";
import { openStandingHistoryParallelWorkStore, type StandingHistoryParallelWorkPlan } from "../src/standing-history-parallel-work-store.js";
import type { StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";

import { createStandingHistoryParallelMaintenance, resolveStandingHistoryParallelMaintenance, hashStandingHistoryParallelMaintenanceJournal } from "../src/standing-history-parallel-maintenance.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "7".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Synthetic private parallel history" };
function page(before: SelfHistoryTaskCheckpoint): SelfHistoryTaskPage {
  const messageId = (before.offsetId || 1000) - 1, date = before.lastDate - 1, ref = "m_" + messageId.toString(16).padStart(24, "0");
  const next = { ...before, offsetId: messageId, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date,
    pages: before.pages + 1, upperBoundMessageId: before.upperBoundMessageId ?? messageId };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: [{ messageId, date, disposition: "included", messageRef: ref, authorId: "456" }],
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: [{ ref, authorRef: "a_" + "3".repeat(24), author: "user", displayName: "Synthetic private speaker", date, editedAt: null,
        replyRef: null, replyUnavailable: false, text: "Synthetic private source " + messageId }], cursor: null, hasMore: true, status: "more",
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: false, undatedEntries: 0, pages: next.pages },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
const binding = (i: number): StandingHistoryAnalysisNativeBinding => ({ epochId: "1".repeat(32), requestRef: "parallel-request-" + i, purpose: "history-analysis" });
const settled = async (nativeBinding: StandingHistoryAnalysisNativeBinding) => ({ schema: "standing-analysis-owner-settlement-v1", nativeBinding,
  resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-parallel-maintenance-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-parallel-maintenance-"))); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, "work"), pagesDirectory = join(root, "pages"), analysisDirectory = join(root, "analysis");
  for (const path of [directory, pagesDirectory, analysisDirectory]) await mkdir(path);
  const shared = { passphrase: "synthetic-parallel-work-passphrase", intent };
  const source = await openStandingHistoryTaskStore({ ...shared, directory: pagesDirectory, mode: "create" }); t.after(() => source.close());
  for (let i = 0; i < 4; i++) { const before = (await source.status()).readProgress.checkpoint; await source.appendPage({ expectedCheckpoint: before, result: page(before) }); }
  const analysis = await openStandingHistoryAnalysisStore({ ...shared, directory: analysisDirectory, readSourcePage: index => source.readPage(index), mode: "create" }); t.after(() => analysis.close());
  const args = { ...shared, directory, source, analysis };
  const openStore = async (mode: "open" | "create" = "create", customAnalysis = analysis) => { const store = await openStandingHistoryParallelWorkStore({ ...args, analysis: customAnalysis, mode }); t.after(() => store.close()); return store; };
  async function leaf(pageIndex: number, requestIndex = pageIndex) {
    const storedPage = (await source.readPage(pageIndex))!, sourceHead = (await source.status()).readProgress.chainHash, expectedHead = (await analysis.status()).headHash;
    const fragment = projectStandingHistorySource({ intent, referenceKey: analysis.referenceKey(), storedPage, maxBytes: 49152, maxRows: 100 });
    const inputs = [{ pageIndex, maxBytes: 49152, maxRows: 100, materialRef: fragment.materialRef }] as const;
    const { modelInputHash } = prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead, inputs, material: fragment });
    const plan: StandingHistoryParallelWorkPlan = { kind: "leaf", inputs, modelInputHash, nativeBinding: binding(requestIndex) };
    const shownSupports = fragment.rows.map(row => ({ sourceRef: row.sourceRef, versionRef: row.versionRef }));
    const output: StandingHistoryAnalysisOutput = { summary: "Synthetic private summary " + pageIndex, claims: [{ kind: "reported", text: "Synthetic private claim " + pageIndex, supports: shownSupports }] };
    return { plan, output, shownSupports, sourceHead, expectedHead };
  }
  return { ...args, root, slot: join(directory, intent.taskId), openStore, leaf };
}
async function files(directory: string) { return Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), "utf8")])); }


async function maintenance(t: TestContext) {
  const f = await fixture(t), store = await f.openStore();
  const directory = join(f.root, "maintenance"), controlDirectory = join(f.root, "control");
  await mkdir(directory); await mkdir(controlDirectory);
  const control = await openStandingHistoryTaskControlStore({ directory: controlDirectory, intent, passphrase: f.passphrase, mode: "create" });
  t.after(() => control.close());
  const a = await f.leaf(1), b = await f.leaf(2);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] });
  const input = { directory, originalJournalDirectory: f.directory, intent, passphrase: f.passphrase, signal: new AbortController().signal,
    directories: { pages: join(f.root, "pages"), control: controlDirectory, analysis: join(f.root, "analysis") } };
  const authorization = { generationRef: "hmaint_" + "9".repeat(48), requestHash: "2".repeat(64), sourceHead: a.sourceHead,
    analysisHead: a.expectedHead, controlHead: (await control.status()).headHash, originalJournalHash: await hashStandingHistoryParallelMaintenanceJournal(input) };
  let calls = 0;
  const verifyOwnerSettled = async (nativeBinding: StandingHistoryAnalysisNativeBinding) => {
    calls++; return { nativeBinding, windowsBeforeAbsent: true as const, guestAbsent: true as const,
      windowsAfterAbsent: true as const, exclusiveCustody: true as const, receiptHash: "3".repeat(64) };
  };
  return { f, store, a, wave, control, input, authorization, verifyOwnerSettled, calls: () => calls };
}

test("absent maintenance selection is read only and cannot create a generation", async t => {
  const x = await maintenance(t); const before = await files(x.f.slot);
  assert.equal(await resolveStandingHistoryParallelMaintenance(x.input), undefined);
  assert.deepEqual(await readdir(x.input.directory), []); assert.deepEqual(await files(x.f.slot), before);
});

test("operator generation preserves unknown old wave and saved pages across reopen and legitimate progress", async t => {
  const x = await maintenance(t), old = await files(x.f.slot);
  const journal = await createStandingHistoryParallelMaintenance({ ...x.input, authorization: x.authorization, verifyOwnerSettled: x.verifyOwnerSettled });
  assert.equal(x.calls(), 2); assert.notEqual(journal, x.f.directory);
  assert.deepEqual(await files(x.f.slot), old);
  assert.equal(await resolveStandingHistoryParallelMaintenance(x.input), journal);
  const successor = await openStandingHistoryParallelWorkStore({ directory: journal, intent, passphrase: x.f.passphrase, source: x.f.source, analysis: x.f.analysis, mode: "open" });
  assert.equal((await successor.status()).works, 0);
  // New generation, same retained source/analysis, fresh native request identity.
  const fresh = { ...x.a.plan, nativeBinding: { ...binding(7), epochId: "8".repeat(32) } };
  const w = await successor.reserveWave({ sourceHead: x.a.sourceHead, expectedHead: x.a.expectedHead, works: [fresh] });
  await successor.prepare({ workRef: w.workRefs[0]!, output: x.a.output, shownSupports: x.a.shownSupports });
  await successor.recordModelOutcome({ workRef: w.workRefs[0]!, outcome: "observed" });
  await successor.projectNext({ waveRef: w.waveRef, verifyOwnerSettled: settled }); await successor.close();
  const before = (await x.f.source.status()).readProgress.checkpoint;
  await x.f.source.appendPage({ expectedCheckpoint: before, result: page(before) });
  assert.equal((await x.f.analysis.status()).analysisNodes, 1);
  assert.equal(await resolveStandingHistoryParallelMaintenance(x.input), journal);
  assert.deepEqual(await files(x.f.slot), old);
  await assert.rejects(createStandingHistoryParallelMaintenance({ ...x.input, authorization: x.authorization, verifyOwnerSettled: x.verifyOwnerSettled }));
});

test("head mismatch and nonsettlement cannot authorize another model generation", async t => {
  const x = await maintenance(t);
  await assert.rejects(createStandingHistoryParallelMaintenance({ ...x.input, authorization: { ...x.authorization, analysisHead: "0".repeat(64) }, verifyOwnerSettled: x.verifyOwnerSettled }), /BINDING/);
  assert.equal(x.calls(), 0);
  await assert.rejects(createStandingHistoryParallelMaintenance({ ...x.input, authorization: x.authorization, verifyOwnerSettled: async b => ({ ...await x.verifyOwnerSettled(b), guestAbsent: false as unknown as true }) }), /SETTLEMENT/);
  assert.deepEqual(await readdir(x.input.directory), []);
});

test("a single prepared work among unknown peers forbids maintenance generation", async t => {
  const x = await maintenance(t);
  await x.store.prepare({ workRef: x.wave.workRefs[0]!, output: x.a.output, shownSupports: x.a.shownSupports });
  await assert.rejects(createStandingHistoryParallelMaintenance({ ...x.input, authorization: x.authorization, verifyOwnerSettled: x.verifyOwnerSettled }), /BINDING/);
  assert.deepEqual(await readdir(x.input.directory), []);
});

test("tampered original journal fails closed instead of returning original or successor", async t => {
  const x = await maintenance(t);
  await createStandingHistoryParallelMaintenance({ ...x.input, authorization: x.authorization, verifyOwnerSettled: x.verifyOwnerSettled });
  await writeFile(join(x.f.slot, "event-999999.enc"), "not an authenticated record");
  await assert.rejects(resolveStandingHistoryParallelMaintenance(x.input), /BINDING/);
});

test("missing activation fails closed; different runtime store roots cannot adopt authorization", async t => {
  const x = await maintenance(t);
  await createStandingHistoryParallelMaintenance({ ...x.input, authorization: x.authorization, verifyOwnerSettled: x.verifyOwnerSettled });
  await assert.rejects(resolveStandingHistoryParallelMaintenance({ ...x.input, directories: { ...x.input.directories, pages: join(x.f.root, "other-pages") } }), /BINDING/);
  const activation = join(x.input.directory, intent.taskId, "activation.enc"); await rm(activation);
  await assert.rejects(resolveStandingHistoryParallelMaintenance(x.input), /STORAGE/);
});

test("mutation of a retained page after activation is refused", async t => {
  const x = await maintenance(t);
  await createStandingHistoryParallelMaintenance({ ...x.input, authorization: x.authorization, verifyOwnerSettled: x.verifyOwnerSettled });
  const slot = join(x.input.directories.pages, intent.taskId);
  const filename = (await readdir(slot)).find(n => n !== "intent.enc")!;
  await writeFile(join(slot, filename), "changed baseline");
  await assert.rejects(resolveStandingHistoryParallelMaintenance(x.input), /BINDING/);
});
