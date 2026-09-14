import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createGeneratedImageReceiver, GENERATED_IMAGE_CHUNK_BYTES } from "../src/generated-image-receiver.js";
import { runGeneratedImageDelivery } from "../src/generated-image-outbox.js";

const scope = { requestRef: "selected-request", threadId: "thread-native", turnId: "turn-native" };
const origin = { ...scope, itemId: "image-native" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const remoteRef = "img_" + "ab".repeat(24);
function frames(bytes: Buffer = png): any[] {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const chunks = [];
  for (let at = 0; at < bytes.length; at += GENERATED_IMAGE_CHUNK_BYTES) {
    chunks.push({ kind: "imageChunk", artifactRef: remoteRef, sequence: chunks.length, dataBase64: bytes.subarray(at, at + GENERATED_IMAGE_CHUNK_BYTES).toString("base64") });
  }
  return [{ kind: "imageBegin", artifact: { schema: "neurobro-generated-image-artifact-v1", ref: remoteRef, origin: { ...origin }, mimeType: "image/png", byteLength: bytes.length, sha256, width: 1, height: 1 } },
    ...chunks, { kind: "imageEnd", artifactRef: remoteRef, chunkCount: chunks.length, byteLength: bytes.length, sha256 }];
}
function complete(rows = frames()) {
  const receiver = createGeneratedImageReceiver(scope);
  for (const frame of rows) receiver.accept(frame);
  return receiver;
}
function reject(rows: any[], pattern: RegExp) {
  const receiver = createGeneratedImageReceiver(scope);
  assert.throws(() => { for (const frame of rows) receiver.accept(frame); }, pattern);
  assert.throws(() => receiver.artifact(), /CLOSED/);
  assert.throws(() => receiver.accept(frames()[0]), /CLOSED/);
}
function chunk(type: string, data: Buffer): Buffer {
  const raw = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of raw) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length); raw.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function paddedPng(length: number): Buffer {
  return Buffer.concat([png.subarray(0, 33), chunk("tEXt", Buffer.alloc(length - png.length - 12)), png.subarray(33)]);
}

