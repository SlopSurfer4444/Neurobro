import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { decryptSession, encryptSession } from "../src/session-crypto.js";
import { runGeneratedImageDelivery, openEncryptedGeneratedImageOutbox, readVerifiedGeneratedImage, generatedImageDeliveryKey, generatedImagePlanHash, GeneratedImageOutboxError,
  GeneratedImageTransportError, type ImageDeliveryDiagnostics, type ImageDeliveryApproval, type ImageDeliveryPlan, type ImageDeliveryRecord, type ImageMediaReadback, type ImageMediaAcknowledgement } from "../src/generated-image-outbox.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const approved = (): ImageDeliveryApproval => ({ chatId: "-100123456", accountId: "11111111", replyToMessageId: 987, origin: { requestRef: "request-test", threadId: "thread-test", turnId: "turn-test", itemId: "image-test" } });
const caption = "Synthetic image caption";
function setup() {
  const binding = approved(), origin = binding.origin;
  const registry = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  const artifact = registry.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: PNG.toString("base64") });
  const controller = new AbortController(); const events: string[] = [], records: ImageDeliveryRecord[] = [];
  let plan: ImageDeliveryPlan | undefined, sends = 0, reserved = false, held: Buffer | undefined;
  const readback: ImageMediaReadback = { messageId: 1234, photoId: "9223372036854775806", chatId: binding.chatId, accountId: binding.accountId, replyToMessageId: binding.replyToMessageId, caption };
  const input: Parameters<typeof runGeneratedImageDelivery>[0] = {
    approved: binding, registry, artifactRef: artifact.ref, caption, signal: controller.signal, killSwitchEngaged: () => false,
    store: {
      async reserve(value, bytes) { if (reserved) throw new GeneratedImageOutboxError("consumed"); reserved = true; plan = value; events.push("planned"); assert.deepEqual(bytes, PNG); },
      async append(record) { records.push(record); events.push(record.state); },
    },
    transport: {
      async sendOnce(value) { sends++; held = value.bytes; events.push("send"); assert.equal(events.at(-2), "sending"); assert.ok(plan); assert.deepEqual(value.bytes, PNG); assert.equal(value.randomId, plan.randomId); return { messageId: readback.messageId, photoId: readback.photoId }; },
      async readExact(chat, id) { events.push("read"); assert.equal(chat, binding.chatId); assert.equal(id, readback.messageId); return readback; },
    },
  };
  return { input, registry, artifact, controller, events, records, readback, plan: () => plan!, sends: () => sends, held: () => held };
}
const plain = (result: Awaited<ReturnType<typeof runGeneratedImageDelivery>>) => ({ generation: result.generation, delivery: result.delivery, code: result.code, transportSettled: result.transportSettled });
function attachStore(f: ReturnType<typeof setup>, store: Parameters<typeof runGeneratedImageDelivery>[0]["store"]) {
  const old = f.input.store;
  f.input.store = {
    async reserve(plan, bytes) { await store.reserve(plan, bytes); await old.reserve(plan, bytes); },
    async append(record) { await store.append(record); await old.append(record); },
  };
}

test("persists completed generation and send claim before upload/send, verifies exact photo identity", async () => {
  const f = setup(); const result = await runGeneratedImageDelivery(f.input); await result.settlement;
  assert.deepEqual(plain(result), { generation: "completed", delivery: "verified", code: "verified", transportSettled: true });
  assert.deepEqual(f.events, ["planned", "sending", "send", "read", "verified"]); assert.equal(f.sends(), 1);
  assert.equal(f.plan().generation, "completed"); assert.equal(f.plan().artifact.sha256, f.artifact.sha256); assert.deepEqual(f.plan().approved, approved());
  assert.match(f.plan().key, /^[0-9a-f]{64}$/); assert.ok(BigInt(f.plan().randomId) > 0n && BigInt(f.plan().randomId) < 2n ** 63n);
  assert.ok(f.held()!.every(value => value === 0)); assert.deepEqual(f.registry.copyBytes(f.artifact.ref), PNG);
  assert.equal(f.records.at(-1)!.photoId, f.readback.photoId);
  assert.equal((await runGeneratedImageDelivery(f.input)).code, "consumed"); assert.equal(f.sends(), 1);
});

