import {
  CONTRACT_LIMITS,
  PROCESS_CONSUMER,
  PROCESS_EVIDENCE_SCHEMA,
  PROCESS_REQUEST_SCHEMA,
  assertExactKeys,
  canonicalizeJson,
  decodeStrictUtf8,
  encodeCanonicalProcessRequest,
  parseProcessEvidence,
  parseProcessRequest,
  sha256Hex,
  type ProcessRequest,
} from "./contract.ts";
import { win32 } from "node:path";
import type {
  RustSidecarAuthority,
  RustSidecarResult,
} from "./rust-sidecar-adapter.ts";
import {
  PHASE3_CONTROLLER_EMPTY_SHA256 as EMPTY_SHA256,
  PHASE3_CONTROLLER_PHASE_ID as PHASE_ID,
  Phase3ControllerRefusal as ControllerRefusal,
  makePhase3ControllerResult as makeResult,
  type Phase3BoundFileObservation,
  type Phase3ControllerBoundary,
  type Phase3ControllerExecutionState as ExecutionState,
  type Phase3ControllerOutcome,
  type Phase3ControllerResult,
  type Phase3DurableWriteObservation,
} from "./phase3-hardening-controller-core.ts";

export type {
  Phase3BoundFileObservation,
  Phase3ControllerBoundary,
  Phase3ControllerOutcome,
  Phase3ControllerResult,
  Phase3DurableWriteObservation,
} from "./phase3-hardening-controller-core.ts";

export const PHASE3_HARDENING_CARRIER_SCHEMA =
  "decadans.rm0032.phase3-hardening-carrier.v1" as const;
export const PHASE3_HARDENING_FIXED_CARRIER_PATH =
  "project/verification/rm-0032-phase3-live-hardening-carrier.json" as const;

const PHASE2_RECEIPT_PATH = "project/verification/rm-0032-dedicated-wsl-distro-acquisition-import-receipt.json";
const PHASE3A_RECEIPT_PATH = "project/verification/rm-0032-phase3-typed-runner-acceptance-receipt.json";
const PHASE3A_DECISION_PATH = "project/decisions/rm-0032-phase3-typed-native-runner-boundary.md";
const CONTROLLER_SOURCE_PATH = "packages/rm0032-phase3-runner/src/phase3-hardening-controller.ts";
const CONTROLLER_TEST_PATH = "packages/rm0032-phase3-runner/test/phase3-hardening-controller.test.ts";
const CONTROLLER_RECEIPT_PATH = "project/verification/rm-0032-phase3-controller-acceptance-receipt.json";
const GIT_PATH = "C:\\Program Files\\Git\\cmd\\git.exe";
const GIT_SHA256 = "81EF35AE005CA9318018D18E3327578CE939FB99FEAAD6B2D7C8AB15F3DE8DB5";
const WSL_PATH = "C:\\Windows\\System32\\wsl.exe";
const PHASE3A_VERDICT = "WHOLE_PHASE3A_TYPED_RUNNER_BOUNDARY_CLEAR";
const CONTROLLER_VERDICT = "WHOLE_PHASE3_CONTROLLER_BOUNDARY_CLEAR";
const SHA256_UPPER = /^[0-9A-F]{64}$/u;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const UUID_V4_UPPER = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u;
const SAFE_SEMANTIC_CLASS = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TOP_KEYS = [
  "schema", "phase", "fixedCarrierPath", "predecessorBindings", "controllerBindings",
  "binaryBindings", "repositoryBinding", "policy", "review", "parentDecision",
  "authorization", "guestExecutables", "commands",
] as const;
const PHASE_KEYS = ["id", "status", "subSlice", "autoContinue", "phase4Available"] as const;
const PREDECESSOR_KEYS = ["phase2Receipt", "phase3A"] as const;
const PHASE3A_KEYS = ["commit", "tree", "parent", "receipt", "decision", "verdict", "artifactBindings"] as const;
const FILE_BINDING_KEYS = ["path", "bytes", "sha256"] as const;
const CONTROLLER_KEYS = ["commit", "tree", "verdict", "source", "test", "receipt"] as const;
const CONTROLLER_RECEIPT_KEYS = ["path", "bytes", "sha256", "outcome", "selfAcceptanceClaimed"] as const;
const BINARY_KEYS = ["runner", "git", "wsl"] as const;
const REPOSITORY_KEYS = [
  "root", "acceptedControllerCommit", "acceptedControllerTree", "carrierCommit", "carrierTree",
  "carrierParent", "carrierOnlyDeltaPath", "carrierBlobId",
] as const;
const POLICY_KEYS = [
  "aggregateDeadlineMs", "commandCountMax", "decodedStreamBytesMax", "artifactStdinBytesEachMax",
  "artifactStdinBytesAggregateMax", "outerDeadlineGraceMs", "guestInternalTimeoutSeconds",
  "retryAuthorized", "cleanupAuthorized", "phaseAdvanceAuthorized", "phase4Authorized",
] as const;
const REVIEW_KEYS = ["verdict", "independent", "controllerVerdict"] as const;
const PARENT_DECISION_KEYS = ["decision", "stable"] as const;
const AUTHORIZATION_KEYS = [
  "id", "oneShot", "retryAuthorized", "cleanupAuthorized", "phaseAdvanceAuthorized",
  "phase4Authorized", "attemptEvidencePath",
] as const;
const COMMAND_KEYS = ["role", "decoder", "semanticClass", "requestPath", "request", "expected"] as const;
const EXPECTED_RAW_KEYS = ["exitCode", "stdoutBytes", "stdoutSha256", "stderrBytes", "stderrSha256"] as const;
const EXPECTED_CARRIER_KEYS = ["exitCode", "stdoutBinding", "stderrBytes", "stderrSha256"] as const;
const FILE_OBSERVATION_KEYS = [
  "path", "resolvedPath", "exists", "kind", "isContained", "isReparsePoint", "bytes", "sha256", "content",
] as const;
const WRITE_OBSERVATION_KEYS = [
  "path", "resolvedPath", "created", "durableFlushCompleted", "exists", "kind", "isContained",
  "isReparsePoint", "bytes", "sha256", "content",
] as const;
const SIDECAR_RESULT_KEYS = [
  "adapter", "requestSha256", "sidecarProcessStartCount", "sidecarExitCodeKnown", "sidecarExitCode",
  "sidecarOutputComplete", "sidecarStdoutBytes", "sidecarStdoutSha256", "sidecarStderrBytes",
  "sidecarStderrSha256", "evidenceRecoveredBeforeAckParse", "evidenceBytes", "evidenceSha256",
  "runnerPeakWorkingSetBytes", "retryPerformed", "evidence",
] as const;

