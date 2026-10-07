import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TdlibTelegram,type TdJsonTransport,type TdObject,type TelegramReceiptStore } from '../../src/telegram/index.ts';
const receipts:TelegramReceiptStore={get:async()=>undefined,put:async()=>{},findMessage:async()=>undefined};
function fixture(){let privatePeer=false,wrongId=false,noUsername=false,groupOnly=false;const calls:TdObject[]=[];
  class Fake extends EventEmitter implements TdJsonTransport{
    async invoke(r:TdObject):Promise<TdObject>{calls.push(r);switch(r['@type']){
      case 'getMe':return{'@type':'user',id:'42'};
      case 'getChat':return{'@type':'chat',id:wrongId?'99':r.chat_id,title:'Jobs',type:privatePeer?{'@type':'chatTypePrivate',user_id:'77'}:{'@type':'chatTypeSupergroup',supergroup_id:'55',is_channel:!groupOnly}};
      case 'getSupergroup':return{'@type':'supergroup',id:'55',is_channel:!groupOnly,usernames:{active_usernames:noUsername?[]:['JobsChannel'],disabled_usernames:['DisabledName'],editable_username:'DisabledName'}};
      case 'getUser':return{'@type':'user',id:'77',have_access:true,type:{'@type':'userTypeRegular'},usernames:{active_usernames:noUsername?[]:['PosterName']}};
      case 'getSupergroupFullInfo':return{'@type':'supergroupFullInfo',description:'Work https://example.com/jobs and https://t.me/OtherJobs.',linked_chat_id:'-10066',direct_messages_chat_id:'0'};
      case 'getUserFullInfo':return{'@type':'userFullInfo',bio:{text:'Founder contact',entities:[{offset:0,length:7,type:{'@type':'textEntityTypeTextUrl',url:'https://example.com/about'}}]},personal_chat_id:'-10088'};
      case 'getInternalLink':return{'@type':'httpUrl',url:'https://t.me/'+r.type.chat_username+'?profile'};
      case 'getChatSimilarChats':return{'@type':'chats',total_count:10,chat_ids:['-10011','-10022','-10011']};
      default:throw new Error('unexpected '+r['@type']);
    }}async close(){}
  }
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts});return{port,calls,transport,flags:(args:{privatePeer?:boolean;wrongId?:boolean;noUsername?:boolean;groupOnly?:boolean})=>{privatePeer=args.privatePeer??false;wrongId=args.wrongId??false;noUsername=args.noUsername??false;groupOnly=args.groupOnly??false;}};
}
test('channel inspect resolves native group ID, exposes description links/linked community and official active public profile link',async()=>{
  const f=fixture(),result=await f.port.readCapability('telegram.peer.inspect',{peerId:'-10055'}) as any;
  assert.equal(result.peer.peerId,'-10055');assert.deepEqual(result.links,['https://example.com/jobs','https://t.me/OtherJobs']);assert.deepEqual(result.linkedPeerIds,['-10066']);assert.equal(result.publicProfileLink,'https://t.me/JobsChannel?profile');assert.match(result.freshness,/cache/);
  assert.equal(f.calls.find(r=>r['@type']==='getSupergroupFullInfo')?.supergroup_id,'55');assert.deepEqual(f.calls.find(r=>r['@type']==='getInternalLink')?.type,{'@type':'internalLinkTypePublicChat',chat_username:'JobsChannel',draft_text:'',open_profile:true});await f.port.close();
});
test('private profile uses native user identity and hidden text-url entities without guessing user chat ID',async()=>{
  const f=fixture();f.flags({privatePeer:true});const result=await f.port.readCapability('telegram.peer.inspect',{peerId:'780'}) as any;
  assert.equal(result.peer.userId,'77');assert.equal(result.peer.peerId,'780');assert.deepEqual(result.links,['https://example.com/about']);assert.deepEqual(result.linkedPeerIds,['-10088']);assert.equal(f.calls.find(r=>r['@type']==='getUserFullInfo')?.user_id,'77');await f.port.close();
});
test('disabled username does not become active profile link; metadata access never joins or sends',async()=>{
  const f=fixture();f.flags({noUsername:true});const result=await f.port.readCapability('telegram.peer.inspect',{peerId:'-10055'}) as any;
  assert.equal(result.publicProfileLink,undefined);assert.equal(f.calls.some(r=>['getInternalLink','getUserLink','joinChat','sendMessage','createPrivateChat'].includes(r['@type'])),false);await f.port.close();
});
test('related channels hydrate a bounded unique result with explicit non-exhaustive truncation',async()=>{
  const f=fixture(),result=await f.port.readCapability('telegram.channels.related',{peerId:'-10055',limit:1}) as any;
  assert.equal(result.peers.length,1);assert.equal(result.peers[0].peerId,'-10011');assert.equal(result.truncated,true);assert.match(result.coverage,/not exhaustive/);assert.deepEqual(f.calls.filter(r=>r['@type']==='getChat').map(r=>r.chat_id),['-10055','-10011']);await f.port.close();
});
test('recommendations reject groups, private peers, lossy IDs and invalid bounds before server search',async()=>{
  for(const flags of [{groupOnly:true},{privatePeer:true},{wrongId:true}]){const f=fixture();f.flags(flags);await assert.rejects(f.port.readCapability('telegram.channels.related',{peerId:'-10055',limit:1}));assert.equal(f.calls.some(r=>r['@type']==='getChatSimilarChats'),false);await f.port.close();}
  const f=fixture();for(const limit of [0,21,1.5])await assert.rejects(f.port.readCapability('telegram.channels.related',{peerId:'-10055',limit}));await assert.rejects(f.port.readCapability('telegram.peer.inspect',{peerId:9007199254740992}),/lossy|out of range/);await f.port.close();
});
test('description and entity links are bounded, credential-bearing links omitted, cache coverage explicit',async()=>{
  const f=fixture(),original=f.transport.invoke.bind(f.transport);f.transport.invoke=async r=>r['@type']==='getSupergroupFullInfo'?{'@type':'supergroupFullInfo',description:'https://user:secret@example.com/ '+'x'.repeat(20000),linked_chat_id:'0',direct_messages_chat_id:'0'}:original(r);
  const result=await f.port.readCapability('telegram.peer.inspect',{peerId:'-10055'}) as any;assert.equal(result.description.length,16384);assert.equal(result.descriptionTruncated,true);assert.deepEqual(result.links,[]);assert.equal(result.coverage,'visible-metadata');await f.port.close();
});
test('native entity destinations retain punctuation and prose links retain balanced parentheses',async()=>{
  const f=fixture();f.flags({privatePeer:true});const original=f.transport.invoke.bind(f.transport);f.transport.invoke=async r=>r['@type']==='getUserFullInfo'?{'@type':'userFullInfo',bio:{text:'See (https://example.com/jobs_(remote)).',entities:[{offset:0,length:3,type:{'@type':'textEntityTypeTextUrl',url:'https://example.com/apply!'}}]}}:original(r);
  const result=await f.port.readCapability('telegram.peer.inspect',{peerId:'780'}) as any;assert.deepEqual(result.links,['https://example.com/apply!','https://example.com/jobs_(remote)']);await f.port.close();
});
test('bot profile inspection returns visible short and full description links when user bio is null',async()=>{
  const f=fixture();f.flags({privatePeer:true});const original=f.transport.invoke.bind(f.transport);f.transport.invoke=async r=>r['@type']==='getUser'?{'@type':'user',id:'77',have_access:true,type:{'@type':'userTypeBot'},usernames:{active_usernames:[]}}:r['@type']==='getUserFullInfo'?{'@type':'userFullInfo',bio:null,bot_info:{'@type':'botInfo',short_description:'Jobs https://example.com/jobs',description:'Apply https://example.com/apply'}}:original(r);
  const result=await f.port.readCapability('telegram.peer.inspect',{peerId:'780'}) as any;assert.equal(result.peer.kind,'bot');assert.deepEqual(result.links,['https://example.com/jobs','https://example.com/apply']);assert.equal(result.description,'Jobs https://example.com/jobs\nApply https://example.com/apply');await f.port.close();
});
test('prose heuristics never add rewritten alternatives inside authoritative native link entities',async()=>{
  const f=fixture();f.flags({privatePeer:true});const original=f.transport.invoke.bind(f.transport),text='https://example.com/apply.';f.transport.invoke=async r=>r['@type']==='getUserFullInfo'?{'@type':'userFullInfo',bio:{text,entities:[{offset:0,length:text.length,type:{'@type':'textEntityTypeUrl'}}]}}:original(r);
  assert.deepEqual((await f.port.readCapability('telegram.peer.inspect',{peerId:'780'}) as any).links,[text]);await f.port.close();
});