test("delivery key ignores content/ref/native epoch so a regenerated artifact cannot evade an old request slot", () => {
  const first = approved(), second = { ...approved(), origin: { requestRef: "new", threadId: "new", turnId: "new", itemId: "new" } };
  assert.equal(generatedImageDeliveryKey(first), generatedImageDeliveryKey(second));
  assert.notEqual(generatedImageDeliveryKey(first), generatedImageDeliveryKey({ ...first, replyToMessageId: 988 }));
  assert.notEqual(generatedImageDeliveryKey(first), generatedImageDeliveryKey({ ...first, chatId: "-42" }));
});

test("approval, origin, artifact digest and caption failures prevent reservation", async () => {
  for (const change of [{ chatId: "123" }, { accountId: "0" }, { replyToMessageId: 0 }, { origin: { ...approved().origin, turnId: "foreign" } }]) {
    const f = setup(); f.input.approved = { ...f.input.approved, ...change };
    assert.equal((await runGeneratedImageDelivery(f.input)).code, "input-refused"); assert.deepEqual(f.events, []);
  }
  for (const text of ["a".repeat(1025), "\ud800", "x\0y"]) {
    const f = setup(); f.input.caption = text; assert.equal((await runGeneratedImageDelivery(f.input)).code, "input-refused"); assert.deepEqual(f.events, []);
  }
  const f = setup(); const real = f.registry; f.input.registry = { ...real, get: ref => ({ ...real.get(ref), sha256: "0".repeat(64) }) };
  const result = await runGeneratedImageDelivery(f.input); assert.equal(result.code, "input-refused"); assert.equal(result.generation, "unknown"); assert.deepEqual(f.events, []);
});

test("equivalent origin property order does not create a false correlation failure", async () => {
  const f = setup(), o = approved().origin;
  f.input.approved = { ...approved(), origin: { itemId: o.itemId, turnId: o.turnId, threadId: o.threadId, requestRef: o.requestRef } };
  assert.equal((await runGeneratedImageDelivery(f.input)).delivery, "verified");
});

test("stop before reservation and after each durable pre-send stage never dispatches", async () => {
  for (const phase of ["before", "planned", "sending"]) {
    const f = setup(); f.input.killSwitchEngaged = () => phase === "before" || f.events.includes(phase);
    const result = await runGeneratedImageDelivery(f.input); assert.equal(result.code, "stopped"); assert.equal(f.sends(), 0);
    assert.equal(result.delivery, phase === "before" ? "refused" : "failed_terminal");
  }
});

test("failed reservation/marker persistence stays unknown and never starts transport", async () => {
  for (const phase of ["reserve", "sending"]) {
    const f = setup();
    if (phase === "reserve") f.input.store.reserve = async () => { throw new Error("disk failure"); };
    else f.input.store.append = async () => { throw new Error("sync failure"); };
    const result = await runGeneratedImageDelivery(f.input); assert.equal(result.delivery, "unknown"); assert.equal(result.code, "persistence-unknown"); assert.equal(f.sends(), 0);
  }
});

test("every readback field including acknowledged photo identity must match", async () => {
  for (const change of [null, { messageId: 1235 }, { photoId: "7" }, { chatId: "-42" }, { accountId: "2" }, { replyToMessageId: 988 }, { caption: "edited" }]) {
    const f = setup(); f.input.transport.readExact = async () => change === null ? null : { ...f.readback, ...change };
    const result = await runGeneratedImageDelivery(f.input); assert.equal(result.code, "delivery-unknown"); assert.equal(f.sends(), 1); assert.equal(f.records.at(-1)!.state, "unknown");
    assert.ok(f.held()!.every(value => value === 0));
  }
});

test("invalid acknowledgement prevents fresh read and any retry", async () => {
  for (const ack of [{ messageId: 0, photoId: "1" }, { messageId: 1, photoId: "9223372036854775808" }, { messageId: 1, photoId: "0" }]) {
    const f = setup(); f.input.transport.sendOnce = async () => ack;
    assert.equal((await runGeneratedImageDelivery(f.input)).delivery, "unknown"); assert.equal(f.events.includes("read"), false);
  }
});

test("send rejection clears its owned bytes, remains consumed and never regenerates or reads", async () => {
  const f = setup(); let owned!: Buffer;
  f.input.transport.sendOnce = async request => { owned = request.bytes; throw new Error("lost send response"); };
  const result = await runGeneratedImageDelivery(f.input); await result.settlement;
  assert.equal(result.generation, "completed"); assert.equal(result.delivery, "unknown"); assert.equal(result.transportSettled, true);
  assert.ok(owned.every(value => value === 0)); assert.equal(f.events.includes("read"), false); assert.equal((await runGeneratedImageDelivery(f.input)).code, "consumed");
});

