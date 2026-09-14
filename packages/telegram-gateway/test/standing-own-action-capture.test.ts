import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wrapPilotStore, wrapImageStore, wrapArtifactStore, wrapActionJournal, type StandingOwnActionCaptureEvent } from "../src/standing-own-action-capture.js";
import { createEncryptedPilotStore, runPilotReply, type PilotReply, type PilotRecord, type PilotStore } from "../src/pilot-outbox.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { generatedImageDeliveryKey, generatedImagePlanHash, openEncryptedGeneratedImageOutbox, runGeneratedImageDelivery, type ImageDeliveryPlan, type ImageDeliveryRecord } from "../src/generated-image-outbox.js";
import { createStandingArtifactRegistry } from "../src/standing-artifact.js";
import { artifactDeliveryKey, artifactDeliveryPlanHash, openEncryptedArtifactOutbox, runArtifactDelivery, type ArtifactDeliveryPlan, type ArtifactDeliveryRecord } from "../src/standing-artifact-outbox.js";
import { openStandingActionJournal, standingActionKey, type StandingActionBinding, type StandingActionIntent, type StandingActionTerminal } from "../src/standing-action-journal.js";
import { projectStandingOwnAction } from "../src/standing-own-action-projection.js";
import { openStandingOwnActionReader } from "../src/standing-own-action-reader.js";

const binding = { accountId: "123", chatId: "-100456" }, passphrase = "synthetic-own-action-capture-passphrase";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const reply: PilotReply = { chatId: binding.chatId, replyToMessageId: 789, text: "Synthetic capture reply" };
function pilotRecord(state: PilotRecord["state"]): PilotRecord {
  const contentHash = createHash("sha256").update(reply.text).digest("hex");
  return { version: "pilot-outbox-v1", ...binding, replyToMessageId: 789, randomId: "123456789", contentHash, textBytes: Buffer.byteLength(reply.text),
    idempotencyKey: hash([binding.chatId, "owner-prompt", 789, "reply", contentHash]), state, ...(state === "verified" ? { messageId: 800 } : {}) };
}
const actionBinding: StandingActionBinding = { ...binding, primaryMessageId: 789, operationSlot: 0 };
const actionIntent: StandingActionIntent = { requestRef: "synthetic-request", randomId: "123456789", action: { kind: "set-reaction", messageRef: "m_synthetic", emoji: "👍" } };
const actionTerminal: StandingActionTerminal = { state: "verified", result: { verdict: "verified", change: "set" } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-own-capture-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-own-capture-"))); await rm(root, { recursive: true, force: true }); });
  const pilot = join(root, "pilot"), images = join(root, "images"), artifacts = join(root, "artifacts"), actions = join(root, "actions");
  for (const directory of [pilot, images, artifacts, actions]) await mkdir(directory);
  return { root, pilot, images, artifacts, actions };
}
function plans() {
  const origin = { requestRef: "synthetic-request", threadId: "synthetic-thread", turnId: "synthetic-turn", itemId: "synthetic-image" };
  const imageRegistry = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  const image = imageRegistry.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: PNG.toString("base64") });
  const imageApproved = { ...binding, replyToMessageId: 789, origin };
  const imagePlan: ImageDeliveryPlan = { version: "generated-image-delivery-v1", generation: "completed", approved: imageApproved, artifact: image, key: generatedImageDeliveryKey(imageApproved), caption: "Synthetic photo", randomId: "123456789" };
  const imageTerminal: ImageDeliveryRecord = { key: imagePlan.key, planHash: generatedImagePlanHash(imagePlan), state: "verified", messageId: 801, photoId: "999999" };
  const artifactApproved = { ...binding, replyToMessageId: 789, operationSlot: 0, requestRef: "synthetic-request" }, artifactRegistry = createStandingArtifactRegistry({ requestRef: artifactApproved.requestRef });
  const bytes = Buffer.from("Synthetic file"), artifact = artifactRegistry.accept({ source: { kind: "generated", reference: "synthetic-text" }, filename: "note.txt", mimeType: "text/plain", bytes });
  const artifactPlan: ArtifactDeliveryPlan = { version: "standing-artifact-delivery-v1", approved: artifactApproved, artifact, key: artifactDeliveryKey(artifactApproved), caption: "Synthetic document", randomId: "123456789" };
  const artifactTerminal: ArtifactDeliveryRecord = { key: artifactPlan.key, planHash: artifactDeliveryPlanHash(artifactPlan), state: "verified", acknowledgement: { messageId: 802, documentId: "999998" } };
  return { imageRegistry, artifactRegistry, imagePlan, imageTerminal, artifactPlan, artifactTerminal, bytes, close() { imageRegistry.close(); artifactRegistry.close(); } };
}
function assertMetadata(value: unknown): void {
  assert.equal(Buffer.isBuffer(value), false);
  if (value && typeof value === "object") { assert.ok(Object.isFrozen(value)); for (const child of Object.values(value)) assertMetadata(child); }
}
function assertProjection(event: StandingOwnActionCaptureEvent, expected: "verified" | "unknown" = "verified") {
  const view = projectStandingOwnAction({ binding, referenceKey: "4".repeat(64), slot: event.slot, source: event.source });
  assert.equal(view.verdict, expected); assert.equal(view.currentAvailability, "not-checked"); assertMetadata(event);
}
async function assertCold(f: Awaited<ReturnType<typeof fixture>>, event: StandingOwnActionCaptureEvent, physicalSlot = event.slot) {
  const reader = await openStandingOwnActionReader({ directories: { pilot: f.pilot, images: f.images, artifacts: f.artifacts, actions: f.actions }, binding, passphrase, referenceKey: "4".repeat(64) });
  try {
    const cold = await reader.read({ family: event.source.family, slot: physicalSlot }); assert.equal(cold.status, "ready");
    const warm = projectStandingOwnAction({ binding, referenceKey: "4".repeat(64), slot: event.slot, source: event.source });
    assert.equal(cold.view?.actionRef, warm.actionRef); assert.equal(cold.view?.verdict, warm.verdict);
  } finally { await reader.close(); }
}

