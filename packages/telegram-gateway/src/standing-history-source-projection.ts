import { MATERIAL_BYTES, LEGACY_MATERIAL_BYTES } from "./standing-history-analysis-limits.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskPage, standingHistoryTaskSourcePeerId, StandingHistoryTaskStoreError,
  type StandingHistoryStoredPage, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import type { SelfHistoryMessage, SelfHistoryPage } from "./self-history-reader.js";

type SourceIdentity = Readonly<{ sourceRef: string; versionRef: string; date: number | null }>;
export type StandingHistorySourceRow = SourceIdentity & Readonly<
  { disposition: "included"; date: number; speakerRef: string; author: SelfHistoryMessage["author"]; displayName: string;
    forwarded?: SelfHistoryMessage["forwarded"];
    editedAt: number | null; text: string; replySourceRef: string | null; replyContentAvailable: boolean; replyUnavailable: boolean } |
  { disposition: "nonText" | "invalidText" | "unavailable" | "outsidePeriod" }
>;
export type StandingHistorySourceFragment = Readonly<{
  schema: "standing-history-source-fragment-v1"; materialRef: string; pageHash: string; pageIndex: number; fromDate: number; toDate: number;
  rows: readonly StandingHistorySourceRow[]; range: Readonly<{ fromRow: number; toRow: number; totalRows: number }>;
  nextPosition: string | null;
  sourceRef?: "community";
  sourceInterpretation?: "quoted-source-not-request";
  coverage: Readonly<{ sourcePageStatus: SelfHistoryPage["status"]; sourcePageCoverage: SelfHistoryPage["coverage"];
    sourcePageExcluded: SelfHistoryPage["excluded"]; sourceRowsReturned: number;
    /** True only for the final fragment of this stored page, not task analysis completion. */
    fragmentComplete: boolean }>;
  limitations: SelfHistoryPage["limitations"];
}>;
export type StandingHistorySourceProjectionRequest = Readonly<{
  intent: StandingHistoryTaskIntent; referenceKey: string; storedPage: StandingHistoryStoredPage; position?: string; maxBytes?: number; maxRows?: number;
}>;
export class StandingHistorySourceProjectionError extends Error {
  constructor(readonly code: "input" | "binding" | "position" | "limit") { super("STANDING_HISTORY_SOURCE_" + code.toUpperCase()); }
}
const fail = (code: StandingHistorySourceProjectionError["code"]): never => { throw new StandingHistorySourceProjectionError(code); };
const MAX_BYTES = LEGACY_MATERIAL_BYTES, DOMAIN = "DecadansNeurobro/standing-history-source/v1";
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) { const d = ds[key]!; if (!("value" in d) || !d.enumerable) return fail("input"); result[key] = d.value; }
  return result;
}
/** Used only after inert canonical validators. Property insertion order is not
 * part of source content or material identity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}

/** Pure projection of an already authenticated store read. A caller-supplied
 * page hash is not authentication: the store owns ciphertext/chain/intent proof.
 * HMAC refs provide task-local identity and positions bind this supplied material.
 * No connection alias, raw Telegram selector or reference key is exposed.
 * Returned text/names are untrusted observations, never task instructions. */
