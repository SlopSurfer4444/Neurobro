import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireProcessLock } from "../src/process-lock.js";
import {
  GATEWAY_STICKY_OWNER_REQUEST,
  createCompatibleSoleOwnerSurface,
} from "../src/sole-owner-lease.js";

test("allows only one local process to own the MTProto runtime lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-lock-test-"));
  const lockPath = path.join(directory, "ingestor.lock");
  const release = await acquireProcessLock(lockPath);
  await assert.rejects(acquireProcessLock(lockPath), /Another ingestor process is active/);
  await release();
  const releaseAgain = await acquireProcessLock(lockPath);
  await releaseAgain();
});

test("legacy gateway callers refuse a durable sticky owner block", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-lock-sticky-test-"));
  const lockPath = path.join(directory, "ingestor.lock");
  const surface = createCompatibleSoleOwnerSurface(lockPath);
  const lease = await surface.acquireExclusive();
  assert.ok(lease);
  await surface.retainStickyUntilOsAbsenceProof(lease, GATEWAY_STICKY_OWNER_REQUEST);
  await rm(lockPath);

  await assert.rejects(acquireProcessLock(lockPath), /sticky owner admission block/i);
});

test("a malformed lock is preserved and blocks admission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-lock-malformed-test-"));
  const lockPath = path.join(directory, "ingestor.lock");
  const malformed = "{not-json\n";
  await writeFile(lockPath, malformed, "utf8");

  await assert.rejects(acquireProcessLock(lockPath), /Malformed process lock is preserved/);
  assert.equal(await readFile(lockPath, "utf8"), malformed);
});

test("an old lease cannot unlink a substituted valid owner record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-lock-substitution-test-"));
  const lockPath = path.join(directory, "ingestor.lock");
  const release = await acquireProcessLock(lockPath);
  const original = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
  const replacement = `${JSON.stringify({ ...original, ownershipNonce: "f".repeat(64) })}\n`;
  await writeFile(lockPath, replacement, "utf8");

  await assert.rejects(release(), /ownership changed/);
  assert.equal(await readFile(lockPath, "utf8"), replacement);
});

test("a relative process lock path is ambiguous and cannot admit an owner", async () => {
  await assert.rejects(acquireProcessLock("relative-ingestor.lock"), /Relative process lock path is ambiguous/);
  assert.equal(await createCompatibleSoleOwnerSurface("relative-ingestor.lock").acquireExclusive(), null);
});

test("a structurally valid stale lock is preserved until separate OS reconciliation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-lock-stale-test-"));
  const lockPath = path.join(directory, "ingestor.lock");
  const release = await acquireProcessLock(lockPath);
  const owned = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
  await release();
  const stale = `${JSON.stringify({ ...owned, pid: 2_147_483_647 })}\n`;
  await writeFile(lockPath, stale, "utf8");

  await assert.rejects(acquireProcessLock(lockPath), /Stale process lock is preserved/);
  assert.equal(await readFile(lockPath, "utf8"), stale);
});
