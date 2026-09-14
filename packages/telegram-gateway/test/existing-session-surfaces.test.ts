import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GATEWAY_STICKY_OWNER_CONFIRMED,
  GATEWAY_STICKY_OWNER_REQUEST,
  createCompatibleSoleOwnerSurface,
} from "../src/sole-owner-lease.js";
import { encryptSession } from "../src/session-crypto.js";
import { openExistingEncryptedSessionLease } from "../src/existing-session-lease.js";

test("a retained compatible owner lease durably blocks later admission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-owner-lease-test-"));
  const lockPath = path.join(directory, "ingestor.lock");
  const surface = createCompatibleSoleOwnerSurface(lockPath);

  const lease = await surface.acquireExclusive();
  assert.deepEqual(lease, {
    exclusive: true,
    compatibleSoleOwner: true,
    capability: "admitted-sole-owner-gateway",
  });

  assert.equal(
    await surface.retainStickyUntilOsAbsenceProof(lease!, GATEWAY_STICKY_OWNER_REQUEST),
    GATEWAY_STICKY_OWNER_CONFIRMED,
  );
  await rm(lockPath);
  assert.equal(await createCompatibleSoleOwnerSurface(lockPath).acquireExclusive(), null);
});

test("active ownership refuses a second compatible owner before sticky retention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-active-owner-lease-test-"));
  const lockPath = path.join(directory, "ingestor.lock");
  const first = createCompatibleSoleOwnerSurface(lockPath);
  const lease = await first.acquireExclusive();
  assert.notEqual(lease, null);
  assert.equal(await createCompatibleSoleOwnerSurface(lockPath).acquireExclusive(), null);
  await first.release(lease!);
  const next = createCompatibleSoleOwnerSurface(lockPath);
  const nextLease = await next.acquireExclusive();
  assert.notEqual(nextLease, null);
  await next.release(nextLease!);
});

test("an exact existing encrypted session is opened in memory and cleared on release", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-session-lease-test-"));
  const reference = path.join(directory, "session.enc");
  const session = "1invented-existing-session";
  const passphrase = "fixture-passphrase-longer-than-sixteen";
  await writeFile(reference, await encryptSession(session, passphrase), "utf8");

  const lease = await openExistingEncryptedSessionLease({ reference, passphrase });
  assert.equal(lease.kind, "existing-encrypted-session");
  assert.deepEqual(lease.material, {
    version: "rm0017-existing-string-session-v1",
    kind: "existing-string-session",
    value: session,
  });
  await lease.release();
  assert.equal(lease.material.value, "");
});

test("only one exact bounded regular session file is accepted without discovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-session-reference-test-"));
  const nested = path.join(directory, "not-a-session-file");
  await mkdir(nested);
  const passphrase = "fixture-passphrase-longer-than-sixteen";

  await assert.rejects(
    openExistingEncryptedSessionLease({ reference: nested, passphrase }),
    /session-reference-refused/,
  );
  await assert.rejects(
    openExistingEncryptedSessionLease({ reference: path.join(directory, "*.enc"), passphrase }),
    { code: "ENOENT" },
  );
  await assert.rejects(
    openExistingEncryptedSessionLease({ reference: "relative-session.enc", passphrase }),
    /session-reference-refused/,
  );
});
