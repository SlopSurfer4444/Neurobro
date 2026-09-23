import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { acquireProcessLock, ProcessLockAdmissionDeniedError } from "../src/process-lock.js";
import { encryptSession } from "../src/session-crypto.js";
import { assertStandingWorkspaceStateDirectory, normalizeStandingWorkspace, prepareStandingWorkspace,
  type StandingWorkspaceInput } from "../src/standing-workspace.js";

function receipt() {
  return {
    exitCode: 0, transportError: false, timedOut: false, overflow: false, outcome: "completed-review-client-verdict",
    guest: { version: "astra-canary-v3", outcome: "completed-review-client-verdict", stage: "complete", telegram: false,
      preflight: true, relayReady: true, modelTurnAdmitted: true, settled: true, relaySettled: true, clientNaturalSettlement: true,
      clientExit: 0, relayExit: 0,
      client: { schema: "decadans.rm0032.astra-canary-client.v1", outcome: "observed", code: "OK", stage: "complete",
        canary: { threadAttempted: true, threadStarted: true, turnAttempted: true, turnStarted: true, modelMatched: true,
          effortMatched: true, permissionsMatched: true, ephemeralMatched: true, turnCompleted: true, answerExact: true,
          answerBytes: Buffer.byteLength("NEUROBRO_ASTRA_READY."), toolEvents: 0, serverRequests: 0, events: 3 },
        appServer: { launched: true, stdinClosed: true, reaped: true, stderrComplete: true, exitCode: 0, stderrBytes: 0 },
        limits: { clientTurnStartLimit: 1, transportRetriesDisabled: false, syntheticInputOnly: true, telegram: false },
        custody: { initialize: true, profile: true,
          controls: { authMetadata: true, authOpenClosed: true, parentFdClosed: true, proxyEnvPresent: true, relayBefore: true, relayAfter: true },
          account: { checked: true, chatgpt: true }, model: { checked: true, astraListedOnce: true, mediumSupported: true },
          probes: ["public", "auth_direct", "auth_self_root", "auth_server_root", "auth_controller_root", "auth_init_root", "fd", "env", "network"]
            .map(name => ({ name, attempted: true, verdict: "pass", rpcCode: null, stdoutBytes: 0, stderrBytes: 0 })) },
      },
    },
  };
}

