import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { encryptSession, decryptSession } from "../src/session-crypto.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisOutput } from "../src/standing-history-analysis-store.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { openStandingHistoryAnalysisAttemptStore } from "../src/standing-history-analysis-attempt-store.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";

type Store = Awaited<ReturnType<typeof openStandingHistoryAnalysisAttemptStore>>;
type Plan = Parameters<Store["reserve"]>[0]["plan"];
const intent = (): StandingHistoryTaskIntent => ({ schema: "standing-history-task-v1", taskId: "htask_" + "7".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Private synthetic analysis objective" });
function page(before: SelfHistoryTaskCheckpoint): SelfHistoryTaskPage {
  const messageId = (before.offsetId || 1000) - 1, date = before.lastDate - 1, ref = "m_" + messageId.toString(16).padStart(24, "0");
  const next = { ...before, offsetId: messageId, lastDate: date, oldestDate: date, newestDate: before.newestDate ?? date,
    pages: before.pages + 1, upperBoundMessageId: before.upperBoundMessageId ?? messageId };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources: [{ messageId, date, disposition: "included", messageRef: ref, authorId: "456" }],
    page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
      messages: [{ ref, authorRef: "a_" + "3".repeat(24), author: "user", displayName: "Private synthetic speaker", date, editedAt: null,
        replyRef: null, replyUnavailable: false, text: "Private original source " + messageId }], cursor: null, hasMore: true, status: "more",
      coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: false, undatedEntries: 0, pages: next.pages },
      excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-analysis-attempt-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-analysis-attempt-"))); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, "attempts"), pagesDirectory = join(root, "pages"), analysisDirectory = join(root, "analysis");
  for (const path of [directory, pagesDirectory, analysisDirectory]) await mkdir(path);
  const binding = { passphrase: "synthetic-analysis-attempt-passphrase", intent: intent() };
  const pages = await openStandingHistoryTaskStore({ ...binding, directory: pagesDirectory, mode: "create" }); t.after(() => pages.close());
  for (let i = 0; i < 2; i++) { const before = (await pages.status()).readProgress.checkpoint; await pages.appendPage({ expectedCheckpoint: before, result: page(before) }); }
  const analysisArgs = { ...binding, directory: analysisDirectory, readSourcePage: (index: number) => pages.readPage(index) };
  const analysis = await openStandingHistoryAnalysisStore({ ...analysisArgs, mode: "create" }); t.after(() => analysis.close());
  return { root, directory, slot: join(directory, binding.intent.taskId), binding, pages, analysis, analysisArgs };
}
function args(f: Awaited<ReturnType<typeof fixture>>) { return { ...f.binding, directory: f.directory, analysis: f.analysis }; }
async function opened(f: Awaited<ReturnType<typeof fixture>>, t: TestContext, mode: "create" | "open" = "create") {
  const store = await openStandingHistoryAnalysisAttemptStore({ ...args(f), mode }); t.after(() => store.close()); return store;
}
async function leafPlan(f: Awaited<ReturnType<typeof fixture>>, pageIndex = 1) {
  const source = await f.pages.status(), analysis = await f.analysis.status(), stored = (await f.pages.readPage(pageIndex))!;
  const material = projectStandingHistorySource({ intent: f.binding.intent, referenceKey: f.analysis.referenceKey(), storedPage: stored, maxBytes: 49152, maxRows: 100 });
  const plan: Plan = { kind: "leaf", sourceHead: source.readProgress.chainHash, expectedHead: analysis.headHash, nodeIndex: analysis.analysisNodes + 1,
    modelInputHash: "9".repeat(64), inputs: [{ pageIndex, maxBytes: 49152, maxRows: 100, materialRef: material.materialRef }] };
  const output: StandingHistoryAnalysisOutput = { summary: "Private model summary", claims: [{ kind: "reported", text: "Private unverified model claim",
    supports: [{ sourceRef: material.rows[0]!.sourceRef, versionRef: material.rows[0]!.versionRef }] }] };
  return { plan, output };
}
async function files(directory: string) { return Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), "utf8")])); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("first reservation is consumed across reopen and encrypted records never authorize model replay", async t => {
  const f = await fixture(t), store = await opened(f, t), { plan } = await leafPlan(f), first = await store.reserve({ plan });
  assert.match(first.planHash, /^[0-9a-f]{64}$/u); assert.equal(first.nodeIndex, 1); assert.ok(first.attemptRef);
  const status = await store.status(); assert.equal(status.storage, "ready"); assert.equal(status.attempts, 1); assert.equal(status.modelReplayAllowed, false);
  assert.equal(status.last?.attemptRef, first.attemptRef); await assert.rejects(store.reserve({ plan })); await store.close();
  const again = await opened(f, t, "open"); assert.deepEqual(await again.status(), status); await assert.rejects(again.reserve({ plan }));
  assert.equal(Object.hasOwn(status.last!, "nativeBinding"), false); assert.equal(Object.hasOwn((await again.status()).last!, "nativeBinding"), false);
  const legacyReservation = JSON.parse(await decryptSession(await readFile(join(f.slot, "attempt-000001.reservation.enc"), "utf8"), f.binding.passphrase));
  assert.equal(Object.hasOwn(legacyReservation, "nativeBinding"), false);
  assert.deepEqual(await readdir(f.slot), ["attempt-000001.reservation.enc", "intent.enc"]);
  for (const [name, cipher] of await files(f.slot)) {
    for (const raw of [f.binding.intent.objective, "-100456", "modelInputHash", "sourceHead", "expectedHead", "modelReplayAllowed"]) assert.equal(cipher!.includes(raw), false, name);
  }
});

