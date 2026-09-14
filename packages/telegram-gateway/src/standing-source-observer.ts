import { createHash, randomUUID } from "node:crypto";
import { Api, utils } from "telegram";
import type { PilotBinding } from "./pilot-telegram-adapter.js";
import type { SourceObservationMessage, StandingSourceArchive } from "./standing-source-archive.js";

export class StandingSourceObserverError extends Error {
  readonly code = "checkpoint";
  constructor() { super("STANDING_SOURCE_OBSERVER_REFUSED_OR_UNKNOWN"); }
}
const fail = (): never => { throw new StandingSourceObserverError(); };
const positive = (value: unknown, max = 2147483647): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;
const text = (value: unknown, cap: number): value is string => typeof value === "string" && Buffer.byteLength(value,"utf8") <= cap &&
  !value.includes("\0") && Buffer.from(value,"utf8").toString("utf8") === value;
const samePeer = (value: unknown, peer: string) => { try { return utils.getPeerId(value as Api.TypePeer) === peer; } catch { return false; } };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type ObservationResult = Readonly<{ stored: number; unchanged: number; excluded: number; completeChat: false }>;

/** Copies only available message text/captions from the already owned group's
 * Messages envelopes. No invoke, downloads, model calls, extra client or polling.
 * The archive owns durable observations; this bounded hash cache only reduces
 * repeated context reads. Eviction/restart may retain another observation and
 * never suppress a changed message. Media bytes and unavailable messages are
 * not reconstructed. Source text remains untrusted data.
 */
