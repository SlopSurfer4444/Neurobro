import { createHash, randomUUID } from 'node:crypto';
import type { CapabilityGrant, Grant, MessageRef, Observation, TaskIntent, ToolContext } from '../contracts.ts';
import { AuthorityError, canonicalJson } from '../core/broker.ts';
import { hasQuotedAuthorityText } from '../core/authority-text.ts';
import { parseOwnerDirective } from './directives.ts';
import type { MonitorPolicy, OwnerApprovalReceipt, OwnerAuthorityPreparation, OwnerControlOptions, OwnerEffectRequest,
  OwnerEventResult, OwnerProposalPublication, OwnerScopeProposal, OwnerSourceEvidence, OutreachApprovalProposalInput, ResolvedOwnerPeer, SourceScopeProposalInput } from './types.ts';

interface OwnerState extends OwnerSourceEvidence { revokedAt?: string }
interface SourcePlan { id: string; ownerSource: OwnerSourceEvidence; peers: ResolvedOwnerPeer[]; kind: 'read' | 'monitor'; revokedAt?: string; revokedPeers?: string[]; boundTaskId?: string }
const refKey = (ref: MessageRef) => JSON.stringify([ref.accountId, ref.peerId, ref.messageId]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function ownerVersion(observation: Observation): string {
  return digest(JSON.stringify({ ref: observation.ref, authorId: observation.authorId, outgoing: observation.outgoing,
    forwarded: observation.forwarded, viaBot: observation.viaBot, replyTo: observation.replyTo, text: observation.text, sentAt: observation.sentAt,
    editedAt: observation.editedAt, authorityTextRanges: observation.authorityTextRanges,
    attachments: observation.attachments?.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) }));
}
function sameIntent(context: ToolContext, intent: TaskIntent): boolean {
  return context.taskId === intent.id && context.intentRevision === intent.revision;
}
const readCapabilities = ['telegram.history', 'telegram.search', 'telegram.message.get', 'telegram.context', 'telegram.file.get',
  'telegram.participants', 'telegram.poll.results', 'telegram.reactions.get', 'telegram.bot.buttons', 'telegram.schedule.list'];

/** Canonical owner authority registry. The model can propose scope; only fresh owner events admit it. */
export class OwnerControlService {
  private readonly options: OwnerControlOptions;
  constructor(options: OwnerControlOptions) {
    if (!options.accountId || !options.ownerId || !options.controlPeerId) throw new Error('Owner control identity is required');
    this.options = options;
    const identity = { accountId: options.accountId, ownerId: options.ownerId, controlPeerId: options.controlPeerId };
    const old = options.store.get<typeof identity>('metadata', 'ownerControlIdentity');
    if (old && JSON.stringify(old) !== JSON.stringify(identity)) throw new AuthorityError('Owner controls belong to another account/owner/control room');
    options.store.put('metadata', 'ownerControlIdentity', identity);
  }
  private now(): Date { return (this.options.now ?? (() => new Date()))(); }
  private taskActive(taskId: string): boolean {
    const intent = this.options.taskIntent(taskId);
    const grant = intent && this.options.store.get<Grant>('grants', intent.grantId);
    return !!intent && !!grant && grant.taskId === taskId && !grant.revokedAt &&
      (!grant.expiresAt || Date.parse(grant.expiresAt) > this.now().getTime()) && this.options.taskActive(taskId);
  }
  private directOwner(observation: Observation): boolean {
    return observation.ref.accountId === this.options.accountId && observation.authorId === this.options.ownerId && observation.outgoing &&
      !observation.forwarded && !observation.viaBot && !observation.agentEffectId &&
      !this.options.store.get('ownOutputs', refKey(observation.ref));
  }
  private async freshOwner(observation: Observation): Promise<Observation> {
    if (!this.directOwner(observation)) throw new AuthorityError('Authority requires a direct owner utterance, not an agent output or quoted source');
    const fresh = await this.options.telegram.getMessage(observation.ref);
    if (!fresh || refKey(fresh.ref) !== refKey(observation.ref) || !this.directOwner(fresh) || ownerVersion(fresh) !== ownerVersion(observation)) {
      throw new AuthorityError('Owner utterance changed or is unavailable');
    }
    return { ...fresh, contextRefs: observation.contextRefs ?? [] };
  }
  private evidence(observation: Observation): OwnerSourceEvidence {
    return { ref: observation.ref, versionHash: ownerVersion(observation), contextRefs: observation.contextRefs ?? [], admittedAt: this.now().toISOString() };
  }
  private recordOwner(evidence: OwnerSourceEvidence): void {
    const previous = this.options.store.get<OwnerState>('ownerControlSources', refKey(evidence.ref));
    if (previous?.versionHash === evidence.versionHash) {
      if (previous.revokedAt) throw new AuthorityError('Revoked owner instruction cannot be replayed');
      return;
    }
    if (previous && previous.versionHash !== evidence.versionHash) this.revokeOwnerSource(evidence.ref, 'Owner instruction edited');
    this.options.store.put<OwnerState>('ownerControlSources', refKey(evidence.ref), evidence);
  }
  private sourceActive(evidence: OwnerSourceEvidence): boolean {
    const current = this.options.store.get<OwnerState>('ownerControlSources', refKey(evidence.ref));
    return !!current && !current.revokedAt && current.versionHash === evidence.versionHash;
  }
  private commandFresh(observation: Observation): boolean {
    const issuedAt = Date.parse(observation.editedAt ?? observation.sentAt);
    return Number.isFinite(issuedAt) && issuedAt <= this.now().getTime() + 60_000 &&
      this.now().getTime() - issuedAt <= (this.options.proposalTtlMs ?? 30 * 60 * 1000);
  }
  private assertPeer(peer: ResolvedOwnerPeer): ResolvedOwnerPeer {
    if (peer.accountId !== this.options.accountId || typeof peer.peerId !== 'string' || !peer.peerId || peer.peerId.length > 128 ||
        typeof peer.label !== 'string' || !peer.label || peer.label.length > 1024) throw new AuthorityError('Trusted resolver returned a misbound peer');
    return { ...peer };
  }

