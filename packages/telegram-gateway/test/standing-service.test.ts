import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStandingInvokeOwner } from "../src/standing-service.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { runGeneratedImageDelivery, openEncryptedGeneratedImageOutbox, type GeneratedImageMediaTransport } from "../src/generated-image-outbox.js";
import { createStandingArtifactRuntime, type StandingArtifactRuntime } from "../src/standing-artifact-runtime.js";
import { completedStandingResult, type StandingNativeModelResult } from "../src/standing-model-result.js";
import { SELF_HISTORY_TOOL_SPEC } from "../src/self-history-tool.js";
import type { ConversationReferences } from "../src/conversation-references.js";
import { BOUND_ACTION_TOOL_SPECS } from "../src/bound-action-tools.js";
import { createStandingBoundActionRuntime } from "../src/standing-bound-action-runtime.js";
import type { StandingEpochConnection } from "../src/standing-service.js";
import type { EpochExtraTool, EpochToolResult } from "../src/standing-tool-dispatcher.js";
import { STANDING_ARTIFACT_TOOL_SPECS } from "../src/standing-artifact-tools.js";
import { runPilotReply, createEncryptedPilotStore, type PilotSend } from "../src/pilot-outbox.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStandingState } from "../src/standing-state.js";
import { runStandingWithPorts, STANDING_DEFERRED_REPLY, addressedModelText, withTyping, type StandingInput, type StandingPorts } from "../src/standing-service.js";
import type { DialogueOutcome, DialogueQuestion } from "../src/standing-dialogue-journal.js";
import { Api, utils } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import { createBoundActionTransportLease } from "../src/bound-action-transport.js";

test("encrypted cursor resumes exact binding and never moves backwards", async () => {
  const root = await mkdtemp(join(tmpdir(), "standing-state-"));
  try {
    const binding = { accountId: "123456", peerId: "-100123456" }, passphrase = "invented-test-passphrase-1234";
    const state = await openStandingState(join(root, "state"), passphrase, binding);
    assert.equal(state.cursor(), undefined);
    await state.checkpointCursor(42);
    const raw = await readFile(join(root, "state", "checkpoint.enc"), "utf8");
    assert.ok(!raw.includes(binding.peerId) && !raw.includes(passphrase) && !raw.includes('"cursor"'));
    const resumed = await openStandingState(join(root, "state"), passphrase, binding);
    assert.equal(resumed.cursor(), 42);
    await assert.rejects(resumed.checkpointCursor(41));
    await assert.rejects(openStandingState(join(root, "state"), passphrase, { ...binding, peerId: "-999" }));
    assert.notEqual(resumed.newOutbox(), resumed.newOutbox());
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fixture(options: { unknownFirst?: boolean; modelBlocked?: boolean; teardownFails?: boolean; checkpointFails?: boolean; stopAfterModel?: boolean } = {}) {
  const abort = new AbortController(), events: string[] = [];
  const questions: DialogueQuestion[] = [], outcomes: DialogueOutcome[] = [];
  let cursor = 0, yielded = 0, blocked = false, models = 0, clients = 0;
  const credentials = { apiId: 123, apiHash: "a".repeat(32), passphrase: "invented-secret-passphrase" };
  const paths = { authConfigPath: "fixture/auth", bindingPath: "fixture/binding", modelReceiptPath: "fixture/ready", attemptDirectory: "fixture/unused", killSwitchPath: "fixture/STOP" };
  const input: StandingInput = {
    paths, stateDirectory: "fixture/state", credentials, signal: abort.signal,
    modelState: () => ({ blocked }), notify: code => events.push(code),
    async model(text) {
      models++; events.push(`model-${cursor}`);
      const conversation = JSON.parse(text);
      assert.equal(conversation.schema, "neurobro-conversation-v1");
      assert.equal(conversation.currentRequest.text, String(cursor));
      if (options.modelBlocked) blocked = true;
      if (options.stopAfterModel) abort.abort();
      const answer = "fixture answer";
      return { answer, receipt: { version: "modeltext-host-v1", outcome: options.unknownFirst && models === 1 ? "unknown" : "observed", exitCode: 0,
        transportError: false, timedOut: false, aborted: false, overflow: false,
        guestSettled: true, clientSettled: true, relaySettled: true, custodyReady: true, appServerSettled: true, turnCompleted: true, answerBytes: Buffer.byteLength(answer) } };
    },
  };
  const ports = {
    prepare: async () => ({ paths, config: { account: { sessionFile: "fixture/session" } }, binding: { accountId: "100", peerId: "-200" }, ownerLock: "fixture/lock" }),
    acquireLock: async () => { events.push("lock"); return async () => { events.push("release-lock"); }; },
    openSession: async () => ({ material: { value: "fixture-session" }, release: async () => { events.push("release-session"); } }),
    state: async () => ({ cursor: () => cursor, checkpointCursor: async (id: number) => { if (options.checkpointFails) throw new Error("state-failed"); cursor = id; events.push(`checkpoint-${id}`); }, newOutbox: () => `fixture/outbox-${cursor}` }),
    journal: async () => ({
      async recordQuestion(value: DialogueQuestion) { questions.push(value); events.push(`question-${value.primary.messageId}`); return { key: String(value.primary.messageId).padStart(10, "0"), created: true }; },
      async recordModelAdmission(value: { key: string; attemptRef: string }) { events.push(`admission-${Number(value.key)}`); return { created: true }; },
      async recordOutcome(value: DialogueOutcome) { outcomes.push(value); events.push(`outcome-${Number(value.key)}`); },
      async read() { return { dialogues: [], scanned: 0, hasOlder: false }; }, close() { events.push("close-journal"); },
    }),
    createClient: () => { clients++; events.push(`client-${clients}`); return { connect: async () => {}, getMe: async () => ({}) }; },
    installFence: () => () => { events.push("restore-fence"); },
    adapter: async (arg: { checkpointCursor(id: number): Promise<void>; checkpointQuestion(primary: DialogueQuestion["primary"], context?: unknown): Promise<void> }) => ({
      async next() {
        if (yielded >= 2) { abort.abort(); throw new Error("aborted"); }
        const id = ++yielded;
        const primary = { chatId: "-200", ownerId: "300", messageId: id, text: `ПРОМПТ ${id}` };
        await arg.checkpointQuestion(primary); await arg.checkpointCursor(id);
        return { primary, transport: {}, cursor: id };
      }, close() { events.push("close-adapter"); },
    }),
    settle: async () => { events.push("settle-client"); return !options.teardownFails; },
    store: (path: string) => { events.push(path); return { async reserve() {}, async append() {} }; },
    dispatch: async (arg: { reply: { replyToMessageId: number } }) => { events.push(`send-${arg.reply.replyToMessageId}`); return { state: "verified", code: "verified" }; },
    killed: () => false, wait: async () => { events.push("backoff"); }, now: () => 1700000000000,
  } as unknown as StandingPorts;
  return { input, ports, events, credentials, questions, outcomes, abort, counters: () => ({ clients, models }) };
}

test("two consecutive replies use consumed cursors, one client and distinct outboxes", async () => {
  const f = fixture(); const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 2); assert.equal(result.lockPreserved, false);
  assert.deepEqual(f.counters(), { clients: 1, models: 2 });
  for (const id of [1, 2]) {
    assert.ok(f.events.indexOf(`checkpoint-${id}`) < f.events.indexOf(`model-${id}`));
    assert.ok(f.events.includes(`fixture/outbox-${id}`));
  }
  assert.ok(f.events.indexOf("settle-client") < f.events.indexOf("release-lock"));
  assert.deepEqual(f.credentials, { apiId: 0, apiHash: "", passphrase: "" });
});

function warmFixture(f = fixture(), rotate = false) {
  const originalAdapter = f.ports.adapter, originalJournal = f.ports.journal;
  let refs: ConversationReferences | undefined, preparations = 0, journalReads = 0;
  const packets: Record<string, any>[] = [], releases: Array<[string, string]> = [];
  const history = { spec: SELF_HISTORY_TOOL_SPEC, async call(value: unknown) {
    f.events.push("history-call"); return { success: true, contentItems: [{ type: "inputText" as const, text: JSON.stringify(value) }] };
  }, close() {} };
  const connection: { -readonly [K in keyof StandingEpochConnection]: StandingEpochConnection[K] } = {
    async prepare() { f.events.push("epoch-prepare"); return { restoration: ++preparations === 1 || rotate }; },
    async turn(requestRef, text) {
      f.events.push("epoch-turn");assert.ok(refs!.matches("-200", "100"));assert.match(requestRef, /^[0-9a-f-]{36}$/);
      packets.push(JSON.parse(text));return { kind: "text", answer: "Я помню предыдущий ответ" };
    },
    async release(ref, delivery) { releases.push([ref, delivery]); f.events.push("epoch-release"); },
    async close() { assert.ok(refs!.matches("-200", "100"));f.events.push("epoch-close");return { resourcesSettled: true, persisted: true }; },
    state: () => ({ blocked: false }),
  };
  f.ports.adapter = async arg => {
    assert.equal(arg.enableSelfHistory, true);refs = arg.references;assert.ok(refs);
    const active=await originalAdapter(arg);
    return { ...active, selfHistory: history, async next(signal) {
      const selected=await active.next(signal);
      return {...selected,transport:{
        sendOnce:async()=>({messageId:selected.primary.messageId+100}),
        readExact:async()=>null,
      }};
    } };
  };
  f.ports.journal = async arg => ({ ...await originalJournal(arg), async read() {
    journalReads++;
    const dialogues = f.questions.map(question => {
      const key = String(question.primary.messageId).padStart(10, "0");
      const outcome = f.outcomes.find(value => value.key === key) ?? null;
      return { key, question, recordedAt: 1699999900 + question.primary.messageId, modelAdmission: null,
        outcome, status: outcome?.delivery ?? "pending" as const };
    });
    return { dialogues, scanned: dialogues.length, hasOlder: false };
  } });
  f.input = { ...f.input, openConversation({ history: supplied }) {
    assert.equal(supplied, history);f.events.push("open-conversation");return connection;
  } };
  return { ...f, connection, history, packets, releases, refs: () => refs!, journalReads: () => journalReads };
}

function initiativeFixture(answer: string | null, directAnswer = "Direct answer after initiative", mode: "initiative" | "continuation" = "initiative") {
  const f = warmFixture(), originalAdapter = f.ports.adapter, originalTurn = f.connection.turn, originalDispatch = f.ports.dispatch;
  const sent: Array<{ replyToMessageId: number; text: string }> = [];
  let enabled: (() => boolean) | undefined, finishes = 0;
  f.input = { ...f.input, enableInitiative: true };
  f.ports.adapter = async args => {
    enabled = args.initiative?.enabled;
    assert.equal(typeof enabled, "function");
    const adapter = await originalAdapter(args);
    return { ...adapter, async next(signal) {
      const selected = await adapter.next(signal);
      return selected.primary.messageId !== 1 ? selected : { ...selected, [mode]: true as const,
        async finishInitiative() { finishes++; f.events.push("finish-initiative-1"); } };
    } };
  };
  f.connection.turn = async (requestRef, text) => {
    await originalTurn(requestRef, text);
    const packet = JSON.parse(text);
    const selectedAnswer = packet.contextState.interaction === mode ? answer : directAnswer;
    return selectedAnswer === null ? { kind: "none", answer: null } : { kind: "text", answer: selectedAnswer };
  };
  f.ports.dispatch = async args => {
    assert.notEqual(args.reply.replyToMessageId, null);
    sent.push({ replyToMessageId: args.reply.replyToMessageId!, text: args.reply.text });
    return originalDispatch(args);
  };
  return { ...f, sent, enabled: () => enabled!(), finishes: () => finishes };
}

test("continuation may answer or stay silent with initiative disabled, then releases for the next direct request", async () => {
  for (const answer of ["NEUROBRO_SILENCE", "Погнали, ты играешь за коммунальщика."]) {
    const f = initiativeFixture(answer, "Следующий ответ", "continuation");
    f.ports.killed = path => path === join(f.input.stateDirectory, "INITIATIVE.OFF");
    const result = await runStandingWithPorts(f.input, f.ports);
    assert.equal(result.status, "stopped");
    assert.deepEqual(f.packets.map(p => p.contextState.interaction), ["continuation", "direct"]);
    assert.equal(f.enabled(), false);
    assert.deepEqual(f.sent, [...(answer === "NEUROBRO_SILENCE" ? [] : [{ replyToMessageId: 1, text: answer }]),
      { replyToMessageId: 2, text: "Следующий ответ" }]);
    assert.deepEqual(f.releases.map(v => v[1]), [answer === "NEUROBRO_SILENCE" ? "not-sent" : "verified", "verified"]);
    if (answer === "NEUROBRO_SILENCE") {
      assert.equal(f.finishes(), 1);
      assert.ok(f.events.indexOf("epoch-release") < f.events.indexOf("finish-initiative-1"));
      assert.ok(f.events.indexOf("finish-initiative-1") < f.events.indexOf("admission-2"));
    }
  }
});

test("initiative silence consumes without deferred text, releases before finish, and allows a following direct reply", async () => {
    const f = initiativeFixture("NEUROBRO_SILENCE"), result = await runStandingWithPorts(f.input, f.ports);
    assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 1); assert.equal(result.lockPreserved, false);
    assert.deepEqual(f.sent, [{ replyToMessageId: 2, text: "Direct answer after initiative" }]);
    assert.deepEqual(f.outcomes.map(({ key, kind, delivery, answer }) => ({ key, kind, delivery, answer })), [
      { key: "0000000001", kind: "model", delivery: "not-sent", answer: null },
      { key: "0000000002", kind: "model", delivery: "verified", answer: "Direct answer after initiative" },
    ]);
    assert.deepEqual(f.releases.map(v => v[1]), ["not-sent", "verified"]); assert.equal(f.finishes(), 1);
    assert.ok(f.events.indexOf("outcome-1") < f.events.indexOf("epoch-release"));
    assert.ok(f.events.indexOf("epoch-release") < f.events.indexOf("finish-initiative-1"));
    assert.ok(f.events.indexOf("finish-initiative-1") < f.events.indexOf("admission-2"));
    assert.deepEqual(f.packets.map(p => p.contextState.interaction), ["initiative", "direct"]);
    assert.equal(f.packets[0]!.currentRequest.text, "ПРОМПТ 1");
    assert.equal(f.packets[1]!.currentRequest.text, "2");
    assert.equal(f.sent.some(reply => reply.text === STANDING_DEFERRED_REPLY), false);
});

test("malformed warm initiative none result stays consumed and blocked without a deferred notice", async () => {
  const f = initiativeFixture(null), result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "blocked"); assert.equal(result.verifiedReplies, 0);
  assert.equal(f.events.includes("admission-1"), true); assert.equal(f.events.includes("admission-2"), false);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.outcomes, []);
  assert.deepEqual(f.releases.map(v => v[1]), ["not-sent"]); assert.equal(f.finishes(), 0);
  assert.deepEqual(f.packets.map(p => p.contextState.interaction), ["initiative"]);
});

