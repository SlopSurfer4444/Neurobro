import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConversationReferences } from "../src/conversation-references.js";
import { createEncryptedPilotStore, runPilotReply } from "../src/pilot-outbox.js";
import { wrapPilotStore } from "../src/standing-own-action-capture.js";
import { openStandingOwnActionCheckpoint } from "../src/standing-own-action-checkpoint.js";
import { openStandingOwnActionMemory } from "../src/standing-own-action-memory.js";
import { readStandingSharedContext } from "../src/standing-shared-context-reader.js";
import { conversationModelInput } from "../src/standing-model-input.js";

test("cold query recall lifts an older uncertain answer into the bounded model packet without changing its evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "neurobro-recall-"));
  const binding = { accountId: "100", peerId: "-200" }, passphrase = "synthetic recall checkpoint passphrase";
  const config = { directory: join(root, "cache"), binding, passphrase };
  const checkpoint = await openStandingOwnActionCheckpoint(config), signal = new AbortController().signal;
  const answer = "Метеорит Альтаир: результат отправки неизвестен.";
  try {
    for (let i = 1; i <= 12; i++) {
      const reply = { chatId: binding.peerId, replyToMessageId: i, text: i === 1 ? answer : `Разговор ${i}: ` + "другие события ".repeat(120) };
      const result = await runPilotReply({ approved: { accountId: binding.accountId, chatId: binding.peerId, replyToMessageId: i, maximumTextBytes: 4096 }, reply,
        signal, killSwitchEngaged: () => false,
        store: wrapPilotStore(createEncryptedPilotStore(join(root, "source-" + i), passphrase), reply, event => checkpoint.stage(event)),
        transport: { async sendOnce() { if (i === 1) throw Error("synthetic lost acknowledgement"); return { messageId: i + 100 }; },
          async readExact() { return { ...reply, accountId: binding.accountId, messageId: i + 100 }; } } });
      assert.equal(result.state, i === 1 ? "unknown" : "verified");
    }
    await checkpoint.flush();
  } finally { await checkpoint.close(); }
  const restored = await openStandingOwnActionCheckpoint(config), references = createConversationReferences(binding);
  const scopeRef = "scope_" + "a".repeat(32), asOf = 1700000000;
  const memory = await openStandingOwnActionMemory({ binding, passphrase, references, scopeRef, signal });
  try {
    for (const event of restored.read()) memory.observe(event);
    const primary = { chatId: binding.peerId, ownerId: "300", messageId: 200, text: "ПРОМПТ напомни про метеорит Альтаир" };
    const unrelated = { ...primary, text: "ПРОМПТ что сейчас?" };
    const before = memory.forPrimary({ primary: unrelated, asOf }).source.items;
    assert.ok(!before.some(item => item.content.kind === "text" && item.content.text === answer));
    const ownActionContext = memory.forPrimary({ primary, asOf });
    assert.equal(ownActionContext.source.items.length, 8);
    const remembered = ownActionContext.source.items[0]!;
    assert.equal(remembered.content.kind === "text" && remembered.content.text, answer);
    assert.equal(remembered.verdict, "unknown"); assert.equal(remembered.currentAvailability, "not-checked");
    const shared = readStandingSharedContext({ binding, primary, references, scopeRef, asOf, signal, ownActionContext });
    assert.ok(Buffer.byteLength(JSON.stringify(shared.snapshot)) <= 8192);
    assert.ok(shared.snapshot.coverage.ownActions.omittedByBudget > 0, "crowded evidence genuinely exercises byte-budget omission");
    const packet = conversationModelInput(primary, undefined, references, undefined, undefined, shared);
    assert.ok(Buffer.byteLength(packet) <= 24576);
    const parsed = JSON.parse(packet), evidence = parsed.contextState.shared.snapshot.items.find((item: any) => item.evidence.actionRef === remembered.actionRef)?.evidence;
    assert.deepEqual(evidence, remembered);
    assert.equal(parsed.contextState.shared.snapshot.completeChat, false);
    assert.equal(parsed.contextState.shared.snapshot.initiativeEligibility, "not-evaluated");
    assert.deepEqual(memory.forPrimary({ primary: unrelated, asOf }).source.items, before);
  } finally { memory.close(); references.close(); await restored.close(); }
});
