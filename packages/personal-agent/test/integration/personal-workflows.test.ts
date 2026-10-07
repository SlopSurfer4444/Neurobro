import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createPersonalWorkflows, encryptedJobStore } from '../../src/app.ts';
import { PersonalHost } from '../../src/host.ts';
import { TdlibTelegram, FileTelegramStore, TdRequestError, type TdJsonTransport, type TdObject } from '../../src/telegram/index.ts';
import { createScheduleServer, type ScheduleManifest } from '../../src/hermes/schedules.ts';
import { admitNativeSkill, revokeNativeSkill, type NativeSkillDescriptor } from '../../src/hermes/cognition.ts';
import type { PersonalConfig } from '../../src/config.ts';
import type { EngineInput, EnginePort, Json, RunSnapshot, ToolContext } from '../../src/contracts.ts';

test('application factory: private integration checks fresh owner edits before reads and after awaited tool result', async () => {
  const f=await fixture(false,true);
  try {
    const initial=await f.owner('List my saved resumes'), taskId=initial.result.taskId!, token=f.token(taskId);
    f.rpc.put(message('1',initial.observation.ref.messageId,'Stop, do not read my documents',true));
    const before=await f.workflows.registry.invoke(token,{name:'documents.list',args:{}});
    assert.equal(before.ok,false,'unconsumed owner edit must invalidate the old request');
    const next=await f.owner('Show my saved document list'), nextToken=f.token(next.result.taskId!);
    const library=f.workflows.library!, read=library.list.bind(library);
    let invoked=false;
    library.list=owner=>{invoked=true;const result=read(owner);f.rpc.put(message('1',next.observation.ref.messageId,'Cancel this request',true));return result;};
    const after=await f.workflows.registry.invoke(nextToken,{name:'documents.list',args:{}});
    assert.equal(invoked,true);assert.equal(after.ok,false,'changed owner instruction during the read prevents result exposure');
    assert.equal(after.value,undefined);
  } finally {await f.close();}
});

const sourcePeer = '-100123';
function message(peer: string, id: string, text: string, outgoing = false, replyTo?: string): TdObject {
  return { '@type': 'message', id, chat_id: peer, sender_id: { '@type': 'messageSenderUser', user_id: outgoing ? '1' : '42' },
    is_outgoing: outgoing, date: Math.floor(Date.now() / 1000), edit_date: 0, can_be_saved: true,
    content: { '@type': 'messageText', text: { '@type': 'formattedText', text, entities: [] } },
    ...(replyTo ? { reply_to: { '@type': 'messageReplyToMessage', chat_id: peer, message_id: replyTo } } : {}) };
}

/** Only native RPCs cross the fixture boundary: normalization, receipts and readback are real. */
class TelegramRPC extends EventEmitter implements TdJsonTransport {
  messages = new Map<string, TdObject>();
  requests: TdObject[] = [];
  sends: TdObject[] = [];
  stagedBytes: Buffer[] = [];
  folders = new Map<number, TdObject>();
  accountChats = new Map<string, TdObject>();
  accountUsers = new Map<string, TdObject>();
  accountSupergroups = new Map<string, TdObject>();
  accountBasicGroups = new Map<string, TdObject>();
  loseResponseFor = new Set<string>();
  publicPeers = new Map<string, string>();
  pendingTextSends = 0;
  pendingDocumentSends = 0;
  delayedSends = new Map<string, TdObject>();
  next = 1000;
  put(value: TdObject) { this.messages.set(`${value.chat_id}/${value.id}`, value); }
  completePendingSends() {
    for (const [temporaryId, value] of this.delayedSends) {
      this.put(value); this.emit('update', { '@type': 'updateMessageSendSucceeded', old_message_id: temporaryId, message: value });
      this.delayedSends.delete(temporaryId);
    }
  }
  async invoke(request: TdObject): Promise<TdObject> {
    this.requests.push(structuredClone(request));
    switch (request['@type']) {
      case 'getMe': return { '@type': 'user', id: '1', first_name: 'Owner' };
      case 'loadChats': throw new TdRequestError('All fixture account chats are loaded', true, 404);
      case 'searchPublicChat': return { '@type': 'chat', id: this.publicPeers.get(request.username) ?? (request.username === 'source' ? sourcePeer : '-100999') };
      case 'getChat': return this.accountChats.get(String(request.chat_id)) ?? (String(request.chat_id).startsWith('-')
        ? { '@type': 'chat', id: String(request.chat_id), title: 'Exact source', type: { '@type': 'chatTypeSupergroup', supergroup_id: '123', is_channel: true } }
        : { '@type': 'chat', id: String(request.chat_id), title: `Recipient ${request.chat_id}`, type: { '@type': 'chatTypePrivate', user_id: String(request.chat_id) } });
      case 'getUser': return this.accountUsers.get(String(request.user_id)) ?? { '@type': 'user', id: String(request.user_id), have_access: true, type: { '@type': 'userTypeRegular' }, usernames: { active_usernames: [`recipient${request.user_id}`] } };
      case 'getSupergroup': return this.accountSupergroups.get(String(request.supergroup_id)) ?? { '@type': 'supergroup', id: '123', is_channel: true, usernames: { active_usernames: ['source'] } };
      case 'getBasicGroup': return this.accountBasicGroups.get(String(request.basic_group_id)) ?? { '@type': 'error', code: 404, message: 'Not found' };
      case 'getSupergroupFullInfo': return { '@type': 'supergroupFullInfo', description: 'Software jobs; https://t.me/source', linked_chat_id: '0' };
      case 'getInternalLink': return { '@type': 'httpUrl', url: `https://t.me/${request.type.chat_username}` };
      case 'getCurrentState': return { '@type': 'updates', updates: [
        ...[...this.accountUsers.values()].map(user => ({ '@type': 'updateUser', user })),
        ...[...this.accountSupergroups.values()].map(supergroup => ({ '@type': 'updateSupergroup', supergroup })),
        ...[...this.accountBasicGroups.values()].map(basic_group => ({ '@type': 'updateBasicGroup', basic_group })),
        ...[...this.accountChats.values()].map(chat => ({ '@type': 'updateNewChat', chat })),
        { '@type': 'updateChatFolders', chat_folders: [...this.folders].map(([id, folder]) => ({ '@type': 'chatFolderInfo', id, name: folder.name, is_shareable: false })) },
      ] };
      case 'getChatFolder': return this.folders.get(request.chat_folder_id) ?? { '@type': 'error', code: 404, message: 'Not found' };
      case 'createChatFolder': { const id = this.folders.size + 1; this.folders.set(id, structuredClone(request.folder)); return { '@type': 'chatFolderInfo', id, name: request.folder.name, is_shareable: false }; }
      case 'editChatFolder': this.folders.set(request.chat_folder_id, structuredClone(request.folder)); return { '@type': 'chatFolderInfo', id: request.chat_folder_id, name: request.folder.name, is_shareable: false };
      case 'getMessage': return this.messages.get(`${request.chat_id}/${request.message_id}`) ?? { '@type': 'error', code: 404, message: 'Not found' };
      case 'getChatHistory': {
        const before = BigInt(request.from_message_id);
        return { '@type': 'messages', messages: [...this.messages.values()].filter(m => String(m.chat_id) === String(request.chat_id) && (!before || BigInt(m.id) <= before))
          .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, request.limit) };
      }
      case 'editMessageText': {
        const current = this.messages.get(`${request.chat_id}/${request.message_id}`);
        if (!current) return { '@type': 'error', code: 404, message: 'Not found' };
        const updated = { ...current, edit_date: Math.floor(Date.now() / 1000),
          content: { '@type': 'messageText', text: structuredClone(request.input_message_content.text) } };
        this.put(updated); return updated;
      }
      case 'sendMessage': {
        this.sends.push(structuredClone(request));
        const input = request.input_message_content;
        const value = message(String(request.chat_id), String(this.next++), input.text?.text ?? '', true);
        value.reply_to = request.reply_to;
        if (input['@type'] === 'inputMessageDocument') {
          const bytes = await readFile(input.document.document.path); this.stagedBytes.push(bytes);
          value.content = { '@type': 'messageDocument', caption: input.caption,
            document: { file_name: basename(input.document.document.path), mime_type: 'text/csv', document: { id: '901', size: bytes.length } } };
        }
        if (input['@type'] === 'inputMessageText' && this.pendingTextSends > 0 || input['@type'] === 'inputMessageDocument' && this.pendingDocumentSends > 0) {
          if (input['@type'] === 'inputMessageText') this.pendingTextSends--; else this.pendingDocumentSends--;
          const temporaryId = '-' + value.id; this.delayedSends.set(temporaryId, value);
          const pending = { ...value, id: temporaryId, sending_state: { '@type': 'messageSendingStatePending', sending_id: request.options.sending_id } };
          this.put(pending); return pending;
        }
        this.put(value);
        if (this.loseResponseFor.has(String(request.chat_id))) throw new Error('Fixture lost response after native send acceptance');
        return value;
      }
      default: throw new Error(`Unexpected external RPC ${request['@type']}`);
    }
  }
  async close() {}
}

