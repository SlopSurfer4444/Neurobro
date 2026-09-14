// Real compiled service core + runtime + source-bound builder + guarded outbox.
// All Telegram/native-process/store ports are invented; no OS/model/auth calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const publicRoot=resolve(process.env.NEUROBRO_PUBLIC_SOURCE_ROOT??'project/verification');
const build=resolve(process.env.NEUROBRO_GATEWAY_BUILD??'packages/telegram-gateway/dist');
const loadPublic=name=>import(pathToFileURL(resolve(publicRoot,name)));
const loadGateway=name=>import(pathToFileURL(resolve(build,'src',name)));
const {prepareStandingEpochRuntime}=await loadPublic('rm-0032-standing-epoch-runtime.mjs');
const {SOURCE_NAMES,SOURCE_PINS}=await loadPublic('rm-0032-standing-epoch-host.mjs');
const {runStandingWithPorts}=await loadGateway('standing-service.js');
const {runPilotReply}=await loadGateway('pilot-outbox.js');
const {SELF_HISTORY_TOOL_SPEC}=await loadGateway('self-history-tool.js');
const {createEpochWire}=await loadGateway('standing-epoch-wire.js');
const {openStandingEpochSession}=await loadGateway('standing-epoch-session.js');
const {createGeneratedImageRegistry}=await loadGateway('generated-image-artifact.js');
const {runGeneratedImageDelivery}=await loadGateway('generated-image-outbox.js');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const sources=Object.fromEntries(Object.entries(SOURCE_NAMES).map(([key,name])=>[key,readFileSync(resolve(publicRoot,name),'utf8')]));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const tick=()=>new Promise(done=>setImmediate(done));
function record(epochId,unknown=false){return {schema:'standing-epoch-owner-v1',epochId,outcome:unknown?'unknown':'observed',
  bootstrapJoined:true,activeJoined:true,sessionClosed:true,epochObserved:!unknown,supervisorObserved:!unknown,processSettled:true,exitObserved:true,closeObserved:true,
  stderrEnded:true,stdoutEnded:true,wireCleanEof:true,streamError:false,childError:false,terminationDispatched:false,successfulEpoch:!unknown,resourcesSettled:true,replacementReady:true,
  exitCode:unknown?1:0,exitSignal:null,closeCode:unknown?1:0,closeSignal:null,stderrBytes:0};}
