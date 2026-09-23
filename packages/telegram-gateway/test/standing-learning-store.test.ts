import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decryptSession } from "../src/session-crypto.js";
import { openStandingLearningStore, StandingLearningStoreError, type StandingLearningMutation } from "../src/standing-learning-store.js";

const passphrase = "synthetic-standing-learning-passphrase";
const binding = { accountId: "123", peerId: "-100456" };
async function fixture(t: TestContext, inspection?: { maxEntries?: number; maxPlaintextBytes?: number }) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-learning-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-learning-"))); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, "learning"), args = { directory, passphrase, binding, workspaceId: "community-team", ...(inspection ? { inspection } : {}) };
  return { root, directory, file: join(directory, "learning.enc"), args };
}
function mutation(changes: Partial<StandingLearningMutation> = {}): StandingLearningMutation {
  return { actorId: "789", requestRef: "request-1", messageId: 101, callRef: "call-1", action: "save", scope: "self",
    key: "reply.style", expectedRevision: null, kind: "preference", text: "Use a concise and friendly reply.", ...changes } as StandingLearningMutation;
}
function retirement(changes: Partial<StandingLearningMutation> = {}): StandingLearningMutation {
  return { actorId: "789", requestRef: "retire-request", messageId: 102, callRef: "retire-call", action: "retire", scope: "self",
    key: "reply.style", expectedRevision: 1, ...changes };
}

test("encrypted notes survive reopen with actor/team isolation, CAS retirement and exact-call idempotency", async t => {
  const f = await fixture(t); let store = await openStandingLearningStore(f.args);
  const self = await store.mutate(mutation());
  assert.equal(self.revision, 1); assert.equal(self.idempotent, false);
  assert.equal((await store.mutate(mutation())).idempotent, true);
  await assert.rejects(store.mutate(mutation({ text: "Changed under the same tool call." })), (error: unknown) =>
    error instanceof StandingLearningStoreError && error.code === "conflict");
  const team = await store.mutate(mutation({ requestRef: "request-2", messageId: 102, callRef: "call-2", scope: "team",
    key: "handoff.rule", kind: "procedure", text: "Escalate when the answer needs owner-only facts." }));
  assert.equal(team.revision, 1);
  assert.equal((await store.read({ actorId: "790", scope: "self", key: "reply.style" })).state, "absent");
  assert.equal((await store.read({ actorId: "790", scope: "team", key: "handoff.rule" })).note?.text, "Escalate when the answer needs owner-only facts.");
  assert.deepEqual((await store.list({ actorId: "790", query: "owner facts" })).notes.map(note => note.key), ["handoff.rule"]);
  await store.close();
  const cipher = await readFile(f.file, "utf8");
  assert.equal(cipher.includes("friendly"), false); assert.equal(cipher.includes("owner-only"), false);
  const plain = JSON.parse(await decryptSession(cipher, passphrase));
  assert.equal(plain.domain, "DecadansNeurobro/standing-learning-store/v1");
  assert.deepEqual(plain.binding, binding); assert.equal(plain.workspaceId, "community-team"); assert.equal(plain.entries.length, 2);
  assert.equal(Object.hasOwn(plain, "retiredHeads"), false);
  const before = await readFile(f.file);
  await assert.rejects(openStandingLearningStore({ ...f.args, workspaceId: "other-workspace" }), (error: unknown) =>
    error instanceof StandingLearningStoreError && error.code === "binding");
  assert.deepEqual(await readFile(f.file), before);
  store = await openStandingLearningStore(f.args);
  assert.equal((await store.read({ actorId: "789", scope: "self", key: "reply.style" })).note?.provenance.messageId, 101);
  assert.equal((await store.mutate(mutation({ requestRef: "request-3", messageId: 103, callRef: "call-3", expectedRevision: 1,
    text: "Prefer short direct replies." }))).revision, 2);
  await assert.rejects(store.mutate(mutation({ requestRef: "request-4", messageId: 104, callRef: "call-4", expectedRevision: 1 })),
    (error: unknown) => error instanceof StandingLearningStoreError && error.code === "conflict");
  const retired = await store.mutate(retirement({ requestRef: "request-5", messageId: 105, callRef: "call-5",
    scope: "team", key: "handoff.rule", expectedRevision: 1 }));
  assert.deepEqual({ state: retired.state, revision: retired.revision, note: retired.note }, { state: "retired", revision: 2, note: null });
  await store.close(); store = await openStandingLearningStore(f.args);
  const retiredRead = await store.read({ actorId: "790", scope: "team", key: "handoff.rule" });
  assert.deepEqual({ state: retiredRead.state, revision: retiredRead.revision, note: retiredRead.note }, { state: "retired", revision: 2, note: null });
  await assert.rejects(store.mutate(mutation({ requestRef: "request-6", messageId: 106, callRef: "call-6", scope: "team",
    key: "handoff.rule", kind: "procedure", text: "New procedure after retirement." })),
    (error: unknown) => error instanceof StandingLearningStoreError && error.code === "conflict");
  const revived = await store.mutate(mutation({ requestRef: "request-7", messageId: 107, callRef: "call-7", scope: "team",
    key: "handoff.rule", expectedRevision: retiredRead.revision, kind: "procedure", text: "New procedure after retirement." }));
  assert.equal(revived.revision, 3); await store.close();
});

