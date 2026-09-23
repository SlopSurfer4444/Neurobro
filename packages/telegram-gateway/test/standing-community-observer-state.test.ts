import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Api } from "telegram";
import { decryptSession, encryptSession } from "../src/session-crypto.js";
import { openStandingCommunityObserverState, StandingCommunityObserverStateError } from "../src/standing-community-observer-state.js";
import { projectStandingObservedSourcePage } from "../src/standing-observed-source-reader.js";

const passphrase = "synthetic-community-observer-passphrase";
const binding = { workspaceId: "community-team", accountId: "123", internalPeerId: "-100654321", sourcePeerId: "-100123456" };
const sourcePeer = () => new Api.PeerChannel({ channelId: bigInt(123456) });
function sourceMessage(id: number, text = `Synthetic community row ${id}`) {
  return new Api.Message({ id, date: 1700000000 + id, peerId: sourcePeer(), fromId: new Api.PeerUser({ userId: bigInt(777) }), message: text });
}
function page(ids: readonly number[], beforeMessageId?: number) {
  return projectStandingObservedSourcePage(new Api.messages.Messages({ messages: ids.map(id => sourceMessage(id)),
    users: [new Api.User({ id: bigInt(777), firstName: "Source participant" })], chats: [] }),
  { sourceRef: "community", title: "Synthetic source", peerId: binding.sourcePeerId, limit: 30, ...(beforeMessageId ? { beforeMessageId } : {}) });
}
async function fixture(t: TestContext, inspection?: { maxRecentRows?: number; maxPlaintextBytes?: number }) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-community-state-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-community-state-"))); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, "observer"), args = { directory, passphrase, binding, ...(inspection ? { inspection } : {}) };
  return { directory, file: join(directory, "community-observer.enc"), args };
}
const refused = (code: StandingCommunityObserverStateError["code"]) => (error: unknown) => error instanceof StandingCommunityObserverStateError && error.code === code && !error.cause;

test("full Russian text and captions persist across reopen; legacy processing counters migrate without inventing analysis", async t => {
  const f = await fixture(t); let store = await openStandingCommunityObserverState(f.args);
  const fullText = "Подробная претензия. ".repeat(190) + "В КОНЦЕ КЛИЕНТ ПРОСИТ ПЕРЕЗВОНИТЬ";
  const message = sourceMessage(100, fullText); message.media = new Api.MessageMediaPhoto({});
  const source = projectStandingObservedSourcePage(new Api.messages.Messages({ messages: [message],
    users: [new Api.User({ id: bigInt(777), firstName: "Источник" })], chats: [] }),
    { sourceRef: "community", title: "Synthetic source", peerId: binding.sourcePeerId, limit: 30 });
  await store.commitPage({ expectedRevision: 0, observedAt: 1800000000, page: source }); await store.close();
  const before = JSON.parse(await decryptSession(await readFile(f.file, "utf8"), passphrase));
  assert.equal(before.recent[0].item.text, fullText); assert.equal(before.recent[0].item.truncated, false);
  // Reconstruct the earlier V41 schema, which had no too-large counter.
  delete before.processingTotals["material-too-large"];
  await writeFile(f.file, await encryptSession(JSON.stringify(before), passphrase), "utf8");
  store = await openStandingCommunityObserverState(f.args);
  assert.equal((await store.checkpoint()).processing.totals["material-too-large"], 0);
  const pending = await store.readPending(); assert.equal(pending.items[0]!.text, fullText);
  assert.equal(pending.items[0]!.media.kind, "photo");
  await store.markProcessed({ expectedRevision: 1, throughSequence: 1, disposition: "material-too-large" }); await store.close();
  store = await openStandingCommunityObserverState(f.args);
  const checkpoint = await store.checkpoint();
  assert.equal(checkpoint.processing.totals["material-too-large"], 1); assert.equal(checkpoint.processing.totals.silent, 0);
  assert.ok(checkpoint.coverage.gaps.some(gap => gap.kind === "assessment-material-too-large-not-analyzed" && gap.count === 1));
  await store.close();
  const after = JSON.parse(await decryptSession(await readFile(f.file, "utf8"), passphrase));
  assert.equal(after.recent[0].item.text, fullText, "disposition must not remove or shorten retained source");
});

