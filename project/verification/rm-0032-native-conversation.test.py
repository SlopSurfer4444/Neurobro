"""Connected fake-RPC tests: no process, model, auth or Telegram access."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("native", ROOT / "rm-0032-native-conversation.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SOURCE = (ROOT / "rm-0032-astra-canary-client.py").read_bytes().decode()
PROFILE, CWD = "decadans-native-test", "/run/decadans-native-test/workspace"
ARGS = {"fromDate": 1, "toDate": 200, "cursor": None}
SPEC = {"type": "function", "name": m.NAME, "description": "Read only current group history", "inputSchema": {
    "type": "object", "additionalProperties": False,
    "properties": {"fromDate": {"type": "integer", "minimum": 1, "maximum": 2147483646},
                   "toDate": {"type": "integer", "minimum": 1, "maximum": 2147483646},
                   "cursor": {"type": ["string", "null"]}}, "required": ["fromDate", "toDate", "cursor"]}}
RESULT = {"success": True, "contentItems": [{"type": "inputText", "text": '{"messages":[],"hasMore":false}'}]}


def message(turn, text="Ответ 🤝"):
    return {"id": "answer-" + turn, "type": "agentMessage", "phase": "final_answer", "text": text}


def completed(turn, text="Ответ 🤝", items=None):
    return {"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
        "id": turn, "items": [message(turn, text)] if items is None else items, "status": "completed"}}}


def request(turn, rpc_id=17, call_id="call-1"):
    return {"id": rpc_id, "method": "item/tool/call", "params": {"threadId": "thread-1", "turnId": turn,
        "callId": call_id, "tool": m.NAME, "arguments": copy.deepcopy(ARGS), "namespace": None}}


class Rpc:
    def __init__(self, plan=None):
        self.calls, self.responses, self.frames = [], [], []
        self.plan = plan or (lambda turn: [completed(turn)])
        self.turn, self.on_respond, self.auto_terminal = 0, None, True
        self.requests = {}

    def exchange(self, method, params, timeout):
        assert 0 < timeout <= 20
        self.calls.append((method, copy.deepcopy(params)))
        if method == "thread/start":
            return {"thread": {"id": "thread-1", "ephemeral": True}, "model": "gpt-6-astra", "modelProvider": "openai",
                    "reasoningEffort": "medium", "cwd": CWD, "approvalPolicy": "never", "approvalsReviewer": "user",
                    "activePermissionProfile": {"id": PROFILE}}, None
        assert method == "turn/start"
        self.turn += 1
        turn = "turn-" + str(self.turn)
        self.frames.extend(self.plan(turn))
        return {"turn": {"id": turn, "items": [], "status": "inProgress"}}, None

    def next_frame(self, timeout):
        assert timeout > 0
        if not self.frames: raise EOFError("PRIVATE frame error")
        frame = self.frames.pop(0)
        if frame.get("method") == "item/tool/call": self.requests[(type(frame["id"]), frame["id"])] = frame["params"]
        return frame

    def respond(self, request_id, result, timeout):
        self.responses.append((request_id, copy.deepcopy(result)))
        if self.on_respond: self.on_respond(request_id, result)
        elif self.auto_terminal:
            p = self.requests[(type(request_id), request_id)]
            item = {"id": p["callId"], "type": "dynamicToolCall", "tool": p["tool"], "namespace": p.get("namespace"),
                    "arguments": copy.deepcopy(p["arguments"]), "status": "completed", **copy.deepcopy(result)}
            self.frames.insert(0, {"method": "item/completed", "params": {"threadId": p["threadId"], "turnId": p["turnId"], "completedAtMs": 5, "item": item}})


def engine(rpc=None, tool=None, **kwargs):
    return m.NativeConversation(SOURCE, profile=PROFILE, cwd=CWD, tool_spec=copy.deepcopy(SPEC),
                                instructions="Neurobro answers in Russian; use only declared history tool.",
                                rpc=rpc or Rpc(), tool=tool or (lambda params, timeout: copy.deepcopy(RESULT)), **kwargs)


def extra(name="neurobro_archive", validate=None):
    return {"spec":{"type":"function","name":name,"description":"Synthetic bounded tool",
            "inputSchema":{"type":"object","additionalProperties":False,"properties":{"value":{"type":"integer"}},"required":["value"]}},
            "validate":validate or (lambda x:type(x) is dict and set(x)=={"value"} and type(x["value"]) is int and 0<=x["value"]<=10)}


def named_request(turn, name="neurobro_archive", args=None, rpc_id=2**63-1, call_id="named-call"):
    value=request(turn,rpc_id,call_id)
    value["params"].update(tool=name,arguments={"value":1} if args is None else args)
    return value


def web_item(identifier="web-1", action=None, query=""):
    return {"id": identifier, "type": "webSearch", "query": query, "action": action, "results": None}


def web_event(turn, item, done=True):
    return {"method": "item/completed" if done else "item/started", "params": {
        "threadId": "thread-1", "turnId": turn, "completedAtMs" if done else "startedAtMs": 2, "item": copy.deepcopy(item)}}


def analysis_payload_fixture():
    # Import-only producer contract: no process, auth, model or network action.
    producer_spec = importlib.util.spec_from_file_location("analysis_producer", ROOT / "rm-0032-standing-epoch-client.py")
    producer = importlib.util.module_from_spec(producer_spec); producer_spec.loader.exec_module(producer)
    supports = [{"sourceRef": "hsrc_"+format(i, "048x"), "versionRef": "hver_"+format(i+16, "048x")} for i in range(16)]
    output = {"summary": "\x01"*4095+'"', "claims": [
        {"kind": "reported", "text": "\x01"*1023+'"', "supports": copy.deepcopy(supports)} for _ in range(16)]}
    args = {"output": output}
    assert producer.analysis_commit_arguments(copy.deepcopy(args)) is True
    entries = [extra("neurobro_analysis_material"), extra("neurobro_analysis_notes"),
               extra("neurobro_analysis_commit", producer.analysis_commit_arguments)]
    return args, entries, {"web_search": "disabled", "features.image_generation": False}


class NativeTests(unittest.TestCase):
    def test_default_thread_config_preserves_exact_reviewed_request(self):
        for kwargs in ({}, {"thread_config": None}, {"enable_web": True}):
            with self.subTest(kwargs=kwargs):
                rpc = Rpc(); e = engine(rpc, **kwargs)
                expected = copy.deepcopy(e._reviewed.thread_params())
                expected["dynamicTools"] = [copy.deepcopy(SPEC)]
                self.assertEqual(e.run("Synthetic default turn")["metadata"]["code"], "OK")
                self.assertEqual(rpc.calls[0], ("thread/start", expected))

    def test_analysis_thread_config_overrides_only_pinned_keys_and_copies_input(self):
        config = {"web_search": "disabled", "features.image_generation": False}
        names = ("neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit")
        entries = [extra(name) for name in names]
        rpc = Rpc(); e = engine(rpc, thread_config=config, extra_tools=entries)
        baseline = copy.deepcopy(e._reviewed.thread_params())
        expected = copy.deepcopy(baseline)
        expected["config"].update(config)
        expected["dynamicTools"] = [copy.deepcopy(entry["spec"]) for entry in entries]
        config.update(web_search="live", approval_policy="on-request")
        config["features.image_generation"] = True
        self.assertEqual(e.run("Synthetic isolated turn")["metadata"]["code"], "OK")
        self.assertEqual(rpc.calls[0], ("thread/start", expected))
        self.assertEqual(e.tool_names(), names)
        self.assertEqual(e._reviewed.thread_params(), baseline)
        self.assertEqual(e.run("Synthetic subsequent turn")["metadata"]["code"], "OK")
        self.assertEqual([call[0] for call in rpc.calls], ["thread/start", "turn/start", "turn/start"])

    def test_analysis_thread_config_refuses_hostile_values_before_rpc(self):
        class DictSubclass(dict): pass
        class StringSubclass(str): pass
        valid = {"web_search": "disabled", "features.image_generation": False}
        invalid = [False, True, 0, "analysis", [], {}, DictSubclass(valid),
                   {"web_search": "disabled"}, {"features.image_generation": False},
                   {**valid, "approval_policy": "never"}, {**valid, "permissions": {}},
                   {**valid, "web_search": "live"}, {**valid, "web_search": StringSubclass("disabled")},
                   {**valid, "features.image_generation": 0}, {**valid, "features.image_generation": True},
                   {**valid, "features.image_generation": None},
                   {StringSubclass("web_search"): "disabled", "features.image_generation": False}]
        for value in invalid:
            with self.subTest(value=value):
                rpc = Rpc()
                with self.assertRaises(m.Refused) as caught: engine(rpc, thread_config=value)
                self.assertEqual(caught.exception.code, "CONFIG_REFUSED")
                self.assertEqual(rpc.calls, [])
        rpc = Rpc()
        with self.assertRaises(m.Refused) as caught: engine(rpc, thread_config=valid, enable_web=True)
        self.assertEqual(caught.exception.code, "CONFIG_REFUSED")
        self.assertEqual(rpc.calls, [])

    def test_analysis_registry_requires_exact_three_tools_before_rpc(self):
        names = ("neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit")
        variants = [(), names[:2], tuple(reversed(names)), (*names, "neurobro_archive"), (m.NAME, *names)]
        for selected in variants:
            with self.subTest(names=selected):
                rpc = Rpc()
                with self.assertRaises(m.Refused) as caught:
                    engine(rpc, thread_config={"web_search": "disabled", "features.image_generation": False},
                           extra_tools=[extra(name) for name in selected])
                self.assertEqual(caught.exception.code, "CONFIG_REFUSED")
                self.assertEqual(rpc.calls, [])

    def test_analysis_only_tools_execute_and_raw_history_refused_before_callback(self):
        names = ("neurobro_analysis_material", "neurobro_analysis_notes", "neurobro_analysis_commit")
        kwargs = {"thread_config": {"web_search": "disabled", "features.image_generation": False},
                  "extra_tools": [extra(name) for name in names]}
        calls = []
        rpc = Rpc(lambda t: [named_request(t, name, rpc_id=i, call_id="analysis-"+str(i))
                             for i, name in enumerate(names)] + [completed(t)])
        result = engine(rpc, lambda p,t: calls.append(p) or copy.deepcopy(RESULT), **kwargs).run("Analyze")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual([call["tool"] for call in calls], list(names))
        calls = []; rpc = Rpc(lambda t: [request(t), completed(t)])
        result = engine(rpc, lambda p,t: calls.append(p) or copy.deepcopy(RESULT), **kwargs).run("History refused")
        self.assertEqual(result["metadata"]["code"], "TOOL_REFUSED")
        self.assertTrue(result["metadata"]["sessionPoisoned"])
        self.assertEqual(calls, [])
        self.assertEqual(rpc.responses, [])

    def test_web_enabled_search_open_find_and_history_share_real_observer_without_web_callbacks(self):
        items = [web_item("search", {"type": "search", "query": "PRIVATE query", "queries": ["PRIVATE query"]}, "PRIVATE query"),
                 web_item("open", {"type": "openPage", "url": "https://example.invalid/page"}),
                 web_item("find", {"type": "findInPage", "url": "https://example.invalid/page", "pattern": "PRIVATE needle"})]
        items[0]["results"] = [{"opaque": {"PRIVATE": [1, True, None]}}]
        def plan(turn):
            frames = []
            for item in items:
                frames.extend([web_event(turn, web_item(item["id"]), False), web_event(turn, item)])
            return frames + [request(turn), completed(turn, items=copy.deepcopy(items) + [message(turn)])]
        calls = []; rpc = Rpc(plan); e = engine(rpc, lambda p,t: calls.append(p) or copy.deepcopy(RESULT), enable_web=True)
        result = e.run("Synthetic search")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(e.web_metadata(), {"admitted": 3, "completed": 3, "search": 1, "openPage": 1, "findInPage": 1, "other": 0})
        self.assertEqual([p["tool"] for p in calls], [m.NAME]); self.assertEqual(len(rpc.responses), 1)
        self.assertNotIn("PRIVATE", json.dumps(result)); self.assertEqual(rpc.calls[0][1]["dynamicTools"], [SPEC])
        self.assertNotIn("PRIVATE", repr(e.web_metadata()))
        detached = e.web_metadata(); detached["completed"] = 100
        self.assertEqual(e.web_metadata()["completed"], 3)

    def test_web_snapshot_only_missing_nullable_action_other_and_counters_reset(self):
        variants = [{"id": "web", "type": "webSearch", "query": ""}, web_item("web"),
                    web_item("web", {"type": "search", "queries": None, "query": None}),
                    web_item("web", {"type": "openPage", "url": None}),
                    web_item("web", {"type": "findInPage", "url": None, "pattern": None}),
                    web_item("web", {"type": "other"})]
        for item in variants:
            e = engine(Rpc(lambda t: [completed(t, items=[item, message(t)])]), enable_web=True)
            self.assertEqual(e.run("x")["metadata"]["code"], "OK")
            self.assertEqual(e.web_metadata()["admitted"], 1); self.assertEqual(e.web_metadata()["completed"], 1)
        e = engine(Rpc(lambda t: [completed(t, items=([web_item()] if t == "turn-1" else []) + [message(t)])]), enable_web=True)
        self.assertEqual(e.run("one")["metadata"]["code"], "OK")
        self.assertEqual(e.run("two")["metadata"]["code"], "OK"); self.assertEqual(e.web_metadata(), m.web_counts())

    def test_web_default_disabled_config_exact_bool_and_no_dynamic_dispatch(self):
        legacy = engine(Rpc(lambda t: [web_event(t, web_item()), completed(t)]))
        result = legacy.run("x")
        self.assertEqual(result["metadata"]["code"], "TOOL_EVENT_REFUSED")
        self.assertEqual(set(result["metadata"]), set(m.metadata())); self.assertEqual(legacy.web_metadata(), m.web_counts())
        for value in (None, 0, 1, "true", {}):
            with self.assertRaises(m.Refused): engine(enable_web=value)
        calls = []; e = engine(Rpc(lambda t: [named_request(t, "webSearch"), completed(t)]),
                             lambda p,t: calls.append(p) or RESULT, enable_web=True)
        self.assertEqual(e.run("x")["metadata"]["code"], "TOOL_REFUSED"); self.assertEqual(calls, [])

    def test_web_malformed_actions_queries_results_and_unknown_fields_refuse_privately(self):
        variants = [dict(web_item(), query=None), dict(web_item(), query="bad\ud800"), dict(web_item(), results={}),
                    dict(web_item(), extra="PRIVATE"), web_item(action={"type": "unknown"}),
                    web_item(action={"type": "search", "query": 1}), web_item(action={"type": "search", "queries": [None]}),
                    web_item(action={"type": "openPage", "url": True}), web_item(action={"type": "findInPage", "pattern": []}),
                    web_item(action={"type": "other", "url": "PRIVATE"}), web_item(action=[])]
        for item in variants:
            result = engine(Rpc(lambda t: [web_event(t, item), completed(t)]), enable_web=True).run("x")
            self.assertIsNone(result["answer"]); self.assertTrue(result["metadata"]["sessionPoisoned"])
            self.assertNotIn("PRIVATE", json.dumps(result["metadata"]))

    def test_web_exact_repeats_and_only_completion_enrichment(self):
        first = web_item(action={"type": "search", "query": None}, query="fixed")
        last = web_item(action={"type": "search", "query": "fixed", "queries": ["fixed"]}, query="fixed")
        rpc = Rpc(lambda t: [web_event(t, first, False), web_event(t, first, False), web_event(t, last),
                             web_event(t, last), completed(t, items=[last, message(t)])])
        e = engine(rpc, enable_web=True); self.assertEqual(e.run("x")["metadata"]["code"], "OK")
        self.assertEqual(e.web_metadata()["completed"], 1)
        # Immutable terminal values, known start fields, no backwards lifecycle,
        # and no reuse of a web ID for an agent message.
        changes = [(first, dict(last, query="changed"), False, True),
                   (first, web_item(action={"type": "openPage"}, query="fixed"), False, True),
                   (first, last, False, False), (last, first, True, True), (last, last, True, False),
                   (dict(last, results=["a"]), dict(last, results=["b"]), True, True),
                   (last, {**message("turn-1"), "id": "web-1"}, True, True)]
        for a,b,done_a,done_b in changes:
            result = engine(Rpc(lambda t: [web_event(t,a,done_a), web_event(t,b,done_b), completed(t)]), enable_web=True).run("x")
            self.assertEqual(result["metadata"]["failureSite"], "web_changed"); self.assertIsNone(result["answer"])

    def test_web_unfinished_missing_completion_and_foreign_turn_poison(self):
        e = engine(Rpc(lambda t: [web_event(t,web_item(),False), completed(t)]), enable_web=True)
        self.assertEqual(e.run("x")["metadata"]["failureSite"], "web_unfinished")
        self.assertEqual(e.web_metadata()["completed"], 0)
        for key,value in (("threadId","foreign"),("turnId","old-turn")):
            def plan(t):
                event=web_event(t,web_item()); event["params"][key]=value
                return [event, completed(t)]
            e=engine(Rpc(plan),enable_web=True);self.assertIsNone(e.run("x")["answer"])
            self.assertEqual(e.web_metadata()["admitted"],0)
        e=engine(Rpc(lambda t:[completed(t)] if t=="turn-1" else [web_event("turn-1",web_item()),completed(t)]),enable_web=True)
        self.assertEqual(e.run("one")["metadata"]["code"],"OK")
        self.assertIsNone(e.run("two")["answer"]);self.assertTrue(e.state()["poisoned"])

    def test_web_field_item_and_ordinary_event_budgets_are_not_exempt(self):
        for item in (web_item(query="x"*4097), web_item(action={"type":"search","queries":[""]*33}),
                     dict(web_item(),results=["x"*65536])):
            e=engine(Rpc(lambda t:[web_event(t,item),completed(t)]),enable_web=True)
            self.assertEqual(e.run("x")["metadata"]["code"],"BOUNDS_REFUSED")
        item=dict(web_item(),results=["x"*60000])
        e=engine(Rpc(lambda t:[web_event(t,item)]*5+[completed(t)]),enable_web=True)
        result=e.run("x");self.assertEqual(result["metadata"]["code"],"BOUNDS_REFUSED")
        self.assertEqual(result["metadata"]["eventBytes"],m.EVENT_BYTES_CAP+1)

    def test_named_registry_copied_advertised_and_exact_int64_archive_schedule_calls(self):
        entries=[extra(),extra("neurobro_schedule_text")]; original=[copy.deepcopy(x["spec"]) for x in entries]
        calls=[]
        rpc=Rpc(lambda t:[request(t,7,"history"),named_request(t),named_request(t,"neurobro_schedule_text",rpc_id="9223372036854775807",call_id="schedule"),completed(t)])
        e=engine(rpc,lambda p,t:calls.append(copy.deepcopy(p)) or copy.deepcopy(RESULT),extra_tools=entries)
        entries[0]["spec"]["name"]="neurobro_changed";entries[1]["validate"]=lambda x:False
        result=e.run("Use registered tools")
        self.assertEqual(result["metadata"]["code"],"OK")
        self.assertEqual(e.tool_names(),(m.NAME,"neurobro_archive","neurobro_schedule_text"))
        self.assertEqual(rpc.calls[0][1]["dynamicTools"],[SPEC,*original])
        self.assertEqual([p["tool"] for p in calls],list(e.tool_names()))
        self.assertEqual([p["requestId"] for p in calls],[7,2**63-1,"9223372036854775807"])
        self.assertEqual([type(p["requestId"]) for p in calls],[int,int,str])
        self.assertEqual(result["metadata"]["toolCalls"],3)

    def test_named_invalid_args_mutating_or_throwing_validator_never_executes(self):
        def mutate(x): x["value"]=2; return True
        def throws(x): raise ValueError("PRIVATE")
        for entry,args in ((extra(),{"value":True}),(extra(),{"value":1,"unexpected":"PRIVATE"}),
                           (extra(validate=mutate),{"value":1}),(extra(validate=throws),{"value":1}),
                           (extra(validate=lambda x:1),{"value":1})):
            calls=[];rpc=Rpc(lambda t:[named_request(t,args=args),completed(t)])
            result=engine(rpc,lambda p,t:calls.append(p) or RESULT,extra_tools=[entry]).run("x")
            self.assertEqual(result["metadata"]["code"],"OK");self.assertEqual(calls,[])
            self.assertEqual(result["metadata"]["toolRefusals"],1)
            refusal=json.loads(rpc.responses[0][1]["contentItems"][0]["text"])
            self.assertEqual(refusal,{"schema":"neurobro-tool-error-v1","code":"invalid-arguments"})
            self.assertNotIn("PRIVATE",json.dumps(result["metadata"]))

    def test_unknown_and_default_unregistered_tools_poison_before_callback(self):
        for name,entries in (("neurobro_archive",()),("neurobro_unknown",[extra()]),(["bad"],[extra()])):
            calls=[];rpc=Rpc(lambda t:[named_request(t,name),completed(t)])
            result=engine(rpc,lambda p,t:calls.append(p) or RESULT,extra_tools=entries).run("x")
            self.assertEqual(result["metadata"]["code"],"TOOL_REFUSED");self.assertEqual(calls,[])
            self.assertTrue(result["metadata"]["sessionPoisoned"])

    def test_registry_bounds_shape_duplicates_no_history_override(self):
        variants=[[extra(m.NAME)],[extra(),extra()],[extra("other")],[extra("neurobro_1bad")],
                  [extra("neurobro_"+"x"*56)],[extra("neurobro_x"+str(i)) for i in range(32)],
                  [{"spec":extra()["spec"]}], [{"spec":extra()["spec"],"validate":None}]]
        for patch in ({"additionalProperties":True},{"required":["value","value"]},{"required":["absent"]},{"properties":{"value":"integer"}}):
            entry=extra();entry["spec"]["inputSchema"].update(patch);variants.append([entry])
        entry=extra();entry["spec"]["inputSchema"]["properties"]["value"]["description"]="x"*8192;variants.append([entry])
        entries=[extra("neurobro_x"+str(i)) for i in range(8)]
        for entry in entries:entry["spec"]["inputSchema"]["properties"]["value"]["description"]="x"*4096
        variants.append(entries)
        for entries in variants:
            rpc=Rpc()
            with self.assertRaises(m.Refused) as caught:engine(rpc,extra_tools=entries)
            self.assertEqual(caught.exception.code,"CONFIG_REFUSED");self.assertEqual(rpc.calls,[])
        self.assertEqual(len(engine(extra_tools=[extra("neurobro_x"+str(i)) for i in range(31)]).tool_names()),32)

    def test_registered_lifecycle_cannot_change_tool_or_args_after_callback(self):
        for key,value in (("tool","neurobro_schedule_text"),("arguments",{"value":2}),("tool","neurobro_unknown")):
            rpc=Rpc(lambda t:[named_request(t),completed(t)])
            def terminal(identifier,result):
                p=rpc.requests[(type(identifier),identifier)]
                item={"id":p["callId"],"type":"dynamicToolCall","tool":p["tool"],"arguments":p["arguments"],"status":"completed",**result,key:value}
                rpc.frames.insert(0,{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":5,"item":item}})
            rpc.on_respond=terminal
            result=engine(rpc,extra_tools=[extra(),extra("neurobro_schedule_text")]).run("x")
            self.assertEqual(result["metadata"]["code"],"TOOL_REFUSED");self.assertIsNone(result["answer"])

    def test_named_total_eight_calls_four_refusals_and_duplicate_id_bounds(self):
        calls=[]
        rpc=Rpc(lambda t:[named_request(t,rpc_id=i,call_id="call"+str(i)) for i in range(12)]+[completed(t)])
        result=engine(rpc,lambda p,t:calls.append(p) or RESULT,extra_tools=[extra()]).run("x")
        self.assertEqual(result["metadata"]["code"],"OK");self.assertEqual(len(calls),8)
        self.assertEqual(result["metadata"]["toolRefusals"],4)
        self.assertEqual(json.loads(rpc.responses[-1][1]["contentItems"][0]["text"])["code"],"tool-budget-exhausted")
        for count in (2,13):
            rpc=Rpc(lambda t:[named_request(t,rpc_id=i if count==13 else 1,call_id="call"+str(i)) for i in range(count)]+[completed(t)])
            result=engine(rpc,extra_tools=[extra()]).run("x")
            self.assertIn(result["metadata"]["code"],("TOOL_REFUSED","BOUNDS_REFUSED"))
            self.assertTrue(result["metadata"]["sessionPoisoned"])

    def test_two_turns_one_thread_and_policy_unchanged(self):
        rpc = Rpc(); e = engine(rpc)
        a, b = e.run("Первый"), e.run("Второй")
        self.assertEqual([a["metadata"]["code"], b["metadata"]["code"]], ["OK", "OK"])
        self.assertEqual([c[0] for c in rpc.calls], ["thread/start", "turn/start", "turn/start"])
        for method, params in rpc.calls:
            self.assertEqual(params["model"], "gpt-6-astra")
            self.assertEqual(params["permissions"], PROFILE)
            self.assertEqual(params["environments"], [])
            self.assertEqual(params["approvalPolicy"], "never")
        self.assertEqual(rpc.calls[0][1]["dynamicTools"], [SPEC])
        self.assertTrue(rpc.calls[0][1]["ephemeral"])
        self.assertEqual(rpc.calls[1][1]["threadId"], rpc.calls[2][1]["threadId"])
        self.assertNotIn("settled", json.dumps(b["metadata"]).lower())

    def test_pinned_observer_failure_preserves_fixed_site_method_and_shape(self):
        def plan(turn):
            return [{"method": "configWarning", "params": {"summary": "PRIVATE warning text"}},
                    {"method": "thread/started", "params": {"thread": {"id": "PRIVATE foreign thread", "ephemeral": True}}}]
        result = engine(Rpc(plan)).run("PRIVATE primary")
        receipt = result["metadata"]; observed = receipt["observer"]
        self.assertIsNone(result["answer"]); self.assertEqual(receipt["eventCount"], 2)
        self.assertEqual(receipt["failureSite"], "observer_or_transport"); self.assertEqual(observed["site"], "thread_event")
        self.assertEqual(observed["method"], "thread/started"); self.assertTrue(observed["shape"]["nestedThreadObject"])
        self.assertTrue(observed["shape"]["threadEphemeralTrue"]); self.assertNotIn("PRIVATE", json.dumps(receipt))
        self.assertTrue(receipt["sessionPoisoned"]); self.assertEqual(receipt["toolCalls"], 0)

    def test_adapter_exception_cannot_forge_pinned_observer_diagnostics(self):
        class Impostor(Exception):
            code, site = "PROTOCOL_REFUSED", "thread_event"
        rpc = Rpc()
        def bad(seconds): raise Impostor("PRIVATE exception payload")
        rpc.next_frame = bad
        result = engine(rpc).run("PRIVATE")
        self.assertEqual(result["metadata"]["observer"], m.observer_metadata())
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertEqual(engine().run("ok")["metadata"]["observer"], m.observer_metadata())

    def test_global_metadata_is_passive_and_preserves_two_turns(self):
        def plan(turn):
            return [{"method": "skills/changed", "params": {}},
                    {"method": "app/list/updated", "params": {"data": [{"id": "PRIVATE app", "name": "PRIVATE name", "isEnabled": False, "appMetadata": {"categories": ["PRIVATE category"]}}]}},
                    *[{"method": "mcpServer/startupStatus/updated", "params": {"name": "PRIVATE mcp", "status": status, "threadId": None}} for status in ("starting", "ready", "failed", "cancelled")],
                    completed(turn)]
        rpc = Rpc(plan); e = engine(rpc)
        for _ in range(2): self.assertEqual(e.run("hello")["metadata"]["code"], "OK")
        self.assertEqual([x[0] for x in rpc.calls], ["thread/start", "turn/start", "turn/start"])
        self.assertEqual(rpc.responses, [])

    def test_global_metadata_invalid_fields_and_cross_thread_are_refused(self):
        invalid = [("skills/changed", {"unexpected": True}), ("app/list/updated", {"data": [{}]}),
                   ("app/list/updated", {"data": [{"id": "a", "name": "b", "branding": {}}]}),
                   ("app/list/updated", {"data": [{"id": "a", "name": "b", "appMetadata": {"review": {"status": False}}}]}),
                   ("mcpServer/startupStatus/updated", {"name": "m", "status": "ready", "threadId": "PRIVATE foreign"}),
                   ("mcpServer/startupStatus/updated", {"name": "m", "status": "PRIVATE bad"}),
                   ("mcpServer/startupStatus/updated", {"name": "m", "status": "failed", "failureReason": "PRIVATE bad"})]
        for method, params in invalid:
            result = engine(Rpc(lambda turn: [{"method": method, "params": params}])).run("x")
            self.assertIsNone(result["answer"]); self.assertEqual(result["metadata"]["observer"]["method"], method)
            self.assertEqual(result["metadata"]["observer"]["site"], "event_params")
            self.assertNotIn("PRIVATE", json.dumps(result["metadata"]))
        # Additional installed global names remain named diagnostics, not ignored.
        result = engine(Rpc(lambda turn: [{"method": "fs/changed", "params": {"watchId": "PRIVATE", "changedPaths": []}}])).run("x")
        self.assertEqual(result["metadata"]["observer"]["method"], "fs/changed")
        self.assertIsNone(result["answer"])

    def test_remote_disabled_is_passive_and_records_no_private_identity(self):
        for extra in ({}, {"environmentId": None}):
            params = {"installationId": "PRIVATE installation", "serverName": "PRIVATE server", "status": "disabled", **extra}
            rpc = Rpc(lambda turn: [{"method": "remoteControl/status/changed", "params": params}, completed(turn)])
            value = engine(rpc).run("hello")
            self.assertEqual(value["metadata"]["code"], "OK")
            self.assertEqual(value["metadata"]["observer"]["remoteControlStatus"], "disabled")
            self.assertEqual([x[0] for x in rpc.calls], ["thread/start", "turn/start"])
            self.assertNotIn("PRIVATE", json.dumps(value["metadata"]))

    def test_remote_active_or_enrolled_disabled_custody_refuses_before_any_tool(self):
        for status, environment in (("connecting", None), ("connected", None), ("errored", None), ("disabled", "PRIVATE environment")):
            params = {"installationId": "PRIVATE installation", "serverName": "PRIVATE server", "status": status, "environmentId": environment}
            rpc = Rpc(lambda turn: [{"method": "remoteControl/status/changed", "params": params}, request(turn)])
            calls = []; value = engine(rpc, lambda *args: calls.append(True) or RESULT).run("hello")
            self.assertIsNone(value["answer"]); self.assertEqual(calls, [])
            self.assertEqual(value["metadata"]["code"], "CUSTODY_REFUSED")
            self.assertEqual(value["metadata"]["observer"]["remoteControlStatus"], status)
            self.assertEqual(value["metadata"]["observer"]["method"], "remoteControl/status/changed")
            self.assertNotIn("PRIVATE", json.dumps(value["metadata"]))
        for bad in ({"status": "PRIVATE bad"}, {"status": []}, {"status": "disabled", "environmentId": 3}, {"status": "disabled", "installationId": None}):
            params = {"installationId": "PRIVATE", "serverName": "PRIVATE", **bad}
            value = engine(Rpc(lambda turn: [{"method": "remoteControl/status/changed", "params": params}])).run("x")
            self.assertEqual(value["metadata"]["code"], "PROTOCOL_REFUSED"); self.assertNotIn("PRIVATE", json.dumps(value["metadata"]))

    def test_connected_tool_request_result_lifecycle_and_final(self):
        rpc = Rpc(lambda turn: [request(turn)])
        called = []
        def tool(params, timeout): called.append(params); return copy.deepcopy(RESULT)
        def response(rpc_id, result):
            item = {"id": "call-1", "type": "dynamicToolCall", "tool": m.NAME, "arguments": copy.deepcopy(ARGS), "status": "completed", **result}
            rpc.frames.extend([
                {"method": "serverRequest/resolved", "params": {"threadId": "thread-1", "requestId": rpc_id}},
                {"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 5, "item": item}},
                completed("turn-1", items=[item, message("turn-1")])])
        rpc.on_respond = response
        result = engine(rpc, tool).run("Что было вчера?")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(len(called), 1); self.assertEqual(len(rpc.responses), 1)
        self.assertEqual(called[0]["requestId"], 17); self.assertEqual(called[0]["callId"], "call-1")
        self.assertEqual(rpc.responses[0][0], 17)
        self.assertNotIn("Что было", json.dumps(result["metadata"], ensure_ascii=False))
        self.assertNotIn("messages", json.dumps(result["metadata"]))

    def test_exact_int64_id_kept_without_javascript_rounding(self):
        identifier = 2**63 - 1
        rpc = Rpc(lambda turn: [request(turn, identifier), completed(turn)])
        seen = []
        result = engine(rpc, lambda p, t: seen.append(p["requestId"]) or copy.deepcopy(RESULT)).run("x")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(seen, [identifier]); self.assertEqual(rpc.responses[0][0], identifier)

    def test_unsafe_id_types_refused_before_callback(self):
        for identifier in (True, 1.0, 2**63, -(2**63)-1, None, ""):
            with self.subTest(identifier=identifier):
                rpc = Rpc(lambda turn: [request(turn, identifier)])
                seen = []; result = engine(rpc, lambda p, t: seen.append(p)).run("x")
                self.assertTrue(result["metadata"]["sessionPoisoned"]); self.assertEqual(seen, [])
                self.assertEqual(rpc.responses, [])

    def test_duplicate_rpc_id_or_call_id_and_foreign_correlation(self):
        for field, replacement in (("id", 17), ("callId", "call-1"), ("threadId", "foreign"), ("turnId", "foreign"), ("tool", "shell"), ("namespace", "foreign")):
            with self.subTest(field=field):
                first = request("turn-1")
                second = request("turn-1", 18, "call-2")
                if field == "id": second["id"] = replacement
                else: second["params"][field] = replacement
                rpc = Rpc(lambda turn: [first, second, completed(turn)])
                e = engine(rpc); result = e.run("x")
                self.assertIsNone(result["answer"]); self.assertTrue(e.state()["poisoned"])
                self.assertEqual(len(rpc.responses), 1)
                before = len(rpc.calls); self.assertEqual(e.run("another")["metadata"]["code"], "SESSION_POISONED")
                self.assertEqual(len(rpc.calls), before)

    def test_tool_exception_and_late_result_poison_without_leak(self):
        rpc = Rpc(lambda turn: [request(turn)])
        def broken(params, timeout): raise ValueError("PRIVATE history and credentials")
        result = engine(rpc, broken).run("PRIVATE question")
        self.assertIsNone(result["answer"])
        self.assertNotIn("PRIVATE", json.dumps(result)); self.assertEqual(rpc.responses, [])
        clock = [0.0]
        def late(params, timeout): clock[0] = 126; return copy.deepcopy(RESULT)
        rpc = Rpc(lambda turn: [request(turn)])
        result = engine(rpc, late, clock=lambda: clock[0]).run("x")
        self.assertEqual(result["metadata"]["code"], "TRANSPORT_UNKNOWN"); self.assertEqual(rpc.responses, [])

    def test_typed_tool_refusal_can_continue(self):
        rpc = Rpc(lambda turn: [request(turn), completed(turn, "История недоступна")])
        result = engine(rpc, lambda p, t: {"success": False, "contentItems": [{"type": "inputText", "text": '{"code":"unavailable"}'}]}).run("x")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertFalse(rpc.responses[0][1]["success"])

    def test_escaped_wire_budget_and_tool_count_cap(self):
        rpc = Rpc(lambda turn: [request(turn)])
        result = engine(rpc, lambda p, t: {"success": True, "contentItems": [{"type": "inputText", "text": "\x00"*65536}]}).run("x")
        self.assertEqual(result["metadata"]["code"], "TOOL_REFUSED"); self.assertEqual(rpc.responses, [])
        rpc = Rpc(lambda turn: [*[request(turn, i, "call-"+str(i)) for i in range(9)], completed(turn, "История прочитана частично: лимит страниц")])
        result = engine(rpc).run("x")
        self.assertEqual(len(rpc.responses), 9); self.assertTrue(result["metadata"]["toolBudgetExhausted"])
        self.assertEqual(result["metadata"]["toolCalls"], 8); self.assertEqual(result["metadata"]["toolRefusals"], 1)
        self.assertEqual(result["metadata"]["code"], "OK"); self.assertFalse(rpc.responses[-1][1]["success"])

    def test_full_size_quote_heavy_history_result_is_accepted(self):
        rpc = Rpc(lambda turn: [request(turn), completed(turn)])
        page = '{"x":"' + '\\"'*32764 + '"}'
        self.assertEqual(len(page.encode()), 65536)
        result = engine(rpc, lambda p, t: {"success": True, "contentItems": [{"type": "inputText", "text": page}]}).run("x")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertGreater(result["metadata"]["toolResultBytes"], 65536)

    def test_bad_spec_and_source_rejected_without_rpc(self):
        rpc = Rpc()
        bad = copy.deepcopy(SPEC); del bad["type"]
        with self.assertRaises(m.Refused):
            m.NativeConversation(SOURCE, profile=PROFILE, cwd=CWD, tool_spec=bad, instructions="x", rpc=rpc, tool=lambda p,t: RESULT)
        with self.assertRaises(m.Refused):
            m.NativeConversation(SOURCE+"\n", profile=PROFILE, cwd=CWD, tool_spec=SPEC, instructions="x", rpc=rpc, tool=lambda p,t: RESULT)
        self.assertEqual(rpc.calls, [])

    def test_benign_metadata_interleaving_and_per_turn_event_reset(self):
        def plan(turn):
            return [{"method": "configWarning", "params": {"summary": "PRIVATE warning"}},
                    {"method": "account/updated", "params": {"authMode": "chatgpt"}},
                    *[{"method": "thread/tokenUsage/updated", "params": {"threadId": "thread-1"}} for _ in range(300)], completed(turn)]
        e = engine(Rpc(plan))
        for _ in range(2):
            result = e.run("x"); self.assertEqual(result["metadata"]["code"], "OK")
            self.assertEqual(result["metadata"]["eventCount"], 303); self.assertNotIn("PRIVATE", json.dumps(result))

    def test_event_overflow_and_missing_final_poison(self):
        rpc = Rpc(lambda turn: [{"method": "thread/tokenUsage/updated", "params": {"threadId": "thread-1"}} for _ in range(513)])
        result = engine(rpc).run("x"); self.assertEqual(result["metadata"]["code"], "BOUNDS_REFUSED")
        result = engine(Rpc(lambda turn: [completed(turn, items=[])])).run("x")
        self.assertEqual(result["metadata"]["code"], "ANSWER_REFUSED")

    def test_lifecycle_without_real_tool_request_refused_and_no_send(self):
        item = {"id": "invented", "type": "dynamicToolCall", "tool": m.NAME, "arguments": ARGS, "status": "completed"}
        result = engine(Rpc(lambda turn: [completed(turn, items=[item, message(turn)])])).run("x")
        self.assertEqual(result["metadata"]["failureSite"], "tool_item_missing")

    def test_missing_timestamp_or_changed_final_refused(self):
        def plan(turn):
            return [{"method": "item/completed", "params": {"threadId": "thread-1", "turnId": turn, "item": message(turn)}}]
        self.assertEqual(engine(Rpc(plan)).run("x")["metadata"]["failureSite"], "item_timestamp")
        def changed(turn):
            return [{"method": "item/completed", "params": {"threadId": "thread-1", "turnId": turn, "completedAtMs": 1, "item": message(turn, "A")}}, completed(turn, "B")]
        self.assertEqual(engine(Rpc(changed)).run("x")["metadata"]["failureSite"], "answer_changed")

    def test_reentrant_call_busy_without_second_admission(self):
        rpc = Rpc(lambda turn: [request(turn), completed(turn)])
        busy = []
        def tool(params, timeout): busy.append(e.run("nested")); return RESULT
        e = engine(rpc, tool)
        self.assertEqual(e.run("x")["metadata"]["code"], "OK")
        self.assertEqual(busy[0]["metadata"]["code"], "BUSY")
        self.assertEqual(e.state()["turnsAttempted"], 1)

    def test_invalid_arguments_graceful_refusal_and_refusal_loop_bound(self):
        bad = request("turn-1"); bad["params"]["arguments"] = {"fromDate": "yesterday"}
        rpc = Rpc(lambda turn: [bad, completed(turn, "Нужен корректный период")])
        seen = []
        result = engine(rpc, lambda p,t: seen.append(p)).run("x")
        self.assertEqual(result["metadata"]["code"], "OK"); self.assertEqual(seen, [])
        self.assertEqual(result["metadata"]["toolRefusals"], 1)
        self.assertFalse(rpc.responses[0][1]["success"])
        def loop(turn):
            values = [request(turn, i, "call-"+str(i)) for i in range(5)]
            for value in values: value["params"]["arguments"] = {}
            return values
        rpc = Rpc(loop); result = engine(rpc).run("x")
        self.assertEqual(len(rpc.responses), 4); self.assertIsNone(result["answer"])
        self.assertTrue(result["metadata"]["toolBudgetExhausted"])

    def test_terminal_required_and_terminal_conflict_cannot_be_overwritten(self):
        rpc = Rpc(lambda turn: [request(turn), completed(turn)]); rpc.auto_terminal = False
        self.assertEqual(engine(rpc).run("x")["metadata"]["failureSite"], "tool_item_missing")
        rpc = Rpc(lambda turn: [request(turn)])
        def respond(identifier, result):
            item = {"id": "call-1", "type": "dynamicToolCall", "tool": m.NAME, "arguments": ARGS, "status": "completed", **result}
            conflict = copy.deepcopy(item); conflict["contentItems"][0]["text"] = '{"different":true}'
            for value in (item, conflict, item):
                rpc.frames.append({"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 1, "item": value}})
            rpc.frames.append(completed("turn-1", items=[item, message("turn-1")]))
        rpc.on_respond = respond
        self.assertEqual(engine(rpc).run("x")["metadata"]["failureSite"], "tool_item_changed")

    def test_order_independent_object_fingerprints_and_optional_terminal_merge(self):
        rpc = Rpc(lambda turn: [request(turn)])
        def respond(identifier, result):
            item = {"id": "call-1", "type": "dynamicToolCall", "tool": m.NAME,
                    "arguments": {"cursor": None, "toDate": 200, "fromDate": 1}, "status": "completed",
                    "contentItems": [{"text": result["contentItems"][0]["text"], "type": "inputText"}], "success": True}
            sparse = {k:v for k,v in item.items() if k not in {"success", "contentItems"}}
            rpc.frames.extend([
                {"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 1, "item": item}},
                completed("turn-1", items=[sparse, message("turn-1")])])
        rpc.on_respond = respond
        self.assertEqual(engine(rpc).run("x")["metadata"]["code"], "OK")

    def test_callback_reservation_exact_boundary_and_one_byte_over(self):
        boundary = m.TOOL_TURN_WIRE_CAP - m.TOOL_REPLY_RESERVATION - m.TOOL_REFUSAL_CAP*1024
        for offset, expected_calls in ((0, 1), (1, 0)):
            rpc = Rpc(); rpc.on_respond = lambda i,r: None
            calls = []; e = engine(rpc, lambda p,t: calls.append(p) or RESULT, clock=lambda: 0)
            e._thread = "thread-1"
            receipt = m.metadata(); receipt["toolResultBytes"] = boundary+offset
            e._request(request("turn-1"), "turn-1", 125, receipt)
            self.assertEqual(len(calls), expected_calls)
            self.assertEqual(receipt["toolBudgetExhausted"], offset == 1)
            self.assertLessEqual(receipt["toolResultBytes"], m.TOOL_TURN_WIRE_CAP)

    def test_large_pages_streamed_and_snapshot_echoes_separate_from_normal_budget(self):
        page = '{"x":"' + '\\"'*32764 + '"}'
        rpc = Rpc(lambda turn: [*[request(turn, i, "call-"+str(i)) for i in range(8)], completed(turn, "Прочитано частично, достигнут бюджет")])
        def respond(identifier, result):
            p = rpc.requests[(type(identifier), identifier)]
            item = {"id": p["callId"], "type": "dynamicToolCall", "tool": m.NAME, "arguments": ARGS, "status": "completed", **copy.deepcopy(result)}
            rpc.frames.insert(0, {"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 1, "item": item}})
            final = next(x for x in rpc.frames if x["method"] == "turn/completed")
            final["params"]["turn"]["items"].insert(0, item)
        rpc.on_respond = respond
        result = engine(rpc, lambda p,t: {"success": True, "contentItems": [{"type": "inputText", "text": page}]}).run("x")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(result["metadata"]["toolCalls"], 7)
        self.assertTrue(result["metadata"]["toolBudgetExhausted"])
        self.assertGreater(result["metadata"]["historyLifecycleBytes"], m.EVENT_BYTES_CAP)
        self.assertLessEqual(result["metadata"]["historyLifecycleBytes"], m.HISTORY_LIFECYCLE_CAP)
        self.assertLess(result["metadata"]["eventBytes"], m.EVENT_BYTES_CAP)

    def test_history_echo_overflow_and_mixed_agent_text_not_exempt(self):
        page = '{"x":"' + '\\"'*32764 + '"}'
        rpc = Rpc(lambda turn: [request(turn)])
        def respond(identifier, result):
            item = {"id": "call-1", "type": "dynamicToolCall", "tool": m.NAME, "arguments": ARGS, "status": "completed", **result}
            rpc.frames.extend([{"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 1, "item": item}} for _ in range(20)])
        rpc.on_respond = respond
        result = engine(rpc, lambda p,t: {"success": True, "contentItems": [{"type": "inputText", "text": page}]}).run("x")
        self.assertEqual(result["metadata"]["code"], "BOUNDS_REFUSED")
        self.assertEqual(result["metadata"]["historyLifecycleBytes"], m.HISTORY_LIFECYCLE_CAP+1)
        item = {"id": "call-1", "type": "dynamicToolCall", "tool": m.NAME, "arguments": ARGS, "status": "completed", **RESULT}
        rpc = Rpc(lambda turn: [request(turn), completed(turn, items=[item, message(turn, "a"*m.EVENT_BYTES_CAP)])])
        result = engine(rpc).run("x")
        self.assertEqual(result["metadata"]["code"], "BOUNDS_REFUSED")
        self.assertEqual(result["metadata"]["eventBytes"], m.EVENT_BYTES_CAP+1)

    def test_only_validated_registered_text_payload_uses_shared_lifecycle_budget(self):
        name='neurobro_create_text_file';args={'filename':'max.txt','text':'\t'*65536}
        validator=lambda a:type(a) is dict and set(a)=={'filename','text'} and a['filename']=='max.txt' and a['text']==args['text']
        e=engine(extra_tools=[extra(name,validator)])
        frame=named_request('turn-1',name,args);original=copy.deepcopy(frame);receipt=m.metadata()
        for _ in range(3):e._count_frame(frame,receipt)
        self.assertEqual(frame,original)
        self.assertEqual(receipt['historyLifecycleBytes'],3*131072)
        self.assertLess(receipt['eventBytes'],4096)
        for label,patch_value,registered in [('other',{'tool':'neurobro_other'},True),
                ('namespace',{'namespace':'foreign'},True),('extra',{'arguments':{**args,'path':'private'}},True),
                ('invalid',{'arguments':{**args,'filename':'../max.txt'}},True),('unregistered',{},False)]:
            candidate=copy.deepcopy(frame);candidate['params'].update(patch_value)
            target=e if registered else engine();facts=m.metadata()
            with self.subTest(label=label):
                with self.assertRaises(m.Refused):
                    for _ in range(3):target._count_frame(candidate,facts)
                self.assertEqual(facts['historyLifecycleBytes'],0)
                self.assertEqual(facts['eventBytes'],m.EVENT_BYTES_CAP+1)

    def test_text_payload_echoes_are_bounded_and_do_not_hide_ordinary_noise(self):
        name='neurobro_create_text_file';args={'filename':'max.txt','text':'\t'*65536}
        e=engine(extra_tools=[extra(name,lambda a:a==args)])
        item={'id':'text-call','type':'dynamicToolCall','tool':name,'namespace':None,'arguments':args,'status':'completed',**RESULT}
        frame=completed('turn-1',items=[item,message('turn-1')]);facts=m.metadata()
        with self.assertRaises(m.Refused):
            for _ in range(8*3):e._count_frame(frame,facts)
        self.assertEqual(facts['historyLifecycleBytes'],m.HISTORY_LIFECYCLE_CAP+1)
        self.assertLess(facts['eventBytes'],m.EVENT_BYTES_CAP)
        noisy=completed('turn-1',items=[item,message('turn-1','x'*m.EVENT_BYTES_CAP)])
        facts=m.metadata()
        with self.assertRaises(m.Refused):e._count_frame(noisy,facts)
        self.assertEqual(facts['eventBytes'],m.EVENT_BYTES_CAP+1)

    def test_analysis_max_commit_payload_and_compatible_echoes_use_existing_lifecycle_budget(self):
        args, entries, config = analysis_payload_fixture(); original = copy.deepcopy(args)
        calls = []; rpc = Rpc(lambda t: [named_request(t, "neurobro_analysis_commit", args), completed(t)])
        def respond(identifier, result):
            p = rpc.requests[(type(identifier), identifier)]
            item = {"id": p["callId"], "type": "dynamicToolCall", "tool": p["tool"], "namespace": None,
                    "arguments": copy.deepcopy(p["arguments"]), "status": "completed", **copy.deepcopy(result)}
            event = {"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 1, "item": item}}
            rpc.frames[:0] = [copy.deepcopy(event), copy.deepcopy(event)]
            rpc.frames[-1]["params"]["turn"]["items"].insert(0, copy.deepcopy(item))
        rpc.on_respond = respond
        result = engine(rpc, lambda p,t: calls.append(p) or copy.deepcopy(RESULT), extra_tools=entries, thread_config=config).run("Commit analysis")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(result["metadata"]["toolCalls"], 1)
        self.assertGreater(result["metadata"]["historyLifecycleBytes"], m.EVENT_BYTES_CAP)
        self.assertLessEqual(result["metadata"]["historyLifecycleBytes"], m.HISTORY_LIFECYCLE_CAP)
        self.assertLess(result["metadata"]["eventBytes"], 4096)
        self.assertEqual(calls[0]["arguments"], original); self.assertEqual(args, original)

    def test_analysis_payload_exemption_requires_active_profile_exact_args_and_validator(self):
        args, entries, config = analysis_payload_fixture()
        target = engine(extra_tools=entries, thread_config=config)
        frame = named_request("turn-1", "neurobro_analysis_commit", args)
        variants = [("extra-args", {"arguments": {**args, "path": "private"}}, target),
                    ("extra-output", {"arguments": {"output": {**args["output"], "untrusted": True}}}, target),
                    ("namespace", {"namespace": "foreign"}, target),
                    ("other-tool", {"tool": "neurobro_analysis_notes"}, target),
                    ("legacy-registered", {}, engine(extra_tools=entries)),
                    ("unregistered", {}, engine())]
        def mutates(value): value["output"]["summary"] = "changed"; return True
        def throws(value): raise ValueError("PRIVATE")
        for validator in (lambda value: False, lambda value: 1, mutates, throws):
            changed_entries = entries[:2]+[extra("neurobro_analysis_commit", validator)]
            variants.append(("validator-"+validator.__name__, {}, engine(extra_tools=changed_entries, thread_config=config)))
        for label, patch, e in variants:
            candidate = copy.deepcopy(frame); candidate["params"].update(patch); original = copy.deepcopy(candidate)
            facts = m.metadata()
            with self.subTest(label=label):
                with self.assertRaises(m.Refused):
                    for _ in range(4): e._count_frame(candidate, facts)
                self.assertEqual(facts["historyLifecycleBytes"], 0)
                self.assertEqual(facts["eventBytes"], m.EVENT_BYTES_CAP+1)
                self.assertEqual(candidate, original)

    def test_analysis_payload_lifecycle_cap_and_ordinary_agent_noise_remain_enforced(self):
        args, entries, config = analysis_payload_fixture(); e = engine(extra_tools=entries, thread_config=config)
        item = {"id": "analysis", "type": "dynamicToolCall", "tool": "neurobro_analysis_commit", "namespace": None,
                "arguments": args, "status": "completed", **RESULT}
        frame = completed("turn-1", items=[item, message("turn-1")]); original = copy.deepcopy(frame); facts = m.metadata()
        with self.assertRaises(m.Refused):
            for _ in range(30): e._count_frame(frame, facts)
        self.assertEqual(facts["historyLifecycleBytes"], m.HISTORY_LIFECYCLE_CAP+1)
        self.assertLess(facts["eventBytes"], m.EVENT_BYTES_CAP)
        self.assertEqual(frame, original)
        noisy = completed("turn-1", items=[item, message("turn-1", "x"*m.EVENT_BYTES_CAP)])
        facts = m.metadata()
        with self.assertRaises(m.Refused): e._count_frame(noisy, facts)
        self.assertEqual(facts["eventBytes"], m.EVENT_BYTES_CAP+1)

    def test_analysis_payload_changed_echo_still_fails_original_fingerprint(self):
        args, entries, config = analysis_payload_fixture(); calls = []
        rpc = Rpc(lambda t: [named_request(t, "neurobro_analysis_commit", args), completed(t)])
        def respond(identifier, result):
            p = rpc.requests[(type(identifier), identifier)]; changed = copy.deepcopy(args)
            changed["output"]["summary"] = "z"+changed["output"]["summary"][1:]
            item = {"id": p["callId"], "type": "dynamicToolCall", "tool": p["tool"], "arguments": changed,
                    "namespace": None, "status": "completed", **copy.deepcopy(result)}
            rpc.frames.insert(0, {"method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 1, "item": item}})
        rpc.on_respond = respond
        result = engine(rpc, lambda p,t: calls.append(p) or copy.deepcopy(RESULT), extra_tools=entries, thread_config=config).run("Commit analysis")
        self.assertEqual(result["metadata"]["code"], "TOOL_REFUSED")
        self.assertEqual(result["metadata"]["failureSite"], "tool_item_correlation")
        self.assertTrue(result["metadata"]["sessionPoisoned"]); self.assertEqual(len(calls), 1)

    def test_analysis_seven_read_callbacks_reserve_eighth_callback_for_commit_each_turn(self):
        args, entries, config = analysis_payload_fixture(); calls = []
        def plan(t):
            return [named_request(t, "neurobro_analysis_material" if i%2 == 0 else "neurobro_analysis_notes",
                                  rpc_id=t+str(i), call_id=t+"-read-"+str(i)) for i in range(8)] + [
                named_request(t, "neurobro_analysis_commit", args, rpc_id=t+"commit", call_id=t+"-commit"), completed(t)]
        rpc = Rpc(plan)
        e = engine(rpc, lambda p,t: calls.append(p) or copy.deepcopy(RESULT), extra_tools=entries, thread_config=config)
        for _ in range(2):
            result = e.run("Analyze saved material")
            self.assertEqual(result["metadata"]["code"], "OK")
            self.assertEqual(result["metadata"]["toolCalls"], 8)
            self.assertEqual(result["metadata"]["toolRefusals"], 1)
            self.assertTrue(result["metadata"]["toolBudgetExhausted"])
        self.assertEqual(len(calls), 16)
        self.assertEqual([calls[i]["tool"] for i in (7,15)], ["neurobro_analysis_commit"]*2)
        for i in (7,16):
            self.assertFalse(rpc.responses[i][1]["success"])
            self.assertEqual(json.loads(rpc.responses[i][1]["contentItems"][0]["text"])["code"], "tool-budget-exhausted")

    def test_analysis_invalid_read_consumes_no_callback_and_legacy_has_no_read_reserve(self):
        args, entries, config = analysis_payload_fixture(); calls = []
        def plan(t):
            return [named_request(t, "neurobro_analysis_material", {"value": True}, rpc_id="bad", call_id="bad-read")] + [
                named_request(t, "neurobro_analysis_notes", rpc_id=i, call_id="read-"+str(i)) for i in range(7)] + [
                named_request(t, "neurobro_analysis_commit", args, rpc_id="commit", call_id="commit"), completed(t)]
        rpc = Rpc(plan)
        result = engine(rpc, lambda p,t: calls.append(p) or copy.deepcopy(RESULT), extra_tools=entries, thread_config=config).run("Analyze")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(result["metadata"]["toolCalls"], 8)
        self.assertEqual(result["metadata"]["toolRefusals"], 1)
        self.assertFalse(result["metadata"]["toolBudgetExhausted"])
        self.assertEqual(len(calls), 8); self.assertEqual(calls[-1]["tool"], "neurobro_analysis_commit")
        rpc = Rpc(lambda t: [named_request(t, "neurobro_analysis_material", rpc_id=i, call_id="read-"+str(i)) for i in range(8)]+[completed(t)])
        result = engine(rpc, extra_tools=entries).run("Legacy registry")
        self.assertEqual(result["metadata"]["code"], "OK")
        self.assertEqual(result["metadata"]["toolCalls"], 8)
        self.assertEqual(result["metadata"]["toolRefusals"], 0)


if __name__ == "__main__": unittest.main()
