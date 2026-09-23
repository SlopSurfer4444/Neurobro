import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Api } from "telegram";
import bigInt from "big-integer";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import { createStandingCommunityObserver, type StandingCommunityObserverInput } from "../src/standing-community-observer.js";
import { openStandingCommunitySettings } from "../src/standing-community-settings.js";
import { openStandingCommunityObserverState } from "../src/standing-community-observer-state.js";
import { openStandingCommunityAlertOutbox } from "../src/standing-community-alert-outbox.js";
import { projectStandingObservedSourcePage } from "../src/standing-observed-source-reader.js";
import type { StandingIdleHistoryTicket } from "../src/standing-conversation-adapter.js";

const binding = { workspaceId: "synthetic-team", accountId: "123", internalPeerId: "-654321", observedSourcePeerId: "-123456" };
const passphrase = "synthetic-observer-controller-passphrase";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(resolve(tmpdir()), "neurobro-observer-controller-")), signal = new AbortController();
  const settings = await openStandingCommunitySettings({ directory: join(root, "settings"), passphrase, ...binding });
  const stateArgs = { directory: join(root, "state"), passphrase,
    binding: { workspaceId: binding.workspaceId, accountId: binding.accountId, internalPeerId: binding.internalPeerId, sourcePeerId: binding.observedSourcePeerId } };
  let state = await openStandingCommunityObserverState(stateArgs);
  const outbox = await openStandingCommunityAlertOutbox({ directory: join(root, "outbox"), passphrase, binding });
  let now = Date.now(), sourceReads = 0, sourceCloses = 0, alertOpens = 0, alertCloses = 0, assessments = 0, verified = 0;
  let rows = Array.from({ length: 30 }, (_, i) => ({ id: 100 - i, text: "Synthetic source " + i }));
  const sent: string[] = [], controllers: ReturnType<typeof createStandingCommunityObserver>[] = [];
  let implementation: StandingCommunityObserverInput["assess"] = async () => ({ decision: "silent", caseKey: null, answer: null });
  let sourceWait: ReturnType<typeof deferred> | undefined, sourceEntered: ReturnType<typeof deferred> | undefined;
  let failSource = false, failReadback = false;
  const observer = (overrides: Partial<StandingCommunityObserverInput> = {}) => {
    const value = createStandingCommunityObserver({ settings, state, outbox, signal: signal.signal, now: () => now, onVerified: () => { verified++; },
      assess: async (ref, body, callSignal) => {
        assessments++; assert.equal((await state.checkpoint()).processing.last?.disposition, "attempt-reserved");
        const parsed = JSON.parse(body); assert.equal(parsed.assessmentRef, ref); assert.equal(Buffer.byteLength(body) <= 24576, true);
        assert.equal(body.includes(binding.observedSourcePeerId), false); assert.equal(body.includes("sequence"), false); assert.equal(body.includes("observedAt"), false);
        return implementation(ref, body, callSignal);
      }, ...overrides }); controllers.push(value); return value;
  };
  const ticket = (): StandingIdleHistoryTicket => {
    let used = false; const take = () => { assert.equal(used, false, "only one capability per idle ticket"); used = true; };
    return { openHistoryTask() { assert.fail("history task authority must not be borrowed"); }, openTaskReply() { assert.fail("no fabricated human primary"); },
      openObservedSource() { take(); sourceReads++; return { info: { sourceRef: "community", title: "Synthetic", readOnly: true, telegramSendRestriction: "not-confirmed" },
        async readHistory(input = {}) {
          sourceEntered?.resolve(); await sourceWait?.promise; if (failSource) throw Error("private-source-error");
          const values = rows.filter(row => input.beforeMessageId === undefined || row.id < input.beforeMessageId).slice(0, input.limit ?? 30);
          const envelope = new Api.messages.Messages({ messages: values.map(row => new Api.Message({ id: row.id, date: 1700000000 + row.id,
            peerId: new Api.PeerChat({ chatId: bigInt(123456) }), fromId: new Api.PeerUser({ userId: bigInt(777) }), message: row.text })),
            users: [new Api.User({ id: bigInt(777), firstName: "Synthetic speaker" })], chats: [] });
          return projectStandingObservedSourcePage(new BinaryReader(envelope.getBytes()).tgReadObject(),
            { sourceRef: "community", title: "Synthetic", peerId: binding.observedSourcePeerId, limit: input.limit ?? 30,
              ...(input.beforeMessageId === undefined ? {} : { beforeMessageId: input.beforeMessageId }) });
        }, async close() { sourceCloses++; sourceWait?.resolve(); } }; },
      openCommunityAlert() { take(); alertOpens++; let text = ""; return { info: { accountId: binding.accountId, internalPeerId: binding.internalPeerId },
        async sendOnce(value) { text = value.text; sent.push(text); return { messageId: 501 }; },
        async readExact() { if (failReadback) throw Error("private-readback-error");
          return { messageId: 501, chatId: binding.internalPeerId, accountId: binding.accountId, fromId: binding.accountId, out: true,
            text, replyToMessageId: null, media: false, post: false }; }, async close() { alertCloses++; } }; },
    };
  };
  const enable = async (alertsEnabled = true) => { const policy = await settings.policy(); return settings.update({ expectedRevision: policy.revision,
    observationEnabled: true, alertsEnabled, alertGuidance: "Assess only synthetic source", minAlertIntervalSeconds: 60,
    evidence: { actorId: "456", messageId: 33, requestRef: "request-" + policy.revision, changedAt: Math.floor(now / 1000) } }); };
  t.after(async () => {
    await Promise.allSettled(controllers.map(controller => controller.close())); await Promise.allSettled([settings.close(), state.close(), outbox.close()]);
    assert.ok(root.startsWith(join(resolve(tmpdir()), "neurobro-observer-controller-"))); await rm(root, { recursive: true, force: true });
  });
  return { settings, get state() { return state; }, outbox, observer, ticket, enable, sent, signal,
    advance(ms = 60_001) { now += ms; }, now: () => now, counters: () => ({ sourceReads, sourceCloses, alertOpens, alertCloses, assessments, verified }),
    setAssess(value: StandingCommunityObserverInput["assess"]) { implementation = value; }, setRows(value: typeof rows) { rows = value; },
    setFailSource() { failSource = true; }, setFailReadback() { failReadback = true; },
    holdSource() { sourceWait = deferred(); sourceEntered = deferred(); return { entered: sourceEntered.promise, release: sourceWait.resolve }; },
    async reopenState() { await state.close(); state = await openStandingCommunityObserverState(stateArgs); },
  };
}

