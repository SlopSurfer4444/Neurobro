import { parseRuntimeCarrier, parseExternalStartupBinding, assertCarrierStartupAgreement, resolveRuntimeFilePath } from "./phase3-hardening-runtime-contract-v1.mjs";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { canonicalizeJson, decodeStrictUtf8, sha256Hex } from "./contract.ts";
import {
  PHASE3_HARDENING_CARRIER_V16_SCHEMA,
  PHASE3_HARDENING_V16_FIXED_CARRIER_PATH,
  runPhase3HardeningControllerV2,
  type Phase3ControllerBoundary,
  type Phase3ControllerResult,
} from "./phase3-hardening-controller-v2.ts";
import {
  NATIVE_OBSERVER_CONSUMER,
  NATIVE_OBSERVER_REQUEST_SCHEMA,
  NATIVE_OBSERVER_VERSION,
  createPhase3NativeObserverV1,
  type Phase3NativeObserverV1,
} from "./phase3-native-observer-adapter-v1.ts";
import {
  createPhase3NativeObserverProductionTransportV1,
  type AcceptedNativeObserverLauncherBindingV1,
  type NativeObserverLauncherPortInputV1,
  type NativeObserverLauncherPortResultV1,
  type Phase3NativeObserverLauncherPortV1,
} from "./phase3-native-observer-production-transport-v1.ts";
import { invokeRustSidecar } from "./rust-sidecar-adapter.ts";
import { Phase3ControllerRefusal } from "./phase3-hardening-controller-core.ts";

const EXACT_NODE_VERSION = "v24.15.0";
const EXACT_PLATFORM = "win32";
const EXACT_ARCH = "x64";
const MAX_CARRIER_BYTES = 65_536;
const MAX_BOUND_IMAGE_BYTES = 536_870_912;
const MAX_LAUNCHER_STDOUT_BYTES = 1_500_000;
const LAUNCHER_MODE = "supervise-observer-v1";
const OUTER_LAUNCHER_GRACE_MS = 5_000;
const TERMINATION_REAP_GRACE_MS = 5_000;
const EXACT_LAUNCHER_ENVIRONMENT = Object.freeze({
  SystemDrive: "C:",
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
});
interface BootstrapFileBinding {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface BootstrapCarrier {
  readonly repositoryRoot: string;
  readonly node: BootstrapFileBinding;
  readonly liveEntry: BootstrapFileBinding;
  readonly launcher: BootstrapFileBinding;
  readonly observer: BootstrapFileBinding;
  readonly observerEvidenceRootAbsolutePath: string;
}

class Phase3BootstrapRefusal extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "Phase3BootstrapRefusal";
    this.code = code;
  }
}

export async function runPhase3HardeningBootstrapV1(
  capturedCarrierBytes: Uint8Array,
  capturedStartupBindingBytes: Uint8Array,
): Promise<Phase3ControllerResult> {
  requireExactRuntime();
  if (!(capturedCarrierBytes instanceof Uint8Array)
    || capturedCarrierBytes.byteLength < 1
    || capturedCarrierBytes.byteLength > MAX_CARRIER_BYTES) {
    refuse("captured-carrier-bytes-refused");
  }
  const carrierBytes = Buffer.from(capturedCarrierBytes);
  const liveEntryPath = canonicalDosPath(process.argv[1], "live-entry-derived-path-refused");
  const sourceDirectory = dirname(liveEntryPath);
  const repositoryRoot = canonicalDosPath(
    win32.resolve(sourceDirectory, "..", "..", ".."),
    "repository-derived-path-refused",
  );
  requireExactArgv(liveEntryPath);

  const carrier = parseBootstrapCarrier(carrierBytes, capturedStartupBindingBytes);
  if (carrier.repositoryRoot !== repositoryRoot) refuse("repository-root-binding-refused");
  if (carrier.node.path !== process.execPath || carrier.node.path !== process.argv[0]) {
    refuse("node-path-binding-refused");
  }
  if (carrier.liveEntry.path !== liveEntryPath || carrier.liveEntry.path !== process.argv[1]) {
    refuse("live-entry-path-binding-refused");
  }

  await verifyExactRegularFile(carrier.node, "node-binding-refused");
  await verifyExactRegularFile(carrier.liveEntry, "live-entry-binding-refused");
  await verifyExactRegularFile(carrier.launcher, "launcher-binding-refused");
  await verifyExactRegularFile(carrier.observer, "observer-binding-refused");

  const acceptedObserverBinding = Object.freeze({
    observerAbsolutePath: carrier.observer.path,
    observerSha256: carrier.observer.sha256.toLowerCase(),
    evidenceRootAbsolutePath: carrier.observerEvidenceRootAbsolutePath,
  });
  const acceptedLauncherBinding: AcceptedNativeObserverLauncherBindingV1 = Object.freeze({
    launcherAbsolutePath: carrier.launcher.path,
    launcherSha256: carrier.launcher.sha256.toLowerCase(),
    carrierSha256: sha256Hex(carrierBytes),
    acceptedObserverBinding,
  });
  const launcherPort = createExactLauncherPort(carrier.launcher);
  const transport = createPhase3NativeObserverProductionTransportV1(acceptedLauncherBinding, launcherPort);
  const observer = createPhase3NativeObserverV1(acceptedObserverBinding, transport);
  const boundary = createControllerBoundary(repositoryRoot, observer);
  return runPhase3HardeningControllerV2(
    carrierBytes,
    PHASE3_HARDENING_V16_FIXED_CARRIER_PATH,
    boundary,
    capturedStartupBindingBytes,
  );
}

