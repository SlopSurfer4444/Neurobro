/** The adapter controls only bridge-owned App Server jobs. Desktop attachment is unsupported. */
export interface ExecutorVerification {
  id: string; executorId: string; projectRoot: string; verifiedAt: string; expiresAt: string;
  sandbox: 'read-only' | 'workspace-write'; networkAccess: boolean;
  /** Receipt of actual OS/tool negative probes, not a sandbox flag or profile name. */
  boundaryReceipt: string;
}
export interface ComputerProject {
  id: string; root: string;
  permissions: {
    sandbox: 'read-only' | 'workspace-write'; networkAccess: boolean;
    approvalPolicy: 'never' | 'on-request' | 'untrusted';
    verification?: ExecutorVerification;
  };
}
export type ComputerTaskState = 'created' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed' | 'unknown';
export interface ComputerBinding { intentRevision: number; grantId: string; grantRevision: number }
export interface ComputerTask {
  taskId: string; projectId: string; projectRoot: string; cwd: string; executorId: string;
  threadId?: string; turnId?: string; state: ComputerTaskState; observedAt: string;
  nativeStatus?: 'active' | 'idle' | 'notLoaded' | 'systemError';
  output?: string; reason?: string;
  /** Completion of protocol is distinct from physical/tool/effect settlement. */
  executionSettled?: boolean; effectsReconciled?: boolean;
  /** Trusted parent authority generation; never supplied by the model. */
  binding?: ComputerBinding;
  stopRequestedAt?: string;
  interruptRequestedAt?: string;
  priorExecutions?: Array<Omit<ComputerTask, 'priorExecutions'>>;
  pending?: { operationId: string; method: string; state: 'dispatching' | 'unknown' };
}
export interface ComputerStopResult { settled: boolean; reason?: string; task?: ComputerTask }
export interface ComputerRegistry {
  list(): Promise<ComputerTask[]>;
  get(taskId: string): Promise<ComputerTask | undefined>;
  put(task: ComputerTask): Promise<void>;
}
export interface ComputerArtifact { taskId: string; turnId: string; itemId: string; path: string; kind: 'fileChange' | 'imageGeneration' }
export interface ComputerDoctor {
  executorId: string; transport: string; desktopAttachment: false;
  projects: Array<{ id: string; readable: boolean; executable: boolean; reason?: string; action?: string }>;
}
export interface ExecutionSettlement {
  executionSettled: boolean; effectsReconciled: boolean;
  /** Bound host verifier reports owned descendants/tool channel closure and effect reconciliation. */
  receipt?: string;
}
