import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Api } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import { createStandingArtifactRegistry } from "../src/standing-artifact.js";
import { runArtifactDelivery, openEncryptedArtifactOutbox, artifactDeliveryKey, artifactDeliveryPlanHash, ArtifactOutboxError, type ArtifactDeliveryApproval, type ArtifactDeliveryPlan, type ArtifactDeliveryRecord } from "../src/standing-artifact-outbox.js";
import { decryptSession } from "../src/session-crypto.js";
import { ArtifactTransportError, createStandingArtifactTelegramTransport } from "../src/standing-artifact-telegram.js";

const approval = (): ArtifactDeliveryApproval => ({ accountId: "123456", chatId: "-1001234567", replyToMessageId: 12, operationSlot: 0, requestRef: "test-request" });
function syntheticVoice(): Buffer {
  const page = (packet: Buffer, sequence: number, flags: number, granule: bigint) => {
    const b = Buffer.alloc(28 + packet.length); b.write("OggS"); b[5] = flags; b.writeBigInt64LE(granule, 6);
    b.writeUInt32LE(99, 14); b.writeUInt32LE(sequence, 18); b[26] = 1; b[27] = packet.length; packet.copy(b, 28);
    let crc = 0; for (const byte of b) { crc ^= byte << 24; for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0); }
    b.writeUInt32LE(crc >>> 0, 22); return b;
  };
  const head = Buffer.alloc(19); head.write("OpusHead"); head[8] = 1; head[9] = 1; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
  const tags = Buffer.alloc(16); tags.write("OpusTags");
  return Buffer.concat([page(head, 0, 2, 0n), page(tags, 1, 0, 0n), page(Buffer.from([0xf8, 0xff, 0xfe]), 2, 4, 960n)]);
}
function fixture() {
  const approved = approval(), registry = createStandingArtifactRegistry({ requestRef: approved.requestRef });
  const bytes = Buffer.from("ordinary file payload\n"), artifact = registry.accept({ source: { kind: "generated", reference: "test-file" }, filename: "note.txt", mimeType: "text/plain", bytes });
  const controller = new AbortController(), events: string[] = [], records: ArtifactDeliveryRecord[] = [];
  let reserved = false, plan: ArtifactDeliveryPlan | undefined, held: Buffer | undefined;
  const ack = { messageId: 30, documentId: "999999" }, readback = { ...ack, chatId: approved.chatId, accountId: approved.accountId, replyToMessageId: approved.replyToMessageId, caption: "file", filename: artifact.filename, mimeType: artifact.mimeType, byteLength: artifact.byteLength };
  const input: Parameters<typeof runArtifactDelivery>[0] = { approved, registry, artifactRef: artifact.ref, caption: "file", signal: controller.signal, killSwitchEngaged: () => false,
    store: { async reserve(p, b) { if (reserved) throw new ArtifactOutboxError("consumed"); reserved = true; plan = p; assert.deepEqual(b, bytes); events.push("planned"); }, async append(r) { records.push(r); events.push(r.state); } },
    transport: { async sendOnce(v) { held = v.bytes; assert.equal(events.at(-1), "sending"); assert.equal(v.randomId, plan!.randomId); events.push("send"); return ack; }, async readExact(chatId, id) { assert.equal(chatId, approved.chatId); assert.equal(id, ack.messageId); events.push("read"); return readback; } },
  };
  return { input, controller, events, records, registry, artifact, bytes, ack, readback, plan: () => plan!, held: () => held! };
}
test("general file delivery persists intent before upload and proves exact document", async () => {
  const f = fixture(); const r = await runArtifactDelivery(f.input); await r.settlement;
  assert.equal(r.delivery, "verified"); assert.deepEqual(r.acknowledgement, f.ack); assert.deepEqual(f.events, ["planned", "sending", "send", "read", "verified"]);
  assert.ok(f.held().every(v => v === 0)); assert.deepEqual(f.registry.copyBytes(f.artifact.ref), f.bytes);
  assert.equal((await runArtifactDelivery(f.input)).failure?.reason, "consumed"); assert.equal(f.events.filter(v => v === "send").length, 1); f.registry.close();
});
test("delivery slot survives native request changes; explicit next slot is distinct", () => {
  assert.equal(artifactDeliveryKey(approval()), artifactDeliveryKey({ ...approval(), requestRef: "next-epoch" }));
  assert.notEqual(artifactDeliveryKey(approval()), artifactDeliveryKey({ ...approval(), operationSlot: 1 }));
});

