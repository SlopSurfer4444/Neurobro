import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { decryptSession } from "../src/session-crypto.js";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskContinuation, type StandingHistoryTaskContinuationAuthorization } from "../src/standing-history-task-continuation.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { projectMergeView } from "../src/standing-history-analysis-view.js";
import type { StandingHistoryAnalysisStepConnection } from "../src/standing-history-analysis-step.js";
import { recordStandingHistoryTaskDisposition } from "../src/standing-history-task-disposition.js";
import { readStandingHistoryTaskDelivery } from "../src/standing-history-task-delivery.js";
import { openStandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { openStandingHistoryTaskRunner } from "../src/standing-history-task-runner.js";
import type { StandingIdleHistoryTicket } from "../src/standing-conversation-adapter.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import type { PilotSend } from "../src/pilot-outbox.js";

function page(before: SelfHistoryTaskCheckpoint, terminal: boolean): SelfHistoryTaskPage {
  const messageId = (before.offsetId || 1000) - 1, date = before.lastDate - 1, ref = "m_" + messageId.toString(16).padStart(24, "0");
  const status = terminal ? "lower-bound-reached" as const : "more" as const;
  const next = { ...before, offsetId: messageId, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date,
    pages: before.pages + 1, upperBoundMessageId: before.upperBoundMessageId ?? messageId, status };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: [{ messageId, date, disposition: "included", messageRef: ref, authorId: "456" }],
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: [{ ref, authorRef: "a_" + "3".repeat(24), author: "user", displayName: "Synthetic speaker", date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Saved month material " + messageId }],
      cursor: null, hasMore: !terminal, status,
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: terminal, undatedEntries: 0, pages: next.pages },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
const settled = async (nativeBinding: StandingHistoryAnalysisNativeBinding) => ({ schema: "standing-analysis-owner-settlement-v1" as const, nativeBinding,
  resourcesSettled: true as const, persisted: true as const, replacementReady: true as const, modelOutcome: "not-proven" as const });
async function fixture(t: TestContext, terminal = true, pageCount = 2) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-continuation-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-continuation-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts"), delivery: join(root, "delivery"), disposition: join(root, "disposition") };
  const directory = join(root, "continuations"); for (const p of [...Object.values(directories), directory]) await mkdir(p);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "6".repeat(48), accountId: "123", chatId: "-100456", requesterId: "456", primaryMessageId: 999,
    fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Finish original month report from saved notes" };
  const passphrase = "synthetic-continuation-passphrase", binding = { intent, passphrase }, controller = new AbortController();
  const source = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "create" });
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: directories.control, mode: "create" });
  const analysis = await openStandingHistoryAnalysisStore({ ...binding, directory: directories.analysis, mode: "create", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: directories.attempts, mode: "create", analysis });
  for (let i = 0; i < pageCount; i++) { const before = (await source.status()).readProgress.checkpoint; await source.appendPage({ expectedCheckpoint: before, result: page(before, terminal && i === pageCount - 1) }); }
  const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis });
  async function select() { for (let i = 0; i < 32; i++) { const p = await planner.next(); if (p.kind !== "scan-more") return p; } assert.fail(); }
  for (let i = 0; i < 2; i++) {
    const p = await select(); if (p.kind !== "leaf") assert.fail(); const prepared = prepareStandingHistoryAnalysisMaterial(p);
    const attempt = await attempts.reserve({ plan: { kind: "leaf", inputs: p.inputs, sourceHead: p.sourceHead, expectedHead: p.expectedHead, nodeIndex: i + 1, modelInputHash: prepared.modelInputHash },
      nativeBinding: { epochId: "a".repeat(32), requestRef: "saved-leaf-" + i, purpose: "history-analysis" } });
    await attempts.prepare({ attemptRef: attempt.attemptRef, output: { summary: "Already analyzed leaf " + i, claims: [] } });
    await attempts.commitPrepared({ attemptRef: attempt.attemptRef }); await attempts.recordModelOutcome({ attemptRef: attempt.attemptRef, outcome: "observed" });
  }
  // An unresolved merge represents old work whose model outcome is unknown.
  // For the incomplete-source rejection fixture only, its descriptors can be
  // prepared directly from the same two authenticated children.
  const a = await analysis.status(), s = await source.status(), c = await control.status();
  const nodes = [(await analysis.readNodeAt(1))!, (await analysis.readNodeAt(2))!], children = nodes.map(n => n.nodeRef);
  const view = projectMergeView({ children: nodes, referenceKey: analysis.referenceKey() });
  const inputHash = prepareStandingHistoryAnalysisMaterial({ kind: "merge", sourceHead: s.readProgress.chainHash, expectedHead: a.headHash, children: children as [string, string], materials: view.children }).modelInputHash;
  const plan = { kind: "merge" as const, children, sourceHead: s.readProgress.chainHash, expectedHead: a.headHash, nodeIndex: 3, modelInputHash: inputHash };
  const old = await attempts.reserve({ plan, nativeBinding: { epochId: "a".repeat(32), requestRef: "original-unknown-merge", purpose: "history-analysis" } });
  await attempts.recordModelOutcome({ attemptRef: old.attemptRef, outcome: "unknown" });
  await recordStandingHistoryTaskDisposition({ directory: directories.disposition, ...binding, sourceHead: s.readProgress.chainHash, analysisHead: a.headHash, reason: "consumed-without-prepared" });
  const authorization: StandingHistoryTaskContinuationAuthorization = { schema: "standing-history-task-continuation-authorization-v1", continuationRef: "hcont_" + "9".repeat(48), requestHash: "e".repeat(64),
    taskRef: intent.taskId, sourceHead: s.readProgress.chainHash, analysisHead: a.headHash, controlHead: c.headHash, attemptRef: old.attemptRef, planHash: old.planHash };
  await planner.close(); await attempts.close(); await analysis.close(); await control.close(); await source.close();
  const args = { ...binding, directory, directories, authorization, signal: controller.signal, verifyOwnerSettled: settled };
  return { root, binding, intent, passphrase, directory, directories, authorization, controller, args };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function originals(f: Fixture) {
  const result: Record<string, string> = {};
  for (const area of ["pages", "control", "analysis", "attempts", "disposition"] as const) for (const name of await readdir(join(f.directories[area], f.intent.taskId))) {
    result[area + "/" + name] = (await readFile(join(f.directories[area], f.intent.taskId, name))).toString("base64");
  }
  return result;
}
function native(f: Fixture, mode: "observed" | "unknown" = "observed") {
  const counts = { acquired: 0, turns: 0, closed: 0, released: 0 };
  const errors: unknown[] = [], workRefs: string[] = [];
  const connection: StandingHistoryAnalysisStepConnection = { async acquireParallelAnalysisAdmissions() { throw Error("maintenance must not create a parallel wave"); }, async acquireAnalysisAdmission(requestRef) {
    counts.acquired++; const nativeBinding = { epochId: "b".repeat(32), requestRef, purpose: "history-analysis" as const };
    return { nativeBinding, async turnAnalysis(req, body, tools) {
      try {
      counts.turns++; assert.equal(JSON.parse(body).kind, "merge");
      assert.equal(tools.work?.taskRef, f.intent.taskId); assert.match(tools.work?.workRef ?? "", /^hattempt_[a-f0-9]{48}$/); assert.equal(tools.work?.planRef, tools.work?.workRef);
      workRefs.push(tools.work!.workRef);
      if (mode === "unknown") throw Error("new generation outcome unknown");
      const material = await tools.analysisTools[0]!.call({}, { requestRef: req, callRef: "material", signal: f.controller.signal }) as EpochToolResult;
      assert.equal(material.success, true); tools.onToolResultSent({ requestRef: req, callRef: "material", name: "neurobro_analysis_material", result: material });
      const packet = JSON.parse(material.contentItems[0].text); assert.equal(packet.children.length, 2);
      assert.deepEqual(packet.children.map((c: { summary: { text: string } }) => c.summary.text), ["Already analyzed leaf 0", "Already analyzed leaf 1"]);
      const committed = await tools.analysisTools[2]!.call({ output: { summary: "Finished original month report", claims: [] } }, { requestRef: req, callRef: "commit", signal: f.controller.signal }) as EpochToolResult;
      assert.equal(committed.success, true); tools.onToolResultSent({ requestRef: req, callRef: "commit", name: "neurobro_analysis_commit", result: committed });
      return { kind: "analysis", scope: { ...nativeBinding, threadId: "new-generation-thread", turnId: "new-generation-turn", turnNumber: 1, threadTurnNumber: 1 }, answer: "Saved", toolCalls: 2, toolRefusals: 0 };
      } catch (error) { errors.push(error); throw error; }
    }, async releaseAnalysis() { counts.released++; }, async abortAndJoin() {}, async close() { counts.closed++; } };
  } };
  return { counts, connection, errors, workRefs };
}
async function advance(coordinator: Awaited<ReturnType<typeof openStandingHistoryTaskContinuation>>, f: Fixture, connection: StandingHistoryAnalysisStepConnection, requestRef: string) {
  for (let i = 0; i < 64; i++) { const result = await coordinator.next({ connection, requestRef, signal: f.controller.signal }); if (result.kind !== "scan-more") return result; } assert.fail();
}

