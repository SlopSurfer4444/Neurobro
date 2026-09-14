import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rename, link, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { encryptSession, decryptSession } from "../src/session-crypto.js";
import { openStandingHistoryTaskControlStore } from "../src/standing-history-task-control-store.js";
import type { StandingHistoryTaskIntent } from "../src/standing-history-task-store.js";

type Store = Awaited<ReturnType<typeof openStandingHistoryTaskControlStore>>;
const intent = (): StandingHistoryTaskIntent => ({ schema: "standing-history-task-v1", taskId: "htask_" + "4".repeat(48), accountId: "123", chatId: "-100456",
  requesterId: "456", primaryMessageId: 999, fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Секретный разбор истории обсуждения" });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-task-control-")), directory = join(root, "control"); await mkdir(directory);
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-task-control-"))); await rm(root, { recursive: true, force: true }); });
  const args = { directory, passphrase: "synthetic-task-control-passphrase", intent: intent() };
  return { root, args, slot: join(directory, args.intent.taskId) };
}
async function created(f: Awaited<ReturnType<typeof fixture>>, t: TestContext) {
  const store = await openStandingHistoryTaskControlStore({ ...f.args, mode: "create" }); t.after(() => store.close()); return store;
}
async function reopened(f: Awaited<ReturnType<typeof fixture>>, t: TestContext) {
  const store = await openStandingHistoryTaskControlStore({ ...f.args, mode: "open" }); t.after(() => store.close()); return store;
}
async function disk(slot: string) {
  return Promise.all((await readdir(slot)).sort().map(async name => [name, await readFile(join(slot, name), "utf8")]));
}
async function assertTail(store: Store, state: "queued" | "cancelled", revision: 0 | 1) {
  const status = await store.status(); assert.equal(status.storage, "tail-refused"); assert.equal(status.state, state); assert.equal(status.revision, revision);
  await assert.rejects(store.cancel({ expectedRevision: 0 })); await assert.rejects(store.cancel({ expectedRevision: 1 }));
}

test("created control is encrypted queued revision zero and exact reopen returns the same head", async t => {
  const f = await fixture(t), store = await created(f, t), initial = await store.status();
  assert.deepEqual(Object.keys(initial).sort(), ["headHash", "revision", "state", "storage"]);
  assert.equal(initial.state, "queued"); assert.equal(initial.revision, 0); assert.equal(initial.storage, "ready"); assert.match(initial.headHash, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(initial)); assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
  const ciphertext = await readFile(join(f.slot, "intent.enc"), "utf8");
  for (const raw of ["Секретный", "-100456", "requesterId", "primaryMessageId", "queued", "revision", "objective"]) assert.equal(ciphertext.includes(raw), false);
  const plaintext = await decryptSession(ciphertext, f.args.passphrase); assert.ok(plaintext.includes(f.args.intent.objective));
  await store.close(); const again = await reopened(f, t); assert.deepEqual(await again.status(), initial);
  assert.equal(await readFile(join(f.slot, "intent.enc"), "utf8"), ciphertext);
});

test("one immutable cancel advances revision and repeats at either revision create no new bytes", async t => {
  const f = await fixture(t), store = await created(f, t), queued = await store.status(), header = await readFile(join(f.slot, "intent.enc"));
  const cancelled = await store.cancel({ expectedRevision: 0 });
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.revision, 1); assert.equal(cancelled.storage, "ready"); assert.notEqual(cancelled.headHash, queued.headHash);
  assert.deepEqual(await readdir(f.slot), ["cancel-000001.enc", "intent.enc"]); const before = await disk(f.slot);
  assert.deepEqual(await store.cancel({ expectedRevision: 0 }), cancelled); assert.deepEqual(await store.cancel({ expectedRevision: 1 }), cancelled);
  assert.deepEqual(await disk(f.slot), before); assert.deepEqual(await readFile(join(f.slot, "intent.enc")), header);
  const ciphertext = await readFile(join(f.slot, "cancel-000001.enc"), "utf8");
  for (const raw of ["cancelled", "revision", "previousHash", queued.headHash]) assert.equal(ciphertext.includes(raw), false);
  await store.close(); const again = await reopened(f, t); assert.deepEqual(await again.status(), cancelled);
  assert.deepEqual(await again.cancel({ expectedRevision: 0 }), cancelled); assert.deepEqual(await disk(f.slot), before);
});

test("lost cancellation acknowledgment recovers cancelled and never replays an extra transition", async t => {
  const f = await fixture(t), store = await created(f, t); await store.cancel({ expectedRevision: 0 }); await store.close();
  const before = await disk(f.slot), again = await reopened(f, t), recovered = await again.status();
  assert.equal(recovered.state, "cancelled"); assert.equal(recovered.revision, 1);
  assert.deepEqual(await again.cancel({ expectedRevision: 0 }), recovered); assert.deepEqual(await disk(f.slot), before);
});

