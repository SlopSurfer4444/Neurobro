import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotReadback, PilotSend, PilotTransport } from "./pilot-outbox.js";

/** Existing sole client only. The runner owns connect, retry fences, deadline and teardown. */
export interface PilotInvoker { invoke(request: Api.AnyRequest): Promise<unknown> }
export type PilotBinding = Readonly<{ accountId: string; peerId: string }>;
export type PilotPrimary = Readonly<{ chatId: string; ownerId: string; messageId: number; text: string }>;
const fail = (): never => { throw new Error("PILOT_TELEGRAM_REFUSED_OR_UNKNOWN"); };
const validId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0 && (id as number) <= 2_147_483_647;
const validUser = (id: string) => /^[1-9]\d{0,19}$/.test(id);
function samePeer(peer: Api.TypePeer | undefined, id: string): boolean {
  try { return peer !== undefined && utils.getPeerId(peer) === id; } catch { return false; }
}
function textOnly(message: Api.Message): boolean {
  return typeof message.message === "string" && message.message.trim().length > 0 && message.message.length <= 4096 &&
    Buffer.byteLength(message.message, "utf8") <= 4096 && !message.message.includes("\0") &&
    Buffer.from(message.message, "utf8").toString("utf8") === message.message &&
    !message.fwdFrom && !message.viaBotId && !message.groupedId && !message.replyMarkup &&
    (!message.media || message.media instanceof Api.MessageMediaEmpty);
}
function hashPresent(value: unknown): boolean {
  try { const n = BigInt(String(value)); return n !== 0n && n >= -(2n ** 63n) && n < 2n ** 63n; }
  catch { return false; }
}

/** Pure exact binding resolver. Title is deliberately not a selector. */
export function resolvePilotPeer(binding: PilotBinding, self: Api.User, envelope: unknown): Api.InputPeerChat | Api.InputPeerChannel {
  if (!validUser(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId) ||
      !(self instanceof Api.User) || !self.self || self.bot || self.deleted || self.id.toString() !== binding.accountId ||
      !(envelope instanceof Api.messages.Dialogs || envelope instanceof Api.messages.DialogsSlice) ||
      envelope.dialogs.length > 100 || envelope.chats.length > 100 || envelope.users.length > 100 || envelope.messages.length > 100) return fail();
  const dialogs = envelope.dialogs.filter(dialog => dialog instanceof Api.Dialog && samePeer(dialog.peer, binding.peerId));
  if (dialogs.length !== 1) fail();
  const entities = envelope.chats.filter(entity => {
    try { return utils.getPeerId(entity) === binding.peerId; } catch { return false; }
  });
  if (entities.length !== 1) fail();
  const entity = entities[0]!;
  if (entity instanceof Api.Chat && !entity.left && !entity.deactivated && !entity.migratedTo &&
      !entity.defaultBannedRights?.viewMessages && !entity.defaultBannedRights?.sendMessages) {
    return new Api.InputPeerChat({ chatId: entity.id });
  }
  if (entity instanceof Api.Channel && !entity.left && !entity.min && !entity.broadcast &&
      (entity.megagroup || entity.gigagroup) && !entity.bannedRights?.viewMessages && !entity.bannedRights?.sendMessages &&
      !entity.defaultBannedRights?.viewMessages && !entity.defaultBannedRights?.sendMessages && hashPresent(entity.accessHash)) {
    return new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash! });
  }
  return fail();
}

function exactMessage(envelope: unknown, chatId: string, messageId: number): Api.Message {
  if (!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) ||
      envelope.messages.length !== 1 || envelope.chats.length > 100 || envelope.users.length > 100) return fail();
  const message = envelope.messages[0];
  if (!(message instanceof Api.Message) || message.id !== messageId || !samePeer(message.peerId, chatId) || !textOnly(message)) return fail();
  return message;
}

