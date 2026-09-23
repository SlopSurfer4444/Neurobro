import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { runStandingWithPorts, type StandingInput, type StandingPorts, type StandingEpochConnection } from "../src/standing-service.js";
import { createStandingConversationAdapter } from "../src/standing-conversation-adapter.js";
import { openStandingState } from "../src/standing-state.js";
import { openStandingDialogueJournal } from "../src/standing-dialogue-journal.js";
import { createEncryptedPilotStore, runPilotReply } from "../src/pilot-outbox.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { readStandingHistoryTaskDelivery } from "../src/standing-history-task-delivery.js";
import { decryptSession } from "../src/session-crypto.js";
import type { EpochExtraTool, EpochToolResult } from "../src/standing-tool-dispatcher.js";
import { MATERIAL_BYTES } from "../src/standing-history-analysis-limits.js";

// Actual service, adapter, manager, page/control/analysis/attempt ledgers, runner
// and final outbox. Telegram transport, native model and report draft are synthetic.
// This proves traversal/retention/delivery, not semantic quality or live vision.
test("one community month request survives service restart, preserves full text and delivers only internally", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "standing-community-month-"));
  const custodyRoot = join(root, "custody"), appRoot = join(root, "app"), stateDirectory = join(appRoot, "state");
  await mkdir(custodyRoot); await mkdir(appRoot);
  const passphrase = "synthetic-community-month-passphrase", accountId = "789", requesterId = "456";
  const internalPeer = new Api.PeerChannel({ channelId: bigInt(123) }), sourcePeer = new Api.PeerChannel({ channelId: bigInt(222) });
  const binding = { accountId, peerId: utils.getPeerId(internalPeer) }, sourcePeerId = utils.getPeerId(sourcePeer);
  const workspaceId = "universal-month-fixture", internalTitle = "Internal fixture", sourceTitle = "Community fixture";
  const fromDate = 1_800_000_000, toDate = fromDate + 30 * 86400;
  const longText = "Очень длинное сообщение про комплектацию автомобиля. ".repeat(140) + " КОНЕЦ_ПОЛНОГО_ТЕКСТА";
  const caption = "Подпись к фотографии содержит важное уточнение. ".repeat(110) + " КОНЕЦ_ПОЛНОЙ_ПОДПИСИ";
  assert.ok(longText.length > 4096); assert.ok(caption.length > 4096);
  const self = () => new Api.User({ id: bigInt(accountId), self: true });
  const human = () => new Api.User({ id: bigInt(requesterId), firstName: "Requester" });
  const internalMessage = (id: number, text: string, own = false) => new Api.Message({ id, date: toDate + 10,
    message: text, peerId: internalPeer, fromId: new Api.PeerUser({ userId: bigInt(own ? accountId : requesterId) }), ...(own ? { out: true } : {}) });
  const internal = [internalMessage(91, "ПРОМПТ Разбери месяц общения в сообществе")];
  const source = Array.from({ length: 1053 }, (_, i) => new Api.Message({ id: 1000 + i,
    date: fromDate + Math.floor(i * (30 * 86400 - 1) / 1052), peerId: sourcePeer,
    message: i === 3 ? longText : i === 1017 ? caption : `Сообщение сообщества ${i}`,
    ...(i % 7 === 0 ? { post: true } : { fromId: new Api.PeerUser({ userId: bigInt(777) }) }),
    ...(i === 1017 ? { media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(44) }) }) } : {}) }));
  const paths = { authConfigPath: join(custodyRoot, "auth.json"), bindingPath: join(appRoot, "binding.json"),
    modelReceiptPath: join(appRoot, "model.json"), attemptDirectory: join(appRoot, "attempts"), killSwitchPath: join(appRoot, "STOP") };
  const workspace = { workspaceId, target: { accountId, peerId: binding.peerId, title: internalTitle },
    accountCustodyRoot: custodyRoot, appRoot, ...paths, stateDirectory };
  const directories = Object.fromEntries(["pages", "control", "analysis", "attempts", "delivery", "disposition"]
    .map(name => [name, join(stateDirectory, "history-tasks", name)])) as Record<"pages" | "control" | "analysis" | "attempts" | "delivery" | "disposition", string>;
  await (await openStandingState(stateDirectory, passphrase, binding)).checkpointCursor(90);
  let nowMs = (toDate + 10) * 1000, taskRef = "", finalSends = 0, nativeTurns = 0, clients = 0;
  const sourceRequests: Api.messages.GetHistory[] = [], sends: Api.messages.SendMessage[] = [], events: string[] = [];
  const modelTexts: string[] = [];
  const batch = (rows: Api.TypeMessage[]) => new Api.messages.Messages({ messages: rows, users: [self(), human(),
    new Api.User({ id: bigInt(777), firstName: "Community member" })], chats: [] });
  const unwrap = (result: EpochToolResult): any => { assert.equal(result.success, true, JSON.stringify(result)); return JSON.parse(result.contentItems[0]!.text); };
  async function readIntent(): Promise<StandingHistoryTaskIntent> {
    return JSON.parse(await decryptSession(await readFile(join(directories.control, taskRef, "intent.enc"), "utf8"), passphrase)).intent;
  }
  async function run(phase: "first" | "resume" | "after-delivery") {
    const abort = new AbortController(); let tools: readonly EpochExtraTool[] = [], polls = 0, stoppedAtBoundary = false;
    const startingSends = finalSends;
    const client = {
      async connect() {}, async getMe() { return self(); }, async destroy() {},
      async invoke(request: Api.AnyRequest): Promise<unknown> {
        assert.ok(request.getBytes().length > 0);
        if (request instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({
          dialogs: [internalPeer, sourcePeer].map(peer => new Api.Dialog({ peer, topMessage: 2052, readInboxMaxId: 0,
            readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })),
          chats: [new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: internalTitle, photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true }),
            new Api.Channel({ id: bigInt(222), accessHash: bigInt(654), title: sourceTitle, photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true,
              defaultBannedRights: new Api.ChatBannedRights({ untilDate: 0, sendMessages: true }) })], users: [], messages: [] });
        if (request instanceof Api.messages.GetHistory) {
          const peerId = utils.getPeerId(request.peer); assert.ok(peerId === binding.peerId || peerId === sourcePeerId);
          if (peerId === sourcePeerId) { assert.equal(request.limit, 100); sourceRequests.push(request); events.push("source-read"); }
          return batch((peerId === sourcePeerId ? source : internal).filter(row => row.id > (request.minId ?? 0) &&
            (!request.offsetId || row.id < request.offsetId) && (!request.offsetDate || row.date < request.offsetDate))
            .sort((a, b) => b.id - a.id).slice(0, request.limit));
        }
        if (request instanceof Api.channels.GetMessages || request instanceof Api.messages.GetMessages) {
          if (request instanceof Api.channels.GetMessages) { assert.ok(request.channel instanceof Api.InputChannel); assert.equal(request.channel.channelId.toString(), "123"); }
          return batch(request.id.map(input => internal.find(row => row.id === (input as Api.InputMessageID).id) ?? new Api.MessageEmpty({ id: (input as Api.InputMessageID).id })));
        }
        if (request instanceof Api.messages.SendMessage) {
          assert.equal(utils.getPeerId(request.peer), binding.peerId); sends.push(request);
          const sent = internalMessage(Math.max(...internal.map(row => row.id)) + 1, request.message, true);
          sent.replyTo = new Api.MessageReplyHeader({ replyToMsgId: (request.replyTo as Api.InputReplyToMessage).replyToMsgId });
          if (request.entities !== undefined) sent.entities = request.entities;
          internal.push(sent);
          if (!request.message.startsWith("Foreground")) { assert.equal(sent.replyTo.replyToMsgId, 91); finalSends++; events.push("final-send"); }
          return new Api.UpdateShortSentMessage({ id: sent.id, date: sent.date, out: true, pts: 1, ptsCount: 1 });
        }
        if (request instanceof Api.messages.SetTyping) { assert.equal(utils.getPeerId(request.peer), binding.peerId); return true; }
        throw Error("unexpected request " + request.className);
      }
    };
    const connection: StandingEpochConnection = {
      async prepare() { return { restoration: false }; }, state: () => ({ blocked: false }),
      async turn(requestRef) {
        const scope = { requestRef, callRef: "history-control", signal: abort.signal };
        if (phase === "first") {
          const create = tools.find(tool => tool.name === "neurobro_create_history_task")!;
          taskRef = unwrap(await create.call({ fromDate, toDate, timezone: "Europe/Moscow", objective: "Разбери весь месяц", source: "community" }, scope) as EpochToolResult).taskRef;
        } else {
          const status = unwrap(await tools.find(tool => tool.name === "neurobro_history_task_status")!.call({ taskRef }, scope) as EpochToolResult);
          assert.equal(status.control.state, "queued"); events.push("status-after-reopen");
        }
        return { kind: "text", answer: "Foreground accepted" };
      },
      async release(_requestRef, delivery) { assert.equal(delivery, "verified"); if (phase === "after-delivery") abort.abort(); },
      async close() { return { resourcesSettled: true, persisted: true }; },
      async acquireAnalysisAdmission(requestRef) {
        const nativeBinding = { epochId: "a".repeat(32), requestRef, purpose: "history-analysis" as const };
        return { nativeBinding,
          async turnAnalysis(ref, text, supplied) {
            nativeTurns++; assert.equal(JSON.parse(text).schema, "neurobro-history-analysis-input-v1");
            const scope = { requestRef: ref, callRef: "material", signal: abort.signal };
            const result = await supplied.analysisTools[0]!.call({}, scope) as EpochToolResult;
            const material = unwrap(result); assert.ok(Buffer.byteLength(JSON.stringify(material)) <= MATERIAL_BYTES);
            // Wide leaves carry whole source fragments under `fragments`; inspect
            // the same admitted rows as a model instead of silently dropping them
            // from this fixture's full-text/no-replay evidence.
            if (material.schema !== "standing-history-merge-view-v1") {
              const fragments = material.schema === "standing-history-source-batch-v1" ? material.fragments : [material];
              assert.ok(Array.isArray(fragments) && fragments.length > 0);
              for (const fragment of fragments) {
                assert.equal(fragment.schema, "standing-history-source-fragment-v1");
                assert.equal(fragment.rows.length, fragment.range.toRow - fragment.range.fromRow);
                for (const row of fragment.rows) if (row.disposition === "included") modelTexts.push(row.text);
              }
            }
            events.push(material.children ? "merge" : "leaf");
            supplied.onToolResultSent({ requestRef: ref, callRef: "material", name: "neurobro_analysis_material", result });
            const committed = await supplied.analysisTools[2]!.call({ output: { summary: "Synthetic month reduction", claims: [] } }, { ...scope, callRef: "commit" }) as EpochToolResult;
            unwrap(committed); supplied.onToolResultSent({ requestRef: ref, callRef: "commit", name: "neurobro_analysis_commit", result: committed });
            return { kind: "analysis", answer: "Saved", toolCalls: 2, toolRefusals: 0, scope: { epochId: nativeBinding.epochId, purpose: "history-analysis", requestRef: ref,
              threadId: "synthetic-month-thread", turnId: "turn-" + nativeTurns, turnNumber: nativeTurns, threadTurnNumber: nativeTurns } };
          }, async releaseAnalysis() {}, async abortAndJoin() {}, async close() {}
        };
      },
      async verifyAnalysisSettlement(nativeBinding) { return { schema: "standing-analysis-owner-settlement-v1", nativeBinding, resourcesSettled: true,
        persisted: true, replacementReady: true, modelOutcome: "not-proven" }; },
      async verifyAnalysisReady(nativeBinding) { return { schema: "standing-analysis-owner-ready-v1", nativeBinding, basis: "released-current-owner", modelOutcome: "not-proven" }; }
    };
    const input: StandingInput = { paths, stateDirectory, workspace, workProfile: "community-team", observedSource: { title: sourceTitle },
      enableHistoryTasks: true, credentials: { apiId: 123, apiHash: "a".repeat(32), passphrase }, signal: abort.signal,
      modelState: () => ({ blocked: false }), async model() { throw Error("cold model must not run"); },
      async historyFinalReport({ intent, readiness }) { return { schema: "standing-history-final-report-v1" as const, taskRef: intent.taskId,
        sourceHead: readiness.sourceHead, analysisHead: readiness.expectedHead, body: "Synthetic complete month report from saved analysis." }; },
      openConversation({ extraTools }) { tools = extraTools!; return connection; }, notify(code) { events.push(code); } };
    const ports = {
      async prepare() { return { paths, config: { account: { sessionFile: join(custodyRoot, "session.enc") } }, binding, ownerLock: join(custodyRoot, "lock") }; },
      async acquireLock() { return async () => {}; }, async openSession() { return { material: { value: "synthetic-session" }, async release() {} }; },
      state: openStandingState, journal: openStandingDialogueJournal, createClient() { clients++; return client; }, installFence() { return () => {}; },
      async adapter(args: Parameters<typeof createStandingConversationAdapter>[0]) {
        const actual = await createStandingConversationAdapter({ ...args, clock: () => nowMs, async wait(ms) { nowMs += ms; } });
        return { ...actual, async pollWork(signal: AbortSignal, options: Readonly<{ backgroundDue: boolean }>) {
          if (++polls > 1200) { abort.abort(); throw Error("month fixture poll budget exhausted"); }
          if (phase === "first" && sourceRequests.length >= 4 && events.includes("leaf")) { stoppedAtBoundary = true; abort.abort(); }
          if (phase === "resume" && finalSends > startingSends) abort.abort();
          return actual.pollWork(signal, options);
        } };
      },
      async settle(value: typeof client) { assert.equal(value, client); await client.destroy(); return true; },
      store: createEncryptedPilotStore, dispatch: runPilotReply, killed: () => false,
      async wait(ms: number, signal: AbortSignal) { if (signal.aborted) throw Error("synthetic stop"); nowMs += ms; }, now: () => nowMs
    } as unknown as StandingPorts;
    const result = await runStandingWithPorts(input, ports);
    assert.equal(result.status, "stopped", JSON.stringify({ result, events: events.slice(-15), polls }));
    assert.equal(result.clientSettled, true); assert.equal(result.lockPreserved, false);
    if (phase === "first") assert.equal(stoppedAtBoundary, true);
  }
  await run("first");
  const intent = await readIntent();
  assert.equal(intent.chatId, binding.peerId); assert.equal(intent.primaryMessageId, 91);
  assert.deepEqual(intent.source, { kind: "observed-source", sourceRef: "community", workspaceId, peerId: sourcePeerId });
  assert.equal(finalSends, 0);
  assert.ok(events.includes("leaf"), "restart happens after persisted analysis as well as persisted reads");
  internal.push(internalMessage(Math.max(...internal.map(row => row.id)) + 1, "ПРОМПТ Как идёт разбор?"));
  await run("resume");
  assert.equal(finalSends, 1); assert.ok(sourceRequests.length > 8); assert.ok(events.includes("leaf"));
  assert.equal(new Set(modelTexts).size, source.length); assert.equal(modelTexts.length, source.length, "no completed leaf is replayed after reopen");
  assert.ok(modelTexts.includes(longText)); assert.ok(modelTexts.includes(caption));
  const pages = await openStandingHistoryTaskStore({ directory: directories.pages, passphrase, intent, mode: "open" });
  const analysis = await openStandingHistoryAnalysisStore({ directory: directories.analysis, passphrase, intent, mode: "open", readSourcePage: index => pages.readPage(index) });
  try {
    const status = await pages.status(); assert.ok(status.readProgress.committedPages > 8); assert.equal(status.readProgress.checkpoint.chatId, sourcePeerId);
    assert.equal(status.readProgress.checkpoint.status, "empty-page");
    const restored: string[] = [];
    for (let index = 1; index <= status.readProgress.committedPages; index++) {
      const page = await pages.readPage(index); assert.ok(page); restored.push(...page.result.page.messages.map(row => row.text));
      for (const value of page.result.sources) if ((value.messageId - 1000) % 7 === 0) assert.equal(value.authorId, sourcePeerId);
    }
    assert.deepEqual(restored.sort(), source.map(row => row.message).sort());
    assert.ok((await analysis.status()).analysisNodes >= 1);
  } finally { await analysis.close(); await pages.close(); }
  const delivered = await readStandingHistoryTaskDelivery({ directory: directories.delivery, passphrase, intent });
  assert.equal(delivered.delivery, "verified"); assert.equal(delivered.leaseJoined, true);
  assert.equal(delivered.descriptor?.coverage.sourceRows, source.length);
  assert.equal(delivered.descriptor?.coverage.coveredRows, source.length);
  assert.equal(delivered.descriptor?.coverage.readTraversalComplete, true);
  assert.ok(sends.some(request => request.message.includes("Источник: подключённое сообщество (только чтение).")));
  const before = { turns: nativeTurns, reads: sourceRequests.length, sends: finalSends };
  internal.push(internalMessage(Math.max(...internal.map(row => row.id)) + 1, "ПРОМПТ Статус готового разбора"));
  await run("after-delivery");
  assert.deepEqual({ turns: nativeTurns, reads: sourceRequests.length, sends: finalSends }, before);
  assert.equal(clients, 3); assert.ok(sends.every(request => utils.getPeerId(request.peer) === binding.peerId));
  const manager = await openStandingHistoryTaskManager({ directories, passphrase, binding, observedSource: intent.source, async onCancelled() {} });
  try {
    await assert.rejects(manager.status({ taskRef, requesterId: "999" }));
    const cancelled = await manager.cancel({ taskRef, requesterId }); assert.equal(cancelled.control.state, "cancelled");
  } finally { await manager.close(); }
  const reopened = await openStandingHistoryTaskManager({ directories, passphrase, binding, observedSource: intent.source, async onCancelled() {} });
  try { assert.equal((await reopened.status({ taskRef, requesterId })).control.state, "cancelled"); }
  finally { await reopened.close(); }
});
