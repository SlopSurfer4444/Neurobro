import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createSelfHistoryReader, type SelfHistoryMessage } from "../src/self-history-reader.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskDiscovery } from "../src/standing-history-task-discovery.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";

// Real reader, generated GramJS requests and encrypted on-disk store; only the
// Telegram invoker is a fixture. This is not a live model or task scheduler test.
test("history page commits survive recreated readers and stores beyond eight pages without lost sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neurobro-history-coupled-"));
  await chmod(directory, 0o700);
  const accountId = "7890123456", requesterId = "4560123456", chatId = "-10012345678";
  const fromDate = 1700000000, toDate = fromDate + 3 * 86400;
  const intent: StandingHistoryTaskIntent = {
    schema: "standing-history-task-v1", taskId: "htask_" + randomBytes(24).toString("hex"),
    accountId, chatId, requesterId, primaryMessageId: 999999,
    fromDate, toDate, timezone: "Europe/Moscow", objective: "Сделай выжимку за три дня",
  };
  const passphrase = "synthetic-history-task-passphrase";
  // Restart entrypoint knows only the protected parent and account binding.
  // The complete task intent must come from authenticated disk discovery.
  const reopenDiscovered = async () => {
    const discovery = await openStandingHistoryTaskDiscovery({ directory, passphrase, accountId, chatId });
    try {
      const page = await discovery.find();
      assert.equal(page.hasMore, false);
      assert.equal(page.coverage.complete, true);
      assert.equal(page.tasks.length, 1);
      const recovered = page.tasks[0]!;
      assert.deepEqual(recovered, intent);
      return await openStandingHistoryTaskStore({ directory, passphrase, intent: recovered, mode: "open" });
    } finally { await discovery.close(); }
  };
  const values = Array.from({ length: 1053 }, (_, i) => new Api.Message({
    id: 1000 + i, date: fromDate + Math.floor(i / 3) * 600,
    message: "Observed synthetic source " + i + " " + "x".repeat(750),
    peerId: new Api.PeerChannel({ channelId: bigInt(12345678) }),
    fromId: new Api.PeerUser({ userId: bigInt(i % 5 === 0 ? accountId : requesterId) }),
    ...(i % 5 === 0 ? { out: true } : {}),
    ...(i ? { replyTo: new Api.MessageReplyHeader({ replyToMsgId: 999 + i }) } : {}),
  }));
  const offsets: number[] = [];
  const openReader = () => {
    const references = createConversationReferences({ accountId, peerId: chatId });
    const reader = createSelfHistoryReader({
    binding: { accountId, peerId: chatId }, signal: new AbortController().signal,
    references,
    self: new Api.User({ id: bigInt(accountId), self: true }),
    peer: new Api.InputPeerChannel({ channelId: bigInt(12345678), accessHash: bigInt(987654321) }),
    client: { async invoke(request: Api.AnyRequest) {
      assert.ok(request instanceof Api.messages.GetHistory);
      assert.ok(request.getBytes().length > 0);
      offsets.push(request.offsetId);
      return new Api.messages.Messages({
        messages: values.filter(value => (!request.offsetId || value.id < request.offsetId) &&
          (!request.offsetDate || value.date < request.offsetDate)).sort((a, b) => b.id - a.id).slice(0, request.limit),
        users: [new Api.User({ id: bigInt(requesterId), firstName: "Участник" }),
          new Api.User({ id: bigInt(accountId), self: true })], chats: [],
      });
    } },
    });
    return { ...reader, close() { reader.close(); references.close(); } };
  };
  let store = await openStandingHistoryTaskStore({ directory, passphrase, intent, mode: "create" });
  let reader = openReader();
  let discardedUncommittedPage = false;
  const acceptedIds: number[] = [];
  try {
    for (let step = 0; step < 40; step++) {
      const before = await store.status();
      const result = await reader.readTaskPage({ fromDate, toDate, checkpoint: before.readProgress.checkpoint });
      if (step === 3 && !discardedUncommittedPage) {
        // A completed read without a page commit may be read again; it is not a
        // send or a model mutation. The saved frontier must remain unchanged.
        discardedUncommittedPage = true;
        reader.close(); await store.close();
        store = await reopenDiscovered();
        assert.deepEqual((await store.status()).readProgress, before.readProgress);
        reader = openReader();
        const repeated = await reader.readTaskPage({ fromDate, toDate, checkpoint: before.readProgress.checkpoint });
        assert.deepEqual(repeated.sources.map(source => source.messageId), result.sources.map(source => source.messageId));
        await store.appendPage({ expectedCheckpoint: before.readProgress.checkpoint, result: repeated });
        acceptedIds.push(...repeated.sources.map(source => source.messageId));
      } else {
        // Deliberately discard append's returned receipt, then discover the
        // committed page by reopening instead of assuming it was not written.
        await store.appendPage({ expectedCheckpoint: before.readProgress.checkpoint, result });
        acceptedIds.push(...result.sources.map(source => source.messageId));
      }
      reader.close(); await store.close();
      store = await reopenDiscovered();
      const after = await store.status();
      assert.equal(after.modelProgress, "not-recorded");
      assert.equal(after.readProgress.committedPages, before.readProgress.committedPages + 1);
      assert.deepEqual(after.readProgress.checkpoint, result.nextCheckpoint);
      reader = openReader();
      if (!result.page.hasMore) break;
    }
    const completed = await store.status();
    assert.ok(completed.readProgress.committedPages > 8);
    assert.equal(completed.readProgress.checkpoint.status, "empty-page");
    assert.equal(completed.readProgress.checkpoint.upperBoundMessageId, values.at(-1)!.id);
    assert.deepEqual([...acceptedIds].sort((a, b) => a - b), values.map(value => value.id));
    assert.equal(new Set(acceptedIds).size, values.length);
    assert.ok(offsets.some((offset, i) => i > 0 && offset === offsets[i - 1]), "uncommitted read reused saved frontier");
    const restored = new Map<number, string>();
    const projected = new Map<string, string>();
    const referenceKey = randomBytes(32).toString("hex");
    for (let index = 1; index <= completed.readProgress.committedPages; index++) {
      const stored = await store.readPage(index);
      assert.ok(stored);
      let position: string | undefined;
      let consumedRows = 0;
      const versions = new Map<string, string>();
      do {
        const fragment = projectStandingHistorySource({ intent, referenceKey, storedPage: stored,
          maxBytes: 8192, ...(position ? { position } : {}) });
        assert.ok(Buffer.byteLength(JSON.stringify(fragment)) <= 8192);
        assert.equal(fragment.range.fromRow, consumedRows);
        consumedRows = fragment.range.toRow;
        for (const row of fragment.rows) {
          if (row.disposition !== "included") continue;
          assert.ok("text" in row && typeof row.text === "string");
          assert.equal(projected.has(row.sourceRef), false);
          projected.set(row.sourceRef, row.text);
          versions.set(row.sourceRef, row.versionRef);
        }
        position = fragment.nextPosition ?? undefined;
      } while (position);
      assert.equal(consumedRows, stored.result.sources.length);
      // Context packing changes material spans, never logical message/version
      // identity. A larger budget must expose the same provenance.
      let largePosition: string | undefined;
      let largeCount = 0;
      do {
        const larger = projectStandingHistorySource({ intent, referenceKey, storedPage: stored,
          maxBytes: 49152, ...(largePosition ? { position: largePosition } : {}) });
        assert.ok(Buffer.byteLength(JSON.stringify(larger)) <= 49152);
        for (const row of larger.rows) {
          if (row.disposition !== "included") continue;
          assert.equal(versions.get(row.sourceRef), row.versionRef);
          largeCount++;
        }
        largePosition = larger.nextPosition ?? undefined;
      } while (largePosition);
      assert.equal(largeCount, versions.size);
      for (const source of stored.result.sources) {
        assert.equal(source.disposition, "included");
        const message: SelfHistoryMessage | undefined = stored.result.page.messages.find(row => row.ref === source.messageRef);
        assert.ok(message);
        const own = (source.messageId - 1000) % 5 === 0;
        assert.equal(source.authorId, own ? accountId : requesterId);
        assert.equal(message.author === "self", own);
        if (own) assert.equal(message.authorRef, "neurobro");
        assert.equal(message.date, source.date);
        restored.set(source.messageId, message.text);
      }
    }
    assert.equal(restored.size, values.length);
    assert.equal(projected.size, values.length);
    assert.deepEqual([...projected.values()].sort(), values.map(value => value.message).sort());
    for (const value of values) assert.equal(restored.get(value.id), value.message);
    const callsBeforeTerminalRead = offsets.length;
    await assert.rejects(reader.readTaskPage({ fromDate, toDate, checkpoint: completed.readProgress.checkpoint }));
    assert.equal(offsets.length, callsBeforeTerminalRead);
  } finally {
    reader.close(); await store.close();
    // Kept task-private synthetic evidence; no user data or live private state.
  }
});
