import { createHash } from "node:crypto";
import { types } from "node:util";
import { Api, utils } from "telegram";

export type StandingObservedSourceInfo = Readonly<{
  sourceRef: "community"; title: string; readOnly: true;
  telegramSendRestriction: "confirmed-denied" | "not-confirmed";
}>;
export type StandingObservedSourceItem = Readonly<{
  ref: string; date: number; displayName: string; text: string; truncated: boolean;
  media: Readonly<{ kind: "none" | "photo" | "document" | "poll" | "other"; pixelsProvided: false }>;
  forwarded?: Readonly<{ originalDate: number; sourceName: string | null; interpretation: "quoted-source-not-request" }>;
}>;
export type StandingObservedSourcePage = Readonly<{
  schema: "standing-observed-source-page-v1";
  source: Readonly<{ sourceRef: "community"; title: string; readOnly: true }>;
  items: readonly StandingObservedSourceItem[];
  nextBeforeMessageId: number | null;
  bounded: true; truncated: boolean; incompleteHistory: true;
  coverage: Readonly<{ requestedLimit: number; rawRows: number; coveredRows: number; skippedRows: number;
    omittedByBudget: number; hasMore: boolean; mayChangeBetweenPages: true }>;
  interpretation: "quoted-source-not-request"; applicationAuthority: "none";
}>;
export type StandingObservedSourceLease = Readonly<{
  info: StandingObservedSourceInfo;
  readHistory(input?: Readonly<{ beforeMessageId?: number; limit?: number }>): Promise<StandingObservedSourcePage>;
  close(): Promise<void>;
}>;
export type StandingObservedSourceProjectionInput = Readonly<{
  sourceRef: "community"; title: string; peerId: string; beforeMessageId?: number; limit: number;
}>;
/** Host-only transport metadata. Never serialize this value into model input or
 * tool output: the peer and per-row identifiers remain private routing
 * material. The public page separately retains its legacy fixed-source
 * `nextBeforeMessageId` cursor. `rowIds` covers exactly the raw rows consumed by
 * the public page, including service/empty rows which have no public item. */
export type StandingObservedSourcePageMetadata = Readonly<{
  peerId: string;
  requestedBeforeMessageId: number | null;
  requestedLimit: number;
  highestMessageId: number | null;
  lowestCoveredMessageId: number | null;
  rowIds: readonly number[];
  rawRows: number;
  coveredRows: number;
  omittedByBudget: number;
}>;
export class StandingObservedSourceReaderError extends Error {
  constructor(readonly code: "input" | "protocol") { super("STANDING_OBSERVED_SOURCE_" + code.toUpperCase()); }
}
export const STANDING_OBSERVED_SOURCE_MAX_BYTES = 48 * 1024;
export const STANDING_OBSERVED_SOURCE_TEXT_BYTES = 16 * 1024;
const issued = new WeakMap<object, Readonly<{ title: string; beforeMessageId: number | undefined; limit: number;
  metadata: StandingObservedSourcePageMetadata }>>();
