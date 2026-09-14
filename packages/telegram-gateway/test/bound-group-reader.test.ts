import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import { createBoundGroupReader, BoundGroupReaderError } from "../src/bound-group-reader.js";
const wire = (v: { getBytes(): Buffer }) => new BinaryReader(v.getBytes()).tgReadObject();
const user = (n: number) => new Api.User({ id: bigInt(n), firstName: "Участник " + n, username: "member_" + n, phone: "PRIVATE_PHONE", accessHash: bigInt(567) });
const part = (n: number) => new Api.ChannelParticipant({ userId: bigInt(n), date: 1 });
const refused = (code: string) => (e: unknown) => e instanceof BoundGroupReaderError && e.code === code && !e.cause;
function fixture(basic = false, total = 203, withheld = false) {
  const signal = new AbortController(), calls: Api.AnyRequest[] = [];
  const peer = basic ? new Api.InputPeerChat({ chatId: bigInt(123) }) : new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(987) });
  const chat = basic ? new Api.Chat({ id: bigInt(123), title: "Group", photo: new Api.ChatPhotoEmpty(), date: 1, participantsCount: total, version: 1 }) :
    new Api.Channel({ id: bigInt(123), accessHash: bigInt(987), title: "Group", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true });
  const users = Array.from({ length: total }, (_, i) => user(i + 1000));
  const full = () => new Api.messages.ChatFull({ chats: [chat], users: basic ? users : [], fullChat: basic ?
    new Api.ChatFull({ id: bigInt(123), about: "About", notifySettings: new Api.PeerNotifySettings({}), participants: withheld ? new Api.ChatParticipantsForbidden({ chatId: bigInt(123) }) :
      new Api.ChatParticipants({ chatId: bigInt(123), version: 1, participants: users.map(u => new Api.ChatParticipant({ userId: u.id, inviterId: bigInt(7), date: 1 })) }) }) :
    new Api.ChannelFull({ id: bigInt(123), about: "About", participantsCount: total, canViewParticipants: !withheld, participantsHidden: withheld, readInboxMaxId: 0,
      readOutboxMaxId: 0, unreadCount: 0, chatPhoto: new Api.PhotoEmpty({ id: bigInt(1) }), notifySettings: new Api.PeerNotifySettings({}), botInfo: [], pts: 1 }) });
  let override: ((r: Api.AnyRequest) => Promise<unknown>) | undefined;
  const options = { peer, binding: { accountId: "7", peerId: utils.getPeerId(basic ? new Api.PeerChat({ chatId: bigInt(123) }) : new Api.PeerChannel({ channelId: bigInt(123) })) },
    self: new Api.User({ id: bigInt(7), self: true }), signal: signal.signal, client: { async invoke(r: Api.AnyRequest) {
      calls.push(r); wire(r);
      if (r instanceof Api.channels.GetFullChannel || r instanceof Api.channels.GetParticipants) { assert.equal((r.channel as Api.InputChannel).channelId.toString(), "123"); assert.equal((r.channel as Api.InputChannel).accessHash.toString(), "987"); }
      else { assert.ok(r instanceof Api.messages.GetFullChat); assert.equal(r.chatId.toString(), "123"); }
      if (override) return override(r);
      if (r instanceof Api.channels.GetParticipants) { assert.equal(r.limit, 100); const selected = users.slice(r.offset, r.offset + 73); return wire(new Api.channels.ChannelParticipants({ count: total, users: selected, participants: selected.map(u => part(Number(u.id))), chats: [] })); }
      return wire(full());
    } } };
  return { options, calls, signal, full, reader: createBoundGroupReader(options), override: (v: typeof override) => { override = v; } };
}
test("supergroup uses binary TL roundtrips and short-page offsets without skipping; opaque stable refs", async () => {
  const f = fixture(); const info = await f.reader.groupInfo(); assert.equal(info.memberCount, 203); assert.equal(info.kind, "supergroup");
  const all: string[] = []; let cursor: string | undefined;
  for (let n = 0; n < 5; n++) { const p = await f.reader.listParticipants(cursor ? { cursor } : {}); assert.equal(p.coverage.fullRoster, false);
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 65536); assert.ok(!JSON.stringify(p).includes("PRIVATE_PHONE")); assert.ok(!JSON.stringify(p).includes("accessHash"));
    all.push(...p.members.map(m => m.memberRef)); if (!p.cursor) { assert.equal(p.status, "exhausted"); break; } cursor = p.cursor;
  }
  assert.equal(new Set(all).size, 203); assert.deepEqual(f.calls.filter(r => r instanceof Api.channels.GetParticipants).map(r => r.offset), [0, 73, 146, 203]);
  assert.equal((await f.reader.listParticipants()).members[0]!.memberRef, all[0]); await f.reader.close();
});
test("basic group snapshots paginate 100 without repeat network reads", async () => {
  const f = fixture(true, 150), p = await f.reader.listParticipants(); assert.equal(p.members.length, 100);
  const q = await f.reader.listParticipants({ cursor: p.cursor! }); assert.equal(q.members.length, 50); assert.equal(q.status, "exhausted"); assert.equal(f.calls.length, 1);
  await assert.rejects(f.reader.listParticipants({ cursor: p.cursor! }), refused("cursor")); await f.reader.close();
});
test("withheld roster remains explicit for both peer kinds", async () => {
  for (const basic of [true, false]) { const f = fixture(basic, 2, true); assert.equal((await f.reader.groupInfo()).permissions.canViewParticipants, false);
    const p = await f.reader.listParticipants(); assert.equal(p.status, "inaccessible"); assert.equal(p.coverage.paginationComplete, false); assert.equal(p.members.length, 0);
    assert.ok(f.calls.every(r => !(r instanceof Api.channels.GetParticipants))); await f.reader.close(); }
});
test("binding snapshot resists source mutation and refuses foreign self", async () => {
  const f = fixture(); f.options.peer instanceof Api.InputPeerChannel && (f.options.peer.channelId = bigInt(999)); f.options.binding.peerId = "-999"; f.options.self.id = bigInt(8);
  await f.reader.groupInfo(); assert.throws(() => createBoundGroupReader(f.options), refused("binding")); await f.reader.close();
});
test("foreign full entity, duplicate and wrong self refused", async () => {
  for (const mode of ["foreign", "duplicate", "self"] as const) { const f = fixture(false, 1);
    f.override(async r => { if (!(r instanceof Api.channels.GetParticipants)) { const e = f.full(); if (mode === "foreign") e.fullChat.id = bigInt(999); return e; }
      const u = user(1000); if (mode === "self") u.self = true;
      return new Api.channels.ChannelParticipants({ count: 1, chats: [], users: mode === "duplicate" ? [u, u] : [u], participants: [part(1000)] }); });
    await assert.rejects(f.reader.listParticipants(), refused("protocol")); await f.reader.close(); }
});
test("STOP revokes immediately while close joins actual invoke settlement and single flight", async () => {
  const f = fixture(); let finish!: (v: unknown) => void;
  f.override(() => new Promise(resolve => { finish = resolve; }));
  const work = f.reader.groupInfo(); await Promise.resolve(); await assert.rejects(f.reader.groupInfo(), refused("busy"));
  f.signal.abort(); let settled = false; const close = f.reader.close().then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  await assert.rejects(f.reader.listParticipants(), refused("aborted")); finish(f.full()); await assert.rejects(work, refused("aborted")); await close; assert.equal(settled, true);
});
test("fixed errors hide raw transport messages; foreign cursor and model selectors rejected", async () => {
  const f = fixture(); await assert.rejects(f.reader.listParticipants({ cursor: "foreign" }), refused("cursor"));
  await assert.rejects(f.reader.listParticipants({ peerId: "123" } as never), refused("input"));
  f.override(async () => { throw new Error("PRIVATE_SECRET"); }); await assert.rejects(f.reader.groupInfo(), refused("transport"));
  f.override(async () => { throw { errorMessage: "CHAT_ADMIN_REQUIRED" }; }); assert.equal((await f.reader.listParticipants()).status, "inaccessible"); await f.reader.close();
});
test("malformed counts, permissions and participant envelopes refuse without projecting", async () => {
  for (const mode of ["count", "flag", "oversize", "invalid-chat"] as const) {
    const f = fixture(); f.override(async r => {
      if (!(r instanceof Api.channels.GetParticipants)) { const e = f.full(); assert.ok(e.fullChat instanceof Api.ChannelFull);
        if (mode === "count") e.fullChat.participantsCount = -1;
        if (mode === "flag") e.fullChat.canViewParticipants = "yes" as never;
        return e;
      }
      return new Api.channels.ChannelParticipants({ count: 101, users: [], participants: mode === "oversize" ? Array.from({ length: 101 }, (_, i) => part(i + 1000)) : [],
        chats: mode === "invalid-chat" ? [new Api.ChatEmpty({ id: bigInt.zero })] : [] });
    }); await assert.rejects(f.reader.listParticipants(), refused("protocol")); await f.reader.close();
  }
});
test("hidden participants never become a full-roster claim even if visible to this account", async () => {
  const f = fixture(false, 0); f.override(async r => {
    if (r instanceof Api.channels.GetParticipants) return new Api.channels.ChannelParticipants({ count: 500, participants: [], users: [], chats: [] });
    const e = f.full(); assert.ok(e.fullChat instanceof Api.ChannelFull); e.fullChat.participantsHidden = true; return e;
  }); assert.equal((await f.reader.groupInfo()).permissions.participantsHidden, true);
  const p = await f.reader.listParticipants(); assert.equal(p.status, "exhausted"); assert.equal(p.coverage.fullRoster, false); await f.reader.close();
});
test("maximum bounded member names fit a 64KiB page without skipping", async () => {
  const f = fixture(); f.override(async r => {
    if (!(r instanceof Api.channels.GetParticipants)) return f.full();
    const users = Array.from({ length: 100 }, (_, i) => { const u = user(i + 1000); u.firstName = "😀".repeat(64); u.lastName = "😀".repeat(64); u.username = "a".repeat(64); return u; });
    return new Api.channels.ChannelParticipants({ count: 100, users, participants: users.map(u => part(Number(u.id))), chats: [] });
  }); const p = await f.reader.listParticipants(); assert.equal(p.members.length, 100); assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 65536); await f.reader.close();
});
test("request cursor is synchronously copied before deferred work", async () => {
  const f = fixture(true, 150), first = await f.reader.listParticipants();
  const request = { cursor: first.cursor! }, work = f.reader.listParticipants(request);
  request.cursor = "foreign";
  const next = await work; assert.equal(next.members.length, 50); assert.equal(next.status, "exhausted");
  const nullRecord = Object.create(null) as { cursor?: string };
  assert.equal((await f.reader.listParticipants(nullRecord)).members.length, 100);
  await f.reader.close();
});
test("accessors, proxies, prototypes and symbol keys are rejected without running caller code", async () => {
  const f = fixture(); let getterCalls = 0, proxyCalls = 0;
  const accessor = Object.defineProperty({}, "cursor", { get() { getterCalls++; void f.reader.groupInfo(); return undefined; } });
  const proxy = new Proxy({}, { getPrototypeOf() { proxyCalls++; return Object.prototype; }, ownKeys() { proxyCalls++; return []; }, get() { proxyCalls++; return undefined; } });
  for (const request of [accessor, proxy, Object.create({ cursor: undefined }), { [Symbol("selector")]: "foreign" }]) {
    await assert.rejects(f.reader.listParticipants(request), refused("input"));
  }
  assert.equal(getterCalls, 0); assert.equal(proxyCalls, 0); assert.equal(f.calls.length, 0);
  await f.reader.groupInfo(); await f.reader.close();
});

