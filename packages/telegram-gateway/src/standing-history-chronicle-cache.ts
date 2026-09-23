import { createHash, createHmac } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent, type StandingHistoryStoredPage } from "./standing-history-task-store.js";
import { snapshotStandingHistoryAnalysisOutput, type StandingHistoryAnalysisOutput, type StandingHistoryAnalysisMaterialRequest, type StandingHistoryAnalysisNode } from "./standing-history-analysis-store.js";
import { projectStandingHistorySource, type StandingHistorySourceFragment } from "./standing-history-source-projection.js";
import { MAX_ANALYSIS_NODES, MAX_CLAIMS, MAX_FRAGMENTS } from "./standing-history-analysis-limits.js";

export type StandingHistoryChronicleProducer = Readonly<{ model: string; promptVersion: string; projectionVersion: string; outputVersion: string }>;
export type StandingHistoryChronicleSelection = Readonly<{
  intent: StandingHistoryTaskIntent; producer: StandingHistoryChronicleProducer; referenceKey: string;
  /** Authenticated reads from the current task, never pages supplied by a model. */
  materials: readonly Readonly<{ request: StandingHistoryAnalysisMaterialRequest; page: StandingHistoryStoredPage }>[];
}>;
export type StandingHistoryChronicleCoverage = Readonly<{
  scope: "selected-material-only"; rows: number; includedRows: number; firstDate: number | null; lastDate: number | null;
  days: readonly Readonly<{ day: string; rows: number }>[]; hasMoreDays: boolean;
  fragments: readonly Readonly<{ pageIndex: number; range: StandingHistorySourceFragment["range"]; coverage: StandingHistorySourceFragment["coverage"] }>[];
}>;
export type StandingHistoryChronicleProvenance = Readonly<{
  kind: "reused-analysis"; claimsStatus: "model-authored-unverified"; cacheRef: string; contentHash: string; producerHash: string;
  originTaskRef: string; originNodeRef: string; originNodeHash: string; capturedAt: number;
}>;
export type StandingHistoryChronicleHit = Readonly<{ output: StandingHistoryAnalysisOutput; provenance: StandingHistoryChronicleProvenance; coverage: StandingHistoryChronicleCoverage }>;
export type StandingHistoryChronicleCatalogEntry = Readonly<{
  cacheRef: string; objectiveHash: string; producerHash: string; period: Readonly<{ fromDate: number; toDate: number; timezone: string }>;
  coverage: StandingHistoryChronicleCoverage; capturedAt: number; mode: "query-specific";
}>;
export type StandingHistoryChronicleCache = Readonly<{
  lookup(selection: StandingHistoryChronicleSelection): Promise<StandingHistoryChronicleHit | undefined>;
  /** Caller must capture only an authenticated, saved leaf after its model owner
   * settled. The cache does not establish that fact or create a native attempt. */
  remember(input: StandingHistoryChronicleSelection & Readonly<{ node: StandingHistoryAnalysisNode; capturedAt: number }>): Promise<StandingHistoryChronicleProvenance | undefined>;
  /** Background-only bounded period discovery. Entries are query-specific and
   * may overlap; their row counts must never be summed as complete coverage. */
  catalog(input: Readonly<{ intent: StandingHistoryTaskIntent; producer: StandingHistoryChronicleProducer; limit?: number }>): Promise<readonly StandingHistoryChronicleCatalogEntry[]>;
  close(): Promise<void>;
}>;
const DOMAIN = "DecadansNeurobro/standing-history-chronicle-cache/v1";
const MAX_PLAIN = 128 * 1024, MAX_CIPHER = 192 * 1024, MAX_ENTRIES = 1024, MAX_PERIODS = 64;
const fail = (): never => { throw new Error("STANDING_HISTORY_CHRONICLE_CACHE_INPUT"); };
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const reference = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp("^" + prefix + "_[0-9a-f]{48}$").test(v);
const canonical = (v: unknown): string => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object"
  ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}" : JSON.stringify(v);
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
function fields(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, any> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail();
  const out: Record<string, unknown> = {};
  for (const key of keys as string[]) { const d = ds[key]!; if (!("value" in d) || !d.enumerable) return fail(); out[key] = d.value; }
  return out;
}
function snapshot<T>(v: T): T {
  let remaining = 2 * 1024 * 1024, nodes = 0;
  const copy = (v: unknown, depth: number): any => {
    if (++nodes > 65536 || depth > 24 || --remaining < 0) return fail();
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") { remaining -= Buffer.byteLength(v); if (remaining < 0 || Buffer.from(v).toString() !== v) return fail(); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) return fail();
      const ds = Object.getOwnPropertyDescriptors(v), n = Object.getOwnPropertyDescriptor(v, "length")!.value;
      if (!Number.isSafeInteger(n) || n < 0 || n > 8192 || Reflect.ownKeys(ds).length !== n + 1) return fail();
      const out = []; for (let i = 0; i < n; i++) { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail(); out.push(copy(d.value, depth + 1)); } return Object.freeze(out);
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
    const ds = Object.getOwnPropertyDescriptors(v), out: Record<string, unknown> = {};
    for (const k of Reflect.ownKeys(ds)) { if (typeof k !== "string" || ["__proto__", "constructor", "prototype"].includes(k)) return fail(); const d = ds[k]!; if (!("value" in d) || !d.enumerable) return fail(); out[k] = copy(d.value, depth + 1); }
    return Object.freeze(out);
  };
  return copy(v, 0);
}
function producerCopy(v: unknown): StandingHistoryChronicleProducer {
  const p = fields(v, ["model", "promptVersion", "projectionVersion", "outputVersion"]);
  if (Object.values(p).some(v => typeof v !== "string" || !v.trim() || v.includes("\0") || Buffer.byteLength(v) > 256)) return fail();
  return Object.freeze(p) as StandingHistoryChronicleProducer;
}
function scopeFor(intent: StandingHistoryTaskIntent, producer: StandingHistoryChronicleProducer) {
  return { accountId: intent.accountId, chatId: intent.chatId, requesterId: intent.requesterId, source: intent.source ?? null,
    period: { fromDate: intent.fromDate, toDate: intent.toDate, timezone: intent.timezone }, producer };
}
type Prepared = ReturnType<typeof prepare>;
function prepare(value: StandingHistoryChronicleSelection) {
  const v = fields(value, ["intent", "producer", "referenceKey", "materials"]), intent = snapshotStandingHistoryTaskIntent(v.intent), producer = producerCopy(v.producer);
  if (!digest(v.referenceKey)) return fail();
  const materials = snapshot(v.materials) as StandingHistoryChronicleSelection["materials"];
  if (!Array.isArray(materials) || materials.length < 1 || materials.length > MAX_FRAGMENTS) return fail();
  const fragments: StandingHistorySourceFragment[] = [], normalized: unknown[] = [], seenIds = new Set<number>(), supports: { sourceRef: string; versionRef: string }[] = [];
  const dates: number[] = [], days = new Map<string, number>(); let includedRows = 0;
  const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: intent.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const raw of materials) {
    const m = fields(raw, ["request", "page"]), r = fields(m.request, ["pageIndex", "maxBytes", "materialRef"], ["position", "maxRows"]);
    const fragment = projectStandingHistorySource({ intent, referenceKey: v.referenceKey, storedPage: m.page, maxBytes: r.maxBytes,
      ...(r.position === undefined ? {} : { position: r.position }), ...(r.maxRows === undefined ? {} : { maxRows: r.maxRows }) });
    if (fragment.materialRef !== r.materialRef || fragment.pageIndex !== r.pageIndex) return fail();
    const byRef = new Map(m.page.result.page.messages.map((row: any) => [row.ref, row]));
    const rows = m.page.result.sources.slice(fragment.range.fromRow, fragment.range.toRow).map((s: any, i: number) => {
      if (seenIds.has(s.messageId)) return fail(); seenIds.add(s.messageId);
      const projected = fragment.rows[i]!; supports.push({ sourceRef: projected.sourceRef, versionRef: projected.versionRef });
      if (s.date !== null) { dates.push(s.date); const day = dayFormat.format(new Date(s.date * 1000)); days.set(day, (days.get(day) ?? 0) + 1); }
      if (s.disposition !== "included") return { messageId: s.messageId, date: s.date, disposition: s.disposition };
      includedRows++; const message = byRef.get(s.messageRef) as any;
      return { messageId: s.messageId, date: s.date, disposition: s.disposition, authorId: s.authorId, author: message.author, displayName: message.displayName,
        editedAt: message.editedAt, text: message.text, replyToMessageId: s.replyToMessageId ?? null, replyUnavailable: message.replyUnavailable,
        replyContentAvailable: projected.disposition === "included" && projected.replyContentAvailable, forwarded: message.forwarded ?? null };
    });
    // Preserve every model-visible contextual field except opaque task-local
    // aliases and hashes. A page number/coverage change is conservatively a miss.
    normalized.push({ pageIndex: fragment.pageIndex, fromDate: fragment.fromDate, toDate: fragment.toDate, rows, range: fragment.range,
      hasNextPosition: fragment.nextPosition !== null, coverage: fragment.coverage, limitations: fragment.limitations,
      sourceRef: fragment.sourceRef ?? null, sourceInterpretation: fragment.sourceInterpretation ?? null });
    fragments.push(fragment);
  }
  const scope = scopeFor(intent, producer), objectiveHash = hash(intent.objective), contentHash = hash(normalized), producerHash = hash(producer);
  const coverage: StandingHistoryChronicleCoverage = snapshot({ scope: "selected-material-only", rows: supports.length, includedRows,
    firstDate: dates.length ? Math.min(...dates) : null, lastDate: dates.length ? Math.max(...dates) : null,
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).slice(0, 64).map(([day, rows]) => ({ day, rows })), hasMoreDays: days.size > 64,
    fragments: fragments.map(f => ({ pageIndex: f.pageIndex, range: f.range, coverage: f.coverage })) });
  return { intent, scope, objectiveHash, contentHash, producerHash, fragments, materials, supports, coverage };
}
type PortableOutput = Readonly<{ summary: string; claims: readonly Readonly<{ kind: StandingHistoryAnalysisOutput["claims"][number]["kind"]; text: string; supports: readonly number[] }>[]; omittedDetailCount?: number }>;
// Inline opaque aliases have no typed rebinding contract. Do not preserve a
// stale identifier in prose or guess whether an arbitrary token means a source.
const inlineAlias = /(?:hsrc|hver|hspk|hmat|hnode|hnote|hpos|hnpos|htask|hattempt|chron|chver)_[A-Za-z0-9_:-]+/;
function portableOutput(output: StandingHistoryAnalysisOutput, prepared: Prepared): PortableOutput {
  const out = snapshotStandingHistoryAnalysisOutput(output), indices = new Map(prepared.supports.map((s, i) => [s.sourceRef + ":" + s.versionRef, i]));
  if (inlineAlias.test(out.summary) || out.claims.some(c => inlineAlias.test(c.text))) return fail();
  return snapshot({ ...out, claims: out.claims.map(c => ({ ...c, supports: c.supports.map(s => { const i = indices.get(s.sourceRef + ":" + s.versionRef); if (i === undefined) return fail(); return i; }) })) });
}
function reboundOutput(value: unknown, prepared: Pick<Prepared, "supports">): StandingHistoryAnalysisOutput {
  const o = fields(value, ["summary", "claims"], ["omittedDetailCount"]);
  if (!Array.isArray(o.claims) || o.claims.length > MAX_CLAIMS) return fail();
  return snapshotStandingHistoryAnalysisOutput({ ...o, claims: o.claims.map((value: unknown) => {
    const c = fields(value, ["kind", "text", "supports"]); if (!Array.isArray(c.supports) || c.supports.length < 1 || c.supports.length > 16) return fail();
    return { ...c, supports: c.supports.map((index: unknown) => { if (!Number.isSafeInteger(index) || Number(index) < 0 || !prepared.supports[Number(index)]) return fail(); return prepared.supports[Number(index)]!; }) };
  }) });
}

