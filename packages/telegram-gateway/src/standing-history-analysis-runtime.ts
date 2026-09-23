import { STANDING_HISTORY_REPORT_REVIEW_SCHEMA } from "./standing-history-report-quality.js";
import { MATERIAL_BYTES, MAX_FRAGMENTS, MAX_ANALYSIS_NODES, MAX_SUPPORTS, SUMMARY_BYTES, MAX_CLAIMS, NODE_PLAIN_BYTES } from "./standing-history-analysis-limits.js";
import { ANALYSIS_TOOL_TEXT_BYTES, ANALYSIS_TOOL_RESULT_BYTES } from "./standing-tool-dispatcher.js";
import { createHash } from "node:crypto";
import { types } from "node:util";
import type { EpochExtraTool, EpochToolResult, EpochToolScope } from "./standing-tool-dispatcher.js";
import { snapshotStandingHistoryTaskIntent, standingHistoryTaskSourcePeerId, type StandingHistoryTaskIntent, type StandingHistoryTaskStore } from "./standing-history-task-store.js";
import type { StandingHistoryTaskControlStore } from "./standing-history-task-control-store.js";
import { snapshotStandingHistoryAnalysisOutput, validateStandingHistoryShownOutput, StandingHistoryAnalysisStoreError, type StandingHistoryAnalysisStore, type StandingHistoryAnalysisSupport } from "./standing-history-analysis-store.js";
import type { StandingHistoryAnalysisAttemptPlan, StandingHistoryAnalysisAttemptStore } from "./standing-history-analysis-attempt-store.js";
import type { StandingHistoryAnalysisPlan, StandingHistorySourceBatch } from "./standing-history-analysis-planner.js";
import type { StandingHistorySourceFragment } from "./standing-history-source-projection.js";
import { readNodeNotes, type StandingHistoryMergeView, type StandingHistoryNodeNotes } from "./standing-history-analysis-view.js";

