"""Two actual engines, synthetic native transport; no process/auth/model I/O."""
import copy
import importlib.util
import json
from pathlib import Path
import queue
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
s = load('scoped_session', 'rm-0032-native-epoch-session.py')
m = load('scoped_budget', 'rm-0032-native-epoch-managed-rpc.py')
i = load('scoped_idle', 'rm-0032-native-epoch-idle.py')
f = load('scoped_fixture', 'rm-0032-native-conversation.test.py')
e = load('scoped_image', 'rm-0032-native-image-epoch.py')
c = load('scoped_collector', 'rm-0032-native-image-collector.py')
IDLE = object()
NAMES = {'conversation': (f.m.NAME,), 'history-analysis': s.ANALYSIS_NAMES}

class Rpc(f.Rpc):
    def __init__(self, plan=None):
        super().__init__(plan); self.threads = 0; self.current = None
        self.fail_thread = False; self.cancelled = False
    def admit_model(self): pass
    def cancel_requested(self): return self.cancelled
    def poll_frame(self, seconds): return self.next_frame(seconds) if self.frames else IDLE
    def idle_state(self): return {'queuedFrames': 0, 'partialBytes': 0, 'pendingRequests': 0, 'stdoutEofObserved': False}
    def exchange(self, method, params, timeout):
        if method == 'thread/start':
            if self.fail_thread: raise OSError('PRIVATE')
            result = super().exchange(method, params, timeout)
            self.threads += 1; result[0]['thread']['id'] = 'thread-' + str(self.threads)
            return result
        self.current = params['threadId']
        result = super().exchange(method, params, timeout)
        for frame in self.frames:
            if frame.get('params', {}).get('threadId') == 'thread-1': frame['params']['threadId'] = self.current
        return result

class Host:
    def __init__(self, purposes=('conversation','history-analysis','conversation'), plan=None, clock=time.monotonic, protocol='standing-scoped-epoch-v1'):
        self.protocol=protocol; self.names={**NAMES, **({'community-assessment':()} if protocol=='standing-scoped-epoch-v2' else {})}; self.purposes=purposes; self.frames=[]; self.inbox=queue.Queue(); self.receivers=set(); self.actors={}
        self.rpc=Rpc(plan); self.clock=clock; self.hook=None; self.cancelled=0
        self.idle=i.ScopedEpochIdleRegistry(idle_sentinel=IDLE,clock=clock,protocol=protocol)
        self.budget=m.ScopedManagedDeadlineRpc(self.rpc,self.idle,clock,protocol=protocol); self.budget.begin_epoch()
    def turn(self, number): return {'kind':'turn','purpose':self.purposes[number-1],'requestRef':'request-'+str(number),'input':'Host-owned material'}
    def receive(self, seconds):
        self.receivers.add(threading.get_ident())
        try:return self.inbox.get(timeout=min(seconds,.005))
        except queue.Empty:return s.IDLE
    def emit(self, value, seconds):
        self.frames.append(copy.deepcopy(value))
        if self.hook and self.hook(value): return True
        kind=value['kind']
        if kind=='ready': self.inbox.put(self.turn(1))
        elif kind=='tool': self.inbox.put({'kind':'toolResult','purpose':value['purpose'],'requestRef':value['requestRef'],'callRef':value['callRef'],'result':copy.deepcopy(f.RESULT)})
        elif kind=='completed': self.inbox.put({'kind':'release','purpose':value['scope']['purpose'],'requestRef':value['scope']['requestRef'],'delivery':'not-sent'})
        elif kind=='released':
            n=int(value['requestRef'].split('-')[-1]); self.inbox.put(self.turn(n+1) if n<len(self.purposes) else {'kind':'close'})
        return True
    def factory(self, purpose, **ports):
        extra = {} if purpose=='conversation' else {'thread_config':{'web_search':'disabled','features.image_generation':False},'extra_tools':[f.extra(n) for n in s.ANALYSIS_NAMES]}
        if purpose=='community-assessment': extra={'thread_config':{'web_search':'disabled','features.image_generation':False},'isolation_mode':'community-assessment'}
        actor=e.create_native_image_epoch(f.m,c,f.SOURCE,profile=f.PROFILE,cwd=f.CWD,tool_spec=copy.deepcopy(f.SPEC),instructions='Host scoped synthetic material.',**extra,**ports)
        self.actors[purpose]=actor; return actor
    def cancel(self): self.cancelled+=1
    def run(self): return s.run_scoped_session(self.factory,self.receive,self.emit,self.idle,lambda p,t:True,self.cancel,budget=self.budget,clock=self.clock,tool_names=self.names,protocol=self.protocol)

