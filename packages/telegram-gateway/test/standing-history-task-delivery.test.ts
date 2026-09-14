import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash, createHmac, scryptSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createHook } from "node:async_hooks";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner, type StandingHistoryAnalysisPlan } from "../src/standing-history-analysis-planner.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { runStandingHistoryTaskDelivery, readStandingHistoryTaskDelivery, prepareStandingHistoryTaskDeliveryText } from "../src/standing-history-task-delivery.js";
import { decryptSession } from "../src/session-crypto.js";
import { PilotPreDispatchError, type PilotRecord, type PilotSend } from "../src/pilot-outbox.js";
import type { StandingTaskReplyLease } from "../src/standing-conversation-adapter.js";
import type { StandingOwnActionCaptureEvent } from "../src/standing-own-action-capture.js";

type Ready = Extract<StandingHistoryAnalysisPlan, { kind: "analysis-ready" }>;
const nativeBinding: StandingHistoryAnalysisNativeBinding = { epochId: "a".repeat(32), requestRef: "delivery-analysis", purpose: "history-analysis" };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, outcome: "observed" | "unknown" | "refused" = "observed", objective = "Summarize synthetic source") {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-task-delivery-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-task-delivery-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts"), delivery: join(root, "delivery") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "7".repeat(48), accountId: "123", chatId: "-100456", requesterId: "456", primaryMessageId: 999,
    fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective };
  const passphrase = "synthetic-task-delivery-passphrase", binding = { intent, passphrase }, controller = new AbortController();
  const source = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "create" });
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: directories.control, mode: "create" });
  const analysis = await openStandingHistoryAnalysisStore({ ...binding, directory: directories.analysis, mode: "create", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: directories.attempts, mode: "create", analysis });
  const before = (await source.status()).readProgress.checkpoint, ref = "m_" + "1".repeat(24);
  const after = { ...before, offsetId: 998, lastDate: 1500, oldestDate: 1500, newestDate: 1500, upperBoundMessageId: 998, pages: 1, status: "lower-bound-reached" as const };
  await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: after,
    sources: [{ messageId: 998, date: 1500, disposition: "included", messageRef: ref, authorId: "456" }], page: {
      schema: "neurobro-self-history-v1", fromDate: 1000, toDate: 2000,
      messages: [{ ref, authorRef: "a_" + "2".repeat(24), author: "user", displayName: "Synthetic speaker", date: 1500, editedAt: null, replyRef: null, replyUnavailable: false, text: "Private source from disk" }],
      cursor: null, hasMore: false, status: "lower-bound-reached", coverage: { scope: "available-history-snapshot", oldestExaminedDate: 1500, newestExaminedDate: 1500, traversalComplete: true, undatedEntries: 0, pages: 1 },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } } });
  const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis });
  async function selected() { for (let i = 0; i < 20; i++) { const result = await planner.next(); if (result.kind !== "scan-more") return result; } throw Error("fixture planner did not finish"); }
  const plan = await selected(); assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") throw Error("expected leaf");
  const material = prepareStandingHistoryAnalysisMaterial(plan);
  const reservation = await attempts.reserve({ plan: { kind: "leaf", sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, nodeIndex: 1, inputs: plan.inputs, modelInputHash: material.modelInputHash }, nativeBinding });
  await attempts.prepare({ attemptRef: reservation.attemptRef, output: { summary: "Private root summary", claims: [] } });
  const node = await attempts.commitPrepared({ attemptRef: reservation.attemptRef });
  await attempts.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome });
  const readiness = await selected(); assert.equal(readiness.kind, "analysis-ready"); if (readiness.kind !== "analysis-ready") throw Error("expected ready");
  await planner.close(); await attempts.close(); await analysis.close(); await source.close(); await control.close();
  const proofs: StandingHistoryAnalysisNativeBinding[] = [];
  const args = { ...binding, directories, readiness, signal: controller.signal, async verifyOwnerReady(value: StandingHistoryAnalysisNativeBinding) {
    proofs.push(value); return { schema: "standing-analysis-owner-ready-v1" as const, nativeBinding: value, basis: "persisted-owner-settlement" as const, modelOutcome: "not-proven" as const };
  } };
  const slot = join(directories.delivery, intent.taskId);
  const inspect = () => readStandingHistoryTaskDelivery({ directory: directories.delivery, ...binding });
  return { root, binding, directories, controller, readiness, node, proofs, args, slot, inspect };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function pilot(f: Fixture, name: string, partIndex?: number): Promise<PilotRecord> {
  const directory = partIndex === undefined ? f.slot : join(f.slot, `part-${String(partIndex).padStart(2, "0")}`);
  const envelope = JSON.parse(await readFile(join(directory, "pilot", name + ".enc"), "utf8"));
  let phrase = f.binding.passphrase;
  if (partIndex !== undefined) {
    const wrapper = JSON.parse(await decryptSession(await readFile(join(f.slot, "descriptor.enc"), "utf8"), f.binding.passphrase));
    phrase = createHmac("sha256", phrase).update(JSON.stringify(["DecadansNeurobro/standing-history-task-delivery/pilot-part/v2", f.binding.intent.taskId, digest(canonical(wrapper.descriptor)), partIndex])).digest("hex");
  }
  const key = scryptSync(phrase, Buffer.from(envelope.salt, "base64"), 32);
  try { const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from("DecadansNeurobro/pilot-outbox/v1")); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  } finally { key.fill(0); }
}
function ticket(f: Fixture, mode: "verified" | "unknown" | "blocked" | "pre-dispatch" = "verified", partIndex?: number) {
  const counts = { opens: 0, sends: 0, reads: 0, closes: 0 }, entered = deferred(), release = deferred(), sendDone = deferred();
  let sent: PilotSend;
  const value = { openTaskReply(input: { intent: StandingHistoryTaskIntent; signal: AbortSignal }): StandingTaskReplyLease {
    counts.opens++; assert.deepEqual(input.intent, f.binding.intent);
    return { transport: { async sendOnce(reply) {
      counts.sends++; sent = reply; entered.resolve();
      try { const record = await pilot(f, "sending", partIndex); assert.equal(record.state, "sending"); assert.equal(record.randomId, reply.randomId); assert.equal(record.contentHash, digest(reply.text));
        if (mode === "blocked") await release.promise;
        if (mode === "pre-dispatch") throw new PilotPreDispatchError();
        if (mode !== "verified") throw Error("synthetic send outcome unknown");
        return { messageId: 2001 };
      } finally { sendDone.resolve(); }
    }, async readExact(chatId, messageId) { counts.reads++; assert.equal(chatId, f.binding.intent.chatId); assert.equal(messageId, 2001);
      return { chatId, messageId, accountId: f.binding.intent.accountId, replyToMessageId: sent.replyToMessageId, text: sent.text };
    } }, async close() { counts.closes++; if (counts.sends) await sendDone.promise; } };
  } };
  return { value, counts, entered, release, get sent() { return sent; } };
}

