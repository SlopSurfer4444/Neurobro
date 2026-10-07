import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TdlibTelegram, TdRequestError, type TdJsonTransport, type TdObject, type TelegramReceiptStore } from '../../src/telegram/index.ts';

const receipts:TelegramReceiptStore={get:async()=>undefined,put:async()=>{},findMessage:async()=>undefined};
const chat=(id:string,userId=id,title='Кита'):TdObject=>({'@type':'chat',id,title,type:{'@type':'chatTypePrivate',user_id:userId}});
const user=(id:string,phone?:string):TdObject=>({'@type':'user',id,have_access:true,type:{'@type':'userTypeRegular'},usernames:{active_usernames:[]},...(phone?{phone_number:phone}:{})});
const chats=(ids:string[],total_count=ids.length):TdObject=>({'@type':'chats',chat_ids:ids,total_count});
const contacts=(ids:string[],total_count=ids.length):TdObject=>({'@type':'users',user_ids:ids,total_count});
class Fake extends EventEmitter implements TdJsonTransport {
  calls:TdObject[]=[];
  handle:(request:TdObject)=>Promise<TdObject>=async request=>{
    switch(request['@type']){
      case 'searchChats':case 'searchChatsOnServer':case 'searchPublicChats':return chats([]);
      case 'searchContacts':return contacts([]);
      case 'createPrivateChat':return chat(String(request.user_id));
      case 'getChat':return chat(String(request.chat_id));
      case 'getUser':return user(String(request.user_id));
      default:throw new Error('Unexpected TDLib method');
    }
  };
  async invoke(request:TdObject):Promise<TdObject>{this.calls.push(request);if(request['@type']==='getMe')return user('42');return this.handle(request);}
  async close(){}
}
const make=()=>{const transport=new Fake(),port=new TdlibTelegram({accountId:'42',transport,receipts});return{transport,port};};
const discover=async(port:TdlibTelegram,query='Кита',limit=20):Promise<any>=>port.readCapability('telegram.source.discover',{query,limit});
const forbidden=['sendMessage','joinChat','importContacts','addContact','setName','setAuthenticationPhoneNumber'];

test('existing Cyrillic dialog without public username is discovered before contacts and public search',async()=>{
  const {transport,port}=make(),fallback=transport.handle;
  transport.handle=async request=>request['@type']==='searchChats'?chats(['77']):request['@type']==='searchContacts'?contacts(['77','88']):request['@type']==='searchChatsOnServer'?chats(['77','99']):request['@type']==='searchPublicChats'?chats(['77','111']):fallback(request);
  const result=await discover(port,' Кита ');
  assert.deepEqual(result.peers.map((peer:any)=>peer.peerId),['77','88','99','111']);
  assert.deepEqual(result.peers[0],{accountId:'42',peerId:'77',kind:'user',userId:'77',title:'Кита'});
  assert.deepEqual(result.matches[0],{peerId:'77',sources:['known-chat','contact','known-chat-server','public']});
  assert.deepEqual(transport.calls.filter(request=>['searchChats','searchContacts','searchChatsOnServer','searchPublicChats'].includes(request['@type'])).map(request=>request['@type']),['searchChats','searchContacts','searchChatsOnServer','searchPublicChats']);
  assert.equal(transport.calls[1]?.query,'Кита');
  assert.deepEqual(transport.calls.filter(request=>request['@type']==='createPrivateChat').map(request=>request.user_id),['88']);
  assert.equal(result.selectionRequired,true);assert.equal(result.truncated,false);
  assert.equal(transport.calls.some(request=>forbidden.includes(request['@type'])),false);await port.close();
});

test('same-name contacts preserve each identity and bounded output stays explicitly ambiguous',async()=>{
  const {transport,port}=make(),fallback=transport.handle;
  transport.handle=async request=>request['@type']==='searchContacts'?contacts(['9007199254740990','9007199254740991']):fallback(request);
  const result=await discover(port);assert.deepEqual(result.peers.map((peer:any)=>peer.userId),['9007199254740990','9007199254740991']);
  assert.equal(result.selectionRequired,true);assert.equal(result.truncated,false);
  const bounded=await discover(port,'Кита',1);assert.equal(bounded.peers.length,1);assert.equal(bounded.truncated,true);assert.equal(bounded.selectionRequired,true);
  assert.equal(transport.calls.some(request=>forbidden.includes(request['@type'])),false);await port.close();
});