async function fixture(withSkills = false, personalFeatures = false) {
  const directory = await mkdtemp(join(tmpdir(), 'neurobro-workflows-')), key = Buffer.alloc(32, 21), rpc = new TelegramRPC();
  const telegramStore = new FileTelegramStore(join(directory, 'telegram'), key);
  let telegram = new TdlibTelegram({ accountId: '1', transport: rpc, receipts: telegramStore, spool: telegramStore });
  const admissions: EngineInput[] = [], runs = new Map<string, RunSnapshot>();
  const engine: EnginePort = {
    async capabilities() { return { durable: true, sessions: true, cancel: true, steer: false }; },
    async submit(input) {
      admissions.push(structuredClone(input)); const runId = `fixture-run-${admissions.length}`;
      const run: RunSnapshot = { binding: { taskId: input.taskId, intentRevision: input.intentRevision, idempotencyKey: input.idempotencyKey, runId, sessionId: `session-${runId}` }, state: 'running', observedAt: new Date().toISOString() };
      runs.set(runId, run); return structuredClone(run);
    },
    async inspect(binding) { return structuredClone(runs.get(binding.runId)!); },
    async cancel(binding) { const run = runs.get(binding.runId)!; run.state = 'cancelled'; return structuredClone(run); },
  };
  const registrationKey = 'fixture-host-registration-key-'.repeat(3);
  const jobs = new Map<string, { id: string; key: string; state: string; schedule_context: string; instruction: string }>();
  const cronCalls: { path: string; body: any }[] = [];
  const manifests = new Map<string, ScheduleManifest>();
  const native = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${registrationKey}`);
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, path = request.url!; cronCalls.push({ path, body });
    let value: unknown = { ok: true };
    if (path === '/cron/jobs') {
      let job = jobs.get(body.key);
      if (!job) { job = { ...body, id: `native-job-${jobs.size + 1}`, state: 'active' }; jobs.set(body.key, job!); }
      value = { ok: true, job };
    } else if (path === '/cron/bindings') value = { ok: true };
    else if (path.startsWith('/cron/results/')) value = { ok: true, manifest: manifests.get(path.slice('/cron/results/'.length)) };
    else {
      const job = [...jobs.values()].find(item => item.id === path.split('/')[3]);
      if (!job) { response.writeHead(404); response.end(JSON.stringify({ ok: false })); return; }
      if (path.endsWith('/cancel')) job.state = 'cancelled';
      if (path.endsWith('/pause')) job.state = 'paused';
      if (path.endsWith('/resume')) job.state = 'active';
      value = { ok: true, job };
    }
    // Native Python management uses HTTP/1.0 connections, not Node's default
    // five-second idle keepalive. Mirror that transport across CPU-heavy tests.
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); response.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve));
  const nativeUrl = `http://127.0.0.1:${(native.address() as { port: number }).port}`;
  const config: PersonalConfig = { schemaVersion: 1, stateDirectory: directory,
    account: { id: '1', ownerId: '1', controlPeerId: '1' }, encryptionKeyEnv: 'NOT_READ',
    hermes: { baseUrl: nativeUrl, apiKeyEnv: 'NOT_READ', cronUrl: nativeUrl },
    telegram: { command: 'NOT_LAUNCHED', args: [], databaseDirectory: join(directory, 'td'), filesDirectory: join(directory, 'files'), apiIdEnv: 'NOT_READ', apiHashEnv: 'NOT_READ' },
    ...(personalFeatures ? { documents: { enabled: true }, ownerTelegram: { readAllChats: true, manageFolders: true, joinPublicChats: true }, github: { owner: 'fixture-owner' },
      desktopContext: { enabled: true, codexHome: join(directory, 'saved-codex'), ownerId: '1', scope: { allOwnerThreads: true as const } } } : {}) };
  let workflows: ReturnType<typeof createPersonalWorkflows>;
  const createHost = () => new PersonalHost({ config, encryptionKey: key, telegram, engine,
    onFinalDelivery: ({ taskId, runId, effects }) => workflows.replies.acknowledgeDelivered(taskId, runId, effects.map(effect => effect.id)),
    isPrivateMonitorExecution: context => workflows?.monitors?.isMonitorExecution(context) === true,
    onOwnerControlEvent: (event, context) => workflows.onOwnerControlEvent(event, context) });
  let host = createHost();
  const nativeSkill: NativeSkillDescriptor = { id: 'installed-notes', nativeName: 'notes', sha256: 'a'.repeat(64), ownerId: '1', accountId: '1', scope: 'global', sourceRefs: [], state: 'approved' };
  if (withSkills) admitNativeSkill(host.agent.store, nativeSkill);
  const compose = () => createPersonalWorkflows({ host, config, telegram, hermesHome: join(directory, 'hermes'), jobs: encryptedJobStore(host), nativeSchedules: { baseUrl: nativeUrl, registrationKey },
    ...(withSkills ? { nativeCognition: { resolveSession: (context: ToolContext) => {
      const status = host.agent.status(context.taskId)!; assert.equal(status.run!.binding.runId, context.runId); return `original-${context.runId}`;
    }, native: { async read(input: any) { assert.match(input.session_id, /^original-fixture-run-/); assert.deepEqual(input.descriptors, [nativeSkill]); return input.operation === 'list' ? { skills: input.descriptors } : { skill: nativeSkill, content: '---\nname: Notes\ndescription: Installed knowledge\n---\nKeep useful notes.' }; } } } } : {}) });
  workflows = compose();
  const scheduleServer = await createScheduleServer(workflows.schedules!);
  async function owner(text: string, replyTo?: string) {
    // Native message IDs order both owner messages and agent sends in the same room.
    const id = String(rpc.next++); rpc.put(message('1', id, text, true, replyTo));
    const observation = await telegram.getMessage({ accountId: '1', peerId: '1', messageId: id }); assert.ok(observation);
    const result = await host.ingest(observation); await workflows.syncOwnerPolicies(); return { result, observation };
  }
  async function call(token: string, name: string, args: Record<string, Json> = {}): Promise<any> {
    const result = await workflows.registry.invoke(token, { name, args }); assert.equal(result.ok, true, `${name}: ${result.error}`); return result.value;
  }
  async function admit(job: { id: string; schedule_context: string }, executionId: string) {
    const response = await fetch(`${scheduleServer.address}/schedules/admit`, { method: 'POST', headers: { Authorization: `Bearer ${job.schedule_context}`, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ job_id: job.id, execution_id: executionId, task_id: `cron:${job.id}:${executionId}` }) });
    return { status: response.status, body: await response.json() as { ok: boolean; tool_context?: string } };
  }
  async function complete(job: { id: string; schedule_context: string }, executionId: string, outcome: ScheduleManifest['outcome'] = 'completed') {
    const manifest: ScheduleManifest = { job_id: job.id, execution_id: executionId, task_id: `cron:${job.id}:${executionId}`, outcome, output_file: null, output_sha256: null };
    manifests.set(`${job.id}/${executionId}`, manifest);
    const response = await fetch(`${scheduleServer.address}/schedules/complete`, { method: 'POST', headers: { Authorization: `Bearer ${job.schedule_context}`, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(manifest) });
    return { status: response.status, body: await response.json() as { ok: boolean; replayed?: boolean; callback?: string } };
  }
  function currentContext(taskId: string): ToolContext {
    const status = host.agent.status(taskId)!; const grant = host.agent.store.get<{ revision: number }>('grants', status.intent.grantId)!;
    return { taskId, intentRevision: status.intent.revision, grantId: status.intent.grantId, grantRevision: grant.revision, runId: status.run!.binding.runId };
  }
  return { directory, rpc, get telegram() { return telegram; }, get host() { return host; }, get workflows() { return workflows; }, admissions, runs, jobs, cronCalls, owner, call, admit, complete, currentContext,
    async reopen() {
      workflows.dispose(); await host.close(); await telegram.close();
      const receipts = new FileTelegramStore(join(directory, 'telegram'), key);
      telegram = new TdlibTelegram({ accountId: '1', transport: rpc, receipts, spool: receipts });
      host = createHost(); workflows = compose(); await host.agent.start(); await workflows.syncOwnerPolicies();
    },
    token: (taskId: string) => admissions.findLast(input => input.taskId === taskId)!.toolContext!,
    async close() { await scheduleServer.close(); await telegram.close(); workflows.dispose(); await host.close(); native.closeAllConnections(); await new Promise<void>(resolve => native.close(() => resolve()));
      assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'neurobro-workflows-')))); await rm(directory, { recursive: true, force: true }); } };
}

test('application factory: native installed skill read records exact lineage and revocation fences old execution', async () => {
  const f = await fixture(true); try {
    const { result } = await f.owner('Read the approved notes skill.'); const taskId = result.taskId!, token = f.token(taskId);
    const value = await f.call(token, 'learning.skills.view', { skillId: 'installed-notes' }); assert.match(value.content, /Keep useful notes/);
    const manifest = f.host.getExecutionContext(f.currentContext(taskId)).manifest as any;
    assert.equal(manifest.skillRefs[0].id, 'installed-notes'); assert.equal(manifest.skillRefs[0].origin, 'operator-installed');
    assert.deepEqual(manifest.skillRefs[0].sourceRefs, []); assert.equal(manifest.skillRefs[0].sha256, 'a'.repeat(64));
    revokeNativeSkill(f.host.agent.store, 'installed-notes');
    const denied = await f.workflows.registry.invoke(token, { name: 'learning.skills.view', args: { skillId: 'installed-notes' } }); assert.equal(denied.ok, false);
    assert.throws(() => f.host.getExecutionContext(f.currentContext(taskId)), /invalid|refresh/i);
  } finally { await f.close(); }
});

