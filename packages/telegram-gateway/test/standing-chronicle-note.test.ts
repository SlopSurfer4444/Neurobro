import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectStandingChronicleNote, requireStandingChronicleNote } from "../src/standing-chronicle-note.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { readNodeNotes } from "../src/standing-history-analysis-view.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { readStandingSharedContext } from "../src/standing-shared-context-reader.js";
import { projectStandingSharedContext, STANDING_SHARED_CONTEXT_MAX_BYTES, type StandingSharedContextInput } from "../src/standing-shared-context.js";
import { conversationModelInput, CONVERSATION_INPUT_BYTES } from "../src/standing-model-input.js";
import type { StandingContext, StandingContextMessage } from "../src/standing-context.js";

async function fixture(t: TestContext, summary = "Model summary of synthetic source", claimText = "Model-authored decision", claimCount = 1) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-chronicle-note-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-chronicle-note-"))); await rm(root, { recursive: true, force: true }); });
  const pages = join(root, "pages"), directory = join(root, "analysis"); await mkdir(pages); await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "7".repeat(48), accountId: "123", chatId: "-100456", requesterId: "456", primaryMessageId: 789,
    fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Private objective must not be projected" };
  const passphrase = "synthetic-chronicle-note-passphrase", binding = { intent, passphrase };
  const source = await openStandingHistoryTaskStore({ ...binding, directory: pages, mode: "create" });
  const before = (await source.status()).readProgress.checkpoint;
  const after = { ...before, offsetId: 788, lastDate: 150, oldestDate: 150, newestDate: 150, upperBoundMessageId: 788, pages: 1, status: "lower-bound-reached" as const };
  const ref = "m_" + "1".repeat(24);
  await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: after,
    sources: [{ messageId: 788, date: 150, disposition: "included", messageRef: ref, authorId: "456" }], page: {
      schema: "neurobro-self-history-v1", fromDate: 100, toDate: 200,
      messages: [{ ref, authorRef: "a_" + "2".repeat(24), author: "user", displayName: "Private speaker", date: 150, editedAt: null, replyRef: null, replyUnavailable: false, text: "Private original message" }],
      cursor: null, hasMore: false, status: "lower-bound-reached", coverage: { scope: "available-history-snapshot", oldestExaminedDate: 150, newestExaminedDate: 150, traversalComplete: true, undatedEntries: 0, pages: 1 },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"]
    } } });
  const args = { ...binding, directory, readSourcePage: (index: number) => source.readPage(index) };
  const analysis = await openStandingHistoryAnalysisStore({ ...args, mode: "create" });
  const referenceKey = analysis.referenceKey(), material = projectStandingHistorySource({ intent, referenceKey, storedPage: (await source.readPage(1))! });
  const supports = [{ sourceRef: material.rows[0]!.sourceRef, versionRef: material.rows[0]!.versionRef }];
  const saved = await analysis.appendLeaf({ expectedHead: (await analysis.status()).headHash, inputs: [{ pageIndex: 1, materialRef: material.materialRef, maxBytes: 49152 }],
    output: { summary, claims: Array.from({ length: claimCount }, () => ({ kind: "decision" as const, text: claimText, supports })), omittedDetailCount: 7 } });
  await analysis.close();
  const reopened = await openStandingHistoryAnalysisStore({ ...args, mode: "open" });
  const node = (await reopened.readNode(saved.nodeRef))!; assert.deepEqual(node, saved);
  const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis: reopened });
  try {
    for (let step = 0; step < 10; step++) {
      const readiness = await planner.next();
      if (readiness.kind === "scan-more") continue;
      assert.equal(readiness.kind, "analysis-ready"); if (readiness.kind !== "analysis-ready") throw Error("fixture not ready");
      return { intent, readiness, node, referenceKey, supports, owner: { accountId: intent.accountId, peerId: intent.chatId, requesterId: intent.requesterId } };
    }
    throw Error("fixture planner failed to finish");
  } finally { await planner.close(); await reopened.close(); await source.close(); }
}
function frozen(value: unknown): void {
  if (value && typeof value === "object") { assert.ok(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child); }
}