export type StandingHistoryAnalysisRuntimeMaterial = StandingHistorySourceFragment | StandingHistorySourceBatch | StandingHistoryMergeView;
type ActionPlan = Extract<StandingHistoryAnalysisPlan, { kind: "leaf" | "merge" }>;
const fail = (): never => { throw new Error("STANDING_HISTORY_ANALYSIS_RUNTIME_INPUT"); };
const ref = (v: unknown, prefix: string): v is string => typeof v === "string" && new RegExp("^" + prefix + "_[0-9a-f]{48}$", "u").test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
const scopedRef = (v: unknown): v is string => typeof v === "string" && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(v);
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
    if (typeof v === "number") { if (!Number.isFinite(v)) return fail(); return v; }
    if (typeof v === "string") { remaining -= Buffer.byteLength(v); if (remaining < 0 || Buffer.from(v).toString("utf8") !== v) return fail(); return v; }
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    const isArray = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail();
    const keys = Reflect.ownKeys(v), result: object = isArray ? [] : {};
    if (isArray && (Object.getOwnPropertyDescriptor(v, "length")!.value > MAX_SUPPORTS || keys.length !== Object.getOwnPropertyDescriptor(v, "length")!.value + 1)) return fail();
    for (const k of keys) {
      if (isArray && k === "length") continue;
      if (typeof k !== "string" || k === "__proto__" || isArray && !/^(?:0|[1-9]\d*)$/u.test(k)) return fail();
      const d = Object.getOwnPropertyDescriptor(v, k)!; if (!("value" in d) || !d.enumerable) return fail();
      Object.defineProperty(result, k, { value: visit(d.value, depth + 1), enumerable: true });
    }
    return Object.freeze(result);
  }
  const copied = visit(value, 0) as T; if (Buffer.byteLength(JSON.stringify(copied)) > maximum) return fail(); return copied;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function method<T extends (...args: never[]) => unknown>(v: unknown, name: string): T {
  if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
  const d = Object.getOwnPropertyDescriptor(v, name); if (!d || !("value" in d) || typeof d.value !== "function" || types.isProxy(d.value)) return fail(); return d.value.bind(v) as T;
}
function supportCopy(value: unknown): StandingHistoryAnalysisSupport {
  const s = fields(value, ["sourceRef", "versionRef"]); if (!ref(s.sourceRef, "hsrc") || !ref(s.versionRef, "hver")) return fail();
  return Object.freeze({ sourceRef: s.sourceRef, versionRef: s.versionRef });
}
const supportKey = (s: StandingHistoryAnalysisSupport) => s.sourceRef + ":" + s.versionRef;
function noteSupports(notes: StandingHistoryNodeNotes): readonly StandingHistoryAnalysisSupport[] {
  if (!ref(notes.nodeRef, "hnode") || !digest(notes.nodeHash) || !Array.isArray(notes.claims) || notes.claims.length > MAX_CLAIMS) return fail();
  const supports: StandingHistoryAnalysisSupport[] = [];
  for (const claim of notes.claims) { if (!Array.isArray(claim.supports) || claim.supports.length > 16) return fail(); for (const s of claim.supports) supports.push(supportCopy(s)); }
  return Object.freeze(supports);
}
function materialCopy(value: unknown): StandingHistoryAnalysisRuntimeMaterial {
  const material = snapshot(value) as StandingHistoryAnalysisRuntimeMaterial;
  if (material.schema === "standing-history-source-fragment-v1") {
    fields(material, ["schema", "materialRef", "pageHash", "pageIndex", "fromDate", "toDate", "rows", "range", "nextPosition", "coverage", "limitations"], ["sourceRef", "sourceInterpretation"]);
    if ((Object.hasOwn(material, "sourceRef") || Object.hasOwn(material, "sourceInterpretation")) &&
        (material.sourceRef !== "community" || material.sourceInterpretation !== "quoted-source-not-request")) return fail();
    if (!ref(material.materialRef, "hmat") || !digest(material.pageHash) || !Number.isInteger(material.pageIndex) || material.pageIndex < 1 || material.pageIndex > 1024 || !Array.isArray(material.rows) || material.rows.length > 100) return fail();
    for (const row of material.rows) { supportCopy({ sourceRef: row.sourceRef, versionRef: row.versionRef }); if (!["included", "nonText", "invalidText", "unavailable", "outsidePeriod"].includes(row.disposition)) return fail(); }
  } else if (material.schema === "standing-history-source-batch-v1") {
    fields(material, ["schema", "fragments"]);
    if (!Array.isArray(material.fragments) || material.fragments.length < 2 || material.fragments.length > MAX_FRAGMENTS) return fail();
    const seen = new Set<string>();
    for (const item of material.fragments) {
      const fragment = materialCopy(item);
      if (fragment.schema !== "standing-history-source-fragment-v1" || seen.has(fragment.materialRef)) return fail();
      seen.add(fragment.materialRef);
    }
  } else if (material.schema === "standing-history-merge-view-v1") {
    fields(material, ["schema", "children", "detailCoverage", "claimsStatus"]);
    if (!Array.isArray(material.children) || material.children.length < 2 || material.children.length > MAX_ANALYSIS_NODES || material.claimsStatus !== "model-authored-unverified" ||
        material.detailCoverage !== (material.children.some(child => child.detailCoverage === "partial") ? "partial" : "complete")) return fail();
    for (const child of material.children) noteSupports(child);
    if (new Set(material.children.map(child => child.nodeRef)).size !== material.children.length) return fail();
  } else return fail();
  if (Buffer.byteLength(JSON.stringify(material)) > MATERIAL_BYTES) return fail(); return material;
}

/** Call before reservation. Host planner/store provenance authenticates source;
 * a matching hash alone does not. This snapshots and measures the exact view
 * which will be returned, never silently crops/reprojects reserved material. */
export function prepareStandingHistoryAnalysisMaterial(value: ActionPlan): Readonly<{ material: StandingHistoryAnalysisRuntimeMaterial; modelInputHash: string }> {
  const p = fields(value, ["kind", "sourceHead", "expectedHead"], ["inputs", "material", "children", "materials", "viewMaxBytes"]);
  let material: StandingHistoryAnalysisRuntimeMaterial;
  if (p.kind === "leaf" && !Object.hasOwn(p, "children") && !Object.hasOwn(p, "materials")) material = materialCopy(p.material);
  else if (p.kind === "merge" && !Object.hasOwn(p, "inputs") && !Object.hasOwn(p, "material")) {
    const children = snapshot(p.materials) as StandingHistoryMergeView["children"];
    material = materialCopy({ schema: "standing-history-merge-view-v1", children,
      detailCoverage: children.some(child => child.detailCoverage === "partial") ? "partial" : "complete", claimsStatus: "model-authored-unverified" });
  } else return fail();
  return Object.freeze({ material, modelInputHash: hash(material) });
}

