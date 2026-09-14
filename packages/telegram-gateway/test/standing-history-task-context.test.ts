import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationReferences } from "../src/conversation-references.js";
import { openStandingHistoryTaskDiscovery, type StandingHistoryTaskDiscoveryPage } from "../src/standing-history-task-discovery.js";
import { openStandingHistoryTaskManager, type StandingHistoryManagedTaskStatus } from "../src/standing-history-task-manager.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { projectStandingSharedContext } from "../src/standing-shared-context.js";
import { readStandingHistoryTaskContext, requireStandingHistoryTaskContext, createStandingHistoryTaskContextProjection, type StandingHistoryTaskContextInput } from "../src/standing-history-task-context.js";

const binding = { accountId: "999", peerId: "-100123" }, primary = { chatId: binding.peerId, ownerId: "123", messageId: 1000, text: "How is my task?" };
const scopeRef = "scope_" + "a".repeat(32), asOf = 1700002000;
const id = (n: number) => "htask_" + n.toString(16).padStart(48, "0");
function intent(n = 1, requesterId = primary.ownerId): StandingHistoryTaskIntent {
  return { schema: "standing-history-task-v1", taskId: id(n), accountId: binding.accountId, chatId: binding.peerId, requesterId,
    primaryMessageId: n, fromDate: 1000, toDate: 2000, timezone: "UTC", objective: "Task objective " + n };
}
function page(tasks: StandingHistoryTaskIntent[], more = false): StandingHistoryTaskDiscoveryPage {
  return { tasks, hasMore: more, ...(more ? { cursor: "hcur_" + "a".repeat(48) } : {}),
    coverage: { scanned: tasks.length, unavailable: 0, foreign: 0, root: "present", complete: !more } };
}
function status(taskRef: string): StandingHistoryManagedTaskStatus {
  return { taskRef, control: { storage: "ready", state: "queued", revision: 0, headHash: "a".repeat(64) },
    read: { storage: "unavailable" }, analysis: { storage: "unavailable" } };
}
function fixture() {
  const references = createConversationReferences(binding), controller = new AbortController();
  const input: StandingHistoryTaskContextInput = { binding, primary, references, signal: controller.signal, scopeRef, asOf,
    discovery: { async find() { return page([intent()]); } }, manager: { async status(value) { return status(value.taskRef); } } };
  return { references, controller, input };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
test("real encrypted task creation survives manager/discovery reopen and actor-only bounded traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "neurobro-task-context-"));
  const directories = { control: join(root, "control"), pages: join(root, "pages"), analysis: join(root, "analysis") };
  for (const dir of Object.values(directories)) await mkdir(dir);
  const args = { directories, passphrase: "invented task context passphrase", binding, async onCancelled() {} };
  const own = new Set<string>(); let manager = await openStandingHistoryTaskManager(args);
  for (let n = 1; n <= 6; n++) {
    const requesterId = n === 3 ? "456" : primary.ownerId;
    const created = await manager.create({ primary: { ...primary, ownerId: requesterId, messageId: n },
      request: { fromDate: 1000, toDate: 2000, timezone: "UTC", objective: n === 3 ? "FOREIGN PRIVATE OBJECTIVE" : "Own task " + n } });
    if (requesterId === primary.ownerId) own.add(created.taskRef);
  }
  await manager.close(); manager = await openStandingHistoryTaskManager(args);
  const f = fixture(), discovery = await openStandingHistoryTaskDiscovery({ directory: directories.pages, passphrase: args.passphrase,
    accountId: binding.accountId, chatId: binding.peerId, signal: f.controller.signal });
  let finds = 0, statuses = 0;
  const borrowedDiscovery = { async find(value: Parameters<typeof discovery.find>[0]) { finds++; assert.equal(value?.limit, 4); return discovery.find(value); } };
  const borrowedManager = { async status(value: Parameters<typeof manager.status>[0]) { statuses++; assert.equal(value.requesterId, primary.ownerId); assert.ok(own.has(value.taskRef)); return manager.status(value); } };
  try {
    const seen = new Set<string>(); let continuation: Awaited<ReturnType<typeof readStandingHistoryTaskContext>>["continuation"];
    for (let pulse = 0; pulse < 5; pulse++) {
      const oldFinds = finds, oldStatuses = statuses;
      const result = await readStandingHistoryTaskContext({ ...f.input, discovery: borrowedDiscovery, manager: borrowedManager, ...(continuation ? { continuation } : {}) });
      assert.equal(finds - oldFinds, 1); assert.ok(statuses - oldStatuses <= 4);
      assert.equal(result.scan.latestOrdering, false);
      assert.ok(!JSON.stringify(result).includes("FOREIGN PRIVATE OBJECTIVE"));
      for (const task of result.source.items) {
        seen.add(task.taskRef); assert.equal(task.outputPrepared, "unavailable"); assert.equal(task.nodeCommitted, "unavailable");
        assert.equal(task.delivery, "not-inspected"); assert.ok(task.description?.objective.startsWith("Own task"));
      }
      continuation = result.continuation;
      if (!continuation) { assert.equal(result.scan.hasMore, false); break; }
    }
    assert.deepEqual(seen, own); assert.equal(statuses, 5); assert.equal(finds, 2);
  } finally { await discovery.close(); await manager.close(); f.references.close(); }
});
test("foreign actor/account/chat filters run before manager and expose no descriptions", async () => {
  const f = fixture(); const calls: string[] = [];
  try {
    const result = await readStandingHistoryTaskContext({ ...f.input, discovery: { async find() { return page([intent(1, "456"), { ...intent(2), accountId: "888" }, { ...intent(3), chatId: "-333" }, intent(4)]); } },
      manager: { async status(value) { calls.push(value.taskRef); return status(value.taskRef); } } });
    assert.deepEqual(calls, [id(4)]); assert.equal(result.scan.actorExcluded, 3); assert.equal(result.source.items.length, 1);
    assert.equal(result.source.items[0]!.description?.objective, "Task objective 4");
    for (let n = 1; n <= 3; n++) assert.ok(!JSON.stringify(result).includes("Task objective " + n));
  } finally { f.references.close(); }
});
test("single-use continuation is owned by actor, discovery and reference lifetime", async () => {
  const f = fixture(); let finds = 0;
  const discovery = { async find(value?: {cursor?:string;limit?:number}) { finds++; if (finds === 2) assert.match(value?.cursor ?? "", /^hcur_/); return page([], finds === 1); } };
  try {
    const first = await readStandingHistoryTaskContext({ ...f.input, discovery }); assert.ok(first.continuation);
    await assert.rejects(readStandingHistoryTaskContext({ ...f.input, discovery, primary: { ...primary, ownerId: "456" }, continuation: first.continuation }));
    await assert.rejects(readStandingHistoryTaskContext({ ...f.input, discovery: { ...discovery }, continuation: first.continuation }));
    const second = await readStandingHistoryTaskContext({ ...f.input, discovery, continuation: first.continuation });
    assert.equal(second.scan.hasMore, false); assert.equal(finds, 2);
    await assert.rejects(readStandingHistoryTaskContext({ ...f.input, discovery, continuation: first.continuation }));
    assert.equal(finds, 2);
  } finally { f.references.close(); }
});
test("status failures retain task descriptions and explicit unavailable facts, never false booleans", async () => {
  const f = fixture();
  try {
    const result = await readStandingHistoryTaskContext({ ...f.input, manager: { async status() { throw Error("PRIVATE STORAGE PATH"); } } });
    assert.equal(result.scan.statusUnavailable, 1); assert.equal(result.scan.completeTraversal, false);
    const task = result.source.items[0]!;
    assert.equal(task.description?.objective, "Task objective 1");
    assert.equal(task.outputPrepared, "unavailable"); assert.equal(task.nodeCommitted, "unavailable"); assert.equal(task.modelOutcome, "unavailable");
    assert.equal(task.control, "unavailable"); assert.ok(!JSON.stringify(result).includes("PRIVATE STORAGE PATH"));
    const absent = () => ({ items: [], coverage: { availability: "not-configured" as const, freshness: "unknown" as const, scanned: 0, hasMore: null, omittedAtSource: null } });
    const snapshot = projectStandingSharedContext({ scope: { scopeRef, audience: { kind: "requester", requesterRef: f.references.speaker(primary.ownerId) } }, asOf,
      tasks: result.source, chronicle: absent(), dialogues: absent(), ownActions: absent() });
    assert.equal(snapshot.items[0]!.evidence.kind, "task-state"); assert.equal(snapshot.initiativeEligibility, "not-evaluated");
  } finally { f.references.close(); }
});
test("cancelled, committed node and UNKNOWN native result remain independent", async () => {
  const f = fixture();
  try {
    const result = await readStandingHistoryTaskContext({ ...f.input, manager: { async status(value) { return { ...status(value.taskRef),
      control: { storage: "ready", state: "cancelled", revision: 1, headHash: "a".repeat(64) },
      attempts: { storage: "ready", attempts: 1, modelReplayAllowed: false, last: { attemptRef: "hattempt_" + "a".repeat(48), attemptIndex: 1,
        nodeIndex: 1, planHash: "b".repeat(64), prepared: { outputHash: "c".repeat(64) }, node: { nodeRef: "hnode_" + "d".repeat(48), index: 1, hash: "e".repeat(64) }, modelOutcome: "unknown" } },
      delivery: { state: "partial", consumed: true, partsTotal: 2, verifiedParts: 1, nextPart: 2 } }; } } });
    const task = result.source.items[0]!;
    assert.equal(task.control, "cancelled"); assert.equal(task.outputPrepared, true); assert.equal(task.nodeCommitted, true);
    assert.equal(task.modelOutcome, "unknown"); assert.equal(task.delivery, "partial");
    for (const privateKey of ["planHash", "outputHash", "headHash", "attemptRef", "nodeRef"]) assert.ok(!JSON.stringify(result).includes(privateKey));
  } finally { f.references.close(); }
});
test("authenticated zero attempts yields false while unavailable attempts remains unknown", async () => {
  const f = fixture();
  try {
    const known = await readStandingHistoryTaskContext({ ...f.input, manager: { async status(value) { return { ...status(value.taskRef), attempts: { storage: "ready", attempts: 0, modelReplayAllowed: false } }; } } });
    assert.equal(known.source.items[0]!.outputPrepared, false); assert.equal(known.source.items[0]!.nodeCommitted, false);
    assert.equal(known.source.items[0]!.modelOutcome, "not-recorded");
    const unknown = await readStandingHistoryTaskContext(f.input);
    assert.equal(unknown.source.items[0]!.outputPrepared, "unavailable");
  } finally { f.references.close(); }
});
test("abort during borrowed discovery joins actual I/O and admits no status calls", async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let completed = false, statuses = 0;
  const pending = readStandingHistoryTaskContext({ ...f.input, discovery: { async find() { entered.resolve(); await release.promise; return page([intent()]); } },
    manager: { async status(value) { statuses++; return status(value.taskRef); } } });
  void pending.then(() => { completed = true; }, () => { completed = true; });
  await entered.promise; f.controller.abort(); await Promise.resolve(); assert.equal(completed, false); assert.equal(statuses, 0);
  release.resolve(); await assert.rejects(pending); assert.equal(statuses, 0); f.references.close();
});
test("abort during first serial status joins it and does not admit the second", async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let completed = false, statuses = 0;
  const pending = readStandingHistoryTaskContext({ ...f.input, discovery: { async find() { return page([intent(1), intent(2)]); } },
    manager: { async status(value) { statuses++; entered.resolve(); await release.promise; return status(value.taskRef); } } });
  void pending.then(() => { completed = true; }, () => { completed = true; });
  await entered.promise; f.controller.abort(); await Promise.resolve(); assert.equal(completed, false);
  release.resolve(); await assert.rejects(pending); assert.equal(statuses, 1); f.references.close();
});
test("owned page rejects clones, changed primary and revoked reference lifetime", async () => {
  const f = fixture();
  try {
    const result = await readStandingHistoryTaskContext(f.input);
    assert.equal(requireStandingHistoryTaskContext(result, primary, f.references), result);
    assert.equal(requireStandingHistoryTaskContext(result, primary, f.references, { scopeRef, asOf }), result);
    assert.throws(() => requireStandingHistoryTaskContext(result, primary, f.references, { scopeRef, asOf: asOf + 1 }));
    assert.throws(() => requireStandingHistoryTaskContext(result, primary, f.references, { scopeRef: "scope_" + "b".repeat(32), asOf }));
    assert.throws(() => requireStandingHistoryTaskContext({ ...result }, primary, f.references));
    assert.throws(() => requireStandingHistoryTaskContext(result, { ...primary, messageId: 1001 }, f.references));
    assert.throws(() => requireStandingHistoryTaskContext(result, { ...primary, ownerId: "456" }, f.references));
    f.controller.abort(); assert.throws(() => requireStandingHistoryTaskContext(result, primary, f.references));
  } finally { f.references.close(); }
});
test("cumulative escaped-byte and key budgets stop status copying before a later branch", async () => {
  const f = fixture(), original = Object.getOwnPropertyDescriptors;
  let lateVisited = 0;
  const late = { nested: "must not be visited after budget exhaustion" };
  Object.getOwnPropertyDescriptors = function(value: unknown) {
    if (value === late) lateVisited++;
    return original(value);
  } as typeof Object.getOwnPropertyDescriptors;
  try {
    for (const large of [
      { ...status(id(1)), large: ["\u0001".repeat(8192), "\u0001".repeat(8192)], late },
      { ...status(id(1)), ["k".repeat(129)]: "key too long", late },
    ]) {
      const result = await readStandingHistoryTaskContext({ ...f.input, manager: { async status() { return large; } } });
      assert.equal(result.scan.statusUnavailable, 1);
      assert.equal(result.source.items[0]!.outputPrepared, "unavailable");
    }
    assert.equal(lateVisited, 0);
  } finally { Object.getOwnPropertyDescriptors = original; f.references.close(); }
});
test("malformed page/getters refuse inertly; unavailable discovery is not an empty complete inventory", async () => {
  const f = fixture(); let calls = 0;
  try {
    const hostile = { ...intent() }; Object.defineProperty(hostile, "objective", { enumerable: true, get() { calls++; return "secret"; } });
    await assert.rejects(readStandingHistoryTaskContext({ ...f.input, discovery: { async find() { return page([hostile]); } } }));
    assert.equal(calls, 0);
    const result = await readStandingHistoryTaskContext({ ...f.input, discovery: { async find() { throw Error("synthetic missing handle"); } } });
    assert.equal(result.source.coverage.availability, "unavailable"); assert.equal(result.scan.hasMore, null); assert.equal(result.scan.completeTraversal, false);
  } finally { f.references.close(); }
});
test("passive projection owns observations and binds reused pages to new primary without renewing observation time", () => {
  const f = fixture(), projection = createStandingHistoryTaskContextProjection({ binding, references: f.references, scopeRef, signal: f.controller.signal });
  try {
    const observation = projection.capture({ intent: intent(), status: status(id(1)), observedAt: asOf });
    const nextPrimary = { ...primary, messageId: 1001, text: "Next request" };
    const result = projection.issue({ primary: nextPrimary, asOf: asOf + 100, observations: [observation] });
    assert.equal(result.source.items[0]!.observedAt, asOf);
    assert.equal(result.source.coverage.freshness, "stale"); assert.equal(result.scan.completeTraversal, false);
    assert.equal(requireStandingHistoryTaskContext(result, nextPrimary, f.references, { scopeRef, asOf: asOf + 100 }), result);
    assert.throws(() => requireStandingHistoryTaskContext(result, primary, f.references));
    assert.throws(() => projection.issue({ primary: nextPrimary, asOf: asOf + 100, observations: [{ ...observation }] }));
    assert.throws(() => projection.issue({ primary: { ...nextPrimary, ownerId: "456" }, asOf: asOf + 100, observations: [observation] }));
    projection.close(); assert.throws(() => requireStandingHistoryTaskContext(result, nextPrimary, f.references));
  } finally { projection.close(); f.references.close(); }
});
test("passive invalidation retains purpose and source identity with new unknown status version", () => {
  const f = fixture(), projection = createStandingHistoryTaskContextProjection({ binding, references: f.references, scopeRef, signal: f.controller.signal });
  try {
    const observed = projection.capture({ intent: intent(), status: status(id(1)), observedAt: asOf });
    const before = projection.issue({ primary, asOf, observations: [observed] }).source.items[0]!;
    const invalidated = projection.invalidate(observed), result = projection.issue({ primary, asOf: asOf + 1, observations: [invalidated] });
    assert.equal(projection.invalidate(invalidated), invalidated);
    const after = result.source.items[0]!;
    assert.deepEqual(after.description, before.description); assert.equal(after.sourceRef, before.sourceRef); assert.equal(after.observedAt, before.observedAt);
    assert.notEqual(after.versionRef, before.versionRef); assert.equal(after.control, "unavailable"); assert.equal(after.outputPrepared, "unavailable");
    assert.equal(result.source.coverage.freshness, "unknown");
  } finally { projection.close(); f.references.close(); }
});
