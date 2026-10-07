import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TdlibTelegram, TdRequestError, type TdJsonTransport, type TdObject } from '../../src/telegram/index.ts';
import { telegramTools } from '../../src/capabilities/telegram.ts';
import type { ToolContext } from '../../src/contracts.ts';

const context: ToolContext = { taskId: 'task', intentRevision: 1, grantId: 'grant', grantRevision: 1, runId: 'run' };
const main = { '@type': 'chatListMain' }, archive = { '@type': 'chatListArchive' }, folder = { '@type': 'chatListFolder', chat_folder_id: 7 };
const pos = (list: TdObject = main, order = '9223372036854775800', pinned = false): TdObject => ({ '@type': 'chatPosition', list, order, is_pinned: pinned });
const person = (id: number, list = main, order = '9223372036854775800', bot = false): TdObject[] => [
  { '@type': 'updateUser', user: { '@type': 'user', id: String(id), first_name: `Имя ${id}`, last_name: 'Фамилия', phone_number: 'SECRET-PHONE', usernames: { active_usernames: [`user_${id}`] }, type: { '@type': bot ? 'userTypeBot' : 'userTypeRegular' } } },
  { '@type': 'updateNewChat', chat: { '@type': 'chat', id: String(id), title: `Диалог ${id}`, type: { '@type': 'chatTypePrivate', user_id: String(id) }, positions: [pos(list, order)], last_message: { content: { text: 'SECRET-MESSAGE' } } } },
];
const group = (id: number, options: { list?: TdObject; order?: string; status?: TdObject; basic?: boolean; channel?: boolean } = {}): TdObject[] => [
  { '@type': options.basic ? 'updateBasicGroup' : 'updateSupergroup', [options.basic ? 'basic_group' : 'supergroup']: { '@type': options.basic ? 'basicGroup' : 'supergroup', id: String(id), is_channel: !!options.channel, usernames: { active_usernames: options.channel ? [`jobs_${id}`] : [] }, status: options.status ?? { '@type': 'chatMemberStatusMember' } } },
  { '@type': 'updateNewChat', chat: { '@type': 'chat', id: String(-id), title: `Чат ${id}`, type: options.basic ? { '@type': 'chatTypeBasicGroup', basic_group_id: String(id) } : { '@type': 'chatTypeSupergroup', supergroup_id: String(id), is_channel: !!options.channel }, positions: [pos(options.list ?? main, options.order)] } },
];
function fixture(initial: TdObject[] = [], loads: TdObject[][] = []) {
  class Fake extends EventEmitter implements TdJsonTransport {
    calls: TdObject[] = []; state = initial; batches = [...loads]; closed = false;
    stateHook?: () => Promise<void> | void; loadHook?: () => Promise<TdObject>;
    async invoke(request: TdObject): Promise<TdObject> {
      this.calls.push(structuredClone(request));
      if (request['@type'] === 'getMe') return { '@type': 'user', id: '42' };
      if (request['@type'] === 'getCurrentState') { const state = structuredClone(this.state); await this.stateHook?.(); return { '@type': 'updates', updates: state }; }
      if (request['@type'] === 'loadChats') {
        if (this.loadHook) return this.loadHook();
        const batch = this.batches.shift(); if (!batch) throw new TdRequestError('TDLib rejected request', true, 404);
        for (const update of batch) this.emit('update', structuredClone(update)); return { '@type': 'ok' };
      }
      throw new TdRequestError('metadata unavailable', true, 403);
    }
    async close() { this.closed = true; }
  }
  const transport = new Fake();
  const port = new TdlibTelegram({ accountId: '42', transport, receipts: { get: async () => undefined, put: async () => {}, findMessage: async () => undefined } });
  const read = async (args: TdObject = {}, ctx = context): Promise<TdObject> => await port.readCapability('telegram.chats.list', args, ctx) as TdObject;
  return { port, transport, read };
}

