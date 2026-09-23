import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import { openStandingHistoryAnalysisStep, type StandingHistoryAnalysisStepConnection, type StandingHistoryAnalysisOwnerSettlement } from "../src/standing-history-analysis-step.js";
import type { StandingHistoryAnalysisRuntimeMaterial } from "../src/standing-history-analysis-runtime.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";

// A single shared corpus gives both packing modes identical source semantics.
// The oracle is deterministic test code, not a language model speed/quality test.
const ROWS = 1200, PAGE_ROWS = 100;
const corpus = Array.from({ length: ROWS }, (_, i) => {
  const prefix = `[ROW${String(i).padStart(4, "0")}] `;
  const text = i % 3 === 0 ? "Short ordinary message." : i % 3 === 1 ? "Detailed report: status and delivery remain unconfirmed. ".repeat(4) :
    'Цитата: "да\\нет" — 東京 😀; строка\n'.repeat(4);
  return prefix + text + (i % 97 === 0 || i === ROWS - 1 ? ` [MARKER${i}]` : "");
});
const expectedIds = corpus.map((_, i) => i);
const expectedMarkers = corpus.flatMap(text => [...text.matchAll(/\[MARKER(\d+)\]/gu)].map(m => Number(m[1])));
const excluded = { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 };
const limitations = ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] as const;

