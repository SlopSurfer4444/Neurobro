import test from "node:test";
import assert from "node:assert/strict";
import { BOUND_ACTION_TOOL_SPECS, createBoundActionTools, type BoundActionRequest } from "../src/bound-action-tools.js";
import { createStandingToolDispatcher, type EpochToolResult, type EpochToolScope } from "../src/standing-tool-dispatcher.js";

const ref = "m_" + "a".repeat(24);
const poll = () => ({ question: "Что выберем?", options: ["Чай", "Кофе"], anonymous: true, type: "single" });

test("durable discovery and resolution expose only exact scoped selectors", async () => {
  const f = setup();
  const objectRef = "obj_" + "a".repeat(48), cursor = "cur_" + "b".repeat(48);
  for (const args of [{ kind: "poll" }, { kind: "poll", query: "😀".repeat(64), cursor, limit: 10 }])
    assert.equal((await f.call(9, args) as EpochToolResult).success, true);
  assert.equal((await f.call(10, { objectRef }) as EpochToolResult).success, true);
  assert.deepEqual(f.calls[2], { kind: "resolve-object", objectRef });
  const before = f.calls.length;
  for (const args of [{ kind: "file" }, { kind: "poll", chatId: "-1" }, { kind: "poll", query: "😀".repeat(65) },
    { kind: "poll", query: " leading" }, { kind: "poll", cursor: "../slot" }, { kind: "poll", limit: 0 },
    { kind: "poll", limit: 1.5 }, { kind: "poll", limit: 11 }, { kind: "poll", query: undefined }])
    assert.equal(decode(await f.call(9, args)).code, "invalid-arguments");
  for (const args of [{ objectRef: "1234" }, { objectRef, pollId: "1234" }, { objectRef, record: {} }])
    assert.equal(decode(await f.call(10, args)).code, "invalid-arguments");
  assert.equal(f.calls.length, before); await f.tools.close();
});
const decode = (value: unknown) => JSON.parse((value as EpochToolResult).contentItems[0].text) as Record<string, unknown>;
function setup(execute?: (request: BoundActionRequest, scope: EpochToolScope) => Promise<unknown>) {
  const control = new AbortController(), calls: BoundActionRequest[] = [];
  const scope = { requestRef: "request1", callRef: "call1", signal: control.signal };
  const tools = createBoundActionTools({ signal: control.signal, execute: async (request, scoped) => {
    calls.push(request); return execute ? execute(request, scoped) : { verdict: "verified", status: "observed" };
  } });
  return { control, scope, tools, calls, call: (i: number, args: unknown, scoped = scope) => tools.handlers[i]!.call(args, scoped) };
}

test("five immutable named schemas route real dispatcher calls to exact request unions", async () => {
  const f = setup(), dispatcher = createStandingToolDispatcher({ call: async () => { throw Error(); } }, f.tools.handlers);
  assert.deepEqual(BOUND_ACTION_TOOL_SPECS.slice(0, 5).map(s => s.name), ["neurobro_create_poll", "neurobro_read_poll", "neurobro_close_poll", "neurobro_read_reactions", "neurobro_set_reaction"]);
  for (const spec of BOUND_ACTION_TOOL_SPECS) { assert.ok(Object.isFrozen(spec)); assert.ok(Object.isFrozen(spec.inputSchema.properties)); assert.equal(spec.inputSchema.additionalProperties, false); }
  const args = [poll(), { messageRef: ref }, { messageRef: ref }, { messageRef: ref }, { messageRef: ref, emoji: null }];
  for (let i = 0; i < args.length; i++) assert.equal((await dispatcher.call(BOUND_ACTION_TOOL_SPECS[i]!.name, args[i], f.scope)).success, true);
  assert.deepEqual(f.calls, [{ kind: "create-poll", poll: poll() }, { kind: "read-poll", messageRef: ref }, { kind: "close-poll", messageRef: ref }, { kind: "read-reactions", messageRef: ref }, { kind: "set-reaction", messageRef: ref, emoji: null }]);
  await dispatcher.close(); await f.tools.close();
});

