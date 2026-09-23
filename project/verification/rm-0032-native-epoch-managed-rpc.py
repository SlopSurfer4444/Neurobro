"""Opt-in warm RPC lifetime and cancellation; no launch or process settlement.

Composition pins both caller-supplied modules. Historical NativeRpc and its idle
extension remain unchanged. cancel() is the only cross-thread entry: it sets an
Event, never closes descriptors under the sole RPC reader/writer. The owner must
join the active call before close_input/drain/close or any process operation.
"""
import base64
import math
import os
import selectors
import threading
import time

MIB = 1024 * 1024
# Per turn: maximum of 50.25MiB foreground image/event traffic and
# 66MiB isolated analysis lifecycle/event traffic.
# Additional 8MiB covers custody, ACKs and bounded post-turn notifications. This
# is cumulative traffic, not retained memory; existing frame/queue caps remain.
RAW_READ_CAP = 16 * (64 * MIB + 2 * MIB) + 8 * MIB
RAW_WRITE_CAP = 16 * (18 * MIB + 65536) + MIB
VISUAL_WRITE_CAP = 16 * 12 * MIB
CLEANUP_READ_CAP = 8 * MIB
WAIT_SLICE = .05
PREP_SECONDS, EPOCH_SECONDS = 120.0, 900.0


def visual_input_write_bytes(frame):
    """Account only canonical bounded input URLs; all other bytes stay ordinary."""
    if type(frame) is not dict or frame.get('method')!='turn/start':return 0
    params=frame.get('params')
    if type(params) is not dict or type(params.get('input')) is not list:return 0
    images=[item for item in params['input'] if type(item) is dict and item.get('type')=='image']
    if not 1<=len(images)<=2:return 0
    total=0;wire=0
    for item in images:
        if set(item)!={'type','url'} or type(item['url']) is not str:return 0
        url=item['url'];prefix=next((p for p in ('data:image/png;base64,','data:image/jpeg;base64,') if url.startswith(p)),None)
        if prefix is None or len(url)>12*MIB:return 0
        encoded=url[len(prefix):]
        try:raw=base64.b64decode(encoded,validate=True)
        except Exception:return 0
        if not raw or base64.b64encode(raw).decode('ascii')!=encoded:return 0
        if not raw.startswith(b'\x89PNG\r\n\x1a\n' if prefix=='data:image/png;base64,' else b'\xff\xd8\xff'):return 0
        total+=len(raw)
        if total>8*MIB:return 0
        wire+=len(url)
    return wire