test("binary partial, deleted, empty and absent profiles preserve every confirmed row in both group kinds", async () => {
  for (const basic of [true, false]) {
    const f = fixture(basic, 5);
    const deleted = user(1001); deleted.deleted = true;
    const minimal = user(1002); minimal.min = true;
    const users = [user(1000), deleted, minimal, new Api.UserEmpty({ id: bigInt(1003) }), new Api.UserEmpty({ id: bigInt(9000) })];
    f.override(async r => {
      if (basic) { const e = f.full(); e.users = users; return wire(e); }
      if (!(r instanceof Api.channels.GetParticipants)) return wire(f.full());
      return wire(new Api.channels.ChannelParticipants({ count: 5, chats: [], users, participants: r.offset === 0 ? [1000, 1001, 1002, 1003, 1004].map(part) : [] }));
    });
    const p = await f.reader.listParticipants();
    assert.deepEqual(p.members.map(m => m.metadata), ["full", "deleted", "partial", "unavailable", "unavailable"]);
    assert.equal(p.members[0]!.username, "member_1000"); assert.equal(p.members[2]!.username, "member_1002");
    for (const i of [1, 3, 4]) assert.equal(Object.hasOwn(p.members[i]!, "username"), false);
    assert.equal(p.members[1]!.displayName, "Удалённый аккаунт");
    assert.equal(p.coverage.participantRows, 5); assert.equal(p.coverage.fullRoster, false);
    assert.deepEqual(p.coverage.metadata, { scope: "returned-page", complete: false, full: 1, partial: 1, deleted: 1, unavailable: 2 });
    if (!basic) { const q = await f.reader.listParticipants({ cursor: p.cursor! }); assert.equal(q.status, "exhausted");
      assert.deepEqual(f.calls.filter(r => r instanceof Api.channels.GetParticipants).map(r => r.offset), [0, 5]); }
    await f.reader.close();
  }
});

