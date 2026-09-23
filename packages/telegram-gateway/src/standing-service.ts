import { TelegramClient } from "telegram";
import { finalizeStandingHistoryReport } from "./standing-history-final-report.js";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { types } from "node:util";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { acquireProcessLock } from "./process-lock.js";
import { openExistingEncryptedSessionLease, type GatewayExistingEncryptedSessionLease } from "./existing-session-lease.js";
import { clientOptions } from "./telegram-client.js";
import { installBindingNetworkFence } from "./binding-network-fence.js";
import { preparePilotGreeting, greetingKillSwitchEngaged, type GreetingPaths, type GreetingPrepared, type GreetingCredentials, type GreetingClient } from "./pilot-greeting.js";
import { completedStandingResult, closeStandingImage, validateStandingContent, type CompletedStandingResult, type StandingModel } from "./standing-model-result.js";
import { applyGeneratedImageUse } from "./standing-generated-image-use.js";
export type { StandingModel, StandingModelResult, StandingNativeModelResult, StandingNativeReceipt } from "./standing-model-result.js";
import { openEncryptedGeneratedImageOutbox, runGeneratedImageDelivery, readVerifiedGeneratedImage } from "./generated-image-outbox.js";
import { createStandingConversationAdapter } from "./standing-conversation-adapter.js";
import { conversationModelInput, StandingModelInputSizeError, STANDING_INITIATIVE_SILENCE, type StandingReplyPhotoArtifact } from "./standing-model-input.js";
export { addressedModelText } from "./standing-model-input.js";
import { openStandingState, StandingStateError, type StandingState } from "./standing-state.js";
import { createEncryptedPilotStore, runPilotReply, type PilotReplyInput, type PilotResult, type PilotStore, type PilotTransport } from "./pilot-outbox.js";
import { openStandingDialogueJournal, StandingDialogueJournalError, type StandingDialogueJournal } from "./standing-dialogue-journal.js";
import { createConversationReferences, type ConversationReferences } from "./conversation-references.js";
import { readStandingContextRestoration } from "./standing-context-restoration.js";
import { readStandingSharedContext } from "./standing-shared-context-reader.js";
import { createStandingHistoryTaskMemory } from "./standing-history-task-memory.js";
import { openStandingOwnActionMemory } from "./standing-own-action-memory.js";
import { openStandingOwnActionCheckpoint } from "./standing-own-action-checkpoint.js";
import { requireStandingChronicleNote, type StandingChronicleNote } from "./standing-chronicle-note.js";
import { openStandingHistoryChronicleCache, type StandingHistoryChronicleProducer } from "./standing-history-chronicle-cache.js";
import { openStandingHistoryPeriodChronicleStore } from "./standing-history-period-chronicle-store.js";
import { wrapPilotStore, wrapImageStore, wrapArtifactStore, wrapActionJournal, type StandingOwnActionCaptureEvent } from "./standing-own-action-capture.js";
import { openEncryptedArtifactOutbox } from "./standing-artifact-outbox.js";
import { openStandingActionJournal } from "./standing-action-journal.js";
import type { SelfHistoryToolResult } from "./self-history-tool.js";
import type { EpochExtraTool } from "./standing-tool-dispatcher.js";
import { createStandingArtifactRuntime, type StandingArtifactRuntime } from "./standing-artifact-runtime.js";
import { renderTelegramText } from "./telegram-text-format.js";
import { createStandingBoundActionRuntime, type StandingBoundActionRuntime } from "./standing-bound-action-runtime.js";
import { createRepositoryTools } from "./standing-repository-tools.js";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { openStandingHistoryTaskManager, type StandingHistoryTaskManager } from "./standing-history-task-manager.js";
import { createStandingHistoryTaskRuntime } from "./standing-history-task-runtime.js";
import { openStandingHistoryTaskRunner, StandingHistoryTaskRunnerError, standingWaitCode, type StandingHistoryTaskRunner } from "./standing-history-task-runner.js";
import { readStandingHistoryTaskDelivery, runStandingHistoryTaskDelivery, StandingHistoryTaskDeliveryError } from "./standing-history-task-delivery.js";
import { recordStandingHistoryTaskDisposition } from "./standing-history-task-disposition.js";
import type { StandingSelection } from "./standing-conversation-adapter.js";
import type { StandingVisualInput } from "./standing-visual-input.js";
import { createStandingMediaReadPort } from "./standing-media-read-port.js";
import type { StandingInputPhotoArtifact } from "./standing-model-input.js";
import type { StandingHistoryAnalysisStepConnection, StandingHistoryAnalysisOwnerSettlement } from "./standing-history-analysis-step.js";
import type { StandingHistoryAnalysisNativeBinding } from "./standing-history-analysis-attempt-store.js";
import { normalizeStandingWorkspace, prepareStandingWorkspace, type StandingWorkspaceInput } from "./standing-workspace.js";
import { openStandingLearningStore } from "./standing-learning-store.js";
import { createStandingLearningTools, STANDING_LEARNING_TOOL_NAME } from "./standing-learning-tools.js";
import { openStandingObservedSourceBinding } from "./standing-observed-source-binding.js";
import { createStandingObservedSourceTools, StandingObservedSourceUnavailableError } from "./standing-observed-source-tools.js";
import { createStandingChatSearchTools } from "./standing-chat-search.js";
import { openStandingCommunitySettings } from "./standing-community-settings.js";
import { openStandingCommunityObserverState } from "./standing-community-observer-state.js";
import { openStandingCommunityAlertOutbox } from "./standing-community-alert-outbox.js";
import { createStandingObservationTools, STANDING_OBSERVATION_TOOL_NAME } from "./standing-observation-tools.js";
import { createStandingCommunityObserver } from "./standing-community-observer.js";
import { createStandingCommunityAssessmentPort, type StandingCommunityAssessmentConnection } from "./standing-community-assessment-port.js";
import type { StandingHistoryTaskProgressEvent } from "./standing-history-task-progress.js";
import type { StandingHistoryTaskWork } from "./standing-history-task-runner.js";

/** Interpret only joined runner observations; no timer implies execution. */
export function standingHistoryWorkProgress(work: StandingHistoryTaskWork): StandingHistoryTaskProgressEvent | undefined {
  if (work.kind !== "background") return undefined;
  const o = work.outcome;
  if (o.kind === "scan" || o.kind === "participant") return undefined;
  const taskRef = o.kind === "ready" ? o.intent.taskId : o.taskRef;
  const progress = (phase: StandingHistoryTaskProgressEvent["phase"], reason: StandingHistoryTaskProgressEvent["reason"] = null) => ({ taskRef, phase, reason });
  if (o.kind === "stalled") return progress(o.reason === "cancelled" ? "cancelled" : "stalled", o.reason);
  if (o.kind === "task-blocked") return progress("stalled", o.reason);
  if (o.kind === "read") return o.result.kind === "cancelled" ? progress("cancelled", "cancelled")
    : o.result.kind === "stale" ? progress("stalled", "stale") : progress("reading");
  if (o.kind === "ready") return progress("finalizing");
  if (o.kind === "recovered") return progress("recovering");
  if (o.kind === "analysis-running") return progress("analyzing");
  if (o.kind === "analysis") {
    if (o.result.kind === "cancelled" || ("cancelled" in o.result && o.result.cancelled)) return progress("cancelled", "cancelled");
    if (o.result.kind === "blocked") return progress("stalled", "unavailable");
    return progress(o.result.kind === "scan-more" ? "planning" : o.result.kind === "read-more" ? "reading" : "analyzing");
  }
  if (o.kind === "delivery-state") {
    if (o.state === "verified") return progress("delivered");
    if (o.state === "unknown") return progress("stalled", "delivery-unknown");
    if (o.state === "failed-terminal") return progress("stalled", "delivery-failed-terminal");
    return progress("stalled", "unavailable");
  }
  return undefined;
}

/** Source-owned warm runtime. turn returns content only after its native scope
 * and custody admission; close separately proves owned process settlement.
 * The service joins actual delivery before release and retains one Telegram
 * connection/reference set across native-only epoch rotation. */
export type StandingEpochConnection = Readonly<{
  prepare(): Promise<Readonly<{ restoration: boolean }>>;
  prepareAnalysis?(): Promise<Readonly<{ restoration: boolean }>>;
  turn(requestRef: string, conversation: string, images?: readonly StandingVisualInput[]): Promise<CompletedStandingResult | Readonly<{ kind: "not-admitted"; reason: "prepare" | "limit" }>>;
  release(requestRef: string, delivery: "verified" | "not-sent" | "unknown"): Promise<void>;
  close(): Promise<Readonly<{ resourcesSettled: boolean; persisted: boolean }>>;
  state(): Readonly<{ blocked: boolean; failedTurn?: boolean }>;
  acquireAnalysisAdmission?: StandingHistoryAnalysisStepConnection["acquireAnalysisAdmission"];
  concurrentAnalysis?: true;
  acquireParallelAnalysisAdmissions?: StandingHistoryAnalysisStepConnection["acquireParallelAnalysisAdmissions"];
  verifyAnalysisWorkReleased?: StandingHistoryAnalysisStepConnection["verifyAnalysisWorkReleased"];
  verifyAnalysisSettlement?(binding: StandingHistoryAnalysisNativeBinding): Promise<StandingHistoryAnalysisOwnerSettlement>;
  verifyAnalysisReady?(binding: StandingHistoryAnalysisNativeBinding): Promise<unknown>;
  acquireCommunityAssessmentAdmission?: StandingCommunityAssessmentConnection["acquireCommunityAssessmentAdmission"];
  verifyCommunityAssessmentSettlement?: StandingCommunityAssessmentConnection["verifyCommunityAssessmentSettlement"];
}>;