test("serialized mutations have one CAS winner, close joins admitted work, and only tombstones are reclaimed", async t => {
  const f = await fixture(t, { maxEntries: 2, maxPlaintextBytes: 16384 });
  let store = await openStandingLearningStore(f.args);
  const one = store.mutate(mutation({ callRef: "race-1" })), two = store.mutate(mutation({ callRef: "race-2" }));
  let closed = false; const closing = store.close().then(() => { closed = true; });
  assert.equal(closed, false);
  const results = await Promise.allSettled([one, two]); await closing;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof StandingLearningStoreError && result.reason.code === "conflict").length, 1);
  store = await openStandingLearningStore(f.args);
  await store.mutate(retirement({ requestRef: "retire-1", messageId: 102, callRef: "retire-1", expectedRevision: 1 }));
  await store.mutate(mutation({ requestRef: "create-2", messageId: 103, callRef: "create-2", scope: "team", key: "second.slot",
    kind: "lesson", text: "A second retained slot." }));
  await store.mutate(mutation({ requestRef: "create-3", messageId: 104, callRef: "create-3", scope: "team", key: "third.slot",
    kind: "lesson", text: "Reclaims the retired slot." }));
  await assert.rejects(store.mutate(mutation({ requestRef: "create-4", messageId: 105, callRef: "create-4", scope: "team", key: "fourth.slot",
    kind: "lesson", text: "Cannot displace an active note." })), (error: unknown) => error instanceof StandingLearningStoreError && error.code === "limit");
  await store.close();
  store = await openStandingLearningStore(f.args);
  assert.deepEqual(await store.read({ actorId: "789", scope: "self", key: "reply.style" }),
    { state: "retired", key: "reply.style", scope: "self", revision: 2, note: null });
  assert.equal((await store.read({ actorId: "999", scope: "team", key: "second.slot" })).revision, 1);
  assert.equal((await store.read({ actorId: "999", scope: "team", key: "third.slot" })).revision, 1);
  await store.close();
});

