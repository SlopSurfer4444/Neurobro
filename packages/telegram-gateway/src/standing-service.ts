import { TelegramClient } from "telegram";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
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
import { conversationModelInput, STANDING_INITIATIVE_SILENCE, type StandingReplyPhotoArtifact } from "./standing-model-input.js";
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
import { openStandingHistoryTaskRunner, type StandingHistoryTaskRunner } from "./standing-history-task-runner.js";
import { readStandingHistoryTaskDelivery, runStandingHistoryTaskDelivery, StandingHistoryTaskDeliveryError } from "./standing-history-task-delivery.js";
import { recordStandingHistoryTaskDisposition } from "./standing-history-task-disposition.js";
import type { StandingSelection } from "./standing-conversation-adapter.js";
import type { StandingVisualInput } from "./standing-visual-input.js";
import { createStandingMediaReadPort } from "./standing-media-read-port.js";
import type { StandingInputPhotoArtifact } from "./standing-model-input.js";
import type { StandingHistoryAnalysisStepConnection, StandingHistoryAnalysisOwnerSettlement } from "./standing-history-analysis-step.js";
import type { StandingHistoryAnalysisNativeBinding } from "./standing-history-analysis-attempt-store.js";

/** Source-owned warm runtime. turn returns content only after its native scope
 * and custody admission; close separately proves owned process settlement.
 * The service joins actual delivery before release and retains one Telegram
 * connection/reference set across native-only epoch rotation. */
export type StandingEpochConnection = Readonly<{
  prepare(): Promise<Readonly<{ restoration: boolean }>>;
  turn(requestRef: string, conversation: string, images?: readonly StandingVisualInput[]): Promise<CompletedStandingResult | Readonly<{ kind: "not-admitted"; reason: "prepare" | "limit" }>>;
  release(requestRef: string, delivery: "verified" | "not-sent" | "unknown"): Promise<void>;
  close(): Promise<Readonly<{ resourcesSettled: boolean; persisted: boolean }>>;
  state(): Readonly<{ blocked: boolean; failedTurn?: boolean }>;
  acquireAnalysisAdmission?: StandingHistoryAnalysisStepConnection["acquireAnalysisAdmission"];
  verifyAnalysisSettlement?(binding: StandingHistoryAnalysisNativeBinding): Promise<StandingHistoryAnalysisOwnerSettlement>;
  verifyAnalysisReady?(binding: StandingHistoryAnalysisNativeBinding): Promise<unknown>;
}>;

