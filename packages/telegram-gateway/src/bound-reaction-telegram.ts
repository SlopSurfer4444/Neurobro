import { STANDING_INCOMING_TEXT_BYTES } from "./standing-context.js";
import { types } from "node:util";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotBinding, PilotInvoker, PilotPrimary } from "./pilot-telegram-adapter.js";

export type BoundReactionAggregate = Readonly<{ emoji: string; count: number; chosen: boolean | null; externalCount: number | null }>;
export type BoundReactionAvailability = Readonly<{ mode: "none" | "all" | "some"; emoji: readonly string[] }>;
export type BoundReactionReadback = Readonly<{
  targetMessageId: number;
  ownEmojis: readonly string[];
  ownStateComplete: boolean;
  unsupportedOwnReaction: boolean;
  counts: readonly BoundReactionAggregate[];
  aggregateComplete: boolean;
  availability: BoundReactionAvailability;
  sendAs: "self";
}>;
export type BoundReactionOutcome = Readonly<{
  state: "unchanged" | "set" | "replaced" | "removed";
  before: BoundReactionReadback;
  after: BoundReactionReadback;
}>;

export class BoundReactionTelegramError extends Error {
  constructor(readonly code: "config" | "state" | "primary" | "permission" | "target" | "protocol" | "transport" | "aborted", readonly unknown: boolean) {
    super("BOUND_REACTION_" + code.toUpperCase());
  }
}

const absent = (value: unknown): boolean => value === undefined || value === null;
const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < 2147483647;
const long = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) < 2n ** 63n;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= STANDING_INCOMING_TEXT_BYTES &&
  !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value;
const emoji = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 64 &&
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) && Buffer.from(value, "utf8").toString("utf8") === value;
const samePeer = (value: unknown, expected: string): boolean => { try { return utils.getPeerId(value as Api.TypePeer) === expected; } catch { return false; } };

function discard(value: unknown): void {
  if (value instanceof Api.messages.ChatFull) { value.chats.length = 0; value.users.length = 0; }
  if (value instanceof Api.messages.AvailableReactions) value.reactions.length = 0;
  if (value instanceof Api.messages.Messages || value instanceof Api.messages.MessagesSlice || value instanceof Api.messages.ChannelMessages) {
    value.messages.length = 0; value.chats.length = 0; value.users.length = 0;
  }
  if (value instanceof Api.Updates || value instanceof Api.UpdatesCombined) { value.updates.length = 0; value.chats.length = 0; value.users.length = 0; }
}

/** A sole-client capability for ordinary emoji reactions in one frozen group.
 * The caller resolves targetMessageId from its trusted message-reference table
 * and persists mutation intent before setOnce(). No participant reaction list is
 * requested or returned. close() revokes immediately and joins actual pending I/O. */