test("real delivery persists exact root descriptor and encrypted verified pilot evidence, then refuses replay on restart", async t => {
  const f = await fixture(t), transport = ticket(f);
  assert.deepEqual(await f.inspect(), { storage: "absent", consumed: false, delivery: "not-attempted" });
  assert.deepEqual(await readdir(f.directories.delivery), []);
  const delivered = await runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value });
  assert.equal(delivered.result.state, "verified"); assert.equal(delivered.leaseJoined, true);
  assert.equal(delivered.descriptor.rootRef, f.node.nodeRef); assert.equal(delivered.descriptor.rootHash, f.node.hash);
  assert.equal(delivered.descriptor.body, "Private root summary"); assert.equal(delivered.descriptor.text, transport.sent.text);
  assert.deepEqual(delivered.descriptor.coverage, f.readiness.coverage); assert.deepEqual(delivered.descriptor.gaps, f.readiness.gaps);
  assert.equal(transport.sent.replyToMessageId, f.binding.intent.primaryMessageId);
  assert.deepEqual(transport.counts, { opens: 1, sends: 1, reads: 1, closes: 1 }); assert.deepEqual(f.proofs, [nativeBinding]);
  const terminal = await pilot(f, "terminal"); assert.equal(terminal.state, "verified"); assert.equal(terminal.messageId, 2001);
  assert.equal(terminal.contentHash, delivered.descriptor.textHash); assert.equal(terminal.textBytes, Buffer.byteLength(transport.sent.text));
  for (const name of ["descriptor.enc", "result.enc"]) {
    const ciphertext = await readFile(join(f.slot, name), "utf8"); assert.equal(ciphertext.includes("Private root summary"), false);
    const plaintext = await decryptSession(ciphertext, f.binding.passphrase); assert.equal(typeof JSON.parse(plaintext), "object");
  }
  const status = await f.inspect(); assert.equal(status.storage, "ready"); assert.equal(status.consumed, true); assert.equal(status.delivery, "verified"); assert.equal(status.leaseJoined, true);
  assert.deepEqual(status.descriptor, delivered.descriptor); assert.deepEqual(status.result, delivered.result);
  const bytes = await readFile(join(f.slot, "pilot", "terminal.enc"));
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value }));
  assert.equal(transport.counts.opens, 1); assert.deepEqual(await readFile(join(f.slot, "pilot", "terminal.enc")), bytes);
});

