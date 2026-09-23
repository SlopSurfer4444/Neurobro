"""Decoded duplex protocol over trusted hard-deadline ports; no I/O on import.

Caller owns source pins, custody, NDJSON codec, epochId, RPC, cancellation and OS
settlement. IDLE is a receive timeout, None is EOF. idle_native is a reviewed
non-poisoning drain/validator; never simulate it with NativeRpc.next_frame timeout.
Completed frames are per-turn evidence, not delivery or process settlement.
"""
import collections
import json
import threading
import math
import re
import time
import uuid

IDLE = object()
CLOSED_CODES = frozenset({"CLOSED", "EPOCH_LIMIT", "TURN_LIMIT", "INPUT_REFUSED", "PROTOCOL_REFUSED", "IO_UNKNOWN", "NATIVE_UNKNOWN", "RELEASE_UNKNOWN", "INTERNAL_UNKNOWN"})
DELIVERIES = frozenset({"verified", "not-sent", "unknown"})
FRAME_BYTES = 3 * 1024 * 1024
INPUT_FRAME_BYTES = 12 * 1024 * 1024
def incoming_frame_cap(value):
    return INPUT_FRAME_BYTES if type(value) is dict and value.get("kind") == "turn" and "images" in value else FRAME_BYTES
EPOCH_WIRE_BYTES = 512 * 1024 * 1024
# Native records call IDs before validating arguments/refusal budget. Each turn
# allows 8 callbacks + 4 refusals; one final over-budget ID can poison the epoch.
NATIVE_CALL_ID_CAP = 16 * (8 + 4) + 1
FACT_KEYS = frozenset({"threadStarted", "poisoned", "busy", "turnsAttempted", "toolCalls", "schema", "turnsAdmitted", "turnLimit", "epochSeconds", "turnSeconds", "running", "releasePending", "closed", "resourceSettlementObserved"})

class SessionStop(Exception):
    def __init__(self, code): self.code = code

