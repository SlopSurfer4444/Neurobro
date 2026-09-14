import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Api} from 'telegram';
import {BinaryReader} from 'telegram/extensions/BinaryReader.js';
import bigInt from 'big-integer';
import {inspectStandingMediaProfile,validateStandingMediaProfile,mediaProfileWire,StandingMediaProfileError} from '../src/standing-media-profile.js';
import {createStandingArtifactTelegramTransport,ArtifactTransportError} from '../src/standing-artifact-telegram.js';
// Synthetic framing fixtures, deliberately no decoded-media/playability claim.
function page(packet:Buffer,sequence:number,flags:number,granule:bigint):Buffer {
  const lengths:number[]=[];let size=packet.length;while(size>=255){lengths.push(255);size-=255;}lengths.push(size);
  const b=Buffer.alloc(27+lengths.length+packet.length);b.write('OggS');b[5]=flags;b.writeBigInt64LE(granule,6);b.writeUInt32LE(99,14);b.writeUInt32LE(sequence,18);b[26]=lengths.length;Buffer.from(lengths).copy(b,27);packet.copy(b,27+lengths.length);
  let crc=0;for(const byte of b){crc^=byte<<24;for(let bit=0;bit<8;bit++)crc=(crc<<1)^((crc&0x80000000)?0x04c11db7:0);}b.writeUInt32LE(crc>>>0,22);return b;
}
function ogg(packet=Buffer.from([0xf8,0xff,0xfe])):Buffer {
  const head=Buffer.alloc(19);head.write('OpusHead');head[8]=1;head[9]=1;head.writeUInt16LE(312,10);head.writeUInt32LE(48000,12);
  const tags=Buffer.alloc(16);tags.write('OpusTags');return Buffer.concat([page(head,0,2,0n),page(tags,1,0,0n),page(packet,2,4,960n)]);
}
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const box=(type:string,...parts:Buffer[])=>{const b=Buffer.concat([Buffer.alloc(8),...parts]);b.writeUInt32BE(b.length);b.write(type,4);return b;};
const full=(type:string,...parts:Buffer[])=>box(type,Buffer.alloc(4),...parts);
function mp4(width=64,height=64,ticks=1000,withAudio=false,highProfile=false,identityEdit=false):Buffer {
  const ftyp=box('ftyp',Buffer.from('isom'),u32(0),Buffer.from('avc1'));
  const mdat=box('mdat',Buffer.from(withAudio?[0,0,0,1,0x65,0x21,0x10]:[0,0,0,1,0x65]));
  const mdhd=Buffer.alloc(24);mdhd.writeUInt32BE(1000,12);mdhd.writeUInt32BE(ticks,16);
  const hdlr=Buffer.alloc(24);hdlr.write('vide',8);
  const tkhd=Buffer.alloc(84);tkhd.writeUInt32BE(width*65536,76);tkhd.writeUInt32BE(height*65536,80);
  const entry=Buffer.alloc(78);entry.writeUInt16BE(1,6);entry.writeUInt16BE(width,24);entry.writeUInt16BE(height,26);
  const avcc=box('avcC',Buffer.from([1,highProfile?100:66,0,30,255,225,0,2,0x67,0,1,0,2,0x68,0]),highProfile?Buffer.from([253,248,248,0]):Buffer.alloc(0));
  const stsd=full('stsd',u32(1),box('avc1',entry,avcc));
  const stsz=full('stsz',u32(5),u32(1)),stts=full('stts',u32(1),u32(1),u32(ticks)),stco=full('stco',u32(1),u32(ftyp.length+8)),stsc=full('stsc',u32(1),u32(1),u32(1),u32(1));
  const dinf=box('dinf',full('dref',u32(1),box('url ',u32(1))));
  const minf=box('minf',dinf,box('stbl',stsd,stsz,stts,stco,stsc));
  let audioTrack=Buffer.alloc(0);
  if(withAudio){
    const handler=Buffer.from(hdlr);handler.write('soun',8);const audioEntry=Buffer.alloc(28);audioEntry.writeUInt16BE(1,6);
    const decoder=Buffer.concat([Buffer.from([0x40,0x15]),Buffer.alloc(11),Buffer.from([5,2,0x12,0x08])]);
    const es=Buffer.concat([Buffer.from([0,1,0,4,decoder.length]),decoder,Buffer.from([6,1,2])]);
    const soundDescription=full('stsd',u32(1),box('mp4a',audioEntry,full('esds',Buffer.from([3,es.length]),es)));
    const soundTable=box('stbl',soundDescription,full('stsz',u32(2),u32(1)),stts,full('stco',u32(1),u32(ftyp.length+13)),stsc);
    audioTrack=box('trak',box('mdia',box('mdhd',mdhd),box('hdlr',handler),box('minf',dinf,soundTable)));
  }
  const mvhd=Buffer.alloc(24);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(ticks,16);
  const edts=identityEdit?box('edts',full('elst',u32(1),u32(ticks),u32(0),u32(65536))):Buffer.alloc(0);
  return Buffer.concat([ftyp,mdat,box('moov',box('mvhd',mvhd),box('trak',box('tkhd',tkhd),edts,box('mdia',box('mdhd',mdhd),box('hdlr',hdlr),minf)),audioTrack)]);
}
function edit(bytes:Buffer,tag:string,relative:number,value:number):Buffer{const copy=Buffer.from(bytes),where=copy.indexOf(tag);assert.ok(where>=0);copy.writeUInt32BE(value,where+4+relative);return copy;}