test("native binding is snapshotted in encrypted reservation and survives fresh reopen exactly", async t => {
  const f = await fixture(t), store = await opened(f, t), { plan } = await leafPlan(f);
  const nativeBinding = { epochId: "a".repeat(32), requestRef: "Analysis_1:step.2-3", purpose: "history-analysis" as const }, expected = { ...nativeBinding };
  const pending = store.reserve({ plan, nativeBinding }); nativeBinding.epochId = "b".repeat(32); nativeBinding.requestRef = "changed-after-admission";
  const reservation = await pending, status = await store.status(); assert.deepEqual(status.last?.nativeBinding, expected); assert.ok(Object.isFrozen(status.last?.nativeBinding));
  const path = join(f.slot, "attempt-000001.reservation.enc"), ciphertext = await readFile(path, "utf8");
  for (const privateValue of [expected.epochId, expected.requestRef, "nativeBinding", "history-analysis"]) assert.equal(ciphertext.includes(privateValue), false);
  const record = JSON.parse(await decryptSession(ciphertext, f.binding.passphrase)); assert.deepEqual(record.nativeBinding, expected);
  await store.close(); const again = await opened(f, t, "open"); assert.deepEqual(await again.status(), status);
  assert.equal((await again.status()).last?.attemptRef, reservation.attemptRef); assert.equal(await readFile(path, "utf8"), ciphertext);
  await assert.rejects(again.reserve({ plan, nativeBinding: expected }));
});

test("invalid and executable native binding graphs refuse before reservation writes", async t => {
  const f = await fixture(t), store = await opened(f, t), { plan } = await leafPlan(f);
  const valid = { epochId: "c".repeat(32), requestRef: "request-1", purpose: "history-analysis" as const }; let calls = 0;
  for (const nativeBinding of [undefined, null, { ...valid, epochId: "c".repeat(31) }, { ...valid, epochId: "c".repeat(33) },
    { ...valid, epochId: "C".repeat(32) }, { ...valid, epochId: "g".repeat(32) }, { ...valid, requestRef: "" },
    { ...valid, requestRef: "-invalid-start" }, { ...valid, requestRef: "request/1" }, { ...valid, requestRef: "request\n" },
    { ...valid, requestRef: "r".repeat(129) }, { ...valid, purpose: "conversation" }, { ...valid, extra: true },
    { ...valid, get epochId() { calls++; return valid.epochId; } },
    new Proxy(valid, { getPrototypeOf() { calls++; throw Error("binding trap"); } })])
    await assert.rejects(store.reserve({ plan, nativeBinding } as never));
  await assert.rejects(store.reserve({ plan, get nativeBinding() { calls++; return valid; } }));
  assert.equal(calls, 0); assert.equal((await store.status()).attempts, 0); assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
  const maximum = { ...valid, requestRef: "r".repeat(128) }; await store.reserve({ plan, nativeBinding: maximum });
  assert.deepEqual((await store.status()).last?.nativeBinding, maximum);
});

