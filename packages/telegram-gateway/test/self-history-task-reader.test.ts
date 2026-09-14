import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { createSelfHistoryReader, snapshotSelfHistoryTaskCheckpoint, SelfHistoryReaderError,
  type SelfHistoryTaskCheckpoint, type SelfHistoryTaskPage } from "../src/self-history-reader.js";

const accountId = "7890123456", authorId = "4560123456";
const peer = (basic = false) => basic ? new Api.PeerChat({ chatId: bigInt(12345678) }) : new Api.PeerChannel({ channelId: bigInt(12345678) });
function message(id: number, date: number, text = "history " + id, basic = false): Api.Message {
  return new Api.Message({ id, date, message: text, fromId: new Api.PeerUser({ userId: bigInt(authorId) }), peerId: peer(basic) });
}
const refused = (code: string) => (e: unknown) => e instanceof SelfHistoryReaderError && e.code === code && !e.cause;
function fixture(values: Api.TypeMessage[], basic = false) {
  const control = new AbortController(), requests: Api.messages.GetHistory[] = [], envelopes: Api.messages.Messages[] = [];
  let override: ((request: Api.messages.GetHistory) => Promise<unknown>) | undefined;
  const binding = { accountId, peerId: utils.getPeerId(peer(basic)) };
  const input = { binding, signal: control.signal, self: new Api.User({ id: bigInt(accountId), self: true }),
    peer: basic ? new Api.InputPeerChat({ chatId: bigInt(12345678) }) : new Api.InputPeerChannel({ channelId: bigInt(12345678), accessHash: bigInt(987654321) }),
    client: { async invoke(request: Api.AnyRequest) {
      assert.ok(request instanceof Api.messages.GetHistory); requests.push(request); assert.ok(request.getBytes().length > 0);
      assert.equal(utils.getPeerId(request.peer), binding.peerId);
      if (override) return override(request);
      const envelope = new Api.messages.Messages({ messages: values.filter(v => (!request.offsetId || v.id < request.offsetId) &&
        (!request.offsetDate || v instanceof Api.MessageEmpty || v.date < request.offsetDate)).sort((a, b) => b.id - a.id).slice(0, request.limit),
        users: [new Api.User({ id: bigInt(authorId), firstName: "Саша" })], chats: [] });
      envelopes.push(envelope); return envelope;
    } } };
  return { input, values, requests, envelopes, control, reader: () => createSelfHistoryReader(input), setOverride: (value: typeof override) => { override = value; } };
}
const initial = (binding: { accountId: string; peerId: string }, fromDate = 100, toDate = 300): SelfHistoryTaskCheckpoint => ({
  schema: "self-history-task-checkpoint-v1", accountId: binding.accountId, chatId: binding.peerId, fromDate, toDate,
  offsetId: 0, lastDate: toDate, oldestDate: null, newestDate: null, undated: 0, pages: 0, inexact: false, upperBoundMessageId: null, status: "more",
});
function contents(result: SelfHistoryTaskPage) {
  const messages = new Map(result.page.messages.map(value => [value.ref, value]));
  return result.sources.map(row => ({ id: row.messageId, date: row.date, disposition: row.disposition,
    authorId: row.authorId ?? null, replyToMessageId: row.replyToMessageId ?? null,
    text: row.messageRef ? messages.get(row.messageRef)!.text : null }));
}

