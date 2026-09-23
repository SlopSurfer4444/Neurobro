import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { runStandingWithPorts, type StandingInput, type StandingPorts, type StandingEpochConnection } from "../src/standing-service.js";
import { createStandingConversationAdapter } from "../src/standing-conversation-adapter.js";
import { openStandingState } from "../src/standing-state.js";
import { openStandingDialogueJournal } from "../src/standing-dialogue-journal.js";
import { createEncryptedPilotStore, runPilotReply } from "../src/pilot-outbox.js";
import { HISTORY_TASK_TOOL_SPECS } from "../src/standing-history-task-tools.js";
import { STANDING_CHAT_SEARCH_TOOL_SPEC } from "../src/standing-chat-search.js";
import { openStandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { readStandingHistoryTaskDelivery, StandingHistoryTaskDeliveryError, type StandingHistoryTaskDeliveryStatus } from "../src/standing-history-task-delivery.js";
import { readStandingHistoryTaskDisposition } from "../src/standing-history-task-disposition.js";
import { openStandingHistoryTaskStore } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { decryptSession } from "../src/session-crypto.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import type { EpochExtraTool, EpochToolResult } from "../src/standing-tool-dispatcher.js";
import { openStandingHistoryChronicleCache } from "../src/standing-history-chronicle-cache.js";
import { openStandingHistoryPeriodChronicleStore } from "../src/standing-history-period-chronicle-store.js";

test("membership loss during real adapter polling reproduces wait-other without analysis dispatch", async t => {
  const f = await fixture(t, "complete"), create = f.ports.createClient;
  let refused = 0;
  f.ports.createClient = (...args) => {
    const client = create(...args) as ReturnType<StandingPorts["createClient"]> & { invoke(request: Api.AnyRequest): Promise<unknown> };
    const invoke = client.invoke.bind(client);
    client.invoke = async request => {
      if (request instanceof Api.messages.GetHistory) { refused++; throw Object.assign(new Error("CHANNEL_PRIVATE"), { code: 400, errorMessage: "CHANNEL_PRIVATE" }); }
      return invoke(request);
    };
    return client;
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(refused, 1); assert.equal(result.status, "blocked");
  assert.equal(result.failureStage, "wait"); assert.equal(result.failureCode, "other");
  assert.equal(result.waitFailureOrigin, "adapter-poll");
  assert.equal(result.waitFailureCode, "protocol");
  const hostModule = new URL("../../../../project/verification/rm-0032-standing-host.mjs", import.meta.url).href;
  const projected = (await import(hostModule)).normalizeStandingResult(result);
  assert.equal(projected.waitFailureCode, "protocol");
  assert.equal(JSON.stringify(projected).includes("CHANNEL_PRIVATE"), false);
  assert.equal(result.clientSettled, true); assert.equal(result.verifiedReplies, 0);
  assert.equal(f.counts().nativeTurns, 0); assert.ok(f.events.includes("native-close"));
});

async function periodServiceFixture(t: TestContext, omit?: "chronicle" | "parallel" | "workspace") {
  const f = await fixture(t, "cancel"), original = f.input;
  const accountCustodyRoot = f.root + "-account", paths = { ...original.paths, authConfigPath: join(accountCustodyRoot, "auth.json") };
  const workspace = { workspaceId: "synthetic-period-service", target: { ...binding, title: "Synthetic period team" },
    accountCustodyRoot, appRoot: f.root, ...paths, stateDirectory: original.stateDirectory };
  const input: StandingInput = { ...original,
    ...(omit === "workspace" ? {} : { paths, workspace, workProfile: "community-team" as const }),
    ...(omit === "chronicle" ? {} : { historyChronicle: { producer: { model: "synthetic-model", promptVersion: "prompt", projectionVersion: "source", outputVersion: "output" } } }),
    ...(omit === "parallel" ? {} : { historyParallel: { maxLeaves: 2 } }),
    async openConversation(args) {
      const connection = await original.openConversation!(args);
      return { ...connection, concurrentAnalysis: true as const,
        async acquireParallelAnalysisAdmissions() { throw Error("startup fixture must not dispatch a wave"); },
        async verifyAnalysisWorkReleased() { throw Error("startup fixture has no release witnesses"); } };
    },
    notify(code) { original.notify(code); if (code === "STANDING_ONLINE") f.abort.abort(); },
  };
  return { ...f, input };
}

test("workspace parallel chronicle opens the fixed neutral store and joins its close before releasing credentials", async t => {
  const f = await periodServiceFixture(t); let opened = 0, closed = 0, releaseClose!: () => void, markClosing!: () => void;
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; }), closing = new Promise<void>(resolve => { markClosing = resolve; });
  const running = runStandingWithPorts(f.input, { ...f.ports, async historyPeriodChronicleStore(input) {
    opened++; assert.equal(input.directory, join(f.input.stateDirectory, "history-tasks", "period-chronicle")); assert.equal(input.passphrase, passphrase);
    const store = await openStandingHistoryPeriodChronicleStore(input);
    return { ...store, async close() { markClosing(); await closeGate; await store.close(); closed++; f.events.push("period-chronicle-closed"); } };
  } });
  try { await closing; assert.equal(f.events.includes("release-session"), false); assert.ok(f.events.includes("STANDING_ONLINE")); }
  finally { releaseClose(); }
  const result = await running; assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(opened, 1); assert.equal(closed, 1);
  assert.ok(f.events.indexOf("period-chronicle-closed") < f.events.indexOf("release-session")); assert.equal(f.counts().nativeTurns, 0);
});