test('cold startup uses real updates and repeated short native loads; over 100 dialogs are genuinely paginated', async () => {
  const rows = Array.from({ length: 137 }, (_, n) => person(n + 1, main, String(9223372036854775800n - BigInt(n))));
  const f = fixture([], [rows.slice(0, 2).flat(), [], rows.slice(2, 31).flat(), rows.slice(31).flat()]);
  let result = await f.read({ limit: 20 }); const snapshot = result.snapshotId, seen: string[] = [];
  assert.equal(result.coverage.complete, true); assert.equal(result.coverage.loadRequests, 5); assert.equal(result.coverage.loadedChats, 137);
  do {
    assert.equal(result.snapshotId, snapshot); assert.ok(result.chats.length <= 20); seen.push(...result.chats.map((row: TdObject) => row.peerId));
    assert.equal(result.chats[0].positions[0].order, String(9223372036854775800n - BigInt(seen.length - result.chats.length)));
    if (!result.nextCursor) break; result = await f.read({ limit: 20, cursor: result.nextCursor });
  } while (true);
  assert.deepEqual(seen, Array.from({ length: 137 }, (_, n) => String(n + 1))); assert.equal(result.page.snapshotExhausted, true);
  assert.deepEqual([...new Set(f.transport.calls.map(r => r['@type']))], ['getMe', 'getCurrentState', 'loadChats']);
  await f.port.close();
});

test('main, archive and dynamic folder positions are distinct list identities, with classification and human names', async () => {
  const f = fixture([
    ...person(1), ...person(2, main, undefined, true), ...person(3, archive), ...group(4, { basic: true }), ...group(5), ...group(6, { channel: true, list: folder }),
    { '@type': 'updateChatFolders', chat_folders: [{ id: 7, name: { text: { text: 'Работа' } } }] },
  ]);
  const a = await f.read(); assert.equal(a.chats.length, 4); assert.deepEqual(new Set(a.chats.map((r: TdObject) => r.kind)), new Set(['private', 'bot', 'group', 'supergroup']));
  const user = a.chats.find((r: TdObject) => r.peerId === '1'); assert.equal(user.firstName, 'Имя 1'); assert.equal(user.lastName, 'Фамилия'); assert.equal(user.username, 'user_1'); assert.equal(user.publicUrl, 'https://t.me/user_1');
  assert.equal(JSON.stringify(a).includes('SECRET'), false);
  const b = await f.read({ list: 'archive' }); assert.deepEqual(b.chats.map((r: TdObject) => r.peerId), ['3']);
  const c = await f.read({ list: 'folder', folderId: 7 }); assert.equal(c.list.name, 'Работа'); assert.equal(c.chats[0].kind, 'channel'); assert.equal(c.chats[0].ownMembership, 'member'); assert.equal(c.chats[0].positions[0].list.name, 'Работа');
  assert.deepEqual(f.transport.calls.filter(r => r['@type'] === 'loadChats').map(r => r.chat_list), [main, archive, folder]); await f.port.close();
});

test('native 404 alone proves exhaustion; short or empty ok loads reach a finite explicit incomplete bound', async () => {
  const f = fixture(person(1)); f.transport.loadHook = async () => ({ '@type': 'ok' });
  const result = await f.read(); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.reason, 'load-request-limit'); assert.equal(result.coverage.loadRequests, 50); assert.equal(result.chats.length, 1); await f.port.close();
});

test('rate or transport load failure returns partial dialog evidence and never searches or retries the failed read', async () => {
  const f = fixture(person(1)); f.transport.loadHook = async () => { throw new TdRequestError('native rejection', true, 429, 'FLOOD_WAIT_60'); };
  const result = await f.read(); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.reason, 'load-unavailable'); assert.equal(result.coverage.errorCode, 429); assert.equal(result.coverage.loadRequests, 1); assert.equal(result.chats[0].peerId, '1'); await f.port.close();
});

test('unavailable current state is not empty dialog evidence, including state 404', async () => {
  const f = fixture(); f.transport.stateHook = () => { throw new TdRequestError('state missing', true, 404); };
  const result = await f.read(); assert.equal(result.status, 'unavailable'); assert.equal(result.chats, undefined); assert.equal(f.transport.calls.some(r => r['@type'] === 'loadChats'), false); await f.port.close();
});