const PHASE3A_ARTIFACTS = Object.freeze([
  { path: "packages/rm0032-phase3-runner/package.json", bytes: 937, sha256: "83E4249D86A8DE9FE0ED4BADADFE3390B7F1061B8BE8420D20E2F4DEA926557A" },
  { path: "packages/rm0032-phase3-runner/tsconfig.json", bytes: 390, sha256: "ED31D9571111AA2C0DF5E511A746F1A39CF5D2525D8E16BA46BAC0ED471584C7" },
  { path: "packages/rm0032-phase3-runner/src/contract.ts", bytes: 26_159, sha256: "BBF93E822CEA9C420FF2936632B8B4DDD23F2DD24753374A5579D0524C56C012" },
  { path: "packages/rm0032-phase3-runner/src/typescript-baseline.ts", bytes: 15_456, sha256: "9CEE2B073429F5A801AE2E218F8A98FE360346FD776DBC5405189491EA9F6713" },
  { path: "packages/rm0032-phase3-runner/src/rust-sidecar-adapter.ts", bytes: 19_968, sha256: "6350934B398142221293D71B30F129481436A69E6559F65B9D307224EEE5DDE5" },
  { path: "packages/rm0032-phase3-runner/test/contract.test.ts", bytes: 7_658, sha256: "12FC9F32D4EF3ED683751EDF77B0070B4FA8EF641D551740010EFED99BCEEE1A" },
  { path: "packages/rm0032-phase3-runner/test/faults.test.ts", bytes: 36_294, sha256: "3350FBA908C586D63D27BA5633858EF64CF0A3AFECFDC9E0416E6332877D2120" },
  { path: "packages/rm0032-phase3-runner/bench/process-boundary-benchmark.ts", bytes: 17_403, sha256: "D9C20A6043064B6A9A0BBD66D4F97FA52779AA8DC0126A6690C78EA05AEAC102" },
  { path: "packages/rm0032-phase3-runner/fixtures/process-boundary-v1.json", bytes: 4_660, sha256: "1F2A0B693ED0CF8E7E020F38A4BA93BD88FB26FEF7D55ACAF16AD983FD581EB7" },
  { path: "crates/rm0032-phase3-runner/Cargo.toml", bytes: 596, sha256: "5F9AD6A53A71692DD80EDAA205562D155DEF1BB33199AB7ED8229A1C2C93ABCA" },
  { path: "crates/rm0032-phase3-runner/Cargo.lock", bytes: 5_545, sha256: "07487081DB08293FB92CE23CC818D3B9E72531A5931A1FB8B8B6523E0BDEE103" },
  { path: "crates/rm0032-phase3-runner/src/main.rs", bytes: 62_900, sha256: "E9ECF46850418E441814E5CF95E307EEB46D952CC511DF6AA313C0A367BCCE02" },
  { path: "crates/rm0032-phase3-runner/tests/contract_vectors.rs", bytes: 5_237, sha256: "4100B8A5CF168F1E9789DC5BED0216762A988CB1BF2193604BFB8855C4848D64" },
]);

interface FileBinding { path: string; bytes: number; sha256: string }
interface CommandExpectation {
  exitCode: number;
  stdoutBytes?: number;
  stdoutSha256?: string;
  stdoutBinding?: "exact-carrier-bytes";
  stderrBytes: number;
  stderrSha256: string;
}
interface ControllerCommand {
  role: "git-guard" | "wsl-management" | "wsl-guest";
  decoder: "utf-8-no-bom-strict" | "utf-16le-no-bom-strict" | "raw-hash-only" | "silent-mutator";
  semanticClass: string;
  requestPath: string;
  request: ProcessRequest;
  expected: CommandExpectation;
}
interface ParsedCarrier {
  value: Record<string, unknown>;
  repositoryRoot: string;
  bindings: FileBinding[];
  controllerCommit: string;
  controllerTree: string;
  carrierCommit: string;
  carrierTree: string;
  carrierBlobId: string;
  runner: FileBinding;
  git: FileBinding;
  wsl: FileBinding;
  authorizationId: string;
  attemptEvidencePath: string;
  aggregateDeadlineMs: number;
  guestExecutables: string[];
  commands: ControllerCommand[];
}

