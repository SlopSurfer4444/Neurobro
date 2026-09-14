import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { readStandingDeliveredChronicleNote, readStandingHistoryTaskDelivery, runStandingHistoryTaskDelivery } from "../src/standing-history-task-delivery.js";
import { projectStandingChronicleNote, requireStandingChronicleNote } from "../src/standing-chronicle-note.js";
import type { PilotSend } from "../src/pilot-outbox.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-delivered-chronicle-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-delivered-chronicle-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), analysis: join(root, "analysis"), control: join(root, "control"), attempts: join(root, "attempts"), delivery: join(root, "delivery") };
  for (const path of Object.values(directories)) await mkdir(path);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "7".repeat(48), accountId: "123", chatId: "-100456", requesterId: "456", primaryMessageId: 999,
    fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Private task objective" };
  const binding = { intent, passphrase: "synthetic-delivered-chronicle-passphrase" }, signal = new AbortController().signal;
  const source = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "create" });
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: directories.control, mode: "create" });
  const analysisArgs = { ...binding, directory: directories.analysis, readSourcePage: (i: number) => source.readPage(i) };
  const analysis = await openStandingHistoryAnalysisStore({ ...analysisArgs, mode: "create" });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: directories.attempts, mode: "create", analysis });
  const before = (await source.status()).readProgress.checkpoint, ref = "m_" + "1".repeat(24);
  const after = { ...before, offsetId: 998, lastDate: 1500, oldestDate: 1500, newestDate: 1500, upperBoundMessageId: 998, pages: 1, status: "lower-bound-reached" as const };
  await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: after,
    sources: [{ messageId: 998, date: 1500, disposition: "included", messageRef: ref, authorId: "456" }], page: {
      schema: "neurobro-self-history-v1", fromDate: 1000, toDate: 2000,
      messages: [{ ref, authorRef: "a_" + "2".repeat(24), author: "user", displayName: "Synthetic speaker", date: 1500, editedAt: null, replyRef: null, replyUnavailable: false, text: "Private original source" }],
      cursor: null, hasMore: false, status: "lower-bound-reached", coverage: { scope: "available-history-snapshot", oldestExaminedDate: 1500, newestExaminedDate: 1500, traversalComplete: true, undatedEntries: 0, pages: 1 },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } } });
  const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis });
  async function selected() { for (let i = 0; i < 10; i++) { const plan = await planner.next(); if (plan.kind !== "scan-more") return plan; } throw Error("fixture planner did not finish"); }
  const plan = await selected(); assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") throw Error("expected leaf");
  const referenceKey = analysis.referenceKey(), fragment = projectStandingHistorySource({ intent, referenceKey, storedPage: (await source.readPage(1))! });
  const supports = [{ sourceRef: fragment.rows[0]!.sourceRef, versionRef: fragment.rows[0]!.versionRef }];
  const output = { summary: "Persisted model analysis with supporting source", claims: [{ kind: "reported" as const, text: "Model-authored supported report", supports }], omittedDetailCount: 3 };
  const reservation = await attempts.reserve({ plan: { kind: "leaf", sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, nodeIndex: 1, inputs: plan.inputs, modelInputHash: prepareStandingHistoryAnalysisMaterial(plan).modelInputHash },
    nativeBinding: { epochId: "a".repeat(32), requestRef: "synthetic-analysis", purpose: "history-analysis" } });
  await attempts.prepare({ attemptRef: reservation.attemptRef, output }); const evidence = await attempts.commitPrepared({ attemptRef: reservation.attemptRef });
  await attempts.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome: "observed" });
  const node = (await analysis.readNode(evidence.nodeRef))!, readiness = await selected(); assert.equal(readiness.kind, "analysis-ready"); if (readiness.kind !== "analysis-ready") throw Error("expected ready");
  await planner.close(); await attempts.close(); await analysis.close(); await control.close(); await source.close();
  const counts = { opens: 0, sends: 0, reads: 0, closes: 0, ownerProofs: 0 };
  const deliver = (mode: "verified" | "unknown" = "verified", body?: string) => {
    let sent: PilotSend;
    return runStandingHistoryTaskDelivery({ ...binding, directories, signal, readiness, ...(body === undefined ? {} : { body }),
      async verifyOwnerReady(nativeBinding) { counts.ownerProofs++; return { schema: "standing-analysis-owner-ready-v1", nativeBinding, basis: "persisted-owner-settlement", modelOutcome: "not-proven" }; },
      ticket: { openTaskReply() { counts.opens++; return { async close() { counts.closes++; }, transport: {
        async sendOnce(reply) { counts.sends++; sent = reply; if (mode === "unknown") throw Error("synthetic unknown send"); return { messageId: 2001 }; },
        async readExact(chatId, messageId) { counts.reads++; return { chatId, messageId, accountId: intent.accountId, replyToMessageId: sent.replyToMessageId, text: sent.text }; }
      } }; } } });
  };
  const readArgs = { ...binding, directories: { pages: directories.pages, analysis: directories.analysis, delivery: directories.delivery }, signal };
  const inspect = () => readStandingHistoryTaskDelivery({ ...binding, directory: directories.delivery });
  return { root, directories, binding, node, readiness, referenceKey, supports, output, counts, deliver, readArgs, inspect, slot: join(directories.delivery, intent.taskId) };
}
// Reads may update access time. Preserve and compare every entry's identity,
// write/change metadata and content hash; do not confuse read access with writes.
async function tree(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  async function visit(path: string, relative: string) {
    const stat = await lstat(path, { bigint: true });
    result.push({ path: relative, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      ...(stat.isFile() ? { hash: crypto.createHash("sha256").update(await readFile(path)).digest("hex") } : {}) });
    if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative + "/" + name);
  }
  await visit(root, ""); return result;
}

