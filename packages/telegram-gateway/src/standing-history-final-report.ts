import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { openStandingHistoryTaskStore, snapshotStandingHistoryTaskIntent } from "./standing-history-task-store.js";
import type { StandingHistoryTaskIntent, StandingHistoryTaskStore } from "./standing-history-task-store.js";
import { openStandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { openStandingHistoryAnalysisStore, type StandingHistoryAnalysisStore } from "./standing-history-analysis-store.js";
import { openStandingHistoryFinalReportStore, readStandingHistoryFinalReportRoot, type StandingHistoryFinalReportStore, type StandingHistoryFinalReportStatus } from "./standing-history-final-report-store.js";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";
import { prepareStandingHistoryTaskDeliveryText, StandingHistoryTaskDeliveryError, type StandingHistoryFinalReport, type StandingHistoryTaskReadiness } from "./standing-history-task-delivery.js";
import type { StandingHistoryAnalysisOwnerSettlement, StandingHistoryAnalysisStepConnection, StandingHistoryAnalysisStepLease } from "./standing-history-analysis-step.js";
import type { StandingHistoryAnalysisNativeBinding } from "./standing-history-analysis-attempt-store.js";
import { ANALYSIS_TOOL_TEXT_BYTES, type EpochExtraTool, type EpochToolResult, type EpochToolScope } from "./standing-tool-dispatcher.js";
import { EpochTurnNotAdmitted } from "./standing-epoch-session.js";
import { createStandingHistoryFinalReportMaterial, StandingHistoryFinalReportMaterialError } from "./standing-history-final-report-material.js";

import { REPORT_REVIEW_SERIALIZED_BYTES, snapshotStandingHistoryReportReview, standingHistoryReportBodyHash, type StandingHistoryReportReview } from "./standing-history-report-quality.js";

export type StandingHistoryFinalReportResult = Readonly<{ kind: "ready"; report: StandingHistoryFinalReport; recovered: boolean }> |
  Readonly<{ kind: "blocked"; reason: "consumed" | "cancelled" | "stale" | "unprepared" | "quality-rejected" | "review-unprepared" | "attempt-limit" | "material-unavailable" }>;
export class StandingHistoryFinalReportError extends Error {
  constructor(readonly code: "input" | "owner" | "close" | "storage") { super("STANDING_HISTORY_FINALIZER_" + code.toUpperCase()); }
}

type StageInput = Parameters<typeof prepareStandingHistoryReportStage>[0];
export type StandingHistoryFinalReportInput = Omit<StageInput, "reportStage" | "previousOwner"> & Readonly<{
  onStage?(phase: "finalizing" | "reviewing"): void;
}>;
type ReportIdentity = Pick<StageInput, "intent" | "passphrase"> & Readonly<{ sourceHead: string; analysisHead: string; rootRef: string; directory: string }>;
type ReportStage = NonNullable<StageInput["reportStage"]>;
const stageDirectory = (directory: string, stage: "review-0" | "draft-1" | "review-1") => join(directory, "final-report-" + stage);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const noOutputFeedback = "The previous report attempt completed or was refused without saving a report. Produce a new standalone report from the saved analysis; do not repeat source analysis.";

async function reportStatus(identity: ReportIdentity, reportStage?: ReportStage): Promise<StandingHistoryFinalReportStatus | undefined> {
  try { await lstat(join(identity.directory, identity.intent.taskId)); } catch (e) { if (missing(e)) return undefined; throw e; }
  const store = await openStandingHistoryFinalReportStore({ directory: identity.directory, passphrase: identity.passphrase,
    intent: identity.intent, sourceHead: identity.sourceHead, analysisHead: identity.analysisHead, rootRef: identity.rootRef,
    mode: "open", ...(reportStage ? { contextHash: hash(reportStage) } : {}), ...(reportStage?.kind === "review" ? { bodyKind: "review" as const } : {}) });
  try { return await store.status(); } finally { await store.close(); }
}
const knownNoOutput = (status: StandingHistoryFinalReportStatus | undefined): boolean => status?.storage === "ready" && !!status.nativeBinding &&
  !status.prepared && (status.modelOutcome === "refused" || status.modelOutcome === "observed");
const reviewContext = (candidate: string): ReportStage => ({ kind: "review", candidate });

/** Four immutable stages: draft, review, at most one correction, final review.
 * A saved model result is never dispatched again. Cold stages require exact
 * owner settlement; UNKNOWN without output has no automatic successor. */
export async function finalizeStandingHistoryReport(input: StandingHistoryFinalReportInput): Promise<StandingHistoryFinalReportResult> {
  const identity: ReportIdentity = { intent: snapshotStandingHistoryTaskIntent(input.intent), passphrase: input.passphrase,
    sourceHead: input.readiness.sourceHead, analysisHead: input.readiness.expectedHead, rootRef: input.readiness.rootRef!, directory: input.directories.reports };
  const observe = (phase: "finalizing" | "reviewing") => { try { input.onStage?.(phase); } catch { /* Observation cannot grant or revoke authority. */ } };
  const run = async (label: "draft-0" | "review-0" | "draft-1" | "review-1", reportStage?: ReportStage, previousOwner?: StandingHistoryAnalysisNativeBinding) => {
    observe(reportStage?.kind === "review" ? "reviewing" : "finalizing");
    const directory = label === "draft-0" ? identity.directory : stageDirectory(identity.directory, label);
    if (label !== "draft-0") {
      await assertPilotPrivateDirectory(identity.directory);
      try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      await assertPilotPrivateDirectory(directory);
    }
    return prepareStandingHistoryReportStage({ ...input, requestRef: "history-report-" + hash(input.requestRef).slice(0, 40) + "-" + label,
      directories: { ...input.directories, reports: directory }, ...(reportStage ? { reportStage } : {}), ...(previousOwner ? { previousOwner } : {}) });
  };
  let feedback: StandingHistoryReportReview | string, candidate: string | undefined, previousOwner: StandingHistoryAnalysisNativeBinding | undefined;
  const draft = await run("draft-0");
  if (draft.kind !== "ready") {
    if (!["consumed", "unprepared"].includes(draft.reason)) return draft;
    const prior = await reportStatus(identity); if (!knownNoOutput(prior)) return draft;
    previousOwner = prior!.nativeBinding;
    feedback = noOutputFeedback;
  } else {
    candidate = draft.report.body;
    const draftOwner = (await reportStatus(identity))?.nativeBinding; if (!draftOwner) return fail("owner");
    const reviewed = await run("review-0", reviewContext(candidate), draftOwner);
    if (reviewed.kind !== "ready") return { kind: "blocked", reason: ["cancelled", "stale", "material-unavailable"].includes(reviewed.reason) ? reviewed.reason : "review-unprepared" } as StandingHistoryFinalReportResult;
    feedback = snapshotStandingHistoryReportReview(JSON.parse(reviewed.report.body), standingHistoryReportBodyHash(candidate));
    if (feedback.verdict === "accepted") return { ...draft, recovered: draft.recovered || reviewed.recovered };
    previousOwner = (await reportStatus({ ...identity, directory: stageDirectory(identity.directory, "review-0") }, reviewContext(candidate)))?.nativeBinding;
    if (!previousOwner) return fail("owner");
  }
  const revisionContext: ReportStage = { kind: "revision", feedback, ...(candidate ? { candidate } : {}) };
  const revision = await run("draft-1", revisionContext, previousOwner);
  if (revision.kind !== "ready") return revision;
  const revisionOwner = (await reportStatus({ ...identity, directory: stageDirectory(identity.directory, "draft-1") }, revisionContext))?.nativeBinding; if (!revisionOwner) return fail("owner");
  const reviewed = await run("review-1", reviewContext(revision.report.body), revisionOwner);
  if (reviewed.kind !== "ready") return { kind: "blocked", reason: ["cancelled", "stale", "material-unavailable"].includes(reviewed.reason) ? reviewed.reason : "review-unprepared" } as StandingHistoryFinalReportResult;
  const finalReview = snapshotStandingHistoryReportReview(JSON.parse(reviewed.report.body), standingHistoryReportBodyHash(revision.report.body));
  if (finalReview.verdict !== "accepted") return { kind: "blocked", reason: "quality-rejected" };
  return { ...revision, recovered: revision.recovered || reviewed.recovered };
}

/** Read-only scheduling hint, never model admission. Only authenticated stages
 * with remaining bounded work can cross a legacy report-required disposition.
 * The executor still checks current control/heads and prior owner settlement. */
export async function canContinueStandingHistoryReport(input: Readonly<{
  intent: StandingHistoryTaskIntent; sourceHead: string; analysisHead: string; directory: string; passphrase: string; signal?: AbortSignal;
}>): Promise<boolean> {
  try {
    if (input.signal?.aborted) return false;
    const rootRef = await readStandingHistoryFinalReportRoot(input); if (!rootRef) return false;
    const identity: ReportIdentity = { ...input, rootRef }, draft = await reportStatus(identity);
    if (draft?.storage !== "ready" || !draft.reserved) return false;
    let feedback: StandingHistoryReportReview | string, candidate: string | undefined;
    if (!draft.prepared) { if (!knownNoOutput(draft)) return false; feedback = noOutputFeedback; }
    else {
      candidate = draft.prepared.body;
      const review = await reportStatus({ ...identity, directory: stageDirectory(input.directory, "review-0") }, reviewContext(candidate));
      if (!review || review.storage === "ready" && !review.reserved) return !input.signal?.aborted;
      if (review.storage !== "ready" || !review.prepared) return false;
      feedback = snapshotStandingHistoryReportReview(JSON.parse(review.prepared.body), standingHistoryReportBodyHash(candidate));
      if (feedback.verdict === "accepted") return !input.signal?.aborted;
    }
    const context: ReportStage = { kind: "revision", feedback, ...(candidate ? { candidate } : {}) };
    const revision = await reportStatus({ ...identity, directory: stageDirectory(input.directory, "draft-1") }, context);
    if (!revision || revision.storage === "ready" && !revision.reserved) return !input.signal?.aborted;
    if (revision.storage !== "ready" || !revision.prepared) return false;
    const review = await reportStatus({ ...identity, directory: stageDirectory(input.directory, "review-1") }, reviewContext(revision.prepared.body));
    if (!review || review.storage === "ready" && !review.reserved) return !input.signal?.aborted;
    return review.storage === "ready" && !!review.prepared && snapshotStandingHistoryReportReview(JSON.parse(review.prepared.body), standingHistoryReportBodyHash(revision.prepared.body)).verdict === "accepted" && !input.signal?.aborted;
  } catch { return false; }
}
const fail = (code: StandingHistoryFinalReportError["code"]): never => { throw new StandingHistoryFinalReportError(code); };
class Blocked extends Error { constructor(readonly reason: "consumed" | "cancelled" | "stale" | "unprepared") { super(reason); } }
function fields(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail("input");
  const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail("input");
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail("input"); return [k, d.value]; }));
}
const result = (success: boolean, value: unknown): EpochToolResult => {
  const text = JSON.stringify(value); if (Buffer.byteLength(text) > ANALYSIS_TOOL_TEXT_BYTES) return fail("input");
  return Object.freeze({ success, contentItems: Object.freeze([Object.freeze({ type: "inputText", text })]) as EpochToolResult["contentItems"] });
};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Final presentation is a separate durable generation. It can read only this
 * task's authenticated notes/source and prepare text, never Telegram delivery.
 * A reservation is never replayed; cold prepared text requires owner settlement.
 * This verifies identity/lifecycle, not the truth of model-authored prose. */