test("explicit continuation reuses saved leaves, delivers original task, and normal manager/runner recognize terminal despite old UNKNOWN", async t => {
  const f = await fixture(t), before = await originals(f), n = native(f);
  let coordinator = await openStandingHistoryTaskContinuation({ ...f.args, mode: "create" });
  const attempt = await advance(coordinator, f, n.connection, "explicit-new-generation"); assert.equal(attempt.kind, "attempt");
  if (n.errors.length) throw n.errors[0];
  if (attempt.kind !== "attempt") assert.fail(); assert.equal(attempt.node?.index, 3); assert.equal(attempt.modelOutcome, "observed");
  assert.deepEqual(n.workRefs, [attempt.attemptRef]);
  const finalReady = await advance(coordinator, f, n.connection, "readiness-only");
  assert.equal(finalReady.kind, "analysis-ready");
  if (finalReady.kind !== "analysis-ready") assert.fail();
  assert.equal(n.counts.turns, 1); await coordinator.close();
  // Cold delivery uses the new journal's actual final attempt and durable ready
  // capsule, while preserving the original task, requester and primary anchor.
  coordinator = await openStandingHistoryTaskContinuation({ ...f.args, mode: "open" }); t.after(() => coordinator.close());
  let sent: PilotSend | undefined, sends = 0, replyCloses = 0;
  const delivered = await coordinator.deliver({ signal: f.controller.signal,
    finalReport: { schema: "standing-history-final-report-v1", taskRef: f.intent.taskId,
      sourceHead: finalReady.sourceHead, analysisHead: finalReady.expectedHead, body: "Reviewed final report for the requester." },
    async verifyOwnerReady(nativeBinding) { assert.equal(nativeBinding.requestRef, "explicit-new-generation");
    return { schema: "standing-analysis-owner-ready-v1", nativeBinding, basis: "persisted-owner-settlement", modelOutcome: "not-proven" }; }, ticket: { openTaskReply({ intent }) {
    assert.deepEqual(intent, f.intent); return { transport: { async sendOnce(value) { sends++; sent = value; return { messageId: 2001 }; }, async readExact(chatId, messageId) {
      assert.ok(sent); return { chatId, messageId, accountId: f.intent.accountId, replyToMessageId: sent.replyToMessageId, text: sent.text };
    } }, async close() { replyCloses++; } };
  } } });
  assert.equal(delivered.deliveryComplete, true); assert.equal(delivered.result.state, "verified"); assert.equal(sends, 1); assert.equal(replyCloses, 1);
  assert.equal(sent?.replyToMessageId, f.intent.primaryMessageId); await coordinator.close();
  const after = await originals(f); for (const [name, body] of Object.entries(before)) assert.equal(after[name], body, name);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 1, "only one appended analysis node");
  const manager = await openStandingHistoryTaskManager({ directories: f.directories, passphrase: f.passphrase, binding: { accountId: f.intent.accountId, peerId: f.intent.chatId }, async onCancelled() {} }); t.after(() => manager.close());
  const status = await manager.status({ taskRef: f.intent.taskId, requesterId: f.intent.requesterId });
  if (status.attempts?.storage !== "ready") assert.fail();
  assert.equal(status.attempts?.last?.attemptRef, f.authorization.attemptRef); assert.equal(status.attempts?.last?.modelOutcome, "unknown");
  assert.equal(status.delivery?.state, "verified"); assert.equal(status.disposition?.storage, "absent");
  let nativeAdmissions = 0, historyReads = 0, replyOpens = 0;
  const ticket: StandingIdleHistoryTicket = { openHistoryTask() { historyReads++; throw Error("must not read source"); }, openTaskReply() { replyOpens++; throw Error("must not replay delivery"); } };
  const runner = await openStandingHistoryTaskRunner({ directories: f.directories, passphrase: f.passphrase, binding: { accountId: f.intent.accountId, peerId: f.intent.chatId }, signal: f.controller.signal, manager,
    adapter: { async pollWork() { return { kind: "idle", ticket }; } }, verifyOwnerSettled: settled,
    connection: { async prepare() { nativeAdmissions++; return { restoration: false }; }, async acquireAnalysisAdmission() { nativeAdmissions++; throw Error("must not replay old attempt"); } } }); t.after(() => runner.close());
  let terminal = false;
  for (let i = 0; i < 32; i++) { const work = await runner.poll(); if (work.kind === "background" && work.outcome.kind === "delivery-state") { assert.equal(work.outcome.state, "verified"); terminal = true; break; } }
  assert.equal(terminal, true); for (let i = 0; i < 8; i++) await runner.poll();
  assert.equal(nativeAdmissions + historyReads + replyOpens, 0); assert.equal(n.counts.turns, 1);
  assert.equal((await readStandingHistoryTaskDelivery({ directory: f.directories.delivery, ...f.binding })).delivery, "verified");
});

