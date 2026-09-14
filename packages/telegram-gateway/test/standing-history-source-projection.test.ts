import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createSelfHistoryReader } from "../src/self-history-reader.js";
import { snapshotStandingHistoryTaskPage, type StandingHistoryStoredPage, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { projectStandingHistorySource, StandingHistorySourceProjectionError, type StandingHistorySourceFragment } from "../src/standing-history-source-projection.js";

const referenceKey = "01".repeat(32), accountId = "7890123456", authorId = "4560123456";
const intent = (): StandingHistoryTaskIntent => ({ schema: "standing-history-task-v1", taskId: "htask_" + "1".repeat(48), accountId, chatId: "-10012345678",
  requesterId: authorId, primaryMessageId: 2100, fromDate: 100, toDate: 1000, timezone: "Europe/Moscow", objective: "Review this bounded history" });
const message = (id: number, text = "source " + id) => new Api.Message({ id, date: id - 900, message: text,
  peerId: new Api.PeerChannel({ channelId: bigInt(12345678) }), fromId: new Api.PeerUser({ userId: bigInt(authorId) }) });
async function storedPage(messages: Api.TypeMessage[], inaccessible = false): Promise<StandingHistoryStoredPage> {
  const reader = createSelfHistoryReader({ binding: { accountId, peerId: intent().chatId }, self: new Api.User({ id: bigInt(accountId), self: true }),
    peer: new Api.InputPeerChannel({ channelId: bigInt(12345678), accessHash: bigInt(999) }), signal: new AbortController().signal,
    client: { async invoke(request: Api.AnyRequest) {
      assert.ok(request instanceof Api.messages.GetHistory);
      if (inaccessible) throw { errorMessage: "CHANNEL_PRIVATE" };
      return new Api.messages.Messages({ messages: [...messages].sort((a, b) => b.id - a.id), users: [new Api.User({ id: bigInt(authorId), firstName: "Саша" })], chats: [] });
    } } });
  try { return { index: 1, hash: "a".repeat(64), result: snapshotStandingHistoryTaskPage(await reader.readTaskPage({ fromDate: 100, toDate: 1000 })) }; }
  finally { reader.close(); }
}
const project = (stored: StandingHistoryStoredPage, extra: Partial<Parameters<typeof projectStandingHistorySource>[0]> = {}) =>
  projectStandingHistorySource({ intent: intent(), referenceKey, storedPage: stored, ...extra });
const refused = (code: string) => (e: unknown) => e instanceof StandingHistorySourceProjectionError && e.code === code;
function aliasReplacement(stored: StandingHistoryStoredPage): StandingHistoryStoredPage {
  const copy = structuredClone(stored), aliases = new Map<string, string>(); let n = 1;
  const alias = (ref: string) => { if (!aliases.has(ref)) aliases.set(ref, ref.slice(0, 2) + (n++).toString(16).padStart(24, "0")); return aliases.get(ref)!; };
  for (const row of copy.result.page.messages) {
    const m = row as unknown as Record<string, unknown>; m.ref = alias(row.ref); m.authorRef = alias(row.authorRef);
    if (row.replyRef !== null) m.replyRef = alias(row.replyRef);
  }
  for (const row of copy.result.sources) if (row.messageRef) (row as { messageRef: string }).messageRef = alias(row.messageRef);
  return { ...copy, hash: "b".repeat(64) };
}

test("source speaker and observed-version references survive reconnect aliases and changed page hash", async () => {
  const old = message(1001), reply = message(1002); reply.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 1001 });
  const stored = await storedPage([old, reply]), first = project(stored), reconnected = project(aliasReplacement(stored));
  assert.deepEqual(reconnected.rows, first.rows); assert.notEqual(reconnected.materialRef, first.materialRef); assert.notEqual(reconnected.pageHash, first.pageHash);
  assert.equal(first.rows[0]!.disposition, "included");
  if (first.rows[0]!.disposition !== "included") throw Error();
  assert.equal(first.rows[0]!.replySourceRef, first.rows[1]!.sourceRef); assert.equal(first.rows[0]!.replyContentAvailable, true);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /"(?:messageId|authorId|accountId|chatId|requesterId|primaryMessageId|offsetId|referenceKey|beforeCheckpoint|nextCheckpoint)"/u);
  assert.equal(serialized.includes(accountId), false); assert.equal(serialized.includes(authorId), false); assert.equal(serialized.includes(referenceKey), false);
  for (const row of stored.result.page.messages) { assert.equal(serialized.includes(row.ref), false); assert.equal(serialized.includes(row.authorRef), false); }
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.rows) && first.rows.every(Object.isFrozen));
});

