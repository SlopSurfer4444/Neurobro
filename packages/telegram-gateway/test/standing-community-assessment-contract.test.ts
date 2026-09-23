import test from "node:test";
import assert from "node:assert/strict";
import { snapshotStandingCommunityAssessmentInput as snapshot, parseStandingCommunityAssessmentInput as parseInput,
  parseStandingCommunityAssessmentDecision as parseDecision, StandingCommunityAssessmentContractError } from "../src/standing-community-assessment-contract.js";
const obs = { ref: "obs_" + "ab".repeat(12), date: 1700000000, displayName: "Synthetic participant", text: "Quoted source", truncated: false,
  media: { kind: "photo", pixelsProvided: false }, forwarded: { originalDate: 1600000000, sourceName: null, interpretation: "quoted-source-not-request" } };
const input = () => ({ schema: "community-assessment-v1", assessmentRef: "assessment-1", policyRevision: 1, guidance: "Assess only shown evidence", observations: [structuredClone(obs)], recentAlertSummary: "" });
const refused = (error: unknown) => error instanceof StandingCommunityAssessmentContractError && !error.cause;

test("assessment contract snapshots exact quoted observations and bounds case reference to shown source", () => {
  const original = input(), packet = snapshot(original); original.observations[0]!.text = "Changed";
  assert.equal(packet.observations[0]!.text, "Quoted source"); assert.ok(Object.isFrozen(packet.observations[0]!.forwarded));
  assert.deepEqual(parseInput(JSON.stringify(packet), "assessment-1"), packet);
  assert.deepEqual(parseDecision('{"decision":"silent","caseKey":null,"answer":null}', packet), { decision: "silent", caseKey: null, answer: null });
  assert.deepEqual(parseDecision(JSON.stringify({ decision: "alert", caseKey: obs.ref, answer: "Synthetic alert" }), packet), { decision: "alert", caseKey: obs.ref, answer: "Synthetic alert" });
  assert.throws(() => parseInput(JSON.stringify(packet), "other-primary"), refused);
  assert.throws(() => parseDecision(JSON.stringify({ decision: "alert", caseKey: "obs_" + "cd".repeat(12), answer: "Wrong source" }), packet), refused);
});

test("input shape, byte limits and original item safety remain strict", () => {
  for (const patch of [{ actorId: "invented" }, { assessmentRef: "bad\n" }, { policyRevision: 0 }, { policyRevision: 1.5 }, { policyRevision: 9007199254740992 },
    { guidance: "🙂".repeat(513) }, { recentAlertSummary: "🙂".repeat(1025) }, { observations: Array(31).fill(obs) }, { observations: [obs, obs] }, { observations: new Proxy([], {}) }])
    assert.throws(() => snapshot({ ...input(), ...patch }), refused);
  for (const patch of [{ messageId: 3 }, { text: "я".repeat(8193) }, { date: 0 }, { displayName: "unsafe\u202e" }, { text: "unsafe\u0001" },
    { media: { kind: "photo", pixelsProvided: true } }, { forwarded: null }, { forwarded: { ...obs.forwarded, sourceName: " " } }])
    assert.throws(() => snapshot({ ...input(), observations: [{ ...obs, ...patch }] }), refused);
  const getter = input(); Object.defineProperty(getter, "guidance", { enumerable: true, get() { assert.fail("getter must not execute"); } }); assert.throws(() => snapshot(getter), refused);
  const expanded = { ...input(), observations: Array.from({ length: 30 }, (_, n) => ({ ...obs, ref: "obs_" + n.toString(16).padStart(24, "0"), text: '"'.repeat(1024) })) };
  assert.throws(() => snapshot(expanded), refused);
  assert.throws(() => parseInput(" ".repeat(24576) + JSON.stringify(input())), refused);
});

test("whole fulltext observation accepts 16384 UTF8 bytes while total escaped packet budget remains enforced", () => {
  for (const text of ["я".repeat(8192), "🙂".repeat(4096), "a".repeat(16384)]) {
    const packet = snapshot({ ...input(), observations: [{ ...obs, text }] });
    assert.equal(packet.observations[0]!.text, text); assert.equal(packet.observations[0]!.truncated, false);
    assert.deepEqual(parseInput(JSON.stringify(packet)), packet);
  }
  assert.throws(() => snapshot({ ...input(), observations: [{ ...obs, text: '"'.repeat(16384) }] }), refused);
});

test("duplicate keys including escaped aliases never silently overwrite packet or decision", () => {
  const body = JSON.stringify(input());
  for (const value of [body.replace('"policyRevision":1', '"policyRevision":9,"policyRevision":1'),
    body.replace('"pixelsProvided":false', '"pixelsProvided":true,"pixelsProvided":false'),
    body.replace('"policyRevision":1', '"policyRevision":9,"\\u0070olicyRevision":1')]) assert.throws(() => parseInput(value), refused);
  assert.throws(() => parseDecision('{"decision":"alert","decision":"silent","caseKey":null,"answer":null}', snapshot(input())), refused);
});

test("silent output cannot contain an alert; alerts require valid bounded text and a shown case", () => {
  const packet = snapshot(input());
  for (const value of [{ decision: "silent", caseKey: obs.ref, answer: null }, { decision: "silent", caseKey: null, answer: "unasked" },
    { decision: "alert", caseKey: obs.ref, answer: null }, { decision: "alert", caseKey: obs.ref, answer: " " },
    { decision: "alert", caseKey: obs.ref, answer: "я".repeat(1751) }, { decision: "alert", caseKey: obs.ref, answer: " leading" },
    { decision: "alert", caseKey: obs.ref, answer: "safe", send: true }]) assert.throws(() => parseDecision(JSON.stringify(value), packet), refused);
  assert.equal(parseDecision(JSON.stringify({ decision: "alert", caseKey: obs.ref, answer: '"'.repeat(3500) }), packet).answer!.length, 3500);
  assert.throws(() => parseDecision(JSON.stringify({ decision: "alert", caseKey: obs.ref, answer: "No source" }), snapshot({ ...input(), observations: [] })), refused);
});