test("default observation reads one page, then drains quietly without model or alert authority", async t => {
  const f = await fixture(t), observer = f.observer(); await observer.step(f.ticket(), f.signal.signal);
  assert.equal(f.counters().sourceReads, 1); assert.equal(f.counters().sourceCloses, 1); assert.equal(f.counters().assessments, 0);
  assert.equal(observer.snapshot().pendingRows, 30); assert.equal(observer.snapshot().lastReadAtMs, f.now());
  await observer.step(f.ticket(), f.signal.signal);
  assert.equal((await f.state.checkpoint()).processing.totals["alerts-disabled"], 30); assert.equal(f.counters().assessments, 0); assert.equal(f.counters().alertOpens, 0);
  assert.equal(observer.due(), false); assert.equal(observer.snapshot().completeHistory, false);
  f.advance(); assert.equal(observer.due(), true); await observer.step(f.ticket(), f.signal.signal);
  assert.equal((await f.state.checkpoint()).recent.pendingRows, 0); assert.equal(f.counters().assessments, 0);
});

test("full Russian rows are packed whole across bounded assessments after state reopen", async t => {
  const f = await fixture(t); await f.enable();
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: 100 - i, text: "я".repeat(3990) + " ХВОСТ-" + i }));
  f.setRows(rows); const reader = f.observer(); await reader.step(f.ticket(), f.signal.signal);
  await reader.close(); await f.reopenState();
  assert.deepEqual((await f.state.readPending()).items.map(row => row.text), rows.map(row => row.text));
  const seen: string[] = [], batches: number[] = [];
  f.setAssess(async (_ref, body) => {
    const packet = JSON.parse(body); batches.push(packet.observations.length);
    for (const item of packet.observations) { assert.equal(item.truncated, false); assert.match(item.text, /ХВОСТ-\d+$/u); seen.push(item.text); }
    return { decision: "silent", caseKey: null, answer: null };
  });
  const observer = f.observer();
  for (let i = 0; i < rows.length && (await f.state.checkpoint()).recent.pendingRows; i++) await observer.step(f.ticket(), f.signal.signal);
  assert.deepEqual(seen, rows.map(row => row.text)); assert.ok(batches.length > 1); assert.ok(batches.every(count => count > 0 && count < rows.length));
  assert.equal((await f.state.checkpoint()).processing.totals.silent, rows.length); assert.equal(f.sent.length, 0);
});

