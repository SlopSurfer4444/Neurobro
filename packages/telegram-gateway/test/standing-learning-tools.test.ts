import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingLearningStore, type StandingLearningStore } from "../src/standing-learning-store.js";
import { createStandingLearningTools, requireStandingLearningSnapshot, STANDING_LEARNING_TOOL_NAME, STANDING_LEARNING_TOOL_SPEC } from "../src/standing-learning-tools.js";
import { createStandingNamedToolDispatcher } from "../src/standing-tool-dispatcher.js";

const signal = new AbortController().signal;
const args = { action: "save", key: "reply.style", expectedRevision: null, kind: "preference", scope: "self",
  text: "Keep replies concise and friendly.", query: null } as const;
const scope = { requestRef: "request-1", callRef: "call-1", signal };
const parse = (value: unknown) => JSON.parse((value as { contentItems: readonly { text: string }[] }).contentItems[0]!.text);

test("fixed tool saves idempotently and issues bounded primary-authentic fallback snapshots", async t => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-learning-tools-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-learning-tools-"))); await rm(root, { recursive: true, force: true }); });
  const storeArgs = { directory: join(root, "learning"), passphrase: "synthetic-learning-tools-passphrase",
    binding: { accountId: "123", peerId: "-100456" }, workspaceId: "community-team" };
  let store = await openStandingLearningStore(storeArgs);
  let primary = { actorId: "789", requestRef: "request-1", messageId: 101 }, tools = createStandingLearningTools({ store, primary, signal });
  try {
    assert.equal(STANDING_LEARNING_TOOL_NAME, "neurobro_memory"); assert.equal(STANDING_LEARNING_TOOL_SPEC.inputSchema.required.length, 7);
    const saved = parse(await tools.handlers[0]!.call(args, scope));
    assert.equal(saved.state, "saved"); assert.equal(saved.revision, 1); assert.equal(saved.idempotent, false); assert.equal(saved.telegramAction, "none");
    assert.equal(parse(await tools.handlers[0]!.call(args, scope)).idempotent, true);
    const duplicate = parse(await tools.handlers[0]!.call({ ...args, key: "other.style", text: args.text.toUpperCase() },
      { ...scope, callRef: "duplicate" }));
    assert.equal(duplicate.code, "duplicate-candidate"); assert.equal(duplicate.persistence, "no-new-write");
    assert.equal(duplicate.candidate.key, args.key);
    const inventory = parse(await tools.handlers[0]!.call({ action: "read", key: null, expectedRevision: null,
      kind: null, scope: null, text: null, query: null }, { ...scope, callRef: "inventory" }));
    assert.equal(inventory.capacity.notes.active, 1); assert.equal(inventory.notes.length, 1);
    const snapshot = await tools.snapshot({ query: "no lexical overlap" });
    assert.equal(snapshot.coverage.selection, "recent-fallback"); assert.equal(snapshot.notes[0]!.key, "reply.style");
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 6144);
    assert.equal(snapshot.capacity.formatLimits.hotSlotsMaximum, 256);
    assert.equal(requireStandingLearningSnapshot(snapshot, primary), snapshot);
    assert.throws(() => requireStandingLearningSnapshot(structuredClone(snapshot), primary));
    assert.throws(() => requireStandingLearningSnapshot(snapshot, { ...primary, actorId: "790" }));
    const stale = await tools.handlers[0]!.call({ ...args, text: "PRIVATE CHANGED TEXT" }, scope);
    assert.equal((stale as { success: boolean }).success, false); assert.equal(JSON.stringify(stale).includes("PRIVATE"), false);
    const read = parse(await tools.handlers[0]!.call({ action: "read", key: "reply.style", expectedRevision: null, kind: null,
      scope: "self", text: null, query: null }, { ...scope, callRef: "read-1" }));
    assert.equal(read.state, "active"); assert.equal(read.revision, 1);
    assert.equal(read.note.text, args.text); assert.equal(read.note.sourceData, "not-instructions");
    const retired = parse(await tools.handlers[0]!.call({ action: "retire", key: "reply.style", expectedRevision: read.revision,
      kind: null, scope: "self", text: null, query: null }, { ...scope, callRef: "retire-1" }));
    assert.equal(retired.state, "retired"); assert.equal(retired.note, null);
    await tools.close(); await store.close();
    store = await openStandingLearningStore(storeArgs); primary = { actorId: "789", requestRef: "request-2", messageId: 102 };
    tools = createStandingLearningTools({ store, primary, signal });
    const reopenedScope = { requestRef: primary.requestRef, callRef: "read-retired", signal };
    const tombstone = parse(await tools.handlers[0]!.call({ action: "read", key: "reply.style", expectedRevision: null, kind: null,
      scope: "self", text: null, query: null }, reopenedScope));
    assert.equal(tombstone.state, "retired"); assert.equal(tombstone.note, null); assert.equal(tombstone.revision, retired.revision);
    const restored = parse(await tools.handlers[0]!.call({ ...args, expectedRevision: tombstone.revision, text: "Use the restored concise style." },
      { ...reopenedScope, callRef: "restore-retired" }));
    assert.equal(restored.state, "saved"); assert.equal(restored.revision, tombstone.revision + 1);
  } finally { await tools.close(); await store.close(); }
});

