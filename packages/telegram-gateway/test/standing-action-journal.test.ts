import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { decryptSession, encryptSession } from "../src/session-crypto.js";
import { openStandingActionJournal, standingActionKey, StandingActionJournalError, type StandingActionBinding } from "../src/standing-action-journal.js";
import type { StandingPollObjectEvidence } from "../src/standing-object-evidence.js";

const binding = (): StandingActionBinding => ({ accountId: "123", chatId: "-100456", primaryMessageId: 789, operationSlot: 0 });
const intent = () => ({ requestRef: "req1", randomId: "123456789", action: { kind: "reaction", emoji: "👍" } });
async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(resolve(tmpdir()), "neurobro-action-journal-"));
  t.after(async () => { assert.ok(parent.startsWith(join(resolve(tmpdir()), "neurobro-action-journal-"))); await rm(parent, { recursive: true, force: true }); });
  const args = { directory: join(parent, "journal"), passphrase: "synthetic-action-passphrase-only", binding: binding() };
  return { args, slot: join(args.directory, standingActionKey(args.binding)), parent };
}
function code(expected: string) { return (e: unknown) => e instanceof StandingActionJournalError && e.code === expected; }
test("exclusive encrypted intent precedes terminal and verified state reopens", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args);
  assert.deepEqual(await journal.inspect(), { state: "absent" }); await journal.reserve(intent());
  assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
  const reserved = await journal.inspect(); assert.equal(reserved.state, "reserved"); assert.deepEqual(reserved.intent, intent());
  await journal.append({ state: "verified", result: { messageId: 900, reaction: "👍" } });
  const proof = await journal.inspect(); assert.equal(proof.state, "verified"); assert.ok(Object.isFrozen(proof.intent!.action));
  const cipher = await readFile(join(f.slot, "intent.enc"), "utf8"); assert.equal(cipher.includes("req1"), false); assert.equal(cipher.includes("reaction"), false);
  await journal.close(); const reopened = await openStandingActionJournal(f.args);
  assert.deepEqual(await reopened.inspect(), proof);
  await assert.rejects(reopened.reserve({ ...intent(), requestRef: "new-epoch", randomId: "9", action: { kind: "poll" } }), code("consumed"));
  await assert.rejects(reopened.append({ state: "verified", result: null }), code("consumed")); await reopened.close();
});
test("slot key depends only on bound peer, account, primary and host slot", () => {
  const original = standingActionKey(binding()); assert.match(original, /^[0-9a-f]{64}$/u);
  for (const edit of [{ accountId: "124" }, { chatId: "-100457" }, { primaryMessageId: 790 }, { operationSlot: 1 }]) assert.notEqual(standingActionKey({ ...binding(), ...edit }), original);
  for (const edit of [{ operationSlot: 32 }, { operationSlot: -1 }, { primaryMessageId: 0 }, { accountId: "0" }, { chatId: "123" }]) assert.throws(() => standingActionKey({ ...binding(), ...edit }), code("input"));
});
test("independent journal instances cannot reserve the same logical action twice", async t => {
  const f = await fixture(t), a = await openStandingActionJournal(f.args), b = await openStandingActionJournal(f.args);
  const outcomes = await Promise.allSettled([a.reserve(intent()), b.reserve({ ...intent(), requestRef: "next", randomId: "7", action: { kind: "poll" } })]);
  assert.equal(outcomes.filter(v => v.status === "fulfilled").length, 1);
  const refused = outcomes.find(v => v.status === "rejected"); assert.ok(refused && refused.status === "rejected" && code("consumed")(refused.reason));
  assert.equal((await a.inspect()).state, "reserved"); await a.close(); await b.close();
});
test("refused and unknown outcomes are terminal and cannot overwrite each other", async t => {
  const f = await fixture(t);
  for (const [operationSlot, state] of [[0, "unknown"], [1, "refused"]] as const) {
    const journal = await openStandingActionJournal({ ...f.args, binding: { ...binding(), operationSlot } });
    await journal.reserve(intent()); await journal.append({ state, result: { stage: "readback", reason: "unavailable" } });
    const proof = await journal.inspect(); assert.equal(proof.state, state);
    await assert.rejects(journal.append({ state: "verified", result: {} }), code("consumed"));
    await assert.rejects(journal.reserve(intent()), code("consumed")); assert.deepEqual(await journal.inspect(), proof); await journal.close();
  }
});
test("incomplete slot and corrupted ciphertext stay unknown and consumed", async t => {
  const f = await fixture(t); await mkdir(f.args.directory); await mkdir(f.slot);
  const journal = await openStandingActionJournal(f.args); assert.deepEqual(await journal.inspect(), { state: "unknown" });
  await assert.rejects(journal.reserve(intent()), code("consumed")); await journal.close();
  await writeFile(join(f.slot, "intent.enc"), "not encrypted");
  const reopened = await openStandingActionJournal(f.args); assert.equal((await reopened.inspect()).state, "unknown");
  await assert.rejects(reopened.reserve(intent()), code("consumed")); await reopened.close();
});
test("reserved slot remains consumed after restart without executing or appending", async t => {
  const f = await fixture(t), first = await openStandingActionJournal(f.args); await first.reserve(intent()); await first.close();
  const resumed = await openStandingActionJournal(f.args); assert.equal((await resumed.inspect()).state, "reserved");
  await assert.rejects(resumed.append({ state: "unknown", result: {} }), code("consumed"));
  await assert.rejects(resumed.reserve({ ...intent(), requestRef: "new" }), code("consumed")); await resumed.close();
});
test("intent and terminal nested JSON are snapshotted synchronously", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args);
  const requested = { ...intent(), action: { kind: "poll", options: ["first", "second"] } };
  const pending = journal.reserve(requested); requested.requestRef = "changed"; requested.action.options[0] = "changed"; await pending;
  const done = { state: "verified" as const, result: { ids: [1, 2] } }, terminal = journal.append(done); done.result.ids[0] = 999; await terminal;
  const proof = await journal.inspect(); assert.equal(proof.intent!.requestRef, "req1"); assert.deepEqual(proof.intent!.action, { kind: "poll", options: ["first", "second"] }); assert.deepEqual(proof.terminal!.result, { ids: [1, 2] }); await journal.close();
});
test("hostile JSON, getters, proxies, sparse arrays, size and depth refuse before reserve", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args); let calls = 0;
  const nestedGetter = { get value() { calls++; return 1; } }, proxy = new Proxy({}, { getPrototypeOf() { calls++; throw Error(); } });
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  let deep: unknown = 1; for (let n = 0; n < 10; n++) deep = { child: deep };
  const sparse = Array(3); sparse[2] = 1;
  for (const action of [nestedGetter, proxy, cycle, deep, sparse, { a: undefined }, { a: NaN }, { a: Infinity }, { a: "x".repeat(4097) },
    ["x".repeat(4096), "x".repeat(4096), "x".repeat(4096), "x".repeat(4096)], new Date(), Buffer.from("secret"), { toJSON() { calls++; return {}; } }])
    await assert.rejects(journal.reserve({ ...intent(), action }), code("input"));
  assert.equal(calls, 0); assert.deepEqual(await journal.inspect(), { state: "absent" });
  await assert.rejects(journal.reserve({ ...intent(), randomId: "9223372036854775808" }), code("input"));
  await assert.rejects(journal.reserve({ ...intent(), get requestRef() { calls++; return "x"; } }), code("input"));
  assert.equal(calls, 0); await journal.close();
});
test("envelope domain/key and terminal intent hash prevent transplanted results", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args); await journal.reserve(intent()); await journal.append({ state: "verified", result: { id: 1 } }); await journal.close();
  const terminalPath = join(f.slot, "terminal.enc"), original = await readFile(terminalPath, "utf8");
  const decoded = JSON.parse(await decryptSession(original, f.args.passphrase));
  for (const mutate of [(v: typeof decoded) => { v.domain = "other"; }, (v: typeof decoded) => { v.key = "0".repeat(64); }, (v: typeof decoded) => { v.payload.intentHash = "0".repeat(64); }]) {
    const tampered = JSON.parse(JSON.stringify(decoded)); mutate(tampered);
    await writeFile(terminalPath, await encryptSession(JSON.stringify(tampered), f.args.passphrase));
    const reopened = await openStandingActionJournal(f.args); assert.equal((await reopened.inspect()).state, "unknown"); await assert.rejects(reopened.reserve(intent()), code("consumed")); await reopened.close();
  }
});
test("terminal persistence failure preserves reserved evidence and refuses overwrite", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args); await journal.reserve(intent());
  await writeFile(join(f.slot, "terminal.enc"), "partial prior result");
  await assert.rejects(journal.append({ state: "verified", result: { id: 1 } }), code("storage"));
  assert.equal((await journal.inspect()).state, "unknown"); await assert.rejects(journal.append({ state: "unknown", result: {} }), code("consumed"));
  assert.equal(await readFile(join(f.slot, "terminal.enc"), "utf8"), "partial prior result"); await journal.close();
});
test("singleflight rejects concurrent work; close revokes and joins admitted disk work", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args); let finished = false;
  const pending = journal.reserve(intent()).then(() => { finished = true; }, e => { finished = true; assert.ok(e instanceof StandingActionJournalError); });
  await assert.rejects(journal.inspect(), code("consumed"));
  // Observe the exclusive reservation before closing during encryption or later I/O.
  for (let n = 0; n < 1000 && !finished; n++) { try { await lstat(f.slot); break; } catch { await immediate(); } }
  await journal.close(); await pending; assert.equal(finished, true);
  await assert.rejects(journal.inspect(), code("closed")); await assert.rejects(journal.reserve(intent()), code("closed"));
  const reopened = await openStandingActionJournal(f.args); const state = (await reopened.inspect()).state;
  assert.ok(state === "unknown" || state === "reserved"); await assert.rejects(reopened.reserve(intent()), code("consumed")); await reopened.close();
});
test("hardlinked record is refused and slot symlink cannot redirect journal reads", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args); await journal.reserve(intent()); await journal.close();
  await link(join(f.slot, "intent.enc"), join(f.parent, "linked.enc"));
  const reopened = await openStandingActionJournal(f.args); assert.equal((await reopened.inspect()).state, "unknown"); await reopened.close();
  const other = await fixture(t); await mkdir(other.args.directory);
  await symlink(f.slot, other.slot, process.platform === "win32" ? "junction" : "dir");
  const linked = await openStandingActionJournal(other.args); assert.equal((await linked.inspect()).state, "unknown"); await assert.rejects(linked.reserve(intent()), code("consumed")); await linked.close();
});

