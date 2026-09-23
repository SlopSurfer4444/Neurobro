import { createHash, createHmac, randomBytes } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent, type StandingHistoryStoredPage } from "./standing-history-task-store.js";
import { projectStandingHistorySource, type StandingHistorySourceFragment } from "./standing-history-source-projection.js";
import { MATERIAL_BYTES, MAX_FRAGMENTS, MAX_ANALYSIS_NODES, MAX_SUPPORTS, SUMMARY_BYTES, MAX_CLAIMS, NODE_PLAIN_BYTES, NODE_CIPHER_BYTES } from "./standing-history-analysis-limits.js";

export type StandingHistoryAnalysisSupport = Readonly<{ sourceRef: string; versionRef: string }>;
export type StandingHistoryAnalysisOutput = Readonly<{ summary: string; claims: readonly Readonly<{
  kind: "reported" | "decision" | "open-question" | "inference"; text: string; supports: readonly StandingHistoryAnalysisSupport[];
}>[]; omittedDetailCount?: number }>;
export type StandingHistoryAnalysisMaterialRequest = Readonly<{ pageIndex: number; position?: string; maxBytes: number; maxRows?: number; materialRef: string }>;
export type StandingHistoryAnalysisSpan = Readonly<{ materialRef: string; pageIndex: number; pageHash: string;
  range: StandingHistorySourceFragment["range"]; coverage: StandingHistorySourceFragment["coverage"] }>;
export type StandingHistoryAnalysisMaterial = StandingHistoryAnalysisMaterialRequest & StandingHistoryAnalysisSpan & Readonly<{ supports: readonly StandingHistoryAnalysisSupport[] }>;
export type StandingHistoryAnalysisNode = Readonly<{ nodeRef: string; kind: "leaf" | "merge"; index: number; hash: string;
  inputs: Readonly<{ materials: readonly StandingHistoryAnalysisMaterial[] }> | Readonly<{ children: readonly string[] }>;
  coverage: readonly StandingHistoryAnalysisSpan[]; output: StandingHistoryAnalysisOutput }>;
export type StandingHistoryAnalysisStatus = Readonly<{ storage: "ready" | "tail-refused"; headHash: string; analysisNodes: number; leafNodes: number;
  claims: "model-authored-unverified"; limits: Readonly<{ maximumNodes: number; maximumNodeBytes: number; maximumCiphertextBytes: number; nodeQuotaReached: boolean }> }>;
