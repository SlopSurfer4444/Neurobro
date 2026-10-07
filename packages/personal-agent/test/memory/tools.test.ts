import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentMemoryStore } from '../../src/memory/index.ts';
import { memoryTools, type AdmittedPreference } from '../../src/memory/tools.ts';
import { ToolRegistry } from '../../src/capabilities/registry.ts';
import type { ToolContext } from '../../src/contracts.ts';
const context:ToolContext={taskId:'t',intentRevision:1,grantId:'g',grantRevision:1,runId:'r'};
test('real registry validates retrieval and preference admission without model approval booleans',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'neurobro-memory-tools-'));const store=new PersistentMemoryStore({databasePath:join(dir,'db.sqlite'),blobDirectory:join(dir,'blobs'),encryptionKey:Buffer.alloc(32,9)});
 try{
  const a=store.ingestSource({ownerId:'owner',accountId:'account',scope:'chat:private',sourceId:'1',version:'1',eventAt:new Date().toISOString(),text:'Please always keep reports detailed.',attribution:'owner_explicit'});
  store.ingestSource({ownerId:'owner',accountId:'account',scope:'chat:other',sourceId:'2',version:'1',eventAt:new Date().toISOString(),text:'private-secret-other-scope'});
  let admission:AdmittedPreference|undefined;
  const registry=new ToolRegistry({resolveToolContext(token){if(token!=='issued')throw new Error('unknown token');return context;},authorizeTool(_token,_capability,resource){assert.equal(resource,'t');},async executeEffect(){throw new Error('No external effects');}},memoryTools({store,resolveAccess:()=>({ownerId:'owner',accountId:'account',scopes:['chat:private','global']}),admitPreference:async()=>admission}));
  assert.equal((await registry.invoke('forged',{name:'memory.preferences',args:{}})).ok,false);
  const other=await registry.invoke('issued',{name:'memory.search',args:{query:'private-secret-other-scope'}});assert.equal(other.ok,true);assert.deepEqual((other.value as {hits:unknown[]}).hits,[]);
  const slice=await registry.invoke('issued',{name:'memory.source_read',args:{ref:a.ref,maxChars:6}});assert.equal(slice.ok,true);assert.deepEqual((slice.value as {span:unknown}).span,{start:0,end:6,total:a.text.length,more:true,unit:'UTF-16 code units'});
  const args={key:'style',scope:'global',text:'Detailed reports',sourceRef:a.ref,expectedRevision:0};
  assert.equal((await registry.invoke('issued',{name:'memory.preference_propose',args:{...args,explicitOwner:true}})).ok,false);
  const proposal=await registry.invoke('issued',{name:'memory.preference_propose',args});assert.equal((proposal.value as {canonicalChanged:boolean}).canonicalChanged,false);assert.equal(store.preferences({ownerId:'owner',scopes:['global']}).length,0);
  admission={...args,ownerId:'owner',explicitOwner:true,enduring:true};
  const accepted=await registry.invoke('issued',{name:'memory.preference_propose',args});assert.equal(accepted.ok,true);assert.equal((accepted.value as {canonicalChanged:boolean}).canonicalChanged,true);
  assert.equal(store.preferences({ownerId:'owner',scopes:['global']})[0]?.text,'Detailed reports');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
