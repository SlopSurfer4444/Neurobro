import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, readFile, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";

import {
  CONTRACT_LIMITS,
  RUNNER_ACK_SCHEMA,
  assertExactKeys,
  canonicalizeJson,
  decodeStrictUtf8,
  parseCanonicalProcessEvidenceBytes,
  parseCanonicalProcessRequestBytes,
  sha256Hex,
  type ProcessEvidence,
} from "./contract.ts";

const SIDECAR_STREAM_CAP = 65_536;
const SIDECAR_CLOSE_GRACE_MS = 250;
const ACK_KEYS = [
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
  "runnerPeakWorkingSetBytes",
] as const;
let activeSidecarInvocation: SidecarInvocationLease | null = null;
let lastSidecarGeneration = 0;
let staleEvidenceFixtureOrdinal = 0;

export interface RustSidecarAuthority {
  runnerPath: string;
  runnerSha256: string;
  requestPath: string;
  sidecarDeadlineMs: number;
  testFault?:
    | "marker-flush-failure"
    | "evidence-create-race"
    | "evidence-write-failure"
    | "evidence-flush-failure"
    | "evidence-readback-failure"
    | "truncated-evidence"
    | "corrupt-ack"
    | "swallow-ack"
    | "spawn-refusal"
    | "job-create-refusal"
    | "resource-control-refusal"
    | "unassigned-kill-uncertainty"
    | "unassigned-wait-uncertainty"
    | "resume-refusal"
    | "start-uncertainty"
    | "wait-uncertainty"
    | "adapter-close-uncertainty"
    | "adapter-kill-result-uncertainty"
    | "adapter-stdout-close-uncertainty"
    | "adapter-stderr-close-uncertainty"
    | "adapter-generation-kill-true"
    | "adapter-generation-kill-false"
    | "adapter-generation-kill-throw"
    | "adapter-generation-close-before-settlement"
    | "adapter-generation-stale-evidence";
}

export interface SidecarTerminationObservation {
  trigger: "aggregate-deadline" | "stdout-cap" | "stderr-cap";
  processStartCount: 1;
  killRequestCount: 1;
  killResultKnown: boolean;
  killResult: boolean | null;
  closeObserved: boolean;
  fixtureSafetyCloseObserved: boolean;
  terminalState: "unknown";
  outputComplete: false;
  retryAuthorized: false;
}

export interface RustSidecarResult {
  adapter: "replaceable-rust-sidecar-v1";
  requestSha256: string;
  sidecarProcessStartCount: 1;
  sidecarExitCodeKnown: true;
  sidecarExitCode: 0;
  sidecarOutputComplete: true;
  sidecarStdoutBytes: number;
  sidecarStdoutSha256: string;
  sidecarStderrBytes: 0;
  sidecarStderrSha256: string;
  evidenceRecoveredBeforeAckParse: true;
  evidenceBytes: number;
  evidenceSha256: string;
  runnerPeakWorkingSetBytes: number;
  retryPerformed: false;
  evidence: ProcessEvidence;
}

interface SidecarRawResult {
  processStartCount: 1;
  exitCodeKnown: boolean;
  exitCode: number | null;
  outputComplete: boolean;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  deadlineExceeded: boolean;
}

interface RunnerAck {
  schema: string;
  evidencePath: string;
  evidenceBytes: number;
  evidenceSha256: string;
  processStartCount: number;
  terminalState: string;
  exitCodeKnown: boolean;
  exitCode: number | null;
  outputComplete: boolean;
  retryPerformed: boolean;
  runnerPeakWorkingSetBytes: number;
}

interface SidecarInvocationLease {
  generation: number | null;
  child: object | null;
  quarantineHeld: boolean;
  matchingCloseObserved: boolean;
  terminalUnknownReturned: boolean;
}

interface FixtureTerminationPlan {
  killDisposition: "true" | "false" | "throw";
  childSleepMs: number;
  duplicateCloseAfterMs: number | null;
}

