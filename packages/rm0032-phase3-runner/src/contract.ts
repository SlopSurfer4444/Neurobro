import { createHash } from "node:crypto";
import { win32 } from "node:path";

export const PROCESS_REQUEST_SCHEMA = "decadans.rm0032.process-request.v1" as const;
export const PROCESS_EVIDENCE_SCHEMA = "decadans.rm0032.process-evidence.v1" as const;
export const RUNNER_ACK_SCHEMA = "decadans.rm0032.runner-ack.v1" as const;
export const PROCESS_CONSUMER = "phase-3-wsl-hardening-coordinator" as const;

export const CONTRACT_LIMITS = Object.freeze({
  requestBytesMax: 65_536,
  stdinBytesMax: 262_144,
  stdoutBytesMax: 1_048_576,
  stderrBytesMax: 1_048_576,
  evidenceBytesMax: 3_145_728,
  concurrencyMax: 1,
  childProcessMax: 1,
  deadlineMsMin: 1_000,
  deadlineMsMax: 120_000,
  aggregateDeadlineMs: 420_000,
  memoryBytesMax: 268_435_456,
  cpuPercentMax: 25,
  argvCountMax: 64,
  argvElementBytesMax: 4_096,
});

const REQUEST_KEYS = [
  "schema",
  "operationId",
  "oneShot",
  "retryAuthorized",
  "executable",
  "argv",
  "stdin",
  "environment",
  "limits",
  "containment",
  "attemptMarker",
  "evidence",
] as const;

const EXECUTABLE_KEYS = ["path", "sha256"] as const;
const STDIN_KEYS = ["encoding", "base64", "bytes", "sha256"] as const;
const ENVIRONMENT_KEYS = ["inherit", "allowlist", "values"] as const;
const LIMIT_KEYS = [
  "requestBytesMax",
  "stdinBytesMax",
  "stdoutBytesMax",
  "stderrBytesMax",
  "evidenceBytesMax",
  "concurrencyMax",
  "childProcessMax",
  "deadlineMs",
  "aggregateDeadlineMs",
  "memoryBytesMax",
  "cpuPercentMax",
] as const;
const CONTAINMENT_KEYS = ["consumer", "operationRoot", "requireCanonicalPaths"] as const;
const MARKER_KEYS = ["path", "createNew"] as const;
const EVIDENCE_KEYS = ["path", "schema", "createNew"] as const;
const PROCESS_EVIDENCE_KEYS = [
  "schema",
  "requestBytes",
  "requestSha256",
  "executableSha256Observed",
  "argv",
  "stdinBytes",
  "stdinSha256",
  "startedUtc",
  "finishedUtc",
  "processStartCount",
  "terminalState",
  "exitCodeKnown",
  "exitCode",
  "outputComplete",
  "standardOutput",
  "standardError",
  "retryPerformed",
  "cleanupPerformed",
] as const;
const RAW_STREAM_KEYS = ["base64", "bytes", "sha256", "complete", "truncated"] as const;

const SAFE_ENVIRONMENT_NAMES = new Set(["LANG", "LC_ALL", "NO_COLOR", "RM0032_FIXTURE_MODE"]);
const SENSITIVE_ENVIRONMENT_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|SESSION|COOKIE|TELEGRAM|CREDENTIAL|AUTH)/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TERMINAL_STATES = new Set([
  "known-exit",
  "spawn-refused",
  "containment-refused",
  "resource-control-refused",
  "deadline-killed",
  "stdout-cap-killed",
  "stderr-cap-killed",
  "unknown",
]);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProcessRequest {
  schema: typeof PROCESS_REQUEST_SCHEMA;
  operationId: string;
  oneShot: true;
  retryAuthorized: false;
  executable: { path: string; sha256: string };
  argv: string[];
  stdin: { encoding: "base64"; base64: string; bytes: number; sha256: string };
  environment: { inherit: false; allowlist: string[]; values: Record<string, string> };
  limits: {
    requestBytesMax: number;
    stdinBytesMax: number;
    stdoutBytesMax: number;
    stderrBytesMax: number;
    evidenceBytesMax: number;
    concurrencyMax: 1;
    childProcessMax: 1;
    deadlineMs: number;
    aggregateDeadlineMs: number;
    memoryBytesMax: number;
    cpuPercentMax: number;
  };
  containment: {
    consumer: typeof PROCESS_CONSUMER;
    operationRoot: string;
    requireCanonicalPaths: true;
  };
  attemptMarker: { path: string; createNew: true };
  evidence: { path: string; schema: typeof PROCESS_EVIDENCE_SCHEMA; createNew: true };
}