test("voice framing is persisted before send and exact wire media is verified across encrypted reopen", async t => {
  const d = await disk(t), approved = approval(), registry = createStandingArtifactRegistry({ requestRef: approved.requestRef });
  const bytes = syntheticVoice(), artifact = registry.accept({ source: { kind: "generated", reference: "synthetic-voice" }, filename: "voice.ogg", mimeType: "audio/ogg", bytes });
  const store = await openEncryptedArtifactOutbox({ ...d, approved });
  const ack = { messageId: 30, documentId: "999999" }; let plan: ArtifactDeliveryPlan | undefined;
  const r = await runArtifactDelivery({ approved, registry, artifactRef: artifact.ref, caption: "голосовое", mediaKind: "voice", signal: new AbortController().signal, killSwitchEngaged: () => false,
    store: { async reserve(p, b) { plan = p; await store.reserve(p, b); }, append: store.append },
    transport: { async sendOnce(v) { assert.equal(plan!.mediaKind, "voice"); assert.deepEqual(v.mediaProfile, plan!.mediaProfile); assert.equal(v.mediaProfile!.durationSeconds, (960 - 312) / 48000); assert.equal(v.audio, undefined); return ack; },
      async readExact() { return { ...ack, chatId: approved.chatId, accountId: approved.accountId, replyToMessageId: approved.replyToMessageId, caption: "голосовое", filename: artifact.filename, mimeType: artifact.mimeType, byteLength: bytes.length, media: { kind: "voice", durationSeconds: 1 } }; } } });
  await r.settlement; assert.equal(r.delivery, "verified"); store.close(); registry.close();
  const reopened = await openEncryptedArtifactOutbox({ ...d, approved }); assert.equal((await reopened.inspect()).delivery, "verified"); reopened.close();
});

