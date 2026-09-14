import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStandingArtifactRuntime, type StandingArtifactRuntimePorts } from "../src/standing-artifact-runtime.js";
import { openEncryptedArtifactOutbox, artifactDeliveryKey, type ArtifactDeliveryApproval } from "../src/standing-artifact-outbox.js";
import type { StandingArtifactTransportLease } from "../src/standing-conversation-adapter.js";
import { ArtifactTransportError, type ArtifactSendInput } from "../src/standing-artifact-telegram.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { STANDING_AVATAR_MAX_BYTES } from "../src/standing-avatar-policy.js";

const passphrase = "synthetic-artifact-runtime-passphrase";
const binding = { accountId: "123", peerId: "-456" };
const primary = { chatId: binding.peerId, ownerId: "789", messageId: 12, text: "synthetic request" };
const contents = Buffer.from("synthetic PRIVATE file bytes");
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: TestContext, payload = contents, mimeType = "text/plain") {
  const stateDirectory = await mkdtemp(join(resolve(tmpdir()), "artifact-runtime-"));
  t.after(async () => { assert.ok(stateDirectory.startsWith(join(resolve(tmpdir()), "artifact-runtime-"))); await rm(stateDirectory, { recursive: true, force: true }); });
  const controller = new AbortController(), events: string[] = []; let sent: ArtifactSendInput | undefined, sentBytes: Buffer | undefined, sends = 0, leases = 0, killed = false;
  const fetch: NonNullable<StandingArtifactRuntimePorts["fetch"]> = {
    async resolve() { events.push("dns"); return [{ address: "8.8.8.8", family: 4 }]; },
    request() { events.push("fetch"); return { response: Promise.resolve({ statusCode: 200,
      rawHeaders: ["content-type", mimeType, "content-length", String(payload.length)],
      body: (async function* () { yield payload; })() }), settled: Promise.resolve(), destroy() { events.push("fetch-close"); } }; },
  };
  const lease = (): StandingArtifactTransportLease => {
    leases++; events.push("lease");
    return { transport: {
      async sendOnce(value) { sends++; sent = value; sentBytes = Buffer.from(value.bytes); events.push("send"); return { messageId: 22, documentId: "33" }; },
      async readExact() { events.push("read"); return { messageId: 22, documentId: "33", chatId: binding.peerId, accountId: binding.accountId,
        replyToMessageId: primary.messageId, caption: sent!.caption, filename: sent!.filename, mimeType: sent!.mimeType,
        byteLength: sent!.bytes.length, ...(sent!.audio ? { audio: sent!.audio } : {}) }; },
    }, async close() { events.push("lease-close"); } };
  };
  const create = (ports: StandingArtifactRuntimePorts = {}) => createStandingArtifactRuntime({ stateDirectory, passphrase, binding,
    signal: controller.signal, killed: () => killed, ports: { fetch, ...ports } });
  return { create, controller, stateDirectory, events, fetch, lease, sent: () => sent, sentBytes: () => sentBytes, sends: () => sends, leases: () => leases, kill: () => { killed = true; } };
}
function caller(runtime: ReturnType<typeof createStandingArtifactRuntime>, requestRef = "epoch-request-1") {
  let number = 0; const signal = new AbortController().signal;
  return async (name: string, args: unknown) => {
    const value = await runtime.handlers.find(h => h.name === name)!.call(args, { requestRef, callRef: "call-" + ++number, signal }) as EpochToolResult;
    return { success: value.success, ...JSON.parse(value.contentItems[0].text) };
  };
}
async function fetchArtifact(call: ReturnType<typeof caller>) { return call("neurobro_fetch_artifact", { url: "https://files.public.net/file.txt", filename: "file.txt" }); }
async function createTextArtifact(call: ReturnType<typeof caller>, filename = "notes.txt", text = "synthetic text\n") {
  return call("neurobro_create_text_file", { filename, text });
}
const planGeneratedImageUse = (call: ReturnType<typeof caller>, target: "self-avatar" | "group-avatar") =>
  call("neurobro_plan_generated_image_use", { target });
