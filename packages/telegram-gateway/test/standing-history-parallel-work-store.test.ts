import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisOutput } from "../src/standing-history-analysis-store.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { projectMergeView } from "../src/standing-history-analysis-view.js";
import { openStandingHistoryParallelWorkStore, type StandingHistoryParallelWorkPlan } from "../src/standing-history-parallel-work-store.js";
import type { StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";
import { decryptSession, encryptSession } from "../src/session-crypto.js";

const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "7".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Synthetic private parallel history" };
function page(before: SelfHistoryTaskCheckpoint, count = 1): SelfHistoryTaskPage {
  const firstId = (before.offsetId || (count > 1 ? 1000000 : 1000)) - 1, messageId = firstId - count + 1, date = before.lastDate - 1;
  const sources = Array.from({ length: count }, (_, i) => ({ messageId: firstId - i, date, disposition: "included" as const,
    messageRef: "m_" + (firstId - i).toString(16).padStart(24, "0"), authorId: "456" }));
  const next = { ...before, offsetId: messageId, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date,
    pages: before.pages + 1, upperBoundMessageId: before.upperBoundMessageId ?? messageId };
  return { beforeCheckpoint: before, nextCheckpoint: { ...next, upperBoundMessageId: before.upperBoundMessageId ?? firstId }, sources,
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: sources.map(s => ({ ref: s.messageRef, authorRef: "a_" + "3".repeat(24), author: "user" as const, displayName: "Synthetic private speaker", date, editedAt: null,
        replyRef: null, replyUnavailable: false, text: "Synthetic private source " + s.messageId })).reverse(), cursor: null, hasMore: true, status: "more",
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: false, undatedEntries: 0, pages: next.pages },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
const binding = (i: number): StandingHistoryAnalysisNativeBinding => ({ epochId: "1".repeat(32), requestRef: "parallel-request-" + i, purpose: "history-analysis" });
const settled = async (nativeBinding: StandingHistoryAnalysisNativeBinding) => ({ schema: "standing-analysis-owner-settlement-v1", nativeBinding,
  resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" });
async function fixture(t: TestContext, pageCount = 4, rowsPerPage = 1) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-parallel-work-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-parallel-work-"))); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, "work"), pagesDirectory = join(root, "pages"), analysisDirectory = join(root, "analysis");
  for (const path of [directory, pagesDirectory, analysisDirectory]) await mkdir(path);
  const shared = { passphrase: "synthetic-parallel-work-passphrase", intent };
  const source = await openStandingHistoryTaskStore({ ...shared, directory: pagesDirectory, mode: "create" }); t.after(() => source.close());
  for (let i = 0; i < pageCount; i++) { const before = (await source.status()).readProgress.checkpoint; await source.appendPage({ expectedCheckpoint: before, result: page(before, rowsPerPage) }); }
  const analysis = await openStandingHistoryAnalysisStore({ ...shared, directory: analysisDirectory, readSourcePage: index => source.readPage(index), mode: "create" }); t.after(() => analysis.close());
  const args = { ...shared, directory, source, analysis };
  const openStore = async (mode: "open" | "create" = "create", customAnalysis = analysis) => { const store = await openStandingHistoryParallelWorkStore({ ...args, analysis: customAnalysis, mode }); t.after(() => store.close()); return store; };
  async function leaf(pageIndex: number, requestIndex = pageIndex) {
    const storedPage = (await source.readPage(pageIndex))!, sourceHead = (await source.status()).readProgress.chainHash, expectedHead = (await analysis.status()).headHash;
    const fragment = projectStandingHistorySource({ intent, referenceKey: analysis.referenceKey(), storedPage, maxBytes: 49152, maxRows: 100 });
    const inputs = [{ pageIndex, maxBytes: 49152, maxRows: 100, materialRef: fragment.materialRef }] as const;
    const { modelInputHash } = prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead, inputs, material: fragment });
    const plan: StandingHistoryParallelWorkPlan = { kind: "leaf", inputs, modelInputHash, nativeBinding: binding(requestIndex) };
    const shownSupports = fragment.rows.map(row => ({ sourceRef: row.sourceRef, versionRef: row.versionRef }));
    const output: StandingHistoryAnalysisOutput = { summary: "Synthetic private summary " + pageIndex, claims: [{ kind: "reported", text: "Synthetic private claim " + pageIndex, supports: shownSupports }] };
    return { plan, output, shownSupports, sourceHead, expectedHead };
  }
  return { ...args, root, slot: join(directory, intent.taskId), openStore, leaf };
}
async function files(directory: string) { return Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), "utf8")])); }
const successorBinding = (i: number): StandingHistoryAnalysisNativeBinding => ({ ...binding(100 + i), epochId: i.toString(16).padStart(32, "0") });

test("129 completed waves survive cold reopen within actual event and analysis-node capacity", async t => {
  const f = await fixture(t, 2, 100), store = await f.openStore(), sourceHead = (await f.source.status()).readProgress.chainHash;
  let expectedHead = (await f.analysis.status()).headHash, completed = 0, firstWave = "";
  for (const pageIndex of [1, 2]) {
    const storedPage = (await f.source.readPage(pageIndex))!; let position: string | undefined;
    do {
      const fragment = projectStandingHistorySource({ intent, referenceKey: f.analysis.referenceKey(), storedPage, maxBytes: 1048576, maxRows: 1,
        ...(position ? { position } : {}) });
      const inputs = [{ pageIndex, materialRef: fragment.materialRef, maxBytes: 1048576, maxRows: 1, ...(position ? { position } : {}) }] as const;
      const modelInputHash = prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead, inputs, material: fragment }).modelInputHash;
      const plan: StandingHistoryParallelWorkPlan = { kind: "leaf", inputs, modelInputHash, nativeBinding: binding(completed + 1) };
      const wave = await store.reserveWave({ sourceHead, expectedHead, works: [plan] }), workRef = wave.workRefs[0]!;
      if (!firstWave) firstWave = wave.waveRef;
      await store.prepare({ workRef, output: { summary: "Synthetic single-row analysis", claims: [] }, shownSupports: [] });
      await store.recordModelOutcome({ workRef, outcome: "observed" });
      const result = await store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled });
      assert.equal(result.kind, "projected"); if (result.kind !== "projected") throw new Error("fixture"); expectedHead = result.node.hash;
      completed++; position = fragment.nextPosition ?? undefined;
    } while (position && completed < 129);
    if (completed === 129) break;
  }
  assert.equal(completed, 129); const lastBefore = await store.status(); assert.equal(lastBefore.waves, 129); assert.equal(lastBefore.projected, 129);
  const firstReceiptPath = join(f.slot, "event-000001.enc"), firstReceipt = await readFile(firstReceiptPath); await store.close();
  const cold = await f.openStore("open"); assert.deepEqual(await cold.status(), lastBefore); assert.equal((await cold.status()).storage, "ready");
  assert.deepEqual(await cold.projectNext({ waveRef: firstWave, verifyOwnerSettled: settled }), { kind: "complete" });
  assert.deepEqual(await readFile(firstReceiptPath), firstReceipt); assert.equal((await f.analysis.status()).analysisNodes, 129);
});