test("usage, normalized duplicate recognition and ranked lexical retrieval stay actor scoped and bounded", async t => {
  const f = await fixture(t); const store = await openStandingLearningStore(f.args);
  try {
    await store.mutate(mutation({ requestRef: "rank-1", messageId: 201, callRef: "rank-1", scope: "team", key: "publication.check",
      kind: "procedure", text: "Перед публикацией проверяйте факты и ссылки." }));
    await store.mutate(mutation({ requestRef: "rank-2", messageId: 202, callRef: "rank-2", scope: "team", key: "follow.up",
      kind: "lesson", text: "Follow  UP with the owner." }));
    await store.mutate(mutation({ requestRef: "rank-3", messageId: 203, callRef: "rank-3", scope: "self", key: "private.style",
      kind: "preference", text: "Use private phrasing." }));
    const ranked = await store.list({ actorId: "999", query: "публика провер", limit: 4 });
    assert.deepEqual(ranked.notes.map(note => note.key), ["publication.check"]);
    assert.equal(ranked.visible, 2); assert.equal(ranked.matched, 1);
    const duplicates = await store.duplicates({ actorId: "999", scope: "team", kind: "lesson", text: "ｆｏｌｌｏｗ up with the owner." });
    assert.deepEqual(duplicates.notes.map(note => note.key), ["follow.up"]);
    assert.equal(duplicates.matched, 1);
    assert.equal((await store.duplicates({ actorId: "999", scope: "team", kind: "decision", text: "Follow up with the owner." })).matched, 0);
    assert.equal((await store.duplicates({ actorId: "999", scope: "self", kind: "preference", text: "Use private phrasing." })).matched, 0);
    const usage = await store.usage({ actorId: "789" });
    assert.equal(usage.visibility, "actor-visible"); assert.deepEqual(usage.notes, { active: 3, retired: 0, total: 3 });
    assert.ok(usage.projection.bytes > 0);
    assert.deepEqual(usage.formatLimits, { hotSlotsMaximum: 256, archivedRetiredMaximum: 2048, plaintextMaximumBytes: 1024 * 1024 });
  } finally { await store.close(); }
});

test("hot tombstones archive atomically at capacity and retain read, CAS and exact retry across reopen", async t => {
  const f = await fixture(t, { maxEntries: 2, maxPlaintextBytes: 32768 }); let store = await openStandingLearningStore(f.args);
  const saved = await store.mutate(mutation({ requestRef: "archive-save", messageId: 301, callRef: "archive-save", scope: "team", key: "old.rule",
    kind: "procedure", text: "Original rule text must not enter the compact retired head." }));
  const retireInput = retirement({ requestRef: "archive-retire", messageId: 302, callRef: "archive-retire", scope: "team", key: "old.rule", expectedRevision: saved.revision });
  const retired = await store.mutate(retireInput);
  await store.mutate(mutation({ requestRef: "archive-b", messageId: 303, callRef: "archive-b", scope: "team", key: "active.b", kind: "lesson", text: "Active B" }));
  // This third logical key reclaims only the oldest hot tombstone. Both active
  // notes remain hot and the retired CAS head remains encrypted and queryable.
  await store.mutate(mutation({ requestRef: "archive-c", messageId: 304, callRef: "archive-c", scope: "team", key: "active.c", kind: "decision", text: "Active C" }));
  let usage = await store.usage({ actorId: "789" });
  assert.deepEqual(usage.notes, { active: 2, retired: 1, total: 3 });
  await store.close();
  let plain = JSON.parse(await decryptSession(await readFile(f.file, "utf8"), passphrase));
  assert.equal(plain.entries.length, 2); assert.equal(plain.retiredHeads.length, 1);
  assert.equal(JSON.stringify(plain.retiredHeads).includes("Original rule text"), false);
  assert.equal(Object.hasOwn(plain.retiredHeads[0], "text"), false); assert.equal(Object.hasOwn(plain.retiredHeads[0], "provenance"), false);
  store = await openStandingLearningStore(f.args);
  const read = await store.read({ actorId: "999", scope: "team", key: "old.rule" });
  assert.deepEqual({ state: read.state, revision: read.revision, note: read.note }, { state: "retired", revision: retired.revision, note: null });
  assert.equal((await store.mutate(retireInput)).idempotent, true);
  await assert.rejects(store.mutate(mutation({ requestRef: "restore-blocked", messageId: 305, callRef: "restore-blocked", scope: "team", key: "old.rule",
    expectedRevision: read.revision, kind: "procedure", text: "Restored rule" })),
  (error: unknown) => error instanceof StandingLearningStoreError && error.code === "limit");
  const activeB = await store.read({ actorId: "999", scope: "team", key: "active.b" });
  await store.mutate(retirement({ requestRef: "retire-b", messageId: 306, callRef: "retire-b", scope: "team", key: "active.b", expectedRevision: activeB.revision }));
  const restored = await store.mutate(mutation({ requestRef: "restore-ok", messageId: 307, callRef: "restore-ok", scope: "team", key: "old.rule",
    expectedRevision: read.revision, kind: "procedure", text: "Restored rule" }));
  assert.equal(restored.revision, retired.revision + 1);
  usage = await store.usage({ actorId: "789" }); assert.equal(usage.notes.retired, 1); assert.equal(usage.notes.active, 2);
  await store.close(); store = await openStandingLearningStore(f.args);
  assert.equal((await store.read({ actorId: "999", scope: "team", key: "old.rule" })).note?.text, "Restored rule");
  assert.equal((await store.read({ actorId: "999", scope: "team", key: "active.b" })).state, "retired");
  plain = JSON.parse(await decryptSession(await readFile(f.file, "utf8"), passphrase)); assert.equal(plain.retiredHeads.length, 1);
  await store.close();
});