/** Optional task-independent, encrypted leaf cache. Exact current source reads
 * are required on every hit; this detects edits/deletions in selected material
 * without claiming a live immutable Telegram snapshot. The host serializes the
 * cache writer. No task journal, model reservation, delivery or foreground state
 * is modified here. Corrupt/missing/conflicting cache evidence is only a miss.
 * At most 64 source/period/producer partitions and 1024 entries per partition;
 * quota exhaustion is a miss, with no automatic deletion. */
export async function openStandingHistoryChronicleCache(input: Readonly<{ directory: string; passphrase: string }>): Promise<StandingHistoryChronicleCache> {
  const a = fields(input, ["directory", "passphrase"]);
  if (typeof a.directory !== "string" || !isAbsolute(a.directory) || resolve(a.directory) !== a.directory || dirname(a.directory) === a.directory ||
    typeof a.passphrase !== "string" || a.passphrase.length < 16 || Buffer.byteLength(a.passphrase) > 4096 || a.passphrase.includes("\0")) return fail();
  const directory: string = a.directory, parent = dirname(directory); let passphrase: string = a.passphrase;
  const key = createHmac("sha256", passphrase).update(DOMAIN + "/index").digest();
  let root: BigIntStats | undefined, closed = false, active: Promise<unknown> | undefined;
  const dirStat = async (path: string) => { await assertPilotPrivateDirectory(path); const s = await lstat(path, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink()) return fail(); return s; };
  const parentIdentity = await dirStat(parent);
  try { root = await dirStat(directory); } catch (e) { if (!missing(e)) { key.fill(0); passphrase = ""; throw e; } }
  const guard = async () => {
    if (!same(parentIdentity, await dirStat(parent))) return fail();
    if (root) { if (!same(root, await dirStat(directory))) return fail(); }
    else { try { await lstat(directory); return fail(); } catch (e) { if (!missing(e)) throw e; } }
  };
  const mac = (v: unknown) => createHmac("sha256", key).update(canonical([DOMAIN, v])).digest("hex");
  const refs = (p: Prepared) => ({ periodRef: mac(p.scope), entryRef: mac({ scope: p.scope, objectiveHash: p.objectiveHash, contentHash: p.contentHash }) });
  const read = async (slot: string, filename: string, identity: BigIntStats): Promise<any> => {
    await guard(); if (!same(identity, await dirStat(slot))) return fail();
    const path = join(slot, filename), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail();
    const handle = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) return fail();
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { const got = await handle.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size) || stamp(await handle.stat({ bigint: true })) !== stamp(before) || stamp(await lstat(path, { bigint: true })) !== stamp(before)) return fail();
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail();
      const value = snapshot(JSON.parse(plain)); await guard(); if (!same(identity, await dirStat(slot))) return fail(); return value;
    } finally { bytes?.fill(0); await handle.close(); }
  };
  const decode = (value: unknown, p: Prepared, entryRef: string): StandingHistoryChronicleHit => {
    const e = fields(value, ["domain", "scope", "objectiveHash", "contentHash", "producerHash", "provenance", "coverage", "output"]);
    if (e.domain !== DOMAIN || !equal(e.scope, p.scope) || e.objectiveHash !== p.objectiveHash || e.contentHash !== p.contentHash || e.producerHash !== p.producerHash || !equal(e.coverage, p.coverage)) return fail();
    const provenance = fields(e.provenance, ["kind", "claimsStatus", "cacheRef", "contentHash", "producerHash", "originTaskRef", "originNodeRef", "originNodeHash", "capturedAt"]);
    if (provenance.kind !== "reused-analysis" || provenance.claimsStatus !== "model-authored-unverified" || provenance.cacheRef !== "hcache_" + entryRef ||
      provenance.contentHash !== p.contentHash || provenance.producerHash !== p.producerHash || !reference(provenance.originTaskRef, "htask") || !reference(provenance.originNodeRef, "hnode") ||
      !digest(provenance.originNodeHash) || !Number.isSafeInteger(provenance.capturedAt) || provenance.capturedAt < 0) return fail();
    const output = reboundOutput(e.output, p); if (!equal(portableOutput(output, p), e.output)) return fail();
    return snapshot({ output, provenance: provenance as StandingHistoryChronicleProvenance, coverage: p.coverage });
  };
  const run = <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    if (closed || active) return Promise.resolve(fallback);
    const operation = Promise.resolve().then(work).catch(() => fallback); active = operation;
    return operation.finally(() => { if (active === operation) active = undefined; });
  };
  return Object.freeze<StandingHistoryChronicleCache>({
    lookup(value) {
      const p = prepare(value);
      return run(async () => { if (!root) return undefined; const { periodRef, entryRef } = refs(p), slot = join(directory, periodRef), identity = await dirStat(slot);
        return decode(await read(slot, entryRef + ".enc", identity), p, entryRef); }, undefined);
    },
    remember(value) {
      const v = fields(value, ["intent", "producer", "referenceKey", "materials", "node", "capturedAt"]), p = prepare({ intent: v.intent, producer: v.producer, referenceKey: v.referenceKey, materials: v.materials });
      const node = fields(snapshot(v.node), ["nodeRef", "kind", "index", "hash", "inputs", "coverage", "output"]);
      if (node.kind !== "leaf" || !reference(node.nodeRef, "hnode") || !digest(node.hash) || !Number.isInteger(node.index) || node.index < 1 || node.index > MAX_ANALYSIS_NODES || !Number.isSafeInteger(v.capturedAt) || v.capturedAt < 0) return fail();
      const expected = p.fragments.map((f, i) => ({ ...p.materials[i]!.request, materialRef: f.materialRef, pageIndex: f.pageIndex, pageHash: f.pageHash, range: f.range, coverage: f.coverage,
        supports: f.rows.filter(row => row.disposition === "included").map(row => ({ sourceRef: row.sourceRef, versionRef: row.versionRef })) }));
      if (!equal(fields(node.inputs, ["materials"]).materials, expected) || !equal(node.coverage, p.fragments.map(f => ({ materialRef: f.materialRef, pageIndex: f.pageIndex, pageHash: f.pageHash, range: f.range, coverage: f.coverage })))) return fail();
      let output: PortableOutput; try { output = portableOutput(node.output, p); } catch { return Promise.resolve(undefined); }
      return run(async () => {
        await guard(); const { periodRef, entryRef } = refs(p), slot = join(directory, periodRef), filename = entryRef + ".enc";
        const provenance: StandingHistoryChronicleProvenance = { kind: "reused-analysis", claimsStatus: "model-authored-unverified", cacheRef: "hcache_" + entryRef,
          contentHash: p.contentHash, producerHash: p.producerHash, originTaskRef: p.intent.taskId, originNodeRef: node.nodeRef, originNodeHash: node.hash, capturedAt: v.capturedAt };
        // Cache budgets remain smaller than valid analysis nodes. Prove both
        // bounded storage and reader roundtrip before creating any cache state.
        const envelope = { domain: DOMAIN, scope: p.scope, objectiveHash: p.objectiveHash, contentHash: p.contentHash, producerHash: p.producerHash, provenance, coverage: p.coverage, output };
        const plain = JSON.stringify(envelope); if (Buffer.byteLength(plain) > MAX_PLAIN) return undefined;
        decode(snapshot(JSON.parse(plain)), p, entryRef);
        const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return undefined;
        if (!root) { await mkdir(directory, { mode: 0o700 }); root = await dirStat(directory); }
        await guard(); let identity: BigIntStats;
        try { identity = await dirStat(slot); } catch (e) {
          if (!missing(e)) throw e;
          const partitions = await opendir(directory, { bufferSize: 1 }); let count = 0;
          try { for (;;) { const entry = await partitions.read(); if (!entry) break;
            if (++count >= MAX_PERIODS || !entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f]{64}$/.test(entry.name)) return undefined;
          } } finally { await partitions.close(); }
          await guard(); await mkdir(slot, { mode: 0o700 }); identity = await dirStat(slot);
        }
        try { const existing = decode(await read(slot, filename, identity), p, entryRef); return existing.provenance; } catch (e) { if (!missing(e)) return undefined; }
        const listing = await opendir(slot, { bufferSize: 1 }); let count = 0;
        try { for (;;) { const entry = await listing.read(); if (!entry) break; if (++count >= MAX_ENTRIES || !entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.enc$/.test(entry.name)) return undefined; } } finally { await listing.close(); }
        await guard(); if (!same(identity, await dirStat(slot))) return undefined;
        const handle = await open(join(slot, filename), "wx", 0o600);
        try { await handle.writeFile(cipher); await handle.sync(); } finally { await handle.close(); }
        return decode(await read(slot, filename, identity), p, entryRef).provenance;
      }, undefined);
    },
    catalog(value) {
      const v = fields(value, ["intent", "producer"], ["limit"]), intent = snapshotStandingHistoryTaskIntent(v.intent), producer = producerCopy(v.producer), limit = v.limit ?? 8;
      if (!Number.isInteger(limit) || limit < 1 || limit > 32) return fail();
      const scope = scopeFor(intent, producer);
      return run(async () => {
        if (!root) return Object.freeze([]); const slot = join(directory, mac(scope)), identity = await dirStat(slot), listing = await opendir(slot, { bufferSize: 1 });
        const names: string[] = [];
        try { for (;;) { const entry = await listing.read(); if (!entry) break; if (names.length >= MAX_ENTRIES || !entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.enc$/.test(entry.name)) return Object.freeze([]); names.push(entry.name); } } finally { await listing.close(); }
        const entries: StandingHistoryChronicleCatalogEntry[] = [];
        for (const name of names.sort().slice(0, limit)) {
          try {
            const e = fields(await read(slot, name, identity), ["domain", "scope", "objectiveHash", "contentHash", "producerHash", "provenance", "coverage", "output"]);
            if (e.domain !== DOMAIN || !equal(e.scope, scope) || !digest(e.objectiveHash) || !digest(e.contentHash) || e.producerHash !== hash(producer) ||
              name !== mac({ scope, objectiveHash: e.objectiveHash, contentHash: e.contentHash }) + ".enc") continue;
            // Catalog is a hint only; actual reuse always reprojects fresh pages
            // and validates the full entry through decode above.
            entries.push(snapshot({ cacheRef: "hcache_" + name.slice(0, -4), objectiveHash: e.objectiveHash, producerHash: e.producerHash, period: scope.period,
              coverage: e.coverage, capturedAt: e.provenance.capturedAt, mode: "query-specific" }));
          } catch { /* A damaged entry cannot suppress unrelated catalog hints. */ }
        }
        return Object.freeze(entries);
      }, Object.freeze([]));
    },
    async close() { closed = true; try { await active; } finally { passphrase = ""; key.fill(0); } },
  });
}
