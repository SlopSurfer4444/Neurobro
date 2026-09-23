"""Production guest entry, real engines/RPC, synthetic child pipes only."""
import copy
import importlib.util
import json
from pathlib import Path
import queue
import sys
import threading
import types
import unittest

ROOT=Path(__file__).parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/file)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
f=load('parallel_client_adapter_fixture','history-parallel-native-adapter.test.py')
c=f.f.c
EXTRA={'parallelPool':'history-parallel-native-pool.py','parallelAdapter':'history-parallel-native-adapter.py',
       'parallelSession':'history-parallel-native-session.py','parallelClient':'history-parallel-native-client.py'}


class OptionalAnalysisTests(unittest.TestCase):
    def test_session_failure_is_bounded_diagnostic_not_a_wire_extension(self):
        entry=load('parallel_entry_session_failure','history-parallel-native-client.py')
        receipt=dict(schema='history-parallel-native-pool-v1',epochRef='fixture',resourcesSettled=True,
            replacementReady=True,relaySettlementObserved=False,children=[],budget=dict(turnStartDispatches=0,
            foregroundDispatches=0,turnsAdmitted=0,foregroundAdmissions=0,reservedReadBytes=0,reservedWriteBytes=0,closed=True))
        diagnostic={'site':'tool_wait','purpose':'conversation','toolName':'neurobro_read_history'}
        session=types.SimpleNamespace(run_parallel_session=lambda *args,**kwargs:dict(code='IO_UNKNOWN',receipt=receipt,sessionFailure=diagnostic))
        result,_,_=entry.run(c,{'parallelSession':session},{},{},lambda _:None,lambda *_:True,
            parallel_options={'analysisWorkers':1,'communityAssessment':False})
        self.assertEqual(result['sessionFailure'],diagnostic)
        self.assertEqual(c.normalize_parallel_result(result),result)
        for failure in ({**diagnostic,'toolName':'PRIVATE arbitrary name'}, {**diagnostic,'purpose':'community-assessment'},
                        {**diagnostic,'arguments':{'private':'value'}}, {**diagnostic,'site':'other'},
                        {'site':'receive_eof','purpose':'conversation','toolName':None}):
            with self.subTest(failure=failure),self.assertRaises(ValueError):
                c.normalize_parallel_result({**result,'sessionFailure':failure})
        for site in ('wire_emit','receive_eof','receive_exception'):
            valid={**result,'sessionFailure':{'site':site,'purpose':None,'toolName':None}}
            self.assertEqual(c.normalize_parallel_result(valid),valid)
        for patch in ({'sessionCode':'CLOSED'},{'sessionCode':'EPOCH_LIMIT'},{'outcome':'observed'}):
            with self.subTest(patch=patch),self.assertRaises(ValueError):
                c.normalize_parallel_result({**result,**patch})

    def test_parallel_client_retains_closed_reason_in_normalized_receipt(self):
        entry=load('parallel_entry_diagnostic','history-parallel-native-client.py')
        receipt=dict(schema='history-parallel-native-pool-v1',epochRef='fixture',resourcesSettled=True,
            replacementReady=True,relaySettlementObserved=False,children=[],budget=dict(turnStartDispatches=0,
            foregroundDispatches=0,turnsAdmitted=0,foregroundAdmissions=0,reservedReadBytes=0,reservedWriteBytes=0,closed=True))
        session=types.SimpleNamespace(run_parallel_session=lambda *args,**kwargs:dict(code='INPUT_REFUSED',receipt=receipt))
        result,_,_=entry.run(c,{'parallelSession':session},{},{},lambda _:None,lambda *_:True,
            parallel_options={'analysisWorkers':1,'communityAssessment':False})
        self.assertEqual((result['code'],result['sessionCode']),('SESSION_UNKNOWN','INPUT_REFUSED'))
        self.assertEqual(c.normalize_parallel_result(result),result)

    def test_optional_initial_chronicle_advertisement_exact_shape(self):
        packet=json.loads(f.f.ANALYSIS_TEXT)
        advertised={'contextHash':'a'*64,'neutralPeriodNotesAvailable':True,'periodAdvisoryAvailable':False}
        self.assertTrue(c.validate_analysis_input(json.dumps({**packet,'periodChronicle':advertised})))
        for delta in ({'contextHash':'A'*64},{'neutralPeriodNotesAvailable':1},{'periodAdvisoryAvailable':None},
                      {'neutralPeriodNotesAvailable':False},{'taskRef':'other'}):
            self.assertFalse(c.validate_analysis_input(json.dumps({**packet,'periodChronicle':{**advertised,**delta}})))
        self.assertFalse(c.validate_analysis_input(json.dumps({**packet,'periodChronicle':None})))

    def test_optional_material_purpose_remains_closed_and_raw_read_available(self):
        for value in ({},{'purpose':'neutral-period-notes'},{'purpose':'period-advisory'}):
            self.assertTrue(c.analysis_material_arguments(value))
        for value in ({'purpose':None},{'purpose':True},{'purpose':'query'},{'purpose':'period-advisory','taskRef':'other'}):
            self.assertFalse(c.analysis_material_arguments(value))

    def test_neutral_commit_is_separate_optional_bounded_output(self):
        output={'summary':'Query result','claims':[]}
        neutral={'inputHash':'a'*64,'output':{'summary':'Neutral notes','claims':[]}}
        self.assertTrue(c.analysis_commit_arguments({'output':output}))
        self.assertTrue(c.analysis_commit_arguments({'output':output,'neutralOutput':neutral}))
        self.assertFalse(c.analysis_commit_arguments({'neutralOutput':neutral}))
        for delta in ({'inputHash':'A'*64},{'inputHash':'a'*63},{'inputHash':None},{'taskRef':'other'},
                      {'output':{'summary':'x'*32769,'claims':[]}}, {'output':{'summary':'x','claims':[],'hidden':True}}):
            self.assertFalse(c.analysis_commit_arguments({'output':output,'neutralOutput':{**neutral,**delta}}))


