import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "telegram";
import bigInt from "big-integer";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import { inputImageIdentity, downloadStandingInputImage } from "../src/standing-input-image.js";

// Minimal framing fixture; validation intentionally makes no pixel-decoding claim.
const jpeg = (padding = 0) => Buffer.concat([Buffer.from([255,216,255,192,0,11,8,0,10,0,20,1,1,17,0,255,218,0,8,1,1,0,0,63,0]), Buffer.alloc(padding, 1), Buffer.from([1,255,217])]);
const photo = (bytes = jpeg()) => new Api.Message({ id: 42, date: 1, message: "look", peerId: new Api.PeerChat({ chatId: bigInt(9) }),
  media: new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: bigInt(10), accessHash: bigInt(11), fileReference: Buffer.from([12]), date: 1, dcId: 2,
    sizes: [new Api.PhotoSize({ type: "x", w: 20, h: 10, size: bytes.length })] }) }) });
const getPhoto = (m: Api.Message) => (m.media as Api.MessageMediaPhoto).photo as Api.Photo;
const file = (bytes: Buffer) => new Api.upload.File({ type: new Api.storage.FileJpeg(), mtime: 1, bytes });
const wire = <T extends { getBytes(): Buffer }>(v: T): T => new BinaryReader(v.getBytes()).tgReadObject() as T;

test("fresh photo location and bounded exact chunks survive installed wire constructors", async () => {
  const bytes = jpeg(600000), message = wire(photo(bytes)), requests: Api.upload.GetFile[] = [];
  const result = await downloadStandingInputImage(message, async (r,dcId) => {
    assert.equal(dcId,2);
    assert.ok(r instanceof Api.upload.GetFile); const request = wire(r); requests.push(request);
    assert.ok(request.location instanceof Api.InputPhotoFileLocation);
    assert.equal(request.location.id.toString(), "10"); assert.equal(request.location.thumbSize, "x");
    assert.deepEqual(request.location.fileReference, Buffer.from([12]));
    return wire(file(bytes.subarray(Number(request.offset.toString()), Number(request.offset.toString()) + request.limit)));
  }, () => {});
  assert.deepEqual(result.bytes, bytes); assert.equal(result.messageId, 42); assert.equal(result.mimeType, "image/jpeg");
  assert.deepEqual(requests.map(r => Number(r.offset.toString())), [0, 524288]);
  assert.ok(requests.every(r => r.limit === 524288 && !r.cdnSupported));
});

test("largest safe full progressive representation selected; thumbnail and unsafe sizes excluded", async () => {
  const m = photo(), p = getPhoto(m);
  p.sizes.push(new Api.PhotoSize({ type: "s", w: 3000, h: 3000, size: 100 }),
    new Api.PhotoSize({ type: "w", w: 5000, h: 5000, size: 100 }),
    new Api.PhotoSizeProgressive({ type: "y", w: 40, h: 20, sizes: [10, 28] }));
  assert.equal(JSON.parse(inputImageIdentity(m)!)[4], "y");
  p.fileReference = Buffer.from([99]); const identity = inputImageIdentity(m);
  p.fileReference = Buffer.from([98]); assert.equal(inputImageIdentity(m), identity);
  p.id = bigInt(88); assert.notEqual(inputImageIdentity(m), identity);
});

test("TTL, missing full sizes, empty references and oversized declarations refuse before RPC", async () => {
  for (const mutate of [(m: Api.Message) => { (m.media as Api.MessageMediaPhoto).ttlSeconds = 1; },
    (m: Api.Message) => { getPhoto(m).sizes = []; }, (m: Api.Message) => { getPhoto(m).fileReference = Buffer.alloc(0); },
    (m: Api.Message) => { (getPhoto(m).sizes[0] as Api.PhotoSize).size = 8388609; }]) {
    const m = photo(); mutate(m); assert.equal(inputImageIdentity(m), undefined);
    await assert.rejects(downloadStandingInputImage(m, async () => { assert.fail("unexpected RPC"); }, () => {}));
  }
});

test("truncated, extra, redirected, wrong format and dimension-mismatched bytes refuse", async () => {
  for (const response of [file(jpeg().subarray(1)), file(Buffer.concat([jpeg(), Buffer.from([0])])),
    new Api.upload.FileCdnRedirect({ dcId: 3, fileToken: Buffer.alloc(1), encryptionKey: Buffer.alloc(32), encryptionIv: Buffer.alloc(16), fileHashes: [] }),
    file(Buffer.alloc(jpeg().length)), file(Buffer.from(jpeg()))]) {
    if (response instanceof Api.upload.File && response.bytes.equals(jpeg())) response.bytes[10] = 21;
    await assert.rejects(downloadStandingInputImage(photo(), async () => response, () => {}));
  }
});