test("encrypted baseline, pending dispositions and crash-safe reservation survive exact-bound reopen", async t => {
  const f = await fixture(t); let store = await openStandingCommunityObserverState(f.args);
  const baselinePage = page(Array.from({ length: 30 }, (_, i) => 100 - i));
  const baseline = await store.commitPage({ expectedRevision: 0, observedAt: 1800000000, page: baselinePage });
  assert.equal(baseline.idempotent, false); assert.equal(baseline.admittedRows, 30);
  assert.deepEqual(baseline.checkpoint.read, { beforeMessageId: null, limit: 30 });
  assert.equal(baseline.checkpoint.cycle.status, "idle"); assert.equal(baseline.checkpoint.cycle.highWatermark, null);
  assert.equal(baseline.checkpoint.coverage.completeHistory, false);
  assert.deepEqual(baseline.checkpoint.coverage.gaps, [{ kind: "history-before-observation-not-read" }]);
  const initial = await store.readPending({ limit: 30 });
  assert.equal(initial.items.length, 30); assert.equal(initial.range.throughSequence, 30);
  assert.equal(initial.ordering, "discovery-sequence-with-explicit-source-date");
  assert.equal(JSON.stringify(initial).includes(binding.sourcePeerId), false);
  const disabled = await store.markProcessed({ expectedRevision: 1, throughSequence: 30, disposition: "alerts-disabled" });
  assert.equal(disabled.checkpoint.processing.totals["alerts-disabled"], 30); assert.equal(disabled.checkpoint.recent.pendingRows, 0);
  const newer = await store.commitPage({ expectedRevision: 2, observedAt: 1800000100, page: page([105, 104, 103, 102, 101, 100]) });
  assert.equal(newer.admittedRows, 5); assert.equal(newer.checkpoint.cycle.status, "idle");
  const pending = await store.readPending(); assert.equal(pending.items.length, 5); assert.equal(pending.range.throughSequence, 35);
  const reserved = await store.markProcessed({ expectedRevision: 3, throughSequence: 35, disposition: "attempt-reserved" });
  assert.equal(reserved.checkpoint.processing.last?.disposition, "attempt-reserved"); assert.equal(reserved.checkpoint.processing.totals["attempt-reserved"], 5);
  await store.close();
  const cipher = await readFile(f.file, "utf8"); assert.equal(cipher.includes("Synthetic community"), false); assert.equal(cipher.includes(binding.sourcePeerId), false);
  const plain = JSON.parse(await decryptSession(cipher, passphrase)); assert.deepEqual(plain.binding, binding); assert.equal(plain.recent.length, 35);
  await assert.rejects(openStandingCommunityObserverState({ ...f.args, binding: { ...binding, workspaceId: "other-team" } }), refused("binding"));
  store = await openStandingCommunityObserverState(f.args);
  assert.equal((await store.readPending()).items.length, 0); assert.equal((await store.checkpoint()).processing.last?.disposition, "attempt-reserved");
  const resolved = await store.markProcessed({ expectedRevision: 4, throughSequence: 35, disposition: "unknown" });
  assert.equal(resolved.checkpoint.processing.totals["attempt-reserved"], 0); assert.equal(resolved.checkpoint.processing.totals.unknown, 5);
  assert.equal(resolved.checkpoint.processing.last?.disposition, "unknown"); await store.close();
});

test("a burst larger than one page resumes its exact cursor across reopen without skipped or duplicate rows", async t => {
  const f = await fixture(t); let store = await openStandingCommunityObserverState(f.args);
  await store.commitPage({ expectedRevision: 0, observedAt: 1800000000, page: page(Array.from({ length: 30 }, (_, i) => 100 - i)) });
  await store.markProcessed({ expectedRevision: 1, throughSequence: 30, disposition: "alerts-disabled" });
  const first = await store.commitPage({ expectedRevision: 2, observedAt: 1800000100, page: page(Array.from({ length: 30 }, (_, i) => 171 - i)) });
  assert.deepEqual(first.checkpoint.read, { beforeMessageId: 142, limit: 30 }); assert.equal(first.checkpoint.cycle.highWatermark, 171);
  await store.close(); store = await openStandingCommunityObserverState(f.args);
  const second = await store.commitPage({ expectedRevision: 3, observedAt: 1800000101, page: page(Array.from({ length: 30 }, (_, i) => 141 - i), 142) });
  assert.deepEqual(second.checkpoint.read, { beforeMessageId: 112, limit: 30 });
  await store.close(); store = await openStandingCommunityObserverState(f.args);
  const third = await store.commitPage({ expectedRevision: 4, observedAt: 1800000102, page: page(Array.from({ length: 30 }, (_, i) => 111 - i), 112) });
  assert.equal(third.admittedRows, 11); assert.equal(third.checkpoint.cycle.status, "idle"); assert.equal(third.checkpoint.recent.pendingRows, 71);
  const one = await store.readPending({ limit: 64 });
  assert.equal(one.items.length, 64); assert.equal(new Set(one.items.map(item => item.ref)).size, 64); assert.equal(one.hasMore, true);
  await store.markProcessed({ expectedRevision: 5, throughSequence: one.range.throughSequence!, disposition: "policy-suppressed" });
  const two = await store.readPending({ limit: 64 });
  assert.equal(two.items.length, 7); assert.equal(two.items[0]!.sequence, one.range.throughSequence! + 1);
  assert.equal(new Set([...one.items, ...two.items].map(item => item.ref)).size, 71); await store.close();
});