test("single, multiple and quiz poll constraints preserve UTF16 limits and exact options", async () => {
  const f = setup();
  for (const args of [poll(), { ...poll(), type: "multiple" }, { ...poll(), type: "quiz", correctOption: 1, explanation: "Кофе" },
    { ...poll(), question: "😀".repeat(127) + "x", options: ["😀".repeat(50), "я".repeat(100)] }]) assert.equal((await f.call(0, args) as EpochToolResult).success, true);
  const before = f.calls.length;
  for (const args of [{ ...poll(), type: "quiz" }, { ...poll(), correctOption: 0 }, { ...poll(), explanation: undefined },
    { ...poll(), type: "quiz", correctOption: 2 }, { ...poll(), type: "quiz", correctOption: 0.5 },
    { ...poll(), type: "quiz", correctOption: 0, explanation: "" }, { ...poll(), options: ["x", "x"] },
    { ...poll(), question: "😀".repeat(128) }, { ...poll(), options: ["😀".repeat(51), "y"] },
    { ...poll(), options: ["x"] }, { ...poll(), options: Array.from({ length: 11 }, (_, i) => String(i)) },
    { ...poll(), question: " leading" }, { ...poll(), question: "line\nline" }, { ...poll(), question: "\ud800" }])
    assert.equal(decode(await f.call(0, args)).code, "invalid-arguments");
  assert.equal(f.calls.length, before); await f.tools.close();
});

test("only opaque refs and exact argument keys reach host, null clears reaction", async () => {
  const f = setup();
  for (const i of [1, 2, 3, 4]) for (const messageRef of ["123", "m_" + "A".repeat(24), "m_" + "a".repeat(25), 123])
    assert.equal(decode(await f.call(i, { messageRef, ...(i === 4 ? { emoji: "👍" } : {}) })).code, "invalid-arguments");
  for (const extra of [{ chatId: "123" }, { accountId: "1" }, { messageId: 123 }, { operationSlot: 1 }])
    assert.equal(decode(await f.call(1, { messageRef: ref, ...extra })).code, "invalid-arguments");
  for (const emoji of ["", " ", "👍 👍", "\ud800", "a".repeat(65)]) assert.equal(decode(await f.call(4, { messageRef: ref, emoji })).code, "invalid-arguments");
  assert.equal(f.calls.length, 0);
  for (const emoji of [null, "👍", "❤️"]) assert.equal((await f.call(4, { messageRef: ref, emoji }) as EpochToolResult).success, true);
  await f.tools.close();
});

test("proxies, getters, sparse arrays and exotic scope never invoke caller code or ports", async () => {
  const f = setup(); let traps = 0;
  const proxy = new Proxy(poll(), { getPrototypeOf() { traps++; throw Error(); } });
  const getter = { ...poll(), get question() { traps++; return "x"; } };
  const options = ["x", "y"]; Object.defineProperty(options, "0", { get() { traps++; return "x"; }, enumerable: true });
  const sparse = new Array(2); sparse[1] = "x";
  for (const args of [proxy, getter, { ...poll(), options }, { ...poll(), options: sparse }, { ...poll(), options: new Proxy(["x", "y"], { get() { traps++; throw Error(); } }) }])
    assert.equal(decode(await f.call(0, args)).code, "invalid-arguments");
  const scope = new Proxy(f.scope, { getPrototypeOf() { traps++; throw Error(); } });
  assert.equal(decode(await f.call(0, poll(), scope)).code, "invalid-scope");
  assert.equal(traps, 0); assert.equal(f.calls.length, 0); await f.tools.close();
});

test("arguments and scope are snapshotted and deeply frozen before deferred execution", async () => {
  let seen: EpochToolScope | undefined;
  const f = setup(async (request, scope) => { seen = scope; assert.ok(Object.isFrozen(request)); if (request.kind === "create-poll") { assert.ok(Object.isFrozen(request.poll)); assert.ok(Object.isFrozen(request.poll.options)); } return { verdict: "verified" }; });
  const args = poll(), scope = { ...f.scope }, work = f.call(0, args, scope);
  args.question = "changed"; args.options[0] = "changed"; scope.requestRef = "changed";
  assert.equal((await work as EpochToolResult).success, true); assert.deepEqual(f.calls[0], { kind: "create-poll", poll: poll() }); assert.equal(seen?.requestRef, "request1"); await f.tools.close();
});

test("only verified is success; host semantics remain exact and unknown is not retried", async () => {
  for (const verdict of ["verified", "refused", "unknown"]) {
    const body = { verdict, status: "unchanged", availability: "partial", counts: [{ emoji: "👍", count: 2 }], messageRef: ref };
    const f = setup(async () => body), result = await f.call(3, { messageRef: ref }) as EpochToolResult;
    assert.equal(result.success, verdict === "verified"); assert.deepEqual(decode(result), body); assert.equal(f.calls.length, 1);
    body.counts[0]!.count = 99; assert.equal((decode(result).counts as { count: number }[])[0]!.count, 2); await f.tools.close();
  }
});

