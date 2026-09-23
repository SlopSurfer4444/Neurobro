import { createHash, createHmac, createDecipheriv, scrypt } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import { assertPilotPrivateDirectory, createEncryptedPilotStore, runPilotReply, isPilotDeliveryDiagnostic, tagPilotTaskSendError, type PilotRecord, type PilotResult, type PilotStore } from "./pilot-outbox.js";
import { encryptSession, decryptSession } from "./session-crypto.js";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent, type StandingHistoryTaskStore } from "./standing-history-task-store.js";
import { openStandingHistoryTaskControlStore, type StandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisStore, type StandingHistoryAnalysisNode } from "./standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding } from "./standing-history-analysis-attempt-store.js";
import type { StandingHistoryAnalysisPlan } from "./standing-history-analysis-planner.js";
import type { StandingIdleHistoryTicket, StandingTaskReplyLease } from "./standing-conversation-adapter.js";
import { wrapPilotStore, type StandingOwnActionCaptureObserver } from "./standing-own-action-capture.js";
import { projectStandingChronicleNote, type StandingChronicleNote } from "./standing-chronicle-note.js";
import { readStandingHistoryDeliveryRecovery, runStandingHistoryDeliveryRecovery, snapshotStandingHistoryDeliveryRecoveryAuthorization,
  type StandingHistoryDeliveryRecoveryAuthorization, type StandingHistoryDeliveryRecoveryBinding } from "./standing-history-task-delivery-recovery.js";

export type StandingHistoryTaskReadiness = Extract<StandingHistoryAnalysisPlan, { kind: "analysis-ready" }>;
export type StandingHistoryTaskDeliveryPart = Readonly<{ index: number; kind: "combined" | "body" | "coverage"; text: string; textHash: string }>;
export type StandingHistoryTaskDeliveryDescriptor = Readonly<{
  schema: "standing-history-task-delivery-v1" | "standing-history-task-delivery-v2" | "standing-history-task-delivery-v3"; taskRef: string; sourceHead: string; analysisHead: string; rootRef: string; rootHash: string;
  body: string; text: string; textHash: string; coverage: StandingHistoryTaskReadiness["coverage"]; gaps: StandingHistoryTaskReadiness["gaps"];
  parts?: readonly StandingHistoryTaskDeliveryPart[];
}>;
export type StandingHistoryTaskDeliveryStatus = Readonly<{
  storage: "absent" | "ready" | "unavailable"; consumed: boolean;
  delivery: "not-attempted" | "not-inspected" | "unknown" | "verified" | "failed-terminal" | "partial";
  descriptor?: StandingHistoryTaskDeliveryDescriptor; result?: PilotResult; leaseJoined?: true;
  partsTotal?: number; verifiedParts?: number; nextPart?: number;
}>;
/** Host-admitted user-facing report, distinct from internal analysis notes.
 * The host must synthesize/review it against the objective; these bindings
 * establish identity, not semantic quality. */
