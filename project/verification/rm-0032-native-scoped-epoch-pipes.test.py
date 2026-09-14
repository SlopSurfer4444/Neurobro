"""Synthetic Linux anonymous pipes: two actual engines, one real RPC reader.

No subprocess, model, network, credentials or production entrypoint. Portable
discovery skips the selector test. EOF below is pipe EOF, never process proof.
"""
import copy
import importlib.util
import json
from pathlib import Path
import queue
import sys
import threading
import time
import unittest


ROOT = Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pipe = load("scoped_pipe_fixture", "rm-0032-native-rpc.test.py")
f = load("scoped_conversation_fixture", "rm-0032-native-conversation.test.py")
managed = load("scoped_managed_rpc", "rm-0032-native-epoch-managed-rpc.py")
epoch_rpc = load("scoped_epoch_rpc", "rm-0032-native-epoch-rpc.py")
idle = load("scoped_idle", "rm-0032-native-epoch-idle.py")
session = load("scoped_session", "rm-0032-native-epoch-session.py")
engine = load("scoped_image_epoch", "rm-0032-native-image-epoch.py")
collector = load("scoped_image_collector", "rm-0032-native-image-collector.py")

ManagedRpc = managed.create_managed_rpc_class(pipe.rpc_module, epoch_rpc)


class ObservedRpc(ManagedRpc):
    """Observe the inherited lock entry; do not add another reader/parser."""
    def __init__(self, *args, **kwargs):
        self.reader_threads = set()
        super().__init__(*args, **kwargs)

    def _enter(self):
        self.reader_threads.add(threading.get_ident())
        return super()._enter()


pipe.rpc_module.NativeRpc = ObservedRpc
PURPOSES = ("conversation", "history-analysis")
ANALYSIS = ("neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit")
TOOLS = {"conversation": (f.m.NAME,), "history-analysis": ANALYSIS}


