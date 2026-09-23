import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationReferences } from "../src/conversation-references.js";
import { createStandingHistoryTaskMemory } from "../src/standing-history-task-memory.js";
import { requireStandingHistoryTaskContext } from "../src/standing-history-task-context.js";
import { openStandingHistoryTaskManager, type StandingHistoryTaskContextEvent, type StandingHistoryManagedTaskStatus } from "../src/standing-history-task-manager.js";
import { openStandingHistoryTaskDiscovery } from "../src/standing-history-task-discovery.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { snapshotStandingHistoryTaskProgress, snapshotStandingHistoryTaskProgressEvent,
  projectStandingHistoryTaskProgress } from "../src/standing-history-task-progress.js";
import { readStandingSharedContext } from "../src/standing-shared-context-reader.js";
import { conversationModelInput } from "../src/standing-model-input.js";
import { projectStandingSharedContext } from "../src/standing-shared-context.js";

const binding = { accountId: "999", peerId: "-100123" }, primary = { chatId: binding.peerId, ownerId: "123", messageId: 1000, text: "Task status?" };
const scopeRef = "scope_" + "a".repeat(32), observedAt = 1700000000;
const ref = (n: number) => "htask_" + n.toString(16).padStart(48, "0");
function intent(n: number, requesterId = primary.ownerId): StandingHistoryTaskIntent {
  return { schema: "standing-history-task-v1", taskId: ref(n), accountId: binding.accountId, chatId: binding.peerId, requesterId,
    primaryMessageId: n, fromDate: 1000, toDate: 2000, timezone: "UTC", objective: "Task purpose " + n };
}
function status(taskRef: string): StandingHistoryManagedTaskStatus {
  return { taskRef, control: { storage: "ready", state: "queued", revision: 0, headHash: "a".repeat(64) },
    read: { storage: "unavailable" }, analysis: { storage: "unavailable" }, attempts: { storage: "ready", attempts: 0, modelReplayAllowed: false } };
}
const event = (n: number, actor?: string): StandingHistoryTaskContextEvent => ({ kind: "snapshot", intent: intent(n, actor), status: status(ref(n)) });
function fixture() {
  const references = createConversationReferences(binding), abort = new AbortController();
  const memory = createStandingHistoryTaskMemory({ binding, references, signal: abort.signal, scopeRef });
  return { references, abort, memory, close() { memory.close(); references.close(); } };
}

test("saved counts and host stall survive invalidation into same-actor bounded model context", () => {
  const f = fixture();
  try {
    // The context adapter consumes authenticated manager statuses in production.
    const s = { ...status(ref(1)), read: { storage: "ready", readProgress: { committedPages: 24,
      checkpoint: { inexact: false, undated: 0, status: "more" } } },
      analysis: { storage: "ready", claims: "model-authored-unverified", analysisNodes: 46 } } as unknown as StandingHistoryManagedTaskStatus;
    f.memory.observe({ kind: "snapshot", intent: intent(1), status: s }, observedAt);
    f.memory.observeProgress({ taskRef: ref(1), phase: "stalled", reason: "consumed-without-prepared" }, observedAt + 1);
    f.memory.invalidate(ref(1));
    const taskContext = f.memory.forPrimary({ primary, asOf: observedAt + 100 });
    const bound = readStandingSharedContext({ binding, primary, references: f.references, scopeRef, signal: f.abort.signal,
      asOf: observedAt + 100, taskContext });
    const body = conversationModelInput(primary, undefined, f.references, undefined, undefined, bound);
    const packet = JSON.parse(body), task = packet.contextState.shared.snapshot.items.find((i: any) => i.source === "tasks").evidence;
    assert.deepEqual(task.savedProgress, { committedPages: 24, analysisNodes: 46, observedAt, freshness: "stale" });
    assert.deepEqual(task.progress, { phase: "stalled", reason: "consumed-without-prepared", recovery: "needs-settlement",
      observedAt: observedAt + 1, freshness: "stale", executionAuthorized: false });
    assert.equal(task.modelOutcome, "unavailable"); assert.equal(task.delivery, "unavailable");
    assert.equal(task.observedAt, observedAt); assert.equal(taskContext.source.coverage.freshness, "unknown");
    assert.ok(Buffer.byteLength(JSON.stringify(bound.snapshot)) <= 8192);
    assert.equal(f.memory.forPrimary({ primary: { ...primary, ownerId: "456" }, asOf: observedAt + 100 }).source.items.length, 0);
    assert.throws(() => f.memory.forPrimary({ primary, asOf: observedAt }));
    const clone = structuredClone(bound.snapshot), empty = { items: [], coverage: { availability: "not-configured" as const, freshness: "unknown" as const, scanned: 0, hasMore: null, omittedAtSource: null } };
    const evidence = clone.items.find(i => i.source === "tasks")!.evidence;
    assert.throws(() => projectStandingSharedContext({ scope: clone.scope, asOf: observedAt,
      chronicle: empty, dialogues: empty, ownActions: empty, tasks: { ...taskContext.source, items: [evidence as any] } }));
  } finally { f.close(); }
});

