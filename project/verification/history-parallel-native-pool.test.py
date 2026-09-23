"""Offline actual-engine/fake-child integration. No launch/model/network/auth."""
import copy
import base64
import importlib.util
import json
from pathlib import Path
import threading
import time
import types
import unittest

ROOT = Path(__file__).parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT/file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


m = load('parallel_pool', 'history-parallel-native-pool.py')
f = load('parallel_fixture', 'rm-0032-native-conversation.test.py')
epoch = load('parallel_epoch', 'rm-0032-native-image-epoch.py')
collector = load('parallel_collector', 'rm-0032-native-image-collector.py')
client = load('parallel_client', 'rm-0032-standing-epoch-client.py')


class Raw(f.Rpc):
    def __init__(self, proc, barrier=None, fail=False):
        super().__init__()
        self.proc, self.barrier, self.fail = proc, barrier, fail
        self.cancelled = threading.Event()
        self.readers = set()

    def admit_model(self): pass
    def cancel(self): self.cancelled.set()

    def exchange(self, method, params, timeout):
        self.readers.add(threading.get_ident())
        if method == 'turn/start':
            if self.barrier is not None:
                self.barrier.wait(timeout=3)
            if self.fail:
                raise RuntimeError('synthetic lost ACK')
        return super().exchange(method, params, timeout)


class Harness:
    def __init__(self, *, width=2, barrier=None, bad_settle=None, failed_index=None, budget=None):
        self.children, self.raws, self.actors, self.settled = [], [], [], []
        self.bad_settle = bad_settle

        def launch(purpose, index):
            proc = types.SimpleNamespace(pid=100+index)
            self.children.append(proc)
            return proc

        def rpc_factory(proc, budget):
            raw = Raw(proc, barrier, proc.pid == failed_index)
            self.raws.append(raw)
            return raw

        def actor_factory(rpc, purpose):
            opts = {} if purpose == 'conversation' else dict(extra_tools=client.ANALYSIS_EXTRA_TOOLS,
                     thread_config={'web_search':'disabled','features.image_generation':False})
            actor = epoch.create_native_image_epoch(f.m, collector, f.SOURCE,
                        profile=f.PROFILE, cwd=f.CWD, tool_spec=f.SPEC,
                        instructions='Synthetic isolated work', rpc=rpc,
                        tool=lambda params, seconds: copy.deepcopy(f.RESULT), **opts)
            self.actors.append(actor)
            return actor

        def settle(proc, raw, seconds):
            self.settled.append(proc)
            return dict(stdinClosed=True, stdoutEof=True, reaped=True,
                        stderrJoined=proc.pid != self.bad_settle, exitCode=0)

        self.pool = m.NativeWorkerPool(enabled=True, epoch_ref='epoch-test', analysis_workers=width,
             launch=launch, rpc_factory=rpc_factory, verify=lambda *args: True,
             actor_factory=actor_factory, settle=settle, budget=budget)
        self.pool.open()

    def submit(self, ref, purpose='history-analysis', **extra):
        return self.pool.submit(purpose=purpose, request_ref=ref, task_ref='task-a',
             plan_ref='wave-a', work_ref='work-'+ref, text='Synthetic text '+ref, **extra)


