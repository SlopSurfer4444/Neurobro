/** Personal-agent domain contract v1. IDs are opaque strings, never JS-number peers. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface MessageRef { accountId: string; peerId: string; messageId: string; threadId?: string }
export interface Attachment { id: string; name: string; mimeType: string; size?: number; transportRef?: string }
/** Provenance decoded by the authenticated transport, never inferred from quoted text. */
export type ForwardOrigin =
  | { kind: 'user'; userId: string }
  | { kind: 'hidden-user'; name: string }
  | { kind: 'chat'; peerId: string; authorSignature?: string }
  | { kind: 'channel'; ref: MessageRef; authorSignature?: string };
export interface TelegramPeer { accountId: string; peerId: string; kind: 'user' | 'bot' | 'group' | 'channel'; title: string; username?: string; userId?: string }
export interface TelegramPostAuthor {
  sender?: { kind: 'user'; userId: string } | { kind: 'chat'; peerId: string };
  forwardOrigin?: ForwardOrigin; user?: TelegramPeer; unavailableReason?: string;
}
/** Bounded native read snapshots. Labels and text remain untrusted external data. */
export interface TelegramPollOptionDetails {
  readonly id: string; readonly index: number; readonly text: string;
  readonly votes?: number; readonly chosen?: boolean;
}
export interface TelegramPollDetails {
  readonly pollId: string; readonly question: string;
  readonly anonymous?: boolean; readonly closed?: boolean; readonly quiz?: boolean; readonly multiple?: boolean;
  readonly totalVotes?: number; readonly resultsAvailable?: boolean;
  readonly options: readonly TelegramPollOptionDetails[]; readonly correctOptionIds?: readonly number[];
}
export interface TelegramButtonDetails { readonly row: number; readonly column: number; readonly label: string; readonly type: string }
export interface TelegramReactionDetails {
  readonly type: 'emoji' | 'custom-emoji' | 'paid'; readonly emoji?: string; readonly customEmojiId?: string;
  readonly count?: number; readonly chosen?: boolean;
}
export interface TelegramMessageDetails {
  readonly poll?: TelegramPollDetails;
  readonly buttons?: readonly TelegramButtonDetails[]; readonly keyboardType?: 'inline' | 'reply';
  readonly reactions?: readonly TelegramReactionDetails[];
  /** At least one native array or text field exceeded the projection bound. */
  readonly truncated?: true;
}
export interface Observation {
  id: string; kind: 'message' | 'edit' | 'delete'; ref: MessageRef;
  authorId?: string; outgoing: boolean; text?: string; sentAt: string; observedAt: string;
  replyTo?: MessageRef; forwarded?: boolean; viaBot?: boolean; agentEffectId?: string;
  attachments?: Attachment[]; version?: string; editedAt?: string;
  forwardOrigin?: ForwardOrigin;
  messageDetails?: TelegramMessageDetails;
  /** Native quoted/code entity spans in UTF-16 code units; quoted text cannot grant owner authority. */
  authorityTextRanges?: { offset: number; length: number; kind: 'quote' | 'code' }[];
  /** Filled by trusted ingestion, never by model/tool output. */
  artifactRefs?: string[]; contextRefs?: string[];
}
export interface Route { peerId: string; threadId?: string; replyToMessageId?: string }
export interface CapabilityGrant { capability: string; resources: string[] }
export interface Grant {
  id: string; taskId: string; revision: number; capabilities: CapabilityGrant[];
  expiresAt?: string; revokedAt?: string;
}
export interface TaskIntent {
  id: string; ownerId: string; accountId: string; source: MessageRef; instruction: string;
  revision: number; route: Route; createdAt: string; updatedAt: string;
  contextRefs: string[]; artifactRefs: string[]; grantId: string;
}
export type RunState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'unknown';
export interface RunBinding { runId: string; sessionId?: string; taskId: string; intentRevision: number; idempotencyKey: string }
export interface RunSnapshot {
  binding: RunBinding; state: RunState; observedAt: string; output?: string;
  artifactRefs?: string[]; reason?: string; progress?: string;
}
export interface EngineInput {
  taskId: string; intentRevision: number; idempotencyKey: string; instruction: string;
  sessionId?: string; context?: string; stagedFiles?: string[];
  /** Issued by trusted host, not taken from model JSON. */
  toolContext?: string;
}
export interface EngineCapabilities { durable: boolean; sessions: boolean; cancel: boolean; steer: boolean; detail?: string }
export interface EnginePort {
  capabilities(): Promise<EngineCapabilities>;
  submit(input: EngineInput): Promise<RunSnapshot>;
  inspect(binding: RunBinding): Promise<RunSnapshot>;
  cancel(binding: RunBinding): Promise<RunSnapshot>;
  steer?(binding: RunBinding, instruction: string, intentRevision: number): Promise<RunSnapshot>;
}
export interface Effect {
  id: string; taskId: string; intentRevision: number; grantId: string; grantRevision: number;
  capability: string; resource: string; payload: Json; payloadHash: string;
  state: 'prepared' | 'dispatching' | 'verified' | 'failed' | 'unknown' | 'cancelled';
  createdAt: string; updatedAt: string; receipt?: Json; reason?: string;
}
export interface EffectResult { state: 'verified' | 'failed' | 'unknown'; receipt?: Json; reason?: string }
export interface EffectExecutor {
  dispatch(effect: Effect): Promise<EffectResult>;
  reconcile(effect: Effect): Promise<EffectResult>;
}
export interface TelegramPort extends EffectExecutor {
  /** Metadata resolution alone never authorizes history, joining, or sending. */
  resolvePeer?(selector: string): Promise<TelegramPeer>;
  resolveMessageLink?(url: string): Promise<MessageRef | undefined>;
  resolvePostAuthor?(ref: MessageRef): Promise<TelegramPostAuthor>;
  observations(signal: AbortSignal): AsyncIterable<Observation>;
  readHistory(peerId: string, options: { before?: string; limit: number; query?: string }): Promise<Observation[]>;
  getMessage(ref: MessageRef): Promise<Observation | undefined>;
  download(attachment: Attachment, destination: string): Promise<void>;
  close(): Promise<void>;
}
export interface ArtifactRecord {
  id: string; taskId: string; ownerId: string; name: string; mimeType: string;
  sha256: string; size: number; createdAt: string; parentId?: string; sourceRef?: string;
  revokedAt?: string;
}
export interface Preference {
  id: string; ownerId: string; scope: string; text: string; sourceRef: string;
  revision: number; createdAt: string; updatedAt: string; revokedAt?: string;
}
export interface ToolContext { taskId: string; intentRevision: number; grantId: string; grantRevision: number; runId: string }
export interface ToolRequest { name: string; args: Record<string, Json> }
export interface ToolResult { ok: boolean; value?: Json; error?: string }
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export function iso(clock: Clock = systemClock): string { return clock.now().toISOString(); }