/** Pure text-only primary validation. No neighboring messages, forwarding or attachments. */
export function parsePilotPrimary(envelope: unknown, chatId: string, ownerId: string, messageId: number): PilotPrimary {
  if (!validUser(ownerId) || !validId(messageId)) return fail();
  const message = exactMessage(envelope, chatId, messageId);
  if (!(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== ownerId ||
      message.post || !/^ПРОМПТ(?:\s|:|,|$)/u.test(message.message)) return fail();
  return Object.freeze({ chatId, ownerId, messageId, text: message.message });
}

/** Acknowledgement is only an ID candidate; the outbox still requires a fresh exact read. */
export function extractPilotSentId(envelope: unknown, randomId: string, chatId: string): number {
  if (envelope instanceof Api.UpdateShortSentMessage) {
    if (!envelope.out || !validId(envelope.id) || (envelope.media && !(envelope.media instanceof Api.MessageMediaEmpty))) return fail();
    return envelope.id;
  }
  if (!(envelope instanceof Api.Updates || envelope instanceof Api.UpdatesCombined) ||
      envelope.updates.length > 100 || envelope.chats.length > 100 || envelope.users.length > 100) return fail();
  const mappings = envelope.updates.filter(update => update instanceof Api.UpdateMessageID && update.randomId?.toString() === randomId);
  if (mappings.length !== 1) return fail();
  const mapped = mappings[0] as Api.UpdateMessageID;
  if (!validId(mapped.id)) return fail();
  const echoed = envelope.updates.filter(update => (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) && update.message.id === mapped.id);
  if (echoed.length > 1) return fail();
  for (const update of echoed) {
    if (!(update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) ||
        !(update.message instanceof Api.Message) || !samePeer(update.message.peerId, chatId)) return fail();
  }
  return mapped.id;
}

function discard(envelope: unknown): void {
  // Drop protocol-carried bodies/entities immediately; never log/return the envelope.
  // GramJS invoke may already cache entity metadata in its owned client/session;
  // clearing these arrays does not erase that cache. Message bodies are not cached there.
  if (envelope instanceof Api.messages.Dialogs || envelope instanceof Api.messages.DialogsSlice ||
      envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) {
    envelope.messages.length = 0; envelope.users.length = 0; envelope.chats.length = 0;
  } else if (envelope instanceof Api.Updates || envelope instanceof Api.UpdatesCombined) {
    envelope.updates.length = 0; envelope.users.length = 0; envelope.chats.length = 0;
  }
}

/** No reconnect, pagination, polling, event listener or automatic send is provided.
 * Protocol calls can outlive signal abort: runner must settle its sole client before
 * releasing the lock. The adapter latches terminal refusal and never retries. */
export async function createPilotTelegramAdapter(input: {
  client: PilotInvoker; binding: PilotBinding; self: Api.User; signal: AbortSignal; mode?: "owner-prompt" | "greeting";
}): Promise<Readonly<{ readExactPrompt(ownerId: string, messageId: number, signal: AbortSignal): Promise<PilotPrimary>; transport: PilotTransport }>> {
  const mode = input.mode ?? "owner-prompt";
  if (mode !== "owner-prompt" && mode !== "greeting") return fail();
  const binding = Object.freeze({ ...input.binding });
  const invoke = input.client.invoke.bind(input.client);
  let closed = false;
  async function request<T>(requestValue: Api.AnyRequest, signal: AbortSignal, parse: (envelope: unknown) => T): Promise<T> {
    if (closed || input.signal.aborted || signal.aborted) return fail();
    let envelope: unknown;
    try {
      envelope = await invoke(requestValue);
      if (closed || input.signal.aborted || signal.aborted) return fail();
      return parse(envelope);
    } catch { closed = true; return fail(); }
    finally { discard(envelope); }
  }
  // Validate self before the first network call, even if dialog parsing would refuse it.
  if (!(input.self instanceof Api.User) || !input.self.self || input.self.bot || input.self.deleted || input.self.id.toString() !== binding.accountId ||
      !validUser(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId)) return fail();
  const peer = await request(new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(), limit: 100, hash: bigInt.zero }), input.signal,
    envelope => resolvePilotPeer(binding, input.self, envelope));
  const getMessage = (id: number): Api.AnyRequest => peer instanceof Api.InputPeerChannel
    ? new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }), id: [new Api.InputMessageID({ id })] })
    : new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id })] });
  let primaryConsumed = false;
  let anchor: number | undefined;
  let sendConsumed = false;
  let sentId: number | undefined;
  let sentReplyTo: number | null | undefined;
  let sentText: string | undefined;
  let readbackConsumed = false;
  return Object.freeze({
    async readExactPrompt(ownerId: string, messageId: number, signal: AbortSignal) {
      if (mode !== "owner-prompt" || primaryConsumed || sendConsumed || !validUser(ownerId) || ownerId === binding.accountId || !validId(messageId)) return fail();
      primaryConsumed = true;
      const primary = await request(getMessage(messageId), signal, envelope => parsePilotPrimary(envelope, binding.peerId, ownerId, messageId));
      anchor = primary.messageId;
      return primary;
    },
    transport: Object.freeze({
      async sendOnce(reply: PilotSend, signal: AbortSignal) {
        reply = Object.freeze({ ...reply });
        const expectedAnchor = mode === "greeting" ? null : anchor;
        if (sendConsumed || expectedAnchor === undefined || reply.chatId !== binding.peerId || reply.replyToMessageId !== expectedAnchor ||
            typeof reply.text !== "string" || !reply.text.trim() || reply.text.length > 4096 || Buffer.byteLength(reply.text, "utf8") > 4096 ||
            reply.text.includes("\0") || Buffer.from(reply.text, "utf8").toString("utf8") !== reply.text ||
            !/^[1-9]\d{0,18}$/.test(reply.randomId) || BigInt(reply.randomId) >= 2n ** 63n) return fail();
        sendConsumed = true;
        const id = await request(new Api.messages.SendMessage({ peer, ...(expectedAnchor === null ? {} : { replyTo: new Api.InputReplyToMessage({ replyToMsgId: expectedAnchor }) }),
          message: reply.text, randomId: bigInt(reply.randomId), sendAs: new Api.InputPeerSelf(), noWebpage: true, entities: [], clearDraft: false, allowPaidFloodskip: false }), signal,
        envelope => extractPilotSentId(envelope, reply.randomId, binding.peerId));
        sentId = id;
        sentReplyTo = expectedAnchor;
        sentText = reply.text;
        return { messageId: id };
      },
      async readExact(chatId: string, messageId: number, signal: AbortSignal): Promise<PilotReadback> {
        if (readbackConsumed || sentId === undefined || messageId !== sentId || chatId !== binding.peerId) return fail();
        readbackConsumed = true;
        return request(getMessage(messageId), signal, envelope => {
          const message = exactMessage(envelope, binding.peerId, messageId);
          if (!(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== binding.accountId || message.message !== sentText) return fail();
          if (sentReplyTo === null) {
            if (message.replyTo) return fail();
          } else if (!(message.replyTo instanceof Api.MessageReplyHeader) || message.replyTo.replyToMsgId !== sentReplyTo ||
              (message.replyTo.replyToPeerId && !samePeer(message.replyTo.replyToPeerId, binding.peerId))) return fail();
          return Object.freeze({ messageId, chatId: binding.peerId, accountId: binding.accountId, replyToMessageId: sentReplyTo!, text: message.message });
        });
      },
    }),
  });
}
