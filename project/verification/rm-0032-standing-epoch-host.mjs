// Public source preparation only; no launch occurs on import or preparePacket.
// The managed owner starts the prepared child and owns every private turn.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {types} from 'node:util';

const sha=value=>createHash('sha256').update(value).digest('hex');
function dataRecord(value,keys){
  assert.ok(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  assert.deepEqual(Reflect.ownKeys(descriptors).sort(),[...keys].sort());
  const result={};
  for(const key of keys){
    const descriptor=descriptors[key];
    assert.ok(descriptor&&descriptor.enumerable&&Object.hasOwn(descriptor,'value'));
    result[key]=descriptor.value;
  }
  return Object.freeze(result);
}
const prepared=new WeakSet();
const SOURCE_CAP=262144,EXECUTABLE_CAP=120000;
// Capacity for the pinned public source bundle only. New tool definitions and
// observers exceed the old 256KiB decoded bundle. Model/wire/executable caps
// remain unchanged; decoding still stops at this explicit bound.
const PUBLIC_BUNDLE_CAP=393216;
const PARALLEL_PUBLIC_BUNDLE_CAP=524288;
export const SOURCE_NAMES=Object.freeze({
  custody:'rm-0032-managed-custody-client.py',canary:'rm-0032-astra-canary-client.py',
  native:'rm-0032-native-conversation.py',rpc:'rm-0032-native-rpc.py',collector:'rm-0032-native-image-collector.py',
  epoch:'rm-0032-native-image-epoch.py',session:'rm-0032-native-epoch-session.py',epochRpc:'rm-0032-native-epoch-rpc.py',
  managedRpc:'rm-0032-native-epoch-managed-rpc.py',idleValidator:'rm-0032-native-epoch-idle.py',
  client:'rm-0032-standing-epoch-client.py',wire:'rm-0032-native-epoch-wire.py',
  bridge:'rm-0032-standing-epoch-supervisor.py',supervisor:'rm-0032-managed-custody-supervisor.py',relay:'rm-0032-model-egress-relay.py',
});
export const SOURCE_PINS=Object.freeze({
  custody:'6a5f187c701708830b8556465ddea0142196250302a1062c6e343c3f7ba598e9',
  canary:'43e9422897b97ce4dc9aacd40494e94d89fd770ad84b9e6361666a6f70d3d967',
  native:'275ecba0707727ea876e9d0f1b4998f1fdedb4b9f5af28d01c96a56d1cbbd7e5',
  rpc:'2a7f04c392b7bc5cb81165c02e27f8d04ef6f400cb464bf3f91c378a8f23d720',
  collector:'7c9b3f3c11b9ba08399b6c63e1727dbfad7a25aa39e6d7294ba6a9ed2397ac76',
  epoch:'b308337ffb5dbd10fff6ffc6df95bed37b507c6d7428cab0d8810d9cbf4a9812',
  session:'45e7e3f3b6021385afdc66a61f7831de20302c14092d985f2e8aea7b8013134b',
  epochRpc:'66f8087f2db9c6b8f804ff30a98529c82acda17d7605e71e52fee2f4d6cc77b5',
  managedRpc:'41cfe0add7071561d941d301006b89ae55c105d064b793ab32b4a0858a125c95',
  idleValidator:'1255e5d9003cb68db7d08d4061073a44de4169fc507b905957890b9b4f7e0052',
  client:'459a07ab9ec4a395cfe1334dde7a41126c04866fc232c78babebcd1bc0b1c2bb',
  wire:'ffc597983104aadaf986e940edae7434960ae09451683dcafe3256d12740e96a',
  bridge:'cb3427af5e65bbcd26c3b5e57f319d7c3b6025dd3d22bb3b5f8d3e0144e48917',
  supervisor:'feb8522b2cfdd87c8121221b95287a1a5cb5c27938126b7fdfd5c097040639c0',
  relay:'c46f4136c37b1154b1e8178b3e5989844e1a2b47fb8e38e8a344361e5d077a7e',
});
export const PARALLEL_SOURCE_NAMES=Object.freeze({parallelPool:'history-parallel-native-pool.py',
  parallelAdapter:'history-parallel-native-adapter.py',parallelSession:'history-parallel-native-session.py',
  parallelClient:'history-parallel-native-client.py'});
export const PARALLEL_SOURCE_PINS=Object.freeze({parallelPool:'0596359b6e6e3fe6475ee293c3ef9ae9d9a17ce95860d2a32228bb6f00ad0e4e',parallelAdapter:'b4364205dc8794b079b8c4d1cd620e7a4b2169a968c1adc5a8b50aa0b47bb027',
  parallelSession:'edc898c1dd001aab502e9098dca862039f4b8060fb37b38508d4ae97cb0b591c',parallelClient:'4eb64245bee24977f174fcb3c825d39cd17dba4f0f8cc3c7a758ef1fbbad5545'});
const clientKeys=['custody','canary','native','rpc','collector','epoch','session','epochRpc','managedRpc','idleValidator'];
const pyString=value=>JSON.stringify(value); // Only ASCII public JSON/base64 enters these literals.
function compressed(value,cap=PUBLIC_BUNDLE_CAP){
  const raw=Buffer.from(JSON.stringify(value));assert.ok(raw.length>0&&raw.length<=cap);
  return {encoded:deflateSync(raw).toString('base64'),bytes:raw.length};
}
export function identity(token){
  assert.match(token,/^[a-f0-9]{32}$/u);
  const root='/run/decadans-standing-epoch-'+token;
  return Object.freeze({root,cwd:root+'/workspace',profile:'decadans-standing-epoch-'+token,
    relayUnit:'decadans-standing-epoch-relay-'+token+'.service',clientUnit:'decadans-standing-epoch-'+token+'.service'});
}
export function frameSource(source){
  const data=Buffer.from(source);assert.ok(data.length>0&&data.length<=SOURCE_CAP);
  const size=Buffer.alloc(4);size.writeUInt32BE(data.length);return Buffer.concat([size,Buffer.from(sha(data)),data]);
}
function clientCapsule(sources,pins,config,sessionMode,workProfile,parallelOptions){
  const parallel=sessionMode==='standing-parallel-epoch-v1',keys=parallel?[...clientKeys,...Object.keys(PARALLEL_SOURCE_NAMES)]:clientKeys;
  const cap=parallel?PARALLEL_PUBLIC_BUNDLE_CAP:PUBLIC_BUNDLE_CAP;
  const contents=Object.fromEntries(keys.map(k=>[k,sources[k]]));
  contents._client=sources.client;contents._wire=sources.wire;
  const selected=Object.fromEntries(keys.map(k=>[k,pins[k]]));selected._client=pins.client;selected._wire=pins.wire;
  const block=compressed(contents,cap),publicConfig=Object.fromEntries(['root','cwd','profile'].map(k=>[k,config[k]]));
  const source=`import base64,hashlib,json,zlib,sys
_d=zlib.decompressobj()
_raw=_d.decompress(base64.b64decode(${pyString(block.encoded)}),${cap+1})
assert len(_raw)<=${cap} and _d.eof and not _d.unused_data and not _d.unconsumed_tail
_sources=json.loads(_raw.decode('utf-8'))
_pins=json.loads(${pyString(JSON.stringify(selected))})
assert type(_sources) is dict and set(_sources)==set(_pins)
assert all(type(v) is str and hashlib.sha256(v.encode()).hexdigest()==_pins[k].lower() for k,v in _sources.items())
_wire={'__name__':'reviewed_epoch_wire'}
exec(compile(_sources.pop('_wire'),'<reviewed-epoch-wire>','exec'),_wire)
_client={'__name__':'reviewed_epoch_client'}
exec(compile(_sources.pop('_client'),'<reviewed-epoch-client>','exec'),_client)
_config=json.loads(${pyString(JSON.stringify(publicConfig))})
${parallel?`_parallel_options=json.loads(${pyString(JSON.stringify(parallelOptions))})
def worker_count(): return 1+_parallel_options['analysisWorkers']+int(_parallel_options['communityAssessment'])
`:''}def normalize_result(value): return _client['normalize_result'](value)
def wire_class(): return ${parallel?"__import__('functools').partial(_wire['NativeEpochWire'],parallel=True)":"_wire['NativeEpochWire']"}
if __name__=='__main__':
 _io=wire_class()(sys.stdin.fileno(),sys.stdout.fileno(),idle=_client['IDLE'])
 try: _value=_client['main'](_sources,_config,_io.receive,_io.emit${sessionMode===undefined?'':`,session_mode=${pyString(sessionMode)}`}${workProfile===undefined?'':`,work_profile=${pyString(workProfile)}`}${parallel?',parallel_options=_parallel_options':''})
 finally: _io.close()
 raise SystemExit(0 if _value['outcome']=='observed' else 1)
`;
  // The standing supervisor passes only BOOTSTRAP in argv. This capsule now
  // travels through the existing authenticated SOURCE_CAP frame on stdin.
  assert.ok(Buffer.byteLength(source)<=SOURCE_CAP);
  return {source,sha256:sha(source),decodedBytes:block.bytes};
}

export function preparePacket(input){
  assert.ok(input&&typeof input==='object'&&!types.isProxy(input));
  const hasMode=Object.hasOwn(input,'sessionMode');
  const hasProfile=Object.hasOwn(input,'workProfile');
  const hasParallel=Object.hasOwn(input,'parallelOptions');
  const captured=dataRecord(input,['sources','pins','token',...(hasMode?['sessionMode']:[]),...(hasProfile?['workProfile']:[]),...(hasParallel?['parallelOptions']:[])]);
  const sessionMode=hasMode?captured.sessionMode:undefined;
  if(hasMode)assert.ok(['standing-scoped-epoch-v1','standing-scoped-epoch-v2','standing-parallel-epoch-v1'].includes(sessionMode));
  const parallel=sessionMode==='standing-parallel-epoch-v1';assert.equal(hasParallel,parallel);
  const parallelOptions=parallel?dataRecord(captured.parallelOptions,['analysisWorkers','communityAssessment']):undefined;
  if(parallel)assert.ok(typeof parallelOptions.communityAssessment==='boolean'&&Number.isSafeInteger(parallelOptions.analysisWorkers)&&parallelOptions.analysisWorkers>=1&&parallelOptions.analysisWorkers<=7-Number(parallelOptions.communityAssessment));
  const workProfile=hasProfile?captured.workProfile:undefined;
  if(hasProfile)assert.ok(['team-assistant','community-team'].includes(workProfile));
  const sourceNames=parallel?{...SOURCE_NAMES,...PARALLEL_SOURCE_NAMES}:SOURCE_NAMES;
  const sourcePins=parallel?{...SOURCE_PINS,...PARALLEL_SOURCE_PINS}:SOURCE_PINS;
  const sources=dataRecord(captured.sources,Object.keys(sourceNames));
  const pins=dataRecord(captured.pins,Object.keys(sourceNames));
  const token=captured.token;
  for(const key of Object.keys(sourceNames)){
    assert.equal(typeof sources[key],'string');assert.match(pins[key],/^[a-f0-9]{64}$/u);
    assert.equal(sha(sources[key]),pins[key]);assert.equal(pins[key],sourcePins[key]);
  }
  const config=identity(token),client=clientCapsule(sources,pins,config,sessionMode,workProfile,parallelOptions);
  const outer={bridge:sources.bridge,supervisor:sources.supervisor,relay:sources.relay,client:client.source};
  const outerPins={bridge:pins.bridge,supervisor:pins.supervisor,relay:pins.relay,client:client.sha256};
  const block=compressed(outer);
  const source=`import base64,hashlib,json,zlib,asyncio
_d=zlib.decompressobj()
_raw=_d.decompress(base64.b64decode(${pyString(block.encoded)}),${PUBLIC_BUNDLE_CAP+1})
assert len(_raw)<=${PUBLIC_BUNDLE_CAP} and _d.eof and not _d.unused_data and not _d.unconsumed_tail
_sources=json.loads(_raw.decode('utf-8'))
_pins=json.loads(${pyString(JSON.stringify(outerPins))})
assert type(_sources) is dict and set(_sources)==set(_pins)
assert all(type(v) is str and hashlib.sha256(v.encode()).hexdigest()==_pins[k] for k,v in _sources.items())
_bridge={'__name__':'reviewed_standing_epoch_bridge'}
exec(compile(_sources['bridge'],'<reviewed-standing-epoch-bridge>','exec'),_bridge)
_config=json.loads(${pyString(JSON.stringify(config))})
_relay=_bridge['specialize_relay'](_sources['relay'],worker_count=${parallel?1+parallelOptions.analysisWorkers+Number(parallelOptions.communityAssessment):1})
_bundle={'client':{'source':_sources['client'],'sha256':_pins['client']},'relay':{'source':_relay,'sha256':hashlib.sha256(_relay.encode()).hexdigest()}}
_value=asyncio.run(_bridge['main'](_sources['supervisor'],_bundle,_config${parallel?`,session_mode=${pyString(sessionMode)}`:''}))
raise SystemExit(0 if _value['outcome']=='observed' else 1)
`;
  assert.ok(Buffer.byteLength(source)<=SOURCE_CAP);
  const match=sources.bridge.match(/BOOTSTRAP = """([\s\S]*?)"""/u);assert.ok(match&&Buffer.byteLength(match[1])<2048);
  const packet=Object.freeze({source,sourceSha256:sha(source),bootstrap:match[1],config,token,
    pins:Object.freeze({...pins}),clientSource:client.source,clientSourceSha256:client.sha256,
    clientDecodedBytes:client.decodedBytes,outerDecodedBytes:block.bytes,...(hasMode?{sessionMode}:{}),...(hasProfile?{workProfile}:{}),...(parallel?{parallelOptions}:{})});
  prepared.add(packet);return packet;
}
export function assertPrepared(packet){assert.ok(prepared.has(packet)&&sha(packet.source)===packet.sourceSha256);return packet;}
