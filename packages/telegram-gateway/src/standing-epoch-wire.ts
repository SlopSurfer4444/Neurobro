import type { Readable, Writable } from "node:stream";
import { performance } from "node:perf_hooks";

export const EPOCH_FRAME_BYTES = 786432;
export const EPOCH_TOTAL_BYTES = 16 * (12 * 1024 * 1024 + 128 * 1024);
export const EPOCH_QUEUE_BYTES = 3 * 1024 * 1024;
export const EPOCH_QUEUE_FRAMES = 32;
export type EpochWireCode = "closed" | "eof" | "partial-eof" | "frame" | "bounds" | "read" | "write" | "concurrent-read" | "concurrent-write" | "timeout-value";
export class EpochWireError extends Error {
  constructor(readonly code: EpochWireCode) { super("EPOCH_WIRE_" + code.toUpperCase()); this.name = "EpochWireError"; }
}
export class EpochWireTimeout extends Error {
  constructor(readonly direction: "read" | "write") { super("EPOCH_WIRE_" + direction.toUpperCase() + "_TIMEOUT"); this.name = "EpochWireTimeout"; }
}
export type EpochWire = Readonly<{
  send(frame: unknown, timeoutMs: number): Promise<void>;
  receive(timeoutMs: number): Promise<unknown>;
  sealWrites(): void;
  close(): void;
}>;
type Fault = EpochWireError | EpochWireTimeout;
type PendingRead = { resolve(value: unknown): void; reject(error: Fault): void; timer: ReturnType<typeof setTimeout> };
type PendingWrite = { resolve(): void; reject(error: Fault): void; timer: ReturnType<typeof setTimeout>;
  callbackDone: boolean; callbackFailed: boolean; drainSeen: boolean; returned: boolean; needsDrain: boolean; cleanup(): void };
function timeoutValid(value: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= 2147483647; }
function parse(bytes: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", {fatal:true,ignoreBOM:true}).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== text) throw new Error();
    return value;
  } catch { throw new EpochWireError("frame"); }
}

/** One pending operation per direction; read and write may proceed together.
 * Read timeout is nonfatal and preserves input. Write timeout revokes the wire:
 * submitted bytes may already have been written and must never be replayed.
 * send joins the write callback and any required drain, not peer receipt.
 * close removes only this adapter's listeners. It never destroys streams or
 * asserts process settlement; the owning controller retains that obligation.
 * onFault receives fixed errors only, excludes clean EOF, explicit close,
 * read timeout and nonfatal caller/concurrency errors. Its exceptions are ignored.
 * Pass byte-mode streams without setEncoding; parsed objects transfer to caller.
 */
