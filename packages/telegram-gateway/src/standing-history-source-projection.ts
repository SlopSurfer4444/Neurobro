import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { snapshotStandingHistoryTaskIntent, snapshotStandingHistoryTaskPage,
  type StandingHistoryStoredPage, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import type { SelfHistoryMessage, SelfHistoryPage } from "./self-history-reader.js";

type SourceIdentity = Readonly<{ sourceRef: string; versionRef: string; date: number | null }>;
export type StandingHistorySourceRow = SourceIdentity & Readonly<
  { disposition: "included"; date: number; speakerRef: string; author: SelfHistoryMessage["author"]; displayName: string;
    editedAt: number | null; text: string; replySourceRef: string | null; replyContentAvailable: boolean; replyUnavailable: boolean } |
  { disposition: "nonText" | "invalidText" | "unavailable" | "outsidePeriod" }
>;
export type StandingHistorySourceFragment = Readonly<{
  schema: "standing-history-source-fragment-v1"; materialRef: string; pageHash: string; pageIndex: number; fromDate: number; toDate: number;
  rows: readonly StandingHistorySourceRow[]; range: Readonly<{ fromRow: number; toRow: number; totalRows: number }>;
  nextPosition: string | null;
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
const MAX_BYTES = 48 * 1024, DOMAIN = "DecadansNeurobro/standing-history-source/v1";
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
    const page = data(args.storedPage, ["index", "hash", "result"]), result = snapshotStandingHistoryTaskPage(page.result);
    if (!Number.isSafeInteger(page.index) || Number(page.index) < 1 || Number(page.index) > 1024 ||
        typeof page.hash !== "string" || !/^[0-9a-f]{64}$/u.test(page.hash) ||
        typeof args.referenceKey !== "string" || !/^[0-9a-f]{64}$/u.test(args.referenceKey) ||
        Object.hasOwn(args, "maxBytes") && (!Number.isSafeInteger(args.maxBytes) || Number(args.maxBytes) < 1024 || Number(args.maxBytes) > MAX_BYTES) ||
        Object.hasOwn(args, "maxRows") && (!Number.isInteger(args.maxRows) || Number(args.maxRows) < 1 || Number(args.maxRows) > 100) ||
        Object.hasOwn(args, "position") && (typeof args.position !== "string" || !/^hpos_(?:0|[1-9]\d{0,2})_[0-9a-f]{48}$/u.test(args.position))) return fail("input");
    stored = Object.freeze({ index: Number(page.index), hash: page.hash, result });
  } catch (error) { if (error instanceof StandingHistorySourceProjectionError) throw error; return fail("input"); }
  const before = stored.result.beforeCheckpoint;
  if (before.accountId !== intent.accountId || before.chatId !== intent.chatId || before.fromDate !== intent.fromDate || before.toDate !== intent.toDate ||
      stored.index !== before.pages + 1) return fail("binding");
  // All shape/binding checks above precede secret allocation and cryptography.
  const key = Buffer.from(args.referenceKey as string, "hex"), scope = [intent.taskId, intent.accountId, intent.chatId];
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
        replyToMessageId: source.replyToMessageId ?? null, replyUnavailable: message.replyUnavailable };
      return Object.freeze({ sourceRef: logical, versionRef: "hver_" + mac("version", observed), disposition: "included", date: message.date,
        speakerRef: speakerRef(source.authorId!), author: message.author, displayName: message.displayName, editedAt: message.editedAt, text: message.text,
        replySourceRef: source.replyToMessageId === undefined ? null : sourceRef(source.replyToMessageId), replyContentAvailable: false,
        replyUnavailable: message.replyUnavailable });
    });
    const fragment = (end: number): StandingHistorySourceFragment => {
      const slice = projected.slice(start, end), available = new Set(slice.filter(row => row.disposition === "included").map(row => row.sourceRef));
      const rows = slice.map(row => row.disposition !== "included" ? row : Object.freeze({ ...row,
        // Content elsewhere in this page, another fragment or another page is
        // deliberately not claimed available to this fragment's model consumer.
        replyContentAvailable: row.replySourceRef !== null && available.has(row.replySourceRef) }));
      return Object.freeze({ schema: "standing-history-source-fragment-v1", materialRef: "hmat_" + mac("fragment-material", { pageMaterialRef, start, end }), pageHash: stored.hash, pageIndex: stored.index,
        fromDate: intent.fromDate, toDate: intent.toDate, rows: Object.freeze(rows), range: Object.freeze({ fromRow: start, toRow: end, totalRows: projected.length }),
        nextPosition: end === projected.length ? null : position(end),
        coverage: Object.freeze({ sourcePageStatus: stored.result.page.status, sourcePageCoverage: stored.result.page.coverage,
          sourcePageExcluded: stored.result.page.excluded, sourceRowsReturned: rows.length, fragmentComplete: end === projected.length }),
        limitations: stored.result.page.limitations });
    };
    const budget = args.maxBytes === undefined ? MAX_BYTES : Number(args.maxBytes);
    let result: StandingHistorySourceFragment | undefined;
    if (projected.length === 0) {
      result = fragment(0); if (Buffer.byteLength(JSON.stringify(result)) > budget) return fail("limit"); return result;
    }
    // Test the final serialized shape, including continuation, range and reply
    // availability. Omit no oversized row: the next position remains before it.
    const endLimit = args.maxRows === undefined ? projected.length : Math.min(projected.length, start + Number(args.maxRows));
    for (let end = start + 1; end <= endLimit; end++) {
      const next = fragment(end);
      if (Buffer.byteLength(JSON.stringify(next)) > budget) break;
      result = next;
    }
    if (!result) return fail("limit");
    return result;
  } finally { key.fill(0); }
}
