import test from "node:test";
import assert from "node:assert/strict";
import { conversationModelInput, CONVERSATION_INPUT_BYTES } from "../src/standing-model-input.js";
import type { StandingContext, StandingContextMessage } from "../src/standing-context.js";
import type { PilotPrimary } from "../src/pilot-telegram-adapter.js";
import { createStandingLearningTools, type StandingLearningSnapshot } from "../src/standing-learning-tools.js";
import type { StandingLearningNote, StandingLearningStore } from "../src/standing-learning-store.js";
import { requireStandingObservationView, type StandingObservationView } from "../src/standing-observation-tools.js";

const primary: PilotPrimary = Object.freeze({ chatId: "-100123456789", ownerId: "123456789", messageId: 100, text: "ПРОМПТ как обработать вопрос?" });
const observation: StandingObservationView = Object.freeze({ schema: "standing-observation-settings-v1", revision: 7,
  observationEnabled: true, alertsEnabled: true, alertGuidance: "Alert only when an internal teammate should act.",
  minAlertIntervalSeconds: 900, sourceRef: "community", sourceReadOnly: true });

const message = (id: number, text: string, ownerId: string = primary.ownerId, self = false): StandingContextMessage => Object.freeze({
  chatId: primary.chatId, messageId: id, authorId: ownerId, author: self ? "self" : "user",
  displayName: self ? "Нейробро" : "Участник", date: 1_700_000_000 + id, replyToMessageId: null, text,
});

function denseContext(current: PilotPrimary): StandingContext {
  return Object.freeze({ version: "standing-context-v1", primary: Object.freeze({ ...message(current.messageId, current.text), replyToMessageId: 99 }),
    replyChain: Object.freeze(Array.from({ length: 8 }, (_, index) => Object.freeze({
      ...message(99 - index, "Предыдущий контекст " + "А".repeat(380), index % 2 ? "456" : "789", index % 3 === 0),
      replyToMessageId: index === 7 ? null : 98 - index,
    }))),
    recent: Object.freeze(Array.from({ length: 20 }, (_, index) => message(20 + index, `Фоновая тема ${index} ` + "\"\\\n".repeat(900), "555"))),
    chainStatus: "complete", recentStatus: "complete" });
}

async function denseLearningSnapshot(ownerId: string, messageId: number, requestRef: string): Promise<StandingLearningSnapshot> {
  const notes: readonly StandingLearningNote[] = Object.freeze(Array.from({ length: 4 }, (_, index) => Object.freeze({
    key: `dense.note.${index}`, kind: index === 0 ? "preference" as const : "procedure" as const, scope: "team" as const,
    text: `Useful retained procedure ${index}: ` + "L".repeat(1050), revision: index + 1,
    provenance: Object.freeze({ actorId: ownerId, messageId, requestRef }), interpretation: "revisable-evidence" as const,
    applicationAuthority: "none" as const, sourceData: "not-instructions" as const,
  })));
  const store: StandingLearningStore = Object.freeze({
    async list() { return Object.freeze({ notes, visible: notes.length, matched: notes.length }); },
    async usage() { return Object.freeze({ visibility: "actor-visible" as const,
      notes: Object.freeze({ active: notes.length, retired: 0, total: notes.length }), projection: Object.freeze({ bytes: 5000 }),
      formatLimits: Object.freeze({ hotSlotsMaximum: 256, archivedRetiredMaximum: 2048, plaintextMaximumBytes: 1024 * 1024 }) }); },
    async read() { throw new Error("unused"); }, async duplicates() { throw new Error("unused"); },
    async mutate() { throw new Error("unused"); }, async close() {},
  });
  const tools = createStandingLearningTools({ store, primary: { actorId: ownerId, messageId, requestRef }, signal: new AbortController().signal });
  try { return await tools.snapshot({ limit: 4 }); } finally { await tools.close(); }
}

