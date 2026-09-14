import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, lstat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
import { Api } from "telegram";
import bigInt from "big-integer";
import { normalizeConversationPaths, completedModelAnswer, runPilotConversationWithPorts,
  type ConversationPaths, type ConversationPorts, type ConversationModelResult } from "../src/pilot-conversation.js";
import type { GreetingClient } from "../src/pilot-greeting.js";
import { acquireProcessLock } from "../src/process-lock.js";
import { encryptSession } from "../src/session-crypto.js";
import { openExistingEncryptedSessionLease } from "../src/existing-session-lease.js";
import { createEncryptedPilotStore, runPilotReply, type PilotSend } from "../src/pilot-outbox.js";
import { createConversationAdapter } from "../src/pilot-conversation-adapter.js";

const phrase = "invented conversation passphrase";
const primary = Object.freeze({ chatId: "-123", ownerId: "456", messageId: 51, text: "ПРОМПТ придумай приветствие" });
const answer = "Привет, это придуманный ответ.";
function modelResult(): ConversationModelResult {
  return { answer, receipt: { version: "modeltext-host-v1", outcome: "observed", exitCode: 0,
    transportError: false, timedOut: false, aborted: false, overflow: false, guestSettled: true,
    clientSettled: true, relaySettled: true, custodyReady: true, appServerSettled: true,
    turnCompleted: true, answerBytes: Buffer.byteLength(answer), outputBytes: 800, stderrBytes: 0 } };
}
async function absent(path: string) {
  try { await lstat(path); throw Error("exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "neurobro-conversation-test-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith("neurobro-conversation-test-")); await rm(root, { recursive: true, force: true }); });
  const privateRoot = join(root, "telegram"), modelRoot = join(root, "model");
  await mkdir(privateRoot); await mkdir(modelRoot);
  const paths: ConversationPaths = { authConfigPath: join(privateRoot, "auth.json"), bindingPath: join(privateRoot, "binding.json"),
    modelReceiptPath: join(privateRoot, "ready.json"), attemptDirectory: join(privateRoot, "outbox"), killSwitchPath: join(privateRoot, "STOP"),
    modelAttemptDirectory: join(modelRoot, "modeltext-v1") };
  const sessionFile = join(privateRoot, "session.enc"), ownerLock = `${sessionFile}.owner.lock`;
  await writeFile(sessionFile, await encryptSession("invented-session", phrase));
  const events: string[] = [], notifications: string[] = [], sends: PilotSend[] = [];
  let connected = false;
  const client: GreetingClient = {
    async connect() { events.push("connect"); connected = true; },
    async getMe() { events.push("self"); return new Api.User({ id: bigInt(789), self: true }); },
    async destroy() { events.push("destroy"); connected = false; },
    async invoke() { throw Error("fixture adapter owns transport"); },
  };
  const ports: ConversationPorts = {
    async prepare(raw) {
      events.push("prepare"); const { modelAttemptDirectory, ...five } = normalizeConversationPaths(raw);
      await absent(five.attemptDirectory); await absent(modelAttemptDirectory);
      return { paths: five, modelAttemptDirectory, ownerLock, binding: { accountId: "789", peerId: "-123" },
        config: { schemaVersion: 1, mode: "auth-only", account: { apiIdEnv: "ID", apiHashEnv: "HASH", sessionPassphraseEnv: "PHRASE", sessionFile } } };
    },
    absent,
    async acquireLock(path) { events.push("lock"); const release = await acquireProcessLock(path); return async () => { events.push("unlock"); await release(); }; },
    async prompt() { events.push("prompt"); return { apiId: 1, apiHash: "a".repeat(32), passphrase: phrase }; },
    async openSession(reference, passphrase) {
      events.push("decrypt"); assert.ok(await lstat(ownerLock));
      const lease = await openExistingEncryptedSessionLease({ reference, passphrase });
      return { ...lease, async release() { assert.equal(connected, false); events.push("lease-release"); await lease.release(); } };
    },
    createClient(material) { assert.equal(material, "invented-session"); events.push("client"); return client; },
    installFence(owned) { assert.equal(owned, client); assert.equal(connected, false); events.push("fence"); return () => { events.push("unfence"); }; },
    async createAdapter(input) {
      assert.equal(input.client, client); assert.equal(input.startedAt, 1800000000); events.push("adapter");
      return {
        async waitForPrompt() { events.push("primary"); return primary; },
        transport: {
          async sendOnce(reply) { events.push("send"); sends.push(reply); assert.ok(await lstat(join(paths.attemptDirectory, "sending.enc"))); return { messageId: 52 }; },
          async readExact(chatId, messageId) { events.push("readback"); return { chatId, messageId, accountId: "789", replyToMessageId: 51, text: answer }; },
        },
      };
    },
    async model(text, signal) {
      events.push("model"); assert.equal(text, primary.text); assert.equal(signal.aborted, false);
      assert.ok(await lstat(ownerLock)); await mkdir(paths.modelAttemptDirectory); return modelResult();
    },
    createStore: createEncryptedPilotStore,
    async dispatch(input) { events.push("outbox"); return runPilotReply(input); },
    killed: () => false,
    async settle(owned) { assert.equal(owned, client); await owned.destroy(); return true; },
    now: () => 1800000000000,
    notify: code => { notifications.push(code); },
  };
  return { root, paths, ownerLock, ports, events, notifications, sends, client };
}