test("projection byte omissions continue the original bounded bootstrap window without drifting into older history", async t => {
  const f = await fixture(t); const store = await openStandingCommunityObserverState(f.args), ids = Array.from({ length: 30 }, (_, i) => 500 - i);
  const projected = (selected: readonly number[], beforeMessageId?: number) => projectStandingObservedSourcePage(new Api.messages.Messages({
    messages: selected.map(id => sourceMessage(id, '"'.repeat(1024))), users: [new Api.User({ id: bigInt(777), firstName: "Source participant" })], chats: [] }),
  { sourceRef: "community", title: "Synthetic source", peerId: binding.sourcePeerId, limit: 30, ...(beforeMessageId ? { beforeMessageId } : {}) });
  const firstPage = projected(ids); assert.ok(firstPage.coverage.omittedByBudget > 0);
  const first = await store.commitPage({ expectedRevision: 0, observedAt: 1800000000, page: firstPage });
  assert.equal(first.checkpoint.cycle.kind, "bootstrap"); assert.equal(first.checkpoint.read.beforeMessageId, firstPage.nextBeforeMessageId);
  const remaining = ids.slice(firstPage.coverage.coveredRows), secondPage = projected(remaining, firstPage.nextBeforeMessageId!);
  const second = await store.commitPage({ expectedRevision: 1, observedAt: 1800000001, page: secondPage });
  assert.equal(second.checkpoint.cycle.status, "idle"); assert.equal(second.checkpoint.recent.pendingRows, 30);
  const pending = await store.readPending({ limit: 32 }); assert.equal(pending.items.length, 30);
  assert.equal(new Set(pending.items.map(item => item.ref)).size, 30); await store.close();
});

test("capacity pause never advances past an unretained row and processing reopens the same durable cursor", async t => {
  const f = await fixture(t, { maxRecentRows: 3, maxPlaintextBytes: 16384 }); const store = await openStandingCommunityObserverState(f.args);
  await store.commitPage({ expectedRevision: 0, observedAt: 1800000000, page: page([10, 9, 8]) });
  await store.markProcessed({ expectedRevision: 1, throughSequence: 3, disposition: "alerts-disabled" });
  const blocked = await store.commitPage({ expectedRevision: 2, observedAt: 1800000010, page: page([14, 13, 12, 11, 10]) });
  assert.equal(blocked.admittedRows, 3); assert.equal(blocked.checkpoint.cycle.status, "capacity-paused");
  assert.deepEqual(blocked.checkpoint.read, { beforeMessageId: 12, limit: 30 });
  assert.deepEqual(blocked.checkpoint.coverage.gaps, [{ kind: "history-before-observation-not-read" }, { kind: "retention-evicted", count: 3 }, { kind: "capacity-paused" }]);
  const pending = await store.readPending(); assert.equal(pending.items.length, 3);
  const processed = await store.markProcessed({ expectedRevision: 3, throughSequence: pending.range.throughSequence!, disposition: "policy-suppressed" });
  assert.equal(processed.checkpoint.cycle.status, "catching-up");
  const resumed = await store.commitPage({ expectedRevision: 4, observedAt: 1800000011, page: page([11, 10, 9], 12) });
  assert.equal(resumed.admittedRows, 1); assert.equal(resumed.checkpoint.cycle.status, "idle");
  assert.equal((await store.readPending()).items.length, 1); assert.equal(resumed.checkpoint.coverage.completeHistory, false); await store.close();
});

test("an exact page retry is idempotent after reopen while changed or stale windows conflict", async t => {
  const f = await fixture(t); const firstPage = page([30, 29]); let store = await openStandingCommunityObserverState(f.args);
  await store.commitPage({ expectedRevision: 0, observedAt: 1800000000, page: firstPage }); await store.close();
  store = await openStandingCommunityObserverState(f.args);
  const retry = await store.commitPage({ expectedRevision: 0, observedAt: 1800000000, page: page([30, 29]) }); assert.equal(retry.idempotent, true);
  await assert.rejects(store.commitPage({ expectedRevision: 0, observedAt: 1800000001, page: page([30, 29]) }), refused("conflict"));
  await assert.rejects(store.commitPage({ expectedRevision: 1, observedAt: 1800000001, page: page([28], 29) }), refused("conflict"));
  await assert.rejects(store.commitPage({ expectedRevision: 1, observedAt: 1800000001,
    page: projectStandingObservedSourcePage(new Api.messages.Messages({ messages: [], users: [], chats: [] }),
      { sourceRef: "community", title: "Foreign", peerId: "-100999999", limit: 30 }) }), refused("binding"));
  await store.close();
});

test("close joins serialized admitted work and refuses later operations", async t => {
  const f = await fixture(t); const store = await openStandingCommunityObserverState(f.args);
  const commit = store.commitPage({ expectedRevision: 0, observedAt: 1800000000, page: page([2, 1]) });
  const closing = store.close(); const result = await commit; await closing; assert.equal(result.admittedRows, 2);
  await assert.rejects(store.checkpoint(), refused("closed"));
});