export const ANALYSIS_TOOL_SPECS = snapshot([
  {
    "type": "function" as const,
    "name": "neurobro_analysis_material",
    "description": "Read the host-selected material for this analysis attempt. Coverage and omitted detail are explicit; stored model notes are unverified. No other task or source can be selected.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "purpose": {
          "type": "string",
          "enum": [
            "neutral-period-notes",
            "period-advisory",
            "final-report-source",
            "final-report-candidate"
          ]
        },
        "pageIndex": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1024
        },
        "position": {
          "type": [
            "string",
            "null"
          ],
          "pattern": "^hpos_(?:0|[1-9][0-9]{0,2})_[0-9a-f]{48}$"
        }
      },
      "required": []
    }
  },
  {
    "type": "function" as const,
    "name": "neurobro_analysis_notes",
    "description": "Read bounded notes of a supplied child in a merge or an advertised bound node in final-report synthesis. Use only its supplied nodeRef and nextPosition; null starts its notes. Omitted notes are not shown or analyzed by this call.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "nodeRef": {
          "type": "string",
          "pattern": "^hnode_[0-9a-f]{48}$"
        },
        "position": {
          "type": [
            "string",
            "null"
          ],
          "pattern": "^hnpos_(?:0|[1-9][0-9]{0,4})_(?:0|[1-9][0-9]{0,2})_[0-9a-f]{48}$"
        }
      },
      "required": [
        "nodeRef",
        "position"
      ]
    }
  },
  {
    "type": "function" as const,
    "name": "neurobro_analysis_commit",
    "description": "Save one bounded analysis node, exclusive finalReport body for kind final-report, or exclusive reportReview verdict for kind final-report-review, for the current host-owned attempt. Final report body is at most32768 UTF8 bytes and is distinct from internal notes. Summary is at most32768 UTF8 bytes; each claim text at most1024 UTF8 bytes. Supports must be exact source/version pairs shown in this attempt. Saving notes does not prove their truth, full archive coverage or Telegram delivery.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "output": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "summary": {
              "type": "string",
              "minLength": 1,
              "maxLength": SUMMARY_BYTES
            },
            "claims": {
              "type": "array",
              "maxItems": MAX_CLAIMS,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "reported",
                      "decision",
                      "open-question",
                      "inference"
                    ]
                  },
                  "text": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1024
                  },
                  "supports": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 16,
                    "uniqueItems": true,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "sourceRef": {
                          "type": "string",
                          "pattern": "^hsrc_[0-9a-f]{48}$"
                        },
                        "versionRef": {
                          "type": "string",
                          "pattern": "^hver_[0-9a-f]{48}$"
                        }
                      },
                      "required": [
                        "sourceRef",
                        "versionRef"
                      ]
                    }
                  }
                },
                "required": [
                  "kind",
                  "text",
                  "supports"
                ]
              }
            },
            "omittedDetailCount": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "summary",
            "claims"
          ]
        },
        "neutralOutput": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "inputHash": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "output": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "summary": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": SUMMARY_BYTES
                },
                "claims": {
                  "type": "array",
                  "maxItems": MAX_CLAIMS,
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "kind": {
                        "type": "string",
                        "enum": [
                          "reported",
                          "decision",
                          "open-question",
                          "inference"
                        ]
                      },
                      "text": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 1024
                      },
                      "supports": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 16,
                        "uniqueItems": true,
                        "items": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "sourceRef": {
                              "type": "string",
                              "pattern": "^hsrc_[0-9a-f]{48}$"
                            },
                            "versionRef": {
                              "type": "string",
                              "pattern": "^hver_[0-9a-f]{48}$"
                            }
                          },
                          "required": [
                            "sourceRef",
                            "versionRef"
                          ]
                        }
                      }
                    },
                    "required": [
                      "kind",
                      "text",
                      "supports"
                    ]
                  }
                },
                "omittedDetailCount": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "summary",
                "claims"
              ]
            }
          },
          "required": [
            "inputHash",
            "output"
          ]
        },
        "reportReview": STANDING_HISTORY_REPORT_REVIEW_SCHEMA,
        "finalReport": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "body": {
              "type": "string",
              "minLength": 1,
              "maxLength": 32768
            }
          },
          "required": [
            "body"
          ]
        }
      },
      "required": []
    }
  }
]);

