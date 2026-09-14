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
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";

test("fresh planner fills an interior coverage gap and finishes actual stored material without duplicating analysis", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-planner-coupled-"));
  const directory = join(root, "pages"), analysisDirectory = join(root, "analysis");
  await mkdir(directory); await mkdir(analysisDirectory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + randomBytes(24).toString("hex"),
    accountId: "123", chatId: "-100456", requesterId: "789", primaryMessageId: 100,
    fromDate: 1, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize the available period" };
  const passphrase = "synthetic-planner-coupling-passphrase";
  const references = createConversationReferences({ accountId: intent.accountId, peerId: intent.chatId });
  const values = Array.from({ length: 6 }, (_, i) => new Api.Message({ id: 10 + i, date: 100,
    message: "Observed source " + i, peerId: new Api.PeerChannel({ channelId: bigInt(456) }), fromId: new Api.PeerUser({ userId: bigInt(789) }) }));
  const reader = createSelfHistoryReader({ binding: { accountId: intent.accountId, peerId: intent.chatId }, references,
    self: new Api.User({ id: bigInt(123), self: true }), peer: new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(12345) }),
    signal: new AbortController().signal, client: { async invoke(request: Api.AnyRequest) {
      assert.ok(request instanceof Api.messages.GetHistory);
      return new Api.messages.Messages({ messages: values.filter(m => !request.offsetId || m.id < request.offsetId)
        .sort((a, b) => b.id - a.id).slice(0, request.limit), users: [new Api.User({ id: bigInt(789), firstName: "Participant" })], chats: [] });
    } } });
  const source = await openStandingHistoryTaskStore({ directory, passphrase, intent, mode: "create" });
  const analysis = await openStandingHistoryAnalysisStore({ directory: analysisDirectory, passphrase, intent, mode: "create", readSourcePage: i => source.readPage(i) });
  const openPlanner = () => createStandingHistoryAnalysisPlanner({ intent,
    source: { status: () => source.status(), readPage: (i: number) => source.readPage(i) },
    analysis: { status: () => analysis.status(), readNodeAt: (i: number) => analysis.readNodeAt(i), referenceKey: () => analysis.referenceKey() } });
  let planner: ReturnType<typeof openPlanner> | undefined;
  try {
    const checkpoint = (await source.status()).readProgress.checkpoint;
    const read = await reader.readTaskPage({ fromDate: 1, toDate: 200, checkpoint });
    await source.appendPage({ expectedCheckpoint: checkpoint, result: read });
    const stored = await source.readPage(1); assert.ok(stored);
    const first = projectStandingHistorySource({ intent, referenceKey: analysis.referenceKey(), storedPage: stored, maxRows: 1 });
    assert.ok(first.nextPosition);
    const second = projectStandingHistorySource({ intent, referenceKey: analysis.referenceKey(), storedPage: stored, maxRows: 1, position: first.nextPosition });
    // An authenticated later row exists while the first row is still a hole.
    await analysis.appendLeaf({ expectedHead: (await analysis.status()).headHash,
      inputs: [{ pageIndex: 1, maxBytes: 49152, maxRows: 1, position: first.nextPosition, materialRef: second.materialRef }],
      output: { summary: "Previously analyzed second row", claims: [] } });
    planner = openPlanner();
    let filledGap = false, readFurther = false, merged = false, ready = false;
    for (let step = 0; step < 200; step++) {
      const plan = await planner.next();
      if (plan.kind === "scan-more") continue;
      assert.notEqual(plan.kind, "blocked");
      const repeated = await planner.next();
      assert.deepEqual(repeated, plan, "no commit means no claimed progress or new action");
      if (plan.kind === "leaf") {
        assert.ok(Buffer.byteLength(JSON.stringify(plan.material)) <= 49152);
        if (!filledGap) { assert.equal(plan.material.range.fromRow, 0); assert.equal(plan.material.range.toRow, 1); filledGap = true; }
        await analysis.appendLeaf({ expectedHead: plan.expectedHead, inputs: plan.inputs,
          output: { summary: "Synthetic analysis of exact material", claims: [] } });
      } else if (plan.kind === "merge") {
        assert.ok(Buffer.byteLength(JSON.stringify(plan.materials)) <= 49152);
        await analysis.appendMerge({ expectedHead: plan.expectedHead, children: plan.children,
          output: { summary: "Synthetic merged notes retaining child provenance", claims: [] } }); merged = true;
      } else if (plan.kind === "read-more") {
        const result = await reader.readTaskPage({ fromDate: 1, toDate: 200, checkpoint: plan.checkpoint });
        await source.appendPage({ expectedCheckpoint: plan.checkpoint, result }); readFurther = true;
      } else if (plan.kind === "analysis-ready") {
        assert.equal(plan.coverage.committedPages, 2); assert.equal(plan.coverage.coveredPages, 2);
        assert.equal(plan.coverage.sourceRows, 6); assert.equal(plan.coverage.coveredRows, 6);
        assert.equal(plan.coverage.readTraversalComplete, true); assert.deepEqual(plan.gaps, []);
        assert.ok(plan.rootRef); ready = true; break;
      }
      await planner.close(); planner = openPlanner();
    }
    assert.ok(ready && filledGap && readFurther && merged);
    assert.equal((await source.status()).modelProgress, "not-recorded");
    assert.equal((await analysis.status()).claims, "model-authored-unverified");
  } finally { await planner?.close(); await analysis.close(); await source.close(); reader.close(); references.close(); }
});
