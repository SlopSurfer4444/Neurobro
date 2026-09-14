import { createHash } from 'node:crypto';
import { types } from 'node:util';

export type StandingMediaProfile = Readonly<{version:'standing-media-profile-v1';kind:'voice'|'video'|'round-video';mimeType:'audio/ogg'|'video/mp4';sha256:string;byteLength:number;durationSeconds:number;width?:number;height?:number}>;
export class StandingMediaProfileError extends Error { constructor(){super('STANDING_MEDIA_PROFILE_REFUSED');this.name='StandingMediaProfileError';Object.freeze(this);} }
const fail=():never=>{throw new StandingMediaProfileError();};
const MAX=32*1024*1024;
function record(value:unknown,keys:readonly string[],required:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return fail();
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(ds).some(k=>typeof k!=='string'||!keys.includes(k))||required.some(k=>!Object.hasOwn(ds,k))||Object.values(ds).some(d=>!('value'in d)))return fail();
  return Object.fromEntries(Object.entries(ds).map(([k,d])=>[k,d.value]));
}
const typed=Object.getPrototypeOf(Uint8Array.prototype), backing=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!,offset=Object.getOwnPropertyDescriptor(typed,'byteOffset')!.get!,length=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!,resizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
function copy(value:unknown):Buffer{
  if(!value||typeof value!=='object'||types.isProxy(value)||!Buffer.isBuffer(value))return fail();
  const buffer=backing.call(value) as ArrayBuffer,len=length.call(value) as number;
  if(types.isSharedArrayBuffer(buffer)||resizable?.call(buffer)||len<1||len>MAX)return fail();
  return Buffer.from(new Uint8Array(buffer,offset.call(value) as number,len));
}
const crcTable=Array.from({length:256},(_,i)=>{let r=i<<24;for(let n=0;n<8;n++)r=(r<<1)^((r&0x80000000)?0x04c11db7:0);return r>>>0;});
function crc(bytes:Buffer,start:number,end:number):number{let r=0;for(let i=start;i<end;i++){const b=i>=start+22&&i<start+26?0:bytes[i]!;r=((r<<8)^crcTable[((r>>>24)^b)&255]!)>>>0;}return r;}
// RFC 6716 section 3 packet framing only: no Opus entropy/sample decoding.
function opusSamples(p:Buffer):number{
  if(!p.length)return fail();const toc=p[0]!,config=toc>>>3,code=toc&3;
  const samples=config<12?[480,960,1920,2880][config&3]!:config<16?[480,960][config&1]!:[120,240,480,960][config&3]!;
  let n=1,pos=1,end=p.length;const frame=(size:number)=>{if(size<0||size>1275)return fail();};
  const frameLength=()=>{if(pos>=end)return fail();const a=p[pos++]!;if(a<252)return a;if(pos>=end)return fail();return a+4*p[pos++]!;};
  if(code===0)frame(end-pos);
  else if(code===1){n=2;if((end-pos)%2)return fail();frame((end-pos)/2);}
  else if(code===2){n=2;const size=frameLength();frame(size);frame(end-pos-size);}
  else {
    if(pos>=end)return fail();const flags=p[pos++]!;n=flags&63;if(!n||n>48)return fail();
    if(flags&64){let padding=0,b:number;do{if(pos>=end)return fail();b=p[pos++]!;padding+=b===255?254:b;if(padding>end-pos)return fail();}while(b===255);end-=padding;}
    if(flags&128){let sum=0;for(let i=0;i<n-1;i++){const size=frameLength();frame(size);sum+=size;}frame(end-pos-sum);}
    else{if((end-pos)%n)return fail();frame((end-pos)/n);}
  }
  if(n*samples>5760)return fail();return n*samples;
}
function oggDuration(bytes:Buffer):number{
  let at=0,seq=0,serial:number|undefined,packetCount=0,preskip=0,total=0,previous=0,ended=false,pending=0;let pieces:Buffer[]=[];
  while(at<bytes.length){
    if(ended||bytes.length-at<27||bytes.toString('ascii',at,at+4)!=='OggS'||bytes[at+4]!==0)return fail();
    const flags=bytes[at+5]!,segments=bytes[at+26]!,head=at+27+segments;if(flags&~7||head>bytes.length||!segments)return fail();
    const granule=bytes.readBigInt64LE(at+6),stream=bytes.readUInt32LE(at+14),sequence=bytes.readUInt32LE(at+18);
    if(sequence!==seq++||(serial!==undefined&&serial!==stream)||Boolean(flags&1)!==Boolean(pending)||Boolean(flags&2)!==(sequence===0))return fail();serial=stream;
    let end=head;for(let i=at+27;i<head;i++)end+=bytes[i]!;if(end>bytes.length||crc(bytes,at,end)!==bytes.readUInt32LE(at+22))return fail();
    let cursor=head,completedAudio=0;const before=packetCount;
    for(let i=at+27;i<head;i++){
      const size=bytes[i]!;pieces.push(bytes.subarray(cursor,cursor+size));pending+=size;cursor+=size;if(pending>1024*1024)return fail();
      if(size===255)continue;const packet=Buffer.concat(pieces,pending);pieces=[];pending=0;
      try {
        if(packetCount===0){if(sequence!==0||segments!==1||packet.length!==19||packet.toString('ascii',0,8)!=='OpusHead'||packet[8]!==1||![1,2].includes(packet[9]!)||packet[18]!==0)return fail();preskip=packet.readUInt16LE(10);}
        else if(packetCount===1){if(packet.length<16||packet.toString('ascii',0,8)!=='OpusTags')return fail();let p=12+packet.readUInt32LE(8);if(p+4>packet.length)return fail();const count=packet.readUInt32LE(p);p+=4;if(count>65536)return fail();for(let j=0;j<count;j++){if(p+4>packet.length)return fail();const n=packet.readUInt32LE(p);p+=4+n;if(p>packet.length)return fail();}}
        else {total+=opusSamples(packet);completedAudio++;if(total>48000*86400)return fail();}
        packetCount++;
      }finally{packet.fill(0);}
    }
    if(before<2&&packetCount>2)return fail(); // Separate header and audio pages.
    if(packetCount<=2){if(granule!==0n||flags&4)return fail();}
    else if(completedAudio){if(granule<0n||granule>BigInt(total)||granule<BigInt(previous)||(!(flags&4)&&granule!==BigInt(total)))return fail();previous=Number(granule);}
    else if(granule!==-1n)return fail();
    if(flags&4){if(pending||!completedAudio||previous<=preskip)return fail();ended=true;}
    at=end;
  }
  if(!ended||packetCount<3||pending)return fail();return(previous-preskip)/48000;
}

