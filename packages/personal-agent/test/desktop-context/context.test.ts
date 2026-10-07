import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCodexContext } from '../../src/desktop-context/index.ts';
import { desktopContextTools } from '../../src/desktop-context/tools.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import { redactDesktopText } from '../../src/desktop-context/privacy.ts';
import type { ToolContext } from '../../src/contracts.ts';
const a = '01a10000-0000-7000-8000-000000000001', b = '01a10000-0000-7000-8000-000000000002';
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-05T00:00:00Z', type, payload }) + '\n';
const message = (role: string, text: string, extra: object = {}) => row('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neurobro-desktop-'));
  const dir = join(home, 'sessions', '2026', '10', '05'); await mkdir(dir, { recursive: true });
  const project = join(home, 'portfolio'), other = join(home, 'unrelated');
  const path = join(dir, `rollout-2026-10-05T00-00-00-${a}.jsonl`);
  const second = join(dir, `rollout-2026-10-05T00-00-01-${b}.jsonl`);
  await writeFile(path, row('session_meta', { id: a, cwd: project, base_instructions: 'SYSTEM SECRET' }) + message('user', 'Build my portfolio') +
    message('assistant', 'private reasoning', { channel: 'analysis' }) + row('response_item', { type: 'function_call_output', output: 'TOOL SECRET' }) +
    message('developer', 'DEVELOPER SECRET') + message('assistant', 'call command with secret', { recipient: 'functions.exec', channel: 'commentary' }) +
    message('assistant', 'Portfolio source is complete; api_key=secret-value', { phase: 'final' }) + row('event_msg', { type: 'agent_message', message: 'DUPLICATE SECRET' }));
  await writeFile(second, row('session_meta', { id: b, cwd: other }) + message('user', 'FOREIGN PRIVATE'));
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: a, thread_name: 'Portfolio discussion', updated_at: '2026-10-05' }) + '\n' + JSON.stringify({ id: b, thread_name: 'Other discussion' }) + '\n');
  await writeFile(join(home, 'auth.json'), 'AUTH FILE MUST NOT BE READ');
  const access = { ownerId: 'owner', scope: { allOwnerThreads: true } };
  const adapter = new LocalCodexContext({ codexHome: home, ownerId: 'owner', scope: { projectRoots: [project] } });
  return { home, dir, path, second, project, adapter, access, cleanup: () => rm(home, { recursive: true, force: true }) };
}
test('finds actual saved title, reads visible messages with scope intersection and honest status', async () => {
  const f = await fixture(); try {
    const found = await f.adapter.search(f.access, { query: 'PORTFOLIO' }); assert.equal(found.chats.length, 1); assert.equal(found.chats[0]!.id, a);
    const read = await f.adapter.read(f.access, a); assert.equal(read.messages.length, 2); assert.equal(read.messages[1]!.phase, 'final');
    const encoded = JSON.stringify(read); for (const secret of ['private reasoning', 'TOOL SECRET', 'DEVELOPER SECRET', 'SYSTEM SECRET', 'secret-value', 'DUPLICATE SECRET', 'call command']) assert.equal(encoded.includes(secret), false);
    assert.equal(read.chat.runtimeStatus, 'unknown'); assert.equal(read.desktopAttached, false); assert.equal(read.controlAvailable, false); assert.equal(read.statusEvidence, 'saved_messages_only');
    assert.equal(read.messages[1]!.redacted, true); assert.equal(read.coverage.moreAfter, false);
    await assert.rejects(f.adapter.read(f.access, b), /OUTSIDE_SCOPE/);
    assert.equal((await f.adapter.search({ ownerId: 'owner', scope: { threadIds: [b] } })).chats.length, 0);
    await assert.rejects(f.adapter.search({ ownerId: 'impostor', scope: { allOwnerThreads: true } }), /OWNER_MISMATCH/);
    const projects = await f.adapter.projects(f.access); assert.equal(projects.registry, 'observed_session_workspaces_only'); assert.equal(projects.projects[0]!.root, f.project);
    assert.equal(await readFile(join(f.home, 'auth.json'), 'utf8'), 'AUTH FILE MUST NOT BE READ');
  } finally { await f.cleanup(); }
});
test('whole-message budget and tail windows disclose gaps and can read earlier records', async () => {
  const f = await fixture(); try {
    await appendFile(f.path, message('assistant', 'x'.repeat(4000)) + message('assistant', 'Newest answer'));
    const adapter = new LocalCodexContext({ codexHome: f.home, ownerId: 'owner', scope: { allOwnerThreads: true }, maxReadBytes: 1024 });
    const tail = await adapter.read(f.access, a, { maxChars: 5 });
    assert.equal(tail.coverage.moreBefore, true); assert.equal(tail.coverage.moreAfter, false);
    assert.equal(tail.messages.at(-1)!.omission, 'whole_message_exceeds_text_budget'); assert.equal(tail.messages.at(-1)!.text, undefined);
    const previous = await f.adapter.read(f.access, a, { beforeByte: tail.coverage.startByte });
    assert.equal(previous.coverage.moreAfter, true); assert.equal(previous.messages.some(m => m.text === 'Build my portfolio'), true);
    await appendFile(f.path, '{"type":"response_item"'); const partial = await adapter.read(f.access, a); assert.equal(partial.coverage.moreAfter, true); assert.ok(partial.coverage.incompleteLines > 0);
  } finally { await f.cleanup(); }
});
test('duplicate identity and oversized metadata are excluded rather than guessed', async () => {
  const f = await fixture(); try {
    await writeFile(join(f.dir, `rollout-copy-${a}.jsonl`), row('session_meta', { id: a, cwd: f.project }) + message('user', 'alternative transcript'));
    const found = await f.adapter.search(f.access); assert.equal(found.chats.length, 0); assert.equal(found.coverage.filesIgnored, 2);
    await assert.rejects(f.adapter.read(f.access, a), /UNAVAILABLE/);
    await writeFile(f.second, row('session_meta', { id: b, cwd: f.project, instructions: 'x'.repeat(140000) }));
    assert.equal((await f.adapter.search(f.access)).coverage.filesIgnored, 3);
  } finally { await f.cleanup(); }
});
test('message-limit cursors retain earlier messages in the same window and empty windows advance', async () => {
  const f = await fixture(); try {
    await appendFile(f.path, Array.from({ length: 8 }, (_, i) => message('assistant', `answer-${i}`)).join(''));
    let cursor: number | undefined; const texts: string[] = [];
    for (let count = 0; count < 6; count++) {
      const page = await f.adapter.read(f.access, a, { limit: 3, beforeByte: cursor });
      texts.push(...page.messages.flatMap(m => m.text ? [m.text] : []));
      if (page.coverage.nextBeforeByte === null) break;
      assert.ok(cursor === undefined || page.coverage.nextBeforeByte < cursor); cursor = page.coverage.nextBeforeByte;
    }
    for (let i = 0; i < 8; i++) assert.equal(texts.filter(t => t === `answer-${i}`).length, 1);
    await appendFile(f.path, message('assistant', 'z'.repeat(6000)));
    const small = new LocalCodexContext({ codexHome: f.home, ownerId: 'owner', scope: { allOwnerThreads: true }, maxReadBytes: 1024 });
    const empty = await small.read(f.access, a); assert.equal(empty.messages.length, 0); assert.ok(empty.coverage.nextBeforeByte! < empty.coverage.fileBytes);
    const older = await small.read(f.access, a, { beforeByte: empty.coverage.nextBeforeByte! }); assert.ok(older.coverage.nextBeforeByte! < empty.coverage.nextBeforeByte!);
  } finally { await f.cleanup(); }
});
test('tail window at an exact record boundary preserves each complete message across cursor pages', async () => {
  const f = await fixture(); try {
    const header = row('session_meta', { id: a, cwd: f.project });
    const marker = 'Точная граница записи';
    const first = message('user', marker), emptyLast = message('assistant', '');
    const lastText = 'x'.repeat(1024 - Buffer.byteLength(first) - Buffer.byteLength(emptyLast));
    const tail = first + message('assistant', lastText);
    assert.equal(Buffer.byteLength(tail), 1024);
    await writeFile(f.path, header + tail);
    const adapter = new LocalCodexContext({ codexHome: f.home, ownerId: 'owner', scope: { allOwnerThreads: true }, maxReadBytes: 1024 });
    let cursor: number | undefined;
    const texts: string[] = [];
    for (let count = 0; count < 3; count++) {
      const page = await adapter.read(f.access, a, { beforeByte: cursor });
      texts.push(...page.messages.flatMap(m => m.text ? [m.text] : []));
      if (count === 0) {
        assert.equal(page.coverage.startByte, Buffer.byteLength(header));
        assert.equal(page.coverage.incompleteLines, 0);
      }
      if (page.coverage.nextBeforeByte === null) break;
      assert.ok(cursor === undefined || page.coverage.nextBeforeByte < cursor);
      cursor = page.coverage.nextBeforeByte;
    }
    assert.deepEqual(texts, [marker, lastText]);
  } finally { await f.cleanup(); }
});

