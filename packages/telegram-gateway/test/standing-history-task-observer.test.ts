import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStandingHistoryTaskManager, type StandingHistoryTaskContextEvent } from "../src/standing-history-task-manager.js";

type Manager = Awaited<ReturnType<typeof openStandingHistoryTaskManager>>;
const primary = { chatId: "-100456", ownerId: "456", messageId: 999, text: "Private source question" };
const request = { fromDate: 1000, toDate: 2000, timezone: "Europe/Moscow", objective: "Synthetic task objective" };
const actor = (taskRef: string) => ({ taskRef, requesterId: "456" });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-task-observer-"));
  t.after(async () => { assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-task-observer-"))); await rm(root, { recursive: true, force: true }); });
  const directories = { control: join(root, "control"), pages: join(root, "pages"), analysis: join(root, "analysis") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const cancellations: { taskRef: string; revision: 1 }[] = [];
  const args = { directories, binding: { accountId: "123", peerId: primary.chatId }, passphrase: "synthetic-task-observer-passphrase",
    async onCancelled(value: { taskRef: string; revision: 1 }) { cancellations.push(value); } };
  const events: StandingHistoryTaskContextEvent[] = [];
  const open = async (onObservation = (event: StandingHistoryTaskContextEvent) => { events.push(event); }) => {
    const manager = await openStandingHistoryTaskManager({ ...args, onObservation }); t.after(() => manager.close()); return manager;
  };
  return { root, args, events, cancellations, open };
}
const create = (manager: Manager) => manager.create({ primary, request });

test("create invalidates before any task slots exist and publishes the detached successful snapshot", async t => {
  const f = await fixture(t), order: { kind: string; entries: number[] }[] = [];
  const manager = await f.open(event => { f.events.push(event); order.push({ kind: event.kind, entries: Object.values(f.args.directories).map(directory => readdirSync(directory).length) }); });
  const result = await create(manager);
  assert.deepEqual(f.events.map(event => event.kind), ["invalidate", "snapshot"]);
  assert.deepEqual(order[0]!.entries, [0, 0, 0]); assert.deepEqual(order[1]!.entries, [1, 1, 1]);
  const invalidate = f.events[0]!, snapshot = f.events[1]!; assert.equal(invalidate.kind, "invalidate"); assert.equal(snapshot.kind, "snapshot");
  if (invalidate.kind !== "invalidate" || snapshot.kind !== "snapshot") assert.fail();
  assert.deepEqual(invalidate, { kind: "invalidate", taskRef: result.taskRef, requesterId: primary.ownerId });
  assert.equal(snapshot.intent.taskId, result.taskRef); assert.equal(snapshot.intent.requesterId, primary.ownerId); assert.equal(snapshot.intent.objective, request.objective);
  assert.deepEqual(snapshot.status, result); assert.notEqual(snapshot.status, result); assert.notEqual(snapshot.status.control, result.control);
});

test("status snapshots and cancel invalidations observe actual persisted states without fabricating a cancel snapshot", async t => {
  const f = await fixture(t), manager = await f.open(), initial = await create(manager); f.events.length = 0;
  const status = await manager.status(actor(initial.taskRef)); assert.deepEqual(f.events.map(event => event.kind), ["invalidate", "snapshot"]);
  const event = f.events[1]!; if (event.kind !== "snapshot") assert.fail(); assert.deepEqual(event.status, status);
  f.events.length = 0; const cancelled = await manager.cancel(actor(initial.taskRef)); assert.equal(cancelled.control.state, "cancelled");
  assert.deepEqual(f.events, [{ kind: "invalidate", taskRef: initial.taskRef, requesterId: primary.ownerId }]);
  f.events.length = 0; await manager.status(actor(initial.taskRef)); const latest = f.events[1]!;
  if (latest.kind !== "snapshot") assert.fail(); assert.equal(latest.status.control.state, "cancelled");
});

test("snapshot event graphs are deeply frozen and independent of the returned status", async t => {
  const f = await fixture(t), manager = await f.open(), returned = await create(manager), event = f.events.find(value => value.kind === "snapshot")!;
  if (event.kind !== "snapshot") assert.fail();
  for (const object of [event, event.intent, event.status, event.status.control, event.status.read, event.status.analysis]) assert.ok(Object.isFrozen(object));
  assert.equal(Reflect.set(event.intent, "objective", "changed"), false); assert.equal(Reflect.set(event.status.control, "state", "cancelled"), false);
  assert.equal(returned.control.state, "queued"); assert.equal(event.intent.objective, request.objective);
  assert.notEqual(event.status.read, returned.read); assert.notEqual(event.status.analysis, returned.analysis);
  const fresh = await manager.status(actor(returned.taskRef)); assert.equal(fresh.control.state, "queued");
});

test("existing-task conflict and damaged storage invalidate first but never publish success snapshots", async t => {
  const f = await fixture(t), manager = await f.open(), initial = await create(manager); f.events.length = 0;
  await assert.rejects(manager.create({ primary, request: { ...request, objective: "Conflicting objective" } }));
  assert.deepEqual(f.events, [{ kind: "invalidate", taskRef: initial.taskRef, requesterId: primary.ownerId }]);
  f.events.length = 0; const path = join(f.args.directories.control, initial.taskRef, "intent.enc"); await writeFile(path, "retained damaged header");
  await assert.rejects(manager.status(actor(initial.taskRef)));
  assert.deepEqual(f.events, [{ kind: "invalidate", taskRef: initial.taskRef, requesterId: primary.ownerId }]);
  assert.equal(await readFile(path, "utf8"), "retained damaged header");
});

test("create storage failure still emits invalidation before the first persistent control mutation", async t => {
  const f = await fixture(t); let priorControlAbsent = false;
  const manager = await f.open(event => {
    f.events.push(event);
    if (event.kind === "invalidate") {
      priorControlAbsent = !existsSync(join(f.args.directories.control, event.taskRef));
      mkdirSync(join(f.args.directories.pages, event.taskRef));
    }
  });
  await assert.rejects(create(manager)); assert.equal(priorControlAbsent, true); assert.equal(f.events.length, 1); assert.equal(f.events[0]!.kind, "invalidate");
});

test("foreign requester operations reveal no intent or successful task snapshot", async t => {
  const f = await fixture(t), manager = await f.open(), initial = await create(manager); f.events.length = 0;
  for (const operation of [manager.status, manager.cancel]) await assert.rejects(operation({ taskRef: initial.taskRef, requesterId: "777" }));
  assert.ok(f.events.every(event => event.kind === "invalidate"));
  assert.equal(JSON.stringify(f.events).includes(request.objective), false); assert.equal(JSON.stringify(f.events).includes("intent"), false);
  assert.equal(f.cancellations.length, 0); assert.equal((await manager.status(actor(initial.taskRef))).control.state, "queued");
});

test("synchronous observer exceptions do not change create, cancel or idempotent retries", async t => {
  const f = await fixture(t); let callbacks = 0;
  const manager = await f.open(() => { callbacks++; throw Error("synthetic observer failure"); });
  const initial = await create(manager), repeated = await create(manager); assert.equal(repeated.taskRef, initial.taskRef);
  assert.equal((await manager.status(actor(initial.taskRef))).control.state, "queued");
  assert.equal((await manager.cancel(actor(initial.taskRef))).control.state, "cancelled");
  assert.equal((await manager.cancel(actor(initial.taskRef))).control.state, "cancelled");
  assert.equal(f.cancellations.length, 2); assert.ok(callbacks >= 8);
  await manager.close(); const reopened = await f.open(); assert.equal((await reopened.status(actor(initial.taskRef))).control.state, "cancelled");
});

test("factory rejects async, generator, proxied and accessor observers without invoking them", async t => {
  const f = await fixture(t); let invoked = 0;
  const ordinary = () => { invoked++; };
  for (const onObservation of [async () => { invoked++; }, function* () { invoked++; }, async function* () { invoked++; },
    new Proxy(ordinary, { apply() { invoked++; }, getOwnPropertyDescriptor() { invoked++; throw Error("trap"); } })]) {
    await assert.rejects(openStandingHistoryTaskManager({ ...f.args, onObservation: onObservation as never }));
  }
  await assert.rejects(openStandingHistoryTaskManager({ ...f.args, get onObservation() { invoked++; return ordinary; } }));
  assert.equal(invoked, 0);
});

test("close and per-call abort during real status decryption suppress any late snapshot", async t => {
  for (const abort of [false, true]) {
    const f = await fixture(t), manager = await f.open(), initial = await create(manager); f.events.length = 0;
    const controller = new AbortController(); let started!: () => void, cryptoStarted = false;
    const beginning = new Promise<void>(resolve => { started = resolve; });
    const hook = createHook({ init(_id, type) { if (type === "SCRYPTREQUEST") { cryptoStarted = true; started(); } } }).enable();
    try {
      const pending = manager.status({ ...actor(initial.taskRef), signal: controller.signal }).then(() => "unexpected-success", () => "refused");
      await Promise.race([beginning, pending]); assert.equal(cryptoStarted, true); hook.disable();
      if (abort) controller.abort(); else await manager.close();
      assert.equal(await pending, "refused"); assert.deepEqual(f.events, [{ kind: "invalidate", taskRef: initial.taskRef, requesterId: primary.ownerId }]);
    } finally { hook.disable(); await manager.close(); }
  }
});
