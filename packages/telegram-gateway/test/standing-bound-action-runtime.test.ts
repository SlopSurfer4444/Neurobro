import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createStandingBoundActionRuntime, type BoundActionLease, type StandingBoundActionRuntimePorts } from "../src/standing-bound-action-runtime.js";
import { openStandingActionJournal, standingActionKey, snapshotStandingActionJson, StandingActionJournalError,
  type StandingActionInspection, type StandingActionBinding, type StandingActionIntent } from "../src/standing-action-journal.js";
import type { EpochToolResult } from "../src/standing-tool-dispatcher.js";
import type { StandingPollObjectEvidence } from "../src/standing-object-evidence.js";

const binding = { accountId: "123", peerId: "-456" }, primary = { chatId: "-456", ownerId: "789", messageId: 12, text: "synthetic question" };
const ref = "m_" + "a".repeat(24), poll = { question: "Choose", options: ["one", "two"], anonymous: true, type: "single" };
const cases: [string, unknown][] = [["neurobro_create_poll", poll], ["neurobro_read_poll", { messageRef: ref }],
  ["neurobro_close_poll", { messageRef: ref }], ["neurobro_read_reactions", { messageRef: ref }], ["neurobro_set_reaction", { messageRef: ref, emoji: "👍" }],
  ["neurobro_self_profile", {}], ["neurobro_set_display_name", { firstName: "Нейробро" }], ["neurobro_set_avatar", { artifactRef: "art_" + "a".repeat(48) }],
  ["neurobro_set_group_avatar", { artifactRef: "art_" + "a".repeat(48) }]];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

function objectEvidence(randomId: string): StandingPollObjectEvidence {
  return { schema: "standing-poll-object-v1", kind: "poll", objectRef: "obj_" + "c".repeat(48), observedAt: 1789068247,
    record: { schema: "owned-bound-poll-v1", operationId: "bound-action-" + randomId, randomId,
      accountId: binding.accountId, chatId: binding.peerId, replyToMessageId: primary.messageId,
      messageId: 250, pollId: "987654321012345678", poll: { ...poll, type: "single" } } };
}

test("verified poll evidence survives runtime replacement; model finds then resolves through the current lease", async t => {
  const prefix = join(resolve(tmpdir()), "durable-object-runtime-");
  const stateDirectory = await mkdtemp(prefix), passphrase = "synthetic durable object runtime passphrase";
  t.after(async () => { assert.ok(resolve(stateDirectory).startsWith(prefix)); await rm(stateDirectory, { recursive: true, force: true }); });
  const control = new AbortController(); let created: StandingPollObjectEvidence | undefined, createCalls = 0, resolveCalls = 0;
  const make = () => createStandingBoundActionRuntime({ signal: control.signal, stateDirectory, passphrase, binding, killed: () => false });
  const first = make();
  first.begin({ requestRef: "before-reconnect", primary, openActions: () => ({
    async execute(request, randomId) {
      assert.equal(request.kind, "create-poll"); createCalls++; created = objectEvidence(randomId);
      return { outcome: { verdict: "verified", poll: { messageRef: ref, question: poll.question } }, privateObjectEvidence: created };
    }, async close() {},
  }) });
  const answer = await caller(first, "before-reconnect")("neurobro_create_poll", poll);
  assert.equal(answer.verdict, "verified");
  assert.equal(JSON.stringify(answer).includes("privateObjectEvidence"), false);
  assert.equal(JSON.stringify(answer).includes("987654321012345678"), false);
  await first.close();
  const second = make(), nextRef = "m_" + "b".repeat(24);
  second.begin({ requestRef: "after-reconnect", primary: { ...primary, messageId: 13 }, openActions: () => ({
    async execute(request) {
      assert.equal(request.kind, "resolve-poll-object");
      if (request.kind !== "resolve-poll-object") throw Error("unexpected transport call");
      assert.deepEqual(request.record, created!.record); resolveCalls++;
      return { outcome: { verdict: "verified", poll: { messageRef: nextRef, totalVoters: 3 } } };
    }, async close() {},
  }) });
  const call = caller(second, "after-reconnect"), before = await readdir(join(stateDirectory, "action-journal"));
  const found = await call("neurobro_find_objects", { kind: "poll", query: "Choose" });
  assert.equal(found.verdict, "verified"); assert.equal(found.objects.length, 1);
  assert.equal(found.objects[0].objectRef, created!.objectRef); assert.equal(resolveCalls, 0);
  assert.deepEqual(await readdir(join(stateDirectory, "action-journal")), before);
  const resolved = await call("neurobro_resolve_object", { objectRef: found.objects[0].objectRef });
  assert.equal(resolved.verdict, "verified"); assert.equal(resolved.poll.messageRef, nextRef);
  assert.equal(resolved.poll.totalVoters, 3); assert.equal(createCalls, 1); assert.equal(resolveCalls, 1);
  assert.equal(JSON.stringify({ found, resolved }).includes(created!.record.pollId), false);
  await second.close();
});

