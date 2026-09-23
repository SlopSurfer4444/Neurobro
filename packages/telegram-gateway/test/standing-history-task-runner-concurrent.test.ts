import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore } from "../src/standing-history-analysis-attempt-store.js";
import { openStandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { openStandingHistoryTaskRunner, type StandingHistoryTaskRunner, type StandingHistoryTaskRunnerInput, type StandingHistoryTaskWork } from "../src/standing-history-task-runner.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import type { StandingIdleHistoryTicket, StandingPollWork, StandingSelection } from "../src/standing-conversation-adapter.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import timersPromises from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";

const deferred = () => {
  let resolve!: () => void, settled = false;
  const promise = new Promise<void>(done => { resolve = () => { settled = true; done(); }; });
  return { promise, resolve, get settled() { return settled; } };
};
// Reuse the actual encrypted-store/manager fixture shape from the ordinary
// runner cohort. Only the native completion and adapter selection are gated.
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
async function fixture(t: TestContext, analyzed = false, sourcePages = 2) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-concurrent-runner-"));
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const passphrase = "synthetic-concurrent-runner-passphrase", binding = { accountId: "123", peerId: "-100456" }, controller = new AbortController();
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "a".repeat(48), accountId: binding.accountId, chatId: binding.peerId,
    requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "UTC", objective: "Synthetic concurrent history" };
  async function openStores(mode: "create" | "open" = "open") {
    const shared = { intent, passphrase, mode };
    const source = await openStandingHistoryTaskStore({ ...shared, directory: directories.pages });
    const control = await openStandingHistoryTaskControlStore({ ...shared, directory: directories.control });
    const analysis = await openStandingHistoryAnalysisStore({ ...shared, directory: directories.analysis, readSourcePage: index => source.readPage(index) });
    const attempts = await openStandingHistoryAnalysisAttemptStore({ ...shared, directory: directories.attempts, analysis });
    return { source, control, analysis, attempts, async close() { await attempts.close(); await analysis.close(); await source.close(); await control.close(); } };
  }
  const seeded = await openStores("create");
  try {
    for (let i = 1; i <= sourcePages; i++) { const before = (await seeded.source.status()).readProgress.checkpoint; await seeded.source.appendPage({ expectedCheckpoint: before, result: page(before, i === sourcePages) }); }
    if (analyzed) {
      const materials = [];
      for (let pageIndex = 1; pageIndex <= sourcePages; pageIndex++) { const projected = projectStandingHistorySource({ intent, referenceKey: seeded.analysis.referenceKey(), storedPage: (await seeded.source.readPage(pageIndex))!, maxBytes: 49152 });
        materials.push({ pageIndex, maxBytes: 49152, materialRef: projected.materialRef }); }
      await seeded.analysis.appendLeaf({ expectedHead: (await seeded.analysis.status()).headHash, inputs: materials, output: { summary: "Existing complete synthetic note", claims: [] } });
    }
  } finally { await seeded.close(); }
  let runner: StandingHistoryTaskRunner | undefined, selection: StandingSelection | undefined, nativeAborted = false;
  const nativeEntered = deferred(), nativeRelease = deferred(), nativeFinished = deferred(), abortEntered = deferred();
  const counts = { poll: 0, status: 0, prepare: 0, acquired: 0, turns: 0, released: 0, aborted: 0, closed: 0, reads: 0 };
  const tickets: StandingIdleHistoryTicket[] = [];
  const manager = await openStandingHistoryTaskManager({ directories, passphrase, binding, signal: controller.signal, async onCancelled({ taskRef }) { await runner?.revoke(taskRef); } });
  const args: StandingHistoryTaskRunnerInput = { directories, passphrase, binding, signal: controller.signal, concurrentAnalysis: true,
    manager: { async status(input) { counts.status++; return manager.status(input); } },
    adapter: { async pollWork(): Promise<StandingPollWork> {
      counts.poll++;
      if (selection) { const selected = selection; selection = undefined; return { kind: "selected", selection: selected }; }
      const ticket: StandingIdleHistoryTicket = { openTaskReply() { throw Error("No delivery authorized in this fixture"); }, openHistoryTask() { counts.reads++; throw Error("Finite source must not read Telegram"); } };
      tickets.push(ticket); return { kind: "idle", ticket };
    } },
    async verifyOwnerSettled(nativeBinding) { return { schema: "standing-analysis-owner-settlement-v1", nativeBinding, resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" }; },
    connection: { concurrentAnalysis: true, async prepare() { counts.prepare++; return { restoration: true }; }, async acquireAnalysisAdmission(requestRef) {
      counts.acquired++; const nativeBinding = { epochId: "a".repeat(32), requestRef, purpose: "history-analysis" as const };
      return { nativeBinding, async turnAnalysis(req, input, tools) {
        counts.turns++; nativeEntered.resolve();
        try {
          assert.equal(JSON.parse(input).schema, "neurobro-history-analysis-input-v1"); await nativeRelease.promise;
          if (nativeAborted) throw Error("Synthetic native owner stopped after release gate");
          const scope = { requestRef: req, callRef: "material", signal: controller.signal };
          const material = await tools.analysisTools[0]!.call({}, scope) as EpochToolResult; assert.equal(material.success, true);
          tools.onToolResultSent({ requestRef: req, callRef: "material", name: "neurobro_analysis_material", result: material });
          const committed = await tools.analysisTools[2]!.call({ output: { summary: "Synthetic concurrent summary", claims: [] } }, { ...scope, callRef: "commit" }) as EpochToolResult;
          assert.equal(committed.success, true);
          return { kind: "analysis", scope: { epochId: nativeBinding.epochId, purpose: "history-analysis", requestRef: req, threadId: "synthetic-thread", turnId: "turn", turnNumber: 1, threadTurnNumber: 1 }, answer: "Recorded", toolCalls: 2, toolRefusals: 0 };
        } finally { nativeFinished.resolve(); }
      }, async releaseAnalysis() { counts.released++; }, async abortAndJoin() { counts.aborted++; nativeAborted = true; abortEntered.resolve(); await nativeFinished.promise; }, async close() { counts.closed++; } };
    } }
  };
  async function start(input = args) { runner = await openStandingHistoryTaskRunner(input); return runner; }
  t.after(async () => {
    nativeRelease.resolve(); await runner?.close(); await manager.close();
    assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-concurrent-runner-"))); await rm(root, { recursive: true, force: true });
  });
  return { args, intent, manager, controller, counts, tickets, nativeEntered, nativeRelease, nativeFinished, abortEntered, openStores, start,
    select(value: StandingSelection) { selection = value; } };
}
const running = (work: StandingHistoryTaskWork): boolean => work.kind === "background" && work.outcome.kind === "analysis-running";
async function until(runner: StandingHistoryTaskRunner, predicate: (work: StandingHistoryTaskWork) => boolean): Promise<StandingHistoryTaskWork> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const work = await runner.poll(); if (predicate(work)) return work; await delay(10); }
  return assert.fail("bounded runner observation did not reach the expected state");
}
async function startNative(f: Awaited<ReturnType<typeof fixture>>, runner: StandingHistoryTaskRunner) {
  await until(runner, work => running(work) && f.nativeEntered.settled);
  assert.equal(f.counts.acquired, 1); assert.equal(f.counts.turns, 1);
}

