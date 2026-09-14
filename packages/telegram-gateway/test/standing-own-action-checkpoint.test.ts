import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createHook } from "node:async_hooks";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingOwnActionCheckpoint } from "../src/standing-own-action-checkpoint.js";
import { wrapPilotStore, wrapImageStore, wrapArtifactStore, wrapActionJournal, type StandingOwnActionCaptureEvent } from "../src/standing-own-action-capture.js";
import { createEncryptedPilotStore, runPilotReply, type PilotReply } from "../src/pilot-outbox.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { openEncryptedGeneratedImageOutbox, runGeneratedImageDelivery } from "../src/generated-image-outbox.js";
import { createStandingArtifactRegistry } from "../src/standing-artifact.js";
import { openEncryptedArtifactOutbox, runArtifactDelivery } from "../src/standing-artifact-outbox.js";
import { openStandingActionJournal } from "../src/standing-action-journal.js";
import { projectStandingOwnAction } from "../src/standing-own-action-projection.js";
import { decryptSession, encryptSession } from "../src/session-crypto.js";

const binding = { accountId: "123", peerId: "-100456" }, sourceBinding = { accountId: binding.accountId, chatId: binding.peerId };
const passphrase = "synthetic-own-action-checkpoint-passphrase";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-own-checkpoint-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-own-checkpoint-"))); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, "checkpoint"), args = { directory, binding, passphrase };
  return { root, directory, args, file: join(directory, "checkpoint.enc") };
}
async function pilotEvent(root: string, unknown = false): Promise<StandingOwnActionCaptureEvent> {
  const reply: PilotReply = { chatId: binding.peerId, replyToMessageId: 789, text: "Synthetic private complete reply" };
  let captured: StandingOwnActionCaptureEvent | undefined;
  const result = await runPilotReply({ approved: { ...sourceBinding, replyToMessageId: 789, maximumTextBytes: 4096 }, reply,
    store: wrapPilotStore(createEncryptedPilotStore(join(root, randomUUID()), passphrase), reply, event => { captured = event; }),
    signal: new AbortController().signal, killSwitchEngaged: () => false, transport: {
      async sendOnce() { if (unknown) throw Error("synthetic unknown"); return { messageId: 800 }; },
      async readExact() { return { ...reply, accountId: binding.accountId, messageId: 800 }; }
    } });
  assert.equal(result.state, unknown ? "unknown" : "verified"); assert.ok(captured); return captured;
}
// Derive coherent independent slots from an actual captured record to exercise
// retention without performing 33 redundant encrypted producer deliveries.
function variant(event: StandingOwnActionCaptureEvent, index: number): StandingOwnActionCaptureEvent {
  if (event.source.family !== "pilot") throw Error("expected pilot");
  const record = { ...event.source.record, randomId: String(10000 + index) };
  return { slot: hash(["DecadansNeurobro/own-pilot-source/v1", record.idempotencyKey, record.randomId]), source: { ...event.source, record } };
}
function project(event: StandingOwnActionCaptureEvent) {
  return projectStandingOwnAction({ binding: sourceBinding, referenceKey: "4".repeat(64), ...event });
}