test("more than eight pages resume through fresh readers with exactly the uninterrupted private identities and text", async () => {
  for (const basic of [false, true]) {
    const values: Api.TypeMessage[] = Array.from({ length: 1050 }, (_, i) => message(1000 + i, 100 + i, "text " + i, basic));
    values[200] = new Api.MessageEmpty({ id: 1200 }); values[600] = message(1600, 0, "undated", basic);
    (values[1049] as Api.Message).replyTo = new Api.MessageReplyHeader({ replyToMsgId: 2048 });
    const period = { fromDate: 100, toDate: 1200 };
    const full = fixture(values, basic), stable = full.reader(), resumed = fixture(values, basic);
    const traverse = async (fresh: boolean) => {
      let checkpoint: SelfHistoryTaskCheckpoint | undefined; const all: ReturnType<typeof contents> = [];
      for (let n = 0; n < 20; n++) {
        const reader = fresh ? resumed.reader() : stable;
        const result = await reader.readTaskPage({ ...period, ...(checkpoint ? { checkpoint } : {}) });
        assert.equal(result.page.cursor, null); assert.equal(result.nextCheckpoint.upperBoundMessageId, 2049);
        assert.equal(result.beforeCheckpoint.pages, n); assert.equal(result.nextCheckpoint.pages, n + 1);
        assert.ok(Object.isFrozen(result) && Object.isFrozen(result.sources) && Object.isFrozen(result.nextCheckpoint));
        assert.ok(Buffer.byteLength(JSON.stringify(result.page)) <= 65_536);
        assert.doesNotMatch(JSON.stringify(result.page), /"(?:messageId|accountId|chatId|authorId|offsetId)"/u);
        all.push(...contents(result)); checkpoint = JSON.parse(JSON.stringify(result.nextCheckpoint));
        if (fresh) reader.close();
        if (!result.page.hasMore) {
          assert.equal(result.page.status, "empty-page"); assert.equal(result.page.coverage.traversalComplete, false);
          assert.equal(result.page.coverage.undatedEntries, 2); assert.ok(result.page.coverage.pages > 8); return { all, checkpoint };
        }
      }
      throw Error("traversal did not finish");
    };
    const uninterrupted = await traverse(false), restored = await traverse(true); stable.close();
    assert.deepEqual(restored, uninterrupted); assert.equal(restored.all.length, 1050); assert.equal(new Set(restored.all.map(row => row.id)).size, 1050);
    assert.equal(restored.all[0]!.replyToMessageId, 2048); assert.equal(full.requests.length, 12); assert.equal(resumed.requests.length, 12);
    assert.equal(resumed.requests[0]!.offsetDate, 1201); assert.equal(resumed.requests[1]!.offsetDate, 0);
    assert.equal(resumed.requests[1]!.offsetId, 1950); assert.ok(resumed.envelopes.every(e => e.messages.length === 0 && e.users.length === 0));
  }
});

test("byte boundary checkpoint follows the last consumed excluded row and never the unconsumed batch minimum", async () => {
  const huge = "\u0001".repeat(4096), f = fixture([message(20, 200, huge), new Api.MessageEmpty({ id: 19 }), message(18, 180, huge),
    new Api.MessageService({ id: 17, date: 170, peerId: peer(), action: new Api.MessageActionEmpty() }), message(16, 160, huge), message(15, 150, huge)]);
  const first = f.reader(), page = await first.readTaskPage({ fromDate: 100, toDate: 300 }); first.close();
  assert.deepEqual(page.sources.map(s => s.messageId), [20, 19, 18, 17]); assert.equal(page.nextCheckpoint.offsetId, 17);
  assert.equal(page.nextCheckpoint.lastDate, 170); assert.equal(page.nextCheckpoint.oldestDate, 170); assert.equal(page.nextCheckpoint.newestDate, 200);
  assert.equal(page.nextCheckpoint.undated, 1); assert.equal(page.nextCheckpoint.upperBoundMessageId, 20);
  assert.equal(page.page.excluded.unavailable, 1); assert.equal(page.page.excluded.nonText, 1);
  const next = f.reader(), result = await next.readTaskPage({ fromDate: 100, toDate: 300, checkpoint: page.nextCheckpoint });
  assert.deepEqual(result.sources.map(s => s.messageId), [16, 15]); assert.equal(f.requests[1]!.offsetId, 17); assert.equal(result.nextCheckpoint.upperBoundMessageId, 20); next.close();
});

test("checkpoint and request snapshots reject foreign scope, terminal progress and hostile shape before invocation", async () => {
  const f = fixture([]), reader = f.reader(), base = initial(f.input.binding); let accesses = 0;
  for (const [key, value, code] of [["accountId", "111", "binding"], ["chatId", "-222", "binding"], ["fromDate", 101, "input"],
    ["toDate", 301, "input"], ["status", "inaccessible", "input"], ["offsetId", 7, "input"], ["pages", -1, "input"], ["inexact", 1, "input"]] as const) {
    await assert.rejects(reader.readTaskPage({ fromDate: 100, toDate: 300, checkpoint: { ...base, [key]: value } as SelfHistoryTaskCheckpoint }), refused(code));
  }
  const accessor = { ...base }; Object.defineProperty(accessor, "offsetId", { enumerable: true, get() { accesses++; return 0; } });
  assert.throws(() => snapshotSelfHistoryTaskCheckpoint(accessor), refused("input"));
  assert.throws(() => snapshotSelfHistoryTaskCheckpoint(new Proxy(base, { ownKeys() { accesses++; return []; } })), refused("input"));
  assert.throws(() => snapshotSelfHistoryTaskCheckpoint({ ...base, extra: 1 }), refused("input"));
  assert.throws(() => snapshotSelfHistoryTaskCheckpoint({ ...base, pages: 1 }), refused("input"));
  assert.throws(() => snapshotSelfHistoryTaskCheckpoint({ ...base, pages: 1, offsetId: 20, upperBoundMessageId: 20, undated: 101 }), refused("input"));
  const request = { fromDate: 100, toDate: 300 }; Object.defineProperty(request, "checkpoint", { enumerable: true, get() { accesses++; return base; } });
  await assert.rejects(reader.readTaskPage(request), refused("input"));
  await assert.rejects(reader.read({ fromDate: 100, toDate: 300, checkpoint: base } as never), refused("input"));
  assert.equal(accesses, 0); assert.equal(f.requests.length, 0); reader.close();
});

