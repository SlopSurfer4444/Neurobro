import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, standingHistoryTaskSourcePeerId, type StandingHistoryTaskIntent, type StandingHistoryTaskStore } from "./standing-history-task-store.js";
import { snapshotStandingHistoryAnalysisOutput, validateStandingHistoryShownOutput, type StandingHistoryAnalysisStore, type StandingHistoryAnalysisOutput,
  type StandingHistoryAnalysisSupport, type StandingHistoryAnalysisMaterialRequest, type StandingHistoryAnalysisNode, type StandingHistoryAnalysisSpan } from "./standing-history-analysis-store.js";
import type { StandingHistoryAnalysisNativeBinding, StandingHistoryAnalysisModelOutcome, StandingHistoryAnalysisNodeEvidence } from "./standing-history-analysis-attempt-store.js";
import { projectStandingHistorySource } from "./standing-history-source-projection.js";
import { projectMergeView } from "./standing-history-analysis-view.js";
import { prepareStandingHistoryAnalysisMaterial } from "./standing-history-analysis-runtime.js";
import { MATERIAL_BYTES, LEGACY_MATERIAL_BYTES, MAX_FRAGMENTS, MAX_ANALYSIS_NODES, MAX_SUPPORTS, NODE_PLAIN_BYTES, NODE_CIPHER_BYTES } from "./standing-history-analysis-limits.js";

export type StandingHistoryParallelWorkPlan = Readonly<{ modelInputHash: string; nativeBinding: StandingHistoryAnalysisNativeBinding; contextHash?: string }> & (
  Readonly<{ kind: "leaf"; inputs: readonly StandingHistoryAnalysisMaterialRequest[] }> | Readonly<{ kind: "merge"; children: readonly string[]; viewMaxBytes?: number }>);
