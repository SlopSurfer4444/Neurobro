import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, CompliancePurpose, LimitConfig, SourceConfig } from "./types.js";

const PURPOSES = new Set<CompliancePurpose>([
  "personal-archive",
  "authorized-research",
  "moderation-export",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value as number;
}

function exactTrue(value: unknown, label: string): true {
  if (value !== true) {
    throw new Error(`${label} must be explicitly true.`);
  }
  return true;
}

function parseLimits(raw: unknown): LimitConfig {
  const value = object(raw, "limits");
  return {
    dialogDiscoveryLimit: integer(value.dialogDiscoveryLimit, "limits.dialogDiscoveryLimit", 1, 100),
    historyPageSize: integer(value.historyPageSize, "limits.historyPageSize", 1, 100),
    maxPagesPerSourcePerRun: integer(
      value.maxPagesPerSourcePerRun,
      "limits.maxPagesPerSourcePerRun",
      1,
      10,
    ),
    maxMessagesPerSourcePerRun: integer(
      value.maxMessagesPerSourcePerRun,
      "limits.maxMessagesPerSourcePerRun",
      1,
      500,
    ),
    maxSources: integer(value.maxSources, "limits.maxSources", 1, 20),
    lookbackDays: integer(value.lookbackDays, "limits.lookbackDays", 1, 365),
    maxRequestsPerMinute: integer(value.maxRequestsPerMinute, "limits.maxRequestsPerMinute", 1, 30),
    maxRequestsPerHour: integer(value.maxRequestsPerHour, "limits.maxRequestsPerHour", 1, 500),
    maxRequestsPerRollingDay: integer(
      value.maxRequestsPerRollingDay,
      "limits.maxRequestsPerRollingDay",
      1,
      5000,
    ),
    minRequestIntervalMs: integer(value.minRequestIntervalMs, "limits.minRequestIntervalMs", 1000, 60000),
    maxTransientRetries: integer(value.maxTransientRetries, "limits.maxTransientRetries", 0, 3),
    retryBaseMs: integer(value.retryBaseMs, "limits.retryBaseMs", 500, 60000),
    retryMaxMs: integer(value.retryMaxMs, "limits.retryMaxMs", 1000, 300000),
    floodWaitSafetySeconds: integer(
      value.floodWaitSafetySeconds,
      "limits.floodWaitSafetySeconds",
      5,
      600,
    ),
    circuitBreakerFailures: integer(
      value.circuitBreakerFailures,
      "limits.circuitBreakerFailures",
      1,
      10,
    ),
    circuitBreakerCooldownSeconds: integer(
      value.circuitBreakerCooldownSeconds,
      "limits.circuitBreakerCooldownSeconds",
      60,
      86400,
    ),
    liveBufferSize: integer(value.liveBufferSize, "limits.liveBufferSize", 10, 10000),
  };
}

function parseSources(raw: unknown, maxSources: number): SourceConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error("sources must be an array.");
  }
  if (raw.length > maxSources) {
    throw new Error(`sources contains ${raw.length} entries; maximum is ${maxSources}.`);
  }

  const ids = new Set<string>();
  const peers = new Set<string>();
  return raw.map((entry, index) => {
    const value = object(entry, `sources[${index}]`);
    const id = string(value.id, `sources[${index}].id`);
    const peerId = string(value.peerId, `sources[${index}].peerId`);
    if (!/^-?\d+$/.test(peerId) || peerId === "0") {
      throw new Error(`sources[${index}].peerId must be a non-zero numeric Telegram peer ID.`);
    }
    if (peerId.includes("*") || id.includes("*")) {
      throw new Error("Wildcards are forbidden in source allowlists.");
    }
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
      throw new Error(`sources[${index}].id must be a filesystem-safe stable identifier.`);
    }
    if (ids.has(id) || peers.has(peerId)) {
      throw new Error(`Duplicate source id or peerId at sources[${index}].`);
    }
    ids.add(id);
    peers.add(peerId);
    if (typeof value.enabled !== "boolean" || typeof value.includeText !== "boolean") {
      throw new Error(`sources[${index}] enabled/includeText must be booleans.`);
    }
    return {
      id,
      peerId,
      enabled: value.enabled,
      includeText: value.includeText,
      initialBackfillMessages: integer(
        value.initialBackfillMessages,
        `sources[${index}].initialBackfillMessages`,
        0,
        100,
      ),
    };
  });
}

export function parseConfig(raw: unknown, configPath: string): AppConfig {
  const value = object(raw, "config");
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1.");
  if (value.mode !== "read-only") throw new Error('mode must be exactly "read-only".');

  const compliance = object(value.compliance, "compliance");
  const purpose = string(compliance.purpose, "compliance.purpose") as CompliancePurpose;
  if (!PURPOSES.has(purpose)) throw new Error(`Unsupported compliance purpose: ${purpose}.`);

  const account = object(value.account, "account");
  const output = object(value.output, "output");
  const limits = parseLimits(value.limits);
  if (limits.maxMessagesPerSourcePerRun > limits.historyPageSize * limits.maxPagesPerSourcePerRun) {
    throw new Error(
      "limits.maxMessagesPerSourcePerRun cannot exceed historyPageSize * maxPagesPerSourcePerRun.",
    );
  }

  const absoluteConfigPath = path.resolve(configPath);
  const base = path.dirname(absoluteConfigPath);
  return {
    schemaVersion: 1,
    mode: "read-only",
    compliance: {
      purpose,
      ownOrAuthorizedChatsOnly: exactTrue(
        compliance.ownOrAuthorizedChatsOnly,
        "compliance.ownOrAuthorizedChatsOnly",
      ),
      noAiMlTrainingDevelopmentOrDeployment: exactTrue(
        compliance.noAiMlTrainingDevelopmentOrDeployment,
        "compliance.noAiMlTrainingDevelopmentOrDeployment",
      ),
      acceptedTelegramApiTerms: exactTrue(
        compliance.acceptedTelegramApiTerms,
        "compliance.acceptedTelegramApiTerms",
      ),
    },
    account: {
      apiIdEnv: string(account.apiIdEnv, "account.apiIdEnv"),
      apiHashEnv: string(account.apiHashEnv, "account.apiHashEnv"),
      sessionPassphraseEnv: string(account.sessionPassphraseEnv, "account.sessionPassphraseEnv"),
      sessionFile: path.resolve(base, string(account.sessionFile, "account.sessionFile")),
    },
    sources: parseSources(value.sources, limits.maxSources),
    output: {
      directory: path.resolve(base, string(output.directory, "output.directory")),
      exportPassphraseEnv: string(output.exportPassphraseEnv, "output.exportPassphraseEnv"),
      retentionDays: integer(output.retentionDays, "output.retentionDays", 1, 30),
    },
    stateFile: path.resolve(base, string(value.stateFile, "stateFile")),
    lockFile: path.resolve(base, string(value.lockFile, "lockFile")),
    limits,
    configPath: absoluteConfigPath,
  };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  return parseConfig(raw, configPath);
}

export function readApiCredentials(config: AppConfig): { apiId: number; apiHash: string } {
  const apiIdRaw = process.env[config.account.apiIdEnv];
  const apiHash = process.env[config.account.apiHashEnv];
  const apiId = Number(apiIdRaw);
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error(`Environment variable ${config.account.apiIdEnv} must contain a positive api_id.`);
  }
  if (!apiHash || !/^[a-fA-F0-9]{32}$/.test(apiHash)) {
    throw new Error(`Environment variable ${config.account.apiHashEnv} must contain a 32-character api_hash.`);
  }
  return { apiId, apiHash };
}
