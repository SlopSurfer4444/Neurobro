import test from "node:test";
import assert from "node:assert/strict";
import { createStandingCommunityAssessmentPort, type StandingCommunityAssessmentConnection, type StandingCommunityAssessmentLease,
  type StandingCommunityAssessmentNativeBinding, type StandingCommunityAssessmentSettlement } from "../src/standing-community-assessment-port.js";
import { openStandingScopedEpochSession, type CompletedCommunityAssessmentTurn } from "../src/standing-scoped-epoch-session.js";
const ref = "assessment-1", observation = "obs_" + "ab".repeat(12);
const body = (requestRef = ref) => JSON.stringify({ schema: "community-assessment-v1", assessmentRef: requestRef, policyRevision: 1, guidance: "Assess these observations",
  observations: [{ ref: observation, date: 100, displayName: "Synthetic", text: "Untrusted source", truncated: false, media: { kind: "none", pixelsProvided: false } }], recentAlertSummary: "" });
const binding = (requestRef = ref): StandingCommunityAssessmentNativeBinding => ({ epochId: "a".repeat(32), requestRef, purpose: "community-assessment" });
const proof = (requestRef = ref): StandingCommunityAssessmentSettlement => ({ schema: "standing-community-assessment-owner-settlement-v1", nativeBinding: binding(requestRef),
  resourcesSettled: true, persisted: true, replacementReady: true, modelOutcome: "not-proven" });
const completed = (requestRef = ref): CompletedCommunityAssessmentTurn => ({ kind: "community-assessment", scope: { ...binding(requestRef), threadId: "thread-m", turnId: "turn-1", turnNumber: 1, threadTurnNumber: 1 },
  decision: { decision: "alert", caseKey: observation, answer: "Synthetic alert" }, toolCalls: 0, toolRefusals: 0 });
const deferred = <T = void>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(r => setImmediate(r));
const error = (code: string) => Object.assign(new Error("private native details"), { code });
const code = (expected: string) => (value: unknown) => value instanceof Error && "code" in value && value.code === expected && !value.message.includes("private") && value.cause === undefined;
function fixture() {
  const global = new AbortController(), call = new AbortController(), events: string[] = [];
  let currentRef = ref;
  const lease: StandingCommunityAssessmentLease = { nativeBinding: binding(),
    async turnCommunityAssessment(requestRef, input) { events.push("turn"); assert.equal(requestRef, currentRef); assert.equal(input, body(currentRef)); return completed(currentRef); },
    async releaseCommunityAssessment(requestRef) { assert.equal(requestRef, currentRef); events.push("release"); },
    async abortAndJoin() { events.push("abort"); return proof(currentRef); }, async close() { events.push("close"); } };
  const connection: StandingCommunityAssessmentConnection = { async prepare() { events.push("prepare"); return { restoration: false }; },
    async acquireCommunityAssessmentAdmission(requestRef) { events.push("acquire"); currentRef = requestRef; return { ...lease, nativeBinding: binding(requestRef) }; },
    async verifyCommunityAssessmentSettlement(value) { events.push("verify"); return proof(value.requestRef); } };
  return { global, call, events, lease, connection, open: () => createStandingCommunityAssessmentPort(connection, global.signal) };
}

test("successful assessment validates and releases then closes only its lease, keeping connection reusable", async () => {
  const f = fixture(), port = f.open();
  assert.deepEqual(await port.assess(ref, body(), f.call.signal), completed().decision);
  assert.deepEqual(await port.assess("assessment-2", body("assessment-2"), f.call.signal), completed().decision);
  assert.deepEqual(f.events, ["prepare", "acquire", "turn", "release", "close", "prepare", "acquire", "turn", "release", "close"]);
  await port.close(); await assert.rejects(port.assess(ref, body(), f.call.signal), code("CLOSED"));
});

