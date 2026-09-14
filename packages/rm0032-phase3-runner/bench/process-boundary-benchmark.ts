import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_LIMITS,
  PROCESS_CONSUMER,
  PROCESS_EVIDENCE_SCHEMA,
  PROCESS_REQUEST_SCHEMA,
  canonicalizeJson,
  parseCanonicalProcessEvidenceBytes,
  sha256Hex,
  type ProcessEvidence,
  type ProcessRequest,
} from "../src/contract.ts";
import { invokeRustSidecar } from "../src/rust-sidecar-adapter.ts";

const BENCHMARK_SCHEMA = "decadans.rm0032.process-boundary-benchmark.v1";
const WARMUP_COUNT = 50;
const TIMED_COUNT = 200;
const PAYLOAD_SIZES = [0, 4_096, 262_144] as const;
const RUST_WORKING_SET_MAX = 67_108_864;
const BASELINE_ACK_SCHEMA = "decadans.rm0032.typescript-baseline-ack.v1";
const BASELINE_ACK_KEYS = [
  "schema",
  "evidencePath",
  "evidenceBytes",
  "evidenceSha256",
  "processStartCount",
  "terminalState",
  "exitCodeKnown",
  "exitCode",
  "outputComplete",
  "retryPerformed",
  "typescriptWorkingSetBytes",
] as const;

interface SampleResult {
  durationMs: number;
  evidence: ProcessEvidence;
  rustPeakWorkingSetBytes?: number;
  typescriptWorkingSetBytes?: number;
}

interface BenchmarkContext {
  root: string;
  runnerPath: string;
  runnerSha256: string;
  nodePath: string;
  nodeSha256: string;
  baselineScriptPath: string;
  baselineScriptSha256: string;
  sequence: number;
}

