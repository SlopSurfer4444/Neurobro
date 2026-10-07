import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {JsonProcessTransport,TdRequestError,safeTdErrorReason,type TdJsonTransport,type TdObject} from '../../src/telegram/transport.ts';
import {resolveControlPeer,onboardingStage,OnboardingStageError,OnboardingClosureError} from '../../src/onboarding.ts';
import {commandFailure} from '../../src/cli.ts';

test('native reasons accept only complete whitelisted symbols and normalize flood waits without secrets',()=>{
  for(const [raw,expected]of [['USERNAME_NOT_OCCUPIED','USERNAME_NOT_OCCUPIED'],['USERNAME_INVALID','USERNAME_INVALID'],['Username is invalid','USERNAME_INVALID'],['User not found','USER_NOT_FOUND'],['FLOOD_WAIT_123','FLOOD_WAIT'],['Too Many Requests: retry after 42','FLOOD_WAIT']] as const)assert.equal(safeTdErrorReason(raw),expected);
  for(const raw of ['USERNAME_INVALID secret-code','USERNAME_NOT_OCCUPIED: +70000000000','failure: FLOOD_WAIT_30 password','constructor','USERNAME_INVALID\nphone','Too Many Requests: retry after secret',{},'a'.repeat(200)])assert.equal(safeTdErrorReason(raw),undefined);
  const error=new TdRequestError('TDLib rejected request',true,400,'unrecognized secret-password +70000000000');assert.equal(error.reason,undefined);assert.doesNotMatch(JSON.stringify(error),/secret-password|70000000000/);assert.doesNotMatch(error.stack!,/secret-password/);
});
test('real JSON process bridge retains safe reason and code without retaining native message',async(t)=>{
  const fixture=`import readline from 'node:readline';const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');emit({'@type':'neurobroSidecarStatus',state:'ready',client_id:1});readline.createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);if(v['@type']==='close'){emit({'@type':'updateAuthorizationState',authorization_state:{'@type':'authorizationStateClosed'}});process.exit(0);}else emit({'@type':'error','@extra':v['@extra'],code:v.fixtureCode??400,message:v.fixtureMessage});});`;
  const transport=new JsonProcessTransport({command:process.execPath,args:['--input-type=module','--eval',fixture],closeTimeoutMs:2000});t.after(()=>transport.close().catch(()=>{}));transport.start();await transport.waitReady();
  for(const [raw,expected]of [['USERNAME_NOT_OCCUPIED','USERNAME_NOT_OCCUPIED'],['FLOOD_WAIT_17','FLOOD_WAIT'],['private password: secret-123',undefined]] as const){
    await assert.rejects(transport.invoke({'@type':'fixtureError',fixtureMessage:raw}),error=>{assert.ok(error instanceof TdRequestError);assert.equal(error.reason,expected);assert.equal(error.code,400);assert.equal(error.message,'TDLib rejected request');assert.equal(error.dispatched,true);assert.doesNotMatch(JSON.stringify(error),/secret-123|private password/);return true;});
  }
  await transport.close();
});
class Control extends EventEmitter implements TdJsonTransport{
  failAt='searchPublicChat';nativeMessage='USERNAME_NOT_OCCUPIED';calls:TdObject[]=[];
  async invoke(v:TdObject):Promise<TdObject>{this.calls.push(v);if(v['@type']===this.failAt)throw new TdRequestError('TDLib rejected request',true,400,this.nativeMessage);if(v['@type']==='getUser')return{'@type':'user',id:'77',type:{'@type':'userTypeBot'},usernames:{active_usernames:['ExampleControl_bot']}};return{'@type':'chat',id:'77',type:{'@type':'chatTypePrivate',user_id:'77'}};}
  async close(){}
}
test('control lookup failures identify their exact read stage without selecting alternate spellings',async()=>{
  for(const [method,stage]of [['searchPublicChat','control-username-lookup'],['getChat','control-chat-read'],['getUser','control-bot-read']]){
    const transport=new Control();transport.failAt=method!;
    await assert.rejects(resolveControlPeer(transport,'@ExampleControl_bot'),error=>{assert.ok(error instanceof OnboardingStageError);assert.equal(error.stage,stage);assert.equal(error.telegramReason,'USERNAME_NOT_OCCUPIED');const result=commandFailure(error);assert.equal(result.telegramReason,'USERNAME_NOT_OCCUPIED');assert.equal(result.stage,stage);assert.match(String(result.detail),/exact username was not found/);return true;});
    assert.equal(transport.calls[0]?.username,'ExampleControl_bot');assert.equal(transport.calls.filter(v=>v['@type']==='searchPublicChat').length,1);assert.equal(transport.calls.some(v=>['sendMessage','setAuthenticationPhoneNumber','logOut'].includes(v['@type'])),false);
  }
});
test('auth diagnostics suppress submitted secrets and unknown provider messages even with local-looking prefixes',async()=>{
  await assert.rejects(onboardingStage('submit-password',async()=>{throw new TdRequestError('TDLib rejected request',true,400,'PASSWORD_HASH_INVALID');}),error=>{assert.ok(error instanceof OnboardingStageError);const result=commandFailure(error);assert.equal(result.stage,'submit-password');assert.equal(result.telegramReason,'PASSWORD_HASH_INVALID');assert.match(String(result.detail),/two-factor/);return true;});
  await assert.rejects(onboardingStage('submit-code',async()=>{throw new Error('Enrollment secret-login-code');}),error=>{assert.ok(error instanceof OnboardingStageError);assert.equal(error.telegramReason,undefined);assert.doesNotMatch(JSON.stringify(commandFailure(error)),/secret-login-code/);assert.doesNotMatch(JSON.stringify(error),/secret-login-code/);return true;});
  for(const message of ['Enrollment secret-login-code','Control peer password secret-password','Telegram login required (secret-code); run login --config explicitly'])assert.doesNotMatch(JSON.stringify(commandFailure(new Error(message))),/secret-login-code|secret-password|secret-code/);
  const closure=new OnboardingClosureError([new Error('secret-close-password')],'secret-close-password');assert.doesNotMatch(JSON.stringify(commandFailure(closure)),/secret-close-password/);assert.equal(commandFailure(closure).outcome,'unknown');
});
