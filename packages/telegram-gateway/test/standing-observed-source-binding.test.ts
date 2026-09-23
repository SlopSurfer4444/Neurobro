import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  openStandingObservedSourceBinding,
  StandingObservedSourceBindingError,
  type StandingObservedSourceBindingInput,
} from "../src/standing-observed-source-binding.js";

const sourceTitle = "ExampleCommunity";
const sourcePeerId = "-100111";
const secondSourcePeerId = "-100222";
const slot = "observed-source-binding.json";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "neurobro-observed-binding-test-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith("neurobro-observed-binding-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, "state"); await mkdir(directory);
  const input: StandingObservedSourceBindingInput = {
    directory, workspaceId: "community-team-v1", accountId: "123456789", internalPeerId: "-100999", title: sourceTitle,
  };
  const candidate = { accountId: input.accountId, peerId: sourcePeerId, title: sourceTitle };
  return { root, directory, path: join(directory, slot), input, candidate };
}

const refused = (error: unknown) => error instanceof StandingObservedSourceBindingError &&
  error.message === "STANDING_OBSERVED_SOURCE_BINDING_REFUSED";

test("first exact observation atomically creates one canonical binding and exact repeat never rewrites", async t => {
  const f = await fixture(t);
  const binding = await openStandingObservedSourceBinding(f.input);
  assert.equal(binding.expectedPeerId, undefined);
  await binding.bind(f.candidate);
  const first = await readFile(f.path);
  assert.deepEqual(JSON.parse(first.toString("utf8")), { version: "standing-observed-source-binding-v1",
    workspaceId: f.input.workspaceId, accountId: f.input.accountId, internalPeerId: f.input.internalPeerId,
    title: sourceTitle, peerId: sourcePeerId });
  await binding.bind(f.candidate);
  assert.deepEqual(await readFile(f.path), first);
  assert.deepEqual(await readdir(f.directory), [slot]);
});

test("reopen exposes only the expected peer and reparses exact saved metadata before admission", async t => {
  const f = await fixture(t);
  const initial = await openStandingObservedSourceBinding(f.input); await initial.bind(f.candidate);
  const reopened = await openStandingObservedSourceBinding(f.input);
  assert.deepEqual({ ...reopened }, { expectedPeerId: sourcePeerId, bind: reopened.bind });
  await reopened.bind(f.candidate);
});

test("wrong account, internal peer, title and malformed candidates cannot create metadata", async t => {
  const changes: readonly Record<string, unknown>[] = [
    { accountId: "123456788" }, { peerId: "-100999" }, { peerId: "123" }, { title: `${sourceTitle} ` }, { extra: true },
  ];
  for (const change of changes) {
    const f = await fixture(t); const binding = await openStandingObservedSourceBinding(f.input);
    await assert.rejects(binding.bind({ ...f.candidate, ...change } as typeof f.candidate), refused);
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
  }
});

test("workspace, account, internal peer or desired-title namespace mismatch refuses existing metadata", async t => {
  const changes: readonly Partial<StandingObservedSourceBindingInput>[] = [
    { workspaceId: "sample-other" }, { accountId: "123456788" }, { internalPeerId: "-100998" }, { title: "Other source" },
  ];
  for (const change of changes) {
    const f = await fixture(t); const binding = await openStandingObservedSourceBinding(f.input); await binding.bind(f.candidate);
    const before = await readFile(f.path);
    await assert.rejects(openStandingObservedSourceBinding({ ...f.input, ...change }), refused);
    assert.deepEqual(await readFile(f.path), before);
  }
});

test("different peer after reopen is a mismatch and never overwrites the accepted binding", async t => {
  const f = await fixture(t); const initial = await openStandingObservedSourceBinding(f.input); await initial.bind(f.candidate);
  const before = await readFile(f.path); const reopened = await openStandingObservedSourceBinding(f.input);
  await assert.rejects(reopened.bind({ ...f.candidate, peerId: secondSourcePeerId }), refused);
  assert.deepEqual(await readFile(f.path), before);
});

test("malformed, noncanonical and hard-linked existing slots are refused without repair", async t => {
  for (const mode of ["malformed", "extra", "hardlink"] as const) {
    const f = await fixture(t);
    const canonical = JSON.stringify({ version: "standing-observed-source-binding-v1", workspaceId: f.input.workspaceId,
      accountId: f.input.accountId, internalPeerId: f.input.internalPeerId, title: sourceTitle, peerId: sourcePeerId });
    await writeFile(f.path, mode === "malformed" ? "{" : mode === "extra" ? JSON.stringify({ ...JSON.parse(canonical), extra: true }) : canonical);
    if (mode === "hardlink") await link(f.path, join(f.directory, "other-link"));
    const before = await readFile(f.path);
    await assert.rejects(openStandingObservedSourceBinding(f.input), refused);
    assert.deepEqual(await readFile(f.path), before);
  }
});

test("post-open mutation or same-content inode replacement is detected by bind reparse", async t => {
  for (const mode of ["mutation", "replacement"] as const) {
    const f = await fixture(t); const initial = await openStandingObservedSourceBinding(f.input); await initial.bind(f.candidate);
    const opened = await openStandingObservedSourceBinding(f.input); const before = await readFile(f.path);
    if (mode === "mutation") await writeFile(f.path, "{");
    else { await unlink(f.path); await writeFile(f.path, before); }
    await assert.rejects(opened.bind(f.candidate), refused);
  }
});

test("two absent-state owners race through exclusive publication; exactly one wins and the slot is never overwritten", async t => {
  const f = await fixture(t);
  const first = await openStandingObservedSourceBinding(f.input);
  const second = await openStandingObservedSourceBinding(f.input);
  const outcomes = await Promise.allSettled([
    first.bind(f.candidate),
    second.bind({ ...f.candidate, peerId: secondSourcePeerId }),
  ]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(value => value.status === "rejected" && refused(value.reason)).length, 1);
  const persisted = JSON.parse(await readFile(f.path, "utf8"));
  assert.ok([sourcePeerId, secondSourcePeerId].includes(persisted.peerId));
  assert.deepEqual(await readdir(f.directory), [slot]);
  const reopened = await openStandingObservedSourceBinding(f.input);
  assert.equal(reopened.expectedPeerId, persisted.peerId);
});
