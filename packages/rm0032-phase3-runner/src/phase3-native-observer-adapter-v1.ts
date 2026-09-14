import { createHash } from "node:crypto";

export const NATIVE_OBSERVER_REQUEST_SCHEMA = "decadans.rm0032.native-observer-request.v1" as const;
export const NATIVE_OBSERVER_OBSERVATION_SCHEMA = "decadans.rm0032.native-observer-observation.v1" as const;
export const NATIVE_OBSERVER_ACKNOWLEDGMENT_SCHEMA = "decadans.rm0032.native-observer-ack.v1" as const;
export const NATIVE_OBSERVER_PRE_OBSERVATION_REFUSAL_SCHEMA = "decadans.rm0032.native-observer-pre-observation-refusal.v1" as const;
export const NATIVE_OBSERVER_TERMINAL_SCHEMA = "decadans.rm0032.native-observer-terminal-failure.v1" as const;
export const NATIVE_OBSERVER_VERSION = "v1" as const;
export const NATIVE_OBSERVER_CONSUMER = "rm-0032-phase3-hardening-coordinator" as const;

export type ObserverJsonValue =
  | null
  | boolean
  | number
  | string
  | ObserverJsonValue[]
  | { [key: string]: ObserverJsonValue };

export interface ReadBoundFileRequestV1 {
  schema: typeof NATIVE_OBSERVER_REQUEST_SCHEMA;
  version: typeof NATIVE_OBSERVER_VERSION;
  consumer: typeof NATIVE_OBSERVER_CONSUMER;
  operation: "read-bound-file";
  requestId: string;
  rootPath: string;
  targetPath: string;
}

export interface CreateNewDurableFileRequestV1 {
  schema: typeof NATIVE_OBSERVER_REQUEST_SCHEMA;
  version: typeof NATIVE_OBSERVER_VERSION;
  consumer: typeof NATIVE_OBSERVER_CONSUMER;
  operation: "create-new-durable-file";
  requestId: string;
  rootPath: string;
  targetPath: string;
  contentBase64: string;
}

export type NativeObserverRequestV1 = ReadBoundFileRequestV1 | CreateNewDurableFileRequestV1;

export class NativeObserverContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "NativeObserverContractError";
    this.code = code;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateRequestId(value: string): boolean {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u.test(value);
}

export function validateSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

export function decodeCanonicalBase64(value: string, maximumBytes: number): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new NativeObserverContractError("base64", "maximum byte cap is invalid");
  }
  const maximumEncodedBytes = Math.ceil(maximumBytes / 3) * 4;
  if (
    value.length > maximumEncodedBytes
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new NativeObserverContractError("base64", "value is not canonical RFC4648 Base64");
  }
  const paddingBytes = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedByteLength = (value.length / 4) * 3 - paddingBytes;
  if (decodedByteLength > maximumBytes) {
    throw new NativeObserverContractError("base64", "value is oversized before decode");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maximumBytes || decoded.toString("base64") !== value) {
    throw new NativeObserverContractError("base64", "value is noncanonical or oversized");
  }
  return decoded;
}

function parseInputPath(path: string): { drive: string; components: string[] } {
  if (
    Buffer.byteLength(path, "utf8") < 3
    || Buffer.byteLength(path, "utf8") > 1_024
    || !/^[A-Z]:\\/u.test(path)
    || path.includes("/")
  ) {
    throw new NativeObserverContractError("path", "path must be a bounded uppercase-drive DOS absolute path");
  }
  rejectControlScalars(path, "$path");
  const components = path.slice(3).length === 0 ? [] : path.slice(3).split("\\");
  for (const component of components) {
    if (
      component.length === 0
      || component === "."
      || component === ".."
      || component.includes(":")
      || /[<>"|?*]/u.test(component)
      || component.endsWith(".")
      || component.endsWith(" ")
    ) {
      throw new NativeObserverContractError("path-component", "path component is noncanonical");
    }
    const stem = component.split(".", 1)[0].replace(/[a-z]/gu, (character) => character.toUpperCase());
    if (
      ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].includes(stem)
      || /^(?:COM|LPT)(?:[1-9]|[¹²³])$/u.test(stem)
    ) {
      throw new NativeObserverContractError("path-component", "reserved DOS path component");
    }
  }
  return { drive: path[0], components };
}

export function validateInputPathPair(root: string, target: string): void {
  const rootPath = parseInputPath(root);
  const targetPath = parseInputPath(target);
  if (rootPath.drive !== targetPath.drive || targetPath.components.length <= rootPath.components.length) {
    throw new NativeObserverContractError("path-descendant", "target must be a strict descendant on the same drive");
  }
  for (let index = 0; index < rootPath.components.length; index += 1) {
    if (rootPath.components[index] !== targetPath.components[index]) {
      throw new NativeObserverContractError("path-descendant", "target prefix components must be byte-identical");
    }
  }
}

function trustedFinalComponents(path: string): string[] {
  if (!/^\\\\\?\\[A-Z]:\\/u.test(path) || path.includes("/")) {
    throw new NativeObserverContractError("final-path", "trusted final path lacks exact extended DOS prefix");
  }
  rejectControlScalars(path, "$finalPath");
  const tail = path.slice(7);
  const components = [path.slice(4, 6), ...(tail.length === 0 ? [] : tail.split("\\"))];
  if (components.some((component, index) => index > 0 && (component.length === 0 || component === "." || component === ".."))) {
    throw new NativeObserverContractError("final-path", "trusted final path has a noncanonical component");
  }
  return components;
}

export function validateFinalContainment(root: string, target: string): "contained" | "non-identical" | "invalid" {
  let rootComponents: string[];
  let targetComponents: string[];
  try {
    rootComponents = trustedFinalComponents(root);
    targetComponents = trustedFinalComponents(target);
  } catch {
    return "invalid";
  }
  if (targetComponents.length <= rootComponents.length) return "invalid";
  for (let index = 0; index < rootComponents.length; index += 1) {
    const left = Buffer.from(rootComponents[index], "utf16le");
    const right = Buffer.from(targetComponents[index], "utf16le");
    if (left.byteLength !== right.byteLength || !left.equals(right)) return "non-identical";
  }
  return "contained";
}

const LEGAL_TERMINAL_TUPLES = new Set([
  "read-bound-file|refused|pre-effect|none",
  "read-bound-file|unknown|pre-effect|none",
  "read-bound-file|refused|read-observation|none",
  "read-bound-file|unknown|read-observation|none",
  "create-new-durable-file|refused|pre-effect|none",
  "create-new-durable-file|unknown|pre-effect|none",
  "create-new-durable-file|refused|create-collision|not-created",
  "create-new-durable-file|unknown|post-create|possibly-created",
]);

export interface PreObservationRefusalV1 {
  schema: typeof NATIVE_OBSERVER_PRE_OBSERVATION_REFUSAL_SCHEMA;
  version: typeof NATIVE_OBSERVER_VERSION;
  consumer: typeof NATIVE_OBSERVER_CONSUMER;
  outcome: "refused";
  failureStage: "pre-observation";
}

export interface CorrelatedTerminalFailureV1 {
  schema: typeof NATIVE_OBSERVER_TERMINAL_SCHEMA;
  version: typeof NATIVE_OBSERVER_VERSION;
  consumer: typeof NATIVE_OBSERVER_CONSUMER;
  operation: "read-bound-file" | "create-new-durable-file";
  requestId: string;
  requestSha256: string;
  outcome: "refused" | "unknown";
  failureStage: "pre-effect" | "read-observation" | "create-collision" | "post-create";
  effectState: "none" | "not-created" | "possibly-created";
}

type ReadRefusedTerminalV1 = CorrelatedTerminalFailureV1 & {
  operation: "read-bound-file";
  outcome: "refused";
};
type ReadUnknownTerminalV1 = CorrelatedTerminalFailureV1 & {
  operation: "read-bound-file";
  outcome: "unknown";
};
type CreateRefusedTerminalV1 = CorrelatedTerminalFailureV1 & {
  operation: "create-new-durable-file";
  outcome: "refused";
};
type CreateUnknownTerminalV1 = CorrelatedTerminalFailureV1 & {
  operation: "create-new-durable-file";
  outcome: "unknown";
};

