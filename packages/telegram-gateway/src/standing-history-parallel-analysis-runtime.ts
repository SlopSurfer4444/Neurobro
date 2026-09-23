import { createHash } from "node:crypto";
import { MAX_SUPPORTS, NODE_PLAIN_BYTES } from "./standing-history-analysis-limits.js";
import { ANALYSIS_TOOL_TEXT_BYTES, ANALYSIS_TOOL_RESULT_BYTES } from "./standing-tool-dispatcher.js";
import { types } from "node:util";
import { ANALYSIS_TOOL_SPECS, prepareStandingHistoryAnalysisMaterial, type StandingHistoryAnalysisRuntimeMaterial } from "./standing-history-analysis-runtime.js";
import { snapshotStandingHistoryAnalysisOutput, validateStandingHistoryShownOutput, StandingHistoryAnalysisStoreError,
  type StandingHistoryAnalysisSupport, type StandingHistoryAnalysisMaterialRequest } from "./standing-history-analysis-store.js";
import { snapshotStandingHistoryTaskIntent, standingHistoryTaskSourcePeerId, type StandingHistoryTaskIntent, type StandingHistoryTaskStore } from "./standing-history-task-store.js";
import type { StandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import type { StandingHistoryParallelWorkStore, StandingHistoryParallelWork } from "./standing-history-parallel-work-store.js";
import type { EpochExtraTool, EpochToolResult, EpochToolScope } from "./standing-tool-dispatcher.js";
import type { StandingHistoryPeriodChronicleTurn, StandingHistoryPeriodChroniclePrepared } from "./standing-history-period-chronicle-turn.js";

type LeafMaterial = Exclude<StandingHistoryAnalysisRuntimeMaterial, { schema: "standing-history-merge-view-v1" }>;
export type StandingHistoryParallelAnalysisRuntime = Readonly<{
  specs: typeof ANALYSIS_TOOL_SPECS; handlers: readonly EpochExtraTool[];
  begin(input: Readonly<{ requestRef: string; workRef: string; material: LeafMaterial; controlHead: string; signal: AbortSignal; periodChronicle?: StandingHistoryPeriodChronicleTurn }>): Promise<void>;
  onToolResultSent(input: Readonly<{ requestRef: string; callRef: string; name: string; result: EpochToolResult }>): void;
  finish(): Promise<void>; close(): Promise<void>;
  preparedPeriodChronicle(): StandingHistoryPeriodChroniclePrepared | undefined;
}>;
const fail = (): never => { throw new Error("STANDING_HISTORY_PARALLEL_ANALYSIS_RUNTIME_INPUT"); };
const ref = (v: unknown, p: string): v is string => typeof v === "string" && new RegExp("^" + p + "_[0-9a-f]{48}$", "u").test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
const request = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v);
const callRefValid = (v: unknown): v is string => typeof v === "string" && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(v);
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => typeof k !== "string" || !required.includes(k) && !optional.includes(k))) return fail();
  return Object.fromEntries(keys.map(k => { const d = ds[k as string]!; if (!("value" in d) || !d.enumerable) return fail(); return [k, d.value]; }));
}
function snapshot<T>(value: T, maximum = NODE_PLAIN_BYTES): T {
  let remaining = maximum;
  function visit(v: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 32) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isSafeInteger(v)) return fail(); return v; }
    if (typeof v === "string") { remaining -= Buffer.byteLength(v); if (remaining < 0 || Buffer.from(v).toString("utf8") !== v) return fail(); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > MAX_SUPPORTS || Reflect.ownKeys(v).length !== v.length + 1) return fail();
      return Object.freeze(Array.from({ length: v.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d || !("value" in d) || !d.enumerable) return fail(); return visit(d.value, depth + 1); }));
    }
    return Object.freeze(Object.fromEntries(Object.entries(fields(v, [], Object.keys(v))).map(([k, x]) => [k, visit(x, depth + 1)])));
  }
  const copy = visit(value, 0) as T; if (Buffer.byteLength(JSON.stringify(copy)) > maximum) return fail(); return copy;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v);
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
function method<T extends (...args: never[]) => unknown>(v: unknown, name: string): T {
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail(); const d = Object.getOwnPropertyDescriptor(v, name);
  if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail(); return d.value.bind(v) as T;
}
// Existing borrowed stores reject overlapping status operations. Share only a
// bounded read lane between runtime instances with the same capability object.
// This grants no source-write, Telegram-client or native-owner capability.
const readLanes = new WeakMap<object, { tail: Promise<unknown>; pending: number }>();
function sharedRead<T>(port: object, read: () => Promise<T>): Promise<T> {
  let lane = readLanes.get(port); if (!lane) { lane = { tail: Promise.resolve(), pending: 0 }; readLanes.set(port, lane); }
  if (lane.pending >= 16) return Promise.reject(new Error("STANDING_HISTORY_PARALLEL_ANALYSIS_READ_BUSY")); lane.pending++;
  const current = lane, result = current.tail.then(read); current.tail = result.catch(() => {}).finally(() => { current.pending--; }); return result;
}
const result = (success: boolean, value: unknown): EpochToolResult => {
  const text = JSON.stringify(value); if (Buffer.byteLength(text) > ANALYSIS_TOOL_TEXT_BYTES) return fail();
  const output: EpochToolResult = Object.freeze({ success, contentItems: Object.freeze([Object.freeze({ type: "inputText", text })]) as EpochToolResult["contentItems"] });
  if (Buffer.byteLength(JSON.stringify(output)) > ANALYSIS_TOOL_RESULT_BYTES) return fail(); return output;
};
const refused = (code: string) => result(false, { schema: "neurobro-history-analysis-error-v1", code });
type Pending = { name: string; resultHash: string; material: boolean; supports: readonly StandingHistoryAnalysisSupport[]; acknowledged: boolean };
type Turn = { requestRef: string; workRef: string; controlHead: string; signal: AbortSignal; controller: AbortController; abort: () => void;
  periodChronicle?: StandingHistoryPeriodChronicleTurn;
  work?: StandingHistoryParallelWork; material?: LeafMaterial; ready: boolean; calls: number; reads: number; commitStarted: boolean; prepared: boolean; materialShown: boolean;
  shown: Map<string, StandingHistoryAnalysisSupport>; pending: Map<string, Pending>; usedCalls: Set<string>; callSignals: Map<string, AbortSignal>; active?: Promise<unknown>; closing?: Promise<void> };

