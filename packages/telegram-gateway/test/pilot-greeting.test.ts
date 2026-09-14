import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { assertAstraReady, normalizeGreetingPaths, preparePilotGreeting, runPilotGreetingWithPorts, greetingKillSwitchEngaged,
  PILOT_GREETING, type GreetingPaths, type GreetingPorts, type GreetingClient } from "../src/pilot-greeting.js";
import { acquireProcessLock } from "../src/process-lock.js";
import { encryptSession } from "../src/session-crypto.js";
import { openExistingEncryptedSessionLease } from "../src/existing-session-lease.js";
import { createEncryptedPilotStore, runPilotReply, type PilotDirectoryInspection } from "../src/pilot-outbox.js";
import { createPilotTelegramAdapter } from "../src/pilot-telegram-adapter.js";

function receipt() {
  return {
    exitCode: 0, transportError: false, timedOut: false, overflow: false, outcome: "completed-review-client-verdict",
    guest: { version: "astra-canary-v3", outcome: "completed-review-client-verdict", stage: "complete", telegram: false,
      preflight: true, relayReady: true, modelTurnAdmitted: true, settled: true, relaySettled: true, clientNaturalSettlement: true, clientExit: 0, relayExit: 0,
      client: { schema: "decadans.rm0032.astra-canary-client.v1", outcome: "observed", code: "OK", stage: "complete",
        canary: { threadAttempted: true, threadStarted: true, turnAttempted: true, turnStarted: true, modelMatched: true, effortMatched: true,
          permissionsMatched: true, ephemeralMatched: true, turnCompleted: true, answerExact: true, answerBytes: Buffer.byteLength("NEUROBRO_ASTRA_READY."), toolEvents: 0, serverRequests: 0, events: 3 },
        appServer: { launched: true, stdinClosed: true, reaped: true, stderrComplete: true, exitCode: 0, stderrBytes: 0 },
        limits: { clientTurnStartLimit: 1, transportRetriesDisabled: false, syntheticInputOnly: true, telegram: false },
        custody: { initialize: true, profile: true, controls: { authMetadata: true, authOpenClosed: true, parentFdClosed: true, proxyEnvPresent: true, relayBefore: true, relayAfter: true },
          account: { checked: true, chatgpt: true }, model: { checked: true, astraListedOnce: true, mediumSupported: true, pages: 1 },
          probes: ["public", "auth_direct", "auth_self_root", "auth_server_root", "auth_controller_root", "auth_init_root", "fd", "env", "network"].map(name =>
            ({ name, attempted: true, verdict: "pass", rpcCode: null, stdoutBytes: 0, stderrBytes: 0 })),
        },
      },
    },
  };
}

test("only complete matching Astra metadata with settled host/guest/app processes opens readiness", () => {
  assert.doesNotThrow(() => assertAstraReady(receipt()));
  const mutations: Array<(r: ReturnType<typeof receipt>) => void> = [
    r => { r.exitCode = 1; }, r => { r.transportError = true; }, r => { r.timedOut = true; }, r => { r.overflow = true; },
    r => { r.guest.version = "astra-canary-v2"; }, r => { r.guest.outcome = "inconclusive"; }, r => { r.guest.settled = false; },
    r => { r.guest.relaySettled = false; }, r => { r.guest.clientNaturalSettlement = false; }, r => { r.guest.clientExit = 1; }, r => { r.guest.relayExit = 1; },
    r => { r.guest.client.outcome = "refused"; }, r => { r.guest.client.code = "ANSWER_REFUSED"; }, r => { r.guest.client.schema = "invented-other-schema"; },
    r => { r.guest.client.canary.modelMatched = false; }, r => { r.guest.client.canary.effortMatched = false; },
    r => { r.guest.client.canary.permissionsMatched = false; }, r => { r.guest.client.canary.ephemeralMatched = false; },
    r => { r.guest.client.canary.answerExact = false; }, r => { r.guest.client.canary.turnCompleted = false; },
    r => { r.guest.client.canary.answerBytes++; }, r => { r.guest.client.canary.toolEvents++; }, r => { r.guest.client.canary.serverRequests++; },
    r => { r.guest.client.appServer.reaped = false; }, r => { r.guest.client.appServer.exitCode = 1; },
    r => { r.guest.client.custody.controls.relayAfter = false; }, r => { r.guest.client.custody.account.chatgpt = false; },
    r => { r.guest.client.custody.probes[0]!.verdict = "unknown"; }, r => { r.guest.client.custody.probes.pop(); },
    r => { r.guest.client.limits.telegram = true; }, r => { r.guest.client.limits.syntheticInputOnly = false; },
  ];
  for (const mutate of mutations) { const r = receipt(); mutate(r); assert.throws(() => assertAstraReady(r)); }
  assert.throws(() => assertAstraReady({})); assert.throws(() => assertAstraReady(null));
});