  /** Called on canonical fresh owner intake before task admission; it never invokes a model or scheduler. */
  async prepareOwnerEvent(observation: Observation): Promise<OwnerEventResult> {
    const result = await this.processOwnerEvent(observation);
    // Derive revocation follow-up from durable records, including after a crash before host grant refresh.
    const key = refKey(observation.ref);
    const affectedTaskIds = [...new Set([
      ...this.options.store.list<MonitorPolicy>('ownerMonitorPolicies').filter(policy => policy.state === 'revoked' && refKey(policy.ownerSource.ref) === key).map(policy => policy.taskId),
      ...this.options.store.list<OwnerApprovalReceipt>('ownerApprovalReceipts').filter(receipt => receipt.revokedAt && refKey(receipt.ownerSource.ref) === key).map(receipt => receipt.context.taskId),
    ])];
    return { ...result, ...(affectedTaskIds.length ? { affectedTaskIds } : {}) };
  }
  private async processOwnerEvent(observation: Observation): Promise<OwnerEventResult> {
    if (observation.kind === 'delete') {
      const source = this.options.store.get<OwnerState>('ownerControlSources', refKey(observation.ref));
      if (!source || observation.ref.accountId !== this.options.accountId || observation.forwarded || observation.viaBot ||
        (observation.authorId !== undefined && observation.authorId !== this.options.ownerId)) return { disposition: 'none' };
      this.revokeOwnerSource(observation.ref, 'Owner instruction deleted'); return { disposition: 'revoked' };
    }
    if (!this.directOwner(observation) || (observation.ref.peerId !== this.options.controlPeerId && !/^\/бро(?:\s|$)/iu.test(observation.text ?? ''))) return { disposition: 'none' };
    const eventKey = digest(observation.id + ':' + observation.kind + ':' + ownerVersion(observation));
    const known = this.options.store.get<OwnerEventResult>('ownerControlEvents', eventKey);
    const fresh = await this.freshOwner(observation);
    const evidence = this.evidence(fresh); this.recordOwner(evidence);
    if (known) {
      if (known.disposition === 'accepted' && known.proposal) {
        const active = known.proposal.kind === 'sources'
          ? this.options.store.list<MonitorPolicy>('ownerMonitorPolicies').some(policy => policy.taskId === known.proposal!.context.taskId &&
            refKey(policy.ownerSource.ref) === refKey(evidence.ref) && this.policyActive(policy))
          : this.activeReceipts(known.proposal.context.taskId).some(receipt => receipt.id === known.receipt?.id);
        if (!active) return { disposition: 'ambiguous', reason: 'Это подтверждение было учтено раньше; текущее разрешение уже не действует. Повторное разрешение не создано.' };
      }
      return structuredClone(known);
    }
    const directive = parseOwnerDirective(fresh.text ?? '');
    if (!directive) return { disposition: 'none' }; // Natural-language proposals remain proposals until the owner accepts their card.
    if (hasQuotedAuthorityText(fresh)) return { disposition: 'none' };
    if (!this.commandFresh(fresh)) {
      return { disposition: 'ambiguous', reason: 'Это подтверждение устарело. Пришли свежее поручение.' };
    }
    if (directive.kind === 'approve' || directive.kind === 'reject') {
      const result = await this.confirm(fresh, evidence, directive); this.options.store.put('ownerControlEvents', eventKey, result); return result;
    }
    const peers: ResolvedOwnerPeer[] = [];
    for (const selector of directive.selectors) peers.push(this.assertPeer(await this.options.telegram.resolveSource(selector)));
    if (directive.forwardedSource) {
      const material = fresh.replyTo && await this.options.telegram.getMessage(fresh.replyTo);
      const peer = material && await this.options.telegram.resolveForwardSource(material);
      if (!peer) return { disposition: 'ambiguous', reason: 'Источник пересылки скрыт или не определён. Укажи точную ссылку или имя источника.' };
      peers.push(this.assertPeer(peer));
    }
    if (!peers.length) return { disposition: 'ambiguous', reason: 'Выбери хотя бы один конкретный источник.' };
    await this.freshOwner(observation); // Resolver waits do not extend stale/edited owner authority.
    if (!this.commandFresh(fresh) || !this.sourceActive(evidence)) return { disposition: 'ambiguous', reason: 'Поручение устарело или отозвано во время проверки. Пришли свежее поручение.' };
    if (directive.kind === 'unsubscribe') {
      for (const peer of peers) this.revokeSource(peer.peerId, 'Owner unsubscribed source');
      const result: OwnerEventResult = { disposition: 'revoked' }; this.options.store.put('ownerControlEvents', eventKey, result); return result;
    }
    const plan: SourcePlan = { id: digest(refKey(evidence.ref) + ':' + evidence.versionHash), ownerSource: evidence,
      peers: [...new Map(peers.map(peer => [peer.peerId, peer])).values()], kind: directive.kind === 'observe' ? 'monitor' : 'read' };
    this.options.store.put('ownerSourcePlans', plan.id, plan);
    const result: OwnerEventResult = { disposition: 'source-plan' }; this.options.store.put('ownerControlEvents', eventKey, result); return result;
  }

