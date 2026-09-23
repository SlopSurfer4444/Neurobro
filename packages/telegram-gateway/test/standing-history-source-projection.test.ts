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

test("explicit large source projection preserves full rows and old 48KiB descriptors exactly", async () => {
  const stored = await storedPage([message(1003, "я".repeat(8000)), message(1002, "я".repeat(8000)), message(1001, "я".repeat(8000))]);
  const legacy = project(stored, { maxBytes: 49152 });
  const large = project(stored, { maxBytes: 1048576 });
  assert.equal(large.rows.length, 3); assert.equal(large.nextPosition, null);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 49152); assert.ok(legacy.rows.length < large.rows.length);
  assert.deepEqual(project(stored), legacy); assert.deepEqual(project(stored, { maxBytes: 49152 }), legacy);
  assert.throws(() => project(stored, { maxBytes: 1048577 }), refused("input"));
});
const communityIntent = (): StandingHistoryTaskIntent => ({ ...intent(), source: {
  kind: "observed-source", sourceRef: "community", workspaceId: "synthetic-workspace", peerId: "-10087654321" } });
function communityPage(stored: StandingHistoryStoredPage): StandingHistoryStoredPage {
  return { ...stored, result: { ...stored.result,
    beforeCheckpoint: { ...stored.result.beforeCheckpoint, chatId: communityIntent().source!.peerId },
    nextCheckpoint: { ...stored.result.nextCheckpoint, chatId: communityIntent().source!.peerId } } };
}

test("community source binds peer and workspace while keeping delivery identity private", async () => {
  const original = await storedPage([message(1001)]), stored = communityPage(original), selected = communityIntent();
  const result = project(stored, { intent: selected });
  assert.equal(result.sourceRef, "community"); assert.equal(result.sourceInterpretation, "quoted-source-not-request");
  assert.equal(result.rows[0]!.disposition, "included");
  const encoded = JSON.stringify(result);
  for (const privateValue of [selected.chatId, selected.source!.peerId, selected.source!.workspaceId, selected.requesterId]) assert.equal(encoded.includes(privateValue), false);
  assert.throws(() => project(original, { intent: selected }));
  assert.throws(() => project(stored));
  const other = project(stored, { intent: { ...selected, source: { ...selected.source!, workspaceId: "other-workspace" } } });
  assert.notEqual(other.rows[0]!.sourceRef, result.rows[0]!.sourceRef);
  assert.notEqual(other.rows[0]!.versionRef, result.rows[0]!.versionRef);
  if (other.rows[0]!.disposition === "included" && result.rows[0]!.disposition === "included") assert.notEqual(other.rows[0]!.speakerRef, result.rows[0]!.speakerRef);
  const legacy = project(original); assert.equal(Object.hasOwn(legacy, "sourceRef"), false); assert.equal(Object.hasOwn(legacy, "sourceInterpretation"), false);
});

test("community full text and signed speakers survive bounded fragments without lost bytes", async () => {
  const stored = structuredClone(communityPage(await storedPage([message(1001), message(1002), message(1003)])));
  const fullText = "🙂".repeat(4096);
  for (const row of stored.result.page.messages) (row as { text: string }).text = fullText;
  for (const row of stored.result.sources) (row as { authorId: string }).authorId = "-10087654321";
  const fragments: StandingHistorySourceFragment[] = []; let position: string | undefined;
  do {
    const part = project(stored, { intent: communityIntent(), ...(position ? { position } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 49152); fragments.push(part); position = part.nextPosition ?? undefined;
  } while (position);
  assert.ok(fragments.length > 1); const rows = fragments.flatMap(part => part.rows); assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(row => row.sourceRef)).size, 3);
  for (const row of rows) { assert.equal(row.disposition, "included"); if (row.disposition === "included") assert.equal(row.text, fullText); }
  assert.equal(fragments[0]!.range.fromRow, 0); assert.equal(fragments.at(-1)!.range.toRow, 3);
});

