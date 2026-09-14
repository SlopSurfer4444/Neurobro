import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const liveEntryUrl = new URL("../src/phase3-hardening-live-entry.mjs", import.meta.url);

test("trusted entry binds exactly eight retained JS/TypeScript sources and a closed synchronous hook graph", async () => {
  const source = await readFile(liveEntryUrl, "utf8");
  assert.equal((source.match(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\b/gu) ?? []).length, 1);
  assert.match(source, /registerHooks\(\{/u);
  assert.match(source, /format: retainedFormats\.get\(url\), source: retainedSource, shortCircuit: true/u);
  assert.match(source, /if \(BUILTIN_URLS\.has\(url\)\) return nextLoad\(url, context\)/u);
  assert.match(source, /const bootstrap = await import\(BOOTSTRAP_URL\)/u);
  assert.match(source, /bootstrap\.runPhase3HardeningBootstrapV1\(Buffer\.from\(capturedCarrierBytes\), Buffer\.from\(capturedStartupBindingBytes\)\)/u);
  assert.doesNotMatch(source, /import\(carrier|import\([^)]*\.entry|nextResolve\(|process\.cwd/iu);

  const topLevelSpecifiers = [...source.matchAll(/^import .* from "([^"]+)";/gmu)].map((match) => match[1]);
  assert.deepEqual(topLevelSpecifiers, ["node:crypto", "node:fs", "node:module", "node:path", "node:url"]);

  const manifestPattern = /path: "([^"]+\.(?:ts|mjs))",[\s\S]*?url: (?:BOOTSTRAP_URL|"[^"]+"),[\s\S]*?bytes: ([\d_]+),[\s\S]*?sha256: "([0-9a-f]{64})"/gu;
  const manifest = [...source.matchAll(manifestPattern)].map((match) => ({
    path: match[1]!,
    bytes: Number(match[2]!.replaceAll("_", "")),
    sha256: match[3]!,
  }));
  assert.deepEqual(manifest.map((item) => item.path), [
    "phase3-hardening-runtime-contract-v1.mjs",
    "contract.ts",
    "phase3-hardening-bootstrap-v1.ts",
    "phase3-hardening-controller-v2.ts",
    "phase3-hardening-controller-core.ts",
    "phase3-native-observer-adapter-v1.ts",
    "phase3-native-observer-production-transport-v1.ts",
    "rust-sidecar-adapter.ts",
  ]);
  const sourceDirectory = dirname(fileURLToPath(liveEntryUrl));
  for (const binding of manifest) {
    const bytes = await readFile(win32.join(sourceDirectory, binding.path));
    assert.equal(bytes.byteLength, binding.bytes, binding.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), binding.sha256, binding.path);
  }
  assert.equal((source.match(/edge\(/gu) ?? []).length - 1, 32);
});

const SOURCE_NAMES = [
  "phase3-hardening-runtime-contract-v1.mjs",
  "contract.ts",
  "phase3-hardening-bootstrap-v1.ts",
  "phase3-hardening-controller-v2.ts",
  "phase3-hardening-controller-core.ts",
  "phase3-native-observer-adapter-v1.ts",
  "phase3-native-observer-production-transport-v1.ts",
  "rust-sidecar-adapter.ts",
] as const;

interface ProbeResult {
  bootstrapError: string;
  hookRegistrations: number;
  loadedSources: string[];
  sourceReads: Record<string, number>;
  carrierReads: number;
  deniedIoCalls: number;
  processCalls: number;
  defaultLocalLoads: number;
  changedSources: string[];
  refused: string[];
  repeatError: string;
}

// The child receives source snapshots on stdin. It never reads a real carrier,
// and its entry and every downstream source are loaded from memory only.
const ISOLATED_PROBE = String.raw`
  import assert from "node:assert/strict";
  import fs from "node:fs";
  import fsPromises from "node:fs/promises";
  import childProcess from "node:child_process";
  import nodeModule from "node:module";
  import { dirname, win32 } from "node:path";
  import { pathToFileURL } from "node:url";

  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const sourceDirectory = dirname(input.entryPath);
  const entryUrl = pathToFileURL(input.entryPath).href;
  const carrierPath = win32.join(sourceDirectory, "..", "..", "..",
    "project", "verification", "rm-0032-phase3-live-hardening-carrier.json");
  const sourceByPath = new Map(input.sources.map(([name, base64]) =>
    [win32.join(sourceDirectory, name), Buffer.from(base64, "base64")]));
  const originalByUrl = new Map(input.sources.map(([name, base64]) =>
    ["decadans-c1r-ts://module/" + name, Buffer.from(base64, "base64").toString("utf8")]));
  const sourceReads = {};
  const changedSources = [];
  const loadedSources = [];
  let carrierReads = 0;
  let deniedIoCalls = 0;
  let processCalls = 0;
  let defaultLocalLoads = 0;
  let hookRegistrations = 0;
  const carrierBytes = Buffer.from("{}");
  const startupPath="C:\\ProgramData\\DecadansNeurobro\\startup-trust-v1\\accepted-launchbinding-v1.json";
  const root=win32.resolve(sourceDirectory,"..","..","..");
  const canon=v=>v===null||typeof v!=="object"?JSON.stringify(v):Array.isArray(v)?"["+v.map(canon).join(",")+"]":"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canon(v[k])).join(",")+"}";
  const ordinary=path=>({path,bytes:1,sha256:"A".repeat(64)});
  let startupBytes=Buffer.from(canon({
    schema:"decadans.rm0032.accepted-startup-launchbinding.v2",acceptanceId:"12345678-1234-4123-8123-123456789abc",
    acceptedGeneration:{p:{commit:"1".repeat(40),tree:"2".repeat(40),parent:"dad22e37dc12da1ffbf3f1cdf961db6e49da305d"},a:{commit:"3".repeat(40),tree:"4".repeat(40),parent:"1".repeat(40)},k:{commit:"5".repeat(40),tree:"6".repeat(40),parent:"3".repeat(40),carrierBlobId:"e".repeat(40)}},
    repositoryRoot:root,cwd:root,nativePrestart:ordinary("C:\\fixture\\prestart.exe"),
    node:{...ordinary(process.execPath),version:"v24.15.0",platform:"win32",arch:"x64"},
    liveEntry:ordinary(input.entryPath),
    carrier:{path:carrierPath,bytes:2,sha256:"44136FA355B3678A1146AD16F7E8649E94FB4FC21FE77E8310C060F61CAAFF8A"},
    launcher:ordinary("C:\\fixture\\launcher.exe"),observer:ordinary("C:\\fixture\\observer.exe"),
    binaryBindings:{runner:ordinary("C:\\fixture\\runner.exe"),git:ordinary("C:\\Program Files\\Git\\mingw64\\bin\\git.exe"),wsl:ordinary("C:\\Program Files\\WSL\\wsl.exe")},
  }));
  if (input.mode === "startup-hostile") {
    const hostile=JSON.parse(startupBytes.toString());
    if(input.target==="old-v1") hostile.schema="decadans.rm0032.accepted-startup-launchbinding.v1";
    if(input.target==="missing-binaries") delete hostile.binaryBindings;
    if(input.target==="malformed-binary") hostile.binaryBindings.runner.bytes=0;
    if(input.target==="wsl-system32") hostile.binaryBindings.wsl.path="C:\\Windows\\System32\\wsl.exe";
    if(input.target==="wsl-syswow64") hostile.binaryBindings.wsl.path="C:\\Windows\\SysWOW64\\wsl.exe";
    if(input.target==="wsl-alias") hostile.binaryBindings.wsl.path="C:\\Program Files\\WSL\\wsl-alias.exe";
    const changed=Buffer.from(canon(hostile));assert.notDeepEqual(changed,startupBytes);startupBytes=changed;
  }
  const poisonIo = () => { deniedIoCalls++; throw new Error("FIXTURE_UNEXPECTED_IO"); };
  const poisonProcess = () => { processCalls++; throw new Error("FIXTURE_PROCESS_FORBIDDEN"); };
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    childProcess[method] = poisonProcess;
  }
  for (const method of ["lstat", "readFile", "realpath", "open", "writeFile", "appendFile", "mkdir", "rm", "unlink"]) {
    fsPromises[method] = poisonIo;
  }
  for (const method of ["open", "openSync", "readFile", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
    "createReadStream", "createWriteStream", "realpath", "realpathSync", "mkdir", "mkdirSync", "rm", "rmSync", "unlink", "unlinkSync"]) {
    fs[method] = poisonIo;
  }
  fs.lstatSync = (path) => {
    const bytes = path === carrierPath ? carrierBytes : path === startupPath ? startupBytes : sourceByPath.get(path);
    if (bytes === undefined) return poisonIo();
    return { size: bytes.byteLength, isFile: () => true, isSymbolicLink: () => false };
  };
  fs.readFileSync = (path) => {
    if (path === carrierPath) { carrierReads++; return Buffer.from(carrierBytes); }
    if (path === startupPath) return Buffer.from(startupBytes);
    const bytes = sourceByPath.get(path);
    if (bytes === undefined) return poisonIo();
    const name = win32.basename(path);
    sourceReads[name] = (sourceReads[name] ?? 0) + 1;
    return Buffer.from(bytes);
  };
  function changeSource(name) {
    const path = win32.join(sourceDirectory, name);
    const before = sourceByPath.get(path);
    const after = Buffer.from(before);
    after[0] ^= 1;
    assert.equal(after.byteLength, before.byteLength);
    assert.notDeepEqual(after, before);
    sourceByPath.set(path, after);
    changedSources.push(name);
  }
  const realRegisterHooks = nodeModule.registerHooks;
  nodeModule.registerHooks = (hooks) => {
    hookRegistrations++;
    if (input.mode === "post-read-drift") {
      for (const [name] of input.sources) changeSource(name);
    }
    return realRegisterHooks({
      resolve: hooks.resolve,
      load(url, context, nextLoad) {
        const result = hooks.load(url, context, nextLoad);
        if (originalByUrl.has(url)) {
          assert.equal(result.format, url.endsWith(".mjs") ? "module" : "module-typescript");
          assert.equal(result.shortCircuit, true);
          assert.equal(result.source, originalByUrl.get(url), "evaluated source must equal the retained original");
          loadedSources.push(url.slice("decadans-c1r-ts://module/".length));
        }
        return result;
      },
    });
  };
  nodeModule.syncBuiltinESMExports();
  let entrySource = input.entrySource;
  if (input.mode === "broken-bootstrap-edge") {
    const needle = "edge(import.meta.url, BOOTSTRAP_URL, BOOTSTRAP_URL),";
    assert.equal(entrySource.split(needle).length, 2);
    entrySource = entrySource.replace(needle,
      "edge(import.meta.url, BOOTSTRAP_URL + '-deliberately-broken', BOOTSTRAP_URL),");
    assert.notEqual(entrySource, input.entrySource);
  }
  // This fixture hook only supplies the plain-JS entry. Product hooks must
  // short-circuit every downstream TS load, otherwise the fixture refuses.
  realRegisterHooks({ load(url, context, nextLoad) {
    if (url === entryUrl) return { format: "module", source: entrySource, shortCircuit: true };
    if (url.startsWith("node:")) return nextLoad(url, context);
    defaultLocalLoads++;
    throw new Error("FIXTURE_DEFAULT_LOCAL_LOAD_FORBIDDEN");
  } });
  const entry = await import(entryUrl);
  if (input.mode === "source-mutation") changeSource(input.target);
  // Import first: never activate the automatic direct-entry branch.
  process.argv = [process.execPath, input.entryPath];
  process.execArgv = [];
  process.env = {SystemRoot:"C:\\Windows",WINDIR:"C:\\Windows"};
  if (input.mode === "node-extra-environment") process.env.SystemDrive = "C:";
  let bootstrapError = "";
  try { await entry.runPhase3HardeningLiveEntry(); }
  catch (error) { bootstrapError = String(error?.message ?? error); }
  const refused = [];
  if (hookRegistrations === 1) {
    for (const specifier of ["node:fs?hostile", "node:fs", "node:crypto",
      "decadans-c1r-ts://module/unknown.ts", "decadans-c1r-ts://module/contract.ts",
      "./contract.ts?hostile", "data:text/javascript,export default 1",
      "file:///D:/definitely-not-an-admitted-c1-module.mjs"]) {
      try { await import(specifier); refused.push("UNEXPECTED"); }
      catch (error) { refused.push(String(error?.message ?? error)); }
    }
  }
  let repeatError = "";
  try { await entry.runPhase3HardeningLiveEntry(); }
  catch (error) { repeatError = String(error?.message ?? error); }
  process.stdout.write(JSON.stringify({ bootstrapError, hookRegistrations, loadedSources,
    sourceReads, carrierReads, deniedIoCalls, processCalls, defaultLocalLoads, changedSources,
    refused, repeatError }));
`;

async function runIsolatedProbe(
  mode: "positive" | "post-read-drift" | "source-mutation" | "broken-bootstrap-edge" | "startup-hostile" | "node-extra-environment",
  target?: string,
): Promise<ProbeResult> {
  const entryPath = fileURLToPath(liveEntryUrl);
  const sources = await Promise.all(SOURCE_NAMES.map(async (name) => [
    name, (await readFile(new URL(`../src/${name}`, import.meta.url))).toString("base64"),
  ]));
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", ISOLATED_PROBE], {
    input: JSON.stringify({ entryPath, entrySource: await readFile(liveEntryUrl, "utf8"), sources, mode, target }),
    encoding: "utf8",
    windowsHide: true,
    env: {},
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout) as ProbeResult;
  assert.equal(result.deniedIoCalls, 0);
  assert.equal(result.processCalls, 0);
  assert.equal(result.defaultLocalLoads, 0);
  assert.equal(result.repeatError, mode === "node-extra-environment"
    ? "phase3-live-entry-environment-refused"
    : "phase3-live-entry-bootstrap-once-refused");
  return result;
}

function assertPositiveBootstrap(result: ProbeResult): void {
  // Exact refusal comes from the real bootstrap parser after it receives "{}".
  // A resolve failure, export failure, missing carrier, or arbitrary exception
  // is not evidence that the retained graph reached the bootstrap function.
  assert.equal(result.bootstrapError, "carrier-keys-refused");
  assert.equal(result.hookRegistrations, 1);
  assert.equal(result.carrierReads, 1);
  assert.deepEqual([...result.loadedSources].sort(), [...SOURCE_NAMES].sort());
  assert.deepEqual(result.sourceReads, Object.fromEntries(SOURCE_NAMES.map((name) => [name, 1])));
  assert.equal(result.refused.length, 8);
  for (const refusal of result.refused) assert.match(refusal, /^phase3-live-entry-resolve-refused:/u);
}

test("isolated real Node 24 hooks reach the synthetic carrier parser once and stay closed", async () => {
  const result = await runIsolatedProbe("positive");
  assertPositiveBootstrap(result);
  assert.deepEqual(result.changedSources, []);
});

test("all eight actual same-length source mutations refuse before hooks, TS evaluation, or carrier read", async (context) => {
  for (const target of SOURCE_NAMES) {
    await context.test(target, async () => {
      const result = await runIsolatedProbe("source-mutation", target);
      assert.equal(result.bootstrapError, `phase3-live-entry-module-hash-refused:${target}`);
      assert.deepEqual(result.changedSources, [target]);
      assert.equal(result.sourceReads[target], 1);
      assert.equal(result.hookRegistrations, 0);
      assert.deepEqual(result.loadedSources, []);
      assert.equal(result.carrierReads, 0);
    });
  }
});

test("post-read backing-source drift evaluates only the original retained eight sources", async () => {
  const result = await runIsolatedProbe("post-read-drift");
  assertPositiveBootstrap(result);
  assert.deepEqual(result.changedSources, [...SOURCE_NAMES]);
});

test("a connected broken bootstrap edge fails the positive bootstrap oracle", async () => {
  const result = await runIsolatedProbe("broken-bootstrap-edge");
  assert.match(result.bootstrapError, /^phase3-live-entry-resolve-refused:/u);
  assert.equal(result.hookRegistrations, 1);
  assert.deepEqual(result.loadedSources, []);
  assert.equal(result.carrierReads, 0);
  assert.throws(() => assertPositiveBootstrap(result), assert.AssertionError);
});

test("entry guard still refuses SystemDrive in the prestart-to-Node environment", async () => {
  const result = await runIsolatedProbe("node-extra-environment");
  assert.equal(result.bootstrapError, "phase3-live-entry-environment-refused");
  assert.equal(result.hookRegistrations, 0);
  assert.deepEqual(result.loadedSources, []);
  assert.deepEqual(result.sourceReads, {});
  assert.equal(result.carrierReads, 0);
});

test("entry refuses old, incomplete, or shim-bound protected startup bytes before invoking bootstrap",async context=>{
  for(const [target,error] of [
    ["old-v1","startup-schema-or-id-refused"],
    ["missing-binaries","startup-keys-refused"],
    ["malformed-binary","startup-binary-runner-binding-refused"],
    ["wsl-system32","startup-wsl-path-refused"],
    ["wsl-syswow64","startup-wsl-path-refused"],
    ["wsl-alias","startup-wsl-path-refused"],
  ]) await context.test(target!,async()=>{
    const result=await runIsolatedProbe("startup-hostile",target);
    assert.equal(result.bootstrapError,error);
    assert.equal(result.carrierReads,1);
    assert.throws(()=>assertPositiveBootstrap(result),assert.AssertionError);
  });
});
