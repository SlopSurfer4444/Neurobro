import test from "node:test";
import assert from "node:assert/strict";
import { createConversationReferences } from "../src/conversation-references.js";
import { readStandingHistoryTaskContext } from "../src/standing-history-task-context.js";
import { readStandingSharedContext } from "../src/standing-shared-context-reader.js";
import { conversationModelInput } from "../src/standing-model-input.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";

test("owned task page reaches model with purpose and unknown progress; another actor or timestamp cannot reuse it", async () => {
  const binding = { accountId: "999", peerId: "-100123" };
  const primary = { chatId: binding.peerId, ownerId: "123", messageId: 200, text: "ПРОМПТ ну что там с выжимкой?" };
  const references = createConversationReferences(binding), controller = new AbortController();
  const scopeRef = "scope_" + "a".repeat(32), asOf = 1700000200;
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "b".repeat(48),
    accountId: binding.accountId, chatId: binding.peerId, requesterId: primary.ownerId, primaryMessageId: 100,
    fromDate: 1699700000, toDate: 1700000000, timezone: "Europe/Moscow", objective: "Выжимка решений за три дня" };
  let reads = 0;
  const input = { binding, primary, references, scopeRef, asOf, signal: controller.signal };
  try {
    const taskContext = await readStandingHistoryTaskContext({ ...input,
      discovery: { async find() { return { tasks: [intent], hasMore: false,
        coverage: { complete: true, scanned: 1, unavailable: 0, foreign: 0, root: "present" as const } }; } },
      manager: { async status(value) { reads++; assert.equal(value.requesterId, primary.ownerId); throw new Error("synthetic unavailable store"); } } });
    const bound = readStandingSharedContext({ ...input, taskContext });
    const packet = JSON.parse(conversationModelInput(primary, undefined, references, undefined, undefined, bound));
    const task = packet.contextState.shared.snapshot.items.find((item: any) => item.source === "tasks").evidence;
    assert.equal(task.taskRef, intent.taskId);
    assert.deepEqual(task.description, { objective: intent.objective, fromDate: intent.fromDate, toDate: intent.toDate, timezone: intent.timezone });
    assert.equal(task.outputPrepared, "unavailable");
    assert.equal(task.nodeCommitted, "unavailable");
    assert.equal(task.delivery, "unavailable");
    assert.equal(reads, 1, "packing an already-read page performs no additional status read");
    assert.throws(() => readStandingSharedContext({ ...input, taskContext, primary: { ...primary, ownerId: "124" } }));
    assert.throws(() => readStandingSharedContext({ ...input, taskContext, asOf: asOf + 1 }));
    assert.throws(() => readStandingSharedContext({ ...input, taskContext, scopeRef: "scope_" + "c".repeat(32) }));
    assert.throws(() => readStandingSharedContext({ ...input, taskContext: structuredClone(taskContext) }));
    controller.abort();
    assert.throws(() => readStandingSharedContext({ ...input, taskContext }));
  } finally { references.close(); }
});