test("authenticated native binding tampering refuses invalid schema and breaks prepared-record chain", async t => {
  const f = await fixture(t), store = await opened(f, t), { plan, output } = await leafPlan(f);
  const nativeBinding = { epochId: "d".repeat(32), requestRef: "reserved-request", purpose: "history-analysis" as const };
  const reservation = await store.reserve({ plan, nativeBinding }); await store.prepare({ attemptRef: reservation.attemptRef, output }); await store.close();
  const path = join(f.slot, "attempt-000001.reservation.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.binding.passphrase));
  const preparedBytes = await readFile(join(f.slot, "attempt-000001.prepared.enc"));
  for (const change of [{ purpose: "conversation" }, { epochId: "bad-epoch" }, { requestRef: "different-valid-request" }]) {
    const value = structuredClone(original); Object.assign(value.nativeBinding, change);
    const ciphertext = await encryptSession(JSON.stringify(value), f.binding.passphrase); await writeFile(path, ciphertext);
    const again = await opened(f, t, "open"), status = await again.status(); assert.equal(status.storage, "tail-refused");
    assert.equal(status.attempts, "requestRef" in change ? 1 : 0); assert.equal(status.last?.prepared, undefined); assert.equal(status.modelReplayAllowed, false);
    await assert.rejects(again.commitPrepared({ attemptRef: reservation.attemptRef })); await assert.rejects(again.reserve({ plan, nativeBinding }));
    assert.equal(await readFile(path, "utf8"), ciphertext); assert.deepEqual(await readFile(join(f.slot, "attempt-000001.prepared.enc")), preparedBytes); await again.close();
  }
});

test("prepared output, node commit and native outcome are independently durable and retries are exact", async t => {
  const f = await fixture(t), store = await opened(f, t), { plan, output } = await leafPlan(f), reservation = await store.reserve({ plan });
  const prepared = await store.prepare({ attemptRef: reservation.attemptRef, output }); assert.match(prepared.last!.prepared!.outputHash, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await store.prepare({ attemptRef: reservation.attemptRef, output }), prepared);
  await assert.rejects(store.prepare({ attemptRef: reservation.attemptRef, output: { ...output, summary: "Different result" } }));
  const node = await store.commitPrepared({ attemptRef: reservation.attemptRef }); assert.equal(node.index, 1);
  const saved = (await f.analysis.readNodeAt(1))!; assert.equal(saved.nodeRef, node.nodeRef); assert.equal(saved.hash, node.hash); assert.deepEqual(saved.output, output);
  const afterNode = await files(f.slot); assert.deepEqual(await store.commitPrepared({ attemptRef: reservation.attemptRef }), node); assert.deepEqual(await files(f.slot), afterNode);
  await assert.rejects(store.reserve({ plan: (await leafPlan(f, 2)).plan }));
  const unknown = await store.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome: "unknown" });
  assert.equal(unknown.last?.modelOutcome, "unknown"); assert.deepEqual(unknown.last?.node, node); assert.equal(unknown.modelReplayAllowed, false);
  const recorded = await files(f.slot); assert.deepEqual(await store.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome: "unknown" }), unknown);
  await assert.rejects(store.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome: "observed" })); assert.deepEqual(await files(f.slot), recorded);
  // The ledger checks two records; settlement of a real native owner remains a host gate.
  const next = await store.reserve({ plan: (await leafPlan(f, 2)).plan }); assert.equal(next.nodeIndex, 2); assert.notEqual(next.attemptRef, reservation.attemptRef);
});

