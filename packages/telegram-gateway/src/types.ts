import type { Api } from "telegram";

export type CompliancePurpose =
  | "personal-archive"
  | "authorized-research"
  | "moderation-export";

export interface SourceConfig {
  id: string;
  peerId: string;
  enabled: boolean;
  initialBackfillMessages: number;
  includeText: boolean;
}

export interface LimitConfig {
  dialogDiscoveryLimit: number;
  historyPageSize: number;
  maxPagesPerSourcePerRun: number;
  maxMessagesPerSourcePerRun: number;
  maxSources: number;
  lookbackDays: number;
  maxRequestsPerMinute: number;
  maxRequestsPerHour: number;
  maxRequestsPerRollingDay: number;
  minRequestIntervalMs: number;
  maxTransientRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  floodWaitSafetySeconds: number;
  circuitBreakerFailures: number;
  circuitBreakerCooldownSeconds: number;
  liveBufferSize: number;
}

export interface AppConfig {
  schemaVersion: 1;
  mode: "read-only";
  compliance: {
    purpose: CompliancePurpose;
    ownOrAuthorizedChatsOnly: true;
    noAiMlTrainingDevelopmentOrDeployment: true;
    acceptedTelegramApiTerms: true;
  };
  account: {
    apiIdEnv: string;
    apiHashEnv: string;
    sessionPassphraseEnv: string;
    sessionFile: string;
  };
  sources: SourceConfig[];
  output: {
    directory: string;
    exportPassphraseEnv: string;
    retentionDays: number;
  };
  stateFile: string;
  lockFile: string;
  limits: LimitConfig;
  configPath: string;
}

export interface CursorState {
  lastMessageId: number;
  lastSyncedAt: string;
}

export interface PersistentState {
  schemaVersion: 1;
  cursors: Record<string, CursorState>;
  requestTimestamps: string[];
  lastRequestAt?: string;
  cooldownUntil?: string;
  cooldownReason?: string;
  circuitBreaker: {
    consecutiveTransientFailures: number;
    openUntil?: string;
  };
}

export interface ResolvedSource {
  source: SourceConfig;
  peer: Api.TypeInputPeer;
  title: string;
}

export interface ExportedMessage {
  schemaVersion: 1;
  sourceId: string;
  peerId: string;
  messageId: number;
  date: string;
  editDate?: string;
  senderId?: string;
  text?: string;
  mediaType?: string;
  replyToMessageId?: number;
  groupedId?: string;
  untrustedInput: true;
}

export interface DialogSummary {
  peerId: string;
  title: string;
  kind: "user" | "group" | "channel" | "unknown";
  peer: Api.TypeInputPeer;
}