export interface RawStreamEvidence {
  base64: string;
  bytes: number;
  sha256: string;
  complete: boolean;
  truncated: boolean;
}

export interface ProcessEvidence {
  schema: typeof PROCESS_EVIDENCE_SCHEMA;
  requestBytes: number;
  requestSha256: string;
  executableSha256Observed: string;
  argv: string[];
  stdinBytes: number;
  stdinSha256: string;
  startedUtc: string;
  finishedUtc: string;
  processStartCount: 0 | 1;
  terminalState: string;
  exitCodeKnown: boolean;
  exitCode: number | null;
  outputComplete: boolean;
  standardOutput: RawStreamEvidence;
  standardError: RawStreamEvidence;
  retryPerformed: false;
  cleanupPerformed: false;
}

export class ContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ContractError";
    this.code = code;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, "$", new Set<object>());
}

function canonicalize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new ContractError("non-canonical-number", `${path} must be a finite safe integer other than -0`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new ContractError("non-json-value", `${path} contains ${typeof value}`);
  }
  if (seen.has(value)) throw new ContractError("cyclic-json", `${path} is cyclic`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ContractError("non-plain-object", `${path} has a non-plain prototype`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function parseProcessRequest(input: unknown): ProcessRequest {
  const request = asRecord(input, "$request");
  assertExactKeys(request, REQUEST_KEYS, "$request");

  requireLiteral(request.schema, PROCESS_REQUEST_SCHEMA, "$request.schema");
  requireStringMatch(request.operationId, UUID_V4_PATTERN, "$request.operationId");
  requireLiteral(request.oneShot, true, "$request.oneShot");
  requireLiteral(request.retryAuthorized, false, "$request.retryAuthorized");

  const executable = asRecord(request.executable, "$request.executable");
  assertExactKeys(executable, EXECUTABLE_KEYS, "$request.executable");
  const executablePath = requireCanonicalWindowsPath(executable.path, "$request.executable.path");
  requireStringMatch(executable.sha256, SHA256_PATTERN, "$request.executable.sha256");

  if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.length > CONTRACT_LIMITS.argvCountMax) {
    throw new ContractError("invalid-argv", `$request.argv must contain 1..${CONTRACT_LIMITS.argvCountMax} literal elements`);
  }
  const argv = request.argv.map((entry, index) => {
    const value = requireString(entry, `$request.argv[${index}]`);
    if (Buffer.byteLength(value, "utf8") > CONTRACT_LIMITS.argvElementBytesMax || /[\u0000\r\n]/u.test(value)) {
      throw new ContractError("invalid-argv-element", `$request.argv[${index}] is unsafe or oversized`);
    }
    return value;
  });

  const stdin = asRecord(request.stdin, "$request.stdin");
  assertExactKeys(stdin, STDIN_KEYS, "$request.stdin");
  requireLiteral(stdin.encoding, "base64", "$request.stdin.encoding");
  const stdinBase64 = requireString(stdin.base64, "$request.stdin.base64");
  const stdinBytes = requireInteger(stdin.bytes, "$request.stdin.bytes", 0, CONTRACT_LIMITS.stdinBytesMax);
  requireStringMatch(stdin.sha256, SHA256_PATTERN, "$request.stdin.sha256");
  const decodedStdin = decodeStrictBase64(stdinBase64, "$request.stdin.base64");
  if (decodedStdin.byteLength !== stdinBytes || sha256Hex(decodedStdin) !== stdin.sha256) {
    throw new ContractError("stdin-binding-mismatch", "$request.stdin byte count or SHA-256 differs from decoded bytes");
  }

  const environment = asRecord(request.environment, "$request.environment");
  assertExactKeys(environment, ENVIRONMENT_KEYS, "$request.environment");
  requireLiteral(environment.inherit, false, "$request.environment.inherit");
  if (!Array.isArray(environment.allowlist)) {
    throw new ContractError("invalid-environment-allowlist", "$request.environment.allowlist must be an array");
  }
  const values = asRecord(environment.values, "$request.environment.values");
  const rawAllowlist = environment.allowlist;
  const windowsNames = ["SystemRoot", "WINDIR"];
  const windowsEnvironment = windowsNames.some((name) => rawAllowlist.includes(name) || Object.hasOwn(values, name));
  if (windowsEnvironment && (
    executablePath !== "C:\\Program Files\\WSL\\wsl.exe"
    || rawAllowlist.length !== windowsNames.length
    || rawAllowlist.some((name, index) => name !== windowsNames[index])
    || Object.keys(values).length !== windowsNames.length
    || windowsNames.some((name) => values[name] !== "C:\\Windows")
  )) {
    throw new ContractError("wsl-environment-binding-refused", "Windows environment requires the exact direct WSL target and trusted pair");
  }
  const allowlist = rawAllowlist.map((entry, index) => {
    const name = requireString(entry, `$request.environment.allowlist[${index}]`);
    if (!windowsEnvironment && (!SAFE_ENVIRONMENT_NAMES.has(name) || SENSITIVE_ENVIRONMENT_NAME.test(name))) {
      throw new ContractError("unsafe-environment-name", `${name} is not in the v1 environment allowlist`);
    }
    return name;
  });
  if (new Set(allowlist).size !== allowlist.length || [...allowlist].sort().some((value, index) => value !== allowlist[index])) {
    throw new ContractError("non-canonical-environment-allowlist", "$request.environment.allowlist must be sorted and unique");
  }
  assertExactKeys(values, allowlist, "$request.environment.values");
  for (const name of allowlist) {
    const value = requireString(values[name], `$request.environment.values.${name}`);
    if (Buffer.byteLength(value, "utf8") > 4_096 || /[\u0000\r\n]/u.test(value)) {
      throw new ContractError("unsafe-environment-value", `${name} is unsafe or oversized`);
    }
  }

  const limits = asRecord(request.limits, "$request.limits");
  assertExactKeys(limits, LIMIT_KEYS, "$request.limits");
  requireExactInteger(limits.requestBytesMax, CONTRACT_LIMITS.requestBytesMax, "$request.limits.requestBytesMax");
  requireExactInteger(limits.stdinBytesMax, CONTRACT_LIMITS.stdinBytesMax, "$request.limits.stdinBytesMax");
  requireExactInteger(limits.stdoutBytesMax, CONTRACT_LIMITS.stdoutBytesMax, "$request.limits.stdoutBytesMax");
  requireExactInteger(limits.stderrBytesMax, CONTRACT_LIMITS.stderrBytesMax, "$request.limits.stderrBytesMax");
  requireExactInteger(limits.evidenceBytesMax, CONTRACT_LIMITS.evidenceBytesMax, "$request.limits.evidenceBytesMax");
  requireExactInteger(limits.concurrencyMax, CONTRACT_LIMITS.concurrencyMax, "$request.limits.concurrencyMax");
  requireExactInteger(limits.childProcessMax, CONTRACT_LIMITS.childProcessMax, "$request.limits.childProcessMax");
  const deadlineMs = requireInteger(
    limits.deadlineMs,
    "$request.limits.deadlineMs",
    CONTRACT_LIMITS.deadlineMsMin,
    CONTRACT_LIMITS.deadlineMsMax,
  );
  requireExactInteger(limits.aggregateDeadlineMs, CONTRACT_LIMITS.aggregateDeadlineMs, "$request.limits.aggregateDeadlineMs");
  requireExactInteger(limits.memoryBytesMax, CONTRACT_LIMITS.memoryBytesMax, "$request.limits.memoryBytesMax");
  requireExactInteger(limits.cpuPercentMax, CONTRACT_LIMITS.cpuPercentMax, "$request.limits.cpuPercentMax");

  const containment = asRecord(request.containment, "$request.containment");
  assertExactKeys(containment, CONTAINMENT_KEYS, "$request.containment");
  requireLiteral(containment.consumer, PROCESS_CONSUMER, "$request.containment.consumer");
  const operationRoot = requireCanonicalWindowsPath(containment.operationRoot, "$request.containment.operationRoot");
  requireLiteral(containment.requireCanonicalPaths, true, "$request.containment.requireCanonicalPaths");

  const attemptMarker = asRecord(request.attemptMarker, "$request.attemptMarker");
  assertExactKeys(attemptMarker, MARKER_KEYS, "$request.attemptMarker");
  const markerPath = requireCanonicalWindowsPath(attemptMarker.path, "$request.attemptMarker.path");
  requireLiteral(attemptMarker.createNew, true, "$request.attemptMarker.createNew");

  const evidence = asRecord(request.evidence, "$request.evidence");
  assertExactKeys(evidence, EVIDENCE_KEYS, "$request.evidence");
  const evidencePath = requireCanonicalWindowsPath(evidence.path, "$request.evidence.path");
  requireLiteral(evidence.schema, PROCESS_EVIDENCE_SCHEMA, "$request.evidence.schema");
  requireLiteral(evidence.createNew, true, "$request.evidence.createNew");

  requireContainedPath(operationRoot, markerPath, "$request.attemptMarker.path");
  requireContainedPath(operationRoot, evidencePath, "$request.evidence.path");
  if (markerPath.toUpperCase() === evidencePath.toUpperCase() || executablePath.toUpperCase() === evidencePath.toUpperCase()) {
    throw new ContractError("path-role-collision", "executable, marker, and evidence paths must be distinct");
  }

  return {
    schema: PROCESS_REQUEST_SCHEMA,
    operationId: request.operationId as string,
    oneShot: true,
    retryAuthorized: false,
    executable: { path: executablePath, sha256: executable.sha256 as string },
    argv,
    stdin: { encoding: "base64", base64: stdinBase64, bytes: stdinBytes, sha256: stdin.sha256 as string },
    environment: { inherit: false, allowlist, values: values as Record<string, string> },
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
    attemptMarker: { path: markerPath, createNew: true },
    evidence: { path: evidencePath, schema: PROCESS_EVIDENCE_SCHEMA, createNew: true },
  };
}

export function encodeCanonicalProcessRequest(request: ProcessRequest): Buffer {
  const parsed = parseProcessRequest(request);
  const bytes = Buffer.from(canonicalizeJson(parsed), "utf8");
  if (bytes.byteLength > CONTRACT_LIMITS.requestBytesMax) {
    throw new ContractError("request-too-large", `canonical request exceeds ${CONTRACT_LIMITS.requestBytesMax} bytes`);
  }
  return bytes;
}

export function parseProcessEvidence(input: unknown): ProcessEvidence {
  const evidence = asRecord(input, "$evidence");
  assertExactKeys(evidence, PROCESS_EVIDENCE_KEYS, "$evidence");
  requireLiteral(evidence.schema, PROCESS_EVIDENCE_SCHEMA, "$evidence.schema");
  const requestBytes = requireInteger(
    evidence.requestBytes,
    "$evidence.requestBytes",
    1,
    CONTRACT_LIMITS.requestBytesMax,
  );
  requireStringMatch(evidence.requestSha256, SHA256_PATTERN, "$evidence.requestSha256");
  requireStringMatch(
    evidence.executableSha256Observed,
    SHA256_PATTERN,
    "$evidence.executableSha256Observed",
  );
  if (!Array.isArray(evidence.argv) || evidence.argv.length === 0 || evidence.argv.length > CONTRACT_LIMITS.argvCountMax) {
    throw new ContractError("invalid-evidence-argv", "$evidence.argv must be a nonempty bounded array");
  }
  const argv = evidence.argv.map((entry, index) => requireString(entry, `$evidence.argv[${index}]`));
  const stdinBytes = requireInteger(evidence.stdinBytes, "$evidence.stdinBytes", 0, CONTRACT_LIMITS.stdinBytesMax);
  requireStringMatch(evidence.stdinSha256, SHA256_PATTERN, "$evidence.stdinSha256");

  const startedUtc = requireTimestamp(evidence.startedUtc, "$evidence.startedUtc");
  const finishedUtc = requireTimestamp(evidence.finishedUtc, "$evidence.finishedUtc");
  const elapsedMs = Date.parse(finishedUtc) - Date.parse(startedUtc);
  if (elapsedMs < 0 || elapsedMs > CONTRACT_LIMITS.aggregateDeadlineMs) {
    throw new ContractError("invalid-evidence-duration", "$evidence timestamps are reversed or exceed the aggregate deadline");
  }

  const processStartCount = requireInteger(evidence.processStartCount, "$evidence.processStartCount", 0, 1) as 0 | 1;
  const terminalState = requireString(evidence.terminalState, "$evidence.terminalState");
  if (!TERMINAL_STATES.has(terminalState)) {
    throw new ContractError("invalid-terminal-state", `$evidence.terminalState ${terminalState} is not a v1 state`);
  }
  const exitCodeKnown = requireBoolean(evidence.exitCodeKnown, "$evidence.exitCodeKnown");
  let exitCode: number | null;
  if (evidence.exitCode === null) {
    exitCode = null;
  } else {
    exitCode = requireInteger(evidence.exitCode, "$evidence.exitCode", -2_147_483_648, 2_147_483_647);
  }
  const outputComplete = requireBoolean(evidence.outputComplete, "$evidence.outputComplete");
  const standardOutput = parseRawStreamEvidence(evidence.standardOutput, "$evidence.standardOutput", CONTRACT_LIMITS.stdoutBytesMax);
  const standardError = parseRawStreamEvidence(evidence.standardError, "$evidence.standardError", CONTRACT_LIMITS.stderrBytesMax);
  requireLiteral(evidence.retryPerformed, false, "$evidence.retryPerformed");
  requireLiteral(evidence.cleanupPerformed, false, "$evidence.cleanupPerformed");

  if (outputComplete !== (standardOutput.complete && standardError.complete)) {
    throw new ContractError("output-completeness-mismatch", "$evidence.outputComplete must equal both stream completeness flags");
  }
  if (terminalState === "known-exit") {
    if (processStartCount !== 1 || !exitCodeKnown || exitCode === null || !outputComplete) {
      throw new ContractError("known-exit-invariant", "known-exit requires one start, a known exit code, and complete output");
    }
  } else if (exitCodeKnown || exitCode !== null) {
    throw new ContractError("unknown-exit-invariant", "non-exit terminal states cannot claim an exit code");
  }
  if ((terminalState === "spawn-refused" || terminalState === "containment-refused") && processStartCount !== 0) {
    throw new ContractError("pre-spawn-invariant", `${terminalState} must record zero process starts`);
  }
  if (
    ["deadline-killed", "stdout-cap-killed", "stderr-cap-killed", "unknown"].includes(
      terminalState,
    ) &&
    processStartCount !== 1
  ) {
    throw new ContractError("post-spawn-invariant", `${terminalState} must record exactly one process start`);
  }

  return {
    schema: PROCESS_EVIDENCE_SCHEMA,
    requestBytes,
    requestSha256: evidence.requestSha256 as string,
    executableSha256Observed: evidence.executableSha256Observed as string,
    argv,
    stdinBytes,
    stdinSha256: evidence.stdinSha256 as string,
    startedUtc,
    finishedUtc,
    processStartCount,
    terminalState,
    exitCodeKnown,
    exitCode,
    outputComplete,
    standardOutput,
    standardError,
    retryPerformed: false,
    cleanupPerformed: false,
  };
}

export function parseCanonicalProcessEvidenceBytes(bytes: Uint8Array): ProcessEvidence {
  if (bytes.byteLength === 0 || bytes.byteLength > CONTRACT_LIMITS.evidenceBytesMax) {
    throw new ContractError("evidence-size", `evidence must contain 1..${CONTRACT_LIMITS.evidenceBytesMax} bytes`);
  }
  const text = decodeStrictUtf8(bytes, "$evidenceBytes");
  if (text.charCodeAt(0) === 0xfeff) throw new ContractError("evidence-bom", "evidence must not contain a BOM");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new ContractError("evidence-json", `evidence is not strict JSON: ${error instanceof Error ? error.message : "unknown parse error"}`);
  }
  const parsed = parseProcessEvidence(input);
  if (text !== canonicalizeJson(parsed)) {
    throw new ContractError("evidence-not-canonical", "evidence bytes differ from canonical v1 JSON");
  }
  return parsed;
}

