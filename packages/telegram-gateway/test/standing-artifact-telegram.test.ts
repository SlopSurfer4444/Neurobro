import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Api } from 'telegram';
import { BinaryReader } from 'telegram/extensions/BinaryReader.js';
import bigInt from 'big-integer';
import { createStandingArtifactTelegramTransport } from '../src/standing-artifact-telegram.js';
import { ArtifactTransportError, type ArtifactDiagnostics, type StandingArtifactTelegramTransport } from '../src/standing-artifact-telegram.js';
import type { PilotPrimary } from '../src/pilot-telegram-adapter.js';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
const long=bigInt;
const binding={accountId:'123',peerId:'-100456'};
const primary={chatId:binding.peerId,ownerId:'321',messageId:10,text:'ПРОМПТ картинку'};
const document=(pid='777',size=PNG.length,mime='application/octet-stream',attrs: Api.TypeDocumentAttribute[]=[new Api.DocumentAttributeFilename({fileName:'sample.bin'})])=>new Api.MessageMediaDocument({document:new Api.Document({id:long(pid),accessHash:long(55),fileReference:Buffer.alloc(0),date:1,mimeType:mime,size:long(size),dcId:2,attributes:attrs})});
const message=(edits: Partial<ConstructorParameters<typeof Api.Message>[0]>={})=>new Api.Message({id:11,out:true,peerId:new Api.PeerChannel({channelId:long(456)}),fromId:new Api.PeerUser({userId:long(123)}),date:1,message:'caption',replyTo:new Api.MessageReplyHeader({replyToMsgId:10}),media:document(),...edits});
const ack=()=>new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:document()});
const updates=(msg=message(),rid='999',extra: Api.TypeUpdate[]=[])=>new Api.Updates({updates:[new Api.UpdateMessageID({id:11,randomId:long(rid)}),new Api.UpdateNewChannelMessage({message:msg,pts:1,ptsCount:1}),...extra],users:[],chats:[],date:1,seq:1});
const read=(msg: Api.TypeMessage=message())=>new Api.messages.Messages({messages:[msg],chats:[],users:[]});
/** Exercise the installed TL serializer AND decoder, not constructor defaults. */
function wire<T extends { getBytes(): Buffer }>(value: T): T {
  const bytes = value.getBytes(), reader = new BinaryReader(bytes);
  const decoded: unknown = reader.tgReadObject();
  assert.ok(decoded && typeof decoded === 'object');
  assert.equal(decoded.constructor, value.constructor);
  assert.equal(reader.tellPosition(), bytes.length);
  return decoded as T;
}
type SendInput = Parameters<StandingArtifactTelegramTransport['sendOnce']>[0];
const input=(edits: Partial<SendInput>={}): SendInput=>({chatId:binding.peerId,replyToMessageId:10,caption:'caption',randomId:'999',filename:'sample.bin',mimeType:'application/octet-stream',bytes:Buffer.from(PNG),...edits});
const deferred=()=>{let resolve!: ()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
type FactoryInput = Parameters<typeof createStandingArtifactTelegramTransport>[0];
type Options = {invoke?(request: Api.AnyRequest): Promise<unknown>; revalidate?(count: number): Promise<PilotPrimary>; args?: Partial<FactoryInput>};
function harness(options: Options={}) {
  const calls: Api.AnyRequest[]=[], revalidations: AbortSignal[]=[], stop=new AbortController(); let active=true;
  const args={client:{async invoke(request: Api.AnyRequest){calls.push(request);return options.invoke?options.invoke(request):request instanceof Api.upload.SaveFilePart?true:request instanceof Api.messages.SendMedia?ack():read();}},
    binding:{...binding},peer:new Api.InputPeerChannel({channelId:long(456),accessHash:long(7)}),self:new Api.User({id:long(123),self:true}),selected:{...primary},signal:stop.signal,
    isSelectionActive:()=>active,async revalidatePrimary(signal: AbortSignal){revalidations.push(signal);return options.revalidate?options.revalidate(revalidations.length):{...primary};},...options.args};
  return{transport:createStandingArtifactTelegramTransport(args),args,calls,revalidations,stop,deactivate:()=>active=false};
}
function upload(value: Api.AnyRequest | undefined): Api.upload.SaveFilePart { assert.ok(value instanceof Api.upload.SaveFilePart); return value; }
function sent(value: Api.AnyRequest | undefined) {
  assert.ok(value instanceof Api.messages.SendMedia); assert.ok(value.media instanceof Api.InputMediaUploadedDocument);
  assert.ok(value.media.file instanceof Api.InputFile); assert.ok(value.peer instanceof Api.InputPeerChannel);
  assert.ok(value.replyTo instanceof Api.InputReplyToMessage); assert.ok(value.randomId);
  return { request: value, file: value.media.file, peer: value.peer, reply: value.replyTo, randomId: value.randomId };
}
test('generic document, persisted randomId, bounded upload, exact document readback and single-use lifecycle',async()=>{
  const h=harness();const value=input();const a=await h.transport.sendOnce(value,h.stop.signal);
  assert.deepEqual(a,{messageId:11,documentId:'777'});assert.equal(h.revalidations.length,2);
  const [part,send]=h.calls;assert.ok(part instanceof Api.upload.SaveFilePart);assert.equal(part.filePart,0);
  const sentProof=sent(send);assert.equal(sentProof.randomId.toString(),'999');assert.equal(sentProof.file.id.toString(),part.fileId.toString());
  assert.equal(sentProof.file.md5Checksum,createHash('md5').update(PNG).digest('hex'));assert.equal(sentProof.file.parts,1);
  assert.equal(sentProof.peer.channelId.toString(),'456');assert.equal(sentProof.reply.replyToMsgId,10);assert.equal(sentProof.request.allowPaidFloodskip,false);assert.ok(sentProof.request.sendAs instanceof Api.InputPeerSelf);
  assert.deepEqual(value.bytes,PNG);assert.ok(part.bytes.every(b=>b===0),'owned upload bytes cleared after invocation settlement');
  const result=await h.transport.readExact(binding.peerId,11,h.stop.signal);assert.deepEqual(result,{messageId:11,documentId:'777',chatId:binding.peerId,accountId:'123',replyToMessageId:10,caption:'caption',filename:'sample.bin',mimeType:'application/octet-stream',byteLength:PNG.length});
  assert.ok(h.calls[2] instanceof Api.channels.GetMessages);assert.deepEqual(h.calls[2].id.map(i=>{assert.ok(i instanceof Api.InputMessageID);return i.id;}),[11]);
  await assert.rejects(h.transport.sendOnce(value,h.stop.signal));await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));assert.equal(h.calls.length,3);
});
test('long Russian selected request remains file-toolable through exact revalidation', async () => {
  const selected = { ...primary, text: 'ПРОМПТ ' + 'я'.repeat(4000) + ' конец' };
  const h = harness({ args: { selected }, revalidate: async () => ({ ...selected }) });
  assert.deepEqual(await h.transport.sendOnce(input(), h.stop.signal), { messageId: 11, documentId: '777' });
  assert.equal((await h.transport.readExact(binding.peerId, 11, h.stop.signal))?.caption, 'caption');
  assert.equal(h.revalidations.length, 2);
});
test('upload chunks are strictly sequential, copy owned and intact until in-flight part settles',async()=>{
  const pending=deferred();const admitted=deferred(),parts: Buffer[]=[];
  const bytes=Buffer.alloc(524288+100,42);PNG.copy(bytes,0);const original=Buffer.from(bytes);
  const h=harness({invoke:async r=>{if(r instanceof Api.upload.SaveFilePart){parts.push(Buffer.from(r.bytes));if(r.filePart===0){admitted.resolve();await pending.promise;}return true;}return new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:document("777",bytes.length)});}});
  const work=h.transport.sendOnce(input({bytes}),h.stop.signal);await admitted.promise;
  assert.equal(h.calls.length,1);bytes.fill(0);assert.deepEqual(upload(h.calls[0]).bytes,original.subarray(0,524288));pending.resolve();await work;
  assert.deepEqual(Buffer.concat(parts),original);assert.deepEqual(h.calls.filter(r=>r instanceof Api.upload.SaveFilePart).map(r=>r.filePart),[0,1]);assert.equal(sent(h.calls[2]).file.parts,2);
});
test('abort while upload is pending joins actual invoke, preserves bytes then admits no send',async()=>{
  const gate=deferred(),started=deferred();const h=harness({invoke:async r=>{started.resolve();await gate.promise;return true;}});
  let settled=false;const work=h.transport.sendOnce(input(),h.stop.signal);const observed=work.then(()=>{settled=true;},()=>{settled=true;});await started.promise;h.stop.abort();
  await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(upload(h.calls[0]).bytes,PNG);gate.resolve();await assert.rejects(work);await observed;
  assert.equal(h.calls.length,1);assert.ok(upload(h.calls[0]).bytes.every(b=>b===0));
});
test('upload refusal and invoke error never retry or send media',async()=>{
  for(const response of [false,new Error('unavailable')]){const h=harness({invoke:async()=>{if(response instanceof Error)throw response;return response;}});await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));assert.equal(h.calls.length,1);}
});
test('changed primary before upload or after upload refuses send',async()=>{
  for(const stage of [1,2]){const h=harness({revalidate:async n=>({...primary,text:n===stage?'edited':primary.text})});await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));assert.equal(h.calls.length,stage-1);}
});
test('selection expires during upload: no new invocation or final revalidation',async()=>{
  let h: ReturnType<typeof harness>;h=harness({invoke:async()=>{h.deactivate();return true;}});await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));assert.equal(h.calls.length,1);assert.equal(h.revalidations.length,1);
});
test('concurrent duplicate send cannot start second upload while first is pending',async()=>{
  const gate=deferred(),started=deferred();const h=harness({invoke:async r=>{if(r instanceof Api.upload.SaveFilePart){started.resolve();await gate.promise;return true;}return ack();}});
  const work=h.transport.sendOnce(input(),h.stop.signal);await started.promise;await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));assert.equal(h.calls.length,1);gate.resolve();await work;assert.equal(h.calls.length,2);
});
test('Updates ack needs exact randomId mapping AND matching self-authored document message',async()=>{
  const h=harness({invoke:async r=>r instanceof Api.upload.SaveFilePart?true:r instanceof Api.messages.SendMedia?updates():read()});assert.deepEqual(await h.transport.sendOnce(input(),h.stop.signal),{messageId:11,documentId:'777'});const proof=await h.transport.readExact(binding.peerId,11,h.stop.signal);assert.ok(proof);assert.equal(proof.documentId,'777');
});
test('ambiguous or unrelated ack mappings and absent document are unknown, never read or retry',async()=>{
  const bad=[()=>updates(message(),'998'),()=>updates(message(),'999',[new Api.UpdateMessageID({id:11,randomId:long(999)})]),
    ()=>updates(message(),'999',[new Api.UpdateMessageID({id:11,randomId:long(998)})]),()=>updates(message(),'999',[new Api.UpdateNewChannelMessage({message:message(),pts:1,ptsCount:1})]),
    ()=>updates(message({media:new Api.MessageMediaEmpty()})),()=>new Api.Updates({updates:[new Api.UpdateMessageID({id:11,randomId:long(999)})],users:[],chats:[],date:1,seq:1}),
    ()=>new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1}),()=>updates(message({fromId:new Api.PeerUser({userId:long(321)})}))];
  for(const make of bad){const h=harness({invoke:async r=>r instanceof Api.upload.SaveFilePart?true:make()});await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));assert.equal(h.calls.length,2);}
});
test('fresh readback rejects wrong identity, document, caption, reply, peer and forwarding',async()=>{
  const variants=[{id:12},{out:false},{fromId:new Api.PeerUser({userId:long(321)})},{peerId:new Api.PeerChannel({channelId:long(999)})},
    {media:document('778')},{message:'different'},{replyTo:new Api.MessageReplyHeader({replyToMsgId:9})},{replyTo:new Api.MessageReplyHeader({replyToMsgId:10,replyToPeerId:new Api.PeerChannel({channelId:long(999)})})},
    {fwdFrom:new Api.MessageFwdHeader({date:1})},{viaBotId:long(8)},{groupedId:long(4)},{post:true},{media:new Api.MessageMediaEmpty()}];
  for(const edits of variants){const h=harness({invoke:async r=>r instanceof Api.upload.SaveFilePart?true:r instanceof Api.messages.SendMedia?ack():read(message(edits))});await h.transport.sendOnce(input(),h.stop.signal);await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));assert.equal(h.calls.length,3);}
});
test('missing exact sent message returns null without claiming verification',async()=>{
  const h=harness({invoke:async r=>r instanceof Api.upload.SaveFilePart?true:r instanceof Api.messages.SendMedia?ack():read(new Api.MessageEmpty({id:11}))});await h.transport.sendOnce(input(),h.stop.signal);assert.equal(await h.transport.readExact(binding.peerId,11,h.stop.signal),null);
});
test('bad binding, self, byte bounds, filename, caption and randomId admit no invocations',async()=>{
  for(const edits of [{chatId:'-100999'},{replyToMessageId:12},{randomId:'0'},{randomId:(2n**63n).toString()},{mimeType:'invalid'},
    {bytes:Buffer.alloc(0)},{bytes:Buffer.alloc(32*1024*1024+1)},{caption:'x'.repeat(1025)},{caption:'\0'}]){const h=harness();/* Deliberately inject invalid MIME at the runtime boundary. */await assert.rejects(h.transport.sendOnce(input(edits as Partial<SendInput>),h.stop.signal));assert.equal(h.calls.length,0);}
  for(const args of [{binding:{...binding,accountId:'321'}},{peer:new Api.InputPeerChannel({channelId:long(999),accessHash:long(7)})},{self:new Api.User({id:long(123),self:true,bot:true})}])assert.throws(()=>harness({args}));
});
test('resolved peer, primary and binding are captured independently of later caller mutation',async()=>{
  const mutableBinding={...binding},mutableSelected={...primary},mutablePeer=new Api.InputPeerChannel({channelId:long(456),accessHash:long(7)});
  const h=harness({args:{binding:mutableBinding,selected:mutableSelected,peer:mutablePeer}});mutableBinding.peerId='-100999';mutablePeer.channelId=long(999);mutableSelected.messageId=99;await h.transport.sendOnce(input(),h.stop.signal);assert.equal(sent(h.calls[1]).peer.channelId.toString(),'456');assert.equal(sent(h.calls[1]).reply.replyToMsgId,10);
});
test('basic group routes exact GetMessages and preserves same peer/self checks',async()=>{
  const selected={...primary,chatId:'-456'};const h=harness({args:{binding:{...binding,peerId:'-456'},selected,peer:new Api.InputPeerChat({chatId:long(456)}),revalidatePrimary:async()=>({...selected})},invoke:async r=>r instanceof Api.upload.SaveFilePart?true:r instanceof Api.messages.SendMedia?ack():read(message({peerId:new Api.PeerChat({chatId:long(456)})}))});
  await h.transport.sendOnce(input({chatId:'-456'}),h.stop.signal);const proof=await h.transport.readExact('-456',11,h.stop.signal);assert.ok(proof);assert.equal(proof.chatId,'-456');assert.ok(h.calls[2] instanceof Api.messages.GetMessages);
});
test('abort during SendMedia remains pending until actual response; no read or replay admitted',async()=>{
  const gate=deferred(),started=deferred();const h=harness({invoke:async r=>{if(r instanceof Api.upload.SaveFilePart)return true;started.resolve();await gate.promise;return ack();}});
  const work=h.transport.sendOnce(input(),h.stop.signal);let done=false;work.catch(()=>{done=true;});await started.promise;h.stop.abort();await new Promise(r=>setImmediate(r));assert.equal(done,false);gate.resolve();await assert.rejects(work);await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));assert.equal(h.calls.length,2);
});

