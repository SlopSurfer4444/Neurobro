"""Opt-in outer gate and fake OS-port integration. No native process or network."""
import asyncio
import copy
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import types
import unittest

ROOT = Path(os.environ.get('EPOCH_SUPERVISOR_SOURCE_ROOT', Path(__file__).parent))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


m = load('parallel_supervisor_fixture', 'rm-0032-standing-epoch-supervisor.py')
client = load('parallel_client_schema_fixture', 'rm-0032-standing-epoch-client.py')


def proofs():
    return [dict(workerId='worker-' + str(i), processId=100 + i, purpose=purpose,
        custody=dict(initialize=True, profile=True, controlsPassed=True, relayAfter=False,
            probePass=[True]*9, probeExitCodes=[0,20,20,20,20,20,40,30,60], accountChatgpt=True, astraMedium=True),
        capabilities=dict(checked=True, imageGeneration=True, namespaceTools=False, webSearch=True))
        for i, purpose in enumerate(('conversation', 'history-analysis', 'history-analysis', 'community-assessment'))]


def pool_receipt():
    return dict(schema='history-parallel-native-pool-v1', epochRef='epoch-1', resourcesSettled=True,
        replacementReady=True, relaySettlementObserved=False,
        children=[dict(workerId=p['workerId'], processId=p['processId'], turnJoined=True,
            resourcesSettled=True, pendingBinding=None, pendingOutcome=None) for p in proofs()],
        budget=dict(turnStartDispatches=0, foregroundDispatches=0, turnsAdmitted=0, foregroundAdmissions=0,
            reservedReadBytes=0, reservedWriteBytes=0, closed=True))


def receipt():
    return dict(schema=m.PARALLEL_SCHEMA, outcome='observed', code='OK', stage='complete',
                injectedPorts=True, custodyChildren=proofs(), pool=pool_receipt())


def facts():
    return dict(threadStarted=False, poisoned=False, busy=False, turnsAttempted=0, toolCalls=0,
        schema='neurobro-native-image-epoch-v1', turnsAdmitted=0, turnLimit=16, epochSeconds=900,
        turnSeconds=300, running=False, releasePending=False, closed=True,
        resourceSettlementObserved=False, unreleasedTurn=False)


def worker_ready(proof):
    purpose = proof['purpose']
    names = ['neurobro_read_history'] if purpose == 'conversation' else [
        'neurobro_analysis_material', 'neurobro_analysis_notes', 'neurobro_analysis_commit'] if purpose == 'history-analysis' else []
    return dict(workerId=proof['workerId'], frame=dict(kind='ready', protocol=m.PARALLEL_MODE,
                scopes=[dict(purpose=purpose, tools=names)]))


def initial():
    return [dict(kind='poolCustodyReady', proof=proofs()),
        dict(kind='poolReady', protocol=m.PARALLEL_MODE,
            workers=[dict(workerId=p['workerId'], purpose=p['purpose']) for p in proofs()]),
        *[worker_ready(p) for p in proofs()]]


def final(value=None):
    value = value or receipt()
    return [*[dict(workerId=p['workerId'], frame=dict(kind='closed', code='CLOSED', facts=facts())) for p in proofs()],
        dict(kind='poolClosed', protocol=m.PARALLEL_MODE, code='CLOSED', receipt=value['pool']),
        dict(kind='epochResult', receipt=value)]


def accept(gate, value):
    return gate.accept(value, len(m.encoded(value)) + 1)


def gate(ready=True):
    value = m.OutputGate(client.normalize_result, m.Budget(), session_mode=m.PARALLEL_MODE)
    if ready:
        for frame in initial(): accept(value, frame)
    return value


def scoped(worker, kind='scope', ref=None):
    proof = proofs()[worker]
    scope = dict(purpose=proof['purpose'], requestRef=ref or 'request-' + str(worker),
                 threadId='thread-' + str(worker), turnId='turn-' + str(worker), turnNumber=1)
    frame = dict(kind=kind, scope=scope)
    if kind == 'completed': frame.update(answer='bounded result', kindOfAnswer='text', toolCalls=0, toolRefusals=0)
    return dict(workerId=proof['workerId'], frame=frame)


