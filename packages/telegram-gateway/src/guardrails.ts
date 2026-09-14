import type { LimitConfig } from "./types.js";
import { classifyTelegramError, GuardrailStopError } from "./errors.js";
import { StateStore } from "./state-store.js";

export interface GuardrailClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  random(): number;
}

const systemClock: GuardrailClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

function newestRetryAt(timestamps: number[], windowMs: number): Date {
  const oldest = Math.min(...timestamps);
  return new Date(oldest + windowMs + 1);
}

export class GuardedExecutor {
  constructor(
    private readonly limits: LimitConfig,
    private readonly store: StateStore,
    private readonly clock: GuardrailClock = systemClock,
  ) {}

  private async beforeRequest(method: string): Promise<void> {
    const state = await this.store.load();
    const now = this.clock.now();
    const nowMs = now.getTime();
    if (state.cooldownUntil && Date.parse(state.cooldownUntil) > nowMs) {
      const retryAt = new Date(state.cooldownUntil);
      throw new GuardrailStopError(
        `Persistent Telegram cooldown is active for ${method} until ${retryAt.toISOString()}.`,
        "COOLDOWN_ACTIVE",
        retryAt,
      );
    }
    if (state.circuitBreaker.openUntil && Date.parse(state.circuitBreaker.openUntil) > nowMs) {
      const retryAt = new Date(state.circuitBreaker.openUntil);
      throw new GuardrailStopError(
        `Circuit breaker is open for ${method} until ${retryAt.toISOString()}.`,
        "CIRCUIT_OPEN",
        retryAt,
      );
    }

    const dayMs = 24 * 60 * 60 * 1000;
    const parsed = state.requestTimestamps
      .map((timestamp) => Date.parse(timestamp))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > nowMs - dayMs);
    const windows: Array<[number, number, string]> = [
      [60_000, this.limits.maxRequestsPerMinute, "minute"],
      [3_600_000, this.limits.maxRequestsPerHour, "hour"],
      [dayMs, this.limits.maxRequestsPerRollingDay, "rolling day"],
    ];
    for (const [windowMs, maximum, label] of windows) {
      const inWindow = parsed.filter((timestamp) => timestamp > nowMs - windowMs);
      if (inWindow.length >= maximum) {
        const retryAt = newestRetryAt(inWindow, windowMs);
        throw new GuardrailStopError(
          `Request budget for the ${label} is exhausted before ${method}.`,
          "REQUEST_BUDGET_EXHAUSTED",
          retryAt,
        );
      }
    }

    if (state.lastRequestAt) {
      const waitMs = Date.parse(state.lastRequestAt) + this.limits.minRequestIntervalMs - nowMs;
      if (waitMs > 0) await this.clock.sleep(waitMs);
    }
    const issuedAt = this.clock.now().toISOString();
    state.requestTimestamps = [...parsed.map((timestamp) => new Date(timestamp).toISOString()), issuedAt];
    state.lastRequestAt = issuedAt;
    await this.store.save();
  }

  async execute<T>(method: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await this.beforeRequest(method);
      try {
        const result = await operation();
        const state = await this.store.load();
        if (state.circuitBreaker.consecutiveTransientFailures !== 0 || state.circuitBreaker.openUntil) {
          state.circuitBreaker = { consecutiveTransientFailures: 0 };
          await this.store.save();
        }
        return result;
      } catch (error) {
        if (error instanceof GuardrailStopError) throw error;
        const classified = classifyTelegramError(error);
        const state = await this.store.load();

        if (classified.kind === "flood") {
          const seconds = classified.floodSeconds ?? 3600;
          const retryAt = new Date(
            this.clock.now().getTime() + (seconds + this.limits.floodWaitSafetySeconds) * 1000,
          );
          state.cooldownUntil = retryAt.toISOString();
          state.cooldownReason = `Telegram FLOOD_WAIT on ${method}; server wait=${seconds}s.`;
          await this.store.save();
          throw new GuardrailStopError(
            `Telegram FLOOD_WAIT on ${method}; no retry before ${retryAt.toISOString()}.`,
            "FLOOD_WAIT",
            retryAt,
          );
        }

        if (classified.kind !== "transient") {
          throw new GuardrailStopError(
            `${classified.message} Method=${method}; automatic retry is disabled.`,
            classified.kind === "fatal" ? "TELEGRAM_FATAL" : "TELEGRAM_NON_RETRYABLE",
          );
        }

        state.circuitBreaker.consecutiveTransientFailures += 1;
        if (state.circuitBreaker.consecutiveTransientFailures >= this.limits.circuitBreakerFailures) {
          const retryAt = new Date(
            this.clock.now().getTime() + this.limits.circuitBreakerCooldownSeconds * 1000,
          );
          state.circuitBreaker.openUntil = retryAt.toISOString();
          await this.store.save();
          throw new GuardrailStopError(
            `Circuit breaker opened after transient failures on ${method}.`,
            "CIRCUIT_OPENED",
            retryAt,
          );
        }
        await this.store.save();
        if (attempt >= this.limits.maxTransientRetries) {
          throw new GuardrailStopError(
            `Transient retry limit reached for ${method}.`,
            "TRANSIENT_RETRY_LIMIT",
          );
        }

        const cap = Math.min(this.limits.retryMaxMs, this.limits.retryBaseMs * 2 ** attempt);
        const delay = Math.max(1, Math.floor(this.clock.random() * cap));
        await this.clock.sleep(delay);
      }
    }
  }
}
