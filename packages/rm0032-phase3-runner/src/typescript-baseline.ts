import { spawn } from "node:child_process";
import { open, lstat, readFile, realpath, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROCESS_EVIDENCE_SCHEMA,
  canonicalizeJson,
  parseCanonicalProcessEvidenceBytes,
  parseCanonicalProcessRequestBytes,
  sha256Hex,
  type ProcessEvidence,
} from "./contract.ts";

const ATTEMPT_MARKER_SCHEMA = "decadans.rm0032.attempt-marker.v1";
const BASELINE_ACK_SCHEMA = "decadans.rm0032.typescript-baseline-ack.v1";

export interface NativeProcessSpecification {
  executablePath: string;
  argv: readonly string[];
  stdinBytes: Uint8Array;
  environment: Readonly<Record<string, string>>;
  deadlineMs: number;
  stdoutBytesMax: number;
  stderrBytesMax: number;
  memoryBytesMax: number;
  cpuPercentMax: number;
  currentDirectory: string;
}

export interface NativeProcessOutcome {
  startedUtc: string;
  finishedUtc: string;
  processStartCount: 0 | 1;
  terminalState: string;
  exitCodeKnown: boolean;
  exitCode: number | null;
  standardOutput: Uint8Array;
  standardError: Uint8Array;
  standardOutputComplete: boolean;
  standardErrorComplete: boolean;
  standardOutputTruncated: boolean;
  standardErrorTruncated: boolean;
}

export interface NativeProcessPort {
  start(specification: NativeProcessSpecification): Promise<NativeProcessOutcome>;
}

export interface TypeScriptBaselineAuthority {
  allowedExecutablePath: string;
  allowedExecutableSha256: string;
  allowedOperationRoot: string;
  processPort: NativeProcessPort;
}

export interface TypeScriptBaselineResult {
  authority: "offline-fixture-only";
  requestSha256: string;
  markerPersisted: true;
  evidencePersisted: true;
  evidenceBytes: number;
  evidenceSha256: string;
  evidence: ProcessEvidence;
}

export function createOfflineFixtureProcessPort(): NativeProcessPort {
  return {
    async start(specification) {
      if (specification.argv[0] !== "fixture") {
        throw new Error("offline-port-authority-refused: only self-owned fixture argv is accepted");
      }
      return await new Promise((resolve, reject) => {
        const startedUtc = new Date().toISOString();
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let deadlineExceeded = false;
        let stdinFailed = false;
        let settled = false;
        const child = spawn(specification.executablePath, [...specification.argv], {
          cwd: specification.currentDirectory,
          env: { ...specification.environment },
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const deadline = setTimeout(() => {
          deadlineExceeded = true;
          child.kill();
        }, specification.deadlineMs);

        child.stdout.on("data", (chunk: Buffer) => {
          if (stdoutTruncated) return;
          const combined = Buffer.concat([stdout, chunk]);
          if (combined.byteLength > specification.stdoutBytesMax) {
            stdout = combined.subarray(0, specification.stdoutBytesMax);
            stdoutTruncated = true;
            child.kill();
          } else {
            stdout = combined;
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrTruncated) return;
          const combined = Buffer.concat([stderr, chunk]);
          if (combined.byteLength > specification.stderrBytesMax) {
            stderr = combined.subarray(0, specification.stderrBytesMax);
            stderrTruncated = true;
            child.kill();
          } else {
            stderr = combined;
          }
        });
        child.stdin.once("error", () => {
          stdinFailed = true;
        });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          reject(error);
        });
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          const terminalState = stdoutTruncated
            ? "stdout-cap-killed"
            : stderrTruncated
              ? "stderr-cap-killed"
              : deadlineExceeded
                ? "deadline-killed"
                : stdinFailed
                  ? "unknown"
                  : typeof code === "number"
                    ? "known-exit"
                    : "unknown";
          resolve({
            startedUtc,
            finishedUtc: new Date().toISOString(),
            processStartCount: 1,
            terminalState,
            exitCodeKnown: terminalState === "known-exit",
            exitCode: terminalState === "known-exit" ? code : null,
            standardOutput: stdout,
            standardError: stderr,
            standardOutputComplete: !stdoutTruncated,
            standardErrorComplete: !stderrTruncated,
            standardOutputTruncated: stdoutTruncated,
            standardErrorTruncated: stderrTruncated,
          });
        });
        child.stdin.end(Buffer.from(specification.stdinBytes));
      });
    },
  };
}