function fixture({holdSend=false,image=false}={}){
  const abort=new AbortController(),events=[],questions=[],outcomes=[],packets=[],owners=[],nativeRecords=[],outboxes=[],entered=deferred(),sendEnd=deferred();
  let cursor=0,selected=0,clients=0,spawns=0,journalReads=0,references,uploadBytes,imageValue;
  const history={spec:SELF_HISTORY_TOOL_SPEC,async call(args){events.push('history');return{success:true,contentItems:[{type:'inputText',text:JSON.stringify(args)}]};},close(){}};
  const runtime=prepareStandingEpochRuntime({sources,pins:SOURCE_PINS,attemptParent:resolve('synthetic-model-attempts'),workerToken:'a'.repeat(32),createWire:createEpochWire,openSession:openStandingEpochSession},{
    store:{reserve(path,intent){events.push('reserve-native');nativeRecords.push({path,intent});},controller(path,value){events.push('controller-native');nativeRecords.find(r=>r.path===path).controller=value;},
      async finish(path,value){events.push('persist-native');nativeRecords.find(r=>r.path===path).actual=value;}},
    spawn(){spawns++;events.push('spawn-native');return{pid:222};},
    async openOwner(input){
      assert.equal(input.bootstrap.readUInt32BE(0),input.bootstrap.length-68);
      assert.equal(input.bootstrap.subarray(4,68).toString(),createHash('sha256').update(input.bootstrap.subarray(68)).digest('hex'));
      input.spawnChild();const epoch=owners.length+1;let turns=0,pending=false,closed,final;
      const owner={
        admission:()=>closed||pending?'unavailable':turns>=2?'rotate':'ready',
        async turn(ref,text){
          turns++;pending=true;const packet=JSON.parse(text);packets.push({epoch,ref,packet});events.push('turn-'+packet.currentRequest.text);
          assert.ok(references.matches('-200','100'));assert.match(ref,/^[0-9a-f-]{36}$/u);
          assert.equal((await input.history.call({fromDate:1,toDate:200,cursor:null})).success,true);
          if(image){
            const origin={requestRef:ref,threadId:'thread-'+epoch,turnId:'turn-'+turns,itemId:'image-'+turns};
            const registry=createGeneratedImageRegistry({requestRef:ref,threadId:origin.threadId,turnId:origin.turnId});
            const artifact=registry.acceptCompleted(origin,{id:origin.itemId,type:'imageGeneration',status:'completed',result:PNG});
            imageValue={kind:'image',answer:'caption',image:{artifact,registry:{get:registry.get,copyBytes:registry.copyBytes},close(){events.push('close-image');registry.close();}}};
            return imageValue;
          }
          return{kind:'text',answer:'answer-'+packet.currentRequest.text};
        },
        async release(ref,delivery){const p=packets.find(p=>p.ref===ref);assert.ok(p);events.push('release-'+p.packet.currentRequest.text+'-'+delivery);pending=false;},
        close(){if(!final){closed=true;events.push('close-native-'+epoch);final=(async()=>{const value=record(input.epochId,pending);await input.recordFinal(value,1000);return{...value,persisted:true};})();}return final;},
      };owners.push(owner);return owner;
    },
  });
  const paths={authConfigPath:'fixture/auth',bindingPath:'fixture/binding',modelReceiptPath:'fixture/ready',attemptDirectory:'fixture/unused',killSwitchPath:'fixture/STOP'};
  const credentials={apiId:123,apiHash:'a'.repeat(32),passphrase:'invented-test-passphrase'};
  const input={paths,stateDirectory:'fixture/state',credentials,signal:abort.signal,enableImages:image,notify:code=>events.push(code),
    model:async()=>{throw Error('legacy model must not run');},modelState:()=>runtime.state(),
    openConversation(args){assert.equal(args.history,history);events.push('open-conversation');return runtime.openConnection(args);}};
  const ports={
    prepare:async()=>({paths,config:{account:{sessionFile:'fixture/session'}},binding:{accountId:'100',peerId:'-200'},ownerLock:'fixture/lock'}),
    acquireLock:async()=>async()=>{events.push('release-lock');},
    openSession:async()=>({material:{value:'invented-session'},release:async()=>{events.push('release-session');}}),
    state:async()=>({cursor:()=>cursor,checkpointCursor:async id=>{cursor=id;events.push('cursor-'+id);},newOutbox:()=>`fixture/outbox-${cursor}`}),
    journal:async()=>({
      async recordQuestion(question){questions.push(question);events.push('question-'+question.primary.messageId);return{key:String(question.primary.messageId).padStart(10,'0'),created:true};},
      async recordModelAdmission(value){events.push('admit-'+Number(value.key));return{created:true};},
      async recordOutcome(outcome){outcomes.push(outcome);events.push('outcome-'+Number(outcome.key)+'-'+outcome.delivery);},
      async read(){journalReads++;return{dialogues:questions.map(question=>{const key=String(question.primary.messageId).padStart(10,'0'),outcome=outcomes.find(v=>v.key===key)??null;return{key,question,recordedAt:1700000000000+question.primary.messageId,modelAdmission:null,outcome,status:outcome?.delivery??'pending'};}),scanned:questions.length,hasOlder:false};},
      close(){events.push('close-journal');},
    }),
    createClient:()=>{clients++;return{connect:async()=>{},getMe:async()=>({})};},installFence:()=>()=>{},
    adapter:async args=>{references=args.references;assert.equal(args.enableSelfHistory,true);return{
      selfHistory:history,
      async next(){
        if(selected>=3){abort.abort();throw Error('fixture complete');}
        const id=++selected,primary={chatId:'-200',ownerId:'300',messageId:id,text:'ПРОМПТ '+id};
        await args.checkpointQuestion(primary);await args.checkpointCursor(id);let sent;
        return{primary,cursor:id,imageTransport:{
          async sendOnce(value){uploadBytes=value.bytes;events.push('image-send');assert.equal(value.chatId,'-200');assert.equal(value.replyToMessageId,id);assert.equal(value.bytes.toString('base64'),PNG);
            entered.resolve();if(holdSend)await sendEnd.promise;events.push('image-send-end');return{messageId:1000+id,photoId:String(2000+id)};},
          async readExact(){events.push('image-read');return{chatId:'-200',messageId:1000+id,accountId:'100',replyToMessageId:id,photoId:String(2000+id),caption:'caption'};},
        },transport:{
          async sendOnce(reply){events.push('send-enter-'+id);assert.equal(reply.replyToMessageId,id);assert.equal(reply.chatId,'-200');sent=reply;
            if(holdSend&&id===1){entered.resolve();await sendEnd.promise;}
            events.push('send-end-'+id);return{messageId:100+id};},
          async readExact(chatId,messageId){events.push('read-'+id);assert.equal(messageId,100+id);return{messageId,chatId,accountId:'100',replyToMessageId:id,text:sent.text};},
        }};
      },close(){events.push('close-adapter');},
    };},
    settle:async()=>{events.push('settle-telegram');return true;},
    store:path=>{const rows=[];outboxes.push({path,rows});return{
      async reserve(value){assert.equal(rows.length,0);rows.push(value);events.push('outbox-'+value.replyToMessageId+'-'+value.state);},
      async append(value){rows.push(value);events.push('outbox-'+value.replyToMessageId+'-'+value.state);},
    };},
    dispatch:runPilotReply,killed:()=>false,wait:async()=>{events.push('backoff');},now:()=>1700000000000,
    imageStore:async()=>({reserve:async(_plan,bytes)=>{assert.equal(bytes.toString('base64'),PNG);events.push('image-reserve');},append:async r=>events.push('image-'+r.state),close(){events.push('image-store-close');}}),
    dispatchImage:runGeneratedImageDelivery,
  };
  return{run:()=>runStandingWithPorts(input,ports),events,packets,outcomes,nativeRecords,outboxes,entered,sendEnd,abort,runtime,
    counts:()=>({clients,spawns,journalReads}),references:()=>references,uploadBytes:()=>uploadBytes,imageValue:()=>imageValue};
}