test("prepared output recovers a lost analysis append acknowledgment using an exact fresh reopened node", async t => {
  const f = await fixture(t), { plan, output } = await leafPlan(f); let appends = 0;
  const store = await openStandingHistoryAnalysisAttemptStore({ ...args(f), mode: "create", analysis: { ...f.analysis, async appendLeaf(input) {
    appends++; await f.analysis.appendLeaf(input); throw Error("synthetic lost append acknowledgment");
  } } }); t.after(() => store.close());
  const reservation = await store.reserve({ plan }); await store.prepare({ attemptRef: reservation.attemptRef, output });
  await assert.rejects(store.commitPrepared({ attemptRef: reservation.attemptRef })); assert.equal(appends, 1); await store.close(); await f.analysis.close();
  const freshAnalysis = await openStandingHistoryAnalysisStore({ ...f.analysisArgs, mode: "open" }); t.after(() => freshAnalysis.close());
  const again = await openStandingHistoryAnalysisAttemptStore({ ...args(f), analysis: { ...freshAnalysis, async appendLeaf() { assert.fail("recovery must not append a duplicate node"); } }, mode: "open" }); t.after(() => again.close());
  const recovered = await again.commitPrepared({ attemptRef: reservation.attemptRef }), actual = (await freshAnalysis.readNodeAt(1))!;
  assert.deepEqual(recovered, { nodeRef: actual.nodeRef, index: actual.index, hash: actual.hash }); assert.equal((await freshAnalysis.status()).analysisNodes, 1);
});

test("native observed may precede preparation; unknown or refused cannot introduce new prepared output", async t => {
  for (const outcome of ["observed", "unknown", "refused"] as const) {
    const f = await fixture(t), store = await opened(f, t), { plan, output } = await leafPlan(f), reservation = await store.reserve({ plan });
    await store.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome }); await assert.rejects(store.reserve({ plan }));
    if (outcome === "observed") {
      await store.prepare({ attemptRef: reservation.attemptRef, output }); await store.commitPrepared({ attemptRef: reservation.attemptRef });
      assert.equal((await store.reserve({ plan: (await leafPlan(f, 2)).plan })).nodeIndex, 2);
    } else { await assert.rejects(store.prepare({ attemptRef: reservation.attemptRef, output })); assert.equal((await f.analysis.status()).analysisNodes, 0); }
  }
});

test("prepared-before-unknown remains recoverable and exact node/native records survive another reopen", async t => {
  const f = await fixture(t), store = await opened(f, t), { plan, output } = await leafPlan(f), reservation = await store.reserve({ plan });
  await store.prepare({ attemptRef: reservation.attemptRef, output }); await store.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome: "unknown" }); await store.close();
  const again = await opened(f, t, "open"), before = await again.status();
  assert.deepEqual(await again.prepare({ attemptRef: reservation.attemptRef, output }), before);
  const node = await again.commitPrepared({ attemptRef: reservation.attemptRef }), status = await again.status();
  assert.equal(status.last?.modelOutcome, "unknown"); assert.deepEqual(status.last?.node, node); assert.equal(status.modelReplayAllowed, false); await again.close();
  const last = await opened(f, t, "open"); assert.deepEqual(await last.status(), status);
  assert.deepEqual(await readdir(f.slot), ["attempt-000001.native.enc", "attempt-000001.node.enc", "attempt-000001.prepared.enc", "attempt-000001.reservation.enc", "intent.enc"]);
});

test("merge reservation commits the retained exact children through the real analysis store", async t => {
  const f = await fixture(t), store = await opened(f, t), children: string[] = [];
  for (const pageIndex of [1, 2]) {
    const { plan, output } = await leafPlan(f, pageIndex), reserved = await store.reserve({ plan });
    await store.prepare({ attemptRef: reserved.attemptRef, output }); children.push((await store.commitPrepared({ attemptRef: reserved.attemptRef })).nodeRef);
    await store.recordModelOutcome({ attemptRef: reserved.attemptRef, outcome: "observed" });
  }
  const head = await f.analysis.status(), source = await f.pages.status(), first = (await f.analysis.readNodeAt(1))!;
  const plan: Plan = { kind: "merge", sourceHead: source.readProgress.chainHash, expectedHead: head.headHash, nodeIndex: 3, modelInputHash: "a".repeat(64), children };
  const reservation = await store.reserve({ plan }); await store.prepare({ attemptRef: reservation.attemptRef, output: first.output });
  const committed = await store.commitPrepared({ attemptRef: reservation.attemptRef }), actual = (await f.analysis.readNodeAt(3))!;
  assert.equal(actual.kind, "merge"); assert.deepEqual(actual.inputs, { children }); assert.deepEqual(actual.output, first.output);
  assert.deepEqual(committed, { nodeRef: actual.nodeRef, index: 3, hash: actual.hash }); await store.close();
  const again = await opened(f, t, "open"); assert.deepEqual((await again.status()).last?.node, committed); assert.equal((await again.status()).attempts, 3);
});

