import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CapabilityGrant, Effect, EffectResult, Json, Observation, ToolContext } from './contracts.ts';
import type { PersonalConfig } from './config.ts';
import { PersonalHost, type HostCapabilityStatus } from './host.ts';
import { OwnerControlService, ownerControlTools, type OwnerEventResult, type OwnerProposalPublication, type OwnerProposalPublicationPart, type OwnerScopeProposal, type ResolvedOwnerPeer } from './owner-controls/index.ts';
import { sourceProposalPresentation } from './owner-controls/presentation.ts';
import { OutreachService, outreachTools } from './outreach/index.ts';
import { OutreachReplyService, outreachReplyTools } from './outreach/replies.ts';
import { ContinuousMonitorCoordinator, createObservationTools, type MonitorCandidate, type MonitorDigest, type Subscription } from './observation/index.ts';
import { HermesScheduleCoordinator, createScheduleTools, type ScheduleOptions } from './hermes/schedules.ts';
import { createScheduleDelivery } from './schedule-delivery.ts';
import { createMonitorSource } from './monitor-source.ts';
import { createToolRegistry, WebService, type CatalogOptions, type RegisteredTool } from './capabilities/index.ts';
import type { ToolCall } from './capabilities/types.ts';
import { obj, str } from './capabilities/schema.ts';
import { canonicalJson, effectOperationId } from './core/broker.ts';
import { memoryTools } from './memory/tools.ts';
import { artifactTools } from './artifacts/tools.ts';
import { createArtifactTools } from './artifacts/create.ts';
import { createArtifactVisionTools } from './artifacts/vision.ts';
import { ArtifactInspector } from './artifacts/inspect.ts';
import { createNativeSkillTools, type NativeSkillToolsOptions, type NativeSkillDescriptor } from './hermes/cognition.ts';
import { deliveryParts } from './core/controller.ts';
import { DocumentLibrary } from './documents/index.ts';
import { documentTools } from './documents/tools.ts';
import { LocalCodexContext } from './desktop-context/index.ts';
import { desktopContextTools } from './desktop-context/tools.ts';
import { githubTools } from './github/index.ts';

