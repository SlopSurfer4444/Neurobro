import { createHash, randomBytes } from "node:crypto";
import { Api, utils } from "telegram";
import { types } from "node:util";
import bigInt from "big-integer";
import { validateStandingMediaProfile, mediaProfileWire, type StandingMediaWire, type StandingMediaProfile } from "./standing-media-profile.js";
import type { PilotBinding, PilotInvoker, PilotPrimary } from "./pilot-telegram-adapter.js";
export type ArtifactAudio = Readonly<{durationSeconds: number; title?: string; performer?: string}>;
export type ArtifactSendInput = Readonly<{chatId: string; replyToMessageId: number; caption: string; randomId: string; filename: string; mimeType: string; bytes: Buffer; audio?: ArtifactAudio; mediaProfile?: StandingMediaProfile}>;
export type ArtifactAcknowledgement = Readonly<{messageId: number; documentId: string}>;
export type ArtifactReadback = ArtifactAcknowledgement & Readonly<{chatId: string; accountId: string; replyToMessageId: number; caption: string; filename: string; mimeType: string; byteLength: number; audio?: ArtifactAudio; media?: StandingMediaWire}>;
export interface StandingArtifactTelegramTransport {
  sendOnce(input: ArtifactSendInput, signal: AbortSignal): Promise<ArtifactAcknowledgement>;
  readExact(chatId: string, messageId: number, signal: AbortSignal): Promise<ArtifactReadback | null>;
}
const stages = ["admission", "revalidate-before", "upload", "revalidate-after", "send-invoke", "ack-parse", "read-invoke", "readback-parse"] as const;
const reasons = ["input", "stopped", "selection", "invoke", "proof", "consumed", "unexpected"] as const;
export type ArtifactDiagnostics = Readonly<{stage: typeof stages[number]; reason: typeof reasons[number]}>;
export function validateArtifactDiagnostics(value: unknown): ArtifactDiagnostics {
  if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("ARTIFACT_DIAGNOSTICS_REFUSED");
  const ds = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== 2 || !ds.stage || !ds.reason || !("value" in ds.stage) || !("value" in ds.reason) ||
      !stages.includes(ds.stage.value) || !reasons.includes(ds.reason.value)) throw new Error("ARTIFACT_DIAGNOSTICS_REFUSED");
  return Object.freeze({stage: ds.stage.value, reason: ds.reason.value});
}
export class ArtifactTransportError extends Error {
  readonly diagnostics: ArtifactDiagnostics;
  constructor(diagnostics: ArtifactDiagnostics) { super("ARTIFACT_TELEGRAM_REFUSED_OR_UNKNOWN"); this.name = "ArtifactTransportError"; this.diagnostics = validateArtifactDiagnostics(diagnostics); Object.freeze(this); }
}