test("malformed/stale inputs never reach store, private failures stay hidden, and close joins an admitted call", async () => {
  let calls = 0, release!: () => void; const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const store = {
    async read() { return { state: "absent", key: args.key, scope: "self", revision: null, note: null }; },
    async duplicates() { return { notes: [], visible: 0, matched: 0 }; },
    async list() { calls++; throw Error("PRIVATE_SECRET_PATH"); },
    async mutate() { calls++; await gate; throw Error("PRIVATE_SECRET_PATH"); }, async close() {}
  } as unknown as StandingLearningStore;
  const primary = { actorId: "789", requestRef: "request-1", messageId: 101 }, tools = createStandingLearningTools({ store, primary, signal });
  let invoked = false;
  const hostile = { ...args, get text() { invoked = true; return "PRIVATE"; } };
  const invalid = await tools.handlers[0]!.call(hostile, scope) as { success: boolean; contentItems: readonly { text: string }[] };
  assert.equal(invalid.success, false); assert.equal(invoked, false); assert.equal(calls, 0);
  assert.equal((await tools.handlers[0]!.call(args, { ...scope, requestRef: "stale" }) as { success: boolean }).success, false); assert.equal(calls, 0);
  const pending = tools.handlers[0]!.call(args, scope) as Promise<{ success: boolean; contentItems: readonly { text: string }[] }>;
  await new Promise(resolvePromise => setImmediate(resolvePromise)); assert.equal(calls, 1);
  let closed = false; const closing = tools.close().then(() => { closed = true; }); await new Promise(resolvePromise => setImmediate(resolvePromise)); assert.equal(closed, false);
  release(); const result = await pending; await closing;
  assert.equal(result.success, false); assert.equal(result.contentItems[0]!.text.includes("PRIVATE"), false); assert.equal(parse(result).code, "stopped");
  assert.equal((await tools.handlers[0]!.call(args, scope) as { success: boolean }).success, false); assert.equal(calls, 1);
});

test("snapshot revocation at every asynchronous boundary joins reads and issues no snapshot", async () => {
  for (const mode of ["close", "abort"] as const) for (const heldCall of [1, 2, 3]) {
    let calls = 0, release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const step = async () => { if (++calls === heldCall) { reached(); await gate; } };
    const store = {
      async list() { await step(); return { notes: [], visible: 0, matched: 0 }; },
      async usage() { await step(); return {}; },
    } as unknown as StandingLearningStore;
    const controller = new AbortController(), primary = { actorId: "789", requestRef: "request-1", messageId: 101 };
    const tools = createStandingLearningTools({ store, primary, signal: controller.signal });
    const pending = tools.snapshot({ query: "missing" });
    const rejected = assert.rejects(pending, /STANDING_LEARNING_TOOLS_CLOSED/);
    await entered;
    let joined = false;
    if (mode === "abort") controller.abort();
    const closing = mode === "close" ? tools.close().then(() => { joined = true; }) : undefined;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(joined, false);
    release(); await rejected; await closing;
    assert.equal(calls, heldCall);
    await tools.close();
  }
});

test("actual dispatcher bounds escaped multi-note list JSON and reports exact omissions", async t => {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-learning-output-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-learning-output-"))); await rm(root, { recursive: true, force: true }); });
  const store = await openStandingLearningStore({ directory: join(root, "learning"), passphrase: "synthetic-learning-output-passphrase",
    binding: { accountId: "123", peerId: "-100456" }, workspaceId: "community-team" });
  const primary = { actorId: "789", requestRef: "escape-request", messageId: 201 }, tools = createStandingLearningTools({ store, primary, signal });
  const dispatcher = createStandingNamedToolDispatcher(tools.handlers);
  try {
    for (let index = 0; index < 8; index++) {
      const result = await dispatcher.call(STANDING_LEARNING_TOOL_NAME, { action: "save", key: `escape.${index}`, expectedRevision: null,
        kind: "lesson", scope: "team", text: "\"".repeat(4094) + String(index).padStart(2, "0"), query: null },
      { requestRef: primary.requestRef, callRef: `save-${index}`, signal });
      assert.equal(result.success, true);
    }
    const result = await dispatcher.call(STANDING_LEARNING_TOOL_NAME, { action: "read", key: null, expectedRevision: null,
      kind: null, scope: null, text: null, query: "escape" }, { requestRef: primary.requestRef, callRef: "list", signal });
    assert.equal(result.success, true); const text = result.contentItems[0]!.text, value = JSON.parse(text);
    assert.ok(Buffer.byteLength(text) <= 48 * 1024); assert.ok(value.returned < 8); assert.equal(value.matched, 8);
    assert.equal(value.returned + value.omitted, value.matched); assert.equal(value.complete, false);
    assert.equal(value.notes.every((note: { text: string }) => note.text.length === 4096), true);
  } finally { await dispatcher.close(); await tools.close(); await store.close(); }
});