test("neutral period store requires all three explicit workspace, chronicle and parallel gates", async t => {
  for (const omitted of ["chronicle", "parallel", "workspace"] as const) {
    const f = await periodServiceFixture(t, omitted); let opened = 0;
    const result = await runStandingWithPorts(f.input, { ...f.ports, async historyPeriodChronicleStore() { opened++; throw Error("gate must remain closed"); } });
    assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(opened, 0); assert.ok(f.events.includes("STANDING_ONLINE"));
    assert.equal((await readdir(join(f.input.stateDirectory, "history-tasks"))).includes("period-chronicle"), false);
  }
});

test("optional neutral store opening failure preserves admitted service startup and joined teardown", async t => {
  const f = await periodServiceFixture(t); let opened = 0;
  const result = await runStandingWithPorts(f.input, { ...f.ports, async historyPeriodChronicleStore() { opened++; throw Error("synthetic unavailable neutral notes"); } });
  assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(opened, 1); assert.ok(f.events.includes("STANDING_ONLINE"));
  assert.ok(f.events.includes("release-session")); assert.equal(f.counts().nativeTurns, 0);
});

test("unjoined neutral store closure blocks safe service replacement", async t => {
  const f = await periodServiceFixture(t);
  const result = await runStandingWithPorts(f.input, { ...f.ports, async historyPeriodChronicleStore(input) {
    const store = await openStandingHistoryPeriodChronicleStore(input); return { ...store, async close() { await store.close(); throw Error("synthetic close failure"); } };
  } });
  assert.equal(result.status, "blocked", serviceEvidence(f, result)); assert.equal(result.lockPreserved, true); assert.ok(f.events.includes("STANDING_ONLINE"));
});

test("explicit service chronicle pins producer identity, captures real leaves and joins service-owned cache closure", async t => {
  const f = await fixture(t, "complete"), producer = { model: "synthetic-admitted-model", promptVersion: "synthetic-native-prompt-hash", projectionVersion: "source-v1", outputVersion: "analysis-v1" };
  const expected = { ...producer }; let opened = 0, captured = 0, closed = 0;
  const result = await runStandingWithPorts({ ...f.input, historyChronicle: { producer } }, { ...f.ports, async historyChronicleCache(input) {
    opened++; assert.equal(input.directory, join(f.input.stateDirectory, "history-tasks", "chronicle"));
    const cache = await openStandingHistoryChronicleCache(input); producer.model = "mutated-after-service-admission";
    return { ...cache, async remember(value) { assert.deepEqual(value.producer, expected); assert.ok(f.counts().nativeClosed > 0); captured++; return cache.remember(value); },
      async close() { await cache.close(); closed++; f.events.push("chronicle-closed"); } };
  } });
  assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(opened, 1); assert.ok(captured > 0); assert.equal(closed, 1);
  assert.equal(f.counts().finalSends, 1); assert.ok(f.events.indexOf("chronicle-closed") < f.events.indexOf("release-session"));
  const partitions = await readdir(join(f.input.stateDirectory, "history-tasks", "chronicle")); assert.ok(partitions.length > 0);
});

test("service default leaves chronicle disabled and invalid opt-in fails before opening sessions", async t => {
  const normal = await fixture(t, "cancel"); let opened = 0;
  const result = await runStandingWithPorts(normal.input, { ...normal.ports, async historyChronicleCache() { opened++; throw Error("must remain disabled"); } });
  assert.equal(result.status, "stopped", serviceEvidence(normal, result)); assert.equal(opened, 0);
  assert.equal((await readdir(join(normal.input.stateDirectory, "history-tasks"))).includes("chronicle"), false);
  const invalid = await fixture(t, "cancel"); let evaluated = 0;
  const producer = { get model() { evaluated++; return "unsafe getter"; }, promptVersion: "p", projectionVersion: "s", outputVersion: "o" };
  const failed = await runStandingWithPorts({ ...invalid.input, historyChronicle: { producer } }, invalid.ports);
  assert.equal(failed.status, "blocked"); assert.equal(evaluated, 0); assert.equal(invalid.events.includes("lock"), false); assert.equal(invalid.counts().clients, 0);
});

test("unavailable optional chronicle becomes misses while normal service history still completes", async t => {
  const f = await fixture(t, "complete"); let opened = 0;
  const producer = { model: "synthetic-model", promptVersion: "prompt", projectionVersion: "source", outputVersion: "output" };
  const result = await runStandingWithPorts({ ...f.input, historyChronicle: { producer } }, { ...f.ports, async historyChronicleCache() { opened++; throw Error("synthetic unavailable derived cache"); } });
  assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(opened, 1); assert.equal(f.counts().finalSends, 1); assert.ok(f.counts().nativeTurns > 0);
});