test("actual captures from all four encrypted producers survive checkpoint reopen with identical projected facts", async t => {
  const f = await fixture(t), events = [await pilotEvent(f.root), await pilotEvent(f.root, true)], emit = (event: StandingOwnActionCaptureEvent) => { events.push(event); };
  const imageDirectory = join(f.root, "images"), artifactDirectory = join(f.root, "artifacts"), actionDirectory = join(f.root, "actions");
  for (const path of [imageDirectory, artifactDirectory, actionDirectory]) await mkdir(path);
  const origin = { requestRef: "synthetic-request", threadId: "synthetic-thread", turnId: "synthetic-turn", itemId: "synthetic-image" };
  const images = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  const image = images.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: PNG.toString("base64") });
  const approvedImage = { ...sourceBinding, replyToMessageId: 789, origin }, imageStore = wrapImageStore(await openEncryptedGeneratedImageOutbox({ directory: imageDirectory, passphrase, approved: approvedImage }), emit);
  try {
    const result = await runGeneratedImageDelivery({ approved: approvedImage, registry: images, artifactRef: image.ref, caption: "Private image caption", store: imageStore,
      signal: new AbortController().signal, killSwitchEngaged: () => false, transport: {
        async sendOnce() { return { messageId: 801, photoId: "999999" }; },
        async readExact() { return { ...sourceBinding, replyToMessageId: 789, caption: "Private image caption", messageId: 801, photoId: "999999" }; }
      } }); await result.settlement; assert.equal(result.delivery, "verified");
  } finally { imageStore.close(); images.close(); }
  const artifacts = createStandingArtifactRegistry({ requestRef: "synthetic-request" }), bytes = Buffer.from("Private file bytes");
  const artifact = artifacts.accept({ source: { kind: "generated", reference: "synthetic-file" }, filename: "note.txt", mimeType: "text/plain", bytes });
  const approvedArtifact = { ...sourceBinding, replyToMessageId: 789, operationSlot: 0, requestRef: "synthetic-request" };
  const artifactStore = wrapArtifactStore(await openEncryptedArtifactOutbox({ directory: artifactDirectory, passphrase, approved: approvedArtifact }), emit);
  try {
    const result = await runArtifactDelivery({ approved: approvedArtifact, registry: artifacts, artifactRef: artifact.ref, caption: "Private file caption", store: artifactStore,
      signal: new AbortController().signal, killSwitchEngaged: () => false, transport: {
        async sendOnce() { return { messageId: 802, documentId: "999998" }; },
        async readExact() { return { ...sourceBinding, replyToMessageId: 789, caption: "Private file caption", messageId: 802, documentId: "999998", filename: "note.txt", mimeType: "text/plain", byteLength: bytes.length }; }
      } }); await result.settlement; assert.equal(result.delivery, "verified");
  } finally { artifactStore.close(); artifacts.close(); }
  const actionBinding = { ...sourceBinding, primaryMessageId: 789, operationSlot: 0 };
  const action = wrapActionJournal(await openStandingActionJournal({ directory: actionDirectory, passphrase, binding: actionBinding }), actionBinding, emit);
  try { await action.reserve({ requestRef: "synthetic-request", randomId: "123456789", action: { kind: "set-reaction", messageRef: "m_synthetic", emoji: "👍" } });
    await action.append({ state: "verified", result: { verdict: "verified", change: "set" } });
  } finally { await action.close(); }
  assert.equal(events.length, 5);
  const checkpoint = await openStandingOwnActionCheckpoint(f.args);
  for (const event of events) checkpoint.stage(event);
  await checkpoint.flush(); await checkpoint.close();
  const cipher = await readFile(f.file, "utf8"); assert.equal(cipher.includes("Private"), false); assert.equal(cipher.includes("Synthetic private complete reply"), false);
  const envelope = JSON.parse(await decryptSession(cipher, passphrase));
  assert.equal(envelope.domain, "DecadansNeurobro/standing-own-action-checkpoint/v1"); assert.deepEqual(envelope.binding, binding); assert.deepEqual(envelope.events, events);
  assert.ok(Buffer.byteLength(cipher) < 4 * 1024 * 1024 + 1024); assert.equal(cipher.includes(PNG.toString("base64")), false);
  const reopened = await openStandingOwnActionCheckpoint(f.args);
  try { assert.deepEqual(reopened.read(), events); assert.deepEqual(reopened.read().map(project), events.map(project)); assert.equal(reopened.read()[1]!.source.family, "pilot"); assert.equal(project(reopened.read()[1]!).verdict, "unknown"); }
  finally { await reopened.close(); }
});