async function main(): Promise<void> {
  const targetRoot = process.env.CARGO_TARGET_DIR;
  assert.ok(targetRoot, "CARGO_TARGET_DIR must name the prebuilt offline release target");
  const runnerPath = canonicalWindowsPath(
    join(targetRoot, "x86_64-pc-windows-msvc", "release", "rm0032-phase3-runner.exe"),
  );
  const runnerSha256 = sha256Hex(await readFile(runnerPath));
  const nodePath = canonicalWindowsPath(process.execPath);
  const nodeSha256 = sha256Hex(await readFile(nodePath));
  const baselineScriptPath = canonicalWindowsPath(
    fileURLToPath(new URL("../src/typescript-baseline.ts", import.meta.url)),
  );
  const baselineScriptSha256 = sha256Hex(await readFile(baselineScriptPath));
  const benchmarkRoot = canonicalWindowsPath(await mkdtemp(join(tmpdir(), "rm0032-boundary-benchmark-")));
  const context: BenchmarkContext = {
    root: benchmarkRoot,
    runnerPath,
    runnerSha256,
    nodePath,
    nodeSha256,
    baselineScriptPath,
    baselineScriptSha256,
    sequence: 0,
  };
  const payloadResults: unknown[] = [];
  let maximumRustPeakWorkingSetBytes = 0;
  let maximumTypeScriptWorkingSetBytes = 0;

  try {
    for (const payloadBytes of PAYLOAD_SIZES) {
      const expectedPayload = deterministicPayload(payloadBytes);
      const cleanStartPair = await runPair(context, payloadBytes, false);
      assertEvidenceParity(
        cleanStartPair.typescript.evidence,
        cleanStartPair.rust.evidence,
        expectedPayload,
      );
      maximumRustPeakWorkingSetBytes = Math.max(
        maximumRustPeakWorkingSetBytes,
        cleanStartPair.rust.rustPeakWorkingSetBytes ?? 0,
      );
      maximumTypeScriptWorkingSetBytes = Math.max(
        maximumTypeScriptWorkingSetBytes,
        cleanStartPair.typescript.typescriptWorkingSetBytes ?? 0,
      );
      for (let index = 0; index < WARMUP_COUNT; index += 1) {
        const pair = await runPair(context, payloadBytes, index % 2 === 1);
        assertEvidenceParity(pair.typescript.evidence, pair.rust.evidence, expectedPayload);
        maximumRustPeakWorkingSetBytes = Math.max(
          maximumRustPeakWorkingSetBytes,
          pair.rust.rustPeakWorkingSetBytes ?? 0,
        );
        maximumTypeScriptWorkingSetBytes = Math.max(
          maximumTypeScriptWorkingSetBytes,
          pair.typescript.typescriptWorkingSetBytes ?? 0,
        );
      }

      const typescriptDurations: number[] = [];
      const rustDurations: number[] = [];
      let byteParityCount = 0;
      let evidenceParityCount = 0;
      for (let index = 0; index < TIMED_COUNT; index += 1) {
        const pair = await runPair(context, payloadBytes, index % 2 === 1);
        typescriptDurations.push(pair.typescript.durationMs);
        rustDurations.push(pair.rust.durationMs);
        if (streamBytesEqual(pair.typescript.evidence, pair.rust.evidence)) byteParityCount += 1;
        assertEvidenceParity(pair.typescript.evidence, pair.rust.evidence, expectedPayload);
        evidenceParityCount += 1;
        maximumRustPeakWorkingSetBytes = Math.max(
          maximumRustPeakWorkingSetBytes,
          pair.rust.rustPeakWorkingSetBytes ?? 0,
        );
        maximumTypeScriptWorkingSetBytes = Math.max(
          maximumTypeScriptWorkingSetBytes,
          pair.typescript.typescriptWorkingSetBytes ?? 0,
        );
      }
      const typescriptP95 = percentile(typescriptDurations, 0.95);
      const rustP95 = percentile(rustDurations, 0.95);
      const overheadP95 = Math.max(0, rustP95 - typescriptP95);
      const overheadThresholdMs = payloadBytes === 262_144 ? 100 : 25;
      payloadResults.push({
        payloadBytes,
        cleanStart: {
          typescriptMicros: toMicros(cleanStartPair.typescript.durationMs),
          rustMicros: toMicros(cleanStartPair.rust.durationMs),
          byteAndEvidenceParity: true,
        },
        warmupCount: WARMUP_COUNT,
        timedCount: TIMED_COUNT,
        byteParityCount,
        evidenceParityCount,
        reliabilityPercent: 100,
        typescriptBaseline: summarize(typescriptDurations),
        rustBoundary: summarize(rustDurations),
        rustP95OverheadMicros: toMicros(overheadP95),
        overheadThresholdMs,
        overheadThresholdPassed: overheadP95 <= overheadThresholdMs,
      });
    }

    const faultParity = await runFaultParity(context);
    const performancePassed = payloadResults.every(
      (result: any) => result.overheadThresholdPassed === true && result.byteParityCount === TIMED_COUNT,
    );
    const result = {
      schema: BENCHMARK_SCHEMA,
      authority: "offline-synthetic-only",
      runnerSha256,
      nodeSha256,
      baselineScriptSha256,
      nodeVersion: process.version,
      payloads: payloadResults,
      faultParity,
      maximumRustPeakWorkingSetBytes,
      maximumTypeScriptWorkingSetBytes,
      rustPeakWorkingSetThresholdBytes: RUST_WORKING_SET_MAX,
      rustPeakWorkingSetThresholdPassed: maximumRustPeakWorkingSetBytes <= RUST_WORKING_SET_MAX,
      reliabilityPassed: true,
      performancePassed,
      liveProcessStartCount: 0,
      networkRequestCount: 0,
      retryCount: 0,
      overallPassed:
        performancePassed &&
        faultParity.every((entry) => entry.parityPassed) &&
        maximumRustPeakWorkingSetBytes <= RUST_WORKING_SET_MAX,
    };
    process.stdout.write(canonicalizeJson(result));
    if (!result.overallPassed) process.exitCode = 1;
  } finally {
    await rm(benchmarkRoot, { recursive: true, force: true });
  }
}

async function runPair(
  context: BenchmarkContext,
  payloadBytes: number,
  rustFirst: boolean,
): Promise<{ typescript: SampleResult; rust: SampleResult }> {
  if (rustFirst) {
    const rust = await runRust(context, Buffer.alloc(0), ["fixture", "payload", String(payloadBytes)], 5_000);
    const typescript = await runTypeScript(context, Buffer.alloc(0), ["fixture", "payload", String(payloadBytes)], 5_000);
    return { typescript, rust };
  }
  const typescript = await runTypeScript(context, Buffer.alloc(0), ["fixture", "payload", String(payloadBytes)], 5_000);
  const rust = await runRust(context, Buffer.alloc(0), ["fixture", "payload", String(payloadBytes)], 5_000);
  return { typescript, rust };
}