  /** Model-facing source proposal creates no grants and reads no source history. */
  async proposeSources(input: SourceScopeProposalInput): Promise<OwnerScopeProposal> {
    this.options.validateAuthority(input.context);
    if (!input.sources.length || input.sources.length > 32) throw new Error('Source proposal must contain 1..32 exact sources');
    if (!this.options.telegram.verifyPeer) throw new AuthorityError('Exact source proposal resolver is unavailable');
    const sources: ResolvedOwnerPeer[] = [];
    for (const candidate of input.sources) {
      const peer = this.assertPeer(await this.options.telegram.verifyPeer(this.assertPeer(candidate)));
      if (peer.peerId !== candidate.peerId) throw new AuthorityError('Source proposal changed its exact peer');
      sources.push(peer);
    }
    this.options.validateAuthority(input.context);
    const proposal = this.createProposal(input.context, input.title ?? 'Выбранные источники', input.expiresAt);
    Object.assign(proposal, { kind: 'sources', sources: [...new Map(sources.map(peer => [peer.peerId, peer])).values()], monitor: input.monitor });
    this.options.store.put('ownerScopeProposals', proposal.id, proposal); return proposal;
  }
  proposeApproval(input: OutreachApprovalProposalInput): OwnerScopeProposal {
    this.options.validateAuthority(input.context);
    if (!input.objectId || !Number.isSafeInteger(input.batchRevision) || input.batchRevision < 1 || !/^[a-f0-9]{64}$/u.test(input.manifestHash) ||
        !input.recipients.length || input.recipients.length > 100 || new Set(input.recipients.map(item => item.id)).size !== input.recipients.length ||
        input.recipients.some(item => !item.id || !item.peerId || !/^[a-f0-9]{64}$/u.test(item.payloadHash))) throw new Error('Invalid immutable outreach approval proposal');
    for (const recipient of input.recipients) if (recipient.effects) {
      const prefix = 'outreach:' + input.objectId + ':revision:' + input.batchRevision + ':recipient:' + recipient.id;
      if (!recipient.effects.length || recipient.effects.length > 11 || new Set(recipient.effects.map(effect => effect.operationId)).size !== recipient.effects.length ||
        recipient.effects.some(effect => !/^[a-f0-9]{64}$/u.test(effect.payloadHash) ||
          !(effect.capability === 'telegram.send' && effect.operationId === prefix && effect.payloadHash === recipient.payloadHash ||
            effect.capability === 'telegram.media.send' && effect.operationId.startsWith(prefix + ':attachment:') && /^\d+$/u.test(effect.operationId.slice((prefix + ':attachment:').length))))) {
        throw new Error('Invalid immutable outreach operation binding');
      }
    }
    const proposal = this.createProposal(input.context, input.title ?? 'Выбранная отправка', input.expiresAt);
    Object.assign(proposal, { kind: 'outreach', objectId: input.objectId, batchRevision: input.batchRevision,
      manifestHash: input.manifestHash, recipients: structuredClone(input.recipients) });
    this.options.store.put('ownerScopeProposals', proposal.id, proposal); return proposal;
  }
  private createProposal(context: ToolContext, title: string, expiresAt?: string): OwnerScopeProposal {
    const end = expiresAt ? Date.parse(expiresAt) : this.now().getTime() + (this.options.proposalTtlMs ?? 30 * 60 * 1000);
    if (!Number.isFinite(end) || end <= this.now().getTime() || end > this.now().getTime() + 24 * 60 * 60 * 1000) throw new Error('Proposal deadline is invalid');
    return { id: randomUUID(), kind: 'sources', context: { ...context }, state: 'pending', title: title.slice(0, 1024),
      expiresAt: new Date(end).toISOString(), createdAt: this.now().toISOString() };
  }
  /** Trusted host records the actual private proposal message; the model cannot claim a card identity. */
  registerCard(proposalId: string, ref: MessageRef): void {
    const proposal = this.proposal(proposalId);
    if (ref.accountId !== this.options.accountId || ref.peerId !== this.options.controlPeerId || !this.options.store.get('ownOutputs', refKey(ref))) {
      throw new AuthorityError('Approval card must be a recorded private agent output');
    }
    if (proposal.cardRef && refKey(proposal.cardRef) !== refKey(ref)) throw new AuthorityError('Proposal card identity is immutable');
    proposal.cardRef = ref; this.options.store.put('ownerScopeProposals', proposalId, proposal);
  }
  /** Publication is a trusted host lifecycle, separate from the owner's pending/accepted decision. */
  recordPublication(proposalId: string, publication: OwnerProposalPublication): void {
    this.options.store.transaction(() => {
      const proposal = this.proposal(proposalId), previous = proposal.publication;
      for (const part of ['manifest', 'card'] as const) {
        const old = previous?.[part], next = publication[part];
        if (old && (!next || old.effectId !== next.effectId || old.payloadHash !== next.payloadHash || old.artifactId !== next.artifactId)) {
          throw new AuthorityError('Proposal publication effect identity is immutable');
        }
      }
      if (previous?.state === 'verified' && publication.state !== 'verified') throw new AuthorityError('Verified proposal publication cannot be downgraded');
      proposal.publication = structuredClone(publication); this.options.store.put('ownerScopeProposals', proposal.id, proposal);
    });
  }
  proposal(proposalId: string): OwnerScopeProposal {
    const proposal = this.options.store.get<OwnerScopeProposal>('ownerScopeProposals', proposalId);
    if (!proposal) throw new Error('Unknown owner scope proposal');
    return proposal;
  }
  listProposals(context: ToolContext): OwnerScopeProposal[] {
    this.options.validateAuthority(context);
    return this.options.store.list<OwnerScopeProposal>('ownerScopeProposals').filter(proposal => proposal.context.taskId === context.taskId && proposal.context.intentRevision === context.intentRevision);
  }
  private async confirm(observation: Observation, evidence: OwnerSourceEvidence,
    directive: { kind: 'approve' | 'reject'; proposalId?: string; selectedIds?: string[] }): Promise<OwnerEventResult> {
    let candidates = this.options.store.list<OwnerScopeProposal>('ownerScopeProposals').filter(item => item.state === 'pending' && Date.parse(item.expiresAt) > this.now().getTime());
    if (directive.proposalId) candidates = candidates.filter(item => item.id === directive.proposalId || item.id.startsWith(directive.proposalId!));
    else if (observation.replyTo) candidates = candidates.filter(item => item.cardRef && refKey(item.cardRef) === refKey(observation.replyTo!));
    else return { disposition: 'ambiguous', reason: 'Ответь на карточку конкретного предложения.' };
    if (candidates.length !== 1) return { disposition: 'ambiguous', reason: 'Выбери одно действующее предложение и ответь на его карточку.' };
    const proposal = candidates[0]!;
    // Native Telegram timestamps have second precision; card readback/message identity orders that second.
    if (!proposal.cardRef || Date.parse(observation.editedAt ?? observation.sentAt) < Math.floor(Date.parse(proposal.createdAt) / 1000) * 1000) {
      return { disposition: 'ambiguous', reason: 'Подтверждение должно относиться к уже опубликованной карточке предложения.' };
    }
    const card = await this.options.telegram.getMessage(proposal.cardRef);
    if (!card || refKey(card.ref) !== refKey(proposal.cardRef) || !Number.isFinite(Date.parse(card.sentAt)) ||
        Date.parse(observation.editedAt ?? observation.sentAt) < Date.parse(card.sentAt) ||
        !observation.editedAt && observation.ref.peerId === card.ref.peerId && /^\d+$/u.test(observation.ref.messageId) && /^\d+$/u.test(card.ref.messageId) &&
          BigInt(observation.ref.messageId) <= BigInt(card.ref.messageId)) {
      return { disposition: 'ambiguous', reason: 'Не удалось подтвердить, что карточка была опубликована до твоего ответа. Ответь на действующую карточку.' };
    }
    await this.freshOwner(observation);
    const currentProposal = this.proposal(proposal.id);
    if (currentProposal.state !== 'pending' || Date.parse(currentProposal.expiresAt) <= this.now().getTime() || !this.commandFresh(observation) || !this.sourceActive(evidence)) {
      return { disposition: 'ambiguous', reason: 'Предложение устарело, отозвано или уже рассмотрено. Новое разрешение не сохранено.' };
    }
    this.validateProposalAuthority(proposal);
    if (directive.kind === 'reject') { proposal.state = 'rejected'; this.options.store.put('ownerScopeProposals', proposal.id, proposal); return { disposition: 'rejected', proposal }; }
    if (proposal.kind === 'sources') {
      if (directive.selectedIds) return { disposition: 'ambiguous', reason: 'Для части источников нужна новая карточка с точным списком.' };
      if (!this.options.telegram.verifyPeer) throw new AuthorityError('Exact source proposal resolver is unavailable');
      for (const source of proposal.sources!) {
        const peer = this.assertPeer(await this.options.telegram.verifyPeer(source));
        if (peer.peerId !== source.peerId) throw new AuthorityError('Proposed source is no longer exact');
      }
      await this.freshOwner(observation);
      return this.options.store.transaction(() => {
        const current = this.proposal(proposal.id);
        if (current.state !== 'pending' || Date.parse(current.expiresAt) <= this.now().getTime() || !this.commandFresh(observation) || !this.sourceActive(evidence)) {
          return { disposition: 'ambiguous', reason: 'Предложение устарело, отозвано или уже рассмотрено. Новое разрешение не сохранено.' };
        }
        this.validateProposalAuthority(current);
        const plan: SourcePlan = { id: 'proposal:' + current.id, ownerSource: evidence, peers: current.sources!, kind: current.monitor ? 'monitor' : 'read' };
        this.options.store.put('ownerSourcePlans', plan.id, plan); this.bindPlan(this.options.taskIntent(current.context.taskId)!, plan);
        current.state = 'accepted'; this.options.store.put('ownerScopeProposals', current.id, current);
        return { disposition: 'accepted', proposal: current };
      });
    }
    const selected = directive.selectedIds ?? proposal.recipients!.map(item => item.id);
    if (!selected.length || selected.some(id => !proposal.recipients!.some(item => item.id === id))) return { disposition: 'ambiguous', reason: 'В выборе есть неизвестный получатель. Ответь на точную карточку отправки.' };
    const receipt: OwnerApprovalReceipt = { id: randomUUID(), context: { ...proposal.context }, ownerSource: evidence,
      objectKind: 'outreach', objectId: proposal.objectId!, batchRevision: proposal.batchRevision!, manifestHash: proposal.manifestHash!,
      selectedRecipientIds: [...selected], recipients: proposal.recipients!.filter(item => selected.includes(item.id)),
      expiresAt: new Date(Math.min(Date.parse(proposal.expiresAt), this.now().getTime() + (this.options.outreachTtlMs ?? 30 * 60 * 1000))).toISOString() };
    this.options.store.transaction(() => {
      const current = this.proposal(proposal.id);
      if (current.state !== 'pending' || Date.parse(current.expiresAt) <= this.now().getTime() || !this.commandFresh(observation) || !this.sourceActive(evidence)) throw new AuthorityError('Предложение уже рассмотрено, устарело или отозвано.');
      this.validateProposalAuthority(current);
      this.options.store.put('ownerApprovalReceipts', receipt.id, receipt);
      current.state = 'accepted'; current.receiptId = receipt.id; current.selectedRecipientIds = [...selected];
      this.options.store.put('ownerScopeProposals', current.id, current);
    });
    return { disposition: 'accepted', proposal: this.proposal(proposal.id), receipt };
  }
  private validateProposalAuthority(proposal: OwnerScopeProposal): void {
    const intent = this.options.taskIntent(proposal.context.taskId);
    const grant = intent && this.options.store.get<Grant>('grants', intent.grantId);
    if (!intent || !sameIntent(proposal.context, intent) || !grant || !this.taskActive(intent.id)) throw new AuthorityError('Proposal no longer belongs to a current owner task');
    // A separate fresh owner approval may have changed the grant epoch, never the proposal manifest/intention.
    this.options.validateAuthority({ ...proposal.context, grantId: grant.id, grantRevision: grant.revision });
  }
  private bindPlan(intent: TaskIntent, plan: SourcePlan): void {
    if (!intent || plan.revokedAt || !this.sourceActive(plan.ownerSource) || (plan.boundTaskId && plan.boundTaskId !== intent.id)) return;
    if (!plan.boundTaskId) { plan.boundTaskId = intent.id; this.options.store.put('ownerSourcePlans', plan.id, plan); }
    for (const peer of plan.peers) {
      if (plan.revokedPeers?.includes(peer.peerId)) continue;
      const id = digest(intent.id + ':' + plan.id + ':' + peer.peerId);
      if (this.options.store.get('ownerMonitorPolicies', id)) continue;
      const policy: MonitorPolicy = { id, taskId: intent.id, sourcePeerId: peer.peerId, label: peer.label, revision: 1,
        ownerSource: plan.ownerSource, kind: plan.kind, state: 'active', createdAt: this.now().toISOString(),
        ...(plan.kind === 'read' ? { expiresAt: new Date(Date.parse(plan.ownerSource.admittedAt) + (this.options.readTtlMs ?? 7 * 24 * 60 * 60 * 1000)).toISOString() } : {}) };
      this.options.store.put('ownerMonitorPolicies', id, policy);
    }
  }
  getMonitorPolicies(taskId?: string): MonitorPolicy[] {
    return this.options.store.list<MonitorPolicy>('ownerMonitorPolicies').filter(policy => policy.kind === 'monitor' &&
      (!taskId || policy.taskId === taskId) && this.policyActive(policy));
  }
  private policyActive(policy: MonitorPolicy): boolean {
    return policy.state === 'active' && (!policy.expiresAt || Date.parse(policy.expiresAt) > this.now().getTime()) &&
      this.sourceActive(policy.ownerSource) && this.taskActive(policy.taskId);
  }
  getReadPeers(taskId: string): string[] {
    return [...new Set(this.options.store.list<MonitorPolicy>('ownerMonitorPolicies').filter(policy => policy.taskId === taskId && this.policyActive(policy)).map(policy => policy.sourcePeerId))];
  }
  contextReadScopes(taskId: string): string[] { return this.getReadPeers(taskId).map(peer => 'chat:' + peer); }
  prepareAuthority(intent: TaskIntent): OwnerAuthorityPreparation {
    for (const plan of this.options.store.list<SourcePlan>('ownerSourcePlans')) {
      if (refKey(plan.ownerSource.ref) === refKey(intent.source) || plan.ownerSource.contextRefs.some(ref => intent.contextRefs.includes(ref))) this.bindPlan(intent, plan);
    }
    const peers = this.getReadPeers(intent.id);
    const capabilities = this.options.baseCapabilities(intent).map(grant => ({ ...grant, resources: [...grant.resources] }));
    for (const capability of ['owner.sources.propose', 'owner.sources.inspect']) {
      const existing = capabilities.find(grant => grant.capability === capability);
      if (existing) existing.resources = [...new Set([...existing.resources, 'owner-controls'])];
      else capabilities.push({ capability, resources: ['owner-controls'] });
    }
    for (const capability of readCapabilities) {
      const grant = capabilities.find(item => item.capability === capability);
      if (grant) grant.resources = [...new Set([...grant.resources, ...peers])];
      else capabilities.push({ capability, resources: [...peers] });
    }
    const recipients = this.activeReceipts(intent.id).flatMap(receipt => receipt.recipients.map(item => item.peerId));
    const send = capabilities.find(item => item.capability === 'telegram.send');
    if (send) send.resources = [...new Set([...send.resources, ...recipients])];
    else capabilities.push({ capability: 'telegram.send', resources: [...new Set(recipients)] });
    const mediaRecipients = this.activeReceipts(intent.id).flatMap(receipt => receipt.recipients.filter(item => item.effects?.some(effect => effect.capability === 'telegram.media.send')).map(item => item.peerId));
    const media = capabilities.find(item => item.capability === 'telegram.media.send');
    if (media) media.resources = [...new Set([...media.resources, ...mediaRecipients])];
    else if (mediaRecipients.length) capabilities.push({ capability: 'telegram.media.send', resources: [...new Set(mediaRecipients)] });
    // Standing monitor lifetime is independent of the core's bounded public-reply resource authority.
    // With no monitor, restore the original ordinary grant deadline rather than retain a cleared TTL.
    const baseline = this.options.store.get<{ expiresAt: string }>('grantBaselines', intent.grantId);
    return { capabilities, ...(this.getMonitorPolicies(intent.id).length ? { expiresAt: null } : baseline ? { expiresAt: baseline.expiresAt } : {}) };
  }
  private activeReceipts(taskId: string): OwnerApprovalReceipt[] {
    const intent = this.options.taskIntent(taskId);
    return this.options.store.list<OwnerApprovalReceipt>('ownerApprovalReceipts').filter(receipt => intent && sameIntent(receipt.context, intent) &&
      !receipt.revokedAt && Date.parse(receipt.expiresAt) > this.now().getTime() && this.sourceActive(receipt.ownerSource) && this.taskActive(taskId));
  }
  async getOutreachApproval(context: ToolContext, receiptId: string, objectId: string, batchRevision: number,
    manifestHash: string, selectedIds: readonly string[]): Promise<OwnerApprovalReceipt> {
    this.options.validateAuthority(context);
    const receipt = this.activeReceipts(context.taskId).find(item => item.id === receiptId);
    if (!receipt || receipt.objectId !== objectId || receipt.batchRevision !== batchRevision || receipt.manifestHash !== manifestHash ||
        receipt.selectedRecipientIds.length !== selectedIds.length || receipt.selectedRecipientIds.some(id => !selectedIds.includes(id))) throw new AuthorityError('Outreach batch has no matching fresh owner authorization');
    const fresh = await this.options.telegram.getMessage(receipt.ownerSource.ref);
    if (!fresh || !this.directOwner(fresh) || ownerVersion(fresh) !== receipt.ownerSource.versionHash) {
      this.revokeOwnerSource(receipt.ownerSource.ref, 'Owner confirmation changed or was deleted');
      throw new AuthorityError('Owner outreach confirmation changed or was deleted');
    }
    this.options.validateAuthority(context);
    const current = this.activeReceipts(context.taskId).find(item => item.id === receiptId);
    if (!current || JSON.stringify(current) !== JSON.stringify(receipt)) throw new AuthorityError('Owner outreach authorization was withdrawn or expired during readback');
    return structuredClone(current);
  }
  validateEffect(context: ToolContext, request: OwnerEffectRequest): void {
    const intent = this.options.taskIntent(context.taskId) ?? this.options.store.get<TaskIntent & { controlOnly?: boolean }>('tasks', context.taskId);
    if (intent && 'controlOnly' in intent && intent.controlOnly === true && intent.ownerId === this.options.ownerId && intent.accountId === this.options.accountId &&
      sameIntent(context, intent) && intent.route.peerId === this.options.controlPeerId && request.capability === 'telegram.send' && request.resource === this.options.controlPeerId) return;
    if (!intent || !sameIntent(context, intent) || !this.taskActive(context.taskId)) throw new AuthorityError('Owner task authority is not current');
    if (!['telegram.send', 'telegram.media.send'].includes(request.capability)) return;
    if (request.resource === this.options.controlPeerId || request.resource === intent.route.peerId) return;
    const payloadHash = digest(canonicalJson(request.payload));
    if (!this.activeReceipts(intent.id).some(receipt => receipt.recipients.some(item => item.peerId === request.resource && (
      (request.capability === 'telegram.send' && item.payloadHash === payloadHash && request.id === 'outreach:' + receipt.objectId + ':revision:' + receipt.batchRevision + ':recipient:' + item.id) ||
      item.effects?.some(effect => effect.operationId === request.id && effect.capability === request.capability && effect.payloadHash === payloadHash))))) {
      throw new AuthorityError('External recipient/payload was not selected in a current concrete owner batch');
    }
  }
  /** Revoked dynamic source reads fail immediately, including tokens issued before unsubscribe. */
  validateResource(context: ToolContext, capability: string, resource: string): void {
    if (!readCapabilities.includes(capability) && capability !== 'telegram.read') return;
    const policies = this.options.store.list<MonitorPolicy>('ownerMonitorPolicies').filter(policy => policy.taskId === context.taskId && policy.sourcePeerId === resource);
    if (policies.length && !policies.some(policy => this.policyActive(policy))) throw new AuthorityError('Owner source policy is revoked or expired');
  }
  revokeOwnerSource(ref: MessageRef, reason: string): void {
    const now = this.now().toISOString(); const key = refKey(ref);
    this.options.store.transaction(() => {
      const current = this.options.store.get<OwnerState>('ownerControlSources', key);
      if (current) this.options.store.put('ownerControlSources', key, { ...current, revokedAt: now });
      for (const policy of this.options.store.list<MonitorPolicy>('ownerMonitorPolicies')) if (refKey(policy.ownerSource.ref) === key && policy.state === 'active') {
        Object.assign(policy, { state: 'revoked', revokedAt: now, reason, revision: policy.revision + 1 }); this.options.store.put('ownerMonitorPolicies', policy.id, policy);
      }
      for (const plan of this.options.store.list<SourcePlan>('ownerSourcePlans')) if (refKey(plan.ownerSource.ref) === key) this.options.store.put('ownerSourcePlans', plan.id, { ...plan, revokedAt: now });
      for (const receipt of this.options.store.list<OwnerApprovalReceipt>('ownerApprovalReceipts')) if (refKey(receipt.ownerSource.ref) === key) this.options.store.put('ownerApprovalReceipts', receipt.id, { ...receipt, revokedAt: now });
    });
  }
  revokeSource(peerId: string, reason = 'Owner unsubscribed source'): void {
    const now = this.now().toISOString();
    this.options.store.transaction(() => {
      for (const policy of this.options.store.list<MonitorPolicy>('ownerMonitorPolicies')) if (policy.sourcePeerId === peerId && policy.state === 'active') {
        Object.assign(policy, { state: 'revoked', revokedAt: now, reason, revision: policy.revision + 1 }); this.options.store.put('ownerMonitorPolicies', policy.id, policy);
      }
      for (const plan of this.options.store.list<SourcePlan>('ownerSourcePlans')) if (plan.peers.some(peer => peer.peerId === peerId)) {
        plan.revokedPeers = [...new Set([...(plan.revokedPeers ?? []), peerId])]; this.options.store.put('ownerSourcePlans', plan.id, plan);
      }
    });
  }
}