test('application factory: owner-authorized monitor uses native admission, semantic private effects and quiet revoked reads', async () => {
  const f = await fixture(); try {
    f.rpc.put(message(sourcePeer, '1', 'Existing vacancy before owner subscription'));
    const { result } = await f.owner('watch @source'); assert.equal(result.disposition, 'accepted'); const taskId = result.taskId!, token = f.token(taskId);
    assert.deepEqual(f.host.getMonitorPolicies(taskId).map(policy => policy.sourcePeerId), [sourcePeer]);
    assert.equal((await f.workflows.registry.invoke(token, { name: 'telegram.history', args: { peerId: '-100999' } })).ok, false);
    const spec = { key: 'remote-engineering', name: 'Remote engineering', sources: [{ id: 'source', kind: 'telegram', resource: sourcePeer }], criteria: 'Remote software engineering employment; exclude training courses and onsite sales', schedule: '*/5 * * * *', deliveryMode: 'alerts' };
    const sub = await f.call(token, 'monitors.subscribe', spec); assert.equal(sub.state, 'active'); assert.equal(f.jobs.size, 1);
    assert.equal(f.host.agent.store.list<any>('effects').filter(effect => String(effect.payload.text ?? '').startsWith('Новый материал:')).length, 0);
    assert.deepEqual(await f.call(token, 'monitors.subscribe', spec), sub); assert.equal(f.cronCalls.filter(call => call.path === '/cron/jobs').length, 1);
    const job = [...f.jobs.values()][0]!; assert.match(job.instruction, /context.current/); assert.match(job.instruction, /semantically/);
    const admitted = await f.admit(job, 'execution-1'); assert.equal(admitted.status, 200); assert.ok(admitted.body.tool_context);
    const cronToken = admitted.body.tool_context!;
    const context = await f.call(cronToken, 'context.current'); assert.match(context.text, /watch @source/);
    const beforeInjection = f.rpc.sends.length;
    const injection = await f.workflows.registry.invoke(cronToken, { name: 'telegram.send', args: { peerId: '1', text: 'Unreviewed monitor output' } });
    assert.equal(injection.ok, false); assert.equal(f.rpc.sends.length, beforeInjection);
    f.rpc.put(message(sourcePeer, '2', 'Distributed server-side JavaScript team hiring across time zones; work from anywhere.'));
    f.rpc.put(message(sourcePeer, '3', 'Remote Node.js bootcamp course; enroll now.'));
    const gathered = await f.call(cronToken, 'monitors.collect', { subscriptionId: sub.id });
    assert.equal(gathered.candidates.length, 2); assert.equal(gathered.criteria, spec.criteria); assert.equal(f.rpc.sends.length, beforeInjection);
    const decisions = gathered.candidates.map((candidate: any) => ({ candidateId: candidate.id, match: candidate.alert.itemId === '2', reason: candidate.alert.itemId === '2' ? 'Remote engineering employment fits the meaning' : 'Training is not employment' }));
    await f.call(cronToken, 'monitors.decide', { subscriptionId: sub.id, decisions });
    const alerts = f.host.agent.store.list<any>('effects').filter(effect => String(effect.payload.text ?? '').startsWith('Новый материал:'));
    assert.equal(alerts.length, 1); assert.equal(alerts[0].state, 'verified'); assert.equal(alerts[0].resource, '1'); assert.match(alerts[0].payload.text, /work from anywhere/);
    await f.call(cronToken, 'monitors.decide', { subscriptionId: sub.id, decisions });
    const sendCount = f.rpc.sends.length; assert.equal((await f.call(cronToken, 'monitors.collect', { subscriptionId: sub.id })).pending, 0); assert.equal(f.rpc.sends.length, sendCount);
    await f.owner('unsubscribe @source'); assert.equal(job.state, 'cancelled'); assert.deepEqual(f.host.getMonitorPolicies(taskId), []);
    const historyCount = f.rpc.requests.filter(request => request['@type'] === 'getChatHistory').length;
    assert.equal((await f.workflows.registry.invoke(cronToken, { name: 'telegram.history', args: { peerId: sourcePeer } })).ok, false);
    assert.equal((await f.workflows.registry.invoke(cronToken, { name: 'monitors.collect', args: { subscriptionId: sub.id } })).ok, false);
    assert.equal(f.rpc.requests.filter(request => request['@type'] === 'getChatHistory').length, historyCount);
    assert.equal((await f.admit(job, 'execution-after-unsubscribe')).status, 403);
    const bytes = await readFile(join(f.directory, 'broker.sqlite')); assert.equal(bytes.includes(Buffer.from('work from anywhere')), false);
  } finally { await f.close(); }
});

test('application factory: exact private outreach card admits selected payloads and never replays UNKNOWN', async () => {
  const f = await fixture(); try {
    const { result } = await f.owner('Prepare two exact recipient drafts for my approval.'); assert.equal(result.disposition, 'accepted'); const taskId = result.taskId!, token = f.token(taskId);
    const draft = await f.call(token, 'outreach.propose', { name: 'Exact employment outreach', recipients: [
      { id: 'selected', route: { peerId: '42' }, text: 'Approved exact first payload' },
      { id: 'excluded', route: { peerId: '43' }, text: 'Never selected second payload' },
    ] });
    assert.equal(f.rpc.sends.some(request => ['42', '43'].includes(String(request.chat_id))), false);
    const proposal = await f.call(token, 'outreach.request_approval', { batchId: draft.batch.id, expectedRevision: 1 });
    const saved = f.workflows.ownerControls.proposal(proposal.id); assert.ok(saved.cardRef);
    const card = f.rpc.messages.get(`1/${saved.cardRef.messageId}`)!; assert.match(card.content.text.text, /Approved exact first payload/); assert.match(card.content.text.text, /Never selected second payload/);
    const reviewed = JSON.parse(card.content.text.text.slice(card.content.text.text.indexOf('{'), card.content.text.text.indexOf('\n\nОтветь')));
    assert.equal(reviewed.manifestHash, draft.manifest.manifestHash);
    assert.deepEqual(reviewed.recipients.map((recipient: any) => ({ id: recipient.id, route: recipient.route, text: recipient.text, destination: recipient.destination })), [
      { id: 'selected', route: { peerId: '42' }, text: 'Approved exact first payload', destination: { title: 'Recipient 42', kind: 'user', username: 'recipient42' } },
      { id: 'excluded', route: { peerId: '43' }, text: 'Never selected second payload', destination: { title: 'Recipient 43', kind: 'user', username: 'recipient43' } },
    ]);
    const forged = await f.workflows.registry.invoke(token, { name: 'telegram.send', args: { peerId: '42', text: 'Forged preapproval' } }); assert.equal(forged.ok, false);
    const approval = await f.owner('да только selected', saved.cardRef.messageId); assert.equal(approval.result.disposition, 'status');
    assert.deepEqual(f.rpc.sends.filter(request => String(request.chat_id) === '42').map(request => request.input_message_content.text.text), ['Approved exact first payload']);
    assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '43').length, 0);
    const freshToken = f.host.agent.issueExecutionContext(f.currentContext(taskId));
    await assert.rejects(f.host.agent.executeEffect(freshToken, { id: `outreach:${draft.batch.id}:revision:1:recipient:selected`, capability: 'telegram.send', resource: '42', payload: { peerId: '42', text: 'Changed after approval' } }), /payload|selected/);
    const status = await f.call(freshToken, 'outreach.inspect', { batchId: draft.batch.id }); assert.equal(status.counts.verified, 1); assert.equal(status.counts.unselected, 1);
    await f.call(freshToken, 'outreach.send', { batchId: draft.batch.id }); assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '42').length, 1);
    const unknownDraft = await f.call(freshToken, 'outreach.propose', { name: 'Lost response fixture', recipients: [
      { id: 'uncertain', route: { peerId: '44' }, text: 'Payload accepted but acknowledgement lost' },
      { id: 'remaining', route: { peerId: '45' }, text: 'Selected remaining payload requires explicit continuation' },
    ] });
    const unknownProposal = await f.call(freshToken, 'outreach.request_approval', { batchId: unknownDraft.batch.id, expectedRevision: 1 });
    f.rpc.loseResponseFor.add('44'); const unknownCard = f.workflows.ownerControls.proposal(unknownProposal.id).cardRef!;
    const unknownApproval = await f.owner('да только uncertain,remaining', unknownCard.messageId);
    assert.match(unknownApproval.result.reason!, /требует сверки/);
    assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '44').length, 1);
    assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '45').length, 0);
    const unknownReceipt = f.workflows.ownerControls.proposal(unknownProposal.id).receiptId!;
    const callback = f.host.agent.store.get<{ state: string }>('workflowOwnerApprovals', unknownReceipt)!;
    assert.ok(callback); assert.equal(callback.state, 'unknown');
    const currentToken = f.host.agent.issueExecutionContext(f.currentContext(taskId));
    const uncertain = await f.call(currentToken, 'outreach.inspect', { batchId: unknownDraft.batch.id }); assert.equal(uncertain.counts.unknown, 1); assert.equal(uncertain.counts.pending, 1);
    const uncertainEffect = f.host.agent.store.list<any>('effects').find(effect => effect.resource === '44')!; assert.equal(uncertainEffect.state, 'unknown');
    const replay = await f.host.ingest(unknownApproval.observation); assert.equal(replay.disposition, 'status'); assert.match(replay.reason!, /требует сверки/);
    assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '44').length, 1); assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '45').length, 0);
    // A direct trusted callback replay also refuses the durable UNKNOWN reservation.
    await assert.rejects(f.workflows.onOwnerControlEvent({ disposition: 'accepted', proposal: f.workflows.ownerControls.proposal(unknownProposal.id), receipt: f.host.agent.store.get<any>('ownerApprovalReceipts', unknownReceipt)! }, f.currentContext(taskId)), /reconciliation|replay/);
    assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '45').length, 0);
    await f.call(currentToken, 'outreach.send', { batchId: unknownDraft.batch.id }); await f.call(currentToken, 'outreach.send', { batchId: unknownDraft.batch.id });
    assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '44').length, 1);
    assert.deepEqual(f.rpc.sends.filter(request => String(request.chat_id) === '45').map(request => request.input_message_content.text.text), ['Selected remaining payload requires explicit continuation']);
    assert.equal(f.host.agent.store.list<any>('effects').filter(effect => effect.resource === '44').length, 1);
  } finally { await f.close(); }
});