test("a retained escape-heavy row too large for assessment records explicit gap and cannot starve later rows", async t => {
  const f = await fixture(t); await f.enable(); const complete = '"'.repeat(16384);
  f.setRows([{ id: 100, text: complete }, { id: 99, text: "Следующее сообщение — ответьте клиенту" }]);
  const observer = f.observer(); await observer.step(f.ticket(), f.signal.signal);
  assert.equal((await f.state.readPending()).items[0]!.text, complete);
  await observer.step(f.ticket(), f.signal.signal);
  assert.equal(f.counters().assessments, 0); assert.equal(f.sent.length, 0);
  assert.equal(observer.snapshot().lastOutcome, "material-too-large");
  assert.ok(observer.snapshot().coverage!.gaps.some(gap => gap.kind === "assessment-material-too-large-not-analyzed" && gap.count === 1));
  assert.equal((await f.state.checkpoint()).recent.pendingRows, 1);
  await observer.close(); await f.reopenState();
  let seen = ""; f.setAssess(async (_ref, body) => { const packet = JSON.parse(body);
    assert.equal(packet.observations.length, 1); seen = packet.observations[0].text; return { decision: "silent", caseKey: null, answer: null }; });
  const next = f.observer(); await next.step(f.ticket(), f.signal.signal);
  assert.equal(seen, "Следующее сообщение — ответьте клиенту"); assert.equal(f.counters().assessments, 1);
  assert.equal((await f.state.checkpoint()).processing.totals["material-too-large"], 1);
  assert.equal((await f.state.checkpoint()).processing.totals.silent, 1); assert.equal((await f.state.checkpoint()).recent.pendingRows, 0);
});

test("joined assessment produces one bounded internal alert, cooldown uses millisecond receipts and repeated rows never retry", async t => {
  const f = await fixture(t); await f.enable(); const observer = f.observer();
  f.setAssess(async (_ref, body) => ({ decision: "alert", caseKey: JSON.parse(body).observations[0].ref, answer: "🙂".repeat(800) }));
  await observer.step(f.ticket(), f.signal.signal); assert.equal(f.counters().assessments, 0);
  await observer.step(f.ticket(), f.signal.signal);
  assert.equal(f.counters().assessments, 1); assert.equal(f.sent.length, 1); assert.equal(f.counters().verified, 1); assert.equal(f.counters().alertCloses, 1);
  assert.equal(observer.snapshot().outbox!.used, (await f.outbox.status()).used);
  assert.ok(f.sent[0]!.length <= 900 && Buffer.byteLength(f.sent[0]!) <= 4096); assert.match(f.sent[0]!, /\[Сокращено\]$/u);
  assert.equal(Buffer.from(f.sent[0]!).toString(), f.sent[0]);
  const first = await f.state.checkpoint(); assert.equal(first.processing.totals.alert, 30);
  // More pending data may already exist without another source scan. It must
  // be suppressed during the receipt-based cooldown without a model call.
  f.setRows([{ id: 101, text: "New case" }]); f.advance(1); observer.policyChanged();
  await observer.step(f.ticket(), f.signal.signal); // scan cadence still waits
  f.advance(120_000); await observer.step(f.ticket(), f.signal.signal); await observer.step(f.ticket(), f.signal.signal);
  assert.equal(f.counters().assessments, 2); // clock moved beyond 60 seconds
  const recent = await f.outbox.recent({ limit: 8 }); assert.ok(recent[0]!.settledAt > 1_000_000_000_000);
  const reopened = f.observer(); await reopened.step(f.ticket(), f.signal.signal); assert.equal(f.sent.length, 2);
});

test("disabled policy after assessment suppresses delivery and reserves no fabricated retry", async t => {
  const f = await fixture(t); await f.enable(); const observer = f.observer();
  f.setAssess(async (_ref, body) => { await f.enable(false); return { decision: "alert", caseKey: JSON.parse(body).observations[0].ref, answer: "Should stay quiet" }; });
  await observer.step(f.ticket(), f.signal.signal); await observer.step(f.ticket(), f.signal.signal);
  assert.equal(f.counters().assessments, 1); assert.equal(f.counters().alertOpens, 0); assert.equal(f.sent.length, 0);
  assert.equal((await f.state.checkpoint()).processing.totals.silent, 30); assert.equal(observer.snapshot().lastOutcome, "policy-suppressed");
  assert.equal(observer.snapshot().alertsEnabled, false); assert.equal(observer.snapshot().policyRevision, (await f.settings.policy()).revision);
});

