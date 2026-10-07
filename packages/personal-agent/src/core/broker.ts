import { createHash, randomBytes } from 'node:crypto';
import type { Clock, Effect, EffectExecutor, EffectResult, Grant, Json, RunBinding, TaskIntent, ToolContext } from '../contracts.ts';
import { systemClock } from '../contracts.ts';
import { PersonalStore } from './store.ts';
import { OWNER_ACCOUNT_RESOURCE, permitsOwnerAccountResource } from './owner-account.ts';

export interface EffectRequest { id?: string; capability: string; resource: string; payload: Json }
interface ContextRecord { context: ToolContext; expiresAt: string; revokedAt?: string }
export class AuthorityError extends Error { constructor(message: string) { super(message); this.name = 'AuthorityError'; } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function permits(grant: Grant, capability: string, resource: string): boolean {
  return grant.capabilities.some(g => {
    if (g.capability !== capability) return false;
    if (g.resources.includes(resource)) return true;
    if (g.resources.includes(OWNER_ACCOUNT_RESOURCE) && permitsOwnerAccountResource(capability, resource)) return true;
    if (!['web.fetch', 'web.download'].includes(capability) || !g.resources.includes('public-web')) return false;
    try {
      const url = new URL(resource);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === resource;
    } catch { return false; }
  });
}

/** Stable canonical JSON avoids different object insertion orders defeating effect dedupe. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Effect payload contains non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key]!)).join(',') + '}';
}

/** The broker's sole operation identity, also used by trusted projection readers. */
export function effectOperationId(context: ToolContext, request: EffectRequest): string {
  const identity: Json[] = [context.taskId, context.intentRevision, request.id ?? hash(canonicalJson(request.payload)), request.capability, request.resource];
  if (context.runId.startsWith('cron:')) identity.splice(2, 0, context.runId);
  return hash(canonicalJson(identity));
}

export class EffectBroker {
  private readonly store: PersonalStore;
  private readonly executor: EffectExecutor;
  private readonly clock: Clock;
  private readonly contextTtlMs: number;
  private readonly onVerified?: (effect: Effect) => void;
  private readonly validateAdditionalContext?: (context: ToolContext) => void;
  private readonly validateResource?: (context: ToolContext, capability: string, resource: string) => void;
  private readonly validateEffect?: (context: ToolContext, request: EffectRequest) => void;
  private readonly inFlight = new Set<string>();
  constructor(store: PersonalStore, executor: EffectExecutor, clock: Clock = systemClock,
    contextTtlMs = 24 * 60 * 60 * 1000, onVerified?: (effect: Effect) => void,
    validateAdditionalContext?: (context: ToolContext) => void,
    validateResource?: (context: ToolContext, capability: string, resource: string) => void,
    validateEffect?: (context: ToolContext, request: EffectRequest) => void) {
    this.store = store; this.executor = executor; this.clock = clock;
    this.contextTtlMs = contextTtlMs; this.onVerified = onVerified;
    this.validateAdditionalContext = validateAdditionalContext;
    this.validateResource = validateResource; this.validateEffect = validateEffect;
  }

  issue(context: ToolContext): string {
    // Initial reservation precedes input preparation. Tokens cannot execute until resolve validates its manifest.
    this.validateContext(context, false);
    const token = randomBytes(32).toString('base64url');
    this.store.put<ContextRecord>('contexts', hash(token), {
      context, expiresAt: new Date(this.clock.now().getTime() + this.contextTtlMs).toISOString(),
    });
    return token;
  }

  bindToken(token: string, binding: RunBinding): void {
    const record = this.resolve(token);
    if (record.context.taskId !== binding.taskId || record.context.intentRevision !== binding.intentRevision) {
      throw new AuthorityError('Run binding does not belong to token');
    }
    record.context.runId = binding.runId;
    this.store.put('contexts', hash(token), record);
  }

