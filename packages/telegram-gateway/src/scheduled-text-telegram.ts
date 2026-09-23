import { STANDING_INCOMING_TEXT_BYTES } from "./standing-context.js";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotBinding, PilotInvoker, PilotPrimary } from "./pilot-telegram-adapter.js";

export type ScheduledTextOperation = Readonly<{ operationId: string; randomId: string; text: string; scheduleDate: number }>;
export type OwnedScheduledText = Readonly<ScheduledTextOperation & {
  schema: "owned-scheduled-text-v1"; chatId: string; accountId: string; replyToMessageId: number; scheduledMessageId: number;
}>;
export type ScheduledInspection = Readonly<{
  state: "queued" | "absent"; delivery: "unobserved"; record: OwnedScheduledText;
}>;
export class ScheduledTextError extends Error {
  constructor(readonly code: "config" | "state" | "date" | "primary" | "protocol" | "transport" | "aborted", readonly unknown: boolean) {
    super("SCHEDULED_TEXT_" + code.toUpperCase());
  }
}
const id = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) < 2147483647;
const long = (n: unknown): n is string => typeof n === "string" && /^[1-9]\d{0,18}$/.test(n) && BigInt(n) < 2n ** 63n;
const absent = (n: unknown) => n === undefined || n === null; // Real TL decode uses null for absent optionals.
const text = (n: unknown, maximum = 4096): n is string => typeof n === "string" && n.trim().length > 0 && Buffer.byteLength(n, "utf8") <= maximum &&
  !n.includes("\0") && Buffer.from(n, "utf8").toString("utf8") === n;
const samePeer = (peer: unknown, expected: string): boolean => { try { return utils.getPeerId(peer as Api.TypePeer) === expected; } catch { return false; } };
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).length === keys.length && keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k); return !!d && "value" in d && d.enumerable;
  });
const operationKeys = ["operationId", "randomId", "text", "scheduleDate"];
const recordKeys = [...operationKeys, "schema", "chatId", "accountId", "replyToMessageId", "scheduledMessageId"];
function discard(v: unknown): void {
  if (v instanceof Api.Updates || v instanceof Api.UpdatesCombined) { v.updates.length = 0; v.chats.length = 0; v.users.length = 0; }
  if (v instanceof Api.messages.Messages || v instanceof Api.messages.MessagesSlice || v instanceof Api.messages.ChannelMessages) {
    v.messages.length = 0; v.chats.length = 0; v.users.length = 0;
  }
}

/** One operation on the existing sole client and exact selected lease. No timer,
 * background task, cron, reconnect, automatic retry, other chat, or delivery claim.
 * Caller must persist operation/randomId and dispatch intent BEFORE scheduleOnce;
 * persist the returned record before releasing ownership. ownedRecord() exposes
 * an ACK candidate even if the later queue read fails; it is NOT queued proof.
 * An uncertain call stays
 * consumed even after restart: use its journal, never create a replacement send.
 * Reopening with a caller-authenticated ownedRecord permits only inspect/cancel.
 * Caller persists a cancellation intent before cancelOnce and must not replay it.
 * Injected invoke owns hard deadlines/retry fences; close/abort revokes publication
 * and new calls, but caller MUST join actual invocation before client teardown.
 * Queue absence cannot distinguish delivery, deletion, or external cancellation.
 */
