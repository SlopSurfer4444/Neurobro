import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskManager, type StandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { createStandingHistoryTaskRuntime } from "../src/standing-history-task-runtime.js";
import { createStandingToolDispatcher } from "../src/standing-tool-dispatcher.js";
import { HISTORY_TASK_TOOL_SPECS, parseStandingHistoryTaskTool } from "../src/standing-history-task-tools.js";

const binding = { accountId: "123", peerId: "-100456" };
const primary = { chatId: "-100456", ownerId: "789", messageId: 123, text: "ПРОМПТ summarize the week" };
const request = { fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize available history" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("public disposition is a fixed reason only and requires ready chains for a ready record", async () => {
  const taskRef = "htask_" + "f".repeat(48), signal = new AbortController().signal;
  let disposition: unknown, ready = true;
  const manager = { async status() { return { taskRef, control: { storage: "ready", state: "queued", revision: 0, headHash: "a".repeat(64) },
    read: ready ? { storage: "ready", readProgress: { committedPages: 0, checkpoint: { status: "more", inexact: false, undated: 0 } } } : { storage: "absent" },
    analysis: { storage: "ready", analysisNodes: 0, leafNodes: 0, claims: "model-authored-unverified" }, disposition }; },
    async create() { throw Error(); }, async cancel() { throw Error(); }, async close() {} } as unknown as StandingHistoryTaskManager;
  const runtime = createStandingHistoryTaskRuntime({ binding, signal, manager });
  const call = async (requestRef: string) => runtime.handlers[1]!.call({ taskRef }, { requestRef, callRef: "status", signal }) as Promise<{ success: boolean; contentItems: { text: string }[] }>;
  try {
    runtime.begin({ requestRef: "reasons", primary });
    for (const reason of ["coverage", "stale", "consumed-without-prepared", "source-page-quota", "report-required", "overflow"]) {
      disposition = { storage: "ready", reason }; const result = await call("reasons");
      assert.equal(result.success, true); assert.deepEqual(JSON.parse(result.contentItems[0]!.text).disposition, disposition);
    }
    await runtime.finish(); runtime.begin({ requestRef: "bad", primary });
    for (const bad of [{ storage: "ready", reason: "PRIVATE" }, { storage: "ready", reason: "coverage", sourceHead: "PRIVATE" }, { storage: "absent", reason: "coverage" }, undefined]) {
      disposition = bad; const result = await call("bad"); assert.equal(result.success, false); assert.equal(result.contentItems[0]!.text.includes("PRIVATE"), false);
    }
    ready = false; disposition = { storage: "ready", reason: "coverage" }; assert.equal((await call("bad")).success, false);
    disposition = { storage: "unavailable" }; assert.equal((await call("bad")).success, true);
  } finally { await runtime.close(); }
});