test("terminal persistence failure after real readback remains unknown without replay", async () => {
  const f = setup(), append = f.input.store.append;
  f.input.store.append = async record => { if (record.state === "verified") throw new Error("sync"); await append(record); };
  assert.equal((await runGeneratedImageDelivery(f.input)).code, "persistence-unknown"); assert.equal(f.records.at(-1)!.state, "sending");
  assert.equal((await runGeneratedImageDelivery(f.input)).code, "consumed"); assert.equal(f.sends(), 1);
});

test("abort during pending upload returns unknown, preserves bytes until actual promise settles and never starts a late read", async () => {
  const f = setup(); let finish!: (ack: ImageMediaAcknowledgement) => void, entered!: () => void, transportBytes!: Buffer;
  const started = new Promise<void>(done => { entered = done; });
  f.input.transport.sendOnce = async value => { transportBytes = value.bytes; entered(); return new Promise(done => { finish = done; }); };
  const running = runGeneratedImageDelivery(f.input); await started; f.controller.abort(); const result = await running;
  assert.equal(result.delivery, "unknown"); assert.equal(result.transportSettled, false); assert.deepEqual(transportBytes, PNG);
  let settled = false; void result.settlement.then(() => { settled = true; }); await new Promise(done => setImmediate(done)); assert.equal(settled, false);
  finish({ messageId: f.readback.messageId, photoId: f.readback.photoId }); await result.settlement;
  assert.ok(transportBytes.every(value => value === 0)); assert.equal(f.events.includes("read"), false);
});

test("abort during pending read retains no image bytes and exposes unsettled read promise", async () => {
  const f = setup(); let finish!: (read: ImageMediaReadback) => void, entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  f.input.transport.readExact = async () => { entered(); return new Promise(done => { finish = done; }); };
  const running = runGeneratedImageDelivery(f.input); await started; f.controller.abort(); const result = await running;
  assert.equal(result.delivery, "unknown"); assert.equal(result.transportSettled, false); assert.ok(f.held()!.every(value => value === 0));
  finish(f.readback); await result.settlement; assert.equal(f.records.at(-1)!.state, "unknown");
});

const TEST_BASE = resolve(tmpdir(), "neurobro-public-image-outbox-tests");
const PASSPHRASE = "synthetic-only-image-outbox-passphrase";
async function diskCase(work: (directory: string) => Promise<void>) {
  await mkdir(TEST_BASE, { recursive: true }); const root = await mkdtemp(join(TEST_BASE, "case-"));
  try { await work(join(root, "outbox")); }
  finally { if (!resolve(root).startsWith(join(TEST_BASE, "case-"))) throw new Error("test cleanup scope"); await rm(root, { recursive: true, force: true }); }
}

function readInput(directory: string) {
  const { accountId, chatId, replyToMessageId } = approved();
  return { directory, passphrase: PASSPHRASE, accountId, chatId, replyToMessageId, messageId: 1234, photoId: "9223372036854775806" };
}
async function verifiedDisk(directory: string) {
  const f = setup(), store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  attachStore(f, store);
  const result = await runGeneratedImageDelivery(f.input); await result.settlement;
  assert.equal(result.delivery, "verified"); store.close(); f.registry.close();
  return f;
}
async function diskSnapshot(directory: string) {
  const attempt = join(directory, generatedImageDeliveryKey(approved()));
  return Promise.all((await readdir(attempt)).sort().map(async name => [name, await readFile(join(attempt, name))]));
}

test("read-only verified PNG survives reopen with authenticated origin, isolated bytes and no file changes", async () => diskCase(async directory => {
  const f = await verifiedDisk(directory), before = await diskSnapshot(directory);
  const first = await readVerifiedGeneratedImage(readInput(directory));
  assert.deepEqual(first.artifact, f.artifact); assert.deepEqual(first.bytes, PNG);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.artifact) && Object.isFrozen(first.artifact.origin));
  first.bytes[0] = 0;
  const second = await readVerifiedGeneratedImage(readInput(directory));
  assert.deepEqual(second.bytes, PNG); first.close(); first.close();
  assert.ok(first.bytes.every(value => value === 0)); assert.deepEqual(second.bytes, PNG);
  second.close(); assert.ok(second.bytes.every(value => value === 0));
  assert.deepEqual(await diskSnapshot(directory), before);
  const reopened = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  await assert.rejects(reopened.reserve(f.plan(), PNG), /CONSUMED/); reopened.close();
}));

