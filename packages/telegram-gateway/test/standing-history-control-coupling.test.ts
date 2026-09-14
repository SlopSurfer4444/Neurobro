import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createStandingHistoryTaskRequest, assertStandingHistoryTaskRequestMatches } from "../src/standing-history-task-request.js";
import { openStandingHistoryTaskStore } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskDiscovery } from "../src/standing-history-task-discovery.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";

test("cancelled real persisted request remains cancelled after discovery/reopen and cannot be recreated", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-control-coupling-"));
  const pages = join(root, "pages"), controls = join(root, "controls");
  await mkdir(pages); await mkdir(controls);
  const passphrase = "synthetic-control-coupling-passphrase";
  const makeRequest = () => createStandingHistoryTaskRequest({ identityKey: "a".repeat(64),
    binding: { accountId: "123", peerId: "-100456" },
    primary: { chatId: "-100456", ownerId: "789", messageId: 123, text: "ПРОМПТ summarize history" },
    request: { fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize history" } });
  const intent = makeRequest();
  const pageStore = await openStandingHistoryTaskStore({ directory: pages, passphrase, intent, mode: "create" });
  await pageStore.close();
  const initial = await openStandingHistoryTaskControlStore({ directory: controls, passphrase, intent, mode: "create" });
  try {
    assert.equal((await initial.status()).state, "queued");
    assert.equal((await initial.cancel({ expectedRevision: 0 })).state, "cancelled");
  } finally { await initial.close(); }
  const cancellationPath = join(controls, intent.taskId, "cancel-000001.enc");
  const originalBytes = await readFile(cancellationPath);
  const discovery = await openStandingHistoryTaskDiscovery({ directory: pages, passphrase, accountId: "123", chatId: "-100456" });
  try {
    const found = await discovery.find(); assert.equal(found.tasks.length, 1);
    const restored = found.tasks[0]!; assertStandingHistoryTaskRequestMatches(restored, makeRequest());
    const reopened = await openStandingHistoryTaskControlStore({ directory: controls, passphrase, intent: restored, mode: "open" });
    try {
      const status = await reopened.status();
      assert.equal(status.storage, "ready"); assert.equal(status.state, "cancelled"); assert.equal(status.revision, 1);
      assert.deepEqual(await reopened.cancel({ expectedRevision: 0 }), status);
      assert.deepEqual(await reopened.cancel({ expectedRevision: 1 }), status);
    } finally { await reopened.close(); }
    await assert.rejects(openStandingHistoryTaskControlStore({ directory: controls, passphrase, intent: makeRequest(), mode: "create" }));
    assert.deepEqual(await readFile(cancellationPath), originalBytes);
    const source = await openStandingHistoryTaskStore({ directory: pages, passphrase, intent: restored, mode: "open" });
    try { assert.equal((await source.status()).readProgress.committedPages, 0); }
    finally { await source.close(); }
  } finally { await discovery.close(); }
});
