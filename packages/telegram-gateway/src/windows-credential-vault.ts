import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { assertPilotPrivateDirectory } from "./pilot-outbox.js";

export type WindowsCredentials = Readonly<{ apiId: number; apiHash: string; passphrase: string }>;
export interface WindowsCredentialCodec {
  protect(plaintext: Uint8Array): Promise<Uint8Array>;
  unprotect(ciphertext: Uint8Array): Promise<Uint8Array>;
}
const CAP = 8192;
const VERSION = "decadans-windows-credentials-v1";
const ENTROPY = "DecadansNeurobro/windows-credentials-v1";
const denied = (): never => { throw new Error("WINDOWS_CREDENTIAL_VAULT_REFUSED"); };
const missing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
function bytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > CAP) return denied();
  return Buffer.from(value);
}
function json(value: Buffer): unknown {
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) return denied();
  try { return JSON.parse(text); } catch { return denied(); }
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}
export function validateWindowsCredentials(value: unknown): WindowsCredentials {
  if (!keys(value, ["apiId", "apiHash", "passphrase"]) || !Number.isSafeInteger(value.apiId) ||
      (value.apiId as number) < 1 || (value.apiId as number) > 2_147_483_647 ||
      typeof value.apiHash !== "string" || !/^[a-fA-F0-9]{32}$/.test(value.apiHash) ||
      typeof value.passphrase !== "string" || value.passphrase.length < 16 || value.passphrase.includes("\0") ||
      Buffer.from(value.passphrase, "utf8").toString("utf8") !== value.passphrase) return denied();
  const credentials = Object.freeze({ apiId: value.apiId as number, apiHash: value.apiHash, passphrase: value.passphrase });
  if (Buffer.byteLength(JSON.stringify(credentials), "utf8") > CAP) return denied();
  return credentials;
}

/** All arguments/environment are fixed public values. Input/output use binary pipes.
 * No profiles, shell interpolation, plaintext arguments or inherited environment. */