test("actual reopened analysis produces bounded unverified notes with exact support and omission provenance", async t => {
  const f = await fixture(t), note = projectStandingChronicleNote({ intent: f.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey });
  const expected = readNodeNotes({ node: f.node, referenceKey: f.referenceKey, maxBytes: 4096 });
  const { nextPosition, ...notes } = expected;
  assert.equal(note.kind, "model-analysis-notes"); assert.match(note.sourceRef, /^chron_[0-9a-f]{48}$/); assert.match(note.versionRef, /^chver_[0-9a-f]{48}$/);
  assert.equal(note.observedAt, null); assert.equal(note.taskRef, f.intent.taskId);
  assert.deepEqual(note.period, { fromDate: 100, toDate: 200, timezone: "Europe/Moscow" });
  assert.deepEqual(note.notes, notes); assert.equal(note.hasMoreNotes, nextPosition !== null);
  assert.equal(note.notes.claimsStatus, "model-authored-unverified"); assert.equal(note.notes.supportScope, "immediate-node-claims-only");
  assert.deepEqual(note.notes.claims[0]!.supports, f.supports); assert.equal(note.notes.modelAuthoredOmittedDetailCount, 7);
  assert.deepEqual(note.sourceCoverage, f.readiness.coverage); assert.deepEqual(note.sourceGaps, f.readiness.gaps); frozen(note);
  assert.ok(Buffer.byteLength(JSON.stringify(note)) <= 6144);
  const serialized = JSON.stringify(note);
  for (const privateValue of [f.referenceKey, f.intent.objective, "Private speaker", "Private original message", '"accountId"', '"chatId"', '"requesterId"', '"primaryMessageId"', "nextPosition", "hnpos_"]) assert.equal(serialized.includes(privateValue), false, privateValue);
  assert.doesNotThrow(() => requireStandingChronicleNote(note)); assert.doesNotThrow(() => requireStandingChronicleNote(note, f.owner));
});

test("long UTF8 and JSON-escaped notes retain bounded honest ranges instead of pretending completeness", async t => {
  for (const summary of ["я".repeat(2048), "\u0001".repeat(4096)]) {
    const f = await fixture(t, summary, "У".repeat(512), 16), note = projectStandingChronicleNote({ intent: f.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey });
    const expected = readNodeNotes({ node: f.node, referenceKey: f.referenceKey, maxBytes: 4096 }), { nextPosition, ...notes } = expected;
    assert.deepEqual(note.notes, notes); assert.equal(note.hasMoreNotes, nextPosition !== null); assert.equal(note.hasMoreNotes, true);
    assert.equal(note.notes.detailCoverage, "partial"); assert.equal(note.notes.summary.range.totalBytes, Buffer.byteLength(summary));
    assert.equal(Buffer.from(note.notes.summary.text).toString(), note.notes.summary.text); assert.ok(summary.startsWith(note.notes.summary.text));
    assert.equal(note.notes.claimRange.totalClaims, 16); assert.equal(note.notes.modelAuthoredOmittedDetailCount, 7);
    assert.ok(Buffer.byteLength(JSON.stringify(note)) <= 6144); assert.equal(Object.hasOwn(note.notes, "nextPosition"), false);
  }
});