type Box={type:string;start:number;data:number;end:number};
function boxes(b:Buffer,start:number,end:number):Box[]{const out:Box[]=[];for(let p=start;p<end;){if(end-p<8||out.length>=4096)return fail();let size=b.readUInt32BE(p),header=8;if(size===1){if(end-p<16)return fail();const large=b.readBigUInt64BE(p+8);if(large>BigInt(MAX))return fail();size=Number(large);header=16;}if(size<header||size>end-p)return fail();out.push({type:b.toString('ascii',p+4,p+8),start:p,data:p+header,end:p+size});p+=size;}return out;}
function one(list:Box[],type:string):Box{const found=list.filter(x=>x.type===type);if(found.length!==1)return fail();return found[0]!;}
function full(b:Buffer,x:Box,min:number):number{if(x.end-x.data<min||b.readUInt32BE(x.data)!==0)return fail();return x.data+4;}
function aacConfiguration(b:Buffer,entry:Box):void {
  const children=boxes(b,entry.data+28,entry.end),esds=one(children,'esds'),start=full(b,esds,4);
  function descriptors(start:number,end:number):{tag:number;data:number;end:number}[]{
    const out:{tag:number;data:number;end:number}[]=[];let p=start;
    while(p<end){if(out.length>=16)return fail();const tag=b[p++]!;let size=0,count=0,v:number;do{if(p>=end||count++>=4)return fail();v=b[p++]!;size=size*128+(v&127);}while(v&128);if(size>end-p)return fail();out.push({tag,data:p,end:p+size});p+=size;}
    return out;
  }
  const outer=descriptors(start,esds.end);if(outer.length!==1||outer[0]!.tag!==3)return fail();const es=outer[0]!;
  if(es.end-es.data<3||b[es.data+2]!==0)return fail();const eschildren=descriptors(es.data+3,es.end),decoder=eschildren.filter(x=>x.tag===4),sl=eschildren.filter(x=>x.tag===6);
  if(eschildren.length!==2||decoder.length!==1||sl.length!==1||sl[0]!.end-sl[0]!.data!==1||b[sl[0]!.data]!==2)return fail();const d=decoder[0]!;
  if(d.end-d.data<13||b[d.data]!==0x40||b[d.data+1]!==0x15)return fail();const config=descriptors(d.data+13,d.end);if(config.length!==1||config[0]!.tag!==5||config[0]!.end-config[0]!.data!==2)return fail();
  const bits=b.readUInt16BE(config[0]!.data);if((bits>>>11)!==2||((bits>>>7)&15)>12||![1,2].includes((bits>>>3)&15)||(bits&7)!==0)return fail();
}
function mp4Metadata(b:Buffer):{durationSeconds:number;width:number;height:number}{
  const top=boxes(b,0,b.length);if(top.some(x=>!['ftyp','moov','mdat','free','skip','wide'].includes(x.type)))return fail();
  const ftyp=one(top,'ftyp');if(ftyp.end-ftyp.data<8||(ftyp.end-ftyp.data)%4)return fail();const brands=[b.toString('ascii',ftyp.data,ftyp.data+4)];for(let i=ftyp.data+8;i<ftyp.end;i+=4)brands.push(b.toString('ascii',i,i+4));if(!brands.some(s=>['isom','iso2','mp41','mp42','avc1'].includes(s)))return fail();
  const moov=one(top,'moov'),movie=boxes(b,moov.data,moov.end),mdats=top.filter(x=>x.type==='mdat');if(!mdats.length||movie.some(x=>x.type==='mvex'))return fail();
  const tracks=movie.filter(x=>x.type==='trak');if(!tracks.length||tracks.length>2)return fail();let result:{durationSeconds:number;width:number;height:number}|undefined;const ranges:[number,number][]=[];
  for(const track of tracks){
    const ts=boxes(b,track.data,track.end);const mdia=one(ts,'mdia'),ms=boxes(b,mdia.data,mdia.end),hdlr=one(ms,'hdlr');const hp=full(b,hdlr,12),handler=b.toString('ascii',hp+4,hp+8);if(handler!=='vide'&&handler!=='soun')return fail();
    const mdhd=one(ms,'mdhd');if(mdhd.end-mdhd.data<24)return fail();const ver=b[mdhd.data]!,flags=b.readUIntBE(mdhd.data+1,3);if(flags||ver>1)return fail();const scaleAt=mdhd.data+(ver===0?12:20),durationAt=scaleAt+4;if(durationAt+(ver===0?4:8)>mdhd.end)return fail();const scale=b.readUInt32BE(scaleAt),duration=ver===0?BigInt(b.readUInt32BE(durationAt)):b.readBigUInt64BE(durationAt);if(!scale||duration<=0n||duration>BigInt(scale)*86400n)return fail();
    const edits=ts.filter(x=>x.type==='edts');
    if(edits.length){
      if(edits.length!==1)return fail();const lists=boxes(b,edits[0]!.data,edits[0]!.end),elst=one(lists,'elst');if(lists.length!==1||elst.end-elst.data<8)return fail();
      const v=b[elst.data]!;if(v>1||b.readUIntBE(elst.data+1,3)!==0||b.readUInt32BE(elst.data+4)!==1||elst.end-elst.data!==(v===0?20:28))return fail();
      const segment=v===0?BigInt(b.readUInt32BE(elst.data+8)):b.readBigUInt64BE(elst.data+8),time=v===0?BigInt(b.readInt32BE(elst.data+12)):b.readBigInt64BE(elst.data+16),rateAt=elst.data+(v===0?16:24);
      const mvhd=one(movie,'mvhd');if(mvhd.end-mvhd.data<24||b[mvhd.data]!>1||b.readUIntBE(mvhd.data+1,3)!==0)return fail();const movieScaleAt=mvhd.data+(b[mvhd.data]===0?12:20);if(movieScaleAt+4>mvhd.end)return fail();const movieScale=b.readUInt32BE(movieScaleAt);
      if(time!==0n||b.readUInt32BE(rateAt)!==65536||!movieScale||segment*BigInt(scale)!==duration*BigInt(movieScale))return fail();
    }
    const minf=one(ms,'minf'),mins=boxes(b,minf.data,minf.end),dinf=one(mins,'dinf'),drefs=boxes(b,dinf.data,dinf.end),dref=one(drefs,'dref'),dp=full(b,dref,8);if(b.readUInt32BE(dp)!==1)return fail();const urls=boxes(b,dp+4,dref.end);if(urls.length!==1||urls[0]!.type!=='url '||urls[0]!.end-urls[0]!.data!==4||b.readUInt32BE(urls[0]!.data)!==1)return fail();
    const stbl=one(mins,'stbl'),st=boxes(b,stbl.data,stbl.end);if(st.some(x=>['stz2','senc','saiz','saio'].includes(x.type)))return fail();
    const stsd=one(st,'stsd'),sd=full(b,stsd,8);if(b.readUInt32BE(sd)!==1)return fail();const entries=boxes(b,sd+4,stsd.end);if(entries.length!==1)return fail();const entry=entries[0]!;if(entry.end-entry.data<8||b.readUInt16BE(entry.data+6)!==1)return fail();
    if(handler==='vide'){
      if(result||entry.type!=='avc1'||entry.end-entry.data<78)return fail();const width=b.readUInt16BE(entry.data+24),height=b.readUInt16BE(entry.data+26);if(!width||!height||width>8192||height>8192)return fail();
      const children=boxes(b,entry.data+78,entry.end),avcc=one(children,'avcC');if(avcc.end-avcc.data<7||b[avcc.data]!==1||(b[avcc.data+4]!&3)!==3)return fail();let p=avcc.data+6;const sps=b[avcc.data+5]!&31;if(!sps)return fail();for(let n=0;n<sps;n++){if(p+2>avcc.end)return fail();const size=b.readUInt16BE(p);p+=2;if(!size||p+size>avcc.end||(b[p]!&31)!==7)return fail();p+=size;}if(p>=avcc.end)return fail();const pps=b[p++]!;if(!pps)return fail();for(let n=0;n<pps;n++){if(p+2>avcc.end)return fail();const size=b.readUInt16BE(p);p+=2;if(!size||p+size>avcc.end||(b[p]!&31)!==8)return fail();p+=size;}
      if(p<avcc.end){if(![100,110,122,144].includes(b[avcc.data+1]!)||avcc.end-p<4||b[p++]!==0xfd||b[p++]!==0xf8||b[p++]!==0xf8)return fail();const ext=b[p++]!;for(let n=0;n<ext;n++){if(p+2>avcc.end)return fail();const size=b.readUInt16BE(p);p+=2;if(!size||p+size>avcc.end||(b[p]!&31)!==13)return fail();p+=size;}}
      if(p!==avcc.end)return fail();
      const tkhd=one(ts,'tkhd');if(tkhd.end-tkhd.data<84||b[tkhd.data]!==0)return fail();const w=b.readUInt32BE(tkhd.end-8),h=b.readUInt32BE(tkhd.end-4);if(w!==width*65536||h!==height*65536)return fail();
      result={durationSeconds:Number(duration)/scale,width,height};
    }else {if(entry.type!=='mp4a'||entry.end-entry.data<28||b.readUInt16BE(entry.data+8)!==0)return fail();aacConfiguration(b,entry);}
    const stsz=one(st,'stsz'),sp=full(b,stsz,12),uniform=b.readUInt32BE(sp),sampleCount=b.readUInt32BE(sp+4);if(!sampleCount||sampleCount>1000000||stsz.end!==sp+8+(uniform?0:sampleCount*4))return fail();
    const sizes=Array.from({length:sampleCount},(_,i)=>uniform||b.readUInt32BE(sp+8+i*4));if(sizes.some(n=>!n||n>MAX))return fail();
    const stts=one(st,'stts'),tp=full(b,stts,8),times=b.readUInt32BE(tp);if(!times||stts.end!==tp+4+times*8)return fail();let samples=0,ticks=0n;for(let i=0;i<times;i++){const n=b.readUInt32BE(tp+4+i*8),delta=b.readUInt32BE(tp+8+i*8);if(!n||!delta)return fail();samples+=n;ticks+=BigInt(n)*BigInt(delta);}if(samples!==sampleCount||ticks!==duration)return fail();
    const chunkBoxes=st.filter(x=>x.type==='stco'||x.type==='co64');if(chunkBoxes.length!==1)return fail();const chunkBox=chunkBoxes[0]!,cp=full(b,chunkBox,8),chunks=b.readUInt32BE(cp),step=chunkBox.type==='stco'?4:8;if(!chunks||chunks>sampleCount||chunkBox.end!==cp+4+chunks*step)return fail();
    const sc=one(st,'stsc'),scp=full(b,sc,8),entriesCount=b.readUInt32BE(scp);if(!entriesCount||entriesCount>chunks||sc.end!==scp+4+entriesCount*12)return fail();const map=Array.from({length:entriesCount},(_,i)=>({first:b.readUInt32BE(scp+4+i*12),count:b.readUInt32BE(scp+8+i*12),desc:b.readUInt32BE(scp+12+i*12)}));if(map[0]!.first!==1||map.some((x,i)=>!x.count||x.desc!==1||x.first>chunks||(i>0&&x.first<=map[i-1]!.first)))return fail();
    let sample=0,mapping=0;for(let c=1;c<=chunks;c++){if(mapping+1<map.length&&c===map[mapping+1]!.first)mapping++;const count=map[mapping]!.count;if(sample+count>sampleCount)return fail();const raw=step===4?BigInt(b.readUInt32BE(cp+4+(c-1)*step)):b.readBigUInt64BE(cp+4+(c-1)*step);if(raw>BigInt(b.length))return fail();const start=Number(raw);let end=start;for(let n=0;n<count;n++){
      const sampleEnd=end+sizes[sample++]!;
      if(handler==='vide') {let p=end;while(p<sampleEnd){if(p+4>sampleEnd||p+4>b.length)return fail();const length=b.readUInt32BE(p);p+=4;if(!length||length>sampleEnd-p||p+length>b.length||(b[p]!&128)||(b[p]!&31)===0||(b[p]!&31)>23)return fail();p+=length;}}
      end=sampleEnd;
    }if(!mdats.some(x=>start>=x.data&&end<=x.end))return fail();ranges.push([start,end]);}if(sample!==sampleCount)return fail();
  }
  ranges.sort((a,c)=>a[0]-c[0]);if(ranges.some((r,i)=>i>0&&r[0]<ranges[i-1]![1])||!result)return fail();return result;
}