def create_managed_rpc_class(base, idle_module):
    Parent = idle_module.create_epoch_rpc_class(base)

    class ManagedRpc(Parent):
        def __init__(self, proc, profile="image"):
            if profile != "image": raise base.NativeRpcError("CONFIG_REFUSED")
            self._cancel = threading.Event()
            self._reserved_writes = 0
            self._reserved_visual_writes = 0
            self._cleanup_consumed = False
            super().__init__(proc, profile=profile)

        def cancel(self):
            """Revoke work only. Idempotent and safe from the host receiver thread."""
            self._cancel.set()

        def cancel_requested(self): return self._cancel.is_set()

        def _check(self):
            super()._check()
            if self._cancel.is_set(): self._fail("TRANSPORT_UNKNOWN", True, "cancelled")

        def _ingest(self):
            self._check()
            if self._read_bytes >= RAW_READ_CAP: self._fail("BOUNDS_REFUSED", True)
            super()._ingest()
            # The existing reader takes at most64KiB. Reject a crossing chunk
            # before any decoded envelope can reach the caller. No cap-sized
            # allocation, new parser, or alternate read owner is introduced.
            if self._read_bytes > RAW_READ_CAP: self._fail("BOUNDS_REFUSED", True)
            self._check()

        def _write(self, frame, deadline):
            self._check()
            try: size = len(base.encode_frame(frame, profile=self._profile))
            except base.NativeRpcError: self._fail("BOUNDS_REFUSED")
            visual = visual_input_write_bytes(frame)
            ordinary = size - visual
            if self._reserved_writes + ordinary > RAW_WRITE_CAP or self._reserved_visual_writes + visual > VISUAL_WRITE_CAP: self._fail("BOUNDS_REFUSED", True)
            self._reserved_visual_writes += visual
            self._reserved_writes += ordinary  # Possibly partial writes are consumed.
            return super()._write(frame, deadline)

        def _wait(self, deadline, writing=False):
            if self._eof: self._fail("TRANSPORT_UNKNOWN", True, "eof")
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(self._read_fd, selectors.EVENT_READ)
                    if writing: selector.register(self._write_fd, selectors.EVENT_WRITE)
                    while True:
                        ready = selector.select(min(WAIT_SLICE, self._time(deadline)))
                        self._time(deadline)
                        if not ready: continue
                        writable = False
                        for item, _ in ready:
                            if item.fd == self._read_fd: self._ingest()
                            else: writable = True
                        return writable
            except base.NativeRpcError: raise
            except Exception: self._fail("TRANSPORT_UNKNOWN", True, "selector")

        def drain_to_eof(self, seconds):
            """After call join and stdin EOF, bounded discard despite cancellation.

            EOF is not process exit. Existing buffered data counts toward the
            cleanup limit; newly read bytes are at most the remaining budget.
            At an exhausted budget we cannot prove EOF, so return unknown.
            """
            if not self._input_closed or self._closed or self._cleanup_consumed or not self._lock.acquire(blocking=False):
                raise base.NativeRpcError("PHASE_REFUSED", self._unknown)
            try:
                self._cleanup_consumed = True
                self._phase = "shutdown"
                discarded = len(self._buffer) + self._queued_bytes
                self._drained_bytes += discarded
                self._buffer.clear(); self._queue.clear(); self._queued_bytes = 0
                if type(seconds) not in (int, float) or not math.isfinite(seconds) or not 0 < seconds <= 35:
                    raise ValueError()
                deadline = time.monotonic() + seconds
                with selectors.DefaultSelector() as selector:
                    selector.register(self._read_fd, selectors.EVENT_READ)
                    while not self._eof:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or discarded >= CLEANUP_READ_CAP: break
                        if not selector.select(remaining) or time.monotonic() >= deadline: break
                        try: data = os.read(self._read_fd, min(65536, CLEANUP_READ_CAP - discarded))
                        except BlockingIOError: continue
                        if not data: self._eof = True; break
                        discarded += len(data); self._drained_bytes += len(data)
                if not self._eof or discarded > CLEANUP_READ_CAP: raise ValueError()
                return True
            except Exception:
                self._code, self._unknown = "SHUTDOWN_UNKNOWN", True
                return False
            finally: self._lock.release()

        def epoch_metadata(self):
            return {"schema": "native-epoch-rpc-v1", "cancelRequested": self._cancel.is_set(),
                    "readCap": RAW_READ_CAP, "writeCap": RAW_WRITE_CAP,
                    "cleanupReadCap": CLEANUP_READ_CAP, "cleanupConsumed": self._cleanup_consumed,
                    "reservedWriteBytes": self._reserved_writes}

    return ManagedRpc


class ManagedDeadlineError(ValueError):
    def __init__(self, code):
        self.code, self.unknown = code, True
        super().__init__(code)


class ManagedDeadlineRpc:
    """Sole actor wrapper, explicit custody -> epoch deadline transition.

    begin_epoch() is called only after the composition has verified custody and
    capabilities. It invokes transport admission, which alone is not custody
    proof. Dispatch counters reserve before calls, never imply ACK/completion.
    response_ids() exposes only successful exact typed replies for idle handling.
    """
    def __init__(self, rpc, clock=time.monotonic):
        self.rpc, self.clock = rpc, clock
        now = self._now()
        self.deadline, self.epoch = now + PREP_SECONDS, False
        self._threads = self._turns = 0
        self._responses = []

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not math.isfinite(value): raise ManagedDeadlineError("CONFIG_REFUSED")
        return value

    def remaining(self, seconds=125):
        if type(seconds) not in (int, float) or not math.isfinite(seconds) or seconds <= 0:
            raise ManagedDeadlineError("BOUNDS_REFUSED")
        if self.rpc.cancel_requested(): raise ManagedDeadlineError("TRANSPORT_UNKNOWN")
        left = self.deadline - self._now()
        if left <= 0: raise ManagedDeadlineError("DEADLINE_UNKNOWN")
        return min(seconds, left, 300)

    def begin_epoch(self):
        self.remaining()
        if self.epoch: raise ManagedDeadlineError("PHASE_REFUSED")
        self.rpc.admit_model()
        self.remaining()
        self.epoch = True
        self.deadline = self._now() + EPOCH_SECONDS

    def exchange(self, method, params, seconds=10):
        limit = self.remaining(seconds)
        if method in {"thread/start", "turn/start"}:
            if not self.epoch: raise ManagedDeadlineError("PHASE_REFUSED")
            if method == "thread/start":
                if self._threads: raise ManagedDeadlineError("BOUNDS_REFUSED")
                self._threads += 1
            else:
                if self._threads != 1 or self._turns >= 16: raise ManagedDeadlineError("BOUNDS_REFUSED")
                self._turns += 1; self._responses = []
        elif self.epoch: raise ManagedDeadlineError("PHASE_REFUSED")
        value = self.rpc.exchange(method, params, limit)
        self.remaining()
        return value

    def initialized(self):
        if self.epoch: raise ManagedDeadlineError("PHASE_REFUSED")
        self.rpc.initialized(self.remaining(10)); self.remaining()

    def next_frame(self, seconds):
        value = self.rpc.next_frame(self.remaining(seconds)); self.remaining(); return value

    def respond(self, request_id, result, seconds):
        if not self.epoch or not self._turns or len(self._responses) >= 16:
            raise ManagedDeadlineError("BOUNDS_REFUSED")
        self.rpc.respond(request_id, result, self.remaining(seconds))
        # Actual write succeeded, even if the aggregate deadline expires next.
        self._responses.append(request_id)
        self.remaining()

    def counters(self): return {"threadStartDispatches": self._threads, "turnStartDispatches": self._turns}
    def response_ids(self): return tuple(self._responses)


