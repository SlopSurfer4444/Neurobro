import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeObservations } from '../../src/ingress.ts';
import type { Observation, TelegramPort } from '../../src/contracts.ts';
const observation = (id:string,text:string):Observation=>({id,kind:'message',ref:{accountId:'a',peerId:'p',messageId:id},outgoing:true,text,sentAt:new Date().toISOString(),observedAt:new Date().toISOString()});
test('a stop/status command passes a slow admission without dropping queued durable events',async()=>{
  const events=[observation('1','/бро долгая задача'),observation('2','/бро вторая задача'),observation('3','/бро статус')];
  const port={async *observations(){yield*events;}} as unknown as TelegramPort;
  const completed:string[]=[];let release!:()=>void;
  const blocker=new Promise<void>(resolve=>release=resolve);
  await consumeObservations(port,new AbortController().signal,async event=>{
    if(event.id==='1')await blocker;
    if(event.id==='3'){assert.deepEqual(completed,[]);release();}
    completed.push(event.id);
  },{concurrency:1});
  assert.deepEqual(completed,['3','1','2']);
});
test('an intake failure aborts an idle stream and waits for already started handlers',async()=>{
  let drained=false;
  const port={async *observations(signal:AbortSignal){yield observation('1','bad');await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});drained=true;}} as unknown as TelegramPort;
  await assert.rejects(consumeObservations(port,new AbortController().signal,async()=>{throw new Error('store-corruption');}),/store-corruption/);
  assert.equal(drained,true);
});
