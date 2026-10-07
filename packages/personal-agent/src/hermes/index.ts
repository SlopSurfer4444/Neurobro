import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { realpath, stat, readFile } from 'node:fs/promises';
import { dirname, relative, isAbsolute } from 'node:path';
import type { EngineCapabilities, EngineInput, EnginePort, RunBinding, RunSnapshot, RunState, ToolContext } from '../contracts.ts';

export const HERMES_SOURCE_PIN = '8d5e3e412138342e8bf30443e72bd4e6a9abd057';
type Wire = Record<string, unknown>;
export class HermesError extends Error {
  readonly code: string; readonly status?: number;
  constructor(code: string, message: string, status?: number) { super(message); this.name = 'HermesError'; this.code = code; this.status = status; }
}
/** Trusted host registration. Neither the token nor this interface is model accessible.
 * Native middleware provides task_id=session_id. A session may NEVER be rebound. */
export interface HermesToolBridge {
  register(input: { sessionId: string; idempotencyKey: string; toolContext: string }): Promise<void>;
}
export class HTTPScopedToolBridge implements HermesToolBridge {
  private readonly url: string;
  private readonly options: { baseUrl: string; registrationKey: string; timeoutMs?: number };
  constructor(options: { baseUrl: string; registrationKey: string; timeoutMs?: number }) {
    this.options = options;
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || options.registrationKey.length < 32) throw new HermesError('invalid_config', 'Plugin registration requires numeric loopback and a separate strong host registration key');
    this.url = url.href.replace(/\/$/, '');
  }
  async register(input: { sessionId: string; idempotencyKey: string; toolContext: string }): Promise<void> {
    await this.ready();
    let response: Response;
    try { response = await fetch(this.url + '/bindings', { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.options.registrationKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: input.sessionId, idempotency_key: input.idempotencyKey, tool_context: input.toolContext }), signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) }); }
    catch { throw new HermesError('scoped_tools_unavailable', 'Trusted plugin registration did not settle'); }
    if (!response.ok) throw new HermesError(response.status === 409 ? 'tool_binding_conflict' : 'scoped_tools_unavailable', 'Trusted plugin rejected the immutable session binding', response.status);
    const data = object(await response.json());
    if (data.ok !== true || data.session_id !== input.sessionId) throw new HermesError('protocol_error', 'Trusted plugin binding acknowledgment is invalid');
  }
  async ready(): Promise<void> {
    let data: Wire;
    try {
      const response = await fetch(this.url + '/ready', { redirect: 'error', headers: { Authorization: `Bearer ${this.options.registrationKey}` }, signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000) });
      if (!response.ok) throw new Error(); data = object(await response.json());
    } catch { throw new HermesError('scoped_tools_unavailable', 'Trusted plugin readiness did not settle'); }
    if (data.ok !== true || data.hermesPin !== HERMES_SOURCE_PIN || data.trustedIdentity !== 'native_handler_task_id' || data.requiresUniqueAdmissionSession !== true) throw new HermesError('scoped_tools_unavailable', 'Trusted plugin runtime identity contract is incompatible');
  }
}
export interface HermesOptions {
  baseUrl: string; apiKey?: string; statePath: string;
  requestTimeoutMs?: number; pollIntervalMs?: number; maxWaitMs?: number;
  artifactRoot?: string; bridge?: HermesToolBridge; fetch?: typeof globalThis.fetch;
  now?: () => number;
}
interface Admission { key: string; fingerprint: string; first_at: number; binding: string | null; session_id: string; phase: string; tool_hash: string | null }
const terminal = new Set<RunState>(['completed', 'failed', 'interrupted', 'cancelled']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (v: unknown): Wire => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Wire : {};
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Native Hermes owns execution/transcripts. This SQLite file stores only admission
 * identity and run pointers so its 24h idempotency retention cannot cause a replay. */
export class HermesEngine implements EnginePort {
  readonly options: HermesOptions;
  private readonly db: DatabaseSync;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly poll: number;
  private readonly waitBudget: number;
  constructor(options: HermesOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HermesError('invalid_config', 'Invalid Hermes base URL');
    this.options = { ...options, baseUrl: url.href.replace(/\/$/, '') };
    this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now;
    this.timeout = options.requestTimeoutMs ?? 15_000; this.poll = options.pollIntervalMs ?? 500; this.waitBudget = options.maxWaitMs ?? 60_000;
    for (const n of [this.timeout, this.poll, this.waitBudget]) if (!Number.isFinite(n) || n <= 0) throw new HermesError('invalid_config', 'Timeouts must be positive finite milliseconds');
    mkdirSync(dirname(options.statePath), { recursive: true });
    this.db = new DatabaseSync(options.statePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS metadata(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admissions(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,first_at INTEGER NOT NULL,binding TEXT,session_id TEXT NOT NULL,phase TEXT NOT NULL,tool_hash TEXT);');
    const identity = hash(this.options.baseUrl + ':' + hash(options.apiKey ?? ''));
    const prior = this.db.prepare('SELECT v FROM metadata WHERE k=?').get('engine') as { v: string } | undefined;
    if (prior && prior.v !== identity) { this.db.close(); throw new HermesError('engine_scope_mismatch', 'Admission store belongs to another engine/auth scope'); }
    this.db.prepare('INSERT OR IGNORE INTO metadata(k,v) VALUES(?,?)').run('engine', identity);
  }
  close(): void { this.db.close(); }
  /** Trusted lookup only: transcript compaction may rotate sessionId, while
   * the native handler credential identity remains the original admission. */
  immutableAdmissionSession(context: ToolContext): string {
    const records = this.db.prepare('SELECT * FROM admissions WHERE binding IS NOT NULL AND tool_hash IS NOT NULL').all() as unknown as Admission[];
    const matches = records.filter(record => {
      const binding = JSON.parse(record.binding!) as RunBinding;
      return binding.taskId === context.taskId && binding.intentRevision === context.intentRevision && binding.runId === context.runId;
    });
    if (matches.length !== 1) throw new HermesError('binding_mismatch', 'No unique scoped native admission for this execution');
    return matches[0]!.session_id;
  }
  private async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Wire> {
    let response: Response;
    try { response = await this.fetcher(this.options.baseUrl + path, { method, redirect: 'error', headers: { ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeout) }); }
    catch { throw new HermesError('transport_unknown', 'Hermes request did not return a confirmed outcome'); }
    let data: Wire;
    try { const text = await response.text(); if (text.length > 2_097_152) throw new Error(); data = object(JSON.parse(text)); }
    catch { throw new HermesError('protocol_error', 'Hermes returned invalid or oversized JSON', response.status); }
    if (!response.ok) { const error = object(data.error); throw new HermesError(typeof error.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : `http_${response.status}`, 'Hermes rejected the request; inspect the engine privately for details', response.status); }
    return data;
  }
  async capabilities(): Promise<EngineCapabilities> {
    const c = await this.request('/v1/capabilities');
    if (c.object !== 'hermes.api_server.capabilities' || c.platform !== 'hermes-agent') throw new HermesError('protocol_error', 'Not a native Hermes capabilities response');
    const f = object(c.features), idem = object(f.runs_idempotency);
    return { durable: f.run_submission === true && idem.supported === true && idem.durable === true,
      sessions: f.session_resources === true, cancel: f.run_stop === true, steer: f.run_steer === true,
      detail: `Native source contract ${HERMES_SOURCE_PIN}; retention_seconds=${String(idem.retention_seconds ?? 'unknown')}; scoped tools=${this.options.bridge ? 'trusted immutable-session registration configured' : 'unavailable'}` };
  }
  private admission(key: string): Admission | undefined { return this.db.prepare('SELECT * FROM admissions WHERE key=?').get(key) as unknown as Admission | undefined; }
  private assertBinding(binding: RunBinding): Admission {
    const record = this.admission(binding.idempotencyKey);
    const stored = record?.binding ? JSON.parse(record.binding) as RunBinding : undefined;
    if (!stored || stored.runId !== binding.runId || stored.taskId !== binding.taskId || stored.intentRevision !== binding.intentRevision || stored.idempotencyKey !== binding.idempotencyKey) throw new HermesError('binding_mismatch', 'Run binding is not owned by this admission store');
    if (binding.sessionId && binding.sessionId !== stored.sessionId && binding.sessionId !== record!.session_id) throw new HermesError('binding_mismatch', 'Session binding is not the original or current native lineage');
    return record!;
  }
  /** Recovery obtains the token from the host's encrypted registry. The adapter
   * stores only its digest, and never manufactures/reissues broader authority. */
  async restoreToolBinding(binding: RunBinding, toolContext: string): Promise<void> {
    const record = this.assertBinding(binding);
    if (!record.tool_hash || hash(toolContext) !== record.tool_hash) throw new HermesError('tool_binding_conflict', 'Recovery token differs from the original trusted admission');
    if (!this.options.bridge) throw new HermesError('scoped_tools_unavailable', 'Trusted plugin registration is unavailable');
    await this.options.bridge.register({ sessionId: record.session_id, idempotencyKey: binding.idempotencyKey, toolContext });
  }
  async createLocalSchedule(_input: { name: string; schedule: string; instruction: string }): Promise<never> {
    // api_server.py::_handle_create_job drops failure_deliver, and its update
    // allowlist also omits it. Supported hooks do not correlate execution IDs
    // to timestamp-named outputs. Do not create a partially safe native job.
    throw new HermesError('schedule_result_unavailable', 'Pinned native cron HTTP cannot enforce failure_deliver=local or expose an exact execution/output manifest');
  }
  private async staged(files: string[] | undefined): Promise<string> {
    if (!files?.length) return '';
    if (!this.options.artifactRoot) throw new HermesError('artifact_staging_unavailable', 'A trusted shared artifact root is required for native file tools');
    const root = await realpath(this.options.artifactRoot);
    const manifest = [];
    for (const file of files) {
      const path = await realpath(file), rel = relative(root, path);
      if (rel.startsWith('..') || isAbsolute(rel) || !rel) throw new HermesError('artifact_scope_violation', 'Staged file is outside the authorized artifact root');
      const info = await stat(path); if (!info.isFile()) throw new HermesError('artifact_scope_violation', 'Staged input must be a regular file');
      if (info.size > 67_108_864) throw new HermesError('artifact_size_limit', 'Staged input exceeds 64 MiB');
      const bytes = await readFile(path);
      manifest.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return '\nTask input copies (use the scoped broker file tool):\n' + JSON.stringify(manifest);
  }
  async submit(input: EngineInput): Promise<RunSnapshot> {
    if (!input.taskId || !input.instruction || !Number.isSafeInteger(input.intentRevision) || input.intentRevision < 1 || !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey)) throw new HermesError('invalid_input', 'Task/revision/instruction/key are required');
    if (input.toolContext && !this.options.bridge) throw new HermesError('scoped_tools_unavailable', 'Native Runs API has no trusted tool-context field; configure the supported scoped plugin bridge');
    const caps = await this.capabilities();
    if (!caps.durable || !caps.sessions) throw new HermesError('durability_unavailable', 'Durable native run reservations and server-side sessions are required');
    // Every admission gets a fresh native runtime identity, including pure
    // computation. Reusing a credential-bound session without a token would
    // otherwise inherit another run's plugin authority through native task_id.
    const sessionId = `nb_${hash(input.taskId + '\n' + input.idempotencyKey).slice(0, 48)}`;
    const body: Wire = { input: input.instruction + await this.staged(input.stagedFiles), session_id: sessionId };
    if (input.context) body.instructions = input.context;
    const fingerprint = hash(JSON.stringify({ body, taskId: input.taskId, revision: input.intentRevision, toolContext: input.toolContext ? hash(input.toolContext) : undefined, sourceSession: input.sessionId }));
    const existing = this.admission(input.idempotencyKey);
    if (existing && existing.fingerprint !== fingerprint) throw new HermesError('idempotency_key_conflict', 'Logical key was used with a different task, revision, context or request');
    if (existing?.binding) {
      if (input.toolContext) await this.options.bridge!.register({ sessionId: existing.session_id, idempotencyKey: input.idempotencyKey, toolContext: input.toolContext });
      return this.inspect(JSON.parse(existing.binding) as RunBinding);
    }
    if (existing && this.now() - existing.first_at >= 86_400_000) throw new HermesError('idempotency_retention_expired', 'Unknown admission is beyond native retention; reconcile without replay');
    if (!existing) this.db.prepare('INSERT INTO admissions(key,fingerprint,first_at,session_id,phase,tool_hash) VALUES(?,?,?,?,?,?)').run(input.idempotencyKey, fingerprint, this.now(), sessionId, 'prepared', input.toolContext ? hash(input.toolContext) : null);
    const record = this.admission(input.idempotencyKey)!;
    if (record.phase === 'prepared') {
      if (input.sessionId && input.sessionId !== sessionId) {
        const previous = this.db.prepare("SELECT binding FROM admissions WHERE (session_id=? OR json_extract(binding,'$.sessionId')=?) AND binding IS NOT NULL ORDER BY first_at DESC LIMIT 1").get(input.sessionId, input.sessionId) as { binding: string } | undefined;
        if (!previous) throw new HermesError('session_not_owned', 'Cannot branch a session outside this admission store');
        const previousBinding = JSON.parse(previous.binding) as RunBinding;
        if (previousBinding.taskId !== input.taskId) throw new HermesError('session_task_mismatch', 'Cannot copy another task transcript into this admission');
        const snapshot = await this.inspect(previousBinding);
        if (!terminal.has(snapshot.state)) throw new HermesError('session_writer_unsettled', 'Cannot branch before the previous native run has settled');
        try { await this.request(`/api/sessions/${encodeURIComponent(input.sessionId)}/fork`, 'POST', { id: sessionId }); }
        catch (error) { if (!(error instanceof HermesError) || error.code !== 'session_exists') throw error; }
      } else {
        try { await this.request('/api/sessions', 'POST', { id: sessionId, source: 'api_server' }); }
        catch (error) { if (!(error instanceof HermesError) || error.code !== 'session_exists') throw error; }
      }
      this.db.prepare('UPDATE admissions SET phase=? WHERE key=?').run('dispatching', input.idempotencyKey);
    }
    // Re-enrol after plugin restart before any same-key native replay. Immutable
    // plugin registration cannot broaden or replace a live session's authority.
    if (input.toolContext) await this.options.bridge!.register({ sessionId, idempotencyKey: input.idempotencyKey, toolContext: input.toolContext });
    // A network retry reuses EXACT body/key. Never manufacture a new logical operation.
    // Registration/fork/readiness may consume time. Leave the full request budget
    // before the conservative retention horizon, then require reconciliation.
    if (this.now() - record.first_at + this.timeout >= 86_400_000) throw new HermesError('idempotency_retention_expired', 'Admission cannot settle within native retention; reconcile without replay');
    const wire = await this.request('/v1/runs', 'POST', body, { 'Idempotency-Key': input.idempotencyKey });
    if (!nonempty(wire.run_id)) throw new HermesError('protocol_error', 'Native admission lacks run_id');
    const binding: RunBinding = { runId: wire.run_id, sessionId, taskId: input.taskId, intentRevision: input.intentRevision, idempotencyKey: input.idempotencyKey };
    this.db.prepare('UPDATE admissions SET binding=?,phase=? WHERE key=?').run(JSON.stringify(binding), 'bound', input.idempotencyKey);
    return this.snapshot(binding, wire);
  }
  private snapshot(binding: RunBinding, wire: Wire): RunSnapshot {
    if (wire.run_id !== binding.runId) throw new HermesError('protocol_error', 'Native status belongs to a different run');
    const mapping: Record<string, RunState> = { started: 'queued', queued: 'queued', running: 'running', stopping: 'waiting', waiting_for_approval: 'waiting', completed: 'completed', failed: 'failed', interrupted: 'interrupted', cancelled: 'cancelled' };
    const state = mapping[String(wire.status)];
    if (!state) throw new HermesError('protocol_error', 'Unknown native run status');
    // Native compression may rotate the transcript ID. Preserve the immutable
    // original credential session in admissions.session_id and report the current
    // transcript pointer without changing the logical run/task/revision binding.
    const currentBinding = { ...binding, ...(nonempty(wire.session_id) ? { sessionId: wire.session_id } : {}) };
    this.db.prepare('UPDATE admissions SET binding=? WHERE key=?').run(JSON.stringify(currentBinding), binding.idempotencyKey);
    return { binding: currentBinding, state, observedAt: new Date(this.now()).toISOString(), ...(typeof wire.output === 'string' ? { output: wire.output } : {}), ...(typeof wire.error === 'string' ? { reason: 'native_run_failed; inspect engine privately' } : wire.status === 'stopping' ? { reason: 'cooperative_stop_pending; execution settlement is not yet confirmed' } : {}), ...(typeof wire.last_event === 'string' ? { progress: wire.last_event } : {}) };
  }
  async inspect(binding: RunBinding): Promise<RunSnapshot> {
    this.assertBinding(binding);
    try { return this.snapshot(binding, await this.request(`/v1/runs/${encodeURIComponent(binding.runId)}`)); }
    catch (error) { if (error instanceof HermesError && ['run_not_found', 'http_404', 'transport_unknown'].includes(error.code)) return { binding, state: 'unknown', observedAt: new Date(this.now()).toISOString(), reason: error.code }; throw error; }
  }
  async cancel(binding: RunBinding): Promise<RunSnapshot> {
    this.assertBinding(binding);
    if (!(await this.capabilities()).cancel) throw new HermesError('cancel_unavailable', 'Native engine does not advertise run_stop');
    return this.snapshot(binding, await this.request(`/v1/runs/${encodeURIComponent(binding.runId)}/stop`, 'POST', {}));
  }
  async steer(binding: RunBinding, instruction: string, intentRevision: number): Promise<RunSnapshot> {
    this.assertBinding(binding);
    if (intentRevision !== binding.intentRevision) throw new HermesError('scope_revision_changed', 'A changed grant/revision needs a reconciled new admission and immutable tool binding');
    if (!instruction.trim()) throw new HermesError('invalid_input', 'Steer text is empty');
    if (!(await this.capabilities()).steer) throw new HermesError('steer_unavailable', 'Native engine does not advertise run_steer');
    const result = await this.request(`/v1/runs/${encodeURIComponent(binding.runId)}/steer`, 'POST', { input: instruction });
    if (result.run_id !== binding.runId || result.accepted !== true) throw new HermesError('protocol_error', 'Native steer acceptance is not confirmed');
    return this.inspect(binding);
  }
  async wait(binding: RunBinding, options: { maxWaitMs?: number; signal?: AbortSignal } = {}): Promise<RunSnapshot> {
    const budget = Math.min(options.maxWaitMs ?? this.waitBudget, this.waitBudget), end = Date.now() + budget;
    if (budget <= 0 || !Number.isFinite(budget)) throw new HermesError('invalid_input', 'Wait budget must be positive and finite');
    let snapshot = await this.inspect(binding);
    while (!terminal.has(snapshot.state) && snapshot.state !== 'unknown' && Date.now() < end && !options.signal?.aborted) {
      await new Promise<void>(resolve => { const timer = setTimeout(done, Math.min(this.poll, end - Date.now())); const signal = options.signal; function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
      if (!options.signal?.aborted && Date.now() < end) snapshot = await this.inspect(binding);
    }
    return terminal.has(snapshot.state) || snapshot.state === 'unknown' ? snapshot : { ...snapshot, reason: options.signal?.aborted ? 'wait_cancelled; engine run remains admitted' : 'wait_budget_exhausted; engine run remains admitted' };
  }
  /** SSE is observational only; lost/truncated events fall back to native polling.
   * Last-Event-ID is reused across at most three reconnects; all readers are bounded. */
  async *events(binding: RunBinding, options: { signal?: AbortSignal; maxDurationMs?: number } = {}): AsyncIterable<RunSnapshot> {
    this.assertBinding(binding);
    const duration = Math.min(options.maxDurationMs ?? this.waitBudget, this.waitBudget);
    if (!Number.isFinite(duration) || duration <= 0) throw new HermesError('invalid_input', 'Event duration must be positive and finite');
    const end = Date.now() + duration;
    let lastSeq = -1;
    for (let reconnect = 0; reconnect < 3 && Date.now() < end && !options.signal?.aborted; reconnect++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeout, Math.max(1, end - Date.now())));
      const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await this.fetcher(this.options.baseUrl + `/v1/runs/${encodeURIComponent(binding.runId)}/events`, { redirect: 'error', headers: { ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}), Accept: 'text/event-stream', ...(lastSeq >= 0 ? { 'Last-Event-ID': String(lastSeq) } : {}) }, signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) break;
        reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        while (Date.now() < end && !controller.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
          if (buffer.length > 1_048_576) throw new HermesError('protocol_error', 'Oversized native SSE frame');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const wire = object(JSON.parse(data));
            if (wire.run_id !== binding.runId) throw new HermesError('protocol_error', 'SSE event belongs to another native run');
            const seq = Number(wire.seq);
            if (Number.isSafeInteger(seq) && seq >= 0) { if (seq <= lastSeq) continue; lastSeq = seq; }
            const snapshot = await this.inspect(binding); yield snapshot;
            if (terminal.has(snapshot.state) || snapshot.state === 'unknown') return;
          }
        }
      } catch (error) {
        if (error instanceof HermesError && error.code === 'protocol_error') throw error;
      } finally {
        controller.abort(); clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        try { await reader?.cancel(); } catch { /* aborted native transport */ }
      }
    }
    if (!options.signal?.aborted && Date.now() < end) yield await this.wait(binding, { maxWaitMs: end - Date.now(), signal: options.signal });
  }
  /** Explicit continuation of an interrupted computation; proof is supplied by trusted
   * host reconciliation. Never replays the original body or original operation key. */
  async continueInterrupted(binding: RunBinding, input: EngineInput, proof: { oldExecutionSettled: boolean; effectsReconciled: boolean; checkpoint: string }): Promise<RunSnapshot> {
    const prior = await this.inspect(binding);
    if (prior.state !== 'interrupted' || !proof.oldExecutionSettled || !proof.effectsReconciled || !proof.checkpoint) throw new HermesError('continuation_requires_reconciliation', 'Interrupted run and settled execution/effects/checkpoint are required');
    if (input.taskId !== binding.taskId || input.idempotencyKey === binding.idempotencyKey) throw new HermesError('invalid_continuation', 'Continuation must bind the same task and a distinct logical operation key');
    return this.submit({ ...input, sessionId: binding.sessionId, instruction: `Continue from saved checkpoint for interrupted run ${binding.runId}.\n${proof.checkpoint}\n${input.instruction}` });
  }
}
