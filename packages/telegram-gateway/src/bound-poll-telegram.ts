import { STANDING_INCOMING_TEXT_BYTES } from "./standing-context.js";
import { types } from "node:util";
import { Api, utils } from "telegram";
import bigInt from "big-integer";
import type { PilotBinding, PilotInvoker, PilotPrimary } from "./pilot-telegram-adapter.js";

export type BoundPollSpec = Readonly<{ question:string; options:readonly string[]; anonymous:boolean; type:"single"|"multiple"|"quiz"; correctOption?:number; explanation?:string }>;
export type BoundPollOperation = Readonly<{ operationId:string; randomId:string; poll:BoundPollSpec }>;
/** Host-private journal data. The model-facing layer replaces IDs with refs. */
export type OwnedBoundPoll = Readonly<{ schema:"owned-bound-poll-v1"; operationId:string; randomId:string; chatId:string; accountId:string; replyToMessageId:number;
  messageId:number; pollId:string; poll:BoundPollSpec }>;
export type BoundPollInspection = Readonly<{ messageId:number; pollId:string; own:boolean; question:string; anonymous:boolean; type:BoundPollSpec["type"]; closed:boolean;
  totalVoters:number|null; options:readonly Readonly<{index:number;text:string;voters:number|null;chosen:boolean|null;correct:boolean|null}>[];
  coverage:Readonly<{counts:"server-observed";complete:boolean;voterIdentities:"not-read";atomicSnapshot:false}> }>;
export type BoundPollCreated = Readonly<{ record:OwnedBoundPoll; poll:BoundPollInspection }>;
export type BoundPollClosed = Readonly<{ status:"closed"|"already-closed"; poll:BoundPollInspection }>;
export class BoundPollError extends Error {
  constructor(readonly code:"config"|"input"|"busy"|"consumed"|"permission"|"primary"|"protocol"|"transport"|"aborted"|"not-available"|"definition-changed",readonly unknown:boolean){super("BOUND_POLL_"+code.toUpperCase());}
}
const absent=(v:unknown)=>v===undefined||v===null;
const msgId=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647;
const positiveLong=(v:unknown):v is string=>typeof v==="string"&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<2n**63n;
const pollId=(v:unknown):v is string=>typeof v==="string"&&/^-?[1-9]\d{0,18}$/.test(v)&&BigInt(v)>=-(2n**63n)&&BigInt(v)<2n**63n;
const samePeer=(value:unknown,expected:string)=>{try{return utils.getPeerId(value as Api.TypePeer)===expected;}catch{return false;}};
function data(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=="object"||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error();
  const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
  if(required.some(k=>!Object.hasOwn(ds,k))||keys.some(k=>typeof k!=="string"||!required.includes(k)&&!optional.includes(k)))throw Error();
  const copy:Record<string,unknown>={};for(const key of keys as string[]){const d=ds[key]!;if(!("value"in d)||!d.enumerable)throw Error();copy[key]=d.value;}return copy;
}
function plainText(v:unknown,units:number):v is string{return typeof v==="string"&&v.trim().length>0&&v.length<=units&&Buffer.byteLength(v)<=units*4&&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(v)&&Buffer.from(v).toString()===v;}
function specCopy(value:unknown):BoundPollSpec{
  const v=data(value,["question","options","anonymous","type"],["correctOption","explanation"]),options=v.options;
  if(!plainText(v.question,255)||typeof v.anonymous!=="boolean"||typeof v.type!=="string"||!["single","multiple","quiz"].includes(v.type)||types.isProxy(options)||!Array.isArray(options)||options.length<2||options.length>10||Reflect.ownKeys(options).length!==options.length+1)throw Error();
  const copied:string[]=[];for(let i=0;i<options.length;i++){const d=Object.getOwnPropertyDescriptor(options,String(i));if(!d||!("value"in d)||!plainText(d.value,100))throw Error();copied.push(d.value);}
  if(new Set(copied).size!==copied.length)throw Error();
  if(v.type==="quiz"){if(!Number.isInteger(v.correctOption)||Number(v.correctOption)<0||Number(v.correctOption)>=copied.length||Object.hasOwn(v,"explanation")&&!plainText(v.explanation,200))throw Error();}
  else if(Object.hasOwn(v,"correctOption")||Object.hasOwn(v,"explanation"))throw Error();
  return Object.freeze({question:v.question,options:Object.freeze(copied),anonymous:v.anonymous,type:v.type as BoundPollSpec["type"],
    ...(v.type==="quiz"?{correctOption:Number(v.correctOption),...(v.explanation===undefined?{}:{explanation:v.explanation as string})}:{})});
}
export const snapshotBoundPollSpec=(value:unknown):BoundPollSpec=>specCopy(value);
function discard(v:unknown){if(v instanceof Api.Updates||v instanceof Api.UpdatesCombined){v.updates.length=0;v.users.length=0;v.chats.length=0;}
  if(v instanceof Api.messages.Messages||v instanceof Api.messages.MessagesSlice||v instanceof Api.messages.ChannelMessages){v.messages.length=0;v.users.length=0;v.chats.length=0;}}

