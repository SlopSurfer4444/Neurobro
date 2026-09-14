import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalizeObserverJson,
  classifyCreateTrace,
  completeReadProof,
  createDeadlineContext,
  deadlineReached,
  createPhase3NativeObserverV1,
  createTrace,
  HandleLedger,
  decodeCanonicalBase64,
  encodeObserverSuccessFrame,
  encodeObserverTerminalFrame,
  makeCorrelatedTerminal,
  makePreObservationRefusal,
  NativeObserverContractError,
  NATIVE_OBSERVER_ACKNOWLEDGMENT_SCHEMA,
  NATIVE_OBSERVER_CONSUMER,
  NATIVE_OBSERVER_OBSERVATION_SCHEMA,
  NATIVE_OBSERVER_PRE_OBSERVATION_REFUSAL_SCHEMA,
  NATIVE_OBSERVER_REQUEST_SCHEMA,
  NATIVE_OBSERVER_TERMINAL_SCHEMA,
  NATIVE_OBSERVER_VERSION,
  parseCanonicalObserverJsonBytes,
  parseCanonicalObserverRequestBytes,
  sha256Hex,
  TerminationRequestLatch,
  validateFinalContainment,
  validateExactTargetFinalPath,
  validateInputPathPair,
  validateIdentity,
  validateNoReparseTag,
  validateReadProgress,
  validateRequestId,
  validateSha256,
  validateTerminal,
  type AcceptedNativeObserverBindingV1,
  type CreateNewDurableFileRequestV1,
  type InvocationEvidenceV1,
  type Phase3NativeObserverTransportV1,
  type ReadBoundFileRequestV1,
} from "../src/phase3-native-observer-adapter-v1.ts";

const fixtureUrl = new URL("../fixtures/phase3-native-observer-v1.json", import.meta.url);
const EVIDENCE_ROOT = "C:\\ProgramData\\DecadansNeurobro\\Phase3\\evidence\\native-observer-v1";
const GROUP_FAMILIES = [
  "canonical",
  "scalar",
  "terminal",
  "framing",
  "read-bound-file",
  "create-new-durable-file",
  "deadline-resource",
  "adapter",
] as const;

function isExactRawGroupPattern(pattern: string): boolean {
  return GROUP_FAMILIES.some((family) => pattern === `^fixture-group:${family}$`);
}

function isExactAnchoredChildPattern(pattern: string): boolean {
  return GROUP_FAMILIES.some((family) => pattern === `^fixture-group:${family}$`);
}

function parseRawGroupSelector(argv: readonly string[]): { mode: "aggregate" } | { mode: "group"; pattern: string } {
  if (argv.length === 0) return { mode: "aggregate" };
  if (argv.length !== 2 || argv[0] !== "--test-name-pattern" || !isExactRawGroupPattern(argv[1])) {
    throw new Error("raw phase3-native-observer selector must be one exact nonempty family");
  }
  return { mode: "group", pattern: argv[1] };
}

function parseProcessGroupSelector(argv: readonly string[]): { mode: "aggregate" } | { mode: "group"; pattern: string } {
  if (argv.length === 0) return { mode: "aggregate" };
  if (argv.length === 2 && argv[0] === "--test-name-pattern" && isExactAnchoredChildPattern(argv[1])) {
    return { mode: "group", pattern: argv[1] };
  }

  const [runtimeFlag, selectorFlag, pattern] = argv.slice(-3);
  const inheritedSelectorArgs = argv.slice(0, -3).filter(
    (argument) => argument === "--test-name-pattern" || argument.startsWith("--test-name-pattern="),
  );
  const normalizedPattern = typeof pattern === "string"
    ? (pattern.startsWith("^") ? pattern : `^${pattern}`)
    : "";
  if (
    runtimeFlag === "--experimental-strip-types"
    && selectorFlag === "--test-name-pattern"
    && isExactAnchoredChildPattern(normalizedPattern)
    && inheritedSelectorArgs.length === 1
    && inheritedSelectorArgs[0] === `--test-name-pattern=${pattern}`
  ) {
    return { mode: "group", pattern: normalizedPattern };
  }
  const allSelectorArgs = argv.filter(
    (argument) => argument === "--test-name-pattern" || argument.startsWith("--test-name-pattern="),
  );
  if (allSelectorArgs.length === 0) {
    return { mode: "aggregate" };
  }
  throw new Error("phase3-native-observer child selector token shape is not the exact admitted single-selector transport");
}

const processGroupSelector = parseProcessGroupSelector(process.execArgv);

function fixtureGroupPassEvidence(
  group: (typeof GROUP_FAMILIES)[number],
  selector: { mode: "aggregate" } | { mode: "group"; pattern: string },
  aggregateTerminator = false,
): string {
  if (!GROUP_FAMILIES.includes(group)) throw new Error("fixture group PASS evidence family is not admitted");
  const countMarker = selector.mode === "group"
    ? " 1-tests-passed"
    : aggregateTerminator
      ? ` ${GROUP_FAMILIES.length}-tests-passed`
      : "";
  return `fixture-group:${group}:PASS matchedTestCount=1 failedTestCount=0${countMarker}`;
}