test("logical identity is stable while edits content author observations and reply change version identity", async () => {
  const source = message(1002), earlier = message(1001), stored = await storedPage([source, earlier]), base = project(stored);
  for (const variant of ["text", "edit", "name", "author", "reply", "unavailable-reply"] as const) {
    const copy = structuredClone(stored), row = copy.result.page.messages[1]! as unknown as Record<string, unknown>;
    if (variant === "text") row.text = "Changed observation";
    if (variant === "edit") row.editedAt = 400;
    if (variant === "name") row.displayName = "Новое имя";
    if (variant === "author") row.author = "bot";
    if (variant === "reply") { row.replyRef = copy.result.page.messages[0]!.ref; (copy.result.sources[0] as { replyToMessageId: number }).replyToMessageId = 1001; }
    if (variant === "unavailable-reply") row.replyUnavailable = true;
    const changed = project(copy); assert.equal(changed.rows[0]!.sourceRef, base.rows[0]!.sourceRef, variant);
    assert.notEqual(changed.rows[0]!.versionRef, base.rows[0]!.versionRef, variant); assert.deepEqual(changed.rows[1], base.rows[1]);
  }
});

test("references and positions are scoped to persisted key task and exact canonical material", async () => {
  const stored = await storedPage(Array.from({ length: 8 }, (_, i) => message(1000 + i, "x".repeat(1800))));
  const base = project(stored, { maxBytes: 8192 }); assert.ok(base.nextPosition);
  for (const extra of [{ referenceKey: "02".repeat(32) }, { intent: { ...intent(), taskId: "htask_" + "2".repeat(48) } }]) {
    const other = project(stored, extra); assert.notEqual(other.rows[0]!.sourceRef, base.rows[0]!.sourceRef);
    assert.notEqual(other.rows[0]!.versionRef, base.rows[0]!.versionRef);
    if (other.rows[0]!.disposition === "included" && base.rows[0]!.disposition === "included") assert.notEqual(other.rows[0]!.speakerRef, base.rows[0]!.speakerRef);
    assert.throws(() => project(stored, { ...extra, position: base.nextPosition! }), refused("position"));
  }
  assert.throws(() => project({ ...stored, hash: "c".repeat(64) }, { position: base.nextPosition! }), refused("position"));
  const changed = structuredClone(stored); (changed.result.page.messages[0] as { text: string }).text = "Changed within same supplied hash";
  assert.throws(() => project(changed, { position: base.nextPosition! }), refused("position"));
  const tampered = base.nextPosition!.replace(/hpos_\d+_/u, "hpos_7_"); assert.throws(() => project(stored, { position: tampered }), refused("position"));
  const reordered = Object.fromEntries(Object.entries(stored).reverse()) as unknown as StandingHistoryStoredPage;
  assert.deepEqual(project(reordered), project(stored));
});

test("complete-row fragments include all metadata in byte budget with exact ranges and no lost source rows", async () => {
  const stored = await storedPage(Array.from({ length: 12 }, (_, i) => message(1000 + i, "🙂".repeat(700)))), all: StandingHistorySourceFragment[] = [];
  let position: string | undefined, end = 0;
  do {
    const part = project(stored, { maxBytes: 8192, ...(position ? { position } : {}) }); all.push(part);
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 8192); assert.equal(part.range.fromRow, end); assert.ok(part.range.toRow > end);
    assert.equal(part.range.toRow - part.range.fromRow, part.rows.length); assert.equal(part.range.totalRows, 12); end = part.range.toRow;
    assert.equal(part.coverage.fragmentComplete, part.nextPosition === null); position = part.nextPosition ?? undefined;
  } while (position);
  assert.equal(end, 12); assert.ok(all.length > 1);
  assert.equal(new Set(all.map(part => part.materialRef)).size, all.length);
  assert.equal(project(stored, { maxBytes: 8192 }).materialRef, all[0]!.materialRef);
  assert.deepEqual(all.flatMap(part => part.rows), project(stored).rows); assert.equal(new Set(all.flatMap(part => part.rows.map(row => row.sourceRef))).size, 12);
  for (const part of all) for (const row of part.rows) { assert.equal(row.disposition, "included"); if (row.disposition === "included") assert.equal(row.text, "🙂".repeat(700)); }
});

