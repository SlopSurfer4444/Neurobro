import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { projectStandingSharedContext, requireStandingSharedContextSnapshot,
  type StandingSharedContextInput, type StandingSharedObservation, type StandingSharedTask } from "../src/standing-shared-context.js";
import { projectStandingOwnAction, type StandingOwnActionView } from "../src/standing-own-action-projection.js";
import { runPilotReply, type PilotRecord } from "../src/pilot-outbox.js";

const ref = (n: number, prefix = "src") => prefix + "_" + n.toString(16).padStart(48, "0");
const speakerRef = "a_" + "1".repeat(24);
const available = { availability: "available", freshness: "current", scanned: 0, hasMore: false, omittedAtSource: 0 } as const;
const empty = () => ({ items: [], coverage: { ...available } });
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const v = value as Record<string, unknown>;
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
function observation(n = 1, text = "Observed group discussion"): StandingSharedObservation {
  return { kind: "observed-message", sourceRef: ref(n), versionRef: ref(n, "ver"), observedAt: 100, speakerRef, text };
}
function input(): StandingSharedContextInput {
  return { scope: { scopeRef: ref(1, "scope"), audience: { kind: "group" } }, asOf: 200,
    chronicle: empty(), dialogues: empty(), ownActions: empty(), tasks: empty() };
}
function taskState(): StandingSharedTask {
  return { kind: "task-state", sourceRef: ref(5), versionRef: ref(5, "ver"), observedAt: 100,
    taskRef: ref(5, "htask"), control: "queued", read: "complete", analysis: "committed",
    outputPrepared: true, nodeCommitted: true, modelOutcome: "unknown", delivery: "not-attempted", disposition: "none" };
}

test("quoted forwarded observations survive exact projection but cannot become explicit preferences", () => {
  const forwarded = { originalDate: 90, sourceName: "Outside author", interpretation: "quoted-source-not-request" as const };
  const m = { ...observation(), forwarded };
  const source = { ...input(), chronicle: { items: [m], coverage: available } };
  const snapshot = projectStandingSharedContext(source), projected = snapshot.items[0]!.evidence as StandingSharedObservation;
  assert.deepEqual(projected, m); assert.equal(Object.isFrozen(projected.forwarded), true);
  assert.notEqual(snapshot.revisionRef, projectStandingSharedContext({ ...source,
    chronicle: { items: [{ ...m, forwarded: { ...forwarded, sourceName: null } }], coverage: available } }).revisionRef);
  forwarded.sourceName = "Changed outside snapshot";
  assert.equal(projected.forwarded!.sourceName, "Outside author");
  assert.throws(() => projectStandingSharedContext({ ...source,
    chronicle: { items: [{ ...m, kind: "explicit-preference" }], coverage: available } }));
  let called = false;
  const hostile = { ...forwarded, get sourceName() { called = true; return "Outside author"; } };
  for (const bad of [null, { ...forwarded, interpretation: "participant-request" }, { ...forwarded, originalDate: 0 },
    { ...forwarded, originalDate: 253402300800 }, { ...forwarded, sourceName: " " }, { ...forwarded, sourceName: "x".repeat(129) },
    { ...forwarded, sourceName: "author\u202e" }, { ...forwarded, authority: "team" }, hostile]) {
    assert.throws(() => projectStandingSharedContext({ ...source,
      chronicle: { items: [{ ...m, forwarded: bad }], coverage: available } } as unknown as StandingSharedContextInput));
  }
  assert.equal(called, false);
});

test("unavailable task records remain unknown rather than asserting that no output or node exists", () => {
  const unknown: StandingSharedTask = { ...taskState(), outputPrepared: "unavailable", nodeCommitted: "unavailable",
    analysis: "unavailable", modelOutcome: "unavailable", delivery: "unavailable" };
  const source = { ...input(), tasks: { items: [unknown], coverage: available } };
  const snapshot = projectStandingSharedContext(source);
  assert.deepEqual(snapshot.items[0]!.evidence, unknown);
  const knownAbsent = projectStandingSharedContext({ ...source, tasks: { items: [{ ...unknown, outputPrepared: false, nodeCommitted: false }], coverage: available } });
  assert.notEqual(snapshot.revisionRef, knownAbsent.revisionRef);
  assert.throws(() => projectStandingSharedContext({ ...source, tasks: { items: [{ ...unknown, outputPrepared: null }], coverage: available } } as unknown as StandingSharedContextInput));
});