test("open, stage, clean flush and close do not create an absent checkpoint leaf", async t => {
  const f = await fixture(t), event = await pilotEvent(f.root), checkpoint = await openStandingOwnActionCheckpoint(f.args);
  assert.deepEqual(checkpoint.read(), []); await checkpoint.flush(); assert.equal(existsSync(f.directory), false);
  checkpoint.stage(event); assert.equal(existsSync(f.directory), false); await checkpoint.close(); assert.equal(existsSync(f.directory), false);
  assert.throws(() => checkpoint.read()); assert.throws(() => checkpoint.stage(event)); await assert.rejects(checkpoint.flush());
});

test("retains latest 32 logical slots and replaces an existing slot with its newest detached snapshot", async t => {
  const f = await fixture(t), base = await pilotEvent(f.root), checkpoint = await openStandingOwnActionCheckpoint(f.args);
  try {
    const events = Array.from({ length: 33 }, (_, i) => variant(base, i));
    for (const event of events) checkpoint.stage(event);
    assert.deepEqual(checkpoint.read().map(e => e.slot), events.slice(1).map(e => e.slot));
    const mutable = structuredClone(events[1]!); checkpoint.stage(mutable);
    if (mutable.source.family !== "pilot") throw Error("expected pilot"); (mutable.source.record as { randomId: string }).randomId = "987654321";
    assert.equal(checkpoint.read().length, 32); assert.equal(checkpoint.read().at(-1)!.slot, events[1]!.slot);
    assert.deepEqual(checkpoint.read().at(-1), events[1]); assert.ok(Object.isFrozen(checkpoint.read())); assert.ok(Object.isFrozen(checkpoint.read().at(-1)!.source));
    await checkpoint.flush(); assert.deepEqual(await readdir(f.directory), ["checkpoint.enc"]);
  } finally { await checkpoint.close(); }
});

test("stage refuses executable, malformed, foreign and oversized events without changing stored state", async t => {
  const f = await fixture(t), event = await pilotEvent(f.root), checkpoint = await openStandingOwnActionCheckpoint(f.args); let invoked = 0;
  try {
    checkpoint.stage(event);
    const foreign = structuredClone(event); if (foreign.source.family !== "pilot") throw Error("expected pilot"); (foreign.source.record as { accountId: string }).accountId = "999";
    const bad = [{ ...event, get source() { invoked++; return event.source; } }, new Proxy(event, { ownKeys() { invoked++; throw Error("trap"); } }),
      { ...event, extra: () => {} }, { ...event, slot: "bad" }, foreign, { ...event, source: { ...event.source, payload: "x".repeat(65537) } }];
    for (const value of bad) assert.throws(() => checkpoint.stage(value as StandingOwnActionCaptureEvent));
    assert.equal(invoked, 0); assert.deepEqual(checkpoint.read(), [event]); assert.equal(existsSync(f.directory), false);
  } finally { await checkpoint.close(); }
});

test("wrong passphrase or binding and authenticated malformed contents refuse without overwriting", async t => {
  const f = await fixture(t), event = await pilotEvent(f.root), checkpoint = await openStandingOwnActionCheckpoint(f.args);
  checkpoint.stage(event); await checkpoint.flush(); await checkpoint.close(); const bytes = await readFile(f.file);
  for (const change of [{ passphrase: "another-synthetic-passphrase" }, { binding: { ...binding, peerId: "-100999" } }]) await assert.rejects(openStandingOwnActionCheckpoint({ ...f.args, ...change }));
  assert.deepEqual(await readFile(f.file), bytes);
  const envelope = JSON.parse(await decryptSession(bytes.toString(), passphrase)); envelope.events[0].slot = "not-a-valid-slot";
  const malformed = await encryptSession(JSON.stringify(envelope), passphrase); await writeFile(f.file, malformed);
  await assert.rejects(openStandingOwnActionCheckpoint(f.args)); assert.equal(await readFile(f.file, "utf8"), malformed);
});

test("corrupt files and unknown checkpoint entries are retained and never repaired", async t => {
  for (const fault of ["corrupt", "unknown"] as const) {
    const f = await fixture(t); await mkdir(f.directory); const path = join(f.directory, fault === "corrupt" ? "checkpoint.enc" : "unexpected.tmp");
    await writeFile(path, "retained corrupt checkpoint"); await assert.rejects(openStandingOwnActionCheckpoint(f.args));
    assert.equal(await readFile(path, "utf8"), "retained corrupt checkpoint");
  }
});

