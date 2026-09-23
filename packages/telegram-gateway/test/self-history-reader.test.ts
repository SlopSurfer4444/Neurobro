import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import type { SelfHistoryTaskCheckpoint } from "../src/self-history-reader.js";
import { createSelfHistoryReader, SelfHistoryReaderError, type SelfHistoryMessage } from "../src/self-history-reader.js";

const accountId = "7890123456", authorId = "4560123456";
const self = () => new Api.User({ id: bigInt(accountId), self: true });
const human = () => new Api.User({ id: bigInt(authorId), firstName: "Саша", lastName: "Иванов" });
const peer = (group = false) => group ? new Api.PeerChat({ chatId: bigInt(12345678) }) : new Api.PeerChannel({ channelId: bigInt(12345678) });
const inputPeer = (group = false) => group ? new Api.InputPeerChat({ chatId: bigInt(12345678) }) : new Api.InputPeerChannel({ channelId: bigInt(12345678), accessHash: bigInt(987654321) });
function message(id: number, date: number, text = "Invented history " + id, own = false, group = false): Api.Message {
  return new Api.Message({ id, date, message: text, fromId: new Api.PeerUser({ userId: bigInt(own ? accountId : authorId) }), peerId: peer(group), ...(own ? { out: true } : {}) });
}
const refused = (code: string) => (error: unknown) => error instanceof SelfHistoryReaderError && error.code === code && !error.cause;
function fixture(initial: Api.TypeMessage[], group = false) {
  const values = [...initial], calls: Api.AnyRequest[] = [], envelopes: Api.messages.Messages[] = [], signal = new AbortController();
  let override: ((request: Api.messages.GetHistory) => Promise<unknown>) | undefined;
  const client = { async invoke(request: Api.AnyRequest) {
    calls.push(request); assert.ok(request instanceof Api.messages.GetHistory); assert.ok(request.getBytes().length > 0);
    if (override) return override(request);
    const matches = values.filter(value => (!request.offsetId || value.id < request.offsetId) &&
      (!request.offsetDate || value instanceof Api.MessageEmpty || value.date < request.offsetDate)).sort((a, b) => b.id - a.id).slice(0, request.limit);
    const envelope = new Api.messages.Messages({ messages: matches, users: [human(), self()], chats: [] }); envelopes.push(envelope); return envelope;
  } };
  const options = { client, peer: inputPeer(group), binding: { accountId, peerId: utils.getPeerId(peer(group)) }, self: self(), signal: signal.signal };
  return { values, calls, envelopes, signal, options, reader: createSelfHistoryReader(options), setOverride(value: typeof override) { override = value; } };
}

test("a month spans multiple bound pages, chronological text and stable private refs, followed by explicit exhaustion", async () => {
  for (const group of [false, true]) {
    const start = 1700000000, values = Array.from({ length: 230 }, (_, i) => message(1000 + i, start + i * 10000, "history " + i, i % 2 === 0, group));
    values[229]!.replyTo = new Api.MessageReplyHeader({ replyToMsgId: values[228]!.id });
    const f = fixture(values, group), fromDate = start, toDate = start + 30 * 86400;
    let cursor: string | undefined, completed = false; const all: SelfHistoryMessage[] = [];
    for (let page = 0; page < 5; page++) {
      const result = await f.reader.read({ fromDate, toDate, ...(cursor ? { cursor } : {}) });
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 65536);
      assert.deepEqual(result.messages.map(m => m.date), [...result.messages.map(m => m.date)].sort((a, b) => a - b));
      assert.equal(JSON.stringify(result).includes(accountId), false); assert.equal(JSON.stringify(result).includes(authorId), false);
      all.push(...result.messages); if (!result.hasMore) { completed = result.coverage.traversalComplete; assert.equal(result.status, "empty-page"); break; }
      assert.equal(result.coverage.traversalComplete, false); assert.ok(result.cursor); cursor = result.cursor!;
    }
    assert.equal(completed, true); assert.equal(all.length, 230); assert.equal(new Set(all.map(m => m.ref)).size, 230);
    assert.equal(new Set(all.filter(m => m.author === "self").map(m => m.authorRef)).size, 1);
    const newest = all.find(m => m.text === "history 229")!, previous = all.find(m => m.text === "history 228")!;
    assert.equal(newest.replyRef, previous.ref); assert.ok(all.filter(m => m.author === "self").every(m => m.displayName === "Нейробро"));
    assert.equal(f.calls.length, 4); const first = f.calls[0] as Api.messages.GetHistory;
    assert.equal(first.offsetDate, toDate + 1); assert.equal(first.limit, 100); assert.equal(first.minId, 0); assert.equal(first.maxId, 0);
    assert.equal((f.calls[1] as Api.messages.GetHistory).offsetDate, 0);
    assert.ok(f.envelopes.every(e => e.messages.length === 0 && e.users.length === 0 && e.chats.length === 0)); f.reader.close();
  }
});