test("read-only lookup never creates a missing outbox or attempt directory", async () => diskCase(async directory => {
  await assert.rejects(readVerifiedGeneratedImage(readInput(directory)), /OUTBOX_STORAGE/);
  await assert.rejects(readdir(directory), { code: "ENOENT" });
  await mkdir(directory);
  await assert.rejects(readVerifiedGeneratedImage(readInput(directory)), /OUTBOX_STORAGE/);
  assert.deepEqual(await readdir(directory), []);
}));

test("reader preserves the generated-image 8 MiB bound rather than imposing the avatar limit", async () => diskCase(async directory => {
  const chunk = Buffer.alloc(8 * 1024 * 1024 - PNG.length, 32);
  const dataLength = chunk.length - 12;
  chunk.writeUInt32BE(dataLength, 0); chunk.write("tEXt", 4, "ascii"); chunk.write("padding\0", 8, "ascii");
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const bytes = Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
  assert.equal(bytes.length, 8 * 1024 * 1024);
  const origin = approved().origin, registry = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  const artifact = registry.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: bytes.toString("base64") });
  const binding = approved(), plan: ImageDeliveryPlan = { version: "generated-image-delivery-v1", key: generatedImageDeliveryKey(binding),
    generation: "completed", approved: binding, artifact, caption: "", randomId: "1" };
  const store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: binding });
  await store.reserve(plan, bytes);
  await store.append({ key: plan.key, planHash: generatedImagePlanHash(plan), state: "sending" });
  await store.append({ key: plan.key, planHash: generatedImagePlanHash(plan), state: "verified", messageId: 1234, photoId: readInput(directory).photoId });
  store.close(); registry.close();
  const loaded = await readVerifiedGeneratedImage(readInput(directory));
  assert.deepEqual(loaded.bytes, bytes); loaded.close(); assert.ok(loaded.bytes.every(value => value === 0)); bytes.fill(0); chunk.fill(0);
}));

test("planned, sending, unknown and failed terminal deliveries never release PNG bytes", async () => {
  for (const state of ["planned", "sending", "unknown", "failed_terminal"] as const) await diskCase(async directory => {
    const f = setup(); await runGeneratedImageDelivery(f.input); const plan = f.plan();
    const store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
    await store.reserve(plan, PNG);
    if (state !== "planned") await store.append({ key: plan.key, planHash: generatedImagePlanHash(plan), state: "sending" });
    if (state === "unknown" || state === "failed_terminal") await store.append({ key: plan.key, planHash: generatedImagePlanHash(plan), state });
    store.close(); const before = await diskSnapshot(directory);
    await assert.rejects(readVerifiedGeneratedImage(readInput(directory)), /OUTBOX_STORAGE/);
    assert.deepEqual(await diskSnapshot(directory), before); f.registry.close();
  });
});

test("wrong account, chat, original request, message, photo and secret refuse exact lookup", async () => diskCase(async directory => {
  await verifiedDisk(directory); const before = await diskSnapshot(directory);
  for (const change of [{ accountId: "222" }, { chatId: "-100789" }, { replyToMessageId: 988 }, { messageId: 1235 }, { photoId: "2" }, { passphrase: PASSPHRASE + "wrong" }]) {
    await assert.rejects(readVerifiedGeneratedImage({ ...readInput(directory), ...change }), /GENERATED_IMAGE_OUTBOX_/);
  }
  assert.deepEqual(await diskSnapshot(directory), before); assert.equal((await readdir(directory)).length, 1);
}));

test("authenticated artifact tampering and plan substitution fail PNG, digest, origin and terminal binding", async () => diskCase(async directory => {
  await verifiedDisk(directory);
  const path = join(directory, generatedImageDeliveryKey(approved()), "artifact.enc");
  const original = await readFile(path, "utf8");
  const mutate = [
    (value: any) => { const bytes = Buffer.from(value.payload.imageBase64, "base64"); bytes[bytes.length - 1]! ^= 1; value.payload.imageBase64 = bytes.toString("base64"); },
    (value: any) => { value.payload.plan.artifact.sha256 = "0".repeat(64); },
    (value: any) => { value.payload.plan.artifact.origin.itemId = "foreign"; },
    (value: any) => { value.payload.plan.approved.origin.itemId = "foreign"; value.payload.plan.artifact.origin.itemId = "foreign"; },
    (value: any) => { value.key = "0".repeat(64); },
  ];
  for (const change of mutate) {
    const value = JSON.parse(await decryptSession(original, PASSPHRASE)); change(value);
    const altered = await encryptSession(JSON.stringify(value), PASSPHRASE); await writeFile(path, altered);
    await assert.rejects(readVerifiedGeneratedImage(readInput(directory)), /GENERATED_IMAGE_OUTBOX_/);
    assert.equal(await readFile(path, "utf8"), altered);
  }
}));

