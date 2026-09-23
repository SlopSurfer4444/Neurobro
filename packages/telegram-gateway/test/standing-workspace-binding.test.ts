import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import {
  bindStandingWorkspaceWithPorts,
  readStandingWorkspaceBindingDialogs,
  type StandingWorkspaceBindingDialog,
  type StandingWorkspaceBindingInput,
  type StandingWorkspaceBindingPorts,
  type StandingWorkspaceBindingRecord,
} from "../src/standing-workspace-binding.js";

const title = "Example Support Team";
const accountId = "123456789";
const channelPeer = () => new Api.PeerChannel({ channelId: bigInt(123) });
const peerId = utils.getPeerId(channelPeer());

function fixture() {
  const events: string[] = [];
  const saved: Array<{ path: string; binding: StandingWorkspaceBindingRecord }> = [];
  const credentials = { apiId: 12345, apiHash: "a".repeat(32), passphrase: "invented-passphrase-value" };
  const material = { version: "rm0017-existing-string-session-v1" as const, kind: "existing-string-session" as const, value: "invented-session" };
  const client = {
    async connect() { events.push("client-connect"); },
    async getMe() { events.push("client-get-me"); return new Api.User({ id: bigInt(accountId), self: true }); },
    async invoke(_request: Api.messages.GetDialogs) { throw new Error("unused fake invoke"); },
    async destroy() { events.push("client-destroy"); },
  };
  const input: StandingWorkspaceBindingInput = {
    authConfigPath: "C:\\custody\\auth-config.json",
    previousBindingPath: "C:\\custody\\gateway-binding-v4.json",
    vaultPath: "C:\\custody\\windows-credentials-v1.json",
    appRoot: "C:\\app\\community-team-v1",
    workspaceId: "community-team-v1",
    title,
    signal: new AbortController().signal,
  };
  let dialogs: readonly StandingWorkspaceBindingDialog[] = [{ id: peerId, title, usable: true }];
  const ports: StandingWorkspaceBindingPorts = {
    async prepare() { events.push("prepare"); return { workspaceId: input.workspaceId, title, expectedAccountId: accountId,
      sessionReference: "C:\\custody\\session.enc", ownerLock: "C:\\custody\\session.enc.owner.lock",
      outputPath: "C:\\app\\community-team-v1\\gateway-binding.json", vaultPath: input.vaultPath }; },
    async acquireLock() { events.push("lock"); return async () => { events.push("unlock"); }; },
    async loadCredentials() { events.push("vault-load"); return credentials; },
    async openSession() { events.push("session-open"); return { kind: "existing-encrypted-session", material,
      async release() { events.push("session-release"); material.value = ""; } }; },
    createClient() { events.push("client-create"); return client; },
    installFence() { events.push("fence"); return () => { events.push("unfence"); }; },
    async connect(value) { await value.connect(); },
    async account(value) { const self = await value.getMe(); return { id: self.id.toString(), usable: Boolean(self.self && !self.bot && !self.deleted) }; },
    async dialogs() { events.push("dialogs"); return dialogs; },
    async settle(value, admitted) { events.push("settle"); await value.destroy(); await Promise.allSettled(admitted); return true; },
    async save(path, binding) { events.push("save"); saved.push({ path, binding }); },
    now: () => "2026-09-14T12:34:56.000Z",
  };
  return { input, ports, events, saved, credentials, client, setDialogs(value: readonly StandingWorkspaceBindingDialog[]) { dialogs = value; } };
}

test("verified account and unique usable member bind only after full client cleanup", async () => {
  const f = fixture();
  const result = await bindStandingWorkspaceWithPorts(f.input, f.ports);
  assert.deepEqual(result, { workspaceId: "community-team-v1", accountId, peerId, title });
  assert.deepEqual(f.events, ["prepare", "lock", "vault-load", "session-open", "client-create", "fence", "client-connect",
    "client-get-me", "dialogs", "settle", "client-destroy", "session-release", "unfence", "unlock", "save"]);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0]!.path, "C:\\app\\community-team-v1\\gateway-binding.json");
  assert.deepEqual(f.saved[0]!.binding, { version: "telegram-workspace-binding-v1", workspaceId: "community-team-v1",
    accountId, peerId, title, sessionReference: "C:\\custody\\session.enc", ownerLock: "C:\\custody\\session.enc.owner.lock",
    checkedAt: "2026-09-14T12:34:56.000Z", serving: false });
  assert.deepEqual(f.credentials, { apiId: 0, apiHash: "", passphrase: "" });
  assert.equal(Object.keys(result).sort().join("|"), "accountId|peerId|title|workspaceId");
});

test("old binding account mismatch refuses before dialog discovery and still joins cleanup", async () => {
  const f = fixture();
  f.ports.account = async value => { await value.getMe(); return { id: "123456788", usable: true }; };
  await assert.rejects(bindStandingWorkspaceWithPorts(f.input, f.ports), /STANDING_WORKSPACE_BINDING_REFUSED/);
  assert.equal(f.events.includes("dialogs"), false);
  assert.equal(f.events.includes("save"), false);
  assert.deepEqual(f.events.slice(-5), ["settle", "client-destroy", "session-release", "unfence", "unlock"]);
});