interface SidecarChildDriver {
  childObject: object;
  stdoutOnData(listener: (chunk: Buffer) => void): void;
  stderrOnData(listener: (chunk: Buffer) => void): void;
  onceError(listener: (error: unknown) => void): void;
  onceClose(listener: (code: number | null) => void): void;
  kill(): boolean;
  destroyStreams(): void;
  unref(): void;
  emitFixtureNonCloseSignals(): void;
}

export class SidecarTerminalError extends Error {
  readonly code: string;
  readonly evidenceRecovered: boolean;
  readonly retryAuthorized = false;
  readonly termination: SidecarTerminationObservation | null;

  constructor(
    code: string,
    message: string,
    evidenceRecovered: boolean,
    termination: SidecarTerminationObservation | null = null,
  ) {
    super(`${code}: ${message}`);
    this.name = "SidecarTerminalError";
    this.code = code;
    this.evidenceRecovered = evidenceRecovered;
    this.termination = termination === null ? null : Object.freeze({ ...termination });
    Object.freeze(this);
  }
}

export async function invokeRustSidecar(
  requestBytes: Uint8Array,
  authority: RustSidecarAuthority,
): Promise<RustSidecarResult> {
  if (activeSidecarInvocation !== null) {
    throw new SidecarTerminalError(
      "sidecar-concurrency-refused",
      "the v1 adapter admits exactly one active sidecar request",
      false,
    );
  }
  const lease: SidecarInvocationLease = {
    generation: null,
    child: null,
    quarantineHeld: false,
    matchingCloseObserved: false,
    terminalUnknownReturned: false,
  };
  activeSidecarInvocation = lease;
  try {
    return await invokeRustSidecarExclusive(requestBytes, authority, lease);
  } finally {
    releaseSidecarInvocationIfSafe(lease);
  }
}

