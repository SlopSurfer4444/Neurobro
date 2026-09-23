"""Opt-in guest-local child pool. No launch, import-time I/O, or default ports.

The outer supervisor continues to own ONE custody/relay. This helper launches
only App Server children through its supplied host-private launcher; it never
creates another supervisor, relay, credential store, or Telegram client. Source
pins, launch argv/environment, per-child custody/capability checks and actor
tool configuration belong to that composition, not caller-supplied work.

Completion is private native evidence awaiting explicit release. It is neither
a persisted history node nor delivery nor OS settlement. A failed/unknown turn
is consumed and its child retired. The host must persist work reservations
before submit and stage results before projecting the ordered history frontier.
"""
import concurrent.futures
import base64
import copy
import hashlib
import json
import math
import re
import threading
import time


class PoolError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__('history-parallel-' + code)


def require(value, code='CONFIG_REFUSED'):
    if not value:
        raise PoolError(code)


def identifier(value):
    return type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value) is not None


STARTUP_CODES = frozenset(('CONFIG_REFUSED','PREFLIGHT_REFUSED','LAUNCH_UNKNOWN','PROCESS_UNKNOWN',
    'PROCESS_ALIAS_REFUSED','READER_ALIAS_REFUSED','CUSTODY_REFUSED','CAPABILITIES_REFUSED',
    'PROTOCOL_REFUSED','PROBE_REFUSED','RPC_REFUSED','ACCOUNT_REFUSED','MODEL_UNAVAILABLE',
    'BOUNDS_REFUSED','PHASE_REFUSED','TRANSPORT_UNKNOWN','DEADLINE_UNKNOWN','CANCELLED_UNKNOWN','BYTES_REFUSED','INTERNAL_UNKNOWN'))


TURN_FAILURE_CODES = frozenset(('CLOCK_UNKNOWN','DEADLINE_UNKNOWN','CANCELLED_UNKNOWN','IDLE_UNKNOWN','RESULT_UNKNOWN',
    'INTERNAL_UNKNOWN','TRANSPORT_UNKNOWN','BOUNDS_REFUSED','BYTES_REFUSED','PHASE_REFUSED',
    'RPC_REFUSED','PROTOCOL_REFUSED','INPUT_REFUSED','WORK_SCOPE_REFUSED','THREAD_UNKNOWN','TURNS_REFUSED'))