export function makePreObservationRefusal(): PreObservationRefusalV1 {
  return {
    schema: NATIVE_OBSERVER_PRE_OBSERVATION_REFUSAL_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    outcome: "refused",
    failureStage: "pre-observation",
  };
}

export function makeCorrelatedTerminal(
  operation: string,
  requestId: string,
  requestSha256: string,
  outcome: string,
  failureStage: string,
  effectState: string,
): CorrelatedTerminalFailureV1 {
  if (
    !validateRequestId(requestId)
    || !validateSha256(requestSha256)
    || !LEGAL_TERMINAL_TUPLES.has(`${operation}|${outcome}|${failureStage}|${effectState}`)
  ) {
    throw new NativeObserverContractError("terminal-tuple", "terminal correlation or tuple is not legal");
  }
  return {
    schema: NATIVE_OBSERVER_TERMINAL_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    operation: operation as CorrelatedTerminalFailureV1["operation"],
    requestId,
    requestSha256,
    outcome: outcome as CorrelatedTerminalFailureV1["outcome"],
    failureStage: failureStage as CorrelatedTerminalFailureV1["failureStage"],
    effectState: effectState as CorrelatedTerminalFailureV1["effectState"],
  };
}

export function validateTerminal(value: unknown): PreObservationRefusalV1 | CorrelatedTerminalFailureV1 {
  const terminal = asRecord(value, "$terminal");
  if (terminal.schema === NATIVE_OBSERVER_PRE_OBSERVATION_REFUSAL_SCHEMA) {
    exactKeys(terminal, ["schema", "version", "consumer", "outcome", "failureStage"], "$terminal");
    if (
      terminal.version !== NATIVE_OBSERVER_VERSION
      || terminal.consumer !== NATIVE_OBSERVER_CONSUMER
      || terminal.outcome !== "refused"
      || terminal.failureStage !== "pre-observation"
    ) {
      throw new NativeObserverContractError("terminal", "pre-observation refusal differs from the exact contract");
    }
    return terminal as unknown as PreObservationRefusalV1;
  }
  exactKeys(
    terminal,
    ["schema", "version", "consumer", "operation", "requestId", "requestSha256", "outcome", "failureStage", "effectState"],
    "$terminal",
  );
  if (
    terminal.schema !== NATIVE_OBSERVER_TERMINAL_SCHEMA
    || terminal.version !== NATIVE_OBSERVER_VERSION
    || terminal.consumer !== NATIVE_OBSERVER_CONSUMER
  ) {
    throw new NativeObserverContractError("terminal", "correlated terminal authority differs");
  }
  return makeCorrelatedTerminal(
    requireString(terminal.operation, "$terminal.operation"),
    requireString(terminal.requestId, "$terminal.requestId"),
    requireString(terminal.requestSha256, "$terminal.requestSha256"),
    requireString(terminal.outcome, "$terminal.outcome"),
    requireString(terminal.failureStage, "$terminal.failureStage"),
    requireString(terminal.effectState, "$terminal.effectState"),
  );
}

export function encodeObserverSuccessFrame(observation: unknown, acknowledgment: unknown): Buffer {
  const observationBytes = Buffer.from(canonicalizeObserverJson(observation), "utf8");
  const acknowledgmentBytes = Buffer.from(canonicalizeObserverJson(acknowledgment), "utf8");
  if (observationBytes.byteLength > 1_048_576 || acknowledgmentBytes.byteLength > 65_536) {
    throw new NativeObserverContractError("frame-cap", "success frame member exceeds its cap");
  }
  const frame = Buffer.concat([observationBytes, Buffer.from([0x0a]), acknowledgmentBytes]);
  if (frame.byteLength > 1_114_113) {
    throw new NativeObserverContractError("frame-cap", "success frame exceeds its exact cap");
  }
  return frame;
}

export function encodeObserverTerminalFrame(terminal: unknown): Buffer {
  validateTerminal(terminal);
  const bytes = Buffer.from(canonicalizeObserverJson(terminal), "utf8");
  if (bytes.byteLength > 65_536) throw new NativeObserverContractError("frame-cap", "terminal exceeds its cap");
  return bytes;
}

export interface FileIdentityV1 {
  volumeSerialNumber: string;
  fileId: string;
  size: string;
  lastWriteTime: string;
  fileAttributes: string;
  finalPath: string;
}

function canonicalDecimalU64(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= 0xffff_ffff_ffff_ffffn && parsed.toString() === value;
  } catch {
    return false;
  }
}

export function validateIdentity(value: unknown): FileIdentityV1 {
  const identity = asRecord(value, "$identity");
  exactKeys(
    identity,
    ["volumeSerialNumber", "fileId", "size", "lastWriteTime", "fileAttributes", "finalPath"],
    "$identity",
  );
  const result = {
    volumeSerialNumber: requireString(identity.volumeSerialNumber, "$identity.volumeSerialNumber"),
    fileId: requireString(identity.fileId, "$identity.fileId"),
    size: requireString(identity.size, "$identity.size"),
    lastWriteTime: requireString(identity.lastWriteTime, "$identity.lastWriteTime"),
    fileAttributes: requireString(identity.fileAttributes, "$identity.fileAttributes"),
    finalPath: requireString(identity.finalPath, "$identity.finalPath"),
  };
  if (
    !/^[0-9a-f]{16}$/u.test(result.volumeSerialNumber)
    || !/^[0-9a-f]{32}$/u.test(result.fileId)
    || !canonicalDecimalU64(result.size)
    || !canonicalDecimalU64(result.lastWriteTime)
    || !/^[0-9a-f]{8}$/u.test(result.fileAttributes)
  ) {
    throw new NativeObserverContractError("identity", "identity scalar grammar differs");
  }
  trustedFinalComponents(result.finalPath);
  return result;
}

function exactUtf16Equal(left: string, right: string): boolean {
  return Buffer.from(left, "utf16le").equals(Buffer.from(right, "utf16le"));
}

export function validateExactTargetFinalPath(targetPath: string, identity: FileIdentityV1): void {
  const expected = `\\\\?\\${targetPath}`;
  trustedFinalComponents(expected);
  if (!exactUtf16Equal(expected, identity.finalPath)) {
    throw new NativeObserverContractError(
      "target-final-path",
      "handle-derived final path is not byte-identical UTF-16 to the exact requested target",
    );
  }
}

export function validateNoReparseTag(tag: number | null): void {
  if (tag !== null) throw new NativeObserverContractError("reparse", "every reparse tag is refused");
}

export function validateReadProgress(expected: number, chunks: readonly number[]): void {
  let total = 0;
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk > 65_536) {
      throw new NativeObserverContractError("read-drift", "read count is invalid");
    }
    if (chunk === 0 && total < expected) {
      throw new NativeObserverContractError("read-incomplete", "zero progress before exact length");
    }
    total += chunk;
    if (total > expected) throw new NativeObserverContractError("read-drift", "read exceeded identity size");
  }
  if (total !== expected) throw new NativeObserverContractError("read-incomplete", "read ended before exact length");
}

