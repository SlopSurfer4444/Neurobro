import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Json, ToolContext } from '../contracts.ts';
import type { RegisteredTool } from '../capabilities/types.ts';
import { obj, str, id } from '../capabilities/schema.ts';

/** This must be the broker's encrypted store, never Hermes' plaintext admission DB. */
export interface ScheduleStore {
  get<T>(namespace: string, key: string): T | undefined;
  put<T>(namespace: string, key: string, value: T): void;
  list<T>(namespace: string): T[];
  transaction<T>(operation: () => T): T;
}
export interface ScheduleCore {
  store: ScheduleStore;
  /** Checks current intent revision, grant identity/revision, revocation and expiry.
   * Schedule scope has no foreground run pointer: validate the bound task/grant. */
  validateScope(context: ToolContext): void;
  issueToolContext(context: ToolContext): string;
  revokeToolContext(token: string): void;
  resolveToolContext(token: string): ToolContext;
}
export interface ScheduleSpec { key: string; name: string; schedule: string; instruction: string }
export interface ScheduleManifest {
  job_id: string; execution_id: string; task_id: string; outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
  output_file: string | null; output_sha256: string | null;
  [key: string]: Json;
}
interface Execution { runId: string; token: string; admittedAt: string; revoked?: boolean; manifest?: ScheduleManifest; callbackState?: 'pending' | 'verified' | 'unknown' }
interface ScheduleRecord {
  id: string; key: string; binding: ToolContext; spec: ScheduleSpec; credential: string;
  nativeJobId?: string; state: 'prepared' | 'active' | 'paused' | 'cancelled';
  executions: Record<string, Execution>; createdAt: string;
  pendingControl?: 'pause' | 'resume' | 'cancel';
  nativeBinding?: { state: 'verified' | 'unknown'; checkedAt: string; reason?: 'restore_unconfirmed' | 'restore_deferred' };
  hostCancellation?: { requestedAt: string; nativeCleanup: 'pending' | 'verified' | 'unknown'; reason?: HostScheduleCancellation['reason'] };
}
export interface ScheduleView { id: string; jobId?: string; name: string; schedule: string; state: string; nativeBinding?: { state: 'verified' | 'unknown'; reason?: 'restore_unconfirmed' | 'restore_deferred' }; activeExecutionsMayRemain: boolean; executions: { id: string; state: string; manifest?: ScheduleManifest; callbackState?: 'pending' | 'verified' | 'unknown' }[] }
export interface ScheduleRestorationSummary { restored: number; degraded: number; skipped: number }
export interface ScheduleCompletion { ok: true; replayed: boolean; callback?: 'pending' | 'verified' | 'unknown'; reconciliation_required?: true }
/** Trusted host identity only. At least one immutable schedule identifier is
 * required; every supplied identifier must match the same exact stored record. */
