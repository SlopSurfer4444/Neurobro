import { createHash } from 'node:crypto';
import type { TdObject } from './transport.ts';
import { telegramId } from './identity.ts';

const flags=['exclude_muted','exclude_read','exclude_archived','include_contacts','include_non_contacts','include_bots','include_groups','include_channels'] as const;
export function folderId(value:unknown):number{if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>2147483647)throw new Error('invalid Telegram folder identity');return value;}
export function folderName(value:unknown):string{if(typeof value!=='string'||!value.trim()||[...value].length>12||/[\r\n\u0000]/u.test(value))throw new Error('Telegram folder name must be 1..12 characters without line feeds');return value;}
export function folderPeers(value:unknown,allowEmpty=false,max=50):string[]{if(!Array.isArray(value)||value.length>max||(!allowEmpty&&!value.length))throw new Error('Telegram folder peers must be a bounded explicit list');const peers=value.map(telegramId);if(peers.some(id=>id==='0')||new Set(peers).size!==peers.length)throw new Error('Telegram folder peer identities must be unique and nonzero');return peers;}
/** Canonical native state, including every membership filter. Pinned order remains meaningful. */
export function canonicalFolder(folder:TdObject):TdObject{
  if(folder['@type']!=='chatFolder'||typeof folder.name?.text?.text!=='string')throw new Error('invalid native Telegram folder');
  const result:TdObject={'@type':'chatFolder',name:structuredClone(folder.name),icon:folder.icon??null,color_id:folder.color_id??-1,is_shareable:!!folder.is_shareable,
    pinned_chat_ids:folderPeers(folder.pinned_chat_ids??[],true,1000),included_chat_ids:folderPeers(folder.included_chat_ids??[],true,1000).sort(),excluded_chat_ids:folderPeers(folder.excluded_chat_ids??[],true,1000).sort()};
  for(const flag of flags)result[flag]=!!folder[flag];return result;
}
export function folderVersion(folder:TdObject):string{return createHash('sha256').update(JSON.stringify(canonicalFolder(folder))).digest('hex');}
export function newFolder(args:TdObject):TdObject{
  return canonicalFolder({'@type':'chatFolder',name:{'@type':'chatFolderName',text:{'@type':'formattedText',text:folderName(args.name),entities:[]},animate_custom_emoji:false},icon:{'@type':'chatFolderIcon',name:'Work'},color_id:-1,is_shareable:false,pinned_chat_ids:[],included_chat_ids:folderPeers(args.peerIds),excluded_chat_ids:[]});
}
/** Bounded add/remove patch preserves existing filters, pins, icon, shareability and custom emoji. */
export function patchFolder(current:TdObject,args:TdObject):TdObject{
  const folder=canonicalFolder(current);if(typeof args.expectedVersion!=='string'||folderVersion(folder)!==args.expectedVersion)throw new Error('Telegram folder changed before dispatch');
  const add=folderPeers(args.addPeerIds??[],true),remove=folderPeers(args.removePeerIds??[],true);
  if(args.name===undefined&&!add.length&&!remove.length)throw new Error('Telegram folder update requires a change');
  if(add.some(id=>remove.includes(id)))throw new Error('Telegram folder patch adds and removes the same peer');
  if(args.name!==undefined)folder.name={'@type':'chatFolderName',text:{'@type':'formattedText',text:folderName(args.name),entities:[]},animate_custom_emoji:false};
  folder.pinned_chat_ids=folder.pinned_chat_ids.filter((id:string)=>!remove.includes(id));
  folder.included_chat_ids=[...new Set<string>([...folder.included_chat_ids.filter((id:string)=>!remove.includes(id)),...add.filter(id=>!folder.pinned_chat_ids.includes(id))])].sort();
  folder.excluded_chat_ids=folder.excluded_chat_ids.filter((id:string)=>!add.includes(id));
  // A removed explicit peer stays excluded even when category filters include it.
  if(flags.some(flag=>flag.startsWith('include_')&&folder[flag]))folder.excluded_chat_ids=[...new Set<string>([...folder.excluded_chat_ids,...remove])].sort();
  return canonicalFolder(folder);
}
export function folderView(id:number,folder:TdObject):TdObject{const native=canonicalFolder(folder);return{folderId:id,name:native.name.text.text,version:folderVersion(native),peerIds:[...native.pinned_chat_ids,...native.included_chat_ids],pinnedPeerIds:native.pinned_chat_ids,excludedPeerIds:native.excluded_chat_ids,shareable:native.is_shareable,filters:Object.fromEntries(flags.map(flag=>[flag,native[flag]]))};}
export function folderSnapshotView(update:TdObject):TdObject{
  if(update['@type']!=='updateChatFolders'||!Array.isArray(update.chat_folders))throw new Error('invalid Telegram folder snapshot');
  if(update.chat_folders.length>100)throw new Error('Telegram folder snapshot exceeds bound');const seen=new Set<number>();
  return{status:'observed',folders:update.chat_folders.map((folder:TdObject)=>{const id=folderId(folder.id);if(seen.has(id)||typeof folder.name?.text?.text!=='string')throw new Error('invalid Telegram folder snapshot');seen.add(id);return{folderId:id,name:folder.name.text.text,shareable:!!folder.is_shareable};})};
}
