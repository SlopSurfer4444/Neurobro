import { createHash } from 'node:crypto';
import { systemClock, type Clock, type ToolContext } from '../contracts.ts';

/** These services are invoked by a trusted host. They never start timers or send alerts. */
export type TaskBinding = Omit<ToolContext, 'runId'>;
/** Shared by the service and its model-visible tool schemas. Limits apply per source. */
export const JOB_LIMITS = {
  pageSize: { default: 50, max: 100 }, maxPages: { default: 4, max: 16 },
  maxAlerts: { default: 100, max: 1600 }, maxTrackedItems: { default: 4096, max: 10_000 },
} as const;
export interface JobSource { id: string; kind: 'telegram' | 'web'; resource: string }
export interface JobFilter { include?: string[]; exclude?: string[] }
export interface JobSpec {
  id?: string; name: string; sources: JobSource[]; filter?: JobFilter;
  pageSize?: number; maxPages?: number; maxAlerts?: number; maxTrackedItems?: number;
}
export interface SourceChange {
  itemId: string; kind: 'message' | 'edit' | 'delete'; version: string;
  observedAt: string; title?: string; text?: string;
}
export interface SourcePage {
  sourceId: string; changes: SourceChange[]; cursor?: string; hasMore: boolean;
  unavailable?: boolean;
}
/** Implementations must honor the exact source resource and the requested page bound. */
export interface MonitorSource {
  /** Stable task/job identity separates start-now bootstrap checkpoints for
   * independent jobs that watch the same source. Successor cursors stay opaque. */
  read(source: JobSource, cursor: string | undefined, limit: number, checkpoint?: string): Promise<SourcePage>;
}
export interface MonitorAlert {
  id: string; jobId: string; filterRevision: number; sourceId: string; resource: string;
  itemId: string; kind: SourceChange['kind'] | 'source-lost' | 'source-restored';
  title: string; text: string; observedAt: string; rank: number;
  provenance: 'untrusted-source';
  excerpts: { title: ExcerptMetadata; text: ExcerptMetadata };
}
export interface ExcerptMetadata {
  unit: 'utf16-code-units'; limit: number; originalLength: number; returnedLength: number;
  omittedLength: number; truncated: boolean;
}
export interface CapacityBlock {
  requiredTrackedItems: number; reason: 'tracking-capacity-reached'; cursorPreserved: true;
}
export interface TrackedItem { version: string; fingerprint: string; matched: boolean; deleted: boolean }
export interface SourceState {
  cursor?: string; status: 'ready' | 'catchup' | 'lost' | 'capacity'; lossEpisode: number;
  /** A replacement/re-added source needs a fresh bootstrap, while bounds-only
   * revisions keep its unconsumed immutable page and existing cursor. */
  bootstrapRevision?: number;
  items: Record<string, TrackedItem>; seen: Record<string, string>;
  capacity?: CapacityBlock;
}
export interface JobRecord {
  id: string; binding: TaskBinding; name: string; sources: JobSource[];
  filter: Required<JobFilter>; revision: number; version: number;
  state: 'active' | 'cancelled'; createdAt: string; updatedAt: string;
  limits: { pageSize: number; maxPages: number; maxAlerts: number; maxTrackedItems: number };
  sourceStates: Record<string, SourceState>; nextSourceIndex: number;
  /** Bounded recent evidence, for host inspection after a lost poll response. No delivery claims. */
  alertLog: MonitorAlert[];
}
export interface JobStore {
  load(taskId: string, id: string): Promise<JobRecord | undefined>;
  list(taskId: string, limit: number): Promise<JobRecord[]>;
  /** Atomic compare-and-swap; undefined means insert only. Persist the entire record together. */
  save(record: JobRecord, expectedVersion: number | undefined): Promise<boolean>;
}
export interface JobServiceOptions {
  store: JobStore; source?: MonitorSource; clock?: Clock;
  /** Host revalidates current task/grant authority, including every source resource. */
  validateContext?: (context: ToolContext, sources: readonly JobSource[]) => Promise<void>;
}
export interface SourceProgress {
  sourceId: string; resource: string; status: SourceState['status']; cursor?: string;
  trackedItems: number; trackedVersions: number; maxTrackedItems: number; capacityRemaining: number;
  reason?: 'tracking-capacity-reached' | 'source-unavailable' | 'catchup-needed';
  recovery?: { action: 'jobs.revise' | 'new-scoped-monitor-required'; requiredTrackedItems: number;
    maxAllowed: number; cursorPreserved: true; detail: string };
}
export interface PollResult {
  job: JobRecord; alerts: MonitorAlert[]; pagesRead: number; catchup: boolean; sourceProgress: SourceProgress[];
}