export function windowsDpapiInvocation(mode: "protect" | "unprotect") {
  if (mode !== "protect" && mode !== "unprotect") return denied();
  const operation = mode === "protect" ? "Protect" : "Unprotect";
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{` +
    `Add-Type -AssemblyName System.Security;$s=[Console]::OpenStandardInput();$m=New-Object IO.MemoryStream;` +
    `$b=New-Object byte[] 1024;while(($n=$s.Read($b,0,$b.Length)) -gt 0){if($m.Length+$n -gt 8192){exit 1};$m.Write($b,0,$n)};` +
    `if($m.Length -lt 1){exit 1};$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');` +
    `$r=[Security.Cryptography.ProtectedData]::${operation}($m.ToArray(),$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `if($r.Length -lt 1 -or $r.Length -gt 8192){exit 1};$o=[Console]::OpenStandardOutput();$o.Write($r,0,$r.Length);$o.Flush();exit 0` +
    `}catch{exit 1}`;
  return Object.freeze({
    file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32",
      PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules" },
    cwd: "C:\\Windows\\System32", timeoutMs: 10_000,
  });
}

export type DpapiChild = Pick<ChildProcess, "on" | "kill"> & { stdin: Writable; stdout: Readable };
export type DpapiLauncher = (spec: ReturnType<typeof windowsDpapiInvocation>) => DpapiChild;
class HelperUnsettled extends Error { constructor() { super("WINDOWS_CREDENTIAL_VAULT_HELPER_UNSETTLED"); } }
/** Injected launcher is for offline process-lifecycle tests. Production uses only the
 * fixed specification, with stderr discarded at the OS pipe boundary. */
export function createWindowsDpapiCodec(launcher?: DpapiLauncher): WindowsCredentialCodec {
  async function run(mode: "protect" | "unprotect", value: Uint8Array): Promise<Uint8Array> {
    if (!launcher && process.platform !== "win32") return denied();
    const input = bytes(value);
    const spec = windowsDpapiInvocation(mode);
    try {
      return await new Promise<Buffer>((resolvePromise, reject) => {
        const child = launcher ? launcher(spec) : spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env,
          windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        let length = 0;
        let finished = false;
        let stopping = false;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (ok: boolean, unsettled = false) => {
          if (finished) return;
          finished = true; clearTimeout(workTimer); clearTimeout(cleanupTimer);
          const output = ok && length > 0 ? Buffer.concat(chunks, length) : undefined;
          for (const chunk of chunks) chunk.fill(0);
          if (output) resolvePromise(output);
          else reject(unsettled ? new HelperUnsettled() : new Error("WINDOWS_CREDENTIAL_VAULT_REFUSED"));
        };
        const stop = () => {
          if (finished || stopping) return;
          stopping = true;
          // Reserve one second of the total ten-second deadline for exact child close.
          cleanupTimer = setTimeout(() => finish(false, true), 1000);
          try { child.kill(); } catch { /* Must still wait for close, or report unsettled. */ }
        };
        const workTimer = setTimeout(stop, spec.timeoutMs - 1000);
        child.on("error", stop);
        child.stdin.on("error", stop);
        child.stdout.on("error", stop);
        child.stdout.on("data", (chunk: Buffer) => {
          if (finished || stopping) { chunk.fill(0); return; }
          length += chunk.length;
          if (length > CAP) { chunk.fill(0); stop(); return; }
          chunks.push(chunk);
        });
        child.on("close", (code: number | null, signal: string | null) => finish(!stopping && code === 0 && signal === null));
        try { child.stdin.end(input); } catch { stop(); }
      });
    } catch (error) { if (error instanceof HelperUnsettled) throw error; return denied(); }
    finally { input.fill(0); }
  }
  return Object.freeze({ protect: (value: Uint8Array) => run("protect", value), unprotect: (value: Uint8Array) => run("unprotect", value) });
}
const codecDefault = createWindowsDpapiCodec();
function regular(stat: BigIntStats) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.dev <= 0n || stat.ino <= 0n || stat.size < 0n || stat.size > BigInt(CAP)) return denied();
}
function identity(a: BigIntStats, b: BigIntStats) {
  if (a.dev !== b.dev || a.ino !== b.ino) return denied();
}
function decodeEnvelope(raw: Buffer): Buffer {
  const value = json(raw);
  if (!keys(value, ["version", "scope", "entropy", "ciphertext"]) || value.version !== VERSION ||
      value.scope !== "CurrentUser" || value.entropy !== ENTROPY || typeof value.ciphertext !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.ciphertext)) return denied();
  // Our own canonical encoding also rejects duplicate keys and ambiguous JSON forms.
  if (JSON.stringify({ version: VERSION, scope: "CurrentUser", entropy: ENTROPY, ciphertext: value.ciphertext }) !== raw.toString("utf8")) return denied();
  const decoded = bytes(Buffer.from(value.ciphertext, "base64"));
  if (decoded.toString("base64") !== value.ciphertext) return denied();
  return decoded;
}

/** Optional vault only. Construct/exists/load never save; save is explicit and exclusive.
 * Caller verifies owner/SYSTEM ACL and obtains explicit save consent before save().
 * This stores API credentials + session passphrase, not a Telegram session or login.
 * DPAPI binds to the current Windows user, not to a particular caller executable.
 * No overwrite, migration, cleanup, fallback plaintext storage, or automatic retry. */
export function createWindowsCredentialVault(input: { path: string; codec?: WindowsCredentialCodec }) {
  const path = input.path;
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== "windows-credentials-v1.json") return denied();
  const parent = dirname(path);
  const codec = input.codec ?? codecDefault;
  let busy = false;
  async function guarded<T>(operation: (parentStat: BigIntStats) => Promise<T>): Promise<T> {
    if (busy) return denied();
    busy = true;
    try {
      await assertPilotPrivateDirectory(parent);
      const before = await lstat(parent, { bigint: true });
      const result = await operation(before);
      await assertPilotPrivateDirectory(parent);
      identity(before, await lstat(parent, { bigint: true }));
      return result;
    } catch (error) { if (error instanceof HelperUnsettled) throw error; return denied(); }
    finally { busy = false; }
  }
  async function read(): Promise<Buffer> {
    const before = await lstat(path, { bigint: true }); regular(before);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true }); regular(opened); identity(before, opened);
      const raw = Buffer.alloc(CAP + 1);
      let length = 0;
      while (length < raw.length) {
        const read = await handle.read(raw, length, raw.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
      regular(after); regular(named); identity(opened, after); identity(opened, named);
      if (length < 1 || length > CAP || after.size !== BigInt(length) || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return denied();
      return Buffer.from(raw.subarray(0, length));
    } finally { await handle.close(); }
  }
  return Object.freeze({
    exists: () => guarded(async () => {
      try { await lstat(path, { bigint: true }); }
      catch (error) { if (missing(error)) return false; throw error; }
      decodeEnvelope(await read()); return true;
    }),
    load: () => guarded(async () => {
      const ciphertext = decodeEnvelope(await read());
      const plaintext = bytes(await codec.unprotect(ciphertext));
      try {
        const result = validateWindowsCredentials(json(plaintext));
        if (JSON.stringify(result) !== plaintext.toString("utf8")) return denied();
        return result;
      }
      finally { plaintext.fill(0); }
    }),
    save: (credentials: WindowsCredentials) => guarded(async before => {
      const plaintext = Buffer.from(JSON.stringify(validateWindowsCredentials(credentials)), "utf8");
      let encrypted: Buffer;
      try { encrypted = bytes(await codec.protect(plaintext)); }
      finally { plaintext.fill(0); }
      const raw = Buffer.from(JSON.stringify({ version: VERSION, scope: "CurrentUser", entropy: ENTROPY, ciphertext: encrypted.toString("base64") }), "utf8");
      if (raw.length > CAP) return denied();
      await assertPilotPrivateDirectory(parent); identity(before, await lstat(parent, { bigint: true }));
      const handle = await open(path, "wx", 0o600);
      try {
        const created = await handle.stat({ bigint: true }); regular(created);
        const named = await lstat(path, { bigint: true }); regular(named); identity(created, named);
        await handle.writeFile(raw); await handle.sync();
        const after = await handle.stat({ bigint: true }); const final = await lstat(path, { bigint: true });
        regular(after); regular(final); identity(created, after); identity(created, final);
        if (after.size !== BigInt(raw.length) || final.size !== after.size) return denied();
      } finally { await handle.close(); }
    }),
  });
}
