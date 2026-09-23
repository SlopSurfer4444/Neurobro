import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import { snapshotStandingHistoryAnalysisOutput, type StandingHistoryAnalysisMaterialRequest, type StandingHistoryAnalysisStore, type StandingHistoryAnalysisNode } from "./standing-history-analysis-store.js";
import type { StandingHistoryAnalysisNodeEvidence } from "./standing-history-analysis-attempt-store.js";
import type { StandingHistoryChronicleHit } from "./standing-history-chronicle-cache.js";
import { MATERIAL_BYTES, MAX_FRAGMENTS, MAX_SUPPORTS, NODE_PLAIN_BYTES, NODE_CIPHER_BYTES } from "./standing-history-analysis-limits.js";

export type StandingHistoryChronicleReusePlan = Readonly<{ sourceHead: string; expectedHead: string; nodeIndex: number;
  inputs: readonly StandingHistoryAnalysisMaterialRequest[]; hit: StandingHistoryChronicleHit }>;
export type StandingHistoryChronicleReuseStatus = Readonly<{ storage: "ready" | "tail-refused"; reuses: number; modelInvocation: "none";
  last?: Readonly<{ reuseRef: string; sourceHead: string; expectedHead: string; nodeIndex: number; node?: StandingHistoryAnalysisNodeEvidence }> }>;