class SharedBudget:
    """One deadline and dispatch/transport budgets for every child.

Raw reads reserve a full maximum read chunk BEFORE the inherited sole reader
touches its pipe. Short reads intentionally consume the full reservation. This
conservative cap cannot be multiplied by worker count or refunded after an
unknown read/write. Cleanup has separate existing per-child bounded drains.
"""
    def __init__(self, *, clock=time.monotonic, seconds=900, turns=16,
                 foreground_reserve=1, read_bytes=16*(66*1024*1024)+8*1024*1024,
                 write_bytes=16*(18*1024*1024+65536)+1024*1024+16*12*1024*1024):
        require(callable(clock) and type(seconds) in (int, float) and math.isfinite(seconds) and 0 < seconds <= 900)
        require(type(turns) is int and 2 <= turns <= 16)
        require(type(foreground_reserve) is int and 1 <= foreground_reserve < turns)
        require(all(type(x) is int and 65536 <= x <= 2*1024*1024*1024 for x in (read_bytes, write_bytes)))
        self.clock = clock
        self.started = self._now()
        self.deadline = self.started + seconds
        self.closed_at = None
        self.last_observed = self.started
        self.turn_limit, self.foreground_reserve = turns, foreground_reserve
        self.read_limit, self.write_limit = read_bytes, write_bytes
        self.lock = threading.RLock()
        self.closed = False
        self.turns = self.foreground_turns = self.reads = self.writes = 0
        self.admissions = self.foreground_admissions = 0

    def _now(self):
        value = self.clock()
        require(type(value) in (int, float) and math.isfinite(value), 'CLOCK_UNKNOWN')
        return value

    def remaining(self, maximum=300):
        with self.lock:
            require(type(maximum) in (int, float) and math.isfinite(maximum) and maximum > 0)
            now = self._now()
            require(now >= self.last_observed, 'CLOCK_UNKNOWN')
            self.last_observed = now
            # Closure is revocation, not evidence that a model exhausted time.
            require(not self.closed, 'CANCELLED_UNKNOWN')
            require(now < self.deadline, 'DEADLINE_UNKNOWN')
            return min(maximum, self.deadline-now)

    def reserve(self, kind, count):
        with self.lock:
            self.remaining()
            require(type(count) is int and count > 0)
            field, limit = ('reads', self.read_limit) if kind == 'read' else ('writes', self.write_limit)
            require(kind in ('read', 'write'))
            require(getattr(self, field) + count <= limit, 'BYTES_REFUSED')
            setattr(self, field, getattr(self, field) + count)

    def dispatch(self, purpose):
        with self.lock:
            self.remaining()
            reserve = max(0, self.foreground_reserve-self.foreground_turns)
            limit = self.turn_limit if purpose == 'conversation' else self.turn_limit-reserve
            require(self.turns < limit, 'TURNS_REFUSED')
            self.turns += 1  # Consumed before the actual transport call.
            if purpose == 'conversation':
                self.foreground_turns += 1

    def admit(self, purpose):
        """Reserve a potential turn before actor/thread side effects, atomically.

Unused/uncertain reservations stay consumed. This is separate from the actual
turn/start counter, so two workers cannot both claim the final available slot.
"""
        with self.lock:
            require(not self.closed, 'STATE_REFUSED')
            now = self._now()
            require(now >= self.last_observed, 'CLOCK_UNKNOWN')
            self.last_observed = now
            seconds = 30 if purpose == 'community-assessment' else 300
            if self.deadline-now < seconds:
                return 'time'
            reserve = max(0,self.foreground_reserve-self.foreground_admissions)
            limit = self.turn_limit if purpose == 'conversation' else self.turn_limit-reserve
            if self.admissions >= limit:
                return 'turns'
            self.admissions += 1
            if purpose == 'conversation': self.foreground_admissions += 1
            return None

    def close(self):
        with self.lock:
            if not self.closed:
                try:
                    self.closed_at = self._now()
                    self.last_observed = max(self.last_observed, self.closed_at)
                except PoolError: self.closed_at = None
            self.closed = True

    def failure_timing(self, turn_started, purpose, code, native_failure, rpc_failure):
        # Observed relative durations, not a new retry/admission authority.
        with self.lock:
            try: now = self._now()
            except PoolError: now = None
            if now is not None and now < self.last_observed: now = None
            def elapsed(start, end):
                return None if start is None or end is None or end < start else min(86400000, int((end-start)*1000))
            turn_ms = elapsed(turn_started, now)
            epoch_ms = elapsed(self.started, now)
            close_ms = elapsed(self.started, self.closed_at)
            turn_budget = 30000 if purpose == 'community-assessment' else 300000
            epoch_budget = int((self.deadline-self.started)*1000)
            native_site = native_failure.get('site') if type(native_failure) is dict else None
            rpc_site = rpc_failure.get('site') if type(rpc_failure) is dict else None
            cause = 'other'
            if code == 'CLOCK_UNKNOWN': cause = 'clock-regressed'
            elif code == 'CANCELLED_UNKNOWN' or native_site == 'cancelled' or rpc_site == 'cancelled': cause = 'cancelled'
            elif code == 'DEADLINE_UNKNOWN':
                cause = 'epoch-deadline' if epoch_ms is not None and epoch_ms >= epoch_budget else 'other'
            elif native_site == 'deadline' or rpc_site == 'deadline':
                cause = ('epoch-deadline' if epoch_ms is not None and epoch_ms >= epoch_budget else
                         'turn-deadline' if turn_ms is not None and turn_ms >= turn_budget else 'rpc-deadline')
            return dict(cause=cause, turnElapsedMs=turn_ms, turnBudgetMs=turn_budget,
                        epochElapsedMs=epoch_ms, epochBudgetMs=epoch_budget, closeElapsedMs=close_ms)


    def snapshot(self):
        with self.lock:
            return dict(turnStartDispatches=self.turns, foregroundDispatches=self.foreground_turns,
                        turnsAdmitted=self.admissions, foregroundAdmissions=self.foreground_admissions,
                        reservedReadBytes=self.reads, reservedWriteBytes=self.writes,
                        closed=self.closed)