const passphrase = "invented greeting phrase";
const peer = () => new Api.PeerChannel({ channelId: bigInt(123) });
const peerId = utils.getPeerId(peer());
async function sandbox(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "neurobro-greeting-test-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith("neurobro-greeting-test-")); await rm(root, { recursive: true, force: true }); });
  const paths: GreetingPaths = { authConfigPath: join(root, "auth.json"), bindingPath: join(root, "binding.json"), modelReceiptPath: join(root, "model.json"),
    attemptDirectory: join(root, "one-pilot"), killSwitchPath: join(root, "STOP") };
  const sessionFile = join(root, "session.enc"); const ownerLock = `${sessionFile}.owner.lock`;
  const config = { schemaVersion: 1, mode: "auth-only", account: { apiIdEnv: "INVENTED_ID", apiHashEnv: "INVENTED_HASH", sessionPassphraseEnv: "INVENTED_PHRASE", sessionFile } };
  const binding = { version: "telegram-account-binding-v1", accountId: "789", peerId, title: "Invented private title", sessionReference: sessionFile,
    ownerLock, checkedAt: "2026-09-10T00:00:00.000Z", serving: false };
  await writeFile(paths.authConfigPath, JSON.stringify(config)); await writeFile(paths.bindingPath, JSON.stringify(binding));
  await writeFile(paths.modelReceiptPath, JSON.stringify(receipt())); await writeFile(sessionFile, await encryptSession("invented-session-material", passphrase));
  return { root, paths, sessionFile, ownerLock, config, binding };
}

test("preflight joins regular private config, session and exact binding without touching their contents", async t => {
  const s = await sandbox(t); const before = await readFile(s.sessionFile);
  const prepared = await preparePilotGreeting(s.paths);
  assert.deepEqual(prepared.binding, { accountId: "789", peerId }); assert.equal(prepared.ownerLock, s.ownerLock);
  assert.deepEqual(await readFile(s.sessionFile), before); await assert.rejects(lstat(s.paths.attemptDirectory), { code: "ENOENT" });
});

test("preflight refuses stale model, existing attempt, kill switch and mismatched binding", async t => {
  const s = await sandbox(t);
  await mkdir(s.paths.attemptDirectory); await assert.rejects(preparePilotGreeting(s.paths));
  const s2 = await sandbox(t); await writeFile(s2.paths.killSwitchPath, ""); await assert.rejects(preparePilotGreeting(s2.paths));
  const s3 = await sandbox(t); const bad = receipt(); bad.guest.client.outcome = "refused"; await writeFile(s3.paths.modelReceiptPath, JSON.stringify(bad)); await assert.rejects(preparePilotGreeting(s3.paths));
  const s4 = await sandbox(t); await writeFile(s4.paths.bindingPath, JSON.stringify({ ...s4.binding, ownerLock: join(s4.root, "alternate.lock") })); await assert.rejects(preparePilotGreeting(s4.paths));
  const s5 = await sandbox(t); await writeFile(s5.paths.bindingPath, JSON.stringify({ ...s5.binding, serving: true })); await assert.rejects(preparePilotGreeting(s5.paths));
});