export async function runPhase3HardeningController(
  carrierBytes: Uint8Array,
  fixedCarrierPath: string,
  boundary: Phase3ControllerBoundary,
): Promise<Phase3ControllerResult> {
  const carrierSha256 = sha256Hex(carrierBytes).toUpperCase();
  const state: ExecutionState = {
    acceptedCommandCount: 0,
    rustInvocationCount: 0,
    runnerTerminationRequestCount: 0,
    attemptEvidenceBytes: 0,
    attemptEvidenceSha256: EMPTY_SHA256,
    commandReceipts: [],
  };
  let parsed: ParsedCarrier;
  try {
    parsed = parseCarrier(carrierBytes, fixedCarrierPath);
    await validateAllBoundFiles(parsed, carrierBytes, boundary);
  } catch (error) {
    return makeResult(
      "terminal-refused",
      carrierBytes.byteLength,
      carrierSha256,
      state,
      refusalCode(error),
    );
  }

  let startedAt: number;
  try {
    startedAt = boundary.monotonicMilliseconds();
  } catch {
    return makeResult("terminal-refused", carrierBytes.byteLength, carrierSha256, state, "monotonic-clock-refused");
  }
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    return makeResult("terminal-refused", carrierBytes.byteLength, carrierSha256, state, "monotonic-clock-refused");
  }
  let lastMonotonicMilliseconds = startedAt;

  for (let ordinal = 0; ordinal < parsed.commands.length; ordinal += 1) {
    const command = parsed.commands[ordinal]!;
    if (ordinal === 5) {
      const marker = Buffer.from(canonicalizeJson({
        schema: "decadans.rm0032.phase3-hardening-attempt-evidence.v1",
        authorizationId: parsed.authorizationId,
        attemptOrdinal: 1,
        carrierBytes: carrierBytes.byteLength,
        carrierSha256,
        fixedCarrierPath: PHASE3_HARDENING_FIXED_CARRIER_PATH,
        retryAuthorized: false,
        cleanupAuthorized: false,
        phaseAdvanceAuthorized: false,
        phase4Authorized: false,
        startedMonotonicMilliseconds: startedAt,
      }), "utf8");
      try {
        const observation = await boundary.createNewDurableFile(parsed.attemptEvidencePath, marker);
        validateWriteObservation(observation, parsed.attemptEvidencePath, marker, "attempt-evidence");
        state.attemptEvidenceBytes = marker.byteLength;
        state.attemptEvidenceSha256 = sha256Hex(marker).toUpperCase();
      } catch (error) {
        const code = error instanceof ControllerRefusal && error.code === "attempt-evidence-create-collision"
          ? "attempt-evidence-create-collision"
          : "attempt-evidence-write-unknown";
        const outcome: Phase3ControllerOutcome = code.endsWith("collision") ? "terminal-refused" : "terminal-unknown";
        return makeResult(outcome, carrierBytes.byteLength, carrierSha256, state, code);
      }
    }

    let now: number;
    try {
      now = boundary.monotonicMilliseconds();
    } catch {
      const afterEffect = state.rustInvocationCount > 0 || state.attemptEvidenceBytes > 0;
      return makeResult(
        afterEffect ? "terminal-unknown" : "terminal-refused",
        carrierBytes.byteLength,
        carrierSha256,
        state,
        afterEffect ? "monotonic-clock-unknown-after-effect" : "monotonic-clock-refused",
      );
    }
    const outerDeadlineMs = command.request.limits.deadlineMs + 5_000;
    if (
      !Number.isSafeInteger(now) || now < lastMonotonicMilliseconds ||
      now - startedAt + outerDeadlineMs > parsed.aggregateDeadlineMs
    ) {
      const afterEffect = state.rustInvocationCount > 0 || state.attemptEvidenceBytes > 0;
      return makeResult(
        afterEffect ? "terminal-unknown" : "terminal-refused",
        carrierBytes.byteLength,
        carrierSha256,
        state,
        afterEffect ? "aggregate-remaining-deadline-unknown-after-effect" : "aggregate-remaining-deadline-refused",
      );
    }
    lastMonotonicMilliseconds = now;

    const requestBytes = encodeCanonicalProcessRequest(command.request);
    try {
      const requestObservation = await boundary.createNewDurableFile(command.requestPath, requestBytes);
      validateWriteObservation(requestObservation, command.requestPath, requestBytes, `request-${ordinal}`);
    } catch (error) {
      const collision = error instanceof ControllerRefusal &&
        error.code === `request-${ordinal}-create-collision`;
      return makeResult(
        collision ? "terminal-refused" : "terminal-unknown",
        carrierBytes.byteLength,
        carrierSha256,
        state,
        collision ? error.code : "request-write-unknown",
      );
    }

    let result: RustSidecarResult;
    state.rustInvocationCount += 1;
    try {
      result = await boundary.invokeAcceptedRustSidecar(requestBytes, {
        runnerPath: parsed.runner.path,
        runnerSha256: parsed.runner.sha256.toLowerCase(),
        requestPath: command.requestPath,
        sidecarDeadlineMs: outerDeadlineMs,
      });
    } catch (error) {
      const terminationCount = extractTerminationRequestCount(error);
      state.runnerTerminationRequestCount += terminationCount;
      return makeResult(
        "terminal-unknown",
        carrierBytes.byteLength,
        carrierSha256,
        state,
        "accepted-sidecar-threw-after-invocation",
      );
    }

    let evidence: ReturnType<typeof parseProcessEvidence>;
    try {
      evidence = validateSidecarResult(result, requestBytes, command.request);
    } catch {
      return makeResult(
        "terminal-unknown",
        carrierBytes.byteLength,
        carrierSha256,
        state,
        "accepted-sidecar-evidence-binding-unknown",
      );
    }
    state.commandReceipts.push(makeCommandReceipt(ordinal, command, result, evidence));

    if (evidence.terminalState !== "known-exit" || !evidence.exitCodeKnown || evidence.exitCode === null || !evidence.outputComplete) {
      return makeResult("terminal-unknown", carrierBytes.byteLength, carrierSha256, state, "command-terminal-unknown");
    }
    if (evidence.exitCode !== 0) {
      return makeResult("terminal-known-failure", carrierBytes.byteLength, carrierSha256, state, "command-known-nonzero");
    }
    try {
      validateCommandOutput(command, evidence, carrierBytes, parsed);
    } catch {
      return makeResult("terminal-unknown", carrierBytes.byteLength, carrierSha256, state, "command-output-refused-after-start");
    }
    state.acceptedCommandCount += 1;
  }

  return makeResult("known-clear", carrierBytes.byteLength, carrierSha256, state, "all-carrier-commands-known-clear");
}