for (const [previousContextHash, contextHash] of [["a".repeat(64), "b".repeat(64)], ["a".repeat(64), null], [null, "b".repeat(64)]] as const)
test(`explicit successor context refresh ${previousContextHash ? "present" : "none"} to ${contextHash ? "different" : "none"} preserves primary plan and mixed cap`, async t => {
  const f = await fixture(t), a = await f.leaf(1), b = await f.leaf(2); let store = await f.openStore();
  const plan = { ...a.plan, ...(previousContextHash === null ? {} : { contextHash: previousContextHash }) };
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [plan, b.plan] }), oldRef = wave.workRefs[0]!;
  await store.recordModelOutcome({ workRef: oldRef, outcome: "unknown" });
  await store.prepare({ workRef: wave.workRefs[1]!, output: b.output, shownSupports: b.shownSupports });
  await store.recordModelOutcome({ workRef: wave.workRefs[1]!, outcome: "observed" });
  const original = await store.readWork(oldRef), sibling = await store.readWork(wave.workRefs[1]!), saved = await files(f.slot);
  await store.close(); store = await f.openStore("open");
  const request = { workRef: oldRef, nativeBinding: successorBinding(1), verifyOwnerSettled: settled, contextRefresh: { previousContextHash, contextHash } };
  const next = await store.reserveSuccessor(request), expectedPlan = { ...a.plan, nativeBinding: successorBinding(1), ...(contextHash === null ? {} : { contextHash }) };
  assert.deepEqual((await store.readWork(next.workRef)).plan, expectedPlan);
  assert.equal(Object.hasOwn((await store.readWork(next.workRef)).plan, "contextHash"), contextHash !== null);
  assert.deepEqual(await store.readWork(oldRef), original); assert.deepEqual(await store.readWork(wave.workRefs[1]!), sibling);
  const event = JSON.parse(await decryptSession((await files(f.slot)).at(-2)![1]!, f.passphrase));
  assert.equal(event.payload.kind, "no-output-successor-v2"); assert.deepEqual(event.payload.contextRefresh, request.contextRefresh);
  assert.equal(event.payload.sourceHead, a.sourceHead); assert.equal(event.payload.currentAnalysisHead, a.expectedHead);
  assert.deepEqual(event.payload.lineage, { predecessorWorkRefs: [oldRef], consecutiveNoOutput: 1 });
  assert.deepEqual(event.payload.settlement, await settled(plan.nativeBinding));
  await store.recordModelOutcome({ workRef: next.workRef, outcome: "observed" }); await store.close(); store = await f.openStore("open");
  assert.deepEqual((await store.readWork(next.workRef)).plan, expectedPlan);
  const third = await store.reserveSuccessor({ workRef: next.workRef, nativeBinding: successorBinding(2), verifyOwnerSettled: settled });
  assert.deepEqual((await store.readWork(third.workRef)).plan, { ...expectedPlan, nativeBinding: successorBinding(2) });
  assert.equal(JSON.parse(await decryptSession((await files(f.slot)).at(-2)![1]!, f.passphrase)).payload.kind, "no-output-successor-v1");
  await store.close(); store = await f.openStore("open");
  const exhausted = { workRef: third.workRef, nativeBinding: successorBinding(3), verifyOwnerSettled: settled, contextRefresh: { previousContextHash: contextHash, contextHash: "c".repeat(64) } };
  await assert.rejects(store.reserveSuccessor(exhausted), /LIMIT/);
  assert.equal((await store.readWork(third.workRef)).consecutiveNoOutput, 3);
  assert.deepEqual(await store.readWork(oldRef), original); assert.deepEqual(await store.readWork(wave.workRefs[1]!), sibling);
  const after = new Map(await files(f.slot) as [string, string][]); for (const [name, bytes] of saved) assert.equal(after.get(name!), bytes);
});

test("explicit successor context refresh refuses wrong prior hash, invalid new hash and primary plan changes without writes", async t => {
  const f = await fixture(t), a = await f.leaf(1), store = await f.openStore(), oldHash = "a".repeat(64);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [{ ...a.plan, contextHash: oldHash }] });
  const saved = await files(f.slot);
  for (const previousContextHash of [null, "b".repeat(64)]) {
    const request = { workRef: wave.workRefs[0]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled, contextRefresh: { previousContextHash, contextHash: "c".repeat(64) } };
    await assert.rejects(store.reserveSuccessor(request), /BINDING/);
  }
  for (const contextRefresh of [{ previousContextHash: oldHash, contextHash: "bad" }, { previousContextHash: oldHash, contextHash: undefined },
    { previousContextHash: oldHash, contextHash: oldHash }, { previousContextHash: null, contextHash: null },
    { previousContextHash: oldHash, contextHash: "b".repeat(64), modelInputHash: "c".repeat(64) }]) {
    const request = { workRef: wave.workRefs[0]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled, contextRefresh };
    await assert.rejects(store.reserveSuccessor(request as Parameters<typeof store.reserveSuccessor>[0]), /INPUT/);
  }
  const changedPrimary = { workRef: wave.workRefs[0]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled,
    contextRefresh: { previousContextHash: oldHash, contextHash: "b".repeat(64) }, modelInputHash: "c".repeat(64) };
  await assert.rejects(store.reserveSuccessor(changedPrimary), /INPUT/);
  assert.deepEqual(await files(f.slot), saved);
});

