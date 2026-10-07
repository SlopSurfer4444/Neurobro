import { createHash, randomInt, randomUUID } from 'node:crypto';
import { copyFile, stat } from 'node:fs/promises';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import type { Attachment, Effect, EffectResult, Json, MessageRef, Observation, TelegramMessageDetails, TelegramPollOptionDetails, TelegramReactionDetails, TelegramPeer, TelegramPort, TelegramPostAuthor } from '../contracts.ts';
import { TdRequestError, safeTdErrorReason, type TdJsonTransport, type TdObject } from './transport.ts';
import type { TelegramObservationStore, TelegramReceipt, TelegramReceiptStore } from './store.ts';
import { isTelegramSendReceipt } from './store.ts';
import { validateTdObject } from './schema.ts';
import { EFFECT_METHODS, READ_METHODS, effectRequest, readRequest } from './requests.ts';
import { forwardOrigin, messageReference, parsePeerSelector, peerMetadata } from './identity.ts';
import { canonicalFolder, folderId, folderVersion, folderView, folderSnapshotView, newFolder, patchFolder } from './folders.ts';
import { inspectPeer, relatedChannels } from './exploration.ts';
import { TelegramChatInventory } from './inventory.ts';
export * from './transport.ts'; export * from './store.ts'; export * from './schema.ts';
const sid = (value: unknown): string => { if (typeof value === 'string' && /^-?\d+$/.test(value)) return value; if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value); throw new Error('missing or lossy Telegram identity'); };
const stamp = (v: unknown): string => new Date(Number(v ?? 0) * 1000).toISOString();
const record = (v: unknown): TdObject => v && typeof v === 'object' && !Array.isArray(v) ? v as TdObject : {};
/** Native UTF-16 entity provenance is authority data, separate from visible text. */
function authorityTextRanges(formatted:TdObject):{offset:number;length:number;kind:'quote'|'code'}[]|undefined{
  const source=formatted.text;if(typeof source!=='string'||!source.length)return undefined;
  const ranges:{offset:number;length:number;kind:'quote'|'code'}[]=[];
  if(!Array.isArray(formatted.entities))return undefined;
  for(const entity of formatted.entities){const type=record(record(entity).type)['@type'];
    const kind=['textEntityTypeBlockQuote','textEntityTypeExpandableBlockQuote'].includes(type)?'quote':['textEntityTypeCode','textEntityTypePre','textEntityTypePreCode'].includes(type)?'code':undefined;
    if(!kind)continue;
    if(ranges.length>=1000||!Number.isSafeInteger(entity.offset)||!Number.isSafeInteger(entity.length)||entity.offset<0||entity.length<=0||entity.offset+entity.length>source.length)return[{offset:0,length:source.length,kind:'quote'}];
    ranges.push({offset:entity.offset,length:entity.length,kind});
  }
  return ranges.length?ranges.sort((a,b)=>a.offset-b.offset||a.length-b.length):undefined;
}
/** Only native message fields needed to read current state; never button payloads or voter identities. */
function messageDetails(message:TdObject):TelegramMessageDetails|undefined {
  let truncated=false;
  const text=(value:unknown,limit:number):string=>{const source=typeof value==='string'?value:'';if(source.length<=limit)return source;truncated=true;const cut=source.slice(0,limit);return /[\uD800-\uDBFF]$/.test(cut)?cut.slice(0,-1):cut;};
  const count=(value:unknown):number|undefined=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=2147483647?value:undefined;
  const bool=(value:unknown):boolean|undefined=>typeof value==='boolean'?value:undefined;
  const bounded=(value:unknown,limit:number):unknown[]=>{if(!Array.isArray(value))return[];if(value.length>limit)truncated=true;return value.slice(0,limit);};
  const details:{poll?:TelegramMessageDetails['poll'];buttons?:TelegramMessageDetails['buttons'];keyboardType?:'inline'|'reply';reactions?:TelegramMessageDetails['reactions'];truncated?:true}={};
  const content=record(message.content),poll=record(content.poll);
  if(content['@type']==='messagePoll'&&poll.id!==undefined){
    const resultsAvailable=bool(poll.can_see_results),options:TelegramPollOptionDetails[]=[];
    for(const [index,value]of bounded(poll.options,100).entries()){
      const option=record(value);if(typeof option.id!=='string')continue;if(option.id.length>256){truncated=true;continue;}
      const votes=resultsAvailable===false?undefined:count(option.voter_count),chosen=bool(option.is_chosen);
      options.push({id:option.id,index,text:text(record(option.text).text,1024),...(votes!==undefined?{votes}:{}),...(chosen!==undefined?{chosen}:{})});
    }
    const type=record(poll.type),quiz=type['@type']==='pollTypeQuiz'?true:type['@type']==='pollTypeRegular'?false:undefined;
    const anonymous=bool(poll.is_anonymous),closed=bool(poll.is_closed),multiple=bool(poll.allows_multiple_answers),totalVotes=count(poll.total_voter_count);
    const correctOptionIds=quiz?bounded(type.correct_option_ids,100).filter((v):v is number=>typeof v==='number'&&Number.isInteger(v)&&options.some(option=>option.index===v)):undefined;
    details.poll={pollId:sid(poll.id),question:text(record(poll.question).text,4096),options,...(anonymous!==undefined?{anonymous}:{}),...(closed!==undefined?{closed}:{}),...(quiz!==undefined?{quiz}:{}),...(multiple!==undefined?{multiple}:{}),...(totalVotes!==undefined?{totalVotes}:{}),...(resultsAvailable!==undefined?{resultsAvailable}:{}),...(correctOptionIds?{correctOptionIds}:{})};
  }
  const markup=record(message.reply_markup);
  if(['replyMarkupInlineKeyboard','replyMarkupShowKeyboard'].includes(markup['@type'])){
    details.keyboardType=markup['@type']==='replyMarkupInlineKeyboard'?'inline':'reply';
    const buttons:{row:number;column:number;label:string;type:string}[]=[];
    for(const [row,values]of bounded(markup.rows,32).entries())for(const [column,value]of bounded(values,16).entries()){
      if(buttons.length>=128){truncated=true;break;}
      const button=record(value),type=record(button.type)['@type'];if(typeof type!=='string'||! /^(inlineKeyboardButtonType|keyboardButtonType)[A-Za-z]+$/.test(type))continue;if(type.length>128){truncated=true;continue;}
      buttons.push({row,column,label:text(button.text,256),type});
    }
    details.buttons=buttons;
  }
  const nativeReactions=record(record(message.interaction_info).reactions);
  if(Array.isArray(nativeReactions.reactions)){
    const reactions:TelegramReactionDetails[]=[];
    for(const value of bounded(nativeReactions.reactions,64)){
      const reaction=record(value),nativeType=record(reaction.type),type=nativeType['@type'];const total=count(reaction.total_count),chosen=bool(reaction.is_chosen),common={...(total!==undefined?{count:total}:{}),...(chosen!==undefined?{chosen}:{})};
      if(type==='reactionTypeEmoji')reactions.push({type:'emoji',emoji:text(nativeType.emoji,64),...common});
      else if(type==='reactionTypeCustomEmoji')reactions.push({type:'custom-emoji',customEmojiId:sid(nativeType.custom_emoji_id),...common});
      else if(type==='reactionTypePaid')reactions.push({type:'paid',...common});
    }
    details.reactions=reactions;
  }
  if(!Object.keys(details).length)return undefined;if(truncated)details.truncated=true;return details;
}
export interface TdlibTelegramOptions { accountId: string; transport: TdJsonTransport; receipts: TelegramReceiptStore; spool?: TelegramObservationStore; maxQueuedObservations?: number; sendWaitMs?: number; folderReadyWaitMs?:number }
/** Trusted host adapter. Broker controls grants; TDLib requests never enter the model tool registry. */
export class TdlibTelegram implements TelegramPort {
  private queue: Observation[] = []; private wakes = new Set<() => void>(); private closed = false;
  private fault?: Error; private transportFault?:Error; private chain = Promise.resolve(); private consuming = false;
  private cached = new Map<string, TdObject>(); private fileTokens = new Map<string,{fileId:string;ref:MessageRef}>();
  private topics=new Map<string,TdObject>();
  private terminalWakes = new Map<string,Set<() => void>>();
  private unmatchedTerminal = new Map<string,TdObject>();
  private attributionHolds=new Map<string,Observation>();
  private coverage: 'snapshot-only'|'gap' = 'snapshot-only';
  private readonly options:TdlibTelegramOptions;private accountVerified=false;
  private folderDispatchTail:Promise<unknown>=Promise.resolve();
  private folderSnapshot?:TdObject;private folderSnapshotError?:Error;private folderGeneration=0;private folderRevision=0;private folderWakes=new Set<()=>void>();
  private readonly inventory:TelegramChatInventory;
  constructor(options:TdlibTelegramOptions) {
    this.options=options;
    this.inventory=new TelegramChatInventory(options.accountId,request=>this.invoke(request,{timeoutMs:10000}));
    if (!options.accountId) throw new Error('account binding required');
    if(options.folderReadyWaitMs!==undefined&&(!Number.isInteger(options.folderReadyWaitMs)||options.folderReadyWaitMs<0||options.folderReadyWaitMs>10000))throw new Error('invalid Telegram folder readiness deadline');
    options.transport.on('gap', () => { this.coverage = 'gap';this.accountVerified=false;this.invalidateFolders();this.inventory.invalidate(); });
    options.transport.on('fault', () => { this.coverage = 'gap';if(!this.closed){this.accountVerified=false;this.transportFault??=new Error('Telegram transport failed; connection coverage is incomplete');this.wake();}this.invalidateFolders();this.inventory.invalidate(); });
    options.transport.on('update', value => {
      // Empty folder lists are omitted from getCurrentState by TDLib. Retain the
      // actual startup/change update before any unrelated async intake work.
      if(value['@type']==='updateChatFolders')this.captureFolderSnapshot(value);
      this.inventory.capture(value);
      this.chain = this.chain.then(() => this.update(value)).catch(error => { this.fault = error; this.wake(); });
    });
  }
  /** Honest application coverage: ordered receive does not prove complete crash replay. */
  status(): { coverage: 'snapshot-only'|'gap'; buffered: number; attributionHeld:number; attributionDiagnostic?:string; fault?: string } { const fault=this.fault??this.transportFault;return { coverage:this.coverage,buffered:this.queue.length,attributionHeld:this.attributionHolds.size,...(this.attributionHolds.size?{attributionDiagnostic:'Outgoing source withheld: unresolved send has no durable native message mapping'}:{}),...(fault ? {fault:fault.message}:{}) }; }
  async invoke(request: TdObject, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<TdObject> { validateTdObject(request); return this.options.transport.invoke(request,options); }
  async verifyAccount():Promise<void>{if(this.accountVerified)return;const me=await this.invoke({'@type':'getMe'});if(sid(me.id)!==this.options.accountId)throw new Error('TDLib authorized account does not match configured owner');this.accountVerified=true;}
  async authStatus():Promise<TdObject>{return this.invoke({'@type':'getAuthorizationState'});}
  async configureParameters(config:{databaseDirectory:string;filesDirectory:string;apiId:number;apiHash:string;databaseEncryptionKey:string}):Promise<void>{await this.invoke({'@type':'setTdlibParameters',use_test_dc:false,database_directory:config.databaseDirectory,files_directory:config.filesDirectory,database_encryption_key:config.databaseEncryptionKey,use_file_database:true,use_chat_info_database:true,use_message_database:true,use_secret_chats:false,api_id:config.apiId,api_hash:config.apiHash,system_language_code:'ru',device_model:'Neurobro Personal',system_version:process.platform,application_version:'0.1.0'});}
  async submitAuth(request:TdObject):Promise<void>{if(!['setAuthenticationPhoneNumber','checkAuthenticationCode','checkAuthenticationPassword','checkAuthenticationEmailCode','setAuthenticationEmailAddress','requestQrCodeAuthentication'].includes(request['@type']))throw new Error('unsupported owner authorization step');await this.invoke(request);}
  async acknowledgeObservation(id:string):Promise<void>{await this.options.spool?.acknowledge?.(id);}
  private wake(): void { for (const wake of this.wakes) wake(); this.wakes.clear(); }
  private wakeFolders():void{for(const wake of this.folderWakes)wake();this.folderWakes.clear();}
  private invalidateFolders():void{this.folderSnapshot=undefined;this.folderSnapshotError=undefined;this.folderGeneration++;this.folderRevision++;this.wakeFolders();}
  private captureFolderSnapshot(update:TdObject):void{this.folderRevision++;try{this.folderSnapshot=folderSnapshotView(update);this.folderSnapshotError=undefined;}catch(error){this.folderSnapshot=undefined;this.folderSnapshotError=error instanceof Error?error:new Error('invalid Telegram folder snapshot');}this.wakeFolders();}
  private async readFolders():Promise<Json>{
    const generation=this.folderGeneration,revision=this.folderRevision;
    const state=await this.invoke({'@type':'getCurrentState'});if(state['@type']!=='updates'||!Array.isArray(state.updates))throw new Error('Telegram folder snapshot unavailable');
    if(generation!==this.folderGeneration||this.closed)return{status:'unavailable',reason:'Telegram folder snapshot connection changed; no empty-list claim'};
    const snapshots=state.updates.filter((value:TdObject)=>value['@type']==='updateChatFolders');if(snapshots.length>1)throw new Error('ambiguous Telegram folder snapshot');
    if(snapshots.length){const snapshot=folderSnapshotView(snapshots[0]);if(revision===this.folderRevision){this.folderSnapshot=snapshot;this.folderSnapshotError=undefined;}}
    if(!this.folderSnapshot&&!this.folderSnapshotError){await new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);this.folderWakes.delete(done);resolve();};const timer=setTimeout(done,this.options.folderReadyWaitMs??5000);this.folderWakes.add(done);
      if(this.folderSnapshot||this.folderSnapshotError||generation!==this.folderGeneration||this.closed)done();
    });}
    if(generation!==this.folderGeneration||this.closed)return{status:'unavailable',reason:'Telegram folder snapshot connection changed; no empty-list claim'};
    if(this.folderSnapshotError)throw this.folderSnapshotError;
    return this.folderSnapshot?structuredClone(this.folderSnapshot) as Json:{status:'unavailable',reason:'Telegram folder startup update missing after bounded readiness wait; no empty-list claim'};
  }
  private async emit(observation: Observation): Promise<void> {
    if(await this.ambiguousAttribution(observation)){
      if(this.attributionHolds.size>=(this.options.maxQueuedObservations??1000)&&!this.attributionHolds.has(observation.id))throw new Error('Telegram attribution hold overflow: native send reconciliation required');
      if(this.options.spool&&!this.options.spool.holdAttribution)throw new Error('Telegram observation store cannot durably hold unresolved send attribution');
      await this.options.spool?.holdAttribution?.(observation);this.attributionHolds.set(observation.id,observation);this.coverage='gap';return;
    }
    await this.options.spool?.append(observation);
    if (this.queue.length >= (this.options.maxQueuedObservations ?? 1000)) { this.coverage='gap'; throw new Error('Telegram intake queue overflow: snapshot reconciliation required'); }
    this.queue.push(observation); this.wake();
  }
  private async ambiguousAttribution(observation:Observation):Promise<boolean>{
    if(!observation.outgoing||observation.authorId!==this.options.accountId||observation.agentEffectId)return false;
    if(await this.ownReceipt(observation.ref.peerId,observation.ref.messageId))return false;
    return !!(await this.options.receipts.unmappedSends?.(observation.ref.peerId))?.length;
  }
  private async ownReceipt(peerId:string,messageId:string):Promise<TelegramReceipt|undefined>{const receipt=await this.options.receipts.findMessage(peerId,messageId);return receipt&&isTelegramSendReceipt(receipt)&&receipt.peerId===peerId&&(receipt.tempMessageId===messageId||receipt.messageId===messageId)?receipt:undefined;}
  private async releaseAttributionHolds():Promise<void>{
    for(const observation of await this.options.spool?.heldAttribution?.()??[])this.attributionHolds.set(observation.id,observation);
    for(const [id,observation] of this.attributionHolds){
      if(await this.ambiguousAttribution(observation)){this.coverage='gap';continue;}
      const own=await this.ownReceipt(observation.ref.peerId,observation.ref.messageId);
      const released={...observation,...(own?{agentEffectId:own.effectId}:{})};
      if(this.queue.length>=(this.options.maxQueuedObservations??1000))throw new Error('Telegram intake queue overflow: snapshot reconciliation required');
      if(this.options.spool&&!this.options.spool.releaseAttribution)throw new Error('Telegram observation store cannot durably release attribution hold');
      await this.options.spool?.releaseAttribution?.(released);this.attributionHolds.delete(id);this.queue.push(released);this.wake();
    }
  }
  async *observations(signal: AbortSignal): AsyncIterable<Observation> {
    if (this.consuming) throw new Error('one Telegram observation consumer required'); this.consuming=true;
    try {
      await this.verifyAccount();
      this.chain=this.chain.then(()=>this.releaseAttributionHolds());await this.chain;
      const replayed=new Set<string>();
      while(this.options.spool?.pending){
        const replay=(await this.options.spool.pending(this.options.maxQueuedObservations??1000)).filter(o=>!replayed.has(o.id));if(!replay.length)break;
        for(const observation of replay){if(signal.aborted||this.closed)return;replayed.add(observation.id);if(!this.queue.some(o=>o.id===observation.id)){if(await this.ambiguousAttribution(observation))await this.emit(observation);else{const own=await this.ownReceipt(observation.ref.peerId,observation.ref.messageId);yield {...observation,...(own?{agentEffectId:own.effectId}:{})};}}}
      }
      while (!signal.aborted && !this.closed) {
        if (this.fault||this.transportFault) throw this.fault??this.transportFault;
        const value = this.queue.shift(); if (value) { yield value; continue; }
        await new Promise<void>(resolve => { const wake = () => { signal.removeEventListener('abort',wake);this.wakes.delete(wake);resolve(); };this.wakes.add(wake);signal.addEventListener('abort',wake,{once:true});if(signal.aborted)wake(); });
      }
    } finally { this.consuming=false; }
  }
  private key(chatId:string,messageId:string): string { return `${chatId}/${messageId}`; }
  private assertSendOwnership(message:TdObject,peerId:string):void{
    const sender=record(message.sender_id);
    // TDLib represents an own channel post as messageSenderChat. No capability
    // here authorizes selecting an unrelated send-as identity.
    if(message.is_outgoing!==true||(sender['@type']==='messageSenderUser'?sid(sender.user_id)!==this.options.accountId:sender['@type']==='messageSenderChat'?sid(sender.chat_id)!==peerId:true))throw new Error('Telegram send ownership mismatch');
  }
  private async normalize(message: TdObject, kind: 'message'|'edit' = 'message'): Promise<Observation> {
    await this.verifyAccount();
    const peerId=sid(message.chat_id),messageId=sid(message.id),content=record(message.content),now=new Date().toISOString();
    const ref:MessageRef={accountId:this.options.accountId,peerId,messageId};
    const topic=record(message.topic_id); const thread=topic.message_thread_id ?? topic.forum_topic_id ?? topic.direct_messages_chat_topic_id ?? topic.saved_messages_topic_id; if (thread) {ref.threadId=sid(thread);this.topics.set(this.key(peerId,ref.threadId),topic);}
    const formatted=typeof record(content.text).text==='string'?record(content.text):record(content.caption),textValue=formatted.text,authorityRanges=authorityTextRanges(formatted);
    const own=await this.ownReceipt(peerId,messageId);
    const attachments: Attachment[]=[];
    const protectedMedia = message.can_be_saved === false || message.self_destruct_type || Number(message.self_destruct_in ?? 0) > 0 || content.is_secret;
    if (!protectedMedia) {
      const objects:TdObject[] = [];
      for (const field of ['document','audio','video','voice_note','animation','sticker','video_note']) { const media=record(content[field]);const file=record(media[field==='voice_note'?'voice':field==='video_note'?'video':field]);if(file.id)objects.push({...file,name:media.file_name,mime:media.mime_type}); }
      const sizes=record(content.photo).sizes;if(Array.isArray(sizes)&&sizes.length)objects.push({...record(sizes[sizes.length-1].photo),name:'photo.jpg',mime:'image/jpeg'});
      for(const file of objects){const fileId=sid(file.id),token=randomUUID();this.fileTokens.set(token,{fileId,ref});if(this.fileTokens.size>5000)this.fileTokens.delete(this.fileTokens.keys().next().value!);attachments.push({id:fileId,name:file.name ?? `${content['@type']}-${fileId}`,mimeType:file.mime ?? 'application/octet-stream',size:Number(file.size??0),transportRef:token});}
    }
    const details=messageDetails(message);
    const reply=record(message.reply_to);const revision=createHash('sha256').update(JSON.stringify({content,editDate:message.edit_date,reply,topic,replyMarkup:message.reply_markup,forwardInfo:message.forward_info,messageDetails:details,reactions:record(message.interaction_info).reactions})).digest('hex');
    const observation:Observation={id:`${this.options.accountId}/${peerId}/${messageId}/${kind}/${revision}`,kind,ref,outgoing:!!message.is_outgoing, sentAt:stamp(message.date),observedAt:now,...(Number(message.edit_date)>0?{editedAt:stamp(message.edit_date)}:{}),version:revision,forwarded:!!(message.forward_info||message.import_info),viaBot:String(message.via_bot_user_id??'0')!=='0',...(typeof textValue==='string'?{text:textValue}:{}),...(authorityRanges?{authorityTextRanges:authorityRanges}:{}),...(attachments.length?{attachments}:{}),...(own?{agentEffectId:own.effectId}:{})};
    const sender=record(message.sender_id);if(sender['@type']==='messageSenderUser')observation.authorId=sid(sender.user_id);
    const origin=forwardOrigin(message,this.options.accountId);if(origin)observation.forwardOrigin=origin;
    if(details)observation.messageDetails=details;
    if(reply['@type']==='messageReplyToMessage'&&reply.message_id)observation.replyTo={accountId:this.options.accountId,peerId:sid(reply.chat_id??peerId),messageId:sid(reply.message_id)};
    this.cached.set(this.key(peerId,messageId),message);if(this.cached.size>5000)this.cached.delete(this.cached.keys().next().value!);return observation;
  }
  private async update(update: TdObject): Promise<void> {
    switch(update['@type']) {
      case 'updateNewMessage': { const m=update.message; const sendingId=m.sending_state?.sending_id; if(sendingId&&this.options.receipts.findSending){const r=await this.options.receipts.findSending(sendingId);if(r&&isTelegramSendReceipt(r)&&r.peerId===sid(m.chat_id)&&!['verified','failed'].includes(r.state)&&!r.messageId)await this.options.receipts.put({...r,state:'pending',tempMessageId:r.tempMessageId??sid(m.id)});}await this.emit(await this.normalize(m));break; }
      case 'updateMessageSendSucceeded': case 'updateMessageSendFailed': {
        const m=update.message,peerId=sid(m.chat_id),oldId=sid(update.old_message_id);
        const candidate=await this.options.receipts.findMessage(peerId,oldId) ?? (m.sending_state?.sending_id&&this.options.receipts.findSending ? await this.options.receipts.findSending(m.sending_state.sending_id):undefined);
        const receipt=candidate&&isTelegramSendReceipt(candidate)&&candidate.peerId===peerId?candidate:undefined;
        if(receipt){const code=update.error?.code,reason=safeTdErrorReason(update.error?.message);const terminal=['verified','failed'].includes(receipt.state);
          // Late/duplicate terminal frames cannot replace an already reconciled
          // final identity with a temporary failed-message identity.
          if(terminal&&receipt.messageId&&receipt.messageId!==sid(m.id))this.coverage='gap';
          else {const next:TelegramReceipt={...receipt,state:terminal?receipt.state:update['@type']==='updateMessageSendSucceeded'?'pending':'failed',tempMessageId:oldId,messageId:sid(m.id),detail:{...record(receipt.detail),terminalUpdate:update['@type'],...(Number.isSafeInteger(code)&&code>=0&&code<=2147483647?{code}:{}),...(reason?{nativeReason:reason}:{})}};await this.options.receipts.put(next);for(const wake of this.terminalWakes.get(receipt.effectId)??[])wake();}}
        else {if(this.unmatchedTerminal.size>=1000)throw new Error('unmatched native send mappings exceeded bound');this.unmatchedTerminal.set(this.key(peerId,oldId),update);this.coverage='gap';return;}
        await this.emit(await this.normalize(m));break;
      }
      case 'updateMessageContent': case 'updateMessageEdited': case 'updateMessageInteractionInfo': {
        const peerId=sid(update.chat_id),messageId=sid(update.message_id);let m=this.cached.get(this.key(peerId,messageId));
        if(!m){try{m=await this.invoke({'@type':'getMessage',chat_id:peerId,message_id:messageId});}catch{this.coverage='gap';return;}}
        if(sid(m.chat_id)!==peerId||sid(m.id)!==messageId)throw new Error('Telegram update readback identity mismatch');
        m={...m,...(update.new_content?{content:update.new_content}:{}),...(update.edit_date!==undefined?{edit_date:update.edit_date}:{}),...(update.reply_markup!==undefined?{reply_markup:update.reply_markup}:{}),...(update.interaction_info!==undefined?{interaction_info:update.interaction_info}:{})};await this.emit(await this.normalize(m,'edit'));break;
      }
      case 'updateDeleteMessages': if(update.is_permanent&&!update.from_cache)for(const id of update.message_ids){const peerId=sid(update.chat_id),messageId=sid(id);const old=this.cached.get(this.key(peerId,messageId));this.cached.delete(this.key(peerId,messageId));await this.emit({id:`${this.options.accountId}/${peerId}/${messageId}/delete`,kind:'delete',ref:{accountId:this.options.accountId,peerId,messageId},outgoing:!!old?.is_outgoing,authorId:old?.sender_id?.['@type']==='messageSenderUser'?sid(old.sender_id.user_id):undefined,sentAt:stamp(old?.date),observedAt:new Date().toISOString()});}break;
      case 'updateConnectionState': if(update.state?.['@type']!=='connectionStateReady')this.coverage='gap';break;
      case 'updateAuthorizationState': if(update.authorization_state?.['@type']==='authorizationStateReady')await this.verifyAccount();else this.accountVerified=false;break;
    }
    await this.releaseAttributionHolds();
  }
  async readHistory(peerId:string,options:{before?:string;limit:number;query?:string}):Promise<Observation[]> {
    if(!Number.isInteger(options.limit)||options.limit<1||options.limit>100)throw new Error('Telegram history limit must be 1..100');
    await this.verifyAccount();
    const response=await this.invoke(readRequest(options.query?'telegram.search':'telegram.history.read',sid(peerId),options));
    const result:Observation[]=[];for(const m of response.messages??[]){if(sid(m.chat_id)!==peerId)throw new Error('history escaped requested peer');if(options.before&&sid(m.id)===options.before)continue;result.push(await this.normalize(m));}return result;
  }
  async getMessage(ref:MessageRef):Promise<Observation|undefined>{if(ref.accountId!==this.options.accountId)throw new Error('cross-account Telegram reference');await this.verifyAccount();try{const m=await this.invoke({'@type':'getMessage',chat_id:sid(ref.peerId),message_id:sid(ref.messageId)});if(sid(m.chat_id)!==ref.peerId||sid(m.id)!==ref.messageId)throw new Error('Telegram readback identity mismatch');return this.normalize(m);}catch(e){if(e instanceof TdRequestError&&e.code===404)return undefined;throw e;}}
  async download(attachment:Attachment,destination:string):Promise<void>{const token=attachment.transportRef&&this.fileTokens.get(attachment.transportRef);if(!token||token.fileId!==attachment.id)throw new Error('unbound Telegram attachment');const source=await this.getMessage(token.ref),current=source?.attachments?.find(a=>a.id===token.fileId);if(!current)throw new Error('Telegram media protected, expired or removed');const file=await this.invoke({'@type':'downloadFile',file_id:token.fileId,priority:16,offset:0,limit:0,synchronous:true});if(sid(file.id)!==token.fileId||sid(file.size)!==String(current.size))throw new Error('Telegram downloaded file identity or size mismatch');if(!file.local?.is_downloading_completed||typeof file.local.path!=='string'||!file.local.path)throw new Error('Telegram media download incomplete');const local=await stat(file.local.path);if(!local.isFile()||local.size!==current.size)throw new Error('Telegram downloaded bytes incomplete');await copyFile(file.local.path,destination);}
  /** Metadata resolution is host data; the broker must separately authorize every read/effect. */
  async resolvePeer(selector:string):Promise<TelegramPeer>{
    await this.verifyAccount();const parsed=parsePeerSelector(selector);let chat:TdObject;let expectedUsername:string|undefined;
    if('peerId'in parsed){chat=await this.invoke({'@type':'getChat',chat_id:parsed.peerId});if(sid(chat.id)!==parsed.peerId)throw new Error('Telegram peer identity mismatch');}
    else if('username'in parsed){expectedUsername=parsed.username;const found=await this.invoke({'@type':'searchPublicChat',username:parsed.username});chat=await this.invoke({'@type':'getChat',chat_id:sid(found.id)});if(sid(chat.id)!==sid(found.id))throw new Error('Telegram peer identity mismatch');}
    else{expectedUsername=parsed.publicUsername;const link=await this.invoke({'@type':'getMessageLinkInfo',url:parsed.messageUrl});const peerId=sid(link.chat_id);if(peerId==='0')throw new Error('Telegram message link unavailable');if(link.message&&sid(link.message.chat_id)!==peerId)throw new Error('Telegram linked message identity mismatch');chat=await this.invoke({'@type':'getChat',chat_id:peerId});if(sid(chat.id)!==peerId)throw new Error('Telegram peer identity mismatch');}
    return peerMetadata(chat,this.options.accountId,request=>this.invoke(request),expectedUsername);
  }
  async resolveMessageLink(url:string):Promise<MessageRef|undefined>{
    await this.verifyAccount();const selector=parsePeerSelector(url);if(!('messageUrl'in selector))throw new Error('expected Telegram message link');
    const link=await this.invoke({'@type':'getMessageLinkInfo',url:selector.messageUrl});if(!link.message)return undefined;
    const ref=messageReference({...link.message,topic_id:link.message.topic_id??link.topic_id},this.options.accountId);if(ref.peerId!==sid(link.chat_id))throw new Error('Telegram linked message identity mismatch');return ref;
  }
  async resolvePostAuthor(ref:MessageRef):Promise<TelegramPostAuthor>{
    await this.verifyAccount();if(ref.accountId!==this.options.accountId)throw new Error('cross-account Telegram reference');
    let message:TdObject;try{message=await this.invoke({'@type':'getMessage',chat_id:sid(ref.peerId),message_id:sid(ref.messageId)});}catch(error){if(error instanceof TdRequestError&&error.code===404)return{unavailableReason:'post unavailable'};throw error;}
    if(sid(message.chat_id)!==ref.peerId||sid(message.id)!==ref.messageId)throw new Error('Telegram post identity mismatch');
    const sender=message.sender_id?.['@type']==='messageSenderUser'?{kind:'user' as const,userId:sid(message.sender_id.user_id)}:message.sender_id?.['@type']==='messageSenderChat'?{kind:'chat' as const,peerId:sid(message.sender_id.chat_id)}:undefined;
    const origin=forwardOrigin(message,this.options.accountId);const result:TelegramPostAuthor={...(sender?{sender}:{}),...(origin?{forwardOrigin:origin}:{})};
    if(message.forward_info||message.import_info){if(origin?.kind!=='user')return{...result,unavailableReason:origin?.kind==='hidden-user'?'forwarded author hidden by privacy':origin?'forwarded chat or channel has no individual author identity':'forwarded author identity unavailable'};}
    const userId=origin?.kind==='user'?origin.userId:sender?.kind==='user'?sender.userId:undefined;
    if(!userId)return{...result,unavailableReason:'post sent on behalf of a chat; no individual author identity'};
    const chat=await this.invoke({'@type':'createPrivateChat',user_id:userId,force:false});
    if(chat.type?.['@type']!=='chatTypePrivate'||sid(chat.type.user_id)!==userId)throw new Error('Telegram author private peer identity mismatch');
    return{...result,user:await peerMetadata(chat,this.options.accountId,request=>this.invoke(request))};
  }
  /** A contact user ID is not a guessed chat ID. Refresh and check both native bindings. */
  private async contactPeer(userId:string):Promise<TelegramPeer>{
    if(!/^[1-9]\d*$/.test(userId))throw new Error('invalid Telegram contact identity');
    const found=await this.invoke({'@type':'createPrivateChat',user_id:userId,force:false});
    if(found['@type']!=='chat'||found.type?.['@type']!=='chatTypePrivate'||sid(found.type.user_id)!==userId)throw new Error('Telegram contact private peer identity mismatch');
    const peer=await this.resolvePeer(sid(found.id));
    if(peer.userId!==userId||!['user','bot'].includes(peer.kind))throw new Error('Telegram contact refreshed identity mismatch');
    return peer;
  }
  private async discoverPeers(query:string,limit:number):Promise<Json>{
    const phoneLike=/^[+\d][\d ()-]*$/.test(query)&&(/[+() -]/.test(query));
    if(query.startsWith('+')||phoneLike){
      const phone=query.replace(/[ ()-]/g,'');
      if(!/^\+?[1-9]\d{6,14}$/.test(phone))throw new Error('Telegram phone search requires an international phone number');
      let user:TdObject|undefined;let source='phone-local';
      try{user=await this.invoke({'@type':'searchUserByPhoneNumber',phone_number:phone,only_local:true});}
      catch(error){if(!(error instanceof TdRequestError&&error.code===404))throw error;}
      if(!user){
        source='phone-server';
        try{user=await this.invoke({'@type':'searchUserByPhoneNumber',phone_number:phone,only_local:false});}
        catch(error){if(!(error instanceof TdRequestError&&error.code===404))throw error;}
      }
      if(!user)return{peers:[],matches:[],coverage:'bounded',truncated:false,selectionRequired:false};
      if(user['@type']!=='user')throw new Error('Telegram phone search returned invalid user');
      if(user.phone_number&&String(user.phone_number).replace(/[+ ()-]/g,'')!==phone.replace(/^\+/,''))throw new Error('Telegram phone search identity mismatch');
      const peer=await this.contactPeer(sid(user.id));
      return{peers:[peer],matches:[{peerId:peer.peerId,sources:[source]}],coverage:'bounded',truncated:false,selectionRequired:false} as unknown as Json;
    }
    if(query.startsWith('@')||/^https?:\/\//i.test(query)||/^-?[1-9]\d*$/.test(query)){
      const peer=await this.resolvePeer(query);
      return{peers:[peer],matches:[{peerId:peer.peerId,sources:['exact-selector']}],coverage:'bounded',truncated:false,selectionRequired:false} as unknown as Json;
    }
    const nativeLimit=limit+1;
    let truncated=false;
    const peers=new Map<string,TelegramPeer>(),users=new Map<string,string>(),sources=new Map<string,Set<string>>();
    const collect=async(response:TdObject,source:string,contact=false):Promise<void>=>{
      const field=contact?'user_ids':'chat_ids';
      if(response['@type']!==(contact?'users':'chats')||!Array.isArray(response[field]))throw new Error('Telegram discovery returned invalid native identities');
      const ids=[...new Set<string>(response[field].map(sid))];
      if(ids.some(id=>contact?!/^[1-9]\d*$/.test(id):id==='0'))throw new Error('Telegram discovery returned invalid native identity');
      if(ids.length>=nativeLimit||(typeof response.total_count==='number'&&response.total_count>ids.length))truncated=true;
      for(const id of ids.slice(0,nativeLimit)){
        const existing=contact?users.get(id):peers.has(id)?id:undefined;
        if(existing){sources.get(existing)!.add(source);continue;}
        // The extra candidate proves truncation without expanding unbounded metadata reads.
        if(peers.size>=nativeLimit){truncated=true;continue;}
        const peer=contact?await this.contactPeer(id):await this.resolvePeer(id);
        if(peers.has(peer.peerId)){sources.get(peer.peerId)!.add(source);continue;}
        peers.set(peer.peerId,peer);sources.set(peer.peerId,new Set([source]));
        if(peer.userId)users.set(peer.userId,peer.peerId);
      }
    };
    // Public search deliberately excludes chat-list peers and contacts in TDLib.
    const phases:{source:string;request:TdObject;contact?:true}[]=[
      {source:'known-chat',request:{'@type':'searchChats',query,type_filter:null,limit:nativeLimit}},
      {source:'contact',request:{'@type':'searchContacts',query,limit:nativeLimit},contact:true},
      {source:'known-chat-server',request:{'@type':'searchChatsOnServer',query,type_filter:null,limit:nativeLimit}},
      {source:'public',request:{'@type':'searchPublicChats',query,type_filter:null}},
    ];
    const unavailableSources:{source:string;code?:number;reason?:string}[]=[],skippedSources:string[]=[];
    let rateLimited=false,completed=0,firstError:TdRequestError|undefined;
    for(const phase of phases){
      if(rateLimited){skippedSources.push(phase.source);continue;}
      try{await collect(await this.invoke(phase.request),phase.source,phase.contact);completed++;}
      catch(error){
        if(!(error instanceof TdRequestError))throw error;
        firstError??=error;
        unavailableSources.push({source:phase.source,...(error.code!==undefined?{code:error.code}:{}),...(error.reason?{reason:error.reason}:{})});
        rateLimited=error.code===429||error.reason==='FLOOD_WAIT';
      }
    }
    if(!completed&&!peers.size&&firstError)throw firstError;
    if(peers.size>limit)truncated=true;
    const selected=[...peers.values()].slice(0,limit);
    const incomplete=!!(unavailableSources.length||skippedSources.length);
    return{peers:selected,matches:selected.map(peer=>({peerId:peer.peerId,sources:[...sources.get(peer.peerId)!]})),coverage:'bounded',truncated,selectionRequired:incomplete||truncated||peers.size>1,...(incomplete?{incomplete,unavailableSources,skippedSources}:{})} as unknown as Json;
  }
  async readCapability(name:string,args:TdObject,_context?:unknown):Promise<Json>{
    await this.verifyAccount();const peerId=String(args.peerId??args.resource??this.options.accountId);const fields={...args};
    if(args.tdlib||args.resolvedTopic||args.resolvedFolder)throw new Error('raw TDLib envelope is not a capability payload');
    if(name==='telegram.folders.list')return this.readFolders();
    if(name==='telegram.chats.list')return this.inventory.read(args,_context as import('../contracts.ts').ToolContext|undefined);
    if(name==='telegram.folder.get'){const id=folderId(args.folderId);return folderView(id,await this.invoke({'@type':'getChatFolder',chat_folder_id:id})) as Json;}
    if(name==='telegram.peer.inspect')return inspectPeer(sid(peerId),this.options.accountId,request=>this.invoke(request));
    if(name==='telegram.channels.related')return relatedChannels(sid(peerId),this.options.accountId,args.limit??10,request=>this.invoke(request));
    if(name==='telegram.message.author')return await this.resolvePostAuthor({accountId:this.options.accountId,peerId,messageId:sid(args.messageId)}) as unknown as Json;
    if(name==='telegram.source.discover'){
      if(typeof args.query!=='string'||!args.query.trim()||args.query.length>256)throw new Error('Telegram discovery query required');
      const limit=args.limit??20;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Telegram discovery limit must be 1..100');
      return this.discoverPeers(args.query.trim(),limit);
    }
    if(name==='telegram.participants.read'){
      if(args.supergroupId!==undefined)throw new Error('group IDs resolved by trusted Telegram host');
      const chat=await this.invoke({'@type':'getChat',chat_id:peerId});if(sid(chat.id)!==peerId)throw new Error('Telegram group identity mismatch');
      if(chat.type?.['@type']==='chatTypeSupergroup')fields.supergroupId=sid(chat.type.supergroup_id);
      else if(chat.type?.['@type']==='chatTypeBasicGroup'){if(args.query)throw new Error('basic group participant name search not supported');return await this.invoke({'@type':'getBasicGroupFullInfo',basic_group_id:sid(chat.type.basic_group_id)}) as Json;}
      else throw new Error('Telegram peer is not a participant group');
    }
    if(name==='telegram.context.read'&&args.threadId){const anchor=await this.getMessage({accountId:this.options.accountId,peerId,messageId:sid(args.messageId)});if(anchor?.ref.threadId!==String(args.threadId))throw new Error('Telegram context thread does not match source anchor');}
    const request=readRequest(name,peerId,fields);if(!READ_METHODS[name]?.includes(request['@type']))throw new Error('Telegram read method not allowed');
    if(request.chat_id!==undefined&&sid(request.chat_id)!==peerId)throw new Error('Telegram read escaped peer');
    const response=await this.invoke(request);
    if(response['@type']==='message'&&(sid(response.chat_id)!==peerId||sid(response.id)!==String(args.messageId)))throw new Error('Telegram readback identity mismatch');
    for(const message of response.messages??[])if(sid(message.chat_id)!==peerId)throw new Error('Telegram read returned content outside granted peer');
    return response as Json;
  }
  private result(receipt:TelegramReceipt):EffectResult{return{state:receipt.state==='verified'?'verified':receipt.state==='failed'?'failed':'unknown',receipt:{effectId:receipt.effectId,peerId:receipt.peerId,...(receipt.messageId?{messageId:receipt.messageId}:{}),...(receipt.tempMessageId?{tempMessageId:receipt.tempMessageId}:{}),...(receipt.detail?{detail:receipt.detail}:{})},...(receipt.state==='pending'?{reason:'TDLib native admission pending terminal update/readback'}:{})};}
  /** Check approved source bytes after every async gate, without yielding before native admission. */
  private assertApprovedMedia(args:TdObject):void{
    if(!args.mediaType||(args.sha256===undefined&&args.size===undefined))return;
    if(typeof args.path!=='string'||typeof args.sha256!=='string'||! /^[a-f0-9]{64}$/.test(args.sha256)||!Number.isSafeInteger(args.size)||args.size<0)throw new Error('Telegram approved media integrity metadata invalid');
    let fd:number|undefined;
    try{
      fd=openSync(args.path,'r');const before=fstatSync(fd);
      if(!before.isFile()||before.size!==args.size)throw new Error('changed');
      const hash=createHash('sha256'),buffer=Buffer.alloc(Math.min(65536,Math.max(1,args.size)));let offset=0;
      while(offset<args.size){const count=readSync(fd,buffer,0,Math.min(buffer.length,args.size-offset),offset);if(!count)throw new Error('changed');hash.update(buffer.subarray(0,count));offset+=count;}
      if(fstatSync(fd).size!==args.size||hash.digest('hex')!==args.sha256)throw new Error('changed');
    }catch{throw new Error('Telegram approved media source unavailable or changed');}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  async dispatch(effect:Effect):Promise<EffectResult>{
    if(!effect.capability.startsWith('telegram.folder.'))return this.dispatchBound(effect);
    const next=this.folderDispatchTail.catch(()=>{}).then(()=>this.dispatchBound(effect));this.folderDispatchTail=next;return next;
  }
  private async dispatchBound(effect:Effect):Promise<EffectResult>{
    await this.verifyAccount();
    if(this.fault||this.transportFault||this.closed)throw new Error('Telegram adapter unavailable');const previous=await this.options.receipts.get(effect.id);if(previous){if(previous.payloadHash!==effect.payloadHash)throw new Error('Telegram effect identity payload changed');return this.reconcile(effect);}
    if(effect.state==='cancelled'||effect.state==='failed'||effect.state==='verified')throw new Error('Telegram effect state forbids a new dispatch');
    const args=structuredClone(record(effect.payload));
    const replacement=record(args.replaceAcknowledgement);
    if(args.replaceAcknowledgement!==undefined){
      if(effect.capability!=='telegram.send'||args.mediaType||args.sendAt||replacement.expectedText!=='🤖 Нейробратик\n\nПонял, бро. Сейчас гляну.')throw new Error('Invalid host acknowledgement replacement');
      const original=await this.options.receipts.get(String(replacement.effectId));
      if(!original||original.state!=='verified'||original.capability!=='telegram.send'||original.payloadHash!==replacement.payloadHash||original.peerId!==effect.resource||original.messageId!==replacement.messageId)throw new Error('Acknowledgement native ownership binding mismatch');
      const fresh=await this.invoke({'@type':'getMessage',chat_id:effect.resource,message_id:sid(replacement.messageId)});
      if(!fresh.is_outgoing||fresh.sender_id?.['@type']!=='messageSenderUser'||sid(fresh.sender_id.user_id)!==this.options.accountId||fresh.forward_info||fresh.via_bot_user_id||fresh.sending_state||fresh.content?.['@type']!=='messageText'||fresh.content.text?.text!==replacement.expectedText)throw new Error('Acknowledgement changed or is not an own text message');
      this.assertMessage(fresh,{...effect,payload:{...args,text:replacement.expectedText}},sid(replacement.messageId));
    }
    if(effect.capability==='telegram.source.join'){
      const peer=await this.resolvePeer(effect.resource);if(!['channel','group'].includes(peer.kind)||!peer.username)throw new Error('Telegram joining requires an exact public group or channel with an active username; private invite joins unsupported');
    }
    if(args.resolvedFolder!==undefined)throw new Error('folder objects resolved only by trusted Telegram host');
    let folderIntent:TdObject|undefined;let beforeFolderIds:number[]|undefined;
    if(effect.capability.startsWith('telegram.folder.')){
      if(effect.resource!==this.options.accountId)throw new Error('Telegram folder target escaped owner');
      if(effect.capability==='telegram.folder.create'){
        folderIntent=newFolder(args);const snapshot=record(await this.readCapability('telegram.folders.list',{}));if(snapshot.status!=='observed'||!Array.isArray(snapshot.folders))throw new Error('Telegram folder list unavailable before create');
        if(snapshot.folders.some((folder:TdObject)=>folder.name===args.name))throw new Error('Telegram folder name already exists; inspect and update the selected folder instead');
        beforeFolderIds=snapshot.folders.map((folder:TdObject)=>folderId(folder.folderId));
      }
      else if(effect.capability==='telegram.folder.update'){const id=folderId(args.folderId);folderIntent=patchFolder(await this.invoke({'@type':'getChatFolder',chat_folder_id:id}),args);}
      else throw new Error('unsupported Telegram folder effect');
      // Refresh every changed peer, without implicitly joining channels or sending anything.
      const changed=effect.capability==='telegram.folder.create'?args.peerIds:[...(args.addPeerIds??[]),...(args.removePeerIds??[])];
      for(const peer of changed)await this.resolvePeer(sid(peer));args.resolvedFolder=folderIntent;
      if(effect.capability==='telegram.folder.update'&&folderVersion(await this.invoke({'@type':'getChatFolder',chat_folder_id:args.folderId}))!==args.expectedVersion)throw new Error('Telegram folder changed during peer refresh');
    }
    if(['sticker','videoNote'].includes(args.mediaType)&&(args.caption||args.text))throw new Error('Telegram media profile does not support caption');
    if(effect.capability==='telegram.profile.update'&&[args.bio,args.username,args.firstName].filter(v=>v!==undefined).length!==1)throw new Error('profile effect requires one independently verifiable field family');
    if(args.resolvedTopic!==undefined)throw new Error('topic objects resolved only by trusted Telegram host');
    if(args.threadId!==undefined){const resolved=this.topics.get(this.key(effect.resource,sid(args.threadId)));if(!resolved)throw new Error('topic type unbound; read source before dispatch');args.resolvedTopic=resolved;}
    if(effect.capability==='telegram.profile.update'&&args.firstName!==undefined&&args.lastName===undefined){const me=await this.invoke({'@type':'getMe'});args.lastName=me.last_name??'';}
    let editTarget:TdObject|undefined;
    if(effect.capability==='telegram.message.edit'){
      editTarget=await this.invoke({'@type':'getMessage',chat_id:effect.resource,message_id:sid(args.messageId)});
      if(sid(editTarget.chat_id)!==effect.resource||sid(editTarget.id)!==sid(args.messageId)||!editTarget.is_outgoing||editTarget.sender_id?.['@type']!=='messageSenderUser'||sid(editTarget.sender_id.user_id)!==this.options.accountId||editTarget.forward_info||String(editTarget.via_bot_user_id??'0')!=='0'||editTarget.sending_state)throw new Error('Telegram edit target is not an exact owned message');
      const fresh=await this.normalize(editTarget);if(!args.expectedVersion||fresh.version!==args.expectedVersion)throw new Error('Telegram target changed before dispatch');
      if(args.mediaType||typeof args.text!=='string')throw new Error('Telegram edit requires text or a caption, not replacement media');
      if(!['messageText','messageAnimation','messageAudio','messageDocument','messagePhoto','messageVideo','messageVoiceNote'].includes(editTarget.content?.['@type']))throw new Error('Telegram message type does not support text or caption editing');
    }else if(args.expectedVersion&&args.messageId){const fresh=await this.getMessage({accountId:this.options.accountId,peerId:effect.resource,messageId:sid(args.messageId)});if(!fresh||fresh.version!==args.expectedVersion)throw new Error('Telegram target changed before dispatch');}
    if(effect.capability==='telegram.bot.click'){
      const fresh=await this.invoke({'@type':'getMessage',chat_id:effect.resource,message_id:sid(args.messageId)});const observation=await this.normalize(fresh);if(!args.expectedVersion||observation.version!==args.expectedVersion)throw new Error('bot button target changed');
      const button=fresh.reply_markup?.rows?.[args.row]?.[args.column];if(button?.type?.['@type']!=='inlineKeyboardButtonTypeCallback')throw new Error('unsupported bot button mechanism');args.data=button.type.data;
    }
    const request=editTarget&&editTarget.content['@type']!=='messageText'?{'@type':'editMessageCaption',chat_id:effect.resource,message_id:sid(args.messageId),reply_markup:null,caption:{'@type':'formattedText',text:args.text,entities:[]},show_caption_above_media:!!editTarget.content.show_caption_above_media}:effectRequest(args.replaceAcknowledgement!==undefined?'telegram.message.edit':effect.capability,effect.resource,args.replaceAcknowledgement!==undefined?{...args,messageId:replacement.messageId}:args);
    if(!EFFECT_METHODS[args.replaceAcknowledgement!==undefined?'telegram.message.edit':effect.capability]?.includes(request['@type']))throw new Error('Telegram effect method not allowed');
    if(request.chat_id!==undefined&&sid(request.chat_id)!==effect.resource)throw new Error('Telegram effect target escaped resource');if(args.peerId!==undefined&&args.peerId!==effect.resource)throw new Error('Telegram payload peer mismatch');
    if(effect.capability.startsWith('telegram.profile.')&&effect.resource!==this.options.accountId&&effect.resource!=='self')throw new Error('profile target escaped owner');
    const sending=request['@type']==='sendMessage'||request['@type']==='sendMessageAlbum';const sendingId=sending?randomInt(1,2147483647):undefined;if(sending)request.options={...record(request.options),'@type':'messageSendOptions',sending_id:sendingId};validateTdObject(request);
    let receipt:TelegramReceipt={effectId:effect.id,payloadHash:effect.payloadHash,capability:effect.capability,peerId:effect.resource,state:'dispatching',...(args.replaceAcknowledgement!==undefined?{messageId:sid(replacement.messageId)}:{}),...(sendingId?{sendingId}:{}),...(folderIntent?{detail:{requestedFolder:folderIntent,...(beforeFolderIds?{beforeFolderIds}:{}),...(effect.capability==='telegram.folder.update'?{folderId:args.folderId}:{})}}:{})};await this.options.receipts.put(receipt);
    let nativeInvoked=false;
    try{if(sending)this.assertApprovedMedia(args);nativeInvoked=true;const response=await this.invoke(request);if(sending){if(response['@type']!=='message')throw new Error('album mapping requires multipart durable effects');if(sid(response.chat_id)!==effect.resource)throw new Error('Telegram send response peer mismatch');this.assertSendOwnership(response,effect.resource);
        this.chain=this.chain.then(async()=>{const existing=await this.options.receipts.get(effect.id);receipt={...receipt,...existing,state:existing?.state==='verified'||existing?.state==='failed'?existing.state:'pending',tempMessageId:existing?.tempMessageId??sid(response.id),...(existing?.messageId?{messageId:existing.messageId}:response.sending_state?{}:{messageId:sid(response.id)})};await this.options.receipts.put(receipt);const terminal=this.unmatchedTerminal.get(this.key(effect.resource,sid(response.id)));if(terminal){this.unmatchedTerminal.delete(this.key(effect.resource,sid(response.id)));await this.update(terminal);}await this.releaseAttributionHolds();});await this.chain;
        const latest=await this.options.receipts.get(effect.id);if(latest)receipt=latest;
        if(!receipt.messageId&&this.options.sendWaitMs){await new Promise<void>(resolve=>{const timer=setTimeout(done,this.options.sendWaitMs);const set=this.terminalWakes.get(effect.id)??new Set();this.terminalWakes.set(effect.id,set);function done(){clearTimeout(timer);set.delete(done);resolve();}set.add(done);});}return this.reconcile(effect);
      }const folderResult=folderIntent?folderId(response.id):undefined;if(folderIntent&&(response['@type']!=='chatFolderInfo'||(effect.capability==='telegram.folder.update'&&folderResult!==args.folderId)))throw new Error('Telegram folder result identity mismatch');
      receipt={...receipt,state:'unknown',detail:{...record(receipt.detail),method:request['@type'],nativeAccepted:true,responseType:response['@type'],...(folderResult?{folderId:folderResult}:{})}};await this.options.receipts.put(receipt);return this.reconcile(effect);
    }catch(e){receipt={...receipt,state:!nativeInvoked||(e instanceof TdRequestError&&e.code!==undefined)?'failed':'unknown',detail:{...record(receipt.detail),reason:e instanceof Error?e.message:'dispatch failed',...(e instanceof TdRequestError&&e.code!==undefined?{code:e.code}:{}),...(e instanceof TdRequestError&&e.reason?{nativeReason:e.reason}:{}),...(!nativeInvoked?{notDispatched:true}:{})}};await this.options.receipts.put(receipt);return this.result(receipt);}
  }
  private async documentBytesMatch(m:TdObject,effect:Effect):Promise<boolean>{
    const args=record(effect.payload),document=record(record(m.content).document),file=record(document.document);
    if(sid(m.chat_id)!==effect.resource||m.sending_state||m.content?.['@type']!=='messageDocument')return false;
    if(args.mediaType!=='document'||args.name===undefined||typeof args.path!=='string'||document.file_name===basename(args.path))return false;
    // TDLib may sanitize and shorten filenames. Prove the exact bound document bytes,
    // rather than accepting a similar filename or size as identity evidence.
    if(typeof args.sha256!=='string'||! /^[a-f0-9]{64}$/.test(args.sha256)||!Number.isSafeInteger(args.size)||args.size<0||sid(file.size)!==String(args.size))return false;
    const downloaded=await this.invoke({'@type':'downloadFile',file_id:sid(file.id),priority:16,offset:0,limit:0,synchronous:true});
    if(sid(downloaded.id)!==sid(file.id)||sid(downloaded.size)!==String(args.size)||!downloaded.local?.is_downloading_completed||typeof downloaded.local.path!=='string')return false;
    this.assertApprovedMedia({...args,path:downloaded.local.path});return true;
  }
  private assertMessage(m:TdObject,effect:Effect,messageId:string,documentBytesVerified=false):void{
    const args=record(effect.payload),content=record(m.content),actualText=content.text?.text??content.caption?.text;
    if(sid(m.chat_id)!==effect.resource||sid(m.id)!==messageId||m.sending_state)throw new Error('Telegram message identity or pending state mismatch');
    if(['telegram.send','telegram.message.send','message.send','telegram.media.send','telegram.poll.create','telegram.schedule.create'].includes(effect.capability))this.assertSendOwnership(m,effect.resource);
    if(args.replaceAcknowledgement!==undefined&&(!m.is_outgoing||m.sender_id?.['@type']!=='messageSenderUser'||sid(m.sender_id.user_id)!==this.options.accountId||m.forward_info||m.via_bot_user_id||content['@type']!=='messageText'))throw new Error('Acknowledgement edit readback ownership mismatch');
    if(args.text!==undefined&&args.text!==actualText)throw new Error('Telegram text readback mismatch');
    if(args.caption!==undefined&&args.caption!==content.caption?.text)throw new Error('Telegram caption readback mismatch');
    if(args.replyToMessageId!==undefined&&String(m.reply_to?.message_id)!==String(args.replyToMessageId))throw new Error('Telegram reply readback mismatch');
    if(args.threadId!==undefined&&String(m.topic_id?.message_thread_id??m.topic_id?.forum_topic_id??m.topic_id?.direct_messages_chat_topic_id??m.topic_id?.saved_messages_topic_id)!==String(args.threadId))throw new Error('Telegram topic readback mismatch');
    if(args.sendAt!==undefined&&m.scheduling_state?.send_date!==args.sendAt)throw new Error('Telegram schedule readback mismatch');
    if(args.mediaType){const types:Record<string,string>={photo:'messagePhoto',document:'messageDocument',video:'messageVideo',audio:'messageAudio',voice:'messageVoiceNote',animation:'messageAnimation',sticker:'messageSticker',videoNote:'messageVideoNote'};if(content['@type']!==types[args.mediaType])throw new Error('Telegram media profile readback mismatch');}
    if(args.mediaType==='document'){
      // inputDocument has no filename override: inputFileLocal sends the staged path's basename.
      if(args.name!==undefined&&(typeof args.path!=='string'||content.document?.file_name!==basename(args.path))&&!documentBytesVerified)throw new Error('Telegram document filename readback mismatch');
      if(args.size!==undefined&&sid(content.document?.document?.size)!==String(args.size))throw new Error('Telegram document size readback mismatch');
    }
    // Photos can be recompressed by Telegram. Source SHA-256 is an admission check, not a remote-byte proof.
    if(effect.capability==='telegram.poll.create'){const poll=content.poll;if(content['@type']!=='messagePoll'||poll?.question?.text!==args.question||!Array.isArray(poll.options)||JSON.stringify(poll.options.map((o:TdObject)=>o.text?.text))!==JSON.stringify(args.options))throw new Error('Telegram poll content readback mismatch');
      if(poll.is_anonymous!==(args.anonymous??true)||poll.allows_multiple_answers!==!!args.multiple||poll.type?.['@type']!==(args.quiz?'pollTypeQuiz':'pollTypeRegular'))throw new Error('Telegram poll policy readback mismatch');
      if(args.quiz&&(!Array.isArray(poll.type.correct_option_ids)||JSON.stringify(poll.type.correct_option_ids)!==JSON.stringify([args.correctOption])||poll.type.explanation?.text!==(args.explanation??'')))throw new Error('Telegram quiz answer readback unavailable or mismatched');
    }
  }
  private async verifyMutation(effect:Effect):Promise<boolean>{
    const args=record(effect.payload),cap=effect.capability;
    if(cap==='telegram.message.delete'||cap==='telegram.schedule.cancel'){
      for(const id of args.messageIds??[args.messageId]){try{await this.invoke({'@type':'getMessage',chat_id:effect.resource,message_id:sid(id)});return false;}catch(e){if(!(e instanceof TdRequestError&&e.code===404))return false;}}return true;
    }
    if(['telegram.message.edit','telegram.schedule.edit','telegram.poll.vote','telegram.poll.stop','telegram.reaction.set'].includes(cap)){
      const m=await this.invoke({'@type':'getMessage',chat_id:effect.resource,message_id:sid(args.messageId)});this.assertMessage(m,effect,sid(args.messageId));
      if(cap==='telegram.poll.stop')return m.content?.poll?.is_closed===true;
      if(cap==='telegram.poll.vote')return JSON.stringify((m.content?.poll?.options??[]).map((o:TdObject,i:number)=>o.is_chosen?i:-1).filter((i:number)=>i>=0))===JSON.stringify([...args.optionIds].sort((a:number,b:number)=>a-b));
      if(cap==='telegram.reaction.set'){const reactions=m.interaction_info?.reactions?.reactions??[];const chosen=reactions.some((r:TdObject)=>r.type?.['@type']==='reactionTypeEmoji'&&r.type.emoji===args.emoji&&r.is_chosen);return args.remove?!chosen:chosen;}
      return true;
    }
    if(cap==='telegram.profile.update'){if(args.bio!==undefined){const full=await this.invoke({'@type':'getUserFullInfo',user_id:this.options.accountId});return full.bio?.text===args.bio;}const me=await this.invoke({'@type':'getMe'});if(args.username!==undefined)return(me.usernames?.active_usernames??[]).includes(args.username);return me.first_name===args.firstName&&(args.lastName===undefined||me.last_name===args.lastName);}
    if(cap==='telegram.source.join'){
      const chat=await this.invoke({'@type':'getChat',chat_id:effect.resource});
      if(sid(chat.id)!==effect.resource)throw new Error('Telegram membership peer mismatch');
      const type=chat.type?.['@type'];
      const id=type==='chatTypeSupergroup'?sid(chat.type.supergroup_id):type==='chatTypeBasicGroup'?sid(chat.type.basic_group_id):undefined;
      if(!id)return false;
      const membership=await this.invoke(type==='chatTypeSupergroup'?{'@type':'getSupergroup',supergroup_id:id}:{'@type':'getBasicGroup',basic_group_id:id});
      if(sid(membership.id)!==id)throw new Error('Telegram membership identity mismatch');
      return['chatMemberStatusMember','chatMemberStatusAdministrator','chatMemberStatusCreator','chatMemberStatusRestricted'].includes(membership.status?.['@type'])&&membership.status?.is_member!==false;
    }
    // Callback acceptance and avatar RPC ACK do not prove a downstream semantic outcome.
    return false;
  }
  async reconcile(effect:Effect):Promise<EffectResult>{
    await this.verifyAccount();await this.chain;if(this.fault)throw this.fault;
    const r=await this.options.receipts.get(effect.id);if(!r)return{state:'unknown',reason:'no durable TDLib dispatch receipt; no resend'};
    if(r.payloadHash!==effect.payloadHash)throw new Error('Telegram reconciliation payload mismatch');if(r.state==='failed')return this.result(r);
    try{
      let verified=false;
      if(effect.capability.startsWith('telegram.folder.')){
        const detail=record(r.detail);if(detail.folderId!==undefined&&detail.requestedFolder){const current=await this.invoke({'@type':'getChatFolder',chat_folder_id:folderId(detail.folderId)});verified=folderVersion(canonicalFolder(current))===folderVersion(record(detail.requestedFolder));}
      }else if(r.messageId){const m=await this.invoke({'@type':'getMessage',chat_id:r.peerId,message_id:r.messageId});const bytesVerified=await this.documentBytesMatch(m,effect);this.assertMessage(m,effect,r.messageId,bytesVerified);verified=true;}else if(record(r.detail).nativeAccepted)verified=await this.verifyMutation(effect);
      if(verified){const next={...r,state:'verified' as const};await this.options.receipts.put(next);return this.result(next);}
      return this.result(r);
    }catch{return{state:'unknown',receipt:this.result(r).receipt,reason:'Telegram semantic readback unavailable or mismatched; no resend'};}
  }
  async close():Promise<void>{this.closed=true;this.wake();this.invalidateFolders();this.inventory.invalidate();await this.options.transport.close();await this.chain;if(this.fault)throw this.fault;}
}
