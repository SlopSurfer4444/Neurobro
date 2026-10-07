import { id, int, obj, str } from '../capabilities/schema.ts';
import type { Schema } from '../capabilities/schema.ts';
import type { RegisteredTool, ToolCall } from '../capabilities/types.ts';
import type { Json } from '../contracts.ts';
import type { CodexComputerAdapter } from './index.ts';
import { ComputerDispatchUnknown } from './index.ts';
import type { ComputerTask } from './types.ts';

/** Task IDs come exclusively from the broker's trusted ToolContext. */
export interface ComputerToolsOptions { adapter: CodexComputerAdapter }
function json(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
function text(call: ToolCall, name: string): string { return call.args[name] as string; }
function bound(task: ComputerTask, call: ToolCall): ComputerTask {
  if (task.taskId !== call.context.taskId) throw new Error('COMPUTER_BROKER_TASK_BINDING_MISMATCH');
  if (!task.binding || task.binding.intentRevision !== call.context.intentRevision || task.binding.grantId !== call.context.grantId || task.binding.grantRevision !== call.context.grantRevision) throw new Error('COMPUTER_PARENT_BINDING_MISMATCH');
  const { priorExecutions: _history, ...current } = task;
  return current;
}

/** These tools must be installed in ToolRegistry, which resolves and authorizes every call. */
export function createComputerTools({ adapter }: ComputerToolsOptions): RegisteredTool[] {
  function tool(name: string, description: string, inputSchema: Schema, capability: string, mutates: boolean,
    resources: RegisteredTool['resources'], execute: RegisteredTool['execute']): RegisteredTool {
    return { name, description, inputSchema, capability, mutates, resources, execute: async call => {
      try { return await execute(call); }
      catch (error) {
        if (mutates && error instanceof ComputerDispatchUnknown && error.taskId === call.context.taskId) return {
          taskId: call.context.taskId, state: 'unknown', reconciliationRequired: true,
          reason: 'Original dispatch is retained; reconnect and reconcile before another mutation.',
          code: error.code, ...(error.operationId ? { operationId: error.operationId } : {}),
        };
        throw error;
      }
    } };
  }
  const taskResource: RegisteredTool['resources'] = (_args, context) => [context.taskId];
  const projectResource: RegisteredTool['resources'] = args => [args.projectId as string];
  return [
    tool('computer.projects', 'Inspect one explicitly granted registered project and executor readiness.', obj({ projectId: id }), 'computer.projects', false, projectResource, async call => {
      const projects = await adapter.listProjects(); const project = projects.find(p => p.id === text(call, 'projectId'));
      if (!project) throw new Error('COMPUTER_PROJECT_NOT_REGISTERED');
      const doctor = await adapter.doctor();
      return json({ project, readiness: doctor.projects.find(p => p.id === project.id), desktopAttachment: false });
    }),
    tool('computer.tasks', 'Read this broker task in the granted project page; other broker tasks are excluded.', obj({ projectId: id, cursor: str(4096), limit: int(1, 100) }, ['projectId']), 'computer.read', false, projectResource, async call => {
      const page = await adapter.listTasks(text(call, 'projectId'), { ...(call.args.cursor ? { cursor: text(call, 'cursor') } : {}), ...(call.args.limit ? { limit: call.args.limit as number } : {}) });
      return json({ tasks: page.tasks.filter(t => t.taskId === call.context.taskId && t.binding?.intentRevision === call.context.intentRevision && t.binding.grantId === call.context.grantId && t.binding.grantRevision === call.context.grantRevision).map(task => bound(task, call)), nextCursor: page.nextCursor });
    }),
    tool('computer.create', 'Create an owned Codex thread for this broker task in the granted registered project; UNKNOWN is never retried.', obj({ projectId: id }), 'computer.create', true, projectResource, async call => {
      let task: ComputerTask;
      try { task = await adapter.createTask({ taskId: call.context.taskId, projectId: text(call, 'projectId'), binding: call.context }); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'COMPUTER_TASK_ALREADY_REGISTERED') throw error;
        task = await adapter.readTask(call.context.taskId, call.context);
        if (task.projectId !== text(call, 'projectId')) throw new Error('COMPUTER_BROKER_PROJECT_BINDING_MISMATCH');
      }
      return json(bound(task, call));
    }),
    tool('computer.read', 'Read the current broker-owned Codex thread without resuming another executor.', obj({}), 'computer.read', false, taskResource,
      async call => json(bound(await adapter.readTask(call.context.taskId, call.context), call))),
    tool('computer.start', 'Start a turn on this broker-owned Codex thread under its verified executor policy.', obj({ instruction: str(65536) }), 'computer.start', true, taskResource,
      async call => json(bound(await adapter.startTurn(call.context.taskId, text(call, 'instruction'), call.context), call))),
    tool('computer.steer', 'Steer this broker-owned active turn using its exact expectedTurnId precondition.', obj({ instruction: str(65536), expectedTurnId: id }), 'computer.steer', true, taskResource,
      async call => json(bound(await adapter.steer(call.context.taskId, text(call, 'instruction'), text(call, 'expectedTurnId'), call.context), call))),
    tool('computer.interrupt', 'Request interruption of this broker-owned turn and read terminal/physical/effect settlement separately.', obj({}), 'computer.interrupt', true, taskResource,
      async call => json(bound(await adapter.interrupt(call.context.taskId, call.context), call))),
    tool('computer.reconcile', 'Reconcile a known dispatch by persisted operation identity using readback; does not replay or resume.', obj({}), 'computer.read', false, taskResource,
      async call => json(bound(await adapter.reconcileTask(call.context.taskId, call.context), call))),
    tool('computer.artifacts', 'List opaque artifact handles belonging to this broker task and its bound turn.', obj({}), 'computer.read', false, taskResource, async call => {
      const artifacts = await adapter.artifacts(call.context.taskId, call.context);
      return json(artifacts.map((a, index) => {
        if (a.taskId !== call.context.taskId) throw new Error('COMPUTER_BROKER_TASK_BINDING_MISMATCH');
        return { itemId: a.itemId, index, turnId: a.turnId, kind: a.kind };
      }));
    }),
    tool('computer.artifact_read', 'Read a bounded artifact from this task using a listed itemId/index/turnId; returns base64 bytes.', obj({ itemId: id, index: int(0, 4095), turnId: id, maxBytes: int(1, 1024 * 1024) }, ['itemId', 'index', 'turnId']), 'computer.artifact.read', false, taskResource, async call => {
      const artifacts = await adapter.artifacts(call.context.taskId, call.context); const selected = artifacts[call.args.index as number];
      if (!selected || selected.itemId !== text(call, 'itemId') || selected.turnId !== text(call, 'turnId') || selected.taskId !== call.context.taskId) throw new Error('COMPUTER_ARTIFACT_HANDLE_STALE_OR_UNBOUND');
      const bytes = await adapter.readArtifact(call.context.taskId, selected.path, call.args.maxBytes as number | undefined, call.context);
      return { encoding: 'base64', bytes: bytes.length, content: bytes.toString('base64'), turnId: selected.turnId, itemId: selected.itemId };
    }),
  ];
}