test("detached analysis uses background readiness without entering the foreground preparation lane", async t => {
  const f = await fixture(t); let backgroundPrepares = 0;
  const runner = await f.start({ ...f.args, connection: { ...f.args.connection,
    async prepare() { throw Error("Foreground turn is active"); },
    async prepareAnalysis() { backgroundPrepares++; return { restoration: false }; },
  } });
  await startNative(f, runner); assert.equal(backgroundPrepares, 1); f.nativeRelease.resolve();
  await until(runner, work => work.kind === "background" && work.outcome.kind === "analysis");
  await runner.close(); assert.equal(f.counts.released, 1);
});

test("foreground stays selectable during a yielded local planning drain without native admission", async t => {
  const f = await fixture(t, true, 8), runner = await f.start(), entered = deferred(), release = deferred();
  const before = await f.manager.status({ taskRef: f.intent.taskId, requesterId: f.intent.requesterId });
  const originalImmediate = timersPromises.setImmediate;
  const spy = t.mock.method(timersPromises, "setImmediate", async (...args: Parameters<typeof originalImmediate>) => {
    if (!entered.settled) { entered.resolve(); await release.promise; }
    return originalImmediate(...args);
  });
  syncBuiltinESMExports();
  try {
    await until(runner, running);
    assert.equal(running(await runner.poll()), true);
    await Promise.race([entered.promise, delay(15000, undefined, { ref: false }).then(() => assert.fail("local scan did not yield before its bounded test deadline"))]);
    const selection = { synthetic: "foreground while local planner yields" } as unknown as StandingSelection;
    f.select(selection); assert.deepEqual(await runner.poll(), { kind: "selected", selection });
    assert.equal(f.counts.turns, 0); assert.equal(f.counts.acquired, 0); assert.equal(f.counts.reads, 0);
    release.resolve();
    const ready = await until(runner, work => work.kind === "background" && work.outcome.kind === "ready");
    assert.ok(ready.kind === "background" && ready.outcome.kind === "ready");
    assert.equal(before.read.storage, "ready"); assert.equal(before.analysis.storage, "ready");
    if (before.read.storage !== "ready" || before.analysis.storage !== "ready") assert.fail();
    assert.equal(ready.outcome.result.sourceHead, before.read.readProgress.chainHash);
    assert.equal(ready.outcome.result.expectedHead, before.analysis.headHash);
    assert.equal(f.counts.turns, 0); assert.equal(f.counts.acquired, 0);
    assert.strictEqual(ready.outcome.ticket, f.tickets.at(-1));
  } finally { release.resolve(); spy.mock.restore(); syncBuiltinESMExports(); }
});