test("unknown readback consumes the alert and remaining pending batches observe cooldown without model work", async t => {
  const f = await fixture(t); await f.enable(); f.setFailReadback();
  f.setRows(Array.from({ length: 30 }, (_, n) => ({ id: 100 - n, text: '"'.repeat(1024) })));
  let shown = 0;
  f.setAssess(async (_ref, body) => { const packet = JSON.parse(body); shown = packet.observations.length;
    return { decision: "alert", caseKey: packet.observations[0].ref, answer: "Synthetic" }; });
  const observer = f.observer(); await observer.step(f.ticket(), f.signal.signal); await observer.step(f.ticket(), f.signal.signal);
  assert.equal(f.counters().assessments, 1); assert.equal(f.sent.length, 1); assert.equal(f.counters().verified, 0);
  assert.equal(observer.snapshot().lastOutcome, "unknown"); assert.ok((await f.state.checkpoint()).recent.pendingRows > 0);
  assert.equal(observer.snapshot().outbox!.used, (await f.outbox.status()).used);
  assert.equal((await f.state.checkpoint()).processing.totals.unknown, shown);
  await observer.step(f.ticket(), f.signal.signal); assert.equal(f.counters().assessments, 1); assert.equal(f.sent.length, 1);
  assert.ok((await f.state.checkpoint()).processing.totals["policy-suppressed"] > 0);
});

test("joined model timeout records unknown and backoff; cold reserved attempt is finalized without reassessment", async t => {
  const f = await fixture(t); await f.enable(); const observer = f.observer();
  f.setAssess(async () => { throw Object.assign(Error("private-model-error"), { code: "COMMUNITY_ASSESSMENT_TIMEOUT" }); });
  await observer.step(f.ticket(), f.signal.signal); await observer.step(f.ticket(), f.signal.signal);
  assert.equal((await f.state.checkpoint()).processing.totals.unknown, 30); assert.equal(observer.due(), false);
  assert.equal(observer.snapshot().error, "assessment-timeout"); assert.equal(JSON.stringify(observer.snapshot()).includes("private"), false);
  const held = await fixture(t); await held.enable(); const first = held.observer();
  held.setAssess(async () => { throw Object.assign(Error("unsettled"), { code: "SETTLEMENT_UNKNOWN" }); });
  await first.step(held.ticket(), held.signal.signal); await assert.rejects(first.step(held.ticket(), held.signal.signal), { code: "SETTLEMENT_UNKNOWN" });
  assert.equal(first.due(), false); assert.equal(first.snapshot().error, "settlement-unknown");
  await first.close().catch(() => {}); await held.reopenState();
  const second = held.observer(); await second.step(held.ticket(), held.signal.signal);
  assert.equal(held.counters().assessments, 1); assert.equal((await held.state.checkpoint()).processing.totals.unknown, 30);
});

test("close revokes and joins held source read; optional source error is visible backoff without escaping to foreground", async t => {
  const f = await fixture(t), observer = f.observer(), held = f.holdSource();
  const read = observer.step(f.ticket(), f.signal.signal); await held.entered; await observer.close(); await read;
  assert.equal(f.counters().sourceCloses, 1); assert.equal((await f.state.checkpoint()).recent.rows, 0); assert.equal(observer.due(), false);
  const broken = await fixture(t); broken.setFailSource(); const controller = broken.observer();
  await controller.step(broken.ticket(), broken.signal.signal);
  assert.equal(controller.snapshot().phase, "backoff"); assert.equal(controller.snapshot().error, "operation-unavailable");
  assert.equal(controller.due(), false); assert.equal(broken.counters().sourceCloses, 1);
});

test("full outbox is explicit and drains pending source quietly without model or send", async t => {
  const f = await fixture(t); await f.enable();
  const observer = f.observer({ outbox: { ...f.outbox, async status() { return { used: 256, maximum: 256, full: true }; } } });
  await observer.step(f.ticket(), f.signal.signal); await observer.step(f.ticket(), f.signal.signal);
  assert.equal(observer.snapshot().phase, "outbox-full"); assert.equal(observer.snapshot().outbox!.full, true);
  assert.equal((await f.state.checkpoint()).processing.totals["policy-suppressed"], 30);
  assert.equal(f.counters().assessments, 0); assert.equal(f.counters().alertOpens, 0);
});