const sendArtifact = (call: ReturnType<typeof caller>, artifactRef: string) => call("neurobro_send_artifact", { artifactRef, caption: "synthetic caption", mediaKind: "file" });

test("host import of a saved generated image creates fresh request-scoped refs and retains an isolated profile copy", async t => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const origin = { requestRef: "old-request", threadId: "old-thread", turnId: "old-turn", itemId: "old-item" };
  const generated = createGeneratedImageRegistry({ requestRef: origin.requestRef, threadId: origin.threadId, turnId: origin.turnId });
  const image = generated.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: png.toString("base64") });
  const f = await fixture(t), runtime = f.create();
  assert.throws(() => runtime.importGeneratedImage("fresh", image, png));
  runtime.begin({ requestRef: "fresh", primary, openArtifactTransport: f.lease });
  assert.throws(() => runtime.importGeneratedImage("old-request", image, png));
  assert.throws(() => runtime.importGeneratedImage("fresh", { ...image, sha256: "0".repeat(64) }, png));
  const imported = runtime.importGeneratedImage("fresh", image, png);
  assert.match(imported.ref, /^art_[a-f0-9]{48}$/); assert.equal(imported.source.kind, "generated");
  const original = Buffer.from(png); png.fill(0); generated.close();
  const copy = runtime.copyProfileImage("fresh", imported.ref);
  assert.deepEqual(copy.bytes, original); copy.bytes.fill(0);
  await runtime.finish();
  runtime.begin({ requestRef: "next", primary: { ...primary, messageId: 13 }, openArtifactTransport: f.lease });
  assert.throws(() => runtime.copyProfileImage("next", imported.ref));
  const next = runtime.importGeneratedImage("next", image, original); assert.notEqual(next.ref, imported.ref);
  await runtime.close(); assert.throws(() => runtime.importGeneratedImage("next", image, original));
  original.fill(0); assert.equal(f.sends(), 0); assert.equal(f.leases(), 0);
});

test("profile image copy is restricted to current request, image MIME and size; copied bytes are isolated", async t => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=", "base64");
  const f = await fixture(t, png, "image/png"), runtime = f.create();
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  const fetched = await fetchArtifact(caller(runtime)); assert.equal(fetched.success, true);
  assert.throws(() => runtime.copyProfileImage("foreign", fetched.artifactRef));
  const copy = runtime.copyProfileImage("epoch-request-1", fetched.artifactRef);
  assert.equal(copy.mediaType, "image/png"); assert.deepEqual(copy.bytes, png);
  copy.bytes.fill(0);
  const again = runtime.copyProfileImage("epoch-request-1", fetched.artifactRef);
  assert.deepEqual(again.bytes, png); again.bytes.fill(0);
  await runtime.finish(); assert.throws(() => runtime.copyProfileImage("epoch-request-1", fetched.artifactRef));
  runtime.begin({ requestRef: "epoch-request-2", primary: { ...primary, messageId: 13 }, openArtifactTransport: f.lease });
  assert.throws(() => runtime.copyProfileImage("epoch-request-2", fetched.artifactRef));
  await runtime.close(); assert.equal(f.sends(), 0);
});

test("profile resolver rejects general files and oversized images without Telegram", async t => {
  for (const [payload, mime] of [[contents, "text/plain"], [Buffer.alloc(STANDING_AVATAR_MAX_BYTES + 1), "image/png"]] as const) {
    const f = await fixture(t, payload, mime), runtime = f.create();
    runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
    const fetched = await fetchArtifact(caller(runtime)); assert.equal(fetched.success, true);
    assert.throws(() => runtime.copyProfileImage("epoch-request-1", fetched.artifactRef));
    await runtime.close(); assert.equal(f.sends(), 0);
  }
});