class ScopedSessionTests(unittest.TestCase):
    def test_actual_composer_supervisor_wire_scoped_validator_native_and_rpc_write(self):
        import asyncio,base64,os,subprocess,tempfile
        client=load('album_client','rm-0032-standing-epoch-client.py')
        supervisor=load('album_supervisor','rm-0032-standing-epoch-supervisor.py')
        wire=load('album_wire','rm-0032-native-epoch-wire.py')
        native_rpc=load('album_rpc','rm-0032-native-rpc.py')
        epoch_rpc=load('album_epoch_rpc','rm-0032-native-epoch-rpc.py')
        fixture=os.environ.get('NEUROBRO_VISUAL_FIXTURE')
        if fixture:
            folder=Path(fixture);text=(folder/'fixture-packet.json').read_text(encoding='utf-8')
            pixels=[(folder/('fixture-'+str(n)+'.jpg')).read_bytes() for n in (1,2)]
        else:
            pixels=[b'\xff\xd8\xff'+bytes([n])*1357500 for n in (1,2)]
            module=(ROOT.parent.parent/'packages/telegram-gateway/dist/src/standing-model-input.js').as_uri()
            js="""import {conversationModelInput} from 'MODULE';
const primary={chatId:'-1001234567890',messageId:100,ownerId:'123456789',text:'Describe both pictures'};
const source={chatId:primary.chatId,messageId:101,authorId:primary.ownerId,author:'user',displayName:'Fixture',date:1,replyToMessageId:null,text:''};
console.log(conversationModelInput(primary,undefined,undefined,undefined,undefined,undefined,'not-configured','direct',{images:[100,101].map((messageId,i)=>({messageId,artifactRef:'art_'+String(i+1).repeat(48),byteLength:1357503,mimeType:'image/jpeg'})),provided:2,unavailable:false,sources:[source]}));""".replace('MODULE',module)
            text=subprocess.check_output(['node','--input-type=module','-e',js]).decode('utf-8').strip()
        frame={'kind':'turn','purpose':'conversation','requestRef':'request-1','input':text,'images':[{'mimeType':'image/jpeg','base64':base64.b64encode(raw).decode()} for raw in pixels]}
        async def bridge():
            writes=[];waiting=asyncio.Event();permit=asyncio.Event()
            class Writer:
                def write(self,data):writes.append(data)
                async def drain(self):waiting.set();await permit.wait()
                def close(self):pass
            values=iter([frame,{'kind':'close'}])
            async def receive(_):return next(values)
            gate=supervisor.OutputGate(client.normalize_result,supervisor.Budget());gate.ready=True
            task=asyncio.create_task(supervisor.forward_input(Writer(),receive,gate))
            await waiting.wait();self.assertFalse(task.done());permit.set();await task
            return wire.decode_frame(writes[0])
        decoded=asyncio.run(bridge());self.assertEqual(decoded,frame)
        self.assertGreater(len(json.dumps(frame)),3600000)
        host=Host(('conversation',));host.turn=lambda _:decoded
        def validate(purpose,value):
            self.assertEqual(purpose,'conversation');client.validate_request({'requestRef':'validation','conversation':value});return True
        result=s.run_scoped_session(host.factory,host.receive,host.emit,host.idle,validate,host.cancel,budget=host.budget,clock=host.clock,tool_names=NAMES)
        self.assertEqual(result['code'],'CLOSED',result)
        self.assertEqual(result['facts']['turnStartDispatches'],1)
        params=next(value for method,value in host.rpc.calls if method=='turn/start')
        self.assertEqual([item['url'] for item in params['input'][1:]],['data:image/jpeg;base64,'+item['base64'] for item in frame['images']])
        self.assertTrue(any(item['kind']=='released' for item in host.frames))
        self.assertTrue(result['facts']['closed']);self.assertFalse(result['facts']['unreleasedTurn'])
        cls=m.create_managed_rpc_class(native_rpc,epoch_rpc);rpc=cls.__new__(cls)
        rpc._profile='image';rpc._reserved_writes=rpc._reserved_visual_writes=rpc._write_bytes=rpc._writes=0
        rpc._check=lambda:None;rpc._time=lambda _:None;rpc._wait=lambda *a,**k:True
        envelope={'id':'offline','method':'turn/start','params':params}
        with tempfile.TemporaryFile() as output:
            rpc._write_fd=output.fileno();rpc._write(envelope,100)
            output.seek(0);encoded=output.read()
        self.assertEqual(native_rpc.decode_frame(encoded,profile='image'),envelope)
        self.assertEqual(rpc._write_bytes,len(encoded));self.assertEqual(rpc._writes,1)

    def test_conversation_visual_reaches_rpc_but_analysis_visual_is_refused(self):
        import base64
        encoded=base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
        visual=[{"mimeType":"image/png","base64":encoded}]
        host=Host(purposes=('conversation',))
        original=host.turn
        host.turn=lambda n:{**original(n),"images":visual}
        self.assertEqual(host.run()['code'],'CLOSED')
        params=next(p for method,p in host.rpc.calls if method=='turn/start')
        self.assertEqual(params['input'][1],{'type':'image','url':'data:image/png;base64,'+encoded})
        host=Host(purposes=('history-analysis',));original=host.turn
        host.turn=lambda n:{**original(n),"images":visual}
        self.assertEqual(host.run()['code'],'INPUT_REFUSED')
        self.assertEqual(host.rpc.calls,[])

    def test_two_actual_engines_three_serial_turns_and_scoped_callbacks(self):
        def plan(turn):
            n=int(turn.split('-')[-1])
            request=f.named_request(turn,s.ANALYSIS_NAMES[0],rpc_id=100+n,call_id='call-'+turn) if turn=='turn-2' else f.request(turn,100+n,'call-'+turn)
            return [request,f.completed(turn)]
        host=Host(plan=plan); result=host.run()
        self.assertEqual(result['code'],'CLOSED',result)
        completed=[x for x in host.frames if x['kind']=='completed']
        self.assertEqual([x['scope']['threadId'] for x in completed],['thread-1','thread-2','thread-1'])
        self.assertEqual([x['scope']['turnNumber'] for x in completed],[1,2,3])
        self.assertEqual([x['scope']['threadTurnNumber'] for x in completed],[1,1,2])
        self.assertEqual([x['purpose'] for x in host.frames if x['kind']=='tool'],list(host.purposes))
        self.assertEqual(result['facts']['threadStartDispatches'],2)
        self.assertEqual(result['facts']['turnStartDispatches'],3)
        self.assertEqual(result['facts']['turnsAdmitted'],3)
        self.assertFalse(result['facts']['unreleasedTurn'])
        self.assertFalse(result['facts']['resourceSettlementObserved'])
        self.assertEqual(len(host.receivers),1)
        starts=[p for method,p in host.rpc.calls if method=='thread/start']
        self.assertEqual([t['name'] for t in starts[1]['dynamicTools']],list(s.ANALYSIS_NAMES))
        self.assertEqual(starts[1]['config']['web_search'],'disabled')
        self.assertIs(starts[1]['config']['features.image_generation'],False)
        self.assertNotIn('thread-1',json.dumps(result))

    def test_unknown_thread_start_records_admission_and_dispatch_without_turn(self):
        host=Host();host.rpc.fail_thread=True;result=host.run()
        self.assertEqual(result['code'],'NATIVE_UNKNOWN')
        self.assertEqual(result['facts']['turnsAdmitted'],1)
        self.assertEqual(result['facts']['threadStartDispatches'],1)
        self.assertEqual(result['facts']['turnStartDispatches'],0)
        self.assertTrue(result['facts']['unreleasedTurn'])
        self.assertEqual(host.rpc.turn,0)
        self.assertNotIn('PRIVATE',json.dumps(result))

    def test_analysis_verified_release_refused_and_no_following_turn(self):
        host=Host(('history-analysis','conversation'))
        def hook(value):
            if value['kind']=='completed':
                host.inbox.put({'kind':'release','purpose':'history-analysis','requestRef':'request-1','delivery':'verified'});return True
        host.hook=hook; result=host.run()
        self.assertEqual(result['code'],'PROTOCOL_REFUSED')
        self.assertEqual(result['facts']['turnStartDispatches'],1)
        self.assertTrue(result['facts']['unreleasedTurn'])

    def test_wrong_scope_tool_result_cannot_cross_into_other_actor(self):
        host=Host(plan=lambda t:[f.request(t),f.completed(t)])
        def hook(value):
            if value['kind']=='tool':
                host.inbox.put({'kind':'toolResult','purpose':'history-analysis','requestRef':value['requestRef'],'callRef':value['callRef'],'result':f.RESULT});return True
        host.hook=hook;result=host.run()
        self.assertEqual(result['code'],'PROTOCOL_REFUSED');self.assertEqual(host.rpc.responses,[])
        self.assertEqual(result['facts']['turnStartDispatches'],1)

    def test_actual_scoped_wire_cap_keeps_once_only_closed_receipt(self):
        host=Host(('conversation',))
        ready={'kind':'ready','protocol':'standing-scoped-epoch-v1','scopes':[{'purpose':p,'tools':list(NAMES[p])} for p in s.SCOPED_PURPOSES]}
        with mock.patch.object(s,'EPOCH_WIRE_BYTES',s.wire_size(ready)-1): result=host.run()
        self.assertEqual(result['code'],'PROTOCOL_REFUSED')
        self.assertEqual([x['kind'] for x in host.frames],['closed'])
        self.assertEqual(result['facts']['turnStartDispatches'],0)

    def test_stop_during_callback_no_response_or_replay(self):
        host=Host(plan=lambda t:[f.request(t),f.completed(t)])
        def hook(value):
            if value['kind']=='tool':host.inbox.put({'kind':'close'});return True
        host.hook=hook;result=host.run()
        self.assertEqual(result['code'],'CLOSED');self.assertEqual(host.rpc.responses,[])
        self.assertTrue(result['facts']['unreleasedTurn'])
        self.assertEqual(result['facts']['turnStartDispatches'],1)