export function completeReadProof(
  rootFinalPath: string,
  identityBefore: FileIdentityV1,
  identityAfter: FileIdentityV1,
  content: Uint8Array,
): { contentBase64: string; contentSha256: string } {
  const containment = validateFinalContainment(rootFinalPath, identityBefore.finalPath);
  if (containment === "non-identical") {
    throw new NativeObserverContractError("non-identical", "final path components are not byte-identical UTF-16");
  }
  if (containment !== "contained") {
    throw new NativeObserverContractError("read-drift", "final path is outside the trusted root");
  }
  if (
    (Number.parseInt(identityBefore.fileAttributes, 16) & 0x10) !== 0
    || (Number.parseInt(identityAfter.fileAttributes, 16) & 0x10) !== 0
  ) {
    throw new NativeObserverContractError("read-drift", "directory identity is not an admitted bound file");
  }
  if (canonicalizeObserverJson(identityBefore) !== canonicalizeObserverJson(identityAfter)) {
    throw new NativeObserverContractError("read-drift", "before and after identities differ");
  }
  if (BigInt(identityBefore.size) !== BigInt(content.byteLength) || content.byteLength > 262_144) {
    throw new NativeObserverContractError("read-drift", "identity size differs from bounded content");
  }
  return { contentBase64: Buffer.from(content).toString("base64"), contentSha256: sha256Hex(content) };
}

export interface CreateTraceV1 {
  dispatch: "collision" | "invalid-noncollision" | "ambiguous-no-handle" | "valid-handle";
  writeRequests: number[];
  writeReturned: number | null;
  flush: boolean;
  sizeProof: boolean;
  rewind: boolean;
  sameHandleReadback: boolean;
  releaseOriginal: boolean;
  reopen: boolean;
  reopenedIdentity: boolean;
  reopenedReadback: boolean;
  releaseReopened: boolean;
  acknowledgment: boolean;
  releaseRootAncestors: boolean;
}

function createTraceBase(dispatch: CreateTraceV1["dispatch"]): CreateTraceV1 {
  return {
    dispatch,
    writeRequests: [],
    writeReturned: null,
    flush: false,
    sizeProof: false,
    rewind: false,
    sameHandleReadback: false,
    releaseOriginal: false,
    reopen: false,
    reopenedIdentity: false,
    reopenedReadback: false,
    releaseReopened: false,
    acknowledgment: false,
    releaseRootAncestors: true,
  };
}

export const createTrace = Object.freeze({
  nonemptySuccess(contentLength: number): CreateTraceV1 {
    return {
      ...createTraceBase("valid-handle"),
      writeRequests: [contentLength],
      writeReturned: contentLength,
      flush: true,
      sizeProof: true,
      rewind: true,
      sameHandleReadback: true,
      releaseOriginal: true,
      reopen: true,
      reopenedIdentity: true,
      reopenedReadback: true,
      releaseReopened: true,
      acknowledgment: true,
    };
  },
  zeroValidHandle(): CreateTraceV1 {
    return { ...createTraceBase("valid-handle"), writeRequests: [0], writeReturned: 0, releaseOriginal: true };
  },
  zeroAmbiguityNoHandle(): CreateTraceV1 {
    return createTraceBase("ambiguous-no-handle");
  },
  collision(): CreateTraceV1 {
    return createTraceBase("collision");
  },
});

function noPostCreateProofActions(trace: CreateTraceV1): boolean {
  return !trace.flush
    && !trace.sizeProof
    && !trace.rewind
    && !trace.sameHandleReadback
    && !trace.reopen
    && !trace.reopenedIdentity
    && !trace.reopenedReadback
    && !trace.releaseReopened
    && !trace.acknowledgment;
}

export function classifyCreateTrace(
  content: Uint8Array,
  trace: CreateTraceV1,
): "known" | "refused-collision" | "refused-pre-effect" | "unknown-post-create" | "invalid-trace" {
  if (trace.dispatch === "collision" || trace.dispatch === "invalid-noncollision") {
    const valid = trace.writeRequests.length === 0
      && !trace.releaseOriginal
      && trace.releaseRootAncestors
      && noPostCreateProofActions(trace);
    if (!valid) return "invalid-trace";
    return trace.dispatch === "collision" ? "refused-collision" : "refused-pre-effect";
  }
  if (trace.dispatch === "ambiguous-no-handle") {
    return trace.writeRequests.length === 0
      && !trace.releaseOriginal
      && trace.releaseRootAncestors
      && noPostCreateProofActions(trace)
      ? "unknown-post-create"
      : "invalid-trace";
  }
  if (content.byteLength === 0) {
    return trace.writeRequests.length === 1
      && trace.writeRequests[0] === 0
      && trace.releaseOriginal
      && trace.releaseRootAncestors
      && noPostCreateProofActions(trace)
      ? "unknown-post-create"
      : "invalid-trace";
  }
  return trace.writeRequests.length === 1
    && trace.writeRequests[0] === content.byteLength
    && trace.writeReturned === content.byteLength
    && trace.flush
    && trace.sizeProof
    && trace.rewind
    && trace.sameHandleReadback
    && trace.releaseOriginal
    && trace.reopen
    && trace.reopenedIdentity
    && trace.reopenedReadback
    && trace.releaseReopened
    && trace.acknowledgment
    && trace.releaseRootAncestors
    ? "known"
    : "unknown-post-create";
}

export interface PrivateObserverDeadlineContextV1 {
  readonly aggregateDeadlineMonotonicMs: number;
  readonly operationDeadlineMonotonicMs: number;
}

export function createDeadlineContext(
  aggregateStartMonotonicMs: number,
  operationStartMonotonicMs: number,
): PrivateObserverDeadlineContextV1 {
  if (
    !Number.isSafeInteger(aggregateStartMonotonicMs)
    || aggregateStartMonotonicMs < 0
    || !Number.isSafeInteger(operationStartMonotonicMs)
    || operationStartMonotonicMs < 0
  ) {
    throw new NativeObserverContractError("deadline", "monotonic starts must be nonnegative safe integers");
  }
  const aggregateDeadlineMonotonicMs = aggregateStartMonotonicMs + 15_000;
  const operationDeadlineMonotonicMs = operationStartMonotonicMs + 10_000;
  if (!Number.isSafeInteger(aggregateDeadlineMonotonicMs) || !Number.isSafeInteger(operationDeadlineMonotonicMs)) {
    throw new NativeObserverContractError("deadline", "deadline overflow");
  }
  return Object.freeze({ aggregateDeadlineMonotonicMs, operationDeadlineMonotonicMs });
}

export function deadlineReached(context: PrivateObserverDeadlineContextV1, nowMonotonicMs: number): boolean {
  if (!Number.isSafeInteger(nowMonotonicMs) || nowMonotonicMs < 0) {
    throw new NativeObserverContractError("deadline", "deadline comparison requires a nonnegative safe integer");
  }
  return nowMonotonicMs >= Math.min(
    context.aggregateDeadlineMonotonicMs,
    context.operationDeadlineMonotonicMs,
  );
}

export class TerminationRequestLatch {
  private requested = false;
  private readonly resolveRequested: () => void;
  readonly terminationRequested: Promise<void>;

  constructor() {
    let resolveRequested!: () => void;
    this.terminationRequested = new Promise<void>((resolve) => {
      resolveRequested = resolve;
    });
    this.resolveRequested = resolveRequested;
  }

  request(): void {
    if (this.requested) {
      throw new NativeObserverContractError("termination", "termination request already issued");
    }
    this.requested = true;
    this.resolveRequested();
  }
}

const HANDLE_KINDS = new Set(["root", "existing-ancestor", "read-target", "created-original", "reopened-target"]);

export class HandleLedger {
  private readonly owned = new Set<string>();

  acquire(kind: string): void {
    if (!HANDLE_KINDS.has(kind) || this.owned.has(kind)) {
      throw new NativeObserverContractError("handle-owned", "unknown or already-owned handle kind");
    }
    this.owned.add(kind);
  }

  close(kind: string): void {
    if (!this.owned.delete(kind)) {
      throw new NativeObserverContractError("handle-closed", "handle is not owned or was already closed");
    }
  }

