import type { ReadOnlyGatewayApi, ReadOnlyGatewayOwner } from "./types.js";

/**
 * Public entrypoint: callers receive only an already-bounded read capability.
 * The imported gateway composes its session-backed adapter internally.
 */
export function createReadOnlyGatewayApi(owner: ReadOnlyGatewayOwner): ReadOnlyGatewayApi {
  return {
    listSources: () => owner.listSources(),
    getRecentMessages: (sourceId, limit) => owner.getRecentMessages(sourceId, limit),
  };
}

export type { ReadOnlyGatewayApi, ReadOnlyGatewayOwner, ReadOnlyMessageDto, ReadOnlySourceDto } from "./types.js";
