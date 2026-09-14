"""Pure synthetic idle-event tests; no process, auth, model or Telegram."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("epoch_idle", Path(__file__).with_name("rm-0032-native-epoch-idle.py"))
idle = importlib.util.module_from_spec(spec); spec.loader.exec_module(idle)


def frame(method, params): return {"method": method, "params": params}
def status(value="idle", thread="thread-a"):
    return frame("thread/status/changed", {"threadId": thread, "status": {"type": value}})
def tokens():
    row = {k: 0 for k in idle.TOKEN_KEYS}
    return frame("thread/tokenUsage/updated", {"threadId": "thread-a", "turnId": "turn-a",
        "tokenUsage": {"last": dict(row), "total": dict(row), "modelContextWindow": 200000}})
def request(value=2**63-1, call="call-a", **overrides):
    p = {"threadId": "thread-a", "turnId": "turn-a", "callId": call,
         "tool": "neurobro_read_history", "arguments": {"synthetic": "never executed"}}
    p.update(overrides)
    return {"id": value, "method": "item/tool/call", "params": p}
def resolved(value, thread="thread-a"):
    return frame("serverRequest/resolved", {"threadId": thread, "requestId": value})
def empty_rpc():
    return {"partialBytes": 0, "queuedFrames": 0, "pendingRequests": 0, "stdoutEofObserved": False}
def validator(*ids): return idle.EpochIdleValidator("thread-a", "turn-a", ids)


class IdleTests(unittest.TestCase):
    def test_named_late_tools_are_refused_not_executed_and_exact_response_ids_preserved(self):
        names=(idle.HISTORY_TOOL,"neurobro_archive","neurobro_schedule_text")
        v=idle.EpochIdleValidator("thread-a","turn-a",tool_names=names)
        for i,name in enumerate(names):
            identifier=2**63-1-i
            result=v.observe(request(identifier,"call-"+str(i),tool=name,arguments={"untrusted":"ignored"}))
            self.assertEqual(result["kind"],"refuse-tool");self.assertFalse(result["result"]["success"])
            self.assertIs(type(result["requestId"]),int);self.assertEqual(result["requestId"],identifier)
            self.assertFalse(v.idle_clear(empty_rpc()))
            v.confirm_response(identifier);v.observe(resolved(identifier))
        self.assertTrue(v.idle_clear(empty_rpc()))
        self.assertEqual(v.state()["lateRefusals"],3)
        self.assert_poisoned(v,request(1,"unknown",tool="neurobro_unknown"))
        self.assert_poisoned(validator(),request(tool="neurobro_archive"))
        self.assert_poisoned(idle.EpochIdleValidator(None,None,tool_names=names),request(tool="neurobro_archive"))

    def test_named_idle_registry_rejects_wrong_default_duplicates_and_overflow(self):
        for names in ([],(),("neurobro_archive",),(idle.HISTORY_TOOL,idle.HISTORY_TOOL),
                      (idle.HISTORY_TOOL,"bad"),(idle.HISTORY_TOOL,True),
                      tuple([idle.HISTORY_TOOL]+["neurobro_x"+str(i) for i in range(32)])):
            with self.assertRaises(idle.IdleError) as caught:idle.EpochIdleValidator(None,None,tool_names=names)
            self.assertEqual(caught.exception.code,"CONFIG_REFUSED")

    def assert_poisoned(self, v, value):
        with self.assertRaises(idle.IdleError): v.observe(value)
        self.assertTrue(v.state()["poisoned"])
        with self.assertRaises(idle.IdleError) as caught: v.observe(status())
        self.assertEqual(caught.exception.code, "SESSION_POISONED")

    def test_post_turn_status_and_full_token_usage(self):
        v = validator()
        self.assertEqual(v.observe(status()), {"kind": "notification"})
        for optional in (False, True):
            value = tokens()
            if optional:
                for row in ("last", "total"): value["params"]["tokenUsage"][row]["cacheWriteInputTokens"] = 0
                value["params"]["tokenUsage"]["modelContextWindow"] = None
            else: del value["params"]["tokenUsage"]["modelContextWindow"]
            self.assertEqual(v.observe(value), {"kind": "notification"})
        self.assertTrue(v.idle_clear(empty_rpc()))
        self.assertEqual(v.state()["frames"], 3)

    def test_token_shape_int64_bool_missing_foreign_extra_refused(self):
        for kind in ("bool", "negative", "overflow", "missing", "extra", "wrongturn", "foreign", "nullrow", "windowbool", "windowextra"):
            value = tokens(); p = value["params"]; usage = p["tokenUsage"]
            if kind == "bool": usage["last"]["inputTokens"] = True
            if kind == "negative": usage["total"]["totalTokens"] = -1
            if kind == "overflow": usage["last"]["outputTokens"] = 2**63
            if kind == "missing": del usage["last"]["cachedInputTokens"]
            if kind == "extra": usage["total"]["newTokenField"] = 1
            if kind == "wrongturn": p["turnId"] = "turn-b"
            if kind == "foreign": p["threadId"] = "thread-b"
            if kind == "nullrow": usage["last"] = None
            if kind == "windowbool": usage["modelContextWindow"] = True
            if kind == "windowextra": usage["unknown"] = 1
            with self.subTest(kind=kind): self.assert_poisoned(validator(), value)

    def test_status_active_system_error_not_loaded_foreign_and_extra_refused(self):
        for kind in ("active", "systemError", "notLoaded", "unknown"):
            self.assert_poisoned(validator(), status(kind))
        self.assert_poisoned(validator(), status(thread="other"))
        value = status(); value["params"]["status"]["activeFlags"] = []
        self.assert_poisoned(validator(), value)

    def test_unknown_compaction_new_lifecycle_and_account_changes_refused(self):
        for method in ("thread/compacted", "item/started", "item/completed", "turn/started", "turn/completed",
                       "thread/started", "thread/closed", "account/updated", "account/rateLimits/updated",
                       "error", "model/rerouted", "modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted", "unknown/event"):
            with self.subTest(method=method):
                self.assert_poisoned(validator(), frame(method, {"threadId": "thread-a", "turnId": "turn-a"}))

    def test_exact_global_signals_during_startup_and_completed_pause(self):
        for v in (idle.EpochIdleValidator(None, None), validator()):
            self.assertEqual(v.observe(frame("skills/changed", {})), {"kind": "notification"})
            for environment in (False, True):
                p = {"status": "disabled", "installationId": "installation", "serverName": "server"}
                if environment: p["environmentId"] = None
                self.assertEqual(v.observe(frame("remoteControl/status/changed", p)), {"kind": "notification"})
            self.assertTrue(v.idle_clear(empty_rpc()))
        self.assert_poisoned(idle.EpochIdleValidator(None, None), status())
        self.assert_poisoned(idle.EpochIdleValidator(None, None), request())

    def test_global_signals_never_grant_new_custody_or_unknown_fields(self):
        self.assert_poisoned(validator(), frame("skills/changed", {"new": True}))
        for patch in ({"status": "connected"}, {"status": "connecting"}, {"status": "errored"},
                      {"environmentId": "enrolled"}, {"installationId": None}, {"extra": 1}):
            p = {"status": "disabled", "installationId": "i", "serverName": "s"}; p.update(patch)
            self.assert_poisoned(validator(), frame("remoteControl/status/changed", p))

    def test_exact_warnings_before_first_thread_and_after_completed_turn_are_observational(self):
        for v in (idle.EpochIdleValidator(None, None), validator()):
            values = [frame("configWarning", {"summary":"PRIVATE summary"}),
                      frame("deprecationNotice", {"summary":"PRIVATE summary", "details":None}),
                      frame("deprecationNotice", {"summary":"", "details":"PRIVATE details"}),
                      frame("configWarning", {"summary":"PRIVATE summary", "details":None, "path":None, "range":None}),
                      frame("configWarning", {"summary":"PRIVATE summary", "details":"PRIVATE details", "path":"PRIVATE path",
                          "range":{"start":{"line":0,"column":0},"end":{"line":2,"column":3}}})]
            original = copy.deepcopy(values)
            for value in values: self.assertEqual(v.observe(value), {"kind":"notification"})
            self.assertEqual(values, original)
            self.assertTrue(v.idle_clear(empty_rpc()))
            self.assertEqual(v.state()["frames"], len(values))
            self.assertEqual(v.state()["pendingResponses"], 0)
            self.assertNotIn("PRIVATE", json.dumps(v.state()))

    def test_warning_schema_errors_requests_and_custody_fields_still_poison(self):
        invalid = [{}, {"summary":None}, {"summary":True}, {"summary":"s","details":{}},
                   {"summary":"s","path":False}, {"summary":"s","range":[]},
                   {"summary":"s","range":{"start":{"line":1,"column":1}}},
                   {"summary":"s","threadId":"thread-a"}, {"summary":"s","account":{"type":"chatgpt"}}]
        for kind in ("negative","bool","float","missing","extra"):
            position = {"line":1,"column":1}
            if kind == "negative": position["line"] = -1
            if kind == "bool": position["line"] = True
            if kind == "float": position["line"] = 1.0
            if kind == "missing": del position["column"]
            if kind == "extra": position["offset"] = 1
            invalid.append({"summary":"s","range":{"start":position,"end":{"line":1,"column":1}}})
        for params in invalid:
            with self.subTest(params=params): self.assert_poisoned(idle.EpochIdleValidator(None,None),frame("configWarning",params))
        self.assert_poisoned(validator(),frame("deprecationNotice",{"summary":"s","path":None}))
        self.assert_poisoned(validator(),{**frame("configWarning",{"summary":"s"}),"id":1})

    def test_warning_frame_count_and_byte_limits_preserve_bounded_private_state(self):
        value = frame("configWarning", {"summary":"PRIVATE"*10000})
        v = idle.EpochIdleValidator(None,None)
        for _ in range(3): v.observe(value)
        self.assert_poisoned(v,value)
        self.assertLessEqual(v.state()["bytes"],idle.BYTE_CAP+1)
        self.assertNotIn("PRIVATE",json.dumps(v.state()))
        v = validator()
        for _ in range(idle.FRAME_COUNT): v.observe(frame("deprecationNotice",{"summary":"s"}))
        self.assert_poisoned(v,frame("deprecationNotice",{"summary":"s"}))

    def test_resolved_requires_exact_preconfirmed_typed_id(self):
        v = validator(7, "7", -(2**63), 2**63-1, "a b", "\x00")
        for value in (7, "7", -(2**63), 2**63-1, "a b", "\x00"):
            self.assertEqual(v.observe(resolved(value)), {"kind": "notification"})
        self.assertEqual(v.state()["resolvedNotifications"], 6)
        for value in (True, "8", 2**63, 7.0): self.assert_poisoned(validator(7), resolved(value))
        self.assert_poisoned(validator(7), resolved("7"))
        self.assert_poisoned(validator("7"), resolved(7))
        self.assert_poisoned(validator(7), resolved(7, "other"))

    def test_full_reviewed_startup_sequence_and_post_turn_metadata_are_observational(self):
        app = {"id":"PRIVATE app", "name":"PRIVATE name", "description":None,
               "distributionChannel":"public", "installUrl":None, "logoUrl":None, "logoUrlDark":None,
               "iconAssets":{"small":"PRIVATE URL"}, "iconDarkAssets":None, "labels":{},
               "isAccessible":False, "isEnabled":True, "pluginDisplayNames":["PRIVATE plugin"],
               "branding":{"isDiscoverableApp":True,"category":None,"developer":"PRIVATE developer",
                           "privacyPolicy":None,"termsOfService":None,"website":None},
               "appMetadata":{"developer":None,"seoDescription":"PRIVATE description","version":None,"versionId":None,
                              "versionNotes":None,"firstPartyRequiresInstall":None,"showInComposerWhenUnlinked":False,
                              "categories":["PRIVATE category"],"subCategories":None,"review":{"status":"PRIVATE status"},
                              "screenshots":[{"userPrompt":"PRIVATE prompt","fileId":None,"url":None}]}}
        startup = [frame("configWarning",{"summary":"PRIVATE warning"}), frame("deprecationNotice",{"summary":"PRIVATE notice"}),
                   frame("skills/changed",{}), frame("remoteControl/status/changed",{"status":"disabled","installationId":"i","serverName":"s"}),
                   frame("app/list/updated",{"data":[app,{"id":"minimal","name":"minimal"}]}),
                   frame("app/list/updated",{"data":[]})]
        for v in (idle.EpochIdleValidator(None,None), validator()):
            values = copy.deepcopy(startup)
            for state in ("starting","ready","failed","cancelled"):
                values.append(frame("mcpServer/startupStatus/updated",{"name":"PRIVATE server","status":state,
                    "threadId":None,"error":"PRIVATE error" if state=="failed" else None,
                    "failureReason":"reauthenticationRequired" if state=="failed" else None}))
            original = copy.deepcopy(values)
            for value in values: self.assertEqual(v.observe(value),{"kind":"notification"})
            self.assertEqual(values,original)
            self.assertEqual(v.state()["frames"],len(values))
            self.assertEqual(v.state()["pendingResponses"],0)
            self.assertTrue(v.idle_clear(empty_rpc()))
            self.assertNotIn("PRIVATE",json.dumps(v.state()))
        self.assertEqual(validator().observe(frame("mcpServer/startupStatus/updated",{
            "name":"s","status":"ready","threadId":"thread-a"})),{"kind":"notification"})

    def test_app_and_mcp_shapes_requests_cross_thread_and_actions_remain_refused(self):
        for row in ({"name":"n"},{"id":"i","name":None},{"id":"i","name":"n","isEnabled":None},
                    {"id":"i","name":"n","labels":{"x":None}}, {"id":"i","name":"n","pluginDisplayNames":[True]},
                    {"id":"i","name":"n","branding":{}}, {"id":"i","name":"n","appMetadata":{"categories":[False]}},
                    {"id":"i","name":"n","appMetadata":{"review":{"status":None}}},
                    {"id":"i","name":"n","appMetadata":{"screenshots":[{"url":"x"}]}},
                    {"id":"i","name":"n","appMetadata":{"firstPartyRequiresInstall":1}},
                    {"id":"i","name":"n","activate":True}):
            v=validator()
            with self.assertRaises(idle.IdleError) as caught: v.observe(frame("app/list/updated",{"data":[row]}))
            self.assertEqual((caught.exception.code,caught.exception.site),("PROTOCOL_REFUSED","apps"))
        for params in ({},{"data":None},{"data":[],"action":"install"}):
            self.assert_poisoned(validator(),frame("app/list/updated",params))
        for patch in ({"name":None},{"status":None},{"status":"connected"},{"error":True},
                      {"failureReason":"unknown"},{"threadId":"other"},{"threadId":True},{"authorize":True}):
            value=frame("mcpServer/startupStatus/updated",{"name":"s","status":"ready",**patch})
            with self.assertRaises(idle.IdleError) as caught: validator().observe(value)
            self.assertEqual((caught.exception.code,caught.exception.site),("PROTOCOL_REFUSED","mcp_status"))
        self.assert_poisoned(idle.EpochIdleValidator(None,None),frame("mcpServer/startupStatus/updated",{
            "name":"s","status":"ready","threadId":"thread-a"}))
        for value in (frame("app/list/updated",{"data":[]}),frame("mcpServer/startupStatus/updated",{"name":"s","status":"ready"})):
            self.assert_poisoned(validator(),{**value,"id":7})
        for method in ("app/install","mcpServer/authorize","account/updated","model/rerouted"):
            self.assert_poisoned(validator(),frame(method,{}))

    def test_app_metadata_uses_existing_global_aggregate_bounds(self):
        v=validator()
        value=frame("app/list/updated",{"data":[{"id":"PRIVATE"*10000,"name":"n"}]})
        for _ in range(3): v.observe(value)
        self.assert_poisoned(v,value)
        self.assertEqual(v.state()["bytes"],idle.BYTE_CAP+1)
        self.assertNotIn("PRIVATE",json.dumps(v.state()))

    def test_late_history_refused_once_then_exact_successful_response_confirmation(self):
        v = validator()
        f = request(); original = copy.deepcopy(f)
        result = v.observe(f)
        self.assertEqual(f, original)
        self.assertEqual(result["kind"], "refuse-tool")
        self.assertIs(type(result["requestId"]), int)
        self.assertEqual(result["requestId"], 2**63-1)
        self.assertFalse(result["result"]["success"])
        message = json.loads(result["result"]["contentItems"][0]["text"])
        self.assertEqual(message, {"schema": "neurobro-history-tool-error-v1", "code": "turn-not-active"})
        self.assertFalse(v.idle_clear(empty_rpc()))
        self.assertEqual(v.state()["pendingResponses"], 1)
        v.confirm_response(result["requestId"])
        self.assertTrue(v.idle_clear(empty_rpc()))
        self.assertEqual(v.observe(resolved(result["requestId"])), {"kind": "notification"})
        self.assertEqual(v.state()["confirmedResponses"], 1)
        self.assert_poisoned(v, request())

    def test_pending_not_resolved_and_confirmation_not_fabricated(self):
        v = validator(); v.observe(request())
        self.assert_poisoned(v, resolved(2**63-1))
        for value in (1, True, "9223372036854775807"):
            v = validator(); v.observe(request())
            with self.assertRaises(idle.IdleError): v.confirm_response(value)
            self.assertTrue(v.state()["poisoned"])
        v = validator(); v.observe(request()); v.confirm_response(2**63-1)
        with self.assertRaises(idle.IdleError): v.confirm_response(2**63-1)

    def test_late_tool_scope_namespace_method_and_reused_call_refused(self):
        for patch in ({"turnId": "other"}, {"threadId": "other"}, {"tool": "other"},
                      {"namespace": "other"}, {"callId": "bad call"}, {"extra": True}):
            self.assert_poisoned(validator(), request(**patch))
        value = request(); value["method"] = "item/commandExecution/requestApproval"
        self.assert_poisoned(validator(), value)
        v = validator(); v.observe(request(1, "same")); v.confirm_response(1)
        self.assert_poisoned(v, request(2, "same"))
        self.assert_poisoned(validator(1), request(1))

    def test_four_late_refusals_only_with_bounded_metadata(self):
        v = validator()
        for index in range(4): v.observe(request(index, "call-"+str(index)))
        self.assertEqual(v.state()["pendingResponses"], 4)
        self.assertEqual(v.state()["lateRefusals"], 4)
        self.assert_poisoned(v, request(4, "call-4"))
        self.assertNotIn("thread-a", json.dumps(v.state()))
        self.assertNotIn("call-", json.dumps(v.state()))

    def test_idle_clear_checks_all_observed_rpc_work_but_not_future_events(self):
        for field in empty_rpc():
            state = empty_rpc(); state[field] = True if field == "stdoutEofObserved" else 1
            self.assertFalse(validator().idle_clear(state))
        for state in ({}, {**empty_rpc(), "other": 0}, {**empty_rpc(), "pendingRequests": True}):
            with self.assertRaises(idle.IdleError): validator().idle_clear(state)
        v = validator(); self.assertTrue(v.idle_clear(empty_rpc()))
        self.assert_poisoned(v, frame("turn/started", {"threadId": "thread-a", "turnId": "new"}))

    def test_frame_and_aggregate_budgets_poison_without_payload_diagnostics(self):
        v = validator()
        for _ in range(512): v.observe(frame("skills/changed", {}))
        self.assert_poisoned(v, frame("skills/changed", {}))
        p = {"status": "disabled", "installationId": "PRIVATE"*10000, "serverName": "s"}
        v = validator()
        for _ in range(3): v.observe(frame("remoteControl/status/changed", p))
        self.assert_poisoned(v, frame("remoteControl/status/changed", p))
        self.assertLessEqual(v.state()["bytes"], idle.BYTE_CAP+1)
        self.assertNotIn("PRIVATE", json.dumps(v.state()))
        self.assert_poisoned(validator(), request(arguments="x"*idle.FRAME_CAP))

    def test_exact_normalized_envelope_and_non_json_refused(self):
        for value in ({"id": 1, "result": {}}, {"method": "skills/changed"},
                      {**frame("skills/changed", {}), "jsonrpc": "2.0"},
                      {**frame("skills/changed", {}), "emittedAtMs": 1},
                      request(arguments=float("nan")), request(arguments="\ud800"), []):
            self.assert_poisoned(validator(), value)

    def test_constructor_scope_seed_bounds_and_owned_snapshots(self):
        for args in ((None, "turn-a"), ("thread-a", None), ("bad thread", "turn-a"),
                     (None, None, (1,)), ("thread-a", "turn-a", (True,)),
                     ("thread-a", "turn-a", (1,1)), ("thread-a", "turn-a", tuple(range(13)))):
            with self.assertRaises(idle.IdleError): idle.EpochIdleValidator(*args)
        seeds = [1]; v = idle.EpochIdleValidator("thread-a", "turn-a", seeds)
        seeds.append(2)
        self.assert_poisoned(v, resolved(2))
        v = validator(); result = v.observe(request()); result["requestId"] = 1
        state = v.state(); state["pendingResponses"] = 0
        self.assertFalse(v.idle_clear(empty_rpc()))


if __name__ == "__main__": unittest.main()