export type StandingHistoryFinalReport = Readonly<{
  schema: "standing-history-final-report-v1";
  taskRef: string; sourceHead: string; analysisHead: string; body: string;
}>;
export type StandingHistoryTaskDeliveryInput = Readonly<{
  intent: StandingHistoryTaskIntent; readiness: StandingHistoryTaskReadiness;
  finalReport?: StandingHistoryFinalReport;
  /** Legacy body can reconcile an existing descriptor, never initiate delivery. */
  body?: string;
  directories: Readonly<{ pages: string; control: string; analysis: string; attempts: string; delivery: string }>;
  passphrase: string; ticket: Pick<StandingIdleHistoryTicket, "openTaskReply">; signal: AbortSignal;
  verifyOwnerReady(binding: StandingHistoryAnalysisNativeBinding): Promise<unknown>;
  /** Synchronous host observation of this persisted part, not whole-task
   * completion or lease settlement. Observer failures cannot change delivery. */
  onOwnAction?: StandingOwnActionCaptureObserver;
}>;
export class StandingHistoryTaskDeliveryError extends Error {
  constructor(readonly code: "input" | "coverage" | "overflow" | "stale" | "cancelled" | "consumed" | "storage" | "owner" | "close" | "report-required") {
    super("STANDING_HISTORY_TASK_DELIVERY_" + code.toUpperCase());
  }
}
const fail = (code: StandingHistoryTaskDeliveryError["code"]): never => { throw new StandingHistoryTaskDeliveryError(code); };
// V1 retains body and full text; with a 4096-byte intent objective, valid
// control characters can expand all three strings sixfold in JSON. These are
// V3 stores one copy of up to 32KiB report text in parts; JSON escaping plus
// the objective/metadata stays below 256KiB. Each Telegram part remains 4096B.
const DOMAIN = "DecadansNeurobro/standing-history-task-delivery/v1", MAX_CIPHER = 393216, MAX_PARTS = 16, MAX_REPORT_BYTES = 32768;
const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const count = (v: unknown, max = 102400): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const validText = (v: unknown, maximum = 4096): v is string => typeof v === "string" && v.length <= maximum && !!v.trim() && !v.includes("\0") && Buffer.from(v).toString() === v;
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(":");
function data(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
function array(v: unknown, maximum: number): unknown[] {
  if (!Array.isArray(v) || types.isProxy(v) || Object.getPrototypeOf(v) !== Array.prototype) return fail("input");
  const length = Object.getOwnPropertyDescriptor(v, "length")!.value as number, ds = Object.getOwnPropertyDescriptors(v);
  if (length > maximum || Reflect.ownKeys(ds).length !== length + 1) return fail("input");
  return Array.from({ length }, (_, i) => { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail("input"); return d.value; });
}
function method<T extends (...args: never[]) => unknown>(v: unknown, name: string): T {
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail("input"); const d = Object.getOwnPropertyDescriptor(v, name);
  if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail("input"); return d.value.bind(v) as T;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function signalCopy(v: unknown): AbortSignal { if (types.isProxy(v) || !(v instanceof AbortSignal)) return fail("input"); return v; }
function config(directory: unknown, passphrase: unknown): { directory: string; passphrase: string } {
  if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory || typeof passphrase !== "string" || passphrase.length < 16 ||
      !validText(passphrase) || Buffer.byteLength(passphrase) > 4096) return fail("input"); return { directory, passphrase };
}
const gapLabels: Readonly<Record<string, string>> = Object.freeze({ "inaccessible-history": "история недоступна", "inexact-history": "неполная история",
  "undated-entries": "без даты", nonText: "нет текста", invalidText: "некорректный текст", unavailable: "недоступные записи", outsidePeriod: "вне периода" });
function readyCopy(value: unknown): StandingHistoryTaskReadiness {
  const r = data(value, ["kind", "sourceHead", "expectedHead", "coverage", "gaps"], ["rootRef"]);
  if (r.kind !== "analysis-ready" || !digest(r.sourceHead) || !digest(r.expectedHead) || r.rootRef !== undefined && (typeof r.rootRef !== "string" || !/^hnode_[0-9a-f]{48}$/.test(r.rootRef))) return fail("input");
  const c = data(r.coverage, ["committedPages", "coveredPages", "sourceRows", "coveredRows", "readStatus", "readTraversalComplete", "excluded"]);
  if (!count(c.committedPages, 1024) || c.coveredPages !== c.committedPages || !count(c.sourceRows) || c.coveredRows !== c.sourceRows ||
      !["empty-page", "lower-bound-reached", "inaccessible"].includes(c.readStatus as string) || typeof c.readTraversalComplete !== "boolean") return fail("coverage");
  const e = data(c.excluded, ["nonText", "invalidText", "unavailable", "outsidePeriod"]);
  if (Object.values(e).some(v => !count(v))) return fail("input");
  const gaps = array(r.gaps, 7).map(value => { const g = data(value, ["kind"], ["count"]);
    if (typeof g.kind !== "string" || !Object.hasOwn(gapLabels, g.kind) || Object.hasOwn(g, "count") && (!count(g.count) || g.count === 0)) return fail("input");
    return Object.freeze({ kind: g.kind, ...(Object.hasOwn(g, "count") ? { count: g.count as number } : {}) }); });
  if (new Set(gaps.map(g => g.kind)).size !== gaps.length) return fail("input");
  return Object.freeze({ kind: "analysis-ready", sourceHead: r.sourceHead, expectedHead: r.expectedHead, ...(r.rootRef ? { rootRef: r.rootRef as string } : {}),
    coverage: Object.freeze({ ...c, excluded: Object.freeze(e) }) as StandingHistoryTaskReadiness["coverage"], gaps: Object.freeze(gaps) });
}
const partDirectory = (index: number) => "part-" + String(index).padStart(2, "0");
/** Preserve every UTF-8 byte, preferring paragraph/line boundaries near the end
 * of each message. Never split a code point or trim whitespace. */
function splitReportBody(body: string): string[] {
  const chunks: string[] = []; let remaining = body;
  while (Buffer.byteLength(remaining) > 4096) {
    const bytes = Buffer.from(remaining); let end = 4096;
    while ((bytes[end]! & 0xc0) === 0x80) end--;
    let chunk = bytes.subarray(0, end).toString("utf8");
    for (const delimiter of ["\n\n", "\n"]) {
      const at = chunk.lastIndexOf(delimiter);
      if (at >= 0 && Buffer.byteLength(chunk.slice(0, at + delimiter.length)) >= 3072) {
        chunk = chunk.slice(0, at + delimiter.length); break;
      }
    }
    // Telegram cannot send a whitespace-only message. Keep an ordinary final
    // newline/space suffix attached to a real character rather than rejecting
    // a valid report at an otherwise exact 4096-byte boundary. A whitespace
    // run too large to attach losslessly is refused before any descriptor.
    if (!remaining.slice(chunk.length).trim()) {
      const tailStart = /\S\s*$/u.exec(chunk)?.index;
      if (tailStart === undefined || tailStart === 0 || Buffer.byteLength(remaining.slice(tailStart)) > 4096) return fail("input");
      chunk = chunk.slice(0, tailStart);
    }
    if (!validText(chunk)) return fail("input");
    chunks.push(chunk); remaining = remaining.slice(chunk.length);
  }
  if (!validText(remaining)) return fail("input");
  chunks.push(remaining); return chunks;
}
/** Exact host-selected body plus mandatory coverage disclosure. No truncation,
 * model invocation, semantic-truth claim, or send authority is produced here. */
export function prepareStandingHistoryTaskDeliveryText(value: Readonly<{ intent: StandingHistoryTaskIntent; readiness: StandingHistoryTaskReadiness; body: string }>): Readonly<{ text: string; textHash: string; parts: readonly StandingHistoryTaskDeliveryPart[] }> {
  const v = data(value, ["intent", "readiness", "body"]), intent = snapshotStandingHistoryTaskIntent(v.intent), readiness = readyCopy(v.readiness);
  if (!validText(v.body, MAX_REPORT_BYTES) || Buffer.byteLength(v.body) > MAX_REPORT_BYTES) return fail("input");
  const c = readiness.coverage, gaps = readiness.gaps.map(g => gapLabels[g.kind] + (g.count === undefined ? "" : ": " + g.count)).join("; ");
  const footer = `Охват: ${c.coveredRows}/${c.sourceRows} записей, ${c.coveredPages}/${c.committedPages} страниц; ${new Date(intent.fromDate * 1000).toISOString()} — ${new Date(intent.toDate * 1000).toISOString()} (${intent.timezone}).\nИстория: ${c.readTraversalComplete ? "обход завершён" : "полнота не подтверждена"}. Пробелы: ${gaps || "не отмечены"}. Сводка модели; утверждения не проверены.`;
  if (Buffer.byteLength(footer) > 4096) return fail("overflow");
  const sourceFooter = (intent.source ? "Источник: подключённое сообщество (только чтение).\n" : "") + footer;
  const text = v.body + "\n\n" + sourceFooter;
  const part = (index: number, kind: StandingHistoryTaskDeliveryPart["kind"], text: string): StandingHistoryTaskDeliveryPart => Object.freeze({ index, kind, text, textHash: sha(text) });
  if (Buffer.byteLength(sourceFooter) > 4096) return fail("overflow");
  const chunks = splitReportBody(v.body);
  const parts = Buffer.byteLength(text) <= 4096 ? [part(1, "combined", text)] :
    [...chunks.map((chunk, index) => part(index + 1, "body", chunk)), part(chunks.length + 1, "coverage", sourceFooter)];
  if (parts.length > MAX_PARTS) return fail("overflow");
  // Aggregate text/hash retain the exact body + separator + footer even when
  // that aggregate is not sent as one message. Each sent part has its own hash.
  return Object.freeze({ text, textHash: sha(text), parts: Object.freeze(parts) });
}
function descriptorCopy(value: unknown, intent: StandingHistoryTaskIntent): StandingHistoryTaskDeliveryDescriptor {
  const d = data(value, ["schema", "taskRef", "sourceHead", "analysisHead", "rootRef", "rootHash", "body", "text", "textHash", "coverage", "gaps"], ["parts"]);
  const readiness = readyCopy({ kind: "analysis-ready", sourceHead: d.sourceHead, expectedHead: d.analysisHead, rootRef: d.rootRef, coverage: d.coverage, gaps: d.gaps });
  if (!["standing-history-task-delivery-v1", "standing-history-task-delivery-v2", "standing-history-task-delivery-v3"].includes(d.schema as string) || d.taskRef !== intent.taskId || !digest(d.rootHash) || !validText(d.body, MAX_REPORT_BYTES)) return fail("input");
  const prepared = prepareStandingHistoryTaskDeliveryText({ intent, readiness, body: d.body });
  if (d.text !== prepared.text || d.textHash !== prepared.textHash || d.rootHash !== d.analysisHead) return fail("input");
  const multipart = d.schema !== "standing-history-task-delivery-v1";
  if (multipart ? (d.schema === "standing-history-task-delivery-v2" ? prepared.parts.length !== 2 : prepared.parts.length < 3) || !equal(array(d.parts, MAX_PARTS).map(p => data(p, ["index", "kind", "text", "textHash"])), prepared.parts)
    : prepared.parts.length !== 1 || Object.hasOwn(d, "parts")) return fail("input");
  return Object.freeze({ schema: d.schema as StandingHistoryTaskDeliveryDescriptor["schema"], taskRef: intent.taskId, sourceHead: readiness.sourceHead, analysisHead: readiness.expectedHead,
    rootRef: readiness.rootRef!, rootHash: d.rootHash, body: d.body, text: prepared.text, textHash: prepared.textHash, coverage: readiness.coverage, gaps: readiness.gaps,
    ...(multipart ? { parts: prepared.parts } : {}) });
}
function persistedDescriptor(descriptor: StandingHistoryTaskDeliveryDescriptor): unknown {
  if (descriptor.schema === "standing-history-task-delivery-v1") return descriptor;
  const { body: _body, text: _text, textHash: _textHash, ...compact } = descriptor; return compact;
}
function storedDescriptor(value: unknown, intent: StandingHistoryTaskIntent): StandingHistoryTaskDeliveryDescriptor {
  const d = data(value, ["schema", "taskRef", "sourceHead", "analysisHead", "rootRef", "rootHash", "coverage", "gaps"], ["body", "text", "textHash", "parts"]);
  if (d.schema === "standing-history-task-delivery-v1") return descriptorCopy(d, intent);
  if (!["standing-history-task-delivery-v2", "standing-history-task-delivery-v3"].includes(d.schema as string) || ["body", "text", "textHash"].some(k => Object.hasOwn(d, k))) return fail("input");
  const parts = array(d.parts, MAX_PARTS).map(p => data(p, ["index", "kind", "text", "textHash"]));
  if (parts.length < 2 || parts.some(part => !validText(part.text) || Buffer.byteLength(part.text as string) > 4096)) return fail("input");
  const body = parts.slice(0, -1).map(part => part.text as string).join(""), text = body + "\n\n" + parts.at(-1)!.text;
  return descriptorCopy({ ...d, parts, body, text, textHash: sha(text) }, intent);
}
const descriptorHash = (descriptor: StandingHistoryTaskDeliveryDescriptor) => sha(canonical(persistedDescriptor(descriptor)));
const partPassphrase = (passphrase: string, intent: StandingHistoryTaskIntent, descriptor: StandingHistoryTaskDeliveryDescriptor, index: number) => createHmac("sha256", passphrase)
  .update(JSON.stringify(["DecadansNeurobro/standing-history-task-delivery/pilot-part/v2", intent.taskId, descriptorHash(descriptor), index])).digest("hex");
async function absent(path: string): Promise<boolean> { try { await lstat(path); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; throw e; } }
async function boundedNames(path: string, maximum: number): Promise<string[]> {
  const dir = await opendir(path, { bufferSize: 1 }), names: string[] = [];
  try { for (;;) { const entry = await dir.read(); if (!entry) return names; if (names.length === maximum) return fail("storage"); names.push(entry.name); } }
  finally { await dir.close(); }
}
async function immutableInventory(path: string, prefix: "page" | "node", count: number): Promise<void> {
  const names = new Set(await boundedNames(path, count + 1));
  if (names.size !== count + 1 || !names.has("intent.enc")) return fail("stale");
  for (let i = 1; i <= count; i++) if (!names.has(prefix + "-" + String(i).padStart(6, "0") + ".enc")) return fail("stale");
}
async function pinnedDirectory(path: string): Promise<BigIntStats> { await assertPilotPrivateDirectory(path); const s = await lstat(path, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink()) return fail("storage"); return s; }
async function checkDirectory(path: string, expected: BigIntStats): Promise<void> { if (!sameDirectory(await pinnedDirectory(path), expected)) return fail("storage"); }
async function readFile(path: string, guard: () => Promise<void>, versions?: Map<string, string>): Promise<string> {
  await guard(); const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_CIPHER)) return fail("storage");
  const file = await open(path, "r"); let bytes: Buffer;
  try { if (stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail("storage"); bytes = await file.readFile(); if (stamp(await file.stat({ bigint: true })) !== stamp(before)) return fail("storage"); }
  finally { await file.close(); }
  if (stamp(await lstat(path, { bigint: true })) !== stamp(before) || bytes.length > MAX_CIPHER || Buffer.from(bytes.toString()).compare(bytes) !== 0) return fail("storage");
  versions?.set(path, stamp(before)); await guard(); return bytes.toString();
}
async function writeFile(path: string, value: unknown, passphrase: string, guard: () => Promise<void>): Promise<BigIntStats> {
  const plain = canonical(value); if (Buffer.byteLength(plain) > 262144) return fail("storage");
  const cipher = await encryptSession(plain, passphrase); if (Buffer.byteLength(cipher) > MAX_CIPHER) return fail("storage"); await guard();
  const file = await open(path, "wx", 0o600); let written: BigIntStats;
  try { await file.writeFile(cipher, "utf8"); await file.sync(); written = await file.stat({ bigint: true }); } finally { await file.close(); }
  if (await readFile(path, guard) !== cipher || stamp(await lstat(path, { bigint: true })) !== stamp(written)) return fail("storage");
  return written;
}
function pilotRecord(value: unknown, descriptor: Pick<StandingHistoryTaskDeliveryDescriptor, "text" | "textHash">, intent: StandingHistoryTaskIntent): PilotRecord {
  const p = data(value, ["version", "state", "idempotencyKey", "randomId", "chatId", "accountId", "replyToMessageId", "contentHash", "textBytes"], ["messageId", "wireReplyToMessageId"]);
  const key = sha(JSON.stringify([intent.chatId, "owner-prompt", intent.primaryMessageId, "reply", descriptor.textHash]));
  if (p.version !== "pilot-outbox-v1" || !["planned", "sending", "verified", "unknown", "failed_terminal"].includes(p.state as string) || p.idempotencyKey !== key ||
      typeof p.randomId !== "string" || !/^[1-9][0-9]{0,18}$/.test(p.randomId) || BigInt(p.randomId) > 9223372036854775807n || p.chatId !== intent.chatId || p.accountId !== intent.accountId ||
      p.replyToMessageId !== intent.primaryMessageId || p.contentHash !== descriptor.textHash || p.textBytes !== Buffer.byteLength(descriptor.text) ||
      (p.state === "verified" ? !count(p.messageId, 2147483647) || p.messageId === 0 : Object.hasOwn(p, "messageId")) ||
      Object.hasOwn(p, "wireReplyToMessageId") && (p.state !== "verified" || p.wireReplyToMessageId !== null)) return fail("storage");
  return Object.freeze(p) as PilotRecord;
}
async function decryptPilot(value: string, passphrase: string): Promise<unknown> {
  const e = data(JSON.parse(value), ["version", "algorithm", "kdf", "salt", "iv", "tag", "ciphertext"]);
  if (e.version !== 1 || e.algorithm !== "aes-256-gcm" || e.kdf !== "scrypt") return fail("storage");
  const decode = (v: unknown, size?: number) => { if (typeof v !== "string") return fail("storage"); const b = Buffer.from(v, "base64"); if (b.toString("base64") !== v || size !== undefined && b.length !== size || b.length > 16384) return fail("storage"); return b; };
  const salt = decode(e.salt, 16), iv = decode(e.iv, 12), tag = decode(e.tag, 16), cipher = decode(e.ciphertext);
  const key = await new Promise<Buffer>((done, reject) => scrypt(passphrase, salt, 32, (error, key) => error ? reject(error) : done(key)));
  try { const d = createDecipheriv("aes-256-gcm", key, iv); d.setAAD(Buffer.from("DecadansNeurobro/pilot-outbox/v1")); d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(cipher), d.final()]); if (Buffer.from(plain.toString()).compare(plain) !== 0) return fail("storage"); return JSON.parse(plain.toString()); }
  finally { key.fill(0); }
}
function resultCopy(value: unknown): PilotResult {
  const r = data(value, ["state", "code"], ["deliveryDiagnostic"]);
  if (!((r.state === "verified" && r.code === "verified") || (r.state === "refused" && ["input-refused", "stopped-before-send", "store-refused"].includes(r.code as string)) ||
      (r.state === "unknown" && ["send-or-readback-unknown", "persistence-unknown"].includes(r.code as string)) || (r.state === "failed_terminal" && ["stopped-before-send", "pre-dispatch-refused"].includes(r.code as string))) ||
      Object.hasOwn(r, "deliveryDiagnostic") && !isPilotDeliveryDiagnostic(r.deliveryDiagnostic)) return fail("storage");
  return Object.freeze(r) as PilotResult;
}
/** Bounded, noncreating restart inspection. Every existing part slot is consumed.
 * V2 can continue only the next conclusively absent fixed part after a verified
 * prefix. Its authenticated descriptor alone permits part one, never a new body.
 * A verified pilot terminal can recover the delivery fact without a result
 * receipt; it cannot recover the missing lease-join fact. Missing/partial proof
 * never permits another send, even with a changed body. */
