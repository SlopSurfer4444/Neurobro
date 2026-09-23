"""One guest owner, three anonymous-pipe App Server substitutes, real engines.

No real subprocess, relay, model, network, credentials or Telegram. Linux only
because the pinned NativeRpc uses selectors on anonymous pipes. Test pins bind
current source locally, never changing production bindings.
"""
import copy
import hashlib
import importlib.util
import io
import json
import os
import queue
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


p = load('adapter_pool', 'history-parallel-native-pool.py')
a = load('adapter', 'history-parallel-native-adapter.py')
f = load('adapter_sources', 'rm-0032-standing-scoped-client.test.py')
s = load('adapter_session', 'history-parallel-native-session.py')


class Child:
    def __init__(self, test, base, index, barrier, invalid_profile=False, community=False,work_profile=None,
                 invalid_initialize=False,bad_probe_index=None):
        self.test, self.base, self.index, self.barrier = test, base, index, barrier
        self.pid, self.invalid_profile = 7000+index, invalid_profile
        self.community = community
        self.work_profile = work_profile
        self.invalid_initialize,self.bad_probe_index=invalid_initialize,bad_probe_index
        self.commands = self.turns = 0
        self.done, self.errors, self.requests = False, [], []
        ir, iw = os.pipe(); rr, rw = os.pipe(); er, ew = os.pipe()
        self.stdin, self.stdout, self.stderr = io.FileIO(iw,'wb'), io.FileIO(rr,'rb'), io.FileIO(er,'rb')
        self.server_in, self.server_out, self.server_err = io.FileIO(ir,'rb'), io.FileIO(rw,'wb'), io.FileIO(ew,'wb')
        self.thread = threading.Thread(target=self.serve)
        self.thread.start()

    def send(self, value):
        raw = json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()+b'\n'
        while raw: raw = raw[os.write(self.server_out.fileno(), raw):]

    def serve(self):
        try:
            while True:
                line = self.server_in.readline(12*1024*1024)
                if not line: break
                frame = json.loads(line)
                self.requests.append(frame)
                method, params = frame['method'], frame.get('params', {})
                if method == 'initialized': continue
                if method == 'initialize':
                    if self.invalid_initialize:break
                    result = dict(platformOs='linux',platformFamily='unix',codexHome=self.base.AUTH_HOME,
                                  userAgent=self.base.CLIENT+'/0.153.4 (fixture)')
                elif method == 'permissionProfile/list':
                    result = {'data':[{'id':f.CONFIG['profile'],'allowed':not self.invalid_profile}], 'nextCursor':None}
                elif method == 'command/exec':
                    name = self.base.base_result()['probes'][self.commands]['name']
                    self.commands += 1
                    result = dict(exitCode=sorted(self.base.pass_codes(name))[0],stdout='',stderr='')
                    if self.commands-1==self.bad_probe_index:result['exitCode']=123
                elif method == 'account/read':
                    result = {'account':{'type':'chatgpt'},'requiresOpenaiAuth':False}
                elif method == 'model/list':
                    result = {'data':[{'model':'gpt-6-astra','hidden':False,
                              'supportedReasoningEfforts':[{'reasoningEffort':'medium'}]}], 'nextCursor':None}
                elif method == 'modelProvider/capabilities/read':
                    result = dict(imageGeneration=True,namespaceTools=False,webSearch=True)
                elif method == 'thread/start':
                    analysis = self.index > 0
                    _,extras,_=f.c.conversation_configuration(self.work_profile)
                    expected = [] if self.community else list(f.c.ANALYSIS_TOOL_SPECS) if analysis else [f.c.TOOL_SPEC,*[e['spec'] for e in extras]]
                    self.test.assertEqual(params['dynamicTools'], expected)
                    if analysis:
                        self.test.assertEqual(params['config']['web_search'], 'disabled')
                        self.test.assertIs(params['config']['features.image_generation'], False)
                    result = {'thread':{'id':'thread-'+str(self.index),'ephemeral':True},
                              'model':'gpt-6-astra','modelProvider':'openai','reasoningEffort':'medium',
                              'cwd':f.CONFIG['cwd'],'approvalPolicy':'never','approvalsReviewer':'user',
                              'activePermissionProfile':{'id':f.CONFIG['profile']}}
                elif method == 'turn/start':
                    self.turns += 1
                    self.barrier.wait(4)
                    turn = 'turn-'+str(self.turns)
                    self.send({'id':frame['id'],'result':{'turn':{'id':turn,'items':[],'status':'inProgress'}}})
                    if self.community:
                        self.send({'method':'turn/completed','params':dict(threadId='thread-'+str(self.index),turn=dict(id=turn,status='completed',
                            items=[dict(id='answer-'+turn,type='agentMessage',phase='final_answer',text='{"decision":"silent","caseKey":null,"answer":null}')]))})
                        continue
                    # Callback exercises exact child/work routing with identical
                    # int64 native request IDs deliberately reused across pipes.
                    name, args = f.ANALYSIS_CASES[0] if self.index else f.TOOL_CASES[0]
                    native_id = 2**63-1
                    call = dict(threadId='thread-'+str(self.index),turnId=turn,callId='call-'+turn,tool=name,arguments=args)
                    self.send({'id':native_id,'method':'item/tool/call','params':call})
                    response = json.loads(self.server_in.readline(12*1024*1024))
                    self.test.assertEqual(response['id'], native_id)
                    self.test.assertIs(type(response['id']), int)
                    item = dict(id=call['callId'],type='dynamicToolCall',tool=name,namespace=None,
                                arguments=args,status='completed',**response['result'])
                    self.send({'method':'item/completed','params':dict(threadId=call['threadId'],turnId=turn,completedAtMs=1,item=item)})
                    self.send({'method':'turn/completed','params':dict(threadId=call['threadId'],turn=dict(id=turn,status='completed',
                              items=[item,dict(id='answer-'+turn,type='agentMessage',phase='final_answer',text='Synthetic complete')]))})
                    continue
                else: raise AssertionError('Unexpected method '+method)
                self.send({'id':frame['id'],'result':result})
        except BaseException as error:
            self.errors.append(str(error))
        finally:
            self.server_in.close(); self.server_out.close(); self.server_err.close()
            self.done = True

    def wait(self, timeout):
        self.thread.join(timeout)
        if self.thread.is_alive(): raise subprocess.TimeoutExpired('synthetic',timeout)
        return 0

    def poll(self): return 0 if self.done else None