test("typed pre-dispatch refusal survives actual delivery result reopen and stays consumed", async t => {
  const f = await fixture(t), transport = ticket(f, "pre-dispatch");
  const delivered = await runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value });
  assert.deepEqual(delivered.result, { state: "failed_terminal", code: "pre-dispatch-refused", deliveryDiagnostic: "pre-dispatch-refused" });
  assert.equal(delivered.leaseJoined, true);
  const status = await f.inspect();
  assert.equal(status.delivery, "failed-terminal"); assert.equal(status.consumed, true);
  assert.deepEqual(status.result, delivered.result);
  assert.equal((await pilot(f, "terminal")).state, "failed_terminal");
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value }));
  assert.deepEqual(transport.counts, { opens: 1, sends: 1, reads: 0, closes: 1 });
});

test("whole host body plus deterministic footer is bounded without truncation", async t => {
  const f = await fixture(t), body = "Полный текст отчёта";
  const prepared = prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body });
  assert.ok(prepared.text.startsWith(body)); assert.equal(prepared.textHash, digest(prepared.text));
  assert.deepEqual(prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body }), prepared);
  const footerBytes = Buffer.byteLength(prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body: "x" }).text) - 1;
  const exact = "x".repeat(4096 - footerBytes);
  const combined = prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body: exact });
  assert.equal(Buffer.byteLength(combined.text), 4096); assert.deepEqual(combined.parts, [{ index: 1, kind: "combined", text: combined.text, textHash: combined.textHash }]);
  const split = prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body: exact + "x" });
  assert.equal(split.parts.length, 2); assert.equal(split.parts[0]!.text, exact + "x"); assert.equal(split.parts[0]!.kind, "body"); assert.equal(split.parts[1]!.kind, "coverage");
  assert.equal(split.text, split.parts[0]!.text + "\n\n" + split.parts[1]!.text);
  assert.ok(split.parts.every(part => Buffer.byteLength(part.text) <= 4096 && digest(part.text) === part.textHash));
  assert.throws(() => prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body: "x".repeat(4097) }));
  assert.throws(() => prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body: "я".repeat(4096) }));
  const transport = ticket(f), result = await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: transport.value });
  assert.equal(result.descriptor.body, body); assert.equal(transport.sent.text, prepared.text);
});

test("empty and partial fixed task slots are permanently consumed without opening transport", async t => {
  for (const state of ["empty", "partial"] as const) {
    const f = await fixture(t), transport = ticket(f); await mkdir(f.slot);
    if (state === "partial") await writeFile(join(f.slot, "descriptor.enc"), "retained partial descriptor");
    const status = await f.inspect(); assert.equal(status.consumed, true); assert.notEqual(status.delivery, "verified");
    await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value })); assert.equal(transport.counts.opens, 0);
    if (state === "partial") assert.equal(await readFile(join(f.slot, "descriptor.enc"), "utf8"), "retained partial descriptor");
    else assert.deepEqual(await readdir(f.slot), []);
  }
});

