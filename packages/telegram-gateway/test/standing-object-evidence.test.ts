import test from "node:test";
import assert from "node:assert/strict";
import { snapshotStandingPollObjectEvidence, validateStandingPollObjectEvidence, type StandingPollObjectEvidence } from "../src/standing-object-evidence.js";

const binding = { accountId: "123", chatId: "-100456", primaryMessageId: 789, operationSlot: 0 };
const poll = { question: "Какой день?", options: ["Среда", "Четверг"], anonymous: true, type: "single" as const };
const intent = { requestRef: "request", randomId: "123456789", action: { kind: "create-poll", poll } };
const evidence = (): StandingPollObjectEvidence => ({ schema: "standing-poll-object-v1", kind: "poll", objectRef: "obj_" + "a".repeat(48), observedAt: 1789065600,
  record: { schema: "owned-bound-poll-v1", operationId: "bound-action-123456789", randomId: "123456789", accountId: "123", chatId: "-100456", replyToMessageId: 789,
    messageId: 800, pollId: "-9223372036854775808", poll: structuredClone(poll) } });
test("poll evidence retains exact private identity and snapshots caller graph", () => {
  const source = evidence(), saved = validateStandingPollObjectEvidence(source, binding, intent);
  (source.record.poll.options as string[])[0] = "changed";
  assert.equal(saved.record.poll.options[0], "Среда"); assert.ok(Object.isFrozen(saved.record.poll.options));
  assert.equal(saved.record.pollId, "-9223372036854775808");
});
test("evidence requires exact account/chat/primary/randomId/action and poll definition", () => {
  for (const edit of [{ accountId: "124" }, { chatId: "-100457" }, { primaryMessageId: 788 }])
    assert.throws(() => validateStandingPollObjectEvidence(evidence(), { ...binding, ...edit }, intent));
  for (const edit of [{ randomId: "123456788" }, { action: { kind: "read-poll", poll } },
    { action: { kind: "create-poll", poll: { ...poll, anonymous: false } } }, { action: { kind: "create-poll", poll: { ...poll, options: [...poll.options].reverse() } } }])
    assert.throws(() => validateStandingPollObjectEvidence(evidence(), binding, { ...intent, ...edit }));
  assert.throws(() => snapshotStandingPollObjectEvidence({ ...evidence(), record: { ...evidence().record, operationId: "request" } }));
});
test("hostile evidence getters/proxies and extra fields never execute", () => {
  let calls = 0;
  const getter = { ...evidence(), get record() { calls++; return evidence().record; } }, proxy = new Proxy(evidence(), { getPrototypeOf() { calls++; throw Error(); } });
  for (const value of [getter, proxy, { ...evidence(), extra: true }, { ...evidence(), record: { ...evidence().record, poll: { ...poll, get options() { calls++; return poll.options; } } } }])
    assert.throws(() => snapshotStandingPollObjectEvidence(value));
  assert.equal(calls, 0);
});
test("opaque ref, timestamp and signed Telegram identity limits are strict", () => {
  for (const edit of [{ objectRef: "obj_123" }, { objectRef: "obj_" + "A".repeat(48) }, { observedAt: 0 }, { observedAt: 1.5 }, { observedAt: NaN },
    { record: { ...evidence().record, messageId: 2147483648 } }, { record: { ...evidence().record, pollId: "9223372036854775808" } }])
    assert.throws(() => snapshotStandingPollObjectEvidence({ ...evidence(), ...edit }));
});
test("quiz optional definition fields are bound canonically independent of input property order", () => {
  const quiz = { explanation: "Ответ", correctOption: 1, type: "quiz" as const, anonymous: true, options: ["A", "B"], question: "Тест" },
    e = { ...evidence(), record: { ...evidence().record, poll: quiz } };
  assert.equal(validateStandingPollObjectEvidence(e, binding, { ...intent, action: { kind: "create-poll", poll: quiz } }).record.poll.correctOption, 1);
  assert.throws(() => validateStandingPollObjectEvidence(e, binding, { ...intent, action: { kind: "create-poll", poll: { ...quiz, explanation: "Другой" } } }));
});
