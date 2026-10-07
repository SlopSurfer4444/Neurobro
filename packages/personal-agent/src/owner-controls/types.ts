import type { CapabilityGrant, Json, MessageRef, Observation, TaskIntent, ToolContext } from '../contracts.ts';

export interface OwnerControlStore {
  get<T>(namespace: string, id: string): T | undefined;
  put<T>(namespace: string, id: string, value: T): void;
  list<T>(namespace: string): T[];
  transaction<T>(operation: () => T): T;
}
export interface ResolvedOwnerPeer { accountId: string; peerId: string; label: string; username?: string; kind?: 'user' | 'group' | 'channel'; sourceRef?: MessageRef }
export interface OwnerControlTelegram {
  getMessage(ref: MessageRef): Promise<Observation | undefined>;
  /** Trusted adapter resolves exact public username/link or known reference; fuzzy search never grants. */
  resolveSource(selector: string): Promise<ResolvedOwnerPeer>;
  resolveForwardSource(observation: Observation): Promise<ResolvedOwnerPeer | undefined>;
  /** Exact trusted peer readback; proposal labels supplied by a model are not resolver evidence. */
  verifyPeer?(peer: ResolvedOwnerPeer): Promise<ResolvedOwnerPeer>;
}
export interface OwnerSourceEvidence { ref: MessageRef; versionHash: string; contextRefs: string[]; admittedAt: string }
export interface MonitorPolicy {
  id: string; taskId: string; sourcePeerId: string; label: string; revision: number;
  ownerSource: OwnerSourceEvidence; state: 'active' | 'revoked'; kind: 'read' | 'monitor';
  createdAt: string; expiresAt?: string; revokedAt?: string; reason?: string;
}
export interface SourceScopeProposalInput { context: ToolContext; sources: ResolvedOwnerPeer[]; monitor: boolean; title?: string; expiresAt?: string }
export interface RecipientApprovalSpec { id: string; peerId: string; payloadHash: string; sourceRef?: string; preview?: string;
  effects?: { operationId: string; capability: 'telegram.send' | 'telegram.media.send'; payloadHash: string }[];
  attachments?: { artifactId: string; name: string; sha256: string; size: number; profile: string }[] }
export interface OutreachApprovalProposalInput {
  context: ToolContext; objectId: string; batchRevision: number; manifestHash: string;
  recipients: RecipientApprovalSpec[]; title?: string; expiresAt?: string;
}
export interface OwnerApprovalReceipt {
  id: string; context: ToolContext; ownerSource: OwnerSourceEvidence; objectKind: 'outreach';
  objectId: string; batchRevision: number; manifestHash: string; selectedRecipientIds: string[];
  recipients: RecipientApprovalSpec[]; expiresAt: string; revokedAt?: string;
}
export interface OwnerProposalPublicationPart { effectId: string; payloadHash: string; artifactId?: string }
export interface OwnerProposalPublication {
  state: 'not-published' | 'pending' | 'verified' | 'failed' | 'unknown';
  stage: 'preparing' | 'manifest' | 'card'; updatedAt: string; reason?: string;
  manifest?: OwnerProposalPublicationPart; card?: OwnerProposalPublicationPart;
}
export interface OwnerScopeProposal {
  id: string; kind: 'sources' | 'outreach'; context: ToolContext; state: 'pending' | 'accepted' | 'rejected' | 'expired';
  title: string; sources?: ResolvedOwnerPeer[]; monitor?: boolean; objectId?: string; batchRevision?: number;
  manifestHash?: string; recipients?: RecipientApprovalSpec[]; selectedRecipientIds?: string[];
  cardRef?: MessageRef; publication?: OwnerProposalPublication; expiresAt: string; createdAt: string; receiptId?: string;
}
export interface OwnerEventResult { disposition: 'none' | 'source-plan' | 'accepted' | 'rejected' | 'revoked' | 'ambiguous'; proposal?: OwnerScopeProposal; receipt?: OwnerApprovalReceipt; reason?: string; affectedTaskIds?: string[] }
export interface OwnerAuthorityPreparation { capabilities: CapabilityGrant[]; expiresAt?: string | null }
export interface OwnerControlOptions {
  store: OwnerControlStore; telegram: OwnerControlTelegram; accountId: string; ownerId: string; controlPeerId: string;
  taskIntent(taskId: string): TaskIntent | undefined;
  taskActive(taskId: string): boolean;
  validateAuthority(context: ToolContext): void;
  baseCapabilities(intent: TaskIntent): CapabilityGrant[];
  now?: () => Date; proposalTtlMs?: number; outreachTtlMs?: number; readTtlMs?: number;
}
export interface OwnerEffectRequest { capability: string; resource: string; payload: Json; id?: string }
