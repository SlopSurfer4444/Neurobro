import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decryptExport, encryptExport } from "../src/export-crypto.js";
import { purgeExpiredExports } from "../src/range-export.js";

const passphrase = "correct horse battery staple";

test("encrypts a local range export without plaintext leakage", async () => {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const plaintext = '{"text":"private local message"}\n';
  const encrypted = await encryptExport(plaintext, passphrase, { createdAt, expiresAt, messageCount: 1 });

  assert.equal(encrypted.includes("private local message"), false);
  assert.equal(await decryptExport(encrypted, passphrase), plaintext);
  await assert.rejects(decryptExport(encrypted, "this passphrase is wrong"), /wrong passphrase|damaged file/);
});

test("purges only expired encrypted range files and retains malformed files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tg-export-purge-test-"));
  const expired = await encryptExport("{}\n", passphrase, {
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
    messageCount: 0,
  });
  const expiredPath = path.join(directory, "expired.range.jsonl.enc");
  const malformedPath = path.join(directory, "malformed.range.jsonl.enc");
  const unrelatedPath = path.join(directory, "keep.txt");
  await writeFile(expiredPath, expired, "utf8");
  await writeFile(malformedPath, "not-json", "utf8");
  await writeFile(unrelatedPath, "keep", "utf8");

  const result = await purgeExpiredExports(directory, new Date("2026-08-07T00:00:00.000Z"));
  assert.deepEqual(result.deleted, [expiredPath]);
  assert.deepEqual(result.retainedMalformed, [malformedPath]);
  await assert.rejects(readFile(expiredPath, "utf8"), /ENOENT/);
  assert.equal(await readFile(unrelatedPath, "utf8"), "keep");
});