test('real service + runtime: two same-epoch turns, then restored epoch; real guarded outbox before release',async()=>{
  const f=fixture(),result=await f.run();assert.equal(result.status,'stopped');assert.equal(result.verifiedReplies,3);assert.equal(result.lockPreserved,false);
  assert.deepEqual(f.counts(),{clients:1,spawns:2,journalReads:2});assert.deepEqual(f.packets.map(p=>p.epoch),[1,1,2]);
  assert.equal(f.packets[0].packet.contextState.restoration.pairs.length,0);assert.equal(f.packets[1].packet.contextState.restoration,undefined);
  assert.deepEqual(f.packets[2].packet.contextState.restoration.pairs.map(p=>p.answer.text),['answer-1','answer-2']);
  assert.equal(f.packets[0].packet.currentRequest.speaker,f.packets[2].packet.currentRequest.speaker);
  for(let id=1;id<=3;id++){
    const at=event=>f.events.indexOf(event);
    assert.ok(at('question-'+id)<at('cursor-'+id));assert.ok(at('admit-'+id)<at('turn-'+id));
    assert.ok(at('outbox-'+id+'-sending')<at('send-enter-'+id));
    assert.ok(at('read-'+id)<at('outbox-'+id+'-verified'));assert.ok(at('outbox-'+id+'-verified')<at('outcome-'+id+'-verified'));
    assert.ok(at('outcome-'+id+'-verified')<at('release-'+id+'-verified'));
  }
  assert.equal(f.events.filter(v=>v==='open-conversation').length,1);
  assert.ok(f.events.indexOf('persist-native')<f.events.lastIndexOf('spawn-native'));
  assert.ok(f.events.lastIndexOf('persist-native')<f.events.indexOf('close-adapter'));
  assert.equal(f.nativeRecords.every(r=>r.actual.resourcesSettled),true);assert.equal(JSON.stringify(f.nativeRecords).includes('answer-'),false);
  assert.throws(()=>f.references().message(1));
});

