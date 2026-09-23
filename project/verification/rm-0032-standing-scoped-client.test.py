"""Candidate-only scoped producer tests; no real process, model or network.

The test locally binds PINS to supplied current source snapshots. This is not a
production pin migration, installed capability proof, or live acceptance.
"""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("scoped_producer", ROOT / "rm-0032-standing-epoch-client.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
# This fixture needs only the producer and its ten actual runtime sources.
# Keep unrelated legacy scenarios out of the bounded public transfer packet.
NAMES={"custody":"rm-0032-managed-custody-client.py","canary":"rm-0032-astra-canary-client.py",
       "native":"rm-0032-native-conversation.py","rpc":"rm-0032-native-rpc.py",
       "collector":"rm-0032-native-image-collector.py","epoch":"rm-0032-native-image-epoch.py",
       "session":"rm-0032-native-epoch-session.py","epochRpc":"rm-0032-native-epoch-rpc.py",
       "managedRpc":"rm-0032-native-epoch-managed-rpc.py","idleValidator":"rm-0032-native-epoch-idle.py"}
CONFIG={"root":"/run/decadans-warm-fixture","cwd":"/run/decadans-warm-fixture/workspace","profile":"decadans-warm-fixture"}
TEXT=json.dumps({"schema":"neurobro-conversation-v1","currentRequest":{"text":"Привет"},"replyChain":[],"recent":[],"contextState":{}},ensure_ascii=False)
TOOL_CASES=[("neurobro_read_history",{"fromDate":1,"toDate":200,"cursor":None})]
def sources():return {key:(ROOT/name).read_text(encoding="utf-8") for key,name in NAMES.items()}
def tool_result(name,args=None):
    value={"schema":"neurobro-self-history-v1","messages":[],"coverage":{"traversalComplete":True}} if name=="neurobro_read_history" else {"fixtureTool":name,"private":"fixture result"}
    return {"success":True,"contentItems":[{"type":"inputText","text":json.dumps(value,separators=(',',':'))}]}
NODE = "hnode_" + "a" * 48
SOURCE = "hsrc_" + "b" * 48
VERSION = "hver_" + "c" * 48
POSITION = "hnpos_12_3_" + "d" * 48
SUPPORT = {"sourceRef": SOURCE, "versionRef": VERSION}
OUTPUT = {"summary": "Synthetic bounded summary", "claims": [
    {"kind": "reported", "text": "A synthetic statement", "supports": [SUPPORT]}]}
ANALYSIS_CASES = [("neurobro_analysis_material", {}),
                  ("neurobro_analysis_notes", {"nodeRef": NODE, "position": None}),
                  ("neurobro_analysis_commit", {"output": OUTPUT})]
INPUT = {"schema": "neurobro-history-analysis-input-v1", "kind": "merge",
         "objective": "Summarize the shown synthetic sources", "materialAvailable": True}
ANALYSIS_TEXT = json.dumps(INPUT, separators=(",", ":"))


class PortableTests(unittest.TestCase):
    def test_bounded_continuation_schema_parity(self):
        for text in ('x', 'я'*512):
            self.assertTrue(c.validate_analysis_input(json.dumps({**INPUT,'continuation':text},ensure_ascii=False)))
        for text in ('', 'я'*513, 1):
            self.assertFalse(c.validate_analysis_input(json.dumps({**INPUT,'continuation':text},ensure_ascii=False)))

    def test_actual_analysis_registry_is_exact_and_separate(self):
        self.assertEqual(c.ANALYSIS_TOOL_NAMES, tuple(name for name, _ in ANALYSIS_CASES))
        self.assertEqual([x["spec"] for x in c.ANALYSIS_EXTRA_TOOLS], list(c.ANALYSIS_TOOL_SPECS))
        self.assertTrue(set(c.ANALYSIS_TOOL_NAMES).isdisjoint(c.TOOL_NAMES))
        self.assertEqual(len(c.TOOL_NAMES), 25)
        for entry, (name, args) in zip(c.ANALYSIS_EXTRA_TOOLS, ANALYSIS_CASES):
            self.assertEqual(entry["spec"]["name"], name)
            self.assertIs(entry["validate"](copy.deepcopy(args)), True)
            self.assertIs(entry["validate"]({**args, "taskRef": "foreign"}), False)

    def test_analysis_packet_exact_shape_byte_cap_and_duplicate_keys(self):
        for kind in ("leaf", "merge"):
            self.assertTrue(c.validate_analysis_input(json.dumps({**INPUT, "kind": kind})))
        base = json.dumps({**INPUT, "objective": "я" * 2048}, ensure_ascii=False)
        exact = base + " " * (24576 - len(base.encode("utf-8")))
        self.assertTrue(c.validate_analysis_input(exact))
        self.assertFalse(c.validate_analysis_input(exact + " "))
        for delta in ({"objective": "я" * 2048 + "a"}, {"objective": " "}, {"objective": "\ud800"},
                      {"objective": "x\x00"}, {"kind": "other"}, {"materialAvailable": 1},
                      {"materialAvailable": False}, {"schema": "other"}, {"privatePath": "forbidden"}):
            self.assertFalse(c.validate_analysis_input(json.dumps({**INPUT, **delta})))
        duplicate = ANALYSIS_TEXT[:-1] + ',"kind":"leaf"}'
        for text in (duplicate, ANALYSIS_TEXT + "\x00", "null", "[]", "NaN", "{", None):
            self.assertFalse(c.validate_analysis_input(text))
        self.assertFalse(c.validate_analysis_input(TEXT))
        with self.assertRaises(ValueError):
            c.validate_request({"requestRef": "validation", "conversation": ANALYSIS_TEXT})

    def test_notes_only_accepts_exact_node_and_bounded_position(self):
        for position in (None, POSITION, "hnpos_0_0_" + "d" * 48, "hnpos_99999_999_" + "d" * 48):
            self.assertTrue(c.analysis_notes_arguments({"nodeRef": NODE, "position": position}))
        for position in ("hnpos_00_0_" + "d" * 48, "hnpos_100000_0_" + "d" * 48,
                         "hnpos_0_1000_" + "d" * 48, "hnpos_0_0_" + "D" * 48,
                         "hnpos_1١_1_" + "d" * 48, 0, True, {}, "raw"):
            self.assertFalse(c.analysis_notes_arguments({"nodeRef": NODE, "position": position}))
        for node in ("hnode_" + "A" * 48, "raw", SOURCE, None):
            self.assertFalse(c.analysis_notes_arguments({"nodeRef": node, "position": None}))

    def test_commit_bounds_utf8_support_uniqueness_and_claim_shape(self):
        exact = {"summary": "я" * 16384, "claims": [
            {"kind": "inference", "text": "я" * 512, "supports": [SUPPORT]}] * 128,
            "omittedDetailCount": 9007199254740991}
        self.assertTrue(c.analysis_commit_arguments({"output": exact}))
        self.assertTrue(c.analysis_commit_arguments({"output": {"summary": "x", "claims": []}}))
        for delta in ({"summary": "я" * 16384 + "a"}, {"summary": ""}, {"claims": exact["claims"] * 2},
                      {"omittedDetailCount": True}, {"omittedDetailCount": -1},
                      {"omittedDetailCount": 9007199254740992}, {"taskRef": "foreign"}):
            self.assertFalse(c.analysis_commit_arguments({"output": {**exact, **delta}}))
        claim = OUTPUT["claims"][0]
        for delta in ({"text": "я" * 512 + "a"}, {"text": "\ud800"}, {"kind": "fact"},
                      {"supports": []}, {"supports": [SUPPORT, SUPPORT]},
                      {"supports": [{**SUPPORT, "sourceRef": "raw"}]},
                      {"supports": [{**SUPPORT, "versionRef": "hver_" + "C" * 48}]},
                      {"supports": [{**SUPPORT, "hidden": True}]}, {"privateId": "forbidden"}):
            self.assertFalse(c.analysis_commit_arguments({"output": {**OUTPUT, "claims": [{**claim, **delta}]}}))

    def test_final_report_is_exclusive_and_utf8_bounded(self):
        exact = {'finalReport': {'body': 'я' * 16384}}
        self.assertTrue(c.analysis_commit_arguments(exact))
        for value in ({'finalReport': {'body': 'я' * 16384 + 'a'}},
                      {'finalReport': {'body': ' '}}, {'finalReport': {'body': '\ud800'}},
                      {'finalReport': {'body': 'x', 'head': 'foreign'}},
                      {**exact, 'output': OUTPUT}, {**exact, 'neutralOutput': {}},
                      {'finalReport': 'text'}):
            self.assertFalse(c.analysis_commit_arguments(value))
        packet = {**INPUT, 'kind': 'final-report'}
        self.assertTrue(c.validate_analysis_input(json.dumps(packet)))
        self.assertFalse(c.validate_analysis_input(json.dumps({**packet, 'periodChronicle': {
            'contextHash': 'a' * 64, 'neutralPeriodNotesAvailable': True, 'periodAdvisoryAvailable': False}})))
        self.assertLessEqual(len(c.ANALYSIS_INSTRUCTIONS.encode('utf-8')), 4096)
        self.assertIn('standalone participant-facing report', c.ANALYSIS_INSTRUCTIONS)
        self.assertIn('Use plain-text headings and bullets; no Markdown tables or markup.', c.ANALYSIS_INSTRUCTIONS)
        self.assertIn('Do not invent counts, unique people, trends or weekly dynamics', c.ANALYSIS_INSTRUCTIONS)

    def test_report_review_is_exclusive_candidate_bound_and_actionable(self):
        review={'candidateHash':'a'*64,'verdict':'accepted','findings':[]}
        self.assertTrue(c.analysis_commit_arguments({'reportReview':review}))
        self.assertTrue(c.validate_analysis_input(json.dumps({**INPUT,'kind':'final-report-review'})))
        finding={'dimension':'evidence','problem':'Unsupported count','correction':'Remove it and disclose the gap'}
        self.assertTrue(c.analysis_commit_arguments({'reportReview':{**review,'verdict':'revise','findings':[finding]}}))
        for value in ({**review,'candidateHash':'foreign'},{**review,'findings':[finding]},
                      {**review,'verdict':'revise'},{**review,'verdict':'revise','findings':[{**finding,'correction':' '}]}):
            self.assertFalse(c.analysis_commit_arguments({'reportReview':value}))
        self.assertFalse(c.analysis_commit_arguments({'reportReview':review,'finalReport':{'body':'bypass'}}))
        self.assertTrue(c.analysis_material_arguments({'purpose':'final-report-candidate','pageIndex':1,'position':None}))
        self.assertFalse(c.analysis_material_arguments({'purpose':'final-report-candidate','pageIndex':1,'position':'hpos_1_'+'a'*48}))

    def test_final_report_source_selector_is_exact_and_bounded(self):
        source = {'purpose': 'final-report-source', 'pageIndex': 1, 'position': None}
        self.assertTrue(c.analysis_material_arguments(source))
        self.assertTrue(c.analysis_material_arguments({**source, 'pageIndex': 1024, 'position': 'hpos_99_' + 'a' * 48}))
        for delta in ({'pageIndex': 0}, {'pageIndex': 1025}, {'pageIndex': True},
                      {'position': 'hpos_1000_' + 'a' * 48}, {'position': 'hpos_00_' + 'a' * 48}, {'position': False},
                      {'purpose': 'neutral-period-notes'}, {'taskRef': 'foreign'}):
            self.assertFalse(c.analysis_material_arguments({**source, **delta}))
        self.assertFalse(c.analysis_material_arguments({'purpose': 'final-report-source'}))
        self.assertFalse(c.analysis_material_arguments({'pageIndex': 1, 'position': None}))

    def test_actual_analysis_actor_accepts_producer_registry_without_rpc(self):
        # Exercise the exact constructor seam used by the parallel adapter.
        # No app-server process, custody, provider or Telegram is involved.
        def module(name):
            spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
            value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
            return value
        native = module('rm-0032-native-conversation')
        epoch = module('rm-0032-native-image-epoch')
        collector = module('rm-0032-native-image-collector')
        class NoRpc:
            def exchange(*args): raise AssertionError('constructor must not perform RPC')
            def next_frame(*args): raise AssertionError('constructor must not perform RPC')
            def respond(*args): raise AssertionError('constructor must not perform RPC')
        def forbidden(*args): raise AssertionError('constructor must not dispatch tools')
        kwargs = dict(profile='decadans-final-report-fixture', cwd='/run/decadans-final-report-fixture/workspace',
                      rpc=NoRpc(), tool_spec=c.TOOL_SPEC, tool=forbidden, clock=lambda: 1.0,
                      instructions=c.ANALYSIS_INSTRUCTIONS, extra_tools=c.ANALYSIS_EXTRA_TOOLS,
                      enable_web=False, thread_config={'web_search': 'disabled', 'features.image_generation': False})
        actor = epoch.create_native_image_epoch(native, collector,
                    (ROOT / 'rm-0032-astra-canary-client.py').read_text(encoding='utf-8'), **kwargs)
        self.assertEqual(actor.tool_names(), c.ANALYSIS_TOOL_NAMES)
        self.assertFalse(actor.state()['threadStarted'])
        self.assertEqual(actor.state()['turnsAttempted'], 0)
        specs, validators = native.extra_registry(c.ANALYSIS_EXTRA_TOOLS, c.TOOL_SPEC)
        self.assertEqual(specs[1:], list(c.ANALYSIS_TOOL_SPECS))
        self.assertFalse(validators['neurobro_analysis_commit']({'output': OUTPUT, 'finalReport': {'body': 'mixed'}}))
        self.assertTrue(validators['neurobro_analysis_commit']({'finalReport': {'body': 'report'}}))
        old = [dict(entry) for entry in c.ANALYSIS_EXTRA_TOOLS]
        old[0]['spec'] = {**old[0]['spec'], 'inputSchema': {'type': 'object', 'oneOf': []}}
        with self.assertRaises(native.Refused) as failure:
            native.extra_registry(old, c.TOOL_SPEC)
        self.assertEqual(failure.exception.code, 'CONFIG_REFUSED')
        self.assertEqual(failure.exception.site, 'spec')

    def test_candidate_source_loading_requires_exact_locally_bound_snapshot(self):
        bundle = sources()
        pins = {key: hashlib.sha256(value.encode("utf-8")).hexdigest().upper() for key, value in bundle.items()}
        original = dict(c.PINS)
        with patch.dict(c.PINS, pins, clear=True):
            modules = c.load_sources(bundle, CONFIG)
            self.assertTrue(callable(modules["session"].run_scoped_session))
            self.assertTrue(callable(modules["managedRpc"].ScopedManagedDeadlineRpc))
            with self.assertRaises(c.Stop):
                c.load_sources({**bundle, "session": bundle["session"] + "\n# altered"}, CONFIG)
        self.assertEqual(c.PINS, original)


class ScopedFakeProcess:
    """Anonymous pipes and one scripted peer thread; no Popen or actual process."""
    def __init__(self,test,base,mode):
        self.test,self.base,self.mode=test,base,mode;self.pid=4242
        self.commands=self.turns=self.threads=self.request_count=0
        self.done=False;self.errors=[];self.responses=[];self.waits=[]
        self.pending=[];self.items=[];self.active_request=None
        ir,iw=os.pipe();rr,rw=os.pipe();er,ew=os.pipe()
        self.stdin,self.stdout,self.stderr=io.FileIO(iw,'wb'),io.FileIO(rr,'rb'),io.FileIO(er,'rb')
        self.server_in,self.server_out,self.server_err=io.FileIO(ir,'rb'),io.FileIO(rw,'wb'),io.FileIO(ew,'wb')
        self.thread=threading.Thread(target=self.serve);self.thread.start()
    def send(self,value):
        data=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()+b'\n'
        while data:data=data[os.write(self.server_out.fileno(),data):]
    def wait(self,timeout):
        self.waits.append(timeout);self.thread.join(timeout)
        if self.thread.is_alive():raise subprocess.TimeoutExpired('fake',timeout)
        return 0
    def poll(self):return 0 if self.done else None
    def serve(self):
        self.requests = []
        self.scope_threads = []
        self.current_thread = None
        try:
            while True:
                line = self.server_in.readline(4 * 1024 * 1024)
                if not line:
                    break
                frame = json.loads(line)
                if "method" not in frame:
                    identifier, params = self.active_request
                    self.test.assertEqual(frame["id"], identifier)
                    self.test.assertIs(type(frame["id"]), int)
                    self.test.assertEqual(frame["result"], tool_result(params["tool"], params["arguments"]))
                    self.responses.append(frame["id"])
                    item = {"id": params["callId"], "type": "dynamicToolCall", "tool": params["tool"],
                            "namespace": None, "arguments": params["arguments"], "status": "completed", **frame["result"]}
                    self.items.append(item)
                    self.send({"method": "item/completed", "params": {"threadId": self.current_thread,
                        "turnId": params["turnId"], "completedAtMs": 2, "item": item}})
                    self.active_request = None
                    self.next_tool()
                    continue
                method, params = frame["method"], frame.get("params", {})
                self.requests.append(copy.deepcopy(frame))
                if method == "initialized":
                    continue
                if method == "initialize":
                    result = {"platformOs": "linux", "platformFamily": "unix", "codexHome": self.base.AUTH_HOME,
                              "userAgent": self.base.CLIENT + "/0.153.4 (fixture)"}
                elif method == "permissionProfile/list":
                    result = {"data": [{"id": CONFIG["profile"], "allowed": True}], "nextCursor": None}
                elif method == "command/exec":
                    name = self.base.base_result()["probes"][self.commands]["name"]
                    self.commands += 1
                    result = {"exitCode": sorted(self.base.pass_codes(name))[0], "stdout": "", "stderr": ""}
                elif method == "account/read":
                    result = {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": False}
                elif method == "model/list":
                    result = {"data": [{"model": "gpt-6-astra", "hidden": False,
                              "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]}], "nextCursor": None}
                elif method == "modelProvider/capabilities/read":
                    self.test.assertEqual(self.commands, 9)
                    result = {"imageGeneration": True, "namespaceTools": False, "webSearch": True}
                elif method == "thread/start":
                    self.threads += 1
                    analysis = self.threads == 2
                    self.test.assertLessEqual(self.threads, 2)
                    self.current_thread = "analysis-thread" if analysis else "conversation-thread"
                    self.scope_threads.append(self.current_thread)
                    expected = list(c.ANALYSIS_TOOL_SPECS) if analysis else [c.TOOL_SPEC, *[x["spec"] for x in c.EXTRA_TOOLS]]
                    self.test.assertEqual(params["dynamicTools"], expected)
                    instructions = c.ANALYSIS_INSTRUCTIONS if analysis else c.INSTRUCTIONS
                    self.test.assertEqual(params["baseInstructions"], instructions)
                    self.test.assertEqual(params["developerInstructions"], instructions)
                    if analysis:
                        self.test.assertEqual(params["config"]["web_search"], "disabled")
                        self.test.assertIs(params["config"]["features.image_generation"], False)
                    result = {"thread": {"id": self.current_thread, "ephemeral": True}, "model": "gpt-6-astra",
                              "modelProvider": "openai", "reasoningEffort": "medium", "cwd": CONFIG["cwd"],
                              "approvalPolicy": "never", "approvalsReviewer": "user",
                              "activePermissionProfile": {"id": CONFIG["profile"]}}
                elif method == "turn/start":
                    self.turns += 1
                    self.current_thread = "analysis-thread" if self.turns == 2 else "conversation-thread"
                    self.test.assertEqual(params["threadId"], self.current_thread)
                    self.test.assertEqual(params["input"][0]["text"], ANALYSIS_TEXT if self.turns == 2 else TEXT)
                    if self.turns == 2:
                        self.send({"method": "thread/status/changed", "params": {
                            "threadId": "conversation-thread", "status": {"type": "idle"}}})
                    self.send({"id": frame["id"], "result": {"turn": {"id": "turn-" + str(self.turns),
                              "status": "inProgress", "items": []}}})
                    self.items = []
                    self.pending = copy.deepcopy(ANALYSIS_CASES if self.turns == 2 else TOOL_CASES[:1] if self.turns == 1 else [])
                    self.next_tool()
                    continue
                else:
                    raise AssertionError("Unexpected synthetic native method")
                self.send({"id": frame["id"], "result": result})
        except (OSError, BrokenPipeError):
            pass
        except BaseException as error:
            self.errors.append(type(error).__name__)
        finally:
            self.server_in.close()
            self.server_out.close()
            self.server_err.close()
            self.done = True

    def next_tool(self):
        if not self.pending:
            answer = {"id": "answer-" + str(self.turns), "type": "agentMessage", "phase": "final_answer", "text": "Synthetic scoped answer"}
            self.send({"method": "turn/completed", "params": {"threadId": self.current_thread,
                "turn": {"id": "turn-" + str(self.turns), "status": "completed", "items": [*self.items, answer]}}})
            return
        name, args = self.pending.pop(0)
        self.request_count += 1
        params = {"threadId": self.current_thread, "turnId": "turn-" + str(self.turns),
                  "callId": "call-" + str(self.request_count), "tool": name, "arguments": args}
        identifier = 2**63 - self.request_count
        self.active_request = (identifier, params)
        self.send({"id": identifier, "method": "item/tool/call", "params": params})


@unittest.skipUnless(sys.platform == "linux", "Actual producer consumes Linux anonymous pipes; no real Popen")
class ConnectedTests(unittest.TestCase):
    def fixture(self, expire_before_turn_dispatch=False):
        bundle = sources()
        pins = {key: hashlib.sha256(value.encode("utf-8")).hexdigest().upper() for key, value in bundle.items()}
        made, frames, receivers = [], [], set()
        clock_shift = [0.0]
        cut_points = []
        inbox = queue.Queue()
        def preflight(base, value):
            for key in value["controls"]:
                value["controls"][key] = key != "relayAfter"
        def receive(seconds):
            receivers.add(threading.get_ident())
            try:
                return inbox.get(timeout=min(seconds, .02))
            except queue.Empty:
                return c.IDLE
        def turn(number):
            return {"kind": "turn", "purpose": "history-analysis" if number == 2 else "conversation",
                    "requestRef": "request-" + str(number), "input": ANALYSIS_TEXT if number == 2 else TEXT}
        def emit(frame, seconds):
            frames.append(copy.deepcopy(frame))
            if frame["kind"] == "ready":
                self.assertEqual(made[0].threads, 0)
                inbox.put(turn(1))
            elif frame["kind"] == "tool":
                inbox.put({"kind": "toolResult", "purpose": frame["purpose"], "requestRef": frame["requestRef"],
                    "callRef": frame["callRef"], "result": tool_result(frame["name"], frame["arguments"])})
            elif frame["kind"] == "completed":
                scope = frame["scope"]
                inbox.put({"kind": "release", "purpose": scope["purpose"], "requestRef": scope["requestRef"],
                           "delivery": "not-sent" if scope["purpose"] == "history-analysis" else "verified"})
            elif frame["kind"] == "released":
                number = int(frame["requestRef"].split("-")[-1])
                inbox.put(turn(number + 1) if number < 3 else {"kind": "close"})
            return True
        with patch.dict(c.PINS, pins, clear=True):
            modules = c.load_sources(bundle, CONFIG)
            original_remaining = modules["native"].NativeConversation._remaining
            def cut_remaining(actor, deadline):
                if expire_before_turn_dispatch and not cut_points and actor.state()["turnsAttempted"] == 1:
                    # The real actor has acknowledged its thread and consumed
                    # the attempt. Expire the existing per-turn deadline before
                    # the shared RPC dispatch method can reserve a turn/start.
                    # ImageEpoch overrides _exchange for turn/start, but calls
                    # this shared deadline check before its actual RPC exchange.
                    point=(actor.state()["turnsAttempted"],actor.state()["threadStarted"],made[0].turns)
                    cut_points.append(point)
                    self.assertEqual(point,(1,True,0))
                    clock_shift[0] += 301
                return original_remaining(actor, deadline)
            def popen(argv, **kwargs):
                self.assertEqual(argv, c.image_launch_argv(modules["canary"], modules["custody"]))
                self.assertEqual(kwargs["env"], modules["custody"].app_server_env())
                self.assertTrue(kwargs["close_fds"])
                self.assertEqual(kwargs["bufsize"], 0)
                proc = ScopedFakeProcess(self, modules["custody"], "scoped")
                made.append(proc)
                return proc
            try:
                # The timer only injects host STOP if this synthetic script fails.
                timer = threading.Timer(12, lambda: inbox.put({"kind": "close"}))
                timer.start()
                # Modules were checked against this exact bundle immediately
                # above. Only the synthetic cutpoint alters the loaded method.
                with patch.object(c, "load_sources", return_value=modules), patch.object(
                        modules["native"].NativeConversation, "_remaining", cut_remaining):
                    value = c.main(bundle, CONFIG, receive, emit,
                        {"clock": lambda: time.monotonic() + clock_shift[0], "popen": popen,
                         "preflight": preflight, "relay_reachable": lambda: True}, session_mode=c.SCOPED_MODE)
            finally:
                timer.cancel()
                timer.join(1)
                for proc in made:
                    if not proc.stdin.closed:
                        proc.stdin.close()
                    proc.thread.join(2)
                    self.assertFalse(proc.thread.is_alive())
                    self.assertEqual(proc.errors, [])
                    for stream in (proc.stdin, proc.stdout, proc.stderr):
                        if not stream.closed:
                            stream.close()
        self.assertEqual(cut_points,[(1,True,0)] if expire_before_turn_dispatch else [])
        return value, made[0], frames, receivers

    def test_actual_pre_dispatch_expiry_retains_ack_and_attempt_without_rpc_dispatch(self):
        value, proc, frames, receivers = self.fixture(expire_before_turn_dispatch=True)
        self.assertEqual(value["schema"], c.SCOPED_SCHEMA)
        self.assertEqual(value["outcome"], "unknown")
        self.assertEqual(value["code"], "SESSION_UNKNOWN")
        self.assertEqual(value["session"]["code"], "NATIVE_UNKNOWN")
        self.assertEqual((proc.commands, proc.threads, proc.turns), (9, 1, 0))
        self.assertEqual(value["native"]["threadStartDispatches"], 1)
        self.assertEqual(value["native"]["threadsAcknowledged"], 1)
        self.assertEqual(value["native"]["turnStartDispatches"], 0)
        self.assertEqual(value["session"]["facts"]["turnsAttempted"], 1)
        self.assertEqual(value["session"]["facts"]["slots"][0]["turnsAttempted"], 1)
        self.assertEqual(value["native"]["slotWeb"][0]["turnsAttempted"], 1)
        self.assertEqual(c.normalize_result(value), value)
        self.assertTrue(value["appServer"]["stdoutEof"])
        self.assertTrue(value["appServer"]["reaped"])
        self.assertFalse(any(x["kind"] in ("tool", "completed") for x in frames))
        self.assertEqual(frames[-1], {"kind": "epochResult", "receipt": value})

    def test_actual_producer_custody_two_scopes_callbacks_and_final_cleanup_receipt(self):
        value, proc, frames, receivers = self.fixture()
        self.assertEqual(value["schema"], c.SCOPED_SCHEMA)
        self.assertEqual(value["outcome"], "observed")
        self.assertEqual(value["code"], "OK")
        self.assertTrue(value["injectedPorts"])
        self.assertEqual((proc.commands, proc.threads, proc.turns), (9, 2, 3))
        self.assertEqual(len(proc.responses), 4)
        self.assertEqual([x["kind"] for x in frames][:2], ["custodyReady", "ready"])
        self.assertEqual([x["kind"] for x in frames][-2:], ["closed", "epochResult"])
        final = frames[-1]
        self.assertEqual(final, {"kind": "epochResult", "receipt": value})
        scopes = [x["scope"] for x in frames if x["kind"] == "completed"]
        self.assertEqual([x["threadId"] for x in scopes], ["conversation-thread", "analysis-thread", "conversation-thread"])
        self.assertEqual([x["turnNumber"] for x in scopes], [1, 2, 3])
        self.assertEqual([x["threadTurnNumber"] for x in scopes], [1, 1, 2])
        tools = [x for x in frames if x["kind"] == "tool"]
        self.assertEqual([(x["name"], x["arguments"]) for x in tools], TOOL_CASES[:1] + ANALYSIS_CASES)
        self.assertEqual([x["purpose"] for x in tools], ["conversation"] + ["history-analysis"] * 3)
        self.assertEqual(value["native"]["threadStartDispatches"], 2)
        self.assertEqual(value["native"]["turnStartDispatches"], 3)
        self.assertEqual(value["native"]["threadsAcknowledged"], 2)
        self.assertEqual([x["turnsAttempted"] for x in value["native"]["slotWeb"]], [2, 1])
        self.assertFalse(value["session"]["facts"]["resourceSettlementObserved"])
        self.assertIsNone(value["diagnostics"]["idleFailure"])
        self.assertFalse(value["diagnostics"]["cleanupUnknown"])
        self.assertTrue(all(value["appServer"][key] for key in ("stdinClosed", "stdoutEof", "reaped", "stderrComplete")))
        self.assertEqual(value["appServer"]["exitCode"], 0)
        self.assertEqual(len(receivers), 1)
        serialized = json.dumps(value)
        for hidden in ("conversation-thread", "analysis-thread", "Synthetic scoped answer", NODE, SOURCE, VERSION):
            self.assertNotIn(hidden, serialized)


if __name__ == "__main__":
    unittest.main()
