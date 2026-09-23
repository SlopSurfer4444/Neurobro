import { createHash } from "node:crypto";
import { types } from "node:util";
import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { ConversationReferences } from "./conversation-references.js";
import { STANDING_INCOMING_TEXT_BYTES, type StandingContext, type StandingContextMessage } from "./standing-context.js";
import { requireStandingContextRestoration, type StandingContextRestoration } from "./standing-context-restoration.js";
import { projectStandingSharedContext, type StandingSharedDialogue, type StandingSharedObservation,
  type StandingSharedContextCoverage } from "./standing-shared-context.js";
import { bindStandingSharedContext, type BoundStandingSharedContext } from "./standing-shared-context-binding.js";
import { requireStandingHistoryTaskContext, type StandingHistoryTaskContextPage } from "./standing-history-task-context.js";
import { requireStandingOwnActionContext, type StandingOwnActionContextPage } from "./standing-own-action-memory.js";
import { requireStandingChronicleNote, type StandingChronicleNote } from "./standing-chronicle-note.js";

export type StandingSharedContextReaderInput = Readonly<{
  binding: PilotBinding; primary: PilotPrimary; references: ConversationReferences;
  scopeRef: string; /** Host snapshot time in Unix seconds. */ asOf: number; signal: AbortSignal;
  context?: StandingContext; restoration?: StandingContextRestoration; taskContext?: StandingHistoryTaskContextPage;
  ownActionContext?: StandingOwnActionContextPage;
  chronicleNotes?: readonly StandingChronicleNote[];
}>;
const fail = (): never => { throw new Error("STANDING_SHARED_CONTEXT_READER_REFUSED"); };
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || names.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail();
  const result: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const d = ds[key]; if (!d) continue;
    if (!("value" in d) || !d.enumerable) return fail(); result[key] = d.value;
  }
  return result;
}
function array(value: unknown, cap: number): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > cap) return fail();
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(ds).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, i) => { const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) return fail(); return d.value; });
}
function text(value: unknown, cap: number): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > cap || Buffer.from(value).toString() !== value) return fail(); return value;
}
function messageId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647) return fail(); return value as number;
}
function userId(value: unknown): string { if (typeof value !== "string" || !/^[1-9]\d{0,19}$/u.test(value)) return fail(); return value; }
function date(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 253402300799) return fail(); return value as number;
}
function hash(kind: string, value: unknown): string { return kind + "_" + createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function message(value: unknown, binding: PilotBinding): StandingContextMessage {
  const v = record(value, ["chatId", "messageId", "authorId", "author", "displayName", "date", "replyToMessageId", "text"], ["forwarded"]);
  const authorId = userId(v.authorId);
  if (v.chatId !== binding.peerId || !["user", "self"].includes(v.author as string) || (v.author === "self") !== (authorId === binding.accountId)) return fail();
  const id = messageId(v.messageId), reply = v.replyToMessageId === null ? null : messageId(v.replyToMessageId);
  if (reply !== null && reply >= id) return fail();
  let forwarded: StandingContextMessage["forwarded"];
  if (Object.hasOwn(v, "forwarded")) {
    const f = record(v.forwarded, ["originalDate", "sourceName"]);
    if (!Number.isSafeInteger(f.originalDate) || Number(f.originalDate) < 1 || Number(f.originalDate) > 253402300799) return fail();
    const sourceName = f.sourceName === null ? null : text(f.sourceName, 128);
    if (sourceName !== null && (!sourceName.length || sourceName.trim() !== sourceName || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(sourceName))) return fail();
    forwarded = { originalDate: f.originalDate as number, sourceName };
  }
  return { chatId: binding.peerId, messageId: id, authorId, author: v.author as "user" | "self", displayName: text(v.displayName, 512),
    date: date(v.date), replyToMessageId: reply, text: text(v.text, STANDING_INCOMING_TEXT_BYTES), ...(forwarded ? { forwarded } : {}) };
}
const unavailable = (availability: "unavailable" | "not-configured"): StandingSharedContextCoverage =>
  ({ availability, freshness: "unknown", scanned: 0, hasMore: null, omittedAtSource: null });

/** Composes only already observed host input. No disk, Telegram, model or source
 * archive reads; no background work. Source references are connection-scoped,
 * derived from actual message aliases, never fake message-resolution entries.
 * Immutable selected-journal pairs retain separate provenance through their
 * source family. Old unconfirmed image facts remain in the existing restoration
 * operations lane; they are not upgraded into authenticated own-action records.
 * Authentication of host context and provisioning scopeRef belong to the caller.
 * The returned capability is bound to the current primary/references/signal.
 */
export function readStandingSharedContext(input: StandingSharedContextReaderInput): BoundStandingSharedContext {
  const v = record(input, ["binding", "primary", "references", "scopeRef", "asOf", "signal"], ["context", "restoration", "taskContext", "ownActionContext", "chronicleNotes"]);
  const b = record(v.binding, ["accountId", "peerId"]), p = record(v.primary, ["chatId", "ownerId", "messageId", "text"]);
  const binding = { accountId: userId(b.accountId), peerId: b.peerId as string };
  if (typeof binding.peerId !== "string" || !/^-[1-9]\d{0,22}$/u.test(binding.peerId) || p.chatId !== binding.peerId) return fail();
  const primary: PilotPrimary = { chatId: binding.peerId, ownerId: userId(p.ownerId), messageId: messageId(p.messageId), text: text(p.text, STANDING_INCOMING_TEXT_BYTES) };
  if (primary.ownerId === binding.accountId || !primary.text.length || typeof v.scopeRef !== "string" || !/^[a-z][a-z0-9-]{0,31}_[0-9a-f]{32,64}$/u.test(v.scopeRef)) return fail();
  const scopeRef = v.scopeRef, asOf = date(v.asOf), references = v.references as ConversationReferences, signal = v.signal as AbortSignal;
  // References and AbortSignal are borrowed host capabilities. Their methods are
  // deliberately invoked; nested untrusted message objects are copied inertly.
  if (!references || types.isProxy(references) || types.isProxy(signal) || !(signal instanceof AbortSignal)) return fail();
  const check = () => { if (signal.aborted || !references.matches(binding.peerId, binding.accountId) || references.speaker(primary.ownerId) === "neurobro") return fail(); };
  check();
  const notes = Object.hasOwn(v, "chronicleNotes") ? array(v.chronicleNotes, 2).map(value =>
    requireStandingChronicleNote(value as StandingChronicleNote, { ...binding, requesterId: primary.ownerId })) : [];
  const taskPage = Object.hasOwn(v, "taskContext") ? requireStandingHistoryTaskContext(
    v.taskContext as StandingHistoryTaskContextPage, primary, references, { scopeRef, asOf }) : undefined;
  const ownActionPage = Object.hasOwn(v, "ownActionContext") ? requireStandingOwnActionContext(
    v.ownActionContext as StandingOwnActionContextPage, primary, references, { scopeRef, asOf }) : undefined;
  let observed: StandingContextMessage[] = [], scanned = 0;
  let chronicleCoverage = unavailable("unavailable");
  if (Object.hasOwn(v, "context")) {
    const c = record(v.context, ["version", "primary", "replyChain", "recent", "chainStatus", "recentStatus"]);
    if (c.version !== "standing-context-v1" || !["complete", "partial", "missing", "truncated", "unavailable"].includes(c.chainStatus as string) ||
        !["complete", "partial", "truncated", "unavailable"].includes(c.recentStatus as string)) return fail();
    const current = message(c.primary, binding);
    if (current.forwarded || current.messageId !== primary.messageId || current.authorId !== primary.ownerId || current.author !== "user" || current.text !== primary.text) return fail();
    const chain = array(c.replyChain, 8).map(value => message(value, binding));
    const recent = array(c.recent, 20).map(value => message(value, binding));
    const unique = new Map<number, StandingContextMessage>();
    for (const m of [...chain, ...recent]) {
      if (m.messageId >= primary.messageId) return fail();
      const previous = unique.get(m.messageId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(m)) return fail();
      if (!previous) unique.set(m.messageId, m);
    }
    scanned = chain.length + recent.length;
    // Ancestors first, newest remaining traffic next. All source rows have been
    // validated before any reference resolver is modified.
    const chainIds = new Set(chain.map(m => m.messageId));
    observed = [...new Map(chain.map(m => [m.messageId, m])).values(), ...[...unique.values()].filter(m => !chainIds.has(m.messageId)).sort((a, b) => b.messageId - a.messageId)];
    chronicleCoverage = { availability: "available", freshness: "current", scanned,
      hasMore: c.chainStatus === "complete" && c.recentStatus === "complete" ? false : null,
      omittedAtSource: c.chainStatus === "complete" && c.recentStatus === "complete" ? 0 : null };
  }
  const sourceRef = (messageRef: string) => hash("smsg", ["standing-selected-source-v1", scopeRef, messageRef]);
  const observationByRef = new Map(observed.map(m => [sourceRef(references.message(m.messageId)), m]));
  let dialogueCoverage = unavailable("not-configured");
  const dialogues: StandingSharedDialogue[] = [];
  if (Object.hasOwn(v, "restoration")) {
    const r = requireStandingContextRestoration(v.restoration as StandingContextRestoration, primary, references);
    if (r.status === "unavailable") dialogueCoverage = unavailable("unavailable");
    else {
      let conflicts = 0;
      for (const pair of [...r.dialogues].reverse()) {
        const identity = sourceRef(pair.question.id), current = observationByRef.get(identity);
        if (current && (current.forwarded || current.text !== pair.question.text || references.speaker(current.authorId) !== pair.question.speaker ||
            pair.question.date !== null && current.date !== pair.question.date)) { conflicts++; continue; }
        // The full pair represents its matching question; do not repeat that
        // question as an independent fact in this shared snapshot.
        if (current) observationByRef.delete(identity);
        // The actual dialogue journal records Unix seconds, and restoration
        // forwards that field unchanged. Never infer units from fixture values.
        const recordedSeconds = date(pair.recordedAt);
        if (recordedSeconds > asOf) return fail();
        dialogues.push({ kind: "verified-dialogue", sourceRef: identity,
          versionRef: hash("sver", ["selected-dialogue-version-v1", identity, pair.provenance, pair.recordedAt, pair.question, pair.answer]),
          observedAt: recordedSeconds, question: { speakerRef: pair.question.speaker, text: pair.question.text }, answer: { text: pair.answer.text } });
      }
      dialogueCoverage = { availability: "available", freshness: conflicts ? "stale" : "current", scanned: r.scanned,
        hasMore: r.hasOlder, omittedAtSource: r.eligible - dialogues.length };
    }
  }
  const allObservations: StandingSharedObservation[] = [];
  for (const [identity, m] of observationByRef) allObservations.push({ kind: "observed-message", sourceRef: identity,
    versionRef: hash("sver", ["selected-message-version-v1", identity, m]), observedAt: asOf,
    speakerRef: references.speaker(m.authorId), text: m.text,
    ...(m.forwarded ? { forwarded: { ...m.forwarded, interpretation: "quoted-source-not-request" as const } } : {}) });
  // The composer accepts at most 32 already bounded inputs. Any additional
  // selected rows are explicitly counted before its separate output budget.
  const capacity = 32 - dialogues.length - (taskPage?.source.items.length ?? 0) - (ownActionPage?.source.items.length ?? 0) - notes.length;
  const observations = allObservations.slice(0, capacity), preOmitted = allObservations.length - observations.length;
  const chronicle = [...notes, ...observations];
  if (preOmitted && chronicleCoverage.omittedAtSource !== null) chronicleCoverage = { ...chronicleCoverage, omittedAtSource: chronicleCoverage.omittedAtSource + preOmitted };
  if (notes.length) chronicleCoverage = { availability: "available", freshness: "stale", scanned: scanned + notes.length, hasMore: null, omittedAtSource: null };
  const notConfigured = () => ({ items: [], coverage: unavailable("not-configured") });
  check();
  const snapshot = projectStandingSharedContext({ scope: { scopeRef, audience: { kind: "requester", requesterRef: references.speaker(primary.ownerId) } }, asOf,
    chronicle: { items: chronicle, coverage: chronicleCoverage }, dialogues: { items: dialogues, coverage: dialogueCoverage },
    ownActions: ownActionPage?.source ?? notConfigured(), tasks: taskPage?.source ?? notConfigured() });
  check();
  return bindStandingSharedContext({ snapshot, scopeRef, binding, primary, references, signal });
}