test("all paths require one private parent, disjoint fixed targets and bounded regular files", async t => {
  const s = await sandbox(t);
  assert.throws(() => normalizeGreetingPaths({ ...s.paths, bindingPath: "relative.json" }));
  assert.throws(() => normalizeGreetingPaths({ ...s.paths, bindingPath: join(s.root, "child", "binding.json") }));
  assert.throws(() => normalizeGreetingPaths({ ...s.paths, attemptDirectory: s.paths.bindingPath }));
  await writeFile(s.paths.modelReceiptPath, " ".repeat(65537)); await assert.rejects(preparePilotGreeting(s.paths));
  const s2 = await sandbox(t); await writeFile(s2.paths.authConfigPath, JSON.stringify({ ...s2.config, account: { ...s2.config.account, sessionFile: join(dirname(s2.root), "outside.enc") } }));
  await assert.rejects(preparePilotGreeting(s2.paths));
});

async function flow(t: { after(fn: () => Promise<void>): void }) {
  const s = await sandbox(t); const events: string[] = []; const requests: Api.AnyRequest[] = []; let connected = false;
  const client: GreetingClient = {
    async connect() { events.push("connect"); connected = true; },
    async getMe() { events.push("self"); return new Api.User({ id: bigInt(789), self: true }); },
    async destroy() { events.push("destroy"); connected = false; },
    async invoke(request) {
      requests.push(request); events.push(request.className); assert.ok(request.getBytes().length);
      if (request instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({
        dialogs: [new Api.Dialog({ peer: peer(), topMessage: 55, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })],
        chats: [new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Private title must not become greeting", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })],
        users: [], messages: [new Api.Message({ id: 55, peerId: peer(), fromId: new Api.PeerUser({ userId: bigInt(456) }), date: 1, message: "Private body must never become model input" })],
      });
      if (request instanceof Api.messages.SendMessage) { assert.equal(request.message, PILOT_GREETING); assert.equal(request.replyTo, undefined); assert.ok(request.sendAs instanceof Api.InputPeerSelf);
        return new Api.UpdateShortSentMessage({ id: 66, out: true, pts: 1, ptsCount: 1, date: 1 }); }
      if (request instanceof Api.channels.GetMessages) return new Api.messages.Messages({ messages: [new Api.Message({ id: 66, peerId: peer(), fromId: new Api.PeerUser({ userId: bigInt(789) }), date: 1, out: true, message: PILOT_GREETING })], chats: [], users: [] });
      throw new Error("unexpected request");
    },
  };
  const ports: GreetingPorts = {
    prepare: async paths => { events.push("prepare"); return preparePilotGreeting(paths); },
    absent: async path => { try { await lstat(path); throw new Error("existing"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } },
    acquireLock: async path => { events.push("lock"); const release = await acquireProcessLock(path); return async () => { events.push("unlock"); await release(); }; },
    prompt: async () => { events.push("prompt"); return { apiId: 1, apiHash: "a".repeat(32), passphrase }; },
    openSession: async (reference, phrase) => { events.push("decrypt"); assert.ok(await lstat(s.ownerLock)); const lease = await openExistingEncryptedSessionLease({ reference, passphrase: phrase });
      return { ...lease, release: async () => { assert.equal(connected, false); events.push("clear-session"); await lease.release(); } }; },
    createClient: (material, credentials) => { events.push("client"); assert.equal(material, "invented-session-material"); assert.equal(credentials.apiId, 1); return client; },
    installFence: value => { assert.equal(value, client); assert.equal(connected, false); events.push("fence"); return () => { events.push("restore-fence"); }; },
    createAdapter: createPilotTelegramAdapter, createStore: createEncryptedPilotStore,
    dispatch: async input => { events.push("outbox"); assert.equal(input.reply.text, PILOT_GREETING); assert.equal(input.approved.replyToMessageId, null); return runPilotReply(input); },
    killed: greetingKillSwitchEngaged,
    settle: async value => { await value.destroy(); return true; },
  };
  return { ...s, events, requests, ports, client };
}

test("actual preflight, encryption, adapter and outbox compose one fixed greeting on the sole injected client", async t => {
  const f = await flow(t);
  const result = await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.deepEqual(result, { status: "verified", code: "PILOT_GREETING_VERIFIED", lockPreserved: false, clientSettled: true });
  assert.deepEqual(f.events, ["prepare", "lock", "prompt", "decrypt", "client", "fence", "connect", "self", "messages.GetDialogs", "outbox", "messages.SendMessage", "channels.GetMessages", "destroy", "clear-session", "restore-fence", "unlock"]);
  assert.equal(f.requests.length, 3); await assert.rejects(lstat(f.ownerLock), { code: "ENOENT" });
  assert.ok(await lstat(join(f.paths.attemptDirectory, "terminal.enc")));
  assert.equal(JSON.stringify(result).includes(peerId), false); assert.equal(JSON.stringify(result).includes(PILOT_GREETING), false);
  const before = f.requests.length; assert.equal((await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal)).status, "refused"); assert.equal(f.requests.length, before);
});

test("unready receipt or existing owner prevents prompt, decrypt and connection", async t => {
  const f = await flow(t); const r = receipt(); r.guest.client.canary.answerExact = false; await writeFile(f.paths.modelReceiptPath, JSON.stringify(r));
  assert.equal((await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal)).status, "refused"); assert.deepEqual(f.events, ["prepare"]);
  const g = await flow(t); const release = await acquireProcessLock(g.ownerLock);
  assert.equal((await runPilotGreetingWithPorts(g.paths, g.ports, new AbortController().signal)).status, "refused"); assert.deepEqual(g.events, ["prepare", "lock"]); await release();
});

test("cancelled or malformed local credentials release a known lock without a client", async t => {
  for (const cancelled of [true, false]) {
    const f = await flow(t); f.ports.prompt = async () => { if (cancelled) throw new Error("private cancellation"); return { apiId: 0, apiHash: "invalid", passphrase }; };
    const r = await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal);
    assert.equal(r.status, "refused"); assert.equal(r.lockPreserved, false); assert.equal(f.events.includes("decrypt"), false); assert.equal(f.requests.length, 0);
  }
});