test("explicit successor context refresh refuses prepared output and forged encrypted refresh evidence", async t => {
  const f = await fixture(t), a = await f.leaf(1), b = await f.leaf(2), store = await f.openStore(), oldHash = "a".repeat(64), newHash = "b".repeat(64);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [{ ...a.plan, contextHash: oldHash }, b.plan] });
  await store.prepare({ workRef: wave.workRefs[1]!, output: b.output, shownSupports: b.shownSupports });
  await store.recordModelOutcome({ workRef: wave.workRefs[1]!, outcome: "unknown" });
  await assert.rejects(store.reserveSuccessor({ workRef: wave.workRefs[1]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled,
    contextRefresh: { previousContextHash: null, contextHash: newHash } }), /CONSUMED/);
  const request = { workRef: wave.workRefs[0]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled, contextRefresh: { previousContextHash: oldHash, contextHash: newHash } };
  const next = await store.reserveSuccessor(request); await store.close();
  const path = join(f.slot, "event-000004.enc"), cipher = await readFile(path, "utf8"), event = JSON.parse(await decryptSession(cipher, f.passphrase));
  for (const payload of [
    { ...event.payload, contextRefresh: { previousContextHash: "c".repeat(64), contextHash: newHash } },
    { ...event.payload, contextRefresh: { previousContextHash: oldHash, contextHash: oldHash } },
    { ...event.payload, contextRefresh: { previousContextHash: oldHash, contextHash: newHash, modelInputHash: "c".repeat(64) } },
    { ...event.payload, modelInputHash: "c".repeat(64) },
    { ...event.payload, kind: "no-output-successor-v1" }
  ]) {
    await writeFile(path, await encryptSession(JSON.stringify({ ...event, payload }), f.passphrase));
    const reopened = await f.openStore("open"), before = await files(f.slot);
    assert.equal((await reopened.status()).storage, "tail-refused");
    await assert.rejects(reopened.reserveSuccessor(request), /TAIL/);
    assert.deepEqual(await files(f.slot), before); await reopened.close();
  }
  await writeFile(path, cipher); await writeFile(join(f.slot, "event-000005.enc"), "torn ciphertext");
  const reopened = await f.openStore("open"), before = await files(f.slot);
  await assert.rejects(reopened.reserveSuccessor({ workRef: next.workRef, nativeBinding: successorBinding(2), verifyOwnerSettled: settled,
    contextRefresh: { previousContextHash: newHash, contextHash: null } }), /TAIL/);
  assert.deepEqual(await files(f.slot), before);
});

for (const race of ["late-output", "changed-source"] as const) test(`explicit successor context refresh rejects ${race} during owner settlement`, async t => {
  const f = await fixture(t), a = await f.leaf(1), store = await f.openStore();
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] }), workRef = wave.workRefs[0]!;
  const request = { workRef, nativeBinding: successorBinding(1), contextRefresh: { previousContextHash: null, contextHash: "b".repeat(64) }, verifyOwnerSettled: settled };
  await assert.rejects(store.reserveSuccessor({ ...request, verifyOwnerSettled: async binding => ({ ...await settled(binding), persisted: false }) }), /SETTLEMENT/);
  const saved = await files(f.slot);
  await assert.rejects(store.reserveSuccessor({ ...request, verifyOwnerSettled: async binding => {
    if (race === "late-output") await store.prepare({ workRef, output: a.output, shownSupports: a.shownSupports });
    else { const checkpoint = (await f.source.status()).readProgress.checkpoint; await f.source.appendPage({ expectedCheckpoint: checkpoint, result: page(checkpoint) }); }
    return settled(binding);
  } }), race === "late-output" ? /CONSUMED/ : /CONFLICT/);
  assert.deepEqual((await store.status()).activeWave!.workRefs, wave.workRefs);
  const after = new Map(await files(f.slot) as [string, string][]); for (const [name, bytes] of saved) assert.equal(after.get(name!), bytes);
  assert.equal(after.size, saved.length + (race === "late-output" ? 1 : 0));
});

test("eight disjoint large packets persist an aggregate wave above 2MiB and reopen without replay", async t => {
  const f = await fixture(t, 168, 100), sourceHead = (await f.source.status()).readProgress.chainHash, expectedHead = (await f.analysis.status()).headHash;
  const works: StandingHistoryParallelWorkPlan[] = [];
  for (let worker = 0; worker < 8; worker++) {
    const fragments = [];
    for (let offset = 0; offset < 21; offset++) {
      const pageIndex = worker * 21 + offset + 1, storedPage = (await f.source.readPage(pageIndex))!;
      fragments.push(projectStandingHistorySource({ intent, referenceKey: f.analysis.referenceKey(), storedPage, maxBytes: 1048576, maxRows: 100 }));
    }
    const inputs = fragments.map(fragment => ({ pageIndex: fragment.pageIndex, materialRef: fragment.materialRef, maxBytes: 1048576, maxRows: 100 })) as
      [{ pageIndex: number; materialRef: string; maxBytes: number; maxRows: number }, ...{ pageIndex: number; materialRef: string; maxBytes: number; maxRows: number }[]];
    const material = { schema: "standing-history-source-batch-v1" as const, fragments };
    assert.ok(Buffer.byteLength(JSON.stringify(material)) < 1048576);
    assert.equal(fragments.reduce((n, fragment) => n + fragment.rows.length, 0), 2100);
    works.push({ kind: "leaf", inputs, nativeBinding: binding(worker + 1), modelInputHash: prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead, expectedHead, inputs, material }).modelInputHash });
  }
  const store = await f.openStore(), wave = await store.reserveWave({ sourceHead, expectedHead, works });
  const path = join(f.slot, "event-000001.enc"), ciphertext = await readFile(path, "utf8"), plain = await decryptSession(ciphertext, f.passphrase);
  assert.ok(Buffer.byteLength(plain) > 2 * 1024 * 1024); assert.ok(Buffer.byteLength(plain) < 16 * 1024 * 1024);
  await store.close(); const reopened = await f.openStore("open");
  assert.equal((await reopened.status()).storage, "ready"); assert.equal((await reopened.status()).modelReplayAllowed, false);
  for (let i = 0; i < works.length; i++) assert.deepEqual((await reopened.readWork(wave.workRefs[i]!)).plan, works[i]);
  await assert.rejects(reopened.reserveWave({ sourceHead, expectedHead, works }), /CONSUMED/);
  assert.equal(await readFile(path, "utf8"), ciphertext); assert.equal((await f.analysis.status()).analysisNodes, 0);
});