test("public delivery projection preserves explicit evidence and rejects inconsistent or private host payloads", async () => {
  const taskRef = "htask_" + "e".repeat(48), signal = new AbortController().signal;
  let delivery: unknown;
  const manager = { async status() { return { taskRef, control: { storage: "ready", state: "queued", revision: 0, headHash: "a".repeat(64) },
    read: { storage: "ready", readProgress: { committedPages: 1024, checkpoint: { status: "empty-page", inexact: false, undated: 0 } } },
    analysis: { storage: "ready", analysisNodes: 1024, leafNodes: 1024, claims: "model-authored-unverified" }, delivery }; },
    async create() { throw Error(); }, async cancel() { throw Error(); }, async close() {} } as unknown as StandingHistoryTaskManager;
  const runtime = createStandingHistoryTaskRuntime({ binding, signal, manager });
  try {
    for (const state of ["verified", "unknown", "failed-terminal", "not-attempted", "unavailable"]) {
      runtime.begin({ requestRef: state, primary }); delivery = { state, consumed: state !== "not-attempted" };
      const result = await runtime.handlers[1]!.call({ taskRef }, { requestRef: state, callRef: "status", signal }) as { success: boolean; contentItems: { text: string }[] };
      assert.equal(result.success, true); assert.deepEqual(JSON.parse(result.contentItems[0]!.text).delivery, delivery);
      await runtime.finish();
    }
    runtime.begin({ requestRef: "hostile", primary });
    for (const bad of [{ state: "verified", consumed: false }, { state: "not-attempted", consumed: true }, { state: "verified", consumed: true, descriptor: { body: "PRIVATE TEXT" } }, { state: "observed", consumed: true }, undefined]) {
      delivery = bad;
      const result = await runtime.handlers[1]!.call({ taskRef }, { requestRef: "hostile", callRef: "bad", signal }) as { success: boolean; contentItems: { text: string }[] };
      assert.equal(result.success, false); assert.equal(result.contentItems[0]!.text.includes("PRIVATE"), false);
    }
    await runtime.finish(); runtime.begin({ requestRef: "parts", primary });
    for (const valid of [
      { state: "partial", consumed: true, partsTotal: 16, verifiedParts: 15, nextPart: 16 },
      { state: "verified", consumed: true, partsTotal: 5, verifiedParts: 5 },
      { state: "partial", consumed: true, partsTotal: 2, verifiedParts: 0, nextPart: 1 },
      { state: "partial", consumed: true, partsTotal: 2, verifiedParts: 1, nextPart: 2 },
      { state: "verified", consumed: true, partsTotal: 2, verifiedParts: 2 },
      { state: "unknown", consumed: true, partsTotal: 2, verifiedParts: 1 },
      { state: "failed-terminal", consumed: true, partsTotal: 2, verifiedParts: 1 }
    ]) {
      delivery = valid;
      const result = await runtime.handlers[1]!.call({ taskRef }, { requestRef: "parts", callRef: "status", signal }) as { success: boolean; contentItems: { text: string }[] };
      assert.equal(result.success, true); assert.deepEqual(JSON.parse(result.contentItems[0]!.text).delivery, valid);
    }
    await runtime.finish(); runtime.begin({ requestRef: "bad-parts", primary });
    for (const bad of [
      { state: "partial", consumed: true, partsTotal: 17, verifiedParts: 0, nextPart: 1 },
      { state: "verified", consumed: true, partsTotal: 5, verifiedParts: 2 },
      { state: "partial", consumed: true, partsTotal: 5, verifiedParts: 3, nextPart: 5 },
      { state: "partial", consumed: true, partsTotal: 2, verifiedParts: 1 },
      { state: "partial", consumed: true, partsTotal: 2, verifiedParts: 1, nextPart: 1 },
      { state: "verified", consumed: true, partsTotal: 2, verifiedParts: 1 },
      { state: "unknown", consumed: true, partsTotal: 2, verifiedParts: 1, nextPart: 2 },
      { state: "not-attempted", consumed: false, partsTotal: 2, verifiedParts: 0 },
      { state: "failed-terminal", consumed: true, partsTotal: 2, verifiedParts: 1, nextPart: 2 }
    ]) {
      delivery = bad;
      const result = await runtime.handlers[1]!.call({ taskRef }, { requestRef: "bad-parts", callRef: "status", signal }) as { success: boolean; contentItems: { text: string }[] };
      assert.equal(result.success, false);
    }
  } finally { await runtime.close(); }
});