export function createBoundReactionTelegramTransport(input: {
  client: PilotInvoker;
  binding: PilotBinding;
  peer: Api.InputPeerChat | Api.InputPeerChannel;
  self: Api.User;
  selected: PilotPrimary;
  targetMessageId: number;
  signal: AbortSignal;
  isSelectionActive(): boolean;
  revalidatePrimary(signal: AbortSignal): Promise<PilotPrimary>;
}) {
  const fail = (code: BoundReactionTelegramError["code"], unknown = uncertain): never => { throw new BoundReactionTelegramError(code, unknown); };
  let uncertain = false;
  if (types.isProxy(input.binding) || types.isProxy(input.selected)) return fail("config", false);
  const binding = Object.freeze({ ...input.binding }), selected = Object.freeze({ ...input.selected });
  const targetMessageId = input.targetMessageId;
  if (!long(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId) || !int(targetMessageId) ||
      !(input.self instanceof Api.User) || !input.self.self || input.self.bot || input.self.deleted || input.self.id.toString() !== binding.accountId ||
      selected.chatId !== binding.peerId || !long(selected.ownerId) || selected.ownerId === binding.accountId || !int(selected.messageId) || !text(selected.text) ||
      !(input.peer instanceof Api.InputPeerChat || input.peer instanceof Api.InputPeerChannel) || !samePeer(input.peer, binding.peerId)) return fail("config", false);
  let peer: Api.InputPeerChat | Api.InputPeerChannel;
  try {
    peer = input.peer instanceof Api.InputPeerChat ? new Api.InputPeerChat({ chatId: bigInt(input.peer.chatId.toString()) }) :
      new Api.InputPeerChannel({ channelId: bigInt(input.peer.channelId.toString()), accessHash: bigInt(input.peer.accessHash.toString()) });
  } catch { return fail("config", false); }
  if (peer instanceof Api.InputPeerChannel && (peer.accessHash.isZero() || peer.accessHash.lesser((-(2n ** 63n)).toString()) || peer.accessHash.greaterOrEquals((2n ** 63n).toString()))) return fail("config", false);
  const channel = peer instanceof Api.InputPeerChannel;
  const groupId = (peer instanceof Api.InputPeerChannel ? peer.channelId : peer.chatId).toString();
  const inputChannel = () => {
    if (!(peer instanceof Api.InputPeerChannel)) return fail("config", false);
    return new Api.InputChannel({ channelId: bigInt(peer.channelId.toString()), accessHash: bigInt(peer.accessHash.toString()) });
  };
  const selfPremium = input.self.premium === true;
  const invoke = input.client.invoke.bind(input.client), active = input.isSelectionActive.bind(input), fresh = input.revalidatePrimary.bind(input), signal = input.signal;
  let closed = false, consumed = false, pending: Promise<unknown> | undefined;
  const revoke = () => { closed = true; };
  signal.addEventListener("abort", revoke, { once: true });
  function check(): void {
    let ok = false; try { ok = active() === true; } catch { /* fixed refusal */ }
    if (closed || signal.aborted || !ok) return fail("aborted");
  }
  async function request<T>(request: Api.AnyRequest, parse: (value: unknown) => T): Promise<T> {
    check(); let envelope: unknown;
    try { envelope = await invoke(request); check(); return parse(envelope); }
    catch (error) {
      optionalDiscard(error);
      if (error instanceof BoundReactionTelegramError) throw error;
      const message = (error as { errorMessage?: unknown })?.errorMessage;
      if (!uncertain && typeof message === "string" && ["CHAT_REACTIONS_DISABLED", "REACTION_INVALID", "CHAT_ADMIN_REQUIRED", "USER_BANNED_IN_CHANNEL", "CHANNEL_PRIVATE"].includes(message)) return fail("permission", false);
      if (!uncertain && message === "MESSAGE_ID_INVALID") return fail("target", false);
      return fail("transport");
    } finally { discard(envelope); }
  }
  function optionalDiscard(_value: unknown): void { /* Do not inspect arbitrary error payloads beyond errorMessage. */ }
  async function revalidate(): Promise<void> {
    check(); const value = await fresh(signal); check();
    if (value.chatId !== selected.chatId || value.ownerId !== selected.ownerId || value.messageId !== selected.messageId || value.text !== selected.text) return fail("primary");
  }
  function run<T>(work: () => Promise<T>): Promise<T> {
    try { check(); if (pending) return Promise.reject(new BoundReactionTelegramError("state", uncertain)); }
    catch (error) { return Promise.reject(error); }
    const task = Promise.resolve().then(work).catch(error => {
      if (error instanceof BoundReactionTelegramError) throw error;
      return fail("transport");
    });
    pending = task;
    void task.then(() => { pending = undefined; }, () => { pending = undefined; });
    return task;
  }
  const inputMessage = () => new Api.InputMessageID({ id: targetMessageId });
  async function permission(): Promise<BoundReactionAvailability> {
    const value = await request(channel ? new Api.channels.GetFullChannel({ channel: inputChannel() }) : new Api.messages.GetFullChat({ chatId: bigInt(groupId) }), envelope => {
      if (!(envelope instanceof Api.messages.ChatFull) || envelope.chats.length > 100 || envelope.users.length > 400) return fail("protocol");
      const full = envelope.fullChat;
      if ((channel ? !(full instanceof Api.ChannelFull) : !(full instanceof Api.ChatFull)) || full.id.toString() !== groupId) return fail("protocol");
      const matches = envelope.chats.filter(chat => (channel ? chat instanceof Api.Channel : chat instanceof Api.Chat) && chat.id.toString() === groupId);
      if (matches.length !== 1) return fail("protocol");
      const chat = matches[0]!;
      if (!(chat instanceof Api.Chat || chat instanceof Api.Channel) || chat.left || chat instanceof Api.Chat && (chat.deactivated || chat.migratedTo) ||
          chat instanceof Api.Channel && (chat.min || chat.broadcast || !(chat.megagroup || chat.gigagroup))) return fail("permission");
      if (chat instanceof Api.Channel && !absent(chat.bannedRights) && (!(chat.bannedRights instanceof Api.ChatBannedRights) || chat.bannedRights.viewMessages)) return fail("permission");
      if (full instanceof Api.ChannelFull && !absent(full.defaultSendAs) && !samePeer(full.defaultSendAs, binding.accountId)) return fail("permission");
      return full.availableReactions;
    });
    if (absent(value) || value instanceof Api.ChatReactionsNone) return Object.freeze({ mode: "none", emoji: Object.freeze([]) });
    if (value instanceof Api.ChatReactionsSome) {
      if (value.reactions.length > 200) return fail("protocol");
      const list: string[] = [], seen = new Set<string>();
      for (const reaction of value.reactions) {
        if (!(reaction instanceof Api.ReactionEmoji)) continue;
        if (!emoji(reaction.emoticon) || seen.has(reaction.emoticon)) return fail("protocol");
        seen.add(reaction.emoticon); list.push(reaction.emoticon);
      }
      return Object.freeze({ mode: "some", emoji: Object.freeze(list) });
    }
    if (!(value instanceof Api.ChatReactionsAll)) return fail("protocol");
    return request(new Api.messages.GetAvailableReactions({ hash: 0 }), envelope => {
      if (!(envelope instanceof Api.messages.AvailableReactions) || envelope.reactions.length > 200) return fail("protocol");
      const list: string[] = [], seen = new Set<string>();
      for (const reaction of envelope.reactions) {
        if (!(reaction instanceof Api.AvailableReaction) || !absent(reaction.inactive) && typeof reaction.inactive !== "boolean" ||
            !absent(reaction.premium) && typeof reaction.premium !== "boolean") return fail("protocol");
        if (reaction.inactive || reaction.premium && !selfPremium || !emoji(reaction.reaction) || seen.has(reaction.reaction)) continue;
        seen.add(reaction.reaction); list.push(reaction.reaction);
      }
      return Object.freeze({ mode: "all", emoji: Object.freeze(list) });
    });
  }
  function reactions(value: Api.TypeMessageReactions | null | undefined): Pick<BoundReactionReadback, "ownEmojis" | "ownStateComplete" | "unsupportedOwnReaction" | "counts" | "aggregateComplete"> {
    if (absent(value)) return { ownEmojis: Object.freeze([]), ownStateComplete: true, unsupportedOwnReaction: false, counts: Object.freeze([]), aggregateComplete: true };
    if (!(value instanceof Api.MessageReactions) || value.results.length > 200 || !absent(value.recentReactions) && value.recentReactions!.length > 200 ||
        !absent(value.topReactors) && value.topReactors!.length > 200) return fail("protocol");
    const own: string[] = [], counts: BoundReactionAggregate[] = [], seen = new Set<string>(), orders = new Set<number>();
    let unsupportedOwnReaction = false, omittedAggregate = false;
    for (const result of value.results) {
      if (!(result instanceof Api.ReactionCount) || !Number.isSafeInteger(result.count) || result.count <= 0 || result.count > 2147483647 ||
          !absent(result.chosenOrder) && (!Number.isSafeInteger(result.chosenOrder) || result.chosenOrder! < 0 || orders.has(result.chosenOrder!))) return fail("protocol");
      const explicitlyChosen = !absent(result.chosenOrder);
      if (explicitlyChosen) orders.add(result.chosenOrder!);
      const chosen = explicitlyChosen ? true : value.min ? null : false;
      if (!(result.reaction instanceof Api.ReactionEmoji)) { omittedAggregate = true; if (chosen) unsupportedOwnReaction = true; continue; }
      const emoticon = result.reaction.emoticon;
      if (!emoji(emoticon) || seen.has(emoticon)) return fail("protocol");
      seen.add(emoticon); if (chosen === true) own.push(emoticon);
      counts.push(Object.freeze({ emoji: emoticon, count: result.count, chosen, externalCount: chosen === null ? null : result.count - (chosen ? 1 : 0) }));
    }
    return { ownEmojis: Object.freeze(own), ownStateComplete: !value.min, unsupportedOwnReaction, counts: Object.freeze(counts), aggregateComplete: !value.min && !omittedAggregate };
  }
  async function read(availability: BoundReactionAvailability): Promise<BoundReactionReadback> {
    const value = await request(channel ? new Api.channels.GetMessages({ channel: inputChannel(), id: [inputMessage()] }) : new Api.messages.GetMessages({ id: [inputMessage()] }), envelope => {
      if (!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) ||
          envelope.messages.length !== 1 || envelope.chats.length > 100 || envelope.users.length > 400) return fail("protocol");
      const message = envelope.messages[0];
      if (message instanceof Api.MessageEmpty && message.id === targetMessageId && (absent(message.peerId) || samePeer(message.peerId, binding.peerId))) return fail("target");
      if (!(message instanceof Api.Message) || message.id !== targetMessageId || !samePeer(message.peerId, binding.peerId)) return fail("target");
      return reactions(message.reactions);
    });
    return Object.freeze({ targetMessageId, ...value, availability, sendAs: "self" as const });
  }
  async function inspectExact(): Promise<BoundReactionReadback> { await revalidate(); return read(await permission()); }
  function assertAck(value: unknown, desired: string | null): void {
    if (!(value instanceof Api.Updates || value instanceof Api.UpdatesCombined) || value.updates.length > 100 || value.chats.length > 100 || value.users.length > 100) return fail("protocol", true);
    const found = value.updates.filter(update => update instanceof Api.UpdateMessageReactions);
    if (found.length !== 1) return fail("protocol", true);
    const update = found[0] as Api.UpdateMessageReactions;
    if (update.msgId !== targetMessageId || !samePeer(update.peer, binding.peerId)) return fail("protocol", true);
    const state = reactions(update.reactions);
    if (!state.ownStateComplete || state.unsupportedOwnReaction || (desired === null ? state.ownEmojis.length !== 0 : state.ownEmojis.length !== 1 || state.ownEmojis[0] !== desired)) return fail("protocol", true);
  }
  return Object.freeze({
    inspect: () => run(inspectExact),
    setOnce: (choice: string | null): Promise<BoundReactionOutcome> => {
      if (choice !== null && !emoji(choice)) return Promise.reject(new BoundReactionTelegramError("config", false));
      const desired = choice;
      return run(async () => {
        if (consumed) return fail("state"); consumed = true;
        const before = await inspectExact();
        if (!before.ownStateComplete || before.unsupportedOwnReaction) return fail("state", false);
        const same = desired === null ? before.ownEmojis.length === 0 : before.ownEmojis.length === 1 && before.ownEmojis[0] === desired;
        if (same) return Object.freeze({ state: "unchanged" as const, before, after: before });
        if (desired !== null && !before.availability.emoji.includes(desired)) return fail("permission", false);
        await revalidate(); check(); uncertain = true;
        await request(new Api.messages.SendReaction({ peer, msgId: targetMessageId, reaction: desired === null ? [] : [new Api.ReactionEmoji({ emoticon: desired })],
          big: false, addToRecent: false }), value => assertAck(value, desired));
        const after = await read(await permission());
        if (!after.ownStateComplete || after.unsupportedOwnReaction || (desired === null ? after.ownEmojis.length !== 0 : after.ownEmojis.length !== 1 || after.ownEmojis[0] !== desired)) return fail("protocol", true);
        uncertain = false;
        return Object.freeze({ state: desired === null ? "removed" as const : before.ownEmojis.length === 0 ? "set" as const : "replaced" as const, before, after });
      });
    },
    async close(): Promise<void> { revoke(); signal.removeEventListener("abort", revoke); try { await pending; } catch { /* settlement only */ } },
  });
}