export type StandingHistoryChronicleReuseStore = Readonly<{
  status(): Promise<StandingHistoryChronicleReuseStatus>;
  prepare(plan: StandingHistoryChronicleReusePlan): Promise<Readonly<{ reuseRef: string }>>;
  readPrepared(reuseRef: string): Promise<StandingHistoryChronicleReusePlan>;
  commitPrepared(input: Readonly<{ reuseRef: string }>): Promise<StandingHistoryAnalysisNodeEvidence>;
  close(): Promise<void>;
}>;
export class StandingHistoryChronicleReuseStoreError extends Error {
  constructor(readonly code: "input" | "binding" | "conflict" | "consumed" | "storage" | "tail" | "busy" | "closed" | "limit") { super("STANDING_HISTORY_CHRONICLE_REUSE_" + code.toUpperCase()); }
}
const fail = (code: StandingHistoryChronicleReuseStoreError["code"]): never => { throw new StandingHistoryChronicleReuseStoreError(code); };
const DOMAIN = "DecadansNeurobro/standing-history-chronicle-reuse/v1", MAX_REUSES = 1024, MAX_PLAIN = NODE_PLAIN_BYTES, MAX_CIPHER = NODE_CIPHER_BYTES;
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const ref = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp("^" + prefix + "_[0-9a-f]{48}$").test(v);
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const canonical = (v: unknown): string => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object"
  ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}" : JSON.stringify(v);
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function data(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, any> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  const out: Record<string, unknown> = {};
  for (const k of keys as string[]) { const d = ds[k]!; if (!("value" in d) || !d.enumerable) return fail("input"); out[k] = d.value; } return out;
}
function array(v: unknown, max: number, min = 0): unknown[] {
  if (!v || types.isProxy(v) || !Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), n = Object.getOwnPropertyDescriptor(v, "length")!.value;
  if (!Number.isInteger(n) || n < min || n > max || Reflect.ownKeys(ds).length !== n + 1) return fail("input");
  return Array.from({ length: n }, (_, i) => { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail("input"); return d.value; });
}
function snapshot<T>(v: T): T {
  let remaining = MAX_PLAIN;
  const copy = (v: unknown, depth: number): any => {
    if (--remaining < 0 || depth > 24) return fail("input");
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") { remaining -= Buffer.byteLength(v); if (remaining < 0 || Buffer.from(v).toString() !== v) return fail("input"); return v; }
    if (Array.isArray(v)) return Object.freeze(array(v, MAX_SUPPORTS).map(v => copy(v, depth + 1)));
    if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
    const out: Record<string, unknown> = {};
    for (const k of Reflect.ownKeys(v)) { if (typeof k !== "string" || ["__proto__", "constructor", "prototype"].includes(k)) return fail("input"); const d = Object.getOwnPropertyDescriptor(v, k)!; if (!("value" in d) || !d.enumerable) return fail("input"); out[k] = copy(d.value, depth + 1); } return Object.freeze(out);
  }; return copy(v, 0);
}
function material(v: unknown): StandingHistoryAnalysisMaterialRequest {
  const m = data(v, ["pageIndex", "maxBytes", "materialRef"], ["position", "maxRows"]);
  if (!Number.isInteger(m.pageIndex) || m.pageIndex < 1 || m.pageIndex > 1024 || !Number.isInteger(m.maxBytes) || m.maxBytes < 1024 || m.maxBytes > MATERIAL_BYTES || !ref(m.materialRef, "hmat") ||
    Object.hasOwn(m, "maxRows") && (!Number.isInteger(m.maxRows) || m.maxRows < 1 || m.maxRows > 100) || Object.hasOwn(m, "position") && (typeof m.position !== "string" || !/^hpos_(?:0|[1-9]\d{0,2})_[0-9a-f]{48}$/.test(m.position))) return fail("input");
  return Object.freeze(m) as StandingHistoryAnalysisMaterialRequest;
}
function planCopy(value: unknown): StandingHistoryChronicleReusePlan {
  const p = data(value, ["sourceHead", "expectedHead", "nodeIndex", "inputs", "hit"]);
  if (!digest(p.sourceHead) || !digest(p.expectedHead) || !Number.isInteger(p.nodeIndex) || p.nodeIndex < 1 || p.nodeIndex > 1024) return fail("input");
  const inputs = Object.freeze(array(p.inputs, MAX_FRAGMENTS, 1).map(material)); if (new Set(inputs.map(m => m.materialRef)).size !== inputs.length) return fail("input");
  const h = data(snapshot(p.hit), ["output", "provenance", "coverage"]), output = snapshotStandingHistoryAnalysisOutput(h.output);
  const provenance = data(h.provenance, ["kind", "claimsStatus", "cacheRef", "contentHash", "producerHash", "originTaskRef", "originNodeRef", "originNodeHash", "capturedAt"]);
  if (provenance.kind !== "reused-analysis" || provenance.claimsStatus !== "model-authored-unverified" || typeof provenance.cacheRef !== "string" || !/^hcache_[0-9a-f]{64}$/.test(provenance.cacheRef) ||
    !digest(provenance.contentHash) || !digest(provenance.producerHash) || !ref(provenance.originTaskRef, "htask") || !ref(provenance.originNodeRef, "hnode") || !digest(provenance.originNodeHash) ||
    !Number.isSafeInteger(provenance.capturedAt) || provenance.capturedAt < 0 || h.coverage.scope !== "selected-material-only") return fail("input");
  const result = snapshot({ sourceHead: p.sourceHead, expectedHead: p.expectedHead, nodeIndex: p.nodeIndex, inputs, hit: { output, provenance, coverage: h.coverage } }) as StandingHistoryChronicleReusePlan;
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PLAIN - 4096) return fail("limit"); return result;
}
function evidence(value: unknown): StandingHistoryAnalysisNodeEvidence {
  const e = data(value, ["nodeRef", "index", "hash"]); if (!ref(e.nodeRef, "hnode") || !Number.isInteger(e.index) || e.index < 1 || e.index > 1024 || !digest(e.hash)) return fail("binding"); return Object.freeze(e) as StandingHistoryAnalysisNodeEvidence;
}
function method<T extends (...args: never[]) => unknown>(v: unknown, name: string): T {
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail("input"); const d = Object.getOwnPropertyDescriptor(v, name);
  if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail("input"); return d.value.bind(v) as T;
}
type Entry = { reuseRef: string; index: number; plan: StandingHistoryChronicleReusePlan; preparedHash: string; node?: StandingHistoryAnalysisNodeEvidence };

/** A dedicated no-model receipt chain. Persist exact output/provenance before
 * append; recover only the exact expected node and prior head after interruption.
 * Existing native attempts are untouched. Caller gates fresh source/control
 * heads, cancellation and absence of unresolved native or reuse work. This store
 * grants neither native admission nor source freshness. No live replay exists.
 * directory is a separate host-owned namespace; task slots are created lazily. */
