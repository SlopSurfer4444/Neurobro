import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { mkdtemp } from "node:fs/promises";

import {
  CONTRACT_LIMITS,
  PROCESS_CONSUMER,
  PROCESS_EVIDENCE_SCHEMA,
  PROCESS_REQUEST_SCHEMA,
  canonicalizeJson,
  parseCanonicalProcessEvidenceBytes,
  sha256Hex,
  type ProcessRequest,
} from "../src/contract.ts";
import {
  executeTypeScriptFixtureBaseline,
  createOfflineFixtureProcessPort,
  type NativeProcessPort,
} from "../src/typescript-baseline.ts";
import {
  SidecarTerminalError,
  invokeRustSidecar,
  type RustSidecarAuthority,
} from "../src/rust-sidecar-adapter.ts";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("tracer: TypeScript baseline drives only the exact self-owned fixture without a shell", async () => {
  const targetRoot = process.env.CARGO_TARGET_DIR;
  assert.ok(targetRoot, "CARGO_TARGET_DIR must name the prebuilt offline Rust target");
  const runnerPath = canonicalWindowsPath(join(targetRoot, "debug", "rm0032-phase3-runner.exe"));
  const runnerSha256 = sha256Hex(await readFile(runnerPath));
  const root = canonicalWindowsPath(await mkdtemp(join(tmpdir(), "rm0032-ts-real-")));
  temporaryRoots.push(root);
  const request = makeRequest(root, runnerPath, runnerSha256, Buffer.from("typescript-real-tracer", "utf8"));
  const result = await executeTypeScriptFixtureBaseline(Buffer.from(canonicalizeJson(request), "utf8"), {
    allowedExecutablePath: runnerPath,
    allowedExecutableSha256: runnerSha256,
    allowedOperationRoot: root,
    processPort: createOfflineFixtureProcessPort(),
  });

  assert.equal(result.evidence.terminalState, "known-exit");
  assert.equal(Buffer.from(result.evidence.standardOutput.base64, "base64").toString("utf8"), "typescript-real-tracer");
  assert.equal(result.evidence.retryPerformed, false);
});

test("tracer: TypeScript baseline CLI persists evidence before its small ack", async () => {
  const scenario = await makeRustScenario("typescript-cli", ["fixture", "echo"], Buffer.from("typescript-cli-tracer"));
  const baselineScript = new URL("../src/typescript-baseline.ts", import.meta.url);
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      baselineScript.pathname.replace(/^\/(?:[A-Za-z]:)/u, (match) => match.slice(1)),
      "cli-fixture",
      scenario.requestPath,
      scenario.authority.runnerPath,
      scenario.authority.runnerSha256,
      scenario.request.containment.operationRoot,
    ],
    { cwd: scenario.request.containment.operationRoot, env: {}, windowsHide: true, timeout: 30_000 },
  );
  assert.equal(stderr, "");
  const ack = JSON.parse(stdout);
  const evidenceBytes = await readFile(scenario.request.evidence.path);
  assert.equal(ack.schema, "decadans.rm0032.typescript-baseline-ack.v1");
  assert.equal(ack.evidenceSha256, sha256Hex(evidenceBytes));
  assert.equal(parseCanonicalProcessEvidenceBytes(evidenceBytes).processStartCount, 1);
});

test("tracer: TypeScript policy writes durable evidence before returning a synthetic decision", async () => {
  const root = canonicalWindowsPath(await mkdtemp(join(tmpdir(), "rm0032-ts-baseline-")));
  temporaryRoots.push(root);
  const executablePath = canonicalWindowsPath(process.execPath);
  const executableSha256 = sha256Hex(await readFile(executablePath));
  const stdinBytes = Buffer.from("offline-tracer", "utf8");
  const request = makeRequest(root, executablePath, executableSha256, stdinBytes);
  const requestBytes = Buffer.from(canonicalizeJson(request), "utf8");
  let starts = 0;
  const port: NativeProcessPort = {
    async start(specification) {
      starts += 1;
      assert.equal(specification.executablePath, executablePath);
      return {
        startedUtc: "2026-08-27T00:00:00.000Z",
        finishedUtc: "2026-08-27T00:00:00.010Z",
        processStartCount: 1,
        terminalState: "known-exit",
        exitCodeKnown: true,
        exitCode: 0,
        standardOutput: Buffer.from(specification.stdinBytes),
        standardError: Buffer.alloc(0),
        standardOutputComplete: true,
        standardErrorComplete: true,
        standardOutputTruncated: false,
        standardErrorTruncated: false,
      };
    },
  };

  const result = await executeTypeScriptFixtureBaseline(requestBytes, {
    allowedExecutablePath: executablePath,
    allowedExecutableSha256: executableSha256,
    allowedOperationRoot: root,
    processPort: port,
  });

  assert.equal(starts, 1);
  assert.equal(result.evidencePersisted, true);
  assert.equal(result.evidence.processStartCount, 1);
  assert.equal(result.evidence.retryPerformed, false);
  const persisted = await readFile(request.evidence.path);
  assert.equal(sha256Hex(persisted), result.evidenceSha256);
  assert.deepEqual(parseCanonicalProcessEvidenceBytes(persisted), result.evidence);
});