class PoolTests(unittest.TestCase):
    def test_shared_budget_revocation_expiry_and_clock_regression_are_distinct(self):
        for mode,expected in [('close','CANCELLED_UNKNOWN'),('expiry','DEADLINE_UNKNOWN'),('clock','CLOCK_UNKNOWN')]:
            now=[100.0];budget=m.SharedBudget(clock=lambda:now[0])
            if mode=='close':now[0]=163.6;budget.close()
            elif mode=='expiry':now[0]=1000.0
            else:now[0]=150.0;budget.remaining();now[0]=140.0
            with self.assertRaises(m.PoolError) as error:budget.remaining()
            self.assertEqual(error.exception.code,expected)
            timing=budget.failure_timing(100.0,'history-analysis',expected,None,None)
            self.assertEqual(timing['cause'],{'close':'cancelled','expiry':'epoch-deadline','clock':'clock-regressed'}[mode])
            if mode=='close':
                self.assertLess(timing['turnElapsedMs'],300000)
                self.assertEqual(timing['closeElapsedMs'],timing['epochElapsedMs'])

    def test_recorded_deadline_with_unavailable_diagnostic_clock_stays_serializable(self):
        now=[100.0];budget=m.SharedBudget(clock=lambda:now[0])
        now[0]=1000.0
        with self.assertRaises(m.PoolError) as error:budget.remaining()
        self.assertEqual(error.exception.code,'DEADLINE_UNKNOWN')
        for value in [None,999.0]:
            now[0]=value
            timing=budget.failure_timing(100.0,'history-analysis','DEADLINE_UNKNOWN',None,None)
            self.assertEqual(timing['cause'],'other')
            self.assertIsNone(timing['epochElapsedMs'])
            self.assertIsNone(timing['turnElapsedMs'])

    def test_owner_close_at_63_seconds_preserves_unknown_with_bounded_cancellation_timing(self):
        now=[100.0];h=Harness(width=1,budget=m.SharedBudget(clock=lambda:now[0]))
        raw=h.raws[1];original=raw.next_frame
        def close_during_next_frame(seconds):
            now[0]=163.6
            h.pool.budget.close();h.actors[1].close()
            return original(seconds)
        raw.next_frame=close_during_next_frame
        result=h.submit('owner-stop-63s').result(timeout=5)
        self.assertEqual(result['outcome'],'unknown')
        failure=h.pool.close()['children'][1]['turnFailure']
        self.assertEqual(failure['code'],'CANCELLED_UNKNOWN')
        self.assertEqual(failure['timing']['cause'],'cancelled')
        self.assertIn(failure['timing']['turnElapsedMs'],(63599,63600))
        self.assertEqual(failure['timing']['turnBudgetMs'],300000)
        self.assertIn(failure['timing']['closeElapsedMs'],(63599,63600))

    def test_actor_first_failure_is_not_replaced_by_cleanup_closed_budget(self):
        for site in ('deadline','events'):
            h=Harness(width=1);actor=h.actors[1]
            def failure(*args,**kwargs):
                h.pool.budget.close()
                return {'answer':None,'metadata':{'outcome':'unknown','code':'TRANSPORT_UNKNOWN','failureSite':site}}
            actor.turn=failure
            result=h.submit('first-cause').result(timeout=5)
            self.assertEqual(result['outcome'],'unknown')
            receipt=h.pool.close();failing=receipt['children'][1]['turnFailure']
            self.assertEqual(failing['code'],'RESULT_UNKNOWN')
            self.assertNotEqual(failing['code'],'DEADLINE_UNKNOWN')
            self.assertIsNotNone(failing['timing']['closeElapsedMs'])

    def test_success_racing_close_is_unknown_cancellation_not_deadline(self):
        h=Harness(width=1);actor=h.actors[1];original=actor.turn
        def close_after_result(*args,**kwargs):
            result=original(*args,**kwargs);h.pool.budget.close();return result
        actor.turn=close_after_result
        result=h.submit('race').result(timeout=5)
        self.assertEqual(result['outcome'],'unknown')
        failure=h.pool.close()['children'][1]['turnFailure']
        self.assertEqual(failure['code'],'CANCELLED_UNKNOWN')
        self.assertEqual(failure['timing']['cause'],'cancelled')

    def test_actual_engine_failure_survives_join_and_strict_receipt_without_private_text(self):
        h=Harness(failed_index=100)
        def context(worker,value):
            diagnostics={'nativeFailure':None}
            client.NativeFailureRecorder(diagnostics,('conversation','history-analysis','community-assessment')).capture(value,worker['purpose'])
            return dict(nativeFailure=diagnostics['nativeFailure'],rpcFailure=None)
        h.pool.turn_failure_context=context
        result=h.submit('failure','conversation').result(timeout=5)
        self.assertEqual(result['outcome'],'unknown')
        receipt=h.pool.close()
        failure=receipt['children'][0]['turnFailure']
        self.assertEqual((failure['stage'],failure['code']),('result','RESULT_UNKNOWN'))
        self.assertIsNotNone(failure['nativeFailure'])
        self.assertNotIn('synthetic lost ACK',json.dumps(receipt))
        envelope=dict(schema=client.PARALLEL_SCHEMA,outcome='unknown',code='SESSION_UNKNOWN',stage='session',
            injectedPorts=True,custodyChildren=[],pool=receipt,sessionCode='NATIVE_UNKNOWN')
        self.assertEqual(client.normalize_parallel_result(envelope),envelope)
        for mutate in (lambda v:v.__setitem__('sessionCode','private detail'),
                       lambda v:v['pool']['children'][0]['turnFailure'].__setitem__('code','private detail'),
                       lambda v:v['pool']['children'][0]['turnFailure']['nativeFailure'].__setitem__('site','private detail'),
                       lambda v:v['pool']['children'][0]['turnFailure']['nativeFailure'].__setitem__('purpose','community-assessment'),
                       lambda v:v['pool']['children'][0].__setitem__('pendingOutcome','observed')):
            invalid=copy.deepcopy(envelope);mutate(invalid)
            with self.assertRaises(ValueError):client.normalize_parallel_result(invalid)

    def test_prepare_exception_is_bounded_and_retained_after_clean_settlement(self):
        h=Harness()
        def fail(*args):raise RuntimeError('secret file and token')
        h.pool.prepare_turn=fail
        result=h.submit('prepare','conversation').result(timeout=5)
        self.assertEqual(result['outcome'],'unknown')
        receipt=h.pool.close()
        failure=receipt['children'][0]['turnFailure']
        self.assertEqual({k:v for k,v in failure.items() if k!='timing'},dict(stage='prepare',code='INTERNAL_UNKNOWN',nativeFailure=None,rpcFailure=None))
        self.assertEqual(failure['timing']['cause'],'other')
        self.assertIsNone(failure['timing']['turnElapsedMs'])
        self.assertNotIn('secret',json.dumps(receipt))

    def test_all_joined_children_receive_eof_before_first_child_is_drained(self):
        closed=set();children=[]
        def launch(purpose,index):
            proc=types.SimpleNamespace(pid=500+index);children.append(proc);return proc
        def raw(proc,budget):
            return types.SimpleNamespace(admit_model=lambda:None,cancel=lambda:None,
                close_input=lambda:closed.add(proc.pid),metadata=lambda:{'inputClosed':proc.pid in closed})
        def settle(proc,rpc,seconds):
            # A first child may depend on its siblings seeing EOF. The old
            # sequential close/drain implementation fails this dependency.
            self.assertEqual(closed,{p.pid for p in children})
            return dict(stdinClosed=True,stdoutEof=True,reaped=True,stderrJoined=True,exitCode=0)
        pool=m.NativeWorkerPool(enabled=True,epoch_ref='offline',analysis_workers=2,
            launch=launch,rpc_factory=raw,verify=lambda *args:True,
            actor_factory=lambda *args:types.SimpleNamespace(close=lambda:None),settle=settle)
        pool.open();receipt=pool.close()
        self.assertTrue(receipt['resourcesSettled'])
        self.assertTrue(all(c['cleanup']['stdinClosed'] for c in receipt['children']))

    def test_third_child_startup_failure_survives_failed_cleanup_without_dispatch(self):
        children=[];closed=set()
        failure={'code':'TRANSPORT_UNKNOWN','site':'eof','operation':'initialize','phase':'custody'}
        def launch(purpose,index):
            proc=types.SimpleNamespace(pid=600+index);children.append(proc);return proc
        def raw(proc,budget):
            return types.SimpleNamespace(admit_model=lambda:None,cancel=lambda:None,
                close_input=lambda:closed.add(proc.pid),metadata=lambda:{'inputClosed':proc.pid in closed})
        def verify(proc,*args):
            if proc.pid==602:raise m.PoolError('TRANSPORT_UNKNOWN')
            return True
        pool=m.NativeWorkerPool(enabled=True,epoch_ref='a'*32,analysis_workers=2,community_assessment=True,
            launch=launch,rpc_factory=raw,verify=verify,
            actor_factory=lambda *args:types.SimpleNamespace(close=lambda:None),
            startup_context=lambda worker:dict(custodyStage='initialize',probeIndex=None,rpcFailure=copy.deepcopy(failure)),
            settle=lambda proc,rpc,seconds:dict(stdinClosed=True,stdoutEof=proc.pid!=602,reaped=True,stderrJoined=True,exitCode=0))
        with self.assertRaises(m.PoolError):pool.open()
        receipt=pool.close();self.assertEqual(len(children),3);self.assertFalse(receipt['resourcesSettled'])
        self.assertEqual(receipt['startupFailure'],dict(workerId='worker-2',stage='custody',code='TRANSPORT_UNKNOWN',
            custodyStage='initialize',probeIndex=None,rpcFailure=failure))
        self.assertEqual(receipt['budget']['turnStartDispatches'],0)
        self.assertEqual(receipt['children'][2]['cleanup'],dict(attempted=True,stdinClosed=True,stdoutEof=False,reaped=True,stderrJoined=True,exitCode=0))
        envelope=dict(schema=client.PARALLEL_SCHEMA,outcome='unknown',code='SHUTDOWN_UNKNOWN',stage='shutdown',
            injectedPorts=True,custodyChildren=[],pool=receipt)
        self.assertEqual(client.normalize_parallel_result(envelope),envelope)
        for mutate in (lambda v:v['pool']['startupFailure'].__setitem__('code','private detail'),
                       lambda v:v['pool']['startupFailure']['rpcFailure'].__setitem__('operation','private-path'),
                       lambda v:v['pool']['startupFailure'].__setitem__('probeIndex',0),
                       lambda v:v['pool']['children'][2]['cleanup'].__setitem__('attempted',False),
                       lambda v:v['pool']['children'][2].__setitem__('resourcesSettled',True)):
            invalid=copy.deepcopy(envelope);mutate(invalid)
            with self.assertRaises(ValueError):client.normalize_parallel_result(invalid)

    def test_actual_engines_overlap_and_foreground_remains_available(self):
        h = Harness(barrier=threading.Barrier(3))
        try:
            a, b = h.submit('a'), h.submit('b')
            with self.assertRaisesRegex(m.PoolError, 'BUSY'):
                h.submit('c')
            c = h.submit('foreground', 'conversation')
            values = [f.result(timeout=4) for f in (a,b,c)]
            self.assertEqual([v['outcome'] for v in values], ['observed']*3)
            self.assertEqual(len({v['binding']['processId'] for v in values}), 3)
            # Native thread IDs may coincide across independent processes; exact
            # child ownership disambiguates them without relying on model labels.
            self.assertEqual({v['scope']['threadId'] for v in values}, {'thread-1'})
            self.assertTrue(all(len(raw.readers) == 1 for raw in h.raws))
            self.assertEqual(len(set.union(*(raw.readers for raw in h.raws))), 3)
            self.assertEqual(h.pool.budget.snapshot()['turnStartDispatches'], 3)
            for value in values:
                h.pool.release(value['binding'], 'not-sent')
            self.assertEqual(h.actors[1].tool_names(), client.ANALYSIS_TOOL_NAMES)
        finally:
            receipt = h.pool.close()
        self.assertTrue(receipt['resourcesSettled'])
        self.assertFalse(receipt['relaySettlementObserved'])
        self.assertEqual(h.settled, h.children)

    def test_exact_release_and_replay_guards(self):
        h = Harness(width=1)
        try:
            value = h.submit('a').result(3)
            changed = {**value['binding'], 'workRef':'different'}
            with self.assertRaises(m.PoolError): h.pool.release(changed, 'not-sent')
            with self.assertRaises(m.PoolError): h.pool.release(value['binding'], 'verified')
            h.pool.release(value['binding'], 'not-sent')
            with self.assertRaisesRegex(m.PoolError, 'REPLAY'): h.submit('a')
            next_value = h.submit('b').result(3)
            self.assertEqual(next_value['outcome'], 'observed')
            self.assertEqual(next_value['scope']['turnNumber'], 2)
        finally: h.pool.close()

    def test_aggregate_dispatch_reserves_foreground_and_unknown_is_consumed(self):
        h = Harness(width=1, budget=m.SharedBudget(turns=3, foreground_reserve=1))
        try:
            for ref in ('a','b'):
                value = h.submit(ref).result(3)
                self.assertEqual(value['outcome'], 'observed')
                h.pool.release(value['binding'], 'not-sent')
            refused = h.submit('c').result(3)
            self.assertEqual(refused['outcome'], 'not-admitted')
            # Aggregate admission refused before the raw turn/start call.
            self.assertEqual(h.raws[1].turn, 2)
            self.assertEqual(h.submit('front', 'conversation').result(3)['outcome'], 'observed')
            self.assertEqual(h.pool.budget.snapshot()['turnStartDispatches'], 3)
        finally: h.pool.close()

    def test_lost_ack_retires_exact_child_no_replay(self):
        h = Harness(failed_index=101)
        try:
            failed = h.submit('lost', worker_id='worker-1').result(3)
            self.assertEqual(failed['outcome'], 'unknown')
            self.assertEqual(h.pool.budget.snapshot()['turnStartDispatches'], 1)
            with self.assertRaises(m.PoolError): h.submit('lost')
            with self.assertRaises(m.PoolError): h.submit('new', worker_id='worker-1')
            self.assertEqual(h.submit('other', worker_id='worker-2').result(3)['outcome'], 'observed')
        finally: h.pool.close()

    def test_physical_partial_cleanup_never_grants_replacement(self):
        h = Harness(bad_settle=101)
        receipt = h.pool.close()
        self.assertFalse(receipt['replacementReady'])
        self.assertEqual(h.pool.close(), receipt)
        with self.assertRaises(m.PoolError): h.submit('late')

    def test_alias_and_uncertain_launch_not_accepted(self):
        h = Harness(width=1)
        h.pool.close()
        options = dict(enabled=True, epoch_ref='epoch', analysis_workers=1,
                rpc_factory=lambda *args: None, verify=lambda *args: True,
                actor_factory=lambda *args: None, settle=lambda *args: {})
        p = m.NativeWorkerPool(launch=lambda *args: (_ for _ in ()).throw(RuntimeError('lost launch')), **options)
        with self.assertRaises(RuntimeError): p.open()
        self.assertFalse(p.close()['replacementReady'])

    def test_shared_actual_raw_seams_reserve_before_io(self):
        budget = m.SharedBudget(read_bytes=65536, write_bytes=65536)
        events = []
        class Parent:
            _profile = 'image'
            def _write(self, frame, deadline): events.append(('write',frame))
            def _ingest(self): events.append(('read',None))
        shared = m.create_shared_rpc_class(Parent, lambda frame, profile: json.dumps(frame).encode(), budget)
        a, b = shared(), shared()
        a._ingest()
        with self.assertRaises(m.PoolError): b._ingest()
        a._write({'x':'small'}, budget.deadline)
        with self.assertRaises(m.PoolError): b._write({'x':'x'*65536}, budget.deadline)
        self.assertEqual([e[0] for e in events], ['read','write'])
        self.assertEqual(budget.snapshot()['reservedReadBytes'], 65536)

    def test_revocation_cancels_and_joins_actual_blocked_actor(self):
        h = Harness(width=1)
        raw = h.raws[1]
        entered = threading.Event()
        def blocked(method, params, timeout):
            if method == 'turn/start':
                entered.set()
                raw.cancelled.wait(timeout)
                raise RuntimeError('cancelled')
            return f.Rpc.exchange(raw, method, params, timeout)
        raw.exchange = blocked
        future = h.submit('blocked')
        self.assertTrue(entered.wait(2))
        receipt = h.pool.close(seconds=2)
        self.assertTrue(receipt['resourcesSettled'])
        self.assertTrue(future.done())
        self.assertEqual(future.result()['outcome'], 'unknown')

    def test_foreground_pixels_reach_native_without_leaking_into_next_request(self):
        h = Harness(width=1)
        encoded = base64.b64encode(b'\x89PNG\r\n\x1a\nsynthetic').decode()
        images = [{'mimeType':'image/png','base64':encoded}]
        try:
            result = h.submit('photo','conversation',images=images).result(3)
            self.assertEqual(result['outcome'],'observed')
            call = next(params for method,params in h.raws[0].calls if method=='turn/start')
            self.assertEqual(call['input'][1]['url'],'data:image/png;base64,'+encoded)
            h.pool.release(result['binding'],'not-sent')
            next_result = h.submit('after','conversation').result(3)
            self.assertEqual(next_result['outcome'],'observed')
            self.assertEqual(len(h.raws[0].calls[-1][1]['input']),1)
            with self.assertRaises(m.PoolError): h.submit('analysis-photo',images=images)
        finally: h.pool.close()

    def test_generated_image_export_remains_owned_until_explicit_release(self):
        h = Harness(width=1)
        png = base64.b64encode(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==')).decode()
        def plan(turn):
            item = dict(id='image-'+turn,type='imageGeneration',status='completed',result=png)
            return [dict(method='item/started',params=dict(threadId='thread-1',turnId=turn,startedAtMs=1,item={**item,'status':'in_progress','result':''})),
                    dict(method='item/completed',params=dict(threadId='thread-1',turnId=turn,completedAtMs=2,item=item)),
                    f.completed(turn,items=[item,f.message(turn,'Synthetic image')])]
        h.raws[0].plan = plan
        try:
            result = h.submit('generated','conversation').result(3)
            self.assertEqual(result['outcome'],'observed')
            self.assertTrue(result['value']['imageMetadata']['exportReady'])
            frames = list(h.actors[0].image_frames())
            self.assertGreater(len(frames),1)
            h.pool.release(result['binding'],'not-sent')
            with self.assertRaises(Exception): list(h.actors[0].image_frames())
        finally: h.pool.close()

    def test_exact_no_admission_after_previous_released_turn_is_preserved(self):
        h=Harness(width=1)
        try:
            value=h.submit('first').result(3)
            h.pool.release(value['binding'],'not-sent')
            before=h.pool.budget.snapshot()['turnStartDispatches']
            h.actors[1]._epoch_deadline=h.actors[1]._now()+299
            value=h.submit('too-late').result(3)
            self.assertEqual(value['outcome'],'not-admitted')
            self.assertEqual(value['value'],dict(kind='notAdmitted',requestRef='too-late',reason='time',turnsAdmitted=1))
            self.assertEqual(h.pool.budget.snapshot()['turnStartDispatches'],before)
        finally: h.pool.close()

    def test_atomic_last_global_analysis_slot_does_not_start_second_actor(self):
        h=Harness(width=2,budget=m.SharedBudget(turns=2,foreground_reserve=1))
        try:
            values=[h.submit('a',worker_id='worker-1'),h.submit('b',worker_id='worker-2')]
            outcomes=[f.result(3)['outcome'] for f in values]
            self.assertEqual(sorted(outcomes),['not-admitted','observed'])
            self.assertEqual(h.pool.budget.snapshot()['turnStartDispatches'],1)
            self.assertEqual(sum(raw.thread_started if hasattr(raw,'thread_started') else len([m for m,_ in raw.calls if m=='thread/start']) for raw in h.raws),1)
            self.assertEqual(h.submit('foreground','conversation').result(3)['outcome'],'observed')
        finally: h.pool.close()


if __name__ == '__main__': unittest.main()
