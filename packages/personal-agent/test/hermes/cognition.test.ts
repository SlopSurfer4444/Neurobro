import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalStore } from '../../src/core/store.ts';
import { HTTPNativeSkills, createNativeSkillTools, admitNativeSkill, revokeNativeSkill, NativeSkillDriftError, type NativeSkillDescriptor } from '../../src/hermes/cognition.ts';
import type { ToolContext } from '../../src/contracts.ts';

const context: ToolContext = { taskId: 'task-1', intentRevision: 1, grantId: 'grant-1', grantRevision: 1, runId: 'run-1' };
const descriptor: NativeSkillDescriptor = { id: 'skill-1', nativeName: 'writing/notes', sha256: 'a'.repeat(64), ownerId: 'owner', accountId: 'account', scope: 'global', sourceRefs: [], state: 'approved' };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'nb-cognition-')), store = new PersonalStore({ databasePath: join(dir, 'encrypted.sqlite'), encryptionKey: Buffer.alloc(32, 41) });
  const calls: any[] = []; let mode = 'normal';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    const input = calls.at(-1)!.body;
    if (mode === 'drift') { res.writeHead(409); res.end(JSON.stringify({ ok: false, error: 'skill_source_changed' })); return; }
    if (mode === 'huge') { res.end(' '.repeat(524289)); return; }
    if (mode === 'revoke') revokeNativeSkill(store, descriptor.id);
    const skill = mode === 'extra' ? { ...input.descriptors[0], nativeName: 'outside' } : { ...input.descriptors[0], name: 'Notes', description: 'Installed knowledge' };
    res.end(JSON.stringify({ ok: true, value: input.operation === 'list' ? { skills: input.descriptors.map((item: NativeSkillDescriptor) => ({ ...item, name: 'Notes', description: 'Installed knowledge' })) } : { skill, content: '---\nname: Notes\ndescription: Installed knowledge\n---\nUseful notes\n' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, lineage: string[] = [];
  const tools = createNativeSkillTools({ store, native: new HTTPNativeSkills({ baseUrl: `http://127.0.0.1:${port}`, registrationKey: 'registration-only-'.repeat(3) }),
    resolveAccess: ctx => ({ ownerId: 'owner', accountId: 'account', scopes: ['global', `task:${ctx.taskId}`] }), resolveSession: ctx => { assert.equal(ctx.runId, 'run-1'); return 'original-admission-session'; },
    admitReference: (_ctx, item) => { const current = store.get<NativeSkillDescriptor>('hermesSkills', item.id); assert.equal(current?.state, 'approved'); lineage.push(item.id); } });
  return { store, tools, calls, lineage, mode: (next: string) => { mode = next; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('native list/view use only trusted descriptors and original admission; knowledge is scoped and read-only', async () => {
  const f = await fixture(); try {
    const list = f.tools[0]!, view = f.tools[1]!;
    assert.deepEqual(await list.execute({ context, token: 'broker-token', args: {} }), { skills: [], availability: 'unavailable', reason: 'No approved scoped native skill descriptor' });
    assert.equal(f.calls.length, 0);
    admitNativeSkill(f.store, descriptor);
    admitNativeSkill(f.store, { ...descriptor, id: 'foreign', accountId: 'other' });
    admitNativeSkill(f.store, { ...descriptor, id: 'other-chat', nativeName: 'private/notes', scope: 'chat:foreign' });
    const listed = await list.execute({ context, token: 'broker-token', args: {} });
    assert.equal((listed as any).skills.length, 1); assert.equal(JSON.stringify(listed).includes('nativeName'), false);
    const read = await view.execute({ context, token: 'broker-token', args: { skillId: descriptor.id } });
    assert.match((read as any).content, /Useful notes/); assert.equal((read as any).preprocessing, false);
    assert.equal(f.calls.at(-1).path, '/cognition/read'); assert.equal(f.calls.at(-1).body.session_id, 'original-admission-session');
    assert.deepEqual(f.calls.at(-1).body.descriptors, [descriptor]); assert.equal(JSON.stringify(f.calls).includes('broker-token'), false);
    assert.equal(f.lineage.length, 4);
    await assert.rejects(view.execute({ context, token: 'broker-token', args: { skillId: 'other-chat' } }), /outside trusted scope/);
  } finally { await f.close(); }
});
test('source revocation during read and native metadata substitution cannot expose content', async () => {
  const f = await fixture(); try {
    admitNativeSkill(f.store, descriptor); f.mode('extra');
    await assert.rejects(f.tools[1]!.execute({ context, token: 'token', args: { skillId: descriptor.id } }), /mismatch/);
    f.mode('revoke'); await assert.rejects(f.tools[1]!.execute({ context, token: 'token', args: { skillId: descriptor.id } }), /changed during native read/);
    assert.throws(() => admitNativeSkill(f.store, descriptor), /immutable/);
  } finally { await f.close(); }
});
test('raw native source drift revokes stale knowledge; bounded responses fail closed', async () => {
  const f = await fixture(); try {
    admitNativeSkill(f.store, descriptor); f.mode('huge');
    await assert.rejects(f.tools[1]!.execute({ context, token: 'token', args: { skillId: descriptor.id } }), /exceeds bound/);
    assert.equal(f.store.get<NativeSkillDescriptor>('hermesSkills', descriptor.id)?.state, 'approved');
    f.mode('drift'); await assert.rejects(f.tools[1]!.execute({ context, token: 'token', args: { skillId: descriptor.id } }), NativeSkillDriftError);
    assert.equal(f.store.get<NativeSkillDescriptor>('hermesSkills', descriptor.id)?.state, 'revoked');
  } finally { await f.close(); }
});
test('host admission validates paths and atomically revokes older native versions', () => {
  const store = new PersonalStore({ databasePath: ':memory:', encryptionKey: Buffer.alloc(32, 42) });
  try {
    assert.throws(() => admitNativeSkill(store, { ...descriptor, nativeName: '../secret' }), /Invalid/);
    assert.throws(() => admitNativeSkill(store, { ...descriptor, sourceRefs: ['ref', 'ref'] }), /Invalid/);
    admitNativeSkill(store, descriptor); admitNativeSkill(store, { ...descriptor, id: 'v2', sha256: 'b'.repeat(64) });
    assert.equal(store.get<NativeSkillDescriptor>('hermesSkills', descriptor.id)?.state, 'revoked');
  } finally { store.close(); }
});