type DeliveryReadInput = Readonly<{ directory: string; passphrase: string; intent: StandingHistoryTaskIntent; signal?: AbortSignal }>;
export async function readStandingHistoryTaskDelivery(value: DeliveryReadInput): Promise<StandingHistoryTaskDeliveryStatus> { return readDelivery(value); }
/** Read-only operator inspection; this identity is not send authority. */
export async function inspectStandingHistoryTaskDeliveryRecovery(value: DeliveryReadInput & Readonly<{ partIndex: number }>): Promise<StandingHistoryDeliveryRecoveryBinding | undefined> {
  const v = data(value, ["directory", "passphrase", "intent", "partIndex"], ["signal"]);
  if (!count(v.partIndex, MAX_PARTS) || v.partIndex === 0) return fail("input");
  const { partIndex, ...read } = v; let candidate: StandingHistoryDeliveryRecoveryBinding | undefined;
  const status = await readDelivery(read as DeliveryReadInput, binding => { if (binding.partIndex === partIndex) candidate = binding; });
  return status.storage === "ready" ? candidate : undefined;
}
async function readDelivery(value: DeliveryReadInput, candidate?: (binding: StandingHistoryDeliveryRecoveryBinding) => void): Promise<StandingHistoryTaskDeliveryStatus> {
  const v = data(value, ["directory", "passphrase", "intent"], ["signal"]), c = config(v.directory, v.passphrase), intent = snapshotStandingHistoryTaskIntent(v.intent);
  const signal = Object.hasOwn(v, "signal") ? signalCopy(v.signal) : undefined;
  const empty = Object.freeze({ storage: "absent", consumed: false, delivery: "not-attempted" }) as StandingHistoryTaskDeliveryStatus;
  try {
    if (signal?.aborted) return fail("cancelled"); if (await absent(c.directory)) return empty;
    const parent = await pinnedDirectory(c.directory), slot = join(c.directory, intent.taskId);
    if (await absent(slot)) { await checkDirectory(c.directory, parent); return empty; }
    const own = await pinnedDirectory(slot), versions = new Map<string, string>(), directoryVersions = new Map<string, BigIntStats>();
    const guard = async () => { await checkDirectory(c.directory, parent); await checkDirectory(slot, own);
      for (const [path, identity] of directoryVersions) await checkDirectory(path, identity);
      for (const [path, version] of versions) if (stamp(await lstat(path, { bigint: true })) !== version) return fail("storage"); };
    const names = await boundedNames(slot, MAX_PARTS + 1);
    if (!names.includes("descriptor.enc")) return Object.freeze({ storage: "unavailable", consumed: true, delivery: "not-inspected" });
    const envelope = data(JSON.parse(await decryptSession(await readFile(join(slot, "descriptor.enc"), guard, versions), c.passphrase)), ["domain", "kind", "intent", "descriptor"]);
    if (envelope.domain !== DOMAIN || envelope.kind !== "descriptor" || !equal(snapshotStandingHistoryTaskIntent(envelope.intent), intent)) return fail("storage");
    const descriptor = storedDescriptor(envelope.descriptor, intent), multipart = descriptor.schema !== "standing-history-task-delivery-v1";
    if (names.some(n => !(multipart ? ["descriptor.enc", ...descriptor.parts!.map(part => partDirectory(part.index))] : ["descriptor.enc", "pilot", "result.enc", "recovery-v1"]).includes(n))) return fail("storage");
    async function readPart(base: string, part?: StandingHistoryTaskDeliveryPart) {
      const partNames = base === slot ? names : await boundedNames(base, 3);
      if (base !== slot && partNames.some(n => !["pilot", "result.enc", "recovery-v1"].includes(n))) return fail("storage");
      const expectedText = part ?? descriptor, pilotKey = part ? partPassphrase(c.passphrase, intent, descriptor, part.index) : c.passphrase;
      let terminal: PilotRecord | undefined, planned: PilotRecord | undefined, sending = false;
      const originalFiles: Record<string, string> = {};
      if (partNames.includes("pilot")) {
        const path = join(base, "pilot"); directoryVersions.set(path, await pinnedDirectory(path));
        const files = await boundedNames(path, 3); if (files.some(n => !["planned.enc", "sending.enc", "terminal.enc"].includes(n))) return fail("storage");
        if (files.length && !files.includes("planned.enc")) return fail("storage");
        for (const name of ["planned.enc", "sending.enc", "terminal.enc"]) if (files.includes(name)) {
          const cipher = await readFile(join(path, name), guard, versions); originalFiles[name] = sha(cipher);
          const record = pilotRecord(await decryptPilot(cipher, pilotKey), expectedText, intent);
          if (name === "planned.enc") { if (record.state !== "planned") return fail("storage"); planned = record; }
          else {
            if (!planned || record.randomId !== planned.randomId || name === "sending.enc" && record.state !== "sending") return fail("storage");
            if (name === "sending.enc") sending = true;
            if (name === "terminal.enc") { if (!["verified", "unknown", "failed_terminal"].includes(record.state) || record.state !== "failed_terminal" && !files.includes("sending.enc")) return fail("storage"); terminal = record; }
          }
        }
        await guard(); if (!equal((await boundedNames(path, 3)).sort(), files.sort())) return fail("storage");
      }
      let result: PilotResult | undefined, leaseJoined: true | undefined;
      if (partNames.includes("result.enc")) {
        const cipher = await readFile(join(base, "result.enc"), guard, versions); originalFiles["result.enc"] = sha(cipher);
        const receipt = data(JSON.parse(await decryptSession(cipher, c.passphrase)), ["domain", "kind", "taskId", "intentHash", "descriptorHash", "result", "leaseJoined"], part ? ["partIndex"] : []);
        if (receipt.domain !== DOMAIN || receipt.kind !== "result" || receipt.taskId !== intent.taskId || receipt.intentHash !== sha(canonical(intent)) || receipt.descriptorHash !== descriptorHash(descriptor) || receipt.leaseJoined !== true || part && receipt.partIndex !== part.index) return fail("storage");
        result = resultCopy(receipt.result); leaseJoined = true;
        if (result.state === "verified" && terminal?.state !== "verified" || result.state === "failed_terminal" && terminal?.state !== "failed_terminal" || result.state === "refused" && terminal?.state === "verified") return fail("storage");
      }
      const binding: StandingHistoryDeliveryRecoveryBinding | undefined = planned && sending && terminal?.state === "unknown" && result?.state === "unknown" && leaseJoined === true ? Object.freeze({
        taskRef: intent.taskId, intentHash: sha(canonical(intent)), descriptorHash: descriptorHash(descriptor), partIndex: part?.index ?? 1,
        originalRecordsHash: sha(canonical(originalFiles)), idempotencyKey: planned.idempotencyKey, randomId: planned.randomId,
        accountId: intent.accountId, chatId: intent.chatId, replyToMessageId: intent.primaryMessageId, contentHash: expectedText.textHash, textBytes: Buffer.byteLength(expectedText.text) }) : undefined;
      if (binding) candidate?.(binding);
      if (partNames.includes("recovery-v1")) {
        if (!binding) return fail("storage");
        const recoveryPath = join(base, "recovery-v1"); directoryVersions.set(recoveryPath, await pinnedDirectory(recoveryPath));
        // Keep the receipt files pinned through the whole outer multipart read,
        // including later parts, rather than only while its helper is active.
        const recoveryNames = await boundedNames(recoveryPath, 3);
        for (const name of recoveryNames) await readFile(join(recoveryPath, name), guard, versions);
        const recovered = await readStandingHistoryDeliveryRecovery({ directory: recoveryPath, passphrase: pilotKey, binding, guard });
        if (!equal((await boundedNames(recoveryPath, 3)).sort(), recoveryNames.sort())) return fail("storage");
        if (recovered) { result = { state: "verified", code: "verified" }; leaseJoined = true;
          terminal = { ...planned!, state: "verified", messageId: recovered.messageId,
            ...(recovered.wireReplyToMessageId === null ? { wireReplyToMessageId: null } : {}) }; }
      }
      await guard(); if (!equal((await boundedNames(base, base === slot ? 4 : 3)).sort(), partNames.sort())) return fail("storage");
      const delivery = result?.state === "unknown" ? "unknown" : terminal?.state === "verified" ? "verified" : terminal?.state === "failed_terminal" ? "failed-terminal" : "unknown";
      return { delivery, result, leaseJoined };
    }
    let output: StandingHistoryTaskDeliveryStatus;
    if (!multipart) {
      const part = await readPart(slot);
      output = { storage: "ready", consumed: true, delivery: part.delivery as StandingHistoryTaskDeliveryStatus["delivery"], descriptor,
        ...(part.result ? { result: part.result } : {}), ...(part.leaseJoined ? { leaseJoined: true } : {}) };
    } else {
      let verifiedParts = 0, nextPart: number | undefined, result: PilotResult | undefined, allJoined = true;
      let delivery: StandingHistoryTaskDeliveryStatus["delivery"] = "partial";
      for (const part of descriptor.parts!) {
        const name = partDirectory(part.index), path = join(slot, name);
        if (!names.includes(name)) {
          if (descriptor.parts!.some(later => later.index > part.index && names.includes(partDirectory(later.index)))) return fail("storage");
          if (verifiedParts === part.index - 1) nextPart = part.index;
          break;
        }
        if (verifiedParts !== part.index - 1) return fail("storage");
        directoryVersions.set(path, await pinnedDirectory(path));
        const saved = await readPart(path, part); result = saved.result; allJoined &&= saved.leaseJoined === true;
        if (saved.delivery !== "verified") { delivery = saved.delivery as StandingHistoryTaskDeliveryStatus["delivery"]; if (descriptor.parts!.some(later => later.index > part.index && names.includes(partDirectory(later.index)))) return fail("storage"); break; }
        verifiedParts++;
      }
      if (verifiedParts === descriptor.parts!.length) delivery = "verified";
      output = { storage: "ready", consumed: true, delivery, descriptor, partsTotal: descriptor.parts!.length, verifiedParts,
        ...(nextPart ? { nextPart } : {}), ...(result ? { result } : {}), ...(verifiedParts === descriptor.parts!.length && allJoined ? { leaseJoined: true } : {}) };
    }
    await guard(); if (!equal((await boundedNames(slot, MAX_PARTS + 1)).sort(), names.sort())) return fail("storage"); if (signal?.aborted) return fail("cancelled");
    return Object.freeze(output);
  } catch { return Object.freeze({ storage: "unavailable", consumed: true, delivery: "not-inspected" }); }
}