def create_shared_rpc_class(parent, encode_frame, budget):
    """Wrap the actual ManagedRpc write/ingest seams; preserve its sole lock.

Use the returned class in rpc_factory(proc, budget). The production parent is
create_managed_rpc_class(...); encoder must be the same pinned RPC encoder.
"""
    class SharedRpc(parent):
        def _write(self, frame, deadline):
            budget.reserve('write', len(encode_frame(frame, profile=self._profile)))
            return super()._write(frame, min(deadline, budget.deadline))

        def _ingest(self):
            budget.reserve('read', 65536)
            return super()._ingest()
    return SharedRpc


class _WorkerRpc:
    """Trusted actor facade; exactly one actor per distinct child/reader."""
    def __init__(self, raw, budget, purpose):
        self.raw, self.budget, self.purpose = raw, budget, purpose
        self.active = None
        self.thread = None
        self.thread_started = False
        self.current_thread_dispatch = False
        self.turn_dispatched = False
        self.responses = []
        self.registry = None
        self.first_budget_failure = None

    def _budget_remaining(self, seconds=300):
        try: return self.budget.remaining(seconds)
        except PoolError as error:
            if self.first_budget_failure is None:
                self.first_budget_failure = error.code
            raise

    def _limit(self, seconds):
        require(self.active is not None, 'WORK_SCOPE_REFUSED')
        return self._budget_remaining(seconds)

    def exchange(self, method, params, seconds=10):
        limit = self._limit(seconds)
        require(type(params) is dict and method in ('thread/start', 'turn/start'), 'RPC_REFUSED')
        if method == 'thread/start':
            require(not self.thread_started and not self.turn_dispatched, 'RPC_REFUSED')
            self.thread_started = True
            self.current_thread_dispatch = True
        else:
            require(self.thread is not None and params.get('threadId') == self.thread and not self.turn_dispatched, 'RPC_REFUSED')
            self.budget.dispatch(self.purpose)
            self.turn_dispatched = True
        result = self.raw.exchange(method, params, limit)
        self._budget_remaining()
        if method == 'thread/start':
            require(type(result) is tuple and len(result) == 2 and result[1] is None and
                    type(result[0]) is dict and type(result[0].get('thread')) is dict and
                    identifier(result[0]['thread'].get('id')), 'THREAD_UNKNOWN')
            self.thread = result[0]['thread']['id']
            if self.registry is not None:
                self.registry.start(self.purpose, self.thread)
        return result

    def next_frame(self, seconds):
        end = self.budget.clock()+self._limit(seconds)
        while True:
            value = self.raw.next_frame(self._limit(end-self.budget.clock()))
            self._budget_remaining()
            if self.registry is None or not self.registry.route(value, self.purpose):
                return value

    def respond(self, request_id, result, seconds):
        require(self.turn_dispatched, 'RPC_REFUSED')
        self.raw.respond(request_id, result, self._limit(seconds))
        self.responses.append(request_id)
        self._budget_remaining()