const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (value: string): string => digest(value);
function string(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b-\u001f]/u.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
function bounded(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('Invalid bound');
  return n;
}
function binding(context: ToolContext): TaskBinding {
  string(context.taskId, 'taskId'); string(context.grantId, 'grantId'); string(context.runId, 'runId');
  for (const n of [context.intentRevision, context.grantRevision])
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid context revision');
  return { taskId: context.taskId, intentRevision: context.intentRevision, grantId: context.grantId, grantRevision: context.grantRevision };
}
function sameBinding(a: TaskBinding, b: TaskBinding): boolean {
  return a.taskId === b.taskId && a.intentRevision === b.intentRevision && a.grantId === b.grantId && a.grantRevision === b.grantRevision;
}
function sources(input: JobSource[]): JobSource[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) throw new Error('Invalid source set');
  const result = input.map(s => {
    if (!s || (s.kind !== 'web' && s.kind !== 'telegram')) throw new Error('Invalid source kind');
    return { id: string(s.id, 'source id'), kind: s.kind, resource: string(s.resource, 'source resource', 2048) };
  });
  if (new Set(result.map(s => s.id)).size !== result.length || new Set(result.map(s => `${s.kind}:${s.resource}`)).size !== result.length)
    throw new Error('Duplicate source');
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
function terms(input: string[] | undefined): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 32) throw new Error('Invalid filter terms');
  return [...new Set(input.map(t => string(t, 'filter term', 128).trim().toLocaleLowerCase('en')))].sort();
}
function filter(input: JobFilter | undefined): Required<JobFilter> {
  return { include: terms(input?.include), exclude: terms(input?.exclude) };
}
function matches(f: Required<JobFilter>, title: string, text: string): boolean {
  const haystack = `${title}\n${text}`.toLocaleLowerCase('en');
  return (!f.include.length || f.include.some(t => haystack.includes(t))) && !f.exclude.some(t => haystack.includes(t));
}
function rank(f: Required<JobFilter>, title: string, text: string): number {
  const t = title.toLocaleLowerCase('en'), body = text.toLocaleLowerCase('en');
  return f.include.reduce((n, term) => n + (t.includes(term) ? 2 : 0) + (body.includes(term) ? 1 : 0), 0);
}
function excerpt(value: string, limit: number): { value: string; metadata: ExcerptMetadata } {
  let end = Math.min(value.length, limit);
  // Keep Unicode surrogate pairs intact while reporting exact JS-string length accounting.
  if (end < value.length && end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]!) && /[\uDC00-\uDFFF]/u.test(value[end]!)) end--;
  return { value: value.slice(0, end), metadata: { unit: 'utf16-code-units', limit,
    originalLength: value.length, returnedLength: end, omittedLength: value.length - end, truncated: end < value.length } };
}
function alert(job: JobRecord, source: JobSource, itemId: string, kind: MonitorAlert['kind'], version: string,
  observedAt: string, title: string, text: string,
  excerpts = { title: excerpt(title, 512).metadata, text: excerpt(text, 16_384).metadata }, score = rank(job.filter, title, text)): MonitorAlert {
  return { id: digest([job.binding, job.id, job.revision, source.id, source.resource, itemId, kind, version]), jobId: job.id,
    filterRevision: job.revision, sourceId: source.id, resource: source.resource, itemId, kind, title, text,
    observedAt, rank: score, provenance: 'untrusted-source', excerpts };
}
function sortAlerts(alerts: MonitorAlert[]): MonitorAlert[] {
  return alerts.sort((a, b) => b.rank - a.rank || b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
}
/** Bounded model-visible progress; retention evidence is counted separately from cursor progress. */
export function monitorProgress(job: JobRecord): SourceProgress[] {
  return job.sources.map(source => {
    const state = job.sourceStates[key(source.id)]!;
    const trackedItems = Object.keys(state.items).length, trackedVersions = Object.keys(state.seen).length;
    const progress: SourceProgress = { sourceId: source.id, resource: source.resource, status: state.status,
      ...(state.cursor === undefined ? {} : { cursor: state.cursor }), trackedItems, trackedVersions,
      maxTrackedItems: job.limits.maxTrackedItems,
      capacityRemaining: Math.max(0, job.limits.maxTrackedItems - Math.max(trackedItems, trackedVersions)) };
    if (state.status === 'capacity') {
      const requiredTrackedItems = state.capacity?.requiredTrackedItems ?? Math.max(trackedItems, trackedVersions) + 1;
      progress.reason = 'tracking-capacity-reached';
      progress.recovery = { action: requiredTrackedItems <= JOB_LIMITS.maxTrackedItems.max ? 'jobs.revise' : 'new-scoped-monitor-required',
        requiredTrackedItems, maxAllowed: JOB_LIMITS.maxTrackedItems.max, cursorPreserved: true,
        detail: requiredTrackedItems <= JOB_LIMITS.maxTrackedItems.max
          ? 'Raise maxTrackedItems with jobs.revise and the current expectedRevision, then collect the same unconsumed page. Existing dedupe evidence is retained.'
          : 'The bounded retention ceiling cannot hold this page. Keep this checkpoint; a host must choose a new scoped monitor. No automatic evidence eviction or cursor reset is performed.' };
    } else if (state.status === 'lost') progress.reason = 'source-unavailable';
    else if (state.status === 'catchup') progress.reason = 'catchup-needed';
    return progress;
  });
}

/** Pure reducer. Source metadata never supplies authority, filtering, ranking, or routing. */
export function collectMonitor(job: JobRecord, source: JobSource, page: SourcePage, now: string):
  { sourceState: SourceState; alerts: MonitorAlert[] } {
  const configured = job.sources.find(s => s.id === source.id && s.resource === source.resource && s.kind === source.kind);
  const old = job.sourceStates[key(source.id)];
  if (!configured || !old || page.sourceId !== source.id) throw new Error('Source binding mismatch');
  if (!Array.isArray(page.changes) || page.changes.length > job.limits.pageSize || typeof page.hasMore !== 'boolean')
    throw new Error('Invalid source page');
  if (page.unavailable !== undefined && typeof page.unavailable !== 'boolean') throw new Error('Invalid source availability');
  if (page.cursor !== undefined) string(page.cursor, 'cursor', 4096);
  if (page.hasMore && (!page.cursor || page.cursor === old.cursor)) throw new Error('Source cursor did not advance');
  const next = clone(old), alerts: MonitorAlert[] = [];
  if (page.unavailable === true) {
    if (page.changes.length || page.hasMore || page.cursor !== undefined) throw new Error('Unavailable source has data');
    if (old.status !== 'lost') {
      next.lossEpisode++;
      alerts.push(alert(job, source, '', 'source-lost', String(next.lossEpisode), now, 'Source unavailable', ''));
    }
    next.status = 'lost';
    delete next.capacity;
    return { sourceState: next, alerts };
  }
  if (old.status === 'lost') alerts.push(alert(job, source, '', 'source-restored', String(old.lossEpisode), now, 'Source restored', ''));
  const changes = page.changes.map(raw => {
    if (!raw || !['message', 'edit', 'delete'].includes(raw.kind)) throw new Error('Invalid source change');
    const itemId = string(raw.itemId, 'item id'), version = string(raw.version, 'item version');
    if (typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt))) throw new Error('Invalid observation time');
    const observedAt = new Date(raw.observedAt).toISOString();
    if ((raw.title !== undefined && typeof raw.title !== 'string') || (raw.text !== undefined && typeof raw.text !== 'string'))
      throw new Error('Invalid source text');
    const title = excerpt(raw.title ?? '', 512), text = excerpt(raw.text ?? '', 16_384);
    // Fingerprint the complete admitted source value, including material omitted from the excerpt.
    return { kind: raw.kind, itemId, version, observedAt, title: title.value, text: text.value,
      excerpts: { title: title.metadata, text: text.metadata }, fingerprint: digest([raw.kind, raw.title ?? '', raw.text ?? '']),
      itemKey: key(itemId), eventKey: digest([itemId, version]),
      matched: matches(job.filter, raw.title ?? '', raw.text ?? ''), score: rank(job.filter, raw.title ?? '', raw.text ?? '') };
  });
  const requiredTrackedItems = Math.max(new Set([...Object.keys(old.items), ...changes.map(change => change.itemKey)]).size,
    new Set([...Object.keys(old.seen), ...changes.map(change => change.eventKey)]).size);
  let itemCount = Object.keys(next.items).length, eventCount = Object.keys(next.seen).length;
  for (const raw of changes) {
    const { itemId, version, observedAt, title, text, fingerprint, itemKey, eventKey } = raw;
    const previous = next.items[itemKey];
    if (next.seen[eventKey] !== undefined) {
      if (next.seen[eventKey] !== fingerprint) throw new Error('Conflicting source version');
      continue;
    }
    if ((!previous && itemCount >= job.limits.maxTrackedItems) || eventCount >= job.limits.maxTrackedItems) {
      // Do not advance a partially consumed page or evict dedupe evidence silently.
      return { sourceState: { ...clone(old), status: 'capacity', capacity: {
        requiredTrackedItems, reason: 'tracking-capacity-reached', cursorPreserved: true } }, alerts: [] };
    }
    if (!previous) itemCount++;
    eventCount++;
    next.seen[eventKey] = fingerprint;
    // An old edit arriving after a tombstone cannot resurrect a stable source item identity.
    // A source that supports restoration must supply a fresh itemId for its new incarnation.
    if (previous?.deleted && raw.kind !== 'delete') continue;
    const isMatch = raw.kind === 'delete' ? previous?.matched === true : raw.matched;
    next.items[itemKey] = { version, fingerprint, matched: raw.kind !== 'delete' && isMatch, deleted: raw.kind === 'delete' };
    if (isMatch || (raw.kind === 'edit' && previous?.matched)) {
      alerts.push(alert(job, source, itemId, raw.kind, version, observedAt, title, text, raw.excerpts, raw.score));
    }
  }
  if (page.cursor !== undefined) next.cursor = page.cursor;
  next.status = page.hasMore ? 'catchup' : 'ready';
  delete next.capacity;
  return { sourceState: next, alerts: sortAlerts(alerts) };
}