test('contact discovery refreshes native chat identity and never substitutes user ID for chat ID',async()=>{
  const {transport,port}=make(),fallback=transport.handle;
  transport.handle=async request=>request['@type']==='searchContacts'?contacts(['77']):request['@type']==='createPrivateChat'?chat('780','77'):request['@type']==='getChat'?chat('780','77'):fallback(request);
  const result=await discover(port);assert.equal(result.peers[0].peerId,'780');assert.equal(result.peers[0].userId,'77');
  assert.deepEqual(transport.calls.filter(request=>request['@type']==='getChat').map(request=>request.chat_id),['780']);
  await port.close();
});

test('swapped contact chat, refreshed chat, and hydrated user are rejected',async()=>{
  for(const stage of ['createPrivateChat','getChat','getUser']){
    const {transport,port}=make(),fallback=transport.handle;
    transport.handle=async request=>request['@type']==='searchContacts'?contacts(['77']):request['@type']===stage?stage==='getUser'?user('78'):chat(stage==='getChat'?'77':'78','78'):fallback(request);
    await assert.rejects(discover(port),/identity mismatch/);assert.equal(transport.calls.some(request=>forbidden.includes(request['@type'])),false);await port.close();
  }
});

test('formatted phone uses local exact lookup and never leaks phone into discovery metadata',async()=>{
  const {transport,port}=make(),fallback=transport.handle;
  transport.handle=async request=>request['@type']==='searchUserByPhoneNumber'?user('77','79991234567'):fallback(request);
  const result=await discover(port,'+7 (999) 123-45-67');
  assert.deepEqual(transport.calls.filter(request=>request['@type']==='searchUserByPhoneNumber'),[{'@type':'searchUserByPhoneNumber',phone_number:'+79991234567',only_local:true}]);
  assert.deepEqual(result.matches,[{peerId:'77',sources:['phone-local']}]);assert.equal(result.peers[0].peerId,'77');
  assert.equal(JSON.stringify(result).includes('79991234567'),false);assert.equal(transport.calls.some(request=>request['@type'].startsWith('search')&&request['@type']!=='searchUserByPhoneNumber'),false);
  assert.equal(transport.calls.some(request=>forbidden.includes(request['@type'])),false);await port.close();
});

test('only local phone not-found permits server fallback; two not-found results cannot guess a chat',async()=>{
  for(const serverFound of [true,false]){
    const {transport,port}=make(),fallback=transport.handle;
    transport.handle=async request=>{if(request['@type']==='searchUserByPhoneNumber'){if(request.only_local||!serverFound)throw new TdRequestError('not found',false,404);return user('77');}return fallback(request);};
    const result=await discover(port,'+79991234567');
    assert.deepEqual(transport.calls.filter(request=>request['@type']==='searchUserByPhoneNumber').map(request=>request.only_local),[true,false]);
    assert.equal(result.peers.length,serverFound?1:0);assert.equal(result.selectionRequired,false);
    assert.equal(transport.calls.some(request=>request['@type']==='getChat'&&request.chat_id==='79991234567'),false);
    assert.equal(transport.calls.some(request=>forbidden.includes(request['@type'])),false);await port.close();
  }
});

test('phone timeout, flood, or returned phone mismatch cannot fall back to fuzzy search',async()=>{
  for(const failure of [new TdRequestError('timeout',true),new TdRequestError('rate limited',false,429),'mismatch']){
    const {transport,port}=make();transport.handle=async()=>{if(failure==='mismatch')return user('77','79997654321');throw failure;};
    await assert.rejects(discover(port,'+79991234567'),/timeout|rate limited|identity mismatch/);
    assert.deepEqual(transport.calls.map(request=>request['@type']),['getMe','searchUserByPhoneNumber']);await port.close();
  }
});

