"""Public source-only Linux fixture transport. No live runtime entry is called."""
import hashlib,json,pathlib,runpy,subprocess
HERE=pathlib.Path(__file__).parent
x=runpy.run_path(str(HERE/'rm-0032-standing-epoch-supervisor.test.py'))
m=x['m'];bundle=x['bundle']()
files={name:(HERE/name).read_bytes().decode() for name in ('rm-0032-standing-epoch-supervisor.py','rm-0032-standing-epoch-supervisor.test.py')}
files.update({'rm-0032-managed-custody-supervisor.py':x['SOURCE'],'rm-0032-model-egress-relay.py':x['RELAY']})
packet={'files':files,'pins':{k:m.sha(v) for k,v in files.items()},'capsule':bundle['client'],'names':x['NAMES']}
data=m.encoded(packet);assert len(data)<=262144
bootstrap=r'''import ast,asyncio,base64,hashlib,json,os,pathlib,runpy,sys,tempfile,threading,types,unittest,zlib
from unittest import mock
raw=sys.stdin.buffer.read(262145);assert len(raw)<=262144
p=json.loads(raw);assert set(p)=={'files','pins','capsule','names'}
assert set(p['files'])=={'rm-0032-standing-epoch-supervisor.py','rm-0032-standing-epoch-supervisor.test.py','rm-0032-managed-custody-supervisor.py','rm-0032-model-egress-relay.py'}
assert set(p['files'])==set(p['pins'])
assert all(len(v.encode())<=131072 and hashlib.sha256(v.encode()).hexdigest()==p['pins'][k] for k,v in p['files'].items())
c=p['capsule'];assert set(c)=={'source','sha256'} and len(c['source'].encode())<120000
assert hashlib.sha256(c['source'].encode()).hexdigest()==c['sha256']
nodes={n.targets[0].id:n.value for n in ast.parse(c['source']).body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name)}
payload=ast.literal_eval(nodes['_raw'].args[0].args[0]);pins=json.loads(ast.literal_eval(nodes['_pins'].args[0]))
d=zlib.decompressobj();rawsources=d.decompress(base64.b64decode(payload,validate=True),262145)
assert len(rawsources)<=262144 and d.eof and not d.unused_data and not d.unconsumed_tail
sources=json.loads(rawsources);assert set(sources)==set(pins)
assert all(hashlib.sha256(v.encode()).hexdigest()==pins[k].lower() for k,v in sources.items())
expected={'standing','custody','canary','native','rpc','collector','epoch','session','epochRpc','managedRpc','idleValidator'}
assert set(p['names'])==expected and set(sources)==expected|{'_client','_wire'}
with tempfile.TemporaryDirectory(prefix='neurobro-epoch-supervisor-fixture-') as directory:
 root=pathlib.Path(directory)
 for name,value in p['files'].items(): (root/name).write_bytes(value.encode())
 for key,value in sources.items():
  name='standing-epoch-client' if key=='_client' else 'native-epoch-wire' if key=='_wire' else p['names'][key]
  assert name and all(c in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name)
  (root/('rm-0032-'+name+'.py')).write_bytes(value.encode())
 os.environ['EPOCH_SUPERVISOR_SOURCE_ROOT']=directory
 os.environ['EPOCH_SUPERVISOR_CLIENT']=str(root/'rm-0032-standing-epoch-client.py')
 fixture=runpy.run_path(str(root/'rm-0032-standing-epoch-supervisor.test.py'))
 module=types.ModuleType('linux_supervisor_fixture');module.__dict__.update(fixture)
 suite=unittest.TestLoader().loadTestsFromModule(module)
 m=fixture['m']
 class LinuxPipes(unittest.TestCase):
  def test_actual_main_duplex_threads_and_final_record(self):
   inbound_r,inbound_w=os.pipe();outbound_r,outbound_w=os.pipe();observed=[];errors=[]
   def peer():
    try:
     os.write(inbound_w,b'{"kind":"close"}\n');os.close(inbound_w)
     with os.fdopen(outbound_r,'rb') as stream:
      observed.extend(json.loads(line) for line in stream)
    except BaseException as error:errors.append(type(error).__name__)
   thread=threading.Thread(target=peer);thread.start()
   async def run(*args,**kwargs):
    receive,emit=args[3:5]
    assert await receive(1)=={'kind':'close'}
    assert await receive(1) is None
    kwargs['budget'].close()
    assert await emit({'kind':'ready'},1) is True
    return m.result_template()
   try:
    with mock.patch.object(m,'run_supervisor',run),mock.patch.object(sys,'stdin',types.SimpleNamespace(fileno=lambda:inbound_r)),mock.patch.object(sys,'stdout',types.SimpleNamespace(fileno=lambda:outbound_w)):
     asyncio.run(m.main(fixture['SOURCE'],fixture['bundle'](),fixture['CONFIG']))
   finally:
    os.close(inbound_r);os.close(outbound_w);thread.join(2)
   assert not thread.is_alive() and not errors
   assert [v['kind'] for v in observed]==['ready','supervisorResult']
   assert observed[-1]['receipt']['outcome']=='unknown'
  def test_actual_fd_timeout_then_eof_are_distinct(self):
   capsule=m.load(c['source'],'linux_wire_fixture',c['sha256']);Wire=capsule.wire_class()
   r,w=os.pipe();out_r,out_w=os.pipe();idle=object();wire=Wire(r,out_w,idle=idle)
   try:
    assert wire.receive(.01) is idle
    os.close(w);w=None
    assert wire.receive(.1) is None
   finally:
    wire.close()
    for fd in (r,w,out_r,out_w):
     if fd is not None:os.close(fd)
 suite.addTests(unittest.TestLoader().loadTestsFromTestCase(LinuxPipes))
 result=unittest.TextTestRunner(verbosity=2).run(suite)
 assert result.wasSuccessful() and result.testsRun==19
'''
startup=subprocess.STARTUPINFO();startup.dwFlags|=subprocess.STARTF_USESHOWWINDOW;startup.wShowWindow=0
result=subprocess.run(['C:/Program Files/WSL/wsl.exe','--distribution','DecadansNeurobro','--user','root','--exec','/usr/bin/python3.12','-I','-S','-B','-c',bootstrap],input=data,capture_output=True,timeout=35,startupinfo=startup)
print(json.dumps({'schema':'standing-epoch-supervisor-linux-fixture-v1','packetBytes':len(data),'pins':packet['pins'],'capsuleHash':bundle['client']['sha256'],'exit':result.returncode}))
print(result.stdout.decode(errors='replace'));print(result.stderr.decode(errors='replace'))
assert result.returncode==0