test("profile resolver admits an isolated exact 8 MiB current-request image copy", async t => {
  const payload = Buffer.alloc(STANDING_AVATAR_MAX_BYTES, 65), f = await fixture(t, payload, "image/png"), runtime = f.create();
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  const fetched = await fetchArtifact(caller(runtime)); assert.equal(fetched.success, true);
  const copy = runtime.copyProfileImage("epoch-request-1", fetched.artifactRef);
  assert.equal(copy.bytes.byteLength, STANDING_AVATAR_MAX_BYTES); assert.notEqual(copy.bytes, payload); copy.bytes.fill(0);
  await runtime.close(); assert.equal(f.sends(), 0);
});

test("actual fetch registry and encrypted outbox deliver exact file; close preserves encrypted state", async t => {
  const f = await fixture(t), runtime = f.create(); runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  const call = caller(runtime), fetched = await fetchArtifact(call); assert.equal(fetched.success, true);
  const value = await sendArtifact(call, fetched.artifactRef); assert.equal(value.verdict, "verified"); assert.equal(value.messageId, 22);
  assert.equal(f.sends(), 1); assert.equal(f.leases(), 1); assert.ok(f.events.indexOf("read") < f.events.indexOf("lease-close"));
  assert.ok(f.sent()!.bytes.every(v => v === 0)); assert.deepEqual(runtime.state(), { active: true, blocked: false, closed: false, operationSlots: 1 });
  const approved: ArtifactDeliveryApproval = { accountId: binding.accountId, chatId: binding.peerId, replyToMessageId: primary.messageId, operationSlot: 0, requestRef: "epoch-request-1" };
  const store = await openEncryptedArtifactOutbox({ directory: join(f.stateDirectory, "artifact-outbox"), passphrase, approved });
  assert.equal((await store.inspect()).delivery, "verified"); store.close();
  for (const file of await readdir(join(f.stateDirectory, "artifact-outbox", artifactDeliveryKey(approved)))) {
    assert.equal((await readFile(join(f.stateDirectory, "artifact-outbox", artifactDeliveryKey(approved), file), "utf8")).includes("PRIVATE"), false);
  }
  await runtime.finish(); assert.equal(runtime.state().active, false); assert.equal((await sendArtifact(call, fetched.artifactRef)).success, false); await runtime.close();
});

test("memory-only text creation feeds the existing send path and finish revokes its request ref", async t => {
  const f = await fixture(t), runtime = f.create();
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  const call = caller(runtime), text = "# Unicode\n\nПривет,\tмир\r\n", created = await createTextArtifact(call, "report.md", text);
  assert.equal(created.success, true); assert.equal(created.schema, "neurobro-artifact-create-text-v1");
  assert.equal(created.filename, "report.md"); assert.equal(created.mimeType, "text/markdown"); assert.equal(created.byteLength, Buffer.byteLength(text));
  assert.equal(created.sha256, createHash("sha256").update(Buffer.from(text)).digest("hex"));
  assert.equal(f.events.length, 0); assert.equal(f.leases(), 0);
  const delivered = await sendArtifact(call, created.artifactRef); assert.equal(delivered.verdict, "verified"); assert.equal(delivered.messageId, 22);
  assert.equal(f.events.includes("dns"), false); assert.equal(f.events.includes("fetch"), false);
  assert.equal(f.sent()!.filename, "report.md"); assert.equal(f.sent()!.mimeType, "text/markdown");
  assert.deepEqual(f.sentBytes(), Buffer.from(text));
  assert.ok(f.sent()!.bytes.every(value => value === 0));
  await runtime.finish(); assert.equal((await sendArtifact(call, created.artifactRef)).success, false);
  runtime.begin({ requestRef: "epoch-request-2", primary: { ...primary, messageId: 13 }, openArtifactTransport: f.lease });
  assert.equal((await sendArtifact(caller(runtime, "epoch-request-2"), created.artifactRef)).success, false);
  await runtime.close();
});