test("tracer: Rust adapter reads durable raw evidence before accepting the sidecar ack", async () => {
  const targetRoot = process.env.CARGO_TARGET_DIR;
  assert.ok(targetRoot, "CARGO_TARGET_DIR must name the prebuilt offline Rust target");
  const runnerPath = canonicalWindowsPath(join(targetRoot, "debug", "rm0032-phase3-runner.exe"));
  const runnerSha256 = sha256Hex(await readFile(runnerPath));
  const root = canonicalWindowsPath(await mkdtemp(join(tmpdir(), "rm0032-rust-adapter-")));
  temporaryRoots.push(root);
  const request = makeRequest(root, runnerPath, runnerSha256, Buffer.from("adapter-tracer", "utf8"));
  const requestBytes = Buffer.from(canonicalizeJson(request), "utf8");
  const requestPath = win32.join(root, "request.json");
  await writeFile(requestPath, requestBytes, { flag: "wx" });

  const result = await invokeRustSidecar(requestBytes, {
    runnerPath,
    runnerSha256,
    requestPath,
    sidecarDeadlineMs: 30_000,
  });

  assert.equal(result.sidecarProcessStartCount, 1);
  assert.equal(result.evidenceRecoveredBeforeAckParse, true);
  assert.equal(result.evidence.processStartCount, 1);
  assert.equal(result.evidence.terminalState, "known-exit");
  assert.equal(Buffer.from(result.evidence.standardOutput.base64, "base64").toString("utf8"), "adapter-tracer");
  assert.ok(result.runnerPeakWorkingSetBytes > 0);
  assert.equal("runnerWorkingSetBytes" in result, false);
  assert.equal(result.evidence.retryPerformed, false);
});

test("tracer: outer adapter termination uncertainty is finite, one-shot, and releases admission", async () => {
  const scenario = await makeRustScenario("adapter-close-uncertainty", ["fixture", "sleep", "5000"], Buffer.alloc(0));
  scenario.authority.sidecarDeadlineMs = 1_000;
  const startedAt = Date.now();
  await assert.rejects(
    invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "adapter-close-uncertainty" as NonNullable<RustSidecarAuthority["testFault"]>,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SidecarTerminalError);
      assert.equal(error.code, "sidecar-termination-unknown");
      assert.deepEqual(error.termination, {
        trigger: "aggregate-deadline",
        processStartCount: 1,
        killRequestCount: 1,
        killResultKnown: true,
        killResult: true,
        closeObserved: false,
        fixtureSafetyCloseObserved: false,
        terminalState: "unknown",
        outputComplete: false,
        retryAuthorized: false,
      });
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 3_000, "outer close uncertainty must settle within the fixed grace");
  assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
  assert.equal(await pathExists(scenario.request.evidence.path), false);

  await delay(500);
  const next = await makeRustScenario("adapter-slot-released", ["fixture", "echo"], Buffer.from("slot-released"));
  const nextResult = await invokeRustSidecar(next.requestBytes, next.authority);
  assert.equal(nextResult.evidence.terminalState, "known-exit");
  assert.equal(Buffer.from(nextResult.evidence.standardOutput.base64, "base64").toString("utf8"), "slot-released");
  assert.equal(nextResult.evidence.retryPerformed, false);

  const hostile = await makeRustScenario("adapter-fault-hostile", ["fixture", "echo"], Buffer.alloc(0));
  hostile.request.argv = ["not-fixture", "echo"];
  await rewriteScenarioRequest(hostile);
  await assert.rejects(
    invokeRustSidecar(hostile.requestBytes, {
      ...hostile.authority,
      testFault: "adapter-close-uncertainty" as NonNullable<RustSidecarAuthority["testFault"]>,
    }),
    (error: unknown) =>
      error instanceof SidecarTerminalError &&
      error.code === "test-fault-live-authority-refused" &&
      error.retryAuthorized === false,
  );
  assert.equal(await pathExists(hostile.request.attemptMarker.path), false);
  assert.equal(await pathExists(hostile.request.evidence.path), false);
});

test("outer adapter kill-result uncertainty is honest, bounded, and releases admission", async () => {
  const scenario = await makeRustScenario("adapter-kill-result-uncertainty", ["fixture", "sleep", "5000"], Buffer.alloc(0));
  scenario.authority.sidecarDeadlineMs = 1_000;
  const startedAt = Date.now();
  await assert.rejects(
    invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "adapter-kill-result-uncertainty" as NonNullable<RustSidecarAuthority["testFault"]>,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SidecarTerminalError);
      assert.equal(error.code, "sidecar-termination-unknown");
      assert.deepEqual(error.termination, {
        trigger: "aggregate-deadline",
        processStartCount: 1,
        killRequestCount: 1,
        killResultKnown: false,
        killResult: null,
        closeObserved: false,
        fixtureSafetyCloseObserved: false,
        terminalState: "unknown",
        outputComplete: false,
        retryAuthorized: false,
      });
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 3_000, "kill-result uncertainty must settle within the bounded close grace");
  assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
  assert.equal(await pathExists(scenario.request.evidence.path), false);

  await delay(500);
  const next = await makeRustScenario("adapter-kill-result-slot-released", ["fixture", "echo"]);
  const nextResult = await invokeRustSidecar(next.requestBytes, next.authority);
  assert.equal(nextResult.evidence.terminalState, "known-exit");
  assert.equal(nextResult.evidence.retryPerformed, false);
});

