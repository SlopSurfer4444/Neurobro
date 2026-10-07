import { randomUUID } from 'node:crypto';
import type { Json, ToolContext } from '../contracts.ts';
import { telegramId } from './identity.ts';
import { folderId } from './folders.ts';
import { TdRequestError, type TdObject } from './transport.ts';

type List = { kind: 'main' | 'archive' | 'folder'; folderId?: number; name?: string };
type Snapshot = { id: string; owner: string; generation: number; expires: number; list: List; chats: TdObject[]; coverage: TdObject };
const MAX_CHATS = 5000, MAX_LOAD_REQUESTS = 50, MAX_SNAPSHOTS = 8, SNAPSHOT_TTL = 5 * 60_000;
const record = (v: unknown): TdObject => v && typeof v === 'object' && !Array.isArray(v) ? v as TdObject : {};
const text = (v: unknown, max = 512): string => typeof v === 'string' ? v.slice(0, max) : '';
function listView(v: TdObject): List {
  switch (v['@type']) {
    case 'chatListMain': return { kind: 'main' };
    case 'chatListArchive': return { kind: 'archive' };
    case 'chatListFolder': return { kind: 'folder', folderId: folderId(v.chat_folder_id) };
    default: throw new Error('invalid Telegram chat list');
  }
}
const listKey = (v: List) => v.kind === 'folder' ? `folder:${v.folderId}` : v.kind;
const nativeList = (v: List): TdObject => ({ '@type': v.kind === 'folder' ? 'chatListFolder' : v.kind === 'archive' ? 'chatListArchive' : 'chatListMain', ...(v.kind === 'folder' ? { chat_folder_id: v.folderId } : {}) });
function order(v: unknown): string {
  if (!((typeof v === 'string' && /^\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))) throw new Error('invalid Telegram list order');
  const n = BigInt(v); if (n > 9223372036854775807n) throw new Error('invalid Telegram list order'); return n.toString();
}
function positions(v: unknown): TdObject[] {
  if (!Array.isArray(v) || v.length > 102) throw new Error('invalid Telegram chat positions');
  const found = new Set<string>();
  return v.map(p => { const list = listView(record(p).list), key = listKey(list); if (found.has(key)) throw new Error('duplicate Telegram chat position'); found.add(key); return { list, order: order(p.order), pinned: p.is_pinned === true }; }).filter(p => p.order !== '0');
}
function membership(status: TdObject): string {
  switch (status['@type']) {
    case 'chatMemberStatusMember': case 'chatMemberStatusAdministrator': return 'member';
    case 'chatMemberStatusCreator': case 'chatMemberStatusRestricted': return status.is_member === true ? 'member' : status.is_member === false ? 'left' : 'unknown';
    case 'chatMemberStatusLeft': return 'left';
    case 'chatMemberStatusBanned': return 'banned';
    default: return 'unknown';
  }
}
const usernames = (v: TdObject): string[] => Array.isArray(v.usernames?.active_usernames) ? v.usernames.active_usernames.filter((s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(s)).slice(0, 20) : [];
const ownerKey = (context?: ToolContext): string => context ? JSON.stringify([context.taskId, context.intentRevision, context.grantId, context.grantRevision, context.runId]) : 'trusted-host';

/** Account-scoped metadata only. No message bodies, phones, access hashes or public-search results.
 * TDLib loadChats is incremental; only its documented 404 proves list exhaustion.
 * Position ordering is int64, and opaque pages freeze the observed list against later reordering.
 */
export class TelegramChatInventory {
  private chats = new Map<string, TdObject>();
  private users = new Map<string, TdObject>();
  private groups = new Map<string, TdObject>();
  private folders = new Map<number, string>();
  private sessions = new Map<string, Snapshot>();
  private cursors = new Map<string, { snapshot: Snapshot; offset: number }>();
  private generation = 0;
  private stateReplay?: TdObject[];
  private stateOverflow = false;
  private invalid?: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly accountId: string;
  private readonly invoke: (request: TdObject) => Promise<TdObject>;
  constructor(accountId: string, invoke: (request: TdObject) => Promise<TdObject>) { this.accountId = accountId; this.invoke = invoke; }
  invalidate(): void { this.generation++; this.chats.clear(); this.users.clear(); this.groups.clear(); this.folders.clear(); this.sessions.clear(); this.cursors.clear(); this.invalid = undefined; }
  capture(update: TdObject): void {
    if (!['updateNewChat', 'updateChatTitle', 'updateChatPosition', 'updateChatLastMessage', 'updateChatDraftMessage', 'updateChatRemovedFromList', 'updateUser', 'updateSupergroup', 'updateBasicGroup', 'updateChatFolders'].includes(update['@type'])) return;
    try {
      const minimal = this.minimalUpdate(update);
      if (this.stateReplay) { if (this.stateReplay.length < 20_000) this.stateReplay.push(minimal); else this.stateOverflow = true; }
      this.apply(minimal);
    } catch { this.invalid = 'invalid Telegram inventory update'; }
  }
  private minimalUpdate(update: TdObject): TdObject {
    switch (update['@type']) {
      case 'updateNewChat': { const chat = record(update.chat); return { '@type': update['@type'], chat: { id: telegramId(chat.id), title: text(chat.title), type: structuredClone(record(chat.type)), positions: positions(chat.positions) } }; }
      case 'updateChatLastMessage': case 'updateChatDraftMessage': return { '@type': 'positions', chat_id: telegramId(update.chat_id), positions: positions(update.positions) };
      case 'updateChatPosition': return { '@type': 'position', chat_id: telegramId(update.chat_id), position: { list: listView(record(update.position).list), order: order(record(update.position).order), pinned: record(update.position).is_pinned === true } };
      case 'updateChatRemovedFromList': return { '@type': 'removed', chat_id: telegramId(update.chat_id), list: listView(record(update.chat_list)) };
      case 'updateChatTitle': return { '@type': update['@type'], chat_id: telegramId(update.chat_id), title: text(update.title) };
      case 'updateChatFolders': {
        if (!Array.isArray(update.chat_folders) || update.chat_folders.length > 100) throw new Error('invalid folders');
        return { '@type': update['@type'], folders: update.chat_folders.map((f: TdObject) => ({ id: folderId(f.id), name: text(f.name?.text?.text, 64) })) };
      }
      default: {
        const value = record(update.user ?? update.supergroup ?? update.basic_group);
        return { '@type': update['@type'], value: { id: telegramId(value.id), firstName: text(value.first_name, 256), lastName: text(value.last_name, 256), usernames: usernames(value), bot: value.type?.['@type'] === 'userTypeBot', deleted: value.type?.['@type'] === 'userTypeDeleted', status: { '@type': value.status?.['@type'], is_member: value.status?.is_member }, isChannel: value.is_channel } };
      }
    }
  }
  private apply(update: TdObject): void {
    switch (update['@type']) {
      case 'updateNewChat': this.chats.set(update.chat.id, update.chat); break;
      case 'updateUser': this.users.set(update.value.id, update.value); break;
      case 'updateSupergroup': this.groups.set(`super:${update.value.id}`, update.value); break;
      case 'updateBasicGroup': this.groups.set(`basic:${update.value.id}`, update.value); break;
      case 'updateChatFolders': this.folders = new Map(update.folders.map((f: TdObject) => [f.id, f.name])); break;
      default: {
        const chat = this.chats.get(update.chat_id) ?? { id: update.chat_id, positions: [] };
        if (update['@type'] === 'updateChatTitle') chat.title = update.title;
        if (update['@type'] === 'positions') chat.positions = update.positions;
        if (update['@type'] === 'position' || update['@type'] === 'removed') {
          const list = update.position?.list ?? update.list;
          chat.positions = chat.positions.filter((p: TdObject) => listKey(p.list) !== listKey(list));
          if (update.position?.order !== undefined && update.position.order !== '0') chat.positions.push(update.position);
        }
        this.chats.set(update.chat_id, chat);
      }
    }
  }
  async read(args: TdObject, context?: ToolContext): Promise<Json> {
    const task = this.tail.then(() => this.readSerial(args, context)); this.tail = task.catch(() => undefined); return task;
  }
  private async refreshState(generation: number, clear: boolean): Promise<string | undefined> {
    this.stateReplay = []; this.stateOverflow = false;
    let state: TdObject;
    try { state = await this.invoke({ '@type': 'getCurrentState' }); }
    catch { this.stateReplay = undefined; return 'Telegram inventory state unavailable; no empty-list claim'; }
    const replay = this.stateReplay; this.stateReplay = undefined;
    if (generation !== this.generation) return 'Telegram inventory connection changed';
    if (state['@type'] !== 'updates' || !Array.isArray(state.updates) || this.stateOverflow) return 'Telegram inventory state incomplete';
    // A malformed live update during the pending snapshot must not be reset by a valid response.
    if (this.invalid) return this.invalid;
    if (clear) { this.chats.clear(); this.users.clear(); this.groups.clear(); this.folders.clear(); }
    for (const update of state.updates) this.capture(update);
    for (const update of replay) this.apply(update);
    return this.invalid;
  }
  private async readSerial(args: TdObject, context?: ToolContext): Promise<Json> {
    const kind = args.list ?? 'main';
    if (!['main', 'archive', 'folder'].includes(kind) || (kind !== 'folder' && args.folderId !== undefined)) throw new Error('Telegram inventory requires main, archive or folder list');
    const list: List = { kind, ...(kind === 'folder' ? { folderId: folderId(args.folderId) } : {}) };
    const limit = args.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Telegram inventory page limit must be 1..100');
    const owner = ownerKey(context), now = Date.now();
    for (const [id, snapshot] of this.sessions) if (snapshot.expires <= now) this.dropSession(id);
    let snapshot: Snapshot, offset = 0;
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== 'string') throw new Error('invalid Telegram inventory cursor');
      const cursor = this.cursors.get(args.cursor);
      if (!cursor || cursor.snapshot.owner !== owner || cursor.snapshot.generation !== this.generation || listKey(cursor.snapshot.list) !== listKey(list)) throw new Error('Telegram inventory cursor expired or bound to another run/list');
      snapshot = cursor.snapshot; offset = cursor.offset;
    } else {
      const generation = this.generation;
      this.invalid = undefined;
      const stateError = await this.refreshState(generation, true);
      if (stateError) return { status: 'unavailable', reason: stateError };
      let complete = false, reason = 'load-request-limit', loadRequests = 0, errorCode: number | undefined;
      const deadline = Date.now() + 30_000;
      while (!this.invalid && this.selected(list).length < MAX_CHATS && loadRequests < MAX_LOAD_REQUESTS && Date.now() < deadline) {
        loadRequests++;
        try { const response = await this.invoke({ '@type': 'loadChats', chat_list: nativeList(list), limit: 100 }); if (response['@type'] !== 'ok') { reason = 'invalid-load-response'; break; } }
        catch (error) {
          if (error instanceof TdRequestError && error.code === 404) complete = true;
          else { reason = 'load-unavailable'; if (error instanceof TdRequestError) errorCode = error.code; }
          break;
        }
        if (generation !== this.generation) return { status: 'unavailable', reason: 'Telegram inventory connection changed' };
      }
      if (generation !== this.generation) return { status: 'unavailable', reason: 'Telegram inventory connection changed' };
      if (this.invalid) return { status: 'unavailable', reason: this.invalid };
      // loadChats resolves separately from the update stream. Reconcile actual current
      // TDLib state after exhaustion before claiming complete, even if position updates
      // haven't reached this application's receive callback yet.
      if (complete) {
        const finalStateError = await this.refreshState(generation, false);
        if (finalStateError) return { status: 'unavailable', reason: finalStateError };
      }
      const selected = this.selected(list);
      if (selected.length >= MAX_CHATS) { complete = false; reason = 'chat-limit'; } else if (Date.now() >= deadline && !complete) reason = 'loading-deadline';
      if (kind === 'folder' && this.folders.has(list.folderId!)) list.name = this.folders.get(list.folderId!);
      snapshot = { id: randomUUID(), owner, generation, expires: Date.now() + SNAPSHOT_TTL, list, chats: selected.slice(0, MAX_CHATS).map(chat => this.snapshotChat(chat)), coverage: { complete, loadedChats: Math.min(selected.length, MAX_CHATS), loadRequests, ...(complete ? {} : { reason }), ...(errorCode !== undefined ? { errorCode } : {}) } };
      while (this.sessions.size >= MAX_SNAPSHOTS) this.dropSession(this.sessions.keys().next().value!);
      this.sessions.set(snapshot.id, snapshot);
    }
    const rows: TdObject[] = [];
    for (const chat of snapshot.chats.slice(offset, offset + limit)) rows.push(await this.view(chat));
    if (snapshot.generation !== this.generation) return { status: 'unavailable', reason: 'Telegram inventory connection changed' };
    let nextCursor: string | undefined;
    if (offset + rows.length < snapshot.chats.length) { nextCursor = randomUUID(); this.cursors.set(nextCursor, { snapshot, offset: offset + rows.length }); }
    // Bound repeat-page cursor issuance independently of snapshot/chat counts.
    while (this.cursors.size > MAX_SNAPSHOTS * MAX_CHATS) this.cursors.delete(this.cursors.keys().next().value!);
    return { status: 'observed', accountId: this.accountId, snapshotId: snapshot.id, list: snapshot.list, chats: rows, coverage: snapshot.coverage, page: { offset, returned: rows.length, snapshotExhausted: !nextCursor }, ...(nextCursor ? { nextCursor } : {}) } as Json;
  }
  private dropSession(id: string): void { this.sessions.delete(id); for (const [token, cursor] of this.cursors) if (cursor.snapshot.id === id) this.cursors.delete(token); }
  private selected(list: List): TdObject[] {
    const key = listKey(list), position = (chat: TdObject) => chat.positions.find((p: TdObject) => listKey(p.list) === key);
    return [...this.chats.values()].filter(chat => position(chat)).sort((a, b) => { const oa = BigInt(position(a).order), ob = BigInt(position(b).order); return oa > ob ? -1 : oa < ob ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0; });
  }
  private snapshotChat(chat: TdObject): TdObject {
    const type = record(chat.type), user = this.users.get(String(type.user_id)), group = this.groups.get(`${type['@type'] === 'chatTypeBasicGroup' ? 'basic' : 'super'}:${type.basic_group_id ?? type.supergroup_id}`);
    return structuredClone({ ...chat, positions: chat.positions.map((p: TdObject) => ({ ...p, list: { ...p.list, ...(p.list.kind === 'folder' && this.folders.has(p.list.folderId) ? { name: this.folders.get(p.list.folderId) } : {}) } })), user, group });
  }
  private async view(chat: TdObject): Promise<TdObject> {
    const row: TdObject = { accountId: this.accountId, peerId: chat.id, title: chat.title ?? '', kind: 'unknown', ownMembership: 'unknown', usernames: [], positions: structuredClone(chat.positions) };
    try {
      const type = record(chat.type);
      if (['chatTypePrivate', 'chatTypeSecret'].includes(type['@type'])) {
        const userId = telegramId(type.user_id); let user = chat.user;
        if (!user) { const native = await this.invoke({ '@type': 'getUser', user_id: userId }); if (telegramId(native.id) !== userId) throw new Error('identity mismatch'); user = this.minimalUpdate({ '@type': 'updateUser', user: native }).value; }
        row.userId = userId; row.kind = type['@type'] === 'chatTypeSecret' ? 'secret' : user.bot ? 'bot' : 'private'; row.firstName = user.firstName; row.lastName = user.lastName; row.usernames = user.usernames; row.deleted = user.deleted; row.ownMembership = 'not-applicable';
      } else if (['chatTypeSupergroup', 'chatTypeBasicGroup'].includes(type['@type'])) {
        const basic = type['@type'] === 'chatTypeBasicGroup', id = telegramId(basic ? type.basic_group_id : type.supergroup_id); let group = chat.group;
        row.kind = basic ? 'group' : type.is_channel === true ? 'channel' : 'supergroup';
        if (!group) { const native = await this.invoke({ '@type': basic ? 'getBasicGroup' : 'getSupergroup', [basic ? 'basic_group_id' : 'supergroup_id']: id }); if (telegramId(native.id) !== id) throw new Error('identity mismatch'); group = this.minimalUpdate({ '@type': basic ? 'updateBasicGroup' : 'updateSupergroup', [basic ? 'basic_group' : 'supergroup']: native }).value; }
        if (!basic && group.isChannel !== undefined && group.isChannel !== type.is_channel) throw new Error('type mismatch');
        row.ownMembership = membership(record(group.status)); row.usernames = group.usernames;
      } else row.metadataIncomplete = true;
    } catch { row.metadataIncomplete = true; row.metadataReason = 'peer-metadata-unavailable'; }
    if (row.usernames[0]) { row.username = row.usernames[0]; row.publicUrl = `https://t.me/${row.username}`; }
    return row;
  }
}
