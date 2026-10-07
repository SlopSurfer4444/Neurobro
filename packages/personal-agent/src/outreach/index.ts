import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Effect, Json, MessageRef, Route, ToolContext } from '../contracts.ts';
import { AuthorityError, canonicalJson, type EffectRequest } from '../core/broker.ts';
import type { PersonalStore } from '../core/store.ts';
import type { OutreachApprovalProposalInput, OwnerApprovalReceipt, OwnerScopeProposal } from '../owner-controls/types.ts';
import type { RegisteredTool, ToolBroker } from '../capabilities/types.ts';
import { id, int, obj, str } from '../capabilities/schema.ts';
import type { ToolArtifacts } from '../capabilities/types.ts';

export interface OutreachAttachment { artifactId: string; profile: 'file' | 'photo'; name?: string; sha256?: string; size?: number; payload?: Json }
export interface OutreachRecipient { id: string; route: Route; text: string; sourceRef?: MessageRef; attachments?: OutreachAttachment[] }
export interface OutreachDraft { name: string; recipients: OutreachRecipient[]; requestKey?: string }
export interface OutreachManifest {
  batchId: string; taskId: string; intentRevision: number; revision: number; name: string;
  recipients: (OutreachRecipient & { payloadHash: string })[]; manifestHash: string; createdAt: string;
}
export type RecipientState = 'unselected' | 'pending' | 'dispatching' | 'verified' | 'failed' | 'unknown' | 'cancelled';
export interface RecipientProgress {
  id: string; state: RecipientState; effectId?: string; dispatchContext?: ToolContext;
  receipt?: Json; reason?: string; prewireRejected?: boolean; updatedAt: string;
  textState?: RecipientState; attachments?: RecipientProgress[];
}
export interface OutreachBatch {
  id: string; taskId: string; intentRevision: number; manifestRevision: number; manifestHash: string;
  state: 'draft' | 'approved' | 'sending' | 'completed' | 'partial' | 'unknown' | 'cancelled'; version: number;
  selectedRecipientIds: string[]; recipients: RecipientProgress[]; approvalReceiptId?: string;
  createdAt: string; updatedAt: string; cancelledAt?: string; reason?: string;
}
export interface OutreachApprovalPort {
  proposeApproval(input: OutreachApprovalProposalInput): OwnerScopeProposal | Promise<OwnerScopeProposal>;
  getOutreachApproval(context: ToolContext, receiptId: string, batchId: string, revision: number, hash: string, selection: string[]): Promise<OwnerApprovalReceipt>;
}
export interface OutreachOptions {
  store: Pick<PersonalStore, 'get' | 'put' | 'insert' | 'list' | 'transaction'>;
  broker: ToolBroker; approvals: OutreachApprovalPort;
  /** Core's pure effectOperationId; no duplicate sender, outbox or identity algorithm. */
  effectIdentity(context: ToolContext, request: EffectRequest): string;
  /** Existing broker outbox read. Reconciliation remains the Telegram executor's responsibility. */
  getEffect(id: string): Effect | undefined;
  accountId: string; now?: () => Date;
  artifacts?: Pick<ToolArtifacts, 'resolveForSend'>;
}
export interface OutreachStatus { batch: OutreachBatch; manifest: OutreachManifest; counts: Record<RecipientState, number> }
export interface OutreachReplyTarget { batchId: string; recipientId: string; peerId: string; messageId: string; sentAt: string; sourceRef?: MessageRef }
const batches = 'outreach-batches-v1', manifests = 'outreach-manifests-v1';
const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const mkey = (batchId: string, revision: number) => batchId + ':' + revision;
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
export function outreachPayload(recipient: OutreachRecipient): Json {
  return { peerId: recipient.route.peerId, ...(recipient.route.threadId ? { threadId: recipient.route.threadId } : {}),
    ...(recipient.route.replyToMessageId ? { replyToMessageId: recipient.route.replyToMessageId } : {}), text: recipient.text };
}
function effectRequest(manifest: OutreachManifest, recipient: OutreachRecipient, attachmentIndex?: number): EffectRequest {
  if (attachmentIndex !== undefined) return { id: `outreach:${manifest.batchId}:revision:${manifest.revision}:recipient:${recipient.id}:attachment:${attachmentIndex}`,
    capability: 'telegram.media.send', resource: recipient.route.peerId, payload: recipient.attachments![attachmentIndex]!.payload! };
  return { id: `outreach:${manifest.batchId}:revision:${manifest.revision}:recipient:${recipient.id}`,
    capability: 'telegram.send', resource: recipient.route.peerId, payload: outreachPayload(recipient) };
}

