import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import { snapshotStandingHistoryAnalysisOutput, type StandingHistoryAnalysisStore, type StandingHistoryAnalysisOutput, type StandingHistoryAnalysisMaterialRequest, type StandingHistoryAnalysisNode } from "./standing-history-analysis-store.js";
import { MATERIAL_BYTES, MAX_FRAGMENTS, MAX_ANALYSIS_NODES, NODE_PLAIN_BYTES, NODE_CIPHER_BYTES } from "./standing-history-analysis-limits.js";

type PlanBase = Readonly<{ sourceHead: string; expectedHead: string; nodeIndex: number; modelInputHash: string }>;
export type StandingHistoryAnalysisAttemptPlan = PlanBase & (
  Readonly<{ kind: "leaf"; inputs: readonly StandingHistoryAnalysisMaterialRequest[] }> |
  Readonly<{ kind: "merge"; children: readonly string[]; viewMaxBytes?: number }>);
export type StandingHistoryAnalysisNodeEvidence = Readonly<{ nodeRef: string; index: number; hash: string }>;
export type StandingHistoryAnalysisModelOutcome = "observed" | "refused" | "unknown";
/** Exact native owner association, authenticated with the reservation. It is
 * not settlement evidence; the host resolves that owner's persisted outcome. */
export type StandingHistoryAnalysisNativeBinding = Readonly<{ epochId: string; requestRef: string; purpose: "history-analysis" }>;
export type StandingHistoryAnalysisSuccessorSettlement = Readonly<{ schema: "standing-analysis-owner-settlement-v1"; nativeBinding: StandingHistoryAnalysisNativeBinding;
  resourcesSettled: true; persisted: true; replacementReady: true; modelOutcome: "not-proven" }>;
export type StandingHistoryAnalysisAttemptStatus = Readonly<{
  storage: "ready" | "tail-refused"; attempts: number; modelReplayAllowed: false;
  last?: Readonly<{ attemptRef: string; attemptIndex: number; nodeIndex: number; planHash: string; nativeBinding?: StandingHistoryAnalysisNativeBinding;
    prepared?: Readonly<{ outputHash: string }>; node?: StandingHistoryAnalysisNodeEvidence; modelOutcome?: StandingHistoryAnalysisModelOutcome;
    consecutiveNotAdmitted?: number; consecutiveNoOutput?: number }>;
}>;
/** A bounded fresh successor is distinct from replaying the consumed attempt.
 * Three consecutive admission refusals exhaust this plan across restarts. */
export const STANDING_HISTORY_ANALYSIS_MAX_NOT_ADMITTED = 3;
export const STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT = 3;
/** Pure-analysis successor candidate only, never dispatch authority. UNKNOWN
 * and missing outcomes require explicit settled-owner continuation admission. */
export function isStandingHistoryAnalysisRetryableNoOutput(last: StandingHistoryAnalysisAttemptStatus["last"]): boolean {
  return !!last?.nativeBinding && !last.prepared && !last.node;
}
/** Classification only: settlement, unchanged heads, fresh binding and the
 * persisted consecutive-refusal budget remain separate admission gates. */
