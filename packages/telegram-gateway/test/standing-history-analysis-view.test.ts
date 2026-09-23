import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { projectMergeView, readNodeNotes, StandingHistoryAnalysisViewError } from "../src/standing-history-analysis-view.js";
import type { StandingHistoryAnalysisNode, StandingHistoryAnalysisSpan } from "../src/standing-history-analysis-store.js";
import { validateStandingHistoryShownOutput, StandingHistoryAnalysisStoreError } from "../src/standing-history-analysis-store.js";

const key = "a".repeat(64), size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const ref = (prefix: string, n: number) => prefix + "_" + n.toString(16).padStart(48, "0");
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
function node(n = 1, heavy = false): StandingHistoryAnalysisNode {
  const coverage: StandingHistoryAnalysisSpan[] = [{ materialRef: ref("hmat", n), pageIndex: n, pageHash: "f".repeat(64), range: { fromRow: 0, toRow: 1, totalRows: 1 },
    coverage: { sourcePageStatus: "more", sourcePageCoverage: { scope: "available-history-snapshot", oldestExaminedDate: 10, newestExaminedDate: 20,
      traversalComplete: false, undatedEntries: 0, pages: n }, sourcePageExcluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, sourceRowsReturned: 1, fragmentComplete: true } }];
  return { nodeRef: ref("hnode", n), hash: n.toString(16).padStart(64, "0"), kind: "leaf", index: n, inputs: { materials: [] }, coverage,
    output: { summary: heavy ? "\u0001".repeat(4095) + "x" : "Сводка 🙂", claims: Array.from({ length: heavy ? 16 : 1 }, (_, i) => ({
      kind: "reported", text: heavy ? "\u0002".repeat(1023) + "x" : "Сообщили о решении",
      supports: Array.from({ length: heavy ? 16 : 1 }, (_, s) => ({ sourceRef: ref("hsrc", n * 1000 + i * 16 + s), versionRef: ref("hver", n * 1000 + i * 16 + s) })) })), omittedDetailCount: heavy ? 7 : 0 } };
}
const error = (code: StandingHistoryAnalysisViewError["code"]) => (v: unknown) => v instanceof StandingHistoryAnalysisViewError && v.code === code && v.message === "STANDING_HISTORY_ANALYSIS_VIEW_" + code.toUpperCase();

test("large merge opt-in preserves 32KiB summaries and 128 claims while legacy defaults remain exact", () => {
  const legacy = [node(1, true), node(2, true)], before = projectMergeView({ children: legacy, referenceKey: key, preferComplete: true });
  const rich = [node(3), node(4)].map(n => ({ ...n, output: { summary: "я".repeat(16384),
    claims: Array.from({ length: 128 }, (_, i) => ({ kind: "reported" as const, text: "Claim " + i,
      supports: [{ sourceRef: ref("hsrc", i + 1), versionRef: ref("hver", i + 1) }] })) } }));
  const large = projectMergeView({ children: rich, referenceKey: key, maxBytes: 1048576, preferComplete: true });
  assert.equal(large.detailCoverage, "complete"); assert.ok(size(large) > 49152 && size(large) <= 1048576);
  for (const [index, child] of large.children.entries()) { assert.equal(child.summary.text, rich[index]!.output.summary); assert.equal(child.claims.length, 128); }
  assert.deepEqual(projectMergeView({ children: legacy, referenceKey: key, preferComplete: true }), before);
  let notes = readNodeNotes({ node: rich[0]!, referenceKey: key });
  while (notes.nextPosition) notes = readNodeNotes({ node: rich[0]!, referenceKey: key, position: notes.nextPosition });
  assert.equal(notes.summary.range.toByte, 32768, "expanded authenticated cursor offsets can retrieve the complete long summary");
});

test("large merge accepts 200 complete children by bytes while ledger capacity remains structural", () => {
  const children = Array.from({ length: 200 }, (_, i) => node(i + 1));
  const result = projectMergeView({ children, referenceKey: key, maxBytes: 1048576, preferComplete: true });
  assert.equal(result.children.length, 200); assert.equal(result.detailCoverage, "complete"); assert.ok(size(result) <= 1048576);
  assert.throws(() => projectMergeView({ children: Array.from({ length: 1025 }, (_, i) => node(i + 1)), referenceKey: key, maxBytes: 1048576 }), error("input"));
});