test("byte-limited continuation does not consume the first excluded-by-budget message", async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => message(1000 + i, 100 + i, "\u0001".repeat(4096))));
  let cursor: string | undefined; const refs = new Set<string>();
  for (let n = 0; n < 55; n++) {
    const result = await f.reader.read({ fromDate: 100, toDate: 199, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 65536);
    for (const m of result.messages) { assert.equal(refs.has(m.ref), false); refs.add(m.ref); }
    if (!result.hasMore) { assert.equal(result.coverage.traversalComplete, true); break; } cursor = result.cursor!;
  }
  assert.equal(refs.size, 100); f.reader.close();
});

test("opaque continuation is period/reader scoped and consumed only after successful page processing", async () => {
  const f = fixture([message(20, 200)]), first = await f.reader.read({ fromDate: 100, toDate: 300 });
  assert.ok(first.cursor); assert.equal(first.hasMore, true);
  await assert.rejects(f.reader.read({ fromDate: 101, toDate: 300, cursor: first.cursor! }), refused("cursor"));
  const other = fixture([]); await assert.rejects(other.reader.read({ fromDate: 100, toDate: 300, cursor: first.cursor! }), refused("cursor"));
  await f.reader.read({ fromDate: 100, toDate: 300, cursor: first.cursor! });
  await assert.rejects(f.reader.read({ fromDate: 100, toDate: 300, cursor: first.cursor! }), refused("cursor"));
  await assert.rejects(f.reader.read({ fromDate: 100, toDate: 300, chatId: "-999" } as never), refused("input"));
  assert.equal(f.calls.length, 2); assert.equal(other.calls.length, 0); f.reader.close(); other.reader.close();
});

test("exclusions and edits are explicit; undated/deleted entries prevent complete traversal claims", async () => {
  const edited = message(20, 200, "edited body", true); edited.editDate = 250;
  edited.replyTo = new Api.MessageReplyHeader({ replyToMsgId: 10, replyToPeerId: new Api.PeerChat({ chatId: bigInt(999) }) });
  const f = fixture([edited, Object.assign(message(19, 190), { media: new Api.MessageMediaPhoto({}) }),
    Object.assign(message(18, 180), { fwdFrom: new Api.MessageFwdHeader({ date: 100 }) }), message(17, 170, "x".repeat(16385)), new Api.MessageEmpty({ id: 16 }), message(15, 90)]);
  const result = await f.reader.read({ fromDate: 100, toDate: 300 });
  assert.equal(result.status, "lower-bound-reached"); assert.equal(result.hasMore, false); assert.equal(result.coverage.traversalComplete, false);
  assert.equal(result.coverage.undatedEntries, 1); assert.equal(result.excluded.nonText, 2); assert.equal(result.excluded.invalidText, 1); assert.equal(result.excluded.unavailable, 1);
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0]!.editedAt, 250); assert.equal(result.messages[0]!.replyRef, null); assert.equal(result.messages[0]!.replyUnavailable, true); f.reader.close();
});

test("wrong binding/cross-chat/ascending dates refuse before returning private bodies", async () => {
  const f = fixture([]);
  assert.throws(() => createSelfHistoryReader({ ...f.options, binding: { accountId, peerId: "-999" } }), refused("binding"));
  assert.equal(f.calls.length, 0);
  for (const variant of ["peer", "date"] as const) {
    f.setOverride(async () => new Api.messages.Messages({ messages: variant === "peer" ? [Object.assign(message(20, 200, "PRIVATE"), { peerId: new Api.PeerChat({ chatId: bigInt(999) }) })]
      : [message(20, 200), message(19, 250)], users: [human()], chats: [] }));
    await assert.rejects(f.reader.read({ fromDate: 100, toDate: 300 }), refused("protocol"));
  } f.reader.close();
});

