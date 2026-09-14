import test from "node:test";
import assert from "node:assert/strict";
import { decryptSession, encryptSession } from "../src/session-crypto.js";

test("encrypts and decrypts a StringSession without plaintext leakage", async () => {
  const session = "1A-not-a-real-session-value";
  const encrypted = await encryptSession(session, "this is a long test passphrase");
  assert.equal(encrypted.includes(session), false);
  assert.equal(await decryptSession(encrypted, "this is a long test passphrase"), session);
});

test("rejects a wrong session passphrase", async () => {
  const encrypted = await encryptSession("session", "this is the first passphrase");
  await assert.rejects(
    decryptSession(encrypted, "this is another passphrase"),
    /wrong passphrase or damaged file/,
  );
});