test("new generation UNKNOWN remains consumed across reopen and cannot reset or replay either attempt", async t => {
  const f = await fixture(t), before = await originals(f), n = native(f, "unknown");
  const first = await openStandingHistoryTaskContinuation({ ...f.args, mode: "create" });
  const result = await advance(first, f, n.connection, "one-explicit-new-request"); assert.equal(result.kind, "attempt"); if (result.kind !== "attempt") assert.fail(); assert.equal(result.modelOutcome, "unknown"); assert.equal(result.node, undefined);
  await assert.rejects(advance(first, f, n.connection, "warm-must-not-replay"), /CONSUMED/); await first.close();
  await assert.rejects(openStandingHistoryTaskContinuation({ ...f.args, mode: "create" }));
  const reopened = await openStandingHistoryTaskContinuation({ ...f.args, mode: "open" }); t.after(() => reopened.close());
  await assert.rejects(advance(reopened, f, n.connection, "must-not-replay"), /CONSUMED/); assert.equal(n.counts.turns, 1); assert.equal(n.counts.acquired, 1);
  assert.deepEqual(await originals(f), before);
});

test("warm scan skips full-store reopen but still refuses changed saved source before model admission", async t => {
  const f = await fixture(t, true, 6), coordinator = await openStandingHistoryTaskContinuation({ ...f.args, mode: "create" }), n = native(f);
  t.after(() => coordinator.close());
  assert.equal((await coordinator.next({ connection: n.connection, requestRef: "scan", signal: f.controller.signal })).kind, "scan-more");
  const target = join(f.directories.pages, f.intent.taskId, "intent.enc"), originalOpen = fs.promises.open;
  let intentOpens = 0;
  const mocked = t.mock.method(fs.promises, "open", (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]) === target) intentOpens++;
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await coordinator.next({ connection: n.connection, requestRef: "scan", signal: f.controller.signal });
    assert.equal(result.kind, "scan-more");
    assert.equal(intentOpens, 2, "only before/after preserved-byte guards; no decrypted store reopen");
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const foreign = join(f.directory, f.intent.taskId, "attempts", f.intent.taskId, "unexpected.enc");
  await writeFile(foreign, "unobserved attempt data");
  await assert.rejects(coordinator.next({ connection: n.connection, requestRef: "foreign-attempt", signal: f.controller.signal }), /STORAGE/);
  assert.equal(await readFile(foreign, "utf8"), "unobserved attempt data");
  assert.equal(n.counts.acquired, 0);
  const path = join(f.directories.pages, f.intent.taskId, "page-000001.enc");
  await writeFile(path, "changed saved source");
  await assert.rejects(coordinator.next({ connection: n.connection, requestRef: "changed", signal: f.controller.signal }), /BINDING/);
  assert.equal(n.counts.acquired, 0);
});

