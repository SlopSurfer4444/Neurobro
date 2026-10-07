import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { AppServerTransport } from './transport.ts';
import { canonicalDirectory, scopedPath, within } from './paths.ts';
import type { ComputerArtifact, ComputerBinding, ComputerDoctor, ComputerProject, ComputerRegistry, ComputerStopResult, ComputerTask, ExecutionSettlement } from './types.ts';
export { AppServerTransport, RpcError } from './transport.ts';
export { JsonFileComputerRegistry } from './registry.ts';
export { createComputerTools } from './tools.ts';
export type * from './types.ts';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMPUTER_INVALID_RESPONSE');
  return value as RecordValue;
}
function string(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('COMPUTER_INVALID_ID'); return value; }
function input(text: string) {
  if (!text.trim() || Buffer.byteLength(text) > 128 * 1024) throw new Error('COMPUTER_INPUT_LIMIT');
  return [{ type: 'text', text, text_elements: [] }];
}
function terminal(status: unknown): boolean { return status === 'completed' || status === 'failed' || status === 'interrupted'; }
/** Only raised after the task's dispatch intent and UNKNOWN disposition are durably retained. */
export class ComputerDispatchUnknown extends Error {
  readonly taskId: string; readonly operationId?: string; readonly code: string;
  constructor(taskId: string, operationId: string | undefined, code: string, message: string) {
    super(message); this.name = 'ComputerDispatchUnknown'; this.taskId = taskId; this.operationId = operationId; this.code = code;
  }
}
export interface CodexComputerOptions {
  projects: ComputerProject[]; executorId: string; registry: ComputerRegistry; transport: AppServerTransport;
  now?: () => Date;
  /** Trusted executor-side verifier, never a model-provided assertion. */
  settlement?: (task: ComputerTask) => Promise<ExecutionSettlement>;
  interruptTimeoutMs?: number;
}

