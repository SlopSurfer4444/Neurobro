import test, { mock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Api } from "telegram";
import { createStandingMediaReadPort } from "../src/standing-media-read-port.js";
const require = createRequire(import.meta.url);
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const bigInt = require("big-integer");
const quiet = { info() {}, debug() {}, warn() {}, error() {}, canSend: () => false };
const tick = () => new Promise<void>(r => setImmediate(r));
const request = () => new Api.upload.GetFile({
  location: new Api.InputPhotoFileLocation({ id: bigInt(1), accessHash: bigInt(2),
    fileReference: Buffer.from([1]), thumbSize: "m" }), offset: bigInt(0), limit: 4096,
});
function fixture(config: { delayConnect?: boolean; delayClose?: boolean; delayRead?: boolean;
  needsImport?: boolean; failConnect?: boolean } = {}) {
  const sockets: OfflineSocket[] = [];
  class OfflineSocket extends EventEmitter {
    closed = false;
    destroyed = false;
    callback: (() => void) | undefined;
    constructor() { super(); sockets.push(this); }
    connect(_port: number, _ip: string, callback: () => void) {
      this.callback = callback;
      if (config.failConnect) { queueMicrotask(() => this.emit("error", new Error("fixture refused"))); return; }
      if (!config.delayConnect) queueMicrotask(callback);
    }
    write() { return true; }
    destroy() {
      this.destroyed = true;
      if (!config.delayClose) queueMicrotask(() => this.finishClose());
      return this;
    }
    finishClose() { this.closed = true; this.emit("close"); }
  }
  const replacement = mock.method(net, "Socket", function () {
    return new OfflineSocket();
  } as unknown as typeof net.Socket);
  syncBuiltinESMExports();
  const client = new TelegramClient(new StringSession(""), 1, "fixture", {
    connectionRetries: 1, retryDelay: 0, autoReconnect: false,
  });
  client._log = quiet;
  client.session.setDC(1, "main-fixture", 443);
  client._config = { dcOptions: [{ id: 2, ipv6: false, ipAddress: "media-fixture" }] };
  const sent: unknown[] = [];
  let sender: any;
  let pending: any;
  let creates = 0;
  const create = client._createExportedSender.bind(client);
  client._createExportedSender = (dcId: number) => {
    creates++;
    sender = create(dcId);
    sender.authKey.getKey = () => Buffer.alloc(256, 1);
    if (config.needsImport) {
      const connect = sender.connect.bind(sender);
      sender.connect = async (...args: unknown[]) => {
        const result = await connect(...args);
        sender._authenticated = false;
        return result;
      };
    }
    // Actual sender/connection/socket loops run; only Telegram RPC response is
    // substituted. No fake implementation of connect/disconnect is used.
    sender.addStateToQueue = (state: any) => {
      sent.push(state.request);
      pending = state;
      if (!config.delayRead) queueMicrotask(() => state.resolve({ bytes: Buffer.from("photo") }));
    };
    return sender;
  };
  client.invoke = async (value: unknown) => { sent.push(value); return { bytes: Buffer.from("main-photo") }; };
  client._switchDC = async () => { throw new Error("global switch forbidden"); };
  const controller = new AbortController();
  const port = createStandingMediaReadPort({ client, signal: controller.signal });
  return { client, controller, port, sockets, sent, sender: () => sender,
    creates: () => creates, pending: () => pending,
    restore() { replacement.mock.restore(); syncBuiltinESMExports(); } };
}

test("same DC GetFile uses the sole main invoke without exported sender", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.port.readMediaFile(request(), 1), { bytes: Buffer.from("main-photo") });
    assert.equal(f.creates(), 0);
    assert.equal(f.client.session.dcId, 1);
    await f.port.close();
  } finally { f.restore(); }
});

test("remote GetFile uses actual installed sender/connection and joins every loop", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.port.readMediaFile(request(), 2), { bytes: Buffer.from("photo") });
    assert.equal(f.sent.length, 1);
    assert.ok(f.sent[0] instanceof Api.upload.GetFile);
    assert.equal(f.creates(), 1);
    assert.equal(f.sockets[0]!.closed, true);
    assert.equal(f.sender().isConnected(), false);
    assert.equal(f.client.session.dcId, 1);
    assert.equal(f.client._exportedSenderPromises.size, 0);
    await f.port.close();
  } finally { f.restore(); }
});

test("abort during acquisition closes socket and joins actual connect without retry", async () => {
  const f = fixture({ delayConnect: true });
  try {
    const reading = f.port.readMediaFile(request(), 2);
    const rejected = assert.rejects(reading);
    await tick();
    f.controller.abort();
    await f.port.close();
    await rejected;
    assert.equal(f.sockets[0]!.closed, true);
    assert.equal(f.creates(), 1);
    assert.equal(f.sent.length, 0);
    assert.equal(f.sender().isConnecting, false);
    f.sockets[0]!.callback?.();
    await tick();
    assert.equal(f.sender().isConnected(), false);
  } finally { f.restore(); }
});

