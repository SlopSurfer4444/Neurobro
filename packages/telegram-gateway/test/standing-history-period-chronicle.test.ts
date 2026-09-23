import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryChronicleCache, type StandingHistoryChronicleSelection } from "../src/standing-history-chronicle-cache.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryAnalysisStore, validateStandingHistoryShownOutput } from "../src/standing-history-analysis-store.js";
import { MAX_CLAIMS, MAX_SUPPORTS } from "../src/standing-history-analysis-limits.js";
import { createStandingHistoryPeriodChronicleTurn } from "../src/standing-history-period-chronicle-turn.js";
import { projectStandingHistorySource } from "../src/standing-history-source-projection.js";
import { openStandingHistoryChronicleReuseStore } from "../src/standing-history-chronicle-reuse-store.js";
import { prepareStandingHistoryPeriodChronicle, consumeStandingHistoryPeriodChronicle, STANDING_HISTORY_PERIOD_CHRONICLE_OBJECTIVE,
  type StandingHistoryPeriodChronicleRequest, type StandingHistoryChroniclePeriod, type StandingHistoryPeriodChronicleGeneration } from "../src/standing-history-period-chronicle.js";
import { openStandingHistoryPeriodChronicleStore } from "../src/standing-history-period-chronicle-store.js";

const passphrase = "synthetic-period-cache-passphrase";
const producer = { model: "synthetic-model", promptVersion: "prompt-1", projectionVersion: "source-1", outputVersion: "output-1" };
async function root(t: TestContext) {
  const directory = await mkdtemp(join(resolve(tmpdir()), "neurobro-period-cache-"));
  t.after(async () => { assert.ok(directory.startsWith(join(resolve(tmpdir()), "neurobro-period-cache-"))); await rm(directory, { recursive: true, force: true }); });
  await mkdir(join(directory, "pages")); await mkdir(join(directory, "analysis")); return directory;
}
async function task(t: TestContext, directory: string, digit: string, options: { text?: string; rows?: number; dates?: readonly number[]; reply?: boolean; editedAt?: number | null; intent?: Partial<StandingHistoryTaskIntent>; summary?: string; save?: boolean } = {}) {
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + digit.repeat(48), accountId: "123", chatId: "-100456", requesterId: "456",
    primaryMessageId: 789, fromDate: 100, toDate: 200, timezone: "Europe/Moscow", objective: "Summarize this exact period", ...options.intent };
  const source = await openStandingHistoryTaskStore({ directory: join(directory, "pages"), passphrase, intent, mode: "create" }); t.after(() => source.close());
  const before = (await source.status()).readProgress.checkpoint, count = options.rows ?? 2;
  const sources = Array.from({ length: count }, (_, i) => ({ messageId: 998 - i, date: options.dates?.[i] ?? 199 - i, disposition: "included" as const, messageRef: "m_" + digit.repeat(20) + String(i).padStart(4, "0"), authorId: "456", ...(options.reply && i === 0 ? { replyToMessageId: 997 } : {}) }));
  const next = { ...before, offsetId: sources.at(-1)?.messageId ?? 0, lastDate: sources.at(-1)?.date ?? before.lastDate, oldestDate: sources.at(-1)?.date ?? null,
    newestDate: sources[0]?.date ?? null, upperBoundMessageId: sources[0]?.messageId ?? null, pages: 1, status: count ? "lower-bound-reached" as const : "empty-page" as const };
  await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: next, sources,
    page: { schema: "neurobro-self-history-v1", fromDate: intent.fromDate, toDate: intent.toDate,
      messages: sources.map(s => ({ ref: s.messageRef, authorRef: "a_" + digit.repeat(24), author: "user" as const, displayName: "Synthetic person", date: s.date,
        editedAt: options.editedAt ?? null, replyRef: s.replyToMessageId ? sources[1]!.messageRef : null, replyUnavailable: false, text: (options.text ?? "Private synthetic original") + " " + s.messageId })).reverse(),
      cursor: null, hasMore: false, status: next.status, coverage: { scope: "available-history-snapshot", oldestExaminedDate: next.oldestDate, newestExaminedDate: next.newestDate,
        traversalComplete: true, undatedEntries: 0, pages: 1 }, excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 },
      limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } } });
  const analysis = await openStandingHistoryAnalysisStore({ directory: join(directory, "analysis"), passphrase, intent, mode: "create", readSourcePage: i => source.readPage(i) }); t.after(() => analysis.close());
  const page = (await source.readPage(1))!, referenceKey = analysis.referenceKey(), fragment = projectStandingHistorySource({ intent, referenceKey, storedPage: page });
  const request = { pageIndex: 1, materialRef: fragment.materialRef, maxBytes: 49152 };
  const selection: StandingHistoryChronicleSelection = { intent, producer, referenceKey, materials: [{ request, page }] };
  const output = { summary: options.summary ?? "Synthetic model summary", claims: fragment.rows.length ? [{ kind: "reported" as const, text: "Synthetic unverified claim",
    supports: [{ sourceRef: fragment.rows[0]!.sourceRef, versionRef: fragment.rows[0]!.versionRef }] }] : [], omittedDetailCount: 3 };
  const node = options.save === false ? undefined : await analysis.appendLeaf({ expectedHead: (await analysis.status()).headHash, inputs: [request], output });
  return { selection, node, analysis, source, output };
}