async function fixture(): Promise<any> {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

function assertHostileDescriptorIds(group: any, expected: readonly string[]): void {
  const actual = group.hostileDescriptors.map((descriptor: any) => descriptor.id);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
}

function assertExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

test("fixture-group:canonical", async () => {
  const vectors = await fixture();
  assert.deepEqual(Object.keys(vectors).sort(), [
    "groups",
    "knownAnswerTests",
    "limits",
    "protocolLiterals",
    "schema",
    "version",
  ]);
  assert.equal(vectors.schema, "decadans.rm0032.phase3-native-observer-fixture.v1");
  assert.equal(vectors.version, "v1");
  assertExactObjectKeys(vectors.protocolLiterals, [
    "fixtureSchema", "requestSchema", "observationSchema", "acknowledgmentSchema",
    "preObservationRefusalSchema", "terminalFailureSchema", "version", "consumer",
    "cliMode", "stdinFraming", "successStdoutFraming", "terminalStdoutFraming",
    "recognizedExitCode", "reservedUnableToEmitExitCode",
  ]);
  for (const group of vectors.groups) {
    assertExactObjectKeys(group, ["id", "vectors", "hostileDescriptors"]);
    for (const descriptor of group.hostileDescriptors) {
      const payloadKeys = ["utf8Base64", "hex", "bytes", "mutation"]
        .filter((key) => Object.hasOwn(descriptor, key));
      assert.ok(payloadKeys.length <= 1);
      assertExactObjectKeys(descriptor, ["id", ...payloadKeys]);
    }
    switch (group.id) {
      case "canonical":
        assertExactObjectKeys(group.vectors[0], [
          "knownAnswerNames", "wireKnownAnswerTests", "canonicalPropertyOrder", "admittedEscapes", "admittedNumberDomain",
        ]);
        break;
      case "scalar":
        assert.equal(group.vectors.length, 2);
        assertExactObjectKeys(group.vectors[0], [
          "requestId", "sha256", "base64", "rootPath", "targetPath",
          "trustedRootFinalPath", "trustedTargetFinalPath",
        ]);
        assertExactObjectKeys(group.vectors[1], ["invalidInputPaths", "validLookalikePaths"]);
        break;
      case "terminal":
        for (const tuple of group.vectors) assert.equal(tuple.length, 4);
        break;
      case "framing":
        assertExactObjectKeys(group.vectors[0], [
          "argv", "stdin", "stdoutSuccess", "stdoutTerminal",
          "recognizedExitCode", "reservedUnableToEmitExitCode",
        ]);
        break;
      case "read-bound-file":
        assertExactObjectKeys(group.vectors[0], [
          "rootFinalPath", "identity", "contentBase64", "contentSha256", "readChunkBytes",
        ]);
        assertExactObjectKeys(group.vectors[0].identity, [
          "volumeSerialNumber", "fileId", "size", "lastWriteTime", "fileAttributes", "finalPath",
        ]);
        break;
      case "create-new-durable-file":
        assertExactObjectKeys(group.vectors[0], [
          "name", "contentBase64", "contentSha256", "writeRequestedBytes", "writeReturnedBytes",
        ]);
        assertExactObjectKeys(group.vectors[1], [
          "name", "contentBase64", "writeCallCount", "writeRequestedBytes", "terminal", "laterAction",
        ]);
        assertExactObjectKeys(group.vectors[2], [
          "name", "contentBase64", "writeCallCount", "terminal", "laterAction",
        ]);
        assertExactObjectKeys(group.vectors[3], ["name", "terminal"]);
        break;
      case "deadline-resource":
        assertExactObjectKeys(group.vectors[0], [
          "operationStartMonotonicMs", "aggregateStartMonotonicMs",
          "operationDeadlineMonotonicMs", "aggregateDeadlineMonotonicMs",
          "earliestDeadlineMonotonicMs", "terminationRequestMax", "drainGraceMs", "ownedHandleKinds",
        ]);
        assertExactObjectKeys(group.vectors[1], [
          "operationStartMonotonicMs", "aggregateStartMonotonicMs",
          "operationDeadlineMonotonicMs", "aggregateDeadlineMonotonicMs",
          "earliestDeadlineMonotonicMs",
        ]);
        break;
      case "adapter":
        assertExactObjectKeys(group.vectors[0], [
          "acceptedBinding", "evidenceRootPolicy", "invocationAttemptCount",
          "stoppedCallInvocationAttemptCount", "transportProductionImplementationPresent",
          "retryAuthorized", "cleanupAuthorized", "fallbackAuthorized",
        ]);
        assertExactObjectKeys(group.vectors[0].acceptedBinding, [
          "observerAbsolutePath", "observerSha256", "evidenceRootAbsolutePath",
        ]);
        break;
      default:
        assert.fail(`unexpected group: ${group.id}`);
    }
  }
  const canonicalVector = vectors.groups.find((group: any) => group.id === "canonical").vectors[0];
  for (const knownAnswer of [...vectors.knownAnswerTests, ...canonicalVector.wireKnownAnswerTests]) {
    assertExactObjectKeys(knownAnswer, ["name", "canonicalUtf8Base64", "bytes", "sha256"]);
  }
  assert.deepEqual(vectors.protocolLiterals, {
    fixtureSchema: vectors.schema,
    requestSchema: NATIVE_OBSERVER_REQUEST_SCHEMA,
    observationSchema: NATIVE_OBSERVER_OBSERVATION_SCHEMA,
    acknowledgmentSchema: NATIVE_OBSERVER_ACKNOWLEDGMENT_SCHEMA,
    preObservationRefusalSchema: NATIVE_OBSERVER_PRE_OBSERVATION_REFUSAL_SCHEMA,
    terminalFailureSchema: NATIVE_OBSERVER_TERMINAL_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    cliMode: "observe-v1",
    stdinFraming: "one-canonical-request-then-EOF",
    successStdoutFraming: "one-canonical-observation-0x0A-one-canonical-acknowledgment-then-EOF",
    terminalStdoutFraming: "one-canonical-terminal-then-EOF",
    recognizedExitCode: 0,
    reservedUnableToEmitExitCode: 64,
  });
  assert.deepEqual(vectors.limits, {
    readRequestUtf8BytesMax: 65_536,
    createNewRequestUtf8BytesMax: 393_216,
    stdinUtf8BytesMax: 393_216,
    boundFileBytesMax: 262_144,
    createNewContentBytesMax: 262_144,
    observationUtf8BytesMax: 1_048_576,
    ackUtf8BytesMax: 65_536,
    terminalUtf8BytesMax: 65_536,
    successStdoutUtf8BytesMax: 1_114_113,
    terminalStdoutUtf8BytesMax: 65_536,
    stderrBytesMax: 0,
    durableEvidenceUtf8BytesMax: 1_048_576,
    pathUtf8BytesMax: 1_024,
    operationDeadlineMsMax: 10_000,
    aggregateDeadlineMsMax: 15_000,
    observerInvocationCountMax: 1,
    workingSetBytesMax: 67_108_864,
    jobMemoryBytesMax: 134_217_728,
    cpuHardCapPercent: 25,
    concurrency: 1,
    threadCountMax: 4,
    childProcessCountMax: 0,
    base64OfMaxContentBytes: 349_528,
    createNewMaxEnvelopeUtf8Bytes: 353_882,
    capAlgebra: "base64(262144)=349528-and-fixed-uuid-plus-two-escaped-1024-byte-paths-envelope<=353882<=393216",
  });
  assert.deepEqual(vectors.groups.map((group: any) => group.id), [
    "canonical",
    "scalar",
    "terminal",
    "framing",
    "read-bound-file",
    "create-new-durable-file",
    "deadline-resource",
    "adapter",
  ]);

  for (const knownAnswer of vectors.knownAnswerTests) {
    const bytes = Buffer.from(knownAnswer.canonicalUtf8Base64, "base64");
    assert.equal(bytes.toString("base64"), knownAnswer.canonicalUtf8Base64);
    assert.equal(bytes.byteLength, knownAnswer.bytes);
    assert.equal(sha256Hex(bytes), knownAnswer.sha256);
    const request = parseCanonicalObserverRequestBytes(bytes);
    assert.equal(canonicalizeObserverJson(request), bytes.toString("utf8"));
  }
  assert.equal(canonicalVector.wireKnownAnswerTests.length, 2);
  for (const knownAnswer of canonicalVector.wireKnownAnswerTests) {
    const bytes = Buffer.from(knownAnswer.canonicalUtf8Base64, "base64");
    assert.equal(bytes.toString("base64"), knownAnswer.canonicalUtf8Base64);
    assert.equal(bytes.byteLength, knownAnswer.bytes);
    assert.equal(sha256Hex(bytes), knownAnswer.sha256);
  }
  const wireReadRequest = parseCanonicalObserverRequestBytes(
    Buffer.from(vectors.knownAnswerTests[0].canonicalUtf8Base64, "base64"),
  ) as ReadBoundFileRequestV1;
  const wireIdentity = vectors.groups.find((candidate: any) => candidate.id === "read-bound-file")
    .vectors[0].identity;
  const wireSuccess = knownReadEvidence(wireReadRequest, wireIdentity, Buffer.from("tracer-bullet"));
  assert.equal(
    Buffer.from(wireSuccess.capturedStdoutBytes).toString("base64"),
    canonicalVector.wireKnownAnswerTests[0].canonicalUtf8Base64,
  );
  const wireRequestSha256 = sha256Hex(Buffer.from(canonicalizeObserverJson(wireReadRequest), "utf8"));
  const wireTerminal = makeCorrelatedTerminal(
    wireReadRequest.operation,
    wireReadRequest.requestId,
    wireRequestSha256,
    "refused",
    "read-observation",
    "none",
  );
  assert.equal(
    encodeObserverTerminalFrame(wireTerminal).toString("base64"),
    canonicalVector.wireKnownAnswerTests[1].canonicalUtf8Base64,
  );
  assert.deepEqual(canonicalVector.knownAnswerNames, vectors.knownAnswerTests.map((kat: any) => kat.name));
  assert.ok(canonicalVector.knownAnswerNames.length > 0);
  const canonicalGroup = vectors.groups.find((group: any) => group.id === "canonical");
  assertHostileDescriptorIds(canonicalGroup, [
    "duplicate-property", "unicode-escape", "trailing-lf", "fraction", "negative-zero",
    "unsafe-integer", "malformed-utf8", "utf8-bom", "control-scalar",
    "oversized-read-request", "extra-request-schema-field",
  ]);
  const readKat = parseCanonicalObserverRequestBytes(Buffer.from(vectors.knownAnswerTests[0].canonicalUtf8Base64, "base64"));
  for (const hostile of canonicalGroup.hostileDescriptors) {
    if (hostile.utf8Base64 !== undefined || hostile.hex !== undefined) {
      const bytes = hostile.utf8Base64 !== undefined
        ? Buffer.from(hostile.utf8Base64, "base64")
        : Buffer.from(hostile.hex, "hex");
      assert.throws(() => parseCanonicalObserverJsonBytes(bytes), /canonical|control|duplicate|escape|integer|strict|trailing|utf8|bom/u);
    } else if (hostile.bytes !== undefined) {
      assert.throws(() => parseCanonicalObserverRequestBytes(Buffer.alloc(hostile.bytes, 0x20)), /canonical|strict|request/u);
    } else if (hostile.mutation === "add-extra-field") {
      assert.throws(
        () => parseCanonicalObserverRequestBytes(Buffer.from(canonicalizeObserverJson({ ...readKat, extra: "forbidden" }), "utf8")),
        /property-set/u,
      );
    } else {
      assert.fail("unhandled canonical hostile payload");
    }
  }

  assert.throws(
    () => parseCanonicalObserverRequestBytes(Buffer.from('{"a":1,"a":1}', "utf8")),
    /duplicate/u,
  );
  assert.throws(
    () => parseCanonicalObserverRequestBytes(Buffer.from('{"consumer":"x\\u0079"}', "utf8")),
    /escape|canonical/u,
  );
  console.log(fixtureGroupPassEvidence("canonical", processGroupSelector));
});

test("fixture-group:scalar", async () => {
  const vectors = await fixture();
  const group = vectors.groups.find((candidate: any) => candidate.id === "scalar");
  assertHostileDescriptorIds(group, [
    "request-id-lowercase", "sha256-uppercase", "base64-noncanonical", "path-escape", "path-unc",
    "path-ads", "path-device", "path-reserved", "path-reserved-superscript", "path-trailing-dot",
    "path-console-device", "path-illegal-component-char", "final-path-dot-component", "path-long-extended-native",
    "reparse-any-tag",
  ]);
  const vector = group.vectors[0];
  assert.equal(validateRequestId(vector.requestId), true);
  assert.equal(validateRequestId(vector.requestId.toLowerCase()), false);
  assert.equal(validateSha256(vector.sha256), true);
  assert.equal(validateSha256(vector.sha256.toUpperCase()), false);
  for (const encoded of vector.base64) decodeCanonicalBase64(encoded, 262_144);
  assert.throws(() => decodeCanonicalBase64("Zh==", 262_144), /base64/u);
  validateInputPathPair(vector.rootPath, vector.targetPath);
  for (const [index, invalidPath] of group.vectors[1].invalidInputPaths.entries()) {
    const expected = index <= 2
      ? { code: "path", message: "path: path must be a bounded uppercase-drive DOS absolute path" }
      : index >= 7 && index <= 22
        ? { code: "path-component", message: "path-component: reserved DOS path component" }
        : { code: "path-component", message: "path-component: path component is noncanonical" };
    assert.throws(
      () => validateInputPathPair(vector.rootPath, invalidPath),
      (error: unknown) => error instanceof NativeObserverContractError
        && error.name === "NativeObserverContractError"
        && error.code === expected.code
        && error.message === expected.message,
    );
  }
  for (const validLookalikePath of group.vectors[1].validLookalikePaths) {
    validateInputPathPair(vector.rootPath, validLookalikePath);
  }
  const maximumContent = Buffer.alloc(262_144, 0x61);
  assert.equal(decodeCanonicalBase64(maximumContent.toString("base64"), 262_144).byteLength, 262_144);
  assert.throws(
    () => decodeCanonicalBase64(Buffer.alloc(262_145, 0x61).toString("base64"), 262_144),
    /base64|cap/u,
  );
  validateInputPathPair(vector.rootPath, `${vector.rootPath}\\${"a".repeat(300)}.txt`);
  assert.equal(validateFinalContainment(vector.trustedRootFinalPath, vector.trustedTargetFinalPath), "contained");
  assert.equal(validateFinalContainment("\\\\?\\C:\\", "\\\\?\\C:\\bound.txt"), "contained");
  assert.equal(validateFinalContainment(vector.trustedRootFinalPath, `${vector.trustedRootFinalPath}\\..`), "invalid");
  assert.equal(
    validateFinalContainment(
      vector.trustedRootFinalPath,
      vector.trustedTargetFinalPath.replace("fixtures", "Fixtures"),
    ),
    "non-identical",
  );
  console.log(fixtureGroupPassEvidence("scalar", processGroupSelector));
});

test("fixture-group:terminal", async () => {
  const vectors = await fixture();
  const tuples = vectors.groups.find((candidate: any) => candidate.id === "terminal").vectors;
  const terminalGroup = vectors.groups.find((candidate: any) => candidate.id === "terminal");
  assertHostileDescriptorIds(terminalGroup, [
    "terminal-wrong-consumer", "terminal-wrong-outcome", "terminal-cross-operation",
    "terminal-extra-property", "terminal-missing-property", "pre-observation-correlation-forbidden",
  ]);
  assert.equal(tuples.length, 8);
  for (const [operation, outcome, failureStage, effectState] of tuples) {
    const terminal = makeCorrelatedTerminal(
      operation,
      "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      outcome,
      failureStage,
      effectState,
    );
    validateTerminal(terminal);
    assert.equal(Object.keys(terminal).length, 9);
    for (const key of ["operation", "outcome", "failureStage", "effectState"] as const) {
      assert.throws(() => validateTerminal({ ...terminal, [key]: "outside-domain" }), /terminal|tuple/u);
    }
  }
  assert.throws(
    () => makeCorrelatedTerminal(
      "create-new-durable-file",
      "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "refused",
      "post-create",
      "possibly-created",
    ),
    /terminal|tuple/u,
  );
  const refusal = makePreObservationRefusal();
  validateTerminal(refusal);
  assert.deepEqual(Object.keys(refusal).sort(), ["consumer", "failureStage", "outcome", "schema", "version"]);
  assert.throws(() => validateTerminal({ ...refusal, requestId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" }), /property-set/u);
  const hostileBaseline = makeCorrelatedTerminal(
    "read-bound-file",
    "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "refused",
    "read-observation",
    "none",
  );
  assert.throws(() => validateTerminal({ ...hostileBaseline, consumer: "wrong-consumer" }), /terminal/u);
  const missing = { ...hostileBaseline } as any;
  delete missing.effectState;
  assert.throws(() => validateTerminal(missing), /property-set/u);
  assert.throws(() => validateTerminal({ ...hostileBaseline, extra: true }), /property-set/u);
  assert.throws(
    () => validateTerminal({ ...hostileBaseline, operation: "create-new-durable-file" }),
    /terminal|tuple/u,
  );
  console.log(fixtureGroupPassEvidence("terminal", processGroupSelector));
});

test("fixture-group:framing", async () => {
  const vectors = await fixture();
  const frameVector = vectors.groups.find((candidate: any) => candidate.id === "framing").vectors[0];
  const framingGroup = vectors.groups.find((candidate: any) => candidate.id === "framing");
  assertHostileDescriptorIds(framingGroup, [
    "success-missing-lf", "success-extra-lf", "success-trailing-lf", "success-truncated-observation",
    "success-truncated-ack", "terminal-trailing-lf", "stdout-oversized", "stderr-nonzero-marker", "exit-unknown",
  ]);
  assert.deepEqual(frameVector.argv, ["observe-v1"]);
  assert.equal(frameVector.stdin, "R-then-EOF-only");
  assert.equal(frameVector.stdoutSuccess, "O-0x0A-A-then-EOF");
  assert.equal(frameVector.stdoutTerminal, "T-then-EOF");
  assert.equal(frameVector.recognizedExitCode, 0);
  assert.equal(frameVector.reservedUnableToEmitExitCode, 64);
  const observation = { kind: "observation", size: 0 };
  const acknowledgment = { kind: "acknowledgment", outcome: "known" };
  const success = encodeObserverSuccessFrame(observation, acknowledgment);
  const observationBytes = Buffer.from(canonicalizeObserverJson(observation), "utf8");
  const acknowledgmentBytes = Buffer.from(canonicalizeObserverJson(acknowledgment), "utf8");
  const expected = Buffer.from(
    `${canonicalizeObserverJson(observation)}\n${canonicalizeObserverJson(acknowledgment)}`,
    "utf8",
  );
  assert.deepEqual(success, expected);
  assert.equal(success.filter((byte) => byte === 0x0a).byteLength, 1);
  assert.notEqual(success.at(-1), 0x0a);
  assert.throws(
    () => parseCanonicalObserverJsonBytes(Buffer.concat([observationBytes, acknowledgmentBytes])),
    /json|canonical|trailing/u,
  );
  const extraLf = Buffer.concat([observationBytes, Buffer.from("\n\n"), acknowledgmentBytes]);
  assert.equal(extraLf.filter((byte) => byte === 0x0a).byteLength, 2);
  assert.throws(() => parseCanonicalObserverJsonBytes(extraLf.subarray(observationBytes.length + 1)), /json|canonical/u);
  const trailingLf = Buffer.concat([success, Buffer.from("\n")]);
  assert.throws(() => parseCanonicalObserverJsonBytes(trailingLf), /json|canonical|trailing/u);
  assert.throws(
    () => parseCanonicalObserverJsonBytes(observationBytes.subarray(0, observationBytes.length - 1)),
    /json|canonical/u,
  );
  assert.throws(
    () => parseCanonicalObserverJsonBytes(acknowledgmentBytes.subarray(0, acknowledgmentBytes.length - 1)),
    /json|canonical/u,
  );
  const terminal = makePreObservationRefusal();
  const terminalBytes = encodeObserverTerminalFrame(terminal);
  assert.equal(terminalBytes.toString("utf8"), canonicalizeObserverJson(terminal));
  assert.notEqual(terminalBytes.at(-1), 0x0a);
  assert.throws(
    () => parseCanonicalObserverJsonBytes(Buffer.concat([terminalBytes, Buffer.from("\n")])),
    /json|canonical|trailing/u,
  );
  assert.throws(
    () => encodeObserverSuccessFrame({ payload: "x".repeat(1_048_577) }, acknowledgment),
    /cap/u,
  );
  assert.equal(1_048_576 + 1 + 65_536, 1_114_113);
  console.log(fixtureGroupPassEvidence("framing", processGroupSelector));
});

test("fixture-group:read-bound-file", async () => {
  const vectors = await fixture();
  const vector = vectors.groups.find((candidate: any) => candidate.id === "read-bound-file").vectors[0];
  const readGroup = vectors.groups.find((candidate: any) => candidate.id === "read-bound-file");
  assertHostileDescriptorIds(readGroup, [
    "read-cross-path", "read-directory-type", "read-final-path-case-drift", "read-volume-drift",
    "read-file-id-drift", "read-mtime-drift", "read-size-drift", "read-attributes-drift",
    "read-zero-progress", "read-race-after-identity",
  ]);
  const identity = validateIdentity(vector.identity);
  const content = Buffer.from(vector.contentBase64, "base64");
  assert.deepEqual(
    completeReadProof(vector.rootFinalPath, identity, identity, content),
    { contentBase64: vector.contentBase64, contentSha256: vector.contentSha256 },
  );
  const drifted = { ...identity, lastWriteTime: "1" };
  assert.throws(
    () => completeReadProof(vector.rootFinalPath, identity, drifted, content),
    /drift/u,
  );
  for (const mutatedAfter of [
    { ...identity, volumeSerialNumber: "ffffffffffffffff" },
    { ...identity, fileId: "ffffffffffffffffffffffffffffffff" },
    { ...identity, size: "12" },
    { ...identity, fileAttributes: "00000021" },
  ]) {
    assert.throws(
      () => completeReadProof(vector.rootFinalPath, identity, mutatedAfter, content),
      /drift/u,
    );
  }
  const directoryIdentity = { ...identity, fileAttributes: "00000010" };
  assert.throws(
    () => completeReadProof(vector.rootFinalPath, directoryIdentity, directoryIdentity, content),
    /directory|drift/u,
  );
  const racedAfter = { ...identity, fileId: "00000000000000000000000000000002" };
  assert.throws(
    () => completeReadProof(vector.rootFinalPath, identity, racedAfter, content),
    /drift/u,
  );
  const nonIdentical = { ...identity, finalPath: identity.finalPath.replace("fixtures", "Fixtures") };
  assert.throws(
    () => completeReadProof(vector.rootFinalPath, nonIdentical, nonIdentical, content),
    /non-identical/u,
  );
  validateReadProgress(13, [13]);
  assert.throws(() => validateReadProgress(13, [0]), /incomplete/u);
  assert.throws(() => validateNoReparseTag(0xa000000c), /reparse/u);
  const sibling = { ...identity, finalPath: "\\\\?\\C:\\fixtures\\rm0032\\sibling.txt" };
  assert.throws(() => validateExactTargetFinalPath("C:\\fixtures\\rm0032\\bound.txt", sibling), /target-final-path/u);
  console.log(fixtureGroupPassEvidence("read-bound-file", processGroupSelector));
});

test("fixture-group:create-new-durable-file", async () => {
  const vectors = await fixture();
  const group = vectors.groups.find((candidate: any) => candidate.id === "create-new-durable-file");
  assertHostileDescriptorIds(group, [
    "create-last-error-ambiguous", "create-collision-with-write", "create-zero-valid-handle-extra-action",
    "create-zero-ambiguous-write", "create-write-false", "create-write-short", "create-flush-failure",
    "create-rewind-failure", "create-close-failure", "create-reopen-failure",
    "create-reopen-identity-drift", "create-hash-mismatch", "create-directory-type",
    "create-zero-deadline-write-order", "create-ordered-trace",
  ]);
  const content = Buffer.from(group.vectors[0].contentBase64, "base64");
  assert.equal(group.vectors[0].name, "nonempty-known");
  assert.equal(group.vectors[0].writeRequestedBytes, content.byteLength);
  assert.equal(group.vectors[0].writeReturnedBytes, content.byteLength);
  assert.equal(sha256Hex(content), group.vectors[0].contentSha256);
  assert.equal(classifyCreateTrace(content, createTrace.nonemptySuccess(content.byteLength)), "known");
  const short = createTrace.nonemptySuccess(content.byteLength);
  short.writeReturned = content.byteLength - 1;
  assert.equal(classifyCreateTrace(content, short), "unknown-post-create");
  const zeroValid = createTrace.zeroValidHandle();
  assert.equal(group.vectors[1].name, "zero-valid-handle");
  assert.equal(group.vectors[1].writeCallCount, 1);
  assert.equal(group.vectors[1].writeRequestedBytes, 0);
  assert.deepEqual(group.vectors[1].terminal, ["create-new-durable-file", "unknown", "post-create", "possibly-created"]);
  assert.equal(group.vectors[1].laterAction, "owned-handle-resource-release");
  assert.deepEqual(zeroValid.writeRequests, [0]);
  assert.equal(classifyCreateTrace(Buffer.alloc(0), zeroValid), "unknown-post-create");
  const zeroAmbiguous = createTrace.zeroAmbiguityNoHandle();
  assert.equal(group.vectors[2].name, "zero-ambiguity-no-handle");
  assert.equal(group.vectors[2].writeCallCount, 0);
  assert.deepEqual(group.vectors[2].terminal, ["create-new-durable-file", "unknown", "post-create", "possibly-created"]);
  assert.equal(group.vectors[2].laterAction, "owned-root-and-existing-ancestor-handle-resource-release-only");
  assert.deepEqual(zeroAmbiguous.writeRequests, []);
  assert.equal(zeroAmbiguous.releaseRootAncestors, true);
  assert.equal(classifyCreateTrace(Buffer.alloc(0), zeroAmbiguous), "unknown-post-create");
  const illegalAmbiguityWrite = { ...zeroAmbiguous, writeRequests: [0] as number[] };
  assert.equal(classifyCreateTrace(Buffer.alloc(0), illegalAmbiguityWrite), "invalid-trace");
  const forbiddenPostCreateAction = { ...zeroValid, flush: true };
  assert.equal(classifyCreateTrace(Buffer.alloc(0), forbiddenPostCreateAction), "invalid-trace");
  assert.equal(classifyCreateTrace(content, createTrace.collision()), "refused-collision");
  assert.equal(group.vectors[3].name, "collision");
  assert.deepEqual(group.vectors[3].terminal, ["create-new-durable-file", "refused", "create-collision", "not-created"]);
  const collisionWithWrite = { ...createTrace.collision(), writeRequests: [content.byteLength] };
  assert.equal(classifyCreateTrace(content, collisionWithWrite), "invalid-trace");
  const hostileTraces = [
    { ...createTrace.nonemptySuccess(content.byteLength), writeReturned: null },
    { ...createTrace.nonemptySuccess(content.byteLength), flush: false },
    { ...createTrace.nonemptySuccess(content.byteLength), rewind: false },
    { ...createTrace.nonemptySuccess(content.byteLength), releaseOriginal: false },
    { ...createTrace.nonemptySuccess(content.byteLength), reopen: false },
    { ...createTrace.nonemptySuccess(content.byteLength), reopenedIdentity: false },
    { ...createTrace.nonemptySuccess(content.byteLength), sameHandleReadback: false },
  ];
  for (const hostileTrace of hostileTraces) {
    assert.equal(classifyCreateTrace(content, hostileTrace), "unknown-post-create");
  }
  console.log(fixtureGroupPassEvidence("create-new-durable-file", processGroupSelector));
});

test("fixture-group:deadline-resource", async () => {
  const vectors = await fixture();
  const vector = vectors.groups.find((candidate: any) => candidate.id === "deadline-resource").vectors[0];
  const deadlineGroup = vectors.groups.find((candidate: any) => candidate.id === "deadline-resource");
  assertHostileDescriptorIds(deadlineGroup, [
    "deadline-operation-expired", "deadline-aggregate-precedence", "deadline-overflow",
    "deadline-create-open-classification-dominance", "deadline-late-read-refusal-dominance",
    "deadline-post-frame-known-dominance", "deadline-aggregate-start-before-request",
    "deadline-post-parse-known-dominance", "deadline-clock-fault", "deadline-timeout-one-latch",
    "ancestor-stable-identity-revalidation", "native-trace-last-error-adjacency",
    "termination-request-repeat", "handle-double-close", "handle-unknown-kind",
  ]);
  const deadlines = createDeadlineContext(
    vector.aggregateStartMonotonicMs,
    vector.operationStartMonotonicMs,
  );
  assert.deepEqual(deadlines, {
    aggregateDeadlineMonotonicMs: 15_000,
    operationDeadlineMonotonicMs: 11_000,
  });
  assert.equal(Math.min(deadlines.aggregateDeadlineMonotonicMs, deadlines.operationDeadlineMonotonicMs), 11_000);
  assert.equal(deadlineReached(deadlines, 10_999), false);
  assert.equal(deadlineReached(deadlines, 11_000), true);
  assert.equal(deadlineReached(deadlines, 11_001), true);
  assert.equal(vector.earliestDeadlineMonotonicMs, 11_000);
  assert.equal(vector.terminationRequestMax, 1);
  assert.equal(vector.drainGraceMs, 5_000);
  const ledger = new HandleLedger();
  for (const kind of vector.ownedHandleKinds) ledger.acquire(kind);
  for (const kind of vector.ownedHandleKinds) ledger.close(kind);
  assert.equal(ledger.allReleased(), true);
  assert.throws(() => ledger.close("root"), /owned|closed/u);
  assert.throws(() => ledger.acquire("unknown-kind"), /unknown|owned/u);
  const termination = new TerminationRequestLatch();
  termination.request();
  assert.throws(() => termination.request(), /termination/u);
  assert.throws(() => createDeadlineContext(Number.MAX_SAFE_INTEGER, 0), /deadline/u);
  assert.throws(() => createDeadlineContext(0.5, 0), /deadline/u);
  console.log(fixtureGroupPassEvidence("deadline-resource", processGroupSelector));
});

function knownReadEvidence(request: ReadBoundFileRequestV1, identity: any, content: Buffer): InvocationEvidenceV1 {
  const requestBytes = Buffer.from(canonicalizeObserverJson(request), "utf8");
  const requestSha256 = sha256Hex(requestBytes);
  const observation = {
    schema: NATIVE_OBSERVER_OBSERVATION_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    operation: "read-bound-file",
    requestId: request.requestId,
    requestSha256,
    identityBefore: identity,
    identityAfter: identity,
    contentBase64: content.toString("base64"),
    contentSha256: sha256Hex(content),
  };
  const observationBytes = Buffer.from(canonicalizeObserverJson(observation), "utf8");
  const acknowledgment = {
    schema: NATIVE_OBSERVER_ACKNOWLEDGMENT_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    operation: "read-bound-file",
    requestId: request.requestId,
    requestSha256,
    observationUtf8Bytes: observationBytes.byteLength,
    observationSha256: sha256Hex(observationBytes),
    outcome: "known",
  };
  return {
    kind: "child-started",
    invocationAttemptCount: 1,
    evidenceRootAbsolutePath: EVIDENCE_ROOT,
    childStarted: true,
    capturedStdoutBytes: encodeObserverSuccessFrame(observation, acknowledgment),
    capturedStderrBytes: Buffer.alloc(0),
    stdoutState: "eof",
    stderrState: "eof-zero-bytes",
    streamClosureState: "both-eof",
    exitState: { kind: "known", code: 0 },
  };
}

function knownCreateEvidence(
  request: CreateNewDurableFileRequestV1,
  identityTemplate: any,
): InvocationEvidenceV1 {
  const requestBytes = Buffer.from(canonicalizeObserverJson(request), "utf8");
  const requestSha256 = sha256Hex(requestBytes);
  const content = Buffer.from(request.contentBase64, "base64");
  const contentSha256 = sha256Hex(content);
  const identity = {
    ...identityTemplate,
    size: String(content.byteLength),
    finalPath: `\\\\?\\${request.targetPath}`,
  };
  const observation = {
    schema: NATIVE_OBSERVER_OBSERVATION_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    operation: "create-new-durable-file",
    requestId: request.requestId,
    requestSha256,
    creationDisposition: "CREATE_NEW",
    creationFlags: ["FILE_ATTRIBUTE_NORMAL", "FILE_FLAG_WRITE_THROUGH", "FILE_FLAG_OPEN_REPARSE_POINT"],
    createdIdentity: identity,
    flushFileBuffersSucceeded: true,
    sameHandleReadbackSha256: contentSha256,
    reopenedIdentity: identity,
    reopenedReadbackSha256: contentSha256,
  };
  const observationBytes = Buffer.from(canonicalizeObserverJson(observation), "utf8");
  const acknowledgment = {
    schema: NATIVE_OBSERVER_ACKNOWLEDGMENT_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    operation: "create-new-durable-file",
    requestId: request.requestId,
    requestSha256,
    observationUtf8Bytes: observationBytes.byteLength,
    observationSha256: sha256Hex(observationBytes),
    outcome: "known",
  };
  return {
    kind: "child-started",
    invocationAttemptCount: 1,
    evidenceRootAbsolutePath: EVIDENCE_ROOT,
    childStarted: true,
    capturedStdoutBytes: encodeObserverSuccessFrame(observation, acknowledgment),
    capturedStderrBytes: Buffer.alloc(0),
    stdoutState: "eof",
    stderrState: "eof-zero-bytes",
    streamClosureState: "both-eof",
    exitState: { kind: "known", code: 0 },
  };
}

test("fixture-group:adapter", async () => {
  const vectors = await fixture();
  const binding = vectors.groups.find((candidate: any) => candidate.id === "adapter").vectors[0]
    .acceptedBinding as AcceptedNativeObserverBindingV1;
  const adapterGroup = vectors.groups.find((candidate: any) => candidate.id === "adapter");
  assertHostileDescriptorIds(adapterGroup, [
    "request-wrong-consumer", "observation-wrong-consumer", "ack-wrong-consumer",
    "observation-missing-property", "observation-extra-property", "ack-missing-property", "ack-extra-property",
    "output-schema-drift", "output-version-drift", "cross-operation-request", "cross-operation-observation",
    "cross-operation-ack", "marker-evidence-collision", "evidence-truncated", "evidence-corrupt", "ack-corrupt",
    "ack-hash-mismatch", "late-known", "concurrent-invocation", "stopped-call", "evidence-root-mismatch",
    "create-output-symmetry", "create-terminal-matrix", "method-payload-fresh-observer-zero-transport",
    "request-pre-cap-allocation", "base64-cap-boundary", "create-request-symmetry",
    "bounded-request-correlation",
  ]);
  assert.equal(binding.evidenceRootAbsolutePath, "C:\\ProgramData\\DecadansNeurobro\\Phase3\\evidence\\native-observer-v1");
  assert.equal(adapterGroup.vectors[0].evidenceRootPolicy, "exact-accepted-binding-only");
  assert.equal(adapterGroup.vectors[0].invocationAttemptCount, 1);
  assert.equal(adapterGroup.vectors[0].stoppedCallInvocationAttemptCount, 0);
  assert.equal(adapterGroup.vectors[0].transportProductionImplementationPresent, false);
  assert.equal(adapterGroup.vectors[0].retryAuthorized, false);
  assert.equal(adapterGroup.vectors[0].cleanupAuthorized, false);
  assert.equal(adapterGroup.vectors[0].fallbackAuthorized, false);
  const readRequest = parseCanonicalObserverRequestBytes(
    Buffer.from(vectors.knownAnswerTests[0].canonicalUtf8Base64, "base64"),
  ) as ReadBoundFileRequestV1;
  const identity = vectors.groups.find((candidate: any) => candidate.id === "read-bound-file").vectors[0].identity;
  let calls = 0;
  const knownTransport: Phase3NativeObserverTransportV1 = {
    async invoke(): Promise<InvocationEvidenceV1> {
      calls += 1;
      return knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet"));
    },
  };
  const knownObserver = createPhase3NativeObserverV1(binding, knownTransport);
  assert.deepEqual(Object.keys(knownObserver).sort(), ["createNewDurableFile", "readExactBoundFile"]);
  const known = await knownObserver.readExactBoundFile(readRequest);
  assert.equal(known.outcome, "known");
  assert.equal(calls, 1);

  const bindingSnapshot = { ...binding };
  const mutableAcceptedBinding = { ...binding };
  const transportSnapshots: Array<{
    acceptedBinding: AcceptedNativeObserverBindingV1;
    deadlineContext: { aggregateDeadlineMonotonicMs: number; operationDeadlineMonotonicMs: number };
  }> = [];
  const immutableObserver = createPhase3NativeObserverV1(mutableAcceptedBinding, {
    async invoke(input): Promise<InvocationEvidenceV1> {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.acceptedBinding), true);
      assert.equal(Object.isFrozen(input.deadlineContext), true);
      transportSnapshots.push({
        acceptedBinding: input.acceptedBinding,
        deadlineContext: input.deadlineContext,
      });
      try {
        (input.acceptedBinding as any).observerAbsolutePath = "C:\\mutated\\observer.exe";
      } catch {
        // The transport receives an immutable adapter-owned copy.
      }
      try {
        (input.deadlineContext as any).aggregateDeadlineMonotonicMs = 0;
        (input.deadlineContext as any).operationDeadlineMonotonicMs = 0;
      } catch {
        // Post-await classification uses the adapter's private deadline scalar.
      }
      return knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet"));
    },
  });
  const firstImmutableResult = immutableObserver.readExactBoundFile(readRequest);
  mutableAcceptedBinding.observerAbsolutePath = "C:\\mutated\\caller-observer.exe";
  mutableAcceptedBinding.observerSha256 = "0".repeat(64);
  mutableAcceptedBinding.evidenceRootAbsolutePath = "C:\\mutated\\caller-evidence";
  assert.equal((await firstImmutableResult).outcome, "known");
  assert.equal((await immutableObserver.readExactBoundFile(readRequest)).outcome, "known");
  assert.equal(transportSnapshots.length, 2);
  assert.deepEqual(transportSnapshots[0].acceptedBinding, bindingSnapshot);
  assert.deepEqual(transportSnapshots[1].acceptedBinding, bindingSnapshot);
  assert.notEqual(transportSnapshots[0].acceptedBinding, transportSnapshots[1].acceptedBinding);
  assert.notEqual(transportSnapshots[0].deadlineContext, transportSnapshots[1].deadlineContext);

  async function runReadInFlightMutation(mutator: (request: Record<string, any>) => void): Promise<void> {
    const mutableRequest = { ...readRequest } as Record<string, any>;
    let release!: () => void;
    let entered = false;
    const observer = createPhase3NativeObserverV1(binding, {
      async invoke(input): Promise<InvocationEvidenceV1> {
        entered = true;
        return await new Promise<InvocationEvidenceV1>((resolve) => {
          release = () => {
            const snapshot = parseCanonicalObserverRequestBytes(
              input.canonicalRequestBytes,
            ) as ReadBoundFileRequestV1;
            resolve(knownReadEvidence(snapshot, identity, Buffer.from("tracer-bullet")));
          };
        });
      },
    });
    const pending = observer.readExactBoundFile(mutableRequest as any);
    assert.equal(entered, true);
    mutator(mutableRequest);
    release();
    const result = await pending;
    assert.equal(result.outcome, "known");
    if (result.outcome === "known") {
      assert.equal(result.observation.operation, readRequest.operation);
      assert.equal(result.observation.requestId, readRequest.requestId);
      assert.equal(result.observation.identityBefore.finalPath, identity.finalPath);
    }
  }
  await runReadInFlightMutation((mutable) => delete mutable.operation);
  await runReadInFlightMutation((mutable) => { mutable.requestId = "MUTATED"; });
  await runReadInFlightMutation((mutable) => delete mutable.rootPath);
  await runReadInFlightMutation((mutable) => { mutable.targetPath = "C:\\mutated\\outside.txt"; });

  const createRequest = parseCanonicalObserverRequestBytes(
    Buffer.from(vectors.knownAnswerTests[1].canonicalUtf8Base64, "base64"),
  ) as CreateNewDurableFileRequestV1;
  async function runCreateContentMutation(mutator: (request: Record<string, any>) => void): Promise<void> {
    const mutableRequest = { ...createRequest } as Record<string, any>;
    let release!: () => void;
    const observer = createPhase3NativeObserverV1(binding, {
      async invoke(input): Promise<InvocationEvidenceV1> {
        return await new Promise<InvocationEvidenceV1>((resolve) => {
          release = () => {
            const snapshot = parseCanonicalObserverRequestBytes(
              input.canonicalRequestBytes,
            ) as CreateNewDurableFileRequestV1;
            resolve(knownCreateEvidence(snapshot, identity));
          };
        });
      },
    });
    const pending = observer.createNewDurableFile(mutableRequest as any);
    mutator(mutableRequest);
    release();
    const result = await pending;
    assert.equal(result.outcome, "known");
    if (result.outcome === "known") {
      assert.equal(result.observation.requestId, createRequest.requestId);
      assert.equal(result.observation.sameHandleReadbackSha256, sha256Hex(Buffer.from(createRequest.contentBase64, "base64")));
    }
  }
  await runCreateContentMutation((mutable) => { mutable.contentBase64 = ""; });
  await runCreateContentMutation((mutable) => delete mutable.contentBase64);

  const baselineEvidence = knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet"));
  const baselineStdout = Buffer.from(baselineEvidence.capturedStdoutBytes);
  const baselineLf = baselineStdout.indexOf(0x0a);
  assert.ok(baselineLf > 0);
  const baselineObservation = parseCanonicalObserverJsonBytes(
    baselineStdout.subarray(0, baselineLf),
  ) as Record<string, any>;
  const baselineAcknowledgment = parseCanonicalObserverJsonBytes(
    baselineStdout.subarray(baselineLf + 1),
  ) as Record<string, any>;
  const evidenceWithStdout = (
    stdout: Uint8Array,
    overrides: Partial<InvocationEvidenceV1> = {},
  ): InvocationEvidenceV1 => ({
    ...baselineEvidence,
    capturedStdoutBytes: Buffer.from(stdout),
    ...overrides,
  } as InvocationEvidenceV1);
  const evidenceWithDocuments = (observation: unknown, acknowledgment: unknown): InvocationEvidenceV1 => (
    evidenceWithStdout(encodeObserverSuccessFrame(observation, acknowledgment))
  );
  const readOutcomeForEvidence = async (evidence: InvocationEvidenceV1): Promise<string> => {
    const observer = createPhase3NativeObserverV1(binding, {
      async invoke(): Promise<InvocationEvidenceV1> {
        return evidence;
      },
    });
    return (await observer.readExactBoundFile(readRequest)).outcome;
  };
  const omit = (source: Record<string, any>, key: string): Record<string, any> => {
    const copy = { ...source };
    delete copy[key];
    return copy;
  };

  for (const hostileObservation of [
    { ...baselineObservation, consumer: "wrong-consumer" },
    omit(baselineObservation, "contentSha256"),
    { ...baselineObservation, extra: true },
    { ...baselineObservation, schema: "wrong-schema" },
    { ...baselineObservation, version: "v2" },
    { ...baselineObservation, operation: "create-new-durable-file" },
  ]) {
    assert.equal(
      await readOutcomeForEvidence(evidenceWithDocuments(hostileObservation, baselineAcknowledgment)),
      "unknown",
    );
  }
  for (const hostileAcknowledgment of [
    { ...baselineAcknowledgment, consumer: "wrong-consumer" },
    omit(baselineAcknowledgment, "observationSha256"),
    { ...baselineAcknowledgment, extra: true },
    { ...baselineAcknowledgment, operation: "create-new-durable-file" },
    { ...baselineAcknowledgment, observationSha256: "0".repeat(64) },
  ]) {
    assert.equal(
      await readOutcomeForEvidence(evidenceWithDocuments(baselineObservation, hostileAcknowledgment)),
      "unknown",
    );
  }

  const baselineCreateEvidence = knownCreateEvidence(createRequest, identity);
  const baselineCreateStdout = Buffer.from(baselineCreateEvidence.capturedStdoutBytes);
  const baselineCreateLf = baselineCreateStdout.indexOf(0x0a);
  assert.ok(baselineCreateLf > 0);
  const baselineCreateObservation = parseCanonicalObserverJsonBytes(
    baselineCreateStdout.subarray(0, baselineCreateLf),
  ) as Record<string, any>;
  const baselineCreateAcknowledgment = parseCanonicalObserverJsonBytes(
    baselineCreateStdout.subarray(baselineCreateLf + 1),
  ) as Record<string, any>;
  const createEvidenceWithDocuments = (
    observation: Record<string, any>,
    acknowledgment: Record<string, any>,
    rebindAcknowledgment = false,
  ): InvocationEvidenceV1 => {
    const observationBytes = Buffer.from(canonicalizeObserverJson(observation), "utf8");
    const reboundAcknowledgment = rebindAcknowledgment
      ? {
        ...acknowledgment,
        observationUtf8Bytes: observationBytes.byteLength,
        observationSha256: sha256Hex(observationBytes),
      }
      : acknowledgment;
    return {
      ...baselineCreateEvidence,
      capturedStdoutBytes: encodeObserverSuccessFrame(observation, reboundAcknowledgment),
    };
  };
  const createOutcomeForEvidence = async (evidence: InvocationEvidenceV1): Promise<string> => {
    const observer = createPhase3NativeObserverV1(binding, {
      async invoke(): Promise<InvocationEvidenceV1> {
        return evidence;
      },
    });
    return (await observer.createNewDurableFile(createRequest)).outcome;
  };
  for (const hostileObservation of [
    { ...baselineCreateObservation, consumer: "wrong-consumer" },
    omit(baselineCreateObservation, "reopenedReadbackSha256"),
    { ...baselineCreateObservation, extra: true },
    { ...baselineCreateObservation, schema: "wrong-schema" },
    { ...baselineCreateObservation, version: "v2" },
    { ...baselineCreateObservation, operation: "read-bound-file" },
    { ...baselineCreateObservation, requestId: "BBBBBBBB-BBBB-4CCC-8DDD-EEEEEEEEEEEE" },
    { ...baselineCreateObservation, requestSha256: "0".repeat(64) },
  ]) {
    assert.equal(
      await createOutcomeForEvidence(createEvidenceWithDocuments(
        hostileObservation,
        baselineCreateAcknowledgment,
        true,
      )),
      "unknown",
    );
  }
  for (const hostileAcknowledgment of [
    { ...baselineCreateAcknowledgment, consumer: "wrong-consumer" },
    omit(baselineCreateAcknowledgment, "observationSha256"),
    { ...baselineCreateAcknowledgment, extra: true },
    { ...baselineCreateAcknowledgment, schema: "wrong-schema" },
    { ...baselineCreateAcknowledgment, version: "v2" },
    { ...baselineCreateAcknowledgment, operation: "read-bound-file" },
    { ...baselineCreateAcknowledgment, requestId: "BBBBBBBB-BBBB-4CCC-8DDD-EEEEEEEEEEEE" },
    { ...baselineCreateAcknowledgment, requestSha256: "0".repeat(64) },
    { ...baselineCreateAcknowledgment, observationSha256: "0".repeat(64) },
  ]) {
    assert.equal(
      await createOutcomeForEvidence(createEvidenceWithDocuments(
        baselineCreateObservation,
        hostileAcknowledgment,
      )),
      "unknown",
    );
  }
  const directoryCreateObservation = {
    ...baselineCreateObservation,
    createdIdentity: { ...baselineCreateObservation.createdIdentity, fileAttributes: "00000010" },
    reopenedIdentity: { ...baselineCreateObservation.reopenedIdentity, fileAttributes: "00000010" },
  };
  assert.equal(
    await createOutcomeForEvidence(createEvidenceWithDocuments(
      directoryCreateObservation,
      baselineCreateAcknowledgment,
      true,
    )),
    "unknown",
  );
  assert.equal(
    await readOutcomeForEvidence({
      ...baselineEvidence,
      evidenceRootAbsolutePath: `${EVIDENCE_ROOT}-hostile`,
    }),
    "unknown",
  );
  assert.equal(
    await createOutcomeForEvidence({
      ...baselineCreateEvidence,
      evidenceRootAbsolutePath: `${EVIDENCE_ROOT}-hostile`,
    }),
    "unknown",
  );

  const observationBytes = Buffer.from(canonicalizeObserverJson(baselineObservation), "utf8");
  const acknowledgmentBytes = Buffer.from(canonicalizeObserverJson(baselineAcknowledgment), "utf8");
  const framingHostiles: InvocationEvidenceV1[] = [
    evidenceWithStdout(Buffer.concat([observationBytes, acknowledgmentBytes])),
    evidenceWithStdout(Buffer.concat([observationBytes, Buffer.from("\n\n"), acknowledgmentBytes])),
    evidenceWithStdout(Buffer.concat([baselineStdout, Buffer.from("\n")])),
    evidenceWithStdout(Buffer.concat([observationBytes.subarray(0, observationBytes.byteLength - 1), Buffer.from("\n"), acknowledgmentBytes])),
    evidenceWithStdout(Buffer.concat([observationBytes, Buffer.from("\n"), acknowledgmentBytes.subarray(0, acknowledgmentBytes.byteLength - 1)])),
    evidenceWithStdout(Buffer.alloc(1_114_114, 0x20)),
    evidenceWithStdout(Buffer.from([0xff])),
    evidenceWithStdout(Buffer.concat([observationBytes, Buffer.from("\n{")])),
    evidenceWithStdout(encodeObserverTerminalFrame(makePreObservationRefusal())),
    evidenceWithStdout(baselineStdout, {
      capturedStderrBytes: Buffer.from("marker", "utf8"),
      stderrState: "nonzero-byte-seen",
      streamClosureState: "incomplete-or-unknown",
    }),
    evidenceWithStdout(baselineStdout, {
      exitState: { kind: "unknown" },
      streamClosureState: "incomplete-or-unknown",
    }),
  ];
  for (const hostileEvidence of framingHostiles) {
    assert.equal(await readOutcomeForEvidence(hostileEvidence), "unknown");
  }
  const markerEvidenceCollisionObserver = createPhase3NativeObserverV1(binding, {
    async invoke(): Promise<InvocationEvidenceV1> {
      return evidenceWithStdout(encodeObserverTerminalFrame(makePreObservationRefusal()));
    },
  });
  const markerEvidenceCollision = await markerEvidenceCollisionObserver.readExactBoundFile(readRequest);
  assert.equal(markerEvidenceCollision.outcome, "unknown");
  assert.equal(markerEvidenceCollision.invocationAttemptCount, 1);
  assert.equal(markerEvidenceCollision.childStarted, true);

  let invalidCalls = 0;
  const invalidObserver = createPhase3NativeObserverV1(binding, {
    async invoke(): Promise<InvocationEvidenceV1> {
      invalidCalls += 1;
      throw new Error("must not invoke");
    },
  });
  const invalid = await invalidObserver.readExactBoundFile({ ...readRequest, requestId: "lowercase" });
  assert.equal(invalid.outcome, "refused");
  assert.equal(invalid.invocationAttemptCount, 0);
  assert.equal(invalid.childStarted, false);
  assert.equal(invalid.terminal.schema, NATIVE_OBSERVER_PRE_OBSERVATION_REFUSAL_SCHEMA);
  assert.equal(invalidCalls, 0);
  for (const mismatch of [
    { method: "read" as const, request: createRequest as any },
    { method: "create" as const, request: readRequest as any },
    { method: "read" as const, request: { ...readRequest, targetPath: 7 } as any },
    { method: "create" as const, request: { ...createRequest, contentBase64: 7 } as any },
  ]) {
    let mismatchCalls = 0;
    const freshObserver = createPhase3NativeObserverV1(binding, {
      async invoke(): Promise<InvocationEvidenceV1> {
        mismatchCalls += 1;
        throw new Error("method/payload mismatch must not reach transport");
      },
    });
    const result = mismatch.method === "read"
      ? await freshObserver.readExactBoundFile(mismatch.request)
      : await freshObserver.createNewDurableFile(mismatch.request);
    assert.equal(result.outcome, "refused");
    assert.equal(result.invocationAttemptCount, 0);
    assert.equal(result.childStarted, false);
    assert.equal(mismatchCalls, 0);
  }
  const createMissingTarget = { ...createRequest } as Record<string, unknown>;
  delete createMissingTarget.targetPath;
  const oversizedPathPrefix = "C:\\fixtures\\rm0032\\";
  const oversizedPath = `${oversizedPathPrefix}${"x".repeat(1_025 - Buffer.byteLength(oversizedPathPrefix, "utf8"))}`;
  const oversizedReadRequest = {
    ...readRequest,
    targetPath: `${readRequest.targetPath}${"x".repeat(65_537 - Buffer.byteLength(canonicalizeObserverJson(readRequest), "utf8"))}`,
  };
  assert.equal(Buffer.byteLength(canonicalizeObserverJson(oversizedReadRequest), "utf8"), 65_537);
  for (const [hostile, expectedBytes, expectedSha256] of [
    [{ ...createRequest, schema: "wrong-schema" }, 299, "1ed1c12b60f22098a8f941e3073c355a8c6c305a0ac574311854bb384032f2ca"],
    [{ ...createRequest, version: "v2" }, 329, "3f7c4f670f75eca26e8d9734b1669cdcdf356315ebfb0c11075f1dea53754833"],
    [{ ...createRequest, consumer: "wrong-consumer" }, 307, "2e813018ad149d62fded462ce2cb8129c22b2577f16c00308e453baa1833a800"],
    [createMissingTarget, 282, "12c152a675877afb357ac27341d3fccc060323fe4999fc0ac9c4cdb425b242df"],
    [{ ...createRequest, extra: true }, 342, "e76a16061b113935c36e61fd1e36411006a2d0a7dd870fd96a2f04a011f3bd81"],
    [{ ...readRequest, operation: "create-new-durable-file" }, 290, "1da89f2e3754204d4e4979b04c47b7e86e18e1ed7a42926a7fd7b1e64baf752e"],
  ] as const) {
    const canonicalBytes = Buffer.from(canonicalizeObserverJson(hostile), "utf8");
    assert.equal(canonicalBytes.byteLength, expectedBytes);
    assert.equal(sha256Hex(canonicalBytes), expectedSha256);
  }
  const correlatedAuthorityAndShapeHostiles: Array<{
    method: "read" | "create";
    request: Record<string, unknown>;
  }> = [
    { method: "read", request: { ...readRequest, schema: "wrong-schema" } },
    { method: "read", request: { ...readRequest, version: "v2" } },
    { method: "read", request: { ...readRequest, consumer: "wrong-consumer" } },
    { method: "read", request: { ...readRequest, unexpected: "forbidden" } },
    { method: "read", request: { ...createRequest } },
    { method: "create", request: { ...readRequest } },
    { method: "create", request: { ...createRequest, schema: "wrong-schema" } },
    { method: "create", request: { ...createRequest, version: "v2" } },
    { method: "create", request: { ...createRequest, consumer: "wrong-consumer" } },
    { method: "create", request: createMissingTarget },
    { method: "create", request: { ...createRequest, extra: true } },
    { method: "create", request: { ...readRequest, operation: "create-new-durable-file" } },
    { method: "create", request: { ...createRequest, extra: { nested: [true, null, 7] } } },
    { method: "create", request: { ...createRequest, extra: ["nested", { safe: true }] } },
    { method: "create", request: { ...createRequest, targetPath: oversizedPath } },
    { method: "create", request: { ...createRequest, schema: "s".repeat(257) } },
    { method: "read", request: oversizedReadRequest },
  ];
  for (const { method, request: hostileRequest } of correlatedAuthorityAndShapeHostiles) {
    let hostileCalls = 0;
    const hostileObserver = createPhase3NativeObserverV1(binding, {
      async invoke(): Promise<InvocationEvidenceV1> {
        hostileCalls += 1;
        throw new Error("correlatable request refusal must not reach transport");
      },
    });
    const result = method === "read"
      ? await hostileObserver.readExactBoundFile(hostileRequest as any)
      : await hostileObserver.createNewDurableFile(hostileRequest as any);
    assert.equal(result.outcome, "refused");
    assert.equal(result.invocationAttemptCount, 0);
    assert.equal(result.childStarted, false);
    assert.equal(result.terminal.schema, NATIVE_OBSERVER_TERMINAL_SCHEMA);
    assert.equal((result.terminal as any).operation, hostileRequest.operation);
    assert.equal((result.terminal as any).requestId, hostileRequest.requestId);
    assert.equal(
      (result.terminal as any).requestSha256,
      sha256Hex(Buffer.from(canonicalizeObserverJson(hostileRequest), "utf8")),
    );
    assert.equal((result.terminal as any).outcome, "refused");
    assert.equal((result.terminal as any).failureStage, "pre-effect");
    assert.equal((result.terminal as any).effectState, "none");
    assert.equal(hostileCalls, 0);
  }

  const correlatedLocalHostiles: Array<ReadBoundFileRequestV1 | CreateNewDurableFileRequestV1> = [
    { ...readRequest, targetPath: "C:\\fixtures\\COM¹" },
    { ...createRequest, contentBase64: "@@==" },
    { ...createRequest, contentBase64: "Zh==" },
    { ...createRequest, contentBase64: Buffer.alloc(262_145).toString("base64") },
  ];
  for (const hostileRequest of correlatedLocalHostiles) {
    const result = hostileRequest.operation === "read-bound-file"
      ? await invalidObserver.readExactBoundFile(hostileRequest)
      : await invalidObserver.createNewDurableFile(hostileRequest);
    assert.equal(result.outcome, "refused");
    assert.equal(result.invocationAttemptCount, 0);
    assert.equal(result.childStarted, false);
    assert.equal(result.terminal.schema, NATIVE_OBSERVER_TERMINAL_SCHEMA);
    assert.equal((result.terminal as any).operation, hostileRequest.operation);
    assert.equal((result.terminal as any).requestId, hostileRequest.requestId);
    assert.equal(
      (result.terminal as any).requestSha256,
      sha256Hex(Buffer.from(canonicalizeObserverJson(hostileRequest), "utf8")),
    );
    assert.equal((result.terminal as any).outcome, "refused");
    assert.equal((result.terminal as any).failureStage, "pre-effect");
    assert.equal((result.terminal as any).effectState, "none");
  }
  assert.equal(invalidCalls, 0);

  const maximumCreateRequest: CreateNewDurableFileRequestV1 = {
    ...createRequest,
    contentBase64: Buffer.alloc(262_144, 0x61).toString("base64"),
  };
  let maximumCreateCalls = 0;
  const maximumCreateObserver = createPhase3NativeObserverV1(binding, {
    async invoke(input): Promise<InvocationEvidenceV1> {
      maximumCreateCalls += 1;
      assert.ok(input.canonicalRequestBytes.byteLength <= 393_216);
      return knownCreateEvidence(maximumCreateRequest, identity);
    },
  });
  assert.equal((await maximumCreateObserver.createNewDurableFile(maximumCreateRequest)).outcome, "known");
  assert.equal(maximumCreateCalls, 1);

  for (const preCapHostile of [
    { ...createRequest, contentBase64: Buffer.alloc(262_145, 0x61).toString("base64") },
    { ...createRequest, unexpected: "x".repeat(1_048_577) },
  ]) {
    let preCapCalls = 0;
    const preCapObserver = createPhase3NativeObserverV1(binding, {
      async invoke(): Promise<InvocationEvidenceV1> {
        preCapCalls += 1;
        throw new Error("pre-cap refusal must not reach transport");
      },
    });
    const preCapResult = await preCapObserver.createNewDurableFile(preCapHostile as any);
    assert.equal(preCapResult.outcome, "refused");
    assert.equal(preCapResult.invocationAttemptCount, 0);
    assert.equal(preCapResult.childStarted, false);
    assert.equal(preCapCalls, 0);
  }

  let stoppedCalls = 0;
  const stoppedObserver = createPhase3NativeObserverV1(binding, {
    async invoke(): Promise<InvocationEvidenceV1> {
      stoppedCalls += 1;
      return {
        kind: "child-never-started",
        invocationAttemptCount: 1,
        evidenceRootAbsolutePath: EVIDENCE_ROOT,
        childStarted: false,
        capturedStdoutBytes: Buffer.alloc(0),
        capturedStderrBytes: Buffer.alloc(0),
        stdoutState: "not-opened",
        stderrState: "not-opened",
        streamClosureState: "not-opened",
        exitState: { kind: "not-started" },
      };
    },
  });
  const neverStarted = await stoppedObserver.readExactBoundFile(readRequest);
  assert.equal(neverStarted.outcome, "unknown");
  assert.equal(neverStarted.invocationAttemptCount, 1);
  assert.equal(neverStarted.childStarted, false);
  const stopped = await stoppedObserver.readExactBoundFile(readRequest);
  assert.equal(stopped.outcome, "unknown");
  assert.equal(stopped.invocationAttemptCount, 0);
  assert.equal(stopped.childStarted, false);
  assert.equal(stoppedCalls, 1);

  const terminalMatrices = [
    {
      method: "read" as const,
      request: readRequest,
      baseEvidence: baselineEvidence,
      tuples: [
        ["refused", "pre-effect", "none"],
        ["unknown", "pre-effect", "none"],
        ["refused", "read-observation", "none"],
        ["unknown", "read-observation", "none"],
      ] as const,
    },
    {
      method: "create" as const,
      request: createRequest,
      baseEvidence: baselineCreateEvidence,
      tuples: [
        ["refused", "pre-effect", "none"],
        ["unknown", "pre-effect", "none"],
        ["refused", "create-collision", "not-created"],
        ["unknown", "post-create", "possibly-created"],
      ] as const,
    },
  ];
  for (const matrix of terminalMatrices) {
    const requestSha256 = sha256Hex(Buffer.from(canonicalizeObserverJson(matrix.request), "utf8"));
    for (const [outcome, failureStage, effectState] of matrix.tuples) {
      let terminalCalls = 0;
      const terminal = makeCorrelatedTerminal(
        matrix.request.operation,
        matrix.request.requestId,
        requestSha256,
        outcome,
        failureStage,
        effectState,
      );
      const terminalObserver = createPhase3NativeObserverV1(binding, {
        async invoke(): Promise<InvocationEvidenceV1> {
          terminalCalls += 1;
          return {
            ...matrix.baseEvidence,
            capturedStdoutBytes: encodeObserverTerminalFrame(terminal),
          };
        },
      });
      const terminalResult = matrix.method === "read"
        ? await terminalObserver.readExactBoundFile(matrix.request as ReadBoundFileRequestV1)
        : await terminalObserver.createNewDurableFile(matrix.request as CreateNewDurableFileRequestV1);
      assert.equal(terminalResult.outcome, outcome);
      assert.equal(terminalResult.invocationAttemptCount, 1);
      assert.equal(terminalResult.childStarted, true);
      assert.equal(terminalCalls, 1);
      const stoppedResult = matrix.method === "read"
        ? await terminalObserver.readExactBoundFile(matrix.request as ReadBoundFileRequestV1)
        : await terminalObserver.createNewDurableFile(matrix.request as CreateNewDurableFileRequestV1);
      assert.equal(stoppedResult.outcome, "unknown");
      assert.equal(stoppedResult.invocationAttemptCount, 0);
      assert.equal(stoppedResult.childStarted, false);
      assert.equal(terminalCalls, 1);
    }

    const startedBaseEvidence = matrix.baseEvidence as Extract<InvocationEvidenceV1, { kind: "child-started" }>;
    const evidenceHostiles: InvocationEvidenceV1[] = [
      { ...startedBaseEvidence, exitState: { kind: "known", code: 1 } },
      {
        ...startedBaseEvidence,
        stdoutState: "not-eof-or-unknown",
        streamClosureState: "incomplete-or-unknown",
      },
      { ...startedBaseEvidence, streamClosureState: "incomplete-or-unknown" },
      {
        ...startedBaseEvidence,
        stderrState: "nonzero-byte-seen",
        streamClosureState: "incomplete-or-unknown",
      },
      {
        ...startedBaseEvidence,
        exitState: { kind: "unknown" },
        streamClosureState: "incomplete-or-unknown",
      },
    ];
    for (const hostileEvidence of evidenceHostiles) {
      const evidenceObserver = createPhase3NativeObserverV1(binding, {
        async invoke(): Promise<InvocationEvidenceV1> {
          return hostileEvidence;
        },
      });
      const evidenceResult = matrix.method === "read"
        ? await evidenceObserver.readExactBoundFile(matrix.request as ReadBoundFileRequestV1)
        : await evidenceObserver.createNewDurableFile(matrix.request as CreateNewDurableFileRequestV1);
      assert.equal(evidenceResult.outcome, "unknown");
      assert.equal(evidenceResult.invocationAttemptCount, 1);
    }
  }

  const childNeverStartedEvidence = (): InvocationEvidenceV1 => ({
    kind: "child-never-started",
    invocationAttemptCount: 1,
    evidenceRootAbsolutePath: EVIDENCE_ROOT,
    childStarted: false,
    capturedStdoutBytes: Buffer.alloc(0),
    capturedStderrBytes: Buffer.alloc(0),
    stdoutState: "not-opened",
    stderrState: "not-opened",
    streamClosureState: "not-opened",
    exitState: { kind: "not-started" },
  });
  async function assertChildNeverStartedDominatesPostAwaitAmbiguity(
    method: "read" | "create",
    request: ReadBoundFileRequestV1 | CreateNewDurableFileRequestV1,
  ): Promise<void> {
    const originalPerformance = globalThis.performance;
    let monotonicNow = 1_000;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => monotonicNow },
    });
    try {
      let calls = 0;
      let capturedRequestBytes: Uint8Array | undefined;
      let resolveEvidence!: (evidence: InvocationEvidenceV1) => void;
      const observer = createPhase3NativeObserverV1(binding, {
        async invoke(input): Promise<InvocationEvidenceV1> {
          calls += 1;
          capturedRequestBytes = input.canonicalRequestBytes;
          return await new Promise<InvocationEvidenceV1>((resolve) => {
            resolveEvidence = resolve;
          });
        },
      });
      const invokeOperation = () => method === "read"
        ? observer.readExactBoundFile(request as ReadBoundFileRequestV1)
        : observer.createNewDurableFile(request as CreateNewDurableFileRequestV1);
      const pending = invokeOperation();
      assert.ok(capturedRequestBytes);
      const concurrent = await invokeOperation();
      assert.equal(concurrent.outcome, "unknown");
      assert.equal(concurrent.invocationAttemptCount, 0);
      assert.equal(concurrent.childStarted, false);
      assert.equal((concurrent.terminal as any).failureStage, "pre-effect");
      assert.equal((concurrent.terminal as any).effectState, "none");
      capturedRequestBytes[0] ^= 0x01;
      monotonicNow = 20_000;
      resolveEvidence(childNeverStartedEvidence());
      const result = await pending;
      assert.equal(result.outcome, "unknown");
      assert.equal(result.invocationAttemptCount, 1);
      assert.equal(result.childStarted, false);
      assert.equal((result.terminal as any).operation, request.operation);
      assert.equal((result.terminal as any).requestId, request.requestId);
      assert.equal((result.terminal as any).failureStage, "pre-effect");
      assert.equal((result.terminal as any).effectState, "none");
      const stoppedFollowup = await invokeOperation();
      assert.equal(stoppedFollowup.outcome, "unknown");
      assert.equal(stoppedFollowup.invocationAttemptCount, 0);
      assert.equal(stoppedFollowup.childStarted, false);
      assert.equal((stoppedFollowup.terminal as any).failureStage, "pre-effect");
      assert.equal((stoppedFollowup.terminal as any).effectState, "none");
      assert.equal(calls, 1);
    } finally {
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: originalPerformance,
      });
    }
  }
  await assertChildNeverStartedDominatesPostAwaitAmbiguity("read", readRequest);
  await assertChildNeverStartedDominatesPostAwaitAmbiguity("create", createRequest);

  const malformedNeverStartedObserver = createPhase3NativeObserverV1(binding, {
    async invoke(input): Promise<InvocationEvidenceV1> {
      input.canonicalRequestBytes[0] ^= 0x01;
      return {
        ...childNeverStartedEvidence(),
        capturedStdoutBytes: Buffer.from("malformed", "utf8"),
      } as InvocationEvidenceV1;
    },
  });
  const malformedNeverStarted = await malformedNeverStartedObserver.readExactBoundFile(readRequest);
  assert.equal(malformedNeverStarted.outcome, "unknown");
  assert.equal(malformedNeverStarted.invocationAttemptCount, 1);
  assert.equal(malformedNeverStarted.childStarted, "unknown");

  const malformedEvidenceObserver = createPhase3NativeObserverV1(binding, {
    async invoke(): Promise<InvocationEvidenceV1> {
      return {
        kind: "child-started",
        invocationAttemptCount: 1,
        evidenceRootAbsolutePath: EVIDENCE_ROOT,
        childStarted: true,
        capturedStdoutBytes: Buffer.alloc(0),
        capturedStderrBytes: Buffer.alloc(0),
        stdoutState: "eof",
        stderrState: "eof-zero-bytes",
        streamClosureState: "incomplete-or-unknown",
        exitState: { kind: "known", code: 0 },
      };
    },
  });
  const malformed = await malformedEvidenceObserver.readExactBoundFile(readRequest);
  assert.equal(malformed.outcome, "unknown");
  assert.equal(malformed.invocationAttemptCount, 1);

  const stderrMarkerObserver = createPhase3NativeObserverV1(binding, {
    async invoke(): Promise<InvocationEvidenceV1> {
      return {
        kind: "child-started",
        invocationAttemptCount: 1,
        evidenceRootAbsolutePath: EVIDENCE_ROOT,
        childStarted: true,
        capturedStdoutBytes: Buffer.alloc(0),
        capturedStderrBytes: Buffer.alloc(0),
        stdoutState: "not-eof-or-unknown",
        stderrState: "nonzero-byte-seen",
        streamClosureState: "incomplete-or-unknown",
        exitState: { kind: "unknown" },
      };
    },
  });
  const stderrMarker = await stderrMarkerObserver.readExactBoundFile(readRequest);
  assert.equal(stderrMarker.outcome, "unknown");
  assert.equal(stderrMarker.childStarted, true);

  let resolveEvidence!: (evidence: InvocationEvidenceV1) => void;
  const concurrentObserver = createPhase3NativeObserverV1(binding, {
    async invoke(): Promise<InvocationEvidenceV1> {
      return await new Promise<InvocationEvidenceV1>((resolve) => {
        resolveEvidence = resolve;
      });
    },
  });
  const first = concurrentObserver.readExactBoundFile(readRequest);
  const concurrent = await concurrentObserver.readExactBoundFile(readRequest);
  assert.equal(concurrent.outcome, "unknown");
  assert.equal(concurrent.invocationAttemptCount, 0);
  resolveEvidence(knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet")));
  const lateFirst = await first;
  assert.equal(lateFirst.outcome, "unknown");
  assert.equal(lateFirst.invocationAttemptCount, 1);

  {
    const originalPerformance = globalThis.performance;
    let sampleCount = 0;
    const aggregateDeadlines: number[] = [];
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => 1_000 + sampleCount++ },
    });
    try {
      const perInvocationObserver = createPhase3NativeObserverV1(binding, {
        async invoke(input): Promise<InvocationEvidenceV1> {
          aggregateDeadlines.push(input.deadlineContext.aggregateDeadlineMonotonicMs);
          return knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet"));
        },
      });
      assert.equal(sampleCount, 0, "observer construction must not start the aggregate clock");
      assert.equal((await perInvocationObserver.readExactBoundFile(readRequest)).outcome, "known");
      assert.equal((await perInvocationObserver.readExactBoundFile(readRequest)).outcome, "known");
      assert.deepEqual(aggregateDeadlines, [16_000, 16_005]);
      assert.equal(sampleCount, 10);
    } finally {
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: originalPerformance,
      });
    }
  }

  for (const method of ["read", "create"] as const) {
    const originalPerformance = globalThis.performance;
    const samples = [1_000, 1_000, 1_000, 1_000, 11_000];
    let sampleIndex = 0;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => samples[Math.min(sampleIndex++, samples.length - 1)] },
    });
    try {
      let postParseCalls = 0;
      const postParseObserver = createPhase3NativeObserverV1(binding, {
        async invoke(): Promise<InvocationEvidenceV1> {
          postParseCalls += 1;
          return method === "read"
            ? knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet"))
            : knownCreateEvidence(createRequest, identity);
        },
      });
      const result = method === "read"
        ? await postParseObserver.readExactBoundFile(readRequest)
        : await postParseObserver.createNewDurableFile(createRequest);
      assert.equal(result.outcome, "unknown");
      assert.equal(result.invocationAttemptCount, 1);
      assert.equal(postParseCalls, 1);
      assert.equal(sampleIndex, 5);
    } finally {
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: originalPerformance,
      });
    }
  }

  for (const clockFault of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
    for (const method of ["read", "create"] as const) {
      const originalPerformance = globalThis.performance;
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: { now: () => clockFault },
      });
      try {
        let clockFaultCalls = 0;
        const clockFaultObserver = createPhase3NativeObserverV1(binding, {
          async invoke(): Promise<InvocationEvidenceV1> {
            clockFaultCalls += 1;
            throw new Error("clock fault must fail before transport");
          },
        });
        const result = method === "read"
          ? await clockFaultObserver.readExactBoundFile(readRequest)
          : await clockFaultObserver.createNewDurableFile(createRequest);
        assert.equal(result.outcome, "unknown");
        assert.equal(result.invocationAttemptCount, 0);
        assert.equal(result.childStarted, false);
        assert.equal(clockFaultCalls, 0);
      } finally {
        Object.defineProperty(globalThis, "performance", {
          configurable: true,
          value: originalPerformance,
        });
      }
    }
  }

  {
    const originalPerformance = globalThis.performance;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    type ManualTimer = {
      id: number;
      delay: number;
      callback: () => void;
      state: "active" | "fired" | "cleared";
    };
    let timers: ManualTimer[] = [];
    let monotonicNow = 1_000;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => monotonicNow },
    });
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: ((callback: () => void, delay?: number) => {
        const timer: ManualTimer = {
          id: timers.length + 1,
          delay: delay ?? 0,
          callback,
          state: "active",
        };
        timers.push(timer);
        return timer.id as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: ((handle: ReturnType<typeof setTimeout>) => {
        const timer = timers.find((candidate) => candidate.id === Number(handle));
        assert.ok(timer, "clearTimeout must target a known manual timer");
        if (timer.state === "active") timer.state = "cleared";
      }) as typeof clearTimeout,
    });
    try {
      const yieldTurn = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve));
      const fire = (timer: ManualTimer, nowMonotonicMs: number): void => {
        assert.equal(timer.state, "active");
        monotonicNow = nowMonotonicMs;
        timer.state = "fired";
        timer.callback();
      };
      for (const method of ["read", "create"] as const) {
        for (const settlementMode of [
          "success-before-deadline",
          "fulfilled-during-drain",
          "rejected-during-drain",
          "malformed-during-drain",
          "never-started-during-drain",
          "drain-expires",
        ] as const) {
          timers = [];
          monotonicNow = 1_000;
          let transportCalls = 0;
          let terminationRequests = 0;
          let resolveEvidence!: (evidence: InvocationEvidenceV1) => void;
          let rejectEvidence!: (error: Error) => void;
          const deferred = new Promise<InvocationEvidenceV1>((resolve, reject) => {
            resolveEvidence = resolve;
            rejectEvidence = reject;
          });
          const observer = createPhase3NativeObserverV1(binding, {
            async invoke(input): Promise<InvocationEvidenceV1> {
              assert.equal(arguments.length, 1, "the exact transport port accepts one input argument");
              transportCalls += 1;
              assert.deepEqual(Object.keys(input).sort(), ["acceptedBinding", "canonicalRequestBytes", "deadlineContext"]);
              assert.equal(Object.isFrozen(input), true);
              assert.equal(Object.isFrozen(input.acceptedBinding), true);
              assert.equal(Object.isFrozen(input.deadlineContext), true);
              assert.deepEqual(input.deadlineContext, {
                aggregateDeadlineMonotonicMs: 16_000,
                operationDeadlineMonotonicMs: 11_000,
              });
              const termination = new TerminationRequestLatch();
              const terminationTimer = setTimeout(() => {
                termination.request();
                terminationRequests += 1;
              }, input.deadlineContext.aggregateDeadlineMonotonicMs - monotonicNow);
              try {
                return await deferred;
              } finally {
                clearTimeout(terminationTimer);
              }
            },
          });
          const request = method === "read" ? readRequest : createRequest;
          let pendingSettled = false;
          const pending = (method === "read"
            ? observer.readExactBoundFile(readRequest)
            : observer.createNewDurableFile(createRequest))
            .finally(() => {
              pendingSettled = true;
            });
          assert.equal(transportCalls, 1);
          assert.equal(timers.length, 2);
          assert.deepEqual(timers.map((timer) => timer.delay), [15_000, 20_000]);
          assert.equal(terminationRequests, 0, "operation expiry must not request transport termination");
          assert.equal(pendingSettled, false);
          assert.equal(timers[0].state, "active");
          assert.equal(timers[1].state, "active");

          if (settlementMode === "success-before-deadline") {
            resolveEvidence(method === "read"
              ? knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet"))
              : knownCreateEvidence(createRequest, identity));
          } else {
            fire(timers[0], 16_000);
            await yieldTurn();
            assert.equal(pendingSettled, false);
            assert.equal(terminationRequests, 1);
            if (settlementMode === "fulfilled-during-drain") {
              resolveEvidence(method === "read"
                ? knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet"))
                : knownCreateEvidence(createRequest, identity));
            } else if (settlementMode === "rejected-during-drain") {
              rejectEvidence(new Error("transport rejection during drain"));
            } else if (settlementMode === "malformed-during-drain") {
              resolveEvidence({
                ...(method === "read"
                  ? knownReadEvidence(readRequest, identity, Buffer.from("tracer-bullet"))
                  : knownCreateEvidence(createRequest, identity)),
                evidenceRootAbsolutePath: `${EVIDENCE_ROOT}\\drift`,
              } as InvocationEvidenceV1);
            } else if (settlementMode === "never-started-during-drain") {
              resolveEvidence(childNeverStartedEvidence());
            } else {
              fire(timers[1], 21_000);
            }
          }
          const result = await pending;
          if (settlementMode === "success-before-deadline") {
            assert.equal(result.outcome, "known");
            assert.equal(terminationRequests, 0);
          } else {
            const neverStarted = settlementMode === "never-started-during-drain";
            const failureStage = neverStarted
              ? "pre-effect"
              : method === "read" ? "read-observation" : "post-create";
            const effectState = neverStarted
              ? "none"
              : method === "read" ? "none" : "possibly-created";
            const childStarted = settlementMode === "fulfilled-during-drain"
              ? true
              : neverStarted ? false : "unknown";
            assert.deepEqual(result, {
              outcome: "unknown",
              terminal: makeCorrelatedTerminal(
                request.operation,
                request.requestId,
                sha256Hex(Buffer.from(canonicalizeObserverJson(request), "utf8")),
                "unknown",
                failureStage,
                effectState,
              ),
              invocationAttemptCount: 1,
              childStarted,
            });
          }
          assert.equal(timers.filter((timer) => timer.state === "active").length, 0);
          assert.equal(transportCalls, 1);
          if (settlementMode !== "success-before-deadline") {
            for (const followupMethod of ["read", "create"] as const) {
              const stopped = followupMethod === "read"
                ? await observer.readExactBoundFile(readRequest)
                : await observer.createNewDurableFile(createRequest);
              assert.equal(stopped.outcome, "unknown");
              assert.equal(stopped.invocationAttemptCount, 0);
              assert.equal(stopped.childStarted, false);
              assert.equal((stopped.terminal as any).failureStage, "pre-effect");
              assert.equal((stopped.terminal as any).effectState, "none");
            }
            assert.equal(transportCalls, 1);
            assert.equal(terminationRequests, 1);
          }
          assert.deepEqual(timers.map((timer) => timer.delay), [15_000, 20_000]);
          if (settlementMode === "drain-expires") {
            if (method === "read") rejectEvidence(new Error("late rejection must be consumed"));
            else resolveEvidence(knownCreateEvidence(createRequest, identity));
            await yieldTurn();
            assert.equal(transportCalls, 1);
            assert.equal(terminationRequests, 1);
            assert.equal(timers.filter((timer) => timer.state === "active").length, 0);
          }
        }
      }
    } finally {
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: originalPerformance,
      });
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: originalSetTimeout,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        value: originalClearTimeout,
      });
    }
  }

  assert.deepEqual(parseRawGroupSelector([]), { mode: "aggregate" });
  assert.deepEqual(
    parseRawGroupSelector(["--test-name-pattern", "^fixture-group:canonical$"]),
    { mode: "group", pattern: "^fixture-group:canonical$" },
  );
  for (const rawSelectorArgs of [
    ["--test-name-pattern", ""],
    ["--test-name-pattern", "^fixture-group:unknown$"],
    ["--test-name-pattern=^fixture-group:canonical$"],
    ["--test-name-pattern", "fixture-group:canonical$"],
    ["--test-name-pattern", "^fixture-group:canonical$", "--test-name-pattern", "^fixture-group:canonical$"],
    ["--test-name-pattern", "^fixture-group:canonical$", "--test-name-pattern", "^fixture-group:scalar$"],
  ]) {
    assert.throws(() => parseRawGroupSelector(rawSelectorArgs), /selector/u);
  }
  assert.deepEqual(
    parseProcessGroupSelector([
      "--test-name-pattern",
      "^fixture-group:canonical$",
    ]),
    { mode: "group", pattern: "^fixture-group:canonical$" },
  );
  assert.equal(
    fixtureGroupPassEvidence("canonical", { mode: "aggregate" }),
    "fixture-group:canonical:PASS matchedTestCount=1 failedTestCount=0",
  );
  assert.equal(
    fixtureGroupPassEvidence("adapter", { mode: "aggregate" }, true),
    "fixture-group:adapter:PASS matchedTestCount=1 failedTestCount=0 8-tests-passed",
  );
  assert.equal(
    fixtureGroupPassEvidence("scalar", { mode: "group", pattern: "^fixture-group:scalar$" }),
    "fixture-group:scalar:PASS matchedTestCount=1 failedTestCount=0 1-tests-passed",
  );
  assert.throws(
    () => fixtureGroupPassEvidence("unknown" as (typeof GROUP_FAMILIES)[number], { mode: "aggregate" }, true),
    /not admitted/u,
  );
  assert.deepEqual(
    parseProcessGroupSelector([
      "--test-name-pattern=fixture-group:canonical$",
      "--experimental-strip-types",
      "--test-name-pattern",
      "fixture-group:canonical$",
    ]),
    { mode: "group", pattern: "^fixture-group:canonical$" },
  );
  for (const childSelectorArgs of [
    ["--test-name-pattern=^fixture-group:canonical$"],
    ["--test-name-pattern", ""],
    ["--test-name-pattern", "^fixture-group:unknown$"],
    ["--test-name-pattern", "fixture-group:canonical$"],
    ["--test-name-pattern", "^fixture-group:.*$"],
    ["--test-name-pattern=^fixture-group:canonical$", "--test-name-pattern=^fixture-group:canonical$"],
    ["--test-name-pattern", "^fixture-group:canonical$", "--test-name-pattern", "^fixture-group:canonical$"],
    ["--test-name-pattern=^fixture-group:canonical$", "--test-name-pattern", "^fixture-group:scalar$"],
    ["--test-name-pattern", "^fixture-group:canonical$", "unexpected-trailing-token"],
  ]) {
    assert.throws(() => parseProcessGroupSelector(childSelectorArgs), /selector/u);
  }

  const thisTestFile = fileURLToPath(import.meta.url);
  const selectorEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
  );
  const selectorSuccess = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", "--test-name-pattern", "^fixture-group:canonical$", thisTestFile],
    { encoding: "utf8", env: selectorEnvironment },
  );
  assert.equal(
    selectorSuccess.status,
    0,
    `canonical separated selector failed: stdout=${selectorSuccess.stdout} stderr=${selectorSuccess.stderr}`,
  );
  assert.match(selectorSuccess.stdout, /fixture-group:canonical:PASS matchedTestCount=1 failedTestCount=0 1-tests-passed/u);
  assert.doesNotMatch(selectorSuccess.stdout, /fixture-group:scalar:PASS/u);
  for (const selectorArgs of [
    ["--test-name-pattern", ""],
    ["--test-name-pattern", "^fixture-group:unknown$"],
    ["--test-name-pattern=^fixture-group:canonical$"],
    ["--test-name-pattern", "^fixture-group:.*$"],
    ["--test-name-pattern=^fixture-group:canonical$", "--test-name-pattern=^fixture-group:canonical$"],
    ["--test-name-pattern", "^fixture-group:canonical$", "--test-name-pattern", "^fixture-group:canonical$"],
    ["--test-name-pattern", "^fixture-group:canonical$", "--test-name-pattern", "^fixture-group:scalar$"],
  ]) {
    const selectorFailure = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--test", ...selectorArgs, thisTestFile],
      { encoding: "utf8", env: selectorEnvironment },
    );
    assert.notEqual(
      selectorFailure.status,
      0,
      `selector unexpectedly admitted: ${JSON.stringify(selectorArgs)} stdout=${selectorFailure.stdout} stderr=${selectorFailure.stderr}`,
    );
    assert.doesNotMatch(`${selectorFailure.stdout}${selectorFailure.stderr}`, /fixture-group:.*:PASS/u);
    assert.doesNotMatch(`${selectorFailure.stdout}${selectorFailure.stderr}`, /(?:^|\s)1-tests-passed(?:\s|$)/u);
  }
  console.log(fixtureGroupPassEvidence("adapter", processGroupSelector, true));
});