test("recovery refuses an independently committed node with different output or source inputs", async t => {
  for (const mismatch of ["output", "inputs"] as const) {
    const f = await fixture(t), store = await opened(f, t), a = await leafPlan(f), b = await leafPlan(f, 2), reservation = await store.reserve({ plan: a.plan });
    await store.prepare({ attemptRef: reservation.attemptRef, output: a.output }); assert.equal(a.plan.kind, "leaf"); assert.equal(b.plan.kind, "leaf");
    if (a.plan.kind !== "leaf" || b.plan.kind !== "leaf") return;
    await f.analysis.appendLeaf({ expectedHead: a.plan.expectedHead, inputs: mismatch === "inputs" ? b.plan.inputs : a.plan.inputs,
      output: mismatch === "inputs" ? b.output : { ...a.output, summary: "Foreign output at reserved index" } });
    await assert.rejects(store.commitPrepared({ attemptRef: reservation.attemptRef })); assert.equal((await store.status()).last?.node, undefined);
    assert.equal((await f.analysis.status()).analysisNodes, 1);
  }
});

test("partial and authenticated malformed tails preserve the reservation while refusing further writes", async t => {
  const f = await fixture(t), store = await opened(f, t), { plan, output } = await leafPlan(f), reservation = await store.reserve({ plan });
  await store.prepare({ attemptRef: reservation.attemptRef, output }); await store.close();
  const path = join(f.slot, "attempt-000001.prepared.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.binding.passphrase));
  for (const cipher of ["retained partial prepared output", await encryptSession(JSON.stringify({ ...original, extra: "invalid canonical record" }), f.binding.passphrase)]) {
    await writeFile(path, cipher); const again = await opened(f, t, "open"), status = await again.status();
    assert.equal(status.storage, "tail-refused"); assert.equal(status.attempts, 1); assert.equal(status.last?.attemptRef, reservation.attemptRef); assert.equal(status.last?.prepared, undefined);
    await assert.rejects(again.prepare({ attemptRef: reservation.attemptRef, output })); await assert.rejects(again.commitPrepared({ attemptRef: reservation.attemptRef }));
    await assert.rejects(again.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome: "unknown" }));
    assert.equal(await readFile(path, "utf8"), cipher); await again.close();
  }
});

test("intent and passphrase binding, noncreating open and unknown files preserve prior custody", async t => {
  const f = await fixture(t); await assert.rejects(openStandingHistoryAnalysisAttemptStore({ ...args(f), mode: "open" })); assert.deepEqual(await readdir(f.directory), []);
  const store = await opened(f, t), { plan } = await leafPlan(f); await store.reserve({ plan }); await store.close(); const before = await files(f.slot);
  for (const delta of [{ requesterId: "457" }, { primaryMessageId: 1000 }, { objective: "Another objective" }, { chatId: "-100999" }])
    await assert.rejects(openStandingHistoryAnalysisAttemptStore({ ...args(f), intent: { ...f.binding.intent, ...delta }, mode: "open" }));
  await assert.rejects(openStandingHistoryAnalysisAttemptStore({ ...args(f), passphrase: "wrong-but-long-passphrase", mode: "open" })); assert.deepEqual(await files(f.slot), before);
  await writeFile(join(f.slot, "unknown.bin"), "retained unknown evidence"); const again = await opened(f, t, "open");
  assert.equal((await again.status()).storage, "tail-refused"); await assert.rejects(again.reserve({ plan }));
});