const passphrase = "synthetic-service-history-passphrase";
const peer = new Api.PeerChannel({ channelId: bigInt(123) });
const binding = { accountId: "789", peerId: utils.getPeerId(peer) };
const self = () => new Api.User({ id: bigInt(789), self: true, firstName: "Synthetic self" });
const summary = "Synthetic durable summary";
function message(id: number, text: string, author = "456", date = 1000) {
  return new Api.Message({ id, date, message: text, peerId: peer, fromId: new Api.PeerUser({ userId: bigInt(author) }), ...(author === "789" ? { out: true } : {}) });
}
const resultBody = (value: unknown) => {
  const result = value as EpochToolResult; assert.equal(result.success, true);
  return JSON.parse(result.contentItems[0]!.text);
};
type Mode = "cancel" | "complete" | "restart" | "recall" | "refusal" | "multipart" | "no-report" | "finalizer";
async function fixture(t: TestContext, mode: Mode, saved?: { root: string; values: Api.Message[]; taskRef: string }) {
  const root = saved?.root ?? await mkdtemp(join(resolve(tmpdir()), "standing-service-history-"));
  if (!saved) t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const stateDirectory = join(root, "state"), abort = new AbortController();
  const state = await openStandingState(stateDirectory, passphrase, binding); if (state.cursor() === undefined) await state.checkpointCursor(90);
  const values = saved ? [...saved.values, ...(mode === "recall" ? [] : [message(200, "ПРОМПТ restarted status")])] : [message(50, "First available source", "456", 120), message(49, "Second available source", "999", 110),
    ...(mode === "cancel" ? [message(91, "ПРОМПТ create"), message(92, "ПРОМПТ foreign", "999"), message(93, "ПРОМПТ cancel")] :
      Array.from({ length: 16 }, (_, i) => message(91 + i, i === 0 ? "ПРОМПТ create" : "ПРОМПТ foreground " + (91 + i))))];
  const events: string[] = [], calls: Api.AnyRequest[] = [], foreground: number[] = [], due: boolean[] = [];
  const memories: { primary: number; tasks: any[]; ownActions: any[]; notes: any[]; coverage: any }[] = [];
  let tools: readonly EpochExtraTool[] = [], taskRef = saved?.taskRef ?? "", currentPrimary = 0;
  const historyTool = (name: string) => {
    const tool = tools.find(tool => tool.name === name); assert.ok(tool, `missing history tool: ${name}`); return tool;
  };
  let clients = 0, nativeTurns = 0, nativeReleased = 0, nativeClosed = 0, finalSends = 0, pulses = 0, afterFinal = 0, time = 0;
  let deliveryRefusals = 0, turnsAtRefusal = 0, laterPrimary = 0;
  let afterDeliveryPrimary = 0;
  const finalTickets: object[] = [], partial: StandingHistoryTaskDeliveryStatus[] = [];
  const finalReportBody = "User-facing report.\n".repeat(500);
  const chosenSummary = mode === "multipart" ? summary + "x".repeat(4096 - Buffer.byteLength(summary)) : summary;
  const batch = (rows: Api.TypeMessage[]) => new Api.messages.Messages({ messages: rows, users: [self(),
    new Api.User({ id: bigInt(456), firstName: "First requester" }), new Api.User({ id: bigInt(999), firstName: "Other requester" })], chats: [] });
  const client = {
    async connect() { events.push("connect"); }, async getMe() { return self(); }, async destroy() { events.push("destroy"); },
    async invoke(request: Api.AnyRequest): Promise<unknown> {
      calls.push(request); assert.ok(request.getBytes().length > 0);
      if (request instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({
        dialogs: [new Api.Dialog({ peer, topMessage: 106, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })],
        chats: [new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Synthetic group", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })], messages: [], users: [] });
      if (request instanceof Api.messages.GetHistory) return batch(values.filter(row => row.id > (request.minId ?? 0) && (!request.offsetId || row.id < request.offsetId) &&
        (!request.offsetDate || row.date < request.offsetDate)).sort((a, b) => b.id - a.id).slice(0, request.limit));
      if (request instanceof Api.channels.GetMessages || request instanceof Api.messages.GetMessages) {
        const id = (request.id[0] as Api.InputMessageID).id; return batch([values.find(row => row.id === id) ?? new Api.MessageEmpty({ id })]);
      }
      if (request instanceof Api.messages.SendMessage) {
        const id = Math.max(...values.map(row => row.id)) + 1, sent = message(id, request.message, "789");
        sent.replyTo = new Api.MessageReplyHeader({ replyToMsgId: (request.replyTo as Api.InputReplyToMessage).replyToMsgId });
        if (request.entities !== undefined) sent.entities = request.entities;
        values.push(sent); events.push("send:" + sent.replyTo.replyToMsgId);
        if (sent.replyTo.replyToMsgId === 91 && !request.message.startsWith("Foreground answer")) { finalSends++; events.push("final-send"); }
        return new Api.UpdateShortSentMessage({ id, out: true, pts: 1, ptsCount: 1, date: 1000 });
      }
      if (request instanceof Api.messages.SetTyping) return true;
      throw Error("unexpected synthetic Telegram request");
    }
  };
  const connection: StandingEpochConnection = {
    async prepare() { return { restoration: false }; }, state: () => ({ blocked: false }),
    async turn(requestRef, text) {
      const packet = JSON.parse(text), request = packet.currentRequest.text as string;
      const shared = packet.contextState.shared.snapshot;
      memories.push({ primary: currentPrimary, tasks: shared.items.filter((item: any) => item.source === "tasks").map((item: any) => item.evidence),
        ownActions: shared.items.filter((item: any) => item.source === "ownActions").map((item: any) => item.evidence),
        notes: shared.items.filter((item: any) => item.evidence.kind === "model-analysis-notes").map((item: any) => item.evidence),
        coverage: shared.coverage.tasks });
      foreground.push(currentPrimary); events.push("foreground:" + currentPrimary);
      assert.deepEqual(tools.map(tool => tool.name), [STANDING_CHAT_SEARCH_TOOL_SPEC.name, ...HISTORY_TASK_TOOL_SPECS.map(tool => tool.name)]);
      const scope = { requestRef, callRef: "task-call", signal: abort.signal };
      if (request === "create") {
        const created = resultBody(await historyTool("neurobro_create_history_task").call({ fromDate: 100, toDate: 200, timezone: "UTC", objective: "Summarize the available source" }, scope));
        taskRef = created.taskRef; assert.equal(created.control.state, "queued"); assert.equal(created.attempts.reservedAttempts, 0);
        assert.deepEqual(created.delivery, { state: "not-attempted", consumed: false });
        assert.deepEqual(created.disposition, { storage: "absent" });
      } else if (request === "foreign") {
        for (const tool of [historyTool("neurobro_history_task_status"), historyTool("neurobro_cancel_history_task")]) assert.equal((await tool.call({ taskRef }, scope) as EpochToolResult).success, false);
      } else if (request === "cancel") {
        assert.equal(resultBody(await historyTool("neurobro_history_task_status").call({ taskRef }, scope)).control.state, "queued");
        assert.equal(resultBody(await historyTool("neurobro_cancel_history_task").call({ taskRef }, { ...scope, callRef: "cancel" })).control.state, "cancelled");
      } else if (mode === "restart") assert.equal(resultBody(await historyTool("neurobro_history_task_status").call({ taskRef }, scope)).attempts.last.nodeCommitted, true);
      return { kind: "text", answer: "Foreground answer " + currentPrimary };
    },
    async release(requestRef, delivery) {
      assert.equal(delivery, "verified");
      const retired = await historyTool("neurobro_history_task_status").call({ taskRef }, { requestRef, callRef: "after-finish", signal: abort.signal }) as EpochToolResult;
      assert.equal(retired.success, false); events.push("foreground-released");
      if (mode === "cancel" && foreground.length === 3) abort.abort();
      if (mode === "recall") abort.abort();
    },
    async close() { events.push("native-close"); return { resourcesSettled: true, persisted: true }; },
    async acquireAnalysisAdmission(requestRef) {
      const nativeBinding = { epochId: nativeTurns.toString(16).padStart(32, "0"), requestRef, purpose: "history-analysis" as const };
      return { nativeBinding,
        async turnAnalysis(ref, text, supplied) {
          nativeTurns++; events.push("analysis"); assert.equal(JSON.parse(text).schema, "neurobro-history-analysis-input-v1");
          const scope = { requestRef: ref, callRef: "material", signal: abort.signal };
          const material = await supplied.analysisTools[0]!.call({}, scope) as EpochToolResult; assert.equal(material.success, true);
          supplied.onToolResultSent({ requestRef: ref, callRef: "material", name: "neurobro_analysis_material", result: material });
          const isFinal = JSON.parse(text).kind === "final-report", isReview = JSON.parse(text).kind === "final-report-review";
          if (isFinal) events.push("final-report");
          let review: unknown;
          if (isReview) {
            events.push("final-report-review");
            const candidate = resultBody(material).candidate;
            let body = "";
            for (let pageIndex = 1; pageIndex <= candidate.pages; pageIndex++) {
              const callRef = "candidate-" + pageIndex;
              const page = await supplied.analysisTools[0]!.call({ purpose: "final-report-candidate", pageIndex, position: null }, { ...scope, callRef }) as EpochToolResult;
              assert.equal(page.success, true); body += resultBody(page).text;
              supplied.onToolResultSent({ requestRef: ref, callRef, name: "neurobro_analysis_material", result: page });
            }
            assert.equal(body, finalReportBody); assert.notEqual(body, chosenSummary);
            review = { reportReview: { candidateHash: candidate.candidateHash, verdict: "accepted", findings: [] } };
          }
          const committed = await supplied.analysisTools[2]!.call(isReview ? review : isFinal ? { finalReport: { body: finalReportBody } } : { output: { summary: chosenSummary, claims: [] } }, { ...scope, callRef: "commit" }) as EpochToolResult;
          assert.equal(committed.success, true);
          supplied.onToolResultSent({ requestRef: ref, callRef: "commit", name: "neurobro_analysis_commit", result: committed });
          return { kind: "analysis", answer: "Saved", toolCalls: 2, toolRefusals: 0, scope: { epochId: nativeBinding.epochId, purpose: "history-analysis", requestRef: ref,
            threadId: "synthetic-analysis-thread", turnId: "turn-" + nativeTurns, turnNumber: nativeTurns, threadTurnNumber: nativeTurns } };
        },
        async releaseAnalysis() { nativeReleased++; }, async abortAndJoin() { events.push("analysis-joined"); }, async close() { nativeClosed++; }
      };
    },
    async verifyAnalysisSettlement(nativeBinding) { return { schema: "standing-analysis-owner-settlement-v1", nativeBinding, resourcesSettled: true,
      persisted: true, replacementReady: true, modelOutcome: "not-proven" }; },
    async verifyAnalysisReady(nativeBinding) {
      if (mode === "refusal") {
        // Deliberate typed boundary injection tests service classification, not
        // the delivery module's own coverage computation or native settlement.
        deliveryRefusals++; turnsAtRefusal = nativeTurns; events.push("synthetic-coverage-refusal");
        laterPrimary = Math.max(...values.map(row => row.id)) + 1;
        values.push(message(laterPrimary, "ПРОМПТ later after task refusal"));
        throw new StandingHistoryTaskDeliveryError("coverage");
      }
      return { schema: "standing-analysis-owner-ready-v1", nativeBinding, basis: "released-current-owner", modelOutcome: "not-proven" };
    }
  };
  const paths = { authConfigPath: join(root, "synthetic-auth"), bindingPath: join(root, "synthetic-binding"), modelReceiptPath: join(root, "synthetic-receipt"),
    attemptDirectory: join(root, "unused"), killSwitchPath: join(root, "STOP") };
  let input: StandingInput = { paths, stateDirectory, credentials: { apiId: 123, apiHash: "a".repeat(32), passphrase }, signal: abort.signal,
    async historyFinalReport({ intent, readiness }) {
      if (mode === "no-report") {
        deliveryRefusals++; turnsAtRefusal = nativeTurns; events.push("synthetic-coverage-refusal");
        laterPrimary = Math.max(...values.map(row => row.id)) + 1;
        values.push(message(laterPrimary, "ПРОМПТ later after missing report"));
        return undefined;
      }
      // Explicit host fixture output, not a production analysis-summary fallback.
      return { schema: "standing-history-final-report-v1", taskRef: intent.taskId,
        sourceHead: readiness.sourceHead, analysisHead: readiness.expectedHead, body: chosenSummary };
    },
    enableHistoryTasks: true, modelState: () => ({ blocked: false }), async model() { throw Error("cold model must not run"); },
    openConversation({ extraTools }) { tools = extraTools!; return connection; }, notify(code) { events.push(code); } };
  if (mode === "finalizer") { const { historyFinalReport: _lookup, ...defaults } = input; input = defaults; }
  const ports = {
    async prepare() { return { paths, config: { account: { sessionFile: "synthetic-no-auth" } }, binding, ownerLock: join(root, "lock") }; },
    async acquireLock() { events.push("lock"); return async () => { events.push("release-lock"); }; },
    async openSession() { return { material: { value: "synthetic-session" }, async release() { events.push("release-session"); } }; },
    state: openStandingState, journal: openStandingDialogueJournal,
    createClient() { clients++; return client; }, installFence() { return () => { events.push("restore-fence"); }; },
    async adapter(args: Parameters<typeof createStandingConversationAdapter>[0]) {
      assert.equal(args.client, client); assert.equal(args.enableSelfHistory, true);
      const actual = await createStandingConversationAdapter({ ...args, clock: () => time,
        async wait(ms, signal) { assert.equal(signal.aborted, false); time += ms; },
        async checkpointQuestion(primary, context) { currentPrimary = primary.messageId; await args.checkpointQuestion!(primary, context); } });
      return { ...actual, async pollWork(signal: AbortSignal, options: Readonly<{ backgroundDue: boolean }>) {
        due.push(options.backgroundDue); pulses++;
        // Permit one real idle discovery quantum before the next question.
        // The terminal fast path must restore purpose without a status tool.
        if (mode === "recall" && pulses === 2) values.push(message(200, "ПРОМПТ what did I ask before?"));
        if (mode === "complete" && finalSends === 1 && !afterDeliveryPrimary) {
          afterDeliveryPrimary = Math.max(...values.map(row => row.id)) + 1;
          values.push(message(afterDeliveryPrimary, "ПРОМПТ what did you just send?"));
        }
        if (mode === "multipart" && finalSends === 1 && partial.length === 0) partial.push(await readStandingHistoryTaskDelivery({
          directory: join(stateDirectory, "history-tasks", "delivery"), passphrase, intent: await readIntent() }));
        if (mode !== "cancel" && (finalSends >= (mode === "finalizer" ? 4 : mode === "multipart" ? 2 : 1) || deliveryRefusals > 0 || mode === "restart") && ++afterFinal > 12) abort.abort();
        if (pulses > 160) { abort.abort(); throw Error("synthetic pulse budget exhausted"); }
        const work = await actual.pollWork(signal, options);
        if (work.kind === "background" || work.kind === "idle") {
          const ticket = work.ticket;
          return { ...work, ticket: { ...ticket, openTaskReply(value: Parameters<typeof ticket.openTaskReply>[0]) {
            finalTickets.push(ticket); return ticket.openTaskReply(value);
          } } };
        }
        return work;
      } };
    },
    async settle(value: typeof client) { assert.equal(value, client); await client.destroy(); events.push("client-settled"); return true; },
    store: createEncryptedPilotStore, dispatch: runPilotReply, killed: () => false,
    async wait(_ms: number, signal: AbortSignal) { if (signal.aborted) throw Error("synthetic stop"); }, now: () => 1_000_000
  } as unknown as StandingPorts;
  const directories = { pages: join(stateDirectory, "history-tasks", "pages"), control: join(stateDirectory, "history-tasks", "control"),
    analysis: join(stateDirectory, "history-tasks", "analysis"), attempts: join(stateDirectory, "history-tasks", "attempts"), delivery: join(stateDirectory, "history-tasks", "delivery") };
  async function readIntent(): Promise<StandingHistoryTaskIntent> {
    return JSON.parse(await decryptSession(await readFile(join(directories.control, taskRef, "intent.enc"), "utf8"), passphrase)).intent;
  }
  async function readHeads() {
    const intent = await readIntent(), source = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" });
    const analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", readSourcePage: index => source.readPage(index) });
    try { return { sourceHead: (await source.status()).readProgress.chainHash, analysisHead: (await analysis.status()).headHash }; }
    finally { await analysis.close(); await source.close(); }
  }
  return { root, values, input, ports, abort, events, calls, foreground, due, memories, directories, readIntent, readHeads, finalTickets, partial, chosenSummary, finalReportBody,
    taskRef: () => taskRef, tools: () => tools, counts: () => ({ clients, nativeTurns, nativeReleased, nativeClosed, finalSends, pulses, deliveryRefusals, turnsAtRefusal, laterPrimary, afterDeliveryPrimary }) };
}

function serviceEvidence(f: Awaited<ReturnType<typeof fixture>>, result: Awaited<ReturnType<typeof runStandingWithPorts>>) {
  return JSON.stringify({ result, counts: f.counts(), events: f.events.slice(-24) });
}

test("history-enabled service registers universal search and three actor-bound tools and revokes them through foreground finish and service cleanup", async t => {
  const f = await fixture(t, "cancel"), result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(result.clientSettled, true); assert.equal(result.lockPreserved, false);
  assert.equal(result.verifiedReplies, 3); assert.deepEqual(f.foreground, [91, 92, 93]); assert.equal(f.counts().clients, 1);
  assert.deepEqual(f.memories[0]!.tasks, [], "cold cache makes no invented task claim");
  assert.deepEqual(f.memories[1]!.tasks, [], "another requester cannot see the owner's task");
  const recalled = f.memories[2]!.tasks.find(item => item.taskRef === f.taskRef());
  assert.ok(recalled, "actual create observation reaches a later primary without explicit lookup");
  assert.equal(recalled.description.objective, "Summarize the available source");
  assert.notEqual(f.memories[2]!.coverage.freshness, "current", "repacking cannot freshen cached task progress");
  assert.equal(f.memories[2]!.coverage.hasMore, null, "passive observations are not a complete task inventory");
  const intent = await f.readIntent(); assert.equal(intent.requesterId, "456"); assert.equal(intent.primaryMessageId, 91);
  const { pages, control, analysis, attempts } = f.directories;
  const manager = await openStandingHistoryTaskManager({ directories: { pages, control, analysis, attempts }, passphrase, binding, async onCancelled() {} });
  try { const status = await manager.status({ taskRef: f.taskRef(), requesterId: "456" }); assert.equal(status.control.state, "cancelled"); }
  finally { await manager.close(); }
  for (const tool of f.tools()) assert.equal((await tool.call({ taskRef: f.taskRef() }, { requestRef: "after-close", callRef: "after-close", signal: new AbortController().signal }) as EpochToolResult).success, false);
  assert.ok(f.events.indexOf("client-settled") < f.events.indexOf("release-lock")); assert.ok(f.events.includes("native-close"));
  assert.deepEqual(f.input.credentials, { apiId: 0, apiHash: "", passphrase: "" }); assert.equal(f.counts().finalSends, 0);
});

test("service fairly reads and analyzes persisted history then sends one final reply; restart never repeats that delivery", async t => {
  const f = await fixture(t, "complete"); let backgroundReadiness = 0;
  const result = await runStandingWithPorts({ ...f.input, async openConversation(input) {
    const connection = await f.input.openConversation!(input);
    return { ...connection, async prepareAnalysis() { backgroundReadiness++; return { restoration: false }; } };
  } }, f.ports);
  assert.ok(backgroundReadiness > 0, "service forwards the dedicated background readiness path to actual runner admission");
  assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(result.lockPreserved, false); assert.equal(f.counts().clients, 1);
  assert.equal(f.counts().finalSends, 1); assert.ok(f.counts().nativeTurns > 0); assert.equal(f.counts().nativeTurns, f.counts().nativeReleased);
  const afterDelivery = f.memories.find(memory => memory.primary === f.counts().afterDeliveryPrimary);
  assert.ok(afterDelivery, "foreground continues after the background result");
  const finalAction = afterDelivery.ownActions.find(action => action.kind === "text" && action.content.text?.includes(summary));
  assert.ok(finalAction, "actual background result enters own-action context without a history lookup");
  assert.equal(finalAction.verdict, "verified"); assert.equal(finalAction.currentAvailability, "not-checked");
  const note = afterDelivery.notes.find(item => item.taskRef === f.taskRef());
  assert.ok(note, "actual ready analysis supplies a source-linked chronicle note to later foreground");
  assert.equal(note.notes.summary.text, summary); assert.equal(note.notes.claimsStatus, "model-authored-unverified");
  assert.deepEqual(note.notes.claims, []); // This model fixture committed no claims; recall must not invent them.
  assert.equal(Object.hasOwn(note.notes, "nextPosition"), false);
  assert.equal(f.counts().nativeTurns, f.counts().nativeClosed); assert.ok(f.foreground.length >= 4);
  assert.deepEqual(f.foreground, [...f.foreground].sort((a, b) => a - b)); assert.ok(f.due.includes(true));
  const firstAnalysis = f.events.indexOf("analysis"); assert.ok(firstAnalysis > f.events.indexOf("foreground:92"));
  assert.ok(f.events.slice(firstAnalysis + 1).some(event => event.startsWith("foreground:")));
  const intent = await f.readIntent(), delivery = await readStandingHistoryTaskDelivery({ directory: f.directories.delivery, passphrase, intent });
  assert.equal(delivery.delivery, "verified"); assert.equal(delivery.consumed, true); assert.equal(delivery.leaseJoined, true);
  const source = await openStandingHistoryTaskStore({ directory: f.directories.pages, passphrase, intent, mode: "open" });
  const analysis = await openStandingHistoryAnalysisStore({ directory: f.directories.analysis, passphrase, intent, mode: "open", readSourcePage: index => source.readPage(index) });
  try {
    const sourceStatus = await source.status(), analysisStatus = await analysis.status(), node = await analysis.readNodeAt(1);
    assert.equal(sourceStatus.readProgress.committedPages, 2);
    assert.equal(analysisStatus.analysisNodes, 1, "wide runner packs source and terminal empty page into one durable leaf");
    assert.ok(node && "materials" in node.inputs); assert.equal(node.kind, "leaf");
    assert.equal(node.inputs.materials.length, 2);
    assert.deepEqual(node.coverage.map(span => span.pageIndex), [1, 2]);
    assert.equal(node.coverage.reduce((rows, span) => rows + span.range.toRow - span.range.fromRow, 0), 2);
    assert.equal(f.counts().nativeTurns, 1);
  } finally { await analysis.close(); await source.close(); }
  const names = await readdir(join(f.directories.delivery, f.taskRef()));
  const restarted = await fixture(t, "recall", { root: f.root, values: f.values, taskRef: f.taskRef() });
  const after = await runStandingWithPorts(restarted.input, restarted.ports);
  assert.equal(after.status, "stopped", serviceEvidence(restarted, after)); assert.deepEqual(restarted.foreground, [200]); assert.equal(restarted.counts().clients, 1);
  assert.equal(restarted.counts().finalSends, 0); assert.equal(restarted.counts().nativeTurns, 0);
  const restoredNote = restarted.memories[0]!.notes.find(item => item.taskRef === f.taskRef());
  assert.ok(restoredNote, "completed analysis is recalled from authenticated stores after a fresh service");
  assert.deepEqual(restoredNote, note, "cold recall preserves source versions, claims and coverage without another analysis");
  const remembered = restarted.memories[0]!.tasks.find(task => task.taskRef === f.taskRef());
  assert.equal(remembered?.description?.objective, "Summarize the available source");
  assert.equal(remembered.delivery, "unavailable", "discovering purpose is not delivery evidence");
  const restoredAction = restarted.memories[0]!.ownActions.find(action => action.actionRef === finalAction.actionRef);
  assert.ok(restoredAction, "background result survives a fresh service before any new send");
  assert.equal(restoredAction.content.text, finalAction.content.text);
  assert.equal(restoredAction.verdict, "verified"); assert.equal(restoredAction.currentAvailability, "not-checked");
  assert.deepEqual(await readdir(join(f.directories.delivery, f.taskRef())), names);
  assert.deepEqual(await readStandingHistoryTaskDelivery({ directory: f.directories.delivery, passphrase, intent }), delivery);
});

for (const mode of ["refusal", "no-report"] as const) test(`${mode} persists task-local disposition and leaves later foreground and restart usable`, async t => {
  const f = await fixture(t, mode), result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(result.lockPreserved, false); assert.equal(result.clientSettled, true);
  assert.equal(f.counts().clients, 1); assert.equal(f.counts().deliveryRefusals, 1); assert.equal(f.counts().finalSends, 0);
  assert.equal(f.counts().nativeTurns, f.counts().turnsAtRefusal); assert.equal(f.finalTickets.length, 0);
  assert.ok(f.events.indexOf("foreground:" + f.counts().laterPrimary) > f.events.indexOf("synthetic-coverage-refusal"));
  assert.equal(result.verifiedReplies, f.foreground.length);
  const intent = await f.readIntent(), heads = await f.readHeads(), directory = join(f.input.stateDirectory, "history-tasks", "disposition");
  const disposition = await readStandingHistoryTaskDisposition({ directory, passphrase, intent, ...heads });
  assert.equal(disposition.storage, "ready"); if (disposition.storage !== "ready") throw Error("missing disposition");
  assert.deepEqual(disposition.disposition, { schema: "standing-history-task-disposition-v1", reason: mode === "no-report" ? "report-required" : "coverage", ...heads });
  assert.equal((await readStandingHistoryTaskDelivery({ directory: f.directories.delivery, passphrase, intent })).storage, "absent");
  const names = await readdir(join(directory, f.taskRef()));
  const restarted = await fixture(t, "restart", { root: f.root, values: f.values, taskRef: f.taskRef() });
  const after = await runStandingWithPorts(restarted.input, restarted.ports);
  assert.equal(after.status, "stopped", serviceEvidence(restarted, after)); assert.deepEqual(restarted.foreground, [200]); assert.equal(restarted.counts().nativeTurns, 0);
  assert.equal(restarted.counts().finalSends, 0); assert.equal(restarted.finalTickets.length, 0);
  assert.deepEqual(await readdir(join(directory, f.taskRef())), names);
  assert.deepEqual(await readStandingHistoryTaskDisposition({ directory, passphrase, intent, ...heads }), disposition);
});

test("default finalizer persists a distinct report then delivers every part; restart never regenerates or resends", async t => {
  const f = await fixture(t, "finalizer"), result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped", serviceEvidence(f, result));
  assert.equal(f.events.filter(e => e === "final-report").length, 1);
  assert.equal(f.events.filter(e => e === "final-report-review").length, 1);
  assert.ok(f.events.indexOf("final-report-review") < f.events.indexOf("final-send"));
  const intent = await f.readIntent();
  const saved = await readStandingHistoryTaskDelivery({ directory: f.directories.delivery, passphrase, intent });
  assert.equal(saved.delivery, "verified"); assert.equal(saved.partsTotal, 4); assert.equal(saved.verifiedParts, 4);
  assert.equal(saved.descriptor!.body, f.finalReportBody);
  assert.notEqual(saved.descriptor!.body, f.chosenSummary);
  assert.equal(saved.descriptor!.parts!.filter(p => p.kind === "body").map(p => p.text).join(""), f.finalReportBody);
  const restarted = await fixture(t, "restart", { root: f.root, values: f.values, taskRef: f.taskRef() });
  const after = await runStandingWithPorts(restarted.input, restarted.ports);
  assert.equal(after.status, "stopped", serviceEvidence(restarted, after));
  assert.equal(restarted.counts().nativeTurns, 0); assert.equal(restarted.counts().finalSends, 0);
});

test("material-unavailable finalizer outcome preserves foreground and blocks only the unchanged report task across restart", async t => {
  const f = await fixture(t, "no-report");
  // The constructor/real-store fault is covered by the finalizer containment
  // suite. Inject its typed outcome at the service boundary to exercise the
  // actual disposition, progress, foreground and restart consumers.
  const target = new URL("../src/standing-service.js?material-containment=" + Date.now(), import.meta.url).href;
  const key = "__standingMaterialContainment";
  Reflect.set(globalThis, key, f.input.historyFinalReport);
  const stub = "data:text/javascript," + encodeURIComponent(`export async function finalizeStandingHistoryReport(input){await globalThis[${JSON.stringify(key)}](input);return {kind:'blocked',reason:'material-unavailable'};}`);
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === target && specifier === "./standing-history-final-report.js") return { url: stub, shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  let result: Awaited<ReturnType<typeof runStandingWithPorts>>;
  try {
    const service = await import(target) as typeof import("../src/standing-service.js");
    hooks.deregister();
    const { historyFinalReport: _hook, ...defaults } = f.input;
    result = await service.runStandingWithPorts(defaults, f.ports);
  } finally { hooks.deregister(); Reflect.deleteProperty(globalThis, key); }
  assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(result.lockPreserved, false); assert.equal(result.clientSettled, true);
  assert.equal(f.counts().deliveryRefusals, 1); assert.equal(f.counts().finalSends, 0); assert.equal(f.counts().nativeTurns, f.counts().turnsAtRefusal);
  assert.ok(f.events.indexOf("foreground:" + f.counts().laterPrimary) > f.events.indexOf("synthetic-coverage-refusal"));
  const intent = await f.readIntent(), heads = await f.readHeads(), directory = join(f.input.stateDirectory, "history-tasks", "disposition");
  const saved = await readStandingHistoryTaskDisposition({ directory, passphrase, intent, ...heads });
  assert.equal(saved.storage, "ready"); if (saved.storage !== "ready") throw Error("missing disposition");
  assert.equal(saved.disposition.reason, "report-required");
  const restarted = await fixture(t, "restart", { root: f.root, values: f.values, taskRef: f.taskRef() });
  const after = await runStandingWithPorts(restarted.input, restarted.ports);
  assert.equal(after.status, "stopped", serviceEvidence(restarted, after)); assert.deepEqual(restarted.foreground, [200]);
  assert.equal(restarted.counts().nativeTurns, 0); assert.equal(restarted.counts().finalSends, 0);
  assert.deepEqual(await readStandingHistoryTaskDisposition({ directory, passphrase, intent, ...heads }), saved);
});

test("service sends exact 4096-byte summary and coverage on two fresh tickets; only both parts verify aggregate delivery", async t => {
  const f = await fixture(t, "multipart"), result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped", serviceEvidence(f, result)); assert.equal(result.lockPreserved, false); assert.equal(f.counts().clients, 1);
  assert.equal(f.counts().finalSends, 2); assert.equal(result.verifiedReplies, f.foreground.length + 2);
  assert.equal(f.finalTickets.length, 2); assert.notEqual(f.finalTickets[0], f.finalTickets[1]);
  assert.equal(f.partial.length, 1); assert.equal(f.partial[0]!.delivery, "partial");
  assert.equal(f.partial[0]!.verifiedParts, 1); assert.equal(f.partial[0]!.nextPart, 2); assert.equal(f.partial[0]!.leaseJoined, undefined);
  const intent = await f.readIntent(), delivery = await readStandingHistoryTaskDelivery({ directory: f.directories.delivery, passphrase, intent });
  assert.equal(delivery.delivery, "verified"); assert.equal(delivery.partsTotal, 2); assert.equal(delivery.verifiedParts, 2);
  assert.equal(delivery.nextPart, undefined); assert.equal(delivery.leaseJoined, true);
  const parts = delivery.descriptor!.parts!; assert.equal(parts.length, 2); assert.equal(parts[0]!.text, f.chosenSummary);
  assert.equal(Buffer.byteLength(parts[0]!.text), 4096); assert.ok(Buffer.byteLength(parts[1]!.text) <= 4096);
  const finalRequests = f.calls.filter((request): request is Api.messages.SendMessage => request instanceof Api.messages.SendMessage &&
    (request.replyTo as Api.InputReplyToMessage).replyToMsgId === 91 && !request.message.startsWith("Foreground answer"));
  assert.deepEqual(finalRequests.map(request => request.message), parts.map(part => part.text));
  const restarted = await fixture(t, "restart", { root: f.root, values: f.values, taskRef: f.taskRef() });
  const after = await runStandingWithPorts(restarted.input, restarted.ports);
  assert.equal(after.status, "stopped", serviceEvidence(restarted, after)); assert.deepEqual(restarted.foreground, [200]);
  assert.equal(restarted.counts().nativeTurns, 0); assert.equal(restarted.counts().finalSends, 0); assert.equal(restarted.finalTickets.length, 0);
  assert.deepEqual(await readStandingHistoryTaskDelivery({ directory: f.directories.delivery, passphrase, intent }), delivery);
});
