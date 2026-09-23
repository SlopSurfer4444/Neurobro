import test from "node:test";
import assert from "node:assert/strict";
import { createStandingMultiplexEpochWire } from "../src/standing-multiplex-epoch-wire.js";
import { EpochWireTimeout, EPOCH_FRAME_BYTES } from "../src/standing-epoch-wire.js";

function fixture() {
  const incoming: unknown[] = [], sent: unknown[] = [];
  let waiter: { resolve(v: unknown): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let activeReads = 0, activeWrites = 0, peakReads = 0, peakWrites = 0;
  const push = (v: unknown) => {
    if (waiter) { const w = waiter; waiter = undefined; clearTimeout(w.timer); w.resolve(v); }
    else incoming.push(v);
  };
  const wire = {
    async receive(ms: number) {
      activeReads++; peakReads = Math.max(peakReads, activeReads);
      try {
        if (incoming.length) return incoming.shift();
        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => { waiter = undefined; reject(new EpochWireTimeout("read")); }, ms);
          waiter = { resolve, timer };
        });
      } finally { activeReads--; }
    },
    async send(v: unknown, _ms: number) {
      activeWrites++; peakWrites = Math.max(peakWrites, activeWrites);
      try { await new Promise<void>(resolve => setImmediate(resolve)); sent.push(v); }
      finally { activeWrites--; }
    },
  };
  const signal = new AbortController();
  const mux = createStandingMultiplexEpochWire({ wire, workerIds: ["foreground", "analysis-1", "analysis-2"], signal: signal.signal });
  return { mux, sent, push, wire, signal, peaks: () => ({ peakReads, peakWrites }),
    async close() { push({ kind: "poolClosed", protocol: "standing-parallel-epoch-v1", code: "CLOSED", receipt: {} }); await mux.close(); } };
}

test("multiplexer routes interleaved worker frames with one reader and serialized writes", async () => {
  const f = fixture();
  try {
    const a = f.mux.port("analysis-1"), b = f.mux.port("analysis-2");
    const reads = [a.receive(500), b.receive(500)];
    f.push({ workerId: "analysis-2", frame: { kind: "completed", answer: "B" } });
    f.push({ workerId: "analysis-1", frame: { kind: "tool", name: "material" } });
    assert.deepEqual(await Promise.all(reads), [{ kind: "tool", name: "material" }, { kind: "completed", answer: "B" }]);
    await Promise.all([a.send({ kind: "release" }, 500), b.send({ kind: "release" }, 500)]);
    assert.deepEqual(f.peaks(), { peakReads: 1, peakWrites: 1 });
    assert.deepEqual(f.sent, [{ workerId: "analysis-1", frame: { kind: "release" } }, { workerId: "analysis-2", frame: { kind: "release" } }]);
  } finally { await f.close(); }
});

test("per-worker timeout preserves other queues and later same-worker input", async () => {
  const f = fixture();
  try {
    const a = f.mux.port("analysis-1"), b = f.mux.port("analysis-2");
    await assert.rejects(a.receive(10), e => e instanceof EpochWireTimeout);
    f.push({ workerId: "analysis-2", frame: { kind: "scope" } });
    f.push({ workerId: "analysis-1", frame: { kind: "completed" } });
    assert.deepEqual(await b.receive(500), { kind: "scope" });
    assert.deepEqual(await a.receive(500), { kind: "completed" });
  } finally { await f.close(); }
});

test("host work binding is attached only to turns and detached before queued send", async () => {
  const f = fixture(), binding = { taskRef: "task-1", planRef: "wave-1", workRef: "work-1" };
  try {
    const a = f.mux.port("analysis-1", () => binding);
    const sending = a.send({ kind: "turn", requestRef: "request-1" }, 500);
    binding.taskRef = "changed"; await sending;
    await a.send({ kind: "toolResult" }, 500);
    assert.deepEqual(f.sent[0], { workerId: "analysis-1", work: { taskRef: "task-1", planRef: "wave-1", workRef: "work-1" }, frame: { kind: "turn", requestRef: "request-1" } });
    assert.equal(Object.hasOwn(f.sent[1] as object, "work"), false);
  } finally { await f.close(); }
});