test("ordinary initiative text sends once while the same silence sentinel is literal on a direct request", async () => {
  const f = initiativeFixture("Useful unsolicited answer", "NEUROBRO_SILENCE"), result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 2);
  assert.deepEqual(f.sent, [{ replyToMessageId: 1, text: "Useful unsolicited answer" }, { replyToMessageId: 2, text: "NEUROBRO_SILENCE" }]);
  assert.deepEqual(f.outcomes.map(o => [o.delivery, o.kind, o.answer]), [["verified", "model", "Useful unsolicited answer"], ["verified", "model", "NEUROBRO_SILENCE"]]);
  assert.deepEqual(f.releases.map(v => v[1]), ["verified", "verified"]); assert.equal(f.finishes(), 0);
  assert.deepEqual(f.packets.map(p => p.contextState.interaction), ["initiative", "direct"]);
});

test("INITIATIVE.OFF denies initiative admission while direct requests remain enabled", async () => {
  const f = initiativeFixture("Must not be modelled"), checked: string[] = [];
  f.ports.killed = path => { checked.push(path); return path === join(f.input.stateDirectory, "INITIATIVE.OFF"); };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 1); assert.equal(f.enabled(), false);
  assert.ok(checked.includes(join(f.input.stateDirectory, "INITIATIVE.OFF")));
  assert.equal(f.events.includes("admission-1"), false); assert.equal(f.finishes(), 1);
  assert.deepEqual(f.packets.map(p => p.contextState.interaction), ["direct"]);
  assert.deepEqual(f.releases.map(v => v[1]), ["verified"]);
  assert.deepEqual(f.sent, [{ replyToMessageId: 2, text: "Direct answer after initiative" }]);
  assert.deepEqual(f.outcomes.map(o => [o.delivery, o.kind, o.answer]), [["not-sent", "model", null], ["verified", "model", "Direct answer after initiative"]]);
  assert.ok(f.events.indexOf("finish-initiative-1") < f.events.indexOf("admission-2"));
});

test("INITIATIVE.OFF appearing after the model prevents final initiative send and joins its release", async () => {
  const f = initiativeFixture("Already composed but now disabled"), originalTurn = f.connection.turn;
  let disabled = false;
  f.ports.killed = path => path === join(f.input.stateDirectory, "INITIATIVE.OFF") && disabled;
  f.connection.turn = async (requestRef, text) => {
    const result = await originalTurn(requestRef, text);
    if (JSON.parse(text).contextState.interaction === "initiative") { assert.equal(f.enabled(), true); disabled = true; }
    return result;
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 1); assert.equal(f.enabled(), false);
  assert.deepEqual(f.sent, [{ replyToMessageId: 2, text: "Direct answer after initiative" }]);
  assert.deepEqual(f.releases.map(v => v[1]), ["not-sent", "verified"]); assert.equal(f.finishes(), 1);
  assert.deepEqual(f.outcomes.map(o => [o.delivery, o.kind, o.answer]), [["not-sent", "model", null], ["verified", "model", "Direct answer after initiative"]]);
  assert.ok(f.events.indexOf("epoch-release") < f.events.indexOf("finish-initiative-1"));
  assert.deepEqual(f.packets.map(p => p.contextState.interaction), ["initiative", "direct"]);
});

test("warm service keeps one conversation and stable author references over consecutive replies", async () => {
  const f = warmFixture();const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped");assert.equal(result.verifiedReplies, 2);assert.equal(f.counters().models, 0);
  assert.equal(f.counters().clients, 1);assert.equal(f.events.filter(v => v === "open-conversation").length, 1);
  assert.equal(f.packets.length, 2);assert.equal(f.packets[0]!.currentRequest.speaker, f.packets[1]!.currentRequest.speaker);
  assert.equal(f.packets[0]!.contextState.referenceScope, "bound-connection");
  assert.equal(f.packets[0]!.contextState.restoration.pairs.length, 0);assert.equal(f.packets[1]!.contextState.restoration, undefined);
  const firstShared = f.packets[0]!.contextState.shared.snapshot, secondShared = f.packets[1]!.contextState.shared.snapshot;
  assert.equal(firstShared.scope.scopeRef, secondShared.scope.scopeRef);
  assert.deepEqual(firstShared.scope.audience, { kind: "requester", requesterRef: f.packets[0]!.currentRequest.speaker });
  assert.equal(firstShared.coverage.ownActions.availability, "unavailable");
  assert.equal(firstShared.coverage.tasks.availability, "not-configured");
  assert.equal(firstShared.completeChat, false);
  assert.equal(secondShared.initiativeEligibility, "not-evaluated");
  assert.equal(f.journalReads(), 1);assert.deepEqual(f.releases.map(v => v[1]), ["verified", "verified"]);
  assert.ok(f.events.indexOf("outcome-1") < f.events.indexOf("epoch-release"));
  assert.ok(f.events.indexOf("epoch-close") < f.events.indexOf("close-adapter"));
  assert.ok(f.events.indexOf("epoch-close") < f.events.indexOf("settle-client"));
  assert.throws(() => f.refs().message(1));
});