test("kill switch or attempt appearing during prompt refuses before constructing/connect", async t => {
  for (const kind of ["kill", "attempt"]) {
    const f = await flow(t); const prompt = f.ports.prompt;
    f.ports.prompt = async () => { if (kind === "kill") await writeFile(f.paths.killSwitchPath, ""); else await mkdir(f.paths.attemptDirectory); return prompt(); };
    const r = await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal);
    assert.equal(r.status, "refused"); assert.equal(f.events.includes("client"), false); assert.equal(r.lockPreserved, false);
  }
});

test("uncertain connect/send outcome destroys client and clears session but retains owner lock", async t => {
  for (const phase of ["connect", "send"]) {
    const f = await flow(t);
    if (phase === "connect") f.client.connect = async () => { throw new Error("private connect detail"); };
    else { const invoke = f.client.invoke; f.client.invoke = async request => { if (request instanceof Api.messages.SendMessage) throw new Error("reply may be sent"); return invoke(request); }; }
    const r = await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal);
    assert.equal(r.status, "unknown"); assert.equal(r.lockPreserved, true); assert.equal(r.clientSettled, true);
    assert.ok(await lstat(f.ownerLock)); assert.equal(f.events.includes("destroy"), true); assert.equal(f.events.includes("clear-session"), true); assert.equal(f.events.includes("unlock"), false);
  }
});

