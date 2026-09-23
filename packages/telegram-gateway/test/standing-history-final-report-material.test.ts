import test from "node:test";
import assert from "node:assert/strict";
import { createStandingHistoryFinalReportMaterial } from "../src/standing-history-final-report-material.js";
import type { StandingHistoryAnalysisNode, StandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import type { StandingHistoryTaskStore, StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import type { StandingHistoryTaskReadiness } from "../src/standing-history-task-delivery.js";
import { MAX_ANALYSIS_NODES } from "../src/standing-history-analysis-limits.js";
import { ANALYSIS_TOOL_TEXT_BYTES } from "../src/standing-tool-dispatcher.js";

const ref = (n: number) => "hnode_" + n.toString(16).padStart(48, "0");
function node(n: number, children?: number[], heavy = false): StandingHistoryAnalysisNode {
  return { nodeRef: ref(n), kind: children ? "merge" : "leaf", index: n, hash: "a".repeat(64),
    inputs: children ? { children: children.map(ref) } : { materials: [] }, coverage: [],
    output: { summary: heavy ? "\u0001".repeat(4095) + "x" : "Internal notes",
      claims: Array.from({ length: heavy ? 16 : 1 }, (_, i) => ({ kind: "reported", text: heavy ? "\u0002".repeat(1023) + "x" : "Observed fact",
        supports: [{ sourceRef: "hsrc_" + (i + 1).toString(16).padStart(48, "0"), versionRef: "hver_" + "1".repeat(48) }] })) } };
}
const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "1".repeat(48),
  accountId: "7890123456", chatId: "-10012345678", requesterId: "4560123456", primaryMessageId: 2100,
  fromDate: 100, toDate: 1000, timezone: "Europe/Moscow", objective: "Explain the issues" };
const readiness: StandingHistoryTaskReadiness = { kind: "analysis-ready", rootRef: ref(3), sourceHead: "a".repeat(64), expectedHead: "b".repeat(64),
  coverage: { committedPages: 2, coveredPages: 2, sourceRows: 2, coveredRows: 2, readStatus: "lower-bound-reached", readTraversalComplete: true,
    excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 } }, gaps: [] };
async function fixture(heavy = false) {
  const nodes = new Map([node(1), node(2, [1]), node(3, [2], heavy), node(4)].map(n => [n.nodeRef, n]));
  const reads: string[] = [], sourceReads: number[] = [];
  const analysis = { referenceKey: () => "a".repeat(64), async readNode(r: string) { reads.push(r); return nodes.get(r); } } as StandingHistoryAnalysisStore;
  const source = { async readPage(i: number) { sourceReads.push(i); return undefined; } } as StandingHistoryTaskStore;
  const helper = await createStandingHistoryFinalReportMaterial({ intent: heavy ? { ...intent, objective: "\u0001".repeat(4095) + "x" } : intent, readiness, analysis, source });
  return { helper, reads, sourceReads, nodes };
}
test("final material preserves escaped objective and paginates all root notes under the wire budget", async () => {
  const { helper, nodes } = await fixture(true);
  const material = await helper.material(49152) as { objective: string; root: { summary: { text: string }; claims: { claimIndex: number }[]; nextPosition: string | null }; interpretation: string };
  assert.ok(Buffer.byteLength(JSON.stringify(material)) <= 49152);
  assert.equal(material.objective.length, 4096); assert.match(material.interpretation, /untrusted/);
  let part = material.root, summary = part.summary.text;
  const claims = [...part.claims];
  while (part.nextPosition) {
    part = await helper.notes({ nodeRef: ref(3), position: part.nextPosition }) as typeof part;
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 49152);
    summary += part.summary.text; claims.push(...part.claims);
  }
  assert.equal(summary, nodes.get(ref(3))!.output.summary);
  assert.deepEqual(claims.map(c => c.claimIndex), Array.from({ length: 16 }, (_, i) => i));
});
test("notes resolve descendants from root edges and never read an unrelated selector", async () => {
  const { helper, reads } = await fixture();
  const descendant = await helper.notes({ nodeRef: ref(1), position: null }) as { nodeRef: string; children: unknown[] };
  assert.equal(descendant.nodeRef, ref(1)); assert.deepEqual(descendant.children, []);
  await assert.rejects(helper.notes({ nodeRef: ref(4), position: null }));
  assert.equal(reads.includes(ref(4)), false);
});
test("source and note arguments refuse extra selectors, getters, and out-of-snapshot pages", async () => {
  const { helper, sourceReads } = await fixture(); let invoked = false;
  await assert.rejects(helper.notes({ get nodeRef() { invoked = true; return ref(3); }, position: null }));
  await assert.rejects(helper.notes({ nodeRef: ref(3), position: null, chatId: intent.chatId }));
  await assert.rejects(helper.source({ purpose: "other", pageIndex: 1 }));
  await assert.rejects(helper.source({ purpose: "final-report-source", pageIndex: 3 }));
  await assert.rejects(helper.source({ purpose: "final-report-source", pageIndex: 1, fromRow: 0 }));
  assert.equal(invoked, false); assert.deepEqual(sourceReads, []);
});