function parseCarrier(bytes: Uint8Array, fixedCarrierPath: string): ParsedCarrier {
  if (fixedCarrierPath !== PHASE3_HARDENING_FIXED_CARRIER_PATH) {
    throw new ControllerRefusal("fixed-carrier-path-refused");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 65_536) {
    throw new ControllerRefusal("carrier-byte-cap-refused");
  }
  let text: string;
  try {
    text = decodeStrictUtf8(bytes, "$carrierBytes");
  } catch {
    throw new ControllerRefusal("carrier-utf8-refused");
  }
  if (hasUtf8Bom(bytes) || text.includes("\uFEFF")) throw new ControllerRefusal("carrier-bom-refused");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new ControllerRefusal("carrier-json-refused");
  }
  const carrier = asRecord(parsedJson, "carrier");
  if (text !== canonicalizeJson(carrier)) throw new ControllerRefusal("carrier-canonical-refused");
  exactKeys(carrier, TOP_KEYS, "carrier");
  literal(carrier.schema, PHASE3_HARDENING_CARRIER_SCHEMA, "carrier-schema-refused");
  literal(carrier.fixedCarrierPath, PHASE3_HARDENING_FIXED_CARRIER_PATH, "carrier-path-binding-refused");

  const phase = asRecord(carrier.phase, "phase");
  exactKeys(phase, PHASE_KEYS, "phase");
  literal(phase.id, PHASE_ID, "phase-id-refused");
  literal(phase.status, "pending", "phase-status-refused");
  literal(phase.subSlice, "phase3b-live-guest-hardening", "phase-subslice-refused");
  literal(phase.autoContinue, false, "phase-auto-continue-refused");
  literal(phase.phase4Available, false, "phase4-availability-refused");

  const predecessors = asRecord(carrier.predecessorBindings, "predecessorBindings");
  exactKeys(predecessors, PREDECESSOR_KEYS, "predecessorBindings");
  const phase2 = parseFileBinding(predecessors.phase2Receipt, "phase2Receipt");
  exactFileBinding(phase2, {
    path: PHASE2_RECEIPT_PATH,
    bytes: 43_404,
    sha256: "521EA28F0570E2FDF9C5EB0B9B6F20B1E7C075ED248CED1EAA75A514DE72DD32",
  }, "phase2-receipt-binding-refused");

  const phase3A = asRecord(predecessors.phase3A, "phase3A");
  exactKeys(phase3A, PHASE3A_KEYS, "phase3A");
  literal(phase3A.commit, "d4b2b6eac03cdf3ae845afae5c96ad869b370ca4", "phase3a-commit-refused");
  literal(phase3A.tree, "8859d0fa46777bfedb33f440147d11b5e8dd1870", "phase3a-tree-refused");
  literal(phase3A.parent, "9c440e24d5f9b12f6e700dad20b494a317a81311", "phase3a-parent-refused");
  literal(phase3A.verdict, PHASE3A_VERDICT, "phase3a-verdict-refused");
  const phase3AReceipt = parseFileBinding(phase3A.receipt, "phase3A.receipt");
  exactFileBinding(phase3AReceipt, {
    path: PHASE3A_RECEIPT_PATH,
    bytes: 14_230,
    sha256: "A9ECFC607B307AC68F45E247A8787DAB67A7B42EAC75D0037ED4E5F8B41BEC1C",
  }, "phase3a-receipt-refused");
  const phase3ADecision = parseFileBinding(phase3A.decision, "phase3A.decision");
  exactFileBinding(phase3ADecision, {
    path: PHASE3A_DECISION_PATH,
    bytes: 10_492,
    sha256: "2850A0783C07AC379303F3EFE327E235AEF96689AF5B9319CA22CE7CEC367B09",
  }, "phase3a-decision-refused");
  if (!Array.isArray(phase3A.artifactBindings) || phase3A.artifactBindings.length !== PHASE3A_ARTIFACTS.length) {
    throw new ControllerRefusal("phase3a-artifact-cardinality-refused");
  }
  const phase3AArtifacts = phase3A.artifactBindings.map((value, index) => {
    const binding = parseFileBinding(value, `phase3A.artifactBindings[${index}]`);
    exactFileBinding(binding, PHASE3A_ARTIFACTS[index]!, "phase3a-artifact-binding-refused");
    return binding;
  });

  const controller = asRecord(carrier.controllerBindings, "controllerBindings");
  exactKeys(controller, CONTROLLER_KEYS, "controllerBindings");
  const controllerCommit = gitObjectId(controller.commit, "controller-commit-refused", 40);
  const controllerTree = gitObjectId(controller.tree, "controller-tree-refused", 40);
  literal(controller.verdict, CONTROLLER_VERDICT, "controller-verdict-refused");
  const controllerSource = parseFileBinding(controller.source, "controller.source");
  literal(controllerSource.path, CONTROLLER_SOURCE_PATH, "controller-source-path-refused");
  const controllerTest = parseFileBinding(controller.test, "controller.test");
  literal(controllerTest.path, CONTROLLER_TEST_PATH, "controller-test-path-refused");
  const controllerReceiptValue = asRecord(controller.receipt, "controller.receipt");
  exactKeys(controllerReceiptValue, CONTROLLER_RECEIPT_KEYS, "controller.receipt");
  const controllerReceipt = parseFileBinding(controllerReceiptValue, "controller.receipt", CONTROLLER_RECEIPT_KEYS);
  literal(controllerReceipt.path, CONTROLLER_RECEIPT_PATH, "controller-receipt-path-refused");
  literal(controllerReceiptValue.outcome, "candidate-clear/repo-only-controller-boundary", "controller-receipt-outcome-refused");
  literal(controllerReceiptValue.selfAcceptanceClaimed, false, "controller-self-acceptance-refused");

  const binaries = asRecord(carrier.binaryBindings, "binaryBindings");
  exactKeys(binaries, BINARY_KEYS, "binaryBindings");
  const runner = parseFileBinding(binaries.runner, "binaryBindings.runner");
  canonicalWindowsPath(runner.path, "runner-path-refused");
  if (!runner.path.toLowerCase().endsWith(".exe")) throw new ControllerRefusal("runner-extension-refused");
  const git = parseFileBinding(binaries.git, "binaryBindings.git");
  literal(git.path, GIT_PATH, "git-path-refused");
  literal(git.sha256, GIT_SHA256, "git-hash-refused");
  const wsl = parseFileBinding(binaries.wsl, "binaryBindings.wsl");
  literal(wsl.path, WSL_PATH, "wsl-path-refused");

  const repository = asRecord(carrier.repositoryBinding, "repositoryBinding");
  exactKeys(repository, REPOSITORY_KEYS, "repositoryBinding");
  const repositoryRoot = canonicalWindowsPath(repository.root, "repository-root-refused");
  literal(repository.acceptedControllerCommit, controllerCommit, "repository-controller-commit-refused");
  literal(repository.acceptedControllerTree, controllerTree, "repository-controller-tree-refused");
  const carrierCommit = gitObjectId(repository.carrierCommit, "carrier-commit-refused", 40);
  const carrierTree = gitObjectId(repository.carrierTree, "carrier-tree-refused", 40);
  literal(repository.carrierParent, controllerCommit, "carrier-parent-refused");
  literal(repository.carrierOnlyDeltaPath, PHASE3_HARDENING_FIXED_CARRIER_PATH, "carrier-only-path-refused");
  const carrierBlobId = gitObjectId(repository.carrierBlobId, "carrier-blob-id-refused");
  if (carrierCommit === controllerCommit || carrierTree === controllerTree) {
    throw new ControllerRefusal("carrier-successor-identity-refused");
  }

  const policy = asRecord(carrier.policy, "policy");
  exactKeys(policy, POLICY_KEYS, "policy");
  const aggregateDeadlineMs = integer(policy.aggregateDeadlineMs, 1_000, 420_000, "aggregate-deadline-refused");
  literal(policy.commandCountMax, 48, "command-count-policy-refused");
  literal(policy.decodedStreamBytesMax, 65_536, "decoded-cap-policy-refused");
  literal(policy.artifactStdinBytesEachMax, 16_384, "stdin-each-policy-refused");
  literal(policy.artifactStdinBytesAggregateMax, 65_536, "stdin-aggregate-policy-refused");
  literal(policy.outerDeadlineGraceMs, 5_000, "outer-grace-policy-refused");
  literal(policy.guestInternalTimeoutSeconds, 5, "guest-timeout-policy-refused");
  for (const name of ["retryAuthorized", "cleanupAuthorized", "phaseAdvanceAuthorized", "phase4Authorized"] as const) {
    literal(policy[name], false, `policy-${name}-refused`);
  }

  const review = asRecord(carrier.review, "review");
  exactKeys(review, REVIEW_KEYS, "review");
  literal(review.verdict, "PREMUTATION_CLEAR", "review-verdict-refused");
  literal(review.independent, true, "review-independence-refused");
  literal(review.controllerVerdict, CONTROLLER_VERDICT, "review-controller-verdict-refused");
  const parentDecision = asRecord(carrier.parentDecision, "parentDecision");
  exactKeys(parentDecision, PARENT_DECISION_KEYS, "parentDecision");
  literal(parentDecision.decision, "EXECUTE_EXACT_PHASE3B_CARRIER_ONCE", "parent-decision-refused");
  literal(parentDecision.stable, true, "parent-decision-stability-refused");

  const authorization = asRecord(carrier.authorization, "authorization");
  exactKeys(authorization, AUTHORIZATION_KEYS, "authorization");
  const authorizationId = stringMatch(authorization.id, UUID_V4_UPPER, "authorization-id-refused");
  literal(authorization.oneShot, true, "one-shot-refused");
  for (const name of ["retryAuthorized", "cleanupAuthorized", "phaseAdvanceAuthorized", "phase4Authorized"] as const) {
    literal(authorization[name], false, `authorization-${name}-refused`);
  }
  const attemptEvidencePath = canonicalWindowsPath(authorization.attemptEvidencePath, "attempt-evidence-path-refused");

  const guestExecutables = parseGuestExecutables(carrier.guestExecutables);
  const commands = parseCommands(
    carrier.commands,
    repositoryRoot,
    controllerCommit,
    carrierCommit,
    carrierTree,
    carrierBlobId,
    runner,
    git,
    wsl,
    aggregateDeadlineMs,
    guestExecutables,
    attemptEvidencePath,
  );

  return {
    value: carrier,
    repositoryRoot,
    bindings: [
      phase2, phase3AReceipt, phase3ADecision, ...phase3AArtifacts,
      controllerSource, controllerTest, controllerReceipt, runner, git, wsl,
    ],
    controllerCommit,
    controllerTree,
    carrierCommit,
    carrierTree,
    carrierBlobId,
    runner,
    git,
    wsl,
    authorizationId,
    attemptEvidencePath,
    aggregateDeadlineMs,
    guestExecutables,
    commands,
  };
}

