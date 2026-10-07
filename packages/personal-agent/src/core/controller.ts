import { randomUUID } from 'node:crypto';
import type { CapabilityGrant, Clock, Effect, EffectExecutor, EnginePort, Grant, MessageRef, Observation,
  Route, RunBinding, RunSnapshot, TaskIntent, ToolContext } from '../contracts.ts';
import { systemClock } from '../contracts.ts';
import { AuthorityError, canonicalJson, EffectBroker, effectOperationId, type EffectRequest } from './broker.ts';
import { PersonalStore } from './store.ts';
import { beginsWithQuotedCommand } from './authority-text.ts';

interface Admission {
  taskId: string; revision: number; key: string; token: string;
  state: 'reserved' | 'bound' | 'unknown' | 'blocked'; createdAt: string; reason?: string;
}
interface Control { taskId: string; cancelledAt?: string; heldAt?: string; reason?: string; resumeWhenSettled?: boolean }
interface ChildStop { taskId: string; revision: number; state: 'pending' | 'settled' | 'unknown'; reason?: string }
interface OwnOutput { ref: MessageRef; taskId: string; effectId?: string; controlOnly?: boolean }
interface InternalIntent extends TaskIntent { controlOnly?: boolean }
interface ReceivedObservation { key: string; observation: Observation; receivedAt: string; sequence?: number }
interface OriginDeadline { taskId: string; peerId?: string; expiresAt: string }
interface OwnerChange { ref: MessageRef; authorizedAt: string }
export interface PersonalAgentOptions {
  databasePath: string; encryptionKey: Uint8Array; accountId: string; ownerId: string;
  privateRoute: Route; engine: EnginePort; executor?: EffectExecutor; clock?: Clock;
  capabilityPolicy?: (intent: TaskIntent) => CapabilityGrant[];
  prepareInput?: (intent: TaskIntent) => Promise<{ context?: string; stagedFiles?: string[]; freshSession?: boolean }>;
  restoreToolBinding?: (binding: RunBinding, token: string) => Promise<void>;
  validateToolContext?: (context: ToolContext) => void;
  prepareAuthority?: (intent: TaskIntent) => Promise<{ capabilities: CapabilityGrant[]; expiresAt?: string | null }> | { capabilities: CapabilityGrant[]; expiresAt?: string | null };
  validateToolResource?: (context: ToolContext, capability: string, resource: string) => void;
  validateEffect?: (context: ToolContext, request: EffectRequest) => void;
  /** Exact configured private owner room accepts ordinary direct owner utterances. */
  naturalControlPeerId?: string;
  /** Host excludes tasks with already-bound durable monitors/schedules from implicit revision. */
  canApplyImplicitCorrection?: (taskId: string) => boolean;
  grantTtlMs?: number; toolContextTtlMs?: number; commandPrefix?: string;
  /** Public reply relevance, measured from the owner's message, not restart time. */
  originReplyTtlMs?: number;
  /** Host stops owned child executors after revocation; protocol acknowledgement is insufficient. */
  onTaskStop?: (taskId: string, reason: string, intentRevision: number) => Promise<{ settled: boolean; reason?: string }>;
  /** Host readback for replacing only a task's durable, own acknowledgement. */
  readDeliveryMessage?: (ref: MessageRef) => Promise<Observation | undefined>;
}
export interface TaskStatus {
  intent: TaskIntent; run?: RunSnapshot; admission?: { state: Admission['state']; reason?: string };
  cancelledAt?: string; heldAt?: string; reason?: string; effects: Effect[];
  state: 'accepted' | 'working' | 'ready' | 'failed' | 'paused' | 'cancelled' | 'unknown';
}
export interface IngestResult {
  disposition: 'ignored' | 'duplicate' | 'accepted' | 'status' | 'cancelled' | 'corrected' | 'held' | 'ambiguous';
  taskId?: string; reason?: string; status?: TaskStatus | TaskStatus[];
}
export interface PollResult { tasks: TaskStatus[]; deliveries: Effect[] }
const refKey = (ref: MessageRef) => JSON.stringify([ref.accountId, ref.peerId, ref.messageId]);
const admissionKey = (taskId: string, revision: number) => taskId + ':' + revision;
const sameRef = (a: MessageRef, b: MessageRef) => refKey(a) === refKey(b);
const terminal = (state: string) => ['completed', 'failed', 'interrupted', 'cancelled'].includes(state);
/** Complete cadence amendments only; this never interprets approval or external-send requests. */
export function isCadenceFollowup(command: string): boolean {
  if (command.length > 256) return false;
  return /^(?:(?:давай\s+)?только\s+эт(?:о)?[.!]?\s*)?(?:(?:проверяй|проверять|сводку|сводка|обновляй|обновлять)\s+)?раз\s+в\s+(?:пару|два|две|три|четыре|пять|шесть|\d{1,3})\s+(?:час(?:а|ов)?|минут(?:у|ы)?|дн(?:я|ей))[.!]?$/iu.test(command.trim());
}
export function deliveryParts(text: string, limit = 3500): string[] {
  const parts: string[] = []; let part = '';
  for (const character of text) {
    if (part.length + character.length > limit) { parts.push(part); part = ''; }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
}
const noExecutor: EffectExecutor = {
  async dispatch() { return { state: 'failed', reason: 'No effect executor is configured' }; },
  async reconcile() { return { state: 'unknown', reason: 'No effect executor is configured' }; },
};

/** Trusted orchestration shell; engine remains the sole execution-plan/schedule owner. */
export class PersonalAgent {
  readonly store: PersonalStore;
  private readonly broker: EffectBroker;
  private readonly clock: Clock;
  private startPromise?: Promise<void>;
  private closed = false;
  private replaying = false;
  private readonly activePolls = new Map<string, Promise<RunSnapshot | undefined>>();
  private readonly options: PersonalAgentOptions;

  constructor(options: PersonalAgentOptions) {
    this.options = options;
    if (!options.accountId || !options.ownerId || !options.privateRoute.peerId) throw new Error('Account, owner and private route are required');
    this.clock = options.clock ?? systemClock;
    this.store = new PersonalStore({ databasePath: options.databasePath, encryptionKey: options.encryptionKey });
    const identity = { accountId: options.accountId, ownerId: options.ownerId, privateRoute: options.privateRoute };
    const existing = this.store.get<typeof identity>('metadata', 'identity');
    if (existing && JSON.stringify(existing) !== JSON.stringify(identity)) { this.store.close(); throw new AuthorityError('Database belongs to a different owner/account/route'); }
    this.store.insert('metadata', 'identity', identity);
    this.broker = new EffectBroker(this.store, options.executor ?? noExecutor, this.clock,
      options.toolContextTtlMs ?? 24 * 60 * 60 * 1000, effect => this.captureOwnReceipt(effect), options.validateToolContext,
      (context, capability, resource) => {
        this.validateOriginResource(context, capability, resource);
        options.validateToolResource?.(context, capability, resource);
      }, options.validateEffect);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Personal agent is closed');
    this.startPromise ??= this.recover();
    return this.startPromise;
  }

  private async recover(): Promise<void> {
    const capabilities = await this.options.engine.capabilities();
    if (!capabilities.durable || !capabilities.sessions) throw new Error('Engine must provide durable runs and sessions; admission is disabled');
    // A saved reservation cannot prove that the provider did not accept a request before the crash.
    for (const admission of this.store.list<Admission>('admissions')) {
      if (admission.state === 'reserved') {
        admission.state = 'unknown'; admission.reason = 'Interrupted admission: original operation must be reconciled, never recreated';
        this.store.put('admissions', admissionKey(admission.taskId, admission.revision), admission);
      }
    }
    // Durable revocations/intention changes precede any recovery admission or restored tool authority.
    this.replaying = true;
    try {
      for (const pending of this.store.list<ReceivedObservation>('observations').sort((a, b) =>
        a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : a.receivedAt.localeCompare(b.receivedAt) || a.key.localeCompare(b.key))) {
        if (!this.store.get<IngestResult>('observationResults', pending.key)) {
          const result = await this.processObservation(pending.observation, pending.key);
          this.store.put('observationResults', pending.key, result);
        }
      }
    } finally { this.replaying = false; }
    await this.broker.recover();
    for (const stop of this.store.list<ChildStop>('childStops').filter(stop => stop.state !== 'settled')) {
      await this.stopChildren(stop.taskId, stop.reason ?? 'Recover parent stop', stop.revision);
    }
    for (const snapshot of this.store.list<RunSnapshot>('runs')) {
      const admission = this.store.get<Admission>('admissions', admissionKey(snapshot.binding.taskId, snapshot.binding.intentRevision));
      if (admission) {
        try { this.broker.resolve(admission.token); await this.options.restoreToolBinding?.(snapshot.binding, admission.token); }
        catch (error) { if (!(error instanceof AuthorityError)) throw error; }
      }
      await this.refresh(snapshot);
    }
    for (const intent of this.store.list<InternalIntent>('tasks').filter(i => !i.controlOnly)) {
      if (!this.store.get<Admission>('admissions', admissionKey(intent.id, intent.revision)) &&
        !this.store.get<Control>('controls', intent.id)) {
        if (this.unresolvedPriorWork(intent)) await this.hold(intent.id, 'Recovery retained correction; prior execution is unresolved', true);
        else await this.admit(intent);
      }
    }
  }

  private authenticate(observation: Observation): boolean {
    return observation.ref.accountId === this.options.accountId && observation.authorId === this.options.ownerId &&
      observation.outgoing && !observation.forwarded && !observation.viaBot;
  }

  private ownOutput(observation: Observation): OwnOutput | undefined {
    const saved = this.store.get<OwnOutput>('ownOutputs', refKey(observation.ref));
    if (saved) return saved;
    if (observation.agentEffectId) {
      const effect = this.store.get<Effect>('effects', observation.agentEffectId);
      if (effect) return { ref: observation.ref, taskId: effect.taskId, effectId: effect.id };
    }
    // Pending sends may already have exact native identities before final delivery.
    // Equal text is never evidence: the owner can legitimately repeat our words.
    for (const effect of this.broker.effects()) {
      if (matchesOwnMessageReceipt(effect, observation)) {
        return { ref: observation.ref, taskId: effect.taskId, effectId: effect.id };
      }
    }
    return undefined;
  }

  async ingest(observation: Observation): Promise<IngestResult> {
    await this.start(); // Replay and settlement always precede new admission.
    if (observation.ref.accountId !== this.options.accountId) return { disposition: 'ignored', reason: 'Wrong account' };
    const eventKey = JSON.stringify([observation.id, observation.kind, observation.version ?? observation.text ?? '']);
    if (this.store.get<IngestResult>('observationResults', eventKey)) return { disposition: 'duplicate' };
    this.store.transaction(() => {
      if (this.store.get('observations', eventKey)) return;
      const sequence = (this.store.get<{ next: number }>('metadata', 'observationSequence')?.next ?? 0) + 1;
      this.store.put('metadata', 'observationSequence', { next: sequence });
      this.store.insert<ReceivedObservation>('observations', eventKey, { key: eventKey, observation,
        receivedAt: this.clock.now().toISOString(), sequence });
    });
    const result = await this.processObservation(observation, eventKey);
    this.store.put('observationResults', eventKey, result);
    return result;
  }

  private async processObservation(observation: Observation, eventKey: string): Promise<IngestResult> {
    if (!Number.isFinite(Date.parse(observation.sentAt)) || !Number.isFinite(Date.parse(observation.observedAt))) {
      return { disposition: 'ignored', reason: 'Observation has an invalid timestamp' };
    }
    if (this.ownOutput(observation)) return { disposition: 'ignored', reason: 'Own output cannot command the agent' };
    if (observation.kind === 'delete') {
      if (observation.forwarded || observation.viaBot || (observation.authorId !== undefined && observation.authorId !== this.options.ownerId)) {
        return { disposition: 'ignored', reason: 'Delete is not an authenticated account tombstone' };
      }
      const task = this.taskForSource(observation.ref);
      if (!task) return { disposition: 'ignored', reason: 'Deleted message is not an accepted source' };
      await this.hold(task.id, 'Source command was deleted; future effects are suspended');
      return { disposition: 'held', taskId: task.id, status: this.status(task.id) };
    }
    if (!this.authenticate(observation)) return { disposition: 'ignored', reason: 'Observation is not an authenticated direct owner command' };
    const prefix = this.options.commandPrefix ?? '/бро';
    const sourceTask = this.taskForSource(observation.ref);
    if (beginsWithQuotedCommand(observation, prefix)) {
      if (observation.kind === 'edit' && sourceTask) {
        await this.hold(sourceTask.id, 'Accepted command was changed to quoted material; future effects are suspended');
        return { disposition: 'held', taskId: sourceTask.id, status: this.status(sourceTask.id) };
      }
      return { disposition: 'ignored', reason: 'Цитата или код не является прямым поручением владельца.' };
    }
    const natural = observation.ref.peerId === this.options.naturalControlPeerId;
    const text = (observation.text ?? '').trim() || (natural && (observation.attachments?.length ?? 0) > 0 ? 'Разбери приложенный материал.' : '');
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp('^' + escaped + '(?:\\s+|$)', 'iu'));
    if (observation.kind === 'edit' && sourceTask) {
      if ((!match && !natural) || !text) { await this.hold(sourceTask.id, 'Accepted command was edited out'); return { disposition: 'held', taskId: sourceTask.id }; }
      if (this.staleOwnerChange(sourceTask.id, observation)) return { disposition: 'ignored', taskId: sourceTask.id, reason: 'Более новое уточнение уже сохранено; прежняя редакция не применяется.' };
      await this.applyCorrection(sourceTask.id, match ? text.slice(match[0].length).trim() : text, this.routeFor(observation, text), eventKey,
        observation.editedAt ?? observation.sentAt, false, observation);
      return { disposition: 'corrected', taskId: sourceTask.id, status: this.status(sourceTask.id) };
    }
    const replyTask = observation.replyTo && this.store.get<OwnOutput>('ownOutputs', refKey(observation.replyTo));
    const replySourceTask = observation.replyTo && this.taskForSource(observation.replyTo);
    if (!match && !natural && !replyTask && !replySourceTask) {
      this.invalidateOriginDrafts(observation);
      return { disposition: 'ignored', reason: 'No command prefix or task-bound agent reply' };
    }
    if (sourceTask) return { disposition: 'duplicate', taskId: sourceTask.id };
    if (!match && !natural && replyTask?.controlOnly) return { disposition: 'ignored', reason: 'Control response has no active task' };
    const command = match ? text.slice(match[0].length).trim() : text;
    if (!command) return { disposition: 'ignored', reason: 'Empty command' };
    const target = this.resolveTask(observation, command);
    if (/^(?:статус|как там|ч[её] там|status)(?:\s|$|\?)/iu.test(command)) {
      if (target.kind === 'ambiguous' || (/#[\w-]+/.test(command) && !target.task)) return { disposition: 'ambiguous', reason: 'Choose a registered task ID or reply to its card' };
      return { disposition: 'status', taskId: target.task?.id, status: target.task ? this.status(target.task.id) : this.status() };
    }
    if (/^(?:стоп|отмени|cancel|stop)(?:\s|$)/iu.test(command)) {
      if (!target.task) return { disposition: 'ambiguous', reason: 'Choose the task to cancel' };
      await this.applyCancellation(target.task.id);
      return { disposition: 'cancelled', taskId: target.task.id, status: this.status(target.task.id) };
    }
    if (/^(?:исправь|поправь|correct)(?:\s|$)/iu.test(command) || (target.task && /#[\w-]+/.test(command))) {
      if (!target.task) return { disposition: 'ambiguous', reason: 'Choose the task to correct' };
      if (this.staleOwnerChange(target.task.id, observation)) return { disposition: 'ignored', taskId: target.task.id, reason: 'Более новое уточнение уже сохранено; прежняя редакция не применяется.' };
      await this.applyCorrection(target.task.id, command.replace(/#[\w-]+/g, '').trim(), this.routeFor(observation, command, target.task), eventKey,
        observation.sentAt, false, observation);
      return { disposition: 'corrected', taskId: target.task.id, status: this.status(target.task.id) };
    }
    if (target.task && observation.replyTo && (this.store.get<OwnOutput>('ownOutputs', refKey(observation.replyTo)) || replySourceTask)) {
      if (this.staleOwnerChange(target.task.id, observation)) return { disposition: 'ignored', taskId: target.task.id, reason: 'Более новое уточнение уже сохранено; прежняя редакция не применяется.' };
      await this.applyCorrection(target.task.id, command, this.routeFor(observation, command, target.task), eventKey, observation.sentAt, false, observation);
      return { disposition: 'corrected', taskId: target.task.id, status: this.status(target.task.id) };
    }
    if (natural && !observation.replyTo && isCadenceFollowup(command)) {
      if (target.kind === 'ambiguous') return { disposition: 'ambiguous', reason: 'Ответь на сообщение о нужной задаче, чтобы уточнить её период.' };
      if (target.task && (this.options.canApplyImplicitCorrection?.(target.task.id) ?? true)) {
        if (this.staleOwnerChange(target.task.id, observation)) return { disposition: 'ignored', taskId: target.task.id, reason: 'Более новое уточнение уже сохранено; прежняя редакция не применяется.' };
        await this.applyCorrection(target.task.id, command, this.routeFor(observation, command, target.task), eventKey, observation.sentAt, false, observation);
        return { disposition: 'corrected', taskId: target.task.id, status: this.status(target.task.id) };
      }
    }
    const taskId = randomUUID();
    const now = this.clock.now().toISOString();
    const intent: TaskIntent = {
      id: taskId, ownerId: this.options.ownerId, accountId: this.options.accountId, source: observation.ref,
      instruction: command, revision: 1, route: this.routeFor(observation, command), createdAt: now, updatedAt: now,
      contextRefs: [...(observation.contextRefs ?? []), ...(observation.replyTo ? [refKey(observation.replyTo)] : [])],
      artifactRefs: observation.artifactRefs ?? [], grantId: randomUUID(),
    };
    const created = this.store.transaction(() => {
      if (!this.store.insert('sources', refKey(observation.ref), { taskId })) return false;
      this.store.put('tasks', taskId, intent); this.store.put('grants', intent.grantId, this.makeGrant(intent));
      this.store.put<OwnerChange>('taskOwnerChanges', taskId, { ref: observation.ref, authorizedAt: observation.editedAt ?? observation.sentAt });
      if (intent.route.peerId !== this.options.privateRoute.peerId) {
        this.store.put('originDeadlines', taskId, { taskId, peerId: intent.route.peerId, expiresAt: new Date(Date.parse(observation.sentAt) +
          (this.options.originReplyTtlMs ?? 15 * 60 * 1000)).toISOString() });
        this.store.put('grants', intent.grantId, this.makeGrant(intent));
      }
      return true;
    });
    if (!created) return { disposition: 'duplicate', taskId: this.taskForSource(observation.ref)?.id };
    if (!this.replaying) await this.admit(intent);
    return { disposition: 'accepted', taskId, status: this.status(taskId) };
  }

  private taskForSource(ref: MessageRef): TaskIntent | undefined {
    const link = this.store.get<{ taskId: string }>('sources', refKey(ref));
    return link && this.store.get<TaskIntent>('tasks', link.taskId);
  }

  /** Delayed old follow-ups cannot supersede a newer authenticated owner amendment. */
  private staleOwnerChange(taskId: string, observation: Observation): boolean {
    const previous = this.store.get<OwnerChange>('taskOwnerChanges', taskId);
    if (!previous) return false;
    const issuedAt = Date.parse(observation.editedAt ?? observation.sentAt), priorAt = Date.parse(previous.authorizedAt);
    if (issuedAt !== priorAt) return issuedAt < priorAt;
    // Telegram timestamp resolution is one second; message IDs order new messages in one room.
    return observation.kind !== 'edit' && observation.ref.peerId === previous.ref.peerId &&
      /^\d+$/u.test(observation.ref.messageId) && /^\d+$/u.test(previous.ref.messageId) &&
      BigInt(observation.ref.messageId) < BigInt(previous.ref.messageId);
  }

  private resolveTask(observation: Observation, command: string): { kind: 'one' | 'none' | 'ambiguous'; task?: TaskIntent } {
    const id = command.match(/#([\w-]+)/)?.[1];
    if (id) {
      const tasks = this.store.list<InternalIntent>('tasks').filter(t => !t.controlOnly && (t.id === id || t.id.startsWith(id)));
      return tasks.length === 1 ? { kind: 'one', task: tasks[0] } : { kind: tasks.length ? 'ambiguous' : 'none' };
    }
    if (observation.replyTo) {
      const own = this.store.get<OwnOutput>('ownOutputs', refKey(observation.replyTo));
      if (own && !own.controlOnly) return { kind: 'one', task: this.store.get<TaskIntent>('tasks', own.taskId) };
      const source = this.taskForSource(observation.replyTo);
      if (source) return { kind: 'one', task: source };
    }
    const active = this.status().filter(s => !['cancelled', 'ready', 'failed'].includes(s.state));
    return active.length === 1 ? { kind: 'one', task: active[0]!.intent } : { kind: active.length ? 'ambiguous' : 'none' };
  }

  private routeFor(observation: Observation, instruction: string, task?: TaskIntent): Route {
    let directive = instruction.trim();
    const prefix = (this.options.commandPrefix ?? '/бро').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    directive = directive.replace(new RegExp('^' + prefix + '(?:\\s+|$)', 'iu'), '');
    // Route authority is a leading directive, never a phrase mentioned inside the task material.
    if (/^(?:(?:--|—|–)here(?:\s|$)|(?:ответь здесь|reply here)\s*:)/iu.test(directive)) return { peerId: observation.ref.peerId,
      threadId: observation.ref.threadId, replyToMessageId: observation.ref.messageId };
    if (/^(?:(?:--|—|–)origin(?:\s|$)|(?:в исходный чат|to (?:the )?origin(?:al)? chat)\s*:)/iu.test(directive) && task) return {
      peerId: task.source.peerId, threadId: task.source.threadId, replyToMessageId: task.source.messageId,
    };
    return { ...this.options.privateRoute };
  }

  private makeGrant(intent: TaskIntent): Grant {
    const capabilities = this.options.capabilityPolicy?.(intent) ?? [
      { capability: 'telegram.read', resources: [...new Set([intent.source.peerId, this.options.privateRoute.peerId])] },
      { capability: 'telegram.send', resources: [intent.route.peerId] },
    ];
    const origin = intent.route.peerId !== this.options.privateRoute.peerId && this.store.get<{ expiresAt: string }>('originDeadlines', intent.id);
    const expires = this.clock.now().getTime() + (this.options.grantTtlMs ?? 7 * 24 * 60 * 60 * 1000);
    const grant = { id: intent.grantId, taskId: intent.id, revision: intent.revision, capabilities,
      expiresAt: new Date(origin ? Math.min(expires, Date.parse(origin.expiresAt)) : expires).toISOString() };
    this.store.put('grantBaselines', grant.id, { expiresAt: grant.expiresAt });
    return grant;
  }

  private async admit(intent: TaskIntent): Promise<void> {
    if (this.requireTask(intent.id).revision !== intent.revision) return;
    if (this.store.list<ChildStop>('childStops').some(stop => stop.taskId === intent.id && stop.state !== 'settled')) {
      await this.hold(intent.id, 'Owned child execution/effects settlement is unresolved', true); return;
    }
    try { await this.prepareTaskAuthority(intent.id); }
    catch (error) {
      if (this.requireTask(intent.id).revision !== intent.revision) return;
      await this.hold(intent.id, 'Authority preparation blocked: ' + (error instanceof Error ? error.message : String(error))); return;
    }
    if (this.requireTask(intent.id).revision !== intent.revision) return;
    const grant = this.store.get<Grant>('grants', intent.grantId)!;
    if (grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= this.clock.now().getTime())) {
      await this.hold(intent.id, 'Task authority expired before admission'); return;
    }
    const key = 'neurobro:' + intent.id + ':' + intent.revision;
    const token = this.broker.issue({ taskId: intent.id, intentRevision: intent.revision,
      grantId: grant.id, grantRevision: grant.revision, runId: 'admission:' + key });
    const admission: Admission = { taskId: intent.id, revision: intent.revision, key, token,
      state: 'reserved', createdAt: this.clock.now().toISOString() };
    if (!this.store.insert('admissions', admissionKey(intent.id, intent.revision), admission)) return;
    let dispatched = false;
    try {
      const prepared = await this.options.prepareInput?.(intent);
      // Preparation can be asynchronous; recheck authority before the provider can start.
      this.broker.resolve(token);
      const previous = this.store.list<RunSnapshot>('runs').filter(s => s.binding.taskId === intent.id &&
        s.binding.intentRevision < intent.revision).sort((a, b) => b.binding.intentRevision - a.binding.intentRevision)[0];
      dispatched = true;
      const snapshot = await this.options.engine.submit({ taskId: intent.id, intentRevision: intent.revision,
        idempotencyKey: key, instruction: intent.instruction, toolContext: token,
        sessionId: prepared?.freshSession ? undefined : previous?.binding.sessionId, stagedFiles: prepared?.stagedFiles,
        context: prepared?.context ?? JSON.stringify({ source: intent.source, contextRefs: intent.contextRefs,
          artifactRefs: intent.artifactRefs, previousOutput: prepared?.freshSession ? undefined : previous?.output,
          previousRunId: prepared?.freshSession ? undefined : previous?.binding.runId }) });
      this.acceptSnapshot(snapshot, intent.id, intent.revision, key);
      admission.state = 'bound'; this.store.put('admissions', admissionKey(intent.id, intent.revision), admission);
      // Cancellation/correction may race the engine's response. Keep the real binding and stop that run.
      try { this.broker.bindToken(token, snapshot.binding); } catch (error) {
        if (!(error instanceof AuthorityError)) throw error;
        try {
          const cancelled = await this.options.engine.cancel(snapshot.binding);
          if (cancelled.binding.runId !== snapshot.binding.runId) throw new AuthorityError('Cancel returned a different run');
          this.acceptSnapshot(cancelled, intent.id, intent.revision, key);
        } catch { /* Original binding is preserved for later inspection; no second dispatch. */ }
      }
    } catch (error) {
      admission.state = dispatched ? 'unknown' : 'blocked'; admission.reason = error instanceof Error ? error.message : String(error);
      this.store.put('admissions', admissionKey(intent.id, intent.revision), admission);
      if (!dispatched) await this.hold(intent.id, 'Input preparation blocked: ' + admission.reason);
    }
  }

  private acceptSnapshot(snapshot: RunSnapshot, taskId: string, revision: number, key: string): void {
    const binding = snapshot.binding;
    if (binding.taskId !== taskId || binding.intentRevision !== revision || binding.idempotencyKey !== key || !binding.runId) {
      throw new AuthorityError('Engine response does not match the submitted task/revision/operation');
    }
    if (!Number.isFinite(Date.parse(snapshot.observedAt))) throw new Error('Engine snapshot lacks a valid observation date');
    if (!['queued', 'running', 'waiting', 'completed', 'failed', 'interrupted', 'cancelled', 'unknown'].includes(snapshot.state)) throw new Error('Invalid engine run state');
    this.store.put('runs', admissionKey(taskId, revision), snapshot);
  }

  private async refresh(snapshot: RunSnapshot): Promise<RunSnapshot | undefined> {
    const key = admissionKey(snapshot.binding.taskId, snapshot.binding.intentRevision);
    const existing = this.activePolls.get(key);
    if (existing) return existing;
    const action = (async () => {
      try {
        const updated = await this.options.engine.inspect(snapshot.binding);
        if (updated.binding.runId !== snapshot.binding.runId) {
          throw new AuthorityError('Inspected engine run changed its registered binding');
        }
        this.acceptSnapshot(updated, snapshot.binding.taskId, snapshot.binding.intentRevision, snapshot.binding.idempotencyKey);
        return updated;
      } catch (error) {
        const unknown: RunSnapshot = { ...snapshot, state: 'unknown', observedAt: this.clock.now().toISOString(),
          reason: error instanceof Error ? error.message : String(error) };
        this.store.put('runs', key, unknown); return unknown;
      }
    })();
    this.activePolls.set(key, action);
    try { return await action; } finally { this.activePolls.delete(key); }
  }

  async poll(): Promise<PollResult> {
    await this.start();
    await this.broker.recover();
    await Promise.all(this.store.list<RunSnapshot>('runs').filter(s => !terminal(s.state)).map(s => this.refresh(s)));
    for (const stop of this.store.list<ChildStop>('childStops').filter(stop => stop.state !== 'settled')) await this.stopChildren(stop.taskId, stop.reason ?? 'Reconcile parent stop', stop.revision);
    await this.resumeSettledCorrections();
    const deliveries: Effect[] = [];
    for (const status of this.status()) {
      if (status.cancelledAt || status.heldAt || status.run?.state !== 'completed' || !status.run.output ||
        status.run.binding.intentRevision !== status.intent.revision) continue;
      const grant = this.store.get<Grant>('grants', status.intent.grantId)!;
      if (grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= this.clock.now().getTime())) continue;
      const token = this.issueToolContext(status.run.binding);
      const route = status.intent.route;
      try {
        const parts = deliveryParts(status.run.output);
        for (let index = 0; index < parts.length; index++) {
          const request: EffectRequest = { id: 'delivery:' + status.run.binding.runId + ':part:' + index,
            capability: 'telegram.send', resource: route.peerId,
            payload: { peerId: route.peerId, ...(route.threadId ? { threadId: route.threadId } : {}),
              ...(route.replyToMessageId ? { replyToMessageId: route.replyToMessageId } : {}),
              text: '🤖 Нейробратик' + (parts.length > 1 ? ' · ' + (index + 1) + '/' + parts.length : '') + '\n\n' + parts[index]! } };
          // Formatting upgrades must not change an already prepared delivery's identity/payload.
          const context = this.resolveToolContext(token);
          const previous = this.store.get<Effect>('effects', effectOperationId(context, request));
          if (previous) request.payload = previous.payload;
          else if (index === 0) {
            const replacement = await this.acknowledgementReplacement(status.intent);
            if (replacement) request.payload = { ...(request.payload as Record<string, import('../contracts.ts').Json>), replaceAcknowledgement: replacement };
          }
          const effect = await this.broker.executeDelivery(token, request);
          deliveries.push(effect);
          if (effect.state !== 'verified') break; // UNKNOWN part settles before the next part can be attempted.
        }
      } catch (error) { if (!(error instanceof AuthorityError)) throw error; }
    }
    return { tasks: this.status(), deliveries };
  }

  status(): TaskStatus[];
  status(taskId: string): TaskStatus | undefined;
  status(taskId?: string): TaskStatus[] | TaskStatus | undefined {
    const selected = taskId ? this.store.get<InternalIntent>('tasks', taskId) : undefined;
    const intents = (taskId ? (selected ? [selected] : []) : this.store.list<InternalIntent>('tasks')).filter(intent => !intent.controlOnly);
    if (!intents.length) return taskId ? undefined : [];
    // This synchronous snapshot shares collection reads across tasks; no cached
    // authority survives the call or hides a later UNKNOWN/control transition.
    const allEffects = this.broker.effects();
    const childStops = this.store.list<ChildStop>('childStops');
    const statuses = intents.map(intent => {
      const run = this.store.get<RunSnapshot>('runs', admissionKey(intent.id, intent.revision));
      const admission = this.store.get<Admission>('admissions', admissionKey(intent.id, intent.revision));
      const control = this.store.get<Control>('controls', intent.id);
      const effects = allEffects.filter(effect => effect.taskId === intent.id);
      const childStop = childStops.find(stop => stop.taskId === intent.id && stop.state !== 'settled');
      const uncertainty = effects.some(e => ['unknown', 'dispatching'].includes(e.state)) || !!childStop;
      const state: TaskStatus['state'] = uncertainty || admission?.state === 'unknown' || run?.state === 'unknown' ? 'unknown' :
        control?.cancelledAt || run?.state === 'cancelled' ? 'cancelled' : control?.heldAt ? 'paused' : run?.state === 'interrupted' ? 'unknown' :
        run?.state === 'completed' ? 'ready' : run?.state === 'failed' ? 'failed' : run ? 'working' : 'accepted';
      return { intent, run, ...(admission ? { admission: { state: admission.state, reason: admission.reason } } : {}),
        ...control, ...(childStop ? { reason: childStop.reason ?? 'Owned child settlement is unresolved' } : {}), effects, state } as TaskStatus;
    });
    return taskId ? statuses.find(s => s.intent.id === taskId) : statuses;
  }

  async cancel(taskId: string): Promise<TaskStatus | undefined> {
    await this.start();
    return this.applyCancellation(taskId);
  }

  private async applyCancellation(taskId: string): Promise<TaskStatus | undefined> {
    const intent = this.requireTask(taskId);
    this.store.transaction(() => {
      const grant = this.store.get<Grant>('grants', intent.grantId)!;
      grant.revokedAt = this.clock.now().toISOString(); grant.revision++;
      this.store.put('grants', grant.id, grant);
      this.store.put<Control>('controls', taskId, { taskId, cancelledAt: grant.revokedAt, reason: 'Owner cancelled task; new effects revoked' });
      this.broker.revokeTask(taskId);
      this.journalChildStop(taskId, 'Owner cancelled task', intent.revision);
    });
    await this.stopChildren(taskId, 'Owner cancelled task', intent.revision);
    for (const snapshot of this.store.list<RunSnapshot>('runs').filter(s => s.binding.taskId === taskId && !terminal(s.state))) {
      try {
        const cancelled = await this.options.engine.cancel(snapshot.binding);
        if (cancelled.binding.runId !== snapshot.binding.runId) throw new AuthorityError('Cancel returned a different run');
        this.acceptSnapshot(cancelled, taskId, snapshot.binding.intentRevision, snapshot.binding.idempotencyKey);
      } catch (error) {
        this.store.put('runs', admissionKey(taskId, snapshot.binding.intentRevision), { ...snapshot, state: 'unknown',
          reason: 'Cancel settlement unknown: ' + (error instanceof Error ? error.message : String(error)), observedAt: this.clock.now().toISOString() });
      }
    }
    return this.status(taskId);
  }

  private async hold(taskId: string, reason: string, resumeWhenSettled = false): Promise<void> {
    const intent = this.requireTask(taskId);
    this.store.transaction(() => {
      if (this.store.get<Control>('controls', taskId)?.cancelledAt) return;
      const grant = this.store.get<Grant>('grants', intent.grantId)!;
      grant.revokedAt = this.clock.now().toISOString(); grant.revision++;
      this.store.put('grants', grant.id, grant); this.broker.revokeTask(taskId);
      this.store.put<Control>('controls', taskId, { taskId, heldAt: grant.revokedAt, reason, resumeWhenSettled });
      this.journalChildStop(taskId, reason, intent.revision);
    });
    await this.stopChildren(taskId, reason, intent.revision);
  }

  private journalChildStop(taskId: string, reason: string, revision: number): void {
    if (this.options.onTaskStop) this.store.put<ChildStop>('childStops', admissionKey(taskId, revision), { taskId, revision, state: 'pending', reason });
  }

  private async stopChildren(taskId: string, reason: string, revision: number): Promise<boolean> {
    const key = admissionKey(taskId, revision);
    const old = this.store.get<ChildStop>('childStops', key);
    if (!this.options.onTaskStop) return !old || old.state === 'settled';
    this.store.put<ChildStop>('childStops', key, { taskId, revision, state: 'pending', reason });
    try {
      const result = await this.options.onTaskStop(taskId, reason, revision);
      this.store.put<ChildStop>('childStops', key, { taskId, revision, state: result.settled === true ? 'settled' : 'unknown', reason: result.reason ?? (result.settled === true ? undefined : 'Owned child execution/effects settlement is unverified') });
      return result.settled === true;
    } catch (error) {
      this.store.put<ChildStop>('childStops', key, { taskId, revision, state: 'unknown', reason: 'Owned child stop unknown: ' + (error instanceof Error ? error.message : String(error)) });
      return false;
    }
  }

  /** Trusted host invalidation suspends future work without changing the owner's objective. */
  async suspendTask(taskId: string, reason: string): Promise<void> {
    await this.start(); await this.hold(taskId, reason);
  }

  async correct(taskId: string, instruction: string, route?: Route): Promise<TaskStatus | undefined> {
    await this.start();
    return this.applyCorrection(taskId, instruction, route);
  }

  /** Trusted context maintenance changes no owner objective, route, scope or expiry. */
  async refreshContext(taskId: string): Promise<TaskStatus | undefined> {
    await this.start();
    return this.applyCorrection(taskId, '', undefined, undefined, this.clock.now().toISOString(), true);
  }

  private async applyCorrection(taskId: string, instruction: string, route?: Route, changeId?: string,
    authorizedAt = this.clock.now().toISOString(), contextRefresh = false, observation?: Observation): Promise<TaskStatus | undefined> {
    if (!contextRefresh && !instruction.trim()) throw new Error('Correction instruction is empty');
    const before = this.requireTask(taskId);
    if (changeId && this.store.get('appliedChanges', changeId)) return this.status(taskId);
    const current = this.store.get<RunSnapshot>('runs', admissionKey(taskId, before.revision));
    const intent = this.store.transaction(() => {
      const actual = this.requireTask(taskId); // Serialize revisions, preserve concurrent prior correction.
      if (observation) {
        const linked = this.taskForSource(observation.ref);
        if (linked && linked.id !== taskId) throw new AuthorityError('Owner follow-up is already bound to another task');
        this.store.put('sources', refKey(observation.ref), { taskId });
        this.store.put<OwnerChange>('taskOwnerChanges', taskId, { ref: observation.ref, authorizedAt: observation.editedAt ?? observation.sentAt });
      }
      if (changeId && !this.store.insert('appliedChanges', changeId, { taskId })) return actual;
      const grant = this.store.get<Grant>('grants', actual.grantId)!;
      grant.revokedAt = this.clock.now().toISOString(); this.store.put('grants', grant.id, grant);
      this.broker.revokeTask(taskId);
      const next = { ...actual, instruction: contextRefresh ? actual.instruction : actual.instruction + '\n\nOwner correction: ' + instruction.trim(),
        contextRefs: [...new Set([...actual.contextRefs, ...(observation?.contextRefs ?? []), ...(observation?.replyTo ? [refKey(observation.replyTo)] : [])])],
        artifactRefs: [...new Set([...actual.artifactRefs, ...(observation?.artifactRefs ?? [])])],
        revision: actual.revision + 1, route: route ?? actual.route, updatedAt: this.clock.now().toISOString(), grantId: randomUUID() };
      if (!contextRefresh && route && route.peerId !== this.options.privateRoute.peerId) {
        this.store.put('originDeadlines', taskId, { taskId, peerId: route.peerId,
          expiresAt: new Date(Date.parse(authorizedAt) + (this.options.originReplyTtlMs ?? 15 * 60 * 1000)).toISOString() });
        this.store.delete('originReview', taskId);
      }
      const nextGrant = this.makeGrant(next);
      if (contextRefresh) {
        nextGrant.capabilities = grant.capabilities; nextGrant.expiresAt = grant.expiresAt;
        this.store.put('grantBaselines', nextGrant.id, this.grantBaseline(actual, grant));
      }
      this.store.put('tasks', taskId, next); this.store.put('grants', next.grantId, nextGrant);
      // Persist the barrier before awaiting native cancellation; crashes cannot open a second run.
      this.store.put<Control>('controls', taskId, { taskId, heldAt: next.updatedAt,
        reason: 'Correction saved; checking prior execution settlement', resumeWhenSettled: true });
      this.journalChildStop(taskId, 'Parent task corrected', before.revision);
      this.store.put('corrections', admissionKey(taskId, next.revision), { taskId, revision: next.revision, instruction, kind: contextRefresh ? 'context_refresh' : 'owner_correction', createdAt: next.updatedAt,
        ...(observation ? { ownerSource: observation.ref, authorizedAt: observation.editedAt ?? observation.sentAt } : {}) });
      return next;
    });
    // Steering must be a native supported boundary. Do not create a second execution alongside an unresolved old run.
    const childrenSettled = await this.stopChildren(taskId, 'Parent task corrected', before.revision);
    if (current && !terminal(current.state)) {
      try {
        const ended = await this.options.engine.cancel(current.binding);
        if (ended.binding.runId !== current.binding.runId) throw new AuthorityError('Cancel returned a different run');
        this.acceptSnapshot(ended, taskId, current.binding.intentRevision, current.binding.idempotencyKey);
        if (!terminal(ended.state)) { await this.hold(taskId, 'Correction saved; old engine execution has not settled', true); return this.status(taskId); }
      } catch { await this.hold(taskId, 'Correction saved; old engine cancellation is unknown', true); return this.status(taskId); }
    }
    if (this.broker.effects(taskId).some(e => ['dispatching', 'unknown'].includes(e.state))) {
      await this.hold(taskId, 'Correction saved; possible external effects must be reconciled', true); return this.status(taskId);
    }
    if (!current && ['unknown', 'reserved'].includes(this.store.get<Admission>('admissions', admissionKey(taskId, before.revision))?.state ?? '')) {
      await this.hold(taskId, 'Correction saved; original engine admission is unresolved', true); return this.status(taskId);
    }
    if (!childrenSettled) return this.status(taskId);
    // Another owner amendment can arrive while settlement is awaited. Only its newest revision may resume.
    if (this.requireTask(taskId).revision !== intent.revision) return this.status(taskId);
    if (this.unresolvedPriorWork(intent)) {
      await this.hold(taskId, 'Correction saved; earlier execution or admission is unresolved', true); return this.status(taskId);
    }
    this.store.delete('controls', taskId);
    if (!this.replaying) await this.admit(intent);
    return this.status(taskId);
  }

  private async resumeSettledCorrections(): Promise<void> {
    for (const control of this.store.list<Control>('controls')) {
      if (!control.resumeWhenSettled || control.cancelledAt) continue;
      const intent = this.requireTask(control.taskId);
      if (this.store.list<ChildStop>('childStops').some(stop => stop.taskId === intent.id && stop.state !== 'settled')) continue;
      const priorAdmissions = this.store.list<Admission>('admissions').filter(a => a.taskId === intent.id && a.revision < intent.revision);
      if (priorAdmissions.some(a => ['unknown', 'reserved'].includes(a.state))) continue;
      const runs = this.store.list<RunSnapshot>('runs').filter(r => r.binding.taskId === intent.id);
      if (runs.some(r => !terminal(r.state))) continue;
      if (this.broker.effects(intent.id).some(e => ['unknown', 'dispatching'].includes(e.state))) continue;
      this.store.transaction(() => {
        const restored = { ...intent, grantId: randomUUID() };
        const nextGrant = this.makeGrant(restored);
        if (this.store.get<{ kind?: string }>('corrections', admissionKey(intent.id, intent.revision))?.kind === 'context_refresh') {
          const prior = this.store.get<Grant>('grants', intent.grantId)!;
          nextGrant.capabilities = prior.capabilities; nextGrant.expiresAt = prior.expiresAt;
          this.store.put('grantBaselines', nextGrant.id, this.grantBaseline(intent, prior));
        }
        this.store.put('tasks', intent.id, restored); this.store.put('grants', restored.grantId, nextGrant);
        this.store.delete('controls', intent.id);
      });
      await this.admit(this.requireTask(intent.id));
    }
  }

  private unresolvedPriorWork(intent: TaskIntent): boolean {
    return this.store.list<Admission>('admissions').some(a => a.taskId === intent.id && a.revision < intent.revision && ['unknown', 'reserved'].includes(a.state)) ||
      this.store.list<RunSnapshot>('runs').some(s => s.binding.taskId === intent.id && s.binding.intentRevision < intent.revision && !terminal(s.state)) ||
      this.broker.effects(intent.id).some(e => ['unknown', 'dispatching'].includes(e.state));
  }

  private requireTask(taskId: string): TaskIntent {
    const intent = this.store.get<TaskIntent>('tasks', taskId);
    if (!intent) throw new Error('Unknown task ID');
    return intent;
  }

  private async prepareTaskAuthority(taskId: string): Promise<ToolContext> {
    const intent = this.requireTask(taskId); const grant = this.store.get<Grant>('grants', intent.grantId)!;
    if (grant.revokedAt) throw new AuthorityError('Revoked authority cannot be refreshed');
    const baseline = this.grantBaseline(intent, grant);
    const prepared = await this.options.prepareAuthority?.(intent);
    this.store.transaction(() => {
      const actual = this.requireTask(taskId); const current = this.store.get<Grant>('grants', actual.grantId)!;
      if (actual.revision !== intent.revision || current.id !== grant.id || current.revision !== grant.revision || current.revokedAt) throw new AuthorityError('Task changed during authority preparation');
      const capabilities = (prepared?.capabilities ?? current.capabilities).map(capability => ({ ...capability,
        resources: capability.resources.filter(resource => this.originResourceAllowed(actual, capability.capability, resource)) }));
      const expiresAt = prepared?.expiresAt === null ? undefined : prepared?.expiresAt ?? (prepared ? baseline.expiresAt : current.expiresAt);
      if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new AuthorityError('Prepared authority deadline is invalid');
      if (canonicalJson(current.capabilities as unknown as import('../contracts.ts').Json) !== canonicalJson(capabilities as unknown as import('../contracts.ts').Json) || expiresAt !== current.expiresAt) {
        this.store.put('grants', current.id, { ...current, revision: current.revision + 1, capabilities: structuredClone(capabilities), expiresAt });
      }
    });
    const current = this.store.get<Grant>('grants', intent.grantId)!;
    const run = this.store.get<RunSnapshot>('runs', admissionKey(taskId, intent.revision));
    return { taskId, intentRevision: intent.revision, grantId: current.id, grantRevision: current.revision,
      runId: run?.binding.runId ?? 'authority:' + taskId + ':' + intent.revision };
  }
  /** Host-only scope refresh; it grants no new execution and cannot revive a revoked task. */
  async refreshAuthority(taskId: string): Promise<ToolContext> { await this.start(); return this.prepareTaskAuthority(taskId); }

  private grantBaseline(intent: TaskIntent, grant: Grant): { expiresAt: string } {
    const saved = this.store.get<{ expiresAt: string }>('grantBaselines', grant.id);
    if (saved) return saved;
    // Older monitored grants lost their TTL. Reconstruct conservatively; restart never renews it.
    const origin = intent.route.peerId !== this.options.privateRoute.peerId && this.store.get<OriginDeadline>('originDeadlines', intent.id);
    const expires = grant.expiresAt ? Date.parse(grant.expiresAt) : Date.parse(intent.createdAt) + (this.options.grantTtlMs ?? 7 * 24 * 60 * 60 * 1000);
    const baseline = { expiresAt: new Date(origin ? Math.min(expires, Date.parse(origin.expiresAt)) : expires).toISOString() };
    this.store.insert('grantBaselines', grant.id, baseline); return baseline;
  }
  private originResourceAllowed(intent: TaskIntent, capability: string, resource: string): boolean {
    if (!['telegram.send', 'telegram.media.send'].includes(capability) || resource === this.options.privateRoute.peerId) return true;
    const deadline = this.store.get<OriginDeadline>('originDeadlines', intent.id);
    const originPeer = deadline?.peerId ?? (intent.route.peerId !== this.options.privateRoute.peerId ? intent.route.peerId : intent.source.peerId);
    if (resource !== originPeer || (!deadline && intent.route.peerId === this.options.privateRoute.peerId)) return true;
    return !!deadline && Number.isFinite(Date.parse(deadline.expiresAt)) && Date.parse(deadline.expiresAt) > this.clock.now().getTime() && !this.store.get('originReview', intent.id);
  }
  private validateOriginResource(context: ToolContext, capability: string, resource: string): void {
    if (!this.originResourceAllowed(this.requireTask(context.taskId), capability, resource)) {
      throw new AuthorityError('Public reply deadline expired or origin draft requires a fresh owner instruction');
    }
  }

  private invalidateOriginDrafts(observation: Observation): void {
    for (const intent of this.store.list<TaskIntent>('tasks')) {
      if (intent.source.peerId !== observation.ref.peerId || intent.route.peerId === this.options.privateRoute.peerId || sameRef(intent.source, observation.ref)) continue;
      const grant = this.store.get<Grant>('grants', intent.grantId)!;
      if (grant.revokedAt) continue;
      grant.capabilities = grant.capabilities.map(g => ['telegram.send', 'telegram.media.send'].includes(g.capability) ?
        { ...g, resources: g.resources.filter(r => r !== observation.ref.peerId) } : g);
      grant.revision++;
      this.store.put('grants', grant.id, grant); this.broker.revokeTask(intent.id);
      this.store.put('originReview', intent.id, { taskId: intent.id, ref: observation.ref, reason: 'Owner manually spoke in origin; external draft requires renewed instruction' });
    }
  }

  issueToolContext(binding: RunBinding): string {
    const snapshot = this.store.get<RunSnapshot>('runs', admissionKey(binding.taskId, binding.intentRevision));
    if (!snapshot || JSON.stringify(snapshot.binding) !== JSON.stringify(binding)) throw new AuthorityError('Run binding is not registered');
    const intent = this.requireTask(binding.taskId); const grant = this.store.get<Grant>('grants', intent.grantId)!;
    return this.broker.issue({ taskId: intent.id, intentRevision: binding.intentRevision, grantId: grant.id,
      grantRevision: grant.revision, runId: binding.runId });
  }
  resolveToolContext(token: string): ToolContext { return { ...this.broker.resolve(token).context }; }
  revokeToolContext(token: string): void { this.broker.revokeToken(token); }
  /** Caller must establish its exact native execution binding before issuing this capability. */
  issueExecutionContext(context: ToolContext): string {
    this.broker.validateExecutionContext(context);
    return this.broker.issue(context);
  }
  validateExecutionContext(context: ToolContext): ToolContext { return this.broker.validateExecutionContext(context); }
  validateAuthority(context: ToolContext): ToolContext { return this.broker.validateAuthority(context); }
  authorizeTool(token: string, capability: string, resource: string): ToolContext { return this.broker.authorize(token, capability, resource); }
  async executeEffect(token: string, request: EffectRequest): Promise<Effect> { await this.start(); return this.broker.execute(token, request); }
  /** The accepted notice is host-owned; model output/text cannot register an acknowledgement. */
  registerAcknowledgement(taskId: string, effect: Effect): void {
    const intent = this.requireTask(taskId), target = this.store.get<{taskId:string}>('controlTargets', effect.taskId);
    const payload = effect.payload as Record<string, import('../contracts.ts').Json>;
    if (target?.taskId !== taskId || effect.capability !== 'telegram.send' || effect.resource !== this.options.privateRoute.peerId ||
      payload.text !== '🤖 Нейробратик\n\nПонял, бро. Сейчас гляну.') throw new AuthorityError('Acknowledgement must be an exact host control reply for this task');
    if (!this.store.get('taskAcknowledgements', taskId)) this.store.put('taskAcknowledgements', taskId, {taskId, intentRevision:intent.revision, effectId:effect.id});
  }
  private async acknowledgementReplacement(intent: TaskIntent): Promise<Record<string, import('../contracts.ts').Json> | undefined> {
    if (!this.options.readDeliveryMessage) return;
    const binding = this.store.get<{intentRevision:number;effectId:string}>('taskAcknowledgements', intent.id);
    if (!binding || binding.intentRevision !== intent.revision) return;
    const effect = this.store.get<Effect>('effects', binding.effectId), receipt = effect?.receipt as Record<string, import('../contracts.ts').Json> | undefined;
    if (!effect || effect.state !== 'verified' || effect.resource !== intent.route.peerId || !receipt || receipt.peerId !== effect.resource || typeof receipt.messageId !== 'string') return;
    const ref:MessageRef = {accountId:this.options.accountId,peerId:effect.resource,messageId:receipt.messageId};
    const own = this.store.get<OwnOutput>('ownOutputs', refKey(ref)), payload = effect.payload as Record<string, import('../contracts.ts').Json>;
    if (own?.taskId !== intent.id || own.effectId !== effect.id || payload.threadId !== intent.route.threadId || payload.replyToMessageId !== intent.route.replyToMessageId) return;
    let current:Observation|undefined;
    try { current = await this.options.readDeliveryMessage(ref); } catch { return; }
    if (!current || !sameRef(current.ref, ref) || !current.outgoing || current.authorId !== this.options.accountId || current.forwarded || current.viaBot ||
      current.agentEffectId !== effect.id || current.text !== payload.text || current.ref.threadId !== intent.route.threadId) return;
    return {effectId:effect.id,payloadHash:effect.payloadHash,messageId:receipt.messageId,expectedText:payload.text!};
  }
  /** Host-only response for status/cancel/ambiguity. It consumes no model run or generic service grant. */
  async journalControlReply(observation: Observation, text: string, targetTaskId?: string): Promise<Effect> {
    await this.start();
    const trustedSourceDeletion = observation.kind === 'delete' && observation.ref.accountId === this.options.accountId &&
      !observation.forwarded && !observation.viaBot && (observation.authorId === undefined || observation.authorId === this.options.ownerId) &&
      Boolean(this.taskForSource(observation.ref));
    if (!this.authenticate(observation) && !trustedSourceDeletion) throw new AuthorityError('Control replies require an authenticated owner observation');
    if (targetTaskId) this.requireTask(targetTaskId);
    const id = 'control:' + refKey(observation.ref) + ':' + observation.kind + ':' + (observation.version ?? '');
    let intent = this.store.get<InternalIntent>('tasks', id);
    if (!intent) {
      const now = this.clock.now().toISOString();
      intent = { id, ownerId: this.options.ownerId, accountId: this.options.accountId, source: observation.ref,
        instruction: 'Private control response', revision: 1, route: { ...this.options.privateRoute },
        createdAt: now, updatedAt: now, contextRefs: [], artifactRefs: [], grantId: randomUUID(), controlOnly: true };
      this.store.transaction(() => {
        this.store.put('tasks', id, intent);
        this.store.put<Grant>('grants', intent!.grantId, { id: intent!.grantId, taskId: id, revision: 1,
          capabilities: [{ capability: 'telegram.send', resources: [this.options.privateRoute.peerId] }],
          expiresAt: new Date(this.clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString() });
        if (targetTaskId) this.store.put('controlTargets', id, { taskId: targetTaskId });
      });
    }
    const grant = this.store.get<Grant>('grants', intent.grantId)!;
    const token = this.broker.issue({ taskId: id, intentRevision: 1, grantId: grant.id, grantRevision: grant.revision,
      runId: 'control:' + observation.id });
    const route = this.options.privateRoute;
    const existing = this.broker.effects(id)[0];
    if (existing) return existing; // A changed status readback cannot accidentally resend the same control observation.
    return this.broker.execute(token, { id: 'control-reply', capability: 'telegram.send', resource: route.peerId,
      payload: { peerId: route.peerId, ...(route.threadId ? { threadId: route.threadId } : {}), text: '🤖 Нейробратик\n\n' + text } });
  }
  registerOwnOutput(ref: MessageRef, taskId: string, effectId?: string): void {
    this.requireTask(taskId);
    if (ref.accountId !== this.options.accountId) throw new AuthorityError('Own output belongs to a different account');
    this.store.put<OwnOutput>('ownOutputs', refKey(ref), { ref, taskId, effectId });
  }
  private captureOwnReceipt(effect: Effect): void {
    if (!['telegram.send', 'telegram.media.send'].includes(effect.capability) || !effect.receipt || typeof effect.receipt !== 'object' || Array.isArray(effect.receipt)) return;
    const receipt = effect.receipt;
    const peerId = typeof receipt.peerId === 'string' ? receipt.peerId : effect.resource;
    const messageId = receipt.messageId;
    if (typeof messageId === 'string') {
      const ref = { accountId: this.options.accountId, peerId, messageId,
        ...(typeof receipt.threadId === 'string' ? { threadId: receipt.threadId } : {}) };
      const target = this.store.get<{ taskId: string }>('controlTargets', effect.taskId);
      const intent = this.store.get<InternalIntent>('tasks', effect.taskId);
      this.store.put<OwnOutput>('ownOutputs', refKey(ref), { ref, taskId: target?.taskId ?? effect.taskId, effectId: effect.id,
        controlOnly: intent?.controlOnly && !target });
    }
  }
  close(): void { if (!this.closed) { this.closed = true; this.store.close(); } }
}

/** Native receipt identity, independent of message text, captions or formatting. */
export function matchesOwnMessageReceipt(effect: Effect, observation: Observation): boolean {
  if (!['telegram.send','telegram.message.send','message.send','telegram.media.send','telegram.poll.create','telegram.schedule.create'].includes(effect.capability)) return false;
  if (!observation.outgoing || effect.resource !== observation.ref.peerId) return false;
  const receipt = effect.receipt;
  return !!receipt && !Array.isArray(receipt) && typeof receipt === 'object' &&
    receipt.peerId === observation.ref.peerId &&
    (receipt.messageId === observation.ref.messageId || receipt.tempMessageId === observation.ref.messageId);
}

export function createPersonalAgent(options: PersonalAgentOptions): PersonalAgent { return new PersonalAgent(options); }