test("outer adapter stdout-cap termination is finite and releases admission", async () => {
  const scenario = await makeRustScenario("adapter-stdout-cap", ["fixture", "echo"], Buffer.alloc(0));
  await assert.rejects(
    invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "adapter-stdout-close-uncertainty" as NonNullable<RustSidecarAuthority["testFault"]>,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SidecarTerminalError);
      assert.equal(error.code, "sidecar-termination-unknown");
      assert.equal(error.termination?.trigger, "stdout-cap");
      assert.equal(error.termination?.processStartCount, 1);
      assert.equal(error.termination?.killRequestCount, 1);
      assert.equal(error.termination?.killResultKnown, true);
      assert.equal(typeof error.termination?.killResult, "boolean");
      assert.equal(error.termination?.closeObserved, false);
      assert.equal(error.termination?.fixtureSafetyCloseObserved, true);
      assert.equal(error.termination?.outputComplete, false);
      assert.equal(error.retryAuthorized, false);
      return true;
    },
  );
  assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
  assert.equal(await pathExists(scenario.request.evidence.path), false);

  const next = await makeRustScenario("adapter-stdout-slot-released", ["fixture", "echo"]);
  const result = await invokeRustSidecar(next.requestBytes, next.authority);
  assert.equal(result.evidence.terminalState, "known-exit");
  assert.equal(result.evidence.retryPerformed, false);
});

test("outer adapter stderr-cap termination is finite and releases admission", async () => {
  const scenario = await makeRustScenario("adapter-stderr-cap", ["fixture", "echo"], Buffer.alloc(0));
  await assert.rejects(
    invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "adapter-stderr-close-uncertainty" as NonNullable<RustSidecarAuthority["testFault"]>,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SidecarTerminalError);
      assert.equal(error.code, "sidecar-termination-unknown");
      assert.equal(error.termination?.trigger, "stderr-cap");
      assert.equal(error.termination?.processStartCount, 1);
      assert.equal(error.termination?.killRequestCount, 1);
      assert.equal(error.termination?.killResultKnown, true);
      assert.equal(typeof error.termination?.killResult, "boolean");
      assert.equal(error.termination?.closeObserved, false);
      assert.equal(error.termination?.fixtureSafetyCloseObserved, true);
      assert.equal(error.termination?.outputComplete, false);
      assert.equal(error.retryAuthorized, false);
      return true;
    },
  );
  assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
  assert.equal(await pathExists(scenario.request.evidence.path), false);

  const next = await makeRustScenario("adapter-stderr-slot-released", ["fixture", "echo"]);
  const result = await invokeRustSidecar(next.requestBytes, next.authority);
  assert.equal(result.evidence.terminalState, "known-exit");
  assert.equal(result.evidence.retryPerformed, false);
});

test("termination-generation: kill true returns terminal unknown at 250ms and only matching close releases", async () => {
  await assertTerminationGenerationScenario("adapter-generation-kill-true", true, true);
  await assertCloseBeforeSettlementKeepsAdmissionHeld();
});

test("termination-generation: kill false returns terminal unknown at 250ms and only matching close releases", async () => {
  await assertTerminationGenerationScenario("adapter-generation-kill-false", true, false);
});

test("termination-generation: kill throw is contained, returns terminal unknown at 250ms and only matching close releases", async () => {
  await assertTerminationGenerationScenario("adapter-generation-kill-throw", false, null);
});

test("termination-generation: stale duplicate and non-close evidence cannot release reused PID or rewrite terminal unknown", async () => {
  const first = await makeAdapterTerminationScenario("adapter-generation-stale-a");
  const firstError = await captureTerminalUnknown(first, "adapter-generation-stale-evidence");
  const firstSnapshot = snapshotTermination(firstError);

  const refusedBeforeMatchingClose = await makeAdapterTerminationScenario("adapter-generation-stale-refused");
  await assertAdmissionHeld(refusedBeforeMatchingClose);

  await delay(175);
  const second = await makeAdapterTerminationScenario("adapter-generation-stale-b");
  const secondError = await captureTerminalUnknown(second, "adapter-generation-stale-evidence");
  const secondSnapshot = snapshotTermination(secondError);

  assert.deepEqual(snapshotTermination(firstError), firstSnapshot);
  assert.deepEqual(snapshotTermination(secondError), secondSnapshot);
  assert.equal(Object.isFrozen(firstError), true);
  assert.equal(Object.isFrozen(firstError.termination), true);
  assert.equal(Object.isFrozen(secondError), true);
  assert.equal(Object.isFrozen(secondError.termination), true);

  const staleCannotReleaseSuccessor = await makeAdapterTerminationScenario("adapter-generation-stale-successor-refused");
  await assertAdmissionHeld(staleCannotReleaseSuccessor);

  await delay(250);
  const released = await makeAdapterTerminationScenario("adapter-generation-stale-released");
  await assertAdmissionReleased(released);
});

