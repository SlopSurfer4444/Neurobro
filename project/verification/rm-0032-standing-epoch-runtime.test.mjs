import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,readdirSync,lstatSync,unlinkSync,rmdirSync,renameSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {SOURCE_NAMES,SOURCE_PINS} from './rm-0032-standing-epoch-host.mjs';
import {prepareStandingEpochRuntime} from './rm-0032-standing-epoch-runtime.mjs';
const root=resolve(process.env.NEUROBRO_PUBLIC_SOURCE_ROOT??'project/verification');
const sources=Object.fromEntries(Object.entries(SOURCE_NAMES).map(([key,name])=>[key,readFileSync(resolve(root,name),'utf8')]));
const pins={...SOURCE_PINS};
const tick=()=>new Promise(done=>setImmediate(done));
class SyntheticNotAdmitted extends Error {}
function receipt(epochId,unknown=false){return {schema:'standing-epoch-owner-v1',epochId,outcome:unknown?'unknown':'observed',
  bootstrapJoined:true,activeJoined:true,sessionClosed:true,epochObserved:!unknown,supervisorObserved:!unknown,processSettled:true,exitObserved:true,closeObserved:true,
  stderrEnded:true,stdoutEnded:true,wireCleanEof:true,streamError:false,childError:false,terminationDispatched:false,successfulEpoch:!unknown,resourcesSettled:true,replacementReady:true,
  exitCode:unknown?1:0,exitSignal:null,closeCode:unknown?1:0,closeSignal:null,stderrBytes:0};}
