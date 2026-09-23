import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHook } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, unlink, copyFile, link, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingOwnActionReader } from "../src/standing-own-action-reader.js";
import { createEncryptedPilotStore, runPilotReply, PilotPreDispatchError, type PilotReply } from "../src/pilot-outbox.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { openEncryptedGeneratedImageOutbox, runGeneratedImageDelivery, generatedImageDeliveryKey } from "../src/generated-image-outbox.js";
import { createStandingArtifactRegistry } from "../src/standing-artifact.js";
import { openEncryptedArtifactOutbox, runArtifactDelivery, artifactDeliveryKey } from "../src/standing-artifact-outbox.js";
import { openStandingActionJournal, standingActionKey } from "../src/standing-action-journal.js";
import { openStandingDialogueJournal } from "../src/standing-dialogue-journal.js";
import { decryptSession, encryptSession } from "../src/session-crypto.js";

const binding = { accountId: "123", chatId: "-100456" }, passphrase = "synthetic-own-action-reader-passphrase", referenceKey = "3".repeat(64);
type Family = "pilot" | "generated-image" | "artifact" | "bound-action";
type Handle = Awaited<ReturnType<typeof openStandingOwnActionReader>>;
async function fixture(t: TestContext, createParents = true) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-own-reader-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-own-reader-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { pilot: join(root, "pilot"), images: join(root, "images"), artifacts: join(root, "artifacts"), actions: join(root, "actions"), dialogues: join(root, "dialogues") };
  if (createParents) for (const path of Object.values(directories)) await mkdir(path);
  const args = { directories, binding, passphrase, referenceKey };
  const openReader = async () => { const reader = await openStandingOwnActionReader(args); t.after(() => reader.close()); return reader; };
  return { root, directories, args, openReader };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function producePilot(f: Fixture, unknown = false, withDialogue = false, text = "Synthetic verified reply", questionText = "Synthetic question") {
  const slot = randomUUID(), directory = join(f.directories.pilot, slot);
  const reply: PilotReply = { chatId: binding.chatId, replyToMessageId: 789, text, entities: [{ type: "bold", offset: 0, length: 9 }] };
  const result = await runPilotReply({ approved: { ...binding, replyToMessageId: 789, maximumTextBytes: 4096 }, reply,
    store: createEncryptedPilotStore(directory, passphrase), signal: new AbortController().signal, killSwitchEngaged: () => false,
    transport: { async sendOnce() { if (unknown) throw Error("synthetic lost send acknowledgement"); return { messageId: 800 }; },
      async readExact() { return { ...reply, accountId: binding.accountId, messageId: 800 }; } } });
  assert.equal(result.state, unknown ? "unknown" : "verified");
  if (withDialogue) {
    const journal = await openStandingDialogueJournal({ directory: f.directories.dialogues, passphrase, binding: { accountId: binding.accountId, peerId: binding.chatId } });
    try { const claim = await journal.recordQuestion({ primary: { chatId: binding.chatId, ownerId: "456", messageId: 789, text: questionText }, source: { date: 1500, displayName: "Synthetic person" } });
      await journal.recordModelAdmission({ key: claim.key, attemptRef: "synthetic-attempt" });
      await journal.recordOutcome({ key: claim.key, delivery: unknown ? "unknown" : "verified", kind: "model", answer: reply.text, entities: reply.entities! });
    } finally { journal.close(); }
  }
  return { family: "pilot" as const, slot, directory, reply };
}
async function produceImage(f: Fixture, unknown = false) {
  const origin = { requestRef: "synthetic-request", threadId: "synthetic-thread", turnId: "synthetic-turn", itemId: "synthetic-image" }, approved = { ...binding, replyToMessageId: 789, origin };
  const registry = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId }), store = await openEncryptedGeneratedImageOutbox({ directory: f.directories.images, passphrase, approved });
  try {
    const artifact = registry.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" });
    const result = await runGeneratedImageDelivery({ approved, registry, artifactRef: artifact.ref, caption: "Synthetic photo", store,
      signal: new AbortController().signal, killSwitchEngaged: () => false, transport: {
        async sendOnce() { if (unknown) throw Error("synthetic unknown image send"); return { messageId: 801, photoId: "999999" }; },
        async readExact() { return { ...binding, replyToMessageId: 789, messageId: 801, photoId: "999999", caption: "Synthetic photo" }; } } });
    await result.settlement; assert.equal(result.delivery, unknown ? "unknown" : "verified");
  } finally { store.close(); registry.close(); }
  const slot = generatedImageDeliveryKey(approved); return { family: "generated-image" as const, slot, directory: join(f.directories.images, slot) };
}
async function produceArtifact(f: Fixture, unknown = false) {
  const approved = { ...binding, replyToMessageId: 789, operationSlot: 0, requestRef: "synthetic-request" }, registry = createStandingArtifactRegistry({ requestRef: approved.requestRef });
  const store = await openEncryptedArtifactOutbox({ directory: f.directories.artifacts, passphrase, approved });
  try {
    const bytes = Buffer.from("Synthetic file payload"), artifact = registry.accept({ source: { kind: "generated", reference: "synthetic-only" }, filename: "note.txt", mimeType: "text/plain", bytes });
    const result = await runArtifactDelivery({ approved, registry, artifactRef: artifact.ref, caption: "Synthetic document", store,
      signal: new AbortController().signal, killSwitchEngaged: () => false, transport: {
        async sendOnce() { if (unknown) throw Error("synthetic unknown artifact send"); return { messageId: 802, documentId: "999998" }; },
        async readExact() { return { ...binding, replyToMessageId: 789, messageId: 802, documentId: "999998", caption: "Synthetic document", filename: artifact.filename, mimeType: artifact.mimeType, byteLength: bytes.length }; } } });
    await result.settlement; assert.equal(result.delivery, unknown ? "unknown" : "verified");
  } finally { store.close(); registry.close(); }
  const slot = artifactDeliveryKey(approved); return { family: "artifact" as const, slot, directory: join(f.directories.artifacts, slot) };
}
async function produceAction(f: Fixture, unknown = false) {
  const actionBinding = { ...binding, primaryMessageId: 789, operationSlot: 0 }, journal = await openStandingActionJournal({ directory: f.directories.actions, passphrase, binding: actionBinding });
  try { await journal.reserve({ requestRef: "synthetic-request", randomId: "123456789", action: { kind: "set-reaction", messageRef: "m_synthetic", emoji: "👍" } });
    await journal.append({ state: unknown ? "unknown" : "verified", result: unknown ? { verdict: "unknown" } : { verdict: "verified", change: "set" } });
  } finally { await journal.close(); }
  const slot = standingActionKey(actionBinding); return { family: "bound-action" as const, slot, directory: join(f.directories.actions, slot) };
}
const producers = [producePilot, produceImage, produceArtifact, produceAction] as const;
test("long Russian stored question still joins its verified bounded answer after reopen", async t => {
  const f = await fixture(t), source = await producePilot(f, false, true, "Synthetic verified reply", "я".repeat(4095) + " конец");
  const reader = await f.openReader(), result = await reader.read({ family: source.family, slot: source.slot });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.view?.content, { kind: "text", text: source.reply.text });
});

