import { ACCEPTED_C1, CARRIER_KEYS, GIT_GUARD_BINDINGS, GIT_GUARD_SEMANTICS } from "../src/phase3-hardening-runtime-contract-v1.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { test, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalizeJson, sha256Hex } from "../src/contract.ts";

const bootstrapUrl = new URL("../src/phase3-hardening-bootstrap-v1.ts", import.meta.url);
const liveEntryUrl = new URL("../src/phase3-hardening-live-entry.mjs", import.meta.url);
const controllerUrl = new URL("../src/phase3-hardening-controller-v2.ts", import.meta.url).href;
const observerUrl = new URL("../src/phase3-native-observer-adapter-v1.ts", import.meta.url).href;
const transportUrl = new URL("../src/phase3-native-observer-production-transport-v1.ts", import.meta.url).href;
const runnerUrl = new URL("../src/rust-sidecar-adapter.ts", import.meta.url).href;
const coreUrl = new URL("../src/phase3-hardening-controller-core.ts", import.meta.url).href;
const FIXED_CARRIER_PATH = "project/verification/rm-0032-phase3-live-hardening-carrier.json";
const CARRIER_SCHEMA = "decadans.rm0032.phase3-hardening-carrier.v16";

test("bootstrap exposes one captured-carrier package-internal entry and keeps the launcher port exact-purpose", async () => {
  const source = await readFile(bootstrapUrl, "utf8");
  assert.match(source, /export async function runPhase3HardeningBootstrapV1\([\s\S]*capturedCarrierBytes: Uint8Array,[\s\S]*\): Promise<Phase3ControllerResult>/u);
  assert.equal((source.match(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\b/gu) ?? []).length, 1);
  assert.match(source, /spawn\(launcherAbsolutePath, \[LAUNCHER_MODE\]/u);
  assert.match(source, /const LAUNCHER_MODE = "supervise-observer-v1"/u);
  assert.match(source, /shell: false/u);
  assert.match(source, /windowsHide: true/u);
  assert.match(source, /stdio: \["pipe", "pipe", "pipe"\]/u);
  assert.match(source, /SystemDrive: "C:"/u);
  assert.match(source, /SystemRoot: "C:\\\\Windows"/u);
  assert.match(source, /WINDIR: "C:\\\\Windows"/u);
  assert.match(source, /signal: abortController\.signal/u);
  assert.match(source, /deadlineMs \+ OUTER_LAUNCHER_GRACE_MS/u);
  assert.match(source, /verifyExactRegularFile\(carrier\.launcher, "launcher-binding-refused"\)/u);
  assert.match(source, /verifyExactRegularFile\(launcher, "launcher-prestart-binding-refused"\)/u);
  assert.doesNotMatch(source, /process\.env|process\.cwd|powershell|cmd\.exe|wsl\.exe|https?:|retry|cleanup/iu);
});

test("bootstrap rejects ordinary imported/test argv before any carrier or process work", async () => {
  const module = await import(`${bootstrapUrl.href}?argv-refusal=${Date.now()}`);
  assert.deepEqual(Object.keys(module), ["runPhase3HardeningBootstrapV1"]);
  assert.equal(module.runPhase3HardeningBootstrapV1.length, 2);
  await assert.rejects(module.runPhase3HardeningBootstrapV1(Buffer.from("{}"), Buffer.from("{}")), /argv-binding-refused/u);
  await assert.rejects(module.runPhase3HardeningBootstrapV1(Buffer.alloc(0), Buffer.from("{}")), /captured-carrier-bytes-refused/u);
});

test("bootstrap composes carrier-bound launcher transport, accepted observer, boundary, and controller exactly once", async () => {
  const calls: string[] = [];
  const spawnCalls: Array<{ path: string; argv: string[]; options: Record<string, unknown> }> = [];
  let capturedPort: any;
  let capturedBoundary: any;
  let observerReadOutcome: "known" | "refused" | "unknown" = "known";
  let observerCreateOutcome: "known" | "refused" | "unknown" = "known";
  let spawnMode: "success" | "stderr" | "overflow" | "never-started" | "timeout" | "incomplete" = "success";
  let abortCount = 0;
  const fileReads: string[] = [];
  const bootstrapPath = fileURLToPath(bootstrapUrl);
  const sourceDirectory = dirname(bootstrapPath);
  const liveEntryPath = win32.join(sourceDirectory, "phase3-hardening-live-entry.mjs");
  const repositoryRoot = win32.resolve(sourceDirectory, "..", "..", "..");
  const launcherPath = "D:\\fixture\\bin\\rm0032-phase3-native-observer-launcher-v1.exe";
  const observerPath = "D:\\fixture\\bin\\rm0032-phase3-native-observer-v1.exe";
  const evidenceRoot = "D:\\fixture\\evidence";
  const nodeBytes = Buffer.from("invented-node-image", "utf8");
  const liveBytes = Buffer.from("invented-live-entry", "utf8");
  const launcherBytes = Buffer.from("invented-launcher-image", "utf8");
  const observerBytes = Buffer.from("invented-observer-image", "utf8");
  const binding = (path: string, bytes: Buffer) => ({
    path,
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes).toUpperCase(),
  });
  const shape=(keys:readonly string[], overrides:Record<string,unknown>={}) => Object.assign(Object.fromEntries(keys.map(k=>[k,null])),overrides);
  const historical=binding("C:\\fixture\\historical",Buffer.from("h"));
  const p={commit:"1".repeat(40),tree:"2".repeat(40),parent:ACCEPTED_C1.commit};
  const a={commit:"3".repeat(40),tree:"4".repeat(40),parent:p.commit};
  const k={commit:"5".repeat(40),tree:"6".repeat(40),parent:a.commit,carrierBlobId:"e".repeat(40)};
  const carrier = {
    schema: CARRIER_SCHEMA,
    phase: shape(CARRIER_KEYS.PHASE_KEYS),
    fixedCarrierPath: FIXED_CARRIER_PATH,
    predecessorBindings: {phase2Receipt:historical,phase3A:shape(CARRIER_KEYS.PHASE3A_KEYS,{receipt:historical,decision:historical,artifactBindings:[]})},
    controllerBindings: shape(CARRIER_KEYS.CONTROLLER_KEYS,{source:historical,test:historical,receipt:{...historical,outcome:"historical",selfAcceptanceClaimed:false}}),
    binaryBindings: {runner:{...historical,path:"C:\\fixture\\runner.exe"},git:{...historical,path:"C:\\Program Files\\Git\\mingw64\\bin\\git.exe"},wsl:{...historical,path:"C:\\Program Files\\WSL\\wsl.exe"}},
    productionBindings: {
      node: binding(process.execPath, nodeBytes),
      liveEntry: binding(liveEntryPath, liveBytes),
      launcher: binding(launcherPath, launcherBytes),
      observer: binding(observerPath, observerBytes),
      observerEvidenceRootAbsolutePath: evidenceRoot,
    },
    repositoryBinding: {root:repositoryRoot,acceptedC1:{...ACCEPTED_C1},acceptedP:p,acceptedA:a},
    policy: shape(CARRIER_KEYS.POLICY_KEYS),
    review: shape(CARRIER_KEYS.REVIEW_KEYS),
    parentDecision: shape(CARRIER_KEYS.PARENT_DECISION_KEYS),
    authorization: shape(CARRIER_KEYS.AUTHORIZATION_KEYS),
    guestExecutables: [],
    commands: Array.from({length:7},(_,i)=>({role:i<6?"git-guard":"wsl-management",decoder:"raw-hash-only",semanticClass:i<6?GIT_GUARD_SEMANTICS[i]:"fixture",requestPath:"C:\\fixture\\request-"+i,request:{executable:{path:i<6?"C:\\Program Files\\Git\\mingw64\\bin\\git.exe":"C:\\Program Files\\WSL\\wsl.exe",sha256:historical.sha256.toLowerCase()},environment:i<6?{inherit:false,allowlist:[],values:{}}:{inherit:false,allowlist:["SystemRoot","WINDIR"],values:{SystemRoot:"C:\\Windows",WINDIR:"C:\\Windows"}}},expected:i<6?{exitCode:0,stdoutBinding:GIT_GUARD_BINDINGS[i],stderrBytes:0,stderrSha256:sha256Hex(Buffer.alloc(0)).toUpperCase()}:{exitCode:0,stdoutBytes:0,stdoutSha256:sha256Hex(Buffer.alloc(0)).toUpperCase(),stderrBytes:0,stderrSha256:sha256Hex(Buffer.alloc(0)).toUpperCase()}})),
  };
  const carrierBytes = Buffer.from(canonicalizeJson(carrier), "utf8");
  const startupBytes=Buffer.from(canonicalizeJson({
    schema:"decadans.rm0032.accepted-startup-launchbinding.v2",acceptanceId:"12345678-1234-4123-8123-123456789abc",
    acceptedGeneration:{p,a,k},repositoryRoot,cwd:repositoryRoot,
    nativePrestart:binding("D:\\fixture\\prestart.exe",Buffer.from("p")),
    node:{...carrier.productionBindings.node,version:"v24.15.0",platform:"win32",arch:"x64"},
    liveEntry:carrier.productionBindings.liveEntry,
    carrier:binding(win32.join(repositoryRoot,...FIXED_CARRIER_PATH.split("/")),carrierBytes),
    launcher:carrier.productionBindings.launcher,observer:carrier.productionBindings.observer,
    binaryBindings:carrier.binaryBindings,
  }));
  const files = new Map<string, Buffer>([
    [process.execPath, nodeBytes],
    [liveEntryPath, liveBytes],
    [launcherPath, launcherBytes],
    [observerPath, observerBytes],
  ]);
  const sentinel = Object.freeze({ outcome: "known-clear" });
  const fakeTransport = Object.freeze({ invoke: async () => { throw new Error("unreachable transport"); } });
  const fakeObserver = Object.freeze({
    async readExactBoundFile(request: any) {
      assert.equal(request.operation, "read-bound-file");
      if (observerReadOutcome !== "known") return { outcome: observerReadOutcome };
      const content = Buffer.from("invented-boundary-read", "utf8");
      return { outcome: "known", observation: {
        contentBase64: content.toString("base64"),
        contentSha256: sha256Hex(content),
      } };
    },
    async createNewDurableFile(request: any) {
      assert.equal(request.operation, "create-new-durable-file");
      if (observerCreateOutcome !== "known") return { outcome: observerCreateOutcome };
      return { outcome: "known", observation: {
        reopenedReadbackSha256: sha256Hex(Buffer.from(request.contentBase64, "base64")),
      } };
    },
  });
  const contexts = [
    mock.module("node:fs/promises", { namedExports: {
      async lstat(path: string) {
        fileReads.push("lstat:"+path);
        const bytes = files.get(path);
        assert.ok(bytes, `unexpected lstat path ${path}`);
        return { size: bytes.byteLength, isFile: () => true, isSymbolicLink: () => false };
      },
      async readFile(path: string) {
        fileReads.push("read:"+path);
        const bytes = files.get(path);
        assert.ok(bytes, `unexpected read path ${path}`);
        return Buffer.from(bytes);
      },
    } }),
    mock.module("node:child_process", { namedExports: {
      spawn(path: string, argv: string[], options: Record<string, unknown>) {
        spawnCalls.push({ path, argv, options });
        const child: any = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = spawnMode === "never-started" ? undefined : 4242;
        const signal = options.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          abortCount += 1;
          child.stdout.end();
          child.stderr.end();
          setImmediate(() => child.emit("close", null));
        }, { once: true });
        setImmediate(() => {
          if (spawnMode === "never-started") {
            child.emit("error", new Error("invented spawn refusal"));
          } else if (spawnMode === "timeout") {
            child.emit("spawn");
          } else {
            child.emit("spawn");
            const stdout = spawnMode === "overflow"
              ? Buffer.alloc(1_500_001, 0x61)
              : Buffer.from("invented-launcher-result", "utf8");
            child.stdout.end(stdout);
            if (spawnMode === "stderr") child.stderr.end(Buffer.from([0x78]));
            else if (spawnMode !== "incomplete") child.stderr.end();
            setImmediate(() => child.emit("close", 0));
          }
        });
        return child;
      },
    } }),
    mock.module(controllerUrl, { namedExports: {
      PHASE3_HARDENING_CARRIER_V16_SCHEMA: CARRIER_SCHEMA,
      PHASE3_HARDENING_V16_FIXED_CARRIER_PATH: FIXED_CARRIER_PATH,
      async runPhase3HardeningControllerV2(actualBytes: Uint8Array, actualPath: string, boundary: object, actualStartupBytes: Uint8Array) {
        assert.deepEqual(Buffer.from(actualStartupBytes), startupBytes);
        calls.push("controller");
        assert.deepEqual(Buffer.from(actualBytes), carrierBytes);
        assert.equal(actualPath, FIXED_CARRIER_PATH);
        assert.deepEqual(Object.keys(boundary).sort(), [
          "createNewDurableFile", "invokeAcceptedRustSidecar", "monotonicMilliseconds", "readBoundFile",
        ]);
        capturedBoundary = boundary;
        const carrierRead = await (boundary as any).readBoundFile(FIXED_CARRIER_PATH);
        assert.equal(carrierRead.resolvedPath, win32.join(repositoryRoot,...FIXED_CARRIER_PATH.split("/")));
        assert.equal(carrierRead.path, FIXED_CARRIER_PATH);
        for (const hostile of ["../escape", "project//double", "project/./dot", "project/back\\\\slash", "project/name:stream"]) await assert.rejects((boundary as any).readBoundFile(hostile));
        const read = await (boundary as any).readBoundFile("project/invented-read.txt");
        assert.equal(Buffer.from(read.content).toString("utf8"), "invented-boundary-read");
        const created = await (boundary as any).createNewDurableFile(
          "project/invented-create.txt",
          Buffer.from("invented-boundary-create", "utf8"),
        );
        assert.equal(created.created, true);
        assert.equal(created.durableFlushCompleted, true);
        return sentinel;
      },
    } }),
    mock.module(observerUrl, { namedExports: {
      NATIVE_OBSERVER_CONSUMER: "rm-0032-phase3-hardening-coordinator",
      NATIVE_OBSERVER_REQUEST_SCHEMA: "decadans.rm0032.native-observer-request.v1",
      NATIVE_OBSERVER_VERSION: "v1",
      createPhase3NativeObserverV1(actualBinding: object, actualTransport: object) {
        calls.push("observer");
        assert.equal(actualTransport, fakeTransport);
        assert.deepEqual(actualBinding, {
          observerAbsolutePath: observerPath,
          observerSha256: sha256Hex(observerBytes),
          evidenceRootAbsolutePath: evidenceRoot,
        });
        return fakeObserver;
      },
    } }),
    mock.module(transportUrl, { namedExports: {
      createPhase3NativeObserverProductionTransportV1(actualBinding: any, port: object) {
        calls.push("transport");
        assert.equal(actualBinding.launcherAbsolutePath, launcherPath);
        assert.equal(actualBinding.launcherSha256, sha256Hex(launcherBytes));
        assert.equal(actualBinding.carrierSha256, sha256Hex(carrierBytes));
        assert.deepEqual(Object.keys(port), ["invoke"]);
        capturedPort = port;
        return fakeTransport;
      },
    } }),
    mock.module(runnerUrl, { namedExports: {
      async invokeRustSidecar() { throw new Error("unreachable runner"); },
    } }),
    mock.module(coreUrl, { namedExports: {
      Phase3ControllerRefusal: class Phase3ControllerRefusal extends Error {},
    } }),
  ];
  const originalArgv = process.argv;
  try {
    process.argv = [process.execPath, liveEntryPath];
    const module = await import(`${bootstrapUrl.href}?composition=${Date.now()}`);
    for(const change of [
      (v:any)=>{v.schema="decadans.rm0032.accepted-startup-launchbinding.v1";},
      (v:any)=>{delete v.binaryBindings;},
      (v:any)=>{delete v.binaryBindings.runner;},
      (v:any)=>{v.binaryBindings.git.extra=true;},
      (v:any)=>{v.binaryBindings.wsl.bytes++;},
      (v:any)=>{v.binaryBindings.wsl.sha256="B".repeat(64);},
      (v:any)=>{v.binaryBindings.wsl.path="C:\\Windows\\System32\\wsl.exe";},
      (v:any)=>{v.binaryBindings.wsl.path="C:\\Windows\\SysWOW64\\wsl.exe";},
      (v:any)=>{v.binaryBindings.wsl.path="C:\\Program Files\\WSL\\wsl-alias.exe";},
    ]) {
      const hostile=JSON.parse(startupBytes.toString());change(hostile);
      const bytes=Buffer.from(canonicalizeJson(hostile));assert.notDeepEqual(bytes,startupBytes);
      await assert.rejects(module.runPhase3HardeningBootstrapV1(carrierBytes,bytes),/startup-/u);
      assert.deepEqual(fileReads,[]);assert.deepEqual(calls,[]);assert.deepEqual(spawnCalls,[]);
    }
    const result = await module.runPhase3HardeningBootstrapV1(carrierBytes, startupBytes);
    assert.equal(result, sentinel);
    assert.deepEqual(calls, ["transport", "observer", "controller"]);
    assert.ok(capturedPort);
    const portResult = await capturedPort.invoke({
      canonicalSupervisorInputBytes: Buffer.from("invented-supervisor-frame", "utf8"),
      deadlineMs: 1_000,
    });
    assert.deepEqual({
      invocationAttemptCount: portResult.invocationAttemptCount,
      launcherStarted: portResult.launcherStarted,
      exitCode: portResult.exitCode,
      stdout: Buffer.from(portResult.stdout).toString("utf8"),
      stderrBytes: portResult.stderr.byteLength,
      stdoutComplete: portResult.stdoutComplete,
      stderrComplete: portResult.stderrComplete,
    }, {
      invocationAttemptCount: 1,
      launcherStarted: true,
      exitCode: 0,
      stdout: "invented-launcher-result",
      stderrBytes: 0,
      stdoutComplete: true,
      stderrComplete: true,
    });
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0]!.path, launcherPath);
    assert.deepEqual(spawnCalls[0]!.argv, ["supervise-observer-v1"]);
    assert.equal(spawnCalls[0]!.options.shell, false);
    assert.equal(spawnCalls[0]!.options.windowsHide, true);
    assert.equal(spawnCalls[0]!.options.cwd, win32.dirname(launcherPath));
    assert.notEqual(spawnCalls[0]!.options.cwd, process.cwd());
    assert.deepEqual(spawnCalls[0]!.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.deepEqual(spawnCalls[0]!.options.env, {
      SystemDrive: "C:",
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
    });
    assert.equal(spawnCalls[0]!.options.killSignal, "SIGKILL");
    assert.ok(spawnCalls[0]!.options.signal instanceof AbortSignal);
    observerReadOutcome = "refused";
    await assert.rejects(capturedBoundary.readBoundFile("project/invented-read.txt"), /native-observer-read-not-known/u);
    observerReadOutcome = "unknown";
    await assert.rejects(capturedBoundary.readBoundFile("project/invented-read.txt"), /native-observer-read-not-known/u);
    observerCreateOutcome = "refused";
    await assert.rejects(
      capturedBoundary.createNewDurableFile("project/invented-create.txt", Buffer.from("x")),
      /native-observer-create-refused/u,
    );
    observerCreateOutcome = "unknown";
    await assert.rejects(
      capturedBoundary.createNewDurableFile("project/invented-create.txt", Buffer.from("x")),
      /native-observer-create-unknown/u,
    );
    await assert.rejects(capturedPort.invoke({
      canonicalSupervisorInputBytes: Buffer.from("invented-supervisor-frame", "utf8"),
      deadlineMs: 1_000,
      argv: ["hostile"],
    }), /launcherPortInput-keys-refused/u);
    assert.equal(spawnCalls.length, 1);
    spawnMode = "stderr";
    const stderrResult = await capturedPort.invoke({
      canonicalSupervisorInputBytes: Buffer.from("invented-supervisor-frame", "utf8"),
      deadlineMs: 1_000,
    });
    assert.equal(stderrResult.launcherStarted, true);
    assert.equal(stderrResult.stderr.byteLength, 0);
    assert.equal(stderrResult.stderrComplete, false);
    spawnMode = "overflow";
    const overflowResult = await capturedPort.invoke({
      canonicalSupervisorInputBytes: Buffer.from("invented-supervisor-frame", "utf8"),
      deadlineMs: 1_000,
    });
    assert.equal(overflowResult.stdout.byteLength, 1_500_000);
    assert.equal(overflowResult.stdoutComplete, false);
    spawnMode = "incomplete";
    const incompleteResult = await capturedPort.invoke({
      canonicalSupervisorInputBytes: Buffer.from("invented-supervisor-frame", "utf8"),
      deadlineMs: 1_000,
    });
    assert.equal(incompleteResult.stderrComplete, false);
    spawnMode = "never-started";
    const neverStarted = await capturedPort.invoke({
      canonicalSupervisorInputBytes: Buffer.from("invented-supervisor-frame", "utf8"),
      deadlineMs: 1_000,
    });
    assert.equal(neverStarted.launcherStarted, false);
    spawnMode = "timeout";
    const timedOut = await capturedPort.invoke({
      canonicalSupervisorInputBytes: Buffer.from("invented-supervisor-frame", "utf8"),
      deadlineMs: 1,
    });
    assert.equal(timedOut.launcherStarted, true);
    assert.equal(timedOut.exitCode, null);
    assert.equal(abortCount, 1);
    assert.equal(spawnCalls.length, 6);
    files.set(launcherPath, Buffer.from("drifted-launcher-image", "utf8"));
    await assert.rejects(capturedPort.invoke({
      canonicalSupervisorInputBytes: Buffer.from("invented-supervisor-frame", "utf8"),
      deadlineMs: 1_000,
    }), /launcher-prestart-binding-refused/u);
    assert.equal(spawnCalls.length, 6);
  } finally {
    process.argv = originalArgv;
    for (const context of contexts.reverse()) context.restore();
  }
});
