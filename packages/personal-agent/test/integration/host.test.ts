import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersonalHost } from '../../src/host.ts';
import { HermesEngine, HTTPScopedToolBridge, HERMES_SOURCE_PIN } from '../../src/hermes/index.ts';
import { TdlibTelegram, JsonProcessTransport, FileTelegramStore } from '../../src/telegram/index.ts';
import { createToolRegistry, createToolServer } from '../../src/capabilities/index.ts';
import { memoryTools } from '../../src/memory/tools.ts';
import { artifactTools } from '../../src/artifacts/tools.ts';
import type { PersonalConfig } from '../../src/config.ts';
import type { Observation } from '../../src/contracts.ts';

test('production host composes native HTTP engine, supervised Telegram process, scoped tools, private delivery and cold restart', async () => {
  const directory = await mkdtemp(join(tmpdir(),'neurobro-integration-'));
  const tokens = new Map<string,string>(); const runs = new Map<string,Record<string,unknown>>(); const requests: Record<string,unknown>[]=[];
  const server = createServer(async (request,response) => {
    let raw=''; for await(const part of request) raw+=part; const body=raw?JSON.parse(raw):{};
    let result: unknown = {};
    if(request.url==='/v1/capabilities') result={object:'hermes.api_server.capabilities',platform:'hermes-agent',features:{run_submission:true,runs_idempotency:{supported:true,durable:true,retention_seconds:86400},session_resources:true,run_stop:true,run_steer:true}};
    else if(request.url==='/ready') result={ok:true,hermesPin:HERMES_SOURCE_PIN,trustedIdentity:'native_handler_task_id',requiresUniqueAdmissionSession:true};
    else if(request.url==='/bindings') { tokens.set(body.session_id,body.tool_context); result={ok:true,session_id:body.session_id}; }
    else if(request.url==='/api/sessions'||request.url?.endsWith('/fork')) result={session:{id:body.id}};
    else if(request.url==='/v1/runs') { const id=`r${runs.size}`; requests.push(body); runs.set(id,{run_id:id,status:'running',session_id:body.session_id}); result={run_id:id,status:'started'}; }
    else if(request.url?.endsWith('/stop')) { const run=runs.get(request.url.split('/')[3]!)!;run.status='cancelled';result={...run,object:'hermes.run'}; }
    else result={...runs.get(request.url!.split('/')[3]!),object:'hermes.run',updated_at:Date.now()/1000};
    response.setHeader('Content-Type','application/json'); response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const config:PersonalConfig={schemaVersion:1,stateDirectory:directory,account:{id:'1',ownerId:'1',controlPeerId:'1'},encryptionKeyEnv:'NEUROBRO_STATE_KEY',hermes:{baseUrl,apiKeyEnv:'NEUROBRO_HERMES_API_KEY'},telegram:{command:process.execPath,args:[],databaseDirectory:join(directory,'td'),filesDirectory:join(directory,'files'),apiIdEnv:'NEUROBRO_TG_API_ID',apiHashEnv:'NEUROBRO_TG_API_HASH'}};
  const transport=new JsonProcessTransport({command:process.execPath,args:[fileURLToPath(new URL('./tdlib-fixture.mjs',import.meta.url))]});transport.start();
  const store=new FileTelegramStore(join(directory,'tg'),Buffer.alloc(32,7));
  const telegram=new TdlibTelegram({accountId:'1',transport,receipts:store,spool:store});
  const engineOptions={baseUrl,statePath:join(directory,'hermes.sqlite'),bridge:new HTTPScopedToolBridge({baseUrl,registrationKey:'host-registration-key-'.repeat(3)}),artifactRoot:join(directory,'artifacts','stages')};
  let engine=new HermesEngine(engineOptions);let host=new PersonalHost({config,encryptionKey:Buffer.alloc(32,7),telegram,engine});
  let tools:Awaited<ReturnType<typeof createToolServer>>|undefined;
  const now=new Date().toISOString();
  const observation:Observation={id:'command-1',kind:'message',ref:{accountId:'1',peerId:'-20',messageId:'101'},authorId:'1',outgoing:true,text:'/бро найди полезное',sentAt:now,observedAt:now,version:'v1'};
  try {
    await transport.invoke({'@type':'testPut',message:{'@type':'message',id:101,chat_id:-20,sender_id:{'@type':'messageSenderUser',user_id:1},is_outgoing:true,date:Math.floor(Date.now()/1000),content:{'@type':'messageText',text:{text:observation.text,entities:[]}}}});
    // Admission through normalized real transport input, rather than a synthetic account assertion.
    const normalized=await telegram.getMessage(observation.ref); assert.ok(normalized);
    const accepted=await host.ingest(normalized); assert.equal(accepted.disposition,'accepted');assert.equal(requests.length,1,JSON.stringify(host.agent.status()));
    const taskId=accepted.taskId!; const status=host.agent.status(taskId)!;assert.equal(status.state,'working');
    const acknowledgements=(await transport.invoke({'@type':'testStats'})).messages.filter((message:Record<string,unknown>)=>String(message.chat_id)==='1');
    assert.equal(acknowledgements.length,1);assert.match(acknowledgements[0].content.text.text,/Понял, бро/);assert.ok(!acknowledgements[0].content.text.text.includes(taskId));assert.ok(!acknowledgements[0].content.text.text.includes('проверенный ответ'));
    const token=tokens.get(status.run!.binding.sessionId!)!; assert.ok(token);
    assert.ok(!JSON.stringify(requests).includes(token));
    const registry=createToolRegistry({broker:host.agent,telegram,accountId:'1',artifacts:host.toolArtifacts(),extraTools:[...memoryTools({store:host.memory,resolveAccess:()=>({ownerId:'1',accountId:'1',scopes:['chat:-20']})}),...artifactTools({store:host.artifacts,resolveScope:context=>({ownerId:'1',taskId:context.taskId})})]});
    tools=await createToolServer(registry,{host:'127.0.0.1',port:0});
    const call=async(name:string,args:object)=>{
      const response=await fetch(`${tools!.address}/tools/call`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name,args})});return response.json() as Promise<{ok:boolean;value?:unknown;error?:string}>;
    };
    assert.equal((await call('telegram.history',{peerId:'-20'})).ok,true);
    assert.equal((await call('telegram.history',{peerId:'-999'})).ok,false);
    assert.equal((await call('telegram.send',{peerId:'-20',text:'injected public response'})).ok,false);
    assert.equal((await call('memory.search',{query:'полезное'})).ok,true);
    assert.equal((await call('artifacts.stage',{artifactIds:[]})).ok,true);
    runs.get(status.run!.binding.runId)!.status='completed';runs.get(status.run!.binding.runId)!.output='Готово: проверенный ответ.';
    await host.agent.poll();
    const sent=(await transport.invoke({'@type':'testStats'})).messages.filter((message:Record<string,unknown>)=>String(message.chat_id)==='1');
    assert.equal(sent.length,1);assert.equal(sent[0].id,acknowledgements[0].id);assert.match(sent[0].content.text.text,/проверенный ответ/);assert.ok(sent[0].content.text.text.startsWith('🤖 Нейробратик\n\n'));
    await tools.close();tools=undefined;await host.close();engine.close();
    tokens.clear(); engine=new HermesEngine(engineOptions);host=new PersonalHost({config,encryptionKey:Buffer.alloc(32,7),telegram,engine});
    await host.agent.start();await host.agent.poll();
    assert.equal((await host.ingest(normalized)).disposition,'duplicate');
    assert.equal(requests.length,1);
    const afterRestart=(await transport.invoke({'@type':'testStats'})).messages.filter((message:Record<string,unknown>)=>String(message.chat_id)==='1');assert.equal(afterRestart.length,1);assert.deepEqual(afterRestart.map((message:any)=>({id:message.id,text:message.content.text.text})),sent.map((message:any)=>({id:message.id,text:message.content.text.text})));
    assert.ok(tokens.has(status.run!.binding.sessionId!), 'restart restores plugin binding');
    const bytes=await readFile(join(directory,'broker.sqlite'));assert.ok(!bytes.includes(Buffer.from('найди полезное')));
  } catch(error) { process.stderr.write(String(error instanceof Error ? error.stack : error) + '\n'); throw error; } finally {
    await Promise.allSettled([tools?.close(),host.close(),telegram.close()]);engine.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    const resolved=join(tmpdir(),'neurobro-integration-');assert.ok(directory.startsWith(resolved));await rm(directory,{recursive:true,force:true});
  }
});