for (const previousOutcome of ["observed", "unknown", undefined] as const) test(`fresh successor preserves ${previousOutcome ?? "missing"} outcome and prepared sibling across cold reopen`, async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), b = await f.leaf(2);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] }), oldRef = wave.workRefs[0]!;
  if (previousOutcome) await store.recordModelOutcome({ workRef: oldRef, outcome: previousOutcome });
  await store.prepare({ workRef: wave.workRefs[1]!, output: b.output, shownSupports: b.shownSupports });
  await store.recordModelOutcome({ workRef: wave.workRefs[1]!, outcome: "observed" });
  const oldWork = await store.readWork(oldRef), sibling = await store.readWork(wave.workRefs[1]!), saved = await files(f.slot);
  await store.close(); const reopened = await f.openStore("open");
  const next = await reopened.reserveSuccessor({ workRef: oldRef, nativeBinding: successorBinding(1), verifyOwnerSettled: settled });
  const events = await files(f.slot), event = JSON.parse(await decryptSession(events.at(-2)![1]!, f.passphrase));
  assert.equal(event.payload.kind, "no-output-successor-v1");
  assert.equal(event.payload.reason, previousOutcome === undefined ? "missing-outcome" : previousOutcome === "unknown" ? "unknown-outcome" : "observed-no-output");
  assert.deepEqual(event.payload.lineage, { predecessorWorkRefs: [oldRef], consecutiveNoOutput: 1 });
  assert.equal(event.payload.sourceHead, a.sourceHead); assert.equal(event.payload.currentAnalysisHead, a.expectedHead);
  assert.deepEqual(event.payload.settlement, await settled(a.plan.nativeBinding));
  assert.equal(next.waveRef, wave.waveRef); assert.notEqual(next.workRef, oldRef);
  assert.deepEqual(await reopened.readWork(oldRef), oldWork); assert.deepEqual(await reopened.readWork(wave.workRefs[1]!), sibling);
  assert.deepEqual((await reopened.status()).activeWave!.workRefs, [next.workRef, wave.workRefs[1]]);
  assert.equal((await reopened.status()).works, 3);
  assert.deepEqual((await reopened.readWork(next.workRef)).plan, { ...a.plan, nativeBinding: successorBinding(1) });
  assert.equal((await reopened.readWork(next.workRef)).consecutiveNoOutput, 2);
  await assert.rejects(reopened.prepare({ workRef: oldRef, output: a.output, shownSupports: a.shownSupports }), /CONSUMED/);
  if (previousOutcome === undefined) await assert.rejects(reopened.recordModelOutcome({ workRef: oldRef, outcome: "unknown" }), /CONSUMED/);
  await assert.rejects(reopened.reserveSuccessor({ workRef: oldRef, nativeBinding: successorBinding(2), verifyOwnerSettled: settled }), /CONSUMED/);
  await reopened.prepare({ workRef: next.workRef, output: a.output, shownSupports: a.shownSupports });
  await reopened.recordModelOutcome({ workRef: next.workRef, outcome: "observed" });
  await reopened.close(); const final = await f.openStore("open");
  assert.deepEqual(await final.readWork(oldRef), oldWork);
  for (const workRef of [next.workRef, wave.workRefs[1]]) {
    const projected = await final.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled });
    assert.equal(projected.kind, "projected"); if (projected.kind === "projected") assert.equal(projected.workRef, workRef);
  }
  assert.deepEqual((await f.analysis.readNodeAt(1))!.output, a.output); assert.deepEqual((await f.analysis.readNodeAt(2))!.output, b.output);
  const after = new Map(await files(f.slot) as [string, string][]); for (const [name, bytes] of saved) assert.equal(after.get(name!), bytes);
});

for (const outcomes of [["refused", "observed", "refused"], [undefined, "unknown", "observed"], ["unknown", "observed", undefined], ["observed", undefined, "unknown"]] as const)
test(`combined no-output budget is three across restart: ${outcomes.join("/")}`, async t => {
  const f = await fixture(t), a = await f.leaf(1); let store = await f.openStore();
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] }); let workRef = wave.workRefs[0]!;
  for (let i = 1; i <= 3; i++) {
    const outcome = outcomes[i - 1];
    if (outcome) await store.recordModelOutcome({ workRef, outcome });
    assert.equal((await store.readWork(workRef)).consecutiveNoOutput, i);
    await store.close(); store = await f.openStore("open"); const before = await files(f.slot);
    if (i === 3) {
      let verified = false;
      await assert.rejects(store.reserveSuccessor({ workRef, nativeBinding: successorBinding(i), verifyOwnerSettled: async b => { verified = true; return settled(b); } }), /LIMIT/);
      assert.equal(verified, false); assert.deepEqual(await files(f.slot), before);
    } else workRef = (await store.reserveSuccessor({ workRef, nativeBinding: successorBinding(i), verifyOwnerSettled: settled })).workRef;
  }
});

test("successor rejects unsettled unknown or missing work, output and nonfresh identities without writes", async t => {
  const f = await fixture(t), store = await f.openStore(), leaves = [await f.leaf(1), await f.leaf(2), await f.leaf(3), await f.leaf(4)];
  const wave = await store.reserveWave({ sourceHead: leaves[0]!.sourceHead, expectedHead: leaves[0]!.expectedHead, works: leaves.map(v => v.plan) });
  await store.recordModelOutcome({ workRef: wave.workRefs[0]!, outcome: "unknown" });
  await store.prepare({ workRef: wave.workRefs[2]!, output: leaves[2]!.output, shownSupports: leaves[2]!.shownSupports });
  await store.recordModelOutcome({ workRef: wave.workRefs[2]!, outcome: "observed" });
  await store.recordModelOutcome({ workRef: wave.workRefs[3]!, outcome: "refused" }); const before = await files(f.slot);
  for (const workRef of wave.workRefs.slice(0, 2)) await assert.rejects(store.reserveSuccessor({ workRef, nativeBinding: successorBinding(1), verifyOwnerSettled: async b => ({ ...await settled(b), persisted: false }) }), /SETTLEMENT/);
  await assert.rejects(store.reserveSuccessor({ workRef: wave.workRefs[2]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled }), /CONSUMED/);
  for (const nativeBinding of [binding(99), { ...successorBinding(1), requestRef: binding(1).requestRef }])
    await assert.rejects(store.reserveSuccessor({ workRef: wave.workRefs[3]!, nativeBinding, verifyOwnerSettled: settled }), /BINDING/);
  assert.deepEqual(await files(f.slot), before);
});

