import { types } from "node:util";
import { STANDING_OBSERVED_SOURCE_TEXT_BYTES, type StandingObservedSourceItem } from "./standing-observed-source-reader.js";

export type StandingCommunityAssessmentInput = Readonly<{
  schema: "community-assessment-v1"; assessmentRef: string; policyRevision: number;
  guidance: string; observations: readonly StandingObservedSourceItem[]; recentAlertSummary: string;
}>;
export type StandingCommunityAssessmentDecision = Readonly<{ decision: "silent"; caseKey: null; answer: null }> |
  Readonly<{ decision: "alert"; caseKey: string; answer: string }>;
export const STANDING_COMMUNITY_ASSESSMENT_INPUT_BYTES = 24576;
export const STANDING_COMMUNITY_ASSESSMENT_RESULT_BYTES = 8192;
export class StandingCommunityAssessmentContractError extends Error {
  constructor() { super("STANDING_COMMUNITY_ASSESSMENT_REFUSED"); }
}
const fail = (): never => { throw new StandingCommunityAssessmentContractError(); };
const ref = (value: unknown): value is string => typeof value === "string" && /^obs_[0-9a-f]{24}$/u.test(value);
const date = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 253402300799;
function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= limit && Buffer.from(value).toString("utf8") === value && !value.includes("\0");
}
const label = (value: unknown, limit: number): value is string => text(value, limit) && value.length > 0 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(key => !Object.hasOwn(ds, key)) || keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key)) ||
      Object.values(ds).some(d => !("value" in d) || !d.enumerable)) return fail();
  return Object.fromEntries(Object.entries(ds).map(([key, d]) => [key, d.value]));
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 30 || Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const d = Object.getOwnPropertyDescriptor(value, String(index)); if (!d || !("value" in d) || !d.enumerable) return fail(); return d.value;
  });
}
function observation(value: unknown): StandingObservedSourceItem {
  const item = record(value, ["ref", "date", "displayName", "text", "truncated", "media"], ["forwarded"]);
  if (!ref(item.ref) || !date(item.date) || !label(item.displayName, 128) || !text(item.text, STANDING_OBSERVED_SOURCE_TEXT_BYTES) ||
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(item.text) || typeof item.truncated !== "boolean") return fail();
  const media = record(item.media, ["kind", "pixelsProvided"]);
  if (!["none", "photo", "document", "poll", "other"].includes(media.kind as string) || media.pixelsProvided !== false) return fail();
  let forwarded: StandingObservedSourceItem["forwarded"];
  if (Object.hasOwn(item, "forwarded")) {
    const f = record(item.forwarded, ["originalDate", "sourceName", "interpretation"]);
    if (!date(f.originalDate) || !(f.sourceName === null || label(f.sourceName, 128) && f.sourceName.trim() === f.sourceName) || f.interpretation !== "quoted-source-not-request") return fail();
    forwarded = Object.freeze(f) as StandingObservedSourceItem["forwarded"];
  }
  return Object.freeze({ ...item, media: Object.freeze(media), ...(forwarded ? { forwarded } : {}) }) as StandingObservedSourceItem;
}

/** Copies inert host-selected observations. This validates shape and bounds,
 * not source authenticity or authority; the observer owns source provenance. */
export function snapshotStandingCommunityAssessmentInput(value: unknown): StandingCommunityAssessmentInput {
  const v = record(value, ["schema", "assessmentRef", "policyRevision", "guidance", "observations", "recentAlertSummary"]);
  if (v.schema !== "community-assessment-v1" || typeof v.assessmentRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v.assessmentRef) ||
      !Number.isSafeInteger(v.policyRevision) || Number(v.policyRevision) < 1 || !text(v.guidance, 2048) || !text(v.recentAlertSummary, 4096)) return fail();
  const observations = array(v.observations).map(observation);
  if (new Set(observations.map(item => item.ref)).size !== observations.length) return fail();
  const result = Object.freeze({ ...v, observations: Object.freeze(observations) }) as StandingCommunityAssessmentInput;
  if (Buffer.byteLength(JSON.stringify(result)) > STANDING_COMMUNITY_ASSESSMENT_INPUT_BYTES) return fail(); return result;
}
function json(value: unknown, limit: number): unknown {
  if (!text(value, limit)) return fail();
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { return fail(); }
  // Colons outside JSON strings count every object entry. Comparing to the
  // parsed tree rejects duplicate keys, including nested escaped-key aliases.
  let entries = 0; const pending: unknown[] = [parsed];
  while (pending.length) {
    const current = pending.pop(); if (!current || typeof current !== "object") continue;
    const children = Object.values(current); if (!Array.isArray(current)) entries += children.length;
    pending.push(...children);
  }
  if ((value.match(/"(?:\\.|[^"\\])*"|:/gs) ?? []).filter(token => token === ":").length !== entries) return fail(); return parsed;
}
export function parseStandingCommunityAssessmentInput(body: string, requestRef?: string): StandingCommunityAssessmentInput {
  const result = snapshotStandingCommunityAssessmentInput(json(body, STANDING_COMMUNITY_ASSESSMENT_INPUT_BYTES));
  if (requestRef !== undefined && result.assessmentRef !== requestRef) return fail(); return result;
}
export function parseStandingCommunityAssessmentDecision(body: string, input: StandingCommunityAssessmentInput): StandingCommunityAssessmentDecision {
  const v = record(json(body, STANDING_COMMUNITY_ASSESSMENT_RESULT_BYTES), ["decision", "caseKey", "answer"]);
  if (v.decision === "silent" && v.caseKey === null && v.answer === null) return Object.freeze(v) as StandingCommunityAssessmentDecision;
  if (v.decision !== "alert" || !ref(v.caseKey) || !input.observations.some(item => item.ref === v.caseKey) ||
      !text(v.answer, 3500) || !v.answer.trim() || v.answer.trim() !== v.answer) return fail();
  return Object.freeze(v) as StandingCommunityAssessmentDecision;
}