test("migration propagates without retry and revocation after pending RPC prevents next chunk", async () => {
  let calls = 0;
  await assert.rejects(downloadStandingInputImage(photo(), async () => { calls++; throw Error("FILE_MIGRATE_3"); }, () => {}), /FILE_MIGRATE_3/);
  assert.equal(calls, 1);
  const bytes = jpeg(600000); let revoked = false;
  await assert.rejects(downloadStandingInputImage(photo(bytes), async () => { revoked = true; return file(bytes.subarray(0, 524288)); }, () => { if (revoked) throw Error("stopped"); }), /stopped/);
});

test("PNG photo validates actual dimensions and container instead of declared RPC file type", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=", "base64");
  const m = photo(bytes), size = getPhoto(m).sizes[0] as Api.PhotoSize;
  size.w = 1; size.h = 1;
  const result = await downloadStandingInputImage(m, async () => file(bytes), () => {});
  assert.equal(result.mimeType, "image/png"); assert.deepEqual(result.bytes, bytes);
  size.w = 2;
  await assert.rejects(downloadStandingInputImage(m, async () => file(bytes), () => {}));
  size.w = 1;
  const broken = Buffer.from(bytes); broken.writeUInt32BE(9999, 8);
  await assert.rejects(downloadStandingInputImage(m, async () => file(broken), () => {}));
});

const imageDocument = (bytes = jpeg()) => {
  const message = photo(bytes);
  message.media = new Api.MessageMediaDocument({ document: new Api.Document({ id: bigInt(10), accessHash: bigInt(11),
    fileReference: Buffer.from([12]), date: 1, dcId: 2, mimeType: "image/jpeg", size: bigInt(bytes.length),
    attributes: [new Api.DocumentAttributeImageSize({ w: 20, h: 10 }), new Api.DocumentAttributeFilename({ fileName: "image.jpg" })] }) });
  return message;
};
const getDocument = (m: Api.Message) => (m.media as Api.MessageMediaDocument).document as Api.Document;

test("image document uses full-file installed constructor and stable kind-separated identity", async () => {
  const message = wire(imageDocument()), identity = inputImageIdentity(message);
  assert.ok(identity); assert.notEqual(identity, inputImageIdentity(photo()));
  const result = await downloadStandingInputImage(message, async (request, dcId) => {
    const r = wire(request); assert.equal(dcId, 2); assert.ok(r.location instanceof Api.InputDocumentFileLocation);
    assert.equal(r.location.thumbSize, ""); assert.equal(r.location.id.toString(), "10");
    assert.deepEqual(r.location.fileReference, Buffer.from([12])); return wire(file(jpeg()));
  }, () => {});
  assert.equal(result.mimeType, "image/jpeg"); assert.deepEqual(result.bytes, jpeg());
  getDocument(message).fileReference = Buffer.from([99]); assert.equal(inputImageIdentity(message), identity);
});

test("document MIME, active-media attributes, absent dimensions and excessive size refuse without download", async () => {
  for (const mutate of [(d: Api.Document) => { d.mimeType = "image/gif"; },
    (d: Api.Document) => { d.attributes.push(new Api.DocumentAttributeAnimated()); },
    (d: Api.Document) => { d.attributes.push(new Api.DocumentAttributeVideo({ duration: 1, w: 20, h: 10 })); },
    (d: Api.Document) => { d.attributes.push(new Api.DocumentAttributeSticker({ alt: "x", stickerset: new Api.InputStickerSetEmpty() })); },
    (d: Api.Document) => { d.attributes = []; },
    (d: Api.Document) => { d.size = bigInt(8388609); }]) {
    const m = imageDocument(); mutate(getDocument(m)); assert.equal(inputImageIdentity(m), undefined);
    await assert.rejects(downloadStandingInputImage(m, async () => { assert.fail("unexpected download"); }, () => {}));
  }
  const m = imageDocument(); getDocument(m).mimeType = "image/png";
  await assert.rejects(downloadStandingInputImage(m, async () => file(jpeg()), () => {}));
});

test("remaining aggregate byte budget rejects before download", async () => {
  for (const message of [photo(), imageDocument()]) {
    await assert.rejects(downloadStandingInputImage(message, async () => { assert.fail("budget must be checked before RPC"); }, () => {}, jpeg().length - 1));
    assert.equal((await downloadStandingInputImage(message, async () => file(jpeg()), () => {}, jpeg().length)).bytes.length, jpeg().length);
  }
});

test("PNG document positive path consumes full static file", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=", "base64");
  const m = imageDocument(bytes), document = getDocument(m);
  document.mimeType = "image/png"; document.attributes = [new Api.DocumentAttributeImageSize({ w: 1, h: 1 })];
  const result = await downloadStandingInputImage(wire(m), async () => wire(new Api.upload.File({ type: new Api.storage.FilePng(), mtime: 1, bytes })), () => {});
  assert.equal(result.mimeType, "image/png"); assert.deepEqual(result.bytes, bytes);
});