test("generated-image use plan is request-bound, immutable, consumed once and cleared at finish", async t => {
  const f = await fixture(t), runtime = f.create();
  assert.equal(runtime.takeGeneratedImageUse("epoch-request-1"), undefined);
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  const call = caller(runtime), planned = await planGeneratedImageUse(call, "self-avatar");
  assert.deepEqual(planned, { success: true, schema: "neurobro-generated-image-use-v1", status: "pending", target: "self-avatar" });
  assert.equal(f.events.length, 0); assert.equal(f.leases(), 0); assert.equal(f.sends(), 0);
  assert.equal(runtime.takeGeneratedImageUse("foreign"), undefined);
  assert.equal((await planGeneratedImageUse(call, "self-avatar")).success, false);
  assert.equal((await planGeneratedImageUse(call, "group-avatar")).success, false);
  assert.equal(runtime.takeGeneratedImageUse("epoch-request-1"), "self-avatar");
  assert.equal(runtime.takeGeneratedImageUse("epoch-request-1"), undefined);
  assert.equal((await planGeneratedImageUse(call, "group-avatar")).success, false);
  await runtime.finish(); assert.equal(runtime.takeGeneratedImageUse("epoch-request-1"), undefined);

  runtime.begin({ requestRef: "epoch-request-2", primary: { ...primary, messageId: 13 }, openArtifactTransport: f.lease });
  assert.equal((await planGeneratedImageUse(caller(runtime, "epoch-request-2"), "group-avatar")).success, true);
  await runtime.finish(); assert.equal(runtime.takeGeneratedImageUse("epoch-request-2"), undefined);

  runtime.begin({ requestRef: "epoch-request-3", primary: { ...primary, messageId: 14 }, openArtifactTransport: f.lease });
  const stopped = new AbortController(), handler = runtime.handlers.find(value => value.name === "neurobro_plan_generated_image_use")!;
  const result = await handler.call({ target: "self-avatar" }, { requestRef: "epoch-request-3", callRef: "plan-abort", signal: stopped.signal }) as EpochToolResult;
  assert.equal(result.success, true); stopped.abort();
  assert.equal(runtime.takeGeneratedImageUse("epoch-request-3"), undefined);
  await runtime.close(); assert.equal(runtime.takeGeneratedImageUse("epoch-request-3"), undefined);
  assert.equal(f.events.length, 0); assert.equal(f.leases(), 0); assert.equal(f.sends(), 0);
});

test("stable handlers scope each fresh turn and refuse overlap, foreign scopes and stale refs", async t => {
  const f = await fixture(t), runtime = f.create(), handlers = runtime.handlers;
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  assert.throws(() => runtime.begin({ requestRef: "overlap", primary, openArtifactTransport: f.lease }));
  assert.equal((await fetchArtifact(caller(runtime, "foreign"))).success, false); assert.equal(f.events.length, 0);
  const old = await fetchArtifact(caller(runtime)); await runtime.finish();
  runtime.begin({ requestRef: "epoch-request-2", primary: { ...primary, messageId: 13 }, openArtifactTransport: f.lease });
  assert.equal(runtime.handlers, handlers); assert.equal((await sendArtifact(caller(runtime, "epoch-request-2"), old.artifactRef)).success, false);
  await runtime.close(); assert.throws(() => runtime.begin({ requestRef: "after", primary, openArtifactTransport: f.lease }));
});

test("stable primary slot blocks replay under another native epoch and cannot advance to bypass consumed slot", async t => {
  const f = await fixture(t), runtime = f.create(); runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  const call = caller(runtime), first = await fetchArtifact(call); assert.equal((await sendArtifact(call, first.artifactRef)).verdict, "verified"); await runtime.close();
  const next = f.create(); next.begin({ requestRef: "epoch-request-2", primary, openArtifactTransport: f.lease });
  const nextCall = caller(next, "epoch-request-2"), fresh = await fetchArtifact(nextCall);
  assert.equal((await sendArtifact(nextCall, fresh.artifactRef)).verdict, "refused"); assert.equal(next.state().blocked, true);
  assert.equal((await sendArtifact(nextCall, fresh.artifactRef)).success, false); assert.equal(f.sends(), 1); assert.equal(next.state().operationSlots, 1); await next.close();
});

