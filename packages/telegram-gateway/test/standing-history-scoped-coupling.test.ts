import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createSelfHistoryReader } from "../src/self-history-reader.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { openStandingHistoryAnalysisAttemptStore } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisRuntime, prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { openStandingScopedEpochSession } from "../src/standing-scoped-epoch-session.js";

for (const failure of ["none", "material", "commit"] as const) test(failure === "material"
  ? "uncertain material write never acknowledges exposure or commits empty-claim output"
  : failure === "commit" ? "lost commit response preserves the saved node and native UNKNOWN without replay"
  : "scoped transport acknowledges actual material before committing a stored analysis then returns to conversation", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-scoped-coupled-"));
  const dirs = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts") };
  for (const directory of Object.values(dirs)) await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + randomBytes(24).toString("hex"),
    accountId: "123", chatId: "-100456", requesterId: "789", primaryMessageId: 100,
    fromDate: 1, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize the available period" };
  const binding = { passphrase: "synthetic-scoped-coupling-passphrase", intent }, signal = new AbortController();
  const references = createConversationReferences({ accountId: intent.accountId, peerId: intent.chatId });
  const reader = createSelfHistoryReader({ binding: { accountId: intent.accountId, peerId: intent.chatId }, references, signal: signal.signal,
    self: new Api.User({ id: bigInt(123), self: true }), peer: new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(12345) }),
    client: { async invoke(request: Api.AnyRequest) {
      assert.ok(request instanceof Api.messages.GetHistory);
      return new Api.messages.Messages({ messages: [new Api.Message({ id: 10, date: 100, message: "Observed source",
        peerId: new Api.PeerChannel({ channelId: bigInt(456) }), fromId: new Api.PeerUser({ userId: bigInt(789) }) })],
        users: [new Api.User({ id: bigInt(789), firstName: "Participant" })], chats: [] });
    } } });
  const source = await openStandingHistoryTaskStore({ ...binding, directory: dirs.pages, mode: "create" });
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: dirs.control, mode: "create" });
  const analysis = await openStandingHistoryAnalysisStore({ ...binding, directory: dirs.analysis, mode: "create", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: dirs.attempts, mode: "create", analysis });
  const runtime = createStandingHistoryAnalysisRuntime({ intent, signal: signal.signal, source, control, analysis, attempts });
  const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis });
  const before = (await source.status()).readProgress.checkpoint;
  await source.appendPage({ expectedCheckpoint: before, result: await reader.readTaskPage({ fromDate: 1, toDate: 200, checkpoint: before }) });
  let plan = await planner.next(); for (let i = 0; i < 10 && plan.kind === "scan-more"; i++) plan = await planner.next();
  assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") throw Error("expected leaf");
  const prepared = prepareStandingHistoryAnalysisMaterial(plan);
  const reservedPlan = { kind: "leaf" as const, sourceHead: plan.sourceHead, expectedHead: plan.expectedHead,
    nodeIndex: 1, modelInputHash: prepared.modelInputHash, inputs: plan.inputs };
  const reserved = await attempts.reserve({ plan: reservedPlan });
  await runtime.begin({ requestRef: "analysis-1", attemptRef: reserved.attemptRef, plan: reservedPlan,
    material: prepared.material, controlHead: (await control.status()).headHash, signal: signal.signal });

  const names = ["neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit"];
  const queue: unknown[] = [{ kind: "ready", protocol: "standing-scoped-epoch-v1", scopes: [
    { purpose: "conversation", tools: ["neurobro_read_history"] }, { purpose: "history-analysis", tools: names }] }];
  let globalTurn = 0, conversationTurns = 0, analysisTurns = 0, sentMaterial = false, acknowledged = false, failedMaterial = false, failedCommit = false;
  let current: Record<string, unknown> = {};
  const complete = (calls: number) => {
    const scope = { purpose: current.purpose, requestRef: current.requestRef, threadId: "thread-" + current.purpose,
      turnId: "turn-" + globalTurn, turnNumber: globalTurn, threadTurnNumber: current.purpose === "conversation" ? conversationTurns : analysisTurns };
    queue.push({ kind: "scope", scope }, { kind: "completed", scope, answer: "Synthetic completed response", kindOfAnswer: "text", toolCalls: calls, toolRefusals: 0 });
  };
  const session = await openStandingScopedEpochSession({ epochId: "a".repeat(32), signal: signal.signal, custodyReady: () => true,
    conversation: { history: { async call() { throw Error("analysis must not call raw history"); } } }, analysisTools: runtime.handlers,
    onToolResultSent: async event => {
      assert.equal(event.purpose, "history-analysis");
      if (event.name === names[0]) { assert.ok(sentMaterial); acknowledged = true; }
      await runtime.onToolResultSent({ requestRef: event.requestRef, callRef: event.callRef, name: event.name, result: event.result });
    },
    wire: { async receive() { assert.ok(queue.length, "unexpected receive"); return queue.shift(); }, async send(value) {
      const frame = value as Record<string, unknown>;
      if (frame.kind === "turn") {
        current = frame; globalTurn++;
        if (frame.purpose === "conversation") { conversationTurns++; complete(0); }
        else { analysisTurns++; queue.push({ kind: "tool", purpose: frame.purpose, requestRef: frame.requestRef, callRef: "material-1", name: names[0], arguments: {} }); }
      } else if (frame.kind === "toolResult") {
        const returned = frame.result as { success: boolean; contentItems: { text: string }[] }; assert.equal(returned.success, true);
        if (frame.callRef === "material-1") {
          assert.equal(acknowledged, false); assert.equal((await analysis.status()).analysisNodes, 0); sentMaterial = true;
          if (failure === "material") { failedMaterial = true; throw Error("synthetic uncertain material write"); }
          queue.push({ kind: "tool", purpose: current.purpose, requestRef: current.requestRef, callRef: "commit-1", name: names[2],
            arguments: { output: { summary: "Synthetic summary after material receipt", claims: [] } } });
        } else {
          assert.ok(acknowledged); assert.equal((await analysis.status()).analysisNodes, 1);
          if (failure === "commit") { failedCommit = true; throw Error("synthetic uncertain commit response"); }
          complete(2);
        }
      } else if (frame.kind === "release") queue.push({ ...frame, kind: "released" });
      else if (frame.kind === "close") queue.push({ kind: "closed", code: failedMaterial || failedCommit ? "IO_UNKNOWN" : "CLOSED", facts: {
        schema: "neurobro-native-scoped-epoch-v1", threadLimit: 2, turnLimit: 16, epochSeconds: 900, turnSeconds: 300,
        threadStarted: true, threadStartDispatches: 2, turnStartDispatches: globalTurn, turnsAdmitted: globalTurn, turnsAttempted: globalTurn,
        toolCalls: failedMaterial ? 1 : 2, closed: true, running: false, busy: false, releasePending: false, poisoned: failedMaterial || failedCommit, unreleasedTurn: failedMaterial || failedCommit,
        resourceSettlementObserved: false, slots: [
          { purpose: "conversation", threadStarted: true, turnsAdmitted: conversationTurns, turnsAttempted: conversationTurns, toolCalls: 0, closed: true, poisoned: false },
          { purpose: "history-analysis", threadStarted: true, turnsAdmitted: analysisTurns, turnsAttempted: analysisTurns, toolCalls: failedMaterial ? 1 : 2, closed: true, poisoned: failedMaterial || failedCommit }] } });
      else throw Error("unexpected send");
    } } });
  try {
    await session.turnConversation("conversation-1", "First synthetic conversation"); await session.releaseConversation("conversation-1", "not-sent");
    const turn = session.turnAnalysis("analysis-1", JSON.stringify({ schema: "neurobro-history-analysis-input-v1", kind: "leaf", objective: intent.objective, materialAvailable: true }));
    if (failure !== "none") {
      await assert.rejects(turn); await attempts.recordModelOutcome({ attemptRef: reserved.attemptRef, outcome: "unknown" });
      await runtime.finish(); assert.equal(acknowledged, failure === "commit");
      assert.equal((await analysis.status()).analysisNodes, failure === "commit" ? 1 : 0);
      const status = await attempts.status();
      if (failure === "material") { assert.equal(status.last!.prepared, undefined); assert.equal(status.last!.node, undefined); }
      else { assert.ok(status.last!.prepared); assert.equal(status.last!.node!.index, 1); }
      assert.equal(status.last!.modelOutcome, "unknown"); assert.equal(status.modelReplayAllowed, false);
      await assert.rejects(attempts.reserve({ plan: reservedPlan }));
      const closed = await session.close(); assert.equal(closed.unreleasedTurn, true); assert.equal(closed.resourceSettlementObserved, false);
      return;
    }
    const completed = await turn;
    assert.equal(completed.kind, "analysis"); assert.equal(completed.scope.threadTurnNumber, 1); assert.equal(completed.scope.turnNumber, 2);
    await attempts.recordModelOutcome({ attemptRef: reserved.attemptRef, outcome: "observed" }); await session.releaseAnalysis("analysis-1"); await runtime.finish();
    await session.turnConversation("conversation-2", "Continue synthetic conversation"); await session.releaseConversation("conversation-2", "not-sent");
    assert.equal((await attempts.status()).last!.node!.index, 1); assert.equal(globalTurn, 3); assert.equal(conversationTurns, 2);
    const closed = await session.close(); assert.equal(closed.nativeLoopClosed, true); assert.equal(closed.resourceSettlementObserved, false);
  } finally {
    // Joined fake-wire closure is not managed-process settlement.
    try { await session.close(); } finally {
      signal.abort(); await runtime.close(); await planner.close(); await attempts.close(); await analysis.close(); await control.close(); await source.close(); reader.close(); references.close();
    }
  }
});