const day: StandingHistoryChroniclePeriod = { kind: "day", key: "1970-01-01" };
const request = (selection: StandingHistoryChronicleSelection, period = day) => prepareStandingHistoryPeriodChronicle({ ...selection, period, workspaceId: "test-workspace" })!;
const generation = (r: StandingHistoryPeriodChronicleRequest): StandingHistoryPeriodChronicleGeneration => ({ purpose: "neutral-period-notes", inputHash: r.inputHash,
  requestRef: "synthetic-neutral-request", epochId: "a".repeat(32), modelOutcome: "observed", resourcesSettled: true });
const output = (r: StandingHistoryPeriodChronicleRequest) => ({ summary: "Neutral notes about source participants and unresolved points", claims: [{ kind: "reported" as const,
  text: "Participant reported a source event", supports: [{ sourceRef: r.material.rows[0]!.sourceRef, versionRef: r.material.rows[0]!.versionRef }] }], omittedDetailCount: 2 });
async function store(t: TestContext, directory: string) {
  const s = await openStandingHistoryPeriodChronicleStore({ directory: join(directory, "neutral-notes"), passphrase }); t.after(() => s.close()); return s;
}
function changedIntent(selection: StandingHistoryChronicleSelection, change: Partial<StandingHistoryTaskIntent>): StandingHistoryChronicleSelection {
  const intent = { ...selection.intent, ...change };
  return { ...selection, intent, materials: selection.materials.map(m => {
    const projected = projectStandingHistorySource({ intent, referenceKey: selection.referenceKey, storedPage: m.page, maxBytes: m.request.maxBytes,
      ...(m.request.maxRows === undefined ? {} : { maxRows: m.request.maxRows }), ...(m.request.position === undefined ? {} : { position: m.request.position }) });
    return { page: m.page, request: { ...m.request, materialRef: projected.materialRef } };
  }) };
}

test("neutral period output survives encrypted restart and different queries/windows with current source supports", async t => {
  const directory = await root(t), a = await task(t, directory, "1", { save: false, intent: { objective: "What decisions were made?" } }), s = await store(t, directory), ra = request(a.selection);
  assert.equal(ra.objective, STANDING_HISTORY_PERIOD_CHRONICLE_OBJECTIVE); assert.equal(JSON.stringify(ra).includes(a.selection.intent.objective), false);
  const saved = await s.remember({ request: ra, output: output(ra), generation: generation(ra), capturedAt: 1000 }); assert.ok(saved);
  await s.close();
  const reopened = await store(t, directory), b = await task(t, directory, "2", { save: false, intent: { fromDate: 50, toDate: 250, objective: "Which questions remain unanswered?" } }), rb = request(b.selection);
  assert.notEqual(ra.inputHash, rb.inputHash); assert.notEqual(ra.material.rows[0]!.sourceRef, rb.material.rows[0]!.sourceRef);
  const note = await reopened.lookup(rb); assert.ok(note); assert.equal(note.provenance.contentHash, saved.provenance.contentHash);
  assert.equal(note.provenance.originTaskRef, a.selection.intent.taskId); assert.equal(note.provenance.generation.inputHash, ra.inputHash);
  assert.deepEqual(note.output, output(rb));
  const advisory = consumeStandingHistoryPeriodChronicle({ request: rb, note }); assert.ok(advisory);
  assert.equal(advisory.currentSourceRequired, true); assert.equal(advisory.queryCoverage, "not-established"); assert.equal(advisory.coverage.periodComplete, false);
  assert.equal(advisory.claims[0]!.supports[0]!.sourceRef, rb.material.rows[0]!.sourceRef);
  assert.equal((await a.analysis.status()).analysisNodes, 0); assert.equal((await b.analysis.status()).analysisNodes, 0);
  assert.equal((await b.source.readPage(1))!.result.page.messages[0]!.text, "Private synthetic original 997");
});

