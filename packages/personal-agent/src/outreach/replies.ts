import { createHash } from 'node:crypto';
import type { Effect, Json, MessageRef, Observation, RunSnapshot, TaskIntent, TelegramPort, ToolContext } from '../contracts.ts';
import { AuthorityError, canonicalJson, effectOperationId } from '../core/broker.ts';
import { deliveryParts } from '../core/controller.ts';
import type { PersonalStore } from '../core/store.ts';
import type { RegisteredTool } from '../capabilities/types.ts';
import { obj } from '../capabilities/schema.ts';
import type { OutreachReplyTarget } from './index.ts';

export interface EmployerReply {
  ref: MessageRef; version: string; text: string; sentAt: string; authorId: string;
  batchId: string; recipientId: string; outboundRef: MessageRef;
  attribution: 'exact-reply' | 'private-dialogue-after-send';
  destination: { title: string; username?: string };
  attachments: { id: string; name: string; mimeType: string; size?: number }[];
}
export interface EmployerReplyDigest {
  id: string; taskId: string; intentRevision: number; runId: string; replies: EmployerReply[];
  coverage: { peerId: string; status: 'bounded' | 'unavailable' | 'partial'; pages: number; reason?: string }[];
  generatedAt: string; deliveredAt?: string; deliveryEffectId?: string;
}
export interface OutreachReplyOptions {
  store: Pick<PersonalStore, 'get' | 'put' | 'list' | 'transaction'>;
  telegram: Pick<TelegramPort, 'resolvePeer' | 'readHistory' | 'getMessage'>;
  accountId: string; controlPeerId: string; targets(): OutreachReplyTarget[];
  now?: () => Date; maxPeers?: number; maxPagesPerPeer?: number;
}
const events = 'outreach-employer-replies-v1', reports = 'outreach-reply-reported-v1', digests = 'outreach-reply-digests-v1';
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(json(value))).digest('hex');
const key = (ref: MessageRef) => hash([ref.accountId, ref.peerId, ref.messageId]);
const sameRef = (a: MessageRef, b: MessageRef) => a.accountId === b.accountId && a.peerId === b.peerId && a.messageId === b.messageId;
/** No model invocation, send, subscription, or grant mutation is available to this reader. */
export class OutreachReplyService {
  readonly options: OutreachReplyOptions;
  constructor(options: OutreachReplyOptions) {
    this.options = options;
    if (!options.accountId || !options.controlPeerId) throw new Error('Employer reply account/control binding required');
    if (!Number.isInteger(options.maxPeers ?? 50) || (options.maxPeers ?? 50) < 1 || (options.maxPeers ?? 50) > 50 ||
      !Number.isInteger(options.maxPagesPerPeer ?? 5) || (options.maxPagesPerPeer ?? 5) < 1 || (options.maxPagesPerPeer ?? 5) > 10) throw new Error('Employer reply read bounds invalid');
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private validateContext(context: ToolContext): void {
    const intent = this.options.store.get<TaskIntent>('tasks', context.taskId);
    if (!intent || intent.revision !== context.intentRevision || intent.accountId !== this.options.accountId || intent.source.peerId !== this.options.controlPeerId || intent.route.peerId !== this.options.controlPeerId) throw new AuthorityError('Employer replies are available only in the current owner control task');
  }
  private targets(): OutreachReplyTarget[] {
    return this.options.targets().filter(target => target.peerId !== this.options.controlPeerId && Number.isFinite(Date.parse(target.sentAt)));
  }
  private async admit(observation: Observation, targets: OutreachReplyTarget[]): Promise<boolean> {
    const scoped = targets.filter(target => target.peerId === observation.ref.peerId);
    if (observation.ref.accountId !== this.options.accountId || !scoped.length) return false;
    this.options.store.put(events, key(observation.ref), { deleted: true, ref: observation.ref });
    // Returning true consumes the external conversation even when its body is unavailable or unsuitable for a digest.
    if (observation.kind === 'delete') { this.options.store.put(events, key(observation.ref), { deleted: true, ref: observation.ref }); return true; }
    if (observation.outgoing || observation.forwarded || observation.viaBot || !observation.authorId || !Number.isFinite(Date.parse(observation.sentAt))) return true;
    const peer = await this.options.telegram.resolvePeer?.(observation.ref.peerId);
    if (!peer || peer.accountId !== this.options.accountId || peer.peerId !== observation.ref.peerId || peer.kind !== 'user' || (peer.userId ?? peer.peerId) !== observation.authorId) return true;
    if (observation.replyTo && observation.replyTo.accountId !== this.options.accountId) return true;
    const exact = observation.replyTo && scoped.find(target => sameRef(observation.replyTo!, { accountId: this.options.accountId, peerId: target.peerId, messageId: target.messageId }));
    // A reply to another anchor must never be reclassified as an employer response to this batch.
    if (observation.replyTo && !exact) return true;
    const latest = scoped.filter(target => {
      const nativeOrder = /^\d+$/u.test(target.messageId) && /^\d+$/u.test(observation.ref.messageId);
      // Telegram timestamps have second precision; the native monotone message IDs disambiguate a fast same-second response.
      return nativeOrder ? BigInt(observation.ref.messageId) > BigInt(target.messageId) && Date.parse(observation.sentAt) >= Math.floor(Date.parse(target.sentAt) / 1000) * 1000 :
        Date.parse(target.sentAt) < Date.parse(observation.sentAt);
    }).sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt) || (/^\d+$/u.test(a.messageId) && /^\d+$/u.test(b.messageId) ? (BigInt(a.messageId) < BigInt(b.messageId) ? 1 : -1) : a.messageId.localeCompare(b.messageId)))[0];
    const target = exact ?? latest; if (!target) return true;
    const body = { ref: observation.ref, text: observation.text ?? '', sentAt: observation.sentAt, authorId: observation.authorId,
      batchId: target.batchId, recipientId: target.recipientId, outboundRef: { accountId: this.options.accountId, peerId: target.peerId, messageId: target.messageId },
      attribution: exact ? 'exact-reply' as const : 'private-dialogue-after-send' as const,
      destination: { title: peer.title, ...(peer.username ? { username: peer.username } : {}) },
      attachments: (observation.attachments ?? []).map(({ id, name, mimeType, size }) => ({ id, name, mimeType, ...(size === undefined ? {} : { size }) })) };
    const reply: EmployerReply = { ...body, version: hash(body) };
    this.options.store.put(events, key(reply.ref), reply); return true;
  }
  /** Trusted host intake. True means the external recipient must not trigger an autonomous conversation. */
  async recordObservation(observation: Observation): Promise<boolean> { return observation.outgoing ? false : this.admit(observation, this.targets()); }
  async digest(context: ToolContext): Promise<EmployerReplyDigest> {
    this.validateContext(context);
    const targets = this.targets(), peers = [...new Set(targets.map(target => target.peerId))];
    const coverage: EmployerReplyDigest['coverage'] = [];
    for (const peerId of peers.slice(0, this.options.maxPeers ?? 50)) {
      let before: string | undefined, pages = 0, partial = false;
      try {
        const peer = await this.options.telegram.resolvePeer?.(peerId);
        if (!peer || peer.accountId !== this.options.accountId || peer.peerId !== peerId || peer.kind !== 'user') { coverage.push({ peerId, status: 'unavailable', pages, reason: 'Verified individual private destination unavailable' }); continue; }
        for (; pages < (this.options.maxPagesPerPeer ?? 5);) {
          this.validateContext(context);
          const rows = await this.options.telegram.readHistory(peerId, { limit: 50, ...(before ? { before } : {}) }); pages++;
          if (!Array.isArray(rows) || rows.length > 50 || rows.some(row => row.ref.accountId !== this.options.accountId || row.ref.peerId !== peerId)) throw new Error('Employer history escaped exact account/destination');
          const earliest = Math.floor(Math.min(...targets.filter(target => target.peerId === peerId).map(target => Date.parse(target.sentAt))) / 1000) * 1000;
          for (const row of rows) {
            if (Date.parse(row.sentAt) < earliest && !row.replyTo) continue;
            const fresh = await this.options.telegram.getMessage(row.ref);
            if (!fresh) { this.options.store.put(events, key(row.ref), { deleted: true, ref: row.ref }); continue; }
            if (!sameRef(fresh.ref, row.ref)) throw new Error('Employer message refresh changed identity');
            await this.admit(fresh, targets);
          }
          if (!rows.length || rows.some(row => Date.parse(row.sentAt) <= earliest)) break;
          const cursor = rows.at(-1)!.ref.messageId;
          if (cursor === before) { partial = true; break; }
          before = cursor;
          if (pages === (this.options.maxPagesPerPeer ?? 5)) partial = true;
        }
        coverage.push({ peerId, status: partial ? 'partial' : 'bounded', pages, ...(partial ? { reason: 'Bounded read did not reach earliest verified dispatch' } : {}) });
      } catch { coverage.push({ peerId, status: 'unavailable', pages, reason: 'History unavailable or exact source readback failed' }); }
    }
    for (const peerId of peers.slice(this.options.maxPeers ?? 50)) coverage.push({ peerId, status: 'partial', pages: 0, reason: 'Destination read bound reached' });
    const available = new Set(coverage.filter(item => item.status !== 'unavailable').map(item => item.peerId));
    const replies: EmployerReply[] = [];
    for (const saved of this.options.store.list<EmployerReply & { deleted?: boolean }>(events)) {
      if (saved.deleted || !available.has(saved.ref.peerId) || this.options.store.get<{ version: string }>(reports, key(saved.ref))?.version === saved.version) continue;
      // Refresh journal-only observations too: old cached text is never evidence of a current reply.
      try { const fresh = await this.options.telegram.getMessage(saved.ref);
        if (!fresh || !sameRef(fresh.ref, saved.ref)) continue;
        await this.admit(fresh, targets);
        const current = this.options.store.get<EmployerReply & { deleted?: boolean }>(events, key(saved.ref));
        if (current && !current.deleted && this.options.store.get<{ version: string }>(reports, key(current.ref))?.version !== current.version) replies.push(current);
      } catch { /* Missing refresh remains absent rather than being presented as current. */ }
    }
    this.validateContext(context);
    replies.sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.ref.messageId.localeCompare(b.ref.messageId));
    const digest: EmployerReplyDigest = { id: hash([context.taskId, context.intentRevision, context.runId, replies.map(reply => [key(reply.ref), reply.version]), coverage]),
      taskId: context.taskId, intentRevision: context.intentRevision, runId: context.runId, replies, coverage, generatedAt: this.now() };
    this.options.store.put(digests, digest.id, digest);
    this.options.store.put('outreach-reply-latest-query-v1', hash([context.taskId, context.runId]), { digestId: digest.id });
    return structuredClone(digest);
  }
  /** Host acknowledges only after the existing broker independently verified the owner-DM output. */
  acknowledgeDelivered(taskId: string, runId: string, effectIds: string[]): void {
    const latest = this.options.store.get<{ digestId: string }>('outreach-reply-latest-query-v1', hash([taskId, runId]));
    const pending = this.options.store.list<EmployerReplyDigest>(digests).filter(digest => digest.id === latest?.digestId && digest.taskId === taskId && digest.runId === runId && !digest.deliveredAt);
    if (!pending.length) return;
    const intent = this.options.store.get<TaskIntent>('tasks', taskId), run = intent && this.options.store.get<RunSnapshot>('runs', taskId + ':' + intent.revision);
    if (!intent || !run || run.state !== 'completed' || run.binding.runId !== runId || !run.output || intent.route.peerId !== this.options.controlPeerId) throw new AuthorityError('Employer digest final run is not completed in the owner dialogue');
    const context = { taskId, intentRevision: intent.revision, grantId: intent.grantId, grantRevision: 0, runId };
    const expected = deliveryParts(run.output).map((_part, index) => effectOperationId(context, { id: 'delivery:' + runId + ':part:' + index,
      capability: 'telegram.send', resource: this.options.controlPeerId, payload: null }));
    if (effectIds.length !== expected.length || new Set(effectIds).size !== expected.length || expected.some(id => !effectIds.includes(id))) throw new AuthorityError('Employer digest requires every exact final delivery part; control ACK is insufficient');
    for (const id of expected) {
      const effect = this.options.store.get<Effect>('effects', id), receipt = effect?.receipt && typeof effect.receipt === 'object' && !Array.isArray(effect.receipt) ? effect.receipt : {};
      if (!effect || effect.state !== 'verified' || effect.taskId !== taskId || effect.intentRevision !== intent.revision || effect.capability !== 'telegram.send' ||
        effect.resource !== this.options.controlPeerId || receipt.peerId !== this.options.controlPeerId || typeof receipt.messageId !== 'string') throw new AuthorityError('Employer digest final delivery is not independently verified');
    }
    this.options.store.transaction(() => {
      for (const digest of pending.filter(item => item.intentRevision === intent.revision)) {
        for (const reply of digest.replies) this.options.store.put(reports, key(reply.ref), { version: reply.version, digestId: digest.id, deliveryEffectIds: expected });
        this.options.store.put(digests, digest.id, { ...digest, deliveredAt: this.now(), deliveryEffectId: expected[0] });
      }
    });
  }
}
export function outreachReplyTools(service: OutreachReplyService): RegisteredTool[] {
  return [{ name: 'outreach.replies', capability: 'outreach.replies', mutates: false, inputSchema: obj({}, []), resources: (_args, context) => [context.taskId],
    description: 'Read a grounded digest of new employer replies across verified past batches. Private destination identity and exact fresh messages are checked; coverage gaps are explicit. No employer reply or send authority is created. Delivered digest versions are not new again.',
    async execute({ context }) { return json(await service.digest(context)); } }];
}