function coverageCheck(ready: StandingHistoryTaskReadiness, root: StandingHistoryAnalysisNode, source: Awaited<ReturnType<StandingHistoryTaskStore["status"]>>): void {
  const c = ready.coverage, cp = source.readProgress.checkpoint;
  if (source.storage !== "ready" || source.readProgress.chainHash !== ready.sourceHead || source.readProgress.committedPages !== c.committedPages || cp.status !== c.readStatus) return fail("stale");
  const pages = new Map<number, { total: number; end: number; excluded: { nonText: number; invalidText: number; unavailable: number; outsidePeriod: number }; hash: string }>();
  for (const span of [...root.coverage].sort((a, b) => a.pageIndex - b.pageIndex || a.range.fromRow - b.range.fromRow)) {
    let page = pages.get(span.pageIndex);
    if (!page) { page = { total: span.range.totalRows, end: 0, excluded: span.coverage.sourcePageExcluded, hash: span.pageHash }; pages.set(span.pageIndex, page); }
    else if (page.total === 0 || page.total !== span.range.totalRows || page.hash !== span.pageHash || !equal(page.excluded, span.coverage.sourcePageExcluded)) return fail("coverage");
    if (span.pageIndex < 1 || span.pageIndex > c.committedPages || span.range.fromRow !== page.end) return fail("coverage"); page.end = span.range.toRow;
  }
  let rows = 0; const excluded = { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 };
  for (const p of pages.values()) { if (p.end !== p.total) return fail("coverage"); rows += p.total; for (const k of Object.keys(excluded) as (keyof typeof excluded)[]) excluded[k] += p.excluded[k]; }
  if (pages.size !== c.committedPages || rows !== c.sourceRows || !equal(excluded, c.excluded)) return fail("coverage");
  const terminal = cp.status === "empty-page" || cp.status === "lower-bound-reached", gaps: { kind: string; count?: number }[] = [];
  if (!terminal) gaps.push({ kind: "inaccessible-history" }); if (cp.inexact) gaps.push({ kind: "inexact-history" }); if (cp.undated) gaps.push({ kind: "undated-entries", count: cp.undated });
  for (const [kind, n] of Object.entries(excluded)) if (n) gaps.push({ kind, count: n });
  if (c.readTraversalComplete !== (terminal && !cp.inexact && cp.undated === 0) || !equal(gaps, ready.gaps)) return fail("coverage");
}
export type StandingDeliveredChronicleNoteInput = Readonly<{
  intent: StandingHistoryTaskIntent;
  directories: Readonly<{ pages: string; analysis: string; delivery: string }>;
  passphrase: string; signal: AbortSignal;
}>;
/** Optional background recall of one known consumed task. The authenticated
 * delivery descriptor selects the exact source/analysis frontier; it does not
 * upgrade UNKNOWN delivery or model-authored claims. Existing stores may scan
 * their bounded immutable chains during open; this is not a foreground lookup
 * or a wall-clock fairness guarantee. No send or recovery authority is issued.
 * Invalid optional data yields no note. Cleanup failure remains distinguishable
 * as StandingHistoryTaskDeliveryError("close") after both closes are joined. */
