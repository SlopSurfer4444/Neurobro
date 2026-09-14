import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, link, lstat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWindowsCredentialVault, createWindowsDpapiCodec, validateWindowsCredentials, windowsDpapiInvocation, type WindowsCredentialCodec, type DpapiChild } from "../src/windows-credential-vault.js";

const invented = Object.freeze({ apiId: 123456, apiHash: "a".repeat(32), passphrase: "INVENTED-OFFLINE-PASSPHRASE" });
const refused = (error: unknown) => error instanceof Error && error.message === "WINDOWS_CREDENTIAL_VAULT_REFUSED" && error.cause === undefined;
const xor = (value: Uint8Array) => Buffer.from(value).map(byte => byte ^ 0x55);
function fakeCodec() {
  let protects = 0; let unprotects = 0;
  const codec: WindowsCredentialCodec = {
    async protect(value) { protects++; return xor(value); },
    async unprotect(value) { unprotects++; return xor(value); },
  };
  return { codec, count: () => ({ protects, unprotects }) };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "decadans-vault-invented-test-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "windows-credentials-v1.json");
  return { directory, path };
}

test("construction and absent exists never save or invoke codec; explicit save/load round trip uses encrypted envelope", async t => {
  const f = await fixture(t); const c = fakeCodec(); const vault = createWindowsCredentialVault({ path: f.path, codec: c.codec });
  assert.deepEqual(c.count(), { protects: 0, unprotects: 0 }); assert.equal(await vault.exists(), false);
  await assert.rejects(lstat(f.path)); await vault.save(invented);
  const raw = await readFile(f.path, "utf8");
  assert.equal(raw.includes(invented.passphrase), false); assert.equal(raw.includes(invented.apiHash), false);
  const record = JSON.parse(raw); assert.deepEqual(Object.keys(record), ["version", "scope", "entropy", "ciphertext"]);
  assert.equal(record.scope, "CurrentUser"); assert.equal(record.entropy, "DecadansNeurobro/windows-credentials-v1");
  assert.equal(await vault.exists(), true); assert.deepEqual(c.count(), { protects: 1, unprotects: 0 });
  assert.deepEqual(await vault.load(), invented); assert.deepEqual(c.count(), { protects: 1, unprotects: 1 });
});

test("second save refuses exclusively and preserves original ciphertext", async t => {
  const f = await fixture(t); const c = fakeCodec(); const vault = createWindowsCredentialVault({ path: f.path, codec: c.codec });
  await vault.save(invented); const before = await readFile(f.path);
  await assert.rejects(vault.save({ ...invented, passphrase: "ANOTHER-INVENTED-PASSPHRASE" }), refused);
  assert.deepEqual(await readFile(f.path), before); assert.deepEqual(await vault.load(), invented);
});

test("invalid credential shapes/limits refuse before codec and never create a file", async t => {
  const f = await fixture(t); const c = fakeCodec(); const vault = createWindowsCredentialVault({ path: f.path, codec: c.codec });
  for (const input of [null, {}, { ...invented, extra: "private" }, { ...invented, apiId: 0 }, { ...invented, apiId: 2 ** 31 },
    { ...invented, apiId: "123" }, { ...invented, apiHash: "private invalid" }, { ...invented, passphrase: "short" },
    { ...invented, passphrase: "x".repeat(8192) }, { ...invented, passphrase: "x".repeat(16) + "\0" },
    { ...invented, passphrase: "x".repeat(16) + "\ud800" }]) {
    assert.throws(() => validateWindowsCredentials(input), refused);
    await assert.rejects(vault.save(input as typeof invented), refused);
  }
  assert.deepEqual(c.count(), { protects: 0, unprotects: 0 }); assert.equal(await vault.exists(), false);
});

