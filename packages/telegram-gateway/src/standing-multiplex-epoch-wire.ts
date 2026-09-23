import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { EpochWireTimeout, EPOCH_FRAME_BYTES, EPOCH_QUEUE_BYTES, getStandingMultiplexVisualFrameLimit } from "./standing-epoch-wire.js";
import type { EpochWire } from "./standing-epoch-session.js";

export type StandingPoolWorkBinding = Readonly<{ taskRef: string; planRef: string; workRef: string }>;
export class StandingMultiplexWireError extends Error {
  constructor(readonly code: "input" | "closed" | "protocol" | "bounds" | "busy" | "transport") {
    super("STANDING_MULTIPLEX_WIRE_" + code.toUpperCase());
  }
}
const fail = (code: StandingMultiplexWireError["code"]): never => { throw new StandingMultiplexWireError(code); };
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v);
function snapshot(v: unknown, depth = 0, budget = { left: EPOCH_FRAME_BYTES }): unknown {
  if (depth > 40 || --budget.left < 0) return fail("bounds");
  if (typeof v === "string") {
    budget.left -= Buffer.byteLength(v);
    if (budget.left < 0 || Buffer.from(v).toString("utf8") !== v) return fail("bounds");
    return v;
  }
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail("protocol");
  const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail("protocol");
  if (array && (Reflect.ownKeys(v).length !== v.length + 1 ||
      Reflect.ownKeys(v).some(k => k !== "length" && (typeof k !== "string" || !/^(0|[1-9]\d*)$/u.test(k) || Number(k) >= v.length)))) return fail("protocol");
  const result: Record<string, unknown> | unknown[] = array ? [] : {};
  for (const key of Reflect.ownKeys(v)) {
    if (array && key === "length") continue;
    const d = Object.getOwnPropertyDescriptor(v, key)!;
    if (typeof key !== "string" || !("value" in d) || !d.enumerable) return fail("protocol");
    budget.left -= Buffer.byteLength(key);
    Object.defineProperty(result, key, { value: snapshot(d.value, depth + 1, budget), enumerable: true });
  }
  return Object.freeze(result);
}
function record(v: unknown, limit = EPOCH_FRAME_BYTES): Record<string, unknown> {
  const s = snapshot(v, 0, { left: limit });
  if (!s || typeof s !== "object" || Array.isArray(s)) return fail("protocol");
  return s as Record<string, unknown>;
}
const timeout = (v: number) => { if (!Number.isSafeInteger(v) || v < 1 || v > 2147483647) return fail("input"); };

/** Transport only. A caller must authenticate the poolReady worker manifest
 * before construction. One underlying reader routes immutable frames; writes
 * remain serialized. This owns neither process settlement nor model admission.
 * Work bindings are supplied by the host only for history turn dispatch.
 */