for (const previousOutcome of ["observed", undefined] as const) test(`successor rechecks late output and exact settlement for ${previousOutcome ?? "missing"} outcome`, async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), b = await f.leaf(2);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] }), workRef = wave.workRefs[0]!;
  if (previousOutcome) await store.recordModelOutcome({ workRef, outcome: previousOutcome }); const before = await files(f.slot);
  for (const override of [{ persisted: false }, { resourcesSettled: false }, { replacementReady: false }, { nativeBinding: binding(999) }, { modelOutcome: "observed" }])
    await assert.rejects(store.reserveSuccessor({ workRef, nativeBinding: successorBinding(1), verifyOwnerSettled: async b => ({ ...await settled(b), ...override }) }), /SETTLEMENT/);
  assert.deepEqual(await files(f.slot), before);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(done => { entered = done; }), joined = new Promise<void>(done => { finish = done; });
  const attempt = store.reserveSuccessor({ workRef, nativeBinding: successorBinding(1), verifyOwnerSettled: async binding => { entered(); await joined; return settled(binding); } });
  await started;
  await store.prepare({ workRef: wave.workRefs[1]!, output: b.output, shownSupports: b.shownSupports });
  await store.prepare({ workRef, output: a.output, shownSupports: a.shownSupports }); finish();
  await assert.rejects(attempt, /CONSUMED/);
  assert.deepEqual((await store.status()).activeWave!.workRefs, wave.workRefs);
});

test("unknown output remains projection-only and a late independent analysis append prevents continuation", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), b = await f.leaf(2), c = await f.leaf(3);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] });
  await store.prepare({ workRef: wave.workRefs[0]!, output: a.output, shownSupports: a.shownSupports });
  await store.recordModelOutcome({ workRef: wave.workRefs[0]!, outcome: "unknown" });
  await store.recordModelOutcome({ workRef: wave.workRefs[1]!, outcome: "unknown" });
  const saved = await files(f.slot);
  await assert.rejects(store.reserveSuccessor({ workRef: wave.workRefs[0]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled }), /CONSUMED/);
  await assert.rejects(store.reserveSuccessor({ workRef: wave.workRefs[1]!, nativeBinding: successorBinding(1), verifyOwnerSettled: async binding => {
    assert.equal(c.plan.kind, "leaf"); if (c.plan.kind !== "leaf") throw Error("fixture");
    await f.analysis.appendLeaf({ expectedHead: c.expectedHead, inputs: c.plan.inputs, output: c.output }); return settled(binding);
  } }), /CONFLICT/);
  assert.deepEqual(await files(f.slot), saved);
});

test("all predecessor epochs and request identities stay consumed after mixed-outcome reopen", async t => {
  const f = await fixture(t), a = await f.leaf(1); let store = await f.openStore();
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] });
  const next = await store.reserveSuccessor({ workRef: wave.workRefs[0]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled });
  await store.recordModelOutcome({ workRef: next.workRef, outcome: "unknown" }); await store.close(); store = await f.openStore("open");
  const saved = await files(f.slot);
  for (const nativeBinding of [{ ...successorBinding(2), epochId: a.plan.nativeBinding.epochId }, { ...successorBinding(2), epochId: successorBinding(1).epochId },
    { ...successorBinding(2), requestRef: a.plan.nativeBinding.requestRef }, { ...successorBinding(2), requestRef: successorBinding(1).requestRef }])
    await assert.rejects(store.reserveSuccessor({ workRef: next.workRef, nativeBinding, verifyOwnerSettled: settled }), /BINDING/);
  assert.deepEqual(await files(f.slot), saved);
});

test("legacy successor event remains readable and contributes to new explicit continuation budget", async t => {
  const f = await fixture(t), a = await f.leaf(1); let store = await f.openStore();
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] });
  await store.recordModelOutcome({ workRef: wave.workRefs[0]!, outcome: "observed" });
  const next = await store.reserveSuccessor({ workRef: wave.workRefs[0]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled }); await store.close();
  const path = join(f.slot, "event-000003.enc"), event = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.passphrase));
  const { workRef, successorWorkRef, nativeBinding } = event.payload;
  event.payload = { kind: "successor", workRef, successorWorkRef, nativeBinding };
  await writeFile(path, await encryptSession(JSON.stringify(event), f.passphrase));
  const legacyBytes = await readFile(path, "utf8"); store = await f.openStore("open");
  assert.equal((await store.status()).storage, "ready"); assert.equal((await store.readWork(next.workRef)).consecutiveNoOutput, 2);
  await store.recordModelOutcome({ workRef: next.workRef, outcome: "unknown" });
  const third = await store.reserveSuccessor({ workRef: next.workRef, nativeBinding: successorBinding(2), verifyOwnerSettled: settled });
  await store.close(); store = await f.openStore("open");
  await assert.rejects(store.reserveSuccessor({ workRef: third.workRef, nativeBinding: successorBinding(3), verifyOwnerSettled: settled }), /LIMIT/);
  assert.equal(await readFile(path, "utf8"), legacyBytes);
});

test("contradictory explicit successor evidence and torn journal cannot authorize another continuation", async t => {
  const f = await fixture(t), a = await f.leaf(1), store = await f.openStore();
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] });
  const next = await store.reserveSuccessor({ workRef: wave.workRefs[0]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled }); await store.close();
  const path = join(f.slot, "event-000002.enc"), cipher = await readFile(path, "utf8"), original = JSON.parse(await decryptSession(cipher, f.passphrase));
  for (const altered of [
    { ...original.payload, reason: "unknown-outcome" },
    { ...original.payload, lineage: { predecessorWorkRefs: [], consecutiveNoOutput: 1 } },
    { ...original.payload, lineage: { ...original.payload.lineage, consecutiveNoOutput: 0 } },
    { ...original.payload, settlement: { ...original.payload.settlement, modelOutcome: "observed" } },
    { ...original.payload, currentAnalysisHead: "f".repeat(64) },
    { ...original.payload, currentNodeCount: 1 },
    { ...original.payload, nativeBinding: { ...successorBinding(1), epochId: a.plan.nativeBinding.epochId } }
  ]) {
    await writeFile(path, await encryptSession(JSON.stringify({ ...original, payload: altered }), f.passphrase));
    const reopened = await f.openStore("open"), saved = await files(f.slot);
    assert.equal((await reopened.status()).storage, "tail-refused");
    await assert.rejects(reopened.reserveSuccessor({ workRef: wave.workRefs[0]!, nativeBinding: successorBinding(2), verifyOwnerSettled: settled }), /TAIL/);
    assert.deepEqual(await files(f.slot), saved); await reopened.close();
  }
  await writeFile(path, cipher); await writeFile(join(f.slot, "event-000003.enc"), "torn ciphertext");
  const reopened = await f.openStore("open"), saved = await files(f.slot);
  assert.equal((await reopened.status()).storage, "tail-refused");
  await assert.rejects(reopened.reserveSuccessor({ workRef: next.workRef, nativeBinding: successorBinding(2), verifyOwnerSettled: settled }), /TAIL/);
  assert.deepEqual(await files(f.slot), saved);
});

