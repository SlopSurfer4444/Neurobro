import { scrypt } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession } from "./session-crypto.js";
import { createStandingHistoryTaskRequest, assertStandingHistoryTaskRequestMatches } from "./standing-history-task-request.js";
import { snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskObservedSource, openStandingHistoryTaskStore,
  type StandingHistoryTaskIntent, type StandingHistoryTaskObservedSource, type StandingHistoryTaskStatus, type StandingHistoryTaskStore } from "./standing-history-task-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisStatus } from "./standing-history-analysis-store.js";
import { openStandingHistoryTaskControlStore, type StandingHistoryTaskControlStatus, type StandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisAttemptStatus } from "./standing-history-analysis-attempt-store.js";
import { readStandingHistoryTaskDelivery } from "./standing-history-task-delivery.js";
import { readStandingHistoryTaskDisposition, type StandingHistoryTaskDispositionReason } from "./standing-history-task-disposition.js";

type Primary = Readonly<{ chatId: string; ownerId: string; messageId: number; text?: string }>;
type Request = Readonly<{ fromDate: number; toDate: number; timezone: string; objective: string; source?: "internal" | "community" }>;
type Gap = Readonly<{ storage: "absent" | "unavailable" }>;
export type StandingHistoryManagedDeliveryStatus = Readonly<{
  state: "verified" | "unknown" | "failed-terminal" | "partial" | "not-attempted" | "unavailable";
  /** The task slot is reserved, not necessarily every part. nextPart is an
   * authenticated reader fact; final admission still rechecks its freshness. */
  consumed: boolean; partsTotal?: number; verifiedParts?: number; nextPart?: number;
}>;
export type StandingHistoryManagedDisposition = Readonly<{ storage: "absent" | "unavailable" }> |
  Readonly<{ storage: "ready"; reason: StandingHistoryTaskDispositionReason }>;
export type StandingHistoryManagedTaskStatus = Readonly<{
  taskRef: string; control: StandingHistoryTaskControlStatus;
  source?: "community";
  read: StandingHistoryTaskStatus | Gap; analysis: StandingHistoryAnalysisStatus | Gap;
  attempts?: StandingHistoryAnalysisAttemptStatus | Gap;
  delivery?: StandingHistoryManagedDeliveryStatus;
  disposition?: StandingHistoryManagedDisposition;
}>;
/** Host cache observations only, never task admission, scheduling or delivery
 * authority. Invalidation contains only the identities supplied by this caller;
 * a foreign actor never receives an authenticated intent in a snapshot. */
