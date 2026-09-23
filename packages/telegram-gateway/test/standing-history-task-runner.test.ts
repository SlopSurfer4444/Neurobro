import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
import { openStandingHistoryFinalReportStore } from "../src/standing-history-final-report-store.js";
import { StandingHistoryAnalysisStepError } from "../src/standing-history-analysis-step.js";
import timersPromises from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { READ_AHEAD_PAGES } from "../src/standing-history-analysis-limits.js";

test("stale analysis plan remains task-local with immutable disposition and foreground available", async t => {
  const f=await fixture(t), intent=await f.create("a",1); f.idle();
  const disposition=resolve(f.args.directories.pages,"..","disposition"); await mkdir(disposition);
  const runner=await f.start({...f.args,directories:{...f.args.directories,disposition},connection:{...f.args.connection,
    async acquireAnalysisAdmission(){throw new StandingHistoryAnalysisStepError("stale");}}});
  const result=(await until(runner,w=>w.kind==="background"&&w.outcome.kind==="task-blocked")).work;
  assert.deepEqual(result,{kind:"background",outcome:{kind:"task-blocked",taskRef:intent.taskId,reason:"stale"}});
  const before=f.counts.prepare;
  const next=(await until(runner,w=>w.kind==="background"&&w.outcome.kind==="task-blocked")).work;
  assert.deepEqual(next,result); assert.equal(f.counts.prepare,before); assert.equal(f.counts.turns,0);
  const selection={synthetic:"foreground survives stale task"} as unknown as StandingSelection;
  f.select(selection); assert.deepEqual(await runner.poll(),{kind:"selected",selection});
});

test("saved draft reopens only report-required task without replaying completed analysis", async t => {
  const f = await fixture(t), intent = await f.create("a",1,1); f.idle();
  const first = await f.start();
  const ready = (await until(first, w => w.kind === "background" && w.outcome.kind === "ready")).work;
  if (ready.kind !== "background" || ready.outcome.kind !== "ready") assert.fail();
  await first.close();
  const reports = resolve(f.args.directories.pages,"..","reports"), disposition = resolve(f.args.directories.pages,"..","disposition");
  await mkdir(reports); await mkdir(disposition);
  const plan = ready.outcome.result;
  assert.ok(plan.rootRef);
  const store = await openStandingHistoryFinalReportStore({ directory:reports,passphrase:f.args.passphrase,intent,
    sourceHead:plan.sourceHead,analysisHead:plan.expectedHead,rootRef:plan.rootRef,mode:"create" });
  await store.reserve({epochId:"e".repeat(32),requestRef:"saved-draft",purpose:"history-analysis"});
  await store.prepare({body:"Saved draft awaiting a separate quality review."}); await store.recordOutcome("observed"); await store.close();
  await recordStandingHistoryTaskDisposition({directory:disposition,passphrase:f.args.passphrase,intent,
    sourceHead:plan.sourceHead,analysisHead:plan.expectedHead,reason:"report-required"});
  const turns=f.counts.turns, reads=f.counts.read;
  const next=await f.start({...f.args,directories:{...f.args.directories,reports,disposition}});
  const resumed=(await until(next,w=>w.kind==="background"&&w.outcome.kind==="ready")).work;
  assert.equal(resumed.kind,"background"); assert.equal(f.counts.turns,turns); assert.equal(f.counts.read,reads);
  const saved=await readStandingHistoryTaskDisposition({directory:disposition,passphrase:f.args.passphrase,intent,
    sourceHead:plan.sourceHead,analysisHead:plan.expectedHead});
  assert.equal(saved.storage,"ready","original disposition remains immutable; only authenticated report continuation bypasses it");
});

for (const authorized of [false, true]) test(`cold outputless parallel reservation: explicit maintenance generation ${authorized}`, async t => {
  const f = await fixture(t), intent = await f.create("a", 2); f.idle();
  const parallel = { directory: resolve(f.args.directories.pages, "..", "parallel"), maxLeaves: 2 };
  await mkdir(parallel.directory);
  const s = await f.openStores(intent);
  try {
    const sourceHead = (await s.source.status()).readProgress.chainHash, expectedHead = (await s.analysis.status()).headHash;
    const works = [];
    for (let pageIndex = 1; pageIndex <= 2; pageIndex++) {
      const material = projectStandingHistorySource({ intent, referenceKey: s.analysis.referenceKey(), storedPage: (await s.source.readPage(pageIndex))!, maxBytes: 49152 });
      const inputs = [{ pageIndex, maxBytes: 49152, materialRef: material.materialRef }];
      works.push({ kind: "leaf" as const, inputs, modelInputHash: prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead,
        inputs: inputs as [typeof inputs[number]], material }).modelInputHash,
        nativeBinding: { epochId: "b".repeat(32), requestRef: "dead-owner-" + pageIndex, purpose: "history-analysis" as const } });
    }
    const journal = await openStandingHistoryParallelWorkStore({ directory: parallel.directory, intent, passphrase: f.args.passphrase, mode: "create", source: s.source, analysis: s.analysis });
    try { await journal.reserveWave({ sourceHead, expectedHead, works }); } finally { await journal.close(); }
  } finally { await s.close(); }
  const maintenanceDirectory = resolve(f.args.directories.pages, "..", "parallel-maintenance");
  if (authorized) {
    await mkdir(maintenanceDirectory);
    const s = await f.openStores(intent);
    try {
      await createStandingHistoryParallelMaintenance({ directory: maintenanceDirectory, originalJournalDirectory: parallel.directory,
        intent, passphrase: f.args.passphrase, signal: f.controller.signal,
        directories: { pages: f.args.directories.pages, control: f.args.directories.control, analysis: f.args.directories.analysis },
        authorization: { generationRef: "hmaint_" + "d".repeat(48), requestHash: "a".repeat(64),
          sourceHead: (await s.source.status()).readProgress.chainHash, analysisHead: (await s.analysis.status()).headHash,
          controlHead: (await s.control.status()).headHash,
          originalJournalHash: await hashStandingHistoryParallelMaintenanceJournal({ originalJournalDirectory: parallel.directory, intent, signal: f.controller.signal }) },
        async verifyOwnerSettled(nativeBinding) { return { nativeBinding, windowsBeforeAbsent: true, guestAbsent: true, windowsAfterAbsent: true,
          exclusiveCustody: true, receiptHash: "b".repeat(64) }; } });
    } finally { await s.close(); }
  }
  const runner = await f.start({ ...f.args, parallel: { ...parallel, maintenanceDirectory }, concurrentAnalysis: true, connection: { ...f.args.connection, concurrentAnalysis: true,
    async acquireParallelAnalysisAdmissions() { throw Object.assign(Error("cold owner has no settlement proof"), { code: "PRIOR_OWNER_UNAVAILABLE" }); },
    async verifyAnalysisWorkReleased() { throw Error("cold wave has no warm release"); } } });
  f.onPoll(() => new Promise(resolve => setTimeout(resolve, 10)));
  const result = (await until(runner, v => v.kind === "background" && (authorized ? v.outcome.kind === "analysis" && v.outcome.result.kind === "attempt" : v.outcome.kind === "stalled"), 500)).work;
  if (authorized) {
    assert.ok(result.kind === "background" && result.outcome.kind === "analysis");
    assert.equal(f.counts.turns, 1); assert.equal(f.counts.acquired, 1);
  } else {
    assert.ok(result.kind === "background" && result.outcome.kind === "stalled");
    assert.equal(result.outcome.reason, "prior-owner-unavailable");
    assert.equal(f.counts.turns, 0); assert.equal(f.counts.acquired, 0); assert.equal(f.counts.prepare, 1);
  }
  const selection = { synthetic: "foreground after dead background owner" } as unknown as StandingSelection;
  f.select(selection); assert.deepEqual(await runner.poll(), { kind: "selected", selection });
  const reopened = await f.openStores(intent);
  try {
    const journal = await openStandingHistoryParallelWorkStore({ directory: parallel.directory, intent, passphrase: f.args.passphrase, mode: "open", source: reopened.source, analysis: reopened.analysis });
    try {
      const status = await journal.status(); assert.equal(status.works, 2); assert.equal(status.projected, 0);
      for (const workRef of status.activeWave!.workRefs) {
        const work = await journal.readWork(workRef); assert.equal(work.output, undefined); assert.equal(work.modelOutcome, undefined);
      }
    } finally { await journal.close(); }
  } finally { await reopened.close(); }
});

