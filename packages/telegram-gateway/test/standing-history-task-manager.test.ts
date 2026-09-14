import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rename, rm, unlink } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { decryptSession } from "../src/session-crypto.js";
import { openStandingHistoryTaskManager } from "../src/standing-history-task-manager.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore } from "../src/standing-history-analysis-attempt-store.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { runStandingHistoryTaskDelivery } from "../src/standing-history-task-delivery.js";
import { createStandingHistoryTaskRuntime } from "../src/standing-history-task-runtime.js";
import type { PilotSend } from "../src/pilot-outbox.js";
import { recordStandingHistoryTaskDisposition } from "../src/standing-history-task-disposition.js";

type Manager = Awaited<ReturnType<typeof openStandingHistoryTaskManager>>;
type Status = Awaited<ReturnType<Manager["create"]>>;
const primary = () => ({ chatId: "-100456", ownerId: "456", messageId: 999, text: "Private originating message should not be persisted" });
const request = () => ({ fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Synthetic confidential history analysis" });

test("configured attempt status survives restart without replay or inferred running state", async t => {
  const f = await fixture(t), attemptsRoot = join(f.root, "attempts"); await mkdir(attemptsRoot);
  const args = { ...f.args, directories: { ...f.args.directories, attempts: attemptsRoot } };
  let manager = await openStandingHistoryTaskManager(args);
  const initial = await create(manager); assert.equal(initial.attempts?.storage, "ready");
  await manager.close();
  const header = JSON.parse(await decryptSession(await readFile(join(args.directories.control, initial.taskRef, "intent.enc"), "utf8"), args.passphrase));
  const analysis = await openStandingHistoryAnalysisStore({ directory: args.directories.analysis, passphrase: args.passphrase,
    intent: header.intent, mode: "open", readSourcePage: async () => undefined });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ directory: attemptsRoot, passphrase: args.passphrase, intent: header.intent, mode: "open", analysis });
  try {
    const reserved = await attempts.reserve({ plan: { kind: "leaf", sourceHead: "a".repeat(64), expectedHead: (await analysis.status()).headHash,
      nodeIndex: 1, modelInputHash: "b".repeat(64), inputs: [{ pageIndex: 1, maxBytes: 49152, materialRef: "hmat_" + "c".repeat(48) }] } });
    await attempts.recordModelOutcome({ attemptRef: reserved.attemptRef, outcome: "unknown" });
  } finally { await attempts.close(); await analysis.close(); }
  manager = await openStandingHistoryTaskManager(args);
  try {
    const status = await manager.status(actor(initial.taskRef));
    assert.equal(status.attempts?.storage, "ready");
    assert.ok(status.attempts && "last" in status.attempts);
    assert.equal(status.attempts.last?.modelOutcome, "unknown");
    assert.equal(status.attempts.last?.prepared, undefined);
    assert.equal(status.attempts.modelReplayAllowed, false);
    await assert.rejects(manager.status({ taskRef: initial.taskRef, requesterId: "999" }));
    await manager.cancel(actor(initial.taskRef));
    const cancelled = await manager.status(actor(initial.taskRef));
    assert.equal(cancelled.control.state, "cancelled");
    assert.deepEqual(cancelled.attempts, status.attempts);
  } finally { await manager.close(); }
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-task-manager-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-task-manager-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { control: join(root, "control"), pages: join(root, "pages"), analysis: join(root, "analysis") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const calls: { taskRef: string; revision: 1 }[] = [];
  const args = { directories, passphrase: "synthetic-history-manager-passphrase", binding: { accountId: "123", peerId: "-100456" },
    async onCancelled(value: { taskRef: string; revision: 1 }) { calls.push(value); } };
  return { root, args, calls };
}
async function opened(f: Awaited<ReturnType<typeof fixture>>, t: TestContext) {
  const manager = await openStandingHistoryTaskManager(f.args); t.after(() => manager.close()); return manager;
}
const create = (manager: Manager) => manager.create({ primary: primary(), request: request() });
const actor = (taskRef: string) => ({ taskRef, requesterId: "456" });
function slot(f: Awaited<ReturnType<typeof fixture>>, side: "control" | "pages" | "analysis", taskRef: string) {
  assert.match(taskRef, /^htask_[0-9a-f]{48}$/u); return join(f.args.directories[side], taskRef);
}
async function files(directory: string): Promise<unknown[]> {
  const names = await readdir(directory, { withFileTypes: true });
  return Promise.all(names.sort((a, b) => a.name.localeCompare(b.name)).map(async item => [item.name,
    item.isDirectory() ? await files(join(directory, item.name)) : await readFile(join(directory, item.name), "utf8")]));
}
async function allFiles(f: Awaited<ReturnType<typeof fixture>>) {
  return Promise.all(Object.values(f.args.directories).map(directory => files(directory)));
}
function allReady(status: Status) {
  assert.equal(status.control.storage, "ready"); assert.equal(status.control.state, "queued"); assert.equal(status.control.revision, 0);
  assert.equal(status.read.storage, "ready"); assert.equal(status.analysis.storage, "ready");
  if ("readProgress" in status.read) assert.equal(status.read.readProgress.committedPages, 0);
  if ("analysisNodes" in status.analysis) assert.equal(status.analysis.analysisNodes, 0);
}

async function deliveryFixture(t: TestContext) {
  const f = await fixture(t), directories = { ...f.args.directories, attempts: join(f.root, "attempts"), delivery: join(f.root, "delivery") };
  await mkdir(directories.attempts); await mkdir(directories.delivery);
  const args = { ...f.args, directories }, manager = await openStandingHistoryTaskManager(args);
  t.after(() => manager.close()); const initial = await create(manager);
  const header = JSON.parse(await decryptSession(await readFile(join(directories.control, initial.taskRef, "intent.enc"), "utf8"), args.passphrase));
  const intent = header.intent as StandingHistoryTaskIntent;
  async function deliver(mode: "verified" | "unknown", summary = "Private complete root summary") {
    const shared = { intent, passphrase: args.passphrase, mode: "open" as const };
    const source = await openStandingHistoryTaskStore({ ...shared, directory: directories.pages });
    const analysis = await openStandingHistoryAnalysisStore({ ...shared, directory: directories.analysis, readSourcePage: i => source.readPage(i) });
    const attempts = await openStandingHistoryAnalysisAttemptStore({ ...shared, directory: directories.attempts, analysis });
    const before = (await source.status()).readProgress.checkpoint, after = { ...before, pages: 1, status: "empty-page" as const };
    await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: after, sources: [], page: {
      schema: "neurobro-self-history-v1", fromDate: intent.fromDate, toDate: intent.toDate, messages: [], cursor: null, hasMore: false, status: "empty-page",
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: null, newestExaminedDate: null, traversalComplete: true, undatedEntries: 0, pages: 1 },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } } });
    const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis });
    const nativeBinding = { epochId: "d".repeat(32), requestRef: "private-native-request", purpose: "history-analysis" as const };
    let readiness;
    try {
      const plan = await planner.next(); if (plan.kind !== "leaf") throw Error("fixture leaf required");
      const material = prepareStandingHistoryAnalysisMaterial(plan);
      const reserved = await attempts.reserve({ plan: { kind: "leaf", sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, nodeIndex: 1, inputs: plan.inputs, modelInputHash: material.modelInputHash }, nativeBinding });
      await attempts.prepare({ attemptRef: reserved.attemptRef, output: { summary, claims: [] } });
      await attempts.commitPrepared({ attemptRef: reserved.attemptRef }); await attempts.recordModelOutcome({ attemptRef: reserved.attemptRef, outcome: "observed" });
      readiness = await planner.next(); if (readiness.kind !== "analysis-ready") throw Error("fixture ready required");
    } finally { await planner.close(); await attempts.close(); await analysis.close(); await source.close(); }
    // Nodes/observed model alone never imply a delivered final message.
    assert.deepEqual((await manager.status(actor(initial.taskRef))).delivery, { state: "not-attempted", consumed: false });
    let sent: PilotSend | undefined;
    const deliverNext = () => runStandingHistoryTaskDelivery({ intent, directories, passphrase: args.passphrase, readiness, signal: new AbortController().signal,
      async verifyOwnerReady(value) { assert.deepEqual(value, nativeBinding); return { schema: "standing-analysis-owner-ready-v1", nativeBinding: value, basis: "persisted-owner-settlement", modelOutcome: "not-proven" }; },
      ticket: { openTaskReply() { return { transport: { async sendOnce(value) { sent = value; if (mode === "unknown") throw Error("synthetic outcome lost"); return { messageId: 2001 }; },
        async readExact(chatId, messageId) { assert.ok(sent); return { chatId, messageId, accountId: intent.accountId, replyToMessageId: sent.replyToMessageId, text: sent.text }; } }, async close() {} }; } } });
    await deliverNext(); return { deliverNext };
  }
  return { ...f, args, manager, initial, intent, deliver };
}