function parseCommands(
  value: unknown,
  repositoryRoot: string,
  controllerCommit: string,
  carrierCommit: string,
  carrierTree: string,
  carrierBlobId: string,
  runner: FileBinding,
  git: FileBinding,
  wsl: FileBinding,
  aggregateDeadlineMs: number,
  guestExecutables: string[],
  attemptEvidencePath: string,
): ControllerCommand[] {
  if (!Array.isArray(value) || value.length < 6 || value.length > 48) {
    throw new ControllerRefusal("command-cardinality-refused");
  }
  const expectedGitArgv = [
    ["--no-pager", "-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    ["--no-pager", "-C", repositoryRoot, "rev-parse", "HEAD^{commit}", "HEAD^{tree}", "HEAD^"],
    ["--no-pager", "-C", repositoryRoot, "diff", "--name-only", "--no-renames", `${controllerCommit}..HEAD`, "--"],
    ["--no-pager", "-C", repositoryRoot, "ls-files", "--stage", "--full-name", "--", PHASE3_HARDENING_FIXED_CARRIER_PATH],
    ["--no-pager", "-C", repositoryRoot, "show", `HEAD:${PHASE3_HARDENING_FIXED_CARRIER_PATH}`],
  ];
  const expectedGitSemantics = [
    "git-status-clean", "git-revision-binding", "git-carrier-only-delta", "git-stage0-carrier", "git-carrier-blob",
  ];
  const pathRoles = new Set<string>([attemptEvidencePath.toUpperCase()]);
  let stdinAggregate = 0;
  let outerAggregate = 0;
  let operationRoot: string | null = null;
  const commands = value.map((entry, ordinal) => {
    const command = asRecord(entry, `commands[${ordinal}]`);
    exactKeys(command, COMMAND_KEYS, `commands[${ordinal}]`);
    const role = stringValue(command.role, "command-role-refused") as ControllerCommand["role"];
    if (!(["git-guard", "wsl-management", "wsl-guest"] as string[]).includes(role)) {
      throw new ControllerRefusal("command-role-refused");
    }
    if ((ordinal < 5 && role !== "git-guard") || (ordinal >= 5 && role === "git-guard")) {
      throw new ControllerRefusal("command-order-refused");
    }
    const decoder = stringValue(command.decoder, "command-decoder-refused") as ControllerCommand["decoder"];
    if (!(["utf-8-no-bom-strict", "utf-16le-no-bom-strict", "raw-hash-only", "silent-mutator"] as string[]).includes(decoder)) {
      throw new ControllerRefusal("command-decoder-refused");
    }
    const semanticClass = stringMatch(command.semanticClass, SAFE_SEMANTIC_CLASS, "semantic-class-refused");
    const requestPath = canonicalWindowsPath(command.requestPath, "request-path-refused");
    const request = parseProcessRequest(command.request);
    if (canonicalizeJson(request) !== canonicalizeJson(command.request)) {
      throw new ControllerRefusal("request-canonical-object-refused");
    }
    if (operationRoot === null) operationRoot = request.containment.operationRoot;
    if (request.containment.operationRoot !== operationRoot) throw new ControllerRefusal("operation-root-drift-refused");
    if (request.containment.consumer !== PROCESS_CONSUMER || request.retryAuthorized !== false) {
      throw new ControllerRefusal("request-authority-refused");
    }
    for (const path of [requestPath, request.attemptMarker.path, request.evidence.path]) {
      requireContained(operationRoot, path, "command-path-containment-refused");
      const key = path.toUpperCase();
      if (pathRoles.has(key)) throw new ControllerRefusal("command-path-role-collision-refused");
      pathRoles.add(key);
    }
    requireContained(operationRoot, attemptEvidencePath, "attempt-path-containment-refused");
    stdinAggregate += request.stdin.bytes;
    if (request.stdin.bytes > 16_384 || stdinAggregate > 65_536) {
      throw new ControllerRefusal("artifact-stdin-cap-refused");
    }
    const outerDeadline = request.limits.deadlineMs + 5_000;
    outerAggregate += outerDeadline;
    if (outerDeadline > aggregateDeadlineMs || outerAggregate > aggregateDeadlineMs) {
      throw new ControllerRefusal("declared-aggregate-deadline-refused");
    }

    if (role === "git-guard") {
      if (request.executable.path !== git.path || request.executable.sha256 !== git.sha256.toLowerCase()) {
        throw new ControllerRefusal("git-executable-binding-refused");
      }
      exactStringArray(request.argv, expectedGitArgv[ordinal]!, "git-argv-refused");
      literal(decoder, ordinal === 4 ? "raw-hash-only" : "utf-8-no-bom-strict", "git-decoder-refused");
      literal(semanticClass, expectedGitSemantics[ordinal]!, "git-semantic-refused");
    } else {
      if (request.executable.path !== wsl.path || request.executable.sha256 !== wsl.sha256.toLowerCase()) {
        throw new ControllerRefusal("wsl-executable-binding-refused");
      }
      validateWslArgv(role, request.argv, decoder, semanticClass, guestExecutables);
    }
    if (request.executable.path === runner.path) throw new ControllerRefusal("runner-child-role-refused");
    const expected = parseExpectation(command.expected, ordinal === 4);
    return { role, decoder, semanticClass, requestPath, request, expected };
  });
  if (operationRoot === null) throw new ControllerRefusal("operation-root-missing");
  return commands;
}

function parseExpectation(value: unknown, carrierBlob: boolean): CommandExpectation {
  const expected = asRecord(value, "command.expected");
  if (carrierBlob) {
    exactKeys(expected, EXPECTED_CARRIER_KEYS, "command.expected");
    literal(expected.stdoutBinding, "exact-carrier-bytes", "carrier-blob-output-binding-refused");
  } else {
    exactKeys(expected, EXPECTED_RAW_KEYS, "command.expected");
  }
  const exitCode = integer(expected.exitCode, -2_147_483_648, 2_147_483_647, "expected-exit-refused");
  const stderrBytes = integer(expected.stderrBytes, 0, 65_536, "expected-stderr-bytes-refused");
  const stderrSha256 = sha256Upper(expected.stderrSha256, "expected-stderr-hash-refused");
  if (stderrBytes !== 0 || stderrSha256 !== EMPTY_SHA256) throw new ControllerRefusal("expected-stderr-must-be-empty");
  if (carrierBlob) return { exitCode, stdoutBinding: "exact-carrier-bytes", stderrBytes, stderrSha256 };
  const stdoutBytes = integer(expected.stdoutBytes, 0, 65_536, "expected-stdout-bytes-refused");
  const stdoutSha256 = sha256Upper(expected.stdoutSha256, "expected-stdout-hash-refused");
  return { exitCode, stdoutBytes, stdoutSha256, stderrBytes, stderrSha256 };
}

function parseGuestExecutables(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new ControllerRefusal("guest-executable-cardinality-refused");
  }
  const parsed = value.map((entry) => {
    const executable = stringValue(entry, "guest-executable-type-refused");
    if (!isAbsolutePosixPath(executable) || forbiddenShellToken(executable.split("/").at(-1)!)) {
      throw new ControllerRefusal("guest-executable-refused");
    }
    return executable;
  });
  if (new Set(parsed).size !== parsed.length || [...parsed].sort().some((entry, index) => entry !== parsed[index])) {
    throw new ControllerRefusal("guest-executable-order-refused");
  }
  return parsed;
}