test("unconfirmed destroy dominates wire verification and retains both session lease and lock", async t => {
  const f = await flow(t); f.ports.settle = async () => false;
  const r = await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.deepEqual(r, { status: "unknown", code: "PILOT_GREETING_UNKNOWN", lockPreserved: true, clientSettled: false });
  assert.equal(f.events.includes("clear-session"), false); assert.equal(f.events.includes("restore-fence"), false); assert.equal(f.events.includes("unlock"), false);
});

test("deadline abort during an outstanding connect returns unknown and never proceeds to self/dialog/send", async t => {
  const f = await flow(t); const abort = new AbortController(); let entered!: () => void; let finish!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  f.client.connect = () => { entered(); return new Promise<void>(done => { finish = done; }); };
  const pending = runPilotGreetingWithPorts(f.paths, f.ports, abort.signal); await started; abort.abort();
  const r = await pending; assert.equal(r.status, "unknown"); assert.equal(r.lockPreserved, true); finish();
  await new Promise(done => setImmediate(done)); assert.equal(f.requests.length, 0); assert.equal(f.events.includes("self"), false);
});

test("cleanup release failure prevents a verified close and preserves ownership", async t => {
  const f = await flow(t); const openSession = f.ports.openSession;
  f.ports.openSession = async (...args) => { const lease = await openSession(...args); return { ...lease, release: async () => { throw new Error("private cleanup detail"); } }; };
  const r = await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.equal(r.status, "unknown"); assert.equal(r.lockPreserved, true); assert.equal(f.events.includes("unlock"), false);
});

test("MSIX directory identity regression reaches both preflight and durable outbox on the logical path", async t => {
  const f = await flow(t);
  const physical = join(dirname(f.root), "invented-msix-backing");
  const inspected: string[] = [];
  const inspection: PilotDirectoryInspection = {
    platform: "win32",
    async lstat(path) {
      assert.ok(path === f.root || path === physical); inspected.push(path);
      return lstat(f.root, { bigint: true }); // Simulates two views of the same directory.
    },
    realpath: async path => { assert.equal(path, f.root); return physical; },
    realpathSync: path => { assert.equal(path, f.root); return f.root; },
  };
  f.ports.prepare = paths => preparePilotGreeting(paths, inspection);
  f.ports.createStore = (directory, phrase) => createEncryptedPilotStore(directory, phrase, inspection);
  const r = await runPilotGreetingWithPorts(f.paths, f.ports, new AbortController().signal);
  assert.equal(r.status, "verified");
  assert.deepEqual(inspected, [f.root, physical, f.root, physical]);
  assert.ok(await lstat(join(f.paths.attemptDirectory, "terminal.enc")));
  assert.equal(f.requests.filter(request => request instanceof Api.messages.SendMessage).length, 1);
});

test("MSIX-shaped path with different directory identity blocks preflight and outbox reservation", async t => {
  const f = await flow(t); const physical = join(dirname(f.root), "invented-other-backing");
  const inspection: PilotDirectoryInspection = {
    platform: "win32", realpath: async () => physical, realpathSync: () => f.root,
    async lstat(path) {
      const metadata = await lstat(f.root, { bigint: true });
      if (path === physical) metadata.ino += 1n;
      return metadata;
    },
  };
  await assert.rejects(preparePilotGreeting(f.paths, inspection));
  const store = createEncryptedPilotStore(f.paths.attemptDirectory, passphrase, inspection);
  await assert.rejects(store.reserve({ version: "pilot-outbox-v1", state: "planned", chatId: peerId, accountId: "789", replyToMessageId: null,
    randomId: "123", idempotencyKey: "a".repeat(64), contentHash: "b".repeat(64), textBytes: 1 }));
  await assert.rejects(lstat(f.paths.attemptDirectory), { code: "ENOENT" });
  assert.equal(f.requests.length, 0);
});