test("revision conflict and invalid values never allocate cancellation state", async t => {
  const f = await fixture(t), store = await created(f, t), initial = await store.status();
  await assert.rejects(store.cancel({ expectedRevision: 1 }));
  for (const value of [-1, 2, 0.5, NaN, Infinity, "0", null, undefined]) await assert.rejects(store.cancel({ expectedRevision: value } as never));
  await assert.rejects(store.cancel({ expectedRevision: 0, extra: true } as never));
  assert.deepEqual(await store.status(), initial); assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
});

test("full intent binding and passphrase protect an existing control slot", async t => {
  const f = await fixture(t), store = await created(f, t); await store.close(); const before = await disk(f.slot);
  for (const delta of [{ requesterId: "457" }, { primaryMessageId: 1000 }, { objective: "Different task" }, { timezone: "UTC" },
    { accountId: "124" }, { chatId: "-100457" }, { fromDate: 1001 }, { toDate: 2001 }])
    await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "open", intent: { ...f.args.intent, ...delta } }));
  await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "open", passphrase: "different-long-passphrase" }));
  await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "create" })); assert.deepEqual(await disk(f.slot), before);
});

test("open never creates and a partial or authenticated malformed header stays consumed", async t => {
  const f = await fixture(t); await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "open" })); assert.deepEqual(await readdir(f.args.directory), []);
  await mkdir(f.slot); const path = join(f.slot, "intent.enc");
  for (const content of ["retained partial header", await encryptSession(JSON.stringify({ intent: f.args.intent, extra: "wrong header" }), f.args.passphrase)]) {
    await writeFile(path, content); await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "open" }));
    await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "create" })); assert.equal(await readFile(path, "utf8"), content);
  }
});

test("partial cancellation tail preserves queued prefix and permanently refuses append", async t => {
  const f = await fixture(t), store = await created(f, t), initial = await store.status(); await store.close();
  const path = join(f.slot, "cancel-000001.enc"); await writeFile(path, "retained incomplete cancellation");
  const again = await reopened(f, t); await assertTail(again, "queued", 0); assert.equal((await again.status()).headHash, initial.headHash);
  assert.equal(await readFile(path, "utf8"), "retained incomplete cancellation");
  await rename(path, join(f.root, "retained-cancel.enc")); await assertTail(again, "queued", 0);
});

test("authenticated malformed cancellation chain retains the queued head without accepting forged state", async t => {
  const f = await fixture(t), store = await created(f, t), queued = await store.status(); await store.cancel({ expectedRevision: 0 }); await store.close();
  const path = join(f.slot, "cancel-000001.enc"), original = JSON.parse(await decryptSession(await readFile(path, "utf8"), f.args.passphrase));
  for (const mutate of [(v: any) => { v.previousHash = "0".repeat(64); }, (v: any) => { v.intentHash = "0".repeat(64); },
    (v: any) => { v.taskId = "htask_" + "f".repeat(48); }, (v: any) => { v.state = "queued"; }, (v: any) => { v.revision = 2; },
    (v: any) => { v.extra = "unknown field"; }]) {
    const value = structuredClone(original); mutate(value); const ciphertext = await encryptSession(JSON.stringify(value), f.args.passphrase); await writeFile(path, ciphertext);
    const again = await openStandingHistoryTaskControlStore({ ...f.args, mode: "open" });
    await assertTail(again, "queued", 0); assert.equal((await again.status()).headHash, queued.headHash); await again.close();
    assert.equal(await readFile(path, "utf8"), ciphertext);
  }
});

test("unknown files preserve queued or cancelled authenticated prefix while blocking every new operation", async t => {
  for (const cancelled of [false, true]) {
    const f = await fixture(t), store = await created(f, t); if (cancelled) await store.cancel({ expectedRevision: 0 }); const prior = await store.status(); await store.close();
    await writeFile(join(f.slot, "unknown-retained.bin"), "unowned contents"); const before = await disk(f.slot), again = await reopened(f, t);
    await assertTail(again, cancelled ? "cancelled" : "queued", cancelled ? 1 : 0); assert.equal((await again.status()).headHash, prior.headHash); assert.deepEqual(await disk(f.slot), before);
  }
});