test('application factory: approved exact text and file reach employer; replies cross tasks privately and do not authorize continuation', async () => {
  const f = await fixture(); try {
    const initial = await f.owner('Prepare an employer message with my attachment.'), taskId = initial.result.taskId!, token = f.token(taskId);
    const artifact = await f.call(token, 'artifact.create', { name: 'portfolio.csv', format: 'csv', columns: ['project'], rows: [['Personal assistant']] });
    const draft = await f.call(token, 'outreach.propose', { name: 'Employer contact', recipients: [
      { id: 'employer', route: { peerId: '42' }, text: 'Здравствуйте! Присылаю мой проект.', attachments: [{ artifactId: artifact.id, profile: 'file' }] },
    ] });
    const proposal = await f.call(token, 'outreach.request_approval', { batchId: draft.batch.id, expectedRevision: 1 });
    const card = f.workflows.ownerControls.proposal(proposal.id).cardRef!;
    const visibleCard = f.rpc.messages.get(`1/${card.messageId}`)!.content.text.text;
    assert.ok(visibleCard.includes('portfolio.csv')); assert.ok(visibleCard.includes(draft.manifest.recipients[0].attachments[0].sha256));
    await f.owner('да', card.messageId);
    const employerSends = f.rpc.sends.filter(request => String(request.chat_id) === '42');
    assert.equal(employerSends.length, 2);
    assert.equal(employerSends[0]!.input_message_content.text.text, 'Здравствуйте! Присылаю мой проект.');
    assert.equal(employerSends[1]!.input_message_content['@type'], 'inputMessageDocument');
    assert.ok(f.rpc.stagedBytes.at(-1)!.toString().includes('Personal assistant'));
    const outbound = [...f.rpc.messages.values()].find(item => String(item.chat_id) === '42' && item.content['@type'] === 'messageText')!;
    const incoming = message('42', '9000', 'Здравствуйте! Давайте созвонимся завтра.', false, String(outbound.id));
    incoming.date += 2; f.rpc.put(incoming);
    const observation = (await f.telegram.getMessage({ accountId: '1', peerId: '42', messageId: '9000' }))!;
    const runsBefore = f.admissions.length; assert.equal(await f.workflows.replies.recordObservation(observation), true);
    assert.equal(f.admissions.length, runsBefore); assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '42').length, 2);
    const check = await f.owner('Какие новые ответы от работодателей?'), checkId = check.result.taskId!, checkToken = f.token(checkId);
    const digest = await f.call(checkToken, 'outreach.replies'); assert.equal(digest.replies.length, 1);
    assert.equal(digest.replies[0].text, incoming.content.text.text); assert.equal(digest.replies[0].attribution, 'exact-reply');
    const denial = await f.workflows.registry.invoke(checkToken, { name: 'telegram.send', args: { peerId: '42', text: 'Unapproved continuation' } });
    assert.equal(denial.ok, false);
    const run = f.host.agent.status(checkId)!.run!;
    f.runs.set(run.binding.runId, { ...run, state: 'completed', output: 'Получен ответ: Здравствуйте! Давайте созвонимся завтра.' });
    await f.host.pollLifecycle();
    const next = await f.owner('А теперь есть новые ответы?');
    const nextDigest = await f.call(f.token(next.result.taskId!), 'outreach.replies'); assert.equal(nextDigest.replies.length, 0);
    assert.equal(f.rpc.sends.filter(request => String(request.chat_id) === '42').length, 2);
  } finally { await f.close(); }
});

test('application factory: owner task cancellation withdraws native monitor and existing execution authority', async () => {
  const f = await fixture(); try {
    f.rpc.put(message(sourcePeer, '1', 'Baseline'));
    const { result } = await f.owner('watch @source'); const taskId = result.taskId!, token = f.token(taskId);
    const sub = await f.call(token, 'monitors.subscribe', { key: 'cancelled-monitor', name: 'Cancel fixture', sources: [{ id: 'source', kind: 'telegram', resource: sourcePeer }], criteria: 'Software employment', schedule: '*/5 * * * *' });
    const job = [...f.jobs.values()][0]!, admitted = await f.admit(job, 'execution-before-cancel'); assert.equal(admitted.status, 200);
    const cancellation = await f.owner(`cancel #${taskId}`); assert.equal(cancellation.result.disposition, 'cancelled'); assert.equal(f.host.agent.status(taskId)!.state, 'cancelled');
    assert.equal(job.state, 'cancelled'); assert.equal(f.admissions.length, 1);
    assert.equal((await f.admit(job, 'execution-after-cancel')).status, 403);
    const reads = f.rpc.requests.filter(request => request['@type'] === 'getChatHistory').length;
    assert.equal((await f.workflows.registry.invoke(admitted.body.tool_context!, { name: 'monitors.collect', args: { subscriptionId: sub.id } })).ok, false);
    assert.equal((await f.workflows.registry.invoke(token, { name: 'telegram.history', args: { peerId: sourcePeer } })).ok, false);
    assert.equal(f.rpc.requests.filter(request => request['@type'] === 'getChatHistory').length, reads);
  } finally { await f.close(); }
});

test('application factory: approved public-origin monitor preserves foreground route while cron alerts only privately', async () => {
  const f = await fixture(); try {
    const origin = '-20'; f.rpc.put(message(sourcePeer, '1', 'Existing baseline'));
    f.rpc.put(message(origin, '100', '/бро --here Monitor software vacancies from @source and alert me privately.', true));
    const observation = await f.telegram.getMessage({ accountId: '1', peerId: origin, messageId: '100' }); assert.ok(observation);
    const admittedTask = await f.host.ingest(observation); assert.equal(admittedTask.disposition, 'accepted'); const taskId = admittedTask.taskId!, token = f.token(taskId);
    assert.equal(f.host.agent.status(taskId)!.intent.route.peerId, origin);
    const proposal = await f.call(token, 'owner.sources.propose', { selectors: ['@source'], monitor: true, title: 'Private vacancy monitor' });
    assert.deepEqual(f.host.getMonitorPolicies(taskId), []);
    const card = f.workflows.ownerControls.proposal(proposal.proposalId).cardRef!; assert.equal(card.peerId, '1');
    const approval = await f.owner('да', card.messageId); assert.equal(approval.result.disposition, 'status');
    assert.deepEqual(f.host.getMonitorPolicies(taskId).map(policy => policy.sourcePeerId), [sourcePeer]);
    assert.equal(f.host.agent.status(taskId)!.intent.route.peerId, origin, 'Source approval cannot rewrite the foreground route');
    const current = f.token(taskId);
    const sub = await f.call(current, 'monitors.subscribe', { key: 'public-origin', name: 'Public origin, private monitor', sources: [{ id: 'source', kind: 'telegram', resource: sourcePeer }], criteria: 'Software engineering employment', schedule: '*/5 * * * *', deliveryMode: 'alerts' });
    const deadline = f.host.agent.store.get<{ taskId: string; peerId: string; expiresAt: string }>('originDeadlines', taskId)!; assert.equal(deadline.peerId, origin);
    f.host.agent.store.put('originDeadlines', taskId, { ...deadline, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const standingGrant = f.host.agent.store.get<{ expiresAt?: string }>('grants', f.host.agent.status(taskId)!.intent.grantId)!; assert.equal(standingGrant.expiresAt, undefined);
    const job = [...f.jobs.values()][0]!, execution = await f.admit(job, 'public-origin-execution'); assert.equal(execution.status, 200);
    const cron = execution.body.tool_context!, before = f.rpc.sends.length;
    const executionContext = await f.call(cron, 'context.current'); assert.match(executionContext.text, /маршрут 1;/); assert.match(executionContext.text, /публичное поручение не продлевает/);
    const direct = await f.workflows.registry.invoke(cron, { name: 'telegram.send', args: { peerId: origin, text: 'Unapproved public cron notification', replyToMessageId: '100' } });
    assert.equal(direct.ok, false); assert.equal(f.rpc.sends.length, before);
    f.rpc.put(message(sourcePeer, '2', 'Hiring a software engineer for a distributed team.'));
    const gathered = await f.call(cron, 'monitors.collect', { subscriptionId: sub.id }); assert.equal(gathered.candidates.length, 1);
    await f.call(cron, 'monitors.decide', { subscriptionId: sub.id, decisions: [{ candidateId: gathered.candidates[0].id, match: true, reason: 'An employment vacancy for software engineering' }] });
    assert.equal(f.rpc.sends.length, before + 1); assert.equal(String(f.rpc.sends.at(-1)!.chat_id), '1');
    assert.equal(f.host.agent.status(taskId)!.intent.route.peerId, origin);
    assert.equal(f.host.agent.status().length, 1, 'Monitoring remains bound to the original task');
  } finally { await f.close(); }
});

function addSourcePeers(rpc: TelegramRPC, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const username = `vacancy_source${index}`, peerId = `-100${7000 + index}`, supergroupId = String(7000 + index);
    rpc.publicPeers.set(username, peerId);
    rpc.accountChats.set(peerId, { '@type': 'chat', id: peerId, title: `Вакансии и работа в автоматизации — ${'подробное название источника '.repeat(3)}${index + 1}`,
      type: { '@type': 'chatTypeSupergroup', supergroup_id: supergroupId, is_channel: true } });
    rpc.accountSupergroups.set(supergroupId, { '@type': 'supergroup', id: supergroupId, is_channel: true, usernames: { active_usernames: [username] } });
    return { username, peerId };
  });
}