test("day/week/month grouping is deterministic, selected-only and never triggers an archive pass", async t => {
  const directory = await root(t), a = await task(t, directory, "1", { save: false }), s = await store(t, directory);
  for (const period of [day, { kind: "week", key: "1969-12-29" }, { kind: "month", key: "1970-01" }] as const) {
    const r = request(a.selection, period); assert.equal(r.coverage.rows, 2); assert.equal(r.coverage.periodComplete, false); assert.equal(r.period.key, period.key);
    assert.equal(await s.lookup(r), undefined);
  }
  assert.equal(prepareStandingHistoryPeriodChronicle({ ...a.selection, workspaceId: "test-workspace", period: { kind: "day", key: "1970-01-02" } }), undefined);
  for (const period of [{ kind: "day", key: "1970-02-30" }, { kind: "week", key: "1970-01-01" }, { kind: "month", key: "1970-13" }] as const) assert.throws(() => request(a.selection, period));
  assert.equal((await readdir(directory)).includes("neutral-notes"), false);
  const shifted = request(changedIntent(a.selection, { timezone: "America/Los_Angeles" }), { kind: "day", key: "1969-12-31" }); assert.equal(shifted.coverage.rows, 2);
});

test("period filtering recomputes reply visibility when a shown source target belongs to a different day", async t => {
  const directory = await root(t), a = await task(t, directory, "1", { save: false, dates: [86401, 86399], reply: true,
    intent: { fromDate: 1, toDate: 172800, timezone: "UTC" } });
  const source = projectStandingHistorySource({ intent: a.selection.intent, referenceKey: a.selection.referenceKey, storedPage: a.selection.materials[0]!.page });
  assert.equal(source.rows[0]!.disposition, "included");
  if (source.rows[0]!.disposition === "included") assert.equal(source.rows[0]!.replyContentAvailable, true);
  const selected = request(a.selection, { kind: "day", key: "1970-01-02" });
  assert.equal(selected.material.rows.length, 1);
  const row = selected.material.rows[0]!; assert.equal(row.disposition, "included");
  if (row.disposition === "included") { assert.ok(row.replySourceRef); assert.equal(row.replyContentAvailable, false); }
  const month = request(a.selection, { kind: "month", key: "1970-01" });
  assert.equal(month.material.rows.length, 2);
  if (month.material.rows[0]!.disposition === "included") assert.equal(month.material.rows[0]!.replyContentAvailable, true);
});

test("changed source content, edit metadata and selected row deletion invalidate neutral notes", async t => {
  const directory = await root(t), s = await store(t, directory), a = await task(t, directory, "1", { save: false }), ra = request(a.selection);
  await s.remember({ request: ra, output: output(ra), generation: generation(ra), capturedAt: 1 });
  for (const [digit, options] of [["2", { text: "Edited statement" }], ["3", { editedAt: 199 }], ["4", { rows: 1 }], ["5", { rows: 3 }]] as const) {
    const changed = await task(t, directory, digit, { ...options, save: false }); assert.equal(await s.lookup(request(changed.selection)), undefined);
  }
});