export function createEpochWire({readable,writable,onFault}: {
  readable: Readable; writable: Writable; onFault?(error: Fault): void;
}): EpochWire {
  let terminal: Fault | undefined, inputEnded = false, writesSealed = false;
  let inputBytes = 0, outputBytes = 0, pendingLength = 0, queuedBytes = 0;
  const partial = Buffer.alloc(EPOCH_FRAME_BYTES);
  let queue: Array<{value: unknown; bytes: number}> = [];
  let read: PendingRead | undefined, write: PendingWrite | undefined;
  const detached = () => {
    readable.off("data", onData); readable.off("end", onEnd); readable.off("error", onReadError); readable.off("close", onReadClose);
    writable.off("error", onWriteError); writable.off("close", onWriteClose); writable.off("finish", onWriteFinish);
  };
  const stop = (error: Fault, notify: boolean) => {
    if (terminal) return;
    terminal = error; detached(); partial.fill(0); pendingLength = queuedBytes = 0; queue = [];
    if (read) { const current = read; read = undefined; clearTimeout(current.timer); current.reject(error); }
    if (write) {
      const current = write; write = undefined; current.cleanup(); clearTimeout(current.timer);
      // Submitted buffers belong to the Writable. Even its callback may leave
      // the same Buffer queued downstream (e.g. PassThrough), so never wipe it.
      current.reject(error);
    }
    if (notify) { try { onFault?.(error); } catch { /* diagnostics never reopen or replace the fault */ } }
  };
  const deliver = (value: unknown, bytes: number) => {
    if (read) { const current = read; read = undefined; clearTimeout(current.timer); current.resolve(value); return; }
    if (queue.length >= EPOCH_QUEUE_FRAMES || queuedBytes + bytes > EPOCH_QUEUE_BYTES) throw new EpochWireError("bounds");
    queue.push({value,bytes}); queuedBytes += bytes;
  };
  function onData(chunk: unknown) {
    if (terminal) return;
    try {
      if (!Buffer.isBuffer(chunk)) throw new EpochWireError("read");
      inputBytes += chunk.length;
      if (inputBytes > EPOCH_TOTAL_BYTES) throw new EpochWireError("bounds");
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10,offset), stopAt = newline < 0 ? chunk.length : newline;
        const length = stopAt - offset;
        if (pendingLength + length > EPOCH_FRAME_BYTES) throw new EpochWireError("bounds");
        chunk.copy(partial,pendingLength,offset,stopAt); pendingLength += length;
        if (newline < 0) break;
        if (!pendingLength) throw new EpochWireError("frame");
        const value = parse(partial.subarray(0,pendingLength)), size = pendingLength + 1;
        partial.fill(0,0,pendingLength); pendingLength = 0;
        deliver(value,size); offset = newline + 1;
      }
    } catch (error) { stop(error instanceof EpochWireError ? error : new EpochWireError("frame"),true); }
  }
  function onEnd() {
    if (terminal) return;
    if (pendingLength) { stop(new EpochWireError("partial-eof"),true); return; }
    inputEnded = true;
    if (read) { const current = read; read = undefined; clearTimeout(current.timer); current.reject(new EpochWireError("eof")); }
  }
  function onReadError() { stop(new EpochWireError("read"),true); }
  function onReadClose() { if (!inputEnded) stop(new EpochWireError("read"),true); }
  function onWriteError() { stop(new EpochWireError("write"),true); }
  function onWriteClose() { if (!writesSealed) stop(new EpochWireError("write"),true); }
  function onWriteFinish() { if (!writesSealed) stop(new EpochWireError("write"),true); }
  readable.on("data",onData); readable.on("end",onEnd); readable.on("error",onReadError); readable.on("close",onReadClose);
  writable.on("error",onWriteError); writable.on("close",onWriteClose); writable.on("finish",onWriteFinish);
  if (readable.readableEnded) onEnd();
  if (readable.destroyed && !inputEnded) onReadClose();
  if (writable.destroyed || writable.writableEnded) onWriteClose();
  return Object.freeze({
    receive(timeoutMs: number): Promise<unknown> {
      if (terminal) return Promise.reject(terminal);
      if (!timeoutValid(timeoutMs)) return Promise.reject(new EpochWireError("timeout-value"));
      if (read) return Promise.reject(new EpochWireError("concurrent-read"));
      const next = queue.shift();
      if (next) { queuedBytes -= next.bytes; return Promise.resolve(next.value); }
      if (inputEnded) return Promise.reject(new EpochWireError("eof"));
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => { if (read?.timer === timer) { read = undefined; reject(new EpochWireTimeout("read")); } },timeoutMs);
        read = {resolve,reject,timer};
      });
    },
    send(frame: unknown, timeoutMs: number): Promise<void> {
      if (terminal) return Promise.reject(terminal);
      if (writesSealed) return Promise.reject(new EpochWireError("closed"));
      if (!timeoutValid(timeoutMs)) return Promise.reject(new EpochWireError("timeout-value"));
      if (write) return Promise.reject(new EpochWireError("concurrent-write"));
      let bytes: Buffer = Buffer.alloc(0);
      try {
        if (frame === null || typeof frame !== "object" || Array.isArray(frame)) throw new EpochWireError("frame");
        const text = JSON.stringify(frame);
        if (typeof text !== "string" || Buffer.byteLength(text) > (frame!==null&&typeof frame==="object"&&(frame as {kind?:unknown}).kind==="turn"&&Object.hasOwn(frame,"images")?12*1024*1024:EPOCH_FRAME_BYTES)) throw new EpochWireError("bounds");
        bytes = Buffer.from(text + "\n"); parse(bytes.subarray(0,bytes.length - 1));
        if (outputBytes + bytes.length > EPOCH_TOTAL_BYTES) { bytes.fill(0); throw new EpochWireError("bounds"); }
      } catch (error) { bytes.fill(0); return Promise.reject(error instanceof EpochWireError ? error : new EpochWireError("frame")); }
      outputBytes += bytes.length; // reserve before any potentially partial write
      return new Promise((resolve,reject) => {
        const deadline = performance.now() + timeoutMs;
        const finish = () => {
          if (write === current && performance.now() >= deadline) { stop(new EpochWireTimeout("write"),true); return; }
          if (!current.returned || !current.callbackDone || current.callbackFailed || current.needsDrain && !current.drainSeen || write !== current) return;
          write = undefined; current.cleanup(); clearTimeout(current.timer); resolve();
        };
        const drain = () => { current.drainSeen = true; finish(); };
        const current: PendingWrite = {resolve,reject,callbackDone:false,callbackFailed:false,drainSeen:false,returned:false,needsDrain:false,
          timer:setTimeout(() => { if (write === current) stop(new EpochWireTimeout("write"),true); },timeoutMs),
          cleanup:()=>writable.off("drain",drain)};
        write = current; writable.on("drain",drain);
        try {
          const accepted = writable.write(bytes,(error?: Error | null) => {
            current.callbackDone = true;
            if (terminal || write !== current) return;
            // Node may emit its matching error immediately after this callback.
            // Keep the error listener through that emission; custom Writable
            // ports that only call back are still faulted in this microtask.
            if (error) { current.callbackFailed = true; queueMicrotask(() => stop(new EpochWireError("write"),true)); return; }
            finish();
          });
          current.needsDrain = !accepted; current.returned = true; finish();
        } catch { stop(new EpochWireError("write"),true); }
      });
    },
    // The process owner may now end stdin while retaining the sole stdout
    // reader, including buffered trailing frames and partial-EOF detection.
    // This seals admission only: it does not end streams or prove settlement.
    sealWrites() {
      if (terminal) throw terminal;
      if (write) throw new EpochWireError("concurrent-write");
      writesSealed = true;
    },
    close() { stop(new EpochWireError("closed"),false); },
  });
}
