import { createHmac } from "node:crypto";
import { types } from "node:util";
import { snapshotStandingHistoryTaskIntent, type StandingHistoryTaskIntent } from "./standing-history-task-store.js";

const refuse = (): never => { throw new Error("STANDING_HISTORY_TASK_REQUEST_INPUT"); };
function fields(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.some(k => typeof k !== "string" || !keys.includes(k) && !optional.includes(k)) || keys.some(k => !Object.hasOwn(descriptors, k))) return refuse();
  return Object.fromEntries((names as string[]).map(k => {
    const d = descriptors[k]!;
    if (!("value" in d) || !d.enumerable) return refuse();
    return [k, d.value];
  }));
}

/** Host supplies a stable private key and identities from the admitted selection.
 * Model arguments contain only the frozen period and objective. One history task
 * per primary message: changed arguments retain identity and must conflict with
 * the persisted intent, not create another job. This function persists nothing. */
export function createStandingHistoryTaskRequest(input: Readonly<{
  identityKey: string;
  binding: Readonly<{ accountId: string; peerId: string }>;
  primary: Readonly<{ chatId: string; ownerId: string; messageId: number; text?: string }>;
  request: Readonly<{ fromDate: number; toDate: number; timezone: string; objective: string }>;
}>): StandingHistoryTaskIntent {
  const args = fields(input, ["identityKey", "binding", "primary", "request"]);
  const b = fields(args.binding, ["accountId", "peerId"]);
  // Accept actual PilotPrimary without retaining its conversation text.
  const p = fields(args.primary, ["chatId", "ownerId", "messageId"], ["text"]);
  const r = fields(args.request, ["fromDate", "toDate", "timezone", "objective"]);
  if (typeof args.identityKey !== "string" || !/^[0-9a-f]{64}$/u.test(args.identityKey) ||
      p.chatId !== b.peerId || p.ownerId === b.accountId || Object.hasOwn(p, "text") && typeof p.text !== "string") return refuse();
  // Validate all identities/values before using them in key material. The zero
  // task ID is an internal placeholder and is never returned or persisted.
  const canonical = snapshotStandingHistoryTaskIntent({ schema: "standing-history-task-v1", taskId: "htask_" + "0".repeat(48),
    accountId: b.accountId, chatId: b.peerId, requesterId: p.ownerId, primaryMessageId: p.messageId, ...r });
  const taskId = "htask_" + createHmac("sha256", Buffer.from(args.identityKey, "hex"))
    .update(JSON.stringify(["DecadansNeurobro/history-request/v1", canonical.accountId, canonical.chatId,
      canonical.requesterId, canonical.primaryMessageId])).digest("hex").slice(0, 48);
  return Object.freeze({ ...canonical, taskId });
}

/** Reopen must authenticate the stored intent first. Same identity with changed
 * dates/objective is a conflict, never permission to replace the accepted job. */
export function assertStandingHistoryTaskRequestMatches(stored: StandingHistoryTaskIntent, requested: StandingHistoryTaskIntent): void {
  const a = snapshotStandingHistoryTaskIntent(stored), b = snapshotStandingHistoryTaskIntent(requested);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("STANDING_HISTORY_TASK_REQUEST_CONFLICT");
}