test("requester, peer, observed source workspace, timezone and producer revisions remain isolated", async t => {
  const directory = await root(t), s = await store(t, directory), a = await task(t, directory, "1", { save: false }), ra = request(a.selection);
  await s.remember({ request: ra, output: output(ra), generation: generation(ra), capturedAt: 1 });
  assert.equal(await s.lookup(request(changedIntent(a.selection, { requesterId: "999" }))), undefined);
  assert.equal(await s.lookup(prepareStandingHistoryPeriodChronicle({ ...a.selection, period: day, workspaceId: "other-workspace" })!), undefined);
  assert.equal(await s.lookup(request(changedIntent(a.selection, { timezone: "UTC" }))), undefined);
  for (const field of Object.keys(producer) as (keyof typeof producer)[]) assert.equal(await s.lookup(request({ ...a.selection, producer: { ...producer, [field]: "changed" } })), undefined);
  const source = { kind: "observed-source" as const, sourceRef: "community" as const, workspaceId: "workspace-1", peerId: "-100999" };
  const b = await task(t, directory, "2", { save: false, intent: { source } }), rb = request(b.selection);
  assert.equal(await s.lookup(rb), undefined); await s.remember({ request: rb, output: output(rb), generation: generation(rb), capturedAt: 2 });
  assert.equal(await s.lookup(request(changedIntent(b.selection, { source: { ...source, workspaceId: "workspace-2" } }))), undefined);
  const c = await task(t, directory, "3", { save: false, intent: { chatId: "-100987" } }); assert.equal(await s.lookup(request(c.selection)), undefined);
});

test("capture requires actual neutral input binding, settled observation, shown supports and inert request capability", async t => {
  const directory = await root(t), s = await store(t, directory), a = await task(t, directory, "1", { save: false }), r = request(a.selection);
  for (const patch of [{ purpose: "query-analysis" }, { modelOutcome: "unknown" }, { resourcesSettled: false }, { inputHash: "b".repeat(64) }]) {
    assert.throws(() => s.remember({ request: r, output: output(r), generation: { ...generation(r), ...patch } as any, capturedAt: 1 }));
  }
  const hidden = { ...output(r), claims: [{ kind: "reported" as const, text: "Hidden", supports: [{ sourceRef: "hsrc_" + "f".repeat(48), versionRef: "hver_" + "f".repeat(48) }] }] };
  assert.throws(() => s.remember({ request: r, output: hidden, generation: generation(r), capturedAt: 1 }));
  assert.throws(() => s.remember({ request: r, output: { ...output(r), summary: r.material.rows[0]!.sourceRef }, generation: generation(r), capturedAt: 1 }));
  assert.throws(() => s.lookup(structuredClone(r)), /INPUT/);
  let invoked = 0; const unsafe = { ...a.selection, period: day, workspaceId: "test-workspace" }; Object.defineProperty(unsafe, "producer", { get() { invoked++; return producer; } });
  assert.throws(() => prepareStandingHistoryPeriodChronicle(unsafe)); assert.equal(invoked, 0);
});

test("warm worker release records its exact receipt without claiming physical owner settlement", async t => {
  const directory = await root(t), s = await store(t, directory), a = await task(t, directory, "1", { save: false }), r = request(a.selection);
  const { resourcesSettled, ...base } = generation(r) as Extract<StandingHistoryPeriodChronicleGeneration, { resourcesSettled: true }>;
  const workRelease = { schema: "standing-analysis-work-release-v1" as const, nativeBinding: { epochId: base.epochId, requestRef: base.requestRef, purpose: "history-analysis" as const },
    workRef: "hwork_" + "c".repeat(48), releaseAcknowledged: true as const, callbacksJoined: true as const };
  for (const release of [{ ...workRelease, callbacksJoined: false }, { ...workRelease, releaseAcknowledged: false },
    { ...workRelease, nativeBinding: { ...workRelease.nativeBinding, requestRef: "other" } }]) {
    assert.throws(() => s.remember({ request: r, output: output(r), generation: { ...base, workRelease: release } as any, capturedAt: 1 }));
  }
  assert.throws(() => s.remember({ request: r, output: output(r), generation: { ...base, resourcesSettled: true, workRelease }, capturedAt: 1 }));
  const note = await s.remember({ request: r, output: output(r), generation: { ...base, workRelease }, capturedAt: 1 }); assert.ok(note);
  assert.equal(Object.hasOwn(note.provenance.generation, "resourcesSettled"), false);
  assert.deepEqual(note.provenance.generation, { ...base, workRelease }); await s.close();
  const reopened = await store(t, directory); assert.deepEqual((await reopened.lookup(r))?.provenance.generation, { ...base, workRelease });
});