test("input and capability refusal is inert and happens before preparation", async () => {
  const f = fixture(), port = f.open();
  for (const input of ["{}", body("foreign"), body().replace('"policyRevision":1', '"policyRevision":1,"policyRevision":2')])
    await assert.rejects(port.assess(ref, input, f.call.signal), code("INPUT"));
  await assert.rejects(port.assess(ref, body(), {} as AbortSignal), code("INPUT"));
  let called = 0; const hostile = Object.defineProperty({ ...f.connection }, "prepare", { get() { called++; throw Error(); }, enumerable: true });
  assert.throws(() => createStandingCommunityAssessmentPort(hostile, f.global.signal), code("INPUT"));
  assert.equal(called, 0); assert.deepEqual(f.events, []); await port.close();
});

test("per-call and global cancellation and port close actively abort held turns and wait for joined proof", async () => {
  for (const mode of ["call", "global", "close"]) {
    const f = fixture(), entered = deferred(), turn = deferred<CompletedCommunityAssessmentTurn>(), joined = deferred<StandingCommunityAssessmentSettlement>();
    let aborts = 0;
    Object.assign(f.lease, { async turnCommunityAssessment() { entered.resolve(); return turn.promise; }, async abortAndJoin() { aborts++; return joined.promise; } });
    const port = f.open(), pending = port.assess(ref, body(), f.call.signal); let finished = false;
    const refused = assert.rejects(pending, code("CANCELLED")).then(() => { finished = true; }); await entered.promise;
    await assert.rejects(port.assess("second", body("second"), f.call.signal), code("BUSY"));
    const closing = mode === "close" ? port.close() : undefined;
    if (mode === "call") f.call.abort(); if (mode === "global") f.global.abort();
    await tick(); assert.equal(aborts, 1); assert.equal(finished, false); assert.equal(f.events.includes("close"), false);
    turn.reject(Error("private abort")); joined.resolve(proof()); await refused; await closing;
    assert.equal(f.events.filter(v => v === "close").length, 1); assert.equal(f.events.includes("release"), false); await port.close();
  }
});

test("unknown physical settlement remains fatal without waiting for a permanently stuck turn", async () => {
  const f = fixture(), entered = deferred(), stuck = new Promise<CompletedCommunityAssessmentTurn>(() => {});
  Object.assign(f.lease, { async turnCommunityAssessment() { entered.resolve(); return stuck; }, async abortAndJoin() { throw error("SETTLEMENT_UNKNOWN"); } });
  const port = f.open(), pending = port.assess(ref, body(), f.call.signal), refused = assert.rejects(pending, code("SETTLEMENT_UNKNOWN"));
  await entered.promise; f.call.abort(); await refused;
  await assert.rejects(port.assess("new", body("new"), new AbortController().signal), code("SETTLEMENT_UNKNOWN"));
  await assert.rejects(port.close(), code("SETTLEMENT_UNKNOWN")); assert.equal(f.events.filter(v => v === "close").length, 1);
});

test("joined runtime timeout preserves its code and closes lease before another fresh assessment", async () => {
  const f = fixture(); let first = true;
  Object.assign(f.lease, { async turnCommunityAssessment(requestRef: string) { if (first) { first = false; throw error("COMMUNITY_ASSESSMENT_TIMEOUT"); } return completed(requestRef); } });
  const port = f.open(); await assert.rejects(port.assess(ref, body(), f.call.signal), code("COMMUNITY_ASSESSMENT_TIMEOUT"));
  assert.deepEqual(f.events, ["prepare", "acquire", "abort", "close"]);
  assert.deepEqual(await port.assess("fresh", body("fresh"), f.call.signal), completed().decision); await port.close();
});

test("malformed completion, foreign purpose and unshown decision refuse before release and join actual owner", async () => {
  for (const patch of [ { kind: "analysis" }, { scope: { ...completed().scope, purpose: "history-analysis" } }, { scope: { ...completed().scope, epochId: "b".repeat(32) } },
    { scope: { ...completed().scope, requestRef: "other" } }, { toolCalls: 1 }, { toolRefusals: 1 }, { decision: { decision: "alert", caseKey: "obs_" + "cd".repeat(12), answer: "alert" } } ]) {
    const f = fixture(); Object.assign(f.lease, { async turnCommunityAssessment() { return { ...completed(), ...patch }; } });
    const port = f.open(); await assert.rejects(port.assess(ref, body(), f.call.signal));
    assert.deepEqual(f.events, ["prepare", "acquire", "abort", "close"]); await port.close();
  }
});

