import { createHash, randomBytes } from "node:crypto";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotBinding, PilotInvoker, PilotPrimary } from "./pilot-telegram-adapter.js";
import { GeneratedImageTransportError, type ImageDeliveryDiagnostics, type GeneratedImageMediaTransport, type ImageMediaAcknowledgement, type ImageMediaReadback } from "./generated-image-outbox.js";

const fail = (): never => { throw new Error("GENERATED_IMAGE_TELEGRAM_REFUSED_OR_UNKNOWN"); };
const id = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= 2147483647;
const long = (n: unknown): n is string => typeof n === "string" && /^[1-9]\d{0,18}$/.test(n) && BigInt(n) < 2n ** 63n;
const samePeer = (peer: unknown, expected: string): boolean => { try { return utils.getPeerId(peer as Api.TypePeer) === expected; } catch { return false; } };
const captionValid = (s: unknown): s is string => typeof s === "string" && Buffer.byteLength(s, "utf8") <= 1024 && !s.includes("\0") && Buffer.from(s, "utf8").toString("utf8") === s;
// Installed GramJS fromReader decodes absent optional non-boolean fields as
// null; direct constructors leave them undefined. A present TTL, including 0,
// remains outside this ordinary-photo transport.
const absent = (value: unknown): value is null | undefined => value === null || value === undefined;
function photoId(media: unknown): string {
  if (!(media instanceof Api.MessageMediaPhoto) || !(media.photo instanceof Api.Photo) || !absent(media.ttlSeconds) ||
      media.spoiler || !long(media.photo.id?.toString()) || (media.photo.videoSizes?.length ?? 0) !== 0) return fail();
  return media.photo.id.toString();
}
function discard(envelope: unknown): void {
  if (envelope instanceof Api.Updates || envelope instanceof Api.UpdatesCombined) {
    envelope.updates.length = 0; envelope.chats.length = 0; envelope.users.length = 0;
  } else if (envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) {
    envelope.messages.length = 0; envelope.chats.length = 0; envelope.users.length = 0;
  }
}

/** Construct only inside the sole standing adapter's active selected-request
 * callback, after peer resolution and authentication. This owns no client,
 * connection, retry, deadline, scheduler or background work. The owner must
 * disable GramJS retries/DC switching and join every returned promise before
 * closing/reusing that client. Abort prevents new invocations; it is not proof
 * that an already invoked upload/send stopped. The upstream registry validates
 * the entire PNG; this boundary additionally checks size/signature and owns a
 * defensive copy until all admitted invocations using it have settled.
 * Telegram reencodes photos: delivery proves exact photo identity, not bytes.
 */
