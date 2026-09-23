import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisOutput, type StandingHistoryAnalysisMaterialRequest } from "../src/standing-history-analysis-store.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { ANALYSIS_TOOL_SPECS, prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { openStandingHistoryParallelWorkStore, type StandingHistoryParallelWorkPlan, type StandingHistoryParallelWorkStore } from "../src/standing-history-parallel-work-store.js";
import { createStandingHistoryParallelAnalysisRuntime, type StandingHistoryParallelAnalysisRuntime } from "../src/standing-history-parallel-analysis-runtime.js";
import { createStandingHistoryPeriodChronicleTurn, type StandingHistoryPeriodChronicleTurn } from "../src/standing-history-period-chronicle-turn.js";
import { prepareStandingHistoryPeriodChronicle, consumeStandingHistoryPeriodChronicle, type StandingHistoryPeriodChronicleRequest, type StandingHistoryPeriodChronicleStore } from "../src/standing-history-period-chronicle.js";
import { openStandingHistoryPeriodChronicleStore } from "../src/standing-history-period-chronicle-store.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";

const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "4".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Synthetic parallel runtime objective" };
const materialName = "neurobro_analysis_material", notesName = "neurobro_analysis_notes", commitName = "neurobro_analysis_commit";
function page(before: SelfHistoryTaskCheckpoint): SelfHistoryTaskPage {
  const messageId = (before.offsetId || 1000) - 1, date = before.lastDate - 1, ref = "m_" + messageId.toString(16).padStart(24, "0");
  const next = { ...before, offsetId: messageId, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date, pages: before.pages + 1, upperBoundMessageId: before.upperBoundMessageId ?? messageId };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: [{ messageId, date, disposition: "included", messageRef: ref, authorId: "456" }],
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: [{ ref, authorRef: "a_" + "3".repeat(24), author: "user", displayName: "Synthetic speaker", date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Synthetic private source " + messageId }], cursor: null, hasMore: true, status: "more",
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: false, undatedEntries: 0, pages: next.pages },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, batch = false, community = false, optionalPeriod = false, reuse?: Readonly<{ intent: Partial<StandingHistoryTaskIntent>; notes: StandingHistoryPeriodChronicleStore }>) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-parallel-runtime-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-parallel-runtime-"))); await rm(root, { recursive: true, force: true }); });
  const selectedIntent = { ...(community ? { ...intent, source: { kind: "observed-source" as const, sourceRef: "community" as const, workspaceId: "synthetic-workspace", peerId: "-100789" } } : intent), ...reuse?.intent };
  const directories = { pages: join(root, "pages"), analysis: join(root, "analysis"), control: join(root, "control"), work: join(root, "work") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const shared = { passphrase: "synthetic-parallel-runtime-passphrase", intent: selectedIntent };
  const source = await openStandingHistoryTaskStore({ ...shared, directory: directories.pages, mode: "create" }); t.after(() => source.close());
  for (let i = 0; i < 2; i++) { const before = (await source.status()).readProgress.checkpoint; await source.appendPage({ expectedCheckpoint: before, result: page(before) }); }
  const analysis = await openStandingHistoryAnalysisStore({ ...shared, directory: directories.analysis, mode: "create", readSourcePage: index => source.readPage(index) }); t.after(() => analysis.close());
  const control = await openStandingHistoryTaskControlStore({ ...shared, directory: directories.control, mode: "create" }); t.after(() => control.close());
  const workArgs = { ...shared, directory: directories.work, source, analysis };
  const workStore = await openStandingHistoryParallelWorkStore({ ...workArgs, mode: "create" }); t.after(() => workStore.close());
  const sourceHead = (await source.status()).readProgress.chainHash, expectedHead = (await analysis.status()).headHash, controlHead = (await control.status()).headHash;
  const fragments = [];
  for (let i = 1; i <= 2; i++) fragments.push(projectStandingHistorySource({ intent: selectedIntent, referenceKey: analysis.referenceKey(), storedPage: (await source.readPage(i))!, maxBytes: 49152, maxRows: 100 }));
  const selections = (batch ? [fragments] : fragments.map(fragment => [fragment])).map((selected, i) => {
    const inputs = selected.map(fragment => ({ pageIndex: fragment.pageIndex, materialRef: fragment.materialRef, maxRows: 100, maxBytes: 49152 })) as [StandingHistoryAnalysisMaterialRequest, ...StandingHistoryAnalysisMaterialRequest[]];
    const material = selected.length === 1 ? selected[0]! : { schema: "standing-history-source-batch-v1" as const, fragments: selected };
    const { modelInputHash } = prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead, inputs, material });
    const requestRef = "parallel-runtime-" + i, plan: StandingHistoryParallelWorkPlan = { kind: "leaf", inputs, modelInputHash, nativeBinding: { epochId: "a".repeat(32), requestRef, purpose: "history-analysis" } };
    const output: StandingHistoryAnalysisOutput = { summary: "Synthetic summary " + i, claims: [{ kind: "reported", text: "Synthetic observed source " + i,
      supports: selected.flatMap(fragment => fragment.rows.map(row => ({ sourceRef: row.sourceRef, versionRef: row.versionRef }))) }] };
    return { material, plan, output, requestRef };
  });
  const global = new AbortController(), periodChronicles: StandingHistoryPeriodChronicleTurn[] = [], neutralRequests: StandingHistoryPeriodChronicleRequest[] = [];
  if (optionalPeriod) for (const s of selections) {
    const materials = []; for (const request of s.plan.kind === "leaf" ? s.plan.inputs : []) materials.push({ request, page: (await source.readPage(request.pageIndex))! });
    const neutralRequest = prepareStandingHistoryPeriodChronicle({ intent: selectedIntent, producer: { model: "synthetic", promptVersion: "neutral1", projectionVersion: "source1", outputVersion: "output1" },
      referenceKey: analysis.referenceKey(), materials, period: { kind: "month", key: "1970-01" }, workspaceId: "test-workspace" })!;
    neutralRequests.push(neutralRequest);
    const hit = reuse ? await reuse.notes.lookup(neutralRequest) : undefined;
    const advisory = hit ? consumeStandingHistoryPeriodChronicle({ request: neutralRequest, note: hit }) : undefined;
    const helper = createStandingHistoryPeriodChronicleTurn({ requestRef: s.requestRef, signal: global.signal, ...(advisory ? { advisory } : { neutralRequest }) }); periodChronicles.push(helper);
    s.plan = { ...s.plan, contextHash: helper.contextHash };
  }
  const wave = await workStore.reserveWave({ sourceHead, expectedHead, works: selections.map(s => s.plan) });
  const starts = selections.map((s, i) => ({ ...s, workRef: wave.workRefs[i]!, controller: new AbortController(), ...(periodChronicles[i] ? { periodChronicle: periodChronicles[i]! } : {}) }));
  const begin = (i: number) => { const s = starts[i]!; return { requestRef: s.requestRef, workRef: s.workRef, material: s.material, controlHead, signal: s.controller.signal,
    ...(s.periodChronicle ? { periodChronicle: s.periodChronicle } : {}) }; };
  const make = (port: Pick<StandingHistoryParallelWorkStore, "readWork" | "prepare"> = workStore) => {
    const runtime = createStandingHistoryParallelAnalysisRuntime({ intent: selectedIntent, signal: global.signal, source, control, workStore: port }); t.after(() => runtime.close()); return runtime;
  };
  return { root, directories, source, analysis, control, workStore, workArgs, wave, global, starts, begin, make, neutralRequests };
}
async function call(runtime: StandingHistoryParallelAnalysisRuntime, f: Awaited<ReturnType<typeof fixture>>, i: number, name: string, value: unknown, callRef: string): Promise<EpochToolResult> {
  return await runtime.handlers.find(h => h.name === name)!.call(value, { requestRef: f.starts[i]!.requestRef, callRef, signal: f.starts[i]!.controller.signal }) as EpochToolResult;
}
function ack(runtime: StandingHistoryParallelAnalysisRuntime, f: Awaited<ReturnType<typeof fixture>>, i: number, name: string, callRef: string, result: EpochToolResult) {
  runtime.onToolResultSent({ requestRef: f.starts[i]!.requestRef, callRef, name, result: structuredClone(result) });
}
function refusal(result: EpochToolResult, code: string) { assert.equal(result.success, false); assert.deepEqual(JSON.parse(result.contentItems[0].text), { schema: "neurobro-history-analysis-error-v1", code }); }
async function shown(runtime: StandingHistoryParallelAnalysisRuntime, f: Awaited<ReturnType<typeof fixture>>, i: number) {
  const result = await call(runtime, f, i, materialName, {}, "material"); assert.equal(result.success, true); ack(runtime, f, i, materialName, "material", result); return result;
}

