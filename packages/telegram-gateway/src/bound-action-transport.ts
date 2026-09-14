import { Api } from "telegram";
import { randomBytes } from "node:crypto";
import type { PilotBinding, PilotInvoker, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { ConversationReferences } from "./conversation-references.js";
import type { BoundActionLease, BoundActionOutcome, BoundActionExecution, BoundActionTransportRequest } from "./standing-bound-action-runtime.js";
import { createBoundPollTelegramTransport, BoundPollError, snapshotOwnedBoundPoll, type BoundPollInspection } from "./bound-poll-telegram.js";
import { snapshotStandingPollObjectEvidence, type StandingPollObjectEvidence } from "./standing-object-evidence.js";
import { createBoundReactionTelegramTransport, BoundReactionTelegramError, type BoundReactionReadback } from "./bound-reaction-telegram.js";
import { createStandingSelfProfile, type StandingSelfProfileImage } from "./standing-self-profile.js";
import { createStandingGroupAvatar } from "./standing-group-avatar.js";

/** One selected action lease, owned by the standing adapter. The runtime must
 * durably reserve the action before execute. Message refs locate only objects
 * already named by this bound connection; transports re-read their actual peer.
 * Raw Telegram IDs stay inside this host and never become model selectors. */
export function createBoundActionTransportLease(input: {
  client: PilotInvoker; binding: PilotBinding; peer: Api.InputPeerChat | Api.InputPeerChannel;
  self: Api.User; selected: PilotPrimary; references: ConversationReferences; signal: AbortSignal;
  isSelectionActive(): boolean; revalidatePrimary(signal: AbortSignal): Promise<PilotPrimary>;
  resolveAvatar?(artifactRef: string): StandingSelfProfileImage;
}): BoundActionLease {
  if (!input.references.matches(input.binding.peerId, input.binding.accountId)) throw new Error("BOUND_ACTION_BINDING");
  const refs = input.references, control = new AbortController();
  const signal = AbortSignal.any([input.signal, control.signal]);
  let closed = false, consumed = false, pending: Promise<BoundActionExecution> | undefined;
  let child: { close(): Promise<void> } | undefined, closing: Promise<void> | undefined;
  const current = () => !closed && !signal.aborted && input.isSelectionActive() === true;
  const selected = Object.freeze({ ...input.selected }), freshPrimary = input.revalidatePrimary.bind(input);
  const revalidatePrimary = async (callSignal: AbortSignal): Promise<void> => {
    if (callSignal.aborted || !current()) throw new Error("BOUND_ACTION_PRIMARY");
    const primary = await freshPrimary(callSignal);
    if (callSignal.aborted || !current() || primary.chatId !== selected.chatId || primary.ownerId !== selected.ownerId ||
        primary.messageId !== selected.messageId || primary.text !== selected.text) throw new Error("BOUND_ACTION_PRIMARY");
  };
  const refused = (code: string): BoundActionOutcome => ({ verdict: "refused", code });
  const pollView = (value: BoundPollInspection) => {
    const { messageId, pollId: _pollId, ...rest } = value;
    return { messageRef: refs.message(messageId), ...rest };
  };
  const reactionView = (value: BoundReactionReadback) => {
    const { targetMessageId, ...rest } = value;
    // Unchanged reactions intentionally reuse the transport's before object.
    // Public before/after must be independent JSON trees for durable snapshots.
    return { messageRef: refs.message(targetMessageId), ...rest,
      ownEmojis: [...value.ownEmojis], counts: value.counts.map(row => ({ ...row })),
      availability: { ...value.availability, emoji: [...value.availability.emoji] } };
  };
  const execute = (request: BoundActionTransportRequest, randomId: string): Promise<BoundActionExecution> => {
    if (consumed || !current()) return Promise.resolve({ outcome: refused("stopped-or-consumed") });
    consumed = true;
    let privateObjectEvidence: StandingPollObjectEvidence | undefined;
    if (request.kind === "resolve-poll-object") {
      try { request = Object.freeze({ kind: request.kind, record: snapshotOwnedBoundPoll(request.record) }); }
      catch { return Promise.resolve({ outcome: refused("input") }); }
    }
    // Request is already snapshotted by the source-owned named tool. Factory
    // operations also validate/snapshot their own primitives before awaiting I/O.
    pending = Promise.resolve().then(async (): Promise<BoundActionOutcome> => {
      if (!current()) return refused("stopped");
      try {
        if (request.kind === "set-group-avatar") {
          const primary = await input.revalidatePrimary(signal);
          if (!current() || primary.chatId !== input.selected.chatId || primary.ownerId !== input.selected.ownerId ||
              primary.messageId !== input.selected.messageId || primary.text !== input.selected.text) return refused("selection-changed");
          let image: StandingSelfProfileImage;
          try { if (!input.resolveAvatar) return refused("avatar-unavailable"); image = input.resolveAvatar(request.artifactRef); }
          catch { return refused("avatar-unavailable"); }
          try {
            const transport = createStandingGroupAvatar({ client: input.client, binding: input.binding, peer: input.peer, self: input.self, signal, revalidatePrimary }); child = transport;
            return await transport.setAvatar(image, randomId);
          } finally { image.bytes.fill(0); }
        }
        if (request.kind === "read-self-profile" || request.kind === "set-display-name" || request.kind === "set-avatar") {
          const primary = await input.revalidatePrimary(signal);
          if (!current() || primary.chatId !== input.selected.chatId || primary.ownerId !== input.selected.ownerId ||
              primary.messageId !== input.selected.messageId || primary.text !== input.selected.text) return refused("selection-changed");
          const transport = createStandingSelfProfile({ client: input.client, binding: input.binding, self: input.self, signal, revalidatePrimary }); child = transport;
          if (request.kind === "read-self-profile") return await transport.inspect();
          if (request.kind === "set-display-name") return await transport.setDisplayName({ firstName: request.firstName,
            ...(request.lastName === undefined ? {} : { lastName: request.lastName }) });
          let image: StandingSelfProfileImage;
          try { if (!input.resolveAvatar) return refused("avatar-unavailable"); image = input.resolveAvatar(request.artifactRef); }
          catch { return refused("avatar-unavailable"); }
          try { return await transport.setAvatar(image, randomId); }
          finally { image.bytes.fill(0); }
        }
        if (request.kind === "resolve-poll-object") {
          const transport = createBoundPollTelegramTransport({ ...input, signal, isSelectionActive: current }); child = transport;
          const value = await transport.inspectOwned(request.record);
          return current() ? { verdict: "verified", poll: pollView(value), observedAt: Math.floor(Date.now() / 1000) } : refused("stopped");
        }
        const target = request.kind === "create-poll" ? undefined : refs.resolveMessage(request.messageRef);
        if (request.kind !== "create-poll" && target === undefined) return refused("unknown-message-reference");
        const common = { ...input, signal, isSelectionActive: current };
        if (request.kind === "read-reactions" || request.kind === "set-reaction") {
          const transport = createBoundReactionTelegramTransport({ ...common, targetMessageId: target! }); child = transport;
          if (request.kind === "read-reactions") {
            const value = await transport.inspect();
            return current() ? { verdict: "verified", reactions: reactionView(value) } : refused("stopped");
          }
          const value = await transport.setOnce(request.emoji);
          if (!current()) return { verdict: "unknown", code: "stopped" };
          return { verdict: "verified", change: value.state, before: reactionView(value.before), after: reactionView(value.after) };
        }
        const transport = createBoundPollTelegramTransport(common); child = transport;
        if (request.kind === "create-poll") {
          const value = await transport.createOnce({ operationId: "bound-action-" + randomId, randomId, poll: request.poll });
          if (!current()) return { verdict: "unknown", code: "stopped" };
          privateObjectEvidence = snapshotStandingPollObjectEvidence({ schema: "standing-poll-object-v1", kind: "poll",
            objectRef: "obj_" + randomBytes(24).toString("hex"), observedAt: Math.floor(Date.now() / 1000), record: value.record });
          return { verdict: "verified", poll: { ...pollView(value.poll), objectRef: privateObjectEvidence.objectRef } };
        }
        if (request.kind === "close-poll") {
          const value = await transport.closeOwnOnce(target!);
          if (!current()) return { verdict: "unknown", code: "stopped" };
          return { verdict: "verified", change: value.status, poll: pollView(value.poll) };
        }
        const value = await transport.inspect(target!);
        return current() ? { verdict: "verified", poll: pollView(value) } : refused("stopped");
      } catch (error) {
        if (error instanceof BoundPollError || error instanceof BoundReactionTelegramError) {
          return { verdict: error.unknown ? "unknown" : "refused", code: error.code };
        }
        return { verdict: request.kind === "resolve-poll-object" ? "refused" : "unknown", code: "unavailable" };
      }
    }).then(outcome => Object.freeze({ outcome, ...(privateObjectEvidence && outcome.verdict === "verified" ? { privateObjectEvidence } : {}) }));
    return pending;
  };
  return Object.freeze({ execute, close(): Promise<void> {
    if (closing) return closing;
    closed = true; control.abort();
    const childClosing = child?.close();
    closing = Promise.all([pending, childClosing]).then(() => {});
    return closing;
  } });
}
