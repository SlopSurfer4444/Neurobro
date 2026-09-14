"""Actual host pipes and production driver; synthetic native RPC only.

The auxiliary stdin reader is fixture plumbing for Windows pipes, not the
production managed codec. Host ends stdin after closed; we join it before exit.
"""
import importlib.util
import json
import os
from pathlib import Path
import queue
import sys
import threading

root = Path(__file__).parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, root / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
f = load("fixtures", "rm-0032-native-image-epoch.test.py")
s = load("session", "rm-0032-native-epoch-session.py")
v = load("validator", "rm-0032-standing-image-client.py")
# Do not read ahead into the production unbuffered fd codec's next frame.
bootstrap = bytearray()
while not bootstrap.endswith(b"\n"):
    chunk = os.read(sys.stdin.fileno(), 1)
    assert chunk and len(bootstrap) < 131072
    bootstrap.extend(chunk)
packet = json.loads(bootstrap)
assert set(packet) == {"mode", "spec"} and packet["mode"] in {"sequence", "unknown", "stop-native", "stop-history", "named-sequence", "stop-extra", "not-admitted-time", "not-admitted-after-five"}
mode = packet["mode"]
not_admitted = mode in {"not-admitted-time", "not-admitted-after-five"}
prior_turns = 5 if mode == "not-admitted-after-five" else 0
synthetic_now = [0.0]
named = mode in {"named-sequence", "stop-extra"}
extras = [f.f.extra("neurobro_read_archive"), f.f.extra("neurobro_schedule_text")] if named else []
tool_names = ("neurobro_read_history", *(entry["spec"]["name"] for entry in extras)) if named else None
inbox = queue.Queue(maxsize=4)
cancelled = threading.Event()
cursor = None
history_calls = 0
coverage_complete = False
native_left = False

def read_pipe():
    while True:
        line = sys.stdin.buffer.readline(s.FRAME_BYTES + 2)
        if not line:
            inbox.put(None, timeout=2); return
        assert len(line) <= s.FRAME_BYTES + 1 and line.endswith(b"\n")
        inbox.put(json.loads(line), timeout=2)

reader = None
def receive(seconds):
    try: return inbox.get(timeout=seconds)
    except queue.Empty: return s.IDLE
