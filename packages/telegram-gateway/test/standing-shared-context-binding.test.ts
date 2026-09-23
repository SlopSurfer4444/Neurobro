import test from "node:test";
import assert from "node:assert/strict";
import { createConversationReferences } from "../src/conversation-references.js";
import { projectStandingSharedContext, type StandingSharedContextInput } from "../src/standing-shared-context.js";
import { bindStandingSharedContext, requireBoundStandingSharedContext } from "../src/standing-shared-context-binding.js";
import { conversationModelInput, CONVERSATION_INPUT_BYTES } from "../src/standing-model-input.js";
import { readStandingContextRestoration } from "../src/standing-context-restoration.js";

const binding = { accountId: "999", peerId: "-100123" };
const primary = { chatId: binding.peerId, ownerId: "123", messageId: 100, text: "ПРОМПТ помнишь?" };
const scopeRef = "scope_" + "a".repeat(32);
function input(requesterRef?: string): StandingSharedContextInput {
  const absent = () => ({ items: [], coverage: { availability: "not-configured" as const,
    freshness: "unknown" as const, scanned: 0, hasMore: null, omittedAtSource: null } });
  return { scope: { scopeRef, audience: requesterRef ? { kind: "requester", requesterRef } : { kind: "group" } },
    asOf: 1700000000, chronicle: absent(), dialogues: absent(), ownActions: absent(), tasks: absent() };
}

test("same composed snapshot reaches model input without changing current question or claiming full memory", () => {
  const references = createConversationReferences(binding), controller = new AbortController();
  try {
    const snapshot = projectStandingSharedContext(input(references.speaker(primary.ownerId)));
    const bound = bindStandingSharedContext({ snapshot, scopeRef, binding, primary, references, signal: controller.signal });
    const raw = conversationModelInput(primary, undefined, references, undefined, undefined, bound);
    const packet = JSON.parse(raw);
    assert.deepEqual(packet.contextState.shared, { status: "included", snapshot });
    assert.equal(packet.currentRequest.text, "помнишь?");
    assert.equal(packet.contextState.shared.snapshot.completeChat, false);
    assert.equal(packet.contextState.shared.snapshot.initiativeEligibility, "not-evaluated");
    assert.ok(Buffer.byteLength(raw) <= CONVERSATION_INPUT_BYTES);
    assert.ok(!raw.includes(binding.peerId));
    assert.equal(requireBoundStandingSharedContext(bound, primary, references), snapshot);
    assert.throws(() => requireBoundStandingSharedContext({ ...bound }, primary, references));
    assert.throws(() => conversationModelInput({ ...primary, ownerId: "124" }, undefined, references, undefined, undefined, bound));
    assert.throws(() => conversationModelInput({ ...primary, messageId: 101 }, undefined, references, undefined, undefined, bound));
    assert.throws(() => conversationModelInput({ ...primary, text: "другой запрос" }, undefined, references, undefined, undefined, bound));
    controller.abort();
    assert.throws(() => conversationModelInput(primary, undefined, references, undefined, undefined, bound));
  } finally { references.close(); }
});

test("wrong audience, binding, composed-object substitution and closed reference lifetime refuse", () => {
  const references = createConversationReferences(binding), other = createConversationReferences(binding);
  const controller = new AbortController();
  try {
    const common = { scopeRef, binding, primary, references, signal: controller.signal };
    assert.throws(() => bindStandingSharedContext({ ...common,
      snapshot: projectStandingSharedContext(input(references.speaker("124"))) }));
    const snapshot = projectStandingSharedContext(input());
    assert.throws(() => bindStandingSharedContext({ ...common, snapshot, scopeRef: "scope_" + "b".repeat(32) }));
    assert.throws(() => bindStandingSharedContext({ ...common, snapshot: structuredClone(snapshot) }));
    assert.throws(() => bindStandingSharedContext({ ...common, snapshot, binding: { ...binding, peerId: "-200" } }));
    const bound = bindStandingSharedContext({ ...common, snapshot });
    assert.throws(() => requireBoundStandingSharedContext(bound, primary, other));
    references.close();
    assert.throws(() => requireBoundStandingSharedContext(bound, primary, references));
  } finally { references.close(); other.close(); }
});

test("whole shared evidence and current request survive escape-heavy unrelated traffic within original budget", async () => {
  const references = createConversationReferences(binding);
  try {
    const snapshotInput = input();
    const snapshot = projectStandingSharedContext({ ...snapshotInput, chronicle: {
      items: [{ kind: "observed-message", sourceRef: "src_" + "c".repeat(32), versionRef: "ver_" + "d".repeat(32),
        observedAt: 1700000000, speakerRef: references.speaker("124"), text: "важный контекст ".repeat(100) }],
      coverage: { availability: "available", freshness: "current", scanned: 1, hasMore: true, omittedAtSource: 0 } } });
    const bound = bindStandingSharedContext({ snapshot, scopeRef, binding, primary, references, signal: new AbortController().signal });
    const message = (messageId: number, text: string) => ({ chatId: binding.peerId, messageId, authorId: primary.ownerId,
      author: "user" as const, displayName: "Участник", date: 1699999900 + messageId, replyToMessageId: null, text });
    const context = { version: "standing-context-v1" as const, primary: message(100, primary.text), replyChain: [],
      recent: Array.from({ length: 20 }, (_, i) => message(20 + i, '"\\\n'.repeat(1000))),
      chainStatus: "complete" as const, recentStatus: "complete" as const };
    const raw = conversationModelInput(primary, context, references, undefined, undefined, bound), packet = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= CONVERSATION_INPUT_BYTES);
    assert.deepEqual(packet.contextState.shared.snapshot, snapshot);
    assert.ok(packet.contextState.omittedMessages > 0 || packet.contextState.shortenedMessages > 0);
    const crowdedChain = { ...context, recent: [], replyChain: Array.from({ length: 8 }, (_, i) =>
      message(90 - i, "\u0001".repeat(3600))) };
    const baseline = JSON.parse(conversationModelInput(primary, crowdedChain, references, undefined, undefined, undefined, "bounded-checkpoint"));
    const withSharedRaw = conversationModelInput(primary, crowdedChain, references, undefined, undefined, bound, "bounded-checkpoint");
    const withShared = JSON.parse(withSharedRaw);
    assert.deepEqual(withShared.replyChain, baseline.replyChain, "background memory must not evict directly replied-to context");
    assert.equal(withShared.replyChain.length, baseline.replyChain.length);
    assert.deepEqual(withShared.contextState.shared, { status: "omitted", reason: "input-budget" });
    assert.equal(withShared.contextState.memory.ownActionRecovery, "bounded-checkpoint", "available recovery does not imply included memory");
    assert.equal(withShared.contextState.memory.itemOrder, "source-and-query-priority");
    assert.ok(Buffer.byteLength(withSharedRaw) <= CONVERSATION_INPUT_BYTES);
    const restoration = await readStandingContextRestoration({ binding, primary, references,
      signal: new AbortController().signal,
      journal: { read: async () => ({ dialogues: [], scanned: 0, hasOlder: false }) } });
    const bothRaw = conversationModelInput(primary, crowdedChain, references, restoration, undefined, bound, "bounded-checkpoint");
    const both = JSON.parse(bothRaw);
    assert.ok(Buffer.byteLength(bothRaw) <= CONVERSATION_INPUT_BYTES);
    assert.deepEqual(both.replyChain, withShared.replyChain);
    assert.equal(both.contextState.restoration.scanned, 0);
    assert.deepEqual(both.contextState.shared, { status: "omitted", reason: "input-budget" });
  } finally { references.close(); }
});