test("verified terminal requires the matching sending marker and intact encrypted terminal", async () => diskCase(async directory => {
  await verifiedDisk(directory);
  const attempt = join(directory, generatedImageDeliveryKey(approved()));
  const path = join(attempt, "sending.enc"), original = await readFile(path, "utf8");
  await writeFile(path, "corrupt");
  await assert.rejects(readVerifiedGeneratedImage(readInput(directory)), /GENERATED_IMAGE_OUTBOX_/);
  await writeFile(path, original);
  const terminal = join(attempt, "terminal.enc"); await writeFile(terminal, "corrupt");
  await assert.rejects(readVerifiedGeneratedImage(readInput(directory)), /GENERATED_IMAGE_OUTBOX_/);
}));

test("reader snapshots exact target before awaiting and rejects executable input properties", async () => diskCase(async directory => {
  await verifiedDisk(directory);
  const input = readInput(directory), pending = readVerifiedGeneratedImage(input);
  input.messageId = 1235; input.photoId = "2"; input.accountId = "2"; input.directory += "-missing";
  const loaded = await pending; assert.deepEqual(loaded.bytes, PNG); loaded.close();
  let calls = 0; const trap = () => { calls++; throw new Error("must not execute"); };
  const hostile = readInput(directory); Object.defineProperty(hostile, "photoId", { get: trap, enumerable: true });
  await assert.rejects(readVerifiedGeneratedImage(hostile), /OUTBOX_INPUT/);
  await assert.rejects(readVerifiedGeneratedImage(new Proxy(readInput(directory), { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap })), /OUTBOX_INPUT/);
  assert.equal(calls, 0);
}));

test("abort before or during read refuses and abort after return clears only its byte lease", async () => diskCase(async directory => {
  await verifiedDisk(directory); const before = await diskSnapshot(directory);
  const early = new AbortController(); early.abort();
  await assert.rejects(readVerifiedGeneratedImage({ ...readInput(directory), signal: early.signal }), /OUTBOX_CLOSED/);
  const during = new AbortController(), pending = readVerifiedGeneratedImage({ ...readInput(directory), signal: during.signal });
  during.abort(); await assert.rejects(pending, /OUTBOX_CLOSED/);
  const after = new AbortController(), loaded = await readVerifiedGeneratedImage({ ...readInput(directory), signal: after.signal });
  assert.deepEqual(loaded.bytes, PNG); after.abort(); assert.ok(loaded.bytes.every(value => value === 0)); loaded.close();
  const other = await readVerifiedGeneratedImage(readInput(directory)); assert.deepEqual(other.bytes, PNG); other.close();
  assert.deepEqual(await diskSnapshot(directory), before);
}));

test("actual encrypted store retains artifact and markers; reopened inspection is metadata-only and refuses replay", async () => diskCase(async directory => {
  const f = setup(); const store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  assert.equal((await store.inspect()).delivery, "absent"); attachStore(f, store);
  const send = f.input.transport.sendOnce;
  f.input.transport.sendOnce = async (request, signal) => {
    const before = await store.inspect(); assert.equal(before.generation, "completed"); assert.equal(before.delivery, "sending"); assert.equal(before.artifact!.sha256, f.artifact.sha256);
    return send(request, signal);
  };
  assert.equal((await runGeneratedImageDelivery(f.input)).delivery, "verified");
  const snapshot = await store.inspect(); assert.equal(snapshot.generation, "completed"); assert.equal(snapshot.delivery, "verified"); assert.equal(snapshot.photoId, f.readback.photoId);
  const attempt = join(directory, generatedImageDeliveryKey(approved())); assert.deepEqual((await readdir(attempt)).sort(), ["artifact.enc", "metadata.enc", "sending.enc", "terminal.enc"]);
  for (const name of await readdir(attempt)) { const ciphertext = await readFile(join(attempt, name), "utf8"); assert.equal(ciphertext.includes(caption), false); assert.equal(ciphertext.includes(PNG.toString("base64")), false); }
  const stored = JSON.parse(await decryptSession(await readFile(join(attempt, "artifact.enc"), "utf8"), PASSPHRASE));
  assert.equal(stored.domain, "DecadansNeurobro/generated-image-outbox/v1"); assert.equal(stored.payload.imageBase64, PNG.toString("base64")); assert.equal(stored.payload.plan.artifact.sha256, f.artifact.sha256);
  assert.equal(JSON.stringify(snapshot).includes(PNG.toString("base64")), false); store.close();
  const reopened = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  assert.equal((await reopened.inspect()).delivery, "verified"); f.input.store = reopened;
  assert.equal((await runGeneratedImageDelivery(f.input)).code, "consumed"); assert.equal(f.sends(), 1); reopened.close();
}));

