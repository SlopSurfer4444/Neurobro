import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {SOURCE_NAMES,SOURCE_PINS,preparePacket,assertPrepared,identity,frameSource} from './rm-0032-standing-epoch-host.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const sourceRoot=process.env.EPOCH_TEST_SOURCE_ROOT?pathToFileURL(process.env.EPOCH_TEST_SOURCE_ROOT.replace(/\\/gu,'/')+'/'):new URL('.',import.meta.url);
const sources=Object.fromEntries(Object.entries(SOURCE_NAMES).map(([key,name])=>[key,readFileSync(new URL(name,key==='client'?import.meta.url:sourceRoot),'utf8')]));
const pins=Object.fromEntries(Object.entries(sources).map(([key,source])=>[key,sha(source)]));
const token='0123456789abcdef0123456789abcdef';
const packet=preparePacket({sources,pins,token});
const python=process.env.NEUROBRO_TEST_PYTHON??'python';
function run(script,input){
  const value=spawnSync(python,['-I','-S','-B','-c',script],{input:JSON.stringify(input),encoding:'utf8',timeout:10000,maxBuffer:16384,windowsHide:true});
  assert.equal(value.error,undefined);assert.equal(value.status,0,value.stderr);
  return JSON.parse(value.stdout);
}

test('exact pinned source set composes one capped immutable packet and fixed identities',()=>{
  assert.deepEqual(pins,SOURCE_PINS);
  assert.equal(packet.token,token);assert.deepEqual(packet.config,identity(token));
  assert.equal(assertPrepared(packet),packet);
  assert.ok(Object.isFrozen(packet)&&Object.isFrozen(packet.config)&&Object.isFrozen(packet.pins));
  assert.ok(packet.clientDecodedBytes<=393216&&packet.outerDecodedBytes<=393216);
  assert.ok(Buffer.byteLength(packet.clientSource)<=262144&&Buffer.byteLength(packet.source)<=262144);
  assert.equal(packet.sourceSha256,sha(packet.source));assert.equal(packet.clientSourceSha256,sha(packet.clientSource));
  assert.throws(()=>assertPrepared({...packet}));
});

test('scoped mode is explicit in the pinned client capsule and cannot alter fixed process identities or bounds',()=>{
  const scoped=preparePacket({sources,pins,token,sessionMode:'standing-scoped-epoch-v1'});
  const assessed=preparePacket({sources,pins,token,sessionMode:'standing-scoped-epoch-v2'});
  assert.equal(scoped.sessionMode,'standing-scoped-epoch-v1');assert.equal(Object.hasOwn(packet,'sessionMode'),false);
  assert.deepEqual(scoped.config,packet.config);assert.deepEqual(scoped.pins,packet.pins);assert.notEqual(scoped.sourceSha256,packet.sourceSha256);
  assert.ok(scoped.clientDecodedBytes<=393216&&scoped.outerDecodedBytes<=393216);
  assert.ok(Buffer.byteLength(scoped.clientSource)<=262144&&Buffer.byteLength(scoped.source)<=262144);
  assert.deepEqual(assessed.config,packet.config);assert.equal(assessed.sessionMode,'standing-scoped-epoch-v2');
  assert.ok(Buffer.byteLength(assessed.clientSource)<=262144&&Buffer.byteLength(assessed.source)<=262144);
  const parsed=run(String.raw`
import ast,json,sys
value=json.loads(sys.stdin.read())
def mode(source):
 tree=ast.parse(source)
 calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Subscript) and isinstance(n.func.value,ast.Name) and n.func.value.id=='_client' and isinstance(n.func.slice,ast.Constant) and n.func.slice.value=='main']
 assert len(calls)==1 and len(calls[0].args)==4
 return {k.arg:ast.literal_eval(k.value) for k in calls[0].keywords}
print(json.dumps({'legacy':mode(value['legacy']),'scoped':mode(value['scoped']),'assessed':mode(value['assessed'])}))
`,{legacy:packet.clientSource,scoped:scoped.clientSource,assessed:assessed.clientSource});
  assert.deepEqual(parsed,{legacy:{},scoped:{session_mode:'standing-scoped-epoch-v1'},assessed:{session_mode:'standing-scoped-epoch-v2'}});
  for(const sessionMode of [undefined,null,false,'legacy','standing-scoped-epoch-v3'])assert.throws(()=>preparePacket({sources,pins,token,sessionMode}));
  let getters=0;const hostile={sources,pins,token};Object.defineProperty(hostile,'sessionMode',{get(){getters++;throw Error();},enumerable:true});
  assert.throws(()=>preparePacket(hostile));assert.equal(getters,0);
});