test('installed TL decoder represents absent document/message/short-ack TTL as null',()=>{
  assert.equal(document().ttlSeconds,undefined);assert.equal(message().ttlPeriod,undefined);assert.equal(ack().ttlPeriod,undefined);
  const decodedPhoto=wire(document()),decodedMessage=wire(message()),decodedAck=wire(ack());
  assert.equal(decodedPhoto.ttlSeconds,null);assert.equal(decodedMessage.ttlPeriod,null);assert.equal(decodedAck.ttlPeriod,null);
  assert.ok(decodedMessage.media instanceof Api.MessageMediaDocument);assert.equal(decodedMessage.media.ttlSeconds,null);
  assert.ok(decodedAck.media instanceof Api.MessageMediaDocument);assert.equal(decodedAck.media.ttlSeconds,null);
});

test('binary-decoded ShortSent and Updates acknowledgements plus exact readback verify',async()=>{
  for(const makeAck of [()=>ack(),()=>updates()]) {
    const h=harness({invoke:async request=>request instanceof Api.upload.SaveFilePart?true:
      request instanceof Api.messages.SendMedia?wire(makeAck()):wire(read())});
    assert.deepEqual(await h.transport.sendOnce(input(),h.stop.signal),{messageId:11,documentId:'777'});
    assert.deepEqual(await h.transport.readExact(binding.peerId,11,h.stop.signal),{
      messageId:11,documentId:'777',chatId:binding.peerId,accountId:binding.accountId,replyToMessageId:10,caption:'caption',filename:'sample.bin',mimeType:'application/octet-stream',byteLength:PNG.length});
    assert.equal(h.calls.length,3);assert.equal(h.revalidations.length,2);
  }
});

