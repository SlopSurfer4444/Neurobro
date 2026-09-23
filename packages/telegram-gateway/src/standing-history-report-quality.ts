import { createHash } from "node:crypto";
import { types } from "node:util";

export type StandingHistoryReportReview = Readonly<{
  candidateHash: string;
  verdict: "accepted" | "revise";
  findings: readonly Readonly<{ dimension: "objective" | "evidence" | "coverage" | "readability"; problem: string; correction: string }>[];
}>;
export const standingHistoryReportBodyHash = (body: string): string => createHash("sha256").update(JSON.stringify(body)).digest("hex");
// Six findings, two UTF8-bounded fields each, worst-case JSON escaping plus fixed metadata.
export const REPORT_REVIEW_SERIALIZED_BYTES = 6 * 2 * 1024 * 6 + 1024;
const invalid = (): never => { throw new Error("STANDING_HISTORY_REPORT_REVIEW_INPUT"); };
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k))) return invalid();
  return Object.fromEntries(own.map(k => { const d = descriptors[k as string]!; if (!d.enumerable || !("value" in d)) return invalid(); return [k, d.value]; }));
}
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && !v.includes("\0") && Buffer.byteLength(v) <= 1024 && Buffer.from(v).toString() === v;
/** Semantic judgment belongs to a separate model turn. This validates its
 * exact candidate binding and actionable feedback, not factual correctness. */
export function snapshotStandingHistoryReportReview(value: unknown, expectedHash?: string): StandingHistoryReportReview {
  const v = fields(value, ["candidateHash", "verdict", "findings"]);
  if (typeof v.candidateHash !== "string" || !/^[0-9a-f]{64}$/.test(v.candidateHash) || expectedHash !== undefined && v.candidateHash !== expectedHash ||
      !["accepted", "revise"].includes(v.verdict as string) || !Array.isArray(v.findings) || types.isProxy(v.findings) || v.findings.length > 6 ||
      (v.verdict === "accepted" ? v.findings.length !== 0 : v.findings.length === 0)) return invalid();
  const findings = v.findings.map(value => { const f = fields(value, ["dimension", "problem", "correction"]);
    if (!["objective", "evidence", "coverage", "readability"].includes(f.dimension as string) || !text(f.problem) || !text(f.correction)) return invalid();
    return Object.freeze({ dimension: f.dimension as StandingHistoryReportReview["findings"][number]["dimension"], problem: f.problem, correction: f.correction }); });
  const review = Object.freeze({ candidateHash: v.candidateHash, verdict: v.verdict as StandingHistoryReportReview["verdict"], findings: Object.freeze(findings) });
  if (Buffer.byteLength(JSON.stringify(review)) > REPORT_REVIEW_SERIALIZED_BYTES) return invalid();
  return review;
}

export const STANDING_HISTORY_REPORT_REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, properties: {
    candidateHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    verdict: { type: "string", enum: ["accepted", "revise"] },
    findings: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, properties: {
      dimension: { type: "string", enum: ["objective", "evidence", "coverage", "readability"] },
      problem: { type: "string", minLength: 1, maxLength: 1024 }, correction: { type: "string", minLength: 1, maxLength: 1024 },
    }, required: ["dimension", "problem", "correction"] } },
  }, required: ["candidateHash", "verdict", "findings"],
};