test("persisted own text reaches warm and fresh-service model packets without an archive scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "standing-own-text-memory-"));
  let slots = 0;
  const configure = () => {
    const f = warmFixture(), originalAdapter = f.ports.adapter;
    f.input = { ...f.input, stateDirectory: root };
    f.ports.store = (_directory, passphrase) => createEncryptedPilotStore(join(root, String(++slots)), passphrase);
    f.ports.dispatch = runPilotReply;
    f.ports.adapter = async args => {
      const adapter = await originalAdapter(args);
      return { ...adapter, async next(signal) {
        const selected = await adapter.next(signal); let sent: PilotSend | undefined;
        return { ...selected, transport: {
          async sendOnce(reply) { sent = reply; return { messageId: selected.primary.messageId + 100 }; },
          async readExact(chatId, messageId) { assert.ok(sent); return { chatId, messageId, accountId: "100", replyToMessageId: sent.replyToMessageId,
            text: sent.text, ...(sent.entities ? { entities: sent.entities } : {}) }; },
        } };
      } };
    };
    return f;
  };
  const f = configure();
  try {
    const result = await runStandingWithPorts(f.input, f.ports);
    assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 2);
    const actions = f.packets[1]!.contextState.shared.snapshot.items.filter((item: any) => item.source === "ownActions");
    assert.equal(actions.length, 1); assert.equal(actions[0].evidence.content.text, "Я помню предыдущий ответ");
    assert.equal(actions[0].evidence.verdict, "verified"); assert.equal(actions[0].evidence.identityKnown, true);
    assert.equal(actions[0].evidence.observedAt, null); assert.equal(f.journalReads(), 1);
    const restarted = configure();
    const after = await runStandingWithPorts(restarted.input, restarted.ports);
    assert.equal(after.status, "stopped"); assert.equal(after.verifiedReplies, 2);
    const restored = restarted.packets[0]!.contextState.shared.snapshot.items.filter((item: any) => item.source === "ownActions");
    assert.equal(restarted.packets[0]!.contextState.memory.ownActionRecovery, "bounded-checkpoint");
    assert.equal(restored.length, 2, "first new-process packet restores both prior persisted answers");
    assert.ok(restored.some((item: any) => item.evidence.actionRef === actions[0].evidence.actionRef));
    assert.ok(restored.every((item: any) => item.evidence.verdict === "verified" && item.evidence.currentAvailability === "not-checked"));
    assert.notEqual(restarted.packets[0]!.contextState.shared.snapshot.scope.scopeRef, f.packets[0]!.contextState.shared.snapshot.scope.scopeRef);
    assert.equal(restarted.journalReads(), 1);
    const checkpointPath = join(root, "own-action-memory", "checkpoint.enc");
    assert.ok(!(await readFile(checkpointPath, "utf8")).includes("Я помню предыдущий ответ"));
    await writeFile(checkpointPath, "synthetic damaged checkpoint");
    const damaged = configure(), damagedResult = await runStandingWithPorts(damaged.input, damaged.ports);
    assert.equal(damagedResult.status, "stopped"); assert.equal(damagedResult.verifiedReplies, 2);
    assert.equal(damagedResult.lockPreserved, false);
    assert.equal(damaged.packets[0]!.contextState.memory.ownActionRecovery, "unavailable");
    assert.equal(damaged.packets[0]!.contextState.shared.snapshot.items.filter((item: any) => item.source === "ownActions").length, 0);
    assert.equal(await readFile(checkpointPath, "utf8"), "synthetic damaged checkpoint", "optional failure never repairs or overwrites uncertain storage");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("teardown revokes delayed producer observations before final memory flush", async () => {
  const root = await mkdtemp(join(tmpdir(), "standing-own-late-memory-")), f = warmFixture();
  f.input = { ...f.input, stateDirectory: root };
  let last: Parameters<typeof runPilotReply>[0] | undefined, slots = 0;
  f.ports.store = (_directory, passphrase) => createEncryptedPilotStore(join(root, String(++slots)), passphrase);
  f.ports.dispatch = async input => { last = input; return { state: "verified", code: "verified" }; };
  const close = f.connection.close;
  f.connection.close = async () => {
    assert.ok(last);
    const source = await runPilotReply({ ...last, signal: new AbortController().signal, killSwitchEngaged: () => false,
      transport: { async sendOnce() { return { messageId: 102 }; }, async readExact() {
        return { ...last!.reply, accountId: "100", messageId: 102 };
      } } });
    assert.equal(source.state, "verified", "actual source persistence completes after capture revocation");
    return close();
  };
  try {
    assert.equal((await runStandingWithPorts(f.input, f.ports)).status, "stopped");
    await assert.rejects(readFile(join(root, "own-action-memory", "checkpoint.enc")), { code: "ENOENT" });
    assert.ok((await readFile(join(root, "2", "terminal.enc"), "utf8")).length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsettled teardown cannot flush the last staged own action", async () => {
  const root = await mkdtemp(join(tmpdir(), "standing-own-unsettled-memory-")), f = warmFixture(fixture({ teardownFails: true }));
  f.input = { ...f.input, stateDirectory: root };
  f.ports.store = (_directory, passphrase) => createEncryptedPilotStore(join(root, "source"), passphrase);
  f.ports.dispatch = async input => {
    const result = await runPilotReply({ ...input, transport: {
      async sendOnce() { return { messageId: 101 }; },
      async readExact() { return { ...input.reply, accountId: "100", messageId: 101 }; },
    } });
    assert.equal(result.state, "verified"); f.abort.abort(); return result;
  };
  try {
    const result = await runStandingWithPorts(f.input, f.ports);
    assert.equal(result.status, "blocked"); assert.equal(result.clientSettled, false); assert.equal(result.lockPreserved, true);
    await assert.rejects(readFile(join(root, "own-action-memory", "checkpoint.enc")), { code: "ENOENT" });
    assert.ok((await readFile(join(root, "source", "terminal.enc"), "utf8")).length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["successor", "repeated-refusal", "unknown"] as const) test(`epoch admission boundary ${mode} preserves the selected request without replaying uncertain work`, async () => {
  const f = warmFixture(undefined, true), attempts = new Map<string, number>();
  let turns = 0, observed = 0;
  f.connection.turn = async (requestRef, text) => {
    turns++; const count = (attempts.get(requestRef) ?? 0) + 1; attempts.set(requestRef, count);
    assert.ok(JSON.parse(text).contextState.restoration);
    if (mode === "unknown") throw Error("uncertain-native-turn");
    if (count === 1 || mode === "repeated-refusal") return { kind: "not-admitted", reason: "limit" };
    observed++; return { kind: "text", answer: "Ответ из свежей сессии" };
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(turns, mode === "successor" ? 4 : mode === "repeated-refusal" ? 2 : 1);
  assert.equal(observed, mode === "successor" ? 2 : 0);
  assert.equal(f.counters().clients, 1);
  assert.equal(f.events.filter(event => event.startsWith("admission-")).length, mode === "successor" ? 2 : 1);
  assert.equal(f.releases.length, observed); assert.equal(result.verifiedReplies, observed);
  assert.equal(result.status, mode === "successor" ? "stopped" : "blocked");
});

test("actual read-only repository handlers reach warm turns and stop with the service", async () => {
  const f = warmFixture(), text = "export const answer = 42;\n", sourceCommit = "a".repeat(40);
  const snapshot = { schema: "neurobro-repository-snapshot-v1", sourceCommit,
    files: [{ path: "src/example.ts", text, sha256: createHash("sha256").update(text).digest("hex") }], excluded: [] };
  let tools: readonly EpochExtraTool[] = [];
  f.input = { ...f.input, repositorySnapshot: snapshot, openConversation(input) { tools = input.extraTools!; return f.connection; } };
  f.connection.turn = async requestRef => {
    assert.deepEqual(tools.map(tool => tool.name), ["neurobro_repo_info", "neurobro_repo_search", "neurobro_repo_read"]);
    const scope = { requestRef, callRef: "repo-call", signal: f.input.signal };
    const info = await tools[0]!.call({}, scope) as EpochToolResult, read = await tools[2]!.call({ path: "src/example.ts", offset: 0 }, scope) as EpochToolResult;
    assert.equal(info.success, true); assert.equal(read.success, true);
    assert.ok(JSON.stringify(info).includes(sourceCommit)); assert.ok(JSON.stringify(read).includes("export const answer = 42;"));
    return { kind: "text", answer: "В этой версии answer равен 42" };
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.verifiedReplies, 2); assert.equal(result.status, "stopped"); assert.equal(f.counters().clients, 1);
  const after = await tools[0]!.call({}, { requestRef: "later", callRef: "later", signal: new AbortController().signal }) as EpochToolResult;
  assert.equal(after.success, false);
});

test("invalid repository snapshot refuses before Telegram client or model admission", async () => {
  const f = warmFixture(); f.input = { ...f.input, repositorySnapshot: { schema: "wrong" } };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "blocked"); assert.equal(result.failureStage, "prepare");
  assert.equal(f.counters().clients, 0); assert.equal(f.packets.length, 0); assert.equal(f.events.includes("lock"), false);
});

test("formatting reaches the outbox as actual plaintext/entities and journal retains delivered text", async () => {
  const f = warmFixture(); f.input = { ...f.input, enableFormatting: true };
  f.connection.turn = async () => ({ kind: "text", answer: "😀 **Бро** и `код`" });
  f.ports.dispatch = async arg => { assert.equal(arg.reply.text, "😀 Бро и код"); assert.deepEqual(arg.reply.entities, [
    { type: "bold", offset: 3, length: 3 }, { type: "code", offset: 9, length: 3 }]); return { state: "verified", code: "verified" }; };
  const result = await runStandingWithPorts(f.input, f.ports); assert.equal(result.verifiedReplies, 2);
  assert.ok(f.outcomes.every(v => v.answer === "😀 Бро и код"));
  assert.ok(f.outcomes.every(v => JSON.stringify(v.entities) === JSON.stringify([
    { type: "bold", offset: 3, length: 3 }, { type: "code", offset: 9, length: 3 }])));
});

test("unknown delivery keeps submitted formatting and fixed cause through journal without replay", async () => {
  const f = warmFixture(); f.input = { ...f.input, enableFormatting: true };
  f.connection.turn = async () => ({ kind: "text", answer: "**Бро**" });
  let sends = 0;
  f.ports.dispatch = async () => { sends++; return { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: "readback-mismatch" }; };
  await runStandingWithPorts(f.input, f.ports);
  assert.equal(sends, 2); assert.equal(new Set(f.outcomes.map(row => row.key)).size, 2);
  assert.ok(f.outcomes.every(row => row.delivery === "unknown" && row.deliveryDiagnostic === "readback-mismatch"));
  assert.ok(f.outcomes.every(row => JSON.stringify(row.entities) === JSON.stringify([{ type: "bold", offset: 0, length: 3 }])));
});

test("nested code formatting preserves the answer through dispatch and journal", async () => {
  const f = warmFixture(); f.input = { ...f.input, enableFormatting: true };
  f.connection.turn = async () => ({ kind: "text", answer: "**Use `foo` now**" });
  f.ports.dispatch = async arg => { assert.equal(arg.reply.text, "Use foo now"); assert.deepEqual(arg.reply.entities, [
    { type: "bold", offset: 0, length: 4 }, { type: "code", offset: 4, length: 3 },
    { type: "bold", offset: 7, length: 4 }]); return { state: "verified", code: "verified" }; };
  const result = await runStandingWithPorts(f.input, f.ports); assert.equal(result.verifiedReplies, 2);
  assert.ok(f.outcomes.every(v => v.answer === "Use foo now"));
});

test("formatting cannot replace an original answer with whitespace", async () => {
  const f = warmFixture(); f.input = { ...f.input, enableFormatting: true };
  f.connection.turn = async () => ({ kind: "text", answer: "** **" });
  f.ports.dispatch = async arg => { assert.equal(arg.reply.text, "** **"); assert.equal(arg.reply.entities, undefined); return { state: "verified", code: "verified" }; };
  const result = await runStandingWithPorts(f.input, f.ports); assert.equal(result.verifiedReplies, 2);
  assert.ok(f.outcomes.every(v => v.answer === "** **"));
});

test("artifact handlers stay registered while per-turn ownership joins before final reply and release", async () => {
  const f = warmFixture(), adapter = f.ports.adapter, turn = f.connection.turn; let active: string | undefined, seen: readonly EpochExtraTool[] = [];
  const handlers = Object.freeze(STANDING_ARTIFACT_TOOL_SPECS.map(spec => Object.freeze({ name: spec.name,
    async call(_args: unknown, scope: { requestRef: string }) { assert.equal(scope.requestRef, active); f.events.push("artifact-call"); return { success: true, contentItems: [{ type: "inputText" as const, text: "{}" }] }; } })));
  f.ports.artifactRuntime = () => ({ handlers, specs: STANDING_ARTIFACT_TOOL_SPECS,
    copyProfileImage() { throw new Error("unused-profile-resolver"); },
    importGeneratedImage() { throw new Error("unused-image-import"); },
    importInputImage() { throw new Error("unused-input-image-import"); },
    takeGeneratedImageUse(_requestRef: string) { return undefined; },
    begin(value) { assert.equal(active, undefined); active = value.requestRef; assert.equal(typeof value.openArtifactTransport, "function"); f.events.push("artifact-begin"); },
    async finish() { assert.ok(active); active = undefined; f.events.push("artifact-finish"); },
    async close() { assert.equal(active, undefined); f.events.push("artifact-close"); },
    state: () => ({ active: active !== undefined, blocked: false, closed: false, operationSlots: 0 }) });
  f.ports.adapter = async arg => { assert.equal(arg.enableArtifacts, true); const a = await adapter(arg); return { ...a,
    async closeCapabilities() { f.events.push("artifact-capabilities-close"); },
    async next(signal) { const selected = await a.next(signal); return { ...selected, openArtifactTransport() { throw new Error("fixture-does-not-send"); } }; } }; };
  f.input = { ...f.input, enableArtifacts: true, openConversation(arg) { seen = arg.extraTools!; return f.connection; } };
  f.connection.turn = async (ref, text) => { assert.equal(active, ref); for (const handler of seen) await handler.call({}, { requestRef: ref, callRef: "fixture", signal: f.input.signal }); return turn(ref, text); };
  const dispatch = f.ports.dispatch; f.ports.dispatch = async arg => { assert.equal(active, undefined); assert.equal(f.events.at(-1), "fixture/outbox-" + arg.reply.replyToMessageId); return dispatch(arg); };
  const result = await runStandingWithPorts(f.input, f.ports); assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 2);
  assert.deepEqual(seen.map(h => h.name), STANDING_ARTIFACT_TOOL_SPECS.map(s => s.name)); assert.equal(f.events.filter(e => e === "artifact-call").length, 8);
  assert.equal(f.events.filter(e => e === "artifact-finish").length, 2); assert.ok(f.events.indexOf("artifact-finish") < f.events.indexOf("send-1"));
  assert.ok(f.events.includes("artifact-close")); assert.equal(f.events.filter(e => e === "settle-client").length, 1);
});

for (const mode of ["verified", "wrong-photo", "adapter-failed"] as const) test(`saved generated image bridge ${mode}: fresh scopes, optional absence, terminal adapter stop`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "saved-photo-service-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const f = warmFixture(), adapter = f.ports.adapter;
  f.input = { ...f.input, stateDirectory: directory, enableArtifacts: true };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const origin = { requestRef: "generated-before-reconnect", threadId: "old-thread", turnId: "old-turn", itemId: "old-image" };
  const generated = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  const image = generated.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: png.toString("base64") });
  const approved = { accountId: "100", chatId: "-200", replyToMessageId: 10, origin };
  const store = await openEncryptedGeneratedImageOutbox({ directory: join(directory, "media-outbox"), passphrase: f.credentials.passphrase, approved });
  let imageSends = 0;
  const delivery = await runGeneratedImageDelivery({ approved, registry: generated, artifactRef: image.ref, caption: "photo", store,
    signal: f.input.signal, killSwitchEngaged: () => false,
    transport: { async sendOnce() { imageSends++; return { messageId: 20, photoId: "77" }; },
      async readExact() { return { accountId: "100", chatId: "-200", replyToMessageId: 10, messageId: 20, photoId: "77", caption: "photo" }; } } });
  await delivery.settlement; assert.equal(delivery.delivery, "verified"); store.close(); generated.close();
  let runtime!: StandingArtifactRuntime, count = 0;
  f.ports.artifactRuntime = input => runtime = createStandingArtifactRuntime(input);
  f.ports.adapter = async arg => { const a = await adapter(arg); return { ...a, async closeCapabilities() {},
    async next() {
      if (count === 2) { f.abort.abort(); throw Error("done"); }
      const primary = { chatId: "-200", ownerId: "300", messageId: 30 + count++, text: "Поставь эту на аватарку" };
      const context = { version: "standing-context-v1" as const, primary: { chatId: primary.chatId,
        messageId: primary.messageId, text: primary.text, authorId: primary.ownerId,
        author: "user" as const, displayName: "Participant", date: 1700000000, replyToMessageId: 20 },
        replyChain: [], recent: [], chainStatus: "missing" as const, recentStatus: "complete" as const };
      await arg.checkpointQuestion!(primary, context); await arg.checkpointCursor!(primary.messageId);
      return { primary, context, cursor: primary.messageId, transport: {
          async sendOnce() { throw Error("fixture-dispatch-does-not-call-transport"); }, async readExact() { return null; } },
        async readOwnPhotoAnchor() {
          if (mode === "adapter-failed") throw Error("terminal-adapter-failure");
          return { messageId: 20, photoId: mode === "wrong-photo" ? "88" : "77", replyToMessageId: 10 };
        },
        openArtifactTransport() { throw Error("must-not-resend-image"); } };
    } }; };
  const refs: string[] = []; let turns = 0;
  f.connection.turn = async (requestRef, text) => {
    turns++; const packet = JSON.parse(text);
    if (mode !== "verified") {
      assert.equal(packet.availableArtifacts, undefined);
      return { kind: "text", answer: "Сохранённое изображение недоступно" };
    }
    const artifact = packet.availableArtifacts[0];
    assert.equal(artifact.origin, "own-generated-image"); assert.equal(artifact.avatarEligible, true);
    refs.push(artifact.artifactRef);
    const copy = runtime.copyProfileImage(requestRef, artifact.artifactRef);
    assert.deepEqual(copy.bytes, png); copy.bytes.fill(0);
    return { kind: "text", answer: "Изображение доступно для действия" };
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, mode === "adapter-failed" ? "blocked" : "stopped", JSON.stringify({ result, events: f.events, refs }));
  assert.equal(result.verifiedReplies, mode === "adapter-failed" ? 0 : 2);
  assert.equal(turns, mode === "adapter-failed" ? 0 : 2);
  assert.equal(imageSends, 1); assert.equal(f.counters().clients, 1);
  assert.equal(refs.length, mode === "verified" ? 2 : 0); if (mode === "verified") assert.notEqual(refs[0], refs[1]);
  assert.equal(runtime.state().closed, true);
});

for (const mode of ["available", "unavailable", "rotate", "album"] as const) test(`incoming photo pixels reach the same warm turn, clear after use: ${mode}`, async t => {
  const unavailable = mode === "unavailable";
  const f = warmFixture(), originalAdapter = f.ports.adapter;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const secondPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=", "base64");
  const borrowed: Buffer[] = [], refs: string[] = [];
  let runtime!: StandingArtifactRuntime, turns = 0;
  const directory = await mkdtemp(join(tmpdir(), "incoming-photo-service-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  f.input = { ...f.input, enableArtifacts: true, stateDirectory: directory };
  f.ports.artifactRuntime = input => runtime = createStandingArtifactRuntime(input);
  f.ports.adapter = async args => {
    const adapter = await originalAdapter(args);
    return { ...adapter, async closeCapabilities() {}, async next(signal) {
      const selected = await adapter.next(signal);
      let read = false;
      return { ...selected, openArtifactTransport() { throw Error("No outgoing image needed"); },
        async readInputImages() {
          assert.equal(read, false, "selected image capability is one-shot even across epoch rotation"); read = true;
          if (unavailable) return { images: [], unavailable: true as const };
          const bytes = Buffer.from(png); borrowed.push(bytes);
          if (mode === "album") {
            const second = Buffer.from(secondPng); borrowed.push(second);
            const messageId = selected.primary.messageId + 1;
            return { images: [{ messageId: selected.primary.messageId, mimeType: "image/png" as const, bytes },
              { messageId, mimeType: "image/png" as const, bytes: second }],
              sources: [{ chatId: selected.primary.chatId, messageId, authorId: selected.primary.ownerId, author: "user" as const,
                displayName: "Участник", date: 1700000000, replyToMessageId: null, text: "[Фото из альбома]" }] };
          }
          return { images: [{ messageId: selected.primary.messageId, mimeType: "image/png" as const, bytes }] };
        } };
    } };
  };
  f.connection.turn = async (requestRef, text, images) => {
    turns++;
    const packet = JSON.parse(text);
    assert.deepEqual(packet.contextState.visualInput, { provided: unavailable ? 0 : mode === "album" ? 2 : 1, unavailable });
    if (unavailable) { assert.equal(images, undefined); assert.equal(packet.availableArtifacts, undefined); }
    else {
      assert.equal(images?.length, mode === "album" ? 2 : 1); assert.deepEqual(images![0]!.bytes, png);
      if (mode === "album") {
        assert.deepEqual(images![1]!.bytes, secondPng);
        assert.equal(packet.visualSourceMessages.length, 1);
        assert.equal(packet.availableArtifacts[1].sourceMessage, packet.visualSourceMessages[0].id);
        const copy = runtime.copyProfileImage(requestRef, packet.availableArtifacts[1].artifactRef);
        assert.deepEqual(copy.bytes, secondPng); copy.bytes.fill(0);
      }
      const artifact = packet.availableArtifacts[0]; refs.push(artifact.artifactRef);
      assert.equal(artifact.sourceMessage, packet.currentRequest.id); assert.equal(artifact.origin, "telegram-image");
      const copy = runtime.copyProfileImage(requestRef, artifact.artifactRef); assert.deepEqual(copy.bytes, png); copy.bytes.fill(0);
      if (borrowed.length > (mode === "album" ? 2 : 1)) assert.ok(borrowed[0]!.every(byte => byte === 0));
    }
    if (mode === "rotate" && turns === 1) return { kind: "not-admitted", reason: "limit" };
    return { kind: "text", answer: unavailable ? "Фото сейчас не загрузилось" : "Вижу изображение" };
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped", JSON.stringify({ result, events: f.events })); assert.equal(result.verifiedReplies, 2); assert.equal(turns, mode === "rotate" ? 3 : 2);
  assert.equal(f.counters().clients, 1); assert.ok(borrowed.every(bytes => bytes.every(byte => byte === 0)));
  if (!unavailable) assert.notEqual(refs[0], refs[1]);
});

test("media reader is passed to the sole adapter and cleanup joins alongside main client settlement", async () => {
  const f = warmFixture(), originalAdapter = f.ports.adapter, settle = f.ports.settle;
  f.input = { ...f.input, enableImages: true };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const readMediaFile = async () => { throw Error("No media in this scenario"); };
  f.ports.mediaReader = () => ({ readMediaFile, async close() { f.events.push("media-close"); await pending; f.events.push("media-joined"); } });
  f.ports.adapter = async input => {
    assert.equal(input.readMediaFile, readMediaFile);
    return { ...await originalAdapter(input), async closeCapabilities() {} };
  };
  f.ports.settle = async client => { assert.ok(f.events.includes("media-close")); finish(); return settle(client); };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(f.counters().clients, 1);
  assert.ok(f.events.indexOf("media-joined") < f.events.indexOf("release-lock"));
});

test("adapter initialization failure settles and joins an already-created media reader before reconnect", async () => {
  const f = warmFixture(), originalAdapter = f.ports.adapter, settle = f.ports.settle;
  f.input = { ...f.input, enableImages: true };
  let calls = 0, finish: (() => void) | undefined, mediaClosed = 0;
  f.ports.mediaReader = () => ({ async readMediaFile() { throw Error("unused"); }, async close() {
    f.events.push("media-close"); await new Promise<void>(resolve => { finish = resolve; }); mediaClosed++;
  } });
  f.ports.adapter = async input => {
    if (++calls === 1) throw Object.assign(new Error("synthetic connection loss"), { code: "transport" });
    assert.equal(mediaClosed, 1);
    return { ...await originalAdapter(input), async closeCapabilities() {} };
  };
  f.ports.settle = async client => { assert.ok(finish); finish!(); finish = undefined; return settle(client); };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(f.counters().clients, 2); assert.equal(mediaClosed, 2);
  assert.equal(result.verifiedReplies, 2);
});

test("group flag forwards only source-owned adapter handlers and joins after client interruption",async()=>{
  const f=warmFixture(), originalAdapter=f.ports.adapter, originalClose=f.connection.close, originalSettle=f.ports.settle;
  let resolveIo!:()=>void;const io=new Promise<void>(done=>{resolveIo=done;});let seen:readonly EpochExtraTool[]|undefined;
  const handlers=Object.freeze([Object.freeze({name:"neurobro_group_info",call:async()=>({success:true,contentItems:[{type:"inputText",text:'{"title":"bound"}'}]})})]);
  f.ports.adapter=async arg=>{assert.equal(arg.enableGroupTools,true);const adapter=await originalAdapter(arg);return {...adapter,extraTools:handlers,
    async closeCapabilities(){f.events.push("capability-close-start");await io;f.events.push("capability-joined");}};};
  f.input={...f.input,enableGroupTools:true,openConversation(arg){seen=arg.extraTools;return f.connection;}};
  f.connection.close=async()=>{f.events.push("native-close-start");await io;return originalClose();};
  f.ports.settle=async client=>{assert.ok(f.events.includes("native-close-start"));assert.ok(f.events.includes("capability-close-start"));resolveIo();return originalSettle(client);};
  const result=await runStandingWithPorts(f.input,f.ports);assert.equal(result.status,"stopped");assert.equal(seen,handlers);
  assert.equal(f.events.filter(e=>e==="settle-client").length,1);assert.ok(f.events.indexOf("capability-joined")<f.events.indexOf("release-lock"));
  assert.throws(()=>f.refs().message(1));
});

test("bound actions are registered and scoped to each model turn then joined before its final answer", async () => {
  const f = warmFixture(), originalAdapter = f.ports.adapter;
  let active: string | undefined, seen: readonly EpochExtraTool[] = [];
  const handlers = Object.freeze(BOUND_ACTION_TOOL_SPECS.map(spec => Object.freeze({ name: spec.name,
    async call(_args: unknown, scope: { requestRef: string }) {
      assert.equal(scope.requestRef, active); f.events.push("bound-action-call");
      return { success: true, contentItems: [{ type: "inputText" as const, text: '{"verdict":"verified"}' }] };
    } })));
  f.ports.actionRuntime = () => ({ handlers, specs: BOUND_ACTION_TOOL_SPECS,
    begin(selection) { assert.equal(active, undefined); active = selection.requestRef; assert.equal(typeof selection.openActions, "function"); f.events.push("actions-begin"); },
    async finish() { assert.ok(active); active = undefined; f.events.push("actions-finish"); },
    async close() { assert.equal(active, undefined); f.events.push("actions-close"); },
    state: () => ({ active: active !== undefined, blocked: false, closed: false, operationSlots: 0 }) });
  f.ports.adapter = async arg => { assert.equal(arg.enableBoundActions, true); const a = await originalAdapter(arg); return { ...a,
    async closeCapabilities() { f.events.push("actions-capabilities-close"); },
    async next(signal) { return { ...await a.next(signal), openActions() { throw new Error("fixture-not-a-real-send"); } }; } }; };
  f.input = { ...f.input, enableBoundActions: true, openConversation(arg) { seen = arg.extraTools!; return f.connection; } };
  f.connection.turn = async ref => {
    for (const handler of seen) await handler.call({}, { requestRef: ref, callRef: "test", signal: f.input.signal });
    return { kind: "text", answer: "Опрос готов" };
  };
  const dispatch = f.ports.dispatch; f.ports.dispatch = async arg => { assert.equal(active, undefined); return dispatch(arg); };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.verifiedReplies, 2); assert.equal(result.status, "stopped");
  assert.deepEqual(seen.map(h => h.name), BOUND_ACTION_TOOL_SPECS.map(s => s.name));
  assert.equal(f.events.filter(e => e === "bound-action-call").length, BOUND_ACTION_TOOL_SPECS.length * 2);
  assert.ok(f.events.indexOf("actions-finish") < f.events.indexOf("send-1"));
  assert.ok(f.events.includes("actions-close")); assert.equal(f.events.filter(e => e === "settle-client").length, 1);
});

test("absent group flag preserves history-only openConversation input",async()=>{
  const f=warmFixture(),originalAdapter=f.ports.adapter,originalOpen=f.input.openConversation!;
  f.ports.adapter=async arg=>{assert.equal(Object.hasOwn(arg,"enableGroupTools"),false);return originalAdapter(arg);};
  f.input={...f.input,openConversation(arg){assert.equal(Object.hasOwn(arg,"extraTools"),false);return originalOpen(arg);}};
  assert.equal((await runStandingWithPorts(f.input,f.ports)).status,"stopped");
});

test("failed client settlement never waits forever on group callbacks or permits replacement",async()=>{
  const f=warmFixture(fixture({teardownFails:true})), originalAdapter=f.ports.adapter;
  const pending=new Promise<void>(()=>{});
  f.ports.adapter=async arg=>({...await originalAdapter(arg),extraTools:[],closeCapabilities:()=>pending});
  f.input={...f.input,enableGroupTools:true};
  const result=await runStandingWithPorts(f.input,f.ports);assert.equal(result.status,"blocked");assert.equal(result.lockPreserved,true);
  assert.equal(result.clientSettled,false);assert.equal(f.counters().clients,1);assert.ok(f.refs().matches("-200","100"));f.refs().close();
});

test("native rotation restores the earlier verified own answer without reconnecting Telegram", async () => {
  const f = warmFixture(fixture(), true);const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.verifiedReplies, 2);assert.equal(f.counters().clients, 1);assert.equal(f.journalReads(), 2);
  const pair = f.packets[1]!.contextState.restoration.pairs[0];
  assert.equal(pair.question.id, f.packets[0]!.currentRequest.id);assert.equal(pair.answer.text, "Я помню предыдущий ответ");
  assert.equal(pair.answer.speaker, "neurobro");assert.equal(pair.answer.telegramMessageId, null);
  assert.equal(f.packets[1]!.currentRequest.text, "2");assert.equal(f.packets[1]!.contextState.restoration.pairs.length, 1);
  const shared = f.packets[1]!.contextState.shared.snapshot;
  const restored = shared.items.find((item: any) => item.source === "dialogues");
  assert.equal(restored.evidence.answer.text, pair.answer.text);
  assert.equal(restored.evidence.observedAt, pair.recordedAt);
  assert.ok(restored.evidence.observedAt > 1600000000);
  assert.equal(shared.scope.scopeRef, f.packets[0]!.contextState.shared.snapshot.scope.scopeRef);
  assert.equal(shared.coverage.dialogues.scope, "selected-dialogues");
});

test("proven pre-dispatch refusal remains consumed and next request runs after settlement", async () => {
  const f = warmFixture(), dispatch = f.ports.dispatch;
  let calls = 0;
  f.ports.dispatch = async input => ++calls === 1
    ? { state: "failed_terminal", code: "pre-dispatch-refused", deliveryDiagnostic: "pre-dispatch-refused" }
    : dispatch(input);
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 1); assert.equal(f.counters().clients, 2);
  assert.equal(calls, 2); assert.deepEqual(f.packets.map(p => p.currentRequest.text), ["1", "2"]);
  assert.equal(f.outcomes[0]!.delivery, "not-sent"); assert.equal(f.outcomes[0]!.deliveryDiagnostic, "pre-dispatch-refused");
  assert.deepEqual(f.releases.map(row => row[1]), ["not-sent", "verified"]);
  assert.ok(f.events.indexOf("settle-client") < f.events.indexOf("STANDING_RECONNECTING"));
});

test("consumed failed native turn resumes only the next question after all owners settle", async () => {
  const f=warmFixture(),turn=f.connection.turn,close=f.connection.close,open=f.input.openConversation!;
  let calls=0,failed=false;
  f.input={...f.input,openConversation(arg){failed=false;return open(arg);}};
  f.connection.state=()=>({blocked:false,failedTurn:failed});
  f.connection.turn=async(ref,text)=>{
    f.events.push(`attempt-${JSON.parse(text).currentRequest.text}`);
    if(++calls===1){failed=true;throw Error("synthetic native failure");}
    return turn(ref,text);
  };
  f.connection.close=async()=>{const proof=await close();f.events.push("model-proof-persisted");return proof;};
  const result=await runStandingWithPorts(f.input,f.ports);
  assert.equal(result.status,"stopped");assert.equal(result.verifiedReplies,1);assert.equal(result.lockPreserved,false);
  assert.equal(f.counters().clients,2);assert.equal(calls,2);
  assert.deepEqual(f.events.filter(e=>e.startsWith("attempt-")),["attempt-1","attempt-2"]);
  assert.ok(!f.events.includes("send-1"));assert.ok(f.events.includes("send-2"));
  assert.ok(f.events.indexOf("model-proof-persisted")<f.events.indexOf("STANDING_RECONNECTING"));
  assert.ok(f.events.indexOf("settle-client")<f.events.indexOf("STANDING_RECONNECTING"));
  assert.equal(f.outcomes.some(v=>v.key==="0000000001"),false); // Existing admission remains UNKNOWN, never fabricated success.
});

for(const failure of ["native","persistence","telegram","unclassified"] as const)test(`failed native turn does not reconnect without ${failure} acceptance`,async()=>{
  const f=warmFixture(fixture({teardownFails:failure==="telegram"}));
  f.connection.state=()=>({blocked:false,failedTurn:failure!=="unclassified"});
  f.connection.turn=async()=>{throw Error("synthetic native failure");};
  if(failure==="native"||failure==="persistence")f.connection.close=async()=>({resourcesSettled:failure!=="native",persisted:failure!=="persistence"});
  const result=await runStandingWithPorts(f.input,f.ports);
  assert.equal(result.status,"blocked");assert.equal(result.lockPreserved,true);
  assert.equal(f.counters().clients,1);assert.ok(!f.events.includes("STANDING_RECONNECTING"));
  assert.ok(!f.events.some(e=>e.startsWith("send-")));
});

test("unknown native resource settlement preserves the lock and reference lifetime", async () => {
  const f = warmFixture();f.connection.close = async () => ({ resourcesSettled: false, persisted: true });
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "blocked");assert.equal(result.lockPreserved, true);
  assert.ok(!f.events.includes("release-lock"));assert.ok(f.refs().matches("-200", "100"));f.refs().close();
});

test("warm model receives only the existing history capability and closes before its reference owner", async () => {
  const f = warmFixture();const turn = f.connection.turn;
  f.connection.turn = async (ref, text) => {
    const page = await f.history.call({ fromDate: 1700000000, toDate: 1700000100, cursor: null });
    assert.equal(page.success, true);return turn(ref, text);
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.verifiedReplies, 2);assert.equal(f.events.filter(v => v === "history-call").length, 2);
});

test("warm image release waits for actual upload/readback and journal outcome", async () => {
  const imageFixture = images(), model = imageFixture.input.model, f = warmFixture(imageFixture);
  f.connection.turn = async (_ref, text) => { f.packets.push(JSON.parse(text)); return completedStandingResult(await model(text, f.input.signal)); };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.verifiedReplies, 2);assert.deepEqual(f.releases.map(v => v[1]), ["verified", "verified"]);
  assert.ok(f.events.indexOf("image-read-1") < f.events.indexOf("epoch-release"));
  assert.ok(f.events.indexOf("outcome-1") < f.events.indexOf("epoch-release"));
  assert.ok(f.events.indexOf("epoch-release") < f.events.indexOf("close-image-1"));
  const photo = f.packets[1]!.contextState.shared.snapshot.items.find((item: any) => item.source === "ownActions").evidence;
  assert.equal(photo.kind, "photo"); assert.equal(photo.verdict, "verified");
  assert.equal(photo.content.caption, "Готово 1"); assert.equal(photo.currentAvailability, "not-checked");
});