test('binary-decoded present TTL including zero remains refused in media, short ack and full message',async()=>{
  for(const ttl of [0,1,60]) {
    const ttlPhoto=()=>new Api.MessageMediaDocument({document:document().document!,ttlSeconds:ttl});
    assert.equal(wire(ttlPhoto()).ttlSeconds,ttl);assert.equal(wire(message({ttlPeriod:ttl})).ttlPeriod,ttl);
    assert.equal(wire(new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:document(),ttlPeriod:ttl})).ttlPeriod,ttl);
    const badAcks=[()=>new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:document(),ttlPeriod:ttl}),
      ()=>new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:ttlPhoto()}),
      ()=>updates(message({ttlPeriod:ttl})),()=>updates(message({media:ttlPhoto()}))];
    for(const makeAck of badAcks) {
      const h=harness({invoke:async request=>request instanceof Api.upload.SaveFilePart?true:wire(makeAck())});
      await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));assert.equal(h.calls.length,2);
      await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));assert.equal(h.calls.length,2);
    }
    for(const edited of [message({ttlPeriod:ttl}),message({media:ttlPhoto()})]) {
      const h=harness({invoke:async request=>request instanceof Api.upload.SaveFilePart?true:
        request instanceof Api.messages.SendMedia?wire(ack()):wire(read(edited))});
      await h.transport.sendOnce(input(),h.stop.signal);await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));
      assert.equal(h.calls.length,3);
    }
  }
});