for (const width of [8, 22, 128, 200, MAX_ANALYSIS_NODES - 1]) test(`final report traverses ${width}-child merges with bounded paginated notes`, async () => {
  const children = Array.from({ length: width }, (_, i) => i + 1);
  const root: StandingHistoryAnalysisNode = { ...node(MAX_ANALYSIS_NODES, children, true), output: { summary: "\u0001".repeat(32768), claims: Array.from({ length: 128 }, (_, i) => ({ kind: "reported", text: "\u0002".repeat(1000),
    supports: [{ sourceRef: "hsrc_" + (i + 1).toString(16).padStart(48, "0"), versionRef: "hver_" + "1".repeat(48) }] })) } };
  const nodes = new Map([root, ...children.map(i => node(i)), ...(width < MAX_ANALYSIS_NODES - 1 ? [node(width + 1)] : []), node(MAX_ANALYSIS_NODES + 2)].map(n => [n.nodeRef, n]));
  if (width < MAX_ANALYSIS_NODES - 1) nodes.set(ref(1), node(1, [width + 1]));
  const reads: string[] = [];
  const analysis = { referenceKey: () => "a".repeat(64), async readNode(r: string) { reads.push(r); return nodes.get(r); } } as StandingHistoryAnalysisStore;
  const helper = await createStandingHistoryFinalReportMaterial({ intent, readiness: { ...readiness, rootRef: root.nodeRef }, analysis, source: {} as StandingHistoryTaskStore });
  type Notes = { summary: { text: string }; claims: { claimIndex: number }[]; nextPosition: string | null; children: string[] };
  const materialBudget = width <= 128 ? 12000 : width === 200 ? 20000 : ANALYSIS_TOOL_TEXT_BYTES;
  if (width === MAX_ANALYSIS_NODES - 1) await assert.rejects(helper.material(49152), /STANDING_HISTORY_FINAL_REPORT_MATERIAL_INPUT/);
  const material = await helper.material(materialBudget) as { root: Notes };
  assert.ok(Buffer.byteLength(JSON.stringify(material)) <= materialBudget);
  assert.deepEqual(material.root.children, children.map(ref));
  assert.equal((await helper.notes({ nodeRef: ref(width), position: null }) as { nodeRef: string }).nodeRef, ref(width));
  let page = material.root, summary = page.summary.text; const indices = page.claims.map(c => c.claimIndex);
  for (let calls = 0; page.nextPosition !== null; calls++) {
    assert.ok(calls < 100);
    page = await helper.notes({ nodeRef: root.nodeRef, position: page.nextPosition }) as Notes;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= ANALYSIS_TOOL_TEXT_BYTES);
    assert.deepEqual(page.children, children.map(ref)); summary += page.summary.text; indices.push(...page.claims.map(c => c.claimIndex));
  }
  assert.equal(summary, root.output.summary); assert.deepEqual(indices, Array.from({ length: 128 }, (_, i) => i));
  if (width < MAX_ANALYSIS_NODES - 1) assert.equal((await helper.notes({ nodeRef: ref(width + 1), position: null }) as { nodeRef: string }).nodeRef, ref(width + 1));
  await assert.rejects(helper.notes({ nodeRef: ref(MAX_ANALYSIS_NODES + 2), position: null })); assert.equal(reads.includes(ref(MAX_ANALYSIS_NODES + 2)), false);
});