export interface HostScheduleCancellationInput { taskId: string; scheduleId?: string; key?: string; nativeJobId?: string; /** Trusted independent readback fence, including unknown local native identity. */ expectedNativeJobId?: string }
export interface HostScheduleCancellation {
  schedule: ScheduleView; nativeCleanup: 'verified' | 'unknown';
  reason?: 'native_job_identity_unknown' | 'native_cancel_unconfirmed';
}
export interface ScheduleOptions {
  core: ScheduleCore;
  native: { baseUrl: string; registrationKey: string; timeoutMs?: number };
  /** Trusted synchronous host preparation of the current per-execution context
   * manifest. Runs only for new executions, inside the admission transaction,
   * before issuing a token. Throws to deny; never changes task/grant authority. */
  prepareExecution?: (context: ToolContext) => void;
  /** Optional host callback. The coordinator never sends results itself. */
  onComplete?: (context: ToolContext, manifest: ScheduleManifest, executionToken: string) => Promise<void>;
}
const namespace = 'hermesSchedules';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
function text(value: unknown, max = 255, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u : /[\u0000-\u001f]/u).test(value)) throw new Error('Invalid schedule field');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid schedule response');
  return value as Record<string, unknown>;
}
function executionId(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9._-]+$/u.test(result) || ['__proto__','constructor','prototype'].includes(result)) throw new Error('Invalid cron execution identity');
  return result;
}
function equalCredential(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}
function scopeEqual(a: ToolContext, b: ToolContext): boolean {
  return a.taskId === b.taskId && a.intentRevision === b.intentRevision && a.grantId === b.grantId && a.grantRevision === b.grantRevision;
}
const view = (record: ScheduleRecord): ScheduleView => ({ id: record.id, jobId: record.nativeJobId, name: record.spec.name, schedule: record.spec.schedule, state: record.pendingControl ? `${record.pendingControl}-pending` : record.state, ...(record.nativeBinding ? { nativeBinding: { state: record.nativeBinding.state, ...(record.nativeBinding.reason ? { reason: record.nativeBinding.reason } : {}) } } : {}), activeExecutionsMayRemain: Object.values(record.executions).some(entry => !entry.manifest),
  executions: Object.entries(record.executions).map(([id, entry]) => ({ id, state: entry.manifest?.outcome ?? 'admitted', ...(entry.manifest ? { manifest: structuredClone(entry.manifest) } : {}), ...(entry.callbackState ? { callbackState: entry.callbackState } : {}) })) });

/** Hermes native cron is the only scheduler. This coordinator contains no timers,
 * foreground engine submissions or task-state writes. Credentials are per schedule. */