test("optional delivery status reads actual encrypted terminals without exposing descriptor or implying settlement", async t => {
  for (const mode of ["verified", "unknown"] as const) {
    const f = await deliveryFixture(t);
    assert.deepEqual(f.initial.delivery, { state: "not-attempted", consumed: false });
    assert.deepEqual(await readdir(f.args.directories.delivery), []);
    await f.deliver(mode);
    const slot = join(f.args.directories.delivery, f.initial.taskRef), terminal = join(slot, "pilot", "terminal.enc");
    const original = await readFile(terminal); assert.equal(original.includes(Buffer.from("Private complete root summary")), false);
    // The reader can prove verified delivery from terminal even when the
    // convenience result/lease-joined receipt was lost; no settlement is added.
    if (mode === "verified") await unlink(join(slot, "result.enc"));
    await f.manager.close(); const reopened = await openStandingHistoryTaskManager(f.args); t.after(() => reopened.close());
    const status = await reopened.status(actor(f.initial.taskRef)); assert.deepEqual(status.delivery, { state: mode, consumed: true });
    assert.deepEqual(Object.keys(status.delivery!).sort(), ["consumed", "state"]);
    const runtime = createStandingHistoryTaskRuntime({ binding: f.args.binding, signal: new AbortController().signal, manager: reopened });
    try {
      runtime.begin({ requestRef: "status-turn", primary: primary() });
      const result = await runtime.handlers[1]!.call({ taskRef: f.initial.taskRef }, { requestRef: "status-turn", callRef: "status", signal: new AbortController().signal }) as { success: boolean; contentItems: { text: string }[] };
      assert.equal(result.success, true); const text = result.contentItems[0]!.text;
      assert.deepEqual(JSON.parse(text).delivery, { state: mode, consumed: true });
      for (const forbidden of ["Private complete", "descriptor", "leaseJoined", "resourcesSettled", "private-native", "textHash", "rootHash", "passphrase", f.args.directories.delivery]) assert.equal(text.includes(forbidden), false);
    } finally { await runtime.close(); }
    assert.deepEqual(await readFile(terminal), original);
  }
});