function requireExactRuntime(): void {
  if (process.version !== EXACT_NODE_VERSION || process.platform !== EXACT_PLATFORM || process.arch !== EXACT_ARCH) {
    refuse("runtime-binding-refused");
  }
}

function requireExactArgv(liveEntryPath: string): void {
  if (process.argv.length !== 2 || process.argv[0] !== process.execPath || process.argv[1] !== liveEntryPath
    || win32.basename(liveEntryPath) !== "phase3-hardening-live-entry.mjs") {
    refuse("argv-binding-refused");
  }
  if (pathToFileURL(process.argv[1]).href !== pathToFileURL(liveEntryPath).href) {
    refuse("direct-entry-binding-refused");
  }
}

function parseBootstrapCarrier(bytes: Uint8Array, startupBytes: Uint8Array): BootstrapCarrier {
  const carrier = parseRuntimeCarrier(bytes);
  const startup = parseExternalStartupBinding(startupBytes);
  assertCarrierStartupAgreement(carrier, startup, bytes);
  return {
    repositoryRoot: carrier.repositoryBinding.root,
    ...carrier.productionBindings,
  } as BootstrapCarrier;
}

async function verifyExactRegularFile(binding: BootstrapFileBinding, code: string): Promise<Buffer> {
  let metadata;
  try {
    metadata = await lstat(binding.path);
  } catch {
    refuse(code);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== binding.bytes) refuse(code);
  let bytes: Buffer;
  try {
    bytes = await readFile(binding.path);
  } catch {
    refuse(code);
  }
  if (bytes.byteLength !== binding.bytes || sha256Hex(bytes).toUpperCase() !== binding.sha256) refuse(code);
  return bytes;
}

function createExactLauncherPort(launcher: BootstrapFileBinding): Phase3NativeObserverLauncherPortV1 {
  return Object.freeze({
    async invoke(input: NativeObserverLauncherPortInputV1): Promise<NativeObserverLauncherPortResultV1> {
      exactRecord(input, ["canonicalSupervisorInputBytes", "deadlineMs"], "launcherPortInput");
      if (!(input.canonicalSupervisorInputBytes instanceof Uint8Array)
        || input.canonicalSupervisorInputBytes.byteLength < 1
        || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > 10_000) {
        refuse("launcher-port-input-refused");
      }
      await verifyExactRegularFile(launcher, "launcher-prestart-binding-refused");
      return invokeExactLauncher(launcher.path, Buffer.from(input.canonicalSupervisorInputBytes), input.deadlineMs);
    },
  });
}

async function invokeExactLauncher(
  launcherAbsolutePath: string,
  stdinBytes: Buffer,
  deadlineMs: number,
): Promise<NativeObserverLauncherPortResultV1> {
  return new Promise((resolve) => {
    const abortController = new AbortController();
    let child;
    try {
      child = spawn(launcherAbsolutePath, [LAUNCHER_MODE], {
        shell: false,
        windowsHide: true,
        cwd: win32.dirname(launcherAbsolutePath),
        stdio: ["pipe", "pipe", "pipe"],
        env: EXACT_LAUNCHER_ENVIRONMENT,
        signal: abortController.signal,
        killSignal: "SIGKILL",
      });
    } catch {
      resolve(neverStartedLauncherResult());
      return;
    }
    let settled = false;
    let launcherStarted: false | true | "unknown" = typeof child.pid === "number" ? true : "unknown";
    let stdoutEnded = false;
    let stderrEnded = false;
    let stdoutOverflow = false;
    let stderrByteSeen = false;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let terminationRequested = false;
    let outerDeadline: ReturnType<typeof setTimeout> | undefined;
    let terminationReapDeadline: ReturnType<typeof setTimeout> | undefined;

    const settle = (exitCode: number | null, forcedIncomplete = false): void => {
      if (settled) return;
      settled = true;
      if (outerDeadline !== undefined) clearTimeout(outerDeadline);
      if (terminationReapDeadline !== undefined) clearTimeout(terminationReapDeadline);
      resolve(Object.freeze({
        invocationAttemptCount: 1 as const,
        launcherStarted,
        exitCode,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.alloc(0),
        stdoutComplete: !forcedIncomplete && stdoutEnded && !stdoutOverflow,
        stderrComplete: !forcedIncomplete && stderrEnded && !stderrByteSeen,
      }));
    };

    const requestTerminationOnce = (): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      terminationReapDeadline = setTimeout(() => {
        if (settled) return;
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        settle(null, true);
      }, TERMINATION_REAP_GRACE_MS);
      abortController.abort();
    };

    child.once("spawn", () => { launcherStarted = true; });
    child.once("error", () => {
      if (!terminationRequested && launcherStarted !== true) {
        launcherStarted = false;
        settle(null, true);
      }
    });
    child.stdout.on("data", (chunk: Uint8Array) => {
      const bytes = Buffer.from(chunk);
      const available = MAX_LAUNCHER_STDOUT_BYTES - stdoutBytes;
      if (available > 0) {
        const retained = bytes.subarray(0, available);
        stdoutChunks.push(Buffer.from(retained));
        stdoutBytes += retained.byteLength;
      }
      if (bytes.byteLength > available) stdoutOverflow = true;
    });
    child.stdout.once("end", () => { stdoutEnded = true; });
    child.stderr.on("data", (chunk: Uint8Array) => {
      if (chunk.byteLength > 0) stderrByteSeen = true;
    });
    child.stderr.once("end", () => { stderrEnded = true; });
    child.once("close", (code) => settle(code));
    child.stdin.once("error", () => undefined);
    child.stdin.end(stdinBytes);

    outerDeadline = setTimeout(
      requestTerminationOnce,
      deadlineMs + OUTER_LAUNCHER_GRACE_MS,
    );
  });
}