SCOPED_PURPOSES = ("conversation", "history-analysis")


class ScopedManagedDeadlineRpc(ManagedDeadlineRpc):
    """Two-slot v1 or explicit three-slot v2; one RPC/reader and active turn.

    A slot is host-private, not a model-selected transport. This coordinator
    reserves before dispatch, never retries unknown writes, and has the SAME
    aggregate epoch/turn bounds as the legacy single-thread wrapper.
    """
    def __init__(self, rpc, idle_registry, clock=time.monotonic, *, protocol="standing-scoped-epoch-v1"):
        if type(protocol) is not str or protocol not in ("standing-scoped-epoch-v1", "standing-scoped-epoch-v2"):
            raise ManagedDeadlineError("PHASE_REFUSED")
        super().__init__(rpc, clock)
        self.protocol = protocol
        purposes = SCOPED_PURPOSES + (("community-assessment",) if protocol == "standing-scoped-epoch-v2" else ())
        self.idle_registry = idle_registry
        self._slots = {p: {"thread": None, "started": False, "turns": 0, "responses": []} for p in purposes}
        self._admitted, self._active, self._retired = 0, None, False
        self._seen_refs = set()

    def _need(self, value):
        if not value:
            self._retired = True
            raise ManagedDeadlineError("PHASE_REFUSED")

    def begin_turn(self, purpose, request_ref):
        import re
        self.remaining()
        self._need(self.epoch and not self._retired and self._active is None and type(purpose) is str and purpose in self._slots)
        self._need(type(request_ref) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", request_ref) is not None and request_ref not in self._seen_refs)
        turn_seconds = 30 if purpose == "community-assessment" else 300
        if self._admitted >= 16 or self.deadline - self._now() < turn_seconds:
            self._retired = True
            return {"kind": "notAdmitted", "requestRef": request_ref, "reason": "turns" if self._admitted >= 16 else "time", "turnsAdmitted": self._admitted}
        self._seen_refs.add(request_ref); self._admitted += 1
        self._active = {"purpose": purpose, "requestRef": request_ref, "number": self._admitted,
                        "deadline": min(self.deadline, self._now() + turn_seconds), "dispatched": False, "completed": False,
                        "threadsBefore": self._threads, "turnsBefore": self._turns}
        return self._admitted

    def _current(self, purpose):
        self._need(not self._retired and self._active is not None and self._active["purpose"] == purpose)
        return self._active

    def _turn_remaining(self, purpose, seconds):
        active = self._current(purpose)
        left = active["deadline"] - self._now()
        if left <= 0:
            self._retired = True
            raise ManagedDeadlineError("DEADLINE_UNKNOWN")
        return min(self.remaining(seconds), left)

    def slot(self, purpose):
        self._need(type(purpose) is str and purpose in self._slots)
        owner = self
        class Slot:
            def exchange(self, method, params, seconds):
                active = owner._current(purpose); slot = owner._slots[purpose]
                owner._need(not active["completed"] and type(params) is dict)
                limit = owner._turn_remaining(purpose, seconds)
                if method == "thread/start":
                    owner._need(not slot["started"] and owner._threads < len(owner._slots) and not active["dispatched"])
                    slot["started"] = True; owner._threads += 1
                elif method == "turn/start":
                    owner._need(slot["thread"] is not None and params.get("threadId") == slot["thread"] and not active["dispatched"] and owner._turns < 16)
                    active["dispatched"] = True; owner._turns += 1; slot["turns"] += 1; slot["responses"] = []
                else: owner._need(False)
                try:
                    value = owner.rpc.exchange(method, params, limit)
                    owner._turn_remaining(purpose, seconds)
                    if method == "thread/start":
                        owner._need(type(value) is tuple and len(value) == 2 and value[1] is None and type(value[0]) is dict)
                        thread = value[0].get("thread")
                        owner._need(type(thread) is dict and type(thread.get("id")) is str and bool(thread["id"]) and len(thread["id"].encode()) <= 128)
                        identifier = thread["id"]
                        owner._need(all(s["thread"] != identifier for s in owner._slots.values()))
                        slot["thread"] = identifier; owner.idle_registry.start(purpose, identifier)
                    return value
                except Exception:
                    owner._retired = True
                    raise

            def next_frame(self, seconds):
                try:
                    deadline = owner._now() + owner._turn_remaining(purpose, seconds)
                    while True:
                        left = deadline - owner._now()
                        if left <= 0: raise ManagedDeadlineError("DEADLINE_UNKNOWN")
                        frame = owner.rpc.next_frame(owner._turn_remaining(purpose, left))
                        owner._turn_remaining(purpose, left)
                        if owner._now() >= deadline: raise ManagedDeadlineError("DEADLINE_UNKNOWN")
                        if not owner.idle_registry.route(frame, purpose): return frame
                except Exception:
                    owner._retired = True
                    raise

            def respond(self, request_id, result, seconds):
                active = owner._current(purpose); slot = owner._slots[purpose]
                owner._need(active["dispatched"] and not active["completed"] and len(slot["responses"]) < 16)
                try:
                    owner.rpc.respond(request_id, result, owner._turn_remaining(purpose, seconds))
                    slot["responses"].append(request_id)
                    owner._turn_remaining(purpose, seconds)
                except Exception:
                    owner._retired = True
                    raise
        return Slot()

    def complete_turn(self, purpose, request_ref, scope):
        active = self._current(purpose); slot = self._slots[purpose]
        self._need(active["requestRef"] == request_ref and active["dispatched"] and not active["completed"] and type(scope) is dict)
        self._need(set(scope) == {"requestRef", "threadId", "turnId", "turnNumber"} and
                   scope.get("requestRef") == request_ref and scope.get("threadId") == slot["thread"] and
                   type(scope.get("turnNumber")) is int and scope["turnNumber"] == slot["turns"])
        self.idle_registry.complete(purpose, scope["threadId"], scope["turnId"], tuple(slot["responses"]))
        active["completed"] = True
        return {**scope, "purpose": purpose, "turnNumber": active["number"], "threadTurnNumber": scope["turnNumber"]}

    def finish_not_admitted(self, purpose, request_ref):
        # Session must additionally prove unchanged actor counters/state. Any
        # possible native thread/turn dispatch makes this non-admission invalid.
        active = self._current(purpose)
        self._need(active["requestRef"] == request_ref and not active["dispatched"] and
                   self._threads == active["threadsBefore"] and self._turns == active["turnsBefore"])
        self._admitted -= 1; self._active = None; self._retired = True
        return self._admitted

    def release_turn(self, purpose, request_ref, delivery):
        active = self._current(purpose)
        self._need(active["requestRef"] == request_ref and active["completed"] and delivery in ("verified", "not-sent", "unknown") and
                   (purpose == "conversation" or delivery == "not-sent"))
        self._active = None
        if delivery == "unknown": self._retired = True

    def close(self): self._retired = True

    def scoped_counters(self):
        return {**self.counters(), "turnsAdmitted": self._admitted, "active": self._active is not None, "retired": self._retired}

    # A caller cannot accidentally bypass the slot gate through inherited APIs.
    def exchange(self, method, params, seconds=10):
        if self.epoch: self._need(False)
        return super().exchange(method, params, seconds)

    def next_frame(self, seconds): self._need(False)
    def respond(self, request_id, result, seconds): self._need(False)