class NativeWorkerPool:
    """Single-owner, opt-in child composition with explicit joined settlement.

launch(purpose,index)->captured Popen-like child. This port launches only the
App Server under existing supervisor ownership. verify(child,raw,purpose) must
initialize and perform per-child custody/profile/control/capability checks and
return True; actor_factory is trusted pinned code, not model-selected tools.
settle(child,raw,seconds) must reap the exact child and join pipe readers; it
returns {stdinClosed,stdoutEof,reaped,stderrJoined,exitCode}. It never settles
the shared relay: that remains the outer supervisor's final responsibility.

All ports must honor supplied deadlines. Pool close reports UNKNOWN if a port
does not stop in time; it keeps its ownership records and forbids replacement.
"""
    def __init__(self, *, enabled, epoch_ref, analysis_workers, launch,
                 rpc_factory, verify, actor_factory, settle, budget=None,
                 community_assessment=False, prepare_turn=None, startup_context=None, turn_failure_context=None):
        require(enabled is True and identifier(epoch_ref))
        require(type(community_assessment) is bool)
        require(type(analysis_workers) is int and 1 <= analysis_workers <= 7-int(community_assessment))
        require(prepare_turn is None or callable(prepare_turn))
        require(startup_context is None or callable(startup_context))
        require(all(callable(x) for x in (launch, rpc_factory, verify, actor_factory, settle)))
        self.epoch_ref = epoch_ref
        self.budget = budget if budget is not None else SharedBudget()
        require(isinstance(self.budget, SharedBudget))
        self.launch, self.rpc_factory, self.verify = launch, rpc_factory, verify
        self.actor_factory, self.settle = actor_factory, settle
        self.prepare_turn = prepare_turn
        self.startup_context = startup_context
        require(turn_failure_context is None or callable(turn_failure_context))
        self.turn_failure_context = turn_failure_context
        self.startup_failure = None
        self.purposes = ['conversation'] + ['history-analysis']*analysis_workers + (['community-assessment'] if community_assessment else [])
        self.workers = []
        self.lock = threading.RLock()
        self.opened = self.closing = self.starting = False
        self.seen = set()
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=len(self.purposes), thread_name_prefix='history-native')
        self.receipt = None
        self.ownership_known = True

    def open(self):
        # The owner serializes open/close; work cannot enter partial startup.
        with self.lock:
            require(not self.opened and not self.starting and not self.closing, 'STATE_REFUSED')
            self.starting = True
            index, stage, worker = 0, 'launch', None
            try:
                for index, purpose in enumerate(self.purposes):
                    stage, worker = 'launch', None
                    self.budget.remaining()
                    try:
                        proc = self.launch(purpose, index)
                    except BaseException:
                        # A launcher exception cannot prove no process exists.
                        self.ownership_known = False
                        raise
                    # Capture the exact returned process BEFORE constructing RPC.
                    worker = dict(id='worker-'+str(index), purpose=purpose, proc=proc, raw=None,
                                  rpc=None, actor=None, future=None, binding=None, retired=False)
                    self.workers.append(worker)
                    require(type(getattr(proc, 'pid', None)) is int and proc.pid > 0, 'PROCESS_UNKNOWN')
                    require(all(w['proc'] is not proc and w['proc'].pid != proc.pid for w in self.workers[:-1]), 'PROCESS_ALIAS_REFUSED')
                    stage = 'rpc'
                    raw = self.rpc_factory(proc, self.budget)
                    worker['raw'] = raw
                    require(all(w['raw'] is not raw for w in self.workers[:-1]), 'READER_ALIAS_REFUSED')
                    stage = 'custody'
                    require(self.verify(proc, raw, purpose, self.budget.remaining(120)) is True, 'CUSTODY_REFUSED')
                    self.budget.remaining()
                    stage = 'admit'
                    raw.admit_model()
                    rpc = _WorkerRpc(raw, self.budget, purpose)
                    worker['rpc'] = rpc
                    stage = 'actor'
                    worker['actor'] = self.actor_factory(rpc, purpose)
                self.opened = True
                return self
            except BaseException as error:
                # Capture before cleanup mutates the RPC phase or final code.
                code = getattr(error, 'code', None)
                self.startup_failure = dict(workerId='worker-'+str(index), stage=stage,
                    code=code if type(code) is str and code in STARTUP_CODES else 'INTERNAL_UNKNOWN',
                    custodyStage=None, probeIndex=None, rpcFailure=None)
                if self.startup_context is not None and worker is not None:
                    try: self.startup_failure.update(self.startup_context(worker))
                    except BaseException: pass
                # Caller receives a fixed error and can inspect exact cleanup.
                self.starting = False
                self.close()
                raise
            finally:
                self.starting = False

    def submit(self, *, purpose, request_ref, task_ref, plan_ref, work_ref, text, worker_id=None, images=None):
        require(purpose in ('conversation', 'history-analysis', 'community-assessment'))
        require(all(identifier(x) for x in (request_ref, task_ref, plan_ref, work_ref)))
        require(worker_id is None or identifier(worker_id))
        require(type(text) is str and '\0' not in text and 0 < len(text.encode('utf-8')) <= 24576, 'INPUT_REFUSED')
        if images is not None:
            require(purpose == 'conversation' and type(images) is list and 1 <= len(images) <= 2, 'INPUT_REFUSED')
            total = 0
            for image in images:
                require(type(image) is dict and set(image) == {'mimeType','base64'} and image['mimeType'] in ('image/png','image/jpeg') and
                        type(image['base64']) is str and len(image['base64']) <= 11184812, 'INPUT_REFUSED')
                try: raw = base64.b64decode(image['base64'], validate=True)
                except Exception: raise PoolError('INPUT_REFUSED') from None
                total += len(raw)
                require(bool(raw) and total <= 8*1024*1024 and base64.b64encode(raw).decode('ascii') == image['base64'] and
                        raw.startswith(b'\x89PNG\r\n\x1a\n' if image['mimeType']=='image/png' else b'\xff\xd8\xff'), 'INPUT_REFUSED')
            images = [{'mimeType':image['mimeType'],'base64':image['base64']} for image in images]
        input_bytes = (text.encode('utf-8') if images is None else
                       json.dumps({'text':text,'images':images},ensure_ascii=False,separators=(',',':')).encode('utf-8'))
        with self.lock:
            require(self.opened and not self.closing, 'STATE_REFUSED')
            self.budget.remaining()
            require(request_ref not in self.seen, 'REPLAY_REFUSED')
            worker = next((w for w in self.workers if w['purpose'] == purpose and (worker_id is None or w['id'] == worker_id) and w['binding'] is None and not w['retired']), None)
            require(worker is not None, 'BUSY')  # No hidden unbounded job queue.
            binding = dict(epochRef=self.epoch_ref, workerId=worker['id'], processId=worker['proc'].pid,
                           purpose=purpose, requestRef=request_ref, taskRef=task_ref, planRef=plan_ref,
                           workRef=work_ref, inputSha256=hashlib.sha256(input_bytes).hexdigest())
            self.seen.add(request_ref)
            worker['binding'] = binding
            worker['rpc'].active = request_ref
            worker['rpc'].turn_dispatched = False
            worker['rpc'].current_thread_dispatch = False
            worker['rpc'].responses = []
            worker['rpc'].first_budget_failure = None
            try:
                future = self.executor.submit(self._run, worker, text, images)
            except BaseException:
                worker['retired'] = True
                raise
            worker['future'] = future
            return future

    def _run(self, worker, text, images):
        binding = copy.deepcopy(worker['binding'])
        result = dict(binding=binding, outcome='unknown', scope=None, value=None)
        stage = 'admit'
        actor_value = None
        turn_started = None
        def failed(code):
            if 'turnFailure' in worker: return
            guard_code = worker['rpc'].first_budget_failure
            if code == 'RESULT_UNKNOWN' and guard_code in ('CANCELLED_UNKNOWN','DEADLINE_UNKNOWN','CLOCK_UNKNOWN'): code = guard_code
            failure = dict(stage=stage, code=code, nativeFailure=None, rpcFailure=None)
            if self.turn_failure_context is not None:
                try: failure.update(self.turn_failure_context(worker, actor_value))
                except Exception: pass
            failure['timing'] = self.budget.failure_timing(turn_started, binding['purpose'], failure['code'], failure['nativeFailure'], failure['rpcFailure'])
            worker['turnFailure'] = failure
        try:
            reason = self.budget.admit(binding['purpose'])
            if reason is not None:
                worker['retired'] = True
                return {**result, 'outcome':'not-admitted', 'value':{'kind':'notAdmitted',
                        'requestRef':binding['requestRef'], 'reason':reason,
                        'turnsAdmitted':worker['actor'].state()['turnsAdmitted']}}
            stage = 'prepare'
            if self.prepare_turn is not None:
                require(self.prepare_turn(worker, self.budget.remaining(1)) is True, 'IDLE_UNKNOWN')
            stage = 'actor'
            turn_started = self.budget._now()
            value = worker['actor'].turn(binding['requestRef'], text, **({'images':images} if images is not None else {}))
            actor_value = value
            stage = 'result'
            require(type(value) is dict, 'RESULT_UNKNOWN')
            if value.get('kind') == 'notAdmitted':
                self.budget.remaining()
                require(value.get('requestRef') == binding['requestRef'] and not worker['rpc'].turn_dispatched and
                        not worker['rpc'].current_thread_dispatch, 'RESULT_UNKNOWN')
                result['outcome'] = 'not-admitted'
                result['value'] = copy.deepcopy(value)
                worker['retired'] = True
            elif type(value.get('metadata')) is dict and value['metadata'].get('outcome') == 'observed':
                self.budget.remaining()
                require(value['metadata'].get('code') == 'OK' and value['metadata'].get('turnCompleted') is True and
                        value['metadata'].get('sessionPoisoned') is False, 'RESULT_UNKNOWN')
                scope = worker['actor'].completed_turn_scope()
                require(type(scope) is dict and set(scope) == {'requestRef','threadId','turnId','turnNumber'} and
                        scope['requestRef'] == binding['requestRef'] and scope['threadId'] == worker['rpc'].thread and
                        identifier(scope['turnId']) and type(scope['turnNumber']) is int and scope['turnNumber'] > 0 and
                        worker['rpc'].turn_dispatched, 'RESULT_UNKNOWN')
                result.update(outcome='observed', scope=copy.deepcopy(scope), value=copy.deepcopy(value))
            else:
                # Preserve the returned actor's first failure before cleanup's
                # budget revocation can obscure it. Still UNKNOWN and retired.
                site = value.get('metadata', {}).get('failureSite') if type(value.get('metadata')) is dict else None
                failed('CANCELLED_UNKNOWN' if site == 'cancelled' else 'RESULT_UNKNOWN')
                worker['retired'] = True
        except BaseException as error:
            code = getattr(error, 'code', None)
            failed(code if type(code) is str and code in TURN_FAILURE_CODES else 'INTERNAL_UNKNOWN')
            worker['retired'] = True
        # Binding is retained until explicit release, even for a completed future.
        return result

    def release(self, binding, delivery):
        with self.lock:
            require(not self.closing and type(binding) is dict, 'STATE_REFUSED')
            worker = next((w for w in self.workers if w['binding'] == binding), None)
            require(worker is not None and worker['future'] is not None and worker['future'].done(), 'RELEASE_REFUSED')
            result = worker['future'].result()
            require(result['outcome'] == 'observed' and not worker['retired'], 'RELEASE_REFUSED')
            require(delivery in ('verified', 'not-sent', 'unknown') and
                    (worker['purpose'] == 'conversation' or delivery == 'not-sent'), 'RELEASE_REFUSED')
            try:
                if worker['rpc'].registry is not None:
                    scope = result['scope']
                    worker['rpc'].registry.complete(worker['purpose'], scope['threadId'], scope['turnId'], tuple(worker['rpc'].responses))
                worker['actor'].releaseTurn(binding['requestRef'], delivery)
            except BaseException:
                worker['retired'] = True
                raise PoolError('RELEASE_UNKNOWN') from None
            worker['retired'] = delivery == 'unknown'
            worker['rpc'].active = None
            worker['binding'] = worker['future'] = None

    def close(self, seconds=35):
        require(type(seconds) in (int, float) and math.isfinite(seconds) and 0 < seconds <= 35)
        with self.lock:
            if self.receipt is not None:
                return copy.deepcopy(self.receipt)
            self.closing = True
            self.budget.close()
            deadline = time.monotonic()+seconds
            self.cleanup_deadline = deadline
            for worker in self.workers:
                worker['retired'] = True
                for obj, method in ((worker['actor'], 'close'), (worker['raw'], 'cancel')):
                    if obj is not None:
                        try: getattr(obj, method)()
                        except BaseException: pass
            futures = [w['future'] for w in self.workers if w['future'] is not None]
            if futures:
                concurrent.futures.wait(futures, timeout=max(0, deadline-time.monotonic()))
            # All joined children receive EOF before waiting on any one child.
            # cancel() only revokes RPC calls; it does not close their stdin.
            input_closed = {}
            for worker in self.workers:
                input_closed[worker['id']] = False
                if worker['future'] is not None and not worker['future'].done():
                    continue
                try:
                    if worker['raw'] is not None:
                        worker['raw'].close_input()
                        input_closed[worker['id']] = worker['raw'].metadata()['inputClosed'] is True
                    else:
                        worker['proc'].stdin.close()
                        input_closed[worker['id']] = worker['proc'].stdin.closed is True
                except BaseException: pass
            receipts = []
            for worker in self.workers:
                joined = worker['future'] is None or worker['future'].done()
                physical = None
                attempted = False
                if joined and deadline > time.monotonic():
                    attempted = True
                    try: physical = self.settle(worker['proc'], worker['raw'], deadline-time.monotonic())
                    except BaseException: pass
                good = (type(physical) is dict and set(physical) == {'stdinClosed','stdoutEof','reaped','stderrJoined','exitCode'} and
                        all(physical[k] is True for k in ('stdinClosed','stdoutEof','reaped','stderrJoined')) and
                        type(physical['exitCode']) is int and physical['exitCode'] == 0 and time.monotonic() <= deadline)
                pending_outcome = 'unknown' if worker['binding'] is not None else None
                if worker['future'] is not None and joined:
                    try: pending_outcome = worker['future'].result()['outcome']
                    except BaseException: pass
                cleanup = dict(attempted=attempted,stdinClosed=input_closed[worker['id']],stdoutEof=False,
                               reaped=False,stderrJoined=False,exitCode=None)
                if type(physical) is dict and set(physical) == {'stdinClosed','stdoutEof','reaped','stderrJoined','exitCode'}:
                    for key in ('stdinClosed','stdoutEof','reaped','stderrJoined'):
                        cleanup[key] = physical[key] is True
                    if type(physical['exitCode']) is int and -(2**31) <= physical['exitCode'] < 2**31:
                        cleanup['exitCode'] = physical['exitCode']
                receipts.append(dict(workerId=worker['id'], processId=getattr(worker['proc'], 'pid', None),
                                     turnJoined=joined, resourcesSettled=bool(joined and good),
                                     pendingBinding=copy.deepcopy(worker['binding']),
                                     pendingOutcome=pending_outcome,cleanup=cleanup))
                if 'turnFailure' in worker:
                    receipts[-1]['turnFailure'] = copy.deepcopy(worker['turnFailure'])
            self.executor.shutdown(wait=False, cancel_futures=True)
            settled = self.ownership_known and all(r['resourcesSettled'] for r in receipts)
            self.receipt = dict(schema='history-parallel-native-pool-v1', epochRef=self.epoch_ref,
                                resourcesSettled=settled, replacementReady=settled,
                                relaySettlementObserved=False, children=receipts, budget=self.budget.snapshot())
            if self.startup_failure is not None:
                self.receipt['startupFailure'] = copy.deepcopy(self.startup_failure)
            return copy.deepcopy(self.receipt)
