import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export class RpcError extends Error {
  readonly code: string;
  readonly outcome: 'failed' | 'unknown';

  constructor(code: string, outcome: 'failed' | 'unknown', message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.outcome = outcome;
  }
}

export interface AppServerTransportConfig {
  command: string;
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxLineBytes?: number;
}

type TransportState = 'new' | 'ready' | 'stopping' | 'closed' | 'failed';
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
};
type StopResult = { processExited: boolean; forced: boolean };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));

/** One owned child, no retry, and no inherited environment or shell expansion. */
export class AppServerTransport {
  private readonly config: AppServerTransportConfig;
  private readonly spawnChild: typeof spawn;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly maxLineBytes: number;
  private child?: ChildProcessWithoutNullStreams;
  private current: TransportState = 'new';
  private reason?: string;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: unknown) => void>();
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<StopResult>;
  private stopResult?: StopResult;
  private closePromise?: Promise<void>;
  private resolveClose?: () => void;
  private processClosed = false;
  private forced = false;

  constructor(config: AppServerTransportConfig, spawnChild: typeof spawn = spawn) {
    this.spawnChild = spawnChild;
    this.config = { ...config, args: [...(config.args ?? [])], env: { ...config.env } };
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.stopTimeoutMs = config.stopTimeoutMs ?? 2_000;
    this.maxLineBytes = config.maxLineBytes ?? 4 * 1024 * 1024;
    for (const [name, value] of Object.entries({
      requestTimeoutMs: this.requestTimeoutMs,
      stopTimeoutMs: this.stopTimeoutMs,
      maxLineBytes: this.maxLineBytes,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RpcError('INVALID_CONFIG', 'failed', `${name} must be a positive integer`);
    }
  }

  state(): { state: TransportState; pid?: number; reason?: string } {
    return { state: this.current, ...(this.child?.pid === undefined ? {} : { pid: this.child.pid }),
      ...(this.reason === undefined ? {} : { reason: this.reason }) };
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.current !== 'new') return Promise.reject(new RpcError('TRANSPORT_NOT_READY', 'failed', 'Transport cannot be started'));
    this.startPromise = this.startChild().catch((error: unknown) => {
      const rpcError = error instanceof RpcError ? error : new RpcError('INITIALIZATION_FAILED', 'unknown', 'App server initialization failed');
      if (this.current !== 'stopping' && this.current !== 'closed') this.fail(rpcError);
      throw rpcError;
    });
    return this.startPromise;
  }

  private async startChild(): Promise<void> {
    this.closePromise = new Promise(resolve => { this.resolveClose = resolve; });
    try {
      this.child = this.spawnChild(this.config.command, this.config.args, {
        cwd: this.config.cwd, env: this.config.env, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.processClosed = true;
      this.resolveClose?.();
      this.fail(new RpcError('SPAWN_FAILED', 'failed', 'Could not spawn app server'));
      throw new RpcError('SPAWN_FAILED', 'failed', 'Could not spawn app server');
    }
    const child = this.child;
    child.stdout.on('data', (chunk: Buffer) => this.readChunk(chunk));
    // Drain stderr without persisting potential credentials or unbounded output.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {
      if (this.current !== 'stopping' && this.current !== 'closed') this.fail(new RpcError('WRITE_FAILED', 'unknown', 'App server input failed'));
    });
    child.on('error', () => this.fail(new RpcError('SPAWN_FAILED', child.pid ? 'unknown' : 'failed', 'App server process failed')));
    child.on('exit', () => {
      if (this.current !== 'stopping' && this.current !== 'failed') {
        this.fail(this.buffer.length
          ? new RpcError('PROTOCOL_ERROR', 'unknown', 'App server exited with an incomplete frame')
          : new RpcError('PROCESS_EXITED', 'unknown', 'App server exited before transport stop'));
      }
      this.rejectPending(new RpcError('PROCESS_EXITED', 'unknown', 'App server exited'));
    });
    child.on('close', () => {
      this.processClosed = true;
      if (this.current !== 'failed') this.current = 'closed';
      this.buffer = Buffer.alloc(0);
      this.resolveClose?.();
    });
    child.stdout.on('end', () => {
      if (this.buffer.length && this.current !== 'stopping' && this.current !== 'failed') {
        this.fail(new RpcError('PROTOCOL_ERROR', 'unknown', 'App server ended with an incomplete frame'));
      }
    });
    await this.dispatch('initialize', {
      clientInfo: { name: 'neurobro_personal', title: 'Personal Neurobro', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    if (this.current !== 'new') throw new RpcError('TRANSPORT_STOPPED', 'failed', 'Transport stopped during initialization');
    await this.write({ method: 'initialized' });
    if (this.current !== 'new') throw new RpcError('TRANSPORT_STOPPED', 'failed', 'Transport stopped during initialization');
    this.current = 'ready';
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.current !== 'ready') return Promise.reject(new RpcError('TRANSPORT_NOT_READY', 'failed', 'App server transport is not ready'));
    return this.dispatch(method, params);
  }

  private dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    let serialized: string;
    try { serialized = JSON.stringify({ id, method, params }) + '\n'; }
    catch { return Promise.reject(new RpcError('INVALID_REQUEST', 'failed', 'Request is not JSON serializable')); }
    if (Buffer.byteLength(serialized) - 1 > this.maxLineBytes) {
      return Promise.reject(new RpcError('INVALID_REQUEST', 'failed', 'Request exceeds frame limit'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.fail(new RpcError('REQUEST_TIMEOUT', 'unknown', 'App server request timed out; outcome is unknown'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.writeSerialized(serialized).catch(() => {
        this.fail(new RpcError('WRITE_FAILED', 'unknown', 'App server request write failed'));
      });
    });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private async write(frame: Record<string, unknown>): Promise<void> {
    await this.writeSerialized(JSON.stringify(frame) + '\n');
  }

  private writeSerialized(frame: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.processClosed || this.current === 'stopping' || this.current === 'closed' || this.current === 'failed') {
        reject(new RpcError('TRANSPORT_STOPPED', 'failed', 'Transport is stopped'));
        return;
      }
      this.child.stdin.write(frame, error => error ? reject(error) : resolve());
    });
  }

  private readChunk(chunk: Buffer): void {
    if (!this.acceptsIncoming()) return;
    // Inspect each line before concatenation, keeping the retained buffer bounded.
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);
      if (this.buffer.length + fragment.length > this.maxLineBytes) {
        this.fail(new RpcError('PROTOCOL_ERROR', 'unknown', 'App server frame exceeds limit'));
        return;
      }
      this.buffer = Buffer.concat([this.buffer, fragment]);
      if (newline < 0) return;
      const line = this.buffer;
      this.buffer = Buffer.alloc(0);
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
        this.receive(JSON.parse(decoded));
      } catch {
        this.fail(new RpcError('PROTOCOL_ERROR', 'unknown', 'Invalid app server JSON frame'));
      }
      if (!this.acceptsIncoming()) return;
      offset = newline + 1;
    }
  }

  private acceptsIncoming(): boolean {
    return this.current === 'new' || this.current === 'ready';
  }

  private receive(frame: unknown): void {
    if (!object(frame)) throw new Error('Frame must be an object');
    if ('method' in frame) {
      if (typeof frame.method !== 'string' || !frame.method || 'result' in frame || 'error' in frame) throw new Error('Invalid method frame');
      if ('id' in frame) {
        if (!validId(frame.id)) throw new Error('Invalid server request id');
        // No approval, tool execution, credential access, or other server request is admitted.
        void this.write({ id: frame.id, error: { code: -32601, message: 'Client requests are not supported' } })
          .catch(() => this.fail(new RpcError('WRITE_FAILED', 'unknown', 'Could not deny server request')));
      } else {
        for (const listener of [...this.listeners]) {
          try { listener(frame.method, frame.params); } catch { /* Consumer exceptions do not change wire custody. */ }
        }
      }
      return;
    }
    if (!validId(frame.id) || ('result' in frame) === ('error' in frame)) throw new Error('Invalid response frame');
    if ('error' in frame && (!object(frame.error) || !Number.isSafeInteger(frame.error.code) || typeof frame.error.message !== 'string')) {
      throw new Error('Invalid RPC error');
    }
    // Identity is exact: string ids, unsolicited ids and duplicates never settle another call.
    const pending = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
    if (!pending) return;
    this.pending.delete(frame.id as number);
    clearTimeout(pending.timer);
    if (object(frame.error)) pending.reject(new RpcError(`SERVER_ERROR_${frame.error.code}`, 'failed', frame.error.message as string));
    else pending.resolve(frame.result);
  }

  private rejectPending(error: RpcError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: RpcError): void {
    if (this.current === 'closed' || this.current === 'failed') return;
    this.current = 'failed';
    this.reason = error.code;
    this.rejectPending(error);
    void this.stop();
  }

  stop(): Promise<StopResult> {
    // A missed close deadline is historical uncertainty, not permanent evidence of a live child.
    // Only the owned child's actual close event can upgrade a later readback; never kill/retry again.
    if (this.stopResult && !this.stopResult.processExited && this.processClosed) {
      this.stopResult = { processExited: true, forced: this.forced };
      this.stopPromise = Promise.resolve(this.stopResult);
    }
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopChild().then(result => { this.stopResult = result; return result; });
    return this.stopPromise;
  }

  private async waitForClose(): Promise<boolean> {
    if (this.processClosed || !this.child) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.closePromise!.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.stopTimeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async stopChild(): Promise<StopResult> {
    if (this.current !== 'failed' && this.current !== 'closed') this.current = 'stopping';
    this.rejectPending(new RpcError('TRANSPORT_STOPPED', 'unknown', 'Transport stopped with a request in flight'));
    if (!this.child) {
      if (this.current !== 'failed') this.current = 'closed';
      return { processExited: true, forced: false };
    }
    this.child.stdin.end();
    let exited = await this.waitForClose();
    if (!exited) {
      this.forced = true;
      this.child.kill('SIGKILL');
      exited = await this.waitForClose();
    }
    if (!exited) {
      this.current = 'failed';
      this.reason ??= 'PROCESS_EXIT_UNCONFIRMED';
    } else if (this.current !== 'failed') this.current = 'closed';
    return { processExited: exited, forced: this.forced };
  }
}
