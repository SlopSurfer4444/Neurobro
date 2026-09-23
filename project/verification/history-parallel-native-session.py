"""Opt-in multiplexed guest wire; supplied pool owns all native resources.

No process, credentials, filesystem or network access. The single calling
thread receives frames; independent native callbacks wait on bounded slots.
Ports must honor deadlines. A close wakes callbacks before joining the pool.
"""
import base64
import hashlib
import json
import math
import queue
import re
import threading
import time
import uuid

PROTOCOL = 'standing-parallel-epoch-v1'
IDLE = object()
FRAME_BYTES = 3 * 1024 * 1024
INPUT_FRAME_BYTES = 12 * 1024 * 1024
WIRE_BYTES = 512 * 1024 * 1024
ANALYSIS_NAMES = ('neurobro_analysis_material', 'neurobro_analysis_notes', 'neurobro_analysis_commit')
BINDING_KEYS = {'epochRef', 'workerId', 'processId', 'purpose', 'requestRef', 'taskRef', 'planRef', 'workRef', 'inputSha256'}
FACT_KEYS = {'threadStarted', 'poisoned', 'busy', 'turnsAttempted', 'toolCalls', 'schema',
             'turnsAdmitted', 'turnLimit', 'epochSeconds', 'turnSeconds', 'running',
             'releasePending', 'closed', 'resourceSettlementObserved'}


class SessionStop(Exception):
    def __init__(self, code):
        self.code = code


def exact(value, keys):
    return type(value) is dict and set(value) == set(keys)


def identifier(value):
    return type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value) is not None


def require(ok, code='PROTOCOL_REFUSED'):
    if not ok:
        raise SessionStop(code)