test("same inputs yield stable references while key, task identity and source head produce distinct scoped versions", async t => {
  const f = await fixture(t), input = { intent: f.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey };
  const note = projectStandingChronicleNote(input); assert.deepEqual(projectStandingChronicleNote(input), note);
  const newKey = projectStandingChronicleNote({ ...input, referenceKey: "f".repeat(64) }); assert.notEqual(newKey.sourceRef, note.sourceRef); assert.notEqual(newKey.versionRef, note.versionRef);
  const newTask = projectStandingChronicleNote({ ...input, intent: { ...f.intent, taskId: "htask_" + "8".repeat(48) } }); assert.notEqual(newTask.sourceRef, note.sourceRef);
  const newHead = projectStandingChronicleNote({ ...input, readiness: { ...f.readiness, sourceHead: "e".repeat(64) } });
  assert.equal(newHead.sourceRef, note.sourceRef); assert.notEqual(newHead.versionRef, note.versionRef);
  const newAnalysisHead = projectStandingChronicleNote({ ...input, readiness: { ...f.readiness, expectedHead: "e".repeat(64) } });
  assert.equal(newAnalysisHead.sourceRef, note.sourceRef); assert.notEqual(newAnalysisHead.versionRef, note.versionRef);
});

test("issued-note identity and exact owner binding reject clones, proxies and mismatched owners", async t => {
  const f = await fixture(t), note = projectStandingChronicleNote({ intent: f.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey }); let invoked = 0;
  for (const value of [structuredClone(note), { ...note }, new Proxy(note, { get() { invoked++; throw Error("trap"); } })]) assert.throws(() => requireStandingChronicleNote(value));
  for (const owner of [{ ...f.owner, accountId: "999" }, { ...f.owner, peerId: "-100999" }, { ...f.owner, requesterId: "999" },
    { ...f.owner, get requesterId() { invoked++; return f.owner.requesterId; } }, new Proxy(f.owner, { ownKeys() { invoked++; throw Error("trap"); } })]) assert.throws(() => requireStandingChronicleNote(note, owner));
  assert.equal(invoked, 0); assert.doesNotThrow(() => requireStandingChronicleNote(note, f.owner));
});

test("projection detaches node output and coverage while preserving explicit source gaps and no invented dates", async t => {
  const f = await fixture(t), node = structuredClone(f.node), readiness = structuredClone(f.readiness);
  const input = { intent: { ...f.intent }, node, readiness: { ...readiness, coverage: { ...readiness.coverage, readTraversalComplete: false }, gaps: [{ kind: "inexact-history" as const }] }, referenceKey: f.referenceKey };
  const note = projectStandingChronicleNote(input), original = structuredClone(note);
  (node.output as { summary: string }).summary = "caller mutation"; input.intent.objective = "new private objective";
  input.readiness.gaps.length = 0; input.readiness.coverage.readTraversalComplete = true;
  assert.deepEqual(note, original); assert.notEqual(note.sourceCoverage, input.readiness.coverage); assert.notEqual(note.notes.claims, node.output.claims);
  assert.deepEqual(note.sourceGaps, [{ kind: "inexact-history" }]); assert.equal(note.observedAt, null); frozen(note);
});

test("missing or mismatched readiness root, malformed heads and non-ready plans refuse", async t => {
  const f = await fixture(t), input = { intent: f.intent, node: f.node, referenceKey: f.referenceKey };
  const { rootRef: _root, ...missing } = f.readiness;
  for (const readiness of [missing, { ...f.readiness, rootRef: "hnode_" + "e".repeat(48) }, { ...f.readiness, sourceHead: "bad" },
    { ...f.readiness, expectedHead: "bad" }, { ...f.readiness, kind: "read-more" }]) {
    assert.throws(() => projectStandingChronicleNote({ ...input, readiness } as Parameters<typeof projectStandingChronicleNote>[0]));
  }
});

test("getters, proxies, executable extras and oversized metadata refuse without executing caller code", async t => {
  const f = await fixture(t), input = { intent: f.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey }; let invoked = 0;
  const trap = { ownKeys() { invoked++; throw Error("trap"); }, getPrototypeOf() { invoked++; throw Error("trap"); } };
  const candidates = [new Proxy(input, trap), { ...input, get node() { invoked++; return f.node; } }, { ...input, intent: new Proxy(f.intent, trap) },
    { ...input, readiness: { ...f.readiness, get sourceHead() { invoked++; return f.readiness.sourceHead; } } },
    { ...input, node: { ...f.node, output: { ...f.node.output, get summary() { invoked++; return "bad"; } } } },
    { ...input, toJSON() { invoked++; return {}; } }, { ...input, intent: { ...f.intent, objective: "x".repeat(4097) } }, { ...input, referenceKey: "bad" }];
  for (const candidate of candidates) assert.throws(() => projectStandingChronicleNote(candidate));
  assert.equal(invoked, 0);
});

