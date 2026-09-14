import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuardedExecutor, type GuardrailClock } from "../src/guardrails.js";
import { StateStore } from "../src/state-store.js";
import type { LimitConfig } from "../src/types.js";
import { GuardrailStopError } from "../src/errors.js";

const limits: LimitConfig = {
  dialogDiscoveryLimit: 100,
  historyPageSize: 50,
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

class FakeClock implements GuardrailClock {
  current = new Date("2026-08-07T10:00:00.000Z");
  now(): Date {
    return new Date(this.current);
  }
  async sleep(ms: number): Promise<void> {
    this.current = new Date(this.current.getTime() + ms);
  }
  random(): number {
    return 0.5;
  }
}

async function fixture(): Promise<{ guard: GuardedExecutor; store: StateStore; clock: FakeClock }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-guard-test-"));
  const store = new StateStore(path.join(directory, "state.json"));
  const clock = new FakeClock();
  return { guard: new GuardedExecutor(limits, store, clock), store, clock };
}

test("persists FLOOD_WAIT plus safety margin and never immediately retries it", async () => {
  const { guard, store } = await fixture();
  let calls = 0;
  await assert.rejects(
    guard.execute("messages.getHistory", async () => {
      calls += 1;
      throw { code: 420, errorMessage: "FLOOD_WAIT_10", seconds: 10 };
    }),
    (error: unknown) => error instanceof GuardrailStopError && error.code === "FLOOD_WAIT",
  );
  assert.equal(calls, 1);
  const state = await store.load();
  assert.equal(state.cooldownUntil, "2026-08-07T10:00:40.000Z");
});

test("retries only bounded transient failures with backoff", async () => {
  const { guard } = await fixture();
  let calls = 0;
  const result = await guard.execute("messages.getHistory", async () => {
    calls += 1;
    if (calls < 3) throw { code: 500, errorMessage: "INTERNAL" };
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("does not retry privacy or authorization failures", async () => {
  const { guard } = await fixture();
  let calls = 0;
  await assert.rejects(
    guard.execute("messages.getHistory", async () => {
      calls += 1;
      throw { code: 401, errorMessage: "SESSION_REVOKED" };
    }),
    (error: unknown) => error instanceof GuardrailStopError && error.code === "TELEGRAM_FATAL",
  );
  assert.equal(calls, 1);
});
