import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import { createStandingConversationAdapter, type StandingSelection } from "../src/standing-conversation-adapter.js";

const peer = new Api.PeerChannel({ channelId: bigInt(123) });
const binding = { accountId: "789", peerId: utils.getPeerId(peer) };
const self = new Api.User({ id: bigInt(789), self: true });
function message(id: number, text = "Ordinary conversation", author = "456", reply?: number) {
  return new Api.Message({ id, peerId: peer, fromId: new Api.PeerUser({ userId: bigInt(author) }), date: 100,
    message: text, ...(author === "789" ? { out: true } : {}),
    ...(reply ? { replyTo: new Api.MessageReplyHeader({ replyToMsgId: reply }) } : {}) });
}
async function fixture(initial: Api.Message[] = [], enabledInitially = true, resumeCursor = 90) {
  const values = [...initial], checkpoints: number[] = [], questions: number[] = [], calls: Api.AnyRequest[] = [];
  let time = 0, enabled = enabledInitially, hook: ((request: Api.AnyRequest) => void) | undefined;
  const abort = new AbortController();
  const users = [self, new Api.User({ id: bigInt(456), firstName: "Human" }), new Api.User({ id: bigInt(9), bot: true })];
  const batch = (rows: Api.TypeMessage[]) => new Api.messages.Messages({ messages: rows, users: [...users], chats: [] });
  const input = { binding, self, signal: abort.signal, startedAt: 1, resumeCursor,
    checkpointCursor: async (id: number) => { checkpoints.push(id); },
    checkpointQuestion: async (primary: { messageId: number }) => { questions.push(primary.messageId); },
    clock: () => time, wait: async (ms: number) => { time += ms; },
    initiative: { enabled: () => enabled },
    client: { async invoke(request: Api.AnyRequest): Promise<unknown> {
      calls.push(request); assert.ok(request.getBytes().length > 0); hook?.(request);
      if (request instanceof Api.messages.GetDialogs) return new Api.messages.Dialogs({
        dialogs: [new Api.Dialog({ peer, topMessage: 90, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0,
          unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) })],
        chats: [new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Synthetic", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })], users: [], messages: [] });
      if (request instanceof Api.messages.GetHistory) return batch(values.filter(m => m.id > (request.minId ?? 0) && (!request.offsetId || m.id < request.offsetId)).sort((a, b) => b.id - a.id).slice(0, request.limit));
      if (request instanceof Api.channels.GetMessages || request instanceof Api.messages.GetMessages) {
        const id = (request.id[0] as Api.InputMessageID).id;
        return batch([values.find(m => m.id === id) ?? new Api.MessageEmpty({ id })]);
      }
      if (request instanceof Api.messages.SetTyping) return true;
      if (request instanceof Api.messages.SendMessage) {
        const id = Math.max(90, ...values.map(value => value.id)) + 1;
        values.push(message(id, request.message, "789", (request.replyTo as Api.InputReplyToMessage).replyToMsgId));
        return new Api.UpdateShortSentMessage({ id, out: true, pts: 1, ptsCount: 1, date: 100 });
      }
      throw Error("unexpected mutation in selection test");
    } } };
  const adapter = await createStandingConversationAdapter(input);
  return { adapter, input, values, calls, checkpoints, questions, abort, users,
    setTime(value: number) { time = value; }, advance(ms: number) { time += ms; }, time: () => time,
    enabled(value: boolean) { enabled = value; }, hook(value: typeof hook) { hook = value; },
    poll: () => adapter.pollNext(abort.signal) };
}
function selected(value: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["poll"]>>): StandingSelection {
  assert.equal(value.kind, "selected"); if (value.kind !== "selected") assert.fail(); return value.selection;
}

test("fresh unthreaded continuation survives initiative OFF and cooldown without a keyword list", async () => {
  for (const text of ["гоу", "yes please", "а давай сначала про вчерашнее", "не сейчас"]) {
    const f = await fixture([message(90, "Кто хочет разобрать это вместе?", "789"), message(91, text)], false);
    try {
      f.setTime(100000);
      const choice = selected(await f.poll());
      assert.equal(choice.continuation, true); assert.equal(choice.initiative, undefined);
      assert.equal(choice.primary.text, text); assert.equal(choice.context?.primary.replyToMessageId, null);
      assert.deepEqual(choice.context?.replyChain, []);
      assert.equal(choice.context?.recent.find(value => value.messageId === 90)?.text, "Кто хочет разобрать это вместе?");
      await choice.finishInitiative!();
      f.values.push(message(92, "Another unrelated human turn"));
      assert.equal((await f.poll()).kind, "idle");
      assert.deepEqual(f.questions, [91]);
    } finally { f.adapter.close(); }
  }
});

test("open invitation can be continued by a different human; only its next human gets the opportunity", async () => {
  const f = await fixture([message(89, "Earlier requester"), message(90, "Кто-нибудь хочет?", "789", 89), message(91, "можно я", "457"), message(92, "другой разговор")], false);
  try {
    f.users.push(new Api.User({ id: bigInt(457), firstName: "Another human" })); f.setTime(100000);
    const choice = selected(await f.poll()); assert.equal(choice.continuation, true); assert.equal(choice.primary.ownerId, "457");
    await choice.finishInitiative!(); assert.equal((await f.poll()).kind, "idle"); assert.deepEqual(f.questions, [91]);
  } finally { f.adapter.close(); }
});

test("intervening human, stale own output and explicit reply to another human do not create continuation", async () => {
  for (const mode of ["intervening", "stale", "reply"] as const) {
    const rows = [message(80, "Human topic"), message(89, "Own invitation", "789")];
    if (mode === "intervening") rows.push(message(90, "A human already answered"));
    rows.push(message(91, "go", "456", mode === "reply" ? 80 : undefined));
    const f = await fixture(rows, false);
    try {
      f.setTime(mode === "stale" ? 300000 : 100000);
      let result = await f.poll(); if (result.kind === "more") result = await f.poll();
      assert.equal(result.kind, "idle"); assert.deepEqual(f.questions, []);
    } finally { f.adapter.close(); }
  }
});

test("guaranteed request wins over an earlier continuation opportunity", async () => {
  const f = await fixture([message(90, "Want to continue?", "789"), message(91, "sure"), message(92, "ПРОМПТ exact request")], false);
  try { f.setTime(100000); const choice = selected(await f.poll());
    assert.equal(choice.primary.messageId, 92); assert.equal(choice.continuation, undefined); assert.equal(choice.initiative, undefined);
  } finally { f.adapter.close(); }
});

test("ordinary initiative cooldown follows a verified direct answer while a response opportunity remains available", async () => {
  const f = await fixture([message(80, "Human topic"), message(91, "ПРОМПТ question")]);
  try {
    f.setTime(120000); const direct = selected(await f.poll());
    const sent = await direct.transport.sendOnce({ chatId: binding.peerId, replyToMessageId: 91, text: "Own answer", randomId: "1234" }, f.abort.signal);
    await direct.transport.readExact(binding.peerId, sent.messageId, f.abort.signal);
    f.values.push(message(93, "Human reply elsewhere", "456", 80));
    assert.equal((await f.poll()).kind, "more"); assert.equal((await f.poll()).kind, "idle");
    f.values.push(message(94, "Unrelated ordinary discussion")); f.advance(6000);
    assert.equal((await f.poll()).kind, "idle"); assert.deepEqual(f.questions, [91]);
  } finally { f.adapter.close(); }
});

test("edited own invitation cannot authorize continuation send after selection", async () => {
  const f = await fixture([message(90, "Want to continue?", "789"), message(91, "sure")], false);
  try {
    f.setTime(100000); const choice = selected(await f.poll()); f.values[0]!.message = "Edited invitation";
    await assert.rejects(choice.transport.sendOnce({ chatId: binding.peerId, replyToMessageId: 91, text: "Must not send", randomId: "1234" }, f.abort.signal));
    assert.equal(f.calls.some(call => call instanceof Api.messages.SendMessage), false);
  } finally { f.adapter.close(); }
});

test("startup cooldown skips old chatter; fresh passive anchor is consumed once and silence frees the guaranteed lane", async () => {
  const f = await fixture([message(91)]);
  try {
    assert.equal((await f.poll()).kind, "idle"); assert.deepEqual(f.checkpoints, [91]);
    f.setTime(120000); f.values.push(message(92, "Human discussion, not a request"));
    assert.equal((await f.poll()).kind, "idle"); f.advance(6000);
    const choice = selected(await f.poll()); assert.equal(choice.initiative, true);
    assert.equal(choice.primary.text, "Human discussion, not a request"); assert.equal(choice.primary.ownerId, "456");
    assert.deepEqual(f.questions, [92]); assert.equal(f.checkpoints.at(-1), 92);
    await choice.finishInitiative!(); await assert.rejects(choice.finishInitiative!());
    f.values.push(message(93, "My own output", "789"), message(94, "Bot output", "9"));
    assert.equal((await f.poll()).kind, "idle");
    f.values.push(message(95, "ПРОМПТ guaranteed"));
    const direct = selected(await f.poll()); assert.equal(direct.initiative, undefined); assert.equal(direct.primary.messageId, 95);
    assert.deepEqual(f.questions, [92, 95]);
  } finally { f.adapter.close(); }
});

test("queued guaranteed request wins over newer and older ordinary anchors without cursor reordering", async () => {
  const f = await fixture([message(91), message(92, "ПРОМПТ priority"), message(93)]);
  try { f.setTime(120000); const choice = selected(await f.poll());
    assert.equal(choice.primary.messageId, 92); assert.equal(choice.initiative, undefined); assert.deepEqual(f.checkpoints, [92]);
  } finally { f.adapter.close(); }
});

test("reply to another human becomes an observed passive anchor; reply to self remains guaranteed", async () => {
  const f = await fixture([message(80, "Human anchor"), message(91, "Replying to that human", "456", 80)]);
  try {
    f.setTime(120000); assert.equal((await f.poll()).kind, "more"); f.advance(6000);
    const choice = selected(await f.poll()); assert.equal(choice.initiative, true); assert.equal(choice.primary.messageId, 91);
    const reply = { chatId: binding.peerId, replyToMessageId: 91, text: "Joining the discussion", randomId: "1234" };
    const sent = await choice.transport.sendOnce(reply, f.abort.signal);
    const readback = await choice.transport.readExact(binding.peerId, sent.messageId, f.abort.signal);
    assert.equal(readback?.text, reply.text);
    f.values.push(message(93, "Followup", "456", 92));
    const direct = selected(await f.poll()); assert.equal(direct.initiative, undefined); assert.equal(direct.primary.messageId, 93);
  } finally { f.adapter.close(); }
});

test("continuous fresh conversation reaches maximum burst wait without quiet-period starvation", async () => {
  const f = await fixture([message(91)]);
  try {
    f.setTime(120000); assert.equal((await f.poll()).kind, "idle");
    let choice: StandingSelection | undefined;
    for (let i = 1; i <= 20; i++) {
      f.advance(2000); f.values.push(message(91 + i, "Another fresh human contribution"));
      const result = await f.poll(); if (result.kind === "selected") { choice = result.selection; break; }
    }
    assert.ok(choice); assert.equal(choice.initiative, true); assert.equal(choice.primary.messageId, f.values.at(-1)!.id);
    assert.ok(f.time() < 165000); await choice.finishInitiative!();
  } finally { f.adapter.close(); }
});

test("disabled switch prevents admission and prevents transport after already-selected initiative", async () => {
  const f = await fixture([message(91)]);
  try {
    f.setTime(120000); await f.poll(); f.enabled(false); f.advance(6000);
    assert.equal((await f.poll()).kind, "idle"); assert.deepEqual(f.questions, []);
    f.enabled(true); f.values.push(message(92)); await f.poll(); f.advance(6000);
    const choice = selected(await f.poll()); f.enabled(false);
    await assert.rejects(choice.transport.sendOnce({ chatId: binding.peerId, replyToMessageId: 92, text: "not sent", randomId: "1234" }, f.abort.signal));
    assert.equal(f.calls.some(call => call instanceof Api.messages.SendMessage), false);
  } finally { f.adapter.close(); }
});

test("new guaranteed arrival during debounce takes priority; edited passive source is skipped before model selection", async () => {
  const f = await fixture([message(91)]);
  try {
    f.setTime(120000); await f.poll(); f.advance(6000); f.values.push(message(92, "ПРОМПТ arrived"));
    assert.equal(selected(await f.poll()).primary.messageId, 92);
  } finally { f.adapter.close(); }
  const edited = await fixture([message(91)]);
  try {
    edited.setTime(120000); await edited.poll(); edited.advance(6000);
    edited.hook(request => { if (request instanceof Api.channels.GetMessages) edited.values[0]!.message = "Edited after collect"; });
    assert.equal((await edited.poll()).kind, "more"); assert.deepEqual(edited.questions, []); assert.equal(edited.checkpoints.at(-1), 91);
    edited.hook(undefined); edited.values.push(message(92, "ПРОМПТ next"));
    assert.equal(selected(await edited.poll()).primary.messageId, 92);
  } finally { edited.adapter.close(); }
});

test("edited or deleted queued primary skips only that stale source and preserves the following request", async () => {
  for (const mode of ["edit", "delete", "remove-trigger", "empty", "document"] as const) {
    const f = await fixture([message(91, "ПРОМПТ original"), message(92, "ПРОМПТ following")], false);
    try {
      let changed = false;
      f.hook(request => {
        if (!(request instanceof Api.channels.GetMessages) || (request.id[0] as Api.InputMessageID).id !== 91 || changed) return;
        changed = true;
        if (mode === "delete") f.values.splice(0, 1);
        else if (mode === "document") f.values[0]!.media = new Api.MessageMediaDocument({ document: new Api.DocumentEmpty({ id: bigInt(1234) }) });
        else f.values[0]!.message = mode === "edit" ? "ПРОМПТ edited" : mode === "empty" ? "" : "No longer addressed";
      });
      assert.equal((await f.poll()).kind, "more"); assert.deepEqual(f.questions, []); assert.deepEqual(f.checkpoints, [91]);
      const next = selected(await f.poll()); assert.equal(next.primary.messageId, 92); assert.equal(next.continuation, undefined);
      assert.equal(f.calls.some(call => call instanceof Api.messages.SendMessage), false);
    } finally { f.adapter.close(); }
  }
});

test("fresh-start baseline never revives a pre-start ordinary human as continuation", async () => {
  const f = await fixture([message(89, "Recent own invitation", "789")], false); f.adapter.close();
  const { resumeCursor: _resume, ...freshInput } = f.input;
  const adapter = await createStandingConversationAdapter({ ...freshInput, startedAt: 101 });
  try {
    f.values.push(message(90, "Historical response delivered after baseline"));
    const result = await adapter.pollNext(f.abort.signal);
    assert.equal(result.kind, "idle"); assert.deepEqual(f.questions, []);
  } finally { adapter.close(); }
});

test("bot and service messages do not hide a fresh cold continuation", async () => {
  for (const kind of ["bot", "service"] as const) {
    const f = await fixture([message(90, "Who wants to continue?", "789"), message(92, "гоу")], false);
    try {
      f.values.push(kind === "bot" ? message(91, "Bot event", "9") : new Api.MessageService({ id: 91, peerId: peer,
        date: 100, action: new Api.MessageActionEmpty() }) as unknown as Api.Message);
      f.setTime(100000); const choice = selected(await f.poll());
      assert.equal(choice.continuation, true); assert.equal(choice.primary.messageId, 92); await choice.finishInitiative!();
    } finally { f.adapter.close(); }
  }
});

test("foreign identity and malformed exact source still fail instead of being classified as a harmless edit", async () => {
  for (const mode of ["peer", "author", "date", "shape"] as const) {
    const f = await fixture([message(91, "ПРОМПТ original")], false);
    try {
      f.hook(request => {
        if (!(request instanceof Api.channels.GetMessages)) return;
        if (mode === "peer") f.values[0]!.peerId = new Api.PeerChannel({ channelId: bigInt(999) });
        if (mode === "author") f.values[0]!.fromId = new Api.PeerUser({ userId: bigInt(9) });
        if (mode === "date") f.values[0]!.date = 0;
        if (mode === "shape") f.values[0]!.message = "bad\0message";
      });
      await assert.rejects(f.poll(), (error: unknown) => (error as { code?: string }).code === "protocol");
      assert.deepEqual(f.checkpoints, []); assert.deepEqual(f.questions, []);
    } finally { f.adapter.close(); }
  }
});

test("exact own-anchor deletion before context is local while foreign or malformed replacements still stop", async () => {
  for (const mode of ["delete", "peer", "author", "malformed"] as const) {
    const f = await fixture([message(80, "Own anchor", "789"), message(91, "Follow up", "456", 80), message(92, "ПРОМПТ next")], false);
    try {
      let reads = 0;
      f.hook(request => {
        if (!(request instanceof Api.channels.GetMessages) || (request.id[0] as Api.InputMessageID).id !== 80 || ++reads !== 2) return;
        if (mode === "delete") f.values.splice(0, 1);
        if (mode === "peer") f.values[0]!.peerId = new Api.PeerChannel({ channelId: bigInt(999) });
        if (mode === "author") f.values[0]!.fromId = new Api.PeerUser({ userId: bigInt(456) });
        if (mode === "malformed") f.values[0]!.message = "invalid\0source";
      });
      if (mode === "delete") {
        assert.equal((await f.poll()).kind, "more"); assert.deepEqual(f.questions, []);
        assert.equal(selected(await f.poll()).primary.messageId, 92);
      } else {
        await assert.rejects(f.poll(), (error: unknown) => (error as {code?: string}).code === "protocol");
        assert.deepEqual(f.checkpoints, []);
      }
    } finally { f.adapter.close(); }
  }
});

test("switch disabled during final actual message read refuses physical send", async () => {
  const f = await fixture([message(91)]);
  try {
    f.setTime(120000); await f.poll(); f.advance(6000); const choice = selected(await f.poll());
    f.hook(request => { if (request instanceof Api.channels.GetMessages) f.enabled(false); });
    await assert.rejects(choice.transport.sendOnce({ chatId: binding.peerId, replyToMessageId: 91, text: "not sent", randomId: "1234" }, f.abort.signal));
    assert.equal(f.calls.some(call => call instanceof Api.messages.SendMessage), false);
  } finally { f.adapter.close(); }
});

test("reconnecting re-arms full cooldown and resumed cursor never reconsiders consumed anchor", async () => {
  const f = await fixture([message(92)], true, 92);
  try {
    assert.equal((await f.poll()).kind, "idle"); f.values.push(message(93)); f.setTime(119000);
    assert.equal((await f.poll()).kind, "idle"); assert.deepEqual(f.questions, []);
    f.setTime(240000); f.values.push(message(94)); await f.poll(); f.advance(6000);
    assert.equal(selected(await f.poll()).primary.messageId, 94);
  } finally { f.adapter.close(); }
});

test("initiative options are inert and a regular callback returning rejected Promise disables without unhandled work", async () => {
  const f = await fixture([message(91)]); f.adapter.close(); let reads = 0;
  try {
    for (const initiative of [
      { get enabled() { reads++; return () => true; } },
      { enabled: async () => true }, { enabled: function* () { yield true; } },
      { enabled: new Proxy(() => true, { apply() { reads++; return true; } }) },
      { enabled: () => true, minimumIntervalMs: 0 }, { enabled: () => true, debounceMs: 30001 },
    ]) await assert.rejects(createStandingConversationAdapter({ ...f.input, initiative: initiative as never }));
    assert.equal(reads, 0);
    const adapter = await createStandingConversationAdapter({ ...f.input, initiative: { enabled: () => Promise.reject(Error("synthetic rejected callback")) as never } });
    try { f.setTime(500000); assert.equal((await adapter.pollNext(f.abort.signal)).kind, "idle"); await new Promise(resolve => setImmediate(resolve)); }
    finally { adapter.close(); }
  } finally { f.abort.abort(); }
});