test("unsupported media refuses before persistence and wrong voice profile readback is unknown", async () => {
  for (const mediaKind of ["audio", "voice", "video", "round-video"] as const) {
    const f = fixture(); const r = await runArtifactDelivery({ ...f.input, mediaKind }); assert.equal(r.delivery, "refused"); assert.deepEqual(f.events, []); f.registry.close();
  }
  for (const media of [undefined, { kind: "voice", durationSeconds: 2 }, { kind: "video", durationSeconds: 1 }, { kind: "voice", durationSeconds: 1, sha256: "0".repeat(64) }]) {
    const f = fixture(), registry = createStandingArtifactRegistry({ requestRef: approval().requestRef }); const bytes = syntheticVoice();
    const artifact = registry.accept({ source: { kind: "generated", reference: "voice" }, filename: "voice.ogg", mimeType: "audio/ogg", bytes });
    const r = await runArtifactDelivery({ ...f.input, registry, artifactRef: artifact.ref, mediaKind: "voice",
      store: { async reserve() {}, async append() {} }, transport: { async sendOnce() { return f.ack; }, async readExact() { return { ...f.readback, filename: artifact.filename, mimeType: artifact.mimeType, byteLength: bytes.length, ...(media ? { media } : {}) } as Awaited<ReturnType<Parameters<typeof runArtifactDelivery>[0]["transport"]["readExact"]>>; } } });
    assert.equal(r.delivery, "unknown"); await r.settlement; registry.close(); f.registry.close();
  }
});
test("invalid metadata, mismatched scope and caption refuse without persistence or upload", async () => {
  for (const change of [{ requestRef: "other" }, { operationSlot: -1 }, { chatId: "42" }]) { const f = fixture(); f.input.approved = { ...f.input.approved, ...change }; assert.equal((await runArtifactDelivery(f.input)).delivery, "refused"); assert.deepEqual(f.events, []); }
  for (const caption of ["x".repeat(1025), "\ud800", "x\0y"]) { const f = fixture(); f.input.caption = caption; assert.equal((await runArtifactDelivery(f.input)).delivery, "refused"); assert.deepEqual(f.events, []); }
  const f = fixture(); f.input.registry = { get: () => ({ ...f.artifact, sha256: "0".repeat(64) }), copyBytes: () => Buffer.from(f.bytes) }; assert.equal((await runArtifactDelivery(f.input)).delivery, "refused"); assert.deepEqual(f.events, []);
});
test("STOP at each pre-send durable stage never uploads", async () => {
  for (const stage of ["before", "planned", "sending"]) {
    const f = fixture(); f.input.killSwitchEngaged = () => stage === "before" || f.events.includes(stage);
    const r = await runArtifactDelivery(f.input); assert.equal(r.failure?.reason, "stopped"); assert.equal(f.events.includes("send"), false);
    assert.equal(r.delivery, stage === "before" ? "refused" : "failed_terminal");
  }
});
test("uncertain store/ACK/readback does not retry or claim delivery", async () => {
  for (const stage of ["reserve", "sending", "ack", "read", "terminal"]) {
    const f = fixture();
    if (stage === "reserve") f.input.store.reserve = async () => { throw new Error("private disk error"); };
    if (stage === "sending" || stage === "terminal") f.input.store.append = async r => { if (r.state === (stage === "sending" ? "sending" : "verified")) throw new Error("private storage error"); };
    if (stage === "ack") f.input.transport = { ...f.input.transport, sendOnce: async () => ({ messageId: 0, documentId: "5" }) };
    if (stage === "read") f.input.transport = { ...f.input.transport, readExact: async () => null };
    const r = await runArtifactDelivery(f.input); await r.settlement; assert.equal(r.delivery, "unknown"); assert.equal(JSON.stringify(r).includes("private"), false); assert.ok(f.events.filter(v => v === "send").length <= 1);
  }
});
test("all document identity and metadata fields must agree with the admitted file", async () => {
  for (const change of [{ documentId: "7" }, { messageId: 31 }, { accountId: "1" }, { chatId: "-99" }, { replyToMessageId: 13 }, { caption: "other" }, { filename: "other.txt" }, { mimeType: "audio/mpeg" }, { byteLength: 1 }]) {
    const f = fixture(); f.input.transport = { ...f.input.transport, readExact: async () => ({ ...f.readback, ...change }) }; assert.equal((await runArtifactDelivery(f.input)).delivery, "unknown");
  }
});
test("typed transport cause survives terminal write failure, without raw error text", async () => {
  const f = fixture(); f.input.transport = { ...f.input.transport, sendOnce: async () => { throw new ArtifactTransportError({ stage: "upload", reason: "invoke" }); } };
  f.input.store.append = async r => { if (r.state === "failed_terminal") throw new Error("private path"); };
  const r = await runArtifactDelivery(f.input); assert.equal(r.delivery, "unknown"); assert.deepEqual(r.failure?.transport, { stage: "upload", reason: "invoke" }); assert.equal(JSON.stringify(r).includes("private"), false);
});

