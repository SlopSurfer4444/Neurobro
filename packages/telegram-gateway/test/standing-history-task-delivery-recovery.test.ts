import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash, createHmac, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { runStandingHistoryTaskDelivery, readStandingHistoryTaskDelivery, inspectStandingHistoryTaskDeliveryRecovery, recoverStandingHistoryTaskDelivery } from "../src/standing-history-task-delivery.js";
import type { PilotSend, PilotReadback } from "../src/pilot-outbox.js";
import type { StandingTaskReplyLease } from "../src/standing-conversation-adapter.js";
import { decryptSession, encryptSession } from "../src/session-crypto.js";
const nativeBinding: StandingHistoryAnalysisNativeBinding = { epochId: "a".repeat(32), requestRef: "delivery-analysis", purpose: "history-analysis" };
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
  const args = { ...binding, directories, readiness, finalReport: { schema: "standing-history-final-report-v1" as const, taskRef: intent.taskId, sourceHead: readiness.sourceHead, analysisHead: readiness.expectedHead, body: "User-facing report" }, signal: controller.signal, async verifyOwnerReady(value: StandingHistoryAnalysisNativeBinding) {
    proofs.push(value); return { schema: "standing-analysis-owner-ready-v1" as const, nativeBinding: value, basis: "persisted-owner-settlement" as const, modelOutcome: "not-proven" as const };
  } };
  const slot = join(directories.delivery, intent.taskId);
  const inspect = () => readStandingHistoryTaskDelivery({ directory: directories.delivery, ...binding });
  return { root, binding, directories, controller, readiness, node, proofs, args, slot, inspect };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type RecoveryBinding = NonNullable<Awaited<ReturnType<typeof inspectStandingHistoryTaskDeliveryRecovery>>>;
function authorization(binding: RecoveryBinding) {
  return { schema: "standing-history-delivery-recovery-authorization-v1" as const, binding, ownerReceiptHash: "a".repeat(64) };
}
async function inspectRecovery(f: Fixture, partIndex = 1) {
  return inspectStandingHistoryTaskDeliveryRecovery({ directory: f.directories.delivery, ...f.binding, partIndex, signal: f.controller.signal });
}
async function savedFiles(directory: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) for (const [child, bytes] of await savedFiles(path)) entries.set(child, bytes);
    else entries.set(path, await readFile(path));
  }
  return entries;
}
async function assertUnchanged(before: Map<string, Buffer>) {
  for (const [path, bytes] of before) assert.deepEqual(await readFile(path), bytes, path);
}

/** Deterministic provider model: a lost acknowledgement can occur on either
 * side of application. Deduplication is keyed only by the original randomId;
 * generating a fresh ID would create an observable duplicate in these tests. */
function remote(f: Fixture) {
  const messages = new Map<string, PilotReadback>(), requests: PilotSend[] = [];
  const counts = { opens: 0, sends: 0, reads: 0, closes: 0 };
  let sequence = 2000;
  function ticket(mode: "verified" | "applied-lost-ack" | "unapplied-lost-ack" | "readback-mismatch" = "verified", close?: () => Promise<void>, readback?: (message: PilotReadback) => PilotReadback, standalone = false) {
    return { openTaskReply(input: { intent: StandingHistoryTaskIntent; signal: AbortSignal; taskReplyPolicy?: "standalone-if-exact-missing" }): StandingTaskReplyLease {
      counts.opens++; assert.deepEqual(input.intent, f.binding.intent);
      assert.equal(input.taskReplyPolicy, "standalone-if-exact-missing");
      return { transport: {
        async sendOnce(reply) {
          counts.sends++; requests.push({ ...reply });
          if (mode === "unapplied-lost-ack") throw Error("synthetic lost ACK before remote application");
          let message = messages.get(reply.randomId);
          if (message) {
            assert.equal(message.chatId, reply.chatId); assert.equal(message.replyToMessageId, reply.replyToMessageId);
            assert.equal(message.text, reply.text); assert.deepEqual(message.entities, reply.entities);
          } else {
            message = { chatId: reply.chatId, replyToMessageId: standalone ? null : reply.replyToMessageId, text: reply.text,
              ...(standalone ? { taskReplyOriginMessageId: reply.replyToMessageId! } : {}),
              ...(reply.entities ? { entities: reply.entities } : {}), accountId: f.binding.intent.accountId, messageId: ++sequence };
            messages.set(reply.randomId, message);
          }
          if (mode === "applied-lost-ack") throw Error("synthetic lost ACK after remote application");
          return { messageId: message.messageId };
        },
        async readExact(chatId, messageId) {
          counts.reads++;
          const found = [...messages.values()].find(message => message.chatId === chatId && message.messageId === messageId);
          assert.ok(found);
          return readback ? readback(found) : mode === "readback-mismatch" ? { ...found, text: found.text + " altered" } : { ...found };
        },
      }, async close() { counts.closes++; await close?.(); } };
    } };
  }
  return { ticket, messages, requests, counts };
}
async function unknownFixture(t: TestContext, applied = true) {
  const f = await fixture(t), provider = remote(f);
  const args = { ...f.args, finalReport: { ...f.args.finalReport, body: "report paragraph\n".repeat(510) } };
  const original = await runStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(applied ? "applied-lost-ack" : "unapplied-lost-ack") });
  assert.equal(original.result.state, "unknown"); assert.equal(original.leaseJoined, true);
  const before = await savedFiles(f.slot), binding = await inspectRecovery(f);
  assert.ok(binding); assert.equal((await f.inspect()).nextPart, undefined);
  return { f, args, provider, original, before, binding };
}