export type StandingCode = "STANDING_CONNECTING" | "STANDING_ONLINE" | "STANDING_MODEL" | "STANDING_REPLY_VERIFIED" | "STANDING_RECONNECTING" | "STANDING_UNKNOWN_CONSUMED" | "STANDING_STOPPED" | "STANDING_BLOCKED";
export type StandingStage = "prepare" | "lock" | "session" | "state" | "connect" | "self" | "adapter" | "wait" | "model" | "send" | "settle" | "none";
export type StandingFailure = "none" | "transport" | "binding" | "protocol" | "backlog" | "checkpoint" | "aborted" | "other";
export type StandingResult = Readonly<{ status: "stopped" | "blocked"; code: StandingCode; clientSettled: boolean; lockPreserved: boolean; verifiedReplies: number; failureStage: StandingStage; failureCode: StandingFailure; waitFailureOrigin?: "history-poll" | "adapter-poll" | "participant-due" | "participant-step"; waitFailureCode?: string }>;
export type StandingInput = Readonly<{
  paths: GreetingPaths; stateDirectory: string; credentials: GreetingCredentials;
  model: StandingModel; modelState(): { blocked: boolean };
  openConversation?(input: { history: { call(value: unknown): Promise<SelfHistoryToolResult> }; signal: AbortSignal; extraTools?: readonly EpochExtraTool[]; workProfile?: "team-assistant" | "community-team" }):
    StandingEpochConnection | Promise<StandingEpochConnection>;
  /** Host-owned profile and isolated state. Chat content cannot select either. */
  workProfile?: "team-assistant" | "community-team";
  workspace?: StandingWorkspaceInput;
  /** Owner configuration only. This source never becomes a reply destination. */
  observedSource?: Readonly<{ title: string }>;
  enableCommunityObservation?: boolean;
  enableImages?: boolean;
  enableGroupTools?: boolean;
  enableArtifacts?: boolean;
  enableFormatting?: boolean;
  enableBoundActions?: boolean;
  enableHistoryTasks?: boolean;
  /** Host-owned lookup of an already synthesized, reviewed final report.
   * No internal analysis summary is an implicit publishable result. */
  historyFinalReport?(input: Pick<Parameters<typeof runStandingHistoryTaskDelivery>[0], "intent" | "readiness" | "signal">):
    Promise<Parameters<typeof runStandingHistoryTaskDelivery>[0]["finalReport"]>;
  /** Explicit host opt-in. Bind the actual admitted model and exact native
   * prompt/projector/output revisions; chat text cannot choose this identity. */
  historyChronicle?: Readonly<{ producer: StandingHistoryChronicleProducer }>;
  historyParallel?: Readonly<{ maxLeaves: number }>;
  enableInitiative?: boolean;
  repositorySnapshot?: unknown;
  signal: AbortSignal; notify(code: StandingCode): void;
  /** Host diagnostics and model memory only; failure cannot affect custody. */
  onHistoryProgress?(event: StandingHistoryTaskProgressEvent, observedAt: number): void;
  acquireLock?: (path: string) => Promise<() => Promise<void>>;
}>;
export interface StandingPorts {
  historyChronicleCache?: typeof openStandingHistoryChronicleCache;
  historyPeriodChronicleStore?: typeof openStandingHistoryPeriodChronicleStore;
  prepare(paths: GreetingPaths): Promise<GreetingPrepared>;
  acquireLock(path: string): Promise<() => Promise<void>>;
  openSession(reference: string, passphrase: string): Promise<GatewayExistingEncryptedSessionLease>;
  state(directory: string, passphrase: string, binding: GreetingPrepared["binding"]): Promise<StandingState>;
  journal: typeof openStandingDialogueJournal;
  createClient(material: string, credentials: GreetingCredentials, signal: AbortSignal, disconnected: () => void): GreetingClient;
  installFence(client: GreetingClient, disconnected: () => never): () => void;
  adapter: typeof createStandingConversationAdapter;
  mediaReader?(client: GreetingClient, signal: AbortSignal): ReturnType<typeof createStandingMediaReadPort>;
  settle(client: GreetingClient): Promise<boolean>;
  store(directory: string, passphrase: string): PilotStore;
  dispatch(input: PilotReplyInput): Promise<PilotResult>;
  imageStore: typeof openEncryptedGeneratedImageOutbox;
  dispatchImage: typeof runGeneratedImageDelivery;
  readGeneratedImage?: typeof readVerifiedGeneratedImage;
  artifactRuntime?: typeof createStandingArtifactRuntime;
  actionRuntime?: typeof createStandingBoundActionRuntime;
  killed(path: string): boolean;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  now(): number;
}
export class StandingTransportError extends Error {
  readonly code = "transport";
  constructor() { super("STANDING_TRANSPORT"); }
}
const transportError = () => new StandingTransportError();
export const STANDING_DEFERRED_REPLY = "Бро, сейчас не получилось закончить ответ. Попробуй спросить ещё раз или разбить вопрос на части.";
export async function withTyping<T>(operation: () => Promise<T>, pulse: (() => Promise<void>) | undefined, signal: AbortSignal): Promise<T> {
  if (!pulse) return operation();
  let stopped = false, wake: (() => void) | undefined;
  const stop = () => { stopped = true; wake?.(); };
  signal.addEventListener("abort", stop, { once: true });
  const typing = (async () => {
    while (!stopped && !signal.aborted) {
      try { await pulse(); } catch { break; }
      if (stopped || signal.aborted) break;
      await new Promise<void>(done => {
        const timer = setTimeout(() => { wake = undefined; done(); }, 4000);
        wake = () => { clearTimeout(timer); wake = undefined; done(); };
      });
    }
  })();
  try { return await operation(); }
  finally { stop(); signal.removeEventListener("abort", stop); await typing; }
}
function retryable(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "transport";
}
function trackTextDelivery(transport: PilotTransport) {
  const pending: Promise<void>[] = [];
  const send = transport.sendOnce.bind(transport), read = transport.readExact.bind(transport);
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    const actual = Promise.resolve().then(operation);
    pending.push(actual.then(() => {}, () => {}));
    return actual;
  };
  return { transport: Object.freeze<PilotTransport>({
    sendOnce: (reply, signal) => track(() => send(reply, signal)),
    readExact: (chat, message, signal) => track(() => read(chat, message, signal)),
  }), settle: () => Promise.all(pending).then(() => {}) };
}
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  if (signal.aborted) throw transportError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      abort = () => reject(transportError()); signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
}

/** Image-enabled connections must retain the actual invoke lifetime. Cancellation
 * closes this same client to interrupt I/O, but never resolves an invocation early.
 * If GramJS does not settle after destroy, the media buffer and owner remain held;
 * an outer supervisor must report unknown rather than claim graceful settlement. */
export function createStandingInvokeOwner(input: {
  destroy(): Promise<unknown>; signal: AbortSignal; disconnected(): void;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}) {
  const schedule = input.schedule ?? ((callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); });
  const pending = new Set<Promise<void>>();
  let stopped = false, destroyPromise: Promise<boolean> | undefined;
  const stop = () => {
    stopped = true;
    if (!destroyPromise) {
      // Install the promise before notifying: disconnected may synchronously
      // abort this owner's signal and re-enter stop.
      destroyPromise = Promise.resolve().then(input.destroy).then(() => true, () => false);
      try { input.disconnected(); } catch { /* Still join the actual destroy. */ }
    }
  };
  input.signal.addEventListener("abort", stop, { once: true });
  if (input.signal.aborted) stop();
  return Object.freeze({
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (stopped || input.signal.aborted) throw transportError();
      const cancelTimer = schedule(stop, 30_000);
      const operationPromise = Promise.resolve().then(() => {
        if (stopped || input.signal.aborted) throw transportError();
        return operation();
      });
      const settled = operationPromise.then(() => {}, () => {}).then(() => { pending.delete(settled); });
      pending.add(settled);
      try {
        const result = await operationPromise;
        if (stopped || input.signal.aborted) throw transportError();
        return result;
      } finally { cancelTimer(); }
    },
    async settle(): Promise<boolean> {
      stop(); input.signal.removeEventListener("abort", stop);
      let cancelTimer = () => {};
      try {
        return await Promise.race([
          Promise.all([destroyPromise!, ...pending]).then(values => values[0] === true && pending.size === 0),
          new Promise<false>(done => { cancelTimer = schedule(() => done(false), 10_000); }),
        ]);
      } finally { cancelTimer(); }
    },
  });
}

/** Owns one session lock throughout reconnects; a primary's persisted cursor is
 * advanced before model admission. Unknown delivery is consumed, never replayed.
 * Restoration of resources and successful delivery are independent verdicts. */
