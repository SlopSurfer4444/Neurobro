import type { ForwardOrigin, MessageRef, TelegramPeer } from '../contracts.ts';
import type { TdObject } from './transport.ts';

export function telegramId(value: unknown): string {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new Error('missing or lossy Telegram identity');
}
function positive(value: unknown): string { const id=telegramId(value);if(!/^[1-9]\d*$/.test(id))throw new Error('invalid Telegram origin identity');return id; }
/** Provenance from native TDLib only. A signature or privacy-hidden name is not a user. */
export function forwardOrigin(message: TdObject, accountId: string): ForwardOrigin | undefined {
  const origin=message.forward_info?.origin;
  const signature=typeof origin?.author_signature==='string'&&origin.author_signature?{authorSignature:origin.author_signature}:{};
  switch(origin?.['@type']) {
    case 'messageOriginUser': return {kind:'user',userId:positive(origin.sender_user_id)};
    case 'messageOriginHiddenUser': return {kind:'hidden-user',name:String(origin.sender_name??'')};
    case 'messageOriginChat': return {kind:'chat',peerId:telegramId(origin.sender_chat_id),...signature};
    case 'messageOriginChannel': return {kind:'channel',ref:{accountId,peerId:telegramId(origin.chat_id),messageId:positive(origin.message_id)},...signature};
    default: return undefined;
  }
}
export type PeerSelector = {peerId:string}|{username:string}|{messageUrl:string;publicUsername?:string};
export function parsePeerSelector(selector: string): PeerSelector {
  if(typeof selector!=='string'||selector!==selector.trim()||selector.length>2048)throw new Error('invalid Telegram peer selector');
  if(/^-?[1-9]\d*$/.test(selector))return{peerId:selector};
  if(/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(selector))return{username:selector.slice(1)};
  let url:URL;try{url=new URL(selector);}catch{throw new Error('expected exact Telegram ID, @username or public message link');}
  if(url.protocol!=='https:'||!['t.me','telegram.me','www.t.me','www.telegram.me'].includes(url.hostname)||url.username||url.password||url.port||url.hash)throw new Error('unsupported Telegram peer link');
  const path=url.pathname.split('/').filter(Boolean);
  if(path[0]==='s')path.shift();
  const username=/^[A-Za-z][A-Za-z0-9_]{3,31}$/;
  if(path.length===1&&username.test(path[0]!)&&!url.search)return{username:path[0]!};
  const publicMessage=[2,3].includes(path.length)&&username.test(path[0]!)&&path.slice(1).every(v=>/^[1-9]\d*$/.test(v));
  if(publicMessage||([3,4].includes(path.length)&&path[0]==='c'&&path.slice(1).every(v=>/^[1-9]\d*$/.test(v)))) {
    if([...url.searchParams.keys()].some(k=>!['single','thread','comment','t'].includes(k)))throw new Error('unsupported Telegram message link option');
    return{messageUrl:url.toString(),...(publicMessage?{publicUsername:path[0]!}:{})};
  }
  throw new Error('unsupported Telegram peer link');
}
export function messageReference(message:TdObject,accountId:string):MessageRef {
  const ref:MessageRef={accountId,peerId:telegramId(message.chat_id),messageId:positive(message.id)};
  const topic=message.topic_id;const thread=topic?.message_thread_id??topic?.forum_topic_id??topic?.direct_messages_chat_topic_id??topic?.saved_messages_topic_id;
  if(thread&&String(thread)!=='0')ref.threadId=positive(thread);
  return ref;
}
export async function peerMetadata(chat:TdObject,accountId:string,invoke:(request:TdObject)=>Promise<TdObject>,expectedUsername?:string):Promise<TelegramPeer> {
  const peerId=telegramId(chat.id);if(peerId==='0')throw new Error('Telegram peer unavailable');
  const base={accountId,peerId,title:String(chat.title??'')};let usernames:string[]=[];let result:TelegramPeer;
  switch(chat.type?.['@type']) {
    case 'chatTypePrivate': {
      const userId=positive(chat.type.user_id),user=await invoke({'@type':'getUser',user_id:userId});
      if(telegramId(user.id)!==userId)throw new Error('Telegram user identity mismatch');
      if(user.have_access===false||!['userTypeRegular','userTypeBot'].includes(user.type?.['@type']))throw new Error('Telegram user inaccessible or deleted');
      usernames=user.usernames?.active_usernames??[];
      result={...base,userId,kind:user.type['@type']==='userTypeBot'?'bot':'user'};break;
    }
    case 'chatTypeBasicGroup': result={...base,kind:'group'};break;
    case 'chatTypeSupergroup': {
      const id=positive(chat.type.supergroup_id),group=await invoke({'@type':'getSupergroup',supergroup_id:id});
      if(telegramId(group.id)!==id)throw new Error('Telegram group identity mismatch');
      if(group.is_channel!==undefined&&!!group.is_channel!==!!chat.type.is_channel)throw new Error('Telegram group type mismatch');
      usernames=group.usernames?.active_usernames??[];result={...base,kind:chat.type.is_channel?'channel':'group'};break;
    }
    default: throw new Error('unsupported Telegram peer type');
  }
  if(expectedUsername&&!usernames.some(v=>typeof v==='string'&&v.toLowerCase()===expectedUsername.toLowerCase()))throw new Error('Telegram username does not match resolved active identity');
  const username=expectedUsername?usernames.find(v=>v.toLowerCase()===expectedUsername.toLowerCase()):usernames[0];
  return {...result,...(username?{username}:{})};
}
