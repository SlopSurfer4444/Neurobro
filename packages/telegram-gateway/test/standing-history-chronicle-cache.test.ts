import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryChronicleCache, type StandingHistoryChronicleSelection } from "../src/standing-history-chronicle-cache.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { openStandingHistoryChronicleReuseStore } from "../src/standing-history-chronicle-reuse-store.js";

const passphrase = "synthetic-period-cache-passphrase";
const producer = { model: "synthetic-model", promptVersion: "prompt-1", projectionVersion: "source-1", outputVersion: "output-1" };
async function root(t: TestContext) {
  const directory = await mkdtemp(join(resolve(tmpdir()), "neurobro-period-cache-"));
  t.after(async () => { assert.ok(directory.startsWith(join(resolve(tmpdir()), "neurobro-period-cache-"))); await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, "pages")); await mkdir(join(directory, "analysis")); return directory;
}
async function task(t: TestContext, directory: string, digit: string, options: { text?: string; rows?: number; editedAt?: number | null; intent?: Partial<StandingHistoryTaskIntent>; summary?: string; claimCount?: number; claimText?: string; splitRows?: boolean; save?: boolean } = {}) {
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + digit.repeat(48), accountId: "123", chatId: "-100456", requesterId: "456",
    primaryMessageId: 789, fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize this exact period", ...options.intent };
  const source = await openStandingHistoryTaskStore({ directory: join(directory, "pages"), passphrase, intent, mode: "create" }); t.after(() => source.close());
  const before = (await source.status()).readProgress.checkpoint, count = options.rows ?? 2;
  const sources = Array.from({ length: count }, (_, i) => ({ messageId: 998 - i, date: 199 - i, disposition: "included" as const, messageRef: "m_" + digit.repeat(20) + String(i).padStart(4, "0"), authorId: "456" }));
  const next = { ...before, offsetId: sources.at(-1)?.messageId ?? 0, lastDate: sources.at(-1)?.date ?? before.lastDate, oldestDate: sources.at(-1)?.date ?? null,
    newestDate: sources[0]?.date ?? null, upperBoundMessageId: sources[0]?.messageId ?? null, pages: 1, status: count ? "lower-bound-reached" as const : "empty-page" as const };
  await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: next, sources,
    page: { schema: "neurobro-self-history-v1", fromDate: intent.fromDate, toDate: intent.toDate,
      messages: sources.map(s => ({ ref: s.messageRef, authorRef: "a_" + digit.repeat(24), author: "user" as const, displayName: "Synthetic person", date: s.date,
        editedAt: options.editedAt ?? null, replyRef: null, replyUnavailable: false, text: (options.text ?? "Private synthetic original") + " " + s.messageId })).reverse(),
      cursor: null, hasMore: false, status: next.status, coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate,
        traversalComplete: true, undatedEntries: 0, pages: 1 }, excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } } });
  const analysis = await openStandingHistoryAnalysisStore({ directory: join(directory, "analysis"), passphrase, intent, mode: "create", readSourcePage: i => source.readPage(i) }); t.after(() => analysis.close());
  const page = (await source.readPage(1))!, referenceKey = analysis.referenceKey();
  const materials: StandingHistoryChronicleSelection["materials"][number][] = [];
  let position: string | undefined;
  do {
    const requestOptions = { maxBytes: 49152, ...(options.splitRows ? { maxRows: 1 } : {}), ...(position ? { position } : {}) };
    const fragment = projectStandingHistorySource({ intent, referenceKey, storedPage: page, ...requestOptions });
    materials.push({ page, request: { pageIndex: 1, materialRef: fragment.materialRef, ...requestOptions } });
    position = fragment.nextPosition ?? undefined;
  } while (position);
  const fragment = projectStandingHistorySource({ intent, referenceKey, storedPage: page, maxBytes: 49152, ...(options.splitRows ? { maxRows: 1 } : {}) });
  const selection: StandingHistoryChronicleSelection = { intent, producer, referenceKey, materials };
  const output = { summary: options.summary ?? "Synthetic model summary", claims: fragment.rows.length ? Array.from({ length: options.claimCount ?? 1 }, (_, index) => ({ kind: "reported" as const, text: options.claimText ?? "Synthetic unverified claim " + index,
    supports: [{ sourceRef: fragment.rows[0]!.sourceRef, versionRef: fragment.rows[0]!.versionRef }] })) : [], omittedDetailCount: 3 };
  const node = options.save === false ? undefined : await analysis.appendLeaf({ expectedHead: (await analysis.status()).headHash, inputs: materials.map(m => m.request), output });
  return { selection, node, analysis, source, output };
}
async function cache(t: TestContext, directory: string) {
  const result = await openStandingHistoryChronicleCache({ directory: join(directory, "cache"), passphrase }); t.after(() => result.close()); return result;
}
function reproject(selection: StandingHistoryChronicleSelection, intent: StandingHistoryTaskIntent): StandingHistoryChronicleSelection {
  return { ...selection, intent, materials: selection.materials.map(m => {
    const fragment = projectStandingHistorySource({ intent, referenceKey: selection.referenceKey, storedPage: m.page, maxBytes: m.request.maxBytes });
    return { page: m.page, request: { ...m.request, materialRef: fragment.materialRef } };
  }) };
}

