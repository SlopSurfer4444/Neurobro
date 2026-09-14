import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStandingHistoryTaskRequest, assertStandingHistoryTaskRequestMatches } from "../src/standing-history-task-request.js";
import { openStandingHistoryTaskStore } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskDiscovery } from "../src/standing-history-task-discovery.js";

const input = () => ({ identityKey: "a".repeat(64), binding: { accountId: "123", peerId: "-100456" },
  primary: { chatId: "-100456", ownerId: "789", messageId: 101, text: "ПРОМПТ summarize our chat" },
  request: { fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize this period" } });

test("same selected request discovers and reopens the actual persisted intent after losing local state", async () => {
  const directory = join(await mkdtemp(join(resolve(tmpdir()), "neurobro-request-test-")), "tasks");
  await mkdir(directory);
  const passphrase = "synthetic-request-passphrase";
  const first = createStandingHistoryTaskRequest(input());
  const store = await openStandingHistoryTaskStore({ directory, passphrase, intent: first, mode: "create" });
  await store.close();
  const discovery = await openStandingHistoryTaskDiscovery({ directory, passphrase, accountId: "123", chatId: "-100456" });
  try {
    const page = await discovery.find();
    assert.equal(page.tasks.length, 1);
    const next = createStandingHistoryTaskRequest(input());
    assertStandingHistoryTaskRequestMatches(page.tasks[0]!, next);
    const reopened = await openStandingHistoryTaskStore({ directory, passphrase, intent: next, mode: "open" });
    try { assert.equal((await reopened.status()).readProgress.committedPages, 0); }
    finally { await reopened.close(); }
    const changed = input(); changed.request.objective = "Different objective";
    const conflicting = createStandingHistoryTaskRequest(changed);
    assert.equal(conflicting.taskId, next.taskId);
    assert.throws(() => assertStandingHistoryTaskRequestMatches(page.tasks[0]!, conflicting), /CONFLICT/);
    await assert.rejects(openStandingHistoryTaskStore({ directory, passphrase, intent: conflicting, mode: "open" }));
  } finally { await discovery.close(); }
});

test("identity isolates primary, requester, binding and key but not mutable arguments", () => {
  const original = createStandingHistoryTaskRequest(input());
  assert.equal(JSON.stringify(original).includes("ПРОМПТ"), false);
  const differentText = input(); differentText.primary.text = "Edited message";
  assert.deepEqual(createStandingHistoryTaskRequest(differentText), original);
  for (const edit of [(v: ReturnType<typeof input>) => { v.primary.messageId++; },
    (v: ReturnType<typeof input>) => { v.primary.ownerId = "790"; },
    (v: ReturnType<typeof input>) => { v.binding.accountId = "124"; },
    (v: ReturnType<typeof input>) => { v.binding.peerId = v.primary.chatId = "-100457"; },
    (v: ReturnType<typeof input>) => { v.identityKey = "b".repeat(64); }]) {
    const v = input(); edit(v); assert.notEqual(createStandingHistoryTaskRequest(v).taskId, original.taskId);
  }
  const changed = input(); changed.request.fromDate++;
  assert.equal(createStandingHistoryTaskRequest(changed).taskId, original.taskId);
  assert.throws(() => assertStandingHistoryTaskRequestMatches(original, createStandingHistoryTaskRequest(changed)), /CONFLICT/);
});

test("host binding and inert exact model fields cannot be overridden", () => {
  const foreign = input(); foreign.primary.chatId = "-100457";
  assert.throws(() => createStandingHistoryTaskRequest(foreign));
  const self = input(); self.primary.ownerId = self.binding.accountId;
  assert.throws(() => createStandingHistoryTaskRequest(self));
  let invoked = false;
  const getter = input(); Object.defineProperty(getter.request, "objective", { get() { invoked = true; return "x"; }, enumerable: true });
  assert.throws(() => createStandingHistoryTaskRequest(getter)); assert.equal(invoked, false);
  const extra = input(); Object.assign(extra.request, { chatId: "-100999" });
  assert.throws(() => createStandingHistoryTaskRequest(extra));
  const proxy = new Proxy(input(), { get() { invoked = true; throw new Error("unexpected"); } });
  assert.throws(() => createStandingHistoryTaskRequest(proxy)); assert.equal(invoked, false);
});
