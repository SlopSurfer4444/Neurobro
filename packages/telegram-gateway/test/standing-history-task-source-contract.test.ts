import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decryptSession } from "../src/session-crypto.js";
import { createStandingHistoryTaskRequest, assertStandingHistoryTaskRequestMatches } from "../src/standing-history-task-request.js";
import { openStandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { createStandingHistoryTaskRuntime } from "../src/standing-history-task-runtime.js";
import { HISTORY_TASK_TOOL_SPECS, parseStandingHistoryTaskTool } from "../src/standing-history-task-tools.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskPage, snapshotStandingHistoryTaskObservedSource,
  standingHistoryTaskSourcePeerId, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";

const binding = { accountId: "123", peerId: "-100456" };
const primary = { chatId: binding.peerId, ownerId: "789", messageId: 101, text: "private initiating text" };
const request = { fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize the available month" };
const source = { kind: "observed-source" as const, sourceRef: "community" as const, workspaceId: "community-team", peerId: "-100999" };
const identityKey = "a".repeat(64);

async function directory(t: TestContext, prefix: string) {
  const root = await mkdtemp(join(resolve(tmpdir()), prefix));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), prefix))); await rm(root, { recursive: true, force: true }); });
  return root;
}
function task(sourceValue?: typeof source): StandingHistoryTaskIntent {
  return createStandingHistoryTaskRequest({ identityKey, binding, primary, request, ...(sourceValue ? { source: sourceValue } : {}) });
}
function page(before: SelfHistoryTaskCheckpoint, authorId: string, text: string): SelfHistoryTaskPage {
  const messageId = 100, date = 199, ref = "m_" + "1".repeat(24);
  const next = { ...before, offsetId: messageId, lastDate: date, oldestDate: date, newestDate: date, pages: 1, upperBoundMessageId: messageId };
  return { beforeCheckpoint: before, nextCheckpoint: next,
    sources: [{ messageId, date, disposition: "included", messageRef: ref, authorId }],
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: [{ ref, authorRef: "a_" + "2".repeat(24), author: "user", displayName: "Channel or anonymous administrator",
        date, editedAt: null, replyRef: null, replyUnavailable: false, text }], cursor: null, hasMore: true, status: "more",
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: date, newestExaminedDate: date, traversalComplete: false, undatedEntries: 0, pages: 1 },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}

test("optional observed source preserves legacy canonical intent and conflicts under the same stable task identity", () => {
  const legacy = task(), observed = task(source);
  assert.equal(observed.taskId, legacy.taskId);
  assert.deepEqual(Object.keys(legacy), ["schema", "taskId", "accountId", "chatId", "requesterId", "primaryMessageId", "fromDate", "toDate", "timezone", "objective"]);
  assert.equal(Object.hasOwn(legacy, "source"), false);
  assert.deepEqual(observed.source, source);
  assert.equal(standingHistoryTaskSourcePeerId(legacy), binding.peerId);
  assert.equal(standingHistoryTaskSourcePeerId(observed), source.peerId);
  assert.throws(() => assertStandingHistoryTaskRequestMatches(legacy, observed), /CONFLICT/u);
  assert.deepEqual(snapshotStandingHistoryTaskObservedSource(source), source);
  for (const bad of [{ ...source, workspaceId: "Other Workspace" }, { ...source, peerId: binding.accountId }, { ...source, sourceRef: "internal" }, { ...source, extra: true }])
    assert.throws(() => snapshotStandingHistoryTaskObservedSource(bad));
});

test("source checkpoint, signed channel author and 4096-codepoint text survive encrypted reopen", async t => {
  const root = await directory(t, "neurobro-history-source-");
  const intent = task(source), args = { directory: root, passphrase: "synthetic-source-store-passphrase", intent };
  let store = await openStandingHistoryTaskStore({ ...args, mode: "create" });
  const before = (await store.status()).readProgress.checkpoint;
  assert.equal(before.chatId, source.peerId);
  const full = "😀".repeat(4096), result = structuredClone(page(before, source.peerId, full));
  (result.page.messages[0] as unknown as { forwarded: unknown }).forwarded =
    { originalDate: 150, sourceName: "Original public channel", interpretation: "quoted-source-not-request" };
  assert.equal(Buffer.byteLength(full), 16384);
  assert.deepEqual(snapshotStandingHistoryTaskPage(result, intent), result);
  assert.throws(() => snapshotStandingHistoryTaskPage(result, task()), /BINDING/u);
  for (const forwarded of [
    { originalDate: 0, sourceName: "Channel", interpretation: "quoted-source-not-request" },
    { originalDate: 150, sourceName: "", interpretation: "quoted-source-not-request" },
    { originalDate: 150, sourceName: "😀".repeat(33), interpretation: "quoted-source-not-request" },
    { originalDate: 150, sourceName: "Channel", interpretation: "request" },
    { originalDate: 150, sourceName: "Channel", interpretation: "quoted-source-not-request", originalId: "private" }
  ]) {
    const changed = structuredClone(result); (changed.page.messages[0] as unknown as { forwarded: unknown }).forwarded = forwarded;
    assert.throws(() => snapshotStandingHistoryTaskPage(changed, intent));
  }
  let invoked = 0; const hostile = structuredClone(result);
  Object.defineProperty(hostile.page.messages[0]!, "forwarded", { enumerable: true, get() { invoked++; return undefined; } });
  assert.throws(() => snapshotStandingHistoryTaskPage(hostile, intent)); assert.equal(invoked, 0);
  await store.appendPage({ expectedCheckpoint: before, result }); await store.close();
  store = await openStandingHistoryTaskStore({ ...args, mode: "open" });
  assert.equal((await store.status()).readProgress.checkpoint.chatId, source.peerId);
  assert.equal((await store.readPage(1))!.result.page.messages[0]!.text, full);
  assert.deepEqual(((await store.readPage(1))!.result.page.messages[0] as unknown as { forwarded: unknown }).forwarded,
    { originalDate: 150, sourceName: "Original public channel", interpretation: "quoted-source-not-request" });
  await store.close();
  await assert.rejects(openStandingHistoryTaskStore({ ...args, intent: task(), mode: "open" }));
});