test("an uncertain bound action still forces reconnect after a verified final image", async () => {
  const f = warmFixture(images()), model = f.input.model, adapter = f.ports.adapter;
  let active = false;
  f.ports.actionRuntime = () => ({ handlers: [], specs: BOUND_ACTION_TOOL_SPECS,
    begin() { active = true; }, async finish() { active = false; }, async close() { active = false; },
    state: () => ({ active, blocked: true, closed: false, operationSlots: 1 }) });
  f.ports.adapter = async args => { const a = await adapter(args); return { ...a,
    async closeCapabilities() {}, async next(signal) { return { ...await a.next(signal), openActions() { throw Error("fixture"); } }; } }; };
  f.input = { ...f.input, enableBoundActions: true };
  f.connection.turn = async (_ref, text) => completedStandingResult(await model(text, f.input.signal));
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.verifiedReplies, 2);
  assert.equal(f.events.filter(v => v === "STANDING_UNKNOWN_CONSUMED").length, 2);
  assert.ok(f.counters().clients > 1);
  assert.ok(f.events.indexOf("epoch-close") < f.events.indexOf("client-2"));
});

test("STOP during a warm text send joins the real transport before native release and client close", async () => {
  const f=warmFixture(),entered=deferred<void>(),sendEnd=deferred<void>(),adapter=f.ports.adapter;
  f.ports.adapter=async arg=>{
    const active=await adapter(arg);
    return {...active,next:async signal=>{
      const selected=await active.next(signal);
      return {...selected,transport:{
        async sendOnce(){entered.resolve();await sendEnd.promise;f.events.push("text-send-ended");return {messageId:77};},
        async readExact(){throw Error("no readback after abort");},
      }};
    }};
  };
  f.ports.store=()=>({reserve:async()=>{},append:async()=>{}});
  f.ports.dispatch=runPilotReply;
  let finished=false;const running=runStandingWithPorts(f.input,f.ports).then(value=>{finished=true;return value;});
  await entered.promise;f.abort.abort();await tick();
  assert.equal(finished,false);assert.equal(f.releases.length,0);assert.ok(!f.events.includes("epoch-close"));
  sendEnd.resolve();const result=await running;
  assert.equal(result.status,"stopped");assert.deepEqual(f.releases.map(v=>v[1]),["unknown"]);
  assert.ok(f.events.indexOf("text-send-ended")<f.events.indexOf("epoch-release"));
  assert.ok(f.events.indexOf("epoch-release")<f.events.indexOf("settle-client"));
});

