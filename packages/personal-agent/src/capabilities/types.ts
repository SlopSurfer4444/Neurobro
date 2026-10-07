import type { Effect, Json, ToolContext, TelegramPort, Observation, Attachment } from '../contracts.ts';
import type { Schema } from './schema.ts';

/** The broker owns context issuance, grants, revisions and effect attempts. */
export interface ToolBroker {
  resolveToolContext(token: string): ToolContext;
  authorizeTool(token: string, capability: string, resource: string): void | ToolContext | Promise<void | ToolContext>;
  executeEffect(token: string, request: { capability: string; resource: string; payload: Json; id?: string }): Promise<Effect>;
}
export interface CapabilityTelegram extends TelegramPort {
  readCapability?(name: string, args: Record<string, Json>, context?: ToolContext): Promise<Json>;
}
export interface ToolDefinition { name: string; description: string; inputSchema: Schema; capability: string; mutates: boolean }
export interface ToolArtifacts {
  stageTelegram(context: ToolContext, observation: Observation, attachment: Attachment, download: (destination: string) => Promise<void>): Promise<Json>;
  resolveForSend(context: ToolContext, artifactId: string): Promise<{ path: string; mimeType: string; name: string; size?: number; sha256?: string }>;
}
export interface ToolCall { token: string; context: ToolContext; args: Record<string, Json> }
export interface RegisteredTool extends ToolDefinition {
  resources(args: Record<string, Json>, context: ToolContext): string[];
  execute(call: ToolCall): Promise<Json>;
}