test("Rust boundary fault ladder is terminal, evidence-first, and never retries", async (context) => {
  await context.test("preexisting marker refuses before child or evidence creation", async () => {
    const scenario = await makeRustScenario("marker-exists", ["fixture", "echo"]);
    await writeFile(scenario.request.attemptMarker.path, "historical-marker", { flag: "wx" });
    await assert.rejects(invokeRustSidecar(scenario.requestBytes, scenario.authority));
    assert.equal(await readFile(scenario.request.attemptMarker.path, "utf8"), "historical-marker");
    assert.equal(await pathExists(scenario.request.evidence.path), false);
  });

  await context.test("preexisting evidence refuses before marker creation", async () => {
    const scenario = await makeRustScenario("evidence-exists", ["fixture", "echo"]);
    await writeFile(scenario.request.evidence.path, "historical-evidence", { flag: "wx" });
    await assert.rejects(invokeRustSidecar(scenario.requestBytes, scenario.authority));
    assert.equal(await readFile(scenario.request.evidence.path, "utf8"), "historical-evidence");
    assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
  });

  await context.test("child executable hash drift refuses before marker", async () => {
    const scenario = await makeRustScenario("child-hash-drift", ["fixture", "echo"]);
    scenario.request.executable.sha256 = "b".repeat(64);
    await rewriteScenarioRequest(scenario);
    await assert.rejects(invokeRustSidecar(scenario.requestBytes, scenario.authority));
    assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
    assert.equal(await pathExists(scenario.request.evidence.path), false);
  });

  await context.test("request-file byte swap refuses before sidecar start", async () => {
    const scenario = await makeRustScenario("request-swap", ["fixture", "echo"]);
    await writeFile(scenario.requestPath, Buffer.from(`${scenario.requestBytes.toString("utf8")}\n`, "utf8"), { flag: "w" });
    await assert.rejects(
      invokeRustSidecar(scenario.requestBytes, scenario.authority),
      (error: unknown) => error instanceof SidecarTerminalError && error.evidenceRecovered === false,
    );
    assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
  });

  await context.test("known nonzero exit preserves stderr bytes", async () => {
    const scenario = await makeRustScenario("nonzero", ["fixture", "nonzero"]);
    const result = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    assert.equal(result.evidence.terminalState, "known-exit");
    assert.equal(result.evidence.exitCodeKnown, true);
    assert.notEqual(result.evidence.exitCode, 0);
    assert.ok(result.evidence.standardError.bytes > 0);
  });

  await context.test("successful stderr is captured without changing exit truth", async () => {
    const scenario = await makeRustScenario("stderr", ["fixture", "stderr"]);
    const result = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    assert.equal(result.evidence.exitCode, 0);
    assert.equal(Buffer.from(result.evidence.standardError.base64, "base64").toString("utf8"), "synthetic-stderr");
  });

  await context.test("spawn refusal starts zero child processes", async () => {
    const scenario = await makeRustScenario("spawn-refusal", ["fixture", "echo"]);
    const result = await invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "spawn-refusal",
    });
    assert.equal(result.evidence.processStartCount, 0);
    assert.equal(result.evidence.terminalState, "spawn-refused");
    assert.equal(result.evidence.retryPerformed, false);
  });

  await context.test("resource-control refusal kills the one owned child and remains unknown", async () => {
    const scenario = await makeRustScenario("resource-refusal", ["fixture", "sleep", "5000"]);
    const result = await invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "resource-control-refusal",
    });
    assert.equal(result.evidence.processStartCount, 1);
    assert.equal(result.evidence.terminalState, "resource-control-refused");
    assert.equal(result.evidence.exitCodeKnown, false);
  });

  await context.test("unassigned suspended child kill uncertainty is terminal after fixture teardown", async () => {
    const scenario = await makeRustScenario("unassigned-kill-uncertainty", ["fixture", "echo"], Buffer.alloc(0));
    const result = await invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "unassigned-kill-uncertainty" as NonNullable<RustSidecarAuthority["testFault"]>,
    });
    assert.equal(result.evidence.processStartCount, 1);
    assert.equal(result.evidence.terminalState, "unknown");
    assert.equal(result.evidence.exitCodeKnown, false);
    assert.equal(result.evidence.exitCode, null);
    assert.equal(result.evidence.outputComplete, false);
    assert.equal(result.evidence.standardOutput.complete, false);
    assert.equal(result.evidence.standardError.complete, false);
    assert.match(
      Buffer.from(result.evidence.standardError.base64, "base64").toString("utf8"),
      /synthetic-unassigned-child-kill-result-unknown; fixture-safety-teardown-observed/u,
    );
    assert.equal(result.evidence.retryPerformed, false);
    assert.equal(result.evidence.cleanupPerformed, false);
    await assert.rejects(
      invokeRustSidecar(scenario.requestBytes, scenario.authority),
      (error: unknown) => error instanceof SidecarTerminalError && error.retryAuthorized === false,
    );
  });

  await context.test("unassigned suspended child wait uncertainty is terminal after fixture teardown", async () => {
    const scenario = await makeRustScenario("unassigned-wait-uncertainty", ["fixture", "echo"], Buffer.alloc(0));
    const result = await invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "unassigned-wait-uncertainty" as NonNullable<RustSidecarAuthority["testFault"]>,
    });
    assert.equal(result.evidence.processStartCount, 1);
    assert.equal(result.evidence.terminalState, "unknown");
    assert.equal(result.evidence.exitCodeKnown, false);
    assert.equal(result.evidence.exitCode, null);
    assert.equal(result.evidence.outputComplete, false);
    assert.equal(result.evidence.standardOutput.complete, false);
    assert.equal(result.evidence.standardError.complete, false);
    assert.match(
      Buffer.from(result.evidence.standardError.base64, "base64").toString("utf8"),
      /synthetic-unassigned-child-wait-result-unknown; fixture-safety-teardown-observed/u,
    );
    assert.equal(result.evidence.retryPerformed, false);
    assert.equal(result.evidence.cleanupPerformed, false);
    await assert.rejects(
      invokeRustSidecar(scenario.requestBytes, scenario.authority),
      (error: unknown) => error instanceof SidecarTerminalError && error.retryAuthorized === false,
    );
  });

  await context.test("job creation refusal is typed as a zero-start resource refusal", async () => {
    const scenario = await makeRustScenario("job-create-refusal", ["fixture", "echo"]);
    const result = await invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "job-create-refusal",
    });
    assert.equal(result.evidence.processStartCount, 0);
    assert.equal(result.evidence.terminalState, "resource-control-refused");
    assert.equal(result.evidence.exitCodeKnown, false);
  });

  await context.test("resource controls bind before the first child instruction", async () => {
    const rustSourcePath = new URL("../../../crates/rm0032-phase3-runner/src/main.rs", import.meta.url);
    const rustSource = await readFile(rustSourcePath, "utf8");
    const executeStart = rustSource.indexOf("fn execute_child(");
    const executeEnd = rustSource.indexOf("fn spawn_capture<", executeStart);
    assert.ok(executeStart >= 0 && executeEnd > executeStart);
    const executeBody = rustSource.slice(executeStart, executeEnd);
    const jobCreate = executeBody.indexOf("Job::create(");
    const spawn = executeBody.indexOf("command.spawn()");
    const assign = executeBody.indexOf("job.assign(");
    const resume = executeBody.indexOf("resume_suspended_primary_thread(");
    assert.match(executeBody, /CREATE_NO_WINDOW\s*\|\s*CREATE_SUSPENDED/u);
    assert.ok(jobCreate >= 0 && jobCreate < spawn && spawn < assign && assign < resume);
    assert.match(rustSource, /let _admission = SidecarAdmission::acquire\(\)\?;/u);
    assert.match(executeBody, /terminate_unassigned_suspended_child\(&mut child, started_utc, error, fault\)/u);
    assert.match(rustSource, /Ok\(counters\.PeakWorkingSetSize as u64\)/u);

    const scenario = await makeRustScenario("pre-resume-refusal", ["fixture", "echo"], Buffer.alloc(0));
    const sentinelPath = win32.join(scenario.request.containment.operationRoot, "child-executed.txt");
    scenario.request.argv = ["fixture", "write-sentinel", sentinelPath];
    await rewriteScenarioRequest(scenario);
    const result = await invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: "resume-refusal",
    });
    assert.equal(result.evidence.processStartCount, 1);
    assert.equal(result.evidence.terminalState, "resource-control-refused");
    assert.equal(result.evidence.exitCodeKnown, false);
    assert.equal(await pathExists(sentinelPath), false);
  });

  for (const fault of ["start-uncertainty", "wait-uncertainty"] as const) {
    await context.test(`${fault} preserves one start and terminal unknown`, async () => {
      const scenario = await makeRustScenario(fault, ["fixture", "sleep", "5000"], Buffer.alloc(0));
      const result = await invokeRustSidecar(scenario.requestBytes, { ...scenario.authority, testFault: fault });
      assert.equal(result.evidence.processStartCount, 1);
      assert.equal(result.evidence.terminalState, "unknown");
      assert.equal(result.evidence.exitCodeKnown, false);
      assert.equal(result.evidence.retryPerformed, false);
    });
  }

  await context.test("deadline kills the one owned child without replay", async () => {
    const scenario = await makeRustScenario("deadline", ["fixture", "sleep", "1500"], Buffer.alloc(0));
    scenario.request.limits.deadlineMs = 1000;
    await rewriteScenarioRequest(scenario);
    const result = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    assert.equal(result.evidence.terminalState, "deadline-killed");
    assert.equal(result.evidence.processStartCount, 1);
    assert.equal(result.evidence.retryPerformed, false);
  });

  await context.test("stdout at the exact cap completes", async () => {
    const scenario = await makeRustScenario("stdout-cap-exact", ["fixture", "flood-stdout", "1048576"], Buffer.alloc(0));
    const result = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    assert.equal(result.evidence.terminalState, "known-exit");
    assert.equal(result.evidence.standardOutput.bytes, 1_048_576);
    assert.equal(result.evidence.standardOutput.truncated, false);
  });

  await context.test("stdout above the cap is killed and truncated", async () => {
    const scenario = await makeRustScenario("stdout-cap-over", ["fixture", "flood-stdout", "1048577"], Buffer.alloc(0));
    const result = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    assert.equal(result.evidence.terminalState, "stdout-cap-killed");
    assert.equal(result.evidence.standardOutput.bytes, 1_048_576);
    assert.equal(result.evidence.standardOutput.truncated, true);
  });

  await context.test("stderr above the cap is killed and truncated", async () => {
    const scenario = await makeRustScenario("stderr-cap-over", ["fixture", "flood-stderr", "1048577"], Buffer.alloc(0));
    const result = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    assert.equal(result.evidence.terminalState, "stderr-cap-killed");
    assert.equal(result.evidence.standardError.bytes, 1_048_576);
    assert.equal(result.evidence.standardError.truncated, true);
  });

  await context.test("sensitive inherited environment is absent", async () => {
    const scenario = await makeRustScenario("environment", ["fixture", "environment"], Buffer.alloc(0));
    const result = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    assert.equal(Buffer.from(result.evidence.standardOutput.base64, "base64").toString("utf8"), "[]");
  });

  await context.test("raw non-UTF8 stdout remains exact Base64 evidence", async () => {
    const scenario = await makeRustScenario("binary", ["fixture", "binary"], Buffer.alloc(0));
    const result = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    assert.deepEqual(Buffer.from(result.evidence.standardOutput.base64, "base64"), Buffer.from([0x00, 0xff, 0xfe, 0x80]));
  });

  await context.test("marker flush failure starts no child and creates no evidence", async () => {
    const scenario = await makeRustScenario("marker-flush", ["fixture", "echo"]);
    await assert.rejects(
      invokeRustSidecar(scenario.requestBytes, { ...scenario.authority, testFault: "marker-flush-failure" }),
      (error: unknown) => error instanceof SidecarTerminalError && error.evidenceRecovered === false,
    );
    assert.equal(await pathExists(scenario.request.attemptMarker.path), true);
    assert.equal(await pathExists(scenario.request.evidence.path), false);
  });

  for (const fault of [
    "evidence-create-race",
    "evidence-write-failure",
    "evidence-flush-failure",
    "evidence-readback-failure",
  ] as const) {
    await context.test(`${fault} is terminal with no retry`, async () => {
      const scenario = await makeRustScenario(fault, ["fixture", "echo"]);
      await assert.rejects(
        invokeRustSidecar(scenario.requestBytes, { ...scenario.authority, testFault: fault }),
        (error: unknown) => error instanceof SidecarTerminalError && error.retryAuthorized === false,
      );
    });
  }

  for (const fault of ["truncated-evidence", "corrupt-ack", "swallow-ack"] as const) {
    await context.test(`${fault} is refused after durable evidence recovery`, async () => {
      const scenario = await makeRustScenario(fault, ["fixture", "echo"]);
      await assert.rejects(invokeRustSidecar(scenario.requestBytes, { ...scenario.authority, testFault: fault }));
      assert.equal(await pathExists(scenario.request.evidence.path), true);
    });
  }

  await context.test("a completed operation cannot be replayed", async () => {
    const scenario = await makeRustScenario("no-replay", ["fixture", "echo"]);
    const first = await invokeRustSidecar(scenario.requestBytes, scenario.authority);
    const markerBefore = sha256Hex(await readFile(scenario.request.attemptMarker.path));
    const evidenceBefore = sha256Hex(await readFile(scenario.request.evidence.path));
    await assert.rejects(
      invokeRustSidecar(scenario.requestBytes, scenario.authority),
      (error: unknown) => error instanceof SidecarTerminalError && error.retryAuthorized === false,
    );
    assert.equal(sha256Hex(await readFile(scenario.request.attemptMarker.path)), markerBefore);
    assert.equal(sha256Hex(await readFile(scenario.request.evidence.path)), evidenceBefore);
    assert.equal(first.evidence.processStartCount, 1);
    assert.equal(first.evidence.retryPerformed, false);
  });

  await context.test("concurrent same-operation attempts produce one inner start", async () => {
    const scenario = await makeRustScenario("marker-race", ["fixture", "sleep", "50"], Buffer.alloc(0));
    const outcomes = await Promise.allSettled([
      invokeRustSidecar(scenario.requestBytes, scenario.authority),
      invokeRustSidecar(scenario.requestBytes, scenario.authority),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const persisted = parseCanonicalProcessEvidenceBytes(await readFile(scenario.request.evidence.path));
    assert.equal(persisted.processStartCount, 1);
    assert.equal(persisted.retryPerformed, false);
  });

  await context.test("distinct operations share one adapter admission slot", async () => {
    const first = await makeRustScenario("distinct-concurrency-a", ["fixture", "sleep", "250"], Buffer.alloc(0));
    const second = await makeRustScenario("distinct-concurrency-b", ["fixture", "sleep", "250"], Buffer.alloc(0));
    const [firstOutcome, secondOutcome] = await Promise.allSettled([
      invokeRustSidecar(first.requestBytes, first.authority),
      invokeRustSidecar(second.requestBytes, second.authority),
    ]);
    assert.equal(firstOutcome.status, "fulfilled");
    assert.equal(secondOutcome.status, "rejected");
    assert.ok(
      secondOutcome.status === "rejected" &&
        secondOutcome.reason instanceof SidecarTerminalError &&
        secondOutcome.reason.code === "sidecar-concurrency-refused",
    );
    assert.equal(await pathExists(first.request.evidence.path), true);
    assert.equal(await pathExists(second.request.attemptMarker.path), false);
    assert.equal(await pathExists(second.request.evidence.path), false);
  });

  await context.test("distinct runner processes share one named admission mutex", async () => {
    const first = await makeRustScenario("cross-process-concurrency-a", ["fixture", "sleep", "250"], Buffer.alloc(0));
    const second = await makeRustScenario("cross-process-concurrency-b", ["fixture", "sleep", "250"], Buffer.alloc(0));
    const outcomes = await Promise.allSettled(
      [first, second].map(async (scenario) =>
        await execFileAsync(scenario.authority.runnerPath, ["run", scenario.requestPath], {
          cwd: scenario.request.containment.operationRoot,
          env: {},
          windowsHide: true,
          timeout: 30_000,
        }),
      ),
    );
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.match(String((rejected.reason as { stderr?: unknown }).stderr ?? ""), /sidecar-concurrency-refused/u);
    const evidenceCount = Number(await pathExists(first.request.evidence.path)) +
      Number(await pathExists(second.request.evidence.path));
    const markerCount = Number(await pathExists(first.request.attemptMarker.path)) +
      Number(await pathExists(second.request.attemptMarker.path));
    assert.equal(evidenceCount, 1);
    assert.equal(markerCount, 1);
  });
});

