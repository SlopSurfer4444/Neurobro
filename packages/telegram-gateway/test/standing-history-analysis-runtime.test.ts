import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisOutput } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisAttemptPlan } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { createStandingHistoryAnalysisRuntime, prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";

type Runtime = ReturnType<typeof createStandingHistoryAnalysisRuntime>;
const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "8".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Synthetic runtime analysis" };
const materialName = "neurobro_analysis_material", notesName = "neurobro_analysis_notes", commitName = "neurobro_analysis_commit";
function page(before: SelfHistoryTaskCheckpoint, count = 1): SelfHistoryTaskPage {
  const sources = Array.from({ length: count }, (_, i) => ({ messageId: (before.offsetId || 10000) - i - 1, date: before.lastDate - i - 1,
    disposition: "included" as const, messageRef: "m_" + ((before.offsetId || 10000) - i - 1).toString(16).padStart(24, "0"), authorId: "456" }));
  const next = { ...before, offsetId: sources.at(-1)!.messageId, lastDate: sources.at(-1)!.date, oldestDate: sources.at(-1)!.date,
    newestDate: before.newestDate ?? sources[0]!.date, pages: before.pages + 1, upperBoundMessageId: before.upperBoundMessageId ?? sources[0]!.messageId };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources, page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
    messages: [...sources].reverse().map(s => ({ ref: s.messageRef, authorRef: "a_" + "3".repeat(24), author: "user", displayName: "Synthetic speaker",
      date: s.date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Private source " + s.messageId })), cursor: null, hasMore: true, status: "more",
    coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: false, undatedEntries: 0, pages: next.pages },
    excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
    limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
async function fixture(t: TestContext, merge = false) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-analysis-runtime-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-analysis-runtime-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), analysis: join(root, "analysis"), control: join(root, "control"), attempts: join(root, "attempts") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const passphrase = "synthetic-analysis-runtime-passphrase", binding = { passphrase, intent };
  const source = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "create" }); t.after(() => source.close());
  for (const count of merge ? [16, 1] : [1]) { const before = (await source.status()).readProgress.checkpoint; await source.appendPage({ expectedCheckpoint: before, result: page(before, count) }); }
  const analysis = await openStandingHistoryAnalysisStore({ ...binding, directory: directories.analysis, mode: "create", readSourcePage: index => source.readPage(index) }); t.after(() => analysis.close());
  let leafOutput: StandingHistoryAnalysisOutput | undefined;
  for (const index of merge ? [1, 2] : []) {
    const fragment = projectStandingHistorySource({ intent, referenceKey: analysis.referenceKey(), storedPage: (await source.readPage(index))! });
    const output: StandingHistoryAnalysisOutput = { summary: "Retained original notes", claims: fragment.rows.map(row => ({ kind: "reported", text: index === 1 ? "\u0001".repeat(1000) : "Other child claim",
      supports: [{ sourceRef: row.sourceRef, versionRef: row.versionRef }] })) };
    await analysis.appendLeaf({ expectedHead: (await analysis.status()).headHash, inputs: [{ pageIndex: index, materialRef: fragment.materialRef, maxBytes: 49152 }], output });
    if (index === 1) leafOutput = output;
  }
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: directories.control, mode: "create" }); t.after(() => control.close());
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: directories.attempts, mode: "create", analysis }); t.after(() => attempts.close());
  const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis }); t.after(() => planner.close());
  let selection = await planner.next();
  for (let n = 0; selection.kind === "scan-more" && n < 20; n++) selection = await planner.next();
  assert.ok(selection.kind === "leaf" || selection.kind === "merge");
  const prepared = prepareStandingHistoryAnalysisMaterial(selection), analysisStatus = await analysis.status();
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.material)) <= 49152);
  assert.deepEqual(prepareStandingHistoryAnalysisMaterial(selection), prepared);
  const plan: StandingHistoryAnalysisAttemptPlan = { kind: selection.kind, sourceHead: selection.sourceHead, expectedHead: selection.expectedHead,
    nodeIndex: analysisStatus.analysisNodes + 1, modelInputHash: prepared.modelInputHash,
    ...(selection.kind === "leaf" ? { inputs: selection.inputs } : { children: selection.children }) } as StandingHistoryAnalysisAttemptPlan;
  const reservation = await attempts.reserve({ plan }), controller = new AbortController();
  const begin = { requestRef: "request-1", attemptRef: reservation.attemptRef, plan, material: prepared.material, controlHead: (await control.status()).headHash, signal: controller.signal };
  if (!leafOutput && selection.kind === "leaf") { const row = selection.material.rows[0]!; leafOutput = { summary: "Valid current leaf", claims: [{ kind: "reported", text: "Source observation", supports: [{ sourceRef: row.sourceRef, versionRef: row.versionRef }] }] }; }
  const runtimeArgs = { intent, signal: controller.signal, source, control, analysis, attempts };
  return { root, directories, source, analysis, control, attempts, controller, plan, selection, begin, runtimeArgs, output: leafOutput! };
}
async function runtime(f: Awaited<ReturnType<typeof fixture>>, t: TestContext) {
  const value = createStandingHistoryAnalysisRuntime(f.runtimeArgs); t.after(() => value.close()); await value.begin(f.begin); return value;
}
async function call(r: Runtime, f: Awaited<ReturnType<typeof fixture>>, name: string, args: unknown, callRef: string, requestRef = f.begin.requestRef) {
  const handler = r.handlers.find(h => h.name === name); assert.ok(handler);
  return await handler.call(args, { requestRef, callRef, signal: f.controller.signal }) as EpochToolResult;
}
function ack(r: Runtime, f: Awaited<ReturnType<typeof fixture>>, name: string, callRef: string, result: EpochToolResult) {
  r.onToolResultSent({ requestRef: f.begin.requestRef, callRef, name, result: structuredClone(result) });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("material is not shown until exact wire acknowledgment; acknowledged support permits one actual commit", async t => {
  const f = await fixture(t), r = await runtime(f, t);
  assert.deepEqual(r.handlers.map(h => h.name), [materialName, notesName, commitName]); assert.equal(r.specs.length, 3);
  const result = await call(r, f, materialName, {}, "material"); assert.equal(result.success, true);
  assert.equal((await call(r, f, commitName, { output: f.output }, "unacknowledged")).success, false);
  assert.equal((await f.attempts.status()).last?.prepared, undefined); assert.equal((await f.analysis.status()).analysisNodes, 0);
  ack(r, f, materialName, "material", result);
  const committed = await call(r, f, commitName, { output: f.output }, "commit"); assert.equal(committed.success, true);
  const node = (await f.analysis.readNodeAt(1))!; assert.deepEqual(node.output, f.output); assert.equal((await f.attempts.status()).last?.node?.hash, node.hash);
  assert.equal((await call(r, f, commitName, { output: f.output }, "repeat")).success, false);
});

test("foreign, mismatched and altered acknowledgments cannot expand shown supports", async t => {
  const f = await fixture(t), r = await runtime(f, t), result = await call(r, f, materialName, {}, "material"); assert.equal(result.success, true);
  const original = { requestRef: f.begin.requestRef, callRef: "material", name: materialName, result };
  const altered: EpochToolResult = { success: true, contentItems: [{ type: "inputText", text: " " + result.contentItems[0].text }] };
  for (const [i, change] of [{ requestRef: "foreign" }, { callRef: "foreign" }, { name: notesName }, { result: altered }].entries()) {
    assert.throws(() => r.onToolResultSent({ ...original, ...change }));
    assert.equal((await call(r, f, commitName, { output: f.output }, "refusal-" + i)).success, false);
  }
  ack(r, f, materialName, "material", result); ack(r, f, materialName, "material", result);
  assert.equal((await call(r, f, commitName, { output: f.output }, "valid")).success, true);
});

test("late call-scope abort after material return rejects its acknowledgment and leaves even empty claims unprepared", async t => {
  const f = await fixture(t), r = await runtime(f, t), callController = new AbortController();
  const handler = r.handlers.find(h => h.name === materialName)!;
  const result = await handler.call({}, { requestRef: f.begin.requestRef, callRef: "late-abort", signal: callController.signal }) as EpochToolResult;
  assert.equal(result.success, true); callController.abort();
  assert.throws(() => ack(r, f, materialName, "late-abort", result));
  assert.equal((await call(r, f, commitName, { output: { summary: "No claims does not bypass delivery", claims: [] } }, "empty-commit")).success, false);
  assert.equal((await f.attempts.status()).last?.prepared, undefined); assert.equal((await f.analysis.status()).analysisNodes, 0);
});

test("hidden immediate-child notes require their own acknowledged delivery before claims become admissible", async t => {
  const f = await fixture(t, true), r = await runtime(f, t); assert.equal(f.selection.kind, "merge"); if (f.selection.kind !== "merge") return;
  const first = f.selection.materials[0], hiddenIndex = first.claimRange.toClaim;
  assert.ok(hiddenIndex < f.output.claims.length); const hidden = f.output.claims[hiddenIndex]!;
  const output = { summary: "Claim from retained hidden notes", claims: [hidden] };
  const material = await call(r, f, materialName, {}, "material"); assert.equal(material.success, true); ack(r, f, materialName, "material", material);
  assert.equal((await call(r, f, commitName, { output }, "not-shown")).success, false);
  const notes = await call(r, f, notesName, { nodeRef: first.nodeRef, position: null }, "notes"); assert.equal(notes.success, true);
  assert.equal((await call(r, f, commitName, { output }, "notes-not-ack")).success, false);
  ack(r, f, notesName, "notes", notes);
  assert.equal((await call(r, f, commitName, { output }, "shown")).success, true);
  assert.deepEqual((await f.analysis.readNodeAt(3))!.output, output);
});

test("notes enforce immediate-child allowlist, stored hash and continuation binding", async t => {
  const f = await fixture(t, true), r = await runtime(f, t); assert.equal(f.selection.kind, "merge"); if (f.selection.kind !== "merge") return;
  const child = f.selection.materials[0]; assert.ok(child.nextPosition);
  assert.equal((await call(r, f, notesName, { nodeRef: "hnode_" + "f".repeat(48), position: null }, "foreign")).success, false);
  assert.equal((await call(r, f, notesName, { nodeRef: child.nodeRef, position: "hnpos_0_0_" + "0".repeat(48) }, "forged-cursor")).success, false);
  assert.equal((await call(r, f, notesName, { nodeRef: f.selection.materials[1].nodeRef, position: child.nextPosition }, "cross-child")).success, false);
  assert.equal((await call(r, f, notesName, { nodeRef: child.nodeRef, position: child.nextPosition }, "valid-cursor")).success, true);
  await r.finish();
  const changed = createStandingHistoryAnalysisRuntime({ ...f.runtimeArgs, analysis: { ...f.analysis, async readNode(ref) {
    const node = await f.analysis.readNode(ref); return node ? { ...node, hash: "0".repeat(64) } : undefined;
  } } }); t.after(() => changed.close()); await changed.begin({ ...f.begin, requestRef: "request-2" });
  assert.equal((await call(changed, f, notesName, { nodeRef: child.nodeRef, position: null }, "changed-hash", "request-2")).success, false);
});

test("cancelled control, tail and changed source/analysis heads prevent prepared output admission", async t => {
  for (const change of ["cancelled", "tail", "source", "analysis"] as const) {
    const f = await fixture(t), r = await runtime(f, t), material = await call(r, f, materialName, {}, "material"); ack(r, f, materialName, "material", material);
    if (change === "cancelled") await f.control.cancel({ expectedRevision: 0 });
    if (change === "tail") await writeFile(join(f.directories.control, intent.taskId, "unknown.bin"), "retained control tail");
    if (change === "source") {
      const before = (await f.source.status()).readProgress.checkpoint; await f.source.appendPage({ expectedCheckpoint: before, result: page(before) });
    }
    if (change === "analysis" && f.plan.kind === "leaf") await f.analysis.appendLeaf({ expectedHead: f.plan.expectedHead, inputs: f.plan.inputs, output: f.output });
    assert.equal((await call(r, f, commitName, { output: f.output }, "changed")).success, false, change);
    assert.equal((await f.attempts.status()).last?.prepared, undefined);
  }
});

test("seven read calls leave one commit slot, and an unknown commit return cannot admit a retry", async t => {
  const f = await fixture(t), r = await runtime(f, t);
  for (let i = 0; i < 7; i++) { const result = await call(r, f, materialName, {}, "read-" + i); assert.equal(result.success, true); ack(r, f, materialName, "read-" + i, result); }
  assert.equal((await call(r, f, commitName, { output: f.output }, "eighth")).success, true);
  assert.equal((await call(r, f, materialName, {}, "ninth")).success, false);
  const g = await fixture(t); let commits = 0;
  const unknown = createStandingHistoryAnalysisRuntime({ ...g.runtimeArgs, attempts: { ...g.attempts, async commitPrepared() { commits++; throw Error("synthetic unknown commit return"); } } });
  t.after(() => unknown.close()); await unknown.begin(g.begin);
  const shown = await call(unknown, g, materialName, {}, "material"); ack(unknown, g, materialName, "material", shown);
  assert.equal((await call(unknown, g, commitName, { output: g.output }, "unknown")).success, false);
  assert.equal((await call(unknown, g, commitName, { output: g.output }, "retry")).success, false);
  assert.equal(commits, 1); assert.ok((await g.attempts.status()).last?.prepared); assert.equal((await g.analysis.status()).analysisNodes, 0);
});

test("finish and abort join actual pending status callbacks, revoke acknowledgments and preserve borrowed stores", async t => {
  for (const abort of [false, true]) {
    const f = await fixture(t), entered = deferred(), release = deferred(); let block = false;
    const r = createStandingHistoryAnalysisRuntime({ ...f.runtimeArgs, source: { async status() { if (block) { entered.resolve(); await release.promise; } return f.source.status(); } } }); t.after(() => r.close());
    await r.begin(f.begin); block = true;
    const pending = call(r, f, materialName, {}, "blocked"); await entered.promise;
    if (abort) f.controller.abort(); let joined = false; const finishing = r.finish().then(() => { joined = true; });
    await immediate(); assert.equal(joined, false); release.resolve(); const result = await pending; await finishing; assert.equal(result.success, false);
    assert.throws(() => ack(r, f, materialName, "blocked", result)); assert.equal((await f.attempts.status()).last?.prepared, undefined);
    assert.equal((await f.source.status()).storage, "ready"); assert.equal((await f.analysis.status()).storage, "ready");
    assert.equal((await call(r, f, commitName, { output: f.output }, "late")).success, false);
  }
});

test("begin and tool arguments reject getters/proxies without executing them or preparing output", async t => {
  const f = await fixture(t), r = createStandingHistoryAnalysisRuntime(f.runtimeArgs); t.after(() => r.close()); let getters = 0;
  await assert.rejects(async () => r.begin({ ...f.begin, plan: { ...f.plan, modelInputHash: "0".repeat(64) } }));
  await assert.rejects(async () => r.begin({ ...f.begin, get plan() { getters++; return f.plan; } }));
  await assert.rejects(async () => r.begin(new Proxy(f.begin, { getPrototypeOf() { getters++; throw Error("trap"); } })));
  await r.begin(f.begin);
  for (const value of [{ get output() { getters++; return f.output; } }, new Proxy({ output: f.output }, { ownKeys() { getters++; throw Error("trap"); } })])
    assert.equal((await call(r, f, commitName, value, "hostile-" + getters)).success, false);
  assert.equal(getters, 0); assert.equal((await f.attempts.status()).last?.prepared, undefined);
});

test("material preparation refuses an oversized full view instead of cropping it", async t => {
  const f = await fixture(t); assert.equal(f.selection.kind, "leaf"); if (f.selection.kind !== "leaf") return;
  const material = structuredClone(f.selection.material), row = material.rows[0]!;
  assert.equal(row.disposition, "included"); if (row.disposition !== "included") return;
  const oversized = { ...f.selection, material: { ...material, rows: [{ ...row, text: "x".repeat(50000) }] } };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.material)) > 49152);
  assert.throws(() => prepareStandingHistoryAnalysisMaterial(oversized));
  assert.equal(oversized.material.rows[0]!.text.length, 50000);
});