export function isStandingHistoryAnalysisNotAdmitted(last: StandingHistoryAnalysisAttemptStatus["last"]): boolean {
  return !!last?.nativeBinding && last.modelOutcome === "refused" && !last.prepared && !last.node;
}
export type StandingHistoryAnalysisAttemptStore = Readonly<{
  status(): Promise<StandingHistoryAnalysisAttemptStatus>;
  /** Host-only exact plan recovery; does not grant successor admission. */
  readNotAdmittedPlan(attemptRef: string): Promise<StandingHistoryAnalysisAttemptPlan>;
  readRetryablePlan(attemptRef: string): Promise<StandingHistoryAnalysisAttemptPlan>;
  reserve(input: Readonly<{ plan: StandingHistoryAnalysisAttemptPlan; nativeBinding?: StandingHistoryAnalysisNativeBinding }>): Promise<Readonly<{ attemptRef: string; planHash: string; nodeIndex: number }>>;
  /** Append a new pure-analysis attempt only after exact physical owner settlement.
   * The original receipt (including its absence) is retained without amendment. */
  reserveSuccessor(input: Readonly<{ attemptRef: string; plan: StandingHistoryAnalysisAttemptPlan; nativeBinding: StandingHistoryAnalysisNativeBinding;
    verifyOwnerSettled: (binding: StandingHistoryAnalysisNativeBinding) => Promise<StandingHistoryAnalysisSuccessorSettlement> }>): Promise<Readonly<{ attemptRef: string; planHash: string; nodeIndex: number }>>;
  prepare(input: Readonly<{ attemptRef: string; output: StandingHistoryAnalysisOutput }>): Promise<StandingHistoryAnalysisAttemptStatus>;
  commitPrepared(input: Readonly<{ attemptRef: string }>): Promise<StandingHistoryAnalysisNodeEvidence>;
  recordModelOutcome(input: Readonly<{ attemptRef: string; outcome: StandingHistoryAnalysisModelOutcome }>): Promise<StandingHistoryAnalysisAttemptStatus>;
  close(): Promise<void>;
}>;
export class StandingHistoryAnalysisAttemptStoreError extends Error {
  constructor(readonly code: "input" | "binding" | "consumed" | "conflict" | "tail" | "limit" | "storage" | "busy" | "closed" | "aborted") {
    super("STANDING_HISTORY_ANALYSIS_ATTEMPT_" + code.toUpperCase()); this.name = "StandingHistoryAnalysisAttemptStoreError";
  }
}
const fail = (code: StandingHistoryAnalysisAttemptStoreError["code"]): never => { throw new StandingHistoryAnalysisAttemptStoreError(code); };
const DOMAIN = "DecadansNeurobro/standing-history-analysis-attempt/v1", MAX_ATTEMPTS = 1024, MAX_PLAIN = NODE_PLAIN_BYTES, MAX_CIPHER = NODE_CIPHER_BYTES;
const ref = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp("^" + prefix + "_[0-9a-f]{48}$", "u").test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
const text = (v: unknown, limit: number): v is string => typeof v === "string" && v.trim().length > 0 && !v.includes("\0") && Buffer.byteLength(v) <= limit && Buffer.from(v).toString("utf8") === v;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function data(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function array(v: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(v) || types.isProxy(v) || Object.getPrototypeOf(v) !== Array.prototype) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), length = Object.getOwnPropertyDescriptor(v, "length")!.value as number;
  if (length < minimum || length > maximum || Reflect.ownKeys(ds).length !== length + 1) return fail("input");
  return Array.from({ length }, (_, i) => { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail("input"); return d.value; });
}
function material(v: unknown): StandingHistoryAnalysisMaterialRequest {
  const m = data(v, ["pageIndex", "maxBytes", "materialRef"], ["position", "maxRows"]);
  if (!Number.isInteger(m.pageIndex) || Number(m.pageIndex) < 1 || Number(m.pageIndex) > 1024 || !Number.isInteger(m.maxBytes) || Number(m.maxBytes) < 1024 || Number(m.maxBytes) > MATERIAL_BYTES || !ref(m.materialRef, "hmat") ||
      Object.hasOwn(m, "maxRows") && (!Number.isInteger(m.maxRows) || Number(m.maxRows) < 1 || Number(m.maxRows) > 100) ||
      Object.hasOwn(m, "position") && (typeof m.position !== "string" || !/^hpos_(?:0|[1-9]\d{0,2})_[0-9a-f]{48}$/u.test(m.position))) return fail("input");
  return Object.freeze({ pageIndex: Number(m.pageIndex), maxBytes: Number(m.maxBytes), materialRef: m.materialRef,
    ...(Object.hasOwn(m, "position") ? { position: m.position as string } : {}), ...(Object.hasOwn(m, "maxRows") ? { maxRows: Number(m.maxRows) } : {}) });
}
function planCopy(v: unknown): StandingHistoryAnalysisAttemptPlan {
  const p = data(v, ["kind", "sourceHead", "expectedHead", "nodeIndex", "modelInputHash"], ["inputs", "children", "viewMaxBytes"]);
  if (!digest(p.sourceHead) || !digest(p.expectedHead) || !digest(p.modelInputHash) || !Number.isInteger(p.nodeIndex) || Number(p.nodeIndex) < 1 || Number(p.nodeIndex) > MAX_ANALYSIS_NODES) return fail("input");
  const base = { sourceHead: p.sourceHead, expectedHead: p.expectedHead, nodeIndex: Number(p.nodeIndex), modelInputHash: p.modelInputHash };
  if (p.kind === "leaf" && !Object.hasOwn(p, "children") && !Object.hasOwn(p, "viewMaxBytes")) {
    const inputs = array(p.inputs, MAX_FRAGMENTS, 1).map(material); if (new Set(inputs.map(m => m.materialRef)).size !== inputs.length) return fail("input");
    return Object.freeze({ kind: "leaf", ...base, inputs: Object.freeze(inputs) });
  }
  if (p.kind === "merge" && !Object.hasOwn(p, "inputs")) {
    const children = array(p.children, MAX_ANALYSIS_NODES, 1); if (children.some(v => !ref(v, "hnode")) || new Set(children).size !== children.length) return fail("input");
    if (Object.hasOwn(p, "viewMaxBytes") && (!Number.isSafeInteger(p.viewMaxBytes) || Number(p.viewMaxBytes) < 1024 || Number(p.viewMaxBytes) > MATERIAL_BYTES)) return fail("input");
    return Object.freeze({ kind: "merge", ...base, children: Object.freeze(children as string[]), ...(Object.hasOwn(p, "viewMaxBytes") ? { viewMaxBytes: Number(p.viewMaxBytes) } : {}) });
  }
  return fail("input");
}
function outputCopy(v: unknown): StandingHistoryAnalysisOutput {
  let output: StandingHistoryAnalysisOutput;
  try { output = snapshotStandingHistoryAnalysisOutput(v); } catch { return fail("input"); }
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_PLAIN) return fail("limit"); return output;
}
function method<T extends (...args: never[]) => unknown>(v: unknown, name: string): T {
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail("input");
  const d = Object.getOwnPropertyDescriptor(v, name); if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail("input"); return d.value.bind(v) as T;
}
function nativeBindingCopy(value: unknown): StandingHistoryAnalysisNativeBinding {
  const v = data(value, ["epochId", "requestRef", "purpose"]);
  if (typeof v.epochId !== "string" || !/^[0-9a-f]{32}$/.test(v.epochId) || typeof v.requestRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.requestRef) || v.purpose !== "history-analysis") return fail("input");
  return Object.freeze({ epochId: v.epochId, requestRef: v.requestRef, purpose: "history-analysis" });
}
type Continuation = Readonly<{ schema: "settled-analysis-successor-v1"; predecessorAttemptRef: string; predecessorReservationHash: string; planHash: string;
  nativeBinding: StandingHistoryAnalysisNativeBinding; originalOutcome: StandingHistoryAnalysisModelOutcome | "missing"; originalNativeHash: string | null;
  ownerSettlement: StandingHistoryAnalysisSuccessorSettlement }>;