test("malformed, oversized and executable host results refuse without leaking errors", async () => {
  let traps = 0;
  const getter = { verdict: "verified", get secret() { traps++; return "secret"; } };
  const deep: Record<string, unknown> = { verdict: "verified" }; let cursor = deep; for (let i = 0; i < 18; i++) { cursor.child = {}; cursor = cursor.child as Record<string, unknown>; }
  for (const body of [{ success: true }, { verdict: "failed_terminal" }, { verdict: "verified", n: NaN }, { verdict: "verified", n: 2 ** 53 },
    { verdict: "verified", text: "\u0000".repeat(12000) }, { verdict: "verified", text: "x".repeat(65537) },
    { verdict: "verified", values: Array(4096).fill(null) }, getter, deep, new Proxy({ verdict: "verified" }, { getPrototypeOf() { traps++; throw Error(); } })]) {
    const f = setup(async () => body), result = await f.call(1, { messageRef: ref });
    assert.equal(decode(result).code, "unavailable"); assert.equal(JSON.stringify(result).includes("secret"), false); await f.tools.close();
  }
  const f = setup(async () => { throw Error("C:/private token=secret"); }); assert.equal(decode(await f.call(1, { messageRef: ref })).code, "unavailable"); await f.tools.close(); assert.equal(traps, 0);
});

test("single busy lane and close join actual operation after abort without publishing late success", async () => {
  let release!: () => void, entered!: () => void, signal: AbortSignal | undefined, closed = false;
  const pending = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { entered = resolve; });
  const f = setup(async (_request, scope) => { signal = scope.signal; entered(); await pending; return { verdict: "verified" }; });
  const work = f.call(4, { messageRef: ref, emoji: "👍" }); await began;
  assert.equal(decode(await f.call(1, { messageRef: ref })).code, "busy");
  const closing = f.tools.close().then(() => { closed = true; }); await Promise.resolve();
  assert.equal(signal?.aborted, true); assert.equal(closed, false); assert.equal(f.calls.length, 1);
  release(); assert.equal(decode(await work).code, "stopped"); await closing;
  assert.equal(decode(await f.call(1, { messageRef: ref })).code, "stopped"); assert.equal(f.calls.length, 1);
});

test("scope cancellation joins pending port and abort before admission never executes", async () => {
  let release!: () => void, entered!: () => void, settled = false;
  const hold = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { entered = r; });
  const f = setup(async (_request, scope) => { entered(); await hold; assert.equal(scope.signal.aborted, true); return { verdict: "unknown" }; });
  const local = new AbortController(), work = f.call(1, { messageRef: ref }, { ...f.scope, signal: local.signal }).then(v => { settled = true; return v; });
  await began; local.abort(); await Promise.resolve(); assert.equal(settled, false); release(); assert.equal(decode(await work).code, "stopped");
  assert.equal(decode(await f.call(1, { messageRef: ref }, { ...f.scope, signal: local.signal })).code, "stopped"); assert.equal(f.calls.length, 1); await f.tools.close();
});

test("three own-profile names append exact schemas and preserve omitted versus empty surname", async () => {
  const f = setup(), dispatcher = createStandingToolDispatcher({ call: async () => { throw Error(); } }, f.tools.handlers);
  assert.deepEqual(BOUND_ACTION_TOOL_SPECS.slice(5, 8).map(s => s.name), ["neurobro_self_profile", "neurobro_set_display_name", "neurobro_set_avatar"]);
  assert.deepEqual(BOUND_ACTION_TOOL_SPECS[5].inputSchema, { type: "object", additionalProperties: false, properties: {}, required: [] });
  assert.deepEqual(BOUND_ACTION_TOOL_SPECS[6].inputSchema.required, ["firstName"]);
  const artifactRef = "art_" + "a".repeat(48);
  const cases = [[5, {}], [6, { firstName: "Нейробро" }], [6, { firstName: "Neurobro", lastName: "" }],
    [6, { firstName: "😀".repeat(32), lastName: "я".repeat(64) }], [7, { artifactRef }]] as const;
  for (const [index, args] of cases) assert.equal((await dispatcher.call(BOUND_ACTION_TOOL_SPECS[index].name, args, f.scope)).success, true);
  assert.deepEqual(f.calls, [{ kind: "read-self-profile" }, { kind: "set-display-name", firstName: "Нейробро" },
    { kind: "set-display-name", firstName: "Neurobro", lastName: "" }, { kind: "set-display-name", firstName: "😀".repeat(32), lastName: "я".repeat(64) }, { kind: "set-avatar", artifactRef }]);
  assert.equal(Object.hasOwn(f.calls[1]!, "lastName"), false); assert.equal(Object.hasOwn(f.calls[2]!, "lastName"), true);
  await dispatcher.close(); await f.tools.close();
});