test("unknown readback revokes later sends while returning a truthful unknown result", async t => {
  const f = await fixture(t), runtime = f.create();
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: () => { const lease = f.lease(); return { ...lease, transport: { ...lease.transport, readExact: async () => null } }; } });
  const call = caller(runtime), file = await fetchArtifact(call);
  assert.equal((await planGeneratedImageUse(call, "group-avatar")).success, true);
  const result = await sendArtifact(call, file.artifactRef);
  assert.equal(result.verdict, "unknown"); assert.equal(result.success, false); assert.equal(result.messageId, undefined);
  assert.equal(runtime.state().blocked, true); assert.equal(runtime.takeGeneratedImageUse("epoch-request-1"), undefined);
  await sendArtifact(call, file.artifactRef); assert.equal(f.sends(), 1);
  await runtime.finish(); assert.throws(() => runtime.begin({ requestRef: "retry", primary, openArtifactTransport: f.lease })); await runtime.close();
});

test("settled pre-dispatch failure stays consumed without poisoning later user requests", async t => {
  const f = await fixture(t), runtime = f.create();
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: () => {
    const lease = f.lease(); return { ...lease, transport: { ...lease.transport,
      async sendOnce() { throw new ArtifactTransportError({ stage: "upload", reason: "invoke" }); } } };
  } });
  const call = caller(runtime), file = await createTextArtifact(call);
  const outcome = await sendArtifact(call, file.artifactRef);
  assert.equal(outcome.success, false); assert.equal(outcome.verdict, "failed_terminal");
  assert.equal(runtime.state().blocked, false); assert.equal(f.sends(), 0);
  await runtime.finish();
  const reopened = await openEncryptedArtifactOutbox({ directory: join(f.stateDirectory, "artifact-outbox"), passphrase,
    approved: { accountId: binding.accountId, chatId: binding.peerId, replyToMessageId: primary.messageId, operationSlot: 0, requestRef: "epoch-request-1" } });
  const persisted = await reopened.inspect(); assert.equal(persisted.delivery, "failed_terminal");
  assert.equal(persisted.failure?.reason, "pre-dispatch-refused"); reopened.close();
  runtime.begin({ requestRef: "epoch-request-2", primary: { ...primary, messageId: primary.messageId + 1 }, openArtifactTransport: () => {
    const lease = f.lease(); return { ...lease, transport: { ...lease.transport,
      async readExact(chatId, messageId, signal) { return { ...await lease.transport.readExact(chatId, messageId, signal), replyToMessageId: primary.messageId + 1 } as Awaited<ReturnType<typeof lease.transport.readExact>>; } } };
  } });
  const nextCall = caller(runtime, "epoch-request-2"), nextFile = await createTextArtifact(nextCall);
  assert.equal((await sendArtifact(nextCall, nextFile.artifactRef)).verdict, "verified"); await runtime.close();
  const retry = f.create(); retry.begin({ requestRef: "epoch-request-3", primary, openArtifactTransport: f.lease });
  const retryCall = caller(retry, "epoch-request-3"), retryFile = await createTextArtifact(retryCall);
  assert.equal((await sendArtifact(retryCall, retryFile.artifactRef)).verdict, "refused");
  assert.equal(f.sends(), 1); await retry.close();
});

test("abort and finish join real pending upload before lease release and bytes zeroing", async t => {
  const f = await fixture(t), runtime = f.create(), entered = deferred(), release = deferred(); let held: Buffer | undefined;
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: () => { const lease = f.lease(); return { ...lease, transport: { ...lease.transport,
    async sendOnce(value, signal) { held = value.bytes; entered.resolve(); await release.promise; return lease.transport.sendOnce(value, signal); },
  } }; } });
  const call = caller(runtime), file = await fetchArtifact(call), work = sendArtifact(call, file.artifactRef); await entered.promise;
  let finished = false; const finish = runtime.finish().then(() => { finished = true; }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.equal(f.events.includes("lease-close"), false); assert.deepEqual(held, contents);
  release.resolve(); await work; await finish; assert.ok(held!.every(v => v === 0)); assert.equal(runtime.state().blocked, true); assert.equal(f.events.includes("read"), false); await runtime.close();
});