class GateTests(unittest.TestCase):
    def test_explicit_mode_only_and_legacy_shapes_unchanged(self):
        old = m.OutputGate(client.normalize_result, m.Budget())
        with self.assertRaises(m.Refused): accept(old, initial()[0])
        for value in ({'kind':'custodyReady','proof':{}}, {'kind':'ready'}, {'kind':'closed','code':'CLOSED','facts':facts()}):
            with self.assertRaises(m.Refused): accept(gate(False), value)
        with self.assertRaises(m.Refused): m.OutputGate(client.normalize_result, m.Budget(), session_mode='parallel')

    def test_custody_requires_distinct_verified_children_and_exact_ready_roster(self):
        mutations = [lambda p: p[1].update(processId=p[0]['processId']),
            lambda p: p[1].update(workerId=p[0]['workerId']), lambda p: p[1].update(processId=True),
            lambda p: p[1]['custody'].update(relayAfter=True),
            lambda p: p[1]['custody']['probeExitCodes'].__setitem__(1, 0),
            lambda p: p[1]['custody'].update(accountChatgpt=False),
            lambda p: p[1].update(extra='private'), lambda p: p[1].update(purpose='conversation')]
        for mutate in mutations:
            p = proofs(); mutate(p)
            with self.assertRaises((m.Refused, ValueError)): accept(gate(False), dict(kind='poolCustodyReady', proof=p))
        g = gate(False); accept(g, initial()[0])
        bad = initial()[1]; bad['workers'].reverse()
        with self.assertRaises(m.Refused): accept(g, bad)

    def test_worker_modes_cannot_cross_purpose_or_tool_registry(self):
        for index, purpose, names in ((1,'conversation',['neurobro_read_history']),
                                      (1,'history-analysis',['neurobro_read_history']),
                                      (3,'community-assessment',['neurobro_analysis_commit'])):
            g=gate(False)
            for frame in initial()[:2]: accept(g,frame)
            value=worker_ready(proofs()[index]); value['frame']['scopes']=[dict(purpose=purpose,tools=names)]
            with self.assertRaises(m.Refused): accept(g,value)

    def test_interleaved_worker_scopes_complete_and_release_independently(self):
        g=gate()
        for i in (1,2,0): accept(g,scoped(i))
        for i in (2,0,1): accept(g,scoped(i,'completed'))
        for i in (0,2,1):
            p=proofs()[i]
            accept(g,dict(workerId=p['workerId'],frame=dict(kind='released',purpose=p['purpose'],
                requestRef='request-'+str(i),delivery='verified' if i==0 else 'not-sent')))
        for value in final(): accept(g,value)
        self.assertEqual(g.receipt,receipt())
        self.assertFalse(g.receipt['pool']['relaySettlementObserved'])

    def test_wrong_request_images_and_completion_order_refuse(self):
        cases=[]
        g=gate(); accept(g,scoped(1)); cases.append((g,scoped(1,'completed','other')))
        g=gate(); cases.append((g,scoped(1,'completed')))
        g=gate(); accept(g,scoped(1)); cases.append((g,dict(workerId='worker-1',frame=dict(kind='imageBegin'))))
        g=gate(); accept(g,scoped(1)); value=scoped(1,'completed'); value['frame']['kindOfAnswer']='image'; cases.append((g,value))
        for g,value in cases:
            with self.assertRaises(m.Refused): accept(g,value)

    def test_native_close_is_never_physical_settlement(self):
        g=gate(); native=final()[0]
        native['frame']['facts']['resourceSettlementObserved']=True
        with self.assertRaises(m.Refused): accept(g,native)
        g=gate()
        for value in final()[:4]: accept(g,value)
        self.assertIsNone(g.receipt); self.assertIsNone(g.closed)
        with self.assertRaises(m.Refused): accept(g,dict(kind='epochResult',receipt=receipt()))

    def test_pool_closed_requires_all_native_closed_and_exact_custody_binding(self):
        with self.assertRaises(m.Refused): accept(gate(),final()[-2])
        for change in ('processId','relaySettlementObserved','resourcesSettled'):
            g=gate()
            for value in final()[:4]: accept(g,value)
            value=final()[-2]
            if change=='processId': value['receipt']['children'][1]['processId']=999
            elif change=='relaySettlementObserved': value['receipt'][change]=True
            else: value['receipt']['children'][1][change]=False
            with self.assertRaises((m.Refused,ValueError)): accept(g,value)

    def test_final_receipt_cannot_change_published_proofs_or_pool(self):
        for change in ('custody','budget'):
            g=gate()
            for frame in final()[:-1]: accept(g,frame)
            value=receipt()
            if change=='custody': value['custodyChildren'][0]['capabilities']['namespaceTools']=True
            else: value['pool']['budget']['reservedReadBytes']=65536
            with self.assertRaises(m.Refused): accept(g,dict(kind='epochResult',receipt=value))

    def test_failed_startup_retains_partial_pool_without_claiming_ready(self):
        value=receipt(); value.update(outcome='unknown',code='CUSTODY_REFUSED',stage='custody',custodyChildren=[])
        value['pool']['children']=value['pool']['children'][:1]
        g=gate(False)
        accept(g,dict(kind='poolClosed',protocol=m.PARALLEL_MODE,code='NATIVE_UNKNOWN',receipt=value['pool']))
        accept(g,dict(kind='epochResult',receipt=value))
        self.assertFalse(g.ready); self.assertFalse(g.custody); self.assertEqual(g.receipt['outcome'],'unknown')

    def test_control_and_inner_frame_budgets_are_aggregate(self):
        g=gate(False)
        with self.assertRaises(m.Refused): g.accept(initial()[0],m.CONTROL_CAP+1)
        g=gate(); g.frames=m.FRAME_COUNT
        with self.assertRaises(m.Refused): accept(g,scoped(1))
        g=gate(); g.inner_bytes=m.INNER_CAP
        with self.assertRaises(m.Refused): accept(g,scoped(2))

    def test_observed_receipt_requires_native_turns_to_be_released(self):
        g=gate(); accept(g,scoped(1)); accept(g,scoped(1,'completed'))
        for frame in final()[:-1]: accept(g,frame)
        with self.assertRaises(m.Refused): accept(g,final()[-1])
        for key in ('poisoned','busy','running','releasePending','unreleasedTurn'):
            g=gate(); values=final(); values[0]['frame']['facts'][key]=True
            for frame in values[:-1]: accept(g,frame)
            with self.assertRaises(m.Refused): accept(g,values[-1])

    def test_analysis_tool_frame_is_bound_to_announced_registry(self):
        value=dict(workerId='worker-1',frame=dict(kind='tool',purpose='history-analysis',requestRef='request-1',
            callRef='call-1',name='neurobro_read_history',arguments={}))
        with self.assertRaises(m.Refused): accept(gate(),value)

    def test_authenticated_source_cap_and_specialized_bundle_cap_match_in_bytes(self):
        source=(ROOT/'rm-0032-managed-custody-supervisor.py').read_text(encoding='utf-8')
        config=dict(root='/run/decadans-standing-epoch-cap',cwd='/run/decadans-standing-epoch-cap/workspace',
            profile='decadans-standing-epoch-cap',relayUnit='decadans-standing-epoch-relay-cap.service',
            clientUnit='decadans-standing-epoch-client-cap.service')
        runtime=m.prepare_runtime(source,config)
        for size in (120000,m.SOURCE_CAP,m.SOURCE_CAP+1):
            text='#'+'a'*(size-1)
            bundle={k:dict(source=text,sha256=m.sha(text)) for k in ('client','relay')}
            if size<=m.SOURCE_CAP:
                self.assertEqual(len(m.source_frame(text)),size+68); runtime.validate_bundle(bundle)
            else:
                with self.assertRaises(m.Refused): m.source_frame(text)
                with self.assertRaises(runtime.Refused): runtime.validate_bundle(bundle)
        text='#'+'é'*(m.SOURCE_CAP//2)
        with self.assertRaises(runtime.Refused):
            runtime.validate_bundle({k:dict(source=text,sha256=m.sha(text)) for k in ('client','relay')})

    def test_parallel_capsule_is_pinned_explicit_and_has_its_own_decoded_cap(self):
        names={'custody':'rm-0032-managed-custody-client.py','canary':'rm-0032-astra-canary-client.py',
            'native':'rm-0032-native-conversation.py','rpc':'rm-0032-native-rpc.py',
            'collector':'rm-0032-native-image-collector.py','epoch':'rm-0032-native-image-epoch.py',
            'session':'rm-0032-native-epoch-session.py','epochRpc':'rm-0032-native-epoch-rpc.py',
            'managedRpc':'rm-0032-native-epoch-managed-rpc.py','idleValidator':'rm-0032-native-epoch-idle.py',
            'parallelPool':'history-parallel-native-pool.py','parallelAdapter':'history-parallel-native-adapter.py',
            'parallelSession':'history-parallel-native-session.py','parallelClient':'history-parallel-native-client.py'}
        sources={key:(ROOT/file).read_text(encoding='utf-8') for key,file in names.items()}
        source=(ROOT/'rm-0032-standing-epoch-client.py').read_text(encoding='utf-8')
        wire=(ROOT/'rm-0032-native-epoch-wire.py').read_text(encoding='utf-8')
        relay=(ROOT/'rm-0032-model-egress-relay.py').read_text(encoding='utf-8')
        config=dict(root='/run/decadans-standing-epoch-cap',cwd='/run/decadans-standing-epoch-cap/workspace',
            profile='decadans-standing-epoch-cap',relayUnit='decadans-standing-epoch-relay-cap.service',
            clientUnit='decadans-standing-epoch-client-cap.service')
        pins={key:m.sha(text) for key,text in {**sources,'_client':source,'_wire':wire}.items()}
        args=(relay,sources,source,wire,config,pins)
        with self.assertRaises(m.Refused): m.build_bundle(*args)
        kwargs=dict(session_mode=m.PARALLEL_MODE,work_profile='community-team',
                    parallel_options=dict(analysisWorkers=2,communityAssessment=True))
        bundle=m.build_bundle(*args,**kwargs)
        capsule=bundle['client']['source']
        loaded=m.load(capsule,'parallel_capsule_schema',bundle['client']['sha256'])
        self.assertEqual(loaded.worker_count(),4)
        self.assertEqual(loaded._parallel_options,kwargs['parallel_options'])
        self.assertIn('parallel_options=_parallel_options',capsule)
        runtime=m.prepare_runtime((ROOT/'rm-0032-managed-custody-supervisor.py').read_text(encoding='utf-8'),config)
        m.configure_parallel_task_limit(runtime,loaded.worker_count())
        self.assertIn('--property=TasksMax=256',runtime.unit_argv(runtime.CLIENT,'source'))
        self.assertIn('--property=TasksMax=64',runtime.unit_argv(runtime.RELAY,'source'))
        self.assertEqual(loaded.normalize_result(receipt()),receipt())
        self.assertEqual(set(loaded._sources),set(client.PINS)|set(client.PARALLEL_PINS))
        self.assertIn('len(_raw)<=524288',capsule)
        self.assertIn("session_mode='standing-parallel-epoch-v1'",capsule)
        wire_factory=loaded.wire_class()
        self.assertEqual(wire_factory.func.__name__,'NativeEpochWire')
        self.assertEqual(wire_factory.keywords,{'parallel':True})
        self.assertLessEqual(len(capsule.encode()),m.SOURCE_CAP)
        for options in ({'analysisWorkers':True,'communityAssessment':True},
                        {'analysisWorkers':7,'communityAssessment':True},
                        {'analysisWorkers':2,'communityAssessment':True,'extra':True}):
            with self.assertRaises(m.Refused): m.build_bundle(*args,**{**kwargs,'parallel_options':options})


class WireTests(unittest.IsolatedAsyncioTestCase):
    async def test_read_output_preserves_entire_multiplex_stream_and_receipt(self):
        frames=initial()+final(); raw=b''.join(m.encoded(f)+b'\n' for f in frames)
        reader=asyncio.StreamReader(); reader.feed_data(raw); reader.feed_eof(); seen=[]
        async def emit(value,_): seen.append(value); return True
        result,count=await m.read_output(reader,gate(False),emit)
        self.assertEqual(seen,frames); self.assertEqual(result,receipt()); self.assertEqual(count,len(raw))

    async def test_only_multiplex_foreground_visual_input_gets_large_cap(self):
        frame=dict(workerId='worker-0',frame=dict(kind='turn',purpose='conversation',requestRef='request-1',
            input='{}',images=[dict(mimeType='image/png',base64='A'*800000)]))
        self.assertEqual(m.input_frame_cap(frame),m.FRAME_CAP)
        self.assertEqual(m.input_frame_cap(frame,session_mode=m.PARALLEL_MODE),m.VISUAL_INPUT_FRAME_CAP)
        writes=[]
        class Writer:
            def write(self,raw): writes.append(raw)
            async def drain(self): pass
            def close(self): pass
        values=iter((frame,{'kind':'close'}))
        async def receive(_): return next(values)
        await m.forward_input(Writer(),receive,gate())
        self.assertEqual(m.decoded(writes[0]),frame)
        frame['frame']['purpose']='history-analysis'
        self.assertEqual(m.input_frame_cap(frame,session_mode=m.PARALLEL_MODE),m.FRAME_CAP)

    async def test_wrong_worker_purpose_or_work_never_written(self):
        valid=dict(workerId='worker-1',frame=dict(kind='turn',purpose='history-analysis',requestRef='request-1',input='{}'),
                   work=dict(taskRef='task',planRef='plan',workRef='work'))
        variants=[{**valid,'workerId':'absent'}, {k:v for k,v in valid.items() if k!='work'},
            {**valid,'frame':{**valid['frame'],'purpose':'conversation'}},
            {**valid,'work':{**valid['work'],'unexpected':True}}]
        class Writer:
            def write(self,_): raise AssertionError('invalid envelope reached pipe')
            def close(self): pass
        for value in variants:
            async def receive(_): return value
            with self.assertRaises(m.Refused): await m.forward_input(Writer(),receive,gate())

    async def test_eof_without_epoch_result_does_not_settle_pool(self):
        reader=asyncio.StreamReader()
        reader.feed_data(b''.join(m.encoded(f)+b'\n' for f in initial()+final()[:4])); reader.feed_eof()
        async def emit(*_): return True
        with self.assertRaises(m.Refused): await m.read_output(reader,gate(False),emit)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def fixture(self, *, child_unsettled=False, fail_emit=False):
        config=dict(root='/run/decadans-standing-epoch-parallel-fixture',
            cwd='/run/decadans-standing-epoch-parallel-fixture/workspace',
            profile='decadans-standing-epoch-parallel-fixture',
            relayUnit='decadans-standing-epoch-relay-parallel-fixture.service',
            clientUnit='decadans-standing-epoch-client-parallel-fixture.service')
        source=(ROOT/'rm-0032-managed-custody-supervisor.py').read_text(encoding='utf-8')
        runtime=m.prepare_runtime(source,config)
        runtime.os=types.SimpleNamespace(geteuid=lambda:0,chown=lambda *_:None)
        runtime.relay_identity_available=lambda:None
        runtime.ROOT=types.SimpleNamespace(exists=lambda:False,is_symlink=lambda:False,mkdir=lambda **_:None)
        runtime.BINARY=types.SimpleNamespace(lstat=lambda:types.SimpleNamespace(st_mode=stat.S_IFREG|0o555,
            st_uid=0,st_gid=0,st_size=258659424),open=lambda _:io.BytesIO(b'fixture'))
        runtime.BINARY_SHA=hashlib.sha256(b'fixture').hexdigest()
        runtime.Path=lambda _:types.SimpleNamespace(read_text=lambda:'header\n')
        # The real client schema runs only at import, with no main/run/process call.
        # Fake bootstrap transport captures this source without executing it.
        client_source=(ROOT/'rm-0032-standing-epoch-client.py').read_text(encoding='utf-8')+'\ndef worker_count(): return 4\n'
        relay_source='# synthetic unused relay source\n'*10
        bundle={k:dict(source=v,sha256=m.sha(v)) for k,v in (('client',client_source),('relay',relay_source))}
        value=receipt()
        if child_unsettled:
            value.update(outcome='unknown',code='SHUTDOWN_UNKNOWN',stage='shutdown')
            value['pool'].update(resourcesSettled=False,replacementReady=False)
            value['pool']['children'][1]['resourcesSettled']=False
        relay_receipt=dict(version=1,settled=True,counters=dict.fromkeys(
            ('accepted','over_limit','refused','connected','completed','failed','cancelled','internal_error'),0))
        units={}; launches=[]; observed=[]; inputs=asyncio.Queue()
        class Proc:
            def __init__(self,unit=None,payload=None):
                self.unit=unit; self.returncode=None; self.stdout=asyncio.StreamReader(); self.stderr=asyncio.StreamReader()
                self.done=asyncio.Event(); self.stdin=Writer(self) if unit else None
                if payload is not None: self.stdout.feed_data(payload); self.finish()
            def send(self,frame): self.stdout.feed_data(m.encoded(frame)+b'\n')
            def finish(self,code=0):
                if self.returncode is None:
                    self.returncode=code; self.stdout.feed_eof(); self.stderr.feed_eof(); self.done.set()
            async def wait(self): await self.done.wait(); return self.returncode
            def kill(self): self.finish(-9)
        class Writer:
            def __init__(self,proc): self.proc=proc; self.bootstrap=True; self.closed=False
            def write(self,raw):
                assert not self.closed
                if self.bootstrap:
                    assert len(raw)==68+int.from_bytes(raw[:4],'big')
                    assert hashlib.sha256(raw[68:]).hexdigest().encode()==raw[4:68]
                    self.bootstrap=False
                    if self.proc.unit==runtime.RELAY: self.proc.send(dict(event='ready',version=1))
                    else:
                        for frame in initial(): self.proc.send(frame)
                else:
                    assert m.decoded(raw)=={'kind':'close'}
                    for frame in final(value): self.proc.send(frame)
                    self.proc.finish()
            async def drain(self): await asyncio.sleep(0)
            def close(self): self.closed=True
            async def wait_closed(self): assert self.closed
        def snapshot(unit):
            proc=units.get(unit)
            if proc is None or proc.returncode is not None:
                return dict(LoadState='not-found',ActiveState='inactive',MainPID='0')
            return dict(LoadState='loaded',ActiveState='active',MainPID='123',Description=runtime.DESCRIPTIONS[unit],
                        User=runtime.OWNERS[unit],Group=runtime.OWNERS[unit])
        async def spawn(*argv,**kwargs):
            if argv[0]=='/usr/bin/systemd-run':
                self.assertEqual(argv[-1],m.BOOTSTRAP)
                self.assertNotIn(client_source,argv)
                unit=next(x[len('--unit='):] for x in argv if x.startswith('--unit=')); launches.append(unit)
                self.assertIn('--property=TasksMax=256' if unit==runtime.CLIENT else '--property=TasksMax=64',argv)
                proc=Proc(unit); units[unit]=proc; return proc
            assert argv[0]=='/usr/bin/systemctl'
            if argv[1]=='show':
                return Proc(payload=''.join(k+'='+v+'\n' for k,v in snapshot(argv[2]).items()).encode())
            assert argv[1]=='stop'
            if argv[2]==runtime.RELAY: units[argv[2]].send(relay_receipt)
            units[argv[2]].finish(); return Proc(payload=b'')
        async def receive(seconds):
            try: return await asyncio.wait_for(inputs.get(),seconds)
            except TimeoutError: return m.IDLE
        async def emit(frame,_):
            observed.append(frame)
            if fail_emit and frame.get('kind')=='poolClosed': raise TimeoutError('synthetic downstream')
            if frame.get('workerId')=='worker-3' and frame['frame']['kind']=='ready':
                await inputs.put({'kind':'close'})
            return True
        result=await m.run_supervisor(source,bundle,config,receive,emit,
            {'runtime':lambda *_:runtime,'spawn':spawn,'clock':m.time.monotonic},session_mode=m.PARALLEL_MODE)
        return result,launches,observed,config

    async def test_same_outer_schema_and_exactly_one_client_and_relay(self):
        result,launches,observed,config=await self.fixture()
        self.assertEqual(launches,[config['relayUnit'],config['clientUnit']])
        self.assertEqual(result['schema'],'standing-epoch-supervisor-v1')
        self.assertEqual(result['outcome'],'observed')
        self.assertTrue(result['physicalCleanup']['complete'])
        self.assertEqual(result['client'],receipt())
        self.assertEqual(observed,initial()+final())
        self.assertFalse(result['client']['pool']['relaySettlementObserved'])
        self.assertTrue(result['relaySettled'])

    async def test_native_child_unsettled_stays_unknown_after_outer_cleanup(self):
        result,_,_,_=await self.fixture(child_unsettled=True)
        self.assertEqual(result['outcome'],'unknown')
        self.assertTrue(result['physicalCleanup']['complete'])
        self.assertTrue(result['allProcessesSettled'])
        self.assertFalse(result['client']['pool']['replacementReady'])

    async def test_parallel_outer_observed_cannot_omit_physical_cleanup(self):
        result,_,_,_=await self.fixture()
        without={k:v for k,v in result.items() if k!='physicalCleanup'}
        with self.assertRaises(m.Refused):
            m.normalize_result(without,client.normalize_result,lambda v:v)
        result['physicalCleanup'].update(stdoutEof=False,complete=False)
        with self.assertRaises(m.Refused):
            m.normalize_result(result,client.normalize_result,lambda v:v)

    async def test_failed_final_forwarding_never_promotes_observed(self):
        result,_,_,_=await self.fixture(fail_emit=True)
        self.assertEqual(result['outcome'],'unknown')
        self.assertIsNone(result['client'])
        self.assertTrue(result['physicalCleanup']['complete'])


if __name__ == '__main__': unittest.main()