test('application factory: sixteen source proposal is a readable exact card without JSON upload or implicit approval', async () => {
  const f = await fixture(); try {
    const sources = addSourcePeers(f.rpc, 16), { result } = await f.owner('Подготовь предложение наблюдения за шестнадцатью источниками вакансий.');
    const before = f.rpc.sends.length, title = 'Источники вакансий: ' + 'Ищем вакансии по AI-автоматизации и агентским системам. '.repeat(5);
    const taskId = result.taskId!, proposal = await f.call(f.token(taskId), 'owner.sources.propose', {
      selectors: sources.map(source => '@' + source.username), monitor: true, title });
    const saved = f.workflows.ownerControls.proposal(proposal.proposalId);
    assert.ok(JSON.stringify({ title: saved.title, monitor: saved.monitor, sources: saved.sources }, null, 2).length > 3300, 'Old JSON presentation would require an upload');
    assert.equal(proposal.publication.state, 'verified'); assert.equal(proposal.publication.stage, 'card'); assert.ok(saved.cardRef);
    assert.equal(f.rpc.sends.length, before + 1); assert.equal(f.rpc.stagedBytes.length, 0);
    const text = f.rpc.messages.get(`1/${saved.cardRef!.messageId}`)!.content.text.text;
    assert.match(text, /Предлагаю наблюдать за источниками: 16/); assert.match(text, /Ответь на эту карточку/);
    assert.doesNotMatch(text, /"accountId"|"sources"|\.json|SHA256/);
    assert.ok(text.startsWith(title + '\n'), 'The full saved criteria/title is presented to the owner');
    for (const source of sources) { assert.ok(text.includes('@' + source.username)); assert.ok(saved.sources!.some(item => item.peerId === source.peerId)); }
    assert.doesNotMatch(text, /ID -100/);
    assert.ok(text.length <= 3300); assert.deepEqual(f.host.getMonitorPolicies(taskId), []); assert.equal(f.jobs.size, 0);
    await f.owner('Вижу'); assert.equal(f.workflows.ownerControls.proposal(saved.id).state, 'pending'); assert.deepEqual(f.host.getMonitorPolicies(taskId), []);
    await f.owner('да', saved.cardRef!.messageId);
    assert.equal(f.workflows.ownerControls.proposal(saved.id).state, 'accepted');
    assert.deepEqual(f.host.getMonitorPolicies(taskId).map(policy => policy.sourcePeerId).sort(), sources.map(source => source.peerId).sort());
    assert.equal(f.jobs.size, 0, 'Accepting source scope does not fabricate a native subscription');
  } finally { await f.close(); }
});

test('application factory: late verified proposal card is rebound during sync without another send', async () => {
  const f = await fixture(); try {
    const { result } = await f.owner('Propose a source monitor for approval.'), taskId = result.taskId!;
    const before = f.rpc.sends.length;
    f.rpc.pendingTextSends = 1;
    const proposal = await f.call(f.token(taskId), 'owner.sources.propose', { selectors: ['@source'], monitor: true });
    assert.equal(proposal.state, 'pending'); assert.equal(proposal.publication.state, 'unknown'); assert.equal(proposal.publication.stage, 'card');
    assert.equal(proposal.cardRef, undefined); assert.match(proposal.instruction, /not verified/); assert.equal(f.rpc.sends.length, before + 1);
    await f.host.agent.poll(); await f.workflows.syncOwnerPolicies();
    assert.equal(f.workflows.ownerControls.proposal(proposal.proposalId).cardRef, undefined); assert.equal(f.rpc.sends.length, before + 1);
    f.rpc.completePendingSends(); await f.host.agent.poll(); await f.workflows.syncOwnerPolicies();
    const saved = f.workflows.ownerControls.proposal(proposal.proposalId); assert.ok(saved.cardRef); assert.equal(saved.publication!.state, 'verified');
    const effect = f.host.agent.store.get<any>('effects', proposal.publication.card.effectId)!;
    assert.equal(effect.state, 'verified'); assert.equal(effect.receipt.messageId, saved.cardRef!.messageId);
    await f.workflows.syncOwnerPolicies(); assert.equal(f.rpc.sends.length, before + 1); assert.deepEqual(f.host.getMonitorPolicies(taskId), []);
    await f.owner('да', saved.cardRef!.messageId); assert.equal(f.workflows.ownerControls.proposal(saved.id).state, 'accepted');
  } finally { await f.close(); }
});

test('application factory: cold reopen reconciles and binds a legacy proposal card without replay', async () => {
  const f = await fixture(); try {
    const sources = addSourcePeers(f.rpc, 16), { result } = await f.owner('Propose sixteen exact sources.'), taskId = result.taskId!;
    const before = f.rpc.sends.length;
    f.rpc.pendingTextSends = 1;
    const proposal = await f.call(f.token(taskId), 'owner.sources.propose', { selectors: sources.map(source => '@' + source.username), monitor: true });
    const saved = f.workflows.ownerControls.proposal(proposal.proposalId), immutable = JSON.stringify({ id: saved.id, context: saved.context, sources: saved.sources });
    delete saved.publication; f.host.agent.store.put('ownerScopeProposals', saved.id, saved); // Existing installs have no publication links.
    f.rpc.completePendingSends();
    const originalEffect = f.host.agent.store.get<any>('effects', proposal.publication.card.effectId)!;
    assert.equal((await f.telegram.reconcile(originalEffect)).state, 'verified');
    await f.reopen();
    const recovered = f.workflows.ownerControls.proposal(saved.id);
    assert.equal(JSON.stringify({ id: recovered.id, context: recovered.context, sources: recovered.sources }), immutable);
    assert.ok(recovered.cardRef); assert.equal(recovered.publication!.state, 'verified'); assert.equal(f.rpc.sends.length, before + 1);
    await f.host.agent.poll(); await f.workflows.syncOwnerPolicies(); assert.equal(f.rpc.sends.length, before + 1);
    assert.equal(recovered.state, 'pending'); assert.deepEqual(f.host.getMonitorPolicies(taskId), []);
    await f.owner('да', recovered.cardRef!.messageId); assert.equal(f.workflows.ownerControls.proposal(saved.id).state, 'accepted');
  } finally { await f.close(); }
});

test('application factory: lost proposal send response remains a structured unknown with no resend or grant', async () => {
  const f = await fixture(); try {
    const { result } = await f.owner('Propose a source monitor.'), taskId = result.taskId!;
    const before = f.rpc.sends.length;
    f.rpc.loseResponseFor.add('1');
    const proposal = await f.call(f.token(taskId), 'owner.sources.propose', { selectors: ['@source'], monitor: true });
    assert.equal(proposal.state, 'pending'); assert.equal(proposal.publication.state, 'unknown'); assert.ok(proposal.proposalId);
    for (let index = 0; index < 2; index++) { await f.host.agent.poll(); await f.workflows.syncOwnerPolicies(); }
    const saved = f.workflows.ownerControls.proposal(proposal.proposalId);
    assert.equal(saved.publication!.state, 'unknown'); assert.equal(saved.cardRef, undefined); assert.equal(f.rpc.sends.length, before + 1);
    assert.deepEqual(f.host.getMonitorPolicies(taskId), []); assert.equal(f.jobs.size, 0);
  } finally { await f.close(); }
});