test("retry preserves an already projected sibling and refuses changed source after settlement", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), b = await f.leaf(2);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] });
  await store.prepare({ workRef: wave.workRefs[0]!, output: a.output, shownSupports: a.shownSupports });
  await store.recordModelOutcome({ workRef: wave.workRefs[0]!, outcome: "observed" });
  await store.recordModelOutcome({ workRef: wave.workRefs[1]!, outcome: "refused" });
  await store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled });
  const sibling = await store.readWork(wave.workRefs[0]!);
  const next = await store.reserveSuccessor({ workRef: wave.workRefs[1]!, nativeBinding: successorBinding(1), verifyOwnerSettled: settled });
  assert.deepEqual(await store.readWork(wave.workRefs[0]!), sibling);
  await store.recordModelOutcome({ workRef: next.workRef, outcome: "observed" });
  const before = await files(f.slot);
  await assert.rejects(store.reserveSuccessor({ workRef: next.workRef, nativeBinding: successorBinding(2), verifyOwnerSettled: async binding => {
    const checkpoint = (await f.source.status()).readProgress.checkpoint;
    await f.source.appendPage({ expectedCheckpoint: checkpoint, result: page(checkpoint) }); return settled(binding);
  } }), /CONFLICT/);
  assert.deepEqual(await files(f.slot), before); assert.deepEqual(await store.readWork(wave.workRefs[0]!), sibling);
});

test("independent outputs finish in reverse order, persist through reopen, and project exact ordered nodes", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), b = await f.leaf(2);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] });
  await store.prepare({ workRef: wave.workRefs[1]!, output: b.output, shownSupports: b.shownSupports });
  await store.recordModelOutcome({ workRef: wave.workRefs[1]!, outcome: "observed" });
  await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }), /CONSUMED/);
  await store.prepare({ workRef: wave.workRefs[0]!, output: a.output, shownSupports: a.shownSupports });
  await store.recordModelOutcome({ workRef: wave.workRefs[0]!, outcome: "observed" });
  assert.equal((await f.analysis.status()).analysisNodes, 0); const saved = await files(f.slot); await store.close();
  const reopened = await f.openStore("open"); assert.equal((await reopened.status()).modelReplayAllowed, false);
  for (let i = 0; i < 2; i++) { const projected = await reopened.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }); assert.equal(projected.kind, "projected"); if (projected.kind === "projected") assert.equal(projected.node.index, i + 1); }
  assert.deepEqual(await reopened.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }), { kind: "complete" });
  assert.deepEqual((await f.analysis.readNodeAt(1))!.output, a.output); assert.deepEqual((await f.analysis.readNodeAt(2))!.output, b.output);
  const after = new Map(await files(f.slot) as [string, string][]); for (const [name, bytes] of saved) assert.equal(after.get(name!), bytes);
  for (const [, bytes] of after) assert.ok(!bytes.includes("Synthetic private"));
});

test("optional context digest is inert, validated before reservation, and retained exactly on reopen", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), before = await files(f.slot);
  await assert.rejects(store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead,
    works: [{ ...a.plan, contextHash: "invalid-context" }] }));
  assert.deepEqual(await files(f.slot), before);
  const contextHash = "b".repeat(64), plan = { ...a.plan, contextHash };
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [plan] });
  plan.contextHash = "c".repeat(64);
  assert.equal((await store.readWork(wave.workRefs[0]!)).plan.contextHash, contextHash);
  await store.close(); const reopened = await f.openStore("open");
  assert.equal((await reopened.readWork(wave.workRefs[0]!)).plan.contextHash, contextHash);
  assert.equal((await reopened.readWork(wave.workRefs[0]!)).modelReplayAllowed, false);
});

test("pre-write support refusal is correctable; cross-work support and repeated preparation are refused", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), b = await f.leaf(2);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] }), before = await files(f.slot), workRef = wave.workRefs[0]!;
  await assert.rejects(store.prepare({ workRef, output: a.output, shownSupports: [] }), /SUPPORT/);
  await assert.rejects(store.prepare({ workRef, output: b.output, shownSupports: b.shownSupports }), /SUPPORT/);
  assert.deepEqual(await files(f.slot), before);
  await store.prepare({ workRef, output: a.output, shownSupports: a.shownSupports });
  await assert.rejects(store.prepare({ workRef, output: a.output, shownSupports: a.shownSupports }), /CONSUMED/);
  await assert.rejects(store.recordModelOutcome({ workRef, outcome: "refused" }), /CONFLICT/);
});

test("reopen consumes missing and unknown work and never fabricates output or permits another wave", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), b = await f.leaf(2);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] });
  await store.recordModelOutcome({ workRef: wave.workRefs[0]!, outcome: "unknown" }); await store.close(); const again = await f.openStore("open"), before = await files(f.slot);
  for (const [i, v] of [a, b].entries()) await assert.rejects(again.prepare({ workRef: wave.workRefs[i]!, output: v.output, shownSupports: v.shownSupports }), /CONSUMED/);
  await assert.rejects(again.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] }), /CONSUMED/);
  await assert.rejects(again.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }), /CONSUMED/);
  await assert.rejects(again.recordModelOutcome({ workRef: wave.workRefs[0]!, outcome: "observed" }), /CONFLICT/);
  assert.deepEqual(await files(f.slot), before);
});