test('duplicate new-chat updates are deduplicated and frozen pages resist title, order and list removal changes', async () => {
  const f = fixture([...person(1), ...person(2, main, '9223372036854775799'), ...person(2, main, '9223372036854775799')]);
  const first = await f.read({ limit: 1 }); assert.equal(first.chats[0].peerId, '1');
  f.transport.emit('update', { '@type': 'updateChatTitle', chat_id: '2', title: 'Changed' });
  f.transport.emit('update', { '@type': 'updateChatPosition', chat_id: '2', position: pos(main, '0') });
  const second = await f.read({ limit: 1, cursor: first.nextCursor }); assert.equal(second.chats[0].title, 'Диалог 2'); assert.equal(second.chats[0].peerId, '2'); assert.equal(second.coverage.loadedChats, 2); await f.port.close();
});

test('live title and last-message/draft position updates received during stale snapshot retrieval win', async () => {
  const f = fixture([...person(1), ...person(2)]);
  f.transport.stateHook = () => {
    f.transport.emit('update', { '@type': 'updateChatTitle', chat_id: '1', title: 'Fresh' });
    f.transport.emit('update', { '@type': 'updateChatLastMessage', chat_id: '2', last_message: { text: 'SECRET' }, positions: [pos(archive)] });
    f.transport.emit('update', { '@type': 'updateChatDraftMessage', chat_id: '1', draft_message: { text: 'SECRET' }, positions: [pos(main, '9223372036854775790')] });
  };
  const result = await f.read(); assert.equal(result.chats.length, 1); assert.equal(result.chats[0].title, 'Fresh'); assert.equal(result.chats[0].positions[0].order, '9223372036854775790'); await f.port.close();
});

test('left, banned, restricted and former creator memberships remain honest', async () => {
  const statuses = [
    { '@type': 'chatMemberStatusLeft' }, { '@type': 'chatMemberStatusBanned' }, { '@type': 'chatMemberStatusRestricted', is_member: true }, { '@type': 'chatMemberStatusRestricted', is_member: false }, { '@type': 'chatMemberStatusCreator', is_member: false }, { '@type': 'chatMemberStatusCreator', is_member: true }, {},
  ];
  const f = fixture(statuses.flatMap((status, n) => group(n + 1, { channel: true, status })));
  const result = await f.read(); assert.deepEqual(result.chats.map((r: TdObject) => r.ownMembership), ['left', 'banned', 'member', 'left', 'left', 'member', 'unknown']); await f.port.close();
});

test('metadata fallback failure preserves a real dialog without inventing joined membership or identities', async () => {
  const f = fixture([group(1, { channel: true })[1]!]);
  const result = await f.read(); assert.equal(result.coverage.complete, true); assert.equal(result.chats[0].kind, 'channel'); assert.equal(result.chats[0].ownMembership, 'unknown'); assert.equal(result.chats[0].metadataIncomplete, true); assert.deepEqual(result.chats[0].usernames, []); await f.port.close();
});

test('opaque cursors reject another run/list/grant or adapter restart; changed connection never returns cached names', async () => {
  const f = fixture([...person(1), ...person(2)]); const first = await f.read({ limit: 1 });
  await assert.rejects(f.read({ cursor: 'made-up' }), /cursor/);
  await assert.rejects(f.read({ cursor: first.nextCursor }, { ...context, runId: 'other' }), /cursor/);
  await assert.rejects(f.read({ cursor: first.nextCursor }, { ...context, grantRevision: 2 }), /cursor/);
  await assert.rejects(f.read({ cursor: first.nextCursor, list: 'archive' }), /cursor/);
  f.transport.emit('gap', {}); await assert.rejects(f.read({ cursor: first.nextCursor }), /cursor/);
  f.transport.stateHook = () => { f.transport.emit('gap', {}); }; assert.equal((await f.read()).status, 'unavailable'); await f.port.close();
});

