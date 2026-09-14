import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createSelfHistoryReader } from "../src/self-history-reader.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisNode } from "../src/standing-history-analysis-store.js";

// Actual reader, page storage, projection and analysis ledger. Only Telegram
// history and model-authored notes are synthetic; no serving or model call.
test("stored history material and retained analysis tree survive reopen without losing early provenance", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-analysis-coupled-"));
  const pagesDirectory = join(root, "pages"), directory = join(root, "analysis");
  await mkdir(pagesDirectory); await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1",
    taskId: "htask_" + randomBytes(24).toString("hex"), accountId: "123", chatId: "-100456",
    requesterId: "789", primaryMessageId: 999, fromDate: 1700000000, toDate: 1700001000,
    timezone: "Europe/Moscow", objective: "Собери решения и открытые вопросы" };
  const passphrase = "synthetic-analysis-coupling-passphrase";
  const refs = createConversationReferences({ accountId: intent.accountId, peerId: intent.chatId });
  const values = Array.from({ length: 24 }, (_, i) => new Api.Message({ id: 100 + i,
    date: intent.fromDate + i, message: "Source " + i + " " + "x".repeat(350),
    peerId: new Api.PeerChannel({ channelId: bigInt(456) }),
    fromId: new Api.PeerUser({ userId: bigInt(789) }) }));
  const reader = createSelfHistoryReader({ binding: { accountId: intent.accountId, peerId: intent.chatId },
    signal: new AbortController().signal, references: refs,
    self: new Api.User({ id: bigInt(123), self: true }),
    peer: new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(12345) }),
    client: { async invoke(request: Api.AnyRequest) {
      assert.ok(request instanceof Api.messages.GetHistory);
      return new Api.messages.Messages({ messages: values.filter(m => !request.offsetId || m.id < request.offsetId)
        .sort((a, b) => b.id - a.id).slice(0, request.limit),
        users: [new Api.User({ id: bigInt(789), firstName: "Участник" })], chats: [] });
    } } });
  const pages = await openStandingHistoryTaskStore({ directory: pagesDirectory, passphrase, intent, mode: "create" });
  const readSourcePage = (index: number) => pages.readPage(index);
  let analysis: Awaited<ReturnType<typeof openStandingHistoryAnalysisStore>> | undefined;
  try {
    const checkpoint = (await pages.status()).readProgress.checkpoint;
    const read = await reader.readTaskPage({ fromDate: intent.fromDate, toDate: intent.toDate, checkpoint });
    await pages.appendPage({ expectedCheckpoint: checkpoint, result: read });
    const stored = await pages.readPage(1); assert.ok(stored);
    analysis = await openStandingHistoryAnalysisStore({ directory, passphrase, intent, mode: "create", readSourcePage });
    const referenceKey = analysis.referenceKey();
    const leafRefs: string[] = [];
    const retainedSources = new Map<string, { versionRef: string; text: string }>();
    let position: string | undefined;
    do {
      const material = projectStandingHistorySource({ intent, referenceKey, storedPage: stored, maxBytes: 2048,
        ...(position ? { position } : {}) });
      const row = material.rows.find(r => r.disposition === "included"); assert.ok(row);
      retainedSources.set(row.sourceRef, { versionRef: row.versionRef, text: row.text });
      const node = await analysis.appendLeaf({ expectedHead: (await analysis.status()).headHash,
        inputs: [{ pageIndex: 1, maxBytes: 2048, materialRef: material.materialRef, ...(position ? { position } : {}) }],
        output: { summary: "Synthetic notes for fragment", claims: [{ kind: "reported", text: row.text,
          supports: [{ sourceRef: row.sourceRef, versionRef: row.versionRef }] }] } });
      leafRefs.push(node.nodeRef);
      position = material.nextPosition ?? undefined;
      await analysis.close();
      analysis = await openStandingHistoryAnalysisStore({ directory, passphrase, intent, mode: "open", readSourcePage });
      assert.equal(analysis.referenceKey(), referenceKey);
      assert.ok(await analysis.readNode(node.nodeRef));
    } while (position);
    assert.ok(leafRefs.length > 8);
    let roots = leafRefs;
    while (roots.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < roots.length; i += 2) {
        if (i + 1 === roots.length) { next.push(roots[i]!); continue; }
        const child = await analysis.readNode(roots[i]!); assert.ok(child);
        const node = await analysis.appendMerge({ expectedHead: (await analysis.status()).headHash,
          children: roots.slice(i, i + 2), output: { summary: "Synthetic merged notes",
            claims: child.output.claims.slice(0, 1), omittedDetailCount: 1 } });
        next.push(node.nodeRef);
      }
      roots = next;
    }
    await analysis.close();
    analysis = await openStandingHistoryAnalysisStore({ directory, passphrase, intent, mode: "open", readSourcePage });
    // Fresh planner learns the node inventory from disk; remembered references
    // below are only expected-value assertions, not inputs to recovery.
    const recoveredNodes: StandingHistoryAnalysisNode[] = [];
    const recoveredStatus = await analysis.status();
    for (let index = 1; index <= recoveredStatus.analysisNodes; index++) {
      const recovered: StandingHistoryAnalysisNode | undefined = await analysis.readNodeAt(index); assert.ok(recovered);
      recoveredNodes.push(recovered);
    }
    assert.equal(recoveredNodes.at(-1)?.nodeRef, roots[0]);
    const recoveredLeaves = recoveredNodes.filter(node => node.kind === "leaf");
    assert.equal(recoveredLeaves.length, leafRefs.length);
    for (const recovered of recoveredLeaves) {
      const claim: StandingHistoryAnalysisNode["output"]["claims"][number] = recovered.output.claims[0]!;
      const support: (typeof claim)["supports"][number] = claim.supports[0]!;
      assert.deepEqual(retainedSources.get(support.sourceRef), { versionRef: support.versionRef, text: claim.text });
    }
    assert.equal((await pages.status()).modelProgress, "not-recorded");
    assert.equal((await analysis.status()).claims, "model-authored-unverified");
    assert.equal((await pages.readPage(1))?.hash, stored.hash);
  } finally { await analysis?.close(); await pages.close(); reader.close(); refs.close(); }
});