test("delivery lookup follows actor authentication, and empty/corrupt slots remain consumed and untouched", async t => {
  const f = await deliveryFixture(t), slot = join(f.args.directories.delivery, f.initial.taskRef);
  await mkdir(slot); await writeFile(join(slot, "descriptor.enc"), "synthetic incomplete ciphertext");
  let reads = 0; const original = fs.open;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (typeof args[0] === "string" && args[0].startsWith(f.args.directories.delivery)) reads++;
    return original(...args);
  }) as typeof fs.open; syncBuiltinESMExports();
  try { await assert.rejects(f.manager.status({ taskRef: f.initial.taskRef, requesterId: "999" })); assert.equal(reads, 0); }
  finally { fs.open = original; syncBuiltinESMExports(); }
  const before = await files(f.args.directories.delivery);
  assert.deepEqual((await f.manager.status(actor(f.initial.taskRef))).delivery, { state: "unavailable", consumed: true });
  assert.deepEqual(await files(f.args.directories.delivery), before);
  await unlink(join(slot, "descriptor.enc"));
  assert.deepEqual((await f.manager.status(actor(f.initial.taskRef))).delivery, { state: "unavailable", consumed: true });
  assert.deepEqual(await readdir(slot), []);
});

test("actual multipart reader reports partial with explicit next part, then verified only after both terminals", async t => {
  const f = await deliveryFixture(t), delivered = await f.deliver("verified", "s".repeat(4096));
  const first = await f.manager.status(actor(f.initial.taskRef));
  assert.deepEqual(first.delivery, { state: "partial", consumed: true, partsTotal: 2, verifiedParts: 1, nextPart: 2 });
  const runtime = createStandingHistoryTaskRuntime({ binding: f.args.binding, signal: new AbortController().signal, manager: f.manager });
  try {
    runtime.begin({ requestRef: "partial-status", primary: primary() });
    const result = await runtime.handlers[1]!.call({ taskRef: f.initial.taskRef }, { requestRef: "partial-status", callRef: "status", signal: new AbortController().signal }) as { success: boolean; contentItems: { text: string }[] };
    assert.equal(result.success, true); assert.deepEqual(JSON.parse(result.contentItems[0]!.text).delivery, first.delivery);
  } finally { await runtime.close(); }
  await delivered.deliverNext();
  assert.deepEqual((await f.manager.status(actor(f.initial.taskRef))).delivery, { state: "verified", consumed: true, partsTotal: 2, verifiedParts: 2 });
});