test("actual pilot emits one snapshot after synced terminal and canonicalizes the source independently of physical UUID", async t => {
  for (const unknown of [false, true]) {
    const f = await fixture(t), physicalSlot = randomUUID(), directory = join(f.pilot, physicalSlot), events: StandingOwnActionCaptureEvent[] = [], terminalPresent: boolean[] = [];
    const wrapped = wrapPilotStore(createEncryptedPilotStore(directory, passphrase), reply, event => {
      events.push(event); terminalPresent.push(existsSync(join(directory, "terminal.enc"))); if (unknown) throw Error("synthetic observer error");
    });
    const result = await runPilotReply({ approved: { ...binding, replyToMessageId: 789, maximumTextBytes: 4096 }, reply, store: wrapped,
      signal: new AbortController().signal, killSwitchEngaged: () => false, transport: {
        async sendOnce() { if (unknown) throw Error("synthetic unknown send"); return { messageId: 800 }; },
        async readExact() { return { ...reply, accountId: binding.accountId, messageId: 800 }; } } });
    assert.equal(result.state, unknown ? "unknown" : "verified"); assert.deepEqual(terminalPresent, [true]); assert.equal(events.length, 1);
    const event = events[0]!; if (event.source.family !== "pilot") assert.fail();
    assert.equal(event.slot, hash(["DecadansNeurobro/own-pilot-source/v1", event.source.record.idempotencyKey, event.source.record.randomId]));
    assert.deepEqual(event.source.reply, reply); assertProjection(event, unknown ? "unknown" : "verified");
    await assertCold(f, event, physicalSlot);
  }
});