test("actual transport preflight and upload refusals consume a failed terminal without sending media", async () => {
  for (const cause of ["primary-before", "primary-after", "upload-refused", "upload-error"] as const) {
    const f = fixture(), approved = f.input.approved;
    const selected = { chatId: approved.chatId, ownerId: "654321", messageId: approved.replyToMessageId, text: "Send this file" };
    let validations = 0, uploads = 0, sends = 0;
    f.input.transport = createStandingArtifactTelegramTransport({
      binding: { accountId: approved.accountId, peerId: approved.chatId },
      peer: new Api.InputPeerChannel({ channelId: bigInt(1234567), accessHash: bigInt(3) }),
      self: new Api.User({ id: bigInt(approved.accountId), self: true }), selected,
      signal: f.controller.signal, isSelectionActive: () => true,
      revalidatePrimary: async () => ({ ...selected, text: ++validations === (cause === "primary-before" ? 1 : cause === "primary-after" ? 2 : -1) ? "Do not send" : selected.text }),
      client: { async invoke(request) {
        if (request instanceof Api.upload.SaveFilePart) {
          uploads++;
          if (cause === "upload-error") throw new Error("synthetic upload failure");
          return cause !== "upload-refused";
        }
        if (request instanceof Api.messages.SendMedia) sends++;
        throw new Error("unexpected Telegram request");
      } },
    });
    const result = await runArtifactDelivery(f.input); await result.settlement;
    assert.equal(result.delivery, "failed_terminal", cause);
    assert.equal(result.transportSettled, true, cause);
    assert.equal(sends, 0, cause); assert.equal(uploads, cause === "primary-before" ? 0 : 1, cause);
    assert.deepEqual(f.records.map(record => record.state), ["sending", "failed_terminal"], cause);
    assert.equal((await runArtifactDelivery(f.input)).failure?.reason, "consumed", cause);
    f.registry.close();
  }
});

test("late, duplicate, generic and forged pre-dispatch errors retain unknown", async () => {
  let traps = 0;
  const forged = Object.defineProperty(Object.create(ArtifactTransportError.prototype), "diagnostics", { get() { traps++; throw new Error("getter"); } });
  const errors: unknown[] = [new Error("upload failed"), { diagnostics: { stage: "upload", reason: "invoke" } }, forged,
    new Proxy({}, { getPrototypeOf() { traps++; return ArtifactTransportError.prototype; } }),
    new ArtifactTransportError({ stage: "admission", reason: "consumed" }),
    ...(["send-invoke", "ack-parse", "read-invoke", "readback-parse"] as const).map(stage => new ArtifactTransportError({ stage, reason: "invoke" }))];
  for (const error of errors) {
    const f = fixture(); f.input.transport = { ...f.input.transport, sendOnce: async () => { throw error; } };
    const result = await runArtifactDelivery(f.input); await result.settlement;
    assert.equal(result.delivery, "unknown"); assert.equal(f.records.at(-1)!.state, "unknown"); f.registry.close();
  }
  const f = fixture(); f.input.transport = { ...f.input.transport, readExact: async () => { throw new ArtifactTransportError({ stage: "upload", reason: "invoke" }); } };
  assert.equal((await runArtifactDelivery(f.input)).delivery, "unknown"); f.registry.close();
  assert.equal(traps, 0);
});

test("aborted pending raw upload remains unknown even if it later proves no media dispatch", async () => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.input.transport = { ...f.input.transport, async sendOnce() { entered(); await gate; throw new ArtifactTransportError({ stage: "upload", reason: "stopped" }); } };
  const pending = runArtifactDelivery(f.input); await began; f.controller.abort();
  const result = await pending; assert.equal(result.delivery, "unknown"); assert.equal(result.transportSettled, false);
  release(); await result.settlement; assert.equal(f.records.at(-1)!.state, "unknown"); f.registry.close();
});
test("aborted upload retains bytes until actual settlement and never issues readback", async () => {
  const f = fixture(); let release!: () => void, entered!: () => void, held: Buffer | undefined;
  const began = new Promise<void>(r => { entered = r; }), pending = new Promise<void>(r => { release = r; });
  f.input.transport = { ...f.input.transport, sendOnce: async v => { held = v.bytes; entered(); await pending; assert.deepEqual(held, f.bytes); return f.ack; } };
  const work = runArtifactDelivery(f.input); await began; f.controller.abort(); const r = await work;
  assert.equal(r.delivery, "unknown"); assert.equal(r.transportSettled, false); assert.deepEqual(held, f.bytes); assert.equal(f.events.includes("read"), false);
  release(); await r.settlement; assert.ok(held!.every(v => v === 0));
});
async function disk(t: TestContext) {
  const parent = await mkdtemp(join(resolve(tmpdir()), "neurobro-artifact-outbox-"));
  t.after(async () => { assert.ok(parent.startsWith(join(resolve(tmpdir()), "neurobro-artifact-outbox-"))); await rm(parent, { recursive: true, force: true }); });
  return { directory: join(parent, "outbox"), passphrase: "synthetic-only-passphrase-32-characters" };
}