@unittest.skipUnless(sys.platform == "linux", "Anonymous-pipe selector contract is Linux-only")
class ScopedPipeTests(unittest.TestCase):
    def test_conversation_analysis_conversation_share_reader_and_global_budget(self):
        with pipe.Peer(self, "image") as peer:
            native_requests, native_responses, thread_ids = [], [], []
            finished = threading.Event()
            inbox = queue.Queue()
            frames, receivers, actors = [], set(), {}
            sequence = ("conversation", "history-analysis", "conversation")
            registry = idle.ScopedEpochIdleRegistry(idle_sentinel=epoch_rpc.IDLE)
            budget = managed.ScopedManagedDeadlineRpc(peer.rpc, registry)

            def server():
                try:
                    init = peer.receive()
                    self.assertEqual(init["method"], "initialize")
                    peer.send({"id": init["id"], "result": {"ready": True}})
                    self.assertEqual(peer.receive(), {"method": "initialized"})
                    for number, purpose in enumerate(sequence, 1):
                        request = peer.receive()
                        if number < 3:
                            self.assertEqual(request["method"], "thread/start")
                            native_requests.append(copy.deepcopy(request))
                            thread_id = "thread-conversation" if number == 1 else "thread-analysis"
                            thread_ids.append(thread_id)
                            tools = request["params"]["dynamicTools"]
                            self.assertEqual(tuple(x["name"] for x in tools), TOOLS[purpose])
                            if purpose == "history-analysis":
                                config = request["params"]["config"]
                                self.assertEqual(config["web_search"], "disabled")
                                self.assertIs(config["features.image_generation"], False)
                            peer.send({"id": request["id"], "result": {
                                "thread": {"id": thread_id, "ephemeral": True},
                                "model": "gpt-6-astra", "modelProvider": "openai",
                                "reasoningEffort": "medium", "cwd": f.CWD,
                                "approvalPolicy": "never", "approvalsReviewer": "user",
                                "activePermissionProfile": {"id": f.PROFILE}}})
                            request = peer.receive()
                        thread_id = "thread-analysis" if purpose == "history-analysis" else "thread-conversation"
                        self.assertEqual(request["method"], "turn/start")
                        self.assertEqual(request["params"]["threadId"], thread_id)
                        native_requests.append(copy.deepcopy(request))
                        turn_id = "turn-" + str(number)
                        if number == 2:
                            # This prior conversation event is queued by the sole
                            # actual RPC reader before the analysis turn ACK.
                            peer.send({"method": "thread/status/changed", "params": {
                                "threadId": "thread-conversation", "status": {"type": "idle"}}})
                        peer.send({"id": request["id"], "result": {
                            "turn": {"id": turn_id, "items": [], "status": "inProgress"}}})
                        items = []
                        names = TOOLS[purpose] if number < 3 else ()
                        for index, name in enumerate(names):
                            native_id = 2**63 - 1 - number * 10 - index
                            call_id = "call-%s-%s" % (number, index)
                            args = copy.deepcopy(f.ARGS) if name == f.m.NAME else {"value": index}
                            peer.send({"id": native_id, "method": "item/tool/call", "params": {
                                "threadId": thread_id, "turnId": turn_id, "callId": call_id,
                                "tool": name, "arguments": args, "namespace": None}})
                            response = peer.receive()
                            self.assertEqual(response["id"], native_id)
                            self.assertIs(type(response["id"]), int)
                            self.assertEqual(response["result"], f.RESULT)
                            native_responses.append(copy.deepcopy(response))
                            item = {"id": call_id, "type": "dynamicToolCall", "tool": name,
                                    "namespace": None, "arguments": args, "status": "completed",
                                    **copy.deepcopy(response["result"])}
                            items.append(item)
                            peer.send({"method": "item/completed", "params": {
                                "threadId": thread_id, "turnId": turn_id, "completedAtMs": 1, "item": item}})
                        items.append(f.message(turn_id, "Synthetic answer " + str(number)))
                        peer.send({"method": "turn/completed", "params": {
                            "threadId": thread_id, "turn": {"id": turn_id,
                            "items": items, "status": "completed"}}})
                    self.assertIsNone(peer.receive())
                    peer.server_out.close()
                except BaseException:
                    peer.rpc.cancel()
                    raise

            def receive(seconds):
                receivers.add(threading.get_ident())
                try:
                    return inbox.get(timeout=min(seconds, .02))
                except queue.Empty:
                    return session.IDLE

            def turn(number):
                return {"kind": "turn", "purpose": sequence[number - 1],
                        "requestRef": "request-" + str(number), "input": "Synthetic input " + str(number)}

            def emit(value, seconds):
                frames.append(copy.deepcopy(value))
                if value["kind"] == "ready":
                    self.assertEqual(native_requests, [])
                    self.assertEqual(set(actors), set(PURPOSES))
                    self.assertTrue(all(not actor.state()["threadStarted"] for actor in actors.values()))
                    inbox.put(turn(1))
                elif value["kind"] == "tool":
                    inbox.put({"kind": "toolResult", "purpose": value["purpose"],
                               "requestRef": value["requestRef"], "callRef": value["callRef"],
                               "result": copy.deepcopy(f.RESULT)})
                elif value["kind"] == "completed":
                    scope = value["scope"]
                    inbox.put({"kind": "release", "purpose": scope["purpose"],
                               "requestRef": scope["requestRef"],
                               "delivery": "not-sent" if scope["purpose"] == "history-analysis" else "verified"})
                elif value["kind"] == "released":
                    number = int(value["requestRef"].split("-")[-1])
                    inbox.put(turn(number + 1) if number < 3 else {"kind": "close"})
                return True

            def factory(*, purpose, **ports):
                options = {}
                if purpose == "history-analysis":
                    options = {"enable_web": False,
                               "thread_config": {"web_search": "disabled", "features.image_generation": False},
                               "extra_tools": [f.extra(name) for name in ANALYSIS]}
                actor = engine.create_native_image_epoch(f.m, collector, f.SOURCE,
                    profile=f.PROFILE, cwd=f.CWD, tool_spec=copy.deepcopy(f.SPEC),
                    instructions="Use only the declared tools for this synthetic scope.", **options, **ports)
                actors[purpose] = actor
                return actor

            # A fixture failure cannot wait for a production 300-second deadline.
            watchdog = threading.Thread(target=lambda: None if finished.wait(10) else peer.rpc.cancel(), daemon=True)
            watchdog.start()
            try:
                peer.worker(server)
                self.assertEqual(budget.exchange("initialize", {}, 1), ({"ready": True}, None))
                budget.initialized()
                budget.begin_epoch()
                closed = session.run_scoped_session(factory, receive, emit, registry,
                    lambda purpose, text: purpose in PURPOSES and text.startswith("Synthetic input "),
                    peer.rpc.cancel, budget=budget, clock=time.monotonic, tool_names=TOOLS)
                self.assertEqual(closed["code"], "CLOSED")
                peer.rpc.close_input()
                self.assertTrue(peer.rpc.drain_to_eof(1))
                peer.threads[-1].join(1)
                self.assertFalse(peer.threads[-1].is_alive())
            finally:
                finished.set()
                watchdog.join(1)

            self.assertEqual(frames[0], {"kind": "ready", "protocol": "standing-scoped-epoch-v1",
                "scopes": [{"purpose": p, "tools": list(TOOLS[p])} for p in PURPOSES]})
            scopes = [value["scope"] for value in frames if value["kind"] == "completed"]
            self.assertEqual([x["purpose"] for x in scopes], list(sequence))
            self.assertEqual([x["threadId"] for x in scopes], [thread_ids[0], thread_ids[1], thread_ids[0]])
            self.assertEqual([x["turnNumber"] for x in scopes], [1, 2, 3])
            self.assertEqual([x["threadTurnNumber"] for x in scopes], [1, 1, 2])
            self.assertEqual([x["method"] for x in native_requests],
                             ["thread/start", "turn/start", "thread/start", "turn/start", "turn/start"])
            self.assertEqual(len(native_responses), 4)
            callbacks = [x for x in frames if x["kind"] == "tool"]
            self.assertEqual([(x["purpose"], x["name"]) for x in callbacks],
                             [("conversation", f.m.NAME)] + [("history-analysis", name) for name in ANALYSIS])
            self.assertEqual(registry.state()["frames"], 1)
            self.assertFalse(registry.state()["poisoned"])
            self.assertEqual(peer.rpc.reader_threads, {threading.get_ident()})
            self.assertEqual(len(receivers), 1)
            self.assertNotIn(threading.get_ident(), receivers)
            facts = closed["facts"]
            self.assertEqual(facts["schema"], "neurobro-native-scoped-epoch-v1")
            self.assertEqual((facts["threadLimit"], facts["turnLimit"], facts["epochSeconds"], facts["turnSeconds"]), (2, 16, 900, 300))
            self.assertEqual((facts["threadStartDispatches"], facts["turnStartDispatches"], facts["turnsAdmitted"], facts["turnsAttempted"]), (2, 3, 3, 3))
            self.assertFalse(facts["resourceSettlementObserved"])
            self.assertFalse(facts["unreleasedTurn"])
            self.assertTrue(facts["closed"])
            self.assertEqual([(x["purpose"], x["turnsAdmitted"], x["turnsAttempted"], x["toolCalls"]) for x in facts["slots"]],
                             [("conversation", 2, 2, 1), ("history-analysis", 1, 1, 3)])
            serialized = json.dumps(facts)
            self.assertNotIn("thread-conversation", serialized)
            self.assertNotIn("thread-analysis", serialized)


if __name__ == "__main__":
    unittest.main()