function pollEvidence(): StandingPollObjectEvidence {
  return { schema: "standing-poll-object-v1", kind: "poll", objectRef: "obj_" + "1".repeat(48), observedAt: 1789065600,
    record: { schema: "owned-bound-poll-v1", operationId: "bound-action-123456789", randomId: "123456789", accountId: "123", chatId: "-100456",
      replyToMessageId: 789, messageId: 800, pollId: "900", poll: { question: "Private poll?", options: ["Yes", "No"], anonymous: true, type: "single" } } };
}
test("verified poll evidence and public result persist in one encrypted terminal across reopen", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args), evidence = pollEvidence();
  await journal.reserve({ ...intent(), action: { kind: "create-poll", poll: evidence.record.poll } });
  const terminal = journal.append({ state: "verified", result: { verdict: "verified", poll: { messageRef: "msg_ephemeral" } }, privateObjectEvidence: evidence });
  (evidence.record.poll.options as string[])[0] = "changed after append"; await terminal; await journal.close();
  assert.deepEqual((await readdir(f.slot)).sort(), ["intent.enc", "terminal.enc"]);
  const cipher = await readFile(join(f.slot, "terminal.enc"), "utf8");
  for (const secret of ["Private poll?", "123456789", "obj_", "privateObjectEvidence", "msg_ephemeral"]) assert.equal(cipher.includes(secret), false);
  const reopened = await openStandingActionJournal(f.args), result = await reopened.inspect();
  assert.equal(result.state, "verified"); assert.deepEqual(result.terminal!.privateObjectEvidence, pollEvidence());
  assert.deepEqual(result.terminal!.result, { verdict: "verified", poll: { messageRef: "msg_ephemeral" } });
  await assert.rejects(reopened.append({ state: "verified", result: { verdict: "verified" }, privateObjectEvidence: pollEvidence() }), code("consumed")); await reopened.close();
});
test("private evidence refuses nonverified and mismatched action before terminal persistence", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args); await journal.reserve(intent());
  for (const state of ["unknown", "refused", "verified"] as const)
    await assert.rejects(journal.append({ state, result: { verdict: state }, privateObjectEvidence: pollEvidence() }), code("input"));
  assert.deepEqual(await readdir(f.slot), ["intent.enc"]); await journal.append({ state: "refused", result: {} }); await journal.close();
});
test("authenticated but misbound poll terminal becomes unknown without rewriting old attempt", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args), evidence = pollEvidence();
  await journal.reserve({ ...intent(), action: { kind: "create-poll", poll: evidence.record.poll } });
  await journal.append({ state: "verified", result: { verdict: "verified" }, privateObjectEvidence: evidence }); await journal.close();
  const path = join(f.slot, "terminal.enc"), decoded = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  decoded.payload.terminal.privateObjectEvidence.record.replyToMessageId++;
  const changed = await encryptSession(JSON.stringify(decoded), f.args.passphrase); await writeFile(path, changed);
  const reopened = await openStandingActionJournal(f.args); assert.equal((await reopened.inspect()).state, "unknown"); await reopened.close();
  assert.equal(await readFile(path, "utf8"), changed);
});
test("poll evidence refuses contradictory public verdict before append and during authenticated readback", async t => {
  const f = await fixture(t), journal = await openStandingActionJournal(f.args), evidence = pollEvidence();
  await journal.reserve({ ...intent(), action: { kind: "create-poll", poll: evidence.record.poll } });
  for (const result of [{ verdict: "unknown" }, { verdict: "refused" }, {}, null, []])
    await assert.rejects(journal.append({ state: "verified", result, privateObjectEvidence: evidence }), code("input"));
  assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
  await journal.append({ state: "verified", result: { verdict: "verified" }, privateObjectEvidence: evidence }); await journal.close();
  const path = join(f.slot, "terminal.enc"), decoded = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  decoded.payload.terminal.result.verdict = "unknown"; await writeFile(path, await encryptSession(JSON.stringify(decoded), f.args.passphrase));
  const reopened = await openStandingActionJournal(f.args); assert.equal((await reopened.inspect()).state, "unknown"); await reopened.close();
});