test("abort during read rejects owned state and waits physical socket close", async () => {
  const f = fixture({ delayRead: true, delayClose: true });
  try {
    const reading = f.port.readMediaFile(request(), 2);
    const rejected = assert.rejects(reading);
    await tick();
    assert.ok(f.pending());
    f.controller.abort();
    let closed = false;
    const closing = f.port.close().then(() => { closed = true; });
    await tick();
    assert.equal(closed, false);
    assert.equal(f.sockets[0]!.destroyed, true);
    f.sockets[0]!.finishClose();
    await closing;
    await rejected;
    assert.equal(f.sender().isConnected(), false);
  } finally { f.restore(); }
});

test("completed RPC does not finish read until physical cleanup joins", async () => {
  const f = fixture({ delayClose: true });
  try {
    let done = false;
    const reading = f.port.readMediaFile(request(), 2).then(() => { done = true; });
    await tick();
    assert.equal(done, false);
    f.sockets[0]!.finishClose();
    await reading;
    await f.port.close();
  } finally { f.restore(); }
});

test("unsupported proxy fails before any sender/socket", async () => {
  const f = fixture();
  try {
    f.client._proxy = { ip: "fixture" };
    await assert.rejects(f.port.readMediaFile(request(), 2), /unsupported/);
    assert.equal(f.creates(), 0);
    assert.equal(f.sockets.length, 0);
    await f.port.close();
  } finally { f.restore(); }
});

test("cold client gets DC config through its same owned main invoke", async () => {
  const f = fixture();
  f.client._config = undefined;
  let configs = 0;
  f.client.invoke = async (value: unknown) => {
    assert.ok(value instanceof Api.help.GetConfig);
    configs++;
    return { dcOptions: [{ id: 2, ipv6: false, ipAddress: "media-fixture" }] };
  };
  try {
    await f.port.readMediaFile(request(), 2);
    assert.equal(configs, 1);
    assert.equal(f.client.session.dcId, 1);
    assert.equal(f.creates(), 1);
    await f.port.close();
  } finally { f.restore(); }
});

test("abort while main export is pending joins its external owner, never fake-settles", async () => {
  const f = fixture({ needsImport: true });
  let rejectExport!: (reason: unknown) => void;
  let exported = false;
  f.client.invoke = (value: unknown) => {
    assert.ok(value instanceof Api.auth.ExportAuthorization);
    exported = true;
    return new Promise((_resolve, reject) => { rejectExport = reject; });
  };
  try {
    const rejected = assert.rejects(f.port.readMediaFile(request(), 2));
    await tick();
    assert.equal(exported, true);
    f.controller.abort();
    let closed = false;
    const closing = f.port.close().then(() => { closed = true; });
    await tick();
    assert.equal(f.sockets[0]!.closed, true);
    assert.equal(closed, false);
    rejectExport(new Error("external main invoke owner has joined"));
    await closing;
    await rejected;
    assert.equal(f.sent.length, 0);
  } finally { f.restore(); }
});

test("export/import uses same client and clones main init request", async () => {
  const f = fixture({ needsImport: true });
  const original = f.client._initRequest.query;
  let exports = 0;
  f.client.invoke = async (value: unknown) => {
    assert.ok(value instanceof Api.auth.ExportAuthorization);
    exports++;
    return { id: bigInt(12), bytes: Buffer.from("authorization") };
  };
  try {
    await f.port.readMediaFile(request(), 2);
    assert.equal(exports, 1);
    assert.equal(f.sent.length, 2);
    const layer = f.sent[0] as Api.InvokeWithLayer;
    assert.ok(layer instanceof Api.InvokeWithLayer);
    assert.ok(layer.query instanceof Api.InitConnection);
    assert.ok(layer.query.query instanceof Api.auth.ImportAuthorization);
    assert.equal(f.client._initRequest.query, original);
    assert.ok(f.sent[1] instanceof Api.upload.GetFile);
    await f.port.close();
  } finally { f.restore(); }
});

test("remote connection failure does not call the main service error handler or retry", async () => {
  const f = fixture({ failConnect: true });
  let mainStops = 0;
  f.client._errorHandler = async () => { mainStops++; };
  try {
    await assert.rejects(f.port.readMediaFile(request(), 2), /connection failed/);
    assert.equal(mainStops, 0);
    assert.equal(f.creates(), 1);
    assert.equal(f.sockets.length, 1);
    assert.equal(f.sockets[0]!.closed, true);
    assert.equal(f.sent.length, 0);
    await f.port.close();
  } finally { f.restore(); }
});