test("wrong scope/entropy/version, extra or duplicate fields and malformed base64 refuse before unprotect", async t => {
  const f = await fixture(t); const c = fakeCodec(); const vault = createWindowsCredentialVault({ path: f.path, codec: c.codec });
  await vault.save(invented); const original = await readFile(f.path, "utf8"); const record = JSON.parse(original);
  const invalid = [{ ...record, scope: "LocalMachine" }, { ...record, entropy: "wrong" }, { ...record, version: "v2" },
    { ...record, extra: "private" }, { ...record, ciphertext: "!invalid!" }, { ...record, ciphertext: "" }].map(value => JSON.stringify(value));
  invalid.push(original.replace('"scope":"CurrentUser"', '"scope":"LocalMachine","scope":"CurrentUser"'), "{}", "null", "not JSON", "x".repeat(8193));
  for (const value of invalid) {
    await writeFile(f.path, value); await assert.rejects(vault.load(), refused); await assert.rejects(vault.exists(), refused);
  }
  assert.equal(c.count().unprotects, 0);
});

test("decrypted plaintext schema and canonical JSON are checked before returning credentials", async t => {
  const f = await fixture(t); const c = fakeCodec(); await createWindowsCredentialVault({ path: f.path, codec: c.codec }).save(invented);
  for (const text of ["PRIVATE invalid JSON", "{}", JSON.stringify({ ...invented, extra: "private" }),
    JSON.stringify(invented).replace('"apiId":123456', '"apiId":9,"apiId":123456'), "x".repeat(8193)]) {
    const vault = createWindowsCredentialVault({ path: f.path, codec: { ...c.codec, async unprotect() { return Buffer.from(text); } } });
    await assert.rejects(vault.load(), refused);
  }
});

test("codec errors and wrong-account DPAPI failures contain no raw error or secret in public failure", async t => {
  const f = await fixture(t); const c = fakeCodec(); const raw = new Error(invented.passphrase);
  const vault = createWindowsCredentialVault({ path: f.path, codec: { ...c.codec, async protect() { throw raw; } } });
  await assert.rejects(vault.save(invented), refused); assert.equal(await vault.exists(), false);
  await createWindowsCredentialVault({ path: f.path, codec: c.codec }).save(invented);
  const loader = createWindowsCredentialVault({ path: f.path, codec: { ...c.codec, async unprotect() { throw raw; } } });
  await assert.rejects(loader.load(), refused); assert.equal(await loader.exists(), true);
});

test("codec output and encoded file remain bounded at 8KiB", async t => {
  const f = await fixture(t); const c = fakeCodec();
  for (const value of [Buffer.alloc(0), Buffer.alloc(8193), Buffer.alloc(8192)]) {
    const vault = createWindowsCredentialVault({ path: f.path, codec: { ...c.codec, async protect() { return value; } } });
    await assert.rejects(vault.save(invented), refused); assert.equal(await vault.exists(), false);
  }
});

test("file path is exact, existing parent required, directory/hardlink targets refused", async t => {
  const f = await fixture(t); const c = fakeCodec();
  for (const path of ["windows-credentials-v1.json", join(f.directory, "wrong.json"), f.directory]) assert.throws(() => createWindowsCredentialVault({ path, codec: c.codec }), refused);
  const absent = createWindowsCredentialVault({ path: join(f.directory, "absent", "windows-credentials-v1.json"), codec: c.codec });
  await assert.rejects(absent.save(invented), refused); await assert.rejects(lstat(join(f.directory, "absent")));
  await mkdir(f.path); await assert.rejects(createWindowsCredentialVault({ path: f.path, codec: c.codec }).exists(), refused);
  const second = await fixture(t); const vault = createWindowsCredentialVault({ path: second.path, codec: c.codec });
  await vault.save(invented); await link(second.path, join(second.directory, "invented-hardlink"));
  await assert.rejects(vault.exists(), refused); await assert.rejects(vault.load(), refused);
});

test("parent replacement during protect refuses before write without deleting either directory", async t => {
  const f = await fixture(t); const c = fakeCodec(); const old = f.directory + "-moved";
  t.after(async () => { await rm(old, { recursive: true, force: true }); });
  const vault = createWindowsCredentialVault({ path: f.path, codec: { ...c.codec, async protect(value) {
    await rename(f.directory, old); await mkdir(f.directory); return xor(value);
  } } });
  await assert.rejects(vault.save(invented), refused); await assert.rejects(lstat(f.path));
  assert.equal((await lstat(old)).isDirectory(), true); assert.equal((await lstat(f.directory)).isDirectory(), true);
});