for (const applied of [true, false]) test(`recovery reuses original randomId when remote ${applied ? "already applied the send" : "never applied the send"}`, async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t, applied);
  await assert.rejects(runStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket() }), /CONSUMED/);
  assert.equal(provider.counts.sends, 1);
  const recovered = await recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(binding) });
  assert.equal(recovered.result.state, "verified"); assert.equal(recovered.leaseJoined, true);
  assert.equal(provider.counts.sends, 2); assert.equal(provider.messages.size, 1);
  assert.deepEqual(provider.requests[1], provider.requests[0]);
  await assertUnchanged(before);
  const status = await f.inspect(); assert.equal(status.verifiedParts, 1); assert.equal(status.nextPart, 2);
  const opens = provider.counts.opens;
  await assert.rejects(recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(binding) }));
  assert.equal(provider.counts.opens, opens); assert.equal(provider.counts.sends, 2);
  const { finalReport: _report, ...resume } = args;
  for (let part = 2; part <= originalPartCount(status); part++) {
    const sent = await runStandingHistoryTaskDelivery({ ...resume, ticket: provider.ticket() });
    assert.equal(sent.partIndex, part); assert.equal(sent.result.state, "verified");
    assert.equal(sent.deliveryComplete, part === originalPartCount(status));
  }
  assert.equal((await f.inspect()).delivery, "verified");
  assert.equal(provider.messages.size, originalPartCount(status));
  assert.equal(provider.requests.filter(request => request.randomId === provider.requests[0]!.randomId).length, 2);
  await assertUnchanged(before);
});
function originalPartCount(status: Awaited<ReturnType<typeof readStandingHistoryTaskDelivery>>) {
  assert.ok(status.partsTotal && status.partsTotal > 2); return status.partsTotal;
}

for (const mode of ["unapplied-lost-ack", "readback-mismatch"] as const) test(`recovery ${mode} consumes its generation and keeps later parts blocked`, async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t);
  const result = await recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(mode), maintenance: authorization(binding) });
  assert.equal(result.result.state, "unknown"); assert.equal(result.leaseJoined, true);
  const status = await f.inspect(); assert.equal(status.nextPart, undefined); assert.notEqual(status.delivery, "verified");
  const opens = provider.counts.opens;
  await assert.rejects(recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(binding) }));
  await assert.rejects(runStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket() }));
  assert.equal(provider.counts.opens, opens); assert.equal(provider.counts.sends, 2);
  assert.equal(existsSync(join(f.slot, "part-02")), false); await assertUnchanged(before);
});

test("a precreated recovery generation refuses dispatch at empty, intent-only, and dispatched crash frontiers", async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t);
  const directory = join(f.slot, "part-01", "recovery-v1"), domain = "DecadansNeurobro/standing-history-task-delivery-recovery/v1";
  await mkdir(directory);
  const intent = { domain, kind: "intent", binding, ownerReceiptHash: "a".repeat(64), taskReplyPolicy: "standalone-if-exact-missing" };
  const intentHash = createHash("sha256").update(canonical(intent)).digest("hex");
  for (const frontier of ["empty", "intent-only", "dispatched"] as const) {
    if (frontier === "intent-only") await writeFile(join(directory, "intent.enc"), await encryptSession(canonical(intent), recoveryPhrase(f, binding)));
    if (frontier === "dispatched") await writeFile(join(directory, "dispatch.enc"), await encryptSession(canonical({ domain, kind: "dispatch", intentHash }), recoveryPhrase(f, binding)));
    const cold = await f.inspect(); assert.equal(cold.storage, "ready", frontier); assert.equal(cold.nextPart, undefined, frontier);
    await assert.rejects(recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(binding) }));
    assert.equal(provider.counts.sends, 1, frontier); assert.equal(provider.counts.opens, 1, frontier); await assertUnchanged(before);
  }
});

