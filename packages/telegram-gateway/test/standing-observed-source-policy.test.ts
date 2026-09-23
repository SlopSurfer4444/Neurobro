import test from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import { createStandingObservedSourcePolicy, StandingObservedSourcePolicyError } from "../src/standing-observed-source-policy.js";

const wire = (value: { getBytes(): Buffer }) => new BinaryReader(value.getBytes()).tgReadObject();
const refused = (code: StandingObservedSourcePolicyError["code"]) => (error: unknown) =>
  error instanceof StandingObservedSourcePolicyError && error.code === code && !error.cause;
const channel = () => new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(987) });
const chat = () => new Api.InputPeerChat({ chatId: bigInt(123) });
const history = (peer: Api.InputPeerChat | Api.InputPeerChannel = channel(), changes: Record<string, unknown> = {}) =>
  new Api.messages.GetHistory({ peer, offsetId: 100, offsetDate: 200, addOffset: 0, limit: 30, maxId: 300, minId: 10, hash: bigInt.zero, ...changes });
const search = (peer: Api.InputPeerChat | Api.InputPeerChannel = chat(), changes: Record<string, unknown> = {}) =>
  new Api.messages.Search({ peer, q: "нужный отзыв", filter: new Api.InputMessagesFilterEmpty(), minDate: 10, maxDate: 200,
    offsetId: 100, addOffset: 0, limit: 20, maxId: 300, minId: 1, hash: bigInt.zero, ...changes });
const response = () => new Api.messages.Messages({ messages: [new Api.MessageEmpty({ id: 100 })], users: [], chats: [] });

test("history and search are copied synchronously to exact bound peers and raw vectors are discarded after projection", async () => {
  for (const kind of ["history", "search"] as const) {
    const peer = kind === "history" ? channel() : chat(), calls: Api.AnyRequest[] = [], raw = response();
    const policy = createStandingObservedSourcePolicy({ client: { async invoke(request) { calls.push(request); wire(request); return raw; } },
      binding: { accountId: "7", peerId: kind === "history" ? "-100123" : "-123" }, peer, signal: new AbortController().signal });
    const request = kind === "history" ? history(peer) : search(peer);
    const work = policy.call(request, value => {
      assert.equal(value, raw); assert.equal(raw.messages.length, 1);
      return Object.freeze({ rows: raw.messages.length, source: "untrusted-data" });
    });
    // Mutating the caller-owned TL graph after call admission cannot redirect or
    // widen the delayed borrowed invocation.
    request.limit = 1; request.offsetId = 999;
    const callerPeer = request.peer;
    if (callerPeer instanceof Api.InputPeerChannel) { callerPeer.channelId = bigInt(999); callerPeer.accessHash = bigInt(111); }
    else if (callerPeer instanceof Api.InputPeerChat) callerPeer.chatId = bigInt(999);
    if (request instanceof Api.messages.Search) request.q = "changed";
    assert.deepEqual(await work, { rows: 1, source: "untrusted-data" }); assert.equal(calls.length, 1);
    const admitted = calls[0]!;
    assert.equal(admitted instanceof Api.messages.GetHistory, kind === "history");
    assert.equal(admitted instanceof Api.messages.Search, kind === "search");
    if (admitted instanceof Api.messages.GetHistory) {
      assert.equal(admitted.limit, 30); assert.equal(admitted.offsetId, 100);
      assert.ok(admitted.peer instanceof Api.InputPeerChannel); assert.equal(admitted.peer.channelId.toString(), "123"); assert.equal(admitted.peer.accessHash.toString(), "987");
    } else if (admitted instanceof Api.messages.Search) {
      assert.equal(admitted.limit, 20); assert.equal(admitted.offsetId, 100);
      assert.ok(admitted.peer instanceof Api.InputPeerChat); assert.equal(admitted.peer.chatId.toString(), "123");
      assert.equal(admitted.q, "нужный отзыв"); assert.ok(admitted.filter instanceof Api.InputMessagesFilterEmpty);
    }
    assert.equal(raw.messages.length, 0); assert.equal(raw.users.length, 0); assert.equal(raw.chats.length, 0);
    await policy.close();
  }
});