/** Exact v1 own-create identity. Option tokens are the immutable one-byte [index]
 * encoding produced by this transport, never guessed for arbitrary Telegram polls. */
export function snapshotOwnedBoundPoll(value:unknown):OwnedBoundPoll{
  try{
    const v=data(value,["schema","operationId","randomId","chatId","accountId","replyToMessageId","messageId","pollId","poll"]);
    if(v.schema!=="owned-bound-poll-v1"||typeof v.operationId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v.operationId)||
      !positiveLong(v.randomId)||!positiveLong(v.accountId)||typeof v.chatId!=="string"||!/^-[1-9]\d{0,19}$/.test(v.chatId)||
      !msgId(v.replyToMessageId)||!msgId(v.messageId)||!pollId(v.pollId))throw Error();
    return Object.freeze({schema:"owned-bound-poll-v1",operationId:v.operationId,randomId:v.randomId,chatId:v.chatId,accountId:v.accountId,
      replyToMessageId:v.replyToMessageId,messageId:v.messageId,pollId:v.pollId,poll:specCopy(v.poll)});
  }catch{throw new BoundPollError("input",false);}
}

/** Exact-bound, existing-client poll transport. Before either mutation the caller
 * MUST durably record its intent and supplied randomId, and retain UNKNOWN as
 * consumed across restart. One mutation per instance; no retries/replay/voting,
 * sender changes, voter enumeration, timers or client creation. inspect IDs are
 * host-resolved references, never raw model-selected targets. close revokes now
 * and joins the real pending operation; the connection owner interrupts I/O. */
