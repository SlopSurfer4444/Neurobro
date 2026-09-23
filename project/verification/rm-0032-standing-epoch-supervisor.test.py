"""Source/OS-port fixtures; no model, auth, systemd or remote egress calls."""
import asyncio
import ast
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import stat
import sys
import types
import unittest
import zlib
from unittest import mock

HERE = Path(__file__).parent
ROOT = Path(os.environ.get('EPOCH_SUPERVISOR_SOURCE_ROOT', str(HERE)))
CLIENT = Path(os.environ.get('EPOCH_SUPERVISOR_CLIENT', str(ROOT / 'rm-0032-standing-epoch-client.py')))
spec = importlib.util.spec_from_file_location('epoch_supervisor', ROOT / 'rm-0032-standing-epoch-supervisor.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SOURCE = (ROOT / 'rm-0032-managed-custody-supervisor.py').read_bytes().decode()
RELAY = (ROOT / 'rm-0032-model-egress-relay.py').read_bytes().decode()
WIRE = (ROOT / 'rm-0032-native-epoch-wire.py').read_bytes().decode()
CLIENT_SOURCE = CLIENT.read_bytes().decode()
client = m.load(CLIENT_SOURCE, 'client_fixture_schema')
NAMES = {'custody': 'managed-custody-client', 'canary': 'astra-canary-client',
         'native': 'native-conversation', 'rpc': 'native-rpc', 'collector': 'native-image-collector',
         'epoch': 'native-image-epoch', 'session': 'native-epoch-session', 'epochRpc': 'native-epoch-rpc',
         'managedRpc': 'native-epoch-managed-rpc', 'idleValidator': 'native-epoch-idle'}
SOURCES = {key: (ROOT / ('rm-0032-' + name + '.py')).read_bytes().decode() for key, name in NAMES.items()}
PINS = {key: m.sha(value) for key, value in {**SOURCES, '_client': CLIENT_SOURCE, '_wire': WIRE}.items()}
CONFIG = {'root': '/run/decadans-standing-epoch-fixture', 'cwd': '/run/decadans-standing-epoch-fixture/workspace',
          'profile': 'decadans-standing-epoch-fixture', 'relayUnit': 'decadans-standing-epoch-relay-fixture.service',
          'clientUnit': 'decadans-standing-epoch-client-fixture.service'}


def bundle(): return m.build_bundle(RELAY, SOURCES, CLIENT_SOURCE, WIRE, CONFIG, PINS)


def receipt():
    value = client.template()
    value.update(outcome='observed', code='OK', stage='complete')
    value['custody'].update(initialize=True, profile=True, controlsPassed=True, relayAfter=True,
        probePass=[True]*9, probeExitCodes=[0,20,20,20,20,20,40,30,60], accountChatgpt=True, astraMedium=True)
    value['capabilities'].update(checked=True, imageGeneration=True,webSearch=True)
    value['native'].update(admitted=True, threadStartDispatches=1, turnStartDispatches=1, threadAcknowledged=True)
    facts = {'threadStarted': True, 'poisoned': False, 'busy': False, 'turnsAttempted': 1, 'toolCalls': 1,
        'schema': 'neurobro-native-image-epoch-v1', 'turnsAdmitted': 1, 'turnLimit': 16,
        'epochSeconds': 900, 'turnSeconds': 300, 'running': False, 'releasePending': False,
        'closed': True, 'resourceSettlementObserved': False, 'unreleasedTurn': False}
    value['session'].update(custodyPublished=True, ready=True, closed=True, code='CLOSED', facts=facts)
    value['diagnostics'].update(originalCode='OK', originalStage='complete', rpcCode='OK')
    value['appServer'].update(launched=True, stdinClosed=True, stdoutEof=True, reaped=True, exitCode=0, stderrComplete=True)
    return client.normalize_result(value)


def custody_frame():
    value = receipt()
    return {'kind':'custodyReady', 'proof': {'custody':{**value['custody'], 'relayAfter':False}, 'capabilities':value['capabilities']}}


def limit_receipt(reason, turns):
    value = receipt()
    started = turns > 0
    value['native'].update(threadStartDispatches=int(started), turnStartDispatches=turns, threadAcknowledged=started)
    value['session']['code'] = 'TURN_LIMIT' if reason == 'turns' else 'EPOCH_LIMIT'
    value['session']['facts'].update(threadStarted=started, turnsAttempted=turns,
        turnsAdmitted=turns, toolCalls=0)
    return client.normalize_result(value)


class SourceTests(unittest.TestCase):
    def test_physical_cleanup_shape_legacy_and_nonvacuous_relationships(self):
        value=m.result_template()
        normalize=lambda v:m.normalize_result(v,lambda x:x,lambda x:x)
        legacy={k:v for k,v in value.items() if k!='physicalCleanup'}
        self.assertEqual(normalize(legacy),legacy)
        self.assertFalse(normalize(value)['physicalCleanup']['complete'])
        expected={'clientLaunchCaptured','relayLaunchCaptured','creationsJoined','ownershipKnown',
            'clientUnitAbsent','relayUnitAbsent','unitChecksAfterCreations','transportsJoined',
            'stdinClosed','stdoutEof','stderrEof','sessionTasksJoined','clientStopRequested',
            'relayStopRequested','transportKillRequested','complete'}
        self.assertEqual(set(value['physicalCleanup']),expected)
        good={**value,'clientExit':1,'relayExit':0,'allProcessesSettled':True,
            'physicalCleanup':{**value['physicalCleanup'],**dict.fromkeys(m.PHYSICAL_EVIDENCE,True),'complete':True}}
        self.assertEqual(normalize(good)['outcome'],'unknown')
        for key in m.PHYSICAL_EVIDENCE:
            bad={**good,'physicalCleanup':{**good['physicalCleanup'],key:False}}
            with self.assertRaises(m.Refused):normalize(bad)
        for changes in ({'extra':'private'},{'stdoutEof':1},{'complete':'true'}):
            with self.assertRaises(m.Refused):normalize({**good,'physicalCleanup':{**good['physicalCleanup'],**changes}})
        for changes in ({'clientExit':None},{'relayExit':None},{'allProcessesSettled':False}):
            with self.assertRaises(m.Refused):normalize({**good,**changes})

    def test_real_client_capsule_and_outer_boundary_fit_unchanged_caps(self):
        value = bundle()
        raw = m.encoded({**SOURCES, '_client':CLIENT_SOURCE, '_wire':WIRE})
        self.assertGreater(len(raw),262144)
        self.assertLessEqual(len(raw),393216)
        self.assertLessEqual(len(value['client']['source'].encode()),m.SOURCE_CAP)
        outer = m.encoded({'bridge':(ROOT/'rm-0032-standing-epoch-supervisor.py').read_bytes().decode(),
                          'supervisor':SOURCE,'bundle':value,'config':CONFIG})
        self.assertLessEqual(len(outer),262144)
        loaded = m.load(value['client']['source'],'capsule_fixture',value['client']['sha256'])
        self.assertEqual(loaded.normalize_result(receipt()),receipt())
        self.assertEqual(loaded.wire_class().__name__,'NativeEpochWire')
        self.assertEqual(loaded._client['PINS'],client.PINS)
        self.assertTrue(all(m.sha(loaded._sources[k]).upper()==v for k,v in client.PINS.items()))

    def test_decoded_public_bundle_boundaries_use_valid_pinned_synthetic_modules(self):
        wire='class NativeEpochWire: pass\n'
        def contents(a,b):
            dependencies={'a':'#'+'x'*a+'\n','b':'#'+'y'*b+'\n'}
            pins={key:m.sha(value) for key,value in dependencies.items()}
            source='PINS='+repr({key:value.upper() for key,value in pins.items()})+'\ndef normalize_result(value): return value\n'
            pins.update(_client=m.sha(source),_wire=m.sha(wire))
            return dependencies,source,pins
        empty,source,pins=contents(0,0)
        overhead=len(m.encoded({**empty,'_client':source,'_wire':wire}))
        for target in (262144,262145,393216,393217):
            extra=target-overhead;deps,source,pins=contents(extra//2,extra-extra//2)
            self.assertEqual(len(m.encoded({**deps,'_client':source,'_wire':wire})),target)
            if target>m.PUBLIC_BUNDLE_CAP:
                with self.assertRaises(m.Refused):m.build_bundle(RELAY,deps,source,wire,CONFIG,pins)
                continue
            value=m.build_bundle(RELAY,deps,source,wire,CONFIG,pins)
            loaded=m.load(value['client']['source'],'synthetic_capsule',value['client']['sha256'])
            self.assertEqual(loaded._sources,deps);self.assertEqual(loaded.normalize_result({'fixed':True}),{'fixed':True})
            self.assertLess(len(value['client']['source'].encode()),120000)
        deps,source,pins=contents(262144,0) # One source >262144 although aggregate <393216.
        with self.assertRaises(m.Refused):m.build_bundle(RELAY,deps,source,wire,CONFIG,pins)
        self.assertEqual(m.SOURCE_CAP,262144)

    def test_emitted_decoder_refuses_bomb_trailing_truncation_and_invalid_base64(self):
        capsule=bundle()['client']['source']
        end=capsule.index('_sources=json.loads(')
        prefix=capsule[:end]
        tree=ast.parse(prefix)
        payload=next(node.value for node in ast.walk(tree) if isinstance(node,ast.Constant) and isinstance(node.value,str))
        compressed=base64.b64decode(payload,validate=True)
        for data in (compressed[:-1],compressed+b'trailing',compressed+compressed,zlib.compress(b'x'*393217)):
            altered=prefix.replace(repr(payload),repr(base64.b64encode(data).decode()),1)
            with self.assertRaises((AssertionError,zlib.error)):exec(compile(altered,'<fixture-decoder>','exec'),{})
        altered=prefix.replace(repr(payload),repr(payload+'!'),1)
        with self.assertRaises(ValueError):exec(compile(altered,'<fixture-decoder>','exec'),{})

    def test_tampered_or_oversized_public_sources_refuse_without_cap_changes(self):
        with self.assertRaises(m.Refused):m.build_bundle(RELAY,SOURCES,CLIENT_SOURCE+'\n',WIRE,CONFIG,PINS)
        with self.assertRaises(m.Refused):m.specialize_relay(RELAY+'\n')
        with self.assertRaises(m.Refused):m.prepare_runtime(SOURCE+'\n',CONFIG)
        huge={**SOURCES,'native':SOURCES['native']+'#' * 262144}
        pins={**PINS,'native':m.sha(huge['native'])}
        with self.assertRaises(m.Refused):m.build_bundle(RELAY,huge,CLIENT_SOURCE,WIRE,CONFIG,pins)

    def test_exact_owned_unit_security_and_relay_profile(self):
        runtime=m.prepare_runtime(SOURCE,CONFIG)
        client_args=runtime.unit_argv(runtime.CLIENT,'source')
        relay_args=runtime.unit_argv(runtime.RELAY,'source')
        for item in ('--uid=20000','--gid=20000','--property=IPAddressDeny=any','--property=IPAddressAllow=127.0.0.2/32',
                     '--property=RuntimeMaxSec=1055s','--property=NoNewPrivileges=yes','--property=ProtectSystem=strict'):
            self.assertIn(item,client_args)
        self.assertIn('--uid=65534',relay_args)
        self.assertIn('--property=InaccessiblePaths='+runtime.AUTH,relay_args)
        relay=m.load(m.specialize_relay(RELAY),'relay_fixture')
        self.assertEqual((relay.MAX_LIFETIME,relay.MAX_TUNNEL_SECONDS,relay.IDLE_SECONDS),(1055,1055,300))
        self.assertEqual(relay.MAX_TUNNEL_BYTES,1024**3)
        self.assertEqual((relay.MAX_ACCEPTED,relay.MAX_CONCURRENT),(848,8))
        self.assertEqual(relay.AUTHORITIES,{'chatgpt.com:443':'chatgpt.com','auth.openai.com:443':'auth.openai.com'})
        self.assertIn('await asyncio.gather(*tasks, return_exceptions=True)\n            await self.server.wait_closed()',m.specialize_relay(RELAY))

    def test_parallel_task_limit_only_changes_client_task_population(self):
        baseline=m.prepare_runtime(SOURCE,CONFIG)
        original_client=baseline.unit_argv(baseline.CLIENT,'source')
        original_relay=baseline.unit_argv(baseline.RELAY,'source')
        self.assertIn('--property=TasksMax=64',original_client)
        self.assertIn('--property=TasksMax=64',original_relay)
        for workers in range(1,9):
            runtime=m.prepare_runtime(SOURCE,CONFIG)
            m.configure_parallel_task_limit(runtime,workers)
            self.assertEqual(runtime.unit_argv(runtime.CLIENT,'source'),
                ['--property=TasksMax=%d'%(64*workers) if v=='--property=TasksMax=64' else v for v in original_client])
            self.assertEqual(runtime.unit_argv(runtime.RELAY,'source'),original_relay)
        for workers in (0,9,-1,True,4.0,'4',None):
            with self.assertRaises(m.Refused):m.configure_parallel_task_limit(m.prepare_runtime(SOURCE,CONFIG),workers)

    def test_budget_does_not_renew_cleanup_or_exceed_original1055(self):
        now=[100.];budget=m.Budget(lambda:now[0])
        self.assertEqual(budget.remaining(9999),120)
        now[0]=219.;budget.admit_epoch();self.assertEqual(budget.end,1119.)
        now[0]=1100.;budget.close();self.assertEqual(budget.end,1135.)
        now[0]=1120.;budget.close();self.assertEqual(budget.end,1135.)
        now[0]=1135.
        with self.assertRaises(m.Refused):budget.remaining(1)
        now[0]=0.;budget=m.Budget(lambda:now[0]);now[0]=120.
        with self.assertRaises(m.Refused):budget.admit_epoch()

    def test_output_gate_exact_control_order_and_actual_tool_kind(self):
        gate=m.OutputGate(client.normalize_result,m.Budget())
        def accept(v):return gate.accept(v,len(m.encoded(v))+1)
        with self.assertRaises(m.Refused):accept({'kind':'ready'})
        gate=m.OutputGate(client.normalize_result,m.Budget())
        accept(custody_frame());accept({'kind':'ready'});accept({'kind':'tool','scope':{},'arguments':{}})
        with self.assertRaises(m.Refused):accept({'kind':'toolCall'})
        closed={'kind':'closed','code':'CLOSED','facts':receipt()['session']['facts']}
        accept(closed);accept({'kind':'epochResult','receipt':receipt()})
        with self.assertRaises(m.Refused):accept({'kind':'ready'})

    def test_output_gate_accepts_only_bounded_not_admitted_shape(self):
        def fresh():
            gate=m.OutputGate(client.normalize_result,m.Budget())
            gate.accept(custody_frame(),len(m.encoded(custody_frame()))+1)
            gate.accept({'kind':'ready'},len(m.encoded({'kind':'ready'}))+1)
            return gate
        for value in (
            {'kind':'notAdmitted','requestRef':'request-1','reason':'time','turnsAdmitted':0},
            {'kind':'notAdmitted','requestRef':'A'+'.:_-'*31,'reason':'turns','turnsAdmitted':16},
        ):
            with self.subTest(value=value):
                gate=fresh();original=m.encoded(value)
                self.assertIs(gate.accept(value,len(original)+1),value)
                self.assertEqual(m.encoded(value),original)
        invalid=(
            {'kind':'notAdmitted','requestRef':'request-1','reason':'time'},
            {'kind':'notAdmitted','requestRef':'request-1','reason':'time','turnsAdmitted':0,'extra':False},
            {'kind':'notAdmitted','requestRef':'','reason':'time','turnsAdmitted':0},
            {'kind':'notAdmitted','requestRef':'a'*129,'reason':'time','turnsAdmitted':0},
            {'kind':'notAdmitted','requestRef':'bad/ref','reason':'time','turnsAdmitted':0},
            {'kind':'notAdmitted','requestRef':'request-1','reason':'other','turnsAdmitted':0},
            {'kind':'notAdmitted','requestRef':'request-1','reason':'time','turnsAdmitted':True},
            {'kind':'notAdmitted','requestRef':'request-1','reason':'time','turnsAdmitted':-1},
            {'kind':'notAdmitted','requestRef':'request-1','reason':'turns','turnsAdmitted':17},
        )
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(m.Refused):fresh().accept(value,len(m.encoded(value))+1)
        with self.assertRaises(m.Refused):
            fresh().accept({'kind':'notAdmitted','requestRef':'request-1','reason':'time','turnsAdmitted':0},m.INNER_CAP+1)

    def test_not_admitted_then_clean_close_is_an_observed_normalized_receipt(self):
        for reason,turns in (('time',0),('time',5),('turns',16)):
            with self.subTest(reason=reason,turns=turns):
                expected=limit_receipt(reason,turns)
                gate=m.OutputGate(client.normalize_result,m.Budget())
                frames=(custody_frame(),{'kind':'ready'},
                    {'kind':'notAdmitted','requestRef':'request-limit','reason':reason,'turnsAdmitted':turns},
                    {'kind':'closed','code':expected['session']['code'],'facts':expected['session']['facts']},
                    {'kind':'epochResult','receipt':expected})
                for value in frames:gate.accept(value,len(m.encoded(value))+1)
                self.assertEqual(gate.receipt,expected)
                self.assertEqual(gate.receipt['outcome'],'observed')
                self.assertFalse(gate.receipt['session']['facts']['unreleasedTurn'])
                self.assertFalse(gate.receipt['session']['facts']['poisoned'])

    def test_named_ready_accepts_only_bounded_structural_registry_and_legacy(self):
        maximum=['neurobro_read_history']+['neurobro_x'+str(i) for i in range(31)]
        for value in ({'kind':'ready'}, {'kind':'ready','tools':['neurobro_read_history']},
                      {'kind':'ready','tools':list(client.TOOL_NAMES)}, {'kind':'ready','tools':maximum},
                      {'kind':'ready','tools':['neurobro_read_history','neurobro_z','neurobro_a']}):
            with self.subTest(value=value):
                gate=m.OutputGate(client.normalize_result,m.Budget())
                gate.accept(custody_frame(),len(m.encoded(custody_frame()))+1)
                original=m.encoded(value)
                self.assertIs(gate.accept(value,len(original)+1),value)
                self.assertEqual(m.encoded(value),original)
                self.assertTrue(gate.ready)
                with self.assertRaises(m.Refused):gate.accept(value,len(original)+1)
        invalid=[None,True,1,'neurobro_read_history',(),{},[],[True],[None],[1],[[]],
                 ['neurobro_other'],['neurobro_other','neurobro_read_history'],
                 ['neurobro_read_history']*2,maximum+['neurobro_over_limit']]
        invalid += [['neurobro_read_history',name] for name in
                    (False,{},'','neurobro_','neurobro_1bad','neurobro_Bad','neurobro_bad-name',
                     'neurobro_bad\n','neurobro_я','neurobro_a'+'x'*55)]
        for names in invalid:
            with self.subTest(names=names):
                gate=m.OutputGate(client.normalize_result,m.Budget())
                gate.accept(custody_frame(),1)
                with self.assertRaises(m.Refused):gate.accept({'kind':'ready','tools':names},1)
                self.assertFalse(gate.ready)
        for value in ({'kind':'ready','tools':['neurobro_read_history'],'extra':False},
                      {'kind':'ready','extra':False}):
            gate=m.OutputGate(client.normalize_result,m.Budget());gate.accept(custody_frame(),1)
            with self.assertRaises(m.Refused):gate.accept(value,1)
        named={'kind':'ready','tools':list(client.TOOL_NAMES)}
        gate=m.OutputGate(client.normalize_result,m.Budget())
        with self.assertRaises(m.Refused):gate.accept(named,1)


class ScopedOutputGateTests(unittest.TestCase):
    def ready(self, version=2):
        scopes=[{'purpose':'conversation','tools':list(client.TOOL_NAMES)},
            {'purpose':'history-analysis','tools':['neurobro_analysis_material','neurobro_analysis_notes','neurobro_analysis_commit']}]
        if version == 2: scopes.append({'purpose':'community-assessment','tools':[]})
        return {'kind':'ready','protocol':'standing-scoped-epoch-v'+str(version),'scopes':scopes}

    def gate(self, version=2):
        # Receipt normalization is endpoint-owned; isolate outer mode/schema closure.
        gate=m.OutputGate(lambda value:value,m.Budget())
        gate.accept(custody_frame(),1)
        gate.accept(self.ready(version),1)
        return gate

    def scope(self, purpose):
        return {'purpose':purpose,'requestRef':'req-1','threadId':'thread-1','turnId':'turn-1',
            'turnNumber':1,'threadTurnNumber':1}

    def test_v1_v2_ready_exact_registry_order_and_opt_in(self):
        for version in (1,2):
            gate=self.gate(version)
            self.assertEqual(gate.mode,'scoped-v2' if version == 2 else 'scoped')
            with self.assertRaises(m.Refused):gate.accept(self.ready(version),1)
        invalid=[]
        for version in (1,2):
            good=self.ready(version)
            invalid.extend([{**good,'protocol':'standing-scoped-epoch-v3'},
                {**good,'protocol':'standing-scoped-epoch-v'+str(3-version)},
                {**good,'scopes':good['scopes'][::-1]},
                {**good,'scopes':good['scopes']+[good['scopes'][0]]}])
        for tools in (None,(),{},False,['neurobro_read_history'],['neurobro_analysis_material']):
            good=self.ready()
            good['scopes'][2]['tools']=tools
            invalid.append(good)
        for purpose in ('history-analysis','conversation','community-assessment ',None):
            good=self.ready();good['scopes'][2]['purpose']=purpose;invalid.append(good)
        for value in invalid:
            with self.subTest(value=value):
                gate=m.OutputGate(lambda value:value,m.Budget());gate.accept(custody_frame(),1)
                with self.assertRaises(m.Refused):gate.accept(value,1)
                self.assertFalse(gate.ready)

    def test_v2_nonconversation_text_release_and_conversation_images(self):
        for version in (1,2):
            purposes=('conversation','history-analysis')+ (('community-assessment',) if version == 2 else ())
            for purpose in purposes:
                with self.subTest(version=version,purpose=purpose):
                    gate=self.gate(version);scope=self.scope(purpose)
                    gate.accept({'kind':'scope','scope':scope},1)
                    if purpose == 'conversation':
                        for kind in ('imageBegin','imageChunk','imageEnd'):gate.accept({'kind':kind},1)
                    if purpose != 'community-assessment':
                        gate.accept({'kind':'tool','purpose':purpose,'requestRef':'req-1','callRef':'call-1',
                            'name':'neurobro_read_history','arguments':{}},1)
                    gate.accept({'kind':'completed','scope':scope,'answer':'bounded result','kindOfAnswer':'text',
                        'toolCalls':0,'toolRefusals':0},1)
                    gate.accept({'kind':'released','purpose':purpose,'requestRef':'req-1',
                        'delivery':'sent' if purpose == 'conversation' else 'not-sent'},1)
                    self.assertIsNone(gate.active_scope)

    def test_v2_community_tools_images_and_nonconversation_writes_refused(self):
        for purpose in ('history-analysis','community-assessment'):
            invalid=[{'kind':kind} for kind in ('imageBegin','imageChunk','imageEnd')]
            invalid += [{'kind':'completed','scope':self.scope(purpose),'answer':'image','kindOfAnswer':'image',
                'toolCalls':0,'toolRefusals':0}]
            invalid += [{'kind':'released','purpose':purpose,'requestRef':'req-1','delivery':delivery}
                for delivery in ('sent','unknown',None)]
            if purpose == 'community-assessment':
                invalid += [{'kind':'tool','purpose':purpose,'requestRef':'req-1','callRef':'call-1',
                    'name':name,'arguments':{}} for name in ('neurobro_read_history','neurobro_analysis_material','neurobro_unknown')]
            for value in invalid:
                with self.subTest(value=value):
                    gate=self.gate();gate.accept({'kind':'scope','scope':self.scope(purpose)},1)
                    with self.assertRaises(m.Refused):gate.accept(value,1)
        gate=self.gate();gate.accept({'kind':'scope','scope':self.scope('community-assessment')},1)
        with self.assertRaises(m.Refused):gate.accept({'kind':'scope','scope':self.scope('conversation')},1)
        for version in (1,2):
            for purpose in ('community-assessment','unknown') if version == 1 else ('unknown',):
                with self.assertRaises(m.Refused):self.gate(version).accept({'kind':'scope','scope':self.scope(purpose)},1)

    def test_scoped_not_admitted_is_version_bound(self):
        good={'kind':'notAdmitted','purpose':'community-assessment','requestRef':'req-1','reason':'turns',
            'turnsAdmitted':16,'turnStartDispatches':16}
        self.gate().accept(good,1)
        with self.assertRaises(m.Refused):self.gate(1).accept(good,1)
        for change in ({'purpose':'unknown'},{'turnStartDispatches':True},{'turnStartDispatches':17},{'extra':False}):
            with self.assertRaises(m.Refused):self.gate().accept({**good,**change},1)

    def test_scoped_closed_and_receipt_reject_cross_version_schemas(self):
        for version in (1,2):
            value=receipt();value['schema']='decadans.rm0032.standing-scoped-epoch.v'+str(version)
            value['session']['facts']['schema']='neurobro-native-scoped-epoch-v'+str(version)
            closed={'kind':'closed','code':value['session']['code'],'facts':value['session']['facts']}
            gate=self.gate(version);gate.accept(closed,1);gate.accept({'kind':'epochResult','receipt':value},1)
            self.assertEqual(gate.receipt,value)
            for schema in ('neurobro-native-image-epoch-v1','neurobro-native-scoped-epoch-v'+str(3-version)):
                with self.assertRaises(m.Refused):
                    self.gate(version).accept({**closed,'facts':{**closed['facts'],'schema':schema}},1)
            for schema in ('decadans.rm0032.standing-epoch.v1','decadans.rm0032.standing-scoped-epoch.v'+str(3-version)):
                gate=self.gate(version);gate.accept(closed,1)
                with self.assertRaises(m.Refused):gate.accept({'kind':'epochResult','receipt':{**value,'schema':schema}},1)


class SessionOutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_production_session_named_ready_stream_preserves_bytes_and_cleanup_receipt(self):
        session=m.load(SOURCES['session'],'actual_session_output_fixture')
        for names in (None,('neurobro_read_history',),client.TOOL_NAMES):
            with self.subTest(names=names):
                inbox=queue.Queue();reader=asyncio.StreamReader();raw_frames=[];forwarded=[]
                loop=asyncio.get_running_loop();cancelled=[]
                facts={k:v for k,v in receipt()['session']['facts'].items() if k!='unreleasedTurn'}
                facts.update(threadStarted=False,turnsAttempted=0,turnsAdmitted=0,toolCalls=0,closed=False)
                class Epoch:
                    def state(self):return dict(facts)
                    def tool_names(self):return names or ('neurobro_read_history',)
                    def close(self):facts['closed']=True
                    def turn(self,*_):raise AssertionError('no native turn admitted')
                def emit(value,seconds):
                    self.assertGreater(seconds,0)
                    raw=m.encoded(value)+b'\n';raw_frames.append(raw)
                    loop.call_soon_threadsafe(reader.feed_data,raw)
                    return True
                def receive(seconds):
                    try:return inbox.get(timeout=min(seconds,.05))
                    except queue.Empty:return session.IDLE
                async def forward(value,seconds):
                    forwarded.append(m.encoded(value)+b'\n')
                    if value['kind']=='ready':inbox.put({'kind':'close'})
                    return True
                def produce():
                    emit(custody_frame(),20)
                    closed=session.run_session(lambda **_:Epoch(),receive,emit,lambda _: 'clear',
                        lambda _:True,lambda:cancelled.append(True),tool_names=names)
                    result=receipt()
                    result['native'].update(threadStartDispatches=0,turnStartDispatches=0,threadAcknowledged=False)
                    result['session'].update(code=closed['code'],facts=closed['facts'])
                    result=client.normalize_result(result)
                    emit({'kind':'epochResult','receipt':result},10)
                    loop.call_soon_threadsafe(reader.feed_eof)
                    return result
                gate=m.OutputGate(client.normalize_result,m.Budget())
                producer=asyncio.create_task(asyncio.to_thread(produce))
                try:
                    result,(observed,total)=await asyncio.wait_for(asyncio.gather(
                        asyncio.shield(producer),m.read_output(reader,gate,forward)),5)
                finally:
                    inbox.put({'kind':'close'})
                    await asyncio.wait_for(asyncio.shield(producer),5)
                self.assertEqual(forwarded,raw_frames)
                self.assertEqual(total,sum(map(len,raw_frames)))
                expected={'kind':'ready',**({'tools':list(names)} if names is not None else {})}
                self.assertEqual(raw_frames[1],m.encoded(expected)+b'\n')
                self.assertEqual([m.decoded(line)['kind'] for line in raw_frames],
                                 ['custodyReady','ready','closed','epochResult'])
                self.assertEqual(observed,result);self.assertEqual(gate.receipt,result)
                self.assertTrue(gate.ready);self.assertTrue(gate.budget.closing)
                self.assertEqual(gate.closed['facts'],result['session']['facts'])
                self.assertEqual(result['native']['turnStartDispatches'],0)
                self.assertEqual(result['session']['code'],'CLOSED');self.assertEqual(cancelled,[True])


class RelayTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'Actual relay loopback runs in the Linux guest')
    async def test_two_actual_loopback_tunnels_share_one_budget_and_natural_shutdown_joins_handlers(self):
        relay_module=m.load(m.specialize_relay(RELAY),'relay_tcp_fixture')
        relay_module.MAX_TUNNEL_BYTES=4096  # synthetic scaled aggregate; production fixed1GiB
        endpoints=[];received=bytearray();sink_tasks=set()
        async def sink(reader,writer):
            current=asyncio.current_task();sink_tasks.add(current)
            try:
                while data:=await reader.read(512):received.extend(data)
                writer.write_eof();await writer.drain()
            finally:writer.close();await writer.wait_closed();sink_tasks.discard(current)
        remote=await asyncio.start_server(sink,'127.0.0.1',0)
        port=remote.sockets[0].getsockname()[1]
        async def resolver(host):return [(relay_module.socket.AF_INET,'93.184.216.34')]
        async def connector(addresses):return await asyncio.open_connection('127.0.0.1',port)
        relay=relay_module.Relay(resolver=resolver,connector=connector)
        relay_module.LISTEN=('127.0.0.1',0);ready=asyncio.Event();stop=asyncio.Event()
        serving=asyncio.create_task(relay.serve(2,stop,ready.set))
        try:
            await asyncio.wait_for(ready.wait(),1)
            relay_port=relay.server.sockets[0].getsockname()[1]
            for _ in range(2):
                reader,writer=await asyncio.open_connection('127.0.0.1',relay_port);endpoints.append((reader,writer))
                writer.write(b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n');await writer.drain()
                self.assertIn(b'200',await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),1))
            async def flood(writer):writer.write(b'x'*3072);await writer.drain()
            await asyncio.gather(*(flood(writer) for _,writer in endpoints))
            end=asyncio.get_running_loop().time()+1
            while relay.counts['failed']==0 and asyncio.get_running_loop().time()<end:await asyncio.sleep(.005)
            self.assertGreater(relay.counts['failed'],0)
            self.assertLessEqual(relay.reserved_bytes,4096)
            self.assertGreater(relay.reserved_bytes,0)
            stop.set();counts=await asyncio.wait_for(serving,2)
            self.assertEqual(len(relay.tasks),0)
            self.assertEqual(counts['accepted'],2)
            self.assertGreaterEqual(counts['cancelled'],1)
            self.assertLessEqual(len(received),relay.reserved_bytes)
            self.assertTrue(relay.closing)
        finally:
            stop.set()
            for _,writer in endpoints:writer.close()
            await asyncio.gather(*(writer.wait_closed() for _,writer in endpoints),return_exceptions=True)
            await asyncio.gather(serving,return_exceptions=True)
            remote.close()
            if sink_tasks:await asyncio.gather(*sink_tasks,return_exceptions=True)
            await remote.wait_closed()

    async def test_exact_reservation_and_cancelled_write_are_consumed_without_refund(self):
        relay_module=m.load(m.specialize_relay(RELAY),'relay_reservation_fixture')
        relay=relay_module.Relay();relay.reserve(relay_module.MAX_TUNNEL_BYTES)
        with self.assertRaises(relay_module.Refused):relay.reserve(1)
        self.assertEqual(relay.reserved_bytes,relay_module.MAX_TUNNEL_BYTES)
        relay=relay_module.Relay()
        class Reader:
            def __init__(self):self.used=False
            async def read(self,_):
                if self.used:await asyncio.Future()
                self.used=True;return b'submitted'
        class Writer:
            def write(self,_):pass
            async def drain(self):await asyncio.Future()
            def write_eof(self):pass
        running=asyncio.create_task(relay_module.tunnel(Reader(),Writer(),Reader(),Writer(),reserve=relay.reserve))
        await asyncio.sleep(.01);running.cancel();await asyncio.gather(running,return_exceptions=True)
        self.assertEqual(relay.reserved_bytes,len(b'submitted')*2)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def fixture(self, *, foreign_relay=False, fail_emit=False, spawn_mode=None, fail_bootstrap=False, kill_race=False):
        runtime=m.prepare_runtime(SOURCE,CONFIG)
        runtime.os=types.SimpleNamespace(geteuid=lambda:0,chown=lambda root,uid,gid:self.assertEqual((uid,gid),(20000,20000)))
        runtime.relay_identity_available=lambda:None
        runtime.ROOT=types.SimpleNamespace(exists=lambda:False,is_symlink=lambda:False,mkdir=lambda **_:None)
        runtime.BINARY=types.SimpleNamespace(lstat=lambda:types.SimpleNamespace(st_mode=stat.S_IFREG|0o555,st_uid=0,st_gid=0,st_size=258659424),open=lambda _:io.BytesIO(b'fixture'))
        runtime.BINARY_SHA=hashlib.sha256(b'fixture').hexdigest()
        runtime.Path=lambda _:types.SimpleNamespace(read_text=lambda:'header\n')
        units={};events=[];outer=asyncio.Queue();observed=[];clock_offset=[0.];late_release=asyncio.Event();late_pending=[False]
        clock=lambda:m.time.monotonic()+clock_offset[0]
        owned_bundle=bundle();budget=m.Budget(clock)
        unit_argv=runtime.unit_argv
        def fixture_unit_argv(unit,source):
            # Before owned_spawn captures its deadline, after source loading.
            if unit==runtime.CLIENT and spawn_mode in ('delayed','pending_proof'):budget.end=clock()+.1
            return unit_argv(unit,source)
        runtime.unit_argv=fixture_unit_argv
        relay_receipt={'version':1,'settled':True,'counters':dict.fromkeys(('accepted','over_limit','refused','connected','completed','failed','cancelled','internal_error'),0)}
        scope={'requestRef':'request-1','threadId':'thread-1','turnId':'turn-1','turnNumber':1}
        class Proc:
            def __init__(self,unit=None,payload=None):
                self.unit=unit;self.returncode=None;self.stdout=asyncio.StreamReader();self.stderr=asyncio.StreamReader();self.done=asyncio.Event();self.waited=False
                self.stdin=Writer(self) if unit else None
                if payload is not None:self.stdout.feed_data(payload);self.finish(0)
            def send(self,value):self.stdout.feed_data(m.encoded(value)+b'\n')
            def finish(self,code):
                if self.returncode is None:self.returncode=code;self.done.set();self.stdout.feed_eof();self.stderr.feed_eof()
            async def wait(self):await self.done.wait();self.waited=True;return self.returncode
            def kill(self):
                self.finish(0 if kill_race else -9)
                if kill_race:raise ProcessLookupError('already exited')
        class Writer:
            def __init__(self,proc):self.proc=proc;self.bootstrap=True;self.closed=False
            def write(self,data):
                self.assert_open()
                if self.bootstrap:
                    length=int.from_bytes(data[:4],'big');assert len(data)==68+length
                    assert hashlib.sha256(data[68:]).hexdigest().encode()==data[4:68]
                    self.bootstrap=False
                    if self.proc.unit==runtime.RELAY:self.proc.send({'event':'ready','version':1})
                    else:self.proc.send(custody_frame());self.proc.send({'kind':'ready'})
                    return
                value=m.decoded(data);events.append(value['kind'])
                if value['kind']=='turn':
                    self.proc.send({'kind':'scope','scope':scope})
                    self.proc.send({'kind':'tool','scope':scope,'callRef':'call-1','name':'neurobro_read_history','arguments':{'fromDate':1,'toDate':2}})
                elif value['kind']=='toolResult':self.proc.send({'kind':'completed','scope':scope,'answer':'Историю прочёл','kindOfAnswer':'text','toolCalls':1,'toolRefusals':0})
                elif value['kind']=='release':self.proc.send({'kind':'released','requestRef':'request-1','delivery':'verified'})
                elif value['kind']=='close':
                    self.proc.send({'kind':'closed','code':'CLOSED','facts':receipt()['session']['facts']})
                    self.proc.send({'kind':'epochResult','receipt':receipt()});self.proc.finish(0)
            def assert_open(self):assert not self.closed
            async def drain(self):
                if fail_bootstrap and self.proc.unit==runtime.CLIENT:raise TimeoutError('bootstrap drain')
                await asyncio.sleep(0)
            def close(self):self.closed=True
            async def wait_closed(self):
                assert self.closed
        def status(unit):
            proc=units.get(unit)
            if unit==runtime.CLIENT and late_pending[0] and proc is None:
                events.append('absence-before-late-launch');late_release.set()
            if proc is None or proc.returncode is not None:
                if proc is not None and unit==runtime.CLIENT and spawn_mode is None and not fail_bootstrap:assert proc.waited
                return {'LoadState':'not-found','ActiveState':'inactive','MainPID':'0'}
            return {'LoadState':'loaded','ActiveState':'active','MainPID':'123',
                'Description':'foreign owner' if foreign_relay and unit==runtime.RELAY else runtime.DESCRIPTIONS[unit],
                'User':runtime.OWNERS[unit],'Group':runtime.OWNERS[unit]}
        async def spawn(*argv,**kwargs):
            if argv[0]=='/usr/bin/systemd-run':
                unit=next(x[len('--unit='):] for x in argv if x.startswith('--unit='));proc=Proc(unit);units[unit]=proc
                if unit==runtime.CLIENT:
                    if spawn_mode=='post_deadline':clock_offset[0]+=16.
                    elif spawn_mode=='delayed':
                        # OS handle exists, but creation's await completes after
                        # its already-admitted timeout. Cleanup must join it.
                        await asyncio.sleep(.15)
                    elif spawn_mode=='pending_proof':
                        del units[unit];late_pending[0]=True
                        await late_release.wait()
                        units[unit]=proc
                return proc
            assert argv[0]=='/usr/bin/systemctl'
            if argv[1]=='show':return Proc(payload=''.join(k+'='+v+'\n' for k,v in status(argv[2]).items()).encode())
            assert argv[1]=='stop';unit=argv[2];events.append('stop:'+unit)
            if unit==runtime.RELAY:units[unit].send(relay_receipt)
            units[unit].finish(0);return Proc(payload=b'')
        async def receive(seconds):
            try:return await asyncio.wait_for(outer.get(),seconds)
            except TimeoutError:return m.IDLE
        async def emit(value,seconds):
            observed.append(value['kind'])
            if fail_emit and value['kind']=='tool':raise TimeoutError('private downstream failure')
            if value['kind']=='ready':await outer.put({'kind':'turn','requestRef':'request-1','conversation':'{}'})
            elif value['kind']=='tool':await outer.put({'kind':'toolResult','callRef':'call-1','contentItems':[{'type':'inputText','text':'fixture history'}],'success':True})
            elif value['kind']=='completed':await outer.put({'kind':'release','requestRef':'request-1','delivery':'verified'})
            elif value['kind']=='released':await outer.put({'kind':'close'})
            return True
        value=await m.run_supervisor(SOURCE,owned_bundle,CONFIG,receive,emit,{'runtime':lambda *_:runtime,'spawn':spawn,'clock':clock},budget=budget)
        if spawn_mode or fail_bootstrap:
            self.assertTrue(units[runtime.CLIENT].stdin.closed)
            self.assertIsNotNone(units[runtime.CLIENT].returncode)
            self.assertTrue(all(proc.stdin.closed for proc in units.values()))
        return value,events,observed,runtime

    async def test_full_frozen_runtime_predicates_duplex_history_release_and_natural_units(self):
        value,events,observed,runtime=await self.fixture()
        self.assertEqual(value['outcome'],'observed',value)
        self.assertTrue(value['clientNaturalSettlement']);self.assertTrue(value['relaySettled']);self.assertTrue(value['allProcessesSettled'])
        self.assertTrue(value['injectedPorts'])
        self.assertEqual(observed,['custodyReady','ready','scope','tool','completed','released','closed','epochResult'])
        self.assertEqual(events[:4],['turn','toolResult','release','close'])
        self.assertNotIn('stop:'+runtime.CLIENT,events)
        self.assertEqual(events.count('stop:'+runtime.RELAY),1)
        self.assertTrue(value['physicalCleanup']['complete'])
        self.assertFalse(value['physicalCleanup']['clientStopRequested'])
        self.assertTrue(value['physicalCleanup']['relayStopRequested'])

    async def test_foreign_unit_is_never_stopped_or_claimed_settled(self):
        value,events,observed,runtime=await self.fixture(foreign_relay=True,kill_race=True)
        self.assertEqual(value['outcome'],'unknown')
        self.assertFalse(value['settled']);self.assertFalse(value['clientNaturalSettlement'])
        self.assertNotIn('stop:'+runtime.RELAY,events);self.assertEqual(observed,[])
        self.assertTrue(value['allProcessesSettled'])
        self.assertFalse(value['physicalCleanup']['complete'])
        self.assertFalse(value['physicalCleanup']['clientLaunchCaptured'])

    async def test_completed_spawn_past_local_deadline_still_captures_and_closes_handle(self):
        value,events,observed,runtime=await self.fixture(spawn_mode='post_deadline')
        self.assertEqual(value['outcome'],'unknown');self.assertFalse(value['clientNaturalSettlement'])
        self.assertTrue(value['allProcessesSettled']);self.assertIn('stop:'+runtime.CLIENT,events)

    async def test_delayed_spawn_creation_is_joined_during_shared_cleanup(self):
        value,events,observed,runtime=await self.fixture(spawn_mode='delayed')
        self.assertEqual(value['outcome'],'unknown');self.assertFalse(value['clientNaturalSettlement'])
        self.assertTrue(value['allProcessesSettled']);self.assertIn('stop:'+runtime.CLIENT,events)

    async def test_failed_bootstrap_drain_closes_client_before_launch_assignment(self):
        value,events,observed,runtime=await self.fixture(fail_bootstrap=True)
        self.assertEqual(value['outcome'],'unknown');self.assertFalse(value['clientNaturalSettlement'])
        self.assertTrue(value['allProcessesSettled']);self.assertIn('stop:'+runtime.CLIENT,events)

    async def test_late_launch_cannot_reuse_absence_proof_from_before_creation(self):
        value,events,observed,runtime=await self.fixture(spawn_mode='pending_proof')
        self.assertIn('absence-before-late-launch',events)
        self.assertEqual(value['outcome'],'unknown');self.assertFalse(value['settled'])
        self.assertTrue(value['allProcessesSettled']);self.assertFalse(value['clientNaturalSettlement'])
        # The legacy proof remains false. A separate final snapshot AFTER late
        # capture/kill observes absence in this fake runtime and may prove cleanup.
        self.assertTrue(value['physicalCleanup']['creationsJoined'])
        self.assertTrue(value['physicalCleanup']['unitChecksAfterCreations'])
        self.assertTrue(value['physicalCleanup']['transportKillRequested'])

    async def test_output_backpressure_failure_never_becomes_natural_client_success(self):
        value,events,observed,runtime=await self.fixture(fail_emit=True)
        self.assertEqual(value['outcome'],'unknown')
        self.assertFalse(value['clientNaturalSettlement']);self.assertNotIn('completed',observed)
        self.assertIn('stop:'+runtime.CLIENT,events)
        self.assertNotIn('private',json.dumps(value))

    async def test_large_two_image_input_crosses_supervisor_and_inner_codec_after_joined_drain(self):
        wire=m.load(WIRE,'visual_input_wire_fixture')
        for scoped in (False,True):
            frame={'kind':'turn','requestRef':'photo','images':[{'mimeType':'image/jpeg','base64':base64.b64encode(b"\xff\xd8\xff"+b'x'*1357500).decode()}]*2}
            frame.update({'purpose':'conversation','input':'Describe attached pictures'} if scoped else {'conversation':'Describe attached pictures'})
            gate=m.OutputGate(client.normalize_result,m.Budget());gate.ready=True
            values=iter([frame,{'kind':'close'}]);writes=[];draining=asyncio.Event();permit=asyncio.Event()
            class Writer:
                def write(self,raw):writes.append(raw)
                async def drain(self):draining.set();await permit.wait()
                def close(self):pass
            async def receive(_):return next(values)
            task=asyncio.create_task(m.forward_input(Writer(),receive,gate));await draining.wait()
            self.assertFalse(task.done());self.assertEqual(len(writes),1)
            self.assertGreater(len(writes[0]),3600000)
            self.assertEqual(wire.decode_frame(writes[0]),frame)
            permit.set();await task
            self.assertEqual(writes[1],b'{"kind":"close"}\n')

    async def test_supervisor_large_input_allowance_cannot_expand_ordinary_or_output_caps(self):
        image={'mimeType':'image/jpeg','base64':'A'*(m.FRAME_CAP+1)}
        good={'kind':'turn','purpose':'conversation','requestRef':'photo','input':'Describe','images':[image]}
        cases=[{**good,'purpose':'history-analysis'}, {**good,'kind':'toolResult'},
               {**good,'extra':True},{**good,'input':'x'*24577},
               {**good,'images':[image]*3},{**good,'images':[{'mimeType':'text/plain','base64':'A'*(m.FRAME_CAP+1)}]},
               {**good,'images':[{**image,'base64':'A'*(m.VISUAL_INPUT_FRAME_CAP+1)}]}]
        for frame in cases:
            gate=m.OutputGate(client.normalize_result,m.Budget());gate.ready=True;writes=[]
            writer=types.SimpleNamespace(write=lambda raw:writes.append(raw),close=lambda:None)
            async def receive(_):return frame
            with self.assertRaises(m.Refused):await m.forward_input(writer,receive,gate)
            self.assertEqual(writes,[])
        gate=m.OutputGate(client.normalize_result,m.Budget());writes=[]
        class Reader:
            async def readline(self):return m.encoded({'kind':'completed','images':[image]})+b'\n'
        async def emit(value,_):writes.append(value);return True
        with self.assertRaises(m.Refused):await m.read_output(Reader(),gate,emit)
        self.assertEqual(writes,[])

    async def test_late_input_and_output_never_forward_records_or_admit_custody(self):
        now=[0.];budget=m.Budget(lambda:now[0]);gate=m.OutputGate(client.normalize_result,budget)
        writes=[]
        writer=types.SimpleNamespace(write=lambda raw:writes.append(raw),close=lambda:None)
        async def receive(_):now[0]=121.;return {'kind':'close'}
        with self.assertRaises(m.Refused):await m.forward_input(writer,receive,gate)
        self.assertEqual(writes,[])
        now[0]=0.;budget=m.Budget(lambda:now[0]);gate=m.OutputGate(client.normalize_result,budget)
        class Reader:
            async def readline(self):now[0]=121.;return m.encoded(custody_frame())+b'\n'
        async def emit(value,_):writes.append(value);return True
        with self.assertRaises(m.Refused):await m.read_output(Reader(),gate,emit)
        self.assertFalse(gate.custody);self.assertEqual(writes,[])

    async def test_main_final_record_shares_earliest_close_budget_and_refuses_expiry(self):
        for expired in (False,True):
            now=[0.];budget=m.Budget(lambda:now[0]);writes=[];closed=[]
            class Wire:
                def __init__(self,*args,**kwargs):pass
                def emit(self,value,seconds):writes.append((value['kind'],seconds));return True
                def close(self):closed.append(True)
            capsule=types.SimpleNamespace(wire_class=lambda:Wire)
            async def run(*args,**kwargs):
                self.assertIs(kwargs['budget'],budget)
                now[0]=10.;budget.close();now[0]=45. if expired else 44.
                return {'invented':'receipt'}
            with mock.patch.object(m,'Budget',lambda:budget),mock.patch.object(m,'load',lambda *args:capsule),mock.patch.object(m,'run_supervisor',run):
                if expired:
                    with self.assertRaises(m.Refused):await m.main(SOURCE,{'client':{'source':'','sha256':''}},CONFIG)
                    self.assertEqual(writes,[])
                else:
                    await m.main(SOURCE,{'client':{'source':'','sha256':''}},CONFIG)
                    self.assertEqual(writes,[('supervisorResult',1.)])
            self.assertTrue(closed)

    async def test_close_or_eof_before_custody_immediately_requests_owned_cleanup(self):
        for value in (None,{'kind':'close'}):
            gate=m.OutputGate(client.normalize_result,m.Budget());closed=[];writes=[]
            writer=types.SimpleNamespace(close=lambda:closed.append(True),write=lambda v:writes.append(v))
            async def receive(_):return value
            with self.assertRaises(m.Refused):await m.forward_input(writer,receive,gate)
            self.assertEqual(closed,[True]);self.assertEqual(writes,[]);self.assertTrue(gate.budget.closing)


if __name__=='__main__':unittest.main()