@unittest.skipUnless(sys.platform=='linux','Actual pinned RPC anonymous pipes require Linux')
class ConnectedClientTests(unittest.TestCase):
    def test_actual_guest_main_custody_result_profile_and_all_children_join(self):
        sources={**f.f.sources(),**{k:(ROOT/v).read_text(encoding='utf-8') for k,v in EXTRA.items()}}
        inbox=queue.Queue();frames=[];children=[];base=[];released=[]
        barrier=threading.Barrier(3)
        def preflight(b,result):
            base.append(b)
            for key in result['controls']:result['controls'][key]=key!='relayAfter'
        def popen(argv,**kwargs):
            child=f.Child(self,base[0],len(children),barrier,work_profile='community-team')
            children.append(child);return child
        def receive(seconds):
            try:return inbox.get(timeout=seconds)
            except queue.Empty:return c.IDLE
        def emit(value,seconds):
            frames.append(copy.deepcopy(value));frame=value.get('frame',{})
            if frame.get('kind')=='ready' and value['workerId']=='worker-2':
                for index,purpose in enumerate(('conversation','history-analysis','history-analysis')):
                    item=dict(workerId='worker-'+str(index),frame=dict(kind='turn',purpose=purpose,requestRef='request-'+str(index),input=f.f.TEXT if index==0 else f.f.ANALYSIS_TEXT))
                    if index:item['work']=dict(taskRef='task',planRef='wave',workRef='work-'+str(index))
                    inbox.put(item)
            elif frame.get('kind')=='tool':
                inbox.put(dict(workerId=value['workerId'],frame=dict(kind='toolResult',purpose=frame['purpose'],requestRef=frame['requestRef'],callRef=frame['callRef'],result=f.f.tool_result(frame['name'],frame['arguments']))))
            elif frame.get('kind')=='completed':
                inbox.put(dict(workerId=value['workerId'],frame=dict(kind='release',purpose=frame['scope']['purpose'],requestRef=frame['scope']['requestRef'],delivery='not-sent')))
            elif frame.get('kind')=='released':
                released.append(value['workerId'])
                if len(released)==3:inbox.put({'kind':'close'})
            return True
        result=c.main(sources,f.f.CONFIG,receive,emit,ports={'clock':f.s.time.monotonic,'popen':popen,'preflight':preflight,'relay_reachable':lambda:True},
                      session_mode=c.PARALLEL_MODE,work_profile='community-team',parallel_options={'analysisWorkers':2,'communityAssessment':False})
        self.assertEqual(result['outcome'],'observed',result)
        self.assertEqual(result,c.normalize_result(result))
        self.assertEqual(frames[0]['kind'],'poolCustodyReady')
        self.assertEqual(frames[-1],{'kind':'epochResult','receipt':result})
        self.assertEqual(len(result['custodyChildren']),3)
        self.assertTrue(result['pool']['resourcesSettled'])
        self.assertTrue(all(not x.errors and not x.thread.is_alive() for x in children))
        for mutate in (lambda v:v['custodyChildren'][0]['custody']['probeExitCodes'].__setitem__(0,123),
                       lambda v:v['pool']['budget'].__setitem__('foregroundAdmissions',0),
                       lambda v:v['custodyChildren'][0]['capabilities'].__setitem__('webSearch',False)):
            invalid=copy.deepcopy(result);mutate(invalid)
            with self.assertRaises(ValueError):c.normalize_result(invalid)

    def test_bad_parallel_source_refused_before_any_port(self):
        calls=[]
        result=c.run({},f.f.CONFIG,lambda _:calls.append('read'),lambda *_:calls.append('write'),
                     session_mode=c.PARALLEL_MODE,parallel_options={'analysisWorkers':2,'communityAssessment':False})
        self.assertEqual(result['code'],'SOURCE_REFUSED');self.assertEqual(calls,[])


if __name__=='__main__':unittest.main()