test("service passes selected reply context to the model and keeps outbox anchored to the original request", async () => {
  const f = fixture();
  const controller = new AbortController(); f.input = { ...f.input, signal: controller.signal };
  let cursor = 0, selected = false;
  f.ports.state = async () => ({ cursor: () => cursor, checkpointCursor: async id => { cursor = id; }, newOutbox: () => "fixture/context-outbox" });
  f.ports.adapter = async arg => ({
    async next() {
      if (selected) { controller.abort(); throw new Error("aborted"); }
      selected = true;
      await arg.checkpointQuestion!({ chatId: "-200", ownerId: "300", messageId: 20, text: "ПРОМПТ а почему?" }, undefined as never);
      await arg.checkpointCursor(20);
      return { primary: { chatId: "-200", ownerId: "300", messageId: 20, text: "ПРОМПТ а почему?" }, cursor: 20,
        transport: {} as never, context: { version: "standing-context-v1",
          primary: { chatId: "-200", authorId: "300", author: "user", displayName: "А", messageId: 20, date: 100, replyToMessageId: 19, text: "ПРОМПТ а почему?" },
          replyChain: [{ chatId: "-200", authorId: "100", author: "self", displayName: "Нейробро", messageId: 19, date: 99, replyToMessageId: null, text: "Мой предыдущий ответ" }],
          recent: [], chainStatus: "complete", recentStatus: "complete" },
      };
    }, close() {}, async closeCapabilities() {}, async pollNext() { throw new Error("unexpected polling API"); }, async pollWork() { throw new Error("unexpected work polling API"); },
  });
  f.input = { ...f.input, model: async text => {
    const packet = JSON.parse(text);
    assert.equal(packet.currentRequest.text, "а почему?");
    assert.equal(packet.replyChain[0].text, "Мой предыдущий ответ");
    assert.equal(packet.currentRequest.replyTo, packet.replyChain[0].id);
    return { answer: "Объясняю предыдущий ответ", receipt: { version: "modeltext-host-v1", outcome: "observed", exitCode: 0,
      transportError: false, timedOut: false, aborted: false, overflow: false, guestSettled: true, clientSettled: true,
      relaySettled: true, custodyReady: true, appServerSettled: true, turnCompleted: true,
      answerBytes: Buffer.byteLength("Объясняю предыдущий ответ") } };
  } };
  f.ports.dispatch = async arg => {
    assert.equal(arg.approved.replyToMessageId, 20); assert.equal(arg.reply.replyToMessageId, 20);
    assert.equal(arg.reply.text, "Объясняю предыдущий ответ");
    return { state: "verified", code: "verified" };
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.verifiedReplies, 1); assert.equal(result.status, "stopped");
});

test("wake command is removed only at the start; body and similarly named words stay intact", () => {
  assert.equal(addressedModelText("ПРОМПТ: почему небо синее?"), "почему небо синее?");
  assert.equal(addressedModelText("ПРОМПТ\nОбъясни слово ПРОМПТ"), "Объясни слово ПРОМПТ");
  assert.equal(addressedModelText("ПРОМПТИНГ интересен"), "ПРОМПТИНГ интересен");
  assert.equal(addressedModelText("А что такое ПРОМПТ?"), "А что такое ПРОМПТ?");
  assert.ok(!addressedModelText("ПРОМПТ").includes("ПРОМПТ"));
});

