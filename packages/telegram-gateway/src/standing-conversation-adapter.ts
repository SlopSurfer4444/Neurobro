import { createHash } from "node:crypto";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { inputImageIdentity, downloadStandingInputImage, type StandingMediaFileReader } from "./standing-input-image.js";
import { PilotPreDispatchError, type PilotReadback, type PilotSend, type PilotTransport } from "./pilot-outbox.js";
import { resolvePilotPeer, extractPilotSentId, type PilotBinding, type PilotInvoker, type PilotPrimary } from "./pilot-telegram-adapter.js";
import { STANDING_CONTEXT_CHAIN_LIMIT, STANDING_CONTEXT_WINDOW_LIMIT, type StandingContext, type StandingContextMessage, type StandingContextStatus } from "./standing-context.js";
import { createGeneratedImageTelegramTransport } from "./generated-image-telegram.js";
import { GeneratedImageTransportError, type GeneratedImageMediaTransport } from "./generated-image-outbox.js";
import type { ConversationReferences } from "./conversation-references.js";
import { createSelfHistoryReader, SelfHistoryReaderError, snapshotSelfHistoryTaskCheckpoint, type SelfHistoryTaskCheckpoint, type SelfHistoryTaskPage } from "./self-history-reader.js";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";
import { createSelfHistoryTool } from "./self-history-tool.js";
import { createBoundGroupReader, BoundGroupReaderError } from "./bound-group-reader.js";
import { createBoundGroupTools } from "./bound-group-tools.js";
import { createBoundActionTransportLease } from "./bound-action-transport.js";
import type { StandingSelfProfileImage } from "./standing-self-profile.js";
import type { BoundActionLease } from "./standing-bound-action-runtime.js";
import { projectStandingMediaContext, projectStandingOwnMediaContext } from "./standing-media-context.js";
import type { EpochExtraTool, EpochToolResult } from "./standing-tool-dispatcher.js";
import { createStandingArtifactTelegramTransport, ArtifactTransportError, type StandingArtifactTelegramTransport } from "./standing-artifact-telegram.js";
import { types } from "node:util";
import { copyTelegramTextEntities, toTelegramEntities, fromTelegramEntities, type TelegramTextEntity } from "./telegram-text-format.js";

export type StandingSelfHistory = ReturnType<typeof createSelfHistoryTool>;

export type StandingAdapterErrorCode = "transport" | "binding" | "protocol" | "backlog" | "checkpoint" | "aborted";
export class StandingAdapterError extends Error {
  constructor(readonly code: StandingAdapterErrorCode) { super("STANDING_TELEGRAM_" + code.toUpperCase()); }
}
const fail = (code: StandingAdapterErrorCode = "protocol"): never => { throw new StandingAdapterError(code); };
function invokeFailure(error: unknown): StandingAdapterErrorCode {
  try {
    if (typeof error !== "object" || error === null) return "protocol";
    const value = error as { code?: unknown; errorMessage?: unknown; message?: unknown };
    if (typeof value.errorMessage === "string" || typeof value.code === "number") return "protocol";
    if (value.code === "transport" && value.message === "STANDING_TRANSPORT") return "transport";
    if (typeof value.code === "string" && ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"].includes(value.code)) return "transport";
    if (value.message === "TIMEOUT") return "transport";
  } catch { /* Untrusted adapter errors never escape or stringify. */ }
  return "protocol";
}
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
    (!message.media || message.media instanceof Api.MessageMediaEmpty || message.media instanceof Api.MessageMediaWebPage);
}
function incomingShape(message: Api.Message): boolean {
  return textOnly(message) || (inputImageIdentity(message) !== undefined &&
    typeof message.message === "string" && Buffer.byteLength(message.message,"utf8") <= 1024 &&
    !message.message.includes("\0") && Buffer.from(message.message,"utf8").toString("utf8") === message.message &&
    !message.fwdFrom && !message.viaBotId && !message.replyMarkup);
}
function primaryText(message: Api.Message): string {
  return (message.message.trim() ? message.message : "[Фото пользователя]") + (message.groupedId ? "\n[Элемент альбома; содержимое доступно только в приложенных изображениях, весь состав не подтверждён]" : "");
}
/** Same plain photo shape accepted by generated-image-telegram readback. This
 * proves an own photo identity and caption, never pixel contents or generation. */
function selfPhotoId(message: Api.Message, binding: PilotBinding): string | undefined {
  if (!validId(message.id) || !samePeer(message.peerId, binding.peerId) || !(message.fromId instanceof Api.PeerUser) ||
      message.fromId.userId.toString() !== binding.accountId || !message.out || message.post ||
      !Number.isSafeInteger(message.date) || message.date <= 0 || message.fwdFrom || message.viaBotId || message.groupedId || message.replyMarkup ||
      (message.ttlPeriod !== undefined && message.ttlPeriod !== null) || (message.entities?.length ?? 0) !== 0 ||
      typeof message.message !== "string" || Buffer.byteLength(message.message,"utf8") > 1024 || message.message.includes("\0") ||
      Buffer.from(message.message,"utf8").toString("utf8") !== message.message ||
      !(message.media instanceof Api.MessageMediaPhoto) || !(message.media.photo instanceof Api.Photo) ||
      (message.media.ttlSeconds !== undefined && message.media.ttlSeconds !== null) || message.media.spoiler || (message.media.photo.videoSizes?.length ?? 0) !== 0) return;
  const id = message.media.photo.id?.toString();
  if (typeof id !== "string" || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) >= 2n ** 63n) return;
  return id;
}
const PHOTO_CONTEXT_MARKER = "[Фото]";
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
type Candidate = Readonly<{ id: number; ownerId: string; date: number; proof: string; trigger: "prompt" | "mention" | "reply" | "ordinary"; replyId?: number; unthreaded?: true; albumKey?:string; albumCaption?:true; albumContinuation?:true }>;
type ContinuationAnchor = Readonly<{ message: StandingContextMessage; proof: string }>;
type AnchorIdentity = Readonly<{ ownerId: string; date: number }>;
export type StandingSelection = Readonly<{ primary: PilotPrimary; transport: PilotTransport; cursor: number; pulseTyping?: () => Promise<void>; context?: StandingContext;
  readInputImages?(): Promise<Readonly<{images: readonly Readonly<{messageId:number; mimeType:"image/jpeg"|"image/png"; bytes:Buffer}>[]; sources?:readonly StandingContextMessage[]; unavailable?:true}>>;
  /** The primary is an observed human anchor, not an addressed request. */
  initiative?: true; finishInitiative?(): Promise<void>;
  /** Next unthreaded human contribution after fresh own output. Intent remains
   * for the model to assess; silence is allowed without disabling this route. */
  continuation?: true;
  /** Host-only identity lookup; never proves that arbitrary own photos were generated.
   * Missing/ineligible anchor returns undefined; terminal adapter failure rejects. */
  readOwnPhotoAnchor?(): Promise<Readonly<{ messageId: number; photoId: string; replyToMessageId: number }> | undefined>;
  /** Default absent. Shares one send admission with text, including upload. */
  imageTransport?: GeneratedImageMediaTransport;
  /** Source-owned operation lease during this model turn; close joins real I/O
   * before history, another artifact, or the final reply can proceed. */
  openArtifactTransport?(): StandingArtifactTransportLease;
  openActions?(resolveAvatar?: (artifactRef: string) => StandingSelfProfileImage): BoundActionLease }>;