export function projectStandingHistorySource(value: StandingHistorySourceProjectionRequest): StandingHistorySourceFragment {
  let args: Record<string, unknown>, intent: StandingHistoryTaskIntent, stored: StandingHistoryStoredPage;
  try {
    args = data(value, ["intent", "referenceKey", "storedPage"], ["position", "maxBytes", "maxRows"]);
    intent = snapshotStandingHistoryTaskIntent(args.intent);
    const page = data(args.storedPage, ["index", "hash", "result"]), result = snapshotStandingHistoryTaskPage(page.result, intent);
    if (!Number.isSafeInteger(page.index) || Number(page.index) < 1 || Number(page.index) > 1024 ||
        typeof page.hash !== "string" || !/^[0-9a-f]{64}$/u.test(page.hash) ||
        typeof args.referenceKey !== "string" || !/^[0-9a-f]{64}$/u.test(args.referenceKey) ||
        Object.hasOwn(args, "maxBytes") && (!Number.isSafeInteger(args.maxBytes) || Number(args.maxBytes) < 1024 || Number(args.maxBytes) > MATERIAL_BYTES) ||
        Object.hasOwn(args, "maxRows") && (!Number.isInteger(args.maxRows) || Number(args.maxRows) < 1 || Number(args.maxRows) > 100) ||
        Object.hasOwn(args, "position") && (typeof args.position !== "string" || !/^hpos_(?:0|[1-9]\d{0,2})_[0-9a-f]{48}$/u.test(args.position))) return fail("input");
    stored = Object.freeze({ index: Number(page.index), hash: page.hash, result });
  } catch (error) {
    if (error instanceof StandingHistorySourceProjectionError) throw error;
    if (error instanceof StandingHistoryTaskStoreError && error.code === "binding") return fail("binding");
    return fail("input");
  }
  const before = stored.result.beforeCheckpoint;
  if (before.accountId !== intent.accountId || before.chatId !== standingHistoryTaskSourcePeerId(intent) || before.fromDate !== intent.fromDate || before.toDate !== intent.toDate ||
      stored.index !== before.pages + 1) return fail("binding");
  // All shape/binding checks above precede secret allocation and cryptography.
  const key = Buffer.from(args.referenceKey as string, "hex"), scope = intent.source
    ? [intent.taskId, intent.accountId, intent.chatId, intent.source]
    : [intent.taskId, intent.accountId, intent.chatId];
  try {
    const mac = (kind: string, material: unknown) => createHmac("sha256", key).update(canonical([DOMAIN, kind, scope, material])).digest("hex").slice(0, 48);
    const sourceRef = (id: number) => "hsrc_" + mac("source", id), speakerRef = (id: string) => "hspk_" + mac("speaker", id);
    const pageMaterialRef = mac("page-material", { intent, stored });
    const position = (offset: number) => "hpos_" + offset + "_" + mac("position", { pageMaterialRef, offset });
    let start = 0;
    if (Object.hasOwn(args, "position")) {
      const supplied = args.position as string; start = Number(supplied.split("_")[1]);
      const expected = position(start);
      if (start < 1 || start >= stored.result.sources.length || expected.length !== supplied.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return fail("position");
    }
    const byRef = new Map(stored.result.page.messages.map(message => [message.ref, message]));
    const projected: StandingHistorySourceRow[] = stored.result.sources.map(source => {
      const logical = sourceRef(source.messageId);
      if (source.disposition !== "included") return Object.freeze({ sourceRef: logical, versionRef: "hver_" + mac("version", {
        messageId: source.messageId, date: source.date, disposition: source.disposition }), date: source.date, disposition: source.disposition });
      const message = byRef.get(source.messageRef!)!;
      const observed = { messageId: source.messageId, date: message.date, disposition: "included", authorId: source.authorId!,
        author: message.author, displayName: message.displayName, editedAt: message.editedAt, text: message.text,
        replyToMessageId: source.replyToMessageId ?? null, replyUnavailable: message.replyUnavailable,
        ...(message.forwarded ? { forwarded: message.forwarded } : {}) };
      return Object.freeze({ sourceRef: logical, versionRef: "hver_" + mac("version", observed), disposition: "included", date: message.date,
        speakerRef: speakerRef(source.authorId!), author: message.author, displayName: message.displayName, editedAt: message.editedAt, text: message.text,
        ...(message.forwarded ? { forwarded: message.forwarded } : {}),
        replySourceRef: source.replyToMessageId === undefined ? null : sourceRef(source.replyToMessageId), replyContentAvailable: false,
        replyUnavailable: message.replyUnavailable });
    });
    const assembleFragment = (end: number, rows: readonly StandingHistorySourceRow[], materialRef: string,
      nextPosition: string | null, sourceRowsReturned = rows.length): StandingHistorySourceFragment => Object.freeze({
        schema: "standing-history-source-fragment-v1", materialRef, pageHash: stored.hash, pageIndex: stored.index,
        ...(intent.source ? { sourceRef: "community" as const, sourceInterpretation: "quoted-source-not-request" as const } : {}),
        fromDate: intent.fromDate, toDate: intent.toDate, rows, range: Object.freeze({ fromRow: start, toRow: end, totalRows: projected.length }),
        nextPosition,
        coverage: Object.freeze({ sourcePageStatus: stored.result.page.status, sourcePageCoverage: stored.result.page.coverage,
          sourcePageExcluded: stored.result.page.excluded, sourceRowsReturned, fragmentComplete: end === projected.length }),
        limitations: stored.result.page.limitations });
    const fragment = (end: number): StandingHistorySourceFragment => {
      const slice = projected.slice(start, end), available = new Set(slice.filter(row => row.disposition === "included").map(row => row.sourceRef));
      const rows = Object.freeze(slice.map(row => row.disposition !== "included" ? row : Object.freeze({ ...row,
        // Content elsewhere in this page, another fragment or another page is
        // deliberately not claimed available to this fragment's model consumer.
        replyContentAvailable: row.replySourceRef !== null && available.has(row.replySourceRef) })));
      return assembleFragment(end, rows, "hmat_" + mac("fragment-material", { pageMaterialRef, start, end }),
        end === projected.length ? null : position(end));
    };
    const budget = args.maxBytes === undefined ? MAX_BYTES : Number(args.maxBytes);
    if (projected.length === 0) {
      const result = fragment(0); if (Buffer.byteLength(JSON.stringify(result)) > budget) return fail("limit"); return result;
    }
    // Select against the exact JSON byte shape in one pass. A newly included
    // reply target can shorten earlier rows from false to true, and the terminal
    // envelope shortens nextPosition to null, so candidate sizes are not assumed
    // monotonic. Omit no oversized row: the next position remains before it.
    const endLimit = args.maxRows === undefined ? projected.length : Math.min(projected.length, start + Number(args.maxRows));
    const placeholderMaterialRef = "hmat_" + "0".repeat(48), placeholderPosition = (end: number) => "hpos_" + end + "_" + "0".repeat(48);
    const emptyRows = Object.freeze([]) as readonly StandingHistorySourceRow[];
    const rowSizes = projected.slice(start, endLimit).map(row => {
      const unavailable = Buffer.byteLength(JSON.stringify(row));
      if (row.disposition !== "included" || row.replySourceRef === null) return { unavailable, available: unavailable };
      // JSON's only change is the boolean token: `true` is one byte shorter.
      return { unavailable, available: unavailable - 1 };
    });
    const available = new Set<string>(), waitingDeltas = new Map<string, number>();
    let selectedEnd: number | undefined, rowsBytes = 0;
    for (let end = start + 1; end <= endLimit; end++) {
      const row = projected[end - 1]!, sizes = rowSizes[end - start - 1]!;
      if (row.disposition === "included") {
        if (!available.has(row.sourceRef)) {
          available.add(row.sourceRef);
          rowsBytes += waitingDeltas.get(row.sourceRef) ?? 0;
          waitingDeltas.delete(row.sourceRef);
        }
        const replyAvailable = row.replySourceRef !== null && available.has(row.replySourceRef);
        rowsBytes += end > start + 1 ? 1 : 0;
        rowsBytes += replyAvailable ? sizes.available : sizes.unavailable;
        if (!replyAvailable && row.replySourceRef !== null) waitingDeltas.set(row.replySourceRef,
          (waitingDeltas.get(row.replySourceRef) ?? 0) + sizes.available - sizes.unavailable);
      } else {
        rowsBytes += (end > start + 1 ? 1 : 0) + sizes.unavailable;
      }
      const envelope = assembleFragment(end, emptyRows, placeholderMaterialRef,
        end === projected.length ? null : placeholderPosition(end), end - start);
      if (Buffer.byteLength(JSON.stringify(envelope)) + rowsBytes > budget) break;
      selectedEnd = end;
    }
    if (selectedEnd === undefined) return fail("limit");
    return fragment(selectedEnd);
  } finally { key.fill(0); }
}