async function invokeRustSidecarExclusive(
  requestBytes: Uint8Array,
  authority: RustSidecarAuthority,
  lease: SidecarInvocationLease,
): Promise<RustSidecarResult> {
  const request = parseCanonicalProcessRequestBytes(requestBytes);
  if (authority.sidecarDeadlineMs < 1_000 || authority.sidecarDeadlineMs > CONTRACT_LIMITS.aggregateDeadlineMs) {
    throw new SidecarTerminalError("sidecar-deadline-refused", "deadline is outside the v1 aggregate bound", false);
  }
  await verifyExactRegularFile(authority.runnerPath, authority.runnerSha256, "runner");
  await verifyExactRegularFile(authority.requestPath, sha256Hex(requestBytes), "request");
  const persistedRequest = await readFile(authority.requestPath);
  if (!persistedRequest.equals(Buffer.from(requestBytes))) {
    throw new SidecarTerminalError("request-byte-readback-refused", "request file differs from the canonical input bytes", false);
  }

  if (
    authority.testFault &&
    (request.argv[0] !== "fixture" ||
      request.executable.path.toUpperCase() !== authority.runnerPath.toUpperCase() ||
      request.executable.sha256 !== authority.runnerSha256)
  ) {
    throw new SidecarTerminalError(
      "test-fault-live-authority-refused",
      "deterministic test faults require the exact self-owned fixture executable",
      false,
    );
  }

  const adapterCloseUncertainty =
    authority.testFault === "adapter-close-uncertainty" ||
    authority.testFault === "adapter-stdout-close-uncertainty" ||
    authority.testFault === "adapter-stderr-close-uncertainty";
  const adapterKillResultUncertainty = authority.testFault === "adapter-kill-result-uncertainty";
  const fixtureTerminationPlan = makeFixtureTerminationPlan(authority.testFault);
  const modeArguments =
    fixtureTerminationPlan !== null
    ? ["fixture", "sleep", String(fixtureTerminationPlan.childSleepMs)]
    : authority.testFault === "adapter-close-uncertainty" || adapterKillResultUncertainty
    ? ["fixture", "sleep", "5000"]
    : authority.testFault === "adapter-stdout-close-uncertainty"
    ? ["fixture", "flood-stdout", String(SIDECAR_STREAM_CAP + 1)]
    : authority.testFault === "adapter-stderr-close-uncertainty"
    ? ["fixture", "flood-stderr", String(SIDECAR_STREAM_CAP + 1)]
    : authority.testFault
    ? ["test-run", authority.testFault, authority.requestPath]
    : ["run", authority.requestPath];
  const raw = await invokeDirect(
    authority.runnerPath,
    modeArguments,
    authority.sidecarDeadlineMs,
    lease,
    adapterCloseUncertainty,
    adapterKillResultUncertainty,
    fixtureTerminationPlan,
  );

  let rawEvidence: Buffer;
  try {
    const evidenceMetadata = await lstat(request.evidence.path);
    if (!evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink()) {
      throw new Error("evidence is not a regular non-reparse file");
    }
    const resolvedEvidence = canonicalWindowsPath(await realpath(request.evidence.path));
    if (resolvedEvidence.toUpperCase() !== request.evidence.path.toUpperCase()) {
      throw new Error("evidence resolved path differs from the exact planned path");
    }
    if (evidenceMetadata.size > CONTRACT_LIMITS.evidenceBytesMax) {
      throw new Error("evidence exceeds the fixed v1 cap");
    }
    rawEvidence = await readFile(request.evidence.path);
  } catch (error) {
    throw new SidecarTerminalError(
      "durable-evidence-unavailable",
      `sidecar terminated without readable evidence: ${errorText(error)}; stdoutSha256=${sha256Hex(raw.stdout)}; stderrSha256=${sha256Hex(raw.stderr)}`,
      false,
    );
  }
  const evidenceRecoveredBeforeAckParse = true as const;
  const evidenceSha256 = sha256Hex(rawEvidence);

  if (
    !raw.exitCodeKnown ||
    raw.exitCode !== 0 ||
    !raw.outputComplete ||
    raw.deadlineExceeded ||
    raw.stdoutTruncated ||
    raw.stderrTruncated
  ) {
    throw new SidecarTerminalError(
      "sidecar-terminal-not-clear",
      `known=${raw.exitCodeKnown} exit=${String(raw.exitCode)} complete=${raw.outputComplete} deadline=${raw.deadlineExceeded}`,
      evidenceRecoveredBeforeAckParse,
    );
  }
  if (raw.stderr.byteLength !== 0) {
    throw new SidecarTerminalError(
      "sidecar-stderr-refused",
      `sidecar stderr must be empty; bytes=${raw.stderr.byteLength} sha256=${sha256Hex(raw.stderr)}`,
      evidenceRecoveredBeforeAckParse,
    );
  }

  let evidence: ProcessEvidence;
  try {
    evidence = parseCanonicalProcessEvidenceBytes(rawEvidence);
  } catch (error) {
    throw new SidecarTerminalError("durable-evidence-parse-refused", errorText(error), true);
  }
  bindEvidenceToRequest(evidence, requestBytes, request);
  const ack = parseCanonicalAck(raw.stdout);
  if (
    ack.evidencePath !== request.evidence.path ||
    ack.evidenceBytes !== rawEvidence.byteLength ||
    ack.evidenceSha256 !== evidenceSha256 ||
    ack.processStartCount !== evidence.processStartCount ||
    ack.terminalState !== evidence.terminalState ||
    ack.exitCodeKnown !== evidence.exitCodeKnown ||
    ack.exitCode !== evidence.exitCode ||
    ack.outputComplete !== evidence.outputComplete ||
    ack.retryPerformed !== false
  ) {
    throw new SidecarTerminalError("sidecar-ack-binding-refused", "ack differs from the durable evidence", true);
  }
  if (!Number.isSafeInteger(ack.runnerPeakWorkingSetBytes) || ack.runnerPeakWorkingSetBytes < 0) {
    throw new SidecarTerminalError("sidecar-working-set-refused", "ack working-set value is invalid", true);
  }

  return {
    adapter: "replaceable-rust-sidecar-v1",
    requestSha256: sha256Hex(requestBytes),
    sidecarProcessStartCount: 1,
    sidecarExitCodeKnown: true,
    sidecarExitCode: 0,
    sidecarOutputComplete: true,
    sidecarStdoutBytes: raw.stdout.byteLength,
    sidecarStdoutSha256: sha256Hex(raw.stdout),
    sidecarStderrBytes: 0,
    sidecarStderrSha256: sha256Hex(raw.stderr),
    evidenceRecoveredBeforeAckParse,
    evidenceBytes: rawEvidence.byteLength,
    evidenceSha256,
    runnerPeakWorkingSetBytes: ack.runnerPeakWorkingSetBytes,
    retryPerformed: false,
    evidence,
  };
}

