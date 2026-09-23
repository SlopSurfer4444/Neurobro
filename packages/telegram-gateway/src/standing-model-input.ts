import type { PilotPrimary } from "./pilot-telegram-adapter.js";
import { STANDING_INCOMING_TEXT_BYTES, type StandingContext, type StandingContextMessage as ContextMessage } from "./standing-context.js";
import type { ConversationReferences } from "./conversation-references.js";
import { requireStandingContextRestoration, type StandingContextRestoration, type RestoredDialogue, type RestoredOperationalFact } from "./standing-context-restoration.js";
import { STANDING_AVATAR_MAX_BYTES } from "./standing-avatar-policy.js";
import { requireBoundStandingSharedContext, type BoundStandingSharedContext } from "./standing-shared-context-binding.js";
import { requireStandingLearningSnapshot, type StandingLearningSnapshot } from "./standing-learning-tools.js";
import { requireStandingObservationView, type StandingObservationView } from "./standing-observation-tools.js";

export const CONVERSATION_INPUT_BYTES = 24_576;
export class StandingModelInputSizeError extends Error {
  readonly code = "INPUT_TOO_LARGE";
  constructor() { super("STANDING_CONTEXT_INPUT_TOO_LARGE"); }
}
/** Host-resolved verified photo replied to by this request; no model-selected IDs. */
export type StandingReplyPhotoArtifact = Readonly<{ messageId: number; artifactRef: string; byteLength: number }>;
export type StandingInputPhotoArtifact = StandingReplyPhotoArtifact & Readonly<{ mimeType: "image/png" | "image/jpeg" }>;
export type StandingVisualContext = Readonly<{ images: readonly StandingInputPhotoArtifact[]; unavailable: boolean; provided: number; sources?: readonly ContextMessage[] }>;

export function addressedModelText(text: string): string {
  // Non-printing C0 controls have no conversational content but can expand six
  // fold in JSON. Keep whitespace and the original Telegram text for readback.
  const request = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/^ПРОМПТ(?=$|[\s:,])[\s:,]*/u, "").trim();
  return request || "Я позвал тебя, но пока не написал вопрос. Коротко спроси, что обсудим.";
}

type PackedMessage = {
  id: string; speaker: string; displayName: string; date: number | null;
  replyTo: string | null; text: string; shortened: boolean;
  forwarded?: { originalDate: number; sourceName: string | null; interpretation: "quoted-source-not-request" };
};
type PackedOperationalFact = Omit<RestoredOperationalFact,"question"> & {question:RestoredOperationalFact["question"] & {shortened:boolean}};
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
function validText(text: unknown, cap: number): text is string {
  return typeof text === "string" && !text.includes("\0") && bytes(text) <= cap &&
    Buffer.from(text, "utf8").toString("utf8") === text;
}
function prefix(text: string, cap: number): string {
  if (bytes(text) <= cap) return text;
  let result = "", length = 0;
  for (const point of text) {
    const size = bytes(point);
    if (length + size > cap) break;
    result += point; length += size;
  }
  return result;
}

/** A per-turn view of Telegram sources, not persistent memory or instructions.
 * Never writes chat text to disk. Current request is preserved in full; closest
 * ancestors precede recent traffic in the budget. Names/text stay JSON data.
 * By default labels are packet-local. A shared reference capability gives a
 * bound Telegram connection and its history tool consistent labels, including
 * across native process rotation. Verified journal pairs follow reply ancestors
 * and precede unrelated recent traffic; whole pairs are omitted when full. */