test("two independently bound workers overlap preparation through actual shared stores and return staged receipts only", async t => {
  const f = await fixture(t), bothEntered = deferred(); let entries = 0, active = 0, maximum = 0;
  const port = { readWork: f.workStore.readWork, prepare: async (input: Parameters<typeof f.workStore.prepare>[0]) => {
    entries++; active++; maximum = Math.max(maximum, active); if (entries === 2) bothEntered.resolve(); await bothEntered.promise;
    try { await f.workStore.prepare(input); } finally { active--; }
  } };
  const runtimes = [f.make(port), f.make(port)]; assert.strictEqual(runtimes[0]!.specs, ANALYSIS_TOOL_SPECS);
  await Promise.all(runtimes.map((runtime, i) => runtime.begin(f.begin(i)))); await Promise.all(runtimes.map((runtime, i) => shown(runtime, f, i)));
  const results = await Promise.all(runtimes.map((runtime, i) => call(runtime, f, i, commitName, { output: f.starts[i]!.output }, "commit")));
  assert.equal(maximum, 2);
  for (const [i, result] of results.entries()) { assert.equal(result.success, true); assert.deepEqual(JSON.parse(result.contentItems[0].text), { schema: "neurobro-history-analysis-prepared-v1", prepared: true, projectionPending: true, claimsStatus: "model-authored-unverified" });
    const work = await f.workStore.readWork(f.starts[i]!.workRef); assert.deepEqual(work.output, f.starts[i]!.output); assert.equal(work.modelOutcome, undefined); assert.equal(work.node, undefined); }
  assert.equal((await f.analysis.status()).analysisNodes, 0);
});

