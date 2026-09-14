export class GuardrailStopError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "GuardrailStopError";
  }
}

export type TelegramErrorKind = "flood" | "transient" | "fatal" | "non-retryable";

export interface ClassifiedTelegramError {
  kind: TelegramErrorKind;
  message: string;
  floodSeconds?: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function classifyTelegramError(error: unknown): ClassifiedTelegramError {
  const candidate = error as {
    code?: number | string;
    errorMessage?: string;
    seconds?: number;
    name?: string;
    message?: string;
  };
  const rpc = `${candidate.errorMessage ?? ""} ${candidate.message ?? errorMessage(error)}`.toUpperCase();
  const floodMatch = /(?:FLOOD_(?:PREMIUM_)?WAIT_|A WAIT OF )(\d+)/.exec(rpc);
  const floodSeconds = Number.isFinite(candidate.seconds)
    ? Math.max(0, Math.trunc(candidate.seconds as number))
    : floodMatch
      ? Number.parseInt(floodMatch[1] ?? "0", 10)
      : undefined;
  if (candidate.code === 420 || floodSeconds !== undefined || rpc.includes("FLOOD_WAIT")) {
    if (rpc.includes("FROZEN_METHOD_INVALID")) {
      return { kind: "fatal", message: "Telegram reports that the account is frozen." };
    }
    return {
      kind: "flood",
      message: "Telegram requested a flood wait.",
      ...(floodSeconds === undefined ? {} : { floodSeconds }),
    };
  }

  if (
    candidate.code === 401 ||
    candidate.code === 403 ||
    candidate.code === 406 ||
    rpc.includes("AUTH_KEY_DUPLICATED") ||
    rpc.includes("SESSION_REVOKED") ||
    rpc.includes("SESSION_EXPIRED") ||
    rpc.includes("USER_DEACTIVATED")
  ) {
    return { kind: "fatal", message: "Telegram authorization/privacy state requires operator action." };
  }

  const networkCode = String(candidate.code ?? "").toUpperCase();
  if (
    (typeof candidate.code === "number" && Math.abs(candidate.code) >= 500) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EAI_AGAIN"].includes(networkCode) ||
    rpc.includes("RPC_CALL_FAIL") ||
    rpc.includes("RPC_MCGET_FAIL") ||
    rpc.includes("TIMEOUT") ||
    rpc.includes("CONNECTION")
  ) {
    return { kind: "transient", message: "Transient Telegram/network failure." };
  }

  return { kind: "non-retryable", message: "Non-retryable Telegram request failure." };
}

export function safeErrorSummary(error: unknown): string {
  const candidate = error as {
    code?: number | string;
    errorMessage?: string;
    name?: string;
    message?: string;
  };
  const summary = candidate.errorMessage ?? candidate.message ?? candidate.code ?? candidate.name ?? "UNKNOWN";
  return String(summary)
    .replace(/[\r\n]/g, " ")
    .replace(/\b[a-fA-F0-9]{32,}\b/g, "[REDACTED_HEX]")
    .replace(/(?:\+?\d[\d\s().-]{8,}\d)/g, "[REDACTED_PHONE]")
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, "[REDACTED_TOKEN]")
    .slice(0, 300);
}