test("compact image metadata follows terminal and carries exactly its canonical plan for every terminal verdict", async () => {
  for (const state of ["verified", "unknown", "failed_terminal"] as const) await diskCase(async directory => {
    const f = setup(); await runGeneratedImageDelivery(f.input); const plan = f.plan();
    const store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
    const attempt = join(directory, plan.key), metadata = join(attempt, "metadata.enc");
    await store.reserve(plan, PNG); await assert.rejects(readFile(metadata), { code: "ENOENT" });
    if (state !== "failed_terminal") {
      await store.append({ key: plan.key, planHash: generatedImagePlanHash(plan), state: "sending" });
      await assert.rejects(readFile(metadata), { code: "ENOENT" });
    }
    await store.append({ key: plan.key, planHash: generatedImagePlanHash(plan), state,
      ...(state === "verified" ? { messageId: f.readback.messageId, photoId: f.readback.photoId } : {}) });
    const ciphertext = await readFile(metadata, "utf8"), plaintext = await decryptSession(ciphertext, PASSPHRASE);
    assert.ok(Buffer.byteLength(ciphertext) <= 65536); assert.ok(Buffer.byteLength(plaintext) <= 49152);
    assert.equal(plaintext, JSON.stringify({ domain: "DecadansNeurobro/generated-image-outbox/v1", key: plan.key, kind: "metadata", payload: { plan } }));
    const terminal = JSON.parse(await decryptSession(await readFile(join(attempt, "terminal.enc"), "utf8"), PASSPHRASE));
    assert.equal(terminal.payload.state, state); assert.equal(terminal.payload.planHash, generatedImagePlanHash(JSON.parse(plaintext).payload.plan));
    assert.equal(plaintext.includes(PNG.toString("base64")), false);
    await rm(metadata); assert.equal((await store.inspect()).delivery, state); // Legacy absence remains readable.
    store.close(); f.registry.close();
  });
});

test("image companion failure leaves verified verdict and no replay; terminal failure never writes companion", async () => {
  for (const blocked of ["metadata.enc", "terminal.enc"] as const) await diskCase(async directory => {
    const f = setup(), store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
    attachStore(f, store); const original = f.input.store.reserve;
    f.input.store.reserve = async (plan, bytes) => { await original(plan, bytes); await mkdir(join(directory, plan.key, blocked)); };
    const result = await runGeneratedImageDelivery(f.input); await result.settlement;
    assert.equal(result.delivery, blocked === "metadata.enc" ? "verified" : "unknown"); assert.equal(f.sends(), 1);
    if (blocked === "terminal.enc") await assert.rejects(readFile(join(directory, f.plan().key, "metadata.enc")), { code: "ENOENT" });
    store.close();
    const reopened = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
    assert.equal((await reopened.inspect()).delivery, result.delivery);
    f.input.store = reopened; assert.equal((await runGeneratedImageDelivery(f.input)).code, "consumed"); assert.equal(f.sends(), 1);
    reopened.close(); f.registry.close();
  });
});

test("planned and sending crash states remain generation-completed and permanently consumed", async () => diskCase(async directory => {
  const f = setup(); await runGeneratedImageDelivery(f.input); const plan = f.plan();
  const first = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  await first.reserve(plan, PNG); assert.equal((await first.inspect()).delivery, "planned");
  await first.append({ key: plan.key, planHash: generatedImagePlanHash(plan), state: "sending" }); first.close();
  const reopened = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  assert.equal((await reopened.inspect()).delivery, "sending"); assert.equal((await reopened.inspect()).generation, "completed");
  await assert.rejects(reopened.reserve(plan, PNG), /CONSUMED/); reopened.close();
}));

