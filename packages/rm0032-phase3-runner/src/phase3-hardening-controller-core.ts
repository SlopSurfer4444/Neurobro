import type {
  RustSidecarAuthority,
  RustSidecarResult,
} from "./rust-sidecar-adapter.ts";

export type Phase3ControllerOutcome =
  | "known-clear"
  | "terminal-refused"
  | "terminal-known-failure"
  | "terminal-unknown";

export interface Phase3BoundFileObservation {
  path: string;
  resolvedPath: string;
  exists: boolean;
  kind: string;
  isContained: boolean;
  isReparsePoint: boolean;
  bytes: number;
  sha256: string;
  content: Uint8Array;
}

export interface Phase3DurableWriteObservation {
  path: string;
  resolvedPath: string;
  created: boolean;
  durableFlushCompleted: boolean;
  exists: boolean;
  kind: string;
  isContained: boolean;
  isReparsePoint: boolean;
  bytes: number;
  sha256: string;
  content: Uint8Array;
}

export interface Phase3ControllerBoundary {
  readBoundFile(path: string): Promise<Phase3BoundFileObservation>;
  createNewDurableFile(path: string, bytes: Uint8Array): Promise<Phase3DurableWriteObservation>;
  monotonicMilliseconds(): number;
  invokeAcceptedRustSidecar(
    requestBytes: Uint8Array,
    authority: RustSidecarAuthority,
  ): Promise<RustSidecarResult>;
}

export interface Phase3ControllerResult {
  outcome: Phase3ControllerOutcome;
  retryAuthorized: false;
  cleanupAuthorized: false;
  acceptedCommandCount: number;
  rustInvocationCount: number;
  controllerKillCount: 0;
  runnerTerminationRequestCount: number;
  carrierBytes: number;
  carrierSha256: string;
  attemptEvidenceBytes: number;
  attemptEvidenceSha256: string;
  receiptCandidate: Record<string, unknown>;
}

export const PHASE3_CONTROLLER_EMPTY_SHA256 =
  "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
export const PHASE3_CONTROLLER_PHASE_ID =
  "phase-3-wsl-hardening-identity-and-resource-verification";

export class Phase3ControllerRefusal extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ControllerRefusal";
    this.code = code;
  }
}

export interface Phase3ControllerExecutionState {
  acceptedCommandCount: number;
  rustInvocationCount: number;
  runnerTerminationRequestCount: number;
  attemptEvidenceBytes: number;
  attemptEvidenceSha256: string;
  commandReceipts: Array<Record<string, unknown>>;
}

export function makePhase3ControllerResult(
  outcome: Phase3ControllerOutcome,
  carrierBytes: number,
  carrierSha256: string,
  state: Phase3ControllerExecutionState,
  semanticClass: string,
): Phase3ControllerResult {
  return {
    outcome,
    retryAuthorized: false,
    cleanupAuthorized: false,
    acceptedCommandCount: state.acceptedCommandCount,
    rustInvocationCount: state.rustInvocationCount,
    controllerKillCount: 0,
    runnerTerminationRequestCount: state.runnerTerminationRequestCount,
    carrierBytes,
    carrierSha256,
    attemptEvidenceBytes: state.attemptEvidenceBytes,
    attemptEvidenceSha256: state.attemptEvidenceSha256,
    receiptCandidate: {
      schema: "decadans.rm0032.phase3-controller-run-receipt-candidate.v1",
      outcome,
      phase: PHASE3_CONTROLLER_PHASE_ID,
      semanticClass,
      carrier: { bytes: carrierBytes, sha256: carrierSha256 },
      attemptEvidence: { bytes: state.attemptEvidenceBytes, sha256: state.attemptEvidenceSha256 },
      counts: {
        acceptedCommandCount: state.acceptedCommandCount,
        rustInvocationCount: state.rustInvocationCount,
        controllerKillCount: 0,
        runnerTerminationRequestCount: state.runnerTerminationRequestCount,
      },
      commands: state.commandReceipts,
      rawProcessBodies: false,
      retryAuthorized: false,
      cleanupAuthorized: false,
      liveAuthorityGranted: false,
      lifecycleAdvanced: false,
      phase4AuthorityGranted: false,
    },
  };
}