test("fresh exact source in another task reuses encrypted persisted leaf with current supports and provenance", async t => {
  const r = await root(t), a = await task(t, r, "1"), c = await cache(t, r);
  const provenance = await c.remember({ ...a.selection, node: a.node!, capturedAt: 1000 }); assert.ok(provenance);
  await c.close(); const reopened = await cache(t, r), b = await task(t, r, "2", { save: false });
  assert.notEqual(a.selection.referenceKey, b.selection.referenceKey);
  const hit = await reopened.lookup(b.selection); assert.ok(hit); assert.equal(hit.provenance.originTaskRef, a.selection.intent.taskId);
  assert.equal(hit.provenance.kind, "reused-analysis"); assert.equal(hit.provenance.claimsStatus, "model-authored-unverified");
  assert.deepEqual(hit.output, b.output); assert.notDeepEqual(hit.output.claims[0]!.supports, a.output.claims[0]!.supports);
  const imported = await b.analysis.appendLeaf({ expectedHead: (await b.analysis.status()).headHash, inputs: b.selection.materials.map(m => m.request), output: hit.output });
  assert.deepEqual(imported.output, b.output); assert.equal((await b.analysis.status()).analysisNodes, 1);
  const [period] = await readdir(join(r, "cache")), [file] = await readdir(join(r, "cache", period!));
  const bytes = await readFile(join(r, "cache", period!, file!), "utf8");
  for (const secret of [a.output.summary, a.selection.intent.objective, "Private synthetic original", a.node!.nodeRef]) assert.equal(bytes.includes(secret), false);
  const catalog = await reopened.catalog({ intent: b.selection.intent, producer }); assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.mode, "query-specific"); assert.equal(catalog[0]!.coverage.scope, "selected-material-only"); assert.equal(catalog[0]!.coverage.rows, 2);
  assert.equal(catalog[0]!.coverage.days[0]!.rows, 2); assert.equal(catalog[0]!.coverage.hasMoreDays, false);
});

for (const claimCount of [17, 128]) test(`${claimCount} valid claims persist and rebind after cache close and reopen`, async t => {
  const r = await root(t), a = await task(t, r, "1", { claimCount }), c = await cache(t, r);
  assert.equal((await a.analysis.readNode(a.node!.nodeRef))!.output.claims.length, claimCount);
  assert.ok(await c.remember({ ...a.selection, node: a.node!, capturedAt: 1000 })); await c.close();
  const reopened = await cache(t, r), b = await task(t, r, "2", { claimCount, save: false });
  const hit = await reopened.lookup(b.selection); assert.ok(hit); assert.deepEqual(hit.output, b.output);
  const imported = await b.analysis.appendLeaf({ expectedHead: (await b.analysis.status()).headHash, inputs: b.selection.materials.map(m => m.request), output: hit.output });
  assert.equal(imported.output.claims.length, claimCount);
});