/** Supported local protocol adapter; no private DB access, authentication copying or desktop attach. */
export class CodexComputerAdapter {
  private readonly projects = new Map<string, ComputerProject>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly stopFences = new Map<string, number>();
  private ready?: Promise<void>;
  private closing = false;
  private readonly options: CodexComputerOptions;
  constructor(options: CodexComputerOptions) {
    this.options = options;
    if (!options.executorId) throw new Error('COMPUTER_EXECUTOR_ID_REQUIRED');
    for (const project of options.projects) {
      if (!project.id || this.projects.has(project.id)) throw new Error('COMPUTER_DUPLICATE_PROJECT');
      this.projects.set(project.id, structuredClone(project));
    }
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private async init(): Promise<void> {
    this.ready ??= (async () => {
      for (const project of this.projects.values()) project.root = await canonicalDirectory(project.root);
      await this.options.transport.start();
    })();
    return this.ready;
  }
  private project(projectId: string): ComputerProject {
    const project = this.projects.get(projectId); if (!project) throw new Error('COMPUTER_PROJECT_NOT_REGISTERED'); return project;
  }
  private verificationReason(project: ComputerProject): string | undefined {
    const v = project.permissions.verification;
    if (!v || !v.id || !v.boundaryReceipt) return 'executor boundary has no verification receipt';
    if (v.executorId !== this.options.executorId || v.projectRoot !== project.root || v.sandbox !== project.permissions.sandbox || v.networkAccess !== project.permissions.networkAccess) return 'executor verification is bound to another policy or root';
    const now = Date.parse(this.now());
    if (!Number.isFinite(Date.parse(v.verifiedAt)) || !Number.isFinite(Date.parse(v.expiresAt)) || Date.parse(v.verifiedAt) > now || Date.parse(v.expiresAt) <= now) return 'executor verification is expired or invalid';
    return undefined;
  }
  private requireExecution(project: ComputerProject): void {
    if (this.verificationReason(project)) throw new Error('COMPUTER_EXECUTOR_UNVERIFIED');
  }
  private sandbox(project: ComputerProject): RecordValue {
    if (project.permissions.sandbox === 'read-only') return { type: 'readOnly', networkAccess: project.permissions.networkAccess };
    return { type: 'workspaceWrite', writableRoots: [project.root], networkAccess: project.permissions.networkAccess, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  }
  private async validatePolicy(project: ComputerProject, response: RecordValue, cwd: string): Promise<void> {
    if (await canonicalDirectory(string(response.cwd)) !== cwd || response.approvalPolicy !== project.permissions.approvalPolicy) throw new Error('COMPUTER_EFFECTIVE_POLICY_MISMATCH');
    const sandbox = record(response.sandbox);
    const expected = this.sandbox(project);
    if (sandbox.type !== expected.type || sandbox.networkAccess !== expected.networkAccess) throw new Error('COMPUTER_EFFECTIVE_POLICY_MISMATCH');
    if (sandbox.type === 'workspaceWrite') {
      if (!Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.length !== 1 || await canonicalDirectory(string(sandbox.writableRoots[0])) !== project.root || sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true) throw new Error('COMPUTER_EFFECTIVE_POLICY_MISMATCH');
    }
  }
  private async task(taskId: string, binding?: ComputerBinding): Promise<ComputerTask> {
    const task = await this.options.registry.get(taskId);
    if (!task || task.executorId !== this.options.executorId) throw new Error('COMPUTER_TASK_NOT_OWNED');
    const project = this.project(task.projectId);
    if (task.projectRoot !== project.root || !within(project.root, task.cwd) || await canonicalDirectory(task.cwd) !== task.cwd) throw new Error('COMPUTER_TASK_BINDING_MISMATCH');
    if (binding && !this.sameBinding(task.binding, binding)) throw new Error('COMPUTER_PARENT_BINDING_MISMATCH');
    return task;
  }
  private sameBinding(a: ComputerBinding | undefined, b: ComputerBinding | undefined): boolean {
    return a?.intentRevision === b?.intentRevision && a?.grantId === b?.grantId && a?.grantRevision === b?.grantRevision;
  }
  private requireUnstopped(taskId: string, binding?: ComputerBinding, task?: ComputerTask): void {
    const fence = this.stopFences.get(taskId);
    if (task?.stopRequestedAt || (fence !== undefined && (binding?.intentRevision ?? 0) <= fence)) throw new Error('COMPUTER_PARENT_STOPPED');
  }
  private async boundThread(task: ComputerTask, value: unknown): Promise<RecordValue> {
    const thread = record(value);
    if (string(thread.id) !== task.threadId || await canonicalDirectory(string(thread.cwd)) !== task.cwd) throw new Error('COMPUTER_THREAD_BINDING_MISMATCH');
    return thread;
  }
  private async exclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('COMPUTER_EXECUTOR_CLOSED');
    if (this.locks.has(taskId)) throw new Error('COMPUTER_CONCURRENT_MUTATION');
    let release!: () => void;
    this.locks.set(taskId, new Promise<void>(resolve => { release = resolve; }));
    try { return await operation(); } finally { this.locks.delete(taskId); release(); }
  }
  private async persistDispatch(task: ComputerTask, method: string): Promise<string> {
    if (task.pending) throw new Error('COMPUTER_RECONCILIATION_REQUIRED');
    const operationId = randomUUID();
    if (method === 'turn/start') { delete task.output; delete task.executionSettled; delete task.effectsReconciled; }
    task.pending = { operationId, method, state: 'dispatching' }; task.observedAt = this.now();
    await this.options.registry.put(task); return operationId;
  }
  private async uncertain(task: ComputerTask, error: unknown): Promise<never> {
    const failure = error as { outcome?: string; code?: string };
    const knownRejection = failure.outcome === 'failed' && ['INVALID_REQUEST', 'TRANSPORT_NOT_READY', 'TRANSPORT_STOPPED', 'SERVER_ERROR_-32601', 'SERVER_ERROR_-32602'].includes(failure.code ?? '');
    if (knownRejection) { delete task.pending; task.reason = 'provider rejected request before admission'; }
    else { if (task.pending) task.pending.state = 'unknown'; task.state = 'unknown'; task.reason = 'dispatch outcome requires reconciliation; no automatic retry'; }
    task.observedAt = this.now(); await this.options.registry.put(task);
    if (!knownRejection) throw new ComputerDispatchUnknown(task.taskId, task.pending?.operationId, failure.code ?? 'COMPUTER_DISPATCH_UNKNOWN', error instanceof Error ? error.message : 'computer dispatch unknown');
    throw error;
  }
  async doctor(): Promise<ComputerDoctor> {
    const result: ComputerDoctor = { executorId: this.options.executorId, transport: this.options.transport.state().state, desktopAttachment: false, projects: [] };
    for (const project of this.projects.values()) {
      try {
        project.root = await canonicalDirectory(project.root);
        const reason = this.verificationReason(project);
        result.projects.push({ id: project.id, readable: true, executable: !reason, ...(reason ? { reason, action: 'Run executor OS/tool boundary negative probes for this root/policy and configure the dated receipt; then validate App Server effective policy on creation.' } : {}) });
      } catch { result.projects.push({ id: project.id, readable: false, executable: false, reason: 'registered root unavailable', action: 'Restore or explicitly register an existing absolute project directory.' }); }
    }
    return result;
  }
  async listProjects(): Promise<Array<{ id: string; root: string }>> {
    for (const project of this.projects.values()) project.root = await canonicalDirectory(project.root);
    return [...this.projects.values()].map(p => ({ id: p.id, root: p.root }));
  }
  async listTasks(projectId: string, options: { cursor?: string; limit?: number } = {}): Promise<{ tasks: ComputerTask[]; nextCursor?: string }> {
    await this.init(); const project = this.project(projectId);
    const limit = options.limit ?? 25; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('COMPUTER_PAGE_LIMIT');
    const response = record(await this.options.transport.request('thread/list', { cwd: project.root, sourceKinds: ['appServer'], useStateDbOnly: true, limit, ...(options.cursor ? { cursor: options.cursor } : {}) }));
    if (!Array.isArray(response.data)) throw new Error('COMPUTER_INVALID_RESPONSE');
    const owned = (await this.options.registry.list()).filter(t => t.projectId === projectId && t.executorId === this.options.executorId && t.projectRoot === project.root);
    const tasks: ComputerTask[] = [];
    for (const item of response.data) {
      const thread = record(item); const task = owned.find(t => t.threadId === thread.id);
      if (task) { await this.boundThread(task, thread); tasks.push(task); }
    }
    return { tasks, ...(typeof response.nextCursor === 'string' ? { nextCursor: response.nextCursor } : {}) };
  }
  async createTask(request: { taskId: string; projectId: string; cwd?: string; model?: string; binding?: ComputerBinding }): Promise<ComputerTask> {
    return this.exclusive(request.taskId, async () => {
      this.requireUnstopped(request.taskId, request.binding); await this.init();
      const project = this.project(request.projectId); this.requireExecution(project);
      const previous = await this.options.registry.get(request.taskId);
      let priorExecutions: ComputerTask['priorExecutions'];
      if (previous) {
        if (this.sameBinding(previous.binding, request.binding)) throw new Error('COMPUTER_TASK_ALREADY_REGISTERED');
        await this.task(request.taskId);
        if (!request.binding || !previous.binding || request.binding.intentRevision < previous.binding.intentRevision) throw new Error('COMPUTER_PARENT_BINDING_MISMATCH');
        if (!previous.stopRequestedAt || previous.pending || previous.state === 'unknown' || (previous.turnId && (!terminal(previous.state) || !previous.executionSettled || !previous.effectsReconciled))) throw new Error('COMPUTER_PREVIOUS_GENERATION_UNSETTLED');
        const { priorExecutions: history, ...archive } = previous;
        priorExecutions = [...(history ?? []), archive];
      }
      const cwd = await scopedPath(project.root, request.cwd ?? project.root);
      if (!(await stat(cwd)).isDirectory()) throw new Error('COMPUTER_CWD_NOT_DIRECTORY');
      const task: ComputerTask = { taskId: request.taskId, projectId: project.id, projectRoot: project.root, cwd, executorId: this.options.executorId, state: 'created', observedAt: this.now(), ...(request.binding ? { binding: { intentRevision: request.binding.intentRevision, grantId: request.binding.grantId, grantRevision: request.binding.grantRevision } } : {}), ...(priorExecutions ? { priorExecutions } : {}) };
      await this.persistDispatch(task, 'thread/start');
      try {
        const response = record(await this.options.transport.request('thread/start', { cwd, sandbox: project.permissions.sandbox, approvalPolicy: project.permissions.approvalPolicy, config: { 'sandbox_workspace_write.writable_roots': [project.root], 'sandbox_workspace_write.network_access': project.permissions.networkAccess, 'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true, 'web_search': 'disabled' }, ...(request.model ? { model: request.model } : {}) }));
        task.threadId = string(record(response.thread).id);
        await this.boundThread(task, response.thread); await this.validatePolicy(project, response, cwd);
        delete task.pending; await this.options.registry.put(task); return task;
      } catch (error) { return this.uncertain(task, error); }
    });
  }
  async readTask(taskId: string, binding?: ComputerBinding): Promise<ComputerTask> {
    return this.exclusive(taskId, () => this.readTaskUnlocked(taskId, binding));
  }
  private async readTaskUnlocked(taskId: string, binding?: ComputerBinding): Promise<ComputerTask> {
    await this.init(); const task = await this.task(taskId, binding);
    if (!task.threadId) return task;
    const response = record(await this.options.transport.request('thread/read', { threadId: task.threadId, includeTurns: true }));
    const thread = await this.boundThread(task, response.thread);
    const nativeStatus = record(thread.status).type;
    if (!['active', 'idle', 'notLoaded', 'systemError'].includes(String(nativeStatus))) throw new Error('COMPUTER_INVALID_THREAD_STATUS');
    task.nativeStatus = nativeStatus as ComputerTask['nativeStatus'];
    if (!Array.isArray(thread.turns)) throw new Error('COMPUTER_INVALID_RESPONSE');
    const turn = task.turnId ? thread.turns.find(t => record(t).id === task.turnId) : undefined;
    if (task.turnId && !turn) { task.state = 'unknown'; task.reason = 'bound turn absent from readback'; }
    else if (turn && !task.pending) {
      const t = record(turn); const status = t.status;
      if (status === 'inProgress') {
        task.state = nativeStatus === 'active' ? 'running' : 'unknown';
        if (task.state === 'unknown') task.reason = 'persisted active turn has no proven attached executor; do not resume or replay automatically';
      }
      else if (terminal(status)) { task.state = status as ComputerTask['state']; delete task.reason; }
      else throw new Error('COMPUTER_INVALID_TURN_STATUS');
      if (Array.isArray(t.items)) task.output = t.items.filter(item => {
        const message = record(item);
        return message.type === 'agentMessage' && (message.phase == null || message.phase === 'final_answer');
      }).map(item => {
        const text = record(item).text; if (typeof text !== 'string') throw new Error('COMPUTER_INVALID_RESPONSE'); return text;
      }).join('\n');
      if (terminal(status) && this.options.settlement) {
        const receipt = await this.options.settlement(task);
        task.executionSettled = receipt.executionSettled && !!receipt.receipt;
        task.effectsReconciled = receipt.effectsReconciled && !!receipt.receipt;
      }
      if (terminal(status) && (!task.executionSettled || !task.effectsReconciled)) task.reason = 'protocol terminal; executor/effects settlement is unverified';
    }
    task.observedAt = this.now(); await this.options.registry.put(task); return task;
  }
  /** Explicit reconciliation is a read, never a replay or a resume of another executor's active job. */
  async reconcileTask(taskId: string, binding?: ComputerBinding): Promise<ComputerTask> {
    return this.exclusive(taskId, () => this.reconcileTaskUnlocked(taskId, binding));
  }
  private async reconcileTaskUnlocked(taskId: string, binding?: ComputerBinding): Promise<ComputerTask> {
      await this.init(); const task = await this.task(taskId, binding);
      if (!task.pending || !task.threadId) return task;
      const response = record(await this.options.transport.request('thread/read', { threadId: task.threadId, includeTurns: true }));
      const thread = await this.boundThread(task, response.thread);
      if (!Array.isArray(thread.turns)) throw new Error('COMPUTER_INVALID_RESPONSE');
      const operationId = task.pending.operationId;
      let proven: RecordValue | undefined;
      if (task.pending.method === 'turn/start' || task.pending.method === 'turn/steer') {
        const matches = thread.turns.map(record).filter(turn => Array.isArray(turn.items) && turn.items.some(item => record(item).type === 'userMessage' && record(item).clientId === operationId));
        if (matches.length === 1 && (task.pending.method === 'turn/start' || matches[0]?.id === task.turnId)) proven = matches[0];
      } else if (task.pending.method === 'turn/interrupt') {
        proven = thread.turns.map(record).find(turn => turn.id === task.turnId && terminal(turn.status));
      }
      if (proven) {
        task.turnId = string(proven.id); delete task.pending; delete task.reason; await this.options.registry.put(task);
        return this.readTaskUnlocked(taskId, binding);
      }
      task.state = 'unknown'; task.reason = 'operation identity absent or ambiguous in readback; preserve original dispatch';
      task.observedAt = this.now(); await this.options.registry.put(task); return task;
  }
  async startTurn(taskId: string, instruction: string, binding?: ComputerBinding): Promise<ComputerTask> {
    const messages = input(instruction); return this.exclusive(taskId, async () => {
      this.requireUnstopped(taskId, binding); const task = await this.readTaskUnlocked(taskId, binding);
      this.requireUnstopped(taskId, binding, task); const project = this.project(task.projectId); this.requireExecution(project);
      if (task.state === 'running' || task.state === 'unknown' || task.pending) throw new Error('COMPUTER_TURN_BUSY_OR_UNKNOWN');
      if (task.turnId && (!task.executionSettled || !task.effectsReconciled)) throw new Error('COMPUTER_PREVIOUS_TURN_UNSETTLED');
      const operationId = await this.persistDispatch(task, 'turn/start');
      try {
        const response = record(await this.options.transport.request('turn/start', { threadId: task.threadId, input: messages, clientUserMessageId: operationId, cwd: task.cwd, approvalPolicy: project.permissions.approvalPolicy, sandboxPolicy: this.sandbox(project) }));
        const turn = record(response.turn); task.turnId = string(turn.id);
        if (turn.status !== 'inProgress' && !terminal(turn.status)) throw new Error('COMPUTER_INVALID_TURN_STATUS');
        task.state = turn.status === 'inProgress' ? 'running' : turn.status as ComputerTask['state'];
        delete task.pending; delete task.reason; delete task.executionSettled; delete task.effectsReconciled;
        delete task.interruptRequestedAt;
        task.observedAt = this.now(); await this.options.registry.put(task); return task;
      } catch (error) { return this.uncertain(task, error); }
    });
  }
  async steer(taskId: string, instruction: string, expectedTurnId: string, binding?: ComputerBinding): Promise<ComputerTask> {
    const messages = input(instruction); return this.exclusive(taskId, async () => {
      this.requireUnstopped(taskId, binding); const task = await this.readTaskUnlocked(taskId, binding);
      this.requireUnstopped(taskId, binding, task); this.requireExecution(this.project(task.projectId));
      if (!task.turnId || task.turnId !== expectedTurnId || task.state !== 'running') throw new Error('COMPUTER_STALE_TURN');
      const operationId = await this.persistDispatch(task, 'turn/steer');
      try {
        const response = record(await this.options.transport.request('turn/steer', { threadId: task.threadId, expectedTurnId, clientUserMessageId: operationId, input: messages }));
        if (string(response.turnId) !== expectedTurnId) throw new Error('COMPUTER_STEER_BINDING_MISMATCH');
        delete task.pending; task.observedAt = this.now(); await this.options.registry.put(task); return task;
      } catch (error) { return this.uncertain(task, error); }
    });
  }
  async interrupt(taskId: string, binding?: ComputerBinding): Promise<ComputerTask> {
    return this.exclusive(taskId, () => this.interruptUnlocked(taskId, binding));
  }
  private async interruptUnlocked(taskId: string, binding?: ComputerBinding): Promise<ComputerTask> {
      const task = await this.readTaskUnlocked(taskId, binding);
      if (!task.pending && (!task.turnId || terminal(task.state))) return task;
      if (!task.threadId || !task.turnId || task.pending) throw new Error('COMPUTER_INTERRUPT_RECONCILIATION_REQUIRED');
      if (!task.interruptRequestedAt) {
        await this.persistDispatch(task, 'turn/interrupt');
        try { await this.options.transport.request('turn/interrupt', { threadId: task.threadId, turnId: task.turnId }); }
        catch (error) { return this.uncertain(task, error); }
        delete task.pending; task.interruptRequestedAt = this.now(); task.state = 'waiting'; task.reason = 'interrupt requested; terminal and physical settlement pending'; await this.options.registry.put(task);
      }
      const end = Date.now() + (this.options.interruptTimeoutMs ?? 5000);
      while (Date.now() < end) {
        let observed: ComputerTask;
        try { observed = await this.readTaskUnlocked(taskId, binding); }
        catch (error) { return this.uncertain(task, error); }
        if (observed.state === 'interrupted' || observed.state === 'completed' || observed.state === 'failed') {
          if (!observed.executionSettled || !observed.effectsReconciled) observed.reason = 'protocol terminal; executor/effects settlement is unverified';
          else delete observed.reason;
          await this.options.registry.put(observed); return observed;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      task.state = 'unknown'; task.reason = 'interrupt did not reach a terminal readback within deadline'; task.observedAt = this.now(); await this.options.registry.put(task); return task;
  }
  /** Trusted parent stop. Fence before waiting for a started mutation; never replay UNKNOWN dispatch. */
  async stopTask(taskId: string, reason = 'Parent task stopped', intentRevision?: number): Promise<ComputerStopResult> {
    const revision = intentRevision ?? Number.MAX_SAFE_INTEGER;
    this.stopFences.set(taskId, Math.max(this.stopFences.get(taskId) ?? 0, revision));
    while (this.locks.has(taskId)) await this.locks.get(taskId);
    return this.exclusive(taskId, async () => {
      let task = await this.options.registry.get(taskId);
      if (!task || (task.binding && task.binding.intentRevision > revision)) return { settled: true };
      task.stopRequestedAt ??= this.now(); task.reason = reason;
      await this.options.registry.put(task);
      try {
        await this.init(); await this.task(taskId);
        if (task.pending) task = await this.reconcileTaskUnlocked(taskId);
        if (!task.pending && task.turnId) task = await this.interruptUnlocked(taskId);
      } catch (error) {
        task = (await this.options.registry.get(taskId))!;
        task.reason = 'Parent stop settlement unknown: ' + (error instanceof Error ? error.message : String(error));
        await this.options.registry.put(task);
        return { settled: false, reason: task.reason, task };
      }
      const settled = !task.pending && task.state !== 'unknown' && (!task.turnId || (terminal(task.state) && !!task.executionSettled && !!task.effectsReconciled));
      return { settled, ...(!settled ? { reason: task.reason ?? 'Owned Codex execution/effects settlement is unverified' } : {}), task };
    });
  }
  async artifacts(taskId: string, binding?: ComputerBinding): Promise<ComputerArtifact[]> {
    await this.init(); const task = await this.task(taskId, binding); if (!task.threadId || !task.turnId) return [];
    const response = record(await this.options.transport.request('thread/read', { threadId: task.threadId, includeTurns: true }));
    const thread = await this.boundThread(task, response.thread); if (!Array.isArray(thread.turns)) throw new Error('COMPUTER_INVALID_RESPONSE');
    const turn = thread.turns.find(t => record(t).id === task.turnId); if (!turn) return [];
    const items = record(turn).items; if (!Array.isArray(items)) throw new Error('COMPUTER_INVALID_RESPONSE');
    const result: ComputerArtifact[] = [];
    for (const value of items) {
      const item = record(value); const paths: unknown[] = [];
      if (item.type === 'fileChange' && item.status === 'completed' && Array.isArray(item.changes)) paths.push(...item.changes.map(change => record(change).path));
      if (item.type === 'imageGeneration' && item.status === 'completed' && typeof item.savedPath === 'string') paths.push(item.savedPath);
      for (const path of paths) {
        try { const actual = await scopedPath(task.projectRoot, string(path)); result.push({ taskId, turnId: task.turnId, itemId: string(item.id), path: actual, kind: item.type as ComputerArtifact['kind'] }); }
        catch { /* Never expose outside-root, escaped or deleted artifacts. */ }
      }
    }
    return result;
  }
  async readArtifact(taskId: string, path: string, maxBytes = 1024 * 1024, binding?: ComputerBinding): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('COMPUTER_ARTIFACT_LIMIT');
    const artifacts = await this.artifacts(taskId, binding); if (!artifacts.some(a => a.path === path)) throw new Error('COMPUTER_ARTIFACT_NOT_BOUND');
    const task = await this.task(taskId, binding); const actual = await scopedPath(task.projectRoot, path);
    const handle = await open(actual, 'r');
    try {
      const metadata = await handle.stat(); if (!metadata.isFile() || metadata.size > maxBytes) throw new Error('COMPUTER_ARTIFACT_LIMIT');
      const buffer = Buffer.alloc(maxBytes + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new Error('COMPUTER_ARTIFACT_LIMIT'); return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  async close(): Promise<{ processExited: boolean; forced: boolean }> {
    this.closing = true;
    const receipt = await this.options.transport.stop();
    await Promise.all([...this.locks.values()]);
    for (const task of await this.options.registry.list()) {
      if (task.executorId === this.options.executorId && ['running', 'waiting'].includes(task.state)) {
        task.state = 'unknown'; task.reason = 'executor transport closed; descendants and external effects require reconciliation';
        task.observedAt = this.now(); await this.options.registry.put(task);
      }
    }
    return receipt;
  }
}