export async function prepareStandingHistoryReportStage(input: Readonly<{
  intent: StandingHistoryTaskIntent; readiness: StandingHistoryTaskReadiness;
  directories: Readonly<{ pages: string; control: string; analysis: string; reports: string }>;
  passphrase: string; connection: StandingHistoryAnalysisStepConnection; requestRef: string; signal: AbortSignal;
  previousOwner?: StandingHistoryAnalysisNativeBinding;
  reportStage?: Readonly<{ kind: "review"; candidate: string }> | Readonly<{ kind: "revision"; candidate?: string; feedback: StandingHistoryReportReview | string }>;
  verifyOwnerSettled(binding: StandingHistoryAnalysisNativeBinding): Promise<StandingHistoryAnalysisOwnerSettlement>;
}>): Promise<StandingHistoryFinalReportResult> {
  const intent = snapshotStandingHistoryTaskIntent(input.intent), readiness = JSON.parse(JSON.stringify(input.readiness)) as StandingHistoryTaskReadiness;
  if (!(input.signal instanceof AbortSignal) || types.isProxy(input.signal) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestRef) || !readiness.rootRef) return fail("input");
  let source: StandingHistoryTaskStore | undefined, analysis: StandingHistoryAnalysisStore | undefined, reports: StandingHistoryFinalReportStore | undefined;
  let lease: StandingHistoryAnalysisStepLease | undefined, toolsLive = false, active: Promise<EpochToolResult> | undefined;
  let cleanupDone = false, materialShown = false, calls = 0, reads = 0, fatal: unknown;
  let aborting: Promise<void> | undefined;
  const abortOwner = () => { toolsLive = false; if (lease && !cleanupDone && !aborting) { aborting = Promise.resolve().then(() => lease!.abortAndJoin()); void aborting.catch(() => {}); } return aborting; };
  const onAbort = () => { void abortOwner(); };
  const candidate = input.reportStage?.candidate;
  const candidatePages: string[] = []; let chunk = "", bytes = 0;
  for (const character of candidate ?? "") { const size = Buffer.byteLength(JSON.stringify(character)) - 2; if (bytes + size > 45000) { candidatePages.push(chunk); chunk = ""; bytes = 0; } chunk += character; bytes += size; }
  if (chunk) candidatePages.push(chunk);
  const candidateShown = new Set<number>();
  const used = new Set<string>(), pending = new Map<string, { name: string; digest: string; material: boolean; candidatePage?: number }>();
  const guard = () => { if (input.signal.aborted) throw new Blocked("cancelled"); };
  async function heads(): Promise<void> {
    guard();
    const control = await openStandingHistoryTaskControlStore({ directory: input.directories.control, passphrase: input.passphrase, intent, mode: "open" });
    try { const c = await control.status(); if (c.storage !== "ready") throw new Blocked("stale"); if (c.state !== "queued") throw new Blocked("cancelled"); if (c.revision !== 0) throw new Blocked("stale"); }
    finally { await control.close(); }
    const s = await source!.status(), a = await analysis!.status(); guard();
    if (s.storage !== "ready" || a.storage !== "ready" || s.readProgress.chainHash !== readiness.sourceHead || a.headHash !== readiness.expectedHead) throw new Blocked("stale");
    const root = await analysis!.readNode(readiness.rootRef!);
    if (!root || root.hash !== readiness.expectedHead || root.nodeRef !== readiness.rootRef) throw new Blocked("stale");
  }
  async function settled(binding: StandingHistoryAnalysisNativeBinding): Promise<void> {
    const proof = await input.verifyOwnerSettled(binding);
    if (proof.schema !== "standing-analysis-owner-settlement-v1" || proof.persisted !== true || proof.resourcesSettled !== true || proof.replacementReady !== true ||
      proof.modelOutcome !== "not-proven" || proof.nativeBinding.epochId !== binding.epochId || proof.nativeBinding.requestRef !== binding.requestRef || proof.nativeBinding.purpose !== binding.purpose) return fail("owner");
  }
  async function cleanup(abort: boolean): Promise<void> {
    if (!lease || cleanupDone) return;
    toolsLive = false;
    let failed = false;
    try { if (abort || aborting) await abortOwner(); } catch { failed = true; }
    try { await active; } catch { /* Persistence outcome is reconciled by its ledger. */ }
    try { await lease.close(); } catch { failed = true; }
    cleanupDone = true;
    if (failed) return fail("close");
  }
  try {
    source = await openStandingHistoryTaskStore({ directory: input.directories.pages, passphrase: input.passphrase, intent, mode: "open" });
    analysis = await openStandingHistoryAnalysisStore({ directory: input.directories.analysis, passphrase: input.passphrase, intent, mode: "open", readSourcePage: i => source!.readPage(i) });
    await heads();
    let exists = false;
    try { await lstat(join(input.directories.reports, intent.taskId)); exists = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    reports = await openStandingHistoryFinalReportStore({ directory: input.directories.reports, passphrase: input.passphrase, intent, sourceHead: readiness.sourceHead,
      analysisHead: readiness.expectedHead, rootRef: readiness.rootRef, mode: exists ? "open" : "create", ...(input.reportStage ? {contextHash: hash(input.reportStage)} : {}),
      ...(input.reportStage?.kind === "review" ? { bodyKind: "review" as const } : {}) });
    const prior = await reports.status();
    if (prior.storage !== "ready") throw new Blocked("consumed");
    if (prior.reserved) {
      if (!prior.prepared || !prior.nativeBinding) throw new Blocked("consumed");
      await settled(prior.nativeBinding); await heads();
      return { kind: "ready", recovered: true, report: { schema: "standing-history-final-report-v1", taskRef: intent.taskId, sourceHead: readiness.sourceHead, analysisHead: readiness.expectedHead, body: prior.prepared.body } };
    }
    let material: Awaited<ReturnType<typeof createStandingHistoryFinalReportMaterial>>;
    try { material = await createStandingHistoryFinalReportMaterial({ intent, readiness, source, analysis }); }
    catch (error) {
      // Deterministic evidence projection refusal occurs before any lease or
      // request reservation. Keep it local to this task; storage, owner and
      // the finally's close failures must still propagate to the host.
      if (error instanceof StandingHistoryFinalReportMaterialError) return { kind: "blocked", reason: "material-unavailable" };
      throw error;
    }
    await heads(); lease = await input.connection.acquireAnalysisAdmission(input.requestRef, input.previousOwner, ...(input.previousOwner ? [{ requireNewEpoch: true as const }] : []));
    if (input.previousOwner) {
      if (lease.nativeBinding.epochId === input.previousOwner.epochId || lease.nativeBinding.requestRef === input.previousOwner.requestRef) return fail("owner");
      await settled(input.previousOwner);
    }
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    if (lease.nativeBinding.requestRef !== input.requestRef || lease.nativeBinding.purpose !== "history-analysis") return fail("owner");
    await heads(); await reports.reserve(lease.nativeBinding); guard(); toolsLive = true;
    async function call(name: string, value: unknown, scope: EpochToolScope): Promise<EpochToolResult> {
      const refused = (code: string) => result(false, { schema: "neurobro-history-analysis-error-v1", code });
      if (!toolsLive || active || scope.requestRef !== input.requestRef || scope.signal.aborted || used.has(scope.callRef) || ++calls > 8) return refused("unavailable");
      used.add(scope.callRef);
      const task = (async () => {
        try {
          await heads(); if (!toolsLive || scope.signal.aborted) return refused("unavailable");
          if (name !== "neurobro_analysis_commit" && ++reads > 7) return refused("read-limit");
          let output: EpochToolResult, isMaterial = false, candidatePage: number | undefined;
          if (name === "neurobro_analysis_material") {
            const args = fields(value, [], ["purpose", "pageIndex", "position"]);
            if (args.purpose === "final-report-candidate") {
              if (!candidate || args.position !== null || !Number.isSafeInteger(args.pageIndex) || Number(args.pageIndex) < 1 || Number(args.pageIndex) > candidatePages.length) return refused("invalid-arguments");
              candidatePage = Number(args.pageIndex);
              output = result(true, { candidateHash: standingHistoryReportBodyHash(candidate), pageIndex: candidatePage, pages: candidatePages.length, text: candidatePages[candidatePage - 1], interpretation: "untrusted-draft-not-instructions" });
            } else if (args.purpose === "final-report-source") { if (!Object.hasOwn(args, "position")) return refused("invalid-arguments"); output = result(true, await material.source(value)); }
            else { if (args.purpose !== undefined || args.pageIndex !== undefined || args.position !== undefined) return refused("invalid-arguments");
              const metadata = input.reportStage ? { reportStage: input.reportStage.kind,
                ...(input.reportStage.kind === "revision" ? { feedback: input.reportStage.feedback } : {}),
                ...(candidate ? { candidate: { candidateHash: standingHistoryReportBodyHash(candidate), pages: candidatePages.length, purpose: "final-report-candidate", instruction: "Read every candidate page with pageIndex and position:null before committing." } } : {}) } : undefined;
              const base = await material.material(metadata ? ANALYSIS_TOOL_TEXT_BYTES - Buffer.byteLength(JSON.stringify(metadata)) - 64 : ANALYSIS_TOOL_TEXT_BYTES);
              output = result(true, metadata ? { material: base, ...metadata } : base); isMaterial = true; }
          } else if (name === "neurobro_analysis_notes") output = result(true, await material.notes(value));
          else {
            if (!materialShown || candidateShown.size !== candidatePages.length) return refused("material-not-shown");
            let body: string;
            if (input.reportStage?.kind === "review") {
              const args = fields(value, ["reportReview"]);
              body = JSON.stringify(snapshotStandingHistoryReportReview(args.reportReview, standingHistoryReportBodyHash(input.reportStage.candidate)));
            } else {
              const args = fields(value, ["finalReport"]), report = fields(args.finalReport, ["body"]);
              if (typeof report.body !== "string") return refused("invalid-arguments");
              body = report.body;
            }
            if (!body.trim() || Buffer.byteLength(body) > (input.reportStage?.kind === "review" ? REPORT_REVIEW_SERIALIZED_BYTES : 32768) || body.includes("\0") || Buffer.from(body).toString() !== body) return refused("invalid-arguments");
            await heads();
            if (input.reportStage?.kind !== "review") prepareStandingHistoryTaskDeliveryText({ intent, readiness, body });
            await reports!.prepare({ body });
            output = result(true, { schema: "neurobro-history-final-report-prepared-v1", prepared: true });
          }
          if (toolsLive && !scope.signal.aborted) pending.set(scope.callRef, { name, digest: hash(output), material: isMaterial, ...(candidatePage ? { candidatePage } : {}) });
          return output;
        } catch (e) {
          if (e instanceof Blocked) { fatal = e; return refused(e.reason); }
          if (e instanceof StandingHistoryTaskDeliveryError && ["input", "overflow"].includes(e.code) || e instanceof StandingHistoryFinalReportError && e.code === "input" || e instanceof Error && ["STANDING_HISTORY_FINAL_REPORT_MATERIAL_INPUT", "STANDING_HISTORY_REPORT_REVIEW_INPUT"].includes(e.message)) return refused("invalid-arguments");
          fatal = e; return refused("unavailable");
        }
      })();
      active = task; try { return await task; } finally { if (active === task) active = undefined; }
    }
    const analysisTools: readonly EpochExtraTool[] = ["neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit"].map(name => ({ name, call: (value, scope) => call(name, value, scope) }));
    const onToolResultSent = (ack: Readonly<{ requestRef: string; callRef: string; name: string; result: EpochToolResult }>) => {
      const p = pending.get(ack.callRef); if (!toolsLive || ack.requestRef !== input.requestRef || !p || p.name !== ack.name || p.digest !== hash(ack.result)) return;
      pending.delete(ack.callRef); if (p.material && ack.result.success) materialShown = true; if (p.candidatePage && ack.result.success) candidateShown.add(p.candidatePage);
    };
    let outcome: "observed" | "unknown" | "refused" = "unknown";
    try {
      const completed = await lease.turnAnalysis(input.requestRef, JSON.stringify({ schema: "neurobro-history-analysis-input-v1", kind: input.reportStage?.kind === "review" ? "final-report-review" : "final-report", objective: intent.objective, materialAvailable: true, ...(intent.source ? { sourceRef: "community", sourceInterpretation: "quoted-source-not-request" } : {}) }), {
        analysisTools, onToolResultSent,
        ...(input.connection.acquireParallelAnalysisAdmissions ? { work: { taskRef: intent.taskId, planRef: "final-" + readiness.expectedHead.slice(0,48), workRef: input.requestRef } } : {}) });
      if (completed.kind !== "analysis" || completed.scope.epochId !== lease.nativeBinding.epochId || completed.scope.requestRef !== input.requestRef || completed.scope.purpose !== "history-analysis") return fail("owner");
      outcome = "observed";
    } catch (e) { if (e instanceof StandingHistoryFinalReportError) throw e; outcome = e instanceof EpochTurnNotAdmitted ? "refused" : "unknown"; }
    toolsLive = false; await active; await reports.recordOutcome(outcome);
    if (outcome === "observed" && !input.signal.aborted && !fatal) {
      try { await lease.releaseAnalysis(input.requestRef); } catch { await cleanup(true); return fail("owner"); }
      await cleanup(false);
    } else await cleanup(true);
    if (fatal) throw fatal;
    await heads(); const saved = await reports.status();
    if (saved.storage !== "ready" || !saved.prepared) throw new Blocked("unprepared");
    if (outcome !== "observed") await settled(lease.nativeBinding);
    await heads();
    return { kind: "ready", recovered: false, report: { schema: "standing-history-final-report-v1", taskRef: intent.taskId, sourceHead: readiness.sourceHead, analysisHead: readiness.expectedHead, body: saved.prepared.body } };
  } catch (e) {
    if (lease && !cleanupDone) await cleanup(true);
    if (e instanceof Blocked) return { kind: "blocked", reason: e.reason };
    throw e;
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    toolsLive = false;
    const closed = await Promise.allSettled([reports?.close(), analysis?.close(), source?.close()]);
    if (closed.some(r => r.status === "rejected")) fail("close");
  }
}
