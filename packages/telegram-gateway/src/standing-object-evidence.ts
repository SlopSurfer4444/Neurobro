import { types } from "node:util";
import { snapshotOwnedBoundPoll, snapshotBoundPollSpec, type OwnedBoundPoll } from "./bound-poll-telegram.js";
import type { StandingActionBinding, StandingActionIntent } from "./standing-action-journal.js";

/** Private ciphertext payload. Never return this record to a model tool. */
export type StandingPollObjectEvidence = Readonly<{
  schema: "standing-poll-object-v1"; kind: "poll"; objectRef: string; observedAt: number; record: OwnedBoundPoll;
}>;
const invalid = (): never => { throw new Error("STANDING_OBJECT_EVIDENCE_INPUT"); };
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return invalid();
  const copy: Record<string, unknown> = {};
  for (const k of keys as string[]) { const d = ds[k]!; if (!("value" in d) || !d.enumerable) return invalid(); copy[k] = d.value; }
  return copy;
}
export function snapshotStandingPollObjectEvidence(value: unknown): StandingPollObjectEvidence {
  const e = data(value, ["schema", "kind", "objectRef", "observedAt", "record"]);
  if (e.schema !== "standing-poll-object-v1" || e.kind !== "poll" || typeof e.objectRef !== "string" || !/^obj_[0-9a-f]{48}$/u.test(e.objectRef) ||
      !Number.isSafeInteger(e.observedAt) || Number(e.observedAt) < 1 || Number(e.observedAt) > 253402300799) return invalid();
  const record = snapshotOwnedBoundPoll(e.record);
  if (record.operationId !== "bound-action-" + record.randomId) return invalid();
  return Object.freeze({ schema: e.schema, kind: e.kind, objectRef: e.objectRef, observedAt: Number(e.observedAt), record });
}
export function validateStandingPollObjectEvidence(value: unknown, binding: StandingActionBinding, intent: StandingActionIntent): StandingPollObjectEvidence {
  const evidence = snapshotStandingPollObjectEvidence(value), b = data(binding, ["accountId", "chatId", "primaryMessageId", "operationSlot"]),
    i = data(intent, ["requestRef", "randomId", "action"]), action = data(i.action, ["kind", "poll"]), r = evidence.record;
  if (action.kind !== "create-poll" || r.accountId !== b.accountId || r.chatId !== b.chatId || r.replyToMessageId !== b.primaryMessageId ||
      r.randomId !== i.randomId || JSON.stringify(r.poll) !== JSON.stringify(snapshotBoundPollSpec(action.poll))) return invalid();
  return evidence;
}