test("actual image and artifact producers emit terminal metadata only, preserving inspection and synchronous close", async t => {
  const f = await fixture(t), p = plans(); t.after(() => p.close());
  const imageEvents: StandingOwnActionCaptureEvent[] = [], artifactEvents: StandingOwnActionCaptureEvent[] = [], synced: boolean[] = [];
  const imageStore = wrapImageStore(await openEncryptedGeneratedImageOutbox({ directory: f.images, passphrase, approved: p.imagePlan.approved }), event => {
    imageEvents.push(event); synced.push(existsSync(join(f.images, p.imagePlan.key, "terminal.enc")));
  });
  const image = await runGeneratedImageDelivery({ approved: p.imagePlan.approved, registry: p.imageRegistry, artifactRef: p.imagePlan.artifact.ref, caption: p.imagePlan.caption, store: imageStore,
    signal: new AbortController().signal, killSwitchEngaged: () => false, transport: {
      async sendOnce() { return { messageId: 801, photoId: "999999" }; }, async readExact() { return { ...binding, replyToMessageId: 789, caption: p.imagePlan.caption, messageId: 801, photoId: "999999" }; } } });
  await image.settlement; assert.equal(image.delivery, "verified"); assert.equal((await imageStore.inspect()).delivery, "verified"); assert.equal(imageStore.close(), undefined);
  const artifactStore = wrapArtifactStore(await openEncryptedArtifactOutbox({ directory: f.artifacts, passphrase, approved: p.artifactPlan.approved }), event => {
    artifactEvents.push(event); synced.push(existsSync(join(f.artifacts, p.artifactPlan.key, "terminal.enc")));
  });
  const artifact = await runArtifactDelivery({ approved: p.artifactPlan.approved, registry: p.artifactRegistry, artifactRef: p.artifactPlan.artifact.ref, caption: p.artifactPlan.caption, store: artifactStore,
    signal: new AbortController().signal, killSwitchEngaged: () => false, transport: {
      async sendOnce() { return { messageId: 802, documentId: "999998" }; },
      async readExact() { return { ...binding, replyToMessageId: 789, caption: p.artifactPlan.caption, messageId: 802, documentId: "999998", filename: "note.txt", mimeType: "text/plain", byteLength: p.bytes.length }; } } });
  await artifact.settlement; assert.equal(artifact.delivery, "verified"); assert.equal((await artifactStore.inspect()).delivery, "verified"); assert.equal(artifactStore.close(), undefined);
  assert.deepEqual(synced, [true, true]); assert.equal(imageEvents.length, 1); assert.equal(artifactEvents.length, 1);
  assert.equal(imageEvents[0]!.slot, p.imagePlan.key); assert.equal(artifactEvents[0]!.slot, p.artifactPlan.key);
  for (const event of [...imageEvents, ...artifactEvents]) { assertProjection(event); assert.equal(JSON.stringify(event).includes("Base64"), false); await assertCold(f, event); }
});

test("actual action journal captures after terminal and callback failure does not alter inspection", async t => {
  const f = await fixture(t), events: StandingOwnActionCaptureEvent[] = [], synced: boolean[] = [];
  const journal = wrapActionJournal(await openStandingActionJournal({ directory: f.actions, passphrase, binding: actionBinding }), actionBinding, event => {
    events.push(event); synced.push(existsSync(join(f.actions, standingActionKey(actionBinding), "terminal.enc"))); throw Error("synthetic callback failure");
  });
  await journal.reserve(actionIntent); assert.equal(events.length, 0); await journal.append(actionTerminal);
  assert.equal((await journal.inspect()).state, "verified"); await journal.close();
  assert.deepEqual(synced, [true]); assert.equal(events.length, 1); assert.equal(events[0]!.slot, standingActionKey(actionBinding)); assertProjection(events[0]!);
  await assertCold(f, events[0]!);
});