test("actor-visible usage is invariant under another actor private save, revision, retirement and archival", async t => {
  const f = await fixture(t, { maxEntries: 2, maxPlaintextBytes: 32768 }); const store = await openStandingLearningStore(f.args);
  try {
    await store.mutate(mutation({ actorId: "789", requestRef: "visible-a", messageId: 401, callRef: "visible-a",
      key: "actor.a", text: "Actor A private preference." }));
    const before = await store.usage({ actorId: "789" }), beforeJson = JSON.stringify(before);
    assert.deepEqual(before.notes, { active: 1, retired: 0, total: 1 });
    const privateB = await store.mutate(mutation({ actorId: "790", requestRef: "private-b", messageId: 402, callRef: "private-b",
      key: "actor.b", text: "Actor B private preference with a different byte length." }));
    assert.equal(JSON.stringify(await store.usage({ actorId: "789" })), beforeJson);
    const revisedB = await store.mutate(mutation({ actorId: "790", requestRef: "private-b2", messageId: 403, callRef: "private-b2",
      key: "actor.b", expectedRevision: privateB.revision, text: "Actor B revised private preference." }));
    assert.equal(JSON.stringify(await store.usage({ actorId: "789" })), beforeJson);
    await store.mutate(retirement({ actorId: "790", requestRef: "private-b3", messageId: 404, callRef: "private-b3",
      key: "actor.b", expectedRevision: revisedB.revision }));
    assert.equal(JSON.stringify(await store.usage({ actorId: "789" })), beforeJson);
    await store.mutate(mutation({ actorId: "790", requestRef: "private-b4", messageId: 405, callRef: "private-b4",
      key: "actor.b.next", text: "Actor B replacement private preference." }));
    assert.equal(JSON.stringify(await store.usage({ actorId: "789" })), beforeJson);
    const visibleB = await store.usage({ actorId: "790" });
    assert.deepEqual(visibleB.notes, { active: 1, retired: 1, total: 2 });
    assert.notEqual(JSON.stringify(visibleB), beforeJson);
    const actorA = await store.read({ actorId: "789", scope: "self", key: "actor.a" });
    await store.mutate(retirement({ actorId: "789", requestRef: "visible-a-retire", messageId: 406, callRef: "visible-a-retire",
      key: "actor.a", expectedRevision: actorA.revision }));
    const beforeRelocation = JSON.stringify(await store.usage({ actorId: "789" }));
    await store.mutate(mutation({ actorId: "790", requestRef: "private-b5", messageId: 407, callRef: "private-b5",
      key: "actor.b.third", text: "Actor B creates another private preference." }));
    assert.equal(JSON.stringify(await store.usage({ actorId: "789" })), beforeRelocation);
  } finally { await store.close(); }
});