test("explicit chronicle wiring reuses a second task fairly without preparing or inventing a native attempt", async t => {
  const f = await fixture(t), a = await f.create("a", 3, 1, true, undefined, "Same exact objective"), b = await f.create("b", 3, 1, true, undefined, "Same exact objective"); f.idle();
  const parent = resolve(f.args.directories.pages, ".."), cache = await openStandingHistoryChronicleCache({ directory: join(parent, "chronicle"), passphrase: f.args.passphrase }); t.after(() => cache.close());
  const producer = { model: "synthetic", promptVersion: "prompt-1", projectionVersion: "projection-1", outputVersion: "output-1" };
  const runner = await f.start({ ...f.args, chronicle: { cache, producer, reuseDirectory: join(parent, "reuse") } });
  const first = (await until(runner, attempted)).work; assert.ok(first.kind === "background" && first.outcome.kind === "analysis" && first.outcome.taskRef === a.taskId);
  const reused = (await until(runner, v => v.kind === "background" && v.outcome.kind === "analysis" && v.outcome.result.kind === "reused")).work;
  assert.ok(reused.kind === "background" && reused.outcome.kind === "analysis" && reused.outcome.taskRef === b.taskId);
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.acquired, 1); assert.equal(f.counts.turns, 1);
  assert.equal(f.counts.read, 0, "finite authenticated source needs no further Telegram reads for cache comparison"); assert.equal(f.counts.readClosed, f.counts.read);
  const stores = await f.openStores(b); try { assert.equal((await stores.analysis.status()).analysisNodes, 2); assert.equal((await stores.attempts.status()).attempts, 0); } finally { await stores.close(); }
  const selection = { synthetic: "foreground after cache quantum" } as unknown as StandingSelection; f.select(selection);
  assert.deepEqual(await runner.poll(), { kind: "selected", selection }); await runner.close();
  assert.equal((await cache.catalog({ intent: a, producer })).length, 1, "runner must not close service-owned cache");
});

test("runner refuses malformed optional chronicle identity before adapter or discovery work", async t => {
  const f = await fixture(t); let touched = 0;
  const cache = { async lookup() { touched++; }, async remember() { touched++; }, async catalog() { return []; }, async close() {} };
  const producer = { model: "synthetic", promptVersion: "p", projectionVersion: "s", outputVersion: "o" }, reuseDirectory = resolve(f.args.directories.pages, "..", "reuse");
  for (const chronicle of [undefined, { cache, producer: { ...producer, model: "" }, reuseDirectory }, { cache, producer, reuseDirectory: f.args.directories.pages }]) {
    await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, chronicle } as never), /INPUT/);
  }
  assert.equal(touched, 0); assert.equal(f.due.length, 0);
});

test("missing prior owner stalls only that task and suppresses repeated preparation", async t => {
  const f = await fixture(t); await f.create("a", 1); f.idle(); let prepares = 0;
  const runner = await f.start({ ...f.args, connection: { ...f.args.connection, async prepare() {
    prepares++; throw Object.assign(new Error("bounded missing prior evidence"), { code: "PRIOR_OWNER_UNAVAILABLE" });
  } } });
  let blocked = false;
  for (let i = 0; i < 40; i++) {
    const result = await runner.poll();
    if (result.kind === "background" && result.outcome.kind === "stalled" && result.outcome.reason === "prior-owner-unavailable") { blocked = true; break; }
  }
  assert.equal(blocked, true); assert.equal(prepares, 1);
  for (let i = 0; i < 10; i++) await runner.poll();
  assert.equal(prepares, 1); assert.equal(f.counts.turns, 0);
});

test("runner accepts borrowed period chronicle and rejects malformed workspace before discovery", async t => {
  const f = await fixture(t); let closed = 0, touched = 0;
  const store = { async lookup() { touched++; return undefined; }, async remember() { touched++; return undefined; }, async close() { closed++; } };
  const cache = { ...store, async catalog() { return []; } };
  const chronicle = { cache, producer: { model: "synthetic", promptVersion: "p", projectionVersion: "s", outputVersion: "o" },
    reuseDirectory: resolve(f.args.directories.pages, "..", "reuse"), periods: { store, workspaceId: "fixture-workspace" } };
  for (const periods of [{ store, workspaceId: "" }, { store: { ...store, lookup: undefined }, workspaceId: "fixture-workspace" }]) {
    await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, chronicle: { ...chronicle, periods } } as never), /INPUT/);
  }
  const runner = await f.start({ ...f.args, chronicle }); await runner.close();
  assert.equal(touched, 0); assert.equal(closed, 0, "runner borrows the service-owned stores"); assert.equal(f.due.length, 0);
});

test("verified terminal recall captures once per runner, reuses warm capture and never sends or invokes native work", async t => {
  const f = await fixture(t), intent = await f.create("d", 1, 0, true); f.idle();
  const reservation = await seedPending(f, intent, true), saved = await f.openStores(intent);
  try { await saved.attempts.commitPrepared({ attemptRef: reservation.attemptRef });
    await saved.attempts.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome: "observed" });
  } finally { await saved.close(); }
  const delivery = resolve(f.args.directories.pages, "..", "delivery"); await mkdir(delivery);
  const directories = { ...f.args.directories, delivery }; let warmCaptures = 0, coldCaptures = 0, statusCalls = 0;
  const warm = await f.start({ ...f.args, directories, onAnalysisReady(event) {
    assert.equal(event.intent.taskId, intent.taskId); assert.equal(event.note.notes.summary.text, "Saved before crash"); warmCaptures++;
  } });
  const ready = (await until(warm, value => value.kind === "background" && value.outcome.kind === "ready")).work;
  assert.equal(ready.kind, "background"); if (ready.kind !== "background" || ready.outcome.kind !== "ready") assert.fail("expected ready");
  assert.equal(warmCaptures, 1);
  let sent: PilotSend | undefined; const sends = { open: 0, send: 0, read: 0, close: 0 };
  const result = await runStandingHistoryTaskDelivery({ intent, readiness: ready.outcome.result, directories, finalReport: { schema: "standing-history-final-report-v1", taskRef: intent.taskId, sourceHead: ready.outcome.result.sourceHead, analysisHead: ready.outcome.result.expectedHead, body: "Synthetic user-facing report" },
    passphrase: f.args.passphrase, signal: f.args.signal,
    async verifyOwnerReady(nativeBinding) { return { schema: "standing-analysis-owner-ready-v1", nativeBinding,
      basis: "released-current-owner", modelOutcome: "not-proven" }; },
    ticket: { openTaskReply({ intent: selected }) { assert.deepEqual(selected, intent); sends.open++;
      return { transport: { async sendOnce(reply) { sent = reply; sends.send++; return { messageId: 2001 }; },
        async readExact(chatId, messageId) { sends.read++; assert.ok(sent); return { chatId, messageId, accountId: intent.accountId,
          replyToMessageId: sent.replyToMessageId, text: sent.text }; } }, async close() { sends.close++; } };
    } } });
  assert.equal(result.result.state, "verified"); assert.equal(result.deliveryComplete, true);
  assert.equal((await readStandingHistoryTaskDelivery({ directory: delivery, passphrase: f.args.passphrase, intent })).delivery, "verified");
  const terminalPath = join(delivery, intent.taskId, "pilot", "terminal.enc"), terminalBytes = await readFile(terminalPath);
  assert.equal(terminalBytes.toString().includes("Saved before crash"), false);
  for (let i = 0; i < 3; i++) await until(warm, value => value.kind === "background" && value.outcome.kind === "delivery-state");
  assert.equal(warmCaptures, 1, "warm ready capture must mark terminal recall as already seen"); await warm.close();
  const cold = await f.start({ ...f.args, directories,
    manager: { async status() { statusCalls++; throw Error("terminal recall must not reopen manager status"); } },
    onAnalysisReady(event) {
      assert.equal(event.intent.taskId, intent.taskId);
      const note = requireStandingChronicleNote(event.note, { ...f.args.binding, requesterId: intent.requesterId });
      assert.equal(note.notes.summary.text, "Saved before crash"); assert.equal(note.notes.claimsStatus, "model-authored-unverified");
      coldCaptures++; throw Error("optional cold cache consumer failure");
    } });
  for (let i = 0; i < 3; i++) await until(cold, value => value.kind === "background" && value.outcome.kind === "delivery-state");
  assert.equal(coldCaptures, 1); assert.equal(statusCalls, 0);
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.acquired, 0); assert.equal(f.counts.turns, 0); assert.equal(f.counts.read, 0);
  assert.deepEqual(sends, { open: 1, send: 1, read: 1, close: 1 }); assert.deepEqual(await readFile(terminalPath), terminalBytes);
});

test("runner forwards ready note capture before its existing step close without preparing native work", async t => {
  const f = await fixture(t), intent = await f.create("c", 1, 1, true); f.idle(); let captures = 0;
  const runner = await f.start({ ...f.args, onAnalysisReady(event) {
    assert.equal(event.intent.taskId, intent.taskId);
    const note = requireStandingChronicleNote(event.note, { ...f.args.binding, requesterId: intent.requesterId });
    assert.equal(note.notes.summary.text, "Existing note 0"); captures++; throw Error("optional cache failure");
  } });
  const result = await until(runner, v => v.kind === "background" && v.outcome.kind === "ready");
  assert.equal(result.seen.at(-1)?.kind, "background"); assert.equal(captures, 1);
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.turns, 0); assert.equal(f.counts.acquired, 0);
});