export interface PersonalWorkflowOptions {
  host: PersonalHost; config: PersonalConfig; hermesHome: string;
  telegram: CatalogOptions['telegram'] & { status?(): { coverage: 'snapshot-only' | 'gap' } };
  nativeSchedules?: ScheduleOptions['native'];
  web?: CatalogOptions['web']; jobs: NonNullable<CatalogOptions['jobs']>['store'];
  extraTools?: RegisteredTool[];
  nativeCognition?: Pick<NativeSkillToolsOptions, 'native' | 'resolveSession'>;
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const outreachCapabilities = ['outreach.propose','outreach.revise','outreach.request_approval','outreach.inspect','outreach.list','outreach.cancel','outreach.send','outreach.replies'];
const monitorCapabilities = ['monitors.subscribe','monitors.list','monitors.inspect','monitors.collect','monitors.candidate_read','monitors.decide','monitors.unsubscribe','monitors.pause','monitors.resume','monitors.reschedule'];

/** The same trusted composition is used by the installed app and offline workflow tests.
 * Hermes remains the sole timer/model planner; this factory creates no background loop. */
export function createPersonalWorkflows(options: PersonalWorkflowOptions) {
  const { host, config, telegram } = options, agent = host.agent, artifacts = host.toolArtifacts();
  let monitors: ContinuousMonitorCoordinator | undefined;
  const scope = (context: ToolContext) => ({ ownerId: config.account.ownerId, taskId: context.taskId });
  const library = config.documents?.enabled ? new DocumentLibrary({ databasePath: join(config.stateDirectory, 'documents.sqlite'), encryptionKey: host.options.encryptionKey, artifacts: host.artifacts }) : undefined;
  const desktop = config.desktopContext?.enabled ? new LocalCodexContext(config.desktopContext) : undefined;
  const privateTools = (tools: RegisteredTool[]): RegisteredTool[] => tools.map(tool => ({ ...tool, async execute(call) {
    await host.authorizePrivateOwner(call.context); const result = await tool.execute(call); await host.authorizePrivateOwner(call.context); return result;
  } }));
  const trackedArtifacts = (tools: RegisteredTool[]): RegisteredTool[] => tools.map(tool => ({ ...tool, async execute(call) {
    const result=await tool.execute(call);
    if(['artifacts.inspect','artifacts.read','artifacts.stage','artifacts.view_image','documents.import'].includes(tool.name)){
      const ids:string[]=[];
      if(typeof call.args.artifactId==='string')ids.push(call.args.artifactId);
      if(Array.isArray(call.args.artifactIds))ids.push(...call.args.artifactIds.filter((id):id is string=>typeof id==='string'));
      if(tool.name==='documents.import'&&result&&typeof result==='object'&&!Array.isArray(result)){
        const artifact=result.artifact;if(artifact&&typeof artifact==='object'&&!Array.isArray(artifact)&&typeof artifact.id==='string')ids.push(artifact.id);
      }
      if(ids.length)host.admitArtifactRead(call.context,ids);
    }
    return result;
  }}));
  function digestPayloads(summary: Readonly<MonitorDigest>, subscription: Readonly<Subscription>): Json[] {
    const candidates = summary.candidateIds.map(id => agent.store.get<MonitorCandidate>('observation/candidates', id));
    if(candidates.some(item => !item || item.subscriptionId !== subscription.id || !item.decision?.match)) throw new Error('Digest membership is invalid');
    const text = `Сводка: ${subscription.spec.name}\nПодходящих новых материалов: ${candidates.length}\n\n` + candidates.map((item,index) => {
      const candidate = item!;
      return `${index+1}. ${candidate.alert.title}\n${candidate.decision!.reason}\n${candidate.alert.text}\nИсточник: ${candidate.alert.resource}, запись ${candidate.alert.itemId}`;
    }).join('\n\n');
    return deliveryParts(text).map(text => ({ peerId: config.account.controlPeerId, text }));
  }
  function monitorPayload(candidate: Readonly<MonitorCandidate>, subscription: Readonly<Subscription>): Json {
    const text = `Новый материал: ${subscription.spec.name}\nИсточник ${candidate.alert.resource}, запись ${candidate.alert.itemId}\n${candidate.decision?.reason ?? ''}\n${candidate.alert.title}\n${candidate.alert.text}`;
    return { peerId: config.account.controlPeerId, text: text.length <= 3500 ? text : text.slice(0, 3400) + '\n[Уведомление сокращено; полный источник сохранён в кандидате.]' };
  }
  async function resolveSource(selector: string): Promise<ResolvedOwnerPeer> {
    if (!telegram.resolvePeer) throw new Error('Exact Telegram source resolution is unavailable');
    const peer = await telegram.resolvePeer(selector);
    if (peer.accountId !== config.account.id || peer.kind === 'bot') throw new Error('Source resolver returned an unsupported account/peer');
    return { accountId: peer.accountId, peerId: peer.peerId, label: peer.title, kind: peer.kind, ...(peer.username ? { username: peer.username } : {}) };
  }
  const ownerControls = new OwnerControlService({ store: agent.store, telegram: {
    getMessage: ref => telegram.getMessage(ref), resolveSource,
    async verifyPeer(peer) { const fresh = await resolveSource(peer.peerId); if (fresh.peerId !== peer.peerId) throw new Error('Source peer changed'); return fresh; },
    async resolveForwardSource(observation) {
      const fresh = await telegram.getMessage(observation.ref), origin = fresh?.forwardOrigin;
      const peerId = origin?.kind === 'channel' ? origin.ref.peerId : origin?.kind === 'chat' ? origin.peerId : undefined;
      if (!fresh?.forwarded || !peerId) return undefined;
      return { ...await resolveSource(peerId), ...(origin?.kind === 'channel' ? { sourceRef: origin.ref } : {}) };
    },
  }, accountId: config.account.id, ownerId: config.account.ownerId, controlPeerId: config.account.controlPeerId,
    taskIntent: id => agent.status(id)?.intent,
    taskActive: id => { const status = agent.status(id); return !!status && !status.cancelledAt && !status.heldAt; },
    validateAuthority: context => { agent.validateAuthority(context); },
    baseCapabilities: intent => [...host.getBaseCapabilities(intent), ...[...outreachCapabilities, ...(options.nativeSchedules ? monitorCapabilities : [])].map(capability => ({ capability, resources: [intent.id] }))] as CapabilityGrant[],
  });
  host.setOwnerControls({
    prepareOwnerEvent: observation => ownerControls.prepareOwnerEvent(observation),
    prepareAuthority: intent => ownerControls.prepareAuthority(intent), getReadPeers: id => ownerControls.getReadPeers(id),
    getMonitorPolicies: id => ownerControls.getMonitorPolicies(id), validateResource: (...args) => ownerControls.validateResource(...args),
    revokeOwnerSource: (ref, reason) => ownerControls.revokeOwnerSource(ref, reason),
    validateEffect(context, request) {
      ownerControls.validateEffect(context, request);
      if (!monitors?.isMonitorExecution(context) || !request.capability.startsWith('telegram.')) return;
      const digest = agent.store.list<MonitorDigest>('observation/digests').find(item => item.runId === context.runId &&
        item.delivery.state === 'dispatching' && typeof request.id === 'string' && request.id.startsWith(item.delivery.effectId + ':part:'));
      if (digest) {
        const subscription = agent.store.get<Subscription>('observation/subscriptions', digest.subscriptionId);
        const index = Number(request.id!.slice(digest.delivery.effectId.length + ':part:'.length));
        if (request.capability !== 'telegram.send' || request.resource !== config.account.controlPeerId || !subscription || subscription.state !== 'active' ||
          subscription.binding.taskId !== context.taskId || !subscription.nativeJobId || !context.runId.startsWith(`cron:${subscription.nativeJobId}:`) ||
          !Number.isSafeInteger(index) || index < 0 || request.id !== `${digest.delivery.effectId}:part:${index}` ||
          canonicalJson(request.payload) !== canonicalJson(digestPayloads(digest,subscription)[index] ?? null)) throw new Error('Monitor digest requires exact saved private parts');
        return;
      }
      const candidate = agent.store.list<MonitorCandidate>('observation/candidates').find(item => item.delivery?.effectId === request.id);
      const subscription = candidate && agent.store.get<Subscription>('observation/subscriptions', candidate.subscriptionId);
      if (request.capability !== 'telegram.send' || request.resource !== config.account.controlPeerId || !candidate?.decision?.match ||
        candidate.delivery?.state !== 'dispatching' || !subscription || subscription.state !== 'active' ||
        subscription.binding.taskId !== context.taskId || subscription.nativeJobId === undefined || !context.runId.startsWith(`cron:${subscription.nativeJobId}:`) ||
        canonicalJson(request.payload) !== canonicalJson(monitorPayload(candidate, subscription))) throw new Error('Monitor sends require an exact saved semantic match and host private alert payload');
    },
  });

  function proposalEffect(proposal: OwnerScopeProposal, part: 'manifest' | 'card', binding?: OwnerProposalPublicationPart): Effect | undefined {
    const capability = part === 'card' ? 'telegram.send' : 'telegram.media.send';
    const expectedId = effectOperationId(proposal.context, { id: `owner-card:${proposal.id}:${part}`, capability, resource: config.account.controlPeerId, payload: null });
    if (binding && binding.effectId !== expectedId) throw new Error('Proposal publication effect is misbound');
    const effect = agent.store.get<Effect>('effects', expectedId);
    if (!effect) return undefined;
    if (effect.taskId !== proposal.context.taskId || effect.intentRevision !== proposal.context.intentRevision || effect.capability !== capability ||
      effect.resource !== config.account.controlPeerId || binding && effect.payloadHash !== binding.payloadHash) throw new Error('Proposal publication effect identity changed');
    return effect;
  }
  function savePublication(proposalId: string, publication: OwnerProposalPublication): OwnerProposalPublication {
    const previous = ownerControls.proposal(proposalId).publication;
    if (!previous || canonicalJson(json({ ...previous, updatedAt: '' })) !== canonicalJson(json({ ...publication, updatedAt: '' }))) {
      ownerControls.recordPublication(proposalId, { ...publication, updatedAt: new Date().toISOString() });
    }
    return ownerControls.proposal(proposalId).publication!;
  }
  function reconcileProposalPublication(proposal: OwnerScopeProposal): OwnerProposalPublication | undefined {
    const manifest = proposalEffect(proposal, 'manifest', proposal.publication?.manifest), card = proposalEffect(proposal, 'card', proposal.publication?.card);
    if (!proposal.publication && !manifest && !card) return undefined;
    const publication: OwnerProposalPublication = { ...proposal.publication,
      state: proposal.publication?.state ?? 'not-published', stage: proposal.publication?.stage ?? 'preparing', updatedAt: proposal.publication?.updatedAt ?? new Date().toISOString(),
      ...(manifest ? { manifest: { ...proposal.publication?.manifest, effectId: manifest.id, payloadHash: manifest.payloadHash } } : {}),
      ...(card ? { card: { ...proposal.publication?.card, effectId: card.id, payloadHash: card.payloadHash } } : {}) };
    const current = card ?? manifest;
    if (current) {
      publication.stage = card ? 'card' : 'manifest';
      publication.state = current.state === 'verified' ? 'verified' : current.state === 'failed' || current.state === 'cancelled' ? 'failed'
        : current.state === 'unknown' ? 'unknown' : 'pending';
      if (current.reason) publication.reason = current.reason; else delete publication.reason;
    }
    if (card?.state === 'verified') {
      const receipt = card.receipt && typeof card.receipt === 'object' && !Array.isArray(card.receipt) ? card.receipt : {};
      if (receipt.peerId !== config.account.controlPeerId || typeof receipt.messageId !== 'string') {
        publication.state = 'unknown'; publication.reason = 'Verified card has no exact private message receipt';
      } else {
        const ref = { accountId: config.account.id, peerId: config.account.controlPeerId, messageId: receipt.messageId };
        const own = agent.store.get<{ taskId: string; effectId?: string }>('ownOutputs', JSON.stringify([ref.accountId, ref.peerId, ref.messageId]));
        if (own?.taskId !== proposal.context.taskId || own.effectId !== card.id) {
          publication.state = 'unknown'; publication.reason = 'Verified card is not yet recorded as this proposal task output';
        } else if (!proposal.cardRef || JSON.stringify(proposal.cardRef) !== JSON.stringify(ref)) ownerControls.registerCard(proposal.id, ref);
      }
    } else if (!card && manifest?.state === 'verified') {
      publication.state = 'not-published'; publication.stage = 'card';
      publication.reason = 'Manifest verified, but approval card was not dispatched; no automatic continuation or resend';
    }
    return savePublication(proposal.id, publication);
  }
  async function publishProposal(proposal: OwnerScopeProposal): Promise<OwnerProposalPublication> {
    const existing = reconcileProposalPublication(ownerControls.proposal(proposal.id));
    if (existing) return existing; // A publication attempt is immutable; reconciliation never dispatches it again.
    let publication: OwnerProposalPublication = savePublication(proposal.id, { state: 'not-published', stage: 'preparing', updatedAt: new Date().toISOString() });
    let token: string | undefined;
    try {
      token = agent.issueExecutionContext(proposal.context);
      let exactRecipients: Json | undefined;
      if (proposal.kind === 'outreach') {
        const current = await outreach.inspect(proposal.context, proposal.objectId!);
        if (current.manifest.manifestHash !== proposal.manifestHash || current.manifest.revision !== proposal.batchRevision) throw new Error('Concrete outreach proposal no longer matches its saved manifest');
        const recipients = [];
        for (const recipient of current.manifest.recipients) {
          if (!telegram.resolvePeer) throw new Error('Exact outreach recipient metadata is unavailable');
          const peer = await telegram.resolvePeer(recipient.route.peerId);
          if (peer.accountId !== config.account.id || peer.peerId !== recipient.route.peerId) throw new Error('Outreach recipient identity changed');
          recipients.push({ id: recipient.id, route: recipient.route, destination: { title: peer.title, kind: peer.kind, ...(peer.username ? { username: peer.username } : {}) },
            text: recipient.text, payloadHash: recipient.payloadHash, ...(recipient.sourceRef ? { sourceRef: recipient.sourceRef } : {}),
            ...(recipient.attachments?.length ? { attachments: recipient.attachments.map(({ artifactId, name, profile, sha256, size }) => ({ artifactId, name, profile, sha256, size })) } : {}) });
        }
        exactRecipients = json(recipients);
      }
      const content = { title: proposal.title, batchId: proposal.objectId, revision: proposal.batchRevision, manifestHash: proposal.manifestHash,
          recipients: exactRecipients };
      const exact = JSON.stringify(content, null, 2);
      const selection = proposal.kind === 'outreach' ? ' Для выбора получателей: «да только id1,id2».' : '';
      const sourcePresentation = proposal.kind === 'sources' ? sourceProposalPresentation(proposal) : undefined;
      let card = sourcePresentation?.card ?? `Предложение #${proposal.id}\n${exact}\n\nОтветь на эту карточку «да» или «нет».${selection} Действует до ${proposal.expiresAt}.`;
      if (sourcePresentation?.attachment || !sourcePresentation && card.length > 3300) {
        const saved = host.artifacts.put({ ...scope(proposal.context), name: `proposal-${proposal.id}.${sourcePresentation ? 'txt' : 'json'}`,
          mimeType: sourcePresentation ? 'text/plain' : 'application/json', bytes: Buffer.from(sourcePresentation?.attachment ?? exact) });
        const file = await artifacts.resolveForSend(proposal.context, saved.id);
        const request = { id: `owner-card:${proposal.id}:manifest`, capability: 'telegram.media.send', resource: config.account.controlPeerId,
          payload: { peerId: config.account.controlPeerId, ...file, artifactId: saved.id, mediaType: 'document', profile: 'file' } };
        publication = savePublication(proposal.id, { ...publication, state: 'pending', stage: 'manifest', manifest: {
          effectId: effectOperationId(proposal.context, request), payloadHash: createHash('sha256').update(canonicalJson(request.payload)).digest('hex'), artifactId: saved.id } });
        const effect = await agent.executeEffect(token, request);
        publication = reconcileProposalPublication(ownerControls.proposal(proposal.id))!;
        if (effect.state !== 'verified') return publication;
        const index = proposal.recipients?.map(item => `${item.id}: ${item.peerId}`).join('\n') ?? proposal.sources?.map(item => `${item.label}: ${item.peerId}`).join('\n') ?? '';
        const summary = index.length <= 1600 ? index : `Состав содержит ${proposal.recipients?.length ?? proposal.sources?.length ?? 0} записей; все идентификаторы и маршруты указаны в полном приложенном документе.`;
        if (!sourcePresentation) card = `Предложение #${proposal.id}: ${proposal.title}\nПолный точный состав и тексты — в приложенном ${saved.name}, SHA256 ${saved.sha256}.\n${summary}\nОтветь на эту карточку «да» или «нет».${selection} Действует до ${proposal.expiresAt}.`;
      }
      if (card.length > 3500) throw new Error('Proposal card exceeds Telegram bound');
      const request = { id: `owner-card:${proposal.id}:card`, capability: 'telegram.send', resource: config.account.controlPeerId, payload: { peerId: config.account.controlPeerId, text: card } };
      publication = savePublication(proposal.id, { ...publication, state: 'pending', stage: 'card', card: {
        effectId: effectOperationId(proposal.context, request), payloadHash: createHash('sha256').update(canonicalJson(request.payload)).digest('hex') } });
      await agent.executeEffect(token, request);
      return reconcileProposalPublication(ownerControls.proposal(proposal.id))!;
    } catch (error) {
      publication = reconcileProposalPublication(ownerControls.proposal(proposal.id)) ?? publication;
      if (publication.state !== 'verified' && publication.state !== 'unknown') publication = savePublication(proposal.id, { ...publication, state: 'failed',
        reason: error instanceof Error ? error.message : 'Proposal publication failed before verified card' });
      return publication;
    } finally { if (token) agent.revokeToolContext(token); }
  }
  const outreach = new OutreachService({ store: agent.store, broker: agent, artifacts, accountId: config.account.id, effectIdentity: effectOperationId,
    getEffect: id => agent.store.get<Effect>('effects', id), approvals: {
      async proposeApproval(input) { const proposal = ownerControls.proposeApproval(input); await publishProposal(proposal); return ownerControls.proposal(proposal.id); },
      getOutreachApproval: (...args) => ownerControls.getOutreachApproval(...args),
    } });
  const replies = new OutreachReplyService({ store: agent.store, telegram, accountId: config.account.id,
    controlPeerId: config.account.controlPeerId, targets: () => outreach.replyTargets() });
  const monitorOptions = { store: agent.store, telegram, accountId: config.account.id,
    authorizeObservation: (observation: Observation) => observation.ref.accountId === config.account.id && agent.status().some(status => host.getReadPeers(status.intent.id).includes(observation.ref.peerId) && ownerControls.getMonitorPolicies(status.intent.id).some(policy => policy.sourcePeerId === observation.ref.peerId)),
  };
  const monitorSource = createMonitorSource(monitorOptions);
  function sourceForCall(call: ToolCall) {
    return createMonitorSource({ ...monitorOptions, telegram: { async readHistory(peer, query) {
      await agent.authorizeTool(call.token, query.query ? 'telegram.search' : 'telegram.history', peer);
      return host.admitReadResult(call.context, await telegram.readHistory(peer, query));
    } }, web: { fetch: source => new WebService({ ...options.web, authority: async (_context, capability, resource) => { await agent.authorizeTool(call.token, capability, resource); } }).fetch(call.context, { url: source.resource }) } });
  }
  const ordinaryCompletion = createScheduleDelivery({ agent, artifacts: host.artifacts, hermesHome: options.hermesHome,
    privateRoute: { peerId: config.account.controlPeerId }, artifactSend: (context, id) => artifacts.resolveForSend(context, id) });
  const schedules = options.nativeSchedules ? new HermesScheduleCoordinator({ native: options.nativeSchedules,
    core: { store: agent.store, validateScope: context => { agent.validateAuthority(context); }, issueToolContext: context => agent.issueExecutionContext(context),
      revokeToolContext: token => agent.revokeToolContext(token), resolveToolContext: token => agent.resolveToolContext(token) },
    prepareExecution: context => host.prepareExecutionContext(context, monitors?.isMonitorExecution(context) ? { privateMonitor: true } : undefined),
    onComplete: async (context, manifest, token) => {
      if (monitors?.isMonitorExecution(context)) { if (manifest.outcome === 'completed') await monitors.completeExecution({ context, token, args: {} }); }
      else await ordinaryCompletion(context, manifest, token);
    },
  }) : undefined;
  if (schedules) monitors = new ContinuousMonitorCoordinator({ store: agent.store, schedules, sourceForCall,
    async authorizeOwnerControl(call, subscription, action) {
      await host.authorizePrivateOwner(call.context);
      const original = agent.status(subscription.binding.taskId)?.intent;
      if (!original || original.accountId !== config.account.id || original.ownerId !== config.account.ownerId) throw new Error('Monitor belongs to another owner');
      if (action === 'resume' || action === 'reschedule') {
        agent.validateAuthority({ ...subscription.binding, runId: `control:monitor:${subscription.id}` });
        const policies = ownerControls.getMonitorPolicies(subscription.binding.taskId);
        if (!subscription.spec.sources.every(source => policies.some(policy => policy.sourcePeerId === source.resource))) throw new Error('Original monitoring source authority is no longer active');
      }
    },
    async manageSchedule(_call, subscription, action) {
      if (action === 'cancel') {
        const result = await schedules.cancelFromHost({ taskId: subscription.binding.taskId, scheduleId: subscription.scheduleId,
          key: subscription.scheduleKey ?? `monitor-${subscription.id}`, nativeJobId: subscription.nativeJobId });
        if(result.nativeCleanup!=='verified')throw new Error('Native monitor cancellation is unconfirmed; local withdrawal preserved');
        return result.schedule;
      }
      if (!subscription.scheduleId) throw new Error('Monitor schedule identity is unavailable');
      return schedules.control({ ...subscription.binding, runId: `control:monitor:${subscription.id}` }, subscription.scheduleId, action);
    },
    sourceCoverage: () => telegram.status?.().coverage ?? 'snapshot-only',
    async authorize(call, sources) {
      agent.validateExecutionContext(call.context);
      if (agent.resolveToolContext(call.token).runId !== call.context.runId) throw new Error('Monitor token/run mismatch');
      const policies = ownerControls.getMonitorPolicies(call.context.taskId);
      for (const source of sources) {
        if (source.kind !== 'telegram' || !policies.some(policy => policy.sourcePeerId === source.resource)) throw new Error('Monitor requires a current explicit owner policy for every exact source');
        await agent.authorizeTool(call.token, 'telegram.history', source.resource);
      }
    },
    async deliver(call, candidate, subscription, effectId) {
      const effect = await agent.executeEffect(call.token, { id: effectId, capability: 'telegram.send', resource: config.account.controlPeerId,
        payload: monitorPayload(candidate, subscription) });
      return { state: ['verified','failed'].includes(effect.state) ? effect.state as 'verified' | 'failed' : 'unknown', ...(effect.receipt ? { receipt: effect.receipt } : {}), ...(effect.reason ? { reason: effect.reason } : {}) };
    },
    async deliverDigest(call, summary, _candidates, subscription, effectId): Promise<EffectResult> {
      const receipts: Json[] = [];
      for (const [index,payload] of digestPayloads(summary,subscription).entries()) {
        const effect=await agent.executeEffect(call.token,{id:`${effectId}:part:${index}`,capability:'telegram.send',resource:config.account.controlPeerId,payload});
        if(effect.state!=='verified') return {state:'unknown',reason:'Digest delivery requires reconciliation; verified parts are not replayed',receipt:{verifiedParts:receipts}};
        receipts.push({effectId:effect.id,...(effect.receipt?{receipt:effect.receipt}:{})});
      }
      return {state:'verified',receipt:{parts:receipts}};
    },
  });
  async function syncOwnerPolicies() {
    for (const proposal of agent.store.list<OwnerScopeProposal>('ownerScopeProposals')) reconcileProposalPublication(proposal);
    monitors?.withdrawInvalidSubscriptions(sub => {
      agent.validateAuthority({ ...sub.binding, runId: `withdraw:${sub.id}` });
      const current = ownerControls.getMonitorPolicies(sub.binding.taskId);
      return sub.spec.sources.every(source => source.kind === 'telegram' && current.some(policy => policy.sourcePeerId === source.resource));
    });
    await monitors?.cancelWithdrawn(async sub => {
      const result = await schedules!.cancelFromHost({ taskId: sub.binding.taskId, ...(sub.scheduleId ? { scheduleId: sub.scheduleId } : {}), key: sub.scheduleKey ?? `monitor-${sub.id}`, ...(sub.nativeJobId ? { nativeJobId: sub.nativeJobId } : {}) });
      if (result.nativeCleanup !== 'verified') throw new Error('Native monitor cancellation requires reconciliation');
    });
  }
  async function onOwnerControlEvent(event: OwnerEventResult, freshContext?: ToolContext) {
    await syncOwnerPolicies();
    if (event.disposition !== 'accepted' || !event.receipt || !freshContext) return;
    const receipt = event.receipt, key = receipt.id;
    const record = { taskId: freshContext.taskId, batchId: receipt.objectId, manifestHash: receipt.manifestHash, state: 'prepared' as 'prepared' | 'verified' | 'unknown' };
    const replayed = agent.store.transaction(() => {
      const old = agent.store.get<typeof record>('workflowOwnerApprovals', key);
      if (old) {
        if (old.taskId !== record.taskId || old.batchId !== record.batchId || old.manifestHash !== record.manifestHash) throw new Error('Owner workflow receipt identity changed');
        if (old.state === 'verified') return 'verified';
        old.state = 'unknown'; agent.store.put('workflowOwnerApprovals', key, old);
        return 'unknown';
      }
      agent.store.put('workflowOwnerApprovals', key, record); return 'new';
    });
    if (replayed === 'verified') return;
    if (replayed === 'unknown') throw new Error('Owner outreach callback requires reconciliation; no automatic replay');
    let token: string | undefined;
    try {
      await outreach.attachApproval(freshContext, receipt.objectId, receipt.id, receipt.selectedRecipientIds);
      token = agent.issueExecutionContext(freshContext);
      // A finite owner-selected manifest is the bound, not a new planner loop.
      // Each drain revalidates the exact receipt; UNKNOWN stops the remainder.
      const approved = await outreach.inspect(freshContext, receipt.objectId);
      const operations = approved.manifest.recipients.filter(item => receipt.selectedRecipientIds.includes(item.id))
        .reduce((count, item) => count + 1 + (item.attachments?.length ?? 0), 0);
      for (let offset = 0; offset < operations; offset++) {
        const status = await outreach.drain(token, receipt.objectId, 1);
        if (status.counts.unknown || status.counts.dispatching) throw new Error('Owner outreach execution settlement is unknown; no automatic replay');
        if (!status.counts.pending) break;
      }
      record.state = 'verified'; agent.store.put('workflowOwnerApprovals', key, record);
    } catch (error) { record.state = 'unknown'; agent.store.put('workflowOwnerApprovals', key, record); throw error; }
    finally { if (token) agent.revokeToolContext(token); }
  }
  const registry:ReturnType<typeof createToolRegistry> = createToolRegistry({ broker: agent, telegram, accountId: config.account.id, artifacts, web: options.web,
    authorizeAccountInventory: async context => { await host.authorizePrivateOwner(context); },
    admitReadResult: (context, rows) => host.admitReadResult(context, rows), jobs: { store: options.jobs, source: monitorSource, sourceForCall },
    extraTools: [
      { name: 'tools.describe', capability: 'memory.read', mutates: false, description: 'Read exact descriptions and JSON input schemas for named installed tools before calling them. Metadata does not grant execution rights.',
        inputSchema: obj({names:{type:'array',items:str(128),minItems:1,maxItems:12}},['names']), resources: (_args,context)=>[context.taskId],
        async execute({args}):Promise<Json>{const names=[...new Set(args.names as string[])],catalog=registry.list();return json({tools:catalog.filter(tool=>names.includes(tool.name)),unknown:names.filter(name=>!catalog.some(tool=>tool.name===name))});} },
      { name: 'context.current', capability: 'memory.read', mutates: false, description: 'Read current trusted execution context and owner preferences before recurring work. Source text remains untrusted.', inputSchema: obj({}), resources: (_args, context) => [context.taskId], async execute({ context }) { return json(host.getExecutionContext(context)); } },
      ...ownerControlTools({ service: ownerControls, resolveSource, onProposal: publishProposal }), ...outreachTools(outreach), ...outreachReplyTools(replies),
      ...memoryTools({ store: host.memory, admitPreference: (context, proposal) => host.admitPreference(context, proposal), resolveAccess: context => ({ ownerId: config.account.ownerId, accountId: config.account.id, scopes: ['global', `task:${context.taskId}`, ...host.getReadPeers(context.taskId).map(peer => `chat:${peer}`)] }) }),
      ...(options.nativeCognition ? createNativeSkillTools({ ...options.nativeCognition, store: agent.store,
        resolveAccess: context => ({ ownerId: config.account.ownerId, accountId: config.account.id, scopes: ['global', `task:${context.taskId}`, ...host.getReadPeers(context.taskId).map(peer => `chat:${peer}`)] }),
        admitReference: (context, descriptor) => host.admitSkillReference(context, descriptor) }) : []),
      ...trackedArtifacts(artifactTools({ store: host.artifacts, inspector: new ArtifactInspector({ pythonExecutable: config.artifacts?.pythonExecutable }), resolveScope: scope })),
      ...privateTools([
        ...(library ? trackedArtifacts(documentTools({ library, resolveScope: scope, authorize: context => host.authorizePrivateOwner(context), authorizeDestructive:(context,operation,args)=>host.authorizeDocumentDestruction(context,operation,args) })) : []),
        ...(desktop ? desktopContextTools({ adapter: desktop, resolveAccess: () => ({ ownerId: config.account.ownerId, scope: config.desktopContext!.scope }) }) : []),
        ...(config.github ? githubTools({ broker: agent, owner: config.github.owner, ...(config.github.tokenEnv && process.env[config.github.tokenEnv] ? {token:process.env[config.github.tokenEnv]} : {}) }) : []),
      ]),
      ...createArtifactTools({ store: host.artifacts, resolveScope: scope }), ...trackedArtifacts(createArtifactVisionTools(host.artifacts, scope)),
      ...(schedules ? createScheduleTools(schedules) : []), ...(monitors ? createObservationTools(monitors).map(tool => ({ ...tool,
        description: tool.description + ' This host admits continuous subscriptions only for explicitly owner-authorized Telegram sources; web monitor authority is unavailable.' })) : []), ...(options.extraTools ?? []),
    ] });
  const catalog: HostCapabilityStatus[] = registry.list().map(tool => ({ name: tool.name, capability: tool.capability, description:tool.description,
    availability: tool.name === 'web.search' && !options.web?.searchProvider ? 'unavailable' : tool.name === 'artifacts.inspect' && !config.artifacts?.pythonExecutable ? 'unknown' : 'configured',
    ...(tool.name === 'web.search' && !options.web?.searchProvider ? { reason: 'No search provider configured' } : {}) }));
  if (!schedules) for (const name of ['schedules.create','monitors.subscribe']) catalog.push({ name, capability: name, availability: 'unavailable', reason: 'Native cron control is not configured' });
  if (!registry.list().some(tool => tool.name === 'images.generate')) catalog.push({ name: 'images.generate', capability: 'images.generate', availability: 'unavailable', reason: 'Image generation provider is not configured' });
  if (!registry.list().some(tool => tool.name === 'computer.create')) catalog.push({ name: 'computer.create', capability: 'computer.create', availability: 'unavailable', reason: 'Computer adapter is not configured' });
  const approvedSkills = agent.store.list<NativeSkillDescriptor>('hermesSkills').some(descriptor => descriptor.state === 'approved' && descriptor.ownerId === config.account.ownerId && descriptor.accountId === config.account.id);
  for (const name of ['learning.skills.list', 'learning.skills.view']) {
    const entry = catalog.find(item => item.name === name);
    if (!options.nativeCognition || !approvedSkills) {
      if (entry) Object.assign(entry, { availability: 'unavailable', reason: 'No configured scoped native skill catalog with approved descriptors' });
      else catalog.push({ name, capability: 'memory.read', availability: 'unavailable', reason: 'Native skill reuse is not configured' });
    }
  }
  host.setCapabilityCatalog(catalog);
  return { registry, schedules, monitors, monitorSource, ownerControls, outreach, replies, library, onOwnerControlEvent, syncOwnerPolicies, dispose: () => library?.dispose() };
}