test("task purpose survives whole with range and source validation instead of opaque-reference-only recall", () => {
  const description = { objective: "Собрать решения за три дня", fromDate: 100, toDate: 200, timezone: "Europe/Moscow" };
  const source = { ...input(), tasks: { items: [{ ...taskState(), description }], coverage: available } };
  const snapshot = projectStandingSharedContext(source);
  assert.deepEqual((snapshot.items[0]!.evidence as StandingSharedTask).description, description);
  const changed = projectStandingSharedContext({ ...source, tasks: { items: [{ ...taskState(), description: { ...description, objective: "Другая задача" } }], coverage: available } });
  assert.notEqual(snapshot.revisionRef, changed.revisionRef);
  assert.throws(() => projectStandingSharedContext({ ...source, tasks: { items: [{ ...taskState(), description: { ...description, timezone: "unknown-zone" } }], coverage: available } }));
  assert.throws(() => projectStandingSharedContext({ ...source, tasks: { items: [{ ...taskState(), description: { ...description, toDate: 90 } }], coverage: available } }));
});
test("same immutable snapshot feeds both consumers, with exact included-content revision", () => {
  const source = { ...input(), chronicle: { items: [observation()], coverage: available } };
  const responseView = projectStandingSharedContext(source);
  const initiativeView = requireStandingSharedContextSnapshot(responseView);
  assert.equal(responseView, initiativeView);
  const { revisionRef, ...body } = responseView;
  assert.equal(revisionRef, "sctx_" + createHash("sha256").update(canonical(body)).digest("hex"));
  assert.equal(responseView.completeChat, false);
  assert.equal(responseView.initiativeEligibility, "not-evaluated");
  assert.equal(responseView.coverage.chronicle.scope, "observations-only");
  assert.equal(responseView.coverage.dialogues.scope, "selected-dialogues");
  assert.equal(responseView.coverage.tasks.scope, "selected-task-statuses");
  assert.deepEqual(projectStandingSharedContext(source), responseView);
  assert.throws(() => requireStandingSharedContextSnapshot(JSON.parse(JSON.stringify(responseView))));
  assert.throws(() => { (responseView.items[0]!.evidence as {text:string}).text = "changed"; });
  (source.chronicle.items[0] as {text:string}).text = "source edited after snapshot";
  assert.equal((responseView.items[0]!.evidence as StandingSharedObservation).text, "Observed group discussion");
});