function makeRequest(
  root: string,
  executablePath: string,
  executableSha256: string,
  stdinBytes: Buffer,
): ProcessRequest {
  return {
    schema: PROCESS_REQUEST_SCHEMA,
    operationId: randomUUID().toUpperCase(),
    oneShot: true,
    retryAuthorized: false,
    executable: { path: executablePath, sha256: executableSha256 },
    argv: ["fixture", "echo"],
    stdin: {
      encoding: "base64",
      base64: stdinBytes.toString("base64"),
      bytes: stdinBytes.byteLength,
      sha256: createHash("sha256").update(stdinBytes).digest("hex"),
    },
    environment: { inherit: false, allowlist: [], values: {} },
    limits: {
      requestBytesMax: CONTRACT_LIMITS.requestBytesMax,
      stdinBytesMax: CONTRACT_LIMITS.stdinBytesMax,
      stdoutBytesMax: CONTRACT_LIMITS.stdoutBytesMax,
      stderrBytesMax: CONTRACT_LIMITS.stderrBytesMax,
      evidenceBytesMax: CONTRACT_LIMITS.evidenceBytesMax,
      concurrencyMax: 1,
      childProcessMax: 1,
      deadlineMs: 5_000,
      aggregateDeadlineMs: CONTRACT_LIMITS.aggregateDeadlineMs,
      memoryBytesMax: CONTRACT_LIMITS.memoryBytesMax,
      cpuPercentMax: CONTRACT_LIMITS.cpuPercentMax,
    },
    containment: { consumer: PROCESS_CONSUMER, operationRoot: root, requireCanonicalPaths: true },
    attemptMarker: { path: win32.join(root, "attempt.marker"), createNew: true },
    evidence: {
      path: win32.join(root, "evidence.json"),
      schema: PROCESS_EVIDENCE_SCHEMA,
      createNew: true,
    },
  };
}