test('Ogg Opus framing derives duration and immutable byte-bound descriptor',()=>{
  const bytes=ogg(),before=Buffer.from(bytes),p=inspectStandingMediaProfile({kind:'voice',mimeType:'audio/ogg',bytes});
  assert.equal(p.durationSeconds,(960-312)/48000);assert.equal(p.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(p.byteLength,bytes.length);assert.ok(Object.isFrozen(p));assert.deepEqual(mediaProfileWire(p),{kind:'voice',durationSeconds:1});assert.deepEqual(bytes,before);assert.deepEqual(validateStandingMediaProfile(JSON.parse(JSON.stringify(p)),bytes,'audio/ogg'),p);
});
test('Ogg checksum truncated headers chained streams bad packets and false duration refuse',()=>{
  const bytes=ogg();const corrupted=Buffer.from(bytes);corrupted[corrupted.length-1]=corrupted[corrupted.length-1]!^1;
  for(const bad of [corrupted,bytes.subarray(0,-1),Buffer.concat([bytes,bytes]),ogg(Buffer.from([0xfb,0])),ogg(Buffer.from([0xfb,63])),Buffer.concat([bytes.subarray(0,bytes.length-31),page(Buffer.from([0xf8,0xff,0xfe]),2,4,999999n)])])assert.throws(()=>inspectStandingMediaProfile({kind:'voice',mimeType:'audio/ogg',bytes:bad}),StandingMediaProfileError);
});
test('MP4 local AVC sample tables derive dimensions and duration; round requires square <=60s',()=>{
  const bytes=mp4();const p=inspectStandingMediaProfile({kind:'video',mimeType:'video/mp4',bytes});assert.equal(p.durationSeconds,1);assert.equal(p.width,64);assert.equal(p.height,64);assert.deepEqual(mediaProfileWire(p),{kind:'video',durationSeconds:1,width:64,height:64});
  assert.equal(inspectStandingMediaProfile({kind:'round-video',mimeType:'video/mp4',bytes:mp4(64,64,60000)}).durationSeconds,60);
  for(const b of [mp4(64,32),mp4(64,64,60001)])assert.throws(()=>inspectStandingMediaProfile({kind:'round-video',mimeType:'video/mp4',bytes:b}),StandingMediaProfileError);
});
test('MP4 rejects invalid box lengths external sample data codec duration size and dimension declarations',()=>{
  const bytes=mp4(),codec=Buffer.from(bytes);codec.write('encv',codec.indexOf('avc1',30));
  const variants=[bytes.subarray(0,-1),edit(bytes,'stco',8,0),edit(bytes,'stts',12,2000),edit(bytes,'stsz',4,0xffffffff),edit(bytes,'tkhd',76,65536),codec,Buffer.concat([bytes,box('moof')]),edit(bytes,'url ',0,0),edit(bytes,'ftyp',0,0)];
  // Last variant loses major brand but retains avc1 compatibility, which is valid.
  for(const b of variants.slice(0,-1))assert.throws(()=>inspectStandingMediaProfile({kind:'video',mimeType:'video/mp4',bytes:b}),StandingMediaProfileError);
});
test('descriptor replay is bound to bytes kind MIME and exact keys; getters and shared input refuse',()=>{
  const bytes=mp4(),p=inspectStandingMediaProfile({kind:'video',mimeType:'video/mp4',bytes});
  for(const changed of [{...p,sha256:'0'.repeat(64)},{...p,width:1},{...p,kind:'voice'},{...p,extra:1}])assert.throws(()=>validateStandingMediaProfile(changed,bytes,'video/mp4'),StandingMediaProfileError);
  assert.throws(()=>validateStandingMediaProfile(p,mp4(32,32),'video/mp4'));assert.throws(()=>validateStandingMediaProfile(p,bytes,'audio/ogg'));
  let invoked=false;const input={kind:'voice',mimeType:'audio/ogg',get bytes(){invoked=true;return ogg();}};assert.throws(()=>inspectStandingMediaProfile(input as Parameters<typeof inspectStandingMediaProfile>[0]));assert.equal(invoked,false);
  assert.throws(()=>inspectStandingMediaProfile({kind:'voice',mimeType:'audio/ogg',bytes:Buffer.from(new SharedArrayBuffer(100))}));
});
function wire<T extends {getBytes():Buffer}>(value:T):T{const b=value.getBytes(),r=new BinaryReader(b);const decoded=r.tgReadObject();assert.equal(r.tellPosition(),b.length);return decoded as T;}
test('profile to actual GramJS attributes and binary exact readback for voice video and round',async()=>{
  for(const kind of ['voice','video','round-video'] as const){
    const bytes=kind==='voice'?ogg():mp4(),mimeType=kind==='voice'?'audio/ogg':'video/mp4',profile=inspectStandingMediaProfile({kind,mimeType,bytes}),media=mediaProfileWire(profile),filename=kind==='voice'?'voice.ogg':'video.mp4',caption=kind==='round-video'?'':'caption';const calls:Api.AnyRequest[]=[];
    const attribute=()=>kind==='voice'?new Api.DocumentAttributeAudio({voice:true,duration:media.durationSeconds}):new Api.DocumentAttributeVideo({duration:media.durationSeconds,w:media.width!,h:media.height!,roundMessage:kind==='round-video'});
    const document=()=>new Api.MessageMediaDocument({voice:kind==='voice',video:kind==='video',round:kind==='round-video',document:new Api.Document({id:bigInt(777),accessHash:bigInt(1),fileReference:Buffer.alloc(0),date:1,mimeType,size:bigInt(bytes.length),dcId:2,attributes:[new Api.DocumentAttributeFilename({fileName:filename}),attribute()]})});
    const message=()=>new Api.Message({id:11,out:true,peerId:new Api.PeerChannel({channelId:bigInt(456)}),fromId:new Api.PeerUser({userId:bigInt(123)}),date:1,message:caption,replyTo:new Api.MessageReplyHeader({replyToMsgId:10}),media:document()});
    const stop=new AbortController(),primary={chatId:'-100456',ownerId:'321',messageId:10,text:'request'};
    const transport=createStandingArtifactTelegramTransport({client:{async invoke(r:Api.AnyRequest){calls.push(r);const decoded=wire(r);if(decoded instanceof Api.upload.SaveFilePart)return true;if(decoded instanceof Api.messages.SendMedia){assert.ok(decoded.media instanceof Api.InputMediaUploadedDocument);assert.equal(decoded.media.forceFile,false);assert.deepEqual(decoded.media.attributes.map(a=>a.className),['DocumentAttributeFilename',kind==='voice'?'DocumentAttributeAudio':'DocumentAttributeVideo']);return wire(new Api.UpdateShortSentMessage({id:11,out:true,pts:1,ptsCount:1,date:1,media:document()}));}return wire(new Api.messages.Messages({messages:[message()],chats:[],users:[]}));}},binding:{accountId:'123',peerId:'-100456'},peer:new Api.InputPeerChannel({channelId:bigInt(456),accessHash:bigInt(7)}),self:new Api.User({id:bigInt(123),self:true}),selected:primary,signal:stop.signal,isSelectionActive:()=>true,revalidatePrimary:async()=>primary});
    await transport.sendOnce({chatId:primary.chatId,replyToMessageId:10,caption,randomId:'999',filename,mimeType,bytes,mediaProfile:profile},stop.signal);
    const result=await transport.readExact(primary.chatId,11,stop.signal);assert.deepEqual(result?.media,media);assert.ok(result&&!('mediaProfile'in result)&&!('sha256'in result));assert.equal(calls.length,3);
  }
});

test('MP4 optional AAC LC track is locally framed; unsupported decoder declaration refuses',()=>{
  const bytes=mp4(64,64,1000,true);assert.equal(inspectStandingMediaProfile({kind:'video',mimeType:'video/mp4',bytes}).durationSeconds,1);
  const wrong=Buffer.from(bytes),where=wrong.indexOf(Buffer.from([0x40,0x15]));assert.ok(where>0);wrong[where]=0x6b;
  assert.throws(()=>inspectStandingMediaProfile({kind:'video',mimeType:'video/mp4',bytes:wrong}),StandingMediaProfileError);
  const malformed=Buffer.from(bytes);malformed.writeUInt32BE(1000,malformed.indexOf('mdat')+4);assert.throws(()=>inspectStandingMediaProfile({kind:'video',mimeType:'video/mp4',bytes:malformed}),StandingMediaProfileError);
});
test('profile mismatch and simultaneous MP3 audio admit no Telegram invocation',async()=>{
  const bytes=ogg(),profile=inspectStandingMediaProfile({kind:'voice',mimeType:'audio/ogg',bytes});let calls=0;
  for(const edits of [{mediaProfile:{...profile,durationSeconds:2}},{mediaProfile:{...profile,sha256:'0'.repeat(64)}},{mediaProfile:profile,audio:{durationSeconds:1}}]){
    const stop=new AbortController(),primary={chatId:'-100456',ownerId:'321',messageId:10,text:'request'};
    const transport=createStandingArtifactTelegramTransport({client:{async invoke(){calls++;throw new Error('must not invoke');}},binding:{accountId:'123',peerId:'-100456'},peer:new Api.InputPeerChannel({channelId:bigInt(456),accessHash:bigInt(7)}),self:new Api.User({id:bigInt(123),self:true}),selected:primary,signal:stop.signal,isSelectionActive:()=>true,revalidatePrimary:async()=>primary});
    await assert.rejects(transport.sendOnce({chatId:primary.chatId,replyToMessageId:10,caption:'caption',randomId:'999',filename:'voice.ogg',mimeType:'audio/ogg',bytes,...edits},stop.signal),ArtifactTransportError);
  }assert.equal(calls,0);
});

test('high-profile AVC extension and exact identity edit accepted; presentation trimming refused',()=>{
  const bytes=mp4(64,64,1000,false,true,true);assert.equal(inspectStandingMediaProfile({kind:'video',mimeType:'video/mp4',bytes}).durationSeconds,1);
  const bad=edit(bytes,'elst',12,1);assert.throws(()=>inspectStandingMediaProfile({kind:'video',mimeType:'video/mp4',bytes:bad}),StandingMediaProfileError);
});

test('round video caption is refused before upload',async()=>{
  const bytes=mp4(),mediaProfile=inspectStandingMediaProfile({kind:'round-video',mimeType:'video/mp4',bytes}),stop=new AbortController(),primary={chatId:'-100456',ownerId:'321',messageId:10,text:'request'};let calls=0;
  const transport=createStandingArtifactTelegramTransport({client:{async invoke(){calls++;throw new Error('must not invoke');}},binding:{accountId:'123',peerId:'-100456'},peer:new Api.InputPeerChannel({channelId:bigInt(456),accessHash:bigInt(7)}),self:new Api.User({id:bigInt(123),self:true}),selected:primary,signal:stop.signal,isSelectionActive:()=>true,revalidatePrimary:async()=>primary});
  await assert.rejects(transport.sendOnce({chatId:primary.chatId,replyToMessageId:10,caption:'not supported',randomId:'999',filename:'video.mp4',mimeType:'video/mp4',bytes,mediaProfile},stop.signal),ArtifactTransportError);assert.equal(calls,0);
});