test('path injection and symlinked archives cannot read credentials outside the saved-log roots', async () => {
  const f = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'neurobro-desktop-outside-'));
  try {
    await assert.rejects(f.adapter.read(f.access, '../auth.json'), /INVALID_THREAD_ID/);
    await writeFile(join(outside, `rollout-${b}.jsonl`), row('session_meta', { id: b, cwd: f.project }) + message('user', 'OUTSIDE SECRET'));
    await symlink(outside, join(f.home, 'archived_sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    const adapter = new LocalCodexContext({ codexHome: f.home, ownerId: 'owner', scope: { allOwnerThreads: true }, includeArchived: true });
    await assert.rejects(adapter.search(f.access), /PATH_ESCAPE/);
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});
test('registry exposes only read tools and access cannot be widened through arguments', async () => {
  const f = await fixture(); try {
    const context: ToolContext = { taskId: 'owner-task', intentRevision: 1, grantId: 'g', grantRevision: 1, runId: 'r' };
    const tools = desktopContextTools({ adapter: f.adapter, resolveAccess: () => f.access }); assert.ok(tools.every(t => !t.mutates));
    const registry = new ToolRegistry({ resolveToolContext(token) { assert.equal(token, 'issued'); return context; }, authorizeTool(_token, capability, resource) { assert.equal(capability, 'codex.context.read'); assert.equal(resource, 'owner-task'); }, async executeEffect() { throw new Error('No effects authorized'); } }, tools);
    assert.equal((await registry.invoke('issued', { name: 'codex.chat_read', args: { threadId: a, allOwnerThreads: true } })).ok, false);
    assert.equal((await registry.invoke('issued', { name: 'codex.chat_read', args: { threadId: a } })).ok, true);
    assert.equal((await registry.invoke('issued', { name: 'codex.chat_read', args: { threadId: b } })).ok, false);
    assert.equal((await registry.invoke('issued', { name: 'codex.chat_create', args: {} })).ok, false);
  } finally { await f.cleanup(); }
});
test('credential patterns are removed before title/message export', () => {
  const input = 'api_key="value" password=word Bearer abcdef sk-abcdefghijklmnop 123456789:abcdefghijklmnopqrstuvwxy -----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----';
  const redacted = redactDesktopText(input); assert.equal(redacted.redacted, true);
  for (const secret of ['"value"', '=word', 'abcdef', 'sk-', '123456789:', 'material']) assert.equal(redacted.text.includes(secret), false);
});