function neverStartedLauncherResult(): NativeObserverLauncherPortResultV1 {
  return Object.freeze({
    invocationAttemptCount: 1,
    launcherStarted: false,
    exitCode: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutComplete: false,
    stderrComplete: false,
  });
}

function createControllerBoundary(repositoryRoot: string, observer: Phase3NativeObserverV1): Phase3ControllerBoundary {
  return Object.freeze({
    async readBoundFile(path: string) {
      const targetPath = resolveRuntimeFilePath(repositoryRoot, path);
      const result = await observer.readExactBoundFile({
        schema: NATIVE_OBSERVER_REQUEST_SCHEMA,
        version: NATIVE_OBSERVER_VERSION,
        consumer: NATIVE_OBSERVER_CONSUMER,
        operation: "read-bound-file",
        requestId: randomUUID().toUpperCase(),
        rootPath: win32.isAbsolute(path) ? dirname(targetPath) : repositoryRoot,
        targetPath,
      });
      if (result.outcome !== "known") throw new Phase3ControllerRefusal("native-observer-read-not-known");
      const content = Buffer.from(result.observation.contentBase64, "base64");
      return {
        path,
        resolvedPath: targetPath,
        exists: true,
        kind: "regular-file",
        isContained: true,
        isReparsePoint: false,
        bytes: content.byteLength,
        sha256: result.observation.contentSha256.toUpperCase(),
        content,
      };
    },
    async createNewDurableFile(path: string, bytes: Uint8Array) {
      const targetPath = resolveRuntimeFilePath(repositoryRoot, path);
      const content = Buffer.from(bytes);
      const result = await observer.createNewDurableFile({
        schema: NATIVE_OBSERVER_REQUEST_SCHEMA,
        version: NATIVE_OBSERVER_VERSION,
        consumer: NATIVE_OBSERVER_CONSUMER,
        operation: "create-new-durable-file",
        requestId: randomUUID().toUpperCase(),
        rootPath: win32.isAbsolute(path) ? dirname(targetPath) : repositoryRoot,
        targetPath,
        contentBase64: content.toString("base64"),
      });
      if (result.outcome === "refused") throw new Phase3ControllerRefusal("native-observer-create-refused");
      if (result.outcome !== "known") throw new Error("native-observer-create-unknown");
      return {
        path,
        resolvedPath: targetPath,
        created: true,
        durableFlushCompleted: true,
        exists: true,
        kind: "regular-file",
        isContained: true,
        isReparsePoint: false,
        bytes: content.byteLength,
        sha256: result.observation.reopenedReadbackSha256.toUpperCase(),
        content,
      };
    },
    monotonicMilliseconds() {
      const sampled = performance.now();
      if (!Number.isFinite(sampled) || sampled < 0) throw new Phase3ControllerRefusal("monotonic-clock-refused");
      const value = Math.floor(sampled);
      if (!Number.isSafeInteger(value)) throw new Phase3ControllerRefusal("monotonic-clock-refused");
      return value;
    },
    invokeAcceptedRustSidecar: invokeRustSidecar,
  });
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${label}-object-refused`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) refuse(`${label}-prototype-refused`);
  if (Object.getOwnPropertySymbols(value).length !== 0) refuse(`${label}-symbols-refused`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  const sortedActual = [...actual].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const sortedExpected = [...keys].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (sortedActual.length !== sortedExpected.length
    || sortedActual.some((key, index) => key !== sortedExpected[index])) {
    refuse(`${label}-keys-refused`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) refuse(`${label}-descriptor-refused`);
  }
  return value as Record<string, unknown>;
}

function canonicalDosPath(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Z]:\\/u.test(value) || !win32.isAbsolute(value)
    || value.startsWith("\\\\") || value.startsWith("\\\\?\\") || /[\u0000\r\n]/u.test(value)
    || win32.normalize(value) !== value) {
    refuse(code);
  }
  return value;
}

function refuse(code: string): never {
  throw new Phase3BootstrapRefusal(code);
}
