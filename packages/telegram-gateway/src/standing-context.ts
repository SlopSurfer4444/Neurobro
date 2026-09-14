/** Private, untrusted conversation data. These fields never grant instructions,
 * tools, authority, or permission. The model consumer owns explicit data framing
 * and its final input budget; none of this envelope belongs in logs or receipts. */
export type StandingContextMessage = Readonly<{
  chatId: string;
  messageId: number;
  authorId: string;
  author: "self" | "user";
  displayName: string;
  date: number;
  replyToMessageId: number | null;
  text: string;
}>;
export type StandingContextStatus = "complete" | "partial" | "missing" | "truncated" | "unavailable";
export type StandingContext = Readonly<{
  version: "standing-context-v1";
  primary: StandingContextMessage;
  /** Closest replied-to message first. */
  replyChain: readonly StandingContextMessage[];
  /** Chronological preceding window; chain duplicates are omitted here. */
  recent: readonly StandingContextMessage[];
  chainStatus: StandingContextStatus;
  recentStatus: Exclude<StandingContextStatus, "missing">;
}>;
export const STANDING_CONTEXT_CHAIN_LIMIT = 8;
export const STANDING_CONTEXT_WINDOW_LIMIT = 20;
