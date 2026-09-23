import test from "node:test";
import assert from "node:assert/strict";
import { standingHistoryWorkProgress } from "../src/standing-service.js";
import type { StandingHistoryTaskWork } from "../src/standing-history-task-runner.js";
import { snapshotStandingHistoryTaskProgressEvent } from "../src/standing-history-task-progress.js";

const taskRef = "htask_" + "a".repeat(48);
const outcome = (value: unknown) => standingHistoryWorkProgress({ kind: "background", outcome: value } as StandingHistoryTaskWork);
test("cancelled and blocked history observations never claim active analysis", () => {
  for (const result of [{kind:"cancelled"},{kind:"attempt",cancelled:true},{kind:"parallel-wave",cancelled:true},{kind:"reused",cancelled:true}]) {
    assert.deepEqual(outcome({kind:"analysis",taskRef,result}),{taskRef,phase:"cancelled",reason:"cancelled"});
  }
  assert.deepEqual(outcome({kind:"read",taskRef,result:{kind:"stale"}}),{taskRef,phase:"stalled",reason:"stale"});
  assert.deepEqual(outcome({kind:"analysis",taskRef,result:{kind:"blocked",reason:"PRIVATE arbitrary reason"}}),{taskRef,phase:"stalled",reason:"unavailable"});
});
test("saved analysis is not yet a quality-accepted report; observations fit strict model schema", () => {
  const ready = outcome({kind:"ready",intent:{taskId:taskRef}})!;
  assert.equal(ready.phase,"finalizing");
  const observations = [ready, outcome({kind:"analysis",taskRef,result:{kind:"scan-more"}})!,
    outcome({kind:"stalled",taskRef,reason:"prior-owner-unavailable"})!,
    outcome({kind:"delivery-state",taskRef,state:"unknown"})!];
  for (const event of observations) assert.deepEqual(snapshotStandingHistoryTaskProgressEvent(event),event);
  assert.equal(observations[1]!.phase,"planning");
  assert.equal(observations[3]!.reason,"delivery-unknown");
  assert.equal(standingHistoryWorkProgress({kind:"idle"}),undefined);
});
