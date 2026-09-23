import { standingHistoryReportBodyHash } from "../src/standing-history-report-quality.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore } from "../src/standing-history-analysis-store.js";
import { openStandingHistoryAnalysisAttemptStore, type StandingHistoryAnalysisNativeBinding } from "../src/standing-history-analysis-attempt-store.js";
import { createStandingHistoryAnalysisPlanner } from "../src/standing-history-analysis-planner.js";
import { ANALYSIS_TOOL_SPECS, prepareStandingHistoryAnalysisMaterial } from "../src/standing-history-analysis-runtime.js";
import { prepareStandingHistoryReportStage as finalizeStandingHistoryReport, finalizeStandingHistoryReport as finalizeReviewedReport, canContinueStandingHistoryReport } from "../src/standing-history-final-report.js";
import type { StandingHistoryAnalysisStepConnection, StandingHistoryAnalysisStepLease } from "../src/standing-history-analysis-step.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
const nativeBinding: StandingHistoryAnalysisNativeBinding = { epochId: "a".repeat(32), requestRef: "final-report", purpose: "history-analysis" };
async function fixture(t: TestContext, mergeWidth = 1) {
  const outcome = "observed", objective = "Explain complaints and what to do next";
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-finalizer-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-finalizer-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pages: join(root, "pages"), control: join(root, "control"), analysis: join(root, "analysis"), attempts: join(root, "attempts"), reports: join(root, "reports") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + "7".repeat(48), accountId: "123", chatId: "-100456", requesterId: "456", primaryMessageId: 999,
    fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective };
  const passphrase = "synthetic-task-delivery-passphrase", binding = { intent, passphrase }, controller = new AbortController();
  const source = await openStandingHistoryTaskStore({ ...binding, directory: directories.pages, mode: "create" });
  const control = await openStandingHistoryTaskControlStore({ ...binding, directory: directories.control, mode: "create" });
  const analysis = await openStandingHistoryAnalysisStore({ ...binding, directory: directories.analysis, mode: "create", readSourcePage: i => source.readPage(i) });
  const attempts = await openStandingHistoryAnalysisAttemptStore({ ...binding, directory: directories.attempts, mode: "create", analysis });
  const pageCount = Math.ceil(mergeWidth / 100);
  for (let pageIndex = 1; pageIndex <= pageCount; pageIndex++) {
    const before = (await source.status()).readProgress.checkpoint;
    const start = (pageIndex - 1) * 100;
    const sources = Array.from({ length: Math.min(100, mergeWidth - start) }, (_, offset) => {
      const i = start + offset;
      return { messageId: 998 - i, date: 1500 - i, disposition: "included" as const,
        messageRef: "m_" + (mergeWidth === 1 ? "1".repeat(24) : (i + 1).toString(16).padStart(24, "0")), authorId: "456" };
    });
    const complete = pageIndex === pageCount;
    const after = { ...before, offsetId: sources.at(-1)!.messageId, lastDate: sources.at(-1)!.date, oldestDate: sources.at(-1)!.date,
      newestDate: 1500, upperBoundMessageId: 998, pages: pageIndex, status: complete ? "lower-bound-reached" as const : "more" as const };
    await source.appendPage({ expectedCheckpoint: before, result: { beforeCheckpoint: before, nextCheckpoint: after,
      sources, page: {
        schema: "neurobro-self-history-v1", fromDate: 1000, toDate: 2000,
        messages: [...sources].reverse().map(s => ({ ref: s.messageRef, authorRef: "a_" + "2".repeat(24), author: "user" as const, displayName: "Synthetic speaker", date: s.date, editedAt: null, replyRef: null, replyUnavailable: false, text: "Private source from disk" })),
        cursor: null, hasMore: !complete, status: after.status, coverage: { scope: "available-history-snapshot", oldestExaminedDate: after.oldestDate, newestExaminedDate: 1500, traversalComplete: complete, undatedEntries: 0, pages: pageIndex },
        excluded: { nonText: 0, invalidText: 0, unavailable: 0, outsidePeriod: 0 }, limitations: ["text-only", "not-a-full-archive", "deleted-or-hidden-content-not-recoverable", "edits-may-change-between-pages"] } } });
  }
  const planner = createStandingHistoryAnalysisPlanner({ intent, source, analysis });
  async function selected() { for (let i = 0; i < 512; i++) { const result = await planner.next(); if (result.kind !== "scan-more") return result; } throw Error("fixture planner did not finish"); }
  if (mergeWidth > 1) {
    const { projectStandingHistorySource } = await import("../src/standing-history-source-projection.js");
    const children: string[] = [];
    for (let pageIndex = 1; pageIndex <= pageCount; pageIndex++) {
      const page = (await source.readPage(pageIndex))!; let position: string | undefined;
      do {
        const material = projectStandingHistorySource({ intent, referenceKey: analysis.referenceKey(), storedPage: page, maxBytes: 49152, maxRows: 1, ...(position ? { position } : {}) });
        const leaf = await analysis.appendLeaf({ expectedHead: (await analysis.status()).headHash,
          inputs: [{ pageIndex, materialRef: material.materialRef, maxBytes: 49152, maxRows: 1, ...(position ? { position } : {}) }],
          output: { summary: "Saved child " + children.length, claims: [] } });
        children.push(leaf.nodeRef); position = material.nextPosition ?? undefined;
      } while (position);
    }
    assert.equal(children.length, mergeWidth);
    await analysis.appendMerge({ expectedHead: (await analysis.status()).headHash, children, output: { summary: "Private root summary", claims: [] } });
  } else {
  const plan = await selected(); assert.equal(plan.kind, "leaf"); if (plan.kind !== "leaf") throw Error("expected leaf");
  const material = prepareStandingHistoryAnalysisMaterial(plan);
  const reservation = await attempts.reserve({ plan: { kind: "leaf", sourceHead: plan.sourceHead, expectedHead: plan.expectedHead, nodeIndex: 1, inputs: plan.inputs, modelInputHash: material.modelInputHash }, nativeBinding });
  await attempts.prepare({ attemptRef: reservation.attemptRef, output: { summary: "Private root summary", claims: [] } });
  const node = await attempts.commitPrepared({ attemptRef: reservation.attemptRef });
  await attempts.recordModelOutcome({ attemptRef: reservation.attemptRef, outcome });
  }
  const readiness = await selected(); assert.equal(readiness.kind, "analysis-ready"); if (readiness.kind !== "analysis-ready") throw Error("expected ready");
  await planner.close(); await attempts.close(); await analysis.close(); await source.close(); await control.close();

  const args = { ...binding, directories, readiness, signal: controller.signal, requestRef: nativeBinding.requestRef,
    async verifyOwnerSettled(value: StandingHistoryAnalysisNativeBinding) { return { schema: "standing-analysis-owner-settlement-v1" as const, nativeBinding: value, persisted: true as const, resourcesSettled: true as const, replacementReady: true as const, modelOutcome: "not-proven" as const }; } };
  return { args, controller };
}
function connection(run: StandingHistoryAnalysisStepLease["turnAnalysis"], hooks: { released?:()=>void; closed?:()=>void; aborted?:()=>void } = {}): StandingHistoryAnalysisStepConnection {
  return { async acquireAnalysisAdmission() { return { nativeBinding, turnAnalysis: run,
    async releaseAnalysis() { hooks.released?.(); }, async abortAndJoin() { hooks.aborted?.(); }, async close() { hooks.closed?.(); } }; } };
}
const completed = () => ({ kind: "analysis" as const, scope: { epochId: nativeBinding.epochId, requestRef: nativeBinding.requestRef, purpose: "history-analysis" as const, threadId: "thread", turnId: "turn", turnNumber: 1, threadTurnNumber: 1 }, answer: "prepared", toolCalls: 2, toolRefusals: 0 });
async function invoke(bindings: Parameters<StandingHistoryAnalysisStepLease["turnAnalysis"]>[2], name: string, args: unknown, ref: string, acknowledge = true) {
  const output = await bindings.analysisTools.find(t => t.name === name)!.call(args, { requestRef: nativeBinding.requestRef, callRef: ref, signal: new AbortController().signal }) as EpochToolResult;
  if (acknowledge) bindings.onToolResultSent({ requestRef: nativeBinding.requestRef, callRef: ref, name, result: output });
  return output;
}
test("finalizer acknowledges objective material, persists separate report and cold reopens without model", async t => {
  const f = await fixture(t); let released = 0, closed = 0;
  const first = await finalizeStandingHistoryReport({ ...f.args, connection: connection(async (_ref, body, bindings) => {
    assert.equal(JSON.parse(body).kind, "final-report"); assert.equal(JSON.parse(body).objective, f.args.intent.objective);
    const repo = process.env.NEUROBRO_REPO_ROOT ?? (existsSync(resolve("project/verification/rm-0032-standing-epoch-client.py")) ? process.cwd() : resolve("../.."));
    const producer = resolve(repo, "project/verification/rm-0032-standing-epoch-client.py");
    const proof = execFileSync(process.env.PYTHON ?? "python", ["-c", [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('final_report_native',sys.argv[1])",
      "c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)",
      "v=json.load(sys.stdin)",
      "assert c.validate_analysis_input(v['packet']), 'actual executor packet rejected by native'",
      "assert list(c.ANALYSIS_TOOL_SPECS)==v['specs'], 'native and TypeScript registry differ'",
      "assert len(c.ANALYSIS_INSTRUCTIONS.encode('utf-8'))<=4096",
      "print('native-final-report-contract-ok')",
    ].join("\n"), producer], { input: JSON.stringify({ packet: body, specs: ANALYSIS_TOOL_SPECS }), encoding: "utf8" });
    assert.equal(proof.trim(), "native-final-report-contract-ok");
    const material = await invoke(bindings, "neurobro_analysis_material", {}, "material");
    assert.equal(material.success, true); assert.match(material.contentItems[0].text, /Private root summary/);
    assert.equal((await invoke(bindings, "neurobro_analysis_commit", { finalReport: { body: "Useful final report about complaints." } }, "commit")).success, true);
    return completed();
  }, { released:()=>released++, closed:()=>closed++ }) });
  assert.equal(first.kind, "ready"); if (first.kind !== "ready") throw Error(); assert.equal(first.report.body, "Useful final report about complaints.");
  assert.equal(released, 1); assert.equal(closed, 1);
  const reopened = await finalizeStandingHistoryReport({ ...f.args, connection: { async acquireAnalysisAdmission() { throw Error("must not replay"); } } });
  assert.equal(reopened.kind, "ready"); if (reopened.kind === "ready") assert.equal(reopened.recovered, true);
});
test("commit before wire material acknowledgement is refused and can be corrected", async t => {
  const f = await fixture(t);
  const done = await finalizeStandingHistoryReport({ ...f.args, connection: connection(async (_ref, _body, bindings) => {
    await invoke(bindings, "neurobro_analysis_material", {}, "unacked", false);
    assert.equal((await invoke(bindings, "neurobro_analysis_commit", { finalReport: { body: "Premature" } }, "bad")).success, false);
    await invoke(bindings, "neurobro_analysis_material", {}, "acked");
    assert.equal((await invoke(bindings, "neurobro_analysis_commit", { finalReport: { body: "Final" } }, "good")).success, true);
    return completed();
  }) }); assert.equal(done.kind, "ready");
});
test("unprepared model result consumes reservation permanently", async t => {
  const f = await fixture(t); let turns = 0;
  const conn = connection(async () => { turns++; return completed(); });
  assert.deepEqual(await finalizeStandingHistoryReport({ ...f.args, connection: conn }), { kind: "blocked", reason: "unprepared" });
  assert.deepEqual(await finalizeStandingHistoryReport({ ...f.args, connection: conn }), { kind: "blocked", reason: "consumed" }); assert.equal(turns, 1);
});
test("unknown prepared output requires exact persisted owner settlement", async t => {
  const f = await fixture(t); let settled = 0;
  const done = await finalizeStandingHistoryReport({ ...f.args, async verifyOwnerSettled(b) { settled++; return f.args.verifyOwnerSettled(b); }, connection: connection(async (_r,_b,bindings) => {
    await invoke(bindings,"neurobro_analysis_material",{},"read"); await invoke(bindings,"neurobro_analysis_commit",{finalReport:{body:"Recovered after transport loss"}},"save"); throw Error("transport");
  }) }); assert.equal(done.kind,"ready"); assert.equal(settled,1);
});
test("cleanup failure is owner-visible and never a task-local success", async t => {
  const f=await fixture(t);
  await assert.rejects(finalizeStandingHistoryReport({...f.args,connection:connection(async()=>completed(),{closed:()=>{throw Error("unsettled")}})}),/FINALIZER_CLOSE/);
});
test("cancelled task never acquires model", async t => {
  const f=await fixture(t), c=await openStandingHistoryTaskControlStore({intent:f.args.intent,passphrase:f.args.passphrase,directory:f.args.directories.control,mode:"open"});
  await c.cancel({expectedRevision:0}); await c.close();
  assert.deepEqual(await finalizeStandingHistoryReport({...f.args,connection:{async acquireAnalysisAdmission(){throw Error("no")}}}),{kind:"blocked",reason:"cancelled"});
});