test("inaccessible source is not exhaustion; transport errors are sanitized and no automatic retry occurs", async () => {
  const f = fixture([]); f.setOverride(async () => { throw Object.assign(new Error("PRIVATE user details"), { errorMessage: "CHANNEL_PRIVATE" }); });
  const result = await f.reader.read({ fromDate: 100, toDate: 300 }); assert.equal(result.status, "inaccessible"); assert.equal(result.coverage.traversalComplete, false);
  f.setOverride(async () => { throw new Error("PRIVATE socket detail"); });
  await assert.rejects(f.reader.read({ fromDate: 100, toDate: 300 }), refused("transport")); assert.equal(f.calls.length, 2); f.reader.close();
});

test("STOP/close discard late results and same-reader concurrent calls are refused", async () => {
  const f = fixture([]); let release!: (value: unknown) => void;
  f.setOverride(() => new Promise(resolve => { release = resolve; }));
  const pending = f.reader.read({ fromDate: 100, toDate: 300 });
  await assert.rejects(f.reader.read({ fromDate: 100, toDate: 300 }), refused("busy"));
  f.signal.abort(); const envelope = new Api.messages.Messages({ messages: [message(20, 200)], users: [human()], chats: [] }); release(envelope);
  await assert.rejects(pending, refused("aborted")); assert.equal(envelope.messages.length, 0); assert.equal(envelope.users.length, 0);
  await assert.rejects(f.reader.read({ fromDate: 100, toDate: 300 }), refused("aborted")); assert.equal(f.calls.length, 1);
});

test("date bounds are inclusive and a prior inexact page never becomes a complete interval claim", async () => {
  const f = fixture([message(25, 301), message(24, 300), message(23, 200), message(22, 100), message(21, 99)]);
  const result = await f.reader.read({ fromDate: 100, toDate: 300 });
  assert.deepEqual(result.messages.map(value => value.date), [100, 200, 300]);
  assert.equal(result.status, "lower-bound-reached"); assert.equal(result.coverage.traversalComplete, true); f.reader.close();
  const g = fixture([]); let called = false;
  g.setOverride(async () => {
    if (called) return new Api.messages.Messages({ messages: [], users: [], chats: [] });
    called = true; return new Api.messages.MessagesSlice({ inexact: true, count: 1, messages: [message(20, 200)], users: [human()], chats: [] });
  });
  const first = await g.reader.read({ fromDate: 100, toDate: 300 }); assert.ok(first.cursor);
  const last = await g.reader.read({ fromDate: 100, toDate: 300, cursor: first.cursor! });
  assert.equal(last.status, "empty-page"); assert.equal(last.hasMore, false); assert.equal(last.coverage.traversalComplete, false); g.reader.close();
});


test("durable text reads a month through 100-row wire pages and fresh readers without losing captions or channel senders", async () => {
  const start = 1700000000, values = Array.from({ length: 1053 }, (_, i) => new Api.Message({
    id: i + 1, date: start + i * 2000, peerId: peer(), post: true, message: "Post " + i,
    ...(i % 3 === 0 ? { fwdFrom: new Api.MessageFwdHeader({ date: start }) } : {}),
    ...(i % 3 === 1 ? { media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(7) }) }), groupedId: bigInt(12) } : {}),
    ...(i % 3 === 2 ? { replyMarkup: new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButton({ text: "button" })] })] }) } : {}),
  }));
  const calls: number[] = [], collected: number[] = []; let checkpoint: SelfHistoryTaskCheckpoint | undefined;
  for (let n = 0; n < 15; n++) {
    const reader = createSelfHistoryReader({ peer: inputPeer(), binding: { accountId, peerId: utils.getPeerId(peer()) }, self: self(),
      signal: new AbortController().signal, durableText: true, client: { async invoke(request) {
        assert.ok(request instanceof Api.messages.GetHistory); assert.equal(request.limit, 100); calls.push(request.offsetId);
        const wire = new Api.messages.Messages({ messages: values.filter(v => !request.offsetId || v.id < request.offsetId).sort((a,b) => b.id-a.id).slice(0, request.limit), users: [], chats: [] });
        return new BinaryReader(wire.getBytes()).tgReadObject();
      } } });
    const result = await reader.readTaskPage({ fromDate: start, toDate: start + 30 * 86400, ...(checkpoint ? { checkpoint } : {}) });
    reader.close(); checkpoint = result.nextCheckpoint;
    assert.ok(result.sources.every(row => row.disposition === "included" && row.authorId === utils.getPeerId(peer())));
    assert.equal(result.page.excluded.nonText, 0); assert.ok(Buffer.byteLength(JSON.stringify(result.page)) <= 65536);
    collected.push(...result.sources.map(row => row.messageId));
    if (!result.page.hasMore) { assert.equal(result.page.coverage.traversalComplete, true); break; }
  }
  assert.equal(calls.length, 12); assert.equal(collected.length, 1053); assert.equal(new Set(collected).size, 1053);
  assert.equal(checkpoint?.status, "empty-page");
});