test("forward provenance remains distinct from the actual participant and changes only observed version", async () => {
  const stored = structuredClone(await storedPage([message(1001, "Original source complaint")]));
  const before = project(stored);
  const forwarding = { originalDate: 90, sourceName: "Original complainant", interpretation: "quoted-source-not-request" as const };
  (stored.result.page.messages[0] as { forwarded: typeof forwarding }).forwarded = forwarding;
  const after = project(stored), first = before.rows[0]!, forwarded = after.rows[0]!;
  assert.equal(first.disposition, "included"); assert.equal(forwarded.disposition, "included");
  if (first.disposition !== "included" || forwarded.disposition !== "included") return;
  assert.deepEqual(forwarded.forwarded, forwarding); assert.equal(forwarded.displayName, "Саша");
  assert.equal(forwarded.speakerRef, first.speakerRef); assert.equal(forwarded.sourceRef, first.sourceRef);
  assert.notEqual(forwarded.versionRef, first.versionRef); assert.equal(Object.hasOwn(first, "forwarded"), false);
  forwarding.sourceName = "Different original speaker";
  assert.notEqual(project(stored).rows[0]!.versionRef, forwarded.versionRef);
  assert.equal(forwarded.forwarded!.sourceName, "Original complainant"); assert.ok(Object.isFrozen(forwarded.forwarded));
});
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
  assert.throws(() => project(stored, { maxBytes: 1048577 }), refused("input"));
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

test("linear byte selection is exactly equivalent to serialized candidates across 100 escaped Unicode rows", async () => {
  const token = '🙂漢字 "quoted" \\path\n\t';
  const messages = Array.from({ length: 100 }, (_, i) => {
    const item = message(1000 + i, `row ${i}: 🙂 "q" \\path\n${i % 25 === 0 ? token.repeat(8) : ""}`);
    if (i > 0) item.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 1000 });
    return item;
  });
  const stored = await storedPage(messages), bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const candidates = Array.from({ length: 100 }, (_, i) => project(stored, { maxRows: i + 1 }));
  assert.deepEqual(candidates.map(candidate => candidate.range.toRow), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.ok(bytes(candidates.at(-1)) <= 49152);

  const reference = (available: readonly StandingHistorySourceFragment[], maxBytes: number, maxRows = available.length) => {
    let selected: StandingHistorySourceFragment | undefined;
    for (const candidate of available.slice(0, maxRows)) {
      if (bytes(candidate) > maxBytes) break;
      selected = candidate;
    }
    return selected;
  };
  const assertEquivalent = (available: readonly StandingHistorySourceFragment[], maxBytes: number, maxRows: number,
    extra: Partial<Parameters<typeof projectStandingHistorySource>[0]> = {}) => {
    const expected = reference(available, maxBytes, maxRows);
    if (expected === undefined) assert.throws(() => project(stored, { ...extra, maxBytes, maxRows }), refused("limit"));
    else assert.deepEqual(project(stored, { ...extra, maxBytes, maxRows }), expected);
  };

  const thresholds = new Set<number>([1024, 8192, 49152]);
  for (const candidate of candidates) for (const value of [bytes(candidate) - 1, bytes(candidate), bytes(candidate) + 1]) {
    if (value >= 1024 && value <= 49152) thresholds.add(value);
  }
  for (const maxBytes of thresholds) assertEquivalent(candidates, maxBytes, 100);
  for (const maxRows of [1, 17, 53, 99, 100]) for (const maxBytes of [1024, 8192, 32768, 49152]) {
    assertEquivalent(candidates, maxBytes, maxRows);
  }

  const terminal = candidates.at(-1)!, penultimate = candidates.at(-2)!;
  const counterfactualTerminal = { ...terminal, nextPosition: "hpos_100_" + "0".repeat(48),
    coverage: { ...terminal.coverage, fragmentComplete: false } };
  assert.ok(bytes(terminal) < bytes(counterfactualTerminal));
  assert.ok(bytes(penultimate) <= bytes(terminal));
  assert.deepEqual(project(stored, { maxBytes: bytes(terminal), maxRows: 100 }), terminal);
  assert.throws(() => project(stored, { maxBytes: 1024, maxRows: 100 }), refused("limit"));

  const position = candidates[36]!.nextPosition!;
  const suffix = Array.from({ length: 63 }, (_, i) => project(stored, { position, maxRows: i + 1 }));
  assert.equal(suffix[0]!.range.fromRow, 37); assert.equal(suffix.at(-1)!.nextPosition, null);
  for (let i = 0; i < suffix.length; i += 7) {
    const boundary = bytes(suffix[i]);
    for (const maxBytes of [boundary - 1, boundary]) if (maxBytes >= 1024 && maxBytes <= 49152) {
      assertEquivalent(suffix, maxBytes, 63, { position });
    }
  }
  for (const row of terminal.rows) {
    assert.equal(row.disposition, "included");
    if (row.disposition === "included") assert.equal(row.text, messages.find(item => item.id === Number(row.date) + 900)!.message);
  }
});