test("all wrappers suppress reserve and sending events and emit at most once even if a permissive store accepts repeated terminals", async () => {
  const p = plans();
  try {
    const events: StandingOwnActionCaptureEvent[] = [], emit = (event: StandingOwnActionCaptureEvent) => { events.push(event); };
    const pilot = wrapPilotStore({ async reserve(..._args: unknown[]) {}, async append(..._args: unknown[]) {} }, reply, emit);
    await pilot.reserve(pilotRecord("planned")); await pilot.append(pilotRecord("sending")); assert.equal(events.length, 0);
    await pilot.append(pilotRecord("verified")); await pilot.append(pilotRecord("verified")); assert.equal(events.length, 1);
    const image = wrapImageStore({ async reserve(..._args: unknown[]) {}, async append(..._args: unknown[]) {} }, emit);
    await image.reserve(p.imagePlan, PNG); await image.append({ key: p.imagePlan.key, planHash: p.imageTerminal.planHash, state: "sending" }); assert.equal(events.length, 1);
    await image.append(p.imageTerminal); await image.append(p.imageTerminal); assert.equal(events.length, 2);
    const artifact = wrapArtifactStore({ async reserve(..._args: unknown[]) {}, async append(..._args: unknown[]) {} }, emit);
    await artifact.reserve(p.artifactPlan, p.bytes); await artifact.append({ key: p.artifactPlan.key, planHash: p.artifactTerminal.planHash, state: "sending" }); assert.equal(events.length, 2);
    await artifact.append(p.artifactTerminal); await artifact.append(p.artifactTerminal); assert.equal(events.length, 3);
    const journal = wrapActionJournal({ async reserve(..._args: unknown[]) {}, async append(..._args: unknown[]) {}, async inspect() { return { state: "absent" as const }; }, async close() {} }, actionBinding, emit);
    await journal.reserve(actionIntent); assert.equal(events.length, 3); await journal.append(actionTerminal); await journal.append(actionTerminal); assert.equal(events.length, 4);
  } finally { p.close(); }
});

test("failed reservation or terminal persistence never emits a capture event", async () => {
  const p = plans();
  try {
    for (const failure of ["reserve", "terminal"] as const) {
      const events: StandingOwnActionCaptureEvent[] = [], emit = (event: StandingOwnActionCaptureEvent) => { events.push(event); }, error = Error("synthetic persistence failure");
      const methods = { async reserve(..._args: unknown[]) { if (failure === "reserve") throw error; }, async append(..._args: unknown[]) { throw error; } };
      const pilot = wrapPilotStore(methods, reply, emit), image = wrapImageStore(methods, emit), artifact = wrapArtifactStore(methods, emit);
      const journal = wrapActionJournal({ ...methods, async inspect() { return { state: "absent" as const }; }, async close() {} }, actionBinding, emit);
      const runs = [async () => { await pilot.reserve(pilotRecord("planned")); await pilot.append(pilotRecord("verified")); },
        async () => { await image.reserve(p.imagePlan, PNG); await image.append(p.imageTerminal); },
        async () => { await artifact.reserve(p.artifactPlan, p.bytes); await artifact.append(p.artifactTerminal); },
        async () => { await journal.reserve(actionIntent); await journal.append(actionTerminal); }];
      for (const run of runs) await assert.rejects(run(), error); assert.deepEqual(events, []);
    }
  } finally { p.close(); }
});

test("media metadata is snapshotted before reserve and terminal awaits while bytes remain outside capture state", async () => {
  const p = plans(), reserveGate = deferred(), terminalGate = deferred(), reserveEntered = deferred(), terminalEntered = deferred(), events: StandingOwnActionCaptureEvent[] = [];
  try {
    const plan = structuredClone(p.artifactPlan), terminal = structuredClone(p.artifactTerminal), bytes = Buffer.from(p.bytes);
    const store = wrapArtifactStore({ async reserve(_plan: ArtifactDeliveryPlan, actual: Buffer) { assert.equal(actual, bytes); reserveEntered.resolve(); await reserveGate.promise; },
      async append(..._args: unknown[]) { terminalEntered.resolve(); await terminalGate.promise; } }, event => { events.push(event); });
    const reserving = store.reserve(plan, bytes); await reserveEntered.promise;
    (plan as { caption: string }).caption = "mutated after admission"; bytes.fill(0); reserveGate.resolve(); await reserving;
    const appending = store.append(terminal); await terminalEntered.promise; (terminal as { state: string }).state = "unknown";
    assert.equal(events.length, 0); terminalGate.resolve(); await appending;
    assert.equal(events.length, 1); const source = events[0]!.source; if (source.family !== "artifact") assert.fail();
    assert.equal(source.plan.caption, p.artifactPlan.caption); assert.equal(source.terminal.state, "verified"); assertMetadata(events[0]);
  } finally { reserveGate.resolve(); terminalGate.resolve(); p.close(); }
});