test("public attempt facts preserve UNKNOWN independently of saved output without leaking owner identity", async () => {
  const taskRef = "htask_" + "a".repeat(48), signal = new AbortController().signal;
  let last: Record<string, unknown> = {};
  const manager = { async status() { return { taskRef,
    control: { storage: "ready", state: "queued", revision: 0, headHash: "f".repeat(64) },
    read: { storage: "absent" }, analysis: { storage: "absent" },
    attempts: { storage: "ready", attempts: 1, modelReplayAllowed: false, last: {
      attemptRef: "hattempt_private", planHash: "private-plan", nativeBinding: { epochId: "private-owner", requestRef: "private-request" }, ...last } } }; },
    async create() { throw Error(); }, async cancel() { throw Error(); }, async close() {} } as unknown as StandingHistoryTaskManager;
  const runtime = createStandingHistoryTaskRuntime({ binding, signal, manager });
  const dispatcher = createStandingToolDispatcher({ call: async () => { throw Error(); } }, runtime.handlers);
  try {
    for (const modelOutcome of [undefined, "unknown", "refused", "observed"]) {
      const requestRef = "status-" + String(modelOutcome); runtime.begin({ requestRef, primary });
      for (const stage of ["reserved", "prepared", "node"] as const) {
        const node = stage === "node", prepared = stage !== "reserved";
        last = { ...(modelOutcome === undefined ? {} : { modelOutcome }), ...(prepared ? { prepared: { outputHash: "private-output" } } : {}), ...(node ? { node: { nodeRef: "private-node" } } : {}) };
        const result = await dispatcher.call("neurobro_history_task_status", { taskRef }, { requestRef, callRef: requestRef + "-" + stage, signal });
        assert.equal(result.success, true);
        const text = result.contentItems[0].text, view = JSON.parse(text);
        assert.equal(view.attempts.last.modelOutcome, modelOutcome ?? "not-recorded");
        assert.equal(view.attempts.last.nodeCommitted, node);
        assert.equal(view.attempts.last.outputPrepared, prepared);
        assert.equal(view.attempts.modelReplayAllowed, false);
        assert.equal(view.attempts.execution, "not-inspected");
        assert.equal(view.attempts.ownerSettlement, "not-inspected");
        assert.equal(view.delivery, "not-inspected");
        assert.equal(text.includes("private-"), false);
      }
      await runtime.finish();
    }
  } finally { await dispatcher.close(); await runtime.close(); }
});
function gate() { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { promise, done }; }

test("actual dispatcher and manager preserve actor-bound task creation, restart status and cancellation", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-control-runtime-"));
  const directories = { control: join(root, "control"), pages: join(root, "pages"), analysis: join(root, "analysis") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const signal = new AbortController().signal; let revocations = 0;
  const openManager = () => openStandingHistoryTaskManager({ directories, binding, signal, passphrase: "synthetic-manager-runtime-passphrase",
    onCancelled: async () => { revocations++; } });
  let manager = await openManager();
  let runtime = createStandingHistoryTaskRuntime({ binding, signal, manager });
  let dispatcher = createStandingToolDispatcher({ call: async () => { throw Error("unexpected history"); } }, runtime.handlers);
  const scope = (requestRef: string) => ({ requestRef, callRef: "call-1", signal });
  try {
    runtime.begin({ requestRef: "turn-1", primary });
    const create = await dispatcher.call("neurobro_create_history_task", request, scope("turn-1"));
    assert.equal(create.success, true);
    const created = JSON.parse(create.contentItems[0].text); const taskRef: string = created.taskRef;
    assert.equal(created.control.state, "queued"); assert.equal(created.read.committedPages, 0);
    assert.equal(created.delivery, "not-inspected");
    for (const forbidden of ["requesterId", "accountId", "primaryMessageId", "offsetId", "headHash", "chainHash", "checkpoint", "passphrase"]) assert.equal(create.contentItems[0].text.includes(forbidden), false);
    assert.equal((await dispatcher.call("neurobro_create_history_task", { ...request, objective: "Replace goal" }, scope("turn-1"))).success, false);
    await runtime.finish();
    runtime.begin({ requestRef: "turn-2", primary: { ...primary, ownerId: "790", messageId: 124 } });
    assert.equal((await dispatcher.call("neurobro_history_task_status", { taskRef }, scope("turn-2"))).success, false);
    assert.equal((await dispatcher.call("neurobro_cancel_history_task", { taskRef }, scope("turn-2"))).success, false);
    assert.equal(revocations, 0);
    await dispatcher.close(); await runtime.close(); await manager.close();
    manager = await openManager(); runtime = createStandingHistoryTaskRuntime({ binding, signal, manager });
    dispatcher = createStandingToolDispatcher({ call: async () => { throw Error(); } }, runtime.handlers);
    runtime.begin({ requestRef: "turn-3", primary: { ...primary, messageId: 125 } });
    assert.equal((await dispatcher.call("neurobro_history_task_status", { taskRef }, scope("turn-1"))).success, false);
    const status = await dispatcher.call("neurobro_history_task_status", { taskRef }, scope("turn-3"));
    assert.equal(status.success, true); assert.equal(JSON.parse(status.contentItems[0].text).control.state, "queued");
    const cancelled = await dispatcher.call("neurobro_cancel_history_task", { taskRef }, scope("turn-3"));
    assert.equal(cancelled.success, true); assert.equal(JSON.parse(cancelled.contentItems[0].text).revocationJoined, true);
    assert.equal(revocations, 1);
  } finally { await dispatcher.close(); await runtime.close(); await manager.close(); }
});

