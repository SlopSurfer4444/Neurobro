/** Trusted host configuration. Model arguments never expand this scope. */
export interface DesktopContextScope {
  allOwnerThreads?: boolean;
  threadIds?: string[];
  projectRoots?: string[];
}
export interface DesktopContextConfig {
  codexHome: string;
  ownerId: string;
  scope: DesktopContextScope;
  includeArchived?: boolean;
  maxFiles?: number;
  maxReadBytes?: number;
}
export interface DesktopContextAccess { ownerId: string; scope: DesktopContextScope }
export interface SavedChat {
  id: string; title: string; cwd: string; archived: boolean; savedAt: string;
  source: 'local_codex_rollout'; runtimeStatus: 'unknown';
}
export interface SavedMessage {
  ref: string; role: 'user' | 'assistant'; phase?: string; timestamp?: string;
  text?: string; omission?: string; redacted: boolean;
}
export interface SavedChatRead {
  chat: SavedChat; observedAt: string; snapshot: string; messages: SavedMessage[];
  coverage: { startByte: number; endByte: number; fileBytes: number; moreBefore: boolean;
    moreAfter: boolean; nextBeforeByte: number | null; incompleteLines: number; ignoredRecords: number; changedDuringRead: boolean };
  statusEvidence: 'saved_messages_only'; desktopAttached: false; controlAvailable: false;
}