export async function openStandingHistoryChronicleReuseStore(input: Readonly<{
  directory: string; passphrase: string; intent: StandingHistoryTaskIntent;
  analysis: Pick<StandingHistoryAnalysisStore, "status" | "readNodeAt" | "appendLeaf">;
}>): Promise<StandingHistoryChronicleReuseStore> {
  const a = data(input, ["directory", "passphrase", "intent", "analysis"]), intent = snapshotStandingHistoryTaskIntent(a.intent);
  if (typeof a.directory !== "string" || !isAbsolute(a.directory) || resolve(a.directory) !== a.directory || dirname(a.directory) === a.directory || typeof a.passphrase !== "string" ||
    a.passphrase.length < 16 || Buffer.byteLength(a.passphrase) > 4096 || a.passphrase.includes("\0")) return fail("input");
  const analysisStatus = method<StandingHistoryAnalysisStore["status"]>(a.analysis, "status"), readNodeAt = method<StandingHistoryAnalysisStore["readNodeAt"]>(a.analysis, "readNodeAt"), appendLeaf = method<StandingHistoryAnalysisStore["appendLeaf"]>(a.analysis, "appendLeaf");
  const directory: string = a.directory, parent = dirname(directory), slot = join(directory, intent.taskId), intentHash = hash(intent); let passphrase: string = a.passphrase;
  let root: BigIntStats | undefined, owner: BigIntStats | undefined, closed = false, tail = false, active: Promise<unknown> | undefined;
  const entries: Entry[] = [], versions = new Map<string, string>();
  const dirStat = async (path: string) => { await assertPilotPrivateDirectory(path); const s = await lstat(path, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink()) return fail("storage"); return s; };
  const parentIdentity = await dirStat(parent), live = () => { if (closed) return fail("closed"); };
  try { root = await dirStat(directory); try { owner = await dirStat(slot); } catch (e) { if (!missing(e)) throw e; } } catch (e) { if (!missing(e)) throw e; }
  const absent = async (path: string) => { try { await lstat(path); return fail("storage"); } catch (e) { if (!missing(e)) throw e; } };
  const guard = async (known = true) => {
    if (!same(parentIdentity, await dirStat(parent))) return fail("storage");
    if (root) { if (!same(root, await dirStat(directory))) return fail("storage"); } else await absent(directory);
    if (owner) { if (!same(owner, await dirStat(slot))) return fail("storage"); } else if (root) await absent(slot);
    if (known) for (const [name, expected] of versions) { const s = await lstat(join(slot, name), { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || stamp(s) !== expected) return fail("storage"); }
  };
  const filename = (index: number, kind: "prepared" | "node") => "reuse-" + String(index).padStart(6, "0") + "-" + kind + ".enc";
  const inventory = async () => {
    await guard(); const names = new Set<string>(); if (!owner) return names;
    const listing = await opendir(slot, { bufferSize: 1 });
    try { for (;;) { const entry = await listing.read(); if (!entry) break; if (names.size >= MAX_REUSES * 2 || !entry.isFile() || entry.isSymbolicLink() || !/^reuse-\d{6}-(?:prepared|node)\.enc$/.test(entry.name)) return fail("tail"); names.add(entry.name); } } finally { await listing.close(); }
    await guard(); return names;
  };
  const read = async (name: string): Promise<unknown> => {
    await guard(); const path = join(slot, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const handle = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(before)) return fail("storage"); bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { const got = await handle.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size) || stamp(await handle.stat({ bigint: true })) !== stamp(before) || stamp(await lstat(path, { bigint: true })) !== stamp(before)) return fail("storage");
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
      const value = snapshot(JSON.parse(plain)); await guard(); versions.set(name, stamp(before)); return value;
    } finally { bytes?.fill(0); await handle.close(); }
  };
  const write = async (name: string, value: unknown) => {
    const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit"); await guard();
    const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("limit"); await guard();
    const handle = await open(join(slot, name), "wx", 0o600);
    try { await handle.writeFile(cipher); await handle.sync(); } finally { await handle.close(); }
    if (!equal(await read(name), value)) return fail("storage");
  };
  const preparedEnvelope = (index: number, plan: StandingHistoryChronicleReusePlan, previousHash: string) => ({ domain: DOMAIN, kind: "prepared", intent, intentHash, index, previousHash, plan });
  const nodeEnvelope = (entry: Entry, node: StandingHistoryAnalysisNodeEvidence) => ({ domain: DOMAIN, kind: "node", intentHash, reuseRef: entry.reuseRef, preparedHash: entry.preparedHash, node });
  const entryHash = (entry: Entry) => entry.node ? hash(nodeEnvelope(entry, entry.node)) : entry.preparedHash;
  const status = (): StandingHistoryChronicleReuseStatus => {
    const e = entries.at(-1); return Object.freeze({ storage: tail ? "tail-refused" : "ready", reuses: entries.length, modelInvocation: "none",
      ...(e ? { last: Object.freeze({ reuseRef: e.reuseRef, sourceHead: e.plan.sourceHead, expectedHead: e.plan.expectedHead, nodeIndex: e.plan.nodeIndex, ...(e.node ? { node: e.node } : {}) }) } : {}) });
  };
  try {
    const names = await inventory();
    for (let index = 1; index <= MAX_REUSES && names.size; index++) {
      const name = filename(index, "prepared"); if (!names.delete(name) || entries.length && !entries.at(-1)!.node) return fail("tail");
      const saved = data(await read(name), ["domain", "kind", "intent", "intentHash", "index", "previousHash", "plan"]), plan = planCopy(saved.plan);
      const envelope = preparedEnvelope(index, plan, entries.length ? entryHash(entries.at(-1)!) : intentHash);
      if (!equal(saved, envelope)) return fail("binding");
      const preparedHash = hash(envelope), e: Entry = { index, plan, preparedHash, reuseRef: "hreuse_" + preparedHash.slice(0, 48) };
      if (names.delete(filename(index, "node"))) { const savedNode = data(await read(filename(index, "node")), ["domain", "kind", "intentHash", "reuseRef", "preparedHash", "node"]), n = evidence(savedNode.node);
        if (n.index !== plan.nodeIndex || !equal(savedNode, nodeEnvelope(e, n))) return fail("binding"); e.node = n; }
      entries.push(e);
    }
    if (names.size) return fail("tail");
  } catch { tail = true; }
  const ready = async () => { live(); if (tail) return fail("tail"); await guard(); const names = await inventory();
    if (names.size !== versions.size || [...names].some(n => !versions.has(n))) { tail = true; return fail("tail"); } };
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    live(); if (active) return Promise.reject(new StandingHistoryChronicleReuseStoreError("busy"));
    const operation = Promise.resolve().then(work); active = operation;
    return operation.catch(e => { if (e instanceof StandingHistoryChronicleReuseStoreError) throw e; return fail("storage"); }).finally(() => { if (active === operation) active = undefined; });
  };
  const last = (reference: string) => { const e = entries.at(-1); if (!e || e.reuseRef !== reference) return fail("consumed"); return e; };
  const analysisSnapshot = async () => { const a = data(await analysisStatus(), ["storage", "headHash", "analysisNodes", "leafNodes", "claims", "limits"]);
    if (a.storage !== "ready" || !digest(a.headHash) || !Number.isInteger(a.analysisNodes) || a.analysisNodes < 0 || a.analysisNodes > 1024) return fail("storage"); return a; };
  const verifyNode = (value: StandingHistoryAnalysisNode, e: Entry) => {
    const n = data(value, ["nodeRef", "kind", "index", "hash", "inputs", "coverage", "output"]), result = evidence({ nodeRef: n.nodeRef, index: n.index, hash: n.hash });
    if (n.kind !== "leaf" || result.index !== e.plan.nodeIndex || !equal(snapshotStandingHistoryAnalysisOutput(n.output), e.plan.hit.output)) return fail("binding");
    const inputs = array(data(n.inputs, ["materials"]).materials, MAX_FRAGMENTS, 1).map(v => { const m = data(v, ["pageIndex", "maxBytes", "materialRef", "pageHash", "range", "coverage", "supports"], ["position", "maxRows"]);
      return material({ pageIndex: m.pageIndex, maxBytes: m.maxBytes, materialRef: m.materialRef, ...(Object.hasOwn(m, "position") ? { position: m.position } : {}), ...(Object.hasOwn(m, "maxRows") ? { maxRows: m.maxRows } : {}) }); });
    if (!equal(inputs, e.plan.inputs)) return fail("binding"); return result;
  };
  return Object.freeze<StandingHistoryChronicleReuseStore>({
    status: () => run(async () => {
      await guard(); if (!tail) {
        try { const names = await inventory(); if (names.size !== versions.size || [...names].some(n => !versions.has(n))) tail = true; }
        catch (error) { if (error instanceof StandingHistoryChronicleReuseStoreError && error.code === "tail") tail = true; else throw error; }
      }
      return status();
    }),
    prepare(value) {
      const plan = planCopy(value);
      return run(async () => {
        await ready(); if (entries.at(-1) && !entries.at(-1)!.node) return fail("consumed"); if (entries.length >= MAX_REUSES) return fail("limit");
        const a = await analysisSnapshot(); if (a.headHash !== plan.expectedHead || a.analysisNodes + 1 !== plan.nodeIndex) return fail("conflict");
        if (!root) { await mkdir(directory, { mode: 0o700 }); root = await dirStat(directory); } await guard();
        if (!owner) { await mkdir(slot, { mode: 0o700 }); owner = await dirStat(slot); } await guard();
        const index = entries.length + 1, envelope = preparedEnvelope(index, plan, entries.length ? entryHash(entries.at(-1)!) : intentHash), preparedHash = hash(envelope);
        try { await write(filename(index, "prepared"), envelope); } catch (e) { tail = true; throw e; }
        const e: Entry = { index, plan, preparedHash, reuseRef: "hreuse_" + preparedHash.slice(0, 48) }; entries.push(e);
        const confirmed = await analysisSnapshot(); if (confirmed.headHash !== plan.expectedHead || confirmed.analysisNodes + 1 !== plan.nodeIndex) return fail("conflict");
        return Object.freeze({ reuseRef: e.reuseRef });
      });
    },
    readPrepared(reference) { if (!ref(reference, "hreuse")) return fail("input"); return run(async () => { await ready(); return last(reference).plan; }); },
    commitPrepared(value) {
      const v = data(value, ["reuseRef"]); if (!ref(v.reuseRef, "hreuse")) return fail("input");
      return run(async () => {
        await ready(); const e = last(v.reuseRef), a = await analysisSnapshot(); let raw = await readNodeAt(e.plan.nodeIndex);
        if (!raw) {
          if (e.node || a.headHash !== e.plan.expectedHead || a.analysisNodes + 1 !== e.plan.nodeIndex) return fail("conflict");
          const written = await appendLeaf({ expectedHead: e.plan.expectedHead, inputs: e.plan.inputs, output: e.plan.hit.output }); verifyNode(written, e);
          raw = await readNodeAt(e.plan.nodeIndex); if (!raw) return fail("storage");
          if (!equal(verifyNode(raw, e), verifyNode(written, e))) return fail("binding");
        }
        const node = verifyNode(raw, e);
        if (e.plan.nodeIndex > 1) { const previous = await readNodeAt(e.plan.nodeIndex - 1); if (!previous || previous.index !== e.plan.nodeIndex - 1 || previous.hash !== e.plan.expectedHead) return fail("binding"); }
        if (e.node && !equal(e.node, node)) return fail("binding");
        const after = await analysisSnapshot(); if (after.analysisNodes < node.index || after.analysisNodes === node.index && after.headHash !== node.hash) return fail("binding");
        await ready(); if (!e.node) { try { await write(filename(e.index, "node"), nodeEnvelope(e, node)); } catch (error) { tail = true; throw error; } e.node = node; }
        return node;
      });
    },
    async close() { closed = true; try { await active; } finally { passphrase = ""; } },
  });
}
