import test from "node:test";
import assert from "node:assert/strict";
import { Api, utils } from "telegram";
import { BinaryReader } from "telegram/extensions/BinaryReader.js";
import bigInt from "big-integer";
import { createStandingSourceObserver, StandingSourceObserverError } from "../src/standing-source-observer.js";
import type { SourceObservationCapture } from "../src/standing-source-archive.js";
import { openStandingSourceArchive } from "../src/standing-source-archive.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";

const peer=()=>new Api.PeerChannel({channelId:bigInt(123)});
const binding={accountId:"789",peerId:utils.getPeerId(peer())};
const signal=()=>new AbortController().signal;
const human=()=>new Api.User({id:bigInt(456),firstName:"Тестовый участник"});
const message=(id=2,body="исходный текст")=>new Api.Message({id,peerId:peer(),fromId:new Api.PeerUser({userId:bigInt(456)}),message:body,date:100});
const envelope=(messages:Api.TypeMessage[])=>new Api.messages.Messages({messages,users:[human()],chats:[]});
const quota={batches:1,encryptedBytes:1000,maximumBatches:8192 as const,maximumEncryptedBytes:268435456 as const};
function fixture(){const writes:SourceObservationCapture[]=[];const observer=createStandingSourceObserver({binding,now:()=>120,archive:{append:async(capture)=>{writes.push(capture);return {status:"stored",sequence:writes.length,quota};}}});return {writes,observer};}
function gate(){let done!:()=>void;const promise=new Promise<void>(r=>{done=r;});return {promise,done};}

test("decoded messages preserve original body, own answer, edit and reply; captions never claim media bytes",async()=>{
  const {observer,writes}=fixture();const photo=message(3,"");photo.media=new Api.MessageMediaPhoto({photo:new Api.PhotoEmpty({id:bigInt(1)})});
  const own=message(4,"мой ответ");own.fromId=new Api.PeerUser({userId:bigInt(789)});own.out=true;own.replyTo=new Api.MessageReplyHeader({replyToMsgId:2});
  const edited=message(2,"исправленный текст");edited.editDate=110;
  const decode=(m:Api.Message)=>new BinaryReader(m.getBytes()).tgReadObject() as Api.Message;
  const result=await observer.observe(envelope([decode(edited),decode(photo),decode(own)]),signal());
  assert.equal(result.stored,3);assert.equal(writes[0]!.observedAt,120);
  assert.deepEqual(writes[0]!.messages.map(m=>[m.messageId,m.text,m.contentKind,m.editedAt,m.replyToMessageId]),[
    [2,"исправленный текст","text",110,null],[3,"","photo-caption",null,null],[4,"мой ответ","text",null,2]]);
  assert.equal(writes[0]!.messages[2]!.authorId,"789");await observer.close();
});

test("repeated reads coalesce, changed old ID persists, and caller mutation cannot rewrite admitted source",async()=>{
  const entered=gate(),end=gate(),writes:SourceObservationCapture[]=[];
  const observer=createStandingSourceObserver({binding,now:()=>120,archive:{append:async capture=>{writes.push(capture);entered.done();await end.promise;return {status:"stored",sequence:1,quota};}}});
  const original=message(),batch=envelope([original]);const reading=observer.observe(batch,signal());
  original.message="changed immediately after invocation";batch.messages.length=0;
  await entered.promise;original.message="changed during write";end.done();await reading;
  assert.equal(writes[0]!.messages[0]!.text,"исходный текст");
  assert.equal((await observer.observe(envelope([message()]),signal())).unchanged,1);assert.equal(writes.length,1);
  const edited=message(2,"новая редакция");edited.editDate=119;await observer.observe(envelope([edited]),signal());assert.equal(writes.length,2);
  await observer.observe(envelope([message(1,"найдено старое")]),signal());assert.equal(writes.length,3);await observer.close();
});

test("foreign, unavailable, malformed and expiring messages cannot enter archive; exclusions are explicit",async()=>{
  const {observer,writes}=fixture();const foreign=message();foreign.peerId=new Api.PeerChannel({channelId:bigInt(999)});
  const expiry=message(3);expiry.ttlPeriod=0;const bad=message(4,"secret\0bad");const ownSpoof=message(5);ownSpoof.out=true;
  const result=await observer.observe(envelope([foreign,expiry,bad,ownSpoof,new Api.MessageEmpty({id:6})]),signal());
  assert.equal(result.excluded,5);assert.equal(result.completeChat,false);assert.equal(writes.length,0);
  await assert.rejects(observer.observe(envelope([message(),message()]),signal()),StandingSourceObserverError);await observer.close();
});

