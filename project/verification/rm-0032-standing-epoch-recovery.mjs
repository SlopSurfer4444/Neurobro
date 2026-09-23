// Append-only physical settlement. This receipt never supplies a model outcome.
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath,link,unlink} from 'node:fs/promises';
import {resolve,dirname,basename,isAbsolute} from 'node:path';
import {types} from 'node:util';
import {normalizeEpochOwnerRecord} from './rm-0032-standing-epoch-receipt.mjs';

const HASH=/^[a-f0-9]{64}$/,TOKEN=/^[a-f0-9]{32}$/;
const fail=()=>{throw Object.assign(new Error('STANDING_EPOCH_RECOVERY_INVALID'),{code:'RECOVERY'});};
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
const identity=s=>[s.dev,s.ino].join(':');
const hash=b=>createHash('sha256').update(b).digest('hex');
function physicalSnapshot(value){
  if(!value||typeof value!=='object'||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return fail();
  const keys=['exclusiveCustody','windowsBeforeAbsent','guestAbsent','windowsAfterAbsent','checkedAt','receiptHash'];
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==keys.length)return fail();
  const result={};
  for(const key of keys){const d=descriptors[key];if(!d||!Object.hasOwn(d,'value')||!d.enumerable||!['boolean','string'].includes(typeof d.value))return fail();result[key]=d.value;}
  return Object.freeze(result);
}
async function directory(path,epochId){
  if(!isAbsolute(path)||resolve(path)!==path||!TOKEN.test(epochId)||basename(path)!==epochId)return fail();
  for(let at=path;;at=dirname(at)){const s=await lstat(at);if(!s.isDirectory()||s.isSymbolicLink())return fail();if(at===dirname(at))break;}
  if(await realpath(path)!==path)return fail();return identity(await lstat(path,{bigint:true}));
}
async function read(path){
  const before=await lstat(path,{bigint:true});
  const published=basename(path)==='recovery.json';
  if(!before.isFile()||before.isSymbolicLink()||(before.nlink!==1n&&!(published&&before.nlink===2n))||before.size<1n||before.size>32768n)return fail();
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{if(stamp(await file.stat({bigint:true}))!==stamp(before))return fail();
    const bytes=await file.readFile();
    if(stamp(await file.stat({bigint:true}))!==stamp(before)||stamp(await lstat(path,{bigint:true}))!==stamp(before))return fail();
    const value=JSON.parse(bytes.toString('utf8'));if(!Buffer.from(JSON.stringify(value)+'\n').equals(bytes))return fail();
    const digest=hash(bytes);
    // A crash after atomic no-overwrite publication may retain the one known
    // staging alias. Accept only that exact immutable content-addressed inode;
    // arbitrary aliases and all aliases on original records remain forbidden.
    if(before.nlink===2n){let stage;try{stage=await lstat(resolve(dirname(path),'.recovery-'+digest+'.json'),{bigint:true});}catch{return fail();}
      if(!stage.isFile()||stage.isSymbolicLink()||stamp(stage)!==stamp(before))return fail();}
    return {value,hash:digest};
  }finally{await file.close();}
}
async function actualSnapshot(path,epochId){
  let actual;try{actual=await read(resolve(path,'actual.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const normalized=normalizeEpochOwnerRecord(actual.value,epochId);
  if(normalized.resourcesSettled&&normalized.replacementReady)return fail();
  return actual;
}
async function snapshot(path,epochId){
  const id=await directory(path,epochId),actual=await actualSnapshot(path,epochId);
  const intent=await read(resolve(path,'intent.json')),controller=await read(resolve(path,'controller.json'));
  if(intent.value.token!==epochId||intent.value.operation!=='standing-native-epoch-v1'||!TOKEN.test(intent.value.workerToken)||
    controller.value.version!=='standing-controller-v1'||controller.value.token!==epochId||controller.value.workerToken!==intent.value.workerToken||
    !Number.isSafeInteger(controller.value.pid)||controller.value.pid<=0)return fail();
  if(await directory(path,epochId)!==id)return fail();return {id,intent,controller,actual};
}
function validate(r,epochId,s){
  const v2=r?.version==='standing-epoch-physical-recovery-v2';
  const keys=['version','epochId','authorizationHash','intentHash','controllerHash','physical',...(v2?['actualHash']:[])];
  if(!r||Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k))||!['standing-epoch-physical-recovery-v1','standing-epoch-physical-recovery-v2'].includes(r.version)||r.epochId!==epochId||
    !HASH.test(r.authorizationHash)||r.intentHash!==s.intent.hash||r.controllerHash!==s.controller.hash)return fail();
  if(v2?r.actualHash!==(s.actual?.hash??null):s.actual!==null)return fail();
  const p=r.physical,pk=['exclusiveCustody','windowsBeforeAbsent','guestAbsent','windowsAfterAbsent','checkedAt','receiptHash'];
  if(!p||Object.keys(p).length!==pk.length||pk.some(k=>!Object.hasOwn(p,k))||pk.slice(0,4).some(k=>p[k]!==true)||
    !HASH.test(p.receiptHash)||typeof p.checkedAt!=='string'||!Number.isFinite(Date.parse(p.checkedAt))||new Date(p.checkedAt).toISOString()!==p.checkedAt)return fail();
}
export async function readStandingEpochRecovery({directory:path,epochId}){
  await directory(path,epochId);
  let saved;try{saved=await read(resolve(path,'recovery.json'));}catch(e){if(e.code==='ENOENT')return undefined;throw e;}
  const s=await snapshot(path,epochId);validate(saved.value,epochId,s);
  if((await actualSnapshot(path,epochId))?.hash!==s.actual?.hash)return fail();
  if(await directory(path,epochId)!==s.id)return fail();
  return Object.freeze({intent:s.intent.value,receipt:saved.value,resourcesSettled:true,persisted:true,replacementReady:true,modelOutcome:'not-proven'});
}
// The host uses this only after selecting a pending epoch. A torn/foreign
// source is not recoverable; callers may retain task-local containment.
export async function inspectStandingEpochRecoveryCandidate({directory:path,epochId}){
  const s=await snapshot(path,epochId);
  return Object.freeze({epochId,workerToken:s.intent.value.workerToken,intentHash:s.intent.hash,controllerHash:s.controller.hash,actualHash:s.actual?.hash??null});
}
export async function writeStandingEpochRecovery({directory:path,epochId,authorizationHash,intentHash,controllerHash,actualHash=null,checkPhysicalSettlement}){
  if(![authorizationHash,intentHash,controllerHash].every(x=>typeof x==='string'&&HASH.test(x))||typeof checkPhysicalSettlement!=='function')return fail();
  if(actualHash!==null&&(typeof actualHash!=='string'||!HASH.test(actualHash)))return fail();
  const s=await snapshot(path,epochId);if(s.intent.hash!==intentHash||s.controller.hash!==controllerHash||(s.actual?.hash??null)!==actualHash)return fail();
  const physical=physicalSnapshot(await checkPhysicalSettlement(Object.freeze({epochId,authorizationHash,intentHash,controllerHash,controller:Object.freeze({...s.controller.value})})));
  const receipt={version:'standing-epoch-physical-recovery-v2',epochId,authorizationHash,intentHash,controllerHash,physical,actualHash};
  validate(receipt,epochId,s);const age=Date.now()-Date.parse(physical.checkedAt);if(age<0||age>60000)return fail();
  const after=await snapshot(path,epochId);if(after.id!==s.id||after.intent.hash!==intentHash||after.controller.hash!==controllerHash||(after.actual?.hash??null)!==actualHash)return fail();
  const bytes=JSON.stringify(receipt)+'\n',stage=resolve(path,'.recovery-'+hash(bytes)+'.json');
  const file=await open(stage,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  let stageIdentity;
  try{const own=await file.stat({bigint:true});if(!own.isFile()||own.nlink!==1n)return fail();await file.writeFile(bytes);await file.sync();
    stageIdentity=identity(own);if(identity(await lstat(stage,{bigint:true}))!==stageIdentity)return fail();
  }finally{await file.close();}
  // link is atomic and refuses any existing final path. rename would replace
  // an existing receipt. Failed stages are retained as crash evidence.
  await link(stage,resolve(path,'recovery.json'));
  if(identity(await lstat(resolve(path,'recovery.json'),{bigint:true}))!==stageIdentity||identity(await lstat(stage,{bigint:true}))!==stageIdentity)return fail();
  await unlink(stage);
  return readStandingEpochRecovery({directory:path,epochId});
}