class ScopedBudgetTests(unittest.TestCase):
    def setUp(self):
        self.now=1.;self.rpc=Rpc();self.idle=i.ScopedEpochIdleRegistry(idle_sentinel=IDLE,clock=lambda:self.now)
        self.budget=m.ScopedManagedDeadlineRpc(self.rpc,self.idle,lambda:self.now);self.budget.begin_epoch()
    def complete(self,purpose,ref):
        number=self.budget.begin_turn(purpose,ref);slot=self.budget.slot(purpose)
        if purpose not in self.idle._threads:slot.exchange('thread/start',{},10)
        thread=self.idle._threads[purpose];slot.exchange('turn/start',{'threadId':thread},10)
        scope={'requestRef':ref,'threadId':thread,'turnId':'turn-'+str(number),'turnNumber':self.budget._slots[purpose]['turns']}
        self.budget.complete_turn(purpose,ref,scope);self.budget.release_turn(purpose,ref,'not-sent')
        self.rpc.frames=[]
    def test_shared_sixteen_turn_limit_across_two_slots(self):
        for n in range(16):self.complete(s.SCOPED_PURPOSES[n%2],'req-'+str(n))
        value=self.budget.begin_turn('conversation','req-17')
        self.assertEqual(value,{'kind':'notAdmitted','requestRef':'req-17','reason':'turns','turnsAdmitted':16})
        self.assertEqual(self.budget.counters(),{'threadStartDispatches':2,'turnStartDispatches':16})
    def test_shared_epoch_minimum_time_refusal_does_not_dispatch(self):
        self.now=602.;value=self.budget.begin_turn('history-analysis','req')
        self.assertEqual(value['reason'],'time');self.assertEqual(self.budget.counters()['turnStartDispatches'],0)
    def test_overlap_foreign_slot_and_third_scope_poison_before_dispatch(self):
        for operation in (lambda b:b.begin_turn('history-analysis','other'),lambda b:b.slot('history-analysis').exchange('thread/start',{},10),lambda b:b.slot('other')):
            self.setUp();self.budget.begin_turn('conversation','one')
            with self.assertRaises(m.ManagedDeadlineError):operation(self.budget)
            self.assertTrue(self.budget.scoped_counters()['retired']);self.assertEqual(self.rpc.calls,[])
    def test_inactive_event_consumed_but_request_and_unknown_thread_poison(self):
        self.complete('conversation','one');self.budget.begin_turn('history-analysis','two')
        slot=self.budget.slot('history-analysis');slot.exchange('thread/start',{},10);slot.exchange('turn/start',{'threadId':'thread-2'},10)
        event={'method':'thread/status/changed','params':{'threadId':'thread-1','status':{'type':'idle'}}}
        self.rpc.frames.insert(0,event);self.assertEqual(slot.next_frame(10)['method'],'turn/completed')
        self.assertEqual(self.idle.state()['frames'],1)
        for event in (f.request('turn-1'),{'method':'thread/status/changed','params':{'threadId':'foreign','status':{'type':'idle'}}}):
            registry=i.ScopedEpochIdleRegistry(idle_sentinel=IDLE);registry.start('conversation','thread-1');registry.complete('conversation','thread-1','turn-1',())
            with self.assertRaises(i.IdleError):registry.route(event,'history-analysis')
            self.assertTrue(registry.state()['poisoned'])
    def test_inactive_notifications_cannot_refresh_one_read_deadline(self):
        self.complete('conversation','one');self.budget.begin_turn('history-analysis','two')
        slot=self.budget.slot('history-analysis');slot.exchange('thread/start',{},10);slot.exchange('turn/start',{'threadId':'thread-2'},10)
        def frame(seconds):
            self.now+=.6
            return {'method':'thread/status/changed','params':{'threadId':'thread-1','status':{'type':'idle'}}}
        self.rpc.next_frame=frame
        with self.assertRaises(m.ManagedDeadlineError):slot.next_frame(1)
        self.assertLess(self.now,3.);self.assertTrue(self.budget.scoped_counters()['retired'])
    def test_notification_budget_not_reset_on_thread_completion(self):
        registry=i.ScopedEpochIdleRegistry(idle_sentinel=IDLE);registry.start('conversation','thread-1')
        event={'method':'thread/status/changed','params':{'threadId':'thread-1','status':{'type':'idle'}}}
        with mock.patch.object(i,'FRAME_COUNT',2):
            for n in range(2):registry.complete('conversation','thread-1','turn-'+str(n),());registry.route(event)
            registry.complete('conversation','thread-1','turn-3',())
            with self.assertRaises(i.IdleError):registry.route(event)


