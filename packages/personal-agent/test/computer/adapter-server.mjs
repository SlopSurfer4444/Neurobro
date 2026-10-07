import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const mode = process.env.FIXTURE_MODE;
const root = process.env.FIXTURE_ROOT;
const database = process.env.FIXTURE_DATABASE;
let threads = existsSync(database) ? JSON.parse(readFileSync(database, 'utf8')) : [];
const save = () => writeFileSync(database, JSON.stringify(threads));
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const error = (id, code = -32000) => process.stdout.write(JSON.stringify({ id, error: { code, message: 'fixture rejection' } }) + '\n');
let initialized = false;
createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line); appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(req) + '\n');
  const p = req.params ?? {};
  if (req.method === 'initialize') {
    if (mode === 'exit-init') { process.exit(0); }
    return reply(req.id, { userAgent: 'fixture/0.160.0' });
  }
  if (req.method === 'initialized') { initialized = true; return; }
  if (!initialized) return error(req.id);
  if (req.method === 'thread/start') {
    const thread = { id: `thread-${threads.length + 1}`, cwd: p.cwd, turns: [], status: { type: 'idle' } };
    threads.push(thread); save();
    const config = p.config;
    return reply(req.id, { thread, cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: {
      type: mode === 'bad-policy' ? 'dangerFullAccess' : p.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite',
      networkAccess: config['sandbox_workspace_write.network_access'],
      writableRoots: config['sandbox_workspace_write.writable_roots'],
      excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    } });
  }
  if (req.method === 'thread/list') return reply(req.id, { data: [...threads, { id: 'foreign', cwd: root, turns: [] }], nextCursor: 'next' });
  const thread = threads.find(t => t.id === p.threadId);
  if (!thread) return error(req.id);
  if (req.method === 'thread/read') return reply(req.id, { thread: mode === 'bad-binding' ? { ...thread, id: 'alien' } : mode === 'not-loaded' ? { ...thread, status: { type: 'notLoaded' } } : thread });
  if (req.method === 'turn/start') {
    if (mode === 'reject-start') return error(req.id, -32602);
    const turn = { id: `turn-${thread.turns.length + 1}`, status: 'inProgress', items: [{ type: 'userMessage', id: 'message', clientId: p.clientUserMessageId }] };
    thread.turns.push(turn); thread.status = { type: 'active' }; save();
    if (mode === 'lost-start') { process.exit(0); }
    if (mode === 'terminal-start') {
      turn.status = 'completed'; thread.status = { type: 'idle' };
      turn.items.push({ type: 'agentMessage', id: 'progress', text: 'Planning fixture.', phase: 'commentary' }, { type: 'agentMessage', id: 'answer', text: 'Final fixture.', phase: 'final_answer' });
      save();
    }
    if (mode === 'slow-start') return setTimeout(() => reply(req.id, { turn }), 75);
    return reply(req.id, { turn });
  }
  const turn = thread.turns.at(-1);
  if (req.method === 'turn/steer') {
    if (!turn || turn.id !== p.expectedTurnId || turn.status !== 'inProgress') return error(req.id);
    turn.items.push({ type: 'userMessage', id: 'steer', clientId: p.clientUserMessageId }); save();
    return reply(req.id, { turnId: turn.id });
  }
  if (req.method === 'turn/interrupt') {
    if (!turn || turn.id !== p.turnId) return error(req.id);
    if (mode === 'never-terminal') return reply(req.id, {});
    turn.status = 'interrupted'; thread.status = { type: 'idle' };
    turn.items.push({ type: 'agentMessage', id: 'answer', text: 'Stopped fixture.' });
    const artifact = path.join(root, 'output.txt'); writeFileSync(artifact, 'bounded fixture artifact');
    turn.items.push({ type: 'fileChange', id: 'change', status: 'completed', changes: [{ path: artifact }, { path: process.env.FIXTURE_OUTSIDE }] });
    save(); return reply(req.id, {});
  }
  error(req.id, -32601);
});