export function parseCanonicalProcessRequestBytes(bytes: Uint8Array): ProcessRequest {
  if (bytes.byteLength === 0 || bytes.byteLength > CONTRACT_LIMITS.requestBytesMax) {
    throw new ContractError("request-size", `request must contain 1..${CONTRACT_LIMITS.requestBytesMax} bytes`);
  }
  const text = decodeStrictUtf8(bytes, "$requestBytes");
  if (text.charCodeAt(0) === 0xfeff) throw new ContractError("request-bom", "request must not contain a BOM");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new ContractError("request-json", `request is not strict JSON: ${error instanceof Error ? error.message : "unknown parse error"}`);
  }
  const parsed = parseProcessRequest(input);
  const canonical = canonicalizeJson(parsed);
  if (text !== canonical) throw new ContractError("request-not-canonical", "request bytes differ from canonical v1 JSON");
  return parsed;
}

export function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new ContractError("property-set-mismatch", `${path} expected [${sortedExpected.join(",")}] but received [${actual.join(",")}]`);
  }
}

export function decodeStrictUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ContractError("invalid-utf8", `${path} is not valid UTF-8`);
  }
}

export function decodeStrictBase64(value: string, path: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ContractError("invalid-base64", `${path} is not canonical Base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new ContractError("invalid-base64", `${path} is not canonical Base64`);
  return bytes;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("expected-object", `${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractError("non-plain-object", `${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function parseRawStreamEvidence(value: unknown, path: string, maximumBytes: number): RawStreamEvidence {
  const stream = asRecord(value, path);
  assertExactKeys(stream, RAW_STREAM_KEYS, path);
  const base64 = requireString(stream.base64, `${path}.base64`);
  const bytes = requireInteger(stream.bytes, `${path}.bytes`, 0, maximumBytes);
  const sha256 = requireStringMatch(stream.sha256, SHA256_PATTERN, `${path}.sha256`);
  const complete = requireBoolean(stream.complete, `${path}.complete`);
  const truncated = requireBoolean(stream.truncated, `${path}.truncated`);
  const decoded = decodeStrictBase64(base64, `${path}.base64`);
  if (decoded.byteLength !== bytes || sha256Hex(decoded) !== sha256) {
    throw new ContractError("stream-binding-mismatch", `${path} byte count or SHA-256 differs from captured bytes`);
  }
  if (complete === truncated) {
    throw new ContractError("stream-completeness-invariant", `${path} complete and truncated must be logical opposites`);
  }
  return { base64, bytes, sha256, complete, truncated };
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ContractError("expected-string", `${path} must be a string`);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ContractError("expected-boolean", `${path} must be a boolean`);
  return value;
}

function requireTimestamp(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!UTC_TIMESTAMP_PATTERN.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new ContractError("invalid-timestamp", `${path} must be an exact UTC millisecond timestamp`);
  }
  return text;
}

function requireStringMatch(value: unknown, pattern: RegExp, path: string): string {
  const text = requireString(value, path);
  if (!pattern.test(text)) throw new ContractError("string-format", `${path} has an invalid format`);
  return text;
}

function requireLiteral<T extends string | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new ContractError("literal-mismatch", `${path} must equal ${JSON.stringify(expected)}`);
  return expected;
}

function requireInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ContractError("integer-range", `${path} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function requireExactInteger(value: unknown, expected: number, path: string): number {
  const actual = requireInteger(value, path, expected, expected);
  return actual;
}

function requireCanonicalWindowsPath(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (
    text.length === 0 ||
    text.length > 32_767 ||
    !/^[A-Z]:\\/u.test(text) ||
    text.includes("/") ||
    /[\u0000-\u001f]/u.test(text) ||
    win32.normalize(text) !== text ||
    !win32.isAbsolute(text)
  ) {
    throw new ContractError("non-canonical-path", `${path} must be an absolute normalized Windows drive path`);
  }
  return text;
}

function requireContainedPath(root: string, candidate: string, path: string): void {
  const relative = win32.relative(root, candidate);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${win32.sep}`) || win32.isAbsolute(relative)) {
    throw new ContractError("path-containment", `${path} must be a strict descendant of the operation root`);
  }
}
