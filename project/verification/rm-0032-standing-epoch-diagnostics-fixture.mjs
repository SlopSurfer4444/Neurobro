// Source-only Linux fixtures. Compression bounds test sources, never model data.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
const mode=process.argv[2]??'--tests';assert.ok(['--tests','--receipts'].includes(mode));
const {REPOSITORY_TOOL_SPECS}=await import(new URL('../../packages/telegram-gateway/dist/src/standing-repository-tools.js',import.meta.url).href);
const {BOUND_ACTION_TOOL_SPECS}=await import(new URL('../../packages/telegram-gateway/dist/src/bound-action-tools.js',import.meta.url).href);
const {STANDING_ARTIFACT_TOOL_SPECS}=await import(new URL('../../packages/telegram-gateway/dist/src/standing-artifact-tools.js',import.meta.url).href);
const {HISTORY_TASK_TOOL_SPECS}=await import(new URL('../../packages/telegram-gateway/dist/src/standing-history-task-tools.js',import.meta.url).href);
const historyTaskSpecs=JSON.parse(JSON.stringify(HISTORY_TASK_TOOL_SPECS));
const repositorySpecs=JSON.parse(JSON.stringify(REPOSITORY_TOOL_SPECS));
const boundActionSpecs=JSON.parse(JSON.stringify(BOUND_ACTION_TOOL_SPECS));
const artifactSpecs=JSON.parse(JSON.stringify(STANDING_ARTIFACT_TOOL_SPECS));
const names=['standing-image-client','managed-custody-client','astra-canary-client','native-conversation','native-rpc','native-image-collector',
  'native-image-epoch','native-epoch-session','native-epoch-rpc','native-epoch-managed-rpc','native-epoch-idle','standing-epoch-client','standing-epoch-client.test','native-scoped-epoch.test','native-conversation.test','native-epoch-session.test'];
const files=names.map(n=>{const name='rm-0032-'+n+'.py',bytes=readFileSync(new URL('./'+name,import.meta.url));
  assert.ok(Buffer.from(bytes.toString('utf8')).equals(bytes));return{name,source:bytes.toString('utf8'),sha256:createHash('sha256').update(bytes).digest('hex')};});
const raw=Buffer.from(JSON.stringify({files,mode,repositorySpecs,boundActionSpecs,artifactSpecs,historyTaskSpecs}));assert.ok(raw.length<=589824);
const input=deflateSync(raw);assert.ok(input.length<=262144);
const bootstrap=`import copy,hashlib,json,os,pathlib,runpy,sys,tempfile,zlib,unittest,types
packed=sys.stdin.buffer.read(262145);assert len(packed)<=262144
d=zlib.decompressobj();raw=d.decompress(packed,589825)
assert len(raw)<=589824 and d.eof and not d.unused_data and not d.unconsumed_tail
p=json.loads(raw);assert set(p)=={'files','mode','repositorySpecs','boundActionSpecs','artifactSpecs','historyTaskSpecs'} and p['mode'] in {'--tests','--receipts'}
assert type(p['repositorySpecs']) is list and type(p['boundActionSpecs']) is list and type(p['artifactSpecs']) is list and type(p['historyTaskSpecs']) is list
os.environ['NEUROBRO_GENERATED_TOOL_SPECS']=json.dumps({'actions':p['boundActionSpecs'],'repository':p['repositorySpecs'],'artifacts':p['artifactSpecs'],'historyTasks':p['historyTaskSpecs']},separators=(',',':'))
expected=${JSON.stringify(names)}
expected={'rm-0032-'+n+'.py' for n in expected}
assert len(p['files'])==len(expected) and {f['name'] for f in p['files']}==expected
with tempfile.TemporaryDirectory(prefix='neurobro-epoch-idle-fixture-') as directory:
 for f in p['files']:
  assert set(f)=={'name','source','sha256'} and type(f['source']) is str
  data=f['source'].encode();assert len(data)<=131072 and hashlib.sha256(data).hexdigest()==f['sha256']
  pathlib.Path(directory,f['name']).write_bytes(data)
 x=runpy.run_path(str(pathlib.Path(directory,'rm-0032-standing-epoch-client.test.py')))
 if p['mode']=='--tests':
  module=types.ModuleType('epoch_client_diagnostics_fixture');module.__dict__.update(x)
  loader=unittest.TestLoader();suite=loader.loadTestsFromModule(module);count=suite.countTestCases()
  required={'test_native_failure_recorder_keeps_only_first_enumerated_bounded_fields','test_actual_scoped_engine_failure_survives_session_collapse_in_terminal_diagnostic'}
  assert required<=set(loader.getTestCaseNames(x['PortableTests'])) and count>=47
  result=unittest.TextTestRunner(verbosity=2).run(suite)
  assert result.wasSuccessful() and result.testsRun==count and not result.skipped
 else:
  records=[];case=x['ConnectedTests']()
  for mode in ('ok','not-reaped','cap-false','idle-stop','startup-warnings','startup-warning-invalid','startup-other','after-warning-invalid'):
   value,proc,frames=case.fixture(mode)
   records.append({'mode':mode,'result':value,'custodyFrame':next((f for f in frames if f['kind']=='custodyReady'),None)})
  original=next(v['result'] for v in records if v['mode']=='startup-warning-invalid');parity=[]
  for patch in ({'code':'DEADLINE_UNKNOWN'},{'site':'apps'},{'site':'mcp_status'},{'frames':513,'bytes':262145},{'frames':514},{'frames':True},{'bytes':262146},{'method':'private-future-method'},
                {'site':'private-path'},{'pendingResponses':5},{'raw':'private-data'}):
   value=copy.deepcopy(original);value['diagnostics']['idleFailure'].update(patch)
   try:x['c'].normalize_result(value);accepted=True
   except ValueError:accepted=False
   parity.append({'value':value,'accepted':accepted})
  print(json.dumps({'schema':'epoch-client-host-fixture-v1','records':records,'idleParity':parity},separators=(',',':')))
`;
const result=spawnSync('C:/Program Files/WSL/wsl.exe',['--distribution','DecadansNeurobro','--user','root','--exec','/usr/bin/python3.12','-I','-S','-B','-c',bootstrap],
  {input,timeout:40000,killSignal:'SIGKILL',maxBuffer:131072,windowsHide:true});
process.stdout.write(JSON.stringify({schema:'epoch-idle-linux-fixture-v1',sourceBytes:raw.length,compressedBytes:input.length,
  sources:files.map(({name,sha256})=>({name,sha256})),exit:result.status,signal:result.signal,error:result.error?.code??null})+'\n');
if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0);