test("runner rejects invalid ready observers before discovery or callback execution", async t => {
  const f = await fixture(t); let evaluated = 0;
  for (const onAnalysisReady of [undefined, null, async () => {}, function* () {}, async function* () {}, new Proxy(() => {}, { apply() { evaluated++; throw Error(); } })]) {
    await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, onAnalysisReady } as never), /INPUT/);
  }
  const hostile = { ...f.args }; Object.defineProperty(hostile, "onAnalysisReady", { enumerable: true, get() { evaluated++; throw Error(); } });
  await assert.rejects(openStandingHistoryTaskRunner(hostile), /INPUT/); assert.equal(evaluated, 0);
  assert.equal(f.due.length, 0); assert.equal(f.counts.prepare, 0);
});

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function page(before: SelfHistoryTaskCheckpoint, empty = false): SelfHistoryTaskPage {
  const id = (before.offsetId || 1000) - 1, date = before.lastDate - 1, ref = "m_" + id.toString(16).padStart(24, "0");
  const next = empty ? { ...before, pages: before.pages + 1, status: "empty-page" as const } :
    { ...before, pages: before.pages + 1, offsetId: id, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date, upperBoundMessageId: before.upperBoundMessageId ?? id };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: empty ? [] : [{ messageId: id, date, disposition: "included", messageRef: ref, authorId: "456" }], page: {
    schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
    messages: empty ? [] : [{ ref, authorRef: "a_" + "4".repeat(24), author: "user", displayName: "Synthetic speaker", date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Synthetic source " + id }],
    cursor: null, hasMore: !empty, status: empty ? "empty-page" : "more", coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: empty, undatedEntries: 0, pages: next.pages },
    excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-task-runner-"));
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts") };
  for (const dir of Object.values(directories)) await mkdir(dir);
  const passphrase = "synthetic-task-runner-passphrase", binding = { accountId: "123", peerId: "-100456" }, controller = new AbortController();
  let runner: StandingHistoryTaskRunner | undefined, queued = true, selection: StandingSelection | undefined;
  let onPoll: (() => Promise<void>) | undefined, onRead: ((signal: AbortSignal) => Promise<void>) | undefined;
  let onPrepare: (() => Promise<void>) | undefined;
  let nativeMode: "commit" | "unknown" | "wait" | "observed-without-commit" | "refused" = "commit";
  let nativeEpoch = "a".repeat(32);
  let terminalRead = Infinity;
  const due: boolean[] = [], counts = { prepare: 0, acquired: 0, turns: 0, released: 0, aborted: 0, closed: 0, read: 0, readClosed: 0 };
  const nativeEntered = deferred(), nativeStopped = deferred(), nativeFinished = deferred();
  const settlements: StandingHistoryAnalysisNativeBinding[] = [];
  const manager = await openStandingHistoryTaskManager({ directories, passphrase, binding, signal: controller.signal,
    async onCancelled({ taskRef }) { await runner?.revoke(taskRef); } });
  const ticket: StandingIdleHistoryTicket = { openTaskReply() { throw Error("runner must not send"); }, openHistoryTask({ checkpoint, signal }) {
    let stopped = false;
    return { async readTaskPage() { counts.read++; await onRead?.(signal); if (stopped || signal.aborted) throw Error("synthetic revoked"); assert.ok(checkpoint); return page(checkpoint, counts.read >= terminalRead); },
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
    connection: { async prepare() { counts.prepare++; await onPrepare?.(); return { restoration: true }; }, async acquireAnalysisAdmission(requestRef, previous, options) {
      if (options?.requireNewEpoch && previous?.epochId === nativeEpoch) nativeEpoch = (BigInt('0x'+nativeEpoch) + 1n).toString(16).padStart(32,'0');
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
  t.after(async () => { await runner?.close(); await manager.close(); assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-task-runner-"))); await rm(root, { recursive: true, force: true }); });
  return { args, counts, due, settlements, create, openStores, start, manager, controller, nativeEntered,
    epoch(value: string) { nativeEpoch = value; },
    terminalRead(value: number) { terminalRead = value; },
    idle() { queued = false; }, select(value: StandingSelection) { selection = value; }, onPoll(value: typeof onPoll) { onPoll = value; }, onRead(value: typeof onRead) { onRead = value; }, onPrepare(value: typeof onPrepare) { onPrepare = value; }, mode(value: typeof nativeMode) { nativeMode = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const observedSource = { kind: "observed-source", sourceRef: "community", workspaceId: "synthetic-team-v1", peerId: "-100888" } as const;
test("source tasks stall before status, reads or native work when the host pin is absent or changed", async t => {
  for (const pin of [undefined, { ...observedSource, peerId: "-100889" }, { ...observedSource, workspaceId: "other-team-v1" }]) {
    const f = await fixture(t), intent = await f.create("a", 0, 0, false, observedSource); f.idle();
    const stores = await f.openStores(intent), before = await stores.source.status(); await stores.close();
    let statuses = 0, recalls = 0;
    const runner = await f.start({ ...f.args, ...(pin ? { observedSource: pin } : {}),
      onDiscovered() { recalls++; },
      manager: { async status() { statuses++; throw Error("unavailable source must not inspect task status"); } } });
    const result = (await until(runner, v => v.kind === "background" && v.outcome.kind === "stalled")).work;
    assert.deepEqual(result, { kind: "background", outcome: { kind: "stalled", taskRef: intent.taskId, reason: "source-unavailable" } });
    assert.equal(statuses, 0); assert.equal(recalls, 0); assert.equal(f.counts.read, 0); assert.equal(f.counts.prepare, 0); assert.equal(f.counts.acquired, 0); assert.equal(f.counts.turns, 0);
    const after = await f.openStores(intent); assert.deepEqual(await after.source.status(), before); await after.close();
    assert.equal((await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId })).taskRef, intent.taskId);
    await f.manager.cancel({ taskRef: intent.taskId, requesterId: intent.requesterId });
    assert.equal((await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId })).control.state, "cancelled");
    await runner.close();
  }
});

test("matching source pin admits status and is snapshotted; unavailable source does not block an internal task", async t => {
  const f = await fixture(t), sourceTask = await f.create("a", 0, 0, false, observedSource); f.idle();
  const pin = { ...observedSource }; let statusCalls = 0;
  const matching = await f.start({ ...f.args, observedSource: pin,
    manager: { async status() { statusCalls++; throw Error("synthetic unavailable task state"); } } });
  Object.assign(pin, { peerId: "-100999" });
  assert.deepEqual((await until(matching, v => v.kind === "background" && v.outcome.kind === "stalled")).work,
    { kind: "background", outcome: { kind: "stalled", taskRef: sourceTask.taskId, reason: "unavailable" } });
  assert.equal(statusCalls, 1); await matching.close();
  const internal = await f.create("b"), runner = await f.start();
  const read = await until(runner, v => v.kind === "background" && v.outcome.kind === "read");
  assert.equal(read.work.kind, "background");
  if (read.work.kind !== "background" || read.work.outcome.kind !== "read") assert.fail();
  assert.equal(read.work.outcome.taskRef, internal.taskId); assert.equal(f.counts.read, 1);
});

test("source pin input rejects extra fields, absent values and getters before any adapter or task work", async t => {
  const f = await fixture(t); let evaluated = 0;
  const hostile = { ...observedSource }; Object.defineProperty(hostile, "peerId", { enumerable: true, get() { evaluated++; return "-100888"; } });
  for (const pin of [undefined, null, { ...observedSource, targetChat: "other" }, hostile, new Proxy(observedSource, {})]) {
    await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, observedSource: pin } as never), /INPUT/);
  }
  assert.equal(evaluated, 0); assert.equal(f.due.length, 0);
});

async function until(runner: StandingHistoryTaskRunner, match: (v: StandingHistoryTaskWork) => boolean, max = 60) {
  const seen: StandingHistoryTaskWork[] = [];
  for (let i = 0; i < max; i++) { const work = await runner.poll(); seen.push(work); if (match(work)) return { work, seen }; }
  assert.fail("finite synthetic traversal did not finish");
}
const attempted = (v: StandingHistoryTaskWork) => v.kind === "background" && v.outcome.kind === "analysis" && v.outcome.result.kind === "attempt";

test("large packed analysis and merge reuse one workspace across discovery and foreground without reopening manager chains", async t => {
  const f = await fixture(t), old = await f.create("a", 1), intent = await f.create("b", 17, 8, true);
  await f.manager.cancel({ taskRef: old.taskId, requesterId: old.requesterId });
  const requests: string[] = []; let activeStatuses = 0;
  const runner = await f.start({ ...f.args,
    manager: { async status(input) { if (input.taskRef === intent.taskId) activeStatuses++; return f.manager.status(input); } },
    connection: { ...f.args.connection, async acquireAnalysisAdmission(requestRef, previous) {
      requests.push(requestRef); return f.args.connection.acquireAnalysisAdmission(requestRef, previous);
    } } });
  await until(runner, attempted);
  const selected = { synthetic: true } as unknown as StandingSelection; f.select(selected);
  assert.deepEqual(await runner.poll(), { kind: "selected", selection: selected });
  await until(runner, attempted);
  assert.equal(activeStatuses, 1, "cancelled historical task must not evict the active working state");
  assert.equal(f.counts.turns, 2); assert.equal(f.counts.read, 0);
  assert.equal(new Set(requests).size, 2, "every new node still needs a new native request");
  assert.equal(f.counts.closed, 2); assert.equal(f.counts.released, 2, "no native lease is parked");
  const status = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  if (status.analysis.storage !== "ready" || status.attempts?.storage !== "ready") assert.fail();
  assert.equal(status.analysis.analysisNodes, 10); assert.equal(status.attempts.attempts, 2);
  const { work } = await until(runner, v => v.kind === "background" && v.outcome.kind === "ready");
  if (work.kind !== "background" || work.outcome.kind !== "ready") assert.fail();
  assert.equal(work.outcome.result.coverage.sourceRows, 16); assert.equal(work.outcome.result.coverage.coveredRows, 16);
  assert.equal(work.outcome.result.coverage.committedPages, 17); assert.equal(work.outcome.result.coverage.coveredPages, 17);
  assert.equal(work.outcome.result.coverage.readTraversalComplete, true);
  assert.equal(f.counts.turns, 2); assert.equal(activeStatuses, 1, "packed leaf and its merge reuse the same authenticated workspace");
  const stored = await f.openStores(intent);
  try {
    const nodes = [];
    for (let index = 1; index <= 10; index++) { const node = await stored.analysis.readNodeAt(index); assert.ok(node); nodes.push(node); }
    assert.deepEqual(nodes.slice(8).map(node => node!.kind), ["leaf", "merge"]);
    assert.equal("materials" in nodes[8]!.inputs ? nodes[8]!.inputs.materials.length : 0, 9, "large production packing exceeds the historical eight-fragment batch");
    assert.deepEqual(nodes.slice(0, 9).flatMap(node => node!.coverage.map(span => span.pageIndex)), Array.from({ length: 17 }, (_, i) => i + 1));
    const root = nodes[9]!;
    assert.deepEqual("children" in root.inputs ? root.inputs.children : [], nodes.slice(0, 9).map(node => node!.nodeRef));
  } finally { await stored.close(); }
  await runner.close(); await assert.rejects(runner.poll(), /CLOSED/);
});

test("parked working state does not change round-robin admission of two runnable tasks", async t => {
  const f = await fixture(t), a = await f.create("a", 16, 8), b = await f.create("b", 16, 8); f.idle();
  const statuses: string[] = [], admitted: string[] = [];
  const runner = await f.start({ ...f.args, manager: { async status(input) { statuses.push(input.taskRef); return f.manager.status(input); } } });
  for (let i = 0; i < 4; i++) {
    const { work } = await until(runner, attempted);
    if (work.kind !== "background" || work.outcome.kind !== "analysis") assert.fail();
    admitted.push(work.outcome.taskRef);
  }
  assert.deepEqual(admitted, [a.taskId, b.taskId, a.taskId, b.taskId]);
  assert.deepEqual(statuses, admitted, "other runnable task evicts previous workspace before admission");
  assert.equal(f.counts.turns, 4); assert.equal(f.counts.closed, 4);
});

test("persisted cancellation revokes a parked successful workspace before another native turn", async t => {
  const f = await fixture(t), intent = await f.create("a", 9); f.idle(); const runner = await f.start();
  await until(runner, attempted);
  const cancelled = await f.manager.cancel({ taskRef: intent.taskId, requesterId: intent.requesterId });
  assert.equal(cancelled.revocationJoined, true);
  const { work } = await until(runner, v => v.kind === "background" && v.outcome.kind === "stalled");
  assert.deepEqual(work, { kind: "background", outcome: { kind: "stalled", taskRef: intent.taskId, reason: "cancelled" } });
  assert.equal(f.counts.turns, 1); assert.equal(f.counts.acquired, 1);
});

test("persisted cancellation without revoke remains task-local when working state is parked", async t => {
  const f = await fixture(t), intent = await f.create("a", 9); f.idle(); const runner = await f.start();
  await until(runner, attempted);
  const control = await openStandingHistoryTaskControlStore({ directory: f.args.directories.control, intent, passphrase: f.args.passphrase, mode: "open" });
  try { await control.cancel({ expectedRevision: 0 }); } finally { await control.close(); }
  const { work } = await until(runner, v => v.kind === "background" && v.outcome.kind === "stalled");
  assert.deepEqual(work, { kind: "background", outcome: { kind: "stalled", taskRef: intent.taskId, reason: "cancelled" } });
  assert.equal(f.counts.turns, 1); assert.equal(f.counts.acquired, 1);
  const selection = { synthetic: true } as unknown as StandingSelection; f.select(selection);
  assert.deepEqual(await runner.poll(), { kind: "selected", selection });
});

test("a new exact-head disposition while parked blocks warm admission", async t => {
  const f = await fixture(t), intent = await f.create("a", 9); f.idle();
  const disposition = resolve(f.args.directories.pages, "..", "disposition"); await mkdir(disposition);
  const runner = await f.start({ ...f.args, directories: { ...f.args.directories, disposition } });
  await until(runner, attempted);
  const saved = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  if (saved.read.storage !== "ready" || saved.analysis.storage !== "ready") assert.fail();
  await recordStandingHistoryTaskDisposition({ directory: disposition, passphrase: f.args.passphrase, intent,
    sourceHead: saved.read.readProgress.chainHash, analysisHead: saved.analysis.headHash, reason: "coverage" });
  const { work } = await until(runner, v => v.kind === "background" && v.outcome.kind === "task-blocked");
  assert.deepEqual(work, { kind: "background", outcome: { kind: "task-blocked", taskRef: intent.taskId, reason: "coverage" } });
  assert.equal(f.counts.turns, 1); assert.equal(f.counts.acquired, 1);
});

test("a new delivery slot while parked takes the cold terminal path without another model turn", async t => {
  const f = await fixture(t), intent = await f.create("a", 9); f.idle();
  const delivery = resolve(f.args.directories.pages, "..", "delivery"); await mkdir(delivery);
  const runner = await f.start({ ...f.args, directories: { ...f.args.directories, delivery } });
  await until(runner, attempted); await mkdir(join(delivery, intent.taskId));
  const { work } = await until(runner, v => v.kind === "background" && v.outcome.kind === "delivery-state");
  assert.deepEqual(work, { kind: "background", outcome: { kind: "delivery-state", taskRef: intent.taskId, state: "not-inspected" } });
  assert.equal(f.counts.turns, 1); assert.equal(f.counts.acquired, 1);
});

async function seedPending(f: Fixture, intent: StandingHistoryTaskIntent, prepared: boolean) {
  const s = await f.openStores(intent), planner = createStandingHistoryAnalysisPlanner({ intent, source: s.source, analysis: s.analysis });
  try {
    let plan = await planner.next(); while (plan.kind === "scan-more") plan = await planner.next();
    assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") throw Error();
    const material = prepareStandingHistoryAnalysisMaterial(plan);
    const attemptPlan: StandingHistoryAnalysisAttemptPlan = { kind: "leaf", sourceHead: plan.sourceHead, expectedHead: plan.expectedHead,
      nodeIndex: 1, modelInputHash: material.modelInputHash, inputs: plan.inputs };
    const reserved = await s.attempts.reserve({ plan: attemptPlan, nativeBinding: { epochId: "b".repeat(32), requestRef: "old-consumed", purpose: "history-analysis" } });
    if (prepared) await s.attempts.prepare({ attemptRef: reserved.attemptRef, output: { summary: "Saved before crash", claims: [] } });
    return reserved;
  } finally { await planner.close(); await s.close(); }
}

test("local planner scan drain preserves foreground credit and rotates after one actual model turn", async t => {
  const f = await fixture(t), a = await f.create("a", 10, 9), b = await f.create("b", 1), runner = await f.start();
  const first = await until(runner, attempted), second = await until(runner, attempted);
  const results = [...first.seen, ...second.seen];
  const taskRefs = results.filter(attempted).map(v => v.kind === "background" && v.outcome.kind === "analysis" ? v.outcome.taskRef : "");
  assert.deepEqual(new Set(taskRefs), new Set([a.taskId, b.taskId]));
  assert.ok(results.length < 18, "small local scans must no longer require a Telegram poll per planner quantum");
  assert.ok(results.every(v => v.kind !== "idle"));
  assert.deepEqual(f.due, f.due.map((_, i) => i % 3 === 2));
  assert.equal(f.counts.prepare, 2); assert.equal(f.counts.turns, 2); assert.equal(f.counts.released, 2); assert.equal(f.counts.read, 0);
});

test("empty tasks read one page then rotate fairly, using fresh tickets without native preparation", async t => {
  const f = await fixture(t), a = await f.create("a"), b = await f.create("b"), runner = await f.start();
  const isRead = (v: StandingHistoryTaskWork) => v.kind === "background" && v.outcome.kind === "read";
  const one = await until(runner, isRead), two = await until(runner, isRead);
  assert.deepEqual(new Set([one.work, two.work].map(v => v.kind === "background" && v.outcome.kind === "read" ? v.outcome.taskRef : "")), new Set([a.taskId, b.taskId]));
  assert.equal(f.counts.read, 2); assert.equal(f.counts.readClosed, 2); assert.equal(f.counts.prepare, 0);
  const saved = await f.manager.status({ taskRef: a.taskId, requesterId: "456" });
  assert.equal(saved.read.storage, "ready"); if (saved.read.storage === "ready") assert.equal(saved.read.readProgress.committedPages, 1);
});

test("64-page read-ahead preserves the workspace, yields foreground credit and replans before further reads", async t => {
  const f = await fixture(t), intent = await f.create("a", 1, 1, false); let statuses = 0;
  const runner = await f.start({ ...f.args, manager: { async status(input) { statuses++; return f.manager.status(input); } } });
  await until(runner, v => v.kind === "background" && v.outcome.kind === "analysis" && v.outcome.result.kind === "read-more");
  const originalPage = join(f.args.directories.pages, intent.taskId, "page-000001.enc");
  const originalNode = join(f.args.directories.analysis, intent.taskId, "node-000001.enc");
  const pageBytes = await readFile(originalPage), nodeBytes = await readFile(originalNode);
  const archiveReads: string[] = [], realOpen = fsPromises.open;
  const spy = t.mock.method(fsPromises, "open", (...args: Parameters<typeof realOpen>) => {
    const path = String(args[0]);
    if (args[1] === "r" && (path === originalPage || path === originalNode || path.startsWith(f.args.directories.attempts))) archiveReads.push(path);
    return realOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < READ_AHEAD_PAGES; i++) {
      const { work } = await until(runner, v => v.kind === "background" && v.outcome.kind === "read");
      assert.equal(work.kind, "background"); if (work.kind !== "background" || work.outcome.kind !== "read") assert.fail();
      assert.equal(work.outcome.result.kind, "committed");
    }
    assert.equal(statuses, 1); assert.deepEqual(archiveReads, [], "retained page reads must not decrypt old pages, nodes or attempts");
    assert.equal(f.counts.turns, 0); assert.equal(f.counts.read, READ_AHEAD_PAGES); assert.equal(f.counts.readClosed, READ_AHEAD_PAGES);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  const replanned = await until(runner, v => v.kind === "background" && v.outcome.kind === "analysis" && v.outcome.result.kind === "read-more");
  assert.ok(replanned.seen.every(v => !(v.kind === "background" && v.outcome.kind === "read")), "no 65th read is admitted before planner inspection");
  assert.equal(f.counts.read, READ_AHEAD_PAGES);
  f.terminalRead(READ_AHEAD_PAGES + 1);
  await until(runner, attempted);
  assert.equal(f.counts.read, READ_AHEAD_PAGES + 1, "a terminal page ends read-ahead immediately instead of requiring another full window");
  assert.equal(statuses, 1); assert.equal(f.counts.turns, 1);
  assert.deepEqual(f.due, f.due.map((_, i) => i % 3 === 2), "every page still yields two foreground pulses");
  const saved = await f.openStores(intent);
  try {
    const node = await saved.analysis.readNodeAt(2); assert.ok(node);
    assert.deepEqual(node.coverage.map(span => span.pageIndex), Array.from({ length: READ_AHEAD_PAGES + 1 }, (_, i) => i + 2), "planner sees every newly authenticated page exactly once");
    assert.equal((await saved.source.status()).readProgress.committedPages, READ_AHEAD_PAGES + 2);
  } finally { await saved.close(); }
  assert.deepEqual(await readFile(originalPage), pageBytes); assert.deepEqual(await readFile(originalNode), nodeBytes);
});

test("persisted cancellation between read-ahead pages blocks the next read without a local revoke", async t => {
  const f = await fixture(t), intent = await f.create("a"); f.idle(); const runner = await f.start();
  await until(runner, v => v.kind === "background" && v.outcome.kind === "read");
  const control = await openStandingHistoryTaskControlStore({ directory: f.args.directories.control, passphrase: f.args.passphrase, intent, mode: "open" });
  try { const before = await control.status(); await control.cancel({ expectedRevision: before.revision }); } finally { await control.close(); }
  const { work } = await until(runner, v => v.kind === "background" && v.outcome.kind === "read");
  if (work.kind !== "background" || work.outcome.kind !== "read") assert.fail();
  assert.equal(work.outcome.result.kind, "cancelled"); assert.equal(f.counts.read, 1); assert.equal(f.counts.turns, 0);
});

test("restart after prefetched page resumes its saved checkpoint without reading the page again", async t => {
  const f = await fixture(t), intent = await f.create("a"); f.idle(); const runner = await f.start();
  await until(runner, v => v.kind === "background" && v.outcome.kind === "read"); await runner.close();
  let restartedReads = 0;
  const restarted = await f.start({ ...f.args, adapter: { async pollWork() { return { kind: "idle", ticket: {
    openTaskReply() { throw Error("no send"); },
    openHistoryTask({ checkpoint }) { assert.ok(checkpoint); assert.equal(checkpoint.pages, 1);
      return { async readTaskPage() { restartedReads++; return page(checkpoint, true); }, async close() {} };
    }
  } }; } } });
  await until(restarted, attempted);
  assert.equal(f.counts.read, 1); assert.equal(restartedReads, 1); assert.equal(f.counts.turns, 1);
  const saved = await f.openStores(intent);
  try { assert.equal((await saved.source.status()).readProgress.committedPages, 2);
    assert.deepEqual((await saved.analysis.readNodeAt(1))!.coverage.map(span => span.pageIndex), [1, 2]);
  } finally { await saved.close(); }
});

test("prepared output recovers without a model call while only the unprepared task receives a successor", async t => {
  const f = await fixture(t), a = await f.create("a", 1), b = await f.create("b", 1), reserved = await seedPending(f, a, true);
  await seedPending(f, b, false); f.idle(); const runner = await f.start();
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) { const work = await runner.poll(); if (work.kind === "background") outcomes.push(work.outcome.kind); }
  assert.ok(outcomes.includes("recovered")); assert.ok(outcomes.includes("analysis"));
  const saved = await f.manager.status({ taskRef: a.taskId, requesterId: "456" });
  assert.equal(saved.attempts?.storage, "ready"); if (saved.attempts?.storage === "ready") { assert.equal(saved.attempts.last?.attemptRef, reserved.attemptRef); assert.equal(saved.attempts.last?.modelOutcome, "unknown"); assert.ok(saved.attempts.last?.node); }
  const continued = await f.manager.status({ taskRef: b.taskId, requesterId: "456" });
  if (continued.attempts?.storage !== "ready") assert.fail();
  assert.equal(continued.attempts.attempts, 2); assert.ok(continued.attempts.last?.node);
  await assert.rejects(readFile(join(f.args.directories.attempts, b.taskId, "attempt-000001.native.enc")), { code: "ENOENT" });
  assert.equal(f.settlements[0]?.requestRef, "old-consumed"); assert.equal(f.counts.turns, 1);
});

test("typed no-admission continues after runner reopen on a new epoch without rereading source", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.idle(); f.mode("refused");
  const runner = await f.start(); await until(runner, attempted); await runner.close();
  const before = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  if (before.attempts?.storage !== "ready" || before.read.storage !== "ready") assert.fail();
  assert.equal(before.attempts.last?.modelOutcome, "refused"); assert.equal(before.attempts.attempts, 1);
  f.epoch("c".repeat(32)); f.mode("commit"); const reopened = await f.start(); await until(reopened, attempted);
  const after = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  if (after.attempts?.storage !== "ready" || after.analysis.storage !== "ready") assert.fail();
  assert.equal(after.attempts.attempts, 2); assert.equal(after.analysis.analysisNodes, 1);
  assert.equal(after.attempts.last?.planHash, before.attempts.last?.planHash);
  assert.notEqual(after.attempts.last?.nativeBinding?.requestRef, before.attempts.last?.nativeBinding?.requestRef);
  assert.equal(after.attempts.last?.nativeBinding?.epochId, "c".repeat(32));
  assert.deepEqual(after.read, before.read); assert.equal(f.counts.read, 0); assert.equal(f.counts.turns, 2);
  assert.deepEqual(f.settlements[0], before.attempts.last?.nativeBinding);
});

test("legacy refused plan survives wide successor and restart packing with original records intact", async t => {
  const f = await fixture(t), intent = await f.create("a", 4); f.idle();
  const reserved = await seedPending(f, intent, false), stores = await f.openStores(intent);
  await stores.attempts.recordModelOutcome({ attemptRef: reserved.attemptRef, outcome: "refused" }); await stores.close();
  const originalPaths = ["reservation", "native"].map(kind => join(f.args.directories.attempts, intent.taskId, `attempt-000001.${kind}.enc`));
  const originalFiles = await Promise.all(originalPaths.map(path => readFile(path)));
  const before = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  if (before.read.storage !== "ready" || before.analysis.storage !== "ready") assert.fail();
  const disposition = resolve(f.args.directories.pages, "..", "disposition"); await mkdir(disposition);
  const record = { directory: disposition, passphrase: f.args.passphrase, intent,
    sourceHead: before.read.readProgress.chainHash, analysisHead: before.analysis.headHash };
  await recordStandingHistoryTaskDisposition({ ...record, reason: "consumed-without-prepared" });
  const savedDisposition = await readStandingHistoryTaskDisposition(record);
  const runner = await f.start({ ...f.args, directories: { ...f.args.directories, disposition } });
  await until(runner, attempted);
  const after = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  if (after.analysis.storage !== "ready" || after.attempts?.storage !== "ready") assert.fail();
  assert.equal(after.analysis.analysisNodes, 1); assert.equal(after.attempts.attempts, 2);
  assert.equal(after.attempts.last?.planHash, reserved.planHash, "legacy refusal successor retains its exact saved plan");
  assert.deepEqual(await readStandingHistoryTaskDisposition(record), savedDisposition);
  assert.deepEqual(after.read, before.read); assert.equal(f.counts.turns, 1); assert.equal(f.counts.read, 0);
  await runner.close();
  const reopened = await f.start({ ...f.args, directories: { ...f.args.directories, disposition } });
  const ready = (await until(reopened, value => value.kind === "background" && value.outcome.kind === "ready")).work;
  if (ready.kind !== "background" || ready.outcome.kind !== "ready") assert.fail();
  assert.equal(ready.outcome.result.coverage.coveredPages, 4); assert.equal(ready.outcome.result.coverage.coveredRows, 3);
  const ledger = await f.openStores(intent);
  try {
    const first = await ledger.analysis.readNodeAt(1), second = await ledger.analysis.readNodeAt(2), root = await ledger.analysis.readNodeAt(3);
    assert.ok(first && second && root);
    assert.equal(first.kind, "leaf"); assert.equal(second.kind, "leaf"); assert.equal(root.kind, "merge");
    assert.ok("materials" in first.inputs && "materials" in second.inputs && "children" in root.inputs);
    assert.equal(first.inputs.materials.length, 1, "refused legacy plan is recovered exactly, without repacking its successor");
    assert.equal(first.inputs.materials[0]!.maxRows, 1);
    assert.equal(second.inputs.materials.length, 3, "new work after restart adopts wide packing");
    assert.ok(second.inputs.materials.every(material => material.maxRows === 1));
    assert.deepEqual(second.coverage.map(span => span.pageIndex), [2, 3, 4]);
    assert.deepEqual(root.inputs.children, [first.nodeRef, second.nodeRef]);
    assert.equal((await ledger.attempts.status()).attempts, 4);
  } finally { await ledger.close(); }
  assert.equal(f.counts.turns, 3); assert.equal(f.counts.read, 0);
  assert.deepEqual(await Promise.all(originalPaths.map(path => readFile(path))), originalFiles);
  assert.deepEqual(await readStandingHistoryTaskDisposition(record), savedDisposition);
});

test("no-admission successor requires settlement and repeated refusals stop at three", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.idle(); f.mode("refused");
  const runner = await f.start(); await until(runner, attempted); await runner.close();
  f.epoch("b".repeat(32)); let settlementChecks = 0;
  const blocked = await f.start({ ...f.args, async verifyOwnerSettled() { settlementChecks++; throw Error("synthetic settlement unavailable"); } });
  await assert.rejects(blocked.poll());
  assert.equal(settlementChecks, 1); assert.equal(f.counts.turns, 1); await blocked.close();
  f.epoch("b".repeat(32)); const second = await f.start(); await until(second, attempted); await second.close();
  f.epoch("c".repeat(32)); const third = await f.start();
  await until(third, v => v.kind === "background" && v.outcome.kind === "stalled");
  for (let i = 0; i < 4; i++) await third.poll();
  const status = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  if (status.attempts?.storage !== "ready") assert.fail();
  assert.equal(status.attempts.attempts, 3); assert.equal(status.attempts.last?.consecutiveNotAdmitted, 3);
  assert.equal(f.counts.turns, 3); assert.equal(f.counts.read, 0);
});

test("UNKNOWN without prepared output consumes a persistent three-attempt budget across discovery cycles", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.mode("unknown"); f.idle(); const runner = await f.start();
  await until(runner, attempted);
  await until(runner, v => v.kind === "background" && v.outcome.kind === "stalled");
  for (let i = 0; i < 3; i++) { const work = await runner.poll(); assert.equal(work.kind, "background"); if (work.kind === "background") assert.equal(work.outcome.kind, "stalled"); }
  assert.equal(f.counts.turns, 3); assert.equal(f.counts.aborted, 3); assert.equal(f.counts.closed, 3);
  const saved = await f.manager.status({ taskRef: intent.taskId, requesterId: "456" });
  if (saved.attempts?.storage !== "ready") throw Error(); assert.equal(saved.attempts.attempts, 3); assert.equal(saved.attempts.last?.consecutiveNoOutput, 3);
});

test("observed empty turns use three fresh attempts then persist blockage across restart", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.mode("observed-without-commit"); f.idle();
  const disposition = resolve(f.args.directories.pages, "..", "disposition"); await mkdir(disposition);
  const directories = { ...f.args.directories, disposition };
  const manager = await openStandingHistoryTaskManager({ directories, passphrase: f.args.passphrase, binding: f.args.binding, signal: f.args.signal, async onCancelled() {} });
  t.after(() => manager.close());
  const args = { ...f.args, directories, manager };
  const runner = await f.start(args);
  const first = (await until(runner, v => v.kind === "background" && v.outcome.kind === "task-blocked")).work;
  assert.deepEqual(first, { kind: "background", outcome: { kind: "task-blocked", taskRef: intent.taskId, reason: "consumed-without-prepared" } });
  assert.equal(f.counts.turns, 3); assert.equal(f.counts.released, 3); assert.equal(f.counts.closed, 3);
  const saved = await manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  assert.deepEqual(saved.disposition, { storage: "ready", reason: "consumed-without-prepared" });
  assert.equal(saved.control.state, "queued", "original control state is preserved, explicit disposition describes blockage");
  if (saved.analysis.storage !== "ready" || saved.attempts?.storage !== "ready") assert.fail("expected ready stores");
  assert.equal(saved.analysis.analysisNodes, 0);
  assert.equal(saved.attempts.last?.modelOutcome, "observed"); assert.equal(saved.attempts.last?.prepared, undefined);
  assert.equal(saved.attempts.last?.consecutiveNoOutput, 3);
  const attempt = saved.attempts;
  await runner.close(); const reopened = await f.start(args);
  for (let i = 0; i < 3; i++) assert.equal((await until(reopened, v => v.kind === "background" && v.outcome.kind === "task-blocked")).work.kind, "background");
  assert.deepEqual((await manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId })).attempts, attempt);
  assert.equal(f.counts.turns, 3); assert.equal(f.counts.read, 0);
});