export function createStandingMultiplexEpochWire(input: Readonly<{
  wire: EpochWire; workerIds: readonly string[]; signal: AbortSignal;
}>) {
  if (!input || typeof input !== "object" || types.isProxy(input)) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(ds).length !== 3 || ["wire", "workerIds", "signal"].some(k => !ds[k] || !("value" in ds[k]!))) return fail("input");
  const signal = ds.signal!.value as AbortSignal, workerIds = snapshot(ds.workerIds!.value) as readonly string[];
  if (!(signal instanceof AbortSignal) || types.isProxy(signal) || !Array.isArray(workerIds) || workerIds.length < 1 || workerIds.length > 8 ||
      workerIds.some(v => !id(v)) || new Set(workerIds).size !== workerIds.length) return fail("input");
  const rawWire = ds.wire!.value;
  if (!rawWire || typeof rawWire !== "object" || types.isProxy(rawWire)) return fail("input");
  const methods = Object.getOwnPropertyDescriptors(rawWire);
  if (["send", "receive"].some(k => !methods[k] || !("value" in methods[k]!) || typeof methods[k]!.value !== "function" || types.isProxy(methods[k]!.value))) return fail("input");
  const sendMethod = methods.send!.value as EpochWire["send"], receiveMethod = methods.receive!.value as EpochWire["receive"];
  const wire: EpochWire = { send: sendMethod.bind(rawWire), receive: receiveMethod.bind(rawWire) };
  type Waiter = { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };
  type Slot = { queue: { frame: unknown; bytes: number }[]; waiting?: Waiter; writing: boolean };
  const slots = new Map<string, Slot>(workerIds.map(v => [v, { queue: [], writing: false }]));
  const control: Slot = { queue: [], writing: false };
  let bytes = 0, terminal: Error | undefined, peerClosed = false, pump: Promise<void> | undefined, writes = Promise.resolve();
  let closingSend: Promise<void> | undefined;
  const stop = (error: Error) => {
    terminal ??= error;
    for (const slot of [...slots.values(), control]) {
      slot.queue.length = 0;
      if (slot.waiting) { clearTimeout(slot.waiting.timer); slot.waiting.reject(terminal); delete slot.waiting; }
    }
    bytes = 0;
  };
  const abort = () => stop(new StandingMultiplexWireError("closed"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  async function readLoop() {
    try {
      while (!terminal) {
        let raw: unknown;
        try { raw = await wire.receive(1000); }
        catch (e) { if (e instanceof EpochWireTimeout && e.direction === "read") continue; throw e; }
        if (terminal) break;
        const envelope = record(raw);
        const poolClosed = envelope.kind === "poolClosed";
        if (!poolClosed && (Object.keys(envelope).length !== 2 || !id(envelope.workerId) || !Object.hasOwn(envelope, "frame"))) return fail("protocol");
        const slot = poolClosed ? control : slots.get(envelope.workerId as string); if (!slot) return fail("protocol");
        const frame = poolClosed ? envelope : record(envelope.frame), size = Buffer.byteLength(JSON.stringify(envelope));
        if (size > EPOCH_FRAME_BYTES) return fail("bounds");
        if (slot.waiting) {
          const waiting = slot.waiting; delete slot.waiting; clearTimeout(waiting.timer); waiting.resolve(frame);
        } else {
          if (bytes + size > EPOCH_QUEUE_BYTES || slot.queue.length >= 64) return fail("bounds");
          slot.queue.push({ frame, bytes: size }); bytes += size;
        }
        if (poolClosed) {
          peerClosed = true;
          for (const pending of [...slots.values(), control]) {
            if (pending.waiting) {
              clearTimeout(pending.waiting.timer);
              pending.waiting.reject(new StandingMultiplexWireError("closed"));
              delete pending.waiting;
            }
          }
          break;
        }
      }
    } catch (error) { stop(error instanceof StandingMultiplexWireError ? error : new StandingMultiplexWireError("transport")); }
  }
  const start = () => { pump ??= readLoop(); };
  function receive(slot: Slot, timeoutMs: number) {
    timeout(timeoutMs); if (terminal) return Promise.reject(terminal);
    if (slot.waiting) return Promise.reject(new StandingMultiplexWireError("busy"));
    const saved = slot.queue.shift();
    if (saved) { bytes -= saved.bytes; return Promise.resolve(saved.frame); }
    if (peerClosed) return Promise.reject(new StandingMultiplexWireError("closed"));
    const promise = new Promise<unknown>((resolve, reject) => {
      const waiting: Waiter = { resolve, reject, timer: setTimeout(() => {
        if (slot.waiting === waiting) { delete slot.waiting; reject(new EpochWireTimeout("read")); }
      }, timeoutMs) };
      slot.waiting = waiting;
    });
    start(); return promise;
  }
  return Object.freeze({
    /** Owner-only global close. Worker faults may request the same joined close;
     * this does not discard queued worker receipts or stop the sole reader. */
    requestPoolClose(timeoutMs: number): Promise<void> {
      timeout(timeoutMs);
      if (closingSend) return closingSend;
      if (terminal) return Promise.reject(terminal);
      if (peerClosed) return Promise.resolve();
      const end = performance.now() + timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new EpochWireTimeout("write"); stop(error); reject(error);
        }, timeoutMs);
      });
      const operation = writes.then(async () => {
        if (terminal) throw terminal;
        if (peerClosed) return;
        const remaining = Math.ceil(end - performance.now());
        if (remaining <= 0) throw new EpochWireTimeout("write");
        await wire.send({ kind: "close" }, remaining);
      });
      writes = operation.catch(() => { stop(new StandingMultiplexWireError("transport")); });
      closingSend = Promise.race([operation, deadline]).finally(() => { clearTimeout(timer); });
      return closingSend;
    },
    /** Unvalidated outer close receipt; process owner must verify its schema,
     * exact workers/budgets and actual process settlement separately. */
    receivePoolClosed(timeoutMs: number) { return receive(control, timeoutMs); },
    port(workerId: string, bindTurn?: (frame: Readonly<Record<string, unknown>>) => StandingPoolWorkBinding | undefined): EpochWire {
      const slot = slots.get(workerId); if (!slot) return fail("input");
      return Object.freeze({
        async send(value: unknown, timeoutMs: number) {
          timeout(timeoutMs); if (terminal) throw terminal;
          if (peerClosed) return fail("closed");
          if (closingSend) return fail("closed");
          if (slot.writing) return fail("busy");
          const frame = record(value, 12 * 1024 * 1024), work = frame.kind === "turn" ? bindTurn?.(frame) : undefined;
          let binding: Record<string, unknown> | undefined;
          if (work !== undefined) {
            binding = record(work);
            if (Object.keys(binding).length !== 3 || !id(binding.taskRef) || !id(binding.planRef) || !id(binding.workRef)) return fail("input");
          }
          const envelope = Object.freeze({ workerId, ...(binding ? { work: binding } : {}), frame });
          const frameLimit = getStandingMultiplexVisualFrameLimit(envelope);
          if (Buffer.byteLength(JSON.stringify(envelope)) > frameLimit) return fail("bounds");
          const end = performance.now() + timeoutMs; slot.writing = true;
          let expired = false, dispatched = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              expired = true;
              if (dispatched) stop(new StandingMultiplexWireError("transport"));
              reject(new EpochWireTimeout("write"));
            }, timeoutMs);
          });
          const operation = writes.then(async () => {
            if (expired) return;
            if (terminal) throw terminal;
            if (peerClosed) return fail("closed");
            const remaining = Math.ceil(end - performance.now());
            if (remaining <= 0) { expired = true; throw new EpochWireTimeout("write"); }
            dispatched = true;
            await wire.send(envelope, remaining);
          });
          writes = operation.catch(() => { if (dispatched) stop(new StandingMultiplexWireError("transport")); })
            .finally(() => { slot.writing = false; });
          try { await Promise.race([operation, deadline]); }
          finally { clearTimeout(timer); }
        },
        receive(timeoutMs: number) {
          return receive(slot, timeoutMs);
        },
      });
    },
    async close() {
      stop(new StandingMultiplexWireError("closed"));
      signal.removeEventListener("abort", abort);
      await Promise.allSettled([pump, writes]);
    },
  });
}