test("typing starts alongside the model, settles before delivery and never substitutes for the answer", async () => {
  const events: string[] = [], signal = new AbortController().signal;
  let finishPulse: (() => void) | undefined;
  const result = withTyping(async () => { events.push("model"); return "answer"; }, async () => {
    events.push("typing"); await new Promise<void>(done => { finishPulse = done; }); events.push("typing-settled");
  }, signal);
  await Promise.resolve(); assert.deepEqual(events, ["typing", "model"]);
  finishPulse!(); assert.equal(await result, "answer");
  assert.deepEqual(events, ["typing", "model", "typing-settled"]);
  assert.equal(await withTyping(async () => "still answers", async () => { throw Error("typing unavailable"); }, signal), "still answers");
});

test("settled unknown answer receives one fixed guarded notice, then continues with next input", async () => {
  const f = fixture({ unknownFirst: true }), dispatch = f.ports.dispatch, texts: string[] = [];
  f.ports.dispatch = async arg => { texts.push(arg.reply.text); return dispatch(arg); };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.verifiedReplies, 1); assert.equal(result.status, "stopped");
  assert.deepEqual(texts, [STANDING_DEFERRED_REPLY, "fixture answer"]);
  assert.deepEqual(f.counters(), { clients: 2, models: 2 });
  assert.equal(f.events.filter(event => event === "send-1").length, 1);
  assert.ok(f.events.includes("fixture/outbox-1") && f.events.includes("fixture/outbox-2"));
  assert.ok(f.events.indexOf("settle-client") < f.events.indexOf("client-2"));
});

test("unknown delivery of a failure notice is consumed without sending it again", async () => {
  const f = fixture({ unknownFirst: true }), sent: number[] = [];
  f.ports.dispatch = async arg => {
    sent.push(arg.reply.replyToMessageId!);
    return arg.reply.replyToMessageId === 1 ? { state: "unknown", code: "send-or-readback-unknown" } : { state: "verified", code: "verified" };
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.deepEqual(sent, [1, 2]); assert.equal(result.verifiedReplies, 1);
  const stopped = fixture({ unknownFirst: true, stopAfterModel: true });
  await runStandingWithPorts(stopped.input, stopped.ports);
  assert.ok(!stopped.events.includes("send-1"));
});

test("unconfirmed model settlement blocks new turns and preserves owner lock", async () => {
  const f = fixture({ modelBlocked: true }); const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "blocked"); assert.equal(result.lockPreserved, true);
  assert.deepEqual(f.counters(), { clients: 1, models: 1 }); assert.ok(!f.events.includes("send-1"));
});

test("unconfirmed Telegram teardown never starts a replacement client", async () => {
  const f = fixture({ unknownFirst: true, teardownFails: true }); const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "blocked"); assert.equal(result.clientSettled, false);
  assert.equal(f.counters().clients, 1); assert.ok(!f.events.includes("release-lock"));
});

test("checkpoint failure cannot reach model; STOP after model cannot reach send", async () => {
  const f = fixture({ checkpointFails: true }); const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "blocked"); assert.equal(f.counters().models, 0);
  const g = fixture({ stopAfterModel: true }); const stopped = await runStandingWithPorts(g.input, g.ports);
  assert.equal(stopped.status, "stopped"); assert.ok(!g.events.includes("send-1"));
});

test("plain connection failure reconnects only after old client teardown", async () => {
  const f = fixture(), original = f.ports.createClient;
  let first = true;
  f.ports.createClient = (...args) => {
    const client = original(...args);
    if (first) { first = false; client.connect = async () => { throw new Error("socket failed"); }; }
    return client;
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 2);
  assert.ok(f.events.indexOf("settle-client") < f.events.indexOf("client-2"));
});

