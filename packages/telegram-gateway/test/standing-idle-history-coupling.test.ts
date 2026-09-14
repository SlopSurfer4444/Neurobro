import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Api } from "telegram";
import bigInt from "big-integer";
import { createStandingConversationAdapter } from "../src/standing-conversation-adapter.js";
import { createConversationReferences } from "../src/conversation-references.js";
import { openStandingHistoryTaskStore, type StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";
import { openStandingHistoryTaskDiscovery } from "../src/standing-history-task-discovery.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import { runStandingHistoryReadStep } from "../src/standing-history-read-step.js";

test("idle same-client page commits survive task rediscovery while a new addressed question is handled first", async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-idle-coupled-"));
  const directory = join(root, "pages"), controlDirectory = join(root, "controls");
  await mkdir(directory); await mkdir(controlDirectory);
  const binding = { accountId: "789", peerId: "-100123" }, control = new AbortController();
  const references = createConversationReferences(binding), passphrase = "synthetic-idle-history-passphrase";
  const intent: StandingHistoryTaskIntent = { schema: "standing-history-task-v1", taskId: "htask_" + randomBytes(24).toString("hex"),
    accountId: binding.accountId, chatId: binding.peerId, requesterId: "456", primaryMessageId: 180,
    fromDate: 1, toDate: 200, timezone: "Europe/Moscow", objective: "Read earlier conversation" };
  const make = (id: number, text: string, own = false) => new Api.Message({ id, date: 100, message: text,
    peerId: new Api.PeerChannel({ channelId: bigInt(123) }), fromId: new Api.PeerUser({ userId: bigInt(own ? 789 : 456) }), ...(own ? { out: true } : {}) });
  const messages = Array.from({ length: 105 }, (_, i) => make(i + 1, "Saved source " + i));
  const users = [new Api.User({ id: bigInt(789), self: true }), new Api.User({ id: bigInt(456), firstName: "Participant" })];
  // Each RPC owns its envelope arrays; production readers clear them on release.
  const batch = (rows: Api.TypeMessage[]) => new Api.messages.Messages({ messages: rows, users: [...users], chats: [] });
  let time = 0, concurrent = 0, maximumConcurrent = 0, dialogs = 0;
  const checkpoints: number[] = [];
  const adapter = await createStandingConversationAdapter({ binding, references, self: users[0]!, signal: control.signal,
    startedAt: 100, resumeCursor: 200, enableSelfHistory: true, clock: () => time,
    wait: async ms => { time += ms; }, checkpointCursor: async cursor => { checkpoints.push(cursor); },
    client: { async invoke(request: Api.AnyRequest) {
      concurrent++; maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      try {
        await new Promise<void>(done => setImmediate(done));
        assert.ok(request.getBytes().length);
        if (request instanceof Api.messages.GetDialogs) {
          dialogs++;
          return new Api.messages.Dialogs({ dialogs: [new Api.Dialog({ peer: new Api.PeerChannel({ channelId: bigInt(123) }),
            topMessage: 105, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0,
            notifySettings: new Api.PeerNotifySettings({}) })], messages: [], users: [], chats: [new Api.Channel({ id: bigInt(123),
              accessHash: bigInt(987), title: "Synthetic group", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true })] });
        }
        if (request instanceof Api.messages.GetHistory) return batch(messages.filter(m => m.id > request.minId &&
          (!request.offsetId || m.id < request.offsetId) && (!request.offsetDate || m.date < request.offsetDate))
          .sort((a, b) => b.id - a.id).slice(0, request.limit));
        if (request instanceof Api.channels.GetMessages || request instanceof Api.messages.GetMessages) {
          const id = (request.id[0] as Api.InputMessageID).id;
          return batch([messages.find(m => m.id === id) ?? new Api.MessageEmpty({ id })]);
        }
        if (request instanceof Api.messages.SendMessage) {
          const sent = make(202, request.message, true);
          sent.replyTo = new Api.MessageReplyHeader({ replyToMsgId: (request.replyTo as Api.InputReplyToMessage).replyToMsgId }); messages.push(sent);
          return new Api.UpdateShortSentMessage({ id: sent.id, out: true, pts: 1, ptsCount: 1, date: 100 });
        }
        if (request instanceof Api.messages.SetTyping) return true;
        throw Error("unexpected synthetic request");
      } finally { concurrent--; }
    } } });
  let store = await openStandingHistoryTaskStore({ directory, passphrase, intent, mode: "create" });
  const taskControl = await openStandingHistoryTaskControlStore({ directory: controlDirectory, passphrase, intent, mode: "create" });
  const expectedControlHead = (await taskControl.status()).headHash; await taskControl.close();
  try {
    const first = await adapter.pollNext(control.signal); assert.equal(first.kind, "idle"); if (first.kind !== "idle") throw Error();
    const expectedSourceHead = (await store.status()).readProgress.chainHash; await store.close();
    const firstStep = await runStandingHistoryReadStep({ intent, directories: { pages: directory, control: controlDirectory },
      passphrase, expectedControlHead, expectedSourceHead, ticket: first.ticket, signal: control.signal });
    assert.equal(firstStep.kind, "committed");
    const discovery = await openStandingHistoryTaskDiscovery({ directory, passphrase, accountId: binding.accountId, chatId: binding.peerId });
    const found = await discovery.find(); await discovery.close(); assert.equal(found.tasks.length, 1);
    const recoveredIntent = found.tasks[0]!;
    store = await openStandingHistoryTaskStore({ directory, passphrase, intent: recoveredIntent, mode: "open" });
    assert.equal((await store.readPage(1))!.result.sources.length, 100);
    messages.push(make(201, "ПРОМПТ answer this new question"));
    const next = await adapter.pollNext(control.signal); assert.equal(next.kind, "selected"); if (next.kind !== "selected") throw Error();
    assert.equal(next.selection.primary.messageId, 201);
    assert.equal((await store.status()).readProgress.committedPages, 1);
    const outgoing = { chatId: binding.peerId, replyToMessageId: 201, text: "Foreground answer", randomId: "123456789" };
    const sent = await next.selection.transport.sendOnce(outgoing, control.signal);
    await next.selection.transport.readExact(binding.peerId, sent.messageId, control.signal);
    const idle = await adapter.pollNext(control.signal); assert.equal(idle.kind, "idle"); if (idle.kind !== "idle") throw Error();
    const continuedHead = (await store.status()).readProgress.chainHash; await store.close();
    const secondStep = await runStandingHistoryReadStep({ intent: recoveredIntent, directories: { pages: directory, control: controlDirectory },
      passphrase, expectedControlHead, expectedSourceHead: continuedHead, ticket: idle.ticket, signal: control.signal });
    assert.equal(secondStep.kind, "committed");
    store = await openStandingHistoryTaskStore({ directory, passphrase, intent: recoveredIntent, mode: "open" });
    assert.deepEqual((await store.readPage(2))!.result.sources.map(s => s.messageId), [5, 4, 3, 2, 1]);
    assert.equal((await store.status()).readProgress.committedPages, 2);
    assert.equal(dialogs, 1); assert.equal(maximumConcurrent, 1); assert.ok(checkpoints.includes(201));
  } finally { await store.close(); await adapter.closeCapabilities(); references.close(); }
});