  /** Native schedule pause/cancel can revoke one execution without revoking the task grant. */
  revokeToken(token: string): void {
    if (typeof token !== 'string' || token.length > 256) throw new AuthorityError('Invalid tool context');
    const key = hash(token);
    const record = this.store.get<ContextRecord>('contexts', key);
    if (!record || record.revokedAt) return;
    record.revokedAt = this.clock.now().toISOString();
    this.store.put('contexts', key, record);
  }

  resolve(token: string): ContextRecord {
    if (typeof token !== 'string' || token.length > 256) throw new AuthorityError('Invalid tool context');
    const record = this.store.get<ContextRecord>('contexts', hash(token));
    if (!record || record.revokedAt || Date.parse(record.expiresAt) <= this.clock.now().getTime()) {
      throw new AuthorityError('Tool context missing, expired or revoked');
    }
    this.validateContext(record.context);
    return record;
  }

  authorize(token: string, capability: string, resource: string): ToolContext {
    const { context } = this.resolve(token);
    const { grant } = this.validateContext(context);
    if (!permits(grant, capability, resource)) {
      throw new AuthorityError('Capability/resource is outside the trusted grant');
    }
    this.validateResource?.({ ...context }, capability, resource);
    return { ...context };
  }

  /** Used only by trusted native schedule/run adapters, never model-selected IDs. */
  validateExecutionContext(context: ToolContext): ToolContext {
    this.validateContext(context);
    return { ...context };
  }

  /** Trusted schedule registration checks authority before preparing a fresh projection. */
  validateAuthority(context: ToolContext): ToolContext {
    this.validateContext(context, false);
    return { ...context };
  }

  private validateContext(context: ToolContext, validateAdditional = true): { intent: TaskIntent; grant: Grant } {
    const intent = this.store.get<TaskIntent>('tasks', context.taskId);
    const grant = this.store.get<Grant>('grants', context.grantId);
    if (!intent || !grant || intent.grantId !== grant.id || grant.taskId !== intent.id ||
      intent.revision !== context.intentRevision || grant.revision !== context.grantRevision ||
      grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= this.clock.now().getTime())) {
      throw new AuthorityError('Current task intention or grant does not authorize this context');
    }
    if (validateAdditional && this.validateAdditionalContext) {
      try { this.validateAdditionalContext({ ...context }); }
      catch (error) { throw new AuthorityError('Execution context invalidated: ' + (error instanceof Error ? error.message : String(error))); }
    }
    return { intent, grant };
  }

  revokeTask(taskId: string): void {
    const now = this.clock.now().toISOString();
    // Current grant/revision is authoritative; old context tokens fail validation immediately.
    for (const effect of this.store.list<Effect>('effects')) {
      if (effect.taskId === taskId && effect.state === 'prepared') {
        effect.state = 'cancelled'; effect.updatedAt = now; effect.reason = 'Task authority revoked before dispatch';
        this.store.put('effects', effect.id, effect);
      }
    }
  }

