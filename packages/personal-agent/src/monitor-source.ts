import { createHash, randomUUID } from 'node:crypto';
import type { Observation, TelegramPort } from './contracts.ts';
import type { PersonalStore } from './core/store.ts';
import type { JobSource, MonitorSource, SourceChange, SourcePage } from './capabilities/jobs.ts';
import { validatePublicUrl } from './capabilities/web.ts';

export interface MonitorSourceOptions {
  store: PersonalStore; telegram: Pick<TelegramPort, 'readHistory'>; accountId: string;
  /** A trusted closure around WebService.fetch with a freshly authorized broker context. No raw fetch fallback. */
  web?: { fetch(source: JobSource): Promise<{ url: string; status: number; mimeType: string; text: string; size: number }> };
  /** Required in addition to prior registration. Default false; revoked grants stop observation retention. */
  authorizeObservation?: (observation: Observation) => boolean;
  maxJournalEventsPerSource?: number;
}
export interface MonitorCoverage {
  initialHistory: 'bounded-snapshot'; updates: 'authorized-host-journal' | 'head-snapshots-only';
  gap?: string; committedHead: string; scanHead?: string; scanBefore?: string;
  /** JobService owns admission. Its capacity state never acknowledges this source's uncommitted page. */
  admission: 'immutable-page-replay; capacity requires owner intervention';
}
interface Binding { accountId: string; kind: JobSource['kind']; id: string; resource: string }
interface Cursor {
  binding: Binding; phase: 'idle' | 'catchup'; highwater: string; upper?: string; before?: string;
  journalSeq: string; nextLane: 'history' | 'journal'; webVersion?: string; webSequence?: string;
  replay?: { pageKey: string; offset: number };
}
interface SourceRegistration { binding: Binding; journalSeq: string; journalGap?: string }
interface JournalEvent { sourceKey: string; sequence: string; change: SourceChange }
interface PageResult extends SourcePage { coverage: MonitorCoverage }
const SOURCES = 'monitor-source/registrations';
const CURSORS = 'monitor-source/cursors';
const PAGES = 'monitor-source/pages';
const JOURNAL = 'monitor-source/journal';
const DEDUPE = 'monitor-source/journal-dedupe';
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
function decimal(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,39})$/.test(value)) throw new Error('Monitor message/sequence ID must be an exact nonnegative decimal');
  return BigInt(value);
}
function stableChange(observation: Observation): SourceChange {
  const kind = observation.kind === 'message' && observation.editedAt ? 'edit' : observation.kind;
  const text = observation.text ?? '';
  if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) throw new Error('Monitor source text exceeds byte bound');
  const version = hash({ kind, text, sentAt: observation.sentAt, editedAt: observation.editedAt,
    author: observation.authorId, outgoing: observation.outgoing, replyTo: observation.replyTo,
    attachments: observation.attachments?.map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size })) });
  if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error('Monitor observation timestamp invalid');
  return { itemId: observation.ref.messageId, kind, version, observedAt: observation.observedAt, text };
}