const phrase = "invented isolated workspace phrase";
async function fixture(t: { after(fn: () => Promise<void>): void }, suffix = "one", peerId = "-100123") {
  const root = await mkdtemp(join(tmpdir(), "neurobro-workspace-test-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith("neurobro-workspace-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const accountCustodyRoot = join(root, "account-custody");
  const appRoot = join(root, `app-${suffix}`);
  await mkdir(accountCustodyRoot); await mkdir(appRoot);
  const sessionFile = join(accountCustodyRoot, "session.enc");
  const authConfigPath = join(accountCustodyRoot, "auth-config.json");
  const input: StandingWorkspaceInput = {
    workspaceId: `sample-${suffix}`,
    target: { accountId: "789", peerId, title: `Invented target ${suffix}` },
    accountCustodyRoot, appRoot, authConfigPath,
    bindingPath: join(appRoot, "binding.json"), modelReceiptPath: join(appRoot, "model-receipt.json"),
    attemptDirectory: join(appRoot, "attempts"), killSwitchPath: join(appRoot, "STOP"), stateDirectory: join(appRoot, "state"),
  };
  const auth = { schemaVersion: 1, mode: "auth-only", account: { apiIdEnv: "INVENTED_ID", apiHashEnv: "INVENTED_HASH",
    sessionPassphraseEnv: "INVENTED_PHRASE", sessionFile } };
  const binding = { version: "telegram-workspace-binding-v1", workspaceId: input.workspaceId, ...input.target, sessionReference: sessionFile,
    ownerLock: `${sessionFile}.owner.lock`, checkedAt: "2026-09-14T00:00:00.000Z", serving: false };
  await writeFile(authConfigPath, JSON.stringify(auth));
  await writeFile(sessionFile, await encryptSession("invented-session-material", phrase));
  await writeFile(input.bindingPath, JSON.stringify(binding));
  await writeFile(input.modelReceiptPath, JSON.stringify(receipt()));
  return { root, input, sessionFile, binding };
}

test("fresh app workspace reuses only custody config/session and keeps state absent", async t => {
  const f = await fixture(t); const sessionBefore = await readFile(f.sessionFile);
  const oldStop = join(f.input.accountCustodyRoot, "STOP"); await writeFile(oldStop, "preserved old workspace stop");
  const prepared = await prepareStandingWorkspace(f.input);
  assert.equal(prepared.workspaceId, f.input.workspaceId);
  assert.deepEqual(prepared.target, f.input.target);
  assert.deepEqual(prepared.binding, { accountId: f.input.target.accountId, peerId: f.input.target.peerId });
  assert.equal(prepared.config.account.sessionFile, f.sessionFile);
  assert.equal(prepared.ownerLock, `${f.sessionFile}.owner.lock`);
  assert.equal(prepared.stateDirectory, f.input.stateDirectory);
  assert.deepEqual(await readFile(f.sessionFile), sessionBefore);
  assert.equal(await readFile(oldStop, "utf8"), "preserved old workspace stop");
  await assert.rejects(lstat(f.input.stateDirectory), { code: "ENOENT" });
  await assert.rejects(lstat(f.input.attemptDirectory), { code: "ENOENT" });
});

test("workspace binding is exact across workspace, account, peer and title", async t => {
  const mutations: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
    ["workspace", { workspaceId: "other-workspace" }], ["account", { accountId: "790" }],
    ["peer", { peerId: "-100124" }], ["title", { title: "Other target" }],
  ];
  for (const [label, mutation] of mutations) {
    const f = await fixture(t, `cross-${label}`);
    await writeFile(f.input.bindingPath, JSON.stringify({ ...f.binding, ...mutation }));
    await assert.rejects(prepareStandingWorkspace(f.input), /STANDING_WORKSPACE_REFUSED/);
  }
  const f = await fixture(t, "old-schema");
  const { workspaceId: _workspaceId, ...oldBinding } = f.binding;
  await writeFile(f.input.bindingPath, JSON.stringify({ ...oldBinding, version: "telegram-account-binding-v1" }));
  await assert.rejects(prepareStandingWorkspace(f.input), /STANDING_WORKSPACE_REFUSED/);
});

test("separate app workspaces share the one encrypted-session owner lock", async t => {
  const f = await fixture(t, "first", "-100123");
  const secondRoot = join(f.root, "app-second"); await mkdir(secondRoot);
  const second: StandingWorkspaceInput = { ...f.input, workspaceId: "sample-second",
    target: { ...f.input.target, peerId: "-100456", title: "Invented target second" }, appRoot: secondRoot,
    bindingPath: join(secondRoot, "binding.json"), modelReceiptPath: join(secondRoot, "model-receipt.json"),
    attemptDirectory: join(secondRoot, "attempts"), killSwitchPath: join(secondRoot, "STOP"), stateDirectory: join(secondRoot, "state") };
  await writeFile(second.bindingPath, JSON.stringify({ version: "telegram-workspace-binding-v1", workspaceId: second.workspaceId, ...second.target,
    sessionReference: f.sessionFile, ownerLock: `${f.sessionFile}.owner.lock`, checkedAt: "2026-09-14T00:00:00.000Z", serving: false }));
  await writeFile(second.modelReceiptPath, JSON.stringify(receipt()));
  const firstPrepared = await prepareStandingWorkspace(f.input), secondPrepared = await prepareStandingWorkspace(second);
  assert.equal(firstPrepared.ownerLock, secondPrepared.ownerLock);
  const release = await acquireProcessLock(firstPrepared.ownerLock);
  await assert.rejects(acquireProcessLock(secondPrepared.ownerLock), ProcessLockAdmissionDeniedError);
  await release();
});

test("normalization rejects old-root fallbacks, overlap and mismatched runtime state", async t => {
  const f = await fixture(t, "paths"); const workspace = normalizeStandingWorkspace(f.input);
  assert.throws(() => normalizeStandingWorkspace({ ...f.input, stateDirectory: join(f.input.accountCustodyRoot, "state") }), /STANDING_WORKSPACE_REFUSED/);
  assert.throws(() => normalizeStandingWorkspace({ ...f.input, bindingPath: join(f.input.accountCustodyRoot, "binding.json") }), /STANDING_WORKSPACE_REFUSED/);
  assert.throws(() => normalizeStandingWorkspace({ ...f.input, appRoot: join(f.input.accountCustodyRoot, "nested") }), /STANDING_WORKSPACE_REFUSED/);
  assert.throws(() => assertStandingWorkspaceStateDirectory(workspace, join(f.input.appRoot, "other-state")), /STANDING_WORKSPACE_REFUSED/);
  assert.doesNotThrow(() => assertStandingWorkspaceStateDirectory(workspace, f.input.stateDirectory));
  await rm(f.input.modelReceiptPath);
  await writeFile(join(f.input.accountCustodyRoot, "model-receipt.json"), JSON.stringify(receipt()));
  await assert.rejects(prepareStandingWorkspace(f.input), { code: "ENOENT" });
});

test("canonical roots reject a symlinked app workspace", async t => {
  const f = await fixture(t, "symlink");
  const physical = join(f.root, "physical-app"); await mkdir(physical);
  const linked = join(f.root, "linked-app"); await symlink(physical, linked, "junction");
  const input: StandingWorkspaceInput = { ...f.input, appRoot: linked, bindingPath: join(linked, "binding.json"),
    modelReceiptPath: join(linked, "model-receipt.json"), attemptDirectory: join(linked, "attempts"),
    killSwitchPath: join(linked, "STOP"), stateDirectory: join(linked, "state") };
  await writeFile(input.bindingPath, JSON.stringify(f.binding)); await writeFile(input.modelReceiptPath, JSON.stringify(receipt()));
  await assert.rejects(prepareStandingWorkspace(input));
});