for (const rows of [8, 9]) test(`${rows} bounded legacy-size fragments persist across cache reopen`, async t => {
  const r = await root(t), a = await task(t, r, "1", { rows, splitRows: true }), c = await cache(t, r);
  assert.ok("materials" in a.node!.inputs); assert.equal(a.node!.inputs.materials.length, rows);
  assert.ok(await c.remember({ ...a.selection, node: a.node!, capturedAt: 1000 })); await c.close();
  const reopened = await cache(t, r), b = await task(t, r, "2", { rows, splitRows: true, save: false });
  const hit = await reopened.lookup(b.selection); assert.ok(hit); assert.deepEqual(hit.output, b.output);
  assert.equal(hit.coverage.fragments.length, rows); assert.equal(hit.coverage.rows, rows);
});

test("valid saved analysis exceeding cache bytes is an optional miss without any cache directory or encrypted entry", async t => {
  const r = await root(t), a = await task(t, r, "1", { claimCount: 128, claimText: "c".repeat(1024), summary: "s".repeat(32768) }), c = await cache(t, r);
  assert.deepEqual((await a.analysis.readNode(a.node!.nodeRef))!.output, a.output);
  assert.equal(await c.remember({ ...a.selection, node: a.node!, capturedAt: 1000 }), undefined);
  assert.equal((await readdir(r)).includes("cache"), false); await c.close();
  const reopened = await cache(t, r); assert.equal(await reopened.lookup(a.selection), undefined);
  assert.deepEqual(await reopened.catalog({ intent: a.selection.intent, producer }), []);
  assert.equal((await readdir(r)).includes("cache"), false);
  // The miss leaves the same source key available for a later bounded saved leaf.
  const b = await task(t, r, "2", { summary: "Bounded summary", claimCount: 0 });
  assert.ok(await reopened.remember({ ...b.selection, node: b.node!, capturedAt: 1001 }));
  assert.equal((await reopened.lookup(a.selection))!.output.summary, "Bounded summary");
});

test("text edits, edit stamps, and deleted source rows each miss instead of importing stale claims", async t => {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1"); await c.remember({ ...a.selection, node: a.node!, capturedAt: 1 });
  for (const [digit, options] of [["2", { text: "Changed source" }], ["3", { editedAt: 199 }], ["4", { rows: 1 }]] as const) {
    const changed = await task(t, r, digit, { ...options, save: false }); assert.equal(await c.lookup(changed.selection), undefined);
    assert.equal((await changed.analysis.status()).analysisNodes, 0);
  }
});

test("objective, requester, source, workspace, period, timezone and producer revisions are isolated", async t => {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1"); await c.remember({ ...a.selection, node: a.node!, capturedAt: 1 });
  for (const change of [{ objective: "Different question" }, { requesterId: "777" }, { timezone: "UTC" }]) {
    assert.equal(await c.lookup(reproject(a.selection, { ...a.selection.intent, ...change })), undefined);
  }
  for (const field of Object.keys(producer) as (keyof typeof producer)[]) assert.equal(await c.lookup({ ...a.selection, producer: { ...producer, [field]: "changed" } }), undefined);
  const source = { kind: "observed-source" as const, sourceRef: "community" as const, workspaceId: "workspace-1", peerId: "-100999" };
  const b = await task(t, r, "2", { intent: { source } }); assert.equal(await c.lookup(b.selection), undefined);
  await c.remember({ ...b.selection, node: b.node!, capturedAt: 2 });
  assert.equal(await c.lookup(reproject(b.selection, { ...b.selection.intent, source: { ...source, workspaceId: "workspace-2" } })), undefined);
  const period = await task(t, r, "3", { intent: { fromDate: 101 }, save: false }); assert.equal(await c.lookup(period.selection), undefined);
});

test("a missing cache stays absent during lookup and catalog; close forbids later I/O", async t => {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1");
  assert.equal(await c.lookup(a.selection), undefined); assert.deepEqual(await c.catalog({ intent: a.selection.intent, producer }), []);
  assert.equal((await readdir(r)).includes("cache"), false); await c.close();
  assert.equal(await c.remember({ ...a.selection, node: a.node!, capturedAt: 1 }), undefined); assert.equal((await readdir(r)).includes("cache"), false);
});