async function invokeDirect(
  executable: string,
  argv: readonly string[],
  deadlineMs: number,
  lease: SidecarInvocationLease,
  suppressCloseObservationForFixture = false,
  suppressSuccessfulKillResultForFixture = false,
  fixtureTerminationPlan: FixtureTerminationPlan | null = null,
): Promise<SidecarRawResult> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let outputComplete = false;
    let deadlineExceeded = false;
    let terminationTrigger: SidecarTerminationObservation["trigger"] | null = null;
    let killRequestCount: 0 | 1 = 0;
    let killResultKnown = false;
    let killResult: boolean | null = null;
    let closeObserved = false;
    let fixtureSafetyCloseObserved = false;
    let closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
    allocateSidecarGeneration(lease);
    const child = createSidecarChildDriver(executable, argv, fixtureTerminationPlan);
    lease.child = child.childObject;
    const finishTermination = () => {
      if (settled || terminationTrigger === null) return;
      if (killRequestCount !== 1) {
        settled = true;
        clearTimeout(deadlineTimer);
        if (closeGraceTimer !== null) clearTimeout(closeGraceTimer);
        reject(new SidecarTerminalError(
          "sidecar-termination-invariant-failed",
          "outer termination settled without exactly one retained kill request",
          false,
        ));
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      if (closeGraceTimer !== null) clearTimeout(closeGraceTimer);
      child.destroyStreams();
      child.unref();
      const termination: SidecarTerminationObservation = {
        trigger: terminationTrigger,
        processStartCount: 1,
        killRequestCount,
        killResultKnown,
        killResult,
        closeObserved,
        fixtureSafetyCloseObserved,
        terminalState: "unknown",
        outputComplete: false,
        retryAuthorized: false,
      };
      lease.terminalUnknownReturned = true;
      reject(new SidecarTerminalError(
        "sidecar-termination-unknown",
        `trigger=${termination.trigger} killKnown=${termination.killResultKnown} kill=${String(termination.killResult)} close=${termination.closeObserved}`,
        false,
        termination,
      ));
    };
    const requestTermination = (trigger: SidecarTerminationObservation["trigger"]) => {
      if (settled || terminationTrigger !== null) return;
      terminationTrigger = trigger;
      lease.quarantineHeld = true;
      closeGraceTimer = setTimeout(() => {
        if (settled || terminationTrigger === null) return;
        killRequestCount = 1;
        try {
          const observedKillResult = child.kill();
          if (suppressSuccessfulKillResultForFixture && observedKillResult) {
            killResult = null;
            killResultKnown = false;
          } else {
            killResult = observedKillResult;
            killResultKnown = true;
          }
        } catch {
          killResult = null;
          killResultKnown = false;
        }
        finishTermination();
      }, SIDECAR_CLOSE_GRACE_MS);
    };
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      requestTermination("aggregate-deadline");
    }, deadlineMs);

    child.stdoutOnData((chunk: Buffer) => {
      if (stdoutTruncated) return;
      const combined = Buffer.concat([stdout, chunk]);
      if (combined.byteLength > SIDECAR_STREAM_CAP) {
        stdout = combined.subarray(0, SIDECAR_STREAM_CAP);
        stdoutTruncated = true;
        requestTermination("stdout-cap");
      } else {
        stdout = combined;
      }
    });
    child.stderrOnData((chunk: Buffer) => {
      if (stderrTruncated) return;
      const combined = Buffer.concat([stderr, chunk]);
      if (combined.byteLength > SIDECAR_STREAM_CAP) {
        stderr = combined.subarray(0, SIDECAR_STREAM_CAP);
        stderrTruncated = true;
        requestTermination("stderr-cap");
      } else {
        stderr = combined;
      }
    });
    child.onceError((error) => {
      if (settled) return;
      if (terminationTrigger !== null) return;
      settled = true;
      clearTimeout(deadlineTimer);
      reject(new SidecarTerminalError("sidecar-spawn-refused", errorText(error), false));
    });
    const onChildClose = (code: number | null) => {
      const matchingClose = observeMatchingChildClose(lease, child.childObject);
      if (!matchingClose) return;
      if (settled) return;
      if (terminationTrigger !== null) {
        fixtureSafetyCloseObserved = true;
        if (suppressCloseObservationForFixture) return;
        closeObserved = true;
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      outputComplete = !stdoutTruncated && !stderrTruncated;
      resolve({
        processStartCount: 1,
        exitCodeKnown: typeof code === "number",
        exitCode: typeof code === "number" ? code : null,
        outputComplete,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        deadlineExceeded,
      });
    };
    child.onceClose(onChildClose);
    if (fixtureTerminationPlan !== null) {
      setTimeout(() => requestTermination("aggregate-deadline"), 0);
      setTimeout(() => child.emitFixtureNonCloseSignals(), 50);
      if (fixtureTerminationPlan.duplicateCloseAfterMs !== null) {
        setTimeout(() => onChildClose(0), fixtureTerminationPlan.duplicateCloseAfterMs);
      }
    }
  });
}