test("valid unrelated binary users and all TL chat variants do not change target or page completeness", async () => {
  const f = fixture(false, 1), deleted = user(9000); deleted.deleted = true;
  const chats = [new Api.ChatEmpty({ id: bigInt(999) }),
    new Api.Chat({ id: bigInt(998), title: "Other", photo: new Api.ChatPhotoEmpty(), date: 1, participantsCount: 1, version: 1 }),
    new Api.ChatForbidden({ id: bigInt(997), title: "Other" }),
    new Api.Channel({ id: bigInt(123), title: "Unused", photo: new Api.ChatPhotoEmpty(), date: 1, megagroup: true }),
    new Api.ChannelForbidden({ id: bigInt(999), accessHash: bigInt(2), title: "Other", megagroup: true })];
  f.override(async r => r instanceof Api.channels.GetParticipants ? wire(new Api.channels.ChannelParticipants({ count: 1, chats,
    users: [user(1000), deleted, new Api.UserEmpty({ id: bigInt(9001) })], participants: [part(1000)] })) : wire(f.full()));
  const p = await f.reader.listParticipants(); assert.equal(p.members.length, 1); assert.equal(p.coverage.metadata.complete, true);
  assert.equal(p.members[0]!.displayName, "Участник 1000"); assert.equal(f.calls.length, 2); await f.reader.close();
});

