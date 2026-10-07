import type { Json, ToolRequest, ToolResult } from '../contracts.ts';
import type { RegisteredTool, ToolBroker, ToolDefinition } from './types.ts';
import { validate } from './schema.ts';
import { AuthorityError } from '../core/broker.ts';
import { TdRequestError } from '../telegram/transport.ts';

export interface PublicToolFailure {
  code: 'invalid_request' | 'unknown_tool' | 'invalid_arguments' | 'authority_denied' | 'invalid_resource' | 'rate_limited' | 'operation_failed';
  message: string;
  outcome: 'not_dispatched' | 'read_failed' | 'unknown';
}
export interface RegistryToolResult extends ToolResult { failure?: PublicToolFailure }

/** No tool receives authority, a context token or a filesystem path from model arguments. */
export class ToolRegistry {
  readonly #broker: ToolBroker;
  readonly #tools = new Map<string, RegisteredTool>();
  constructor(broker: ToolBroker, tools: RegisteredTool[]) {
    this.#broker = broker;
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9_.]+$/u.test(tool.name) || this.#tools.has(tool.name)) throw new Error(`invalid or duplicate tool: ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
  }
  list(): ToolDefinition[] {
    return [...this.#tools.values()].map(({ name, description, inputSchema, capability, mutates }) => structuredClone({ name, description, inputSchema, capability, mutates }));
  }
  listForToken(token: string): ToolDefinition[] {
    this.#broker.resolveToolContext(token);
    return this.list();
  }
  async invoke(token: string, request: ToolRequest): Promise<RegistryToolResult> {
    let phase: 'request' | 'lookup' | 'schema' | 'authority' | 'resource' | 'execute' | 'after' = 'request';
    let mutates = false;
    try {
      if (!request || typeof request !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(request)) || Object.keys(request).some(key => !['name', 'args'].includes(key))) throw new Error('invalid tool request');
      const nameDescriptor = Object.getOwnPropertyDescriptor(request, 'name');
      const argsDescriptor = Object.getOwnPropertyDescriptor(request, 'args');
      if (!nameDescriptor || !argsDescriptor || !('value' in nameDescriptor) || !('value' in argsDescriptor) || typeof nameDescriptor.value !== 'string') throw new Error('invalid tool request');
      phase = 'lookup';
      const tool = this.#tools.get(nameDescriptor.value);
      if (!tool) throw new Error('unknown tool');
      mutates = tool.mutates;
      phase = 'schema';
      validate(tool.inputSchema, argsDescriptor.value);
      // Broker resolution is mandatory on every call, including reads, and rejects stale grants/runs.
      phase = 'authority';
      const context = Object.freeze(structuredClone(this.#broker.resolveToolContext(token)));
      const args = structuredClone(argsDescriptor.value) as Record<string, Json>;
      phase = 'resource';
      const resources = tool.resources(args, context);
      if (resources.length === 0 || resources.length > 64) throw new Error('invalid resource binding');
      for (const resource of new Set(resources)) {
        if (typeof resource !== 'string' || !resource || resource.length > 2048) throw new Error('invalid resource');
        phase = 'authority';
        await this.#broker.authorizeTool(token, tool.capability, resource);
        phase = 'resource';
      }
      phase = 'execute';
      const value = await tool.execute({ token, context, args });
      // A read completed under a now-revoked/stale grant must not enter the model context.
      phase = 'after';
      for (const resource of new Set(resources)) await this.#broker.authorizeTool(token, tool.capability, resource);
      return { ok: true, value: structuredClone(value) };
    } catch (error) {
      const authority = phase === 'authority' || phase === 'after' || error instanceof AuthorityError;
      const rateLimited = error instanceof TdRequestError && (error.code === 429 || error.reason === 'FLOOD_WAIT');
      const code: PublicToolFailure['code'] = rateLimited ? 'rate_limited' : authority ? 'authority_denied' : phase === 'request' ? 'invalid_request'
        : phase === 'lookup' ? 'unknown_tool' : phase === 'schema' ? 'invalid_arguments' : phase === 'resource' ? 'invalid_resource' : 'operation_failed';
      const messages: Record<PublicToolFailure['code'], string> = {
        invalid_request: 'Expected a tool name and argument object.', unknown_tool: 'Tool is not installed. Read the current tool catalog.',
        invalid_arguments: 'Arguments do not match the tool schema. Read tools.describe before correcting the call.',
        authority_denied: 'Current task, source or resource authority does not permit this call. Inspect current context; do not repeat a mutation without reconciliation.',
        invalid_resource: 'Arguments do not identify a supported resource. Read the tool schema and current context.',
        rate_limited: 'Telegram rate limit reached. Stop Telegram requests and report the limit; do not retry automatically.',
        operation_failed: 'The tool operation failed. Inspect saved task or operation state before repeating a mutation.',
      };
      const outcome: PublicToolFailure['outcome'] = phase !== 'execute' && phase !== 'after' ? 'not_dispatched' : mutates ? 'unknown' : 'read_failed';
      return { ok: false, error: error instanceof Error ? error.message : 'tool failed', failure: { code, message: messages[code], outcome } };
    }
  }
}
