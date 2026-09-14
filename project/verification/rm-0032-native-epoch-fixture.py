"""Synthetic four-turn duplex fixture. No App Server/model/Telegram process."""
import importlib.util
import json
from pathlib import Path
import sys

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("epoch_fixture", root / "rm-0032-native-image-epoch.test.py")
f = importlib.util.module_from_spec(spec); spec.loader.exec_module(f)

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"); sys.stdout.flush()

def receive():
    line = sys.stdin.buffer.readline(262145)
    assert line and len(line) <= 262144 and line.endswith(b"\n")
    return json.loads(line)

cursor = None
history_calls = 0
coverage_complete = False

def request(turn):
    global history_calls
    history_calls += 1
    frame = f.f.request(turn, 2**63 - history_calls, "history-" + str(history_calls))
    frame["params"]["arguments"] = {"fromDate":1,"toDate":200,"cursor":cursor}
    return frame

def plan(turn):
    if turn in {"turn-1","turn-2"}: return [request(turn)]
    if turn == "turn-3": return f.images(turn)
    return [f.f.completed(turn,"Связанный ответ")]

class Rpc(f.f.Rpc):
    def respond(self, request_id, result, timeout):
        global cursor, coverage_complete
        assert type(request_id) is int and request_id == 2**63 - history_calls and result["success"] is True
        page = json.loads(result["contentItems"][0]["text"])
        assert page["schema"] == "neurobro-self-history-v1"
        cursor, coverage_complete = page["cursor"], page["coverage"]["traversalComplete"]
        super().respond(request_id,result,timeout)
        turn="turn-"+str(self.turn)
        if history_calls in {8,10}: self.frames.append(f.f.completed(turn,"История частично прочитана" if history_calls==8 else "Доступный период прочитан"))
        else: self.frames.append(request(turn))

def history(params, timeout):
    emit({"kind":"tool","callId":params["callId"],"arguments":params["arguments"]})
    reply=receive(); assert reply["callId"]==params["callId"]
    return reply["result"]

packet=receive();rpc=Rpc(plan)
actor=f.e.create_native_image_epoch(f.f.m,f.c,f.f.SOURCE,profile=f.f.PROFILE,cwd=f.f.CWD,
    tool_spec=packet["spec"],instructions="Synthetic bound history and image fixture.",rpc=rpc,tool=history)
codes=[]
for number in range(1,5):
    ref="request-"+str(number);result=actor.turn(ref,"Запрос "+str(number))
    assert result["metadata"]["outcome"]=="observed", result["metadata"]
    codes.append(result["metadata"]["code"])
    scope=actor.completed_turn_scope()
    emit({"kind":"scope","scope":scope})
    image=result["imageMetadata"]["exportReady"]
    if image:
        for frame in actor.image_frames(): emit(frame)
    emit({"kind":"completed","scope":scope,"answer":result["answer"],"image":image,
          "toolCalls":result["metadata"]["toolCalls"]})
    released=receive();assert released=={"kind":"release","requestRef":ref,"delivery":"verified"}
    actor.releaseTurn(ref,released["delivery"])
actor.close()
emit({"kind":"done","codes":codes,"threadStarts":sum(method=="thread/start" for method,_ in rpc.calls),
      "turns":rpc.turn,"historyCalls":history_calls,"coverageComplete":coverage_complete})