function sourcePage(before: SelfHistoryTaskCheckpoint, start: number): SelfHistoryTaskPage {
  const indices = start < ROWS ? Array.from({ length: Math.min(PAGE_ROWS, ROWS - start) }, (_, i) => start + i) : [];
  const sources = indices.map(i => ({ messageId: 10000 - i, date: 4999 - i, disposition: "included" as const,
    messageRef: "m_" + (10000 - i).toString(16).padStart(24, "0"), authorId: "456" }));
  const last = sources.at(-1), next = { ...before, pages: before.pages + 1,
    ...(last ? { offsetId: last.messageId, lastDate: last.date, oldestDate: last.date, newestDate: before.newestDate ?? sources[0]!.date,
      upperBoundMessageId: before.upperBoundMessageId ?? sources[0]!.messageId } : {}), status: last ? "more" as const : "empty-page" as const };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources,
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: indices.map((i, index) => ({ ref: sources[index]!.messageRef, authorRef: "a_" + "4".repeat(24), author: "user" as const,
        displayName: "Synthetic speaker", date: sources[index]!.date, editedAt: null, replyRef: null, replyUnavailable: false, text: corpus[i]! })).reverse(),
      cursor: null, hasMore: !!last, status: next.status, excluded, limitations,
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate,
        traversalComplete: !last, undatedEntries: 0, pages: next.pages } } };
}
function settled(nativeBinding: StandingHistoryAnalysisNativeBinding): StandingHistoryAnalysisOwnerSettlement {
  return { schema: "standing-analysis-owner-settlement-v1", nativeBinding, resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" };
}
async function inventory(directories: readonly string[]) {
  const result = new Map<string, string>();
  for (const directory of directories) for (const name of await readdir(directory)) {
    const path = join(directory, name); result.set(path, createHash("sha256").update(await readFile(path)).digest("hex"));
  }
  return result;
}
type Summary = { ids: number[]; markers: number[] };
function summary(ids: readonly number[]): Summary {
  const sorted = [...ids].sort((a, b) => a - b);
  assert.equal(new Set(sorted).size, sorted.length, "a leaf or merge must not count any source row twice");
  return { ids: sorted, markers: sorted.filter(i => expectedMarkers.includes(i)) };
}

async function runPacking(t: TestContext, packing: "wide" | "large") {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-large-packets-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-large-packets-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "8".repeat(48), accountId: "123", chatId: "-100456",
    requesterId: "456", primaryMessageId: 12000, fromDate: 1000, toDate: 5000, timezone: "Europe/Moscow",
    objective: "Count every original source row once and preserve distributed marker identities through the full period." };
  const binding = { intent, passphrase: "synthetic-large-history-packets-passphrase" }, controller = new AbortController();
  const source = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "create" });
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: directories.control, mode: "create" });
  const analysis = await openStandingHistoryAnalysisStore({ ...binding, directory: directories.analysis, mode: "create", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: directories.attempts, mode: "create", analysis });
  for (let start = 0; start <= ROWS; start += PAGE_ROWS) {
    const before = (await source.status()).readProgress.checkpoint; await source.appendPage({ expectedCheckpoint: before, result: sourcePage(before, start) });
  }
  await attempts.close(); await analysis.close(); await source.close(); await control.close();
  const args = { ...binding, directories, signal: controller.signal, retainWorkingState: true, verifyOwnerSettled: async (b: StandingHistoryAnalysisNativeBinding) => settled(b) };
  let admissions = 0, leafAdmissions = 0, mergeAdmissions = 0, maxMaterialBytes = 0, maxFragments = 0, readRows = 0, restarts = 0;
  const seenRows = new Set<number>(), materialSizes: number[] = [];
  const connection: StandingHistoryAnalysisStepConnection = {
    async acquireAnalysisAdmission(requestRef) {
      const nativeBinding: StandingHistoryAnalysisNativeBinding = { epochId: (++admissions).toString(16).padStart(32, "0"), requestRef, purpose: "history-analysis" };
      return { nativeBinding, async turnAnalysis(ref, _body, callbacks) {
        let calls = 0;
        const call = async (name: string, input: unknown) => {
          const callRef = "large-test-" + (++calls), tool = callbacks.analysisTools.find(tool => tool.name === name); assert.ok(tool);
          const result = await tool.call(input, { requestRef: ref, callRef, signal: controller.signal }) as EpochToolResult;
          assert.equal(result.success, true, JSON.stringify(result));
          callbacks.onToolResultSent({ requestRef: ref, callRef, name, result });
          assert.equal(result.contentItems.length, 1); assert.equal(result.contentItems[0]!.type, "inputText");
          return result.contentItems[0]!.text;
        };
        const text = await call("neurobro_analysis_material", {}), material = JSON.parse(text) as StandingHistoryAnalysisRuntimeMaterial;
        const bytes = Buffer.byteLength(text); materialSizes.push(bytes); maxMaterialBytes = Math.max(maxMaterialBytes, bytes);
        let ids: number[];
        if (material.schema === "standing-history-merge-view-v1") {
          mergeAdmissions++; ids = [];
          for (const child of material.children) {
            let note = child;
            if (!note.summary.complete) note = JSON.parse(await call("neurobro_analysis_notes", { nodeRef: child.nodeRef, position: null }));
            assert.equal(note.summary.complete, true, "bounded synthetic summaries must remain whole");
            const saved = JSON.parse(note.summary.text) as Summary; assert.deepEqual(saved, summary(saved.ids)); ids.push(...saved.ids);
          }
        } else {
          leafAdmissions++; ids = [];
          const fragments = material.schema === "standing-history-source-fragment-v1" ? [material] : material.fragments;
          maxFragments = Math.max(maxFragments, fragments.length);
          for (const fragment of fragments) for (const row of fragment.rows) {
            assert.equal(row.disposition, "included"); if (row.disposition !== "included") assert.fail();
            const found = /^\[ROW(\d{4})\]/u.exec(row.text); assert.ok(found, "every source row carries a stable identity");
            const id = Number(found[1]); assert.equal(row.text, corpus[id], "Unicode, quotes, escapes and markers must be byte-exact");
            assert.equal(seenRows.has(id), false, "cold restart must not redispatch old source coverage"); seenRows.add(id); readRows++; ids.push(id);
          }
        }
        const committed = JSON.parse(await call("neurobro_analysis_commit", { output: { summary: JSON.stringify(summary(ids)), claims: [] } }));
        assert.equal(committed.committed, true);
        return { kind: "analysis" as const, scope: { ...nativeBinding, threadId: "synthetic-large-thread", turnId: "synthetic-" + admissions,
          turnNumber: admissions, threadTurnNumber: admissions }, answer: "Synthetic accepted node", toolCalls: calls, toolRefusals: 0 };
      }, async releaseAnalysis() {}, async abortAndJoin() {}, async close() {} };
    }
  };
  const started = performance.now();
  // Start both paths with a real legacy-size node before switching the candidate.
  let step = await openStandingHistoryAnalysisStep({ ...args, packing: "wide" });
  let original = new Map<string, string>(), ready: Extract<Awaited<ReturnType<typeof step.next>>, { kind: "analysis-ready" }> | undefined;
  try {
    for (let quantum = 0; quantum < 1500; quantum++) {
      const result = await step.next({ requestRef: "packet-" + quantum, connection, signal: controller.signal });
      if (result.kind === "analysis-ready") { ready = result; break; }
      if (result.kind === "attempt") {
        assert.equal(result.modelOutcome, "observed"); assert.ok(result.node); assert.equal(result.release, "acknowledged");
        if (!restarts) {
          await step.close(); original = await inventory([join(directories.analysis, intent.taskId), join(directories.attempts, intent.taskId)]);
          step = await openStandingHistoryAnalysisStep({ ...args, packing }); restarts++;
        }
      } else assert.equal(result.kind, "scan-more", "complete stored corpus must not ask for live reads or lose progress");
    }
    assert.ok(ready?.rootRef, "bounded offline execution must reach an authenticated root");
    assert.equal(ready.coverage.committedPages, ROWS / PAGE_ROWS + 1); assert.equal(ready.coverage.coveredPages, ROWS / PAGE_ROWS + 1);
    assert.equal(ready.coverage.sourceRows, ROWS); assert.equal(ready.coverage.coveredRows, ROWS); assert.equal(ready.coverage.readTraversalComplete, true);
  } finally { await step.close(); }
  const elapsedMs = Math.round(performance.now() - started), reopenedSource = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "open" });
  const reopenedAnalysis = await openStandingHistoryAnalysisStore({ ...binding, directory: directories.analysis, mode: "open", readSourcePage: i => reopenedSource.readPage(i) });
  try {
    const node = await reopenedAnalysis.readNode(ready!.rootRef!); assert.ok(node); assert.deepEqual(JSON.parse(node.output.summary), summary(expectedIds));
  } finally { await reopenedAnalysis.close(); await reopenedSource.close(); }
  for (const [path, digest] of original) assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), digest, "pre-restart evidence must remain unchanged");
  assert.deepEqual([...seenRows].sort((a, b) => a - b), expectedIds); assert.equal(readRows, ROWS); assert.equal(restarts, 1);
  return { packing, admissions, leafAdmissions, mergeAdmissions, maxMaterialBytes, maxFragments, readRows, restarts, elapsedMs, materialSizes };
}

test("large production packets cross 48KiB through encrypted runtime and reduce admissions without losing legacy coverage", async t => {
  const wide = await runPacking(t, "wide"); t.diagnostic(JSON.stringify({ kind: "offline-baseline-complete", wide }));
  const large = await runPacking(t, "large");
  assert.ok(wide.maxMaterialBytes <= 48 * 1024, "comparison baseline keeps its actual 48KiB packet ceiling");
  assert.ok(large.maxMaterialBytes > 48 * 1024, "a real acknowledged runtime material call must cross the former ceiling");
  assert.ok(large.maxFragments > 8, "candidate must exercise more than the previous fragment-count ceiling");
  assert.ok(large.admissions < wide.admissions, `expected fewer native admissions: wide=${wide.admissions}, large=${large.admissions}`);
  assert.deepEqual([wide.readRows, large.readRows], [ROWS, ROWS]);
  t.diagnostic(JSON.stringify({ kind: "offline-throughput-comparison", corpusSha256: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"), rows: ROWS,
    markers: expectedMarkers.length, wide, large, limitation: "Synthetic model tool boundary; elapsed times are local encrypted fixture costs, not Astra throughput or semantic quality." }));
});