test("separate protected model parent is accepted without weakening five-path Telegram normalization", () => {
  const root = resolve(tmpdir(), "fixture"), path = (name: string) => join(root, "telegram", name);
  const paths: ConversationPaths = { authConfigPath: path("auth"), bindingPath: path("binding"), modelReceiptPath: path("ready"),
    attemptDirectory: path("outbox"), killSwitchPath: path("STOP"), modelAttemptDirectory: join(root, "model", "fresh") };
  assert.deepEqual(normalizeConversationPaths(paths), paths);
  assert.throws(() => normalizeConversationPaths({ ...paths, bindingPath: join(root, "elsewhere", "binding") }));
  assert.throws(() => normalizeConversationPaths({ ...paths, modelAttemptDirectory: paths.attemptDirectory }));
  assert.throws(() => normalizeConversationPaths({ ...paths, modelAttemptDirectory: "relative" }));
});

test("one selected text crosses model port, real encrypted outbox sends one exact anchored reply", async t => {
  const f = await fixture(t), result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.deepEqual(result, { status: "verified", code: "PILOT_CONVERSATION_VERIFIED", lockPreserved: false, clientSettled: true });
  assert.deepEqual(f.events, ["prepare", "lock", "prompt", "decrypt", "client", "fence", "connect", "self", "adapter", "primary", "model", "outbox", "send", "readback", "destroy", "lease-release", "unfence", "unlock"]);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.replyToMessageId, primary.messageId); assert.equal(f.sends[0]!.text, answer);
  assert.deepEqual(f.notifications, ["PILOT_CONVERSATION_WAITING", "PILOT_CONVERSATION_MODEL", "PILOT_CONVERSATION_VERIFIED"]);
  assert.equal(JSON.stringify(result).includes(answer), false); assert.equal(JSON.stringify(f.notifications).includes(primary.text), false);
  const encrypted = await readFile(join(f.paths.attemptDirectory, "terminal.enc"), "utf8"); assert.equal(encrypted.includes(answer), false);
  const before = f.events.filter(e => e === "model").length;
  assert.equal((await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal)).status, "refused");
  assert.equal(f.events.filter(e => e === "model").length, before); assert.equal(f.sends.length, 1);
});