test("a consumed empty next-part slot keeps the same verified count but removes continuation", async t => {
  const f = await deliveryFixture(t); await f.deliver("verified", "s".repeat(4096));
  assert.deepEqual((await f.manager.status(actor(f.initial.taskRef))).delivery, { state: "partial", consumed: true, partsTotal: 2, verifiedParts: 1, nextPart: 2 });
  const part = join(f.args.directories.delivery, f.initial.taskRef, "part-02"); await mkdir(part);
  assert.deepEqual((await f.manager.status(actor(f.initial.taskRef))).delivery, { state: "unknown", consumed: true, partsTotal: 2, verifiedParts: 1 });
  assert.deepEqual(await readdir(part), []);
});

test("disposition reads only the authenticated actual head pair and does not synthesize heads for unavailable chains", async t => {
  const f = await fixture(t), directory = join(f.root, "disposition"); await mkdir(directory);
  const args = { ...f.args, directories: { ...f.args.directories, disposition: directory } }, manager = await openStandingHistoryTaskManager(args);
  t.after(() => manager.close()); const initial = await create(manager);
  assert.deepEqual(initial.disposition, { storage: "absent" }); assert.deepEqual(await readdir(directory), []);
  const header = JSON.parse(await decryptSession(await readFile(join(args.directories.control, initial.taskRef, "intent.enc"), "utf8"), args.passphrase));
  if (initial.read.storage !== "ready" || initial.analysis.storage !== "ready") throw Error();
  const saved = await recordStandingHistoryTaskDisposition({ directory, passphrase: args.passphrase, intent: header.intent,
    sourceHead: initial.read.readProgress.chainHash, analysisHead: initial.analysis.headHash, reason: "coverage" });
  const original = await files(directory);
  assert.deepEqual((await manager.status(actor(initial.taskRef))).disposition, { storage: "ready", reason: "coverage" });
  const runtime = createStandingHistoryTaskRuntime({ binding: f.args.binding, signal: new AbortController().signal, manager });
  try {
    runtime.begin({ requestRef: "disposition", primary: primary() });
    const result = await runtime.handlers[1]!.call({ taskRef: initial.taskRef }, { requestRef: "disposition", callRef: "status", signal: new AbortController().signal }) as { success: boolean; contentItems: { text: string }[] };
    assert.equal(result.success, true); const text = result.contentItems[0]!.text;
    assert.deepEqual(JSON.parse(text).disposition, { storage: "ready", reason: "coverage" });
    for (const value of ["sourceHead", "analysisHead", saved.disposition.sourceHead, directory]) assert.equal(text.includes(value), false);
  } finally { await runtime.close(); }
  let reads = 0; const originalOpen = fs.open;
  fs.open = (async (...values: Parameters<typeof fs.open>) => { if (typeof values[0] === "string" && values[0].startsWith(directory)) reads++; return originalOpen(...values); }) as typeof fs.open;
  syncBuiltinESMExports();
  try { await assert.rejects(manager.status({ taskRef: initial.taskRef, requesterId: "999" })); assert.equal(reads, 0); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  const source = await openStandingHistoryTaskStore({ directory: args.directories.pages, passphrase: args.passphrase, intent: header.intent, mode: "open" });
  try {
    const before = (await source.status()).readProgress.checkpoint;
    await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: { ...before, pages: 1, status: "empty-page" }, sources: [], page: {
      schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate, messages: [], cursor: null, hasMore: false, status: "empty-page",
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: null, newestExaminedDate: null, traversalComplete: true, undatedEntries: 0, pages: 1 },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } } });
  } finally { await source.close(); }
  assert.deepEqual((await manager.status(actor(initial.taskRef))).disposition, { storage: "absent" });
  assert.deepEqual(await files(directory), original);
  const analysisSlot = join(args.directories.analysis, initial.taskRef), retained = join(f.root, "retained-disposition-analysis");
  assert.ok(analysisSlot.startsWith(args.directories.analysis)); assert.ok(retained.startsWith(f.root)); await rename(analysisSlot, retained);
  reads = 0; fs.open = (async (...values: Parameters<typeof fs.open>) => { if (typeof values[0] === "string" && values[0].startsWith(directory)) reads++; return originalOpen(...values); }) as typeof fs.open;
  syncBuiltinESMExports();
  try { assert.deepEqual((await manager.status(actor(initial.taskRef))).disposition, { storage: "unavailable" }); assert.equal(reads, 0); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
});

