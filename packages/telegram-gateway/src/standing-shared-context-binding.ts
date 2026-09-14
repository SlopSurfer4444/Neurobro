import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { ConversationReferences } from "./conversation-references.js";
import { requireStandingSharedContextSnapshot, type StandingSharedContextSnapshot } from "./standing-shared-context.js";

/** Same-process host ownership, not authentication of the underlying sources.
 * The reader must establish source scope before binding its composed snapshot.
 * This capability grants no sending, retrieval or initiative permission. */
export type BoundStandingSharedContext = Readonly<{ snapshot: StandingSharedContextSnapshot }>;
type Owner = Readonly<{
  primary: PilotPrimary; accountId: string; scopeRef: string;
  references: ConversationReferences; signal: AbortSignal;
}>;
const owners = new WeakMap<BoundStandingSharedContext, Owner>();
const refuse = (): never => { throw new Error("STANDING_SHARED_CONTEXT_BINDING_REFUSED"); };

function check(owner: Owner, snapshot: StandingSharedContextSnapshot): void {
  if (owner.signal.aborted || !owner.references.matches(owner.primary.chatId, owner.accountId) ||
      owner.references.speaker(owner.primary.ownerId) === "neurobro" || snapshot.scope.scopeRef !== owner.scopeRef) refuse();
  if (snapshot.scope.audience.kind === "requester" &&
      snapshot.scope.audience.requesterRef !== owner.references.speaker(owner.primary.ownerId)) refuse();
  requireStandingSharedContextSnapshot(snapshot);
}

export function bindStandingSharedContext(input: Readonly<{
  snapshot: StandingSharedContextSnapshot; scopeRef: string; binding: PilotBinding;
  primary: PilotPrimary; references: ConversationReferences; signal: AbortSignal;
}>): BoundStandingSharedContext {
  const owner: Owner = Object.freeze({ primary: Object.freeze({ ...input.primary }),
    accountId: input.binding.accountId, scopeRef: input.scopeRef,
    references: input.references, signal: input.signal });
  if (owner.primary.chatId !== input.binding.peerId ||
      !Number.isSafeInteger(owner.primary.messageId) || owner.primary.messageId < 1 || owner.primary.messageId > 2147483647 ||
      typeof owner.primary.text !== "string" || Buffer.byteLength(owner.primary.text, "utf8") > 4096) refuse();
  check(owner, input.snapshot);
  const value = Object.freeze({ snapshot: input.snapshot });
  owners.set(value, owner);
  return value;
}

/** A restored snapshot cannot be reused for another participant, request or
 * connection. Revocation is checked immediately before packing model input. */
export function requireBoundStandingSharedContext(value: BoundStandingSharedContext,
  primary: PilotPrimary, references: ConversationReferences | undefined): StandingSharedContextSnapshot {
  const owner = owners.get(value);
  if (!owner || references !== owner.references || primary.chatId !== owner.primary.chatId ||
      primary.ownerId !== owner.primary.ownerId || primary.messageId !== owner.primary.messageId ||
      primary.text !== owner.primary.text) return refuse();
  check(owner, value.snapshot);
  return value.snapshot;
}
