import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Api } from "telegram";
import { createReadOnlyGatewayApi, type ReadOnlyGatewayApi } from "../src/api/index.js";
import { createReadOnlyGatewayOwner } from "../src/api/adapter.js";
import type { LimitConfig, ResolvedSource } from "../src/types.js";

const limits: LimitConfig = {
  dialogDiscoveryLimit: 100,
  historyPageSize: 2,
  maxPagesPerSourcePerRun: 4,
  maxMessagesPerSourcePerRun: 200,
  maxSources: 10,
  lookbackDays: 14,
  maxRequestsPerMinute: 6,
  maxRequestsPerHour: 60,
  maxRequestsPerRollingDay: 300,
  minRequestIntervalMs: 2500,
  maxTransientRetries: 2,
  retryBaseMs: 2000,
  retryMaxMs: 30000,
  floodWaitSafetySeconds: 30,
  circuitBreakerFailures: 3,
  circuitBreakerCooldownSeconds: 900,
  liveBufferSize: 1000,
};

const source: ResolvedSource = {
  source: { id: "allowed", peerId: "-1001", enabled: true, initialBackfillMessages: 0, includeText: true },
  peer: {} as Api.TypeInputPeer,
  title: "Allowed chat",
};

test("public API exposes only typed read methods and no raw client", async () => {
  const calls: unknown[] = [];
  const client = {
    async *iterMessages(peer: unknown, options: unknown) {
      calls.push({ peer, options });
      yield new Api.Message({ id: 7, date: 1786492800, message: "fixture" });
    },
  };
  const guard = { execute: async <T>(_method: string, operation: () => Promise<T>): Promise<T> => operation() };
  const owner = createReadOnlyGatewayOwner({ limits }, client as never, guard as never, [source]);
  const api: ReadOnlyGatewayApi = createReadOnlyGatewayApi(owner);

  assert.deepEqual(Object.keys(api).sort(), ["getRecentMessages", "listSources"]);
  assert.deepEqual(api.listSources(), [{ id: "allowed", peerId: "-1001", title: "Allowed chat" }]);
  assert.deepEqual(await api.getRecentMessages("allowed", 1), [{
    schemaVersion: 1, sourceId: "allowed", peerId: "-1001", messageId: 7,
    date: "2026-08-12T00:00:00.000Z", text: "fixture", untrustedInput: true,
  }]);
  assert.equal(calls.length, 1);
  assert.equal("client" in api, false);
  assert.equal("sendMessage" in api, false);
});

test("API preserves allowlist and bounded history requests without creating a client", async () => {
  let iterated = false;
  const client = { async *iterMessages() { iterated = true; } };
  const guard = { execute: async <T>(_method: string, operation: () => Promise<T>): Promise<T> => operation() };
  const owner = createReadOnlyGatewayOwner({ limits }, client as never, guard as never, [source]);
  const api = createReadOnlyGatewayApi(owner);

  await assert.rejects(api.getRecentMessages("other", 1), /not allowlisted/);
  await assert.rejects(api.getRecentMessages("allowed", 3), /integer from 1 to 2/);
  assert.equal(iterated, false);
});

test("public entrypoint has no write methods or TelegramClient export", async () => {
  const entrypoint = await readFile(path.resolve(import.meta.dirname, "../../src/api/index.ts"), "utf8");
  assert.doesNotMatch(entrypoint, /TelegramClient|send|reply|react|delete|execute/i);
});