test('STOP may close native epoch, but actual text delivery and reference lifetime stay joined',async t=>{
  const f=fixture({holdSend:true});let finished=false;
  const running=f.run().then(value=>{finished=true;return value;});
  t.after(async()=>{f.abort.abort();f.sendEnd.resolve();await running;});
  await f.entered.promise;f.abort.abort();await tick();
  // Always release the invented I/O so a failing regression leaves no pending
  // service promise or timer behind.
  assert.equal(finished,false);assert.equal(f.events.includes('settle-telegram'),false);assert.equal(f.events.includes('close-adapter'),false);
  assert.equal(f.events.includes('close-journal'),false);assert.equal(f.outcomes.length,0);assert.ok(f.references().matches('-200','100'));
  assert.equal(f.counts().spawns,1);f.sendEnd.resolve();const result=await running;
  assert.equal(result.status,'stopped');assert.equal(result.verifiedReplies,0);assert.deepEqual(f.outcomes.map(v=>v.delivery),['unknown']);
  assert.ok(f.events.indexOf('send-end-1')<f.events.indexOf('outcome-1-unknown'));assert.ok(f.events.indexOf('outcome-1-unknown')<f.events.indexOf('close-adapter'));
  assert.equal(f.nativeRecords[0].actual.outcome,'unknown');assert.equal(f.nativeRecords[0].actual.successfulEpoch,false);
  assert.deepEqual(f.counts(),{clients:1,spawns:1,journalReads:1});assert.equal(f.events.includes('read-1'),false);assert.throws(()=>f.references().message(1));
});

test('STOP during image upload preserves caller bytes after native close until actual media settlement',async t=>{
  const f=fixture({holdSend:true,image:true});let finished=false;
  const running=f.run().then(value=>{finished=true;return value;});
  t.after(async()=>{f.abort.abort();f.sendEnd.resolve();await running;});
  await f.entered.promise;f.abort.abort();await tick();
  assert.equal(finished,false);assert.equal(f.uploadBytes().toString('base64'),PNG);
  assert.equal(f.imageValue().image.registry.get(f.imageValue().image.artifact.ref).sha256,f.imageValue().image.artifact.sha256);
  assert.equal(f.events.includes('image-store-close'),false);assert.equal(f.events.includes('close-image'),false);assert.equal(f.events.includes('settle-telegram'),false);
  assert.ok(f.references().matches('-200','100'));assert.equal(f.counts().spawns,1);
  f.sendEnd.resolve();const result=await running;
  assert.equal(result.status,'stopped');assert.equal(result.verifiedReplies,0);assert.deepEqual(f.outcomes.map(v=>v.delivery),['unknown']);
  assert.ok(f.uploadBytes().every(byte=>byte===0));assert.throws(()=>f.imageValue().image.registry.get(f.imageValue().image.artifact.ref));
  assert.ok(f.events.indexOf('image-send-end')<f.events.indexOf('image-store-close'));
  assert.ok(f.events.indexOf('image-store-close')<f.events.indexOf('outcome-1-unknown'));assert.ok(f.events.indexOf('outcome-1-unknown')<f.events.indexOf('close-image'));
  assert.ok(f.events.indexOf('close-image')<f.events.indexOf('settle-telegram'));assert.equal(f.events.includes('image-read'),false);
  assert.equal(f.nativeRecords[0].actual.outcome,'unknown');assert.deepEqual(f.counts(),{clients:1,spawns:1,journalReads:1});
});