type Attempt = { attemptRef: string; index: number; plan: StandingHistoryAnalysisAttemptPlan; planHash: string; reservationHash: string; nativeBinding?: StandingHistoryAnalysisNativeBinding; continuation?: Continuation;
  prepared?: { hash: string; outputHash: string; output?: StandingHistoryAnalysisOutput };
  node?: { hash: string; evidence: StandingHistoryAnalysisNodeEvidence }; native?: { hash: string; outcome: StandingHistoryAnalysisModelOutcome } };
type Kind = "reservation" | "prepared" | "node" | "native";

/** Persistence for one actual internal analysis invocation per reservation.
 * A fresh reserve return is consumed once by its host; reopening/status never
 * grants model replay. Node proof and native outcome are independent facts.
 * The original commit may run inside its admitted native callback. Recovery
 * requires an externally settled native owner/release and a noncancelled task;
 * this store neither creates that proof nor closes borrowed analysis owners.
 * Source/model-input hashes are pinned host commitments, not source authority.
 * Claims remain unverified. A recorded UNKNOWN is never upgraded to observed.
 * File sync/readback is checked; power-loss directory durability is not promised. */
export async function openStandingHistoryAnalysisAttemptStore(input: Readonly<{
  directory: string; passphrase: string; intent: StandingHistoryTaskIntent; mode: "create" | "open";
  analysis: Pick<StandingHistoryAnalysisStore, "status" | "readNodeAt" | "appendLeaf" | "appendMerge">; signal?: AbortSignal;
}>): Promise<StandingHistoryAnalysisAttemptStore> {
  const args = data(input, ["directory", "passphrase", "intent", "mode", "analysis"], ["signal"]);
  let intent: StandingHistoryTaskIntent; try { intent = snapshotStandingHistoryTaskIntent(args.intent); } catch { return fail("input"); }
  if (typeof args.directory !== "string" || !isAbsolute(args.directory) || resolve(args.directory) !== args.directory || !text(args.passphrase, 4096) || args.passphrase.length < 16 || args.mode !== "create" && args.mode !== "open" ||
      Object.hasOwn(args, "signal") && (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal))) return fail("input");
  const analysisStatus = method<StandingHistoryAnalysisStore["status"]>(args.analysis, "status"), readNodeAt = method<StandingHistoryAnalysisStore["readNodeAt"]>(args.analysis, "readNodeAt");
  const appendLeaf = method<StandingHistoryAnalysisStore["appendLeaf"]>(args.analysis, "appendLeaf"), appendMerge = method<StandingHistoryAnalysisStore["appendMerge"]>(args.analysis, "appendMerge");
  const directory = args.directory, slot = join(directory, intent.taskId), signal = args.signal as AbortSignal | undefined;
  const header = { domain: DOMAIN, taskId: intent.taskId, kind: "intent", intent }, intentHash = hash(header);
  let passphrase = args.passphrase, tail = false, revoked: "closed" | "aborted" | undefined, active: Promise<unknown> | undefined, closing: Promise<void> | undefined, initializing = true;
  let root: BigIntStats, owner: BigIntStats;
  const versions = new Map<string, string>(), attempts: Attempt[] = [];
  const filename = (index: number, kind: Kind) => "attempt-" + String(index).padStart(6, "0") + "." + kind + ".enc";
  const live = () => { if (revoked) return fail(revoked); if (signal?.aborted) return fail("aborted"); };
  const shutdown = (): Promise<void> => {
    closing ??= (async () => { try { await active; } catch {} finally { passphrase = ""; for (const a of attempts) if (a.prepared) delete a.prepared.output; signal?.removeEventListener("abort", abort); } })(); return closing;
  };
  const abort = () => { revoked ??= "aborted"; if (!initializing) void shutdown(); };
  signal?.addEventListener("abort", abort, { once: true });
  const check = async (known = false) => {
    live(); await assertPilotPrivateDirectory(directory); await assertPilotPrivateDirectory(slot);
    if (!sameDirectory(root, await lstat(directory, { bigint: true })) || !sameDirectory(owner, await lstat(slot, { bigint: true }))) return fail("storage");
    if (known) for (const [name, expected] of versions) { live(); const s = await lstat(join(slot, name), { bigint: true }); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || stamp(s) !== expected) return fail("storage"); }
    live();
  };
  const read = async (name: string): Promise<{ value: unknown; version: string }> => {
    await check(); const path = join(slot, name), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true }); if (!inside.isFile() || stamp(inside) !== stamp(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { live(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size)) return fail("storage");
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); live(); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
      const value: unknown = JSON.parse(plain), after = await lstat(path, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || stamp(after) !== stamp(before)) return fail("storage");
      await check(); return { value, version: stamp(after) };
    } finally { bytes?.fill(0); await file.close(); }
  };
  const write = async (name: string, value: unknown): Promise<void> => {
    const plain = JSON.stringify(value); if (Buffer.byteLength(plain) > MAX_PLAIN) return fail("limit");
    try {
      await check(); const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("limit"); await check();
      const file = await open(join(slot, name), "wx", 0o600); try { await file.writeFile(cipher); await file.sync(); } finally { await file.close(); }
      const saved = await read(name); if (!equal(saved.value, value)) return fail("storage"); versions.set(name, saved.version); await check(true);
    } catch (error) { tail = true; throw error; }
  };
  const inventory = async () => {
    await check(); const dir = await opendir(slot, { bufferSize: 1 }), names = new Set<string>(); let valid = true;
    try {
      for (let n = 0; n <= MAX_ATTEMPTS * 4 + 1; n++) {
        live(); const entry = await dir.read(); if (!entry) { await check(); return { names, valid }; }
        names.add(entry.name);
        if (n === MAX_ATTEMPTS * 4 + 1 || !entry.isFile() || entry.isSymbolicLink() || entry.name !== "intent.enc" && !/^attempt-\d{6}\.(reservation|prepared|node|native)\.enc$/u.test(entry.name)) valid = false;
      }
      return { names, valid: false };
    } finally { await dir.close(); }
  };
  const ready = async () => { await check(true); const listing = await inventory(); if (!listing.valid || listing.names.size !== versions.size || [...versions.keys()].some(n => !listing.names.has(n))) tail = true; if (tail) return fail("tail"); };
  const previousHash = (a: Attempt | undefined) => {
    if (!a) return intentHash;
    if (retryable(a)) return hash({ reservation: a.reservationHash, native: a.native!.hash });
    if (a.native?.outcome === "refused" || !a.prepared || !a.node || !a.native) return fail("consumed");
    return hash({ reservation: a.reservationHash, prepared: a.prepared.hash, node: a.node.hash, native: a.native.hash });
  };
  const notAdmitted = (a: Attempt | undefined) => !!a?.nativeBinding && a.native?.outcome === "refused" && !a.prepared && !a.node;
  const retryable = (a: Attempt | undefined) => !!a?.nativeBinding && (a.native?.outcome === "refused" || a.native?.outcome === "observed") && !a.prepared && !a.node;
  const successorCandidate = (a: Attempt | undefined) => !!a?.nativeBinding && !a.prepared && !a.node;
  const noOutputCount = () => { let count = 0; for (let i = attempts.length - 1; i >= 0 && successorCandidate(attempts[i]); i--) count++; return count; };
  const refusalCount = () => { let count = 0; for (let i = attempts.length - 1; i >= 0 && notAdmitted(attempts[i]); i--) count++; return count; };
  const verifySuccessor = (previous: Attempt | undefined, planHash: string, binding: StandingHistoryAnalysisNativeBinding | undefined) => {
    if (!successorCandidate(previous)) return;
    if (noOutputCount() >= STANDING_HISTORY_ANALYSIS_MAX_NO_OUTPUT) return fail("limit");
    if (planHash !== previous!.planHash) return fail("conflict");
    if (!binding) return fail("binding");
    for (let i = attempts.length - 1; i >= 0 && successorCandidate(attempts[i]); i--) {
      const old = attempts[i]!.nativeBinding!;
      if (binding.epochId === old.epochId || binding.requestRef === old.requestRef) return fail("binding");
    }
  };
  const continuationRecord = (previous: Attempt): Continuation => {
    if (!successorCandidate(previous)) return fail("consumed");
    return Object.freeze({ schema: "settled-analysis-successor-v1", predecessorAttemptRef: previous.attemptRef,
      predecessorReservationHash: previous.reservationHash, planHash: previous.planHash, nativeBinding: previous.nativeBinding!,
      originalOutcome: previous.native?.outcome ?? "missing", originalNativeHash: previous.native?.hash ?? null,
      ownerSettlement: Object.freeze({ schema: "standing-analysis-owner-settlement-v1", nativeBinding: previous.nativeBinding!, resourcesSettled: true,
        persisted: true, replacementReady: true, modelOutcome: "not-proven" }) });
  };
  const reservationRecord = (a: Attempt, previous: string) => ({ domain: DOMAIN, taskId: intent.taskId, kind: "reservation", intentHash,
    attemptIndex: a.index, attemptRef: a.attemptRef, previousHash: previous, plan: a.plan, planHash: a.planHash,
    ...(a.nativeBinding ? { nativeBinding: a.nativeBinding } : {}), ...(a.continuation ? { continuation: a.continuation } : {}) });
  const preparedRecord = (a: Attempt, output: StandingHistoryAnalysisOutput) => ({ domain: DOMAIN, taskId: intent.taskId, kind: "prepared", intentHash,
    reservationHash: a.reservationHash, attemptRef: a.attemptRef, planHash: a.planHash, nodeIndex: a.plan.nodeIndex, output, outputHash: hash(output) });
  const nodeRecord = (a: Attempt, evidence: StandingHistoryAnalysisNodeEvidence) => ({ domain: DOMAIN, taskId: intent.taskId, kind: "node", intentHash,
    reservationHash: a.reservationHash, preparedHash: a.prepared!.hash, attemptRef: a.attemptRef, planHash: a.planHash, outputHash: a.prepared!.outputHash, evidence });
  const nativeRecord = (a: Attempt, outcome: StandingHistoryAnalysisModelOutcome) => ({ domain: DOMAIN, taskId: intent.taskId, kind: "native", intentHash,
    reservationHash: a.reservationHash, attemptRef: a.attemptRef, outcome });
  const evidenceCopy = (value: unknown): StandingHistoryAnalysisNodeEvidence => {
    const e = data(value, ["nodeRef", "index", "hash"]); if (!ref(e.nodeRef, "hnode") || !digest(e.hash) || !Number.isInteger(e.index) || Number(e.index) < 1 || Number(e.index) > MAX_ANALYSIS_NODES) return fail("binding");
    return Object.freeze({ nodeRef: e.nodeRef, index: Number(e.index), hash: e.hash });
  };
  const status = (): StandingHistoryAnalysisAttemptStatus => {
    const a = attempts.at(-1);
    return Object.freeze({ storage: tail ? "tail-refused" : "ready", attempts: attempts.length, modelReplayAllowed: false,
      ...(a ? { last: Object.freeze({ attemptRef: a.attemptRef, attemptIndex: a.index, nodeIndex: a.plan.nodeIndex, planHash: a.planHash,
        ...(a.nativeBinding ? { nativeBinding: a.nativeBinding } : {}), ...(notAdmitted(a) ? { consecutiveNotAdmitted: refusalCount() } : {}),
        ...(successorCandidate(a) ? { consecutiveNoOutput: noOutputCount() } : {}),
        ...(a.prepared ? { prepared: Object.freeze({ outputHash: a.prepared.outputHash }) } : {}), ...(a.node ? { node: a.node.evidence } : {}), ...(a.native ? { modelOutcome: a.native.outcome } : {}) }) } : {}) });
  };
  const last = (attemptRef: string) => { const a = attempts.at(-1); if (!a || a.attemptRef !== attemptRef) return fail("consumed"); return a; };
  const analysisSnapshot = async () => {
    const s = data(await analysisStatus(), ["storage", "headHash", "analysisNodes", "leafNodes", "claims", "limits"]); live();
    if (s.storage !== "ready" || !digest(s.headHash) || !Number.isInteger(s.analysisNodes) || Number(s.analysisNodes) < 0 || Number(s.analysisNodes) > MAX_ANALYSIS_NODES) return fail("storage");
    return { headHash: s.headHash, count: Number(s.analysisNodes) };
  };
  const verifyNode = (value: StandingHistoryAnalysisNode, a: Attempt): StandingHistoryAnalysisNodeEvidence => {
    const n = data(value, ["nodeRef", "kind", "index", "hash", "inputs", "coverage", "output"]), evidence = evidenceCopy({ nodeRef: n.nodeRef, index: n.index, hash: n.hash });
    if (n.kind !== a.plan.kind || evidence.index !== a.plan.nodeIndex || hash(outputCopy(n.output)) !== a.prepared!.outputHash) return fail("binding");
    if (a.plan.kind === "leaf") {
      const i = data(n.inputs, ["materials"]);
      const inputs = array(i.materials, MAX_FRAGMENTS, 1).map(value => {
        const m = data(value, ["pageIndex", "maxBytes", "materialRef", "pageHash", "range", "coverage", "supports"], ["position", "maxRows"]);
        return material({ pageIndex: m.pageIndex, maxBytes: m.maxBytes, materialRef: m.materialRef, ...(Object.hasOwn(m, "position") ? { position: m.position } : {}), ...(Object.hasOwn(m, "maxRows") ? { maxRows: m.maxRows } : {}) });
      });
      if (!equal(inputs, a.plan.inputs)) return fail("binding");
    } else {
      const i = data(n.inputs, ["children"]), children = array(i.children, MAX_ANALYSIS_NODES, 1); if (!equal(children, a.plan.children)) return fail("binding");
    }
    return evidence;
  };
  try {
    live(); await assertPilotPrivateDirectory(directory); root = await lstat(directory, { bigint: true }); live();
    if (args.mode === "create") { try { await mkdir(slot, { mode: 0o700 }); } catch (error) { return fail((error as NodeJS.ErrnoException)?.code === "EEXIST" ? "consumed" : "storage"); } }
    await assertPilotPrivateDirectory(slot); owner = await lstat(slot, { bigint: true });
    if (args.mode === "create") await write("intent.enc", header);
    else {
      const saved = await read("intent.enc"), h = data(saved.value, ["domain", "taskId", "kind", "intent"]);
      if (h.domain !== DOMAIN || h.taskId !== intent.taskId || h.kind !== "intent" || !equal(snapshotStandingHistoryTaskIntent(h.intent), intent)) return fail("binding"); versions.set("intent.enc", saved.version);
      const listing = await inventory(); if (!listing.valid) tail = true;
      for (let index = 1; index <= MAX_ATTEMPTS && listing.names.has(filename(index, "reservation")); index++) {
        try {
          const previous = attempts.at(-1), savedReservation = await read(filename(index, "reservation"));
          const r = data(savedReservation.value, ["domain", "taskId", "kind", "intentHash", "attemptIndex", "attemptRef", "previousHash", "plan", "planHash"], ["nativeBinding", "continuation"]);
          let continuation: Continuation | undefined;
          if (Object.hasOwn(r, "continuation")) {
            if (!previous) return fail("binding");
            continuation = continuationRecord(previous);
            if (!equal(r.continuation, continuation)) return fail("binding");
          }
          const priorHash = continuation ? hash(continuation) : previousHash(previous);
          if (!ref(r.attemptRef, "hattempt") || attempts.some(a => a.attemptRef === r.attemptRef)) return fail("binding");
          const plan = planCopy(r.plan), a: Attempt = { attemptRef: r.attemptRef, index, plan, planHash: hash(plan), reservationHash: hash(savedReservation.value),
            ...(Object.hasOwn(r, "nativeBinding") ? { nativeBinding: nativeBindingCopy(r.nativeBinding) } : {}), ...(continuation ? { continuation } : {}) };
          if (!equal(savedReservation.value, reservationRecord(a, priorHash))) return fail("binding");
          verifySuccessor(previous, a.planHash, a.nativeBinding);
          if (previous?.prepared) delete previous.prepared.output; attempts.push(a); versions.set(filename(index, "reservation"), savedReservation.version);
          if (listing.names.has(filename(index, "prepared"))) {
            const saved = await read(filename(index, "prepared")), p = data(saved.value, ["domain", "taskId", "kind", "intentHash", "reservationHash", "attemptRef", "planHash", "nodeIndex", "output", "outputHash"]);
            const output = outputCopy(p.output); if (!equal(saved.value, preparedRecord(a, output))) return fail("binding");
            a.prepared = { hash: hash(saved.value), outputHash: hash(output), output }; versions.set(filename(index, "prepared"), saved.version);
          }
          if (listing.names.has(filename(index, "node"))) {
            if (!a.prepared) return fail("binding");
            const saved = await read(filename(index, "node")), n = data(saved.value, ["domain", "taskId", "kind", "intentHash", "reservationHash", "preparedHash", "attemptRef", "planHash", "outputHash", "evidence"]);
            const evidence = evidenceCopy(n.evidence); if (evidence.index !== a.plan.nodeIndex || !equal(saved.value, nodeRecord(a, evidence))) return fail("binding");
            a.node = { hash: hash(saved.value), evidence }; versions.set(filename(index, "node"), saved.version);
          }
          if (listing.names.has(filename(index, "native"))) {
            const saved = await read(filename(index, "native")), n = data(saved.value, ["domain", "taskId", "kind", "intentHash", "reservationHash", "attemptRef", "outcome"]);
            if (!["observed", "refused", "unknown"].includes(n.outcome as string) || !equal(saved.value, nativeRecord(a, n.outcome as StandingHistoryAnalysisModelOutcome))) return fail("binding");
            a.native = { hash: hash(saved.value), outcome: n.outcome as StandingHistoryAnalysisModelOutcome }; versions.set(filename(index, "native"), saved.version);
          }
        } catch { live(); tail = true; break; }
      }
      if (listing.names.size !== versions.size || [...versions.keys()].some(n => !listing.names.has(n))) tail = true;
    }
    await check(true); initializing = false; live();
  } catch (error) {
    initializing = false; passphrase = ""; signal?.removeEventListener("abort", abort); if (error instanceof StandingHistoryAnalysisAttemptStoreError) throw error; return fail("storage");
  }
  const operation = <T>(work: () => Promise<T>): Promise<T> => {
    live(); if (active) return fail("busy"); const pending = Promise.resolve().then(async () => { await check(true); return work(); }); active = pending;
    return pending.catch(error => { if (error instanceof StandingHistoryAnalysisAttemptStoreError) throw error; return fail("storage"); }).finally(() => { if (active === pending) active = undefined; });
  };
  return Object.freeze<StandingHistoryAnalysisAttemptStore>({
    async status() { return operation(async () => { const listing = await inventory(); if (!listing.valid || listing.names.size !== versions.size || [...versions.keys()].some(n => !listing.names.has(n))) tail = true; await check(true); return status(); }); },
    async readNotAdmittedPlan(attemptRef) {
      if (!ref(attemptRef, "hattempt")) return fail("input");
      return operation(async () => {
        await ready(); const a = last(attemptRef); if (!notAdmitted(a)) return fail("consumed");
        return planCopy(a.plan);
      });
    },
    async readRetryablePlan(attemptRef) {
      if (!ref(attemptRef, "hattempt")) return fail("input");
      return operation(async () => {
        await ready(); const a = last(attemptRef); if (!successorCandidate(a)) return fail("consumed");
        return planCopy(a.plan);
      });
    },
    async reserve(value) {
      const request = data(value, ["plan"], ["nativeBinding"]), plan = planCopy(request.plan);
      const nativeBinding = Object.hasOwn(request, "nativeBinding") ? nativeBindingCopy(request.nativeBinding) : undefined;
      return operation(async () => {
        await ready(); if (attempts.length >= MAX_ATTEMPTS) return fail("limit"); const previous = attempts.at(-1), priorHash = previousHash(previous);
        verifySuccessor(previous, hash(plan), nativeBinding);
        const observed = await analysisSnapshot(); if (observed.headHash !== plan.expectedHead || observed.count + 1 !== plan.nodeIndex) return fail("conflict");
        const a: Attempt = { attemptRef: "hattempt_" + randomBytes(24).toString("hex"), index: attempts.length + 1, plan, planHash: hash(plan), reservationHash: "",
          ...(nativeBinding ? { nativeBinding } : {}) };
        const record = reservationRecord(a, priorHash); a.reservationHash = hash(record); await write(filename(a.index, "reservation"), record);
        if (previous?.prepared) delete previous.prepared.output; attempts.push(a);
        const confirmed = await analysisSnapshot(); if (confirmed.headHash !== plan.expectedHead || confirmed.count + 1 !== plan.nodeIndex) return fail("conflict");
        await ready(); return Object.freeze({ attemptRef: a.attemptRef, planHash: a.planHash, nodeIndex: plan.nodeIndex });
      });
    },
    async reserveSuccessor(value) {
      const request = data(value, ["attemptRef", "plan", "nativeBinding", "verifyOwnerSettled"]);
      if (!ref(request.attemptRef, "hattempt") || typeof request.verifyOwnerSettled !== "function" || types.isProxy(request.verifyOwnerSettled)) return fail("input");
      const attemptRef = request.attemptRef, plan = planCopy(request.plan), nativeBinding = nativeBindingCopy(request.nativeBinding);
      const verifyOwnerSettled = request.verifyOwnerSettled as (binding: StandingHistoryAnalysisNativeBinding) => Promise<StandingHistoryAnalysisSuccessorSettlement>;
      const continuation = await operation(async () => {
        await ready(); if (attempts.length >= MAX_ATTEMPTS) return fail("limit");
        const previous = last(attemptRef), continuation = continuationRecord(previous);
        verifySuccessor(previous, hash(plan), nativeBinding);
        const observed = await analysisSnapshot(); if (observed.headHash !== plan.expectedHead || observed.count + 1 !== plan.nodeIndex) return fail("conflict");
        return continuation;
      });
      // Joining the owner must not hold the store operation slot: a late native
      // callback may still prepare output. The second phase rejects that race.
      const proof = data(await verifyOwnerSettled(continuation.nativeBinding), ["schema", "nativeBinding", "resourcesSettled", "persisted", "replacementReady", "modelOutcome"]);
      const proofBinding = nativeBindingCopy(proof.nativeBinding);
      if (!equal({ ...proof, nativeBinding: proofBinding }, continuation.ownerSettlement)) return fail("binding");
      return operation(async () => {
        live(); await ready();
        const previous = last(attemptRef);
        if (!equal(continuationRecord(previous), continuation)) return fail("conflict");
        verifySuccessor(previous, hash(plan), nativeBinding);
        const settled = await analysisSnapshot(); if (settled.headHash !== plan.expectedHead || settled.count + 1 !== plan.nodeIndex) return fail("conflict");
        // The callback may have awaited a native/process readback. Recheck the
        // complete journal before creating the only new authority-bearing file.
        await ready();
        const a: Attempt = { attemptRef: "hattempt_" + randomBytes(24).toString("hex"), index: attempts.length + 1,
          plan, planHash: hash(plan), reservationHash: "", nativeBinding, continuation };
        const record = reservationRecord(a, hash(continuation)); a.reservationHash = hash(record);
        await write(filename(a.index, "reservation"), record); attempts.push(a);
        const confirmed = await analysisSnapshot(); if (confirmed.headHash !== plan.expectedHead || confirmed.count + 1 !== plan.nodeIndex) return fail("conflict");
        await ready(); return Object.freeze({ attemptRef: a.attemptRef, planHash: a.planHash, nodeIndex: plan.nodeIndex });
      });
    },
    async prepare(value) {
      const request = data(value, ["attemptRef", "output"]); if (!ref(request.attemptRef, "hattempt")) return fail("input"); const output = outputCopy(request.output), attemptRef = request.attemptRef;
      return operation(async () => {
        await ready(); const a = last(attemptRef), outputHash = hash(output);
        if (a.prepared) { if (a.prepared.outputHash !== outputHash) return fail("conflict"); return status(); }
        if (a.native && a.native.outcome !== "observed") return fail("consumed");
        const record = preparedRecord(a, output); await write(filename(a.index, "prepared"), record); a.prepared = { hash: hash(record), outputHash, output }; await ready(); return status();
      });
    },
    async commitPrepared(value) {
      const request = data(value, ["attemptRef"]); if (!ref(request.attemptRef, "hattempt")) return fail("input"); const attemptRef = request.attemptRef;
      return operation(async () => {
        await ready(); const a = last(attemptRef); if (!a.prepared?.output) return fail("consumed");
        const current = await analysisSnapshot(); let raw = await readNodeAt(a.plan.nodeIndex); live();
        let evidence: StandingHistoryAnalysisNodeEvidence;
        if (raw) evidence = verifyNode(raw, a);
        else {
          if (a.node || current.headHash !== a.plan.expectedHead || current.count + 1 !== a.plan.nodeIndex) return fail("conflict");
          const returned = a.plan.kind === "leaf" ? await appendLeaf({ expectedHead: a.plan.expectedHead, inputs: a.plan.inputs, output: a.prepared.output }) : await appendMerge({ expectedHead: a.plan.expectedHead, children: a.plan.children, output: a.prepared.output });
          live(); const returnedEvidence = verifyNode(returned, a); raw = await readNodeAt(a.plan.nodeIndex); live(); if (!raw) return fail("storage");
          evidence = verifyNode(raw, a); if (!equal(evidence, returnedEvidence)) return fail("binding");
        }
        if (a.plan.nodeIndex > 1) {
          const previous = await readNodeAt(a.plan.nodeIndex - 1); live();
          if (!previous) return fail("binding"); const n = data(previous, ["nodeRef", "kind", "index", "hash", "inputs", "coverage", "output"]);
          if (n.index !== a.plan.nodeIndex - 1 || n.hash !== a.plan.expectedHead) return fail("binding");
        }
        const after = await analysisSnapshot(); if (after.count < a.plan.nodeIndex) return fail("binding");
        if (a.node) { if (!equal(evidence, a.node.evidence)) return fail("binding"); await ready(); return a.node.evidence; }
        const record = nodeRecord(a, evidence); await write(filename(a.index, "node"), record); a.node = { hash: hash(record), evidence }; await ready(); return evidence;
      });
    },
    async recordModelOutcome(value) {
      const request = data(value, ["attemptRef", "outcome"]); if (!ref(request.attemptRef, "hattempt") || !["observed", "refused", "unknown"].includes(request.outcome as string)) return fail("input");
      const attemptRef = request.attemptRef, outcome = request.outcome as StandingHistoryAnalysisModelOutcome;
      return operation(async () => {
        await ready(); const a = last(attemptRef); if (a.native) { if (a.native.outcome !== outcome) return fail("conflict"); return status(); }
        const record = nativeRecord(a, outcome); await write(filename(a.index, "native"), record); a.native = { hash: hash(record), outcome }; await ready(); return status();
      });
    },
    close() { revoked ??= "closed"; return shutdown(); }
  });
}