test("cold own-action reader accepts verified standalone task evidence without changing original identity", async t => {
  const f = await fixture(t), slot = randomUUID(), reply = { chatId: binding.chatId, replyToMessageId: 789, text: "Saved task result" };
  const result = await runPilotReply({ approved: { ...binding, replyToMessageId: 789, maximumTextBytes: 4096, taskReplyPolicy: "standalone-if-exact-missing" }, reply,
    store: createEncryptedPilotStore(join(f.directories.pilot, slot), passphrase), signal: new AbortController().signal, killSwitchEngaged: () => false,
    transport: { async sendOnce() { return { messageId: 800 }; }, async readExact() { return { ...reply, replyToMessageId: null,
      taskReplyOriginMessageId: 789, accountId: binding.accountId, messageId: 800 }; } } });
  assert.equal(result.state, "verified");
  const reader = await f.openReader(), reopened = await reader.read({ family: "pilot", slot });
  assert.equal(reopened.status, "ready"); assert.equal(reopened.view?.verdict, "verified"); assert.equal(reopened.view?.identityKnown, true);
});

test("actual encrypted producers for every family yield bounded metadata views without raw capabilities", async t => {
  const f = await fixture(t), reader = await f.openReader();
  for (const produce of producers) {
    const source = await produce(f), result = await reader.read({ family: source.family, slot: source.slot });
    assert.equal(result.status, "ready", source.family); assert.equal(result.view?.verdict, "verified"); assert.equal(result.view?.currentAvailability, "not-checked");
    assert.match(result.view!.actionRef, /^act_[0-9a-f]{48}$/); const encoded = JSON.stringify(result);
    for (const raw of ["accountId", "chatId", "messageId", "photoId", "documentId", "artifactRef", "randomId", "passphrase", "synthetic-request"]) assert.equal(encoded.includes(raw), false, raw);
  }
});

