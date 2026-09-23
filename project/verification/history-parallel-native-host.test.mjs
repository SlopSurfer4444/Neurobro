import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {SOURCE_NAMES,SOURCE_PINS,PARALLEL_SOURCE_NAMES,PARALLEL_SOURCE_PINS,preparePacket,frameSource} from './rm-0032-standing-epoch-host.mjs';
const names={...SOURCE_NAMES,...PARALLEL_SOURCE_NAMES};
const sources=Object.fromEntries(Object.entries(names).map(([k,n])=>[k,readFileSync(new URL(n,import.meta.url),'utf8')]));
const pins=Object.fromEntries(Object.entries(sources).map(([k,s])=>[k,createHash('sha256').update(s).digest('hex')]));
const options={sources,pins,token:'1'.repeat(32),sessionMode:'standing-parallel-epoch-v1',workProfile:'community-team',parallelOptions:{analysisWorkers:2,communityAssessment:true}};

test('explicit pool options compose separately pinned sources under existing framed-source cap',()=>{
  assert.deepEqual(pins,{...SOURCE_PINS,...PARALLEL_SOURCE_PINS});
  const packet=preparePacket(options);
  assert.deepEqual(packet.parallelOptions,options.parallelOptions);
  assert.ok(packet.clientDecodedBytes<=524288&&Buffer.byteLength(packet.clientSource)<=262144);
  assert.ok(Buffer.byteLength(packet.source)<=262144&&Buffer.byteLength(packet.bootstrap)<2048);
  assert.match(packet.clientSource,/parallel_options=json.loads/u);
  assert.match(packet.source,/session_mode="standing-parallel-epoch-v1"/u);
  assert.throws(()=>frameSource('x'.repeat(262145)));
});

test('legacy cannot absorb parallel sources/options and worker count remains bounded',()=>{
  const {parallelOptions,...rest}=options;
  assert.throws(()=>preparePacket(rest));
  assert.throws(()=>preparePacket({...options,sessionMode:'standing-scoped-epoch-v2'}));
  for(const value of [{analysisWorkers:7,communityAssessment:true},{analysisWorkers:8,communityAssessment:false},
    {analysisWorkers:0,communityAssessment:true},{analysisWorkers:2,communityAssessment:1},
    {analysisWorkers:2,communityAssessment:true,model:'foreign'}])assert.throws(()=>preparePacket({...options,parallelOptions:value}));
});

test('actual capsule passes fixed profile and options to production entry without launching resources',()=>{
  const packet=preparePacket(options);
  const script=String.raw`import ast,json,sys,types
v=json.loads(sys.stdin.buffer.read());ns={'__name__':'fixture'}
exec(compile(v['source'],'<candidate-public-capsule>','exec'),ns)
seen=[]
class Wire:
 def __init__(self,*args,**kwargs):pass
 def receive(self,*args):raise AssertionError('no receive')
 def emit(self,*args):raise AssertionError('no emit')
 def close(self):pass
def main(*args,**kwargs):
 assert kwargs=={'session_mode':'standing-parallel-epoch-v1','work_profile':'community-team','parallel_options':{'analysisWorkers':2,'communityAssessment':True}}
 assert set(args[0])==set(ns['_client']['PINS'])|set(ns['_client']['PARALLEL_PINS'])
 ns['_client']['load_sources'](args[0],args[1],parallel=True)
 seen.append(True);return {'outcome':'observed'}
ns['_client']['main']=main;ns['wire_class']=lambda:Wire;ns['__name__']='__main__'
node=next(n for n in ast.parse(v['source']).body if isinstance(n,ast.If))
try:exec(compile(ast.Module(body=[node],type_ignores=[]),'<candidate-entry>','exec'),ns)
except SystemExit as e:assert e.code==0
assert seen==[True];print('{}')
`;
  const python=process.env.NEUROBRO_TEST_PYTHON??'python';
  const result=spawnSync(python,['-I','-S','-B','-c',script],{input:JSON.stringify({source:packet.clientSource}),encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});

test('actual outer and Python capsules bind the same four-worker relay budget before any launch',()=>{
  const packet=preparePacket(options);
  const script=String.raw`import ast,json,sys
v=json.loads(sys.stdin.buffer.read());ns={'__name__':'fixture'};body=[]
for node in ast.parse(v['outer']).body:
 if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='_value' for t in node.targets):break
 body.append(node)
exec(compile(ast.Module(body=body,type_ignores=[]),'<prepared-outer-without-launch>','exec'),ns)
relay=ns['_bridge']['load'](ns['_relay'],'actual_prepared_relay')
assert (relay.WORKER_COUNT,relay.MAX_ACCEPTED,relay.MAX_CONCURRENT)==(4,872,16)
client=ns['_bridge']['load'](v['sources']['client'],'client_schema')
keys=set(client.PINS)|set(client.PARALLEL_PINS)
deps={k:v['sources'][k] for k in keys};pins={k:v['pins'][k] for k in keys}
pins.update(_client=v['pins']['client'],_wire=v['pins']['wire'])
bundle=ns['_bridge']['build_bundle'](v['sources']['relay'],deps,v['sources']['client'],v['sources']['wire'],v['config'],pins,
 session_mode='standing-parallel-epoch-v1',work_profile='community-team',parallel_options={'analysisWorkers':2,'communityAssessment':True})
assert bundle['relay']['source']==ns['_relay']
runtime=ns['_bridge']['prepare_runtime'](v['sources']['supervisor'],v['config'])
service=relay.Relay();receipt={'version':1,'settled':True,'counters':service.counts,'diagnostics':service.diagnostics}
assert runtime.normalize_relay(receipt)==receipt
print(json.dumps({'outerBytes':len(v['outer'].encode()),'clientBytes':len(bundle['client']['source'].encode()),'maxAccepted':relay.MAX_ACCEPTED}))
`;
  const python=process.env.NEUROBRO_TEST_PYTHON??'python';
  const result=spawnSync(python,['-I','-S','-B','-c',script],{input:JSON.stringify({outer:packet.source,sources,pins,config:packet.config}),encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  const counts=JSON.parse(result.stdout);assert.ok(counts.outerBytes<=262144&&counts.clientBytes<=262144);assert.equal(counts.maxAccepted,872);
});