test("policyChanged aborts a held assessment, joins its physical settlement and discards late alert", async t => {
  const f = await fixture(t); await f.enable(); const entered = deferred(), settle = deferred(); let aborted = false;
  f.setAssess(async (_ref, body, signal) => { signal.addEventListener("abort", () => { aborted = true; }, { once: true }); entered.resolve();
    await settle.promise; return { decision: "alert", caseKey: JSON.parse(body).observations[0].ref, answer: "Late output" }; });
  const observer = f.observer(); await observer.step(f.ticket(), f.signal.signal);
  const pending = observer.step(f.ticket(), f.signal.signal); await entered.promise; await f.enable(false); observer.policyChanged();
  assert.equal(aborted, true); assert.equal(observer.due(), false);
  let closed = false; const closing = observer.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); settle.resolve(); await pending; await closing;
  assert.equal(f.sent.length, 0); assert.equal(f.counters().alertOpens, 0); assert.equal((await f.state.checkpoint()).processing.totals.unknown, 30);
});

test("uncertain source or alert close is fatal and cannot later claim clean controller settlement", async t => {
  for (const mode of ["source", "alert"] as const) {
    const f = await fixture(t); await f.enable();
    f.setAssess(async (_ref, body) => ({ decision: "alert", caseKey: JSON.parse(body).observations[0].ref, answer: "Synthetic alert" }));
    const observer = f.observer();
    if (mode === "alert") await observer.step(f.ticket(), f.signal.signal);
    const original = f.ticket();
    const bad: StandingIdleHistoryTicket = mode === "source" ? { ...original, openObservedSource(input) {
      const lease = original.openObservedSource!(input); return { ...lease, async close() { await lease.close(); throw Error("private-source-close"); } };
    } } : { ...original, openCommunityAlert(input) {
      const lease = original.openCommunityAlert!(input); return { ...lease, async close() { await lease.close(); throw Error("private-alert-close"); } };
    } };
    await assert.rejects(observer.step(bad, f.signal.signal), { code: "SETTLEMENT_UNKNOWN" });
    assert.equal(observer.due(), false); assert.equal(observer.snapshot().error, "settlement-unknown");
    await assert.rejects(observer.close(), { code: "SETTLEMENT_UNKNOWN" });
    assert.equal(f.counters().assessments, mode === "source" ? 0 : 1);
  }
});

test("unavailable alert lease is visible backoff and cannot churn remaining packets into outbox reservations", async t => {
  const f = await fixture(t); await f.enable();
  f.setRows(Array.from({ length: 30 }, (_, n) => ({ id: 100 - n, text: '"'.repeat(1024) })));
  f.setAssess(async (_ref, body) => ({ decision: "alert", caseKey: JSON.parse(body).observations[0].ref, answer: "Synthetic alert" }));
  const observer = f.observer(); await observer.step(f.ticket(), f.signal.signal);
  const unused = f.ticket(); await observer.step({ ...unused, openCommunityAlert() { throw Error("private-lease-unavailable"); } }, f.signal.signal);
  const checkpoint = await f.state.checkpoint(); assert.ok(checkpoint.recent.pendingRows > 0); assert.ok(checkpoint.processing.totals.unknown > 0);
  assert.equal(checkpoint.processing.totals.silent, 0); assert.equal((await f.outbox.status()).used, 1);
  assert.equal(observer.snapshot().phase, "backoff"); assert.equal(observer.snapshot().error, "operation-unavailable");
  assert.equal(observer.snapshot().lastOutcome, "unknown"); assert.equal(observer.snapshot().outbox!.used, 1); assert.equal(observer.due(), false);
  await observer.step(f.ticket(), f.signal.signal); assert.equal(f.counters().assessments, 1); assert.equal((await f.outbox.status()).used, 1);
  assert.equal(f.sent.length, 0); assert.equal(JSON.stringify(observer.snapshot()).includes("private"), false);
});

test("policy changed at the outbox final refresh is reported accurately and blocks the actual send", async t => {
  const f = await fixture(t); await f.enable();
  f.setAssess(async (_ref, body) => ({ decision: "alert", caseKey: JSON.parse(body).observations[0].ref, answer: "Synthetic" }));
  const observer = f.observer({ outbox: { ...f.outbox, async deliver(value) {
    return f.outbox.deliver({ ...value, refreshPolicy: async () => { await f.enable(false); return value.refreshPolicy(); } });
  } } });
  await observer.step(f.ticket(), f.signal.signal); await observer.step(f.ticket(), f.signal.signal);
  assert.equal(f.counters().assessments, 1); assert.equal(f.counters().alertOpens, 1); assert.equal(f.sent.length, 0);
  assert.equal(observer.snapshot().alertsEnabled, false); assert.equal(observer.snapshot().policyRevision, (await f.settings.policy()).revision);
  assert.equal(observer.snapshot().lastOutcome, "policy-suppressed"); assert.equal((await f.state.checkpoint()).processing.totals.silent, 30);
  assert.equal(observer.snapshot().outbox!.used, (await f.outbox.status()).used);
});