test('work profile is a fixed host option with compatible legacy and scoped capsules',()=>{
  for(const workProfile of ['team-assistant','community-team']){
  const team=preparePacket({sources,pins,token,workProfile});
  const scoped=preparePacket({sources,pins,token,workProfile,sessionMode:'standing-scoped-epoch-v1'});
  assert.equal(Object.hasOwn(packet,'workProfile'),false);assert.equal(team.workProfile,workProfile);
  assert.deepEqual(team.config,packet.config);assert.deepEqual(team.pins,packet.pins);
  for(const candidate of [team,scoped]){
    assert.ok(candidate.clientDecodedBytes<=393216&&candidate.outerDecodedBytes<=393216);
    assert.ok(Buffer.byteLength(candidate.clientSource)<=262144&&Buffer.byteLength(candidate.source)<=262144);
    assert.equal(assertPrepared(candidate),candidate);
  }
  const actual=run(String.raw`
import ast,json,sys
value=json.loads(sys.stdin.read())
def arguments(source):
 tree=ast.parse(source)
 calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Subscript) and isinstance(n.func.value,ast.Name) and n.func.value.id=='_client' and isinstance(n.func.slice,ast.Constant) and n.func.slice.value=='main']
 assert len(calls)==1
 return {k.arg:ast.literal_eval(k.value) for k in calls[0].keywords}
print(json.dumps({k:arguments(v) for k,v in value.items()}))
`,{legacy:packet.clientSource,team:team.clientSource,scoped:scoped.clientSource});
  assert.deepEqual(actual,{legacy:{},team:{work_profile:workProfile},scoped:{session_mode:'standing-scoped-epoch-v1',work_profile:workProfile}});
  }
  for(const workProfile of [undefined,null,false,{},'decadans','arbitrary prompt'])assert.throws(()=>preparePacket({sources,pins,token,workProfile}));
  let reads=0;const hostile={sources,pins,token};Object.defineProperty(hostile,'workProfile',{enumerable:true,get(){reads++;throw Error();}});
  assert.throws(()=>preparePacket(hostile));assert.equal(reads,0);
});

test('changed source and changed matching pin cannot enter a prepared packet',()=>{
  for(const key of Object.keys(sources)){
    const changed={...sources,[key]:sources[key]+'\n# modified'};
    assert.throws(()=>preparePacket({sources:changed,pins,token}));
    assert.throws(()=>preparePacket({sources:changed,pins:{...pins,[key]:sha(changed[key])},token}));
  }
  for(const value of ['',token+'x','../'+token,'A'.repeat(32)])assert.throws(()=>identity(value));
  assert.throws(()=>preparePacket({sources:{...sources,extra:''},pins,token}));
});

