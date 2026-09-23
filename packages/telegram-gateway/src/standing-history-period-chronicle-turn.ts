import { types } from "node:util";
import { MAX_SUPPORTS } from "./standing-history-analysis-limits.js";
import type { StandingHistoryAnalysisOutput, StandingHistoryAnalysisSupport } from "./standing-history-analysis-store.js";
import type { EpochToolResult } from "./standing-tool-dispatcher.js";
import { type StandingHistoryPeriodChronicleRequest, type StandingHistoryPeriodChronicleAdvisory, standingHistoryPeriodChronicleBinding,
  portableStandingHistoryPeriodChronicleOutput, reboundStandingHistoryPeriodChronicleOutput,
  periodChronicleFields as fields, periodChronicleSnapshot as snapshot, periodChronicleHash as hash, periodChronicleFail as fail } from "./standing-history-period-chronicle.js";

export type StandingHistoryPeriodChronicleMaterialPurpose = "neutral-period-notes" | "period-advisory";
export type StandingHistoryPeriodChroniclePrepared = Readonly<{ request: StandingHistoryPeriodChronicleRequest; output: StandingHistoryAnalysisOutput }>;
export type StandingHistoryPeriodChronicleTurn = Readonly<{
  /** Persist this distinct context hash in the work reservation. Raw material
   * keeps its existing independently reproducible modelInputHash. */
  contextHash: string;
  advertised: Readonly<{ contextHash: string; neutralPeriodNotesAvailable: boolean; periodAdvisoryAvailable: boolean }>;
  assertMaterialBinding(input: Readonly<{ requestRef: string; supports: readonly StandingHistoryAnalysisSupport[] }>): void;
  readMaterial(input: Readonly<{ purpose: StandingHistoryPeriodChronicleMaterialPurpose; callRef: string }>): EpochToolResult | undefined;
  onToolResultSent(input: Readonly<{ requestRef: string; callRef: string; name: string; result: EpochToolResult }>): void;
  /** Optional validation never turns a valid primary commit into a refusal. */
  stageNeutralOutput(value: unknown): boolean;
  /** Invoke only after the primary output's durable prepare succeeds. */
  primaryPrepared(): void;
  /** Read before cleanup; publish only after actual observed outcome/release.
   * A crash before derived-cache capture loses this note, never replays work. */
  prepared(): StandingHistoryPeriodChroniclePrepared | undefined;
  close(): void;
}>;

const callRefValid = (v: unknown): v is string => typeof v === "string" && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(v);
const result = (value: unknown): EpochToolResult => {
  const text = JSON.stringify(value); if (Buffer.byteLength(text) > 49152) return fail();
  const output: EpochToolResult = Object.freeze({ success: true, contentItems: Object.freeze([Object.freeze({ type: "inputText", text })]) as EpochToolResult["contentItems"] });
  if (Buffer.byteLength(JSON.stringify(output)) > 131584) return fail(); return output;
};

/** Optional ancillary data inside one existing leaf turn. The parent runtime
 * still owns the eight-call/seven-read budget, current source/control heads,
 * primary source acknowledgment and durable main output. These material reads
 * must never mark primary material shown or expand primary shown supports.
 * Only an exact acknowledged neutral packet enables a distinct neutral output;
 * query output is never inferred or relabeled as neutral. No I/O/model dispatch.
 */
