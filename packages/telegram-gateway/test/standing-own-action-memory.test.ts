import assert from "node:assert/strict";
import test from "node:test";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationReferences } from "../src/conversation-references.js";
import { createEncryptedPilotStore, runPilotReply, type PilotRecord } from "../src/pilot-outbox.js";
import { openStandingOwnActionMemory, requireStandingOwnActionContext } from "../src/standing-own-action-memory.js";
import type { StandingOwnActionSource } from "../src/standing-own-action-projection.js";
import { createGeneratedImageRegistry } from "../src/generated-image-artifact.js";
import { generatedImageDeliveryKey, generatedImagePlanHash, type ImageDeliveryPlan } from "../src/generated-image-outbox.js";
import { createStandingArtifactRegistry } from "../src/standing-artifact.js";
import { artifactDeliveryKey, artifactDeliveryPlanHash, type ArtifactDeliveryPlan } from "../src/standing-artifact-outbox.js";

const binding = { accountId: "999", peerId: "-100123" }, primary = { chatId: binding.peerId, ownerId: "123", messageId: 1000, text: "What did you do?" };
const passphrase = "invented own action memory passphrase", scopeRef = "scope_" + "a".repeat(32), asOf = 1700000000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function pilot(n = 1, state: PilotRecord["state"] = "verified"): Extract<StandingOwnActionSource,{family:"pilot"}> {
  const reply = { chatId: binding.peerId, replyToMessageId: n, text: "Own synthetic response " + n }, contentHash = hash(reply.text);
  return { family: "pilot", reply, record: { version: "pilot-outbox-v1", state, accountId: binding.accountId, chatId: binding.peerId,
    replyToMessageId: n, randomId: String(n + 1000), contentHash, textBytes: Buffer.byteLength(reply.text),
    idempotencyKey: hash(JSON.stringify([binding.peerId, "owner-prompt", n, "reply", contentHash])), ...(state === "verified" ? { messageId: n + 100 } : {}) } };
}
async function fixture(secret = passphrase, scope = scopeRef) {
  const references = createConversationReferences(binding), abort = new AbortController();
  const memory = await openStandingOwnActionMemory({ binding, passphrase: secret, references, scopeRef: scope, signal: abort.signal });
  return { memory, references, abort, close() { memory.close(); references.close(); } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
test("long full-text Russian primary retains exact own-action context binding", async () => {
  const f = await fixture(), selected = { ...primary, text: "я".repeat(4095) + " конец" };
  try {
    f.memory.observe({ slot: "one", source: pilot() });
    const page = f.memory.forPrimary({ primary: selected, asOf });
    assert.equal(page.source.items.length, 1);
    assert.equal(requireStandingOwnActionContext(page, selected, f.references, { scopeRef, asOf }), page);
    assert.throws(() => requireStandingOwnActionContext(page, { ...selected, text: selected.text.slice(0, 2048) }, f.references, { scopeRef, asOf }));
    assert.throws(() => f.memory.forPrimary({ primary: { ...selected, text: "я".repeat(8193) }, asOf }));
  } finally { f.close(); }
});
test("actual persisted Pilot records populate one latest slot view; UNKNOWN and absent dates stay honest", async () => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), "neurobro-own-memory-"));
  try {
    for (const state of ["verified", "unknown"] as const) {
      const store = createEncryptedPilotStore(join(root, state), passphrase), reply = { chatId: binding.peerId, replyToMessageId: 10, text: "Persisted " + state };
      const publish = (record: PilotRecord) => f.memory.observe({ slot: state, source: { family: "pilot", record, reply } });
      const result = await runPilotReply({ approved: { accountId: binding.accountId, chatId: binding.peerId, replyToMessageId: 10, maximumTextBytes: 4096 }, reply,
        signal: f.abort.signal, killSwitchEngaged: () => false,
        store: { async reserve(record) { await store.reserve(record); publish(record); }, async append(record) { await store.append(record); publish(record); } },
        transport: { async sendOnce() { if (state === "unknown") throw Error("synthetic lost acknowledgement"); return { messageId: 100 }; },
          async readExact() { return { ...reply, accountId: binding.accountId, messageId: 100 }; } } });
      assert.equal(result.state, state);
    }
    const page = f.memory.forPrimary({ primary, asOf }); assert.equal(page.source.items.length, 2);
    assert.deepEqual(page.source.items.map(i => i.verdict), ["unknown", "verified"]);
    assert.equal(page.source.items[0]!.effect, "not-proven");
    for (const view of page.source.items) { assert.equal(view.observedAt, null); assert.equal(view.serverDate, null); assert.equal(view.currentAvailability, "not-checked"); }
    assert.equal(page.source.coverage.freshness, "stale"); assert.equal(page.source.coverage.hasMore, null);
    for (const key of ["accountId", "chatId", "messageId", "randomId", "contentHash", "referenceKey"]) assert.ok(!JSON.stringify(page).includes(key));
  } finally { f.close(); }
});
test("same persisted terminal has stable actionRef across reconnect; passphrase changes identity", async () => {
  const first = await fixture(), second = await fixture(passphrase, "scope_" + "b".repeat(32)), different = await fixture(passphrase + " changed");
  try {
    for (const f of [first, second, different]) f.memory.observe({ slot: "durable-slot", source: pilot() });
    const a = first.memory.forPrimary({ primary, asOf }).source.items[0]!;
    assert.equal(second.memory.forPrimary({ primary, asOf }).source.items[0]!.actionRef, a.actionRef);
    assert.notEqual(different.memory.forPrimary({ primary, asOf }).source.items[0]!.actionRef, a.actionRef);
  } finally { first.close(); second.close(); different.close(); }
});
test("groupwide own actions can reach another actor only through a new exact-primary bound page", async () => {
  const f = await fixture();
  try {
    f.memory.observe({ slot: "one", source: pilot() });
    const own = f.memory.forPrimary({ primary, asOf }), otherPrimary = { ...primary, ownerId: "456", messageId: 1001 };
    const other = f.memory.forPrimary({ primary: otherPrimary, asOf: asOf + 1 });
    assert.equal(own.source.items[0]!.actionRef, other.source.items[0]!.actionRef);
    assert.equal(requireStandingOwnActionContext(other, otherPrimary, f.references, { scopeRef, asOf: asOf + 1 }), other);
    assert.throws(() => requireStandingOwnActionContext(own, otherPrimary, f.references, { scopeRef, asOf }));
    assert.throws(() => requireStandingOwnActionContext({ ...own }, primary, f.references, { scopeRef, asOf }));
    assert.throws(() => requireStandingOwnActionContext(own, primary, f.references, { scopeRef, asOf: asOf + 1 }));
    assert.throws(() => requireStandingOwnActionContext(own, primary, f.references, { scopeRef: "scope_" + "c".repeat(32), asOf }));
    f.memory.close(); assert.throws(() => requireStandingOwnActionContext(own, primary, f.references, { scopeRef, asOf }));
  } finally { f.close(); }
});
test("32 latest slots and eight selected views remain bounded, with no complete inventory claim", async () => {
  const f = await fixture();
  try {
    assert.equal(f.memory.forPrimary({ primary, asOf }).source.coverage.availability, "unavailable");
    for (let n = 1; n <= 40; n++) f.memory.observe({ slot: "slot-" + n, source: pilot(n) });
    const result = f.memory.forPrimary({ primary, asOf });
    assert.equal(result.source.coverage.scanned, 32); assert.equal(result.source.items.length, 8);
    assert.deepEqual(result.source.items.map(i => i.content.kind === "text" ? i.content.text : null), Array.from({ length: 8 }, (_, i) => "Own synthetic response " + (40 - i)));
    assert.equal(result.source.coverage.omittedAtSource, null); assert.equal(result.source.coverage.hasMore, null);
    f.memory.observe({ slot: "slot-40", source: pilot(40, "unknown") });
    assert.equal(f.memory.forPrimary({ primary, asOf }).source.coverage.scanned, 32);
    assert.equal(f.memory.forPrimary({ primary, asOf }).source.items[0]!.verdict, "unknown");
  } finally { f.close(); }
});
test("malformed or foreign producer records refuse without invoking properties; close ignores late callbacks", async () => {
  const f = await fixture(); let executed = 0;
  try {
    const hostile = { ...pilot() }; Object.defineProperty(hostile, "family", { enumerable: true, get() { executed++; return "pilot"; } });
    assert.throws(() => f.memory.observe({ slot: "one", source: hostile }));
    const source = pilot(); assert.throws(() => f.memory.observe({ slot: "one", source: { ...source, record: { ...source.record, accountId: "888" } } }));
    assert.throws(() => f.memory.observe({ slot: "private/path", source }));
    assert.equal(executed, 0); assert.equal(f.memory.forPrimary({ primary, asOf }).source.items.length, 0);
    f.abort.abort(); f.memory.close(); f.memory.close(); f.memory.observe({ slot: "one", source });
    assert.throws(() => f.memory.forPrimary({ primary, asOf }));
  } finally { f.close(); }
});
test("abort during actual scrypt waits for its callback and wipes password and derived key", async () => {
  const original = crypto.scrypt, entered = deferred(), release = deferred(); let derivedKey: Buffer | undefined, passwordCopy: Buffer | undefined;
  crypto.scrypt = ((password: crypto.BinaryLike, salt: crypto.BinaryLike, length: number, callback: (error: Error | null, key: Buffer) => void) => {
    if (Buffer.isBuffer(password)) passwordCopy = password;
    original(password, salt, length, (error, key) => { derivedKey = key; entered.resolve(); void release.promise.then(() => callback(error, key)); });
  }) as typeof crypto.scrypt; syncBuiltinESMExports();
  const references = createConversationReferences(binding), abort = new AbortController(); let settled = false;
  const pending = openStandingOwnActionMemory({ binding, passphrase, references, scopeRef, signal: abort.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await entered.promise; abort.abort(); await Promise.resolve(); assert.equal(settled, false);
    assert.ok(derivedKey?.some(byte => byte !== 0)); release.resolve(); await assert.rejects(pending);
    assert.ok(derivedKey?.every(byte => byte === 0)); assert.ok(passwordCopy?.every(byte => byte === 0));
  } finally { release.resolve(); await pending.catch(() => {}); crypto.scrypt = original; syncBuiltinESMExports(); references.close(); }
});
test("normal close wipes actual retained scrypt key and revokes previously issued pages", async () => {
  const original = crypto.scrypt; let derivedKey: Buffer | undefined;
  crypto.scrypt = ((password: crypto.BinaryLike, salt: crypto.BinaryLike, length: number, callback: (error: Error | null, key: Buffer) => void) => {
    original(password, salt, length, (error, key) => { derivedKey = key; callback(error, key); });
  }) as typeof crypto.scrypt; syncBuiltinESMExports();
  const f = await fixture();
  try {
    assert.ok(derivedKey?.some(byte => byte !== 0));
    f.memory.observe({ slot: "one", source: pilot() }); const page = f.memory.forPrimary({ primary, asOf });
    f.memory.close(); assert.ok(derivedKey?.every(byte => byte === 0));
    assert.throws(() => requireStandingOwnActionContext(page, primary, f.references, { scopeRef, asOf }));
  } finally { f.close(); crypto.scrypt = original; syncBuiltinESMExports(); }
});

function textPilot(n: number, text: string, state: PilotRecord["state"] = "verified"): Extract<StandingOwnActionSource, { family: "pilot" }> {
  const source = pilot(n, state), contentHash = hash(text);
  return { ...source, reply: { ...source.reply!, text }, record: { ...source.record, contentHash, textBytes: Buffer.byteLength(text),
    idempotencyKey: hash(JSON.stringify([binding.peerId, "owner-prompt", n, "reply", contentHash])) } };
}
function selectedText(page: ReturnType<Awaited<ReturnType<typeof fixture>>["memory"]["forPrimary"]>) {
  return page.source.items.map(item => item.content.kind === "text" ? item.content.text : item.content.kind);
}

test("query lifts an old matching action beyond the recent eight while retaining the two newest actions", async () => {
  const f = await fixture();
  try {
    f.memory.observe({ slot: "old-match", source: textPilot(1, "Архивный астролябий готов") });
    for (let n = 2; n <= 12; n++) f.memory.observe({ slot: "recent-" + n, source: textPilot(n, "Свежая запись " + n) });
    const before = f.memory.forPrimary({ primary, asOf });
    assert.equal(selectedText(before).includes("Архивный астролябий готов"), false);
    const query = { ...primary, text: "Найди астролябий" }, selected = f.memory.forPrimary({ primary: query, asOf });
    assert.deepEqual(selectedText(selected), ["Архивный астролябий готов", "Свежая запись 12", "Свежая запись 11", "Свежая запись 10", "Свежая запись 9", "Свежая запись 8", "Свежая запись 7", "Свежая запись 6"]);
    assert.equal(new Set(selected.source.items.map(item => item.actionRef)).size, 8);
    assert.deepEqual(selected.source.coverage, before.source.coverage);
    assert.equal(requireStandingOwnActionContext(selected, query, f.references, { scopeRef, asOf }), selected);
    assert.deepEqual(f.memory.forPrimary({ primary, asOf }).source, before.source);
    assert.deepEqual(f.memory.forPrimary({ primary: query, asOf }).source, selected.source);
  } finally { f.close(); }
});

test("empty token sets, function words and absent matches preserve the exact previous recent-eight page", async () => {
  const f = await fixture();
  try {
    for (let n = 1; n <= 12; n++) f.memory.observe({ slot: "fallback-" + n, source: textPilot(n, "Документ архивный " + n) });
    const before = f.memory.forPrimary({ primary, asOf }).source;
    assert.deepEqual(before.items.map(item => item.content.kind === "text" ? item.content.text : null), Array.from({ length: 8 }, (_, i) => "Документ архивный " + (12 - i)));
    for (const text of ["?! 123456", "Что ты мне можешь сейчас пожалуйста?", "what did you do for me", "Несуществующий телескоп"]) {
      assert.deepEqual(f.memory.forPrimary({ primary: { ...primary, text }, asOf }).source, before);
    }
  } finally { f.close(); }
});

test("rare unique query terms outrank common terms without a repeated-word advantage", async () => {
  const f = await fixture();
  try {
    const texts = ["Астролябия", "Компас ".repeat(40).trim(), "Компас восточный", "Компас западный", "Компас северный", "Свежая шестая", "Свежая седьмая"];
    texts.forEach((text, index) => f.memory.observe({ slot: "rank-" + index, source: textPilot(index + 1, text) }));
    const selected = f.memory.forPrimary({ primary: { ...primary, text: "астролябия компас" }, asOf });
    assert.deepEqual(selectedText(selected), [texts[0], texts[4], texts[3], texts[2], texts[1], texts[6], texts[5]]);
    const repeated = f.memory.forPrimary({ primary: { ...primary, text: "компас ".repeat(40) + "астролябия" }, asOf });
    assert.deepEqual(repeated.source, selected.source);
  } finally { f.close(); }
});

test("Unicode NFKC and ё normalization recall old text without changing UNKNOWN evidence", async () => {
  const f = await fixture();
  try {
    f.memory.observe({ slot: "unknown-old", source: textPilot(1, "Ёлка ＭＯＯＮ", "unknown") });
    const original = f.memory.forPrimary({ primary, asOf }).source.items[0]!;
    for (let n = 2; n <= 11; n++) f.memory.observe({ slot: "unicode-" + n, source: textPilot(n, "Новая заметка " + n) });
    for (const text of ["елка moon", "Е\u0308ЛКА ｍｏｏｎ", "ЁЛКА MOON"]) {
      const selected = f.memory.forPrimary({ primary: { ...primary, text }, asOf });
      assert.deepEqual(selected.source.items[0], original);
      assert.equal(selected.source.items[0]!.verdict, "unknown"); assert.equal(selected.source.items[0]!.effect, "not-proven");
      assert.equal(selected.source.items[0]!.identityKnown, false); assert.equal(selected.source.items[0]!.currentAvailability, "not-checked");
    }
  } finally { f.close(); }
});

test("three to eight cached actions can prioritize a match, but queries do not refresh eviction order", async () => {
  const f = await fixture();
  try {
    f.memory.observe({ slot: "oldest", source: textPilot(1, "Хризолит старинный") });
    f.memory.observe({ slot: "second", source: textPilot(2, "Свежий второй") });
    const query = { ...primary, text: "Хризолит" };
    assert.deepEqual(selectedText(f.memory.forPrimary({ primary: query, asOf })), ["Свежий второй", "Хризолит старинный"]);
    f.memory.observe({ slot: "third", source: textPilot(3, "Свежий третий") });
    assert.deepEqual(selectedText(f.memory.forPrimary({ primary: query, asOf })), ["Хризолит старинный", "Свежий третий", "Свежий второй"]);
    for (let n = 4; n <= 32; n++) f.memory.observe({ slot: "entry-" + n, source: textPilot(n, "Заметка " + n) });
    assert.equal(selectedText(f.memory.forPrimary({ primary: query, asOf }))[0], "Хризолит старинный");
    f.memory.observe({ slot: "entry-33", source: textPilot(33, "Заметка 33") });
    assert.equal(selectedText(f.memory.forPrimary({ primary: query, asOf })).includes("Хризолит старинный"), false);
    assert.equal(f.memory.forPrimary({ primary, asOf }).source.coverage.scanned, 32);
  } finally { f.close(); }
});

test("recall uses visible filename, captions, poll options and profile names rather than private source metadata", async () => {
  const f = await fixture(), requestRef = "private-request", artifacts = createStandingArtifactRegistry({ requestRef });
  const origin = { requestRef, threadId: "private-thread", turnId: "private-turn", itemId: "hiddenoriginmarker" };
  const images = createGeneratedImageRegistry({ requestRef, threadId: origin.threadId, turnId: origin.turnId });
  try {
    const ownBinding = { accountId: binding.accountId, chatId: binding.peerId }, approved = { ...ownBinding, replyToMessageId: 900, operationSlot: 0, requestRef };
    const artifact = artifacts.accept({ source: { kind: "generated", reference: "hiddensourcemarker" }, filename: "Янтарный-отчет.txt", mimeType: "text/plain", bytes: Buffer.from("Private payload") });
    const filePlan: ArtifactDeliveryPlan = { version: "standing-artifact-delivery-v1", key: artifactDeliveryKey(approved), approved, artifact, caption: "Кедровая ведомость", randomId: "2001" };
    f.memory.observe({ slot: "old-file", source: { family: "artifact", plan: filePlan, terminal: { key: filePlan.key, planHash: artifactDeliveryPlanHash(filePlan), state: "verified", acknowledgement: { messageId: 901, documentId: "12345" } } } });
    const photo = images.acceptCompleted(origin, { id: origin.itemId, type: "imageGeneration", status: "completed", result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" });
    const photoApproved = { ...ownBinding, replyToMessageId: 900, origin };
    const photoPlan: ImageDeliveryPlan = { version: "generated-image-delivery-v1", key: generatedImageDeliveryKey(photoApproved), generation: "completed", approved: photoApproved, artifact: photo, caption: "Сапфировая иллюстрация", randomId: "2002" };
    f.memory.observe({ slot: "old-photo", source: { family: "generated-image", plan: photoPlan, terminal: { key: photoPlan.key, planHash: generatedImagePlanHash(photoPlan), state: "verified", messageId: 902, photoId: "54321" } } });
    const actionBinding = { ...ownBinding, primaryMessageId: 900, operationSlot: 1 }, poll = { question: "Сирень цветёт?", options: ["Гранат", "Берилл"], anonymous: true, type: "single" as const };
    f.memory.observe({ slot: "old-poll", source: { family: "bound-action", binding: actionBinding, intent: { requestRef, randomId: "2003", action: { kind: "create-poll", poll } }, terminal: { state: "verified", result: { verdict: "verified", code: "verified" }, privateObjectEvidence: {
      schema: "standing-poll-object-v1", kind: "poll", objectRef: "obj_" + "c".repeat(48), observedAt: asOf - 10,
      record: { schema: "owned-bound-poll-v1", operationId: "bound-action-2003", randomId: "2003", ...ownBinding, replyToMessageId: 900, messageId: 903, pollId: "-12345", poll } } } } });
    f.memory.observe({ slot: "old-profile", source: { family: "bound-action", binding: { ...actionBinding, operationSlot: 2 }, intent: { requestRef, randomId: "2004", action: { kind: "read-self-profile" } },
      terminal: { state: "verified", result: { verdict: "verified", profile: { firstName: "Мирослав", lastName: "Лунный", hasPhoto: true } } } } });
    for (let n = 5; n <= 13; n++) f.memory.observe({ slot: "visible-fill-" + n, source: textPilot(n, "Последняя заметка " + n) });
    const baseline = f.memory.forPrimary({ primary, asOf }).source;
    for (const [text, expectedKind] of [["янтарный", "artifact"], ["кедровая", "artifact"], ["сапфировая", "photo"], ["сирень", "poll"], ["берилл", "poll"], ["мирослав", "self-profile"], ["лунный", "self-profile"]] as const) {
      const selected = f.memory.forPrimary({ primary: { ...primary, text }, asOf });
      assert.equal(selected.source.items[0]!.content.kind, expectedKind);
      assert.equal(selected.source.items.length, 8); assert.deepEqual(selectedText(selected).slice(1, 3), ["Последняя заметка 13", "Последняя заметка 12"]);
    }
    for (const text of ["hiddensourcemarker", "hiddenoriginmarker", "artifact verified", "12345"]) {
      assert.deepEqual(f.memory.forPrimary({ primary: { ...primary, text }, asOf }).source, baseline);
    }
  } finally { artifacts.close(); images.close(); f.close(); }
});