test("concurrent operations cannot compete for a save", async t => {
  const f = await fixture(t); const c = fakeCodec(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const vault = createWindowsCredentialVault({ path: f.path, codec: { ...c.codec, async protect(value) { entered(); await gate; return xor(value); } } });
  const saving = vault.save(invented); await ready;
  await assert.rejects(vault.save(invented), refused); await assert.rejects(vault.load(), refused); release(); await saving;
  assert.deepEqual(await vault.load(), invented);
});

test("PowerShell invocation contains only fixed public args/environment, CurrentUser entropy, bounded pipes script", () => {
  for (const mode of ["protect", "unprotect"] as const) {
    const spec = windowsDpapiInvocation(mode); const encoded = JSON.stringify(spec);
    assert.equal(spec.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"); assert.equal(spec.timeoutMs, 10000);
    assert.deepEqual(spec.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert.ok(spec.args[4]!.includes("::CurrentUser")); assert.equal(spec.args[4]!.includes("LocalMachine"), false);
    assert.ok(spec.args[4]!.includes("OpenStandardInput")); assert.ok(spec.args[4]!.includes("OpenStandardOutput"));
    assert.ok(spec.args[4]!.includes("8192")); assert.ok(spec.args[4]!.includes("DecadansNeurobro/windows-credentials-v1"));
    assert.equal(encoded.includes(invented.passphrase), false); assert.equal(encoded.includes(invented.apiHash), false);
    assert.deepEqual(Object.keys(spec.env).sort(), ["PATH", "PSModulePath", "SystemRoot", "WINDIR"]);
    assert.equal(spec.env.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
  }
  assert.throws(() => windowsDpapiInvocation("invalid" as "protect"), refused);
});

function fakeProcess() {
  const emitter = new EventEmitter(); const stdin = new PassThrough(); const stdout = new PassThrough();
  let kills = 0;
  const child = Object.assign(emitter, { stdin, stdout, kill: () => { kills++; return false; } }) as unknown as DpapiChild;
  return { child, emitter, stdin, stdout, kills: () => kills };
}
test("DPAPI codec transfers invented bytes only through stdin and returns only after exact successful close", async () => {
  const f = fakeProcess(); const codec = createWindowsDpapiCodec(spec => {
    assert.equal(JSON.stringify(spec).includes(invented.passphrase), false); return f.child;
  });
  const output = codec.protect(Buffer.from(invented.passphrase));
  assert.equal(f.stdin.read().toString(), invented.passphrase);
  let settled = false; void output.then(() => { settled = true; });
  f.stdout.emit("data", Buffer.from("invented ciphertext")); await Promise.resolve(); assert.equal(settled, false);
  f.emitter.emit("close", 0, null); assert.equal(Buffer.from(await output).toString(), "invented ciphertext"); assert.equal(f.kills(), 0);
});
test("DPAPI overflow or process error kills once but waits for close before sanitized refusal", async () => {
  for (const reason of ["overflow", "error"] as const) {
    const f = fakeProcess(); const pending = createWindowsDpapiCodec(() => f.child).protect(Buffer.from("invented"));
    const check = assert.rejects(pending, refused); let settled = false; void check.then(() => { settled = true; });
    if (reason === "overflow") f.stdout.emit("data", Buffer.alloc(8193)); else f.emitter.emit("error", new Error(invented.passphrase));
    await Promise.resolve(); assert.equal(settled, false); assert.equal(f.kills(), 1);
    f.emitter.emit("close", 1, null); await check;
  }
});
test("DPAPI ten-second deadline waits bounded cleanup and reports unsettled helper when kill has no close", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fakeProcess(); const pending = createWindowsDpapiCodec(() => f.child).protect(Buffer.from("invented"));
  const check = assert.rejects(pending, error => error instanceof Error && error.message === "WINDOWS_CREDENTIAL_VAULT_HELPER_UNSETTLED");
  t.mock.timers.tick(9000); assert.equal(f.kills(), 1); t.mock.timers.tick(1000); await check;
  f.emitter.emit("close", 0, null); // A late close cannot promote the previous unknown result.
});
