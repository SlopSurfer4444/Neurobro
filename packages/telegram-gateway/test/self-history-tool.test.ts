import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { createSelfHistoryReader } from "../src/self-history-reader.js";
import { createSelfHistoryTool, SELF_HISTORY_TOOL_NAME } from "../src/self-history-tool.js";

function fixture() {
  const controller = new AbortController(), calls: Api.AnyRequest[] = [];
  const peer = new Api.PeerChat({ chatId: bigInt(101) });
  const messages = [3,2,1].map(id => new Api.Message({ id, date: 100 + id, message: "Invented message " + id,
    fromId: new Api.PeerUser({ userId: bigInt(55) }), peerId: peer }));
  const reader = createSelfHistoryReader({ binding: { accountId: "77", peerId: utils.getPeerId(peer) },
    self: new Api.User({ id: bigInt(77), self: true }), peer: new Api.InputPeerChat({ chatId: bigInt(101) }), signal: controller.signal,
    client: { async invoke(request) { calls.push(request); assert.ok(request instanceof Api.messages.GetHistory);
      return new Api.messages.Messages({ messages: messages.filter(m => !request.offsetId || m.id < request.offsetId), users: [new Api.User({id: bigInt(55), firstName: "Друг"})], chats: [] }); } } });
  return { tool: createSelfHistoryTool({ history: reader, signal: controller.signal }), calls, controller };
}

test("native function tool reads actual history capability and continues to explicit exhaustion", async () => {
  const f = fixture(); assert.equal(f.tool.spec.type, "function"); assert.equal(f.tool.spec.name, SELF_HISTORY_TOOL_NAME);
  const first = await f.tool.call({ fromDate: 100, toDate: 200, cursor: null });
  assert.equal(first.success, true); assert.equal(first.contentItems[0]!.type, "inputText");
  const page = JSON.parse(first.contentItems[0]!.text); assert.equal(page.messages.length, 3); assert.equal(page.hasMore, true);
  assert.equal(page.coverage.traversalComplete, false); assert.equal(page.limitations.includes("not-a-full-archive"), true);
  const second = await f.tool.call({ fromDate: 100, toDate: 200, cursor: page.cursor });
  assert.equal(second.success, true); assert.equal(JSON.parse(second.contentItems[0]!.text).coverage.traversalComplete, true);
  assert.equal(f.calls.length, 2); f.tool.close();
});
test("model cannot choose another account, chat, path or execute a getter", async () => {
  const f = fixture(); let getter = false;
  const accessor = { get fromDate() { getter = true; return 100; }, toDate: 200, cursor: null };
  for (const args of [accessor, { fromDate:100, toDate:200, cursor:null, chatId:"-999" },
    { fromDate:100, toDate:200, cursor:null, path:"secret" }, {fromDate:200,toDate:100,cursor:null},
    {fromDate:100,toDate:200,cursor:"invented"}, {fromDate:100,toDate:200}, "read all files"]) {
    const result = await f.tool.call(args); assert.equal(result.success, false);
  }
  assert.equal(getter, false); assert.equal(f.calls.length, 0); f.tool.close();
});
test("cancellation and closure discard late private data and revoke capability", async () => {
  const controller = new AbortController(); let closed = 0, complete!: (value: never) => void;
  const tool = createSelfHistoryTool({ signal: controller.signal,
    history: { read: () => new Promise(resolve => { complete = resolve; }), close() { closed++; } } });
  const pending = tool.call({fromDate:100,toDate:200,cursor:null}); controller.abort();
  complete({privateText:"must not escape"} as never);
  const result = await pending; assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes("must not escape"), false);
  tool.close(); tool.close(); assert.equal(closed, 1);
});
test("unexpected errors never expose private exception details", async () => {
  const tool = createSelfHistoryTool({ signal:new AbortController().signal,
    history: { async read() { throw new Error("secret credential and chat body"); }, close() {} } });
  const result = await tool.call({fromDate:100,toDate:200,cursor:null}); assert.equal(result.success, false);
  assert.equal(JSON.stringify(result).includes("secret"), false); assert.equal(JSON.parse(result.contentItems[0]!.text).code, "unavailable");
  tool.close();
});