test("cold prepared continuation output reconciles an exact saved node without dispatching another model", async t => {
  const f = await fixture(t), before = await originals(f), first = await openStandingHistoryTaskContinuation({ ...f.args, mode: "create" }); await first.close();
  const source = await openStandingHistoryTaskStore({ ...f.binding, directory: f.directories.pages, mode: "open" });
  const analysis = await openStandingHistoryAnalysisStore({ ...f.binding, directory: f.directories.analysis, mode: "open", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...f.binding, directory: join(f.directory, f.intent.taskId, "attempts"), mode: "open", analysis });
  const planner = createStandingHistoryAnalysisPlanner({ intent: f.intent, source, analysis, packing: "wide" });
  let p = await planner.next(); for (let i = 0; p.kind === "scan-more" && i < 32; i++) p = await planner.next(); if (p.kind !== "merge") assert.fail();
  const prepared = prepareStandingHistoryAnalysisMaterial(p), reserved = await attempts.reserve({ plan: { kind: "merge", children: p.children, sourceHead: p.sourceHead, expectedHead: p.expectedHead, nodeIndex: 3, modelInputHash: prepared.modelInputHash },
    nativeBinding: { epochId: "b".repeat(32), requestRef: "prepared-before-host-crash", purpose: "history-analysis" } });
  await attempts.prepare({ attemptRef: reserved.attemptRef, output: { summary: "Prepared before lost host response", claims: [] } });
  await planner.close(); await attempts.close(); await analysis.close(); await source.close();
  const recovered = await openStandingHistoryTaskContinuation({ ...f.args, mode: "open" }); t.after(() => recovered.close()); const n = native(f);
  const result = await advance(recovered, f, n.connection, "reconcile-only"); assert.equal(result.kind, "recovered"); if (result.kind !== "recovered") assert.fail();
  assert.equal(result.attemptRef, reserved.attemptRef); assert.equal(result.node.index, 3); assert.equal(result.modelOutcome, "unknown"); assert.equal(n.counts.acquired, 0);
  assert.equal((await advance(recovered, f, n.connection, "derive-existing-ready")).kind, "analysis-ready"); assert.equal(n.counts.turns, 0);
  const after = await originals(f); for (const [name, body] of Object.entries(before)) assert.equal(after[name], body, name);
});

