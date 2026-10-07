import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../src/capabilities/catalog.ts';
import type { CapabilityTelegram,ToolBroker } from '../../src/capabilities/types.ts';
import type { Effect,ToolContext } from '../../src/contracts.ts';
const context:ToolContext={taskId:'t',intentRevision:1,grantId:'g',grantRevision:1,runId:'r'};
test('folder tools require owner account plus every changed peer before broker mutation; narrowed payload is model accessible',async()=>{
  const calls:string[]=[],effects:any[]=[];let allowed=new Set(['42','-1']);const broker:ToolBroker={resolveToolContext:()=>context,authorizeTool:async(_token,capability,resource)=>{calls.push(capability+':'+resource);if(!allowed.has(resource))throw new Error('grant denied');},executeEffect:async(_token,request)=>{effects.push(request);return{...request,id:'e',state:'unknown'} as Effect;}};
  const telegram:CapabilityTelegram={async *observations(){},readHistory:async()=>[],getMessage:async()=>undefined,download:async()=>{},dispatch:async()=>({state:'unknown'}),reconcile:async()=>({state:'unknown'}),close:async()=>{},readCapability:async(name,args)=>({name,args})};const registry=createToolRegistry({accountId:'42',broker,telegram});
  assert.equal((await registry.invoke('token',{name:'telegram.folder.create',args:{name:'Работа',peerIds:['-1','-2']}})).ok,false);assert.equal(effects.length,0);
  allowed.add('-2');assert.equal((await registry.invoke('token',{name:'telegram.folder.create',args:{name:'Работа',peerIds:['-1','-2']}})).ok,true);assert.deepEqual(effects[0],{capability:'telegram.folder.create',resource:'42',payload:{name:'Работа',peerIds:['-1','-2']}});
  assert.ok(calls.includes('telegram.folder.create:-2'));assert.equal((await registry.invoke('token',{name:'telegram.folder.create',args:{name:'Work',peerIds:['-1'],resolvedFolder:{}}})).ok,false);
  assert.equal((await registry.invoke('token',{name:'telegram.folder.update',args:{folderId:2,expectedVersion:'v',removePeerIds:['-3']}})).ok,false);assert.equal(effects.length,1);
  assert.equal((await registry.invoke('token',{name:'telegram.folders.list',args:{}})).ok,true);assert.equal((await registry.invoke('token',{name:'telegram.folder.get',args:{folderId:2}})).ok,true);
  assert.equal((await registry.invoke('token',{name:'telegram.peer.inspect',args:{peerId:'-3'}})).ok,false);assert.equal((await registry.invoke('token',{name:'telegram.channels.related',args:{peerId:'-1',limit:1}})).ok,true);
  for(const name of ['telegram.folders.list','telegram.folder.get','telegram.folder.create','telegram.folder.update','telegram.peer.inspect','telegram.channels.related'])assert.ok(registry.list().some(tool=>tool.name===name));
});
