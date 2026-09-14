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
  native:'74aa6eff101109e99bc545299de08775baa8abde97f152d3bd818deca6e6ec5f',
  rpc:'2a7f04c392b7bc5cb81165c02e27f8d04ef6f400cb464bf3f91c378a8f23d720',
  collector:'7c9b3f3c11b9ba08399b6c63e1727dbfad7a25aa39e6d7294ba6a9ed2397ac76',
  epoch:'8cba8841bf10dca5ea8ea04feba29c75c3a1a0a4b1a8262ed0f7f5af15d44982',
  session:'ce4f0949269e4439d4940221d1a94f10ea90d23736274e2e6c849c47a5b325b8',
  epochRpc:'66f8087f2db9c6b8f804ff30a98529c82acda17d7605e71e52fee2f4d6cc77b5',
  managedRpc:'d115f1c8e18dc0fbc8cc9137ac0112d661f2ed8ea19555fc94d17f2818a38b9f',
  idleValidator:'2eb925f8cb3e872072f4d791f65ed06b1d8f478ba74cdc476004232a300aa776',
  client:'ae5cfc71a5fe8c5aa9f2e2caf8c6bc6fc1f2691801572fa1ee88ff75feff6ec9',
  wire:'c82ec2f2b97114d8980a9a41b8cc45107327eb691cfe18a583beec332ed497e4',
  bridge:'5af7b42d1fd8e602c60c2a653bfe93b8d24bfc7ad26b8fe522ffe20171af1d8f',
  supervisor:'feb8522b2cfdd87c8121221b95287a1a5cb5c27938126b7fdfd5c097040639c0',
  relay:'c46f4136c37b1154b1e8178b3e5989844e1a2b47fb8e38e8a344361e5d077a7e',
});
const clientKeys=['custody','canary','native','rpc','collector','epoch','session','epochRpc','managedRpc','idleValidator'];
const pyString=value=>JSON.stringify(value); // Only ASCII public JSON/base64 enters these literals.
function compressed(value){
  const raw=Buffer.from(JSON.stringify(value));assert.ok(raw.length>0&&raw.length<=PUBLIC_BUNDLE_CAP);
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
function clientCapsule(sources,pins,config,sessionMode){
  const contents=Object.fromEntries(clientKeys.map(k=>[k,sources[k]]));
  contents._client=sources.client;contents._wire=sources.wire;
  const selected=Object.fromEntries(clientKeys.map(k=>[k,pins[k]]));selected._client=pins.client;selected._wire=pins.wire;
  const block=compressed(contents),publicConfig=Object.fromEntries(['root','cwd','profile'].map(k=>[k,config[k]]));
  const source=`import base64,hashlib,json,zlib,sys
_d=zlib.decompressobj()
_raw=_d.decompress(base64.b64decode(${pyString(block.encoded)}),${PUBLIC_BUNDLE_CAP+1})
assert len(_raw)<=${PUBLIC_BUNDLE_CAP} and _d.eof and not _d.unused_data and not _d.unconsumed_tail
_sources=json.loads(_raw.decode('utf-8'))
_pins=json.loads(${pyString(JSON.stringify(selected))})
assert type(_sources) is dict and set(_sources)==set(_pins)
assert all(type(v) is str and hashlib.sha256(v.encode()).hexdigest()==_pins[k].lower() for k,v in _sources.items())
_wire={'__name__':'reviewed_epoch_wire'}
exec(compile(_sources.pop('_wire'),'<reviewed-epoch-wire>','exec'),_wire)
_client={'__name__':'reviewed_epoch_client'}
exec(compile(_sources.pop('_client'),'<reviewed-epoch-client>','exec'),_client)
_config=json.loads(${pyString(JSON.stringify(publicConfig))})
def normalize_result(value): return _client['normalize_result'](value)
def wire_class(): return _wire['NativeEpochWire']
if __name__=='__main__':
 _io=wire_class()(sys.stdin.fileno(),sys.stdout.fileno(),idle=_client['IDLE'])
 try: _value=_client['main'](_sources,_config,_io.receive,_io.emit${sessionMode===undefined?'':",session_mode='standing-scoped-epoch-v1'"})
 finally: _io.close()
 raise SystemExit(0 if _value['outcome']=='observed' else 1)
`;
  assert.ok(Buffer.byteLength(source)<EXECUTABLE_CAP);
  return {source,sha256:sha(source),decodedBytes:block.bytes};
}

export function preparePacket(input){
  assert.ok(input&&typeof input==='object'&&!types.isProxy(input));
  const hasMode=Object.hasOwn(input,'sessionMode');
  const captured=dataRecord(input,['sources','pins','token',...(hasMode?['sessionMode']:[])]);
  const sessionMode=hasMode?captured.sessionMode:undefined;
  if(hasMode)assert.equal(sessionMode,'standing-scoped-epoch-v1');
  const sources=dataRecord(captured.sources,Object.keys(SOURCE_NAMES));
  const pins=dataRecord(captured.pins,Object.keys(SOURCE_NAMES));
  const token=captured.token;
  for(const key of Object.keys(SOURCE_NAMES)){
    assert.equal(typeof sources[key],'string');assert.match(pins[key],/^[a-f0-9]{64}$/u);
    assert.equal(sha(sources[key]),pins[key]);assert.equal(pins[key],SOURCE_PINS[key]);
  }
  const config=identity(token),client=clientCapsule(sources,pins,config,sessionMode);
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
_relay=_bridge['specialize_relay'](_sources['relay'])
_bundle={'client':{'source':_sources['client'],'sha256':_pins['client']},'relay':{'source':_relay,'sha256':hashlib.sha256(_relay.encode()).hexdigest()}}
_value=asyncio.run(_bridge['main'](_sources['supervisor'],_bundle,_config))
raise SystemExit(0 if _value['outcome']=='observed' else 1)
`;
  assert.ok(Buffer.byteLength(source)<=SOURCE_CAP);
  const match=sources.bridge.match(/BOOTSTRAP = """([\s\S]*?)"""/u);assert.ok(match&&Buffer.byteLength(match[1])<2048);
  const packet=Object.freeze({source,sourceSha256:sha(source),bootstrap:match[1],config,token,
    pins:Object.freeze({...pins}),clientSource:client.source,clientSourceSha256:client.sha256,
    clientDecodedBytes:client.decodedBytes,outerDecodedBytes:block.bytes,...(hasMode?{sessionMode}:{})});
  prepared.add(packet);return packet;
}
export function assertPrepared(packet){assert.ok(prepared.has(packet)&&sha(packet.source)===packet.sourceSha256);return packet;}
