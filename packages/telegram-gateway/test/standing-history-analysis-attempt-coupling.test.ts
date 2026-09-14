import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createSelfHistoryReader } from "../src/self-history-reader.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore, validateStandingHistoryShownOutput } from "../src/standing-history-analysis-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisAttemptPlan } from "../src/standing-history-analysis-attempt-store.js";

test("planner, shown-source admission and attempt journal reduce reopened source without replaying committed unknown work", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-attempt-coupled-"));
  const dirs = { pages: join(root, "pages"), analysis: join(root, "analysis"), attempts: join(root, "attempts") };
  for (const directory of Object.values(dirs)) await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + randomBytes(24).toString("hex"),
    accountId: "123", chatId: "-100456", requesterId: "789", primaryMessageId: 100,
    fromDate: 1, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize the available period" };
  const passphrase = "synthetic-attempt-coupling-passphrase", binding = { passphrase, intent };
  const references = createConversationReferences({ accountId: intent.accountId, peerId: intent.chatId });
  const values = [new Api.Message({ id: 10, date: 100, message: "Observed source",
    peerId: new Api.PeerChannel({ channelId: bigInt(456) }), fromId: new Api.PeerUser({ userId: bigInt(789) }) })];
  const reader = createSelfHistoryReader({ binding: { accountId: intent.accountId, peerId: intent.chatId }, references,
    self: new Api.User({ id: bigInt(123), self: true }), peer: new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(12345) }),
    signal: new AbortController().signal, client: { async invoke(request: Api.AnyRequest) {
      assert.ok(request instanceof Api.messages.GetHistory);
      return new Api.messages.Messages({ messages: values.filter(m => !request.offsetId || m.id < request.offsetId),
        users: [new Api.User({ id: bigInt(789), firstName: "Participant" })], chats: [] });
    } } });
  const source = await openStandingHistoryTaskStore({ ...binding, directory: dirs.pages, mode: "create" });
  const analysisArgs = { ...binding, directory: dirs.analysis, readSourcePage: (i: number) => source.readPage(i) };
  let analysis = await openStandingHistoryAnalysisStore({ ...analysisArgs, mode: "create" });
  const openAttempts = (mode: "create" | "open") => openStandingHistoryAnalysisAttemptStore({ ...binding, directory: dirs.attempts, analysis, mode });
  let attempts = await openAttempts("create");
  const openPlanner = () => createStandingHistoryAnalysisPlanner({ intent, source, analysis });
  let planner = openPlanner(), modelCalls = 0, merged = false, ready = false, recoveredUnknown = false;
  const seen = new Set<string>();
  try {
    for (let step = 0; step < 50; step++) {
      const plan = await planner.next();
      if (plan.kind === "scan-more") continue;
      assert.notEqual(plan.kind, "blocked");
      if (plan.kind === "read-more") {
        await source.appendPage({ expectedCheckpoint: plan.checkpoint,
          result: await reader.readTaskPage({ fromDate: 1, toDate: 200, checkpoint: plan.checkpoint }) });
      } else if (plan.kind === "leaf" || plan.kind === "merge") {
        const material = plan.kind === "leaf" ? plan.material : plan.materials;
        const shown = plan.kind === "leaf" ? plan.material.rows.filter(r => r.disposition === "included").map(r => ({ sourceRef: r.sourceRef, versionRef: r.versionRef }))
          : plan.materials.flatMap(n => n.claims.flatMap(c => c.supports));
        const reservationPlan: StandingHistoryAnalysisAttemptPlan = { kind: plan.kind, sourceHead: plan.sourceHead, expectedHead: plan.expectedHead,
          nodeIndex: (await analysis.status()).analysisNodes + 1,
          modelInputHash: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
          ...(plan.kind === "leaf" ? { inputs: plan.inputs } : { children: plan.children }) } as StandingHistoryAnalysisAttemptPlan;
        const admitted = await attempts.reserve({ plan: reservationPlan });
        assert.ok(!seen.has(admitted.planHash)); seen.add(admitted.planHash);
        // Synthetic model result only; native settlement is not exercised here.
        modelCalls++;
        const output = validateStandingHistoryShownOutput({ summary: "Synthetic bounded summary", claims: shown.length
          ? [{ kind: "reported", text: "Synthetic claim", supports: [shown[0]!] }] : [] }, shown);
        await attempts.prepare({ attemptRef: admitted.attemptRef, output });
        const node = await attempts.commitPrepared({ attemptRef: admitted.attemptRef });
        const outcome: "observed" | "unknown" = recoveredUnknown ? "observed" : "unknown";
        await attempts.recordModelOutcome({ attemptRef: admitted.attemptRef, outcome });
        await planner.close(); await attempts.close(); await analysis.close();
        analysis = await openStandingHistoryAnalysisStore({ ...analysisArgs, mode: "open" }); attempts = await openAttempts("open");
        const before = modelCalls, state = await attempts.status();
        assert.equal(state.last!.modelOutcome, outcome); assert.deepEqual(state.last!.node, node); assert.equal(state.modelReplayAllowed, false);
        // The committed node is independently reconciled; no model callback/retry.
        assert.deepEqual(await attempts.commitPrepared({ attemptRef: admitted.attemptRef }), node);
        assert.equal(modelCalls, before); assert.equal((await analysis.status()).analysisNodes, node.index);
        recoveredUnknown = true; merged ||= plan.kind === "merge";
        planner = openPlanner(); continue;
      } else if (plan.kind === "analysis-ready") {
        assert.equal(plan.coverage.sourceRows, 1); assert.equal(plan.coverage.coveredRows, 1);
        assert.equal(plan.coverage.committedPages, 2); assert.equal(plan.coverage.coveredPages, 2);
        assert.equal(plan.coverage.readTraversalComplete, true); assert.deepEqual(plan.gaps, []); assert.ok(plan.rootRef);
        ready = true; break;
      }
      await planner.close(); planner = openPlanner();
    }
    assert.ok(ready && merged && recoveredUnknown); assert.equal(modelCalls, 3);
    assert.equal((await attempts.status()).attempts, 3); assert.equal((await analysis.status()).claims, "model-authored-unverified");
  } finally { await planner.close(); await attempts.close(); await analysis.close(); await source.close(); reader.close(); references.close(); }
});
