import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type TdObject = Record<string, any>;
/** Preserve integer lexemes before JavaScript rounds them. TDLib int64 is often a string. */
export function parseTdJson(raw: string): TdObject {
  return (JSON.parse as any)(raw, (_key: string, value: unknown, context?: { source: string }) =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context?.source ?? (() => { throw new Error('lossless JSON parser unavailable'); })() : value);
}
const idField = /^(id|.*_id|.*_ids|offset|limit)$/;
export function stringifyTdJson(value: unknown): string {
  function encode(v:any,key:string):any{
    if (typeof v === 'bigint') return (JSON as any).rawJSON(v.toString());
    // TDLib int53 IDs (including vectors) are exact numeric tokens; no JS Number coercion.
    if (typeof v === 'string' && /^-?\d+$/.test(v) && idField.test(key)) return (JSON as any).rawJSON(v);
    if(Array.isArray(v))return v.map(entry=>encode(entry,key));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([name,field])=>[name,encode(field,name)]));
    return v;
  }
  return JSON.stringify(encode(value,''));
}
const TD_ERROR_REASONS=['USERNAME_NOT_OCCUPIED','USERNAME_INVALID','USER_NOT_FOUND','CHAT_NOT_FOUND','PEER_ID_INVALID','USER_ID_INVALID','CHANNEL_INVALID','CHANNEL_PRIVATE','INVITE_HASH_INVALID','INVITE_HASH_EXPIRED','CHAT_ADMIN_REQUIRED','AUTH_KEY_UNREGISTERED','AUTH_KEY_DUPLICATED','SESSION_REVOKED','SESSION_EXPIRED','PHONE_NUMBER_INVALID','PHONE_CODE_INVALID','PHONE_CODE_EXPIRED','PASSWORD_HASH_INVALID','EMAIL_INVALID','EMAIL_CODE_INVALID','API_ID_INVALID','API_HASH_INVALID','API_ID_PUBLISHED_FLOOD','FLOOD_WAIT'] as const;
export type TdErrorReason=typeof TD_ERROR_REASONS[number];
/** Match the complete native message, never extract symbols from text that may contain secrets. */
export function safeTdErrorReason(value:unknown):TdErrorReason|undefined {
  if(typeof value!=='string'||value.length>128)return undefined;
  if((TD_ERROR_REASONS as readonly string[]).includes(value))return value as TdErrorReason;
  if(/^FLOOD_WAIT_[0-9]{1,10}$/.test(value)||/^Too Many Requests: retry after [0-9]{1,10}$/.test(value))return'FLOOD_WAIT';
  const phrases:Readonly<Record<string,TdErrorReason>>={'Username is invalid':'USERNAME_INVALID','User not found':'USER_NOT_FOUND','Chat not found':'CHAT_NOT_FOUND','Username not found':'USERNAME_NOT_OCCUPIED'};
  return Object.hasOwn(phrases,value)?phrases[value]:undefined;
}
export class TdRequestError extends Error {
  readonly dispatched: boolean; readonly code?: number;readonly reason?:TdErrorReason;
  constructor(message: string, dispatched: boolean, code?: number, nativeMessage?:unknown) {
    super(message);this.dispatched=dispatched;
    if(typeof code==='number'&&Number.isSafeInteger(code)&&code>=0&&code<=2147483647)this.code=code;
    const reason=safeTdErrorReason(nativeMessage);if(reason)this.reason=reason;
  }
}
export interface TdJsonTransport {
  invoke(request: TdObject, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<TdObject>;
  on(event: 'update' | 'gap' | 'fault', listener: (value: any) => void): this;
  close(): Promise<void>;
}
export interface ProcessTransportOptions { command: string; args?: string[]; env?:NodeJS.ProcessEnv; requestTimeoutMs?: number; closeTimeoutMs?: number; maxLineBytes?: number }
export class JsonProcessTransport extends EventEmitter implements TdJsonTransport {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (v: TdObject) => void; reject: (e: Error) => void; cleanup: () => void }>();
  private buffer = ''; private generation = 0; private closing = false;private nativeClosed=false;
  private firstFault?:Error;
  private closingTask?:Promise<void>;
  private sidecarReady=false;
  private readonly options: ProcessTransportOptions;
  constructor(options: ProcessTransportOptions) { super(); this.options=options; }
  /** Explicit host start. Never authorizes or initializes TDLib by itself. */
  start(): void {
    if (this.child) throw new Error('sidecar already running');
    if (this.closing) throw new Error('transport closed');
    this.generation++;
    this.nativeClosed=false;
    this.firstFault=undefined;
    this.sidecarReady=false;
    const minimalEnv:NodeJS.ProcessEnv={};for(const name of ['SystemRoot','WINDIR','TEMP','TMP','PATH','PATHEXT'])if(process.env[name])minimalEnv[name]=process.env[name];
    const child = spawn(this.options.command, this.options.args ?? [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,env:this.options.env??minimalEnv });
    this.child = child; this.buffer = '';
    this.emit('gap', { generation: this.generation, coverage: 'snapshot-only', reason: 'TDLib application update replay is not guaranteed; reconcile durable observations' });
    const decoder=new StringDecoder('utf8');
    child.stdout.on('data', (data: Buffer) => {
      if(this.child!==child)return;
      this.buffer += decoder.write(data);
      if (Buffer.byteLength(this.buffer) > (this.options.maxLineBytes ?? 16 * 1024 * 1024) && !this.buffer.includes('\n')) { this.fail(new Error('sidecar line exceeds bound')); child.kill(); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if(Buffer.byteLength(line)>(this.options.maxLineBytes??16*1024*1024)){this.fail(new Error('sidecar line exceeds bound'));child.kill();return;}
        try { this.receive(parseTdJson(line)); } catch { this.fail(new Error('invalid sidecar frame')); child.kill(); return; }
      }
    });
    child.stderr.on('data', () => { /* Sidecar diagnostics are intentionally not raw Telegram logs. */ });
    // Pipe errors are events even when a write callback is supplied (notably EPIPE
    // after a killed child). Always consume them and retain the original fault.
    child.stdin.on('error', () => this.fail(new Error('sidecar stdin failed; outcome uncertain')));
    child.on('error', () => this.fail(new Error('sidecar process error')));
    // exit can precede final stdout frames. Keep stream/generation ownership until
    // close, while firstFault prevents any additional request writes after exit.
    child.on('exit', (code) => { this.fail(new Error(`sidecar exited (${code})`)); });
    child.on('close', () => { if(this.child===child){this.child=undefined;this.fail(new Error('sidecar streams closed'));} });
  }
  private receive(value: TdObject): void {
    if (typeof value['@type'] !== 'string') throw new Error('missing TDLib type');
    if(value['@type']==='updateAuthorizationState'&&value.authorization_state?.['@type']==='authorizationStateClosed')this.nativeClosed=true;
    if(value['@type']==='neurobroSidecarStatus'){
      this.emit('status',value);
      if(value.state==='ready'){if(!Number.isSafeInteger(value.client_id)||value.client_id<=0)throw new Error('invalid sidecar readiness identity');this.sidecarReady=true;this.emit('ready');}
      if(value.state==='closed'&&value.authorization_closed===true)this.nativeClosed=true;
      if(value.state==='failure')this.fail(new Error('sidecar startup failure'));
    }
    const pending = typeof value['@extra'] === 'string' ? this.pending.get(value['@extra']) : undefined;
    if (pending) {
      this.pending.delete(value['@extra']); pending.cleanup();
      if (value['@type'] === 'error') pending.reject(new TdRequestError('TDLib rejected request', true, value.code, value.message)); else pending.resolve(value);
    } else if (value['@type'].startsWith('update')) this.emit('update', value);
    // A late response has no authority to retry a timed-out effect; updates still reconcile mappings.
  }
  private fail(error: Error): void {
    const first=!this.firstFault;this.firstFault??=error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new TdRequestError(this.firstFault.message, true)); }
    this.pending.clear(); if(first)this.emit('fault', this.firstFault);
  }
  /** Native startup is a separate bounded phase. No Telegram request is sent here;
   * an unmet readiness deadline is known pre-dispatch, not a native RPC timeout. */
  waitReady(timeoutMs=30000,signal?:AbortSignal):Promise<void>{
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0)return Promise.reject(new Error('invalid sidecar startup deadline'));
    if(!this.child||this.closing||this.firstFault||signal?.aborted)return Promise.reject(new TdRequestError(this.firstFault?.message??'sidecar unavailable or startup cancelled',false));
    if(this.sidecarReady)return Promise.resolve();
    return new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.off('ready',ready);this.off('fault',fault);signal?.removeEventListener('abort',abort);};
      const ready=()=>{cleanup();resolve();};
      const fault=(e:Error)=>{cleanup();reject(new TdRequestError(e.message,false));};
      const abort=()=>fault(new Error('sidecar startup cancelled; no request dispatched'));
      const timer=setTimeout(()=>fault(new Error('sidecar startup timeout; no request dispatched')),timeoutMs);
      this.on('ready',ready);this.on('fault',fault);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();else if(this.sidecarReady)ready();
    });
  }
  invoke(request: TdObject, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TdObject> {
    if (!this.child || this.closing || this.firstFault || options.signal?.aborted) return Promise.reject(new TdRequestError(this.firstFault?.message??'sidecar unavailable or request cancelled', false));
    const extra = `${this.generation}:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const finish = (reason: string) => { const p = this.pending.get(extra); if (!p) return; this.pending.delete(extra); p.cleanup(); reject(new TdRequestError(reason, true)); };
      const timer = setTimeout(() => finish('TDLib request timeout; outcome uncertain'), options.timeoutMs ?? this.options.requestTimeoutMs ?? 30000);
      const aborted = () => finish('TDLib request cancelled after dispatch; outcome uncertain');
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); };
      this.pending.set(extra, { resolve, reject, cleanup }); options.signal?.addEventListener('abort', aborted, { once: true });
      this.child!.stdin.write(stringifyTdJson({ ...request, '@extra': extra }) + '\n', error => { if (error) finish('sidecar write failed; outcome uncertain'); });
    });
  }
  close(): Promise<void> { return this.closingTask??=this.finishClose(); }
  private async finishClose():Promise<void>{
    this.closing = true;
    const child = this.child;
    if (!child) {if(this.firstFault&&!this.nativeClosed)throw new Error(`${this.firstFault.message}; TDLib authorization closure unverified`);return;}
    await new Promise<void>((resolve,reject) => {
      let forceTimer:NodeJS.Timeout|undefined;
      const timer = setTimeout(() => { child.kill();forceTimer=setTimeout(()=>reject(new Error('sidecar process termination unverified')),2000); }, this.options.closeTimeoutMs ?? 10000);
      child.once('close', () => { clearTimeout(timer);if(forceTimer)clearTimeout(forceTimer);resolve(); });
      if(!child.killed&&!child.stdin.destroyed&&!child.stdin.writableEnded&&child.stdin.writable){
        try {
          if(this.firstFault)child.stdin.end();
          else child.stdin.end(stringifyTdJson({ '@type': 'close', '@extra': `close:${randomUUID()}` }) + '\n');
        }catch{this.fail(new Error('sidecar stdin failed during close'));child.kill();}
      }
    });
    this.fail(new Error('transport closed'));
    if(!this.nativeClosed)throw new Error(`${this.firstFault?.message??'transport stopped'}; TDLib authorization closure unverified; process stopped after deadline or failure`);
  }
}