const result = (success: boolean, value: unknown): EpochToolResult => {
  const text = JSON.stringify(value); if (Buffer.byteLength(text) > ANALYSIS_TOOL_TEXT_BYTES) return fail();
  const output: EpochToolResult = Object.freeze({ success, contentItems: Object.freeze([Object.freeze({ type: "inputText", text })]) as EpochToolResult["contentItems"] });
  if (Buffer.byteLength(JSON.stringify(output)) > ANALYSIS_TOOL_RESULT_BYTES) return fail(); return output;
};
const refused = (code: string) => result(false, { schema: "neurobro-history-analysis-error-v1", code });
type Pending = { name: string; resultHash: string; supports: readonly StandingHistoryAnalysisSupport[]; material: boolean; acknowledged: boolean };
type Turn = { requestRef: string; attemptRef: string; plan: StandingHistoryAnalysisAttemptPlan; material: StandingHistoryAnalysisRuntimeMaterial; controlHead: string;
  signal: AbortSignal; controller: AbortController; abort: () => void; ready: boolean; calls: number; readCalls: number; commitStarted: boolean; committed: boolean; materialShown: boolean;
  shown: Map<string, StandingHistoryAnalysisSupport>; pending: Map<string, Pending>; usedCalls: Set<string>; callSignals: Map<string, AbortSignal>; active?: Promise<unknown>; closing?: Promise<void> };
export type StandingHistoryAnalysisRuntime = Readonly<{
  specs: typeof ANALYSIS_TOOL_SPECS; handlers: readonly EpochExtraTool[];
  begin(input: Readonly<{ requestRef: string; attemptRef: string; plan: StandingHistoryAnalysisAttemptPlan; material: StandingHistoryAnalysisRuntimeMaterial; controlHead: string; signal: AbortSignal }>): Promise<void>;
  onToolResultSent(input: Readonly<{ requestRef: string; callRef: string; name: string; result: EpochToolResult }>): void;
  finish(): Promise<void>; close(): Promise<void>;
}>;

/** One internal model scope, with a borrowed durable attempt store. begin does
 * not reserve or grant a model retry: its caller owns the fresh reserve return.
 * Scope heads/material are host-bound, never model arguments. Only an exact
 * successful wire acknowledgement adds shown supports. Native outcomes and
 * physical owner settlement are recorded/validated by the executor outside.
 * Cancellation can race admitted persistence; finish joins it without claiming
 * rollback or deleting prepared output/committed node evidence. */
