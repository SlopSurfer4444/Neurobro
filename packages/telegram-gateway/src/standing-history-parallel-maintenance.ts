import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { decryptSession, encryptSession } from "./session-crypto.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "./standing-history-analysis-store.js";
import { openStandingHistoryParallelWorkStore } from "./standing-history-parallel-work-store.js";
import type { StandingHistoryAnalysisNativeBinding } from "./standing-history-analysis-attempt-store.js";

type Directories = Readonly<{ pages: string; control: string; analysis: string }>;
export type StandingHistoryParallelMaintenanceInput = Readonly<{
  directory: string; originalJournalDirectory: string; directories: Directories; intent: StandingHistoryTaskIntent; passphrase: string; signal: AbortSignal;
}>;
export type StandingHistoryParallelMaintenanceAuthorization = Readonly<{
  generationRef: string; requestHash: string; sourceHead: string; analysisHead: string; controlHead: string; originalJournalHash: string;
}>;
export type StandingHistoryParallelMaintenanceSettlement = Readonly<{
  nativeBinding: StandingHistoryAnalysisNativeBinding; windowsBeforeAbsent: true; guestAbsent: true; windowsAfterAbsent: true;
  exclusiveCustody: true; receiptHash: string;
}>;
export class StandingHistoryParallelMaintenanceError extends Error {
  constructor(readonly code: "input" | "binding" | "storage" | "cancelled" | "settlement") {
    super("STANDING_HISTORY_PARALLEL_MAINTENANCE_" + code.toUpperCase());
  }
}
const fail = (code: StandingHistoryParallelMaintenanceError["code"]): never => { throw new StandingHistoryParallelMaintenanceError(code); };
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fields(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k]; if (!d || !("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function path(v: unknown): string { if (typeof v !== "string" || !isAbsolute(v) || resolve(v) !== v) return fail("input"); return v; }
function disjoint(paths: string[]) {
  for (const [i, a] of paths.entries()) for (const b of paths.slice(i + 1)) for (const [x, y] of [[a, b], [b, a]]) {
    const r = relative(x!, y!); if (!r || !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep)) return fail("input");
  }
}
function copy(value: StandingHistoryParallelMaintenanceInput) {
  const v = fields(value, ["directory", "originalJournalDirectory", "directories", "intent", "passphrase", "signal"]);
  if (typeof v.passphrase !== "string" || v.passphrase.length < 16 || Buffer.byteLength(v.passphrase) > 4096 || types.isProxy(v.signal) || !(v.signal instanceof AbortSignal)) return fail("input");
  const directory = path(v.directory), originalJournalDirectory = path(v.originalJournalDirectory), d = fields(v.directories, ["pages", "control", "analysis"]);
  const directories = { pages: path(d.pages), control: path(d.control), analysis: path(d.analysis) }; disjoint([directory, originalJournalDirectory, ...Object.values(directories)]);
  return { directory, originalJournalDirectory, directories, intent: snapshotStandingHistoryTaskIntent(v.intent), passphrase: v.passphrase, signal: v.signal };
}
function authorization(value: unknown): StandingHistoryParallelMaintenanceAuthorization {
  const v = fields(value, ["generationRef", "requestHash", "sourceHead", "analysisHead", "controlHead", "originalJournalHash"]);
  if (typeof v.generationRef !== "string" || !/^hmaint_[a-f0-9]{48}$/u.test(v.generationRef) || ![v.requestHash, v.sourceHead, v.analysisHead, v.controlHead, v.originalJournalHash].every(digest)) return fail("input");
  return Object.freeze(v) as StandingHistoryParallelMaintenanceAuthorization;
}
async function directoryId(p: string) { await assertPilotPrivateDirectory(p); const s = await lstat(p, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink()) return fail("storage"); return [s.dev, s.ino].join(":"); }
async function bytes(p: string) {
  const a = await lstat(p, { bigint: true }), stamp = (s: typeof a) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
  if (!a.isFile() || a.isSymbolicLink() || a.nlink !== 1n || a.size < 1n || a.size > 2_097_152n) return fail("storage");
  const f = await open(p, "r"); try { if (stamp(await f.stat({ bigint: true })) !== stamp(a)) return fail("storage"); const b = await f.readFile();
    if (b.length !== Number(a.size) || stamp(await f.stat({ bigint: true })) !== stamp(a) || stamp(await lstat(p, { bigint: true })) !== stamp(a)) return fail("storage"); return b;
  } finally { await f.close(); }
}
type Inventory = readonly Readonly<{ name: string; sha256: string }>[];
async function inventory(p: string, signal: AbortSignal): Promise<Inventory> {
  const id = await directoryId(p), result: { name: string; sha256: string }[] = [];
  for (const e of (await readdir(p, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (signal.aborted) return fail("cancelled");
    if (!e.isFile() || e.isSymbolicLink() || !/^[a-z0-9.-]+\.enc$/u.test(e.name) || result.length >= 8192) return fail("storage");
    result.push({ name: e.name, sha256: createHash("sha256").update(await bytes(join(p, e.name))).digest("hex") });
  }
  if (await directoryId(p) !== id) return fail("storage"); return result;
}
/** Digest for the operator's exact immutable original journal precondition. */
export async function hashStandingHistoryParallelMaintenanceJournal(input: Pick<StandingHistoryParallelMaintenanceInput, "originalJournalDirectory" | "intent" | "signal">) {
  return hash(await inventory(join(path(input.originalJournalDirectory), snapshotStandingHistoryTaskIntent(input.intent).taskId), input.signal));
}
type Receipt = {
  schema: "standing-history-parallel-maintenance-v1"; intent: StandingHistoryTaskIntent; originalJournalDirectory: string; directories: Directories;
  authorization: StandingHistoryParallelMaintenanceAuthorization; original: Inventory; preserved: Record<keyof Directories, Inventory>;
  settlements: StandingHistoryParallelMaintenanceSettlement[]; workRefs: string[];
};
async function write(p: string, value: unknown, passphrase: string) {
  const cipher = await encryptSession(JSON.stringify(value), passphrase); if (Buffer.byteLength(cipher) > 2_097_152) return fail("storage");
  const f = await open(p, "wx", 0o600); try { await f.writeFile(cipher); await f.sync(); } finally { await f.close(); }
  if (!equal(JSON.parse(await decryptSession((await bytes(p)).toString("utf8"), passphrase)), value)) return fail("storage");
}

/** Operator-only, with host/task disabled and sole custody throughout. The caller
 * authenticates the owner's request and physical settlement; supplied digests
 * are evidence bindings, not an authentication mechanism. Never a model tool.
 * A failed/incomplete create is retained and refused, never silently replayed. */
export async function createStandingHistoryParallelMaintenance(input: StandingHistoryParallelMaintenanceInput & Readonly<{
  directories: Directories; authorization: StandingHistoryParallelMaintenanceAuthorization;
  verifyOwnerSettled: (binding: StandingHistoryAnalysisNativeBinding) => Promise<StandingHistoryParallelMaintenanceSettlement>;
}>): Promise<string> {
  const raw = fields(input, ["directory", "originalJournalDirectory", "intent", "passphrase", "signal", "directories", "authorization", "verifyOwnerSettled"]);
  const v = copy({ directory: raw.directory as string, originalJournalDirectory: raw.originalJournalDirectory as string, intent: raw.intent as StandingHistoryTaskIntent,
    directories: raw.directories as Directories, passphrase: raw.passphrase as string, signal: raw.signal as AbortSignal });
  const d = fields(raw.directories, ["pages", "control", "analysis"]), directories = { pages: path(d.pages), control: path(d.control), analysis: path(d.analysis) };
  disjoint([v.directory, v.originalJournalDirectory, ...Object.values(directories)]);
  const auth = authorization(raw.authorization); if (typeof raw.verifyOwnerSettled !== "function" || types.isProxy(raw.verifyOwnerSettled)) return fail("input");
  const guard = () => { if (v.signal.aborted) return fail("cancelled"); };
  const roots = new Map<string, string>(); for (const p of [v.directory, v.originalJournalDirectory, ...Object.values(directories)]) roots.set(p, await directoryId(p));
  const checkRoots = async () => { guard(); for (const [p, id] of roots) if (await directoryId(p) !== id) return fail("storage"); };
  const shared = { intent: v.intent, passphrase: v.passphrase, signal: v.signal, mode: "open" as const };
  const source = await openStandingHistoryTaskStore({ ...shared, directory: directories.pages });
  let control: Awaited<ReturnType<typeof openStandingHistoryTaskControlStore>> | undefined;
  let analysis: Awaited<ReturnType<typeof openStandingHistoryAnalysisStore>> | undefined;
  let old: Awaited<ReturnType<typeof openStandingHistoryParallelWorkStore>> | undefined;
  let fresh: Awaited<ReturnType<typeof openStandingHistoryParallelWorkStore>> | undefined;
  try {
    control = await openStandingHistoryTaskControlStore({ ...shared, directory: directories.control });
    analysis = await openStandingHistoryAnalysisStore({ ...shared, directory: directories.analysis, readSourcePage: i => source.readPage(i) });
    old = await openStandingHistoryParallelWorkStore({ ...shared, directory: v.originalJournalDirectory, source, analysis });
    const checkHeads = async () => { guard(); const s = await source.status(), a = await analysis!.status(), c = await control!.status();
      if (s.storage !== "ready" || a.storage !== "ready" || c.storage !== "ready" || c.state !== "queued" || s.readProgress.chainHash !== auth.sourceHead || a.headHash !== auth.analysisHead || c.headHash !== auth.controlHead) return fail("binding"); };
    await checkHeads(); const status = await old.status();
    if (status.storage !== "ready" || !status.activeWave || status.activeWave.workRefs.length < 1) return fail("binding");
    const settlements: StandingHistoryParallelMaintenanceSettlement[] = [];
    for (const workRef of status.activeWave.workRefs) {
      const work = await old.readWork(workRef);
      if (work.output !== undefined || work.modelOutcome !== undefined || work.projection !== undefined || work.node !== undefined) return fail("binding");
      const proof = fields(await (raw.verifyOwnerSettled as typeof input.verifyOwnerSettled)(work.plan.nativeBinding),
        ["nativeBinding", "windowsBeforeAbsent", "guestAbsent", "windowsAfterAbsent", "exclusiveCustody", "receiptHash"]);
      if (!equal(proof.nativeBinding, work.plan.nativeBinding) || proof.windowsBeforeAbsent !== true || proof.guestAbsent !== true || proof.windowsAfterAbsent !== true || proof.exclusiveCustody !== true || !digest(proof.receiptHash)) return fail("settlement");
      settlements.push(proof as StandingHistoryParallelMaintenanceSettlement);
    }
    const original = await inventory(join(v.originalJournalDirectory, v.intent.taskId), v.signal);
    if (hash(original) !== auth.originalJournalHash) return fail("binding");
    const preserved = {} as Record<keyof Directories, Inventory>;
    for (const key of ["pages", "control", "analysis"] as const) preserved[key] = await inventory(join(directories[key], v.intent.taskId), v.signal);
    const receipt: Receipt = { schema: "standing-history-parallel-maintenance-v1", intent: v.intent, originalJournalDirectory: v.originalJournalDirectory, directories,
      authorization: auth, original, preserved, settlements, workRefs: [...status.activeWave.workRefs] };
    await checkRoots(); await checkHeads();
    const slot = join(v.directory, v.intent.taskId); await mkdir(slot, { mode: 0o700 }); roots.set(slot, await directoryId(slot));
    await write(join(slot, "authorization.enc"), receipt, v.passphrase);
    const journalDirectory = join(slot, "parallel"); await mkdir(journalDirectory, { mode: 0o700 }); roots.set(journalDirectory, await directoryId(journalDirectory));
    fresh = await openStandingHistoryParallelWorkStore({ ...shared, directory: journalDirectory, source, analysis, mode: "create" });
    await fresh.close(); fresh = undefined;
    await checkRoots(); await checkHeads();
    if (!equal(await inventory(join(v.originalJournalDirectory, v.intent.taskId), v.signal), original)) return fail("binding");
    for (const key of ["pages", "control", "analysis"] as const) if (!equal(await inventory(join(directories[key], v.intent.taskId), v.signal), preserved[key])) return fail("binding");
    // Activation is an operator action after exact heads and all old bytes are
    // checked again. Runtime is a reader and cannot manufacture this record.
    await write(join(slot, "activation.enc"), { schema: "standing-history-parallel-maintenance-activation-v1", authorizationHash: hash(receipt), generationRef: auth.generationRef }, v.passphrase);
    await checkRoots(); return journalDirectory;
  } finally {
    const closed = await Promise.allSettled([fresh?.close(), old?.close(), analysis?.close(), control?.close(), source.close()]);
    v.passphrase = ""; if (closed.some(x => x.status === "rejected")) fail("storage");
  }
}

/** Pure selection: absent authorization uses the original journal. A present
 * incomplete/tampered authorization fails closed, never falling back or creating
 * a successor. Baseline bytes stay immutable; valid appended progress is read by
 * the normal source/control/analysis stores after selection. */
export async function resolveStandingHistoryParallelMaintenance(input: StandingHistoryParallelMaintenanceInput): Promise<string | undefined> {
  const v = copy(input), slot = join(v.directory, v.intent.taskId); if (v.signal.aborted) return fail("cancelled");
  // The optional root need not exist until an operator installs an authorization.
  try { await lstat(v.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  const rootId = await directoryId(v.directory);
  try { await lstat(slot); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  const slotId = await directoryId(slot), names = await readdir(slot, { withFileTypes: true });
  if (names.length !== 3 || names.some(e => e.isSymbolicLink() || (e.name === "parallel" ? !e.isDirectory() : !["authorization.enc", "activation.enc"].includes(e.name) || !e.isFile()))) return fail("storage");
  const aBytes = await bytes(join(slot, "authorization.enc")), activationBytes = await bytes(join(slot, "activation.enc"));
  const r = fields(JSON.parse(await decryptSession(aBytes.toString("utf8"), v.passphrase)), ["schema", "intent", "originalJournalDirectory", "directories", "authorization", "original", "preserved", "settlements", "workRefs"]);
  const auth = authorization(r.authorization), d = fields(r.directories, ["pages", "control", "analysis"]), directories = { pages: path(d.pages), control: path(d.control), analysis: path(d.analysis) };
  disjoint([v.directory, v.originalJournalDirectory, ...Object.values(directories)]);
  if (r.schema !== "standing-history-parallel-maintenance-v1" || !equal(snapshotStandingHistoryTaskIntent(r.intent), v.intent) || r.originalJournalDirectory !== v.originalJournalDirectory || !equal(directories, v.directories) || hash(r.original) !== auth.originalJournalHash) return fail("binding");
  if (!equal(JSON.parse(await decryptSession(activationBytes.toString("utf8"), v.passphrase)), { schema: "standing-history-parallel-maintenance-activation-v1", authorizationHash: hash(r), generationRef: auth.generationRef })) return fail("binding");
  if (!equal(await inventory(join(v.originalJournalDirectory, v.intent.taskId), v.signal), r.original)) return fail("binding");
  const preserved = fields(r.preserved, ["pages", "control", "analysis"]);
  for (const key of ["pages", "control", "analysis"] as const) {
    if (!Array.isArray(preserved[key]) || (preserved[key] as unknown[]).length > 8192) return fail("binding");
    const current = new Map((await inventory(join(directories[key], v.intent.taskId), v.signal)).map(e => [e.name, e.sha256]));
    for (const entry of preserved[key] as unknown[]) { const p = fields(entry, ["name", "sha256"]); if (typeof p.name !== "string" || !digest(p.sha256) || current.get(p.name) !== p.sha256) return fail("binding"); }
  }
  const journalDirectory = join(slot, "parallel"); await directoryId(journalDirectory); await directoryId(join(journalDirectory, v.intent.taskId));
  if (await directoryId(v.directory) !== rootId || await directoryId(slot) !== slotId || !(await bytes(join(slot, "authorization.enc"))).equals(aBytes) || !(await bytes(join(slot, "activation.enc"))).equals(activationBytes)) return fail("storage");
  if (v.signal.aborted) return fail("cancelled"); return journalDirectory;
}