/** Container framing and declared metadata only, never decoded media or an
 * audibility/playability claim. Conservative Ogg Opus mapping-family 0 and
 * unfragmented local-data AVC MP4 subset. No files, network or subprocesses.
 * Sources: RFC 7845/6716; Apple QuickTime File Format; Telegram sendVideoNote. */
export function inspectStandingMediaProfile(input:{kind:'voice'|'video'|'round-video';mimeType:string;bytes:Buffer}):StandingMediaProfile{
  const data=record(input,['kind','mimeType','bytes'],['kind','mimeType','bytes']);const bytes=copy(data.bytes);
  try{
    let metadata:{durationSeconds:number;width?:number;height?:number};
    if(data.kind==='voice'&&data.mimeType==='audio/ogg')metadata={durationSeconds:oggDuration(bytes)};
    else if((data.kind==='video'||data.kind==='round-video')&&data.mimeType==='video/mp4')metadata=mp4Metadata(bytes);
    else return fail();
    if(!Number.isFinite(metadata.durationSeconds)||metadata.durationSeconds<=0||metadata.durationSeconds>86400||(data.kind==='round-video'&&(metadata.width!==metadata.height||metadata.durationSeconds>60)))return fail();
    return Object.freeze({version:'standing-media-profile-v1',kind:data.kind as StandingMediaProfile['kind'],mimeType:data.mimeType as StandingMediaProfile['mimeType'],byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...metadata});
  }catch{return fail();}finally{bytes.fill(0);}
}
/** Reinspect bytes before accepting a persisted/untrusted descriptor. */
export function validateStandingMediaProfile(value:unknown,bytes:Buffer,mimeType:string):StandingMediaProfile{
  const data=record(value,['version','kind','mimeType','sha256','byteLength','durationSeconds','width','height'],['version','kind','mimeType','sha256','byteLength','durationSeconds']);
  const proof=inspectStandingMediaProfile({kind:data.kind as StandingMediaProfile['kind'],mimeType,bytes});
  if(Object.keys(data).length!==Object.keys(proof).length||Object.entries(proof).some(([k,v])=>data[k]!==v))return fail();return proof;
}

export type StandingMediaWire=Readonly<{kind:StandingMediaProfile['kind'];durationSeconds:number;width?:number;height?:number}>;
export function mediaProfileWire(profile:StandingMediaProfile):StandingMediaWire {
  return Object.freeze({kind:profile.kind,durationSeconds:profile.kind==='voice'?Math.ceil(profile.durationSeconds):profile.durationSeconds,
    ...(profile.kind==='voice'?{}:{width:profile.width!,height:profile.height!})});
}