test("missing receipt reservation receives a distinct successor while its original receipt remains absent", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.idle();
  await seedPending(f, intent, false);
  const before = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  const disposition = resolve(f.args.directories.pages, "..", "disposition"); await mkdir(disposition);
  const runner = await f.start({ ...f.args, directories: { ...f.args.directories, disposition } });
  const work = (await until(runner, attempted)).work;
  assert.ok(work.kind === "background" && work.outcome.kind === "analysis");
  if (before.read.storage !== "ready" || before.analysis.storage !== "ready") assert.fail("expected ready stores");
  const saved = await readStandingHistoryTaskDisposition({ directory: disposition, passphrase: f.args.passphrase, intent,
    sourceHead: before.read.readProgress.chainHash, analysisHead: before.analysis.headHash });
  assert.equal(saved.storage, "absent");
  const after = await f.manager.status({ taskRef: intent.taskId, requesterId: intent.requesterId });
  if (after.attempts?.storage !== "ready" || before.attempts?.storage !== "ready") assert.fail();
  assert.equal(after.attempts.attempts, 2); assert.notEqual(after.attempts.last?.attemptRef, before.attempts.last?.attemptRef);
  await assert.rejects(readFile(join(f.args.directories.attempts, intent.taskId, "attempt-000001.native.enc")), { code: "ENOENT" });
  assert.equal(f.counts.turns, 1); assert.equal(f.counts.read, 0);
});

