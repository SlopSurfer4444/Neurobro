import { open, readFile, rename, unlink, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hkdfSync, randomUUID, createHash } from 'node:crypto';
import type { PersonalConfig } from './config.ts';
import { parseConfig } from './config.ts';
import { JsonProcessTransport, TdRequestError, validateTdObject, type TdErrorReason, type TdObject, type TdJsonTransport } from './telegram/index.ts';
import { readProfile } from '../tools/ops/profile.ts';
import { noLinks } from '../tools/ops/paths.ts';

export interface EnrollmentIdentity { accountId:string; firstName:string; lastName:string; username?:string; phoneNumber?:string }
export interface ControlPeerIdentity { peerId:string;userId:string;username:string;firstName:string;lastName:string;isBot:boolean }
export interface EnrollmentPrompts {
  ask(question:string):Promise<string>;
  askSecret(question:string):Promise<string>;
  /** Trusted local confirmation, never an incoming Telegram message. */
  confirmIdentity(identity:EnrollmentIdentity):Promise<boolean>;
  confirmControl?(identity:ControlPeerIdentity):Promise<boolean>;
}
export interface ApiCredentials { apiId:number; apiHash:string }
export interface EnrollmentTransport extends TdJsonTransport { start():void; waitReady(timeoutMs?:number,signal?:AbortSignal):Promise<void> }
export class OnboardingClosureError extends AggregateError {
  constructor(errors:unknown[],message:string){super(errors,message);this.name='OnboardingClosureError';}
}
export type OnboardingStage='sidecar-start'|'authorization-state'|'configure-parameters'|'submit-phone'|'submit-code'|'submit-password'|'submit-email'|'submit-email-code'|'account-identity'|'control-username-lookup'|'control-chat-read'|'control-bot-read';
const STAGE_DETAIL:Record<OnboardingStage,string>={
  'sidecar-start':'Enrollment sidecar startup failed', 'authorization-state':'Enrollment authorization status read failed',
  'configure-parameters':'Enrollment isolated TDLib configuration failed', 'submit-phone':'Enrollment phone authentication failed',
  'submit-code':'Enrollment login code authentication failed', 'submit-password':'Enrollment two-factor authentication failed',
  'submit-email':'Enrollment email authentication failed', 'submit-email-code':'Enrollment email code authentication failed',
  'account-identity':'Enrollment primary account identity read failed', 'control-username-lookup':'Control peer exact username lookup failed',
  'control-chat-read':'Control peer chat verification read failed', 'control-bot-read':'Control peer identity read failed',
};
/** No original native error, request, cause, phone or secret is retained by this public diagnostic. */
export class OnboardingStageError extends Error {
  readonly stage:OnboardingStage;readonly telegramReason?:TdErrorReason;readonly telegramCode?:number;readonly outcome:'rejected'|'unknown';
  constructor(stage:OnboardingStage,error:unknown){
    super(STAGE_DETAIL[stage]);this.name='OnboardingStageError';this.stage=stage;
    if(error instanceof TdRequestError){this.telegramReason=error.reason;this.telegramCode=error.code;}
    this.outcome=error instanceof TdRequestError&&(!error.dispatched||error.code!==undefined)?'rejected':'unknown';
  }
}
export async function onboardingStage<T>(stage:OnboardingStage,operation:()=>Promise<T>):Promise<T>{
  try{return await operation();}catch(error){if(error instanceof OnboardingStageError)throw error;throw new OnboardingStageError(stage,error);}
}
const AUTH_METHOD_STAGE:Readonly<Record<string,OnboardingStage>>={getAuthorizationState:'authorization-state',setTdlibParameters:'configure-parameters',setAuthenticationPhoneNumber:'submit-phone',checkAuthenticationCode:'submit-code',checkAuthenticationPassword:'submit-password',setAuthenticationEmailAddress:'submit-email',checkAuthenticationEmailCode:'submit-email-code',getMe:'account-identity'};
async function closureUnknown(stateDirectory:string,reason:string,errors:unknown[],message:string):Promise<never>{
  try{await writeFile(join(stateDirectory,'.neurobro-reconciliation-required.json'),JSON.stringify({schemaVersion:1,reason,at:new Date().toISOString()})+'\n',{mode:0o600});}
  catch(error){errors.push(error);} // Even an unavailable disk must not cause CLI custody to be released.
  throw new OnboardingClosureError(errors,message);
}

