import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash, scryptSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { assertPilotPrivateDirectory, createEncryptedPilotStore, isPilotDeliveryDiagnostic, PilotPreDispatchError, runPilotReply, tagPilotTaskSendError, type PilotDeliveryDiagnostic, type PilotDirectoryInspection, type PilotReadback, type PilotRecord, type PilotReplyInput } from "../src/pilot-outbox.js";
import type { TelegramTextEntity } from "../src/telegram-text-format.js";

function setup() {
  const events: string[] = [];
  const records: PilotRecord[] = [];
  let claimed = false;
  let sends = 0;
  const controller = new AbortController();
  const readback: PilotReadback = { messageId: 901, chatId: "-123", accountId: "456", replyToMessageId: 789, text: "Invented pilot reply" };
  const input: PilotReplyInput = {
    approved: { chatId: "-123", accountId: "456", replyToMessageId: 789, maximumTextBytes: 256 },
    reply: { chatId: "-123", replyToMessageId: 789, text: readback.text },
    signal: controller.signal,
    killSwitchEngaged: () => false,
    store: {
      async reserve(record) { if (claimed) throw new Error("existing"); claimed = true; records.push(record); events.push(record.state); },
      async append(record) { records.push(record); events.push(record.state); },
    },
    transport: {
      async sendOnce(sent) {
        sends++;
        if (records.length) {
          assert.equal(events.at(-1), "sending");
          assert.deepEqual(sent, { ...input.reply, randomId: records[0]!.randomId });
        }
        events.push("send");
        return { messageId: 901 };
      },
      async readExact(chat, id) { assert.equal(chat, "-123"); assert.equal(id, 901); events.push("read"); return readback; },
    },
  };
  return { input, events, records, controller, sends: () => sends, readback };
}