function consumer(f: Awaited<ReturnType<typeof fixture>>) {
  const binding = { accountId: f.intent.accountId, peerId: f.intent.chatId }, references = createConversationReferences(binding);
  const primary = { chatId: binding.peerId, ownerId: f.intent.requesterId, messageId: 1000, text: "ПРОМПТ Напомни заметки анализа" };
  const args = { binding, primary, references, scopeRef: "scope_" + "a".repeat(32), asOf: 1000, signal: new AbortController().signal };
  return { args, references, primary };
}
function composerInput(f: ReturnType<typeof consumer>, note: ReturnType<typeof projectStandingChronicleNote>): StandingSharedContextInput {
  const absent = () => ({ items: [], coverage: { availability: "not-configured" as const, freshness: "unknown" as const, scanned: 0, hasMore: null, omittedAtSource: null } });
  return { scope: { scopeRef: f.args.scopeRef, audience: { kind: "requester", requesterRef: f.references.speaker(f.primary.ownerId) } }, asOf: f.args.asOf,
    chronicle: { items: [note], coverage: { availability: "available", freshness: "stale", scanned: 1, hasMore: null, omittedAtSource: null } },
    dialogues: absent(), ownActions: absent(), tasks: absent() };
}

test("authenticated note supports survive requester-bound shared context and the actual conversation model packet", async t => {
  const f = await fixture(t), note = projectStandingChronicleNote({ intent: f.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey }), c = consumer(f);
  try {
    const shared = readStandingSharedContext({ ...c.args, chronicleNotes: [note] });
    assert.deepEqual(shared.snapshot.items, [{ source: "chronicle", evidence: note }]);
    assert.equal(shared.snapshot.coverage.chronicle.scope, "observations-and-analysis-notes");
    const raw = conversationModelInput(c.primary, undefined, c.references, undefined, undefined, shared), packet = JSON.parse(raw);
    assert.equal(packet.contextState.shared.status, "included"); assert.deepEqual(packet.contextState.shared.snapshot, shared.snapshot);
    const evidence = packet.contextState.shared.snapshot.items[0].evidence;
    assert.deepEqual(evidence, note); assert.deepEqual(evidence.notes.claims[0]!.supports, f.supports);
    assert.equal(evidence.notes.claimsStatus, "model-authored-unverified"); assert.equal(evidence.notes.supportScope, "immediate-node-claims-only");
    assert.equal(evidence.notes.modelAuthoredOmittedDetailCount, 7); assert.equal(evidence.observedAt, null);
    assert.equal(packet.contextState.shared.snapshot.completeChat, false); assert.equal(packet.contextState.shared.snapshot.initiativeEligibility, "not-evaluated");
    assert.equal(packet.currentRequest.text, "Напомни заметки анализа"); assert.ok(Buffer.byteLength(raw) <= CONVERSATION_INPUT_BYTES);
    for (const privateValue of [f.referenceKey, f.intent.objective, '"requesterId"', '"accountId"', '"chatId"', "nextPosition", "hnpos_"]) assert.equal(raw.includes(privateValue), false, privateValue);
  } finally { c.references.close(); }
});

