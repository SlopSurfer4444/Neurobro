"""Synthetic ports only: no native process, network, auth or live state."""
import concurrent.futures
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import queue
import threading
import time
import types
import unittest

spec = importlib.util.spec_from_file_location('parallel_session', Path(__file__).with_name('history-parallel-native-session.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
NAMES = {'conversation': ('neurobro_read_history',), 'history-analysis': s.ANALYSIS_NAMES}
RESULT = {'success': True, 'contentItems': [{'type': 'inputText', 'text': 'Host-bound material'}]}


class Actor:
    def __init__(self, purpose):
        self.purpose, self.closed, self.admitted = purpose, False, 0

    def tool_names(self):
        return NAMES.get(self.purpose, ())

    def image_frames(self):
        return iter(self.frames)

    def state(self):
        return {'schema': 'neurobro-native-image-epoch-v1', 'turnLimit': 16, 'epochSeconds': 900,
            'turnSeconds': 300, 'threadStarted': self.admitted > 0, 'poisoned': False, 'busy': False,
            'running': False, 'releasePending': False, 'closed': self.closed,
            'resourceSettlementObserved': False, 'turnsAdmitted': self.admitted,
            'turnsAttempted': self.admitted, 'toolCalls': self.admitted}


class FakePool:
    def __init__(self, tool, script=None, assessment=False):
        self.tool, self.script = tool, script
        self.epoch_ref = 'epoch-fixture'
        self.workers = [dict(id='worker-' + str(n), purpose=p, actor=Actor(p), proc=types.SimpleNamespace(pid=n+100))
            for n, p in enumerate(('conversation', 'history-analysis', 'history-analysis'))]
        if assessment:
            self.workers.append(dict(id='worker-3', purpose='community-assessment', actor=Actor('community-assessment'), proc=types.SimpleNamespace(pid=103)))
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        self.futures, self.releases, self.submits = [], [], []
        self.closed = False

    def open(self):
        return self

    def submit(self, *, purpose, request_ref, task_ref, plan_ref, work_ref, text, worker_id, images=None):
        worker = next(w for w in self.workers if w['id'] == worker_id)
        worker['actor'].admitted += 1
        input_bytes = text.encode() if images is None else json.dumps({'text': text, 'images': images}, ensure_ascii=False, separators=(',', ':')).encode()
        binding = dict(epochRef=self.epoch_ref, workerId=worker_id, processId=worker['proc'].pid,
            purpose=purpose, requestRef=request_ref, taskRef=task_ref, planRef=plan_ref, workRef=work_ref,
            inputSha256=hashlib.sha256(input_bytes).hexdigest())
        self.images = images
        self.submits.append(binding)

        def run():
            scope = dict(requestRef=request_ref, threadId='thread-' + worker_id,
                turnId='turn-' + request_ref, turnNumber=worker['actor'].admitted)
            params = dict(requestId=1, callId='call-' + request_ref, threadId=scope['threadId'],
                turnId=scope['turnId'], tool=NAMES.get(purpose, ('forbidden',))[0], namespace=None, arguments={'operation': 'read'})
            if self.script:
                scripted = self.script(self, binding, params)
                if scripted is not None:
                    return {'binding': binding, **scripted}
            elif purpose != 'community-assessment':
                self.tool(binding, params, 2)
            return dict(binding=binding, outcome='observed', scope=scope,
                value=dict(answer='Bound answer', metadata=dict(outcome='observed', code='OK',
                    turnCompleted=True, sessionPoisoned=False, toolCalls=1, toolRefusals=0),
                    imageMetadata=dict(exportReady=hasattr(worker['actor'], 'frames'))))
        future = self.executor.submit(run)
        self.futures.append(future)
        return future

    def release(self, binding, delivery):
        self.releases.append((copy.deepcopy(binding), delivery))

    def close(self):
        self.closed = True
        self.executor.shutdown(wait=True, cancel_futures=True)
        for w in self.workers:
            w['actor'].closed = True
        return {'schema': 'fake-pool-settlement', 'resourcesSettled': True,
                'replacementReady': True, 'relaySettlementObserved': False}


class Host:
    def __init__(self, script=None, hook=None, assessment=False):
        self.script, self.hook = script, hook
        self.assessment = assessment
        self.inbox = queue.Queue()
        self.frames = []
        self.receivers = set()
        self.emit_lock = threading.Lock()
        self.emit_overlap = False
        self.pool = None

    def turn(self, n, ref=None):
        purpose = 'conversation' if n == 0 else 'history-analysis'
        value = {'workerId': 'worker-' + str(n), 'frame': {'kind': 'turn', 'purpose': purpose,
            'requestRef': ref or 'request-' + str(n), 'input': 'Host owned material'}}
        if n:
            value['work'] = {'taskRef': 'task-A', 'planRef': 'plan-A', 'workRef': 'work-' + str(n)}
        return value

    def receive(self, seconds):
        self.receivers.add(threading.get_ident())
        try:
            return self.inbox.get(timeout=seconds)
        except queue.Empty:
            return s.IDLE

    def emit(self, value, seconds):
        if not self.emit_lock.acquire(blocking=False):
            self.emit_overlap = True
            return False
        try:
            self.frames.append(copy.deepcopy(value))
            if self.hook and self.hook(self, value):
                return True
            frame = value.get('frame', value)
            if frame['kind'] == 'tool':
                self.inbox.put({'workerId': value['workerId'], 'frame': {'kind': 'toolResult',
                    'purpose': frame['purpose'], 'requestRef': frame['requestRef'],
                    'callRef': frame['callRef'], 'result': copy.deepcopy(RESULT)}})
            elif frame['kind'] == 'completed':
                self.inbox.put({'workerId': value['workerId'], 'frame': {'kind': 'release',
                    'purpose': frame['scope']['purpose'], 'requestRef': frame['scope']['requestRef'], 'delivery': 'not-sent'}})
            return True
        finally:
            self.emit_lock.release()

    def run(self):
        def factory(**ports):
            self.pool = FakePool(ports['tool'], self.script, self.assessment)
            return self.pool
        timer = threading.Timer(4, lambda: self.inbox.put({'kind': 'close'}))
        timer.start()
        try:
            names = {**NAMES, **({'community-assessment': ()} if self.assessment else {})}
            return s.run_parallel_session(factory, self.receive, self.emit, lambda purpose, text: True, tool_names=names)
        finally:
            timer.cancel()


class SessionTests(unittest.TestCase):
    def test_large_escaped_result_admitted_only_for_analysis_worker(self):
        payload = '{}' + '\t' * (1088*1024 - 2)
        for worker in (1, 0):
            with self.subTest(worker=worker):
                def hook(host, value):
                    frame = value.get('frame', value)
                    if frame['kind'] == 'poolReady': host.inbox.put(host.turn(worker))
                    if frame['kind'] == 'tool':
                        host.inbox.put({'workerId':value['workerId'],'frame':{'kind':'toolResult','purpose':frame['purpose'],'requestRef':frame['requestRef'],'callRef':frame['callRef'],'result':{'success':True,'contentItems':[{'type':'inputText','text':payload}]}}})
                        return True
                    if frame['kind'] == 'released': host.inbox.put({'kind':'close'})
                host = Host(hook=hook); result = host.run()
                self.assertEqual(result['code'], 'CLOSED' if worker else 'PROTOCOL_REFUSED')
                self.assertEqual(len(host.pool.releases), 1 if worker else 0)

    def _real_processing_case(self, *, opt_in, elapsed, reply):
        # Real engine -> real session callback, synthetic RPC/host only. Advance
        # the injected clock after the request is emitted; no twenty-second sleep.
        fixture_spec = importlib.util.spec_from_file_location('native_timeout_fixture',
            Path(__file__).with_name('rm-0032-native-conversation.test.py'))
        fixture = importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(fixture)
        now, observed, timers = [100.0], {}, []
        def script(pool, binding, params):
            rpc = fixture.Rpc(lambda turn: [fixture.request(turn), fixture.completed(turn)])
            def callback(native_params, seconds):
                observed['callbackSeconds'] = seconds
                return pool.tool(binding, native_params, seconds)
            value = fixture.engine(rpc, callback, clock=lambda: now[0],
                tool_processing_deadline=opt_in).run('Synthetic read')
            value['imageMetadata'] = {'exportReady': False}
            observed.update(value=value, responses=rpc.responses)
            good = value['metadata']['outcome'] == 'observed'
            scope = dict(requestRef=binding['requestRef'], threadId='thread-1', turnId='turn-1', turnNumber=1) if good else None
            return dict(outcome='observed' if good else 'unknown', scope=scope, value=value)
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady': host.inbox.put(host.turn(0))
            if frame['kind'] == 'tool':
                def finish_processing():
                    now[0] += elapsed
                    if reply:
                        host.inbox.put({'workerId': value['workerId'], 'frame': {'kind': 'toolResult',
                            'purpose': frame['purpose'], 'requestRef': frame['requestRef'],
                            'callRef': frame['callRef'], 'result': copy.deepcopy(fixture.RESULT)}})
                timer = threading.Timer(.02, finish_processing)
                timers.append(timer); timer.start()
                return True
            if frame['kind'] == 'released': host.inbox.put({'kind': 'close'})
        host = Host(script, hook)
        def factory(**ports):
            host.pool = FakePool(ports['tool'], script)
            return host.pool
        def emit(value, seconds):
            self.assertLessEqual(seconds, 20)  # Processing never expands wire I/O.
            return host.emit(value, seconds)
        result = s.run_parallel_session(factory, host.receive, emit,
            lambda purpose, text: True, tool_names=NAMES, clock=lambda: now[0])
        for timer in timers: timer.join()
        self.assertTrue(host.pool.closed)
        self.assertTrue(all(f.done() for f in host.pool.futures))
        self.assertEqual(sum(v.get('frame', {}).get('kind') == 'tool' for v in host.frames), 1)
        self.assertNotIn('sessionFailure', host.frames[-1])
        return result, observed, host

    def test_real_engine_tool_wait_timeout_is_not_native_transport_failure(self):
        result, observed, host = self._real_processing_case(opt_in=False, elapsed=20.001, reply=False)
        self.assertEqual(result['code'], 'IO_UNKNOWN')
        self.assertEqual(result['sessionFailure'], {'site': 'tool_wait', 'purpose': 'conversation', 'toolName': 'neurobro_read_history'})
        self.assertEqual(observed['callbackSeconds'], 20)
        metadata = observed['value']['metadata']
        self.assertEqual(metadata['code'], 'TRANSPORT_UNKNOWN')
        self.assertEqual(metadata['failureSite'], 'observer_or_transport')
        self.assertEqual(metadata['observer']['site'], 'none')
        self.assertEqual(metadata['toolCalls'], 1)
        self.assertEqual(observed['responses'], [])
        self.assertEqual(host.pool.releases, [])

    def test_opt_in_real_engine_processing_25_seconds_completes_once(self):
        result, observed, host = self._real_processing_case(opt_in=True, elapsed=25, reply=True)
        self.assertEqual(result['code'], 'CLOSED')
        self.assertNotIn('sessionFailure', result)
        self.assertEqual(observed['callbackSeconds'], 125)
        self.assertEqual(observed['value']['metadata']['code'], 'OK')
        self.assertEqual(len(observed['responses']), 1)
        self.assertEqual(len(host.pool.releases), 1)

    def test_opt_in_processing_deadline_remains_consumed_and_not_replayed(self):
        for reply in (False, True):
            with self.subTest(late_reply=reply):
                result, observed, host = self._real_processing_case(opt_in=True, elapsed=125.001, reply=reply)
                self.assertEqual(result['code'], 'IO_UNKNOWN')
                self.assertEqual(result['sessionFailure']['site'], 'tool_wait')
                self.assertEqual(observed['value']['metadata']['code'], 'TRANSPORT_UNKNOWN')
                self.assertEqual(observed['responses'], [])
                self.assertEqual(host.pool.releases, [])

    def test_three_independent_workers_overlap_and_out_of_order_result_stays_bound(self):
        barrier = threading.Barrier(3)
        first_completed = threading.Event()
        order = []
        def script(pool, binding, params):
            barrier.wait(timeout=2)
            pool.tool(binding, params, 2)
            if binding['workerId'] != 'worker-2':
                if not first_completed.wait(timeout=2):
                    raise AssertionError('first completion not observed')
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                for n in (1, 2, 0):
                    host.inbox.put(host.turn(n))
            if frame['kind'] == 'completed':
                order.append(value['workerId'])
                if value['workerId'] == 'worker-2':
                    first_completed.set()
            if frame['kind'] == 'released' and len(host.pool.releases) == 3:
                host.inbox.put({'kind': 'close'})
        host = Host(script, hook)
        result = host.run()
        self.assertEqual(result['code'], 'CLOSED')
        self.assertEqual(len(host.receivers), 1)
        self.assertFalse(host.emit_overlap)
        self.assertEqual(order[0], 'worker-2')
        self.assertEqual(len(host.pool.releases), 3)
        self.assertTrue(all(f.done() for f in host.pool.futures))
        self.assertEqual([v.get('frame', {}).get('kind') for v in host.frames[-4:-1]], ['closed'] * 3)
        self.assertEqual(host.frames[-1]['kind'], 'poolClosed')
        for value in host.frames:
            frame = value.get('frame', value)
            if frame['kind'] == 'completed':
                self.assertEqual(set(frame['scope']), {'purpose', 'requestRef', 'threadId', 'turnId', 'turnNumber'})
                self.assertEqual(frame['scope']['threadId'], 'thread-' + value['workerId'])

    def test_close_wakes_waiting_callback_and_joins_before_receipt(self):
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                host.inbox.put(host.turn(1))
            if frame['kind'] == 'tool':
                host.inbox.put({'kind': 'close'})
                return True
        host = Host(hook=hook)
        result = host.run()
        self.assertEqual(result['code'], 'CLOSED')
        self.assertNotIn('sessionFailure', result)
        self.assertTrue(host.pool.closed)
        self.assertTrue(host.pool.futures[0].done())
        self.assertEqual(host.pool.releases, [])
        worker_closed = next(v['frame'] for v in host.frames if v.get('workerId') == 'worker-1' and v['frame']['kind'] == 'closed')
        self.assertTrue(worker_closed['facts']['unreleasedTurn'])

    def test_wrong_worker_tool_result_is_refused(self):
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                host.inbox.put(host.turn(1))
            if frame['kind'] == 'tool':
                host.inbox.put({'workerId': 'worker-2', 'frame': {'kind': 'toolResult',
                    'purpose': frame['purpose'], 'requestRef': frame['requestRef'],
                    'callRef': frame['callRef'], 'result': RESULT}})
                return True
        host = Host(hook=hook)
        self.assertEqual(host.run()['code'], 'PROTOCOL_REFUSED')
        self.assertEqual(host.pool.releases, [])

    def test_binding_tamper_never_reaches_host_tool(self):
        for key, value in (('workRef', 'wrong'), ('planRef', 'wrong'), ('processId', 999),
                           ('inputSha256', '0' * 64), ('epochRef', 'wrong')):
            with self.subTest(key=key):
                def script(pool, binding, params):
                    pool.tool({**binding, key: value}, params, 2)
                def hook(host, value):
                    if value.get('kind') == 'poolReady':
                        host.inbox.put(host.turn(1))
                host = Host(script, hook)
                self.assertEqual(host.run()['code'], 'PROTOCOL_REFUSED')
                self.assertFalse(any(v.get('frame', {}).get('kind') == 'tool' for v in host.frames))

    def test_duplicate_request_cannot_be_dispatched_to_second_child(self):
        def hook(host, value):
            if value.get('kind') == 'poolReady':
                host.inbox.put(host.turn(1, 'same-request'))
                host.inbox.put(host.turn(2, 'same-request'))
        host = Host(hook=hook)
        self.assertEqual(host.run()['code'], 'PROTOCOL_REFUSED')
        self.assertEqual(len(host.pool.submits), 1)

    def test_oversize_input_and_unbound_work_are_pre_dispatch_refusals(self):
        for mutation in ('large', 'missing-work', 'foreground-work', 'images', 'extra-work'):
            with self.subTest(mutation=mutation):
                def hook(host, value):
                    if value.get('kind') != 'poolReady':
                        return
                    turn = host.turn(0 if mutation == 'foreground-work' else 1)
                    if mutation == 'large':
                        turn['frame']['input'] = 'x' * 24577
                    elif mutation == 'missing-work':
                        del turn['work']
                    elif mutation == 'foreground-work':
                        turn['work'] = {'taskRef': 'task', 'planRef': 'plan', 'workRef': 'work'}
                    elif mutation == 'images':
                        turn['frame']['images'] = []
                    else:
                        turn['work']['private'] = 'forbidden'
                    host.inbox.put(turn)
                host = Host(hook=hook)
                self.assertIn(host.run()['code'], ('INPUT_REFUSED', 'PROTOCOL_REFUSED'))
                self.assertEqual(host.pool.submits, [])

    def test_early_release_is_refused_and_not_replayed(self):
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                host.inbox.put(host.turn(1))
            if frame['kind'] == 'tool':
                host.inbox.put({'workerId': 'worker-1', 'frame': {'kind': 'release',
                    'purpose': 'history-analysis', 'requestRef': frame['requestRef'], 'delivery': 'not-sent'}})
                return True
        host = Host(hook=hook)
        self.assertEqual(host.run()['code'], 'PROTOCOL_REFUSED')
        self.assertEqual(host.pool.releases, [])

    def test_cross_turn_native_scope_is_refused(self):
        def script(pool, binding, params):
            pool.tool(binding, params, 2)
            pool.tool(binding, {**params, 'callId': 'second-call', 'turnId': 'other-turn'}, 2)
        def hook(host, value):
            if value.get('kind') == 'poolReady':
                host.inbox.put(host.turn(1))
        host = Host(script, hook)
        self.assertEqual(host.run()['code'], 'PROTOCOL_REFUSED')
        self.assertEqual(sum(v.get('frame', {}).get('kind') == 'tool' for v in host.frames), 1)

    def test_foreground_images_cross_size_boundary_and_are_hashed_canonically(self):
        raw = b'\xff\xd8\xff' + b'x' * 700000
        image = {'base64': base64.b64encode(raw).decode(), 'mimeType': 'image/jpeg'}
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                turn = host.turn(0)
                turn['frame']['images'] = [image]
                host.inbox.put(turn)
            if frame['kind'] == 'released':
                host.inbox.put({'kind': 'close'})
        host = Host(hook=hook)
        self.assertEqual(host.run()['code'], 'CLOSED')
        self.assertEqual(host.pool.images, [image])
        self.assertEqual(list(host.pool.images[0]), ['mimeType', 'base64'])
        self.assertEqual(len(host.pool.releases), 1)

    def test_foreground_image_output_preserves_order_and_worker_envelope(self):
        frames = [{'kind': 'imageBegin', 'artifact': {'ref': 'artifact-fixture'}},
            {'kind': 'imageChunk', 'artifactRef': 'artifact-fixture', 'sequence': 0, 'dataBase64': 'eA=='},
            {'kind': 'imageEnd', 'artifactRef': 'artifact-fixture', 'chunkCount': 1}]
        def script(pool, binding, params):
            pool.workers[0]['actor'].frames = frames
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                host.inbox.put(host.turn(0))
            if frame['kind'] == 'released':
                host.inbox.put({'kind': 'close'})
        host = Host(script, hook)
        self.assertEqual(host.run()['code'], 'CLOSED')
        values = [v['frame'] for v in host.frames if v.get('workerId') == 'worker-0']
        self.assertEqual([v['kind'] for v in values], ['ready', 'scope', 'imageBegin', 'imageChunk', 'imageEnd', 'completed', 'released', 'closed'])
        self.assertEqual(values[2:5], frames)
        self.assertEqual(values[5]['kindOfAnswer'], 'image')

    def test_optional_assessor_stays_toolfree_and_bound_without_history_work(self):
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                host.inbox.put({'workerId': 'worker-3', 'frame': {'kind': 'turn',
                    'purpose': 'community-assessment', 'requestRef': 'assessment-1', 'input': 'Packed assessment'}})
            if frame['kind'] == 'released':
                host.inbox.put({'kind': 'close'})
        host = Host(hook=hook, assessment=True)
        self.assertEqual(host.run()['code'], 'CLOSED')
        binding = host.pool.submits[0]
        self.assertEqual(binding['taskRef'], 'community-assessment')
        self.assertEqual(binding['planRef'], 'community-assessment')
        self.assertEqual(binding['workRef'], 'assessment-1')
        self.assertFalse(any(v.get('frame', {}).get('kind') == 'tool' for v in host.frames))

    def test_close_during_image_export_stops_before_next_chunk(self):
        close_seen = threading.Event()
        def script(pool, binding, params):
            pool.workers[0]['actor'].frames = [{'kind': 'imageBegin', 'artifact': {}},
                {'kind': 'imageChunk', 'dataBase64': 'eA=='}]
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                host.inbox.put(host.turn(0))
            if frame['kind'] == 'imageBegin':
                host.inbox.put({'kind': 'close'})
                # Model-independent evidence: the sole receiver consumes close
                # while this serialized output callback is still running.
                self.assertTrue(close_seen.wait(timeout=1))
        host = Host(script, hook)
        original_receive = host.receive
        def receive(seconds):
            frame = original_receive(seconds)
            if frame == {'kind': 'close'}:
                close_seen.set()
            return frame
        host.receive = receive
        self.assertEqual(host.run()['code'], 'CLOSED')
        self.assertFalse(any(v.get('frame', {}).get('kind') in ('imageChunk', 'completed') for v in host.frames))
        self.assertEqual(host.pool.releases, [])

    def test_release_failure_is_unknown_and_does_not_emit_released(self):
        def hook(host, value):
            if value.get('kind') == 'poolReady':
                def fail_release(*args):
                    raise OSError('PRIVATE sentinel must not reach output')
                host.pool.release = fail_release
                host.inbox.put(host.turn(1))
        host = Host(hook=hook)
        self.assertEqual(host.run()['code'], 'RELEASE_UNKNOWN')
        self.assertFalse(any(v.get('frame', {}).get('kind') == 'released' for v in host.frames))
        self.assertNotIn('PRIVATE', json.dumps(host.frames))

    def test_exact_not_admitted_retires_only_one_worker_and_preserves_peer_completion(self):
        refusal_observed = threading.Event()
        def script(pool, binding, params):
            if binding['workerId'] == 'worker-1':
                pool.workers[1]['actor'].admitted -= 1
                return {'outcome': 'not-admitted', 'scope': None, 'value': {'kind': 'notAdmitted',
                    'requestRef': binding['requestRef'], 'reason': 'time', 'turnsAdmitted': 0}}
            self.assertTrue(refusal_observed.wait(timeout=2))
            pool.tool(binding, params, 2)
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                host.inbox.put(host.turn(1))
                host.inbox.put(host.turn(2))
            if frame['kind'] == 'notAdmitted':
                self.assertEqual(value['workerId'], 'worker-1')
                self.assertEqual(frame, {'kind': 'notAdmitted', 'purpose': 'history-analysis',
                    'requestRef': 'request-1', 'reason': 'time', 'turnsAdmitted': 0})
                refusal_observed.set()
            if frame['kind'] == 'released':
                host.inbox.put({'kind': 'close'})
        host = Host(script, hook)
        self.assertEqual(host.run()['code'], 'CLOSED')
        self.assertEqual(len(host.pool.releases), 1)
        self.assertEqual(host.pool.releases[0][0]['workerId'], 'worker-2')
        self.assertEqual(len(host.pool.submits), 2)
        refused = [v['frame'] for v in host.frames if v.get('workerId') == 'worker-1']
        self.assertEqual([f['kind'] for f in refused], ['ready', 'notAdmitted', 'closed'])
        self.assertFalse(refused[-1]['facts']['unreleasedTurn'])

    def test_malformed_not_admitted_proof_remains_unknown(self):
        for mutation in ('scope', 'request', 'reason', 'count', 'bool-count', 'extra', 'kind'):
            with self.subTest(mutation=mutation):
                def script(pool, binding, params):
                    result = {'outcome': 'not-admitted', 'scope': None, 'value': {'kind': 'notAdmitted',
                        'requestRef': binding['requestRef'], 'reason': 'time', 'turnsAdmitted': 0}}
                    if mutation == 'scope':
                        result['scope'] = {'requestRef': binding['requestRef']}
                    else:
                        key, value = {'request': ('requestRef', 'wrong'), 'reason': ('reason', 'unknown'),
                            'count': ('turnsAdmitted', 17), 'bool-count': ('turnsAdmitted', False),
                            'extra': ('extra', True), 'kind': ('kind', 'completed')}[mutation]
                        result['value'][key] = value
                    return result
                def hook(host, value):
                    if value.get('kind') == 'poolReady':
                        host.inbox.put(host.turn(1))
                host = Host(script, hook)
                self.assertEqual(host.run()['code'], 'NATIVE_UNKNOWN')
                self.assertFalse(any(v.get('frame', {}).get('kind') == 'notAdmitted' for v in host.frames))
                self.assertEqual(host.pool.releases, [])

    def test_retired_worker_cannot_accept_new_turn_after_not_admitted(self):
        def script(pool, binding, params):
            return {'outcome': 'not-admitted', 'scope': None, 'value': {'kind': 'notAdmitted',
                'requestRef': binding['requestRef'], 'reason': 'turns', 'turnsAdmitted': 16}}
        def hook(host, value):
            frame = value.get('frame', value)
            if frame['kind'] == 'poolReady':
                host.inbox.put(host.turn(1))
            if frame['kind'] == 'notAdmitted':
                host.inbox.put(host.turn(1, 'second-request'))
        host = Host(script, hook)
        self.assertEqual(host.run()['code'], 'PROTOCOL_REFUSED')
        self.assertEqual(len(host.pool.submits), 1)
        self.assertEqual(host.pool.releases, [])


if __name__ == '__main__':
    unittest.main()
