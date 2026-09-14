import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGeneratedImageRegistry, GENERATED_IMAGE_MAX_BYTES, type GeneratedImageOrigin } from "../src/generated-image-artifact.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const scope = () => ({ requestRef: "m_test_request", threadId: "native-thread-test", turnId: "native-turn-test" });
const origin = (): GeneratedImageOrigin => ({ ...scope(), itemId: "image-test-1" });
const item = (bytes: Buffer = PNG) => ({ id: origin().itemId, type: "imageGeneration", status: "completed", result: bytes.toString("base64") });
const accepts = (bytes: Buffer) => createGeneratedImageRegistry(scope()).acceptCompleted(origin(), item(bytes));
const refuses = (bytes: Buffer, code = "PNG") => assert.throws(() => accepts(bytes), new RegExp("GENERATED_IMAGE_" + code));

// Fixture edits recalculate CRC independently, so malformed-structure checks do
// not accidentally pass merely because a byte edit damaged the CRC.
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, "ascii");
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]); let crc = 0xffffffff;
  for (const value of body) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, data, tail]);
}
const ihdr = () => Buffer.from(PNG.subarray(16, 29));
const idat = () => Buffer.from(PNG.subarray(41, 54));
const png = (...chunks: Buffer[]) => Buffer.concat([PNG.subarray(0, 8), ...chunks]);
const standard = (header = ihdr(), middle: Buffer[] = [chunk("IDAT", idat())]) => png(chunk("IHDR", header), ...middle, chunk("IEND", Buffer.alloc(0)));