export type StandingHistoryTaskContextEvent = Readonly<{
  kind: "invalidate"; taskRef: string; requesterId: string;
}> | Readonly<{
  kind: "snapshot"; intent: StandingHistoryTaskIntent; status: StandingHistoryManagedTaskStatus;
}>;
export type StandingHistoryTaskCancellationResult = Readonly<{
  taskRef: string; control: StandingHistoryTaskControlStatus; source?: "community"; revocationJoined: true;
}>;
export type StandingHistoryTaskManager = Readonly<{
  create(input: Readonly<{ primary: Primary; request: Request; signal?: AbortSignal }>): Promise<StandingHistoryManagedTaskStatus>;
  status(input: Readonly<{ taskRef: string; requesterId: string; signal?: AbortSignal }>): Promise<StandingHistoryManagedTaskStatus>;
  cancel(input: Readonly<{ taskRef: string; requesterId: string; signal?: AbortSignal }>): Promise<StandingHistoryTaskCancellationResult>;
  close(): Promise<void>;
}>;
export class StandingHistoryTaskManagerError extends Error {
  constructor(readonly code: "input" | "binding" | "conflict" | "not-found" | "cancelled" | "storage" | "busy" | "closed" | "aborted" | "revocation") {
    super("STANDING_HISTORY_TASK_MANAGER_" + code.toUpperCase()); this.name = "StandingHistoryTaskManagerError";
  }
}
const fail = (code: StandingHistoryTaskManagerError["code"]): never => { throw new StandingHistoryTaskManagerError(code); };
const CONTROL_DOMAIN = "DecadansNeurobro/standing-history-task-control/v1";
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
function data(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function signalCopy(v: Record<string, unknown>): AbortSignal | undefined {
  if (!Object.hasOwn(v, "signal")) return undefined;
  if (types.isProxy(v.signal) || !(v.signal instanceof AbortSignal)) return fail("input"); return v.signal;
}
type Scope = { signal: AbortSignal; guard(): void; add<T extends { close(): Promise<void> }>(store: T): T };

/** Host-only composition, not a model-facing response or a task scheduler.
 * The wrapper supplies selected primary/actor identities; model arguments never
 * choose an account, chat or requester. Control intent is the reservation and
 * the direct lookup authority. Missing child stores can be created only by an
 * exact create retry; partial/corrupt existing slots are never repaired.
 * Queued, read progress and analysis notes remain distinct from runnable or
 * delivered. Status may reopen bounded store chains; cancellation does not.
 * No Telegram/model operation, prior action replay or completion authority. */
export async function openStandingHistoryTaskManager(input: Readonly<{
  directories: Readonly<{ control: string; pages: string; analysis: string; attempts?: string; delivery?: string; disposition?: string }>;
  passphrase: string; binding: Readonly<{ accountId: string; peerId: string }>;
  onCancelled(input: Readonly<{ taskRef: string; revision: 1 }>): Promise<void>;
  /** Synchronous host cache callback. Must not start/return asynchronous work
   * or reenter the manager. Exceptions are isolated from durable operations.
   * Snapshot payloads are detached and deeply frozen; they are observations of
   * successfully joined operations, not a promise of future freshness. */
  onObservation?(event: StandingHistoryTaskContextEvent): void;
  observedSource?: StandingHistoryTaskObservedSource;
  signal?: AbortSignal;
}>): Promise<StandingHistoryTaskManager> {
  const args = data(input, ["directories", "passphrase", "binding", "onCancelled"], ["signal", "onObservation", "observedSource"]);
  const d = data(args.directories, ["control", "pages", "analysis"], ["attempts", "delivery", "disposition"]), b = data(args.binding, ["accountId", "peerId"]);
  const signal = signalCopy(args);
  if (typeof args.passphrase !== "string" || args.passphrase.length < 16 || !args.passphrase.trim() || args.passphrase.includes("\0") || Buffer.byteLength(args.passphrase) > 4096 || Buffer.from(args.passphrase).toString("utf8") !== args.passphrase ||
      typeof b.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(b.accountId) || typeof b.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(b.peerId) || typeof args.onCancelled !== "function" || types.isProxy(args.onCancelled)) return fail("input");
  if (Object.hasOwn(args, "onObservation") && (typeof args.onObservation !== "function" || types.isProxy(args.onObservation) ||
      types.isAsyncFunction(args.onObservation) || types.isGeneratorFunction(args.onObservation))) return fail("input");
  for (const p of Object.values(d)) if (typeof p !== "string" || !isAbsolute(p) || resolve(p) !== p) return fail("input");
  const directories = Object.freeze({ control: d.control as string, pages: d.pages as string, analysis: d.analysis as string,
    ...(Object.hasOwn(d, "attempts") ? { attempts: d.attempts as string } : {}),
    ...(Object.hasOwn(d, "delivery") ? { delivery: d.delivery as string } : {}),
    ...(Object.hasOwn(d, "disposition") ? { disposition: d.disposition as string } : {}) });
  const paths = Object.values(directories);
  for (let i = 0; i < paths.length; i++) for (let j = 0; j < paths.length; j++) if (i !== j) {
    const rel = relative(paths[i]!, paths[j]!);
    if (!rel || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) return fail("input");
  }
  const binding = Object.freeze({ accountId: b.accountId, peerId: b.peerId });
  let observedSource: StandingHistoryTaskObservedSource | undefined;
  try { observedSource = Object.hasOwn(args, "observedSource") ? snapshotStandingHistoryTaskObservedSource(args.observedSource) : undefined; }
  catch { return fail("input"); }
  if (observedSource?.peerId === binding.peerId) return fail("input");
  const onCancelled = args.onCancelled as (input: Readonly<{ taskRef: string; revision: 1 }>) => Promise<void>;
  const onObservation = args.onObservation as ((event: StandingHistoryTaskContextEvent) => void) | undefined;
  const observe = (event: StandingHistoryTaskContextEvent): void => {
    if (!onObservation) return;
    try {
      // All inputs here come from this manager and its validated, bounded store
      // status types. Never share their object identity with the cache callback.
      const copy = structuredClone(event);
      const freeze = (value: unknown): void => {
        if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
      };
      freeze(copy); onObservation(copy);
    } catch { /* Optional cache failure cannot change persistence or replay. */ }
  };
  let passphrase = args.passphrase, key: Buffer | undefined, closed = false, active: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  const stop = new AbortController(), roots = new Map<string, BigIntStats>();
  const live = () => { if (closed) return fail("closed"); if (signal?.aborted) return fail("aborted"); };
  const shutdown = (): Promise<void> => {
    stop.abort();
    closing ??= (async () => { try { await active; } catch {} finally { key?.fill(0); key = undefined; passphrase = ""; signal?.removeEventListener("abort", abort); } })();
    return closing;
  };
  let initializing = true;
  const abort = () => { stop.abort(); if (!initializing) void shutdown(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    live();
    // Join every independent root check, including failures.
    const checked = await Promise.allSettled(paths.map(async path => { await assertPilotPrivateDirectory(path); return { path, stat: await lstat(path, { bigint: true }) }; }));
    for (const result of checked) { if (result.status !== "fulfilled") return fail("storage"); roots.set(result.value.path, result.value.stat); }
    live();
    key = await new Promise<Buffer>((resolveKey, reject) => scrypt(passphrase,
      JSON.stringify(["DecadansNeurobro/history-task-manager/identity/v1", binding.accountId, binding.peerId]), 32,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => error ? reject(error) : resolveKey(derived)));
    live(); initializing = false;
  } catch (error) {
    initializing = false; key?.fill(0); key = undefined; passphrase = ""; signal?.removeEventListener("abort", abort);
    if (error instanceof StandingHistoryTaskManagerError) throw error; return fail("storage");
  }
  const checkRoot = async (path: string, scope: Scope) => {
    scope.guard(); await assertPilotPrivateDirectory(path); const current = await lstat(path, { bigint: true });
    if (!sameDirectory(roots.get(path)!, current)) return fail("storage"); scope.guard();
  };
  const present = async (path: string, scope: Scope): Promise<boolean> => {
    scope.guard(); try { await lstat(path); scope.guard(); return true; } catch (error) { scope.guard(); if (missing(error)) return false; throw error; }
  };
  // Direct fixed-name lookup authenticates the control reservation before any
  // actor check/store creation. It never scans a directory or consults RAM refs.
  const resolveIntent = async (taskRef: string, scope: Scope): Promise<StandingHistoryTaskIntent> => {
    await checkRoot(directories.control, scope); const slot = join(directories.control, taskRef);
    let owner: BigIntStats;
    try { owner = await lstat(slot, { bigint: true }); } catch (error) { if (missing(error)) return fail("not-found"); throw error; }
    await assertPilotPrivateDirectory(slot);
    const checkSlot = async () => { scope.guard(); await checkRoot(directories.control, scope); await assertPilotPrivateDirectory(slot); if (!sameDirectory(owner, await lstat(slot, { bigint: true }))) return fail("storage"); scope.guard(); };
    await checkSlot(); const path = join(slot, "intent.enc"), before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 65536n) return fail("storage");
    const file = await open(path, "r"); let bytes: Buffer | undefined;
    try {
      const inside = await file.stat({ bigint: true }); if (!inside.isFile() || stamp(inside) !== stamp(before)) return fail("storage");
      bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < bytes.length) { scope.guard(); const got = await file.read(bytes, count, bytes.length - count, null); if (!got.bytesRead) break; count += got.bytesRead; }
      if (count !== Number(before.size)) return fail("storage");
      const plain = await decryptSession(bytes.subarray(0, count).toString("utf8"), passphrase); scope.guard();
      if (Buffer.byteLength(plain) > 32768) return fail("storage");
      const saved = data(JSON.parse(plain), ["domain", "taskId", "kind", "intent", "revision", "state"]);
      if (saved.domain !== CONTROL_DOMAIN || saved.taskId !== taskRef || saved.kind !== "intent" || saved.revision !== 0 || saved.state !== "queued") return fail("binding");
      const intent = snapshotStandingHistoryTaskIntent(saved.intent);
      if (intent.taskId !== taskRef || intent.accountId !== binding.accountId || intent.chatId !== binding.peerId) return fail("binding");
      const after = await lstat(path, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || stamp(after) !== stamp(before)) return fail("storage");
      await checkSlot(); return intent;
    } finally { bytes?.fill(0); await file.close(); }
  };
  const openControl = async (intent: StandingHistoryTaskIntent, mode: "open" | "create", scope: Scope): Promise<StandingHistoryTaskControlStore> => {
    await checkRoot(directories.control, scope);
    const store = scope.add(await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode, signal: scope.signal })); scope.guard(); return store;
  };
  const progress = async (intent: StandingHistoryTaskIntent, scope: Scope, createMissing: boolean): Promise<Pick<StandingHistoryManagedTaskStatus, "read" | "analysis" | "attempts" | "delivery" | "disposition">> => {
    let pages: StandingHistoryTaskStore | undefined, read: StandingHistoryTaskStatus | Gap, analysis: StandingHistoryAnalysisStatus | Gap;
    let analysisStore: Awaited<ReturnType<typeof openStandingHistoryAnalysisStore>> | undefined;
    try {
      await checkRoot(directories.pages, scope); const exists = await present(join(directories.pages, intent.taskId), scope);
      if (!exists && !createMissing) read = Object.freeze({ storage: "absent" });
      else {
        pages = scope.add(await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: exists ? "open" : "create", signal: scope.signal }));
        scope.guard(); read = await pages.status(); scope.guard();
        if (createMissing && read.storage !== "ready") return fail("storage");
      }
    } catch (error) { scope.guard(); if (createMissing) throw error; read = Object.freeze({ storage: "unavailable" }); }
    try {
      await checkRoot(directories.analysis, scope); const exists = await present(join(directories.analysis, intent.taskId), scope);
      if (!exists && !createMissing) analysis = Object.freeze({ storage: "absent" });
      else {
        const store = scope.add(await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: exists ? "open" : "create",
          readSourcePage: index => pages ? pages.readPage(index) : Promise.resolve(undefined), signal: scope.signal }));
        analysisStore = store;
        scope.guard(); analysis = await store.status(); scope.guard();
        if (createMissing && analysis.storage !== "ready") return fail("storage");
      }
    } catch (error) { scope.guard(); if (createMissing) throw error; analysis = Object.freeze({ storage: "unavailable" }); }
    let attempts: StandingHistoryAnalysisAttemptStatus | Gap | undefined;
    if (directories.attempts !== undefined) {
      try {
        await checkRoot(directories.attempts, scope); const exists = await present(join(directories.attempts, intent.taskId), scope);
        if (!exists && !createMissing) attempts = Object.freeze({ storage: "absent" });
        else {
          if (!analysisStore || analysis.storage !== "ready") return fail("storage");
          const store = scope.add(await openStandingHistoryAnalysisAttemptStore({ directory: directories.attempts, passphrase, intent,
            mode: exists ? "open" : "create", analysis: analysisStore, signal: scope.signal }));
          scope.guard(); attempts = await store.status(); scope.guard();
          if (createMissing && attempts.storage !== "ready") return fail("storage");
        }
      } catch (error) { scope.guard(); if (createMissing) throw error; attempts = Object.freeze({ storage: "unavailable" }); }
    }
    let delivery: StandingHistoryManagedDeliveryStatus | undefined;
    if (directories.delivery !== undefined) {
      // Called only after the control intent and requesting actor were
      // authenticated. Even create only reads this optional final outbox.
      delivery = Object.freeze({ state: "unavailable", consumed: true });
      try {
        await checkRoot(directories.delivery, scope);
        const saved = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent, signal: scope.signal });
        scope.guard(); await checkRoot(directories.delivery, scope);
        if (saved.storage === "absent" && saved.consumed === false && saved.delivery === "not-attempted") delivery = Object.freeze({ state: "not-attempted", consumed: false });
        else if (saved.storage === "ready" && saved.consumed === true && ["verified", "unknown", "failed-terminal", "partial"].includes(saved.delivery)) {
          const state = saved.delivery as StandingHistoryManagedDeliveryStatus["state"];
          const facts = saved as unknown as Record<string, unknown>;
          const multipart = Object.hasOwn(facts, "partsTotal") || Object.hasOwn(facts, "verifiedParts") || Object.hasOwn(facts, "nextPart");
          if (!multipart && state !== "partial") delivery = Object.freeze({ state, consumed: true });
          else if (multipart && Number.isInteger(facts.partsTotal) && Number(facts.partsTotal) >= 2 && Number(facts.partsTotal) <= 16 && Number.isInteger(facts.verifiedParts) && Number(facts.verifiedParts) >= 0 && Number(facts.verifiedParts) <= Number(facts.partsTotal) &&
              (state === "verified" ? facts.verifiedParts === facts.partsTotal : Number(facts.verifiedParts) < Number(facts.partsTotal)) &&
              (state === "partial" ? Object.hasOwn(facts, "nextPart") && facts.nextPart === Number(facts.verifiedParts) + 1 : !Object.hasOwn(facts, "nextPart"))) {
            delivery = Object.freeze({ state, consumed: true, partsTotal: facts.partsTotal as number, verifiedParts: facts.verifiedParts as number,
              ...(state === "partial" ? { nextPart: facts.nextPart as number } : {}) });
          }
        }
        // Neither a verified message nor model/node counts prove lease/owner
        // settlement. No descriptor, private text or process facts escape here.
      } catch { scope.guard(); }
    }
    let disposition: StandingHistoryManagedDisposition | undefined;
    if (directories.disposition !== undefined) {
      disposition = Object.freeze({ storage: "unavailable" });
      // A task-local reason belongs to an authenticated pair of actual heads.
      // Absent/corrupt chains never supply a made-up head to the reader.
      if (read.storage === "ready" && analysis.storage === "ready") {
        try {
          await checkRoot(directories.disposition, scope);
          const saved = await readStandingHistoryTaskDisposition({ directory: directories.disposition, passphrase, intent,
            sourceHead: read.readProgress.chainHash, analysisHead: analysis.headHash, signal: scope.signal });
          scope.guard(); await checkRoot(directories.disposition, scope);
          disposition = saved.storage === "ready" ? Object.freeze({ storage: "ready", reason: saved.disposition.reason }) : Object.freeze({ storage: saved.storage });
        } catch { scope.guard(); }
      }
    }
    return { read, analysis, ...(attempts === undefined ? {} : { attempts }), ...(delivery === undefined ? {} : { delivery }), ...(disposition === undefined ? {} : { disposition }) };
  };
  const operation = <T>(callSignal: AbortSignal | undefined, work: (scope: Scope) => Promise<T>, settled?: (result: T) => void): Promise<T> => {
    live(); if (callSignal?.aborted) return Promise.reject(new StandingHistoryTaskManagerError("aborted"));
    if (active) return Promise.reject(new StandingHistoryTaskManagerError("busy"));
    const controller = new AbortController(), handles: { close(): Promise<void> }[] = [];
    const revoke = () => controller.abort(); stop.signal.addEventListener("abort", revoke, { once: true }); callSignal?.addEventListener("abort", revoke, { once: true });
    const scope: Scope = { signal: controller.signal,
      guard() { live(); if (controller.signal.aborted || callSignal?.aborted) return fail("aborted"); },
      add(store) { handles.push(store); return store; } };
    const pending = Promise.resolve().then(async () => {
      try { scope.guard(); const result = await work(scope); scope.guard(); return result; }
      catch (error) { scope.guard(); if (error instanceof StandingHistoryTaskManagerError) throw error; return fail("storage"); }
      finally {
        const results = await Promise.allSettled(handles.reverse().map(store => store.close()));
        stop.signal.removeEventListener("abort", revoke); callSignal?.removeEventListener("abort", revoke);
        if (results.some(result => result.status === "rejected")) return fail("storage");
      }
    }).then(result => {
      // The work and every store.close() have succeeded. Do not refresh a cache
      // after cancellation/shutdown while cleanup was running. This observation
      // guard deliberately does not change the operation's existing verdict.
      if (!closed && !signal?.aborted && !controller.signal.aborted && !callSignal?.aborted) settled?.(result);
      return result;
    });
    active = pending; void pending.finally(() => { if (active === pending) active = undefined; }).catch(() => {}); return pending;
  };
  const lookup = (value: unknown) => {
    const v = data(value, ["taskRef", "requesterId"], ["signal"]), callSignal = signalCopy(v);
    if (typeof v.taskRef !== "string" || !/^htask_[0-9a-f]{48}$/u.test(v.taskRef) || typeof v.requesterId !== "string" || !/^[1-9]\d{0,19}$/u.test(v.requesterId)) return fail("input");
    return { taskRef: v.taskRef, requesterId: v.requesterId, signal: callSignal };
  };
  return Object.freeze<StandingHistoryTaskManager>({
    async create(value) {
      const v = data(value, ["primary", "request"], ["signal"]), callSignal = signalCopy(v); live();
      let requested: StandingHistoryTaskIntent;
      try {
        const request = data(v.request, ["fromDate", "toDate", "timezone", "objective"], ["source"]);
        if (Object.hasOwn(request, "source") && request.source !== "internal" && request.source !== "community") return fail("input");
        const source = request.source === "community" ? observedSource : undefined;
        if (request.source === "community" && source === undefined) return fail("input");
        requested = createStandingHistoryTaskRequest({ identityKey: key!.toString("hex"), binding, primary: v.primary as Primary,
          request: { fromDate: request.fromDate as number, toDate: request.toDate as number, timezone: request.timezone as string, objective: request.objective as string },
          ...(source === undefined ? {} : { source }) });
      } catch { return fail("input"); }
      let observedIntent: StandingHistoryTaskIntent | undefined;
      return operation(callSignal, async scope => {
        observe({ kind: "invalidate", taskRef: requested.taskId, requesterId: requested.requesterId });
        let intent: StandingHistoryTaskIntent, control: StandingHistoryTaskControlStore;
        try {
          intent = await resolveIntent(requested.taskId, scope);
          try { assertStandingHistoryTaskRequestMatches(intent, requested); } catch { return fail("conflict"); }
          control = await openControl(intent, "open", scope);
        } catch (error) {
          if (!(error instanceof StandingHistoryTaskManagerError) || error.code !== "not-found") throw error;
          intent = requested; control = await openControl(intent, "create", scope);
        }
        let state = await control.status(); scope.guard();
        if (state.storage !== "ready") return fail("storage"); if (state.state === "cancelled") return fail("cancelled");
        const material = await progress(intent, scope, true);
        state = await control.status(); scope.guard();
        if (state.storage !== "ready") return fail("storage"); if (state.state === "cancelled") return fail("cancelled");
        observedIntent = intent;
        return Object.freeze({ taskRef: intent.taskId, ...(intent.source ? { source: "community" as const } : {}), control: state, ...material });
      }, status => { if (observedIntent) observe({ kind: "snapshot", intent: observedIntent, status }); });
    },
    async status(value) {
      const request = lookup(value);
      let observedIntent: StandingHistoryTaskIntent | undefined;
      return operation(request.signal, async scope => {
        observe({ kind: "invalidate", taskRef: request.taskRef, requesterId: request.requesterId });
        const intent = await resolveIntent(request.taskRef, scope); if (intent.requesterId !== request.requesterId) return fail("binding");
        const control = await openControl(intent, "open", scope), state = await control.status(); scope.guard();
        const material = await progress(intent, scope, false); const current = await control.status(); scope.guard();
        if (current.headHash !== state.headHash) return fail("conflict");
        observedIntent = intent;
        return Object.freeze({ taskRef: intent.taskId, ...(intent.source ? { source: "community" as const } : {}), control: current, ...material });
      }, status => { if (observedIntent) observe({ kind: "snapshot", intent: observedIntent, status }); });
    },
    async cancel(value) {
      const request = lookup(value);
      return operation(request.signal, async scope => {
        observe({ kind: "invalidate", taskRef: request.taskRef, requesterId: request.requesterId });
        const intent = await resolveIntent(request.taskRef, scope); if (intent.requesterId !== request.requesterId) return fail("binding");
        const control = await openControl(intent, "open", scope), before = await control.status(); scope.guard();
        if (before.storage !== "ready") return fail("storage");
        const cancelled = await control.cancel({ expectedRevision: before.revision });
        if (cancelled.storage !== "ready" || cancelled.state !== "cancelled" || cancelled.revision !== 1) return fail("storage");
        // Once persistence succeeds, join this required host revocation even if
        // the caller aborts while it is running. Retrying it is idempotent; it
        // is not a model/send retry and cannot change the durable task identity.
        try { await onCancelled(Object.freeze({ taskRef: intent.taskId, revision: 1 })); } catch { return fail("revocation"); }
        scope.guard(); const confirmed = await control.status(); scope.guard();
        if (confirmed.storage !== "ready" || confirmed.state !== "cancelled" || confirmed.headHash !== cancelled.headHash) return fail("storage");
        return Object.freeze({ taskRef: intent.taskId, ...(intent.source ? { source: "community" as const } : {}), control: confirmed, revocationJoined: true });
      });
    },
    close() { closed = true; return shutdown(); }
  });
}