def exact(value, keys): return type(value) is dict and set(value) == set(keys)
def identifier(value): return type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value) is not None
def wire_size(value):
    try: return len(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")) + 1
    except Exception: raise SessionStop("PROTOCOL_REFUSED") from None

def safe_facts(value, unreleased):
    if not exact(value, FACT_KEYS): raise SessionStop("INTERNAL_UNKNOWN")
    booleans = {"threadStarted", "poisoned", "busy", "running", "releasePending", "closed", "resourceSettlementObserved"}
    if any(type(value[k]) is not bool for k in booleans): raise SessionStop("INTERNAL_UNKNOWN")
    if any(type(value[k]) is not int or not 0 <= value[k] <= cap for k, cap in (("turnsAttempted",16),("turnsAdmitted",16),("toolCalls",NATIVE_CALL_ID_CAP))): raise SessionStop("INTERNAL_UNKNOWN")
    if value["schema"] != "neurobro-native-image-epoch-v1" or value["turnLimit"] != 16 or value["epochSeconds"] != 900 or value["turnSeconds"] != 300 or value["resourceSettlementObserved"] is not False:
        raise SessionStop("INTERNAL_UNKNOWN")
    return {**value, "unreleasedTurn": unreleased is True}


def run_session(epoch_factory, receive, emit, idle_native, validate_conversation, cancel_native, *, clock=time.monotonic, call_ref_factory=lambda: str(uuid.uuid4()), tool_names=None, analysis_tool_scope=None):
    """epoch_factory(tool=...,clock=...)->reviewed image epoch.

    receive(seconds)->strict decoded dict | IDLE | None. emit(dict,seconds)->True.
    idle_native(seconds)->'clear' must consume and validate only admitted native
    idle events using the same reader; any other result refuses the session.
    validate_conversation(str)->True is the pinned packed-conversation validator.
    A sole receiver thread observes close/EOF during ordinary model work; it
    revokes the actor and invokes cancel_native(), which must promptly interrupt
    the owned RPC. Main joins the model call and receiver before emitting closed.
    Every port must honor its deadline even for blocked reads/writes. The driver
    checks time after calls, but cannot interrupt an incorrectly blocking port.
    Returns the fixed closed message if emitted; raises only a fixed error if the
    output port cannot confirm that final message. Never resumes a failed turn.
    tool_names=None preserves legacy frames; an explicit ordered tuple enables
    named frames and must equal the source-owned actor registry, history first.
    """
    if not all(callable(x) for x in (epoch_factory, receive, emit, idle_native, validate_conversation, cancel_native, clock, call_ref_factory)):
        raise ValueError("native-session-ports-refused")
    named = tool_names is not None
    names = ("neurobro_read_history",) if not named else tool_names
    if (type(names) is not tuple or not 1 <= len(names) <= 32 or names[0] != "neurobro_read_history"
            or any(type(n) is not str or re.fullmatch(r"neurobro_[a-z][a-z0-9_]{0,54}", n) is None for n in names)
            or len(set(names)) != len(names)): raise ValueError("native-session-tools-refused")
    started = clock()
    if type(started) not in {int, float} or not math.isfinite(started): raise ValueError("native-session-clock-refused")
    epoch_deadline = started + 900
    actor = None
    current_ref = None
    pending_release = False
    outstanding_turn = False
    callback_stop = None
    turn_deadline = epoch_deadline
    seen_calls = set()
    inbound_bytes = outbound_bytes = 0
    condition = threading.Condition()
    mailbox = collections.deque()
    phase = "idle"
    stop_code = None
    receiver_thread = None
    waiting_call = None

    def set_phase(value):
        nonlocal phase
        with condition:
            phase = value
            condition.notify_all()

    def request_stop(code):
        nonlocal stop_code
        if type(code) is not str or code not in CLOSED_CODES: code = "INTERNAL_UNKNOWN"
        with condition:
            first = stop_code is None
            if first: stop_code = code
            condition.notify_all()
        if first:
            try:
                if actor is not None: actor.close()
            except Exception:
                with condition: stop_code = "INTERNAL_UNKNOWN"
            try: cancel_native()
            except Exception:
                with condition:
                    if stop_code == "CLOSED": stop_code = "IO_UNKNOWN"
                    condition.notify_all()

    def check_stop():
        with condition:
            if stop_code is not None: raise SessionStop(stop_code)


    def remaining(deadline, maximum):
        now = clock()
        if type(now) not in {int, float} or not math.isfinite(now) or now < started: raise SessionStop("INTERNAL_UNKNOWN")
        value = min(deadline, epoch_deadline) - now
        if value <= 0: raise SessionStop("EPOCH_LIMIT" if now >= epoch_deadline else "IO_UNKNOWN")
        return min(value, maximum)

    def write(message, deadline=epoch_deadline):
        nonlocal outbound_bytes
        check_stop()
        size = wire_size(message)
        if size > FRAME_BYTES or outbound_bytes + size > EPOCH_WIRE_BYTES: raise SessionStop("PROTOCOL_REFUSED")
        outbound_bytes += size  # Partial/uncertain write is consumed, never retried.
        try: accepted = emit(message, remaining(deadline, 20))
        except SessionStop: raise
        except Exception: raise SessionStop("IO_UNKNOWN") from None
        if accepted is not True: raise SessionStop("IO_UNKNOWN")
        check_stop()
        remaining(deadline, 20)

    def receive_pump():
        nonlocal inbound_bytes, phase
        try:
            while True:
                check_stop()
                try: value = receive(remaining(epoch_deadline, 1))
                except SessionStop: raise
                except Exception: raise SessionStop("IO_UNKNOWN") from None
                remaining(epoch_deadline, 1)
                if value is IDLE:
                    # A genuinely idle port may return sooner than its maximum.
                    # This bounded condition wait avoids spinning and wakes on STOP.
                    with condition: condition.wait(timeout=.005)
                    continue
                if value is None: raise SessionStop("IO_UNKNOWN")
                if type(value) is not dict: raise SessionStop("PROTOCOL_REFUSED")
                size = wire_size(value)
                if size > incoming_frame_cap(value) or inbound_bytes + size > EPOCH_WIRE_BYTES: raise SessionStop("PROTOCOL_REFUSED")
                inbound_bytes += size
                if exact(value, {"kind"}) and value["kind"] == "close": raise SessionStop("CLOSED")
                with condition:
                    if stop_code is not None: return
                    expected = {"idle": "turn", "tool": "toolResult", "release": "release"}.get(phase)
                    if value.get("kind") != expected or expected is None or mailbox:
                        raise SessionStop("PROTOCOL_REFUSED")
                    if phase == "tool" and (value.get("requestRef") != current_ref or value.get("callRef") != waiting_call):
                        raise SessionStop("PROTOCOL_REFUSED")
                    phase = "queued"
                    mailbox.append(value)
                    condition.notify_all()
        except SessionStop as error:
            request_stop(error.code)
        except Exception:
            request_stop("IO_UNKNOWN")

    def read(deadline):
        with condition:
            if stop_code is not None: raise SessionStop(stop_code)
            if not mailbox: condition.wait(timeout=remaining(deadline, 1))
            if stop_code is not None: raise SessionStop(stop_code)
            remaining(deadline, 1)
            return mailbox.popleft() if mailbox else IDLE

    def idle_check():
        try: result = idle_native(remaining(epoch_deadline, 1))
        except SessionStop: raise
        except Exception: raise SessionStop("NATIVE_UNKNOWN") from None
        remaining(epoch_deadline, 1)
        if result != "clear" or type(result) is not str: raise SessionStop("NATIVE_UNKNOWN")

    def tool(params, seconds):
        nonlocal callback_stop, waiting_call
        try:
            if type(seconds) not in {int, float} or not math.isfinite(seconds) or not 0 < seconds <= 20: raise SessionStop("PROTOCOL_REFUSED")
            if not exact(params, {"requestId", "arguments", "callId", "threadId", "turnId", "tool", "namespace"}) or type(params["tool"]) is not str or params["tool"] not in names or params["namespace"] is not None:
                raise SessionStop("PROTOCOL_REFUSED")
            call_ref = call_ref_factory()
            if not identifier(call_ref) or call_ref in seen_calls or len(seen_calls) >= 128: raise SessionStop("PROTOCOL_REFUSED")
            seen_calls.add(call_ref)
            waiting_call = call_ref
            set_phase("tool")
            deadline = min(clock() + seconds, turn_deadline, epoch_deadline)
            write({"kind": "tool", "requestRef": current_ref, "callRef": call_ref, "arguments": params["arguments"], **({"name": params["tool"]} if named else {})}, deadline)
            while True:
                message = read(deadline)
                if message is IDLE: continue
                if exact(message, {"kind"}) and message["kind"] == "close": raise SessionStop("CLOSED")
                if not exact(message, {"kind", "requestRef", "callRef", "result"}) or message["kind"] != "toolResult" or message["requestRef"] != current_ref or message["callRef"] != call_ref:
                    raise SessionStop("PROTOCOL_REFUSED")
                result = message["result"]
                if not exact(result, {"success", "contentItems"}) or type(result["success"]) is not bool or type(result["contentItems"]) is not list or len(result["contentItems"]) != 1:
                    raise SessionStop("PROTOCOL_REFUSED")
                item = result["contentItems"][0]
                if not exact(item, {"type", "text"}) or item["type"] != "inputText" or type(item["text"]) is not str or len(item["text"].encode("utf-8")) > (1088*1024 if analysis_tool_scope is not None and analysis_tool_scope() is True else 65536) or wire_size(result) > (2*1088*1024+512 if analysis_tool_scope is not None and analysis_tool_scope() is True else 131584):
                    raise SessionStop("PROTOCOL_REFUSED")
                waiting_call = None
                set_phase("turn")
                return result  # Native engine validates content and responds with exact native ID.
        except SessionStop as error:
            callback_stop = error.code
            request_stop(error.code)
            raise
        except Exception:
            callback_stop = "IO_UNKNOWN"
            request_stop("IO_UNKNOWN")
            raise SessionStop("IO_UNKNOWN") from None

    code = "INTERNAL_UNKNOWN"
    try:
        actor = epoch_factory(tool=tool, clock=clock)
        safe_facts(actor.state(), False)
        actor_names = getattr(actor, "tool_names", None)
        if named and not callable(actor_names) or callable(actor_names) and actor_names() != names: raise SessionStop("PROTOCOL_REFUSED")
        write({"kind": "ready", **({"tools": list(names)} if named else {})})
        receiver_thread = threading.Thread(target=receive_pump, daemon=True)
        receiver_thread.start()
        while True:
            message = read(epoch_deadline)
            if message is IDLE:
                idle_check()
                continue
            if exact(message, {"kind"}) and message["kind"] == "close": raise SessionStop("CLOSED")
            if pending_release:
                if not exact(message, {"kind", "requestRef", "delivery"}) or message["kind"] != "release" or message["requestRef"] != current_ref or type(message["delivery"]) is not str or message["delivery"] not in DELIVERIES:
                    raise SessionStop("PROTOCOL_REFUSED")
                actor.releaseTurn(current_ref, message["delivery"])
                pending_release = False
                outstanding_turn = False
                set_phase("idle" if message["delivery"] != "unknown" else "closing")
                write({"kind": "released", "requestRef": current_ref, "delivery": message["delivery"]})
                current_ref = None
                if message["delivery"] == "unknown": raise SessionStop("RELEASE_UNKNOWN")
                continue
            if not (exact(message, {"kind", "requestRef", "conversation"}) or exact(message, {"kind", "requestRef", "conversation", "images"})) or message["kind"] != "turn" or not identifier(message["requestRef"]): raise SessionStop("PROTOCOL_REFUSED")
            text = message["conversation"]
            if type(text) is not str or "\x00" in text or not 1 <= len(text.encode("utf-8")) <= 24576: raise SessionStop("INPUT_REFUSED")
            try: valid = validate_conversation(text)
            except Exception: raise SessionStop("INPUT_REFUSED") from None
            if valid is not True: raise SessionStop("INPUT_REFUSED")
            set_phase("turn")
            idle_check()
            check_stop()
            current_ref = message["requestRef"]
            turn_deadline = min(clock() + 300, epoch_deadline)
            callback_stop = None
            # Conservative admission marker survives close(), which revokes the
            # core's releasePending flag. Only confirmed release or an exact
            # atomic pre-admission proof clears it.
            outstanding_turn = True
            before_turn = safe_facts(actor.state(), True)
            value = actor.turn(current_ref, text, message["images"]) if "images" in message else actor.turn(current_ref, text)
            text = message = None
            check_stop()
            if callback_stop is not None: raise SessionStop(callback_stop)
            if type(value) is dict and value.get("kind") == "notAdmitted":
                after_turn = safe_facts(actor.state(), True)
                if (not exact(value, {"kind", "requestRef", "reason", "turnsAdmitted"}) or
                        value["requestRef"] != current_ref or value["reason"] not in {"time", "turns"} or
                        type(value["turnsAdmitted"]) is not int or not 0 <= value["turnsAdmitted"] <= 16 or
                        value["turnsAdmitted"] != before_turn["turnsAdmitted"] or
                        any(after_turn[k] != before_turn[k] for k in ("turnsAdmitted", "turnsAttempted", "toolCalls")) or
                        any(before_turn[k] or after_turn[k] for k in ("poisoned", "running", "busy", "closed", "releasePending")) or
                        (value["reason"] == "turns") != (value["turnsAdmitted"] == 16)):
                    raise SessionStop("NATIVE_UNKNOWN")
                # A concurrent close/poison wins over the refusal. Failed writes
                # still yield no host proof and never authorize a retry.
                with condition:
                    if stop_code is not None: raise SessionStop(stop_code)
                    outstanding_turn = False
                    phase = "closing"
                write(value)
                current_ref = None
                raise SessionStop("TURN_LIMIT" if value["reason"] == "turns" else "EPOCH_LIMIT")
            metadata = value["metadata"]
            if metadata["code"] == "SESSION_LIMIT":
                raise SessionStop("NATIVE_UNKNOWN")
            if metadata["outcome"] != "observed" or metadata["code"] != "OK" or metadata["turnCompleted"] is not True or metadata["sessionPoisoned"] is not False:
                raise SessionStop("NATIVE_UNKNOWN")
            remaining(turn_deadline, 20)
            answer = value["answer"]
            if type(answer) is not str or not answer.strip() or "\x00" in answer or len(answer.encode("utf-8")) > 4096: raise SessionStop("NATIVE_UNKNOWN")
            if any(type(metadata[k]) is not int or not 0 <= metadata[k] <= cap for k, cap in (("toolCalls", 8), ("toolRefusals", 4))): raise SessionStop("NATIVE_UNKNOWN")
            scope = actor.completed_turn_scope()
            if not exact(scope, {"requestRef", "threadId", "turnId", "turnNumber"}) or scope["requestRef"] != current_ref or not identifier(scope["threadId"]) or not identifier(scope["turnId"]) or type(scope["turnNumber"]) is not int or not 1 <= scope["turnNumber"] <= 16:
                raise SessionStop("NATIVE_UNKNOWN")
            pending_release = True
            set_phase("exporting")
            write({"kind": "scope", "scope": scope}, turn_deadline)
            image_ready = value["imageMetadata"]["exportReady"] is True
            if image_ready:
                image_count = image_bytes = 0
                for frame in actor.image_frames():
                    image_count += 1; image_bytes += wire_size(frame)
                    if image_count > 24 or image_bytes > 12 * 1024 * 1024: raise SessionStop("NATIVE_UNKNOWN")
                    write(frame, turn_deadline)
            set_phase("release")
            write({"kind": "completed", "scope": scope, "answer": answer, "kindOfAnswer": "image" if image_ready else "text",
                   "toolCalls": metadata["toolCalls"], "toolRefusals": metadata["toolRefusals"]}, turn_deadline)
            value = answer = scope = None
    except SessionStop as error:
        code = stop_code if stop_code is not None else error.code if type(error.code) is str and error.code in CLOSED_CODES else "INTERNAL_UNKNOWN"
    except Exception:
        code = "INTERNAL_UNKNOWN"
    finally:
        unreleased = outstanding_turn
        request_stop(code)
        if receiver_thread is not None:
            receiver_thread.join(2)
            if receiver_thread.is_alive(): raise ValueError("native-session-receiver-unsettled")
        current_ref = None
        with condition: mailbox.clear()
        if actor is not None: actor.close()
    if actor is None: raise ValueError("native-session-factory-refused")
    closed = {"kind": "closed", "code": stop_code or code, "facts": safe_facts(actor.state(), unreleased)}
    # A separate final10s write is a best-effort closure receipt, not an extension
    # of model work or OS settlement. No retry on an uncertain output write.
    try:
        if emit(closed, 10) is not True: raise ValueError()
    except Exception:
        raise ValueError("native-session-close-output-unknown") from None
    return closed


SCOPED_PURPOSES = ("conversation", "history-analysis")
ANALYSIS_NAMES = ("neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit")


def run_scoped_session(epoch_factory, receive, emit, idle_registry, validate_input, cancel_native,
                       *, budget, clock=time.monotonic, tool_names, protocol="standing-scoped-epoch-v1"):
    """Opt-in scoped wire over the unchanged single-pump legacy driver.

    Factories create two engines (three only with explicit v2), sharing one
    budget.slot(purpose) coordinator and the unchanged aggregate limits.
    Threads are lazy; no second process/reader/auth lifecycle is introduced.
    The compatibility actor below is internal only. Its aggregate legacy-shaped
    state is NEVER emitted: the scoped final has its own schema and dispatch
    counters. Production registration/normalizers must explicitly opt in.
    """
    if type(protocol) is not str or protocol not in ("standing-scoped-epoch-v1", "standing-scoped-epoch-v2"):
        raise ValueError("scoped-session-config-refused")
    scope_purposes = SCOPED_PURPOSES + (("community-assessment",) if protocol == "standing-scoped-epoch-v2" else ())
    if (getattr(budget, "protocol", "standing-scoped-epoch-v1") != protocol
            or getattr(idle_registry, "protocol", "standing-scoped-epoch-v1") != protocol):
        raise ValueError("scoped-session-config-refused")
    if (type(tool_names) is not dict or set(tool_names) != set(scope_purposes)
            or type(tool_names["conversation"]) is not tuple or not tool_names["conversation"]
            or tool_names["conversation"][0] != "neurobro_read_history"
            or tool_names["history-analysis"] != ANALYSIS_NAMES
            or protocol == "standing-scoped-epoch-v2" and (type(tool_names["community-assessment"]) is not tuple or tool_names["community-assessment"] != ())):
        raise ValueError("scoped-session-config-refused")
    names = tool_names["conversation"] + tool_names["history-analysis"]
    if len(names) > 32 or len(set(names)) != len(names) or any(type(n) is not str or re.fullmatch(r"neurobro_[a-z][a-z0-9_]{0,54}", n) is None for n in names):
        raise ValueError("scoped-session-config-refused")
    if not all(callable(v) for v in (epoch_factory, receive, emit, validate_input, cancel_native, clock)):
        raise ValueError("scoped-session-config-refused")
    purposes, holder = {}, {}
    wire_totals = {"in": 0, "out": 0}
    final_written = False
    def count_wire(direction, value):
        size = wire_size(value); wire_totals[direction] += size
        if size > (incoming_frame_cap(value) if direction == "in" else FRAME_BYTES) or wire_totals[direction] > EPOCH_WIRE_BYTES: raise SessionStop("PROTOCOL_REFUSED")

    class ScopedActor:
        def __init__(self, tool, clock):
            self.actors = {}; self.active_purpose = self.active_ref = None
            self.full_scope = None; self._closed = False
            try:
                for purpose in scope_purposes:
                    def callback(params, seconds, purpose=purpose):
                        if self.active_purpose != purpose or type(params) is not dict or params.get("tool") not in tool_names[purpose]:
                            raise SessionStop("PROTOCOL_REFUSED")
                        return tool(params, seconds)
                    actor = epoch_factory(purpose=purpose, tool=callback, clock=clock, rpc=budget.slot(purpose))
                    self.actors[purpose] = actor
                    if actor.tool_names() != tool_names[purpose]: raise SessionStop("PROTOCOL_REFUSED")
                    safe_facts(actor.state(), False)
            except Exception:
                self.close()
                raise

        def tool_names(self): return names

        def state(self):
            states = [a.state() for a in self.actors.values()]
            for state in states: safe_facts(state, False)
            return {"schema": "neurobro-native-image-epoch-v1", "turnLimit": 16, "epochSeconds": 900, "turnSeconds": 300,
                    "threadStarted": any(v["threadStarted"] for v in states), "poisoned": any(v["poisoned"] for v in states),
                    "busy": any(v["busy"] for v in states), "running": any(v["running"] for v in states),
                    "releasePending": any(v["releasePending"] for v in states), "closed": self._closed and all(v["closed"] for v in states),
                    "resourceSettlementObserved": False,
                    **{key: sum(v[key] for v in states) for key in ("turnsAdmitted", "turnsAttempted", "toolCalls")}}

        def turn(self, request_ref, text, images=None):
            if self._closed or self.active_ref is not None: raise SessionStop("PROTOCOL_REFUSED")
            purpose = purposes[request_ref]
            admitted = budget.begin_turn(purpose, request_ref)
            if type(admitted) is dict: return admitted
            self.active_purpose, self.active_ref = purpose, request_ref
            actor = self.actors[purpose]; before = safe_facts(actor.state(), False)
            if images is not None and purpose != "conversation": raise SessionStop("INPUT_REFUSED")
            value = actor.turn(request_ref, text, images) if images is not None else actor.turn(request_ref, text)
            if type(value) is dict and value.get("kind") == "notAdmitted":
                after = safe_facts(actor.state(), False)
                if (not exact(value, {"kind", "requestRef", "reason", "turnsAdmitted"}) or value["requestRef"] != request_ref
                        or value["reason"] not in ("time", "turns") or value["turnsAdmitted"] != before["turnsAdmitted"]
                        or any(before[k] != after[k] for k in ("turnsAdmitted", "turnsAttempted", "toolCalls"))
                        or any(before[k] or after[k] for k in ("poisoned", "busy", "running", "closed", "releasePending"))):
                    raise SessionStop("NATIVE_UNKNOWN")
                count = budget.finish_not_admitted(purpose, request_ref)
                self.active_purpose = self.active_ref = None
                return {**value, "turnsAdmitted": count}
            if purpose != "conversation" and value.get("imageMetadata", {}).get("exportReady") is not False:
                raise SessionStop("NATIVE_UNKNOWN")
            return value

        def completed_turn_scope(self):
            scope = self.actors[self.active_purpose].completed_turn_scope()
            self.full_scope = budget.complete_turn(self.active_purpose, self.active_ref, scope)
            return {k: self.full_scope[k] for k in ("requestRef", "threadId", "turnId", "turnNumber")}

        def image_frames(self):
            if self.active_purpose != "conversation": raise SessionStop("PROTOCOL_REFUSED")
            return self.actors["conversation"].image_frames()

        def releaseTurn(self, request_ref, delivery):
            if request_ref != self.active_ref or self.active_purpose is None: raise SessionStop("PROTOCOL_REFUSED")
            if self.active_purpose != "conversation" and delivery != "not-sent": raise SessionStop("PROTOCOL_REFUSED")
            self.actors[self.active_purpose].releaseTurn(request_ref, delivery)
            budget.release_turn(self.active_purpose, request_ref, delivery)
            self.active_purpose = self.active_ref = None
            return self.state()

        def close(self):
            self._closed = True; budget.close()
            for actor in self.actors.values(): actor.close()

        def final_facts(self, legacy):
            counters = budget.scoped_counters()
            slots = []
            for purpose in scope_purposes:
                state = safe_facts(self.actors[purpose].state(), False)
                slots.append({"purpose": purpose, **{k: state[k] for k in ("threadStarted", "turnsAdmitted", "turnsAttempted", "toolCalls", "closed", "poisoned")}})
            if (sum(v["turnsAdmitted"] for v in slots) > counters["turnsAdmitted"] or
                    sum(int(v["threadStarted"]) for v in slots) > counters["threadStartDispatches"]):
                raise SessionStop("INTERNAL_UNKNOWN")
            return {**legacy, "schema": "neurobro-native-scoped-epoch-v2" if protocol == "standing-scoped-epoch-v2" else "neurobro-native-scoped-epoch-v1", "threadLimit": len(scope_purposes),
                    "turnsAdmitted": counters["turnsAdmitted"],
                    "threadStartDispatches": counters["threadStartDispatches"], "turnStartDispatches": counters["turnStartDispatches"], "slots": slots}

    def factory(**ports):
        actor = ScopedActor(**ports); holder["actor"] = actor; return actor

    def scoped_receive(seconds):
        value = receive(seconds)
        if value is IDLE or value is None: return value
        count_wire("in", value)
        if exact(value, {"kind"}) and value["kind"] == "close": return value
        if type(value) is not dict: raise SessionStop("PROTOCOL_REFUSED")
        kind = value.get("kind")
        if kind == "turn":
            if (not (exact(value, {"kind", "purpose", "requestRef", "input"}) or exact(value, {"kind", "purpose", "requestRef", "input", "images"})) or value["purpose"] not in scope_purposes
                    or not identifier(value["requestRef"]) or value["requestRef"] in purposes or len(purposes) >= 17): raise SessionStop("PROTOCOL_REFUSED")
            if "images" in value and value["purpose"] != "conversation": raise SessionStop("INPUT_REFUSED")
            text = value["input"]
            try:
                valid = type(text) is str and "\x00" not in text and 1 <= len(text.encode()) <= 24576 and validate_input(value["purpose"], text) is True
            except Exception: valid = False
            if not valid: raise SessionStop("INPUT_REFUSED")
            purposes[value["requestRef"]] = value["purpose"]
            return {"kind": "turn", "requestRef": value["requestRef"], "conversation": text, **({"images":value["images"]} if "images" in value else {})}
        required = {"kind", "purpose", "requestRef", "delivery"} if kind == "release" else {"kind", "purpose", "requestRef", "callRef", "result"} if kind == "toolResult" else None
        actor = holder.get("actor")
        if required is None or not exact(value, required) or actor is None or value["purpose"] != actor.active_purpose or value["requestRef"] != actor.active_ref:
            raise SessionStop("PROTOCOL_REFUSED")
        return {k: v for k, v in value.items() if k != "purpose"}

    def scoped_emit(frame, seconds):
        nonlocal final_written
        actor = holder["actor"]; kind = frame["kind"]
        if kind == "ready":
            value = {"kind": "ready", "protocol": protocol, "scopes": [{"purpose": p, "tools": list(tool_names[p])} for p in scope_purposes]}
        elif kind in ("scope", "completed"):
            if actor.full_scope is None or frame["scope"]["requestRef"] != actor.full_scope["requestRef"]: raise SessionStop("PROTOCOL_REFUSED")
            value = {**frame, "scope": dict(actor.full_scope)}
        elif kind in ("tool", "released", "notAdmitted"):
            purpose = purposes.get(frame["requestRef"])
            if purpose is None: raise SessionStop("PROTOCOL_REFUSED")
            value = {**frame, "purpose": purpose}
            if kind == "notAdmitted": value["turnStartDispatches"] = budget.counters()["turnStartDispatches"]
        elif kind == "closed": value = {**frame, "facts": actor.final_facts(frame["facts"])}
        else: value = frame
        if kind == "closed":
            # Preserve the legacy once-only bounded final allowance even when
            # the ordinary cumulative wire budget caused shutdown.
            if final_written or wire_size(value) > FRAME_BYTES: raise SessionStop("PROTOCOL_REFUSED")
            final_written = True
        else:
            count_wire("out", value)
        return emit(value, seconds)

    def poll_idle(seconds):
        return idle_registry.poll(budget.rpc, min(seconds, budget.remaining(seconds)))

    result = run_session(factory, scoped_receive, scoped_emit, poll_idle,
                         lambda text: True, cancel_native, clock=clock, tool_names=names,
                         analysis_tool_scope=lambda: holder["actor"].active_purpose == "history-analysis")
    return {**result, "facts": holder["actor"].final_facts(result["facts"])}