test("mutation, unknown, wrapped, subclassed, accessor and mismatched-peer requests refuse before invoke", async () => {
  let calls = 0, getterCalls = 0, proxyCalls = 0;
  const policy = createStandingObservedSourcePolicy({ client: { async invoke() { calls++; throw Error("must not invoke"); } },
    binding: { accountId: "7", peerId: "-100123" }, peer: channel(), signal: new AbortController().signal });
  const allowed = history();
  class HistorySubclass extends Api.messages.GetHistory {}
  const subclass = new HistorySubclass({ peer: channel(), offsetId: 0, offsetDate: 0, addOffset: 0, limit: 1, maxId: 0, minId: 0, hash: bigInt.zero });
  const wrapped = new Api.InvokeWithoutUpdates({ query: allowed });
  const mutation = new Api.messages.SendMessage({ peer: channel(), message: "mutation", randomId: bigInt(1) });
  const accessor = history(); Object.defineProperty(accessor, "offsetId", { enumerable: true, get() { getterCalls++; return 100; } });
  const proxy = new Proxy(history(), { getPrototypeOf() { proxyCalls++; return Api.messages.GetHistory.prototype; }, get() { proxyCalls++; return undefined; } });
  const requests: readonly [unknown, StandingObservedSourcePolicyError["code"]][] = [
    [new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(), limit: 1, hash: bigInt.zero }), "method"],
    [wrapped, "method"], [mutation, "method"], [subclass, "method"], [accessor, "input"], [proxy, "method"],
    [history(new Api.InputPeerChannel({ channelId: bigInt(124), accessHash: bigInt(987) })), "peer"],
    [history(new Api.InputPeerChat({ chatId: bigInt(123) })), "peer"],
  ];
  for (const [request, code] of requests) await assert.rejects(policy.call(request as never, () => true), refused(code));
  assert.equal(calls, 0); assert.equal(getterCalls, 0); assert.equal(proxyCalls, 0); await policy.close();
});

test("history and search product bounds refuse before invoke without relying on account rights", async () => {
  let calls = 0;
  const policy = createStandingObservedSourcePolicy({ client: { async invoke() { calls++; return response(); } },
    binding: { accountId: "7", peerId: "-123" }, peer: chat(), signal: new AbortController().signal });
  const invalid = [history(chat(), { limit: 31 }), history(chat(), { limit: 0 }), history(chat(), { addOffset: 31 }),
    history(chat(), { offsetId: -1 }), history(chat(), { hash: bigInt.one }), search(chat(), { q: "" }),
    search(chat(), { q: " x" }), search(chat(), { q: "x\0" }), search(chat(), { q: "я".repeat(129) }),
    search(chat(), { fromId: new Api.InputPeerSelf() }), search(chat(), { topMsgId: 10 }),
    search(chat(), { filter: new Api.InputMessagesFilterPhotos() }), search(chat(), { minDate: 200, maxDate: 10 })];
  for (const request of invalid) await assert.rejects(policy.call(request, () => true), refused("input"));
  assert.equal(calls, 0); await policy.close();
  assert.throws(() => createStandingObservedSourcePolicy({ client: { async invoke() {} }, binding: { accountId: "7", peerId: "-124" },
    peer: chat(), signal: new AbortController().signal }), refused("config"));
});

test("close revokes and joins the borrowed invoke, then discards a late raw response", async () => {
  let entered!: () => void, finish!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), raw = response();
  const policy = createStandingObservedSourcePolicy({ client: { invoke() { entered(); return new Promise(resolve => { finish = resolve; }); } },
    binding: { accountId: "7", peerId: "-100123" }, peer: channel(), signal: new AbortController().signal });
  const work = policy.call(history(), () => { throw Error("projector must not run after close"); }); await started;
  let closed = false; const closing = policy.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(policy.call(history(), () => true), refused("aborted"));
  finish(raw); await assert.rejects(work, refused("aborted")); await closing; assert.equal(closed, true); assert.equal(raw.messages.length, 0);
});

test("transport and projector failures stay fixed, discard raw data, and async/raw projectors cannot escape envelopes", async () => {
  const transport = createStandingObservedSourcePolicy({ client: { async invoke() { throw Error("PRIVATE_TRANSPORT_SECRET"); } },
    binding: { accountId: "7", peerId: "-123" }, peer: chat(), signal: new AbortController().signal });
  await assert.rejects(transport.call(history(chat()), () => true), error => refused("transport")(error) && !String(error).includes("PRIVATE")); await transport.close();
  for (const mode of ["throw", "promise", "raw"] as const) {
    const raw = response(), policy = createStandingObservedSourcePolicy({ client: { async invoke() { return raw; } },
      binding: { accountId: "7", peerId: "-123" }, peer: chat(), signal: new AbortController().signal });
    const project = mode === "throw" ? () => { throw Error("PRIVATE_PROJECTOR_SECRET"); } : mode === "promise" ? () => Promise.resolve(true) : (value: unknown) => value;
    await assert.rejects(policy.call(history(chat()), project), error => refused("projection")(error) && !String(error).includes("PRIVATE"));
    assert.equal(raw.messages.length, 0); await policy.close();
  }
});