test("large unicode pages split before storage while every full source is retained",async()=>{
  const {observer,writes}=fixture();const body="я".repeat(8000);
  const result=await observer.observe(envelope(Array.from({length:40},(_,i)=>message(i+1,body))),signal());
  assert.equal(result.stored,40);assert.ok(writes.length>1);assert.equal(writes.flatMap(w=>w.messages).length,40);
  for(const capture of writes){assert.ok(Buffer.byteLength(JSON.stringify(capture))<250000);assert.ok(capture.messages.every(m=>m.text===body));}
  await observer.close();
});

test("failed persistence does not populate dedupe; no raw storage error escapes",async()=>{
  let attempts=0;const observer=createStandingSourceObserver({binding,archive:{append:async()=>{if(++attempts===1)throw Error("private filesystem secret");return {status:"stored",sequence:1,quota};}}});
  await assert.rejects(observer.observe(envelope([message()]),signal()),error=>error instanceof StandingSourceObserverError && !error.message.includes("secret") && !error.cause);
  assert.equal((await observer.observe(envelope([message()]),signal())).stored,1);assert.equal(attempts,2);await observer.close();
});

test("close and abort join a pending write, prevent later chunks, and reject concurrent/reentrant observation",async()=>{
  for(const mode of ["close","abort"]){
    const entered=gate(),end=gate(),control=new AbortController();let writes=0;
    const observer=createStandingSourceObserver({binding,archive:{append:async()=>{writes++;entered.done();await end.promise;return {status:"stored",sequence:1,quota};}}});
    const pending=observer.observe(envelope(Array.from({length:40},(_,i)=>message(i+1,"я".repeat(8000)))),control.signal);
    await entered.promise;await assert.rejects(observer.observe(envelope([message()]),signal()),StandingSourceObserverError);
    let closed=false;const closing=mode==="close"?observer.close().then(()=>{closed=true;}):undefined;
    if(mode==="abort")control.abort();await new Promise<void>(r=>setImmediate(r));assert.equal(closed,false);
    end.done();await assert.rejects(pending,StandingSourceObserverError);await closing;assert.equal(writes,1);await observer.close();
  }
});

test("irrelevant acknowledgements are ignored and invalid binding never writes",async()=>{
  const {observer,writes}=fixture();assert.equal((await observer.observe(true,signal())).stored,0);assert.equal(writes.length,0);await observer.close();
  assert.throws(()=>createStandingSourceObserver({binding:{accountId:"789",peerId:"456"},archive:{append:async()=>{throw Error("never");}}}),StandingSourceObserverError);
});

test("actual observer and encrypted archive recover original text and revisions after reopening without Telegram",async t=>{
  const parent=await mkdtemp(join(tmpdir(),"neurobro-observer-test-")),directory=join(parent,"archive"),passphrase="fixture-observer-passphrase-only";
  const handles:Awaited<ReturnType<typeof openStandingSourceArchive>>[]=[];
  t.after(async()=>{for(const h of handles)await h.close();assert.equal(dirname(resolve(parent)),resolve(tmpdir()));assert.ok(basename(parent).startsWith("neurobro-observer-test-"));await rm(parent,{recursive:true,force:true});});
  const archive=await openStandingSourceArchive({directory,passphrase,binding});handles.push(archive);
  const observer=createStandingSourceObserver({binding,archive,now:()=>120});
  const source=message(30,"уникальная исходная реплика");await observer.observe(envelope([source]),signal());
  source.message="уникальная исправленная реплика";source.editDate=115;await observer.observe(envelope([source,message(2,"нашли давнее")]),signal());
  await observer.close();await archive.close();
  for(const name of await readdir(directory)){const content=await readFile(join(directory,name),"utf8");assert.ok(!content.includes("уникальная"));assert.ok(!content.includes("нашли давнее"));}
  const reopened=await openStandingSourceArchive({directory,passphrase,binding});handles.push(reopened);
  const page=await reopened.query({fromDate:100,toDate:100},signal());
  assert.deepEqual(page.rows.map(r=>r.message.text),["уникальная исходная реплика","уникальная исправленная реплика","нашли давнее"]);
  assert.equal(page.coverage.completeChat,false);assert.equal(page.rows[1]!.message.editedAt,115);
});