test("concurrent runner requires an explicit inert independent-worker connection marker", async t => {
  const f = await fixture(t), { concurrentAnalysis: _marker, ...connection } = f.args.connection;
  await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, connection }), /INPUT/);
  await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, concurrentAnalysis: false } as never), /INPUT/);
  let invoked = false;
  const getter = Object.defineProperty({ ...connection }, "concurrentAnalysis", { enumerable: true, get() { invoked = true; return true; } });
  await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, connection: getter }), /INPUT/); assert.equal(invoked, false);
  const proxy = new Proxy(f.args.connection, { getOwnPropertyDescriptor() { invoked = true; throw Error("Proxy marker trap must stay inert"); } });
  await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, connection: proxy }), /INPUT/); assert.equal(invoked, false);
  assert.equal(f.counts.poll, 0); assert.equal(f.counts.status, 0); assert.equal(f.counts.acquired, 0);
});

test("gated actual analysis leaves foreground selectable and every waiting poll retains one in-flight quantum", async t => {
  const f = await fixture(t), runner = await f.start(); await startNative(f, runner);
  const selection = { synthetic: "foreground while native waits" } as unknown as StandingSelection; f.select(selection);
  assert.deepEqual(await runner.poll(), { kind: "selected", selection }); assert.equal(f.nativeFinished.settled, false);
  const before = { ...f.counts };
  for (let i = 0; i < 6; i++) assert.equal(running(await runner.poll()), true);
  assert.equal(f.counts.poll, before.poll + 6); assert.equal(f.counts.status, before.status);
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.acquired, 1); assert.equal(f.counts.turns, 1); assert.equal(f.counts.reads, 0);
  await immediate(); assert.equal(f.counts.poll, before.poll + 6, "waiting analysis must not start autonomous adapter polling");
  f.nativeRelease.resolve();
  const completed = await until(runner, work => work.kind === "background" && work.outcome.kind === "analysis" && work.outcome.result.kind === "attempt");
  assert.ok(completed.kind === "background" && completed.outcome.kind === "analysis" && completed.outcome.result.kind === "attempt" && completed.outcome.result.node);
  assert.equal(f.counts.turns, 1); assert.equal(f.counts.released, 1); assert.equal(f.counts.closed, 1);
  await runner.close(); const stored = await f.openStores();
  try { assert.equal((await stored.analysis.status()).analysisNodes, 1); assert.equal((await stored.attempts.status()).attempts, 1); } finally { await stored.close(); }
});