/** Immutable encrypted cursor references, fixed-head forward catchup, and explicit partial-history gaps. */
export class DurableMonitorSource implements MonitorSource {
  private readonly options: MonitorSourceOptions;
  constructor(options: MonitorSourceOptions) {
    if (!options.accountId) throw new Error('Monitor account binding required');
    const max = options.maxJournalEventsPerSource ?? 10_000;
    if (!Number.isSafeInteger(max) || max < 1 || max > 100_000) throw new Error('Monitor journal bound invalid');
    this.options = { ...options, maxJournalEventsPerSource: max };
  }
  private binding(source: JobSource): Binding {
    if (!source.id || source.id.length > 256 || !['telegram', 'web'].includes(source.kind) || !source.resource || source.resource.length > 2048) throw new Error('Monitor source identity invalid');
    if (source.kind === 'telegram' && !/^-?[1-9]\d{0,39}$/.test(source.resource)) throw new Error('Monitor Telegram resource must be an exact peer ID');
    if (source.kind === 'web') validatePublicUrl(source.resource);
    return { accountId: this.options.accountId, id: source.id, kind: source.kind, resource: source.resource };
  }
  private load(source: JobSource, reference?: string): Cursor {
    const binding = this.binding(source);
    if (!reference) return { binding, phase: 'idle', highwater: '0', journalSeq: '0', nextLane: 'journal' };
    if (!/^ms1_[0-9a-f-]{36}$/.test(reference)) throw new Error('Monitor cursor is not an opaque store reference');
    const cursor = this.options.store.get<Cursor>(CURSORS, reference);
    if (!cursor || hash(cursor.binding) !== hash(binding)) throw new Error('Monitor cursor resource/account binding mismatch');
    decimal(cursor.highwater); decimal(cursor.journalSeq);
    if (cursor.before) decimal(cursor.before); if (cursor.upper) decimal(cursor.upper);
    if (!['idle', 'catchup'].includes(cursor.phase) || !['history', 'journal'].includes(cursor.nextLane)) throw new Error('Monitor cursor state invalid');
    return clone(cursor);
  }
  private registration(binding: Binding): SourceRegistration {
    const sourceKey = hash(binding);
    const existing = this.options.store.get<SourceRegistration>(SOURCES, sourceKey);
    if (existing) return existing;
    const created = { binding, journalSeq: '0' };
    this.options.store.insert(SOURCES, sourceKey, created);
    return this.options.store.get<SourceRegistration>(SOURCES, sourceKey)!;
  }
  private describe(cursor: Cursor, registration: SourceRegistration): MonitorCoverage {
    return { initialHistory: 'bounded-snapshot', updates: this.options.authorizeObservation ? 'authorized-host-journal' : 'head-snapshots-only',
      committedHead: cursor.highwater, ...(cursor.upper ? { scanHead: cursor.upper } : {}), ...(cursor.before ? { scanBefore: cursor.before } : {}),
      ...(registration.journalGap ? { gap: registration.journalGap } : {}), admission: 'immutable-page-replay; capacity requires owner intervention' };
  }
  coverage(source: JobSource, reference?: string): MonitorCoverage {
    const cursor = this.load(source, reference);
    const registration = this.options.store.get<SourceRegistration>(SOURCES, hash(cursor.binding)) ?? { binding: cursor.binding, journalSeq: '0' };
    return this.describe(cursor, registration);
  }
  /** The host calls this only after intake identity validation. It never registers a new source. */
  async recordObservation(observation: Observation): Promise<void> {
    if (observation.ref.accountId !== this.options.accountId || !this.options.authorizeObservation || !this.options.authorizeObservation(observation)) return;
    if (observation.kind !== 'edit' && observation.kind !== 'delete') return;
    if (!/^[1-9]\d{0,39}$/.test(observation.ref.messageId)) return;
    const change = stableChange(observation);
    this.options.store.transaction(() => {
      for (const registration of this.options.store.list<SourceRegistration>(SOURCES)) {
        if (registration.binding.kind !== 'telegram' || registration.binding.accountId !== observation.ref.accountId || registration.binding.resource !== observation.ref.peerId) continue;
        const sourceKey = hash(registration.binding), dedupe = hash([sourceKey, change.itemId, change.version]);
        if (this.options.store.get(DEDUPE, dedupe)) continue;
        if (decimal(registration.journalSeq) >= BigInt(this.options.maxJournalEventsPerSource!)) {
          registration.journalGap = 'authorized observation journal capacity reached; retention stopped';
          this.options.store.put(SOURCES, sourceKey, registration); continue;
        }
        const sequence = (decimal(registration.journalSeq) + 1n).toString();
        this.options.store.put<JournalEvent>(JOURNAL, `${sourceKey}/${sequence}`, { sourceKey, sequence, change });
        this.options.store.put(DEDUPE, dedupe, true); registration.journalSeq = sequence;
        this.options.store.put(SOURCES, sourceKey, registration);
      }
    });
  }
  private persist(cacheKey: string, cursor: Cursor, changes: SourceChange[], hasMore: boolean, coverage: MonitorCoverage): PageResult {
    return this.options.store.transaction(() => {
      const existing = this.options.store.get<PageResult>(PAGES, cacheKey); if (existing) return existing;
      const reference = `ms1_${randomUUID()}`;
      this.options.store.put(CURSORS, reference, cursor);
      const page: PageResult = { sourceId: cursor.binding.id, cursor: reference, changes, hasMore, coverage };
      this.options.store.put(PAGES, cacheKey, page); return page;
    });
  }
  private bounded(page: PageResult, pageKey: string, cursor: Cursor, registration: SourceRegistration, limit: number): PageResult {
    if (page.changes.length <= limit) return clone(page);
    const partial = clone(cursor); partial.replay = { pageKey, offset: limit };
    return this.persist(hash([pageKey, 'bounded-replay', limit]), partial, page.changes.slice(0, limit), true, this.describe(partial, registration));
  }
  private journal(cacheKey: string, cursor: Cursor, registration: SourceRegistration, limit: number): PageResult {
    const sourceKey = hash(cursor.binding), events: SourceChange[] = []; let sequence = decimal(cursor.journalSeq);
    while (events.length < limit && sequence < decimal(registration.journalSeq)) {
      sequence++;
      const event = this.options.store.get<JournalEvent>(JOURNAL, `${sourceKey}/${sequence}`);
      if (!event || event.sourceKey !== sourceKey) throw new Error('Monitor journal gap requires reconciliation');
      events.push(event.change);
    }
    cursor.journalSeq = sequence.toString(); cursor.nextLane = 'history';
    return this.persist(cacheKey, cursor, events, true, this.describe(cursor, registration));
  }
  async read(source: JobSource, reference: string | undefined, limit: number, checkpoint?: string): Promise<PageResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Monitor page limit must be 1..100');
    if (checkpoint !== undefined && (typeof checkpoint !== 'string' || !checkpoint || checkpoint.length > 256)) throw new Error('Monitor checkpoint identity invalid');
    const cursor = this.load(source, reference); let registration = this.registration(cursor.binding); const sourceKey = hash(cursor.binding);
    // A rejected/capacity page is replayed exactly: read() alone never commits the job watermark.
    // Bootstrap belongs to one job, while opaque successor references carry their own identity.
    // A later subscription to the same source must take a fresh start-now baseline.
    const cacheKey = hash([sourceKey, reference ?? ['bootstrap', checkpoint ?? 'legacy']]);
    const cached = this.options.store.get<PageResult>(PAGES, cacheKey); if (cached) return this.bounded(cached, cacheKey, cursor, registration, limit);
    // Preserve already captured pages from the prior limit-keyed format when a
    // persisted checkpoint is resumed. New job bootstraps must not reuse them.
    if (reference !== undefined) {
      let legacy: PageResult | undefined;
      for (let priorLimit = 1; priorLimit <= 100; priorLimit++) {
        const prior = this.options.store.get<PageResult>(PAGES, hash([sourceKey, reference, priorLimit]));
        if (!prior) continue;
        if (legacy && hash(legacy) !== hash(prior)) throw new Error('Conflicting prior monitor pages require reconciliation');
        legacy = prior;
      }
      if (legacy) { this.options.store.put(PAGES, cacheKey, legacy); return this.bounded(legacy, cacheKey, cursor, registration, limit); }
    }
    if (cursor.replay) {
      const original = this.options.store.get<PageResult>(PAGES, cursor.replay.pageKey), offset = cursor.replay.offset;
      if (!original || original.sourceId !== source.id || !Number.isSafeInteger(offset) || offset < 0 || offset >= original.changes.length) throw new Error('Monitor replay checkpoint invalid');
      const remaining = original.changes.slice(offset);
      if (remaining.length <= limit) {
        const terminal = { ...clone(original), changes: remaining };
        this.options.store.put(PAGES, cacheKey, terminal); return terminal;
      }
      cursor.replay.offset += limit;
      return this.persist(cacheKey, cursor, remaining.slice(0, limit), true, this.describe(cursor, registration));
    }
    if (source.kind === 'web') return this.web(source, cacheKey, cursor, registration);
    const journalPending = decimal(registration.journalSeq) > decimal(cursor.journalSeq);
    const baselineSequence = registration.journalSeq;
    // Finish the bootstrap first. Then drain journal chronology before snapshots:
    // mixing a latest snapshot with older queued edits can permanently regress an item.
    if (reference !== undefined && journalPending) return this.journal(cacheKey, cursor, registration, limit);
    const before = cursor.phase === 'catchup' ? cursor.before : undefined;
    // TDLib includes the anchor and the Telegram adapter removes it. Reserving one row avoids a limit=1 stall.
    const requested = Math.min(100, before ? limit + 1 : limit);
    let raw: Observation[];
    try { raw = await this.options.telegram.readHistory(source.resource, { ...(before ? { before } : {}), limit: requested }); }
    catch { return { sourceId: source.id, changes: [], hasMore: false, unavailable: true,
      coverage: { ...this.describe(cursor, registration), gap: 'history source unavailable; committed cursor preserved' } }; }
    registration = this.registration(cursor.binding);
    if (reference === undefined && registration.journalSeq !== baselineSequence) return { sourceId: source.id, changes: [], hasMore: false, unavailable: true,
      coverage: { ...this.describe(cursor, registration), gap: 'source changed during baseline snapshot; stable baseline retry required' } };
    // Events arriving during the asynchronous history call precede admission of
    // its newest snapshot. Defer that snapshot until those events are drained.
    if (reference !== undefined && decimal(registration.journalSeq) > decimal(cursor.journalSeq)) return this.journal(cacheKey, cursor, registration, limit);
    if (!Array.isArray(raw) || raw.length > requested) throw new Error('Monitor history page exceeded native bound');
    const rows = raw.filter(row => {
      if (row.ref.accountId !== this.options.accountId || row.ref.peerId !== source.resource) throw new Error('Monitor history identity mismatch');
      return /^[1-9]\d{0,39}$/.test(row.ref.messageId);
    }).sort((a, b) => decimal(a.ref.messageId) > decimal(b.ref.messageId) ? -1 : decimal(a.ref.messageId) < decimal(b.ref.messageId) ? 1 : 0);
    const byId = new Map<string, Observation>();
    for (const row of rows) {
      const prior = byId.get(row.ref.messageId);
      if (prior && stableChange(prior).version !== stableChange(row).version) throw new Error('Monitor same-page identity has conflicting content');
      byId.set(row.ref.messageId, row);
    }
    const unique = [...byId.values()];
    const highwater = decimal(cursor.highwater);
    if (reference === undefined) {
      const selected = unique.slice(0, limit); cursor.highwater = selected[0]?.ref.messageId ?? '0'; cursor.nextLane = 'journal';
      // Existing source journal events belong to the quiet start-now baseline,
      // including another subscription's prior watch. Do not replay older edits
      // after the latest bootstrap snapshot has established the initial state.
      cursor.journalSeq = registration.journalSeq;
      // Initial monitoring is a declared recent snapshot; old history exhaustion is not inferred from a short page.
      return this.persist(cacheKey, cursor, selected.map(stableChange), false, this.describe(cursor, registration));
    }
    if (cursor.phase === 'idle') {
      const head = unique[0]?.ref.messageId;
      if (!head) return { sourceId: source.id, changes: [], hasMore: false, unavailable: true,
        coverage: { ...this.describe(cursor, registration), gap: 'empty head response does not prove source exhaustion' } };
      if (decimal(head) <= highwater) {
        cursor.nextLane = 'journal';
        return this.persist(cacheKey, cursor, unique.slice(0, limit).map(stableChange), journalPending, this.describe(cursor, registration));
      }
      cursor.phase = 'catchup'; cursor.upper = head;
    }
    const upper = decimal(cursor.upper!);
    const eligible = unique.filter(row => decimal(row.ref.messageId) <= upper && (!before || decimal(row.ref.messageId) < decimal(before)));
    const reached = eligible.some(row => decimal(row.ref.messageId) <= highwater);
    const fresh = eligible.filter(row => decimal(row.ref.messageId) > highwater).slice(0, limit);
    if (!reached && fresh.length === 0) {
      // Empty/short TDLib responses cannot prove exhaustion. Retain the last committed job cursor for retry.
      return { sourceId: source.id, changes: [], hasMore: false, unavailable: true,
        coverage: { ...this.describe(cursor, registration), gap: 'history page did not reach committed boundary; retry required' } };
    }
    if (reached && eligible.filter(row => decimal(row.ref.messageId) > highwater).length <= limit) {
      cursor.highwater = cursor.upper!; cursor.phase = 'idle'; delete cursor.upper; delete cursor.before;
    } else cursor.before = fresh.at(-1)!.ref.messageId;
    cursor.nextLane = 'journal';
    return this.persist(cacheKey, cursor, fresh.map(stableChange), cursor.phase === 'catchup' || journalPending, this.describe(cursor, registration));
  }
  private async web(source: JobSource, cacheKey: string, cursor: Cursor, registration: SourceRegistration): Promise<PageResult> {
    if (!this.options.web) throw new Error('Scoped WebService monitor adapter unavailable');
    const snapshot = await this.options.web.fetch(clone(source));
    validatePublicUrl(snapshot.url);
    if (!Number.isInteger(snapshot.status) || snapshot.status < 200 || snapshot.status >= 300 || typeof snapshot.text !== 'string' || Buffer.byteLength(snapshot.text) > 512 * 1024 || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > 512 * 1024) throw new Error('Monitor web snapshot invalid or oversized');
    const version = hash([snapshot.url, snapshot.status, snapshot.mimeType, snapshot.text]);
    const changed = version !== cursor.webVersion;
    const sequence = changed ? (decimal(cursor.webSequence ?? '0') + 1n).toString() : cursor.webSequence ?? '0';
    const changes: SourceChange[] = !changed ? [] : [{ itemId: hash(source.resource), kind: cursor.webVersion ? 'edit' : 'message', version: hash([version, sequence]), observedAt: new Date().toISOString(), title: source.resource, text: snapshot.text }];
    cursor.webSequence = sequence;
    cursor.webVersion = version;
    return this.persist(cacheKey, cursor, changes, false, this.describe(cursor, registration));
  }
}
export function createMonitorSource(options: MonitorSourceOptions): DurableMonitorSource { return new DurableMonitorSource(options); }
