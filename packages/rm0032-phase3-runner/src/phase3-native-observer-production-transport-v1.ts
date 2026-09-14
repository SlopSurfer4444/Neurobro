import {
  NativeObserverContractError,
  canonicalizeObserverJson,
  parseCanonicalObserverRequestBytes,
  sha256Hex,
  type AcceptedNativeObserverBindingV1,
  type InvocationEvidenceV1,
  type NativeObserverInvocationInputV1,
  type ObserverJsonValue,
  type Phase3NativeObserverTransportV1,
} from "./phase3-native-observer-adapter-v1.ts";

const LAUNCHER_REQUEST_SCHEMA = "decadans.rm0032.native-observer-launcher-request.v1" as const;
const LAUNCHER_RESULT_SCHEMA = "decadans.rm0032.native-observer-launcher-result.v1" as const;
const LAUNCHER_VERSION = "v1" as const;
const MAX_LAUNCHER_HEADER_BYTES = 8_192;
const MAX_OBSERVER_PAYLOAD_BYTES = 65_536;
const MAX_LAUNCHER_RESULT_BYTES = 1_500_000;
const MAX_OBSERVER_STDOUT_BYTES = 1_114_113;
const OUTER_LAUNCHER_GRACE_MS = 5_000;
const CORRELATION_DOMAIN = "decadans.rm0032.native-observer-launcher-correlation.v1\0";
const LEDGER_DOMAIN = "decadans.rm0032.launcher-ledger-identity.v2\0";
const FIXED_LAUNCHER_IMAGE_PATH = "C:\\Program Files\\DecadansNeurobro\\rm0032-phase3-native-observer-launcher-v1.exe";
const FIXED_OBSERVER_IMAGE_PATH = "C:\\Program Files\\DecadansNeurobro\\rm0032-phase3-native-observer-v1.exe";
const FIXED_EVIDENCE_ROOT_PATH = "C:\\ProgramData\\DecadansNeurobro\\accepted-evidence-v1";

export interface AcceptedNativeObserverLauncherBindingV1 {
  readonly launcherAbsolutePath: string;
  readonly launcherSha256: string;
  readonly carrierSha256: string;
  readonly acceptedObserverBinding: AcceptedNativeObserverBindingV1;
}

export interface NativeObserverLauncherPortInputV1 {
  readonly canonicalSupervisorInputBytes: Uint8Array;
  readonly deadlineMs: number;
}

export interface NativeObserverLauncherPortResultV1 {
  readonly invocationAttemptCount: 1;
  readonly launcherStarted: false | true | "unknown";
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutComplete: boolean;
  readonly stderrComplete: boolean;
}

export interface Phase3NativeObserverLauncherPortV1 {
  invoke(input: NativeObserverLauncherPortInputV1): Promise<NativeObserverLauncherPortResultV1>;
}

interface LauncherWireEnvelopeV1 {
  schema: typeof LAUNCHER_REQUEST_SCHEMA;
  version: typeof LAUNCHER_VERSION;
  requestId: string;
  correlationId: string;
  carrierSha256: string;
  launcherImagePath: string;
  launcherImageSha256: string;
  observerImagePath: string;
  observerImageSha256: string;
  evidenceRootAbsolutePath: string;
  stdinSha256: string;
  stdinByteCount: number;
  deadlineMs: number;
}

interface StrictRecord {
  readonly [key: string]: unknown;
}