test("inert reservation and prepared graphs invoke no getters or proxy traps and snapshot before await", async t => {
  const f = await fixture(t), store = await opened(f, t), { plan, output } = await leafPlan(f); let calls = 0;
  for (const value of [{ get plan() { calls++; return plan; } }, { plan: new Proxy(plan, { getPrototypeOf() { calls++; throw Error("trap"); } }) }])
    await assert.rejects(store.reserve(value));
  assert.equal(calls, 0); assert.equal((await store.status()).attempts, 0);
  const mutable = structuredClone(plan), pending = store.reserve({ plan: mutable }); (mutable as { modelInputHash: string }).modelInputHash = "0".repeat(64);
  const reservation = await pending;
  for (const value of [{ attemptRef: reservation.attemptRef, get output() { calls++; return output; } },
    { attemptRef: reservation.attemptRef, output: new Proxy(output, { ownKeys() { calls++; throw Error("trap"); } }) }]) await assert.rejects(store.prepare(value));
  assert.equal(calls, 0); await store.prepare({ attemptRef: reservation.attemptRef, output });
  const content = JSON.parse(await decryptSession(await readFile(join(f.slot, "attempt-000001.reservation.enc"), "utf8"), f.binding.passphrase));
  assert.ok(JSON.stringify(content).includes(plan.modelInputHash));
});

test("factory capability getters and hostile recovery node graphs execute no code", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(openStandingHistoryAnalysisAttemptStore({ ...args(f), mode: "create", analysis: { ...f.analysis, get status() { calls++; return f.analysis.status; } } }));
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.directory), []);
  const { plan, output } = await leafPlan(f), store = await opened(f, t), reservation = await store.reserve({ plan });
  await store.prepare({ attemptRef: reservation.attemptRef, output }); await store.close();
  assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") return;
  const actual = await f.analysis.appendLeaf({ expectedHead: plan.expectedHead, inputs: plan.inputs, output });
  const again = await openStandingHistoryAnalysisAttemptStore({ ...args(f), mode: "open", analysis: { ...f.analysis,
    async readNodeAt() { return { ...actual, get output() { calls++; return output; } }; } } }); t.after(() => again.close());
  await assert.rejects(again.commitPrepared({ attemptRef: reservation.attemptRef })); assert.equal(calls, 0);
});

test("close joins an admitted analysis callback without closing the borrowed analysis store", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), { plan, output } = await leafPlan(f);
  const store = await openStandingHistoryAnalysisAttemptStore({ ...args(f), mode: "create", analysis: { ...f.analysis, async appendLeaf(input) {
    entered.resolve(); await release.promise; return f.analysis.appendLeaf(input);
  } } }); t.after(() => store.close());
  const reservation = await store.reserve({ plan }); await store.prepare({ attemptRef: reservation.attemptRef, output });
  const pending = store.commitPrepared({ attemptRef: reservation.attemptRef }).then(value => value, () => undefined); await entered.promise;
  let closed = false; const closing = store.close().then(() => { closed = true; }); await immediate(); assert.equal(closed, false);
  release.resolve(); await closing; await pending; assert.equal(closed, true); await assert.rejects(store.status());
  assert.equal((await f.analysis.status()).analysisNodes, 1);
  const again = await opened(f, t, "open"), recovered = await again.commitPrepared({ attemptRef: reservation.attemptRef }); assert.equal(recovered.index, 1);
});

test("abort rejects fresh creation and joins an admitted borrowed analysis callback", async t => {
  const f = await fixture(t), aborted = new AbortController(); aborted.abort();
  await assert.rejects(openStandingHistoryAnalysisAttemptStore({ ...args(f), mode: "create", signal: aborted.signal })); assert.deepEqual(await readdir(f.directory), []);
  const controller = new AbortController(), entered = deferred(), release = deferred(), { plan, output } = await leafPlan(f);
  const store = await openStandingHistoryAnalysisAttemptStore({ ...args(f), mode: "create", signal: controller.signal, analysis: { ...f.analysis, async appendLeaf(input) {
    entered.resolve(); await release.promise; return f.analysis.appendLeaf(input);
  } } }); t.after(() => store.close());
  const reservation = await store.reserve({ plan }); await store.prepare({ attemptRef: reservation.attemptRef, output }); let settled = false;
  const pending = store.commitPrepared({ attemptRef: reservation.attemptRef }).then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; controller.abort(); await immediate(); assert.equal(settled, false);
  release.resolve(); await pending; await store.close(); await assert.rejects(store.status());
  assert.equal((await f.analysis.status()).analysisNodes, 1);
});
