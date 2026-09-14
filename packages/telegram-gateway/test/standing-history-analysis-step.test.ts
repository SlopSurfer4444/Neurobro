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
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { openStandingHistoryAnalysisStep, type StandingHistoryAnalysisOwnerSettlement, type StandingHistoryAnalysisStepConnection } from "../src/standing-history-analysis-step.js";
import type { CompletedAnalysisTurn } from "../src/standing-scoped-epoch-session.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { requireStandingChronicleNote } from "../src/standing-chronicle-note.js";

type Step = Awaited<ReturnType<typeof openStandingHistoryAnalysisStep>>;
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
async function fixture(t: TestContext, pageCount = 2) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-analysis-step-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-analysis-step-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "6".repeat(48), accountId: "123", chatId: "-100456",
    requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Synthetic available history analysis" };
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
function connection(f: Awaited<ReturnType<typeof fixture>>, mode: "commit" | "unknown" | "lost-commit" | "no-node" | "wrong-scope" | "blocked" = "commit", afterTools?: () => Promise<void>) {
  const counts = { acquired: 0, turns: 0, released: 0, aborts: 0, closed: 0 }, previous: (StandingHistoryAnalysisNativeBinding | undefined)[] = [];
  const entered = deferred(), release = deferred(), turnDone = deferred();
  const value: StandingHistoryAnalysisStepConnection = { async acquireAnalysisAdmission(requestRef, previousBinding) {
    counts.acquired++; previous.push(previousBinding);
    const nativeBinding: StandingHistoryAnalysisNativeBinding = { epochId: "a".repeat(32), requestRef, purpose: "history-analysis" };
    return { nativeBinding, async turnAnalysis(req, body, bindings): Promise<CompletedAnalysisTurn> {
      counts.turns++; entered.resolve();
      try {
        assert.equal(req, requestRef); assert.equal(JSON.parse(body).schema, "neurobro-history-analysis-input-v1");
        assert.deepEqual(bindings.analysisTools.map(tool => tool.name), ["neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit"]);
        if (mode === "blocked") { await release.promise; throw Error("synthetic interrupted native turn"); }
        if (mode === "unknown") throw Error("synthetic native outcome missing");
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
  return { value, counts, previous, entered, release };
}
async function next(step: Step, f: Awaited<ReturnType<typeof fixture>>, native: ReturnType<typeof connection>, requestRef = "new-request", signal = f.controller.signal) {
  for (let i = 0; i < 20; i++) { const result = await step.next({ requestRef, connection: native.value, signal }); if (result.kind !== "scan-more") return result; }
  assert.fail("bounded fixture planning did not finish");
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, options: { bound?: boolean; prepared?: boolean; node?: "recorded" | "unacknowledged"; outcome?: "observed" | "unknown" } = {}) {
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

test("passive read-more planning never acquires a native admission lease", async t => {
  const f = await fixture(t, 0), step = await opened(f, t), native = connection(f);
  assert.equal((await next(step, f, native)).kind, "read-more"); assert.equal(native.counts.acquired, 0); assert.equal((await readback(f)).attempts.attempts, 0);
});

test("unknown native reservation is durable and a fresh handle never calls the model again", async t => {
  const f = await fixture(t), step = await opened(f, t), native = connection(f, "unknown"), result = await next(step, f, native);
  assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(result.modelOutcome, "unknown"); assert.equal(result.node, undefined); assert.equal(result.release, "not-acknowledged");
  assert.equal(native.counts.aborts, 1); await step.close();
  const again = await opened(f, t), other = connection(f); await assert.rejects(next(again, f, other));
  assert.equal(other.counts.acquired, 0); assert.equal(other.counts.turns, 0); assert.deepEqual(f.settlements, []);
  const saved = await readback(f); assert.equal(saved.attempts.attempts, 1); assert.equal(saved.attempts.last?.modelOutcome, "unknown"); assert.equal(saved.attempts.modelReplayAllowed, false);
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

test("observed completion without a saved node does not authorize another attempt", async t => {
  const f = await fixture(t), step = await opened(f, t), native = connection(f, "no-node"), result = await next(step, f, native);
  assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") return;
  assert.equal(result.modelOutcome, "observed"); assert.equal(result.node, undefined); await step.close();
  const again = await opened(f, t), other = connection(f); await assert.rejects(next(again, f, other)); assert.equal(other.counts.acquired, 0);
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