test('invalid list/folder bounds or lossily decoded position never yields complete data', async () => {
  const f = fixture(person(1));
  for (const args of [{ list: 'all' }, { list: 'folder' }, { folderId: 7 }, { limit: 0 }, { limit: 101 }, { list: 'folder', folderId: -7 }]) await assert.rejects(f.read(args));
  f.transport.state = [{ ...person(1)[1], chat: { ...person(1)[1]!.chat, positions: [pos(main, 9223372036854775800 as unknown as string)] } }];
  assert.equal((await f.read()).status, 'unavailable'); await f.port.close();
});

test('fresh account-inventory authorization runs before and after native read, withholding stale-origin result', async () => {
  const f = fixture(person(1)); let gate = 0;
  const tools = telegramTools({ accountId: '42', telegram: f.port, broker: {} as any, authorizeAccountInventory: async ctx => { assert.deepEqual(ctx, context); if (++gate === 2) throw new Error('owner origin withdrawn'); } });
  const tool = tools.find(t => t.name === 'telegram.chats.list')!;
  assert.deepEqual(tool.resources({}, context), ['42']); assert.equal(tool.mutates, false);
  await assert.rejects(tool.execute({ args: {}, context, token: 'token' }), /withdrawn/); assert.equal(gate, 2); assert.ok(f.transport.calls.some(r => r['@type'] === 'loadChats'));
  gate = 1; const before = f.transport.calls.length; await assert.rejects(tool.execute({ args: {}, context, token: 'token' }), /withdrawn/); assert.equal(f.transport.calls.length, before); await f.port.close();
});

test('exhaustion is reconciled against current state when native position updates are delivered after load response', async () => {
  const f = fixture(); let requests = 0;
  f.transport.loadHook = async () => { f.transport.state = person(8); throw new TdRequestError('fully loaded', true, 404); };
  f.transport.stateHook = () => { requests++; };
  const result = await f.read(); assert.equal(requests, 2); assert.equal(result.coverage.complete, true); assert.equal(result.chats[0].peerId, '8'); await f.port.close();
});

test('malformed live update during snapshot pending prevents acceptance of a clean but stale snapshot', async () => {
  const f = fixture(person(1));
  f.transport.stateHook = () => { f.transport.emit('update', { '@type': 'updateChatPosition', chat_id: '1', position: pos(main, 'nonsense') }); };
  const result = await f.read(); assert.equal(result.status, 'unavailable'); assert.match(result.reason, /invalid.*update/); await f.port.close();
});

test('failed final state reconciliation after native exhaustion never returns a complete empty list', async () => {
  const f = fixture(person(1)); let requests = 0;
  f.transport.stateHook = () => { if (++requests === 2) throw new TdRequestError('gone', true); };
  const result = await f.read(); assert.equal(result.status, 'unavailable'); assert.equal(result.chats, undefined); await f.port.close();
});

test('late final-state overflow cannot retain a native exhaustion completeness claim after dropping dialogs', async () => {
  const f = fixture();
  f.transport.loadHook = async () => {
    f.transport.state = Array.from({ length: 5001 }, (_, n) => person(n + 1, main, String(9223372036854775800n - BigInt(n)))).flat();
    throw new TdRequestError('fully loaded', true, 404);
  };
  const first = await f.read({ limit: 100 });
  assert.equal(first.coverage.complete, false); assert.equal(first.coverage.reason, 'chat-limit'); assert.equal(first.coverage.loadedChats, 5000);
  assert.equal(first.chats.length, 100); assert.ok(first.nextCursor);
  let page = first, delivered = page.chats.length;
  while (page.nextCursor) { page = await f.read({ limit: 100, cursor: page.nextCursor }); delivered += page.chats.length; }
  assert.equal(delivered, 5000); assert.equal(page.page.snapshotExhausted, true); assert.equal(page.coverage.complete, false); assert.equal(page.coverage.reason, 'chat-limit');
  await f.port.close();
});