function setup(options={}){
  const events=[],actors=[],records=[],spawns=[],control=new AbortController();let calls=0;
  const store={
    reserve(path,intent){events.push('reserve');if(options.reserveFail)throw Error('private reserve');records.push({path,intent});},
    controller(path,value){events.push('controller');assert.ok(records.some(r=>r.path===path));if(options.controllerFail)throw Error('private controller');records.find(r=>r.path===path).controller=value;},
    async finish(path,value){events.push('finish');if(options.holdFinish)await options.holdFinish;if(options.finishFail)throw Error('private storage');records.find(r=>r.path===path).actual=value;},
  };
  const spawn=(file,argv,opts)=>{events.push('spawn');spawns.push({file,argv,opts});return{pid:1234};};
  const openOwner=async input=>{
    events.push('open');const child=input.spawnChild();assert.equal(child.pid,1234);
    let admission='ready',closePromise;
    const actor={
      input,child,turns:[],releases:[],closes:0,
      admission:()=>admission,
      rotate:()=>{admission='rotate';},
      async turn(ref,text){events.push('turn');this.turns.push({ref,text});admission='unavailable';
        if(options.pendingTurn)await options.pendingTurn;
        if(options.turnFail)throw options.turnFail===true?Error('synthetic turn unknown'):options.turnFail;
        return options.imageResult??{kind:'text',answer:'private synthetic answer'};},
      async release(ref,delivery){events.push('release');this.releases.push({ref,delivery});admission=delivery==='unknown'?'unavailable':options.epochLimit&&this.turns.length>=options.epochLimit?'rotate':'ready';},
      close(){
        if(!closePromise)closePromise=(async()=>{
          events.push('close');this.closes++;admission='unavailable';
          if(options.holdClose)await options.holdClose;
          const r=receipt(input.epochId,options.unknown===true);
          if(options.unsettled)r.resourcesSettled=false,r.replacementReady=false,r.successfulEpoch=false,r.outcome='unknown';
          await input.recordFinal(r,1000);return{...r,persisted:true};
        })();return closePromise;
      },
    };
    actors.push(actor);await tick();return actor;
  };
  const input={sources:{...sources},pins:{...pins},attemptParent:options.parent??resolve('synthetic-attempt-parent'),workerToken:'a'.repeat(32),createWire:()=>{},openSession:()=>{},
    ...(options.isTurnNotAdmitted?{isTurnNotAdmitted:options.isTurnNotAdmitted}:{})};
  const ports={spawn,openOwner,...(options.realStore?{}:{store})};
  const runtime=prepareStandingEpochRuntime(input,ports);
  const history={call:async()=>{calls++;return{};}};
  return {runtime,input,ports,store,events,actors,records,spawns,control,history,historyCalls:()=>calls,
    connect:extraTools=>runtime.openConnection({history,signal:control.signal,...(extraTools===undefined?{}:{extraTools})})};
}
test('lazy start, same owner across released turns, fixed spawn and no private persistence',async()=>{
  const f=setup(),c=f.connect();assert.equal(f.spawns.length,0);assert.throws(()=>f.connect());
  assert.deepEqual(await c.prepare(),{restoration:true});assert.deepEqual(f.events.slice(0,4),['reserve','open','spawn','controller']);
  assert.equal(Object.hasOwn(f.actors[0].input,'extraTools'),false);
  const a=await c.turn('one','private question');assert.equal(a.answer,'private synthetic answer');
  await assert.rejects(c.prepare(),/RELEASE_REQUIRED/);await c.release('one','verified');
  assert.deepEqual(await c.prepare(),{restoration:false});await c.turn('two','second private');await c.release('two','not-sent');
  const final=await c.close();assert.deepEqual(final,{resourcesSettled:true,persisted:true});assert.equal(f.spawns.length,1);
  assert.equal(f.runtime.state().blocked,false);assert.equal(f.runtime.state().connectionOpen,false);
  assert.equal(JSON.stringify(f.records).includes('private'),false);
  const s=f.spawns[0];assert.equal(s.file,'C:/Program Files/WSL/wsl.exe');assert.equal(s.opts.windowsHide,true);
  assert.deepEqual(s.opts.stdio,['pipe','pipe','pipe']);assert.equal(s.argv.at(-1),'decadans-standing-token='+f.records[0].intent.token);
  assert.deepEqual(s.argv.slice(0,10),['--distribution','DecadansNeurobro','--user','root','--exec','/usr/bin/python3.12','-I','-S','-B','-c']);
  assert.equal(f.records[0].controller.workerToken,'a'.repeat(32));assert.equal(f.records[0].controller.pid,1234);
});
test('rotation waits old durable settlement; a fresh epoch requires restoration',async()=>{
  let release;const held=new Promise(done=>{release=done;});const f=setup({holdClose:held}),c=f.connect();
  await c.prepare();f.actors[0].rotate();const rotating=c.prepare();await tick();assert.equal(f.spawns.length,1);
  release();assert.deepEqual(await rotating,{restoration:true});assert.equal(f.spawns.length,2);
  assert.notEqual(f.records[0].intent.token,f.records[1].intent.token);
  assert.ok(f.events.indexOf('finish')<f.events.lastIndexOf('spawn'));await c.close();
});
test('six released turns rotate before the seventh; stable handlers and no early or repeated turn',async()=>{
  let finish;const held=new Promise(done=>{finish=done;}),f=setup({holdFinish:held});
  const call=async()=>({success:true,contentItems:[]}),c=f.connect([{name:'neurobro_group_info',call}]);
  await assert.rejects(c.turn('first','before prepare'),/PREPARE_REQUIRED/);assert.equal(f.spawns.length,0);
  for(let i=0;i<6;i++){
    assert.deepEqual(await c.prepare(),{restoration:i===0});
    await c.turn('turn-'+i,'public fixture');
    if(i===5){await assert.rejects(c.prepare(),/RELEASE_REQUIRED/);assert.equal(f.actors[0].closes,0);}
    await c.release('turn-'+i,i%2?'not-sent':'verified');
    if(i===0){await assert.rejects(c.turn('turn-0','duplicate'),/REQUEST/);assert.equal(f.actors[0].turns.length,1);}
  }
  assert.equal(f.actors[0].admission(),'ready');assert.equal(f.records[0].intent.turnLimit,16);
  assert.deepEqual(await c.turn('seventh','without prepare'),{kind:'not-admitted',reason:'prepare'});
  assert.equal(f.actors[0].turns.length,6);
  const preparing=c.prepare();await tick();assert.equal(f.spawns.length,1);assert.equal(f.records[0].actual,undefined);
  await assert.rejects(c.turn('seventh','during prepare'),/STATE/);
  finish();assert.deepEqual(await preparing,{restoration:true});assert.equal(f.spawns.length,2);
  assert.ok(f.records[0].actual.resourcesSettled);assert.ok(f.events.indexOf('finish')<f.events.lastIndexOf('spawn'));
  assert.equal(f.actors[1].input.history,f.actors[0].input.history);
  assert.equal(f.actors[1].input.extraTools,f.actors[0].input.extraTools);
  await c.turn('seventh','public fixture');await c.release('seventh','verified');
  await assert.rejects(c.turn('seventh','duplicate'),/REQUEST/);
  assert.deepEqual(f.actors.flatMap(a=>a.turns.map(t=>t.ref)),['turn-0','turn-1','turn-2','turn-3','turn-4','turn-5','seventh']);
  await c.close();
});
test('soft rotation refuses a successor on STOP or uncertain settlement',async()=>{
  for(const mode of ['stop','unsettled','persistence']){
    let finish;const held=new Promise(done=>{finish=done;});
    const f=setup({holdFinish:held,unsettled:mode==='unsettled',finishFail:mode==='persistence'}),c=f.connect();
    for(let i=0;i<6;i++){await c.prepare();await c.turn('turn-'+i,'public fixture');await c.release('turn-'+i,'verified');}
    const preparing=c.prepare(),rejected=assert.rejects(preparing);await tick();assert.equal(f.spawns.length,1);
    if(mode==='stop')f.control.abort();finish();await rejected;await c.close();
    assert.equal(f.spawns.length,1);assert.equal(f.records.length,1);
    assert.equal(f.runtime.state().blocked,mode!=='stop');
  }
});
test('one connection exceeds 4096 requests through bounded settled native epochs', {timeout:20000},async()=>{
  const f=setup({epochLimit:16}),c=f.connect();let fresh=0;
  for(let i=0;i<4097;i++){
    if((await c.prepare()).restoration)fresh++;
    await c.turn('unique-'+i,'public fixture');await c.release('unique-'+i,'verified');
  }
  assert.equal(fresh,683);assert.equal(f.spawns.length,683);assert.ok(f.actors.every(a=>a.turns.length<=6));
  assert.equal(f.runtime.state().blocked,false);assert.equal((await c.close()).persisted,true);
  assert.ok(f.records.every(r=>r.actual?.resourcesSettled===true));
});
test('unknown consumed turn can settle, but is never replayed into replacement',async()=>{
  const f=setup({unknown:true,turnFail:true}),c=f.connect();await c.prepare();await assert.rejects(c.turn('old','private'));
  assert.equal(c.state().failedTurn,true);assert.equal(c.state().pendingRelease,true);
  await assert.rejects(c.prepare(),/RELEASE_REQUIRED/);
  await c.close();assert.equal(f.runtime.state().blocked,false);
  const next=f.connect();assert.equal(next.state().failedTurn,false);await next.prepare();assert.equal(f.actors[0].turns.length,1);assert.equal(f.actors[1].turns.length,0);await next.close();
});
test('STOP during rotation prevents successor, and asynchronous final persistence must join',async()=>{
  let finish;const wait=new Promise(done=>{finish=done;});const f=setup({holdFinish:wait}),c=f.connect();
  await c.prepare();f.actors[0].rotate();const rotating=c.prepare(),refused=assert.rejects(rotating);
  await tick();assert.equal(f.spawns.length,1);assert.equal(f.records[0].actual,undefined);
  const closing=c.close();finish();await refused;await closing;
  assert.equal(f.spawns.length,1);assert.equal(f.runtime.state().blocked,false);assert.ok(f.records[0].actual);
});
test('controller write failure keeps exact child owned and closes before reporting blocked',async()=>{
  const f=setup({controllerFail:true}),c=f.connect();await assert.rejects(c.prepare(),/CONTROLLER_UNKNOWN/);
  assert.equal(f.actors.length,1);assert.equal(f.actors[0].child.pid,1234);assert.equal(f.actors[0].closes,1);
  assert.equal(f.actors[0].input.signal.aborted,true);assert.ok(f.records[0].actual);
  assert.equal(f.runtime.state().blocked,true);await c.close();assert.throws(()=>f.connect());
});
test('reserve, persistence and incomplete settlement failures never authorize another owner',async()=>{
  for(const options of [{reserveFail:true},{finishFail:true},{unsettled:true}]){
    const f=setup(options),c=f.connect();
    if(options.reserveFail){await assert.rejects(c.prepare());assert.equal(f.spawns.length,0);}else await c.prepare();
    await c.close();assert.equal(f.runtime.state().blocked,true);assert.throws(()=>f.connect());
  }
});
test('close before queued prepare prevents all reserve/spawn; idle close permits next connection',async()=>{
  const f=setup(),c=f.connect(),preparing=c.prepare();const rejection=assert.rejects(preparing);await c.close();await rejection;
  assert.equal(f.events.length,0);assert.equal(f.runtime.state().connectionOpen,false);
  const next=f.connect();assert.deepEqual(await next.close(),{resourcesSettled:true,persisted:true});assert.equal(f.events.length,0);
});
test('captured source, callbacks and original history survive input mutation',async()=>{
  const f=setup(),c=f.connect();const wrong=()=>{throw Error('replaced port');};
  f.input.sources.bridge='bad';f.input.pins.bridge='0'.repeat(64);f.input.workerToken='b'.repeat(32);
  f.ports.spawn=wrong;f.ports.openOwner=wrong;f.store.finish=wrong;f.history.call=wrong;
  await c.prepare();await f.actors[0].input.history.call({});assert.equal(f.historyCalls(),1);
  await c.close();assert.equal(f.records[0].controller.workerToken,'a'.repeat(32));
});
test('extra tool registry is snapshotted at connection admission and forwarded with its exact call',async()=>{
  const calls=[];let expectedReceiver;
  const call=async function(args,scope){calls.push({receiver:this,args,scope});return{success:true,contentItems:[{type:'inputText',text:'{}'}]};};
  const entry=Object.assign(Object.create(null),{name:'neurobro_group_info',call}),registry=[entry],f=setup(),c=f.connect(registry);
  entry.name='neurobro_changed';entry.call=()=>{throw Error('mutated');};registry[0]={name:'neurobro_other',call:entry.call};registry.push({name:'neurobro_late',call});
  await c.prepare();const captured=f.actors[0].input.extraTools;expectedReceiver=captured[0];
  assert.ok(Object.isFrozen(captured));assert.ok(Object.isFrozen(expectedReceiver));assert.equal(captured.length,1);
  assert.equal(expectedReceiver.name,'neurobro_group_info');assert.equal(expectedReceiver.call,call);
  const scope=Object.freeze({requestRef:'request-1',callRef:'call-1',signal:new AbortController().signal});
  const result=await Reflect.apply(expectedReceiver.call,expectedReceiver,[{group:true},scope]);
  assert.deepEqual(result,{success:true,contentItems:[{type:'inputText',text:'{}'}]});
  assert.deepEqual(calls,[{receiver:expectedReceiver,args:{group:true},scope}]);await c.close();
});
test('malformed, accessor and proxy extra-tool registries fail before reserve or spawn',()=>{
  let accessorReads=0,proxyTraps=0;
  const accessor=[];Object.defineProperty(accessor,'0',{enumerable:true,get(){accessorReads++;return{name:'neurobro_group_info',call:async()=>{}};}});
  const proxyArray=new Proxy([],{ownKeys(){proxyTraps++;throw Error('trap');}});
  const proxyEntry=new Proxy({name:'neurobro_group_info',call:async()=>{}},{getPrototypeOf(){proxyTraps++;throw Error('trap');}});
  const proxyCall=new Proxy(async()=>{},{apply(){proxyTraps++;throw Error('trap');}});
  const valid=()=>({name:'neurobro_group_info',call:async()=>{}});
  const extraKey=[valid()];extraKey.private=true;
  const malformed=[{},new Array(1),accessor,proxyArray,[proxyEntry],[{name:'neurobro_group_info',call:proxyCall}],extraKey,
    [{name:'neurobro_read_history',call:async()=>{}}],[valid(),valid()]];
  for(const registry of malformed){const f=setup();assert.throws(()=>f.connect(registry),error=>error.code==='CONFIG');
    assert.equal(f.runtime.state().connectionOpen,false);assert.deepEqual(f.events,[]);assert.deepEqual(f.spawns,[]);}
  for(const topLevel of [Object.defineProperty({history:{call:async()=>{}},signal:new AbortController().signal},'extraTools',{get(){accessorReads++;return[];}}),
    new Proxy({history:{call:async()=>{}},signal:new AbortController().signal},{getOwnPropertyDescriptor(){proxyTraps++;throw Error('trap');}})]){
    const f=setup();assert.throws(()=>f.runtime.openConnection(topLevel),error=>error.code==='CONFIG');
    assert.equal(f.runtime.state().connectionOpen,false);assert.deepEqual(f.events,[]);assert.deepEqual(f.spawns,[]);
  }
  assert.equal(accessorReads,0);assert.equal(proxyTraps,0);
});
test('image ownership is forwarded unchanged, no release before exact matching request',async()=>{
  const imageResult={kind:'image',answer:'caption',image:{privateFixture:true}};
  const f=setup({imageResult}),c=f.connect();await c.prepare();assert.equal(await c.turn('image','question'),imageResult);
  await assert.rejects(c.release('different','verified'));await c.release('image','verified');
  await assert.rejects(c.turn('image','replay'));assert.equal(f.actors[0].turns.length,1);await c.close();
});
function cleanup(parent){
  // Only this test's freshly created, flat public fixture tree; no links.
  for(const entry of readdirSync(parent)){const dir=resolve(parent,entry);assert.equal(lstatSync(dir).isDirectory(),true);
    for(const name of readdirSync(dir))unlinkSync(resolve(dir,name));rmdirSync(dir);}
  rmdirSync(parent);
}