const fail = (code: "input" | "protocol" = "protocol"): never => { throw new StandingObservedSourceReaderError(code); };
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2147483647;
const validDate = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 253402300799;
function own(value: unknown, name: string, required = false): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail();
  const d = Object.getOwnPropertyDescriptor(value, name);
  if (!d) { if (required) return fail(); return undefined; }
  if (!("value" in d) || !d.enumerable) return fail(); return d.value;
}
// GramJS constructors leave absent optional values undefined, while fromReader
// decodes unset TL flags as null. Normalize only fields whose absence is legal.
function optional(value: unknown, name: string): unknown { return own(value, name) ?? undefined; }
function plain(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const names = Reflect.ownKeys(value);
  if (required.some(key => !names.includes(key)) || names.some(key => typeof key !== "string" || ![...required, ...optional].includes(key))) return fail("input");
  return Object.fromEntries(names.map(key => [key, own(value, key as string, true)]));
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, i) => own(value, String(i), true));
}
function rawText(value: unknown, maximum = 65536): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum || Buffer.from(value).toString("utf8") !== value) return fail(); return value;
}
function prefix(value: string, maximum: number): string {
  let result = "", bytes = 0;
  for (const point of value) { const size = Buffer.byteLength(point); if (bytes + size > maximum) break; result += point; bytes += size; }
  return result;
}
function label(value: unknown, maximum = 128): string {
  return prefix(rawText(value, 4096).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").trim(), maximum).trim();
}
function identifier(value: unknown): string {
  if (value === null || value === undefined || typeof value === "object" && types.isProxy(value)) return fail();
  const id = String(value); if (!/^[1-9]\d{0,19}$/u.test(id)) return fail(); return id;
}
function peer(value: unknown): string {
  if (!value || typeof value !== "object" || types.isProxy(value)) return fail();
  if (value instanceof Api.PeerUser) identifier(own(value, "userId", true));
  else if (value instanceof Api.PeerChat) identifier(own(value, "chatId", true));
  else if (value instanceof Api.PeerChannel) identifier(own(value, "channelId", true));
  else return fail();
  return utils.getPeerId(value as Api.TypePeer);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}

/** Pure projection of the sole adapter's exact GetHistory response. All raw
 * rows are validated before any output is admitted. Cursor progress covers
 * only included rows and explicitly skipped service/unavailable rows; a row
 * omitted by the serialized budget remains available to the next read. */
export function projectStandingObservedSourcePage(envelope: unknown, input: StandingObservedSourceProjectionInput): StandingObservedSourcePage {
  const args = plain(input, ["sourceRef", "title", "peerId", "limit"], ["beforeMessageId"]);
  if (args.sourceRef !== "community" || typeof args.peerId !== "string" || !/^-[1-9]\d{0,19}$/u.test(args.peerId) ||
      !Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 30 ||
      Object.hasOwn(args, "beforeMessageId") && !validId(args.beforeMessageId)) return fail("input");
  const title = label(args.title, 256); if (!title) return fail("input");
  const limit = args.limit as number, before = args.beforeMessageId as number | undefined;
  if (!envelope || typeof envelope !== "object" || types.isProxy(envelope) ||
      !(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages)) return fail();
  const messages = array(own(envelope, "messages", true), limit), users = array(own(envelope, "users", true), 120), chats = array(own(envelope, "chats", true), 120);
  const inexact = optional(envelope, "inexact"), count = own(envelope, "count");
  const requiresCount = envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages;
  if (inexact !== undefined && typeof inexact !== "boolean" || (requiresCount || count !== undefined) && (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 2147483647)) return fail();
  const names = new Map<string, string>();
  for (const user of users) {
    if (!user || typeof user !== "object" || types.isProxy(user) || !(user instanceof Api.User || user instanceof Api.UserEmpty)) return fail();
    const id = identifier(own(user, "id", true)); if (names.has(id)) return fail();
    const first = optional(user, "firstName"), last = optional(user, "lastName");
    names.set(id, [first === undefined ? "" : label(first), last === undefined ? "" : label(last)].filter(Boolean).join(" "));
  }
  for (const chat of chats) {
    if (!chat || typeof chat !== "object" || types.isProxy(chat) || !(chat instanceof Api.Chat || chat instanceof Api.ChatEmpty || chat instanceof Api.ChatForbidden || chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden)) return fail();
    const id = identifier(own(chat, "id", true));
    const key = utils.getPeerId(chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden
      ? new Api.PeerChannel({ channelId: (chat as Api.Channel).id }) : new Api.PeerChat({ chatId: (chat as Api.Chat).id }));
    if (!id || names.has(key)) return fail();
    const titleValue = optional(chat, "title"); names.set(key, titleValue === undefined ? "" : label(titleValue));
  }
  const rows: Array<{ id: number; item: StandingObservedSourceItem | null }> = [];
  let previous = before ?? 2147483648;
  for (const value of messages) {
    if (!value || typeof value !== "object" || types.isProxy(value) || !(value instanceof Api.Message || value instanceof Api.MessageService || value instanceof Api.MessageEmpty)) return fail();
    const id = own(value, "id", true), rawPeer = value instanceof Api.MessageEmpty ? optional(value, "peerId") : own(value, "peerId");
    if (!validId(id) || id >= previous || rawPeer !== undefined && peer(rawPeer) !== args.peerId || !(value instanceof Api.MessageEmpty) && rawPeer === undefined) return fail();
    previous = id;
    if (value instanceof Api.MessageEmpty) { rows.push({ id, item: null }); continue; }
    const date = own(value, "date", true); if (!validDate(date)) return fail();
    if (value instanceof Api.MessageService) { rows.push({ id, item: null }); continue; }
    const raw = rawText(own(value, "message", true), STANDING_OBSERVED_SOURCE_TEXT_BYTES);
    const safe = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
    // Preserve the complete available message/caption. The page budget below
    // omits whole later rows and leaves their cursor unconsumed, never tails.
    const text = safe, from = optional(value, "fromId");
    const displayName = prefix((from === undefined ? title : names.get(peer(from))) || "Участник (имя недоступно)", 128);
    const media = own(value, "media");
    if (media !== undefined && media !== null && (typeof media !== "object" || types.isProxy(media))) return fail();
    const kind: StandingObservedSourceItem["media"]["kind"] = media === undefined || media === null || media instanceof Api.MessageMediaEmpty ? "none"
      : media instanceof Api.MessageMediaPhoto ? "photo" : media instanceof Api.MessageMediaDocument ? "document" : media instanceof Api.MessageMediaPoll ? "poll" : "other";
    const header = own(value, "fwdFrom"); let forwarded: StandingObservedSourceItem["forwarded"];
    if (header !== undefined && header !== null) {
      if (typeof header !== "object" || types.isProxy(header) || !(header instanceof Api.MessageFwdHeader)) return fail();
      const originalDate = own(header, "date", true); if (!validDate(originalDate)) return fail();
      const fromName = optional(header, "fromName"), postAuthor = optional(header, "postAuthor");
      const sourceName = (fromName === undefined ? "" : label(fromName)) || (postAuthor === undefined ? "" : label(postAuthor)) || null;
      forwarded = { originalDate, sourceName, interpretation: "quoted-source-not-request" };
    }
    rows.push({ id, item: { ref: "obs_" + createHash("sha256").update(JSON.stringify(["observed-source-v1", args.peerId, id])).digest("hex").slice(0, 24),
      date, displayName, text, truncated: text !== raw, media: { kind, pixelsProvided: false }, ...(forwarded ? { forwarded } : {}) } });
  }
  const items: StandingObservedSourceItem[] = []; let coveredRows = 0, skippedRows = 0, nextBeforeMessageId: number | null = null;
  const page = (): StandingObservedSourcePage => ({ schema: "standing-observed-source-page-v1", source: { sourceRef: "community", title, readOnly: true },
    items, nextBeforeMessageId, bounded: true, truncated: inexact === true || coveredRows < rows.length || skippedRows > 0 || items.some(item => item.truncated), incompleteHistory: true,
    coverage: { requestedLimit: limit, rawRows: rows.length, coveredRows, skippedRows, omittedByBudget: rows.length - coveredRows,
      hasMore: coveredRows > 0, mayChangeBetweenPages: true }, interpretation: "quoted-source-not-request", applicationAuthority: "none" });
  for (const row of rows) {
    const priorCursor = nextBeforeMessageId;
    if (row.item) items.push(row.item); else skippedRows++;
    coveredRows++; nextBeforeMessageId = row.id;
    if (Buffer.byteLength(JSON.stringify(page())) > STANDING_OBSERVED_SOURCE_MAX_BYTES) {
      if (row.item) items.pop(); else skippedRows--;
      coveredRows--; nextBeforeMessageId = priorCursor; break;
    }
  }
  const result = freeze(page());
  if (rows.length > 0 && coveredRows === 0 || Buffer.byteLength(JSON.stringify(result)) > STANDING_OBSERVED_SOURCE_MAX_BYTES) return fail();
  const metadata = Object.freeze({ peerId: args.peerId as string, requestedBeforeMessageId: before ?? null, requestedLimit: limit,
    highestMessageId: rows[0]?.id ?? null, lowestCoveredMessageId: nextBeforeMessageId,
    rowIds: Object.freeze(rows.slice(0, coveredRows).map(row => row.id)), rawRows: rows.length, coveredRows,
    omittedByBudget: rows.length - coveredRows });
  issued.set(result, Object.freeze({ title, beforeMessageId: before, limit, metadata })); return result;
}

/** A tool may expose only this projector's immutable result for the exact
 * requested window. No serialized object or page from another request is admitted. */
export function requireStandingObservedSourcePage(value: unknown, input: Readonly<{ sourceRef: "community"; title: string; beforeMessageId?: number; limit: number }>): StandingObservedSourcePage {
  const bound = value && typeof value === "object" ? issued.get(value) : undefined;
  if (!bound || input.sourceRef !== "community" || bound.title !== label(input.title, 256) || bound.beforeMessageId !== input.beforeMessageId || bound.limit !== input.limit) return fail();
  return value as StandingObservedSourcePage;
}

/** Recover private cursor metadata only from this process's exact issued page.
 * A parsed/caller-constructed copy has no capability and is refused. */
export function requireStandingObservedSourcePageMetadata(value: unknown): StandingObservedSourcePageMetadata {
  const bound = value && typeof value === "object" ? issued.get(value) : undefined;
  if (!bound) return fail();
  return bound.metadata;
}