test("private evidence is omitted from unknown terminals and refused when its binding disagrees", async () => {
  for (const mode of ["binding", "close"] as const) {
    const f = fixture(), runtime = f.create();
    runtime.begin({ requestRef: "request-1", primary, openActions: () => ({
      async execute(_request, randomId) {
        const evidence = objectEvidence(randomId);
        return { outcome: { verdict: "verified" }, privateObjectEvidence: mode === "binding"
          ? { ...evidence, record: { ...evidence.record, chatId: "-999" } } : evidence };
      }, async close() { if (mode === "close") throw Error("unsettled"); },
    }) });
    const answer = await caller(runtime)("neurobro_create_poll", poll);
    assert.equal(answer.verdict, "unknown"); assert.equal(runtime.state().blocked, true);
    assert.equal([...f.records.values()][0]!.terminal!.privateObjectEvidence, undefined);
    assert.equal(JSON.stringify(answer).includes("record"), false); await runtime.close();
  }
});

test("catalog reads stay local and STOP joins their actual I/O before closing", async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let catalogClosed = false, finished = false;
  const runtime = f.create({ openCatalog: async () => ({
    async find() { entered.resolve(); await release.promise; return { objects: [], hasMore: false,
      coverage: { complete: true, scanned: 0, unavailable: 0, legacy: 0 } }; },
    async resolve() { throw Error("not expected"); }, async close() { catalogClosed = true; },
  }) });
  runtime.begin({ requestRef: "request-1", primary, openActions: f.lease });
  const work = caller(runtime)("neurobro_find_objects", { kind: "poll" }); await entered.promise;
  const closing = runtime.close().then(() => { finished = true; });
  await new Promise(r => setImmediate(r)); assert.equal(finished, false); assert.equal(catalogClosed, false);
  assert.equal(f.executions(), 0); assert.equal(f.bindings.length, 0);
  release.resolve(); assert.equal((await work).success, false); await closing;
  assert.equal(catalogClosed, true); assert.equal(finished, true);
});
function fixture() {
  const events: string[] = [], records = new Map<string, StandingActionInspection>(), bindings: StandingActionBinding[] = [], randomIds: string[] = [];
  const controller = new AbortController(); let killed = false, executions = 0, closes = 0;
  const openJournal: NonNullable<StandingBoundActionRuntimePorts["openJournal"]> = async input => {
    const key = standingActionKey(input.binding); bindings.push(input.binding); events.push("journal-open");
    let reserved = false;
    return {
      async inspect() { events.push("inspect"); return records.get(key) ?? { state: "absent" }; },
      async reserve(value) {
        events.push("reserve"); if (records.has(key)) throw new StandingActionJournalError("consumed");
        const intent = { ...value, action: snapshotStandingActionJson(value.action) } as StandingActionIntent;
        records.set(key, { state: "reserved", intent }); reserved = true;
      },
      async append(value) { assert.equal(reserved, true); events.push("append-" + value.state);
        records.set(key, { ...records.get(key)!, state: value.state, terminal: { ...value, result: snapshotStandingActionJson(value.result) } }); },
      async close() { events.push("journal-close"); },
    };
  };
  const lease = (): BoundActionLease => ({
    async execute(request, randomId) { executions++; randomIds.push(randomId); events.push("execute-" + request.kind);
      return { outcome: { verdict: "verified", snapshot: { messageRef: ref, count: 2 } } }; },
    async close() { closes++; events.push("lease-close"); },
  });
  const create = (ports: StandingBoundActionRuntimePorts = {}) => createStandingBoundActionRuntime({ binding, stateDirectory: resolve("synthetic-unused-action-runtime"),
    passphrase: "synthetic action runtime passphrase", signal: controller.signal, killed: () => killed, ports: { openJournal, ...ports } });
  return { create, openJournal, lease, events, records, bindings, randomIds, controller, kill: () => { killed = true; }, executions: () => executions, closes: () => closes };
}
function caller(runtime: ReturnType<typeof createStandingBoundActionRuntime>, requestRef = "request-1", signal = new AbortController().signal) {
  let calls = 0;
  return async (name: string, args: unknown) => {
    const result = await runtime.handlers.find(h => h.name === name)!.call(args, { requestRef, callRef: "call-" + ++calls, signal }) as EpochToolResult;
    return { success: result.success, ...JSON.parse(result.contentItems[0].text) };
  };
}

