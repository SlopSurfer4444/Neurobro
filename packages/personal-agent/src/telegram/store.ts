import { mkdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Json, Observation } from '../contracts.ts';

export interface TelegramReceipt { effectId: string; payloadHash: string; capability: string; peerId: string; state: 'dispatching'|'pending'|'verified'|'failed'|'unknown'; tempMessageId?: string; messageId?: string; sendingId?: number; detail?: Json }
export const isTelegramSendReceipt=(receipt:TelegramReceipt):boolean=>['telegram.send','telegram.message.send','message.send','telegram.media.send','telegram.poll.create','telegram.schedule.create'].includes(receipt.capability);
export interface TelegramReceiptStore {
  get(effectId: string): Promise<TelegramReceipt | undefined>;
  put(receipt: TelegramReceipt): Promise<void>;
  findMessage(peerId: string, messageId: string): Promise<TelegramReceipt | undefined>;
  findSending?(sendingId: number): Promise<TelegramReceipt | undefined>;
  unmappedSends?(peerId: string): Promise<TelegramReceipt[]>;
}
export interface TelegramObservationStore { append(observation: Observation): Promise<void>; pending?(limit:number): Promise<Observation[]>; acknowledge?(id:string):Promise<void>; holdAttribution?(observation:Observation):Promise<void>; heldAttribution?():Promise<Observation[]>; releaseAttribution?(observation:Observation):Promise<void> }
/** Append-only encrypted journal; caller owns key custody and retention. fsync precedes native dispatch. */
export class FileTelegramStore implements TelegramReceiptStore, TelegramObservationStore {
  private receipts = new Map<string, TelegramReceipt>(); private observations=new Map<string,Observation>();private attributionHolds=new Map<string,Observation>();private initialized?: Promise<void>; private chain = Promise.resolve();
  private readonly directory:string;private readonly key:Buffer;
  constructor(directory:string,key:Buffer) { if (key.length !== 32) throw new Error('Telegram store requires 32-byte encryption key');this.directory=directory;this.key=Buffer.from(key); }
  private init(): Promise<void> {
    return this.initialized ??= (async () => {
      await mkdir(this.directory, { recursive: true });
      let contents: string;
      try { contents = await readFile(join(this.directory, 'telegram.enc.jsonl'), 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
      if (contents && !contents.endsWith('\n')) throw new Error('torn Telegram journal: reconcile before dispatch');
      for (const line of contents.split('\n').filter(Boolean)) {
        const envelope = JSON.parse(line); const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64')); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const event = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
        if (event.kind === 'receipt') this.receipts.set(event.value.effectId, event.value);
        if (event.kind === 'observation') this.observations.set(event.value.id,event.value);
        if (event.kind === 'ack') this.observations.delete(event.value.id);
        if (event.kind === 'attributionHold') {this.observations.delete(event.value.id);this.attributionHolds.set(event.value.id,event.value);}
        if (event.kind === 'attributionRelease') {this.attributionHolds.delete(event.value.id);this.observations.set(event.value.id,event.value);}
      }
    })();
  }
  private async write(kind: string, value: unknown): Promise<void> {
    const next = this.chain.then(async () => {
      await this.init(); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify({ kind, value }), 'utf8'), cipher.final()]);
      const handle = await open(join(this.directory, 'telegram.enc.jsonl'), 'a', 0o600);
      try { await handle.write(JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n'); await handle.sync(); } finally { await handle.close(); }
      if (kind === 'receipt') { const r = value as TelegramReceipt; this.receipts.set(r.effectId, structuredClone(r)); }
      if(kind==='observation'){const o=value as Observation;this.observations.set(o.id,structuredClone(o));}
      if(kind==='ack')this.observations.delete((value as {id:string}).id);
      if(kind==='attributionHold'){const o=value as Observation;this.observations.delete(o.id);this.attributionHolds.set(o.id,structuredClone(o));}
      if(kind==='attributionRelease'){const o=value as Observation;this.attributionHolds.delete(o.id);this.observations.set(o.id,structuredClone(o));}
    });
    this.chain = next; return next; // A failed durable write poisons this generation, never falls back to memory.
  }
  async get(effectId: string): Promise<TelegramReceipt | undefined> { await this.init(); await this.chain; const r = this.receipts.get(effectId); return r ? structuredClone(r) : undefined; }
  put(receipt: TelegramReceipt): Promise<void> { return this.write('receipt', receipt); }
  append(observation: Observation): Promise<void> { return this.write('observation', observation); }
  async pending(limit:number):Promise<Observation[]>{await this.init();await this.chain;return [...this.observations.values()].slice(0,limit).map(o=>structuredClone(o));}
  acknowledge(id:string):Promise<void>{return this.write('ack',{id});}
  async findMessage(peerId: string, messageId: string): Promise<TelegramReceipt | undefined> { await this.init(); await this.chain; return [...this.receipts.values()].find(r => isTelegramSendReceipt(r) && r.peerId === peerId && (r.tempMessageId === messageId || r.messageId === messageId)); }
  async findSending(sendingId: number): Promise<TelegramReceipt | undefined> { await this.init(); await this.chain; return [...this.receipts.values()].find(r => r.sendingId === sendingId); }
  async unmappedSends(peerId:string):Promise<TelegramReceipt[]>{await this.init();await this.chain;return [...this.receipts.values()].filter(r=>isTelegramSendReceipt(r)&&r.peerId===peerId&&['dispatching','unknown'].includes(r.state)&&!r.tempMessageId&&!r.messageId).map(r=>structuredClone(r));}
  holdAttribution(observation:Observation):Promise<void>{return this.write('attributionHold',observation);}
  async heldAttribution():Promise<Observation[]>{await this.init();await this.chain;return [...this.attributionHolds.values()].map(o=>structuredClone(o));}
  releaseAttribution(observation:Observation):Promise<void>{return this.write('attributionRelease',observation);}
}