/** Immutable drafts plus a small projection of the existing effect outbox. No timer or task engine. */
export class OutreachService {
  readonly #options: OutreachOptions;
  readonly #draining = new Set<string>();
  constructor(options: OutreachOptions) { this.#options = options; if (!options.accountId) throw new Error('outreach account binding required'); }
  #now(): string { return (this.#options.now?.() ?? new Date()).toISOString(); }
  #initialProgress(recipient: OutreachRecipient, now: string): RecipientProgress {
    return { id: recipient.id, state: 'unselected', updatedAt: now, ...(recipient.attachments?.length ? {
      textState: 'unselected', attachments: recipient.attachments.map((_item, index) => ({ id: String(index), state: 'unselected', updatedAt: now })) } : {}) };
  }
  async #validateDraft(context: ToolContext, input: OutreachDraft): Promise<OutreachDraft> {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256 || !Array.isArray(input.recipients) || !input.recipients.length || input.recipients.length > 50) throw new Error('invalid outreach draft');
    if (input.requestKey !== undefined) identifier(input.requestKey, 'request key');
    const recipients = await Promise.all(input.recipients.map(async recipient => {
      const recipientId = identifier(recipient.id, 'recipient ID');
      if (!recipient.route || typeof recipient.route !== 'object') throw new Error('recipient route required');
      const route: Route = { peerId: identifier(recipient.route.peerId, 'peer ID'),
        ...(recipient.route.threadId !== undefined ? { threadId: identifier(recipient.route.threadId, 'thread ID') } : {}),
        ...(recipient.route.replyToMessageId !== undefined ? { replyToMessageId: identifier(recipient.route.replyToMessageId, 'reply ID') } : {}) };
      if (typeof recipient.text !== 'string' || !recipient.text.trim() || recipient.text.length > 4096 || /\u0000/u.test(recipient.text)) throw new Error('invalid recipient text');
      const source = recipient.sourceRef;
      if (source && (source.accountId !== this.#options.accountId || !source.peerId || !source.messageId)) throw new Error('source reference belongs to another account');
      if (recipient.attachments !== undefined && (!Array.isArray(recipient.attachments) || recipient.attachments.length > 10)) throw new Error('invalid outreach attachments');
      const attachments: OutreachAttachment[] = [];
      for (const attachment of recipient.attachments ?? []) {
        if (!this.#options.artifacts || !['file', 'photo'].includes(attachment.profile)) throw new Error('outreach artifact adapter/profile unavailable');
        const artifactId = identifier(attachment.artifactId, 'artifact ID');
        const file = await this.#options.artifacts.resolveForSend(context, artifactId);
        if (attachment.profile === 'photo' && !file.mimeType.startsWith('image/')) throw new Error('outreach photo MIME mismatch');
        const bytes = readFileSync(file.path), sha256 = createHash('sha256').update(bytes).digest('hex');
        if (file.size !== undefined && file.size !== bytes.length) throw new Error('outreach artifact size mismatch');
        attachments.push({ artifactId, profile: attachment.profile, name: file.name, sha256, size: bytes.length,
          payload: { peerId: route.peerId, ...(route.threadId ? { threadId: route.threadId } : {}), ...(route.replyToMessageId ? { replyToMessageId: route.replyToMessageId } : {}),
            path: file.path, artifactId, profile: attachment.profile, mediaType: attachment.profile === 'file' ? 'document' : 'photo', sha256, size: bytes.length, name: file.name } });
      }
      if (new Set(attachments.map(item => item.artifactId)).size !== attachments.length) throw new Error('duplicate outreach attachment');
      return { id: recipientId, route, text: recipient.text, ...(source ? { sourceRef: clone(source) } : {}), ...(attachments.length ? { attachments } : {}) };
    }));
    if (new Set(recipients.map(recipient => recipient.id)).size !== recipients.length ||
      new Set(recipients.map(recipient => canonicalJson(asJson(recipient.route)))).size !== recipients.length) throw new Error('duplicate recipient identity or destination');
    return { name: input.name, recipients, ...(input.requestKey ? { requestKey: input.requestKey } : {}) };
  }
  #load(context: ToolContext, batchId: string): { batch: OutreachBatch; manifest: OutreachManifest } {
    identifier(batchId, 'batch ID');
    const batch = this.#options.store.get<OutreachBatch>(batches, batchId);
    if (!batch || batch.taskId !== context.taskId || batch.intentRevision !== context.intentRevision) throw new Error('batch outside current task revision');
    const manifest = this.#options.store.get<OutreachManifest>(manifests, mkey(batch.id, batch.manifestRevision));
    if (!manifest || manifest.taskId !== context.taskId || manifest.manifestHash !== batch.manifestHash) throw new Error('outreach manifest binding mismatch');
    return { batch: clone(batch), manifest: clone(manifest) };
  }
  #update(batchId: string, mutation: (current: OutreachBatch) => void): OutreachBatch {
    return this.#options.store.transaction(() => {
      const current = this.#options.store.get<OutreachBatch>(batches, batchId); if (!current) throw new Error('batch missing');
      const before = canonicalJson(asJson(current)); mutation(current);
      if (before !== canonicalJson(asJson(current))) { current.version++; current.updatedAt = this.#now(); this.#options.store.put(batches, batchId, current); }
      return clone(current);
    });
  }
  #manifest(context: ToolContext, batchId: string, revision: number, draft: OutreachDraft): OutreachManifest {
    const content = { batchId, taskId: context.taskId, intentRevision: context.intentRevision, revision, name: draft.name,
      recipients: draft.recipients.map(recipient => ({ ...recipient, payloadHash: digest(outreachPayload(recipient)) })) };
    return { ...content, manifestHash: digest(asJson(content)), createdAt: this.#now() };
  }
  async propose(context: ToolContext, input: OutreachDraft): Promise<OutreachStatus> {
    const draft = await this.#validateDraft(context, input);
    const batchId = digest(asJson([context.taskId, context.intentRevision, draft]));
    const manifest = this.#manifest(context, batchId, 1, draft);
    this.#options.store.transaction(() => {
      if (this.#options.store.get(batches, batchId)) return;
      this.#options.store.insert(manifests, mkey(batchId, 1), manifest);
      const now = this.#now();
      this.#options.store.insert<OutreachBatch>(batches, batchId, { id: batchId, taskId: context.taskId, intentRevision: context.intentRevision,
        manifestRevision: 1, manifestHash: manifest.manifestHash, state: 'draft', version: 1, selectedRecipientIds: [],
        recipients: draft.recipients.map(recipient => this.#initialProgress(recipient, now)), createdAt: now, updatedAt: now });
    });
    return this.inspect(context, batchId);
  }
  async revise(context: ToolContext, batchId: string, expectedRevision: number, input: OutreachDraft): Promise<OutreachStatus> {
    const draft = await this.#validateDraft(context, input), { batch } = this.#load(context, batchId);
    if (batch.manifestRevision !== expectedRevision || batch.state === 'cancelled' || batch.recipients.some(recipient => recipient.effectId)) throw new Error('batch revision conflict or dispatch already started; create a follow-up batch');
    const manifest = this.#manifest(context, batchId, expectedRevision + 1, draft);
    this.#options.store.transaction(() => {
      const actual = this.#options.store.get<OutreachBatch>(batches, batchId)!;
      if (actual.version !== batch.version) throw new Error('batch changed while revising');
      if (!this.#options.store.insert(manifests, mkey(batchId, manifest.revision), manifest)) throw new Error('manifest revision already exists');
      this.#update(batchId, current => { current.manifestRevision = manifest.revision; current.manifestHash = manifest.manifestHash;
        current.state = 'draft'; delete current.approvalReceiptId; current.selectedRecipientIds = [];
        current.recipients = draft.recipients.map(recipient => this.#initialProgress(recipient, this.#now())); });
    });
    return this.inspect(context, batchId);
  }
  async requestApproval(context: ToolContext, batchId: string, expectedRevision: number): Promise<OwnerScopeProposal> {
    const { batch, manifest } = this.#load(context, batchId);
    if (batch.state === 'cancelled' || manifest.revision !== expectedRevision) throw new Error('batch revision unavailable');
    const proposal = await this.#options.approvals.proposeApproval({ context, objectId: batchId, batchRevision: manifest.revision,
      manifestHash: manifest.manifestHash, title: manifest.name, recipients: manifest.recipients.map(recipient => ({ id: recipient.id,
        peerId: recipient.route.peerId, payloadHash: recipient.payloadHash, preview: recipient.text,
        ...(recipient.attachments?.length ? { attachments: recipient.attachments.map(({ artifactId, name, sha256, size, profile }) => ({ artifactId, name: name!, sha256: sha256!, size: size!, profile })),
          effects: [effectRequest(manifest, recipient), ...recipient.attachments.map((_item, index) => effectRequest(manifest, recipient, index))].map(request => ({ operationId: request.id!, capability: request.capability as 'telegram.send' | 'telegram.media.send', payloadHash: digest(request.payload) })) } : {}),
        ...(recipient.sourceRef ? { sourceRef: canonicalJson(asJson(recipient.sourceRef)) } : {}) })) });
    if (proposal.objectId !== batchId || proposal.batchRevision !== manifest.revision || proposal.manifestHash !== manifest.manifestHash || proposal.context.taskId !== context.taskId || proposal.context.intentRevision !== context.intentRevision) throw new Error('approval proposal binding mismatch');
    return proposal;
  }
  async #approval(context: ToolContext, manifest: OutreachManifest, receiptId: string, selectedIds: string[]): Promise<OwnerApprovalReceipt> {
    const receipt = await this.#options.approvals.getOutreachApproval(context, receiptId, manifest.batchId, manifest.revision, manifest.manifestHash, selectedIds);
    if (receipt.id !== receiptId || receipt.objectKind !== 'outreach' || receipt.objectId !== manifest.batchId || receipt.batchRevision !== manifest.revision || receipt.manifestHash !== manifest.manifestHash || receipt.context.taskId !== context.taskId || receipt.context.intentRevision !== context.intentRevision || canonicalJson([...receipt.selectedRecipientIds].sort()) !== canonicalJson([...selectedIds].sort())) throw new Error('owner approval receipt binding mismatch');
    for (const recipientId of selectedIds) {
      const approved = receipt.recipients.find(recipient => recipient.id === recipientId), draft = manifest.recipients.find(recipient => recipient.id === recipientId);
      if (!approved || !draft || approved.peerId !== draft.route.peerId || approved.payloadHash !== draft.payloadHash) throw new Error('owner approval payload binding mismatch');
      if (draft.attachments?.length) {
        const effects = [effectRequest(manifest, draft), ...draft.attachments.map((_item, index) => effectRequest(manifest, draft, index))]
          .map(request => ({ operationId: request.id!, capability: request.capability, payloadHash: digest(request.payload) }));
        if (canonicalJson(asJson(approved.effects)) !== canonicalJson(asJson(effects))) throw new Error('owner approval attachment binding mismatch');
      }
    }
    return receipt;
  }
  /** Trusted host only. A model-visible approval proposal is never a receipt or a grant. */
  async attachApproval(context: ToolContext, batchId: string, receiptId: string, selectedIds: string[]): Promise<OutreachStatus> {
    const { batch, manifest } = this.#load(context, batchId);
    if (batch.state === 'cancelled' || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !manifest.recipients.some(recipient => recipient.id === id))) throw new Error('invalid approved recipient selection');
    await this.#approval(context, manifest, receiptId, selectedIds);
    this.#update(batchId, current => {
      if (current.version !== batch.version || current.manifestHash !== manifest.manifestHash || current.state === 'cancelled') throw new Error('batch changed during approval');
      current.approvalReceiptId = receiptId; current.selectedRecipientIds = [...selectedIds]; current.state = 'approved'; delete current.reason;
      for (const recipient of current.recipients) {
        if (recipient.effectId) continue; // Earlier attempts and UNKNOWN are immutable; selecting again cannot reset them.
        recipient.state = selectedIds.includes(recipient.id) ? 'pending' : 'unselected'; recipient.updatedAt = this.#now();
        if (recipient.attachments) { recipient.textState = recipient.state; for (const attachment of recipient.attachments) if (!attachment.effectId) attachment.state = recipient.state; }
      }
    });
    return this.inspect(context, batchId);
  }
  #projectOperation(progress: RecipientProgress, manifest: OutreachManifest, recipientId: string, attachmentIndex?: number): void {
    if (!progress.effectId || !progress.dispatchContext) return;
    const effect = this.#options.getEffect(progress.effectId);
    if (!effect) {
      if (progress.prewireRejected) { progress.state = 'failed'; progress.reason = 'broker authority rejected before any dispatch'; }
      else { progress.state = 'unknown'; progress.reason = 'dispatch reservation has no reconciled broker effect; no replay'; }
      return;
    }
    const recipient = manifest.recipients.find(item => item.id === recipientId)!;
    const request = effectRequest(manifest, recipient, attachmentIndex);
    if (effect.id !== this.#options.effectIdentity(progress.dispatchContext, request) || effect.taskId !== manifest.taskId || effect.intentRevision !== manifest.intentRevision ||
      effect.capability !== request.capability || effect.resource !== recipient.route.peerId || effect.payloadHash !== digest(request.payload) || canonicalJson(effect.payload) !== canonicalJson(request.payload)) {
      progress.state = 'unknown'; progress.reason = 'broker effect does not match approved immutable recipient payload'; return;
    }
    const before = canonicalJson(asJson(progress));
    if (effect.receipt === undefined) delete progress.receipt; else progress.receipt = effect.receipt;
    if (effect.reason === undefined) delete progress.reason; else progress.reason = effect.reason;
    if (effect.state === 'verified') {
      const receipt = effect.receipt && typeof effect.receipt === 'object' && !Array.isArray(effect.receipt) ? effect.receipt : {};
      if (receipt.peerId === recipient.route.peerId && typeof receipt.messageId === 'string' && receipt.messageId) {
        // Existing Telegram executor verifies exact text/reply/topic before the broker marks this receipt verified.
        progress.state = 'verified'; delete progress.reason;
      } else { progress.state = 'unknown'; progress.reason = 'verified effect lacks exact destination/message readback receipt'; }
    } else if (effect.state === 'failed') progress.state = 'failed';
    else if (effect.state === 'cancelled') progress.state = 'cancelled';
    else progress.state = effect.state === 'dispatching' ? 'dispatching' : 'unknown';
    if (before !== canonicalJson(asJson(progress))) progress.updatedAt = this.#now();
  }
  #project(progress: RecipientProgress, manifest: OutreachManifest): void {
    if (!progress.attachments) { this.#projectOperation(progress, manifest, progress.id); return; }
    progress.state = progress.textState ?? progress.state;
    this.#projectOperation(progress, manifest, progress.id); progress.textState = progress.state;
    for (let index = 0; index < progress.attachments.length; index++) this.#projectOperation(progress.attachments[index]!, manifest, progress.id, index);
    const states = [progress.textState, ...progress.attachments.map(item => item.state)];
    progress.state = states.includes('unknown') ? 'unknown' : states.includes('dispatching') ? 'dispatching' : states.includes('failed') ? 'failed' :
      states.includes('cancelled') ? 'cancelled' : states.every(state => state === 'verified') ? 'verified' : states.includes('pending') ? 'pending' : 'unselected';
  }
  async inspect(context: ToolContext, batchId: string): Promise<OutreachStatus> {
    const { manifest } = this.#load(context, batchId);
    const batch = this.#update(batchId, current => {
      for (const recipient of current.recipients) this.#project(recipient, manifest);
      if (current.state !== 'cancelled' && current.selectedRecipientIds.length) {
        const selected = current.recipients.filter(r => current.selectedRecipientIds.includes(r.id));
        if (selected.every(r => r.state === 'verified')) current.state = 'completed';
        else if (selected.every(r => ['verified', 'failed', 'unknown', 'cancelled'].includes(r.state))) current.state = selected.some(r => r.state === 'unknown') ? 'unknown' : 'partial';
      }
    });
    const counts: Record<RecipientState, number> = { unselected: 0, pending: 0, dispatching: 0, verified: 0, failed: 0, unknown: 0, cancelled: 0 };
    batch.recipients.forEach(recipient => counts[recipient.state]++);
    return { batch, manifest, counts };
  }
  async list(context: ToolContext): Promise<OutreachStatus[]> {
    const relevant = this.#options.store.list<OutreachBatch>(batches).filter(batch => batch.taskId === context.taskId && batch.intentRevision === context.intentRevision);
    return Promise.all(relevant.slice(0, 100).map(batch => this.inspect(context, batch.id)));
  }
  /** Trusted read-only projection across prior tasks. This never refreshes their send authority. */
  replyTargets(): OutreachReplyTarget[] {
    const targets: OutreachReplyTarget[] = [];
    for (const batch of this.#options.store.list<OutreachBatch>(batches)) {
      const manifest = this.#options.store.get<OutreachManifest>(manifests, mkey(batch.id, batch.manifestRevision));
      if (!manifest || manifest.manifestHash !== batch.manifestHash) continue;
      for (const saved of batch.recipients) {
        if (!batch.selectedRecipientIds.includes(saved.id)) continue;
        const progress = clone(saved); this.#project(progress, manifest);
        const recipient = manifest.recipients.find(item => item.id === progress.id)!;
        for (const operation of [{ ...progress, state: progress.textState ?? progress.state }, ...(progress.attachments ?? [])]) {
          const receipt = operation.receipt && typeof operation.receipt === 'object' && !Array.isArray(operation.receipt) ? operation.receipt : {};
          const effect = operation.effectId && this.#options.getEffect(operation.effectId);
          if (operation.state !== 'verified' || !effect || typeof receipt.messageId !== 'string') continue;
          targets.push({ batchId: batch.id, recipientId: recipient.id, peerId: recipient.route.peerId, messageId: receipt.messageId,
            sentAt: effect.createdAt, ...(recipient.sourceRef ? { sourceRef: clone(recipient.sourceRef) } : {}) });
        }
      }
    }
    return targets;
  }
  /** Cancels only new dispatches. In-flight/UNKNOWN outcomes remain visible and can still reconcile. */
  async cancel(context: ToolContext, batchId: string): Promise<OutreachStatus> {
    this.#load(context, batchId);
    this.#update(batchId, current => { current.state = 'cancelled'; current.cancelledAt ??= this.#now();
      for (const recipient of current.recipients) {
        if (!recipient.effectId && recipient.state === 'pending') { recipient.state = 'cancelled'; recipient.textState = 'cancelled'; recipient.updatedAt = this.#now(); }
        for (const attachment of recipient.attachments ?? []) if (!attachment.effectId && attachment.state === 'pending') attachment.state = 'cancelled';
      } });
    return this.inspect(context, batchId);
  }
  async drain(token: string, batchId: string, limit = 5): Promise<OutreachStatus> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid outreach dispatch bound');
    const context = this.#options.broker.resolveToolContext(token);
    await this.#options.broker.authorizeTool(token, 'outreach.send', context.taskId);
    this.#load(context, batchId);
    if (this.#draining.has(batchId)) return this.inspect(context, batchId);
    this.#draining.add(batchId);
    try {
      for (let attempt = 0; attempt < limit; attempt++) {
        const { batch, manifest } = this.#load(context, batchId);
        if (batch.state === 'cancelled') break;
        if (!batch.approvalReceiptId) throw new Error('batch has no trusted owner approval');
        const progress = batch.recipients.find(recipient => recipient.state === 'pending' && batch.selectedRecipientIds.includes(recipient.id));
        if (!progress) break;
        try { await this.#approval(context, manifest, batch.approvalReceiptId, batch.selectedRecipientIds); }
        catch { this.#update(batchId, current => { current.reason = 'current owner approval does not admit new sends'; }); break; }
        await this.#options.broker.authorizeTool(token, 'outreach.send', context.taskId);
        const recipient = manifest.recipients.find(item => item.id === progress.id)!;
        const attachmentIndex = progress.attachments && progress.textState === 'verified' ? progress.attachments.findIndex(item => item.state === 'pending') : undefined;
        const request = effectRequest(manifest, recipient, attachmentIndex);
        if (attachmentIndex !== undefined) {
          const attachment = recipient.attachments![attachmentIndex]!;
          try {
            // Refresh scope/revocation through the vault. The approved payload keeps its original immutable path.
            const resolved = await this.#options.artifacts!.resolveForSend(context, attachment.artifactId);
            const bytes = readFileSync(resolved.path), original = readFileSync((attachment.payload as Record<string, Json>).path as string);
            if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256 || createHash('sha256').update(original).digest('hex') !== attachment.sha256 || bytes.length !== attachment.size) throw new Error('approved attachment changed');
          } catch { this.#update(batchId, current => { const parent = current.recipients.find(item => item.id === recipient.id)!;
            parent.attachments![attachmentIndex]!.state = 'failed'; parent.attachments![attachmentIndex]!.reason = 'approved attachment unavailable or changed'; this.#project(parent, manifest); }); continue; }
        }
        const actualEffectId = this.#options.effectIdentity(context, request);
        const reserved = this.#update(batchId, current => {
          const parent = current.recipients.find(item => item.id === recipient.id)!;
          const actual = attachmentIndex === undefined ? parent : parent.attachments![attachmentIndex]!;
          if (current.state === 'cancelled' || current.manifestHash !== manifest.manifestHash || current.approvalReceiptId !== batch.approvalReceiptId || (attachmentIndex === undefined ? parent.textState ?? actual.state : actual.state) !== 'pending') throw new Error('batch changed before recipient dispatch');
          actual.state = 'dispatching'; actual.effectId = actualEffectId; actual.dispatchContext = clone(context); actual.updatedAt = this.#now(); current.state = 'sending';
          if (attachmentIndex === undefined && parent.attachments) parent.textState = 'dispatching';
        });
        try { await this.#options.broker.executeEffect(token, request); }
        catch (error) {
          // The broker's authority exception before an absent outbox record proves prewire rejection.
          // Generic errors and interrupted reservations remain UNKNOWN rather than being inferred failed.
          if (error instanceof AuthorityError && !this.#options.getEffect(actualEffectId)) this.#update(batchId, current => {
            const parent = current.recipients.find(item => item.id === recipient.id)!;
            const actual = attachmentIndex === undefined ? parent : parent.attachments![attachmentIndex]!;
            if (actual.effectId !== actualEffectId) throw new Error('prewire rejection binding changed');
            actual.prewireRejected = true;
          });
        }
        this.#update(batchId, current => {
          const parent = current.recipients.find(item => item.id === recipient.id)!;
          const actual = attachmentIndex === undefined ? parent : parent.attachments![attachmentIndex]!;
          if (actual.effectId !== actualEffectId || reserved.manifestHash !== current.manifestHash) throw new Error('recipient projection binding changed');
          this.#project(parent, manifest);
        });
        // Failure/UNKNOWN of one selected recipient does not block other independently approved recipients.
      }
      return this.inspect(context, batchId);
    } finally { this.#draining.delete(batchId); }
  }
}