test("persists planned and sending before exactly one send and one fresh matching readback", async () => {
  const f = setup();
  assert.deepEqual(await runPilotReply(f.input), { state: "verified", code: "verified" });
  assert.deepEqual(f.events, ["planned", "sending", "send", "read", "verified"]);
  assert.equal(f.sends(), 1);
  assert.match(f.records[0]!.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.ok(BigInt(f.records[0]!.randomId) > 0n && BigInt(f.records[0]!.randomId) < 2n ** 63n);
  assert.equal(JSON.stringify(f.records).includes(f.input.reply.text), false);
  assert.equal(f.records[2]!.messageId, 901);
  assert.deepEqual(await runPilotReply(f.input), { state: "refused", code: "store-refused" });
  assert.equal(f.sends(), 1);
});

test("legacy absence preserves exact content hash, idempotency and send property shape", async () => {
  const f = setup();
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const contentHash = hash(f.input.reply.text);
  const send = f.input.transport.sendOnce;
  f.input.transport.sendOnce = async (reply, signal) => {
    assert.deepEqual(Object.keys(reply).sort(), ["chatId", "randomId", "replyToMessageId", "text"]);
    return send(reply, signal);
  };
  assert.equal((await runPilotReply(f.input)).state, "verified");
  assert.equal(f.records[0]!.contentHash, contentHash);
  assert.equal(f.records[0]!.idempotencyKey, hash(JSON.stringify(["-123", "owner-prompt", 789, "reply", contentHash])));
});

test("explicit task policy records an actual standalone wire reply while retaining original task identity", async () => {
  for (const detached of [false, true]) {
    const f = setup(); f.input.approved = { ...f.input.approved, taskReplyPolicy: "standalone-if-exact-missing" };
    f.input.transport.readExact = async () => detached ? { ...f.readback, replyToMessageId: null, taskReplyOriginMessageId: 789 } : f.readback;
    assert.deepEqual(await runPilotReply(f.input), { state: "verified", code: "verified" });
    assert.equal(f.sends(), 1); assert.ok(f.records.every(record => record.replyToMessageId === 789));
    assert.equal(Object.hasOwn(f.records[0]!, "wireReplyToMessageId"), false); assert.equal(Object.hasOwn(f.records[1]!, "wireReplyToMessageId"), false);
    assert.equal(Object.hasOwn(f.records[2]!, "wireReplyToMessageId"), detached);
    if (detached) assert.equal(f.records[2]!.wireReplyToMessageId, null);
    assert.equal(f.records[2]!.idempotencyKey, f.records[0]!.idempotencyKey);
  }
});

test("standalone task metadata never weakens default foreground or mismatched readback checks", async () => {
  for (const mode of ["default", "missing-origin", "wrong-origin", "anchored-origin", "wrong-text", "wrong-account", "invalid-origin"] as const) {
    const f = setup();
    if (mode !== "default") f.input.approved = { ...f.input.approved, taskReplyPolicy: "standalone-if-exact-missing" };
    const received: PilotReadback = { ...f.readback, replyToMessageId: null, taskReplyOriginMessageId: 789 };
    if (mode === "missing-origin") delete (received as { taskReplyOriginMessageId?: number }).taskReplyOriginMessageId;
    f.input.transport.readExact = async () => ({ ...received,
      ...(mode === "wrong-origin" ? { taskReplyOriginMessageId: 790 } : {}), ...(mode === "anchored-origin" ? { replyToMessageId: 789 } : {}),
      ...(mode === "wrong-text" ? { text: "different" } : {}), ...(mode === "wrong-account" ? { accountId: "457" } : {}), ...(mode === "invalid-origin" ? { taskReplyOriginMessageId: 0 } : {}) });
    assert.equal((await runPilotReply(f.input)).state, "unknown", mode);
    assert.ok(f.records.every(record => !Object.hasOwn(record, "wireReplyToMessageId")));
    assert.equal((await runPilotReply(f.input)).code, "store-refused"); assert.equal(f.sends(), 1);
  }
  for (const policy of [undefined, "always", null]) {
    const f = setup(); f.input.approved = { ...f.input.approved, taskReplyPolicy: policy } as PilotReplyInput["approved"];
    assert.deepEqual(await runPilotReply(f.input), { state: "refused", code: "input-refused" }); assert.equal(f.sends(), 0);
  }
  const greeting = setup(); greeting.input.approved = { ...greeting.input.approved, replyToMessageId: null, taskReplyPolicy: "standalone-if-exact-missing" };
  greeting.input.reply = { ...greeting.input.reply, replyToMessageId: null };
  assert.equal((await runPilotReply(greeting.input)).code, "input-refused");
});

test("formatted reply uses UTF16 emoji spans and hashes text plus normalized entities before send", async () => {
  const f = setup();
  const text = "😀 bold";
  const entities: readonly TelegramTextEntity[] = [{ type: "bold", offset: 3, length: 4 }];
  f.input.reply = { ...f.input.reply, text, entities };
  f.input.transport.readExact = async () => ({ ...f.readback, text, entities });
  assert.equal((await runPilotReply(f.input)).state, "verified");
  const expected = createHash("sha256").update(JSON.stringify(["DecadansNeurobro/pilot-formatted-text/v1", text, entities])).digest("hex");
  assert.equal(f.records[0]!.contentHash, expected);
  assert.equal(f.records[0]!.textBytes, Buffer.byteLength(text));
  assert.equal(JSON.stringify(f.records).includes(text), false);
});

test("entity identity includes absence, empty formatting, span and type without changing text", async () => {
  const hashes: string[] = [];
  for (const entities of [undefined, [], [{ type: "bold", offset: 0, length: 8 }], [{ type: "italic", offset: 0, length: 8 }], [{ type: "bold", offset: 1, length: 7 }]] as const) {
    const f = setup();
    if (entities !== undefined) {
      f.input.reply = { ...f.input.reply, entities };
      f.input.transport.readExact = async () => ({ ...f.readback, entities });
    }
    assert.equal((await runPilotReply(f.input)).state, "verified");
    hashes.push(f.records[0]!.contentHash);
  }
  assert.equal(new Set(hashes).size, hashes.length);
});

test("fresh entity mismatch, missing entities and invalid readback remain consumed unknown", async () => {
  const expected: readonly TelegramTextEntity[] = [{ type: "bold", offset: 0, length: 8 }];
  for (const entities of [undefined, [], [{ type: "italic", offset: 0, length: 8 }], [{ type: "bold", offset: 1, length: 7 }], [{ type: "bold", offset: 0, length: 999 }]] as const) {
    const f = setup();
    f.input.reply = { ...f.input.reply, entities: expected };
    f.input.transport.readExact = async () => ({ ...f.readback, ...(entities === undefined ? {} : { entities }) });
    assert.equal((await runPilotReply(f.input)).state, "unknown");
    assert.equal(f.records.at(-1)!.state, "unknown");
    assert.equal((await runPilotReply(f.input)).code, "store-refused");
    assert.equal(f.sends(), 1);
  }
});

test("equivalent entity ordering normalizes to the same durable identity and fresh proof", async () => {
  const ordered: readonly TelegramTextEntity[] = [{ type: "bold", offset: 0, length: 8 }, { type: "italic", offset: 9, length: 5 }];
  const hashes: string[] = [];
  for (const entities of [ordered, [...ordered].reverse()]) {
    const f = setup();
    f.input.reply = { ...f.input.reply, entities };
    f.input.transport.sendOnce = async sent => { assert.deepEqual(sent.entities, ordered); return { messageId: 901 }; };
    f.input.transport.readExact = async () => ({ ...f.readback, entities: [...ordered].reverse() });
    assert.equal((await runPilotReply(f.input)).state, "verified");
    hashes.push(f.records[0]!.idempotencyKey);
  }
  assert.equal(hashes[0], hashes[1]);
});

test("reply and entities are immutable snapshots before reserve awaits", async () => {
  const f = setup();
  const entities = [{ type: "bold" as const, offset: 0, length: 8 }];
  const reply = { ...f.input.reply, entities };
  f.input.reply = reply;
  let proceed!: () => void;
  const paused = new Promise<void>(done => { proceed = done; });
  const reserve = f.input.store.reserve;
  f.input.store.reserve = async record => { await paused; return reserve(record); };
  let actual: typeof f.input.reply | undefined;
  f.input.transport.sendOnce = async sent => {
    actual = sent;
    assert.ok(Object.isFrozen(sent) && Object.isFrozen(sent.entities) && Object.isFrozen(sent.entities![0]));
    return { messageId: 901 };
  };
  f.input.transport.readExact = async () => ({ ...f.readback, entities: [{ type: "bold", offset: 0, length: 8 }] });
  const pending = runPilotReply(f.input);
  reply.text = "mutated"; entities[0]!.offset = 4; entities.length = 0;
  f.input.reply = { ...reply, text: "replacement" };
  proceed();
  assert.equal((await pending).state, "verified");
  assert.equal(actual!.text, f.readback.text);
  assert.deepEqual(actual!.entities, [{ type: "bold", offset: 0, length: 8 }]);
});

test("accessors and proxies are refused without executing traps or reserving", async () => {
  for (const location of ["input", "reply", "approved", "entities", "entity", "entity-accessor", "text-accessor", "entities-accessor", "input-accessor"] as const) {
    const f = setup(); let invoked = 0;
    const trap = () => { invoked++; throw new Error("must not execute"); };
    const proxied = <T extends object>(value: T): T => new Proxy(value, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const entity = { type: "bold" as const, offset: 0, length: 8 };
    if (location === "reply") f.input.reply = proxied(f.input.reply);
    if (location === "approved") f.input.approved = proxied(f.input.approved);
    if (location === "entities") f.input.reply = { ...f.input.reply, entities: proxied([entity]) };
    if (location === "entity") f.input.reply = { ...f.input.reply, entities: [proxied(entity)] };
    if (location === "entity-accessor") {
      Object.defineProperty(entity, "type", { get: trap, enumerable: true });
      f.input.reply = { ...f.input.reply, entities: [entity] };
    }
    if (location === "text-accessor") Object.defineProperty(f.input.reply, "text", { get: trap, enumerable: true });
    if (location === "entities-accessor") Object.defineProperty(f.input.reply, "entities", { get: trap, enumerable: true });
    if (location === "input-accessor") Object.defineProperty(f.input, "reply", { get: trap, enumerable: true });
    assert.equal((await runPilotReply(location === "input" ? proxied(f.input) : f.input)).code, "input-refused", location);
    assert.equal(invoked, 0, location); assert.deepEqual(f.events, []);
  }
});

test("invalid optional entities and split surrogate offsets refuse before persistence", async () => {
  for (const entities of [undefined, null, [{ type: "bold", offset: 1, length: 1 }], [{ type: "bold", offset: 0, length: 99 }]]) {
    const f = setup();
    f.input.reply = { ...f.input.reply, text: "😀 ok", entities } as unknown as PilotReplyInput["reply"];
    assert.equal((await runPilotReply(f.input)).code, "input-refused"); assert.deepEqual(f.events, []);
  }
});

test("readback entity accessors cannot turn an unchecked response into verified", async () => {
  const f = setup(); let invoked = false;
  f.input.reply = { ...f.input.reply, entities: [] };
  f.input.transport.readExact = async () => Object.defineProperty({ ...f.readback }, "entities", { enumerable: true, get() { invoked = true; return []; } });
  assert.equal((await runPilotReply(f.input)).state, "unknown"); assert.equal(invoked, false);
});

test("exact chat/anchor allowlist and UTF8 byte bounds reject before reservation", async () => {
  const bad = [
    { chatId: "-124" }, { replyToMessageId: 788 }, { text: "" }, { text: "  " },
    { text: "я".repeat(129) }, { text: "\ud800" }, { text: "x\0y" },
  ];
  for (const change of bad) {
    const f = setup();
    f.input.reply = { ...f.input.reply, ...change };
    assert.equal((await runPilotReply(f.input)).code, "input-refused");
    assert.deepEqual(f.events, []);
  }
});

test("invalid approved account/anchor/ceiling cannot enable dispatch", async () => {
  for (const change of [{ accountId: "0" }, { chatId: "123" }, { replyToMessageId: 0 }, { maximumTextBytes: 0 }, { maximumTextBytes: 4097 }, { maximumTextBytes: NaN }]) {
    const f = setup(); f.input.approved = { ...f.input.approved, ...change };
    assert.equal((await runPilotReply(f.input)).state, "refused"); assert.equal(f.sends(), 0);
  }
});

test("kill switch and abort refuse before any durable attempt", async () => {
  for (const kind of ["kill", "throw", "abort"]) {
    const f = setup();
    if (kind === "abort") f.controller.abort();
    else f.input.killSwitchEngaged = () => { if (kind === "throw") throw new Error("private failure"); return true; };
    assert.equal((await runPilotReply(f.input)).code, "stopped-before-send"); assert.deepEqual(f.events, []);
  }
});

test("kill switch changed during planned or sending persistence prevents transport", async () => {
  for (const phase of ["planned", "sending"]) {
    const f = setup();
    f.input.killSwitchEngaged = () => f.events.includes(phase);
    assert.deepEqual(await runPilotReply(f.input), { state: "failed_terminal", code: "stopped-before-send" });
    assert.equal(f.sends(), 0); assert.equal(f.records.at(-1)!.state, "failed_terminal");
  }
});

test("reserve failure and uncertain sending persistence never send", async () => {
  const f = setup(); f.input.store.reserve = async () => { throw new Error("private failure"); };
  assert.deepEqual(await runPilotReply(f.input), { state: "refused", code: "store-refused" });
  assert.equal(f.sends(), 0);
  const g = setup(); g.input.store.append = async () => { throw new Error("sync failure"); };
  assert.deepEqual(await runPilotReply(g.input), { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-sending" });
  assert.equal(g.sends(), 0);
});

test("send failure is unknown and consumed even if server may already have accepted", async () => {
  const f = setup(); let attempts = 0;
  f.input.transport.sendOnce = async () => { attempts++; throw new Error("lost response"); };
  assert.equal((await runPilotReply(f.input)).state, "unknown");
  assert.equal(f.records.at(-1)!.state, "unknown");
  await runPilotReply(f.input); assert.equal(attempts, 1);
});

test("every exact readback field is required; null, edited or mismatched messages stay unknown", async () => {
  for (const change of [null, { messageId: 902 }, { chatId: "-124" }, { accountId: "457" }, { replyToMessageId: 788 }, { text: "different" }]) {
    const f = setup();
    f.input.transport.readExact = async () => change === null ? null : { ...f.readback, ...change };
    assert.equal((await runPilotReply(f.input)).state, "unknown");
    assert.equal(f.sends(), 1); assert.equal(f.records.at(-1)!.state, "unknown");
  }
});

test("invalid send acknowledgement does not initiate a read or retry", async () => {
  const f = setup(); f.input.transport.sendOnce = async () => ({ messageId: 0 });
  assert.equal((await runPilotReply(f.input)).state, "unknown"); assert.equal(f.events.includes("read"), false);
});

test("verified wire result with failed durable terminal write remains unknown", async () => {
  const f = setup(); const append = f.input.store.append;
  f.input.store.append = async record => { if (record.state === "verified") throw new Error("disk full"); return append(record); };
  assert.deepEqual(await runPilotReply(f.input), { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-verified" });
  assert.equal(f.records.at(-1)!.state, "sending");
  await runPilotReply(f.input); assert.equal(f.sends(), 1);
});

test("abort during unresolved transport returns unknown; late send resolution cannot initiate read", async () => {
  const f = setup(); let finish!: (value: { messageId: number }) => void;
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
  f.input.transport.sendOnce = () => { entered(); return new Promise(done => { finish = done; }); };
  const pending = runPilotReply(f.input); await started; f.controller.abort();
  assert.equal((await pending).state, "unknown"); finish({ messageId: 901 });
  await new Promise(done => setImmediate(done));
  assert.equal(f.events.includes("read"), false);
});

test("unknown diagnostics distinguish actual send and readback boundaries without leaking private data", async () => {
  for (const phase of ["send", "send-result", "readback", "readback-shape", "readback-mismatch"] as const) {
    const f = setup(); let sends = 0; let reads = 0;
    f.input.transport.sendOnce = async () => {
      sends++;
      if (phase === "send") throw new Error("invented PRIVATE credential and message text");
      return { messageId: phase === "send-result" ? 0 : 901 };
    };
    f.input.transport.readExact = async () => {
      reads++;
      if (phase === "readback") throw new Error("invented PRIVATE read error");
      if (phase === "readback-shape") return null;
      return { ...f.readback, text: "invented PRIVATE mismatch" };
    };
    const result = await runPilotReply(f.input);
    assert.deepEqual(result, { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: phase });
    assert.equal(isPilotDeliveryDiagnostic(result.deliveryDiagnostic), true);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    assert.equal(sends, 1); assert.equal(reads, phase === "send" || phase === "send-result" ? 0 : 1);
    assert.equal(f.records.at(-1)!.state, "unknown");
    assert.ok(f.records.every(record => !Object.hasOwn(record, "deliveryDiagnostic")));
    assert.deepEqual(await runPilotReply(f.input), { state: "refused", code: "store-refused" });
    assert.equal(sends, 1);
  }
});

test("malformed readback metadata and entity accessors diagnose shape without executing accessors", async () => {
  for (const kind of ["missing-field", "entity-accessor", "bad-entity"] as const) {
    const f = setup(); let invoked = 0;
    f.input.transport.readExact = async () => {
      if (kind === "missing-field") return { text: f.readback.text } as PilotReadback;
      if (kind === "bad-entity") return { ...f.readback, entities: [{ type: "bold", offset: 0, length: 999 }] };
      return Object.defineProperty({ ...f.readback }, "entities", { enumerable: true, get() { invoked++; return []; } });
    };
    assert.equal((await runPilotReply(f.input)).deliveryDiagnostic, "readback-shape");
    assert.equal(invoked, 0);
    assert.equal(f.sends(), 1);
  }
});

test("aborts retain the active send or readback boundary and cannot admit a late verification", async () => {
  for (const phase of ["send", "readback"] as const) {
    const f = setup(); let reads = 0;
    let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    let finish!: () => void;
    if (phase === "send") f.input.transport.sendOnce = () => { entered(); return new Promise(done => { finish = () => done({ messageId: 901 }); }); };
    f.input.transport.readExact = () => {
      reads++;
      if (phase === "readback") { entered(); return new Promise(done => { finish = () => done(f.readback); }); }
      return Promise.resolve(f.readback);
    };
    const pending = runPilotReply(f.input); await started; f.controller.abort("invented PRIVATE abort");
    assert.deepEqual(await pending, { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: phase });
    finish(); await new Promise(done => setImmediate(done));
    assert.equal(reads, phase === "send" ? 0 : 1);
    assert.equal(f.records.at(-1)!.state, "unknown");
    assert.equal(f.records.some(record => record.state === "verified"), false);
  }
});

test("uncertain persistence identifies the exact attempted state without a new send or terminal retry", async () => {
  for (const phase of ["sending", "verified", "failed_terminal", "unknown"] as const) {
    const f = setup(); const append = f.input.store.append; const attempted: string[] = [];
    if (phase === "failed_terminal") f.input.killSwitchEngaged = () => f.events.includes("planned");
    if (phase === "unknown") f.input.transport.readExact = async () => null;
    f.input.store.append = async record => {
      attempted.push(record.state);
      if (record.state === phase) throw new Error("invented PRIVATE uncertain sync");
      return append(record);
    };
    const diagnostic: PilotDeliveryDiagnostic = phase === "failed_terminal" ? "persist-failed-terminal" : `persist-${phase}`;
    assert.deepEqual(await runPilotReply(f.input), { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: diagnostic });
    assert.equal(attempted.filter(state => state === phase).length, 1);
    const expectedSends = phase === "sending" || phase === "failed_terminal" ? 0 : 1;
    assert.equal(f.sends(), expectedSends);
    f.input.killSwitchEngaged = () => false;
    assert.equal((await runPilotReply(f.input)).code, "store-refused");
    assert.equal(f.sends(), expectedSends);
  }
});

test("diagnostic validator accepts only the fixed vocabulary without coercion", () => {
  const valid = ["send", "send-result", "readback", "readback-shape", "readback-mismatch", "pre-dispatch-refused", "persist-sending", "persist-verified", "persist-failed-terminal", "persist-unknown",
    "task-preflight", "task-anchor-read", "task-anchor-validation", "task-send-rpc", "task-ack-parse"];
  for (const value of valid) assert.equal(isPilotDeliveryDiagnostic(value), true);
  let invoked = 0;
  for (const value of [undefined, null, 1, {}, [], "", "SEND", "send\n", "private error", { toString() { invoked++; return "send"; } }]) {
    assert.equal(isPilotDeliveryDiagnostic(value), false);
  }
  assert.equal(invoked, 0);
});

test("task send diagnostics preserve UNKNOWN and do not inspect arbitrary error properties", async () => {
  for (const diagnostic of ["task-preflight", "task-anchor-read", "task-anchor-validation", "task-send-rpc", "task-ack-parse"] as const) {
    const f = setup(); let accessed = 0;
    const error = Object.freeze(Object.defineProperty({}, "deliveryDiagnostic", { get() { accessed++; throw Error("PRIVATE"); } }));
    assert.equal(tagPilotTaskSendError(error, diagnostic), error);
    f.input.transport.sendOnce = async () => { throw error; };
    assert.deepEqual(await runPilotReply(f.input), { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: diagnostic });
    assert.equal(accessed, 0); assert.equal(f.records.at(-1)!.state, "unknown");
    assert.deepEqual(await runPilotReply(f.input), { state: "refused", code: "store-refused" });
  }
  const f = setup();
  f.input.transport.readExact = async () => { throw tagPilotTaskSendError(Error("PRIVATE"), "task-ack-parse"); };
  assert.equal((await runPilotReply(f.input)).deliveryDiagnostic, "readback", "send metadata cannot override a later failure boundary");
  const refused = setup();
  refused.input.transport.sendOnce = async () => { throw tagPilotTaskSendError(new PilotPreDispatchError(), "task-preflight"); };
  assert.deepEqual(await runPilotReply(refused.input), { state: "failed_terminal", code: "pre-dispatch-refused", deliveryDiagnostic: "pre-dispatch-refused" });
});

test("typed pre-dispatch refusal is terminal, skips readback and consumes the attempt", async () => {
  const f = setup(); let attempts = 0;
  f.input.transport.sendOnce = async () => { attempts++; throw new PilotPreDispatchError(); };
  f.input.transport.readExact = async () => { assert.fail("pre-dispatch refusal must not read back"); };
  assert.deepEqual(await runPilotReply(f.input), { state: "failed_terminal", code: "pre-dispatch-refused", deliveryDiagnostic: "pre-dispatch-refused" });
  assert.deepEqual(f.events, ["planned", "sending", "failed_terminal"]);
  assert.deepEqual(await runPilotReply(f.input), { state: "refused", code: "store-refused" });
  assert.equal(attempts, 1);
});

test("generic lookalike and readback typed errors remain unknown", async () => {
  for (const stage of ["send", "readback"] as const) {
    const f = setup();
    if (stage === "send") f.input.transport.sendOnce = async () => { throw new Error("PILOT_PRE_DISPATCH_REFUSED"); };
    else f.input.transport.readExact = async () => { throw new PilotPreDispatchError(); };
    assert.deepEqual(await runPilotReply(f.input), { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: stage });
    assert.equal(f.records.at(-1)!.state, "unknown");
  }
});

test("pre-dispatch terminal persistence failure preserves unknown and consumed budget", async () => {
  const f = setup(); let attempts = 0;
  f.input.transport.sendOnce = async () => { attempts++; throw new PilotPreDispatchError(); };
  const append = f.input.store.append;
  f.input.store.append = async record => { if (record.state === "failed_terminal") throw new Error("synthetic persistence failure"); await append(record); };
  assert.deepEqual(await runPilotReply(f.input), { state: "unknown", code: "persistence-unknown", deliveryDiagnostic: "persist-failed-terminal" });
  assert.deepEqual(await runPilotReply(f.input), { state: "refused", code: "store-refused" });
  assert.equal(attempts, 1);
});

test("proxy transport exception cannot execute prototype traps while classifying refusal", async () => {
  const f = setup(); let traps = 0;
  f.input.transport.sendOnce = async () => { throw new Proxy(new PilotPreDispatchError(), {
    getPrototypeOf() { traps++; throw new Error("untrusted prototype"); },
  }); };
  assert.deepEqual(await runPilotReply(f.input), { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: "send" });
  assert.equal(traps, 0);
});

test("abort racing an unsettled pre-dispatch operation stays unknown", async () => {
  const f = setup(); let entered!: () => void; let rejectSend!: (error: Error) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.input.transport.sendOnce = () => new Promise((_resolve, reject) => { rejectSend = reject; entered(); });
  const pending = runPilotReply(f.input); await ready; f.controller.abort();
  assert.deepEqual(await pending, { state: "unknown", code: "send-or-readback-unknown", deliveryDiagnostic: "send" });
  rejectSend(new PilotPreDispatchError());
  assert.equal(f.records.at(-1)!.state, "unknown");
});

test("parallel invocations share a one-send store budget", async () => {
  const f = setup(); const results = await Promise.all([runPilotReply(f.input), runPilotReply(f.input)]);
  assert.deepEqual(results.map(r => r.state).sort(), ["refused", "verified"]); assert.equal(f.sends(), 1);
});

test("explicit null greeting anchor persists as null and verifies only an unthreaded message", async () => {
  const f = setup();
  f.input.approved = { ...f.input.approved, replyToMessageId: null };
  f.input.reply = { ...f.input.reply, replyToMessageId: null };
  f.input.transport.readExact = async () => ({ ...f.readback, replyToMessageId: null });
  assert.equal((await runPilotReply(f.input)).state, "verified");
  assert.equal(f.records[0]!.replyToMessageId, null); assert.equal(f.records.at(-1)!.replyToMessageId, null);
  const positive = setup(); await runPilotReply(positive.input);
  assert.notEqual(f.records[0]!.idempotencyKey, positive.records[0]!.idempotencyKey);
  await runPilotReply(f.input); assert.equal(f.sends(), 1);
});

test("null is not zero, a missing anchor, a positive anchor or a mismatched readback", async () => {
  for (const positive of [false, true]) {
    const f = setup();
    f.input.approved = { ...f.input.approved, replyToMessageId: positive ? 789 : null };
    f.input.reply = { ...f.input.reply, replyToMessageId: positive ? null : 789 };
    assert.equal((await runPilotReply(f.input)).code, "input-refused"); assert.equal(f.sends(), 0);
    f.input.reply = { ...f.input.reply, replyToMessageId: f.input.approved.replyToMessageId };
    f.input.transport.readExact = async () => ({ ...f.readback, replyToMessageId: positive ? null : 789 });
    assert.equal((await runPilotReply(f.input)).state, "unknown"); assert.equal(f.sends(), 1);
  }
  const zero = setup(); zero.input.approved = { ...zero.input.approved, replyToMessageId: 0 }; zero.input.reply = { ...zero.input.reply, replyToMessageId: 0 };
  assert.equal((await runPilotReply(zero.input)).state, "refused"); assert.equal(zero.sends(), 0);
});

const passphrase = "invented test phrase only";
async function privateDirectory(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "neurobro-pilot-test-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith("neurobro-pilot-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function decrypt(path: string): Promise<PilotRecord> {
  const value = JSON.parse(await readFile(path, "utf8"));
  const key = scryptSync(passphrase, Buffer.from(value.salt, "base64"), 32);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from("DecadansNeurobro/pilot-outbox/v1"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8"));
  } finally { key.fill(0); }
}

test("pre-dispatch refusal persists existing encrypted terminal format and refuses after reopen", async t => {
  const parent = await privateDirectory(t), directory = join(parent, "pre-dispatch"), f = setup();
  f.input.store = createEncryptedPilotStore(directory, passphrase);
  let attempts = 0;
  f.input.transport.sendOnce = async () => { attempts++; throw new PilotPreDispatchError(); };
  assert.equal((await runPilotReply(f.input)).code, "pre-dispatch-refused");
  const terminal = await decrypt(join(directory, "terminal.enc"));
  assert.equal(terminal.state, "failed_terminal");
  assert.equal(Object.hasOwn(terminal, "deliveryDiagnostic"), false);
  assert.equal(Object.hasOwn(terminal, "messageId"), false);
  f.input.store = createEncryptedPilotStore(directory, passphrase);
  assert.deepEqual(await runPilotReply(f.input), { state: "refused", code: "store-refused" });
  assert.equal(attempts, 1);
});

test("real file store encrypts and syncs exclusive durable state slots, restart refuses", async t => {
  const parent = await privateDirectory(t); const directory = join(parent, "one-pilot"); const f = setup();
  f.input.store = createEncryptedPilotStore(directory, passphrase);
  const send = f.input.transport.sendOnce;
  f.input.transport.sendOnce = async (reply, signal) => {
    const durable = await decrypt(join(directory, "sending.enc"));
    assert.equal(durable.state, "sending"); assert.equal(durable.randomId, reply.randomId);
    return send(reply, signal);
  };
  assert.equal((await runPilotReply(f.input)).state, "verified");
  assert.deepEqual((await readdir(directory)).sort(), ["planned.enc", "sending.enc", "terminal.enc"]);
  const planned = await decrypt(join(directory, "planned.enc"));
  const sending = await decrypt(join(directory, "sending.enc"));
  const terminal = await decrypt(join(directory, "terminal.enc"));
  assert.equal(planned.state, "planned"); assert.equal(sending.state, "sending"); assert.equal(terminal.state, "verified");
  assert.equal(planned.randomId, terminal.randomId); assert.equal(sending.idempotencyKey, planned.idempotencyKey);
  assert.equal((await readFile(join(directory, "planned.enc"), "utf8")).includes("accountId"), false);
  const before = await readFile(join(directory, "terminal.enc"));
  f.input.store = createEncryptedPilotStore(directory, passphrase);
  assert.equal((await runPilotReply(f.input)).state, "refused"); assert.equal(f.sends(), 1);
  assert.deepEqual(await readFile(join(directory, "terminal.enc")), before);
});

test("encrypted standalone terminal records null wire anchor only after verification and remains consumed on reopen", async t => {
  const parent = await privateDirectory(t), directory = join(parent, "standalone"), f = setup();
  f.input.approved = { ...f.input.approved, taskReplyPolicy: "standalone-if-exact-missing" };
  f.input.store = createEncryptedPilotStore(directory, passphrase);
  f.input.transport.readExact = async () => ({ ...f.readback, replyToMessageId: null, taskReplyOriginMessageId: 789 });
  assert.equal((await runPilotReply(f.input)).state, "verified");
  const planned = await decrypt(join(directory, "planned.enc")), terminal = await decrypt(join(directory, "terminal.enc"));
  assert.equal(terminal.replyToMessageId, 789); assert.equal(terminal.wireReplyToMessageId, null);
  assert.equal(terminal.idempotencyKey, planned.idempotencyKey); assert.equal(terminal.randomId, planned.randomId);
  assert.equal(Object.hasOwn(planned, "wireReplyToMessageId"), false);
  f.input.store = createEncryptedPilotStore(directory, passphrase); assert.equal((await runPilotReply(f.input)).code, "store-refused"); assert.equal(f.sends(), 1);
  for (const state of ["planned", "sending", "unknown", "failed_terminal"] as const) {
    const store = createEncryptedPilotStore(join(parent, state), passphrase);
    if (state === "planned") await assert.rejects(store.reserve({ ...planned, wireReplyToMessageId: null }));
    else { await store.reserve(planned); await assert.rejects(store.append({ ...planned, state, wireReplyToMessageId: null })); }
  }
});

test("formatted identity is encrypted durably before send and cannot reopen after unknown readback", async t => {
  const parent = await privateDirectory(t); const directory = join(parent, "formatted-pilot"); const f = setup();
  const entities: readonly TelegramTextEntity[] = [{ type: "bold", offset: 0, length: 8 }];
  f.input.reply = { ...f.input.reply, entities };
  f.input.store = createEncryptedPilotStore(directory, passphrase);
  const expected = createHash("sha256").update(JSON.stringify(["DecadansNeurobro/pilot-formatted-text/v1", f.input.reply.text, entities])).digest("hex");
  let sends = 0;
  f.input.transport.sendOnce = async sent => {
    sends++;
    const durable = await decrypt(join(directory, "sending.enc"));
    assert.equal(durable.contentHash, expected); assert.equal(durable.randomId, sent.randomId);
    assert.deepEqual(sent.entities, entities);
    return { messageId: 901 };
  };
  // The real readback omitted formatting: persisted unknown must stay consumed.
  assert.equal((await runPilotReply(f.input)).state, "unknown");
  const terminal = await decrypt(join(directory, "terminal.enc"));
  assert.equal(terminal.state, "unknown"); assert.equal(terminal.contentHash, expected);
  f.input.store = createEncryptedPilotStore(directory, passphrase);
  f.input.transport.readExact = async () => ({ ...f.readback, entities });
  assert.equal((await runPilotReply(f.input)).code, "store-refused"); assert.equal(sends, 1);
});

test("empty, corrupt and arbitrary preexisting directory states are preserved", async t => {
  const parent = await privateDirectory(t);
  for (const name of ["empty", "partial", "unknown"]) {
    const directory = join(parent, name); await mkdir(directory);
    if (name !== "empty") await writeFile(join(directory, "sending.enc"), name);
    const f = setup(); f.input.store = createEncryptedPilotStore(directory, passphrase);
    assert.equal((await runPilotReply(f.input)).state, "refused"); assert.equal(f.sends(), 0);
    if (name !== "empty") assert.equal(await readFile(join(directory, "sending.enc"), "utf8"), name);
  }
});

test("process-crash images after planned, sending or unknown are consumed across fresh store objects", async t => {
  const parent = await privateDirectory(t); const sample = setup(); await runPilotReply(sample.input);
  for (const phase of ["planned", "sending", "unknown"] as const) {
    const directory = join(parent, phase); const store = createEncryptedPilotStore(directory, passphrase);
    await store.reserve(sample.records[0]!);
    if (phase !== "planned") await store.append(sample.records[1]!);
    if (phase === "unknown") await store.append({ ...sample.records[1]!, state: "unknown" });
    const f = setup(); f.input.store = createEncryptedPilotStore(directory, passphrase);
    assert.equal((await runPilotReply(f.input)).state, "refused"); assert.equal(f.sends(), 0);
  }
});

test("independent real store instances race for one exclusive attempt directory", async t => {
  const parent = await privateDirectory(t); const directory = join(parent, "race");
  const a = setup(); const b = setup();
  a.input.store = createEncryptedPilotStore(directory, passphrase); b.input.store = createEncryptedPilotStore(directory, passphrase);
  const results = await Promise.all([runPilotReply(a.input), runPilotReply(b.input)]);
  assert.deepEqual(results.map(r => r.state).sort(), ["refused", "verified"]); assert.equal(a.sends() + b.sends(), 1);
});

test("real store rejects identity changes and terminal transitions without overwriting evidence", async t => {
  const parent = await privateDirectory(t); const directory = join(parent, "tamper"); const f = setup(); await runPilotReply(f.input);
  const store = createEncryptedPilotStore(directory, passphrase); await store.reserve(f.records[0]!);
  await assert.rejects(store.append({ ...f.records[1]!, randomId: "1" }));
  assert.deepEqual(await readdir(directory), ["planned.enc"]);
  await assert.rejects(store.append(f.records[1]!));
  assert.throws(() => createEncryptedPilotStore("relative", passphrase));
  assert.throws(() => createEncryptedPilotStore(resolve(parent, "x"), "short"));
});

function virtualDirectory() {
  const logical = resolve(tmpdir(), "invented-logical-private-parent");
  const physical = resolve(tmpdir(), "invented-msix-private-backing");
  const metadata = { dev: 123n, ino: 9_007_199_254_740_993n, isDirectory: () => true, isSymbolicLink: () => false };
  const inspection: PilotDirectoryInspection = {
    platform: "win32", lstat: async () => ({ ...metadata }),
    realpath: async () => physical, realpathSync: () => logical,
  };
  return { logical, physical, metadata, inspection };
}

test("Windows MSIX logical/native alias accepts only matching positive directory identity", async () => {
  const f = virtualDirectory();
  await assert.doesNotReject(assertPilotPrivateDirectory(f.logical, f.inspection));
  const ordinary = virtualDirectory(); ordinary.inspection.realpath = async () => ordinary.logical;
  await assert.doesNotReject(assertPilotPrivateDirectory(ordinary.logical, ordinary.inspection));
});

test("private-directory alias guard refuses ordinary symlink ancestors, other OS aliases and identity changes", async () => {
  for (const kind of ["ancestor-link", "other-platform", "logical-link", "physical-link", "not-directory", "wrong-device", "wrong-inode", "zero-device", "zero-inode", "unreadable-physical"]) {
    const f = virtualDirectory();
    if (kind === "ancestor-link") f.inspection.realpathSync = () => f.physical;
    if (kind === "other-platform") f.inspection.platform = "linux";
    const base = f.inspection.lstat;
    f.inspection.lstat = async path => {
      if (kind === "unreadable-physical" && path === f.physical) throw new Error("inaccessible");
      const stat = await base(path);
      if ((kind === "logical-link" && path === f.logical) || (kind === "physical-link" && path === f.physical)) stat.isSymbolicLink = () => true;
      if (kind === "not-directory" && path === f.physical) stat.isDirectory = () => false;
      if (kind === "wrong-device" && path === f.physical) stat.dev += 1n;
      if (kind === "wrong-inode" && path === f.physical) stat.ino += 1n;
      if (kind === "zero-device") stat.dev = 0n;
      if (kind === "zero-inode") stat.ino = 0n;
      return stat;
    };
    await assert.rejects(assertPilotPrivateDirectory(f.logical, f.inspection), kind);
  }
});
