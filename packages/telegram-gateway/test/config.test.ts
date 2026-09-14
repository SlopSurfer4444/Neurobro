import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: "read-only",
    compliance: {
      purpose: "personal-archive",
      ownOrAuthorizedChatsOnly: true,
      noAiMlTrainingDevelopmentOrDeployment: true,
      acceptedTelegramApiTerms: true,
    },
    account: {
      apiIdEnv: "TG_API_ID",
      apiHashEnv: "TG_API_HASH",
      sessionPassphraseEnv: "TG_SESSION_PASSPHRASE",
      sessionFile: "./data/session.enc",
    },
    sources: [
      {
        id: "allowed-source",
        peerId: "-1001234567890",
        enabled: true,
        initialBackfillMessages: 10,
        includeText: true,
      },
    ],
    output: {
      directory: "./data/export",
      exportPassphraseEnv: "TG_EXPORT_PASSPHRASE",
      retentionDays: 7,
    },
    stateFile: "./data/state.json",
    lockFile: "./data/ingestor.lock",
    limits: {
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
    },
  };
}

test("accepts an explicit read-only numeric allowlist", () => {
  const config = parseConfig(validConfig(), "C:/safe/config.json");
  assert.equal(config.mode, "read-only");
  assert.equal(config.sources[0]?.peerId, "-1001234567890");
});

test("fails closed until Telegram compliance acknowledgements are explicit", () => {
  const raw = validConfig();
  (raw.compliance as Record<string, unknown>).acceptedTelegramApiTerms = false;
  assert.throws(() => parseConfig(raw, "config.json"), /must be explicitly true/);
});

test("rejects usernames and wildcard source resolution", () => {
  const raw = validConfig();
  ((raw.sources as Array<Record<string, unknown>>)[0] as Record<string, unknown>).peerId = "@someone";
  assert.throws(() => parseConfig(raw, "config.json"), /numeric Telegram peer ID/);
});

test("requires bounded encrypted-export retention", () => {
  const raw = validConfig();
  (raw.output as Record<string, unknown>).retentionDays = 31;
  assert.throws(() => parseConfig(raw, "config.json"), /output.retentionDays/);
});
