import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Api, utils } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import { createStandingGroupAvatar } from "../src/standing-group-avatar.js";
import type { StandingSelfProfileImage } from "../src/standing-self-profile.js";
import { STANDING_AVATAR_MAX_BYTES } from "../src/standing-avatar-policy.js";

const wire = <T extends { getBytes(): Buffer }>(v: T): T => new BinaryReader(v.getBytes()).tgReadObject() as T;
const png = (): StandingSelfProfileImage => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=", "base64");
  return { bytes, mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") };
};
const sizedPng = (size: number): StandingSelfProfileImage => {
  const small = png().bytes as Buffer, payload = Buffer.alloc(size - small.length - 12, 65), extra = Buffer.alloc(payload.length + 12);
  extra.writeUInt32BE(payload.length); extra.write("tEXt", 4); payload.copy(extra, 8);
  const bytes = Buffer.concat([small.subarray(0, 33), extra, small.subarray(33)]);
  return { bytes, mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") };
};
function fixture(basic = false) {
  const peer = basic ? new Api.InputPeerChat({ chatId: bigInt(456) }) : new Api.InputPeerChannel({ channelId: bigInt(456), accessHash: bigInt(987) });
  const binding = { accountId: "123", peerId: utils.getPeerId(peer) }, self = wire(new Api.User({ id: bigInt(123), self: true }));
  const signal = new AbortController(), requests: Api.AnyRequest[] = [];
  let photoId: number | undefined, override: ((r: Api.AnyRequest) => Promise<unknown>) | undefined;
  const chat = (id = 456, photo = photoId, extra: object = {}) => basic ? new Api.Chat({ id: bigInt(id), title: "Group", date: 1, participantsCount: 1, version: 1,
    photo: photo === undefined ? new Api.ChatPhotoEmpty() : new Api.ChatPhoto({ photoId: bigInt(photo), dcId: 1 }), ...extra }) :
    new Api.Channel({ id: bigInt(id), accessHash: bigInt(987), title: "Group", date: 1, megagroup: true,
      photo: photo === undefined ? new Api.ChatPhotoEmpty() : new Api.ChatPhoto({ photoId: bigInt(photo), dcId: 1 }), ...extra });
  const chats = (value = chat()) => wire(new Api.messages.Chats({ chats: [value] }));
  const ack = (id = 55, group = 456, author = 123) => {
    const message = new Api.MessageService({ id: 90, date: 1, out: true, fromId: new Api.PeerUser({ userId: bigInt(author) }),
      peerId: basic ? new Api.PeerChat({ chatId: bigInt(group) }) : new Api.PeerChannel({ channelId: bigInt(group) }),
      action: new Api.MessageActionChatEditPhoto({ photo: new Api.Photo({ id: bigInt(id), accessHash: bigInt(999), fileReference: Buffer.alloc(0), date: 1, sizes: [], dcId: 1 }) }) });
    return wire(new Api.Updates({ updates: [basic ? new Api.UpdateNewMessage({ message, pts: 1, ptsCount: 1 }) : new Api.UpdateNewChannelMessage({ message, pts: 1, ptsCount: 1 })], users: [], chats: [], date: 1, seq: 1 }));
  };
  async function respond(r: Api.AnyRequest): Promise<unknown> {
    if (r instanceof Api.messages.GetChats) { assert.equal(basic, true); assert.deepEqual(r.id.map(String), ["456"]); return chats(); }
    if (r instanceof Api.channels.GetChannels) { assert.equal(basic, false); assert.equal(r.id.length, 1); assert.ok(r.id[0] instanceof Api.InputChannel); assert.equal(r.id[0].channelId.toString(), "456"); assert.equal(r.id[0].accessHash.toString(), "987"); return chats(); }
    if (r instanceof Api.upload.SaveFilePart) return true;
    if (r instanceof Api.messages.EditChatPhoto || r instanceof Api.channels.EditPhoto) {
      if (r instanceof Api.messages.EditChatPhoto) { assert.equal(basic, true); assert.equal(r.chatId.toString(), "456"); }
      else { assert.equal(basic, false); assert.ok(r.channel instanceof Api.InputChannel); assert.equal(r.channel.channelId.toString(), "456"); }
      assert.ok(r.photo instanceof Api.InputChatUploadedPhoto); assert.ok(r.photo.file instanceof Api.InputFile);
      assert.equal(r.photo.file.id.toString(), "789"); photoId = 55; return ack();
    }
    throw Error("unapproved method");
  }
  const transport = createStandingGroupAvatar({ binding, peer, self, signal: signal.signal, revalidatePrimary: async () => {},
    client: { async invoke(r) { const decoded = wire(r); requests.push(decoded); return override ? override(decoded) : respond(decoded); } } });
  return { transport, signal, requests, chat, chats, ack, respond, override: (fn: typeof override) => { override = fn; }, setPhoto: (id: number) => { photoId = id; } };
}
const isEdit = (r: Api.AnyRequest) => r instanceof Api.messages.EditChatPhoto || r instanceof Api.channels.EditPhoto;
for (const basic of [true, false]) test(`binary ${basic ? "basic chat" : "megagroup"} upload/apply/fresh proof uses sole exact peer`, async () => {
  const f = fixture(basic), image = png(), before = Buffer.from(image.bytes);
  const pending = f.transport.setAvatar(image, "789"); image.bytes.fill(0);
  assert.deepEqual(await pending, { verdict: "verified", code: "verified", group: { hasPhoto: true } });
  assert.deepEqual((f.requests[1] as Api.upload.SaveFilePart).bytes, before);
  const photo = (f.requests[3] as Api.channels.EditPhoto).photo as Api.InputChatUploadedPhoto;
  assert.equal((photo.file as Api.InputFile).md5Checksum, createHash("md5").update(before).digest("hex"));
  assert.equal(f.requests.length, 5); assert.equal(f.requests.filter(isEdit).length, 1);
  assert.equal((await f.transport.setAvatar(png(), "790")).code, "state"); assert.equal(f.requests.length, 5);
  assert.equal(f.requests.some(r => r instanceof Api.photos.UploadProfilePhoto || r instanceof Api.messages.GetDialogs), false);
  await f.transport.close();
});

test("fresh group rights refusal occurs before upload; changeInfo admin overrides defaults", async () => {
  for (const basic of [true, false]) {
    const denied = fixture(basic); denied.override(async () => denied.chats(denied.chat(456, undefined, { defaultBannedRights: new Api.ChatBannedRights({ changeInfo: true, untilDate: 0 }) })));
    assert.deepEqual(await denied.transport.setAvatar(png(), "789"), { verdict: "refused", code: "rights" }); assert.equal(denied.requests.length, 1); await denied.transport.close();
    const allowed = fixture(basic); allowed.override(async r => {
      const response = await allowed.respond(r);
      if (response instanceof Api.messages.Chats) { const chat = response.chats[0] as Api.Chat; chat.defaultBannedRights = new Api.ChatBannedRights({ changeInfo: true, untilDate: 0 }); chat.adminRights = new Api.ChatAdminRights({ changeInfo: true }); return wire(response); }
      return response;
    });
    assert.equal((await allowed.transport.setAvatar(png(), "789")).verdict, "verified"); await allowed.transport.close();
  }
});

test("foreign group, min/broadcast/left and changed access hash refuse before upload", async () => {
  for (const extra of [{ min: true }, { broadcast: true }, { left: true }, { accessHash: bigInt(888) }]) {
    const f = fixture(); f.override(async () => f.chats(f.chat(456, undefined, extra)));
    assert.equal((await f.transport.setAvatar(png(), "789")).verdict, "refused"); assert.equal(f.requests.length, 1); await f.transport.close();
  }
  const f = fixture(); f.override(async () => f.chats(f.chat(999)));
  assert.equal((await f.transport.setAvatar(png(), "789")).code, "identity"); assert.equal(f.requests.length, 1); await f.transport.close();
});

test("anonymous administrator refuses before upload when own-user ACK attribution is unavailable", async () => {
  const f = fixture(); f.override(async () => f.chats(f.chat(456, undefined, { adminRights: new Api.ChatAdminRights({ changeInfo: true, anonymous: true }) })));
  assert.deepEqual(await f.transport.setAvatar(png(), "789"), { verdict: "refused", code: "rights" });
  assert.equal(f.requests.length, 1); await f.transport.close();
});

test("bad images, bounds, getters and shared bytes have zero network calls", async () => {
  const f = fixture(); let getter = 0;
  const bad = [ { ...png(), sha256: "0".repeat(64) }, { ...png(), bytes: Buffer.alloc(STANDING_AVATAR_MAX_BYTES + 1) },
    { ...png(), bytes: new Uint8Array(new SharedArrayBuffer(16)) }, { ...png(), get mediaType() { getter++; return "image/png"; } },
    { ...png(), bytes: Buffer.from([137,80,78,71,13,10,26,10]) }, { ...png(), peerId: "-999" } ];
  for (const image of bad) assert.equal((await f.transport.setAvatar(image as StandingSelfProfileImage, "789")).code, "input");
  assert.equal(getter, 0); assert.equal(f.requests.length, 0); await f.transport.close();
});

test("exact 8 MiB group avatar uses sixteen standard InputFile parts and verified group readback", async () => {
  const f = fixture(), image = sizedPng(STANDING_AVATAR_MAX_BYTES);
  assert.equal(image.bytes.byteLength, STANDING_AVATAR_MAX_BYTES);
  assert.deepEqual(await f.transport.setAvatar(image, "789"), { verdict: "verified", code: "verified", group: { hasPhoto: true } });
  const parts = f.requests.filter(value => value instanceof Api.upload.SaveFilePart) as Api.upload.SaveFilePart[];
  assert.equal(parts.length, 16); assert.deepEqual(parts.map(value => value.filePart), Array.from({ length: 16 }, (_, index) => index));
  const edit = f.requests.find(isEdit) as Api.channels.EditPhoto;
  assert.equal((edit.photo as Api.InputChatUploadedPhoto).file instanceof Api.InputFile, true);
  assert.equal(f.requests.length, 35); await f.transport.close();
});

test("apply failure and foreign/wrong-author/duplicate ACK are unknown and never retried", async () => {
  for (const mode of ["throw", "foreign", "author", "duplicate", "empty", "old"]) {
    const f = fixture(); f.override(async r => {
      if (!isEdit(r)) return f.respond(r);
      f.setPhoto(55);
      if (mode === "throw") throw Error("private server message");
      if (mode === "foreign") return f.ack(55, 999);
      if (mode === "author") return f.ack(55, 456, 999);
      const result = f.ack();
      if (mode === "duplicate") result.updates.push(result.updates[0]!);
      if (mode === "empty") result.updates = [];
      if (mode === "old") f.setPhoto(22);
      return result;
    });
    const result = await f.transport.setAvatar(png(), "789"); assert.equal(result.verdict, "unknown", mode);
    assert.equal(JSON.stringify(result).includes("private"), false); const count = f.requests.length;
    assert.equal((await f.transport.setAvatar(png(), "790")).verdict, "refused"); assert.equal(f.requests.length, count); await f.transport.close();
  }
});

test("group change while uploading suppresses apply and returns consumed unknown", async () => {
  const f = fixture(); f.override(async r => { if (r instanceof Api.upload.SaveFilePart) { f.setPhoto(66); return true; } return f.respond(r); });
  assert.deepEqual(await f.transport.setAvatar(png(), "789"), { verdict: "unknown", code: "changed" });
  assert.equal(f.requests.some(isEdit), false); await f.transport.close();
});

test("close joins in-flight upload and never dispatches edit after revocation", async () => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  f.override(async r => { if (r instanceof Api.upload.SaveFilePart) { entered(); await gate; return true; } return f.respond(r); });
  const operation = f.transport.setAvatar(png(), "789"); await started;
  let settled = false; const closing = f.transport.close().then(() => { settled = true; });
  await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  release(); assert.deepEqual(await operation, { verdict: "unknown", code: "stopped" }); await closing;
  assert.equal(settled, true); assert.equal(f.requests.some(isEdit), false);
});
