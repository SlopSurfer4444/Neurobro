import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStandingCommunitySettings, type StandingCommunityPolicy, type StandingCommunitySettingsStore } from "../src/standing-community-settings.js";
import { createStandingObservationTools, STANDING_OBSERVATION_TOOL_NAME, STANDING_OBSERVATION_TOOL_SPEC } from "../src/standing-observation-tools.js";
import type { EpochToolResult, EpochToolScope } from "../src/standing-tool-dispatcher.js";

const passphrase = "synthetic-observation-tools-passphrase";
const binding = Object.freeze({ workspaceId: "community-team", accountId: "123456789",
  internalPeerId: "-100200", observedSourcePeerId: "-100900" });
const primary = Object.freeze({ actorId: "700", messageId: 41, requestRef: "turn-41" });
const statusArgs = Object.freeze({ action: "status", expectedRevision: null, observationEnabled: null,
  alertsEnabled: null, alertGuidance: null, minAlertIntervalSeconds: null });
const configureArgs = Object.freeze({ action: "configure", expectedRevision: 1, observationEnabled: true,
  alertsEnabled: true, alertGuidance: "Alert on urgent customer risk.", minAlertIntervalSeconds: 300 });

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix)), directory = join(root, "settings");
  const open = () => openStandingCommunitySettings({ directory, passphrase, ...binding });
  return { root, directory, open };
}

function scope(requestRef: string = primary.requestRef, signal = new AbortController().signal): EpochToolScope {
  return Object.freeze({ requestRef, callRef: "observation-call", signal });
}
function body(value: EpochToolResult): Record<string, unknown> {
  const item = value.contentItems[0];
  assert.equal(item?.type, "inputText");
  return JSON.parse((item as { type: "inputText"; text: string }).text);
}
async function call(tools: ReturnType<typeof createStandingObservationTools>, value: unknown, callScope = scope()) {
  return tools.handlers[0]!.call(value, callScope) as Promise<EpochToolResult>;
}