const fail = (): never => { throw new ArtifactTransportError({stage: "admission", reason: "input"}); };
const id = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= 2147483647;
const long = (n: unknown): n is string => typeof n === "string" && /^[1-9]\d{0,18}$/.test(n) && BigInt(n) < 2n ** 63n;
const samePeer = (peer: unknown, expected: string): boolean => { try { return utils.getPeerId(peer as Api.TypePeer) === expected; } catch { return false; } };
const captionValid = (s: unknown): s is string => typeof s === "string" && Buffer.byteLength(s, "utf8") <= 1024 && !s.includes("\0") && Buffer.from(s, "utf8").toString("utf8") === s;
const absent = (value: unknown): value is null | undefined => value === null || value === undefined;
const textValid = (s: unknown): s is string => typeof s === "string" && Buffer.byteLength(s, "utf8") <= 255 && !/[\x00-\x1f\x7f]/.test(s) && Buffer.from(s, "utf8").toString("utf8") === s;
const filenameValid = (s: unknown): s is string => textValid(s) && s.length > 0 && s !== "." && s !== ".." && !/[\\/:]/.test(s);
const mimeValid = (s: unknown): s is string => typeof s === "string" && s.length <= 127 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(s);
function plainSnapshot(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (required.some(k => !Object.hasOwn(descriptors, k)) || keys.some(k => typeof k !== "string" || (!required.includes(k) && !optional.includes(k)))) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) { const descriptor = descriptors[key]; if (!descriptor || !("value" in descriptor)) return fail(); result[key] = descriptor.value; }
  return result;
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
function copyArtifactBytes(value: unknown): Buffer {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Buffer.isBuffer(value)) return fail();
  const backing = bufferGetter.call(value) as ArrayBuffer, length = lengthGetter.call(value) as number;
  if (types.isSharedArrayBuffer(backing) || resizableGetter?.call(backing) || length < 1 || length > 32 * 1024 * 1024) return fail();
  return Buffer.from(new Uint8Array(backing, offsetGetter.call(value) as number, length));
}
function audioCopy(value: ArtifactAudio | undefined, mime: string): ArtifactAudio | undefined {
  if (value === undefined) return undefined;
  value = plainSnapshot(value, ["durationSeconds"], ["title", "performer"]) as ArtifactAudio;
  if (!value || mime !== "audio/mpeg" || !Number.isSafeInteger(value.durationSeconds) || value.durationSeconds < 0 || value.durationSeconds > 2147483647 ||
      (value.title !== undefined && !textValid(value.title)) || (value.performer !== undefined && !textValid(value.performer))) return fail();
  return Object.freeze({durationSeconds: value.durationSeconds, ...(value.title === undefined ? {} : {title: value.title}), ...(value.performer === undefined ? {} : {performer: value.performer})});
}
type Metadata = Readonly<{filename: string; mimeType: string; byteLength: number; audio?: ArtifactAudio; mediaProfile?: StandingMediaProfile}>;
function documentProof(media: unknown, expected: Metadata): string {
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document) || !absent(media.ttlSeconds) ||
      media.spoiler || Boolean(media.voice) !== (expected.mediaProfile?.kind === "voice") || Boolean(media.round) !== (expected.mediaProfile?.kind === "round-video") ||
      (expected.mediaProfile?.kind === "video" ? !media.video : expected.mediaProfile?.kind !== "round-video" && media.video) || !absent(media.videoCover) || !absent(media.videoTimestamp) || (media.altDocuments?.length ?? 0) !== 0) return fail();
  const doc = media.document;
  if (!long(doc.id?.toString()) || doc.mimeType !== expected.mimeType || doc.size?.toString() !== String(expected.byteLength) ||
      !Array.isArray(doc.attributes) || doc.attributes.length !== (expected.audio || expected.mediaProfile ? 2 : 1)) return fail();
  const filenames = doc.attributes.filter(a => a instanceof Api.DocumentAttributeFilename);
  if (filenames.length !== 1 || (filenames[0] as Api.DocumentAttributeFilename).fileName !== expected.filename) return fail();
  if (expected.audio) {
    const attrs = doc.attributes.filter(a => a instanceof Api.DocumentAttributeAudio);
    if (attrs.length !== 1) return fail();
    const a = attrs[0] as Api.DocumentAttributeAudio, e = expected.audio;
    if (a.voice || !absent(a.waveform) || a.duration !== e.durationSeconds || (a.title ?? undefined) !== e.title || (a.performer ?? undefined) !== e.performer) return fail();
  }
  if (expected.mediaProfile) {
    const p = expected.mediaProfile;
    if (p.kind === "voice") {
      const attrs = doc.attributes.filter(a => a instanceof Api.DocumentAttributeAudio);
      if (attrs.length !== 1) return fail();
      const a = attrs[0] as Api.DocumentAttributeAudio;
      if (!a.voice || a.duration !== Math.ceil(p.durationSeconds) || !absent(a.title) || !absent(a.performer) || !absent(a.waveform)) return fail();
    } else {
      const attrs = doc.attributes.filter(a => a instanceof Api.DocumentAttributeVideo);
      if (attrs.length !== 1) return fail();
      const a = attrs[0] as Api.DocumentAttributeVideo;
      if (Boolean(a.roundMessage) !== (p.kind === "round-video") || a.duration !== p.durationSeconds || a.w !== p.width || a.h !== p.height ||
          a.supportsStreaming || a.nosound || !absent(a.preloadPrefixSize) || !absent(a.videoStartTs) || !absent(a.videoCodec)) return fail();
    }
  }
  return doc.id.toString();
}
function discard(envelope: unknown): void {
  if (envelope instanceof Api.Updates || envelope instanceof Api.UpdatesCombined) {
    envelope.updates.length = 0; envelope.chats.length = 0; envelope.users.length = 0;
  } else if (envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) {
    envelope.messages.length = 0; envelope.chats.length = 0; envelope.users.length = 0;
  }
}

/** Uses only the existing selected-request client. Caller owns deadline and must
 * join each returned promise: abort does not settle an admitted invocation.
 * The upstream registry validates audio content; this boundary validates wire
 * metadata and holds its defensive bytes until actual invoke settlement. */
