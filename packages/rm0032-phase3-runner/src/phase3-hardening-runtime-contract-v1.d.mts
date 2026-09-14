export interface GitTuple { commit: string; tree: string; parent: string }
export interface FileBinding { path: string; bytes: number; sha256: string }
export interface StartupBinding {
  schema: string; acceptanceId: string; repositoryRoot: string; cwd: string;
  acceptedGeneration: { p: GitTuple; a: GitTuple; k: GitTuple & { carrierBlobId: string } };
  binaryBindings: { runner: FileBinding; git: FileBinding; wsl: FileBinding };
  nativePrestart: FileBinding; node: FileBinding & { version: string; platform: string; arch: string };
  liveEntry: FileBinding; carrier: FileBinding; launcher: FileBinding; observer: FileBinding;
}
export const ACCEPTED_C1: Readonly<GitTuple>;
export const CARRIER_SCHEMA: string;
export const STARTUP_SCHEMA: string;
export const STARTUP_BINDING_PATH: string;
export const FIXED_STARTUP_BINDING_PATH: string;
export const FIXED_CARRIER_PATH: string;
export const EXACT_P_DELTA: ReadonlyArray<{path: string; status: string}>;
export const EXACT_A_DELTA: typeof EXACT_P_DELTA;
export const EXACT_K_DELTA: typeof EXACT_P_DELTA;
export const CARRIER_KEYS: Readonly<Record<string, readonly string[]>>;
export const GIT_GUARD_BINDINGS: readonly string[];
export const GIT_GUARD_SEMANTICS: readonly string[];
export function canonicalJson(value: unknown): string;
export function canonicalDosPath(value: unknown, label?: string): string;
export function resolveRuntimeFilePath(repositoryRoot: string, path: string): string;

export interface RuntimeProjection { readonly checkpoint: string; readonly status: string; readonly writeDelta: typeof EXACT_P_DELTA }
export const RUNTIME_PROJECTIONS: Readonly<{P: RuntimeProjection; K: RuntimeProjection}>;
export function assertRuntimeProjection(posture: string, node: unknown): RuntimeProjection;
export function sha256(bytes: Uint8Array): string;
export function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, any>;
export function parseCanonicalBytes(bytes: Uint8Array, label?: string): any;
export function parseExternalStartupBinding(bytes: Uint8Array): StartupBinding;
export function parseRuntimeCarrier(bytes: Uint8Array): Record<string, any>;
export function assertCarrierStartupAgreement(carrier: Record<string, any>, binding: StartupBinding, bytes: Uint8Array): void;
export function runtimeGitGuardArgv(carrier: Record<string, any>): string[][];
export function parseRuntimeLineage(bytes: Uint8Array): GitTuple[];
export function parseRawGitDelta(bytes: Uint8Array): Array<{path: string;status: string;mode: string;type: string;oldOid: string;oid: string}>;
export function validateGitGuardOutput(index: number, bytes: Uint8Array, context: {carrier: Record<string, any>; binding: StartupBinding; carrierBytes: Uint8Array}): void;
export function classifyRuntimePosture(facts: {
 acceptedC1: GitTuple; commits: GitTuple[]; committedDeltas: Array<Array<{path:string;status:string;mode:string;type:string}>>;
 head: string; trackedWorktreeDelta: Array<{path:string;status:string}>; untrackedPaths:string[]; cachedDelta:Array<{path:string;status:string}>;
 indexVisibilityClean: boolean;
 observePhysicalEntry(path:string,provenance:string): Record<string,unknown>;
 observeCommittedTreeEntry(commit:string,path:string): {path:string;mode:string;type:string};
}): "C1_COMMIT_CLEAN" | "P_WORKING_EXACT" | "P_COMMIT_CLEAN" | "A_WORKING_EXACT" | "A_COMMIT_CLEAN" | "K_WORKING_EXACT" | "K_COMMIT_CLEAN";