test("corrupt cache is a miss and never overwritten; independent source remains intact", async t => {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1"); await c.remember({ ...a.selection, node: a.node!, capturedAt: 1 });
  const [period] = await readdir(join(r, "cache")), [filename] = await readdir(join(r, "cache", period!)), path = join(r, "cache", period!, filename!);
  await writeFile(path, "damaged derived cache"); assert.equal(await c.lookup(a.selection), undefined);
  assert.equal(await c.remember({ ...a.selection, node: a.node!, capturedAt: 2 }), undefined); assert.equal(await readFile(path, "utf8"), "damaged derived cache");
  assert.equal((await a.source.status()).storage, "ready"); assert.equal((await a.analysis.status()).analysisNodes, 1);
});

test("cache capture refuses hidden support, different node material, and inline old aliases", async t => {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1");
  const altered = structuredClone(a.node!); (altered as any).inputs.materials[0].pageHash = "e".repeat(64);
  assert.throws(() => c.remember({ ...a.selection, node: altered, capturedAt: 1 }));
  const hidden = structuredClone(a.node!); (hidden as any).output.claims[0].supports[0].versionRef = "hver_" + "e".repeat(48);
  assert.equal(await c.remember({ ...a.selection, node: hidden, capturedAt: 1 }), undefined);
  const inline = structuredClone(a.node!); (inline as any).output.summary = "See " + a.node!.nodeRef;
  assert.equal(await c.remember({ ...a.selection, node: inline, capturedAt: 1 }), undefined);
  const speaker = structuredClone(a.node!); (speaker as any).output.claims[0].text = "Speaker hspk_" + "a".repeat(48) + " asked this";
  assert.equal(await c.remember({ ...a.selection, node: speaker, capturedAt: 1 }), undefined);
  const noteAlias = structuredClone(a.node!); (noteAlias as any).output.summary = "Earlier hnote_" + "b".repeat(48);
  assert.equal(await c.remember({ ...a.selection, node: noteAlias, capturedAt: 1 }), undefined);
  assert.equal((await readdir(r)).includes("cache"), false);
});

test("hostile nested properties are inert and duplicate source material is refused before storage", async t => {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1"); let invoked = 0;
  const getter = { ...a.selection, producer: { ...producer, get model() { invoked++; return "bad"; } } };
  assert.throws(() => c.lookup(getter)); assert.throws(() => c.lookup(new Proxy(a.selection, { ownKeys() { invoked++; return []; } })));
  assert.throws(() => c.lookup({ ...a.selection, materials: [a.selection.materials[0]!, a.selection.materials[0]!] })); assert.equal(invoked, 0);
});

test("empty source and omission counts retain explicit selected coverage; cache never claims whole period", async t => {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1", { rows: 0 });
  assert.ok(await c.remember({ ...a.selection, node: a.node!, capturedAt: 1 })); const hit = await c.lookup(a.selection); assert.ok(hit);
  assert.equal(hit.output.omittedDetailCount, 3); assert.equal(hit.coverage.rows, 0); assert.equal(hit.coverage.firstDate, null); assert.deepEqual(hit.coverage.days, []);
  assert.equal(hit.coverage.scope, "selected-material-only"); assert.equal("traversalComplete" in hit.coverage, false);
});

test("root replacement invalidates cached custody and preserves replacement contents", async t => {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1"); await c.remember({ ...a.selection, node: a.node!, capturedAt: 1 });
  await rename(join(r, "cache"), join(r, "old-cache")); await mkdir(join(r, "cache")); await writeFile(join(r, "cache", "marker"), "new owner");
  assert.equal(await c.lookup(a.selection), undefined); assert.equal(await c.remember({ ...a.selection, node: a.node!, capturedAt: 1 }), undefined);
  assert.deepEqual(await readdir(join(r, "cache")), ["marker"]);
});