test("group and profile tools share durable slots and persist reads before outcome publication", async () => {
  const f = fixture(), runtime = f.create(); runtime.begin({ requestRef: "request-1", primary, openActions: f.lease });
  const call = caller(runtime);
  for (const [name, args] of cases) {
    const before = f.events.length, result = await call(name, args);
    assert.equal(result.verdict, "verified"); assert.equal(result.snapshot.count, 2);
    const events = f.events.slice(before);
    assert.ok(events.indexOf("reserve") < events.findIndex(e => e.startsWith("execute-")));
    assert.ok(events.indexOf("lease-close") < events.indexOf("append-verified"));
    assert.equal(events.at(-1), "journal-close");
  }
  assert.deepEqual(f.bindings.map(b => b.operationSlot), cases.map((_, index) => index)); assert.equal(f.executions(), cases.length); assert.equal(f.closes(), cases.length);
  assert.ok(f.randomIds.every(id => /^[1-9]\d{0,18}$/.test(id) && BigInt(id) < 2n ** 63n)); assert.equal(new Set(f.randomIds).size, cases.length);
  assert.equal([...f.records.values()].filter(r => r.intent?.action && typeof r.intent.action === "object").length, cases.length);
  await runtime.finish(); assert.equal(runtime.state().active, false); await runtime.close();
});

test("reopened primary slot is inspected and never replayed or bypassed by a new epoch", async () => {
  const f = fixture(), one = f.create(); one.begin({ requestRef: "request-1", primary, openActions: f.lease });
  assert.equal((await caller(one)(...cases[0]!)).verdict, "verified"); await one.close();
  const two = f.create(); two.begin({ requestRef: "request-2", primary, openActions: f.lease });
  const call = caller(two, "request-2"); assert.equal((await call(...cases[4]!)).verdict, "refused");
  assert.equal(two.state().blocked, true); assert.equal((await call(...cases[0]!)).success, false);
  assert.equal(f.executions(), 1); assert.deepEqual(f.bindings.map(b => b.operationSlot), [0, 0]); await two.close();
});

test("foreign or executable scopes and model-selected slots cannot allocate actions", async () => {
  const f = fixture(), runtime = f.create(); runtime.begin({ requestRef: "request-1", primary, openActions: f.lease });
  assert.equal((await caller(runtime, "foreign")(...cases[0]!)).success, false);
  assert.equal((await caller(runtime)("neurobro_create_poll", { ...poll, operationSlot: 10 })).success, false);
  let accessed = false; const scope = { get requestRef() { accessed = true; return "request-1"; }, callRef: "call-1", signal: f.controller.signal };
  assert.equal((await runtime.handlers[0]!.call(poll, scope) as EpochToolResult).success, false); assert.equal(accessed, false);
  assert.equal(f.executions(), 0); assert.equal(f.bindings.length, 0); await runtime.close();
});

test("unknown mutation poisons all tool families; unavailable read may remain a refused snapshot", async () => {
  const f = fixture(), runtime = f.create(); runtime.begin({ requestRef: "request-1", primary,
    openActions: () => ({ ...f.lease(), async execute(request) { if (request.kind === "read-reactions") throw new Error("PRIVATE unavailable"); return { outcome: { verdict: "unknown" } }; } }) });
  const call = caller(runtime);
  assert.equal((await call(...cases[3]!)).verdict, "refused"); assert.equal(runtime.state().blocked, false);
  const value = await call(...cases[4]!); assert.equal(value.verdict, "unknown"); assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
  assert.equal(runtime.state().blocked, true); assert.equal((await call(...cases[0]!)).success, false); assert.equal(f.bindings.length, 2); await runtime.close();
});