function canonicalWindowsPath(value: string): string {
  const normalized = win32.normalize(value);
  return normalized.replace(/^[a-z]:/u, (drive) => drive.toUpperCase());
}

interface RustScenario {
  request: ProcessRequest;
  requestBytes: Buffer;
  requestPath: string;
  authority: {
    runnerPath: string;
    runnerSha256: string;
    requestPath: string;
    sidecarDeadlineMs: number;
  };
}

async function makeRustScenario(
  label: string,
  argv: string[],
  stdinBytes = Buffer.from(`fixture-${label}`, "utf8"),
): Promise<RustScenario> {
  const targetRoot = process.env.CARGO_TARGET_DIR;
  assert.ok(targetRoot, "CARGO_TARGET_DIR must name the prebuilt offline Rust target");
  const runnerPath = canonicalWindowsPath(join(targetRoot, "debug", "rm0032-phase3-runner.exe"));
  const runnerSha256 = sha256Hex(await readFile(runnerPath));
  const root = canonicalWindowsPath(await mkdtemp(join(tmpdir(), `rm0032-${label}-`)));
  temporaryRoots.push(root);
  const request = makeRequest(root, runnerPath, runnerSha256, stdinBytes);
  request.argv = argv;
  const requestPath = win32.join(root, "request.json");
  const scenario: RustScenario = {
    request,
    requestBytes: Buffer.alloc(0),
    requestPath,
    authority: { runnerPath, runnerSha256, requestPath, sidecarDeadlineMs: 30_000 },
  };
  await rewriteScenarioRequest(scenario);
  return scenario;
}

