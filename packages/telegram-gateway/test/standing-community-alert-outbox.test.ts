import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  openStandingCommunityAlertOutbox,
  StandingCommunityAlertOutboxError,
  type StandingCommunityAlertBinding,
  type StandingCommunityAlertLease,
  type StandingCommunityAlertPolicySnapshot,
} from "../src/standing-community-alert-outbox.js";
import { decryptSession, encryptSession } from "../src/session-crypto.js";

const passphrase = "synthetic-community-alert-outbox-passphrase";
const binding: StandingCommunityAlertBinding = Object.freeze({ workspaceId: "team-assistant-test", accountId: "123456789",
  internalPeerId: "-1001234567890", observedSourcePeerId: "-1002777888999" });
const text = "Новый вопрос в сообществе требует внимания.";
const caseKey = (seed: string | number): string => "obs_" + createHash("sha256").update(String(seed)).digest("hex").slice(0, 24);
const policy = (patch: Partial<StandingCommunityAlertPolicySnapshot> = {}): StandingCommunityAlertPolicySnapshot => Object.freeze({
  revision: 7, observationEnabled: true, alertsEnabled: true, observedSourcePeerId: binding.observedSourcePeerId, ...patch,
});
const refused = (code: StandingCommunityAlertOutboxError["code"]) => (error: unknown) => error instanceof StandingCommunityAlertOutboxError && error.code === code;

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix)), directory = join(root, "alerts");
  const outbox = await openStandingCommunityAlertOutbox({ directory, passphrase, binding });
  return { root, directory, outbox, async close() { await outbox.close(); await rm(root, { recursive: true, force: true }); } };
}

function lease(events: string[], patch: Partial<StandingCommunityAlertLease> = {}): StandingCommunityAlertLease {
  return Object.freeze({
    info: Object.freeze({ accountId: binding.accountId, internalPeerId: binding.internalPeerId }),
    async sendOnce(input) { events.push("send:" + input.randomId); assert.equal(input.text, text); return Object.freeze({ messageId: 401 }); },
    async readExact(messageId) { events.push("read"); return Object.freeze({ messageId, chatId: binding.internalPeerId, accountId: binding.accountId,
      fromId: binding.accountId, out: true, text, replyToMessageId: null, media: false, post: false }); },
    async close() { events.push("close"); },
    ...patch,
  });
}

function delivery(overrides: Record<string, unknown> = {}) {
  const events: string[] = [], controller = new AbortController();
  return { events, controller, input: { caseKey: caseKey("one"), policyRevision: 7, text, signal: controller.signal,
    async openAlert() { events.push("open"); return lease(events); },
    async refreshPolicy() { events.push("policy"); return policy(); }, ...overrides } };
}