test("owner authorization and exact task, source, anchor, part bindings reject before opening lease", async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t);
  const maintenance = authorization(binding);
  const hostileInputs = [
    { ...args, readiness: { ...args.readiness, sourceHead: "0".repeat(64) }, maintenance },
    { ...args, intent: { ...args.intent, primaryMessageId: args.intent.primaryMessageId + 1 }, maintenance },
    { ...args, intent: { ...args.intent, accountId: "321" }, maintenance },
    { ...args, intent: { ...args.intent, chatId: "-100654" }, maintenance },
    { ...args, maintenance: { ...maintenance, ownerReceiptHash: "not-a-receipt" } },
    { ...args, maintenance: { ...maintenance, binding: { ...binding, partIndex: 2 } } },
  ];
  for (const input of hostileInputs) await assert.rejects(recoverStandingHistoryTaskDelivery({ ...input, ticket: provider.ticket() }));
  assert.equal(provider.counts.sends, 1); assert.equal(provider.counts.opens, 1);
  assert.equal(existsSync(join(f.slot, "part-01", "recovery-v1")), false); await assertUnchanged(before);
});

test("tampered original UNKNOWN ciphertext cannot authorize recovery", async t => {
  const { f, args, provider, binding } = await unknownFixture(t);
  const path = join(f.slot, "part-01", "pilot", "terminal.enc");
  const old = await readFile(path); await writeFile(path, Buffer.concat([old, Buffer.from("x")]));
  await assert.rejects(recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(binding) }));
  assert.equal(provider.counts.sends, 1); assert.equal(provider.counts.opens, 1);
  assert.equal((await f.inspect()).nextPart, undefined);
});

test("verified readback cannot unlock next part until lease close joins", async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t);
  const closing = deferred(), release = deferred();
  const pending = recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket("verified", async () => { closing.resolve(); await release.promise; }), maintenance: authorization(binding) });
  await closing.promise;
  try {
    assert.equal((await f.inspect()).nextPart, undefined);
    assert.equal(existsSync(join(f.slot, "part-02")), false);
  } finally { release.resolve(); }
  const done = await pending; assert.equal(done.leaseJoined, true);
  assert.equal((await f.inspect()).nextPart, 2); await assertUnchanged(before);
});

test("failed lease close preserves consumed generation without a verified prefix", async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t);
  await assert.rejects(recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket("verified", async () => { throw Error("synthetic close failure"); }), maintenance: authorization(binding) }));
  assert.equal((await f.inspect()).nextPart, undefined);
  const opens = provider.counts.opens;
  await assert.rejects(recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(binding) }));
  assert.equal(provider.counts.opens, opens); assert.equal(provider.counts.sends, 2); await assertUnchanged(before);
});

test("competing recovery calls admit at most one original-ID send", async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t);
  const recovered = await Promise.allSettled([
    recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(binding) }),
    recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(binding) }),
  ]);
  assert.equal(recovered.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(recovered.filter(result => result.status === "rejected").length, 1);
  assert.equal(provider.counts.sends, 2); assert.equal(provider.messages.size, 1);
  assert.equal((await f.inspect()).nextPart, 2); await assertUnchanged(before);
});

test("nested accessor tripwires in authorization or readback are never evaluated", async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t);
  let evaluated = 0;
  const nested = { get tripwire() { evaluated++; throw Error("untrusted accessor executed"); } };
  const hostile = { ...binding, randomId: nested as unknown as string };
  await assert.rejects(recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket(), maintenance: authorization(hostile) }));
  assert.equal(evaluated, 0); assert.equal(provider.counts.opens, 1); assert.equal(provider.counts.sends, 1);
  assert.equal(existsSync(join(f.slot, "part-01", "recovery-v1")), false);
  const result = await recoverStandingHistoryTaskDelivery({ ...args,
    ticket: provider.ticket("verified", undefined, message => ({ ...message, accountId: nested as unknown as string })), maintenance: authorization(binding) });
  assert.equal(result.result.state, "unknown"); assert.equal(evaluated, 0);
  assert.equal((await f.inspect()).nextPart, undefined); await assertUnchanged(before);
});

function recoveryPhrase(f: Fixture, binding: RecoveryBinding) {
  return createHmac("sha256", f.binding.passphrase)
    .update(JSON.stringify(["DecadansNeurobro/standing-history-task-delivery/pilot-part/v2", f.binding.intent.taskId, binding.descriptorHash, binding.partIndex])).digest("hex");
}
async function recoveryReceipt(f: Fixture, binding: RecoveryBinding) {
  return JSON.parse(await decryptSession(await readFile(join(f.slot, "part-01", "recovery-v1", "result.enc"), "utf8"), recoveryPhrase(f, binding))) as Record<string, unknown>;
}