test('application factory: late manifest success never dispatches a missing approval card or accepts scope', async () => {
  const f = await fixture(); try {
    const { result } = await f.owner('Prepare an exact long employer application for my approval.'), taskId = result.taskId!, token = f.token(taskId);
    const draft = await f.call(token, 'outreach.propose', { name: 'Exact long application', recipients: [{ id: 'candidate', route: { peerId: '42' }, text: 'Full approved draft. '.repeat(160) }] });
    const before = f.rpc.sends.length; f.rpc.pendingDocumentSends = 1;
    const proposal = await f.call(token, 'outreach.request_approval', { batchId: draft.batch.id, expectedRevision: 1 });
    assert.equal(proposal.state, 'pending'); assert.equal(proposal.publication.stage, 'manifest'); assert.equal(proposal.publication.state, 'unknown');
    assert.ok(proposal.publication.manifest.effectId); assert.equal(proposal.publication.card, undefined); assert.equal(proposal.cardRef, undefined);
    f.rpc.completePendingSends(); await f.host.agent.poll(); await f.workflows.syncOwnerPolicies();
    const saved = f.workflows.ownerControls.proposal(proposal.id);
    assert.equal(saved.publication!.state, 'not-published'); assert.equal(saved.publication!.stage, 'card');
    assert.match(saved.publication!.reason!, /not dispatched/); assert.equal(saved.cardRef, undefined); assert.equal(saved.state, 'pending');
    await f.reopen(); await f.host.agent.poll(); await f.workflows.syncOwnerPolicies();
    assert.equal(f.rpc.sends.length, before + 1); assert.equal(f.host.agent.store.list<any>('ownerApprovalReceipts').length, 0);
    assert.equal(f.host.agent.store.list<any>('effects').filter(effect => effect.taskId === taskId && effect.capability === 'telegram.send').length, 0);
    assert.equal(f.workflows.ownerControls.proposal(proposal.id).cardRef, undefined);
  } finally { await f.close(); }
});

test('application factory: artifact creation stages exact encrypted CSV bytes for verified private media send', async () => {
  const f = await fixture(); try {
    const { result } = await f.owner('Create and send a CSV report privately.'); assert.equal(result.disposition, 'accepted'); const taskId = result.taskId!, token = f.token(taskId);
    const artifact = await f.call(token, 'artifact.create', { name: 'result.csv', format: 'csv', columns: ['name', 'note'], rows: [['Нейробро', 'comma, quote " and newline\n']], bom: false });
    assert.equal(artifact.taskId, taskId); assert.equal(artifact.ownerId, '1'); assert.equal(artifact.mimeType, 'text/csv');
    const sent = await f.call(token, 'telegram.media.send', { peerId: '1', artifactId: artifact.id, profile: 'file', caption: 'Saved report' }); assert.equal(sent.state, 'verified');
    assert.deepEqual(f.rpc.stagedBytes.map(bytes => bytes.toString()), ['name,note\r\nНейробро,"comma, quote "" and newline\n"\r\n']);
    const request = f.rpc.sends.find(request => request.input_message_content['@type'] === 'inputMessageDocument')!; assert.ok(request);
    assert.ok(resolve(request.input_message_content.document.document.path).startsWith(resolve(join(f.directory, 'artifacts', 'stages'))));
    assert.equal(f.host.agent.store.list<any>('effects').filter(effect => effect.capability === 'telegram.media.send').length, 1);
    assert.equal((await f.workflows.registry.invoke(token, { name: 'telegram.media.send', args: { peerId: '42', artifactId: artifact.id, profile: 'file' } })).ok, false);
    const stored = f.host.artifacts.read({ ownerId: '1', taskId }, artifact.id); assert.deepEqual(stored, f.rpc.stagedBytes[0]);
  } finally { await f.close(); }
});

test('application factory: saved personal resume crosses tasks as an exact approved attachment, never as a send grant', async () => {
  const f = await fixture(false, true); try {
    const savedTask = await f.owner('Save this as my main resume for later approved applications.'), taskA = savedTask.result.taskId!, tokenA = f.token(taskA);
    const original = await f.call(tokenA, 'artifact.create', { name: 'resume.csv', format: 'csv', columns: ['experience'], rows: [['AI automation — original selected version']] });
    const saved = await f.call(tokenA, 'documents.save', { artifactId: original.id, name: 'Main resume', versionLabel: 'owner selected original' });
    const application = await f.owner('Use my saved main resume to prepare this employer application for my approval.'), taskB = application.result.taskId!, tokenB = f.token(taskB);
    assert.notEqual(taskB, taskA);
    const listed = await f.call(tokenB, 'documents.list'); assert.equal(listed.documents[0].currentVersionId, saved.version.id);
    const direct = await f.workflows.registry.invoke(tokenB, { name: 'artifacts.stage', args: { artifactIds: [original.id] } }); assert.equal(direct.ok, false, 'raw foreign task artifact cannot bypass library import');
    const imported = await f.call(tokenB, 'documents.import', { documentId: saved.document.id, versionId: saved.version.id });
    assert.equal(imported.artifact.taskId, taskB); assert.equal(imported.artifact.sha256, original.sha256); assert.notEqual(imported.artifact.id, original.id);
    const repeated = await f.call(tokenB, 'documents.import', { documentId: saved.document.id, versionId: saved.version.id }); assert.equal(repeated.artifact.id, imported.artifact.id);
    const draft = await f.call(tokenB, 'outreach.propose', { name: 'Reviewed resume application', recipients: [{ id: 'employer', route: { peerId: '42' }, text: 'Здравствуйте! Мое резюме во вложении.', attachments: [{ artifactId: imported.artifact.id, profile: 'file' }] }] });
    assert.equal((await f.workflows.registry.invoke(tokenB, { name: 'telegram.media.send', args: { peerId: '42', artifactId: imported.artifact.id, profile: 'file' } })).ok, false);
    const proposal = await f.call(tokenB, 'outreach.request_approval', { batchId: draft.batch.id, expectedRevision: 1 });
    const card = f.workflows.ownerControls.proposal(proposal.id).cardRef!;
    assert.ok(f.rpc.messages.get(`1/${card.messageId}`)!.content.text.text.includes(original.sha256));
    await f.owner('да', card.messageId);
    const sends = f.rpc.sends.filter(request => String(request.chat_id) === '42'); assert.equal(sends.length, 2);
    assert.equal(sends[0]!.input_message_content.text.text, 'Здравствуйте! Мое резюме во вложении.');
    assert.deepEqual(f.rpc.stagedBytes.at(-1), f.host.artifacts.read({ ownerId: '1', taskId: taskA }, original.id));
    const status = await f.call(f.host.agent.issueExecutionContext(f.currentContext(taskB)), 'outreach.inspect', { batchId: draft.batch.id }); assert.equal(status.counts.verified, 1);
    const database = await readFile(join(f.directory, 'documents.sqlite')); assert.equal(database.includes(Buffer.from('Main resume')), false);
  } finally { await f.close(); }
});

test('application factory: public here task cannot read personal library, saved Codex, GitHub, or account-wide chats', async () => {
  const f = await fixture(false, true); try {
    const privateTask = await f.owner('Save my main resume privately.'), privateToken = f.token(privateTask.result.taskId!);
    const original = await f.call(privateToken, 'artifact.create', { name: 'private-resume.csv', format: 'csv', rows: [['PRIVATE RESUME']] });
    const saved = await f.call(privateToken, 'documents.save', { artifactId: original.id, name: 'Private resume', versionLabel: 'v1' });
    const origin = '-20'; f.rpc.put(message(origin, '100', '/бро --here Explain this discussion.', true));
    const observation = (await f.telegram.getMessage({ accountId: '1', peerId: origin, messageId: '100' }))!;
    const result = await f.host.ingest(observation), token = f.token(result.taskId!); assert.equal(result.disposition, 'accepted');
    const before = f.rpc.requests.length;
    for (const [name, args] of [
      ['documents.list', {}], ['documents.import', { documentId: saved.document.id }],
      ['documents.save', { artifactId: original.id, name: 'Leaked', versionLabel: 'v1' }],
      ['codex.chats_search', {}], ['github.repos', {}], ['telegram.history', { peerId: '-100999', limit: 10 }],
      ['telegram.chats.list', {}],
      ['telegram.peer.inspect', { peerId: '-100999' }], ['telegram.folder.create', { name: 'Forbidden', peerIds: ['-100999'] }],
    ] as [string, Record<string, Json>][]) {
      assert.ok(f.workflows.registry.list().some(tool => tool.name === name), `${name} is genuinely registered`);
      const denied = await f.workflows.registry.invoke(token, { name, args }); assert.equal(denied.ok, false, `${name} must reject public origin`);
    }
    assert.equal(f.rpc.requests.length, before, 'denied personal tools cross no native read/effect seam');
    const personal = await f.call(privateToken, 'documents.list'); assert.equal(personal.documents.length, 1);
  } finally { await f.close(); }
});