test("fresh read reconstructs an issued supported note from actual delivery and writes nothing", async t => {
  const f = await fixture(t); assert.equal((await f.deliver()).result.state, "verified");
  const before = await tree(f.root), calls = { ...f.counts }, note = await readStandingDeliveredChronicleNote(f.readArgs); assert.ok(note);
  assert.deepEqual(note, projectStandingChronicleNote({ intent: f.binding.intent, readiness: f.readiness, node: f.node, referenceKey: f.referenceKey }));
  assert.deepEqual(note.notes.claims[0]!.supports, f.supports); assert.equal(note.notes.claimsStatus, "model-authored-unverified"); assert.equal(note.notes.modelAuthoredOmittedDetailCount, 3);
  assert.equal(requireStandingChronicleNote(note, { accountId: f.binding.intent.accountId, peerId: f.binding.intent.chatId, requesterId: f.binding.intent.requesterId }), note);
  assert.deepEqual(await readStandingDeliveredChronicleNote(f.readArgs), note); assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts, calls);
});

test("consumed UNKNOWN delivery permits historical model notes without inventing a verified delivery", async t => {
  const f = await fixture(t); assert.equal((await f.deliver("unknown")).result.state, "unknown"); assert.equal((await f.inspect()).delivery, "unknown");
  const before = await tree(f.root), calls = { ...f.counts }, note = await readStandingDeliveredChronicleNote(f.readArgs); assert.ok(note);
  assert.equal(note.kind, "model-analysis-notes"); assert.equal(note.observedAt, null); assert.equal(note.notes.claimsStatus, "model-authored-unverified"); assert.deepEqual(note.notes.claims[0]!.supports, f.supports);
  assert.equal(Object.hasOwn(note, "delivery"), false); assert.equal(Object.hasOwn(note, "deliveryComplete"), false); assert.equal((await f.inspect()).delivery, "unknown");
  assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts, calls);
});

test("multipart with an available next part refuses notes until that continuation slot is consumed", async t => {
  const f = await fixture(t), body = "x".repeat(4096); assert.equal((await f.deliver("verified", body)).deliveryComplete, false);
  assert.equal((await f.inspect()).nextPart, 2); const before = await tree(f.root), calls = { ...f.counts };
  assert.equal(await readStandingDeliveredChronicleNote(f.readArgs), undefined); assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts, calls);
  assert.equal((await f.deliver("unknown", body)).result.state, "unknown"); assert.equal((await f.inspect()).nextPart, undefined);
  const note = await readStandingDeliveredChronicleNote(f.readArgs); assert.ok(note); assert.deepEqual(note.notes.claims[0]!.supports, f.supports); assert.equal((await f.inspect()).delivery, "unknown");
});

