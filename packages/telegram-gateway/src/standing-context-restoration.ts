import type { ConversationReferences } from "./conversation-references.js";
import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { JournalDialogue, StandingDialogueJournal } from "./standing-dialogue-journal.js";
import { STANDING_INCOMING_TEXT_BYTES } from "./standing-context.js";

export type RestoredDialogue = Readonly<{
  provenance: "verified-model-outcome-in-selected-dialogue-journal";
  recordedAt: number;
  question: Readonly<{ id: string; speaker: string; displayName: string | null; date: number | null; text: string }>;
  // The journal proves delivery but does not retain the answer's Telegram ID or date.
  answer: Readonly<{ speaker: "neurobro"; telegramMessageId: null; date: null; text: string }>;
}>;
export type RestoredOperationalFact = Readonly<{
  provenance: "completed-image-with-unconfirmed-delivery-in-selected-dialogue-journal";
  recordedAt: number;
  question: RestoredDialogue["question"];
  generation: "completed";
  delivery: "unknown" | "not-sent";
  // Generation does not prove that released image bytes remain available.
  artifactAvailability: "unverified";
}>;
export type StandingContextRestoration = Readonly<{
  status: "available" | "unavailable";
  scanned: number;
  hasOlder: boolean | null;
  eligible: number;
  dialogues: readonly RestoredDialogue[];
  operationalFactsEligible: number;
  operationalFacts: readonly RestoredOperationalFact[];
}>;
type Owner = { references: ConversationReferences; primary: PilotPrimary; signal: AbortSignal; accountId: string };
const owners = new WeakMap<StandingContextRestoration, Owner>();
const refuse = (): never => { throw new Error("STANDING_RESTORATION_REFUSED"); };
const text = (value: unknown, cap: number): value is string => typeof value === "string" && value.length > 0 &&
  !value.includes("\0") && Buffer.byteLength(value, "utf8") <= cap && Buffer.from(value, "utf8").toString("utf8") === value;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const validId = (value: unknown): value is number => positive(value) && value <= 2147483647;
function checkOwner(owner: Owner): void {
  if (owner.signal.aborted || !owner.references.matches(owner.primary.chatId, owner.accountId) ||
      owner.references.speaker(owner.primary.ownerId) === "neurobro") refuse();
}

/** Only this reader's immutable snapshots can be packed, under the same bound
 * connection references and exact selected request. Never owns or closes them. */
export function requireStandingContextRestoration(value: StandingContextRestoration, primary: PilotPrimary,
  references: ConversationReferences | undefined): StandingContextRestoration {
  const owner = owners.get(value);
  if (!owner || references !== owner.references || primary.chatId !== owner.primary.chatId ||
      primary.messageId !== owner.primary.messageId || primary.ownerId !== owner.primary.ownerId ||
      primary.text !== owner.primary.text) return refuse();
  checkOwner(owner);
  return value;
}

/** One joined read of at most 100 selected dialogues, retaining the newest eight
 * earlier verified model outcomes and eight separately labelled image-operation
 * facts. These facts grant no replay or sending authority. This is not a complete group history, a
 * chronology of every message, or a proof that no older records were deleted.
 * The caller serializes this read with journal writes and owns its real lifetime.
 * Revocation prevents projection after an awaited read; it does not cancel I/O.
 * No plaintext persistence, Telegram read, model call or reference-key ownership. */