export function createBoundPollTelegramTransport(input:{client:PilotInvoker;binding:PilotBinding;peer:Api.InputPeerChat|Api.InputPeerChannel;self:Api.User;
  selected:PilotPrimary;signal:AbortSignal;isSelectionActive():boolean;revalidatePrimary(signal:AbortSignal):Promise<PilotPrimary>}){
  let mutationStarted=false,consumed=false,revoked=false,pending:Promise<unknown>|undefined,owned:OwnedBoundPoll|undefined;
  const fail=(code:BoundPollError["code"]):never=>{throw new BoundPollError(code,mutationStarted);};
  const binding=Object.freeze({...input.binding}),selected=Object.freeze({...input.selected}),signal=input.signal;
  let peer:Api.InputPeerChat|Api.InputPeerChannel;
  try{
    if(!positiveLong(binding.accountId)||!/^-[1-9]\d{0,19}$/.test(binding.peerId)||!(input.self instanceof Api.User)||!input.self.self||input.self.deleted||input.self.bot||input.self.id.toString()!==binding.accountId||
      selected.chatId!==binding.peerId||!positiveLong(selected.ownerId)||selected.ownerId===binding.accountId||!msgId(selected.messageId)||typeof selected.text!=="string"||!selected.text.trim()||Buffer.byteLength(selected.text)>STANDING_INCOMING_TEXT_BYTES||selected.text.includes("\0")||Buffer.from(selected.text).toString()!==selected.text||
      !(input.peer instanceof Api.InputPeerChat||input.peer instanceof Api.InputPeerChannel)||!samePeer(input.peer,binding.peerId)||!(signal instanceof AbortSignal))return fail("config");
    peer=input.peer instanceof Api.InputPeerChat?new Api.InputPeerChat({chatId:bigInt(input.peer.chatId.toString())}):new Api.InputPeerChannel({channelId:bigInt(input.peer.channelId.toString()),accessHash:bigInt(input.peer.accessHash.toString())});
    if(peer instanceof Api.InputPeerChannel&&(peer.accessHash.isZero()||peer.accessHash.lesser((-(2n**63n)).toString())||peer.accessHash.greaterOrEquals((2n**63n).toString())))return fail("config");
  }catch{return fail("config");}
  const invoke=input.client.invoke.bind(input.client),active=input.isSelectionActive.bind(input),revalidate=input.revalidatePrimary.bind(input);
  const check=()=>{let valid=false;try{valid=active()===true;}catch{}if(revoked||signal.aborted||!valid)return fail("aborted");};
  const flag=(v:unknown):boolean=>absent(v)?false:typeof v==="boolean"?v:fail("protocol");
  const count=(v:unknown):number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=2147483647?Number(v):fail("protocol");
  const run=<T>(work:()=>Promise<T>):Promise<T>=>{
    try{check();if(pending)return fail("busy");}catch(e){return Promise.reject(e);}
    const task=Promise.resolve().then(work).then(result=>{check();if(Buffer.byteLength(JSON.stringify(result))>65536)return fail("protocol");return result;})
      .catch(e=>{revoked=true;if(e instanceof BoundPollError)throw e;return fail("protocol");});
    pending=task;void task.then(()=>{pending=undefined;},()=>{pending=undefined;});return task;
  };
  async function request<T>(r:Api.AnyRequest,parse:(v:unknown)=>T,mutating=false):Promise<T>{
    check();let value:unknown;
    try{if(mutating)mutationStarted=true;try{value=await invoke(r);}catch{return fail("transport");}check();return parse(value);}finally{discard(value);}
  }
  const channel=()=>{if(!(peer instanceof Api.InputPeerChannel))return fail("config");return new Api.InputChannel({channelId:peer.channelId,accessHash:peer.accessHash});};
  const exactRequest=(id:number)=>peer instanceof Api.InputPeerChannel?new Api.channels.GetMessages({channel:channel(),id:[new Api.InputMessageID({id})]}):new Api.messages.GetMessages({id:[new Api.InputMessageID({id})]});
  async function primary(){check();const value=await revalidate(signal);check();if(value.chatId!==selected.chatId||value.ownerId!==selected.ownerId||value.messageId!==selected.messageId||value.text!==selected.text)return fail("primary");}
  async function permission(){
    await request(peer instanceof Api.InputPeerChannel?new Api.channels.GetFullChannel({channel:channel()}):new Api.messages.GetFullChat({chatId:peer.chatId}),v=>{
      if(!(v instanceof Api.messages.ChatFull)||v.chats.length>100||v.users.length>400)return fail("protocol");
      const isChannel=peer instanceof Api.InputPeerChannel,full=v.fullChat,expected=isChannel?(peer as Api.InputPeerChannel).channelId.toString():(peer as Api.InputPeerChat).chatId.toString();
      if((isChannel?!(full instanceof Api.ChannelFull):!(full instanceof Api.ChatFull))||full.id.toString()!==expected)return fail("protocol");
      const matches=v.chats.filter(c=>(isChannel?c instanceof Api.Channel:c instanceof Api.Chat)&&c.id.toString()===expected);if(matches.length!==1)return fail("protocol");
      const c=matches[0]!;if(!(c instanceof Api.Channel||c instanceof Api.Chat)||flag(c.left)||c instanceof Api.Channel&&(flag(c.min)||flag(c.broadcast)||!flag(c.megagroup)&&!flag(c.gigagroup))||c instanceof Api.Chat&&(flag(c.deactivated)||!absent(c.migratedTo)))return fail("permission");
      if(!absent(c.adminRights)&&!(c.adminRights instanceof Api.ChatAdminRights))return fail("protocol");
      const admin=flag(c.creator)||c.adminRights instanceof Api.ChatAdminRights;
      const banned=(rights:unknown)=>{if(absent(rights))return false;if(!(rights instanceof Api.ChatBannedRights))return fail("protocol");return flag(rights.viewMessages)||flag(rights.sendMessages)||flag(rights.sendMedia)||flag(rights.sendPolls);};
      if(c instanceof Api.Channel&&banned(c.bannedRights)||!admin&&banned(c.defaultBannedRights))return fail("permission");
      if(full instanceof Api.ChatFull){const p=full.participants;if(!(p instanceof Api.ChatParticipants||p instanceof Api.ChatParticipantsForbidden)||p.chatId.toString()!==expected)return fail("protocol");
        if(p instanceof Api.ChatParticipants&&(!Array.isArray(p.participants)||p.participants.length>200))return fail("protocol");
        const own=p instanceof Api.ChatParticipants?p.participants.filter(x=>x.userId.toString()===binding.accountId):p.selfParticipant?[p.selfParticipant]:[];
        if(own.length!==1||own[0]!.userId.toString()!==binding.accountId)return fail("permission");}
      return true;
    });
  }
  function textField(value:unknown,max:number):string{
    if(!(value instanceof Api.TextWithEntities)||!plainText(value.text,max)||!Array.isArray(value.entities)||value.entities.length>100)return fail("protocol");
    for(const e of value.entities){if(!Number.isInteger(e.offset)||!Number.isInteger(e.length)||e.offset<0||e.length<=0||e.offset+e.length>value.text.length)return fail("protocol");}
    return value.text;
  }
  type Definition={id:string;question:string;options:readonly {text:string;option:Buffer}[];anonymous:boolean;type:BoundPollSpec["type"];closed:boolean;plain:boolean;closeDate:number|null;closePeriod:number|null};
  function definition(p:unknown):Definition{
    if(!(p instanceof Api.Poll)||!pollId(p.id.toString())||!Array.isArray(p.answers)||p.answers.length<2||p.answers.length>10||!absent(p.closeDate)&&!msgId(p.closeDate)||!absent(p.closePeriod)&&!msgId(p.closePeriod))return fail("protocol");
    const options=p.answers.map(a=>{if(!(a instanceof Api.PollAnswer)||!Buffer.isBuffer(a.option)||a.option.length<1||a.option.length>100)return fail("protocol");return {text:textField(a.text,100),option:Buffer.from(a.option)};});
    if(new Set(options.map(o=>o.option.toString("hex"))).size!==options.length||flag(p.quiz)&&flag(p.multipleChoice))return fail("protocol");
    return {id:p.id.toString(),question:textField(p.question,255),options,anonymous:!flag(p.publicVoters),type:flag(p.quiz)?"quiz":flag(p.multipleChoice)?"multiple":"single",closed:flag(p.closed),
      plain:p.question.entities.length===0&&p.answers.every(a=>a.text.entities.length===0),closeDate:p.closeDate??null,closePeriod:p.closePeriod??null};
  }
  const sameDefinition=(a:Definition,b:Definition)=>a.id===b.id&&a.question===b.question&&a.anonymous===b.anonymous&&a.type===b.type&&a.options.length===b.options.length&&a.options.every((v,i)=>v.text===b.options[i]!.text&&v.option.equals(b.options[i]!.option));
  function projection(d:Definition,r:unknown,id:number,own:boolean):BoundPollInspection{
    if(!(r instanceof Api.PollResults)||!absent(r.results)&&(!Array.isArray(r.results)||r.results.length>d.options.length)||!absent(r.recentVoters)&&(!Array.isArray(r.recentVoters)||r.recentVoters.length>100))return fail("protocol");
    const minimal=flag(r.min),rows=new Map<string,Api.PollAnswerVoters>();
    for(const row of r.results??[]){if(!(row instanceof Api.PollAnswerVoters)||!Buffer.isBuffer(row.option))return fail("protocol");const key=row.option.toString("hex");if(rows.has(key)||!d.options.some(o=>o.option.equals(row.option)))return fail("protocol");count(row.voters);flag(row.chosen);flag(row.correct);rows.set(key,row);}
    const totalVoters=absent(r.totalVoters)?null:count(r.totalVoters),complete=!minimal&&totalVoters!==null&&rows.size===d.options.length;
    const observed=[...rows.values()],sum=observed.reduce((n,row)=>n+row.voters,0);
    if(d.type!=="multiple"&&totalVoters!==null&&(sum>totalVoters||complete&&sum!==totalVoters)||
      observed.filter(row=>flag(row.correct)).length>(d.type==="quiz"?1:0)||d.type!=="multiple"&&observed.filter(row=>flag(row.chosen)).length>1)return fail("protocol");
    return Object.freeze({messageId:id,pollId:d.id,own,question:d.question,anonymous:d.anonymous,type:d.type,closed:d.closed,totalVoters,
      options:Object.freeze(d.options.map((o,index)=>{const row=rows.get(o.option.toString("hex"));if(row&&totalVoters!==null&&row.voters>totalVoters)return fail("protocol");
        return Object.freeze({index,text:o.text,voters:row?row.voters:null,chosen:row?(flag(row.chosen)?true:minimal?null:false):null,correct:row?(flag(row.correct)?true:d.type==="quiz"?null:false):null});})),
      coverage:Object.freeze({counts:"server-observed",complete,voterIdentities:"not-read",atomicSnapshot:false})});
  }
  function message(v:unknown,id:number){
    if(!(v instanceof Api.Message)||v.id!==id||!samePeer(v.peerId,binding.peerId)||!(v.media instanceof Api.MessageMediaPoll)||!absent(v.fwdFrom)||!absent(v.viaBotId)||!absent(v.groupedId)||!absent(v.replyMarkup)||!absent(v.ttlPeriod))return fail("protocol");
    const own=v.fromId instanceof Api.PeerUser&&v.fromId.userId.toString()===binding.accountId&&flag(v.out)&&!flag(v.post);
    const d=definition(v.media.poll);return {definition:d,inspection:projection(d,v.media.results,id,own),message:v};
  }
  async function readMessage(id:number,ownedRead=false){return request(exactRequest(id),v=>{if(!(v instanceof Api.messages.Messages||v instanceof Api.messages.MessagesSlice||v instanceof Api.messages.ChannelMessages)||v.messages.length!==1||v.chats.length>100||v.users.length>100)return fail("protocol");
    // MessageEmpty does not distinguish deletion from lost visibility.
    if(ownedRead&&v.messages[0] instanceof Api.MessageEmpty&&v.messages[0].id===id)return fail("not-available");
    return message(v.messages[0],id);});}
  function updates(v:unknown):Api.TypeUpdate[]{if(!(v instanceof Api.Updates||v instanceof Api.UpdatesCombined)||v.updates.length>100||v.users.length>100||v.chats.length>100)return fail("protocol");return v.updates;}
  async function inspectExact(id:number,record?:OwnedBoundPoll):Promise<{definition:Definition;inspection:BoundPollInspection;solution:string|null}>{
    const initial=await readMessage(id,record!==undefined);
    if(record){
      if(!initial.inspection.own)return fail("permission");
      const m=initial.message,reply=m.replyTo;
      if(initial.definition.id!==record.pollId||!matchesOwnedSpec(initial.definition,record.poll)||m.message!==""||(m.entities?.length??0)!==0||flag(m.fromScheduled)||
        !(reply instanceof Api.MessageReplyHeader)||flag(reply.replyToScheduled)||reply.replyToMsgId!==record.replyToMessageId||!absent(reply.replyToPeerId)&&!samePeer(reply.replyToPeerId,binding.peerId))return fail("definition-changed");
    }
    return request(new Api.messages.GetPollResults({peer,msgId:id}),v=>{
      const list=updates(v).filter(u=>u instanceof Api.UpdateMessagePoll);if(list.length!==1)return fail("protocol");const u=list[0]!;
      if(u.pollId.toString()!==initial.definition.id)return fail("protocol");const d=absent(u.poll)?initial.definition:definition(u.poll);
      if(!sameDefinition(initial.definition,d)||record&&!matchesOwnedSpec(d,record.poll))return fail(record?"definition-changed":"protocol");
      return {definition:d,inspection:projection(d,u.results,id,initial.inspection.own),solution:absent(u.results.solution)||u.results.solution===""?null:plainText(u.results.solution,200)?u.results.solution:fail("protocol")};
    });
  }
  function matchesSpec(d:Definition,s:BoundPollSpec):boolean{return d.question===s.question&&d.anonymous===s.anonymous&&d.type===s.type&&d.options.length===s.options.length&&d.options.every((o,i)=>o.text===s.options[i]&&o.option.equals(Buffer.from([i])));}
  function matchesOwnedSpec(d:Definition,s:BoundPollSpec):boolean{return matchesSpec(d,s)&&d.plain&&d.closeDate===null&&d.closePeriod===null;}
  const pollWire=(s:BoundPollSpec,id="0",closed=false)=>new Api.Poll({id:bigInt(id),closed,publicVoters:!s.anonymous,multipleChoice:s.type==="multiple",quiz:s.type==="quiz",
    question:new Api.TextWithEntities({text:s.question,entities:[]}),answers:s.options.map((text,i)=>new Api.PollAnswer({text:new Api.TextWithEntities({text,entities:[]}),option:Buffer.from([i])}))});
  return Object.freeze({
    createOnce(value:BoundPollOperation):Promise<BoundPollCreated>{
      let operation:BoundPollOperation;try{const v=data(value,["operationId","randomId","poll"]);if(typeof v.operationId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v.operationId)||!positiveLong(v.randomId))throw Error();operation=Object.freeze({operationId:v.operationId,randomId:v.randomId,poll:specCopy(v.poll)});}catch{return Promise.reject(new BoundPollError("input",mutationStarted));}
      return run(async()=>{if(consumed)return fail("consumed");consumed=true;await primary();await permission();await primary();
        const s=operation.poll,id=await request(new Api.messages.SendMedia({peer,sendAs:new Api.InputPeerSelf(),replyTo:new Api.InputReplyToMessage({replyToMsgId:selected.messageId}),message:"",randomId:bigInt(operation.randomId),
          media:new Api.InputMediaPoll({poll:pollWire(s),...(s.type==="quiz"?{correctAnswers:[Buffer.from([s.correctOption!])],...(s.explanation===undefined?{}:{solution:s.explanation,solutionEntities:[]})}:{})})}),v=>{
          const list=updates(v),maps=list.filter(u=>u instanceof Api.UpdateMessageID);if(maps.length!==1||maps[0]!.randomId?.toString()!==operation.randomId||!msgId(maps[0]!.id))return fail("protocol");
          const id=maps[0]!.id,echoes=list.filter(u=>(u instanceof Api.UpdateNewMessage||u instanceof Api.UpdateNewChannelMessage)&&u.message.id===id);if(echoes.length!==1)return fail("protocol");
          const echo=message((echoes[0] as Api.UpdateNewMessage|Api.UpdateNewChannelMessage).message,id);
          if(!echo.inspection.own||!matchesOwnedSpec(echo.definition,s)||echo.definition.closed||echo.message.message!==""||(echo.message.entities?.length??0)!==0||flag(echo.message.fromScheduled)||!(echo.message.replyTo instanceof Api.MessageReplyHeader)||flag(echo.message.replyTo.replyToScheduled)||echo.message.replyTo.replyToMsgId!==selected.messageId||!absent(echo.message.replyTo.replyToPeerId)&&!samePeer(echo.message.replyTo.replyToPeerId,binding.peerId))return fail("protocol");
          owned=Object.freeze({schema:"owned-bound-poll-v1",...operation,chatId:binding.peerId,accountId:binding.accountId,replyToMessageId:selected.messageId,messageId:id,pollId:echo.definition.id});return id;
        },true);
        const observed=await inspectExact(id);if(!observed.inspection.own||observed.definition.id!==owned!.pollId||!matchesOwnedSpec(observed.definition,s)||observed.definition.closed||
          s.type==="quiz"&&(observed.inspection.options.filter(o=>o.correct===true).length!==1||observed.inspection.options[s.correctOption!]!.correct!==true||observed.solution!==(s.explanation??null)))return fail("protocol");
        return Object.freeze({record:owned!,poll:observed.inspection});});
    },
    inspect(id:number):Promise<BoundPollInspection>{if(!msgId(id))return Promise.reject(new BoundPollError("input",mutationStarted));return run(async()=>(await inspectExact(id)).inspection);},
    inspectOwned(value:OwnedBoundPoll):Promise<BoundPollInspection>{
      let record:OwnedBoundPoll;try{record=snapshotOwnedBoundPoll(value);}catch(error){return Promise.reject(error);}
      if(record.accountId!==binding.accountId||record.chatId!==binding.peerId)return Promise.reject(new BoundPollError("permission",false));
      return run(async()=>{await primary();const observed=await inspectExact(record.messageId,record),s=record.poll;
        if(s.type==="quiz"){
          const correct=observed.inspection.options.filter(o=>o.correct===true);
          if(correct.length===0)return fail("not-available");
          if(correct.length!==1||correct[0]!.index!==s.correctOption||observed.solution!==(s.explanation??null))return fail("definition-changed");
        }
        await primary();return observed.inspection;
      });
    },
    closeOwnOnce(id:number):Promise<BoundPollClosed>{if(!msgId(id))return Promise.reject(new BoundPollError("input",mutationStarted));return run(async()=>{
      if(consumed)return fail("consumed");consumed=true;await primary();const before=await readMessage(id);if(!before.inspection.own)return fail("permission");
      if(before.definition.closed)return Object.freeze({status:"already-closed",poll:before.inspection});
      await permission();await primary();const latest=await readMessage(id);if(!latest.inspection.own||!sameDefinition(before.definition,latest.definition)||latest.definition.closed!==before.definition.closed)return fail("protocol");const d=before.definition;
      const closedPoll=new Api.Poll({id:bigInt(d.id),closed:true,publicVoters:!d.anonymous,multipleChoice:d.type==="multiple",quiz:d.type==="quiz",question:new Api.TextWithEntities({text:d.question,entities:[]}),
        answers:d.options.map(o=>new Api.PollAnswer({text:new Api.TextWithEntities({text:o.text,entities:[]}),option:Buffer.from(o.option)}))});
      await request(new Api.messages.EditMessage({peer,id,media:new Api.InputMediaPoll({poll:closedPoll})}),v=>{const list=updates(v);const polls=list.filter(u=>u instanceof Api.UpdateMessagePoll);
        if(polls.some(u=>u.pollId.toString()!==d.id))return fail("protocol");return true;},true);
      const after=await inspectExact(id);if(!after.inspection.own||!sameDefinition(d,after.definition)||!after.definition.closed)return fail("protocol");
      return Object.freeze({status:"closed",poll:after.inspection});});},
    ownedRecord:():OwnedBoundPoll|undefined=>owned,
    async close():Promise<void>{revoked=true;await pending?.then(()=>{},()=>{});},
  });
}