test('application factory: private saved Codex tools read authorized visible context without exporting hidden records or granting execution', async () => {
  const f = await fixture(false, true); try {
    const home = join(f.directory, 'saved-codex'), sessions = join(home, 'sessions', '2026', '10', '05'); await mkdir(sessions, { recursive: true });
    const threadId = '01a10000-0000-7000-8000-000000000001', project = join(f.directory, 'portfolio');
    const row = (type: string, payload: unknown) => JSON.stringify({ type, payload, timestamp: '2026-10-05T00:00:00Z' }) + '\n';
    const visible = (role: string, text: string, extra: object = {}) => row('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra });
    await writeFile(join(sessions, `rollout-2026-10-05T00-00-00-${threadId}.jsonl`), row('session_meta', { id: threadId, cwd: project, base_instructions: 'HIDDEN SYSTEM' }) +
      visible('user', 'Build my portfolio') + visible('assistant', 'HIDDEN REASONING', { channel: 'analysis' }) + row('response_item', { type: 'function_call_output', output: 'HIDDEN TOOL' }) +
      visible('assistant', 'Portfolio implementation is saved; api_key=secret-value', { phase: 'final' }));
    await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: threadId, thread_name: 'Portfolio discussion', updated_at: '2026-10-05' }) + '\n');
    await writeFile(join(home, 'auth.json'), 'AUTH MUST STAY LOCAL');
    const task = await f.owner('What have we discussed in my saved portfolio Codex chat?'), token = f.token(task.result.taskId!);
    const found = await f.call(token, 'codex.chats_search', { query: 'Portfolio' }); assert.equal(found.chats.length, 1); assert.equal(found.chats[0].id, threadId);
    const read = await f.call(token, 'codex.chat_read', { threadId }); assert.equal(read.messages.length, 2); assert.equal(read.messages[1].redacted, true);
    const exported = JSON.stringify(read); for (const secret of ['HIDDEN SYSTEM', 'HIDDEN REASONING', 'HIDDEN TOOL', 'secret-value', 'AUTH MUST STAY LOCAL']) assert.equal(exported.includes(secret), false);
    assert.equal(read.desktopAttached, false); assert.equal(read.controlAvailable, false); assert.equal(read.chat.runtimeStatus, 'unknown');
    const projects = await f.call(token, 'codex.projects'); assert.equal(projects.projects[0].root, project);
    const before = f.admissions.length; assert.equal((await f.workflows.registry.invoke(token, { name: 'computer.start', args: { instruction: 'Deploy now' } })).ok, false); assert.equal(f.admissions.length, before);
    assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), 'AUTH MUST STAY LOCAL');
  } finally { await f.close(); }
});

test('application factory: private account reads and guarded folder edits never admit external text or media', async () => {
  const f = await fixture(false, true); try {
    f.rpc.put(message('-100999', '1', 'Visible source material, not permission to write'));
    const task = await f.owner('Read relevant account chats and organize selected employment sources in a folder.'), token = f.token(task.result.taskId!);
    const history = await f.call(token, 'telegram.history', { peerId: '-100999', limit: 10 }); assert.ok(JSON.stringify(history).includes('Visible source material'));
    const metadata = await f.call(token, 'telegram.peer.inspect', { peerId: '-100999' }); assert.equal(metadata.coverage, 'visible-metadata'); assert.equal(metadata.publicProfileLink, 'https://t.me/source');
    const created = await f.call(token, 'telegram.folder.create', { name: 'Work', peerIds: [sourcePeer] }); assert.equal(created.state, 'verified');
    const old = await f.call(token, 'telegram.folder.get', { folderId: 1 }); assert.deepEqual(old.peerIds, [sourcePeer]);
    const update = await f.call(token, 'telegram.folder.update', { folderId: 1, expectedVersion: old.version, addPeerIds: ['-100999'] }); assert.equal(update.state, 'verified');
    const fresh = await f.call(token, 'telegram.folder.get', { folderId: 1 }); assert.deepEqual([...fresh.peerIds].sort(), [sourcePeer, '-100999'].sort());
    f.host.options.config.ownerTelegram!.manageFolders = false;
    const beforeRevokedEdit = f.rpc.requests.length;
    assert.equal((await f.workflows.registry.invoke(token, { name: 'telegram.folder.update', args: { folderId: 1, expectedVersion: fresh.version, name: 'Must not write' } })).ok, false);
    assert.equal(f.rpc.requests.slice(beforeRevokedEdit).some(request => request['@type'] === 'editChatFolder'), false, 'revoking folder authority fences existing grants');
    const artifact = await f.call(token, 'artifact.create', { name: 'private.csv', format: 'csv', rows: [['not approved for employers']] });
    const sends = f.rpc.sends.length;
    assert.equal((await f.workflows.registry.invoke(token, { name: 'telegram.send', args: { peerId: '-100999', text: 'Unapproved source post' } })).ok, false);
    assert.equal((await f.workflows.registry.invoke(token, { name: 'telegram.media.send', args: { peerId: '42', artifactId: artifact.id, profile: 'file' } })).ok, false);
    assert.equal(f.rpc.sends.length, sends);
    assert.equal(f.rpc.requests.some(request => request['@type'] === 'joinChat'), false, 'organizing a folder does not join its chats');
    const publicWrites = f.host.agent.store.list<any>('effects').filter(effect => effect.capability === 'telegram.send' && effect.resource !== '1'); assert.deepEqual(publicWrites, []);
  } finally { await f.close(); }
});

test('application factory: actual account inventory selects existing main and archived job channels and preserves the owner folder', async () => {
  const f = await fixture(false, true); try {
    const position = (list: string, order: string, folderId?: number) => ({
      list: { '@type': list, ...(folderId ? { chat_folder_id: folderId } : {}) }, order, is_pinned: false,
    });
    const put = (peerId: string, title: string, type: TdObject, positions: TdObject[]) => f.rpc.accountChats.set(peerId, { '@type': 'chat', id: peerId, title, type, positions });
    f.rpc.accountUsers.set('42', { '@type': 'user', id: '42', first_name: 'Human colleague', type: { '@type': 'userTypeRegular' }, have_access: true });
    f.rpc.accountUsers.set('43', { '@type': 'user', id: '43', first_name: 'Jobs bot', type: { '@type': 'userTypeBot' }, have_access: true });
    put('42', 'Human colleague', { '@type': 'chatTypePrivate', user_id: '42' }, [position('chatListMain', '900')]);
    put('43', 'Jobs bot', { '@type': 'chatTypePrivate', user_id: '43' }, [position('chatListMain', '800')]);
    f.rpc.accountBasicGroups.set('50', { '@type': 'basicGroup', id: '50', status: { '@type': 'chatMemberStatusMember' } });
    put('-50', 'Small working group', { '@type': 'chatTypeBasicGroup', basic_group_id: '50' }, [position('chatListMain', '700')]);
    const group = (peerId: string, groupId: string, title: string, isChannel: boolean, status: TdObject, positions: TdObject[], usernames: string[] = []) => {
      f.rpc.accountSupergroups.set(groupId, { '@type': 'supergroup', id: groupId, is_channel: isChannel, status, usernames: { active_usernames: usernames } });
      put(peerId, title, { '@type': 'chatTypeSupergroup', supergroup_id: groupId, is_channel: isChannel }, positions);
    };
    group('-100601', '601', 'Working supergroup', false, { '@type': 'chatMemberStatusMember' }, [position('chatListMain', '600')]);
    group('-100701', '701', 'Job channels', true, { '@type': 'chatMemberStatusMember' }, [position('chatListMain', '500'), position('chatListFolder', '500', 7)]);
    group('-100702', '702', 'Job channels', true, { '@type': 'chatMemberStatusLeft' }, [position('chatListMain', '400')], ['old_jobs']);
    group('-100703', '703', 'Job channels', true, { '@type': 'chatMemberStatusBanned' }, [position('chatListMain', '300')], ['blocked_jobs']);
    group('-100704', '704', 'Job channels', true, { '@type': 'chatMemberStatusAdministrator' }, [position('chatListArchive', '950')], ['archived_jobs']);
    const baseline: TdObject = { '@type': 'chatFolder', name: { '@type': 'chatFolderName', text: { '@type': 'formattedText', text: 'Работа', entities: [] }, animate_custom_emoji: false },
      icon: { '@type': 'chatFolderIcon', name: 'Office' }, color_id: 4, is_shareable: false, pinned_chat_ids: ['-901'], included_chat_ids: ['-902'], excluded_chat_ids: ['-903'],
      exclude_muted: true, exclude_read: false, exclude_archived: false, include_contacts: false, include_non_contacts: false, include_bots: false, include_groups: true, include_channels: false };
    f.rpc.folders.set(7, structuredClone(baseline));
    const owner = await f.owner('Положи наши существующие каналы с вакансиями в мою папку Работа.'), token = f.token(owner.result.taskId!);
    const description = await f.call(token, 'tools.describe', { names: ['telegram.chats.list'] });
    assert.deepEqual(description.unknown, []); assert.equal(description.tools.length, 1);
    const definition = description.tools[0]; assert.equal(definition.name, 'telegram.chats.list'); assert.equal(definition.mutates, false);
    assert.deepEqual(definition.inputSchema.properties.list.enum, ['main', 'archive', 'folder']);
    assert.equal(definition.inputSchema.properties.limit.maximum, 100);
    assert.ok(definition.inputSchema.properties.cursor); assert.equal(definition.inputSchema.properties.scope, undefined);
    assert.equal(definition.inputSchema.additionalProperties, false, 'runtime metadata exposes the exact contract instead of guessed arguments');
    const readFrom = f.rpc.requests.length, sendCount = f.rpc.sends.length;
    const collect = async (list: 'main' | 'archive' | 'folder', folderId?: number) => {
      const chats: any[] = []; let cursor: string | undefined, snapshotId: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await f.call(token, 'telegram.chats.list', { list, limit: 2, ...(folderId ? { folderId } : {}), ...(cursor ? { cursor } : {}) });
        assert.ok(result.chats.length <= 2); chats.push(...result.chats);
        snapshotId ??= result.snapshotId; assert.equal(result.snapshotId, snapshotId);
        assert.equal(result.coverage.complete, true, 'native 404 proves loading coverage even while output pages remain');
        assert.equal(result.page.snapshotExhausted, !result.nextCursor);
        if (!result.nextCursor) return chats;
        cursor = result.nextCursor;
      }
      assert.fail('inventory pagination did not finish within fixture bounds');
    };
    const main = await collect('main'), archive = await collect('archive'), folder = await collect('folder', 7);
    assert.deepEqual(main.map(chat => chat.peerId), ['42', '43', '-50', '-100601', '-100701', '-100702', '-100703']);
    assert.deepEqual(main.slice(0, 4).map(chat => chat.kind), ['private', 'bot', 'group', 'supergroup']);
    assert.deepEqual(archive.map(chat => chat.peerId), ['-100704']); assert.deepEqual(folder.map(chat => chat.peerId), ['-100701']);
    assert.equal(main.find(chat => chat.peerId === '-100702').ownMembership, 'left');
    assert.equal(main.find(chat => chat.peerId === '-100703').ownMembership, 'banned');
    assert.deepEqual(main.find(chat => chat.peerId === '-100701').usernames, [], 'private channel is selectable by actual account ID without a public URL');
    assert.ok([...main, ...archive].every(chat => chat.accountId === '1'));
    const selected = [...main, ...archive].filter(chat => chat.kind === 'channel' && chat.ownMembership === 'member' && chat.title === 'Job channels').map(chat => chat.peerId);
    assert.deepEqual(selected, ['-100701', '-100704'], 'duplicate channel titles must retain exact IDs and membership');
    const enumerations = f.rpc.requests.slice(readFrom);
    assert.ok(enumerations.some(request => request['@type'] === 'loadChats' && request.chat_list['@type'] === 'chatListArchive'));
    assert.equal(enumerations.some(request => ['searchPublicChat', 'searchChatMessages', 'getChatHistory', 'getChatSimilarChats'].includes(request['@type'])), false, 'account membership cannot be inferred from public discovery or message search');
    assert.equal(f.rpc.sends.length, sendCount);
    const folders = await f.call(token, 'telegram.folders.list'); assert.equal(folders.folders.find((entry: any) => entry.folderId === 7).name, 'Работа');
    const before = await f.call(token, 'telegram.folder.get', { folderId: 7 });
    const edited = await f.call(token, 'telegram.folder.update', { folderId: 7, expectedVersion: before.version, addPeerIds: selected }); assert.equal(edited.state, 'verified');
    const after = await f.call(token, 'telegram.folder.get', { folderId: 7 });
    assert.deepEqual([...after.peerIds].sort(), ['-901', '-902', ...selected].sort());
    assert.deepEqual(after.pinnedPeerIds, ['-901']); assert.deepEqual(after.excludedPeerIds, ['-903']); assert.deepEqual(after.filters, before.filters);
    const expected = structuredClone(baseline); expected.included_chat_ids = ['-902', ...selected].sort(); assert.deepEqual(f.rpc.folders.get(7), expected);
    assert.equal(f.rpc.requests.some(request => request['@type'] === 'joinChat'), false); assert.equal(f.rpc.sends.length, sendCount);
    f.host.options.config.ownerTelegram!.readAllChats = false;
    const beforeRevokedRead = f.rpc.requests.length;
    assert.equal((await f.workflows.registry.invoke(token, { name: 'telegram.chats.list', args: { list: 'archive' } })).ok, false);
    assert.equal(f.rpc.requests.slice(beforeRevokedRead).some(request => ['getCurrentState', 'loadChats'].includes(request['@type'])), false, 'revoking account reads fences native enumeration');
  } finally { await f.close(); }
});

