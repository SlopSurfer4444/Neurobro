import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Api } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import { createStandingSelfProfile, type StandingSelfProfileImage } from "../src/standing-self-profile.js";
import { STANDING_AVATAR_MAX_BYTES } from "../src/standing-avatar-policy.js";

const binding = { accountId: "123", peerId: "-456" };
function wire<T extends { getBytes(): Buffer }>(value: T): T { return new BinaryReader(value.getBytes()).tgReadObject() as T; }
function user(firstName = "Old", lastName = "Surname", photoId?: number, id = 123) {
  return wire(new Api.User({ id: bigInt(id), self: true, firstName, lastName, username: "neurobro",
    ...(photoId === undefined ? {} : { photo: new Api.UserProfilePhoto({ photoId: bigInt(photoId), dcId: 1 }) }) }));
}
function photo(id = 55) { return wire(new Api.photos.Photo({ photo: new Api.Photo({ id: bigInt(id), accessHash: bigInt(123), fileReference: Buffer.alloc(0), date: 1, sizes: [], dcId: 1 }), users: [] })); }
function harness(responses: unknown[]) {
  const requests: Api.AnyRequest[] = [], signal = new AbortController();
  const transport = createStandingSelfProfile({ binding, self: user(), signal: signal.signal, revalidatePrimary: async () => {},
    client: { async invoke(request) { requests.push(wire(request)); const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === "function") return response();
      if (response === undefined) throw new Error("Unexpected private value"); return response; } } });
  return { transport, requests, signal };
}
function png(): StandingSelfProfileImage {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=", "base64");
  return { bytes, mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") };
}
function sizedPng(size: number): StandingSelfProfileImage {
  const small = png().bytes as Buffer, payload = Buffer.alloc(size - small.length - 12, 65), extra = Buffer.alloc(payload.length + 12);
  extra.writeUInt32BE(payload.length); extra.write("tEXt", 4); payload.copy(extra, 8);
  const bytes = Buffer.concat([small.subarray(0, 33), extra, small.subarray(33)]);
  return { bytes, mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") };
}
const reads = (f: ReturnType<typeof harness>) => f.requests.filter(x => x instanceof Api.users.GetUsers).length;
test("fresh binary self with null photo is visible without identifiers", async () => {
  const f = harness([[user()]]); assert.equal(user().photo, null);
  assert.deepEqual(await f.transport.inspect(), { verdict: "verified", code: "verified", profile: { firstName: "Old", lastName: "Surname", hasPhoto: false } });
  const request = f.requests[0] as Api.users.GetUsers; assert.ok(request.id[0] instanceof Api.InputUserSelf);
  await f.transport.close();
});
test("display name preserves omitted surname and fresh readback verifies exact self", async () => {
  const f = harness([[user()], user("Bro"), [user("Bro")]]);
  assert.equal((await f.transport.setDisplayName({ firstName: "Bro" })).verdict, "verified");
  const update = f.requests[1] as Api.account.UpdateProfile;
  assert.ok(update instanceof Api.account.UpdateProfile); assert.equal(update.firstName, "Bro"); assert.equal(update.lastName, "Surname"); assert.equal(reads(f), 2);
  assert.equal((await f.transport.setDisplayName({ firstName: "Again" })).verdict, "refused"); assert.equal(f.requests.length, 3);
});
test("explicit empty surname clears while same name skips update", async () => {
  const f = harness([[user()], user("Bro", ""), [user("Bro", "")]]);
  assert.equal((await f.transport.setDisplayName({ firstName: "Bro", lastName: "" })).verdict, "verified");
  assert.equal((f.requests[1] as Api.account.UpdateProfile).lastName, "");
  const unchanged = harness([[user()]]); assert.equal((await unchanged.transport.setDisplayName({ firstName: "Old" })).code, "unchanged"); assert.equal(unchanged.requests.length, 1);
});
test("bad identity refuses before mutation and never leaks account IDs", async () => {
  const f = harness([[user("Other", "", undefined, 999)]]);
  assert.deepEqual(await f.transport.setDisplayName({ firstName: "Bro" }), { verdict: "refused", code: "identity" }); assert.equal(f.requests.length, 1);
});
test("mutation failure is unknown and consumed without retry", async () => {
  const f = harness([[user()], new Error("private secret")]);
  assert.deepEqual(await f.transport.setDisplayName({ firstName: "Bro" }), { verdict: "unknown", code: "transport" });
  assert.equal((await f.transport.inspect()).verdict, "refused"); assert.equal(f.requests.length, 2);
});
test("readback mismatch after acknowledged mutation remains unknown", async () => {
  const f = harness([[user()], user("Bro"), [user("Other")]]);
  assert.deepEqual(await f.transport.setDisplayName({ firstName: "Bro" }), { verdict: "unknown", code: "changed" });
});
test("avatar uses host fileId, binary upload then matching ACK and fresh photo", async () => {
  const image = png(), original = Buffer.from(image.bytes), f = harness([[user()], true, [user()], photo(), [user("Old", "Surname", 55)]]);
  const pending = f.transport.setAvatar(image, "789"); image.bytes.fill(0);
  assert.equal((await pending).verdict, "verified");
  const part = f.requests[1] as Api.upload.SaveFilePart; assert.equal(part.fileId.toString(), "789"); assert.deepEqual(part.bytes, original);
  const apply = f.requests[3] as Api.photos.UploadProfilePhoto; assert.ok(apply instanceof Api.photos.UploadProfilePhoto);
  assert.equal((apply.file as Api.InputFile).id.toString(), "789"); assert.equal((apply.file as Api.InputFile).md5Checksum, createHash("md5").update(original).digest("hex"));
  assert.equal(reads(f), 3); assert.equal(f.requests.some(x => x instanceof Api.messages.SendMedia), false);
});
test("old or different photo after avatar ACK cannot report verified", async () => {
  const f = harness([[user()], true, [user()], photo(), [user()]]);
  assert.deepEqual(await f.transport.setAvatar(png(), "789"), { verdict: "unknown", code: "changed" });
});
test("partial upload failure consumes avatar and issues no apply or retry", async () => {
  const f = harness([[user()], false]);
  assert.deepEqual(await f.transport.setAvatar(png(), "789"), { verdict: "unknown", code: "protocol" });
  assert.equal((await f.transport.setAvatar(png(), "790")).verdict, "refused"); assert.equal(f.requests.length, 2);
});
test("name/photo changes during upload stop before apply", async () => {
  const f = harness([[user()], true, [user("Concurrent")]]);
  assert.deepEqual(await f.transport.setAvatar(png(), "789"), { verdict: "unknown", code: "changed" });
  assert.equal(f.requests.some(x => x instanceof Api.photos.UploadProfilePhoto), false);
});
test("close joins actual in-flight mutation and suppresses further readback", async () => {
  let resolve!: (value: unknown) => void;
  const f = harness([[user()], () => new Promise(r => { resolve = r; })]);
  const operation = f.transport.setDisplayName({ firstName: "Bro" });
  while (!resolve) await new Promise(r => setImmediate(r));
  let settled = false; const close = f.transport.close().then(() => { settled = true; });
  await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  resolve(user("Bro")); assert.deepEqual(await operation, { verdict: "unknown", code: "stopped" }); await close; assert.equal(f.requests.length, 2);
});
test("abort during read is refused, no mutation is admitted", async () => {
  let resolve!: (value: unknown) => void;
  const f = harness([() => new Promise(r => { resolve = r; })]); const op = f.transport.setDisplayName({ firstName: "Bro" });
  while (!resolve) await new Promise(r => setImmediate(r)); f.signal.abort(); resolve([user()]);
  assert.deepEqual(await op, { verdict: "refused", code: "stopped" }); assert.equal(f.requests.length, 1); await f.transport.close();
});
test("busy concurrent calls refuse and names are snapshotted before await", async () => {
  let resolve!: (value: unknown) => void;
  const f = harness([() => new Promise(r => { resolve = r; }), user("Bro"), [user("Bro")]]), names = { firstName: "Bro" };
  const op = f.transport.setDisplayName(names); names.firstName = "Changed";
  assert.equal((await f.transport.inspect()).verdict, "refused"); while (!resolve) await new Promise(r => setImmediate(r)); resolve([user()]);
  assert.equal((await op).verdict, "verified");
});
test("invalid image/hash, oversize, names and accessors refuse without any invoke", async () => {
  const f = harness([]), image = png();
  assert.equal((await f.transport.setAvatar({ ...image, sha256: "0".repeat(64) }, "789")).code, "input");
  assert.equal((await f.transport.setAvatar({ ...image, bytes: Buffer.alloc(STANDING_AVATAR_MAX_BYTES + 1) }, "789")).code, "input");
  assert.equal((await f.transport.setAvatar(image, "0")).code, "input");
  assert.equal((await f.transport.setDisplayName({ firstName: "" })).code, "input");
  let got = false; const names = { get firstName() { got = true; return "Bro"; } };
  assert.equal((await f.transport.setDisplayName(names)).code, "input"); assert.equal(got, false); assert.equal(f.requests.length, 0);
});
test("exact 8 MiB avatar uses sixteen standard InputFile parts and completes verified readback", async () => {
  const responses: unknown[] = [[user()], true];
  for (let part = 1; part < 16; part++) responses.push([user()], true);
  responses.push([user()], photo(), [user("Old", "Surname", 55)]);
  const f = harness(responses), image = sizedPng(STANDING_AVATAR_MAX_BYTES);
  assert.equal(image.bytes.byteLength, STANDING_AVATAR_MAX_BYTES);
  assert.deepEqual(await f.transport.setAvatar(image, "789"), { verdict: "verified", code: "verified",
    profile: { firstName: "Old", lastName: "Surname", hasPhoto: true } });
  const parts = f.requests.filter(value => value instanceof Api.upload.SaveFilePart) as Api.upload.SaveFilePart[];
  assert.equal(parts.length, 16); assert.deepEqual(parts.map(value => value.filePart), Array.from({ length: 16 }, (_, index) => index));
  assert.equal((f.requests.find(value => value instanceof Api.photos.UploadProfilePhoto) as Api.photos.UploadProfilePhoto).file instanceof Api.InputFile, true);
  assert.equal(f.requests.length, 35);
});
test("header-only fake PNG is refused despite correct digest", async () => {
  const f = harness([]), bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  assert.equal((await f.transport.setAvatar({ bytes, mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") }, "789")).code, "input");
  assert.equal(f.requests.length, 0);
});
test("bounded JPEG container uploads with jpg name; malformed segments refuse", async () => {
  // Structural fixture only: intentionally not claimed to decode into pixels.
  const bytes = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,255,0,2,255,217]);
  const image: StandingSelfProfileImage = { bytes, mediaType: "image/jpeg", sha256: createHash("sha256").update(bytes).digest("hex") };
  const f = harness([[user()], true, [user()], photo(), [user("Old", "Surname", 55)]]);
  assert.equal((await f.transport.setAvatar(image, "789")).verdict, "verified");
  assert.equal(((f.requests[3] as Api.photos.UploadProfilePhoto).file as Api.InputFile).name, "avatar.jpg");
  const invalid = Buffer.from(bytes); invalid.writeUInt16BE(65535, 4);
  const bad = harness([]); assert.equal((await bad.transport.setAvatar({ ...image, bytes: invalid, sha256: createHash("sha256").update(invalid).digest("hex") }, "789")).code, "input");
  assert.equal(bad.requests.length, 0);
});
test("multipart upload revalidates and partial failure never reaches profile apply", async () => {
  const small = png().bytes as Buffer, padding = Buffer.alloc(524288), chunk = Buffer.alloc(padding.length + 12);
  chunk.writeUInt32BE(padding.length, 0); chunk.write("tEXt", 4);
  const bytes = Buffer.concat([small.subarray(0, 33), chunk, small.subarray(33)]);
  const image: StandingSelfProfileImage = { bytes, mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") };
  const f = harness([[user()], true, [user()], new Error("interrupted second upload")]);
  assert.equal((await f.transport.setAvatar(image, "789")).verdict, "unknown");
  const parts = f.requests.filter(x => x instanceof Api.upload.SaveFilePart) as Api.upload.SaveFilePart[];
  assert.deepEqual(parts.map(x => x.filePart), [0, 1]); assert.equal(parts[0]!.bytes.length, 524288);
  assert.equal(f.requests.some(x => x instanceof Api.photos.UploadProfilePhoto), false);
});
test("matching old photo ACK cannot certify avatar change", async () => {
  const f = harness([[user("Old", "Surname", 55)], true, [user("Old", "Surname", 55)], photo()]);
  assert.equal((await f.transport.setAvatar(png(), "789")).verdict, "unknown");
});
test("update cannot certify unexpected username or photo drift", async () => {
  const changedUsername = user("Bro"); changedUsername.username = "someone_else";
  const username = harness([[user()], changedUsername]);
  assert.equal((await username.transport.setDisplayName({ firstName: "Bro" })).verdict, "unknown");
  const avatar = harness([[user()], user("Bro", "Surname", 55)]);
  assert.equal((await avatar.transport.setDisplayName({ firstName: "Bro" })).verdict, "unknown");
});
test("close while uploading waits actual bytes user and prevents applying", async () => {
  let resolve!: (value: unknown) => void;
  const f = harness([[user()], () => new Promise(r => { resolve = r; })]);
  const op = f.transport.setAvatar(png(), "789"); while (!resolve) await new Promise(r => setImmediate(r));
  let joined = false; const close = f.transport.close().then(() => { joined = true; });
  await new Promise(r => setImmediate(r)); assert.equal(joined, false);
  resolve(true); assert.equal((await op).verdict, "unknown"); await close; assert.equal(f.requests.length, 2);
});
test("name mutation requires trimmed names and maximum 64 UTF16 units", async () => {
  const f = harness([]);
  for (const firstName of [" a", "a ", "a".repeat(65), "😀".repeat(33)]) {
    assert.equal((await f.transport.setDisplayName({ firstName })).code, "input");
  }
  for (const lastName of [" b", "b ", "b".repeat(65)]) {
    assert.equal((await f.transport.setDisplayName({ firstName: "Bro", lastName })).code, "input");
  }
  assert.equal(f.requests.length, 0);
});