test("UNKNOWN real producer terminals remain unverified in all four families", async t => {
  const f = await fixture(t), reader = await f.openReader();
  for (const produce of producers) {
    const source = await produce(f, true), result = await reader.read({ family: source.family, slot: source.slot });
    assert.equal(result.status, "ready", source.family); assert.equal(result.view?.verdict, "unknown"); assert.equal(result.view?.effect, "not-proven"); assert.equal(result.view?.identityKnown, false);
  }
});

test("pilot text joins only an authenticated matching encrypted dialogue outcome including formatting", async t => {
  const f = await fixture(t), source = await producePilot(f, false, true), reader = await f.openReader();
  const result = await reader.read({ family: source.family, slot: source.slot }); assert.equal(result.status, "ready"); assert.deepEqual(result.view?.content, { kind: "text", text: source.reply.text });
  assert.ok(result.view!.gaps.includes("formatting-not-projected"));
  const path = join(f.directories.dialogues, "0000000789.outcome.enc"); await writeFile(path, "retained corrupt dialogue outcome");
  const corrupt = await reader.read({ family: source.family, slot: source.slot }); assert.notEqual(corrupt.view?.content.kind === "text" ? corrupt.view.content.text : null, source.reply.text);
});

test("actual pre-dispatch terminal joins not-sent dialogue while incompatible diagnostics cannot supply text", async t => {
  const f = await fixture(t), slot = randomUUID(), reply: PilotReply = { chatId: binding.chatId, replyToMessageId: 789, text: "Synthetic unsent reply" };
  const result = await runPilotReply({ approved: { ...binding, replyToMessageId: 789, maximumTextBytes: 4096 }, reply,
    store: createEncryptedPilotStore(join(f.directories.pilot, slot), passphrase), signal: new AbortController().signal, killSwitchEngaged: () => false,
    transport: { async sendOnce() { throw new PilotPreDispatchError(); }, async readExact() { assert.fail("pre-dispatch refusal must not read back"); } } });
  assert.equal(result.state, "failed_terminal"); assert.equal(result.deliveryDiagnostic, "pre-dispatch-refused");
  const journal = await openStandingDialogueJournal({ directory: f.directories.dialogues, passphrase, binding: { accountId: binding.accountId, peerId: binding.chatId } });
  try {
    const claim = await journal.recordQuestion({ primary: { chatId: binding.chatId, ownerId: "456", messageId: 789, text: "Synthetic question" } });
    await journal.recordOutcome({ key: claim.key, delivery: "not-sent", kind: "model", answer: reply.text, deliveryDiagnostic: "pre-dispatch-refused" });
  } finally { journal.close(); }
  const reader = await f.openReader(), first = await reader.read({ family: "pilot", slot });
  assert.equal(first.status, "ready"); assert.equal(first.view?.verdict, "failed-terminal");
  assert.deepEqual(first.view?.content, { kind: "text", text: reply.text });
  const path = join(f.directories.dialogues, "0000000789.outcome.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), passphrase));
  for (const patch of [{ delivery: "verified" }, { delivery: "unknown" }, { deliveryDiagnostic: "send" }]) {
    await writeFile(path, await encryptSession(JSON.stringify({ ...original, payload: { ...original.payload, ...patch } }), passphrase));
    const invalid = await reader.read({ family: "pilot", slot });
    assert.ok(invalid.gaps.includes("text-join-unavailable"));
    assert.notDeepEqual(invalid.view?.content, { kind: "text", text: reply.text });
  }
});

test("missing parents and slots remain absent without directory creation", async t => {
  const f = await fixture(t, false), reader = await f.openReader();
  for (const family of ["pilot", "generated-image", "artifact", "bound-action"] as const) {
    const result = await reader.read({ family, slot: family === "pilot" ? randomUUID() : "1".repeat(64) }); assert.equal(result.status, "absent");
  }
  assert.deepEqual(await readdir(f.root), []);
});

test("legacy media terminal without additive metadata is explicit and does not load the encrypted artifact", async t => {
  const f = await fixture(t), reader = await f.openReader();
  for (const produce of [produceImage, produceArtifact]) {
    const source = await produce(f); await unlink(join(source.directory, "metadata.enc"));
    const result = await reader.read({ family: source.family, slot: source.slot }); assert.equal(result.status, "legacy"); assert.equal(result.view, undefined);
    assert.ok(result.gaps.length > 0);
  }
});

test("poisoned artifact payload does not prevent a metadata-only historical view or imply present availability", async t => {
  const f = await fixture(t), reader = await f.openReader();
  for (const produce of [produceImage, produceArtifact]) {
    const source = await produce(f); await writeFile(join(source.directory, "artifact.enc"), "intentionally unreadable private artifact blob");
    const result = await reader.read({ family: source.family, slot: source.slot }); assert.equal(result.status, "ready"); assert.equal(result.view?.verdict, "verified"); assert.equal(result.view?.currentAvailability, "not-checked");
  }
});

test("copied pilot chains across UUID directories have one canonical action reference", async t => {
  const f = await fixture(t), source = await producePilot(f), reader = await f.openReader(), copied = randomUUID(), target = join(f.directories.pilot, copied);
  await mkdir(target); for (const name of await readdir(source.directory)) await copyFile(join(source.directory, name), join(target, name));
  const first = await reader.read({ family: source.family, slot: source.slot }), second = await reader.read({ family: "pilot", slot: copied });
  assert.equal(first.status, "ready"); assert.equal(second.status, "ready"); assert.equal(first.view?.actionRef, second.view?.actionRef);
});

test("corrupt ciphertext, foreign bindings and moved keyed slots cannot produce a view", async t => {
  const f = await fixture(t), source = await produceArtifact(f), reader = await f.openReader();
  const moved = "f".repeat(64), target = join(f.directories.artifacts, moved); await mkdir(target);
  for (const name of await readdir(source.directory)) await copyFile(join(source.directory, name), join(target, name));
  assert.equal((await reader.read({ family: "artifact", slot: moved })).status, "unavailable");
  const foreign = await openStandingOwnActionReader({ ...f.args, binding: { ...binding, accountId: "124" } });
  try { assert.equal((await foreign.read({ family: source.family, slot: source.slot })).status, "unavailable"); } finally { await foreign.close(); }
  await writeFile(join(source.directory, "terminal.enc"), "retained corrupt terminal"); assert.equal((await reader.read({ family: source.family, slot: source.slot })).status, "unavailable");
});

test("unexpected entries and linked ciphertext are rejected without changing the retained files", async t => {
  const f = await fixture(t), source = await producePilot(f), reader = await f.openReader(), original = await readFile(join(source.directory, "terminal.enc"));
  await writeFile(join(source.directory, "unexpected.enc"), "unknown entry"); assert.equal((await reader.read({ family: source.family, slot: source.slot })).status, "unavailable");
  await unlink(join(source.directory, "unexpected.enc"));
  const linked = join(f.root, "linked-terminal.enc"); await link(join(source.directory, "terminal.enc"), linked);
  assert.equal((await reader.read({ family: source.family, slot: source.slot })).status, "unavailable"); assert.deepEqual(await readFile(linked), original);
});

test("factory and read reject executable getters, proxies and traversal slots without invoking them", async t => {
  const f = await fixture(t); let invoked = 0;
  await assert.rejects(openStandingOwnActionReader({ ...f.args, get directories() { invoked++; return f.directories; } }));
  const reader = await f.openReader();
  for (const value of [{ family: "pilot", get slot() { invoked++; return randomUUID(); } },
    new Proxy({ family: "pilot", slot: randomUUID() }, { getOwnPropertyDescriptor() { invoked++; throw Error("trap"); } }),
    { family: "pilot", slot: "../escape" }, { family: "pilot", slot: randomUUID(), extra: true }]) {
    await assert.rejects(async () => reader.read(value as Parameters<Handle["read"]>[0]));
  }
  assert.equal(invoked, 0);
});

test("close joins admitted reads and revokes future use; aborted reader cannot return a late view", async t => {
  for (const abort of [false, true]) {
    const f = await fixture(t), source = await produceImage(f), signal = new AbortController(), reader = await openStandingOwnActionReader({ ...f.args, signal: signal.signal });
    let settled = false, cryptoStarted = false, started!: () => void;
    const cryptoBeginning = new Promise<void>(resolve => { started = resolve; });
    // Observe real Node crypto work without replacing any source capability.
    const hook = createHook({ init(_id, type) { if (type === "SCRYPTREQUEST") { cryptoStarted = true; started(); } } }).enable();
    try {
      const pending = reader.read({ family: source.family, slot: source.slot }).then(value => { settled = true; return value; }, () => { settled = true; return undefined; });
      await Promise.race([cryptoBeginning, pending]); assert.equal(cryptoStarted, true); hook.disable();
      if (abort) signal.abort(); const closing = reader.close(); assert.equal(settled, false);
      await closing; assert.equal(settled, true); assert.equal(await pending, undefined);
      await assert.rejects(async () => reader.read({ family: source.family, slot: source.slot }));
    } finally { hook.disable(); await reader.close(); }
  }
});

test("parent path replacement after reader open cannot silently substitute another source tree", async t => {
  const f = await fixture(t), source = await producePilot(f), reader = await f.openReader();
  const original = resolve(f.directories.pilot), moved = resolve(join(f.root, "retained-original-pilot"));
  assert.equal(original, join(resolve(f.root), "pilot")); assert.equal(moved, join(resolve(f.root), "retained-original-pilot"));
  await rename(original, moved); await mkdir(original);
  const status = await reader.read({ family: source.family, slot: source.slot }); assert.notEqual(status.status, "ready"); assert.equal(status.view, undefined);
});

test("actual persisted poll journal evidence supplies only its opaque object reference and observation time", async t => {
  const f = await fixture(t), actionBinding = { ...binding, primaryMessageId: 789, operationSlot: 0 }, poll = { question: "Synthetic poll?", options: ["One", "Two"], anonymous: true, type: "single" as const };
  const journal = await openStandingActionJournal({ directory: f.directories.actions, passphrase, binding: actionBinding });
  try {
    await journal.reserve({ requestRef: "synthetic-poll", randomId: "123456789", action: { kind: "create-poll", poll } });
    await journal.append({ state: "verified", result: { verdict: "verified", code: "verified" }, privateObjectEvidence: { schema: "standing-poll-object-v1", kind: "poll", objectRef: "obj_" + "a".repeat(48), observedAt: 1789065600,
      record: { schema: "owned-bound-poll-v1", operationId: "bound-action-123456789", randomId: "123456789", ...binding, replyToMessageId: 789, messageId: 803, pollId: "-9223372036854775808", poll } } });
  } finally { await journal.close(); }
  const reader = await f.openReader(), result = await reader.read({ family: "bound-action", slot: standingActionKey(actionBinding) });
  assert.equal(result.status, "ready"); assert.equal(result.view?.objectRef, "obj_" + "a".repeat(48)); assert.equal(result.view?.observedAt, 1789065600);
  assert.equal(result.view?.identityKnown, true); assert.equal(result.view?.currentAvailability, "not-checked");
  assert.deepEqual(result.view?.content, { kind: "poll", question: poll.question, options: poll.options }); assert.equal(JSON.stringify(result).includes("-9223372036854775808"), false);
});

test("a genuine pilot sending prefix is incomplete without inventing a verified terminal", async t => {
  const f = await fixture(t), source = await producePilot(f), slot = randomUUID(), target = join(f.directories.pilot, slot);
  await mkdir(target); for (const name of ["planned.enc", "sending.enc"]) await copyFile(join(source.directory, name), join(target, name));
  const reader = await f.openReader(), result = await reader.read({ family: "pilot", slot });
  assert.equal(result.status, "incomplete"); assert.notEqual(result.view?.verdict, "verified"); assert.equal(result.view?.effect === "changed", false);
  assert.deepEqual((await readdir(target)).sort(), ["planned.enc", "sending.enc"]);
});

test("a new slot entry introduced during actual decryption invalidates the final view", async t => {
  const f = await fixture(t), source = await produceImage(f), reader = await f.openReader(), path = join(source.directory, "late-entry.enc");
  let injected = 0;
  const hook = createHook({ init(_id, type) {
    if (type === "SCRYPTREQUEST" && injected === 0) { injected++; writeFileSync(path, "retained entry added during decrypt"); }
  } }).enable();
  try {
    const result = await reader.read({ family: source.family, slot: source.slot });
    assert.equal(injected, 1); assert.equal(result.status, "unavailable"); assert.equal(result.view, undefined);
  } finally { hook.disable(); }
  assert.equal(await readFile(path, "utf8"), "retained entry added during decrypt");
});