  async execute(token: string, request: EffectRequest): Promise<Effect> {
    if (request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload) && 'replaceAcknowledgement' in request.payload) {
      throw new AuthorityError('Acknowledgement replacement is reserved for host final delivery');
    }
    return this.executeBound(token, request);
  }

  /** Trusted controller final delivery uses the existing send grant and operation ID. */
  async executeDelivery(token:string,request:EffectRequest):Promise<Effect>{
    const {context}=this.resolve(token),payload=request.payload as Record<string,Json>,replacement=payload?.replaceAcknowledgement as Record<string,Json>|undefined;
    if(replacement){
      const binding=this.store.get<{intentRevision:number;effectId:string}>('taskAcknowledgements',context.taskId);
      const original=typeof replacement.effectId==='string'?this.store.get<Effect>('effects',replacement.effectId):undefined;
      const receipt=original?.receipt as Record<string,Json>|undefined;
      const target=original&&this.store.get<{taskId:string}>('controlTargets',original.taskId);
      if(request.id!=='delivery:'+context.runId+':part:0'||request.capability!=='telegram.send'||binding?.intentRevision!==context.intentRevision||binding.effectId!==original?.id||target?.taskId!==context.taskId||
        original?.state!=='verified'||original.resource!==request.resource||replacement.payloadHash!==original.payloadHash||receipt?.peerId!==request.resource||receipt.messageId!==replacement.messageId||
        replacement.expectedText!=='🤖 Нейробратик\n\nПонял, бро. Сейчас гляну.')throw new AuthorityError('Final delivery acknowledgement binding mismatch');
    }
    return this.executeBound(token,request);
  }

  private async executeBound(token: string, request: EffectRequest): Promise<Effect> {
    if (!request.capability || !request.resource) throw new AuthorityError('Capability and resource are required');
    const { context } = this.resolve(token);
    const { grant } = this.validateContext(context);
    if (!permits(grant, request.capability, request.resource)) {
      throw new AuthorityError('Effect capability/resource is outside the trusted grant');
    }
    this.validateResource?.({ ...context }, request.capability, request.resource);
    this.validateEffect?.({ ...context }, request);
    const payloadHash = hash(canonicalJson(request.payload));
    // Caller IDs are scoped to a task revision. A model cannot collide with another task's effect.
    const id = effectOperationId(context, request);
    let effect = this.store.get<Effect>('effects', id);
    if (effect) {
      if (effect.payloadHash !== payloadHash || effect.capability !== request.capability || effect.resource !== request.resource) {
        throw new AuthorityError('Effect logical ID reused with a different payload');
      }
      return effect; // UNKNOWN/failed/dispatching are never blindly replayed.
    }
    const now = this.clock.now().toISOString();
    effect = {
      id, taskId: context.taskId, intentRevision: context.intentRevision,
      grantId: context.grantId, grantRevision: context.grantRevision,
      capability: request.capability, resource: request.resource, payload: request.payload, payloadHash,
      state: 'prepared', createdAt: now, updatedAt: now,
    };
    this.store.transaction(() => {
      this.validateContext(context);
      this.validateResource?.({ ...context }, request.capability, request.resource);
      this.validateEffect?.({ ...context }, request);
      if (!this.store.insert('effects', id, effect)) throw new AuthorityError('Effect was concurrently prepared');
      effect!.state = 'dispatching';
      this.store.put('effects', id, effect);
    });
    let result: EffectResult;
    this.inFlight.add(effect.id);
    try { result = await this.executor.dispatch(effect); }
    catch (error) { result = { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }; }
    finally { this.inFlight.delete(effect.id); }
    return this.settle(effect, result);
  }

  private settle(effect: Effect, result: EffectResult): Effect {
    if (!['verified', 'failed', 'unknown'].includes(result.state)) throw new Error('Invalid effect settlement');
    const existing = this.store.get<Effect>('effects', effect.id);
    if (existing?.state === 'verified') return existing;
    const settled = { ...effect, ...result, updatedAt: this.clock.now().toISOString() };
    // A final success must not inherit a prior pending/interrupted diagnostic.
    if (result.state === 'verified' && result.reason === undefined) delete settled.reason;
    this.store.put('effects', effect.id, settled);
    if (settled.state === 'verified') this.onVerified?.(settled);
    return settled;
  }

  async recover(): Promise<void> {
    for (const stored of this.store.list<Effect>('effects')) {
      if (!['dispatching', 'unknown'].includes(stored.state)) continue;
      if (this.inFlight.has(stored.id)) continue;
      const effect: Effect = { ...stored, state: 'unknown', reason: stored.reason ?? 'Interrupted during dispatch',
        updatedAt: this.clock.now().toISOString() };
      this.store.put('effects', effect.id, effect);
      let result: EffectResult;
      try { result = await this.executor.reconcile(effect); }
      catch (error) { result = { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }; }
      this.settle(effect, result);
    }
  }

  effects(taskId?: string): Effect[] { return this.store.list<Effect>('effects').filter(e => !taskId || e.taskId === taskId); }
}