export type StandingHistoryParallelWork = Readonly<{
  workRef: string; waveRef: string; ordinal: number; sourceHead: string; baseAnalysisHead: string; baseNodeCount: number;
  plan: StandingHistoryParallelWorkPlan; modelReplayAllowed: false; output?: StandingHistoryAnalysisOutput; modelOutcome?: StandingHistoryAnalysisModelOutcome;
  consecutiveNoOutput?: number;
  noOutputClassification?: "output-present" | "observed-no-output" | "refused-no-output" | "unknown-no-output" | "missing-outcome";
  projection?: Readonly<{ expectedHead: string; nodeIndex: number; outputHash: string }>; node?: StandingHistoryAnalysisNodeEvidence;
}>;
export type StandingHistoryParallelWorkStatus = Readonly<{
  storage: "ready" | "tail-refused"; waves: number; works: number; projected: number; modelReplayAllowed: false;
  activeWave?: Readonly<{ waveRef: string; workRefs: readonly string[] }>;
}>;
export type StandingHistoryParallelWorkStore = Readonly<{
  reserveWave(input: Readonly<{ sourceHead: string; expectedHead: string; works: readonly StandingHistoryParallelWorkPlan[] }>): Promise<Readonly<{ waveRef: string; workRefs: readonly string[] }>>;
  reserveSuccessor(input: Readonly<{ workRef: string; nativeBinding: StandingHistoryAnalysisNativeBinding;
    contextRefresh?: Readonly<{ previousContextHash: string | null; contextHash: string | null }>;
    verifyOwnerSettled(binding: StandingHistoryAnalysisNativeBinding): Promise<unknown> }>): Promise<Readonly<{ waveRef: string; workRef: string }>>;
  /** Host must derive shownSupports from acknowledged tool results for this exact work. */
  prepare(input: Readonly<{ workRef: string; output: StandingHistoryAnalysisOutput; shownSupports: readonly StandingHistoryAnalysisSupport[] }>): Promise<void>;
  recordModelOutcome(input: Readonly<{ workRef: string; outcome: StandingHistoryAnalysisModelOutcome }>): Promise<void>;
  readWork(workRef: string): Promise<StandingHistoryParallelWork>;
  projectNext(input: Readonly<{ waveRef: string }> & (Readonly<{ verifyOwnerSettled(binding: StandingHistoryAnalysisNativeBinding): Promise<unknown> }> |
    Readonly<{ verifyWorkReleased(binding: StandingHistoryAnalysisNativeBinding, workRef: string): Promise<unknown> }>)): Promise<Readonly<{ kind: "projected"; workRef: string; node: StandingHistoryAnalysisNodeEvidence }> | Readonly<{ kind: "complete" }>>;
  status(): Promise<StandingHistoryParallelWorkStatus>; close(): Promise<void>;
}>;
export class StandingHistoryParallelWorkStoreError extends Error {
  constructor(readonly code: "input" | "binding" | "conflict" | "consumed" | "support" | "overlap" | "limit" | "storage" | "tail" | "busy" | "closed" | "aborted" | "settlement") {
    super("STANDING_HISTORY_PARALLEL_WORK_" + code.toUpperCase()); this.name = "StandingHistoryParallelWorkStoreError";
  }
}
const fail = (code: StandingHistoryParallelWorkStoreError["code"]): never => { throw new StandingHistoryParallelWorkStoreError(code); };
// A wave may contain eight separately bounded nodes. Its authenticated receipt
// includes all work memberships and coverage, so it needs an aggregate budget.
const DOMAIN = "DecadansNeurobro/standing-history-parallel-work/v1", MAX_EVENTS = 4096, MAX_PLAIN = 8 * NODE_PLAIN_BYTES, MAX_CIPHER = 8 * NODE_CIPHER_BYTES;
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const ref = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp("^" + prefix + "_[a-f0-9]{48}$", "u").test(v);
function data(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function snapshot<T>(v: T): T {
  if (v === undefined) return v; // Optional host read results only; nested undefined is refused.
  let budget = MAX_PLAIN;
  function visit(x: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 32) return fail("input");
    if (x === null || typeof x === "boolean") return x;
    if (typeof x === "number") { if (!Number.isSafeInteger(x)) return fail("input"); return x; }
    if (typeof x === "string") { budget -= Buffer.byteLength(x); if (budget < 0 || Buffer.from(x).toString("utf8") !== x) return fail("input"); return x; }
    if (!x || typeof x !== "object" || types.isProxy(x)) return fail("input");
    if (Array.isArray(x)) {
      if (Object.getPrototypeOf(x) !== Array.prototype || x.length > MAX_SUPPORTS || Reflect.ownKeys(x).length !== x.length + 1) return fail("input");
      const values = Array.from({ length: x.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(x, String(i)); if (!d || !("value" in d) || !d.enumerable) return fail("input"); return visit(d.value, depth + 1); });
      return Object.freeze(values);
    }
    const plain = data(x, [], Object.keys(x)); return Object.freeze(Object.fromEntries(Object.entries(plain).map(([k, value]) => [k, visit(value, depth + 1)])));
  }
  return visit(v, 0) as T;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex"), equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":"), sameDir = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function method<T extends (...args: never[]) => unknown>(v: unknown, name: string): T {
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail("input"); const d = Object.getOwnPropertyDescriptor(v, name);
  if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail("input"); return d.value.bind(v) as T;
}
function planCopy(value: unknown): StandingHistoryParallelWorkPlan {
  const p = data(snapshot(value), ["kind", "modelInputHash", "nativeBinding"], ["inputs", "children", "contextHash", "viewMaxBytes"]), b = data(p.nativeBinding, ["epochId", "requestRef", "purpose"]);
  if (Object.hasOwn(p, "contextHash") && !digest(p.contextHash)) return fail("input");
  const context = Object.hasOwn(p, "contextHash") ? { contextHash: p.contextHash as string } : {};
  if (!digest(p.modelInputHash) || typeof b.epochId !== "string" || !/^[a-f0-9]{32}$/u.test(b.epochId) || typeof b.requestRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(b.requestRef) || b.purpose !== "history-analysis") return fail("input");
  const nativeBinding = b as StandingHistoryAnalysisNativeBinding;
  if (p.kind === "leaf" && !Object.hasOwn(p, "children") && !Object.hasOwn(p, "viewMaxBytes") && Array.isArray(p.inputs) && p.inputs.length >= 1 && p.inputs.length <= MAX_FRAGMENTS) {
    const inputs = p.inputs.map(value => {
      const m = data(value, ["pageIndex", "maxBytes", "materialRef"], ["maxRows", "position"]);
      if (!Number.isSafeInteger(m.pageIndex) || Number(m.pageIndex) < 1 || Number(m.pageIndex) > 1024 || !Number.isSafeInteger(m.maxBytes) || Number(m.maxBytes) < 1024 || Number(m.maxBytes) > MATERIAL_BYTES || !ref(m.materialRef, "hmat") ||
          Object.hasOwn(m, "maxRows") && (!Number.isSafeInteger(m.maxRows) || Number(m.maxRows) < 1 || Number(m.maxRows) > 100) ||
          Object.hasOwn(m, "position") && (typeof m.position !== "string" || !/^hpos_(?:0|[1-9]\d{0,2})_[a-f0-9]{48}$/u.test(m.position))) return fail("input");
      return m as StandingHistoryAnalysisMaterialRequest;
    });
    if (new Set(inputs.map(v => v.materialRef)).size !== inputs.length) return fail("overlap");
    return snapshot({ kind: "leaf", modelInputHash: p.modelInputHash, nativeBinding, inputs, ...context });
  }
  if (p.kind === "merge" && !Object.hasOwn(p, "inputs") && Array.isArray(p.children) && p.children.length >= 2 && p.children.length <= MAX_ANALYSIS_NODES && p.children.every(v => ref(v, "hnode")) && new Set(p.children).size === p.children.length) {
    if (Object.hasOwn(p, "viewMaxBytes") && (!Number.isSafeInteger(p.viewMaxBytes) || Number(p.viewMaxBytes) < 1024 || Number(p.viewMaxBytes) > MATERIAL_BYTES)) return fail("input");
    return snapshot({ kind: "merge", modelInputHash: p.modelInputHash, nativeBinding, children: p.children, ...context,
      ...(Object.hasOwn(p, "viewMaxBytes") ? { viewMaxBytes: Number(p.viewMaxBytes) } : {}) });
  }
  return fail("input");
}
function supportsCopy(value: unknown): readonly StandingHistoryAnalysisSupport[] {
  const list = snapshot(value); if (!Array.isArray(list) || list.length > MAX_SUPPORTS) return fail("input");
  return Object.freeze(list.map(v => { const s = data(v, ["sourceRef", "versionRef"]); if (!ref(s.sourceRef, "hsrc") || !ref(s.versionRef, "hver")) return fail("input"); return Object.freeze(s) as StandingHistoryAnalysisSupport; }));
}
function contextRefreshCopy(value: unknown): Readonly<{ previousContextHash: string | null; contextHash: string | null }> {
  const c = data(snapshot(value), ["previousContextHash", "contextHash"]);
  if (c.previousContextHash !== null && !digest(c.previousContextHash) || c.contextHash !== null && !digest(c.contextHash) || c.previousContextHash === c.contextHash) return fail("input");
  return c as Readonly<{ previousContextHash: string | null; contextHash: string | null }>;
}
function successorPlan(plan: StandingHistoryParallelWorkPlan, nativeBinding: unknown, refresh?: ReturnType<typeof contextRefreshCopy>): StandingHistoryParallelWorkPlan {
  if (!refresh) return planCopy({ ...plan, nativeBinding });
  if ((plan.contextHash ?? null) !== refresh.previousContextHash) return fail("binding");
  // Only optional context may change. Source material, primary hash and all
  // plan bounds come exclusively from the authenticated predecessor.
  const { contextHash: _previousContextHash, ...primary } = plan;
  return planCopy({ ...primary, nativeBinding, ...(refresh.contextHash === null ? {} : { contextHash: refresh.contextHash }) });
}
const supportKey = (s: StandingHistoryAnalysisSupport) => s.sourceRef + ":" + s.versionRef;
type Work = { workRef: string; plan: StandingHistoryParallelWorkPlan; allowed: readonly StandingHistoryAnalysisSupport[]; coverage: readonly StandingHistoryAnalysisSpan[];
  priorNoOutput?: number;
  output?: StandingHistoryAnalysisOutput; outcome?: StandingHistoryAnalysisModelOutcome; projection?: { expectedHead: string; nodeIndex: number; outputHash: string }; node?: StandingHistoryAnalysisNodeEvidence };