test("void owner join requires exact persisted proof; malformed or foreign proof is fatal", async () => {
  for (const mode of ["valid", "foreign", "unsettled"]) {
    const f = fixture(); Object.assign(f.lease, { async turnCommunityAssessment() { throw Error("private native"); }, async abortAndJoin() { f.events.push("abort"); } });
    Object.assign(f.connection, { async verifyCommunityAssessmentSettlement() { f.events.push("verify"); return mode === "valid" ? proof() : mode === "foreign" ? proof("other") : { ...proof(), replacementReady: false }; } });
    const port = f.open(); await assert.rejects(port.assess(ref, body(), f.call.signal), code(mode === "valid" ? "FAILED" : "SETTLEMENT_UNKNOWN"));
    assert.deepEqual(f.events, ["prepare", "acquire", "abort", "verify", "close"]);
    if (mode === "valid") await port.close(); else await assert.rejects(port.close(), code("SETTLEMENT_UNKNOWN"));
  }
});

test("cancellation during acquisition joins the late lease without dispatching its turn", async () => {
  const f = fixture(), entered = deferred(), acquire = deferred<StandingCommunityAssessmentLease>();
  Object.assign(f.connection, { async acquireCommunityAssessmentAdmission() { entered.resolve(); return acquire.promise; } });
  const port = f.open(), pending = port.assess(ref, body(), f.call.signal), refused = assert.rejects(pending, code("CANCELLED"));
  await entered.promise; f.call.abort(); acquire.resolve(f.lease); await refused;
  assert.deepEqual(f.events, ["prepare", "abort", "close"]); await port.close();
});

test("cancel during release suppresses decision and awaits owner settlement; release failure is never success", async () => {
  for (const cancel of [true, false]) {
    const f = fixture(), entered = deferred(), release = deferred(), joined = deferred<StandingCommunityAssessmentSettlement>();
    Object.assign(f.lease, { async releaseCommunityAssessment() { entered.resolve(); return release.promise; }, async abortAndJoin() { f.events.push("abort"); return joined.promise; } });
    const port = f.open(), pending = port.assess(ref, body(), f.call.signal), refused = assert.rejects(pending, code(cancel ? "CANCELLED" : "FAILED"));
    await entered.promise; if (cancel) f.call.abort(); release.reject(Error("private release")); await tick();
    assert.ok(f.events.includes("abort")); assert.equal(f.events.includes("close"), false); joined.resolve(proof()); await refused; await port.close();
  }
});

test("cancel during a released lease close joins that close without aborting an already closed warm lease", async () => {
  const f = fixture(), entered = deferred(), releaseClose = deferred();
  Object.assign(f.lease, { async close() { f.events.push("close"); entered.resolve(); await releaseClose.promise; } });
  const port = f.open(), pending = port.assess(ref, body(), f.call.signal), refused = assert.rejects(pending, code("CANCELLED"));
  await entered.promise; f.call.abort(); await tick(); assert.equal(f.events.includes("abort"), false); releaseClose.resolve(); await refused; await port.close();
});

test("malformed admitted lease still invokes available cleanup and fails closed", async () => {
  const f = fixture(); Object.assign(f.connection, { async acquireCommunityAssessmentAdmission() { return { ...f.lease, nativeBinding: { ...binding(), purpose: "conversation" } }; } });
  const port = f.open(); await assert.rejects(port.assess(ref, body(), f.call.signal), code("SETTLEMENT_UNKNOWN"));
  assert.deepEqual(f.events, ["prepare", "abort", "close"]); await assert.rejects(port.close(), code("SETTLEMENT_UNKNOWN"));
});