test("abort joins a pending native turn promptly and preserves consumed reservation", async t => {
  const f = await fixture(t); let started!:()=>void, stop!:()=>void, aborted = 0;
  const entered = new Promise<void>(r=>started=r), wait = new Promise<void>(r=>stop=r);
  const pending = finalizeStandingHistoryReport({...f.args,connection:connection(async()=>{started(); await wait; throw Error("aborted");},{aborted:()=>{aborted++;stop();}})});
  await entered; f.controller.abort();
  assert.deepEqual(await pending,{kind:"blocked",reason:"cancelled"}); assert.equal(aborted,1);
});
test("late cancellation after closed lease never starts another owner abort", async t => {
  const f = await fixture(t); let aborted = 0, closed = 0;
  const done = await finalizeStandingHistoryReport({...f.args, connection:connection(async (_r,_b,bindings)=>{
    await invoke(bindings,"neurobro_analysis_material",{},"material");
    await invoke(bindings,"neurobro_analysis_commit",{finalReport:{body:"Final report"}},"commit");
    return completed();
  },{closed:()=>{closed++;setImmediate(()=>f.controller.abort());},aborted:()=>{aborted++;}})});
  assert.deepEqual(done,{kind:"blocked",reason:"cancelled"});assert.equal(closed,1);assert.equal(aborted,0);
});

