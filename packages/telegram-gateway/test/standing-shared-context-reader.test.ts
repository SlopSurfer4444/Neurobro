import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationReferences } from "../src/conversation-references.js";
import type { StandingContext, StandingContextMessage } from "../src/standing-context.js";
import { readStandingContextRestoration } from "../src/standing-context-restoration.js";
import { openStandingDialogueJournal, type JournalDialogue } from "../src/standing-dialogue-journal.js";
import { readStandingSharedContext, type StandingSharedContextReaderInput } from "../src/standing-shared-context-reader.js";
import { requireBoundStandingSharedContext } from "../src/standing-shared-context-binding.js";
import type { StandingSharedDialogue, StandingSharedObservation } from "../src/standing-shared-context.js";

const binding = { peerId: "-100123", accountId: "789" };
const primary = { chatId: binding.peerId, ownerId: "456", messageId: 200, text: "ПРОМПТ помнишь?" };
const scopeRef = "scope_" + "a".repeat(32), asOf = 1700000200;
function message(id: number, text = "Message " + id, self = false): StandingContextMessage {
  return { chatId: binding.peerId, messageId: id, authorId: self ? binding.accountId : primary.ownerId, author: self ? "self" : "user",
    displayName: self ? "Neurobro" : "Participant", date: 1700000000 + id, replyToMessageId: null, text };
}
function context(): StandingContext {
  return { version: "standing-context-v1", primary: message(primary.messageId, primary.text), replyChain: [],
    recent: [message(100), message(101, "Own observed message", true)], chainStatus: "complete", recentStatus: "complete" };
}
function fixture() {
  const references = createConversationReferences(binding), controller = new AbortController();
  const input: StandingSharedContextReaderInput = { binding, primary, references, signal: controller.signal, scopeRef, asOf, context: context() };
  return { input, references, controller };
}
function row(id: number): JournalDialogue {
  const key = String(id).padStart(10, "0");
  return { key, question: { primary: { ...primary, messageId: id, text: "Message " + id }, source: { date: 1700000000 + id, displayName: "Participant" } },
    recordedAt: 1700000100 + id, modelAdmission: null, status: "verified",
    outcome: { key, kind: "model", delivery: "verified", answer: "Verified answer " + id } };
}
test("actual selected context issues requester-bound snapshot without changing source or creating fake message slots", () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.input.context), bound = readStandingSharedContext(f.input), result = bound.snapshot;
    assert.equal(requireBoundStandingSharedContext(bound, primary, f.references), result);
    assert.equal(JSON.stringify(f.input.context), before);
    assert.equal(result.items.length, 2);
    assert.equal(result.scope.audience.kind, "requester");
    assert.equal(result.completeChat, false);
    assert.equal(result.coverage.ownActions.availability, "not-configured");
    assert.equal(result.coverage.tasks.availability, "not-configured");
    assert.equal(result.coverage.dialogues.availability, "not-configured");
    assert.ok(result.items.every(item => item.evidence.kind === "observed-message"));
    assert.ok(!JSON.stringify(result).includes(primary.text));
    assert.ok(!JSON.stringify(result).includes(binding.peerId));
    for (const item of result.items) assert.equal(f.references.resolveMessage((item.evidence as StandingSharedObservation).sourceRef), undefined);
    assert.equal(f.references.resolveMessage(f.references.message(100)), 100);
    assert.equal((result.items[0]!.evidence as StandingSharedObservation).speakerRef, "neurobro");
    assert.deepEqual(readStandingSharedContext(f.input).snapshot, result);
  } finally { f.references.close(); }
});
test("actual owned restoration preserves seconds and deduplicates the matching question", async () => {
  const f = fixture(); let reads = 0;
  try {
    const restoration = await readStandingContextRestoration({ ...f.input, journal: { async read() { reads++; return { dialogues: [row(100)], scanned: 1, hasOlder: false }; } } });
    const bound = readStandingSharedContext({ ...f.input, restoration });
    assert.equal(reads, 1);
    assert.equal(bound.snapshot.items.length, 2);
    assert.equal(bound.snapshot.coverage.dialogues.included, 1);
    assert.equal(bound.snapshot.coverage.chronicle.included, 1);
    const pair = bound.snapshot.items.find(item => item.source === "dialogues")!.evidence as StandingSharedDialogue;
    assert.equal(pair.observedAt, row(100).recordedAt);
    assert.equal(pair.answer.text, "Verified answer 100");
    assert.equal(JSON.stringify(bound.snapshot).split("Message 100").length - 1, 1);
    assert.throws(() => readStandingSharedContext({ ...f.input, restoration: { ...restoration } }));
    assert.equal(reads, 1);
  } finally { f.references.close(); }
});
test("real encrypted journal producer seconds survive reopen and future timestamps refuse", async () => {
  const f = fixture(), directory = join(await mkdtemp(join(tmpdir(), "neurobro-shared-reader-")), "journal");
  const configuration = { directory, passphrase: "invented shared context reader passphrase", binding };
  const writer = await openStandingDialogueJournal(configuration);
  const claim = await writer.recordQuestion(row(100).question);
  await writer.recordOutcome({ key: claim.key, delivery: "verified", kind: "model", answer: "Actual journal answer" });
  writer.close();
  const reader = await openStandingDialogueJournal({ ...configuration, readOnly: true });
  try {
    const restoration = await readStandingContextRestoration({ ...f.input, journal: reader });
    const producedSeconds = restoration.dialogues[0]!.recordedAt;
    assert.ok(producedSeconds > 1700000000 && producedSeconds < 10000000000);
    const result = readStandingSharedContext({ ...f.input, asOf: Math.floor(Date.now() / 1000) + 1, restoration }).snapshot;
    const pair = result.items.find(item => item.source === "dialogues")!.evidence as StandingSharedDialogue;
    assert.equal(pair.observedAt, producedSeconds);
    assert.throws(() => readStandingSharedContext({ ...f.input, asOf: producedSeconds - 1, restoration }));
  } finally { reader.close(); f.references.close(); }
});
test("edited current source supersedes conflicting old pair with explicit stale and omission coverage", async () => {
  const f = fixture();
  try {
    const restoration = await readStandingContextRestoration({ ...f.input, journal: { async read() { return { dialogues: [row(100)], scanned: 1, hasOlder: false }; } } });
    const changed = { ...context(), recent: [message(100, "Edited question")] };
    const result = readStandingSharedContext({ ...f.input, context: changed, restoration }).snapshot;
    assert.equal(result.coverage.dialogues.included, 0);
    assert.equal(result.coverage.dialogues.omittedAtSource, 1);
    assert.equal(result.coverage.dialogues.freshness, "stale");
    assert.equal((result.items[0]!.evidence as StandingSharedObservation).text, "Edited question");
    assert.equal(result.initiativeEligibility, "not-evaluated");
  } finally { f.references.close(); }
});
test("matching chain/recent duplicates appear once; changed same-ID duplicates refuse", () => {
  const f = fixture();
  try {
    const c = { ...context(), replyChain: [message(100)], recent: [message(100), message(101)] };
    const result = readStandingSharedContext({ ...f.input, context: c }).snapshot;
    assert.equal(result.coverage.chronicle.scanned, 3);
    assert.equal(result.coverage.chronicle.included, 2);
    assert.throws(() => readStandingSharedContext({ ...f.input, context: { ...c, recent: [message(100, "Contradiction")] } }));
  } finally { f.references.close(); }
});
test("version binds content and metadata, while logical source and original reference slots remain stable", () => {
  const f = fixture();
  try {
    const read = (m: StandingContextMessage) => readStandingSharedContext({ ...f.input, context: { ...context(), recent: [m] } }).snapshot.items[0]!.evidence as StandingSharedObservation;
    const initial = read(message(100)), edited = read(message(100, "Edited")), renamed = read({ ...message(100), displayName: "New display name" });
    assert.equal(initial.sourceRef, edited.sourceRef);
    assert.equal(initial.sourceRef, renamed.sourceRef);
    assert.notEqual(initial.versionRef, edited.versionRef);
    assert.notEqual(initial.versionRef, renamed.versionRef);
    assert.equal(f.references.resolveMessage(f.references.message(100)), 100);
  } finally { f.references.close(); }
});
test("current primary, binding, own-author consistency, future IDs and revoked capabilities are exact", () => {
  const f = fixture();
  try {
    for (const bad of [
      { ...f.input, primary: { ...primary, text: "Different" } },
      { ...f.input, binding: { ...binding, peerId: "-222" } },
      { ...f.input, context: { ...context(), recent: [message(201)] } },
      { ...f.input, context: { ...context(), recent: [{ ...message(100), author: "self" as const }] } },
      { ...f.input, context: { ...context(), recent: [{ ...message(100), chatId: "-222" }] } },
    ]) assert.throws(() => readStandingSharedContext(bad));
    const bound = readStandingSharedContext(f.input);
    f.controller.abort();
    assert.throws(() => readStandingSharedContext(f.input));
    assert.throws(() => requireBoundStandingSharedContext(bound, primary, f.references));
  } finally { f.references.close(); }
  const second = fixture(); second.references.close(); assert.throws(() => readStandingSharedContext(second.input));
});
test("absent or incomplete selected data reports unknown coverage without preferences or own action claims", async () => {
  const f = fixture();
  try {
    const { context: _unused, ...withoutContext } = f.input;
    const absent = readStandingSharedContext(withoutContext).snapshot;
    assert.equal(absent.coverage.chronicle.availability, "unavailable");
    assert.equal(absent.coverage.chronicle.hasMore, null);
    const restoration = await readStandingContextRestoration({ ...f.input, journal: { async read() { throw Error("synthetic unavailable read"); } } });
    const partial = readStandingSharedContext({ ...f.input, context: { ...context(), chainStatus: "missing", recentStatus: "truncated" }, restoration }).snapshot;
    assert.equal(partial.coverage.chronicle.omittedAtSource, null);
    assert.equal(partial.coverage.chronicle.hasMore, null);
    assert.equal(partial.coverage.dialogues.availability, "unavailable");
    assert.ok(partial.items.every(item => item.evidence.kind !== "explicit-preference"));
  } finally { f.references.close(); }
});
test("bounded maximum selected context plus eight restored pairs reports pre-budget omissions", async () => {
  const f = fixture();
  try {
    const restoration = await readStandingContextRestoration({ ...f.input, journal: { async read() { return { dialogues: Array.from({ length: 8 }, (_, i) => row(i + 1)), scanned: 8, hasOlder: true }; } } });
    const result = readStandingSharedContext({ ...f.input, restoration, context: { ...context(),
      replyChain: Array.from({ length: 8 }, (_, i) => message(190 - i)), recent: Array.from({ length: 20 }, (_, i) => message(100 + i)) } }).snapshot;
    assert.equal(result.coverage.chronicle.provided, 24);
    assert.equal(result.coverage.chronicle.omittedAtSource, 4);
    assert.equal(result.coverage.dialogues.provided, 8);
    assert.equal(result.coverage.dialogues.hasMore, true);
    assert.ok(result.items.length <= 16);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  } finally { f.references.close(); }
});
test("hostile nested getters, proxies and unknown context fields do not execute", () => {
  const f = fixture(); let calls = 0;
  try {
    const bad = { ...message(100) };
    Object.defineProperty(bad, "text", { enumerable: true, get() { calls++; return "bad"; } });
    assert.throws(() => readStandingSharedContext({ ...f.input, context: { ...context(), recent: [bad] } }));
    const proxy = new Proxy(context(), { get() { calls++; throw Error("not allowed"); } });
    assert.throws(() => readStandingSharedContext({ ...f.input, context: proxy }));
    assert.throws(() => readStandingSharedContext({ ...f.input, context: { ...context(), hidden: "secret" } as StandingContext }));
    assert.equal(calls, 0);
  } finally { f.references.close(); }
});
