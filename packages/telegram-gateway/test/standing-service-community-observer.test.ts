import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Api, utils } from "telegram";
import { runStandingWithPorts, type StandingEpochConnection, type StandingInput, type StandingPorts } from "../src/standing-service.js";
import { createStandingConversationAdapter } from "../src/standing-conversation-adapter.js";
import { openStandingState } from "../src/standing-state.js";
import { openStandingDialogueJournal } from "../src/standing-dialogue-journal.js";
import { createEncryptedPilotStore, runPilotReply } from "../src/pilot-outbox.js";
import { openStandingCommunitySettings } from "../src/standing-community-settings.js";
import { openStandingCommunityAlertOutbox } from "../src/standing-community-alert-outbox.js";
import { decryptSession } from "../src/session-crypto.js";
import type { EpochExtraTool, EpochToolResult } from "../src/standing-tool-dispatcher.js";
import type { StandingCommunityAssessmentNativeBinding } from "../src/standing-community-assessment-port.js";

const passphrase = "synthetic-service-community-observer-passphrase";
const accountId = "789", internalPeer = new Api.PeerChannel({ channelId: bigInt(123) });
const sourcePeer = new Api.PeerChannel({ channelId: bigInt(222) });
const internalPeerId = utils.getPeerId(internalPeer), sourcePeerId = utils.getPeerId(sourcePeer);
const workspaceId = "sample-community-observer-test";
const sourceTitle = "Synthetic read-only community";
const internalTitle = "Synthetic internal team";
const humanId = "456";

function internalMessage(id: number, text: string, authorId = humanId) {
  return new Api.Message({ id, date: 1_800_000_000, message: text, peerId: internalPeer,
    fromId: new Api.PeerUser({ userId: bigInt(authorId) }), ...(authorId === accountId ? { out: true } : {}) });
}
function sourceMessage(id: number, text: string) {
  return new Api.Message({ id, date: 1_800_000_000, message: text, peerId: sourcePeer,
    fromId: new Api.PeerUser({ userId: bigInt(777) }) });
}
const dialog = (peer: Api.TypePeer, topMessage: number) => new Api.Dialog({ peer, topMessage, readInboxMaxId: 0,
  readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) });
const internalEntity = () => new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: internalTitle,
  photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true });
const sourceEntity = () => new Api.Channel({ id: bigInt(222), accessHash: bigInt(654), title: sourceTitle,
  photo: new Api.ChatPhotoEmpty(), date: 1, broadcast: true,
  defaultBannedRights: new Api.ChatBannedRights({ untilDate: 0, sendMessages: true }) });
const self = () => new Api.User({ id: bigInt(accountId), self: true, firstName: "Synthetic Neurobro" });
const human = () => new Api.User({ id: bigInt(humanId), firstName: "Internal teammate" });
const sourceAuthor = () => new Api.User({ id: bigInt(777), firstName: "Community author" });
function body(result: EpochToolResult): Record<string, unknown> {
  const item = result.contentItems[0]; assert.equal(item?.type, "inputText");
  return JSON.parse((item as { type: "inputText"; text: string }).text);
}