test("group avatar unknown is durably consumed and cannot replay after reopening the primary", async () => {
  const f = fixture(), first = f.create(); let attempts = 0;
  first.begin({ requestRef: "request-1", primary, openActions: () => ({ async execute(request) {
    assert.equal(request.kind, "set-group-avatar"); attempts++; return { outcome: { verdict: "unknown", code: "transport" } };
  }, async close() {} }) });
  assert.equal((await caller(first)(...cases[8]!)).verdict, "unknown"); assert.equal(first.state().blocked, true);
  assert.equal([...f.records.values()][0]!.state, "unknown"); assert.equal((await caller(first)(...cases[7]!)).success, false);
  await first.close();
  const reopened = f.create(); reopened.begin({ requestRef: "request-2", primary, openActions: f.lease });
  assert.equal((await caller(reopened, "request-2")(...cases[8]!)).verdict, "refused");
  assert.equal(attempts, 1); assert.equal(f.executions(), 0); assert.equal(reopened.state().blocked, true); await reopened.close();
});

test("finish aborts promptly but joins actual mutation and close before any terminal or publication", async () => {
  const f = fixture(), entered = deferred(), release = deferred(), closeRelease = deferred(); let closeCalled = false, published = false;
  const runtime = f.create(); runtime.begin({ requestRef: "request-1", primary, openActions: () => ({
    async execute() { entered.resolve(); await release.promise; return { outcome: { verdict: "verified" } }; },
    async close() { closeCalled = true; await closeRelease.promise; },
  }) });
  const work = caller(runtime)(...cases[0]!).then(v => { published = true; return v; }); await entered.promise;
  let finished = false; const finish = runtime.finish().then(() => { finished = true; });
  assert.equal(closeCalled, true); await new Promise(r => setImmediate(r)); assert.equal(published, false); assert.equal(finished, false);
  assert.equal(f.events.some(e => e.startsWith("append-")), false);
  release.resolve(); await new Promise(r => setImmediate(r)); assert.equal(published, false);
  closeRelease.resolve(); await work; await finish; assert.equal(runtime.state().blocked, true);
  assert.equal([...f.records.values()][0]!.state, "unknown"); await runtime.close();
});

test("result is snapshotted before asynchronous lease cleanup", async () => {
  const f = fixture(), held = deferred(), entered = deferred(); const result: { verdict: "verified"; snapshot: { count: number } } = { verdict: "verified", snapshot: { count: 2 } };
  const runtime = f.create(); runtime.begin({ requestRef: "request-1", primary, openActions: () => ({
    async execute() { return { outcome: result }; }, async close() { entered.resolve(); await held.promise; },
  }) });
  const work = caller(runtime)(...cases[3]!); await entered.promise; result.snapshot.count = 999; held.resolve();
  assert.equal((await work).snapshot.count, 2); await runtime.close();
});

test("reservation and terminal storage uncertainty stop further actions without leaking errors", async () => {
  for (const stage of ["reserve", "append"] as const) {
    const f = fixture(), runtime = f.create({ openJournal: async input => { const journal = await f.openJournal(input); return { ...journal,
      [stage]: async () => { throw new Error("PRIVATE storage path"); } }; } });
    runtime.begin({ requestRef: "request-1", primary, openActions: f.lease });
    const value = await caller(runtime)(...cases[0]!); assert.equal(value.verdict, "unknown"); assert.equal(JSON.stringify(value).includes("PRIVATE"), false);
    assert.equal(runtime.state().blocked, true); assert.equal(f.executions(), stage === "reserve" ? 0 : 1); await runtime.close();
  }
});

test("cleanup failure suppresses verified outcome and poisons even read actions", async () => {
  const f = fixture(), runtime = f.create(); runtime.begin({ requestRef: "request-1", primary,
    openActions: () => ({ ...f.lease(), async close() { throw new Error("PRIVATE unjoined"); } }) });
  const value = await caller(runtime)(...cases[3]!); assert.equal(value.verdict, "unknown"); assert.equal(value.snapshot, undefined);
  assert.equal(runtime.state().blocked, true); assert.equal([...f.records.values()][0]!.state, "unknown"); await runtime.close();
});