test("serialized terminal checkpoints prevent another read and distinguish lower date, empty and access loss", async () => {
  for (const mode of ["lower", "empty", "inaccessible"] as const) {
    const f = fixture(mode === "lower" ? [message(20, 200), message(19, 90)] : []), reader = f.reader();
    if (mode === "inaccessible") f.setOverride(async () => { throw { errorMessage: "CHANNEL_PRIVATE" }; });
    const result = await reader.readTaskPage({ fromDate: 100, toDate: 300 }); reader.close();
    assert.equal(result.page.status, mode === "lower" ? "lower-bound-reached" : mode === "empty" ? "empty-page" : "inaccessible");
    assert.equal(result.nextCheckpoint.status, result.page.status); assert.equal(result.page.hasMore, false);
    assert.equal(result.page.coverage.traversalComplete, mode !== "inaccessible");
    assert.deepEqual(result.sources.map(s => s.messageId), mode === "lower" ? [20] : []);
    const fresh = f.reader(); await assert.rejects(fresh.readTaskPage({ fromDate: 100, toDate: 300, checkpoint: JSON.parse(JSON.stringify(result.nextCheckpoint)) }), refused("input"));
    assert.equal(f.requests.length, 1); fresh.close();
  }
});

test("checkpoint copies precede I/O and fresh reader preserves inexact coverage and the original upper watermark", async () => {
  const f = fixture([]), reader = f.reader(), mutable = { ...initial(f.input.binding) };
  f.setOverride(async () => new Api.messages.MessagesSlice({ inexact: true, count: 1, messages: [message(20, 200)], users: [], chats: [] }));
  const work = reader.readTaskPage({ fromDate: 100, toDate: 300, checkpoint: mutable }); mutable.toDate = 900; mutable.offsetId = 999;
  const first = await work; reader.close(); assert.equal(first.beforeCheckpoint.toDate, 300); assert.equal(first.beforeCheckpoint.offsetId, 0);
  assert.equal(first.nextCheckpoint.inexact, true); assert.equal(first.nextCheckpoint.upperBoundMessageId, 20);
  f.setOverride(async () => new Api.messages.Messages({ messages: [], users: [], chats: [] }));
  const fresh = f.reader(), last = await fresh.readTaskPage({ fromDate: 100, toDate: 300, checkpoint: first.nextCheckpoint });
  assert.equal(last.page.coverage.traversalComplete, false); assert.equal(last.nextCheckpoint.inexact, true); assert.equal(last.nextCheckpoint.upperBoundMessageId, 20); fresh.close();
});

test("STOP and shared busy ownership join the pending task read without publishing a checkpoint", async () => {
  const f = fixture([]), reader = f.reader(); let release!: (value: unknown) => void;
  f.setOverride(() => new Promise(resolve => { release = resolve; }));
  const pending = reader.readTaskPage({ fromDate: 100, toDate: 300 });
  await assert.rejects(reader.readTaskPage({ fromDate: 100, toDate: 300 }), refused("busy"));
  await assert.rejects(reader.read({ fromDate: 100, toDate: 300 }), refused("busy")); f.control.abort();
  const envelope = new Api.messages.Messages({ messages: [message(20, 200)], users: [], chats: [] }); release(envelope);
  await assert.rejects(pending, refused("aborted")); assert.equal(envelope.messages.length, 0); assert.equal(f.requests.length, 1); reader.close();
});

test("descending peer date and id validation still reject a malformed unconsumed byte-boundary tail", async () => {
  for (const mode of ["peer", "id", "date"] as const) {
    const f = fixture([]), reader = f.reader(), tail = message(mode === "id" ? 20 : 18, mode === "date" ? 250 : 180, "tail");
    if (mode === "peer") tail.peerId = new Api.PeerChat({ chatId: bigInt(999) });
    f.setOverride(async () => new Api.messages.Messages({ messages: [message(20, 200, "\u0001".repeat(4096)), message(19, 190, "\u0001".repeat(4096)), tail], users: [], chats: [] }));
    await assert.rejects(reader.readTaskPage({ fromDate: 100, toDate: 300 }), refused("protocol")); assert.equal(f.requests.length, 1); reader.close();
  }
});