test("host observations cannot create tasks, renew saved evidence or survive a new connection", () => {
  const f = fixture();
  try {
    f.memory.observeProgress({ taskRef: ref(1), phase: "analyzing", reason: null }, observedAt);
    assert.equal(f.memory.forPrimary({ primary, asOf: observedAt }).source.items.length, 0);
    f.memory.observe(event(1), observedAt);
    assert.deepEqual(f.memory.forPrimary({ primary, asOf: observedAt }).source.items[0]!.savedProgress,
      { committedPages: null, analysisNodes: null, observedAt, freshness: "stale" });
    f.memory.observeProgress({ taskRef: ref(1), phase: "reviewing", reason: null }, observedAt + 1);
    f.memory.remember(intent(1), observedAt + 2);
    f.memory.observe(event(1), observedAt + 3);
    let task = f.memory.forPrimary({ primary, asOf: observedAt + 3 }).source.items[0]!;
    assert.equal(task.progress!.observedAt, observedAt + 1); assert.equal(task.savedProgress!.observedAt, observedAt + 3);
    assert.throws(() => f.memory.observeProgress({ taskRef: ref(1), phase: "planning", reason: null }, observedAt));
    f.memory.observeProgress({ taskRef: ref(1), phase: "stalled", reason: "report-quality-required" }, observedAt + 4);
    task = f.memory.forPrimary({ primary, asOf: observedAt + 4 }).source.items[0]!;
    assert.equal(task.progress!.recovery, "review-report");
    f.memory.close();
    const next = fixture();
    try {
      next.memory.observe(event(1), observedAt + 5);
      assert.equal(next.memory.forPrimary({ primary, asOf: observedAt + 5 }).source.items[0]!.progress, undefined);
    } finally { next.close(); }
  } finally { f.close(); }
});

test("progress exact schemas reject accessors, unknown reasons, authority and contradictory phases", () => {
  const good = { taskRef: ref(1), phase: "stalled" as const, reason: "prior-owner-unavailable" as const };
  const progress = projectStandingHistoryTaskProgress(good, observedAt);
  assert.equal(snapshotStandingHistoryTaskProgress(progress).recovery, "needs-settlement");
  let invoked = 0;
  const accessor = Object.defineProperty({ ...good }, "reason", { enumerable: true, get() { invoked++; return good.reason; } });
  assert.throws(() => snapshotStandingHistoryTaskProgressEvent(accessor)); assert.equal(invoked, 0);
  for (const bad of [{ ...good, reason: "raw error text" }, { ...good, phase: "analyzing" }, { ...good, reason: null },
    { ...good, taskRef: "foreign" }, { ...good, permission: true }, new Proxy(good, {})]) assert.throws(() => snapshotStandingHistoryTaskProgressEvent(bad));
  for (const bad of [{ ...progress, executionAuthorized: true }, { ...progress, freshness: "current" },
    { ...progress, recovery: "none" }, { ...progress, observedAt: -1 }]) assert.throws(() => snapshotStandingHistoryTaskProgress(bad));
});