test("actual conversation adapter, runner and encrypted outbox compose on the same fake TL client", async t => {
  const f = await fixture(t), requests: Api.AnyRequest[] = [], peer = () => new Api.PeerChat({ chatId: bigInt(123) });
  const incoming = () => new Api.Message({ id: 51, peerId: peer(), fromId: new Api.PeerUser({ userId: bigInt(456) }), date: 1800000000, message: primary.text });
  const batch = (message: Api.Message) => new Api.messages.Messages({ messages: [message], chats: [], users: [] });
  f.client.invoke = async request => {
    requests.push(request); assert.ok(request.getBytes().length > 0);
    if (request instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({
      dialogs: [new Api.Dialog({ peer: peer(), topMessage: 50, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0,
        unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })],
      chats: [new Api.Chat({ id: bigInt(123), title: "Invented title excluded from model", photo: new Api.ChatPhotoEmpty(), date: 1, participantsCount: 3, version: 1 })], users: [], messages: [],
    });
    if (request instanceof Api.messages.GetHistory) return batch(incoming());
    if (request instanceof Api.messages.GetMessages) {
      const id = request.id[0]; assert.ok(id instanceof Api.InputMessageID);
      if (id.id === 51) return batch(incoming());
      assert.equal(id.id, 52);
      return batch(new Api.Message({ id: 52, peerId: peer(), fromId: new Api.PeerUser({ userId: bigInt(789) }), date: 1800000000,
        message: answer, out: true, replyTo: new Api.MessageReplyHeader({ replyToMsgId: 51 }) }));
    }
    assert.ok(request instanceof Api.messages.SendMessage);
    assert.equal(request.message, answer); assert.ok(request.sendAs instanceof Api.InputPeerSelf);
    assert.ok(request.replyTo instanceof Api.InputReplyToMessage); assert.equal(request.replyTo.replyToMsgId, 51);
    assert.ok(await lstat(join(f.paths.attemptDirectory, "sending.enc")));
    return new Api.UpdateShortSentMessage({ id: 52, out: true, pts: 1, ptsCount: 1, date: 1800000000 });
  };
  f.ports.createAdapter = createConversationAdapter;
  const result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.equal(result.status, "verified");
  assert.deepEqual(requests.map(r => r.className), ["messages.GetDialogs", "messages.GetHistory", "messages.GetMessages", "messages.SendMessage", "messages.GetMessages"]);
  assert.equal(f.events.filter(e => e === "model").length, 1);
});

test("no model or outbox before prompt selection; bounded cancellation keeps unknown lock", async t => {
  const f = await fixture(t), abort = new AbortController();
  let entered!: () => void; const waiting = new Promise<void>(done => { entered = done; });
  const original = f.ports.createAdapter;
  f.ports.createAdapter = async input => ({ ...await original(input), waitForPrompt: async () => { entered(); return new Promise(() => {}); } });
  const running = runPilotConversationWithPorts(f.paths, f.ports, abort.signal); await waiting;
  assert.equal(f.events.includes("model"), false); assert.equal(f.sends.length, 0);
  abort.abort(); const result = await running;
  assert.equal(result.status, "unknown"); assert.equal(result.lockPreserved, true); assert.equal(result.clientSettled, true);
  assert.ok(await lstat(f.ownerLock));
});

test("unknown, incomplete or failed model result cannot send and retains owner lock", async t => {
  for (const kind of ["unknown", "incomplete", "throw", "wrong-bytes", "no-answer"]) {
    const f = await fixture(t);
    f.ports.model = async () => {
      if (kind === "throw") throw Error("private model failure");
      const value = modelResult(), receipt = value.receipt as Record<string, unknown>;
      if (kind === "unknown") receipt.outcome = "unknown";
      if (kind === "incomplete") receipt.guestSettled = false;
      if (kind === "wrong-bytes") receipt.answerBytes = 1;
      return kind === "no-answer" ? { ...value, answer: null } : value;
    };
    const result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
    assert.equal(result.status, "unknown"); assert.equal(result.lockPreserved, true); assert.equal(f.sends.length, 0);
    assert.equal(f.events.includes("outbox"), false); assert.ok(await lstat(f.ownerLock));
  }
});

test("abort while model is outstanding discards its late answer and never retries", async t => {
  const f = await fixture(t), abort = new AbortController(); let entered!: () => void, finish!: (value: ConversationModelResult) => void;
  const started = new Promise<void>(done => { entered = done; });
  f.ports.model = async () => { entered(); return new Promise(done => { finish = done; }); };
  const pending = runPilotConversationWithPorts(f.paths, f.ports, abort.signal); await started; abort.abort();
  const result = await pending; finish(modelResult()); await new Promise<void>(done => setImmediate(done));
  assert.equal(result.status, "unknown"); assert.equal(result.lockPreserved, true); assert.equal(f.sends.length, 0);
});

test("unconfirmed Telegram destruction dominates delivered proof and preserves lease plus lock", async t => {
  const f = await fixture(t); f.ports.settle = async () => false;
  const result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.equal(result.status, "unknown"); assert.equal(result.clientSettled, false); assert.equal(result.lockPreserved, true);
  assert.equal(f.events.includes("lease-release"), false); assert.equal(f.events.includes("unlock"), false);
  assert.equal(f.notifications.at(-1), "PILOT_CONVERSATION_UNKNOWN");
});

test("model attempt appearing during local prompt prevents connection and model reuse", async t => {
  const f = await fixture(t), prompt = f.ports.prompt;
  f.ports.prompt = async () => { await mkdir(f.paths.modelAttemptDirectory); return prompt(); };
  const result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.equal(result.status, "refused"); assert.equal(result.lockPreserved, false); assert.equal(f.events.includes("connect"), false);
});

test("kill switch after model completion prevents send through the actual outbox", async t => {
  const f = await fixture(t), model = f.ports.model; let stop = false;
  f.ports.model = async (...args) => { const result = await model(...args); stop = true; return result; };
  f.ports.killed = () => stop;
  const result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.equal(result.status, "refused"); assert.equal(f.sends.length, 0); assert.equal(result.lockPreserved, false);
});

test("model result gate refuses every missing settlement proof and malformed text", () => {
  for (const field of ["guestSettled", "clientSettled", "relaySettled", "custodyReady", "appServerSettled", "turnCompleted"]) {
    const value = modelResult(); (value.receipt as Record<string, unknown>)[field] = false;
    assert.equal(completedModelAnswer(value), null);
  }
  for (const text of ["", " ", "x".repeat(4097), "\ud800", "a\0b"]) assert.equal(completedModelAnswer({ ...modelResult(), answer: text }), null);
});

test("optional credential hook runs exactly once after adapter verification and before waiting or model", async t => {
  const f = await fixture(t); let calls = 0;
  f.ports.credentialsVerified = async credentials => {
    calls++; f.events.push("credentials-verified");
    assert.equal(credentials.apiId, 1); assert.equal(credentials.apiHash, "a".repeat(32)); assert.equal(credentials.passphrase, phrase);
    assert.equal(f.events.at(-2), "adapter"); assert.equal(f.notifications.length, 0);
    assert.ok(await lstat(f.ownerLock)); assert.equal(f.events.includes("model"), false);
  };
  const result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.equal(result.status, "verified"); assert.equal(calls, 1);
  assert.ok(f.events.indexOf("credentials-verified") < f.events.indexOf("primary"));
  assert.ok(f.events.indexOf("credentials-verified") < f.events.indexOf("model"));
});

test("credential hook is never called on failed decryption, wrong self identity or adapter refusal", async t => {
  for (const failure of ["decrypt", "identity", "adapter"]) {
    const f = await fixture(t); let calls = 0;
    f.ports.credentialsVerified = async () => { calls++; };
    if (failure === "decrypt") f.ports.openSession = async () => { throw Error("invented decrypt failure"); };
    if (failure === "identity") {
      f.client.getMe = async () => new Api.User({ id: bigInt(999), self: true });
      f.ports.createAdapter = createConversationAdapter; // Real self guard refuses before invoke.
    }
    if (failure === "adapter") f.ports.createAdapter = async () => { throw Error("invented binding refusal"); };
    const result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
    assert.notEqual(result.status, "verified"); assert.equal(calls, 0);
    assert.equal(f.events.includes("model"), false); assert.equal(f.sends.length, 0);
  }
});

test("credential hook failure stops before waiting, model and send, settles client and preserves unknown lock", async t => {
  const f = await fixture(t); let calls = 0;
  f.ports.credentialsVerified = async () => { calls++; throw Error("invented save failure"); };
  const result = await runPilotConversationWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(result.status, "unknown"); assert.equal(result.lockPreserved, true); assert.equal(result.clientSettled, true);
  assert.deepEqual(f.notifications, ["PILOT_CONVERSATION_UNKNOWN"]);
  assert.equal(f.events.includes("primary"), false); assert.equal(f.events.includes("model"), false); assert.equal(f.sends.length, 0);
  assert.ok(f.events.includes("destroy")); assert.ok(f.events.includes("lease-release")); assert.ok(await lstat(f.ownerLock));
});