export type StandingHistoryAnalysisStore = Readonly<{
  /** Host-private projection capability. Never expose to model/tool output. */
  referenceKey(): string;
  appendLeaf(input: Readonly<{ expectedHead: string; inputs: readonly StandingHistoryAnalysisMaterialRequest[]; output: StandingHistoryAnalysisOutput }>): Promise<StandingHistoryAnalysisNode>;
  appendMerge(input: Readonly<{ expectedHead: string; children: readonly string[]; output: StandingHistoryAnalysisOutput }>): Promise<StandingHistoryAnalysisNode>;
  readNode(nodeRef: string): Promise<StandingHistoryAnalysisNode | undefined>;
  /** Host-private bounded discovery after restart; index is one-based. */
  readNodeAt(index: number): Promise<StandingHistoryAnalysisNode | undefined>;
  status(): Promise<StandingHistoryAnalysisStatus>;
  close(): Promise<void>;
}>;
export class StandingHistoryAnalysisStoreError extends Error {
  constructor(readonly code: "input" | "binding" | "consumed" | "conflict" | "overlap" | "support" | "tail" | "limit" | "storage" | "busy" | "closed" | "aborted") {
    super("STANDING_HISTORY_ANALYSIS_" + code.toUpperCase()); this.name = "StandingHistoryAnalysisStoreError";
  }
}
const fail = (code: StandingHistoryAnalysisStoreError["code"]): never => { throw new StandingHistoryAnalysisStoreError(code); };
const DOMAIN = "DecadansNeurobro/standing-history-analysis/v1", MAX_NODES = MAX_ANALYSIS_NODES, MAX_NODE = NODE_PLAIN_BYTES, MAX_CIPHER = NODE_CIPHER_BYTES;
const refValid = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp("^" + prefix + "_[0-9a-f]{48}$", "u").test(v);
const digestValid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
const textValid = (v: unknown, maximum: number): v is string => typeof v === "string" && v.trim().length > 0 && !v.includes("\0") && Buffer.byteLength(v) <= maximum && Buffer.from(v).toString("utf8") === v;
const version = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function array(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!value || types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
  if (length < minimum || length > maximum || Reflect.ownKeys(ds).length !== length + 1) return fail("input");
  const result: unknown[] = [];
  for (let n = 0; n < length; n++) { const d = ds[String(n)]; if (!d || !("value" in d)) return fail("input"); result.push(d.value); }
  return result;
}
const supportKey = (s: StandingHistoryAnalysisSupport) => s.sourceRef + ":" + s.versionRef;
export function snapshotStandingHistoryAnalysisOutput(value: unknown): StandingHistoryAnalysisOutput {
  const v = data(value, ["summary", "claims"], ["omittedDetailCount"]);
  if (!textValid(v.summary, SUMMARY_BYTES) || Object.hasOwn(v, "omittedDetailCount") && (!Number.isSafeInteger(v.omittedDetailCount) || Number(v.omittedDetailCount) < 0)) return fail("input");
  const claims = array(v.claims, MAX_CLAIMS).map(value => {
    const c = data(value, ["kind", "text", "supports"]);
    if (!["reported", "decision", "open-question", "inference"].includes(c.kind as string) || !textValid(c.text, 1024)) return fail("input");
    const supports = array(c.supports, 16, 1).map(value => {
      const s = data(value, ["sourceRef", "versionRef"]); if (!refValid(s.sourceRef, "hsrc") || !refValid(s.versionRef, "hver")) return fail("input");
      return Object.freeze({ sourceRef: s.sourceRef, versionRef: s.versionRef });
    });
    if (new Set(supports.map(supportKey)).size !== supports.length) return fail("input");
    return Object.freeze({ kind: c.kind as StandingHistoryAnalysisOutput["claims"][number]["kind"], text: c.text, supports: Object.freeze(supports) });
  });
  return Object.freeze({ summary: v.summary, claims: Object.freeze(claims), ...(Object.hasOwn(v, "omittedDetailCount") ? { omittedDetailCount: v.omittedDetailCount as number } : {}) });
}
/** Additional host admission check for the exact material shown in one model
 * attempt. The host owns this list; it must never come from model arguments.
 * Store membership alone includes notes omitted by bounded views. This check
 * does not authenticate the list, prove semantic truth or grant a commit/retry.
 * The support bound covers admitted large source packets and bounded note reads.
 */
export function validateStandingHistoryShownOutput(value: unknown, shown: readonly StandingHistoryAnalysisSupport[]): StandingHistoryAnalysisOutput {
  const output = snapshotStandingHistoryAnalysisOutput(value);
  const allowed = new Set(array(shown, MAX_SUPPORTS).map(value => {
    const support = data(value, ["sourceRef", "versionRef"]);
    if (!refValid(support.sourceRef, "hsrc") || !refValid(support.versionRef, "hver")) return fail("input");
    return support.sourceRef + ":" + support.versionRef;
  }));
  if (output.claims.some(claim => claim.supports.some(support => !allowed.has(supportKey(support))))) return fail("support");
  return output;
}
function materialCopy(value: unknown): StandingHistoryAnalysisMaterialRequest {
  const m = data(value, ["pageIndex", "maxBytes", "materialRef"], ["position", "maxRows"]);
  if (!Number.isInteger(m.pageIndex) || Number(m.pageIndex) < 1 || Number(m.pageIndex) > 1024 || !Number.isInteger(m.maxBytes) || Number(m.maxBytes) < 1024 || Number(m.maxBytes) > MATERIAL_BYTES ||
      Object.hasOwn(m, "maxRows") && (!Number.isInteger(m.maxRows) || Number(m.maxRows) < 1 || Number(m.maxRows) > 100) ||
      !refValid(m.materialRef, "hmat") || Object.hasOwn(m, "position") && (typeof m.position !== "string" || !/^hpos_(?:0|[1-9]\d{0,2})_[0-9a-f]{48}$/u.test(m.position))) return fail("input");
  return Object.freeze({ pageIndex: Number(m.pageIndex), maxBytes: Number(m.maxBytes), materialRef: m.materialRef, ...(Object.hasOwn(m, "position") ? { position: m.position as string } : {}),
    ...(Object.hasOwn(m, "maxRows") ? { maxRows: m.maxRows as number } : {}) });
}
function materialsCopy(value: unknown) {
  const inputs = array(value, MAX_FRAGMENTS, 1).map(materialCopy);
  if (new Set(inputs.map(i => i.materialRef)).size !== inputs.length) return fail("overlap"); return Object.freeze(inputs);
}
function childrenCopy(value: unknown): readonly string[] {
  const children = array(value, MAX_ANALYSIS_NODES, 1); if (children.some(c => !refValid(c, "hnode"))) return fail("input");
  if (new Set(children).size !== children.length) return fail("overlap"); return Object.freeze(children as string[]);
}
function overlap(a: StandingHistoryAnalysisSpan, b: StandingHistoryAnalysisSpan): boolean {
  if (a.pageIndex !== b.pageIndex) return false;
  if (a.pageHash !== b.pageHash || a.range.totalRows !== b.range.totalRows) return fail("binding");
  return a.materialRef === b.materialRef || a.range.totalRows === 0 || Math.max(a.range.fromRow, b.range.fromRow) < Math.min(a.range.toRow, b.range.toRow);
}
function noOverlap(spans: readonly StandingHistoryAnalysisSpan[], prior: readonly StandingHistoryAnalysisSpan[] = []) {
  for (let i = 0; i < spans.length; i++) {
    if (prior.some(p => overlap(spans[i]!, p))) return fail("overlap");
    for (let j = 0; j < i; j++) if (overlap(spans[i]!, spans[j]!)) return fail("overlap");
  }
}
type CoverageCommitment = Readonly<{ schema: "standing-history-analysis-coverage-v1"; spanCount: number; sourceRows: number; emptyPageMarkers: number; commitment: string }>;
type NodeBody = Omit<StandingHistoryAnalysisNode, "hash" | "coverage"> & Readonly<{ coverage: readonly StandingHistoryAnalysisSpan[] | CoverageCommitment }>;
function coverageCommitment(spans: readonly StandingHistoryAnalysisSpan[]): CoverageCommitment {
  // Full metadata lives once on leaf nodes. A merge persists only this fixed
  // commitment and its bounded child references; expansion is host-private.
  return Object.freeze({ schema: "standing-history-analysis-coverage-v1", spanCount: spans.length,
    sourceRows: spans.reduce((count, s) => count + s.range.toRow - s.range.fromRow, 0), emptyPageMarkers: spans.filter(s => s.range.totalRows === 0).length,
    commitment: hash(spans) });
}