  allReleased(): boolean {
    return this.owned.size === 0;
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalizeObserverJson(value: unknown): string {
  return canonicalize(value, "$", new Set<object>());
}

function canonicalize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    rejectControlScalars(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new NativeObserverContractError("non-canonical-number", `${path} must be a safe integer other than -0`);
    }
    return String(value);
  }
  if (typeof value !== "object") {
    throw new NativeObserverContractError("non-json-value", `${path} is not JSON`);
  }
  if (seen.has(value)) throw new NativeObserverContractError("cyclic-json", `${path} is cyclic`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => canonicalize(entry, `${path}[${index}]`, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new NativeObserverContractError("non-plain-object", `${path} must be a plain object`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    return `{${keys.map((key) => `${canonicalize(key, `${path}.<key>`, seen)}:${canonicalize(record[key], `${path}.${key}`, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

class StrictJsonParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): ObserverJsonValue {
    const value = this.parseValue();
    if (this.index !== this.source.length) this.fail("trailing JSON data");
    return value;
  }

  private parseValue(): ObserverJsonValue {
    const token = this.source[this.index];
    if (token === '"') return this.parseString();
    if (token === "{") return this.parseObject();
    if (token === "[") return this.parseArray();
    if (token === "t") return this.parseLiteral("true", true);
    if (token === "f") return this.parseLiteral("false", false);
    if (token === "n") return this.parseLiteral("null", null);
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) return this.parseInteger();
    this.fail("unexpected JSON token");
  }

  private parseString(): string {
    this.index += 1;
    let result = "";
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      this.index += 1;
      if (character === '"') {
        rejectControlScalars(result, "$json-string");
        return result;
      }
      if (character === "\\") {
        const escaped = this.source[this.index];
        this.index += 1;
        if (escaped !== '"' && escaped !== "\\") this.fail("forbidden JSON escape");
        result += escaped;
      } else {
        result += character;
      }
    }
    this.fail("unterminated JSON string");
  }

  private parseObject(): { [key: string]: ObserverJsonValue } {
    this.index += 1;
    const result: { [key: string]: ObserverJsonValue } = Object.create(null) as { [key: string]: ObserverJsonValue };
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    for (;;) {
      if (this.source[this.index] !== '"') this.fail("object key must be a string");
      const key = this.parseString();
      if (keys.has(key)) this.fail(`duplicate JSON property: ${key}`);
      keys.add(key);
      if (this.source[this.index] !== ":") this.fail("object key must be followed by colon");
      this.index += 1;
      result[key] = this.parseValue();
      const delimiter = this.source[this.index];
      this.index += 1;
      if (delimiter === "}") return result;
      if (delimiter !== ",") this.fail("object entry must end with comma or brace");
    }
  }

  private parseArray(): ObserverJsonValue[] {
    this.index += 1;
    const result: ObserverJsonValue[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue());
      const delimiter = this.source[this.index];
      this.index += 1;
      if (delimiter === "]") return result;
      if (delimiter !== ",") this.fail("array entry must end with comma or bracket");
    }
  }

  private parseLiteral<T extends boolean | null>(token: string, value: T): T {
    if (this.source.slice(this.index, this.index + token.length) !== token) this.fail(`invalid ${token} literal`);
    this.index += token.length;
    return value;
  }

  private parseInteger(): number {
    const remainder = this.source.slice(this.index);
    const match = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)/u.exec(remainder);
    if (match === null) this.fail("invalid canonical integer");
    const end = this.index + match[0].length;
    const following = this.source[end];
    if (following !== undefined && !",]}".includes(following)) this.fail("fraction, exponent, sign, or leading zero is forbidden");
    const integer = BigInt(match[0]);
    if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.fail("integer exceeds the safe range");
    }
    this.index = end;
    return Number(integer);
  }

  private fail(message: string): never {
    throw new NativeObserverContractError("strict-json", `${message} at UTF-16 offset ${this.index}`);
  }
}

function rejectControlScalars(value: string, path: string): void {
  for (const character of value) {
    const scalar = character.codePointAt(0) as number;
    if ((scalar >= 0 && scalar <= 0x1f) || (scalar >= 0x7f && scalar <= 0x9f)) {
      throw new NativeObserverContractError("control-scalar", `${path} contains U+${scalar.toString(16).padStart(4, "0")}`);
    }
  }
}

function decodeFatalUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new NativeObserverContractError("utf8-bom", "UTF-8 BOM is forbidden");
    }
    return text;
  } catch (error) {
    if (error instanceof NativeObserverContractError) throw error;
    throw new NativeObserverContractError("invalid-utf8", "input is not strict UTF-8");
  }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(record).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new NativeObserverContractError("property-set", `${path} has a non-exact property set`);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new NativeObserverContractError("object", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new NativeObserverContractError("string", `${path} must be a string`);
  return value;
}

export function parseCanonicalObserverJsonBytes(bytes: Uint8Array): ObserverJsonValue {
  if (bytes.byteLength === 0) throw new NativeObserverContractError("empty", "canonical JSON cannot be empty");
  const text = decodeFatalUtf8(bytes);
  const value = new StrictJsonParser(text).parse();
  if (canonicalizeObserverJson(value) !== text) {
    throw new NativeObserverContractError("non-canonical", "input differs from canonical JSON encoding");
  }
  return value;
}

export function parseCanonicalObserverRequestBytes(bytes: Uint8Array): NativeObserverRequestV1 {
  if (bytes.byteLength > 393_216) {
    throw new NativeObserverContractError("request-cap", "request exceeds the global byte cap before parsing");
  }
  const request = asRecord(parseCanonicalObserverJsonBytes(bytes), "$request");
  const operation = requireString(request.operation, "$request.operation");
  const expected = operation === "read-bound-file"
    ? ["schema", "version", "consumer", "operation", "requestId", "rootPath", "targetPath"]
    : operation === "create-new-durable-file"
      ? ["schema", "version", "consumer", "operation", "requestId", "rootPath", "targetPath", "contentBase64"]
      : undefined;
  if (expected === undefined) throw new NativeObserverContractError("operation", "operation is not admitted");
  exactKeys(request, expected, "$request");
  if (request.schema !== NATIVE_OBSERVER_REQUEST_SCHEMA || request.version !== NATIVE_OBSERVER_VERSION || request.consumer !== NATIVE_OBSERVER_CONSUMER) {
    throw new NativeObserverContractError("authority", "request authority literals differ");
  }
  for (const key of expected) requireString(request[key], `$request.${key}`);
  const maximum = operation === "read-bound-file" ? 65_536 : 393_216;
  if (bytes.byteLength > maximum || !validateRequestId(requireString(request.requestId, "$request.requestId"))) {
    throw new NativeObserverContractError("request", "request cap or uppercase UUID-v4 requestId differs");
  }
  validateInputPathPair(
    requireString(request.rootPath, "$request.rootPath"),
    requireString(request.targetPath, "$request.targetPath"),
  );
  if (operation === "create-new-durable-file") {
    decodeCanonicalBase64(requireString(request.contentBase64, "$request.contentBase64"), 262_144);
  }
  return request as unknown as NativeObserverRequestV1;
}

export interface AcceptedNativeObserverBindingV1 {
  readonly observerAbsolutePath: string;
  readonly observerSha256: string;
  readonly evidenceRootAbsolutePath: string;
}

export interface NativeObserverInvocationInputV1 {
  readonly canonicalRequestBytes: Uint8Array;
  readonly acceptedBinding: AcceptedNativeObserverBindingV1;
  readonly deadlineContext: PrivateObserverDeadlineContextV1;
}

export type InvocationExitStateV1 =
  | { kind: "not-started" }
  | { kind: "known"; code: number }
  | { kind: "unknown" };

interface InvocationEvidenceCommonV1 {
  invocationAttemptCount: 1;
  evidenceRootAbsolutePath: string;
  capturedStdoutBytes: Uint8Array;
  capturedStderrBytes: Uint8Array;
}

