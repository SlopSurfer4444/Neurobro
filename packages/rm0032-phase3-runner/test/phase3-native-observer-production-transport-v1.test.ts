import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NATIVE_OBSERVER_ACKNOWLEDGMENT_SCHEMA,
  NATIVE_OBSERVER_CONSUMER,
  NATIVE_OBSERVER_OBSERVATION_SCHEMA,
  NATIVE_OBSERVER_REQUEST_SCHEMA,
  NATIVE_OBSERVER_VERSION,
  canonicalizeObserverJson,
  createPhase3NativeObserverV1,
  encodeObserverSuccessFrame,
  sha256Hex,
  type CreateNewDurableFileRequestV1,
  type InvocationEvidenceV1,
  type NativeObserverInvocationInputV1,
  type ReadBoundFileRequestV1,
} from "../src/phase3-native-observer-adapter-v1.ts";
import {
  createPhase3NativeObserverProductionTransportV1,
  type AcceptedNativeObserverLauncherBindingV1,
  type NativeObserverLauncherPortInputV1,
  type NativeObserverLauncherPortResultV1,
  type Phase3NativeObserverLauncherPortV1,
} from "../src/phase3-native-observer-production-transport-v1.ts";

const FIXTURE_PATH = new URL("../fixtures/phase3-native-observer-launcher-v1.json", import.meta.url);
const CARRIER_SHA256 = "22".repeat(32);
const LAUNCHER_SHA256 = "33".repeat(32);
const OBSERVER_SHA256 = "44".repeat(32);
const EVIDENCE_ROOT = "C:\\ProgramData\\DecadansNeurobro\\accepted-evidence-v1";
const REQUEST: ReadBoundFileRequestV1 = {
  schema: NATIVE_OBSERVER_REQUEST_SCHEMA,
  version: NATIVE_OBSERVER_VERSION,
  consumer: NATIVE_OBSERVER_CONSUMER,
  operation: "read-bound-file",
  requestId: "11111111-1111-4111-8111-111111111111",
  rootPath: "C:\\fixtures\\rm0032",
  targetPath: "C:\\fixtures\\rm0032\\bound.txt",
};
const REQUEST_BYTES = Buffer.from(canonicalizeObserverJson(REQUEST), "utf8");
const CREATE_REQUEST: CreateNewDurableFileRequestV1 = {
  schema: NATIVE_OBSERVER_REQUEST_SCHEMA,
  version: NATIVE_OBSERVER_VERSION,
  consumer: NATIVE_OBSERVER_CONSUMER,
  operation: "create-new-durable-file",
  requestId: "22222222-2222-4222-8222-222222222222",
  rootPath: "C:\\fixtures\\rm0032",
  targetPath: "C:\\fixtures\\rm0032\\created.txt",
  contentBase64: Buffer.from("production-create-tracer", "utf8").toString("base64"),
};
const CREATE_REQUEST_BYTES = Buffer.from(canonicalizeObserverJson(CREATE_REQUEST), "utf8");
const BINDING: AcceptedNativeObserverLauncherBindingV1 = {
  launcherAbsolutePath: "C:\\Program Files\\DecadansNeurobro\\rm0032-phase3-native-observer-launcher-v1.exe",
  launcherSha256: LAUNCHER_SHA256,
  carrierSha256: CARRIER_SHA256,
  acceptedObserverBinding: {
    observerAbsolutePath: "C:\\Program Files\\DecadansNeurobro\\rm0032-phase3-native-observer-v1.exe",
    observerSha256: OBSERVER_SHA256,
    evidenceRootAbsolutePath: EVIDENCE_ROOT,
  },
};

type Header = {
  schema: string;
  version: string;
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
};

type JsonRecord = Record<string, any>;

function deadlineContext(): NativeObserverInvocationInputV1["deadlineContext"] {
  const now = Math.floor(performance.now());
  return { aggregateDeadlineMonotonicMs: now + 14_000, operationDeadlineMonotonicMs: now + 9_000 };
}

function invocationInput(bytes: Uint8Array = REQUEST_BYTES): NativeObserverInvocationInputV1 {
  return {
    canonicalRequestBytes: bytes,
    acceptedBinding: BINDING.acceptedObserverBinding,
    deadlineContext: deadlineContext(),
  };
}

