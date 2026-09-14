import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { types } from "node:util";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotBinding, PilotInvoker } from "./pilot-telegram-adapter.js";
import type { ConversationReferences } from "./conversation-references.js";

export type SelfHistoryRequest = Readonly<{ fromDate: number; toDate: number; cursor?: string }>;
export type SelfHistoryMessage = Readonly<{
  ref: string; authorRef: string; author: "self" | "user" | "bot" | "unknown"; displayName: string;
  date: number; editedAt: number | null; replyRef: string | null; replyUnavailable: boolean; text: string;
}>;
export type SelfHistoryPage = Readonly<{
  schema: "neurobro-self-history-v1"; fromDate: number; toDate: number;
  messages: readonly SelfHistoryMessage[]; cursor: string | null; hasMore: boolean;
  status: "more" | "lower-bound-reached" | "empty-page" | "inaccessible";
  coverage: Readonly<{ scope: "available-history-snapshot"; oldestExaminedDate: number | null; newestExaminedDate: number | null;
    traversalComplete: boolean; undatedEntries: number; pages: number }>;
  excluded: Readonly<{ nonText: number; invalidText: number; unavailable: number; outsidePeriod: number }>;
  limitations: readonly ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"];
}>;
/** Host-private durable traversal position. This is not a model cursor or an
 * authorization token; the task store owns admission and authentic persistence. */
export type SelfHistoryTaskCheckpoint = Readonly<{
  schema: "self-history-task-checkpoint-v1"; accountId: string; chatId: string;
  fromDate: number; toDate: number; offsetId: number; lastDate: number;
  oldestDate: number | null; newestDate: number | null; undated: number; pages: number; inexact: boolean;
  upperBoundMessageId: number | null; status: SelfHistoryPage["status"];
}>;
export type SelfHistoryTaskRequest = Readonly<{ fromDate: number; toDate: number; checkpoint?: SelfHistoryTaskCheckpoint }>;
export type SelfHistoryTaskSource = Readonly<{
  messageId: number; date: number | null;
  disposition: "included" | "nonText" | "invalidText" | "unavailable" | "outsidePeriod";
  messageRef?: string; authorId?: string; replyToMessageId?: number;
}>;
export type SelfHistoryTaskPage = Readonly<{
  page: SelfHistoryPage; sources: readonly SelfHistoryTaskSource[];
  beforeCheckpoint: SelfHistoryTaskCheckpoint; nextCheckpoint: SelfHistoryTaskCheckpoint;
}>;
export class SelfHistoryReaderError extends Error {
  constructor(readonly code: "input" | "binding" | "cursor" | "protocol" | "transport" | "aborted" | "busy") { super("SELF_HISTORY_" + code.toUpperCase()); }
}
const fail = (code: SelfHistoryReaderError["code"]): never => { throw new SelfHistoryReaderError(code); };
const idValid = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0 && (id as number) <= 2147483647;
const dateValid = (date: unknown): date is number => Number.isSafeInteger(date) && (date as number) > 0 && (date as number) < 2147483647;
const userValid = (id: string) => /^[1-9]\d{0,19}$/.test(id);
const textValid = (value: unknown, maximum: number): value is string => typeof value === "string" && value.trim().length > 0 &&
  !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximum && Buffer.from(value, "utf8").toString("utf8") === value;
const samePeer = (value: Api.TypePeer | undefined, expected: string) => { try { return value !== undefined && utils.getPeerId(value) === expected; } catch { return false; } };