export async function readStandingDeliveredChronicleNote(value: StandingDeliveredChronicleNoteInput): Promise<StandingChronicleNote | undefined> {
  let passphrase = "", signal: AbortSignal | undefined, source: StandingHistoryTaskStore | undefined,
    analysis: StandingHistoryAnalysisStore | undefined, note: StandingChronicleNote | undefined;
  try {
    const v = data(value, ["intent", "directories", "passphrase", "signal"]), intent = snapshotStandingHistoryTaskIntent(v.intent);
    const dirs = data(v.directories, ["pages", "analysis", "delivery"]);
    for (const path of Object.values(dirs)) config(path, v.passphrase);
    const directories = dirs as StandingDeliveredChronicleNoteInput["directories"];
    passphrase = v.passphrase as string; signal = signalCopy(v.signal);
    const live = () => { if (signal!.aborted) return fail("cancelled"); };
    const readDelivery = () => readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent, signal: signal! });
    const eligible = (s: StandingHistoryTaskDeliveryStatus) => s.storage === "ready" && s.consumed && s.nextPart === undefined && s.descriptor !== undefined;
    live(); const delivered = await readDelivery(); live();
    if (!eligible(delivered)) return undefined;
    const descriptor = delivered.descriptor!;
    const readiness = readyCopy({ kind: "analysis-ready", sourceHead: descriptor.sourceHead, expectedHead: descriptor.analysisHead,
      rootRef: descriptor.rootRef, coverage: descriptor.coverage, gaps: descriptor.gaps });
    source = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open", signal }); live();
    analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", signal,
      readSourcePage: index => source!.readPage(index) }); live();
    const root = await analysis.readNode(descriptor.rootRef); live();
    if (!root || root.nodeRef !== descriptor.rootRef || root.hash !== descriptor.rootHash) return undefined;
    const freshHeads = async () => {
      live(); const s = await source!.status(), a = await analysis!.status();
      if (a.storage !== "ready" || a.headHash !== descriptor.analysisHead || root.hash !== a.headHash) return fail("stale");
      coverageCheck(readiness, root, s);
      // Cached statuses pin known files; exact inventories also reject newly
      // appended/unknown tails before accepting the saved final frontier.
      await immutableInventory(join(directories.pages, intent.taskId), "page", s.readProgress.committedPages);
      await immutableInventory(join(directories.analysis, intent.taskId), "node", a.analysisNodes);
      await source!.status(); await analysis!.status(); live();
    };
    await freshHeads();
    const current = await readDelivery(); live();
    if (!eligible(current) || !equal(current.descriptor, descriptor)) return undefined;
    await freshHeads();
    note = projectStandingChronicleNote({ intent, readiness, node: root, referenceKey: analysis.referenceKey() });
  } catch { note = undefined; }
  finally {
    // Independently admit both closes, including when a close throws before
    // returning its promise. Cancellation never detaches admitted I/O/crypto.
    const closed = await Promise.allSettled([analysis, source].map(store => Promise.resolve().then(() => store?.close())));
    passphrase = "";
    if (closed.some(result => result.status === "rejected")) return fail("close");
  }
  return signal?.aborted ? undefined : note;
}
/** A runner-ready snapshot is trusted host input, never a model send tool.
 * Fresh authenticated heads/root coverage, cancellation, exact last attempt and
 * owner readiness are additional gates. One task-derived slot fixes all text;
 * each part has its own exclusive slot, consumed even when empty or UNKNOWN.
 * At most one part uses the supplied ticket. result and leaseJoined describe
 * this invocation's part; only deliveryComplete describes the entire task.
 * The original requester/primary
 * remain fixed by intent and by the sole adapter's task-reply lease. */