test("flush captures its invocation snapshot, joins concurrent callers and leaves later stages dirty", async t => {
  const f = await fixture(t), first = await pilotEvent(f.root), second = variant(first, 1), checkpoint = await openStandingOwnActionCheckpoint(f.args);
  checkpoint.stage(first); let staged = false;
  const hook = createHook({ init(_id, type) { if (type === "SCRYPTREQUEST" && !staged) { staged = true; checkpoint.stage(second); } } });
  hook.enable();
  try { const one = checkpoint.flush(), two = checkpoint.flush(); assert.equal(one, two); await one; } finally { hook.disable(); }
  assert.equal(staged, true); assert.deepEqual(JSON.parse(await decryptSession(await readFile(f.file, "utf8"), passphrase)).events, [first]);
  assert.deepEqual(checkpoint.read(), [first, second]); await checkpoint.flush(); await checkpoint.close();
  const reopened = await openStandingOwnActionCheckpoint(f.args); try { assert.deepEqual(reopened.read(), [first, second]); } finally { await reopened.close(); }
});

test("close during real encryption revokes admission and joins the admitted flush without implicit extra flush", async t => {
  const f = await fixture(t), event = await pilotEvent(f.root), checkpoint = await openStandingOwnActionCheckpoint(f.args);
  checkpoint.stage(event); let closing: Promise<void> | undefined, closed = false;
  const hook = createHook({ init(_id, type) { if (type === "SCRYPTREQUEST" && !closing) { closing = checkpoint.close(); void closing.then(() => { closed = true; }); assert.equal(closed, false); assert.throws(() => checkpoint.stage(event)); } } });
  hook.enable(); try { await checkpoint.flush(); } finally { hook.disable(); }
  assert.ok(closing); await closing; assert.equal(closed, true); assert.throws(() => checkpoint.read());
  const reopened = await openStandingOwnActionCheckpoint(f.args); try { assert.deepEqual(reopened.read(), [event]); } finally { await reopened.close(); }
});

test("linked checkpoint leaf and substituted pinned parent refuse writes outside their admitted directory", async t => {
  const f = await fixture(t), target = join(f.root, "target"); await mkdir(target); await symlink(target, f.directory, "junction");
  await assert.rejects(openStandingOwnActionCheckpoint(f.args)); assert.deepEqual(await readdir(target), []);
  const g = await fixture(t), event = await pilotEvent(g.root), parent = join(g.root, "parent"); await mkdir(parent);
  const args = { ...g.args, directory: join(parent, "checkpoint") }, checkpoint = await openStandingOwnActionCheckpoint(args);
  checkpoint.stage(event); await rename(parent, join(g.root, "retained-parent")); await mkdir(parent);
  await assert.rejects(checkpoint.flush()); await checkpoint.close(); assert.deepEqual(await readdir(parent), []);
});

test("unknown entry introduced during checkpoint encryption prevents publication and preserves evidence", async t => {
  const f = await fixture(t), event = await pilotEvent(f.root), checkpoint = await openStandingOwnActionCheckpoint(f.args);
  checkpoint.stage(event); await checkpoint.flush(); const before = await readFile(f.file); checkpoint.stage(variant(event, 1));
  let changed = false; const hook = createHook({ init(_id, type) {
    if (type === "SCRYPTREQUEST" && !changed && existsSync(f.directory)) { changed = true; writeFileSync(join(f.directory, "late-entry"), "retained late entry"); }
  } });
  hook.enable(); try { await assert.rejects(checkpoint.flush()); } finally { hook.disable(); await checkpoint.close(); }
  assert.equal(changed, true); assert.equal(await readFile(join(f.directory, "late-entry"), "utf8"), "retained late entry");
  assert.deepEqual(await readFile(f.file), before);
  await assert.rejects(openStandingOwnActionCheckpoint(f.args));
});
