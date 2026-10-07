import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareIsolatedProfile} from '../../tools/ops/profile.ts';
import {parseConfig,type PersonalConfig} from '../../src/config.ts';
import {collectApiCredentials,enrollAccount,bindControlPeer,resolveControlPeer,OnboardingClosureError,OnboardingStageError,type EnrollmentPrompts,type EnrollmentTransport,type EnrollmentIdentity,type ControlPeerIdentity} from '../../src/onboarding.ts';
import {type TdObject,TdRequestError} from '../../src/telegram/index.ts';

const credentials={apiId:12345,apiHash:'1a'.repeat(16)},key=Buffer.alloc(32,8);
async function setup(bound=false){
  const directory=await mkdtemp(join(tmpdir(),'nb-enroll-')),state=join(directory,'state'),profile=await prepareIsolatedProfile(state);
  const raw={schemaVersion:1,stateDirectory:state,account:{id:bound?'42':'0',ownerId:bound?'42':'0',controlPeerId:'0',label:'retain-me'},encryptionKeyEnv:'NB_TEST_KEY',hermes:{baseUrl:'http://127.0.0.1:8642',apiKeyEnv:'NB_TEST_ENGINE'},telegram:{command:'unlaunched-fixture',args:[],databaseDirectory:profile.telegramDatabase,filesDirectory:profile.telegramFiles,apiIdEnv:'NB_TEST_API_ID',apiHashEnv:'NB_TEST_API_HASH'},customMetadata:{preserve:true}};
  const path=join(directory,'config.json');await writeFile(path,JSON.stringify(raw,null,2)+'\n');
  return{path,config:parseConfig(raw),raw,state};
}
class Session extends EventEmitter implements EnrollmentTransport{
  calls:TdObject[]=[];started=false;closed=false;failClose=false;beforeClose?:()=>Promise<void>;step=0;
  states=['authorizationStateReady'];userId='42';botUsername='ExampleControl_bot';botType='userTypeBot';chatType='chatTypePrivate';
  start(){this.started=true;this.emit('update',{'@type':'updateNewMessage',message:{chat_id:'-100foreign',id:1,content:'unadmitted foreign data'}});}
  async waitReady(){}
  async invoke(v:TdObject):Promise<TdObject>{this.calls.push(v);switch(v['@type']){
    case 'getAuthorizationState':return{'@type':this.states[Math.min(this.step,this.states.length-1)]};
    case 'getMe':return{'@type':'user',id:this.userId,first_name:'Owner',last_name:'Fixture',phone_number:'70000000000',usernames:{active_usernames:['fixture_owner']},type:{'@type':'userTypeRegular'}};
    case 'searchPublicChat':return{'@type':'chat',id:'100',type:{'@type':this.chatType,user_id:'100'}};
    case 'getChat':return{'@type':'chat',id:'100',type:{'@type':this.chatType,user_id:'100'}};
    case 'getUser':return{'@type':'user',id:'100',first_name:'Control',last_name:'',usernames:{active_usernames:[this.botUsername]},type:{'@type':this.botType}};
    default:this.step++;return{'@type':'ok'};
  }}
  async close(){await this.beforeClose?.();if(this.failClose)throw new Error('fixture close unknown');this.closed=true;}
}
function prompts(confirmation=true):EnrollmentPrompts&{seen:EnrollmentIdentity[];controls:ControlPeerIdentity[];secrets:string[]}{
  return{seen:[],controls:[],secrets:[],async ask(){return'+70000000000';},async askSecret(question){this.secrets.push(question);return'fixture-secret';},async confirmIdentity(identity){this.seen.push(identity);return confirmation;},async confirmControl(identity){this.controls.push(identity);return confirmation;}};
}
test('enrollment authenticates without prebound owner, confirms exact getMe and commits only after close',async()=>{
  const fixture=await setup(),transport=new Session(),p=prompts();transport.states=['authorizationStateWaitTdlibParameters','authorizationStateWaitPhoneNumber','authorizationStateWaitCode','authorizationStateWaitPassword','authorizationStateWaitEmailAddress','authorizationStateWaitEmailCode','authorizationStateReady'];
  const before=await readFile(fixture.path);transport.beforeClose=async()=>assert.deepEqual(await readFile(fixture.path),before);
  const result=await enrollAccount({configPath:fixture.path,config:fixture.config,key,credentials,prompts:p,transport});
  assert.equal(result.enrolled,true);assert.equal(transport.closed,true);assert.equal(p.seen[0]?.accountId,'42');
  const raw=JSON.parse(await readFile(fixture.path,'utf8'));assert.deepEqual(raw.account,{id:'42',ownerId:'42',controlPeerId:'0',label:'retain-me'});assert.deepEqual(raw.customMetadata,{preserve:true});
  assert.equal(await readFile(join(fixture.state,'STOP'),'utf8'),'Prepared offline. Explicit onboarding and readiness are required.\n');
  assert.deepEqual((await readdir(join(fixture.state,'telegram'))).sort(),['database','files']);
  assert.equal(transport.listenerCount('update'),0,'auth gateway never admits observation updates');
  const parameters=transport.calls.find(v=>v['@type']==='setTdlibParameters')!;assert.equal(parameters.use_message_database,false);assert.equal(parameters.use_chat_info_database,false);assert.equal(parameters.use_file_database,false);
  assert.doesNotMatch(await readFile(fixture.path,'utf8'),/fixture-secret|1a1a1a1a/);
  assert.equal(transport.calls.some(v=>['sendMessage','createPrivateChat','joinChat'].includes(v['@type'])),false);
});
test('declined identity leaves every binding and STOP unchanged and closes authorized transport',async()=>{
  const fixture=await setup(),before=await readFile(fixture.path),transport=new Session();assert.deepEqual(await enrollAccount({configPath:fixture.path,config:fixture.config,key,credentials,prompts:prompts(false),transport}),{enrolled:false});assert.deepEqual(await readFile(fixture.path),before);assert.equal(transport.closed,true);
});
test('closure uncertainty never commits confirmed owner and persists reconciliation block',async()=>{
  const fixture=await setup(),before=await readFile(fixture.path),transport=new Session();transport.failClose=true;await assert.rejects(enrollAccount({configPath:fixture.path,config:fixture.config,key,credentials,prompts:prompts(),transport}),/closure requires reconciliation/);assert.deepEqual(await readFile(fixture.path),before);assert.equal(JSON.parse(await readFile(join(fixture.state,'.neurobro-reconciliation-required.json'),'utf8')).reason,'enrollment_transport_closure_unknown');
});
test('failed reconciliation marker write still returns typed unknown closure and never applies binding',async()=>{
  const fixture=await setup(),before=await readFile(fixture.path),transport=new Session();transport.failClose=true;
  await mkdir(join(fixture.state,'.neurobro-reconciliation-required.json'));
  await assert.rejects(enrollAccount({configPath:fixture.path,config:fixture.config,key,credentials,prompts:prompts(),transport}),error=>error instanceof OnboardingClosureError&&error.errors.length===2);
  assert.deepEqual(await readFile(fixture.path),before);
});
test('concurrent configuration edit prevents binding and is preserved after native close',async()=>{
  const fixture=await setup(),transport=new Session(),p=prompts();p.confirmIdentity=async()=>{await writeFile(fixture.path,JSON.stringify({...fixture.raw,customMetadata:{preserve:'edited'}}));return true;};await assert.rejects(enrollAccount({configPath:fixture.path,config:fixture.config,key,credentials,prompts:p,transport}),/configuration changed/);assert.equal(transport.closed,true);assert.deepEqual(JSON.parse(await readFile(fixture.path,'utf8')).customMetadata,{preserve:'edited'});assert.equal(JSON.parse(await readFile(fixture.path,'utf8')).account.id,'0');
});
test('already enrolled account and invalid identities cannot be silently replaced',async()=>{
  const fixture=await setup(true),transport=new Session();await assert.rejects(enrollAccount({configPath:fixture.path,config:fixture.config,key,credentials,prompts:prompts(),transport}),/new unbound profile/);assert.equal(transport.started,false);
  const fresh=await setup(),bad=new Session();bad.userId='9007199254740992';await assert.rejects(enrollAccount({configPath:fresh.path,config:fresh.config,key,credentials,prompts:prompts(),transport:bad}),/valid Telegram user ID/);assert.equal(bad.closed,true);assert.equal(JSON.parse(await readFile(fresh.path,'utf8')).account.id,'0');
});
test('API credentials use memory-only masked prompts when absent and supplied environment values without prompts',async()=>{
  const{config}=await setup();const questions:string[]=[];const p={async askSecret(q:string){questions.push(q);return q.includes('hash')?credentials.apiHash:String(credentials.apiId);}};
  const env:NodeJS.ProcessEnv={};assert.deepEqual(await collectApiCredentials(config,p,env),credentials);assert.equal(questions.length,2);assert.deepEqual(env,{});
  questions.length=0;assert.deepEqual(await collectApiCredentials(config,p,{NB_TEST_API_ID:'12345',NB_TEST_API_HASH:credentials.apiHash}),credentials);assert.equal(questions.length,0);
  await assert.rejects(collectApiCredentials(config,p,{NB_TEST_API_ID:'999999999999',NB_TEST_API_HASH:credentials.apiHash}),/positive int32/);
});
test('fresh literal username resolution requires private chat, exact user ID, active username and live user type',async()=>{
  const transport=new Session();const result=await resolveControlPeer(transport,'@ExampleControl_bot');assert.equal(result.username,'ExampleControl_bot');assert.equal(result.peerId,'100');assert.deepEqual(transport.calls.map(v=>v['@type']),['searchPublicChat','getChat','getUser']);assert.equal(transport.calls[0]?.username,'ExampleControl_bot');
  transport.botUsername='ExampleControlBot';await assert.rejects(resolveControlPeer(transport,'ExampleControl_bot'),/exact fresh identity/);
  transport.botUsername='ExampleControl_bot';transport.botType='userTypeRegular';assert.equal((await resolveControlPeer(transport,'ExampleControl_bot')).isBot,false);
  for(const type of ['userTypeDeleted','userTypeUnknown']){transport.botType=type;await assert.rejects(resolveControlPeer(transport,'ExampleControl_bot'),/accessible private Telegram user or bot/);}
  transport.botType='userTypeBot';transport.chatType='chatTypeSupergroup';await assert.rejects(resolveControlPeer(transport,'ExampleControl_bot'),/private conversation/);
});
test('control route binds only after separate local confirmation and known closure',async()=>{
  const fixture=await setup(true),transport=new Session(),p=prompts(),before=await readFile(fixture.path);transport.beforeClose=async()=>assert.deepEqual(await readFile(fixture.path),before);
  assert.deepEqual(await bindControlPeer({configPath:fixture.path,config:fixture.config,key,credentials,prompts:p,username:'ExampleControl_bot',transport}),{bound:true,controlPeerId:'100',username:'ExampleControl_bot'});assert.equal(p.seen.length,0);assert.equal(p.controls[0]?.userId,'100');const raw=JSON.parse(await readFile(fixture.path,'utf8'));assert.deepEqual(raw.account,{id:'42',ownerId:'42',controlPeerId:'100',label:'retain-me'});
});
test('control route cannot bind on declined confirmation, wrong owner, stale/deleted username or failed close',async()=>{
  for(const scenario of ['decline','wrong-owner','deleted','close'] as const){const fixture=await setup(true),transport=new Session(),before=await readFile(fixture.path),p=prompts(scenario!=='decline');if(scenario==='wrong-owner')transport.userId='43';if(scenario==='deleted')transport.invoke=async(v)=>{if(v['@type']==='getMe')return{'@type':'user',id:'42',type:{'@type':'userTypeRegular'}};if(v['@type']==='getAuthorizationState')return{'@type':'authorizationStateReady'};throw new TdRequestError('not found',true,404);};if(scenario==='close')transport.failClose=true;
    const operation=bindControlPeer({configPath:fixture.path,config:fixture.config,key,credentials,prompts:p,username:'ExampleControl_bot',transport});if(scenario==='decline')assert.deepEqual(await operation,{bound:false});else await assert.rejects(operation);assert.deepEqual(await readFile(fixture.path),before);
  }
});
test('failed exact lookup preserves enrolled session and configuration and emits safe actionable native reason',async()=>{
  const fixture=await setup(true),transport=new Session(),before=await readFile(fixture.path),p=prompts();
  const originalInvoke=transport.invoke.bind(transport);transport.invoke=async request=>{if(request['@type']==='searchPublicChat'){transport.calls.push(request);throw new TdRequestError('TDLib rejected request',true,400,'USERNAME_NOT_OCCUPIED');}return originalInvoke(request);};
  await assert.rejects(bindControlPeer({configPath:fixture.path,config:fixture.config,key,credentials,prompts:p,username:'ExampleControl_bot',transport}),error=>error instanceof OnboardingStageError&&error.stage==='control-username-lookup'&&error.telegramReason==='USERNAME_NOT_OCCUPIED');
  assert.deepEqual(await readFile(fixture.path),before);assert.equal(transport.closed,true);assert.equal(p.controls.length,0);assert.equal(p.secrets.length,0);assert.equal(transport.calls.filter(request=>request['@type']==='searchPublicChat').length,1);assert.equal(transport.calls.some(request=>['logOut','destroy','setAuthenticationPhoneNumber','checkAuthenticationCode'].includes(request['@type'])),false);
});
test('explicit regular-user control binding replaces existing route only after fresh identity confirmation and close',async()=>{
  const fixture=await setup(true),transport=new Session(),p=prompts();fixture.raw.account.controlPeerId='200';await writeFile(fixture.path,JSON.stringify(fixture.raw,null,2)+'\n');fixture.config=parseConfig(fixture.raw);
  const before=await readFile(fixture.path);transport.botType='userTypeRegular';transport.botUsername='Rawwwry';transport.beforeClose=async()=>assert.deepEqual(await readFile(fixture.path),before);
  const result=await bindControlPeer({configPath:fixture.path,config:fixture.config,key,credentials,prompts:p,username:'@Rawwwry',transport});
  assert.deepEqual(result,{bound:true,controlPeerId:'100',username:'Rawwwry'});assert.equal(p.controls[0]?.isBot,false);assert.equal(p.controls[0]?.username,'Rawwwry');assert.equal(transport.calls.find(request=>request['@type']==='searchPublicChat')?.username,'Rawwwry');assert.equal(transport.closed,true);
  const raw=JSON.parse(await readFile(fixture.path,'utf8'));assert.deepEqual(raw.account,{id:'42',ownerId:'42',controlPeerId:'100',label:'retain-me'});assert.deepEqual(raw.customMetadata,{preserve:true});assert.equal(await readFile(join(fixture.state,'STOP'),'utf8'),'Prepared offline. Explicit onboarding and readiness are required.\n');assert.equal(p.secrets.length,0);assert.equal(transport.calls.some(request=>['sendMessage','createPrivateChat','logOut','destroy'].includes(request['@type'])),false);
});
test('regular-user control binding rejects inaccessible identities and preserves Saved Messages as storage',async()=>{
  for(const scenario of ['inaccessible','self'] as const){
    const fixture=await setup(true),transport=new Session(),before=await readFile(fixture.path),p=prompts();transport.botType='userTypeRegular';transport.botUsername='Rawwwry';
    const originalInvoke=transport.invoke.bind(transport);transport.invoke=async request=>{
      const result=await originalInvoke(request);
      if(request['@type']==='getUser'){if(scenario==='inaccessible')result.have_access=false;else result.id='42';}
      if(scenario==='self'&&['searchPublicChat','getChat'].includes(request['@type'])){result.id='42';result.type.user_id='42';}
      return result;
    };
    await assert.rejects(bindControlPeer({configPath:fixture.path,config:fixture.config,key,credentials,prompts:p,username:'Rawwwry',transport}),scenario==='self'?/Saved Messages are reserved for storage/:/accessible private Telegram user or bot/);
    assert.deepEqual(await readFile(fixture.path),before);assert.equal(p.controls.length,0);assert.equal(transport.closed,true);
  }
});