test("UNKNOWN send remains consumed across fresh status and a second delivery call", async t => {
  const events: StandingOwnActionCaptureEvent[] = [], onOwnAction = (event: StandingOwnActionCaptureEvent) => { events.push(event); };
  const f = await fixture(t), transport = ticket(f, "unknown"), result = await runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, onOwnAction });
  assert.equal(result.result.state, "unknown"); assert.equal(result.leaseJoined, true); assert.equal((await pilot(f, "terminal")).state, "unknown");
  assert.equal(events.length, 1); const event = events[0]!; assert.equal(event.source.family, "pilot");
  if (event.source.family !== "pilot") throw Error("expected pilot capture");
  assert.deepEqual(event.source.record, await pilot(f, "terminal")); assert.equal(event.source.record.state, "unknown");
  assert.equal(event.source.reply?.text, transport.sent.text);
  assert.equal(event.slot, digest(JSON.stringify(["DecadansNeurobro/own-pilot-source/v1", event.source.record.idempotencyKey, event.source.record.randomId])));
  assert.equal((await f.inspect()).delivery, "unknown");
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, onOwnAction })); assert.equal(events.length, 1);
  assert.deepEqual(transport.counts, { opens: 1, sends: 1, reads: 0, closes: 1 });
});

test("native UNKNOWN or refused requires persisted settlement rather than a current-owner release", async t => {
  for (const outcome of ["unknown", "refused"] as const) {
    const f = await fixture(t, outcome), transport = ticket(f);
    const verifyOwnerReady = async (binding: StandingHistoryAnalysisNativeBinding) => ({ schema: "standing-analysis-owner-ready-v1" as const, nativeBinding: binding,
      basis: "released-current-owner" as const, modelOutcome: "not-proven" as const });
    await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, verifyOwnerReady }));
    assert.equal(transport.counts.opens, 0); assert.deepEqual(await readdir(f.directories.delivery), []);
    assert.equal((await runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value })).result.state, "verified");
  }
});

test("foreign owner proof, forged readiness heads, and coverage fail before delivery reservation", async t => {
  const f = await fixture(t), transport = ticket(f);
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, async verifyOwnerReady(binding) {
    return { schema: "standing-analysis-owner-ready-v1", nativeBinding: { ...binding, requestRef: "foreign" }, basis: "persisted-owner-settlement", modelOutcome: "not-proven" };
  } }));
  for (const readiness of [{ ...f.readiness, sourceHead: "f".repeat(64) }, { ...f.readiness, expectedHead: "f".repeat(64) },
    { ...f.readiness, rootRef: "hnode_" + "f".repeat(48) }, { ...f.readiness, coverage: { ...f.readiness.coverage, coveredRows: 19 } }]) {
    await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, readiness, ticket: transport.value }));
  }
  assert.equal(transport.counts.opens, 0); assert.deepEqual(await readdir(f.directories.delivery), []);
});

test("fresh persistent cancellation during owner proof prevents transport admission", async t => {
  const f = await fixture(t), transport = ticket(f);
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, async verifyOwnerReady(binding) {
    const control = await openStandingHistoryTaskControlStore({ ...f.binding, directory: f.directories.control, mode: "open" });
    try { await control.cancel({ expectedRevision: 0 }); } finally { await control.close(); }
    return f.args.verifyOwnerReady(binding);
  } }));
  assert.equal(f.controller.signal.aborted, false); assert.equal(transport.counts.sends, 0);
});

test("aborted send cannot report leaseJoined until the actual outstanding send settles", async t => {
  const f = await fixture(t), transport = ticket(f, "blocked"); let settled = false;
  const pending = runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value }).then(value => { settled = true; return value; });
  await transport.entered.promise; f.controller.abort(); await immediate(); assert.equal(settled, false);
  transport.release.resolve(); const result = await pending;
  assert.equal(result.leaseJoined, true); assert.equal(result.result.state, "unknown");
  assert.deepEqual(transport.counts, { opens: 1, sends: 1, reads: 0, closes: 1 }); assert.equal((await f.inspect()).delivery, "unknown");
});

