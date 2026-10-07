import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TdlibTelegram,TdRequestError,type TdJsonTransport,type TdObject,type TelegramReceipt } from '../../src/telegram/index.ts';
import { folderVersion,newFolder } from '../../src/telegram/folders.ts';
import type { Effect } from '../../src/contracts.ts';

function fixture(){
  const receipts=new Map<string,TelegramReceipt>(),folders=new Map<number,TdObject>();let createTimeout=false,editTimeout=false,wrongResult=false,readWrong=false,snapshotMissing=false;
  class Fake extends EventEmitter implements TdJsonTransport{
    calls:TdObject[]=[];
    async invoke(request:TdObject):Promise<TdObject>{this.calls.push(structuredClone(request));switch(request['@type']){
      case 'getMe':return{'@type':'user',id:'42'};
      case 'getCurrentState':return{'@type':'updates',updates:snapshotMissing?[]:[{'@type':'updateChatFolders',chat_folders:[...folders].map(([id,folder])=>({'@type':'chatFolderInfo',id,name:folder.name}))}]};
      case 'getChat':return{'@type':'chat',id:request.chat_id,title:'Jobs',type:{'@type':'chatTypeSupergroup',supergroup_id:'99',is_channel:true}};
      case 'getSupergroup':return{'@type':'supergroup',id:'99',is_channel:true,usernames:{active_usernames:[]}};
      case 'createChatFolder':folders.set(3,structuredClone(request.folder));if(createTimeout)throw new TdRequestError('timeout after admission',true);return{'@type':'chatFolderInfo',id:wrongResult?0:3,name:request.folder.name};
      case 'editChatFolder':folders.set(request.chat_folder_id,structuredClone(request.folder));if(editTimeout)throw new TdRequestError('timeout after admission',true);return{'@type':'chatFolderInfo',id:wrongResult?99:request.chat_folder_id,name:request.folder.name};
      case 'getChatFolder':{const folder=folders.get(request.chat_folder_id);if(!folder)throw new TdRequestError('missing',false,404);return readWrong?{...structuredClone(folder),include_contacts:true}:structuredClone(folder);}
      default:throw new Error('unexpected TDLib method '+request['@type']);
    }}async close(){}
  }
  const transport=new Fake(),store={get:async(id:string)=>receipts.get(id),put:async(receipt:TelegramReceipt)=>{receipts.set(receipt.effectId,structuredClone(receipt));},findMessage:async()=>undefined};
  const port=new TdlibTelegram({accountId:'42',transport,receipts:store,folderReadyWaitMs:20});
  const effect=(capability='telegram.folder.create',payload:Effect['payload']={name:'Работа',peerIds:['-10099']}):Effect=>({id:'folder-1',taskId:'task',intentRevision:1,grantId:'grant',grantRevision:1,capability,resource:'42',payload,payloadHash:'hash',state:'prepared',createdAt:'',updatedAt:''});
  return{port,transport,store,folders,receipts,effect,flags:(flags:{createTimeout?:boolean;editTimeout?:boolean;wrongResult?:boolean;readWrong?:boolean;snapshotMissing?:boolean})=>{createTimeout=flags.createTimeout??false;editTimeout=flags.editTimeout??false;wrongResult=flags.wrongResult??false;readWrong=flags.readWrong??false;snapshotMissing=flags.snapshotMissing??false;}};
}