test("real tiny PNG becomes immutable correlated artifact, not a path or text answer", () => {
  const binding = scope(); const source = origin(); const registry = createGeneratedImageRegistry(binding);
  const artifact = registry.acceptCompleted(source, { ...item(), savedPath: "/var/private/auth-home/generated_images/fake.png", failure: null });
  assert.equal(artifact.byteLength, PNG.length); assert.equal(artifact.width, 1); assert.equal(artifact.height, 1);
  assert.equal(artifact.mimeType, "image/png"); assert.equal(artifact.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.match(artifact.ref, /^img_[0-9a-f]{48}$/); assert.deepEqual(artifact.origin, origin());
  assert.ok(Object.isFrozen(artifact)); assert.ok(Object.isFrozen(artifact.origin));
  binding.threadId = "changed"; (source as {itemId:string}).itemId = "changed";
  assert.equal(artifact.origin.threadId, scope().threadId); assert.equal(artifact.origin.itemId, origin().itemId);
  assert.equal(JSON.stringify(artifact).includes("auth-home"), false); assert.equal(JSON.stringify(artifact).includes(item().result), false);
  assert.deepEqual(registry.copyBytes(artifact.ref), PNG);
  const exported = registry.copyBytes(artifact.ref); exported.fill(0);
  assert.deepEqual(registry.copyBytes(artifact.ref), PNG);
});

test("repeated completed snapshots are idempotent despite optional path/prompt metadata changes", () => {
  const registry = createGeneratedImageRegistry(scope()); const first = registry.acceptCompleted(origin(), item());
  const second = registry.acceptCompleted(origin(), { ...item(), savedPath: "C:/irrelevant.png", revisedPrompt: "private prompt", transparentBackground: false });
  assert.equal(second, first); assert.equal(registry.get(first.ref), first);
  const other = createGeneratedImageRegistry(scope()).acceptCompleted(origin(), item());
  assert.notEqual(first.ref, other.ref);
});

test("conflicting bytes at one origin revoke the registry, including previously issued references", () => {
  const registry = createGeneratedImageRegistry(scope()); const first = registry.acceptCompleted(origin(), item());
  const different = standard(ihdr(), [chunk("tEXt", Buffer.from("label\0different")), chunk("IDAT", idat())]);
  assert.throws(() => registry.acceptCompleted(origin(), item(different)), /GENERATED_IMAGE_CONFLICT/);
  assert.throws(() => registry.copyBytes(first.ref), /GENERATED_IMAGE_CLOSED/);
  assert.throws(() => registry.get(first.ref), /GENERATED_IMAGE_CLOSED/);
  assert.throws(() => registry.acceptCompleted(origin(), item()), /GENERATED_IMAGE_CLOSED/);
});

test("malformed later body for the accepted origin revokes access", () => {
  const registry = createGeneratedImageRegistry(scope()); const artifact = registry.acceptCompleted(origin(), item());
  assert.throws(() => registry.acceptCompleted(origin(), { ...item(), result: "not base64" }), /GENERATED_IMAGE_BASE64/);
  assert.throws(() => registry.copyBytes(artifact.ref), /GENERATED_IMAGE_CLOSED/);
});

test("noncompleted and malformed event envelopes do not replace or revoke an accepted artifact", () => {
  const registry = createGeneratedImageRegistry(scope()); const artifact = registry.acceptCompleted(origin(), item());
  assert.throws(() => registry.acceptCompleted(origin(), { ...item(), status: "failed" }), /GENERATED_IMAGE_NOT-COMPLETED/);
  assert.throws(() => registry.acceptCompleted(origin(), { ...item(), unknownKey: true }), /GENERATED_IMAGE_SHAPE/);
  assert.equal(registry.get(artifact.ref), artifact); assert.deepEqual(registry.copyBytes(artifact.ref), PNG);
});

test("wrong request, native thread, turn, item id and type cannot attach bytes to selected request", () => {
  const registry = createGeneratedImageRegistry(scope());
  for (const field of ["requestRef", "threadId", "turnId", "itemId"]) {
    assert.throws(() => registry.acceptCompleted({ ...origin(), [field]: "foreign" }, item()), /GENERATED_IMAGE_BINDING/);
  }
  assert.throws(() => registry.acceptCompleted(origin(), { ...item(), type: "agentMessage" }), /GENERATED_IMAGE_BINDING/);
  assert.ok(registry.acceptCompleted(origin(), item()));
});

test("one image per selected request; unknown opaque references and changed origins refuse", () => {
  const registry = createGeneratedImageRegistry(scope()); const first = registry.acceptCompleted(origin(), item());
  assert.throws(() => registry.acceptCompleted({ ...origin(), itemId: "image-test-2" }, { ...item(), id: "image-test-2" }), /GENERATED_IMAGE_CAPACITY/);
  assert.throws(() => registry.get("img_unknown"), /GENERATED_IMAGE_REFERENCE/);
  assert.throws(() => registry.copyBytes("/var/lib/auth.json"), /GENERATED_IMAGE_REFERENCE/);
  assert.equal(registry.get(first.ref), first);
  registry.close(); registry.close(); assert.throws(() => registry.acceptCompleted(origin(), item()), /GENERATED_IMAGE_CLOSED/);
});

test("rejects malformed shapes, getters, extra keys and noncompleted/failure items", () => {
  const registry = createGeneratedImageRegistry(scope()); let reads = 0;
  for (const malformed of [null, [], PNG, "fake", { ...item(), unexpected: true }, { ...item(), savedPath: 12 }, { ...item(), transparentBackground: "yes" }]) {
    assert.throws(() => registry.acceptCompleted(origin(), malformed), /GENERATED_IMAGE_SHAPE/);
  }
  const accessor = { ...item(), get savedPath() { reads++; return "C:/auth.json"; } };
  assert.throws(() => registry.acceptCompleted(origin(), accessor), /GENERATED_IMAGE_SHAPE/); assert.equal(reads, 0);
  for (const rejected of [{ ...item(), status: "failed" }, { ...item(), status: "inProgress" }, { ...item(), failure: { type: "usageLimitExceeded" } }]) {
    assert.throws(() => registry.acceptCompleted(origin(), rejected), /GENERATED_IMAGE_NOT-COMPLETED/);
  }
  assert.throws(() => createGeneratedImageRegistry({ ...scope(), requestRef: "" }), /GENERATED_IMAGE_BINDING/);
  assert.throws(() => createGeneratedImageRegistry({ ...scope(), threadId: "a\0b" }), /GENERATED_IMAGE_BINDING/);
});

test("strict canonical base64 rejects data URLs, paths, whitespace, invalid alphabet and alternate pad bits", () => {
  const registry = createGeneratedImageRegistry(scope());
  const canonical = item().result;
  const alternatives: unknown[] = [undefined, null, 0, "", "file:///tmp/a.png", "C:/tmp/a.png", "https://example.test/image.png", "data:image/png;base64," + canonical,
    canonical + "\n", " " + canonical, canonical.replace(/=+$/, ""), canonical.slice(0, -3) + "h==", canonical.slice(0, -4) + "####", "AAAA===="];
  for (const result of alternatives) assert.throws(() => registry.acceptCompleted(origin(), { ...item(), result }), /GENERATED_IMAGE_BASE64/);
});

test("exact decoded 8 MiB is admitted; larger decoded and encoded data fail before PNG processing", () => {
  const paddingBytes = GENERATED_IMAGE_MAX_BYTES - PNG.length - 12;
  const large = standard(ihdr(), [chunk("tEXt", Buffer.alloc(paddingBytes, 65)), chunk("IDAT", idat())]);
  assert.equal(large.length, GENERATED_IMAGE_MAX_BYTES); assert.equal(accepts(large).byteLength, GENERATED_IMAGE_MAX_BYTES);
  const over = Buffer.concat([large, Buffer.from([0])]); refuses(over, "SIZE");
  assert.throws(() => createGeneratedImageRegistry(scope()).acceptCompleted(origin(), { ...item(), result: "A".repeat(4 * Math.ceil(GENERATED_IMAGE_MAX_BYTES / 3) + 4) }), /GENERATED_IMAGE_SIZE/);
});

test("CRC, signature, truncated chunks, impossible declared sizes, trailing garbage and absent IEND refuse", () => {
  const corrupt = Buffer.from(PNG); corrupt[45] = corrupt[45]! ^ 1; refuses(corrupt);
  const signature = Buffer.from(PNG); signature[0] = 0; refuses(signature);
  refuses(PNG.subarray(0, PNG.length - 1)); refuses(PNG.subarray(0, PNG.length - 12));
  const length = Buffer.from(PNG); length.writeUInt32BE(0xffffffff, 33); refuses(length);
  refuses(Buffer.concat([PNG, Buffer.from([0])]));
  refuses(png(chunk("IHDR", ihdr()), chunk("IEND", Buffer.alloc(0))));
  refuses(standard(ihdr(), [chunk("IDAT", Buffer.alloc(0))]));
});

test("IHDR bounds and format validation are independent of chunk CRC", () => {
  for (const [width, height] of [[0, 1], [1, 0], [8193, 1], [1, 8193], [8192, 8192]]) {
    const header = ihdr(); header.writeUInt32BE(width!, 0); header.writeUInt32BE(height!, 4); refuses(standard(header));
  }
  for (const [index, value] of [[8, 3], [9, 1], [10, 1], [11, 1], [12, 2]]) {
    const header = ihdr(); header[index!] = value!; refuses(standard(header));
  }
  const header = ihdr(); header.writeUInt32BE(8192, 0); header.writeUInt32BE(2048, 4);
  // Container-only validation: these dimensions are accepted without inflating pixels.
  assert.equal(accepts(standard(header)).width, 8192);
  refuses(png(chunk("IHDR", ihdr().subarray(0, 12)), chunk("IDAT", idat()), chunk("IEND", Buffer.alloc(0))));
});

test("chunk ordering, reserved names, animation and unknown critical chunks refuse", () => {
  refuses(png(chunk("IDAT", idat()), chunk("IHDR", ihdr()), chunk("IEND", Buffer.alloc(0))));
  refuses(standard(ihdr(), [chunk("IHDR", ihdr()), chunk("IDAT", idat())]));
  refuses(standard(ihdr(), [chunk("IDAT", idat()), chunk("tEXt", Buffer.from("x")), chunk("IDAT", idat())]));
  for (const type of ["ABCD", "abca", "acTL", "fcTL", "fdAT", "a1CD"]) refuses(standard(ihdr(), [chunk(type, Buffer.alloc(1)), chunk("IDAT", idat())]));
  refuses(png(chunk("IHDR", ihdr()), chunk("IDAT", idat()), chunk("IEND", Buffer.from([0]))));
});

test("indexed PNG requires bounded palette before IDAT; palette is forbidden in grayscale", () => {
  const indexed = ihdr(); indexed[8] = 1; indexed[9] = 3;
  refuses(standard(indexed));
  const plte = chunk("PLTE", Buffer.from([0, 0, 0, 255, 255, 255]));
  assert.equal(accepts(standard(indexed, [plte, chunk("IDAT", idat())])).width, 1);
  refuses(standard(indexed, [chunk("PLTE", Buffer.alloc(9)), chunk("IDAT", idat())]));
  refuses(standard(indexed, [plte, plte, chunk("IDAT", idat())]));
  refuses(standard(ihdr(), [chunk("IDAT", idat()), plte]));
  const gray = ihdr(); gray[9] = 0; refuses(standard(gray, [plte, chunk("IDAT", idat())]));
});

test("chunk count is bounded even below the byte ceiling", () => {
  refuses(standard(ihdr(), [...Array.from({ length: 4094 }, () => chunk("tEXt", Buffer.alloc(0))), chunk("IDAT", idat())]));
});