function stagedConnection(run: (packet: Record<string,unknown>, tool: (name: string, args: unknown, acknowledge?: boolean) => Promise<EpochToolResult>) => Promise<void>): StandingHistoryAnalysisStepConnection {
 let stage = 0;
 return { async acquireAnalysisAdmission(requestRef, previous, options) {
  if(previous)assert.deepEqual(options,{requireNewEpoch:true});
  const binding = { ...nativeBinding, epochId: (++stage).toString(16).padStart(32,"0"), requestRef };
  return { nativeBinding: binding, async turnAnalysis(_ref, body, bindings) {
   let call = 0;
   const tool = async (name: string, args: unknown, acknowledge = true) => {
    const callRef = "stage-call-" + ++call;
    const result = await bindings.analysisTools.find(t=>t.name===name)!.call(args,{requestRef,callRef,signal:new AbortController().signal}) as EpochToolResult;
    if (acknowledge) bindings.onToolResultSent({requestRef,callRef,name,result}); return result;
   };
   await run(JSON.parse(body),tool);
   return { ...completed(), scope: { ...completed().scope, ...binding } };
  }, async releaseAnalysis(){}, async abortAndJoin(){}, async close(){} };
 } };
}
type ReportTool = Parameters<Parameters<typeof stagedConnection>[0]>[1];
async function reportMaterial(tool:ReportTool) {
 const result=await tool("neurobro_analysis_material",{});assert.equal(result.success,true);
 const material=JSON.parse(result.contentItems[0].text);
 if(material.candidate)for(let pageIndex=1;pageIndex<=material.candidate.pages;pageIndex++)assert.equal((await tool("neurobro_analysis_material",{purpose:"final-report-candidate",pageIndex,position:null})).success,true);
 return material;
}
const eligibility=(f:Awaited<ReturnType<typeof fixture>>)=>({intent:f.args.intent,sourceHead:f.args.readiness.sourceHead,analysisHead:f.args.readiness.expectedHead,directory:f.args.directories.reports,passphrase:f.args.passphrase});
const accepted=(body:string)=>({reportReview:{candidateHash:standingHistoryReportBodyHash(body),verdict:"accepted",findings:[]}});
test("production finalizer reviews exact persisted candidate before ready, cold restart dispatches no model",async t=>{
 const f=await fixture(t);let calls=0;const phases:string[]=[];const body="A useful supported report.";
 assert.equal(await canContinueStandingHistoryReport(eligibility(f)),false);
 const result=await finalizeReviewedReport({...f.args,onStage:p=>phases.push(p),connection:stagedConnection(async(packet,tool)=>{
  calls++;await reportMaterial(tool);
  assert.equal((await tool("neurobro_analysis_commit",packet.kind==="final-report-review"?accepted(body):{finalReport:{body}})).success,true);
 })});
 assert.equal(result.kind,"ready");assert.equal(calls,2);assert.deepEqual(phases,["finalizing","reviewing"]);
 assert.equal(await canContinueStandingHistoryReport(eligibility(f)),true);
 const reopened=await finalizeReviewedReport({...f.args,connection:{async acquireAnalysisAdmission(){throw Error("replay")}}});assert.equal(reopened.kind,"ready");
 assert.equal(await canContinueStandingHistoryReport({...eligibility(f),analysisHead:"f".repeat(64)}),false);
});
test("concrete quality feedback permits exactly one persisted revision and review",async t=>{
 const f=await fixture(t);let calls=0;const original="Original report", revised="Corrected report";
 const snapshot = async () => { const rows: string[] = []; for (const root of [f.args.directories.pages, f.args.directories.analysis]) { const slot=join(root,f.args.intent.taskId); for(const name of (await readdir(slot)).sort())rows.push(name+":"+(await readFile(join(slot,name))).toString("hex")); } return rows; };
 const before=await snapshot();
 const findings=[{dimension:"evidence",problem:"The participant count is unsupported.",correction:"Remove the invented count and state the counting gap."}];
 const result=await finalizeReviewedReport({...f.args,connection:stagedConnection(async(packet,tool)=>{
  calls++;const material=await reportMaterial(tool);
  if(calls===3){assert.deepEqual(material.feedback.findings,findings);assert.equal(material.reportStage,"revision");}
  const value=packet.kind==="final-report-review"?(calls===2?{reportReview:{candidateHash:standingHistoryReportBodyHash(original),verdict:"revise",findings}}:accepted(revised)):{finalReport:{body:calls===1?original:revised}};
  assert.equal((await tool("neurobro_analysis_commit",value)).success,true);
 })});assert.equal(calls,4);assert.deepEqual(await snapshot(),before);assert.equal(result.kind,"ready");if(result.kind==="ready")assert.equal(result.report.body,revised);
 const reopened=await finalizeReviewedReport({...f.args,connection:{async acquireAnalysisAdmission(){throw Error("must reuse accepted revision")}}});assert.equal(reopened.kind,"ready");
});
test("quality rejection after correction is terminal across restart",async t=>{
 const f=await fixture(t);let calls=0;
 const result=await finalizeReviewedReport({...f.args,connection:stagedConnection(async(packet,tool)=>{
  calls++;const m=await reportMaterial(tool);const value=packet.kind==="final-report-review"?{reportReview:{candidateHash:m.candidate.candidateHash,verdict:"revise",findings:[{dimension:"objective",problem:"Missing requested conclusion",correction:"State the conclusion or its evidence gap"}]}}:{finalReport:{body:"Candidate " + calls}};
  assert.equal((await tool("neurobro_analysis_commit",value)).success,true);
 })});assert.deepEqual(result,{kind:"blocked",reason:"quality-rejected"});assert.equal(calls,4);assert.equal(await canContinueStandingHistoryReport(eligibility(f)),false);
 assert.deepEqual(await finalizeReviewedReport({...f.args,connection:{async acquireAnalysisAdmission(){throw Error("budget reset")}}}),result);
});
test("legacy prepared draft is reviewed without regeneration; candidate must be acknowledged in full",async t=>{
 const f=await fixture(t),body="\\".repeat(32768);
 await finalizeStandingHistoryReport({...f.args,connection:connection(async(_r,_b,bindings)=>{
  await invoke(bindings,"neurobro_analysis_material",{},"material");await invoke(bindings,"neurobro_analysis_commit",{finalReport:{body}},"commit");return completed();
 })});assert.equal(await canContinueStandingHistoryReport(eligibility(f)),true);let calls=0;
 const result=await finalizeReviewedReport({...f.args,connection:stagedConnection(async(packet,tool)=>{
  calls++;assert.equal(packet.kind,"final-report-review");
  const material=JSON.parse((await tool("neurobro_analysis_material",{})).contentItems[0].text);assert.equal(material.candidate.pages,2);
  assert.equal((await tool("neurobro_analysis_commit",accepted(body))).success,false);
  for(let pageIndex=1;pageIndex<=material.candidate.pages;pageIndex++)await tool("neurobro_analysis_material",{purpose:"final-report-candidate",pageIndex,position:null});
  assert.equal((await tool("neurobro_analysis_commit",accepted("different"))).success,false);
  assert.equal((await tool("neurobro_analysis_commit",accepted(body))).success,true);
 })});assert.equal(result.kind,"ready");assert.equal(calls,1);
});
test("known settled no-output draft gets one report-only successor; UNKNOWN never does",async t=>{
 const f=await fixture(t);let calls=0,settled=0,rotated=false;
 const base=stagedConnection(async(packet,tool)=>{
  calls++;if(calls===1)return;const material=await reportMaterial(tool);if(calls===2)assert.equal(typeof material.feedback,"string");
  assert.equal((await tool("neurobro_analysis_commit",packet.kind==="final-report-review"?accepted("New report"):{finalReport:{body:"New report"}})).success,true);
 });
 const done=await finalizeReviewedReport({...f.args,async verifyOwnerSettled(b){assert.equal(rotated,true);settled++;return f.args.verifyOwnerSettled(b)},connection:{async acquireAnalysisAdmission(ref,previous,options){
  if(previous){assert.deepEqual(options,{requireNewEpoch:true});rotated=true;}
  return base.acquireAnalysisAdmission(ref,previous,options);
 }}});assert.equal(done.kind,"ready");assert.equal(calls,3);assert.ok(settled>=1);
 const g=await fixture(t);let unknownCalls=0;const args={...g.args,connection:stagedConnection(async()=>{unknownCalls++;throw Error("transport")})};
 assert.deepEqual(await finalizeReviewedReport(args),{kind:"blocked",reason:"unprepared"});
 assert.deepEqual(await finalizeReviewedReport(args),{kind:"blocked",reason:"consumed"});assert.equal(unknownCalls,1);assert.equal(await canContinueStandingHistoryReport(eligibility(g)),false);
});
test("UNKNOWN review without output stays consumed and cannot send or regenerate draft",async t=>{
 const f=await fixture(t);let calls=0;
 const args={...f.args,connection:stagedConnection(async(packet,tool)=>{calls++;if(packet.kind==="final-report-review")throw Error("transport");await reportMaterial(tool);await tool("neurobro_analysis_commit",{finalReport:{body:"Draft"}})})};
 assert.deepEqual(await finalizeReviewedReport(args),{kind:"blocked",reason:"review-unprepared"});
 assert.equal(await canContinueStandingHistoryReport(eligibility(f)),false);
 assert.deepEqual(await finalizeReviewedReport(args),{kind:"blocked",reason:"review-unprepared"});assert.equal(calls,2);
});