test("lease-close failure and runtime SETTLEMENT_UNKNOWN cannot be downgraded to an ordinary failure", async () => {
  for (const unknownTurn of [false, true]) {
    const f = fixture();
    if (unknownTurn) Object.assign(f.lease, { async turnCommunityAssessment() { throw error("SETTLEMENT_UNKNOWN"); } });
    else Object.assign(f.lease, { async close() { throw Error("private close"); } });
    const port = f.open(); await assert.rejects(port.assess(ref, body(), f.call.signal), code("SETTLEMENT_UNKNOWN")); await assert.rejects(port.close(), code("SETTLEMENT_UNKNOWN"));
  }
});

test("fulfilled undefined acquisition is unknown admission, unlike a rejected acquisition", async () => {
  for (const fulfilled of [false, true]) {
    const f = fixture(); Object.assign(f.connection, { async acquireCommunityAssessmentAdmission() {
      if (fulfilled) return undefined; throw Error("private refused admission");
    } });
    const port = f.open(); await assert.rejects(port.assess(ref, body(), f.call.signal), code(fulfilled ? "SETTLEMENT_UNKNOWN" : "FAILED"));
    if (fulfilled) {
      await assert.rejects(port.assess("new", body("new"), f.call.signal), code("SETTLEMENT_UNKNOWN"));
      await assert.rejects(port.close(), code("SETTLEMENT_UNKNOWN"));
    } else await port.close();
    assert.deepEqual(f.events, ["prepare"]);
  }
});

test("actual scoped-v2 session completion and release cross the port without tools or a native close", async () => {
  const frames: unknown[] = [{ kind: "ready", protocol: "standing-scoped-epoch-v2", scopes: [{ purpose: "conversation", tools: ["neurobro_read_history"] },
    { purpose: "history-analysis", tools: ["neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit"] }, { purpose: "community-assessment", tools: [] }] }];
  const sent: Record<string, unknown>[] = [], global = new AbortController();
  const session = await openStandingScopedEpochSession({ epochId: binding().epochId, sessionMode: "standing-scoped-epoch-v2", signal: global.signal, custodyReady: () => true,
    wire: { async send(value) { const frame = value as Record<string, unknown>; sent.push(frame);
      if (frame.kind === "turn") { const scope = { purpose: frame.purpose, requestRef: frame.requestRef, threadId: "thread-m", turnId: "turn-1", turnNumber: 1, threadTurnNumber: 1 };
        frames.push({ kind: "scope", scope }, { kind: "completed", scope, answer: JSON.stringify(completed().decision), kindOfAnswer: "text", toolCalls: 0, toolRefusals: 0 }); }
      if (frame.kind === "release") frames.push({ kind: "released", purpose: frame.purpose, requestRef: frame.requestRef, delivery: frame.delivery });
    }, async receive() { if (!frames.length) throw Error("unexpected read"); return frames.shift(); } },
    conversation: { history: { async call() { throw Error("no tools"); } } }, onToolResultSent() { throw Error("no tools"); },
    analysisTools: ["neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit"].map(name => ({ name, async call() { throw Error("no tools"); } })) });
  let closes = 0;
  const port = createStandingCommunityAssessmentPort({ async prepare() { return { restoration: false }; }, async acquireCommunityAssessmentAdmission() {
    return { nativeBinding: binding(), turnCommunityAssessment: session.turnCommunityAssessment, releaseCommunityAssessment: session.releaseCommunityAssessment,
      async abortAndJoin() { throw Error("successful release must keep owner warm"); }, async close() { closes++; } }; }, async verifyCommunityAssessmentSettlement() { throw Error("no owner shutdown"); } }, global.signal);
  assert.deepEqual(await port.assess(ref, body(), global.signal), completed().decision); await port.close();
  assert.equal(closes, 1); assert.deepEqual(sent.map(v => [v.kind, v.purpose, v.delivery]), [["turn", "community-assessment", undefined], ["release", "community-assessment", "not-sent"]]);
  assert.equal(session.admission(), "ready"); global.abort();
});
