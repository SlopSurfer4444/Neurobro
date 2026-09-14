"""Actual native engine + selector RPC on anonymous Linux pipes; fake server only."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

fixture = load("rpc_pipe_fixture", "rm-0032-native-rpc.test.py")
native = load("native_engine_fixture", "rm-0032-native-conversation.py")
SOURCE = (ROOT / "rm-0032-astra-canary-client.py").read_text(encoding="utf-8")
PROFILE, CWD = "decadans-rpc-fixture", "/run/decadans-rpc-fixture/workspace"
SPEC = {"type":"function", "name":"neurobro_read_history", "description":"Synthetic history only", "inputSchema":{
    "type":"object", "additionalProperties":False, "properties":{
        "fromDate":{"type":"integer","minimum":1,"maximum":2147483646},
        "toDate":{"type":"integer","minimum":1,"maximum":2147483646}, "cursor":{"type":["string","null"]}},
    "required":["fromDate","toDate","cursor"]}}

@unittest.skipUnless(sys.platform == "linux", "Linux selector pipe integration")
class Integration(unittest.TestCase):
    def test_native_engine_reuses_actual_rpc_and_thread_with_tools_before_turn_ack(self):
        with fixture.Peer(self) as peer:
            peer.initialize(); starts = []; callbacks = []
            arguments = {"fromDate":1,"toDate":200,"cursor":None}
            def server():
                start = peer.receive(); self.assertEqual(start["method"],"thread/start"); starts.append(start)
                self.assertEqual(start["params"]["dynamicTools"],[SPEC])
                peer.send({"jsonrpc":"2.0","id":start["id"],"result":{"thread":{"id":"thread-one","ephemeral":True},
                    "model":"gpt-6-astra","modelProvider":"openai","reasoningEffort":"medium","cwd":CWD,
                    "approvalPolicy":"never","approvalsReviewer":"user","activePermissionProfile":{"id":PROFILE}}})
                for number, question in [(1,"Первый вопрос"),(2,"Продолжение")]:
                    turn = peer.receive(); self.assertEqual(turn["method"],"turn/start")
                    self.assertEqual(turn["params"]["threadId"],"thread-one")
                    self.assertEqual(turn["params"]["input"][0]["text"],question)
                    turn_id,call_id,request_id = "turn-"+str(number),"call-"+str(number),2**63-number
                    # Server request arrives before the turn/start response. The
                    # actual transport must defer it, not lose it or read twice.
                    peer.send({"jsonrpc":"2.0","id":request_id,"method":"item/tool/call","params":{
                        "threadId":"thread-one","turnId":turn_id,"callId":call_id,"tool":native.NAME,"arguments":arguments}})
                    peer.send({"id":turn["id"],"result":{"turn":{"id":turn_id,"items":[],"status":"inProgress"}}})
                    response = peer.receive(); self.assertEqual(response["id"],request_id); self.assertIs(type(response["id"]),int)
                    self.assertTrue(response["result"]["success"])
                    self.assertEqual(json.loads(response["result"]["contentItems"][0]["text"])["messages"][0]["text"],"История 🤝")
                    item={"id":call_id,"type":"dynamicToolCall","tool":native.NAME,"arguments":arguments,"status":"completed",**response["result"]}
                    peer.send({"method":"serverRequest/resolved","emittedAtMs":1789015200123,"params":{"threadId":"thread-one","requestId":request_id}})
                    peer.send({"method":"turn/completed","emittedAtMs":1789015200124,"params":{"threadId":"thread-one","turn":{"id":turn_id,"status":"completed","items":[item,
                        {"id":"answer-"+str(number),"type":"agentMessage","phase":"final_answer","text":"Ответ "+str(number)}]}}})
                self.assertIsNone(peer.receive()); peer.server_out.close()
            peer.worker(server)
            def history(params, timeout):
                callbacks.append(params["requestId"])
                return {"success":True,"contentItems":[{"type":"inputText","text":json.dumps({"messages":[{"text":"История 🤝"}],"hasMore":False},ensure_ascii=False)}]}
            engine = native.NativeConversation(SOURCE,profile=PROFILE,cwd=CWD,tool_spec=SPEC,instructions="Use only the synthetic history tool.",rpc=peer.rpc,tool=history)
            results = [engine.run("Первый вопрос"),engine.run("Продолжение")]
            self.assertEqual([r["metadata"]["code"] for r in results],["OK","OK"])
            self.assertEqual([r["answer"] for r in results],["Ответ 1","Ответ 2"])
            self.assertEqual(callbacks,[2**63-1,2**63-2]); self.assertEqual(len(starts),1)
            peer.rpc.close_input(); self.assertTrue(peer.rpc.drain_to_eof(1))
            self.assertNotIn("processSettled",peer.rpc.metadata())

if __name__ == "__main__": unittest.main()