test("48KiB counts escaped text and final metadata and an oversized first row is refused without skipping", async () => {
  const stored = await storedPage([message(1001, "\u0001".repeat(4096)), message(1000, "\u0001".repeat(4096))]);
  assert.equal(stored.result.sources.length, 2); const first = project(stored); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 49152);
  assert.equal(first.rows.length, 1); assert.equal(first.range.toRow, 1); assert.ok(first.nextPosition);
  const second = project(stored, { position: first.nextPosition! }); assert.equal(second.rows.length, 1); assert.equal(second.range.fromRow, 1); assert.equal(second.nextPosition, null);
  assert.throws(() => project(stored, { maxBytes: 8192 }), refused("limit"));
  assert.throws(() => project(stored, { maxBytes: 8192, position: first.nextPosition! }), refused("limit"));
  assert.throws(() => project(stored, { maxBytes: 49153 }), refused("input"));
});

test("reply content is available only for included targets in the actual returned fragment", async () => {
  const target = message(1000, "x".repeat(1800)), reply = message(1001, "x".repeat(1800)); reply.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 1000 });
  const stored = await storedPage([target, reply]), full = project(stored); const first = project(stored, { maxBytes: 4500 });
  assert.equal(first.rows.length, 1); assert.equal(first.rows[0]!.disposition, "included");
  if (first.rows[0]!.disposition !== "included" || full.rows[0]!.disposition !== "included") throw Error();
  assert.equal(first.rows[0]!.replySourceRef, full.rows[1]!.sourceRef); assert.equal(first.rows[0]!.replyContentAvailable, false); assert.equal(full.rows[0]!.replyContentAvailable, true);
  assert.equal(first.rows[0]!.versionRef, full.rows[0]!.versionRef);
  const excluded = await storedPage([new Api.MessageEmpty({ id: 1000 }), reply]), withExcluded = project(excluded);
  if (withExcluded.rows[0]!.disposition !== "included") throw Error();
  assert.equal(withExcluded.rows[0]!.replySourceRef, withExcluded.rows[1]!.sourceRef); assert.equal(withExcluded.rows[0]!.replyContentAvailable, false);
  const external = await storedPage([reply]), externalProjection = project(external);
  if (externalProjection.rows[0]!.disposition !== "included") throw Error();
  assert.equal(externalProjection.rows[0]!.replySourceRef, full.rows[1]!.sourceRef); assert.equal(externalProjection.rows[0]!.replyContentAvailable, false);
});

test("empty inaccessible and excluded pages preserve source coverage without inventing analysis completion", async () => {
  for (const inaccessible of [false, true]) {
    const result = project(await storedPage([], inaccessible)); assert.deepEqual(result.rows, []); assert.equal(result.nextPosition, null);
    assert.deepEqual(result.range, { fromRow: 0, toRow: 0, totalRows: 0 }); assert.equal(result.coverage.fragmentComplete, true);
    assert.equal(result.coverage.sourcePageStatus, inaccessible ? "inaccessible" : "empty-page"); assert.equal(result.coverage.sourcePageCoverage.traversalComplete, !inaccessible);
  }
  const stored = await storedPage([new Api.MessageEmpty({ id: 1001 }), new Api.MessageService({ id: 1000, date: 100, peerId: new Api.PeerChannel({ channelId: bigInt(12345678) }), action: new Api.MessageActionEmpty() })]);
  const result = project(stored); assert.deepEqual(result.rows.map(row => row.disposition), ["unavailable", "nonText"]);
  assert.ok(result.rows.every(row => !("text" in row))); assert.equal(result.coverage.sourcePageExcluded.unavailable, 1); assert.equal(result.coverage.sourcePageExcluded.nonText, 1);
  assert.equal(result.coverage.sourcePageCoverage.undatedEntries, 1); assert.equal(result.coverage.sourcePageCoverage.traversalComplete, false);
  assert.equal(result.coverage.sourcePageStatus, "more"); assert.equal(result.coverage.fragmentComplete, true);
});