test("absent delivery, missing source data and corrupt descriptor yield no note without repair", async t => {
  for (const missing of ["delivery", "page", "analysis", "descriptor"] as const) {
    const f = await fixture(t); if (missing !== "delivery") await f.deliver();
    if (missing === "page") await unlink(join(f.directories.pages, f.binding.intent.taskId, "page-000001.enc"));
    if (missing === "analysis") await unlink(join(f.directories.analysis, f.binding.intent.taskId, "node-000001.enc"));
    if (missing === "descriptor") await writeFile(join(f.slot, "descriptor.enc"), "retained corrupt descriptor");
    const before = await tree(f.root), calls = { ...f.counts }; assert.equal(await readStandingDeliveredChronicleNote(f.readArgs), undefined);
    assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts, calls);
  }
});

test("new authentic analysis head or unknown page and analysis tails invalidate historical readiness", async t => {
  for (const changed of ["head", "pages", "analysis"] as const) {
    const f = await fixture(t); await f.deliver();
    if (changed === "head") {
      const source = await openStandingHistoryTaskStore({ ...f.binding, directory: f.directories.pages, mode: "open" });
      const analysis = await openStandingHistoryAnalysisStore({ ...f.binding, directory: f.directories.analysis, mode: "open", readSourcePage: i => source.readPage(i) });
      try { await analysis.appendMerge({ expectedHead: f.node.hash, children: [f.node.nodeRef], output: f.output }); } finally { await analysis.close(); await source.close(); }
    } else await writeFile(join(f.directories[changed], f.binding.intent.taskId, "unknown-tail.enc"), "retained tail");
    const before = await tree(f.root), calls = { ...f.counts }; assert.equal(await readStandingDeliveredChronicleNote(f.readArgs), undefined);
    assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts, calls);
  }
});

test("abort joins a real withheld scrypt completion callback before returning no note", async t => {
  const f = await fixture(t); await f.deliver(); const before = await tree(f.root), calls = { ...f.counts }, controller = new AbortController();
  const entered = deferred(), release = deferred(), original = crypto.scrypt; let intercepted = false, settled = false;
  // The actual crypto work completes; only delivery's callback dispatch is held.
  // session-crypto retains its original promisified function. No store is mocked.
  crypto.scrypt = ((...args: unknown[]) => {
    const callback = args.pop() as (...values: unknown[]) => void;
    return Reflect.apply(original, crypto, [...args, (...values: unknown[]) => {
      if (intercepted) { callback(...values); return; } intercepted = true; entered.resolve();
      void release.promise.then(() => callback(...values));
    }]);
  }) as typeof crypto.scrypt;
  syncBuiltinESMExports();
  try {
    const pending = readStandingDeliveredChronicleNote({ ...f.readArgs, signal: controller.signal }).then(value => { settled = true; return value; });
    await Promise.race([entered.promise, pending]); assert.equal(intercepted, true); controller.abort(); await immediate(); assert.equal(settled, false);
    release.resolve(); assert.equal(await pending, undefined); assert.equal(settled, true);
  } finally { release.resolve(); crypto.scrypt = original; syncBuiltinESMExports(); }
  assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts, calls);
});

test("pre-aborted and hostile input reads return no note without executing getters or writing data", async t => {
  const f = await fixture(t); await f.deliver(); const before = await tree(f.root), calls = { ...f.counts }, controller = new AbortController(); controller.abort(); let invoked = 0;
  assert.equal(await readStandingDeliveredChronicleNote({ ...f.readArgs, signal: controller.signal }), undefined);
  assert.equal(await readStandingDeliveredChronicleNote({ ...f.readArgs, get intent() { invoked++; return f.binding.intent; } }), undefined);
  assert.equal(await readStandingDeliveredChronicleNote(new Proxy(f.readArgs, { ownKeys() { invoked++; throw Error("trap"); } })), undefined);
  assert.equal(invoked, 0); assert.deepEqual(await tree(f.root), before); assert.deepEqual(f.counts, calls);
});