function validateWslArgv(
  role: ControllerCommand["role"],
  argv: string[],
  decoder: ControllerCommand["decoder"],
  semanticClass: string,
  guestExecutables: string[],
): void {
  if (argv.length === 0 || argv.some((entry) => /[\u0000\r\n;&|<>`$]/u.test(entry))) {
    throw new ControllerRefusal("wsl-argv-token-refused");
  }
  const management = [
    ["--version"], ["--status"], ["--list", "--quiet"], ["--list", "--running", "--quiet"],
    ["--list", "--verbose"], ["--terminate", "DecadansNeurobro"],
  ];
  if (role === "wsl-management") {
    if (!management.some((candidate) => arraysEqual(candidate, argv))) throw new ControllerRefusal("wsl-management-argv-refused");
    const semanticArgv: Record<string, string[]> = {
      "wsl-version-observed": ["--version"],
      "wsl-status-observed": ["--status"],
      "wsl-list-quiet-observed": ["--list", "--quiet"],
      "wsl-list-running-observed": ["--list", "--running", "--quiet"],
      "wsl-list-verbose-observed": ["--list", "--verbose"],
      "wsl-target-terminated": ["--terminate", "DecadansNeurobro"],
    };
    const exactSemanticArgv = semanticArgv[semanticClass];
    if (exactSemanticArgv === undefined || !arraysEqual(exactSemanticArgv, argv)) {
      throw new ControllerRefusal("wsl-management-semantic-argv-refused");
    }
    if (decoder !== "utf-16le-no-bom-strict" && decoder !== "silent-mutator") {
      throw new ControllerRefusal("wsl-management-decoder-refused");
    }
    if (argv[0] === "--terminate" && decoder !== "silent-mutator") throw new ControllerRefusal("wsl-terminate-silence-refused");
    if (argv[0] !== "--terminate" && decoder !== "utf-16le-no-bom-strict") throw new ControllerRefusal("wsl-observation-decoder-refused");
    return;
  }
  if (
    argv.length < 9 || argv[0] !== "--distribution" || argv[1] !== "DecadansNeurobro" ||
    argv[2] !== "--user" || !["root", "neurobro"].includes(argv[3]!) || argv[4] !== "--exec"
  ) {
    throw new ControllerRefusal("wsl-guest-prefix-refused");
  }
  const executable = argv[5]!;
  const guestTarget = argv[8]!;
  if (
    executable !== "/usr/bin/timeout" || argv[6] !== "--signal=TERM" || argv[7] !== "5s" ||
    !guestExecutables.includes(executable) || !guestExecutables.includes(guestTarget) ||
    !isAbsolutePosixPath(executable) || !isAbsolutePosixPath(guestTarget) || forbiddenShellToken(guestTarget)
  ) {
    throw new ControllerRefusal("wsl-guest-executable-refused");
  }
  if (argv.some((entry) => forbiddenShellToken(entry)) || argv.includes("-c")) {
    throw new ControllerRefusal("wsl-shell-refused");
  }
  if (decoder !== "utf-8-no-bom-strict" && decoder !== "raw-hash-only" && decoder !== "silent-mutator") {
    throw new ControllerRefusal("wsl-guest-decoder-refused");
  }
}

async function validateAllBoundFiles(
  carrier: ParsedCarrier,
  carrierBytes: Uint8Array,
  boundary: Phase3ControllerBoundary,
): Promise<void> {
  const carrierObservation = await boundary.readBoundFile(PHASE3_HARDENING_FIXED_CARRIER_PATH);
  validateFileObservation(
    carrierObservation,
    {
      path: PHASE3_HARDENING_FIXED_CARRIER_PATH,
      bytes: carrierBytes.byteLength,
      sha256: sha256Hex(carrierBytes).toUpperCase(),
    },
    win32.join(carrier.repositoryRoot, PHASE3_HARDENING_FIXED_CARRIER_PATH),
    "carrier-readback",
  );
  if (!Buffer.from(carrierObservation.content).equals(Buffer.from(carrierBytes))) {
    throw new ControllerRefusal("carrier-byte-readback-refused");
  }
  for (const binding of carrier.bindings) {
    const observation = await boundary.readBoundFile(binding.path);
    const expectedResolved = win32.isAbsolute(binding.path)
      ? binding.path
      : win32.join(carrier.repositoryRoot, binding.path);
    validateFileObservation(observation, binding, expectedResolved, "bound-file");
  }
}

function validateFileObservation(
  observationValue: Phase3BoundFileObservation,
  binding: FileBinding,
  expectedResolvedPath: string,
  label: string,
): void {
  const observation = asRecord(observationValue, label);
  exactKeys(observation, FILE_OBSERVATION_KEYS, label);
  literal(observation.path, binding.path, `${label}-path-refused`);
  literal(observation.resolvedPath, expectedResolvedPath, `${label}-resolved-path-refused`);
  literal(observation.exists, true, `${label}-missing`);
  literal(observation.kind, "regular-file", `${label}-kind-refused`);
  literal(observation.isContained, true, `${label}-containment-refused`);
  literal(observation.isReparsePoint, false, `${label}-reparse-refused`);
  literal(observation.bytes, binding.bytes, `${label}-bytes-refused`);
  literal(observation.sha256, binding.sha256, `${label}-sha256-refused`);
  if (!(observation.content instanceof Uint8Array) || observation.content.byteLength !== binding.bytes) {
    throw new ControllerRefusal(`${label}-content-readback-refused`);
  }
  literal(
    sha256Hex(observation.content).toUpperCase(),
    binding.sha256,
    `${label}-content-sha256-refused`,
  );
}

function validateWriteObservation(
  observationValue: Phase3DurableWriteObservation,
  path: string,
  bytes: Uint8Array,
  label: string,
): void {
  const observation = asRecord(observationValue, label);
  exactKeys(observation, WRITE_OBSERVATION_KEYS, label);
  literal(observation.path, path, `${label}-path-refused`);
  literal(observation.resolvedPath, path, `${label}-resolved-path-refused`);
  if (observation.created === false) throw new ControllerRefusal(`${label}-create-collision`);
  literal(observation.created, true, `${label}-create-refused`);
  literal(observation.durableFlushCompleted, true, `${label}-durability-refused`);
  literal(observation.exists, true, `${label}-readback-missing`);
  literal(observation.kind, "regular-file", `${label}-kind-refused`);
  literal(observation.isContained, true, `${label}-containment-refused`);
  literal(observation.isReparsePoint, false, `${label}-reparse-refused`);
  literal(observation.bytes, bytes.byteLength, `${label}-bytes-refused`);
  literal(observation.sha256, sha256Hex(bytes).toUpperCase(), `${label}-hash-refused`);
  if (!(observation.content instanceof Uint8Array) || !Buffer.from(observation.content).equals(Buffer.from(bytes))) {
    throw new ControllerRefusal(`${label}-readback-refused`);
  }
}

function validateSidecarResult(
  resultValue: RustSidecarResult,
  requestBytes: Uint8Array,
  request: ProcessRequest,
): ReturnType<typeof parseProcessEvidence> {
  const result = asRecord(resultValue, "sidecarResult");
  exactKeys(result, SIDECAR_RESULT_KEYS, "sidecarResult");
  literal(result.adapter, "replaceable-rust-sidecar-v1", "sidecar-adapter-refused");
  literal(result.requestSha256, sha256Hex(requestBytes), "sidecar-request-hash-refused");
  literal(result.sidecarProcessStartCount, 1, "sidecar-start-count-refused");
  literal(result.sidecarExitCodeKnown, true, "sidecar-exit-known-refused");
  literal(result.sidecarExitCode, 0, "sidecar-exit-refused");
  literal(result.sidecarOutputComplete, true, "sidecar-output-complete-refused");
  integer(result.sidecarStdoutBytes, 1, 65_536, "sidecar-stdout-cap-refused");
  stringMatch(result.sidecarStdoutSha256, /^[0-9a-f]{64}$/u, "sidecar-stdout-hash-refused");
  literal(result.sidecarStderrBytes, 0, "sidecar-stderr-refused");
  literal(result.sidecarStderrSha256, EMPTY_SHA256.toLowerCase(), "sidecar-stderr-hash-refused");
  literal(result.evidenceRecoveredBeforeAckParse, true, "evidence-before-decode-refused");
  integer(result.evidenceBytes, 1, CONTRACT_LIMITS.evidenceBytesMax, "evidence-bytes-refused");
  stringMatch(result.evidenceSha256, /^[0-9a-f]{64}$/u, "evidence-hash-refused");
  integer(result.runnerPeakWorkingSetBytes, 0, 67_108_864, "runner-working-set-refused");
  literal(result.retryPerformed, false, "sidecar-retry-refused");
  const evidence = parseProcessEvidence(result.evidence);
  if (
    evidence.requestBytes !== requestBytes.byteLength ||
    evidence.requestSha256 !== sha256Hex(requestBytes) ||
    evidence.executableSha256Observed !== request.executable.sha256 ||
    evidence.argv.length !== request.argv.length ||
    evidence.argv.some((argument, index) => argument !== request.argv[index]) ||
    evidence.stdinBytes !== request.stdin.bytes ||
    evidence.stdinSha256 !== request.stdin.sha256 ||
    evidence.retryPerformed !== false ||
    evidence.cleanupPerformed !== false
  ) {
    throw new ControllerRefusal("process-evidence-request-binding-refused");
  }
  if (evidence.standardOutput.bytes > 65_536 || evidence.standardError.bytes > 65_536) {
    throw new ControllerRefusal("decoded-stream-cap-refused");
  }
  return evidence;
}

function validateCommandOutput(
  command: ControllerCommand,
  evidence: ReturnType<typeof parseProcessEvidence>,
  carrierBytes: Uint8Array,
  carrier: ParsedCarrier,
): void {
  const stdout = Buffer.from(evidence.standardOutput.base64, "base64");
  const stderr = Buffer.from(evidence.standardError.base64, "base64");
  if (
    stdout.byteLength !== evidence.standardOutput.bytes ||
    sha256Hex(stdout) !== evidence.standardOutput.sha256 ||
    stderr.byteLength !== evidence.standardError.bytes ||
    sha256Hex(stderr) !== evidence.standardError.sha256 ||
    evidence.standardOutput.truncated || evidence.standardError.truncated ||
    !evidence.standardOutput.complete || !evidence.standardError.complete
  ) {
    throw new ControllerRefusal("raw-stream-binding-refused");
  }
  if (
    evidence.exitCode !== command.expected.exitCode ||
    stderr.byteLength !== command.expected.stderrBytes ||
    sha256Hex(stderr).toUpperCase() !== command.expected.stderrSha256 ||
    stderr.byteLength !== 0
  ) {
    throw new ControllerRefusal("expected-terminal-output-refused");
  }
  if (command.expected.stdoutBinding === "exact-carrier-bytes") {
    if (!stdout.equals(Buffer.from(carrierBytes))) throw new ControllerRefusal("carrier-blob-bytes-refused");
  } else if (
    stdout.byteLength !== command.expected.stdoutBytes ||
    sha256Hex(stdout).toUpperCase() !== command.expected.stdoutSha256
  ) {
    throw new ControllerRefusal("expected-stdout-refused");
  }

  let decoded: string | null = null;
  switch (command.decoder) {
    case "utf-8-no-bom-strict":
      decoded = strictUtf8(stdout);
      break;
    case "utf-16le-no-bom-strict":
      decoded = strictUtf16Le(stdout);
      break;
    case "raw-hash-only":
      break;
    case "silent-mutator":
      if (stdout.byteLength !== 0 || stderr.byteLength !== 0) throw new ControllerRefusal("silent-mutator-output-refused");
      break;
  }

  if (command.role === "git-guard") {
    switch (command.semanticClass) {
      case "git-status-clean":
        if (decoded !== "") throw new ControllerRefusal("git-status-dirty");
        break;
      case "git-revision-binding":
        if (decoded !== `${carrier.carrierCommit}\n${carrier.carrierTree}\n${carrier.controllerCommit}\n`) {
          throw new ControllerRefusal("git-revision-drift");
        }
        break;
      case "git-carrier-only-delta":
        if (decoded !== `${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`) throw new ControllerRefusal("git-extra-delta-refused");
        break;
      case "git-stage0-carrier":
        if (decoded !== `100644 ${carrier.carrierBlobId} 0\t${PHASE3_HARDENING_FIXED_CARRIER_PATH}\n`) {
          throw new ControllerRefusal("git-carrier-mode-or-blob-refused");
        }
        break;
      case "git-carrier-blob":
        if (!stdout.equals(Buffer.from(carrierBytes))) throw new ControllerRefusal("git-carrier-show-refused");
        break;
    }
  }
}

function makeCommandReceipt(
  ordinal: number,
  command: ControllerCommand,
  result: RustSidecarResult,
  evidence: ReturnType<typeof parseProcessEvidence>,
): Record<string, unknown> {
  return {
    ordinal,
    role: command.role,
    semanticClass: command.semanticClass,
    requestBytes: evidence.requestBytes,
    requestSha256: evidence.requestSha256.toUpperCase(),
    durableEvidenceBytes: result.evidenceBytes,
    durableEvidenceSha256: result.evidenceSha256.toUpperCase(),
    terminalState: evidence.terminalState,
    exitCodeKnown: evidence.exitCodeKnown,
    exitCode: evidence.exitCode,
    outputComplete: evidence.outputComplete,
    stdoutBytes: evidence.standardOutput.bytes,
    stdoutSha256: evidence.standardOutput.sha256.toUpperCase(),
    stderrBytes: evidence.standardError.bytes,
    stderrSha256: evidence.standardError.sha256.toUpperCase(),
    retryPerformed: false,
    cleanupPerformed: false,
  };
}

function strictUtf8(bytes: Uint8Array): string {
  if (hasUtf8Bom(bytes)) throw new ControllerRefusal("utf8-bom-refused");
  let text: string;
  try {
    text = decodeStrictUtf8(bytes, "$commandOutput");
  } catch {
    throw new ControllerRefusal("utf8-malformed-refused");
  }
  validateDecodedText(text, "utf8");
  return text;
}

function strictUtf16Le(bytes: Uint8Array): string {
  if (bytes.byteLength % 2 !== 0) throw new ControllerRefusal("utf16-odd-byte-refused");
  if (bytes.byteLength >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    throw new ControllerRefusal("utf16-bom-refused");
  }
  for (let index = 0; index < bytes.byteLength; index += 2) {
    const unit = bytes[index]! | (bytes[index + 1]! << 8);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 3 >= bytes.byteLength) throw new ControllerRefusal("utf16-surrogate-refused");
      const next = bytes[index + 2]! | (bytes[index + 3]! << 8);
      if (next < 0xdc00 || next > 0xdfff) throw new ControllerRefusal("utf16-surrogate-refused");
      index += 2;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ControllerRefusal("utf16-surrogate-refused");
    }
  }
  const text = Buffer.from(bytes).toString("utf16le");
  validateDecodedText(text, "utf16");
  return text;
}

function validateDecodedText(text: string, label: string): void {
  if (text.includes("\u0000") || text.includes("\uFFFD") || text.includes("\uFEFF") || text.includes("\uFFFE")) {
    throw new ControllerRefusal(`${label}-forbidden-codepoint-refused`);
  }
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if ((code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0x7f) {
      throw new ControllerRefusal(`${label}-control-refused`);
    }
  }
}

function parseFileBinding(
  value: unknown,
  label: string,
  expectedKeys: readonly string[] = FILE_BINDING_KEYS,
): FileBinding {
  const record = asRecord(value, label);
  exactKeys(record, expectedKeys, label);
  const path = stringValue(record.path, `${label}-path-refused`);
  if (path.length === 0 || /[\u0000\r\n]/u.test(path)) throw new ControllerRefusal(`${label}-path-refused`);
  const bytes = integer(record.bytes, 1, Number.MAX_SAFE_INTEGER, `${label}-bytes-refused`);
  const sha256 = sha256Upper(record.sha256, `${label}-sha256-refused`);
  return { path, bytes, sha256 };
}

function exactFileBinding(actual: FileBinding, expected: FileBinding, code: string): void {
  if (actual.path !== expected.path || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new ControllerRefusal(code);
  }
}

function canonicalWindowsPath(value: unknown, code: string): string {
  const path = stringValue(value, code);
  if (
    !win32.isAbsolute(path) || !/^[A-Z]:\\/u.test(path) || path.startsWith("\\\\") ||
    path.startsWith("\\\\?\\") || /[\u0000\r\n]/u.test(path) || win32.normalize(path) !== path
  ) {
    throw new ControllerRefusal(code);
  }
  return path;
}

function requireContained(root: string, path: string, code: string): void {
  const rootKey = root.toUpperCase();
  const pathKey = path.toUpperCase();
  if (pathKey !== rootKey && !pathKey.startsWith(`${rootKey}\\`)) throw new ControllerRefusal(code);
}

function gitObjectId(value: unknown, code: string, exactLength?: number): string {
  const text = stringValue(value, code);
  if (!GIT_OBJECT_ID.test(text) || (exactLength !== undefined && text.length !== exactLength)) {
    throw new ControllerRefusal(code);
  }
  return text;
}

function exactStringArray(actual: readonly string[], expected: readonly string[], code: string): void {
  if (!arraysEqual(actual, expected)) throw new ControllerRefusal(code);
}

function arraysEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function isAbsolutePosixPath(value: string): boolean {
  return value.startsWith("/") && !value.includes("//") && !value.includes("/../") && !value.endsWith("/..") &&
    !value.includes("/./") && !value.endsWith("/.") && !/[\u0000\r\n]/u.test(value);
}

function forbiddenShellToken(value: string): boolean {
  const token = value.toLowerCase();
  return ["sh", "bash", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "-c"].includes(token);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ControllerRefusal(`${label}-object-refused`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ControllerRefusal(`${label}-prototype-refused`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  try {
    assertExactKeys(record, keys, label);
  } catch {
    throw new ControllerRefusal(`${label}-property-set-refused`);
  }
}

function literal<T>(value: unknown, expected: T, code: string): T {
  if (value !== expected) throw new ControllerRefusal(code);
  return expected;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string") throw new ControllerRefusal(code);
  return value;
}

function stringMatch(value: unknown, pattern: RegExp, code: string): string {
  const text = stringValue(value, code);
  if (!pattern.test(text)) throw new ControllerRefusal(code);
  return text;
}

function sha256Upper(value: unknown, code: string): string {
  return stringMatch(value, SHA256_UPPER, code);
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ControllerRefusal(code);
  }
  return value as number;
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function extractTerminationRequestCount(error: unknown): number {
  if (error === null || typeof error !== "object") return 0;
  const termination = (error as { termination?: unknown }).termination;
  if (termination === null || typeof termination !== "object") return 0;
  const count = (termination as { killRequestCount?: unknown }).killRequestCount;
  return Number.isSafeInteger(count) && (count as number) >= 0 ? count as number : 0;
}

function refusalCode(error: unknown): string {
  return error instanceof ControllerRefusal ? error.code : "carrier-or-bound-file-refused";
}