test("third reserved successor can prepare but exhausted or contradictory work metadata cannot begin", async t => {
  const f = await fixture(t);
  let workRef = f.wave.workRefs[0]!;
  for (let i = 1; i <= 2; i++) {
    if (i === 1) await f.workStore.recordModelOutcome({ workRef, outcome: "unknown" });
    const next = await f.workStore.reserveSuccessor({ workRef,
      nativeBinding: { epochId: String(i + 1).repeat(32), requestRef: "runtime-successor-" + i, purpose: "history-analysis" },
      async verifyOwnerSettled(nativeBinding) { return { schema: "standing-analysis-owner-settlement-v1", nativeBinding,
        resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" }; } });
    workRef = next.workRef;
  }
  const saved = await f.workStore.readWork(workRef); assert.equal(saved.consecutiveNoOutput, 3); assert.equal(saved.noOutputClassification, "missing-outcome");
  const start = { ...f.begin(0), requestRef: saved.plan.nativeBinding.requestRef, workRef };
  for (const patch of [{ consecutiveNoOutput: 4 }, { noOutputClassification: "unknown-no-output" as const }]) {
    const rejected = f.make({ prepare: f.workStore.prepare, async readWork(ref) { return { ...await f.workStore.readWork(ref), ...patch }; } });
    await assert.rejects(rejected.begin(start));
  }
  const runtime = f.make(); await runtime.begin(start);
  const scope = { requestRef: start.requestRef, signal: start.signal };
  const material = await runtime.handlers[0]!.call({}, { ...scope, callRef: "material" }) as EpochToolResult;
  assert.equal(material.success, true); runtime.onToolResultSent({ requestRef: start.requestRef, callRef: "material", name: materialName, result: material });
  const committed = await runtime.handlers[2]!.call({ output: f.starts[0]!.output }, { ...scope, callRef: "commit" }) as EpochToolResult;
  assert.equal(committed.success, true); assert.deepEqual((await f.workStore.readWork(workRef)).output, f.starts[0]!.output);
});

test("material requires exact matching acknowledgment and cannot borrow another worker's source evidence", async t => {
  const f = await fixture(t), r = f.make(); await r.begin(f.begin(0));
  const material = await call(r, f, 0, materialName, {}, "material");
  refusal(await call(r, f, 0, commitName, { output: f.starts[0]!.output }, "before-ack"), "material-not-shown");
  assert.throws(() => ack(r, f, 1, materialName, "material", material));
  assert.throws(() => ack(r, f, 0, materialName, "material", { ...material, success: false }));
  ack(r, f, 0, materialName, "material", material);
  refusal(await call(r, f, 0, commitName, { output: f.starts[1]!.output }, "cross-support"), "unshown-support");
  assert.equal((await f.workStore.readWork(f.starts[0]!.workRef)).output, undefined);
  assert.equal((await call(r, f, 0, commitName, { output: f.starts[0]!.output }, "corrected")).success, true);
});

test("invalid output remains correctable before persistence; preparation errors consume the worker commit", async t => {
  const f = await fixture(t); let prepares = 0;
  const r = f.make({ readWork: f.workStore.readWork, prepare: async input => { prepares++; await f.workStore.prepare(input); throw new Error("synthetic uncertain prepare return"); } });
  await r.begin(f.begin(0)); await shown(r, f, 0);
  refusal(await call(r, f, 0, commitName, { output: { ...f.starts[0]!.output, summary: "x".repeat(32769) } }, "too-large"), "invalid-arguments"); assert.equal(prepares, 0);
  refusal(await call(r, f, 0, commitName, { output: f.starts[0]!.output }, "uncertain"), "unavailable"); assert.equal(prepares, 1);
  refusal(await call(r, f, 0, commitName, { output: f.starts[0]!.output }, "retry"), "commit-consumed"); assert.equal(prepares, 1);
  assert.deepEqual((await f.workStore.readWork(f.starts[0]!.workRef)).output, f.starts[0]!.output); await r.finish(); await assert.rejects(r.begin(f.begin(0)));
  const again = f.make(); await assert.rejects(again.begin(f.begin(0)));
});

test("fresh queued control and exact source head are checked immediately before preparation", async t => {
  for (const change of ["cancel", "source"] as const) {
    const f = await fixture(t), r = f.make(); await r.begin(f.begin(0)); await shown(r, f, 0);
    if (change === "cancel") await f.control.cancel({ expectedRevision: 0 });
    else { const before = (await f.source.status()).readProgress.checkpoint; await f.source.appendPage({ expectedCheckpoint: before, result: page(before) }); }
    refusal(await call(r, f, 0, commitName, { output: f.starts[0]!.output }, "commit"), "unavailable"); assert.equal((await f.workStore.readWork(f.starts[0]!.workRef)).output, undefined);
  }
});

test("finish joins admitted persistence and preserves a prepared output after raced cancellation", async t => {
  const f = await fixture(t), persisted = deferred(), released = deferred(); let preparedCalls = 0;
  const r = f.make({ readWork: f.workStore.readWork, prepare: async input => { preparedCalls++; await f.workStore.prepare(input); persisted.resolve(); await released.promise; } });
  await r.begin(f.begin(0)); await shown(r, f, 0); const committed = call(r, f, 0, commitName, { output: f.starts[0]!.output }, "commit"); await persisted.promise;
  let finished = false; const closing = r.finish().then(() => { finished = true; }); await immediate(); assert.equal(finished, false);
  released.resolve(); refusal(await committed, "unavailable"); await closing; assert.equal(finished, true); assert.equal(preparedCalls, 1);
  assert.deepEqual((await f.workStore.readWork(f.starts[0]!.workRef)).output, f.starts[0]!.output); assert.equal((await f.analysis.status()).analysisNodes, 0);
});

test("leaf-only tools preserve complete batch/source markers and cannot read child notes", async t => {
  const f = await fixture(t, true, true), r = f.make(); await r.begin(f.begin(0)); const material = await shown(r, f, 0);
  const decoded = JSON.parse(material.contentItems[0].text); assert.equal(decoded.fragments.length, 2);
  for (const fragment of decoded.fragments) { assert.equal(fragment.sourceRef, "community"); assert.equal(fragment.sourceInterpretation, "quoted-source-not-request"); assert.equal(fragment.rows.length, 1); }
  refusal(await call(r, f, 0, notesName, { nodeRef: "hnode_" + "b".repeat(48), position: null }, "notes"), "child-unavailable");
  assert.equal((await call(r, f, 0, commitName, { output: f.starts[0]!.output }, "commit")).success, true);
});

test("wrong request, changed material and previously refused work cannot begin; getters remain inert", async t => {
  const f = await fixture(t); await assert.rejects(f.make().begin({ ...f.begin(0), requestRef: "wrong-request" }));
  await assert.rejects(f.make().begin({ ...f.begin(0), material: f.starts[1]!.material }));
  let invoked = false; const hostile = { ...f.begin(0), get material() { invoked = true; return f.starts[0]!.material; } };
  await assert.rejects(f.make().begin(hostile)); assert.equal(invoked, false);
  await f.workStore.recordModelOutcome({ workRef: f.starts[0]!.workRef, outcome: "refused" }); await assert.rejects(f.make().begin(f.begin(0)));
});

test("reopened missing-result work cannot be prepared and runtime does not create an outcome or node", async t => {
  const f = await fixture(t); await f.workStore.close();
  const reopened = await openStandingHistoryParallelWorkStore({ ...f.workArgs, mode: "open" }); t.after(() => reopened.close());
  // begin is a tool binding, not permission to dispatch a model. The work store
  // still refuses preparing an old reservation even with a new tool instance.
  const r = f.make(reopened); await r.begin(f.begin(0)); await shown(r, f, 0);
  refusal(await call(r, f, 0, commitName, { output: f.starts[0]!.output }, "commit"), "unavailable");
  const work = await reopened.readWork(f.starts[0]!.workRef); assert.equal(work.output, undefined); assert.equal(work.modelOutcome, undefined); assert.equal(work.node, undefined);
  assert.equal((await f.analysis.status()).analysisNodes, 0);
});

test("one leaf turn separately ACKs neutral material and stages distinct sideoutput only after primary prepare", async t => {
  const f = await fixture(t, false, false, true), r = f.make(), request = f.neutralRequests[0]!; await r.begin(f.begin(0));
  const neutral = await call(r, f, 0, materialName, { purpose: "neutral-period-notes" }, "neutral"); assert.equal(neutral.success, true);
  assert.deepEqual(JSON.parse(neutral.contentItems[0].text), request); ack(r, f, 0, materialName, "neutral", neutral);
  const output = { ...f.starts[0]!.output, summary: "Separate neutral summary", claims: f.starts[0]!.output.claims.map(c => ({ ...c, text: "Neutral source event" })) };
  const commit = { output: f.starts[0]!.output, neutralOutput: { inputHash: request.inputHash, output } };
  refusal(await call(r, f, 0, commitName, commit, "neutral-only"), "material-not-shown"); assert.equal(r.preparedPeriodChronicle(), undefined);
  await shown(r, f, 0); assert.equal((await call(r, f, 0, commitName, commit, "commit")).success, true);
  assert.deepEqual((await f.workStore.readWork(f.starts[0]!.workRef)).output, f.starts[0]!.output);
  const prepared = r.preparedPeriodChronicle(); assert.ok(prepared); assert.strictEqual(prepared.request, request); assert.deepEqual(prepared.output, output);
  await r.finish(); assert.equal(r.preparedPeriodChronicle(), undefined);
  // Host capture follows independently verified observed outcome/release; the
  // runtime itself neither invents that outcome nor writes a cache entry.
  const notes = await openStandingHistoryPeriodChronicleStore({ directory: join(f.root, "period-notes"), passphrase: f.workArgs.passphrase }); t.after(() => notes.close());
  const note = await notes.remember({ ...prepared, generation: { purpose: "neutral-period-notes", inputHash: request.inputHash,
    requestRef: f.starts[0]!.requestRef, epochId: f.starts[0]!.plan.nativeBinding.epochId, modelOutcome: "observed", resourcesSettled: true }, capturedAt: 1 });
  assert.ok(note); assert.equal(note.output.summary, "Separate neutral summary"); assert.notEqual(note.output.summary, f.starts[0]!.output.summary);
  const later = await fixture(t, false, false, true, { intent: { taskId: "htask_" + "b".repeat(48), objective: "A different question about the same source" }, notes });
  const query = later.make(); await query.begin(later.begin(0));
  assert.equal(later.starts[0]!.periodChronicle!.advertised.periodAdvisoryAvailable, true);
  const reused = await call(query, later, 0, materialName, { purpose: "period-advisory" }, "advisory"); assert.equal(reused.success, true);
  const decoded = JSON.parse(reused.contentItems[0].text);
  assert.equal(decoded.summary, "Separate neutral summary"); assert.equal(decoded.currentSourceRequired, true); assert.equal(decoded.queryCoverage, "not-established");
  assert.equal(decoded.claims[0].supports[0].sourceRef, later.starts[0]!.output.claims[0]!.supports[0]!.sourceRef);
  assert.notEqual(decoded.claims[0].supports[0].sourceRef, output.claims[0]!.supports[0]!.sourceRef);
  ack(query, later, 0, materialName, "advisory", reused);
  refusal(await call(query, later, 0, commitName, { output: later.starts[0]!.output }, "before-source"), "material-not-shown");
  await shown(query, later, 0); assert.equal((await call(query, later, 0, commitName, { output: later.starts[0]!.output }, "query")).success, true);
  assert.deepEqual((await later.workStore.readWork(later.starts[0]!.workRef)).output, later.starts[0]!.output);
  assert.equal(query.preparedPeriodChronicle(), undefined, "advisory consumption does not relabel query output as neutral");
});

test("unshown, wronghash and outside-neutral support sideoutputs never poison primary durable output", async t => {
  for (const defect of ["unshown", "hash", "support"] as const) {
    const f = await fixture(t, false, false, true), r = f.make(), request = f.neutralRequests[0]!; await r.begin(f.begin(0)); await shown(r, f, 0);
    const neutral = await call(r, f, 0, materialName, { purpose: "neutral-period-notes" }, "neutral");
    if (defect !== "unshown") ack(r, f, 0, materialName, "neutral", neutral);
    const side = { inputHash: defect === "hash" ? "f".repeat(64) : request.inputHash, output: defect === "support" ? f.starts[1]!.output : f.starts[0]!.output };
    assert.equal((await call(r, f, 0, commitName, { output: f.starts[0]!.output, neutralOutput: side }, "commit")).success, true);
    assert.equal(r.preparedPeriodChronicle(), undefined); assert.deepEqual((await f.workStore.readWork(f.starts[0]!.workRef)).output, f.starts[0]!.output);
  }
});

test("reservation context hash binds optional material; omitted or swapped helper refuses begin", async t => {
  const f = await fixture(t, false, false, true), original = f.begin(0);
  const { periodChronicle: ignored, ...without } = original; await assert.rejects(f.make().begin(without));
  await assert.rejects(f.make().begin({ ...original, periodChronicle: f.starts[1]!.periodChronicle! }));
  const plain = await fixture(t); await assert.rejects(plain.make().begin({ ...plain.begin(0), periodChronicle: ignored! }));
});

test("optional read shares seven-read budget and unavailable optional data never substitutes primary source", async t => {
  const f = await fixture(t), r = f.make(); await r.begin(f.begin(0));
  refusal(await call(r, f, 0, materialName, { purpose: "period-advisory" }, "advisory"), "optional-material-unavailable");
  for (let i = 0; i < 6; i++) assert.equal((await call(r, f, 0, materialName, {}, "raw" + i)).success, true);
  refusal(await call(r, f, 0, materialName, {}, "eighth-read"), "read-call-limit");
  assert.equal(r.preparedPeriodChronicle(), undefined);
});