export function outreachTools(service: OutreachService): RegisteredTool[] {
  const route = obj({ peerId: id, threadId: id, replyToMessageId: id }, ['peerId']);
  const sourceRef = obj({ accountId: id, peerId: id, messageId: id, threadId: id }, ['accountId', 'peerId', 'messageId']);
  const attachments = { type: 'array' as const, maxItems: 10, items: obj({ artifactId: id, profile: { type: 'string' as const, enum: ['file', 'photo'] } }, ['artifactId', 'profile']) };
  const recipients = { type: 'array' as const, minItems: 1, maxItems: 50, items: obj({ id, route, text: str(4096), sourceRef, attachments }, ['id', 'route', 'text']) };
  const draft = { name: str(256), recipients, requestKey: id };
  const target = { batchId: id, expectedRevision: int(1, Number.MAX_SAFE_INTEGER) };
  const make = (name: string, description: string, schema: ReturnType<typeof obj>, mutates: boolean, execute: RegisteredTool['execute']): RegisteredTool =>
    ({ name, description, capability: name, inputSchema: schema, mutates, resources: (_args, context) => [context.taskId], execute });
  return [
    make('outreach.propose', 'Save exact recipient drafts and routes for discussion. This grants no external send permission.', obj(draft, ['name', 'recipients']), true,
      async ({ context, args }) => asJson(await service.propose(context, args as unknown as OutreachDraft))),
    make('outreach.revise', 'Create an immutable draft revision before dispatch; original drafts remain recorded and old approval cannot authorize the new revision.', obj({ ...target, ...draft }, ['batchId', 'expectedRevision', 'name', 'recipients']), true,
      async ({ context, args }) => { const { batchId, expectedRevision, ...input } = args; return asJson(await service.revise(context, String(batchId), Number(expectedRevision), input as unknown as OutreachDraft)); }),
    make('outreach.request_approval', 'Propose the exact saved manifest to the owner. A model tool call is not approval; only the owner control path can issue its receipt.', obj(target), true,
      async ({ context, args }) => asJson(await service.requestApproval(context, String(args.batchId), Number(args.expectedRevision)))),
    make('outreach.inspect', 'Read actual per-recipient broker outcomes and verified message receipts. UNKNOWN does not mean sent or pending retry.', obj({ batchId: id }), false,
      async ({ context, args }) => asJson(await service.inspect(context, String(args.batchId)))),
    make('outreach.list', 'List batches belonging only to the current task revision.', obj({}), false,
      async ({ context }) => asJson(await service.list(context))),
    make('outreach.cancel', 'Stop new sends in this batch; preserve and reconcile already-dispatched outcomes.', obj({ batchId: id }), true,
      async ({ context, args }) => asJson(await service.cancel(context, String(args.batchId)))),
    make('outreach.send', 'Dispatch a bounded portion of the exact owner-approved selection. Each recipient remains independent; UNKNOWN is never resent.', obj({ batchId: id, limit: int(1, 20) }, ['batchId']), true,
      async ({ token, args }) => asJson(await service.drain(token, String(args.batchId), Number(args.limit ?? 5)))),
  ];
}
