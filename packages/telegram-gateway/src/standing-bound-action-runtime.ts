import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import { BOUND_ACTION_TOOL_SPECS, createBoundActionTools, type BoundActionRequest } from "./bound-action-tools.js";
import { openStandingActionJournal, standingActionKey, snapshotStandingActionJson,
  StandingActionJournalError, type StandingActionJournal, type StandingActionJson } from "./standing-action-journal.js";
import type { PilotBinding, PilotPrimary } from "./pilot-telegram-adapter.js";
import type { EpochExtraTool, EpochToolResult, EpochToolScope } from "./standing-tool-dispatcher.js";
import type { OwnedBoundPoll } from "./bound-poll-telegram.js";
import { validateStandingPollObjectEvidence, type StandingPollObjectEvidence } from "./standing-object-evidence.js";
import { openStandingObjectCatalog } from "./standing-object-catalog.js";

export type BoundActionOutcome = Readonly<{ verdict: "verified" | "refused" | "unknown"; [key: string]: StandingActionJson }>;
export type BoundActionExecution = Readonly<{ outcome: BoundActionOutcome; privateObjectEvidence?: StandingPollObjectEvidence }>;
export type BoundActionTransportRequest = Exclude<BoundActionRequest, { kind: "find-objects" | "resolve-object" }> |
  Readonly<{ kind: "resolve-poll-object"; record: OwnedBoundPoll }>;
/** Application-owned exact-group lease. execute and close MUST retain actual
 * I/O ownership; close revokes synchronously and joins cancellation/settlement.
 * Neither method may resolve while a mutation remains in flight. */
export type BoundActionLease = Readonly<{
  execute(request: BoundActionTransportRequest, randomId: string): Promise<BoundActionExecution>;
  close(): Promise<void>;
}>;
export type StandingBoundActionSelection = Readonly<{
  requestRef: string; primary: PilotPrimary; openActions(): BoundActionLease;
}>;
export type StandingBoundActionRuntimePorts = Readonly<{ openJournal?: typeof openStandingActionJournal; openCatalog?: typeof openStandingObjectCatalog }>;
export type StandingBoundActionRuntime = Readonly<{
  handlers: readonly EpochExtraTool[]; specs: typeof BOUND_ACTION_TOOL_SPECS;
  begin(selection: StandingBoundActionSelection): void; finish(): Promise<void>; close(): Promise<void>;
  state(): Readonly<{ active: boolean; blocked: boolean; closed: boolean; operationSlots: number }>;
}>;
const fail = (): never => { throw new Error("STANDING_BOUND_ACTION_RUNTIME_REFUSED"); };
const unavailable = (): EpochToolResult => Object.freeze({ success: false,
  contentItems: Object.freeze([Object.freeze({ type: "inputText" as const,
    text: '{"schema":"neurobro-bound-action-tool-error-v1","code":"unavailable"}' })]) as EpochToolResult["contentItems"] });
function reference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256 &&
    !/[\u0000-\u0020\u007f-\u009f]/u.test(value) && Buffer.from(value).toString() === value;
}
function fields(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.some(key => typeof key !== "string" || ![...keys, ...optional].includes(key)) ||
      keys.some(key => !descriptors[key]) || Object.values(descriptors).some(d => !("value" in d))) return fail();
  return Object.fromEntries(names.map(key => [key, descriptors[key as string]!.value]));
}
function outcomeCopy(value: unknown): BoundActionOutcome {
  const copy = snapshotStandingActionJson(value);
  if (!copy || typeof copy !== "object" || Array.isArray(copy) ||
      !["verified", "refused", "unknown"].includes((copy as Record<string, unknown>).verdict as string)) return fail();
  return copy as BoundActionOutcome;
}
type Turn = { requestRef: string; control: AbortController; tools: ReturnType<typeof createBoundActionTools>;
  slots: number; closing?: Promise<void> };

/** Stable names share one bounded slot sequence per selected primary.
 * Request/epoch names cannot reset a consumed slot. All actions, including reads,
 * retain encrypted intent and bounded results, except read-only catalog discovery;
 * only the existing lease has any
 * Telegram authority. Unknown mutation/storage state poisons future admissions.
 * STOP revokes immediately, then finish/close join the admitted real operation. */