test('time changed after prepare yields unconsumed selection and refreshes only after settlement',async()=>{
  const f=setup(),c=f.connect();await c.prepare();f.actors[0].rotate();
  assert.deepEqual(await c.turn('same-question','payload'),{kind:'not-admitted',reason:'prepare'});
  assert.equal(f.actors[0].turns.length,0);assert.equal(c.state().pendingRelease,false);
  await c.prepare();await c.turn('same-question','restored payload');await c.release('same-question','verified');
  assert.equal(f.actors[0].closes,1);assert.equal(f.actors[1].turns.length,1);await c.close();
});

test('only branded pre-admission proof permits settled successor; failed persistence and untyped errors do not',async()=>{
  for(const mode of ['proof','untyped','settlement-failed']){
    const options={turnFail:mode==='untyped'?Object.assign(Error('SESSION_LIMIT'),{reason:'time'}):new SyntheticNotAdmitted(),
      isTurnNotAdmitted:value=>value instanceof SyntheticNotAdmitted,finishFail:mode==='settlement-failed'};
    const f=setup(options),c=f.connect();await c.prepare();
    if(mode==='proof'){
      assert.deepEqual(await c.turn('selected','payload'),{kind:'not-admitted',reason:'limit'});
      assert.equal(c.state().pendingRelease,false);assert.ok(f.records[0].actual.resourcesSettled);
      options.turnFail=false;await c.prepare();await c.turn('selected','restored payload');await c.release('selected','verified');
      assert.equal(f.actors.length,2);assert.equal(f.actors[0].closes,1);
    }else{await assert.rejects(c.turn('selected','payload'));assert.equal(f.actors.length,1);}
    await c.close();
  }
});
test('real exclusive files contain metadata, and changed attempt directory identity refuses final write',async()=>{
  for(const tamper of [false,true]){
    const parent=mkdtempSync(resolve(tmpdir(),'neurobro-epoch-store-'));
    try{
      const f=setup({parent,realStore:true}),c=f.connect();await c.prepare();
      const token=readdirSync(parent)[0],dir=resolve(parent,token);
      assert.deepEqual(readdirSync(dir).sort(),['controller.json','intent.json']);
      if(tamper){renameSync(dir,resolve(parent,'preserved'));mkdirSync(dir);}
      const result=await c.close();
      if(tamper){assert.equal(result.persisted,false);assert.equal(f.runtime.state().blocked,true);assert.equal(readdirSync(dir).length,0);}
      else {
        assert.equal(result.persisted,true);const before=readFileSync(resolve(dir,'actual.json'),'utf8'),data=JSON.parse(before);
        assert.equal(data.schema,'standing-epoch-owner-v1');assert.equal(data.epochId,token);assert.equal(JSON.stringify(data).includes('private'),false);
        // Completed directory authority was retired, not merely hidden by the
        // exclusive file: a stale writer fails DIRECTORY before another open.
        await assert.rejects(f.actors[0].input.recordFinal(data,1000),error=>error.code==='DIRECTORY');
        const next=f.connect();await next.prepare();assert.equal((await next.close()).persisted,true);
        assert.equal(readdirSync(parent).length,2);assert.equal(readFileSync(resolve(dir,'actual.json'),'utf8'),before);
      }
    }finally{cleanup(parent);}
  }
});