export type InvocationEvidenceV1 =
  | (InvocationEvidenceCommonV1 & {
    kind: "child-never-started";
    childStarted: false;
    stdoutState: "not-opened";
    stderrState: "not-opened";
    streamClosureState: "not-opened";
    exitState: { kind: "not-started" };
  })
  | (InvocationEvidenceCommonV1 & {
    kind: "child-started";
    childStarted: true;
    stdoutState: "eof" | "not-eof-or-unknown" | "cap-exceeded-or-truncated";
    stderrState: "eof-zero-bytes" | "nonzero-byte-seen" | "not-eof-or-unknown";
    streamClosureState: "both-eof" | "incomplete-or-unknown";
    exitState: { kind: "known"; code: number } | { kind: "unknown" };
  })
  | (InvocationEvidenceCommonV1 & {
    kind: "child-start-ambiguous";
    childStarted: "unknown";
    stdoutState: "not-opened" | "eof" | "not-eof-or-unknown" | "cap-exceeded-or-truncated";
    stderrState: "not-opened" | "eof-zero-bytes" | "nonzero-byte-seen" | "not-eof-or-unknown";
    streamClosureState: "not-opened" | "both-eof" | "incomplete-or-unknown";
    exitState: InvocationExitStateV1;
  });

export interface Phase3NativeObserverTransportV1 {
  invoke(input: NativeObserverInvocationInputV1): Promise<InvocationEvidenceV1>;
}

export interface ReadBoundFileObservationV1 {
  schema: typeof NATIVE_OBSERVER_OBSERVATION_SCHEMA;
  version: typeof NATIVE_OBSERVER_VERSION;
  consumer: typeof NATIVE_OBSERVER_CONSUMER;
  operation: "read-bound-file";
  requestId: string;
  requestSha256: string;
  identityBefore: FileIdentityV1;
  identityAfter: FileIdentityV1;
  contentBase64: string;
  contentSha256: string;
}

export interface CreateNewDurableFileObservationV1 {
  schema: typeof NATIVE_OBSERVER_OBSERVATION_SCHEMA;
  version: typeof NATIVE_OBSERVER_VERSION;
  consumer: typeof NATIVE_OBSERVER_CONSUMER;
  operation: "create-new-durable-file";
  requestId: string;
  requestSha256: string;
  creationDisposition: "CREATE_NEW";
  creationFlags: ["FILE_ATTRIBUTE_NORMAL", "FILE_FLAG_WRITE_THROUGH", "FILE_FLAG_OPEN_REPARSE_POINT"];
  createdIdentity: FileIdentityV1;
  flushFileBuffersSucceeded: true;
  sameHandleReadbackSha256: string;
  reopenedIdentity: FileIdentityV1;
  reopenedReadbackSha256: string;
}

export interface NativeObserverAcknowledgmentV1 {
  schema: typeof NATIVE_OBSERVER_ACKNOWLEDGMENT_SCHEMA;
  version: typeof NATIVE_OBSERVER_VERSION;
  consumer: typeof NATIVE_OBSERVER_CONSUMER;
  operation: "read-bound-file" | "create-new-durable-file";
  requestId: string;
  requestSha256: string;
  observationUtf8Bytes: number;
  observationSha256: string;
  outcome: "known";
}

type ReadBoundFileAcknowledgmentV1 = NativeObserverAcknowledgmentV1 & {
  operation: "read-bound-file";
};
type CreateNewDurableFileAcknowledgmentV1 = NativeObserverAcknowledgmentV1 & {
  operation: "create-new-durable-file";
};

type KnownReadResultV1 = {
  outcome: "known";
  observation: ReadBoundFileObservationV1;
  acknowledgment: ReadBoundFileAcknowledgmentV1;
};
type KnownCreateResultV1 = {
  outcome: "known";
  observation: CreateNewDurableFileObservationV1;
  acknowledgment: CreateNewDurableFileAcknowledgmentV1;
};

type RefusedReadResultV1 = {
  outcome: "refused";
  terminal: PreObservationRefusalV1 | ReadRefusedTerminalV1;
  invocationAttemptCount: 0 | 1;
  childStarted: false | true;
};
type RefusedCreateResultV1 = {
  outcome: "refused";
  terminal: PreObservationRefusalV1 | CreateRefusedTerminalV1;
  invocationAttemptCount: 0 | 1;
  childStarted: false | true;
};
type UnknownReadResultV1 = {
  outcome: "unknown";
  terminal: ReadUnknownTerminalV1;
  invocationAttemptCount: 0 | 1;
  childStarted: false | true | "unknown";
};
type UnknownCreateResultV1 = {
  outcome: "unknown";
  terminal: CreateUnknownTerminalV1;
  invocationAttemptCount: 0 | 1;
  childStarted: false | true | "unknown";
};

export type ReadBoundFileResultV1 = KnownReadResultV1 | RefusedReadResultV1 | UnknownReadResultV1;
export type CreateNewDurableFileResultV1 = KnownCreateResultV1 | RefusedCreateResultV1 | UnknownCreateResultV1;

export interface Phase3NativeObserverV1 {
  readExactBoundFile(request: ReadBoundFileRequestV1): Promise<ReadBoundFileResultV1>;
  createNewDurableFile(request: CreateNewDurableFileRequestV1): Promise<CreateNewDurableFileResultV1>;
}

function validateBinding(value: AcceptedNativeObserverBindingV1): AcceptedNativeObserverBindingV1 {
  const binding = asRecord(value, "$acceptedBinding");
  exactKeys(binding, ["observerAbsolutePath", "observerSha256", "evidenceRootAbsolutePath"], "$acceptedBinding");
  const observerAbsolutePath = requireString(binding.observerAbsolutePath, "$acceptedBinding.observerAbsolutePath");
  const observerSha256 = requireString(binding.observerSha256, "$acceptedBinding.observerSha256");
  const evidenceRootAbsolutePath = requireString(binding.evidenceRootAbsolutePath, "$acceptedBinding.evidenceRootAbsolutePath");
  validateInputPathPair(`${observerAbsolutePath.slice(0, 3)}`, observerAbsolutePath);
  validateInputPathPair(`${evidenceRootAbsolutePath.slice(0, 3)}`, evidenceRootAbsolutePath);
  if (!validateSha256(observerSha256)) {
    throw new NativeObserverContractError("binding", "observer SHA-256 differs from the exact grammar");
  }
  return Object.freeze({ observerAbsolutePath, observerSha256, evidenceRootAbsolutePath });
}

interface DerivedTypedRequestV1 {
  canonicalRequestBytes: Buffer;
  requestSnapshot: NativeObserverRequestV1;
  requestSha256: string;
}

function snapshotTypedRequestForCanonicalization(value: unknown): Record<string, ObserverJsonValue> {
  const seen = new Set<object>();
  let nodeCount = 0;
  let stringBytes = 0;

  function capture(candidate: unknown, path: string, depth: number): ObserverJsonValue {
    nodeCount += 1;
    if (nodeCount > 4_096 || depth > 32) {
      throw new NativeObserverContractError("request-cap", "typed request structure exceeds its bounded snapshot cap");
    }
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate) || Object.is(candidate, -0)) {
        throw new NativeObserverContractError("request-cap", `${path} is not a canonical safe integer`);
      }
      return candidate;
    }
    if (typeof candidate === "string") {
      const bytes = Buffer.byteLength(candidate, "utf8");
      if (bytes > 393_216 || stringBytes + bytes > 393_216) {
        throw new NativeObserverContractError("request-cap", "typed request strings exceed the global snapshot cap");
      }
      stringBytes += bytes;
      rejectControlScalars(candidate, path);
      return candidate;
    }
    if (candidate === null || typeof candidate !== "object") {
      throw new NativeObserverContractError("request-cap", `${path} is not a bounded canonical JSON value`);
    }
    if (seen.has(candidate)) {
      throw new NativeObserverContractError("request-cap", "typed request is cyclic");
    }
    seen.add(candidate);
    try {
      const symbols = Object.getOwnPropertySymbols(candidate);
      if (symbols.length !== 0) {
        throw new NativeObserverContractError("request-cap", `${path} has symbol properties`);
      }
      const prototype = Object.getPrototypeOf(candidate);
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      if (Array.isArray(candidate)) {
        if (prototype !== Array.prototype) {
          throw new NativeObserverContractError("request-cap", `${path} is not a plain dense array`);
        }
        const lengthDescriptor = descriptors.length;
        const length = lengthDescriptor?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 4_096) {
          throw new NativeObserverContractError("request-cap", `${path} array length exceeds its cap`);
        }
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        if (keys.length !== length) {
          throw new NativeObserverContractError("request-cap", `${path} must be a dense array without extra properties`);
        }
        const snapshot: ObserverJsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
            throw new NativeObserverContractError("request-cap", `${path} contains an accessor or sparse entry`);
          }
          snapshot.push(capture(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        return snapshot;
      }
      if (prototype !== Object.prototype && prototype !== null) {
        throw new NativeObserverContractError("request-cap", `${path} is not a plain object`);
      }
      const keys = Object.keys(descriptors);
      const maximumProperties = depth === 0 ? 9 : 256;
      if (keys.length > maximumProperties) {
        throw new NativeObserverContractError("request-cap", `${path} has too many properties`);
      }
      const snapshot: Record<string, ObserverJsonValue> = Object.create(null) as Record<string, ObserverJsonValue>;
      for (const key of keys) {
        if (Buffer.byteLength(key, "utf8") > 64) {
          throw new NativeObserverContractError("request-cap", `${path} has an oversized property name`);
        }
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || descriptor.enumerable !== true) {
          throw new NativeObserverContractError("request-cap", `${path}.${key} is an accessor or non-enumerable property`);
        }
        snapshot[key] = capture(descriptor.value, `${path}.${key}`, depth + 1);
      }
      return snapshot;
    } finally {
      seen.delete(candidate);
    }
  }

  const snapshot = capture(value, "$request", 0);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new NativeObserverContractError("request-cap", "typed request root is not a plain object");
  }
  return snapshot;
}