/** Separate analysis/<taskId> custody. Source pages remain unchanged. This is a
 * commit-only ledger, not an invocation reservation or model retry authority.
 * Inputs and output share one encrypted immutable commit. A model's claims,
 * kinds, summary and omitted count remain unverified; supports prove membership
 * in the admitted input, not semantic entailment. Retained children and coverage
 * allow a later planner to compute progress; this store never declares analysis
 * or delivery complete. File sync/readback is checked; power-loss directory
 * atomicity and full-period capacity are not promised. */
export async function openStandingHistoryAnalysisStore(input: Readonly<{
  directory: string; passphrase: string; intent: StandingHistoryTaskIntent; mode: "create" | "open";
  readSourcePage: (index: number) => Promise<StandingHistoryStoredPage | undefined>; signal?: AbortSignal;
}>): Promise<StandingHistoryAnalysisStore> {
  const args = data(input, ["directory", "passphrase", "intent", "mode", "readSourcePage"], ["signal"]), intent = snapshotStandingHistoryTaskIntent(args.intent);
  if (typeof args.directory !== "string" || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory || !textValid(args.passphrase, 4096) || args.passphrase.length < 16 ||
      !["create", "open"].includes(args.mode as string) || typeof args.readSourcePage !== "function" || types.isProxy(args.readSourcePage) ||
      Object.hasOwn(args, "signal") && (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal))) return fail("input");
  const directory = args.directory, slot = join(directory, intent.taskId), source = args.readSourcePage as (index: number) => Promise<StandingHistoryStoredPage | undefined>, signal = args.signal as AbortSignal | undefined;
  let passphrase = args.passphrase, referenceKey = "", closed = false, tail = false, active: Promise<unknown> | undefined, headerHash = "", headHash = "";
  const nodes: StandingHistoryAnalysisNode[] = [], byRef = new Map<string, StandingHistoryAnalysisNode>(), corpus: StandingHistoryAnalysisSpan[] = [], versions = new Map<string, string>();
  const live = () => { if (closed) return fail("closed"); if (signal?.aborted) return fail("aborted"); };
  live(); await assertPilotPrivateDirectory(directory); const root = await lstat(directory, { bigint: true });
  if (args.mode === "create") { live(); try { await mkdir(slot, { mode: 0o700 }); } catch (e) { return fail((e as NodeJS.ErrnoException).code === "EEXIST" ? "consumed" : "storage"); } }
  await assertPilotPrivateDirectory(slot); const owner = await lstat(slot, { bigint: true });
  const check = async (known = false) => {
    live(); await assertPilotPrivateDirectory(directory); await assertPilotPrivateDirectory(slot);
    if (!sameDirectory(root, await lstat(directory, { bigint: true })) || !sameDirectory(owner, await lstat(slot, { bigint: true }))) return fail("storage");
    if (known) for (const [name, expected] of versions) { live(); const s = await lstat(join(slot, name), { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || version(s) !== expected) return fail("storage"); }
    live();
  };
  const filename = (n: number) => "node-" + String(n).padStart(6, "0") + ".enc";
  const read = async (name: string): Promise<{ value: unknown; stamp: string }> => {
    await check(); const path = join(slot, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true }); if (!inside.isFile() || version(inside) !== version(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { live(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size)) return fail("storage");
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); if (Buffer.byteLength(plain) > MAX_NODE) return fail("limit");
      const value: unknown = JSON.parse(plain);
      const after = await lstat(path, { bigint: true }); if (!after.isFile() || after.isSymbolicLink() || version(after) !== version(before)) return fail("storage");
      await check(); return { value, stamp: version(after) };
    } finally { bytes?.fill(0); await file.close(); }
  };
  const write = async (name: string, value: unknown): Promise<string> => {
    const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > MAX_NODE) return fail("limit");
    await check(); const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("limit"); await check();
    const file = await open(join(slot, name), "wx", 0o600); try { await file.writeFile(cipher); await file.sync(); } finally { await file.close(); }
    const saved = await read(name); if (!equal(saved.value, value)) return fail("storage"); return saved.stamp;
  };
  const inventory = async (): Promise<Set<string>> => {
    await check(); const dir = await opendir(slot, { bufferSize: 1 }), names = new Set<string>();
    try { for (;;) { live(); const e = await dir.read(); if (!e) break; if (names.size >= MAX_NODES + 1 || !e.isFile() || e.isSymbolicLink() || e.name !== "intent.enc" && !/^node-\d{6}\.enc$/u.test(e.name)) return fail("tail"); names.add(e.name); } }
    finally { await dir.close(); } await check(); return names;
  };
  const pinMaterial = async (request: StandingHistoryAnalysisMaterialRequest): Promise<StandingHistoryAnalysisMaterial> => {
    live(); const page = await source(request.pageIndex); live(); if (!page) return fail("binding");
    // Projector snapshots the callback result before subsequent I/O. The callback
    // is a trusted host capability for an authenticated exact task-store read.
    const fragment = projectStandingHistorySource({ intent, referenceKey, storedPage: page, maxBytes: request.maxBytes, ...(request.position ? { position: request.position } : {}),
      ...(request.maxRows === undefined ? {} : { maxRows: request.maxRows }) });
    if (fragment.pageIndex !== request.pageIndex || fragment.materialRef !== request.materialRef) return fail("binding");
    const supports = fragment.rows.filter(row => row.disposition === "included").map(row => Object.freeze({ sourceRef: row.sourceRef, versionRef: row.versionRef }));
    return Object.freeze({ ...request, pageHash: fragment.pageHash, range: fragment.range, coverage: fragment.coverage, supports: Object.freeze(supports) });
  };
  const spanOf = (m: StandingHistoryAnalysisMaterial): StandingHistoryAnalysisSpan => Object.freeze({ materialRef: m.materialRef, pageIndex: m.pageIndex, pageHash: m.pageHash, range: m.range, coverage: m.coverage });
  const construct = async (kind: "leaf" | "merge", requests: readonly StandingHistoryAnalysisMaterialRequest[] | readonly string[], output: StandingHistoryAnalysisOutput): Promise<NodeBody> => {
    let inputs: NodeBody["inputs"], coverage: readonly StandingHistoryAnalysisSpan[], allowed: Set<string>;
    if (kind === "leaf") {
      const materials: StandingHistoryAnalysisMaterial[] = [];
      for (const request of requests as readonly StandingHistoryAnalysisMaterialRequest[]) materials.push(await pinMaterial(request));
      coverage = Object.freeze(materials.map(spanOf)); noOverlap(coverage, corpus);
      inputs = Object.freeze({ materials: Object.freeze(materials) }); allowed = new Set(materials.flatMap(m => m.supports.map(supportKey)));
    } else {
      const children = requests as readonly string[], selected = children.map(ref => { const node = byRef.get(ref); if (!node) return fail("binding"); return node; });
      coverage = Object.freeze(selected.flatMap(n => n.coverage)); noOverlap(coverage);
      inputs = Object.freeze({ children }); allowed = new Set(selected.flatMap(n => n.output.claims.flatMap(c => c.supports.map(supportKey))));
    }
    if (output.claims.some(c => c.supports.some(s => !allowed.has(supportKey(s))))) return fail("support");
    const base = { kind, index: nodes.length + 1, inputs, coverage: kind === "leaf" ? coverage : coverageCommitment(coverage), output }, key = Buffer.from(referenceKey, "hex");
    let nodeRef: string;
    try { nodeRef = "hnode_" + createHmac("sha256", key).update(canonical([DOMAIN, intent.taskId, headerHash, headHash, base])).digest("hex").slice(0, 48); }
    finally { key.fill(0); }
    const node = Object.freeze({ nodeRef, ...base }); if (Buffer.byteLength(JSON.stringify(node)) > MAX_NODE) return fail("limit"); return node;
  };
  const envelope = (node: NodeBody) => ({ domain: DOMAIN, taskId: intent.taskId, kind: "analysis-node", intentHash: headerHash, index: node.index, previousHash: headHash, node });
  const admit = (body: NodeBody, value: unknown): StandingHistoryAnalysisNode => {
    const coverage = body.kind === "leaf" ? body.coverage as readonly StandingHistoryAnalysisSpan[]
      : Object.freeze((body.inputs as Readonly<{ children: readonly string[] }>).children.flatMap(ref => byRef.get(ref)!.coverage));
    const node = Object.freeze({ ...body, coverage, hash: hash(value) }); nodes.push(node); byRef.set(node.nodeRef, node); headHash = node.hash;
    if (node.kind === "leaf") corpus.push(...node.coverage); return node;
  };
  const decode = async (value: unknown): Promise<NodeBody> => {
    const e = data(value, ["domain", "taskId", "kind", "intentHash", "index", "previousHash", "node"]);
    if (e.domain !== DOMAIN || e.taskId !== intent.taskId || e.kind !== "analysis-node" || e.intentHash !== headerHash || e.index !== nodes.length + 1 || e.previousHash !== headHash) return fail("binding");
    const n = data(e.node, ["nodeRef", "kind", "index", "inputs", "coverage", "output"]), output = snapshotStandingHistoryAnalysisOutput(n.output);
    if (n.index !== e.index || !refValid(n.nodeRef, "hnode") || !["leaf", "merge"].includes(n.kind as string)) return fail("binding");
    let requests: readonly StandingHistoryAnalysisMaterialRequest[] | readonly string[];
    if (n.kind === "leaf") {
      const input = data(n.inputs, ["materials"]), materials = array(input.materials, MAX_FRAGMENTS, 1);
      requests = Object.freeze(materials.map(value => {
        const m = data(value, ["pageIndex", "maxBytes", "materialRef", "pageHash", "range", "coverage", "supports"], ["position", "maxRows"]);
        return materialCopy({ pageIndex: m.pageIndex, maxBytes: m.maxBytes, materialRef: m.materialRef, ...(Object.hasOwn(m, "position") ? { position: m.position } : {}),
          ...(Object.hasOwn(m, "maxRows") ? { maxRows: m.maxRows } : {}) });
      }));
    } else requests = childrenCopy(data(n.inputs, ["children"]).children);
    const body = await construct(n.kind as "leaf" | "merge", requests, output);
    if (!equal(body, n)) return fail("binding"); return body;
  };
  const status = (): StandingHistoryAnalysisStatus => Object.freeze({ storage: tail ? "tail-refused" : "ready", headHash, analysisNodes: nodes.length,
    leafNodes: nodes.filter(n => n.kind === "leaf").length, claims: "model-authored-unverified", limits: Object.freeze({ maximumNodes: MAX_NODES, maximumNodeBytes: MAX_NODE, maximumCiphertextBytes: MAX_CIPHER, nodeQuotaReached: nodes.length >= MAX_NODES }) });
  try {
    if (args.mode === "create") {
      referenceKey = randomBytes(32).toString("hex");
      const header = { domain: DOMAIN, taskId: intent.taskId, kind: "analysis-intent", intent, referenceKey };
      versions.set("intent.enc", await write("intent.enc", header)); headerHash = hash(header); headHash = headerHash;
    } else {
      const saved = await read("intent.enc"), header = data(saved.value, ["domain", "taskId", "kind", "intent", "referenceKey"]);
      if (header.domain !== DOMAIN || header.taskId !== intent.taskId || header.kind !== "analysis-intent" || !equal(snapshotStandingHistoryTaskIntent(header.intent), intent) || !digestValid(header.referenceKey)) return fail("binding");
      referenceKey = header.referenceKey; headerHash = hash({ domain: DOMAIN, taskId: intent.taskId, kind: "analysis-intent", intent, referenceKey }); headHash = headerHash; versions.set("intent.enc", saved.stamp);
      let names: Set<string> | undefined;
      try { names = await inventory(); } catch (e) { live(); if (!(e instanceof StandingHistoryAnalysisStoreError) || e.code !== "tail") throw e; tail = true; }
      for (let index = 1; index <= MAX_NODES; index++) {
        if (names && !names.has(filename(index))) { if (names.size !== index) tail = true; break; }
        try { const saved = await read(filename(index)), body = await decode(saved.value); versions.set(filename(index), saved.stamp); admit(body, envelope(body)); }
        catch (e) { live(); if ((e as NodeJS.ErrnoException)?.code !== "ENOENT" || names?.has(filename(index))) tail = true; break; }
      }
    }
    await check(true);
  } catch (e) { referenceKey = ""; passphrase = ""; if (e instanceof StandingHistoryAnalysisStoreError) throw e; return fail("storage"); }
  const operation = async <T>(work: () => Promise<T>): Promise<T> => {
    live(); if (active) return fail("busy"); const pending = Promise.resolve().then(async () => { await check(true); return work(); }); active = pending;
    try { return await pending; } catch (e) { if (e instanceof StandingHistoryAnalysisStoreError) throw e; return fail("storage"); } finally { if (active === pending) active = undefined; }
  };
  const append = async (expectedHead: string, kind: "leaf" | "merge", requests: readonly StandingHistoryAnalysisMaterialRequest[] | readonly string[], output: StandingHistoryAnalysisOutput) => operation(async () => {
    if (tail) return fail("tail"); if (nodes.length >= MAX_NODES) return fail("limit"); if (expectedHead !== headHash) return fail("conflict");
    let names: Set<string>; try { names = await inventory(); } catch { tail = true; return fail("tail"); }
    if (names.size !== nodes.length + 1 || !names.has("intent.enc") || nodes.some((_, i) => !names.has(filename(i + 1)))) { tail = true; return fail("tail"); }
    const body = await construct(kind, requests, output), record = envelope(body);
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_NODE) return fail("limit");
    try { const stamp = await write(filename(body.index), record); await check(true); versions.set(filename(body.index), stamp); return admit(body, record); }
    catch (e) { tail = true; throw e; }
  });
  const readVerifiedNode = async (node: StandingHistoryAnalysisNode | undefined): Promise<StandingHistoryAnalysisNode | undefined> => {
    if (!node) return undefined;
    const saved = await read(filename(node.index)); if (hash(saved.value) !== node.hash) return fail("storage"); return node;
  };
  return Object.freeze<StandingHistoryAnalysisStore>({
    referenceKey() { live(); return referenceKey; },
    async appendLeaf(value) {
      const request = data(value, ["expectedHead", "inputs", "output"]); if (!digestValid(request.expectedHead)) return fail("input");
      const inputs = materialsCopy(request.inputs), output = snapshotStandingHistoryAnalysisOutput(request.output); return append(request.expectedHead, "leaf", inputs, output);
    },
    async appendMerge(value) {
      const request = data(value, ["expectedHead", "children", "output"]); if (!digestValid(request.expectedHead)) return fail("input");
      const children = childrenCopy(request.children), output = snapshotStandingHistoryAnalysisOutput(request.output); return append(request.expectedHead, "merge", children, output);
    },
    readNode(nodeRef) {
      if (!refValid(nodeRef, "hnode")) return Promise.reject(new StandingHistoryAnalysisStoreError("input"));
      return operation(() => readVerifiedNode(byRef.get(nodeRef)));
    },
    readNodeAt(index) {
      if (!Number.isSafeInteger(index) || index < 1 || index > MAX_NODES) return Promise.reject(new StandingHistoryAnalysisStoreError("input"));
      return operation(() => readVerifiedNode(nodes[index - 1]));
    },
    status: () => operation(async () => status()),
    async close() { closed = true; try { await active; } catch { /* Join filesystem and trusted source-read work. */ } finally { passphrase = ""; referenceKey = ""; } },
  });
}