function splitSupervisorInput(input: NativeObserverLauncherPortInputV1): { header: Header; headerBytes: Buffer; payloadBytes: Buffer } {
  const bytes = Buffer.from(input.canonicalSupervisorInputBytes);
  const lf = bytes.indexOf(0x0a);
  assert.ok(lf > 0);
  assert.equal(bytes.indexOf(0x0a, lf + 1), -1);
  const headerBytes = bytes.subarray(0, lf);
  const payloadBytes = bytes.subarray(lf + 1);
  const header = JSON.parse(headerBytes.toString("utf8")) as Header;
  return { header, headerBytes, payloadBytes };
}

function supervisorLedgerIdentity(headerBytes: Uint8Array, payloadBytes: Uint8Array): string {
  return sha256Hex(Buffer.concat([
    Buffer.from("decadans.rm0032.launcher-ledger-identity.v2\0", "utf8"),
    Buffer.from("stage=supervisor-before-worker", "utf8"),
    Buffer.from("\0header=", "utf8"),
    Buffer.from(sha256Hex(headerBytes), "utf8"),
    Buffer.from("\0payload=", "utf8"),
    Buffer.from(sha256Hex(payloadBytes), "utf8"),
  ]));
}

function observerSuccessStdout(header: Header): Buffer {
  const content = Buffer.from("production-transport-tracer", "utf8");
  const identity = {
    volumeSerialNumber: "0011223344556677",
    fileId: "00112233445566778899aabbccddeeff",
    size: String(content.byteLength),
    lastWriteTime: "133700000000000000",
    fileAttributes: "00000020",
    finalPath: "\\\\?\\C:\\fixtures\\rm0032\\bound.txt",
  };
  const observation = {
    schema: NATIVE_OBSERVER_OBSERVATION_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    operation: "read-bound-file",
    requestId: header.requestId,
    requestSha256: header.stdinSha256,
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
    requestId: header.requestId,
    requestSha256: header.stdinSha256,
    observationUtf8Bytes: observationBytes.byteLength,
    observationSha256: sha256Hex(observationBytes),
    outcome: "known",
  };
  return encodeObserverSuccessFrame(observation, acknowledgment);
}

function observerCreateSuccessStdout(header: Header, request: CreateNewDurableFileRequestV1): Buffer {
  const content = Buffer.from(request.contentBase64, "base64");
  const contentSha256 = sha256Hex(content);
  const identity = {
    volumeSerialNumber: "0011223344556677",
    fileId: "11223344556677889900aabbccddeeff",
    size: String(content.byteLength),
    lastWriteTime: "133700000000000001",
    fileAttributes: "00000020",
    finalPath: `\\\\?\\${request.targetPath}`,
  };
  const observation = {
    schema: NATIVE_OBSERVER_OBSERVATION_SCHEMA,
    version: NATIVE_OBSERVER_VERSION,
    consumer: NATIVE_OBSERVER_CONSUMER,
    operation: "create-new-durable-file",
    requestId: header.requestId,
    requestSha256: header.stdinSha256,
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
    requestId: header.requestId,
    requestSha256: header.stdinSha256,
    observationUtf8Bytes: observationBytes.byteLength,
    observationSha256: sha256Hex(observationBytes),
    outcome: "known",
  };
  return encodeObserverSuccessFrame(observation, acknowledgment);
}

function launcherResultObject(parts: ReturnType<typeof splitSupervisorInput>): JsonRecord {
  const observerStdout = observerSuccessStdout(parts.header);
  return {
    schema: "decadans.rm0032.native-observer-launcher-result.v1",
    requestId: parts.header.requestId,
    correlationId: parts.header.correlationId,
    carrierSha256: parts.header.carrierSha256,
    observerImageSha256: parts.header.observerImageSha256,
    stdinSha256: parts.header.stdinSha256,
    deadlineMs: parts.header.deadlineMs,
    ledgerIdentitySha256: supervisorLedgerIdentity(parts.headerBytes, parts.payloadBytes),
    terminal: "success",
    reason: "bounded fixed launcher invocation succeeded",
    invocationAttemptCount: 1,
    childStartEvidence: "started",
    childStarted: "true",
    ledgerState: "durable-consumed",
    sticky: false,
    handlesReleased: true,
    evidence: {
      kind: "child-started",
      invocationAttemptCount: 1,
      childStarted: true,
      capturedStdoutBase64: observerStdout.toString("base64"),
      capturedStderrBase64: "",
      stdoutState: "eof",
      stderrState: "eof-zero-bytes",
      streamClosureState: "both-eof",
      exitState: { kind: "known", code: 0 },
    },
  };
}