def emit(value, seconds):
    sys.stdout.buffer.write((json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush(); return True
fd_wire = None
if sys.platform == "linux":
    codec = load("epoch_fd_codec", "rm-0032-native-epoch-wire.py")
    fd_wire = codec.NativeEpochWire(sys.stdin.fileno(), sys.stdout.fileno(), idle=s.IDLE)
    receive, emit = fd_wire.receive, fd_wire.emit
else:
    reader = threading.Thread(target=read_pipe)
    reader.start()
def validate(text):
    v.validate_request({"requestRef": "validation", "conversation": text}); return True
def request(turn):
    global history_calls
    history_calls += 1
    frame = f.f.request(turn, 2**63-history_calls, "history-"+str(history_calls))
    frame["params"]["arguments"] = {"fromDate": 1, "toDate": 200, "cursor": cursor}
    return frame
def plan(turn):
    if named:
        if turn == "turn-1":
            if mode == "stop-extra": return [f.f.named_request(turn, "neurobro_read_archive")]
            return [request(turn), f.f.named_request(turn, "neurobro_read_archive", rpc_id="9223372036854775807"),
                    f.f.named_request(turn, "neurobro_schedule_text", rpc_id=2**63-2, call_id="schedule-call"),
                    f.f.completed(turn, "История, архив и очередь проверены")]
        if turn == "turn-2": return f.images(turn)
        return [f.f.completed(turn, "Продолжаю ту же беседу")]
    if mode == "stop-history" or mode == "sequence" and turn in {"turn-1", "turn-2"}:
        return [request(turn)]
    if mode == "sequence" and turn == "turn-3": return f.images(turn)
    return [f.f.completed(turn, "Связанный ответ")]
class Rpc(f.f.Rpc):
    def next_frame(self, seconds):
        global native_left
        if mode == "stop-native":
            sys.stderr.write("FIXTURE_NATIVE_WAITING\n"); sys.stderr.flush()
            assert cancelled.wait(5), "fixture cancellation absent"
            native_left = True
            raise EOFError("synthetic cancellation")
        return super().next_frame(seconds)
    def respond(self, request_id, result, timeout):
        global cursor, coverage_complete
        if named:
            p = self.requests[(type(request_id), request_id)]
            assert result["success"] is True
            page = json.loads(result["contentItems"][0]["text"])
            if p["tool"] == "neurobro_read_history":
                assert type(request_id) is int and request_id == 2**63-1
                assert page["schema"] == "neurobro-self-history-v1"
            elif p["tool"] == "neurobro_read_archive":
                assert type(request_id) is str and request_id == "9223372036854775807"
                assert page == {"tool": p["tool"], "value": 1}
            else:
                assert p["tool"] == "neurobro_schedule_text" and type(request_id) is int and request_id == 2**63-2
                assert page == {"tool": p["tool"], "value": 1}
            return super().respond(request_id, result, timeout)
        assert type(request_id) is int and request_id == 2**63-history_calls and result["success"] is True
        page = json.loads(result["contentItems"][0]["text"])
        assert page["schema"] == "neurobro-self-history-v1"
        cursor, coverage_complete = page["cursor"], page["coverage"]["traversalComplete"]
        super().respond(request_id, result, timeout)
        turn = "turn-"+str(self.turn)
        self.frames.append(f.f.completed(turn, "История частично прочитана" if history_calls == 8 else "Доступный период прочитан")
                           if history_calls in {8, 10} else request(turn))
rpc = Rpc(plan)
def factory(**ports):
    return f.e.create_native_image_epoch(f.f.m, f.c, f.f.SOURCE, profile=f.f.PROFILE, cwd=f.f.CWD,
        tool_spec=packet["spec"], instructions="Synthetic bound history and image fixture.", rpc=rpc, extra_tools=extras, **ports)
def idle_native(seconds):
    if not_admitted and rpc.turn == prior_turns: synthetic_now[0] = 600.001
    return "clear"
closed = s.run_session(factory, receive, emit, idle_native, validate, cancelled.set, tool_names=tool_names,
                       **({"clock": lambda: synthetic_now[0]} if not_admitted else {}))
if reader is not None:
    reader.join(3)
    assert not reader.is_alive()
if fd_wire is not None: fd_wire.close()
assert closed["facts"]["running"] is False and closed["facts"]["resourceSettlementObserved"] is False
assert sum(method == "thread/start" for method, _ in rpc.calls) == (0 if mode == "not-admitted-time" else 1)
if not_admitted:
    assert rpc.turn == prior_turns and history_calls == 0 and not rpc.responses
    assert sum(method == "turn/start" for method, _ in rpc.calls) == prior_turns
    assert closed["code"] == "EPOCH_LIMIT" and closed["facts"]["unreleasedTurn"] is False
    assert closed["facts"]["turnsAdmitted"] == prior_turns and closed["facts"]["poisoned"] is False
elif mode == "named-sequence":
    assert rpc.turn == 3 and history_calls == 1 and len(rpc.responses) == 3
    assert closed["code"] == "CLOSED" and closed["facts"]["unreleasedTurn"] is False
    assert [x["name"] for x in rpc.calls[0][1]["dynamicTools"]] == list(tool_names)
elif mode == "sequence":
    assert rpc.turn == 4 and history_calls == 10 and coverage_complete
    assert closed["code"] == "CLOSED" and closed["facts"]["unreleasedTurn"] is False
elif mode == "unknown":
    assert rpc.turn == 1 and closed["code"] == "RELEASE_UNKNOWN" and closed["facts"]["poisoned"]
else:
    assert rpc.turn == 1 and closed["code"] == "CLOSED" and not rpc.responses
    assert mode != "stop-native" or native_left