function accountId(value:unknown):string {
  const result=typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='string'?value:'';
  if(!/^[1-9]\d*$/.test(result)||BigInt(result)>9007199254740991n)throw new Error('Enrollment identity is not a valid Telegram user ID');
  return result;
}
/** A bound account is never silently replaced through enrollment. */
export function requireUnenrolled(config:PersonalConfig):void {
  if(config.account.id!=='0'||config.account.ownerId!=='0')throw new Error('Enrollment requires a new unbound profile; use login for an already bound account');
}
export async function collectApiCredentials(config:PersonalConfig,prompts:Pick<EnrollmentPrompts,'askSecret'>,env:NodeJS.ProcessEnv=process.env):Promise<ApiCredentials>{
  const id=env[config.telegram.apiIdEnv]??await prompts.askSecret(`Telegram API ID (${config.telegram.apiIdEnv}): `);
  const hash=env[config.telegram.apiHashEnv]??await prompts.askSecret(`Telegram API hash (${config.telegram.apiHashEnv}): `);
  if(!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id))||Number(id)>2147483647)throw new Error('Telegram API ID must be a positive int32');
  if(!/^[a-fA-F0-9]{32}$/.test(hash))throw new Error('Telegram API hash must contain 32 hexadecimal characters');
  return{apiId:Number(id),apiHash:hash}; // Values stay in this call's memory; no global env/config mutation.
}
function environment():NodeJS.ProcessEnv { const result:NodeJS.ProcessEnv={};for(const name of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','LANG','LC_ALL'])if(process.env[name])result[name]=process.env[name];return result; }
function identityFromUser(user:TdObject):EnrollmentIdentity {
  if(user['@type']!=='user'||user.type?.['@type']!=='userTypeRegular')throw new Error('Enrollment requires a primary Telegram user account');
  return{accountId:accountId(user.id),firstName:typeof user.first_name==='string'?user.first_name:'',lastName:typeof user.last_name==='string'?user.last_name:'',...(typeof user.usernames?.active_usernames?.[0]==='string'?{username:user.usernames.active_usernames[0]}:{}),...(typeof user.phone_number==='string'?{phoneNumber:user.phone_number}:{})};
}
async function authenticate(transport:EnrollmentTransport,config:PersonalConfig,key:Uint8Array,credentials:ApiCredentials,prompts:EnrollmentPrompts):Promise<EnrollmentIdentity>{
  const invoke=(request:TdObject)=>{validateTdObject(request);return onboardingStage(AUTH_METHOD_STAGE[request['@type']]??'authorization-state',()=>transport.invoke(request));};
  for(let steps=0;steps<32;steps++){
    const state=await invoke({'@type':'getAuthorizationState'});
    switch(state['@type']){
      case 'authorizationStateWaitTdlibParameters':
        await invoke({'@type':'setTdlibParameters',use_test_dc:false,database_directory:config.telegram.databaseDirectory,files_directory:config.telegram.filesDirectory,database_encryption_key:Buffer.from(hkdfSync('sha256',key,'','neurobro-tdlib-v1',32)).toString('base64'),
          // Authorization storage is needed; chat/file/message caches are not admitted before owner binding.
          use_file_database:false,use_chat_info_database:false,use_message_database:false,use_secret_chats:false,api_id:credentials.apiId,api_hash:credentials.apiHash,system_language_code:'ru',device_model:'Neurobro Personal',system_version:process.platform,application_version:'0.1.0'});break;
      case 'authorizationStateWaitPhoneNumber':await invoke({'@type':'setAuthenticationPhoneNumber',phone_number:await prompts.ask('Telegram phone: '),settings:null});break;
      case 'authorizationStateWaitCode':await invoke({'@type':'checkAuthenticationCode',code:await prompts.askSecret('Telegram login code: ')});break;
      case 'authorizationStateWaitPassword':await invoke({'@type':'checkAuthenticationPassword',password:await prompts.askSecret('Telegram 2FA password: ')});break;
      case 'authorizationStateWaitEmailAddress':await invoke({'@type':'setAuthenticationEmailAddress',email_address:await prompts.ask('Telegram email: ')});break;
      case 'authorizationStateWaitEmailCode':await invoke({'@type':'checkAuthenticationEmailCode',code:{'@type':'emailAddressAuthenticationCode',code:await prompts.askSecret('Email login code: ')}});break;
      case 'authorizationStateReady':return identityFromUser(await invoke({'@type':'getMe'}));
      default:throw new Error('Enrollment encountered an unsupported interactive authorization state');
    }
  }
  throw new Error('Enrollment authorization did not settle within the bounded interactive flow');
}
/** Atomic replacement, with an exact original-document precondition and writer guard. */
async function replaceBinding(configPath:string,expected:Buffer,transform:(config:PersonalConfig,raw:any)=>void):Promise<PersonalConfig>{
  const path=resolve(configPath);await noLinks(path);const info=await lstat(path);if(!info.isFile()||info.nlink!==1)throw new Error('Enrollment configuration must be an ordinary exclusive file');
  const guardPath=join(dirname(path),`.${path.split(/[\\/]/).at(-1)}.enrollment-lock`),temporary=join(dirname(path),`.enrollment-${randomUUID()}.json`);
  const guard=await open(guardPath,'wx',0o600);let temporaryExists=false;
  try{
    const current=await readFile(path);if(!current.equals(expected))throw new Error('Enrollment configuration changed; re-read before binding');
    const raw=JSON.parse(current.toString('utf8'));const old=parseConfig(raw);transform(old,raw);
    const next=parseConfig(raw);const file=await open(temporary,'wx',0o600);temporaryExists=true;
    try{await file.writeFile(JSON.stringify(raw,null,2)+'\n');await file.sync();}finally{await file.close();}
    const fresh=await readFile(path);if(!fresh.equals(expected))throw new Error('Enrollment configuration changed; binding was not applied');
    await rename(temporary,path);temporaryExists=false;return next;
  }finally{if(temporaryExists)await unlink(temporary);await guard.close();await unlink(guardPath);}
}
export interface EnrollmentResult { enrolled:boolean; accountId?:string; ownerId?:string; controlPeerId?:string; configurationSha256?:string }
/** Auth-only flow: no TelegramPort, effect receipts, observation spool, broker or service. */
export async function enrollAccount(options:{configPath:string;config:PersonalConfig;key:Uint8Array;credentials:ApiCredentials;prompts:EnrollmentPrompts;transport?:EnrollmentTransport}):Promise<EnrollmentResult>{
  requireUnenrolled(options.config);const original=await readFile(resolve(options.configPath));const originalConfig=parseConfig(JSON.parse(original.toString('utf8')));
  if(JSON.stringify(originalConfig)!==JSON.stringify(options.config))throw new Error('Enrollment configuration source mismatch');
  const profile=await readProfile(options.config.stateDirectory);
  if(options.config.telegram.databaseDirectory!==profile.telegramDatabase||options.config.telegram.filesDirectory!==profile.telegramFiles)throw new Error('Enrollment Telegram directories do not match the isolated profile');
  if(options.key.length!==32)throw new Error('Enrollment state key must contain 32 bytes');
  const transport=options.transport??new JsonProcessTransport({command:options.config.telegram.command,args:options.config.telegram.args,env:environment()});
  let identity:EnrollmentIdentity|undefined,confirmed=false,failure:unknown;
  try{await onboardingStage('sidecar-start',async()=>{transport.start();await transport.waitReady();});identity=await authenticate(transport,options.config,options.key,options.credentials,options.prompts);confirmed=await options.prompts.confirmIdentity(identity);}catch(error){failure=error;}
  try{await transport.close();}catch(error){
    return closureUnknown(options.config.stateDirectory,'enrollment_transport_closure_unknown',failure?[failure,error]:[error],'Enrollment transport closure requires reconciliation; owner binding was not applied');
  }
  if(failure)throw failure;
  if(!confirmed||!identity)return{enrolled:false};
  const bound=await replaceBinding(options.configPath,original,(old,raw)=>{requireUnenrolled(old);const id=accountId(identity!.accountId);raw.account={...raw.account,id,ownerId:id};});
  return{enrolled:true,accountId:bound.account.id,ownerId:bound.account.ownerId,controlPeerId:bound.account.controlPeerId,configurationSha256:createHash('sha256').update(await readFile(resolve(options.configPath))).digest('hex')};
}

/** Username resolution never substitutes a visually similar or historical name. */
export async function resolveControlPeer(transport:TdJsonTransport,usernameInput:string):Promise<ControlPeerIdentity>{
  const username=usernameInput.startsWith('@')?usernameInput.slice(1):usernameInput;
  if(!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username))throw new Error('Control peer requires an exact Telegram username');
  const stages:Readonly<Record<string,OnboardingStage>>={searchPublicChat:'control-username-lookup',getChat:'control-chat-read',getUser:'control-bot-read'};
  const invoke=(request:TdObject)=>{validateTdObject(request);return onboardingStage(stages[request['@type']]??'control-username-lookup',()=>transport.invoke(request));};
  const found=await invoke({'@type':'searchPublicChat',username});
  if(found['@type']!=='chat')throw new Error('Control peer username did not resolve to a chat');
  if(found.type?.['@type']!=='chatTypePrivate')throw new Error('Control peer must be a verified private conversation');
  const chat=await invoke({'@type':'getChat',chat_id:accountId(found.id)});
  if(chat['@type']!=='chat'||accountId(chat.id)!==accountId(found.id))throw new Error('Control peer chat identity changed during fresh verification');
  if(chat['@type']!=='chat'||chat.type?.['@type']!=='chatTypePrivate')throw new Error('Control peer must be a verified private conversation');
  const peerId=accountId(chat.id),userId=accountId(chat.type.user_id);
  const user=await invoke({'@type':'getUser',user_id:userId});
  if(user['@type']!=='user'||accountId(user.id)!==userId||!['userTypeRegular','userTypeBot'].includes(user.type?.['@type'])||user.have_access===false)throw new Error('Control peer is not an accessible private Telegram user or bot');
  const names=user.usernames?.active_usernames;
  if(!Array.isArray(names)||!names.some((value:unknown)=>typeof value==='string'&&value.toLowerCase()===username.toLowerCase()))throw new Error('Control peer username did not match the exact fresh identity');
  return{peerId,userId,username,firstName:typeof user.first_name==='string'?user.first_name:'',lastName:typeof user.last_name==='string'?user.last_name:'',isBot:user.type['@type']==='userTypeBot'};
}
export async function bindControlPeer(options:{configPath:string;config:PersonalConfig;key:Uint8Array;credentials:ApiCredentials;prompts:EnrollmentPrompts;username:string;transport?:EnrollmentTransport}):Promise<{bound:boolean;controlPeerId?:string;username?:string}>{
  const expectedOwner=accountId(options.config.account.id);if(accountId(options.config.account.ownerId)!==expectedOwner)throw new Error('Control peer binding requires the already enrolled primary owner');
  const original=await readFile(resolve(options.configPath));if(JSON.stringify(parseConfig(JSON.parse(original.toString('utf8'))))!==JSON.stringify(options.config))throw new Error('Control peer configuration source mismatch');
  const profile=await readProfile(options.config.stateDirectory);if(options.config.telegram.databaseDirectory!==profile.telegramDatabase||options.config.telegram.filesDirectory!==profile.telegramFiles)throw new Error('Control peer Telegram directories do not match the isolated profile');
  if(!options.prompts.confirmControl)throw new Error('Control peer binding requires trusted local confirmation');if(options.key.length!==32)throw new Error('Enrollment state key must contain 32 bytes');
  const transport=options.transport??new JsonProcessTransport({command:options.config.telegram.command,args:options.config.telegram.args,env:environment()});
  let target:ControlPeerIdentity|undefined,confirmed=false,failure:unknown;
  try{await onboardingStage('sidecar-start',async()=>{transport.start();await transport.waitReady();});const owner=await authenticate(transport,options.config,options.key,options.credentials,options.prompts);if(owner.accountId!==expectedOwner)throw new Error('Control peer authorization does not match the enrolled owner');target=await resolveControlPeer(transport,options.username);
    // Saved Messages remain storage, as selected by the owner; control needs a separate private peer.
    if(target.userId===expectedOwner)throw new Error('Control peer cannot be the enrolled owner; Saved Messages are reserved for storage');
    confirmed=await options.prompts.confirmControl(target);}catch(error){failure=error;}
  try{await transport.close();}catch(error){return closureUnknown(options.config.stateDirectory,'control_peer_transport_closure_unknown',failure?[failure,error]:[error],'Control peer transport closure requires reconciliation; binding was not applied');}
  if(failure)throw failure;if(!confirmed||!target)return{bound:false};
  await replaceBinding(options.configPath,original,(old,raw)=>{if(old.account.id!==expectedOwner||old.account.ownerId!==expectedOwner)throw new Error('Control peer owner binding changed');raw.account={...raw.account,controlPeerId:target!.peerId};});
  return{bound:true,controlPeerId:target.peerId,username:target.username};
}