async function runTypeScript(
  context: BenchmarkContext,
  payload: Buffer,
  argv: string[],
  deadlineMs: number,
): Promise<SampleResult> {
  const operation = await makeOperation(context, "ts", payload, argv, deadlineMs);
  const started = performance.now();
  try {
    const result = await invokeTypeScriptBaselineCli(context, operation);
    return {
      durationMs: performance.now() - started,
      evidence: result.evidence,
      typescriptWorkingSetBytes: result.typescriptWorkingSetBytes,
    };
  } finally {
    await rm(operation.operationRoot, { recursive: true, force: true });
  }
}

async function runRust(
  context: BenchmarkContext,
  payload: Buffer,
  argv: string[],
  deadlineMs: number,
): Promise<SampleResult> {
  const operation = await makeOperation(context, "rust", payload, argv, deadlineMs);
  const started = performance.now();
  try {
    const result = await invokeRustSidecar(operation.requestBytes, {
      runnerPath: context.runnerPath,
      runnerSha256: context.runnerSha256,
      requestPath: operation.requestPath,
      sidecarDeadlineMs: 30_000,
    });
    return {
      durationMs: performance.now() - started,
      evidence: result.evidence,
      rustPeakWorkingSetBytes: result.runnerPeakWorkingSetBytes,
    };
  } finally {
    await rm(operation.operationRoot, { recursive: true, force: true });
  }
}

async function makeOperation(
  context: BenchmarkContext,
  implementation: "ts" | "rust",
  payload: Buffer,
  argv: string[],
  deadlineMs: number,
): Promise<{ operationRoot: string; requestPath: string; requestBytes: Buffer }> {
  context.sequence += 1;
  const operationRoot = canonicalWindowsPath(
    join(context.root, `${implementation}-${context.sequence.toString().padStart(6, "0")}`),
  );
  await mkdir(operationRoot);
  const request = makeRequest(context, operationRoot, payload, argv, deadlineMs);
  const requestBytes = Buffer.from(canonicalizeJson(request), "utf8");
  const requestPath = win32.join(operationRoot, "request.json");
  await writeFile(requestPath, requestBytes, { flag: "wx" });
  return { operationRoot, requestPath, requestBytes };
}