test('application factory: owner edits during native account inventory prevent private result exposure', async () => {
  const f = await fixture(false, true); try {
    const owner = await f.owner('List my existing Telegram channels.'), token = f.token(owner.result.taskId!);
    const native = f.rpc.invoke.bind(f.rpc); let inventoryRead = false;
    f.rpc.invoke = async request => {
      const result = await native(request);
      if (request['@type'] === 'getCurrentState') {
        inventoryRead = true;
        f.rpc.put(message('1', owner.observation.ref.messageId, 'Stop, do not read my channels.', true));
      }
      return result;
    };
    const result = await f.workflows.registry.invoke(token, { name: 'telegram.chats.list', args: {} });
    assert.equal(inventoryRead, true, 'the owner edit crosses the awaited native inventory boundary');
    assert.equal(result.ok, false); assert.equal(result.value, undefined, 'private account metadata cannot enter the obsolete model request');
    const before = f.rpc.requests.length;
    assert.equal((await f.workflows.registry.invoke(token, { name: 'telegram.chats.list', args: {} })).ok, false);
    assert.equal(f.rpc.requests.slice(before).some(request => ['getCurrentState', 'loadChats'].includes(request['@type'])), false);
  } finally { await f.close(); }
});

test('application factory: default semantic digest closes only on native completion and cross-task pause does not resurrect an old execution', async () => {
  const f = await fixture(); try {
    f.rpc.put(message(sourcePeer, '1', 'Quiet initial baseline'));
    const initial = await f.owner('watch @source'), originalTask = initial.result.taskId!, token = f.token(originalTask);
    const sub = await f.call(token, 'monitors.subscribe', { key: 'daily-digest', name: 'Daily employment digest', sources: [{ id: 'source', kind: 'telegram', resource: sourcePeer }], criteria: 'Software employment', schedule: '0 10 * * 1-5' });
    assert.equal(sub.spec.deliveryMode, 'digest');
    const job = [...f.jobs.values()][0]!, admitted = await f.admit(job, 'assessed-cycle'); assert.equal(admitted.status, 200); const cron = admitted.body.tool_context!;
    f.rpc.put(message(sourcePeer, '2', 'Remote software engineering role Alpha')); f.rpc.put(message(sourcePeer, '3', 'Distributed engineer position Beta')); f.rpc.put(message(sourcePeer, '4', 'Buy a training course'));
    const gathered = await f.call(cron, 'monitors.collect', { subscriptionId: sub.id }); assert.equal(gathered.candidates.length, 3);
    const before = f.rpc.sends.length;
    await f.call(cron, 'monitors.decide', { subscriptionId: sub.id, decisions: gathered.candidates.map((candidate: any) => ({ candidateId: candidate.id, match: candidate.alert.itemId !== '4', reason: candidate.alert.itemId === '4' ? 'Training is not employment' : 'Software job fits' })) });
    assert.equal(f.rpc.sends.length, before, 'semantic decisions do not send per-match alerts in digest mode');
    const completion = await f.complete(job, 'assessed-cycle'); assert.equal(completion.status, 200); assert.equal(completion.body.callback, 'verified');
    const delivered = f.rpc.sends.slice(before); assert.equal(delivered.length, 1); assert.equal(String(delivered[0]!.chat_id), '1');
    const text = delivered[0]!.input_message_content.text.text; assert.match(text, /Сводка: Daily employment digest/); assert.match(text, /Alpha/); assert.match(text, /Beta/); assert.doesNotMatch(text, /training course/);
    const replay = await f.complete(job, 'assessed-cycle'); assert.equal(replay.body.replayed, true); assert.equal(f.rpc.sends.length, before + 1);
    const inFlight = await f.admit(job, 'before-pause'); assert.equal(inFlight.status, 200);
    const control = await f.owner('Pause my existing monitor.'), controlTask = control.result.taskId!, controlToken = f.token(controlTask); assert.notEqual(controlTask, originalTask);
    const listed = await f.call(controlToken, 'monitors.list'); assert.ok(listed.some((item: any) => item.id === sub.id));
    const paused = await f.call(controlToken, 'monitors.pause', { subscriptionId: sub.id }); assert.equal(paused.state, 'paused'); assert.equal(job.state, 'paused');
    assert.equal((await f.admit(job, 'while-paused')).status, 403);
    assert.equal((await f.workflows.registry.invoke(inFlight.body.tool_context!, { name: 'monitors.collect', args: { subscriptionId: sub.id } })).ok, false);
    const resumed = await f.call(controlToken, 'monitors.resume', { subscriptionId: sub.id }); assert.equal(resumed.state, 'active'); assert.equal(job.state, 'active');
    assert.equal((await f.admit(job, 'before-pause')).status, 403, 'resume never revives the old admitted token');
    const fresh = await f.admit(job, 'after-resume'); assert.equal(fresh.status, 200);
    const quiet = await f.call(fresh.body.tool_context!, 'monitors.collect', { subscriptionId: sub.id }); assert.equal(quiet.pending, 0);
    const quietBefore = f.rpc.sends.length; const quietCompletion = await f.complete(job, 'after-resume'); assert.equal(quietCompletion.body.callback, 'verified'); assert.equal(f.rpc.sends.length, quietBefore);
    assert.equal(f.host.agent.status(originalTask)!.intent.id, originalTask, 'owner control did not transfer monitor grant to its newer task');
  } finally { await f.close(); }
});