async function makeAdapterTerminationScenario(label: string): Promise<RustScenario> {
  const root = canonicalWindowsPath(await mkdtemp(join(tmpdir(), `rm0032-${label}-`)));
  temporaryRoots.push(root);
  const runnerPath = win32.join(root, "fixture-runner.exe");
  const runnerBytes = Buffer.from(`closed-adapter-termination-fixture:${label}`, "utf8");
  await writeFile(runnerPath, runnerBytes, { flag: "wx" });
  const runnerSha256 = sha256Hex(runnerBytes);
  const request = makeRequest(root, runnerPath, runnerSha256, Buffer.alloc(0));
  request.argv = ["fixture", "sleep", "5000"];
  const requestPath = win32.join(root, "request.json");
  const scenario: RustScenario = {
    request,
    requestBytes: Buffer.alloc(0),
    requestPath,
    authority: { runnerPath, runnerSha256, requestPath, sidecarDeadlineMs: 30_000 },
  };
  await rewriteScenarioRequest(scenario);
  return scenario;
}

async function rewriteScenarioRequest(scenario: RustScenario): Promise<void> {
  scenario.requestBytes = Buffer.from(canonicalizeJson(scenario.request), "utf8");
  await writeFile(scenario.requestPath, scenario.requestBytes, { flag: (await pathExists(scenario.requestPath)) ? "w" : "wx" });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertTerminationGenerationScenario(
  fault: "adapter-generation-kill-true" | "adapter-generation-kill-false" | "adapter-generation-kill-throw",
  killResultKnown: boolean,
  killResult: boolean | null,
): Promise<void> {
  const scenario = await makeAdapterTerminationScenario(fault);
  const error = await captureTerminalUnknown(scenario, fault);
  assert.equal(error.termination?.killResultKnown, killResultKnown);
  assert.equal(error.termination?.killResult, killResult);
  assert.equal(Object.isFrozen(error), true);
  assert.equal(Object.isFrozen(error.termination), true);

  const refused = await makeAdapterTerminationScenario(`${fault}-refused`);
  await assertAdmissionHeld(refused);

  await delay(225);
  const released = await makeAdapterTerminationScenario(`${fault}-released`);
  await assertAdmissionReleased(released);
}

async function assertCloseBeforeSettlementKeepsAdmissionHeld(): Promise<void> {
  const scenario = await makeAdapterTerminationScenario("adapter-generation-close-before-settlement");
  const startedAt = Date.now();
  const pending = invokeRustSidecar(scenario.requestBytes, {
    ...scenario.authority,
    testFault: "adapter-generation-close-before-settlement",
  });

  await delay(150);
  const refusedWhileOriginalPromisePending = await makeAdapterTerminationScenario(
    "adapter-generation-close-before-settlement-refused",
  );
  await assertAdmissionHeld(refusedWhileOriginalPromisePending);

  let captured: SidecarTerminalError | null = null;
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof SidecarTerminalError);
    captured = error;
    assert.equal(error.code, "sidecar-termination-unknown");
    assert.equal(error.termination?.killRequestCount, 1);
    assert.equal(error.termination?.killResultKnown, true);
    assert.equal(error.termination?.killResult, false);
    assert.equal(error.termination?.closeObserved, true);
    assert.equal(error.termination?.fixtureSafetyCloseObserved, true);
    assert.equal(error.termination?.terminalState, "unknown");
    assert.equal(error.termination?.outputComplete, false);
    assert.equal(error.termination?.retryAuthorized, false);
    return true;
  });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 225, `early matching close released terminal settlement too soon: ${elapsedMs}ms`);
  const settledError = captured as SidecarTerminalError | null;
  assert.ok(settledError);
  assert.equal(Object.isFrozen(settledError), true);
  assert.equal(Object.isFrozen(settledError.termination), true);

  const releasedAfterOriginalPromiseSettled = await makeAdapterTerminationScenario(
    "adapter-generation-close-before-settlement-released",
  );
  await assertAdmissionReleased(releasedAfterOriginalPromiseSettled);
}