test("200-child persisted root resumes intent-only report preparation and cold prepared recovery without analysis replay", async t => {
  const f = await fixture(t, 200); let acquisitions = 0;
  const beforeAdmission = new Error("synthetic pre-admission stop");
  await assert.rejects(finalizeStandingHistoryReport({ ...f.args, connection: { async acquireAnalysisAdmission() { acquisitions++; throw beforeAdmission; } } }), error => error === beforeAdmission);
  assert.equal(acquisitions, 1);
  const slot = join(f.args.directories.reports, f.args.intent.taskId), header = await readFile(join(slot, "intent.enc"));
  assert.deepEqual(await readdir(slot), ["intent.enc"]);
  const first = await finalizeStandingHistoryReport({ ...f.args, connection: connection(async (_ref, _body, bindings) => {
    acquisitions++;
    const material = await invoke(bindings, "neurobro_analysis_material", {}, "material"); assert.equal(material.success, true);
    const packet = JSON.parse(material.contentItems[0].text); assert.equal(packet.root.children.length, 200);
    const child = await invoke(bindings, "neurobro_analysis_notes", { nodeRef: packet.root.children[199], position: null }, "child");
    assert.equal(child.success, true); assert.match(child.contentItems[0].text, /Saved child 199/);
    assert.equal((await invoke(bindings, "neurobro_analysis_commit", { finalReport: { body: "Reader-facing report from the persisted wide root." } }, "commit")).success, true);
    return completed();
  }) });
  assert.equal(first.kind, "ready"); assert.equal(acquisitions, 2); assert.deepEqual(await readFile(join(slot, "intent.enc")), header);
  const recovered = await finalizeStandingHistoryReport({ ...f.args, connection: { async acquireAnalysisAdmission() { assert.fail("prepared report must not dispatch again"); } } });
  assert.equal(recovered.kind, "ready"); if (recovered.kind === "ready") assert.equal(recovered.recovered, true);
});