export function createScheduledTextTelegramTransport(input: {
  client: PilotInvoker; binding: PilotBinding; peer: Api.InputPeerChat | Api.InputPeerChannel; self: Api.User;
  selected: PilotPrimary; signal: AbortSignal; isSelectionActive(): boolean;
  revalidatePrimary(signal: AbortSignal): Promise<PilotPrimary>;
  operation: ScheduledTextOperation; ownedRecord?: OwnedScheduledText; clock?: () => number;
}) {
  const fail = (code: ScheduledTextError["code"], unknown = false): never => { throw new ScheduledTextError(code, unknown); };
  if (!exact(input.operation, operationKeys)) return fail("config");
  const operation = Object.freeze({ ...input.operation }), binding = Object.freeze({ ...input.binding }), selected = Object.freeze({ ...input.selected });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operation.operationId) || !long(operation.randomId) || !text(operation.text) || !id(operation.scheduleDate) ||
      !long(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId) || !(input.self instanceof Api.User) || !input.self.self || input.self.bot || input.self.deleted ||
      input.self.id.toString() !== binding.accountId || selected.chatId !== binding.peerId || !long(selected.ownerId) || selected.ownerId === binding.accountId ||
      !id(selected.messageId) || !text(selected.text, STANDING_INCOMING_TEXT_BYTES) || !(input.peer instanceof Api.InputPeerChat || input.peer instanceof Api.InputPeerChannel) || !samePeer(input.peer, binding.peerId)) return fail("config");
  let peer: Api.InputPeerChat | Api.InputPeerChannel;
  try {
    peer = input.peer instanceof Api.InputPeerChat ? new Api.InputPeerChat({ chatId: bigInt(input.peer.chatId.toString()) }) :
      new Api.InputPeerChannel({ channelId: bigInt(input.peer.channelId.toString()), accessHash: bigInt(input.peer.accessHash.toString()) });
  } catch { return fail("config"); }
  if (peer instanceof Api.InputPeerChannel && (peer.accessHash.isZero() || peer.accessHash.lesser((-(2n ** 63n)).toString()) || peer.accessHash.greaterOrEquals((2n ** 63n).toString()))) return fail("config");
  const invoke = input.client.invoke.bind(input.client), signal = input.signal, active = input.isSelectionActive.bind(input), fresh = input.revalidatePrimary.bind(input);
  const clock = input.clock ?? Date.now;
  let record: OwnedScheduledText | undefined;
  if (input.ownedRecord !== undefined) {
    const saved = input.ownedRecord;
    if (!exact(saved, recordKeys) || saved.schema !== "owned-scheduled-text-v1" || !id(saved.scheduledMessageId) ||
        saved.chatId !== binding.peerId || saved.accountId !== binding.accountId || saved.replyToMessageId !== selected.messageId ||
        operationKeys.some(k => saved[k as keyof ScheduledTextOperation] !== operation[k as keyof ScheduledTextOperation])) return fail("config");
    record = Object.freeze({ ...saved });
  }
  let closed = false, busy = false, scheduleConsumed = record !== undefined, cancelConsumed = false, mutationStarted = false;
  function check(): void {
    let ok = false; try { ok = active() === true; } catch { /* Fixed refusal only. */ }
    if (closed || signal.aborted || !ok) return fail("aborted", mutationStarted);
  }
  async function exclusive<T>(f: () => Promise<T>): Promise<T> {
    check(); if (busy) return fail("state", mutationStarted); busy = true;
    try { return await f(); }
    catch (e) { closed = true; if (e instanceof ScheduledTextError) throw e; return fail("transport", mutationStarted); }
    finally { busy = false; }
  }
  async function revalidate(): Promise<void> {
    check(); const p = await fresh(signal); check();
    if (p.chatId !== selected.chatId || p.ownerId !== selected.ownerId || p.messageId !== selected.messageId || p.text !== selected.text) return fail("primary", mutationStarted);
  }
  function proof(value: unknown, scheduledId: number): void {
    if (!(value instanceof Api.Message) || value.id !== scheduledId || !value.out || value.post || value.fromScheduled || !samePeer(value.peerId, binding.peerId) ||
        !(value.fromId instanceof Api.PeerUser) || value.fromId.userId.toString() !== binding.accountId || value.message !== operation.text || value.date !== operation.scheduleDate ||
        !absent(value.fwdFrom) || !absent(value.viaBotId) || !absent(value.groupedId) || !absent(value.replyMarkup) || !absent(value.ttlPeriod) ||
        (!absent(value.media) && !(value.media instanceof Api.MessageMediaEmpty)) || (value.entities?.length ?? 0) !== 0 ||
        !(value.replyTo instanceof Api.MessageReplyHeader) || value.replyTo.replyToScheduled || value.replyTo.replyToMsgId !== selected.messageId ||
        (!absent(value.replyTo.replyToPeerId) && !samePeer(value.replyTo.replyToPeerId, binding.peerId))) return fail("protocol", mutationStarted);
  }
  async function request<T>(value: Api.AnyRequest, parse: (value: unknown) => T): Promise<T> {
    check(); let envelope: unknown;
    try { envelope = await invoke(value); check(); return parse(envelope); }
    finally { discard(envelope); }
  }
  function updates(value: unknown): Api.TypeUpdate[] {
    if (!(value instanceof Api.Updates || value instanceof Api.UpdatesCombined) || value.updates.length > 100 || value.users.length > 100 || value.chats.length > 100) return fail("protocol", mutationStarted);
    return value.updates;
  }
  async function inspectExact(): Promise<ScheduledInspection> {
    if (!record) return fail("state", mutationStarted);
    const owned = record;
    return request(new Api.messages.GetScheduledMessages({ peer, id: [owned.scheduledMessageId] }), value => {
      if (!(value instanceof Api.messages.Messages || value instanceof Api.messages.MessagesSlice || value instanceof Api.messages.ChannelMessages) ||
          value.messages.length > 1 || value.chats.length > 100 || value.users.length > 100) return fail("protocol", mutationStarted);
      const message = value.messages[0];
      if (message === undefined || message instanceof Api.MessageEmpty && message.id === owned.scheduledMessageId &&
          (absent(message.peerId) || samePeer(message.peerId, binding.peerId))) return Object.freeze({ state: "absent", delivery: "unobserved", record: owned });
      proof(message, owned.scheduledMessageId);
      return Object.freeze({ state: "queued", delivery: "unobserved", record: owned });
    });
  }
  return Object.freeze({
    scheduleOnce: () => exclusive(async (): Promise<ScheduledInspection> => {
      if (scheduleConsumed) return fail("state", mutationStarted); scheduleConsumed = true;
      await revalidate();
      const now = clock();
      if (!Number.isFinite(now) || now < 0 || operation.scheduleDate * 1000 - now < 60_000) return fail("date");
      check(); mutationStarted = true;
      const scheduledId = await request(new Api.messages.SendMessage({ peer, sendAs: new Api.InputPeerSelf(),
        replyTo: new Api.InputReplyToMessage({ replyToMsgId: selected.messageId }), message: operation.text,
        randomId: bigInt(operation.randomId), scheduleDate: operation.scheduleDate, noWebpage: true }), value => {
        const list = updates(value), scheduled = list.filter(x => x instanceof Api.UpdateNewScheduledMessage);
        if (scheduled.length !== 1 || list.some(x => x instanceof Api.UpdateNewMessage || x instanceof Api.UpdateNewChannelMessage)) return fail("protocol", true);
        const message = (scheduled[0] as Api.UpdateNewScheduledMessage).message;
        if (!id(message.id)) return fail("protocol", true); proof(message, message.id);
        const mappings = list.filter(x => x instanceof Api.UpdateMessageID);
        if (mappings.length > 1 || mappings.some(x => !(x instanceof Api.UpdateMessageID) || x.id !== message.id || x.randomId?.toString() !== operation.randomId)) return fail("protocol", true);
        return message.id;
      });
      record = Object.freeze({ schema: "owned-scheduled-text-v1", ...operation, chatId: binding.peerId, accountId: binding.accountId,
        replyToMessageId: selected.messageId, scheduledMessageId: scheduledId });
      const observed = await inspectExact();
      if (observed.state !== "queued") return fail("protocol", true);
      return observed;
    }),
    inspect: () => exclusive(inspectExact),
    ownedRecord: (): OwnedScheduledText | undefined => record,
    cancelOnce: () => exclusive(async (): Promise<Readonly<{ state: "removed-from-queue" | "already-absent"; delivery: "unobserved"; record: OwnedScheduledText }>> => {
      if (cancelConsumed || !record) return fail("state", mutationStarted); cancelConsumed = true;
      await revalidate();
      const before = await inspectExact();
      if (before.state === "absent") return Object.freeze({ state: "already-absent", delivery: "unobserved", record });
      check(); mutationStarted = true;
      await request(new Api.messages.DeleteScheduledMessages({ peer, id: [record.scheduledMessageId] }), value => {
        const list = updates(value), deleted = list.filter(x => x instanceof Api.UpdateDeleteScheduledMessages);
        if (deleted.length !== 1 || list.some(x => x instanceof Api.UpdateNewScheduledMessage || x instanceof Api.UpdateNewMessage || x instanceof Api.UpdateNewChannelMessage)) return fail("protocol", true);
        const ack = deleted[0] as Api.UpdateDeleteScheduledMessages;
        if (!samePeer(ack.peer, binding.peerId) || ack.messages.length !== 1 || ack.messages[0] !== record!.scheduledMessageId ||
            (ack.sentMessages?.length ?? 0) !== 0) return fail("protocol", true);
      });
      if ((await inspectExact()).state !== "absent") return fail("protocol", true);
      return Object.freeze({ state: "removed-from-queue", delivery: "unobserved", record });
    }),
    close() { closed = true; },
  });
}