def wire_size(value):
    try:
        return len(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')) + 1
    except Exception:
        raise SessionStop('PROTOCOL_REFUSED') from None


def safe_facts(value, unreleased):
    require(exact(value, FACT_KEYS), 'NATIVE_UNKNOWN')
    require(all(type(value[k]) is bool for k in ('threadStarted', 'poisoned', 'busy', 'running',
            'releasePending', 'closed', 'resourceSettlementObserved')), 'NATIVE_UNKNOWN')
    require(all(type(value[k]) is int and 0 <= value[k] <= cap for k, cap in
            (('turnsAttempted', 16), ('turnsAdmitted', 16), ('toolCalls', 193))), 'NATIVE_UNKNOWN')
    require(value['schema'] == 'neurobro-native-image-epoch-v1' and value['turnLimit'] == 16
            and value['epochSeconds'] == 900 and value['turnSeconds'] == 300
            and value['resourceSettlementObserved'] is False, 'NATIVE_UNKNOWN')
    return {**value, 'unreleasedTurn': unreleased is True}


def visual_input(images):
    require(type(images) is list and 1 <= len(images) <= 2, 'INPUT_REFUSED')
    total, canonical = 0, []
    for image in images:
        require(exact(image, {'mimeType', 'base64'}) and image['mimeType'] in ('image/png', 'image/jpeg')
                and type(image['base64']) is str and len(image['base64']) <= 11184812, 'INPUT_REFUSED')
        try:
            raw = base64.b64decode(image['base64'], validate=True)
        except Exception:
            raise SessionStop('INPUT_REFUSED') from None
        total += len(raw)
        require(raw and total <= 8 * 1024 * 1024
                and base64.b64encode(raw).decode('ascii') == image['base64']
                and raw.startswith(b'\x89PNG\r\n\x1a\n' if image['mimeType'] == 'image/png' else b'\xff\xd8\xff'), 'INPUT_REFUSED')
        canonical.append({'mimeType': image['mimeType'], 'base64': image['base64']})
    return canonical


def run_parallel_session(pool_factory, receive, emit, validate_input, *, tool_names,
                         clock=time.monotonic, call_ref_factory=lambda: str(uuid.uuid4())):
    """factory(tool=bound_callback, clock=clock)->unopened NativeWorkerPool.

    Input: {workerId,frame}, with work:{taskRef,planRef,workRef} added ONLY
    for history turn. Global close is {kind:'close'}. Inner turn/toolResult/
    release frames retain their scoped shape. Foreground work is host-derived.
    Outputs: poolReady:{kind,protocol,workers:[{workerId,purpose}]}; every
    other ordinary output is {workerId,frame}. Inner ready:{kind,protocol,
    scopes:[{purpose,tools}]}; tool:{kind,purpose,requestRef,callRef,name,arguments};
    scope:{kind,scope}; completed:{kind,scope,answer,kindOfAnswer,toolCalls,
    toolRefusals}; scope is EXACT {purpose,requestRef,threadId,turnId,turnNumber}.
    released:{kind,purpose,requestRef,delivery}; image frames are unchanged.
    notAdmitted:{kind,purpose,requestRef,reason,turnsAdmitted} retires only that
    worker. Its exact reservation remains in the final pool receipt, without
    any fabricated release; other workers keep completing their admitted work.
    closed:{kind,code,facts} uses actual legacy native image actor state plus
    unreleasedTurn. The last outer control frame is poolClosed:{kind,protocol,
    code,receipt}, with the exact pool.close() receipt. Foreground input images
    retain the native image epoch's two-image, eight-MiB total decoded bound.

    A selected worker has at most one running or unreleased request. Bindings
    stay private and are rechecked for every callback/completion/release.
    """
    if not all(callable(x) for x in (pool_factory, receive, emit, validate_input, clock, call_ref_factory)):
        raise ValueError('parallel-session-config-refused')
    if (type(tool_names) is not dict or set(tool_names) not in ({'conversation', 'history-analysis'}, {'conversation', 'history-analysis', 'community-assessment'})
            or tool_names['history-analysis'] != ANALYSIS_NAMES
            or ('community-assessment' in tool_names and tool_names['community-assessment'] != ())
            or type(tool_names['conversation']) is not tuple or not tool_names['conversation']
            or tool_names['conversation'][0] != 'neurobro_read_history'):
        raise ValueError('parallel-session-tools-refused')
    for names in tool_names.values():
        if (len(names) > 32 or len(set(names)) != len(names)
                or any(type(n) is not str or re.fullmatch(r'neurobro_[a-z][a-z0-9_]{0,54}', n) is None for n in names)):
            raise ValueError('parallel-session-tools-refused')
    started = clock()
    require(type(started) in (int, float) and math.isfinite(started), 'INTERNAL_UNKNOWN')
    deadline = started + 900
    condition = threading.Condition(threading.RLock())
    output_lock = threading.Lock()
    inbox = queue.Queue(maxsize=32)
    receiver = None
    pool = None
    workers, active = {}, {}
    seen_requests, seen_calls, seen_native_calls = set(), set(), set()
    totals = {'in': 0, 'out': 0}
    stop = None
    session_failure = None

    def diagnose(site, purpose=None, tool_name=None):
        nonlocal stop, session_failure
        with condition:
            # Cause and stop are one transition: a later timeout cannot replace
            # an earlier owner close, epoch limit, or another failure.
            if stop is None:
                stop = 'IO_UNKNOWN'
                session_failure = {'site': site, 'purpose': purpose, 'toolName': tool_name}
                condition.notify_all()

    def remaining(end=deadline, cap=20):
        now = clock()
        require(type(now) in (int, float) and math.isfinite(now) and now >= started, 'INTERNAL_UNKNOWN')
        require(now < min(end, deadline), 'EPOCH_LIMIT' if now >= deadline else 'IO_UNKNOWN')
        return min(cap, min(end, deadline) - now)

    def halt(code):
        nonlocal stop
        with condition:
            if stop is None:
                stop = code
            condition.notify_all()

    def check():
        if stop is not None:
            raise SessionStop(stop)

    def count(direction, value):
        size = wire_size(value)
        inner = value.get('frame') if type(value) is dict else None
        cap = (INPUT_FRAME_BYTES if direction == 'in' and type(inner) is dict
               and inner.get('kind') == 'turn' and 'images' in inner else FRAME_BYTES)
        require(size <= cap and totals[direction] + size <= WIRE_BYTES)
        totals[direction] += size

    def write(value, end=deadline):
        with output_lock:
            check()
            count('out', value)  # Uncertain writes are consumed; never replay.
            try:
                require(emit(value, remaining(end)) is True, 'IO_UNKNOWN')
            except SessionStop as error:
                if error.code == 'IO_UNKNOWN': diagnose('wire_emit')
                raise
            except Exception:
                diagnose('wire_emit')
                raise SessionStop('IO_UNKNOWN') from None
            remaining(end)
            check()

    def worker_write(worker_id, frame, end=deadline):
        write({'workerId': worker_id, 'frame': frame}, end)

    def receive_pump():
        # Keep close/EOF observable while the caller exports image frames.
        # This is the ONLY caller of the input port; the mailbox is bounded.
        try:
            while True:
                check()
                value = receive(remaining(cap=.05))
                check()
                remaining()
                if value is IDLE:
                    with condition:
                        condition.wait(timeout=.005)
                    continue
                if value is None:
                    diagnose('receive_eof')
                    raise SessionStop('IO_UNKNOWN')
                count('in', value)
                if exact(value, {'kind'}) and value['kind'] == 'close':
                    raise SessionStop('CLOSED')
                try:
                    inbox.put_nowait(value)
                except queue.Full:
                    raise SessionStop('PROTOCOL_REFUSED') from None
        except SessionStop as error:
            halt(error.code)
        except Exception:
            diagnose('receive_exception')
            halt('IO_UNKNOWN')

    def bind(binding):
        require(exact(binding, BINDING_KEYS))
        worker_id = binding['workerId']
        require(identifier(worker_id) and worker_id in active)
        slot = active[worker_id]
        require(all(binding[k] == v for k, v in slot['expected'].items()))
        require(type(binding['processId']) is int and binding['processId'] > 0)
        if slot['binding'] is None:
            slot['binding'] = dict(binding)
        require(slot['binding'] == binding)
        return worker_id, slot

    def tool(binding, params, seconds):
        try:
            require(type(seconds) in (int, float) and math.isfinite(seconds) and 0 < seconds <= 125)
            require(exact(params, {'requestId', 'arguments', 'callId', 'threadId', 'turnId', 'tool', 'namespace'}))
            with condition:
                check()
                worker_id, slot = bind(binding)
                require(slot['phase'] == 'running' and slot['call'] is None)
                require(params['tool'] in tool_names[binding['purpose']] and params['namespace'] is None)
                require(identifier(params['callId']) and identifier(params['threadId']) and identifier(params['turnId']))
                native_scope = (params['threadId'], params['turnId'])
                require(slot['nativeScope'] is None or slot['nativeScope'] == native_scope)
                slot['nativeScope'] = native_scope
                call_ref = call_ref_factory()
                require(identifier(call_ref) and call_ref not in seen_calls and len(seen_calls) < 128)
                native_call = (worker_id, binding['requestRef'], params['callId'])
                require(native_call not in seen_native_calls)
                seen_calls.add(call_ref)
                seen_native_calls.add(native_call)
                end = min(clock() + seconds, slot['deadline'])
                slot['call'] = {'ref': call_ref, 'result': None}
            worker_write(worker_id, {'kind': 'tool', 'purpose': binding['purpose'],
                'requestRef': binding['requestRef'], 'callRef': call_ref,
                'name': params['tool'], 'arguments': params['arguments']}, end)
            with condition:
                while slot['call']['result'] is None:
                    check()
                    try:
                        wait_seconds = remaining(end, .1)
                    except SessionStop as error:
                        if error.code == 'IO_UNKNOWN': diagnose('tool_wait', binding['purpose'], params['tool'])
                        raise
                    condition.wait(timeout=wait_seconds)
                check()
                try:
                    remaining(end)
                except SessionStop as error:
                    if error.code == 'IO_UNKNOWN': diagnose('tool_wait', binding['purpose'], params['tool'])
                    raise
                result = slot['call']['result']
                slot['call'] = None
                return result
        except SessionStop as error:
            halt(error.code)
            raise
        except Exception:
            halt('NATIVE_UNKNOWN')
            raise SessionStop('NATIVE_UNKNOWN') from None

    def completed(worker_id, slot):
        result = slot['future'].result()
        require(exact(result, {'binding', 'outcome', 'scope', 'value'}), 'NATIVE_UNKNOWN')
        with condition:
            bind(result['binding'])
            require(slot['phase'] == 'running' and slot['call'] is None, 'NATIVE_UNKNOWN')
        if result['outcome'] == 'not-admitted':
            value = result['value']
            require(result['scope'] is None and slot['nativeScope'] is None
                    and exact(value, {'kind', 'requestRef', 'reason', 'turnsAdmitted'})
                    and value['kind'] == 'notAdmitted'
                    and value['requestRef'] == slot['expected']['requestRef']
                    and value['reason'] in ('time', 'turns')
                    and type(value['turnsAdmitted']) is int and 0 <= value['turnsAdmitted'] <= 16, 'NATIVE_UNKNOWN')
            # The pool owns the no-dispatch proof. Keep the reservation bound
            # and retire this slot; do not cancel independently admitted peers.
            with condition:
                slot['phase'] = 'retired'
            worker_write(worker_id, {**value, 'purpose': slot['expected']['purpose']})
            return
        require(result['outcome'] == 'observed', 'NATIVE_UNKNOWN')
        scope = result['scope']
        require(exact(scope, {'requestRef', 'threadId', 'turnId', 'turnNumber'})
                and scope['requestRef'] == slot['expected']['requestRef']
                and identifier(scope['threadId']) and identifier(scope['turnId'])
                and type(scope['turnNumber']) is int and 1 <= scope['turnNumber'] <= 16, 'NATIVE_UNKNOWN')
        require(slot['nativeScope'] is None or slot['nativeScope'] == (scope['threadId'], scope['turnId']), 'NATIVE_UNKNOWN')
        value = result['value']
        require(type(value) is dict and type(value.get('metadata')) is dict, 'NATIVE_UNKNOWN')
        metadata = value['metadata']
        require(metadata.get('outcome') == 'observed' and metadata.get('code') == 'OK'
                and metadata.get('turnCompleted') is True and metadata.get('sessionPoisoned') is False, 'NATIVE_UNKNOWN')
        answer = value.get('answer')
        require(type(answer) is str and answer.strip() and '\0' not in answer and len(answer.encode('utf-8')) <= 4096, 'NATIVE_UNKNOWN')
        require(all(type(metadata.get(k)) is int and 0 <= metadata[k] <= cap for k, cap in (('toolCalls', 8), ('toolRefusals', 4))), 'NATIVE_UNKNOWN')
        require(type(value.get('imageMetadata')) is dict and type(value['imageMetadata'].get('exportReady')) is bool, 'NATIVE_UNKNOWN')
        image_ready = value['imageMetadata']['exportReady']
        require(not image_ready or slot['expected']['purpose'] == 'conversation', 'NATIVE_UNKNOWN')
        full_scope = {'purpose': slot['expected']['purpose'], **scope}
        worker_write(worker_id, {'kind': 'scope', 'scope': full_scope}, slot['deadline'])
        if image_ready:
            size = frames = 0
            for frame in workers[worker_id]['actor'].image_frames():
                frames += 1
                size += wire_size(frame)
                require(frames <= 24 and size <= 12 * 1024 * 1024, 'NATIVE_UNKNOWN')
                worker_write(worker_id, frame, slot['deadline'])
        with condition:
            slot['phase'] = 'release'
        worker_write(worker_id, {'kind': 'completed', 'scope': full_scope,
            'answer': answer, 'kindOfAnswer': 'image' if image_ready else 'text',
            'toolCalls': metadata['toolCalls'], 'toolRefusals': metadata['toolRefusals']}, slot['deadline'])

    try:
        pool = pool_factory(tool=tool, clock=clock)
        pool.open()
        require(identifier(pool.epoch_ref), 'INTERNAL_UNKNOWN')
        require(type(pool.workers) is list and 2 <= len(pool.workers) <= 8, 'INTERNAL_UNKNOWN')
        for worker in pool.workers:
            require(type(worker) is dict and identifier(worker.get('id')) and worker['id'] not in workers
                    and worker.get('purpose') in tool_names, 'INTERNAL_UNKNOWN')
            require(worker['actor'].tool_names() == tool_names[worker['purpose']], 'INTERNAL_UNKNOWN')
            safe_facts(worker['actor'].state(), False)
            require(type(getattr(worker.get('proc'), 'pid', None)) is int and worker['proc'].pid > 0, 'INTERNAL_UNKNOWN')
            workers[worker['id']] = worker
        require(sum(w['purpose'] == 'conversation' for w in workers.values()) == 1, 'INTERNAL_UNKNOWN')
        require(sum(w['purpose'] == 'community-assessment' for w in workers.values()) <= 1
                and {w['purpose'] for w in workers.values()} == set(tool_names), 'INTERNAL_UNKNOWN')
        write({'kind': 'poolReady', 'protocol': PROTOCOL,
               'workers': [{'workerId': k, 'purpose': w['purpose']} for k, w in workers.items()]})
        for worker_id, worker in workers.items():
            worker_write(worker_id, {'kind': 'ready', 'protocol': PROTOCOL,
                'scopes': [{'purpose': worker['purpose'], 'tools': list(tool_names[worker['purpose']])}]})
        receiver = threading.Thread(target=receive_pump, daemon=True, name='history-parallel-wire-receiver')
        receiver.start()
        while True:
            check()
            for worker_id, slot in list(active.items()):
                if slot['phase'] == 'retired':
                    continue
                remaining(slot['deadline'])
                if slot['phase'] == 'running' and slot['future'] is not None and slot['future'].done():
                    completed(worker_id, slot)
            try:
                message = inbox.get(timeout=remaining(cap=.05))
            except queue.Empty:
                continue
            check()
            require(type(message) is dict and set(message) in ({'workerId', 'frame'}, {'workerId', 'work', 'frame'}))
            worker_id, frame = message['workerId'], message['frame']
            require(identifier(worker_id) and worker_id in workers and type(frame) is dict)
            purpose = workers[worker_id]['purpose']
            kind = frame.get('kind')
            require(frame.get('purpose') == purpose)
            if kind == 'turn':
                require((exact(frame, {'kind', 'purpose', 'requestRef', 'input'}) or
                         exact(frame, {'kind', 'purpose', 'requestRef', 'input', 'images'})) and worker_id not in active)
                ref, text = frame['requestRef'], frame['input']
                require(identifier(ref) and ref not in seen_requests and len(seen_requests) < 16)
                require(type(text) is str and '\0' not in text and 0 < len(text.encode('utf-8')) <= 24576, 'INPUT_REFUSED')
                try:
                    require(validate_input(purpose, text) is True, 'INPUT_REFUSED')
                except Exception:
                    raise SessionStop('INPUT_REFUSED') from None
                if purpose == 'history-analysis':
                    work = message.get('work')
                    require(exact(work, {'taskRef', 'planRef', 'workRef'}) and all(identifier(v) for v in work.values()))
                else:
                    require('work' not in message)
                    group = 'foreground' if purpose == 'conversation' else 'community-assessment'
                    work = {'taskRef': group, 'planRef': group, 'workRef': ref}
                images = None
                if 'images' in frame:
                    require(purpose == 'conversation', 'INPUT_REFUSED')
                    images = visual_input(frame['images'])
                input_bytes = (text.encode('utf-8') if images is None else
                    json.dumps({'text': text, 'images': images}, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
                expected = dict(epochRef=pool.epoch_ref, workerId=worker_id, purpose=purpose, processId=workers[worker_id]['proc'].pid,
                    requestRef=ref, **work, inputSha256=hashlib.sha256(input_bytes).hexdigest())
                slot = dict(expected=expected, binding=None, call=None, phase='running', future=None,
                            deadline=min(clock() + (30 if purpose == 'community-assessment' else 300), deadline), nativeScope=None)
                with condition:
                    active[worker_id] = slot
                    seen_requests.add(ref)
                slot['future'] = pool.submit(purpose=purpose, request_ref=ref, task_ref=work['taskRef'],
                    plan_ref=work['planRef'], work_ref=work['workRef'], text=text, worker_id=worker_id,
                    **({'images': images} if images is not None else {}))
            else:
                require('work' not in message and worker_id in active)
                slot = active[worker_id]
                require(frame.get('requestRef') == slot['expected']['requestRef'])
                if kind == 'toolResult':
                    require(exact(frame, {'kind', 'purpose', 'requestRef', 'callRef', 'result'}))
                    result = frame['result']
                    require(exact(result, {'success', 'contentItems'}) and type(result['success']) is bool
                            and type(result['contentItems']) is list and len(result['contentItems']) == 1)
                    item = result['contentItems'][0]
                    require(exact(item, {'type', 'text'}) and item['type'] == 'inputText'
                            and type(item['text']) is str and len(item['text'].encode('utf-8')) <= (1088*1024 if slot['expected']['purpose'] == 'history-analysis' else 65536)
                            and wire_size(result) <= (2*1088*1024+512 if slot['expected']['purpose'] == 'history-analysis' else 131584))
                    with condition:
                        require(slot['phase'] == 'running' and slot['call'] is not None
                                and slot['call']['ref'] == frame['callRef'] and slot['call']['result'] is None)
                        slot['call']['result'] = result
                        condition.notify_all()
                elif kind == 'release':
                    require(exact(frame, {'kind', 'purpose', 'requestRef', 'delivery'}) and slot['phase'] == 'release')
                    delivery = frame['delivery']
                    require(delivery in ('verified', 'not-sent', 'unknown') and (purpose == 'conversation' or delivery == 'not-sent'))
                    try:
                        pool.release(slot['binding'], delivery)
                    except Exception:
                        raise SessionStop('RELEASE_UNKNOWN') from None
                    with condition:
                        del active[worker_id]
                    worker_write(worker_id, {'kind': 'released', 'purpose': purpose,
                        'requestRef': frame['requestRef'], 'delivery': delivery})
                    if delivery == 'unknown':
                        raise SessionStop('RELEASE_UNKNOWN')
                else:
                    raise SessionStop('PROTOCOL_REFUSED')
    except SessionStop as error:
        halt(error.code)
    except Exception:
        halt('NATIVE_UNKNOWN')
    finally:
        halt(stop or 'INTERNAL_UNKNOWN')
        receiver_joined = True
        if receiver is not None:
            receiver.join(2)
            receiver_joined = not receiver.is_alive()
        if pool is not None:
            try:
                receipt = pool.close()
            except Exception:
                raise ValueError('parallel-session-pool-settlement-unknown') from None
        else:
            raise ValueError('parallel-session-factory-refused')
        if not receiver_joined:
            raise ValueError('parallel-session-receiver-unsettled')
    final = {'kind': 'poolClosed', 'protocol': PROTOCOL, 'code': stop, 'receipt': receipt}
    try:
        with output_lock:
            for worker_id, worker in workers.items():
                frame = {'workerId': worker_id, 'frame': {'kind': 'closed', 'code': stop,
                    'facts': safe_facts(worker['actor'].state(), worker_id in active and active[worker_id]['phase'] != 'retired')}}
                require(wire_size(frame) <= FRAME_BYTES and emit(frame, 10) is True, 'IO_UNKNOWN')
            require(wire_size(final) <= FRAME_BYTES and emit(final, 10) is True, 'IO_UNKNOWN')
    except Exception:
        raise ValueError('parallel-session-close-output-unknown') from None
    # Diagnostic-only extension: keep the existing poolClosed wire unchanged.
    return final if session_failure is None or stop != 'IO_UNKNOWN' else {**final, 'sessionFailure': session_failure}
