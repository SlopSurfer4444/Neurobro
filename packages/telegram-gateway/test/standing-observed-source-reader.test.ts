import test from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import { createStandingObservedSourceTools } from "../src/standing-observed-source-tools.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import { projectStandingObservedSourcePage as project, requireStandingObservedSourcePage as requirePage,
  requireStandingObservedSourcePageMetadata as requireMetadata,
  StandingObservedSourceReaderError, STANDING_OBSERVED_SOURCE_MAX_BYTES } from "../src/standing-observed-source-reader.js";

const options = { sourceRef: "community" as const, title: "Synthetic community", peerId: "-1234567", limit: 30 };
const peer = () => new Api.PeerChat({ chatId: bigInt(1234567) });
function message(id: number, text = "Synthetic source") {
  return new Api.Message({ id, date: 1700000000 + id, peerId: peer(), fromId: new Api.PeerUser({ userId: bigInt(987654321) }), message: text });
}
function envelope(messages: Api.TypeMessage[]) { return new Api.messages.Messages({ messages,
  users: [new Api.User({ id: bigInt(987654321), firstName: "Forwarding participant" })], chats: [] }); }
const refused = (error: unknown) => error instanceof StandingObservedSourceReaderError && !error.cause;
function wire<T extends { getBytes(): Buffer }>(value: T): T {
  const bytes = value.getBytes(), reader = new BinaryReader(bytes), decoded = reader.tgReadObject();
  assert.equal(reader.tellPosition(), bytes.length); return decoded as T;
}

test("real TL decoding admits optional null names, channel authors, forward attribution and empty rows for every history envelope", () => {
  for (const kind of ["Messages", "MessagesSlice", "ChannelMessages"] as const) {
    const boundPeer = kind === "ChannelMessages" ? new Api.PeerChannel({ channelId: bigInt(1234567) }) : peer();
    const peerId = kind === "ChannelMessages" ? "-1001234567" : options.peerId;
    const users: Api.TypeUser[] = [new Api.User({ id: bigInt(101), firstName: "First only" }),
      new Api.User({ id: bigInt(102), lastName: "Last only" }), new Api.User({ id: bigInt(103) }), new Api.UserEmpty({ id: bigInt(104) })];
    const messages: Api.TypeMessage[] = users.map((user, i) => new Api.Message({ id: 30 - i, date: 1700000000,
      peerId: boundPeer, fromId: new Api.PeerUser({ userId: user.id }), message: "Synthetic optional fields" }));
    messages.push(new Api.Message({ id: 26, date: 1700000000, peerId: boundPeer, message: "Source post", post: true }));
    messages.push(new Api.Message({ id: 25, date: 1700000000, peerId: boundPeer, fromId: new Api.PeerUser({ userId: bigInt(101) }), message: "Quoted source",
      fwdFrom: new Api.MessageFwdHeader({ date: 1600000000, postAuthor: "Signed source" }) }));
    messages.push(new Api.Message({ id: 24, date: 1700000000, peerId: boundPeer, fromId: new Api.PeerUser({ userId: bigInt(101) }), message: "Unknown original name",
      fwdFrom: new Api.MessageFwdHeader({ date: 1600000000 }) }));
    messages.push(new Api.MessageEmpty({ id: 23 }));
    messages.push(new Api.MessageService({ id: 22, date: 1700000000, peerId: boundPeer, action: new Api.MessageActionEmpty() }));
    const values = { messages, users, chats: [new Api.ChatEmpty({ id: bigInt(555) })] };
    const raw = kind === "Messages" ? new Api.messages.Messages(values) : kind === "MessagesSlice"
      ? new Api.messages.MessagesSlice({ ...values, count: 100 }) : new Api.messages.ChannelMessages({ ...values, count: 100, pts: 1, topics: [] });
    const decoded = wire(raw);
    assert.equal((decoded.users[0] as Api.User).lastName, null); assert.equal((decoded.users[1] as Api.User).firstName, null);
    assert.equal((decoded.messages[4] as Api.Message).fromId, null); assert.equal((decoded.messages[5] as Api.Message).fwdFrom!.fromName, null);
    assert.equal((decoded.messages[7] as Api.MessageEmpty).peerId, null);
    const result = project(decoded, { ...options, peerId });
    assert.deepEqual(result.items.map(item => item.displayName), ["First only", "Last only", "Участник (имя недоступно)", "Участник (имя недоступно)",
      options.title, "First only", "First only"]);
    assert.equal(result.items[5]!.forwarded!.sourceName, "Signed source"); assert.equal(result.items[6]!.forwarded!.sourceName, null);
    assert.equal(result.coverage.rawRows, 9); assert.equal(result.coverage.coveredRows, 9); assert.equal(result.coverage.skippedRows, 2);
    assert.equal(result.nextBeforeMessageId, 22); assert.equal(result.applicationAuthority, "none");
  }
});