test("getter and proxy inputs refuse without invocation, slot creation, or transport admission", async t => {
  const f = await fixture(t), transport = ticket(f); let invoked = 0;
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, get body() { invoked++; return "bad"; } }));
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: new Proxy(transport.value, { getOwnPropertyDescriptor() { invoked++; throw Error("trap"); } }) }));
  assert.throws(() => prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, get body() { invoked++; return "bad"; } }));
  assert.equal(invoked, 0); assert.equal(transport.counts.opens, 0); assert.deepEqual(await readdir(f.directories.delivery), []);
});

test("invalid capture callbacks refuse before crypto, owner verification, or transport IO", async t => {
  const f = await fixture(t), transport = ticket(f); let invoked = 0, cryptoRequests = 0;
  const hook = createHook({ init(_id, type) { if (type === "SCRYPTREQUEST") cryptoRequests++; } });
  hook.enable();
  try {
    for (const onOwnAction of [async () => { invoked++; }, function* () { invoked++; },
      new Proxy(() => { invoked++; }, { apply() { invoked++; }, get() { invoked++; throw Error("trap"); } })]) {
      await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, onOwnAction }), /INPUT/);
    }
    await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, get onOwnAction() { invoked++; return () => {}; } }), /INPUT/);
  } finally { hook.disable(); }
  assert.equal(invoked, 0); assert.equal(cryptoRequests, 0); assert.deepEqual(f.proofs, []);
  assert.deepEqual(transport.counts, { opens: 0, sends: 0, reads: 0, closes: 0 }); assert.deepEqual(await readdir(f.directories.delivery), []);
});

test("terminal persistence collision and post-write readback substitution never emit a capture", async t => {
  for (const fault of ["persist", "readback"] as const) {
    const f = await fixture(t), transport = ticket(f), events: StandingOwnActionCaptureEvent[] = [];
    const path = join(f.slot, "pilot", "terminal.enc"); let changed = false;
    const hook = createHook({ init(_id, type) {
      if (fault === "readback" && !changed && type === "SCRYPTREQUEST" && existsSync(path)) {
        changed = true; writeFileSync(path, "retained terminal substitution");
      }
    } });
    const value = { openTaskReply(input: Parameters<typeof transport.value.openTaskReply>[0]) {
      const lease = transport.value.openTaskReply(input);
      return { ...lease, transport: { ...lease.transport, async readExact(...args: Parameters<typeof lease.transport.readExact>) {
        const reply = await lease.transport.readExact(...args);
        if (fault === "persist") { await writeFile(path, "retained terminal substitution"); changed = true; }
        else hook.enable();
        return reply;
      } } };
    } };
    try { await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: value, onOwnAction(event) { events.push(event); } })); }
    finally { hook.disable(); }
    assert.equal(changed, true); assert.equal(events.length, 0); assert.equal(await readFile(path, "utf8"), "retained terminal substitution");
    assert.deepEqual(transport.counts, { opens: 1, sends: 1, reads: 1, closes: 1 });
    assert.notEqual((await f.inspect()).delivery, "verified");
    await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: value, onOwnAction(event) { events.push(event); } }));
    assert.deepEqual(events, []); assert.equal(transport.counts.opens, 1);
  }
});

test("fresh read authenticates pilot terminal when result receipt is missing but never invents lease join", async t => {
  const f = await fixture(t), transport = ticket(f); await runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value });
  await unlink(join(f.slot, "result.enc"));
  const status = await f.inspect(); assert.equal(status.consumed, true); assert.equal(status.delivery, "verified"); assert.equal(status.leaseJoined, undefined);
  await writeFile(join(f.slot, "pilot", "sending.enc"), "retained corrupt sending chain");
  const corrupt = await f.inspect(); assert.equal(corrupt.consumed, true); assert.notEqual(corrupt.delivery, "verified");
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value })); assert.equal(transport.counts.sends, 1);
});