test("two store instances cannot claim one deterministic request slot", async () => diskCase(async directory => {
  const f = setup(); await runGeneratedImageDelivery(f.input); const a = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  const b = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  const results = await Promise.allSettled([a.reserve(f.plan(), PNG), b.reserve(f.plan(), PNG)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(results.filter(result => result.status === "rejected").length, 1); a.close(); b.close();
}));

test("new native epoch and image reference cannot reuse an already consumed disk request", async () => diskCase(async directory => {
  const f = setup(); const oldStore = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() }); attachStore(f, oldStore);
  assert.equal((await runGeneratedImageDelivery(f.input)).delivery, "verified"); oldStore.close();
  const origin = { ...approved().origin, threadId: "new-thread", turnId: "new-turn", itemId: "new-image" };
  const binding = { ...approved(), origin }, registry = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  const artifact = registry.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: PNG.toString("base64") });
  const nextStore = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: binding });
  const result = await runGeneratedImageDelivery({ ...f.input, approved: binding, registry, artifactRef: artifact.ref, store: nextStore });
  assert.equal(result.code, "consumed"); assert.equal(f.sends(), 1); nextStore.close(); registry.close();
}));

test("invalid append transitions, mismatched plan hash and getters cannot create a verified disk record", async () => diskCase(async directory => {
  const f = setup(); await runGeneratedImageDelivery(f.input); const plan = f.plan();
  const store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() }); await store.reserve(plan, PNG);
  let getterCalls = 0;
  const malicious = { key: plan.key, planHash: generatedImagePlanHash(plan), get state() { getterCalls++; return "verified" as const; }, messageId: 1, photoId: "1" };
  await assert.rejects(store.append(malicious), /INPUT/); assert.equal(getterCalls, 0);
  assert.equal((await store.inspect()).delivery, "planned"); await assert.rejects(store.append({ key: plan.key, planHash: "0".repeat(64), state: "sending" }), /CONSUMED/); store.close();
}));

test("partial attempt directories and corrupted terminal markers stay unknown and block new send claims", async () => diskCase(async directory => {
  const f = setup(); const store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  const attempt = join(directory, generatedImageDeliveryKey(approved())); await mkdir(attempt); await writeFile(join(attempt, "artifact.enc"), "partial");
  assert.equal((await store.inspect()).delivery, "unknown"); f.input.store = store; assert.equal((await runGeneratedImageDelivery(f.input)).code, "consumed"); assert.equal(f.sends(), 0); store.close();
}));

test("failed exclusive sending-marker write persists completed image but reports unknown", async () => diskCase(async directory => {
  const f = setup(); const store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  f.input.store = { reserve: async (plan, bytes) => { await store.reserve(plan, bytes); await writeFile(join(directory, plan.key, "sending.enc"), "partial"); }, append: store.append };
  const result = await runGeneratedImageDelivery(f.input); assert.equal(result.code, "persistence-unknown"); assert.equal(f.sends(), 0);
  assert.equal((await store.inspect()).delivery, "unknown"); assert.equal((await store.inspect()).generation, "completed"); store.close();
}));

test("wrong secret and media-domain/key substitution never expose artifact data or claim verified", async () => diskCase(async directory => {
  const f = setup(); const store = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() }); attachStore(f, store);
  await runGeneratedImageDelivery(f.input); store.close();
  const wrong = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE + "wrong", approved: approved() });
  assert.deepEqual(await wrong.inspect(), { generation: "unknown", delivery: "unknown" }); wrong.close();
  const file = join(directory, generatedImageDeliveryKey(approved()), "terminal.enc");
  const record = JSON.parse(await decryptSession(await readFile(file, "utf8"), PASSPHRASE)); record.key = "0".repeat(64);
  await writeFile(file, await encryptSession(JSON.stringify(record), PASSPHRASE));
  const reopened = await openEncryptedGeneratedImageOutbox({ directory, passphrase: PASSPHRASE, approved: approved() });
  assert.equal((await reopened.inspect()).delivery, "unknown"); reopened.close();
}));