test("source incomplete, stale authorization and missing owner proof cannot activate continuation", async t => {
  const incomplete = await fixture(t, false);
  await assert.rejects(openStandingHistoryTaskContinuation({ ...incomplete.args, mode: "create" }), /SOURCE-INCOMPLETE/);
  assert.deepEqual(await readdir(incomplete.directory), []);
  const f = await fixture(t), before = await originals(f);
  await assert.rejects(openStandingHistoryTaskContinuation({ ...f.args, mode: "create", authorization: { ...f.authorization, analysisHead: "0".repeat(64) } }), /BINDING/);
  await assert.rejects(openStandingHistoryTaskContinuation({ ...f.args, mode: "create", async verifyOwnerSettled() { throw Error("exact old owner not proved settled"); } }));
  assert.deepEqual(await readdir(f.directory), []); assert.deepEqual(await originals(f), before);
});

test("foreign old-journal additions and incomplete continuation activation are preserved and refuse admission", async t => {
  const f = await fixture(t), first = await openStandingHistoryTaskContinuation({ ...f.args, mode: "create" }); await first.close();
  const extra = join(f.directories.attempts, f.intent.taskId, "unexpected.enc"); await writeFile(extra, "preserved foreign file");
  await assert.rejects(openStandingHistoryTaskContinuation({ ...f.args, mode: "open" })); assert.equal(await readFile(extra, "utf8"), "preserved foreign file");
  const g = await fixture(t), slot = join(g.directory, g.intent.taskId); await mkdir(slot); await writeFile(join(slot, "authorization.enc"), "uncertain partial receipt");
  await assert.rejects(openStandingHistoryTaskContinuation({ ...g.args, mode: "open" }));
  await assert.rejects(openStandingHistoryTaskContinuation({ ...g.args, mode: "create" })); assert.equal(await readFile(join(slot, "authorization.enc"), "utf8"), "uncertain partial receipt");
});

