import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { encryptSession, decryptSession } from "./session-crypto.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "./standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore } from "./standing-history-analysis-attempt-store.js";
import { openStandingHistoryAnalysisStep, type StandingHistoryAnalysisStep, type StandingHistoryAnalysisOwnerSettlement, type StandingHistoryAnalysisStepConnection, type StandingHistoryAnalysisStepLease } from "./standing-history-analysis-step.js";
import { readStandingHistoryTaskDisposition } from "./standing-history-task-disposition.js";
import { runStandingHistoryTaskDelivery, readStandingHistoryTaskDelivery, type StandingHistoryTaskDeliveryInput, type StandingHistoryTaskReadiness } from "./standing-history-task-delivery.js";

export type StandingHistoryTaskContinuationAuthorization = Readonly<{
  schema: "standing-history-task-continuation-authorization-v1"; continuationRef: string; requestHash: string;
  taskRef: string; sourceHead: string; analysisHead: string; controlHead: string; attemptRef: string; planHash: string;
}>;
export type StandingHistoryTaskContinuationInput = Readonly<{
  directory: string; mode: "create" | "open"; intent: StandingHistoryTaskIntent; passphrase: string; signal: AbortSignal;
  directories: StandingHistoryTaskDeliveryInput["directories"] & Readonly<{ disposition: string }>;
  authorization: StandingHistoryTaskContinuationAuthorization;
  /** Explicit one-generation successor; original directories remain unchanged. */
  predecessor?: Readonly<{ directory: string; authorizationHash: string }>;
  verifyOwnerSettled: (binding: StandingHistoryAnalysisOwnerSettlement["nativeBinding"]) => Promise<StandingHistoryAnalysisOwnerSettlement>;
}>;
export class StandingHistoryTaskContinuationError extends Error {
  constructor(readonly code: "input" | "binding" | "storage" | "consumed" | "source-incomplete" | "cancelled" | "busy" | "closed") {
    super("STANDING_HISTORY_TASK_CONTINUATION_" + code.toUpperCase());
  }
}
const fail = (code: StandingHistoryTaskContinuationError["code"]): never => { throw new StandingHistoryTaskContinuationError(code); };
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fields(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.some(k => typeof k !== "string" || !keys.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries([...keys, ...optional.filter(k => Object.hasOwn(ds, k))].map(k => { const d = ds[k]; if (!d || !("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function authorizationCopy(value: unknown): StandingHistoryTaskContinuationAuthorization {
  const a = fields(value, ["schema", "continuationRef", "requestHash", "taskRef", "sourceHead", "analysisHead", "controlHead", "attemptRef", "planHash"]);
  if (a.schema !== "standing-history-task-continuation-authorization-v1" || typeof a.continuationRef !== "string" || !/^hcont_[a-f0-9]{48}$/u.test(a.continuationRef) ||
      typeof a.taskRef !== "string" || !/^htask_[a-f0-9]{48}$/u.test(a.taskRef) || typeof a.attemptRef !== "string" || !/^hattempt_[a-f0-9]{48}$/u.test(a.attemptRef) ||
      ![a.requestHash, a.sourceHead, a.analysisHead, a.controlHead, a.planHash].every(digest)) return fail("input");
  return Object.freeze(a) as StandingHistoryTaskContinuationAuthorization;
}
const pathCopy = (v: unknown) => { if (typeof v !== "string" || !isAbsolute(v) || resolve(v) !== v) return fail("input"); return v; };
async function privateDirectory(path: string) { await assertPilotPrivateDirectory(path); const s = await lstat(path, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink()) return fail("storage"); return [s.dev, s.ino].join(":"); }
async function bytes(path: string): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  const stamp = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 2_097_152n) return fail("storage");
  const file = await open(path, "r");
  try { if (stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail("storage"); const result = await file.readFile();
    if (result.length !== Number(before.size) || stamp(await file.stat({ bigint: true })) !== stamp(before) || stamp(await lstat(path, { bigint: true })) !== stamp(before)) return fail("storage"); return result;
  } finally { await file.close(); }
}
type Inventory = readonly Readonly<{ area: string; name: string; sha256: string }>[];
type Receipt = Readonly<{ schema: "standing-history-task-continuation-v1"; intent: StandingHistoryTaskIntent; authorization: StandingHistoryTaskContinuationAuthorization;
  originalAttempt: unknown; settlement: StandingHistoryAnalysisOwnerSettlement; baseNodes: number; preserved: Inventory;
  predecessor?: Readonly<{ directory: string; authorizationHash: string }> }>;

/** Explicit maintenance capability, never a model tool or ordinary retry path.
 * The caller authenticates the owner's request and keeps sole custody for the
 * entire continuation. This module records that authorization; a supplied hash
 * alone is not proof of user identity. It creates one separate attempt journal,
 * reuses the original task/source/node identities, and never reads Telegram or
 * changes saved pages, cancellation, the old disposition, or old attempts.
 * Missing/UNKNOWN output in this new generation is consumed as usual. A cold
 * prepared output can reconcile by its exact node without another model call.
 * Incomplete saved source is a blocker, not permission to reread the month.
 */
export async function openStandingHistoryTaskContinuation(value: StandingHistoryTaskContinuationInput) {
  const v = fields(value, ["directory", "mode", "intent", "passphrase", "signal", "directories", "authorization", "verifyOwnerSettled"], ["predecessor"]);
  const directory = pathCopy(v.directory), intent = snapshotStandingHistoryTaskIntent(v.intent), authorization = authorizationCopy(v.authorization);
  const d = fields(v.directories, ["pages", "control", "analysis", "attempts", "delivery", "disposition"]);
  const directories = Object.freeze(Object.fromEntries(Object.entries(d).map(([k, p]) => [k, pathCopy(p)]))) as StandingHistoryTaskContinuationInput["directories"];
  let predecessor: Receipt["predecessor"];
  if (Object.hasOwn(v, "predecessor")) {
    const p = fields(v.predecessor, ["directory", "authorizationHash"]);
    if (!digest(p.authorizationHash)) return fail("input");
    predecessor = Object.freeze({ directory: pathCopy(p.directory), authorizationHash: p.authorizationHash });
  }
  const paths = [directory, ...Object.values(directories), ...(predecessor ? [predecessor.directory] : [])];
  for (const [i, a] of paths.entries()) for (const b of paths.slice(i + 1)) for (const [x, y] of [[a, b], [b, a]]) {
    const r = relative(x!, y!); if (!r || !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep)) return fail("input");
  }
  if (!["create", "open"].includes(v.mode as string) || authorization.taskRef !== intent.taskId || typeof v.passphrase !== "string" || v.passphrase.length < 16 ||
      types.isProxy(v.signal) || !(v.signal instanceof AbortSignal) || typeof v.verifyOwnerSettled !== "function" || types.isProxy(v.verifyOwnerSettled)) return fail("input");
  let passphrase = v.passphrase, closed = false, active: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  const signal = v.signal, stop = new AbortController(), joined = AbortSignal.any([signal, stop.signal]);
  const verify = v.verifyOwnerSettled as StandingHistoryTaskContinuationInput["verifyOwnerSettled"];
  const slot = join(directory, intent.taskId), attemptsDirectory = join(slot, "attempts"), effectiveDirectories = Object.freeze({ pages: directories.pages, control: directories.control,
    analysis: directories.analysis, attempts: attemptsDirectory, delivery: directories.delivery });
  const roots = new Map<string, string>(); let slotId = "", receipt: Receipt, step: StandingHistoryAnalysisStep | undefined, readiness: StandingHistoryTaskReadiness | undefined;
  const capsuleVersions = new Map<string, string>();
  const predecessorVersions = new Map<string, string>();
  let scanning = false;
  const live = () => { if (closed) return fail("closed"); if (joined.aborted) return fail("cancelled"); };
  const checkRoots = async () => {
    live(); for (const [path, identity] of roots) if (await privateDirectory(path) !== identity) return fail("storage");
    for (const [path, version] of predecessorVersions) if (createHash("sha256").update(await bytes(path)).digest("hex") !== version) return fail("storage");
    if (slotId) {
      if (await privateDirectory(slot) !== slotId) return fail("storage");
      for (const entry of await readdir(slot, { withFileTypes: true })) if (entry.isSymbolicLink() || (entry.name === "attempts" ? !entry.isDirectory() :
        !["authorization.enc", "activation.enc", "readiness.enc"].includes(entry.name) || !entry.isFile())) return fail("storage");
      for (const [name, version] of capsuleVersions) if (createHash("sha256").update(await bytes(join(slot, name))).digest("hex") !== version) return fail("storage");
    }
    live();
  };
  const readRecord = async (name: string): Promise<unknown> => {
    const cipher = await bytes(join(slot, name)), version = createHash("sha256").update(cipher).digest("hex");
    if (capsuleVersions.has(name) && capsuleVersions.get(name) !== version) return fail("storage");
    const record = JSON.parse(await decryptSession(cipher.toString("utf8"), passphrase)) as unknown; capsuleVersions.set(name, version); return record;
  };
  const predecessorSlot = predecessor && join(predecessor.directory, intent.taskId);
  const oldAttempts = predecessorSlot ? join(predecessorSlot, "attempts") : directories.attempts;
  const originalAreas = { pages: directories.pages, control: directories.control, attempts: directories.attempts, disposition: directories.disposition, analysis: directories.analysis,
    ...(predecessor ? { predecessorAttempts: oldAttempts } : {}) };
  const inventory = async (): Promise<Inventory> => {
    const result: { area: string; name: string; sha256: string }[] = [];
    for (const [area, root] of Object.entries(originalAreas)) {
      const folder = join(root, intent.taskId); await privateDirectory(folder);
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || entry.isSymbolicLink() || result.length >= 8192 || !/^[a-z0-9.-]+\.enc$/u.test(entry.name)) return fail("storage");
        result.push({ area, name: entry.name, sha256: createHash("sha256").update(await bytes(join(folder, entry.name))).digest("hex") });
      }
    }
    if (predecessorSlot) {
      const entries = await readdir(predecessorSlot, { withFileTypes: true });
      if (entries.length !== 3 || entries.some(e => e.isSymbolicLink() || (e.name === "attempts" ? !e.isDirectory() : !["authorization.enc", "activation.enc"].includes(e.name) || !e.isFile()))) return fail("binding");
      for (const name of ["authorization.enc", "activation.enc"]) result.push({ area: "predecessor", name, sha256: createHash("sha256").update(await bytes(join(predecessorSlot, name))).digest("hex") });
    }
    return Object.freeze(result.map(r => Object.freeze(r)));
  };
  const write = async (name: string, payload: unknown) => {
    await checkRoots(); const cipher = await encryptSession(JSON.stringify(payload), passphrase); if (Buffer.byteLength(cipher) > 2_097_152) return fail("storage");
    const file = await open(join(slot, name), "wx", 0o600); try { await file.writeFile(cipher); await file.sync(); } finally { await file.close(); }
    if (!same(await readRecord(name), payload)) return fail("storage"); await checkRoots();
  };
  const guardPreserved = async () => {
    await checkRoots(); const now = await inventory(), expected = new Map(receipt.preserved.map(r => [r.area + "/" + r.name, r.sha256]));
    for (const entry of now) { const key = entry.area + "/" + entry.name;
      if (expected.has(key)) { if (expected.get(key) !== entry.sha256) return fail("binding"); expected.delete(key); }
      else if (entry.area !== "analysis" || !/^node-\d{6}\.enc$/u.test(entry.name) || Number(entry.name.slice(5, 11)) <= receipt.baseNodes) return fail("binding");
    }
    if (expected.size) return fail("binding"); await checkRoots();
  };
  const openOld = async (attemptRoot = oldAttempts, expectedAuthorization = authorization) => {
    const source = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" });
    let control, analysis, attempts;
    try {
      control = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open" });
      analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", readSourcePage: i => source.readPage(i) });
      attempts = await openStandingHistoryAnalysisAttemptStore({ directory: attemptRoot, passphrase, intent, mode: "open", analysis });
      const s = await source.status(), c = await control.status(), a = await analysis.status(), t = await attempts.status();
      if (s.storage !== "ready" || c.storage !== "ready" || a.storage !== "ready" || t.storage !== "ready" || c.state !== "queued") return fail("binding");
      if (s.readProgress.checkpoint.status === "more") return fail("source-incomplete");
      if (s.readProgress.chainHash !== expectedAuthorization.sourceHead || c.headHash !== expectedAuthorization.controlHead || !t.last?.nativeBinding ||
          t.last.attemptRef !== expectedAuthorization.attemptRef || t.last.planHash !== expectedAuthorization.planHash || t.last.modelOutcome !== "unknown" || t.last.prepared || t.last.node) return fail("binding");
      const settlement = fields(await verify(t.last.nativeBinding), ["schema", "nativeBinding", "resourcesSettled", "persisted", "replacementReady", "modelOutcome"]);
      const native = fields(settlement.nativeBinding, ["epochId", "requestRef", "purpose"]);
      if (settlement.schema !== "standing-analysis-owner-settlement-v1" || !same(native, t.last.nativeBinding) || settlement.resourcesSettled !== true || settlement.persisted !== true ||
          settlement.replacementReady !== true || settlement.modelOutcome !== "not-proven") return fail("binding");
      return { source: s, control: c, analysis: a, originalAttempt: t, settlement: Object.freeze({ ...settlement, nativeBinding: Object.freeze(native) }) as StandingHistoryAnalysisOwnerSettlement };
    } finally { const results = await Promise.allSettled([attempts?.close(), analysis?.close(), control?.close(), source.close()]); if (results.some(r => r.status === "rejected")) return fail("storage"); }
  };
  const newStatus = async () => {
    const source = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" });
    let analysis, attempts;
    try { analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", readSourcePage: i => source.readPage(i) });
      attempts = await openStandingHistoryAnalysisAttemptStore({ directory: attemptsDirectory, passphrase, intent, mode: "open", analysis }); return await attempts.status();
    } finally { const results = await Promise.allSettled([attempts?.close(), analysis?.close(), source.close()]); if (results.some(r => r.status === "rejected")) return fail("storage"); }
  };
  const openStep = () => openStandingHistoryAnalysisStep({ intent, directories: { pages: directories.pages, control: directories.control, analysis: directories.analysis, attempts: attemptsDirectory },
    passphrase, signal: joined, verifyOwnerSettled: verify, retainWorkingState: true, packing: "wide" });
  const bindConnection = (connection: StandingHistoryAnalysisStepConnection): StandingHistoryAnalysisStepConnection => {
    if (!connection || typeof connection !== "object" || types.isProxy(connection)) return fail("input");
    const parallel = Object.getOwnPropertyDescriptor(connection, "acquireParallelAnalysisAdmissions");
    if (!parallel) return connection;
    const acquire = Object.getOwnPropertyDescriptor(connection, "acquireAnalysisAdmission");
    if (!("value" in parallel) || typeof parallel.value !== "function" || !acquire || !("value" in acquire) || typeof acquire.value !== "function") return fail("input");
    return Object.freeze({ async acquireAnalysisAdmission(requestRef: string, previous?: StandingHistoryAnalysisOwnerSettlement["nativeBinding"]) {
      const raw: StandingHistoryAnalysisStepLease = await acquire.value.call(connection, requestRef, previous);
      let lease: Record<string, unknown>;
      try { lease = fields(raw, ["nativeBinding", "turnAnalysis", "releaseAnalysis", "abortAndJoin", "close"]);
        if (["turnAnalysis", "releaseAnalysis", "abortAndJoin", "close"].some(k => typeof lease[k] !== "function" || types.isProxy(lease[k]))) return raw;
      } catch { return raw; } // The step owns strict validation and acquired-lease cleanup.
      const turn = (lease.turnAnalysis as StandingHistoryAnalysisStepLease["turnAnalysis"]).bind(raw);
      return Object.freeze({ nativeBinding: lease.nativeBinding as StandingHistoryAnalysisStepLease["nativeBinding"],
        releaseAnalysis: (lease.releaseAnalysis as StandingHistoryAnalysisStepLease["releaseAnalysis"]).bind(raw),
        abortAndJoin: (lease.abortAndJoin as StandingHistoryAnalysisStepLease["abortAndJoin"]).bind(raw), close: (lease.close as StandingHistoryAnalysisStepLease["close"]).bind(raw),
        async turnAnalysis(req: string, body: string, callbacks: Parameters<StandingHistoryAnalysisStepLease["turnAnalysis"]>[2]) {
          // Native pool aliases require work identity. Resolve it only after
          // the normal step reserved the real new-generation v1 attempt.
          const status = await newStatus(), last = status.last; await guardPreserved();
          const binding = fields(lease.nativeBinding, ["epochId", "requestRef", "purpose"]);
          if (status.storage !== "ready" || !last?.nativeBinding || last.prepared || last.node || last.modelOutcome || req !== requestRef || req !== binding.requestRef ||
              !same(last.nativeBinding, binding)) return fail("binding");
          return turn(req, body, { ...callbacks, work: Object.freeze({ taskRef: intent.taskId, planRef: last.attemptRef, workRef: last.attemptRef }) });
        }
      });
    } });
  };
  try {
    live(); for (const path of paths) roots.set(path, await privateDirectory(path));
    for (const root of Object.values(originalAreas)) { roots.set(root, await privateDirectory(root)); const folder = join(root, intent.taskId); roots.set(folder, await privateDirectory(folder)); }
    if (predecessor && predecessorSlot) {
      roots.set(predecessorSlot, await privateDirectory(predecessorSlot));
      const readPrior = async (name: string) => { const path = join(predecessorSlot, name), cipher = await bytes(path); predecessorVersions.set(path, createHash("sha256").update(cipher).digest("hex")); return JSON.parse(await decryptSession(cipher.toString("utf8"), passphrase)) as unknown; };
      const prior = fields(await readPrior("authorization.enc"),
        ["schema", "intent", "authorization", "originalAttempt", "settlement", "baseNodes", "preserved"]);
      if (prior.schema !== "standing-history-task-continuation-v1" || hash(prior) !== predecessor.authorizationHash || !same(snapshotStandingHistoryTaskIntent(prior.intent), intent) ||
          !Number.isSafeInteger(prior.baseNodes) || Number(prior.baseNodes) < 0 || !Array.isArray(prior.preserved)) return fail("binding");
      const priorAuthorization = authorizationCopy(prior.authorization);
      if (priorAuthorization.continuationRef === authorization.continuationRef || priorAuthorization.requestHash === authorization.requestHash) return fail("binding");
      const activation = fields(await readPrior("activation.enc"), ["schema", "authorizationHash"]);
      if (activation.schema !== "standing-history-task-continuation-activation-v1" || activation.authorizationHash !== predecessor.authorizationHash) return fail("binding");
      const priorOriginal = await openOld(directories.attempts, priorAuthorization);
      if (!same(priorOriginal.originalAttempt, prior.originalAttempt) || !same(priorOriginal.settlement, prior.settlement)) return fail("binding");
      const expected = new Map((prior.preserved as Inventory).map(r => [r.area + "/" + r.name, r.sha256]));
      for (const entry of await inventory()) {
        if (entry.area === "predecessor" || entry.area === "predecessorAttempts") continue;
        const key = entry.area + "/" + entry.name;
        if (expected.has(key)) { if (expected.get(key) !== entry.sha256) return fail("binding"); expected.delete(key); }
        else if (entry.area !== "analysis" || !/^node-\d{6}\.enc$/u.test(entry.name) || Number(entry.name.slice(5, 11)) <= Number(prior.baseNodes)) return fail("binding");
      }
      if (expected.size) return fail("binding");
    }
    const original = await openOld();
    if (v.mode === "create") {
      if (original.analysis.headHash !== authorization.analysisHead || original.originalAttempt.last!.nodeIndex !== original.analysis.analysisNodes + 1) return fail("binding");
      const disposition = predecessor ? undefined : await readStandingHistoryTaskDisposition({ directory: directories.disposition, passphrase, intent, sourceHead: authorization.sourceHead, analysisHead: authorization.analysisHead, signal: joined });
      const delivery = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent, signal: joined });
      if (!predecessor && (disposition?.storage !== "ready" || disposition.disposition.reason !== "consumed-without-prepared") || delivery.storage !== "absent" || delivery.consumed) return fail("binding");
      const preserved = await inventory(), confirmed = await openOld(); await checkRoots();
      if (!same(confirmed, original)) return fail("binding");
      await mkdir(slot, { mode: 0o700 }); slotId = await privateDirectory(slot);
      receipt = Object.freeze({ schema: "standing-history-task-continuation-v1", intent, authorization, originalAttempt: original.originalAttempt,
        settlement: original.settlement, baseNodes: original.analysis.analysisNodes, preserved, ...(predecessor ? { predecessor } : {}) });
      await write("authorization.enc", receipt); await mkdir(attemptsDirectory, { mode: 0o700 });
      const source = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" });
      let analysis, attempts;
      try { analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", readSourcePage: i => source.readPage(i) });
        attempts = await openStandingHistoryAnalysisAttemptStore({ directory: attemptsDirectory, passphrase, intent, mode: "create", analysis });
      } finally { const results = await Promise.allSettled([attempts?.close(), analysis?.close(), source.close()]); if (results.some(r => r.status === "rejected")) return fail("storage"); }
      await guardPreserved(); await write("activation.enc", { schema: "standing-history-task-continuation-activation-v1", authorizationHash: hash(receipt) });
    } else {
      slotId = await privateDirectory(slot);
      const saved = fields(await readRecord("authorization.enc"), ["schema", "intent", "authorization", "originalAttempt", "settlement", "baseNodes", "preserved"], ["predecessor"]);
      if (saved.schema !== "standing-history-task-continuation-v1" || !same(snapshotStandingHistoryTaskIntent(saved.intent), intent) || !same(authorizationCopy(saved.authorization), authorization) ||
          !same(saved.predecessor, predecessor) || !same(saved.originalAttempt, original.originalAttempt) || !same(saved.settlement, original.settlement) || !Number.isSafeInteger(saved.baseNodes) || Number(saved.baseNodes) < 0 || !Array.isArray(saved.preserved)) return fail("binding");
      receipt = saved as Receipt;
      const activated = fields(await readRecord("activation.enc"), ["schema", "authorizationHash"]);
      if (activated.schema !== "standing-history-task-continuation-activation-v1" || activated.authorizationHash !== hash(receipt)) return fail("binding");
      await guardPreserved();
      try {
        const ready = fields(await readRecord("readiness.enc"), ["schema", "authorizationHash", "readiness"]);
        if (ready.schema !== "standing-history-task-continuation-readiness-v1" || ready.authorizationHash !== hash(receipt)) return fail("binding");
        readiness = ready.readiness as StandingHistoryTaskReadiness;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    roots.set(attemptsDirectory, await privateDirectory(attemptsDirectory));
    roots.set(join(attemptsDirectory, intent.taskId), await privateDirectory(join(attemptsDirectory, intent.taskId)));
    const status = await newStatus(); if (status.storage !== "ready") return fail("storage");
    if (!status.last && original.analysis.headHash !== authorization.analysisHead) return fail("binding");
    step = await openStep(); await guardPreserved();
  } catch (error) { closed = true; stop.abort(); await step?.close(); passphrase = ""; throw error; }
  const run = <T>(work: () => Promise<T>) => {
    live(); if (active) return Promise.reject(new StandingHistoryTaskContinuationError("busy"));
    const operation = Promise.resolve().then(work); active = operation;
    return operation.finally(() => { if (active === operation) active = undefined; });
  };
  return Object.freeze({
    next(input: Parameters<StandingHistoryAnalysisStep["next"]>[0]) { return run(async () => {
      const checkRecovery = !scanning; scanning = false;
      await guardPreserved(); const delivery = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent, signal: joined });
      if (delivery.storage !== "absent" || delivery.consumed) return fail("consumed");
      // scan-more cannot reserve or prepare an attempt. The retained step still
      // checks exact inventories, known file stamps and fresh cancellation on
      // every next(). Avoid reopening/decrypting the complete archive merely to
      // repeat cold prepared recovery between those read-only planner quanta.
      const status = checkRecovery ? await newStatus() : undefined;
      if (status && status.storage !== "ready") return fail("storage");
      const last = status?.last;
      if (last && (!last.node || !last.modelOutcome) && last.prepared && last.modelOutcome !== "refused") {
        const recovered = await step!.recoverPrepared({ attemptRef: last.attemptRef, signal: input.signal }); await step!.close(); step = await openStep(); await guardPreserved(); return recovered;
      }
      // An unprepared attempt consumes this explicit maintenance generation.
      // Generic analysis successors cannot authorize another attempt here.
      if (last && !last.prepared && !last.node) return fail("consumed");
      const result = await step!.next({ ...input, connection: bindConnection(input.connection) }); await guardPreserved();
      scanning = result.kind === "scan-more";
      if (result.kind === "read-more") return fail("source-incomplete");
      if (result.kind === "analysis-ready") {
        if (readiness) { if (!same(readiness, result)) return fail("binding"); }
        else { await write("readiness.enc", { schema: "standing-history-task-continuation-readiness-v1", authorizationHash: hash(receipt), readiness: result }); readiness = result; }
      }
      return result;
    }); },
    deliver(input: Pick<StandingHistoryTaskDeliveryInput, "ticket" | "verifyOwnerReady" | "signal" | "finalReport">) { return run(async () => {
      await guardPreserved(); if (!readiness) return fail("binding");
      const result = await runStandingHistoryTaskDelivery({ ...input, intent, readiness, directories: effectiveDirectories, passphrase, signal: AbortSignal.any([joined, input.signal]) });
      await guardPreserved(); return result;
    }); },
    close() { if (!closing) { closed = true; stop.abort(); closing = (async () => { try { if (active) await active.catch(() => {}); await step?.close(); } finally { passphrase = ""; } })(); } return closing; }
  });
}