test("missing-anchor fallback verifies actual null wire anchor, preserves original binding, and resumes later parts", async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t, false);
  const originalRandomId = provider.requests[0]!.randomId;
  const result = await recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket("verified", undefined, undefined, true), maintenance: authorization(binding) });
  assert.equal(result.result.state, "verified"); assert.equal(result.leaseJoined, true);
  assert.deepEqual(provider.requests[1], provider.requests[0]); assert.equal(binding.randomId, originalRandomId);
  const actual = provider.messages.get(originalRandomId)!;
  assert.equal(actual.replyToMessageId, null); assert.equal(actual.taskReplyOriginMessageId, binding.replyToMessageId);
  const receipt = await recoveryReceipt(f, binding);
  assert.equal(receipt.state, "verified"); assert.equal(receipt.wireReplyToMessageId, null);
  const reopened = await f.inspect(); assert.equal(reopened.verifiedParts, 1); assert.equal(reopened.nextPart, 2);
  const { finalReport: _report, ...resume } = args;
  const next = await runStandingHistoryTaskDelivery({ ...resume, ticket: provider.ticket("verified", undefined, undefined, true) });
  assert.equal(next.partIndex, 2); assert.equal(next.result.state, "verified");
  assert.equal((await f.inspect()).verifiedParts, 2); await assertUnchanged(before);
});

for (const corruption of ["missing-origin", "wrong-origin", "wrong-nonnull-anchor"] as const) test(`missing-anchor fallback ${corruption} cannot verify or unlock continuation`, async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t, false);
  const readback = (message: PilotReadback): PilotReadback => {
    if (corruption === "wrong-origin") return { ...message, taskReplyOriginMessageId: binding.replyToMessageId + 1 };
    if (corruption === "wrong-nonnull-anchor") return { ...message, replyToMessageId: binding.replyToMessageId + 1 };
    const { taskReplyOriginMessageId: _origin, ...rest } = message; return rest;
  };
  const result = await recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket("verified", undefined, readback, true), maintenance: authorization(binding) });
  assert.equal(result.result.state, "unknown"); assert.equal(result.leaseJoined, true);
  assert.equal((await f.inspect()).nextPart, undefined);
  const receipt = await recoveryReceipt(f, binding); assert.equal(receipt.state, "unknown");
  assert.equal(Object.hasOwn(receipt, "wireReplyToMessageId"), false);
  await assertUnchanged(before);
});

test("missing-anchor fallback policy still accepts deduplicated original anchored message", async t => {
  const { f, args, provider, before, binding } = await unknownFixture(t, true);
  const result = await recoverStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket("verified", undefined, undefined, true), maintenance: authorization(binding) });
  assert.equal(result.result.state, "verified"); assert.equal(provider.messages.size, 1);
  assert.deepEqual(provider.requests[1], provider.requests[0]);
  const original = provider.messages.get(binding.randomId)!;
  assert.equal(original.replyToMessageId, binding.replyToMessageId); assert.equal(original.taskReplyOriginMessageId, undefined);
  const receipt = await recoveryReceipt(f, binding); assert.equal(Object.hasOwn(receipt, "wireReplyToMessageId"), false);
  assert.equal((await f.inspect()).nextPart, 2); await assertUnchanged(before);
});

test("ordinary background delivery persists null wire anchor in verified pilot and advances its multipart prefix", async t => {
  const f = await fixture(t), provider = remote(f);
  const args = { ...f.args, finalReport: { ...f.args.finalReport, body: "ordinary report\n".repeat(550) } };
  const delivered = await runStandingHistoryTaskDelivery({ ...args, ticket: provider.ticket("verified", undefined, undefined, true) });
  assert.equal(delivered.result.state, "verified"); assert.equal(delivered.leaseJoined, true);
  const wrapper = JSON.parse(await decryptSession(await readFile(join(f.slot, "descriptor.enc"), "utf8"), f.binding.passphrase));
  const hash = createHash("sha256").update(canonical(wrapper.descriptor)).digest("hex");
  const phrase = createHmac("sha256", f.binding.passphrase)
    .update(JSON.stringify(["DecadansNeurobro/standing-history-task-delivery/pilot-part/v2", f.binding.intent.taskId, hash, 1])).digest("hex");
  const envelope = JSON.parse(await readFile(join(f.slot, "part-01", "pilot", "terminal.enc"), "utf8"));
  const key = scryptSync(phrase, Buffer.from(envelope.salt, "base64"), 32);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from("DecadansNeurobro/pilot-outbox/v1")); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const terminal = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
    assert.equal(terminal.state, "verified"); assert.equal(terminal.replyToMessageId, f.binding.intent.primaryMessageId);
    assert.equal(terminal.wireReplyToMessageId, null);
  } finally { key.fill(0); }
  const reopened = await f.inspect(); assert.equal(reopened.verifiedParts, 1); assert.equal(reopened.nextPart, 2);
  assert.equal(provider.messages.values().next().value!.replyToMessageId, null);
});