async function reuseFixture(t: TestContext) {
  const r = await root(t), c = await cache(t, r), a = await task(t, r, "1"), b = await task(t, r, "2", { save: false });
  await c.remember({ ...a.selection, node: a.node!, capturedAt: 100 }); const hit = await c.lookup(b.selection); assert.ok(hit);
  const plan = { sourceHead: (await b.source.status()).readProgress.chainHash, expectedHead: (await b.analysis.status()).headHash,
    nodeIndex: 1, inputs: b.selection.materials.map(m => m.request), hit };
  const args = { directory: join(r, "reuses"), passphrase, intent: b.selection.intent, analysis: b.analysis };
  const store = await openStandingHistoryChronicleReuseStore(args); t.after(() => store.close()); return { r, c, a, b, plan, args, store };
}

test("large leaf reuse output and explicit 1MiB descriptor survive encrypted reopen and one commit", async t => {
  const f = await reuseFixture(t), material = f.b.selection.materials[0]!;
  const fragment = projectStandingHistorySource({ intent: f.args.intent, referenceKey: f.b.analysis.referenceKey(), storedPage: material.page, maxBytes: 1048576 });
  const output = { summary: "s".repeat(32768), claims: Array.from({ length: 128 }, () => ({ kind: "reported" as const, text: "c".repeat(1024),
    supports: [{ sourceRef: fragment.rows[0]!.sourceRef, versionRef: fragment.rows[0]!.versionRef }] })) };
  const plan = { ...f.plan, inputs: [{ pageIndex: 1, materialRef: fragment.materialRef, maxBytes: 1048576 }], hit: { ...f.plan.hit, output } };
  const prepared = await f.store.prepare(plan); await f.store.close();
  const reopened = await openStandingHistoryChronicleReuseStore(f.args); t.after(() => reopened.close());
  assert.deepEqual(await reopened.readPrepared(prepared.reuseRef), plan); const node = await reopened.commitPrepared(prepared); await reopened.close();
  const final = await openStandingHistoryChronicleReuseStore(f.args); t.after(() => final.close());
  assert.deepEqual(await final.commitPrepared(prepared), node); assert.equal((await f.b.analysis.status()).analysisNodes, 1);
  assert.deepEqual((await f.b.analysis.readNode(node.nodeRef))!.output, output);
});

test("reuse receipt persists preparation and exact node without any native attempt, and remains idempotent after reopen", async t => {
  const f = await reuseFixture(t), prepared = await f.store.prepare(f.plan);
  assert.equal((await f.store.status()).modelInvocation, "none"); assert.equal((await f.store.status()).last?.node, undefined);
  const node = await f.store.commitPrepared(prepared); assert.equal(node.index, 1); assert.equal((await f.store.status()).last?.node?.hash, node.hash);
  await f.store.close(); const reopened = await openStandingHistoryChronicleReuseStore(f.args); t.after(() => reopened.close());
  assert.deepEqual(await reopened.readPrepared(prepared.reuseRef), f.plan); assert.deepEqual(await reopened.commitPrepared(prepared), node);
  assert.equal((await f.b.analysis.status()).analysisNodes, 1);
  const names = await readdir(join(f.r, "reuses", f.b.selection.intent.taskId)); assert.deepEqual(names.sort(), ["reuse-000001-node.enc", "reuse-000001-prepared.enc"]);
  const serialized = await readFile(join(f.r, "reuses", f.b.selection.intent.taskId, "reuse-000001-prepared.enc"), "utf8");
  assert.equal(serialized.includes(f.plan.hit.output.summary), false); assert.equal(serialized.includes("nativeBinding"), false);
});

test("restart with only prepared receipt commits exactly once", async t => {
  const f = await reuseFixture(t), prepared = await f.store.prepare(f.plan); await f.store.close();
  let appends = 0; const analysis = { ...f.b.analysis, async appendLeaf(value: Parameters<typeof f.b.analysis.appendLeaf>[0]) { appends++; return f.b.analysis.appendLeaf(value); } };
  const reopened = await openStandingHistoryChronicleReuseStore({ ...f.args, analysis }); t.after(() => reopened.close());
  assert.equal((await reopened.status()).last?.node, undefined); await reopened.commitPrepared(prepared); await reopened.commitPrepared(prepared); assert.equal(appends, 1);
});