test("close waits for download request settlement before releasing registry", async t => {
  const f = await fixture(t), response = deferred(), settled = deferred(), entered = deferred();
  const runtime = f.create({ fetch: { ...f.fetch, request: (_url, _address, signal) => { entered.resolve(); signal.addEventListener("abort", () => response.resolve(), { once: true }); return {
    response: response.promise.then(() => ({ statusCode: 200, rawHeaders: ["content-type", "text/plain"], body: (async function* () { yield contents; })() })),
    settled: settled.promise, destroy() { response.resolve(); },
  }; } } });
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  const work = fetchArtifact(caller(runtime)); await entered.promise; let closed = false;
  const close = runtime.close().then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  settled.resolve(); await close; assert.equal((await work).success, false); assert.equal(runtime.state().active, false);
});

test("host STOP refuses new calls and invalid binding never opens a lease", async t => {
  const f = await fixture(t), runtime = f.create(); assert.throws(() => runtime.begin({ requestRef: "x", primary: { ...primary, chatId: "-99" }, openArtifactTransport: f.lease }));
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease }); const call = caller(runtime), file = await fetchArtifact(call);
  f.kill(); assert.equal((await sendArtifact(call, file.artifactRef)).success, false); assert.equal(f.leases(), 0); await runtime.close();
});

test("lease/store cleanup failures are private unknowns and block further admission", async t => {
  const f = await fixture(t), runtime = f.create({ openOutbox: async () => { throw new Error("PRIVATE credentials path"); } });
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease }); const call = caller(runtime), file = await fetchArtifact(call);
  const result = await sendArtifact(call, file.artifactRef); assert.equal(result.verdict, "unknown"); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(f.events.includes("lease-close"), true); assert.equal(runtime.state().blocked, true); await runtime.close();
});

test("host assigns at most32 action slots and rejects model-selected slots before transport", async t => {
  const f = await fixture(t), slots: number[] = [];
  const runtime = f.create({ openOutbox: async input => { slots.push(input.approved.operationSlot); return {
    async reserve(plan) { assert.equal(plan.approved.operationSlot, input.approved.operationSlot); assert.equal(plan.approved.replyToMessageId, primary.messageId); },
    async append() {}, async inspect() { return { delivery: "absent" as const }; }, close() {},
  }; } });
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: f.lease });
  const call = caller(runtime), file = await fetchArtifact(call);
  assert.equal((await call("neurobro_send_artifact", { artifactRef: file.artifactRef, caption: "x", operationSlot: 31 })).success, false); assert.equal(f.leases(), 0);
  for (let i = 0; i < 32; i++) assert.equal((await sendArtifact(call, file.artifactRef)).verdict, "verified");
  assert.deepEqual(slots, Array.from({ length: 32 }, (_, i) => i));
  assert.equal((await sendArtifact(call, file.artifactRef)).verdict, "refused"); assert.equal(f.sends(), 32); assert.equal(f.leases(), 32); await runtime.close();
});

test("lease cleanup failure suppresses previously verified delivery outcome and poisons runtime", async t => {
  const f = await fixture(t), runtime = f.create();
  runtime.begin({ requestRef: "epoch-request-1", primary, openArtifactTransport: () => ({ ...f.lease(), async close() { throw new Error("PRIVATE teardown"); } }) });
  const call = caller(runtime), file = await fetchArtifact(call), result = await sendArtifact(call, file.artifactRef);
  assert.equal(result.verdict, "unknown"); assert.equal(result.messageId, undefined); assert.equal(runtime.state().blocked, true);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false); await runtime.close();
});