function portResult(stdout: Uint8Array, overrides: Partial<NativeObserverLauncherPortResultV1> = {}): NativeObserverLauncherPortResultV1 {
  return {
    invocationAttemptCount: 1,
    launcherStarted: true,
    exitCode: 0,
    stdout,
    stderr: Buffer.alloc(0),
    stdoutComplete: true,
    stderrComplete: true,
    ...overrides,
  };
}

function fakePort(
  mutate: (result: JsonRecord, parts: ReturnType<typeof splitSupervisorInput>, input: NativeObserverLauncherPortInputV1) => Uint8Array = (result) => Buffer.from(JSON.stringify(result), "utf8"),
): { port: Phase3NativeObserverLauncherPortV1; calls: () => number; inputs: NativeObserverLauncherPortInputV1[] } {
  let callCount = 0;
  const inputs: NativeObserverLauncherPortInputV1[] = [];
  return {
    calls: () => callCount,
    inputs,
    port: {
      async invoke(input): Promise<NativeObserverLauncherPortResultV1> {
        callCount += 1;
        inputs.push(input);
        const parts = splitSupervisorInput(input);
        const result = launcherResultObject(parts);
        return portResult(mutate(result, parts, input));
      },
    },
  };
}

function assertAmbiguous(evidence: InvocationEvidenceV1): void {
  assert.equal(evidence.kind, "child-start-ambiguous");
  assert.equal(evidence.childStarted, "unknown");
  assert.equal(evidence.invocationAttemptCount, 1);
  assert.equal(evidence.capturedStdoutBytes.byteLength, 0);
  assert.equal(evidence.capturedStderrBytes.byteLength, 0);
}