export async function executeTypeScriptFixtureBaseline(
  requestBytes: Uint8Array,
  authority: TypeScriptBaselineAuthority,
): Promise<TypeScriptBaselineResult> {
  const request = parseCanonicalProcessRequestBytes(requestBytes);
  const requestSha256 = sha256Hex(requestBytes);

  if (
    request.executable.path !== authority.allowedExecutablePath ||
    request.executable.sha256 !== authority.allowedExecutableSha256 ||
    request.containment.operationRoot !== authority.allowedOperationRoot
  ) {
    throw new Error("baseline-authority-mismatch: request path/hash/root differs from the explicit offline authority");
  }
  if (request.argv[0] !== "fixture") {
    throw new Error("baseline-live-authority-refused: TypeScript baseline accepts only the self-owned fixture mode");
  }

  await verifyRegularNonReparseFile(request.executable.path, request.executable.sha256);
  await verifyOperationPaths(
    request.containment.operationRoot,
    request.attemptMarker.path,
    request.evidence.path,
  );

  const markerBytes = Buffer.from(
    canonicalizeJson({
      createdUtc: new Date().toISOString(),
      operationId: request.operationId,
      requestSha256,
      schema: ATTEMPT_MARKER_SCHEMA,
    }),
    "utf8",
  );
  await createDurableFile(request.attemptMarker.path, markerBytes);

  let evidenceHandle: FileHandle | undefined;
  try {
    evidenceHandle = await open(request.evidence.path, "wx", 0o600);
    await evidenceHandle.sync();
  } catch (error) {
    await evidenceHandle?.close().catch(() => undefined);
    throw new Error(`evidence-create-new-failed: ${errorText(error)}`);
  }

  let outcome: NativeProcessOutcome;
  try {
    outcome = await authority.processPort.start({
      executablePath: request.executable.path,
      argv: request.argv,
      stdinBytes: Buffer.from(request.stdin.base64, "base64"),
      environment: request.environment.values,
      deadlineMs: request.limits.deadlineMs,
      stdoutBytesMax: request.limits.stdoutBytesMax,
      stderrBytesMax: request.limits.stderrBytesMax,
      memoryBytesMax: request.limits.memoryBytesMax,
      cpuPercentMax: request.limits.cpuPercentMax,
      currentDirectory: request.containment.operationRoot,
    });
  } catch (error) {
    const now = new Date().toISOString();
    outcome = {
      startedUtc: now,
      finishedUtc: now,
      processStartCount: 0,
      terminalState: "spawn-refused",
      exitCodeKnown: false,
      exitCode: null,
      standardOutput: Buffer.alloc(0),
      standardError: Buffer.from(errorText(error), "utf8"),
      standardOutputComplete: true,
      standardErrorComplete: true,
      standardOutputTruncated: false,
      standardErrorTruncated: false,
    };
  }

  const standardOutput = bindStream(
    outcome.standardOutput,
    outcome.standardOutputComplete,
    outcome.standardOutputTruncated,
    request.limits.stdoutBytesMax,
    "stdout",
  );
  const standardError = bindStream(
    outcome.standardError,
    outcome.standardErrorComplete,
    outcome.standardErrorTruncated,
    request.limits.stderrBytesMax,
    "stderr",
  );
  const evidence: ProcessEvidence = {
    schema: PROCESS_EVIDENCE_SCHEMA,
    requestBytes: requestBytes.byteLength,
    requestSha256,
    executableSha256Observed: request.executable.sha256,
    argv: [...request.argv],
    stdinBytes: request.stdin.bytes,
    stdinSha256: request.stdin.sha256,
    startedUtc: outcome.startedUtc,
    finishedUtc: outcome.finishedUtc,
    processStartCount: outcome.processStartCount,
    terminalState: outcome.terminalState,
    exitCodeKnown: outcome.exitCodeKnown,
    exitCode: outcome.exitCode,
    outputComplete: standardOutput.complete && standardError.complete,
    standardOutput,
    standardError,
    retryPerformed: false,
    cleanupPerformed: false,
  };

  const evidenceBytes = Buffer.from(canonicalizeJson(evidence), "utf8");
  if (evidenceBytes.byteLength > request.limits.evidenceBytesMax) {
    await evidenceHandle.close().catch(() => undefined);
    throw new Error("evidence-size-exceeded: canonical evidence exceeds its fixed v1 cap");
  }
  try {
    await evidenceHandle.truncate(0);
    await evidenceHandle.write(evidenceBytes, 0, evidenceBytes.byteLength, 0);
    await evidenceHandle.sync();
    const stat = await evidenceHandle.stat();
    if (stat.size !== evidenceBytes.byteLength) {
      throw new Error(`evidence-size-readback-mismatch: ${stat.size} != ${evidenceBytes.byteLength}`);
    }
  } catch (error) {
    throw new Error(`evidence-durable-write-failed: ${errorText(error)}`);
  } finally {
    await evidenceHandle.close().catch(() => undefined);
  }

  const persistedBytes = await readFile(request.evidence.path);
  const evidenceSha256 = sha256Hex(persistedBytes);
  if (!persistedBytes.equals(evidenceBytes)) {
    throw new Error("evidence-byte-readback-mismatch: durable evidence differs from the exact generated bytes");
  }
  const persistedEvidence = parseCanonicalProcessEvidenceBytes(persistedBytes);
  return {
    authority: "offline-fixture-only",
    requestSha256,
    markerPersisted: true,
    evidencePersisted: true,
    evidenceBytes: persistedBytes.byteLength,
    evidenceSha256,
    evidence: persistedEvidence,
  };
}

