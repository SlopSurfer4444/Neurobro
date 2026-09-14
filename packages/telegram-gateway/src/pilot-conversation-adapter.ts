import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotReadback, PilotSend, PilotTransport } from "./pilot-outbox.js";
import { resolvePilotPeer, extractPilotSentId, type PilotBinding, type PilotInvoker, type PilotPrimary } from "./pilot-telegram-adapter.js";

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
function exactMessage(envelope: unknown, chatId: string, messageId: number): Api.Message {
  if (!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) ||
      envelope.messages.length !== 1 || envelope.chats.length > 100 || envelope.users.length > 100) return fail();
  const message = envelope.messages[0];
  if (!(message instanceof Api.Message) || message.id !== messageId || !samePeer(message.peerId, chatId) || !textOnly(message)) return fail();
  return message;
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

type Batch = Api.messages.Messages | Api.messages.MessagesSlice | Api.messages.ChannelMessages;
type Selected = PilotPrimary & { date: number };
function messageBatch(envelope: unknown, limit: number): Batch {
  if (!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) ||
      envelope.messages.length > limit || envelope.users.length > 100 || envelope.chats.length > 100) return fail();
  return envelope;
}
function eligible(message: unknown, users: Api.TypeUser[], binding: PilotBinding, startedAt: number): Selected | undefined {
  if (!(message instanceof Api.Message) || !validId(message.id) || !samePeer(message.peerId, binding.peerId) ||
      !(message.fromId instanceof Api.PeerUser) || message.out || message.post || !textOnly(message) ||
      !Number.isSafeInteger(message.date) || message.date < startedAt || !/^ПРОМПТ(?:\s|:|,|$)/u.test(message.message)) return;
  const ownerId = message.fromId.userId.toString();
  if (!validUser(ownerId) || ownerId === binding.accountId || users.some(user => user.id.toString() === ownerId &&
      user instanceof Api.User && (user.bot || user.deleted || user.self))) return;
  return { chatId: binding.peerId, ownerId, messageId: message.id, text: message.message, date: message.date };
}
async function waitDefault(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("PILOT_TELEGRAM_REFUSED_OR_UNKNOWN")); return; }
    const abort = () => { clearTimeout(timer); reject(new Error("PILOT_TELEGRAM_REFUSED_OR_UNKNOWN")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One foreground prompt and one anchored answer; no reconnect or request retries.
 * Polling reads only ten most recent envelopes per call, at most thirty times.
 * A bounded window may miss traffic; it is not a persistent listener or backlog.
 * Bodies are discarded after selection. Only selected primary text belongs in model input.
 * Invoke may outlive abort; runner owns deadline, client teardown and encrypted outbox.
 * clock/wait are trusted test hooks in monotonic milliseconds; startedAt is Unix seconds. */
export async function createConversationAdapter(input: {
  client: PilotInvoker; binding: PilotBinding; self: Api.User; signal: AbortSignal; startedAt: number;
  clock?: () => number; wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<Readonly<{ waitForPrompt(signal: AbortSignal): Promise<PilotPrimary>; transport: PilotTransport }>> {
  const startedAt = input.startedAt;
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
  if (!Number.isSafeInteger(input.startedAt) || input.startedAt <= 0 || !(input.self instanceof Api.User) || !input.self.self || input.self.bot || input.self.deleted || input.self.id.toString() !== binding.accountId ||
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
    async waitForPrompt(signal: AbortSignal): Promise<PilotPrimary> {
      if (closed || primaryConsumed || sendConsumed) return fail();
      primaryConsumed = true;
      try {
        const now = input.clock ?? (() => performance.now());
        const wait = input.wait ?? waitDefault;
        const began = now();
        if (!Number.isFinite(began)) return fail();
        let previous = began - 3000;
        for (let poll = 0; poll < 30; poll++) {
          if (input.signal.aborted || signal.aborted) return fail();
          const before = now();
          if (!Number.isFinite(before) || before < began || before - began >= 90_000) return fail();
          const delay = Math.max(0, 3000 - (before - previous));
          if (delay > 0) await wait(delay, AbortSignal.any([input.signal, signal]));
          const current = now();
          if (!Number.isFinite(current) || current < before || current - previous < 3000 || current - began >= 90_000) return fail();
          previous = current;
          const selected = await request(new Api.messages.GetHistory({ peer, offsetId: 0, offsetDate: 0,
            addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: bigInt.zero }), signal, envelope => {
            const batch = messageBatch(envelope, 10);
            let oldest: Selected | undefined;
            for (const message of batch.messages) {
              const candidate = eligible(message, batch.users, binding, startedAt);
              if (candidate && (!oldest || candidate.date < oldest.date ||
                  (candidate.date === oldest.date && candidate.messageId < oldest.messageId))) oldest = candidate;
            }
            return oldest;
          });
          if (!selected) continue;
          const primary = await request(getMessage(selected.messageId), signal, envelope => {
            const batch = messageBatch(envelope, 1);
            if (batch.messages.length !== 1) return fail();
            const fresh = eligible(batch.messages[0], batch.users, binding, startedAt);
            if (!fresh || fresh.chatId !== selected.chatId || fresh.ownerId !== selected.ownerId ||
                fresh.messageId !== selected.messageId || fresh.date !== selected.date || fresh.text !== selected.text) return fail();
            return Object.freeze({ chatId: fresh.chatId, ownerId: fresh.ownerId, messageId: fresh.messageId, text: fresh.text });
          });
          anchor = primary.messageId;
          return primary;
        }
        return fail();
      } catch { closed = true; return fail(); }
    },
    transport: Object.freeze({
      async sendOnce(reply: PilotSend, signal: AbortSignal) {
        reply = Object.freeze({ ...reply });
        const expectedAnchor = anchor;
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
          if (!message.out || message.post || !(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== binding.accountId || message.message !== sentText) return fail();
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