type Wave = { waveRef: string; sourceHead: string; expectedHead: string; nodeCount: number; works: Work[] };

/** Parallel workers stage independent output; only this serial projector appends
 * the existing ordered analysis ledger. A reservation is consumed even if no
 * outcome was recorded. Reopen never grants a model dispatch or output write.
 * This module authenticates storage/material, not host control admission or
 * wire acknowledgements. The host owns those capabilities and all native work.
 * One host must own these stores. Concurrent calls are bounded and serialized;
 * independent process writers are not supported. No borrowed store is closed. */
// Every journal record, including expanded merge coverage, is bounded to
// MAX_PLAIN. This is not a replacement for the legacy large-merge path: callers
// keep those merges serial there. A too-large wave fails before reservation,
// so no model dispatch has been authorized by a fresh reserve return.
export async function openStandingHistoryParallelWorkStore(input: Readonly<{
  directory: string; passphrase: string; intent: StandingHistoryTaskIntent; mode: "create" | "open";
  source: Pick<StandingHistoryTaskStore, "status" | "readPage">;
  analysis: Pick<StandingHistoryAnalysisStore, "status" | "readNodeAt" | "readNode" | "referenceKey" | "appendLeaf" | "appendMerge">; signal?: AbortSignal;
}>): Promise<StandingHistoryParallelWorkStore> {
  const args = data(input, ["directory", "passphrase", "intent", "mode", "source", "analysis"], ["signal"]), intent = snapshotStandingHistoryTaskIntent(args.intent);
  if (typeof args.directory !== "string" || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory || typeof args.passphrase !== "string" || args.passphrase.length < 16 || Buffer.byteLength(args.passphrase) > 4096 ||
      !["create", "open"].includes(args.mode as string) || Object.hasOwn(args, "signal") && (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal))) return fail("input");
  const sourceStatus = method<StandingHistoryTaskStore["status"]>(args.source, "status"), readPage = method<StandingHistoryTaskStore["readPage"]>(args.source, "readPage");
  const analysisStatus = method<StandingHistoryAnalysisStore["status"]>(args.analysis, "status"), readNodeAt = method<StandingHistoryAnalysisStore["readNodeAt"]>(args.analysis, "readNodeAt");
  const readNode = method<StandingHistoryAnalysisStore["readNode"]>(args.analysis, "readNode"), referenceKey = method<StandingHistoryAnalysisStore["referenceKey"]>(args.analysis, "referenceKey");
  const appendLeaf = method<StandingHistoryAnalysisStore["appendLeaf"]>(args.analysis, "appendLeaf"), appendMerge = method<StandingHistoryAnalysisStore["appendMerge"]>(args.analysis, "appendMerge");
  const directory = args.directory, slot = join(directory, intent.taskId), signal = args.signal as AbortSignal | undefined;
  const header = { domain: DOMAIN, kind: "intent", intent }, headerHash = hash(header), waves: Wave[] = [], versions = new Map<string, string>(), fresh = new Set<string>();
  const archived = new Map<string, { wave: Wave; work: Work; ordinal: number }>();
  const allWorks = () => [...waves.flatMap(wave => wave.works), ...[...archived.values()].map(entry => entry.work)];
  // Count the active reservation conservatively, even without a native receipt.
  // The classification preserves absence; the successor persists its debit.
  const noOutputCount = (work: Work) => work.output ? 0 : (work.priorNoOutput ?? 0) + 1;
  const successorDebit = (work: Work) => (work.priorNoOutput ?? 0) + 1;
  const successorReason = (work: Work) => work.outcome === undefined ? "missing-outcome" : work.outcome === "unknown" ? "unknown-outcome" : work.outcome + "-no-output";
  const ancestors = (wave: Wave, ordinal: number) => [...archived.values()].filter(entry => entry.wave === wave && entry.ordinal === ordinal).map(entry => entry.work);
  const settlement = (value: unknown, binding: StandingHistoryAnalysisNativeBinding) => {
    const proof = data(snapshot(value), ["schema", "nativeBinding", "resourcesSettled", "persisted", "replacementReady", "modelOutcome"]);
    if (proof.schema !== "standing-analysis-owner-settlement-v1" || !equal(proof.nativeBinding, binding) || proof.resourcesSettled !== true || proof.persisted !== true || proof.replacementReady !== true || proof.modelOutcome !== "not-proven") return fail("settlement");
    return proof;
  };
  let root: BigIntStats, owner: BigIntStats, passphrase = args.passphrase, tail = false, closed = false, pending = 0, chain: Promise<unknown> = Promise.resolve(), eventCount = 0, eventHead = headerHash;
  let projections = 0, projectionChain: Promise<unknown> = Promise.resolve();
  const live = () => { if (closed) return fail("closed"); if (signal?.aborted) return fail("aborted"); };
  const filename = (i: number) => "event-" + String(i).padStart(6, "0") + ".enc";
  const check = async (known = false) => {
    live(); await assertPilotPrivateDirectory(directory); await assertPilotPrivateDirectory(slot);
    if (!sameDir(root, await lstat(directory, { bigint: true })) || !sameDir(owner, await lstat(slot, { bigint: true }))) return fail("storage");
    if (known) for (const [name, version] of versions) { const s = await lstat(join(slot, name), { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || stamp(s) !== version) return fail("storage"); }
    live();
  };
  const read = async (name: string) => {
    await check(); const path = join(slot, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      if (stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { live(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size)) return fail("storage");
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
      const value: unknown = JSON.parse(plain), after = await lstat(path, { bigint: true }); if (stamp(after) !== stamp(before)) return fail("storage");
      await check(); return { value, version: stamp(after) };
    } finally { bytes?.fill(0); await file.close(); }
  };
  const write = async (name: string, value: unknown) => {
    const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
    try {
      await check(); const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("limit"); await check();
      const file = await open(join(slot, name), "wx", 0o600); try { await file.writeFile(cipher); await file.sync(); } finally { await file.close(); }
      const saved = await read(name); if (!equal(saved.value, value)) return fail("storage"); versions.set(name, saved.version); await check(true);
    } catch (error) { tail = true; throw error; }
  };
  const inventory = async () => {
    await check(); const names = new Set<string>(), dir = await opendir(slot, { bufferSize: 1 }); let valid = true;
    try { for (let i = 0; i <= MAX_EVENTS + 1; i++) { const entry = await dir.read(); if (!entry) return { names, valid };
      names.add(entry.name); if (i === MAX_EVENTS + 1 || !entry.isFile() || entry.isSymbolicLink() || entry.name !== "intent.enc" && !/^event-\d{6}\.enc$/u.test(entry.name)) valid = false;
    } return { names, valid: false }; } finally { await dir.close(); }
  };
  const ready = async () => { await check(true); const list = await inventory(); if (!list.valid || list.names.size !== versions.size || [...versions.keys()].some(n => !list.names.has(n))) tail = true; if (tail) return fail("tail"); };
  const operation = <T>(f: () => Promise<T>): Promise<T> => {
    try { live(); if (pending >= 16) return Promise.reject(new StandingHistoryParallelWorkStoreError("busy")); } catch (error) { return Promise.reject(error); }
    pending++; const result = chain.then(async () => { live(); return f(); }); chain = result.catch(() => {}).finally(() => { pending--; }); return result;
  };
  const located = (workRef: unknown): { wave: Wave; work: Work; ordinal: number } => {
    if (!ref(workRef, "hwork")) return fail("input"); for (const wave of waves) { const ordinal = wave.works.findIndex(w => w.workRef === workRef); if (ordinal >= 0) return { wave, work: wave.works[ordinal]!, ordinal }; } return archived.get(workRef) ?? fail("binding");
  };
  const state = (): StandingHistoryParallelWorkStatus => {
    const current = waves.at(-1), active = current && current.works.some(w => !w.node);
    return snapshot({ storage: tail ? "tail-refused" : "ready", waves: waves.length, works: allWorks().length, projected: waves.reduce((n, w) => n + w.works.filter(v => v.node).length, 0), modelReplayAllowed: false,
      ...(active ? { activeWave: { waveRef: current.waveRef, workRefs: current.works.map(w => w.workRef) } } : {}) });
  };
  const heads = async () => {
    const source = snapshot(await sourceStatus()), analysis = snapshot(await analysisStatus()); live();
    if (source.storage !== "ready" || analysis.storage !== "ready" || !digest(source.readProgress.chainHash) || !digest(analysis.headHash) || !Number.isSafeInteger(analysis.analysisNodes) || analysis.analysisNodes < 0 || analysis.analysisNodes > MAX_ANALYSIS_NODES) return fail("storage");
    const checkpoint = source.readProgress.checkpoint;
    if (checkpoint.accountId !== intent.accountId || checkpoint.chatId !== standingHistoryTaskSourcePeerId(intent) || checkpoint.fromDate !== intent.fromDate || checkpoint.toDate !== intent.toDate) return fail("binding");
    return { sourceHead: source.readProgress.chainHash, expectedHead: analysis.headHash, nodeCount: analysis.analysisNodes };
  };
  const material = async (plan: StandingHistoryParallelWorkPlan, sourceHead: string, expectedHead: string) => {
    const allowed: StandingHistoryAnalysisSupport[] = [], coverage: StandingHistoryAnalysisSpan[] = []; let modelInputHash: string;
    if (plan.kind === "leaf") {
      const fragments = [];
      for (const request of plan.inputs) {
        const storedPage = snapshot(await readPage(request.pageIndex)); live(); if (!storedPage) return fail("binding");
        const fragment = projectStandingHistorySource({ intent, referenceKey: referenceKey(), storedPage, maxBytes: request.maxBytes,
          ...(request.maxRows === undefined ? {} : { maxRows: request.maxRows }), ...(request.position === undefined ? {} : { position: request.position }) });
        if (fragment.materialRef !== request.materialRef) return fail("binding"); fragments.push(fragment);
        coverage.push({ materialRef: fragment.materialRef, pageIndex: fragment.pageIndex, pageHash: fragment.pageHash, range: fragment.range, coverage: fragment.coverage });
        for (const row of fragment.rows) if (row.disposition === "included") allowed.push({ sourceRef: row.sourceRef, versionRef: row.versionRef });
      }
      const view = fragments.length === 1 ? fragments[0]! : { schema: "standing-history-source-batch-v1" as const, fragments };
      modelInputHash = prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead, inputs: plan.inputs as [StandingHistoryAnalysisMaterialRequest, ...StandingHistoryAnalysisMaterialRequest[]], material: view }).modelInputHash;
    } else {
      const children = [];
      for (const childRef of plan.children) { const child = snapshot(await readNode(childRef)); live(); if (!child || child.nodeRef !== childRef) return fail("binding"); children.push(child); coverage.push(...child.coverage); for (const claim of child.output.claims) allowed.push(...claim.supports); }
      const view = projectMergeView({ children, referenceKey: referenceKey(), maxBytes: plan.viewMaxBytes ?? LEGACY_MATERIAL_BYTES, preferComplete: true });
      modelInputHash = prepareStandingHistoryAnalysisMaterial({ kind: "merge", sourceHead, expectedHead, children: plan.children as [string, string, ...string[]], materials: view.children }).modelInputHash;
    }
    if (modelInputHash !== plan.modelInputHash) return fail("binding");
    return { allowed: supportsCopy([...new Map(allowed.map(support => [supportKey(support), support])).values()]), coverage: snapshot(coverage) };
  };
  const disjoint = (coverage: readonly StandingHistoryAnalysisSpan[]) => {
    for (let i = 0; i < coverage.length; i++) for (let j = i + 1; j < coverage.length; j++) {
      const a = coverage[i]!, b = coverage[j]!;
      if (a.pageIndex === b.pageIndex && (a.pageHash !== b.pageHash || a.range.totalRows !== b.range.totalRows || a.range.totalRows === 0 || Math.max(a.range.fromRow, b.range.fromRow) < Math.min(a.range.toRow, b.range.toRow))) return fail("overlap");
    }
  };
  const evidence = (value: unknown): StandingHistoryAnalysisNodeEvidence => {
    const e = data(value, ["nodeRef", "index", "hash"]); if (!ref(e.nodeRef, "hnode") || !digest(e.hash) || !Number.isSafeInteger(e.index) || Number(e.index) < 1 || Number(e.index) > MAX_ANALYSIS_NODES) return fail("binding"); return e as StandingHistoryAnalysisNodeEvidence;
  };
  const apply = (raw: unknown) => {
    const p = snapshot(raw) as Record<string, unknown>;
    if (p.kind === "wave") {
      data(p, ["kind", "waveRef", "sourceHead", "expectedHead", "nodeCount", "works"]);
      if (!ref(p.waveRef, "hwave") || waves.some(w => w.waveRef === p.waveRef) || !digest(p.sourceHead) || !digest(p.expectedHead) || !Number.isSafeInteger(p.nodeCount) || Number(p.nodeCount) < 0 || !Array.isArray(p.works) || p.works.length < 1 || p.works.length > 8 || Number(p.nodeCount) + p.works.length > MAX_ANALYSIS_NODES || waves.at(-1)?.works.some(w => !w.node)) return fail("binding");
      const seen = new Set(allWorks().map(v => v.plan.nativeBinding.requestRef)), refs = new Set(allWorks().map(v => v.workRef));
      const works = p.works.map(raw => { const w = data(raw, ["workRef", "plan", "allowed", "coverage"]), plan = planCopy(w.plan);
        if (!ref(w.workRef, "hwork") || refs.has(w.workRef) || seen.has(plan.nativeBinding.requestRef)) return fail("binding"); refs.add(w.workRef); seen.add(plan.nativeBinding.requestRef);
        if (!Array.isArray(w.coverage) || w.coverage.length < 1 || w.coverage.length > MAX_SUPPORTS) return fail("binding");
        return { workRef: w.workRef, plan, allowed: supportsCopy(w.allowed), coverage: w.coverage as readonly StandingHistoryAnalysisSpan[] }; });
      disjoint(works.flatMap(w => w.coverage));
      waves.push({ waveRef: p.waveRef, sourceHead: p.sourceHead, expectedHead: p.expectedHead, nodeCount: Number(p.nodeCount), works }); return;
    }
    const { wave, work, ordinal } = located(p.workRef);
    if (wave.works[ordinal] !== work) return fail("consumed");
    if (p.kind === "successor") {
      data(p, ["kind", "workRef", "successorWorkRef", "nativeBinding"]);
      const plan = planCopy({ ...work.plan, nativeBinding: p.nativeBinding });
      if (wave !== waves.at(-1) || work.output || work.projection || work.node || !["observed", "refused"].includes(work.outcome ?? "")) return fail("consumed");
      const priorNoOutput = noOutputCount(work); if (priorNoOutput >= 3) return fail("limit");
      if (!ref(p.successorWorkRef, "hwork") || allWorks().some(w => w.workRef === p.successorWorkRef || w.plan.nativeBinding.requestRef === plan.nativeBinding.requestRef) ||
          work.plan.nativeBinding.epochId === plan.nativeBinding.epochId || [...archived.values()].some(entry => entry.wave === wave && entry.ordinal === ordinal && entry.work.plan.nativeBinding.epochId === plan.nativeBinding.epochId)) return fail("binding");
      archived.set(work.workRef, { wave, work, ordinal });
      wave.works[ordinal] = { workRef: p.successorWorkRef, plan, allowed: work.allowed, coverage: work.coverage, priorNoOutput }; return;
    }
    if (p.kind === "no-output-successor-v1" || p.kind === "no-output-successor-v2") {
      data(p, ["kind", "workRef", "successorWorkRef", "nativeBinding", "reason", "sourceHead", "currentAnalysisHead", "currentNodeCount", "lineage", "settlement",
        ...(p.kind === "no-output-successor-v2" ? ["contextRefresh"] : [])]);
      const plan = successorPlan(work.plan, p.nativeBinding, p.kind === "no-output-successor-v2" ? contextRefreshCopy(p.contextRefresh) : undefined);
      if (wave !== waves.at(-1) || work.output || work.projection || work.node) return fail("consumed");
      const priorNoOutput = successorDebit(work); if (priorNoOutput >= 3) return fail("limit");
      const predecessors = [...ancestors(wave, ordinal), work];
      if (!ref(p.successorWorkRef, "hwork") || allWorks().some(w => w.workRef === p.successorWorkRef || w.plan.nativeBinding.requestRef === plan.nativeBinding.requestRef) ||
          predecessors.some(w => w.plan.nativeBinding.epochId === plan.nativeBinding.epochId)) return fail("binding");
      const projected = wave.works.filter(w => w.node), currentAnalysisHead = projected.at(-1)?.node?.hash ?? wave.expectedHead;
      const lineage = data(p.lineage, ["predecessorWorkRefs", "consecutiveNoOutput"]);
      if (p.reason !== successorReason(work) || p.sourceHead !== wave.sourceHead || p.currentAnalysisHead !== currentAnalysisHead || p.currentNodeCount !== wave.nodeCount + projected.length ||
          !equal(lineage.predecessorWorkRefs, predecessors.map(w => w.workRef)) || lineage.consecutiveNoOutput !== priorNoOutput) return fail("binding");
      settlement(p.settlement, work.plan.nativeBinding);
      archived.set(work.workRef, { wave, work, ordinal });
      wave.works[ordinal] = { workRef: p.successorWorkRef, plan, allowed: work.allowed, coverage: work.coverage, priorNoOutput }; return;
    }
    if (p.kind === "prepared") {
      data(p, ["kind", "workRef", "output", "shownSupports"]); if (work.output || work.outcome === "refused" || work.projection) return fail("consumed");
      const shown = supportsCopy(p.shownSupports), permitted = new Set(work.allowed.map(supportKey)); if (shown.some(s => !permitted.has(supportKey(s)))) return fail("support");
      work.output = validateStandingHistoryShownOutput(p.output, shown); return;
    }
    if (p.kind === "native") {
      data(p, ["kind", "workRef", "outcome"]); if (work.outcome || !["observed", "unknown", "refused"].includes(p.outcome as string) || p.outcome === "refused" && !!work.output) return fail("conflict");
      work.outcome = p.outcome as StandingHistoryAnalysisModelOutcome; return;
    }
    if (p.kind === "projection") {
      data(p, ["kind", "workRef", "expectedHead", "nodeIndex", "outputHash"]);
      if (!work.output || !work.outcome || work.outcome === "refused" || work.projection || wave.works.slice(0, ordinal).some(w => !w.node) ||
          p.expectedHead !== (ordinal === 0 ? wave.expectedHead : wave.works[ordinal - 1]!.node!.hash) || p.nodeIndex !== wave.nodeCount + ordinal + 1 || p.outputHash !== hash(work.output)) return fail("binding");
      work.projection = { expectedHead: p.expectedHead as string, nodeIndex: Number(p.nodeIndex), outputHash: p.outputHash as string }; return;
    }
    if (p.kind === "node") {
      data(p, ["kind", "workRef", "evidence"]); const e = evidence(p.evidence); if (!work.projection || work.node || e.index !== work.projection.nodeIndex) return fail("binding"); work.node = snapshot(e); return;
    }
    return fail("binding");
  };
  const append = async (payload: unknown) => {
    if (eventCount >= MAX_EVENTS) return fail("limit"); const event = { domain: DOMAIN, intentHash: headerHash, index: eventCount + 1, previousHash: eventHead, payload };
    await write(filename(eventCount + 1), event); try { apply(payload); } catch (error) { tail = true; throw error; } eventCount++; eventHead = hash(event);
  };
  try {
    live(); await assertPilotPrivateDirectory(directory); root = await lstat(directory, { bigint: true });
    if (args.mode === "create") await mkdir(slot, { mode: 0o700 }); await assertPilotPrivateDirectory(slot); owner = await lstat(slot, { bigint: true });
    if (args.mode === "create") await write("intent.enc", header);
    else {
      const saved = await read("intent.enc"); if (!equal(saved.value, header)) return fail("binding"); versions.set("intent.enc", saved.version);
      const list = await inventory(); if (!list.valid) tail = true;
      for (let i = 1; i <= MAX_EVENTS && list.names.has(filename(i)); i++) {
        try { const saved = await read(filename(i)), e = data(saved.value, ["domain", "intentHash", "index", "previousHash", "payload"]);
          if (e.domain !== DOMAIN || e.intentHash !== headerHash || e.index !== i || e.previousHash !== eventHead) return fail("binding");
          apply(e.payload); versions.set(filename(i), saved.version); eventHead = hash(saved.value); eventCount = i;
        } catch { live(); tail = true; break; }
      }
      if (versions.size !== list.names.size) tail = true;
    }
    await check(true);
  } catch (error) { passphrase = ""; throw error; }
  const verifyNode = (raw: StandingHistoryAnalysisNode, work: Work) => {
    const n = snapshot(raw), p = work.projection!, e = evidence({ nodeRef: n.nodeRef, index: n.index, hash: n.hash });
    if (n.index !== p.nodeIndex || n.kind !== work.plan.kind || hash(n.output) !== p.outputHash || !equal(n.coverage, work.coverage)) return fail("binding");
    if (work.plan.kind === "leaf") {
      const inputs = data(n.inputs, ["materials"]).materials as readonly StandingHistoryAnalysisMaterialRequest[];
      if (!Array.isArray(inputs) || !equal(inputs.map(m => ({ pageIndex: m.pageIndex, maxBytes: m.maxBytes, materialRef: m.materialRef, ...(m.maxRows === undefined ? {} : { maxRows: m.maxRows }), ...(m.position === undefined ? {} : { position: m.position }) })), work.plan.inputs)) return fail("binding");
    } else if (!equal(data(n.inputs, ["children"]).children, work.plan.children)) return fail("binding");
    return snapshot(e);
  };
  return Object.freeze({
    async reserveWave(value) {
      const r = data(value, ["sourceHead", "expectedHead", "works"]); if (!digest(r.sourceHead) || !digest(r.expectedHead) || !Array.isArray(r.works) || types.isProxy(r.works)) return fail("input");
      const plans = snapshot(r.works).map(planCopy); if (!plans.length || plans.length > 8) return fail("limit"); const sourceHead = r.sourceHead, expectedHead = r.expectedHead;
      return operation(async () => {
        await ready(); if (waves.at(-1)?.works.some(w => !w.node)) return fail("consumed"); if (eventCount + 1 + plans.length * 4 > MAX_EVENTS) return fail("limit");
        const before = await heads(); if (before.sourceHead !== sourceHead || before.expectedHead !== expectedHead || before.nodeCount + plans.length > MAX_ANALYSIS_NODES) return fail("conflict");
        const seen = new Set(allWorks().map(v => v.plan.nativeBinding.requestRef));
        const works: Work[] = [];
        for (const plan of plans) { if (seen.has(plan.nativeBinding.requestRef)) return fail("conflict"); seen.add(plan.nativeBinding.requestRef); works.push({ workRef: "hwork_" + randomBytes(24).toString("hex"), plan, ...await material(plan, sourceHead, expectedHead) }); }
        disjoint(works.flatMap(w => w.coverage));
        if (!equal(before, await heads())) return fail("conflict"); await ready();
        const waveRef = "hwave_" + randomBytes(24).toString("hex"); await append({ kind: "wave", waveRef, sourceHead, expectedHead, nodeCount: before.nodeCount, works });
        for (const w of works) fresh.add(w.workRef); return snapshot({ waveRef, workRefs: works.map(w => w.workRef) });
      });
    },
    async reserveSuccessor(value) {
      const p = data(value, ["workRef", "nativeBinding", "verifyOwnerSettled"], ["contextRefresh"]), workRef = p.workRef, nativeBinding = snapshot(p.nativeBinding);
      const contextRefresh = Object.hasOwn(p, "contextRefresh") ? contextRefreshCopy(p.contextRefresh) : undefined;
      const verify = method<(binding: StandingHistoryAnalysisNativeBinding) => Promise<unknown>>(value, "verifyOwnerSettled");
      if (!ref(workRef, "hwork")) return fail("input"); live(); if (projections >= 8) return fail("busy"); projections++;
      const result = projectionChain.then(async () => {
        const validate = () => {
          const selected = located(workRef), { wave, work, ordinal } = selected;
          if (wave !== waves.at(-1) || wave.works[ordinal] !== work || work.output || work.projection || work.node) return fail("consumed");
          if (successorDebit(work) >= 3 || eventCount + 5 > MAX_EVENTS) return fail("limit");
          const plan = successorPlan(work.plan, nativeBinding, contextRefresh);
          if (allWorks().some(w => w.plan.nativeBinding.requestRef === plan.nativeBinding.requestRef) || work.plan.nativeBinding.epochId === plan.nativeBinding.epochId ||
              [...archived.values()].some(entry => entry.wave === wave && entry.ordinal === ordinal && entry.work.plan.nativeBinding.epochId === plan.nativeBinding.epochId)) return fail("binding");
          return selected;
        };
        const selection = await operation(async () => { await ready(); return validate(); });
        // Joining the old owner may require sibling callbacks to append first.
        const proof = settlement(await verify(selection.work.plan.nativeBinding), selection.work.plan.nativeBinding);
        return operation(async () => {
          await ready(); const { wave, work, ordinal } = validate(); if (work !== selection.work) return fail("conflict");
          const current = await heads(), projected = wave.works.filter(w => w.node), expectedHead = projected.at(-1)?.node?.hash ?? wave.expectedHead;
          if (current.sourceHead !== wave.sourceHead || current.expectedHead !== expectedHead || current.nodeCount !== wave.nodeCount + projected.length) return fail("conflict");
          await ready(); if (!equal(current, await heads())) return fail("conflict");
          const successorWorkRef = "hwork_" + randomBytes(24).toString("hex");
          await append({ kind: contextRefresh ? "no-output-successor-v2" : "no-output-successor-v1", workRef, successorWorkRef, nativeBinding, reason: successorReason(work),
            sourceHead: current.sourceHead, currentAnalysisHead: current.expectedHead, currentNodeCount: current.nodeCount,
            lineage: { predecessorWorkRefs: [...ancestors(wave, ordinal).map(w => w.workRef), workRef], consecutiveNoOutput: successorDebit(work) }, settlement: proof,
            ...(contextRefresh ? { contextRefresh } : {}) });
          fresh.delete(workRef); fresh.add(successorWorkRef);
          return snapshot({ waveRef: wave.waveRef, workRef: successorWorkRef });
        });
      });
      projectionChain = result.catch(() => {}).finally(() => { projections--; }); return result;
    },
    async prepare(value) {
      const p = data(value, ["workRef", "output", "shownSupports"]), output = snapshotStandingHistoryAnalysisOutput(p.output), shownSupports = supportsCopy(p.shownSupports), workRef = p.workRef;
      return operation(async () => {
        await ready(); const { wave, work, ordinal } = located(workRef); if (wave.works[ordinal] !== work || !fresh.has(work.workRef) || work.output || work.outcome === "refused" || work.outcome === "unknown") return fail("consumed");
        const permitted = new Set(work.allowed.map(supportKey)); if (shownSupports.some(s => !permitted.has(supportKey(s)))) return fail("support");
        try { validateStandingHistoryShownOutput(output, shownSupports); } catch { return fail("support"); }
        await append({ kind: "prepared", workRef, output, shownSupports }); fresh.delete(work.workRef);
      });
    },
    async recordModelOutcome(value) {
      const p = data(value, ["workRef", "outcome"]), workRef = p.workRef, outcome = p.outcome; if (!["observed", "refused", "unknown"].includes(outcome as string)) return fail("input");
      return operation(async () => { await ready(); const { wave, work, ordinal } = located(workRef); if (work.outcome) { if (work.outcome !== outcome) return fail("conflict"); return; }
        if (wave.works[ordinal] !== work) return fail("consumed");
        if (outcome === "refused" && work.output) return fail("conflict"); await append({ kind: "native", workRef, outcome }); });
    },
    readWork: workRef => operation(async () => { await ready(); const { wave, work, ordinal } = located(workRef); return snapshot({ workRef: work.workRef, waveRef: wave.waveRef, ordinal, sourceHead: wave.sourceHead,
      baseAnalysisHead: wave.expectedHead, baseNodeCount: wave.nodeCount, plan: work.plan, modelReplayAllowed: false, ...(work.output ? { output: work.output } : {}), ...(work.outcome ? { modelOutcome: work.outcome } : {}),
      consecutiveNoOutput: noOutputCount(work),
      noOutputClassification: work.output ? "output-present" : work.outcome === undefined ? "missing-outcome" : work.outcome + "-no-output" as "observed-no-output" | "refused-no-output" | "unknown-no-output",
      ...(work.projection ? { projection: work.projection } : {}), ...(work.node ? { node: work.node } : {}) }); }),
    async projectNext(value) {
      const p = data(value, ["waveRef"], ["verifyOwnerSettled", "verifyWorkReleased"]), waveRef = p.waveRef, warm = Object.hasOwn(p, "verifyWorkReleased");
      if (warm === Object.hasOwn(p, "verifyOwnerSettled")) return fail("input");
      const verify = method<(binding: StandingHistoryAnalysisNativeBinding, workRef: string) => Promise<unknown>>(value, warm ? "verifyWorkReleased" : "verifyOwnerSettled");
      if (!ref(waveRef, "hwave")) return fail("input"); live(); if (projections >= 8) return fail("busy"); projections++;
      const result = projectionChain.then(async () => {
        const selection = await operation(async () => {
          await ready(); const wave = waves.find(w => w.waveRef === waveRef); if (!wave) return fail("binding");
          const ordinal = wave.works.findIndex(w => !w.node); if (ordinal < 0) return undefined; const work = wave.works[ordinal]!;
          if (!work.output || !work.outcome || work.outcome === "refused") return fail("consumed"); return { wave, work, ordinal };
        });
        if (!selection) return Object.freeze({ kind: "complete" as const }); const { wave, work, ordinal } = selection;
        // Owner settlement may depend on another worker receiving its prepare
        // acknowledgement. Never hold the journal lane while awaiting it.
        const proof = snapshot(await verify(work.plan.nativeBinding, work.workRef));
        if (warm) {
          const released = data(proof, ["schema", "nativeBinding", "workRef", "releaseAcknowledged", "callbacksJoined"]);
          if (released.schema !== "standing-analysis-work-release-v1" || !equal(released.nativeBinding, work.plan.nativeBinding) || released.workRef !== work.workRef || released.releaseAcknowledged !== true || released.callbacksJoined !== true) return fail("settlement");
        } else {
          const settlement = data(proof, ["schema", "nativeBinding", "resourcesSettled", "persisted", "replacementReady", "modelOutcome"]);
          if (settlement.schema !== "standing-analysis-owner-settlement-v1" || !equal(settlement.nativeBinding, work.plan.nativeBinding) || settlement.resourcesSettled !== true || settlement.persisted !== true || settlement.replacementReady !== true || settlement.modelOutcome !== "not-proven") return fail("settlement");
        }
        return operation(async () => {
        if (wave.works.findIndex(w => !w.node) !== ordinal || !work.output || !work.outcome || work.outcome === "refused") return fail("conflict");
        await ready(); const expectedHead = ordinal === 0 ? wave.expectedHead : wave.works[ordinal - 1]!.node!.hash, nodeIndex = wave.nodeCount + ordinal + 1;
        const current = await heads(); if (current.sourceHead !== wave.sourceHead) return fail("conflict");
        if (!work.projection) { if (current.expectedHead !== expectedHead || current.nodeCount !== nodeIndex - 1) return fail("conflict"); await append({ kind: "projection", workRef: work.workRef, expectedHead, nodeIndex, outputHash: hash(work.output) }); }
        let node = snapshot(await readNodeAt(nodeIndex)); live();
        if (!node) {
          if (current.expectedHead !== expectedHead || current.nodeCount !== nodeIndex - 1) return fail("conflict");
          // Projection intent is durable before append. An uncertain append is
          // reconciled by exact node index on reopen, never by model replay.
          try { const returned = work.plan.kind === "leaf" ? await appendLeaf({ expectedHead, inputs: work.plan.inputs, output: work.output }) : await appendMerge({ expectedHead, children: work.plan.children, output: work.output });
            verifyNode(returned, work); node = snapshot(await readNodeAt(nodeIndex)); live(); if (!node) return fail("storage");
          } catch (error) { tail = true; throw error; }
        }
        const proof = verifyNode(node, work);
        if (nodeIndex > 1) {
          // The previous node may be a legacy merge with large expanded
          // coverage. The authenticated reader owns its body; this check needs
          // only inert scalar head metadata, not a bounded clone of that body.
          const previous = await readNodeAt(nodeIndex - 1); live(); if (!previous) return fail("binding");
          const metadata = data(previous, ["nodeRef", "kind", "index", "hash", "inputs", "coverage", "output"]);
          if (metadata.index !== nodeIndex - 1 || !digest(metadata.hash) || metadata.hash !== expectedHead) return fail("binding");
        }
        const after = await heads(); if (after.sourceHead !== wave.sourceHead || after.nodeCount !== nodeIndex || after.expectedHead !== proof.hash) return fail("conflict");
        await ready(); await append({ kind: "node", workRef: work.workRef, evidence: proof }); return snapshot({ kind: "projected" as const, workRef: work.workRef, node: proof });
        });
      });
      projectionChain = result.catch(() => {}).finally(() => { projections--; }); return result;
    },
    status: () => operation(async () => { if (!tail) { try { await ready(); } catch { live(); tail = true; } } return state(); }),
    close: async () => { closed = true; await Promise.all([chain, projectionChain]); passphrase = ""; fresh.clear(); waves.length = 0; archived.clear(); }
  });
}