function deriveTypedRequestCorrelation(
  request: NativeObserverRequestV1,
): DerivedTypedRequestV1 {
  const record = snapshotTypedRequestForCanonicalization(request);
  const operation = requireString(record.operation, "$request.operation");
  const requestId = requireString(record.requestId, "$request.requestId");
  if (
    (operation !== "read-bound-file" && operation !== "create-new-durable-file")
    || !validateRequestId(requestId)
  ) {
    throw new NativeObserverContractError("request-correlation", "literal operation or requestId cannot be derived");
  }
  const bytes = Buffer.from(canonicalizeObserverJson(record), "utf8");
  if (bytes.byteLength > 393_216) {
    throw new NativeObserverContractError("request-cap", "typed request exceeds the global canonical byte cap");
  }
  const requestSnapshot = Object.freeze(
    parseCanonicalObserverJsonBytes(bytes),
  ) as unknown as NativeObserverRequestV1;
  return {
    canonicalRequestBytes: bytes,
    requestSnapshot,
    requestSha256: sha256Hex(bytes),
  };
}

function validateDerivedTypedRequest(
  derived: DerivedTypedRequestV1,
  expectedOperation: NativeObserverRequestV1["operation"],
): void {
  const { canonicalRequestBytes: bytes, requestSnapshot: request } = derived;
  const validated = parseCanonicalObserverRequestBytes(bytes);
  if (validated.operation !== expectedOperation || validated.operation !== request.operation) {
    throw new NativeObserverContractError("request-operation", "request operation differs from the invoked method");
  }
}

function validateEvidence(
  value: InvocationEvidenceV1,
  acceptedBinding: AcceptedNativeObserverBindingV1,
): InvocationEvidenceV1 {
  const evidence = asRecord(value, "$evidence");
  exactKeys(
    evidence,
    ["kind", "invocationAttemptCount", "evidenceRootAbsolutePath", "childStarted", "capturedStdoutBytes", "capturedStderrBytes", "stdoutState", "stderrState", "streamClosureState", "exitState"],
    "$evidence",
  );
  if (
    evidence.invocationAttemptCount !== 1
    || evidence.evidenceRootAbsolutePath !== acceptedBinding.evidenceRootAbsolutePath
    || !(evidence.capturedStdoutBytes instanceof Uint8Array)
    || !(evidence.capturedStderrBytes instanceof Uint8Array)
  ) {
    throw new NativeObserverContractError("evidence", "invocation count or captured byte types differ");
  }
  const typed = value;
  if (!new Set(["child-never-started", "child-started", "child-start-ambiguous"]).has(typed.kind)) {
    throw new NativeObserverContractError("evidence-kind", "evidence kind is outside the exact domain");
  }
  if (typed.capturedStdoutBytes.byteLength > 1_114_113 || typed.capturedStderrBytes.byteLength !== 0) {
    throw new NativeObserverContractError("evidence-cap", "captured streams differ from exact caps");
  }
  const exit = asRecord(typed.exitState, "$evidence.exitState");
  if (typed.exitState.kind === "known") {
    exactKeys(exit, ["kind", "code"], "$evidence.exitState");
    if (!Number.isInteger(typed.exitState.code) || typed.exitState.code < -2_147_483_648 || typed.exitState.code > 2_147_483_647) {
      throw new NativeObserverContractError("exit", "known exit code is outside signed 32-bit range");
    }
  } else {
    exactKeys(exit, ["kind"], "$evidence.exitState");
  }
  if (typed.kind === "child-never-started") {
    if (
      typed.childStarted !== false
      || typed.capturedStdoutBytes.byteLength !== 0
      || typed.stdoutState !== "not-opened"
      || typed.stderrState !== "not-opened"
      || typed.streamClosureState !== "not-opened"
      || typed.exitState.kind !== "not-started"
    ) {
      throw new NativeObserverContractError("evidence-branch", "child-never-started evidence is inconsistent");
    }
  } else if (typed.kind === "child-started") {
    if (
      typed.childStarted !== true
      || !new Set(["eof", "not-eof-or-unknown", "cap-exceeded-or-truncated"]).has(typed.stdoutState)
      || !new Set(["eof-zero-bytes", "nonzero-byte-seen", "not-eof-or-unknown"]).has(typed.stderrState)
      || !new Set(["both-eof", "incomplete-or-unknown"]).has(typed.streamClosureState)
      || !new Set(["known", "unknown"]).has(typed.exitState.kind)
    ) {
      throw new NativeObserverContractError("evidence-branch", "child-started evidence is outside its exact domain");
    }
    if (
      typed.capturedStderrBytes.byteLength !== 0
      || (typed.streamClosureState === "both-eof"
        && (typed.stdoutState !== "eof" || typed.stderrState !== "eof-zero-bytes"))
    ) {
      throw new NativeObserverContractError("evidence-closure", "started stream states contradict captured bytes or EOF closure");
    }
  } else if (
    typed.childStarted !== "unknown"
    || !new Set(["not-opened", "eof", "not-eof-or-unknown", "cap-exceeded-or-truncated"]).has(typed.stdoutState)
    || !new Set(["not-opened", "eof-zero-bytes", "nonzero-byte-seen", "not-eof-or-unknown"]).has(typed.stderrState)
    || !new Set(["not-opened", "both-eof", "incomplete-or-unknown"]).has(typed.streamClosureState)
    || !new Set(["not-started", "known", "unknown"]).has(typed.exitState.kind)
  ) {
    throw new NativeObserverContractError("evidence-branch", "child-start-ambiguous evidence is outside its exact domain");
  }
  return typed;
}

function unknownResult(
  request: NativeObserverRequestV1,
  requestSha256: string,
  invocationAttemptCount: 0 | 1,
  childStarted: false | true | "unknown",
  beforeEffect = false,
): UnknownReadResultV1 | UnknownCreateResultV1 {
  const [failureStage, effectState] = beforeEffect
    ? ["pre-effect", "none"] as const
    : request.operation === "read-bound-file"
      ? ["read-observation", "none"] as const
      : ["post-create", "possibly-created"] as const;
  return {
    outcome: "unknown",
    terminal: makeCorrelatedTerminal(
      request.operation,
      request.requestId,
      requestSha256,
      "unknown",
      failureStage,
      effectState,
    ),
    invocationAttemptCount,
    childStarted,
  } as UnknownReadResultV1 | UnknownCreateResultV1;
}