export type StandingArtifactTransportLease = Readonly<{ transport: StandingArtifactTelegramTransport; close(): Promise<void> }>;
export type StandingIdleHistoryLease = Readonly<{ readTaskPage(): Promise<SelfHistoryTaskPage>; close(): Promise<void> }>;
export type StandingTaskReplyLease = Readonly<{ transport: PilotTransport; close(): Promise<void> }>;
export type StandingIdleHistoryTicket = Readonly<{
  openHistoryTask(input: Readonly<{ intent: StandingHistoryTaskIntent; checkpoint?: SelfHistoryTaskCheckpoint; signal: AbortSignal }>): StandingIdleHistoryLease;
  /** Host admits the authenticated task's final reply separately from analysis
   * readiness. This consumes the same ticket and never selects a foreground turn. */
  openTaskReply(input: Readonly<{ intent: StandingHistoryTaskIntent; signal: AbortSignal }>): StandingTaskReplyLease;
}>;
export type StandingPollNext = Readonly<{ kind: "selected"; selection: StandingSelection } | { kind: "more" } | { kind: "idle"; ticket: StandingIdleHistoryTicket }>;
export type StandingPollWork = StandingPollNext | Readonly<{ kind: "background"; ticket: StandingIdleHistoryTicket }>;
const validCursor = (value: unknown): value is number => value === 0 || validId(value);
const overload = (): never => fail("backlog");
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
function batchOf(envelope: unknown, limit: number): Batch {
  if (!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages) ||
      envelope.messages.length > limit || envelope.users.length > 200 || envelope.chats.length > 100) return fail();
  return envelope;
}
function mention(message: Api.Message, accountId: string, usernames: ReadonlySet<string>): boolean {
  if ((message.entities?.length ?? 0) > 100) return false;
  return (message.entities ?? []).some(entity => {
    if (!(entity instanceof Api.MessageEntityMention || entity instanceof Api.MessageEntityMentionName) ||
        !Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length) || entity.offset < 0 || entity.length < 1 ||
        entity.offset + entity.length > message.message.length) return false;
    if (entity instanceof Api.MessageEntityMentionName) return entity.userId.toString() === accountId;
    const token = message.message.slice(entity.offset, entity.offset + entity.length);
    const before = message.message[entity.offset - 1] ?? "";
    const after = message.message[entity.offset + entity.length] ?? "";
    return token.startsWith("@") && usernames.has(token.slice(1).toLowerCase()) &&
      !/[A-Za-z0-9_@]/.test(before) && !/[A-Za-z0-9_]/.test(after);
  });
}
function project(message: Api.TypeMessage | undefined, users: Api.TypeUser[], binding: PilotBinding, usernames: ReadonlySet<string>, ordinary = false): Candidate | undefined {
  if (!(message instanceof Api.Message) || !validId(message.id) || !samePeer(message.peerId, binding.peerId) ||
      !(message.fromId instanceof Api.PeerUser) || message.out || message.post || !incomingShape(message) ||
      !Number.isSafeInteger(message.date) || message.date <= 0) return;
  const ownerId = message.fromId.userId.toString();
  if (!validUser(ownerId) || ownerId === binding.accountId) return;
  // Require actual human author metadata; unknown/duplicate authors are not model input.
  const authors = users.filter(user => user.id.toString() === ownerId);
  if (authors.length !== 1 || !(authors[0] instanceof Api.User) || authors[0].bot || authors[0].deleted || authors[0].self) return;
  let trigger: Candidate["trigger"];
  let replyId: number | undefined;
  if (/^ПРОМПТ(?:\s|:|,|$)/u.test(message.message)) trigger = "prompt";
  else if (mention(message, binding.accountId, usernames)) trigger = "mention";
  else if (message.replyTo instanceof Api.MessageReplyHeader && !message.replyTo.replyToScheduled &&
      validId(message.replyTo.replyToMsgId) && message.replyTo.replyToMsgId < message.id &&
      (!message.replyTo.replyToPeerId || samePeer(message.replyTo.replyToPeerId, binding.peerId))) {
    trigger = "reply"; replyId = message.replyTo.replyToMsgId;
  } else if (ordinary) trigger = "ordinary";
  else return;
  const grouped=message.groupedId?.toString();
  const albumKey=grouped && /^-?[1-9]\d{0,18}$/.test(grouped) && BigInt(grouped)>=-(2n**63n) && BigInt(grouped)<2n**63n && inputImageIdentity(message)!==undefined
    ? digest([binding.peerId,ownerId,grouped]) : undefined;
  return Object.freeze({ id: message.id, ownerId, date: message.date, trigger,
    ...(!message.replyTo ? { unthreaded: true as const } : {}),
    ...(albumKey===undefined?{}:{albumKey,...(message.message.trim()?{albumCaption:true as const}:{}),
      ...(trigger==="ordinary" || trigger==="reply" && !message.message.trim()?{albumContinuation:true as const}:{})}), ...(replyId === undefined ? {} : { replyId }),
    proof: digest([message.message, inputImageIdentity(message) ?? null, message.groupedId?.toString() ?? null, message.date, message.editDate ?? null, ownerId, trigger, replyId ?? null, contextLink(message, binding.peerId)]) });
}
function historyId(message: Api.TypeMessage, chatId: string): number {
  if (!validId(message.id) || (!(message instanceof Api.Message || message instanceof Api.MessageService || message instanceof Api.MessageEmpty)) ||
      (message.peerId && !samePeer(message.peerId, chatId))) return fail();
  if (!(message instanceof Api.MessageEmpty) && !samePeer(message.peerId, chatId)) return fail();
  return message.id;
}
type ContextLink = Readonly<{ id: number | null; status: "complete" | "bound" | "truncated" | "unavailable" }>;
function contextLink(message: Api.Message, chatId: string): ContextLink {
  if (!message.replyTo) return { id: null, status: "complete" };
  const header = message.replyTo;
  if (!(header instanceof Api.MessageReplyHeader) || header.replyToScheduled ||
      (header.replyToPeerId && !samePeer(header.replyToPeerId, chatId))) return { id: null, status: "unavailable" };
  if (!validId(header.replyToMsgId) || header.replyToMsgId >= message.id) return { id: null, status: "truncated" };
  return { id: header.replyToMsgId, status: "bound" };
}
function displayName(user: Api.User | undefined, self: boolean): string {
  if (self) return "Нейробро";
  const name = [user?.firstName, user?.lastName].filter(value => typeof value === "string").map(value => value!.slice(0, 128)).join(" ") || user?.username || "Участник";
  const plain = name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, 128);
  // Do not leave a lone UTF-16 surrogate at the bounded display-name boundary.
  return Buffer.from(plain, "utf8").toString("utf8").replace(/\ufffd/gu, "") || "Участник";
}
function projectContext(message: Api.TypeMessage | undefined, users: Api.TypeUser[], binding: PilotBinding): StandingContextMessage | undefined {
  if (!(message instanceof Api.Message) || !validId(message.id) || !samePeer(message.peerId, binding.peerId) ||
      !(message.fromId instanceof Api.PeerUser) || message.post || !Number.isSafeInteger(message.date) || message.date <= 0) return;
  const authorId = message.fromId.userId.toString(), self = authorId === binding.accountId;
  if (!validUser(authorId) || !!message.out !== self) return;
  const photoId = self ? selfPhotoId(message,binding) : incomingShape(message) ? inputImageIdentity(message) : undefined;
  const media = photoId === undefined ? projectStandingMediaContext(message, binding) : undefined;
  if (!textOnly(message) && photoId === undefined && !media) return;
  const authors = users.filter(user => user.id.toString() === authorId);
  if (authors.length > 1 || (!self && (authors.length !== 1 || !(authors[0] instanceof Api.User) || authors[0].bot || authors[0].deleted || authors[0].self))) return;
  const user = authors[0] instanceof Api.User ? authors[0] : undefined;
  return Object.freeze({ chatId: binding.peerId, messageId: message.id, authorId, author: self ? "self" : "user",
    displayName: displayName(user, self), date: message.date, replyToMessageId: contextLink(message, binding.peerId).id,
    text: media?.text ?? (photoId === undefined ? message.message : (self ? PHOTO_CONTEXT_MARKER : primaryText(message)) + (self && message.message.length ? "\n" + message.message : "")) });
}
function selfAnchorProof(value: Api.TypeMessage | undefined, binding: PilotBinding): string | undefined {
  if (!(value instanceof Api.Message) || !samePeer(value.peerId, binding.peerId) || !(value.fromId instanceof Api.PeerUser) ||
      value.fromId.userId.toString() !== binding.accountId || !value.out || value.post) return;
  const photoId = selfPhotoId(value,binding);
  if (photoId !== undefined) return digest(["photo",value.id,photoId,value.message,value.date,value.editDate ?? null,binding.accountId,contextLink(value,binding.peerId)]);
  const media = projectStandingOwnMediaContext(value, binding);
  if (media && value.media instanceof Api.MessageMediaPoll) {
    const poll = value.media.poll;
    // Closing this poll may be the very action requested by a reply to it.
    // Bind the immutable question/options and routing, not vote/closed state or
    // editDate changed by closure. A changed question/options still refuses.
    return digest(["poll-anchor", value.id, poll.id.toString(), poll.question.text,
      poll.answers.map(a => [a.text.text, a.option.toString("hex")]), !!poll.quiz, !!poll.multipleChoice,
      !!poll.publicVoters, poll.closeDate ?? null, poll.closePeriod ?? null, value.message,
      value.date, binding.accountId, contextLink(value, binding.peerId)]);
  }
  if (media) return digest(["media", value.id, media.identity, value.date, value.editDate ?? null, binding.accountId, contextLink(value, binding.peerId)]);
  if (!textOnly(value)) return;
  return digest([value.id, value.message, value.date, value.editDate ?? null, binding.accountId]);
}
function replyAnchorProof(value:Api.TypeMessage|undefined,users:Api.TypeUser[],binding:PilotBinding):string|undefined {
  const own=selfAnchorProof(value,binding);if(own!==undefined)return own;
  if(!(value instanceof Api.Message)||value.out||!incomingShape(value)||inputImageIdentity(value)===undefined||value.fromScheduled)return;
  const context=projectContext(value,users,binding);if(!context||context.author!=="user")return;
  return digest(["participant-photo",context,inputImageIdentity(value),value.editDate??null]);
}
async function waitDefault(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new StandingAdapterError("aborted")); return; }
    const abort = () => { clearTimeout(timer); reject(new StandingAdapterError("aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Sole-client sequential adapter. Runner owns reconnect/teardown, encrypted cursor
 * binding, durable outbox, model input projection and stopping unknown outcomes.
 * Fresh startup checkpoints the latest ID without processing that baseline body.
 * Resume scans all later IDs; startedAt is not reapplied to downtime messages.
 * Queue contains only IDs/proofs/trigger metadata, never surrounding message text.
 * At most three pages/300 messages and 100 candidates per catch-up. A continuation
 * probe proves exhaustion; excess backlog stops without advancing the durable cursor.
 * MTProto cannot expose deleted/unavailable messages: continuity concerns returned
 * available history, not a claim of recovering deleted or hidden traffic. */
export async function createStandingConversationAdapter(input: {
  client: PilotInvoker; binding: PilotBinding; self: Api.User; signal: AbortSignal; startedAt: number;
  /** Sole-client media DC port; owner joins acquire/invoke/cleanup, never switches the main DC. */
  readMediaFile?: StandingMediaFileReader;
  resumeCursor?: number; checkpointCursor(cursor: number): Promise<void>;
  checkpointQuestion?(primary: PilotPrimary, context: StandingContext): Promise<void>;
  /** App-owned observation sink; same bound client's responses only. Default absent.
   * The service owns its lifetime and joins it before closing the archive. */
  sourceObserver?: { observe(envelope: unknown, signal: AbortSignal): Promise<unknown> };
  /** Source-owned deployment choice; never selected by a chat message. Default false. */
  enableImages?: boolean;
  /** Shared native-thread epoch references are owned/closed by the service. */
  references?: ConversationReferences;
  /** Source-owned capability, absent by default. Requires matching references. */
  enableSelfHistory?: boolean;
  /** Source-owned named group reads; callable only during a selected request. */
  enableGroupTools?: boolean;
  enableArtifacts?: boolean;
  enableBoundActions?: boolean;
  clock?: () => number; wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  initiative?: Readonly<{ enabled(): boolean; minimumIntervalMs?: number; debounceMs?: number }>;
}): Promise<Readonly<{ next(signal: AbortSignal): Promise<StandingSelection>; pollNext(signal: AbortSignal): Promise<StandingPollNext>;
  pollWork(signal: AbortSignal, options: Readonly<{ backgroundDue: boolean }>): Promise<StandingPollWork>; close(): void; selfHistory?: StandingSelfHistory;
  extraTools?: readonly EpochExtraTool[]; closeCapabilities(): Promise<void> }>> {
  const binding = Object.freeze({ ...input.binding });
  const startedAt = input.startedAt;
  const resume = input.resumeCursor;
  const checkpoint = input.checkpointCursor;
  const observeSource = input.sourceObserver?.observe.bind(input.sourceObserver);
  const now = input.clock ?? (() => performance.now());
  const openedAt = now();
  let initiativeEnabled: (() => boolean) | undefined;
  let initiativeInterval = 120_000, initiativeDebounce = 6000;
  if (input.initiative !== undefined) {
    const config = input.initiative;
    if (!config || typeof config !== "object" || types.isProxy(config) || ![Object.prototype, null].includes(Object.getPrototypeOf(config))) return fail("binding");
    const ds = Object.getOwnPropertyDescriptors(config);
    if (!ds.enabled || Reflect.ownKeys(ds).some(key => typeof key !== "string" || !["enabled", "minimumIntervalMs", "debounceMs"].includes(key) || !("value" in ds[key]!) || !ds[key]!.enumerable)) return fail("binding");
    const enabled = ds.enabled.value;
    if (typeof enabled !== "function" || types.isProxy(enabled) || types.isAsyncFunction(enabled) || types.isGeneratorFunction(enabled)) return fail("binding");
    initiativeInterval = ds.minimumIntervalMs?.value ?? initiativeInterval;
    initiativeDebounce = ds.debounceMs?.value ?? initiativeDebounce;
    if (!Number.isSafeInteger(initiativeInterval) || initiativeInterval < 120_000 || initiativeInterval > 3_600_000 ||
        !Number.isSafeInteger(initiativeDebounce) || initiativeDebounce < 1000 || initiativeDebounce > 30_000) return fail("binding");
    initiativeEnabled = () => { try {
      const result: unknown = Reflect.apply(enabled, config, []);
      if (types.isPromise(result)) void Promise.prototype.then.call(result, () => {}, () => {});
      return result === true;
    } catch { return false; } };
  }
  // Restart conservatively re-arms cooldown; persisted cursor still consumes
  // each selected anchor even when its social decision is silence.
  let initiativeAfter = now() + initiativeInterval;
  let passive: { candidate: Candidate; openedAt: number; changedAt: number } | undefined;
  let continuation: { candidate: Candidate; anchor: ContinuationAnchor } | undefined;
  let previousOwn: ContinuationAnchor | undefined;
  let conversationObserved = false, observedThrough = resume ?? 0;
  const anchorFresh = (anchor: ContinuationAnchor, candidate?: Candidate) => {
    const age = startedAt + (now() - openedAt) / 1000 - anchor.message.date;
    return Number.isFinite(age) && age >= -30 && age <= 180 && (!candidate ||
      candidate.id > anchor.message.messageId && candidate.date >= anchor.message.date && candidate.date - anchor.message.date <= 180);
  };
  const observeOwn = (anchor: ContinuationAnchor) => {
    previousOwn = anchorFresh(anchor) ? anchor : undefined;
    const age = startedAt + (now() - openedAt) / 1000 - anchor.message.date;
    if (Number.isFinite(age) && age >= -30 && age < initiativeInterval / 1000)
      initiativeAfter = Math.max(initiativeAfter, now() + initiativeInterval - Math.max(0, age * 1000));
  };
  const humanReplyProofs = new Map<number, string>();
  const consumedAlbums=new Set<string>();
  const consumedAlbum=(candidate:Candidate)=>candidate.albumKey!==undefined && candidate.albumContinuation===true && consumedAlbums.has(candidate.albumKey);
  const initiativeDue = () => initiativeEnabled?.() === true && Number.isFinite(now()) && now() >= initiativeAfter;
  const rememberPassive = (candidate: Candidate) => {
    if (!initiativeDue() || candidate.id <= cursor || consumedAlbum(candidate)) return;
    const at = now();
    if (!passive) passive = { candidate, openedAt: at, changedAt: at };
    else if(candidate.albumKey!==undefined && candidate.albumKey===passive.candidate.albumKey) {
      // Keep an album's caption as the ordinary anchor even when Telegram returns
      // its captionless sibling first in reverse chronological history.
      if(candidate.albumCaption && !passive.candidate.albumCaption || candidate.albumCaption===passive.candidate.albumCaption && candidate.id<passive.candidate.id || candidate.id===passive.candidate.id && candidate.proof!==passive.candidate.proof)
        passive={candidate,openedAt:passive.openedAt,changedAt:at};
    }
    else if (candidate.id > passive.candidate.id || candidate.proof !== passive.candidate.proof && candidate.id === passive.candidate.id)
      passive = { candidate, openedAt: passive.openedAt, changedAt: at };
  };
  const wait = input.wait ?? waitDefault;
  const invoke = input.client.invoke.bind(input.client);
  const readMediaFile=input.readMediaFile;
  const imagesEnabled = input.enableImages === true;
  const historyEnabled = input.enableSelfHistory === true, references = input.references;
  const groupsEnabled = input.enableGroupTools === true;
  const artifactsEnabled = input.enableArtifacts === true;
  const actionsEnabled = input.enableBoundActions === true;
  let activeActions: BoundActionLease | undefined;
  const actionClosings = new Set<Promise<void>>();
  let activeArtifactLease: StandingArtifactTransportLease | undefined;
  const artifactClosings = new Set<Promise<void>>();
  let extraTools: readonly EpochExtraTool[] | undefined, groupTools: ReturnType<typeof createBoundGroupTools> | undefined;
  let groupPending: Promise<unknown> | undefined, groupClosing: Promise<void> | undefined;
  let groupLease: Readonly<{ selection: symbol; signal: AbortSignal; scopeSignal: AbortSignal }> | undefined;
  let selfHistory: StandingSelfHistory | undefined;
  let historyBusy = false, historySelectionSignal: AbortSignal | undefined;
  let idleTicketIdentity: symbol | undefined, activeIdleHistory: StandingIdleHistoryLease | undefined;
  const idleHistoryClosings = new Set<Promise<void>>();
  let activeTaskReply: StandingTaskReplyLease | undefined;
  const taskReplyClosings = new Set<Promise<void>>();
  let ownPhotoAnchorPending: Promise<unknown> | undefined;
  let inputImagesPending: Promise<unknown> | undefined;
  let typingSettlement: Promise<void> | undefined;
  let closed = false;
  let busy = false;
  let active = false;
  let activeSelection: symbol | undefined;
  let typingSelection: number | undefined;
  let typingBusy = false;
  let typingDisabled = false;
  let lastTyping: number | undefined;
  let lastHistory: number | undefined;
  let cursor = resume ?? 0;
  let scannedThrough = cursor;
  const queue: Candidate[] = [];
  const close = () => { closed = true; passive = undefined; continuation = undefined; previousOwn = undefined; idleTicketIdentity = undefined; activeSelection = undefined; typingSelection = undefined; historySelectionSignal = undefined; queue.length = 0; selfHistory?.close();
    if (groupTools && !groupClosing) { groupClosing = groupTools.close(); void groupClosing.catch(() => {}); }
    if (activeArtifactLease) void activeArtifactLease.close();
    if (activeActions) void activeActions.close();
    if (activeIdleHistory) void activeIdleHistory.close();
    if (activeTaskReply) void activeTaskReply.close(); };
  const closeCapabilities = async () => { close(); await Promise.all([groupClosing, groupPending,
    ownPhotoAnchorPending?.then(() => {}, () => {}), inputImagesPending?.then(() => {}, () => {}), ...artifactClosings, ...actionClosings, ...idleHistoryClosings, ...taskReplyClosings]); };
  const check = (signal: AbortSignal) => { if (closed || input.signal.aborted || signal.aborted) { close(); return fail("aborted"); } };
  async function observe(envelope: unknown, signal: AbortSignal): Promise<void> {
    if (!observeSource) return;
    check(signal);
    try { await observeSource(envelope, signal); }
    catch { close(); return fail(input.signal.aborted || signal.aborted ? "aborted" : "checkpoint"); }
    check(signal);
  }
  async function request<T>(value: Api.AnyRequest, signal: AbortSignal, parse: (envelope: unknown) => T): Promise<T> {
    check(signal); let envelope: unknown;
    try {
      try { envelope = await invoke(value); }
      catch (error) { return fail(input.signal.aborted || signal.aborted ? "aborted" : invokeFailure(error)); }
      check(signal); const result = parse(envelope); await observe(envelope, signal); return result;
    } catch (error) { close(); if (error instanceof StandingAdapterError) throw error; return fail(); }
    finally { discard(envelope); }
  }
  if ((input.enableImages !== undefined && typeof input.enableImages !== "boolean") || (input.enableSelfHistory !== undefined && typeof input.enableSelfHistory !== "boolean") ||
      (input.enableGroupTools !== undefined && typeof input.enableGroupTools !== "boolean") ||
      (input.enableArtifacts !== undefined && typeof input.enableArtifacts !== "boolean") ||
      (input.enableBoundActions !== undefined && typeof input.enableBoundActions !== "boolean") ||
      !Number.isSafeInteger(startedAt) || startedAt <= 0 || (resume !== undefined && !validCursor(resume)) || typeof checkpoint !== "function" ||
      !(input.self instanceof Api.User) || !input.self.self || input.self.bot || input.self.deleted || input.self.id.toString() !== binding.accountId ||
      !validUser(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId)) return fail("binding");
  if (historyEnabled || actionsEnabled) {
    let matches = false; try { matches = references?.matches(binding.peerId,binding.accountId) === true; } catch { /* Revoked or foreign epoch. */ }
    if (!matches) return fail("binding");
  }
  const usernames = new Set<string>();
  for (const name of [input.self.username, ...(input.self.usernames ?? []).filter(value => value.active).map(value => value.username)]) {
    if (typeof name === "string" && /^[A-Za-z0-9_]{5,32}$/.test(name)) usernames.add(name.toLowerCase());
  }
  const peer = await request(new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(), limit: 100, hash: bigInt.zero }), input.signal,
    envelope => { try { return resolvePilotPeer(binding, input.self, envelope); } catch { return fail("binding"); } });
  const getMessage = (id: number): Api.AnyRequest => peer instanceof Api.InputPeerChannel
    ? new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }), id: [new Api.InputMessageID({ id })] })
    : new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id })] });
  /** One optional ephemeral indicator, no primary text or arbitrary target.
   * The service owns its timer and joins in-flight pulses before proceeding.
   * Errors only disable this connection's typing; they never close the adapter.
   * Underlying invoke may outlive abort. No cancel request or retry is sent. */
  function typingFor(candidate: Candidate, signal: AbortSignal): () => Promise<void> {
    return async () => {
      if (closed || !active || typingSelection !== candidate.id || input.signal.aborted || signal.aborted || typingBusy || typingDisabled || historyBusy) return;
      let finishTyping: (() => void) | undefined;
      try {
        const at = now();
        if (!Number.isFinite(at) || (lastTyping !== undefined && at < lastTyping)) { typingDisabled = true; return; }
        if (lastTyping !== undefined && at - lastTyping < 4000) return;
        typingBusy = true; lastTyping = at;
        typingSettlement = new Promise<void>(done => { finishTyping = done; });
        const result = await invoke(new Api.messages.SetTyping({ peer, action: new Api.SendMessageTypingAction() }));
        if (result !== true) typingDisabled = true;
      } catch { typingDisabled = true; }
      finally { typingBusy = false; if (finishTyping) { typingSettlement = undefined; finishTyping(); } }
    };
  }
  async function waitForHistory(signal: AbortSignal): Promise<void> {
    check(signal); const before = now();
    if (!Number.isFinite(before) || (lastHistory !== undefined && before < lastHistory)) return fail();
    let at = before;
    while (lastHistory !== undefined && at - lastHistory < 3000) {
      const previous = at;
      await wait(Math.max(1, Math.ceil(3000 - (at - lastHistory))), AbortSignal.any([input.signal, signal]));
      check(signal); at = now();
      // Timers may fire early. Re-wait the remaining interval instead of
      // misclassifying an ordinary idle poll as a protocol failure.
      if (!Number.isFinite(at) || at <= previous) return fail();
    }
    check(signal);
    lastHistory = at;
  }
  async function history<T>(limit: number, offsetId: number, minId: number, signal: AbortSignal, parse: (batch: Batch) => T): Promise<T> {
    await waitForHistory(signal);
    return request(new Api.messages.GetHistory({ peer, offsetId, offsetDate: 0, addOffset: 0, limit, maxId: 0, minId, hash: bigInt.zero }), signal,
      envelope => parse(batchOf(envelope, limit)));
  }
  async function persist(value: number, signal: AbortSignal): Promise<void> {
    check(signal); if (!validCursor(value) || value < cursor) return fail();
    try { await checkpoint(value); } catch { return fail("checkpoint"); }
    check(signal); cursor = value;
  }
  if (historyEnabled) {
    const reader = createSelfHistoryReader({ client: { invoke: async requestValue => {
      // The reader owns request construction. Retain the exact selected lease
      // across waits and the actual invoke; closing cannot publish a late page.
      const selection = activeSelection, signal = historySelectionSignal;
      const selected = () => {
        if (!historyBusy || !active || selection === undefined || activeSelection !== selection || !signal ||
            closed || input.signal.aborted || signal.aborted || historySelectionSignal !== signal) throw new SelfHistoryReaderError("aborted");
      };
      selected(); await waitForHistory(signal!); selected();
      let envelope: unknown;
      try { envelope = await invoke(requestValue); selected(); await observe(envelope,signal!); selected(); return envelope; }
      catch (error) { discard(envelope); throw error; }
    } }, peer, binding, self: input.self, signal: input.signal, references: references! });
    selfHistory = createSelfHistoryTool({ signal: input.signal, history: {
      close: reader.close,
      async read(value) {
        if (historyBusy) throw new SelfHistoryReaderError("busy");
        if (closed || !active || !activeSelection || !historySelectionSignal || input.signal.aborted || historySelectionSignal.aborted)
          throw new SelfHistoryReaderError("aborted");
        historyBusy = true;
        try {
          // Reserve before waiting, so no new typing/send can overlap this read.
          await typingSettlement;
          return await reader.read(value);
        } finally { historyBusy = false; }
      },
    } });
  }
  if (groupsEnabled) {
    const selectedGroup = () => {
      const lease = groupLease;
      if (!lease || !historyBusy || !active || activeSelection !== lease.selection || historySelectionSignal !== lease.signal ||
        closed || input.signal.aborted || lease.signal.aborted || lease.scopeSignal.aborted) throw new BoundGroupReaderError("aborted");
      return lease;
    };
    const reader = createBoundGroupReader({ client: { invoke: async value => {
      const lease = selectedGroup(); await waitForHistory(AbortSignal.any([lease.signal, lease.scopeSignal])); selectedGroup();
      const result = await invoke(value); selectedGroup(); return result;
    } }, peer, binding, self: input.self, signal: input.signal });
    groupTools = createBoundGroupTools({ reader, signal: input.signal });
    const refusedGroup = (code: string): EpochToolResult => Object.freeze({ success: false,
      contentItems: Object.freeze([Object.freeze({ type: "inputText" as const, text: JSON.stringify({ schema: "neurobro-group-tool-error-v1", code }) })]) as EpochToolResult["contentItems"] });
    extraTools = Object.freeze(groupTools.handlers.map(handler => Object.freeze({ name: handler.name, call: (args, scope) => {
      if (historyBusy) return Promise.resolve(refusedGroup("busy"));
      if (closed || !active || !activeSelection || !historySelectionSignal || input.signal.aborted || historySelectionSignal.aborted || scope.signal.aborted)
        return Promise.resolve(refusedGroup("inactive-selection"));
      historyBusy = true;
      groupLease = Object.freeze({ selection: activeSelection, signal: historySelectionSignal, scopeSignal: scope.signal });
      // Publish the reservation and pending ownership before handler/typing ports run.
      const pending = Promise.resolve().then(async () => {
        await typingSettlement; selectedGroup(); return await handler.call(args, scope);
      }).catch(() => refusedGroup("stopped")).finally(() => { historyBusy = false; groupLease = undefined; groupPending = undefined; });
      groupPending = pending; return pending;
    } } satisfies EpochExtraTool)));
  }
  if (resume === undefined) {
    try {
      const baseline = await history(1, 0, 0, input.signal, batch => batch.messages.length ? historyId(batch.messages[0]!, binding.peerId) : 0);
      await persist(baseline, input.signal); scannedThrough = baseline;
    } catch (error) { close(); if (error instanceof StandingAdapterError) throw error; return fail(); }
  }
  async function collect(signal: AbortSignal): Promise<void> {
    let offset = 0;
    let top = cursor;
    const pending: Candidate[] = [];
    const ordinaryCandidates: Candidate[] = [];
    type ConversationObservation = { id: number; own?: ContinuationAnchor; human: boolean; candidate?: Candidate };
    const observations: ConversationObservation[] = [];
    const observation = (message: Api.TypeMessage, users: Api.TypeUser[]): ConversationObservation => {
      if (!(message instanceof Api.Message) || !(message.fromId instanceof Api.PeerUser)) return { id: message.id, human: false };
      if (message.fromId.userId.toString() === binding.accountId) {
        const context = projectContext(message, users, binding), proof = selfAnchorProof(message, binding);
        return context?.author === "self" && proof && !message.fromScheduled ?
          { id: message.id, human: false, own: { message: context, proof } } : { id: message.id, human: true };
      }
      const ownerId = message.fromId.userId.toString();
      const authors = users.filter(user => user.id.toString() === ownerId);
      // Unknown/malformed human input breaks adjacency, too. Bot messages never
      // establish a human continuation opportunity.
      return { id: message.id, human: !(authors.length === 1 && authors[0] instanceof Api.User && authors[0].bot) };
    };
    let total = 0;
    for (let page = 0; page <= 3; page++) {
      const limit = page === 3 ? 1 : 100;
      const result = await history(limit, offset, cursor, signal, batch => {
        let previous = offset || 2_147_483_648;
        const candidates: Candidate[] = [];
        for (const message of batch.messages) {
          const id = historyId(message, binding.peerId);
          if (id <= cursor || id >= previous) return fail(); previous = id;
          if (top === cursor) top = id;
          const candidate = project(message, batch.users, binding, usernames, true);
          if (id > observedThrough) observations.push({ ...observation(message, batch.users),
            ...(candidate && (resume !== undefined || candidate.date >= startedAt) ? { candidate } : {}) });
          if (candidate && !consumedAlbum(candidate) && (resume !== undefined || candidate.date >= startedAt)) {
            if (candidate.trigger === "ordinary" || candidate.trigger === "reply" && humanReplyProofs.get(candidate.id) === candidate.proof) {
              if (initiativeDue()) ordinaryCandidates.push(candidate);
            }
            else candidates.push(candidate);
          }
        }
        return { length: batch.messages.length, oldest: previous, candidates };
      });
      if (!result.length) {
        for (const value of observations.reverse()) {
          if (value.id <= observedThrough) continue;
          // After reconnect, recover only the immediately preceding own turn
          // from a bounded lookbehind; never scan archives or manufacture a reply.
          if (!conversationObserved && value.human && value.candidate?.trigger === "ordinary" && value.candidate.unthreaded) {
            await history(STANDING_CONTEXT_WINDOW_LIMIT, value.id, 0, signal, batch => {
              let previous = value.id;
              for (const message of batch.messages) {
                const id = historyId(message, binding.peerId); if (id >= previous) return fail(); previous = id;
                const prior = observation(message, batch.users);
                if (prior.own) { observeOwn(prior.own); break; }
                if (prior.human) break;
              }
            });
          }
          conversationObserved = conversationObserved || value.human || value.own !== undefined; observedThrough = value.id;
          if (value.own) { observeOwn(value.own); continue; }
          if (!value.human) continue;
          const candidate = value.candidate;
          if (previousOwn && candidate?.trigger === "ordinary" && candidate.unthreaded &&
              !consumedAlbum(candidate) && anchorFresh(previousOwn, candidate))
            continuation = { candidate, anchor: previousOwn };
          previousOwn = undefined;
        }
        for (const candidate of ordinaryCandidates) rememberPassive(candidate);
        scannedThrough = top;
        queue.push(...pending.reverse());
        return;
      }
      if (page === 3) return overload();
      total += result.length; pending.push(...result.candidates);
      if (total > 300 || pending.length > 100) return overload();
      offset = result.oldest;
    }
    return overload();
  }
  type CandidateRead = { primary: PilotPrimary; contextPrimary: StandingContextMessage; link: ContextLink; scheduled: boolean; hasImage:boolean };
  function readCandidate(candidate: Candidate, signal: AbortSignal): Promise<CandidateRead>;
  function readCandidate(candidate: Candidate, signal: AbortSignal, allowStale: true): Promise<CandidateRead | undefined>;
  async function readCandidate(candidate: Candidate, signal: AbortSignal, allowStale = false): Promise<CandidateRead | undefined> {
    return request(getMessage(candidate.id), signal, envelope => {
      const batch = batchOf(envelope, 1);
      if (batch.messages.length !== 1) return fail();
      const raw = batch.messages[0];
      if (allowStale && raw instanceof Api.MessageEmpty && raw.id === candidate.id && (!raw.peerId || samePeer(raw.peerId, binding.peerId))) return;
      if (!(raw instanceof Api.Message) || raw.id !== candidate.id || !samePeer(raw.peerId, binding.peerId) ||
          !(raw.fromId instanceof Api.PeerUser) || raw.fromId.userId.toString() !== candidate.ownerId || raw.out || raw.post || raw.date !== candidate.date) return fail();
      const value = project(raw, batch.users, binding, usernames, true);
      if (!value && allowStale) {
        const authors = batch.users.filter(user => user.id.toString() === candidate.ownerId);
        const knownMedia = raw.media === undefined || raw.media instanceof Api.MessageMediaEmpty || raw.media instanceof Api.MessageMediaWebPage ||
          raw.media instanceof Api.MessageMediaPhoto || raw.media instanceof Api.MessageMediaDocument;
        if (authors.length === 1 && authors[0] instanceof Api.User && !authors[0].bot && !authors[0].deleted && !authors[0].self && knownMedia &&
            typeof raw.message === "string" && !raw.message.includes("\0") && Buffer.byteLength(raw.message, "utf8") <= 4096 &&
            Buffer.from(raw.message, "utf8").toString("utf8") === raw.message) return;
      }
      if (!value) return fail();
      if (value.proof !== candidate.proof) { if (allowStale) return; return fail(); }
      const message = batch.messages[0] as Api.Message;
      const contextPrimary = projectContext(message, batch.users, binding);
      if (!contextPrimary) return fail();
      return { primary: Object.freeze({ chatId: binding.peerId, ownerId: value.ownerId, messageId: value.id, text: primaryText(message) }),
        contextPrimary, link: contextLink(message, binding.peerId), scheduled: message.fromScheduled === true, hasImage:inputImageIdentity(message)!==undefined };
    });
  }
  async function anchorProof(id: number, signal: AbortSignal, captureIdentity?: (identity: AnchorIdentity) => void): Promise<string | undefined> {
    return request(getMessage(id), signal, envelope => {
      const batch = batchOf(envelope, 1);
      if (batch.messages.length !== 1) return;
      const value = batch.messages[0];
      if (value instanceof Api.MessageEmpty && value.id === id) return;
      if (!(value instanceof Api.Message) || value.id !== id || !samePeer(value.peerId, binding.peerId)) return fail();
      const proof = replyAnchorProof(value, batch.users, binding);
      if (proof !== undefined && value.fromId instanceof Api.PeerUser) captureIdentity?.({ ownerId: value.fromId.userId.toString(), date: value.date });
      return proof;
    });
  }
  /** Optional historical data never changes the primary or the durable cursor.
   * Reads are strictly bounded and cannot follow a foreign peer. Missing context
   * is exposed to the consumer; it is never converted into fabricated history. */
  async function contextFor(primary: StandingContextMessage, firstLink: ContextLink, expectedDirectProof: string | undefined, signal: AbortSignal,
      captureOwnPhoto?: (anchor: Readonly<{ id: number; proof: string }>) => void, expectedDirectIdentity?: AnchorIdentity): Promise<StandingContext | undefined> {
    // Admission budget only: never detach an in-flight same-client request. The
    // caller's existing invoke deadline bounds that final request's settlement.
    const began = now();
    const budgetExpired = () => { const at = now(); return !Number.isFinite(began) || !Number.isFinite(at) || at < began || at - began >= 8000; };
    const replyChain: StandingContextMessage[] = [];
    let chainStatus: StandingContextStatus = firstLink.status === "bound" ? "complete" : firstLink.status;
    let recentStatus: StandingContext["recentStatus"] = "unavailable";
    let recent: StandingContextMessage[] = [];
    let next = firstLink.id;
    let failedRead = false;
    async function optional<T>(value: Api.AnyRequest, parse: (batch: Batch) => T, limit: number): Promise<{ value: T } | undefined> {
      check(signal); let envelope: unknown;
      if (budgetExpired()) return;
      try { envelope = await invoke(value); check(signal); const result = parse(batchOf(envelope, limit)); await observe(envelope,signal); return { value: result }; }
      catch (error) { if(error instanceof StandingAdapterError && error.code==="checkpoint")throw error;check(signal); failedRead = true; return; }
      finally { discard(envelope); }
    }
    type Ancestor = { message?: StandingContextMessage; link?: ContextLink; status: "complete" | "partial" | "missing" | "unavailable"; proof?: string; stale?: true };
    for (let depth = 0; next !== null && depth < STANDING_CONTEXT_CHAIN_LIMIT; depth++) {
      if (budgetExpired()) { chainStatus = "truncated"; break; }
      const id = next;
      const result = await optional<Ancestor>(getMessage(id), batch => {
        if (batch.messages.length !== 1) return { status: "missing" };
        const value = batch.messages[0];
        if (value instanceof Api.MessageEmpty && value.id === id && (!value.peerId || samePeer(value.peerId, binding.peerId)))
          return { status: "missing", ...(depth === 0 && expectedDirectIdentity ? { stale: true as const } : {}) };
        if (!(value instanceof Api.Message) || value.id !== id || !samePeer(value.peerId, binding.peerId)) return { status: "unavailable" };
        const message = projectContext(value, batch.users, binding), proof = replyAnchorProof(value, batch.users, binding);
        if (depth === 0 && expectedDirectIdentity && proof !== expectedDirectProof && message &&
            message.authorId === expectedDirectIdentity.ownerId && message.date === expectedDirectIdentity.date)
          return { status: "partial", stale: true };
        // Reuse the existing direct-context read for host-only photo identity.
        // PROMPT/mention reply headers keep their original trigger semantics.
        if (depth === 0 && proof !== undefined && !value.fromScheduled && selfPhotoId(value, binding) !== undefined &&
            contextLink(value, binding.peerId).status === "bound") captureOwnPhoto?.(Object.freeze({ id, proof }));
        if (!message || message.date > primary.date) return { status: "partial", ...(proof === undefined ? {} : { proof }) };
        return { status: "complete", message, link: contextLink(value, binding.peerId), ...(proof === undefined ? {} : { proof }) };
      }, 1);
      if (!result) { chainStatus = "unavailable"; break; }
      if (depth === 0 && expectedDirectProof !== undefined && result.value.proof !== expectedDirectProof) {
        if (result.value.stale) return;
        return fail();
      }
      const value = result.value;
      if (!value.message || !value.link) { chainStatus = value.status; break; }
      replyChain.push(value.message); next = value.link.id;
      chainStatus = value.link.status === "bound" ? "complete" : value.link.status;
      if (next !== null && replyChain.length === STANDING_CONTEXT_CHAIN_LIMIT) chainStatus = "truncated";
    }
    if (!failedRead && !budgetExpired()) {
      // Reuse the same minimum interval as cursor polling, with no extra client.
      await waitForHistory(signal);
      const chainIds = new Set(replyChain.map(message => message.messageId));
      const window = await optional(new Api.messages.GetHistory({ peer, offsetId: primary.messageId, offsetDate: 0,
        addOffset: 0, limit: STANDING_CONTEXT_WINDOW_LIMIT, maxId: 0, minId: 0, hash: bigInt.zero }), batch => {
        const messages: StandingContextMessage[] = [];
        let partial = false, previous = primary.messageId;
        for (const value of batch.messages) {
          const id = historyId(value, binding.peerId);
          if (id >= previous) return { messages: [], status: "unavailable" as const };
          previous = id;
          if (chainIds.has(id)) continue;
          const message = projectContext(value, batch.users, binding);
          if (!message || message.date > primary.date) { partial = true; continue; }
          messages.push(message);
        }
        return { messages: messages.reverse(), status: batch.messages.length === STANDING_CONTEXT_WINDOW_LIMIT ? "truncated" as const : partial ? "partial" as const : "complete" as const };
      }, STANDING_CONTEXT_WINDOW_LIMIT);
      if (window) { recent = window.value.messages; recentStatus = window.value.status; }
    }
    return Object.freeze({ version: "standing-context-v1", primary, replyChain: Object.freeze(replyChain), recent: Object.freeze(recent), chainStatus, recentStatus });
  }
  function transportsFor(candidate: Candidate, primary: PilotPrimary, expectedAnchorProof: string | undefined, selectionSignal: AbortSignal,
      photoAnchor: Readonly<{ id: number; proof: string }> | undefined, initiative = false, context?:StandingContext, continuationAnchor?: ContinuationAnchor): Pick<StandingSelection, "transport" | "imageTransport" | "openArtifactTransport" | "openActions" | "readOwnPhotoAnchor" | "readInputImages" | "finishInitiative"> {
    const selection = Symbol("standing-selection"); activeSelection = selection;
    historySelectionSignal = selectionSignal;
    let route: "text" | "image" | undefined;
    let readConsumed = false; let sentId: number | undefined; let sentText: string | undefined;
    let sentEntities: readonly TelegramTextEntity[] | undefined;
    const current = () => !closed && !input.signal.aborted && !selectionSignal.aborted && active && activeSelection === selection;
    const finish = () => { active = false; activeSelection = undefined; historySelectionSignal = undefined; };
    const passiveFinish = initiative || continuationAnchor ? { async finishInitiative() {
      await typingSettlement;
      if (activeSelection !== selection || !active || route !== undefined || historyBusy || activeActions || activeArtifactLease || groupPending) return fail();
      typingSelection = undefined; finish();
    } } : {};
    function admit(kind: "text" | "image", signal: AbortSignal): void {
      check(signal); if (!current() || route !== undefined || historyBusy) return fail();
      route = kind;
      historySelectionSignal = undefined;
      if (typingSelection === candidate.id) typingSelection = undefined;
    }
    async function revalidate(signal: AbortSignal): Promise<PilotPrimary> {
      check(signal); if (!current() || initiative && initiativeEnabled?.() !== true) return fail();
      const read = await readCandidate(candidate, signal);
      if (!initiative && candidate.trigger === "reply" && await anchorProof(candidate.replyId!, signal) !== expectedAnchorProof) return fail();
      if (continuationAnchor && await anchorProof(continuationAnchor.message.messageId, signal) !== continuationAnchor.proof) return fail();
      check(signal); if (!current() || initiative && initiativeEnabled?.() !== true) return fail();
      return read.primary;
    }
    let inputPhotosConsumed=false;
    const inputPhotos = { readInputImages(): NonNullable<ReturnType<NonNullable<StandingSelection["readInputImages"]>>> {
      if (!current() || route !== undefined || historyBusy || activeActions || activeArtifactLease || groupPending || inputPhotosConsumed)
        return Promise.resolve({images:[],unavailable:true});
      inputPhotosConsumed=true; historyBusy = true;
      const pending = Promise.resolve().then(async () => {
        const images: {messageId:number;mimeType:"image/jpeg"|"image/png";bytes:Buffer}[] = [];
        try {
          await typingSettlement;
          await revalidate(selectionSignal);
          const ids = [candidate.id];
          let sibling:Readonly<{candidate:Candidate;context:StandingContextMessage}>|undefined;
          if(candidate.albumKey!==undefined) {
            const upper=Math.min(2147483647,candidate.id+21),lower=Math.max(0,candidate.id-21);
            sibling=await history(41,upper,lower,selectionSignal,batch=>{
              const matches: {candidate:Candidate;context:StandingContextMessage}[]=[];
              const seen=new Set<number>();
              for(const value of batch.messages) {
                const id=historyId(value,binding.peerId);
                if(seen.has(id))return fail();seen.add(id);
                if(!(value instanceof Api.Message)||id===candidate.id||Math.abs(id-candidate.id)>20||value.fromScheduled)continue;
                const projected=project(value,batch.users,binding,usernames,true),context=projectContext(value,batch.users,binding);
                if(projected && projected.albumKey===candidate.albumKey && projected.ownerId===candidate.ownerId && context?.author==="user")matches.push({candidate:projected,context});
              }
              return matches.sort((a,b)=>Math.abs(a.candidate.id-candidate.id)-Math.abs(b.candidate.id-candidate.id)||a.candidate.id-b.candidate.id)[0];
            });
            if(sibling)ids.push(sibling.candidate.id);
          }
          // The reply header is part of the primary proof, including addressed
          // prompts whose trigger is not classified as `reply`.
          const fresh = await readCandidate(candidate, selectionSignal);
          if (ids.length<2 && fresh.link.status === "bound" && fresh.link.id !== null && !ids.includes(fresh.link.id)) ids.push(fresh.link.id);
          const continuity: {id:number;proof:string}[]=[];
          if(!fresh.hasImage && !sibling && context && fresh.link.status==="bound" && fresh.link.id!==null) {
            let next:number|null=fresh.link.id;
            for(let depth=0;depth<context.replyChain.length && depth<STANDING_CONTEXT_CHAIN_LIMIT && next!==null;depth++) {
              const snapshot=context.replyChain[depth]!;
              if(snapshot.messageId!==next)break;
              const observed: {context:StandingContextMessage;identity:string|undefined;link:ContextLink;proof:string;candidate:Candidate|undefined}|undefined =await request(getMessage(next),selectionSignal,envelope=>{
                const batch=batchOf(envelope,1),value=batch.messages[0];
                if(batch.messages.length!==1 || !(value instanceof Api.Message) || value.id!==snapshot.messageId || value.fromScheduled)return;
                const projected=projectContext(value,batch.users,binding);
                if(!projected || digest(projected)!==digest(snapshot))return;
                const identity=inputImageIdentity(value),link=contextLink(value,binding.peerId);
                return {context:projected,identity,link,proof:digest([projected,identity??null,value.editDate??null]),
                  candidate:project(value,batch.users,binding,usernames,true)};
              });
              if(!observed)break;
              continuity.push({id:snapshot.messageId,proof:observed.proof});
              // A direct image remains handled by the original direct-target path.
              if(depth===0 && observed.identity!==undefined)break;
              if(depth>0 && observed.context.author==="user" && observed.identity!==undefined && observed.candidate) {
                sibling={candidate:observed.candidate,context:observed.context};
                ids.splice(1,ids.length-1,observed.candidate.id);break;
              }
              next=observed.link.status==="bound"?observed.link.id:null;
            }
          }
          for (const id of ids) {
            check(selectionSignal); if (!current() || route !== undefined) return fail();
            const source = await request(getMessage(id),selectionSignal,envelope => {
              const batch=batchOf(envelope,1), value=batch.messages[0];
              if (batch.messages.length!==1 || !(value instanceof Api.Message) || value.id!==id ||
                  !projectContext(value,batch.users,binding) || value.fromScheduled || !inputImageIdentity(value)) return;
              if(id===candidate.id && project(value,batch.users,binding,usernames,candidate.trigger==="ordinary")?.proof!==candidate.proof)return fail();
              if(id===sibling?.candidate.id && project(value,batch.users,binding,usernames,true)?.proof!==sibling.candidate.proof)return fail();
              return value;
            });
            if (!source) continue;
            if(!readMediaFile)throw new Error("input image reader unavailable");
            const identity=inputImageIdentity(source);
            const image = await downloadStandingInputImage(source, async (value,dcId) => {
              check(selectionSignal); if (!current() || route!==undefined) return fail();
              const result = await readMediaFile(value,dcId);
              check(selectionSignal); if (!current() || route!==undefined) return fail();
              return result;
            }, () => { check(selectionSignal); if (!current() || route!==undefined) return fail(); }, 8*1024*1024-images.reduce((sum,item)=>sum+item.bytes.length,0));
            if (images.reduce((sum,item)=>sum+item.bytes.length,0)+image.bytes.length > 8*1024*1024) {image.bytes.fill(0); throw new Error("input image bound");}
            images.push(image);
            const same=await request(getMessage(id),selectionSignal,envelope=>{
              const batch=batchOf(envelope,1), value=batch.messages[0];
              return batch.messages.length===1 && value instanceof Api.Message && value.id===id &&
                projectContext(value,batch.users,binding)!==undefined && inputImageIdentity(value)===identity &&
                (id!==sibling?.candidate.id || project(value,batch.users,binding,usernames,true)?.proof===sibling.candidate.proof);
            });
            if(!same)throw new Error("input image changed");
            if(continuity.length && id===sibling?.candidate.id) {
              await revalidate(selectionSignal);
              for(const hop of continuity) {
                const unchanged=await request(getMessage(hop.id),selectionSignal,envelope=>{
                  const batch=batchOf(envelope,1),value=batch.messages[0];
                  if(batch.messages.length!==1 || !(value instanceof Api.Message) || value.id!==hop.id || value.fromScheduled)return false;
                  const projected=projectContext(value,batch.users,binding);
                  return projected!==undefined && digest([projected,inputImageIdentity(value)??null,value.editDate??null])===hop.proof;
                });
                if(!unchanged)throw new Error("input image linkage changed");
              }
            }
          }
          return Object.freeze({images:Object.freeze(images),...(sibling && images.some(image=>image.messageId===sibling.candidate.id)?{sources:Object.freeze([sibling.context])}:{})});
        } catch {
          for (const image of images) image.bytes.fill(0);
          return Object.freeze({images:Object.freeze([]),unavailable:true as const});
        }
      }).finally(()=>{historyBusy=false;if(inputImagesPending===pending)inputImagesPending=undefined;});
      inputImagesPending=pending;return pending;
    } };
    const ownPhoto = artifactsEnabled ? { readOwnPhotoAnchor(): Promise<Readonly<{ messageId: number; photoId: string; replyToMessageId: number }> | undefined> {
      if (closed || input.signal.aborted || selectionSignal.aborted) return Promise.reject(new StandingAdapterError("aborted"));
      if (!current() || route !== undefined || historyBusy || photoAnchor === undefined) return Promise.resolve(undefined);
      historyBusy = true;
      const pending = Promise.resolve().then(async () => {
        await typingSettlement;
        check(selectionSignal);
        if (!current() || route !== undefined) return;
        const read = await readCandidate(candidate, selectionSignal);
        if (read.scheduled || read.link.status !== "bound" || read.link.id !== photoAnchor.id) return;
        if (!current() || route !== undefined) return;
        const result = await request(getMessage(photoAnchor.id), selectionSignal, envelope => {
          const batch = batchOf(envelope, 1), value = batch.messages[0];
          if (batch.messages.length !== 1 || !(value instanceof Api.Message) || value.id !== photoAnchor.id ||
              selfAnchorProof(value, binding) !== photoAnchor.proof || value.fromScheduled) return;
          const photoId = selfPhotoId(value, binding), link = contextLink(value, binding.peerId);
          if (photoId === undefined || link.status !== "bound" || link.id === null) return;
          return Object.freeze({ messageId: value.id, photoId, replyToMessageId: link.id });
        });
        return current() && route === undefined ? result : undefined;
      }).finally(() => {
        historyBusy = false;
        if (ownPhotoAnchorPending === pending) ownPhotoAnchorPending = undefined;
      });
      ownPhotoAnchorPending = pending; return pending;
    } } : {};
    const artifact = artifactsEnabled ? { openArtifactTransport(): StandingArtifactTransportLease {
      if (!current() || route !== undefined || historyBusy || activeArtifactLease) throw new ArtifactTransportError({stage:"admission",reason:"selection"});
      // The reservation lasts through send, exact readback and caller close.
      // It does not consume the selected turn's final text/image route.
      historyBusy = true;
      const control = new AbortController(), signal = AbortSignal.any([input.signal,selectionSignal,control.signal]);
      let revoked = false, pending: Promise<unknown> | undefined, closing: Promise<void> | undefined;
      let lease: StandingArtifactTransportLease;
      const leaseCurrent = () => !revoked && current() && route === undefined && activeArtifactLease === lease && historyBusy && !signal.aborted;
      const leaseCheck = () => { if (!leaseCurrent()) throw new ArtifactTransportError({stage:"admission",reason:signal.aborted?"stopped":"selection"}); };
      const track = <T>(work:()=>Promise<T>):Promise<T> => {
        try { leaseCheck(); if (pending) throw new ArtifactTransportError({stage:"admission",reason:"consumed"}); }
        catch (error) { return Promise.reject(error); }
        let done!:(value:T)=>void, failed!:(error:unknown)=>void;
        const actual = new Promise<T>((resolve,reject)=>{done=resolve;failed=reject;}); pending=actual;
        // Invoke synchronously after publishing ownership: the underlying
        // transport snapshots metadata and bytes before its first await.
        try { void work().then(done,failed); } catch(error) { failed(error); }
        void actual.then(()=>{if(pending===actual)pending=undefined;},()=>{if(pending===actual)pending=undefined;});
        return actual;
      };
      const closeLease = ():Promise<void> => {
        if (closing) return closing;
        revoked=true; control.abort();
        closing=Promise.resolve(pending).then(()=>{},()=>{}).then(()=>{
          if(activeArtifactLease===lease){activeArtifactLease=undefined;historyBusy=false;}
        });
        artifactClosings.add(closing);const owned=closing;void owned.then(()=>{artifactClosings.delete(owned);});
        return closing;
      };
      try {
        const media=createStandingArtifactTelegramTransport({client:{invoke:async value=>{
          leaseCheck(); const envelope=await invoke(value); leaseCheck(); return envelope;
        }},binding,peer,self:new Api.User({id:bigInt(binding.accountId),self:true}),selected:primary,signal,isSelectionActive:leaseCurrent,
          revalidatePrimary:async callSignal=>{await typingSettlement;leaseCheck();const fresh=await revalidate(callSignal);leaseCheck();return fresh;}});
        lease=Object.freeze({transport:Object.freeze<StandingArtifactTelegramTransport>({
          sendOnce:(value,callSignal)=>track(()=>media.sendOnce(value,callSignal)),
          readExact:(chatId,messageId,callSignal)=>track(()=>media.readExact(chatId,messageId,callSignal)),
        }),close:closeLease});
        activeArtifactLease=lease;return lease;
      } catch(error) { revoked=true;control.abort();historyBusy=false;throw error; }
    } } : {};
    const actions = actionsEnabled ? { openActions(resolveAvatar?: (artifactRef: string) => StandingSelfProfileImage): BoundActionLease {
      if (!current() || route !== undefined || historyBusy || activeActions) return fail();
      historyBusy = true;
      const control = new AbortController(), signal = AbortSignal.any([input.signal, selectionSignal, control.signal]);
      let revoked = false, closing: Promise<void> | undefined;
      let lease: BoundActionLease;
      const leaseCurrent = () => !revoked && current() && route === undefined && historyBusy && activeActions === lease && !signal.aborted;
      try {
        const underlying = createBoundActionTransportLease({ client: { invoke: async value => {
          if (!leaseCurrent()) return fail("aborted");
          const envelope = await invoke(value);
          if (!leaseCurrent()) return fail("aborted");
          return envelope;
        } }, binding, peer, self: input.self, selected: primary, references: references!, signal,
          ...(resolveAvatar ? { resolveAvatar } : {}),
          isSelectionActive: leaseCurrent, revalidatePrimary: async callSignal => {
            await typingSettlement; if (!leaseCurrent()) return fail("aborted");
            return revalidate(callSignal);
          } });
        lease = Object.freeze({ execute: underlying.execute,
          close(): Promise<void> {
            if (closing) return closing;
            revoked = true; control.abort();
            closing = underlying.close().finally(() => {
              if (activeActions === lease) { activeActions = undefined; historyBusy = false; }
            });
            const owned = closing; actionClosings.add(owned);
            void owned.then(() => actionClosings.delete(owned), () => actionClosings.delete(owned));
            return closing;
          } });
        activeActions = lease; return lease;
      } catch (error) { revoked = true; control.abort(); historyBusy = false; throw error; }
    } } : {};
    const transport: PilotTransport = Object.freeze({
      async sendOnce(reply: PilotSend, signal: AbortSignal) {
        check(signal);
        if (!reply || typeof reply !== "object" || types.isProxy(reply)) return fail();
        const entityField = Object.getOwnPropertyDescriptor(reply,"entities");
        if (entityField && !("value" in entityField)) return fail();
        reply = Object.freeze({ ...reply });
        if (!current() || route !== undefined || reply.chatId !== binding.peerId || reply.replyToMessageId !== candidate.id ||
            typeof reply.text !== "string" || !reply.text.trim() || Buffer.byteLength(reply.text, "utf8") > 4096 || reply.text.includes("\0") ||
            Buffer.from(reply.text, "utf8").toString("utf8") !== reply.text || !/^[1-9]\d{0,18}$/.test(reply.randomId) || BigInt(reply.randomId) >= 2n ** 63n) return fail();
        let entities: readonly TelegramTextEntity[] | undefined;
        let wireEntities: Api.TypeMessageEntity[] = [];
        if (entityField) {
          try { entities=copyTelegramTextEntities(reply.text,entityField.value);wireEntities=toTelegramEntities(reply.text,entities); }
          catch { return fail(); }
        }
        admit("text", signal);
        try {
          try { await revalidate(signal); } catch { close(); throw new PilotPreDispatchError(); }
          const id = await request(new Api.messages.SendMessage({ peer, replyTo: new Api.InputReplyToMessage({ replyToMsgId: candidate.id }),
            message: reply.text, randomId: bigInt(reply.randomId), sendAs: new Api.InputPeerSelf(), noWebpage: true,
            entities: wireEntities, clearDraft: false, allowPaidFloodskip: false }), signal, envelope => extractPilotSentId(envelope, reply.randomId, binding.peerId));
          sentId = id; sentText = reply.text; sentEntities=entities; return { messageId: id };
        } catch (error) { close(); if (error instanceof StandingAdapterError || error instanceof PilotPreDispatchError) throw error; return fail(); }
      },
      async readExact(chatId: string, messageId: number, signal: AbortSignal): Promise<PilotReadback> {
        check(signal);
        if (!current() || route !== "text" || readConsumed || sentId === undefined || messageId !== sentId || chatId !== binding.peerId) return fail();
        readConsumed = true;
        const result = await request(getMessage(messageId), signal, envelope => {
          const message = exactMessage(envelope, binding.peerId, messageId);
          if (!message.out || message.post || !(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== binding.accountId ||
              message.message !== sentText || !(message.replyTo instanceof Api.MessageReplyHeader) || message.replyTo.replyToMsgId !== candidate.id ||
              (message.replyTo.replyToPeerId && !samePeer(message.replyTo.replyToPeerId, binding.peerId))) return fail();
          return Object.freeze({ messageId, chatId: binding.peerId, accountId: binding.accountId, replyToMessageId: candidate.id, text: message.message,
            ...(sentEntities === undefined ? {} : {entities:fromTelegramEntities(message.message,message.entities ?? [])}) });
        });
        initiativeAfter = Math.max(initiativeAfter, now() + initiativeInterval);
        sentText = undefined; sentEntities=undefined; finish(); return result;
      },
    });
    if (!imagesEnabled) return Object.freeze({ transport, ...artifact, ...actions, ...ownPhoto, ...inputPhotos, ...passiveFinish });
    // Forward the already captured sole invoker, not a mutable input.client reference.
    const media = createGeneratedImageTelegramTransport({ client: { invoke: async value => {
      const envelope=await invoke(value);
      try { await observe(envelope,selectionSignal);return envelope; }
      catch(error){discard(envelope);throw error;}
    } }, binding, peer, self: input.self, selected: primary,
      signal: input.signal, isSelectionActive: () => current() && route === "image", revalidatePrimary: revalidate });
    const imageTransport = Object.freeze<GeneratedImageMediaTransport>({
      async sendOnce(value, signal) {
        // This shared admission happens before even the first image upload.
        // Any unknown upload/send consumes the text route as well.
        admit("image", signal);
        try { return await media.sendOnce(value, signal); }
        catch(error) { close(); if(error instanceof GeneratedImageTransportError)throw error;return fail(input.signal.aborted || signal.aborted ? "aborted" : "protocol"); }
      },
      async readExact(chatId, messageId, signal) {
        check(signal); if (!current() || route !== "image") return fail();
        try {
          const result = await media.readExact(chatId, messageId, signal);
          if (result === null) close(); else { initiativeAfter = Math.max(initiativeAfter, now() + initiativeInterval); finish(); }
          return result;
        } catch(error) { close(); if(error instanceof GeneratedImageTransportError)throw error;return fail(input.signal.aborted || signal.aborted ? "aborted" : "protocol"); }
      },
    });
    return Object.freeze({ transport, imageTransport, ...artifact, ...actions, ...ownPhoto, ...inputPhotos, ...passiveFinish });
  }
  /** One completed collection plus at most one candidate. Rejected reply anchors
   * are work remaining, even when removing one empties the queue: a later pulse
   * must collect afresh before it can issue an idle capability. */
  async function pollOne(signal: AbortSignal): Promise<Readonly<{ kind: "selected"; selection: StandingSelection } | { kind: "more" } | { kind: "idle" }>> {
    check(signal);
    if (!initiativeDue() || passive && passive.candidate.id <= cursor) passive = undefined;
    if (continuation && (continuation.candidate.id <= cursor || !anchorFresh(continuation.anchor, continuation.candidate))) continuation = undefined;
    if (!queue.length) {
      if (!passive && !continuation && scannedThrough > cursor) await persist(scannedThrough, signal);
      await collect(signal);
      if (!queue.length && !continuation) {
        if (!initiativeDue()) passive = undefined;
        if (!passive) {
          if (scannedThrough > cursor) await persist(scannedThrough, signal);
          return Object.freeze({ kind: "idle" });
        }
        const at = now();
        if (at < Math.min(passive.changedAt + initiativeDebounce, passive.openedAt + 30_000)) return Object.freeze({ kind: "idle" });
      }
    }
    const continuing = queue.length === 0 ? continuation : undefined;
    const initiative = queue.length === 0 && !continuing;
    const candidate = continuing?.candidate ?? (initiative ? passive!.candidate : queue.shift()!);
    if(consumedAlbum(candidate)){if(initiative)passive=undefined;return Object.freeze({kind:"more"});}
    let anchorIdentity: AnchorIdentity | undefined;
    const proof = !initiative && candidate.trigger === "reply" ? await anchorProof(candidate.replyId!, signal, value => { anchorIdentity = value; }) : undefined;
    if (!initiative && candidate.trigger === "reply" && proof === undefined) {
      if (initiativeDue()) {
        humanReplyProofs.set(candidate.id, candidate.proof);
        if (humanReplyProofs.size > 100) humanReplyProofs.delete(humanReplyProofs.keys().next().value!);
        rememberPassive(candidate);
      }
      return Object.freeze({ kind: "more" });
    }
    const read = await readCandidate(candidate, signal, true);
    if (!read) {
      // No model/send attempt exists yet. Consume only this authentic obsolete
      // source; a following queued request remains available on the same client.
      if (continuing) continuation = undefined;
      if (initiative) passive = undefined;
      await persist(candidate.id, signal);
      return Object.freeze({ kind: "more" });
    }
    const primary = read.primary;
    let photoAnchor: Readonly<{ id: number; proof: string }> | undefined;
    let context = await contextFor(read.contextPrimary, read.link, proof, signal,
      artifactsEnabled && !read.scheduled && read.link.status === "bound" ? value => { photoAnchor = value; } : undefined, anchorIdentity);
    if (!context) { await persist(candidate.id, signal); return Object.freeze({ kind: "more" }); }
    if (continuing) {
      if (!anchorFresh(continuing.anchor, candidate) || await anchorProof(continuing.anchor.message.messageId, signal) !== continuing.anchor.proof) {
        continuation = undefined; return Object.freeze({ kind: "more" });
      }
      const own = continuing.anchor.message;
      // Preserve the authentic unthreaded relationship. The model sees the own
      // invitation as recent evidence, never as a fabricated reply ancestor.
      context = Object.freeze({ ...context, recent: Object.freeze([...context.recent.filter(value => value.messageId !== own.messageId).slice(-(STANDING_CONTEXT_WINDOW_LIMIT - 1)), own].sort((a,b) => a.messageId-b.messageId)) });
    }
    if (initiative && !initiativeDue()) { passive = undefined; return Object.freeze({ kind: "more" }); }
    if (input.checkpointQuestion) {
      try { await input.checkpointQuestion(primary, context); } catch { return fail("checkpoint"); }
      check(signal);
    }
    await persist(candidate.id, signal);
    if(candidate.albumKey!==undefined){consumedAlbums.add(candidate.albumKey);if(consumedAlbums.size>32)consumedAlbums.delete(consumedAlbums.values().next().value!);}
    active = true; typingSelection = candidate.id;
    if (continuing) continuation = undefined;
    if (initiative) { initiativeAfter = now() + initiativeInterval; passive = undefined; humanReplyProofs.clear(); }
    else if (passive && (passive.candidate.id <= cursor || consumedAlbum(passive.candidate))) passive = undefined;
    return Object.freeze({ kind: "selected", selection: Object.freeze({ primary, context, ...(initiative ? { initiative: true as const } : {}), ...(continuing ? { continuation: true as const } : {}), ...transportsFor(candidate, primary, proof, signal, photoAnchor, initiative, context, continuing?.anchor),
      cursor, pulseTyping: typingFor(candidate, signal) }) });
  }
  function idleHistoryTicket(): StandingIdleHistoryTicket {
    const identity = Symbol("standing-idle-history"); idleTicketIdentity = identity;
    return Object.freeze({ openTaskReply(value): StandingTaskReplyLease {
      if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
      const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
      if (keys.length !== 2 || !["intent", "signal"].every(k => Object.hasOwn(ds, k)) ||
          keys.some(k => typeof k !== "string" || !("value" in ds[k]!) || !ds[k]!.enumerable)) return fail();
      let intent: StandingHistoryTaskIntent;
      try { intent = snapshotStandingHistoryTaskIntent(ds.intent!.value); } catch { return fail(); }
      const taskSignal: unknown = ds.signal!.value;
      if (types.isProxy(taskSignal) || !(taskSignal instanceof AbortSignal)) return fail();
      if (intent.accountId !== binding.accountId || intent.chatId !== binding.peerId || intent.requesterId === binding.accountId) return fail("binding");
      if (closed || input.signal.aborted) { close(); return fail("aborted"); }
      if (busy || active || historyBusy || activeIdleHistory || activeTaskReply) return fail();
      if (idleTicketIdentity !== identity || taskSignal.aborted) return fail("aborted");
      idleTicketIdentity = undefined; historyBusy = true;
      const control = new AbortController(), signal = AbortSignal.any([input.signal, taskSignal, control.signal]);
      let revoked = false, sendConsumed = false, readConsumed = false, pending: Promise<unknown> | undefined, closing: Promise<void> | undefined;
      let sentId: number | undefined, sentText: string | undefined, sentEntities: readonly TelegramTextEntity[] | undefined;
      let lease: StandingTaskReplyLease;
      const localCheck = (callSignal?: AbortSignal) => {
        if (closed || input.signal.aborted) { close(); return fail("aborted"); }
        if (revoked || signal.aborted || callSignal?.aborted || active || busy || activeTaskReply !== lease || !historyBusy) return fail("aborted");
      };
      const callSignalCopy = (value: unknown): AbortSignal => {
        if (types.isProxy(value) || !(value instanceof AbortSignal)) return fail();
        localCheck(value); return value;
      };
      async function waitForTaskRead(callSignal: AbortSignal): Promise<void> {
        localCheck(callSignal); let at = now();
        if (!Number.isFinite(at) || lastHistory !== undefined && at < lastHistory) return fail();
        while (lastHistory !== undefined && at - lastHistory < 3000) {
          const previous = at;
          try { await wait(Math.max(1, Math.ceil(3000 - (at - lastHistory))), callSignal); }
          catch { localCheck(callSignal); return fail("transport"); }
          localCheck(callSignal); at = now();
          if (!Number.isFinite(at) || at <= previous) return fail();
        }
        localCheck(callSignal); lastHistory = at;
      }
      async function taskRequest<T>(requestValue: Api.AnyRequest, callSignal: AbortSignal, parse: (value: unknown) => T): Promise<T> {
        localCheck(callSignal); let envelope: unknown;
        try {
          try { envelope = await invoke(requestValue); }
          catch (error) { localCheck(callSignal); return fail(invokeFailure(error)); }
          localCheck(callSignal); return parse(envelope);
        } finally {
          // This exact old anchor/readback is not foreground discovery. Do not
          // advance or re-observe the ordinary source cursor through this lease.
          discard(envelope);
        }
      }
      const stopTask = () => { void lease.close(); }, stopAll = () => { close(); };
      function operation<T>(callSignal: AbortSignal, work: (combined: AbortSignal) => Promise<T>): Promise<T> {
        localCheck(callSignal); if (pending) return Promise.reject(new StandingAdapterError("protocol"));
        const combined = AbortSignal.any([signal, callSignal]);
        callSignal.addEventListener("abort", stopTask, { once: true });
        const owned = Promise.resolve().then(async () => { await typingSettlement; localCheck(combined); return work(combined); });
        pending = owned;
        void owned.finally(() => { callSignal.removeEventListener("abort", stopTask); if (pending === owned) pending = undefined; }).catch(() => {});
        return owned;
      }
      const transport: PilotTransport = Object.freeze({
        sendOnce(value: PilotSend, suppliedSignal: AbortSignal): Promise<{ messageId: number }> {
          try {
            const callSignal = callSignalCopy(suppliedSignal);
            if (sendConsumed || pending || !value || typeof value !== "object" || types.isProxy(value) ||
                ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return Promise.reject(new StandingAdapterError("protocol"));
            const fields = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(fields);
            if (!["chatId", "replyToMessageId", "text", "randomId"].every(k => Object.hasOwn(fields, k)) || names.some(k => typeof k !== "string" ||
                !["chatId", "replyToMessageId", "text", "randomId", "entities"].includes(k) || !("value" in fields[k]!) || !fields[k]!.enumerable)) return fail();
            const reply = Object.fromEntries(names.map(k => [k, fields[k as string]!.value]));
            if (reply.chatId !== binding.peerId || reply.replyToMessageId !== intent.primaryMessageId || typeof reply.text !== "string" || !reply.text.trim() ||
                Buffer.byteLength(reply.text, "utf8") > 4096 || reply.text.includes("\0") || Buffer.from(reply.text, "utf8").toString("utf8") !== reply.text ||
                typeof reply.randomId !== "string" || !/^[1-9]\d{0,18}(?![\s\S])/.test(reply.randomId) || BigInt(reply.randomId) >= 2n ** 63n) return fail();
            if (fields.entities && fields.entities.value === undefined) return fail();
            const entities = fields.entities ? copyTelegramTextEntities(reply.text, fields.entities.value!) : undefined;
            const wireEntities = entities === undefined ? [] : toTelegramEntities(reply.text, entities);
            const text = reply.text, randomId = reply.randomId;
            sendConsumed = true;
            return operation(callSignal, async combined => {
              await waitForTaskRead(combined);
              await taskRequest(getMessage(intent.primaryMessageId), combined, envelope => {
                const message = exactMessage(envelope, binding.peerId, intent.primaryMessageId), batch = envelope as Batch;
                if (message.out || message.post || !(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== intent.requesterId ||
                    !Number.isSafeInteger(message.date) || message.date <= 0) return fail("binding");
                const authors = batch.users.filter(user => user.id.toString() === intent.requesterId);
                if (authors.length !== 1 || !(authors[0] instanceof Api.User) || authors[0].bot || authors[0].deleted || authors[0].self) return fail("binding");
                // Task identity survives edits of the original body. No new
                // trigger, objective or foreground selection is inferred here.
              });
              const id = await taskRequest(new Api.messages.SendMessage({ peer, replyTo: new Api.InputReplyToMessage({ replyToMsgId: intent.primaryMessageId }),
                message: text, randomId: bigInt(randomId), sendAs: new Api.InputPeerSelf(), noWebpage: true,
                entities: wireEntities, clearDraft: false, allowPaidFloodskip: false }), combined,
              envelope => extractPilotSentId(envelope, randomId, binding.peerId));
              localCheck(combined); sentId = id; sentText = text; sentEntities = entities; return { messageId: id };
            });
          } catch (error) { return Promise.reject(error instanceof StandingAdapterError ? error : new StandingAdapterError("protocol")); }
        },
        readExact(chatId: string, messageId: number, suppliedSignal: AbortSignal): Promise<PilotReadback> {
          try {
            const callSignal = callSignalCopy(suppliedSignal);
            if (pending || readConsumed || sentId === undefined || messageId !== sentId || chatId !== binding.peerId) return fail();
            readConsumed = true;
            return operation(callSignal, async combined => {
              await waitForTaskRead(combined);
              const result = await taskRequest(getMessage(messageId), combined, envelope => {
                const message = exactMessage(envelope, binding.peerId, messageId);
                if (!message.out || message.post || !(message.fromId instanceof Api.PeerUser) || message.fromId.userId.toString() !== binding.accountId ||
                    message.message !== sentText || !(message.replyTo instanceof Api.MessageReplyHeader) || message.replyTo.replyToScheduled ||
                    message.replyTo.replyToMsgId !== intent.primaryMessageId || (message.replyTo.replyToPeerId && !samePeer(message.replyTo.replyToPeerId, binding.peerId))) return fail();
                return Object.freeze({ messageId, chatId: binding.peerId, accountId: binding.accountId, replyToMessageId: intent.primaryMessageId, text: message.message,
                  ...(sentEntities === undefined ? {} : { entities: fromTelegramEntities(message.message, message.entities ?? []) }) });
              });
              localCheck(combined); sentText = undefined; sentEntities = undefined; return result;
            });
          } catch (error) { return Promise.reject(error instanceof StandingAdapterError ? error : new StandingAdapterError("protocol")); }
        }
      });
      lease = Object.freeze({ transport, close(): Promise<void> {
        if (closing) return closing;
        revoked = true; control.abort();
        closing = Promise.resolve(pending).then(() => {}, () => {}).finally(() => {
          taskSignal.removeEventListener("abort", stopTask); input.signal.removeEventListener("abort", stopAll);
          sentText = undefined; sentEntities = undefined;
          if (activeTaskReply === lease) { activeTaskReply = undefined; historyBusy = false; }
        });
        const owned = closing; taskReplyClosings.add(owned);
        void owned.then(() => taskReplyClosings.delete(owned), () => taskReplyClosings.delete(owned)); return closing;
      } });
      activeTaskReply = lease;
      taskSignal.addEventListener("abort", stopTask, { once: true }); input.signal.addEventListener("abort", stopAll, { once: true });
      return lease;
    }, openHistoryTask(value): StandingIdleHistoryLease {
      // Validate host-owned scope inertly before consuming this ticket. The task
      // store and service own authority; no raw checkpoint enters a model tool.
      if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new SelfHistoryReaderError("input");
      const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
      if (!["intent", "signal"].every(k => Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !["intent", "signal", "checkpoint"].includes(k) || !("value" in ds[k]!) || !ds[k]!.enumerable)) throw new SelfHistoryReaderError("input");
      let intent: StandingHistoryTaskIntent, saved: SelfHistoryTaskCheckpoint | undefined;
      try { intent = snapshotStandingHistoryTaskIntent(ds.intent!.value); saved = ds.checkpoint ? snapshotSelfHistoryTaskCheckpoint(ds.checkpoint.value) : undefined; }
      catch { throw new SelfHistoryReaderError("input"); }
      const taskSignal: unknown = ds.signal!.value;
      if (types.isProxy(taskSignal) || !(taskSignal instanceof AbortSignal)) throw new SelfHistoryReaderError("input");
      if (intent.accountId !== binding.accountId || intent.chatId !== binding.peerId || saved && (saved.accountId !== intent.accountId || saved.chatId !== intent.chatId)) throw new SelfHistoryReaderError("binding");
      if (saved && (saved.fromDate !== intent.fromDate || saved.toDate !== intent.toDate || saved.status !== "more")) throw new SelfHistoryReaderError("input");
      if (closed || input.signal.aborted) { close(); throw new SelfHistoryReaderError("aborted"); }
      if (busy || active || historyBusy || activeIdleHistory) throw new SelfHistoryReaderError("busy");
      if (idleTicketIdentity !== identity || taskSignal.aborted) throw new SelfHistoryReaderError("aborted");
      idleTicketIdentity = undefined; historyBusy = true;
      const control = new AbortController(), signal = AbortSignal.any([input.signal, taskSignal, control.signal]);
      let revoked = false, consumed = false, pending: Promise<SelfHistoryTaskPage> | undefined, closing: Promise<void> | undefined;
      let reader: ReturnType<typeof createSelfHistoryReader> | undefined, lease: StandingIdleHistoryLease;
      const localCheck = () => {
        if (closed || input.signal.aborted) { close(); throw new SelfHistoryReaderError("aborted"); }
        if (revoked || signal.aborted || active || busy || activeIdleHistory !== lease || !historyBusy) throw new SelfHistoryReaderError("aborted");
      };
      async function waitForIdleHistory(): Promise<void> {
        localCheck(); let at = now();
        if (!Number.isFinite(at) || lastHistory !== undefined && at < lastHistory) throw new SelfHistoryReaderError("protocol");
        while (lastHistory !== undefined && at - lastHistory < 3000) {
          const previous = at;
          // Never pass task cancellation to the foreground check-close helper.
          try { await wait(Math.max(1, Math.ceil(3000 - (at - lastHistory))), signal); }
          catch { localCheck(); throw new SelfHistoryReaderError("transport"); }
          localCheck(); at = now();
          if (!Number.isFinite(at) || at <= previous) throw new SelfHistoryReaderError("protocol");
        }
        localCheck(); lastHistory = at;
      }
      const stopTask = () => { void lease.close(); }, stopAll = () => { close(); };
      try {
        reader = createSelfHistoryReader({ client: { invoke: async requestValue => {
          localCheck(); await waitForIdleHistory(); localCheck(); let envelope: unknown;
          try {
            envelope = await invoke(requestValue); localCheck();
            // Persisting all fetched rows through sourceObserver here would
            // pre-observe byte-omitted rows. Only consumed task sources return.
            return envelope;
          } catch (error) { discard(envelope); throw error; }
        } }, peer, binding, self: input.self, signal, ...(references ? { references } : {}) });
        lease = Object.freeze({ readTaskPage(): Promise<SelfHistoryTaskPage> {
          try { localCheck(); if (consumed) throw new SelfHistoryReaderError("busy"); }
          catch (error) { return Promise.reject(error); }
          consumed = true;
          pending = Promise.resolve().then(async () => {
            await typingSettlement; localCheck();
            const page = await reader!.readTaskPage({ fromDate: intent.fromDate, toDate: intent.toDate, ...(saved ? { checkpoint: saved } : {}) });
            localCheck(); return page;
          });
          return pending;
        }, close(): Promise<void> {
          if (closing) return closing;
          revoked = true; control.abort(); reader?.close();
          closing = Promise.resolve(pending).then(() => {}, () => {}).finally(() => {
            taskSignal.removeEventListener("abort", stopTask); input.signal.removeEventListener("abort", stopAll);
            if (activeIdleHistory === lease) { activeIdleHistory = undefined; historyBusy = false; }
          });
          const owned = closing; idleHistoryClosings.add(owned);
          void owned.then(() => idleHistoryClosings.delete(owned), () => idleHistoryClosings.delete(owned)); return closing;
        } });
        activeIdleHistory = lease;
        taskSignal.addEventListener("abort", stopTask, { once: true }); input.signal.addEventListener("abort", stopAll, { once: true });
        return lease;
      } catch (error) { revoked = true; control.abort(); reader?.close(); historyBusy = false; throw error; }
    } });
  }
  async function poll(signal: AbortSignal, backgroundDue: boolean): Promise<StandingPollWork> {
      check(signal); if (busy || active || historyBusy || activeIdleHistory) return fail();
      idleTicketIdentity = undefined; busy = true;
      try {
        // Only the host owns scheduling credit. Yield before touching queued
        // candidates or their checkpoints; this is not an assertion of idle.
        if (backgroundDue) return Object.freeze({ kind: "background", ticket: idleHistoryTicket() });
        const result = await pollOne(signal); return result.kind === "idle" ? Object.freeze({ kind: "idle", ticket: idleHistoryTicket() }) : result;
      }
      catch (error) { close(); if (error instanceof StandingAdapterError) throw error; return fail(); }
      finally { busy = false; }
  }
  return Object.freeze({ close, closeCapabilities,
    ...(selfHistory ? { selfHistory } : {}), ...(extraTools ? { extraTools } : {}),
    async pollNext(signal: AbortSignal): Promise<StandingPollNext> {
      return await poll(signal, false) as StandingPollNext;
    },
    async pollWork(signal: AbortSignal, options: Readonly<{ backgroundDue: boolean }>): Promise<StandingPollWork> {
      idleTicketIdentity = undefined;
      if (!options || typeof options !== "object" || types.isProxy(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) return fail();
      const ds = Object.getOwnPropertyDescriptors(options);
      if (Reflect.ownKeys(ds).length !== 1 || !ds.backgroundDue || !("value" in ds.backgroundDue) || !ds.backgroundDue.enumerable || typeof ds.backgroundDue.value !== "boolean") return fail();
      return poll(signal, ds.backgroundDue.value);
    },
    /** Compatibility blocking loop. Idle-only background admission cannot prove
     * fairness under a perpetually addressed queue; a future scheduler owns it. */
    async next(signal: AbortSignal): Promise<StandingSelection> {
      check(signal); if (busy || active || historyBusy || activeIdleHistory) return fail();
      idleTicketIdentity = undefined; busy = true;
      try { for (;;) { const result = await pollOne(signal); if (result.kind === "selected") return result.selection; } }
      catch (error) { close(); if (error instanceof StandingAdapterError) throw error; return fail(); }
      finally { busy = false; }
    },
  });
}