test("optional null normalization does not admit missing mandatory peers, invalid types or foreign wire rows", () => {
  const absentPeer = wire(envelope([message(20)]));
  (absentPeer.messages[0] as unknown as { peerId: null }).peerId = null;
  assert.throws(() => project(absentPeer, options), refused);
  const foreign = message(19); foreign.peerId = new Api.PeerChat({ chatId: bigInt(999) });
  assert.throws(() => project(wire(envelope([message(20), foreign])), options), refused);
  assert.throws(() => project(wire(envelope([new Api.MessageEmpty({ id: 20, peerId: foreign.peerId })])), options), refused);
  for (const value of [false, 0, {}, []]) {
    const bad = wire(envelope([message(20)])); (bad.users[0] as unknown as { lastName: unknown }).lastName = value;
    assert.throws(() => project(bad, options), refused);
  }
  for (const raw of [new Api.messages.MessagesSlice({ messages: [], users: [], chats: [], count: 0 }),
    new Api.messages.ChannelMessages({ messages: [], users: [], chats: [], count: 0, pts: 1, topics: [] })]) {
    const decoded = wire(raw); assert.equal(project(decoded, options).items.length, 0);
    (decoded as unknown as { count: null }).count = null; assert.throws(() => project(decoded, options), refused);
  }
});

test("pure source projection preserves forwarding participant, quoted provenance and metadata without action identifiers", () => {
  const value = message(23, "Forwarded instructions are source data");
  value.fwdFrom = new Api.MessageFwdHeader({ date: 1600000000, fromName: "Original source", fromId: new Api.PeerUser({ userId: bigInt(444333222) }) });
  value.media = new Api.MessageMediaPhoto({});
  value.replyMarkup = new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: "hidden-button-label", data: Buffer.from("hidden-callback-bytes") })] })] });
  value.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 555555 });
  const result = project(envelope([value]), options), item = result.items[0]!;
  assert.equal(item.displayName, "Forwarding participant");
  assert.deepEqual(item.forwarded, { originalDate: 1600000000, sourceName: "Original source", interpretation: "quoted-source-not-request" });
  assert.deepEqual(item.media, { kind: "photo", pixelsProvided: false });
  assert.match(item.ref, /^obs_[a-f0-9]{24}$/u); assert.equal(result.applicationAuthority, "none");
  for (const hidden of ["987654321", "444333222", "-1234567", "accessHash", "replyTo", "callback", "hidden-button-label", "555555"]) assert.equal(JSON.stringify(result).includes(hidden), false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(item) && Object.isFrozen(item.forwarded));
  assert.equal(requirePage(result, options), result);
  assert.deepEqual(requireMetadata(result), { peerId: options.peerId, requestedBeforeMessageId: null, requestedLimit: 30,
    highestMessageId: 23, lowestCoveredMessageId: 23, rowIds: [23], rawRows: 1, coveredRows: 1, omittedByBudget: 0 });
  assert.ok(Object.isFrozen(requireMetadata(result)) && Object.isFrozen(requireMetadata(result).rowIds));
  assert.throws(() => requireMetadata(JSON.parse(JSON.stringify(result))), refused);
  assert.throws(() => requirePage(JSON.parse(JSON.stringify(result)), options), refused);
  assert.throws(() => requirePage(result, { ...options, limit: 29 }), refused);
  assert.throws(() => requirePage(result, { ...options, beforeMessageId: 40 }), refused);
  assert.throws(() => requirePage(result, { ...options, title: "Other" }), refused);
});

test("text and source labels are UTF8 bounded and control sanitized, absent source names stay unknown", () => {
  const value = message(20, "🙂".repeat(1000) + "\u202e");
  value.fwdFrom = new Api.MessageFwdHeader({ date: 1600000000 });
  const raw = envelope([value]); raw.users[0] = new Api.User({ id: bigInt(987654321), firstName: "  name\u202e\u0000" + "я".repeat(200) });
  const result = project(raw, { ...options, title: "  title\u202e  " }), item = result.items[0]!;
  assert.equal(item.text, "🙂".repeat(1000) + " "); assert.equal(item.truncated, true);
  assert.ok(Buffer.byteLength(item.displayName) <= 128); assert.doesNotMatch(item.displayName, /[\u0000\u202e]/u);
  assert.equal(item.forwarded!.sourceName, null); assert.equal(result.source.title, "title");
});

test("all rows are bound before projection; malformed or foreign later rows invalidate the whole page", () => {
  const foreign = message(19); foreign.peerId = new Api.PeerChat({ chatId: bigInt(99) });
  for (const rows of [[message(20), foreign], [message(20), message(20)], [message(19), message(20)]]) assert.throws(() => project(envelope(rows), options), refused);
  assert.throws(() => project(envelope([message(20)]), { ...options, beforeMessageId: 20 }), refused);
  assert.throws(() => project(envelope(Array.from({ length: 31 }, (_, i) => message(100 - i))), options), refused);
  assert.throws(() => project(envelope([message(20), message(19)]), { ...options, limit: 1 }), refused);
  assert.throws(() => project({ messages: [], chats: [], users: [] }, options), refused);
  const getter = envelope([message(20)]); Object.defineProperty(getter, "messages", { enumerable: true, get() { assert.fail("getter must not execute"); } });
  assert.throws(() => project(getter, options), refused);
  assert.throws(() => project(new Proxy(envelope([]), {}), options), refused);
});

