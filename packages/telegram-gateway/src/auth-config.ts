import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./types.js";

export interface AuthConfig {
  schemaVersion: 1;
  mode: "auth-only";
  account: AppConfig["account"];
}

export function parseAuthConfig(raw: unknown, configPath: string): AuthConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected auth config.");
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.mode !== "auth-only") throw new Error("Expected schemaVersion 1 and auth-only mode.");
  if (Object.keys(value).some((key) => !["schemaVersion", "mode", "account"].includes(key))) {
    throw new Error("Auth config cannot contain ingestion settings.");
  }
  if (!value.account || typeof value.account !== "object" || Array.isArray(value.account)) throw new Error("Expected account settings.");
  const account = value.account as Record<string, unknown>;
  const keys = ["apiIdEnv", "apiHashEnv", "sessionPassphraseEnv", "sessionFile"];
  if (Object.keys(account).some((key) => !keys.includes(key))) throw new Error("Unknown account setting.");
  for (const key of keys) {
    if (typeof account[key] !== "string" || !(account[key] as string).trim()) throw new Error(`Missing account.${key}.`);
  }
  for (const key of keys.slice(0, 3)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(account[key] as string)) throw new Error(`Invalid account.${key}.`);
  }
  return {
    schemaVersion: 1,
    mode: "auth-only",
    account: {
      apiIdEnv: account.apiIdEnv as string,
      apiHashEnv: account.apiHashEnv as string,
      sessionPassphraseEnv: account.sessionPassphraseEnv as string,
      sessionFile: path.resolve(path.dirname(path.resolve(configPath)), account.sessionFile as string),
    },
  };
}

export async function loadAuthConfig(configPath: string): Promise<AuthConfig> {
  return parseAuthConfig(JSON.parse(await readFile(configPath, "utf8")), configPath);
}