test("STOP interrupts an idle adapter without waiting for another message", async () => {
  const f = fixture(); let stopped = false;
  f.ports.killed = () => stopped;
  f.ports.adapter = async () => ({
    next: signal => new Promise((_, reject) => {
      stopped = true;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), close() {}, async closeCapabilities() {}, async pollNext() { throw new Error("unexpected polling API"); }, async pollWork() { throw new Error("unexpected work polling API"); },
  });
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(result.lockPreserved, false);
  assert.equal(f.counters().models, 0);
});

test("journal ordering is question then cursor then admission then model then guarded delivery and truthful outcome", async () => {
  const f = fixture(); await runStandingWithPorts(f.input, f.ports);
  for (const id of [1, 2]) {
    const sequence = [`question-${id}`, `checkpoint-${id}`, `admission-${id}`, `model-${id}`, `send-${id}`, `outcome-${id}`];
    assert.deepEqual([...sequence].sort((a, b) => f.events.indexOf(a) - f.events.indexOf(b)), sequence);
  }
  assert.equal(f.questions[0]!.primary.text, "ПРОМПТ 1"); assert.equal(f.questions[0]!.context, undefined);
  assert.deepEqual(f.outcomes.map(value => [value.delivery, value.kind, value.answer]), [["verified", "model", "fixture answer"], ["verified", "model", "fixture answer"]]);
  assert.ok(f.events.indexOf("close-journal") < f.events.indexOf("release-session"));
});

test("an existing durable admission skips model and send then reconnects after sole client teardown", async () => {
  const f = fixture(), make = f.ports.journal;
  f.ports.journal = async arg => {
    const journal = await make(arg); return { ...journal, recordModelAdmission: async value => {
      if (value.key === "0000000001") { f.events.push("existing-admission"); return { created: false }; }
      return journal.recordModelAdmission(value);
    } };
  };
  const result = await runStandingWithPorts(f.input, f.ports);
  assert.equal(result.status, "stopped"); assert.equal(result.verifiedReplies, 1);
  assert.deepEqual(f.counters(), { clients: 2, models: 1 }); assert.ok(!f.events.includes("model-1") && !f.events.includes("send-1"));
  assert.ok(f.events.indexOf("settle-client") < f.events.indexOf("client-2")); assert.equal(f.outcomes.length, 1);
});

test("question persistence failure blocks cursor/model and model uncertainty leaves admission without invented delivery", async () => {
  const f = fixture(), make = f.ports.journal;
  f.ports.journal = async arg => ({ ...await make(arg), recordQuestion: async () => { throw new Error("PRIVATE journal failure"); } });
  const blocked = await runStandingWithPorts(f.input, f.ports); assert.equal(blocked.status, "blocked");
  assert.equal(f.counters().models, 0); assert.ok(!f.events.includes("checkpoint-1"));
  const uncertain = fixture({ modelBlocked: true }); await runStandingWithPorts(uncertain.input, uncertain.ports);
  assert.ok(uncertain.events.includes("admission-1")); assert.deepEqual(uncertain.outcomes, []);
  const stopped = fixture({ stopAfterModel: true }); await runStandingWithPorts(stopped.input, stopped.ports);
  assert.equal(stopped.outcomes[0]!.delivery, "not-sent"); assert.equal(stopped.outcomes[0]!.answer, "fixture answer");
  const deferred = fixture({ unknownFirst: true }); deferred.ports.dispatch = async () => ({ state: "unknown", code: "send-or-readback-unknown" });
  await runStandingWithPorts(deferred.input, deferred.ports);
  assert.equal(deferred.outcomes[0]!.delivery, "unknown"); assert.equal(deferred.outcomes[0]!.kind, "deferred"); assert.equal(deferred.outcomes[0]!.answer, STANDING_DEFERRED_REPLY);
});

const IMAGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
function generatedAvatarPng(size: number): Buffer {
  const base = Buffer.from(IMAGE_PNG, "base64"), data = Buffer.alloc(size - base.length - 12, 65);
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write("tEXt", 4, "ascii");
  const body = Buffer.concat([Buffer.from("tEXt", "ascii"), data]); let crc = 0xffffffff;
  for (const value of body) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([base.subarray(0, 33), head, data, tail, base.subarray(33)]);
}
for (const mode of ["self-avatar", "group-avatar", "no-image"] as const) test(`generated image plan completes through real artifact/action runtimes: ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "standing-image-use-"));
  const f = warmFixture(images()), originalAdapter = f.ports.adapter;
  let tools: readonly EpochExtraTool[] = [], turns = 0, actions = 0;
  let artifactRuntime: StandingArtifactRuntime | undefined;
  f.input = { ...f.input, stateDirectory: root, enableArtifacts: true, enableBoundActions: true,
    openConversation(input) { tools = input.extraTools!; return f.connection; } };
  f.ports.artifactRuntime = input => artifactRuntime = createStandingArtifactRuntime(input);
  f.ports.actionRuntime = createStandingBoundActionRuntime;
  f.ports.imageStore = openEncryptedGeneratedImageOutbox;
  const dispatch = f.ports.dispatch;
  f.ports.dispatch = async input => {
    const result = await dispatch(input);
    if (input.reply.replyToMessageId === 2) f.abort.abort();
    return result;
  };
  f.ports.adapter = async input => { const adapter = await originalAdapter(input); return { ...adapter,
    async closeCapabilities() { f.events.push("generated-image-capabilities-closed"); },
    async next(signal) {
      const selected = await adapter.next(signal); return { ...selected,
      openArtifactTransport() { throw Error("no file send expected"); },
      openActions(resolveImage) { return { async execute(action) {
        actions++; assert.equal(artifactRuntime!.state().active, true);
        assert.equal(action.kind, mode === "group-avatar" ? "set-group-avatar" : "set-avatar");
        assert.ok(action.kind === "set-avatar" || action.kind === "set-group-avatar");
        const image = resolveImage!(action.artifactRef);
        try { assert.equal(Buffer.from(image.bytes).toString("base64"), IMAGE_PNG); f.events.push("avatar-verified"); }
        finally { image.bytes.fill(0); }
        return { outcome: { verdict: "verified" as const } };
      }, async close() { f.events.push("avatar-lease-closed"); } }; },
    }; },
  }; };
  f.connection.turn = async requestRef => {
    if (++turns > 1) return { kind: "text", answer: "Следующий обычный ответ" };
    const tool = tools.find(value => value.name === "neurobro_plan_generated_image_use")!;
    const planned = await tool.call({ target: mode === "group-avatar" ? mode : "self-avatar" },
      { requestRef, callRef: "plan-fixture", signal: f.input.signal }) as EpochToolResult;
    assert.equal(planned.success, true); assert.equal(JSON.parse(planned.contentItems[0].text).status, "pending");
    if (mode === "no-image") return { kind: "text", answer: "Я уже всё установил" };
    const origin = { requestRef, threadId: "thread", turnId: "turn", itemId: "image" };
    const registry = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
    const artifact = registry.acceptCompleted(origin, { id: "image", type: "imageGeneration", status: "completed", result: IMAGE_PNG });
    return { kind: "image", answer: "Модель не может знать результат установки", image: { artifact,
      registry: { get: registry.get, copyBytes: registry.copyBytes }, close() { f.events.push("planned-image-close"); registry.close(); } } };
  };
  try {
    const result = await runStandingWithPorts(f.input, f.ports);
    assert.equal(result.status, "stopped", JSON.stringify({ result, actions, turns, events: f.events, outcomes: f.outcomes }));
    assert.equal(result.verifiedReplies, 2); assert.equal(f.counters().clients, 1);
    assert.equal(actions, mode === "no-image" ? 0 : 1); assert.equal(turns, 2);
    assert.equal(f.outcomes[1]!.answer, "Следующий обычный ответ");
    assert.match(f.outcomes[0]!.answer!, mode === "no-image" ? /Генерация не завершилась/ : /изменил .*аватарку.*проверил/);
    assert.ok(!f.outcomes[0]!.answer!.includes("Я уже всё установил"));
    if (mode !== "no-image") {
      assert.ok(f.events.indexOf("avatar-verified") < f.events.indexOf("image-send-1"));
      assert.ok(f.events.indexOf("avatar-lease-closed") < f.events.indexOf("image-send-1"));
      assert.ok(f.events.indexOf("image-read-1") < f.events.indexOf("planned-image-close"));
    }
    assert.equal(artifactRuntime!.state().active, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current generation above 2 MiB reaches the actual avatar transport and verified constructor readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "standing-image-use-large-"));
  const f = warmFixture(), originalAdapter = f.ports.adapter, originalClient = f.ports.createClient;
  const bytes = generatedAvatarPng(3 * 1024 * 1024), requests: Api.AnyRequest[] = [];
  const peer = new Api.InputPeerChat({ chatId: bigInt(200) }); assert.equal(utils.getPeerId(peer), "-200");
  const wire = <T extends { getBytes(): Buffer }>(value: T): T => new BinaryReader(value.getBytes()).tgReadObject() as T;
  let photoId: number | undefined, tools: readonly EpochExtraTool[] = [], turns = 0, sent = 0, selections = 0;
  const self = () => wire(new Api.User({ id: bigInt(100), self: true, firstName: "Neurobro",
    ...(photoId === undefined ? {} : { photo: new Api.UserProfilePhoto({ photoId: bigInt(photoId), dcId: 1 }) }) }));
  const avatarAck = () => wire(new Api.photos.Photo({ photo: new Api.Photo({ id: bigInt(55), accessHash: bigInt(123),
    fileReference: Buffer.alloc(0), date: 1, sizes: [], dcId: 1 }), users: [] }));
  f.input = { ...f.input, stateDirectory: root, enableImages: true, enableArtifacts: true, enableBoundActions: true,
    openConversation(input) { tools = input.extraTools!; return f.connection; } };
  f.ports.artifactRuntime = createStandingArtifactRuntime; f.ports.actionRuntime = createStandingBoundActionRuntime;
  f.ports.imageStore = openEncryptedGeneratedImageOutbox; f.ports.dispatchImage = runGeneratedImageDelivery;
  f.ports.createClient = (...args) => { const client = originalClient(...args); return { ...client, async invoke(value: Api.AnyRequest) {
    const request = wire(value); requests.push(request);
    if (request instanceof Api.users.GetUsers) return [self()];
    if (request instanceof Api.upload.SaveFilePart) return true;
    if (request instanceof Api.photos.UploadProfilePhoto) { photoId = 55; return avatarAck(); }
    throw Error("unexpected Telegram request");
  } }; };
  f.ports.adapter = async input => { const adapter = await originalAdapter(input); return { ...adapter,
    async closeCapabilities() {},
    async next(signal) {
      if (++selections > 1) { f.abort.abort(); throw Error("done"); }
      const selected = await adapter.next(signal); return { ...selected,
      openArtifactTransport() { throw Error("no file send expected"); },
      openActions(resolveAvatar) { return createBoundActionTransportLease({ client: input.client, binding: input.binding,
        peer, self: self(), selected: selected.primary, references: f.refs(), signal, ...(resolveAvatar ? { resolveAvatar } : {}),
        isSelectionActive: () => true, revalidatePrimary: async () => selected.primary }); },
      imageTransport: {
        async sendOnce(value) { sent++; assert.deepEqual(value.bytes, bytes); return { messageId: 900, photoId: "901" }; },
        async readExact(chatId, messageId) { return { accountId: "100", chatId, messageId, photoId: "901",
          replyToMessageId: selected.primary.messageId, caption: "Картинка готова: изменил свою аватарку и проверил результат в Telegram." }; },
      },
    }; },
  }; };
  f.connection.turn = async requestRef => {
    turns++; const plan = tools.find(value => value.name === "neurobro_plan_generated_image_use")!;
    const planned = await plan.call({ target: "self-avatar" }, { requestRef, callRef: "large-plan", signal: f.input.signal }) as EpochToolResult;
    assert.equal(planned.success, true);
    const origin = { requestRef, threadId: "thread", turnId: "turn", itemId: "image" };
    const registry = createGeneratedImageRegistry({ requestRef, threadId: origin.threadId, turnId: origin.turnId });
    const artifact = registry.acceptCompleted(origin, { id: "image", type: "imageGeneration", status: "completed", result: bytes.toString("base64") });
    return { kind: "image", answer: "Готово", image: { artifact, registry: { get: registry.get, copyBytes: registry.copyBytes }, close: registry.close } };
  };
  try {
    const result = await runStandingWithPorts(f.input, f.ports);
    assert.equal(result.status, "stopped", JSON.stringify({ result, events: f.events, outcomes: f.outcomes }));
    assert.equal(result.verifiedReplies, 1); assert.equal(turns, 1); assert.equal(sent, 1);
    const parts = requests.filter(value => value instanceof Api.upload.SaveFilePart) as Api.upload.SaveFilePart[];
    assert.equal(parts.length, 6); assert.deepEqual(parts.map(value => value.filePart), [0, 1, 2, 3, 4, 5]);
    const apply = requests.find(value => value instanceof Api.photos.UploadProfilePhoto) as Api.photos.UploadProfilePhoto;
    assert.equal(apply.file instanceof Api.InputFile, true); assert.equal(requests.length, 15);
    assert.match(f.outcomes[0]!.answer!, /изменил свою аватарку и проверил результат/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown generated-avatar action is reported honestly, reconnects, and is never repeated", async () => {
  const root = await mkdtemp(join(tmpdir(), "standing-image-use-unknown-"));
  const f = warmFixture(images()), originalAdapter = f.ports.adapter;
  let tools: readonly EpochExtraTool[] = [], turns = 0, actions = 0;
  f.input = { ...f.input, stateDirectory: root, enableArtifacts: true, enableBoundActions: true,
    openConversation(input) { tools = input.extraTools!; return f.connection; } };
  f.ports.artifactRuntime = createStandingArtifactRuntime;
  f.ports.actionRuntime = createStandingBoundActionRuntime;
  f.ports.imageStore = openEncryptedGeneratedImageOutbox;
  f.ports.adapter = async input => { const adapter = await originalAdapter(input); return { ...adapter,
    async closeCapabilities() { f.events.push("generated-image-capabilities-closed"); },
    async next(signal) { const selected = await adapter.next(signal); return { ...selected,
      openArtifactTransport() { throw Error("no file send expected"); },
      openActions(resolveImage) { return { async execute(action) {
        actions++; assert.equal(action.kind, "set-avatar");
        const image = resolveImage!(action.artifactRef);
        try { assert.equal(Buffer.from(image.bytes).toString("base64"), IMAGE_PNG); }
        finally { image.bytes.fill(0); }
        return { outcome: { verdict: "unknown" as const, code: "telegram-readback-unknown" } };
      }, async close() { f.events.push("avatar-lease-closed"); } }; },
    }; },
  }; };
  f.connection.turn = async requestRef => {
    if (++turns > 1) return { kind: "text", answer: "Следующий обычный ответ" };
    const tool = tools.find(value => value.name === "neurobro_plan_generated_image_use")!;
    const planned = await tool.call({ target: "self-avatar" },
      { requestRef, callRef: "plan-unknown", signal: f.input.signal }) as EpochToolResult;
    assert.equal(planned.success, true);
    const origin = { requestRef, threadId: "thread", turnId: "turn", itemId: "image" };
    const registry = createGeneratedImageRegistry({ requestRef, threadId: origin.threadId, turnId: origin.turnId });
    const artifact = registry.acceptCompleted(origin, { id: "image", type: "imageGeneration", status: "completed", result: IMAGE_PNG });
    return { kind: "image", answer: "Готово", image: { artifact,
      registry: { get: registry.get, copyBytes: registry.copyBytes }, close() { registry.close(); } } };
  };
  try {
    const result = await runStandingWithPorts(f.input, f.ports);
    assert.equal(result.status, "stopped", JSON.stringify({ result, events: f.events, outcomes: f.outcomes }));
    assert.equal(result.verifiedReplies, 2); assert.equal(turns, 2); assert.equal(actions, 1);
    assert.equal(f.counters().clients, 2);
    assert.match(f.outcomes[0]!.answer!, /Не могу подтвердить/);
    assert.match(f.outcomes[0]!.answer!, /повторно действие не запускал/);
    assert.equal(f.outcomes[0]!.delivery, "verified");
    assert.equal(f.outcomes[1]!.answer, "Следующий обычный ответ");
    assert.equal(f.events.filter(value => value === "STANDING_UNKNOWN_CONSUMED").length, 1);
    assert.ok(f.events.indexOf("epoch-close") < f.events.indexOf("client-2"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("STOP during generated-avatar action retains bytes and capabilities until the real action settles, then sends nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "standing-image-use-stop-"));
  const f = warmFixture(images()), originalAdapter = f.ports.adapter;
  const entered = deferred<void>(), finish = deferred<void>();
  let tools: readonly EpochExtraTool[] = [], actions = 0, completed = false, actionBytes: Uint8Array | undefined;
  f.input = { ...f.input, stateDirectory: root, enableArtifacts: true, enableBoundActions: true,
    openConversation(input) { tools = input.extraTools!; return f.connection; } };
  f.ports.artifactRuntime = createStandingArtifactRuntime;
  f.ports.actionRuntime = createStandingBoundActionRuntime;
  f.ports.imageStore = openEncryptedGeneratedImageOutbox;
  f.ports.adapter = async input => { const adapter = await originalAdapter(input); return { ...adapter,
    async closeCapabilities() { f.events.push("generated-image-capabilities-closed"); await finish.promise; },
    async next(signal) { const selected = await adapter.next(signal); return { ...selected,
      openArtifactTransport() { throw Error("no file send expected"); },
      openActions(resolveImage) { return { async execute(action) {
        actions++; assert.equal(action.kind, "set-avatar");
        const image = resolveImage!(action.artifactRef); actionBytes = image.bytes;
        entered.resolve(); await finish.promise;
        assert.equal(Buffer.from(image.bytes).toString("base64"), IMAGE_PNG);
        image.bytes.fill(0); f.events.push("avatar-action-ended");
        return { outcome: { verdict: "verified" as const } };
      }, async close() { f.events.push("avatar-lease-close-start"); await finish.promise; f.events.push("avatar-lease-closed"); } }; },
    }; },
  }; };
  f.connection.turn = async requestRef => {
    const tool = tools.find(value => value.name === "neurobro_plan_generated_image_use")!;
    const planned = await tool.call({ target: "self-avatar" },
      { requestRef, callRef: "plan-stop", signal: f.input.signal }) as EpochToolResult;
    assert.equal(planned.success, true);
    const origin = { requestRef, threadId: "thread", turnId: "turn", itemId: "image" };
    const registry = createGeneratedImageRegistry({ requestRef, threadId: origin.threadId, turnId: origin.turnId });
    const artifact = registry.acceptCompleted(origin, { id: "image", type: "imageGeneration", status: "completed", result: IMAGE_PNG });
    return { kind: "image", answer: "Готово", image: { artifact,
      registry: { get: registry.get, copyBytes: registry.copyBytes }, close() { f.events.push("planned-image-close"); registry.close(); } } };
  };
  try {
    const running = runStandingWithPorts(f.input, f.ports).then(value => { completed = true; return value; });
    await entered.promise; f.abort.abort(); await tick();
    assert.equal(completed, false); assert.equal(actions, 1);
    assert.equal(Buffer.from(actionBytes!).toString("base64"), IMAGE_PNG);
    assert.ok(!f.events.includes("avatar-action-ended"));
    assert.ok(!f.events.includes("avatar-lease-closed"));
    assert.ok(!f.events.includes("generated-image-capabilities-closed"));
    assert.ok(!f.events.includes("planned-image-close"));
    assert.ok(!f.events.includes("image-send-1"));
    finish.resolve();
    const result = await running;
    assert.equal(result.status, "stopped", JSON.stringify({ result, events: f.events, outcomes: f.outcomes }));
    assert.equal(result.verifiedReplies, 0); assert.equal(actions, 1);
    assert.ok(actionBytes!.every(value => value === 0));
    assert.ok(f.events.indexOf("avatar-action-ended") < f.events.indexOf("planned-image-close"));
    assert.ok(f.events.indexOf("avatar-lease-closed") < f.events.indexOf("planned-image-close"));
    assert.ok(!f.events.includes("image-send-1")); assert.ok(!f.events.includes("image-read-1"));
    assert.deepEqual(f.outcomes.map(value => [value.delivery, value.image?.generation]), [["not-sent", "completed"]]);
  } finally { finish.resolve(); await rm(root, { recursive: true, force: true }); }
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const tick = () => new Promise<void>(done=>setImmediate(done));
function images(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options), model = f.input.model, adapter = f.ports.adapter;
  const values: StandingNativeModelResult[] = [];
  let transportHook: ((input: Parameters<GeneratedImageMediaTransport["sendOnce"]>[0])=>Promise<void>) | undefined;
  f.input = {...f.input,enableImages:true,model:async (text,signal)=>{
    await model(text,signal);
    const id = values.length+1, origin = {requestRef:`request-${id}`,threadId:`thread-${id}`,turnId:`turn-${id}`,itemId:`image-${id}`};
    const registry = createGeneratedImageRegistry({requestRef:origin.requestRef,threadId:origin.threadId,turnId:origin.turnId});
    const artifact = registry.acceptCompleted(origin,{id:origin.itemId,type:"imageGeneration",status:"completed",result:IMAGE_PNG});
    const answer = `Готово ${id}`;
    const value: StandingNativeModelResult = {answer,receipt:{version:"standing-native-host-v1",kind:"image",outcome:"observed",exitCode:0,
      transportError:false,timedOut:false,aborted:false,overflow:false,guestSettled:true,clientSettled:true,relaySettled:true,
      appServerSettled:true,custodyReady:true,turnCompleted:true,answerBytes:Buffer.byteLength(answer)},
      image:{artifact,registry:{get:registry.get,copyBytes:registry.copyBytes},close(){f.events.push(`close-image-${id}`);registry.close();}}};
    values.push(value); return value;
  }};
  f.ports.adapter = async arg=>{
    assert.equal(arg.enableImages,true); const selected = await adapter(arg);
    return {...selected,next:async signal=>{
      const value = await selected.next(signal); const id = value.primary.messageId;
      let caption = "";
      return {...value,imageTransport:{
        async sendOnce(input) {
          f.events.push(`image-send-${id}`); caption=input.caption;
          assert.equal(input.chatId,value.primary.chatId); assert.equal(input.replyToMessageId,id);
          assert.equal(input.bytes.toString("base64"),IMAGE_PNG);
          await transportHook?.(input); return {messageId:1000+id,photoId:String(2000+id)};
        },
        async readExact(chatId,messageId) {
          f.events.push(`image-read-${id}`);
          return {chatId,messageId,photoId:String(2000+id),accountId:"100",replyToMessageId:id,caption};
        },
      }};
    }};
  };
  f.ports.imageStore = async arg=>{
    const id=arg.approved.replyToMessageId; assert.equal(arg.directory,join(f.input.stateDirectory,"media-outbox"));
    assert.equal(arg.approved.chatId,"-200");assert.equal(arg.approved.accountId,"100");
    f.events.push(`image-store-${id}`);
    return {reserve:async (plan,bytes)=>{
      assert.deepEqual(plan.approved,arg.approved);assert.equal(bytes.toString("base64"),IMAGE_PNG);f.events.push(`reserve-image-${id}`);
    },append:async record=>{f.events.push(`image-${record.state}-${id}`);},inspect:async()=>({generation:"unknown",delivery:"absent"}),close(){f.events.push(`close-store-${id}`);}};
  };
  f.ports.dispatchImage = runGeneratedImageDelivery;
  return {...f,values,hook(value: typeof transportHook){transportHook=value;}};
}

test("two generated images use actual media outbox with one client and no text fallback", async()=>{
  const f=images(), result=await runStandingWithPorts(f.input,f.ports);
  assert.equal(result.status,"stopped");assert.equal(result.verifiedReplies,2);assert.equal(f.counters().clients,1);
  assert.ok(!f.events.some(e=>/^send-/.test(e)));
  for(const id of [1,2]) {
    const sequence=[`question-${id}`,`checkpoint-${id}`,`admission-${id}`,`model-${id}`,`reserve-image-${id}`,`image-sending-${id}`,`image-send-${id}`,`image-read-${id}`,`image-verified-${id}`,`close-store-${id}`,`outcome-${id}`,`close-image-${id}`];
    assert.deepEqual([...sequence].sort((a,b)=>f.events.indexOf(a)-f.events.indexOf(b)),sequence);
    assert.throws(()=>f.values[id-1]!.image!.registry.get(f.values[id-1]!.image!.artifact.ref),/CLOSED/);
  }
  assert.deepEqual(f.outcomes.map(v=>[v.delivery,v.kind,v.answer]),[["verified","model","[Изображение]\nГотово 1"],["verified","model","[Изображение]\nГотово 2"]]);
  assert.ok(f.outcomes.every(v=>v.image?.generation==="completed"));
});

test("STOP during image upload joins real transport settlement before closing any image state",async()=>{
  const f=images(), entered=deferred<void>(), finish=deferred<void>();let bytes:Buffer|undefined,completed=false;
  f.hook(async input=>{bytes=input.bytes;entered.resolve();await finish.promise;});
  const running=runStandingWithPorts(f.input,f.ports).then(v=>{completed=true;return v;});
  await entered.promise; f.abort.abort(); await tick();
  assert.equal(completed,false);assert.equal(bytes!.toString("base64"),IMAGE_PNG);
  assert.ok(!f.events.includes("close-store-1")&&!f.events.includes("close-image-1")&&!f.events.includes("settle-client"));
  finish.resolve();const result=await running;
  assert.equal(result.status,"stopped");assert.equal(result.verifiedReplies,0);assert.ok(bytes!.every(b=>b===0));
  assert.ok(f.events.indexOf("close-image-1")<f.events.indexOf("settle-client"));
  assert.deepEqual(f.outcomes.map(v=>v.delivery),["unknown"]);assert.ok(!f.events.some(e=>/^send-/.test(e)));
});

test("image delivery uncertainty consumes its primary without text fallback or replay",async()=>{
  const f=images();let sends=0;
  f.hook(async()=>{if(++sends===1)throw Error("fake transport uncertainty");});
  const result=await runStandingWithPorts(f.input,f.ports);
  assert.equal(result.verifiedReplies,1);assert.equal(sends,2);assert.equal(f.counters().clients,2);
  assert.deepEqual(f.outcomes.map(v=>v.delivery),["unknown","verified"]);
  assert.ok(f.outcomes.every(v=>v.image?.generation==="completed"));
  assert.ok(f.events.indexOf("settle-client")<f.events.indexOf("client-2"));assert.ok(!f.events.some(e=>/^send-/.test(e)));
});

test("disabled media and malformed image receipts close scoped registry without a send",async()=>{
  for(const mode of ["disabled","invalid","blocked"] as const){
    const f=images({modelBlocked:mode==="blocked"}), model=f.input.model;
    if(mode==="disabled"){
      f.input={...f.input,enableImages:false};const adapter=f.ports.adapter;
      f.ports.adapter=arg=>adapter({...arg,enableImages:true});
    }
    if(mode==="invalid")f.input={...f.input,model:async(text,signal)=>{
      const value=await model(text,signal) as StandingNativeModelResult;
      return {...value,receipt:{...value.receipt,clientSettled:false}};
    }};
    const result=await runStandingWithPorts(f.input,f.ports);
    assert.equal(result.status,"blocked");assert.equal(result.lockPreserved,true);
    assert.ok(f.events.includes("close-image-1"));assert.ok(!f.events.includes("image-send-1")&&!f.events.includes("send-1"));
  }
});

test("STOP after completed generation closes image without opening media storage",async()=>{
  const f=images({stopAfterModel:true}), result=await runStandingWithPorts(f.input,f.ports);
  assert.equal(result.status,"stopped");assert.ok(f.events.includes("close-image-1"));
  assert.ok(!f.events.includes("image-store-1"));assert.equal(f.outcomes[0]!.delivery,"not-sent");
  assert.deepEqual(f.outcomes[0]!.image,{generation:"completed"});
});

test("media persistence failure closes registry and does not fall back to text",async()=>{
  const f=images();f.ports.imageStore=async()=>{throw Error("private storage failure");};
  const result=await runStandingWithPorts(f.input,f.ports);
  assert.equal(result.status,"blocked");assert.ok(f.events.includes("close-image-1"));
  assert.ok(!f.events.includes("image-send-1")&&!f.events.includes("send-1"));assert.equal(f.outcomes.length,0);
});

test("native text still takes the guarded text route when image capability is enabled",async()=>{
  const f=fixture(),model=f.input.model;
  f.input={...f.input,enableImages:true,model:async(text,signal)=>{
    const value=await model(text,signal);
    return {...value,receipt:{...(value.receipt as Record<string,unknown>),version:"standing-native-host-v1",kind:"text"}};
  }};
  f.ports.dispatchImage=async()=>{throw Error("unexpected image route");};
  const result=await runStandingWithPorts(f.input,f.ports);
  assert.equal(result.verifiedReplies,2);assert.ok(f.events.includes("send-1")&&f.events.includes("send-2"));
});

test("image journal stores exactly the bounded caption actually sent after full native receipt validation",async()=>{
  const f=images(),model=f.input.model,caption="а".repeat(511)+"🦈 хвост",expected="а".repeat(511);
  f.input={...f.input,model:async(text,signal)=>{
    const value=await model(text,signal) as StandingNativeModelResult;
    return {...value,answer:caption,receipt:{...value.receipt,answerBytes:Buffer.byteLength(caption)}};
  }};
  f.hook(async input=>{assert.equal(input.caption,expected);});
  const result=await runStandingWithPorts(f.input,f.ports);assert.equal(result.verifiedReplies,2);
  assert.ok(f.outcomes.every(value=>value.answer==="[Изображение]\n"+expected));
});

test("native unsettled receipt during STOP remains blocked and image cleanup still runs",async()=>{
  const f=images({stopAfterModel:true}),model=f.input.model;
  f.input={...f.input,model:async(text,signal)=>{
    const value=await model(text,signal) as StandingNativeModelResult;
    return {...value,receipt:{...value.receipt,guestSettled:false}};
  }};
  const result=await runStandingWithPorts(f.input,f.ports);
  assert.equal(result.status,"blocked");assert.equal(result.lockPreserved,true);assert.ok(f.events.includes("close-image-1"));
  assert.ok(!f.events.includes("image-store-1"));
});

function invokeFixture() {
  const abort=new AbortController(),destroyGate=deferred<void>(),timers=new Map<number,Set<()=>void>>();let destroys=0,disconnects=0;
  const owner=createStandingInvokeOwner({signal:abort.signal,disconnected(){disconnects++;abort.abort();},destroy:async()=>{destroys++;await destroyGate.promise;},
    schedule(callback,ms){const callbacks=timers.get(ms)??new Set();callbacks.add(callback);timers.set(ms,callbacks);return()=>{callbacks.delete(callback);};}});
  return {abort,owner,destroyGate,timers,counters:()=>({destroys,disconnects}),fire(ms:number){for(const callback of [...(timers.get(ms)??[])])callback();}};
}

test("tracked invoke abort destroys once but cannot settle or release raw bytes until actual invoke ends",async()=>{
  const f=invokeFixture(),gate=deferred<string>(),bytes=Buffer.from(IMAGE_PNG,"base64");let ended=false;
  const running=f.owner.run(async()=>{await gate.promise;assert.equal(bytes.toString("base64"),IMAGE_PNG);return "done";});
  const rejected=assert.rejects(running,/STANDING_TRANSPORT/).then(()=>{ended=true;});
  await tick();f.abort.abort();f.destroyGate.resolve();await tick();assert.equal(ended,false);
  let settled=false;const closure=f.owner.settle().then(value=>{settled=true;return value;});await tick();assert.equal(settled,false);
  await assert.rejects(f.owner.run(async()=>"forbidden"),/STANDING_TRANSPORT/);
  assert.deepEqual(f.counters(),{destroys:1,disconnects:1});gate.resolve("end");await rejected;assert.equal(await closure,true);
});

test("tracked invoke deadline interrupts same client and teardown timeout reports unknown",async()=>{
  const f=invokeFixture(),gate=deferred<void>();let calls=0;
  const running=f.owner.run(async()=>{calls++;await gate.promise;return 1;});const rejected=assert.rejects(running,/STANDING_TRANSPORT/);
  await tick();f.fire(30_000);f.destroyGate.resolve();await tick();
  const closure=f.owner.settle();f.fire(10_000);assert.equal(await closure,false);assert.equal(calls,1);
  await assert.rejects(f.owner.run(async()=>{calls++;return 2;}));assert.equal(calls,1);
  gate.resolve();await rejected;assert.equal(await f.owner.settle(),true);assert.deepEqual(f.counters(),{destroys:1,disconnects:1});
});

test("tracked successful and failed invocations preserve results and destroy failure cannot prove settlement",async()=>{
  const abort=new AbortController();let destroys=0;
  const owner=createStandingInvokeOwner({signal:abort.signal,disconnected(){},destroy:async()=>{destroys++;throw Error("destroy failed");}});
  assert.equal(await owner.run(async()=>42),42);
  const failure=Error("actual RPC refusal");await assert.rejects(owner.run(async()=>{throw failure;}),error=>error===failure);
  assert.equal(await owner.settle(),false);assert.equal(destroys,1);
});