export async function runStandingWithPorts(input: StandingInput, ports: StandingPorts): Promise<StandingResult> {
  const groupToolsFlag = input.enableGroupTools;
  const artifactsFlag = input.enableArtifacts, formattingFlag = input.enableFormatting, actionsFlag = input.enableBoundActions;
  let release: (() => Promise<void>) | undefined, lease: GatewayExistingEncryptedSessionLease | undefined;
  let journal: StandingDialogueJournal | undefined;
  let ownActionCheckpoint: Awaited<ReturnType<typeof openStandingOwnActionCheckpoint>> | undefined;
  let ownActionCheckpointFailed = false;
  const flushOwnActionCheckpoint = async () => {
    if (ownActionCheckpointFailed) return;
    try { await ownActionCheckpoint?.flush(); } catch { ownActionCheckpointFailed = true; }
  };
  let repository: ReturnType<typeof createRepositoryTools> | undefined;
  let workspace: ReturnType<typeof normalizeStandingWorkspace> | undefined;
  let historyChronicle: StandingInput["historyChronicle"];
  let historyParallel: StandingInput["historyParallel"];
  let learningStore: Awaited<ReturnType<typeof openStandingLearningStore>> | undefined;
  let observedBinding: Awaited<ReturnType<typeof openStandingObservedSourceBinding>> | undefined;
  let observedBindingFailed = false;
  let communitySettings: Awaited<ReturnType<typeof openStandingCommunitySettings>> | undefined;
  let communityState: Awaited<ReturnType<typeof openStandingCommunityObserverState>> | undefined;
  let communityOutbox: Awaited<ReturnType<typeof openStandingCommunityAlertOutbox>> | undefined;
  let clientSettled = true, lockPreserved = false, blocked = false, verifiedReplies = 0;
  let stage: StandingStage = "prepare", failureStage: StandingStage = "none", failureCode: StandingFailure = "none";
  let waitFailureOrigin: StandingResult["waitFailureOrigin"], waitFailureCode: string | undefined;
  const recordWaitFailure = (error: unknown, fallback: "history-poll" | "adapter-poll") => {
    waitFailureOrigin = error instanceof StandingHistoryTaskRunnerError && error.origin && ["adapter-poll", "participant-due", "participant-step"].includes(error.origin) ? error.origin : fallback;
    waitFailureCode = error instanceof StandingHistoryTaskRunnerError && error.childCode ? standingWaitCode({ code: error.childCode }) : standingWaitCode(error);
  };
  const recordFailure = (error: unknown) => {
    failureStage = stage;
    if (stage !== "wait") { waitFailureOrigin = undefined; waitFailureCode = undefined; }
    const code = error instanceof StandingStateError || error instanceof StandingDialogueJournalError ? "checkpoint" : error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    failureCode = typeof code === "string" && ["transport", "binding", "protocol", "backlog", "checkpoint", "aborted"].includes(code) ? code as StandingFailure : "other";
  };
  const stopController = new AbortController();
  input = { ...input, signal: AbortSignal.any([input.signal, stopController.signal]) };
  const stopMonitor = setInterval(() => {
    try { if (ports.killed(input.paths.killSwitchPath)) stopController.abort(); }
    catch { blocked = true; stopController.abort(); }
  }, 1000);
  const notify = (code: StandingCode) => { try { input.notify(code); } catch { /* No private fallback output. */ } };
  const stopping = () => input.signal.aborted || ports.killed(input.paths.killSwitchPath);
  const initiativeAllowed = () => input.enableInitiative === true && !ports.killed(join(input.stateDirectory, "INITIATIVE.OFF"));
  try {
    if (input.workProfile !== undefined && input.workProfile !== "team-assistant" && input.workProfile !== "community-team" ||
        (input.workProfile !== undefined) !== (input.workspace !== undefined) || input.workProfile && !input.openConversation) throw new Error("work-profile-config");
    if (input.workspace) {
      workspace = normalizeStandingWorkspace(input.workspace);
      if (resolve(input.stateDirectory) !== workspace.stateDirectory ||
          Object.entries(workspace.paths).some(([key, value]) => resolve(input.paths[key as keyof GreetingPaths]) !== value)) throw new Error("workspace-paths-config");
    }
    if (input.observedSource !== undefined) {
      const source = input.observedSource;
      if (!workspace || !source || Object.keys(source).join() !== "title" || typeof source.title !== "string" ||
          source.title !== source.title.trim() || !source.title.length || Buffer.byteLength(source.title, "utf8") > 256 ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(source.title)) throw new Error("observed-source-config");
      input = { ...input, observedSource: Object.freeze({ title: source.title }) };
    }
    if (groupToolsFlag !== undefined && typeof groupToolsFlag !== "boolean" || groupToolsFlag === true && !input.openConversation) throw new Error("group-tools-config");
    if (artifactsFlag !== undefined && typeof artifactsFlag !== "boolean" || artifactsFlag === true && !input.openConversation || formattingFlag !== undefined && typeof formattingFlag !== "boolean") throw new Error("toolbelt-config");
    if (actionsFlag !== undefined && typeof actionsFlag !== "boolean" || actionsFlag === true && !input.openConversation) throw new Error("action-tools-config");
    if (input.enableHistoryTasks !== undefined && typeof input.enableHistoryTasks !== "boolean" || input.enableHistoryTasks === true && !input.openConversation) throw new Error("history-tasks-config");
    if (input.historyParallel !== undefined) {
      const value = input.historyParallel;
      if (!value || typeof value !== "object" || types.isProxy(value)) throw new Error("history-parallel-config");
      const ds = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(ds).length !== 1 || !ds.maxLeaves || !("value" in ds.maxLeaves) ||
        !Number.isSafeInteger(ds.maxLeaves.value) || ds.maxLeaves.value < 2 || ds.maxLeaves.value > 8 || input.enableHistoryTasks !== true) throw new Error("history-parallel-config");
      historyParallel = Object.freeze({ maxLeaves: ds.maxLeaves.value });
    }
    if (input.historyChronicle !== undefined) {
      const copy = (value: unknown, keys: readonly string[]) => {
        if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("history-chronicle-config");
        const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds), out: Record<string, unknown> = {};
        if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) throw new Error("history-chronicle-config");
        for (const key of keys) { const d = ds[key]; if (!d || !("value" in d) || !d.enumerable) throw new Error("history-chronicle-config"); out[key] = d.value; } return out;
      };
      const config = copy(input.historyChronicle, ["producer"]), producer = copy(config.producer, ["model", "promptVersion", "projectionVersion", "outputVersion"]);
      if (input.enableHistoryTasks !== true || Object.values(producer).some(v => typeof v !== "string" || !v.trim() || v.includes("\0") || Buffer.byteLength(v) > 256)) throw new Error("history-chronicle-config");
      historyChronicle = Object.freeze({ producer: Object.freeze(producer) as StandingHistoryChronicleProducer });
    }
    if (input.enableInitiative !== undefined && typeof input.enableInitiative !== "boolean" || input.enableInitiative === true && !input.openConversation) throw new Error("initiative-config");
    if (input.enableCommunityObservation !== undefined && typeof input.enableCommunityObservation !== "boolean" ||
        input.enableCommunityObservation === true && (!workspace || !input.observedSource || !input.openConversation || input.enableHistoryTasks !== true)) throw new Error("community-observation-config");
    if (input.repositorySnapshot !== undefined) {
      if (!input.openConversation) throw new Error("repository-tools-config");
      repository = createRepositoryTools({ snapshot: input.repositorySnapshot, signal: input.signal });
    }
    const prepared = await ports.prepare(input.paths);
    if (workspace && (prepared.binding.accountId !== workspace.target.accountId || prepared.binding.peerId !== workspace.target.peerId)) throw new Error("workspace-binding-config");
    if (stopping()) throw new Error("stopped");
    stage = "lock"; release = await ports.acquireLock(prepared.ownerLock); lockPreserved = true;
    const credentials = input.credentials;
    if (!Number.isSafeInteger(credentials.apiId) || credentials.apiId <= 0 || !/^[a-fA-F0-9]{32}$/.test(credentials.apiHash) || credentials.passphrase.length < 16) throw new Error("credentials");
    stage = "session"; lease = await ports.openSession(prepared.config.account.sessionFile, credentials.passphrase);
    stage = "state"; const state = await ports.state(input.stateDirectory, credentials.passphrase, prepared.binding);
    if (workspace) learningStore = await openStandingLearningStore({ directory: join(input.stateDirectory, "learning"),
      passphrase: credentials.passphrase, binding: prepared.binding, workspaceId: workspace.workspaceId });
    if (workspace && input.observedSource) {
      try { observedBinding = await openStandingObservedSourceBinding({ directory: input.stateDirectory,
        workspaceId: workspace.workspaceId, accountId: prepared.binding.accountId, internalPeerId: prepared.binding.peerId,
        title: input.observedSource.title }); }
      catch { observedBindingFailed = true; }
    }
    journal = await ports.journal({ directory: join(input.stateDirectory, "dialogues"), passphrase: credentials.passphrase, binding: prepared.binding });
    if (input.openConversation) {
      try { ownActionCheckpoint = await openStandingOwnActionCheckpoint({ directory: join(input.stateDirectory, "own-action-memory"),
        passphrase: credentials.passphrase, binding: prepared.binding }); }
      catch { ownActionCheckpointFailed = true; }
    }
    let failures = 0;
    while (!stopping()) {
      let client: GreetingClient | undefined, restore: (() => void) | undefined;
      let adapter: Awaited<ReturnType<StandingPorts["adapter"]>> | undefined;
      let mediaReader: ReturnType<typeof createStandingMediaReadPort> | undefined;
      let references: ConversationReferences | undefined, conversation: StandingEpochConnection | undefined;
      let failedTurnClosure: ReturnType<StandingEpochConnection["close"]> | undefined;
      let learning: ReturnType<typeof createStandingLearningTools> | undefined;
      let observed: ReturnType<typeof createStandingObservedSourceTools> | undefined;
      let chatSearch: ReturnType<typeof createStandingChatSearchTools> | undefined;
      const chatSearchClosings = new Set<Promise<void>>();
      let chatSearchCloseFailed = false;
      const finishChatSearch = async (deferJoin = false) => {
        const current = chatSearch; chatSearch = undefined;
        const closing = current?.close();
        if (closing) {
          chatSearchClosings.add(closing);
          void closing.then(() => chatSearchClosings.delete(closing), () => {
            chatSearchCloseFailed = true; chatSearchClosings.delete(closing);
          });
        }
        // On a failed/aborted turn, revoke now but let the outer sole-client
        // owner interrupt transport before joining an uncooperative RPC.
        if (!deferJoin && !signal.aborted) await closing;
      };
      const chatSearchHandlers: readonly EpochExtraTool[] = [{ name: "neurobro_search_chat", async call(value, scope) {
        if (!chatSearch) return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ code: "invalid-scope" }) }] };
        return chatSearch.handlers[0]!.call(value, scope);
      } }];
      let observation: ReturnType<typeof createStandingObservationTools> | undefined;
      let communityObserver: ReturnType<typeof createStandingCommunityObserver> | undefined;
      let communityAssessment: ReturnType<typeof createStandingCommunityAssessmentPort> | undefined;
      let resolvedSourcePeerId: string | undefined;
      const finishObservation = async () => { const current = observation; observation = undefined; await current?.close(); };
      const observationHandlers: readonly EpochExtraTool[] = workspace ? [{ name: STANDING_OBSERVATION_TOOL_NAME,
        async call(value, scope) {
          if (!observation) return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ code: "observation-unavailable" }) }] };
          return observation.handlers[0]!.call(value, scope);
        } }] : [];
      const finishObserved = async () => { const current = observed; observed = undefined; await current?.close(); };
      const observedHandlers: readonly EpochExtraTool[] = workspace ? [{ name: "neurobro_community",
        async call(value, scope) {
          if (!observed) return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ code: "invalid-scope" }) }] };
          return observed.handlers[0]!.call(value, scope);
        } }] : [];
      const finishLearning = async () => { const current = learning; learning = undefined; await current?.close(); };
      const learningHandlers: readonly EpochExtraTool[] = learningStore ? [{ name: STANDING_LEARNING_TOOL_NAME,
        async call(value, scope) {
          if (!learning) return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ code: "invalid-scope" }) }] };
          return learning.handlers[0]!.call(value, scope);
        } }] : [];
      const sharedScopeRef = "scope_" + randomUUID().replaceAll("-", "");
      let artifacts: StandingArtifactRuntime | undefined;
      let actions: StandingBoundActionRuntime | undefined;
      let historyManager: StandingHistoryTaskManager | undefined;
      let historyRuntime: ReturnType<typeof createStandingHistoryTaskRuntime> | undefined;
      let historyRunner: StandingHistoryTaskRunner | undefined;
      let historyChronicleCache: Awaited<ReturnType<typeof openStandingHistoryChronicleCache>> | undefined;
      let historyPeriodChronicleStore: Awaited<ReturnType<typeof openStandingHistoryPeriodChronicleStore>> | undefined;
      let historyMemory: ReturnType<typeof createStandingHistoryTaskMemory> | undefined;
      const chronicleNotes = new Map<string, Readonly<{ requesterId: string; note: StandingChronicleNote }>>();
      let ownActionMemory: Awaited<ReturnType<typeof openStandingOwnActionMemory>> | undefined;
      let acceptOwnActionCaptures = true;
      const dropOwnActionMemory = () => {
        const memory = ownActionMemory; ownActionMemory = undefined;
        try { memory?.close(); } catch { /* Optional memory cannot prevent actual cleanup. */ }
      };
      const observeOwnAction = (event: StandingOwnActionCaptureEvent) => {
        if (!acceptOwnActionCaptures) return;
        if (!ownActionCheckpointFailed) {
          try { ownActionCheckpoint?.stage(event); } catch { ownActionCheckpointFailed = true; }
        }
        try { ownActionMemory?.observe(event); } catch { dropOwnActionMemory(); }
      };
      const dropHistoryMemory = () => {
        const memory = historyMemory; historyMemory = undefined;
        try { memory?.close(); } catch { /* Optional context must never skip owner/client cleanup. */ }
      };
      const invalidateHistoryMemory = (taskRef?: string) => {
        try { historyMemory?.invalidate(taskRef); } catch { dropHistoryMemory(); }
      };
      const observeHistoryProgress = (event: StandingHistoryTaskProgressEvent) => {
        const observedAt = Math.floor(ports.now() / 1000);
        try { historyMemory?.observeProgress(event, observedAt); } catch { /* Optional observation grants no execution. */ }
        try { input.onHistoryProgress?.(event, observedAt); } catch { /* Diagnostics must not interrupt a task or client settlement. */ }
      };
      let activeTaskDelivery: Readonly<{ taskRef: string; controller: AbortController; settlement: Promise<void> }> | undefined;
      const historyDirectories = Object.freeze(Object.fromEntries(["pages", "control", "analysis", "attempts", "delivery"].map(name =>
        [name, join(input.stateDirectory, "history-tasks", name)]))) as Readonly<{ pages: string; control: string; analysis: string; attempts: string; delivery: string }>;
      const historyDispositionDirectory = join(input.stateDirectory, "history-tasks", "disposition");
      const historyReportDirectory = join(input.stateDirectory, "history-tasks", "reports");
      let reconnect = false;
      const questionKeys = new Map<number, { key: string; created: boolean }>();
      const disconnected = new AbortController();
      const signal = AbortSignal.any([input.signal, disconnected.signal]);
      try {
        if (input.modelState().blocked) throw new Error("model-unsettled");
        notify("STANDING_CONNECTING");
        stage = "connect";
        client = ports.createClient(lease.material.value, credentials, signal, () => disconnected.abort());
        clientSettled = false;
        restore = ports.installFence(client, () => { disconnected.abort(); throw transportError(); });
        try { await bounded(() => client!.connect(), signal, 30_000); }
        catch (error) {
          // MTProto auth/RPC refusals retain their non-retryable classification.
          // A socket/handshake rejection need not have called onError yet.
          if (error && typeof error === "object" && "errorMessage" in error) throw error;
          throw transportError();
        }
        stage = "self"; const self = await bounded(() => client!.getMe(), signal, 30_000);
        if (input.enableImages === true) mediaReader = ports.mediaReader?.(client, signal);
        const cursor = state.cursor();
        if (input.openConversation) references = createConversationReferences(prepared.binding);
        stage = "adapter"; adapter = await bounded(() => ports.adapter({ client: client!, binding: prepared.binding, self, signal,
          ...(input.observedSource && observedBinding ? { observedSource: { title: input.observedSource.title,
            ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
            ...(observedBinding.expectedPeerId ? { expectedPeerId: observedBinding.expectedPeerId } : {}),
            async onResolved(candidate) { await observedBinding!.bind(candidate); resolvedSourcePeerId = candidate.peerId; } } } : {}),
          enableImages: input.enableImages === true,
          ...(mediaReader ? { readMediaFile: mediaReader.readMediaFile } : {}),
          ...(input.enableInitiative === true ? { initiative: { enabled: initiativeAllowed } } : {}),
          ...(groupToolsFlag === true ? { enableGroupTools: true } : {}),
          ...(artifactsFlag === true ? { enableArtifacts: true } : {}),
          ...(actionsFlag === true ? { enableBoundActions: true } : {}),
          ...(references ? { references, enableSelfHistory: true } : {}),
          startedAt: Math.floor(ports.now() / 1000), ...(cursor === undefined ? {} : { resumeCursor: cursor }),
          checkpointCursor: id => state.checkpointCursor(id),
          checkpointQuestion: async (primary, context) => {
            const recorded = await journal!.recordQuestion({ primary,
              ...(context ? { source: { date: context.primary.date, displayName: context.primary.displayName } } : {}) });
            questionKeys.set(primary.messageId, recorded);
          } }), signal, 30_000);
        if (input.enableCommunityObservation === true && workspace && resolvedSourcePeerId) {
          const binding = { workspaceId: workspace.workspaceId, accountId: prepared.binding.accountId,
            internalPeerId: prepared.binding.peerId, observedSourcePeerId: resolvedSourcePeerId };
          // Open only after the adapter verified and durably pinned this exact source.
          // Separate stores never import another workspace's memory or journal.
          try {
            communitySettings ??= await openStandingCommunitySettings({ directory: join(input.stateDirectory, "community-settings"),
              passphrase: credentials.passphrase, ...binding });
            communityState ??= await openStandingCommunityObserverState({ directory: join(input.stateDirectory, "community-observer"),
              passphrase: credentials.passphrase, binding: { workspaceId: binding.workspaceId, accountId: binding.accountId,
                internalPeerId: binding.internalPeerId, sourcePeerId: binding.observedSourcePeerId } });
            communityOutbox ??= await openStandingCommunityAlertOutbox({ directory: join(input.stateDirectory, "community-alerts"),
              passphrase: credentials.passphrase, binding });
          } catch { /* Optional observation failure must not disable internal conversation. */ }
        }
        const historyObservedSource = workspace && resolvedSourcePeerId ? Object.freeze({
          kind: "observed-source" as const, sourceRef: "community" as const,
          workspaceId: workspace.workspaceId, peerId: resolvedSourcePeerId }) : undefined;
        if (input.openConversation) {
          if (!adapter.selfHistory || !references) throw new Error("history-unavailable");
          try { ownActionMemory = await openStandingOwnActionMemory({ binding: prepared.binding, passphrase: credentials.passphrase,
            references, scopeRef: sharedScopeRef, signal });
            if (!ownActionCheckpointFailed) for (const event of ownActionCheckpoint?.read() ?? []) ownActionMemory.observe(event);
          }
          catch { dropOwnActionMemory(); }
          if (stopping()) throw new Error("stopped");
          if (groupToolsFlag === true && (!adapter.extraTools || !adapter.closeCapabilities)) throw new Error("group-tools-unavailable");
          if (artifactsFlag === true) artifacts = (ports.artifactRuntime ?? createStandingArtifactRuntime)({ signal,
            stateDirectory: input.stateDirectory, passphrase: credentials.passphrase, binding: prepared.binding,
            ports: { openOutbox: async options => wrapArtifactStore(await openEncryptedArtifactOutbox(options), observeOwnAction) },
            killed: () => ports.killed(input.paths.killSwitchPath) });
          if (actionsFlag === true) actions = (ports.actionRuntime ?? createStandingBoundActionRuntime)({ signal,
            stateDirectory: input.stateDirectory, passphrase: credentials.passphrase, binding: prepared.binding,
            ports: { openJournal: async options => wrapActionJournal(await openStandingActionJournal(options), options.binding, observeOwnAction) },
            killed: () => ports.killed(input.paths.killSwitchPath) });
          if (input.enableHistoryTasks === true) {
            historyMemory = createStandingHistoryTaskMemory({ binding: prepared.binding, references,
              scopeRef: sharedScopeRef, signal });
            await assertPilotPrivateDirectory(input.stateDirectory);
            for (const directory of [join(input.stateDirectory, "history-tasks"), ...Object.values(historyDirectories), historyDispositionDirectory, historyReportDirectory]) {
              try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as { code?: unknown }).code !== "EEXIST") throw error; }
              await assertPilotPrivateDirectory(directory);
            }
            if (historyChronicle) {
              try { historyChronicleCache = await (ports.historyChronicleCache ?? openStandingHistoryChronicleCache)({
                directory: join(input.stateDirectory, "history-tasks", "chronicle"), passphrase: credentials.passphrase }); }
              catch {
                // Derived-cache availability cannot erase already-persisted
                // task reuse receipts. Keep that protocol active with misses.
                historyChronicleCache = Object.freeze({ async lookup() { return undefined; }, async remember() { return undefined; },
                  async catalog() { return Object.freeze([]); }, async close() {} });
              }
              if (historyParallel && workspace) {
                try { historyPeriodChronicleStore = await (ports.historyPeriodChronicleStore ?? openStandingHistoryPeriodChronicleStore)({
                  directory: join(input.stateDirectory, "history-tasks", "period-chronicle"), passphrase: credentials.passphrase }); }
                catch { /* Optional neutral notes are unavailable; primary analysis remains enabled. */ }
              }
            }
            historyManager = await openStandingHistoryTaskManager({ ...(historyObservedSource ? { observedSource: historyObservedSource } : {}), directories: { pages: historyDirectories.pages, control: historyDirectories.control,
              analysis: historyDirectories.analysis, attempts: historyDirectories.attempts, delivery: historyDirectories.delivery,
              disposition: historyDispositionDirectory }, passphrase: credentials.passphrase, binding: prepared.binding, signal,
              onObservation(event) {
                try { historyMemory?.observe(event, Math.floor(ports.now() / 1000)); }
                catch { invalidateHistoryMemory(); }
              },
              async onCancelled({ taskRef }) {
                const delivery = activeTaskDelivery;
                if (delivery?.taskRef === taskRef) delivery.controller.abort();
                await historyRunner?.revoke(taskRef);
                if (delivery?.taskRef === taskRef) await delivery.settlement;
              } });
            historyRuntime = createStandingHistoryTaskRuntime({ binding: prepared.binding, signal, manager: historyManager });
          }
          const extraTools = Object.freeze([...chatSearchHandlers, ...(groupToolsFlag === true ? adapter.extraTools! : []),
            ...(artifacts?.handlers ?? []), ...(actions?.handlers ?? []), ...(repository?.handlers ?? []), ...(historyRuntime?.handlers ?? []), ...learningHandlers, ...observedHandlers, ...observationHandlers]);
          conversation = await input.openConversation({ history: adapter.selfHistory, signal,
            ...(input.workProfile ? { workProfile: input.workProfile } : {}),
            extraTools });
          if (resolvedSourcePeerId && communitySettings && communityState && communityOutbox && historyManager &&
              conversation.acquireCommunityAssessmentAdmission && conversation.verifyCommunityAssessmentSettlement) {
            communityAssessment = createStandingCommunityAssessmentPort({
              prepare: () => conversation!.prepare(),
              acquireCommunityAssessmentAdmission: ref => conversation!.acquireCommunityAssessmentAdmission!(ref),
              verifyCommunityAssessmentSettlement: value => conversation!.verifyCommunityAssessmentSettlement!(value),
            }, signal);
            communityObserver = createStandingCommunityObserver({ settings: communitySettings, state: communityState, outbox: communityOutbox,
              assess: (ref, body, callSignal) => communityAssessment!.assess(ref, body, callSignal), signal,
              now: () => ports.now(), onVerified() { verifiedReplies++; notify("STANDING_REPLY_VERIFIED"); } });
          }
          if (historyManager) {
            if (typeof conversation.acquireAnalysisAdmission !== "function" || typeof conversation.verifyAnalysisSettlement !== "function" || typeof conversation.verifyAnalysisReady !== "function") throw new Error("scoped-history-connection-required");
            if (historyParallel && (conversation.concurrentAnalysis !== true || typeof conversation.acquireParallelAnalysisAdmissions !== "function" ||
              typeof conversation.verifyAnalysisWorkReleased !== "function")) throw new Error("parallel-history-connection-required");
            historyRunner = await openStandingHistoryTaskRunner({ adapter, ...(historyObservedSource ? { observedSource: historyObservedSource } : {}), directories: { pages: historyDirectories.pages, control: historyDirectories.control,
              analysis: historyDirectories.analysis, attempts: historyDirectories.attempts, delivery: historyDirectories.delivery,
              disposition: historyDispositionDirectory, reports: historyReportDirectory }, passphrase: credentials.passphrase, binding: prepared.binding, signal,
              manager: historyManager, connection: { prepare: () => conversation!.prepare(), acquireAnalysisAdmission: (ref, previous, options) => conversation!.acquireAnalysisAdmission!(ref, previous, options),
                ...(conversation.prepareAnalysis ? { prepareAnalysis: () => conversation!.prepareAnalysis!() } : {}),
                ...(conversation.concurrentAnalysis === true ? { concurrentAnalysis: true as const } : {}),
                ...(historyParallel ? { acquireParallelAnalysisAdmissions: (refs: readonly string[], previous?: StandingHistoryAnalysisNativeBinding, options?: Readonly<{ requireNewEpoch: true }>) => conversation!.acquireParallelAnalysisAdmissions!(refs, previous, options),
                  verifyAnalysisWorkReleased: (binding: StandingHistoryAnalysisNativeBinding, workRef: string) => conversation!.verifyAnalysisWorkReleased!(binding, workRef) } : {}) },
              ...(conversation.concurrentAnalysis === true ? { concurrentAnalysis: true as const } : {}),
              ...(historyParallel ? { parallel: {
                directory: join(input.stateDirectory, "history-tasks", "parallel"),
                maintenanceDirectory: join(input.stateDirectory, "history-tasks", "parallel-maintenance"),
                maxLeaves: historyParallel.maxLeaves,
              } } : {}),
              verifyOwnerSettled: value => conversation!.verifyAnalysisSettlement!(value),
              ...(historyChronicle && historyChronicleCache ? { chronicle: { cache: historyChronicleCache, producer: historyChronicle.producer,
                reuseDirectory: join(input.stateDirectory, "history-tasks", "reuse"),
                ...(historyPeriodChronicleStore && workspace ? { periods: { store: historyPeriodChronicleStore, workspaceId: workspace.workspaceId } } : {}) } } : {}),
              ...(communityObserver ? { backgroundParticipant: { due: communityObserver.due, step: communityObserver.step } } : {}),
              onDiscovered(intent) {
                try { historyMemory?.remember(intent, Math.floor(ports.now() / 1000)); }
                catch { invalidateHistoryMemory(); }
              },
              onAnalysisReady({ intent, note }) {
                if (!acceptOwnActionCaptures) return;
                try {
                  requireStandingChronicleNote(note, { ...prepared.binding, requesterId: intent.requesterId });
                  chronicleNotes.delete(intent.taskId); chronicleNotes.set(intent.taskId, { requesterId: intent.requesterId, note });
                  if (chronicleNotes.size > 8) chronicleNotes.delete(chronicleNotes.keys().next().value!);
                } catch { /* Optional notes cannot alter task execution. */ }
              } });
          }
        }
        notify("STANDING_ONLINE");
        while (!stopping()) {
          // Persist only at the serial boundary after prior delivery work joined.
          // This derived memory never decides admission, replay or settlement.
          await flushOwnActionCheckpoint();
          if (stopping()) break;
          stage = "wait";
          let selected: StandingSelection;
          if (historyRunner) {
            let work: Awaited<ReturnType<StandingHistoryTaskRunner["poll"]>>;
            try { work = await historyRunner.poll(); }
            catch (error) { recordWaitFailure(error, "history-poll"); invalidateHistoryMemory(); throw error; }
            const progress = standingHistoryWorkProgress(work);
            if (progress) observeHistoryProgress(progress);
            if (work.kind === "idle") { await ports.wait(1000, signal); continue; }
            if (work.kind === "more") continue;
            if (work.kind === "background") {
              if (work.outcome.kind === "analysis-running") { await ports.wait(1000, signal); continue; }
              // A planner quantum can change durable progress after its status
              // read. Retain purpose, but do not present that earlier status as
              // the result of the read/analysis/delivery operation.
              if (work.outcome.kind === "read" || work.outcome.kind === "analysis" || work.outcome.kind === "recovered" || work.outcome.kind === "task-blocked" ||
                  (work.outcome.kind === "stalled" && ["consumed-without-prepared", "prior-owner-unavailable"].includes(work.outcome.reason))) invalidateHistoryMemory(work.outcome.taskRef);
              else if (work.outcome.kind === "ready") invalidateHistoryMemory(work.outcome.intent.taskId);
              if (work.outcome.kind === "ready") {
                const ready = work.outcome;
                const previous = await readStandingHistoryTaskDelivery({ directory: historyDirectories.delivery,
                  passphrase: credentials.passphrase, intent: ready.intent, signal });
                // Existing or unreadable custody is never a new send budget.
                if ((previous.storage !== "absent" || previous.consumed) && !(previous.storage === "ready" && previous.nextPart !== undefined)) continue;
                const controller = new AbortController();
                const deliverySignal = AbortSignal.any([signal, controller.signal]);
                stage = "send";
                const delivery = Promise.resolve().then(async () => {
                  let finalReport: Parameters<typeof runStandingHistoryTaskDelivery>[0]["finalReport"];
                  if (previous.storage === "absent") {
                    if (input.historyFinalReport) {
                      finalReport = await input.historyFinalReport({ intent: ready.intent, readiness: ready.result, signal: deliverySignal });
                    } else {
                      stage = "model";
                      const finalized = await finalizeStandingHistoryReport({
                        intent: ready.intent, readiness: ready.result,
                        directories: { pages: historyDirectories.pages, control: historyDirectories.control,
                          analysis: historyDirectories.analysis, reports: historyReportDirectory },
                        passphrase: credentials.passphrase, signal: deliverySignal, requestRef: "history-final-" + randomUUID(),
                        onStage: phase => observeHistoryProgress({ taskRef: ready.intent.taskId, phase, reason: null }),
                        connection: { ...(conversation!.acquireParallelAnalysisAdmissions ? {
                          acquireParallelAnalysisAdmissions: conversation!.acquireParallelAnalysisAdmissions,
                        } : {}), async acquireAnalysisAdmission(requestRef, previousBinding, options) {
                          if (deliverySignal.aborted) throw new StandingHistoryTaskDeliveryError("cancelled");
                          if (conversation!.prepareAnalysis) await conversation!.prepareAnalysis!();
                          else await conversation!.prepare();
                          if (deliverySignal.aborted) throw new StandingHistoryTaskDeliveryError("cancelled");
                          return conversation!.acquireAnalysisAdmission!(requestRef, previousBinding, options);
                        } },
                        verifyOwnerSettled: value => conversation!.verifyAnalysisSettlement!(value),
                      });
                      if (finalized.kind !== "ready") {
                        observeHistoryProgress({ taskRef: ready.intent.taskId, phase: finalized.reason === "cancelled" ? "cancelled" : "stalled",
                          reason: finalized.reason === "cancelled" ? "cancelled" : finalized.reason === "stale" ? "stale"
                            : finalized.reason === "quality-rejected" || finalized.reason === "attempt-limit" ? "report-quality-required"
                              : finalized.reason === "material-unavailable" ? "report-required" : "consumed-without-prepared" });
                        throw new StandingHistoryTaskDeliveryError(finalized.reason === "cancelled" ? "cancelled" :
                          finalized.reason === "stale" ? "stale" : "report-required");
                      }
                      finalReport = finalized.report;
                      observeHistoryProgress({ taskRef: ready.intent.taskId, phase: "report-ready", reason: null });
                    }
                  }
                  stage = "send";
                  observeHistoryProgress({ taskRef: ready.intent.taskId, phase: "delivering", reason: null });
                  return runStandingHistoryTaskDelivery({
                  intent: ready.intent, readiness: ready.result, directories: historyDirectories,
                  passphrase: credentials.passphrase, ticket: ready.ticket, signal: deliverySignal,
                  ...(finalReport ? { finalReport } : {}),
                  verifyOwnerReady: value => conversation!.verifyAnalysisReady!(value),
                  onOwnAction: observeOwnAction,
                  });
                });
                activeTaskDelivery = { taskRef: ready.intent.taskId, controller, settlement: delivery.then(() => {}, () => {}) };
                try {
                  const result = await delivery;
                  if (result.result.state === "verified") {
                    if (result.deliveryComplete) observeHistoryProgress({ taskRef: ready.intent.taskId, phase: "delivered", reason: null });
                    // Count the verified Telegram message, not an inferred task
                    // completion from a multipart prefix.
                    verifiedReplies++; if (result.deliveryComplete) failures = 0; notify("STANDING_REPLY_VERIFIED");
                  }
                  else if (result.result.state === "unknown") {
                    observeHistoryProgress({ taskRef: ready.intent.taskId, phase: "stalled", reason: "delivery-unknown" });
                    notify("STANDING_UNKNOWN_CONSUMED"); reconnect = !stopping(); break;
                  }
                } catch (error) {
                  if (error instanceof StandingHistoryTaskDeliveryError && error.code === "cancelled")
                    observeHistoryProgress({ taskRef: ready.intent.taskId, phase: "cancelled", reason: "cancelled" });
                  // The delivery operation has already joined its callbacks and
                  // stores in its own finally. A content/head refusal belongs
                  // to this task; owner, close and shared custody faults do not.
                  if (!signal.aborted && error instanceof StandingHistoryTaskDeliveryError) {
                    if (error.code === "coverage" || error.code === "stale" || error.code === "overflow" || error.code === "report-required") {
                      await recordStandingHistoryTaskDisposition({ directory: historyDispositionDirectory, passphrase: credentials.passphrase,
                        intent: ready.intent, sourceHead: ready.result.sourceHead, analysisHead: ready.result.expectedHead, reason: error.code, signal });
                      if (error.code !== "report-required") observeHistoryProgress({ taskRef: ready.intent.taskId, phase: "stalled", reason: error.code });
                      continue;
                    }
                    if (error.code === "cancelled" || error.code === "consumed") continue;
                  }
                  throw error;
                } finally { await activeTaskDelivery.settlement; activeTaskDelivery = undefined; }
              }
              continue;
            }
            selected = work.selection;
          } else { try { selected = await adapter.next(signal); } catch (error) { recordWaitFailure(error, "adapter-poll"); throw error; } }
          const primary = selected.primary;
          const questionRecord = questionKeys.get(primary.messageId); questionKeys.delete(primary.messageId);
          const key = questionRecord?.key;
          if (primary.chatId !== prepared.binding.peerId || primary.ownerId === prepared.binding.accountId ||
              !/^[1-9]\d{0,19}$/.test(primary.ownerId) || state.cursor() !== primary.messageId || !key) throw new StandingStateError();
          if (stopping()) {
            // A reopened question may already have an unknown admission owned
            // by an earlier process. STOP must never overwrite that history.
            if (questionRecord?.created) await journal.recordOutcome({ key, delivery: "not-sent", kind: "model", answer: null });
            break;
          }
          if (selected.initiative === true && !initiativeAllowed()) {
            if (questionRecord?.created) await journal.recordOutcome({ key, delivery: "not-sent", kind: "model", answer: null });
            await selected.finishInitiative!();
            continue;
          }
          // This UUID identifies the service's durable admission, not a provider
          // request or App Server job. Only the exclusive new admission may run.
          const requestRef = randomUUID();
          const admission = await journal.recordModelAdmission({ key, attemptRef: requestRef });
          if (!admission.created) { notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break; }
          if (stopping()) { await journal.recordOutcome({ key, delivery: "not-sent", kind: "model", answer: null }); break; }
          notify("STANDING_MODEL");
          stage = "model";
          // A warm turn's response and its eventual process shutdown are separate.
          // Prepare may rotate the native epoch, retaining this selected transport.
          let failedTurnNotice = false;
          const value = await withTyping(async () => {
            if (!conversation) return input.model(conversationModelInput(primary, selected.context), signal);
            let receivedImages: Awaited<ReturnType<NonNullable<StandingSelection["readInputImages"]>>> | undefined;
            try {
            // At most one fresh successor, and only on source-owned proof that
            // no model turn began. The original durable question admission stays.
            for (let admissionTry = 0; admissionTry < 2; admissionTry++) {
            const ready = await conversation.prepare();
            const restoration = ready.restoration ? await readStandingContextRestoration({
              journal: journal!, binding: prepared.binding, primary, references: references!, signal,
            }) : undefined;
            if (stopping()) throw new Error("stopped");
            if (artifacts) {
              if (!selected.openArtifactTransport) throw new Error("artifact-transport-unavailable");
              artifacts.begin({ requestRef, primary, openArtifactTransport: selected.openArtifactTransport });
            }
            let keepCapabilities = false;
            const visualImages: StandingVisualInput[] = [];
            try {
              let replyPhotoArtifact: StandingReplyPhotoArtifact | undefined;
              const inputPhotoArtifacts: StandingInputPhotoArtifact[] = [];
              let visualUnavailable = false;
              if (selected.readInputImages) {
                const received = receivedImages ??= await selected.readInputImages();
                visualUnavailable = received.unavailable === true;
                for (const image of received.images) {
                  try {
                    if (!artifacts || visualImages.length >= 2 ||
                        visualImages.reduce((n, item) => n + item.bytes.length, image.bytes.length) > 8 * 1024 * 1024) {
                      visualUnavailable = true; continue;
                    }
                    const imported = artifacts.importInputImage(requestRef, image.messageId, image.mimeType, image.bytes);
                    inputPhotoArtifacts.push({ messageId: image.messageId, artifactRef: imported.ref,
                      mimeType: image.mimeType, byteLength: imported.byteLength });
                    visualImages.push({ mimeType: image.mimeType, bytes: Buffer.from(image.bytes) });
                  } catch { visualUnavailable = true; }
                }
              }
              if (artifacts && selected.readOwnPhotoAnchor) {
                // The sole adapter refreshes the exact own-photo reply anchor.
                // Lookup derives one old outbox key; it neither scans nor replays delivery.
                // Terminal adapter failure propagates before spending a model turn.
                const anchor = await selected.readOwnPhotoAnchor();
                let saved: Awaited<ReturnType<typeof readVerifiedGeneratedImage>> | undefined;
                try {
                  if (anchor && !stopping() && !inputPhotoArtifacts.some(image => image.messageId === anchor.messageId)) {
                    saved = await (ports.readGeneratedImage ?? readVerifiedGeneratedImage)({
                      directory: join(input.stateDirectory, "media-outbox"), passphrase: credentials.passphrase,
                      accountId: prepared.binding.accountId, chatId: prepared.binding.peerId, ...anchor, signal });
                    if (!stopping() && visualImages.length < 2 &&
                        visualImages.reduce((n, item) => n + item.bytes.length, saved.bytes.length) <= 8 * 1024 * 1024) {
                      const imported = artifacts.importGeneratedImage(requestRef, saved.artifact, saved.bytes);
                      replyPhotoArtifact = { messageId: anchor.messageId, artifactRef: imported.ref, byteLength: imported.byteLength };
                      visualImages.push({ mimeType: "image/png", bytes: Buffer.from(saved.bytes) });
                    } else {
                      visualUnavailable = true;
                    }
                  }
                } catch { visualUnavailable = true; /* Optional old media never interrupts an ordinary answer. */ }
                finally { saved?.close(); }
              }
              if (stopping()) throw new Error("stopped");
              const asOf = Math.floor(ports.now() / 1000);
              let taskContext: ReturnType<ReturnType<typeof createStandingHistoryTaskMemory>["forPrimary"]> | undefined;
              try { taskContext = historyMemory?.forPrimary({ primary, asOf }); }
              catch { dropHistoryMemory(); }
              let ownActionContext: ReturnType<Awaited<ReturnType<typeof openStandingOwnActionMemory>>["forPrimary"]> | undefined;
              try { ownActionContext = ownActionMemory?.forPrimary({ primary, asOf }); }
              catch { dropOwnActionMemory(); }
              const sharedContext = readStandingSharedContext({ binding: prepared.binding, primary,
                references: references!, scopeRef: sharedScopeRef, asOf, signal,
                chronicleNotes: [...chronicleNotes.values()].reverse().filter(entry => entry.requesterId === primary.ownerId).slice(0, 1).map(entry => entry.note),
                ...(taskContext ? { taskContext } : {}),
                ...(ownActionContext ? { ownActionContext } : {}),
                ...(selected.context ? { context: selected.context } : {}), ...(restoration ? { restoration } : {}) });
              if (learningStore) learning = createStandingLearningTools({ store: learningStore,
                primary: { actorId: primary.ownerId, requestRef, messageId: primary.messageId }, signal });
              chatSearch = createStandingChatSearchTools({ requestRef, signal, async open(source) {
                if (source === "community" && observedBindingFailed) throw new StandingObservedSourceUnavailableError("binding-unavailable");
                if (!selected.openChatSearch) throw new Error("chat-search-unavailable");
                return selected.openChatSearch(source);
              } });
              if (workspace) observed = createStandingObservedSourceTools({ requestRef, signal, async open() {
                if (observedBindingFailed) throw new StandingObservedSourceUnavailableError("binding-unavailable");
                if (!selected.openObservedSource) throw new StandingObservedSourceUnavailableError(
                  selected.observedSourceStatus?.code ?? "not-configured");
                return selected.openObservedSource();
              } });
              if (communitySettings && communityObserver) observation = createStandingObservationTools({ store: communitySettings,
                primary: { actorId: primary.ownerId, requestRef, messageId: primary.messageId }, signal,
                // Every selection here is a real internal human message, including
                // semantic continuations/initiative. Source assessments never enter here.
                allowConfigure: true, now: () => Math.floor(ports.now() / 1000),
                runtimeStatus: () => communityObserver!.status(),
                async onChanged() { communityObserver!.policyChanged(); } });
              const query = [...primary.text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim()].slice(0, 64).join("").trim();
              const learned = await learning?.snapshot(query ? { query } : {});
              let observationSnapshot: Awaited<ReturnType<ReturnType<typeof createStandingObservationTools>["snapshot"]>> | undefined;
              try { observationSnapshot = await observation?.snapshot(); }
              catch { await finishObservation(); /* Optional policy read failure must not consume the internal answer. */ }
              const text = conversationModelInput(primary, selected.context, references, restoration, replyPhotoArtifact, sharedContext,
                ownActionCheckpointFailed ? "unavailable" : ownActionCheckpoint ? "bounded-checkpoint" : "not-configured",
                selected.initiative === true ? "initiative" : selected.continuation === true ? "continuation" : "direct",
                visualImages.length || visualUnavailable ? { images: inputPhotoArtifacts, unavailable: visualUnavailable, provided: visualImages.length,
                  ...(receivedImages?.sources?.length ? { sources: receivedImages.sources.filter(source => inputPhotoArtifacts.some(image => image.messageId === source.messageId)) } : {}) } : undefined,
                learned ? { snapshot: learned, requestRef } : undefined, observationSnapshot);
              if (actions) {
                if (!selected.openActions) throw new Error("action-transport-unavailable");
                const openActions = selected.openActions.bind(selected);
                actions.begin({ requestRef, primary, openActions: () => openActions(artifacts
                  ? ref => artifacts!.copyProfileImage(requestRef, ref) : undefined) });
              }
              historyRuntime?.begin({ requestRef, primary });
              const result = await conversation.turn(requestRef, text, visualImages.length ? visualImages : undefined);
              if (result.kind === "not-admitted") continue;
              keepCapabilities = true;
              return result;
            }
            finally {
              for (const image of visualImages) image.bytes.fill(0);
              if (!keepCapabilities) await Promise.all([artifacts?.finish(), actions?.finish(), historyRuntime?.finish(), finishLearning(), finishObserved(), finishChatSearch(true), finishObservation()]);
            }
            }
            throw new Error("epoch-admission-unavailable");
            } finally {
              for (const image of receivedImages?.images ?? []) image.bytes.fill(0);
            }
          }, selected.pulseTyping, signal).catch(async error => {
            // The encoder refused before turn dispatch. Capability cleanup above
            // has joined; do not invent a model result or release a nonexistent turn.
            if (error instanceof StandingModelInputSizeError) return undefined;
            // No answer dispatch has happened in this scope. A consumed model
            // failure can receive one fixed delivery notice only after its native
            // owner and background work settle. Never regenerate its answer or
            // infer that tool side effects did not happen.
            if (!conversation?.state().failedTurn || stopping() || selected.initiative === true || selected.continuation === true ||
                activeTaskDelivery || chatSearchClosings.size > 0 || chatSearchCloseFailed ||
                input.modelState().blocked || conversation.state().blocked || artifacts?.state().blocked || actions?.state().blocked) throw error;
            const backgroundClosing = [historyRunner?.close(), communityAssessment?.close()]
              .filter((value): value is Promise<void> => value !== undefined);
            for (const closing of backgroundClosing) void closing.catch(() => {});
            failedTurnClosure = conversation.close();
            const proof = await failedTurnClosure;
            await Promise.all(backgroundClosing);
            if (!proof.resourcesSettled || !proof.persisted || conversation.state().blocked || input.modelState().blocked || stopping()) throw error;
            recordFailure(error);
            failedTurnNotice = true;
            return undefined;
          });
          if (value === undefined) {
            if (stopping() || selected.initiative === true || selected.continuation === true) {
              await journal.recordOutcome({ key, delivery: "not-sent", kind: "deferred", answer: null });
              if (selected.initiative === true || selected.continuation === true) await selected.finishInitiative!();
              if (stopping()) break;
              continue;
            }
            const notice = failedTurnNotice ? "Не удалось завершить ответ из-за технического сбоя. Результат выполнения действий не подтверждён. Автоматически этот запрос не повторяю." : "Сообщение вместе с прикреплённым контекстом не помещается в один разбор. Текст не обрезал. Разбей запрос на части или попроси фоновый разбор истории за нужный период.";
            const reply = { chatId: prepared.binding.peerId, replyToMessageId: primary.messageId, text: notice };
            const delivery = trackTextDelivery(selected.transport);
            stage = "send";
            let verdict: PilotResult;
            try { verdict = await ports.dispatch({
              approved: { chatId: prepared.binding.peerId, accountId: prepared.binding.accountId, replyToMessageId: primary.messageId, maximumTextBytes: 4096 },
              reply, store: wrapPilotStore(ports.store(state.newOutbox(), credentials.passphrase), reply, observeOwnAction),
              transport: delivery.transport, signal, killSwitchEngaged: () => ports.killed(input.paths.killSwitchPath),
            }); } finally { await delivery.settle(); }
            const outcome = verdict.state === "verified" ? "verified" : verdict.state === "unknown" ? "unknown" : "not-sent";
            await journal.recordOutcome({ key, delivery: outcome, kind: "deferred", answer: notice });
            if (outcome === "verified") {
              verifiedReplies++; failures = 0; notify("STANDING_REPLY_VERIFIED");
              if (!failedTurnNotice) continue;
            }
            if (stopping()) break;
            notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break;
          }
          let delivered: "verified" | "not-sent" | "unknown" = "not-sent";
          let assessmentSuppressed = false;
          let capabilitiesFinished = false;
          const finishCapabilities = async () => {
            if (capabilitiesFinished) return;
            capabilitiesFinished = true;
            await Promise.all([artifacts?.finish(), actions?.finish(), historyRuntime?.finish(), finishLearning(), finishObserved(), finishChatSearch(), finishObservation()]);
          };
          try {
          if (input.modelState().blocked || conversation?.state().blocked) throw new Error("model-unsettled");
          let completed: ReturnType<typeof completedStandingResult>;
          try { completed = conversation ? validateStandingContent(value) : completedStandingResult(value); }
          catch (error) { blocked = true; throw error; }
          const participationExpired = () => (selected.initiative === true || selected.continuation === true) &&
            selected.isParticipationCurrent?.() === false;
          if (participationExpired() || selected.initiative === true && !initiativeAllowed() ||
              (selected.initiative === true || selected.continuation === true) && completed.kind !== "image" &&
              (completed.answer === null || completed.answer.trim() === STANDING_INITIATIVE_SILENCE)) {
            await finishCapabilities();
            await journal.recordOutcome({ key, delivery: "not-sent", kind: "model", answer: null,
              ...(completed.kind === "image" ? { image: { generation: "completed" as const } } : {}) });
            assessmentSuppressed = true;
            if (artifacts?.state().blocked || actions?.state().blocked) {
              notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break;
            }
            continue;
          }
          if (completed.kind === "image" && (input.enableImages !== true || !selected.imageTransport)) throw new Error("image-disabled");
          let answer = completed.answer;
          const plannedImageUse = !stopping() ? artifacts?.takeGeneratedImageUse(requestRef) : undefined;
          if (plannedImageUse && artifacts) {
            const selectedArtifacts = artifacts;
            answer = await withTyping(() => applyGeneratedImageUse({ target: plannedImageUse, requestRef,
              completed, artifacts: selectedArtifacts, ...(actions ? { actions } : {}), signal }), selected.pulseTyping, signal);
          }
          await finishCapabilities();
          // Optional participation can expire while generation/tool cleanup is
          // running. Consume it quietly before creating either media or text
          // delivery state; the adapter still revalidates at actual dispatch.
          if (participationExpired()) {
            await journal.recordOutcome({ key, delivery: "not-sent", kind: "model", answer: null,
              ...(completed.kind === "image" ? { image: { generation: "completed" as const } } : {}) });
            assessmentSuppressed = true;
            if (artifacts?.state().blocked || actions?.state().blocked) {
              notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break;
            }
            continue;
          }
          if (completed.kind === "image") {
            if (!selected.imageTransport) throw new Error("image-disabled");
            const journalAnswer = "[Изображение]" + (answer === null ? "" : "\n" + answer);
            if (stopping()) { await journal.recordOutcome({ key, delivery: "not-sent", kind: "model", answer: journalAnswer, image:{generation:"completed"} }); break; }
            stage = "send";
            const approved = { chatId: prepared.binding.peerId, accountId: prepared.binding.accountId,
              replyToMessageId: primary.messageId, origin: completed.image.artifact.origin };
            const store = wrapImageStore(await ports.imageStore({ directory: join(input.stateDirectory, "media-outbox"), passphrase: credentials.passphrase, approved }), observeOwnAction);
            let delivery: Awaited<ReturnType<StandingPorts["dispatchImage"]>>;
            try {
              delivered = "unknown";
              delivery = await ports.dispatchImage({ approved, registry: completed.image.registry, artifactRef: completed.image.artifact.ref,
                caption: answer ?? "", store, transport: selected.imageTransport, signal, killSwitchEngaged: () => ports.killed(input.paths.killSwitchPath) || selected.initiative === true && !initiativeAllowed() });
              // The verdict may be returned by an abort race. Its actual upload
              // and readback promises must settle before releasing media state.
              await delivery.settlement;
              delivered = delivery.delivery === "verified" ? "verified" : delivery.delivery === "unknown" ? "unknown" : "not-sent";
            } finally { store.close(); }
            await journal.recordOutcome({ key, delivery: delivery.delivery === "verified" ? "verified" : delivery.delivery === "unknown" ? "unknown" : "not-sent",
              kind: "model", answer: journalAnswer, image:{generation:"completed"} });
            if (delivery.delivery === "verified") { verifiedReplies++; failures = 0; notify("STANDING_REPLY_VERIFIED"); }
            else if (stopping()) break;
            else if (delivery.delivery === "unknown") { notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break; }
            else throw new Error("image-dispatch-refused");
            if (artifacts?.state().blocked || actions?.state().blocked) { notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break; }
            continue;
          }
          if (stopping()) { await journal.recordOutcome({ key, delivery: "not-sent", kind: "model", answer }); break; }
          // The model owner has confirmed resource settlement above. A fixed
          // failure notice is a fresh guarded reply, never a model/answer retry.
          stage = "send"; delivered = "unknown";
          const visibleAnswer = answer ?? STANDING_DEFERRED_REPLY;
          let formatted: ReturnType<typeof renderTelegramText> | undefined;
          if (formattingFlag === true) {
            try { const rendered = renderTelegramText(visibleAnswer); if (rendered.text.trim()) formatted = rendered; }
            catch { /* Preserve the bounded original answer if rich formatting is unsupported. */ }
          }
          const textDelivery = conversation ? trackTextDelivery(selected.transport) : undefined;
          const reply = { chatId: prepared.binding.peerId, replyToMessageId: primary.messageId, text: formatted?.text ?? visibleAnswer,
            ...(formatted ? { entities: formatted.entities } : {}) };
          let verdict: PilotResult;
          try { verdict = await ports.dispatch({
            approved: { chatId: prepared.binding.peerId, accountId: prepared.binding.accountId, replyToMessageId: primary.messageId, maximumTextBytes: 4096 },
            reply,
            store: wrapPilotStore(ports.store(state.newOutbox(), credentials.passphrase), reply, observeOwnAction), transport: textDelivery?.transport ?? selected.transport,
            signal, killSwitchEngaged: () => ports.killed(input.paths.killSwitchPath) || selected.initiative === true && !initiativeAllowed(),
          }); } finally {
            // runPilotReply can return an abort verdict before the underlying
            // send/read promise ends. Warm release must join that actual I/O.
            await textDelivery?.settle();
          }
          delivered = verdict.state === "verified" ? "verified" : verdict.state === "unknown" ? "unknown" : "not-sent";
          await journal.recordOutcome({ key, delivery: verdict.state === "verified" ? "verified" : verdict.state === "unknown" ? "unknown" : "not-sent",
            kind: answer === null ? "deferred" : "model", answer: formatted?.text ?? visibleAnswer,
            ...(formatted ? { entities: formatted.entities } : {}),
            ...(verdict.deliveryDiagnostic && (verdict.state === "unknown" || verdict.deliveryDiagnostic === "pre-dispatch-refused")
              ? { deliveryDiagnostic: verdict.deliveryDiagnostic } : {}) });
          if (verdict.state === "verified" && answer === null) { notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break; }
          else if (verdict.state === "verified") { verifiedReplies++; failures = 0; notify("STANDING_REPLY_VERIFIED"); }
          else if (stopping()) break;
          else if (verdict.state === "unknown") { notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break; }
          else if (verdict.state === "failed_terminal" && verdict.code === "pre-dispatch-refused") {
            // This selection is consumed, but a deleted/edited source must not
            // permanently stop the chat. Settle its adapter before new requests.
            reconnect = true; break;
          }
          else throw new Error("dispatch-refused");
          // Keep an uncertain tool operation consumed. Finish this explanation,
          // then settle the connection before accepting any fresh model work.
          if (artifacts?.state().blocked || actions?.state().blocked) { notify("STANDING_UNKNOWN_CONSUMED"); reconnect = true; break; }
          } finally {
            try { await finishCapabilities(); } finally {
            try {
              if (conversation) await conversation.release(requestRef, delivered);
            } catch (error) { if (!stopping()) { blocked = true; throw error; } }
            finally {
              try { closeStandingImage(value); }
              catch (error) { blocked = true; throw error; }
              if (assessmentSuppressed) await selected.finishInitiative!();
            }
            }
          }
        }
      } catch (error) {
        if (!stopping()) recordFailure(error);
        // A consumed native turn may fail while its resources can still close
        // cleanly. The finally block below must prove native persistence, all
        // callbacks and the sole Telegram client's settlement before reconnect.
        // The advanced cursor/admission journal prevents replay of that turn.
        const consumedTurnFailure = stage === "model" && conversation?.state().failedTurn === true;
        if (consumedTurnFailure && !stopping()) notify("STANDING_UNKNOWN_CONSUMED");
        reconnect = !stopping() && (retryable(error) || disconnected.signal.aborted || consumedTurnFailure);
        if (!reconnect && !stopping()) blocked = true;
      } finally {
        let nativeSettled = true;
        acceptOwnActionCaptures = false;
        chronicleNotes.clear();
        dropHistoryMemory();
        dropOwnActionMemory();
        // Group callbacks can await sole-client I/O while the native owner is
        // closing. Revoke now, start native closure, then destroy/settle that
        // client before joining callbacks; do not await an uncooperative invoke
        // before giving its existing owner the chance to interrupt transport.
        let capabilityClosing: Promise<void> | undefined;
        const mediaClosing = mediaReader?.close(); void mediaClosing?.catch(() => {});
        const artifactClosing = artifacts?.close(); void artifactClosing?.catch(() => {});
        const actionClosing = actions?.close(); void actionClosing?.catch(() => {});
        const learningClosing = finishLearning(); void learningClosing.catch(() => {});
        const observedClosing = finishObserved(); void observedClosing.catch(() => {});
        const chatSearchClosing = (async () => {
          await finishChatSearch(true);
          await Promise.all([...chatSearchClosings]);
          if (chatSearchCloseFailed) throw new Error("chat-search-close");
        })(); void chatSearchClosing.catch(() => {});
        const observationClosing = finishObservation(); void observationClosing.catch(() => {});
        const communityClosing = [communityObserver?.close(), communityAssessment?.close()].filter((value): value is Promise<void> => value !== undefined);
        for (const closing of communityClosing) void closing.catch(() => {});
        activeTaskDelivery?.controller.abort();
        const historyClosing = [historyRuntime?.close(), historyRunner?.close(), activeTaskDelivery?.settlement]
          .filter((value): value is Promise<void> => value !== undefined);
        for (const closing of historyClosing) void closing.catch(() => {});
        // This private filesystem capability is independently revocable even
        // when native/client settlement fails. Join admitted cache I/O before
        // releasing the service's credentials; late optional captures miss.
        const chronicleClosing = historyChronicleCache?.close(); void chronicleClosing?.catch(() => {});
        const periodChronicleClosing = historyPeriodChronicleStore?.close(); void periodChronicleClosing?.catch(() => {});
        let conversationClosing: ReturnType<StandingEpochConnection["close"]> | undefined;
        if (adapter?.closeCapabilities || mediaClosing || chatSearchClosings.size > 0) {
          adapter?.close();
          capabilityClosing = adapter?.closeCapabilities?.(); void capabilityClosing?.catch(() => {});
          if (conversation) {
            try { conversationClosing = failedTurnClosure ?? conversation.close(); } catch (error) { conversationClosing = Promise.reject(error); }
            void conversationClosing.catch(() => {});
          }
          if (client) {
            try { clientSettled = await ports.settle(client); } catch { clientSettled = false; }
            if (!clientSettled) blocked = true;
          }
        }
        if (conversation) {
          try {
            const final = await (conversationClosing ?? failedTurnClosure ?? conversation.close());
            nativeSettled = final.resourcesSettled === true && final.persisted === true;
          } catch { nativeSettled = false; }
          if (!nativeSettled || conversation.state().blocked) blocked = true;
        }
        adapter?.close();
        if (mediaClosing) {
          if (clientSettled) { try { await mediaClosing; } catch { nativeSettled = false; blocked = true; } }
          else { nativeSettled = false; blocked = true; }
        }
        if (capabilityClosing) {
          if (clientSettled) { try { await capabilityClosing; } catch { nativeSettled = false; blocked = true; } }
          else { nativeSettled = false; blocked = true; }
        }
        if (artifactClosing) {
          if (clientSettled) { try { await artifactClosing; } catch { nativeSettled = false; blocked = true; } }
          else { nativeSettled = false; blocked = true; }
        }
        if (actionClosing) {
          if (clientSettled) { try { await actionClosing; } catch { nativeSettled = false; blocked = true; } }
          else { nativeSettled = false; blocked = true; }
        }
        try { await learningClosing; } catch { nativeSettled = false; blocked = true; }
        try { await observedClosing; } catch { nativeSettled = false; blocked = true; }
        if (clientSettled || chatSearchClosings.size === 0) { try { await chatSearchClosing; } catch { nativeSettled = false; blocked = true; } }
        else { nativeSettled = false; blocked = true; }
        try { await observationClosing; } catch { nativeSettled = false; blocked = true; }
        if (chronicleClosing) { try { await chronicleClosing; } catch { nativeSettled = false; blocked = true; } }
        if (periodChronicleClosing) { try { await periodChronicleClosing; } catch { nativeSettled = false; blocked = true; } }
        if (communityClosing.length) {
          if (!clientSettled || (await Promise.allSettled(communityClosing)).some(value => value.status === "rejected")) { nativeSettled = false; blocked = true; }
        }
        if (historyClosing.length) {
          if (clientSettled) {
            const closed = await Promise.allSettled(historyClosing);
            if (closed.some(value => value.status === "rejected")) { nativeSettled = false; blocked = true; }
            else {
              try { await historyManager?.close(); }
              catch { nativeSettled = false; blocked = true; }
            }
          } else { nativeSettled = false; blocked = true; }
        } else if (historyManager) {
          try { await historyManager.close(); } catch { nativeSettled = false; blocked = true; }
        }
        // A timed-out owner may still have an actual history callback. Revoke
        // the adapter first, but never wipe shared references under that call.
        if (nativeSettled) references?.close();
        if (client && !capabilityClosing && !mediaClosing) {
          try { clientSettled = await ports.settle(client); } catch { clientSettled = false; }
          if (!clientSettled) blocked = true;
        }
        if (clientSettled) { try { restore?.(); } catch { blocked = true; } }
        if (input.modelState().blocked) blocked = true;
      }
      if (blocked || stopping()) break;
      if (!reconnect) { blocked = true; break; }
      failures++;
      notify("STANDING_RECONNECTING");
      await ports.wait(Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4)), input.signal);
    }
  } catch (error) { if (!stopping()) { recordFailure(error); blocked = true; } }
  finally {
    clearInterval(stopMonitor);
    if (clientSettled && !blocked) await flushOwnActionCheckpoint();
    try { await ownActionCheckpoint?.close(); } catch { /* Optional memory cannot block resource cleanup. */ }
    try { await learningStore?.close(); } catch { blocked = true; }
    for (const store of [communitySettings, communityState, communityOutbox]) {
      try { await store?.close(); } catch { blocked = true; }
    }
    try { await repository?.close(); } catch { blocked = true; }
    try { journal?.close(); } catch { blocked = true; }
    if (!clientSettled || input.modelState().blocked) blocked = true;
    if (clientSettled) {
      try { await lease?.release(); } catch { blocked = true; }
      if (!blocked && release) {
        try { await release(); lockPreserved = false; } catch { blocked = true; }
      }
    }
    input.credentials.apiHash = ""; input.credentials.passphrase = ""; input.credentials.apiId = 0;
  }
  const code: StandingCode = blocked ? "STANDING_BLOCKED" : "STANDING_STOPPED";
  notify(code);
  return Object.freeze({ status: blocked ? "blocked" : "stopped", code, clientSettled, lockPreserved, verifiedReplies, failureStage, failureCode,
    ...((failureStage as StandingStage) === "wait" && waitFailureOrigin ? { waitFailureOrigin, ...(waitFailureCode ? { waitFailureCode } : {}) } : {}) });
}