test("forged scope inconsistent joins and accessor proxy or extra-field graphs are rejected before projection", async () => {
  const stored = await storedPage([message(1000)]); let accessed = 0;
  for (const edit of [{ accountId: "111" }, { chatId: "-222" }, { fromDate: 101 }, { toDate: 1001 }]) assert.throws(() => project(stored, { intent: { ...intent(), ...edit } }), refused("binding"));
  assert.throws(() => project({ ...stored, index: 2 }), refused("binding"));
  assert.throws(() => project({ ...stored, hash: "not-a-hash" }), refused("input"));
  const corrupted = structuredClone(stored); (corrupted.result.sources[0] as { messageRef: string }).messageRef = "m_" + "0".repeat(24);
  assert.throws(() => project(corrupted), refused("input"));
  const getter = structuredClone(stored); Object.defineProperty(getter.result.page.messages[0], "text", { enumerable: true, get() { accessed++; return "private"; } });
  assert.throws(() => project(getter), refused("input"));
  assert.throws(() => project(new Proxy(stored, { ownKeys() { accessed++; return []; } })), refused("input"));
  const request = { intent: intent(), referenceKey, storedPage: stored }; Object.defineProperty(request, "referenceKey", { enumerable: true, get() { accessed++; return referenceKey; } });
  assert.throws(() => projectStandingHistorySource(request), refused("input"));
  assert.throws(() => project({ ...stored, unexpected: true } as never), refused("input")); assert.equal(accessed, 0);
  // A plausible hash alone is intentionally not checked as ciphertext authority.
  // Only a caller's authenticated readPage supplies that separate guarantee.
  assert.equal(project({ ...stored, hash: "f".repeat(64) }).pageHash, "f".repeat(64));
});

test("maxRows isolates a one-row gap including exclusions without changing omitted-field output or position identity", async () => {
  const stored = await storedPage([message(1002), new Api.MessageEmpty({ id: 1001 }), message(1000)]), all = project(stored);
  assert.deepEqual(project(stored, { maxRows: 100 }), all);
  const first = project(stored, { maxRows: 1 }); assert.deepEqual(first.range, { fromRow: 0, toRow: 1, totalRows: 3 });
  const gap = project(stored, { maxRows: 1, position: first.nextPosition! }); assert.deepEqual(gap.range, { fromRow: 1, toRow: 2, totalRows: 3 });
  assert.equal(gap.rows[0]!.disposition, "unavailable"); assert.ok(gap.nextPosition);
  const tail = project(stored, { maxRows: 1, position: gap.nextPosition! }); assert.deepEqual(tail.range, { fromRow: 2, toRow: 3, totalRows: 3 }); assert.equal(tail.nextPosition, null);
  assert.deepEqual([...first.rows, ...gap.rows, ...tail.rows], all.rows);
  assert.equal(project(stored, { maxRows: 2, position: gap.nextPosition! }).materialRef, tail.materialRef);
  assert.equal(project(stored, { maxRows: 1, maxBytes: 8192 }).nextPosition, first.nextPosition);
  assert.equal(JSON.stringify(first).includes('"maxRows"'), false);
});

test("maxRows rejects invalid or accessor values and still refuses an oversized whole first row", async () => {
  const stored = await storedPage([message(1000)]);
  for (const value of [0, 101, 1.5, "1", null, undefined, NaN, Infinity]) assert.throws(() => project(stored, { maxRows: value as number }), refused("input"));
  let accessed = 0; const request = { intent: intent(), referenceKey, storedPage: stored };
  Object.defineProperty(request, "maxRows", { enumerable: true, get() { accessed++; return 1; } });
  assert.throws(() => projectStandingHistorySource(request), refused("input")); assert.equal(accessed, 0);
  const large = await storedPage([message(1000, "\u0001".repeat(4096))]);
  assert.throws(() => project(large, { maxRows: 1, maxBytes: 8192 }), refused("limit"));
});