/** One leaf worker's tools. Independent instances may run concurrently. begin
 * binds an existing reservation, but does not authorize a native dispatch: the
 * host must own its fresh reserve return and sole dispatch. Only acknowledged
 * material is shown evidence. Commit stages output, never an analysis node or
 * native outcome. Persisted work recovery/projecting belongs to the work store.
 * The host freezes source/analysis writes for the wave and supplies a control
 * capability that reads the current durable queued/cancelled head. */
export function createStandingHistoryParallelAnalysisRuntime(input: Readonly<{
  intent: StandingHistoryTaskIntent; signal: AbortSignal; source: Pick<StandingHistoryTaskStore, "status">;
  control: Pick<StandingHistoryTaskControlStore, "status">; workStore: Pick<StandingHistoryParallelWorkStore, "readWork" | "prepare">;
}>): StandingHistoryParallelAnalysisRuntime {
  const args = fields(input, ["intent", "signal", "source", "control", "workStore"]), intent = snapshotStandingHistoryTaskIntent(args.intent);
  if (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal)) return fail(); const signal = args.signal;
  const sourceStatus = method<StandingHistoryTaskStore["status"]>(args.source, "status"), controlStatus = method<StandingHistoryTaskControlStore["status"]>(args.control, "status");
  const readWork = method<StandingHistoryParallelWorkStore["readWork"]>(args.workStore, "readWork"), prepare = method<StandingHistoryParallelWorkStore["prepare"]>(args.workStore, "prepare");
  let current: Turn | undefined, closed = false; const usedWorks = new Set<string>();
  const guard = (turn: Turn) => { if (closed || signal.aborted || current !== turn || turn.signal.aborted || turn.controller.signal.aborted) return fail(); };
  function finish(): Promise<void> {
    const turn = current; if (!turn) return Promise.resolve(); if (turn.closing) return turn.closing;
    turn.closing = Promise.resolve().then(async () => { try { await turn.active; } catch {} finally {
      turn.periodChronicle?.close(); turn.pending.clear(); turn.shown.clear(); turn.usedCalls.clear(); turn.callSignals.clear(); turn.signal.removeEventListener("abort", turn.abort); if (current === turn) current = undefined;
    } }); turn.controller.abort(); return turn.closing;
  }
  const abort = () => { void finish(); }; signal.addEventListener("abort", abort, { once: true });
  async function heads(turn: Turn) {
    guard(turn); const work = turn.work; if (!work) return fail();
    const control = snapshot(await sharedRead(args.control as object, async () => { guard(turn); return controlStatus(); })); guard(turn);
    fields(control, ["storage", "state", "revision", "headHash"]);
    if (control.storage !== "ready" || control.state !== "queued" || control.revision !== 0 || control.headHash !== turn.controlHead) return fail();
    const source = snapshot(await sharedRead(args.source as object, async () => { guard(turn); return sourceStatus(); })); guard(turn);
    fields(source, ["storage", "readProgress", "modelProgress", "limits"]); const progress = fields(source.readProgress, ["committedPages", "checkpoint", "chainHash"]);
    const checkpoint = progress.checkpoint as Record<string, unknown>;
    if (source.storage !== "ready" || progress.chainHash !== work.sourceHead || checkpoint.accountId !== intent.accountId || checkpoint.chatId !== standingHistoryTaskSourcePeerId(intent) || checkpoint.fromDate !== intent.fromDate || checkpoint.toDate !== intent.toDate) return fail();
  }
  function stage(turn: Turn, callRef: string, name: string, output: EpochToolResult, material = false, supports: readonly StandingHistoryAnalysisSupport[] = []): EpochToolResult {
    if (current === turn && !turn.controller.signal.aborted && !turn.signal.aborted && !signal.aborted && !closed)
      turn.pending.set(callRef, { name, resultHash: hash(output), material, supports, acknowledged: false });
    return output;
  }
  async function call(name: string, value: unknown, scope: EpochToolScope): Promise<EpochToolResult> {
    const turn = current; if (!turn || !turn.ready || !turn.material || closed || signal.aborted || turn.controller.signal.aborted || turn.signal.aborted || turn.active) return refused("unavailable");
    let callRef: string, callSignal: AbortSignal;
    try { const s = fields(scope, ["requestRef", "callRef", "signal"]);
      if (s.requestRef !== turn.requestRef || !callRefValid(s.callRef) || types.isProxy(s.signal) || !(s.signal instanceof AbortSignal) || s.signal.aborted) return refused("invalid-scope");
      callRef = s.callRef; callSignal = AbortSignal.any([signal, turn.signal, turn.controller.signal, s.signal]);
    } catch { return refused("invalid-scope"); }
    if (turn.usedCalls.has(callRef)) return refused("duplicate-call"); if (turn.calls >= 8) return refused("call-limit");
    turn.calls++; turn.usedCalls.add(callRef); turn.callSignals.set(callRef, callSignal);
    if (turn.commitStarted || turn.prepared) return stage(turn, callRef, name, refused("commit-consumed"));
    if (name !== "neurobro_analysis_commit") { if (turn.reads >= 7) return stage(turn, callRef, name, refused("read-call-limit")); turn.reads++; }
    let parsed: Record<string, unknown>;
    try {
      parsed = name === "neurobro_analysis_material" ? fields(value, [], ["purpose"]) : name === "neurobro_analysis_notes" ? fields(value, ["nodeRef", "position"]) : fields(value, ["output"], ["neutralOutput"]);
      if (name === "neurobro_analysis_material" && Object.hasOwn(parsed, "purpose") && !["neutral-period-notes", "period-advisory"].includes(parsed.purpose as string)) return stage(turn, callRef, name, refused("invalid-arguments"));
      if (name === "neurobro_analysis_notes" && (!ref(parsed.nodeRef, "hnode") || parsed.position !== null && (typeof parsed.position !== "string" || !/^hnpos_(?:0|[1-9]\d{0,3})_(?:0|[1-9]\d?)_[0-9a-f]{48}$/u.test(parsed.position)))) return stage(turn, callRef, name, refused("invalid-arguments"));
      if (name === "neurobro_analysis_commit") parsed = { output: snapshotStandingHistoryAnalysisOutput(parsed.output), ...(Object.hasOwn(parsed, "neutralOutput") ? { neutralOutput: parsed.neutralOutput } : {}) };
    } catch { return stage(turn, callRef, name, refused("invalid-arguments")); }
    const stop = () => { if (current === turn) void finish(); }; callSignal.addEventListener("abort", stop, { once: true });
    const pending = Promise.resolve().then(async () => {
      await heads(turn); if (callSignal.aborted) return refused("stopped");
      if (name === "neurobro_analysis_notes") return stage(turn, callRef, name, refused("child-unavailable"));
      if (name === "neurobro_analysis_material") {
        if (Object.hasOwn(parsed, "purpose")) {
          const optional = turn.periodChronicle?.readMaterial({ purpose: parsed.purpose as "neutral-period-notes" | "period-advisory", callRef });
          // Optional notes are not the primary raw source and cannot acknowledge
          // its read or add evidence to the primary query output.
          return stage(turn, callRef, name, optional ?? refused("optional-material-unavailable"));
        }
        const material = turn.material!, fragments = material.schema === "standing-history-source-fragment-v1" ? [material] : material.fragments;
        const supports = Object.freeze(fragments.flatMap(fragment => fragment.rows.filter(row => row.disposition === "included").map(row => Object.freeze({ sourceRef: row.sourceRef, versionRef: row.versionRef }))));
        return stage(turn, callRef, name, result(true, material), true, supports);
      }
      if (!turn.materialShown) return stage(turn, callRef, name, refused("material-not-shown"));
      let output: ReturnType<typeof validateStandingHistoryShownOutput>;
      try { output = validateStandingHistoryShownOutput(parsed.output, [...turn.shown.values()]); }
      catch (error) { if (error instanceof StandingHistoryAnalysisStoreError && error.code === "support") return stage(turn, callRef, name, refused("unshown-support")); throw error; }
      turn.periodChronicle?.stageNeutralOutput(parsed.neutralOutput);
      // This is the last correctable boundary. Never reinterpret an uncertain
      // prepare return as pre-write refusal, even if its error has the same code.
      await heads(turn); if (callSignal.aborted) return refused("stopped"); turn.commitStarted = true;
      await prepare({ workRef: turn.workRef, output, shownSupports: [...turn.shown.values()] }); guard(turn);
      const saved = snapshot(await readWork(turn.workRef)); guard(turn);
      if (saved.workRef !== turn.workRef || saved.plan.nativeBinding.requestRef !== turn.requestRef || !saved.output || hash(saved.output) !== hash(output) || saved.projection || saved.node || saved.modelOutcome === "refused") return fail();
      turn.prepared = true;
      turn.periodChronicle?.primaryPrepared();
      return stage(turn, callRef, name, result(true, { schema: "neurobro-history-analysis-prepared-v1", prepared: true, projectionPending: true, claimsStatus: "model-authored-unverified" }));
    }).catch(() => stage(turn, callRef, name, refused("unavailable")));
    turn.active = pending; try { return await pending; } finally { callSignal.removeEventListener("abort", stop); if (turn.active === pending) delete turn.active; }
  }
  return Object.freeze<StandingHistoryParallelAnalysisRuntime>({
    specs: ANALYSIS_TOOL_SPECS,
    handlers: Object.freeze(ANALYSIS_TOOL_SPECS.map(spec => Object.freeze({ name: spec.name, call: (value: unknown, scope: EpochToolScope) => call(spec.name, value, scope) }))),
    async begin(value) {
      if (closed || signal.aborted || current) return fail(); const v = fields(value, ["requestRef", "workRef", "material", "controlHead", "signal"], ["periodChronicle"]);
      if (!request(v.requestRef) || !ref(v.workRef, "hwork") || !digest(v.controlHead) || types.isProxy(v.signal) || !(v.signal instanceof AbortSignal) || v.signal.aborted || usedWorks.has(v.workRef) || usedWorks.size >= 1024) return fail();
      const suppliedMaterial = snapshot(v.material), turn: Turn = { requestRef: v.requestRef, workRef: v.workRef, controlHead: v.controlHead, signal: v.signal, controller: new AbortController(),
        abort: () => { if (current === turn) void finish(); }, ready: false, calls: 0, reads: 0, commitStarted: false, prepared: false, materialShown: false, shown: new Map(), pending: new Map(), usedCalls: new Set(), callSignals: new Map() };
      if (Object.hasOwn(v, "periodChronicle")) {
        const p = fields(v.periodChronicle, ["contextHash", "advertised", "assertMaterialBinding", "readMaterial", "onToolResultSent", "stageNeutralOutput", "primaryPrepared", "prepared", "close"]);
        if (!digest(p.contextHash)) return fail();
        turn.periodChronicle = Object.freeze({ contextHash: p.contextHash, advertised: snapshot(p.advertised) as StandingHistoryPeriodChronicleTurn["advertised"],
          assertMaterialBinding: method<StandingHistoryPeriodChronicleTurn["assertMaterialBinding"]>(v.periodChronicle, "assertMaterialBinding"),
          readMaterial: method<StandingHistoryPeriodChronicleTurn["readMaterial"]>(v.periodChronicle, "readMaterial"),
          onToolResultSent: method<StandingHistoryPeriodChronicleTurn["onToolResultSent"]>(v.periodChronicle, "onToolResultSent"),
          stageNeutralOutput: method<StandingHistoryPeriodChronicleTurn["stageNeutralOutput"]>(v.periodChronicle, "stageNeutralOutput"),
          primaryPrepared: method<StandingHistoryPeriodChronicleTurn["primaryPrepared"]>(v.periodChronicle, "primaryPrepared"),
          prepared: method<StandingHistoryPeriodChronicleTurn["prepared"]>(v.periodChronicle, "prepared"), close: method<StandingHistoryPeriodChronicleTurn["close"]>(v.periodChronicle, "close") });
      }
      usedWorks.add(turn.workRef); current = turn; turn.signal.addEventListener("abort", turn.abort, { once: true });
      const pending = Promise.resolve().then(async () => {
        guard(turn); const saved = snapshot(await readWork(turn.workRef)); guard(turn);
        fields(saved, ["workRef", "waveRef", "ordinal", "sourceHead", "baseAnalysisHead", "baseNodeCount", "plan", "modelReplayAllowed"], ["output", "modelOutcome", "projection", "node", "consecutiveNoOutput", "noOutputClassification"]);
        // The journal counts this already-reserved attempt. The third attempt
        // may execute; reserving a fourth remains forbidden by the store.
        if (saved.consecutiveNoOutput !== undefined && (!Number.isSafeInteger(saved.consecutiveNoOutput) || saved.consecutiveNoOutput < 0 || saved.consecutiveNoOutput > 3)) return fail();
        if (saved.noOutputClassification !== undefined && saved.noOutputClassification !== "missing-outcome") return fail();
        if (saved.workRef !== turn.workRef || !ref(saved.waveRef, "hwave") || !digest(saved.sourceHead) || !digest(saved.baseAnalysisHead) || saved.modelReplayAllowed !== false ||
            saved.output || saved.modelOutcome || saved.projection || saved.node || saved.plan.kind !== "leaf" || saved.plan.nativeBinding.requestRef !== turn.requestRef || saved.plan.nativeBinding.purpose !== "history-analysis") return fail();
        if (saved.plan.contextHash !== turn.periodChronicle?.contextHash) return fail();
        const prepared = prepareStandingHistoryAnalysisMaterial({ kind: "leaf", sourceHead: saved.sourceHead, expectedHead: saved.baseAnalysisHead,
          inputs: saved.plan.inputs as [StandingHistoryAnalysisMaterialRequest, ...StandingHistoryAnalysisMaterialRequest[]], material: suppliedMaterial as LeafMaterial });
        if (prepared.modelInputHash !== saved.plan.modelInputHash || prepared.material.schema === "standing-history-merge-view-v1") return fail();
        const material = prepared.material, fragments = material.schema === "standing-history-source-fragment-v1" ? [material] : material.fragments;
        if (fragments.length !== saved.plan.inputs.length || fragments.some((fragment, i) => saved.plan.kind !== "leaf" || fragment.materialRef !== saved.plan.inputs[i]!.materialRef || fragment.pageIndex !== saved.plan.inputs[i]!.pageIndex ||
            fragment.fromDate !== intent.fromDate || fragment.toDate !== intent.toDate || (intent.source ? fragment.sourceRef !== "community" || fragment.sourceInterpretation !== "quoted-source-not-request" : Object.hasOwn(fragment, "sourceRef") || Object.hasOwn(fragment, "sourceInterpretation")))) return fail();
        turn.periodChronicle?.assertMaterialBinding({ requestRef: turn.requestRef, supports: fragments.flatMap(f => f.rows.map(r => ({ sourceRef: r.sourceRef, versionRef: r.versionRef }))) });
        turn.work = saved; turn.material = material; await heads(turn); turn.ready = true;
      });
      turn.active = pending; try { await pending; } catch (error) { await finish(); throw error; } finally { if (turn.active === pending) delete turn.active; }
    },
    onToolResultSent(value) {
      const v = fields(value, ["requestRef", "callRef", "name", "result"]), turn = current;
      if (!turn || !turn.ready || v.requestRef !== turn.requestRef || !callRefValid(v.callRef) || typeof v.name !== "string") return fail(); guard(turn);
      const pending = turn.pending.get(v.callRef), output = snapshot(v.result, ANALYSIS_TOOL_RESULT_BYTES) as EpochToolResult; fields(output, ["success", "contentItems"]);
      if (!pending || turn.callSignals.get(v.callRef)?.aborted || pending.name !== v.name || pending.resultHash !== hash(output)) return fail(); if (pending.acknowledged) return;
      const shown = new Map(turn.shown); if (output.success) for (const s of pending.supports) shown.set(s.sourceRef + ":" + s.versionRef, s);
      if (shown.size > MAX_SUPPORTS) return fail(); turn.shown = shown; pending.acknowledged = true; if (output.success && pending.material) turn.materialShown = true;
      turn.periodChronicle?.onToolResultSent({ requestRef: turn.requestRef, callRef: v.callRef, name: v.name, result: output });
    },
    preparedPeriodChronicle() { const turn = current; if (!turn || !turn.prepared || closed || signal.aborted || turn.signal.aborted || turn.controller.signal.aborted) return undefined; return turn.periodChronicle?.prepared(); },
    finish, async close() { closed = true; await finish(); usedWorks.clear(); signal.removeEventListener("abort", abort); }
  });
}