test("task source label survives bounded shared memory while routing fields refuse",()=>{
  const description={objective:"Month report",fromDate:100,toDate:200,timezone:"UTC",source:"community" as const};
  const source={...input(),tasks:{items:[{...taskState(),description}],coverage:available}};
  const snapshot=projectStandingSharedContext(source);
  assert.equal((snapshot.items[0]!.evidence as StandingSharedTask).description?.source,"community");
  for(const bad of [{...description,source:"elsewhere"},{...description,peerId:"-1001"}]){
    assert.throws(()=>projectStandingSharedContext({...source,tasks:{...source.tasks,items:[{...taskState(),description:bad}]}} as StandingSharedContextInput));
  }
});
test("content, coverage, audience and asOf changes bind revision independently of caller labels", () => {
  const original = { ...input(), chronicle: { items: [observation()], coverage: available } };
  const revision = projectStandingSharedContext(original).revisionRef;
  for (const changed of [
    { ...original, asOf: 201 },
    { ...original, scope: { scopeRef: ref(1, "scope"), audience: { kind: "requester" as const, requesterRef: speakerRef } } },
    { ...original, chronicle: { items: [observation(1, "Different actual content")], coverage: available } },
    { ...original, chronicle: { items: [observation()], coverage: { ...available, hasMore: true } } },
  ]) assert.notEqual(projectStandingSharedContext(changed).revisionRef, revision);
  assert.throws(() => projectStandingSharedContext({ ...original, revisionRef: revision } as StandingSharedContextInput));
});
test("whole pairs omitted under final escaped JSON budget; smaller later evidence retained", () => {
  const value: StandingSharedContextInput = { ...input(),
    dialogues: { coverage: available, items: [{ kind: "verified-dialogue", sourceRef: ref(20), versionRef: ref(20, "ver"), observedAt: null,
      question: { speakerRef, text: "\u0001".repeat(4096) }, answer: { text: "Verified answer" } }] },
    chronicle: { coverage: available, items: [observation(21, "Small later item")] } };
  const result = projectStandingSharedContext(value, { maxBytes: 2048 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.source, "chronicle");
  assert.equal(result.coverage.dialogues.provided, 1);
  assert.equal(result.coverage.dialogues.included, 0);
  assert.equal(result.coverage.dialogues.omittedByBudget, 1);
  assert.equal(JSON.stringify(result).includes("Verified answer"), false);
});
test("sixteen output and thirty-two input caps retain exact whole-item omission counts", () => {
  const value = { ...input(), chronicle: { coverage: available, items: Array.from({ length: 32 }, (_, i) => observation(i + 1, "")) } };
  const result = projectStandingSharedContext(value);
  assert.ok(result.items.length <= 16);
  assert.equal(result.coverage.chronicle.included, result.items.length);
  assert.equal(result.coverage.chronicle.omittedByBudget, 32 - result.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.throws(() => projectStandingSharedContext({ ...value, chronicle: { ...value.chronicle, items: [...value.chronicle.items, observation(33)] } }));
  assert.throws(() => projectStandingSharedContext({ ...value, tasks: { coverage: available, items: [taskState()] } }));
});
test("unknown native outcome and committed node remain independent of delivery and initiative", () => {
  const result = projectStandingSharedContext({ ...input(), tasks: { items: [taskState()], coverage: available } });
  assert.deepEqual(result.items[0]!.evidence, taskState());
  assert.equal(result.initiativeEligibility, "not-evaluated");
  assert.equal(result.completeChat, false);
});
test("source omissions and stale or unavailable evidence never imply complete eligibility", () => {
  const value: StandingSharedContextInput = { ...input(),
    chronicle: { items: [observation()], coverage: { ...available, freshness: "stale", hasMore: true, omittedAtSource: 91, scanned: 8 } },
    tasks: { items: [], coverage: { availability: "unavailable", freshness: "unknown", scanned: 0, hasMore: null, omittedAtSource: null } } };
  const result = projectStandingSharedContext(value);
  assert.equal(result.coverage.chronicle.omittedAtSource, 91);
  assert.equal(result.coverage.chronicle.omittedByBudget, 0);
  assert.equal(result.coverage.chronicle.freshness, "stale");
  assert.equal(result.coverage.tasks.hasMore, null);
  assert.equal(result.completeChat, false);
  assert.equal(result.initiativeEligibility, "not-evaluated");
  assert.throws(() => projectStandingSharedContext({ ...value, tasks: { ...value.tasks, items: [taskState()] } }));
  assert.throws(() => projectStandingSharedContext({ ...value, tasks: { items: [], coverage: { ...value.tasks.coverage, hasMore: false } } }));
});
test("duplicate logical source versions and observations newer than asOf are refused", () => {
  assert.throws(() => projectStandingSharedContext({ ...input(), chronicle: { coverage: available, items: [observation(), { ...observation(), versionRef: ref(2, "ver") }] } }));
  assert.throws(() => projectStandingSharedContext({ ...input(), chronicle: { coverage: available, items: [{ ...observation(), observedAt: 201 }] } }));
});
test("inert validation refuses getters, proxies, sparse arrays and unexpected fields without executing them", () => {
  let calls = 0;
  const getter = { ...input() };
  Object.defineProperty(getter, "asOf", { enumerable: true, get: () => { calls++; return 200; } });
  assert.throws(() => projectStandingSharedContext(getter));
  assert.throws(() => projectStandingSharedContext(new Proxy(input(), { get() { calls++; throw Error("unexpected"); } })));
  const sparse: StandingSharedObservation[] = []; sparse.length = 1;
  assert.throws(() => projectStandingSharedContext({ ...input(), chronicle: { coverage: available, items: sparse } }));
  const malicious = { ...observation() };
  Object.defineProperty(malicious, "text", { enumerable: true, get: () => { calls++; return "bad"; } });
  assert.throws(() => projectStandingSharedContext({ ...input(), chronicle: { coverage: available, items: [malicious] } }));
  assert.throws(() => projectStandingSharedContext({ ...input(), secret: "extra" } as StandingSharedContextInput));
  assert.equal(calls, 0);
});
test("requester aliases match actual conversation references; opaque scope is not source authentication", () => {
  const scope = { scopeRef: ref(1, "scope"), audience: { kind: "requester" as const, requesterRef: speakerRef } };
  assert.deepEqual(projectStandingSharedContext({ ...input(), scope }).scope, scope);
  for (const requesterRef of ["123456", "neurobro", "a_" + "1".repeat(32)]) {
    assert.throws(() => projectStandingSharedContext({ ...input(), scope: { ...scope, audience: { kind: "requester", requesterRef } } }));
  }
  assert.throws(() => projectStandingSharedContext(input(), { maxBytes: 8193 }));
  assert.throws(() => projectStandingSharedContext(input(), { maxBytes: 2047 }));
  assert.throws(() => projectStandingSharedContext(input(), { maxBytes: 2048.5 }));
});
test("explicit preference preserves its evidence and rejects own output as a participant preference", () => {
  const preference: StandingSharedObservation = { ...observation(), kind: "explicit-preference", text: "Please reply briefly" };
  const result = projectStandingSharedContext({ ...input(), chronicle: { coverage: available, items: [preference] } });
  assert.deepEqual(result.items[0]!.evidence, preference);
  assert.throws(() => projectStandingSharedContext({ ...input(), chronicle: { coverage: available, items: [{ ...preference, speakerRef: "neurobro" }] } }));
});
test("actual Pilot terminal projection preserves verified vs UNKNOWN and canonical own-action content", async () => {
  const views: StandingOwnActionView[] = [];
  for (const outcome of ["verified", "unknown"] as const) {
    const records: PilotRecord[] = [], reply = { chatId: "-100", replyToMessageId: 9, text: "Own response " + outcome };
    const result = await runPilotReply({ approved: { chatId: "-100", accountId: "10", replyToMessageId: 9, maximumTextBytes: 4096 }, reply,
      signal: new AbortController().signal, killSwitchEngaged: () => false,
      store: { async reserve(r) { records.push(r); }, async append(r) { records.push(r); } },
      transport: { async sendOnce() { if (outcome === "unknown") throw Error("synthetic send lost return"); return { messageId: 12 }; },
        async readExact() { return { ...reply, accountId: "10", messageId: 12 }; } } });
    assert.equal(result.state, outcome);
    views.push(projectStandingOwnAction({ binding: { accountId: "10", chatId: "-100" }, referenceKey: "1".repeat(64), slot: outcome,
      source: { family: "pilot", record: records.at(-1)!, reply } }));
  }
  const value = { ...input(), ownActions: { items: views, coverage: available } };
  const result = projectStandingSharedContext(value);
  assert.equal(result.coverage.ownActions.included, 2);
  assert.equal((result.items[0]!.evidence as StandingOwnActionView).verdict, "verified");
  assert.equal((result.items[1]!.evidence as StandingOwnActionView).verdict, "unknown");
  assert.equal((result.items[1]!.evidence as StandingOwnActionView).effect, "not-proven");
  assert.equal((result.items[0]!.evidence as StandingOwnActionView).currentAvailability, "not-checked");
  const reordered = Object.fromEntries(Object.entries(views[0]!).reverse()) as StandingOwnActionView;
  assert.equal(projectStandingSharedContext({ ...value, ownActions: { ...value.ownActions, items: [reordered, views[1]!] } }).revisionRef, result.revisionRef);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["accountId", "chatId", "messageId", "contentHash", "randomId", "referenceKey"]) assert.equal(serialized.includes(forbidden), false);
});
