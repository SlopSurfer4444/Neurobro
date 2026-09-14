import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { encryptSession, decryptSession } from "../src/session-crypto.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { projectStandingHistorySource, type StandingHistorySourceFragment } from "../src/standing-history-source-projection.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import type { SelfHistoryTaskCheckpoint, SelfHistoryTaskPage } from "../src/self-history-reader.js";

const intent = (): StandingHistoryTaskIntent => ({ schema: "standing-history-task-v1", taskId: "htask_" + "1".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 789, fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Синтетическое обсуждение секретного проекта" });
type Store = Awaited<ReturnType<typeof openStandingHistoryAnalysisStore>>;
type LeafInput = Parameters<Store["appendLeaf"]>[0];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function page(before: SelfHistoryTaskCheckpoint, count = 1): SelfHistoryTaskPage {
  const sources = Array.from({ length: count }, (_, i) => ({ messageId: (before.offsetId || 1000) - i - 1, date: before.lastDate - i - 1,
    disposition: "included" as const, messageRef: "m_" + ((before.offsetId || 1000) - i - 1).toString(16).padStart(24, "0"), authorId: "456" }));
  const next = { ...before, offsetId: sources.at(-1)?.messageId ?? before.offsetId, lastDate: sources.at(-1)?.date ?? before.lastDate,
    oldestDate: sources.at(-1)?.date ?? before.oldestDate, newestDate: before.newestDate ?? sources[0]?.date ?? null, pages: before.pages + 1,
    upperBoundMessageId: before.upperBoundMessageId ?? sources[0]?.messageId ?? null, status: count ? "more" as const : "empty-page" as const };
  return { beforeCheckpoint: before, nextCheckpoint: next, sources, page: { schema: "neurobro-self-history-v1", fromDate: before.fromDate, toDate: before.toDate,
    messages: sources.map(s => ({ ref: s.messageRef, authorRef: "a_" + "2".repeat(24), author: "user" as const, displayName: "Секретное имя участника",
      date: s.date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Секретный исходный текст " + s.messageId + " " + "я".repeat(120) })).reverse(),
    cursor: null, hasMore: count > 0, status: next.status,
    coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate, traversalComplete: count === 0, undatedEntries: 0, pages: next.pages },
    excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
    limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } };
}
async function fixture(t: TestContext, counts = [1, 1], transform: (value: SelfHistoryTaskPage) => SelfHistoryTaskPage = value => value) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-analysis-store-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-analysis-store-"))); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, "analysis"), sourceDirectory = join(root, "sources"); await mkdir(directory); await mkdir(sourceDirectory);
  const binding = { passphrase: "synthetic-analysis-store-passphrase", intent: intent() };
  const source = await openStandingHistoryTaskStore({ ...binding, directory: sourceDirectory, mode: "create" });
  t.after(() => source.close());
  for (const count of counts) { const before = (await source.status()).readProgress.checkpoint; await source.appendPage({ expectedCheckpoint: before, result: transform(page(before, count)) }); }
  const args = { ...binding, directory, readSourcePage: (index: number) => source.readPage(index) };
  return { root, args, source, slot: join(directory, binding.intent.taskId), sourceSlot: join(sourceDirectory, binding.intent.taskId) };
}
async function created(f: Awaited<ReturnType<typeof fixture>>, t: TestContext) {
  const store = await openStandingHistoryAnalysisStore({ ...f.args, mode: "create" }); t.after(() => store.close()); return store;
}
async function projected(f: Awaited<ReturnType<typeof fixture>>, store: Store, pageIndex = 1, maxBytes = 48 * 1024, position?: string) {
  return projectStandingHistorySource({ intent: f.args.intent, referenceKey: store.referenceKey(), storedPage: (await f.source.readPage(pageIndex))!, maxBytes,
    ...(position === undefined ? {} : { position }) });
}
function output(fragment: StandingHistorySourceFragment): LeafInput["output"] {
  return { summary: "Секретное резюме модели", claims: fragment.rows.length ? [{ kind: "reported", text: "Непроверенное утверждение модели",
    supports: [{ sourceRef: fragment.rows[0]!.sourceRef, versionRef: fragment.rows[0]!.versionRef }] }] : [], omittedDetailCount: 0 };
}
function input(fragment: StandingHistorySourceFragment, maxBytes = 48 * 1024, position?: string): LeafInput["inputs"][number] {
  return { pageIndex: fragment.pageIndex, materialRef: fragment.materialRef, maxBytes, ...(position === undefined ? {} : { position }) };
}
async function leaf(f: Awaited<ReturnType<typeof fixture>>, store: Store, pageIndex = 1) {
  const fragment = await projected(f, store, pageIndex);
  return store.appendLeaf({ expectedHead: (await store.status()).headHash, inputs: [input(fragment)], output: output(fragment) });
}

test("encrypted independent ledger preserves key, exact leaf/merge nodes and source frontier across reopen", async t => {
  const f = await fixture(t), originalSource = await readFile(join(f.sourceSlot, "page-000001.enc")), before = await f.source.status(), store = await created(f, t);
  const key = store.referenceKey(); assert.match(key, /^[0-9a-f]{64}$/u);
  const a = await leaf(f, store), b = await leaf(f, store, 2);
  const merged = await store.appendMerge({ expectedHead: b.hash, children: [a.nodeRef, b.nodeRef], output: a.output });
  assert.match(a.nodeRef, /^hnode_[0-9a-f]{48}$/u); assert.equal(a.kind, "leaf"); assert.equal(merged.kind, "merge");
  if (!("materials" in a.inputs)) throw Error();
  assert.equal(Object.hasOwn(a.inputs.materials[0]!, "maxRows"), false);
  const status = await store.status(); assert.equal(status.analysisNodes, 3); assert.equal(status.leafNodes, 2); assert.equal(status.headHash, merged.hash);
  assert.equal(status.claims, "model-authored-unverified"); assert.equal(status.storage, "ready");
  const mergeEnvelope = JSON.parse(await decryptSession(await readFile(join(f.slot, "node-000003.enc"), "utf8"), f.args.passphrase));
  assert.deepEqual(mergeEnvelope.node.inputs, { children: [a.nodeRef, b.nodeRef] });
  assert.deepEqual(mergeEnvelope.node.coverage, { schema: "standing-history-analysis-coverage-v1", spanCount: merged.coverage.length,
    sourceRows: merged.coverage.reduce((n, span) => n + span.range.toRow - span.range.fromRow, 0),
    emptyPageMarkers: merged.coverage.filter(span => span.range.totalRows === 0).length, commitment: digest(merged.coverage) });
  assert.equal(merged.hash, digest(mergeEnvelope));
  for (const span of merged.coverage) {
    assert.equal(JSON.stringify(mergeEnvelope).includes(span.materialRef), false);
    assert.equal(JSON.stringify(mergeEnvelope).includes(span.pageHash), false);
  }
  const maximumCompactCoverage = { ...mergeEnvelope.node.coverage, spanCount: 8192, sourceRows: 819200, emptyPageMarkers: 8192 };
  assert.ok(Buffer.byteLength(JSON.stringify(maximumCompactCoverage)) < 256);
  const fragment = await projected(f, store); await store.close();
  const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" }); t.after(() => reopened.close());
  assert.equal(reopened.referenceKey(), key); assert.deepEqual(await projected(f, reopened), fragment);
  for (const node of [a, b, merged]) assert.deepEqual(await reopened.readNode(node.nodeRef), node);
  assert.equal(await reopened.readNode("hnode_" + "f".repeat(48)), undefined);
  assert.deepEqual(await f.source.status(), before); assert.deepEqual(await readFile(join(f.sourceSlot, "page-000001.enc")), originalSource);
  assert.deepEqual(await readdir(f.slot), ["intent.enc", "node-000001.enc", "node-000002.enc", "node-000003.enc"]);
  for (const name of await readdir(f.slot)) {
    const ciphertext = await readFile(join(f.slot, name), "utf8");
    for (const raw of [key, "Секретное", "исходный текст", "Непроверенное", fragment.rows[0]!.sourceRef, "-100456", "referenceKey", "summary"])
      assert.equal(ciphertext.includes(raw), false, name + " leaked " + raw);
  }
});

test("disjoint fragments of one page survive reopen and retain exact row coverage without double counting", async t => {
  const f = await fixture(t, [8]), store = await created(f, t), maxBytes = 2300;
  let position: string | undefined, head = (await store.status()).headHash, row = 0;
  const refs: string[] = [], materialRefs: string[] = [];
  do {
    const fragment = await projected(f, store, 1, maxBytes, position); assert.equal(fragment.range.fromRow, row);
    const node = await store.appendLeaf({ expectedHead: head, inputs: [input(fragment, maxBytes, position)], output: output(fragment) });
    assert.ok(JSON.stringify(node.inputs).includes(fragment.pageHash)); assert.ok(JSON.stringify(node.inputs).includes(JSON.stringify(fragment.range)));
    assert.ok(JSON.stringify(node.inputs).includes(JSON.stringify(fragment.coverage)));
    assert.equal(materialRefs.includes(fragment.materialRef), false); materialRefs.push(fragment.materialRef);
    refs.push(node.nodeRef); row = fragment.range.toRow; head = node.hash; position = fragment.nextPosition ?? undefined;
  } while (position !== undefined);
  assert.equal(row, 8); assert.ok(refs.length > 1); assert.equal((await store.status()).leafNodes, refs.length);
  await store.close(); const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" }); t.after(() => reopened.close());
  const merged = await reopened.appendMerge({ expectedHead: head, children: refs, output: { summary: "Объединённые фрагменты", claims: [] } });
  assert.equal(merged.index, refs.length + 1); assert.equal((await reopened.status()).leafNodes, refs.length);
});

test("maxRows persists exact one-row gap inputs across ledger reopen and cannot overlap an already covered fragment", async t => {
  const f = await fixture(t, [4]), store = await created(f, t), stored = (await f.source.readPage(1))!;
  const fragment = (maxRows: number, position?: string) => projectStandingHistorySource({ intent: f.args.intent, referenceKey: store.referenceKey(), storedPage: stored, maxRows,
    ...(position === undefined ? {} : { position }) });
  const first = fragment(1), middle = fragment(1, first.nextPosition!);
  const covered = await store.appendLeaf({ expectedHead: (await store.status()).headHash, inputs: [{ ...input(middle, 49152, first.nextPosition!), maxRows: 1 }], output: output(middle) });
  const whole = await projected(f, store);
  await assert.rejects(store.appendLeaf({ expectedHead: covered.hash, inputs: [input(whole)], output: output(whole) }), /OVERLAP/u);
  assert.equal((await store.status()).headHash, covered.hash);
  const gap = await store.appendLeaf({ expectedHead: covered.hash, inputs: [{ ...input(first), maxRows: 1 }], output: output(first) });
  const rest = fragment(2, middle.nextPosition!);
  const tail = await store.appendLeaf({ expectedHead: gap.hash, inputs: [{ ...input(rest, 49152, middle.nextPosition!), maxRows: 2 }], output: output(rest) });
  assert.deepEqual([first.range, middle.range, rest.range].map(r => [r.fromRow, r.toRow]), [[0, 1], [1, 2], [2, 4]]);
  const raw = JSON.parse(await decryptSession(await readFile(join(f.slot, "node-000002.enc"), "utf8"), f.args.passphrase));
  assert.equal(raw.node.inputs.materials[0].maxRows, 1); assert.equal(gap.hash, digest(raw)); await store.close();
  const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" }); t.after(() => reopened.close());
  assert.equal((await reopened.status()).storage, "ready"); assert.equal((await reopened.status()).headHash, tail.hash);
  for (const node of [covered, gap, tail]) assert.deepEqual(await reopened.readNode(node.nodeRef), node);
  await assert.rejects(reopened.appendLeaf({ expectedHead: tail.hash, inputs: [{ ...input(first), maxRows: 1 }], output: output(first) }), /OVERLAP/u);
  const merged = await reopened.appendMerge({ expectedHead: tail.hash, children: [gap.nodeRef, covered.nodeRef, tail.nodeRef], output: { summary: "All disjoint rows", claims: [] } });
  assert.equal(merged.coverage.reduce((n, span) => n + span.range.toRow - span.range.fromRow, 0), 4);
});

test("maxRows invalid or accessor material inputs cannot read sources or change encrypted ledger head", async t => {
  const f = await fixture(t, [2]); let sourceReads = 0;
  const store = await openStandingHistoryAnalysisStore({ ...f.args, mode: "create", readSourcePage: index => { sourceReads++; return f.source.readPage(index); } }); t.after(() => store.close());
  const all = await projected(f, store), before = await store.status(); sourceReads = 0;
  for (const value of [0, 101, 1.5, "1", null, undefined, NaN, Infinity]) await assert.rejects(store.appendLeaf({ expectedHead: before.headHash,
    inputs: [{ ...input(all), maxRows: value as number }], output: output(all) }), /INPUT/u);
  let accessed = 0; const hostile = input(all); Object.defineProperty(hostile, "maxRows", { enumerable: true, get() { accessed++; return 1; } });
  await assert.rejects(store.appendLeaf({ expectedHead: before.headHash, inputs: [hostile], output: output(all) }), /INPUT/u);
  assert.equal(accessed, 0); assert.equal(sourceReads, 0); assert.deepEqual(await store.status(), before); assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
});

test("CAS, duplicate inputs, overlapping fragments and forged material leave the current head unchanged", async t => {
  const f = await fixture(t, [8, 1]), store = await created(f, t), initial = (await store.status()).headHash;
  const fragment = await projected(f, store, 1, 2300), first = await store.appendLeaf({ expectedHead: initial, inputs: [input(fragment, 2300)], output: output(fragment) });
  const second = await projected(f, store, 2), whole = await projected(f, store, 1);
  for (const request of [
    { expectedHead: initial, inputs: [input(second)], output: output(second) },
    { expectedHead: first.hash, inputs: [input(fragment, 2300)], output: output(fragment) },
    { expectedHead: first.hash, inputs: [input(whole)], output: output(whole) },
    { expectedHead: first.hash, inputs: [input(second), input(second)], output: output(second) },
    { expectedHead: first.hash, inputs: [{ ...input(second), materialRef: "hmat_" + "0".repeat(48) }], output: output(second) },
  ]) await assert.rejects(store.appendLeaf(request));
  assert.equal((await store.status()).headHash, first.hash); assert.equal((await store.status()).analysisNodes, 1);
});

test("supports cannot cite an unconsumed source/version or a child claim omitted by an intermediate merge", async t => {
  const f = await fixture(t), store = await created(f, t), first = await projected(f, store), other = await projected(f, store, 2), head = (await store.status()).headHash;
  for (const bad of [output(other), { ...output(first), claims: [{ kind: "inference" as const, text: "Forged version", supports: [{ sourceRef: first.rows[0]!.sourceRef, versionRef: "hver_" + "0".repeat(48) }] }] }])
    await assert.rejects(store.appendLeaf({ expectedHead: head, inputs: [input(first)], output: bad }));
  const a = await leaf(f, store), b = await leaf(f, store, 2);
  const merged = await store.appendMerge({ expectedHead: b.hash, children: [a.nodeRef, b.nodeRef], output: { summary: "Claims deliberately omitted", claims: [] } });
  await assert.rejects(store.appendMerge({ expectedHead: merged.hash, children: [merged.nodeRef], output: a.output }));
  await assert.rejects(store.appendMerge({ expectedHead: merged.hash, children: [merged.nodeRef, a.nodeRef], output: { summary: "Overlapping descendants", claims: [] } }));
  await assert.rejects(store.appendMerge({ expectedHead: merged.hash, children: [a.nodeRef, a.nodeRef], output: a.output }));
  await assert.rejects(store.appendMerge({ expectedHead: merged.hash, children: ["hnode_" + "0".repeat(48)], output: a.output }));
  assert.equal((await store.status()).headHash, merged.hash);
});

test("empty page has one durable coverage marker and cannot be appended twice", async t => {
  const f = await fixture(t, [0]), store = await created(f, t), fragment = await projected(f, store), a = await leaf(f, store);
  assert.equal(fragment.rows.length, 0); assert.ok(JSON.stringify(a.inputs).includes(JSON.stringify(fragment.range)));
  await assert.rejects(leaf(f, store)); assert.equal((await store.status()).leafNodes, 1);
});

test("excluded source rows preserve coverage but cannot support model factual claims", async t => {
  const f = await fixture(t, [2], value => ({ ...value,
    sources: [{ messageId: value.sources[0]!.messageId, date: value.sources[0]!.date, disposition: "nonText" }, value.sources[1]!],
    page: { ...value.page, messages: [value.page.messages[0]!], excluded: { ...value.page.excluded, nonText: 1 } } }));
  const store = await created(f, t), fragment = await projected(f, store), excluded = fragment.rows[0]!, included = fragment.rows[1]!;
  assert.equal(excluded.disposition, "nonText"); assert.equal(included.disposition, "included");
  const head = (await store.status()).headHash;
  await assert.rejects(store.appendLeaf({ expectedHead: head, inputs: [input(fragment)], output: output(fragment) }));
  const saved = await store.appendLeaf({ expectedHead: head, inputs: [input(fragment)], output: { summary: "Only actual text supports this claim", claims: [{ kind: "reported", text: "Observed text",
    supports: [{ sourceRef: included.sourceRef, versionRef: included.versionRef }] }] } });
  assert.ok(JSON.stringify(saved.coverage).includes('"nonText":1'));
});

test("output byte/count bounds and invalid claim shapes refuse before committing", async t => {
  const f = await fixture(t), store = await created(f, t), fragment = await projected(f, store), head = (await store.status()).headHash, valid = output(fragment), claim = valid.claims[0]!;
  for (const bad of [{ ...valid, summary: "я".repeat(2049) }, { ...valid, claims: Array(17).fill(claim) },
    { ...valid, claims: [{ ...claim, text: "я".repeat(513) }] }, { ...valid, claims: [{ ...claim, supports: [] }] },
    { ...valid, claims: [{ ...claim, supports: Array(17).fill(claim.supports[0]) }] }, { ...valid, omittedDetailCount: -1 },
    { ...valid, claims: [{ ...claim, kind: "verified" }] }])
    await assert.rejects(store.appendLeaf({ expectedHead: head, inputs: [input(fragment)], output: bad as never }));
  assert.equal((await store.status()).analysisNodes, 0); assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
});

test("hostile request graphs run no getters or proxy traps and add no files", async t => {
  const f = await fixture(t), store = await created(f, t), fragment = await projected(f, store), request = { expectedHead: (await store.status()).headHash, inputs: [input(fragment)], output: output(fragment) };
  let calls = 0;
  for (const hostile of [{ ...request, get inputs() { calls++; return []; } }, new Proxy(request, { getPrototypeOf() { calls++; throw Error("trap"); } }),
    { ...request, inputs: [{ ...request.inputs[0], get materialRef() { calls++; return fragment.materialRef; } }] },
    { ...request, output: { ...request.output, claims: [{ ...request.output.claims[0], get text() { calls++; return "bad"; } }] } },
    { ...request, inputs: new Proxy(request.inputs, { get() { calls++; throw Error("trap"); } }) }]) await assert.rejects(store.appendLeaf(hostile as never));
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
});

test("append snapshots mutable caller output and input before the source callback await", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const store = await openStandingHistoryAnalysisStore({ ...f.args, mode: "create", readSourcePage: async index => { entered.resolve(); await release.promise; return f.source.readPage(index); } }); t.after(() => store.close());
  const fragment = await projected(f, store), request = structuredClone({ expectedHead: (await store.status()).headHash, inputs: [input(fragment)], output: output(fragment) });
  const pending = store.appendLeaf(request); await entered.promise;
  (request.inputs[0]! as { materialRef: string }).materialRef = "hmat_" + "f".repeat(48); (request.output as { summary: string }).summary = "Changed after admission";
  release.resolve(); const saved = await pending; assert.equal(saved.output.summary, "Секретное резюме модели");
});

test("missing, rebound and hostile callback source pages cannot produce a node", async t => {
  const f = await fixture(t); let replacement: unknown, calls = 0;
  const store = await openStandingHistoryAnalysisStore({ ...f.args, mode: "create", readSourcePage: async () => replacement as never }); t.after(() => store.close());
  const fragment = await projected(f, store), stored = (await f.source.readPage(1))!, head = (await store.status()).headHash;
  for (const candidate of [undefined, { ...stored, index: 2 }, { ...stored, hash: "0".repeat(64) },
    { ...stored, get result() { calls++; return stored.result; } }, new Proxy(stored, { getPrototypeOf() { calls++; throw Error("trap"); } })]) {
    replacement = candidate;
    await assert.rejects(store.appendLeaf({ expectedHead: head, inputs: [input(fragment)], output: output(fragment) }));
  }
  assert.equal(calls, 0); assert.equal((await store.status()).analysisNodes, 0);
});

test("partial/gapped tails expose only the authenticated prefix and refuse all appends without rewriting bytes", async t => {
  const f = await fixture(t), store = await created(f, t), a = await leaf(f, store); await store.close();
  for (const name of ["node-000002.enc", "node-000003.enc"]) {
    const path = join(f.slot, name); await writeFile(path, "retained partial ciphertext");
    const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" });
    assert.equal((await reopened.status()).storage, "tail-refused"); assert.equal((await reopened.status()).analysisNodes, 1); assert.deepEqual(await reopened.readNode(a.nodeRef), a);
    await assert.rejects(leaf(f, reopened, 2)); await assert.rejects(reopened.appendMerge({ expectedHead: a.hash, children: [a.nodeRef], output: a.output }));
    await reopened.close(); assert.equal(await readFile(path, "utf8"), "retained partial ciphertext"); await rename(path, join(f.root, "retained-" + name));
  }
});

test("authenticated malformed node envelopes cannot advance the chain or alter a good prefix", async t => {
  const f = await fixture(t), store = await created(f, t), a = await leaf(f, store); await leaf(f, store, 2); await store.close();
  const path = join(f.slot, "node-000002.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  // Each mutation remains correctly encrypted; canonical chain validation must reject it.
  for (const mutate of [(v: any) => { v.previousHash = "0".repeat(64); }, (v: any) => { v.intentHash = "0".repeat(64); },
    (v: any) => { v.index = 17; }, (v: any) => { v.extra = "unauthorized envelope field"; },
    (v: any) => { v.node.inputs.materials[0].range.toRow = 0; },
    (v: any) => { v.node.inputs.materials[0].coverage.sourceRowsReturned = 17; },
    (v: any) => { v.node.inputs.materials[0].supports[0].versionRef = "hver_" + "0".repeat(48); },
    (v: any) => { v.node.output.claims[0].supports[0].versionRef = "hver_" + "0".repeat(48); }]) {
    const bad = structuredClone(original); mutate(bad); await writeFile(path, await encryptSession(JSON.stringify(bad), f.args.passphrase));
    const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" });
    assert.equal((await reopened.status()).storage, "tail-refused"); assert.equal((await reopened.status()).analysisNodes, 1);
    assert.deepEqual(await reopened.readNode(a.nodeRef), a); await reopened.close();
  }
});

test("compact merge commitment tampering refuses the merge while retained leaves remain readable", async t => {
  const f = await fixture(t), store = await created(f, t), a = await leaf(f, store), b = await leaf(f, store, 2);
  const merged = await store.appendMerge({ expectedHead: b.hash, children: [a.nodeRef, b.nodeRef], output: a.output }); await store.close();
  const path = join(f.slot, "node-000003.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  for (const change of [{ spanCount: 1 }, { sourceRows: 3 }, { emptyPageMarkers: 1 }, { commitment: "0".repeat(64) }]) {
    const bad = structuredClone(original); Object.assign(bad.node.coverage, change); await writeFile(path, await encryptSession(JSON.stringify(bad), f.args.passphrase));
    const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" });
    const status = await reopened.status(); assert.equal(status.storage, "tail-refused"); assert.equal(status.analysisNodes, 2);
    assert.deepEqual(await reopened.readNode(a.nodeRef), a); assert.deepEqual(await reopened.readNode(b.nodeRef), b);
    assert.equal(await reopened.readNode(merged.nodeRef), undefined); await reopened.close();
  }
});

test("noncreating open, intent binding and wrong passphrase preserve prior ledger", async t => {
  const f = await fixture(t); await assert.rejects(openStandingHistoryAnalysisStore({ ...f.args, mode: "open" })); assert.deepEqual(await readdir(f.args.directory), []);
  const store = await created(f, t); await store.close(); const before = await readFile(join(f.slot, "intent.enc"));
  for (const edit of [{ requesterId: "457" }, { primaryMessageId: 790 }, { objective: "Another objective" }, { timezone: "UTC" }, { toDate: 201 }])
    await assert.rejects(openStandingHistoryAnalysisStore({ ...f.args, intent: { ...f.args.intent, ...edit }, mode: "open" }));
  await assert.rejects(openStandingHistoryAnalysisStore({ ...f.args, passphrase: "wrong-but-long-passphrase", mode: "open" }));
  await assert.rejects(openStandingHistoryAnalysisStore({ ...f.args, mode: "create" })); assert.deepEqual(await readFile(join(f.slot, "intent.enc")), before);
});

test("close and abort join an admitted source callback before completing, then forbid new work", async t => {
  for (const cancel of ["close", "abort"] as const) {
    const f = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
    const store = await openStandingHistoryAnalysisStore({ ...f.args, mode: "create", signal: controller.signal,
      readSourcePage: async index => { entered.resolve(); await release.promise; return f.source.readPage(index); } }); t.after(() => store.close());
    const fragment = await projected(f, store), pending = store.appendLeaf({ expectedHead: (await store.status()).headHash, inputs: [input(fragment)], output: output(fragment) });
    const outcome = pending.then(() => "committed", () => "refused"); await entered.promise;
    if (cancel === "abort") controller.abort();
    let closed = false; const closing = store.close().then(() => { closed = true; }); await immediate(); assert.equal(closed, false);
    release.resolve(); await closing; await outcome; assert.equal(closed, true); await assert.rejects(store.status());
    const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" }); assert.equal((await reopened.status()).analysisNodes, 0); await reopened.close();
  }
});

test("aborted creation does not allocate a slot; competing opens cannot overwrite a committed node", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(openStandingHistoryAnalysisStore({ ...f.args, mode: "create", signal: controller.signal })); assert.deepEqual(await readdir(f.args.directory), []);
  const initial = await created(f, t), head = (await initial.status()).headHash; await initial.close();
  const sourceArgs = { directory: join(f.root, "sources"), intent: f.args.intent, passphrase: f.args.passphrase, mode: "open" as const };
  const sourceA = await openStandingHistoryTaskStore(sourceArgs), sourceB = await openStandingHistoryTaskStore(sourceArgs);
  t.after(() => sourceA.close()); t.after(() => sourceB.close());
  // Separate authenticated readers prevent the source store's busy guard from
  // masking the analysis ledger's exclusive-file write race.
  const bothReading = deferred(); let readers = 0;
  const read = (source: typeof sourceA) => async (index: number) => { if (++readers === 2) bothReading.resolve(); await bothReading.promise; return source.readPage(index); };
  const a = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open", readSourcePage: read(sourceA) }),
    b = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open", readSourcePage: read(sourceB) });
  t.after(() => a.close()); t.after(() => b.close()); const first = await projected(f, a), second = await projected(f, b, 2);
  const results = await Promise.allSettled([a.appendLeaf({ expectedHead: head, inputs: [input(first)], output: output(first) }), b.appendLeaf({ expectedHead: head, inputs: [input(second)], output: output(second) })]);
  assert.equal(readers, 2); assert.equal(results.filter(r => r.status === "fulfilled").length, 1); await a.close(); await b.close();
  const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" }); assert.equal((await reopened.status()).analysisNodes, 1); await reopened.close();
});

test("close joins admitted filesystem work and readback reflects only fully persisted nodes", async t => {
  const f = await fixture(t), store = await created(f, t), fragment = await projected(f, store), head = (await store.status()).headHash;
  let settled = false;
  const pending = store.appendLeaf({ expectedHead: head, inputs: [input(fragment)], output: output(fragment) }).then(node => { settled = true; return node; }, () => { settled = true; return undefined; });
  await immediate(); await store.close();
  const atClose = await Promise.all((await readdir(f.slot)).map(async name => [name, await readFile(join(f.slot, name), "utf8")]));
  const node = await pending; assert.equal(settled, true);
  assert.deepEqual(await Promise.all((await readdir(f.slot)).map(async name => [name, await readFile(join(f.slot, name), "utf8")])), atClose);
  const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" }); t.after(() => reopened.close());
  const status = await reopened.status(); assert.ok(status.analysisNodes <= 1);
  if (node) { assert.equal(status.analysisNodes, 1); assert.deepEqual(await reopened.readNode(node.nodeRef), node); }
  await assert.rejects(store.appendLeaf({ expectedHead: head, inputs: [input(fragment)], output: output(fragment) }));
});

test("fresh reopen rediscovers authenticated leaves and merge by index without remembered node refs", async t => {
  const f = await fixture(t);
  {
    const writer = await created(f, t), a = await leaf(f, writer), b = await leaf(f, writer, 2);
    await writer.appendMerge({ expectedHead: b.hash, children: [a.nodeRef, b.nodeRef], output: a.output }); await writer.close();
  }
  const reopened = await openStandingHistoryAnalysisStore({ ...f.args, mode: "open" }); t.after(() => reopened.close());
  const status = await reopened.status(); assert.equal(status.analysisNodes, 3);
  const recovered = [];
  for (let index = 1; index <= status.analysisNodes; index++) {
    const node = await reopened.readNodeAt(index); assert.ok(node); assert.equal(node.index, index); recovered.push(node);
    assert.deepEqual(await reopened.readNode(node.nodeRef), node);
  }
  assert.deepEqual(recovered.map(n => n.kind), ["leaf", "leaf", "merge"]);
  assert.deepEqual(recovered[2]!.inputs, { children: [recovered[0]!.nodeRef, recovered[1]!.nodeRef] });
  assert.deepEqual(recovered[2]!.coverage, [...recovered[0]!.coverage, ...recovered[1]!.coverage]);
  assert.deepEqual(recovered[2]!.output.claims, recovered[0]!.output.claims);
  assert.equal(await reopened.readNodeAt(4), undefined);
  for (const index of [0, -1, 1.5, 1025, NaN]) await assert.rejects(reopened.readNodeAt(index));
  // The index path performs the same current-file custody/hash check as refs.
  await writeFile(join(f.slot, "node-000003.enc"), "retained damaged node");
  await assert.rejects(reopened.readNodeAt(3)); await reopened.close(); await assert.rejects(reopened.readNodeAt(1));
});