test("wrong passphrase or same-slot foreign intent cannot authenticate a successful delivery", async t => {
  const f = await fixture(t), transport = ticket(f); await runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value });
  const bytes = await readFile(join(f.slot, "descriptor.enc"));
  for (const binding of [{ ...f.binding, passphrase: "different synthetic passphrase" },
    { ...f.binding, intent: { ...f.binding.intent, objective: "Different task intent" } }]) {
    const status = await readStandingHistoryTaskDelivery({ directory: f.directories.delivery, ...binding });
    assert.equal(status.consumed, true); assert.equal(status.storage, "unavailable"); assert.notEqual(status.delivery, "verified"); assert.equal(status.leaseJoined, undefined);
  }
  assert.deepEqual(await readFile(join(f.slot, "descriptor.enc")), bytes); assert.equal(transport.counts.sends, 1);
});

test("corrupt analysis-attempt tail refuses delivery while preserving the saved root and corrupt bytes", async t => {
  const f = await fixture(t), transport = ticket(f), path = join(f.directories.attempts, f.binding.intent.taskId, "unexpected-tail.enc");
  await writeFile(path, "retained unknown attempt tail");
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value }));
  assert.equal(transport.counts.opens, 0); assert.deepEqual(await readdir(f.directories.delivery), []);
  assert.equal(await readFile(path, "utf8"), "retained unknown attempt tail");
});

test("new corrupt tails introduced during owner verification refuse delivery even when the cached heads match", async t => {
  for (const directory of ["pages", "analysis", "attempts"] as const) {
    const f = await fixture(t), transport = ticket(f), path = join(f.directories[directory], f.binding.intent.taskId, "unexpected-tail.enc");
    await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value, async verifyOwnerReady(binding) {
      await writeFile(path, "retained late corrupt tail"); return f.args.verifyOwnerReady(binding);
    } }));
    assert.equal(transport.counts.opens, 0); assert.equal(transport.counts.sends, 0);
    assert.equal(await readFile(path, "utf8"), "retained late corrupt tail");
  }
});

test("failed lease closure preserves actual verified pilot proof without claiming a joined result receipt", async t => {
  const f = await fixture(t), transport = ticket(f);
  const broken = { openTaskReply(input: { intent: StandingHistoryTaskIntent; signal: AbortSignal }) {
    const lease = transport.value.openTaskReply(input);
    return { transport: lease.transport, async close() { await lease.close(); throw Error("synthetic unproven lease closure"); } };
  } };
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: broken }));
  assert.deepEqual(transport.counts, { opens: 1, sends: 1, reads: 1, closes: 1 });
  assert.equal((await pilot(f, "terminal")).state, "verified"); assert.equal((await readdir(f.slot)).includes("result.enc"), false);
  const status = await f.inspect(); assert.equal(status.delivery, "verified"); assert.equal(status.leaseJoined, undefined);
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: transport.value })); assert.equal(transport.counts.sends, 1);
});

test("descriptor replacement while opening the reply lease prevents send and still closes the borrowed lease", async t => {
  const f = await fixture(t), transport = ticket(f);
  const replacing = { openTaskReply(input: { intent: StandingHistoryTaskIntent; signal: AbortSignal }) {
    writeFileSync(join(f.slot, "descriptor.enc"), "retained replacement descriptor");
    return transport.value.openTaskReply(input);
  } };
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, ticket: replacing }));
  assert.deepEqual(transport.counts, { opens: 1, sends: 0, reads: 0, closes: 1 });
  assert.equal(await readFile(join(f.slot, "descriptor.enc"), "utf8"), "retained replacement descriptor");
  const status = await f.inspect(); assert.equal(status.consumed, true); assert.notEqual(status.delivery, "verified");
});