test("result diagnostics distinguish success, input, persistence, missing readback and untyped transport errors",async()=>{
  const success=setup();assert.deepEqual((await runGeneratedImageDelivery(success.input)).diagnostics,{originalStage:'none',reason:'none'});
  const invalid=setup();invalid.input.caption='x'.repeat(1025);assert.deepEqual((await runGeneratedImageDelivery(invalid.input)).diagnostics,{originalStage:'admission',reason:'input'});
  const persistence=setup();persistence.input.store.reserve=async()=>{throw new Error('PRIVATE disk');};assert.deepEqual((await runGeneratedImageDelivery(persistence.input)).diagnostics,{originalStage:'persistence',reason:'storage'});
  const missing=setup();missing.input.transport.readExact=async()=>null;assert.deepEqual((await runGeneratedImageDelivery(missing.input)).diagnostics,{originalStage:'readback-parse',reason:'missing-message'});
  const untyped=setup();untyped.input.transport.sendOnce=async()=>{throw {diagnostics:{originalStage:'upload',reason:'invoke'},private:'PRIVATE'};};
  assert.deepEqual((await runGeneratedImageDelivery(untyped.input)).diagnostics,{originalStage:'transport-wait',reason:'unexpected'});
});

test("first trusted transport cause survives a later unknown-terminal persistence failure",async()=>{
  const f=setup(),original=f.input.store.append;
  f.input.transport.sendOnce=async()=>{throw new GeneratedImageTransportError({originalStage:'upload',reason:'invoke'});};
  f.input.store.append=async record=>{if(record.state==='unknown')throw new Error('PRIVATE fsync');await original(record);};
  const result=await runGeneratedImageDelivery(f.input);await result.settlement;assert.equal(result.code,'persistence-unknown');
  assert.deepEqual(result.diagnostics,{originalStage:'upload',reason:'invoke'});assert.ok(Object.isFrozen(result.diagnostics));assert.equal(f.events.includes('read'),false);
});

test("abort race reports only outer transport wait until actual promise settles, without retroactive stage invention",async()=>{
  const f=setup();let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(r=>{entered=r;});
  f.input.transport.sendOnce=async()=>{entered();await new Promise<void>(r=>{finish=r;});throw new GeneratedImageTransportError({originalStage:'upload',reason:'stopped'});};
  const work=runGeneratedImageDelivery(f.input);await started;f.controller.abort();const result=await work;
  assert.equal(result.transportSettled,false);assert.deepEqual(result.diagnostics,{originalStage:'transport-wait',reason:'stopped'});
  finish();await result.settlement;assert.deepEqual(result.diagnostics,{originalStage:'transport-wait',reason:'stopped'});
});

test("encrypted diagnostic terminals reopen with validated enums while legacy terminals remain readable",async()=>{
  for(const diagnostics of [undefined,{originalStage:'ack-parse',reason:'proof'} as const])await diskCase(async directory=>{
    const f=setup();await runGeneratedImageDelivery(f.input);const plan=f.plan();const store=await openEncryptedGeneratedImageOutbox({directory,passphrase:PASSPHRASE,approved:approved()});
    await store.reserve(plan,PNG);await store.append({key:plan.key,planHash:generatedImagePlanHash(plan),state:'sending'});
    await store.append({key:plan.key,planHash:generatedImagePlanHash(plan),state:'unknown',...(diagnostics?{diagnostics}:{})});store.close();
    const reopened=await openEncryptedGeneratedImageOutbox({directory,passphrase:PASSPHRASE,approved:approved()});const result=await reopened.inspect();
    assert.equal(result.delivery,'unknown');assert.deepEqual(result.diagnostics,diagnostics);if(diagnostics)assert.ok(Object.isFrozen(result.diagnostics));
    const path=join(directory,generatedImageDeliveryKey(approved()),'terminal.enc'),encrypted=await readFile(path,'utf8');assert.ok(!encrypted.includes('ack-parse'));
    const payload=JSON.parse(await decryptSession(encrypted,PASSPHRASE));payload.payload.diagnostics={originalStage:'PRIVATE arbitrary',reason:'proof'};await writeFile(path,await encryptSession(JSON.stringify(payload),PASSPHRASE));
    const bad=await reopened.inspect();assert.equal(bad.delivery,'unknown');assert.equal(bad.diagnostics,undefined);reopened.close();
  });
});

test("diagnostic constructors reject unknown enums, getters and success-shaped failures",()=>{
  let accessed=false;const hostile={originalStage:'upload',get reason(){accessed=true;return 'invoke';}};
  for(const value of [{originalStage:'PRIVATE',reason:'invoke'},{originalStage:'upload',reason:'PRIVATE'},{originalStage:'none',reason:'none'},hostile])
    assert.throws(()=>new GeneratedImageTransportError(value as ImageDeliveryDiagnostics));assert.equal(accessed,false);
});