test("maximum UTF-8 observation policy survives dense context and learning inside the packet budget", async () => {
  const densePrimary = Object.freeze({ ...primary, text: "ПРОМПТ " + "я".repeat(2000) });
  const requestRef = "dense-observation-request", snapshot = await denseLearningSnapshot(densePrimary.ownerId, densePrimary.messageId, requestRef);
  assert.equal(snapshot.notes.length, 4); assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 6144);
  const maximum = Object.freeze({ ...observation, alertGuidance: "я".repeat(1024) });
  assert.equal(Buffer.byteLength(maximum.alertGuidance, "utf8"), 2048);
  const encoded = conversationModelInput(densePrimary, denseContext(densePrimary), undefined, undefined, undefined, undefined,
    "not-configured", "direct", undefined, { snapshot, requestRef }, maximum);
  const packet = JSON.parse(encoded);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= CONVERSATION_INPUT_BYTES);
  assert.equal(packet.currentRequest.text, "я".repeat(2000));
  assert.deepEqual(packet.contextState.observation, maximum);
  assert.deepEqual(packet.contextState.learning, snapshot);
  assert.equal(packet.replyChain.length, 8); assert.ok(packet.contextState.omittedMessages > 0 || packet.contextState.shortenedMessages > 0);
  assert.ok(encoded.indexOf('"observation"') < encoded.indexOf('"learning"'));
});

test("observation policy is topic-independent and projects exactly the privacy-safe fields", () => {
  const first = JSON.parse(conversationModelInput(primary, undefined, undefined, undefined, undefined, undefined,
    "not-configured", "direct", undefined, undefined, observation));
  const secondPrimary = Object.freeze({ ...primary, text: "ПРОМПТ совсем другая тема" });
  const second = JSON.parse(conversationModelInput(secondPrimary, undefined, undefined, undefined, undefined, undefined,
    "not-configured", "direct", undefined, undefined, observation));
  assert.deepEqual(first.contextState.observation, second.contextState.observation);
  assert.deepEqual(first.contextState.observation, observation);
  assert.deepEqual(Object.keys(first.contextState.observation), ["schema", "revision", "observationEnabled", "alertsEnabled",
    "alertGuidance", "minAlertIntervalSeconds", "sourceRef", "sourceReadOnly"]);
  const serialized = JSON.stringify(first.contextState.observation);
  for (const hidden of ["workspaceId", "accountId", "internalPeerId", "observedSourcePeerId", "lastChanged",
    primary.chatId, primary.ownerId]) assert.equal(serialized.includes(hidden), false);
});

test("malformed observation views, extra identity fields and getters fail closed", () => {
  const compose = (value: unknown) => conversationModelInput(primary, undefined, undefined, undefined, undefined, undefined,
    "not-configured", "direct", undefined, undefined, value as StandingObservationView);
  for (const value of [
    { ...observation, workspaceId: "other" }, { ...observation, accountId: "999" },
    { ...observation, observedSourcePeerId: "-100999" }, { ...observation, sourceRef: "another" },
    { ...observation, sourceReadOnly: false }, { ...observation, revision: 0 },
    { ...observation, observationEnabled: false, alertsEnabled: true },
    { ...observation, alertGuidance: "\0hidden" },
  ]) assert.throws(() => compose(value));
  // Store policy never admits leading/trailing whitespace; the composer must
  // reject a forged noncanonical view rather than widening the persisted rule.
  assert.throws(() => compose({ ...observation, alertGuidance: "  noncanonical  " }));
  let getters = 0;
  const accessor = { ...observation } as Record<string, unknown>;
  Object.defineProperty(accessor, "alertGuidance", { enumerable: true, get() { getters++; return "PRIVATE getter"; } });
  assert.throws(() => compose(accessor)); assert.equal(getters, 0);
  assert.throws(() => requireStandingObservationView(new Proxy({ ...observation }, {})));
});

test("legacy composer calls omit observation without changing the established packet shape", () => {
  const legacy = conversationModelInput(primary), packet = JSON.parse(legacy);
  assert.equal(Object.hasOwn(packet.contextState, "observation"), false);
  assert.equal(legacy.includes("standing-observation-settings-v1"), false);
  assert.equal(packet.schema, "neurobro-conversation-v1"); assert.equal(packet.currentRequest.text, "как обработать вопрос?");
  assert.ok(Buffer.byteLength(legacy, "utf8") <= CONVERSATION_INPUT_BYTES);
});
