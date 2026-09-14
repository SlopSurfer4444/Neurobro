import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Offline compatibility evidence for the installed 2.26.22 transport. These
// tests deliberately demonstrate why disconnect() is not an acquisition join.
const require = createRequire(import.meta.url);
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Connection } = require("telegram/network/connection/Connection");
const quiet = { info() {}, debug() {}, warn() {}, error() {}, canSend: () => false };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("installed sender disconnect does not join or revoke pending connect", async () => {
  const client = new TelegramClient(new StringSession(""), 1, "fixture", {
    connectionRetries: 1, retryDelay: 0, autoReconnect: false,
  });
  const sender = client._createExportedSender(2);
  sender._log = quiet;
  sender.authKey.getKey = () => Buffer.alloc(256, 1);
  const acquired = deferred();
  let connected = false, disconnects = 0, startedLoops = 0;
  const connection = {
    isConnected: () => connected,
    async connect() { await acquired.promise; connected = true; },
    async disconnect() { disconnects++; connected = false; },
    toString: () => "offline-owned-fixture",
  };
  sender._sendLoop = async () => { startedLoops++; };
  sender._recvLoop = async () => { startedLoops++; };
  let settled = false;
  const connecting = sender.connect(connection, false).finally(() => { settled = true; });
  await sender.disconnect();
  assert.equal(disconnects, 1);
  assert.equal(settled, false);
  assert.equal(startedLoops, 0);
  acquired.resolve();
  assert.equal(await connecting, true);
  assert.equal(sender.isConnected(), true);
  assert.equal(startedLoops, 2);
  await sender.disconnect();
});

test("installed connection disconnect skips an in-progress socket acquisition", async () => {
  const acquired = deferred();
  let closes = 0;
  class OfflineSocket {
    async connect() { await acquired.promise; }
    async close() { closes++; }
  }
  const connection = new Connection({ ip: "fixture", port: 1, dcId: 2,
    loggers: quiet, socket: OfflineSocket });
  connection.PacketCodecClass = class { tag = undefined; };
  connection._sendLoop = async () => {};
  connection._recvLoop = async () => {};
  const connecting = connection.connect();
  await connection.disconnect();
  assert.equal(closes, 0);
  acquired.resolve();
  await connecting;
  assert.equal(connection._connected, true);
  await connection.disconnect();
  assert.equal(closes, 1);
});

test("installed sender disconnect leaves a queued read request unresolved", async () => {
  const client = new TelegramClient(new StringSession(""), 1, "fixture", {
    connectionRetries: 1, retryDelay: 0, autoReconnect: false,
  });
  const sender = client._createExportedSender(2);
  sender._log = quiet;
  let settled = false;
  const pending = sender.send(new Api.help.GetConfig());
  const joined = pending.then(() => { settled = true; }, () => { settled = true; });
  await sender.disconnect();
  await Promise.resolve();
  assert.equal(settled, false);
  // Explicit fixture settlement; the library disconnect did not do it.
  for (const state of sender._sendQueue.values()) state.reject(new Error("fixture close"));
  await joined;
});