test("own-profile arguments reject selectors, paths, invalid names, getters and proxies", async () => {
  const f = setup(), artifactRef = "art_" + "b".repeat(48); let traps = 0;
  for (const extra of [{ userId: "123" }, { accountId: "123" }, { chatId: "-123" }, { operationSlot: 0 }, { fileId: "123" }, { path: "C:/avatar.png" }]) {
    assert.equal(decode(await f.call(5, extra)).code, "invalid-arguments");
    assert.equal(decode(await f.call(6, { firstName: "Name", ...extra })).code, "invalid-arguments");
    assert.equal(decode(await f.call(7, { artifactRef, ...extra })).code, "invalid-arguments");
  }
  for (const firstName of ["", " ", " leading", "trailing ", "a\n", "\ud800", "я".repeat(65), "😀".repeat(33)])
    assert.equal(decode(await f.call(6, { firstName })).code, "invalid-arguments");
  for (const lastName of [null, undefined, " ", "trailing ", "x\0", "\ud800", "😀".repeat(33)])
    assert.equal(decode(await f.call(6, { firstName: "Name", lastName })).code, "invalid-arguments");
  for (const value of ["file:///avatar.png", "art_" + "A".repeat(48), "art_" + "a".repeat(49), 123])
    assert.equal(decode(await f.call(7, { artifactRef: value })).code, "invalid-arguments");
  const getter = { firstName: "Name", get lastName() { traps++; return "Surname"; } };
  assert.equal(decode(await f.call(6, getter)).code, "invalid-arguments");
  const avatar = { get artifactRef() { traps++; return artifactRef; } };
  assert.equal(decode(await f.call(7, avatar)).code, "invalid-arguments");
  for (const index of [5, 6, 7]) {
    const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw Error(); } });
    assert.equal(decode(await f.call(index, proxy)).code, "invalid-arguments");
  }
  assert.equal(traps, 0); assert.equal(f.calls.length, 0); await f.tools.close();
});

test("profile arguments freeze before host execution and share the existing STOP/busy lane", async () => {
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(r => { release = r; }), began = new Promise<void>(r => { entered = r; });
  const f = setup(async request => { assert.ok(Object.isFrozen(request)); entered(); await hold; return { verdict: "unknown" }; });
  const args = { firstName: "Name", lastName: "" }, work = f.call(6, args); args.firstName = "changed"; args.lastName = "changed"; await began;
  assert.deepEqual(f.calls[0], { kind: "set-display-name", firstName: "Name", lastName: "" });
  assert.equal(decode(await f.call(5, {})).code, "busy"); assert.equal(decode(await f.call(1, { messageRef: ref })).code, "busy");
  const closed = f.tools.close(); release(); assert.equal(decode(await work).code, "stopped"); await closed;
  assert.equal(decode(await f.call(7, { artifactRef: "art_" + "c".repeat(48) })).code, "stopped"); assert.equal(f.calls.length, 1);
});

test("group avatar appends one exact artifact-only tool and rejects all selectors", async () => {
  const f = setup(), artifactRef = "art_" + "e".repeat(48);
  assert.equal(BOUND_ACTION_TOOL_SPECS[8].name, "neurobro_set_group_avatar");
  assert.equal((await f.call(8, { artifactRef }) as EpochToolResult).success, true);
  assert.deepEqual(f.calls, [{ kind: "set-group-avatar", artifactRef }]);
  for (const extra of [{ chatId: "-99" }, { accountId: "1" }, { fileId: "3" }, { path: "avatar.png" }, { operationSlot: 0 }])
    assert.equal(decode(await f.call(8, { artifactRef, ...extra })).code, "invalid-arguments");
  assert.equal(decode(await f.call(8, { artifactRef: "art_wrong" })).code, "invalid-arguments");
  let traps = 0;
  assert.equal(decode(await f.call(8, { get artifactRef() { traps++; return artifactRef; } })).code, "invalid-arguments");
  assert.equal(traps, 0); assert.equal(f.calls.length, 1); await f.tools.close();
});