test("malformed associations, duplicate rows and contradictory self remain refused", async () => {
  for (const mode of ["row-duplicate", "user-duplicate", "foreign-self", "deleted-self", "bad-id", "bad-user", "bad-chat", "duplicate-chat"] as const) {
    const f = fixture(false, 1);
    f.override(async r => {
      if (!(r instanceof Api.channels.GetParticipants)) return wire(f.full());
      const u = user(1000); const users: Api.TypeUser[] = [u]; const participants: Api.TypeChannelParticipant[] = [part(1000)];
      const chats: Api.TypeChat[] = [];
      if (mode === "row-duplicate") participants.push(part(1000));
      if (mode === "user-duplicate") users.push(new Api.UserEmpty({ id: u.id }));
      if (mode === "foreign-self") participants[0] = new Api.ChannelParticipantSelf({ userId: u.id, inviterId: bigInt(7), date: 1 });
      if (mode === "deleted-self") users.push(new Api.User({ id: bigInt(7), deleted: true }));
      if (mode === "bad-id") participants[0] = part(0);
      if (mode === "bad-user") users.push(new Api.ChatEmpty({ id: bigInt(999) }) as never);
      if (mode === "bad-chat") chats.push(user(999) as never);
      if (mode === "duplicate-chat") chats.push(new Api.ChatEmpty({ id: bigInt(999) }), new Api.ChatForbidden({ id: bigInt(999), title: "Other" }));
      return wire(new Api.channels.ChannelParticipants({ count: 2, participants, users, chats }));
    });
    await assert.rejects(f.reader.listParticipants(), refused("protocol")); await f.reader.close();
  }
});

test("partial metadata snapshot continuation preserves raw rows and per-page counts", async () => {
  const f = fixture(true, 150);
  f.override(async () => { const e = f.full(); e.users = [user(1000)]; return wire(e); });
  const first = await f.reader.listParticipants(), second = await f.reader.listParticipants({ cursor: first.cursor! });
  assert.equal(first.members.length, 100); assert.equal(first.coverage.participantRows, 100); assert.equal(first.coverage.metadata.unavailable, 99);
  assert.equal(second.members.length, 50); assert.equal(second.coverage.participantRows, 50); assert.equal(second.coverage.metadata.unavailable, 50);
  assert.equal(second.status, "exhausted"); assert.equal(second.coverage.metadata.complete, false);
  assert.equal(new Set([...first.members, ...second.members].map(m => m.memberRef)).size, 150); assert.equal(f.calls.length, 1); await f.reader.close();
});

test("close during actual participant read joins late binary incomplete metadata without publishing it", async () => {
  const f = fixture(false, 1); let finish!: (value: unknown) => void, started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  f.override(async r => { if (!(r instanceof Api.channels.GetParticipants)) return wire(f.full()); started(); return new Promise(resolve => { finish = resolve; }); });
  const work = f.reader.listParticipants(); await reading;
  await assert.rejects(f.reader.listParticipants(), refused("busy"));
  let settled = false; const closing = f.reader.close().then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  finish(wire(new Api.channels.ChannelParticipants({ count: 1, participants: [part(1000)], users: [], chats: [] })));
  await assert.rejects(work, refused("aborted")); await closing; assert.equal(settled, true);
});