export function createGeneratedImageTelegramTransport(input: {
  client: PilotInvoker; binding: PilotBinding; peer: Api.InputPeerChat | Api.InputPeerChannel;
  self: Api.User; selected: PilotPrimary; signal: AbortSignal;
  isSelectionActive(): boolean;
  /** Uses the existing adapter's exact primary + reply-anchor proof. No new client. */
  revalidatePrimary(signal: AbortSignal): Promise<PilotPrimary>;
}): GeneratedImageMediaTransport {
  const binding = Object.freeze({ ...input.binding }), selected = Object.freeze({ ...input.selected });
  if (!long(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId) || !(input.self instanceof Api.User) ||
      !input.self.self || input.self.bot || input.self.deleted || input.self.id.toString() !== binding.accountId ||
      !(input.peer instanceof Api.InputPeerChat || input.peer instanceof Api.InputPeerChannel) || !samePeer(input.peer, binding.peerId) ||
      selected.chatId !== binding.peerId || !id(selected.messageId) || !long(selected.ownerId) || selected.ownerId === binding.accountId ||
      typeof selected.text !== "string" || Buffer.byteLength(selected.text, "utf8") > 4096) return fail();
  // Copy the resolved peer so caller mutation cannot retarget an admitted upload.
  const peer = input.peer instanceof Api.InputPeerChat ? new Api.InputPeerChat({ chatId: bigInt(input.peer.chatId.toString()) }) :
    new Api.InputPeerChannel({ channelId: bigInt(input.peer.channelId.toString()), accessHash: bigInt(input.peer.accessHash.toString()) });
  if (peer instanceof Api.InputPeerChannel && (peer.accessHash.isZero() || peer.accessHash.lesser((-(2n ** 63n)).toString()) || peer.accessHash.greaterOrEquals((2n ** 63n).toString()))) return fail();
  const invoke = input.client.invoke.bind(input.client);
  let closed = false, sendConsumed = false, readConsumed = false;
  let acknowledgement: ImageMediaAcknowledgement | undefined, expectedCaption: string | undefined;
  let stage: ImageDeliveryDiagnostics["originalStage"] = "admission", firstFailure: GeneratedImageTransportError | undefined;
  function refuse(reason: ImageDeliveryDiagnostics["reason"]): never {
    firstFailure ??= new GeneratedImageTransportError({ originalStage: stage, reason }); throw firstFailure;
  }
  function check(signal: AbortSignal): void {
    let active = false; try { active = input.isSelectionActive() === true; } catch { /* Refuse. */ }
    if (input.signal.aborted || signal.aborted) return refuse("stopped");
    if (closed || !active) return refuse("selection");
  }
  async function request<T>(value: Api.AnyRequest, signal: AbortSignal, parse: (envelope: unknown) => T, parseStage: ImageDeliveryDiagnostics["originalStage"] = stage): Promise<T> {
    check(signal); let envelope: unknown;
    try {
      try { envelope = await invoke(value); } catch { return refuse(input.signal.aborted || signal.aborted ? "stopped" : "invoke"); }
      check(signal); stage = parseStage;
      try { return parse(envelope); } catch { return refuse("proof"); }
    }
    catch { closed = true; return refuse("unexpected"); }
    finally { discard(envelope); }
  }
  async function revalidate(signal: AbortSignal): Promise<void> {
    check(signal); let fresh: PilotPrimary;
    try { fresh = await input.revalidatePrimary(signal); }
    catch { return refuse(input.signal.aborted || signal.aborted ? "stopped" : "unexpected"); }
    check(signal);
    if (fresh.chatId !== selected.chatId || fresh.ownerId !== selected.ownerId || fresh.messageId !== selected.messageId || fresh.text !== selected.text) return refuse("proof");
  }
  function messageProof(message: unknown, messageId: number, caption: string): ImageMediaReadback {
    if (!(message instanceof Api.Message) || message.id !== messageId || !samePeer(message.peerId, binding.peerId) || !message.out ||
        message.post || message.fwdFrom || message.viaBotId || message.groupedId || message.replyMarkup || !absent(message.ttlPeriod) || (message.entities?.length ?? 0) !== 0 ||
        !(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== binding.accountId || message.message !== caption ||
        !(message.replyTo instanceof Api.MessageReplyHeader) || message.replyTo.replyToMsgId !== selected.messageId ||
        (message.replyTo.replyToPeerId && !samePeer(message.replyTo.replyToPeerId, binding.peerId))) return fail();
    return Object.freeze({ messageId, photoId: photoId(message.media), chatId: binding.peerId, accountId: binding.accountId,
      replyToMessageId: selected.messageId, caption });
  }
  function parseAck(envelope: unknown, randomId: string, caption: string): ImageMediaAcknowledgement {
    if (envelope instanceof Api.UpdateShortSentMessage) {
      // The direct request response has no randomId field. Its correlation is
      // the single awaited SendMedia promise; a fresh full message is required.
      if (!envelope.out || !id(envelope.id) || !absent(envelope.ttlPeriod) || (envelope.entities?.length ?? 0) !== 0) return fail();
      return Object.freeze({ messageId: envelope.id, photoId: photoId(envelope.media) });
    }
    if (!(envelope instanceof Api.Updates || envelope instanceof Api.UpdatesCombined) || envelope.updates.length > 100 ||
        envelope.chats.length > 100 || envelope.users.length > 100) return fail();
    const maps = envelope.updates.filter(u => u instanceof Api.UpdateMessageID && u.randomId?.toString() === randomId);
    if (maps.length !== 1) return fail();
    const mapped = maps[0] as Api.UpdateMessageID;
    if (!id(mapped.id) || envelope.updates.some(u => u instanceof Api.UpdateMessageID && u.id === mapped.id && u !== mapped)) return fail();
    const echoes = envelope.updates.filter(u => (u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) && u.message.id === mapped.id);
    if (echoes.length !== 1) return fail();
    const echoed = echoes[0] as Api.UpdateNewMessage | Api.UpdateNewChannelMessage;
    const proof = messageProof(echoed.message, mapped.id, caption);
    return Object.freeze({ messageId: proof.messageId, photoId: proof.photoId });
  }
  return Object.freeze<GeneratedImageMediaTransport>({
    async sendOnce(value, signal) {
      // A rejected duplicate call must not overwrite the active send's stage.
      if (sendConsumed) throw new GeneratedImageTransportError({ originalStage: "admission", reason: "consumed" });
      stage = "admission";
      check(signal);
      if (sendConsumed || value.chatId !== binding.peerId || value.replyToMessageId !== selected.messageId || !long(value.randomId) ||
          !captionValid(value.caption) || value.mimeType !== "image/png" || !Buffer.isBuffer(value.bytes) || value.bytes.length < 45 ||
          value.bytes.length > 8 * 1024 * 1024 || !value.bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new GeneratedImageTransportError({ originalStage: "admission", reason: "input" });
      sendConsumed = true;
      const bytes = Buffer.from(value.bytes), caption = value.caption, randomId = value.randomId;
      try {
        stage = "revalidate-before"; await revalidate(signal);
        const fileId = bigInt((randomBytes(8).readBigUInt64BE() % (2n ** 63n - 1n) + 1n).toString());
        const parts = Math.ceil(bytes.length / 524288), md5Checksum = createHash("md5").update(bytes).digest("hex");
        for (let part = 0; part < parts; part++) {
          stage = "upload";
          await request(new Api.upload.SaveFilePart({ fileId, filePart: part, bytes: bytes.subarray(part * 524288, Math.min(bytes.length, (part + 1) * 524288)) }), signal,
            envelope => { if (envelope !== true) return fail(); });
        }
        // Primary or reply anchor may have changed while uploading.
        stage = "revalidate-after"; await revalidate(signal);
        stage = "send-invoke";
        const ack = await request(new Api.messages.SendMedia({ peer, replyTo: new Api.InputReplyToMessage({ replyToMsgId: selected.messageId }),
          media: new Api.InputMediaUploadedPhoto({ file: new Api.InputFile({ id: fileId, parts, name: "neurobro.png", md5Checksum }) }),
          message: caption, randomId: bigInt(randomId), sendAs: new Api.InputPeerSelf(), entities: [], clearDraft: false, allowPaidFloodskip: false }), signal,
          envelope => parseAck(envelope, randomId, caption), "ack-parse");
        acknowledgement = ack; expectedCaption = caption; return ack;
      } catch { closed = true; return refuse("unexpected"); }
      finally { bytes.fill(0); }
    },
    async readExact(chatId, messageId, signal) {
      if (readConsumed) throw new GeneratedImageTransportError({ originalStage: "admission", reason: "consumed" });
      if (!acknowledgement || expectedCaption === undefined || chatId !== binding.peerId || messageId !== acknowledgement.messageId)
        throw new GeneratedImageTransportError({ originalStage: "admission", reason: "input" });
      stage = "admission";
      check(signal);
      if (readConsumed || !acknowledgement || expectedCaption === undefined || chatId !== binding.peerId || messageId !== acknowledgement.messageId) return refuse("input");
      readConsumed = true;
      try {
        const read = peer instanceof Api.InputPeerChannel ? new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }), id: [new Api.InputMessageID({ id: messageId })] }) :
          new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: messageId })] });
        stage = "read-invoke";
        return await request(read, signal, envelope => {
          if (!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) ||
              envelope.messages.length !== 1 || envelope.chats.length > 100 || envelope.users.length > 100) return fail();
          if (envelope.messages[0] instanceof Api.MessageEmpty && envelope.messages[0].id === messageId) return null;
          const proof = messageProof(envelope.messages[0], messageId, expectedCaption!);
          if (proof.photoId !== acknowledgement!.photoId) return fail();
          return proof;
        }, "readback-parse");
      } finally { closed = true; expectedCaption = undefined; }
    },
  });
}