test("persisted cancellation joins delayed native owner and leaves foreground polling available", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.mode("wait"); f.idle(); const runner = await f.start();
  const pending = runner.poll(); await f.nativeEntered.promise;
  const cancelled = await f.manager.cancel({ taskRef: intent.taskId, requesterId: "456" });
  assert.equal(cancelled.revocationJoined, true); await pending;
  assert.equal(f.counts.aborted, 1); assert.equal(f.counts.closed, 1);
  const result = await runner.poll(); assert.equal(result.kind, "background");
  if (result.kind === "background") assert.deepEqual(result.outcome, { kind: "stalled", taskRef: intent.taskId, reason: "cancelled" });
});

test("revoke at a local scan yield closes only that task without a model call or head mutation", async t => {
  const f = await fixture(t), a = await f.create("a", 10, 9), b = await f.create("b", 1); f.idle(); const runner = await f.start();
  const before = await f.manager.status({ taskRef: a.taskId, requesterId: "456" });
  let yields = 0, revoked: Promise<void> | undefined;
  const originalImmediate = timersPromises.setImmediate;
  const spy = t.mock.method(timersPromises, "setImmediate", (...args: Parameters<typeof originalImmediate>) => {
    if (++yields === 2) revoked = runner.revoke(a.taskId);
    return originalImmediate(...args);
  });
  syncBuiltinESMExports();
  try {
    const first = await runner.poll();
    assert.deepEqual(first, { kind: "background", outcome: { kind: "stalled", taskRef: a.taskId, reason: "cancelled" } });
    assert.ok(revoked); await revoked;
    assert.equal(yields, 2); assert.equal(f.counts.turns, 0); assert.equal(f.counts.prepare, 0);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  const after = await f.manager.status({ taskRef: a.taskId, requesterId: "456" });
  assert.deepEqual(after.read, before.read); assert.deepEqual(after.analysis, before.analysis); assert.deepEqual(after.attempts, before.attempts);
  await f.manager.cancel({ taskRef: a.taskId, requesterId: "456" });
  const { work } = await until(runner, attempted);
  if (work.kind !== "background" || work.outcome.kind !== "analysis") throw Error(); assert.equal(work.outcome.taskRef, b.taskId);
  assert.equal(f.counts.turns, 1);
});

test("local scan time budget returns to foreground without consuming a model attempt", async t => {
  const f = await fixture(t), a = await f.create("a", 10, 9); f.idle(); const runner = await f.start();
  const before = await f.manager.status({ taskRef: a.taskId, requesterId: "456" });
  let clockReads = 0;
  const clock = t.mock.method(performance, "now", () => clockReads++ === 0 ? 0 : 2001);
  try {
    const work = await runner.poll();
    assert.ok(work.kind === "background" && work.outcome.kind === "analysis" && work.outcome.result.kind === "scan-more");
    assert.equal(f.counts.turns, 0); assert.equal(f.counts.prepare, 0);
  } finally { clock.mock.restore(); }
  const selection = { synthetic: "foreground after local scan budget" } as unknown as StandingSelection;
  f.select(selection); assert.deepEqual(await runner.poll(), { kind: "selected", selection });
  const after = await f.manager.status({ taskRef: a.taskId, requesterId: "456" });
  assert.deepEqual(after.read, before.read); assert.deepEqual(after.analysis, before.analysis); assert.deepEqual(after.attempts, before.attempts);
  await until(runner, attempted); assert.equal(f.counts.turns, 1);
});

test("ready preserves durable heads, coverage and original intent; it performs no native call", async t => {
  const f = await fixture(t), intent = await f.create("a", 1, 1, true); f.idle(); const runner = await f.start();
  const { work } = await until(runner, v => v.kind === "background" && v.outcome.kind === "ready");
  if (work.kind !== "background" || work.outcome.kind !== "ready") throw Error();
  assert.deepEqual(work.outcome.intent, intent); assert.match(work.outcome.result.sourceHead, /^[a-f0-9]{64}$/);
  assert.match(work.outcome.result.expectedHead, /^[a-f0-9]{64}$/); assert.equal(work.outcome.result.coverage.readTraversalComplete, true);
  assert.equal(work.outcome.result.coverage.committedPages, 1); assert.equal(f.counts.turns, 0);
  assert.equal(typeof work.outcome.ticket.openTaskReply, "function");
});

test("cancel during an actual read step joins it before permitting another poll", async t => {
  const f = await fixture(t), intent = await f.create("a"), entered = deferred(); f.idle(); const runner = await f.start();
  await runner.poll(); // read-more planning retains the task, but no Telegram lease.
  f.onRead(async signal => { entered.resolve(); await new Promise<void>(done => { if (signal.aborted) done(); else signal.addEventListener("abort", () => done(), { once: true }); }); });
  const pending = runner.poll(); await entered.promise;
  await assert.rejects(runner.poll(), /BUSY/);
  const cancelled = await f.manager.cancel({ taskRef: intent.taskId, requesterId: "456" }); assert.equal(cancelled.revocationJoined, true);
  const result = await pending;
  assert.equal(result.kind, "background"); if (result.kind === "background" && result.outcome.kind === "read") assert.equal(result.outcome.result.kind, "cancelled"); else assert.fail("read cancellation required");
  assert.equal(f.counts.readClosed, 1); assert.equal(f.counts.prepare, 0);
});

test("missing attempts remain absent; malformed capabilities are refused without evaluating getters", async t => {
  const f = await fixture(t), intent = await f.create("a"); f.idle();
  const target = join(f.args.directories.attempts, intent.taskId);
  assert.ok(target.startsWith(f.args.directories.attempts + "\\") || target.startsWith(f.args.directories.attempts + "/"));
  await rm(target, { recursive: true });
  const runner = await f.start(), result = await runner.poll();
  if (result.kind !== "background") throw Error(); assert.deepEqual(result.outcome, { kind: "stalled", taskRef: intent.taskId, reason: "unavailable" });
  const saved = await f.manager.status({ taskRef: intent.taskId, requesterId: "456" }); assert.equal(saved.attempts?.storage, "absent"); assert.equal(f.counts.prepare, 0);
  let evaluated = 0;
  const hostile = { ...f.args, connection: Object.defineProperty({}, "prepare", { get() { evaluated++; throw Error("must not run"); } }) };
  await assert.rejects(openStandingHistoryTaskRunner(hostile as StandingHistoryTaskRunnerInput)); assert.equal(evaluated, 0);
});

test("cancellation during lazy prepare joins it, never acquires or reserves a model turn", async t => {
  const f = await fixture(t), intent = await f.create("a", 1), entered = deferred(), release = deferred(); f.idle();
  f.onPrepare(async () => { entered.resolve(); await release.promise; }); const runner = await f.start();
  const pending = runner.poll(); await entered.promise;
  let joined = false; const revocation = runner.revoke(intent.taskId).then(() => { joined = true; });
  await new Promise<void>(done => setImmediate(done)); assert.equal(joined, false);
  release.resolve(); await revocation;
  const work = await pending;
  if (work.kind !== "background") throw Error(); assert.deepEqual(work.outcome, { kind: "stalled", taskRef: intent.taskId, reason: "cancelled" });
  assert.equal(f.counts.acquired, 0); assert.equal(f.counts.turns, 0);
  const status = await f.manager.status({ taskRef: intent.taskId, requesterId: "456" });
  if (status.attempts?.storage !== "ready") throw Error(); assert.equal(status.attempts.attempts, 0);
});

test("tail-refused control cannot be promoted to a trusted cancelled state", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.idle();
  const runner = await f.start({ ...f.args, manager: { async status(input) {
    const result = await f.manager.status(input);
    return { ...result, control: { ...result.control, storage: "tail-refused", state: "cancelled" } };
  } } });
  const result = await runner.poll(); if (result.kind !== "background") throw Error();
  assert.deepEqual(result.outcome, { kind: "stalled", taskRef: intent.taskId, reason: "unavailable" }); assert.equal(f.counts.prepare, 0);
});

