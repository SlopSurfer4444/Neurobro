import test from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import { createStandingChatSearchLease, createStandingChatSearchTools, STANDING_CHAT_SEARCH_TOOL_SPEC,
  type StandingChatSearchLease, type StandingChatSearchSource } from "../src/standing-chat-search.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";

const requestRef = "request-1";
const search = { action: "search", source: "internal", query: "repair", fromDate: null, toDate: null, cursor: null, messageRef: null };
const peer = (source: StandingChatSearchSource) => new Api.InputPeerChat({ chatId: bigInt(source === "internal" ? 12345 : 67890) });
const peerId = (source: StandingChatSearchSource) => source === "internal" ? "-12345" : "-67890";
function message(id: number, text = "repair details", source: StandingChatSearchSource = "internal", date = 1700000000) {
  return new Api.Message({ id, date, peerId: new Api.PeerChat({ chatId: peer(source).chatId }), message: text });
}
function envelope(messages: Api.TypeMessage[]) { return new Api.messages.Messages({ messages, users: [], chats: [] }); }
function wire<T extends { getBytes(): Buffer }>(value: T): T {
  const bytes = value.getBytes(), reader = new BinaryReader(bytes), decoded = reader.tgReadObject();
  assert.equal(reader.tellPosition(), bytes.length); return decoded as T;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type PublicPage = { code?: string; nextCursor: string | null; source: { sourceRef: string }; items: Array<{ text: string; messageRef: string; media: { pixelsProvided: boolean } }>;
  anchor: { status: string } | null; coverage: { coveredRows: number; omittedByBudget: number }; incompleteHistory: boolean; noHitsDoesNotProveAbsence: boolean };
function body(result: EpochToolResult): PublicPage { return JSON.parse(result.contentItems[0].text) as PublicPage; }
function fixture(invoke?: (request: Api.AnyRequest, source: StandingChatSearchSource) => Promise<unknown>, openOverride?: (source: StandingChatSearchSource) => Promise<StandingChatSearchLease>) {
  const controller = new AbortController(); let opens = 0, closes = 0;
  const requests: Api.AnyRequest[] = [];
  const tools = createStandingChatSearchTools({ requestRef, signal: controller.signal, async open(source) {
    opens++; if (openOverride) return openOverride(source);
    const lease = createStandingChatSearchLease({ source, title: source === "internal" ? "Current chat" : "Optional source",
      peer: peer(source), binding: { accountId: "98765", peerId: peerId(source) }, signal: controller.signal,
      async invoke(request) { requests.push(request); return invoke ? invoke(request, source) : envelope([message(30, "repair details", source)]); } });
    return { read: lease.read, async close() { closes++; await lease.close(); } };
  } });
  const scope = { requestRef, callRef: "call-1", signal: controller.signal };
  const call = async (args: unknown = search, scopeValue = scope) => await tools.handlers[0]!.call(args, scopeValue) as EpochToolResult;
  return { tools, controller, scope, call, requests, opens: () => opens, closes: () => closes };
}

test("universal schema has the seven exact fields and explains iterative search, current chat and uncertainty", () => {
  assert.deepEqual(STANDING_CHAT_SEARCH_TOOL_SPEC.inputSchema.required, ["action", "source", "query", "fromDate", "toDate", "cursor", "messageRef"]);
  assert.equal(STANDING_CHAT_SEARCH_TOOL_SPEC.inputSchema.additionalProperties, false);
  assert.match(STANDING_CHAT_SEARCH_TOOL_SPEC.description, /synonyms/); assert.match(STANDING_CHAT_SEARCH_TOOL_SPEC.description, /current chat/);
});

test("two refined searches then opaque context use real peer-bound constructors and release every call", async () => {
  const f = fixture(async request => {
    if (request instanceof Api.messages.GetHistory) {
      assert.equal(request.offsetId, 25); assert.equal(request.addOffset, -15); assert.equal(request.limit, 30);
      return envelope([message(26, "earlier discussion"), message(25, "anchor"), message(24, "more context")]);
    }
    assert.ok(request instanceof Api.messages.Search); assert.ok(request.filter instanceof Api.InputMessagesFilterEmpty);
    return envelope([message(request.q === "repair" ? 30 : 25, request.q)]);
  });
  assert.equal(f.opens(), 0);
  const first = body(await f.call()), second = body(await f.call({ ...search, query: "replacement" }));
  assert.equal(first.items[0]!.text, "repair"); assert.equal(second.items[0]!.text, "replacement");
  const context = await f.call({ ...search, action: "context", query: null, messageRef: second.items[0]!.messageRef });
  assert.equal(context.success, true); assert.equal(body(context).anchor!.status, "available");
  assert.equal(body(context).source.sourceRef, "internal"); assert.equal(f.opens(), 3); assert.equal(f.closes(), 3);
  assert.equal(JSON.stringify(context).includes("-12345"), false); assert.equal(JSON.stringify(context).includes("messageId"), false);
  await f.tools.close();
});

test("actual binary decoded nullable fields retain full text and metadata in both chat and channel results", async () => {
  for (const channel of [false, true]) {
    const controller = new AbortController(), inputPeer = channel ? new Api.InputPeerChannel({ channelId: bigInt(12345), accessHash: bigInt(999) }) : peer("internal");
    const boundPeer = channel ? new Api.PeerChannel({ channelId: bigInt(12345) }) : new Api.PeerChat({ chatId: bigInt(12345) });
    const text = "я".repeat(7000);
    const values = { messages: [new Api.Message({ id: 12, date: 1700000000, peerId: boundPeer, message: text })],
      users: [new Api.User({ id: bigInt(99), firstName: "One name" })], chats: [] };
    const raw = wire(channel ? new Api.messages.ChannelMessages({ ...values, count: 1, pts: 1, topics: [] }) : new Api.messages.MessagesSlice({ ...values, count: 1 }));
    assert.equal((raw.messages[0] as Api.Message).fromId, null);
    const lease = createStandingChatSearchLease({ source: "internal", title: "Current chat", peer: inputPeer,
      binding: { accountId: "99", peerId: channel ? "-10012345" : "-12345" }, signal: controller.signal, async invoke() { return raw; } });
    const result = await lease.read({ action: "search", query: "я", fromDate: null, toDate: null, beforeMessageId: null });
    assert.equal(result.page.items[0]!.text, text); assert.equal(result.page.items[0]!.media.pixelsProvided, false);
    assert.equal(raw.messages.length, 0); await lease.close();
  }
});

test("cursor is single-use, request-local and exact source/query/date-bound; cross-source refs refuse before acquisition", async () => {
  const f = fixture(async (request, source) => envelope([message((request as Api.messages.Search).offsetId ? 29 : 30, "hit", source)]));
  const first = body(await f.call()); const cursor = first.nextCursor!;
  for (const changed of [{ source: "community" }, { query: "other" }, { fromDate: 10 }, { toDate: 20 }])
    assert.equal(body(await f.call({ ...search, ...changed, cursor })).code, "cursor-mismatch");
  assert.equal(body(await f.call({ ...search, action: "context", source: "community", query: null, messageRef: first.items[0]!.messageRef })).code, "source-mismatch");
  assert.equal(f.opens(), 1);
  assert.equal((await f.call({ ...search, cursor })).success, true);
  assert.equal((f.requests[1] as Api.messages.Search).offsetId, 30);
  assert.equal(body(await f.call({ ...search, cursor })).code, "expired-cursor");
  const other = fixture(); assert.equal(body(await other.call({ ...search, cursor: first.nextCursor })).code, "expired-cursor");
  await f.tools.close(); await other.tools.close();
});

test("whole-message budget pagination does not consume omitted hits and preserves complete 16KiB texts", async () => {
  const text = "x".repeat(16384), seen: string[] = [];
  const f = fixture(async request => {
    const before = (request as Api.messages.Search).offsetId || 35;
    return envelope(Array.from({ length: Math.min(4, before - 31) }, (_, i) => message(before - i - 1, text)));
  });
  let cursor: string | null = null;
  for (let i = 0; i < 4; i++) {
    const result = await f.call({ ...search, cursor }); assert.equal(result.success, true);
    assert.ok(Buffer.byteLength(result.contentItems[0].text) <= 48 * 1024);
    const page = body(result); for (const item of page.items) { assert.equal(item.text, text); seen.push(item.messageRef); }
    if (i === 0) { assert.ok(page.coverage.omittedByBudget > 0); assert.equal(page.coverage.coveredRows, 2); }
    cursor = page.nextCursor; if (cursor === null) break;
  }
  assert.equal(seen.length, 4); assert.equal((f.requests[1] as Api.messages.Search).offsetId, 33);
  await f.tools.close();
});

test("inclusive date boundaries are mapped explicitly and out-of-range returned material is refused", async () => {
  const f = fixture(async request => {
    assert.ok(request instanceof Api.messages.Search); assert.equal(request.minDate, 99); assert.equal(request.maxDate, 201);
    return envelope([message(30, "upper", "internal", 200), message(29, "lower", "internal", 100)]);
  });
  assert.equal((await f.call({ ...search, fromDate: 100, toDate: 200 })).success, true); await f.tools.close();
  const bad = fixture(async () => envelope([message(30, "out of requested dates", "internal", 201)]));
  assert.equal(body(await bad.call({ ...search, fromDate: 100, toDate: 200 })).code, "unavailable"); await bad.tools.close();
});

test("search envelope overhead alone omits a whole source-admitted row without advancing past it", async () => {
  const text = "x".repeat(16060);
  const response = (before = 31) => envelope([30, 29, 28].filter(value => value < before).map(value => message(value, text)));
  const lease = createStandingChatSearchLease({ source: "internal", title: "Current chat", peer: peer("internal"),
    binding: { accountId: "99", peerId: peerId("internal") }, signal: new AbortController().signal, async invoke() { return response(); } });
  const source = await lease.read({ action: "search", query: "repair", fromDate: null, toDate: null, beforeMessageId: null });
  assert.equal(source.page.items.length, 3); assert.equal(source.metadata.omittedByBudget, 0); await lease.close();
  const f = fixture(async request => response((request as Api.messages.Search).offsetId || 31));
  const first = await f.call(); assert.equal(first.success, true);
  const page = body(first); assert.equal(page.items.length, 2); assert.equal(page.coverage.omittedByBudget, 1);
  assert.ok(Buffer.byteLength(first.contentItems[0].text) <= 48 * 1024);
  const second = body(await f.call({ ...search, cursor: page.nextCursor }));
  assert.equal((f.requests[1] as Api.messages.Search).offsetId, 29);
  assert.equal(second.items.length, 1); assert.equal(second.items[0]!.text, text); await f.tools.close();
});

test("empty search is explicitly incomplete and absent context anchor is unavailable", async () => {
  let calls = 0; const f = fixture(async () => ++calls === 1 ? envelope([message(30)]) : envelope([]));
  const found = body(await f.call());
  const context = body(await f.call({ ...search, action: "context", query: null, messageRef: found.items[0]!.messageRef }));
  assert.equal(context.anchor!.status, "unavailable");
  const empty = body(await f.call()); assert.equal(empty.nextCursor, null); assert.equal(empty.items.length, 0);
  assert.equal(empty.incompleteHistory, true); assert.equal(empty.noHitsDoesNotProveAbsence, true); await f.tools.close();
});

test("foreign-peer, overlapping/nonprogressing, unsupported envelopes and forged pages are refused", async () => {
  for (const response of [() => envelope([message(30, "foreign", "community")]), () => new Api.messages.MessagesNotModified({ count: 1 })]) {
    const f = fixture(async () => response()); assert.equal(body(await f.call()).code, "unavailable"); assert.equal(f.closes(), 1); await f.tools.close();
  }
  const stale = fixture(); const first = body(await stale.call());
  assert.equal(body(await stale.call({ ...search, cursor: first.nextCursor })).code, "unavailable"); await stale.tools.close();
  let releases = 0;
  const forged = fixture(undefined, async () => ({ async read() { return {} as never; }, async close() { releases++; } }));
  assert.equal(body(await forged.call()).code, "unavailable"); assert.equal(releases, 1); await forged.tools.close();
});

test("invalid arguments, getters, foreign scope and arbitrary ids never acquire transport", async () => {
  const f = fixture();
  for (const args of [{ ...search, query: " " }, { ...search, query: " x" }, { ...search, query: "я".repeat(129) },
    { ...search, fromDate: 0 }, { ...search, toDate: 2147483647 }, { ...search, fromDate: 12, toDate: 11 },
    { ...search, peerId: "-7" }, { ...search, messageRef: "30" }, { ...search, cursor: "1" },
    { ...search, action: "context" }, { ...search, query: "x\n" }, new Proxy(search, {})])
    assert.equal(body(await f.call(args)).code, "invalid-arguments");
  const getter = { ...search }; Object.defineProperty(getter, "query", { enumerable: true, get() { assert.fail("getter invoked"); } });
  assert.equal(body(await f.call(getter)).code, "invalid-arguments");
  assert.equal(body(await f.call(search, { ...f.scope, requestRef: "other-request" })).code, "invalid-scope");
  assert.equal(f.opens(), 0); await f.tools.close();
});

test("bounded cursor and message-ref tables explicitly expire oldest capabilities", async () => {
  const f = fixture(async () => envelope(Array.from({ length: 30 }, (_, i) => message(100 - i))));
  const first = body(await f.call());
  for (let i = 0; i < 32; i++) assert.equal((await f.call()).success, true);
  assert.equal(body(await f.call({ ...search, cursor: first.nextCursor })).code, "expired-cursor");
  assert.equal(body(await f.call({ ...search, action: "context", query: null, messageRef: first.items[0]!.messageRef })).code, "expired-message-ref");
  await f.tools.close();
});

test("abort/close during acquisition joins late release without dispatch", async () => {
  const entered = deferred<void>(), acquired = deferred<StandingChatSearchLease>(), released = deferred<void>(); let closes = 0, reads = 0;
  const f = fixture(undefined, async () => { entered.resolve(); return acquired.promise; });
  const pending = f.call(); await entered.promise; f.controller.abort();
  let done = false; const closing = f.tools.close().then(() => { done = true; });
  acquired.resolve({ async read() { reads++; return {} as never; }, async close() { closes++; await released.promise; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); assert.equal(reads, 0); assert.equal(closes, 1);
  released.resolve(); await closing; assert.equal(body(await pending).code, "stopped");
});

test("busy calls cannot acquire another lease, and cancellation joins the outstanding policy invocation", async () => {
  const entered = deferred<void>(), returned = deferred<void>();
  const f = fixture(async () => { entered.resolve(); await returned.promise; return envelope([message(30)]); });
  const pending = f.call(); await entered.promise;
  assert.equal(body(await f.call()).code, "busy"); assert.equal(f.opens(), 1);
  let done = false; const closing = f.tools.close().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false); assert.equal(f.closes(), 1);
  returned.resolve(); await closing; assert.equal(body(await pending).code, "stopped");
});

test("release failure withholds result, revokes capabilities and remains observable from close", async () => {
  const f = fixture(undefined, async source => {
    const lease = createStandingChatSearchLease({ source, title: "Current chat", peer: peer(source), binding: { accountId: "99", peerId: peerId(source) },
      signal: new AbortController().signal, async invoke() { return envelope([message(30)]); } });
    return { read: lease.read, async close() { await lease.close(); throw Error("private release details"); } };
  });
  const result = await f.call(); assert.equal(body(result).code, "unavailable"); assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(body(await f.call()).code, "stopped"); await assert.rejects(f.tools.close());
});