function createSidecarChildDriver(
  executable: string,
  argv: readonly string[],
  fixtureTerminationPlan: FixtureTerminationPlan | null,
): SidecarChildDriver {
  if (fixtureTerminationPlan !== null) {
    const child = new EventEmitter();
    Object.defineProperty(child, "pid", { value: 4242, enumerable: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    setTimeout(() => child.emit("close", 0), fixtureTerminationPlan.childSleepMs);
    return {
      childObject: child,
      stdoutOnData: (listener) => { stdout.on("data", listener); },
      stderrOnData: (listener) => { stderr.on("data", listener); },
      onceError: (listener) => { child.once("error", listener); },
      onceClose: (listener) => { child.once("close", listener); },
      kill: () => {
        if (fixtureTerminationPlan.killDisposition === "throw") throw new Error("fixture-kill-throw");
        return fixtureTerminationPlan.killDisposition === "true";
      },
      destroyStreams: () => { stdout.destroy(); stderr.destroy(); },
      unref: () => undefined,
      emitFixtureNonCloseSignals: () => {
        child.emit("exit", null, "SIGTERM");
        stdout.emit("end");
        stderr.emit("end");
        stdout.emit("close");
        stderr.emit("close");
      },
    };
  }
  const child = spawn(executable, [...argv], {
    shell: false,
    windowsHide: true,
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    childObject: child,
    stdoutOnData: (listener) => { child.stdout.on("data", listener); },
    stderrOnData: (listener) => { child.stderr.on("data", listener); },
    onceError: (listener) => { child.once("error", listener); },
    onceClose: (listener) => { child.once("close", listener); },
    kill: () => child.kill(),
    destroyStreams: () => { child.stdout.destroy(); child.stderr.destroy(); },
    unref: () => child.unref(),
    emitFixtureNonCloseSignals: () => undefined,
  };
}

function allocateSidecarGeneration(lease: SidecarInvocationLease): void {
  if (activeSidecarInvocation !== lease || lease.child !== null || lease.generation !== null) {
    throw new SidecarTerminalError(
      "sidecar-generation-invariant-failed",
      "sidecar generation could not allocate before child creation",
      false,
    );
  }
  if (lastSidecarGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new SidecarTerminalError(
      "sidecar-generation-exhausted",
      "the monotonic sidecar generation space is exhausted and cannot be reused",
      false,
    );
  }
  lastSidecarGeneration += 1;
  lease.generation = lastSidecarGeneration;
}

function observeMatchingChildClose(lease: SidecarInvocationLease, child: object): boolean {
  const active = activeSidecarInvocation;
  if (
    active !== lease ||
    active.child !== child ||
    active.generation === null ||
    lease.generation !== active.generation ||
    lease.matchingCloseObserved
  ) {
    return false;
  }
  lease.matchingCloseObserved = true;
  if (lease.quarantineHeld && lease.terminalUnknownReturned) {
    activeSidecarInvocation = null;
  }
  return true;
}

function releaseSidecarInvocationIfSafe(lease: SidecarInvocationLease): void {
  if (activeSidecarInvocation !== lease) return;
  if (lease.quarantineHeld && !lease.matchingCloseObserved) return;
  activeSidecarInvocation = null;
}

function makeFixtureTerminationPlan(
  fault: RustSidecarAuthority["testFault"],
): FixtureTerminationPlan | null {
  if (fault === "adapter-generation-kill-true") {
    return { killDisposition: "true", childSleepMs: 400, duplicateCloseAfterMs: null };
  }
  if (fault === "adapter-generation-kill-false") {
    return { killDisposition: "false", childSleepMs: 400, duplicateCloseAfterMs: null };
  }
  if (fault === "adapter-generation-kill-throw") {
    return { killDisposition: "throw", childSleepMs: 400, duplicateCloseAfterMs: null };
  }
  if (fault === "adapter-generation-close-before-settlement") {
    return { killDisposition: "false", childSleepMs: 100, duplicateCloseAfterMs: null };
  }
  if (fault === "adapter-generation-stale-evidence") {
    staleEvidenceFixtureOrdinal += 1;
    return staleEvidenceFixtureOrdinal === 1
      ? { killDisposition: "false", childSleepMs: 340, duplicateCloseAfterMs: 500 }
      : { killDisposition: "false", childSleepMs: 450, duplicateCloseAfterMs: null };
  }
  return null;
}

function parseCanonicalAck(bytes: Uint8Array): RunnerAck {
  let text: string;
  try {
    text = decodeStrictUtf8(bytes, "$sidecarAck");
  } catch (error) {
    throw new SidecarTerminalError("sidecar-ack-utf8-refused", errorText(error), true);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SidecarTerminalError("sidecar-ack-json-refused", errorText(error), true);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SidecarTerminalError("sidecar-ack-shape-refused", "ack must be an object", true);
  }
  const record = value as Record<string, unknown>;
  try {
    assertExactKeys(record, ACK_KEYS, "$sidecarAck");
  } catch (error) {
    throw new SidecarTerminalError("sidecar-ack-property-set-refused", errorText(error), true);
  }
  if (text !== canonicalizeJson(record)) {
    throw new SidecarTerminalError("sidecar-ack-canonical-refused", "ack bytes are not canonical", true);
  }
  if (record.schema !== RUNNER_ACK_SCHEMA) {
    throw new SidecarTerminalError("sidecar-ack-version-refused", "ack schema differs from v1", true);
  }
  const evidencePath = requireAckString(record.evidencePath, "evidencePath");
  const evidenceBytes = requireAckInteger(record.evidenceBytes, "evidenceBytes", 0, CONTRACT_LIMITS.evidenceBytesMax);
  const evidenceSha256 = requireAckString(record.evidenceSha256, "evidenceSha256");
  if (!/^[0-9a-f]{64}$/u.test(evidenceSha256)) {
    throw new SidecarTerminalError("sidecar-ack-hash-refused", "evidenceSha256 has an invalid format", true);
  }
  const processStartCount = requireAckInteger(record.processStartCount, "processStartCount", 0, 1);
  const terminalState = requireAckString(record.terminalState, "terminalState");
  const exitCodeKnown = requireAckBoolean(record.exitCodeKnown, "exitCodeKnown");
  const exitCode = record.exitCode === null
    ? null
    : requireAckInteger(record.exitCode, "exitCode", -2_147_483_648, 2_147_483_647);
  const outputComplete = requireAckBoolean(record.outputComplete, "outputComplete");
  const retryPerformed = requireAckBoolean(record.retryPerformed, "retryPerformed");
  const runnerPeakWorkingSetBytes = requireAckInteger(
    record.runnerPeakWorkingSetBytes,
    "runnerPeakWorkingSetBytes",
    0,
    CONTRACT_LIMITS.memoryBytesMax,
  );
  return {
    schema: RUNNER_ACK_SCHEMA,
    evidencePath,
    evidenceBytes,
    evidenceSha256,
    processStartCount,
    terminalState,
    exitCodeKnown,
    exitCode,
    outputComplete,
    retryPerformed,
    runnerPeakWorkingSetBytes,
  };
}

function requireAckString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new SidecarTerminalError("sidecar-ack-type-refused", `${name} must be a string`, true);
  }
  return value;
}

function requireAckBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new SidecarTerminalError("sidecar-ack-type-refused", `${name} must be a boolean`, true);
  }
  return value;
}

function requireAckInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new SidecarTerminalError("sidecar-ack-type-refused", `${name} must be an in-range integer`, true);
  }
  return value as number;
}

function bindEvidenceToRequest(
  evidence: ProcessEvidence,
  requestBytes: Uint8Array,
  request: ReturnType<typeof parseCanonicalProcessRequestBytes>,
): void {
  if (
    evidence.requestBytes !== requestBytes.byteLength ||
    evidence.requestSha256 !== sha256Hex(requestBytes) ||
    evidence.executableSha256Observed !== request.executable.sha256 ||
    evidence.stdinBytes !== request.stdin.bytes ||
    evidence.stdinSha256 !== request.stdin.sha256 ||
    evidence.argv.length !== request.argv.length ||
    evidence.argv.some((argument, index) => argument !== request.argv[index]) ||
    evidence.retryPerformed !== false ||
    evidence.cleanupPerformed !== false
  ) {
    throw new SidecarTerminalError("evidence-request-binding-refused", "durable evidence differs from the request", true);
  }
}

async function verifyExactRegularFile(path: string, expectedSha256: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SidecarTerminalError(`${label}-shape-refused`, `${label} must be a regular non-reparse file`, false);
  }
  const resolved = canonicalWindowsPath(await realpath(path));
  if (resolved.toUpperCase() !== path.toUpperCase()) {
    throw new SidecarTerminalError(`${label}-reparse-refused`, `${label} resolved path differs`, false);
  }
  const bytes = await readFile(path);
  if (sha256Hex(bytes) !== expectedSha256) {
    throw new SidecarTerminalError(`${label}-hash-refused`, `${label} SHA-256 differs`, false);
  }
}

function canonicalWindowsPath(value: string): string {
  return win32.normalize(value).replace(/^\\\\\?\\/u, "").replace(/^[a-z]:/u, (drive) => drive.toUpperCase());
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}