class ScopedV2Tests(unittest.TestCase):
    def host(self, purposes=('conversation','community-assessment','history-analysis','community-assessment')):
        return Host(purposes=purposes,protocol='standing-scoped-epoch-v2')

    def test_three_lazy_unique_threads_reuse_and_exact_v2_receipt(self):
        host=self.host();result=host.run()
        self.assertEqual(result['code'],'CLOSED',result)
        self.assertEqual(host.frames[0],{'kind':'ready','protocol':'standing-scoped-epoch-v2','scopes':[
            {'purpose':p,'tools':list(host.names[p])} for p in ('conversation','history-analysis','community-assessment')]})
        scopes=[v['scope'] for v in host.frames if v['kind']=='completed']
        self.assertEqual([v['threadId'] for v in scopes],['thread-1','thread-2','thread-3','thread-2'])
        self.assertEqual([v['turnNumber'] for v in scopes],[1,2,3,4])
        self.assertEqual([v['threadTurnNumber'] for v in scopes],[1,1,1,2])
        facts=result['facts'];self.assertEqual(facts['schema'],'neurobro-native-scoped-epoch-v2')
        self.assertEqual((facts['threadLimit'],facts['threadStartDispatches'],facts['turnStartDispatches']),(3,3,4))
        self.assertEqual((facts['turnLimit'],facts['epochSeconds'],facts['turnSeconds']),(16,900,300))
        self.assertEqual([v['purpose'] for v in facts['slots']],['conversation','history-analysis','community-assessment'])
        self.assertEqual(len(host.receivers),1)
        starts=[p for method,p in host.rpc.calls if method=='thread/start']
        self.assertEqual(starts[1]['dynamicTools'],[])
        self.assertEqual(starts[1]['config']['web_search'],'disabled')
        self.assertIs(starts[1]['config']['features.image_generation'],False)
        host=self.host(('community-assessment',));facts=host.run()['facts']
        self.assertEqual(facts['threadStartDispatches'],1)
        self.assertEqual([v['threadStarted'] for v in facts['slots']],[False,False,True])

    def test_v1_rejects_third_purpose_and_v2_rejects_nonempty_community_tools(self):
        host=Host(purposes=('community-assessment',));self.assertEqual(host.run()['code'],'PROTOCOL_REFUSED')
        self.assertEqual(host.rpc.calls,[])
        host=self.host();host.names['community-assessment']=('neurobro_other',)
        with self.assertRaises(ValueError):host.run()
        self.assertEqual(host.rpc.calls,[])

    def test_global_sixteen_turns_cannot_be_reset_by_third_thread(self):
        host=self.host(tuple(('conversation','community-assessment','history-analysis')[n%3] for n in range(17)))
        result=host.run();self.assertEqual(result['code'],'TURN_LIMIT',result)
        self.assertEqual(result['facts']['turnsAdmitted'],16)
        self.assertEqual(result['facts']['turnStartDispatches'],16)
        self.assertEqual(result['facts']['threadStartDispatches'],3)

    def test_community_images_tools_builtins_and_deliveries_fail_closed(self):
        host=self.host(('community-assessment',));original=host.turn
        host.turn=lambda n:{**original(n),'images':[]}
        self.assertEqual(host.run()['code'],'INPUT_REFUSED');self.assertEqual(host.rpc.calls,[])
        for delivery in ('verified','unknown'):
            host=self.host(('community-assessment',))
            def hook(frame):
                if frame['kind']=='completed':
                    host.inbox.put({'kind':'release','purpose':'community-assessment','requestRef':frame['scope']['requestRef'],'delivery':delivery});return True
                return False
            host.hook=hook;result=host.run()
            self.assertEqual(result['code'],'PROTOCOL_REFUSED',result)
            self.assertTrue(result['facts']['unreleasedTurn'])
        for plan in (lambda t:[f.request(t),f.completed(t)],
                     lambda t:[f.web_event(t,f.web_item()),f.completed(t)],
                     lambda t:[f.web_event(t,{'id':'image','type':'imageGeneration','status':'completed','result':'AAAA'}),f.completed(t)]):
            host=self.host(('community-assessment',));host.rpc.plan=plan;result=host.run()
            self.assertNotEqual(result['code'],'CLOSED',result)
            self.assertFalse(any(v['kind'] in ('tool','completed','imageBegin','imageChunk','imageEnd') for v in host.frames))
            self.assertEqual(host.rpc.responses,[])

    def test_v2_third_slot_overlap_duplicate_thread_and_deadlines_fail_closed(self):
        def setup():
            now=[0.];rpc=Rpc();idle=i.ScopedEpochIdleRegistry(idle_sentinel=IDLE,protocol='standing-scoped-epoch-v2')
            budget=m.ScopedManagedDeadlineRpc(rpc,idle,lambda:now[0],protocol='standing-scoped-epoch-v2');budget.begin_epoch()
            return now,rpc,idle,budget
        for overlap in ('conversation','history-analysis','community-assessment'):
            now,rpc,idle,budget=setup();budget.begin_turn('community-assessment','one')
            with self.assertRaises(m.ManagedDeadlineError):budget.begin_turn(overlap,'two')
            self.assertEqual(rpc.calls,[])
        now,rpc,idle,budget=setup();budget.begin_turn('community-assessment','one');slot=budget.slot('community-assessment')
        slot.exchange('thread/start',{},10);slot.exchange('turn/start',{'threadId':'thread-1'},10)
        budget.complete_turn('community-assessment','one',{'requestRef':'one','threadId':'thread-1','turnId':'turn-1','turnNumber':1})
        budget.release_turn('community-assessment','one','not-sent');budget.begin_turn('conversation','two');rpc.threads=0
        with self.assertRaises(m.ManagedDeadlineError):budget.slot('conversation').exchange('thread/start',{},10)
        self.assertEqual(budget.counters()['threadStartDispatches'],2);self.assertTrue(budget.scoped_counters()['retired'])
        now,rpc,idle,budget=setup();budget.begin_turn('community-assessment','one');now[0]=30
        with self.assertRaises(m.ManagedDeadlineError):budget.slot('community-assessment').exchange('thread/start',{},10)
        self.assertEqual(rpc.calls,[])
        now,rpc,idle,budget=setup();now[0]=871
        value=budget.begin_turn('community-assessment','one')
        self.assertEqual((value['reason'],value['turnsAdmitted']),('time',0));self.assertEqual(rpc.calls,[])

    def test_community_thirty_second_bound_retires_epoch_and_preserves_other_caps(self):
        for purpose,duration in (('community-assessment',30),('conversation',300),('history-analysis',300)):
            for elapsed in (duration-.001,duration):
                now=[0.];host=Host(purposes=(purpose,),protocol='standing-scoped-epoch-v2',clock=lambda:now[0])
                original=host.rpc.next_frame
                def frame(seconds):
                    self.assertLessEqual(seconds,duration);now[0]=elapsed;return original(seconds)
                host.rpc.next_frame=frame;result=host.run()
                self.assertEqual(result['facts']['turnSeconds'],300)
                if elapsed<duration:self.assertEqual(result['code'],'CLOSED',result)
                else:
                    self.assertEqual(result['code'],'NATIVE_UNKNOWN',result)
                    self.assertTrue(result['facts']['poisoned']);self.assertTrue(result['facts']['closed'])
                    self.assertTrue(host.budget.scoped_counters()['retired']);self.assertGreater(host.cancelled,0)
                    self.assertFalse(any(v['kind']=='completed' for v in host.frames))
                    before=len(host.rpc.calls)
                    with self.assertRaises(m.ManagedDeadlineError):host.budget.begin_turn('conversation','after-timeout')
                    self.assertEqual(len(host.rpc.calls),before)
        for purpose,late,expected in (('community-assessment',870,True),('community-assessment',870.001,False),('conversation',601,False),('history-analysis',601,False)):
            now=[0.];host=Host(purposes=(purpose,),protocol='standing-scoped-epoch-v2',clock=lambda:now[0])
            def hook(value):
                if value['kind']=='ready':now[0]=late
                return False
            host.hook=hook;result=host.run()
            self.assertEqual(result['code'],'CLOSED' if expected else 'EPOCH_LIMIT',result)
            self.assertEqual(result['facts']['turnStartDispatches'],int(expected))

    def test_protocol_mismatch_and_hostile_selection_refused_before_native(self):
        host=self.host();host.budget.protocol='standing-scoped-epoch-v1'
        with self.assertRaises(ValueError):host.run()
        for value in (None,True,2,[],{},'standing-scoped-epoch-v3'):
            with self.assertRaises(i.IdleError):i.ScopedEpochIdleRegistry(idle_sentinel=IDLE,protocol=value)
            with self.assertRaises(m.ManagedDeadlineError):m.ScopedManagedDeadlineRpc(Rpc(),host.idle,protocol=value)

if __name__=='__main__': unittest.main()