test("creation prepares all three encrypted stores and stable primary identity survives a fresh manager", async t => {
  const f = await fixture(t), manager = await opened(f, t), initial = await create(manager); allReady(initial);
  for (const side of ["control", "pages", "analysis"] as const) {
    assert.deepEqual(await readdir(f.args.directories[side]), [initial.taskRef]);
    assert.deepEqual(await readdir(slot(f, side, initial.taskRef)), ["intent.enc"]);
    const cipher = await readFile(join(slot(f, side, initial.taskRef), "intent.enc"), "utf8");
    assert.equal(cipher.includes(request().objective), false); assert.equal(cipher.includes(primary().text), false);
    const plain = await decryptSession(cipher, f.args.passphrase); assert.equal(plain.includes(primary().text), false);
  }
  const disk = await allFiles(f); assert.deepEqual(await create(manager), initial); await manager.close();
  const again = await opened(f, t); assert.deepEqual(await again.status(actor(initial.taskRef)), initial);
  assert.deepEqual(await again.create({ primary: { ...primary(), text: "Changed message text" }, request: request() }), initial);
  assert.deepEqual(await allFiles(f), disk); assert.deepEqual(f.calls, []);
});

test("same primary with changed request conflicts instead of allocating another task", async t => {
  const f = await fixture(t), manager = await opened(f, t); await create(manager); const before = await allFiles(f);
  for (const delta of [{ objective: "New task" }, { fromDate: 1001 }, { toDate: 2001 }, { timezone: "UTC" }])
    await assert.rejects(manager.create({ primary: primary(), request: { ...request(), ...delta } }));
  assert.deepEqual(await allFiles(f), before);
  const other = await manager.create({ primary: { ...primary(), messageId: 1000 }, request: request() }); allReady(other);
  assert.equal((await readdir(f.args.directories.control)).length, 2);
});