async function failedPredecessor(t: TestContext) {
  const f = await fixture(t), first = await openStandingHistoryTaskContinuation({ ...f.args, mode: "create" }), n = native(f, "unknown");
  const failed = await advance(first, f, n.connection, "failed-first-continuation");
  assert.equal(failed.kind, "attempt"); await first.close();
  const source = await openStandingHistoryTaskStore({ ...f.binding, directory: f.directories.pages, mode: "open" });
  const analysis = await openStandingHistoryAnalysisStore({ ...f.binding, directory: f.directories.analysis, mode: "open", readSourcePage: i => source.readPage(i) });
  const attemptsRoot = join(f.directory, f.intent.taskId, "attempts");
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...f.binding, directory: attemptsRoot, mode: "open", analysis });
  const status = await attempts.status(), a = await analysis.status(); assert.ok(status.last);
  await attempts.close(); await analysis.close(); await source.close();
  const prior = JSON.parse(await decryptSession(await readFile(join(f.directory, f.intent.taskId, "authorization.enc"), "utf8"), f.passphrase));
  const directory = join(f.root, "successor"); await mkdir(directory);
  const args = { ...f.args, directory, predecessor: { directory: f.directory, authorizationHash: createHash("sha256").update(JSON.stringify(prior)).digest("hex") },
    authorization: { ...f.authorization, continuationRef: "hcont_" + "8".repeat(48), requestHash: "d".repeat(64), analysisHead: a.headHash,
      attemptRef: status.last.attemptRef, planHash: status.last.planHash } };
  const oldBytes: Record<string, string> = {};
  for (const name of await readdir(join(attemptsRoot, f.intent.taskId))) oldBytes[name] = (await readFile(join(attemptsRoot, f.intent.taskId, name))).toString("base64");
  return { f, args, attemptsRoot, oldBytes };
}

test("explicit successor preserves failed predecessor, finishes saved work and cold reopens", async t => {
  const { f, args, attemptsRoot, oldBytes } = await failedPredecessor(t), before = await originals(f), n = native(f);
  let successor = await openStandingHistoryTaskContinuation({ ...args, mode: "create" });
  const result = await advance(successor, f, n.connection, "authorized-successor");
  if (n.errors.length) throw n.errors[0]; assert.equal(result.kind, "attempt");
  if (result.kind !== "attempt") assert.fail(); assert.equal(result.modelOutcome, "observed"); assert.equal(result.node?.index, 3);
  assert.equal((await advance(successor, f, n.connection, "successor-ready")).kind, "analysis-ready"); await successor.close();
  successor = await openStandingHistoryTaskContinuation({ ...args, mode: "open" }); await successor.close();
  const after = await originals(f); for (const [name, bytes] of Object.entries(before)) assert.equal(after[name], bytes);
  for (const [name, bytes] of Object.entries(oldBytes)) assert.equal((await readFile(join(attemptsRoot, f.intent.taskId, name))).toString("base64"), bytes);
  assert.equal(n.counts.turns, 1);
});

test("successor rejects stale proof and missing settlement; its own UNKNOWN is not retried", async t => {
  const { f, args } = await failedPredecessor(t), n = native(f, "unknown");
  await assert.rejects(openStandingHistoryTaskContinuation({ ...args, mode: "create", predecessor: { ...args.predecessor, authorizationHash: "0".repeat(64) } }), /BINDING/);
  await assert.rejects(openStandingHistoryTaskContinuation({ ...args, mode: "create", authorization: { ...args.authorization, attemptRef: f.authorization.attemptRef } }), /BINDING/);
  await assert.rejects(openStandingHistoryTaskContinuation({ ...args, mode: "create", async verifyOwnerSettled() { throw Error("not settled"); } }));
  assert.deepEqual(await readdir(args.directory), []);
  const successor = await openStandingHistoryTaskContinuation({ ...args, mode: "create" });
  const result = await advance(successor, f, n.connection, "successor-unknown"); assert.equal(result.kind, "attempt");
  await assert.rejects(advance(successor, f, n.connection, "no-warm-replay"), /CONSUMED/); await successor.close();
  const reopened = await openStandingHistoryTaskContinuation({ ...args, mode: "open" });
  await assert.rejects(advance(reopened, f, n.connection, "no-cold-replay"), /CONSUMED/); await reopened.close();
  assert.equal(n.counts.turns, 1);
});