type DeliveryRunResult = Readonly<{
  descriptor: StandingHistoryTaskDeliveryDescriptor; result: PilotResult; leaseJoined: true; partIndex: number; partsTotal: number; deliveryComplete: boolean;
}>;
export async function runStandingHistoryTaskDelivery(value: StandingHistoryTaskDeliveryInput): Promise<DeliveryRunResult> { return deliver(value, false); }
/** Host-only explicit maintenance entry. Ordinary delivery never starts recovery. */
export async function recoverStandingHistoryTaskDelivery(value: StandingHistoryTaskDeliveryInput & Readonly<{ maintenance: StandingHistoryDeliveryRecoveryAuthorization }>): Promise<DeliveryRunResult> { return deliver(value, true); }
async function deliver(value: StandingHistoryTaskDeliveryInput, recovering: boolean): Promise<DeliveryRunResult> {
  const v = data(value, ["intent", "readiness", "directories", "passphrase", "ticket", "signal", "verifyOwnerReady", ...(recovering ? ["maintenance"] : [])], ["body", "finalReport", "onOwnAction"]);
  if (Object.hasOwn(v, "onOwnAction") && (typeof v.onOwnAction !== "function" || types.isProxy(v.onOwnAction) || types.isAsyncFunction(v.onOwnAction) || types.isGeneratorFunction(v.onOwnAction))) return fail("input");
  const onOwnAction = v.onOwnAction as StandingOwnActionCaptureObserver | undefined;
  const intent = snapshotStandingHistoryTaskIntent(v.intent), readiness = readyCopy(v.readiness), dirs = data(v.directories, ["pages", "control", "analysis", "attempts", "delivery"]);
  for (const path of Object.values(dirs)) config(path, v.passphrase);
  const directories = dirs as StandingHistoryTaskDeliveryInput["directories"];
  for (const [i, a] of Object.values(directories).entries()) for (const b of Object.values(directories).slice(i + 1)) {
    for (const [x, y] of [[a, b], [b, a]]) { const r = relative(x!, y!); if (!r || !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep)) return fail("input"); }
  }
  if (Object.hasOwn(v, "body") && (!validText(v.body, MAX_REPORT_BYTES) || Buffer.byteLength(v.body) > MAX_REPORT_BYTES)) return fail("input"); const body = v.body as string | undefined;
  let finalReport: StandingHistoryFinalReport | undefined;
  if (Object.hasOwn(v, "finalReport")) {
    const report = data(v.finalReport, ["schema", "taskRef", "sourceHead", "analysisHead", "body"]);
    if (report.schema !== "standing-history-final-report-v1" || !validText(report.body, MAX_REPORT_BYTES) || Buffer.byteLength(report.body) > MAX_REPORT_BYTES) return fail("input");
    if (report.taskRef !== intent.taskId || report.sourceHead !== readiness.sourceHead || report.analysisHead !== readiness.expectedHead) return fail("stale");
    if (body !== undefined && body !== report.body) return fail("input");
    finalReport = Object.freeze(report) as StandingHistoryFinalReport;
  }
  const signal = signalCopy(v.signal), openReply = method<StandingIdleHistoryTicket["openTaskReply"]>(v.ticket, "openTaskReply"), verifyOwnerReady = method<StandingHistoryTaskDeliveryInput["verifyOwnerReady"]>(value, "verifyOwnerReady");
  let passphrase = v.passphrase as string, source: StandingHistoryTaskStore | undefined, control: StandingHistoryTaskControlStore | undefined, analysis: StandingHistoryAnalysisStore | undefined, attempts: StandingHistoryAnalysisAttemptStore | undefined;
  let closeReply: (() => Promise<void>) | undefined, closingReply: Promise<void> | undefined;
  const callbacks = new Set<Promise<unknown>>();
  const callback = <T>(work: () => Promise<T>): Promise<T> => { const pending = Promise.resolve().then(work); callbacks.add(pending);
    void pending.finally(() => callbacks.delete(pending)).catch(() => {}); return pending; };
  const joinCallbacks = async () => { await Promise.allSettled([...callbacks]); };
  const closeLease = () => { if (!closeReply) return Promise.resolve(); if (!closingReply) { try { closingReply = Promise.resolve(closeReply()); } catch { closingReply = Promise.reject(new StandingHistoryTaskDeliveryError("close")); } void closingReply.catch(() => {}); } return closingReply; };
  const abort = () => { void closeLease(); }, live = () => { if (signal.aborted) return fail("cancelled"); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    live(); const parent = await pinnedDirectory(directories.delivery), slot = join(directories.delivery, intent.taskId);
    let existing: StandingHistoryTaskDeliveryStatus | undefined, existingOwn: BigIntStats | undefined;
    let recoveryBinding: StandingHistoryDeliveryRecoveryBinding | undefined, recoveryAuthorization: StandingHistoryDeliveryRecoveryAuthorization | undefined;
    if (!await absent(slot)) {
      existingOwn = await pinnedDirectory(slot);
      existing = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent, signal });
      if (recovering) {
        const authorization = data(v.maintenance, ["schema", "binding", "ownerReceiptHash"]), bound = data(authorization.binding,
          ["taskRef", "intentHash", "descriptorHash", "partIndex", "originalRecordsHash", "idempotencyKey", "randomId", "accountId", "chatId", "replyToMessageId", "contentHash", "textBytes"]);
        if (!count(bound.partIndex, MAX_PARTS) || bound.partIndex === 0 || existing.storage !== "ready" || existing.delivery !== "unknown") return fail("consumed");
        recoveryBinding = await inspectStandingHistoryTaskDeliveryRecovery({ directory: directories.delivery, passphrase, intent, signal, partIndex: bound.partIndex as number });
        if (!recoveryBinding) return fail("consumed");
        recoveryAuthorization = snapshotStandingHistoryDeliveryRecoveryAuthorization(v.maintenance, recoveryBinding);
        const recoveryBase = existing.descriptor?.schema === "standing-history-task-delivery-v1" ? slot : join(slot, partDirectory(recoveryBinding.partIndex));
        if (!await absent(join(recoveryBase, "recovery-v1"))) return fail("consumed");
      } else if (existing.storage !== "ready" || existing.descriptor?.schema === "standing-history-task-delivery-v1" || !existing.nextPart) return fail("consumed");
    }
    if (recovering && !recoveryBinding) return fail("consumed");
    // No slot or transport lease is created for an internal analysis note.
    // Existing multipart recovery retains its descriptor and replay boundaries.
    if (!existing && !finalReport) return fail("report-required");
    control = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open" });
    const queued = async () => { await control!.status(); const fresh = await openStandingHistoryTaskControlStore({ directory: directories.control, passphrase, intent, mode: "open" });
      try { const c = await fresh.status(); await control!.status(); if (c.storage !== "ready") return fail("stale"); if (c.state !== "queued") return fail("cancelled"); return c; } finally { await fresh.close(); } };
    const initialControl = await queued(); live();
    source = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" });
    analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", readSourcePage: i => source!.readPage(i) });
    attempts = await openStandingHistoryAnalysisAttemptStore({ directory: directories.attempts, passphrase, intent, mode: "open", analysis });
    const a = await analysis.status(), root = readiness.rootRef ? await analysis.readNode(readiness.rootRef) : undefined;
    if (!root || a.storage !== "ready" || a.headHash !== readiness.expectedHead || root.hash !== a.headHash || root.nodeRef !== readiness.rootRef) return fail("stale");
    coverageCheck(readiness, root, await source.status());
    const snapshot = await attempts.status(), last = snapshot.last;
    if (snapshot.storage !== "ready" || !last?.nativeBinding || !last.node || !last.modelOutcome || last.node.nodeRef !== root.nodeRef || last.node.hash !== root.hash || last.node.index !== root.index) return fail("owner");
    const proof = data(await verifyOwnerReady(last.nativeBinding), ["schema", "nativeBinding", "basis", "modelOutcome"]);
    if (proof.schema !== "standing-analysis-owner-ready-v1" || !equal(data(proof.nativeBinding, ["epochId", "requestRef", "purpose"]), last.nativeBinding) ||
        !["released-current-owner", "persisted-owner-settlement"].includes(proof.basis as string) || proof.modelOutcome !== "not-proven" ||
        last.modelOutcome !== "observed" && proof.basis !== "persisted-owner-settlement") return fail("owner");
    const chosenBody = finalReport?.body ?? body ?? existing!.descriptor!.body, prepared = prepareStandingHistoryTaskDeliveryText({ intent, readiness, body: chosenBody });
    const partsTotal = prepared.parts.length, multipart = partsTotal > 1;
    const descriptor = descriptorCopy({ schema: partsTotal > 2 ? "standing-history-task-delivery-v3" : multipart ? "standing-history-task-delivery-v2" : "standing-history-task-delivery-v1", taskRef: intent.taskId, sourceHead: readiness.sourceHead, analysisHead: readiness.expectedHead,
      rootRef: root.nodeRef, rootHash: root.hash, body: chosenBody, text: prepared.text, textHash: prepared.textHash, coverage: readiness.coverage, gaps: readiness.gaps,
      ...(multipart ? { parts: prepared.parts } : {}) }, intent);
    if (existing && !equal(existing.descriptor, descriptor)) return fail("consumed");
    const partIndex = recoveryBinding?.partIndex ?? existing?.nextPart ?? 1, part = prepared.parts[partIndex - 1]!;
    const freshHeads = async () => { live(); if ((await queued()).headHash !== initialControl.headHash) return fail("stale");
      const s = await source!.status(), a = await analysis!.status(), t = await attempts!.status();
      if (s.storage !== "ready" || a.storage !== "ready" || t.storage !== "ready" || s.readProgress.chainHash !== readiness.sourceHead || a.headHash !== readiness.expectedHead || t.last?.attemptRef !== last.attemptRef) return fail("stale");
      // Cached immutable readers authenticate known files but do not discover
      // newly added tails on status(). Check exact bounded slot inventories,
      // then recheck their pinned custody; no second planner/history traversal.
      await immutableInventory(join(directories.pages, intent.taskId), "page", s.readProgress.committedPages);
      await immutableInventory(join(directories.analysis, intent.taskId), "node", a.analysisNodes);
      await source!.status(); await analysis!.status(); live(); };
    await freshHeads(); await checkDirectory(directories.delivery, parent);
    if (!existing) { try { await mkdir(slot, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return fail("consumed"); throw e; } }
    const own = existingOwn ?? await pinnedDirectory(slot), versions = new Map<string, string>(); let pilotOwn: BigIntStats | undefined, partOwn: BigIntStats | undefined;
    const base = multipart ? join(slot, partDirectory(partIndex)) : slot, pilotPath = join(base, "pilot");
    const guard = async () => { await checkDirectory(directories.delivery, parent); await checkDirectory(slot, own);
      if (partOwn) await checkDirectory(base, partOwn);
      if (pilotOwn) await checkDirectory(pilotPath, pilotOwn);
      for (const [path, version] of versions) if (stamp(await lstat(path, { bigint: true })) !== version) return fail("storage"); };
    const descriptorPath = join(slot, "descriptor.enc");
    if (existing) {
      const saved = data(JSON.parse(await decryptSession(await readFile(descriptorPath, guard, versions), passphrase)), ["domain", "kind", "intent", "descriptor"]);
      if (saved.domain !== DOMAIN || saved.kind !== "descriptor" || !equal(snapshotStandingHistoryTaskIntent(saved.intent), intent) || !equal(storedDescriptor(saved.descriptor, intent), descriptor)) return fail("storage");
    } else versions.set(descriptorPath, stamp(await writeFile(descriptorPath, { domain: DOMAIN, kind: "descriptor", intent, descriptor: persistedDescriptor(descriptor) }, passphrase, guard)));
    await freshHeads();
    if (multipart && !recovering) {
      const beforePart = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent, signal });
      if (beforePart.storage !== "ready" || beforePart.nextPart !== partIndex || !equal(beforePart.descriptor, descriptor)) return fail("consumed");
      await guard(); try { await mkdir(base, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return fail("consumed"); throw e; }
      partOwn = await pinnedDirectory(base);
    }
    if (recovering) {
      partOwn = await pinnedDirectory(base);
      pilotOwn = await pinnedDirectory(pilotPath);
      const originalFiles: Record<string, string> = {};
      for (const name of ["planned.enc", "sending.enc", "terminal.enc"])
        originalFiles[name] = sha(await readFile(join(pilotPath, name), guard, versions));
      originalFiles["result.enc"] = sha(await readFile(join(base, "result.enc"), guard, versions));
      if (sha(canonical(originalFiles)) !== recoveryBinding!.originalRecordsHash) return fail("stale");
      const recoveryGuard = async () => {
        await freshHeads(); await guard();
        if (!equal((await boundedNames(pilotPath, 3)).sort(), ["planned.enc", "sending.enc", "terminal.enc"])) return fail("stale");
      };
      await recoveryGuard();
      const leaseValue = openReply({ intent, signal, taskReplyPolicy: "standalone-if-exact-missing" }); closeReply = method<StandingTaskReplyLease["close"]>(leaseValue, "close");
      const leaseData = data(leaseValue, ["transport", "close"]), send = method<StandingTaskReplyLease["transport"]["sendOnce"]>(leaseData.transport, "sendOnce"), read = method<StandingTaskReplyLease["transport"]["readExact"]>(leaseData.transport, "readExact");
      const result = await runStandingHistoryDeliveryRecovery({ directory: join(base, "recovery-v1"), passphrase: multipart ? partPassphrase(passphrase, intent, descriptor, partIndex) : passphrase,
        binding: recoveryBinding!, authorization: recoveryAuthorization!, text: part.text, signal, guard: recoveryGuard, taskReplyPolicy: "standalone-if-exact-missing",
        transport: { sendOnce(reply, callSignal) { return callback(() => send(reply, callSignal)); }, readExact(chatId, messageId, callSignal) { return callback(() => read(chatId, messageId, callSignal)); } },
        async settle() { try { await closeLease(); } finally { await joinCallbacks(); } } });
      const final = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent });
      if (final.storage !== "ready" || !equal(final.descriptor, descriptor)) return fail("storage");
      return Object.freeze({ descriptor, result, leaseJoined: true, partIndex, partsTotal, deliveryComplete: final.delivery === "verified" });
    }
    const leaseValue = openReply({ intent, signal, taskReplyPolicy: "standalone-if-exact-missing" }); closeReply = method<StandingTaskReplyLease["close"]>(leaseValue, "close");
    const leaseData = data(leaseValue, ["transport", "close"]), send = method<StandingTaskReplyLease["transport"]["sendOnce"]>(leaseData.transport, "sendOnce"), read = method<StandingTaskReplyLease["transport"]["readExact"]>(leaseData.transport, "readExact");
    const pilotKey = multipart ? partPassphrase(passphrase, intent, descriptor, partIndex) : passphrase;
    const pilot = createEncryptedPilotStore(pilotPath, pilotKey);
    const recordReadback = async (record: PilotRecord) => {
      const file = record.state === "planned" ? "planned.enc" : record.state === "sending" ? "sending.enc" : "terminal.enc";
      const saved = pilotRecord(await decryptPilot(await readFile(join(pilotPath, file), guard, versions), pilotKey), part, intent);
      if (!equal(saved, record)) return fail("storage"); await guard();
    };
    const guardedStore: PilotStore = { async reserve(record) { pilotRecord(record, part, intent); await guard(); await pilot.reserve(record); pilotOwn = await pinnedDirectory(pilotPath); await recordReadback(record); },
      async append(record) { pilotRecord(record, part, intent); await guard(); await pilot.append(record); await recordReadback(record); } };
    const reply = { chatId: intent.chatId, replyToMessageId: intent.primaryMessageId, text: part.text };
    // Observe only after the existing exact encrypted readback and custody
    // guards resolve. This adds no reads, sends, or aggregate completion claim.
    const store = onOwnAction ? wrapPilotStore(guardedStore, reply, onOwnAction) : guardedStore;
    const result = await runPilotReply({ approved: { chatId: intent.chatId, accountId: intent.accountId, replyToMessageId: intent.primaryMessageId, maximumTextBytes: 4096, taskReplyPolicy: "standalone-if-exact-missing" },
      reply, store,
      transport: { sendOnce(reply, signal) { return callback(async () => { try { await freshHeads(); await guard();
        if (multipart) { const prefix = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent, signal });
          if (prefix.storage !== "ready" || prefix.verifiedParts !== partIndex - 1 || !equal(prefix.descriptor, descriptor)) return fail("consumed"); }
        } catch (error) { throw tagPilotTaskSendError(error, "task-preflight"); }
        return send(reply, signal); }); },
        readExact(chatId, messageId, signal) { return callback(() => read(chatId, messageId, signal)); } }, killSwitchEngaged: () => signal.aborted, signal });
    try { await closeLease(); } finally { await joinCallbacks(); }
    await writeFile(join(base, "result.enc"), { domain: DOMAIN, kind: "result", taskId: intent.taskId, intentHash: sha(canonical(intent)), descriptorHash: descriptorHash(descriptor),
      ...(multipart ? { partIndex } : {}), result: resultCopy(result), leaseJoined: true }, passphrase, guard);
    const final = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent });
    if (final.storage !== "ready" || !equal(final.descriptor, descriptor)) return fail("storage");
    return Object.freeze({ descriptor, result, leaseJoined: true, partIndex, partsTotal, deliveryComplete: final.delivery === "verified" });
  } finally {
    try { try { await closeLease(); } finally { await joinCallbacks(); } }
    finally {
      const closed = await Promise.allSettled([attempts?.close(), analysis?.close(), source?.close(), control?.close()]);
      passphrase = ""; signal.removeEventListener("abort", abort); if (closed.some(r => r.status === "rejected")) return fail("close");
    }
  }
}