export class HermesScheduleCoordinator {
  private readonly options: ScheduleOptions;
  private readonly base: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(options: ScheduleOptions) {
    const url = new URL(options.native.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || options.native.registrationKey.length < 32) throw new Error('Cron management requires numeric loopback and a strong registration key');
    this.options = options; this.base = url.href.replace(/\/$/u, '');
    this.options.core.store.transaction(() => {
      const identity = digest(this.base), old = this.options.core.store.get<string>('metadata', 'hermesScheduleNativeScope');
      if (old && old !== identity) throw new Error('Schedule registry belongs to another native cron endpoint');
      if (!old) this.options.core.store.put('metadata', 'hermesScheduleNativeScope', identity);
    });
  }
  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation); this.locks.set(key, current);
    try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  private async request(path: string, body?: unknown, timeoutMs = this.options.native.timeoutMs ?? 5000): Promise<Record<string, unknown>> {
    const response = await fetch(this.base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.options.native.registrationKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const raw = await response.text(); if (raw.length > 1_048_576) throw new Error('Oversized cron management response');
    const data = object(JSON.parse(raw)); if (!response.ok || data.ok !== true) throw new Error('Cron management rejected request'); return data;
  }
  private owned(context: ToolContext, id: string): ScheduleRecord {
    this.options.core.validateScope(context);
    const record = this.options.core.store.get<ScheduleRecord>(namespace, id);
    if (!record || !scopeEqual(context, record.binding)) throw new Error('Schedule is outside current task scope');
    return record;
  }
  async create(context: ToolContext, input: ScheduleSpec): Promise<ScheduleView> {
    const spec = { key: text(input.key), name: text(input.name), schedule: text(input.schedule, 1024), instruction: text(input.instruction, 32768, true) };
    const id = 'sch_' + digest({ taskId: context.taskId, key: spec.key }).slice(0, 48);
    return this.serial(id, async () => {
      this.options.core.validateScope(context);
      let record = this.options.core.store.transaction(() => {
        const old = this.options.core.store.get<ScheduleRecord>(namespace, id);
        if (old) { if (!scopeEqual(context, old.binding) || digest(old.spec) !== digest(spec)) throw new Error('Schedule key conflicts with its immutable scope/spec'); return old; }
        const prepared: ScheduleRecord = { id, key: id, binding: structuredClone(context), spec, credential: randomBytes(32).toString('base64url'), state: 'prepared', executions: {}, createdAt: new Date().toISOString() };
        this.options.core.store.put(namespace, id, prepared); return prepared;
      });
      if (record.nativeJobId || record.state === 'cancelled' || record.pendingControl === 'cancel') return view(record);
      // Persist intent and its opaque credential before external creation. Repeated
      // creation uses the same immutable native key after an uncertain response.
      const response = await this.request('/cron/jobs', { key: record.key, name: spec.name, schedule: spec.schedule, instruction: spec.instruction, schedule_context: record.credential });
      const jobId = text(object(response.job).id);
      record = this.options.core.store.transaction(() => {
        const current = this.options.core.store.get<ScheduleRecord>(namespace, id)!;
        if (current.nativeJobId && current.nativeJobId !== jobId) throw new Error('Native cron job identity changed');
        current.nativeJobId = jobId; current.state = 'active'; this.options.core.store.put(namespace, id, current); return current;
      });
      // A revocation racing native creation blocks admission locally even before
      // native cancellation is confirmed. Do not claim creation in stale scope.
      this.options.core.validateScope(context); return view(record);
    });
  }
  list(context: ToolContext): ScheduleView[] {
    this.options.core.validateScope(context);
    return this.options.core.store.list<ScheduleRecord>(namespace).filter(record => scopeEqual(context, record.binding)).map(view);
  }
  /** Route classification only, including prepared subscriber activation gaps.
   * A match never issues a token or changes admission/source authority. */
  matchesExecution(context: ToolContext, key: string): boolean {
    return this.options.core.store.list<ScheduleRecord>(namespace).some(record => scopeEqual(context, record.binding) && record.spec.key === key && !!record.nativeJobId && context.runId.startsWith(`cron:${record.nativeJobId}:`));
  }
  async inspect(context: ToolContext, id: string): Promise<ScheduleView & { native?: Json }> {
    const record = this.owned(context, text(id));
    const native = json(await this.request(record.nativeJobId ? '/cron/jobs/' + encodeURIComponent(record.nativeJobId) : '/cron/lookup/' + encodeURIComponent(record.key)));
    this.options.core.validateScope(context); return { ...view(record), ...(native ? { native } : {}) };
  }
  async control(context: ToolContext, id: string, action: 'pause' | 'resume' | 'cancel'): Promise<ScheduleView> {
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('Invalid schedule control');
    return this.serial(text(id), async () => {
      let record = this.owned(context, id);
      if (!record.nativeJobId || (record.state === 'cancelled' && action !== 'cancel')) throw new Error('Schedule cannot be controlled');
      if (record.pendingControl && record.pendingControl !== action && action !== 'cancel') throw new Error('Schedule pending control requires same-action reconciliation');
      // Block fresh admissions before pause/cancel wire dispatch. An uncertain
      // response keeps this intent until explicit same-action reconciliation.
      this.options.core.store.transaction(() => {
        record.pendingControl = action;
        if (action !== 'resume') for (const entry of Object.values(record.executions)) { this.options.core.revokeToolContext(entry.token); entry.revoked = true; }
        this.options.core.store.put(namespace, id, record);
      });
      await this.request(`/cron/jobs/${encodeURIComponent(record.nativeJobId)}/${action}`, {});
      record = this.options.core.store.transaction(() => {
        const latest = this.options.core.store.get<ScheduleRecord>(namespace, id)!;
        latest.state = action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'cancelled'; delete latest.pendingControl;
        this.options.core.store.put(namespace, id, latest); return latest;
      });
      this.options.core.validateScope(context); return view(record);
    });
  }
  /** Host-only withdrawal of an exact known subscription binding. Cancellation
   * is permitted after grant revocation because it only removes authority. This
   * method is deliberately absent from tools and HTTP routes, never issues a
   * token, never resumes a job and never validates or renews a revoked grant. */
  async cancelFromHost(input: HostScheduleCancellationInput): Promise<HostScheduleCancellation> {
    const taskId = text(input.taskId), scheduleId = input.scheduleId === undefined ? undefined : text(input.scheduleId),
      key = input.key === undefined ? undefined : text(input.key), nativeJobId = input.nativeJobId === undefined ? undefined : text(input.nativeJobId), expectedNativeJobId = input.expectedNativeJobId === undefined ? undefined : text(input.expectedNativeJobId);
    if (!scheduleId && !key && !nativeJobId) throw new Error('Exact schedule identity is required for host cancellation');
    const matches = this.options.core.store.list<ScheduleRecord>(namespace).filter(record => record.binding.taskId === taskId &&
      (scheduleId === undefined || record.id === scheduleId) && (key === undefined || record.spec.key === key) &&
      (nativeJobId === undefined || record.nativeJobId === nativeJobId) && (expectedNativeJobId === undefined || record.nativeJobId === undefined || record.nativeJobId === expectedNativeJobId));
    if (matches.length !== 1) throw new Error('Host cancellation schedule identity is absent or ambiguous');
    const id = matches[0]!.id;
    return this.serial(id, async () => {
      let record = this.options.core.store.transaction(() => {
        const current = this.options.core.store.get<ScheduleRecord>(namespace, id);
        if (!current || current.binding.taskId !== taskId || (scheduleId !== undefined && current.id !== scheduleId) ||
          (key !== undefined && current.spec.key !== key) || (nativeJobId !== undefined && current.nativeJobId !== nativeJobId) || (expectedNativeJobId !== undefined && current.nativeJobId !== undefined && current.nativeJobId !== expectedNativeJobId)) throw new Error('Host cancellation binding changed');
        if (current.hostCancellation?.nativeCleanup === 'verified') return current;
        current.pendingControl = 'cancel'; current.state = 'cancelled';
        current.hostCancellation = { requestedAt: current.hostCancellation?.requestedAt ?? new Date().toISOString(), nativeCleanup: 'pending' };
        for (const execution of Object.values(current.executions)) { this.options.core.revokeToolContext(execution.token); execution.revoked = true; }
        this.options.core.store.put(namespace, id, current); return current;
      });
      if (record.hostCancellation?.nativeCleanup === 'verified') return { schedule: view(record), nativeCleanup: 'verified' };
      let nativeCleanup: 'verified' | 'unknown' = 'unknown', reason: HostScheduleCancellation['reason'];
      if (!record.nativeJobId) {
        // Read-only lookup never re-creates/resumes an uncertain job. The
        // durable local tombstone already denies admission, including after
        // grant revocation. Older extensions that lack lookup stay unknown.
        try {
          const found = await this.request('/cron/lookup/' + encodeURIComponent(record.key));
          if (found.key !== record.key) throw new Error('Native schedule lookup identity changed');
          if (found.job === null && found.absenceVerified === true) nativeCleanup = 'verified';
          else {
            const job = object(found.job), discovered = text(job.id);
            if (found.scopeVerified !== true || job.required_admission !== 'neurobro' || job.admission_key !== record.key) throw new Error('Native schedule lookup scope changed');
            if (expectedNativeJobId !== undefined && discovered !== expectedNativeJobId) throw new Error('Native schedule lookup differs from independent readback');
            record = this.options.core.store.transaction(() => {
              const latest = this.options.core.store.get<ScheduleRecord>(namespace, id)!;
              if (latest.nativeJobId && latest.nativeJobId !== discovered) throw new Error('Native cron job identity changed');
              latest.nativeJobId = discovered; this.options.core.store.put(namespace, id, latest); return latest;
            });
          }
        } catch { reason = 'native_job_identity_unknown'; }
      }
      if (record.nativeJobId && nativeCleanup !== 'verified') {
        try { await this.request(`/cron/jobs/${encodeURIComponent(record.nativeJobId)}/cancel`, {}); nativeCleanup = 'verified'; }
        catch { reason = 'native_cancel_unconfirmed'; }
      }
      record = this.options.core.store.transaction(() => {
        const latest = this.options.core.store.get<ScheduleRecord>(namespace, id)!;
        latest.hostCancellation = { requestedAt: latest.hostCancellation!.requestedAt, nativeCleanup, ...(reason ? { reason } : {}) };
        if (nativeCleanup === 'verified') delete latest.pendingControl;
        this.options.core.store.put(namespace, id, latest); return latest;
      });
      return { schedule: view(record), nativeCleanup, ...(reason ? { reason } : {}) };
    });
  }
  async restoreBindings(): Promise<ScheduleRestorationSummary> {
    const records = this.options.core.store.list<ScheduleRecord>(namespace), summary = { restored: 0, degraded: 0, skipped: 0 };
    // A missing/drifted job must not disable unrelated tools or healthy jobs.
    // Bound startup globally as well as per request when native cron is down.
    const deadline = Date.now() + 15000; let next = 0;
    const restore = async (id: string) => this.serial(id, async () => {
      const record = this.options.core.store.get<ScheduleRecord>(namespace, id)!;
      // An uncertain create has no confirmed native identity. Its native row
      // may not exist at all; restoring it would reject startup before the
      // same-key create reconciliation is available. Preserve it, deny its
      // admissions and require explicit reconciliation through create().
      if (record.state === 'cancelled' || !record.nativeJobId) { summary.skipped++; return; }
      // Revoked bindings remain in encrypted evidence; never re-enroll authority.
      try { this.options.core.validateScope(record.binding); } catch { summary.skipped++; return; }
      const save = (state: 'verified' | 'unknown', reason?: 'restore_unconfirmed' | 'restore_deferred') => this.options.core.store.transaction(() => {
        const latest = this.options.core.store.get<ScheduleRecord>(namespace, id)!;
        latest.nativeBinding = { state, checkedAt: new Date().toISOString(), ...(reason ? { reason } : {}) }; this.options.core.store.put(namespace, id, latest);
      });
      // Quarantine before dispatch, so callbacks cannot race an uncertain restore.
      save('unknown', 'restore_unconfirmed');
      const remaining = deadline - Date.now();
      if (remaining <= 0) { save('unknown', 'restore_deferred'); summary.degraded++; return; }
      try {
        const result = await this.request('/cron/bindings', { key: record.key, schedule_context: record.credential }, Math.min(remaining, this.options.native.timeoutMs ?? 5000));
        if (result.key !== undefined && result.key !== record.key) throw new Error('Native binding identity changed');
        this.options.core.validateScope(record.binding); save('verified'); summary.restored++;
      } catch { save('unknown', 'restore_unconfirmed'); summary.degraded++; }
    });
    await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
      while (next < records.length) { const record = records[next++]!; await restore(record.id); }
    }));
    return summary;
  }
  private credentialRecord(credential: string): ScheduleRecord {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(credential)) throw new Error('Invalid schedule credential');
    const record = this.options.core.store.list<ScheduleRecord>(namespace).find(item => equalCredential(item.credential, credential));
    if (!record || !record.nativeJobId) throw new Error('Unknown schedule binding');
    this.options.core.validateScope(record.binding); return record;
  }
  admit(credential: string, input: unknown): { ok: true; tool_context: string } {
    const data = object(input), job = text(data.job_id), execution = executionId(data.execution_id);
    if (data.task_id !== `cron:${job}:${execution}` || Object.keys(data).some(key => !['job_id','execution_id','task_id'].includes(key))) throw new Error('Misbound cron admission');
    return this.options.core.store.transaction(() => {
      const record = this.credentialRecord(credential);
      if (record.nativeJobId !== job || record.state !== 'active' || record.pendingControl || record.nativeBinding?.state === 'unknown') throw new Error('Cron schedule is inactive or misbound');
      const old = record.executions[execution];
      if (old?.manifest) throw new Error('Cron execution already completed');
      // Resume never resurrects a revoked execution token. A paused in-flight
      // invocation stays denied; native cron may only admit a fresh execution.
      if (old) {
        if (old.revoked) throw new Error('Cron execution authority was revoked');
        this.options.core.resolveToolContext(old.token);
        return { ok: true, tool_context: old.token };
      }
      const context = { ...record.binding, runId: `cron:${job}:${execution}` };
      const preparation = this.options.prepareExecution?.(Object.freeze(context)) as unknown;
      if (preparation && (typeof preparation === 'object' || typeof preparation === 'function') && typeof (preparation as { then?: unknown }).then === 'function') throw new Error('Cron context preparation must be synchronous');
      const token = this.options.core.issueToolContext(context);
      record.executions[execution] = { token, runId: context.runId, admittedAt: new Date().toISOString() };
      this.options.core.store.put(namespace, record.id, record); return { ok: true, tool_context: token };
    });
  }
  async complete(credential: string, input: unknown): Promise<ScheduleCompletion> {
    const body = object(input), job = text(body.job_id), execution = executionId(body.execution_id);
    return this.serial(`completion:${job}:${execution}`, async () => {
      const record = this.credentialRecord(credential), entry = record.executions[execution];
      if (record.nativeJobId !== job || !entry) throw new Error('Cron result has no matching admission');
      const response = await this.request(`/cron/results/${encodeURIComponent(job)}/${encodeURIComponent(execution)}`);
      const manifest = object(response.manifest ?? response.result ?? response) as unknown as ScheduleManifest;
      const native = { ...manifest } as Record<string, unknown>; delete native.ok;
      if (native.job_id !== job || native.execution_id !== execution || native.task_id !== `cron:${job}:${execution}` || !['completed','failed','cancelled','interrupted','unknown'].includes(String(native.outcome)) ||
          !((native.output_file === null && native.output_sha256 === null) || (typeof native.output_file === 'string' && /^[a-f0-9]{64}$/u.test(String(native.output_sha256)))) || digest(native) !== digest(body)) throw new Error('Cron completion differs from exact native manifest');
      this.options.core.validateScope(record.binding);
      const replayed = this.options.core.store.transaction(() => {
        const latest = this.credentialRecord(credential), admitted = latest.executions[execution];
        if (!admitted || admitted.runId !== entry.runId) throw new Error('Cron admission changed');
        if (admitted.manifest) { if (digest(admitted.manifest) !== digest(body)) throw new Error('Cron terminal result changed'); return true; }
        admitted.manifest = structuredClone(body) as ScheduleManifest;
        if (body.outcome !== 'unknown' && !admitted.revoked && latest.state === 'active' && !latest.pendingControl && this.options.onComplete) {
          this.options.core.resolveToolContext(admitted.token);
          admitted.callbackState = 'pending';
        } else {
          this.options.core.revokeToolContext(admitted.token); admitted.revoked = true;
        }
        this.options.core.store.put(namespace, latest.id, latest); return false;
      });
      // A callback failure is not replayed automatically: result is already saved,
      // and potentially effectful callbacks must own their durable effect ledger.
      if (!replayed && this.options.onComplete && this.options.core.store.get<ScheduleRecord>(namespace, record.id)!.executions[execution]!.callbackState === 'pending') {
        let state: 'verified' | 'unknown' = 'verified';
        try {
          const latest = this.credentialRecord(credential), current = latest.executions[execution]!;
          if (current.revoked || latest.state !== 'active' || latest.pendingControl || latest.nativeBinding?.state === 'unknown') throw new Error('Schedule callback authority changed');
          this.options.core.resolveToolContext(current.token);
          await this.options.onComplete({ ...record.binding, runId: entry.runId }, structuredClone(body) as ScheduleManifest, entry.token);
        } catch { state = 'unknown'; }
        this.options.core.store.transaction(() => {
          const latest = this.options.core.store.get<ScheduleRecord>(namespace, record.id)!, current = latest.executions[execution]!;
          current.callbackState = state; this.options.core.revokeToolContext(current.token); current.revoked = true;
          this.options.core.store.put(namespace, latest.id, latest);
        });
      } else if (replayed) {
        // A process crash after pending callback admission is indeterminate.
        // Preserve that disposition and withdraw its token rather than resend.
        this.options.core.store.transaction(() => { const latest = this.options.core.store.get<ScheduleRecord>(namespace, record.id)!, current = latest.executions[execution]!;
          if (current.callbackState === 'pending') current.callbackState = 'unknown';
          this.options.core.revokeToolContext(current.token); current.revoked = true; this.options.core.store.put(namespace, latest.id, latest); });
      }
      const callback = this.options.core.store.get<ScheduleRecord>(namespace, record.id)!.executions[execution]!.callbackState;
      return { ok: true, replayed, ...(callback ? { callback, ...(callback !== 'verified' ? { reconciliation_required: true as const } : {}) } : {}) };
    });
  }
  /** Compose this before tool-token resolution. Schedule credentials cannot call tools. */
  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!['/schedules/admit','/schedules/complete'].includes(request.url ?? '')) return false;
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.method !== 'POST' || request.headers.origin !== undefined || request.headers['access-control-request-method'] !== undefined) { send(403, { ok: false, error: 'request denied' }); return true; }
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ') || !(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { send(401, { ok: false, error: 'schedule credential required' }); return true; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const raw of request) { const chunk = Buffer.from(raw); size += chunk.length; if (size > 65536) throw new Error('Body too large'); chunks.push(chunk); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      send(200, request.url === '/schedules/admit' ? this.admit(auth.slice(7), body) : await this.complete(auth.slice(7), body));
    } catch { send(403, { ok: false, error: 'schedule request rejected' }); }
    return true;
  }
}
export async function createScheduleServer(coordinator: HermesScheduleCoordinator, port = 0): Promise<{ address: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    const address = server.address();
    if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) { response.writeHead(403); response.end(); return; }
    if (!await coordinator.handleRequest(request, response)) { response.writeHead(404); response.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Cron broker server missing address');
  return { address: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
export function createScheduleTools(coordinator: HermesScheduleCoordinator): RegisteredTool[] {
  const resources = (_args: Record<string, Json>, context: ToolContext) => [context.taskId];
  return [
    { name: 'schedules.create', description: 'Create a native Hermes cron job with immutable current task/grant scope. Every new execution prepares current owner preferences/source context before its token is issued and starts by reading context.current; failures stop admission. Same key safely reconciles uncertain creation; results remain local.', capability: 'schedules.create', mutates: true, inputSchema: obj({ key: id, name: str(255), schedule: str(1024), instruction: str(32768) }), resources,
      async execute({ context, args }) { return json(await coordinator.create(context, args as unknown as ScheduleSpec)); } },
    { name: 'schedules.list', description: 'List schedules and their separately tracked recurring execution outcomes for the current task.', capability: 'schedules.list', mutates: false, inputSchema: obj({}), resources,
      async execute({ context }) { return json(coordinator.list(context)); } },
    { name: 'schedules.inspect', description: 'Inspect exact task-bound native cron job status and recorded result manifests.', capability: 'schedules.inspect', mutates: false, inputSchema: obj({ id }), resources,
      async execute({ context, args }) { return json(await coordinator.inspect(context, args.id as string)); } },
    ...(['pause','resume','cancel'] as const).map(action => ({ name: `schedules.${action}`, description: `${action} the current task-bound native cron schedule.`, capability: `schedules.${action}`, mutates: true, inputSchema: obj({ id }), resources,
      async execute({ context, args }: { context: ToolContext; args: Record<string, Json> }) { return json(await coordinator.control(context, args.id as string, action)); } })),
  ];
}