test("all names share the 32-slot cap and stable handlers survive fresh selections", async () => {
  const f = fixture(), runtime = f.create(), handlers = runtime.handlers; runtime.begin({ requestRef: "request-1", primary, openActions: f.lease });
  const call = caller(runtime); for (let i = 0; i < 32; i++) assert.equal((await call(...cases[i % cases.length]!)).verdict, "verified");
  assert.equal((await call(...cases[0]!)).verdict, "refused"); assert.equal(f.executions(), 32);
  await runtime.finish(); runtime.begin({ requestRef: "request-2", primary: { ...primary, messageId: 13 }, openActions: f.lease });
  assert.equal(runtime.handlers, handlers); assert.equal((await caller(runtime, "request-2")(...cases[3]!)).verdict, "verified"); await runtime.close();
});

test("STOP before admission and invalid group binding open no lease or journal", async () => {
  const f = fixture(), runtime = f.create(); assert.throws(() => runtime.begin({ requestRef: "request-1", primary: { ...primary, chatId: "-999" }, openActions: f.lease }));
  runtime.begin({ requestRef: "request-1", primary, openActions: f.lease }); f.kill(); assert.equal((await caller(runtime)(...cases[0]!)).success, false);
  assert.equal(f.bindings.length, 0); await runtime.close(); assert.throws(() => runtime.begin({ requestRef: "after-close", primary, openActions: f.lease }));
});

test("cross-tool concurrent calls cannot open another slot while real execute is pending", async () => {
  const f = fixture(), entered = deferred(), release = deferred(), runtime = f.create(); runtime.begin({ requestRef: "request-1", primary,
    openActions: () => ({ ...f.lease(), async execute() { entered.resolve(); await release.promise; return { outcome: { verdict: "verified" } }; } }) });
  const call = caller(runtime), work = call(...cases[0]!); await entered.promise;
  assert.equal((await call(...cases[4]!)).code, "busy"); assert.equal(f.bindings.length, 1); release.resolve(); await work; await runtime.close();
});

test("runtime and actual encrypted journal preserve poll intent and reaction snapshot across reopen", async t => {
  const prefix = join(resolve(tmpdir()), "bound-action-runtime-");
  const stateDirectory = await mkdtemp(prefix), passphrase = "synthetic bound action journal passphrase";
  t.after(async () => { assert.ok(resolve(stateDirectory).startsWith(prefix)); await rm(stateDirectory, { recursive: true, force: true }); });
  const f = fixture();
  const create = () => createStandingBoundActionRuntime({ signal: f.controller.signal, stateDirectory, passphrase, binding, killed: () => false });
  const runtime = create(); runtime.begin({ requestRef: "request-1", primary, openActions: f.lease });
  const call = caller(runtime); assert.equal((await call("neurobro_create_poll", { ...poll, question: "PRIVATE synthetic poll" })).verdict, "verified");
  assert.equal((await call(...cases[3]!)).verdict, "verified"); await runtime.close();
  for (const operationSlot of [0, 1]) {
    const slotBinding = { accountId: binding.accountId, chatId: binding.peerId, primaryMessageId: primary.messageId, operationSlot };
    const directory = join(stateDirectory, "action-journal"), journal = await openStandingActionJournal({ directory, passphrase, binding: slotBinding });
    const observed = await journal.inspect(); assert.equal(observed.state, "verified"); assert.equal(observed.intent!.requestRef, "request-1");
    assert.equal((observed.intent!.action as { kind: string }).kind, operationSlot === 0 ? "create-poll" : "read-reactions");
    assert.deepEqual(observed.terminal!.result, { verdict: "verified", snapshot: { messageRef: ref, count: 2 } }); await journal.close();
    const slotPath = join(directory, standingActionKey(slotBinding));
    for (const name of await readdir(slotPath)) assert.equal((await readFile(join(slotPath, name), "utf8")).includes("PRIVATE"), false);
  }
  const next = create(); next.begin({ requestRef: "request-2", primary, openActions: f.lease });
  assert.equal((await caller(next, "request-2")(...cases[0]!)).verdict, "refused"); assert.equal(next.state().blocked, true);
  assert.equal(f.executions(), 2); await next.close();
});