test("durable cancellation waits for the in-flight native owner while foreground polling remains available", async t => {
  const f = await fixture(t), runner = await f.start(); await startNative(f, runner);
  let joined = false; const cancelling = f.manager.cancel({ taskRef: f.intent.taskId, requesterId: f.intent.requesterId }).then(result => { joined = true; return result; });
  await f.abortEntered.promise; await immediate(); assert.equal(joined, false); assert.equal(f.nativeFinished.settled, false);
  const selection = { synthetic: "foreground during native cancellation" } as unknown as StandingSelection; f.select(selection);
  assert.deepEqual(await runner.poll(), { kind: "selected", selection }); assert.equal(running(await runner.poll()), true);
  f.nativeRelease.resolve(); assert.equal((await cancelling).revocationJoined, true); assert.equal(joined, true);
  const completed = await until(runner, work => !running(work));
  assert.ok(completed.kind === "background" && (completed.outcome.kind === "stalled" && completed.outcome.reason === "cancelled" || completed.outcome.kind === "analysis" && (completed.outcome.result.kind === "cancelled" || completed.outcome.result.kind === "attempt" && completed.outcome.result.cancelled)));
  assert.equal(f.counts.aborted, 1); assert.equal(f.counts.closed, 1); assert.equal(f.counts.turns, 1);
  const status = await f.manager.status({ taskRef: f.intent.taskId, requesterId: f.intent.requesterId }); assert.equal(status.control.state, "cancelled");
  assert.ok(status.analysis.storage === "ready" && status.analysis.analysisNodes === 0);
  await runner.close();
});

test("close revokes immediately and joins the detached analysis before resolving", async t => {
  const f = await fixture(t), runner = await f.start(); await startNative(f, runner);
  let closed = false; const closing = runner.close().then(() => { closed = true; });
  await f.abortEntered.promise; await immediate(); assert.equal(closed, false); assert.equal(f.nativeFinished.settled, false);
  await assert.rejects(runner.poll(), /CLOSED/); f.nativeRelease.resolve(); await closing;
  assert.equal(closed, true); assert.equal(f.nativeFinished.settled, true); assert.equal(f.counts.aborted, 1); assert.equal(f.counts.closed, 1);
  const stored = await f.openStores(); try { assert.equal((await stored.analysis.status()).analysisNodes, 0); assert.equal((await stored.attempts.status()).attempts, 1); } finally { await stored.close(); }
});

test("completed asynchronous ready result receives the caller's fresh delivery ticket", async t => {
  const f = await fixture(t, true), runner = await f.start();
  const ready = await until(runner, work => work.kind === "background" && work.outcome.kind === "ready");
  assert.ok(ready.kind === "background" && ready.outcome.kind === "ready");
  assert.deepEqual(ready.outcome.intent, f.intent); assert.equal(ready.outcome.result.coverage.readTraversalComplete, true);
  assert.ok(f.tickets.length >= 3); assert.strictEqual(ready.outcome.ticket, f.tickets.at(-1));
  for (const expired of f.tickets.slice(0, -1)) assert.notStrictEqual(ready.outcome.ticket, expired);
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.turns, 0); assert.equal(f.counts.reads, 0);
});

test("durable cancellation of a completed detached ready result exposes no delivery ticket", async t => {
  const f = await fixture(t, true), readySeen = deferred();
  const runner = await f.start({ ...f.args, onAnalysisReady() { readySeen.resolve(); } });
  const deadline = Date.now() + 15000;
  while (!readySeen.settled && Date.now() < deadline) {
    const work = await runner.poll(); assert.ok(!(work.kind === "background" && work.outcome.kind === "ready"), "ready must remain detached until the next poll");
    await Promise.race([readySeen.promise, delay(10)]);
  }
  assert.equal(readySeen.settled, true);
  const cancelled = await f.manager.cancel({ taskRef: f.intent.taskId, requesterId: f.intent.requesterId }); assert.equal(cancelled.revocationJoined, true);
  const work = await runner.poll();
  assert.deepEqual(work, { kind: "background", outcome: { kind: "stalled", taskRef: f.intent.taskId, reason: "cancelled" } });
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.turns, 0); assert.equal(f.counts.reads, 0);
});
