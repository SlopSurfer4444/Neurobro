/**
 * Stable DTOs for local consumers. They intentionally contain no GramJS
 * entities, session material, or mutable client handles.
 */
export interface ReadOnlySourceDto {
  id: string;
  peerId: string;
  title: string;
}

export interface ReadOnlyMessageDto {
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

/** The complete local consumer surface: reads only. */
export interface ReadOnlyGatewayApi {
  listSources(): readonly ReadOnlySourceDto[];
  getRecentMessages(sourceId: string, limit: number): Promise<readonly ReadOnlyMessageDto[]>;
}

/** Internal gateway capability expressed without a session or client handle. */
export interface ReadOnlyGatewayOwner extends ReadOnlyGatewayApi {}