export function createStandingBoundActionRuntime(input: Readonly<{
  signal: AbortSignal; stateDirectory: string; passphrase: string; binding: PilotBinding;
  killed(): boolean; ports?: StandingBoundActionRuntimePorts;
}>): StandingBoundActionRuntime {
  if (!isAbsolute(input.stateDirectory) || resolve(input.stateDirectory) !== input.stateDirectory ||
      typeof input.passphrase !== "string" || input.passphrase.length < 16 || input.passphrase.length > 4096) return fail();
  const directory = join(input.stateDirectory, "action-journal"), binding = Object.freeze({ accountId: input.binding.accountId, chatId: input.binding.peerId });
  standingActionKey({ ...binding, primaryMessageId: 1, operationSlot: 0 });
  const hostSignal = input.signal, killed = input.killed.bind(input), openJournal = input.ports?.openJournal ?? openStandingActionJournal;
  const openCatalog = input.ports?.openCatalog ?? openStandingObjectCatalog;
  let catalogWork: ReturnType<typeof openStandingObjectCatalog> | undefined;
  let passphrase = input.passphrase, current: Turn | undefined, closed = false, blocked = false, closing: Promise<void> | undefined;
  const stopped = () => { try { return closed || hostSignal.aborted || killed() !== false; } catch { return true; } };
  const poison = () => { blocked = true; };
  const catalog = () => catalogWork ??= openCatalog({ directory, passphrase, ...binding });
  function joinTurn(turn: Turn): Promise<void> {
    if (turn.closing) return turn.closing;
    turn.closing = Promise.resolve().then(() => turn.tools.close()).catch(poison).finally(() => { if (current === turn) current = undefined; });
    turn.control.abort();
    return turn.closing;
  }
  const abort = () => { if (current) void joinTurn(current); };
  hostSignal.addEventListener("abort", abort, { once: true });
  const handlers = Object.freeze(BOUND_ACTION_TOOL_SPECS.map((spec, index) => Object.freeze<EpochExtraTool>({ name: spec.name,
    async call(args: unknown, scope: EpochToolScope) {
      const turn = current;
      if (!turn || turn.closing || blocked || stopped()) return unavailable();
      // Reject a foreign or executable scope without evaluating its properties.
      let captured: Record<string, unknown>;
      try { captured = fields(scope, ["requestRef", "callRef", "signal"]); } catch { return unavailable(); }
      if (captured.requestRef !== turn.requestRef) return unavailable();
      return turn.tools.handlers[index]!.call(args, scope);
    },
  })));
  return Object.freeze({ handlers, specs: BOUND_ACTION_TOOL_SPECS,
    begin(selection: StandingBoundActionSelection) {
      if (current || closing || stopped() || blocked) return fail();
      const selected = fields(selection, ["requestRef", "primary", "openActions"]);
      if (!reference(selected.requestRef) || typeof selected.openActions !== "function" || types.isProxy(selected.openActions)) return fail();
      const primary = fields(selected.primary, ["chatId", "ownerId", "messageId", "text"]);
      if (primary.chatId !== binding.chatId) return fail();
      const requestRef = selected.requestRef, primaryMessageId = primary.messageId as number;
      standingActionKey({ ...binding, primaryMessageId, operationSlot: 0 });
      const openActions = selected.openActions.bind(selection) as () => BoundActionLease;
      const control = new AbortController(), signal = AbortSignal.any([hostSignal, control.signal]);
      let turn: Turn;
      const tools = createBoundActionTools({ signal,
        async execute(request, scope): Promise<BoundActionOutcome> {
          if (current !== turn || turn.closing || blocked || stopped() || signal.aborted || scope.signal.aborted || scope.requestRef !== requestRef || turn.slots >= 32)
            return { verdict: "refused" };
          const operationSlot = turn.slots++;
          const interrupted = () => stopped() || signal.aborted || scope.signal.aborted || current !== turn || !!turn.closing;
          if (request.kind === "find-objects") {
            try {
              const reader = await catalog();
              if (interrupted()) return { verdict: "refused", code: "stopped" };
              const found = await reader.find({ kind: "poll", ...(request.query === undefined ? {} : { query: request.query }),
                ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.limit === undefined ? {} : { limit: request.limit }) });
              return interrupted() ? { verdict: "refused", code: "stopped" } : outcomeCopy({ verdict: "verified", ...found });
            } catch { return { verdict: "refused", code: "catalog-unavailable" }; }
          }
          let transportRequest: BoundActionTransportRequest;
          if (request.kind === "resolve-object") {
            try {
              const reader = await catalog();
              if (interrupted()) return { verdict: "refused", code: "stopped" };
              const evidence = await reader.resolve(request.objectRef);
              if (interrupted()) return { verdict: "refused", code: "stopped" };
              if (!evidence) return { verdict: "refused", code: "object-not-found-use-find" };
              transportRequest = { kind: "resolve-poll-object", record: evidence.record };
            } catch { return { verdict: "refused", code: "catalog-unavailable" }; }
          } else transportRequest = request;
          const mutation = request.kind !== "read-poll" && request.kind !== "read-reactions" && request.kind !== "read-self-profile" && request.kind !== "resolve-object";
          const actionBinding = Object.freeze({ ...binding, primaryMessageId, operationSlot });
          const randomId = (randomBytes(8).readBigUInt64BE() % (2n ** 63n - 1n) + 1n).toString();
          let journal: StandingActionJournal | undefined, lease: BoundActionLease | undefined, closeLeaseWork: Promise<void> | undefined;
          let outcome: BoundActionOutcome = { verdict: "refused" };
          let privateObjectEvidence: StandingPollObjectEvidence | undefined;
          const closeLease = (): Promise<void> => {
            if (!lease) return Promise.resolve();
            if (!closeLeaseWork) {
              let done!: () => void, failed!: (error: unknown) => void;
              closeLeaseWork = new Promise<void>((resolve, reject) => { done = resolve; failed = reject; });
              void closeLeaseWork.catch(() => {});
              try { void Promise.resolve(lease.close()).then(done, failed); } catch (error) { failed(error); }
            }
            return closeLeaseWork;
          };
          const cancelLease = () => { void closeLease(); };
          scope.signal.addEventListener("abort", cancelLease, { once: true });
          try {
            journal = await openJournal({ directory, passphrase, binding: actionBinding });
            const previous = await journal.inspect();
            if (previous.state !== "absent") { poison(); outcome = { verdict: "refused" }; }
            else if (!interrupted()) {
              await journal.reserve({ requestRef, randomId, action: request });
              if (!interrupted()) {
              const originalLease = openActions(), candidate = fields(originalLease, ["execute", "close"]);
              if (typeof candidate.execute !== "function" || typeof candidate.close !== "function" || types.isProxy(candidate.execute) || types.isProxy(candidate.close)) return fail();
              const execute = candidate.execute, close = candidate.close;
              lease = Object.freeze({ execute: (value, id) => Reflect.apply(execute, originalLease, [value, id]), close: () => Reflect.apply(close, originalLease, []) });
              if (interrupted()) await closeLease();
              else {
                try {
                  const result = fields(await lease.execute(transportRequest, randomId), ["outcome"], ["privateObjectEvidence"]);
                  outcome = outcomeCopy(result.outcome);
                  if (Object.hasOwn(result, "privateObjectEvidence")) {
                    if (outcome.verdict !== "verified" || request.kind !== "create-poll") return fail();
                    privateObjectEvidence = validateStandingPollObjectEvidence(result.privateObjectEvidence, actionBinding,
                      { requestRef, randomId, action: request });
                  }
                }
                catch { outcome = { verdict: mutation ? "unknown" : "refused" }; }
              }
              }
              try { await closeLease(); } catch { poison(); outcome = { verdict: "unknown" }; }
              if (interrupted() && outcome.verdict === "verified") outcome = { verdict: mutation ? "unknown" : "refused" };
              if (outcome.verdict === "unknown" && mutation) poison();
              await journal.append({ state: outcome.verdict, result: outcome,
                ...(outcome.verdict === "verified" && privateObjectEvidence ? { privateObjectEvidence } : {}) });
            }
          } catch (error) {
            poison(); outcome = { verdict: error instanceof StandingActionJournalError && error.code === "consumed" ? "refused" : "unknown" };
            // No second append after an uncertain storage operation. Reserved
            // state remains consumed if this attempt could not finish its receipt.
          } finally {
            scope.signal.removeEventListener("abort", cancelLease);
            try { await closeLease(); } catch { poison(); outcome = { verdict: "unknown" }; }
            try { await journal?.close(); } catch { poison(); outcome = { verdict: "unknown" }; }
          }
          return Object.freeze(outcome);
        },
      });
      turn = { requestRef, control, tools, slots: 0 }; current = turn;
      if (hostSignal.aborted) void joinTurn(turn);
    },
    async finish() { if (current) await joinTurn(current); },
    close() {
      if (closing) return closing;
      closed = true; hostSignal.removeEventListener("abort", abort);
      closing = (async () => {
        try { if (current) await joinTurn(current); if (catalogWork) await (await catalogWork).close(); }
        finally { passphrase = ""; }
      })();
      return closing;
    },
    state() { return Object.freeze({ active: current !== undefined, blocked, closed, operationSlots: current?.slots ?? 0 }); },
  });
}