function fail(code: string, message: string): never {
  throw new NativeObserverContractError(code, message);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactDataRecord(value: unknown, expected: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("object", `${path} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("object", `${path} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail("property-set", `${path} has symbol properties`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("property-set", `${path} has a non-exact property set`);
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail("property-set", `${path}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail("string", `${path} must be a string`);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("boolean", `${path} must be a boolean`);
  return value;
}

function exactLowerSha256(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!/^[0-9a-f]{64}$/u.test(text)) fail("sha256", `${path} must be lowercase SHA-256`);
  return text;
}

function validateAbsoluteDosPath(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (Buffer.byteLength(text, "utf8") < 4 || Buffer.byteLength(text, "utf8") > 1_024 || !/^[A-Z]:\\[^/]+/u.test(text)) {
    fail("path", `${path} must be a bounded uppercase-drive DOS absolute path`);
  }
  for (const component of text.slice(3).split("\\")) {
    if (component.length === 0 || component === "." || component === ".." || component.includes(":")) {
      fail("path", `${path} contains a noncanonical component`);
    }
  }
  return text;
}

function snapshotObserverBinding(value: unknown, path: string): AcceptedNativeObserverBindingV1 {
  const record = exactDataRecord(
    value,
    ["observerAbsolutePath", "observerSha256", "evidenceRootAbsolutePath"],
    path,
  );
  return Object.freeze({
    observerAbsolutePath: validateAbsoluteDosPath(record.observerAbsolutePath, `${path}.observerAbsolutePath`),
    observerSha256: exactLowerSha256(record.observerSha256, `${path}.observerSha256`),
    evidenceRootAbsolutePath: validateAbsoluteDosPath(record.evidenceRootAbsolutePath, `${path}.evidenceRootAbsolutePath`),
  });
}

function snapshotLauncherBinding(value: unknown): AcceptedNativeObserverLauncherBindingV1 {
  const record = exactDataRecord(
    value,
    ["launcherAbsolutePath", "launcherSha256", "carrierSha256", "acceptedObserverBinding"],
    "$binding",
  );
  const snapshot = Object.freeze({
    launcherAbsolutePath: validateAbsoluteDosPath(record.launcherAbsolutePath, "$binding.launcherAbsolutePath"),
    launcherSha256: exactLowerSha256(record.launcherSha256, "$binding.launcherSha256"),
    carrierSha256: exactLowerSha256(record.carrierSha256, "$binding.carrierSha256"),
    acceptedObserverBinding: snapshotObserverBinding(record.acceptedObserverBinding, "$binding.acceptedObserverBinding"),
  });
  if (snapshot.launcherAbsolutePath !== FIXED_LAUNCHER_IMAGE_PATH
    || snapshot.acceptedObserverBinding.observerAbsolutePath !== FIXED_OBSERVER_IMAGE_PATH
    || snapshot.acceptedObserverBinding.evidenceRootAbsolutePath !== FIXED_EVIDENCE_ROOT_PATH) {
    fail("binding", "launcher, observer, or evidence-root path differs from the fixed native installation");
  }
  return snapshot;
}

function validatePort(value: unknown): Phase3NativeObserverLauncherPortV1 {
  const record = exactDataRecord(value, ["invoke"], "$port");
  if (typeof record.invoke !== "function") fail("port", "$port.invoke must be a function");
  return Object.freeze({ invoke: record.invoke as Phase3NativeObserverLauncherPortV1["invoke"] });
}

function bindingEqual(left: AcceptedNativeObserverBindingV1, right: AcceptedNativeObserverBindingV1): boolean {
  return canonicalizeObserverJson(left) === canonicalizeObserverJson(right);
}

function snapshotInvocationInput(value: unknown, binding: AcceptedNativeObserverLauncherBindingV1): {
  canonicalRequestBytes: Buffer;
  deadlineContext: { aggregateDeadlineMonotonicMs: number; operationDeadlineMonotonicMs: number };
} {
  const record = exactDataRecord(
    value,
    ["canonicalRequestBytes", "acceptedBinding", "deadlineContext"],
    "$input",
  );
  if (!(record.canonicalRequestBytes instanceof Uint8Array)) fail("input", "$input.canonicalRequestBytes must be Uint8Array");
  const acceptedBinding = snapshotObserverBinding(record.acceptedBinding, "$input.acceptedBinding");
  if (!bindingEqual(acceptedBinding, binding.acceptedObserverBinding)) fail("binding", "invocation binding differs from accepted launcher binding");
  const deadline = exactDataRecord(
    record.deadlineContext,
    ["aggregateDeadlineMonotonicMs", "operationDeadlineMonotonicMs"],
    "$input.deadlineContext",
  );
  const aggregate = deadline.aggregateDeadlineMonotonicMs;
  const operation = deadline.operationDeadlineMonotonicMs;
  if (
    typeof aggregate !== "number" || typeof operation !== "number"
    || !Number.isSafeInteger(aggregate) || !Number.isSafeInteger(operation)
    || aggregate < 0 || operation < 0
  ) {
    fail("deadline", "deadline context must contain nonnegative safe integers");
  }
  const canonicalRequestBytes = Buffer.from(record.canonicalRequestBytes);
  parseCanonicalObserverRequestBytes(canonicalRequestBytes);
  if (canonicalRequestBytes.byteLength > MAX_OBSERVER_PAYLOAD_BYTES) {
    fail("request-cap", "canonical observer request exceeds the actual launcher payload cap");
  }
  return {
    canonicalRequestBytes,
    deadlineContext: Object.freeze({
      aggregateDeadlineMonotonicMs: aggregate,
      operationDeadlineMonotonicMs: operation,
    }),
  };
}

function sampleMonotonicMs(): number {
  const sampled = performance.now();
  if (!Number.isFinite(sampled) || sampled < 0) fail("deadline", "monotonic clock sample is invalid");
  const floored = Math.floor(sampled);
  if (!Number.isSafeInteger(floored)) fail("deadline", "monotonic clock sample exceeds safe integer range");
  return floored;
}

function deriveDeadlineMs(deadline: { aggregateDeadlineMonotonicMs: number; operationDeadlineMonotonicMs: number }): number {
  const remaining = Math.min(deadline.aggregateDeadlineMonotonicMs, deadline.operationDeadlineMonotonicMs) - sampleMonotonicMs();
  if (!Number.isSafeInteger(remaining) || remaining <= OUTER_LAUNCHER_GRACE_MS) {
    fail("deadline", "no full child deadline plus launcher grace remains");
  }
  return Math.min(10_000, remaining - OUTER_LAUNCHER_GRACE_MS);
}

function uuidV4FromDigestHex(digestHex: string): string {
  const bytes = Buffer.from(digestHex.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function deriveCorrelationId(
  requestBytes: Uint8Array,
  binding: AcceptedNativeObserverLauncherBindingV1,
): string {
  const launcherBindingBytes = Buffer.from(canonicalizeObserverJson(binding), "utf8");
  return uuidV4FromDigestHex(sha256Hex(Buffer.concat([
    Buffer.from(CORRELATION_DOMAIN, "utf8"),
    Buffer.from(requestBytes),
    Buffer.from("\0carrier=", "utf8"),
    Buffer.from(binding.carrierSha256, "utf8"),
    Buffer.from("\0launcher-binding=", "utf8"),
    launcherBindingBytes,
  ])));
}

function encodeWireEnvelope(envelope: LauncherWireEnvelopeV1): Buffer {
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LAUNCHER_HEADER_BYTES || bytes.includes(0x0a)) {
    fail("launcher-header", "launcher header differs from its exact framing cap");
  }
  return bytes;
}

function expectedSupervisorLedgerIdentity(headerBytes: Uint8Array, payloadBytes: Uint8Array): string {
  return sha256Hex(Buffer.concat([
    Buffer.from(LEDGER_DOMAIN, "utf8"),
    Buffer.from("stage=supervisor-before-worker", "utf8"),
    Buffer.from("\0header=", "utf8"),
    Buffer.from(sha256Hex(headerBytes), "utf8"),
    Buffer.from("\0payload=", "utf8"),
    Buffer.from(sha256Hex(payloadBytes), "utf8"),
  ]));
}

class RustCanonicalJsonParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): ObserverJsonValue {
    const value = this.value();
    if (this.index !== this.source.length) fail("launcher-json", `trailing JSON at ${this.index}`);
    return value;
  }

  private value(): ObserverJsonValue {
    const token = this.source[this.index];
    if (token === '"') return this.string();
    if (token === "{") return this.object();
    if (token === "[") return this.array();
    if (token === "t") return this.literal("true", true);
    if (token === "f") return this.literal("false", false);
    if (token === "n") return this.literal("null", null);
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) return this.integer();
    fail("launcher-json", `unexpected token at ${this.index}`);
  }

  private string(): string {
    this.index += 1;
    let result = "";
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === '"') return result;
      if (character === "\\") {
        const escaped = this.source[this.index++];
        if (escaped !== '"' && escaped !== "\\") fail("launcher-json", `forbidden escape at ${this.index}`);
        result += escaped;
      } else {
        const scalar = character.codePointAt(0) as number;
        if (scalar <= 0x1f || (scalar >= 0x7f && scalar <= 0x9f)) fail("launcher-json", "control scalar in string");
        result += character;
      }
    }
    fail("launcher-json", "unterminated string");
  }

  private object(): { [key: string]: ObserverJsonValue } {
    this.index += 1;
    const result: { [key: string]: ObserverJsonValue } = Object.create(null) as { [key: string]: ObserverJsonValue };
    const keys = new Set<string>();
    if (this.source[this.index] === "}") { this.index += 1; return result; }
    for (;;) {
      if (this.source[this.index] !== '"') fail("launcher-json", "object key is not a string");
      const key = this.string();
      if (keys.has(key)) fail("launcher-json", `duplicate property ${key}`);
      keys.add(key);
      if (this.source[this.index++] !== ":") fail("launcher-json", "object key lacks colon");
      result[key] = this.value();
      const delimiter = this.source[this.index++];
      if (delimiter === "}") return result;
      if (delimiter !== ",") fail("launcher-json", "object delimiter differs");
    }
  }

  private array(): ObserverJsonValue[] {
    this.index += 1;
    const result: ObserverJsonValue[] = [];
    if (this.source[this.index] === "]") { this.index += 1; return result; }
    for (;;) {
      result.push(this.value());
      const delimiter = this.source[this.index++];
      if (delimiter === "]") return result;
      if (delimiter !== ",") fail("launcher-json", "array delimiter differs");
    }
  }

  private literal<T extends boolean | null>(token: string, value: T): T {
    if (this.source.slice(this.index, this.index + token.length) !== token) fail("launcher-json", `invalid ${token}`);
    this.index += token.length;
    return value;
  }

  private integer(): number {
    const match = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)/u.exec(this.source.slice(this.index));
    if (match === null) fail("launcher-json", "invalid integer");
    const end = this.index + match[0].length;
    const following = this.source[end];
    if (following !== undefined && !",]}".includes(following)) fail("launcher-json", "noninteger number");
    const integer = BigInt(match[0]);
    if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) fail("launcher-json", "unsafe integer");
    this.index = end;
    return Number(integer);
  }
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("launcher-json", "UTF-8 BOM is forbidden");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("launcher-json", "launcher result is not strict UTF-8");
  }
}

function exactOrderedRecord(value: unknown, expected: readonly string[], path: string): StrictRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("launcher-result", `${path} must be an object`);
  const record = value as StrictRecord;
  const actual = Object.keys(record);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("launcher-result", `${path} field order or property set differs`);
  }
  return record;
}

function decodeCanonicalBase64(value: unknown, cap: number, path: string): Buffer {
  const text = requireString(value, path);
  if (text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(text)) {
    fail("launcher-result", `${path} is not canonical Base64`);
  }
  const bytes = Buffer.from(text, "base64");
  if (bytes.byteLength > cap || bytes.toString("base64") !== text) fail("launcher-result", `${path} exceeds its cap or is noncanonical`);
  return bytes;
}

function parseExitState(value: unknown): InvocationEvidenceV1["exitState"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("launcher-result", "exitState must be an object");
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "known") {
    const record = exactOrderedRecord(value, ["kind", "code"], "$result.evidence.exitState");
    if (!Number.isInteger(record.code) || (record.code as number) < -2_147_483_648 || (record.code as number) > 2_147_483_647) {
      fail("launcher-result", "known exit code differs from signed i32");
    }
    return Object.freeze({ kind: "known", code: record.code as number });
  }
  if (kind !== "not-started" && kind !== "unknown") fail("launcher-result", "exitState kind differs");
  exactOrderedRecord(value, ["kind"], "$result.evidence.exitState");
  return Object.freeze({ kind });
}

function mapNestedEvidence(value: unknown, evidenceRootAbsolutePath: string): InvocationEvidenceV1 {
  const record = exactOrderedRecord(value, [
    "kind", "invocationAttemptCount", "childStarted", "capturedStdoutBase64", "capturedStderrBase64",
    "stdoutState", "stderrState", "streamClosureState", "exitState",
  ], "$result.evidence");
  if (record.invocationAttemptCount !== 1) fail("launcher-result", "nested invocation count differs");
  const stdout = decodeCanonicalBase64(record.capturedStdoutBase64, MAX_OBSERVER_STDOUT_BYTES, "$result.evidence.capturedStdoutBase64");
  const stderr = decodeCanonicalBase64(record.capturedStderrBase64, 0, "$result.evidence.capturedStderrBase64");
  const exitState = parseExitState(record.exitState);
  const common = {
    invocationAttemptCount: 1 as const,
    evidenceRootAbsolutePath,
    capturedStdoutBytes: Buffer.from(stdout),
    capturedStderrBytes: Buffer.from(stderr),
  };
  if (record.kind === "child-never-started") {
    if (record.childStarted !== false || stdout.byteLength !== 0 || record.stdoutState !== "not-opened"
      || record.stderrState !== "not-opened" || record.streamClosureState !== "not-opened" || exitState.kind !== "not-started") {
      fail("launcher-result", "child-never-started evidence is contradictory");
    }
    return Object.freeze({ ...common, kind: "child-never-started", childStarted: false, stdoutState: "not-opened", stderrState: "not-opened", streamClosureState: "not-opened", exitState });
  }
  if (record.kind === "child-started") {
    if (record.childStarted !== true
      || !["eof", "not-eof-or-unknown", "cap-exceeded-or-truncated"].includes(record.stdoutState as string)
      || !["eof-zero-bytes", "nonzero-byte-seen", "not-eof-or-unknown"].includes(record.stderrState as string)
      || !["both-eof", "incomplete-or-unknown"].includes(record.streamClosureState as string)
      || exitState.kind === "not-started"
      || (record.streamClosureState === "both-eof" && (record.stdoutState !== "eof" || record.stderrState !== "eof-zero-bytes"))) {
      fail("launcher-result", "child-started evidence is contradictory");
    }
    return Object.freeze({ ...common, kind: "child-started", childStarted: true, stdoutState: record.stdoutState, stderrState: record.stderrState, streamClosureState: record.streamClosureState, exitState }) as InvocationEvidenceV1;
  }
  if (record.kind !== "child-start-ambiguous" || record.childStarted !== "unknown"
    || !["not-opened", "eof", "not-eof-or-unknown", "cap-exceeded-or-truncated"].includes(record.stdoutState as string)
    || !["not-opened", "eof-zero-bytes", "nonzero-byte-seen", "not-eof-or-unknown"].includes(record.stderrState as string)
    || !["not-opened", "both-eof", "incomplete-or-unknown"].includes(record.streamClosureState as string)
    || (record.streamClosureState === "both-eof" && (record.stdoutState !== "eof" || record.stderrState !== "eof-zero-bytes"))) {
    fail("launcher-result", "child-start-ambiguous evidence is contradictory");
  }
  return Object.freeze({ ...common, kind: "child-start-ambiguous", childStarted: "unknown", stdoutState: record.stdoutState, stderrState: record.stderrState, streamClosureState: record.streamClosureState, exitState }) as InvocationEvidenceV1;
}

function parseLauncherResult(
  bytes: Uint8Array,
  envelope: LauncherWireEnvelopeV1,
  expectedLedgerIdentity: string,
  evidenceRootAbsolutePath: string,
): InvocationEvidenceV1 {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LAUNCHER_RESULT_BYTES) fail("launcher-result", "launcher result length differs");
  const text = decodeStrictUtf8(bytes);
  const value = new RustCanonicalJsonParser(text).parse();
  if (JSON.stringify(value) !== text) fail("launcher-result", "launcher result is not canonical Rust JSON");
  const record = exactOrderedRecord(value, [
    "schema", "requestId", "correlationId", "carrierSha256", "observerImageSha256", "stdinSha256",
    "deadlineMs", "ledgerIdentitySha256", "terminal", "reason", "invocationAttemptCount", "childStartEvidence",
    "childStarted", "ledgerState", "sticky", "handlesReleased", "evidence",
  ], "$result");
  if (record.schema !== LAUNCHER_RESULT_SCHEMA || record.requestId !== envelope.requestId
    || record.correlationId !== envelope.correlationId || record.carrierSha256 !== envelope.carrierSha256
    || record.observerImageSha256 !== envelope.observerImageSha256 || record.stdinSha256 !== envelope.stdinSha256
    || record.deadlineMs !== envelope.deadlineMs || record.ledgerIdentitySha256 !== expectedLedgerIdentity
    || record.invocationAttemptCount !== 1) {
    fail("launcher-result", "launcher result correlation or binding differs");
  }
  const terminal = requireString(record.terminal, "$result.terminal");
  const reason = requireString(record.reason, "$result.reason");
  const childStartEvidence = requireString(record.childStartEvidence, "$result.childStartEvidence");
  const childStarted = requireString(record.childStarted, "$result.childStarted");
  const ledgerState = requireString(record.ledgerState, "$result.ledgerState");
  const sticky = requireBoolean(record.sticky, "$result.sticky");
  const handlesReleased = requireBoolean(record.handlesReleased, "$result.handlesReleased");
  if (!new Set(["success", "refused", "failed", "unknown", "deadline", "quarantined"]).has(terminal)
    || reason.length === 0 || Buffer.byteLength(reason, "utf8") > 1_024
    || !new Set(["never-started", "started", "ambiguous"]).has(childStartEvidence)
    || childStarted !== ({ "never-started": "false", started: "true", ambiguous: "unknown" } as Record<string, string>)[childStartEvidence]
    || !new Set(["unattempted", "durable-consumed", "sticky-collision", "sticky-unknown"]).has(ledgerState)
    || ((ledgerState === "sticky-collision" || ledgerState === "sticky-unknown") && !sticky)
    || terminal !== "success"
    || reason !== "bounded fixed launcher invocation succeeded"
    || childStartEvidence !== "started"
    || ledgerState !== "durable-consumed"
    || sticky
    || !handlesReleased) {
    fail("launcher-result", "launcher terminal, reason, ledger, or handle invariant differs");
  }
  return mapNestedEvidence(record.evidence, evidenceRootAbsolutePath);
}

function ambiguousEvidence(evidenceRootAbsolutePath: string): InvocationEvidenceV1 {
  return Object.freeze({
    kind: "child-start-ambiguous",
    invocationAttemptCount: 1,
    evidenceRootAbsolutePath,
    childStarted: "unknown",
    capturedStdoutBytes: Buffer.alloc(0),
    capturedStderrBytes: Buffer.alloc(0),
    stdoutState: "not-opened",
    stderrState: "not-opened",
    streamClosureState: "not-opened",
    exitState: Object.freeze({ kind: "not-started" }),
  });
}

function neverStartedEvidence(evidenceRootAbsolutePath: string): InvocationEvidenceV1 {
  return Object.freeze({
    kind: "child-never-started",
    invocationAttemptCount: 1,
    evidenceRootAbsolutePath,
    childStarted: false,
    capturedStdoutBytes: Buffer.alloc(0),
    capturedStderrBytes: Buffer.alloc(0),
    stdoutState: "not-opened",
    stderrState: "not-opened",
    streamClosureState: "not-opened",
    exitState: Object.freeze({ kind: "not-started" }),
  });
}

function snapshotPortResult(value: unknown): NativeObserverLauncherPortResultV1 {
  const record = exactDataRecord(
    value,
    ["invocationAttemptCount", "launcherStarted", "exitCode", "stdout", "stderr", "stdoutComplete", "stderrComplete"],
    "$portResult",
  );
  if (record.invocationAttemptCount !== 1 || ![false, true, "unknown"].includes(record.launcherStarted as false | true | "unknown")
    || !(record.stdout instanceof Uint8Array) || !(record.stderr instanceof Uint8Array)
    || typeof record.stdoutComplete !== "boolean" || typeof record.stderrComplete !== "boolean"
    || (record.exitCode !== null && (!Number.isInteger(record.exitCode) || (record.exitCode as number) < -2_147_483_648 || (record.exitCode as number) > 2_147_483_647))) {
    fail("port-result", "launcher port result differs from its exact contract");
  }
  if (record.stdout.byteLength > MAX_LAUNCHER_RESULT_BYTES || record.stderr.byteLength !== 0) {
    fail("port-result", "launcher port raw streams exceed their retained caps");
  }
  return Object.freeze({
    invocationAttemptCount: 1,
    launcherStarted: record.launcherStarted as false | true | "unknown",
    exitCode: record.exitCode as number | null,
    stdout: Buffer.from(record.stdout),
    stderr: Buffer.from(record.stderr),
    stdoutComplete: record.stdoutComplete,
    stderrComplete: record.stderrComplete,
  });
}

export function createPhase3NativeObserverProductionTransportV1(
  binding: AcceptedNativeObserverLauncherBindingV1,
  port: Phase3NativeObserverLauncherPortV1,
): Phase3NativeObserverTransportV1 {
  const accepted = snapshotLauncherBinding(binding);
  const launcherPort = validatePort(port);
  const evidenceRoot = accepted.acceptedObserverBinding.evidenceRootAbsolutePath;

  return Object.freeze({
    async invoke(input: NativeObserverInvocationInputV1): Promise<InvocationEvidenceV1> {
      let snapshot: ReturnType<typeof snapshotInvocationInput>;
      let requestId: string;
      let deadlineMs: number;
      try {
        snapshot = snapshotInvocationInput(input, accepted);
        requestId = parseCanonicalObserverRequestBytes(snapshot.canonicalRequestBytes).requestId;
        deadlineMs = deriveDeadlineMs(snapshot.deadlineContext);
      } catch {
        return ambiguousEvidence(evidenceRoot);
      }
      const stdinSha256 = sha256Hex(snapshot.canonicalRequestBytes);
      const envelope: LauncherWireEnvelopeV1 = {
        schema: LAUNCHER_REQUEST_SCHEMA,
        version: LAUNCHER_VERSION,
        requestId,
        correlationId: deriveCorrelationId(snapshot.canonicalRequestBytes, accepted),
        carrierSha256: accepted.carrierSha256,
        launcherImagePath: accepted.launcherAbsolutePath,
        launcherImageSha256: accepted.launcherSha256,
        observerImagePath: accepted.acceptedObserverBinding.observerAbsolutePath,
        observerImageSha256: accepted.acceptedObserverBinding.observerSha256,
        evidenceRootAbsolutePath: accepted.acceptedObserverBinding.evidenceRootAbsolutePath,
        stdinSha256,
        stdinByteCount: snapshot.canonicalRequestBytes.byteLength,
        deadlineMs,
      };
      const headerBytes = encodeWireEnvelope(envelope);
      const supervisorInputBytes = Buffer.concat([headerBytes, Buffer.from("\n"), snapshot.canonicalRequestBytes]);
      const supervisorInputSha256 = sha256Hex(supervisorInputBytes);
      const portInput = Object.freeze({ canonicalSupervisorInputBytes: supervisorInputBytes, deadlineMs });
      let result: NativeObserverLauncherPortResultV1;
      try {
        result = snapshotPortResult(await launcherPort.invoke(portInput));
      } catch {
        return ambiguousEvidence(evidenceRoot);
      }
      if (sha256Hex(supervisorInputBytes) !== supervisorInputSha256) return ambiguousEvidence(evidenceRoot);
      if (result.launcherStarted === false) {
        if (result.exitCode === null && result.stdout.byteLength === 0 && result.stderr.byteLength === 0
          && result.stdoutComplete === false && result.stderrComplete === false) {
          return neverStartedEvidence(evidenceRoot);
        }
        return ambiguousEvidence(evidenceRoot);
      }
      if (result.launcherStarted !== true || result.exitCode !== 0 || !result.stdoutComplete || !result.stderrComplete || result.stderr.byteLength !== 0) {
        return ambiguousEvidence(evidenceRoot);
      }
      try {
        return parseLauncherResult(
          result.stdout,
          envelope,
          expectedSupervisorLedgerIdentity(headerBytes, snapshot.canonicalRequestBytes),
          evidenceRoot,
        );
      } catch {
        return ambiguousEvidence(evidenceRoot);
      }
    },
  });
}
