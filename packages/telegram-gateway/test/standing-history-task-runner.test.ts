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
import { openStandingHistoryTaskRunner, type StandingHistoryTaskRunner, type StandingHistoryTaskRunnerInput, type StandingHistoryTaskWork } from "../src/standing-history-task-runner.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import type { StandingPollWork, StandingSelection, StandingIdleHistoryTicket } from "../src/standing-conversation-adapter.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import { recordStandingHistoryTaskDisposition } from "../src/standing-history-task-disposition.js";
import { requireStandingChronicleNote } from "../src/standing-chronicle-note.js";
import { runStandingHistoryTaskDelivery, readStandingHistoryTaskDelivery } from "../src/standing-history-task-delivery.js";
import type { PilotSend } from "../src/pilot-outbox.js";

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
  const result = await runStandingHistoryTaskDelivery({ intent, readiness: ready.outcome.result, directories,
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
  let nativeMode: "commit" | "unknown" | "wait" = "commit";
  const due: boolean[] = [], counts = { prepare: 0, acquired: 0, turns: 0, released: 0, aborted: 0, closed: 0, read: 0, readClosed: 0 };
  const nativeEntered = deferred(), nativeStopped = deferred(), nativeFinished = deferred();
  const settlements: StandingHistoryAnalysisNativeBinding[] = [];
  const manager = await openStandingHistoryTaskManager({ directories, passphrase, binding, signal: controller.signal,
    async onCancelled({ taskRef }) { await runner?.revoke(taskRef); } });
  const ticket: StandingIdleHistoryTicket = { openTaskReply() { throw Error("runner must not send"); }, openHistoryTask({ checkpoint, signal }) {
    let stopped = false;
    return { async readTaskPage() { counts.read++; await onRead?.(signal); if (stopped || signal.aborted) throw Error("synthetic revoked"); assert.ok(checkpoint); return page(checkpoint); },
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
    connection: { async prepare() { counts.prepare++; await onPrepare?.(); return { restoration: true }; }, async acquireAnalysisAdmission(requestRef) {
      counts.acquired++; const nativeBinding = { epochId: "a".repeat(32), requestRef, purpose: "history-analysis" as const };
      return { nativeBinding, async turnAnalysis(req, input, tools) {
        counts.turns++; nativeEntered.resolve();
        try {
          assert.equal(JSON.parse(input).schema, "neurobro-history-analysis-input-v1");
          if (nativeMode === "wait") { await nativeStopped.promise; throw Error("synthetic abort joined"); }
          if (nativeMode === "unknown") throw Error("synthetic outcome lost");
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
  async function create(letter: string, pages = 0, analyzed = 0, terminal = false) {
    const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + letter.repeat(48), accountId: binding.accountId, chatId: binding.peerId,
      requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "UTC", objective: "Synthetic task " + letter };
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
    idle() { queued = false; }, select(value: StandingSelection) { selection = value; }, onPoll(value: typeof onPoll) { onPoll = value; }, onRead(value: typeof onRead) { onRead = value; }, onPrepare(value: typeof onPrepare) { onPrepare = value; }, mode(value: typeof nativeMode) { nativeMode = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function until(runner: StandingHistoryTaskRunner, match: (v: StandingHistoryTaskWork) => boolean, max = 60) {
  const seen: StandingHistoryTaskWork[] = [];
  for (let i = 0; i < max; i++) { const work = await runner.poll(); seen.push(work); if (match(work)) return { work, seen }; }
  assert.fail("finite synthetic traversal did not finish");
}
const attempted = (v: StandingHistoryTaskWork) => v.kind === "background" && v.outcome.kind === "analysis" && v.outcome.result.kind === "attempt";
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

test("retained planner crosses multiple scan-more pulses, foreground credit and a second task", async t => {
  const f = await fixture(t), a = await f.create("a", 10, 9), b = await f.create("b", 1), runner = await f.start();
  const first = await until(runner, attempted), second = await until(runner, attempted);
  const results = [...first.seen, ...second.seen];
  const taskRefs = results.filter(attempted).map(v => v.kind === "background" && v.outcome.kind === "analysis" ? v.outcome.taskRef : "");
  assert.deepEqual(new Set(taskRefs), new Set([a.taskId, b.taskId]));
  const scans = results.flatMap(v => v.kind === "background" && v.outcome.kind === "analysis" && v.outcome.result.kind === "scan-more" ? [v.outcome.result.progress.nodesScanned] : []);
  assert.ok(scans.length >= 2); assert.ok(scans.some((n, i) => i > 0 && n > scans[i - 1]!));
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

test("prepared output recovers after reopen with exact owner proof, no model call; unprepared stays stalled", async t => {
  const f = await fixture(t), a = await f.create("a", 1), b = await f.create("b", 1), reserved = await seedPending(f, a, true);
  await seedPending(f, b, false); f.idle(); const runner = await f.start();
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) { const work = await runner.poll(); if (work.kind === "background") outcomes.push(work.outcome.kind); }
  assert.ok(outcomes.includes("recovered")); assert.ok(outcomes.includes("stalled"));
  const saved = await f.manager.status({ taskRef: a.taskId, requesterId: "456" });
  assert.equal(saved.attempts?.storage, "ready"); if (saved.attempts?.storage === "ready") { assert.equal(saved.attempts.last?.attemptRef, reserved.attemptRef); assert.equal(saved.attempts.last?.modelOutcome, "unknown"); assert.ok(saved.attempts.last?.node); }
  assert.equal(f.settlements[0]?.requestRef, "old-consumed"); assert.equal(f.counts.turns, 0);
});

test("UNKNOWN without prepared output remains consumed across discovery cycles", async t => {
  const f = await fixture(t), intent = await f.create("a", 1); f.mode("unknown"); f.idle(); const runner = await f.start();
  await until(runner, attempted);
  for (let i = 0; i < 3; i++) { const work = await runner.poll(); assert.equal(work.kind, "background"); if (work.kind === "background") assert.equal(work.outcome.kind, "stalled"); }
  assert.equal(f.counts.turns, 1); assert.equal(f.counts.aborted, 1); assert.equal(f.counts.closed, 1);
  const saved = await f.manager.status({ taskRef: intent.taskId, requesterId: "456" });
  if (saved.attempts?.storage !== "ready") throw Error(); assert.equal(saved.attempts.attempts, 1);
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

test("revoke during retained scan closes only that task and advances to another", async t => {
  const f = await fixture(t), a = await f.create("a", 10, 9), b = await f.create("b", 1); f.idle(); const runner = await f.start();
  await until(runner, v => v.kind === "background" && v.outcome.kind === "analysis" && v.outcome.taskRef === a.taskId && v.outcome.result.kind === "scan-more");
  await f.manager.cancel({ taskRef: a.taskId, requesterId: "456" });
  const { work } = await until(runner, attempted);
  if (work.kind !== "background" || work.outcome.kind !== "analysis") throw Error(); assert.equal(work.outcome.taskRef, b.taskId);
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