test("multipart delivery sends one exact part per fresh invocation and becomes verified only after coverage is delivered", async t => {
  const f = await fixture(t), body = "т".repeat(2048), prepared = prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body });
  const events: StandingOwnActionCaptureEvent[] = [], onOwnAction = (event: StandingOwnActionCaptureEvent) => { events.push(event); throw Error("synthetic observer fault"); };
  const first = ticket(f, "verified", 1), one = await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: first.value, onOwnAction });
  assert.equal(one.partIndex, 1); assert.equal(one.partsTotal, 2); assert.equal(one.deliveryComplete, false); assert.equal(one.result.state, "verified");
  assert.equal(first.sent.text, body); assert.equal(Buffer.byteLength(first.sent.text), 4096); assert.equal(first.counts.sends, 1);
  const intermediate = await f.inspect(); assert.equal(intermediate.delivery, "partial"); assert.equal(intermediate.partsTotal, 2); assert.equal(intermediate.verifiedParts, 1); assert.equal(intermediate.nextPart, 2);
  assert.equal(events.length, 1);
  const second = ticket(f, "verified", 2), two = await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: second.value, onOwnAction });
  assert.equal(two.partIndex, 2); assert.equal(two.partsTotal, 2); assert.equal(two.deliveryComplete, true); assert.equal(two.result.state, "verified");
  assert.equal(second.sent.text, prepared.parts[1]!.text); assert.equal(first.sent.text + "\n\n" + second.sent.text, prepared.text);
  assert.equal(first.sent.replyToMessageId, f.binding.intent.primaryMessageId); assert.equal(second.sent.replyToMessageId, f.binding.intent.primaryMessageId);
  assert.deepEqual(two.descriptor, one.descriptor);
  const complete = await f.inspect(); assert.equal(complete.delivery, "verified"); assert.equal(complete.verifiedParts, 2); assert.equal(complete.nextPart, undefined);
  assert.equal(events.length, 2); assert.notEqual(events[0]!.slot, events[1]!.slot);
  for (const [index, event] of events.entries()) {
    assert.equal(event.source.family, "pilot"); if (event.source.family !== "pilot") throw Error("expected pilot capture");
    assert.deepEqual(event.source.record, await pilot(f, "terminal", index + 1)); assert.equal(event.source.record.state, "verified");
    assert.deepEqual(event.source.reply, { chatId: f.binding.intent.chatId, replyToMessageId: f.binding.intent.primaryMessageId, text: prepared.parts[index]!.text });
    assert.equal(event.slot, digest(JSON.stringify(["DecadansNeurobro/own-pilot-source/v1", event.source.record.idempotencyKey, event.source.record.randomId])));
    assert.ok(Object.isFrozen(event)); assert.ok(Object.isFrozen(event.source.record));
  }
  assert.deepEqual(first.counts, { opens: 1, sends: 1, reads: 1, closes: 1 }); assert.deepEqual(second.counts, first.counts);
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, body, ticket: second.value, onOwnAction })); assert.equal(second.counts.sends, 1); assert.equal(events.length, 2);
});

test("multipart continuation refuses a changed whole body and preserves the first part ciphertext", async t => {
  const f = await fixture(t), body = "x".repeat(4096), first = ticket(f, "verified", 1);
  await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: first.value });
  const path = join(f.slot, "part-01", "pilot", "terminal.enc"), before = await readFile(path), second = ticket(f, "verified", 2);
  await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, body: "y".repeat(4096), ticket: second.value }));
  assert.equal(second.counts.opens, 0); assert.deepEqual(await readFile(path), before); assert.equal((await f.inspect()).nextPart, 2);
});

test("empty or UNKNOWN second part halts multipart continuation without resending either part", async t => {
  for (const consumed of ["empty", "unknown"] as const) {
    const f = await fixture(t), body = "x".repeat(4096), first = ticket(f, "verified", 1), second = ticket(f, "unknown", 2);
    await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: first.value });
    if (consumed === "empty") await mkdir(join(f.slot, "part-02"));
    else assert.equal((await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: second.value })).result.state, "unknown");
    const state = await f.inspect(); assert.equal(state.consumed, true); assert.notEqual(state.delivery, "verified"); assert.equal(state.nextPart, undefined);
    const before = { ...second.counts }; await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, body, ticket: second.value }));
    assert.deepEqual(second.counts, before); assert.equal(first.counts.sends, 1);
  }
});

