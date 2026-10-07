import type { Json } from '../contracts.ts';
import { peerMetadata, telegramId } from './identity.ts';
import type { TdObject } from './transport.ts';

type Invoke=(request:TdObject)=>Promise<TdObject>;
const bound=(value:unknown,max:number):string=>typeof value==='string'?value.slice(0,max).replace(/[\uD800-\uDBFF]$/u,''):'';
/** Bounded visible profile links. Link destinations and descriptions are untrusted data. */
function links(text:string,entities:TdObject[]=[]):string[]{
  const candidates:{value:string;prose?:true}[]=[],entitySpans:{start:number;end:number}[]=[];for(const entity of entities.slice(0,128)){
    if(['textEntityTypeTextUrl','textEntityTypeUrl'].includes(entity.type?.['@type'])&&Number.isInteger(entity.offset)&&Number.isInteger(entity.length)&&entity.offset>=0&&entity.length>0&&entity.offset+entity.length<=text.length)entitySpans.push({start:entity.offset,end:entity.offset+entity.length});
    if(entity.type?.['@type']==='textEntityTypeTextUrl'&&typeof entity.type.url==='string')candidates.push({value:entity.type.url});
    else if(entity.type?.['@type']==='textEntityTypeUrl'&&Number.isInteger(entity.offset)&&Number.isInteger(entity.length)&&entity.offset>=0&&entity.length>0&&entity.offset+entity.length<=text.length)candidates.push({value:text.slice(entity.offset,entity.offset+entity.length)});
  }
  for(const match of text.matchAll(/https?:\/\/[^\s<>]+/gu)){const start=match.index,end=start+match[0].length;if(entitySpans.some(span=>start<span.end&&end>span.start))continue;candidates.push({value:match[0],prose:true});}const result=new Set<string>();
  for(const candidate of candidates){if(candidate.value.length>2048)continue;let value=candidate.value;
    if(candidate.prose){value=value.replace(/[.,;]+$/u,'');while(value.endsWith(')')&&(value.match(/\)/gu)?.length??0)>(value.match(/\(/gu)?.length??0))value=value.slice(0,-1);}
    try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;result.add(url.toString());if(result.size>=32)break;}catch{}}
  return[...result];
}
export async function inspectPeer(peerId:string,accountId:string,invoke:Invoke):Promise<Json>{
  const chat=await invoke({'@type':'getChat',chat_id:peerId});if(telegramId(chat.id)!==peerId)throw new Error('Telegram inspection peer identity mismatch');
  const peer=await peerMetadata(chat,accountId,invoke),type=chat.type?.['@type'];let full:TdObject,description='',sourceDescription='';let entities:TdObject[]=[];let linkedPeerIds:string[]=[];
  if(type==='chatTypePrivate'){
    full=await invoke({'@type':'getUserFullInfo',user_id:peer.userId});sourceDescription=peer.kind==='bot'?[full.bot_info?.short_description,full.bot_info?.description].filter(value=>typeof value==='string'&&value).join('\n'):typeof full.bio?.text==='string'?full.bio.text:'';description=bound(sourceDescription,16384);entities=peer.kind==='bot'?[]:Array.isArray(full.bio?.entities)?full.bio.entities:[];
    if(full.personal_chat_id&&String(full.personal_chat_id)!=='0')linkedPeerIds=[telegramId(full.personal_chat_id)];
  }else if(type==='chatTypeSupergroup'){
    full=await invoke({'@type':'getSupergroupFullInfo',supergroup_id:telegramId(chat.type.supergroup_id)});sourceDescription=typeof full.description==='string'?full.description:'';description=bound(sourceDescription,16384);
    linkedPeerIds=[full.linked_chat_id,full.direct_messages_chat_id].filter(value=>value&&String(value)!=='0').map(telegramId);
  }else{full=await invoke({'@type':'getBasicGroupFullInfo',basic_group_id:telegramId(chat.type.basic_group_id)});sourceDescription=typeof full.description==='string'?full.description:'';description=bound(sourceDescription,16384);}
  let publicProfileLink:string|undefined;
  if(peer.username){const result=await invoke({'@type':'getInternalLink',type:{'@type':'internalLinkTypePublicChat',chat_username:peer.username,draft_text:'',open_profile:true},is_http:true});
    if(result['@type']!=='httpUrl'||typeof result.url!=='string')throw new Error('invalid Telegram public profile link');const parsed=new URL(result.url);if(parsed.protocol!=='https:'||!['t.me','telegram.me'].includes(parsed.hostname)||parsed.username||parsed.password)throw new Error('invalid Telegram public profile link');publicProfileLink=result.url;
  }
  return{status:'observed',peer:peer as unknown as Json,description,links:links(description,entities),linkedPeerIds:[...new Set(linkedPeerIds)],...(publicProfileLink?{publicProfileLink}:{}),descriptionTruncated:sourceDescription.length>16384,coverage:'visible-metadata',freshness:'TDLib full-info cache may be up to one minute old; no membership or sending authority granted'};
}
export async function relatedChannels(peerId:string,accountId:string,limit:number,invoke:Invoke):Promise<Json>{
  if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('Telegram related channel limit must be 1..20');
  const chat=await invoke({'@type':'getChat',chat_id:peerId});if(telegramId(chat.id)!==peerId||chat.type?.['@type']!=='chatTypeSupergroup'||chat.type.is_channel!==true)throw new Error('Telegram recommendations require an exact channel peer');
  const response=await invoke({'@type':'getChatSimilarChats',chat_id:peerId});if(response['@type']!=='chats'||!Array.isArray(response.chat_ids))throw new Error('invalid Telegram related channel response');
  const ids=[...new Set<string>(response.chat_ids.map(telegramId))];if(ids.some(id=>id==='0'))throw new Error('invalid Telegram related channel identity');
  const peers=[];for(const id of ids.slice(0,limit)){const candidate=await invoke({'@type':'getChat',chat_id:id});if(telegramId(candidate.id)!==id)throw new Error('Telegram recommended peer identity mismatch');const peer=await peerMetadata(candidate,accountId,invoke);if(peer.kind!=='channel')throw new Error('Telegram recommendation returned a non-channel');peers.push(peer);}
  return{status:'observed',peers:peers as unknown as Json,truncated:ids.length>limit||(typeof response.total_count==='number'&&response.total_count>ids.length),coverage:'Telegram recommendations, not exhaustive related communities; discovery grants no membership, read or send rights'};
}