test("reserves before the last policy check, sends once, joins and admits only exact readback", async () => {
  const f = await fixture("community-alert-verified-");
  try {
    let persistedRandomId = "";
    const d = delivery({ async openAlert() {
      d.events.push("open");
      const encrypted = await readFile(join(f.directory, "community-alert-ledger.enc"), "utf8");
      const ledger = JSON.parse(await decryptSession(encrypted, passphrase));
      assert.equal(ledger.cases[0].state, "reserved"); persistedRandomId = ledger.cases[0].randomId;
      return lease(d.events, { async sendOnce(input) { assert.equal(input.randomId, persistedRandomId); d.events.push("send:" + input.randomId); return { messageId: 401 }; } });
    }, async refreshPolicy() {
      d.events.push("policy");
      const encrypted = await readFile(join(f.directory, "community-alert-ledger.enc"), "utf8");
      const ledger = JSON.parse(await decryptSession(encrypted, passphrase));
      assert.equal(ledger.cases[0].state, "sending");
      assert.equal(ledger.cases[0].text, text);
      assert.match(ledger.cases[0].randomId, /^[1-9]\d{0,18}$/u);
      assert.ok(BigInt(ledger.cases[0].randomId) <= 9_223_372_036_854_775_807n);
      assert.equal(ledger.cases[0].randomId, persistedRandomId);
      return policy();
    } });
    const result = await f.outbox.deliver(d.input);
    assert.deepEqual(d.events.map(value => value.replace(/send:\d+/u, "send")), ["open", "policy", "send", "read", "close"]);
    assert.equal(result.state, "verified"); assert.equal(result.messageId, 401); assert.equal(result.reason, "verified");
    assert.deepEqual(await f.outbox.status(), { used: 1, maximum: 256, full: false });
    assert.deepEqual(await f.outbox.recent({ limit: 1 }), [result]);
    const cipher = await readFile(join(f.directory, "community-alert-ledger.enc"), "utf8");
    assert.equal(cipher.includes(text), false);

    await f.outbox.close();
    const reopened = await openStandingCommunityAlertOutbox({ directory: f.directory, passphrase, binding });
    let callbacks = 0;
    const replay = await reopened.deliver({ ...d.input, async openAlert() { callbacks++; throw new Error("must not open"); }, async refreshPolicy() { callbacks++; return policy(); } });
    assert.deepEqual(replay, result); assert.equal(callbacks, 0); await reopened.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("disabled or changed policy immediately before wire is terminal not-sent", async () => {
  for (const [snapshot, reason] of [[policy({ alertsEnabled: false }), "policy-disabled"], [policy({ revision: 8 }), "policy-changed"],
    [policy({ observedSourcePeerId: "-1002666777888" }), "policy-changed"]] as const) {
    const f = await fixture("community-alert-policy-");
    try {
      const events: string[] = [];
      const result = await f.outbox.deliver({ caseKey: caseKey(reason + snapshot.revision + snapshot.observedSourcePeerId), policyRevision: 7, text,
        signal: new AbortController().signal, async openAlert() { events.push("open"); return lease(events, { async sendOnce() { assert.fail("wire invoked"); } }); },
        async refreshPolicy() { events.push("policy"); return snapshot; } });
      assert.equal(result.state, "not-sent"); assert.equal(result.reason, reason); assert.deepEqual(events, ["open", "policy", "close"]);
    } finally { await f.close(); }
  }
});

test("cancellation before lease and lease-open failure are consumed without a send", async () => {
  const f = await fixture("community-alert-presend-");
  try {
    const stopped = new AbortController(); stopped.abort(); let calls = 0;
    const cancelled = await f.outbox.deliver({ caseKey: caseKey("cancelled"), policyRevision: 7, text, signal: stopped.signal,
      async openAlert() { calls++; throw new Error("must not open"); }, async refreshPolicy() { calls++; return policy(); } });
    assert.equal(cancelled.state, "not-sent"); assert.equal(cancelled.reason, "cancelled"); assert.equal(calls, 0);
    const unavailable = await f.outbox.deliver({ caseKey: caseKey("unavailable"), policyRevision: 7, text, signal: new AbortController().signal,
      async openAlert() { calls++; throw new Error("offline"); }, async refreshPolicy() { calls++; return policy(); } });
    assert.equal(unavailable.state, "not-sent"); assert.equal(unavailable.reason, "lease-unavailable"); assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("a destination-mismatched lease is joined and cannot send", async () => {
  const f = await fixture("community-alert-lease-binding-");
  try {
    let sends = 0, closes = 0;
    const result = await f.outbox.deliver({ caseKey: caseKey("wrong-destination"), policyRevision: 7, text, signal: new AbortController().signal,
      async openAlert() { return Object.freeze({ ...lease([]), info: Object.freeze({ accountId: binding.accountId, internalPeerId: binding.observedSourcePeerId }),
        async sendOnce() { sends++; return { messageId: 1 }; }, async close() { closes++; } }); }, async refreshPolicy() { return policy(); } });
    assert.equal(result.state, "not-sent"); assert.equal(result.reason, "lease-refused"); assert.equal(sends, 0); assert.equal(closes, 1);
  } finally { await f.close(); }
});

test("send, readback and close ambiguity persist unknown and never replay", async () => {
  const cases: ReadonlyArray<Readonly<{ name: string; patch: Partial<StandingCommunityAlertLease>; reason: string }>> = [
    { name: "send", patch: { async sendOnce() { throw new Error("uncertain"); } }, reason: "send-unknown" },
    { name: "read", patch: { async readExact() { return null; } }, reason: "readback-unknown" },
    { name: "mismatch", patch: { async readExact(messageId) { return { messageId, chatId: binding.observedSourcePeerId, accountId: binding.accountId,
      fromId: binding.accountId, out: true, text, replyToMessageId: null, media: false, post: false }; } }, reason: "readback-unknown" },
    { name: "close", patch: { async close() { throw new Error("join failed"); } }, reason: "close-unknown" },
  ];
  for (const item of cases) {
    const f = await fixture("community-alert-unknown-");
    try {
      const events: string[] = [], key = caseKey(item.name);
      const result = await f.outbox.deliver({ caseKey: key, policyRevision: 7, text, signal: new AbortController().signal,
        async openAlert() { return lease(events, item.patch); }, async refreshPolicy() { return policy(); } });
      assert.equal(result.state, "unknown"); assert.equal(result.reason, item.reason);
      let opened = 0;
      const duplicate = await f.outbox.deliver({ caseKey: key, policyRevision: 7, text, signal: new AbortController().signal,
        async openAlert() { opened++; return lease([]); }, async refreshPolicy() { opened++; return policy(); } });
      assert.deepEqual(duplicate, result); assert.equal(opened, 0);
    } finally { await f.close(); }
  }
});

test("readback demands own exact internal plain text without reply, media or post", async () => {
  const fields: Array<[string, unknown]> = [["fromId", "999"], ["out", false], ["text", text + "!"], ["replyToMessageId", 12], ["media", true], ["post", true]];
  for (const [field, value] of fields) {
    const f = await fixture("community-alert-readback-");
    try {
      const events: string[] = [], base = await lease(events).readExact(401); assert.ok(base);
      const result = await f.outbox.deliver({ caseKey: caseKey(field), policyRevision: 7, text, signal: new AbortController().signal,
        async openAlert() { return lease(events, { async readExact() { return Object.freeze({ ...base, [field]: value }) as never; } }); },
        async refreshPolicy() { return policy(); } });
      assert.equal(result.state, "unknown"); assert.equal(result.reason, "readback-unknown");
    } finally { await f.close(); }
  }
});

test("concurrent duplicate delivery serializes to one wire attempt", async () => {
  const f = await fixture("community-alert-concurrent-");
  try {
    let sends = 0; const key = caseKey("concurrent");
    const input = { caseKey: key, policyRevision: 7, text, signal: new AbortController().signal,
      async openAlert() { return lease([], { async sendOnce() { sends++; await new Promise(resolve => setTimeout(resolve, 10)); return { messageId: 401 }; } }); },
      async refreshPolicy() { return policy(); } };
    const [one, two] = await Promise.all([f.outbox.deliver(input), f.outbox.deliver(input)]);
    assert.equal(sends, 1); assert.deepEqual(one, two); assert.equal(one.state, "verified");
  } finally { await f.close(); }
});

test("a valid external ledger replacement after lease open fails the pre-wire CAS and joins with zero sends", async () => {
  const f = await fixture("community-alert-cas-");
  try {
    let sends = 0, closes = 0;
    const input = { caseKey: caseKey("cas"), policyRevision: 7, text, signal: new AbortController().signal,
      async openAlert() {
        const path = join(f.directory, "community-alert-ledger.enc"), ledger = JSON.parse(await decryptSession(await readFile(path, "utf8"), passphrase));
        assert.equal(ledger.cases[0].state, "reserved"); ledger.generation++;
        await writeFile(path, await encryptSession(JSON.stringify(ledger), passphrase), "utf8");
        return lease([], { async sendOnce() { sends++; return { messageId: 401 }; }, async close() { closes++; } });
      }, async refreshPolicy() { assert.fail("policy must not run"); return policy(); } };
    await assert.rejects(f.outbox.deliver(input), refused("storage")); assert.equal(sends, 0); assert.equal(closes, 1);
    await assert.rejects(f.outbox.status(), refused("storage"));
  } finally { await f.outbox.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an interrupted reserved or sending record is consumed on restart", async () => {
  for (const state of ["reserved", "sending"] as const) {
    const f = await fixture("community-alert-interrupted-");
    try {
      const d = delivery(); await f.outbox.deliver({ ...d.input, caseKey: caseKey(state) }); await f.outbox.close();
      const path = join(f.directory, "community-alert-ledger.enc"), ledger = JSON.parse(await decryptSession(await readFile(path, "utf8"), passphrase));
      ledger.cases[0].state = state; delete ledger.cases[0].settledAt; delete ledger.cases[0].reason; delete ledger.cases[0].messageId;
      await writeFile(path, await encryptSession(JSON.stringify(ledger), passphrase), "utf8");
      const reopened = await openStandingCommunityAlertOutbox({ directory: f.directory, passphrase, binding }); let opened = 0;
      const result = await reopened.deliver({ ...d.input, caseKey: caseKey(state), async openAlert() { opened++; return lease([]); } });
      assert.equal(opened, 0); assert.equal(result.state, state === "reserved" ? "not-sent" : "unknown");
      assert.equal(result.reason, state === "reserved" ? "interrupted-before-send" : "interrupted-after-dispatch-began"); await reopened.close();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("same source case cannot change its policy revision or fixed text", async () => {
  const f = await fixture("community-alert-conflict-");
  try {
    const d = delivery(); await f.outbox.deliver(d.input);
    await assert.rejects(f.outbox.deliver({ ...d.input, policyRevision: 8 }), refused("conflict"));
    await assert.rejects(f.outbox.deliver({ ...d.input, text: text + " Ещё." }), refused("conflict"));
  } finally { await f.close(); }
});

test("fixed 256-case capacity never evicts and is surfaced explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "community-alert-capacity-")), directory = join(root, "alerts");
  try {
    await mkdir(directory, { mode: 0o700 });
    const now = Date.now(), cases = Array.from({ length: 256 }, (_, index) => ({ caseKey: caseKey(index), policyRevision: 7, text,
      textHash: createHash("sha256").update(text).digest("hex"), randomId: String(index + 1), reservedAt: now, state: "not-sent",
      settledAt: now, reason: "cancelled" }));
    const ledger = { domain: "DecadansNeurobro/standing-community-alert-outbox/v1", binding, generation: 1, cases };
    await writeFile(join(directory, "community-alert-ledger.enc"), await encryptSession(JSON.stringify(ledger), passphrase), "utf8");
    const outbox = await openStandingCommunityAlertOutbox({ directory, passphrase, binding });
    assert.deepEqual(await outbox.status(), { used: 256, maximum: 256, full: true });
    const d = delivery({ caseKey: caseKey("overflow") });
    await assert.rejects(outbox.deliver(d.input), refused("capacity")); assert.equal(d.events.length, 0);
    assert.equal((await outbox.recent({ limit: 32 })).length, 32); await outbox.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scope tampering, malformed callbacks and hostile input fail closed before wire", async () => {
  const f = await fixture("community-alert-input-");
  try {
    const d = delivery(); let invoked = 0;
    await assert.rejects(f.outbox.deliver({ ...d.input, caseKey: "not-an-observed-ref", async openAlert() { invoked++; return lease([]); } }), refused("input"));
    await assert.rejects(f.outbox.deliver({ ...d.input, text: "x".repeat(901), async openAlert() { invoked++; return lease([]); } }), refused("input"));
    const getter = Object.defineProperty({ ...d.input }, "text", { enumerable: true, get() { invoked++; return text; } });
    await assert.rejects(f.outbox.deliver(getter as never), refused("input")); assert.equal(invoked, 0);
    await f.outbox.deliver(d.input); await f.outbox.close();
    const path = join(f.directory, "community-alert-ledger.enc"), ledger = JSON.parse(await decryptSession(await readFile(path, "utf8"), passphrase));
    ledger.binding.internalPeerId = binding.observedSourcePeerId;
    await writeFile(path, await encryptSession(JSON.stringify(ledger), passphrase), "utf8");
    await assert.rejects(openStandingCommunityAlertOutbox({ directory: f.directory, passphrase, binding }), error =>
      error instanceof StandingCommunityAlertOutboxError && ["binding", "storage"].includes(error.code));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("close aborts and joins an admitted lease operation", async () => {
  const f = await fixture("community-alert-close-"); let release!: () => void, openedSignal!: AbortSignal;
  const entered = new Promise<void>(resolve => { release = resolve; }); let leaseClosed = false;
  const pending = f.outbox.deliver({ caseKey: caseKey("close-join"), policyRevision: 7, text, signal: new AbortController().signal,
    async openAlert({ signal }) { openedSignal = signal; return lease([], { async sendOnce() { release(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); return { messageId: 1 }; },
      async close() { leaseClosed = true; } }); }, async refreshPolicy() { return policy(); } });
  await entered; const closing = f.outbox.close(); await closing; const result = await pending;
  assert.equal(openedSignal.aborted, true); assert.equal(leaseClosed, true); assert.equal(result.state, "unknown");
  await assert.rejects(f.outbox.status(), refused("closed")); await rm(f.root, { recursive: true, force: true });
});