test("manager maps only the community selector and runtime exposes no host source binding", async t => {
  const root = await directory(t, "neurobro-history-source-manager-");
  const directories = { control: join(root, "control"), pages: join(root, "pages"), analysis: join(root, "analysis") };
  for (const value of Object.values(directories)) await mkdir(value);
  const passphrase = "synthetic-source-manager-passphrase";
  let cancellations = 0;
  const openManager = (configured: boolean) => openStandingHistoryTaskManager({ directories, passphrase, binding,
    ...(configured ? { observedSource: source } : {}), async onCancelled() { cancellations++; } });
  let manager = await openManager(true);
  let runtime = createStandingHistoryTaskRuntime({ binding, signal: new AbortController().signal, manager });
  let taskRef = "";
  try {
    runtime.begin({ requestRef: "source-turn", primary });
    const result = await runtime.handlers[0]!.call({ ...request, source: "community" },
      { requestRef: "source-turn", callRef: "create", signal: new AbortController().signal }) as { success: boolean; contentItems: { text: string }[] };
    assert.equal(result.success, true);
    const text = result.contentItems[0]!.text, projected = JSON.parse(text);
    taskRef = projected.taskRef; assert.equal(projected.source, "community");
    for (const privateValue of [source.peerId, source.workspaceId, "observed-source", "peerId", "workspaceId"]) assert.equal(text.includes(privateValue), false);
    const envelope = JSON.parse(await decryptSession(await readFile(join(directories.control, taskRef, "intent.enc"), "utf8"), passphrase));
    assert.deepEqual(envelope.intent.source, source);
  } finally { await runtime.close(); await manager.close(); }

  // Configuration controls future source work. Ownership-bound status and
  // cancellation of an existing source task remain available after removal.
  manager = await openManager(false); runtime = createStandingHistoryTaskRuntime({ binding, signal: new AbortController().signal, manager });
  try {
    runtime.begin({ requestRef: "status-turn", primary });
    const status = await runtime.handlers[1]!.call({ taskRef }, { requestRef: "status-turn", callRef: "status", signal: new AbortController().signal }) as { success: boolean; contentItems: { text: string }[] };
    assert.equal(status.success, true); assert.equal(JSON.parse(status.contentItems[0]!.text).source, "community");
    const conflicting = await runtime.handlers[0]!.call({ ...request, source: "internal" },
      { requestRef: "status-turn", callRef: "conflict", signal: new AbortController().signal }) as { success: boolean };
    assert.equal(conflicting.success, false);
    const cancelled = await runtime.handlers[2]!.call({ taskRef }, { requestRef: "status-turn", callRef: "cancel", signal: new AbortController().signal }) as { success: boolean; contentItems: { text: string }[] };
    assert.equal(cancelled.success, true); assert.equal(JSON.parse(cancelled.contentItems[0]!.text).source, "community"); assert.equal(cancellations, 1);
    await runtime.finish(); runtime.begin({ requestRef: "internal-turn", primary: { ...primary, messageId: 103 } });
    const internal = await runtime.handlers[0]!.call({ ...request, source: "internal" },
      { requestRef: "internal-turn", callRef: "create", signal: new AbortController().signal }) as { success: boolean; contentItems: { text: string }[] };
    assert.equal(internal.success, true); const internalView = JSON.parse(internal.contentItems[0]!.text);
    assert.equal(Object.hasOwn(internalView, "source"), false);
    const internalEnvelope = JSON.parse(await decryptSession(await readFile(join(directories.control, internalView.taskRef, "intent.enc"), "utf8"), passphrase));
    assert.equal(Object.hasOwn(internalEnvelope.intent, "source"), false);
  } finally { await runtime.close(); await manager.close(); }
});

test("tool selector is optional and accepts no raw source identity", () => {
  const name = HISTORY_TASK_TOOL_SPECS[0]!.name;
  assert.deepEqual(parseStandingHistoryTaskTool(name, request), { kind: "create", request });
  assert.deepEqual(parseStandingHistoryTaskTool(name, { ...request, source: "internal" }), { kind: "create", request: { ...request, source: "internal" } });
  assert.deepEqual(parseStandingHistoryTaskTool(name, { ...request, source: "community" }), { kind: "create", request: { ...request, source: "community" } });
  for (const value of [{ ...request, source: null }, { ...request, source: source.peerId }, { ...request, peerId: source.peerId }, { ...request, workspaceId: source.workspaceId }])
    assert.throws(() => parseStandingHistoryTaskTool(name, value));
});