function refusedPreEffectResult(
  request: NativeObserverRequestV1,
  requestSha256: string,
): RefusedReadResultV1 | RefusedCreateResultV1 {
  return {
    outcome: "refused",
    terminal: makeCorrelatedTerminal(
      request.operation,
      request.requestId,
      requestSha256,
      "refused",
      "pre-effect",
      "none",
    ),
    invocationAttemptCount: 0,
    childStarted: false,
  } as RefusedReadResultV1 | RefusedCreateResultV1;
}

function validateObservation(
  value: unknown,
  request: NativeObserverRequestV1,
  requestSha256: string,
): ReadBoundFileObservationV1 | CreateNewDurableFileObservationV1 {
  const observation = asRecord(value, "$observation");
  const commonValid = observation.schema === NATIVE_OBSERVER_OBSERVATION_SCHEMA
    && observation.version === NATIVE_OBSERVER_VERSION
    && observation.consumer === NATIVE_OBSERVER_CONSUMER
    && observation.operation === request.operation
    && observation.requestId === request.requestId
    && observation.requestSha256 === requestSha256;
  if (!commonValid) throw new NativeObserverContractError("observation-correlation", "observation correlation differs");
  if (request.operation === "read-bound-file") {
    exactKeys(
      observation,
      ["schema", "version", "consumer", "operation", "requestId", "requestSha256", "identityBefore", "identityAfter", "contentBase64", "contentSha256"],
      "$observation",
    );
    const before = validateIdentity(observation.identityBefore);
    const after = validateIdentity(observation.identityAfter);
    validateExactTargetFinalPath(request.targetPath, before);
    validateExactTargetFinalPath(request.targetPath, after);
    const contentBase64 = requireString(observation.contentBase64, "$observation.contentBase64");
    const content = decodeCanonicalBase64(contentBase64, 262_144);
    const proof = completeReadProof(`\\\\?\\${request.rootPath}`, before, after, content);
    if (!validateSha256(requireString(observation.contentSha256, "$observation.contentSha256"))
      || proof.contentSha256 !== observation.contentSha256) {
      throw new NativeObserverContractError("observation-content", "read content SHA-256 differs");
    }
    return observation as unknown as ReadBoundFileObservationV1;
  }
  exactKeys(
    observation,
    ["schema", "version", "consumer", "operation", "requestId", "requestSha256", "creationDisposition", "creationFlags", "createdIdentity", "flushFileBuffersSucceeded", "sameHandleReadbackSha256", "reopenedIdentity", "reopenedReadbackSha256"],
    "$observation",
  );
  if (
    observation.creationDisposition !== "CREATE_NEW"
    || canonicalizeObserverJson(observation.creationFlags) !== canonicalizeObserverJson([
      "FILE_ATTRIBUTE_NORMAL",
      "FILE_FLAG_WRITE_THROUGH",
      "FILE_FLAG_OPEN_REPARSE_POINT",
    ])
    || observation.flushFileBuffersSucceeded !== true
  ) {
    throw new NativeObserverContractError("observation-create", "creation disposition, flags, or flush proof differs");
  }
  const created = validateIdentity(observation.createdIdentity);
  const reopened = validateIdentity(observation.reopenedIdentity);
  validateExactTargetFinalPath(request.targetPath, created);
  validateExactTargetFinalPath(request.targetPath, reopened);
  const content = decodeCanonicalBase64(request.contentBase64, 262_144);
  const contentSha256 = sha256Hex(content);
  if (
    content.byteLength === 0
    || (Number.parseInt(created.fileAttributes, 16) & 0x10) !== 0
    || (Number.parseInt(reopened.fileAttributes, 16) & 0x10) !== 0
    || canonicalizeObserverJson(created) !== canonicalizeObserverJson(reopened)
    || BigInt(created.size) !== BigInt(content.byteLength)
    || !validateSha256(requireString(observation.sameHandleReadbackSha256, "$observation.sameHandleReadbackSha256"))
    || !validateSha256(requireString(observation.reopenedReadbackSha256, "$observation.reopenedReadbackSha256"))
    || observation.sameHandleReadbackSha256 !== contentSha256
    || observation.reopenedReadbackSha256 !== contentSha256
  ) {
    throw new NativeObserverContractError("observation-create", "create durability correlation differs");
  }
  return observation as unknown as CreateNewDurableFileObservationV1;
}

function validateAcknowledgment(
  value: unknown,
  request: NativeObserverRequestV1,
  requestSha256: string,
  observationBytes: Uint8Array,
): NativeObserverAcknowledgmentV1 {
  const acknowledgment = asRecord(value, "$acknowledgment");
  exactKeys(
    acknowledgment,
    ["schema", "version", "consumer", "operation", "requestId", "requestSha256", "observationUtf8Bytes", "observationSha256", "outcome"],
    "$acknowledgment",
  );
  const observationUtf8Bytes = acknowledgment.observationUtf8Bytes;
  if (
    acknowledgment.schema !== NATIVE_OBSERVER_ACKNOWLEDGMENT_SCHEMA
    || acknowledgment.version !== NATIVE_OBSERVER_VERSION
    || acknowledgment.consumer !== NATIVE_OBSERVER_CONSUMER
    || acknowledgment.operation !== request.operation
    || acknowledgment.requestId !== request.requestId
    || acknowledgment.requestSha256 !== requestSha256
    || acknowledgment.outcome !== "known"
    || typeof observationUtf8Bytes !== "number"
    || !Number.isSafeInteger(observationUtf8Bytes)
    || observationUtf8Bytes < 1
    || observationUtf8Bytes > 1_048_576
    || observationUtf8Bytes !== observationBytes.byteLength
    || !validateSha256(requireString(acknowledgment.observationSha256, "$acknowledgment.observationSha256"))
    || acknowledgment.observationSha256 !== sha256Hex(observationBytes)
  ) {
    throw new NativeObserverContractError("acknowledgment", "acknowledgment binding differs");
  }
  return acknowledgment as unknown as NativeObserverAcknowledgmentV1;
}

function parseTrustedResult(
  evidence: InvocationEvidenceV1,
  request: NativeObserverRequestV1,
  requestSha256: string,
): ReadBoundFileResultV1 | CreateNewDurableFileResultV1 | null {
  if (
    evidence.kind !== "child-started"
    || evidence.childStarted !== true
    || evidence.stdoutState !== "eof"
    || evidence.stderrState !== "eof-zero-bytes"
    || evidence.streamClosureState !== "both-eof"
    || evidence.exitState.kind !== "known"
    || evidence.exitState.code !== 0
  ) {
    return null;
  }
  const stdout = Buffer.from(evidence.capturedStdoutBytes);
  const lf = stdout.indexOf(0x0a);
  if (lf < 0) {
    if (stdout.byteLength === 0 || stdout.byteLength > 65_536) return null;
    const terminal = validateTerminal(parseCanonicalObserverJsonBytes(stdout));
    if (
      terminal.schema === NATIVE_OBSERVER_PRE_OBSERVATION_REFUSAL_SCHEMA
      || terminal.operation !== request.operation
      || terminal.requestId !== request.requestId
      || terminal.requestSha256 !== requestSha256
    ) {
      return null;
    }
    return {
      outcome: terminal.outcome,
      terminal,
      invocationAttemptCount: 1,
      childStarted: true,
    } as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
  }
  if (lf === 0 || lf === stdout.byteLength - 1 || stdout.indexOf(0x0a, lf + 1) >= 0) return null;
  const observationBytes = stdout.subarray(0, lf);
  const acknowledgmentBytes = stdout.subarray(lf + 1);
  if (observationBytes.byteLength > 1_048_576 || acknowledgmentBytes.byteLength > 65_536) return null;
  const observation = validateObservation(
    parseCanonicalObserverJsonBytes(observationBytes),
    request,
    requestSha256,
  );
  const acknowledgment = validateAcknowledgment(
    parseCanonicalObserverJsonBytes(acknowledgmentBytes),
    request,
    requestSha256,
    observationBytes,
  );
  if (request.operation === "read-bound-file") {
    return {
      outcome: "known",
      observation: observation as ReadBoundFileObservationV1,
      acknowledgment: acknowledgment as ReadBoundFileAcknowledgmentV1,
    };
  }
  return {
    outcome: "known",
    observation: observation as CreateNewDurableFileObservationV1,
    acknowledgment: acknowledgment as CreateNewDurableFileAcknowledgmentV1,
  };
}

