"""Synthetic pipe fixture only. Never starts an App Server or Telegram client."""
import importlib.util
import json
from pathlib import Path
import sys

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("native_fixture_engine", root / "rm-0032-native-conversation.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
source = (root / "rm-0032-astra-canary-client.py").read_text(encoding="utf-8")

def receive():
    line = sys.stdin.buffer.readline(262145)
    if not line or len(line) > 262144 or not line.endswith(b"\n"):
        raise ValueError("fixture-frame")
    return json.loads(line)

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()

class Rpc:
    def __init__(self):
        self.frames, self.turn, self.starts, self.responses = [], 0, 0, 0

    def exchange(self, method, params, timeout):
        if method == "thread/start":
            self.starts += 1
            return {"thread": {"id": "thread-fixture", "ephemeral": True}, "model": "gpt-6-astra",
                    "modelProvider": "openai", "reasoningEffort": "medium", "cwd": "/run/decadans-fixture/workspace",
                    "approvalPolicy": "never", "approvalsReviewer": "user", "activePermissionProfile": {"id": "decadans-fixture"}}, None
        assert method == "turn/start"
        assert params["threadId"] == "thread-fixture"
        assert params["input"][0]["text"] == ("Первый вопрос" if self.turn == 0 else "Продолжение")
        self.turn += 1
        self.turn_id = "turn-" + str(self.turn)
        self.call_id = "call-" + str(self.turn)
        self.frames.append({"id": 2**63 - self.turn, "method": "item/tool/call", "params": {
            "threadId": "thread-fixture", "turnId": self.turn_id, "callId": self.call_id,
            "tool": engine.NAME, "arguments": {"fromDate": 1, "toDate": 200, "cursor": None}}})
        return {"turn": {"id": self.turn_id, "items": [], "status": "inProgress"}}, None

    def next_frame(self, timeout):
        return self.frames.pop(0)

    def respond(self, request_id, result, timeout):
        assert request_id == 2**63 - self.turn and result["success"] is True
        page = json.loads(result["contentItems"][0]["text"])
        assert page["messages"][0]["text"] == 'Выдуманный ответ "\\" 🤝'
        self.responses += 1
        tool = {"id": self.call_id, "type": "dynamicToolCall", "tool": engine.NAME,
                "arguments": {"fromDate": 1, "toDate": 200, "cursor": None}, "status": "completed", **result}
        self.frames.append({"method": "turn/completed", "params": {"threadId": "thread-fixture", "turn": {
            "id": self.turn_id, "status": "completed", "items": [tool, {"id": "answer-" + str(self.turn),
            "type": "agentMessage", "phase": "final_answer", "text": "История получена"}]}}})

def history(params, timeout):
    # The original native int64 stays in Python. The host receives no rounded ID.
    emit({"kind": "tool", "callId": params["callId"], "arguments": params["arguments"]})
    reply = receive()
    assert reply["callId"] == params["callId"]
    return reply["result"]

packet = receive()
rpc = Rpc()
conversation = engine.NativeConversation(source, profile="decadans-fixture", cwd="/run/decadans-fixture/workspace",
    tool_spec=packet["spec"], instructions="Synthetic fixture. Only the declared history tool is available.", rpc=rpc, tool=history)
results = [conversation.run("Первый вопрос"), conversation.run("Продолжение")]
emit({"kind": "done", "codes": [r["metadata"]["code"] for r in results], "threadStarts": rpc.starts,
      "turns": rpc.turn, "responses": rpc.responses, "answersValid": all(r["answer"] == "История получена" for r in results)})
