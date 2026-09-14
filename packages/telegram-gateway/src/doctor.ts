import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { AppConfig } from "./types.js";

interface Check {
  id: string;
  result: "PASS" | "FAIL" | "SKIP";
  detail: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(config: AppConfig): Promise<number> {
  const checks: Check[] = [];
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({
    id: "runtime.node",
    result: major >= 24 ? "PASS" : "FAIL",
    detail: `Node ${process.version}; required >=24.`,
  });
  checks.push({
    id: "config.read-only",
    result: config.mode === "read-only" ? "PASS" : "FAIL",
    detail: `mode=${config.mode}`,
  });
  const enabled = config.sources.filter((source) => source.enabled);
  checks.push({
    id: "config.sources",
    result: enabled.length > 0 ? "PASS" : "FAIL",
    detail: `${enabled.length} explicitly enabled numeric source(s).`,
  });
  checks.push({
    id: "secrets.api-id",
    result: process.env[config.account.apiIdEnv] ? "PASS" : "SKIP",
    detail: process.env[config.account.apiIdEnv]
      ? `${config.account.apiIdEnv} is present (value hidden).`
      : `${config.account.apiIdEnv} is absent; set it only for auth/runtime.`,
  });
  checks.push({
    id: "secrets.api-hash",
    result: process.env[config.account.apiHashEnv] ? "PASS" : "SKIP",
    detail: process.env[config.account.apiHashEnv]
      ? `${config.account.apiHashEnv} is present (value hidden).`
      : `${config.account.apiHashEnv} is absent; set it only for auth/runtime.`,
  });
  const sessionExists = await fileExists(config.account.sessionFile);
  checks.push({
    id: "session.encrypted-file",
    result: sessionExists ? "PASS" : "FAIL",
    detail: sessionExists ? `Encrypted session exists at ${config.account.sessionFile}.` : "Run auth locally.",
  });
  if (sessionExists) {
    const header = await readFile(config.account.sessionFile, "utf8");
    checks.push({
      id: "session.no-plaintext-string-session",
      result: header.includes('"algorithm": "aes-256-gcm"') ? "PASS" : "FAIL",
      detail: "Session envelope format checked without decrypting it.",
    });
  }

  for (const check of checks) console.log(`${check.result} ${check.id}: ${check.detail}`);
  const failed = checks.filter((check) => check.result === "FAIL").length;
  const skipped = checks.filter((check) => check.result === "SKIP").length;
  console.log(`Summary: PASS=${checks.length - failed - skipped} FAIL=${failed} SKIP=${skipped}`);
  return failed === 0 ? 0 : 1;
}