export async function readStandingContextRestoration(input: {
  journal: Pick<StandingDialogueJournal, "read">; binding: PilotBinding; primary: PilotPrimary;
  references: ConversationReferences; signal: AbortSignal;
}): Promise<StandingContextRestoration> {
  const owner: Owner = { references: input.references, primary: Object.freeze({ ...input.primary }),
    signal: input.signal, accountId: input.binding.accountId };
  if (owner.primary.chatId !== input.binding.peerId || !validId(owner.primary.messageId) ||
      !text(owner.primary.text, STANDING_INCOMING_TEXT_BYTES)) return refuse();
  checkOwner(owner);
  const finish = (value: StandingContextRestoration) => {
    checkOwner(owner); Object.freeze(value.dialogues); Object.freeze(value.operationalFacts);
    Object.freeze(value); owners.set(value, owner); return value;
  };
  let result: Awaited<ReturnType<StandingDialogueJournal["read"]>>;
  try { result = await input.journal.read({ limit: 100, scanLimit: 100 }); }
  catch {
    checkOwner(owner);
    return finish({ status: "unavailable", scanned: 0, hasOlder: null, eligible: 0, dialogues: [],
      operationalFactsEligible: 0, operationalFacts: [] });
  }
  checkOwner(owner);
  if (!result || !Array.isArray(result.dialogues) || result.dialogues.length > 100 ||
      !Number.isSafeInteger(result.scanned) || result.scanned < result.dialogues.length || result.scanned > 100 ||
      typeof result.hasOlder !== "boolean") return refuse();
  const eligible: JournalDialogue[] = [], operations: JournalDialogue[] = [], seen = new Set<number>();
  for (const row of result.dialogues) {
    const p = row?.question?.primary;
    if (!p || p.chatId !== owner.primary.chatId || !validId(p.messageId) || seen.has(p.messageId) ||
        !/^[1-9]\d{0,19}$/.test(p.ownerId) || p.ownerId === owner.accountId || !text(p.text, STANDING_INCOMING_TEXT_BYTES) ||
        row.key !== String(p.messageId).padStart(10, "0") || !positive(row.recordedAt)) return refuse();
    seen.add(p.messageId);
    if (!row.outcome) { if (row.status !== "pending") return refuse(); continue; }
    const outcome = row.outcome;
    if (outcome.key !== row.key || outcome.delivery !== row.status ||
        !["verified", "unknown", "not-sent"].includes(row.status) || !["model", "deferred"].includes(outcome.kind) ||
        !(outcome.answer === null || text(outcome.answer, 4096)) ||
        (row.status === "verified" && outcome.answer === null)) return refuse();
    // Explicit journal provenance only; a model-written '[Изображение]' prefix
    // is ordinary text and cannot establish that generation completed.
    if ("image" in outcome) {
      const image = outcome.image;
      if (!image || typeof image !== "object" || Array.isArray(image) ||
          Reflect.ownKeys(image).length !== 1 || !("generation" in image) || image.generation !== "completed" ||
          outcome.kind !== "model" || outcome.answer === null) return refuse();
      if (p.messageId < owner.primary.messageId && row.status !== "verified") operations.push(row);
    }
    if (p.messageId < owner.primary.messageId && row.status === "verified" && outcome.kind === "model") eligible.push(row);
  }
  eligible.sort((a, b) => a.question.primary.messageId - b.question.primary.messageId);
  operations.sort((a, b) => a.question.primary.messageId - b.question.primary.messageId);
  const question = (row: JournalDialogue): RestoredDialogue["question"] => {
    const p = row.question.primary, source = row.question.source, c = row.question.context?.primary;
    if (c && (c.chatId !== p.chatId || c.messageId !== p.messageId || c.authorId !== p.ownerId ||
        c.author !== "user" || c.text !== p.text)) return refuse();
    if (source && c && (source.date !== c.date || source.displayName !== c.displayName)) return refuse();
    const metadata = source ?? c;
    if (metadata && (!positive(metadata.date) || !text(metadata.displayName, 512))) return refuse();
    return Object.freeze({ id: owner.references.message(p.messageId), speaker: owner.references.speaker(p.ownerId),
      displayName: metadata?.displayName ?? null, date: metadata?.date ?? null, text: p.text });
  };
  const dialogues = eligible.slice(-8).map((row): RestoredDialogue =>
    Object.freeze({ provenance: "verified-model-outcome-in-selected-dialogue-journal", recordedAt: row.recordedAt,
      question: question(row),
      answer: Object.freeze({ speaker: "neurobro", telegramMessageId: null, date: null, text: row.outcome!.answer! }) }));
  const operationalFacts = operations.slice(-8).map((row): RestoredOperationalFact => {
    const delivery = row.outcome!.delivery;
    if (delivery !== "unknown" && delivery !== "not-sent") return refuse();
    return Object.freeze({ provenance: "completed-image-with-unconfirmed-delivery-in-selected-dialogue-journal",
      recordedAt: row.recordedAt, question: question(row), generation: "completed", delivery,
      artifactAvailability: "unverified" });
  });
  return finish({ status: "available", scanned: result.scanned, hasOlder: result.hasOlder, eligible: eligible.length, dialogues,
    operationalFactsEligible: operations.length, operationalFacts });
}