test("generic persisted report blockage requires status refresh rather than claiming known quality failure", () => {
  const f = fixture();
  try {
    f.memory.observe(event(1), observedAt);
    f.memory.observeProgress({ taskRef: ref(1), phase: "stalled", reason: "report-quality-required" }, observedAt + 1);
    assert.equal(f.memory.forPrimary({ primary, asOf: observedAt + 1 }).source.items[0]!.progress!.recovery, "review-report");
    f.memory.observeProgress({ taskRef: ref(1), phase: "stalled", reason: "report-required" }, observedAt + 2);
    const generic = f.memory.forPrimary({ primary, asOf: observedAt + 2 }).source.items[0]!.progress!;
    assert.equal(generic.recovery, "refresh-status"); assert.equal(generic.executionAuthorized, false);
    assert.throws(() => snapshotStandingHistoryTaskProgress({ ...generic, recovery: "review-report" }));
    f.memory.observeProgress({ taskRef: ref(1), phase: "stalled", reason: "consumed-without-prepared" }, observedAt + 3);
    assert.equal(f.memory.forPrimary({ primary, asOf: observedAt + 3 }).source.items[0]!.progress!.recovery, "needs-settlement");
  } finally { f.close(); }
});
test("cold cache is unavailable; reuse preserves original time and binds only current same-actor primary", () => {
  const f = fixture();
  try {
    assert.equal(f.memory.forPrimary({ primary, asOf: observedAt }).source.coverage.availability, "unavailable");
    f.memory.observe(event(1), observedAt);
    const nextPrimary = { ...primary, messageId: 1001, text: "Continue" }, page = f.memory.forPrimary({ primary: nextPrimary, asOf: observedAt + 100 });
    assert.equal(page.source.items[0]!.observedAt, observedAt); assert.equal(page.source.items[0]!.description?.objective, "Task purpose 1");
    assert.equal(page.source.coverage.freshness, "stale"); assert.equal(page.source.coverage.hasMore, null); assert.equal(page.scan.completeTraversal, false);
    assert.equal(requireStandingHistoryTaskContext(page, nextPrimary, f.references, { scopeRef, asOf: observedAt + 100 }), page);
    assert.throws(() => requireStandingHistoryTaskContext(page, primary, f.references));
    assert.equal(f.memory.forPrimary({ primary: { ...primary, ownerId: "456" }, asOf: observedAt + 100 }).source.items.length, 0);
  } finally { f.close(); }
});
test("task-specific, actor-specific and all invalidations retain purpose with unavailable progress", () => {
  const f = fixture();
  try {
    f.memory.observe(event(1), observedAt); f.memory.observe(event(2), observedAt); f.memory.observe(event(3, "456"), observedAt);
    f.memory.invalidate(ref(1), "456");
    assert.equal(f.memory.forPrimary({ primary, asOf: observedAt }).source.items.find(i => i.taskRef === ref(1))!.control, "queued");
    f.memory.observe({ kind: "invalidate", taskRef: ref(1), requesterId: primary.ownerId }, observedAt + 1);
    let page = f.memory.forPrimary({ primary, asOf: observedAt + 2 });
    assert.equal(page.source.items.find(i => i.taskRef === ref(1))!.description?.objective, "Task purpose 1");
    assert.equal(page.source.items.find(i => i.taskRef === ref(1))!.control, "unavailable");
    assert.equal(page.source.items.find(i => i.taskRef === ref(2))!.control, "queued"); assert.equal(page.source.coverage.freshness, "unknown");
    f.memory.invalidate(undefined, primary.ownerId); page = f.memory.forPrimary({ primary, asOf: observedAt + 2 });
    assert.ok(page.source.items.every(i => i.outputPrepared === "unavailable"));
    const foreign = { ...primary, ownerId: "456" };
    assert.equal(f.memory.forPrimary({ primary: foreign, asOf: observedAt + 2 }).source.items[0]!.control, "queued");
    f.memory.invalidate(); assert.equal(f.memory.forPrimary({ primary: foreign, asOf: observedAt + 2 }).source.items[0]!.control, "unavailable");
    f.memory.observe(event(1), observedAt + 3);
    assert.equal(f.memory.forPrimary({ primary, asOf: observedAt + 3 }).source.items.find(i => i.taskRef === ref(1))!.control, "queued");
  } finally { f.close(); }
});
test("32 task LRU eviction and four selected rows stay bounded without latest/all coverage claims", () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 32; n++) f.memory.remember(intent(n, String(n)), observedAt);
    const actor = (n: number) => ({ ...primary, ownerId: String(n) });
    assert.equal(f.memory.forPrimary({ primary: actor(1), asOf: observedAt }).source.items.length, 1);
    f.memory.remember(intent(33, "33"), observedAt);
    assert.equal(f.memory.forPrimary({ primary: actor(2), asOf: observedAt }).source.items.length, 0);
    assert.equal(f.memory.forPrimary({ primary: actor(1), asOf: observedAt }).source.items.length, 1);
    for (let n = 40; n < 48; n++) f.memory.observe(event(n), observedAt);
    const page = f.memory.forPrimary({ primary, asOf: observedAt });
    assert.equal(page.source.items.length, 4); assert.equal(page.scan.latestOrdering, false); assert.equal(page.source.coverage.omittedAtSource, null);
    assert.deepEqual(page.source.items.map(i => i.taskRef), [47, 46, 45, 44].map(ref));
  } finally { f.close(); }
});
test("malformed observer input invalidates retained statuses without leaking or executing getters", () => {
  const f = fixture(); let executed = 0;
  try {
    f.memory.observe(event(1), observedAt);
    const hostile = { ...intent(2) }; Object.defineProperty(hostile, "objective", { enumerable: true, get() { executed++; return "secret"; } });
    assert.throws(() => f.memory.observe({ kind: "snapshot", intent: hostile, status: status(ref(2)) }, observedAt));
    const page = f.memory.forPrimary({ primary, asOf: observedAt });
    assert.equal(executed, 0); assert.equal(page.source.items.length, 1); assert.equal(page.source.items[0]!.description?.objective, "Task purpose 1");
    assert.equal(page.source.items[0]!.control, "unavailable");
    assert.throws(() => f.memory.observe({ kind: "snapshot", intent: { ...intent(2), accountId: "888" }, status: status(ref(2)) }, observedAt));
  } finally { f.close(); }
});
test("unknown outcome and known false facts are retained without invented delivery", () => {
  const f = fixture();
  try {
    const s = { ...status(ref(1)), attempts: { storage: "ready" as const, attempts: 1, modelReplayAllowed: false as const,
      last: { attemptRef: "hattempt_" + "b".repeat(48), attemptIndex: 1, nodeIndex: 1, planHash: "c".repeat(64), modelOutcome: "unknown" as const } } };
    f.memory.observe({ kind: "snapshot", intent: intent(1), status: s }, observedAt);
    const task = f.memory.forPrimary({ primary, asOf: observedAt + 1 }).source.items[0]!;
    assert.equal(task.modelOutcome, "unknown"); assert.equal(task.outputPrepared, false); assert.equal(task.nodeCommitted, false); assert.equal(task.delivery, "not-inspected");
    assert.throws(() => f.memory.forPrimary({ primary, asOf: observedAt - 1 }));
  } finally { f.close(); }
});
test("close and abort revoke issued pages and tolerate late invalidate/observer callbacks", () => {
  const f = fixture();
  try {
    f.memory.observe(event(1), observedAt); const page = f.memory.forPrimary({ primary, asOf: observedAt });
    f.memory.close(); f.memory.close(); f.memory.invalidate(); f.memory.observe(event(2), observedAt);
    f.memory.remember(intent(2), observedAt);
    assert.throws(() => f.memory.forPrimary({ primary, asOf: observedAt }));
    assert.throws(() => requireStandingHistoryTaskContext(page, primary, f.references));
  } finally { f.close(); }
  const second = fixture(); second.abort.abort(); assert.throws(() => second.memory.forPrimary({ primary, asOf: observedAt })); second.memory.invalidate(); second.close();
});
test("actual encrypted manager observer populates purpose, invalidates cancellation, and refreshes after reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "neurobro-task-memory-")), directories = { control: join(root, "control"), pages: join(root, "pages"), analysis: join(root, "analysis") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const args = { directories, passphrase: "invented task memory passphrase", binding, async onCancelled() {} };
  const first = fixture(); let callbacks = 0;
  let manager = await openStandingHistoryTaskManager({ ...args, onObservation(event) { callbacks++; first.memory.observe(event, observedAt); } });
  const created = await manager.create({ primary, request: { fromDate: 1000, toDate: 2000, timezone: "UTC", objective: "Purpose retained across turns" } });
  const next = { ...primary, messageId: 1001, text: "Next question" };
  let page = first.memory.forPrimary({ primary: next, asOf: observedAt + 1 });
  assert.equal(page.source.items[0]!.description?.objective, "Purpose retained across turns");
  assert.deepEqual(page.source.items[0]!.savedProgress, { committedPages: 0, analysisNodes: 0, observedAt, freshness: "stale" });
  assert.equal(callbacks, 2);
  await manager.cancel({ taskRef: created.taskRef, requesterId: primary.ownerId });
  page = first.memory.forPrimary({ primary: next, asOf: observedAt + 2 });
  assert.equal(page.source.items[0]!.control, "unavailable"); assert.equal(page.source.items[0]!.description?.objective, "Purpose retained across turns");
  assert.equal(page.source.items[0]!.savedProgress!.committedPages, 0);
  await manager.close(); first.close();
  const second = fixture();
  manager = await openStandingHistoryTaskManager({ ...args, onObservation(event) { second.memory.observe(event, observedAt + 3); } });
  const discovery = await openStandingHistoryTaskDiscovery({ directory: directories.pages, passphrase: args.passphrase,
    accountId: binding.accountId, chatId: binding.peerId, signal: second.abort.signal });
  try {
    assert.equal(second.memory.forPrimary({ primary: next, asOf: observedAt + 3 }).source.coverage.availability, "unavailable");
    const found = await discovery.find({ limit: 4 });
    assert.equal(found.tasks.length, 1);
    second.memory.remember(found.tasks[0]!, observedAt + 3);
    const purposeOnly = second.memory.forPrimary({ primary: next, asOf: observedAt + 3 });
    assert.equal(purposeOnly.source.items[0]!.description?.objective, "Purpose retained across turns");
    assert.equal(purposeOnly.source.items[0]!.control, "unavailable");
    assert.equal(purposeOnly.source.items[0]!.delivery, "unavailable");
    assert.equal(purposeOnly.source.coverage.freshness, "unknown");
    await manager.status({ taskRef: created.taskRef, requesterId: primary.ownerId });
    const restored = second.memory.forPrimary({ primary: next, asOf: observedAt + 4 });
    assert.equal(restored.source.items[0]!.control, "cancelled"); assert.equal(restored.source.items[0]!.description?.objective, "Purpose retained across turns");
    assert.equal(restored.source.coverage.freshness, "stale");
  } finally { await discovery.close(); await manager.close(); second.close(); }
});
test("intent-only discovery supplies actor-scoped purpose with every status facet unknown", () => {
  const f = fixture();
  try {
    f.memory.remember(intent(1), observedAt);
    const page = f.memory.forPrimary({ primary, asOf: observedAt + 1 }), task = page.source.items[0]!;
    assert.equal(task.description?.objective, "Task purpose 1"); assert.equal(task.observedAt, observedAt);
    for (const key of ["control", "read", "analysis", "outputPrepared", "nodeCommitted", "modelOutcome", "delivery", "disposition"] as const) assert.equal(task[key], "unavailable");
    assert.equal(page.source.coverage.freshness, "unknown"); assert.equal(page.scan.completeTraversal, false);
    assert.equal(f.memory.forPrimary({ primary: { ...primary, ownerId: "456" }, asOf: observedAt + 1 }).source.items.length, 0);
    for (const key of ["accountId", "chatId", "primaryMessageId", "intentRef"]) assert.ok(!JSON.stringify(page).includes(key));
  } finally { f.close(); }
});
test("exact rediscovery preserves known status, original time and version; conflicting immutable intent refuses", () => {
  const f = fixture();
  try {
    f.memory.observe(event(1), observedAt);
    const original = f.memory.forPrimary({ primary, asOf: observedAt }).source.items[0]!;
    f.memory.remember({ ...intent(1) }, observedAt + 50);
    assert.deepEqual(f.memory.forPrimary({ primary, asOf: observedAt + 100 }).source.items[0], original);
    for (const conflict of [
      { ...intent(1), objective: "Different immutable objective" }, { ...intent(1), fromDate: 999 },
      { ...intent(1), primaryMessageId: 2 }, { ...intent(1), requesterId: "456" },
    ]) assert.throws(() => f.memory.remember(conflict, observedAt + 100));
    assert.deepEqual(f.memory.forPrimary({ primary, asOf: observedAt + 100 }).source.items[0], original);
    f.memory.invalidate(ref(1));
    const invalidated = f.memory.forPrimary({ primary, asOf: observedAt + 100 }).source.items[0]!;
    f.memory.remember(intent(1), observedAt + 101);
    assert.deepEqual(f.memory.forPrimary({ primary, asOf: observedAt + 101 }).source.items[0], invalidated);
  } finally { f.close(); }
});