function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(key => !Object.hasOwn(ds, key)) || keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) return fail("input");
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) { const d = ds[key]!; if (!("value" in d) || !d.enumerable) return fail("input"); result[key] = d.value; }
  return result;
}
export function snapshotSelfHistoryTaskCheckpoint(value: unknown): SelfHistoryTaskCheckpoint {
  const v = data(value, ["schema", "accountId", "chatId", "fromDate", "toDate", "offsetId", "lastDate", "oldestDate", "newestDate", "undated", "pages", "inexact", "upperBoundMessageId", "status"]);
  const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
  if (v.schema !== "self-history-task-checkpoint-v1" || typeof v.accountId !== "string" || !userValid(v.accountId) || typeof v.chatId !== "string" || !/^-[1-9]\d{0,19}$/u.test(v.chatId) ||
      !dateValid(v.fromDate) || !dateValid(v.toDate) || v.fromDate > v.toDate || !dateValid(v.lastDate) || v.lastDate < v.fromDate || v.lastDate > v.toDate ||
      !(v.offsetId === 0 || idValid(v.offsetId)) || !(v.oldestDate === null || dateValid(v.oldestDate)) || !(v.newestDate === null || dateValid(v.newestDate)) ||
      !natural(v.undated) || !natural(v.pages) || typeof v.inexact !== "boolean" || !(v.upperBoundMessageId === null || idValid(v.upperBoundMessageId)) ||
      typeof v.status !== "string" || !["more", "lower-bound-reached", "empty-page", "inaccessible"].includes(v.status)) return fail("input");
  if ((v.oldestDate === null) !== (v.newestDate === null) || v.oldestDate !== null && (v.oldestDate !== v.lastDate || v.newestDate === null || v.newestDate < v.oldestDate || v.newestDate > v.toDate)) return fail("input");
  if (v.offsetId === 0) {
    if (v.upperBoundMessageId !== null || v.oldestDate !== null || v.undated !== 0 || v.lastDate !== v.toDate || v.pages > 0 && v.status === "more") return fail("input");
  } else if (v.pages === 0 || v.upperBoundMessageId === null || v.upperBoundMessageId < v.offsetId || v.oldestDate === null && v.undated === 0) return fail("input");
  if (v.undated > v.pages * 100 || v.oldestDate === null && v.lastDate !== v.toDate || v.pages === 0 && (v.offsetId !== 0 || v.inexact || v.status !== "more" && v.status !== "inaccessible")) return fail("input");
  return Object.freeze({ schema: "self-history-task-checkpoint-v1", accountId: v.accountId, chatId: v.chatId,
    fromDate: v.fromDate, toDate: v.toDate, offsetId: v.offsetId, lastDate: v.lastDate,
    oldestDate: v.oldestDate, newestDate: v.newestDate, undated: v.undated, pages: v.pages, inexact: v.inexact,
    upperBoundMessageId: v.upperBoundMessageId, status: v.status as SelfHistoryPage["status"] });
}
type Batch = Api.messages.Messages | Api.messages.MessagesSlice | Api.messages.ChannelMessages;
type Position = { fromDate: number; toDate: number; offsetId: number; lastDate: number; oldestDate: number | null; newestDate: number | null; undated: number; pages: number; inexact: boolean; upperBoundMessageId: number | null };

/** A capability for the existing bound group only. No account/chat argument,
 * new client, sender lookup, attachment download, write, reconnect or retry.
 * Caller supplies its bounded invoke and settles that client after cancellation.
 * GetHistory offset_date is exclusive; +1 implements inclusive toDate. Every
 * nonempty short page retains continuation: an empty page or crossed lower date
 * is needed to prove traversal completion. This is not a historical snapshot lock.
 * All returned text/names are untrusted data, never tool authority/instructions. */