test("local close during borrowed foreground poll preserves caller's already admitted selection", async t => {
  const f = await fixture(t), runner = await f.start(), entered = deferred(), release = deferred();
  const selection = { primary: { messageId: 42 } } as StandingSelection;
  f.select(selection); f.onPoll(async () => { entered.resolve(); await release.promise; });
  const pending = runner.poll(); await entered.promise; const closing = runner.close(); release.resolve();
  assert.deepEqual(await pending, { kind: "selected", selection }); await closing;
  await assert.rejects(runner.poll()); assert.equal(f.counts.prepare, 0);
});

test("an incomplete final slot skips source-chain reopening without granting delivery or native work", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.idle();
  const delivery = join(f.args.directories.pages, "..", "delivery");
  await mkdir(delivery); await mkdir(join(delivery, intent.taskId));
  let statusCalls = 0, discoveries = 0, captures = 0;
  const references = createConversationReferences(f.args.binding);
  const memory = createStandingHistoryTaskMemory({ binding: f.args.binding, references, scopeRef: "scope_" + "a".repeat(32), signal: f.args.signal });
  t.after(() => { memory.close(); references.close(); });
  const runner = await f.start({ ...f.args, directories: { ...f.args.directories, delivery },
    onAnalysisReady() { captures++; },
    onDiscovered(found) {
      discoveries++; assert.deepEqual(found, intent); assert.equal(Object.isFrozen(found), true);
      memory.remember(found, 10000);
      throw Error("optional observer failure must not change terminal handling");
    },
    manager: { async status() { statusCalls++; throw Error("a consumed final slot must not reopen analysis"); } } });
  const result = await runner.poll();
  assert.deepEqual(result, { kind: "background", outcome: { kind: "delivery-state", taskRef: intent.taskId, state: "not-inspected" } });
  assert.equal(statusCalls, 0); assert.equal(captures, 0); assert.equal(f.counts.prepare, 0); assert.equal(f.counts.turns, 0); assert.equal(f.counts.read, 0);
  assert.equal(discoveries, 1);
  const recalled = memory.forPrimary({ primary: { chatId: intent.chatId, ownerId: intent.requesterId, messageId: 1000, text: "What did I ask?" }, asOf: 10001 });
  assert.equal(recalled.source.items[0]!.description!.objective, intent.objective);
  assert.equal(recalled.source.items[0]!.delivery, "unavailable", "discovery cannot fabricate final delivery");
});