test("small paired view preserves complete notes, exact coverage commitment and immediate supports", () => {
  const a = node(), b = node(2), before = JSON.stringify([a, b]), result = projectMergeView({ children: [a, b], referenceKey: key });
  assert.equal(result.detailCoverage, "complete"); assert.ok(size(result) <= 49152); assert.equal(JSON.stringify([a, b]), before);
  for (const [i, child] of result.children.entries()) {
    const original = [a, b][i]!;
    assert.equal(child.summary.text, original.output.summary); assert.equal(child.summary.complete, true);
    assert.deepEqual(child.claims.map(({ claimIndex, ...claim }) => claim), original.output.claims);
    assert.equal(child.nextPosition, null); assert.deepEqual(child.omittedClaimIndices, []);
    assert.equal(child.coverage.commitment, createHash("sha256").update(canonical(original.coverage)).digest("hex"));
    assert.equal(child.coverage.sourceRows, 1); assert.equal(child.supportScope, "immediate-node-claims-only");
  }
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("maximum escaped outputs fit paired wire and retain a whole claim per child without fabricated completeness", () => {
  const a = node(1, true), b = node(2, true), result = projectMergeView({ children: [a, b], referenceKey: key });
  assert.ok(size([a.output, b.output]) > 49152); assert.ok(size(result) <= 49152); assert.equal(result.detailCoverage, "partial");
  for (const [i, child] of result.children.entries()) {
    const original = [a, b][i]!;
    assert.ok(child.claims.length >= 1); assert.equal(child.summary.complete, false); assert.ok(child.nextPosition);
    assert.deepEqual(child.omittedClaimIndices, Array.from({ length: 16 - child.claims.length }, (_, index) => index + child.claims.length));
    child.claims.forEach(c => assert.deepEqual({ kind: c.kind, text: c.text, supports: c.supports }, original.output.claims[c.claimIndex]));
    assert.equal(child.modelAuthoredOmittedDetailCount, 7); assert.equal(child.claimsStatus, "model-authored-unverified");
  }
  assert.deepEqual(projectMergeView({ children: [a, b], referenceKey: key }), result);
});

test("merge output cannot cite hidden notes until their bounded continuation was shown", () => {
  const a = node(1, true), b = node(2, true);
  const first = projectMergeView({ children: [a, b], referenceKey: key });
  const shown = first.children.flatMap(child => child.claims.flatMap(claim => claim.supports));
  const hiddenIndex = first.children[0].omittedClaimIndices[0]!;
  assert.ok(Number.isInteger(hiddenIndex));
  const hidden = a.output.claims[hiddenIndex]!;
  const output = { summary: "Сводка по указанному источнику", claims: [hidden] };
  assert.throws(() => validateStandingHistoryShownOutput(output, shown),
    error => error instanceof StandingHistoryAnalysisStoreError && error.code === "support");
  let page = first.children[0];
  while (!page.claims.some(claim => claim.claimIndex === hiddenIndex)) {
    assert.ok(page.nextPosition);
    page = readNodeNotes({ node: a, referenceKey: key, position: page.nextPosition });
    shown.push(...page.claims.flatMap(claim => claim.supports));
  }
  const accepted = validateStandingHistoryShownOutput(output, shown);
  assert.deepEqual(accepted, output); assert.ok(Object.isFrozen(accepted.claims[0]!.supports));
  const wrongVersion = { ...hidden, supports: [{ ...hidden.supports[0]!, versionRef: ref("hver", 99999) }] };
  assert.throws(() => validateStandingHistoryShownOutput({ ...output, claims: [wrongVersion] }, shown),
    error => error instanceof StandingHistoryAnalysisStoreError && error.code === "support");
});

test("shown-output validation detaches model data and refuses accessor or oversized support inventories", () => {
  const support = { sourceRef: ref("hsrc", 1), versionRef: ref("hver", 1) };
  const value = { summary: "summary", claims: [{ kind: "reported", text: "text", supports: [support] }] };
  const snapshot = validateStandingHistoryShownOutput(value, [support]);
  support.sourceRef = ref("hsrc", 2); value.claims[0]!.text = "changed";
  assert.equal(snapshot.claims[0]!.text, "text"); assert.equal(snapshot.claims[0]!.supports[0]!.sourceRef, ref("hsrc", 1));
  let accesses = 0;
  const hostile = Object.defineProperty({}, "sourceRef", { enumerable: true, get() { accesses++; return support.sourceRef; } });
  assert.throws(() => validateStandingHistoryShownOutput(value, [hostile as typeof support]));
  assert.equal(accesses, 0);
  assert.throws(() => validateStandingHistoryShownOutput(value, Array(16385).fill(support)));
  assert.deepEqual(validateStandingHistoryShownOutput({ summary: "No supported claims", claims: [] }, []),
    { summary: "No supported claims", claims: [] });
});

test("paired continuations retrieve both independently advancing suffixes exactly once across stateless calls", () => {
  const a = node(1, true), b = node(2, true), first = projectMergeView({ children: [a, b], referenceKey: key }).children[0];
  let page = first, summary = "", summaryOffset = 0, claimOffset = 0, rounds = 0; const claims: unknown[] = [];
  for (;;) {
    assert.ok(size(page) <= 49152); assert.equal(page.summary.range.fromByte, summaryOffset); assert.equal(page.claimRange.fromClaim, claimOffset);
    summary += page.summary.text; summaryOffset = page.summary.range.toByte;
    for (const c of page.claims) { assert.equal(c.claimIndex, claimOffset++); const { claimIndex, ...claim } = c; claims.push(claim); }
    if (!page.nextPosition) break;
    // Simulated reopen: a fresh deserialized authenticated host-node snapshot.
    page = readNodeNotes({ node: JSON.parse(JSON.stringify(a)), referenceKey: key, position: page.nextPosition });
    assert.ok(++rounds < 20);
  }
  assert.equal(summary, a.output.summary); assert.deepEqual(claims, a.output.claims); assert.equal(summaryOffset, 4096);
  assert.equal(page.detailCoverage, "partial"); assert.equal(page.summary.complete, false); // final page is not the entire notes
});

test("UTF8 fragments respect astral and multibyte boundaries under changing page budgets", () => {
  const a = { ...node(), output: { summary: "🙂Яe".repeat(580), claims: [] } };
  let position: string | undefined, result = "", previous = 0, rounds = 0;
  do {
    const page = readNodeNotes({ node: a, referenceKey: key, maxBytes: rounds % 2 ? 2400 : 1800, ...(position ? { position } : {}) });
    assert.ok(size(page) <= (rounds % 2 ? 2400 : 1800)); assert.equal(page.summary.range.fromByte, previous);
    assert.equal(Buffer.from(page.summary.text).toString("utf8"), page.summary.text); assert.equal(page.summary.text.includes("�"), false);
    result += page.summary.text; previous = page.summary.range.toByte; position = page.nextPosition ?? undefined;
    assert.ok(++rounds < 40);
  } while (position);
  assert.equal(result, a.output.summary);
});

test("positions bind ref, hash, content and key; tampering and transplant errors contain no supplied text", () => {
  const a = node(1, true), position = readNodeNotes({ node: a, referenceKey: key }).nextPosition!;
  assert.ok(position);
  for (const other of [{ ...a, nodeRef: ref("hnode", 5) }, { ...a, hash: "b".repeat(64) }, { ...a, output: { ...a.output, summary: "changed" } }]) {
    assert.throws(() => readNodeNotes({ node: other, referenceKey: key, position }), error("position"));
  }
  assert.throws(() => readNodeNotes({ node: a, referenceKey: "b".repeat(64), position }), error("position"));
  const tampered = position.slice(0, -1) + (position.endsWith("0") ? "1" : "0");
  assert.throws(() => readNodeNotes({ node: a, referenceKey: key, position: tampered }), error("position"));
  assert.throws(() => readNodeNotes({ node: a, referenceKey: key, position: "private injected text" }), error("input"));
});

test("large expanded coverage stays compact and does not expose material/page selectors", () => {
  const base = node(), a = { ...base, coverage: Array.from({ length: 16384 }, (_, i) => ({ ...base.coverage[0]!, materialRef: ref("hmat", i + 1) })) };
  const result = readNodeNotes({ node: a, referenceKey: key });
  assert.equal(result.coverage.spanCount, 16384); assert.equal(result.coverage.sourceRows, 16384); assert.ok(size(result) < 3000);
  assert.equal(JSON.stringify(result).includes(base.coverage[0]!.materialRef), false); assert.equal(JSON.stringify(result).includes(base.coverage[0]!.pageHash), false);
});

test("input and tiny-budget failures never skip an atomic claim or mutate supplied nodes", () => {
  const a = node(1, true), b = node(2, true);
  for (const maxBytes of [0, 1023, 1048577, NaN, 1200.5]) assert.throws(() => readNodeNotes({ node: a, referenceKey: key, maxBytes }), error("input"));
  assert.throws(() => projectMergeView({ children: [a, b], referenceKey: key, maxBytes: 1024 }), error("limit"));
  assert.throws(() => projectMergeView({ children: [a, a], referenceKey: key }), error("binding"));
  let reads = 0; const getter = Object.defineProperty({ ...a.output }, "summary", { enumerable: true, get() { reads++; return "private"; } });
  assert.throws(() => readNodeNotes({ node: { ...a, output: getter }, referenceKey: key }), error("input")); assert.equal(reads, 0);
  assert.throws(() => readNodeNotes({ node: new Proxy(a, {}), referenceKey: key }), error("input"));
  const first = readNodeNotes({ node: a, referenceKey: key, maxBytes: 1800 });
  assert.equal(first.claimRange.toClaim, 0); assert.ok(first.summary.range.toByte > 0); assert.ok(first.nextPosition);
  const next = readNodeNotes({ node: a, referenceKey: key, position: first.nextPosition!, maxBytes: 49152 });
  assert.equal(next.claimRange.fromClaim, 0); assert.ok(next.claims.length); assert.equal(next.claims[0]!.supports.length, 16);
});

test("wide view admits eight complete children and refuses oversized or duplicate groups", () => {
  const children = Array.from({ length: 8 }, (_, i) => node(i + 1)), original = JSON.stringify(children);
  const result = projectMergeView({ children, referenceKey: key, preferComplete: true });
  assert.equal(result.children.length, 8); assert.equal(result.detailCoverage, "complete"); assert.ok(size(result) <= 49152);
  assert.equal(JSON.stringify(children), original);
  for (const [i, child] of result.children.entries()) {
    assert.equal(child.nodeRef, children[i]!.nodeRef); assert.equal(child.summary.text, children[i]!.output.summary);
    assert.deepEqual(child.claims.map(({ claimIndex, ...claim }) => claim), children[i]!.output.claims);
    assert.equal(child.nextPosition, null); assert.deepEqual(child.omittedClaimIndices, []);
  }
  assert.throws(() => projectMergeView({ children: Array.from({ length: 1025 }, (_, i) => node(i + 1)), referenceKey: key, preferComplete: true }), error("input"));
  assert.throws(() => projectMergeView({ children: [node(), node(2), node()], referenceKey: key, preferComplete: true }), error("binding"));
  assert.throws(() => projectMergeView({ children: [node(1, true), node(2, true), node(3)], referenceKey: key, preferComplete: true }), error("limit"));
});

test("complete packing is opt-in and preserves historical pair projection for reserved hashes", () => {
  const a = node(1, true), b = node(2), legacy = projectMergeView({ children: [a, b], referenceKey: key });
  assert.deepEqual(projectMergeView({ children: [a, b], referenceKey: key, preferComplete: false }), legacy);
  // If even the complete pair does not fit, the old explicit partial view and
  // its authenticated continuations remain the exact fallback.
  assert.deepEqual(projectMergeView({ children: [a, b], referenceKey: key, preferComplete: true }), legacy);
  const moderate = { ...node(1), output: { summary: "Summary".repeat(500), claims: Array.from({ length: 16 }, () => ({
    kind: "reported" as const, text: "Claim".repeat(180), supports: node(1).output.claims[0]!.supports })) } };
  const packed = projectMergeView({ children: [moderate, node(2)], referenceKey: key, preferComplete: true });
  assert.equal(packed.detailCoverage, "complete"); assert.equal(packed.children[0].claims.length, 16);
});