test("consumer requires current-bound admitted note and omits whole claims at a measured byte boundary", async t => {
  const directory = await root(t), s = await store(t, directory), a = await task(t, directory, "1", { save: false }), r = request(a.selection);
  const many = { ...output(r), claims: Array.from({ length: 8 }, (_, i) => ({ ...output(r).claims[0]!, text: `${i} ${"Detailed observed claim. ".repeat(20)}` })) };
  const note = await s.remember({ request: r, output: many, generation: generation(r), capturedAt: 1 }); assert.ok(note);
  const full = consumeStandingHistoryPeriodChronicle({ request: r, note, maxBytes: 16384 })!;
  const limit = Buffer.byteLength(JSON.stringify(full)) - 600;
  const bounded = consumeStandingHistoryPeriodChronicle({ request: r, note, maxBytes: limit })!;
  assert.ok(bounded.claims.length > 0 && bounded.claims.length < 8); assert.equal(bounded.omittedClaims, 8 - bounded.claims.length); assert.equal(bounded.omittedDetailCount, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= limit); assert.deepEqual(bounded.claims, many.claims.slice(0, bounded.claims.length));
  assert.throws(() => consumeStandingHistoryPeriodChronicle({ request: r, note: structuredClone(note) }));
  const b = await task(t, directory, "2", { save: false }); assert.throws(() => consumeStandingHistoryPeriodChronicle({ request: request(b.selection), note }));
});

test("encrypted neutral entries contain no plaintext, corruption remains a miss and is not overwritten", async t => {
  const directory = await root(t), s = await store(t, directory), a = await task(t, directory, "1", { save: false }), r = request(a.selection);
  await s.remember({ request: r, output: output(r), generation: generation(r), capturedAt: 1 });
  const [name] = await readdir(join(directory, "neutral-notes")), path = join(directory, "neutral-notes", name!), bytes = await readFile(path, "utf8");
  for (const text of [output(r).summary, "Private synthetic original", a.selection.intent.taskId, "synthetic-neutral-request"]) assert.equal(bytes.includes(text), false);
  await writeFile(path, "broken optional neutral note"); assert.equal(await s.lookup(r), undefined);
  assert.equal(await s.remember({ request: r, output: output(r), generation: generation(r), capturedAt: 2 }), undefined);
  assert.equal(await readFile(path, "utf8"), "broken optional neutral note"); assert.equal((await a.source.status()).storage, "ready");
});

test("oversized neutral packet refuses without dropping or cropping complete source rows", async t => {
  const directory = await root(t), a = await task(t, directory, "1", { save: false, rows: 8, text: "ж".repeat(3600) });
  const first = a.selection.materials[0]!, projected = projectStandingHistorySource({ intent: a.selection.intent, referenceKey: a.selection.referenceKey, storedPage: first.page });
  assert.ok(projected.nextPosition);
  const second = projectStandingHistorySource({ intent: a.selection.intent, referenceKey: a.selection.referenceKey, storedPage: first.page, position: projected.nextPosition! });
  const selection = { ...a.selection, materials: [...a.selection.materials, { page: first.page, request: { pageIndex: 1, maxBytes: 49152, position: projected.nextPosition!, materialRef: second.materialRef } }] };
  assert.throws(() => request(selection));
  assert.equal((await a.source.readPage(1))!.result.sources.length, 8);
});

for (const count of [17, MAX_CLAIMS]) test(`neutral cache roundtrips ${count} claims within its independent byte budget`, async t => {
  const directory = await root(t), a = await task(t, directory, "1", { save: false }), r = request(a.selection), s = await store(t, directory);
  const many = { ...output(r), claims: Array.from({ length: count }, (_, i) => ({ ...output(r).claims[0]!, text: `Reported event ${i}` })) };
  assert.deepEqual((await s.remember({ request: r, output: many, generation: generation(r), capturedAt: 1 }))?.output, many);
  await s.close(); const reopened = await store(t, directory), note = await reopened.lookup(r); assert.ok(note);
  assert.deepEqual(note.output, many);
  const advisory = consumeStandingHistoryPeriodChronicle({ request: r, note }); assert.ok(advisory);
  assert.equal(advisory.claims.length + advisory.omittedClaims, count);
  assert.ok(Buffer.byteLength(JSON.stringify(advisory)) <= 8192);
});