test("a persisted task-local failure blocks only matching source heads and leaves other tasks runnable", async t => {
  const f = await fixture(t), first = await f.create("a", 1), second = await f.create("b", 1); f.idle();
  const disposition = join(f.args.directories.pages, "..", "disposition"); await mkdir(disposition);
  const stores = await f.openStores(first);
  try { await recordStandingHistoryTaskDisposition({ directory: disposition, passphrase: f.args.passphrase, intent: first,
    sourceHead: (await stores.source.status()).readProgress.chainHash, analysisHead: (await stores.analysis.status()).headHash, reason: "coverage" }); }
  finally { await stores.close(); }
  const runner = await f.start({ ...f.args, directories: { ...f.args.directories, disposition } });
  assert.deepEqual(await runner.poll(), { kind: "background", outcome: { kind: "task-blocked", taskRef: first.taskId, reason: "coverage" } });
  assert.equal(f.counts.prepare, 0);
  const next = await runner.poll();
  assert.equal(next.kind, "background");
  if (next.kind !== "background" || next.outcome.kind !== "analysis") throw Error("following task did not run");
  assert.equal(next.outcome.taskRef, second.taskId); assert.equal(next.outcome.result.kind, "attempt"); assert.equal(f.counts.turns, 1);
});

test("participant alternates with retained history work without changing two foreground pulse credit", async t => {
  const f = await fixture(t), intent = await f.create("a");
  let dueCalls = 0, steps = 0; const tickets: StandingIdleHistoryTicket[] = [];
  const runner = await f.start({ ...f.args,
    adapter: { async pollWork(signal, options) {
      const result = await f.args.adapter.pollWork(signal, options);
      if (result.kind === "background" || result.kind === "idle") tickets.push(result.ticket);
      return result;
    } },
    backgroundParticipant: { due() { dueCalls++; return true; }, async step(ticket, signal) {
      assert.equal(ticket, tickets.at(-1)); assert.equal(signal.aborted, false); steps++;
    } } });
  const results: StandingHistoryTaskWork[] = [];
  for (let i = 0; i < 12; i++) results.push(await runner.poll());
  assert.deepEqual(f.due, Array.from({ length: 4 }, () => [false, false, true]).flat());
  const background = results.filter(v => v.kind === "background");
  assert.deepEqual(background.map(v => v.outcome.kind), ["participant", "analysis", "participant", "read"]);
  assert.ok(background.every(v => v.outcome.kind === "participant" || "taskRef" in v.outcome && v.outcome.taskRef === intent.taskId));
  assert.equal(dueCalls, 4); assert.equal(steps, 2); assert.equal(f.counts.read, 1);
});