async function captureTerminalUnknown(
  scenario: RustScenario,
  fault: RustSidecarAuthority["testFault"] | string,
): Promise<SidecarTerminalError> {
  const startedAt = Date.now();
  let captured: SidecarTerminalError | null = null;
  await assert.rejects(
    invokeRustSidecar(scenario.requestBytes, {
      ...scenario.authority,
      testFault: fault as NonNullable<RustSidecarAuthority["testFault"]>,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SidecarTerminalError);
      captured = error;
      assert.equal(error.code, "sidecar-termination-unknown");
      assert.equal(error.termination?.processStartCount, 1);
      assert.equal(error.termination?.killRequestCount, 1);
      assert.equal(error.termination?.closeObserved, false);
      assert.equal(error.termination?.fixtureSafetyCloseObserved, false);
      assert.equal(error.termination?.terminalState, "unknown");
      assert.equal(error.termination?.outputComplete, false);
      assert.equal(error.termination?.retryAuthorized, false);
      assert.equal(error.retryAuthorized, false);
      return true;
    },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 225, `terminal unknown returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 750, `terminal unknown returned too late: ${elapsedMs}ms`);
  assert.ok(captured);
  return captured;
}

function snapshotTermination(error: SidecarTerminalError): string {
  return JSON.stringify({ code: error.code, message: error.message, termination: error.termination });
}

function isConcurrencyRefusal(error: unknown): boolean {
  return error instanceof SidecarTerminalError &&
    error.code === "sidecar-concurrency-refused" &&
    error.retryAuthorized === false;
}

async function assertAdmissionHeld(scenario: RustScenario): Promise<void> {
  await assert.rejects(
    invokeRustSidecar(scenario.requestBytes, { ...scenario.authority, sidecarDeadlineMs: 999 }),
    isConcurrencyRefusal,
  );
  assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
  assert.equal(await pathExists(scenario.request.evidence.path), false);
}

async function assertAdmissionReleased(scenario: RustScenario): Promise<void> {
  await assert.rejects(
    invokeRustSidecar(scenario.requestBytes, { ...scenario.authority, sidecarDeadlineMs: 999 }),
    (error: unknown) =>
      error instanceof SidecarTerminalError &&
      error.code === "sidecar-deadline-refused" &&
      error.retryAuthorized === false,
  );
  assert.equal(await pathExists(scenario.request.attemptMarker.path), false);
  assert.equal(await pathExists(scenario.request.evidence.path), false);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