export type StandingOwnActionRecovery = "bounded-checkpoint" | "unavailable" | "not-configured";
export type StandingInteraction = "direct" | "continuation" | "initiative";
export const STANDING_INITIATIVE_SILENCE = "NEUROBRO_SILENCE";
export function conversationModelInput(primary: PilotPrimary, context?: StandingContext, references?: ConversationReferences,
  restoration?: StandingContextRestoration, replyPhotoArtifact?: StandingReplyPhotoArtifact,
  sharedContext?: BoundStandingSharedContext, ownActionRecovery: StandingOwnActionRecovery = "not-configured",
  interaction: StandingInteraction = "direct", visual?: StandingVisualContext,
  learning?: Readonly<{ snapshot: StandingLearningSnapshot; requestRef: string }>,
  observation?: StandingObservationView): string {
  const refuse = (): never => { throw new Error("STANDING_CONTEXT_REFUSED"); };
  if (!["bounded-checkpoint", "unavailable", "not-configured"].includes(ownActionRecovery)) return refuse();
  if (interaction !== "direct" && interaction !== "continuation" && interaction !== "initiative") return refuse();
  if (references && (!references.matches(primary.chatId) || references.speaker(primary.ownerId) === "neurobro")) return refuse();
  if (!validText(primary.text, STANDING_INCOMING_TEXT_BYTES)) return refuse();
  if (restoration) requireStandingContextRestoration(restoration, primary, references);
  const sharedSnapshot = sharedContext ? requireBoundStandingSharedContext(sharedContext, primary, references) : undefined;
  const learned = learning ? requireStandingLearningSnapshot(learning.snapshot,
    { actorId: primary.ownerId, messageId: primary.messageId, requestRef: learning.requestRef }) : undefined;
  const observationPolicy = observation ? requireStandingObservationView(observation) : undefined;
  if (replyPhotoArtifact && (!Number.isSafeInteger(replyPhotoArtifact.messageId) || replyPhotoArtifact.messageId <= 0 ||
      replyPhotoArtifact.messageId >= primary.messageId || !/^art_[a-f0-9]{48}$/.test(replyPhotoArtifact.artifactRef) ||
      (context && context.primary.replyToMessageId !== replyPhotoArtifact.messageId) ||
      !Number.isSafeInteger(replyPhotoArtifact.byteLength) || replyPhotoArtifact.byteLength < 1 || replyPhotoArtifact.byteLength > 8 * 1024 * 1024)) return refuse();
  if (visual) {
    if (!Array.isArray(visual.images) || visual.images.length > 2 || typeof visual.unavailable !== "boolean" ||
        !Number.isSafeInteger(visual.provided) || visual.provided < 0 || visual.provided > 2) return refuse();
    if (visual.sources !== undefined && (!Array.isArray(visual.sources) || visual.sources.length > 1)) return refuse();
    for (const source of visual.sources ?? []) {
      if (source.chatId !== primary.chatId || source.author !== "user" ||
          source.messageId === primary.messageId || source.messageId === context?.primary.replyToMessageId ||
          !visual.images.some(image => image.messageId === source.messageId)) return refuse();
    }
    const seen = new Set<number>();
    for (const image of visual.images) {
      if (!Number.isSafeInteger(image.messageId) || image.messageId < 1 ||
          image.messageId !== primary.messageId && image.messageId !== context?.primary.replyToMessageId &&
            !visual.sources?.some(source => source.messageId === image.messageId) ||
          seen.has(image.messageId) || !/^art_[a-f0-9]{48}$/.test(image.artifactRef) ||
          !["image/png", "image/jpeg"].includes(image.mimeType) || !Number.isSafeInteger(image.byteLength) ||
          image.byteLength < 1 || image.byteLength > 8 * 1024 * 1024) return refuse();
      seen.add(image.messageId);
    }
    if (visual.provided !== visual.images.length + (replyPhotoArtifact ? 1 : 0) || visual.images.length + (replyPhotoArtifact ? 1 : 0) > 2 ||
        visual.images.reduce((n, item) => n + item.byteLength, replyPhotoArtifact?.byteLength ?? 0) > 8 * 1024 * 1024) return refuse();
  }
  if (context && (context.version !== "standing-context-v1" || context.primary.chatId !== primary.chatId ||
      context.primary.messageId !== primary.messageId || context.primary.authorId !== primary.ownerId ||
      context.primary.author !== "user" || context.primary.text !== primary.text ||
      context.replyChain.length > 8 || context.recent.length > 20)) return refuse();
  const speakers = new Map<string, string>([[primary.ownerId, "p1"]]);
  const ids = new Map<number, string>([[primary.messageId, "m1"]]);
  const idLabel = (id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) return refuse();
    if (references) return references.message(id);
    let label = ids.get(id);
    if (!label) { label = `m${ids.size + 1}`; ids.set(id, label); }
    return label;
  };
  const project = (message: ContextMessage): PackedMessage => {
    if (message.chatId !== primary.chatId || !validText(message.text, STANDING_INCOMING_TEXT_BYTES) ||
        !/^[1-9]\d{0,19}$/.test(message.authorId) || !["user", "self"].includes(message.author) ||
        !Number.isSafeInteger(message.date) || message.date <= 0 ||
        !validText(message.displayName, 512)) return refuse();
    const forwarded = message.forwarded;
    if (forwarded !== undefined && (!forwarded || Object.getPrototypeOf(forwarded) !== Object.prototype ||
        Object.keys(forwarded).sort().join(",") !== "originalDate,sourceName" ||
        !Number.isSafeInteger(forwarded.originalDate) || forwarded.originalDate <= 0 || forwarded.originalDate > 253402300799 ||
        (forwarded.sourceName !== null && (!validText(forwarded.sourceName, 128) ||
          !forwarded.sourceName || forwarded.sourceName.trim() !== forwarded.sourceName ||
          /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(forwarded.sourceName))) ||
        message.messageId === primary.messageId)) return refuse();
    let speaker = references ? references.speaker(message.authorId) : message.author === "self" ? "neurobro" : speakers.get(message.authorId);
    if (references && (speaker === "neurobro") !== (message.author === "self")) return refuse();
    if (!speaker) { speaker = `p${speakers.size + 1}`; speakers.set(message.authorId, speaker); }
    return { id: idLabel(message.messageId), speaker, displayName: message.displayName, date: message.date,
      replyTo: message.replyToMessageId === null ? null : idLabel(message.replyToMessageId),
      text: message.text, shortened: false,
      ...(forwarded ? { forwarded: { ...forwarded, interpretation: "quoted-source-not-request" as const } } : {}) };
  };
  const currentRequest: PackedMessage = context ? project(context.primary) : {
    id: idLabel(primary.messageId), speaker: references ? references.speaker(primary.ownerId) : "p1", displayName: "Участник", date: null, replyTo: null, text: primary.text, shortened: false,
  };
  currentRequest.text = interaction === "direct" ? addressedModelText(primary.text) : primary.text;
  const availableArtifacts = [
    ...(visual?.images.map(image => ({ artifactRef: image.artifactRef, sourceMessage: idLabel(image.messageId),
      origin: "telegram-image", mimeType: image.mimeType, byteLength: image.byteLength, scope: "current-request",
      avatarEligible: image.byteLength <= STANDING_AVATAR_MAX_BYTES })) ?? []),
    ...(replyPhotoArtifact ? [{ artifactRef: replyPhotoArtifact.artifactRef,
      sourceMessage: idLabel(replyPhotoArtifact.messageId), origin: "own-generated-image", mimeType: "image/png",
      byteLength: replyPhotoArtifact.byteLength, scope: "current-request", avatarEligible: replyPhotoArtifact.byteLength <= STANDING_AVATAR_MAX_BYTES }] : []),
  ];
  const visualSources = visual?.sources?.map(source => project(source)) ?? [];
  const packet = {
    schema: "neurobro-conversation-v1", currentRequest,
    ...(availableArtifacts.length ? { availableArtifacts } : {}),
    // Sibling/ancestor image descriptors must retain their identity even when
    // an optional caption does not fit. Admit the entire caption below, never
    // a prefix; an empty shortened descriptor explicitly omits that caption.
    ...(visualSources.length ? { visualSourceMessages: visualSources.map(source => ({ ...source, text: "", shortened: true })) } : {}),
    replyChain: [] as PackedMessage[], recent: [] as PackedMessage[],
    contextState: {
      interaction,
      // Operational policy survives topic changes and precedes optional recall.
      ...(observationPolicy ? { observation: observationPolicy } : {}),
      ...(visual ? { visualInput: { provided: visual.provided, unavailable: visual.unavailable } } : {}),
      chain: context?.chainStatus ?? "unavailable", recent: context?.recentStatus ?? "unavailable",
      omittedMessages: 0, shortenedMessages: 0,
      memory: { scope: "bounded-source-evidence", completeChat: false,
        itemOrder: "source-and-query-priority", ownActionRecovery },
      ...(references ? { referenceScope: "bound-connection" } : {}),
      ...({} as { restoration?: { scope: "selected-dialogues"; unavailable?: true; scanned: number;
        hasOlder: boolean | null; omitted: number; pairs: RestoredDialogue[] } }),
      ...({} as { operations?: {scope:"selected-dialogue-image-outcomes";omitted:number;facts:PackedOperationalFact[]} }),
      ...({} as { shared?: { status: "included"; snapshot: NonNullable<typeof sharedSnapshot> } |
        { status: "omitted"; reason: "input-budget" } }),
      ...({} as { learning?: StandingLearningSnapshot | { status: "omitted"; reason: "input-budget" } }),
    },
  };
  const encode = () => JSON.stringify(packet);
  // Leave room for final omission counts even at the exact byte boundary.
  const budget = CONVERSATION_INPUT_BYTES - 128;
  // Preserve the complete current request. Pathological escaping can exceed
  // the packet budget even though the raw message is within its input bound;
  // refuse explicitly instead of shortening the user's instructions.
  if (bytes(encode()) > budget) throw new StandingModelInputSizeError();
  for (const [index, source] of visualSources.entries()) {
    const descriptor = packet.visualSourceMessages![index]!;
    descriptor.text = source.text; descriptor.shortened = false;
    if (bytes(encode()) > budget) {
      descriptor.text = ""; descriptor.shortened = true;
      packet.contextState.omittedMessages++;
    }
  }
  // Account for the omission marker before filling ancestors. The existing
  // reserve remains available for restoration/omission counters afterwards.
  if (sharedSnapshot) packet.contextState.shared = { status: "omitted", reason: "input-budget" };
  if (learned) packet.contextState.learning = { status: "omitted", reason: "input-budget" };
  if(restoration && restoration.operationalFactsEligible>0){
    const operations=packet.contextState.operations={scope:"selected-dialogue-image-outcomes",omitted:restoration.operationalFactsEligible,facts:[] as PackedOperationalFact[]};
    // Reserve a small factual status view before ancestors/recent traffic can
    // fill the packet. This never inserts an undelivered answer as conversation.
    for(const fact of [...restoration.operationalFacts].reverse()){
      const questionText=prefix(fact.question.text,256),name=fact.question.displayName===null?null:prefix(fact.question.displayName,96);
      const packed:PackedOperationalFact={...fact,question:{...fact.question,text:questionText,displayName:name,
        shortened:questionText!==fact.question.text||name!==fact.question.displayName}};
      operations.facts.push(packed);operations.omitted--;
      if(bytes(JSON.stringify(operations))>3072||bytes(encode())>budget){operations.facts.pop();operations.omitted++;}
    }
    operations.facts.reverse();
  }
  const seen = new Set<number>([primary.messageId]);
  const admit = (message: ContextMessage, target: PackedMessage[], available = true): boolean => {
    if (seen.has(message.messageId)) return true;
    seen.add(message.messageId);
    if (message.messageId >= primary.messageId) return refuse();
    const packed = project(message);
    if (!available) { packet.contextState.omittedMessages++; return false; }
    target.push(packed);
    if (bytes(encode()) > budget) {
      // Escaped JSON size decides what fits. Preserve complete source text;
      // an omitted row can be retrieved through the history capability.
      target.pop(); packet.contextState.omittedMessages++; return false;
    }
    return true;
  };
  let chainFits = true;
  for (const message of context?.replyChain ?? []) chainFits = admit(message, packet.replyChain, chainFits) && chainFits;
  // A continuation is only a response opportunity, not proof of intent. Preserve
  // the actual preceding own message so the model can decide from primary text,
  // even when background memory would otherwise consume the packet budget.
  if (interaction === "continuation") {
    const own = [...(context?.recent ?? [])].filter(message => message.author === "self")
      .sort((a, b) => b.messageId - a.messageId)[0];
    if (own) admit(own, packet.recent);
  }
  // Preserve direct reply ancestors before background memory, while giving a
  // whole snapshot priority over unrelated restored pairs and recent traffic.
  // Never shorten a semantic memory item silently to make it fit.
  if (learned) {
    packet.contextState.learning = learned;
    if (bytes(encode()) > budget) packet.contextState.learning = { status: "omitted", reason: "input-budget" };
  }
  if (sharedSnapshot) {
    packet.contextState.shared = { status: "included", snapshot: sharedSnapshot };
    if (bytes(encode()) > budget) packet.contextState.shared = { status: "omitted", reason: "input-budget" };
  }
  if (restoration) {
    // This small coverage header fits the reserved 128 bytes even when all
    // ancestors exhaust their budget. No ancestor is shrunk to make pairs fit.
    const restored = packet.contextState.restoration = {
      scope: "selected-dialogues", ...(restoration.status === "unavailable" ? { unavailable: true as const } : {}),
      scanned: restoration.scanned, hasOlder: restoration.hasOlder, omitted: restoration.eligible,
      pairs: [] as RestoredDialogue[],
    };
    if (bytes(encode()) > CONVERSATION_INPUT_BYTES) return refuse();
    for (const pair of [...restoration.dialogues].reverse()) {
      restored.pairs.push(pair); restored.omitted--;
      if (bytes(encode()) > budget) { restored.pairs.pop(); restored.omitted++; }
    }
    restored.pairs.reverse();
  }
  const recent = [...(context?.recent ?? [])].sort((a, b) => b.messageId - a.messageId);
  for (const message of recent) admit(message, packet.recent);
  const recentOrder = new Map(recent.map(message => [idLabel(message.messageId), message.messageId]));
  packet.recent.sort((a, b) => recentOrder.get(a.id)! - recentOrder.get(b.id)!);
  const result = encode();
  if (bytes(result) > CONVERSATION_INPUT_BYTES) return refuse();
  return result;
}