test("idle opportunities alternate participant and discovery, and a due change uses the one sampled decision", async t => {
  const f = await fixture(t); f.idle(); let due = false, calls = 0, steps = 0;
  const participant = { due() { calls++; const snapshot = due; due = !due; return snapshot; }, async step() { steps++; } };
  const runner = await f.start({ ...f.args, backgroundParticipant: participant });
  // Methods are captured at construction, so replacement cannot alter admission.
  participant.due = () => { throw Error("replacement must not run"); };
  participant.step = async () => { throw Error("replacement must not run"); };
  const results = []; for (let i = 0; i < 4; i++) results.push(await runner.poll());
  assert.deepEqual(results, [{ kind: "idle" }, { kind: "background", outcome: { kind: "participant" } },
    { kind: "idle" }, { kind: "background", outcome: { kind: "participant" } }]);
  assert.equal(calls, 4); assert.equal(steps, 2); assert.deepEqual(f.due, [false, false, false, false]);
});

test("participant close and global abort revoke immediately but join the held step before closing", async t => {
  for (const mode of ["close", "abort"] as const) {
    const f = await fixture(t); f.idle(); const entered = deferred(), release = deferred();
    let signal: AbortSignal | undefined, settled = false;
    const runner = await f.start({ ...f.args, backgroundParticipant: { due() { return true; }, async step(_ticket, stop) {
      signal = stop; entered.resolve(); await release.promise; settled = true;
    } } });
    const pending = runner.poll(), rejected = assert.rejects(pending, mode === "close" ? /CLOSED/ : /ABORTED/);
    await entered.promise; await assert.rejects(runner.poll(), /BUSY/);
    assert.equal(f.due.length, 1);
    if (mode === "abort") f.controller.abort();
    let closed = false;
    const closing = mode === "close" ? runner.close().then(() => { closed = true; }) : undefined;
    await new Promise<void>(done => setImmediate(done));
    assert.equal(signal?.aborted, true); assert.equal(settled, false); assert.equal(closed, false);
    release.resolve(); await rejected; await (closing ?? runner.close());
    assert.equal(settled, true); assert.equal(f.due.length, 1);
    await assert.rejects(runner.poll(), /CLOSED/);
  }
});

test("wait code sanitizer never evaluates getters or proxies", () => {
  let touched = false;
  const value = { get code() { touched = true; throw Error("private"); } };
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { touched = true; throw Error("private"); } });
  assert.equal(standingWaitCode(value), undefined); assert.equal(standingWaitCode(proxy), undefined);
  assert.equal(touched, false);
});

test("participant diagnostic preserves a fixed code and drops unknown private text", async t => {
  for (const code of ["SETTLEMENT_UNKNOWN", "private secret"]) {
    const f = await fixture(t); f.idle();
    const runner = await f.start({ ...f.args, backgroundParticipant: { due() { return true; }, async step() { throw Object.assign(new Error("private detail"), { code }); } } });
    await assert.rejects(runner.poll(), (error: any) => {
      assert.equal(error.origin, "participant-step");
      assert.equal(error.childCode, code === "SETTLEMENT_UNKNOWN" ? "settlement_unknown" : undefined);
      assert.equal(error.message.includes("private"), false); return true;
    });
  }
});

test("failed participant owns its ticket without falling through to history work", async t => {
  const f = await fixture(t); await f.create("a"); f.idle(); let steps = 0;
  const runner = await f.start({ ...f.args, backgroundParticipant: { due() { return true; }, async step(ticket) {
    assert.equal(typeof ticket.openHistoryTask, "function"); steps++; throw Error("private participant detail");
  } } });
  await assert.rejects(runner.poll(), error => error instanceof Error && error.message === "STANDING_HISTORY_TASK_RUNNER_STEP");
  assert.equal(f.counts.read, 0); assert.equal(f.counts.prepare, 0); assert.equal(steps, 1); assert.equal(f.due.length, 1);
  const next = await runner.poll(); assert.equal(next.kind, "background");
  if (next.kind !== "background" || next.outcome.kind !== "analysis") assert.fail("next distinct ticket belongs to history");
  assert.equal(next.outcome.result.kind, "read-more"); assert.equal(steps, 1);
});

test("participant methods are inert validated capabilities and due must return a synchronous boolean", async t => {
  const f = await fixture(t); f.idle(); let evaluated = 0;
  const step = async () => { evaluated++; };
  const getter = Object.defineProperty({ step }, "due", { enumerable: true, get() { evaluated++; return () => true; } });
  const hostileStep = Object.defineProperty({ due() { return true; } }, "step", { enumerable: true, get() { evaluated++; return step; } });
  for (const backgroundParticipant of [undefined, null, getter, hostileStep,
    { due: async () => true, step }, { due: function* () { yield true; }, step },
    { due: () => true, step: function* () {} },
    new Proxy({ due: () => true, step }, { ownKeys() { evaluated++; throw Error(); } }),
    { due: new Proxy(() => true, { apply() { evaluated++; throw Error(); } }), step }]) {
    await assert.rejects(openStandingHistoryTaskRunner({ ...f.args, backgroundParticipant } as never), /INPUT/);
  }
  assert.equal(evaluated, 0); assert.equal(f.due.length, 0);
  for (const due of [() => undefined, () => 1, () => ({ then() { evaluated++; } }),
    () => Promise.reject(Error("private asynchronous due detail")), () => { throw Error("private due detail"); }]) {
    const runner = await f.start({ ...f.args, backgroundParticipant: { due, step } } as never);
    await assert.rejects(runner.poll(), error => error instanceof Error && error.message === "STANDING_HISTORY_TASK_RUNNER_STEP");
    await runner.close();
  }
  assert.equal(evaluated, 0); assert.equal(f.counts.read, 0); assert.equal(f.counts.prepare, 0);
});
