import { createRequire } from "node:module";
import { Socket } from "node:net";
import { Api, type TelegramClient } from "telegram";

// Deliberately version-bound: GramJS's borrowed sender retries indefinitely and
// its public disconnect does not join acquisition, queues, or transport loops.
const require = createRequire(import.meta.url);
const { PromisedNetSockets } = require("telegram/extensions/PromisedNetSockets");
const { RequestState } = require("telegram/network/RequestState");
const { LAYER } = require("telegram/tl/AllTLObjects");
type Private = Record<string, any>;
export interface StandingMediaReadPort {
  readMediaFile(request: Api.upload.GetFile, dcId: number): Promise<unknown>;
  close(): Promise<void>;
}
export function createStandingMediaReadPort(options: {
  // Main-DC invoke MUST already be owned by the service's bounded invoke owner,
  // or runOwned must supply that owner. This port cannot close the shared main
  // sender independently. close() joins a pending main invoke without pretending
  // its own media-socket deadline settles that separate operation.
  client: TelegramClient;
  signal: AbortSignal;
  runOwned?: <T>(work: () => Promise<T>) => Promise<T>;
}): StandingMediaReadPort {
  const client = options.client as unknown as Private;
  const own = options.runOwned ?? (<T>(work: () => Promise<T>) => work());
  const stop = new AbortController();
  const stopped = () => new Error("standing media read stopped");
  const check = () => { if (stop.signal.aborted) throw stopped(); };
  let active: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let cleanupFailure: unknown;
  let abortCurrent: (() => void) | undefined;
  const abort = () => { stop.abort(); abortCurrent?.(); };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();

  async function remote(request: Api.upload.GetFile, dcId: number): Promise<unknown> {
    check();
    if (require("telegram/package.json").version !== "2.26.22" || client._proxy ||
        client.networkSocket !== PromisedNetSockets) {
      throw new Error("standing media transport unsupported");
    }
    // getDC may lazily issue help.GetConfig through the same owned main invoke.
    // The id originates in the authenticated photo descriptor; redirects and
    // CDN results are not followed, and no main session DC is changed.
    const dc = await own(() => client.getDC(dcId, false)) as Private;
    check();
    if (dc.id !== dcId) throw new Error("standing media DC mismatch");
    let socketClosing: Promise<void> | undefined;
    let socketConnectReject: ((reason: unknown) => void) | undefined;
    let rawSocket: Socket | undefined;
    let socketClosed = false;
    class OwnedSocket extends PromisedNetSockets {
      async connect(port: number, ip: string) {
        check();
        if (socketClosed) throw stopped();
        this.stream = Buffer.alloc(0);
        this.closed = false;
        this.canRead = new Promise(resolve => { this.resolveRead = resolve; });
        const raw = rawSocket = this.client = new Socket();
        await new Promise<void>((resolve, reject) => {
          socketConnectReject = reject;
          raw.once("error", reject);
          raw.once("close", () => {
            this.closed = true;
            this.resolveRead?.(false);
            reject(stopped());
          });
          raw.connect(port, ip, () => {
            if (stop.signal.aborted || socketClosed) { reject(stopped()); return; }
            this.receive();
            resolve();
          });
        });
        socketConnectReject = undefined;
        check();
      }
      close(): Promise<void> {
        if (socketClosing) return socketClosing;
        socketClosed = true;
        this.closed = true;
        this.resolveRead?.(false);
        socketConnectReject?.(stopped());
        socketClosing = rawSocket ? new Promise<void>(resolve => {
          const raw = rawSocket!;
          if (raw.closed) { resolve(); return; }
          raw.once("close", resolve);
          raw.destroy();
        }) : Promise.resolve();
        return socketClosing;
      }
    }
    const BaseConnection = client._connection;
    class OwnedConnection extends BaseConnection {
      constructor(config: unknown) { super(config); }
      async connect() {
        await this._connect();
        check();
        if (socketClosed) throw stopped();
        this._connected = true;
        this._sendTask = this._sendLoop();
        this._recvTask = this._recvLoop();
      }
      async disconnect() {
        this._connected = false;
        void this._sendArray.push(undefined);
        void this._recvArray.push(undefined);
        await this.socket.close();
      }
    }
    const sender = client._createExportedSender(dcId) as Private;
    sender._retries = 1;
    sender._delay = 0;
    sender._autoReconnect = false;
    sender._reconnectRetries = 0;
    // Never invoke client cleanup/reborrow callbacks for this unregistered sender.
    sender._onConnectionBreak = undefined;
    sender._authKeyCallback = undefined;
    // The installed sender reports transport errors through _client._errorHandler;
    // the standing main handler stops the entire service. This private sender
    // needs only local error reporting, never main-client disconnect authority.
    sender._client = { _errorHandler: undefined };
    const connection = new OwnedConnection({ ip: dc.ipAddress, port: dc.port,
      dcId, loggers: client._log, proxy: undefined, testServers: client.testServers,
      socket: OwnedSocket });
    const states = new Set<Private>();
    let cleanup: Promise<void> | undefined;
    let connectPromise: Promise<unknown> | undefined;
    const halt = () => {
      sender.userDisconnected = true;
      sender._userConnected = false;
      for (const state of states) state.reject(stopped());
      sender._sendQueue.clear();
      // Attach immediately; close() later admits or rejects physical settlement.
      void connection.disconnect().catch(() => {});
    };
    sender.reconnect = halt;
    sender._reconnect = halt;
    abortCurrent = halt;
    const timer = setTimeout(halt, 30_000);
    async function send(query: unknown): Promise<unknown> {
      check();
      if (socketClosed || !sender.isConnected()) throw stopped();
      const state = new RequestState(query);
      states.add(state);
      try { sender.addStateToQueue(state); return await state.promise; }
      finally { states.delete(state); }
    }
    async function settle(): Promise<void> {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        halt();
        await connection.disconnect();
        // The socket rejects acquisition before we join. No timeout race is
        // accepted as proof of a closed sender; late failures remain failures.
        await Promise.allSettled(connectPromise ? [connectPromise] : []);
        sender.userDisconnected = true;
        sender._userConnected = false;
        sender._sendQueue.clear();
        await connection.disconnect();
        await Promise.all([sender._sendLoopHandle, sender._recvLoopHandle,
          connection._sendTask, connection._recvTask]);
      })();
      return cleanup;
    }
    try {
      connectPromise = sender.connect(connection, false);
      if (!(await connectPromise)) throw new Error("standing media connection failed");
      check();
      if (socketClosed) throw stopped();
      if (!sender._authenticated) {
        const auth = await own(() => options.client.invoke(new Api.auth.ExportAuthorization({ dcId })));
        check();
        // Never mutate the main client's shared initRequest.query.
        const init = new Api.InitConnection({ ...client._initRequest,
          query: new Api.auth.ImportAuthorization({ id: auth.id, bytes: auth.bytes }) });
        await send(new Api.InvokeWithLayer({ layer: LAYER, query: init }));
        sender._authenticated = true;
      }
      return await send(request);
    } finally {
      clearTimeout(timer);
      try { await settle(); }
      catch (error) { cleanupFailure = error; throw error; }
      abortCurrent = undefined;
    }
  }
  return {
    readMediaFile(request, dcId) {
      if (!(request instanceof Api.upload.GetFile) ||
          !Number.isSafeInteger(dcId) || dcId < 1 || dcId > 5) {
        return Promise.reject(new Error("standing media read request invalid"));
      }
      if (active || closing || stop.signal.aborted || cleanupFailure) return Promise.reject(stopped());
      const operation = (async () => {
        check();
        return dcId === client.session.dcId
          ? own(() => options.client.invoke(request))
          : remote(request, dcId);
      })();
      active = operation;
      void operation.finally(() => { if (active === operation) active = undefined; }).catch(() => {});
      return operation;
    },
    close() {
      if (closing) return closing;
      abort();
      options.signal.removeEventListener("abort", abort);
      closing = (async () => {
        if (active) await active.catch(() => {});
        if (cleanupFailure) throw cleanupFailure;
      })();
      return closing;
    },
  };
}