test("fixture is exact canonical JSON and documents the frozen launcher contract", () => {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  assert.equal(raw, `${raw.trimEnd()}\n`);
  const parsed = JSON.parse(raw) as JsonRecord;
  assert.equal(canonicalizeObserverJson(parsed), raw.trimEnd());
  assert.deepEqual(parsed.supervisorRequest.fields, [
    "schema", "version", "requestId", "correlationId", "carrierSha256", "launcherImagePath",
    "launcherImageSha256", "observerImagePath", "observerImageSha256", "evidenceRootAbsolutePath",
    "stdinSha256", "stdinByteCount", "deadlineMs",
  ]);
  assert.deepEqual(parsed.port.inputFields, ["canonicalSupervisorInputBytes", "deadlineMs"]);
  assert.equal(parsed.caps.observerStdoutBytesMax, 1_114_113);
  assert.equal(parsed.caps.stderrBytesMax, 0);
  assert.equal(
    Buffer.from(parsed.correlation.domainUtf8Hex, "hex").toString("hex"),
    Buffer.from("decadans.rm0032.native-observer-launcher-correlation.v1\0", "utf8").toString("hex"),
  );
  assert.equal(
    Buffer.from(parsed.ledger.identityDomainUtf8Hex, "hex").toString("hex"),
    Buffer.from("decadans.rm0032.launcher-ledger-identity.v2\0", "utf8").toString("hex"),
  );
  assert.equal(Buffer.from(parsed.correlation.domainUtf8Hex, "hex").at(-1), 0);
  assert.equal(Buffer.from(parsed.ledger.identityDomainUtf8Hex, "hex").at(-1), 0);
  assert.deepEqual(parsed.correlation.inputs, [
    "canonicalObserverRequestBytes", "carrierSha256", "acceptedLauncherBinding",
  ]);
  assert.equal(parsed.caps.outerLauncherGraceMs, 5_000);
  assert.deepEqual(parsed.stdio.environment, { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" });
  assert.equal(parsed.ledger.stage, "supervisor-before-worker");
  assert.equal(parsed.handles.genericProcessApiExposed, false);
  assert.deepEqual(parsed.launcherSource.mainRs, {
    bytes: 194_709,
    sha256: "5aea0c9284bced2f71ae7ae2caae5862d7e0db7043dcda3e226281bcfcbeb688",
  });
  assert.deepEqual(parsed.launcherSource.testRs, {
    bytes: 53_240,
    sha256: "2d655aba10ba68c9612eb676c59cdd82ab1cf1c1d8d7ac838c2d48fe9455e3af",
  });
});

test("production transport carries CreateNew through the same exact fake-port seam", async () => {
  const fake = fakePort((result, parts) => {
    const request = JSON.parse(parts.payloadBytes.toString("utf8")) as CreateNewDurableFileRequestV1;
    assert.equal(request.operation, "create-new-durable-file");
    result.evidence.capturedStdoutBase64 = observerCreateSuccessStdout(parts.header, request).toString("base64");
    return Buffer.from(JSON.stringify(result), "utf8");
  });
  const transport = createPhase3NativeObserverProductionTransportV1(BINDING, fake.port);
  const observer = createPhase3NativeObserverV1(BINDING.acceptedObserverBinding, transport);
  const known = await observer.createNewDurableFile(CREATE_REQUEST);
  assert.equal(fake.calls(), 1);
  assert.deepEqual(splitSupervisorInput(fake.inputs[0]).payloadBytes, CREATE_REQUEST_BYTES);
  assert.equal(known.outcome, "known");
  if (known.outcome === "known") {
    assert.equal(known.observation.operation, "create-new-durable-file");
    assert.equal(known.observation.sameHandleReadbackSha256, sha256Hex(Buffer.from(CREATE_REQUEST.contentBase64, "base64")));
  }
});

test("supervisor success legally promotes nested observer never-started and ambiguous evidence", async (t) => {
  const vectors: Array<[string, JsonRecord]> = [
    ["never-started", {
      kind: "child-never-started",
      invocationAttemptCount: 1,
      childStarted: false,
      capturedStdoutBase64: "",
      capturedStderrBase64: "",
      stdoutState: "not-opened",
      stderrState: "not-opened",
      streamClosureState: "not-opened",
      exitState: { kind: "not-started" },
    }],
    ["ambiguous", {
      kind: "child-start-ambiguous",
      invocationAttemptCount: 1,
      childStarted: "unknown",
      capturedStdoutBase64: "",
      capturedStderrBase64: "",
      stdoutState: "not-opened",
      stderrState: "not-opened",
      streamClosureState: "not-opened",
      exitState: { kind: "not-started" },
    }],
  ];
  for (const [expected, nested] of vectors) {
    await t.test(expected, async () => {
      const fake = fakePort((result) => {
        result.evidence = nested;
        return Buffer.from(JSON.stringify(result), "utf8");
      });
      const transport = createPhase3NativeObserverProductionTransportV1(BINDING, fake.port);
      const evidence = await transport.invoke(invocationInput());
      assert.equal(fake.calls(), 1);
      assert.equal(evidence.kind, expected === "never-started" ? "child-never-started" : "child-start-ambiguous");
      assert.equal(evidence.childStarted, expected === "never-started" ? false : "unknown");
    });
  }
});

test("success uses the actual Rust header order and maps nested evidence through the fake port", async () => {
  const fake = fakePort();
  const transport = createPhase3NativeObserverProductionTransportV1(BINDING, fake.port);
  const evidence = await transport.invoke(invocationInput());
  assert.equal(fake.calls(), 1);
  assert.equal(evidence.kind, "child-started");
  assert.equal(evidence.childStarted, true);
  assert.equal(evidence.stdoutState, "eof");
  assert.equal(evidence.stderrState, "eof-zero-bytes");
  assert.equal(evidence.exitState.kind, "known");
  assert.ok(evidence.capturedStdoutBytes.byteLength > 0);

  const portInput = fake.inputs[0];
  assert.deepEqual(Object.keys(portInput), ["canonicalSupervisorInputBytes", "deadlineMs"]);
  const parts = splitSupervisorInput(portInput);
  assert.deepEqual(Object.keys(parts.header), [
    "schema", "version", "requestId", "correlationId", "carrierSha256", "launcherImagePath",
    "launcherImageSha256", "observerImagePath", "observerImageSha256", "evidenceRootAbsolutePath",
    "stdinSha256", "stdinByteCount", "deadlineMs",
  ]);
  assert.equal(parts.header.schema, "decadans.rm0032.native-observer-launcher-request.v1");
  assert.equal(parts.header.version, "v1");
  assert.match(parts.header.correlationId, /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u);
  assert.equal(parts.header.stdinSha256, sha256Hex(REQUEST_BYTES));
  assert.equal(parts.header.launcherImagePath, BINDING.launcherAbsolutePath);
  assert.equal(parts.header.launcherImageSha256, BINDING.launcherSha256);
  assert.equal(parts.header.observerImagePath, BINDING.acceptedObserverBinding.observerAbsolutePath);
  assert.equal(parts.header.evidenceRootAbsolutePath, EVIDENCE_ROOT);
  assert.equal(parts.header.stdinByteCount, REQUEST_BYTES.byteLength);
  assert.ok(parts.header.deadlineMs >= 1 && parts.header.deadlineMs <= 10_000);
  assert.deepEqual(parts.payloadBytes, REQUEST_BYTES);

  const observer = createPhase3NativeObserverV1(BINDING.acceptedObserverBinding, transport);
  const known = await observer.readExactBoundFile(REQUEST);
  assert.equal(known.outcome, "known");
  assert.equal(fake.calls(), 2);
  if (known.outcome === "known") assert.equal(known.observation.contentBase64, Buffer.from("production-transport-tracer").toString("base64"));
  assert.equal(splitSupervisorInput(fake.inputs[0]).header.correlationId, splitSupervisorInput(fake.inputs[1]).header.correlationId);
});

test("binding and invocation input are exact, copied, and request hostility does not reach the port", async () => {
  assert.throws(
    () => createPhase3NativeObserverProductionTransportV1({ ...BINDING, extra: true } as any, fakePort().port),
    /property-set/u,
  );
  assert.throws(
    () => createPhase3NativeObserverProductionTransportV1({
      ...BINDING,
      launcherAbsolutePath: "D:\\alternate\\rm0032-phase3-native-observer-launcher-v1.exe",
    }, fakePort().port),
    /fixed native installation/u,
  );
  assert.throws(
    () => createPhase3NativeObserverProductionTransportV1({
      ...BINDING,
      launcherSha256: "aa".repeat(32),
      acceptedObserverBinding: {
        ...BINDING.acceptedObserverBinding,
        observerAbsolutePath: "D:\\alternate\\rm0032-phase3-native-observer-v1.exe",
      },
    }, fakePort().port),
    /fixed native installation/u,
  );
  const fake = fakePort();
  const transport = createPhase3NativeObserverProductionTransportV1(BINDING, fake.port);
  const noncanonical = Buffer.from(` ${REQUEST_BYTES.toString("utf8")}`, "utf8");
  assertAmbiguous(await transport.invoke(invocationInput(noncanonical)));
  assert.equal(fake.calls(), 0);
  const extraInput = { ...invocationInput(), executable: "hostile.exe" } as any;
  assertAmbiguous(await transport.invoke(extraInput));
  assert.equal(fake.calls(), 0);
});

test("adapter-valid CreateNew above the frozen 65,536-byte launcher cap fails closed before the port", async () => {
  const request: CreateNewDurableFileRequestV1 = {
    ...CREATE_REQUEST,
    requestId: "33333333-3333-4333-8333-333333333333",
    contentBase64: Buffer.alloc(50_000, 0x61).toString("base64"),
  };
  const bytes = Buffer.from(canonicalizeObserverJson(request), "utf8");
  assert.ok(bytes.byteLength > 65_536 && bytes.byteLength <= 393_216);
  const fake = fakePort();
  const transport = createPhase3NativeObserverProductionTransportV1(BINDING, fake.port);
  assertAmbiguous(await transport.invoke(invocationInput(bytes)));
  assert.equal(fake.calls(), 0);
});

test("accepted binding and port capability are snapshotted before later caller mutation", async () => {
  const mutableBinding = {
    ...BINDING,
    acceptedObserverBinding: { ...BINDING.acceptedObserverBinding },
  };
  const fake = fakePort();
  const mutablePort = { ...fake.port };
  const transport = createPhase3NativeObserverProductionTransportV1(mutableBinding, mutablePort);
  mutableBinding.carrierSha256 = "aa".repeat(32);
  mutableBinding.acceptedObserverBinding.observerSha256 = "bb".repeat(32);
  mutablePort.invoke = async () => { throw new Error("mutated port must not be consulted"); };
  const evidence = await transport.invoke(invocationInput());
  assert.equal(evidence.kind, "child-started");
  assert.equal(fake.calls(), 1);
  const header = splitSupervisorInput(fake.inputs[0]).header;
  assert.equal(header.carrierSha256, CARRIER_SHA256);
  assert.equal(header.launcherImagePath, BINDING.launcherAbsolutePath);
  assert.equal(header.launcherImageSha256, LAUNCHER_SHA256);
  assert.equal(header.observerImagePath, BINDING.acceptedObserverBinding.observerAbsolutePath);
  assert.equal(header.observerImageSha256, OBSERVER_SHA256);
  assert.equal(header.evidenceRootAbsolutePath, EVIDENCE_ROOT);
});

test("mutating the canonical supervisor frame after dispatch is detected", async () => {
  const fake = fakePort((result, _parts, input) => {
    input.canonicalSupervisorInputBytes[0] ^= 1;
    return Buffer.from(JSON.stringify(result), "utf8");
  });
  const transport = createPhase3NativeObserverProductionTransportV1(BINDING, fake.port);
  assertAmbiguous(await transport.invoke(invocationInput()));
  assert.equal(fake.calls(), 1);
});

test("hostile result correlation, hash, count, terminal, ledger, handle, and evidence mutations fail closed", async (t) => {
  const vectors: Array<[string, (result: JsonRecord) => void]> = [
    ["correlation", (result) => { result.correlationId = `A${result.correlationId.slice(1)}`; }],
    ["carrier-hash", (result) => { result.carrierSha256 = "55".repeat(32); }],
    ["stdin-hash", (result) => { result.stdinSha256 = "66".repeat(32); }],
    ["count", (result) => { result.invocationAttemptCount = 2; }],
    ["terminal", (result) => { result.terminal = "not-a-terminal"; }],
    ["coherent-non-success", (result) => {
      result.terminal = "quarantined";
      result.reason = "ambiguous reap or final identity/evidence state";
      result.ledgerState = "sticky-unknown";
      result.sticky = true;
      result.handlesReleased = false;
    }],
    ["reason", (result) => { result.reason = "wrong success reason"; }],
    ["ledger", (result) => { result.ledgerIdentitySha256 = "77".repeat(32); }],
    ["handles", (result) => { result.handlesReleased = false; }],
    ["nested-count", (result) => { result.evidence.invocationAttemptCount = 2; }],
    ["nested-correlation-state", (result) => { result.evidence.streamClosureState = "both-eof"; result.evidence.stdoutState = "not-eof-or-unknown"; }],
    ["nested-stderr", (result) => { result.evidence.capturedStderrBase64 = Buffer.from("x").toString("base64"); }],
  ];
  for (const [name, mutate] of vectors) {
    await t.test(name, async () => {
      const fake = fakePort((result) => { mutate(result); return Buffer.from(JSON.stringify(result), "utf8"); });
      const transport = createPhase3NativeObserverProductionTransportV1(BINDING, fake.port);
      assertAmbiguous(await transport.invoke(invocationInput()));
      assert.equal(fake.calls(), 1, `${name} must exercise the port seam`);
    });
  }
});

test("malformed, duplicate, reordered, truncated, and oversized launcher JSON fails closed", async (t) => {
  const vectors: Array<[string, Parameters<typeof fakePort>[0]]> = [
    ["trailing-whitespace", (result) => Buffer.from(`${JSON.stringify(result)}\n`, "utf8")],
    ["duplicate-key", (result) => Buffer.from(JSON.stringify(result).replace('{"schema":', '{"schema":"duplicate","schema":'), "utf8")],
    ["reordered", (result) => {
      const { schema, ...rest } = result;
      return Buffer.from(JSON.stringify({ ...rest, schema }), "utf8");
    }],
    ["truncated", (result) => Buffer.from(JSON.stringify(result).slice(0, -1), "utf8")],
    ["extra", (result) => Buffer.from(JSON.stringify({ ...result, extra: true }), "utf8")],
    ["nested-stdout-cap-plus-one", (result) => {
      result.evidence.capturedStdoutBase64 = Buffer.alloc(1_114_114).toString("base64");
      return Buffer.from(JSON.stringify(result), "utf8");
    }],
  ];
  for (const [name, mutate] of vectors) {
    await t.test(name, async () => {
      const fake = fakePort(mutate);
      const transport = createPhase3NativeObserverProductionTransportV1(BINDING, fake.port);
      assertAmbiguous(await transport.invoke(invocationInput()));
      assert.equal(fake.calls(), 1, `${name} must exercise the port seam`);
    });
  }
});

test("throw, unknown start, incomplete streams, and raw cap violations are ambiguous", async (t) => {
  const variants: Array<[string, Phase3NativeObserverLauncherPortV1]> = [
    ["throw", { async invoke() { throw new Error("scripted throw"); } }],
    ["unknown-start", { async invoke() { return portResult(Buffer.alloc(0), { launcherStarted: "unknown", exitCode: null, stdoutComplete: false, stderrComplete: false }); } }],
    ["incomplete", { async invoke(input) { const parts = splitSupervisorInput(input); return portResult(Buffer.from(JSON.stringify(launcherResultObject(parts))), { stdoutComplete: false }); } }],
    ["raw-stdout-cap-plus-one", { async invoke() { return portResult(Buffer.alloc(1_500_001)); } }],
    ["raw-stderr-byte", { async invoke(input) { const parts = splitSupervisorInput(input); return portResult(Buffer.from(JSON.stringify(launcherResultObject(parts))), { stderr: Buffer.from("x") }); } }],
  ];
  for (const [name, port] of variants) {
    await t.test(name, async () => {
      let calls = 0;
      const connectedPort: Phase3NativeObserverLauncherPortV1 = {
        async invoke(input) {
          calls += 1;
          return port.invoke(input);
        },
      };
      const transport = createPhase3NativeObserverProductionTransportV1(BINDING, connectedPort);
      assertAmbiguous(await transport.invoke(invocationInput()));
      assert.equal(calls, 1, `${name} must exercise the port seam`);
    });
  }
});

test("only an explicit internally consistent launcherStarted=false maps child-never-started", async () => {
  let calls = 0;
  const port: Phase3NativeObserverLauncherPortV1 = {
    async invoke() {
      calls += 1;
      return {
        invocationAttemptCount: 1,
        launcherStarted: false,
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutComplete: false,
        stderrComplete: false,
      };
    },
  };
  const transport = createPhase3NativeObserverProductionTransportV1(BINDING, port);
  const evidence = await transport.invoke(invocationInput());
  assert.equal(calls, 1);
  assert.equal(evidence.kind, "child-never-started");
  assert.equal(evidence.childStarted, false);
  assert.equal(evidence.exitState.kind, "not-started");
});

test("explicit false with contradictory bytes remains ambiguous", async () => {
  const port: Phase3NativeObserverLauncherPortV1 = {
    async invoke() {
      return {
        invocationAttemptCount: 1,
        launcherStarted: false,
        exitCode: null,
        stdout: Buffer.from("unexpected"),
        stderr: Buffer.alloc(0),
        stdoutComplete: false,
        stderrComplete: false,
      };
    },
  };
  const transport = createPhase3NativeObserverProductionTransportV1(BINDING, port);
  assertAmbiguous(await transport.invoke(invocationInput()));
});