test("uncertain append return recovers existing exact node without reappend or model work", async t => {
  const f = await reuseFixture(t); await f.store.close(); let appends = 0;
  const analysis = { ...f.b.analysis, async appendLeaf(value: Parameters<typeof f.b.analysis.appendLeaf>[0]) { appends++; await f.b.analysis.appendLeaf(value); throw Error("synthetic crash after durable node"); } };
  const interrupted = await openStandingHistoryChronicleReuseStore({ ...f.args, analysis }); t.after(() => interrupted.close());
  const prepared = await interrupted.prepare(f.plan); await assert.rejects(interrupted.commitPrepared(prepared)); await interrupted.close();
  assert.equal((await f.b.analysis.status()).analysisNodes, 1);
  const recovery = await openStandingHistoryChronicleReuseStore({ ...f.args, analysis }); t.after(() => recovery.close());
  const node = await recovery.commitPrepared(prepared); assert.equal(node.index, 1); assert.equal(appends, 1);
});

test("pending reuse cannot be replaced and a conflicting existing node is never adopted", async t => {
  const f = await reuseFixture(t), prepared = await f.store.prepare(f.plan);
  await assert.rejects(f.store.prepare(f.plan), /CONSUMED/);
  await f.b.analysis.appendLeaf({ expectedHead: f.plan.expectedHead, inputs: f.plan.inputs, output: { ...f.plan.hit.output, summary: "Different authored output" } });
  await assert.rejects(f.store.commitPrepared(prepared), /BINDING/); assert.equal((await f.store.status()).last?.node, undefined);
  assert.equal((await f.b.analysis.status()).analysisNodes, 1);
});

test("stale source plan cannot reserve at changed analysis head", async t => {
  const f = await reuseFixture(t);
  await f.b.analysis.appendLeaf({ expectedHead: f.plan.expectedHead, inputs: f.plan.inputs, output: f.plan.hit.output });
  await assert.rejects(f.store.prepare(f.plan), /CONFLICT/); assert.equal((await f.store.status()).reuses, 0);
  assert.equal((await readdir(f.r)).includes("reuses"), false);
});

test("damaged reuse receipt stays refused after restart and cannot authorize a fresh append", async t => {
  const f = await reuseFixture(t), prepared = await f.store.prepare(f.plan); await f.store.close();
  const path = join(f.r, "reuses", f.b.selection.intent.taskId, "reuse-000001-prepared.enc"); await writeFile(path, "broken receipt");
  const reopened = await openStandingHistoryChronicleReuseStore(f.args); t.after(() => reopened.close());
  assert.equal((await reopened.status()).storage, "tail-refused"); await assert.rejects(reopened.commitPrepared(prepared), /TAIL/);
  await assert.rejects(reopened.prepare(f.plan), /TAIL/); assert.equal((await f.b.analysis.status()).analysisNodes, 0); assert.equal(await readFile(path, "utf8"), "broken receipt");
});

test("reuse receipts remain bound to the exact task intent and inert input contract", async t => {
  const f = await reuseFixture(t), prepared = await f.store.prepare(f.plan); await f.store.close();
  const wrong = await openStandingHistoryChronicleReuseStore({ ...f.args, intent: { ...f.args.intent, objective: "Different purpose" } }); t.after(() => wrong.close());
  assert.equal((await wrong.status()).storage, "tail-refused"); await assert.rejects(wrong.commitPrepared(prepared), /TAIL/);
  const reopened = await openStandingHistoryChronicleReuseStore(f.args); t.after(() => reopened.close()); let invoked = 0;
  assert.throws(() => reopened.prepare({ ...f.plan, get hit() { invoked++; return f.plan.hit; } })); assert.equal(invoked, 0);
  assert.equal((await f.b.analysis.status()).analysisNodes, 0);
});

test("new unobserved receipt files invalidate a retained reuse status before native or source admission", async t => {
  const f = await reuseFixture(t), prepared = await f.store.prepare(f.plan);
  await writeFile(join(f.r, "reuses", f.b.selection.intent.taskId, "reuse-000002-prepared.enc"), "unexpected writer");
  assert.equal((await f.store.status()).storage, "tail-refused"); await assert.rejects(f.store.commitPrepared(prepared), /TAIL/);
  assert.equal((await f.b.analysis.status()).analysisNodes, 0);
});