export function createStandingHistoryPeriodChronicleTurn(input: Readonly<{
  requestRef: string; signal: AbortSignal; neutralRequest?: StandingHistoryPeriodChronicleRequest; advisory?: StandingHistoryPeriodChronicleAdvisory;
}>): StandingHistoryPeriodChronicleTurn {
  const v = fields(input, ["requestRef", "signal"], ["neutralRequest", "advisory"]);
  if (!callRefValid(v.requestRef) || types.isProxy(v.signal) || !(v.signal instanceof AbortSignal) || v.signal.aborted || !Object.hasOwn(v, "neutralRequest") && !Object.hasOwn(v, "advisory")) return fail();
  const signal: AbortSignal = v.signal, requestRef: string = v.requestRef;
  const neutralRequest = Object.hasOwn(v, "neutralRequest") ? v.neutralRequest as StandingHistoryPeriodChronicleRequest : undefined;
  if (neutralRequest) standingHistoryPeriodChronicleBinding(neutralRequest); else if (Object.hasOwn(v, "neutralRequest")) return fail();
  const advisory = Object.hasOwn(v, "advisory") ? snapshot(v.advisory) as StandingHistoryPeriodChronicleAdvisory : undefined;
  if (Object.hasOwn(v, "advisory") && (!advisory || advisory.schema !== "standing-history-period-chronicle-advisory-v1" || advisory.use !== "supplement-current-source" ||
      advisory.claimsStatus !== "model-authored-unverified" || advisory.currentSourceRequired !== true || advisory.queryCoverage !== "not-established" || advisory.coverage.periodComplete !== false ||
      Buffer.byteLength(JSON.stringify(advisory)) > 16384)) return fail();
  const neutralResult = neutralRequest ? result(neutralRequest) : undefined, advisoryResult = advisory ? result(advisory) : undefined;
  const contextHash = hash({ schema: "standing-history-period-turn-context-v1", neutralRequest: neutralRequest ?? null, advisory: advisory ?? null });
  const advertised = Object.freeze({ contextHash, neutralPeriodNotesAvailable: !!neutralRequest, periodAdvisoryAvailable: !!advisory });
  const reads = new Map<string, Readonly<{ purpose: StandingHistoryPeriodChronicleMaterialPurpose; resultHash: string }>>();
  let closed = false, materialBound = false, neutralShown = false, mainPrepared = false, staged: StandingHistoryAnalysisOutput | undefined, ready: StandingHistoryPeriodChroniclePrepared | undefined;
  const live = () => !closed && !signal.aborted;
  const close = () => { closed = true; reads.clear(); staged = undefined; ready = undefined; signal.removeEventListener("abort", close); };
  signal.addEventListener("abort", close, { once: true });
  return Object.freeze({ contextHash, advertised,
    assertMaterialBinding(value) {
      if (!live() || materialBound) return fail();
      const b = fields(value, ["requestRef", "supports"]), supports = snapshot(b.supports) as readonly StandingHistoryAnalysisSupport[];
      if (b.requestRef !== requestRef || !Array.isArray(supports) || supports.length > MAX_SUPPORTS) return fail();
      const available = new Set(supports.map(s => s.sourceRef + ":" + s.versionRef));
      const required = [...(neutralRequest?.material.rows ?? []), ...(advisory?.claims.flatMap(c => c.supports) ?? [])];
      if (required.some(s => !available.has(s.sourceRef + ":" + s.versionRef))) return fail();
      materialBound = true;
    },
    readMaterial(value) {
      if (!live() || !materialBound || mainPrepared) return undefined;
      const r = fields(value, ["purpose", "callRef"]);
      if (!callRefValid(r.callRef) || !["neutral-period-notes", "period-advisory"].includes(r.purpose) || reads.has(r.callRef) || reads.size >= 7) return undefined;
      const output = r.purpose === "neutral-period-notes" ? neutralResult : advisoryResult; if (!output) return undefined;
      reads.set(r.callRef, { purpose: r.purpose, resultHash: hash(output) }); return output;
    },
    onToolResultSent(value) {
      if (!live()) return;
      const a = fields(value, ["requestRef", "callRef", "name", "result"]);
      if (a.requestRef !== requestRef || a.name !== "neurobro_analysis_material" || !callRefValid(a.callRef)) return;
      const issued = reads.get(a.callRef); if (!issued) return;
      // Snapshot without getters before hashing the exact transport receipt.
      const delivered = snapshot(a.result) as EpochToolResult;
      if (delivered.success !== true || hash(delivered) !== issued.resultHash) return;
      if (issued.purpose === "neutral-period-notes") neutralShown = true;
    },
    stageNeutralOutput(value) {
      if (!live() || mainPrepared) return false;
      staged = undefined;
      if (!neutralRequest || !neutralShown) return false;
      try {
        const output = fields(value, ["inputHash", "output"]);
        if (output.inputHash !== neutralRequest.inputHash) return false;
        staged = reboundStandingHistoryPeriodChronicleOutput(portableStandingHistoryPeriodChronicleOutput(output.output, neutralRequest), neutralRequest);
        return true;
      } catch { return false; }
    },
    primaryPrepared() {
      if (!live() || mainPrepared) return; mainPrepared = true;
      if (staged && neutralRequest && neutralShown) ready = Object.freeze({ request: neutralRequest, output: staged });
      staged = undefined;
    },
    prepared() { return live() ? ready : undefined; },
    close,
  });
}