type Phase = "quiet" | "enable" | "alert" | "disable" | "corrupt";
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "standing-service-community-"));
  t.after(async () => { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const custodyRoot = join(root, "custody"), appRoot = join(root, "app"), stateDirectory = join(appRoot, "state");
  await mkdir(custodyRoot); await mkdir(appRoot);
  const paths = { authConfigPath: join(custodyRoot, "auth.json"), bindingPath: join(appRoot, "binding.json"),
    modelReceiptPath: join(appRoot, "model.json"), attemptDirectory: join(appRoot, "attempts"), killSwitchPath: join(appRoot, "STOP") };
  const workspace = { workspaceId, target: { accountId, peerId: internalPeerId, title: internalTitle },
    accountCustodyRoot: custodyRoot, appRoot, ...paths, stateDirectory };
  const sessionFile = join(custodyRoot, "session.enc"), ownerLock = `${sessionFile}.owner.lock`;
  const state = await openStandingState(stateDirectory, passphrase, { accountId, peerId: internalPeerId });
  await state.checkpointCursor(90);
  const internal: Api.Message[] = [], source: Api.Message[] = [sourceMessage(80, "Routine source row while alerts are disabled")];
  const calls: Api.AnyRequest[] = [], sourceReads: Api.messages.GetHistory[] = [], packets: Array<Record<string, any>> = [];
  const events: string[] = []; let nextInternalId = 91, nowMs = 1_800_000_000_000, assessments = 0, assessmentReleases = 0, assessmentCloses = 0;
  let alertSends = 0, explicitReads = 0;
  const observerFile = join(stateDirectory, "community-observer", "community-observer.enc");
  const settingsFile = join(stateDirectory, "community-settings", "community-settings.enc");
  const observerPlain = async (): Promise<Record<string, any> | undefined> => {
    try { return JSON.parse(await decryptSession(await readFile(observerFile, "utf8"), passphrase)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const page = (rows: Api.Message[]) => new Api.messages.Messages({ messages: rows, users: [self(), human(), sourceAuthor()], chats: [] });

  async function run(phase: Phase) {
    const abort = new AbortController(); let tools: readonly EpochExtraTool[] = [], foregroundDone = false, postDisablePolls = 0, totalPolls = 0;
    const readsAtStart = sourceReads.length, alertsAtStart = alertSends, assessmentsAtStart = assessments;
    const client = {
      async connect() { events.push(`${phase}:connect`); }, async getMe() { return self(); }, async destroy() { events.push(`${phase}:destroy`); },
      async invoke(request: Api.AnyRequest): Promise<unknown> {
        calls.push(request); assert.ok(request.getBytes().length > 0, "real installed TL serialization");
        if (request instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({
          dialogs: [dialog(internalPeer, Math.max(90, ...internal.map(value => value.id))), dialog(sourcePeer, Math.max(...source.map(value => value.id)))],
          chats: [internalEntity(), sourceEntity()], users: [], messages: [] });
        if (request instanceof Api.messages.GetHistory) {
          const peerId = utils.getPeerId(request.peer);
          if (peerId === sourcePeerId) {
            sourceReads.push(request); events.push(`${phase}:source-read`);
            return page(source.filter(row => (!request.offsetId || row.id < request.offsetId)).sort((a, b) => b.id - a.id).slice(0, request.limit));
          }
          assert.equal(peerId, internalPeerId);
          return page(internal.filter(row => row.id > (request.minId ?? 0) && (!request.offsetId || row.id < request.offsetId))
            .sort((a, b) => b.id - a.id).slice(0, request.limit));
        }
        if (request instanceof Api.messages.SendMessage) {
          assert.equal(utils.getPeerId(request.peer), internalPeerId, "all sends remain in the internal team chat");
          const reply = request.replyTo instanceof Api.InputReplyToMessage ? request.replyTo.replyToMsgId : null;
          if (reply === null) { alertSends++; events.push(`${phase}:alert-send`); }
          const sent = internalMessage(nextInternalId++, request.message, accountId);
          if (reply !== null) sent.replyTo = new Api.MessageReplyHeader({ replyToMsgId: reply });
          if (request.entities !== undefined) sent.entities = request.entities;
          internal.push(sent);
          return new Api.UpdateShortSentMessage({ id: sent.id, out: true, pts: 1, ptsCount: 1, date: sent.date });
        }
        if (request instanceof Api.channels.GetMessages || request instanceof Api.messages.GetMessages) {
          const id = (request.id[0] as Api.InputMessageID).id;
          return page([internal.find(row => row.id === id) ?? new Api.MessageEmpty({ id })] as Api.Message[]);
        }
        if (request instanceof Api.messages.SetTyping) return true;
        throw new Error(`unexpected synthetic Telegram request ${request.className}`);
      },
    };
    const connection: StandingEpochConnection = {
      async prepare() { return { restoration: false }; }, state: () => ({ blocked: false }),
      async turn(requestRef, text) {
        const packet = JSON.parse(text) as Record<string, any>; packets.push(packet);
        const scope = { requestRef, callRef: `${phase}-tool`, signal: abort.signal };
        const observation = tools.find(tool => tool.name === "neurobro_observation");
        const community = tools.find(tool => tool.name === "neurobro_community");
        assert.ok(observation); assert.ok(community);
        if (phase === "enable") {
          assert.equal(packet.contextState.observation.revision, 1); assert.equal(packet.contextState.observation.alertsEnabled, false);
          const result = await observation.call({ action: "configure", expectedRevision: 1, observationEnabled: true, alertsEnabled: true,
            alertGuidance: "Alert only when an internal teammate should act.", minAlertIntervalSeconds: 60 }, scope) as EpochToolResult;
          assert.equal(result.success, true); assert.equal(body(result).revision, 2);
        }
        if (phase === "alert") {
          assert.equal(packet.contextState.observation.revision, 2); assert.equal(packet.contextState.observation.alertsEnabled, true);
        }
        if (phase === "disable") {
          assert.equal(packet.contextState.observation.revision, 2); assert.equal(packet.contextState.observation.observationEnabled, true);
          const disabled = await observation.call({ action: "configure", expectedRevision: 2, observationEnabled: false, alertsEnabled: false,
            alertGuidance: "Alert only when an internal teammate should act.", minAlertIntervalSeconds: 60 }, scope) as EpochToolResult;
          assert.equal(disabled.success, true); assert.equal(body(disabled).revision, 3);
          const read = await community.call({ action: "read", beforeMessageId: null, limit: 30 }, { ...scope, callRef: "explicit-read" }) as EpochToolResult;
          assert.equal(read.success, true); assert.match(JSON.stringify(body(read)), /new source row after disabling/); explicitReads++;
        }
        if (phase === "corrupt") assert.equal(Object.hasOwn(packet.contextState, "observation"), false,
          "damaged optional settings are omitted from the foreground packet");
        return { kind: "text", answer: `Synthetic ${phase} response` };
      },
      async release(_requestRef, delivery) { assert.equal(delivery, "verified"); foregroundDone = true;
        if (phase === "enable" || phase === "corrupt") abort.abort(); },
      async close() { events.push(`${phase}:native-close`); return { resourcesSettled: true, persisted: true }; },
      async acquireAnalysisAdmission() { throw new Error("no history task was created"); },
      async verifyAnalysisSettlement() { throw new Error("no history task was created"); },
      async verifyAnalysisReady() { throw new Error("no history task was created"); },
      async acquireCommunityAssessmentAdmission(requestRef) {
        const nativeBinding: StandingCommunityAssessmentNativeBinding = { epochId: "a".repeat(32), requestRef, purpose: "community-assessment" };
        return { nativeBinding,
          async turnCommunityAssessment(ref, text) {
            assessments++; events.push(`${phase}:assessment`); assert.equal(ref, requestRef);
            const packet = JSON.parse(text); assert.equal(packet.schema, "community-assessment-v1"); assert.equal(packet.assessmentRef, ref);
            const caseKey = packet.observations[0].ref as string;
            return { kind: "community-assessment" as const,
              scope: { ...nativeBinding, threadId: "synthetic-community-thread", turnId: `turn-${assessments}`, turnNumber: assessments, threadTurnNumber: assessments },
              decision: { decision: "alert" as const, caseKey, answer: "Новый вопрос требует внимания команды." }, toolCalls: 0 as const, toolRefusals: 0 as const };
          },
          async releaseCommunityAssessment(ref) { assert.equal(ref, requestRef); assessmentReleases++; events.push(`${phase}:assessment-release`); },
          async abortAndJoin() { return { schema: "standing-community-assessment-owner-settlement-v1" as const, nativeBinding,
            resourcesSettled: true as const, persisted: true as const, replacementReady: true as const, modelOutcome: "not-proven" as const }; },
          async close() { assessmentCloses++; events.push(`${phase}:assessment-close`); },
        };
      },
      async verifyCommunityAssessmentSettlement(nativeBinding) { return { schema: "standing-community-assessment-owner-settlement-v1", nativeBinding,
        resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" }; },
    };
    const input: StandingInput = { paths, stateDirectory, workspace, workProfile: "community-team", observedSource: { title: sourceTitle },
      enableCommunityObservation: true, enableHistoryTasks: true,
      credentials: { apiId: 123, apiHash: "a".repeat(32), passphrase }, signal: abort.signal,
      modelState: () => ({ blocked: false }), async model() { throw new Error("cold model must not run"); },
      openConversation({ extraTools, workProfile }) { events.push(`${phase}:open-conversation`); assert.equal(workProfile, "community-team"); tools = extraTools!; return connection; },
      notify(code) { events.push(`${phase}:${code}`); } };
    const ports = {
      async prepare() { return { paths, config: { account: { sessionFile } }, binding: { accountId, peerId: internalPeerId }, ownerLock }; },
      async acquireLock() { events.push(`${phase}:lock`); return async () => { events.push(`${phase}:unlock`); }; },
      async openSession() { return { material: { value: "synthetic-session" }, async release() { events.push(`${phase}:session-release`); } }; },
      state: openStandingState, journal: openStandingDialogueJournal,
      createClient() { return client; }, installFence() { return () => { events.push(`${phase}:fence-restore`); }; },
      async adapter(args: Parameters<typeof createStandingConversationAdapter>[0]) {
        let actual: Awaited<ReturnType<typeof createStandingConversationAdapter>>;
        try { actual = await createStandingConversationAdapter({ ...args, clock: () => nowMs,
          async wait(ms, signal) { assert.equal(signal.aborted, false); nowMs += ms; } }); }
        catch (error) { events.push(`${phase}:adapter-error:${String((error as Error).message)}`); throw error; }
        events.push(`${phase}:adapter-opened`);
        return { ...actual, async pollWork(signal: AbortSignal, options: Readonly<{ backgroundDue: boolean }>) {
          if (++totalPolls > 160) { abort.abort(); throw new Error(`synthetic ${phase} poll bound exceeded`); }
          const persisted = await observerPlain();
          if (phase === "quiet" && persisted?.processingTotals?.["alerts-disabled"] >= 1) abort.abort();
          if (phase === "alert" && persisted?.processingTotals?.alert >= 1) abort.abort();
          if (phase === "disable" && foregroundDone && ++postDisablePolls >= 8) abort.abort();
          const selected = await actual.pollWork(signal, options);
          if (phase === "corrupt" && !events.includes("corrupt:settings-damaged")) {
            await writeFile(settingsFile, "damaged-settings-ciphertext", "utf8");
            events.push("corrupt:settings-damaged");
          }
          return selected;
        } };
      },
      async settle(value: typeof client) { assert.equal(value, client); await client.destroy(); events.push(`${phase}:client-settled`); return true; },
      store: createEncryptedPilotStore, dispatch: runPilotReply, killed: () => false,
      async wait(ms: number, signal: AbortSignal) { if (signal.aborted) throw new Error("synthetic stop"); nowMs += ms; }, now: () => nowMs,
    } as unknown as StandingPorts;
    const result = await runStandingWithPorts(input, ports);
    assert.equal(result.status, "stopped", JSON.stringify({ result, events: events.slice(-30) }));
    assert.equal(result.clientSettled, true); assert.equal(result.lockPreserved, false);
    if (phase === "corrupt") assert.equal(result.verifiedReplies, 1, "the internal answer is delivered despite the optional view failure");
    assert.ok(events.indexOf(`${phase}:client-settled`) < events.indexOf(`${phase}:unlock`));
    return { reads: sourceReads.length - readsAtStart, alerts: alertSends - alertsAtStart, assessments: assessments - assessmentsAtStart };
  }
  const communityBinding = { workspaceId, accountId, internalPeerId, observedSourcePeerId: sourcePeerId };
  return { root, stateDirectory, internal, source, calls, sourceReads, packets, events, run,
    addInternal(text: string) { const id = nextInternalId++; internal.push(internalMessage(id, text)); return id; },
    addSource(id: number, text: string) { source.unshift(sourceMessage(id, text)); },
    counts: () => ({ alertSends, assessments, assessmentReleases, assessmentCloses, explicitReads }),
    settings: () => openStandingCommunitySettings({ directory: join(stateDirectory, "community-settings"), passphrase, ...communityBinding }),
    outbox: () => openStandingCommunityAlertOutbox({ directory: join(stateDirectory, "community-alerts"), passphrase, binding: communityBinding }),
  };
}

test("community observation rejects missing prerequisites and non-boolean enablement before client creation", async () => {
  const paths = { authConfigPath: "C:\\synthetic\\auth.json", bindingPath: "C:\\synthetic\\binding.json",
    modelReceiptPath: "C:\\synthetic\\model.json", attemptDirectory: "C:\\synthetic\\attempts", killSwitchPath: "C:\\synthetic\\STOP" };
  for (const enableCommunityObservation of [true, "yes"] as const) {
    let prepares = 0, clients = 0;
    const input = { paths, stateDirectory: "C:\\synthetic\\state", enableCommunityObservation,
      credentials: { apiId: 123, apiHash: "a".repeat(32), passphrase }, signal: new AbortController().signal,
      modelState: () => ({ blocked: false }), async model() { throw new Error("model must not run"); }, notify() {} } as unknown as StandingInput;
    const ports = { async prepare() { prepares++; throw new Error("prepare must not run"); },
      createClient() { clients++; throw new Error("client must not run"); }, killed: () => false } as unknown as StandingPorts;
    const result = await runStandingWithPorts(input, ports);
    assert.equal(result.status, "blocked"); assert.equal(result.failureStage, "prepare");
    assert.equal(prepares, 0); assert.equal(clients, 0);
  }
});

test("service persists internal observation policy, alerts only internally, and leaves explicit source reads available after disable", async t => {
  const f = await fixture(t);
  const quiet = await f.run("quiet");
  assert.deepEqual(quiet, { reads: 1, alerts: 0, assessments: 0 });
  let settings = await f.settings();
  assert.equal((await settings.policy()).alertsEnabled, false); await settings.close();

  f.addInternal("ПРОМПТ включи наблюдение и внутренние алерты");
  const enabled = await f.run("enable"); assert.deepEqual(enabled, { reads: 0, alerts: 0, assessments: 0 });
  settings = await f.settings(); const enabledPolicy = await settings.policy(); await settings.close();
  assert.equal(enabledPolicy.revision, 2); assert.equal(enabledPolicy.observationEnabled, true); assert.equal(enabledPolicy.alertsEnabled, true);

  f.addInternal("ПРОМПТ покажи текущий режим");
  f.addSource(81, "Urgent new source row after enable");
  const alerted = await f.run("alert"); assert.equal(alerted.reads, 1); assert.deepEqual({ alerts: alerted.alerts, assessments: alerted.assessments }, { alerts: 1, assessments: 1 });
  assert.equal(f.packets.at(-1)?.contextState.observation.revision, 2, "reopened service supplies persisted policy to the next request");
  const afterAlert = f.counts(); assert.equal(afterAlert.assessmentReleases, 1); assert.equal(afterAlert.assessmentCloses, 1);
  const outbox = await f.outbox(); const recent = await outbox.recent({ limit: 8 }); await outbox.close();
  assert.equal(recent.length, 1); assert.equal(recent[0]!.state, "verified");

  f.addInternal("ПРОМПТ выключи наблюдение, но сначала проверь источник явно");
  f.addSource(82, "new source row after disabling");
  const disabled = await f.run("disable");
  assert.equal(disabled.alerts, 0); assert.equal(disabled.assessments, 0); assert.equal(disabled.reads, 1, "only the explicit tool read reaches the source");
  assert.equal(f.counts().explicitReads, 1);
  settings = await f.settings(); const disabledPolicy = await settings.policy(); await settings.close();
  assert.equal(disabledPolicy.revision, 3); assert.equal(disabledPolicy.observationEnabled, false); assert.equal(disabledPolicy.alertsEnabled, false);

  f.addInternal("ПРОМПТ ответь, даже если необязательные настройки повреждены");
  const corrupted = await f.run("corrupt");
  assert.deepEqual(corrupted, { reads: 0, alerts: 0, assessments: 0 });
  assert.ok(f.events.includes("corrupt:settings-damaged"));

  for (const request of f.calls) if (request instanceof Api.messages.SendMessage) assert.equal(utils.getPeerId(request.peer), internalPeerId);
  const sourceWire = f.calls.filter(request => request instanceof Api.messages.GetHistory && utils.getPeerId(request.peer) === sourcePeerId);
  assert.equal(sourceWire.length, f.sourceReads.length);
  const observerCipher = await readFile(join(f.stateDirectory, "community-observer", "community-observer.enc"), "utf8");
  const outboxCipher = await readFile(join(f.stateDirectory, "community-alerts", "community-alert-ledger.enc"), "utf8");
  for (const privateText of f.source.map(row => row.message)) { assert.equal(observerCipher.includes(privateText), false); assert.equal(outboxCipher.includes(privateText), false); }
  assert.equal(f.events.filter(value => value.endsWith(":native-close")).length, 5);
  assert.equal(f.events.filter(value => value.endsWith(":client-settled")).length, 5);
});