function bindStream(
  value: Uint8Array,
  complete: boolean,
  truncated: boolean,
  maximumBytes: number,
  label: string,
) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${label}-cap-contract-breached: process port returned ${bytes.byteLength} bytes`);
  }
  if (complete === truncated) {
    throw new Error(`${label}-completion-contract-breached: complete and truncated must be opposites`);
  }
  return {
    base64: bytes.toString("base64"),
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    complete,
    truncated,
  };
}

async function createDurableFile(path: string, bytes: Uint8Array): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.write(bytes, 0, bytes.byteLength, 0);
    await handle.sync();
    const stat = await handle.stat();
    if (stat.size !== bytes.byteLength) throw new Error(`durable-size-mismatch: ${stat.size} != ${bytes.byteLength}`);
  } catch (error) {
    throw new Error(`create-new-durable-file-failed: ${errorText(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyRegularNonReparseFile(path: string, expectedSha256: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("executable-shape-refused: executable must be a regular non-reparse file");
  }
  const resolved = canonicalWindowsPath(await realpath(path));
  if (resolved.toUpperCase() !== path.toUpperCase()) {
    throw new Error("executable-reparse-refused: executable resolved path differs from the planned path");
  }
  if (sha256Hex(await readFile(path)) !== expectedSha256) {
    throw new Error("executable-hash-refused: executable SHA-256 differs from the planned hash");
  }
}

async function verifyOperationPaths(root: string, markerPath: string, evidencePath: string): Promise<void> {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("operation-root-shape-refused: root must be a regular non-reparse directory");
  }
  const resolvedRoot = canonicalWindowsPath(await realpath(root));
  if (resolvedRoot.toUpperCase() !== root.toUpperCase()) {
    throw new Error("operation-root-reparse-refused: resolved root differs from the planned path");
  }
  for (const path of [markerPath, evidencePath]) {
    const relative = win32.relative(root, path);
    if (relative.length === 0 || relative.startsWith("..") || win32.isAbsolute(relative) || relative.includes("\\")) {
      throw new Error("operation-path-containment-refused: v1 marker and evidence must be direct root children");
    }
    try {
      await lstat(path);
      throw new Error("operation-path-exists-refused: CreateNew target already exists");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function canonicalWindowsPath(value: string): string {
  return win32.normalize(value).replace(/^[a-z]:/u, (drive) => drive.toUpperCase());
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

async function runOfflineFixtureCli(arguments_: string[]): Promise<void> {
  if (arguments_.length !== 5 || arguments_[0] !== "cli-fixture") {
    throw new Error("baseline-cli-argv-refused: expected exact cli-fixture arguments");
  }
  const [, requestPath, runnerPath, runnerSha256, operationRoot] = arguments_;
  const requestBytes = await readFile(requestPath);
  const result = await executeTypeScriptFixtureBaseline(requestBytes, {
    allowedExecutablePath: runnerPath,
    allowedExecutableSha256: runnerSha256,
    allowedOperationRoot: operationRoot,
    processPort: createOfflineFixtureProcessPort(),
  });
  const ack = canonicalizeJson({
    schema: BASELINE_ACK_SCHEMA,
    evidencePath: parseCanonicalProcessRequestBytes(requestBytes).evidence.path,
    evidenceBytes: result.evidenceBytes,
    evidenceSha256: result.evidenceSha256,
    processStartCount: result.evidence.processStartCount,
    terminalState: result.evidence.terminalState,
    exitCodeKnown: result.evidence.exitCodeKnown,
    exitCode: result.evidence.exitCode,
    outputComplete: result.evidence.outputComplete,
    retryPerformed: false,
    typescriptWorkingSetBytes: process.memoryUsage.rss(),
  });
  process.stdout.write(ack);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  return canonicalWindowsPath(fileURLToPath(import.meta.url)).toUpperCase() === canonicalWindowsPath(process.argv[1]).toUpperCase();
}

if (isDirectExecution()) {
  try {
    await runOfflineFixtureCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 64;
  }
}