export type StandingCode = "STANDING_CONNECTING" | "STANDING_ONLINE" | "STANDING_MODEL" | "STANDING_REPLY_VERIFIED" | "STANDING_RECONNECTING" | "STANDING_UNKNOWN_CONSUMED" | "STANDING_STOPPED" | "STANDING_BLOCKED";
export type StandingStage = "prepare" | "lock" | "session" | "state" | "connect" | "self" | "adapter" | "wait" | "model" | "send" | "settle" | "none";
export type StandingFailure = "none" | "transport" | "binding" | "protocol" | "backlog" | "checkpoint" | "aborted" | "other";
export type StandingResult = Readonly<{ status: "stopped" | "blocked"; code: StandingCode; clientSettled: boolean; lockPreserved: boolean; verifiedReplies: number; failureStage: StandingStage; failureCode: StandingFailure }>;
export type StandingInput = Readonly<{
  paths: GreetingPaths; stateDirectory: string; credentials: GreetingCredentials;
  model: StandingModel; modelState(): { blocked: boolean };
  openConversation?(input: { history: { call(value: unknown): Promise<SelfHistoryToolResult> }; signal: AbortSignal; extraTools?: readonly EpochExtraTool[] }):
    StandingEpochConnection | Promise<StandingEpochConnection>;
  enableImages?: boolean;
  enableGroupTools?: boolean;
  enableArtifacts?: boolean;
  enableFormatting?: boolean;
  enableBoundActions?: boolean;
  enableHistoryTasks?: boolean;
  enableInitiative?: boolean;
  repositorySnapshot?: unknown;
  signal: AbortSignal; notify(code: StandingCode): void;
  acquireLock?: (path: string) => Promise<() => Promise<void>>;
}>;
export interface StandingPorts {
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
  let clientSettled = true, lockPreserved = false, blocked = false, verifiedReplies = 0;
  let stage: StandingStage = "prepare", failureStage: StandingStage = "none", failureCode: StandingFailure = "none";
  const recordFailure = (error: unknown) => {
    failureStage = stage;
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
    if (groupToolsFlag !== undefined && typeof groupToolsFlag !== "boolean" || groupToolsFlag === true && !input.openConversation) throw new Error("group-tools-config");
    if (artifactsFlag !== undefined && typeof artifactsFlag !== "boolean" || artifactsFlag === true && !input.openConversation || formattingFlag !== undefined && typeof formattingFlag !== "boolean") throw new Error("toolbelt-config");
    if (actionsFlag !== undefined && typeof actionsFlag !== "boolean" || actionsFlag === true && !input.openConversation) throw new Error("action-tools-config");
    if (input.enableHistoryTasks !== undefined && typeof input.enableHistoryTasks !== "boolean" || input.enableHistoryTasks === true && !input.openConversation) throw new Error("history-tasks-config");
    if (input.enableInitiative !== undefined && typeof input.enableInitiative !== "boolean" || input.enableInitiative === true && !input.openConversation) throw new Error("initiative-config");
    if (input.repositorySnapshot !== undefined) {
      if (!input.openConversation) throw new Error("repository-tools-config");
      repository = createRepositoryTools({ snapshot: input.repositorySnapshot, signal: input.signal });
    }
    const prepared = await ports.prepare(input.paths);
    if (stopping()) throw new Error("stopped");
    stage = "lock"; release = await ports.acquireLock(prepared.ownerLock); lockPreserved = true;
    const credentials = input.credentials;
    if (!Number.isSafeInteger(credentials.apiId) || credentials.apiId <= 0 || !/^[a-fA-F0-9]{32}$/.test(credentials.apiHash) || credentials.passphrase.length < 16) throw new Error("credentials");
    stage = "session"; lease = await ports.openSession(prepared.config.account.sessionFile, credentials.passphrase);
    stage = "state"; const state = await ports.state(input.stateDirectory, credentials.passphrase, prepared.binding);
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
      const sharedScopeRef = "scope_" + randomUUID().replaceAll("-", "");
      let artifacts: StandingArtifactRuntime | undefined;
      let actions: StandingBoundActionRuntime | undefined;
      let historyManager: StandingHistoryTaskManager | undefined;
      let historyRuntime: ReturnType<typeof createStandingHistoryTaskRuntime> | undefined;
      let historyRunner: StandingHistoryTaskRunner | undefined;
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
      let activeTaskDelivery: Readonly<{ taskRef: string; controller: AbortController; settlement: Promise<void> }> | undefined;
      const historyDirectories = Object.freeze(Object.fromEntries(["pages", "control", "analysis", "attempts", "delivery"].map(name =>
        [name, join(input.stateDirectory, "history-tasks", name)]))) as Readonly<{ pages: string; control: string; analysis: string; attempts: string; delivery: string }>;
      const historyDispositionDirectory = join(input.stateDirectory, "history-tasks", "disposition");
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
            for (const directory of [join(input.stateDirectory, "history-tasks"), ...Object.values(historyDirectories), historyDispositionDirectory]) {
              try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as { code?: unknown }).code !== "EEXIST") throw error; }
              await assertPilotPrivateDirectory(directory);
            }
            historyManager = await openStandingHistoryTaskManager({ directories: { pages: historyDirectories.pages, control: historyDirectories.control,
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
          const extraTools = artifacts || actions || repository || historyRuntime ? Object.freeze([...(groupToolsFlag === true ? adapter.extraTools! : []),
            ...(artifacts?.handlers ?? []), ...(actions?.handlers ?? []), ...(repository?.handlers ?? []), ...(historyRuntime?.handlers ?? [])]) : adapter.extraTools;
          conversation = await input.openConversation({ history: adapter.selfHistory, signal,
            ...(groupToolsFlag === true || artifactsFlag === true || actionsFlag === true || repository || historyRuntime ? { extraTools: extraTools! } : {}) });
          if (historyManager) {
            if (typeof conversation.acquireAnalysisAdmission !== "function" || typeof conversation.verifyAnalysisSettlement !== "function" || typeof conversation.verifyAnalysisReady !== "function") throw new Error("scoped-history-connection-required");
            historyRunner = await openStandingHistoryTaskRunner({ adapter, directories: { pages: historyDirectories.pages, control: historyDirectories.control,
              analysis: historyDirectories.analysis, attempts: historyDirectories.attempts, delivery: historyDirectories.delivery,
              disposition: historyDispositionDirectory }, passphrase: credentials.passphrase, binding: prepared.binding, signal,
              manager: historyManager, connection: { prepare: () => conversation!.prepare(), acquireAnalysisAdmission: (ref, previous) => conversation!.acquireAnalysisAdmission!(ref, previous) },
              verifyOwnerSettled: value => conversation!.verifyAnalysisSettlement!(value),
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
            catch (error) { invalidateHistoryMemory(); throw error; }
            if (work.kind === "idle") { await ports.wait(1000, signal); continue; }
            if (work.kind === "more") continue;
            if (work.kind === "background") {
              // A planner quantum can change durable progress after its status
              // read. Retain purpose, but do not present that earlier status as
              // the result of the read/analysis/delivery operation.
              if (work.outcome.kind === "read" || work.outcome.kind === "analysis" || work.outcome.kind === "recovered") invalidateHistoryMemory(work.outcome.taskRef);
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
                const delivery = Promise.resolve().then(() => runStandingHistoryTaskDelivery({
                  intent: ready.intent, readiness: ready.result, directories: historyDirectories,
                  passphrase: credentials.passphrase, ticket: ready.ticket, signal: deliverySignal,
                  verifyOwnerReady: value => conversation!.verifyAnalysisReady!(value),
                  onOwnAction: observeOwnAction,
                }));
                activeTaskDelivery = { taskRef: ready.intent.taskId, controller, settlement: delivery.then(() => {}, () => {}) };
                try {
                  const result = await delivery;
                  if (result.result.state === "verified") {
                    // Count the verified Telegram message, not an inferred task
                    // completion from a multipart prefix.
                    verifiedReplies++; if (result.deliveryComplete) failures = 0; notify("STANDING_REPLY_VERIFIED");
                  }
                  else if (result.result.state === "unknown") { notify("STANDING_UNKNOWN_CONSUMED"); reconnect = !stopping(); break; }
                } catch (error) {
                  // The delivery operation has already joined its callbacks and
                  // stores in its own finally. A content/head refusal belongs
                  // to this task; owner, close and shared custody faults do not.
                  if (!signal.aborted && error instanceof StandingHistoryTaskDeliveryError) {
                    if (error.code === "coverage" || error.code === "stale" || error.code === "overflow") {
                      await recordStandingHistoryTaskDisposition({ directory: historyDispositionDirectory, passphrase: credentials.passphrase,
                        intent: ready.intent, sourceHead: ready.result.sourceHead, analysisHead: ready.result.expectedHead, reason: error.code, signal });
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
          } else selected = await adapter.next(signal);
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
              const text = conversationModelInput(primary, selected.context, references, restoration, replyPhotoArtifact, sharedContext,
                ownActionCheckpointFailed ? "unavailable" : ownActionCheckpoint ? "bounded-checkpoint" : "not-configured",
                selected.initiative === true ? "initiative" : selected.continuation === true ? "continuation" : "direct",
                visualImages.length || visualUnavailable ? { images: inputPhotoArtifacts, unavailable: visualUnavailable, provided: visualImages.length,
                  ...(receivedImages?.sources?.length ? { sources: receivedImages.sources.filter(source => inputPhotoArtifacts.some(image => image.messageId === source.messageId)) } : {}) } : undefined);
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
              if (!keepCapabilities) await Promise.all([artifacts?.finish(), actions?.finish(), historyRuntime?.finish()]);
            }
            }
            throw new Error("epoch-admission-unavailable");
            } finally {
              for (const image of receivedImages?.images ?? []) image.bytes.fill(0);
            }
          }, selected.pulseTyping, signal);
          let delivered: "verified" | "not-sent" | "unknown" = "not-sent";
          let assessmentSuppressed = false;
          let capabilitiesFinished = false;
          const finishCapabilities = async () => {
            if (capabilitiesFinished) return;
            capabilitiesFinished = true;
            await Promise.all([artifacts?.finish(), actions?.finish(), historyRuntime?.finish()]);
          };
          try {
          if (input.modelState().blocked || conversation?.state().blocked) throw new Error("model-unsettled");
          let completed: ReturnType<typeof completedStandingResult>;
          try { completed = conversation ? validateStandingContent(value) : completedStandingResult(value); }
          catch (error) { blocked = true; throw error; }
          if (selected.initiative === true && !initiativeAllowed() ||
              (selected.initiative === true || selected.continuation === true) && completed.kind !== "image" &&
              (completed.answer === null || completed.answer.trim() === STANDING_INITIATIVE_SILENCE)) {
            await finishCapabilities();
            await journal.recordOutcome({ key, delivery: "not-sent", kind: "model", answer: null });
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
        activeTaskDelivery?.controller.abort();
        const historyClosing = [historyRuntime?.close(), historyRunner?.close(), activeTaskDelivery?.settlement]
          .filter((value): value is Promise<void> => value !== undefined);
        for (const closing of historyClosing) void closing.catch(() => {});
        let conversationClosing: ReturnType<StandingEpochConnection["close"]> | undefined;
        if (adapter?.closeCapabilities || mediaClosing) {
          adapter?.close();
          capabilityClosing = adapter?.closeCapabilities?.(); void capabilityClosing?.catch(() => {});
          if (conversation) {
            try { conversationClosing = conversation.close(); } catch (error) { conversationClosing = Promise.reject(error); }
            void conversationClosing.catch(() => {});
          }
          if (client) {
            try { clientSettled = await ports.settle(client); } catch { clientSettled = false; }
            if (!clientSettled) blocked = true;
          }
        }
        if (conversation) {
          try {
            const final = await (conversationClosing ?? conversation.close());
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
  return Object.freeze({ status: blocked ? "blocked" : "stopped", code, clientSettled, lockPreserved, verifiedReplies, failureStage, failureCode });
}

export async function runStandingService(input: StandingInput): Promise<StandingResult> {
  const invokeOwners = new WeakMap<GreetingClient, ReturnType<typeof createStandingInvokeOwner>>();
  const ports: StandingPorts = {
    prepare: preparePilotGreeting, acquireLock: input.acquireLock ?? acquireProcessLock,
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