@unittest.skipUnless(sys.platform == 'linux', 'Pinned anonymous-pipe selector is Linux-only')
class ConnectedTests(unittest.TestCase):
    def fixture(self, invalid_profile=False, community=False, bound_tool=None,invalid_initialize_index=None,bad_probe_index=None):
        sources = f.sources()
        pins = {key:hashlib.sha256(value.encode()).hexdigest().upper() for key,value in sources.items()}
        with patch.dict(f.c.PINS,pins,clear=True): modules = f.c.load_sources(sources,f.CONFIG)
        children, preflights, calls, launches = [], [], [], []
        barrier = threading.Barrier(4 if community else 3)

        def preflight(result):
            preflights.append(1)
            for key in result['controls']: result['controls'][key] = key != 'relayAfter'

        def popen(argv, **kwargs):
            launches.append((argv, kwargs))
            child = Child(self,modules['custody'],len(children),barrier,invalid_profile and len(children)==1, community and len(children)==3,
                          invalid_initialize=len(children)==invalid_initialize_index,bad_probe_index=bad_probe_index)
            children.append(child)
            return child

        def tool(binding, params, seconds):
            calls.append((copy.deepcopy(binding),copy.deepcopy(params)))
            if bound_tool is not None:
                return bound_tool(binding,params,seconds)
            return f.tool_result(params['tool'],params['arguments'])

        pool = a.create_guest_pool(p,f.c,modules,sources,f.CONFIG,enabled=True,epoch_ref='pool-test',
                   analysis_workers=2,tool=tool,popen=popen,preflight=preflight,community_assessment=community)
        return pool, children, preflights, calls, launches

    def test_actual_pipes_custody_engines_tool_binding_global_budget_join(self):
        pool, children, preflights, calls, launches = self.fixture()
        try:
            pool.open()
            proof=pool.custody_snapshot()
            self.assertEqual([r['processId'] for r in proof],[7000,7001,7002])
            self.assertTrue(all(r['custody']['controlsPassed'] and r['capabilities']['checked'] for r in proof))
            futures = []
            for index,purpose in enumerate(('conversation','history-analysis','history-analysis')):
                futures.append(pool.submit(purpose=purpose,request_ref='request-'+str(index),task_ref='task-a',
                     plan_ref='wave-a',work_ref='work-'+str(index),text=f.TEXT if index==0 else f.ANALYSIS_TEXT))
            values = [future.result(timeout=5) for future in futures]
            self.assertEqual([v['outcome'] for v in values], ['observed']*3)
            self.assertEqual(len(calls),3)
            for binding, params in calls:
                self.assertEqual(params['threadId'],'thread-'+str(binding['processId']-7000))
                self.assertEqual(binding['workerId'],'worker-'+str(binding['processId']-7000))
            self.assertEqual(preflights,[1])
            self.assertEqual([c.commands for c in children],[9,9,9])
            self.assertEqual(len({id(w['raw']) for w in pool.workers}),3)
            self.assertEqual(pool.budget.snapshot()['turnStartDispatches'],3)
            self.assertGreater(pool.budget.snapshot()['reservedReadBytes'],0)
            self.assertGreater(pool.budget.snapshot()['reservedWriteBytes'],0)
            self.assertTrue(all(kw['bufsize']==0 and kw['close_fds'] is True for _,kw in launches))
            for value in values: pool.release(value['binding'],'not-sent')
        finally:
            receipt = pool.close()
        self.assertTrue(receipt['resourcesSettled'], receipt)
        self.assertTrue(all(not c.thread.is_alive() and not c.errors for c in children))
        self.assertTrue(all(c.stdin.closed and c.stdout.closed and c.stderr.closed for c in children))

    def test_failed_second_child_custody_joins_created_children(self):
        pool, children, preflights, _, _ = self.fixture(invalid_profile=True)
        with self.assertRaises(Exception): pool.open()
        self.assertEqual(len(children),2)
        self.assertTrue(pool.close()['resourcesSettled'])
        self.assertEqual([c.turns for c in children],[0,0])
        self.assertTrue(all(not c.thread.is_alive() for c in children))
        self.assertTrue(all(c.stdin.closed and c.stdout.closed and c.stderr.closed for c in children))

    def test_third_child_real_rpc_eof_is_retained_after_uncertain_cleanup(self):
        pool,children,_,_,_=self.fixture(community=True,invalid_initialize_index=2)
        settle=pool.settle
        def uncertain(proc,raw,seconds):
            result=settle(proc,raw,seconds)
            if proc.pid==7002:result['stdoutEof']=False
            return result
        pool.settle=uncertain
        with self.assertRaises(Exception):pool.open()
        receipt=pool.close();failure=receipt['startupFailure']
        self.assertEqual(len(children),3);self.assertFalse(receipt['resourcesSettled'])
        self.assertEqual(failure,dict(workerId='worker-2',stage='custody',code='TRANSPORT_UNKNOWN',
            custodyStage='initialize',probeIndex=None,
            rpcFailure=dict(code='TRANSPORT_UNKNOWN',site='eof',operation='initialize',phase='custody')))
        self.assertEqual(receipt['budget']['turnStartDispatches'],0)
        self.assertTrue(all(not c.thread.is_alive() for c in children))
        self.assertTrue(all(c.stdin.closed and c.stdout.closed and c.stderr.closed for c in children))

    def test_nonfinal_refused_probe_is_identified_instead_of_last_successful_probe(self):
        pool,children,_,_,_=self.fixture(bad_probe_index=2)
        with self.assertRaises(Exception):pool.open()
        receipt=pool.close();failure=receipt['startupFailure']
        self.assertEqual(children[0].commands,9)
        self.assertEqual(failure['code'],'PROBE_REFUSED');self.assertEqual(failure['custodyStage'],'probes')
        self.assertEqual(failure['probeIndex'],2);self.assertIsNone(failure['rpcFailure'])
        self.assertTrue(receipt['resourcesSettled'])

    def test_assessor_remains_toolfree_and_runs_alongside_foreground_analysis(self):
        pool, children, _, calls, _ = self.fixture(community=True)
        try:
            pool.open()
            futures=[]
            for index,purpose in enumerate(('conversation','history-analysis','history-analysis','community-assessment')):
                text = f.TEXT if index==0 else f.ANALYSIS_TEXT
                if index==3:
                    text=json.dumps(dict(schema='community-assessment-v1',assessmentRef='request-3',policyRevision=1,
                         guidance='',observations=[],recentAlertSummary=''),separators=(',',':'))
                futures.append(pool.submit(purpose=purpose,request_ref='request-'+str(index),task_ref='task-a',
                     plan_ref='wave-a',work_ref='work-'+str(index),text=text))
            results=[future.result(5) for future in futures]
            self.assertEqual([r['outcome'] for r in results],['observed']*4)
            self.assertEqual(len(calls),3)
            self.assertEqual(pool.workers[3]['actor'].tool_names(),())
        finally:
            receipt=pool.close()
        self.assertTrue(receipt['resourcesSettled'])

    def test_unknown_idle_native_event_refuses_only_child_before_turn_dispatch(self):
        pool, children, _, _, _ = self.fixture()
        try:
            pool.open()
            children[1].send({'method':'untrusted/future','params':{}})
            # Same pipe read owner consumes the actual queued bytes at submit.
            result=pool.submit(purpose='history-analysis',request_ref='idle-test',task_ref='task-a',
                 plan_ref='wave-a',work_ref='work-a',text=f.ANALYSIS_TEXT,worker_id='worker-1').result(3)
            self.assertEqual(result['outcome'],'unknown')
            self.assertEqual(children[1].turns,0)
            self.assertEqual(pool.budget.snapshot()['turnStartDispatches'],0)
        finally:
            pool.close()

    def test_multiplex_session_connects_actual_native_children_and_exact_tool_release(self):
        inbox, frames, holder = queue.Queue(), [], []
        released=[]
        def factory(*,tool,clock):
            fixture=self.fixture(bound_tool=tool)
            holder.append(fixture)
            return fixture[0]
        def receive(seconds):
            try: return inbox.get(timeout=seconds)
            except queue.Empty: return s.IDLE
        def emit(value,seconds):
            frames.append(copy.deepcopy(value))
            frame=value.get('frame',{})
            if frame.get('kind')=='ready' and value['workerId']=='worker-2':
                for index,purpose in enumerate(('conversation','history-analysis','history-analysis')):
                    envelope=dict(workerId='worker-'+str(index),frame=dict(kind='turn',purpose=purpose,
                         requestRef='request-'+str(index),input=f.TEXT if index==0 else f.ANALYSIS_TEXT))
                    if index: envelope['work']=dict(taskRef='task-a',planRef='wave-a',workRef='work-'+str(index))
                    inbox.put(envelope)
            elif frame.get('kind')=='tool':
                inbox.put(dict(workerId=value['workerId'],frame=dict(kind='toolResult',purpose=frame['purpose'],
                          requestRef=frame['requestRef'],callRef=frame['callRef'],result=f.tool_result(frame['name'],frame['arguments']))))
            elif frame.get('kind')=='completed':
                inbox.put(dict(workerId=value['workerId'],frame=dict(kind='release',purpose=frame['scope']['purpose'],
                               requestRef=frame['scope']['requestRef'],delivery='not-sent')))
            elif frame.get('kind')=='released':
                released.append(value['workerId'])
                if len(released)==3: inbox.put({'kind':'close'})
            return True
        result=s.run_parallel_session(factory,receive,emit,
                     lambda purpose,text: f.c.validate_analysis_input(text) if purpose=='history-analysis' else True,
                     tool_names={'conversation':f.c.TOOL_NAMES,'history-analysis':f.c.ANALYSIS_TOOL_NAMES})
        self.assertEqual(result['code'],'CLOSED',result)
        self.assertTrue(result['receipt']['resourcesSettled'])
        self.assertEqual(len(released),3)
        self.assertEqual(len([v for v in frames if v.get('frame',{}).get('kind')=='completed']),3)
        self.assertTrue(all(not child.errors and not child.thread.is_alive() for child in holder[0][1]))


if __name__ == '__main__': unittest.main()