test('binary-decoded wrong peer, caption, author, reply or document stays refused',async()=>{
  const variants=[{peerId:new Api.PeerChannel({channelId:long(999)})},{message:'changed'},
    {fromId:new Api.PeerUser({userId:long(321)})},{replyTo:new Api.MessageReplyHeader({replyToMsgId:9})},
    {media:new Api.MessageMediaEmpty()}];
  for(const edit of variants) {
    const badAck=harness({invoke:async request=>request instanceof Api.upload.SaveFilePart?true:wire(updates(message(edit)))});
    await assert.rejects(badAck.transport.sendOnce(input(),badAck.stop.signal));assert.equal(badAck.calls.length,2);
    const h=harness({invoke:async request=>request instanceof Api.upload.SaveFilePart?true:
      request instanceof Api.messages.SendMedia?wire(ack()):wire(read(message(edit)))});
    await h.transport.sendOnce(input(),h.stop.signal);await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));assert.equal(h.calls.length,3);
  }
});

test('fixed diagnostics locate each transport stage while nested catches retain the first cause',async()=>{
  const cases: {stage: ArtifactDiagnostics['stage'];reason:ArtifactDiagnostics['reason'];options:Options;read?:boolean}[]=[
    {stage:'revalidate-before',reason:'proof',options:{revalidate:async()=>({...primary,text:'edited'})}},
    {stage:'revalidate-after',reason:'proof',options:{revalidate:async n=>({...primary,text:n===2?'edited':primary.text})}},
    {stage:'upload',reason:'invoke',options:{invoke:async()=>{throw new Error('PRIVATE upload payload');}}},
    {stage:'upload',reason:'proof',options:{invoke:async()=>false}},
    {stage:'send-invoke',reason:'invoke',options:{invoke:async r=>{if(r instanceof Api.upload.SaveFilePart)return true;throw new Error('PRIVATE send payload');}}},
    {stage:'ack-parse',reason:'proof',options:{invoke:async r=>r instanceof Api.upload.SaveFilePart?true:wire(updates(message(),'998'))}},
    {stage:'read-invoke',reason:'invoke',read:true,options:{invoke:async r=>{if(r instanceof Api.upload.SaveFilePart)return true;if(r instanceof Api.messages.SendMedia)return wire(ack());throw new Error('PRIVATE read payload');}}},
    {stage:'readback-parse',reason:'proof',read:true,options:{invoke:async r=>r instanceof Api.upload.SaveFilePart?true:r instanceof Api.messages.SendMedia?wire(ack()):wire(read(message({message:'wrong'})))}},
  ];
  for(const c of cases){const h=harness(c.options);if(c.read)await h.transport.sendOnce(input(),h.stop.signal);
    await assert.rejects(c.read?h.transport.readExact(binding.peerId,11,h.stop.signal):h.transport.sendOnce(input(),h.stop.signal),error=>{
      assert.ok(error instanceof ArtifactTransportError);assert.deepEqual(error.diagnostics,{stage:c.stage,reason:c.reason});
      assert.ok(Object.isFrozen(error));assert.ok(Object.isFrozen(error.diagnostics));assert.ok(!JSON.stringify(error).includes('PRIVATE'));
      assert.deepEqual(Object.keys(error.diagnostics).sort(),['reason','stage']);return true;
    });
  }
});