test("durable full text keeps 16KiB captions and packing resumes at the unconsumed message", async () => {
  const f = fixture(Array.from({ length: 12 }, (_, i) => message(i + 1, 100, "я".repeat(8192))));
  const ids: number[] = []; let checkpoint: SelfHistoryTaskCheckpoint | undefined;
  for (let n = 0; n < 10; n++) {
    const reader = createSelfHistoryReader({ ...f.options, durableText: true });
    const result = await reader.readTaskPage({ fromDate: 1, toDate: 200, ...(checkpoint ? { checkpoint } : {}) });
    reader.close(); checkpoint = result.nextCheckpoint;
    assert.ok(result.page.messages.every(row => Buffer.byteLength(row.text) === 16384));
    ids.push(...result.sources.map(row => row.messageId)); if (!result.page.hasMore) break;
  }
  assert.equal(ids.length, 12); assert.equal(new Set(ids).size, 12); assert.equal(checkpoint?.status, "empty-page"); f.reader.close();
});


test("direct text history preserves the full Russian message beyond 4096 bytes", async () => {
 const text="я".repeat(7000)+" КОНЕЦ";const f=fixture([message(1,100,text)]);
 const page=await f.reader.read({fromDate:1,toDate:200});assert.equal(page.messages[0]?.text,text);assert.equal(page.excluded.invalidText,0);f.reader.close();
});


test("wire-decoded forwarded complaint preserves quoting provenance separately from its forwarding participant", async () => {
 const forwarded=message(3,100,"My car is delayed");
 forwarded.fwdFrom=new Api.MessageFwdHeader({date:50,fromName:"Original\u202e customer"});
 const unknown=message(2,90,"Other quotation");unknown.fwdFrom=new Api.MessageFwdHeader({date:40});
 const plain=message(1,80,"My own words");
 const f=fixture([]);f.setOverride(async()=>new BinaryReader(new Api.messages.Messages({messages:[forwarded,unknown,plain],users:[human()],chats:[]}).getBytes()).tgReadObject());
 const reader=createSelfHistoryReader({...f.options,durableText:true});
 const result=await reader.readTaskPage({fromDate:1,toDate:200});reader.close();f.reader.close();
 assert.ok(result.sources.every(source=>source.authorId===authorId));
 const complaint=result.page.messages.find(row=>row.text==="My car is delayed")!;
 assert.equal(complaint.displayName,"Саша Иванов");assert.equal(complaint.author,"user");
 assert.deepEqual(complaint.forwarded,{originalDate:50,sourceName:"Original  customer",interpretation:"quoted-source-not-request"});
 assert.deepEqual(result.page.messages.find(row=>row.text==="Other quotation")!.forwarded,{originalDate:40,sourceName:null,interpretation:"quoted-source-not-request"});
 assert.equal(Object.hasOwn(result.page.messages.find(row=>row.text==="My own words")!,"forwarded"),false);
});

test("durable forward metadata rejects malformed headers and bounds multibyte source labels",async()=>{
 for(const originalDate of [0,NaN]){
  const m=message(1,100,"quoted");m.fwdFrom=new Api.MessageFwdHeader({date:originalDate});const f=fixture([m]);
  const reader=createSelfHistoryReader({...f.options,durableText:true});await assert.rejects(reader.readTaskPage({fromDate:1,toDate:200}),refused("protocol"));reader.close();f.reader.close();
 }
 const m=message(1,100,"quoted");m.fwdFrom=new Api.MessageFwdHeader({date:50,postAuthor:"я".repeat(100)});const f=fixture([m]);
 const reader=createSelfHistoryReader({...f.options,durableText:true}),result=await reader.readTaskPage({fromDate:1,toDate:200});
 assert.equal(Buffer.byteLength(result.page.messages[0]!.forwarded!.sourceName!),128);reader.close();f.reader.close();
});