test("creator-only status and cancellation reject a foreign actor without writes or callback", async t => {
  const f = await fixture(t), manager = await opened(f, t), initial = await create(manager), before = await allFiles(f);
  for (const requesterId of ["457", "123"]) {
    await assert.rejects(manager.status({ taskRef: initial.taskRef, requesterId }));
    await assert.rejects(manager.cancel({ taskRef: initial.taskRef, requesterId }));
  }
  await assert.rejects(manager.create({ primary: { ...primary(), chatId: "-100999" }, request: request() }));
  await assert.rejects(manager.create({ primary: { ...primary(), ownerId: "123" }, request: request() }));
  assert.deepEqual(await allFiles(f), before); assert.deepEqual(f.calls, []);
  assert.deepEqual(await manager.status(actor(initial.taskRef)), initial);
});

test("fresh status authenticates control directly and missing tasks remain noncreating", async t => {
  const f = await fixture(t), manager = await opened(f, t); await assert.rejects(manager.status(actor("htask_" + "f".repeat(48))));
  await assert.rejects(manager.cancel(actor("htask_" + "f".repeat(48)))); assert.deepEqual(await allFiles(f), [[], [], []]);
  const initial = await create(manager); await manager.close();
  const again = await opened(f, t); assert.equal((await again.status(actor(initial.taskRef))).taskRef, initial.taskRef);
  const before = await allFiles(f); const foreign = await openStandingHistoryTaskManager({ ...f.args, binding: { ...f.args.binding, peerId: "-100999" } }); t.after(() => foreign.close());
  await assert.rejects(foreign.status(actor(initial.taskRef))); await assert.rejects(foreign.cancel(actor(initial.taskRef)));
  assert.deepEqual(await allFiles(f), before); assert.deepEqual(f.calls, []);
});

test("partial creation resumes only absent slots and preserves the existing reservation bytes", async t => {
  const f = await fixture(t), manager = await opened(f, t), initial = await create(manager); await manager.close();
  for (const side of ["pages", "analysis"] as const) await rename(slot(f, side, initial.taskRef), join(f.root, "retained-" + side));
  const reservation = await files(slot(f, "control", initial.taskRef)), again = await opened(f, t);
  const absent = await again.status(actor(initial.taskRef)); assert.equal(absent.read.storage, "absent"); assert.equal(absent.analysis.storage, "absent");
  assert.deepEqual(await readdir(f.args.directories.pages), []); assert.deepEqual(await readdir(f.args.directories.analysis), []);
  const recovered = await create(again); allReady(recovered); assert.equal(recovered.taskRef, initial.taskRef);
  assert.deepEqual(await files(slot(f, "control", initial.taskRef)), reservation);
});

test("existing partial or corrupt data slots are preserved and cannot be overwritten by create", async t => {
  for (const side of ["pages", "analysis"] as const) {
    const f = await fixture(t), manager = await opened(f, t), initial = await create(manager); await manager.close();
    const path = join(slot(f, side, initial.taskRef), "intent.enc"); await writeFile(path, "retained partial " + side);
    const before = await allFiles(f), again = await opened(f, t), status = await again.status(actor(initial.taskRef));
    assert.equal((side === "pages" ? status.read : status.analysis).storage, "unavailable");
    await assert.rejects(create(again)); assert.deepEqual(await allFiles(f), before);
  }
});

test("invalid encrypted control authority refuses status/create/cancel and retains every byte", async t => {
  const f = await fixture(t), manager = await opened(f, t), initial = await create(manager); await manager.close();
  await writeFile(join(slot(f, "control", initial.taskRef), "intent.enc"), "retained corrupt authority");
  const before = await allFiles(f), again = await opened(f, t);
  await assert.rejects(again.status(actor(initial.taskRef))); await assert.rejects(again.cancel(actor(initial.taskRef))); await assert.rejects(create(again));
  assert.deepEqual(await allFiles(f), before); assert.deepEqual(f.calls, []);
});