test('duplicate calls during pending upload do not overwrite the admitted operation diagnostic stage',async()=>{
  const gate=deferred(),started=deferred();const h=harness({invoke:async()=>{started.resolve();await gate.promise;throw new Error('PRIVATE');}});
  const work=h.transport.sendOnce(input(),h.stop.signal);const rejected=assert.rejects(work,error=>error instanceof ArtifactTransportError&&error.diagnostics.stage==='upload'&&error.diagnostics.reason==='invoke');
  await started.promise;await assert.rejects(h.transport.sendOnce(input(),h.stop.signal));await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));gate.resolve();await rejected;assert.equal(h.calls.length,1);
});


test('MP3 wire metadata delivers playable audio with defensive metadata copy',async()=>{
  const audio={durationSeconds:123,title:'Track',performer:'Artist'};
  const media=()=>document('777',PNG.length,'audio/mpeg',[new Api.DocumentAttributeFilename({fileName:'track.mp3'}),new Api.DocumentAttributeAudio({duration:123,title:'Track',performer:'Artist'})]);
  const h=harness({invoke:async r=>{const d=wire(r);if(d instanceof Api.upload.SaveFilePart)return true;if(d instanceof Api.messages.SendMedia){assert.ok(d.media instanceof Api.InputMediaUploadedDocument);assert.equal(d.media.forceFile,false);assert.equal(d.media.mimeType,'audio/mpeg');assert.deepEqual(d.media.attributes.map(a=>a.className),['DocumentAttributeFilename','DocumentAttributeAudio']);return wire(new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:media()}));}return wire(read(message({media:media()})));}});
  await h.transport.sendOnce(input({filename:'track.mp3',mimeType:'audio/mpeg',audio}),h.stop.signal);audio.title='mutated';
  assert.deepEqual((await h.transport.readExact(binding.peerId,11,h.stop.signal))?.audio,{durationSeconds:123,title:'Track',performer:'Artist'});
});
test('10 MiB InputFile boundary and 32 MiB InputFileBig upload use sequential binary parts',async()=>{
  for(const size of [10*1024*1024,10*1024*1024+1,32*1024*1024]){const big=size>10*1024*1024,parts=Math.ceil(size/524288);let count=0;
    const h=harness({invoke:async r=>{if(r instanceof Api.upload.SaveFilePart||r instanceof Api.upload.SaveBigFilePart){assert.equal(r.filePart,count++);assert.equal(r instanceof Api.upload.SaveBigFilePart,big);if(r instanceof Api.upload.SaveBigFilePart)assert.equal(r.fileTotalParts,parts);assert.equal(r.bytes.length,Math.min(524288,size-r.filePart*524288));wire(r);return true;}assert.ok(r instanceof Api.messages.SendMedia);const d=wire(r);assert.ok(d.media instanceof Api.InputMediaUploadedDocument);assert.equal(d.media.file instanceof Api.InputFileBig,big);assert.ok(d.media.file instanceof Api.InputFileBig || d.media.file instanceof Api.InputFile);assert.equal(d.media.file.parts,parts);assert.equal(d.media.forceFile,true);return wire(new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:document('777',size)}));}});
    await h.transport.sendOnce(input({bytes:Buffer.alloc(size,7)}),h.stop.signal);assert.equal(count,parts);
  }
});
test('binary document proof refuses size MIME filename duplicate attributes and media voice/video',async()=>{
  const variants=[document('777',PNG.length+1),document('777',PNG.length,'text/plain'),document('777',PNG.length,'application/octet-stream',[new Api.DocumentAttributeFilename({fileName:'other.bin'})]),document('777',PNG.length,'application/octet-stream',[new Api.DocumentAttributeFilename({fileName:'sample.bin'}),new Api.DocumentAttributeFilename({fileName:'sample.bin'})]),document('777',PNG.length,'application/octet-stream',[new Api.DocumentAttributeAnimated()]),new Api.MessageMediaDocument({document:document().document!,voice:true}),new Api.MessageMediaDocument({document:document().document!,video:true})];
  for(const media of variants){const h=harness({invoke:async r=>r instanceof Api.upload.SaveFilePart?true:r instanceof Api.messages.SendMedia?wire(ack()):wire(read(message({media})))});await h.transport.sendOnce(input(),h.stop.signal);await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal),ArtifactTransportError);}
});
test('binary audio proof refuses voice waveform duration title performer and nonaudio attribute',async()=>{
  const good=new Api.DocumentAttributeAudio({duration:12,title:'title',performer:'artist'});
  const variants=[new Api.DocumentAttributeAudio({duration:12,title:'title',performer:'artist',voice:true}),new Api.DocumentAttributeAudio({duration:12,title:'title',performer:'artist',waveform:Buffer.alloc(0)}),new Api.DocumentAttributeAudio({duration:13,title:'title',performer:'artist'}),new Api.DocumentAttributeAudio({duration:12,title:'wrong',performer:'artist'}),new Api.DocumentAttributeAudio({duration:12,title:'title',performer:'wrong'}),new Api.DocumentAttributeAnimated()];
  const media=(a:Api.TypeDocumentAttribute)=>document('777',PNG.length,'audio/mpeg',[new Api.DocumentAttributeFilename({fileName:'sample.bin'}),a]);
  for(const a of variants){const h=harness({invoke:async r=>r instanceof Api.upload.SaveFilePart?true:r instanceof Api.messages.SendMedia?wire(new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:media(good)})):wire(read(message({media:media(a)})))});await h.transport.sendOnce(input({mimeType:'audio/mpeg',audio:{durationSeconds:12,title:'title',performer:'artist'}}),h.stop.signal);await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));}
});
test('invalid filename and audio metadata cannot invoke',async()=>{
  for(const edits of [{filename:'../a'},{filename:'a\\b'},{filename:'a:stream'},{filename:''},{filename:'bad\nname'},{audio:{durationSeconds:1}},{mimeType:'audio/mpeg',audio:{durationSeconds:-1}},{mimeType:'audio/mpeg',audio:{durationSeconds:1.5}},{mimeType:'audio/mpeg',audio:{durationSeconds:1,title:'\0'}}]){const h=harness();await assert.rejects(h.transport.sendOnce(input(edits),h.stop.signal),ArtifactTransportError);assert.equal(h.calls.length,0);}
});
test('STOP during read joins invoke and forbids duplicate read',async()=>{
  const gate=deferred(),started=deferred();const h=harness({invoke:async r=>{if(r instanceof Api.upload.SaveFilePart)return true;if(r instanceof Api.messages.SendMedia)return ack();started.resolve();await gate.promise;return read();}});
  await h.transport.sendOnce(input(),h.stop.signal);let done=false;const work=h.transport.readExact(binding.peerId,11,h.stop.signal);const joined=work.catch(()=>{done=true;});await started.promise;h.stop.abort();await assert.rejects(h.transport.readExact(binding.peerId,11,h.stop.signal));await new Promise(r=>setImmediate(r));assert.equal(done,false);gate.resolve();await assert.rejects(work);await joined;assert.equal(h.calls.length,3);
});