test("uncertain append after real saved node recovers without a duplicate append or model replay", async t => {
  const f = await fixture(t); let appends = 0;
  const broken = { ...f.analysis, appendLeaf: async (args: Parameters<typeof f.analysis.appendLeaf>[0]) => { appends++; await f.analysis.appendLeaf(args); throw new Error("synthetic lost append response"); } };
  const store = await f.openStore("create", broken), a = await f.leaf(1), wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] }), workRef = wave.workRefs[0]!;
  await store.prepare({ workRef, output: a.output, shownSupports: a.shownSupports }); await store.recordModelOutcome({ workRef, outcome: "unknown" });
  await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }), /lost append response/);
  assert.equal((await store.status()).storage, "tail-refused"); assert.equal((await f.analysis.status()).analysisNodes, 1); await store.close();
  const reopened = await f.openStore("open", broken); assert.equal((await reopened.status()).storage, "ready");
  const result = await reopened.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }); assert.equal(result.kind, "projected"); assert.equal(appends, 1);
  assert.equal((await reopened.readWork(workRef)).modelOutcome, "unknown"); assert.equal((await f.analysis.status()).analysisNodes, 1);
});

test("settlement binds exact owner and source mutation blocks projection before ledger writes", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] }), workRef = wave.workRefs[0]!;
  await store.prepare({ workRef, output: a.output, shownSupports: a.shownSupports }); await store.recordModelOutcome({ workRef, outcome: "observed" });
  const before = await files(f.slot);
  await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: async b => ({ ...await settled(b), nativeBinding: binding(999) }) }), /SETTLEMENT/);
  await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: async b => ({ ...await settled(b), resourcesSettled: false }) }), /SETTLEMENT/);
  assert.deepEqual(await files(f.slot), before);
  const checkpoint = (await f.source.status()).readProgress.checkpoint; await f.source.appendPage({ expectedCheckpoint: checkpoint, result: page(checkpoint) });
  await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }), /CONFLICT/); assert.equal((await f.analysis.status()).analysisNodes, 0);
});

test("reservation rejects overlapping ranges, changed material hashes and reused request identities without writes", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), duplicate = await f.leaf(1, 2), b = await f.leaf(2), before = await files(f.slot);
  for (const works of [[a.plan, duplicate.plan], [a.plan, { ...b.plan, nativeBinding: a.plan.nativeBinding }], [{ ...a.plan, modelInputHash: "c".repeat(64) }]])
    await assert.rejects(store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works }));
  assert.deepEqual(await files(f.slot), before);
});

for (const viewMaxBytes of [undefined, 1048576]) test(`merge work preserves ${viewMaxBytes ?? "legacy absent"} material view across cold reopen`, async t => {
  const f = await fixture(t), a = await f.leaf(1), b = await f.leaf(2);
  if (a.plan.kind !== "leaf" || b.plan.kind !== "leaf") throw new Error("fixture");
  const left = await f.analysis.appendLeaf({ expectedHead: a.expectedHead, inputs: a.plan.inputs, output: { ...a.output, summary: "a".repeat(32768) } });
  const right = await f.analysis.appendLeaf({ expectedHead: left.hash, inputs: b.plan.inputs, output: { ...b.output, summary: "b".repeat(32768) } });
  const expectedHead = right.hash, children: [string, string] = [left.nodeRef, right.nodeRef];
  const view = projectMergeView({ children: [left, right], referenceKey: f.analysis.referenceKey(), maxBytes: viewMaxBytes ?? 49152, preferComplete: true });
  const { modelInputHash } = prepareStandingHistoryAnalysisMaterial({ kind: "merge", sourceHead: a.sourceHead, expectedHead, children, materials: view.children });
  const plan: StandingHistoryParallelWorkPlan = { kind: "merge", children, modelInputHash, nativeBinding: binding(10), ...(viewMaxBytes === undefined ? {} : { viewMaxBytes }) };
  const store = await f.openStore();
  if (viewMaxBytes !== undefined) await assert.rejects(store.reserveWave({ sourceHead: a.sourceHead, expectedHead, works: [{ kind: "merge", children, modelInputHash, nativeBinding: binding(10) }] }), /BINDING/);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead, works: [plan] }), workRef = wave.workRefs[0]!;
  await store.recordModelOutcome({ workRef, outcome: "refused" }); const before = await files(f.slot); await store.close();
  const reopened = await f.openStore("open"); assert.deepEqual((await reopened.readWork(workRef)).plan, plan);
  assert.equal(Object.hasOwn((await reopened.readWork(workRef)).plan, "viewMaxBytes"), viewMaxBytes !== undefined);
  const successor = await reopened.reserveSuccessor({ workRef, nativeBinding: successorBinding(1), verifyOwnerSettled: settled });
  assert.deepEqual((await reopened.readWork(successor.workRef)).plan, { ...plan, nativeBinding: successorBinding(1) });
  const output = { summary: "x".repeat(32768), claims: Array.from({ length: 128 }, () => ({ ...a.output.claims[0]!, text: "c".repeat(1024) })) };
  await reopened.prepare({ workRef: successor.workRef, output, shownSupports: a.shownSupports });
  await reopened.recordModelOutcome({ workRef: successor.workRef, outcome: "observed" }); await reopened.close();
  const final = await f.openStore("open"); await final.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled });
  assert.deepEqual((await f.analysis.readNodeAt(3))!.output, output);
  const after = new Map(await files(f.slot) as [string, string][]); for (const [name, bytes] of before) assert.equal(after.get(name!), bytes);
});

test("queued concurrent preparations snapshot arguments and project through a later serial merge", async t => {
  const f = await fixture(t), store = await f.openStore(), leaves = [await f.leaf(1), await f.leaf(2)];
  const first = leaves[0]!, wave = await store.reserveWave({ sourceHead: first.sourceHead, expectedHead: first.expectedHead, works: leaves.map(v => v.plan) });
  await Promise.all(leaves.map((v, i) => store.prepare({ workRef: wave.workRefs[i]!, output: v.output, shownSupports: v.shownSupports })));
  await Promise.all(wave.workRefs.map(workRef => store.recordModelOutcome({ workRef, outcome: "observed" })));
  await Promise.all(wave.workRefs.map(() => store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled })));
  const children = [(await f.analysis.readNodeAt(1))!, (await f.analysis.readNodeAt(2))!], expectedHead = (await f.analysis.status()).headHash;
  const view = projectMergeView({ children, referenceKey: f.analysis.referenceKey(), preferComplete: true });
  const refs = children.map(n => n.nodeRef) as [string, string], modelInputHash = prepareStandingHistoryAnalysisMaterial({ kind: "merge", sourceHead: first.sourceHead, expectedHead, children: refs, materials: view.children }).modelInputHash;
  const merged = await store.reserveWave({ sourceHead: first.sourceHead, expectedHead, works: [{ kind: "merge", children: refs, modelInputHash, nativeBinding: binding(3) }] });
  const shownSupports = leaves.flatMap(v => v.shownSupports), output = { summary: "Synthetic combined report", claims: [{ kind: "reported" as const, text: "Both sources", supports: shownSupports }] };
  await store.prepare({ workRef: merged.workRefs[0]!, output, shownSupports }); await store.recordModelOutcome({ workRef: merged.workRefs[0]!, outcome: "observed" });
  await store.projectNext({ waveRef: merged.waveRef, verifyOwnerSettled: settled }); assert.equal((await f.analysis.readNodeAt(3))!.kind, "merge");
});

