import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TdlibTelegram, TdRequestError, type TdJsonTransport, type TdObject, type TelegramReceiptStore } from '../../src/telegram/index.ts';
import { forwardOrigin, parsePeerSelector } from '../../src/telegram/identity.ts';
const receipts:TelegramReceiptStore={get:async()=>undefined,put:async()=>{},findMessage:async()=>undefined};
class Fake extends EventEmitter implements TdJsonTransport {
  calls:TdObject[]=[];
  handle:(v:TdObject)=>Promise<TdObject>=async()=>{throw new Error('unexpected native method');};
  async invoke(v:TdObject){if(v['@type']==='getMe')return{'@type':'user',id:'42'};this.calls.push(v);return this.handle(v);}
  async close(){}
}
const peer=(id='77')=>({'@type':'chat',id,title:'Selected user',type:{'@type':'chatTypePrivate',user_id:id}});
const user=(id='77',username='Selected_Poster')=>({'@type':'user',id,have_access:true,type:{'@type':'userTypeRegular'},usernames:{active_usernames:[username],disabled_usernames:[]}});
const post=(origin?:TdObject):TdObject=>({'@type':'message',chat_id:'-100555',id:'1234567890123456',sender_id:{'@type':'messageSenderUser',user_id:'42'},is_outgoing:true,date:1,content:{'@type':'messageText',text:{text:'untrusted post'}},...(origin?{forward_info:{origin}}:{})});
test('forward provenance preserves all native variants and never uses signature as identity',()=>{
  assert.deepEqual(forwardOrigin(post({'@type':'messageOriginUser',sender_user_id:'9007199254740991'}),'42'),{kind:'user',userId:'9007199254740991'});
  assert.deepEqual(forwardOrigin(post({'@type':'messageOriginHiddenUser',sender_name:'Alice'}),'42'),{kind:'hidden-user',name:'Alice'});
  assert.deepEqual(forwardOrigin(post({'@type':'messageOriginChat',sender_chat_id:'-10066',author_signature:'Alice'}),'42'),{kind:'chat',peerId:'-10066',authorSignature:'Alice'});
  assert.deepEqual(forwardOrigin(post({'@type':'messageOriginChannel',chat_id:'-10066',message_id:'9007199254740991',author_signature:'Alice'}),'42'),{kind:'channel',ref:{accountId:'42',peerId:'-10066',messageId:'9007199254740991'},authorSignature:'Alice'});
  assert.equal(forwardOrigin(post(),'42'),undefined);
  assert.throws(()=>forwardOrigin(post({'@type':'messageOriginUser',sender_user_id:9007199254740992}),'42'),/lossy/);
});
test('exact username resolver refreshes identities and rejects renamed alias, swapped peer and unrelated URLs',async()=>{
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts});
  transport.handle=async v=>v['@type']==='getUser'?user():peer();
  assert.deepEqual(await port.resolvePeer('@selected_poster'),{accountId:'42',peerId:'77',kind:'user',userId:'77',title:'Selected user',username:'Selected_Poster'});
  assert.deepEqual(transport.calls.map(v=>v['@type']),['searchPublicChat','getChat','getUser']);
  transport.handle=async v=>v['@type']==='getUser'?user('77','Renamed_Poster'):peer();
  await assert.rejects(port.resolvePeer('@Selected_Poster'),/active identity/);
  transport.handle=async v=>v['@type']==='searchPublicChat'?peer():peer('78');
  await assert.rejects(port.resolvePeer('@Selected_Poster'),/peer identity mismatch/);
  for(const url of ['https://example.com/Selected_Poster','https://t.me/+invite','https://t.me/Selected_Poster?start=pay','https://user@t.me/Selected_Poster','file:///private.txt'])assert.throws(()=>parsePeerSelector(url),/unsupported/);
  assert.equal(transport.calls.some(v=>['sendMessage','joinChat'].includes(v['@type'])),false);await port.close();
});
test('public and private post links use native TDLib message references without integer conversion',async()=>{
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts});
  transport.handle=async()=>({'@type':'messageLinkInfo',chat_id:'-100555',message:{...post(),topic_id:{'@type':'messageTopicForum',forum_topic_id:'9007199254740991'}}});
  const expected={accountId:'42',peerId:'-100555',messageId:'1234567890123456',threadId:'9007199254740991'};
  assert.deepEqual(await port.resolveMessageLink('https://t.me/Jobs_Channel/12'),expected);
  assert.deepEqual(await port.resolveMessageLink('https://t.me/c/555/12'),expected);
  assert.deepEqual(await port.resolveMessageLink('https://t.me/Jobs_Channel/10/12'),expected);
  assert.equal(transport.calls.every(v=>v['@type']==='getMessageLinkInfo'),true);
  transport.handle=async()=>({'@type':'messageLinkInfo',chat_id:'-100999',message:post()});await assert.rejects(port.resolveMessageLink('https://t.me/Jobs_Channel/12'),/identity mismatch/);
  transport.handle=async()=>({'@type':'messageLinkInfo',chat_id:'0',message:null});assert.equal(await port.resolveMessageLink('https://t.me/Jobs_Channel/12'),undefined);await port.close();
});
test('selected author resolves native user; forwarded hidden/channel never resolves owner forwarder',async()=>{
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts}),ref={accountId:'42',peerId:'-100555',messageId:'1234567890123456'};
  let current=post({'@type':'messageOriginUser',sender_user_id:'77'});
  transport.handle=async v=>v['@type']==='getMessage'?current:v['@type']==='getUser'?user():peer();
  const known=await port.resolvePostAuthor(ref);assert.equal(known.user?.userId,'77');assert.deepEqual(known.sender,{kind:'user',userId:'42'});assert.equal(transport.calls.find(v=>v['@type']==='createPrivateChat')?.user_id,'77');
  for(const origin of [{'@type':'messageOriginHiddenUser',sender_name:'Selected_Poster'},{'@type':'messageOriginChannel',chat_id:'-10066',message_id:'123',author_signature:'Selected_Poster'},{'@type':'messageOriginChat',sender_chat_id:'-10066',author_signature:'Selected_Poster'}]){
    current=post(origin);transport.calls=[];const result=await port.resolvePostAuthor(ref);assert.equal(result.user,undefined);assert.ok(result.unavailableReason);assert.deepEqual(transport.calls.map(v=>v['@type']),['getMessage']);
  }
  current={...post(),sender_id:{'@type':'messageSenderChat',chat_id:'-10066'}};assert.equal((await port.resolvePostAuthor(ref)).user,undefined);
  await assert.rejects(port.resolvePostAuthor({...ref,accountId:'43'}),/cross-account/);
  transport.handle=async()=>({...post(),id:'1'});await assert.rejects(port.resolvePostAuthor(ref),/post identity mismatch/);
  transport.handle=async()=>{throw new TdRequestError('not found',false,404);};assert.equal((await port.resolvePostAuthor(ref)).unavailableReason,'post unavailable');await port.close();
});
test('forward provenance survives observations and durable spool intake without author substitution',async()=>{
  const transport=new Fake(),saved:any[]=[],port=new TdlibTelegram({accountId:'42',transport,receipts,spool:{append:async v=>{saved.push(v);}}});
  const controller=new AbortController(),iterator=port.observations(controller.signal)[Symbol.asyncIterator]();
  transport.emit('update',{'@type':'updateNewMessage',message:post({'@type':'messageOriginChannel',chat_id:'-10066',message_id:'123'})});
  const event=(await iterator.next()).value!;assert.equal(event.authorId,'42');assert.equal(event.forwarded,true);assert.deepEqual(event.forwardOrigin,{kind:'channel',ref:{accountId:'42',peerId:'-10066',messageId:'123'}});assert.deepEqual(saved[0].forwardOrigin,event.forwardOrigin);
  controller.abort();await iterator.return?.();await port.close();
});
test('discovery hydrates bounded peer metadata and exact selector never becomes fuzzy search',async()=>{
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts});transport.handle=async v=>v['@type']==='searchPublicChats'?{'@type':'chats',chat_ids:['77','77','78']}:['searchChats','searchChatsOnServer'].includes(v['@type'])?{'@type':'chats',chat_ids:[]}:v['@type']==='searchContacts'?{'@type':'users',user_ids:[]}:v['@type']==='getUser'?user(String(v.user_id)):peer(String(v.chat_id??'77'));
  const result:any=await port.readCapability('telegram.source.discover',{query:'jobs',limit:1});assert.equal(result.peers.length,1);assert.equal(result.peers[0].peerId,'77');assert.equal(result.truncated,true);assert.equal(result.coverage,'bounded');
  transport.calls=[];await port.readCapability('telegram.source.discover',{query:'@Selected_Poster'});assert.equal(transport.calls.some(v=>v['@type']==='searchPublicChats'),false);
  await assert.rejects(port.readCapability('telegram.source.discover',{query:'jobs',limit:101}),/limit/);await port.close();
});
test('channel discovery checks supergroup identity and active alias against the requested post URL',async()=>{
  const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts});
  const channel={'@type':'chat',id:'-100555',title:'Jobs',type:{'@type':'chatTypeSupergroup',supergroup_id:'555',is_channel:true}};
  let group={'@type':'supergroup',id:'555',is_channel:true,usernames:{active_usernames:['Jobs_Channel']}};
  transport.handle=async v=>v['@type']==='getMessageLinkInfo'?{'@type':'messageLinkInfo',chat_id:'-100555',message:post()}:v['@type']==='getSupergroup'?group:channel;
  assert.deepEqual(await port.resolvePeer('https://t.me/Jobs_Channel/12'),{accountId:'42',peerId:'-100555',kind:'channel',title:'Jobs',username:'Jobs_Channel'});
  group={...group,id:'999'};await assert.rejects(port.resolvePeer('@Jobs_Channel'),/group identity mismatch/);
  group={...group,id:'555',usernames:{active_usernames:['Other_Channel']}};await assert.rejects(port.resolvePeer('https://t.me/Jobs_Channel/12'),/active identity/);
  assert.equal(transport.calls.some(v=>['sendMessage','joinChat'].includes(v['@type'])),false);await port.close();
});