test("compact artifact metadata follows terminal and contains exactly its canonical plan for all verdicts", async t => {
  for (const state of ["verified", "unknown", "failed_terminal"] as const) {
    const d = await disk(t), f = fixture(); await runArtifactDelivery(f.input); const plan = f.plan();
    const store = await openEncryptedArtifactOutbox({ ...d, approved: approval() });
    const attempt = join(d.directory, plan.key), metadata = join(attempt, "metadata.enc");
    await store.reserve(plan, f.bytes); await assert.rejects(readFile(metadata), { code: "ENOENT" });
    if (state !== "failed_terminal") {
      await store.append({ key: plan.key, planHash: artifactDeliveryPlanHash(plan), state: "sending" });
      await assert.rejects(readFile(metadata), { code: "ENOENT" });
    }
    await store.append({ key: plan.key, planHash: artifactDeliveryPlanHash(plan), state,
      ...(state === "verified" ? { acknowledgement: f.ack } : { failure: { stage: "prepare", reason: "stopped" } as const }) });
    const ciphertext = await readFile(metadata, "utf8"), plaintext = await decryptSession(ciphertext, d.passphrase);
    assert.ok(Buffer.byteLength(ciphertext) <= 65536); assert.ok(Buffer.byteLength(plaintext) <= 49152);
    assert.equal(plaintext, JSON.stringify({ domain: "DecadansNeurobro/artifact-outbox/v1", key: plan.key, kind: "metadata", payload: { plan } }));
    const terminal = JSON.parse(await decryptSession(await readFile(join(attempt, "terminal.enc"), "utf8"), d.passphrase));
    assert.equal(terminal.payload.state, state); assert.equal(terminal.payload.planHash, artifactDeliveryPlanHash(JSON.parse(plaintext).payload.plan));
    assert.equal(plaintext.includes(f.bytes.toString("base64")), false);
    await rm(metadata); assert.equal((await store.inspect()).delivery, state);
    store.close(); f.registry.close();
  }
});

