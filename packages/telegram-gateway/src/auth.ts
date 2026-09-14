import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { LogLevel } from "telegram/extensions/Logger.js";
import type { AppConfig } from "./types.js";
import { ask, askHidden, readSessionPassphrase } from "./prompt.js";
import { encryptSession } from "./session-crypto.js";
import { writeFileAtomic } from "./atomic-file.js";
import { clientOptions } from "./telegram-client.js";
import { safeErrorSummary } from "./errors.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function credential(
  envName: string,
  prompt: string,
  hidden = false,
): Promise<string> {
  return process.env[envName] || (hidden ? askHidden(prompt) : ask(prompt));
}

export function authClientOptions() {
  return {
    ...clientOptions(),
    // GramJS consumes the first request attempt when Telegram returns
    // PHONE_MIGRATE_X and needs one more loop iteration on the correct DC.
    requestRetries: 2,
    autoReconnect: false,
    connectionRetries: 1,
    reconnectRetries: 0,
  };
}

export async function authorize(config: Pick<AppConfig, "account">, replaceSession: boolean): Promise<void> {
  const apiIdRaw = await credential(config.account.apiIdEnv, "Telegram api_id: ");
  const apiHash = await credential(config.account.apiHashEnv, "Telegram api_hash: ", true);
  const apiId = Number(apiIdRaw);
  if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error("api_id must be a positive integer.");
  if (!/^[a-fA-F0-9]{32}$/.test(apiHash)) throw new Error("api_hash must be 32 hexadecimal characters.");
  if ((await exists(config.account.sessionFile)) && !replaceSession) {
    throw new Error("Encrypted session already exists. Use --replace-session to create a recoverable backup and replace it.");
  }

  const phoneNumber = await ask("Account phone number (international format): ");
  const passphrase = await readSessionPassphrase(config.account.sessionPassphraseEnv, true);
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    ...authClientOptions(),
  });
  client.setLogLevel(LogLevel.WARN);
  let reportedError = "AUTH_FAILED";
  try {
    await client.start({
      phoneNumber: async () => phoneNumber,
      phoneCode: async () => askHidden("Login code: "),
      password: async () => askHidden("Telegram 2FA password: "),
      firstAndLastNames: async () => {
        throw new Error("Refusing to create a new Telegram account from this tool.");
      },
      onError: async (error) => {
        reportedError = safeErrorSummary(error);
        return true;
      },
    });
    const session = (client.session as StringSession).save();
    const encrypted = await encryptSession(session, passphrase);
    await mkdir(path.dirname(config.account.sessionFile), { recursive: true });
    if (await exists(config.account.sessionFile)) {
      const backup = `${config.account.sessionFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(config.account.sessionFile, backup);
      console.log(`Existing encrypted session moved to ${backup}`);
    }
    await writeFileAtomic(config.account.sessionFile, encrypted);
    await writeFile(`${config.account.sessionFile}.NOTICE.txt`, "Encrypted session: do not commit, copy, or share this file.\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`Authorization complete. Encrypted session saved to ${config.account.sessionFile}`);
  } catch (error) {
    throw new Error(`Authorization stopped (${reportedError}): ${safeErrorSummary(error)}`);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}
