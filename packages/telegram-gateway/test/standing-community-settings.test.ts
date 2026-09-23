import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openStandingCommunitySettings,
  StandingCommunitySettingsError,
  type StandingCommunitySettingsEvidence,
  type StandingCommunitySettingsUpdate,
} from "../src/standing-community-settings.js";

const passphrase = "synthetic-community-settings-passphrase";
const binding = Object.freeze({ workspaceId: "community-team", accountId: "123456789",
  internalPeerId: "-100200", observedSourcePeerId: "-100900" });
const evidence = (messageId: number): StandingCommunitySettingsEvidence => Object.freeze({
  actorId: "700", messageId, requestRef: `request-${messageId}`, changedAt: 1_700_000_000 + messageId,
});
const update = (expectedRevision: number, messageId: number, values: Partial<Omit<StandingCommunitySettingsUpdate, "expectedRevision" | "evidence">> = {}): StandingCommunitySettingsUpdate => Object.freeze({
  expectedRevision, observationEnabled: true, alertsEnabled: true, alertGuidance: "Alert on urgent customer risk.",
  minAlertIntervalSeconds: 300, evidence: evidence(messageId), ...values,
});

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix)), directory = join(root, "community-settings");
  const open = (overrides: Partial<{ workspaceId: string; accountId: string; internalPeerId: string; observedSourcePeerId: string }> = {}) =>
    openStandingCommunitySettings({ directory, passphrase, ...binding, ...overrides });
  return { root, directory, open };
}

function code(expected: StandingCommunitySettingsError["code"]): (error: unknown) => boolean {
  return error => error instanceof StandingCommunitySettingsError && error.code === expected;
}

test("canonical policy starts at revision one and is compact immutable", async () => {
  const f = await fixture("community-settings-default-");
  try {
    const store = await f.open(), policy = await store.policy();
    assert.deepEqual(policy, { revision: 1, observationEnabled: true, alertsEnabled: false, alertGuidance: "",
      minAlertIntervalSeconds: 1800, observedSourcePeerId: binding.observedSourcePeerId, lastChanged: null });
    assert.deepEqual(Object.keys(policy), ["revision", "observationEnabled", "alertsEnabled", "alertGuidance",
      "minAlertIntervalSeconds", "observedSourcePeerId", "lastChanged"]);
    assert.equal(Object.isFrozen(policy), true);
    await store.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("full update survives reopen and observation off atomically cancels alerts", async () => {
  const f = await fixture("community-settings-reopen-");
  try {
    const first = await f.open(), enabled = await first.update(update(1, 10));
    assert.deepEqual(enabled, { revision: 2, observationEnabled: true, alertsEnabled: true,
      alertGuidance: "Alert on urgent customer risk.", minAlertIntervalSeconds: 300,
      observedSourcePeerId: binding.observedSourcePeerId, lastChanged: evidence(10) });
    assert.equal(Object.isFrozen(enabled), true); assert.equal(Object.isFrozen(enabled.lastChanged), true);
    const ciphertext = await readFile(join(f.directory, "community-settings.enc"), "utf8");
    for (const privateValue of [binding.workspaceId, binding.accountId, binding.internalPeerId,
      binding.observedSourcePeerId, enabled.alertGuidance, enabled.lastChanged!.requestRef]) assert.equal(ciphertext.includes(privateValue), false);
    await first.close();

    const second = await f.open();
    assert.deepEqual(await second.policy(), enabled);
    const disabledInput = update(2, 11, { observationEnabled: false, alertsEnabled: true,
      alertGuidance: "Keep this guidance for a later explicit enable.", minAlertIntervalSeconds: 600 });
    const disabled = await second.update(disabledInput);
    assert.equal(disabled.revision, 3); assert.equal(disabled.observationEnabled, false); assert.equal(disabled.alertsEnabled, false);
    assert.equal(disabled.alertGuidance, disabledInput.alertGuidance); assert.equal(disabled.minAlertIntervalSeconds, 600);
    await second.close();
    const third = await f.open(); assert.deepEqual(await third.policy(), disabled); await third.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("workspace, account and both peer bindings are required on reopen", async () => {
  const f = await fixture("community-settings-scope-");
  try {
    const store = await f.open(); await store.update(update(1, 20)); await store.close();
    for (const changed of [
      { workspaceId: "another-team" }, { accountId: "123456788" }, { internalPeerId: "-100201" }, { observedSourcePeerId: "-100901" },
    ]) await assert.rejects(f.open(changed), code("binding"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("CAS is monotonic, exact lost-ack replay is idempotent and policy refreshes", async () => {
  const f = await fixture("community-settings-cas-");
  try {
    const first = await f.open(), second = await f.open(), initial = update(1, 30);
    const revisionTwo = await first.update(initial);
    assert.equal(revisionTwo.revision, 2);
    assert.deepEqual(await first.update(initial), revisionTwo);
    assert.deepEqual(await second.update(initial), revisionTwo);
    await assert.rejects(first.update(update(1, 31)), code("conflict"));
    assert.deepEqual(await second.policy(), revisionTwo);
    const next = update(2, 32, { alertGuidance: "Only alert on a clear delivery blocker." });
    const revisionThree = await first.update(next);
    assert.equal(revisionThree.revision, 3); assert.deepEqual(await second.policy(), revisionThree);
    await assert.rejects(second.update(update(2, 33)), code("conflict"));
    await Promise.all([first.close(), second.close()]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("encrypted record corruption is refused by live refresh and reopen", async () => {
  const f = await fixture("community-settings-corrupt-");
  try {
    const store = await f.open(); await store.update(update(1, 40));
    const path = join(f.directory, "community-settings.enc"), encrypted = JSON.parse(await readFile(path, "utf8"));
    encrypted.authTag = Buffer.from("damaged-auth-tag", "utf8").toString("base64");
    await writeFile(path, JSON.stringify(encrypted), "utf8");
    await assert.rejects(store.policy(), code("storage")); await store.close();
    await assert.rejects(f.open(), code("storage"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("close revokes new calls and joins an already admitted update", async () => {
  const f = await fixture("community-settings-close-");
  try {
    const store = await f.open(), admitted = store.update(update(1, 50)), closing = store.close();
    await assert.rejects(store.policy(), code("closed"));
    const saved = await admitted; assert.equal(saved.revision, 2); await closing;
    await assert.rejects(store.update(update(2, 51)), code("closed"));
    const reopened = await f.open(); assert.deepEqual(await reopened.policy(), saved); await reopened.close();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