test("control-only cancellation joins callback with corrupt pages and leaves absent analysis untouched", async t => {
  const f = await fixture(t), first = await opened(f, t), initial = await create(first); await first.close();
  await writeFile(join(slot(f, "pages", initial.taskRef), "intent.enc"), "retained inaccessible pages");
  await rename(slot(f, "analysis", initial.taskRef), join(f.root, "retained-analysis"));
  const pagesBefore = await files(f.args.directories.pages), entered = deferred(), release = deferred(); let callbackDone = false, returned = false;
  const manager = await openStandingHistoryTaskManager({ ...f.args, async onCancelled(value) {
    f.calls.push(value); entered.resolve(); await release.promise; callbackDone = true;
  } }); t.after(() => manager.close());
  const pending = manager.cancel(actor(initial.taskRef)).then(value => { returned = true; return value; }); await entered.promise;
  const controlFiles = await readdir(slot(f, "control", initial.taskRef)); assert.ok(controlFiles.includes("cancel-000001.enc"));
  await immediate(); assert.equal(returned, false); release.resolve(); const cancelled = await pending;
  assert.equal(callbackDone, true); assert.equal(cancelled.revocationJoined, true); assert.equal(cancelled.control.state, "cancelled");
  assert.deepEqual(f.calls, [{ taskRef: initial.taskRef, revision: 1 }]); assert.deepEqual(await files(f.args.directories.pages), pagesBefore);
  assert.deepEqual(await readdir(f.args.directories.analysis), []);
  await assert.rejects(create(manager)); assert.deepEqual(await readdir(f.args.directories.analysis), []);
});

test("failed revocation leaves cancellation durable; a later call joins again without rewriting control", async t => {
  const f = await fixture(t); let attempts = 0;
  const manager = await openStandingHistoryTaskManager({ ...f.args, async onCancelled(value) { f.calls.push(value); if (++attempts === 1) throw Error("synthetic callback failure"); } }); t.after(() => manager.close());
  const initial = await create(manager); await assert.rejects(manager.cancel(actor(initial.taskRef)));
  const afterFailure = await manager.status(actor(initial.taskRef)); assert.equal(afterFailure.control.state, "cancelled");
  const before = await files(slot(f, "control", initial.taskRef)), result = await manager.cancel(actor(initial.taskRef));
  assert.equal(result.revocationJoined, true); assert.equal(attempts, 2); assert.deepEqual(await files(slot(f, "control", initial.taskRef)), before);
  await manager.close(); const again = await opened(f, t); assert.equal((await again.status(actor(initial.taskRef))).control.state, "cancelled");
});

test("custody changes during a joined cancellation callback refuse success and preserve durable cancellation", async t => {
  const f = await fixture(t); let joined = false, cancelledBytes: Buffer | undefined;
  const manager = await openStandingHistoryTaskManager({ ...f.args, async onCancelled(value) {
    const directory = slot(f, "control", value.taskRef);
    cancelledBytes = await readFile(join(directory, "cancel-000001.enc"));
    await writeFile(join(directory, "retained-unknown.bin"), "Unexpected control custody change during callback");
    joined = true;
  } }); t.after(() => manager.close());
  const initial = await create(manager); await assert.rejects(manager.cancel(actor(initial.taskRef)));
  assert.equal(joined, true); assert.ok(cancelledBytes);
  const directory = slot(f, "control", initial.taskRef);
  assert.deepEqual(await readFile(join(directory, "cancel-000001.enc")), cancelledBytes);
  assert.equal(await readFile(join(directory, "retained-unknown.bin"), "utf8"), "Unexpected control custody change during callback");
  const status = await manager.status(actor(initial.taskRef));
  assert.equal(status.control.storage, "tail-refused"); assert.equal(status.control.state, "cancelled"); assert.equal(status.control.revision, 1);
  await manager.close(); const again = await opened(f, t);
  assert.equal((await again.status(actor(initial.taskRef))).control.storage, "tail-refused");
});

test("manager parent roots must be distinct existing protected paths and opening creates no task", async t => {
  const f = await fixture(t);
  await assert.rejects(openStandingHistoryTaskManager({ ...f.args, directories: { ...f.args.directories, pages: f.args.directories.control } }));
  await assert.rejects(openStandingHistoryTaskManager({ ...f.args, directories: { ...f.args.directories, analysis: join(f.root, "does-not-exist") } }));
  await assert.rejects(openStandingHistoryTaskManager({ ...f.args, directories: { ...f.args.directories, analysis: "relative" } }));
  const manager = await opened(f, t); assert.deepEqual(await allFiles(f), [[], [], []]); await manager.close();
});