test("unknown worker faults all waiters without dispatching its frame", async () => {
  const f = fixture();
  try {
    const a = f.mux.port("analysis-1").receive(500), b = f.mux.port("foreground").receive(500);
    const checked = Promise.all([assert.rejects(a, /PROTOCOL/), assert.rejects(b, /PROTOCOL/)]);
    f.push({ workerId: "intruder", frame: { kind: "tool" } }); await checked;
    await assert.rejects(f.mux.port("analysis-2").send({ kind: "turn" }, 100), /PROTOCOL/);
    assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
});

test("same-worker overlapping read is refused; outer receipt remains separate", async () => {
  const f = fixture();
  try {
    const a = f.mux.port("analysis-1"), first = a.receive(500);
    await assert.rejects(a.receive(500), /BUSY/);
    f.push({ workerId: "analysis-1", frame: { kind: "closed" } });
    assert.deepEqual(await first, { kind: "closed" });
    const receipt = { kind: "poolClosed", protocol: "standing-parallel-epoch-v1", code: "CLOSED", receipt: { workers: 3 } };
    f.push(receipt); assert.deepEqual(await f.mux.receivePoolClosed(500), receipt);
  } finally { await f.close(); }
});

test("hostile outbound getter is not invoked and failed write cannot replay", async () => {
  const f = fixture(); let calls = 0;
  try {
    const frame = {}; Object.defineProperty(frame, "kind", { enumerable: true, get() { calls++; return "turn"; } });
    await assert.rejects(f.mux.port("analysis-1").send(frame, 100), /PROTOCOL/);
    assert.equal(calls, 0); assert.equal(f.sent.length, 0);
  } finally { await f.close(); }
  let writes = 0;
  const mux = createStandingMultiplexEpochWire({ workerIds: ["worker"], signal: new AbortController().signal,
    wire: { async receive() { throw Error("unused"); }, async send() { writes++; throw Error("uncertain write"); } } });
  await assert.rejects(mux.port("worker").send({ kind: "turn" }, 100), /uncertain write/);
  await assert.rejects(mux.port("worker").send({ kind: "turn" }, 100), /TRANSPORT/);
  assert.equal(writes, 1); await mux.close();
});

test("queued send expires before shared writer release and is never dispatched", async () => {
  let release!: () => void;
  const sent: unknown[] = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  const mux = createStandingMultiplexEpochWire({ workerIds: ["a", "b"], signal: new AbortController().signal,
    wire: { async receive() { throw Error("unused"); }, async send(frame) { sent.push(frame); await gate; } } });
  const a = mux.port("a"), b = mux.port("b");
  const first = a.send({ kind: "release" }, 1000);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(b.send({ kind: "turn" }, 10), e => e instanceof EpochWireTimeout);
  assert.equal(sent.length, 1);
  await assert.rejects(b.send({ kind: "turn" }, 10), /BUSY/);
  release(); await first;
  await new Promise<void>(resolve => setImmediate(resolve));
  await b.send({ kind: "release" }, 100);
  assert.equal(sent.length, 2);
  assert.equal((sent[1] as {frame:{kind:string}}).frame.kind, "release");
  await mux.close();
});

test("pool closure releases empty waiters while preserving queued worker closure", async () => {
  const f = fixture();
  try {
    const waiting = assert.rejects(f.mux.port("analysis-2").receive(1000), /CLOSED/);
    f.push({ workerId: "analysis-1", frame: { kind: "closed" } });
    f.push({ kind: "poolClosed", receipt: {} });
    await f.mux.receivePoolClosed(500); await waiting;
    assert.deepEqual(await f.mux.port("analysis-1").receive(500), { kind: "closed" });
    await assert.rejects(f.mux.port("analysis-1").receive(500), /CLOSED/);
    await assert.rejects(f.mux.receivePoolClosed(500), /CLOSED/);
  } finally { await f.close(); }
});

test("foreground image input preserves large turn budget without enlarging ordinary turns", async () => {
  const f = fixture();
  try {
    const image = Buffer.alloc(EPOCH_FRAME_BYTES).toString("base64");
    await f.mux.port("foreground").send({ kind: "turn", purpose: "conversation", requestRef: "request", input: "image", images: [{ mimeType: "image/png", base64: image }] }, 500);
    assert.equal(f.sent.length, 1);
    await assert.rejects(f.mux.port("foreground").send({ kind: "turn", text: image }, 500), /BOUNDS/);
  } finally { await f.close(); }
});
test("global close is serialized once and retains worker receipt readback", async () => {
  const f = fixture();
  try {
    const first = f.mux.port("analysis-1").send({ kind: "release" }, 500);
    const close = f.mux.requestPoolClose(500);
    assert.equal(f.mux.requestPoolClose(500), close);
    await assert.rejects(f.mux.port("analysis-2").send({ kind: "turn" }, 500), /CLOSED/);
    await first; await close;
    assert.deepEqual(f.sent[1], { kind: "close" });
    f.push({ workerId: "analysis-1", frame: { kind: "closed" } });
    f.push({ kind: "poolClosed", receipt: {} });
    assert.deepEqual(await f.mux.port("analysis-1").receive(500), { kind: "closed" });
    await f.mux.receivePoolClosed(500);
  } finally { await f.close(); }
});