export function createStandingArtifactTelegramTransport(input: {
  client: PilotInvoker; binding: PilotBinding; peer: Api.InputPeerChat | Api.InputPeerChannel;
  self: Api.User; selected: PilotPrimary; signal: AbortSignal;
  isSelectionActive(): boolean;
  /** Uses the existing adapter's exact primary + reply-anchor proof. No new client. */
  revalidatePrimary(signal: AbortSignal): Promise<PilotPrimary>;
}): StandingArtifactTelegramTransport {
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
  let acknowledgement: ArtifactAcknowledgement | undefined, expectedCaption: string | undefined;
  let metadata: Metadata | undefined;
  let stage: ArtifactDiagnostics["stage"] = "admission", firstFailure: ArtifactTransportError | undefined;
  function refuse(reason: ArtifactDiagnostics["reason"]): never {
    firstFailure ??= new ArtifactTransportError({ stage: stage, reason }); throw firstFailure;
  }
  function check(signal: AbortSignal): void {
    let active = false; try { active = input.isSelectionActive() === true; } catch { /* Refuse. */ }
    if (input.signal.aborted || signal.aborted) return refuse("stopped");
    if (closed || !active) return refuse("selection");
  }
  async function request<T>(value: Api.AnyRequest, signal: AbortSignal, parse: (envelope: unknown) => T, parseStage: ArtifactDiagnostics["stage"] = stage): Promise<T> {
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
  function messageProof(message: unknown, messageId: number, caption: string): ArtifactReadback {
    if (!(message instanceof Api.Message) || message.id !== messageId || !samePeer(message.peerId, binding.peerId) || !message.out ||
        message.post || message.fwdFrom || message.viaBotId || message.groupedId || message.replyMarkup || !absent(message.ttlPeriod) || (message.entities?.length ?? 0) !== 0 ||
        !(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== binding.accountId || message.message !== caption ||
        !(message.replyTo instanceof Api.MessageReplyHeader) || message.replyTo.replyToMsgId !== selected.messageId ||
        (message.replyTo.replyToPeerId && !samePeer(message.replyTo.replyToPeerId, binding.peerId))) return fail();
    return Object.freeze({ messageId, documentId: documentProof(message.media, metadata!), chatId: binding.peerId, accountId: binding.accountId,
      replyToMessageId: selected.messageId, caption, filename: metadata!.filename, mimeType: metadata!.mimeType, byteLength: metadata!.byteLength, ...(metadata!.audio ? {audio: metadata!.audio} : {}), ...(metadata!.mediaProfile ? {media: mediaProfileWire(metadata!.mediaProfile)} : {}) });
  }
  function parseAck(envelope: unknown, randomId: string, caption: string): ArtifactAcknowledgement {
    if (envelope instanceof Api.UpdateShortSentMessage) {
      // The direct request response has no randomId field. Its correlation is
      // the single awaited SendMedia promise; a fresh full message is required.
      if (!envelope.out || !id(envelope.id) || !absent(envelope.ttlPeriod) || (envelope.entities?.length ?? 0) !== 0) return fail();
      return Object.freeze({ messageId: envelope.id, documentId: documentProof(envelope.media, metadata!) });
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
    return Object.freeze({ messageId: proof.messageId, documentId: proof.documentId });
  }
  return Object.freeze<StandingArtifactTelegramTransport>({
    async sendOnce(untrusted, signal) {
      // A rejected duplicate call must not overwrite the active send's stage.
      if (sendConsumed) throw new ArtifactTransportError({ stage: "admission", reason: "consumed" });
      sendConsumed = true;
      let value: ArtifactSendInput;
      try { value = plainSnapshot(untrusted, ["chatId", "replyToMessageId", "caption", "randomId", "filename", "mimeType", "bytes"], ["audio", "mediaProfile"]) as ArtifactSendInput; }
      catch { throw new ArtifactTransportError({stage: "admission", reason: "input"}); }
      stage = "admission";
      check(signal);
      if ( value.chatId !== binding.peerId || value.replyToMessageId !== selected.messageId || !long(value.randomId) ||
          !captionValid(value.caption) || !mimeValid(value.mimeType) || !filenameValid(value.filename)) throw new ArtifactTransportError({ stage: "admission", reason: "input" });
      let bytes: Buffer;
      try { bytes = copyArtifactBytes(value.bytes); } catch { throw new ArtifactTransportError({stage: "admission", reason: "input"}); }
      try {
      let audio: ArtifactAudio | undefined;
      try { audio = audioCopy(value.audio, value.mimeType); } catch { throw new ArtifactTransportError({stage: "admission", reason: "input"}); }
      let mediaProfile: StandingMediaProfile | undefined;
      try {
        if (value.mediaProfile !== undefined) { if (audio) return fail(); mediaProfile = validateStandingMediaProfile(value.mediaProfile, bytes, value.mimeType); if (mediaProfile.kind === "round-video" && value.caption !== "") return fail(); }
      } catch { throw new ArtifactTransportError({stage: "admission", reason: "input"}); }
      metadata = Object.freeze({filename: value.filename, mimeType: value.mimeType, byteLength: bytes.length, ...(audio ? {audio} : {}), ...(mediaProfile ? {mediaProfile} : {})});
      const caption = value.caption, randomId = value.randomId;
        stage = "revalidate-before"; await revalidate(signal);
        const fileId = bigInt((randomBytes(8).readBigUInt64BE() % (2n ** 63n - 1n) + 1n).toString());
        const parts = Math.ceil(bytes.length / 524288), big = bytes.length > 10 * 1024 * 1024;
        const md5Checksum = big ? "" : createHash("md5").update(bytes).digest("hex");
        for (let part = 0; part < parts; part++) {
          stage = "upload";
          await request(big ? new Api.upload.SaveBigFilePart({ fileId, filePart: part, fileTotalParts: parts, bytes: bytes.subarray(part * 524288, Math.min(bytes.length, (part + 1) * 524288)) }) : new Api.upload.SaveFilePart({ fileId, filePart: part, bytes: bytes.subarray(part * 524288, Math.min(bytes.length, (part + 1) * 524288)) }), signal,
            envelope => { if (envelope !== true) return fail(); });
        }
        // Primary or reply anchor may have changed while uploading.
        stage = "revalidate-after"; await revalidate(signal);
        stage = "send-invoke";
        const ack = await request(new Api.messages.SendMedia({ peer, replyTo: new Api.InputReplyToMessage({ replyToMsgId: selected.messageId }),
          media: new Api.InputMediaUploadedDocument({
            file: big ? new Api.InputFileBig({id: fileId, parts, name: metadata.filename}) : new Api.InputFile({id: fileId, parts, name: metadata.filename, md5Checksum}),
            mimeType: metadata.mimeType, forceFile: !audio && !mediaProfile,
            attributes: [new Api.DocumentAttributeFilename({fileName: metadata.filename}), ...(audio ? [new Api.DocumentAttributeAudio({duration: audio.durationSeconds, ...(audio.title === undefined ? {} : {title: audio.title}), ...(audio.performer === undefined ? {} : {performer: audio.performer})})] : []), ...(mediaProfile ? [mediaProfile.kind === "voice" ? new Api.DocumentAttributeAudio({voice: true, duration: Math.ceil(mediaProfile.durationSeconds)}) : new Api.DocumentAttributeVideo({duration: mediaProfile.durationSeconds, w: mediaProfile.width!, h: mediaProfile.height!, roundMessage: mediaProfile.kind === "round-video", supportsStreaming: false})] : [])] }),
          message: caption, randomId: bigInt(randomId), sendAs: new Api.InputPeerSelf(), entities: [], clearDraft: false, allowPaidFloodskip: false }), signal,
          envelope => parseAck(envelope, randomId, caption), "ack-parse");
        acknowledgement = ack; expectedCaption = caption; return ack;
      } catch { closed = true; return refuse(stage === "admission" ? "input" : "unexpected"); }
      finally { bytes.fill(0); }
    },
    async readExact(chatId, messageId, signal) {
      if (readConsumed) throw new ArtifactTransportError({ stage: "admission", reason: "consumed" });
      if (!acknowledgement || expectedCaption === undefined || chatId !== binding.peerId || messageId !== acknowledgement.messageId)
        throw new ArtifactTransportError({ stage: "admission", reason: "input" });
      readConsumed = true;
      stage = "admission";
      check(signal);
      if ( !acknowledgement || expectedCaption === undefined || chatId !== binding.peerId || messageId !== acknowledgement.messageId) return refuse("input");
      try {
        const read = peer instanceof Api.InputPeerChannel ? new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }), id: [new Api.InputMessageID({ id: messageId })] }) :
          new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: messageId })] });
        stage = "read-invoke";
        return await request(read, signal, envelope => {
          if (!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) ||
              envelope.messages.length !== 1 || envelope.chats.length > 100 || envelope.users.length > 100) return fail();
          if (envelope.messages[0] instanceof Api.MessageEmpty && envelope.messages[0].id === messageId) return null;
          const proof = messageProof(envelope.messages[0], messageId, expectedCaption!);
          if (proof.documentId !== acknowledgement!.documentId) return fail();
          return proof;
        }, "readback-parse");
      } finally { closed = true; expectedCaption = undefined; }
    },
  });
}