test("artifact companion failure keeps verified verdict and no replay; terminal failure has no companion", async t => {
  for (const blocked of ["metadata.enc", "terminal.enc"] as const) {
    const d = await disk(t), f = fixture(), store = await openEncryptedArtifactOutbox({ ...d, approved: approval() });
    f.input.store = { async reserve(plan, bytes) { await store.reserve(plan, bytes); await mkdir(join(d.directory, plan.key, blocked)); }, append: store.append };
    let sends = 0; f.input.transport = { ...f.input.transport, sendOnce: async () => { sends++; return f.ack; } };
    const result = await runArtifactDelivery(f.input); await result.settlement;
    assert.equal(result.delivery, blocked === "metadata.enc" ? "verified" : "unknown"); assert.equal(sends, 1);
    if (blocked === "terminal.enc") await assert.rejects(readFile(join(d.directory, artifactDeliveryKey(approval()), "metadata.enc")), { code: "ENOENT" });
    store.close();
    const reopened = await openEncryptedArtifactOutbox({ ...d, approved: approval() });
    assert.equal((await reopened.inspect()).delivery, result.delivery);
    f.input.store = reopened; assert.equal((await runArtifactDelivery(f.input)).failure?.reason, "consumed"); assert.equal(sends, 1);
    reopened.close(); f.registry.close();
  }
});
test("encrypted file store reopens verified delivery and refuses epoch replay", async t => {
  const f = fixture(), d = await disk(t), store = await openEncryptedArtifactOutbox({ ...d, approved: f.input.approved });
  const fixtureStore = f.input.store;
  f.input.store = { async reserve(plan, bytes) { await store.reserve(plan, bytes); await fixtureStore.reserve(plan, bytes); }, async append(record) { await store.append(record); await fixtureStore.append(record); } };
  assert.equal((await store.inspect()).delivery, "absent"); const r = await runArtifactDelivery(f.input); assert.equal(r.delivery, "verified"); store.close();
  const reopened = await openEncryptedArtifactOutbox({ ...d, approved: { ...approval(), requestRef: "new-epoch" } });
  const read = await reopened.inspect(); assert.equal(read.delivery, "verified"); assert.deepEqual(read.acknowledgement, f.ack); assert.equal(read.artifact!.sha256, f.artifact.sha256);
  const filenames = await readdir(join(d.directory, artifactDeliveryKey(approval()))); assert.deepEqual(filenames.sort(), ["artifact.enc", "metadata.enc", "sending.enc", "terminal.enc"]);
  const cipher = await readFile(join(d.directory, artifactDeliveryKey(approval()), "artifact.enc"), "utf8"); assert.equal(cipher.includes("ordinary file payload"), false); assert.equal(cipher.includes("note.txt"), false);
  f.input.store = reopened; f.input.approved = { ...approval(), requestRef: "new-epoch" }; const fresh = createStandingArtifactRegistry({ requestRef: "new-epoch" }); const next = fresh.accept({ source: { kind: "generated", reference: "new" }, filename: "new.txt", mimeType: "text/plain", bytes: Buffer.from("new content") }); f.input.registry = fresh; f.input.artifactRef = next.ref;
  assert.equal((await runArtifactDelivery(f.input)).failure?.reason, "consumed"); reopened.close();
});
test("incomplete and corrupted encrypted attempts remain unknown and consumed", async t => {
  const d = await disk(t), f = fixture(); await mkdir(d.directory); await mkdir(join(d.directory, artifactDeliveryKey(approval())));
  const store = await openEncryptedArtifactOutbox({ ...d, approved: approval() }); assert.equal((await store.inspect()).delivery, "unknown"); f.input.store = store;
  assert.equal((await runArtifactDelivery(f.input)).failure?.reason, "consumed"); store.close();
  await writeFile(join(d.directory, artifactDeliveryKey(approval()), "artifact.enc"), "broken"); const reopened = await openEncryptedArtifactOutbox({ ...d, approved: approval() }); assert.equal((await reopened.inspect()).delivery, "unknown"); reopened.close();
});
test("planned state is inspectable but does not authorize upload after restart", async t => {
  const d = await disk(t), f = fixture(), store = await openEncryptedArtifactOutbox({ ...d, approved: approval() });
  const original = f.input.store; f.input.store = { async reserve(plan, bytes) { await store.reserve(plan, bytes); await original.reserve(plan, bytes); }, async append() { throw new Error("crash before sending"); } };
  assert.equal((await runArtifactDelivery(f.input)).delivery, "unknown"); store.close();
  const reopened = await openEncryptedArtifactOutbox({ ...d, approved: approval() }); assert.equal((await reopened.inspect()).delivery, "planned"); f.input.store = reopened; assert.equal((await runArtifactDelivery(f.input)).failure?.reason, "consumed"); reopened.close();
});
test("hostile approval and ACK proxies are refused without invoking traps", async () => {
  let calls = 0; const proxy = new Proxy(approval(), { get() { calls++; throw new Error("trap"); }, getPrototypeOf() { calls++; throw new Error("trap"); } });
  const f = fixture(); f.input.approved = proxy; assert.equal((await runArtifactDelivery(f.input)).delivery, "refused"); assert.equal(calls, 0);
  // JS promise assimilation reads then before the outbox receives the value;
  // only the subsequent data-validation accesses belong to this boundary.
  const g = fixture(); g.input.transport = { ...g.input.transport, sendOnce: async () => new Proxy(g.ack, { get(_target, key) { if (key === "then") return undefined; calls++; throw new Error("trap"); } }) };
  assert.equal((await runArtifactDelivery(g.input)).delivery, "unknown"); assert.equal(calls, 0);
});
test("MP3 registry → encrypted outbox → installed GramJS transport verifies integer wire duration", async t => {
  const d = await disk(t), approved = approval(), registry = createStandingArtifactRegistry({ requestRef: approved.requestRef });
  const source = Buffer.concat(Array.from({ length: 3 }, () => { const frame = Buffer.alloc(417); frame.set([255, 251, 144, 0]); return frame; }));
  const artifact = registry.accept({ source: { kind: "generated", reference: "synthetic-audio" }, filename: "sound.mp3", mimeType: "audio/mpeg", bytes: source, audio: { durationSeconds: 99, title: "Synthetic", performer: "Fixture" } });
  assert.ok(artifact.audio!.durationSeconds > 0 && artifact.audio!.durationSeconds < 1);
  const stop = new AbortController(), selected = { chatId: approved.chatId, ownerId: "654321", messageId: approved.replyToMessageId, text: "ПРОМПТ аудио" };
  const chunks: Buffer[] = []; let media: Api.InputMediaUploadedDocument | undefined, sends = 0, reads = 0;
  const wire = <T extends { getBytes(): Buffer }>(v: T): T => { const b = v.getBytes(), r = new BinaryReader(b), decoded = r.tgReadObject(); assert.equal(r.tellPosition(), b.length); return decoded as T; };
  const makeMedia = () => new Api.MessageMediaDocument({ document: new Api.Document({ id: bigInt(777), accessHash: bigInt(22), fileReference: Buffer.alloc(0), date: 1, mimeType: media!.mimeType, size: bigInt(source.length), dcId: 2, attributes: media!.attributes }) });
  const transport = createStandingArtifactTelegramTransport({ binding: { accountId: approved.accountId, peerId: approved.chatId }, peer: new Api.InputPeerChannel({ channelId: bigInt(1234567), accessHash: bigInt(3) }), self: new Api.User({ id: bigInt(approved.accountId), self: true }), selected, signal: stop.signal, isSelectionActive: () => true, revalidatePrimary: async () => selected,
    client: { async invoke(r) {
      // Sending marker must already be durable even for the first upload part.
      assert.ok((await readFile(join(d.directory, artifactDeliveryKey(approved), "sending.enc"))).length > 0);
      if (r instanceof Api.upload.SaveFilePart) { chunks.push(Buffer.from(wire(r).bytes)); return true; }
      if (r instanceof Api.messages.SendMedia) {
        sends++; const decoded = wire(r); assert.ok(decoded.media instanceof Api.InputMediaUploadedDocument); media = decoded.media;
        const audio = media.attributes.find(a => a instanceof Api.DocumentAttributeAudio); assert.ok(audio instanceof Api.DocumentAttributeAudio); assert.equal(audio.duration, 1); assert.equal(audio.title, "Synthetic"); assert.equal(media.forceFile, false);
        return wire(new Api.UpdateShortSentMessage({ id: 55, out: true, pts: 1, ptsCount: 1, date: 1, media: makeMedia() }));
      }
      assert.ok(r instanceof Api.channels.GetMessages); reads++;
      return wire(new Api.messages.Messages({ messages: [new Api.Message({ id: 55, out: true, peerId: new Api.PeerChannel({ channelId: bigInt(1234567) }), fromId: new Api.PeerUser({ userId: bigInt(approved.accountId) }), date: 1, message: "audio", replyTo: new Api.MessageReplyHeader({ replyToMsgId: approved.replyToMessageId }), media: makeMedia() })], chats: [], users: [] }));
    } },
  });
  const store = await openEncryptedArtifactOutbox({ ...d, approved });
  const result = await runArtifactDelivery({ approved, registry, artifactRef: artifact.ref, caption: "audio", store, transport, signal: stop.signal, killSwitchEngaged: () => false }); await result.settlement;
  assert.equal(result.delivery, "verified", JSON.stringify(result)); assert.equal(sends, 1); assert.equal(reads, 1); assert.deepEqual(Buffer.concat(chunks), source); store.close(); registry.close();
  const reopened = await openEncryptedArtifactOutbox({ ...d, approved }); const proof = await reopened.inspect(); assert.equal(proof.delivery, "verified"); assert.equal(proof.artifact!.audio!.durationSeconds, artifact.audio!.durationSeconds); reopened.close();
});