test("hardlinked headers are refused and hardlinked cancellation cannot be admitted", async t => {
  for (const filename of ["intent.enc", "cancel-000001.enc"]) {
    const f = await fixture(t), store = await created(f, t); await store.cancel({ expectedRevision: 0 }); await store.close();
    const path = join(f.slot, filename), bytes = await readFile(path); await link(path, join(f.root, "retained-hardlink.enc"));
    if (filename === "intent.enc") await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "open" }));
    else { const again = await reopened(f, t); await assertTail(again, "queued", 0); }
    assert.deepEqual(await readFile(path), bytes);
  }
});

test("junction slots and substitution of the protected slot or parent are refused", async t => {
  const f = await fixture(t), store = await created(f, t); await store.close(); const original = join(f.root, "retained-original-slot");
  await rename(f.slot, original); await symlink(original, f.slot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "open" }));
  for (const target of ["slot", "parent"] as const) {
    const g = await fixture(t), current = await created(g, t);
    await rename(target === "slot" ? g.slot : g.args.directory, join(g.root, "retained-original"));
    if (target === "parent") await mkdir(g.args.directory);
    await mkdir(g.slot); await assert.rejects(current.status()); await assert.rejects(current.cancel({ expectedRevision: 0 })); await current.close();
    assert.deepEqual(await readdir(g.slot), []);
  }
});

test("getter and proxy input graphs execute no traps or accessors", async t => {
  const f = await fixture(t); let calls = 0;
  for (const args of [{ ...f.args, mode: "create", get intent() { calls++; return f.args.intent; } },
    new Proxy({ ...f.args, mode: "create" }, { getPrototypeOf() { calls++; throw Error("trap"); } }),
    { ...f.args, mode: "create", intent: { ...f.args.intent, get objective() { calls++; return "changed"; } } }])
    await assert.rejects(openStandingHistoryTaskControlStore(args as never));
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.args.directory), []);
  const store = await created(f, t);
  for (const request of [{ get expectedRevision() { calls++; return 0; } }, new Proxy({ expectedRevision: 0 }, { ownKeys() { calls++; throw Error("trap"); } })])
    await assert.rejects(store.cancel(request as never));
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.slot), ["intent.enc"]);
});

test("creation and cancellation snapshot caller intent and revision before awaiting I/O", async t => {
  const f = await fixture(t), originalIntent = structuredClone(f.args.intent), pending = openStandingHistoryTaskControlStore({ ...f.args, mode: "create" });
  (f.args.intent as { objective: string }).objective = "Mutated after admission"; const store = await pending; t.after(() => store.close());
  const request = { expectedRevision: 0 as 0 | 1 }, cancellation = store.cancel(request); request.expectedRevision = 1;
  assert.equal((await cancellation).state, "cancelled"); await store.close();
  const again = await openStandingHistoryTaskControlStore({ ...f.args, intent: originalIntent, mode: "open" }); t.after(() => again.close());
  assert.equal((await again.status()).state, "cancelled");
});

test("preaborted creation allocates nothing and close or abort joins admitted cancellation work", async t => {
  const f = await fixture(t), aborted = new AbortController(); aborted.abort();
  await assert.rejects(openStandingHistoryTaskControlStore({ ...f.args, mode: "create", signal: aborted.signal })); assert.deepEqual(await readdir(f.args.directory), []);
  for (const cancel of ["close", "abort"] as const) {
    const g = await fixture(t), controller = new AbortController(), store = await openStandingHistoryTaskControlStore({ ...g.args, mode: "create", signal: controller.signal }); t.after(() => store.close());
    const pending = store.cancel({ expectedRevision: 0 }).then(value => value, () => undefined);
    await immediate(); if (cancel === "abort") controller.abort(); await store.close();
    const atClose = await disk(g.slot), result = await pending; assert.deepEqual(await disk(g.slot), atClose);
    await assert.rejects(store.status()); await assert.rejects(store.cancel({ expectedRevision: 0 }));
    const again = await reopened(g, t), state = await again.status();
    if (result) assert.deepEqual(state, result);
    assert.ok(state.revision === 0 || state.revision === 1);
  }
});

test("two independently opened handles cannot overwrite the single cancellation record", async t => {
  const f = await fixture(t), store = await created(f, t); await store.close();
  const a = await reopened(f, t), b = await reopened(f, t);
  const results = await Promise.allSettled([a.cancel({ expectedRevision: 0 }), b.cancel({ expectedRevision: 0 })]);
  assert.ok(results.some(r => r.status === "fulfilled"));
  await a.close(); await b.close(); const again = await reopened(f, t); assert.equal((await again.status()).state, "cancelled");
  assert.deepEqual(await readdir(f.slot), ["cancel-000001.enc", "intent.enc"]); const bytes = await disk(f.slot);
  await again.cancel({ expectedRevision: 0 }); assert.deepEqual(await disk(f.slot), bytes);
});