function sampleMonotonicMs(): number {
  const sampled = performance.now();
  if (!Number.isFinite(sampled) || sampled < 0) {
    throw new NativeObserverContractError("deadline", "monotonic clock sample is invalid");
  }
  const floored = Math.floor(sampled);
  if (!Number.isSafeInteger(floored)) {
    throw new NativeObserverContractError("deadline", "monotonic clock sample exceeds the safe range");
  }
  return floored;
}

export function createPhase3NativeObserverV1(
  acceptedBinding: AcceptedNativeObserverBindingV1,
  transport: Phase3NativeObserverTransportV1,
): Phase3NativeObserverV1 {
  const binding = validateBinding(acceptedBinding);
  if (transport === null || typeof transport !== "object" || typeof transport.invoke !== "function") {
    throw new NativeObserverContractError("transport", "transport must expose exactly the injected invoke port");
  }
  exactKeys(asRecord(transport, "$transport"), ["invoke"], "$transport");
  let state: "ready" | "stopped" = "ready";
  let invocationInFlight = false;

  async function invoke(
    request: NativeObserverRequestV1,
    expectedOperation: NativeObserverRequestV1["operation"],
  ): Promise<ReadBoundFileResultV1 | CreateNewDurableFileResultV1> {
    let aggregateStartMonotonicMs: number | undefined;
    try {
      aggregateStartMonotonicMs = sampleMonotonicMs();
    } catch {
      // Capture the aggregate clock before request work, then correlate if the request is safe to derive.
    }
    let derived: DerivedTypedRequestV1;
    try {
      derived = deriveTypedRequestCorrelation(request);
    } catch {
      state = "stopped";
      return {
        outcome: "refused",
        terminal: makePreObservationRefusal(),
        invocationAttemptCount: 0,
        childStarted: false,
      };
    }
    const { canonicalRequestBytes, requestSnapshot, requestSha256 } = derived;
    try {
      validateDerivedTypedRequest(derived, expectedOperation);
    } catch {
      state = "stopped";
      return refusedPreEffectResult(requestSnapshot, requestSha256);
    }
    if (state === "stopped") {
      return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    if (invocationInFlight) {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    if (aggregateStartMonotonicMs === undefined) {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    let operationStartMonotonicMs: number;
    let privateDeadlineContext: PrivateObserverDeadlineContextV1;
    try {
      operationStartMonotonicMs = sampleMonotonicMs();
      privateDeadlineContext = createDeadlineContext(aggregateStartMonotonicMs, operationStartMonotonicMs);
    } catch {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    const earliestDeadlineMonotonicMs = Math.min(
      privateDeadlineContext.aggregateDeadlineMonotonicMs,
      privateDeadlineContext.operationDeadlineMonotonicMs,
    );
    if (operationStartMonotonicMs >= earliestDeadlineMonotonicMs) {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    const transportRequestBytes = Buffer.from(canonicalRequestBytes);
    const transportInput = Object.freeze({
      canonicalRequestBytes: transportRequestBytes,
      acceptedBinding: Object.freeze({ ...binding }),
      deadlineContext: Object.freeze({ ...privateDeadlineContext }),
    });
    let evidence: InvocationEvidenceV1;
    const outerDeadlineMarker = Symbol("phase3-native-observer-outer-deadline");
    let outerDeadlineHandle: ReturnType<typeof setTimeout> | undefined;
    let outerDeadlineRemainingMs: number;
    try {
      const preDispatchMonotonicMs = sampleMonotonicMs();
      if (preDispatchMonotonicMs >= earliestDeadlineMonotonicMs) {
        state = "stopped";
        return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
      }
      const aggregateDrainDeadlineMonotonicMs = privateDeadlineContext.aggregateDeadlineMonotonicMs + 5_000;
      if (!Number.isSafeInteger(aggregateDrainDeadlineMonotonicMs)) {
        state = "stopped";
        return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
      }
      outerDeadlineRemainingMs = aggregateDrainDeadlineMonotonicMs - preDispatchMonotonicMs;
    } catch {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    if (outerDeadlineRemainingMs <= 0) {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 0, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    invocationInFlight = true;
    try {
      type TaggedSettlement =
        | { kind: "fulfilled"; evidence: InvocationEvidenceV1 }
        | { kind: "rejected" };
      let invoked: Promise<InvocationEvidenceV1>;
      try {
        invoked = transport.invoke(transportInput);
      } catch {
        invoked = Promise.reject(new Error("transport invoke threw synchronously"));
      }
      const settlement: Promise<TaggedSettlement> = Promise.resolve(invoked).then(
        (settledEvidence) => ({ kind: "fulfilled", evidence: settledEvidence }),
        () => ({ kind: "rejected" }),
      );
      const outerDeadline = new Promise<typeof outerDeadlineMarker>((resolve) => {
        outerDeadlineHandle = setTimeout(() => {
          state = "stopped";
          resolve(outerDeadlineMarker);
        }, outerDeadlineRemainingMs);
      });
      const raced = await Promise.race([settlement, outerDeadline]);
      if (raced === outerDeadlineMarker) {
        return unknownResult(
          requestSnapshot,
          requestSha256,
          1,
          "unknown",
        ) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
      }
      if (raced.kind === "rejected") {
        state = "stopped";
        return unknownResult(requestSnapshot, requestSha256, 1, "unknown") as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
      }
      evidence = validateEvidence(raced.evidence, binding);
    } catch {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 1, "unknown") as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    } finally {
      if (outerDeadlineHandle !== undefined) clearTimeout(outerDeadlineHandle);
      invocationInFlight = false;
    }
    if (evidence.kind === "child-never-started") {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 1, false, true) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    let postAwaitMonotonicMs: number;
    try {
      postAwaitMonotonicMs = sampleMonotonicMs();
    } catch {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 1, evidence.childStarted) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    if (
      (state as "ready" | "stopped") === "stopped"
      || postAwaitMonotonicMs >= earliestDeadlineMonotonicMs
      || !transportRequestBytes.equals(canonicalRequestBytes)
      || sha256Hex(transportRequestBytes) !== requestSha256
    ) {
      state = "stopped";
      return unknownResult(requestSnapshot, requestSha256, 1, evidence.childStarted) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
    }
    try {
      const trusted = parseTrustedResult(evidence, requestSnapshot, requestSha256);
      if (trusted !== null) {
        if (sampleMonotonicMs() >= earliestDeadlineMonotonicMs) {
          state = "stopped";
          return unknownResult(requestSnapshot, requestSha256, 1, evidence.childStarted) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
        }
        if (trusted.outcome !== "known") state = "stopped";
        return trusted;
      }
    } catch {
      // Malformed, truncated, misordered, or uncorrelated output is classified below.
    }
    state = "stopped";
    return unknownResult(requestSnapshot, requestSha256, 1, evidence.childStarted) as ReadBoundFileResultV1 | CreateNewDurableFileResultV1;
  }

  return {
    async readExactBoundFile(request: ReadBoundFileRequestV1): Promise<ReadBoundFileResultV1> {
      return invoke(request, "read-bound-file") as Promise<ReadBoundFileResultV1>;
    },
    async createNewDurableFile(request: CreateNewDurableFileRequestV1): Promise<CreateNewDurableFileResultV1> {
      return invoke(request, "create-new-durable-file") as Promise<CreateNewDurableFileResultV1>;
    },
  };
}