test("pilot reply and action binding snapshots survive caller mutation without changing observed source identity", async () => {
  const events: StandingOwnActionCaptureEvent[] = [], mutableReply = { ...reply }, store = wrapPilotStore({ async reserve(..._args: unknown[]) {}, async append(..._args: unknown[]) {} }, mutableReply, event => { events.push(event); });
  mutableReply.text = "mutated caller reply"; await store.reserve(pilotRecord("planned")); await store.append(pilotRecord("verified"));
  if (events[0]!.source.family !== "pilot") assert.fail(); assert.equal(events[0]!.source.reply!.text, reply.text);
  const mutableBinding = { ...actionBinding }, journal = wrapActionJournal({ async reserve(..._args: unknown[]) {}, async append(..._args: unknown[]) {}, async inspect() { return { state: "absent" as const }; }, async close() {} }, mutableBinding, event => { events.push(event); });
  mutableBinding.primaryMessageId = 123; await journal.reserve(actionIntent); await journal.append(actionTerminal);
  assert.equal(events[1]!.slot, standingActionKey(actionBinding)); if (events[1]!.source.family !== "bound-action") assert.fail(); assert.deepEqual(events[1]!.source.binding, actionBinding);
});

test("wrapper forwarding preserves method receivers, extra methods and original synchronous close behavior", async () => {
  let closes = 0, reserves = 0, appends = 0;
  const original = { marker: "original", async reserve(..._args: unknown[]) { assert.equal(this, original); reserves++; }, async append(..._args: unknown[]) { assert.equal(this, original); appends++; },
    inspect() { assert.equal(this, original); return this.marker; }, close() { assert.equal(this, original); closes++; return "closed" as const; } };
  const wrapped = wrapPilotStore(original, reply, () => {});
  await wrapped.reserve(pilotRecord("planned")); await wrapped.append(pilotRecord("verified"));
  assert.equal(wrapped.inspect(), "original"); assert.equal(wrapped.close(), "closed"); assert.deepEqual([reserves, appends, closes], [1, 1, 1]);
});

test("malformed, executable and oversized capture metadata is suppressed while original store calls remain unchanged", async () => {
  const p = plans(); let invoked = 0;
  try {
    const malformed = [
      { ...p.artifactPlan, get caption() { invoked++; return "must not execute"; } },
      new Proxy(p.artifactPlan, { getPrototypeOf() { invoked++; throw Error("trap"); }, ownKeys() { invoked++; throw Error("trap"); } }),
      { ...p.artifactPlan, caption: "x".repeat(65537) },
      { ...p.artifactPlan, extra: Buffer.from("must not retain") },
    ];
    for (const plan of malformed) {
      const calls: unknown[][] = [], events: StandingOwnActionCaptureEvent[] = [];
      const original = { async reserve(...args: unknown[]) { calls.push(args); }, async append(...args: unknown[]) { calls.push(args); } };
      const wrapped = wrapArtifactStore(original, event => { events.push(event); });
      assert.equal(await wrapped.reserve(plan, p.bytes), undefined); assert.equal(await wrapped.append(p.artifactTerminal), undefined);
      assert.equal(calls.length, 2); assert.equal(calls[0]![0], plan); assert.equal(calls[0]![1], p.bytes); assert.equal(calls[1]![0], p.artifactTerminal);
      assert.deepEqual(events, []);
    }
    const events: StandingOwnActionCaptureEvent[] = [], records: unknown[] = [];
    const pilot = wrapPilotStore({ async reserve(..._args: unknown[]) {}, async append(record: PilotRecord) { records.push(record); } }, reply, event => { events.push(event); });
    const terminal = { ...pilotRecord("verified"), get state() { invoked++; return "verified" as const; } };
    await pilot.reserve(pilotRecord("planned")); await pilot.append(terminal);
    assert.equal(records[0], terminal); assert.deepEqual(events, []); assert.equal(invoked, 0);
  } finally { p.close(); }
});