test("full private stream yields local validated artifact, never transport ref alias", () => {
  const receiver = complete(); const artifact = receiver.artifact();
  assert.notEqual(artifact.ref, remoteRef); assert.deepEqual(artifact.origin, origin);
  assert.deepEqual(receiver.copyBytes(artifact.ref), png);
  assert.equal(receiver.get(artifact.ref), artifact);
  assert.throws(() => receiver.copyBytes(remoteRef), /REFERENCE/);
  const copy = receiver.copyBytes(artifact.ref); copy.fill(0);
  assert.deepEqual(receiver.copyBytes(artifact.ref), png);
  receiver.close(); assert.throws(() => receiver.copyBytes(artifact.ref), /CLOSED/);
});
test("no artifact can escape before complete end; close handles missing end/abort", () => {
  const receiver = createGeneratedImageReceiver(scope); const rows = frames();
  assert.throws(() => receiver.artifact(), /NOT-READY/);
  assert.equal(receiver.accept(rows[0]), undefined); assert.equal(receiver.accept(rows[1]), undefined);
  assert.throws(() => receiver.artifact(), /NOT-READY/); receiver.close(); receiver.close();
  assert.throws(() => receiver.accept(rows[2]), /CLOSED/);
});
test("scope and artifact metadata copied before caller mutation", () => {
  const selected = { ...scope }; const receiver = createGeneratedImageReceiver(selected); selected.turnId = "other";
  const rows = frames(); receiver.accept(rows[0]); rows[0].artifact.origin.itemId = "changed"; rows[0].artifact.width = 42;
  receiver.accept(rows[1]); const result = receiver.accept(rows[2]); assert.deepEqual(result?.origin, origin); receiver.close();
});
test("wrong trusted native identity or item shape refused", () => {
  for (const key of ["requestRef", "threadId", "turnId"]) {
    const rows = frames(); rows[0].artifact.origin[key] = "foreign"; reject(rows, /BINDING/);
  }
  const rows = frames(); rows[0].artifact.origin.itemId = ""; reject(rows, /BINDING/);
  assert.throws(() => createGeneratedImageReceiver({ ...scope, requestRef: "\ud800" }), /BINDING/);
});
test("begin shape and inert paths are never admitted", () => {
  for (const change of [
    (a: any) => { a.savedPath = "C:/private/auth.json"; },
    (a: any) => { a.mimeType = "image/jpeg"; },
    (a: any) => { a.ref = "file:///private.png"; },
    (a: any) => { a.schema = "other"; },
    (a: any) => { delete a.width; },
  ]) { const rows = frames(); change(rows[0].artifact); reject(rows, /SHAPE/); }
});
test("accessors symbols and unexpected prototypes cannot execute via serialization", () => {
  let calls = 0;
  const first = frames()[0]; Object.defineProperty(first.artifact, "width", { get() { calls++; return 1; } });
  reject([first], /SHAPE/); assert.equal(calls, 0);
  const next = frames()[0]; next[Symbol("extra")] = "x"; reject([next], /SHAPE/);
  const third = frames()[0]; Object.setPrototypeOf(third.artifact, { toJSON() { calls++; } }); reject([third], /SHAPE/); assert.equal(calls, 0);
});
test("wrong chunk/end ref rejected", () => {
  for (const at of [1, 2]) { const rows = frames(); rows[at].artifactRef = "img_" + "cd".repeat(24); reject(rows, /BINDING/); }
});
test("reorder, duplicate, missing chunk and second image revoke", () => {
  const rows = frames(); reject([rows[1]], /ORDER/); reject([rows[0], rows[2]], /INTEGRITY/);
  reject([rows[0], rows[1], rows[1]], /ORDER/); reject([rows[0], rows[0]], /ORDER/);
  reject([...rows, rows[0]], /ORDER/); reject([...rows, rows[2]], /ORDER/);
  const altered = frames(); altered[1].sequence = 1; reject(altered, /ORDER/);
});
test("strict canonical base64 rejects whitespace URL and noncanonical padding", () => {
  for (const value of ["AAAA\n===", "file:///private.png", "AB==", "", "data:image/png;base64,AAAA"]) {
    const rows = frames(); rows[1].dataBase64 = value; reject(rows, /BASE64/);
  }
});
test("begin size and dimensions, chunk encoded size and short pieces bounded", () => {
  for (const [key, value] of [["byteLength", 8 * 1024 * 1024 + 1], ["width", 8193], ["height", 0], ["byteLength", 4.5], ["width", 8192]] as const) {
    const rows = frames(); rows[0].artifact[key] = value;
    if (key === "width" && value === 8192) rows[0].artifact.height = 8192;
    reject(rows, /BOUNDS/);
  }
  const rows = frames(); rows[1].dataBase64 = Buffer.alloc(GENERATED_IMAGE_CHUNK_BYTES + 1).toString("base64"); reject(rows, /BOUNDS/);
  const short = frames(); short[1].dataBase64 = png.subarray(0, 10).toString("base64"); reject(short, /BOUNDS/);
});
test("terminal count, size and digest must match exactly", () => {
  for (const [key, value] of [["chunkCount", 2], ["byteLength", png.length + 1], ["sha256", "0".repeat(64)]] as const) {
    const rows = frames(); rows[2][key] = value; reject(rows, /INTEGRITY/);
  }
  const rows = frames(); rows[0].artifact.sha256 = rows[2].sha256 = "0".repeat(64); reject(rows, /INTEGRITY/);
});
test("digest-valid corrupt PNG still fails local registry; false dimensions revoke", () => {
  const corrupt = Buffer.from(png); corrupt[corrupt.length - 1] = 0; reject(frames(corrupt), /PNG/);
  const rows = frames(); rows[0].artifact.width = 2; reject(rows, /INTEGRITY/);
});
test("late malformed frame revokes already returned artifact access", () => {
  const receiver = complete(); const artifact = receiver.artifact();
  assert.throws(() => receiver.accept({ kind: "other" }), /ORDER/);
  assert.throws(() => receiver.get(artifact.ref), /CLOSED/);
});
test("exact maximum image uses 22 bounded chunks and validates after assembly", () => {
  const bytes = paddedPng(8 * 1024 * 1024); const rows = frames(bytes);
  assert.equal(rows.length, 24); const receiver = complete(rows); const artifact = receiver.artifact();
  assert.equal(artifact.byteLength, bytes.length); assert.deepEqual(receiver.copyBytes(artifact.ref), bytes); receiver.close();
});
test("actual Python collector chunks flow through receiver and media outbox", async () => {
  // Fixed public source-only helper: no WSL, credentials, model, Telegram or files written.
  const python = globalThis.process.env.NEUROBRO_TEST_PYTHON ?? "python";
  const collector = resolve("../../project/verification/rm-0032-native-image-collector.py");
  const code = `import base64, importlib.util, json, sys
spec=importlib.util.spec_from_file_location('collector',sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
scope={'requestRef':'selected-request','threadId':'thread-native','turnId':'turn-native'}
c=m.NativeImageCollector(scope)
for state, timestamp, status in [('started','startedAtMs','in_progress'),('completed','completedAtMs','completed')]:
 item={'id':'image-native','type':'imageGeneration','status':status,'result':sys.stdin.read() if state=='completed' else ''}
 c.observe_notification({'method':'item/'+state,'params':{'threadId':scope['threadId'],'turnId':scope['turnId'],'item':item,timestamp:100 if state=='started' else 200}})
c.finish_turn(thread_id=scope['threadId'],turn_id=scope['turnId'],status='completed')
for frame in c.artifact_frames(): print(json.dumps(frame,separators=(',',':')))
c.close()
`;
  const bytes = paddedPng(GENERATED_IMAGE_CHUNK_BYTES + 70);
  const process = spawnSync(python, ["-I", "-S", "-B", "-c", code, collector], { input: bytes.toString("base64"), encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  assert.equal(process.error, undefined); assert.equal(process.status, 0, process.stderr); assert.equal(process.stderr, "");
  const rows = process.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 4); const receiver = complete(rows); const artifact = receiver.artifact();
  assert.notEqual(artifact.ref, rows[0].artifact.ref); assert.deepEqual(receiver.copyBytes(artifact.ref), bytes);
  const approved = { chatId: "-100456", accountId: "123", replyToMessageId: 10, origin: artifact.origin };
  const order: string[] = [];
  const delivery = await runGeneratedImageDelivery({ approved, registry: receiver, artifactRef: artifact.ref, caption: "robot",
    store: { async reserve(plan, persisted) { assert.equal(plan.artifact.sha256, artifact.sha256); assert.deepEqual(persisted, bytes); order.push("reserve"); },
      async append(record) { order.push(record.state); } },
    transport: { async sendOnce(value) { assert.deepEqual(value.bytes, bytes); order.push("send"); return { messageId: 11, photoId: "777" }; },
      async readExact() { order.push("read"); return { messageId: 11, photoId: "777", chatId: approved.chatId, accountId: approved.accountId, replyToMessageId: 10, caption: "robot" }; } },
    signal: new AbortController().signal, killSwitchEngaged: () => false });
  await delivery.settlement;
  assert.equal(delivery.delivery, "verified"); assert.deepEqual(order, ["reserve", "sending", "send", "read", "verified"]);
  receiver.close();
});