test("missing, ambiguous, unusable or invalid exact-title membership never writes a binding", async () => {
  const cases: readonly (readonly StandingWorkspaceBindingDialog[])[] = [
    [],
    [{ id: peerId, title, usable: true }, { id: "-100456", title, usable: true }],
    [{ id: peerId, title, usable: false }],
    [{ id: "123", title, usable: true }],
    [{ id: peerId, title: `${title} `, usable: true }],
  ];
  for (const value of cases) {
    const f = fixture(); f.setDialogs(value);
    await assert.rejects(bindStandingWorkspaceWithPorts(f.input, f.ports), /STANDING_WORKSPACE_BINDING_REFUSED/);
    assert.equal(f.events.filter(event => event === "dialogs").length, 1);
    assert.equal(f.events.includes("save"), false);
    assert.deepEqual(f.events.slice(-5), ["settle", "client-destroy", "session-release", "unfence", "unlock"]);
  }
});

test("unconfirmed client destruction preserves session, fence and owner lock and cannot save", async () => {
  const f = fixture();
  f.ports.settle = async () => { f.events.push("settle-timeout"); return false; };
  await assert.rejects(bindStandingWorkspaceWithPorts(f.input, f.ports), /STANDING_WORKSPACE_BINDING_REFUSED/);
  assert.equal(f.events.at(-1), "settle-timeout");
  for (const forbidden of ["session-release", "unfence", "unlock", "save"]) assert.equal(f.events.includes(forbidden), false);
});

test("cleanup failure blocks later cleanup ownership and persistence", async () => {
  const f = fixture(); const open = f.ports.openSession;
  f.ports.openSession = async (...args) => {
    const lease = await open(...args);
    return { ...lease, async release() { f.events.push("session-release-failed"); throw new Error("invented private error"); } };
  };
  await assert.rejects(bindStandingWorkspaceWithPorts(f.input, f.ports), /STANDING_WORKSPACE_BINDING_REFUSED/);
  assert.equal(f.events.includes("session-release-failed"), true);
  for (const forbidden of ["unfence", "unlock", "save"]) assert.equal(f.events.includes(forbidden), false);
});

test("abort during the sole dialog request returns after cleanup and discards a late result", async () => {
  const f = fixture(); const control = new AbortController();
  f.input = { ...f.input, signal: control.signal };
  let entered!: () => void; let finish!: (value: readonly StandingWorkspaceBindingDialog[]) => void;
  const started = new Promise<void>(done => { entered = done; });
  f.ports.dialogs = async () => { f.events.push("dialogs"); entered(); return new Promise(done => { finish = done; }); };
  const pending = bindStandingWorkspaceWithPorts(f.input, f.ports);
  await started; control.abort();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(f.events.slice(-2), ["settle", "client-destroy"]);
  for (const forbidden of ["session-release", "unfence", "unlock", "save"]) assert.equal(f.events.includes(forbidden), false);
  finish([{ id: peerId, title, usable: true }]);
  await assert.rejects(pending, /STANDING_WORKSPACE_BINDING_REFUSED/);
  assert.deepEqual(f.events.slice(-5), ["settle", "client-destroy", "session-release", "unfence", "unlock"]);
  assert.equal(f.events.includes("save"), false);
});

test("dialog adapter makes one GetDialogs(100), returns only dialog-backed groups and discards raw bodies", async () => {
  const peer = channelPeer();
  const dialog = new Api.Dialog({ peer, topMessage: 5, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0,
    unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) });
  const allowed = new Api.Channel({ id: bigInt(123), accessHash: bigInt(9), title, photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true });
  const unrelated = new Api.Channel({ id: bigInt(456), accessHash: bigInt(10), title, photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true });
  const envelope = new Api.messages.Dialogs({ dialogs: [dialog], chats: [allowed, unrelated],
    users: [new Api.User({ id: bigInt(77), firstName: "Invented" })],
    messages: [new Api.Message({ id: 5, peerId: peer, date: 1, message: "private body must be discarded" })] });
  const requests: Api.messages.GetDialogs[] = [];
  const client = {
    async connect() {}, async getMe() { return new Api.User({ id: bigInt(accountId), self: true }); }, async destroy() {},
    async invoke(request: Api.messages.GetDialogs) { requests.push(request); return envelope; },
  };
  const result = await readStandingWorkspaceBindingDialogs(client);
  assert.deepEqual(result, [{ id: peerId, title, usable: true }]);
  assert.equal(requests.length, 1); assert.equal(requests[0]!.limit, 100); assert.equal(requests[0]!.offsetId, 0);
  assert.equal(envelope.messages.length, 0); assert.equal(envelope.users.length, 0); assert.equal(envelope.chats.length, 0);
});

test("dialog adapter marks left/minimal/forbidden and non-group entities unusable", async () => {
  const peer = channelPeer();
  const dialog = new Api.Dialog({ peer, topMessage: 1, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0,
    unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) });
  for (const flags of [{ left: true }, { min: true }, { accessHash: bigInt.zero }, { broadcast: true, megagroup: false },
    { bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }) }]) {
    const channel = Object.assign(new Api.Channel({ id: bigInt(123), accessHash: bigInt(9), title, photo: new Api.ChatPhotoEmpty(), date: 1,
      megagroup: true }), flags);
    const envelope = new Api.messages.Dialogs({ dialogs: [dialog], chats: [channel], users: [], messages: [] });
    const client = { async connect() {}, async getMe() { return new Api.User({ id: bigInt(accountId), self: true }); }, async destroy() {},
      async invoke(_request: Api.messages.GetDialogs) { return envelope; } };
    assert.deepEqual(await readStandingWorkspaceBindingDialogs(client), [{ id: peerId, title, usable: false }]);
  }
});
