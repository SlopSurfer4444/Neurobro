import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseAuthConfig } from "../src/auth-config.js";
import { parseConfig } from "../src/config.js";

const fixture = () => ({
  schemaVersion: 1,
  mode: "auth-only",
  account: {
    apiIdEnv: "NEUROBRO_TG_API_ID",
    apiHashEnv: "NEUROBRO_TG_API_HASH",
    sessionPassphraseEnv: "NEUROBRO_TG_SESSION_PASSPHRASE",
    sessionFile: "session.enc",
  },
});

test("account-only login resolves separate session without ingestion attestations", () => {
  const configPath = path.resolve("private-account", "auth.json");
  const config = parseAuthConfig(fixture(), configPath);
  assert.equal(config.account.sessionFile, path.join(path.dirname(configPath), "session.enc"));
  assert.equal("compliance" in config, false);
});

test("auth-only config cannot authorize connected ingestion commands", () => {
  assert.throws(() => parseConfig(fixture(), "auth.json"), /mode/);
  for (const extra of ["sources", "compliance", "output"]) {
    assert.throws(() => parseAuthConfig({ ...fixture(), [extra]: {} }, "auth.json"), /ingestion/);
  }
});

test("auth parser rejects malformed settings and inline credentials", () => {
  for (const raw of [null, [], {}, { ...fixture(), mode: "read-only" }, { ...fixture(), account: [] }]) {
    assert.throws(() => parseAuthConfig(raw, "auth.json"));
  }
  for (const key of Object.keys(fixture().account)) {
    assert.throws(() => parseAuthConfig({ ...fixture(), account: { ...fixture().account, [key]: "" } }, "auth.json"));
  }
  assert.throws(() => parseAuthConfig({ ...fixture(), account: { ...fixture().account, apiHash: "inline-secret" } }, "auth.json"), /Unknown/);
  assert.throws(() => parseAuthConfig({ ...fixture(), account: { ...fixture().account, apiIdEnv: "bad name" } }, "auth.json"), /Invalid/);
});