test('create folder journals exact intent and stable native ID, validates pinned constructors and verifies full readback',async()=>{
  const f=fixture();assert.equal((await f.port.dispatch(f.effect())).state,'verified');
  const request=f.transport.calls.find(r=>r['@type']==='createChatFolder')!;
  assert.equal(request.folder.name.text.text,'Работа');assert.equal(request.folder.icon.name,'Work');assert.equal(request.folder.color_id,-1);assert.deepEqual(request.folder.included_chat_ids,['-10099']);assert.equal(request.folder.include_channels,false);
  assert.equal((f.receipts.get('folder-1')?.detail as any).folderId,3);assert.deepEqual((f.receipts.get('folder-1')?.detail as any).beforeFolderIds,[]);
  assert.equal(f.transport.calls.some(r=>['joinChat','sendMessage'].includes(r['@type'])),false);await f.port.close();
});
test('native ACK with wrong complete state remains UNKNOWN; later exact readback reconciles with no repeat create',async()=>{
  const f=fixture();f.flags({readWrong:true});assert.equal((await f.port.dispatch(f.effect())).state,'unknown');f.flags({});assert.equal((await f.port.dispatch(f.effect())).state,'verified');assert.equal(f.transport.calls.filter(r=>r['@type']==='createChatFolder').length,1);await f.port.close();
});
test('lost create response survives restart and stays UNKNOWN despite matching name/state; never resend',async()=>{
  const f=fixture();f.flags({createTimeout:true});assert.equal((await f.port.dispatch(f.effect())).state,'unknown');
  const reopened=new TdlibTelegram({accountId:'42',transport:f.transport,receipts:f.store});assert.equal((await reopened.dispatch(f.effect())).state,'unknown');assert.equal((await reopened.readCapability('telegram.folders.list',{}) as any).folders[0].folderId,3);
  assert.equal(f.transport.calls.filter(r=>r['@type']==='createChatFolder').length,1);await reopened.close();
});
test('duplicate name, unknown folder snapshot, invalid name, duplicate peer, raw object or escaped owner prevents create',async()=>{
  for(const scenario of ['duplicate-name','snapshot','name','peers','raw','owner']){const f=fixture();let effect=f.effect();
    if(scenario==='duplicate-name')f.folders.set(2,newFolder({name:'Работа',peerIds:['-1']}));if(scenario==='snapshot')f.flags({snapshotMissing:true});
    if(scenario==='name')effect=f.effect(undefined,{name:'too long folder name',peerIds:['-1']});if(scenario==='peers')effect=f.effect(undefined,{name:'Work',peerIds:['-1','-1']});
    if(scenario==='raw')effect=f.effect(undefined,{name:'Work',peerIds:['-1'],resolvedFolder:{'@type':'chatFolder'}});if(scenario==='owner')effect={...effect,resource:'99'};
    await assert.rejects(f.port.dispatch(effect));assert.equal(f.transport.calls.some(r=>r['@type']==='createChatFolder'),false);await f.port.close();
  }
});
test('folder list returns sanitized snapshot or unavailable, never account-wide current-state contents',async()=>{
  const f=fixture();f.folders.set(2,newFolder({name:'Работа',peerIds:['-1']}));const result=await f.port.readCapability('telegram.folders.list',{}) as any;
  assert.deepEqual(result,{status:'observed',folders:[{folderId:2,name:'Работа',shareable:false}]});f.transport.emit('gap',{});f.flags({snapshotMissing:true});assert.equal((await f.port.readCapability('telegram.folders.list',{}) as any).status,'unavailable');await f.port.close();
});
test('versioned patch preserves filters, pins, icon, color and shareability; removals exclude filtered peers',async()=>{
  const f=fixture(),current={...newFolder({name:'Работа',peerIds:['-1','-2']}),pinned_chat_ids:['-3'],icon:{'@type':'chatFolderIcon',name:'Study'},color_id:2,is_shareable:true,include_channels:true,exclude_muted:true,excluded_chat_ids:['-4']};f.folders.set(2,current);
  const state=await f.port.readCapability('telegram.folder.get',{folderId:2}) as any;const effect=f.effect('telegram.folder.update',{folderId:2,expectedVersion:state.version,name:'Вакансии',addPeerIds:['-4'],removePeerIds:['-1']});
  assert.equal((await f.port.dispatch(effect)).state,'verified');const saved=f.folders.get(2)!;assert.deepEqual(saved.pinned_chat_ids,['-3']);assert.deepEqual(saved.included_chat_ids,['-2','-4']);assert.deepEqual(saved.excluded_chat_ids,['-1']);assert.equal(saved.icon.name,'Study');assert.equal(saved.color_id,2);assert.equal(saved.is_shareable,true);assert.equal(saved.include_channels,true);assert.equal(saved.exclude_muted,true);await f.port.close();
});
test('lost edit response uses exact persisted folder target and full desired state to reconcile, never re-edit',async()=>{
  const f=fixture(),current=newFolder({name:'Работа',peerIds:['-1']});f.folders.set(2,current);f.flags({editTimeout:true});const effect=f.effect('telegram.folder.update',{folderId:2,expectedVersion:folderVersion(current),addPeerIds:['-2']});
  assert.equal((await f.port.dispatch(effect)).state,'unknown');assert.equal((await f.port.reconcile(effect)).state,'verified');assert.equal((await f.port.dispatch(effect)).state,'verified');assert.equal(f.transport.calls.filter(r=>r['@type']==='editChatFolder').length,1);await f.port.close();
});
test('stale folder version and identity-invalid create result are contained',async()=>{
  const f=fixture();f.folders.set(2,newFolder({name:'Работа',peerIds:['-1']}));await assert.rejects(f.port.dispatch(f.effect('telegram.folder.update',{folderId:2,expectedVersion:'stale',addPeerIds:['-2']})),/changed/);assert.equal(f.transport.calls.some(r=>r['@type']==='editChatFolder'),false);
  f.folders.clear();f.flags({wrongResult:true});assert.equal((await f.port.dispatch(f.effect())).state,'unknown');assert.equal((f.receipts.get('folder-1')?.detail as any).folderId,undefined);await f.port.close();
});
test('native RPC failure is failed and payload drift is refused on recovery',async()=>{
  const f=fixture();f.transport.invoke=async request=>{if(request['@type']==='getMe')return{'@type':'user',id:'42'};if(request['@type']==='getCurrentState')return{'@type':'updates',updates:[{'@type':'updateChatFolders',chat_folders:[]}]};if(request['@type']==='getChat')return{'@type':'chat',id:request.chat_id,title:'Jobs',type:{'@type':'chatTypeBasicGroup',basic_group_id:'99'}};throw new TdRequestError('folder quota',false,400);};
  assert.equal((await f.port.dispatch(f.effect())).state,'failed');await assert.rejects(f.port.dispatch({...f.effect(),payloadHash:'different'}),/payload changed/);await f.port.close();
});
test('concurrent edits serialize and reject stale second version before replacing folder state',async()=>{
  const f=fixture(),current=newFolder({name:'Работа',peerIds:['-1']});f.folders.set(2,current);const first=f.effect('telegram.folder.update',{folderId:2,expectedVersion:folderVersion(current),addPeerIds:['-2']});const second={...f.effect('telegram.folder.update',{folderId:2,expectedVersion:folderVersion(current),addPeerIds:['-3']}),id:'folder-2'};
  const results=await Promise.allSettled([f.port.dispatch(first),f.port.dispatch(second)]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(f.transport.calls.filter(r=>r['@type']==='editChatFolder').length,1);assert.deepEqual(f.folders.get(2)?.included_chat_ids,['-1','-2']);await f.port.close();
});
test('real empty startup update before call survives getCurrentState omission and caller mutation',async()=>{
  const f=fixture();f.flags({snapshotMissing:true});f.transport.emit('update',{'@type':'updateChatFolders',chat_folders:[]});const first=await f.port.readCapability('telegram.folders.list',{}) as any;
  assert.deepEqual(first,{status:'observed',folders:[]});(first as TdObject).folders.push({folderId:9,name:'invented'});assert.deepEqual(await f.port.readCapability('telegram.folders.list',{}),{status:'observed',folders:[]});await f.port.close();
});
test('delayed real empty startup update resolves bounded readiness wait without repeated snapshot polling',async()=>{
  const f=fixture();f.flags({snapshotMissing:true});const pending=f.port.readCapability('telegram.folders.list',{});setTimeout(()=>f.transport.emit('update',{'@type':'updateChatFolders',chat_folders:[]}),5);
  assert.deepEqual(await pending,{status:'observed',folders:[]});assert.equal(f.transport.calls.filter(r=>r['@type']==='getCurrentState').length,1);await f.port.close();
});
test('real delayed nonempty folder update unblocks create preflight and preserves baseline IDs',async()=>{
  const f=fixture();f.flags({snapshotMissing:true});const pending=f.port.dispatch(f.effect());setTimeout(()=>f.transport.emit('update',{'@type':'updateChatFolders',chat_folders:[{id:7,name:{text:{text:'Other'}}}]}),5);
  assert.equal((await pending).state,'verified');assert.deepEqual((f.receipts.get('folder-1')?.detail as any).beforeFolderIds,[7]);await f.port.close();
});
test('snapshot missing after finite readiness wait remains unavailable and creation never dispatches',async()=>{
  const f=fixture();f.flags({snapshotMissing:true});assert.equal((await f.port.readCapability('telegram.folders.list',{}) as any).status,'unavailable');await assert.rejects(f.port.dispatch(f.effect()),/unavailable/);
  assert.equal(f.transport.calls.some(r=>r['@type']==='createChatFolder'),false);assert.equal(f.receipts.size,0);await f.port.close();
});
test('a newer live folder update wins over an older in-flight current-state snapshot',async()=>{
  const f=fixture(),original=f.transport.invoke.bind(f.transport);f.transport.invoke=async request=>{
    if(request['@type']!=='getCurrentState')return original(request);
    f.transport.emit('update',{'@type':'updateChatFolders',chat_folders:[]});return{'@type':'updates',updates:[{'@type':'updateChatFolders',chat_folders:[{id:7,name:{text:{text:'Stale'}}}]}]};
  };
  assert.deepEqual(await f.port.readCapability('telegram.folders.list',{}),{status:'observed',folders:[]});await f.port.close();
});
test('gap or fault clears previous empty cache and interrupts in-flight snapshot provenance',async()=>{
  for(const event of ['gap','fault']){const f=fixture();f.flags({snapshotMissing:true});f.transport.emit('update',{'@type':'updateChatFolders',chat_folders:[]});f.transport.emit(event,{});
    assert.equal((await f.port.readCapability('telegram.folders.list',{}) as any).status,'unavailable');
    const original=f.transport.invoke.bind(f.transport);f.transport.invoke=async request=>{if(request['@type']!=='getCurrentState')return original(request);f.transport.emit(event,{});return{'@type':'updates',updates:[{'@type':'updateChatFolders',chat_folders:[]}]};};
    assert.equal((await f.port.readCapability('telegram.folders.list',{}) as any).status,'unavailable');await f.port.close();
  }
});
test('close interrupts folder readiness immediately and a malformed real update is never an empty list',async()=>{
  const f=fixture();f.flags({snapshotMissing:true});let invoked!:()=>void;const initial=new Promise<void>(resolve=>{invoked=resolve;});const original=f.transport.invoke.bind(f.transport);f.transport.invoke=async request=>{const response=await original(request);if(request['@type']==='getCurrentState')invoked();return response;};
  const pending=f.port.readCapability('telegram.folders.list',{});await initial;await f.port.close();assert.equal((await pending as any).status,'unavailable');
  const malformed=fixture();malformed.flags({snapshotMissing:true});malformed.transport.emit('update',{'@type':'updateChatFolders',chat_folders:[{id:0}]});await assert.rejects(malformed.port.readCapability('telegram.folders.list',{}),/invalid/);await malformed.port.close();
});
