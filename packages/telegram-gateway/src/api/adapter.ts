import { Api, type TelegramClient } from "telegram";
import type { AppConfig, ResolvedSource } from "../types.js";
import { GuardedExecutor } from "../guardrails.js";
import { normalizeMessage } from "../ingestor.js";
import type { ReadOnlyGatewayOwner, ReadOnlyMessageDto, ReadOnlySourceDto } from "./types.js";

/**
 * Internal bridge from the imported gateway's existing session owner. This
 * factory never authenticates, connects, or constructs a TelegramClient.
 */
export function createReadOnlyGatewayOwner(
  config: Pick<AppConfig, "limits">,
  client: TelegramClient,
  guard: GuardedExecutor,
  sources: readonly ResolvedSource[],
): ReadOnlyGatewayOwner {
  const byId = new Map(sources.map((source) => [source.source.id, source]));
  const sourceDtos: readonly ReadOnlySourceDto[] = sources.map((source) => ({
    id: source.source.id,
    peerId: source.source.peerId,
    title: source.title,
  }));

  return {
    listSources: () => sourceDtos,
    async getRecentMessages(sourceId, limit) {
      const source = byId.get(sourceId);
      if (!source) throw new Error(`Source ${JSON.stringify(sourceId)} is not allowlisted.`);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.limits.historyPageSize) {
        throw new Error(`limit must be an integer from 1 to ${config.limits.historyPageSize}.`);
      }

      return guard.execute(`messages.getHistory.local-api:${sourceId}`, async () => {
        const messages: ReadOnlyMessageDto[] = [];
        for await (const message of client.iterMessages(source.peer, { limit, waitTime: 0 })) {
          if (message instanceof Api.Message) messages.push(normalizeMessage(message, source.source));
        }
        return messages;
      });
    },
  };
}
