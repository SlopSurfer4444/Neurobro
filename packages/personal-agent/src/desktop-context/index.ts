import { open, readdir, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { DesktopContextConfig, DesktopContextAccess, DesktopContextScope, SavedChat, SavedChatRead, SavedMessage } from './types.ts';
import { redactDesktopText } from './privacy.ts';
export type { DesktopContextConfig, DesktopContextAccess, DesktopContextScope, SavedChat, SavedChatRead } from './types.ts';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const error = (code: string): never => { throw new Error(`DESKTOP_CONTEXT_${code}`); };
const bounded = (n: number, low: number, high: number) => Number.isSafeInteger(n) && n >= low && n <= high;
type Entry = { path: string; chat: SavedChat };

/** Read-only projection of local saved Codex chats. No auth/config/SQLite reads, executors or RPC writes.
 * The cwd groups are observed session workspaces, not the Desktop's saved project registry. */
export class LocalCodexContext {
  private readonly config: DesktopContextConfig;
  constructor(config: DesktopContextConfig) {
    if (!isAbsolute(config.codexHome) || !config.ownerId || !bounded(config.maxFiles ?? 30_000, 1, 100_000) || !bounded(config.maxReadBytes ?? 2_097_152, 1024, 8_388_608)) error('INVALID_CONFIG');
    for (const id of config.scope.threadIds ?? []) if (!uuid.test(id)) error('INVALID_THREAD_ID');
    for (const root of config.scope.projectRoots ?? []) if (!isAbsolute(root)) error('INVALID_PROJECT_ROOT');
    this.config = structuredClone(config);
  }
  private authorized(chat: SavedChat, scope: DesktopContextScope): boolean {
    return scope.allOwnerThreads === true || !!scope.threadIds?.includes(chat.id) || !!scope.projectRoots?.some(root => within(resolve(root), resolve(chat.cwd)));
  }
  private check(access: DesktopContextAccess) {
    if (access.ownerId !== this.config.ownerId) error('OWNER_MISMATCH');
  }
  private async safePath(path: string): Promise<string> {
    const home = await realpath(this.config.codexHome);
    const candidate = await realpath(path);
    if (!within(home, candidate) || (await lstat(path)).isSymbolicLink()) error('PATH_ESCAPE');
    // Reject junctions/symlinks at every component, not merely the final file.
    let cursor = this.config.codexHome;
    for (const part of relative(this.config.codexHome, path).split(sep).filter(Boolean)) {
      cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) error('PATH_ESCAPE');
    }
    return candidate;
  }
  private async bytes(path: string, mode: 'head' | 'tail', limit: number, endByte?: number) {
    const canonical = await this.safePath(path);
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) error('NOT_A_FILE');
      if (await this.safePath(path) !== canonical) error('PATH_CHANGED');
      const current = await lstat(canonical);
      if (current.ino !== stat.ino || current.dev !== stat.dev) error('PATH_CHANGED');
      const end = mode === 'head' ? Math.min(stat.size, limit) : Math.min(stat.size, endByte ?? stat.size);
      const start = mode === 'head' ? 0 : Math.max(0, end - limit);
      let startsOnLineBoundary = start === 0;
      if (start > 0) {
        const previous = Buffer.alloc(1);
        const read = await handle.read(previous, 0, 1, start - 1);
        startsOnLineBoundary = read.bytesRead === 1 && previous[0] === 10;
      }
      const buffer = Buffer.alloc(end - start);
      let count = 0;
      while (count < buffer.length) { const read = await handle.read(buffer, count, buffer.length - count, start + count); if (!read.bytesRead) break; count += read.bytesRead; }
      const after = await handle.stat();
      return { buffer: buffer.subarray(0, count), start, end: start + count, size: stat.size, mtime: stat.mtimeMs,
        startsOnLineBoundary, changed: stat.size !== after.size || stat.mtimeMs !== after.mtimeMs };
    } finally { await handle.close(); }
  }
  private async inventory(access: DesktopContextAccess, selection: { threadId?: string; titleQuery?: string } = {}) {
    this.check(access);
    const files: { path: string; archived: boolean }[] = []; let truncated = false;
    const visit = async (directory: string, archived: boolean, depth: number): Promise<void> => {
      if (depth > 6) { truncated = true; return; }
      let entries;
      try { await this.safePath(directory); entries = await readdir(directory, { withFileTypes: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const item of entries) {
        if (files.length >= (this.config.maxFiles ?? 30_000)) { truncated = true; return; }
        if (item.isSymbolicLink()) continue;
        const path = join(directory, item.name);
        if (item.isDirectory()) await visit(path, archived, depth + 1);
        else if (item.isFile() && /^rollout-.*\.jsonl$/.test(item.name)) files.push({ path, archived });
      }
    };
    await visit(join(this.config.codexHome, 'sessions'), false, 0);
    if (this.config.includeArchived) await visit(join(this.config.codexHome, 'archived_sessions'), true, 0);
    const titles = new Map<string, string>(); let indexPartial = false;
    try {
      const index = await this.bytes(join(this.config.codexHome, 'session_index.jsonl'), 'tail', 8_388_608);
      indexPartial = index.start > 0;
      const lines = index.buffer.toString('utf8').split('\n'); if (index.start > 0) lines.shift();
      for (const line of lines) { try { const r: unknown = JSON.parse(line); if (record(r) && typeof r.id === 'string' && typeof r.thread_name === 'string') titles.set(r.id, redactDesktopText(r.thread_name).text.slice(0, 512)); } catch {} }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const entries: Entry[] = []; let ignored = 0, metadataRead = 0;
    for (const file of files) {
      // Filename filtering is only an optimization; session_meta still binds every result.
      if (selection.threadId && !file.path.toLowerCase().includes(selection.threadId.toLowerCase())) continue;
      if (selection.titleQuery && ![...titles].some(([id, title]) => title.toLocaleLowerCase().includes(selection.titleQuery!) && file.path.toLowerCase().includes(id.toLowerCase()))) continue;
      try {
        metadataRead++;
        const head = await this.bytes(file.path, 'head', 131_072);
        const newline = head.buffer.indexOf(10); if (newline < 0) { ignored++; continue; }
        const row: unknown = JSON.parse(head.buffer.subarray(0, newline).toString('utf8'));
        if (!record(row) || row.type !== 'session_meta' || !record(row.payload) || typeof row.payload.id !== 'string' || !uuid.test(row.payload.id) || typeof row.payload.cwd !== 'string' || !isAbsolute(row.payload.cwd)) { ignored++; continue; }
        const chat: SavedChat = { id: row.payload.id, title: titles.get(row.payload.id) ?? row.payload.id, cwd: row.payload.cwd, archived: file.archived,
          savedAt: new Date(head.mtime).toISOString(), source: 'local_codex_rollout', runtimeStatus: 'unknown' };
        if (this.authorized(chat, this.config.scope) && this.authorized(chat, access.scope)) entries.push({ path: file.path, chat });
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { ignored++; continue; } throw e; }
    }
    // Duplicate/recovered files are ambiguous: do not silently select a different transcript.
    const counts = new Map<string, number>(); for (const e of entries) counts.set(e.chat.id, (counts.get(e.chat.id) ?? 0) + 1);
    const unambiguous = entries.filter(e => counts.get(e.chat.id) === 1);
    ignored += entries.length - unambiguous.length;
    unambiguous.sort((a, b) => b.chat.savedAt.localeCompare(a.chat.savedAt) || a.chat.id.localeCompare(b.chat.id));
    return { entries: unambiguous, coverage: { filesEnumerated: files.length, filesMetadataRead: metadataRead, filesIgnored: ignored, inventoryTruncated: truncated, titleIndexPartial: indexPartial } };
  }
  async search(access: DesktopContextAccess, options: { query?: string; offset?: number; limit?: number } = {}) {
    const offset = options.offset ?? 0, limit = options.limit ?? 25;
    if (!bounded(offset, 0, 100_000) || !bounded(limit, 1, 100) || (options.query?.length ?? 0) > 2048) error('INVALID_SEARCH');
    const query = (options.query ?? '').toLocaleLowerCase(); const inventory = await this.inventory(access, { titleQuery: query });
    const matches = inventory.entries.filter(e => e.chat.title.toLocaleLowerCase().includes(query));
    return { chats: matches.slice(offset, offset + limit).map(e => e.chat), nextOffset: offset + limit < matches.length ? offset + limit : null,
      observedAt: new Date().toISOString(), coverage: inventory.coverage, searchCoverage: 'saved_title_index_only_for_nonempty_query', desktopAttached: false, controlAvailable: false };
  }
  async projects(access: DesktopContextAccess) {
    const inventory = await this.inventory(access); const groups = new Map<string, { root: string; savedChats: number; lastSavedAt: string }>();
    for (const { chat } of inventory.entries) { const existing = groups.get(chat.cwd); if (existing) existing.savedChats++; else groups.set(chat.cwd, { root: chat.cwd, savedChats: 1, lastSavedAt: chat.savedAt }); }
    return { projects: [...groups.values()], observedAt: new Date().toISOString(), coverage: inventory.coverage, registry: 'observed_session_workspaces_only', desktopAttached: false, controlAvailable: false };
  }
  async read(access: DesktopContextAccess, threadId: string, options: { beforeByte?: number; maxChars?: number; limit?: number } = {}): Promise<SavedChatRead> {
    if (!uuid.test(threadId)) error('INVALID_THREAD_ID');
    if (options.beforeByte !== undefined && !bounded(options.beforeByte, 1, Number.MAX_SAFE_INTEGER)) error('INVALID_CURSOR');
    const maxChars = options.maxChars ?? 32_000, limit = options.limit ?? 40;
    if (!bounded(maxChars, 1, 64_000) || !bounded(limit, 1, 200)) error('INVALID_READ');
    const inventory = await this.inventory(access, { threadId }); const entry = inventory.entries.find(e => e.chat.id === threadId);
    if (!entry) error('CHAT_UNAVAILABLE_OR_OUTSIDE_SCOPE');
    const slice = await this.bytes(entry!.path, 'tail', this.config.maxReadBytes ?? 2_097_152, options.beforeByte);
    const header = await this.bytes(entry!.path, 'head', 131_072);
    const boundRow: unknown = JSON.parse(header.buffer.subarray(0, header.buffer.indexOf(10)).toString('utf8'));
    if (!record(boundRow) || !record(boundRow.payload) || boundRow.payload.id !== threadId || boundRow.payload.cwd !== entry!.chat.cwd) error('CHAT_CHANGED');
    let start = slice.start, incomplete = 0, ignored = 0, tailIncomplete = false, buffer = slice.buffer;
    if (slice.start > 0 && !slice.startsOnLineBoundary) { const nl = buffer.indexOf(10); if (nl < 0) { start = slice.end; buffer = Buffer.alloc(0); } else { start += nl + 1; buffer = buffer.subarray(nl + 1); } incomplete++; }
    const finalNl = buffer.lastIndexOf(10); if (finalNl < buffer.length - 1) { incomplete++; tailIncomplete = true; buffer = finalNl < 0 ? Buffer.alloc(0) : buffer.subarray(0, finalNl + 1); }
    const messages: SavedMessage[] = []; let position = start;
    for (const raw of buffer.toString('utf8').split('\n')) {
      const bytePosition = position; position += Buffer.byteLength(raw) + 1; if (!raw) continue;
      let row: unknown; try { row = JSON.parse(raw); } catch { ignored++; continue; }
      if (!record(row) || row.type !== 'response_item' || !record(row.payload)) { ignored++; continue; }
      const p = row.payload;
      if (p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant') || p.channel === 'analysis' || p.channel === 'summary' || (p.role === 'assistant' && p.recipient && p.recipient !== 'all') || !Array.isArray(p.content)) { ignored++; continue; }
      const parts: string[] = [];
      for (const item of p.content) if (record(item) && (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string') parts.push(item.text);
      if (!parts.length) { ignored++; continue; }
      const projection = redactDesktopText(parts.join('\n'));
      messages.push({ ref: `${threadId}:${bytePosition}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`, role: p.role,
        ...(typeof p.phase === 'string' ? { phase: p.phase } : typeof p.channel === 'string' ? { phase: p.channel } : {}), ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
        text: projection.text, redacted: projection.redacted });
    }
    const selected = messages.slice(-limit); let remaining = maxChars;
    for (let i = selected.length - 1; i >= 0; i--) { const m = selected[i]!; if (m.text!.length > remaining) { delete m.text; m.omission = 'whole_message_exceeds_text_budget'; } else remaining -= m.text!.length; }
    // Cursor follows the first returned message when the limit removed earlier messages in this window.
    // Empty windows must still advance through an oversized line instead of repeating the same cursor.
    const nextBeforeByte = messages.length > limit && selected.length ? Number(selected[0]!.ref.split(':')[1]) : slice.start;
    return { chat: entry!.chat, observedAt: new Date().toISOString(), snapshot: createHash('sha256').update(header.buffer).update(slice.buffer).digest('hex'), messages: selected,
      coverage: { startByte: start, endByte: start + buffer.length, fileBytes: slice.size, moreBefore: start > 0 || messages.length > limit, moreAfter: slice.end < slice.size || tailIncomplete,
        nextBeforeByte: nextBeforeByte > 0 ? nextBeforeByte : null, incompleteLines: incomplete, ignoredRecords: ignored, changedDuringRead: slice.changed || header.mtime !== slice.mtime },
      statusEvidence: 'saved_messages_only', desktopAttached: false, controlAvailable: false };
  }
}