export class JobService {
  readonly #options: JobServiceOptions;
  constructor(options: JobServiceOptions) { this.#options = options; }
  #now(): string { return (this.#options.clock ?? systemClock).now().toISOString(); }
  async #authorize(context: ToolContext, sourceSet: JobSource[]): Promise<void> {
    binding(context); await this.#options.validateContext?.(context, clone(sourceSet));
  }
  async #load(context: ToolContext, id: string, revision?: number, allowRebind = false): Promise<JobRecord> {
    string(id, 'job id'); const b = binding(context);
    const job = await this.#options.store.load(b.taskId, id);
    if (!job || job.binding.taskId !== b.taskId || job.id !== id) throw new Error('Job not found');
    if (!sameBinding(job.binding, b) && !(allowRebind && this.#options.validateContext &&
      b.intentRevision >= job.binding.intentRevision &&
      (b.grantId !== job.binding.grantId || b.grantRevision >= job.binding.grantRevision))) throw new Error('Stale job context');
    if (revision !== undefined && revision !== job.revision) throw new Error('Job revision conflict');
    await this.#authorize(context, job.sources);
    return clone(job);
  }
  async create(context: ToolContext, spec: JobSpec): Promise<JobRecord> {
    const b = binding(context), sourceSet = sources(spec.sources), f = filter(spec.filter);
    const name = string(spec.name, 'job name', 256);
    const limits = { pageSize: bounded(spec.pageSize, JOB_LIMITS.pageSize.default, JOB_LIMITS.pageSize.max),
      maxPages: bounded(spec.maxPages, JOB_LIMITS.maxPages.default, JOB_LIMITS.maxPages.max),
      maxAlerts: bounded(spec.maxAlerts, JOB_LIMITS.maxAlerts.default, JOB_LIMITS.maxAlerts.max),
      maxTrackedItems: bounded(spec.maxTrackedItems, JOB_LIMITS.maxTrackedItems.default, JOB_LIMITS.maxTrackedItems.max) };
    const id = spec.id === undefined ? digest([b, context.runId, name, sourceSet, f, limits]) : string(spec.id, 'job id');
    await this.#authorize(context, sourceSet);
    const existing = await this.#options.store.load(b.taskId, id);
    if (existing) {
      if (existing.state !== 'active' || !sameBinding(existing.binding, b) ||
        digest([existing.name, existing.sources, existing.filter, existing.limits]) !== digest([name, sourceSet, f, limits]))
        throw new Error('Job identity conflict');
      return clone(existing);
    }
    const now = this.#now();
    const record: JobRecord = { id, binding: b, name, sources: sourceSet, filter: f, revision: 1, version: 1,
      state: 'active', createdAt: now, updatedAt: now, limits, nextSourceIndex: 0, alertLog: [],
      sourceStates: Object.fromEntries(sourceSet.map(s => [key(s.id), { status: 'ready', lossEpisode: 0, items: {}, seen: {} }])) };
    if (!await this.#options.store.save(clone(record), undefined)) throw new Error('Job storage conflict');
    return clone(record);
  }
  inspect(context: ToolContext, id: string): Promise<JobRecord> { return this.#load(context, id); }
  async list(context: ToolContext, limit = 50): Promise<JobRecord[]> {
    bounded(limit, 50, 100); const b = binding(context); await this.#authorize(context, []);
    const records = await this.#options.store.list(b.taskId, limit);
    if (records.length > limit) throw new Error('Job store exceeded list bound');
    const result = records.filter(r => sameBinding(r.binding, b));
    for (const record of result) await this.#authorize(context, record.sources);
    return clone(result);
  }
  async update(context: ToolContext, id: string, expectedRevision: number, patch: Partial<Omit<JobSpec, 'id'>>): Promise<JobRecord> {
    const job = await this.#load(context, id, expectedRevision, true);
    if (job.state !== 'active') throw new Error('Job cancelled');
    const nextSources = patch.sources === undefined ? job.sources : sources(patch.sources);
    await this.#authorize(context, nextSources);
    const next = clone(job);
    next.binding = binding(context); next.revision++; next.version++; next.updatedAt = this.#now();
    next.name = patch.name === undefined ? job.name : string(patch.name, 'job name');
    next.sources = nextSources; next.filter = patch.filter === undefined ? job.filter : filter(patch.filter);
    next.limits = { pageSize: bounded(patch.pageSize ?? job.limits.pageSize, JOB_LIMITS.pageSize.default, JOB_LIMITS.pageSize.max),
      maxPages: bounded(patch.maxPages ?? job.limits.maxPages, JOB_LIMITS.maxPages.default, JOB_LIMITS.maxPages.max),
      maxAlerts: bounded(patch.maxAlerts ?? job.limits.maxAlerts, JOB_LIMITS.maxAlerts.default, JOB_LIMITS.maxAlerts.max),
      maxTrackedItems: bounded(patch.maxTrackedItems ?? job.limits.maxTrackedItems, JOB_LIMITS.maxTrackedItems.default, JOB_LIMITS.maxTrackedItems.max) };
    next.sourceStates = Object.fromEntries(nextSources.map(s => {
      const previousSource = job.sources.find(old => old.id === s.id && old.kind === s.kind && old.resource === s.resource);
      const oldState = previousSource && job.sourceStates[key(s.id)];
      // Filter changes apply to future observations; retained tombstones/cursors prevent historical replay.
      const state: SourceState = oldState ?? { status: 'ready', lossEpisode: 0, bootstrapRevision: next.revision, items: {}, seen: {} };
      if (Math.max(Object.keys(state.items).length, Object.keys(state.seen).length) > next.limits.maxTrackedItems)
        throw new Error('Cannot lower maxTrackedItems below retained dedupe evidence');
      if (state.status === 'capacity' && state.capacity && state.capacity.requiredTrackedItems <= next.limits.maxTrackedItems) {
        state.status = 'catchup'; delete state.capacity;
      }
      return [key(s.id), state];
    }));
    next.nextSourceIndex = 0;
    await this.#authorize(context, nextSources);
    if (!await this.#options.store.save(clone(next), job.version)) throw new Error('Job storage conflict');
    return clone(next);
  }
  async cancel(context: ToolContext, id: string, expectedRevision: number): Promise<JobRecord> {
    const job = await this.#load(context, id, expectedRevision, true);
    if (job.state === 'cancelled') return job;
    const next = { ...job, binding: binding(context), state: 'cancelled' as const, revision: job.revision + 1,
      version: job.version + 1, updatedAt: this.#now() };
    await this.#authorize(context, next.sources);
    if (!await this.#options.store.save(clone(next), job.version)) throw new Error('Job storage conflict');
    return clone(next);
  }
  async poll(context: ToolContext, id: string, expectedRevision: number): Promise<PollResult> {
    const job = await this.#load(context, id, expectedRevision);
    if (job.state !== 'active') throw new Error('Job cancelled');
    if (!this.#options.source) throw new Error('Monitor source unavailable');
    const next = clone(job), alerts: MonitorAlert[] = [];
    let pagesRead = 0;
    const queue = next.sources.map((_, i) => next.sources[(next.nextSourceIndex + i) % next.sources.length]!);
    while (queue.length && pagesRead < next.limits.maxPages && alerts.length < next.limits.maxAlerts) {
        const s = queue.shift()!;
        await this.#authorize(context, [s]);
        const current = await this.#options.store.load(context.taskId, id);
        if (current?.version !== job.version || current.state !== 'active') throw new Error('Job changed during poll');
        const previous = next.sourceStates[key(s.id)]!;
        const remaining = next.limits.maxAlerts - alerts.length;
        const limit = Math.min(next.limits.pageSize, Math.max(1, remaining - (previous.status === 'lost' ? 1 : 0)));
        const checkpoint = previous.bootstrapRevision === undefined ? digest([context.taskId, id]) : digest([context.taskId, id, previous.bootstrapRevision]);
        const page = await this.#options.source.read(clone(s), previous.cursor, limit, checkpoint);
        if (!Array.isArray(page.changes) || page.changes.length > limit) throw new Error('Source exceeded requested page bound');
        pagesRead++;
        next.nextSourceIndex = (next.sources.findIndex(source => source.id === s.id) + 1) % next.sources.length;
        const collected = collectMonitor(next, s, page, this.#now());
        // Stop before consuming more alerts than the host can admit; retain the page cursor for catchup.
        if (alerts.length + collected.alerts.length > next.limits.maxAlerts) {
          // With a one-alert budget, acknowledge restoration first and retain the data cursor.
          const restoration = collected.alerts.find(a => a.kind === 'source-restored');
          if (restoration && remaining >= 1) {
            alerts.push(restoration);
            next.sourceStates[key(s.id)]!.status = 'catchup';
          } else next.sourceStates[key(s.id)]!.status = 'catchup';
          break;
        }
        next.sourceStates[key(s.id)] = collected.sourceState; alerts.push(...collected.alerts);
        if (collected.sourceState.status === 'catchup') queue.push(s);
    }
    await this.#authorize(context, next.sources);
    next.alertLog = [...next.alertLog, ...sortAlerts(alerts)].slice(-next.limits.maxAlerts);
    next.version++; next.updatedAt = this.#now();
    if (!await this.#options.store.save(clone(next), job.version)) throw new Error('Job changed during poll');
    return { job: clone(next), alerts: sortAlerts(alerts), pagesRead,
      catchup: Object.values(next.sourceStates).some(s => s.status === 'catchup' || s.status === 'capacity') || queue.length > 0,
      sourceProgress: monitorProgress(next) };
  }
}

/** Reference test store; production hosts must inject a durable atomic implementation. */
export class InMemoryJobStore implements JobStore {
  readonly #records = new Map<string, JobRecord>();
  async load(taskId: string, id: string): Promise<JobRecord | undefined> { return clone(this.#records.get(digest([taskId, id]))); }
  async list(taskId: string, limit: number): Promise<JobRecord[]> {
    return clone([...this.#records.values()].filter(r => r.binding.taskId === taskId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit));
  }
  async save(record: JobRecord, expectedVersion: number | undefined): Promise<boolean> {
    const k = digest([record.binding.taskId, record.id]), current = this.#records.get(k);
    if (current?.version !== expectedVersion) return false;
    this.#records.set(k, clone(record)); return true;
  }
}

export interface TaskMemoryRecord {
  id: string; binding: TaskBinding; text: string; sourceRef: string; revision: number;
  createdAt: string; updatedAt: string; removedAt?: string;
}
export interface TaskMemoryStore {
  load(taskId: string, id: string): Promise<TaskMemoryRecord | undefined>;
  list(taskId: string, limit: number): Promise<TaskMemoryRecord[]>;
  save(record: TaskMemoryRecord, expectedRevision: number | undefined): Promise<boolean>;
}
export interface TaskMemoryServiceOptions {
  store: TaskMemoryStore; clock?: Clock;
  validateContext?: (context: ToolContext) => Promise<void>;
}
export class TaskMemoryService {
  readonly #options: TaskMemoryServiceOptions;
  constructor(options: TaskMemoryServiceOptions) { this.#options = options; }
  async #authorize(context: ToolContext): Promise<TaskBinding> {
    const b = binding(context); await this.#options.validateContext?.(context); return b;
  }
  async get(context: ToolContext, id: string): Promise<TaskMemoryRecord | undefined> {
    const b = await this.#authorize(context); string(id, 'memory id');
    const record = await this.#options.store.load(b.taskId, id);
    if (record && (!sameBinding(record.binding, b) || record.id !== id)) throw new Error('Stale memory context');
    return record?.removedAt ? undefined : clone(record);
  }
  async list(context: ToolContext, limit = 50): Promise<TaskMemoryRecord[]> {
    bounded(limit, 50, 100); const b = await this.#authorize(context);
    const records = await this.#options.store.list(b.taskId, limit);
    if (records.length > limit) throw new Error('Memory store exceeded list bound');
    return clone(records.filter(r => sameBinding(r.binding, b) && !r.removedAt));
  }
  async put(context: ToolContext, input: { id: string; text: string; sourceRef: string; expectedRevision?: number }): Promise<TaskMemoryRecord> {
    const b = await this.#authorize(context), id = string(input.id, 'memory id');
    const text = string(input.text, 'memory text', 16_384), sourceRef = string(input.sourceRef, 'memory provenance', 2048);
    const old = await this.#options.store.load(b.taskId, id);
    if (old && (!sameBinding(old.binding, b) || old.id !== id)) throw new Error('Stale memory context');
    if (old?.removedAt) throw new Error('Memory removed');
    if (old && sourceRef !== old.sourceRef) throw new Error('Memory provenance is immutable');
    if (old && input.expectedRevision === undefined && old.text === text) return clone(old);
    if (old?.revision !== input.expectedRevision) throw new Error('Memory revision conflict');
    const now = (this.#options.clock ?? systemClock).now().toISOString();
    const record: TaskMemoryRecord = { id, binding: b, text, sourceRef, revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? now, updatedAt: now };
    await this.#authorize(context);
    if (!await this.#options.store.save(clone(record), old?.revision)) throw new Error('Memory storage conflict');
    return clone(record);
  }
  async remove(context: ToolContext, id: string, expectedRevision: number): Promise<void> {
    const old = await this.get(context, id);
    if (!old) return;
    if (old.revision !== expectedRevision) throw new Error('Memory revision conflict');
    const now = (this.#options.clock ?? systemClock).now().toISOString();
    await this.#authorize(context);
    if (!await this.#options.store.save({ ...old, revision: old.revision + 1, updatedAt: now, removedAt: now }, old.revision))
      throw new Error('Memory storage conflict');
  }
}
export class InMemoryTaskMemoryStore implements TaskMemoryStore {
  readonly #records = new Map<string, TaskMemoryRecord>();
  async load(taskId: string, id: string): Promise<TaskMemoryRecord | undefined> { return clone(this.#records.get(digest([taskId, id]))); }
  async list(taskId: string, limit: number): Promise<TaskMemoryRecord[]> {
    return clone([...this.#records.values()].filter(r => r.binding.taskId === taskId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit));
  }
  async save(record: TaskMemoryRecord, expectedRevision: number | undefined): Promise<boolean> {
    const k = digest([record.binding.taskId, record.id]), old = this.#records.get(k);
    if (old?.revision !== expectedRevision) return false;
    this.#records.set(k, clone(record)); return true;
  }
}