export function createStandingSourceObserver(input: {
  binding: PilotBinding; archive: Pick<StandingSourceArchive,"append">;
  now?: () => number;
}): Readonly<{ observe(envelope: unknown, signal: AbortSignal): Promise<ObservationResult>; close(): Promise<void> }> {
  const binding = Object.freeze({...input.binding}), append = input.archive.append.bind(input.archive), now = input.now ?? (()=>Math.floor(Date.now()/1000));
  if (!/^[1-9]\d{0,19}$/.test(binding.accountId) || !/^-[1-9]\d{0,19}$/.test(binding.peerId)) return fail();
  const seen = new Map<number,string>();
  let closed = false, active: Promise<ObservationResult> | undefined;
  const check = (signal: AbortSignal) => { if(closed || signal.aborted) fail(); };
  function project(value: Api.TypeMessage, users: Api.TypeUser[], chats: Api.TypeChat[]): SourceObservationMessage | undefined {
    if (!(value instanceof Api.Message) || !positive(value.id) || !samePeer(value.peerId,binding.peerId) ||
        !positive(value.date,253402300799) || !text(value.message,16384) ||
        (value.ttlPeriod !== undefined && value.ttlPeriod !== null) ||
        (value.media && "ttlSeconds" in value.media && value.media.ttlSeconds !== undefined && value.media.ttlSeconds !== null)) return;
    let authorId: string, authorKind: SourceObservationMessage["authorKind"], authorName = "Неизвестный участник";
    if (value.fromId instanceof Api.PeerUser) {
      authorId=value.fromId.userId.toString();authorKind="user";
      if (!!value.out !== (authorId===binding.accountId)) return;
      const authors=users.filter(u=>u.id.toString()===authorId);
      if(authors.length>1) return;
      if(authors[0] instanceof Api.User) {
        if(authors[0].self && authorId!==binding.accountId) return;
        const name=[authors[0].firstName,authors[0].lastName].filter(v=>typeof v==="string" && v.length>0).join(" ");
        if(name) authorName=name;
      }
    } else if(value.fromId instanceof Api.PeerChat || value.fromId instanceof Api.PeerChannel) {
      authorKind=value.fromId instanceof Api.PeerChat?"chat":"channel";
      authorId=(value.fromId instanceof Api.PeerChat?value.fromId.chatId:value.fromId.channelId).toString();
      const authors=chats.filter(c=>c.id.toString()===authorId && (authorKind==="chat"?c instanceof Api.Chat:c instanceof Api.Channel));
      if(authors.length>1) return;
      const author=authors[0];if(author instanceof Api.Chat || author instanceof Api.Channel)authorName=author.title;
    } else return;
    if(!/^[1-9]\d{0,19}$/.test(authorId) || !text(authorName,1024)) return;
    const editedAt=value.editDate??null;
    if(editedAt!==null && (!positive(editedAt,253402300799) || editedAt<value.date)) return;
    const reply=value.replyTo;
    // A foreign or inaccessible reply remains absent; it never grants another peer.
    const replyId=reply instanceof Api.MessageReplyHeader && !reply.replyToScheduled && positive(reply.replyToMsgId) && reply.replyToMsgId<value.id &&
      (!reply.replyToPeerId || samePeer(reply.replyToPeerId,binding.peerId))?reply.replyToMsgId:null;
    const contentKind: SourceObservationMessage["contentKind"] = !value.media || value.media instanceof Api.MessageMediaEmpty ? "text" :
      value.media instanceof Api.MessageMediaPhoto ? "photo-caption" : value.media instanceof Api.MessageMediaDocument ? "document-caption" : "other-caption";
    return Object.freeze({messageId:value.id,authorId,authorKind,authorName,date:value.date,editedAt,replyToMessageId:replyId,text:value.message,contentKind});
  }
  async function capture(envelope: unknown, signal: AbortSignal): Promise<ObservationResult> {
    check(signal);
    if(!(envelope instanceof Api.messages.Messages || envelope instanceof Api.messages.MessagesSlice || envelope instanceof Api.messages.ChannelMessages))
      return Object.freeze({stored:0,unchanged:0,excluded:0,completeChat:false});
    if(envelope.messages.length>100 || envelope.users.length>200 || envelope.chats.length>100) return fail();
    const observedAt=now();if(!positive(observedAt,253402300799))return fail();
    let excluded=0,unchanged=0,stored=0;
    const ids=new Set<number>(), projected: SourceObservationMessage[]=[];
    for(const value of envelope.messages){
      const message=project(value,envelope.users,envelope.chats);
      if(!message){excluded++;continue;}
      if(ids.has(message.messageId))return fail();ids.add(message.messageId);
      if(seen.get(message.messageId)===hash(message)){unchanged++;continue;}
      projected.push(message);
    }
    // Copy all source fields before the first await. Keep each encrypted batch
    // inside the archive's plaintext cap even for large Unicode messages.
    while(projected.length){
      const messages:SourceObservationMessage[]=[];let used=512;
      while(projected.length && used+Buffer.byteLength(JSON.stringify(projected[0]),"utf8")+1<=250000){
        const message=projected.shift()!;messages.push(message);used+=Buffer.byteLength(JSON.stringify(message),"utf8")+1;
      }
      if(!messages.length)return fail();check(signal);
      await append({captureId:randomUUID(),observedAt,messages},signal);check(signal);
      for(const message of messages){seen.delete(message.messageId);seen.set(message.messageId,hash(message));stored++;}
      while(seen.size>2048)seen.delete(seen.keys().next().value!);
    }
    return Object.freeze({stored,unchanged,excluded,completeChat:false});
  }
  return Object.freeze({
    async observe(envelope: unknown,signal:AbortSignal):Promise<ObservationResult>{
      check(signal);if(active)return fail();
      let resolve!:(value:ObservationResult)=>void,reject!:(error:unknown)=>void;
      const running=new Promise<ObservationResult>((done,failed)=>{resolve=done;reject=failed;});active=running;
      // Reserve ownership before projecting synchronously; callers cannot mutate
      // an admitted envelope in the microtask gap before its fields are copied.
      void capture(envelope,signal).then(resolve,reject);
      try{return await running;}catch{throw new StandingSourceObserverError();}
      finally{if(active===running)active=undefined;}
    },
    async close(){closed=true;seen.clear();try{await active;}catch{/* Caller observes operation outcome separately. */}}
  });
}