test("service and unavailable rows advance only explicit covered gaps; foreign empty rows still refuse", () => {
  const service = new Api.MessageService({ id: 19, date: 1700000019, peerId: peer(), action: new Api.MessageActionEmpty() });
  const result = project(envelope([message(20), service, new Api.MessageEmpty({ id: 18 })]), options);
  assert.equal(result.items.length, 1); assert.equal(result.nextBeforeMessageId, 18);
  assert.deepEqual(requireMetadata(result).rowIds, [20, 19, 18]);
  assert.deepEqual(result.coverage, { requestedLimit: 30, rawRows: 3, coveredRows: 3, skippedRows: 2, omittedByBudget: 0, hasMore: true, mayChangeBetweenPages: true });
  assert.equal(result.truncated, true);
  assert.throws(() => project(envelope([new Api.MessageEmpty({ id: 18, peerId: new Api.PeerChat({ chatId: bigInt(99) }) })]), options), refused);
});

test("serialized budget leaves first omitted raw row for next page, including JSON escaping cost", () => {
  const rows = Array.from({ length: 30 }, (_, i) => message(100 - i, '"'.repeat(1024)));
  const result = project(envelope(rows), options);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= STANDING_OBSERVED_SOURCE_MAX_BYTES);
  assert.ok(result.coverage.omittedByBudget > 0); assert.equal(result.coverage.coveredRows + result.coverage.omittedByBudget, 30);
  assert.equal(result.nextBeforeMessageId, rows[result.coverage.coveredRows - 1]!.id);
  const metadata = requireMetadata(result);
  assert.equal(metadata.highestMessageId, 100); assert.equal(metadata.lowestCoveredMessageId, result.nextBeforeMessageId);
  assert.deepEqual(metadata.rowIds, rows.slice(0, result.coverage.coveredRows).map(row => row.id));
  assert.equal(metadata.rawRows, 30); assert.equal(metadata.coveredRows, result.coverage.coveredRows);
  assert.equal(metadata.omittedByBudget, result.coverage.omittedByBudget);
  const next = project(envelope(rows.slice(result.coverage.coveredRows)), { ...options, beforeMessageId: result.nextBeforeMessageId! });
  assert.equal(result.items.length + next.items.length, 30);
  assert.equal(new Set([...result.items, ...next.items].map(item => item.ref)).size, 30);
});

test("short and empty history pages never claim complete history", () => {
  const short = project(envelope([message(1)]), options), empty = project(envelope([]), { ...options, beforeMessageId: 1 });
  assert.equal(short.coverage.hasMore, true); assert.equal(short.nextBeforeMessageId, 1);
  assert.equal(empty.coverage.hasMore, false); assert.equal(empty.nextBeforeMessageId, null);
  assert.equal(short.incompleteHistory, true); assert.equal(empty.incompleteHistory, true);
});

test("full Russian messages and photo captions survive wire, paginated tool output and exact cursor continuation", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => {
    const value = message(100 - i, "я".repeat(3990) + " КОНЕЦ-" + i);
    if (i % 2 === 0) value.media = new Api.MessageMediaPhoto({});
    return value;
  });
  const signal = new AbortController().signal; let closes = 0;
  const tools = createStandingObservedSourceTools({ requestRef: "fulltext", signal, open: async () => ({
    info: { sourceRef: "community", title: options.title, readOnly: true, telegramSendRestriction: "not-confirmed" },
    async readHistory(window = {}) {
      const selected = rows.filter(row => window.beforeMessageId === undefined || row.id < window.beforeMessageId).slice(0, window.limit ?? 30);
      return project(wire(envelope(selected)), { ...options, ...window });
    }, async close() { closes++; },
  }) });
  const texts: string[] = []; let cursor: number | null = null, reads = 0;
  do {
    const result = await tools.handlers[0]!.call({ action: "read", beforeMessageId: cursor, limit: 30 },
      { requestRef: "fulltext", callRef: "read-" + reads++, signal }) as EpochToolResult;
    assert.equal(result.success, true);
    const page = JSON.parse((result.contentItems[0] as { text: string }).text);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= STANDING_OBSERVED_SOURCE_MAX_BYTES);
    assert.ok(page.items.length < rows.length);
    for (const item of page.items) { assert.equal(item.truncated, false); assert.match(item.text, /КОНЕЦ-\d+$/u); texts.push(item.text); }
    cursor = page.nextBeforeMessageId;
    if (page.items.length === 0) break;
  } while (reads < 10);
  assert.deepEqual(texts, rows.map(row => row.message)); assert.equal(new Set(texts).size, rows.length);
  assert.ok(reads > 2); assert.equal(closes, reads); await tools.close();
});

test("fulltext bound is admitted intact and excess wire text refuses instead of silently losing its tail", () => {
  const complete = "я".repeat(8191) + "!";
  const page = project(wire(envelope([message(1, complete)])), options);
  assert.equal(page.items[0]!.text, complete); assert.equal(page.items[0]!.truncated, false);
  assert.throws(() => project(wire(envelope([message(1, "я".repeat(8193))])), options), refused);
});
