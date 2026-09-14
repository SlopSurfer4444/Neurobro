import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createBoundGroupReader } from "../src/bound-group-reader.js";
import { createBoundGroupTools } from "../src/bound-group-tools.js";
import { createStandingToolDispatcher } from "../src/standing-tool-dispatcher.js";

function fixture() {
  const stop = new AbortController(), calls: Api.AnyRequest[] = [];
  const client = { async invoke(r: Api.AnyRequest) {
    calls.push(r); assert.ok(r instanceof Api.messages.GetFullChat); assert.equal(r.chatId.toString(), "456");
    return new Api.messages.ChatFull({ fullChat: new Api.ChatFull({ id: bigInt(456), about: "Описание группы", participants: new Api.ChatParticipants({ chatId: bigInt(456), participants: [new Api.ChatParticipant({ userId: bigInt(321), inviterId: bigInt(123), date: 1 })], version: 1 }), notifySettings: new Api.PeerNotifySettings({}) }), chats: [new Api.Chat({ id: bigInt(456), title: "Тестовая группа", photo: new Api.ChatPhotoEmpty(), participantsCount: 1, date: 1, version: 1 })], users: [new Api.User({ id: bigInt(321), firstName: "Участник", username: "member" })] });
  } };
  const reader = createBoundGroupReader({ client, binding: { accountId: "123", peerId: "-456" }, peer: new Api.InputPeerChat({ chatId: bigInt(456) }), self: new Api.User({ id: bigInt(123), self: true }), signal: stop.signal });
  const tools = createBoundGroupTools({ reader, signal: stop.signal }), dispatcher = createStandingToolDispatcher({ call: async () => ({ success: true, contentItems: [{ type: "inputText", text: "{}" }] }) }, tools.handlers);
  return { stop, calls, reader, tools, dispatcher, scope: { requestRef: "req", callRef: "call", signal: stop.signal } };
}
test("named dispatcher → real bound reader returns group menu and stable participant data", async () => {
  const f = fixture(); assert.deepEqual(f.tools.specs.map(s => s.name), f.tools.handlers.map(s => s.name));
  const info = await f.dispatcher.call("neurobro_group_info", {}, f.scope); assert.equal(info.success, true); assert.equal(JSON.parse(info.contentItems[0].text).title, "Тестовая группа");
  const list = await f.dispatcher.call("neurobro_list_participants", { cursor: null }, f.scope); assert.equal(list.success, true);
  const page = JSON.parse(list.contentItems[0].text); assert.equal(page.members[0].displayName, "Участник"); assert.match(page.members[0].memberRef, /^member_/); assert.equal(page.coverage.fullRoster, false); assert.equal(page.status, "exhausted");
  assert.equal(f.calls.length, 2); assert.equal(list.contentItems[0].text.includes("accessHash"), false); await f.tools.close(); await f.dispatcher.close();
});
test("tool arguments cannot introduce another peer or invoke getters", async () => {
  const f = fixture(); let getters = 0;
  for (const args of [{ peer: "other" }, { cursor: null, chatId: "-99" }, { get cursor() { getters++; return null; } }]) {
    const result = await f.tools.handlers[1]!.call(args, f.scope); assert.equal((result as { success: boolean }).success, false);
  }
  assert.equal(getters, 0); assert.equal(f.calls.length, 0); await f.tools.close();
});
test("closed or per-call aborted tools never read the group", async () => {
  const f = fixture(), callStop = new AbortController(); callStop.abort();
  const stopped = await f.tools.handlers[0]!.call({}, { ...f.scope, signal: callStop.signal }); assert.equal((stopped as { success: boolean }).success, false); assert.equal(f.calls.length, 0);
  await f.tools.close(); const closed = await f.tools.handlers[0]!.call({}, f.scope); assert.equal((closed as { success: boolean }).success, false); assert.equal(f.calls.length, 0);
});