test("shared reader rejects a note for another requester or chat and composer rejects an unissued clone", async t => {
  const f = await fixture(t), note = projectStandingChronicleNote({ intent: f.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey }), c = consumer(f);
  const foreignBinding = { ...c.args.binding, peerId: "-100999" }, foreignReferences = createConversationReferences(foreignBinding);
  try {
    assert.throws(() => readStandingSharedContext({ ...c.args, primary: { ...c.primary, ownerId: "777" }, chronicleNotes: [note] }), /STANDING_CHRONICLE_NOTE_REFUSED/);
    assert.throws(() => readStandingSharedContext({ ...c.args, binding: foreignBinding, references: foreignReferences,
      primary: { ...c.primary, chatId: foreignBinding.peerId }, chronicleNotes: [note] }), /STANDING_CHRONICLE_NOTE_REFUSED/);
    const input = composerInput(c, note);
    assert.doesNotThrow(() => projectStandingSharedContext(input));
    for (const clone of [{ ...note }, structuredClone(note)]) {
      assert.throws(() => projectStandingSharedContext({ ...input, chronicle: { ...input.chronicle, items: [clone] } }), /STANDING_CHRONICLE_NOTE_REFUSED/);
    }
    assert.deepEqual(readStandingSharedContext({ ...c.args, chronicleNotes: [note] }).snapshot.items[0]!.evidence, note);
  } finally { foreignReferences.close(); c.references.close(); }
});

test("crowded shared context prioritizes the entire note over observations and reports whole-item budget omissions", async t => {
  const f = await fixture(t, "я".repeat(2048), "Поддержанное моделью утверждение ".repeat(12), 16),
    note = projectStandingChronicleNote({ intent: f.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey }), c = consumer(f);
  const row = (messageId: number, text: string): StandingContextMessage => ({ chatId: f.intent.chatId, messageId, authorId: f.intent.requesterId,
    author: "user", displayName: "Synthetic requester", date: messageId, replyToMessageId: null, text });
  const context: StandingContext = { version: "standing-context-v1", primary: row(c.primary.messageId, c.primary.text), replyChain: [],
    recent: Array.from({ length: 12 }, (_, i) => row(900 + i, "Observation " + i + ": " + "x".repeat(1000))), chainStatus: "complete", recentStatus: "complete" };
  try {
    const shared = readStandingSharedContext({ ...c.args, chronicleNotes: [note], context }), snapshot = shared.snapshot;
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= STANDING_SHARED_CONTEXT_MAX_BYTES);
    assert.deepEqual(snapshot.items[0], { source: "chronicle", evidence: note });
    assert.equal(snapshot.coverage.chronicle.provided, 13); assert.equal(snapshot.coverage.chronicle.included, snapshot.items.length);
    assert.equal(snapshot.coverage.chronicle.omittedByBudget, 13 - snapshot.items.length); assert.ok(snapshot.coverage.chronicle.omittedByBudget > 0);
    assert.equal(snapshot.coverage.chronicle.hasMore, null); assert.equal(snapshot.coverage.chronicle.omittedAtSource, null);
    for (const item of snapshot.items.slice(1)) {
      assert.equal(item.evidence.kind, "observed-message");
      if (item.evidence.kind !== "observed-message") assert.fail();
      const text = item.evidence.text; assert.ok(context.recent.some(message => message.text === text));
    }
    const raw = conversationModelInput(c.primary, context, c.references, undefined, undefined, shared), packet = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) <= CONVERSATION_INPUT_BYTES); assert.equal(packet.contextState.shared.status, "included");
    assert.deepEqual(packet.contextState.shared.snapshot, snapshot); assert.deepEqual(packet.contextState.shared.snapshot.items[0].evidence.notes.claims, note.notes.claims);
    // When even the complete note cannot fit, the composer drops it, never a
    // shortened or apparently complete variant of its summary/support evidence.
    const limited = projectStandingSharedContext(composerInput(c, note), { maxBytes: 2048 });
    assert.ok(Buffer.byteLength(JSON.stringify(limited)) <= 2048); assert.deepEqual(limited.items, []);
    assert.equal(limited.coverage.chronicle.provided, 1); assert.equal(limited.coverage.chronicle.included, 0); assert.equal(limited.coverage.chronicle.omittedByBudget, 1);
  } finally { c.references.close(); }
});