test('source/pin accessors and reentrant mutations cannot swap executable bootstrap after validation',()=>{
  let reads=0;
  for(const member of ['sources','pins']){
    const values={...(member==='sources'?sources:pins)};
    Object.defineProperty(values,'bridge',{enumerable:true,get(){reads++;return member==='sources'?sources.bridge:pins.bridge;}});
    assert.throws(()=>preparePacket({sources,pins,token,[member]:values}));
  }
  const input={sources,pins,token};
  Object.defineProperty(input,'sources',{enumerable:true,get(){reads++;return sources;}});
  assert.throws(()=>preparePacket(input));assert.equal(reads,0);
  const mutable={...sources};
  const proxy=new Proxy(mutable,{getOwnPropertyDescriptor(target,key){
    const descriptor=Reflect.getOwnPropertyDescriptor(target,key);
    if(key==='relay')target.bridge='BOOTSTRAP = """unreviewed"""';
    return descriptor;
  }});
  const captured=preparePacket({sources:proxy,pins,token});
  assert.equal(captured.sourceSha256,packet.sourceSha256);assert.equal(captured.bootstrap,packet.bootstrap);
  for(const modify of [v=>{v[Symbol('extra')]='x';},v=>Object.setPrototypeOf(v,{})]){
    const value={...sources};modify(value);assert.throws(()=>preparePacket({sources:value,pins,token}));
  }
});

test('Node and Python client capsules load the same pinned modules and bound configuration',()=>{
  const result=run(String.raw`
import sys,json,ast,hashlib,zlib,base64
v=json.loads(sys.stdin.buffer.read().decode('utf-8'))
bridge={'__name__':'fixture_bridge'}
exec(compile(v['sources']['bridge'],'<public-bridge>','exec'),bridge)
keys=['custody','canary','native','rpc','collector','epoch','session','epochRpc','managedRpc','idleValidator']
deps={k:v['sources'][k] for k in keys}
pins={k:v['pins'][k] for k in keys}
pins.update(_client=v['pins']['client'],_wire=v['pins']['wire'])
bundle=bridge['build_bundle'](v['sources']['relay'],deps,v['sources']['client'],v['sources']['wire'],v['config'],pins)
a={'__name__':'node_prepared'};b={'__name__':'python_prepared'}
exec(compile(v['client'],'<node-client>','exec'),a)
exec(compile(bundle['client']['source'],'<python-client>','exec'),b)
assert a['_sources']==b['_sources']==deps
assert a['_pins']==b['_pins']==pins
assert a['_config']==b['_config']=={k:v['config'][k] for k in ['root','cwd','profile']}
assert a['_client']['PINS']==b['_client']['PINS']
assert callable(a['normalize_result']) and a['wire_class']().__name__=='NativeEpochWire'
outer=ast.parse(v['outer'])
payload=outer.body[2].value.args[0].args[0].value
raw=zlib.decompress(base64.b64decode(payload));assert len(raw)<=393216
contents=json.loads(raw)
assert set(contents)=={'bridge','supervisor','relay','client'}
assert contents['client']==v['client']
assert all(contents[k]==v['sources'][k] for k in ['bridge','supervisor','relay'])
assert 'asyncio.run' in v['outer'] and "_bridge['main']" in v['outer']
print(json.dumps({'equivalent':True,'outerDecodedBytes':len(raw),'relayHash':bundle['relay']['sha256']}))
`,{sources,pins,config:packet.config,client:packet.clientSource,outer:packet.source});
  assert.equal(result.equivalent,true);assert.equal(result.outerDecodedBytes,packet.outerDecodedBytes);
  assert.match(result.relayHash,/^[a-f0-9]{64}$/u);
});

test('real bootstrap reads exactly its framed public source and preserves following duplex bytes',()=>{
  const source="import os,json\nprint(json.dumps({'remaining':os.read(0,4).decode('ascii')}))\n";
  const input=Buffer.concat([frameSource(source),Buffer.from('NEXT')]);
  const value=spawnSync(python,['-I','-S','-B','-c',packet.bootstrap],{input,encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true});
  assert.equal(value.error,undefined);assert.equal(value.status,0,value.stderr);assert.deepEqual(JSON.parse(value.stdout),{remaining:'NEXT'});
  const broken=Buffer.from(input);broken[4]=broken[4]===97?98:97;
  const refused=spawnSync(python,['-I','-S','-B','-c',packet.bootstrap],{input:broken,encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true});
  assert.notEqual(refused.status,0);assert.equal(refused.stdout,'');
});