test("authenticated multipart descriptor alone permits the first absent part after restart", async t => {
  const f = await fixture(t), body = "x".repeat(4096), first = ticket(f, "verified", 1);
  await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: first.value });
  // Retain only the real encrypted descriptor to model a crash before any part
  // reservation. This removes only this test's synthetic temporary part image.
  const ownPart = resolve(join(f.slot, "part-01")); assert.equal(ownPart, join(resolve(f.root), "delivery", f.binding.intent.taskId, "part-01"));
  await rm(ownPart, { recursive: true });
  assert.deepEqual(await readdir(f.slot), ["descriptor.enc"]);
  const state = await f.inspect(); assert.equal(state.consumed, true); assert.equal(state.nextPart, 1); assert.equal(state.verifiedParts, 0);
  const restarted = ticket(f, "verified", 1), result = await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: restarted.value });
  assert.equal(result.partIndex, 1); assert.equal(result.deliveryComplete, false); assert.equal(restarted.counts.sends, 1);
});

test("copying valid first-part ciphertext into second-part slots never proves aggregate delivery", async t => {
  const f = await fixture(t), body = "x".repeat(4096), first = ticket(f, "verified", 1);
  await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: first.value });
  const target = join(f.slot, "part-02"); await mkdir(target); await mkdir(join(target, "pilot"));
  for (const name of ["planned.enc", "sending.enc", "terminal.enc"]) await writeFile(join(target, "pilot", name), await readFile(join(f.slot, "part-01", "pilot", name)));
  await writeFile(join(target, "result.enc"), await readFile(join(f.slot, "part-01", "result.enc")));
  const state = await f.inspect(); assert.equal(state.consumed, true); assert.notEqual(state.delivery, "verified"); assert.equal(state.nextPart, undefined);
  const second = ticket(f, "verified", 2); await assert.rejects(runStandingHistoryTaskDelivery({ ...f.args, body, ticket: second.value })); assert.equal(second.counts.opens, 0);
});

test("maximum escaped body and objective survive encrypted multipart storage without cropping", async t => {
  const objective = "\u0002".repeat(4096), body = "\u0001".repeat(4096), f = await fixture(t, "observed", objective), first = ticket(f, "verified", 1);
  const result = await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: first.value });
  assert.equal(first.sent.text, body); assert.equal(result.descriptor.body, body); assert.equal(result.deliveryComplete, false);
  const cipher = await readFile(join(f.slot, "descriptor.enc"), "utf8"), plain = await decryptSession(cipher, f.binding.passphrase), envelope = JSON.parse(plain);
  assert.ok(Buffer.byteLength(plain) <= 65536); assert.ok(Buffer.byteLength(cipher) <= 98304); assert.equal(envelope.intent.objective, objective);
  assert.equal(Object.hasOwn(envelope.descriptor, "body"), false); assert.equal(Object.hasOwn(envelope.descriptor, "text"), false);
  assert.equal(envelope.descriptor.parts[0].text, body); assert.equal((await f.inspect()).descriptor?.body, body);
  const second = ticket(f, "verified", 2), completed = await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: second.value });
  assert.equal(completed.deliveryComplete, true); assert.equal((await f.inspect()).delivery, "verified");
});

test("maximum escaped objective and an exactly fitting combined body remain deliverable without cropping", async t => {
  const objective = "\u0002".repeat(4096), f = await fixture(t, "observed", objective), transport = ticket(f);
  const footerBytes = Buffer.byteLength(prepareStandingHistoryTaskDeliveryText({ intent: f.binding.intent, readiness: f.readiness, body: "x" }).text) - 1;
  const body = "\u0001".repeat(4096 - footerBytes), result = await runStandingHistoryTaskDelivery({ ...f.args, body, ticket: transport.value });
  assert.equal(result.partsTotal, 1); assert.equal(result.deliveryComplete, true); assert.equal(Buffer.byteLength(transport.sent.text), 4096);
  assert.ok(transport.sent.text.startsWith(body)); assert.equal(result.descriptor.body, body);
  const cipher = await readFile(join(f.slot, "descriptor.enc"), "utf8"), plain = await decryptSession(cipher, f.binding.passphrase);
  assert.ok(Buffer.byteLength(plain) > 65536); assert.ok(Buffer.byteLength(plain) <= 81920); assert.ok(Buffer.byteLength(cipher) <= 131072);
  const status = await f.inspect(); assert.equal(status.delivery, "verified"); assert.equal(status.descriptor?.body, body);
});