export async function runStandingService(input: StandingInput): Promise<StandingResult> {
  const invokeOwners = new WeakMap<GreetingClient, ReturnType<typeof createStandingInvokeOwner>>();
  const ports: StandingPorts = {
    prepare: input.workspace ? () => prepareStandingWorkspace(input.workspace!) : preparePilotGreeting,
    acquireLock: input.acquireLock ?? acquireProcessLock,
    openSession: (reference, passphrase) => openExistingEncryptedSessionLease({ reference, passphrase }),
    state: openStandingState, journal: openStandingDialogueJournal,
    createClient(material, credentials, signal, disconnected) {
      const client = new TelegramClient(new StringSession(material), credentials.apiId, credentials.apiHash, {
        ...clientOptions(), baseLogger: new Logger(LogLevel.NONE), requestRetries: 1, connectionRetries: 1, reconnectRetries: 0, autoReconnect: false,
      });
      client.setLogLevel(LogLevel.NONE); client.onError = async () => { disconnected(); };
      const invoke = client.invoke.bind(client);
      if (input.enableImages === true || input.openConversation || input.enableGroupTools === true || input.enableArtifacts === true) {
        const owner = createStandingInvokeOwner({ destroy: () => client.destroy(), signal, disconnected });
        invokeOwners.set(client, owner);
        client.invoke = request => owner.run(() => invoke(request));
      } else client.invoke = request => bounded(() => invoke(request), signal, 30_000);
      return client;
    },
    installFence: (client, refuse) => installBindingNetworkFence(client as TelegramClient, refuse),
    adapter: createStandingConversationAdapter, store: createEncryptedPilotStore, dispatch: runPilotReply,
    mediaReader: (client, signal) => createStandingMediaReadPort({ client: client as TelegramClient, signal }),
    imageStore: openEncryptedGeneratedImageOutbox, dispatchImage: runGeneratedImageDelivery,
    killed: greetingKillSwitchEngaged, now: Date.now,
    async settle(client) {
      const owner = invokeOwners.get(client);
      if (owner) return owner.settle();
      try { await bounded(() => client.destroy(), new AbortController().signal, 10_000); return true; }
      catch { return false; }
    },
    async wait(milliseconds, signal) {
      let abort: (() => void) | undefined;
      await new Promise<void>(done => {
        if (signal.aborted) { done(); return; }
        const timer = setTimeout(() => { if (abort) signal.removeEventListener("abort", abort); done(); }, milliseconds);
        abort = () => { clearTimeout(timer); done(); }; signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  return runStandingWithPorts(input, ports);
}