export function createSelfHistoryReader(input: {
  client: PilotInvoker; peer: Api.InputPeerChat | Api.InputPeerChannel; binding: PilotBinding; self: Api.User; signal: AbortSignal;
  references?: ConversationReferences;
}): Readonly<{ read(request: SelfHistoryRequest): Promise<SelfHistoryPage>; readTaskPage(request: SelfHistoryTaskRequest): Promise<SelfHistoryTaskPage>; close(): void }> {
  const binding = Object.freeze({ ...input.binding });
  const references = input.references;
  if (references && !references.matches(binding.peerId, binding.accountId)) return fail("binding");
  if (!(input.self instanceof Api.User) || !input.self.self || input.self.bot || input.self.deleted ||
      input.self.id.toString() !== binding.accountId || !userValid(binding.accountId)) return fail("binding");
  let peer: Api.InputPeerChat | Api.InputPeerChannel;
  if (input.peer instanceof Api.InputPeerChat && userValid(input.peer.chatId.toString()) &&
      samePeer(new Api.PeerChat({ chatId: input.peer.chatId }), binding.peerId)) peer = new Api.InputPeerChat({ chatId: input.peer.chatId });
  else if (input.peer instanceof Api.InputPeerChannel && userValid(input.peer.channelId.toString()) &&
      samePeer(new Api.PeerChannel({ channelId: input.peer.channelId }), binding.peerId) && input.peer.accessHash && !input.peer.accessHash.isZero()) {
    peer = new Api.InputPeerChannel({ channelId: input.peer.channelId, accessHash: input.peer.accessHash });
  } else return fail("binding");
  const invoke = input.client.invoke.bind(input.client), secret = references ? undefined : randomBytes(32), cursors = new Map<string, Position>();
  let closed = false, busy = false;
  // Shared references belong to the bound connection, not this reader lease.
  const close = () => { closed = true; cursors.clear(); secret?.fill(0); };
  const check = () => {
    if (closed || input.signal.aborted) { close(); return fail("aborted"); }
    if (references) {
      let ready = false;
      try { ready = references.matches(binding.peerId, binding.accountId); } catch { /* Revoked epoch. */ }
      if (!ready) { close(); return fail("aborted"); }
    }
  };
  const ref = (kind: "m" | "a", raw: string) => references
    ? kind === "m" ? references.message(Number(raw)) : references.speaker(raw)
    : kind + "_" + createHmac("sha256", secret!).update(kind + ":" + raw).digest("hex").slice(0, 24);
  const name = (user: Api.User | undefined, own: boolean): string => {
    if (own) return "Нейробро";
    const raw = [user?.firstName, user?.lastName].filter(value => typeof value === "string").map(value => value!.slice(0, 128)).join(" ") || user?.username || "Неизвестный участник";
    return Buffer.from(raw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, 128), "utf8").toString("utf8").replace(/\ufffd/gu, "") || "Участник";
  };
  const limitations: SelfHistoryPage["limitations"] = Object.freeze(["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"]);
  const checkpoint = (position: Position, status: SelfHistoryPage["status"]): SelfHistoryTaskCheckpoint => snapshotSelfHistoryTaskCheckpoint({
    schema: "self-history-task-checkpoint-v1", accountId: binding.accountId, chatId: binding.peerId,
    fromDate: position.fromDate, toDate: position.toDate, offsetId: position.offsetId, lastDate: position.lastDate,
    oldestDate: position.oldestDate, newestDate: position.newestDate, undated: position.undated, pages: position.pages, inexact: position.inexact,
    upperBoundMessageId: position.upperBoundMessageId, status });
  async function readPage(request: SelfHistoryRequest, beforeCheckpoint?: SelfHistoryTaskCheckpoint): Promise<{ page: SelfHistoryPage; nextCheckpoint?: SelfHistoryTaskCheckpoint; sources: readonly SelfHistoryTaskSource[] }> {
    check(); if (busy) return fail("busy");
    if (!request || Object.keys(request).some(key => !["fromDate", "toDate", "cursor"].includes(key)) ||
        !dateValid(request.fromDate) || !dateValid(request.toDate) || request.fromDate > request.toDate ||
        (request.cursor !== undefined && (typeof request.cursor !== "string" || !/^[0-9a-f-]{36}$/.test(request.cursor)))) return fail("input");
    const found = request.cursor === undefined ? undefined : cursors.get(request.cursor);
    if (request.cursor !== undefined && (!found || found.fromDate !== request.fromDate || found.toDate !== request.toDate)) return fail("cursor");
    const position: Position = beforeCheckpoint ? { ...beforeCheckpoint } : found ? { ...found } : { fromDate: request.fromDate, toDate: request.toDate, offsetId: 0, lastDate: request.toDate,
      oldestDate: null, newestDate: null, undated: 0, pages: 0, inexact: false, upperBoundMessageId: null };
    const startOffsetId = position.offsetId, sources: SelfHistoryTaskSource[] = [];
    busy = true; let envelope: unknown;
    const excluded = { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, messages: SelfHistoryMessage[] = [];
    const coverage = (complete: boolean) => ({ scope: "available-history-snapshot" as const, oldestExaminedDate: position.oldestDate,
      newestExaminedDate: position.newestDate, traversalComplete: complete && position.undated === 0 && !position.inexact, undatedEntries: position.undated, pages: position.pages });
    try {
      try {
        check(); envelope = await invoke(new Api.messages.GetHistory({ peer, offsetId: position.offsetId, offsetDate: position.offsetId ? 0 : position.toDate + 1,
          addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: bigInt.zero })); check();
      } catch (error) {
        check();
        const code = error && typeof error === "object" ? (error as { errorMessage?: unknown }).errorMessage : undefined;
        if (typeof code === "string" && ["CHANNEL_PRIVATE", "CHAT_ADMIN_REQUIRED", "USER_BANNED_IN_CHANNEL", "FROZEN_PARTICIPANT_MISSING"].includes(code)) {
          if (request.cursor) cursors.delete(request.cursor);
          return { page: Object.freeze({ schema: "neurobro-self-history-v1", fromDate: position.fromDate, toDate: position.toDate, messages: [], cursor: null, hasMore: false,
            status: "inaccessible", coverage: coverage(false), excluded, limitations }), sources: Object.freeze(sources),
            ...(beforeCheckpoint ? { nextCheckpoint: checkpoint(position, "inaccessible") } : {}) };
        }
        return fail("transport");
      }
      if (!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) ||
          envelope.messages.length > 100 || envelope.users.length > 200 || envelope.chats.length > 100) return fail("protocol");
      const batch: Batch = envelope; position.pages++;
      if ("inexact" in batch && batch.inexact) position.inexact = true;
      let previousId = position.offsetId || 2147483648, previousDate = position.lastDate;
      // Validate descending bound peer/ID/date before returning any partial page.
      for (const value of batch.messages) {
        if (!(value instanceof Api.Message || value instanceof Api.MessageService || value instanceof Api.MessageEmpty) ||
            !idValid(value.id) || value.id >= previousId || (value.peerId && !samePeer(value.peerId, binding.peerId)) ||
            (!(value instanceof Api.MessageEmpty) && !samePeer(value.peerId, binding.peerId))) return fail("protocol");
        previousId = value.id;
        if (!(value instanceof Api.MessageEmpty) && dateValid(value.date)) { if (value.date > previousDate) return fail("protocol"); previousDate = value.date; }
      }
      let status: SelfHistoryPage["status"] = batch.messages.length === 0 ? "empty-page" : "more", complete = batch.messages.length === 0;
      let usedBytes = 0;
      for (const value of batch.messages) {
        const date = !(value instanceof Api.MessageEmpty) && dateValid(value.date) ? value.date : null;
        if (date !== null && date < position.fromDate) { status = "lower-bound-reached"; complete = true; break; }
        let projected: SelfHistoryMessage | undefined;
        let reason: keyof typeof excluded | undefined;
        if (date === null || value instanceof Api.MessageEmpty) reason = "unavailable";
        else if (date > position.toDate) reason = "outsidePeriod";
        else if (!(value instanceof Api.Message) || !(value.fromId instanceof Api.PeerUser) || value.post || value.fwdFrom || value.viaBotId || value.groupedId || value.replyMarkup ||
            (value.media && !(value.media instanceof Api.MessageMediaEmpty))) reason = "nonText";
        else if (!textValid(value.message, 4096)) reason = "invalidText";
        else {
          const authorId = value.fromId.userId.toString(), own = authorId === binding.accountId;
          const matches = batch.users.filter(user => user.id.toString() === authorId), user = matches.length === 1 && matches[0] instanceof Api.User ? matches[0] : undefined;
          if (!userValid(authorId) || !!value.out !== own || matches.length > 1 || (!own && user?.self)) reason = "unavailable";
          else {
            const reply = value.replyTo, replyValid = reply instanceof Api.MessageReplyHeader && !reply.replyToScheduled && idValid(reply.replyToMsgId) &&
              reply.replyToMsgId < value.id && (!reply.replyToPeerId || samePeer(reply.replyToPeerId, binding.peerId));
            projected = Object.freeze({ ref: ref("m", String(value.id)), authorRef: ref("a", authorId),
              author: own ? "self" : !user || user.deleted ? "unknown" : user.bot ? "bot" : "user", displayName: name(user, own),
              date, editedAt: dateValid(value.editDate) ? value.editDate : null, replyRef: replyValid ? ref("m", String(reply.replyToMsgId)) : null,
              replyUnavailable: !!reply && !replyValid, text: value.message });
          }
        }
        const size = projected ? Buffer.byteLength(JSON.stringify(projected), "utf8") : 0;
        if (projected && usedBytes + size > 60_000) break; // Do not consume omitted message; next cursor starts before it.
        if (position.upperBoundMessageId === null) position.upperBoundMessageId = value.id;
        position.offsetId = value.id;
        if (date === null) position.undated++;
        else { position.lastDate = date; position.oldestDate = position.oldestDate === null ? date : Math.min(position.oldestDate, date); position.newestDate = position.newestDate === null ? date : Math.max(position.newestDate, date); }
        if (projected) { messages.push(projected); usedBytes += size; } else if (reason) excluded[reason]++;
        if (beforeCheckpoint) {
          const reply = !(value instanceof Api.MessageEmpty) ? value.replyTo : undefined;
          sources.push(Object.freeze({ messageId: value.id, date, disposition: projected ? "included" : reason!,
            ...(projected && value instanceof Api.Message && value.fromId instanceof Api.PeerUser ? {
              messageRef: projected.ref, authorId: value.fromId.userId.toString(),
              ...(projected.replyRef !== null && reply instanceof Api.MessageReplyHeader ? { replyToMessageId: reply.replyToMsgId } : {}) } : {}) }));
        }
      }
      if ("inexact" in batch && batch.inexact) complete = false;
      if (request.cursor) cursors.delete(request.cursor);
      const hasMore = status === "more";
      let cursor: string | null = null;
      if (hasMore) {
        if (position.offsetId === startOffsetId) return fail("protocol");
        if (!beforeCheckpoint) {
          cursor = randomUUID(); cursors.set(cursor, position);
          if (cursors.size > 256) cursors.delete(cursors.keys().next().value!);
        }
      }
      const result: SelfHistoryPage = Object.freeze({ schema: "neurobro-self-history-v1", fromDate: position.fromDate, toDate: position.toDate,
        messages: Object.freeze(messages.reverse()), cursor, hasMore, status, coverage: Object.freeze(coverage(complete)), excluded: Object.freeze(excluded), limitations });
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 65_536) return fail("protocol");
      return { page: result, sources: Object.freeze(sources), ...(beforeCheckpoint ? { nextCheckpoint: checkpoint(position, status) } : {}) };
    } catch (error) { if (error instanceof SelfHistoryReaderError) throw error; return fail("protocol"); }
    finally {
      if (envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) {
        envelope.messages.length = 0; envelope.users.length = 0; envelope.chats.length = 0;
      }
      busy = false;
    }
  }
  return Object.freeze({ close,
    async read(request: SelfHistoryRequest): Promise<SelfHistoryPage> { return (await readPage(request)).page; },
    async readTaskPage(value: SelfHistoryTaskRequest): Promise<SelfHistoryTaskPage> {
      check(); if (busy) return fail("busy");
      const request = data(value, ["fromDate", "toDate"], ["checkpoint"]);
      if (!dateValid(request.fromDate) || !dateValid(request.toDate) || request.fromDate > request.toDate) return fail("input");
      const before = Object.hasOwn(request, "checkpoint") ? snapshotSelfHistoryTaskCheckpoint(request.checkpoint) : checkpoint({
        fromDate: request.fromDate, toDate: request.toDate, offsetId: 0, lastDate: request.toDate, oldestDate: null, newestDate: null,
        undated: 0, pages: 0, inexact: false, upperBoundMessageId: null }, "more");
      if (before.accountId !== binding.accountId || before.chatId !== binding.peerId) return fail("binding");
      if (before.fromDate !== request.fromDate || before.toDate !== request.toDate || before.status !== "more") return fail("input");
      const result = await readPage({ fromDate: before.fromDate, toDate: before.toDate }, before);
      return Object.freeze({ page: result.page, sources: result.sources, beforeCheckpoint: before, nextCheckpoint: result.nextCheckpoint! });
    },
  });
}
