import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable, Duplex } from "node:stream";
import { createEpochWire, EpochWireError, EpochWireTimeout, EPOCH_FRAME_BYTES, EPOCH_TOTAL_BYTES } from "../src/standing-epoch-wire.js";

const row = (v: unknown) => Buffer.from(JSON.stringify(v)+"\n");
const tick = () => new Promise<void>(resolve=>setImmediate(resolve));
function fixture() {
  const readable = new PassThrough(), writable = new PassThrough(), faults: Error[] = [];
  readable.on("error",()=>{}); writable.on("error",()=>{});
  const wire = createEpochWire({readable,writable,onFault:e=>faults.push(e)});
  return {wire,readable,writable,faults,close(){wire.close();readable.destroy();writable.destroy();}};
}
test("fragmented multibyte UTF8 and many coalesced frames remain ordered",async()=>{
  const f=fixture();try {
    const bytes=row({text:"РџСЂРёРІРµС‚ рџ¦€"}); const pending=f.wire.receive(1000);
    for(const byte of bytes)f.readable.write(Buffer.from([byte]));
    assert.deepEqual(await pending,{text:"РџСЂРёРІРµС‚ рџ¦€"});
    f.readable.write(Buffer.concat(Array.from({length:20},(_,n)=>row({n}))));
    for(let n=0;n<20;n++)assert.deepEqual(await f.wire.receive(1000),{n});
  } finally {f.close();}
});
test("read timeout preserves partial frame and admits its later continuation",async()=>{
  const f=fixture();try {
    f.readable.write(Buffer.from('{"hello":'));
    await assert.rejects(f.wire.receive(10),e=>e instanceof EpochWireTimeout&&e.direction==="read");
    assert.equal(f.faults.length,0);f.readable.write(Buffer.from('"world"}\n'));
    assert.deepEqual(await f.wire.receive(100),{hello:"world"});
  } finally{f.close();}
});
test("clean EOF drains queued objects then reports eof without pretending close",async()=>{
  const f=fixture();try {
    f.readable.end(row({done:true}));await tick();
    assert.deepEqual(await f.wire.receive(100),{done:true});
    await assert.rejects(f.wire.receive(100),e=>e instanceof EpochWireError&&e.code==="eof");
    assert.equal(f.faults.length,0);
    f.writable.resume();await f.wire.send({stillWritable:true},100);
  } finally{f.close();}
});
test("sealed writes allow owned stdin finish and close without losing final frames or EOF",async()=>{
  const f=fixture();try {
    f.readable.write(row({final:true}));
    f.wire.sealWrites();f.wire.sealWrites();
    f.writable.end();await tick();f.writable.destroy();await tick();
    await assert.rejects(f.wire.send({late:true},100),/CLOSED/);
    assert.deepEqual(await f.wire.receive(100),{final:true});
    f.readable.end();await tick();
    await assert.rejects(f.wire.receive(100),e=>e instanceof EpochWireError&&e.code==="eof");
    assert.equal(f.faults.length,0);
  } finally{f.close();}
});
test("sealing preserves trailing extra frames and rejects partial EOF",async()=>{
  const f=fixture();try {
    f.wire.sealWrites();f.writable.end();await tick();
    f.readable.write(row({unexpected:true}));
    assert.deepEqual(await f.wire.receive(100),{unexpected:true});
    const pending=f.wire.receive(100);
    f.readable.end(Buffer.from('{"trailing":'));
    await assert.rejects(pending,e=>e instanceof EpochWireError&&e.code==="partial-eof");
  } finally{f.close();}
});
test("seal while a write is pending refuses without truncating or sealing it",async()=>{
  const f=fixture();try {
    const value={s:"a".repeat(200000)};
    const pending=f.wire.send(value,1000);
    assert.throws(()=>f.wire.sealWrites(),/CONCURRENT-WRITE/);
    const chunks:Buffer[]=[];f.writable.on("data",chunk=>chunks.push(chunk));
    await pending;assert.deepEqual(Buffer.concat(chunks),row(value));
    await f.wire.send({after:true},100);
    f.wire.sealWrites();assert.equal(f.faults.length,0);
  } finally{f.close();}
});
test("unsealed finish and actual writable errors after sealing remain fatal",async()=>{
  for(const sealed of [false,true]){
    const f=fixture();try {
      const pending=f.wire.receive(1000);
      if(sealed){f.wire.sealWrites();f.writable.destroy(new Error("private"));}
      else f.writable.end();
      await assert.rejects(pending,e=>e instanceof EpochWireError&&e.code==="write");
      assert.equal(f.faults.length,1);
    } finally{f.close();}
  }
});
test("EOF partial and premature readable close are fatal and sanitized",async()=>{
  for(const partial of [true,false]){
    const f=fixture();const pending=f.wire.receive(1000);
    if(partial)f.readable.end(Buffer.from('{"private":'));else f.readable.destroy();
    await assert.rejects(pending,e=>e instanceof EpochWireError&&e.code===(partial?"partial-eof":"read"));
    assert.equal(f.faults.length,1);assert.ok(!f.faults[0]!.message.includes("private"));f.close();
  }
});
test("noncanonical duplicate keys whitespace arrays primitives malformed UTF8 refused",async()=>{
  for(const bytes of [Buffer.from('{"a":1,"a":2}\n'),Buffer.from('{ "a":1}\n'),Buffer.from('[]\n'),Buffer.from('1\n'),Buffer.from('null\n'),Buffer.from('{"n":1.0}\n'),Buffer.from('\n'),Buffer.from([123,34,120,34,58,34,255,34,125,10])]){
    const f=fixture();const pending=f.wire.receive(100);f.readable.write(bytes);
    await assert.rejects(pending,e=>e instanceof EpochWireError&&e.code==="frame");assert.equal(f.faults.length,1);f.close();
  }
});
test("exact maximum frame passes and one byte larger faults before parsing",async()=>{
  for(const extra of [0,1]){
    const f=fixture();try {
      const value={s:"a".repeat(EPOCH_FRAME_BYTES-8+extra)},pending=f.wire.receive(1000);
      f.readable.write(row(value));
      if(extra)await assert.rejects(pending,e=>e instanceof EpochWireError&&e.code==="bounds");else assert.deepEqual(await pending,value);
    } finally{f.close();}
  }
});
test("queue frame count and byte budget refuse overflow even with coalesced read",async()=>{
  for(const bytes of [Buffer.concat(Array.from({length:33},()=>row({x:1}))),Buffer.concat(Array.from({length:5},()=>row({s:"a".repeat(700000)})))]){
    const f=fixture();f.readable.write(bytes);
    await assert.rejects(f.wire.receive(100),e=>e instanceof EpochWireError&&e.code==="bounds");assert.equal(f.faults.length,1);f.close();
  }
});
test("one pending receive and send independently; second same direction is nonfatal",async()=>{
  const f=fixture();try {
    const read=f.wire.receive(1000);await assert.rejects(f.wire.receive(100),/CONCURRENT-READ/);
    const write=f.wire.send({s:"a".repeat(200000)},1000);await assert.rejects(f.wire.send({two:true},100),/CONCURRENT-WRITE/);
    f.readable.write(row({incoming:true}));assert.deepEqual(await read,{incoming:true});
    f.writable.resume();await write;assert.equal(f.faults.length,0);
  } finally{f.close();}
});
test("actual duplex transports independent directions without a process",async()=>{
  let sent=Buffer.alloc(0);
  const duplex=new Duplex({read(){},write(chunk,_encoding,callback){sent=Buffer.concat([sent,chunk]);callback();}});
  const wire=createEpochWire({readable:duplex,writable:duplex});
  try {const r=wire.receive(100);await wire.send({out:true},100);duplex.push(row({in:true}));assert.deepEqual(await r,{in:true});assert.equal(sent.toString(),'{"out":true}\n');}
  finally{wire.close();duplex.destroy();}
});
test("backpressure send waits for drain and callback before succeeding",async()=>{
  const f=fixture();try {
    let settled=false;const write=f.wire.send({s:"a".repeat(200000)},1000).then(()=>{settled=true;});
    await tick();assert.equal(settled,false);f.writable.resume();await write;assert.equal(settled,true);
  } finally{f.close();}
});
test("write timeout is fatal/possibly partial and preserves stream-owned buffers",async()=>{
  const readable=new PassThrough();let retained:Buffer|undefined,finish:(()=>void)|undefined;
  const writable=new Writable({highWaterMark:1,write(bytes,_encoding,callback){retained=bytes;finish=()=>callback();}});
  writable.on("error",()=>{});const faults:Error[]=[];const wire=createEpochWire({readable,writable,onFault:e=>faults.push(e)});
  const pending=wire.receive(1000);const rejected=assert.rejects(pending,e=>e instanceof EpochWireTimeout&&e.direction==="write");
  await assert.rejects(wire.send({private:"payload"},10),e=>e instanceof EpochWireTimeout&&e.direction==="write");await rejected;
  assert.ok(retained!.includes(Buffer.from("payload")));assert.equal(faults.length,1);
  finish!();await tick();assert.ok(retained!.includes(Buffer.from("payload")));
  await assert.rejects(wire.send({retry:true},10),EpochWireTimeout);wire.close();readable.destroy();writable.destroy();
});
test("PassThrough may retain the submitted buffer after write callback; payload survives",async()=>{
  const f=fixture();try {
    await f.wire.send({text:"still queued downstream"},100);
    assert.equal(f.writable.read().toString(),'{"text":"still queued downstream"}\n');
  } finally{f.close();}
});
test("close rejects pending operations removes only owned listeners and never destroys streams",async()=>{
  const f=fixture();const own=()=>{};f.readable.on("data",own);const oldErrors=f.writable.listenerCount("error")-1;
  const read=assert.rejects(f.wire.receive(1000),/CLOSED/);
  const write=assert.rejects(f.wire.send({s:"a".repeat(200000)},1000),/CLOSED/);
  f.wire.close();await Promise.all([read,write]);
  assert.equal(f.readable.destroyed,false);assert.equal(f.writable.destroyed,false);
  assert.deepEqual(f.readable.listeners("data"),[own]);assert.equal(f.writable.listenerCount("error"),oldErrors);
  assert.equal(f.writable.listenerCount("drain"),0);assert.equal(f.faults.length,0);
  f.writable.resume();await tick();f.close();
});
test("write errors and throwing onFault are sanitized and do not escape callback",async()=>{
  const readable=new PassThrough();const writable=new Writable({write(_chunk,_encoding,callback){callback(new Error("PRIVATE"));}});
  const wire=createEpochWire({readable,writable,onFault(){throw Error("diagnostic");}});
  await assert.rejects(wire.send({x:1},100),e=>e instanceof EpochWireError&&e.code==="write");
  await tick();wire.close();readable.destroy();writable.destroy();
});
test("a synchronous error callback cannot race a true write return into success",async()=>{
  const readable=new PassThrough(),writable=new PassThrough();
  const port=writable as unknown as {write(bytes:Buffer,callback:(error:Error)=>void):boolean};
  port.write=(_bytes,callback)=>{callback(new Error("PRIVATE"));return true;};
  const wire=createEpochWire({readable,writable});
  await assert.rejects(wire.send({x:1},100),e=>e instanceof EpochWireError&&e.code==="write");
  wire.close();readable.destroy();writable.destroy();
});
test("write completion after its monotonic deadline cannot beat a delayed timer",async()=>{
  const readable=new PassThrough();
  const writable=new Writable({write(_bytes,_encoding,callback){const until=performance.now()+15;while(performance.now()<until){} callback();}});
  const wire=createEpochWire({readable,writable});
  await assert.rejects(wire.send({x:1},2),e=>e instanceof EpochWireTimeout&&e.direction==="write");
  wire.close();readable.destroy();writable.destroy();
});
test("invalid timeout and locally invalid frame do not consume working wire",async()=>{
  const f=fixture();try {
    for(const ms of [0,-1,1.5,NaN,Infinity])await assert.rejects(f.wire.receive(ms),/TIMEOUT-VALUE/);
    for(const value of [[],null,1])await assert.rejects(f.wire.send(value,100),/FRAME/);
    f.writable.resume();await f.wire.send({ok:true},100);assert.equal(f.faults.length,0);
  } finally{f.close();}
});
test("real transferred bytes enforce aggregate ingress and egress caps independently",async()=>{
  const f=fixture();f.writable.resume();
  const value={s:"a".repeat(EPOCH_FRAME_BYTES-8)}, bytes=row(value),allowed=Math.floor(EPOCH_TOTAL_BYTES/bytes.length);
  try {
    for(let i=0;i<allowed;i++){const received=f.wire.receive(2000);f.readable.write(bytes);await received;await f.wire.send(value,2000);}
    await assert.rejects(f.wire.send(value,2000),e=>e instanceof EpochWireError&&e.code==="bounds");
    const last=f.wire.receive(2000);f.readable.write(bytes);await assert.rejects(last,e=>e instanceof EpochWireError&&e.code==="bounds");
  } finally{f.close();}
});

test("large visual admission is outbound only and leaves ordinary bounds intact",async()=>{
 const f=fixture();try{
   let sent=0;f.writable.on("data",(chunk:Buffer)=>{sent+=chunk.length;});
   await f.wire.send({kind:"turn",requestRef:"photo",conversation:"Describe",images:[{mimeType:"image/png",base64:"A".repeat(11*1024*1024)}]},10000);
   assert.ok(sent>11*1024*1024);
 }finally{f.close();}
 for(const frame of [{kind:"toolResult",images:"A".repeat(EPOCH_FRAME_BYTES)}, {kind:"turn",conversation:"A".repeat(EPOCH_FRAME_BYTES)}]){
   const f=fixture();try{await assert.rejects(f.wire.send(frame,1000),EpochWireError);}finally{f.close();}
 }
});