test('bare numeric ID and exact username remain selectors rather than phone or fuzzy search',async()=>{
  const {transport,port}=make(),fallback=transport.handle;
  transport.handle=async request=>request['@type']==='searchPublicChat'?chat('77'):request['@type']==='getUser'&&request.user_id==='77'?{...user('77'),usernames:{active_usernames:['Selected_Poster']}}:fallback(request);
  assert.equal((await discover(port,'8311787601')).peers[0].peerId,'8311787601');
  assert.equal((await discover(port,'@Selected_Poster')).peers[0].username,'Selected_Poster');
  assert.equal(transport.calls.some(request=>['searchUserByPhoneNumber','searchChats','searchContacts','searchChatsOnServer','searchPublicChats'].includes(request['@type'])),false);await port.close();
});

test('all native read failures, malformed responses and lossy IDs are not reported as empty discovery',async()=>{
  for(const response of [new TdRequestError('known chat unavailable',true),{'@type':'chat',id:'77'},chats(['0']),{'@type':'chats',chat_ids:[9007199254740992]}]){
    const {transport,port}=make();transport.handle=async()=>{if(response instanceof Error)throw response;return response;};
    await assert.rejects(discover(port),/unavailable|invalid native|lossy/);
    assert.deepEqual(transport.calls.map(request=>request['@type']),response instanceof TdRequestError?['getMe','searchChats','searchContacts','searchChatsOnServer','searchPublicChats']:['getMe','searchChats']);await port.close();
  }
});

test('later remote failure preserves found local dialog with explicit sanitized coverage gap',async()=>{
  const {transport,port}=make(),fallback=transport.handle;
  transport.handle=async request=>{if(request['@type']==='searchChats')return chats(['77']);if(request['@type']==='searchPublicChats')throw new TdRequestError('secret native text must not be returned',true);return fallback(request);};
  const result=await discover(port);assert.equal(result.peers[0].peerId,'77');assert.equal(result.incomplete,true);assert.equal(result.selectionRequired,true);
  assert.deepEqual(result.unavailableSources,[{source:'public'}]);assert.deepEqual(result.skippedSources,[]);assert.equal(JSON.stringify(result).includes('secret native text'),false);await port.close();
});

test('FLOOD_WAIT preserves local identities and prevents any later lookup or network phase',async()=>{
  for(const limitedStage of ['searchContacts','searchChatsOnServer']){
    const {transport,port}=make(),fallback=transport.handle;
    transport.handle=async request=>{if(request['@type']==='searchChats')return chats(['77']);if(request['@type']===limitedStage)throw new TdRequestError('rate limited',true,429,'FLOOD_WAIT_10');return fallback(request);};
    const result=await discover(port);assert.equal(result.peers[0].peerId,'77');assert.equal(result.incomplete,true);assert.equal(result.selectionRequired,true);
    assert.deepEqual(result.unavailableSources,[{source:limitedStage==='searchContacts'?'contact':'known-chat-server',code:429,reason:'FLOOD_WAIT'}]);
    const last=transport.calls.findIndex(request=>request['@type']===limitedStage);assert.equal(last,transport.calls.length-1);
    assert.deepEqual(result.skippedSources,limitedStage==='searchContacts'?['known-chat-server','public']:['public']);await port.close();
  }
});

test('search and hydration fanout are bounded and native truncation remains visible',async()=>{
  const {transport,port}=make(),fallback=transport.handle;
  transport.handle=async request=>request['@type']==='searchChats'?chats(['77','78','79','80'],100):request['@type']==='searchContacts'?contacts(['88','89']):request['@type']==='searchPublicChats'?chats(['111','112','113']):fallback(request);
  const result=await discover(port,'Кита',1);assert.equal(result.peers.length,1);assert.equal(result.truncated,true);assert.equal(result.selectionRequired,true);
  assert.equal(transport.calls.filter(request=>request['@type']==='getChat').length,2);assert.equal(transport.calls.some(request=>request['@type']==='createPrivateChat'),false);
  assert.equal(transport.calls.find(request=>request['@type']==='searchChats')?.limit,2);await port.close();
});

test('invalid query, phone and output limits fail before any search request',async()=>{
  const {transport,port}=make();
  for(const query of ['', ' ', '+123', '+7999ABC1234567'])await assert.rejects(discover(port,query),/query required|international phone/);
  for(const limit of [0,101,1.5])await assert.rejects(discover(port,'Кита',limit),/limit/);
  assert.equal(transport.calls.every(request=>request['@type']==='getMe'),true);await port.close();
});