async function invokeTypeScriptBaselineCli(
  context: BenchmarkContext,
  operation: { operationRoot: string; requestPath: string; requestBytes: Buffer },
): Promise<{ evidence: ProcessEvidence; typescriptWorkingSetBytes: number }> {
  const raw = await new Promise<{ stdout: Buffer; stderr: Buffer; code: number | null }>((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const child = spawn(
      context.nodePath,
      [
        "--experimental-strip-types",
        context.baselineScriptPath,
        "cli-fixture",
        operation.requestPath,
        context.runnerPath,
        context.runnerSha256,
        operation.operationRoot,
      ],
      { cwd: operation.operationRoot, env: {}, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > 65_536) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.byteLength > 65_536) child.kill();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
  const request = JSON.parse(operation.requestBytes.toString("utf8"));
  const evidenceBytes = await readFile(request.evidence.path);
  const evidence = parseCanonicalProcessEvidenceBytes(evidenceBytes);
  assert.equal(raw.code, 0, raw.stderr.toString("utf8"));
  assert.equal(raw.stderr.byteLength, 0);
  const text = raw.stdout.toString("utf8");
  const ack = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(ack).sort(), [...BASELINE_ACK_KEYS].sort());
  assert.equal(text, canonicalizeJson(ack));
  assert.equal(ack.schema, BASELINE_ACK_SCHEMA);
  assert.equal(ack.evidencePath, request.evidence.path);
  assert.equal(ack.evidenceBytes, evidenceBytes.byteLength);
  assert.equal(ack.evidenceSha256, sha256Hex(evidenceBytes));
  assert.equal(ack.processStartCount, evidence.processStartCount);
  assert.equal(ack.terminalState, evidence.terminalState);
  assert.equal(ack.retryPerformed, false);
  assert.ok(Number.isSafeInteger(ack.typescriptWorkingSetBytes));
  return { evidence, typescriptWorkingSetBytes: ack.typescriptWorkingSetBytes as number };
}

function makeRequest(
  context: BenchmarkContext,
  operationRoot: string,
  payload: Buffer,
  argv: string[],
  deadlineMs: number,
): ProcessRequest {
  const identifier = context.sequence.toString(16).toUpperCase().padStart(12, "0").slice(-12);
  return {
    schema: PROCESS_REQUEST_SCHEMA,
    operationId: `00000000-0000-4000-8000-${identifier}`,
    oneShot: true,
    retryAuthorized: false,
    executable: { path: context.runnerPath, sha256: context.runnerSha256 },
    argv,
    stdin: {
      encoding: "base64",
      base64: payload.toString("base64"),
      bytes: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
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
      deadlineMs,
      aggregateDeadlineMs: CONTRACT_LIMITS.aggregateDeadlineMs,
      memoryBytesMax: CONTRACT_LIMITS.memoryBytesMax,
      cpuPercentMax: CONTRACT_LIMITS.cpuPercentMax,
    },
    containment: { consumer: PROCESS_CONSUMER, operationRoot, requireCanonicalPaths: true },
    attemptMarker: { path: win32.join(operationRoot, "attempt.marker"), createNew: true },
    evidence: {
      path: win32.join(operationRoot, "evidence.json"),
      schema: PROCESS_EVIDENCE_SCHEMA,
      createNew: true,
    },
  };
}

async function runFaultParity(context: BenchmarkContext) {
  const cases = [
    { name: "known-nonzero", argv: ["fixture", "nonzero"], deadlineMs: 5_000, expected: "known-exit" },
    { name: "stderr", argv: ["fixture", "stderr"], deadlineMs: 5_000, expected: "known-exit" },
    { name: "deadline", argv: ["fixture", "sleep", "1100"], deadlineMs: 1_000, expected: "deadline-killed" },
  ];
  const results = [];
  for (const fault of cases) {
    const payload = Buffer.alloc(0);
    const typescript = await runTypeScript(context, payload, fault.argv, fault.deadlineMs);
    const rust = await runRust(context, payload, fault.argv, fault.deadlineMs);
    const parityPassed =
      typescript.evidence.terminalState === fault.expected &&
      rust.evidence.terminalState === fault.expected &&
      evidenceClassificationEqual(typescript.evidence, rust.evidence);
    results.push({ name: fault.name, expected: fault.expected, parityPassed });
  }
  return results;
}

function assertEvidenceParity(typescript: ProcessEvidence, rust: ProcessEvidence, expectedPayload: Buffer): void {
  assert.equal(streamBytesEqual(typescript, rust), true);
  assert.equal(evidenceClassificationEqual(typescript, rust), true);
  assert.equal(typescript.standardOutput.bytes, expectedPayload.byteLength);
  assert.equal(typescript.standardOutput.sha256, sha256Hex(expectedPayload));
}

function streamBytesEqual(left: ProcessEvidence, right: ProcessEvidence): boolean {
  return (
    left.stdinBytes === right.stdinBytes &&
    left.stdinSha256 === right.stdinSha256 &&
    left.standardOutput.base64 === right.standardOutput.base64 &&
    left.standardOutput.sha256 === right.standardOutput.sha256 &&
    left.standardError.base64 === right.standardError.base64 &&
    left.standardError.sha256 === right.standardError.sha256
  );
}

function evidenceClassificationEqual(left: ProcessEvidence, right: ProcessEvidence): boolean {
  return (
    left.processStartCount === right.processStartCount &&
    left.terminalState === right.terminalState &&
    left.exitCodeKnown === right.exitCodeKnown &&
    left.exitCode === right.exitCode &&
    left.outputComplete === right.outputComplete &&
    left.retryPerformed === false &&
    right.retryPerformed === false &&
    left.cleanupPerformed === false &&
    right.cleanupPerformed === false
  );
}

function deterministicPayload(bytes: number): Buffer {
  const payload = Buffer.allocUnsafe(bytes);
  for (let index = 0; index < bytes; index += 1) payload[index] = (index * 31 + 17) % 251;
  return payload;
}

function summarize(values: number[]) {
  return {
    p50Micros: toMicros(percentile(values, 0.5)),
    p95Micros: toMicros(percentile(values, 0.95)),
    maximumMicros: toMicros(Math.max(...values)),
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function toMicros(valueMs: number): number {
  return Math.round(valueMs * 1_000);
}

function canonicalWindowsPath(value: string): string {
  return win32.normalize(value).replace(/^[a-z]:/u, (drive) => drive.toUpperCase());
}

await main();
