import { readFile } from "node:fs/promises";
import { Api, TelegramClient, utils } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { LogLevel } from "telegram/extensions/Logger.js";
import type { AppConfig, DialogSummary, ResolvedSource } from "./types.js";
import { decryptSession } from "./session-crypto.js";
import { GuardedExecutor } from "./guardrails.js";
import { readApiCredentials } from "./config.js";

function clientOptions() {
  return {
    requestRetries: 1,
    connectionRetries: 2,
    reconnectRetries: 3,
    retryDelay: 5000,
    autoReconnect: true,
    sequentialUpdates: true,
    floodSleepThreshold: 0,
    securityChecks: true,
    deviceModel: "Guarded MTProto Ingestor",
    systemVersion: process.platform,
    appVersion: "0.1.0",
    langCode: "en",
    systemLangCode: "en",
  };
}

export async function createAuthorizedClient(
  config: AppConfig,
  passphrase: string,
  guard: GuardedExecutor,
): Promise<TelegramClient> {
  const credentials = readApiCredentials(config);
  const encrypted = await readFile(config.account.sessionFile, "utf8");
  const session = await decryptSession(encrypted, passphrase);
  const client = new TelegramClient(
    new StringSession(session),
    credentials.apiId,
    credentials.apiHash,
    clientOptions(),
  );
  client.setLogLevel(LogLevel.WARN);
  await guard.execute("mtproto.connect", async () => {
    await client.connect();
  });
  await guard.execute("updates.getState", async () => {
    await client.invoke(new Api.updates.GetState());
  });
  return client;
}

function dialogKind(dialog: { isUser?: boolean; isGroup?: boolean; isChannel?: boolean }): DialogSummary["kind"] {
  if (dialog.isUser) return "user";
  if (dialog.isGroup) return "group";
  if (dialog.isChannel) return "channel";
  return "unknown";
}

export async function discoverDialogs(
  client: TelegramClient,
  guard: GuardedExecutor,
  limit: number,
): Promise<DialogSummary[]> {
  const dialogs = await guard.execute("messages.getDialogs", () => client.getDialogs({ limit }));
  const result: DialogSummary[] = [];
  for (const dialog of dialogs) {
    if (!dialog.entity || !dialog.inputEntity) continue;
    result.push({
      peerId: utils.getPeerId(dialog.entity),
      title: dialog.title || "(untitled)",
      kind: dialogKind(dialog),
      peer: dialog.inputEntity,
    });
  }
  return result;
}

export function findExactDialogByTitle(dialogs: DialogSummary[], title: string): DialogSummary {
  const expected = title.trim();
  if (!expected) throw new Error("Dialog title must not be empty.");
  const matches = dialogs.filter(
    (dialog) => dialog.title.trim().localeCompare(expected, undefined, { sensitivity: "accent" }) === 0,
  );
  if (matches.length === 0) {
    throw new Error(`No exact dialog title match was found for ${JSON.stringify(expected)}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} exact dialog title matches for ${JSON.stringify(expected)}; refusing an ambiguous selection.`,
    );
  }
  return matches[0] as DialogSummary;
}

export function resolveConfiguredSources(
  config: AppConfig,
  dialogs: DialogSummary[],
): ResolvedSource[] {
  const byPeer = new Map(dialogs.map((dialog) => [dialog.peerId, dialog]));
  return config.sources.filter((source) => source.enabled).map((source) => {
    const dialog = byPeer.get(source.peerId);
    if (!dialog) {
      throw new Error(
        `Allowed source ${source.id} (${source.peerId}) is not in the bounded dialog discovery page. ` +
          "Run discover and keep only an exact numeric peerId from that output.",
      );
    }
    return { source, peer: dialog.peer, title: dialog.title };
  });
}

export function getStablePeerId(message: Api.Message): string | undefined {
  if (!message.peerId) return undefined;
  try {
    return utils.getPeerId(message.peerId);
  } catch {
    return undefined;
  }
}

export { clientOptions };