test('accessor or extended metadata is refused without executing getters',async()=>{
  let reads=0;const getter={...input()};Object.defineProperty(getter,'filename',{get(){reads++;return 'sample.bin';},enumerable:true});
  const audio={durationSeconds:1};Object.defineProperty(audio,'title',{get(){reads++;return 'title';},enumerable:true});
  for(const value of [getter,input({mimeType:'audio/mpeg',audio}),{...input(),voice:true}]){const h=harness();await assert.rejects(h.transport.sendOnce(value,h.stop.signal),ArtifactTransportError);assert.equal(h.calls.length,0);}
  assert.equal(reads,0);
});

test('intrinsic byte custody never invokes caller Buffer length or proxy traps',async()=>{
  let getters=0;const bytes=Buffer.from(PNG);Object.defineProperty(bytes,'length',{get(){getters++;PNG.copy(bytes);return 0;}});
  const h=harness();await h.transport.sendOnce(input({bytes}),h.stop.signal);assert.equal(getters,0);assert.equal(h.calls.length,2);
  let traps=0;const proxied=new Proxy(input(),{getPrototypeOf(){traps++;return Object.prototype;}});const refused=harness();await assert.rejects(refused.transport.sendOnce(proxied,refused.stop.signal),ArtifactTransportError);assert.equal(traps,0);assert.equal(refused.calls.length,0);
});