test("factory/create/status/cancel reject getter and proxy arguments without executing them", async t => {
  const f = await fixture(t); let calls = 0;
  for (const args of [{ ...f.args, get binding() { calls++; return f.args.binding; } },
    new Proxy(f.args, { getPrototypeOf() { calls++; throw Error("trap"); } }),
    { ...f.args, directories: { ...f.args.directories, get pages() { calls++; return f.args.directories.pages; } } }])
    await assert.rejects(openStandingHistoryTaskManager(args));
  const manager = await opened(f, t);
  for (const args of [{ primary: primary(), get request() { calls++; return request(); } },
    { primary: { ...primary(), get ownerId() { calls++; return "456"; } }, request: request() },
    new Proxy({ primary: primary(), request: request() }, { ownKeys() { calls++; throw Error("trap"); } })]) await assert.rejects(manager.create(args));
  for (const method of [manager.status, manager.cancel]) {
    await assert.rejects(method({ taskRef: "htask_" + "f".repeat(48), get requesterId() { calls++; return "456"; } }));
    await assert.rejects(method(new Proxy(actor("htask_" + "f".repeat(48)), { ownKeys() { calls++; throw Error("trap"); } })));
  }
  assert.equal(calls, 0); assert.deepEqual(await allFiles(f), [[], [], []]); assert.deepEqual(f.calls, []);
});

test("factory and create snapshot binding, directories, primary and request before awaiting", async t => {
  const f = await fixture(t), binding = { ...f.args.binding }, directories = { ...f.args.directories };
  const opening = openStandingHistoryTaskManager({ ...f.args, binding, directories });
  binding.peerId = "-100999"; directories.pages = directories.analysis;
  const manager = await opening; t.after(() => manager.close());
  const p = primary(), r = request(), pending = manager.create({ primary: p, request: r });
  p.ownerId = "457"; p.messageId = 1001; r.objective = "Changed after invocation";
  const created = await pending, original = await create(manager); assert.equal(created.taskRef, original.taskRef);
  assert.deepEqual(await manager.status(actor(created.taskRef)), original); assert.equal((await readdir(f.args.directories.control)).length, 1);
});

test("preaborted operations create nothing; close and per-call abort join a pending revocation", async t => {
  const f = await fixture(t), aborted = new AbortController(); aborted.abort();
  await assert.rejects(openStandingHistoryTaskManager({ ...f.args, signal: aborted.signal }));
  const manager = await opened(f, t); await assert.rejects(manager.create({ primary: primary(), request: request(), signal: aborted.signal }));
  assert.deepEqual(await allFiles(f), [[], [], []]);
  for (const stop of ["close", "call-abort"] as const) {
    const g = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
    const current = await openStandingHistoryTaskManager({ ...g.args, async onCancelled() { entered.resolve(); await release.promise; } }); t.after(() => current.close());
    const initial = await create(current); let settled = false;
    const pending = current.cancel({ ...actor(initial.taskRef), signal: controller.signal }).then(value => { settled = true; return value; }, () => { settled = true; return undefined; });
    await entered.promise;
    if (stop === "call-abort") {
      controller.abort(); await immediate(); assert.equal(settled, false);
      release.resolve(); assert.equal(await pending, undefined);
      // A per-call abort joins that operation and preserves independent future reads.
      assert.equal((await current.status(actor(initial.taskRef))).control.state, "cancelled"); await current.close();
    } else {
      let closed = false; const closing = current.close().then(() => { closed = true; }); await immediate(); assert.equal(closed, false); assert.equal(settled, false);
      release.resolve(); await closing; await pending;
    }
    await assert.rejects(current.status(actor(initial.taskRef)));
    const again = await opened(g, t); assert.equal((await again.status(actor(initial.taskRef))).control.state, "cancelled");
  }
});