test("actual store status, configure, reopen and exact lost-ack replay stay host-bound", async () => {
  const f = await fixture("observation-tool-reopen-");
  try {
    const store = await f.open(), tools = createStandingObservationTools({ store, primary, allowConfigure: true,
      signal: new AbortController().signal, now: () => 1_700_000_041 });
    assert.equal(tools.handlers[0]!.name, STANDING_OBSERVATION_TOOL_NAME);
    assert.equal(tools.specs[0], STANDING_OBSERVATION_TOOL_SPEC);
    const initial = await call(tools, statusArgs), initialBody = body(initial);
    assert.equal(initial.success, true);
    assert.deepEqual(initialBody, { schema: "standing-observation-settings-v1", revision: 1, observationEnabled: true,
      alertsEnabled: false, alertGuidance: "", minAlertIntervalSeconds: 1800, sourceRef: "community", sourceReadOnly: true });
    const configured = await call(tools, configureArgs), configuredBody = body(configured);
    assert.equal(configured.success, true); assert.equal(configuredBody.revision, 2); assert.equal(configuredBody.persisted, true);
    const serialized = JSON.stringify(configuredBody);
    for (const hidden of Object.values(binding)) assert.equal(serialized.includes(hidden), false);
    for (const hidden of [primary.actorId, primary.requestRef, String(primary.messageId)]) assert.equal(serialized.includes(hidden), false);
    await tools.close(); await store.close();

    const reopened = await f.open(), replayTools = createStandingObservationTools({ store: reopened, primary,
      allowConfigure: true, signal: new AbortController().signal, now: () => 1_700_000_041 });
    const reopenedStatus = body(await call(replayTools, statusArgs));
    assert.deepEqual(reopenedStatus, Object.fromEntries(Object.entries(configuredBody).filter(([key]) => key !== "persisted")));
    const replay = body(await call(replayTools, configureArgs));
    assert.equal(replay.revision, 2); assert.equal(replay.persisted, true);
    const policy = await reopened.policy();
    assert.deepEqual(policy.lastChanged, { ...primary, changedAt: 1_700_000_041 });
    await replayTools.close(); await reopened.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("tool arguments cannot choose provenance or workspace and projections expose no peer IDs", async () => {
  const f = await fixture("observation-tool-scope-");
  try {
    const store = await f.open(), tools = createStandingObservationTools({ store, primary, allowConfigure: true,
      signal: new AbortController().signal, now: () => 1_700_000_042 });
    for (const injected of [{ actorId: "999" }, { workspaceId: "other" }, { observedSourcePeerId: "-100999" }]) {
      const response = await call(tools, { ...configureArgs, ...injected });
      assert.equal(response.success, false); assert.equal(body(response).code, "invalid-arguments");
    }
    const wrongScope = await call(tools, configureArgs, scope("another-turn"));
    assert.equal(wrongScope.success, false); assert.equal(body(wrongScope).code, "invalid-scope");
    assert.equal((await store.policy()).revision, 1);
    const status = JSON.stringify(body(await call(tools, statusArgs)));
    assert.equal(status.includes("observedSourcePeerId"), false); assert.equal(status.includes("internalPeerId"), false);
    assert.equal(status.includes(binding.observedSourcePeerId), false); assert.equal(status.includes(binding.internalPeerId), false);
    await tools.close(); await store.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("initiative facade refuses configure before touching the store", async () => {
  const f = await fixture("observation-tool-initiative-");
  try {
    const store = await f.open(); let mutations = 0;
    const guarded: StandingCommunitySettingsStore = Object.freeze({ policy: store.policy,
      async update(value) { mutations++; return store.update(value); }, close: store.close });
    const tools = createStandingObservationTools({ store: guarded, primary, allowConfigure: false,
      signal: new AbortController().signal, now: () => 1_700_000_043 });
    const response = await call(tools, configureArgs);
    assert.equal(response.success, false); assert.equal(body(response).code, "human-request-required");
    assert.equal(mutations, 0); assert.equal((await store.policy()).revision, 1);
    await tools.close(); await store.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("full-state updates preserve requested fields, enforce CAS and disable alerts with observation", async () => {
  const f = await fixture("observation-tool-cas-");
  try {
    const store = await f.open(), tools = createStandingObservationTools({ store, primary, allowConfigure: true,
      signal: new AbortController().signal, now: () => 1_700_000_044 });
    const enabled = body(await call(tools, configureArgs)); assert.equal(enabled.revision, 2);
    const alertsOff = { ...configureArgs, expectedRevision: 2, alertsEnabled: false };
    const preserved = body(await call(tools, alertsOff));
    assert.equal(preserved.revision, 3); assert.equal(preserved.alertGuidance, configureArgs.alertGuidance);
    assert.equal(preserved.minAlertIntervalSeconds, configureArgs.minAlertIntervalSeconds);
    const stale = await call(tools, { ...alertsOff, alertGuidance: "Stale overwrite" });
    assert.equal(stale.success, false); assert.equal(body(stale).code, "conflict");
    const disabled = body(await call(tools, { ...alertsOff, expectedRevision: 3, observationEnabled: false, alertsEnabled: true }));
    assert.equal(disabled.revision, 4); assert.equal(disabled.observationEnabled, false); assert.equal(disabled.alertsEnabled, false);
    const policy = await store.policy(); assert.equal(policy.revision, 4); assert.equal(policy.alertsEnabled, false);
    await tools.close(); await store.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("close joins a held snapshot and revokes its result", async () => {
  const f = await fixture("observation-tool-snapshot-close-");
  try {
    const store = await f.open(); let release!: () => void, entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const wrapped: StandingCommunitySettingsStore = Object.freeze({
      async policy() { entered(); await hold; return store.policy(); }, update: store.update, close: store.close,
    });
    const tools = createStandingObservationTools({ store: wrapped, primary, allowConfigure: true, signal: new AbortController().signal });
    const snapshot = tools.snapshot(); await began;
    let settled = false; const closing = tools.close().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    release(); await assert.rejects(snapshot, /stopped/); await closing; assert.equal(settled, true);
    await store.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("scope abort and close join a held persisted update without claiming rollback", async () => {
  const f = await fixture("observation-tool-update-close-");
  try {
    const store = await f.open(); let release!: () => void, persisted!: () => void;
    const saved = new Promise<void>(resolve => { persisted = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const wrapped: StandingCommunitySettingsStore = Object.freeze({ policy: store.policy,
      async update(value) { const policy = await store.update(value); persisted(); await hold; return policy; }, close: store.close });
    const host = new AbortController(), local = new AbortController();
    const tools = createStandingObservationTools({ store: wrapped, primary, allowConfigure: true,
      signal: host.signal, now: () => 1_700_000_045 });
    const pending = call(tools, configureArgs, scope(primary.requestRef, local.signal)); await saved;
    local.abort(); let settled = false; const closing = tools.close().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    release(); const response = await pending; await closing;
    assert.equal(response.success, false); assert.equal(body(response).code, "stopped"); assert.equal(settled, true);
    const policy = await store.policy(); assert.equal(policy.revision, 2); assert.equal(policy.alertsEnabled, true);
    assert.equal(JSON.stringify(body(response)).includes("rollback"), false);
    await store.close(); const reopened = await f.open(); assert.equal((await reopened.policy()).revision, 2); await reopened.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