test("getter and sparse-array inputs are inert; stray journal files refuse reopening without deletion", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1); let invoked = false;
  const bad = { ...a.plan, get modelInputHash() { invoked = true; return a.plan.modelInputHash; } };
  await assert.rejects(store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [bad] })); assert.equal(invoked, false);
  await assert.rejects(store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: new Array(2) })); await store.close();
  const path = join(f.slot, "unexpected.enc"); await writeFile(path, "preserve synthetic unknown file");
  const reopened = await f.openStore("open"); assert.equal((await reopened.status()).storage, "tail-refused"); assert.equal(await readFile(path, "utf8"), "preserve synthetic unknown file");
});

test("settlement waits outside the journal lane so another worker can prepare and release", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), b = await f.leaf(2);
  const wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan, b.plan] });
  await store.prepare({ workRef: wave.workRefs[0]!, output: a.output, shownSupports: a.shownSupports }); await store.recordModelOutcome({ workRef: wave.workRefs[0]!, outcome: "observed" });
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(done => { entered = done; }), finishOther = new Promise<void>(done => { finish = done; });
  const projecting = store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: async nativeBinding => { entered(); await finishOther; return settled(nativeBinding); } });
  await started;
  try {
    await store.prepare({ workRef: wave.workRefs[1]!, output: b.output, shownSupports: b.shownSupports });
    await store.recordModelOutcome({ workRef: wave.workRefs[1]!, outcome: "observed" });
  } finally { finish(); }
  assert.equal((await projecting).kind, "projected"); assert.equal((await store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled })).kind, "projected");
});

test("saved projection intent rejects a different node at the reserved index on recovery", async t => {
  const f = await fixture(t), broken = { ...f.analysis, appendLeaf: async () => { throw new Error("synthetic pre-append interruption"); } };
  const store = await f.openStore("create", broken), a = await f.leaf(1), b = await f.leaf(2), wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] }), workRef = wave.workRefs[0]!;
  await store.prepare({ workRef, output: a.output, shownSupports: a.shownSupports }); await store.recordModelOutcome({ workRef, outcome: "observed" });
  await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }), /pre-append interruption/); await store.close();
  if (b.plan.kind !== "leaf") throw new Error("fixture"); await f.analysis.appendLeaf({ expectedHead: a.expectedHead, inputs: b.plan.inputs, output: b.output });
  const again = await f.openStore("open"), before = await files(f.slot);
  await assert.rejects(again.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled }), /BINDING/);
  assert.deepEqual(await files(f.slot), before); assert.deepEqual((await f.analysis.readNodeAt(1))!.output, b.output);
});

test("a preceding legacy merge binds by authenticated scalar metadata without cloning its large body", async t => {
  const f = await fixture(t), a = await f.leaf(1), b = await f.leaf(2);
  if (a.plan.kind !== "leaf" || b.plan.kind !== "leaf") throw new Error("fixture");
  const first = await f.analysis.appendLeaf({ expectedHead: a.expectedHead, inputs: a.plan.inputs, output: a.output });
  const second = await f.analysis.appendLeaf({ expectedHead: first.hash, inputs: b.plan.inputs, output: b.output });
  const merged = await f.analysis.appendMerge({ expectedHead: second.hash, children: [first.nodeRef, second.nodeRef], output: { summary: "Synthetic prior merge", claims: [] } });
  // The real ledger supplies the predecessor identity/hash. This trusted reader
  // fixture expands only the unused body to exercise the bounded-clone seam;
  // it does not claim the repeated spans are actual archive coverage.
  const largeBody = Array.from({ length: 1024 }, () => merged.coverage[0]!); assert.ok(Buffer.byteLength(JSON.stringify(largeBody)) > 262144);
  const port = { ...f.analysis, readNodeAt: async (index: number) => { const node = await f.analysis.readNodeAt(index); return index === merged.index && node ? { ...node, coverage: largeBody } : node; } };
  const store = await f.openStore("create", port), next = await f.leaf(3), wave = await store.reserveWave({ sourceHead: next.sourceHead, expectedHead: next.expectedHead, works: [next.plan] }), workRef = wave.workRefs[0]!;
  await store.prepare({ workRef, output: next.output, shownSupports: next.shownSupports }); await store.recordModelOutcome({ workRef, outcome: "observed" });
  assert.equal((await store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: settled })).kind, "projected");
  assert.equal((await f.analysis.status()).analysisNodes, 4);
});

test("exact warm work release admits projection without claiming physical owner settlement", async t => {
  const f = await fixture(t), store = await f.openStore(), a = await f.leaf(1), wave = await store.reserveWave({ sourceHead: a.sourceHead, expectedHead: a.expectedHead, works: [a.plan] }), workRef = wave.workRefs[0]!;
  await store.prepare({ workRef, output: a.output, shownSupports: a.shownSupports }); await store.recordModelOutcome({ workRef, outcome: "observed" });
  const warm = async (nativeBinding: StandingHistoryAnalysisNativeBinding, selectedWork: string) => ({ schema: "standing-analysis-work-release-v1", nativeBinding, workRef: selectedWork, releaseAcknowledged: true, callbacksJoined: true });
  for (const changes of [{ workRef: "hwork_" + "0".repeat(48) }, { releaseAcknowledged: false }, { callbacksJoined: false }, { nativeBinding: binding(999) }])
    await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyWorkReleased: async (b, w) => ({ ...await warm(b, w), ...changes }) }), /SETTLEMENT/);
  await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyOwnerSettled: b => warm(b, workRef) }));
  await assert.rejects(store.projectNext({ waveRef: wave.waveRef, verifyWorkReleased: b => settled(b) }));
  assert.equal((await f.analysis.status()).analysisNodes, 0);
  assert.equal((await store.projectNext({ waveRef: wave.waveRef, verifyWorkReleased: warm })).kind, "projected");
  assert.equal((await f.analysis.status()).analysisNodes, 1);
});