export function createStandingHistoryAnalysisRuntime(input: Readonly<{
  intent: StandingHistoryTaskIntent; signal: AbortSignal;
  source: Pick<StandingHistoryTaskStore, "status">; control: Pick<StandingHistoryTaskControlStore, "status">;
  analysis: Pick<StandingHistoryAnalysisStore, "status" | "readNode" | "referenceKey">;
  attempts: Pick<StandingHistoryAnalysisAttemptStore, "status" | "prepare" | "commitPrepared">;
}>): StandingHistoryAnalysisRuntime {
  const args = fields(input, ["intent", "signal", "source", "control", "analysis", "attempts"]), intent = snapshotStandingHistoryTaskIntent(args.intent);
  if (types.isProxy(args.signal) || !(args.signal instanceof AbortSignal)) return fail(); const signal = args.signal;
  const sourceStatus = method<StandingHistoryTaskStore["status"]>(args.source, "status"), controlStatus = method<StandingHistoryTaskControlStore["status"]>(args.control, "status");
  const analysisStatus = method<StandingHistoryAnalysisStore["status"]>(args.analysis, "status"), readNode = method<StandingHistoryAnalysisStore["readNode"]>(args.analysis, "readNode"), referenceKey = method<StandingHistoryAnalysisStore["referenceKey"]>(args.analysis, "referenceKey");
  const attemptStatus = method<StandingHistoryAnalysisAttemptStore["status"]>(args.attempts, "status"), prepare = method<StandingHistoryAnalysisAttemptStore["prepare"]>(args.attempts, "prepare"), commitPrepared = method<StandingHistoryAnalysisAttemptStore["commitPrepared"]>(args.attempts, "commitPrepared");
  let current: Turn | undefined, closed = false; const usedAttempts = new Set<string>();
  const guard = (turn: Turn) => { if (closed || signal.aborted || current !== turn || turn.signal.aborted || turn.controller.signal.aborted) return fail(); };
  function finish(): Promise<void> {
    const turn = current; if (!turn) return Promise.resolve(); if (turn.closing) return turn.closing;
    turn.closing = Promise.resolve().then(async () => { try { await turn.active; } catch {} finally {
      turn.pending.clear(); turn.shown.clear(); turn.usedCalls.clear(); turn.callSignals.clear(); turn.signal.removeEventListener("abort", turn.abort); if (current === turn) current = undefined;
    } });
    turn.controller.abort(); return turn.closing;
  }
  const abort = () => { void finish(); }; signal.addEventListener("abort", abort, { once: true });
  async function heads(turn: Turn) {
    guard(turn); const c = fields(snapshot(await controlStatus()), ["storage", "state", "revision", "headHash"]); guard(turn);
    if (c.storage !== "ready" || c.state !== "queued" || c.revision !== 0 || c.headHash !== turn.controlHead) return fail();
    const s = fields(snapshot(await sourceStatus()), ["storage", "readProgress", "modelProgress", "limits"]); guard(turn);
    const p = fields(s.readProgress, ["committedPages", "checkpoint", "chainHash"]), checkpoint = p.checkpoint as Record<string, unknown>;
    if (s.storage !== "ready" || p.chainHash !== turn.plan.sourceHead || checkpoint.accountId !== intent.accountId || checkpoint.chatId !== standingHistoryTaskSourcePeerId(intent) || checkpoint.fromDate !== intent.fromDate || checkpoint.toDate !== intent.toDate) return fail();
    const a = fields(snapshot(await analysisStatus()), ["storage", "headHash", "analysisNodes", "leafNodes", "claims", "limits"]); guard(turn);
    if (a.storage !== "ready" || a.headHash !== turn.plan.expectedHead || a.analysisNodes !== turn.plan.nodeIndex - 1) return fail();
  }
  function stage(turn: Turn, callRef: string, name: string, output: EpochToolResult, supports: readonly StandingHistoryAnalysisSupport[] = [], material = false): EpochToolResult {
    if (current === turn && !turn.controller.signal.aborted && !turn.signal.aborted && !signal.aborted && !closed)
      turn.pending.set(callRef, { name, resultHash: hash(output), supports, material, acknowledged: false });
    return output;
  }
  async function call(name: string, value: unknown, scope: EpochToolScope): Promise<EpochToolResult> {
    const turn = current; if (!turn || !turn.ready || closed || signal.aborted || turn.controller.signal.aborted || turn.signal.aborted || turn.active) return refused("unavailable");
    let callRef: string, callSignal: AbortSignal;
    try {
      const s = fields(scope, ["requestRef", "callRef", "signal"]);
      if (s.requestRef !== turn.requestRef || !scopedRef(s.callRef) || types.isProxy(s.signal) || !(s.signal instanceof AbortSignal) || s.signal.aborted) return refused("invalid-scope");
      callRef = s.callRef; callSignal = AbortSignal.any([signal, turn.signal, turn.controller.signal, s.signal]);
    } catch { return refused("invalid-scope"); }
    if (turn.usedCalls.has(callRef)) return refused("duplicate-call");
    if (turn.calls >= 8) return refused("call-limit"); turn.calls++; turn.usedCalls.add(callRef); turn.callSignals.set(callRef, callSignal);
    if (turn.commitStarted || turn.committed) return stage(turn, callRef, name, refused("commit-consumed"));
    const reading = name !== "neurobro_analysis_commit";
    if (reading && turn.readCalls >= 7) return stage(turn, callRef, name, refused("read-call-limit")); if (reading) turn.readCalls++;
    let parsed: Record<string, unknown>;
    try {
      parsed = name === "neurobro_analysis_material" ? fields(value, []) : name === "neurobro_analysis_notes" ? fields(value, ["nodeRef", "position"]) : fields(value, ["output"]);
      if (name === "neurobro_analysis_notes" && (!ref(parsed.nodeRef, "hnode") || parsed.position !== null && (typeof parsed.position !== "string" || !/^hnpos_(?:0|[1-9]\d{0,4})_(?:0|[1-9]\d{0,2})_[0-9a-f]{48}$/u.test(parsed.position)))) return stage(turn, callRef, name, refused("invalid-arguments"));
      if (name === "neurobro_analysis_commit") parsed = { output: snapshotStandingHistoryAnalysisOutput(parsed.output) };
    } catch { return stage(turn, callRef, name, refused("invalid-arguments")); }
    const stopCall = () => { if (current === turn) void finish(); }; callSignal.addEventListener("abort", stopCall, { once: true });
    const pending = Promise.resolve().then(async () => {
      guard(turn); if (callSignal.aborted) return refused("stopped"); await heads(turn);
      if (name === "neurobro_analysis_material") {
        const supports = turn.material.schema === "standing-history-merge-view-v1" ? turn.material.children.flatMap(child => noteSupports(child)) :
          (turn.material.schema === "standing-history-source-fragment-v1" ? [turn.material] : turn.material.fragments)
            .flatMap(fragment => fragment.rows.filter(row => row.disposition === "included").map(row => supportCopy({ sourceRef: row.sourceRef, versionRef: row.versionRef })));
        return stage(turn, callRef, name, result(true, turn.material), Object.freeze(supports), true);
      }
      if (name === "neurobro_analysis_notes") {
        if (turn.material.schema !== "standing-history-merge-view-v1") return stage(turn, callRef, name, refused("child-unavailable"));
        const child = turn.material.children.find(child => child.nodeRef === parsed.nodeRef);
        if (!child) return stage(turn, callRef, name, refused("child-unavailable"));
        const node = await readNode(child.nodeRef); guard(turn); if (!node) return fail();
        const notes = readNodeNotes({ node, referenceKey: referenceKey(), maxBytes: 49152, ...(parsed.position === null ? {} : { position: parsed.position as string }) });
        if (notes.nodeRef !== child.nodeRef || notes.nodeHash !== child.nodeHash) return fail();
        await heads(turn); return stage(turn, callRef, name, result(true, notes), noteSupports(notes));
      }
      if (!turn.materialShown) return stage(turn, callRef, name, refused("material-not-shown"));
      let output: ReturnType<typeof validateStandingHistoryShownOutput>;
      try { output = validateStandingHistoryShownOutput(parsed.output, [...turn.shown.values()]); }
      catch (error) {
        // This exact validation runs before any persistence admission. The model
        // may correct its references within this turn's remaining call budget.
        // Never classify a later prepare/commit failure as safely correctable.
        if (error instanceof StandingHistoryAnalysisStoreError && error.code === "support")
          return stage(turn, callRef, name, refused("unshown-support"));
        throw error;
      }
      // Consume before the first persistence call; an uncertain return must not
      // become a second commit invocation within this native attempt.
      turn.commitStarted = true;
      await prepare({ attemptRef: turn.attemptRef, output }); guard(turn); await heads(turn);
      const node = snapshot(await commitPrepared({ attemptRef: turn.attemptRef })); guard(turn);
      const evidence = fields(node, ["nodeRef", "index", "hash"]);
      if (!ref(evidence.nodeRef, "hnode") || evidence.index !== turn.plan.nodeIndex || !digest(evidence.hash)) return fail();
      turn.committed = true; return stage(turn, callRef, name, result(true, { schema: "neurobro-history-analysis-commit-v1", committed: true, nodeRef: evidence.nodeRef, claimsStatus: "model-authored-unverified" }));
    }).catch(() => stage(turn, callRef, name, refused("unavailable")));
    turn.active = pending;
    try { return await pending; } finally { callSignal.removeEventListener("abort", stopCall); if (turn.active === pending) delete turn.active; }
  }
  return Object.freeze<StandingHistoryAnalysisRuntime>({ specs: ANALYSIS_TOOL_SPECS,
    handlers: Object.freeze(ANALYSIS_TOOL_SPECS.map(spec => Object.freeze({ name: spec.name, call: (value: unknown, scope: EpochToolScope) => call(spec.name, value, scope) }))),
    async begin(value) {
      if (closed || signal.aborted || current) return fail();
      const v = fields(value, ["requestRef", "attemptRef", "plan", "material", "controlHead", "signal"]);
      if (!scopedRef(v.requestRef) || !ref(v.attemptRef, "hattempt") || !digest(v.controlHead) || types.isProxy(v.signal) || !(v.signal instanceof AbortSignal) || v.signal.aborted || usedAttempts.has(v.attemptRef) || usedAttempts.size >= 1024) return fail();
      const plan = snapshot(v.plan) as StandingHistoryAnalysisAttemptPlan, material = materialCopy(v.material);
      if (!digest(plan.sourceHead) || !digest(plan.expectedHead) || !digest(plan.modelInputHash) || !Number.isInteger(plan.nodeIndex) || plan.nodeIndex < 1 || plan.nodeIndex > 1024 || hash(material) !== plan.modelInputHash) return fail();
      if (plan.kind === "leaf") {
        if (material.schema === "standing-history-merge-view-v1" || !Array.isArray(plan.inputs) || plan.inputs.length < 1 || plan.inputs.length > MAX_FRAGMENTS) return fail();
        const fragments = material.schema === "standing-history-source-fragment-v1" ? [material] : material.fragments;
        if (fragments.length !== plan.inputs.length || fragments.some((fragment, index) =>
          plan.inputs[index]!.materialRef !== fragment.materialRef || plan.inputs[index]!.pageIndex !== fragment.pageIndex ||
          fragment.fromDate !== intent.fromDate || fragment.toDate !== intent.toDate ||
          (intent.source ? fragment.sourceRef !== "community" || fragment.sourceInterpretation !== "quoted-source-not-request" :
            Object.hasOwn(fragment, "sourceRef") || Object.hasOwn(fragment, "sourceInterpretation")))) return fail();
      } else if (plan.kind === "merge") {
        if (material.schema !== "standing-history-merge-view-v1" || !Array.isArray(plan.children) || !equalChildren(plan.children, material.children.map(child => child.nodeRef))) return fail();
      } else return fail();
      const turn: Turn = { requestRef: v.requestRef, attemptRef: v.attemptRef, plan, material, controlHead: v.controlHead, signal: v.signal, controller: new AbortController(),
        abort: () => { if (current === turn) void finish(); }, ready: false, calls: 0, readCalls: 0, commitStarted: false, committed: false, materialShown: false, shown: new Map(), pending: new Map(), usedCalls: new Set(), callSignals: new Map() };
      usedAttempts.add(turn.attemptRef); current = turn; turn.signal.addEventListener("abort", turn.abort, { once: true });
      const pending = Promise.resolve().then(async () => {
        await heads(turn); const saved = snapshot(await attemptStatus()); guard(turn);
        if (saved.storage !== "ready" || saved.modelReplayAllowed !== false || !saved.last || saved.last.attemptRef !== turn.attemptRef || saved.last.planHash !== hash(plan) || saved.last.nodeIndex !== plan.nodeIndex || saved.last.prepared || saved.last.node || saved.last.modelOutcome) return fail();
        turn.ready = true;
      });
      turn.active = pending;
      try { await pending; } catch (error) { await finish(); throw error; } finally { if (turn.active === pending) delete turn.active; }
    },
    onToolResultSent(value) {
      const v = fields(value, ["requestRef", "callRef", "name", "result"]), turn = current;
      if (!turn || !turn.ready || v.requestRef !== turn.requestRef || !scopedRef(v.callRef) || typeof v.name !== "string") return fail(); guard(turn);
      const pending = turn.pending.get(v.callRef), output = snapshot(v.result, ANALYSIS_TOOL_RESULT_BYTES) as EpochToolResult;
      fields(output, ["success", "contentItems"]);
      if (!pending || turn.callSignals.get(v.callRef)?.aborted || pending.name !== v.name || pending.resultHash !== hash(output)) return fail();
      if (pending.acknowledged) return;
      const shown = new Map(turn.shown); if (output.success) for (const support of pending.supports) shown.set(supportKey(support), support);
      if (shown.size > MAX_SUPPORTS) return fail();
      turn.shown = shown; pending.acknowledged = true; if (output.success && pending.material) turn.materialShown = true;
    }, finish,
    async close() { closed = true; await finish(); usedAttempts.clear(); signal.removeEventListener("abort", abort); }
  });
}
function equalChildren(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((ref, i) => ref === b[i]); }