test("valid oversized neutral output is an optional miss before state creation and permits a later bounded capture", async t => {
  const directory = await root(t), a = await task(t, directory, "1", { save: false }), r = request(a.selection), s = await store(t, directory);
  const large = { ...output(r), claims: Array.from({ length: MAX_CLAIMS }, (_, i) => ({ ...output(r).claims[0]!, text: `${i} ${"x".repeat(1000)}` })) };
  assert.equal(validateStandingHistoryShownOutput(large, r.material.rows.map(({ sourceRef, versionRef }) => ({ sourceRef, versionRef }))).claims.length, MAX_CLAIMS);
  assert.equal(await s.remember({ request: r, output: large, generation: generation(r), capturedAt: 1 }), undefined);
  assert.equal((await readdir(directory)).includes("neutral-notes"), false);
  assert.ok(await s.remember({ request: r, output: output(r), generation: generation(r), capturedAt: 2 }));
  assert.equal((await a.analysis.status()).analysisNodes, 0);
});

for (const count of [8, 9]) test(`neutral preparation admits ${count} whole fragments within its packet budget`, async t => {
  const directory = await root(t), a = await task(t, directory, "1", { save: false, rows: count });
  const page = a.selection.materials[0]!.page, materials: StandingHistoryChronicleSelection["materials"][number][] = [];
  let position: string | undefined;
  for (let i = 0; i < count; i++) {
    const fragment = projectStandingHistorySource({ intent: a.selection.intent, referenceKey: a.selection.referenceKey, storedPage: page, maxRows: 1,
      ...(position === undefined ? {} : { position }) });
    materials.push({ page, request: { pageIndex: 1, materialRef: fragment.materialRef, maxBytes: 49152, maxRows: 1,
      ...(position === undefined ? {} : { position }) } });
    position = fragment.nextPosition ?? undefined;
  }
  const r = request({ ...a.selection, materials }); assert.equal(r.material.rows.length, count);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 49152); assert.equal(position, undefined);
});

test("optional neutral and cached context accepts the full primary support contract without enlarging its packet", async t => {
  const directory = await root(t), a = await task(t, directory, "1", { save: false }), r = request(a.selection), s = await store(t, directory);
  const note = await s.remember({ request: r, output: output(r), generation: generation(r), capturedAt: 1 }); assert.ok(note);
  const advisory = consumeStandingHistoryPeriodChronicle({ request: r, note }); assert.ok(advisory);
  const supports = [...r.material.rows.map(({ sourceRef, versionRef }) => ({ sourceRef, versionRef })),
    ...Array.from({ length: MAX_SUPPORTS - r.material.rows.length }, (_, i) => ({ sourceRef: "hsrc_" + i.toString(16).padStart(48, "0"), versionRef: "hver_" + i.toString(16).padStart(48, "0") }))];
  assert.deepEqual(validateStandingHistoryShownOutput(output(r), supports), output(r));
  for (const optional of [{ neutralRequest: r }, { advisory }, { neutralRequest: r, advisory }]) {
    const turn = createStandingHistoryPeriodChronicleTurn({ requestRef: "large-primary", signal: new AbortController().signal, ...optional });
    assert.doesNotThrow(() => turn.assertMaterialBinding({ requestRef: "large-primary", supports }));
    turn.close();
  }
  const rejected = createStandingHistoryPeriodChronicleTurn({ requestRef: "too-large", signal: new AbortController().signal, neutralRequest: r });
  assert.throws(() => rejected.assertMaterialBinding({ requestRef: "too-large", supports: [...supports, supports[0]!] })); rejected.close();
  const absent = createStandingHistoryPeriodChronicleTurn({ requestRef: "missing-source", signal: new AbortController().signal, neutralRequest: r });
  assert.throws(() => absent.assertMaterialBinding({ requestRef: "missing-source", supports: supports.slice(r.material.rows.length) })); absent.close();
});