test("finish revokes admitted call and waits for actual manager settlement before next selection", async () => {
  for (const globalAbort of [false, true]) {
  const entered = gate(), settle = gate(); let callSignal: AbortSignal | undefined;
  const manager = { async create(value: { signal: AbortSignal }) { callSignal = value.signal; entered.done(); await settle.promise; throw Error("cancelled"); },
    async status() { throw Error(); }, async cancel() { throw Error(); }, async close() { throw Error("borrowed manager must not close"); } } as unknown as StandingHistoryTaskManager;
  const controller = new AbortController();
  const runtime = createStandingHistoryTaskRuntime({ binding, signal: controller.signal, manager });
  runtime.begin({ requestRef: "turn", primary });
  const pending = runtime.handlers[0]!.call(request, { requestRef: "turn", callRef: "call", signal: controller.signal }); await entered.promise;
  if (globalAbort) controller.abort();
  let joined = false; const closing = runtime.finish().then(() => { joined = true; }); await tick();
  assert.equal(callSignal!.aborted, true); assert.equal(joined, false);
  assert.throws(() => runtime.begin({ requestRef: "new-turn", primary }));
  settle.done(); assert.equal((await pending as { success: boolean }).success, false); await closing;
  if (globalAbort) assert.throws(() => runtime.begin({ requestRef: "new-turn", primary }));
  else runtime.begin({ requestRef: "new-turn", primary });
  await runtime.close();
  }
});

test("tool schemas reject raw identity injection, malformed periods and getter/proxy arguments", () => {
  assert.equal(HISTORY_TASK_TOOL_SPECS.length, 3);
  assert.throws(() => parseStandingHistoryTaskTool(HISTORY_TASK_TOOL_SPECS[0]!.name, { ...request, requesterId: "790" }));
  for (const changed of [{ fromDate: true }, { toDate: 99 }, { timezone: "Not/AZone" }, { objective: "\0" }, { objective: "я".repeat(2049) }]) {
    assert.throws(() => parseStandingHistoryTaskTool(HISTORY_TASK_TOOL_SPECS[0]!.name, { ...request, ...changed }));
  }
  let invoked = false;
  assert.throws(() => parseStandingHistoryTaskTool(HISTORY_TASK_TOOL_SPECS[2]!.name, { get taskRef() { invoked = true; return "htask_" + "a".repeat(48); } }));
  assert.equal(invoked, false);
  assert.throws(() => parseStandingHistoryTaskTool(HISTORY_TASK_TOOL_SPECS[2]!.name, new Proxy({}, { ownKeys() { invoked = true; return []; } })));
  assert.equal(invoked, false);
});

test("unselected/stale calls and excess calls never reach manager; host errors never leak", async () => {
  let calls = 0;
  const manager = { async create() { calls++; throw Error("PRIVATE-HOST-PATH-AND-SECRET"); }, async status() { throw Error(); }, async cancel() { throw Error(); } } as unknown as StandingHistoryTaskManager;
  const signal = new AbortController().signal;
  const runtime = createStandingHistoryTaskRuntime({ binding, signal, manager });
  const scope = { requestRef: "turn", callRef: "call", signal };
  const call = () => runtime.handlers[0]!.call(request, scope) as Promise<{ success: boolean; contentItems: readonly { text: string }[] }>;
  assert.equal((await call()).success, false); assert.equal(calls, 0);
  runtime.begin({ requestRef: "turn", primary });
  assert.equal((await runtime.handlers[0]!.call(request, { ...scope, requestRef: "stale" }) as { success: boolean }).success, false);
  assert.equal(calls, 0);
  for (let i = 0; i < 8; i++) {
    const result = await call(); assert.equal(result.success, false);
    assert.equal(result.contentItems[0]!.text.includes("PRIVATE"), false);
  }
  assert.equal(calls, 8); await call(); assert.equal(calls, 8);
  await runtime.close(); await call(); assert.equal(calls, 8);
});
