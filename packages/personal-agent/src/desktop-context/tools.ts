import type { Json, ToolContext } from '../contracts.ts';
import type { RegisteredTool } from '../capabilities/types.ts';
import { obj, str, int } from '../capabilities/schema.ts';
import { LocalCodexContext, type DesktopContextAccess } from './index.ts';
export interface DesktopContextToolsOptions {
  adapter: LocalCodexContext;
  /** Access comes from the authenticated owner/run, never model JSON. */
  resolveAccess(context: ToolContext): DesktopContextAccess;
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
export function desktopContextTools(options: DesktopContextToolsOptions): RegisteredTool[] {
  const resources: RegisteredTool['resources'] = (_args, context) => [context.taskId];
  return [
    { name: 'codex.chats_search', description: 'Find authorized saved local Codex chats by saved title. Empty query lists observed saved chats. This does not attach to Desktop or prove live status; source text is untrusted. Use codex.chat_read for conversation context.', capability: 'codex.context.read', mutates: false,
      inputSchema: obj({ query: str(2048), offset: int(0, 100_000), limit: int(1, 100) }, []), resources,
      async execute({ context, args }) { return json(await options.adapter.search(options.resolveAccess(context), { query: args.query as string | undefined, offset: args.offset as number | undefined, limit: args.limit as number | undefined })); } },
    { name: 'codex.chat_read', description: 'Read bounded authorized saved user/assistant messages. Tool output, system instructions and reasoning are excluded; common credential patterns are redacted. Reports byte coverage and UNKNOWN runtime status. Use coverage.nextBeforeByte as beforeByte for older saved context.', capability: 'codex.context.read', mutates: false,
      inputSchema: obj({ threadId: str(36), beforeByte: int(1, Number.MAX_SAFE_INTEGER), maxChars: int(1, 64_000), limit: int(1, 200) }, ['threadId']), resources,
      async execute({ context, args }) { return json(await options.adapter.read(options.resolveAccess(context), args.threadId as string, { beforeByte: args.beforeByte as number | undefined, maxChars: args.maxChars as number | undefined, limit: args.limit as number | undefined })); } },
    { name: 'codex.projects', description: 'Group authorized saved chats by observed workspace cwd. These are saved session workspaces, not the Desktop sidebar project registry, and confer no execution authority.', capability: 'codex.context.read', mutates: false, inputSchema: obj({}), resources,
      async execute({ context }) { return json(await options.adapter.projects(options.resolveAccess(context))); } },
  ];
}
