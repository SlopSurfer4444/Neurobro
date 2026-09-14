"""Offline fake-AppServer checks; optional argv is the frozen base source path."""
import copy
import ast
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).parent
BASE_PATH = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else HERE / "rm-0032-managed-custody-client.py"
BASE_SOURCE = BASE_PATH.read_bytes().decode("utf-8")
spec = importlib.util.spec_from_file_location("canary", HERE / "rm-0032-astra-canary-client.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def initialized(base):
    return {"platformOs": "linux", "platformFamily": "unix", "codexHome": base.AUTH_HOME,
            "userAgent": base.CLIENT + "/0.153.4 (linux)"}


def ready_custody(base):
    result = base.base_result()
    result["initialize"] = result["profile"] = True
    result["controls"] = dict.fromkeys(result["controls"], True)
    result["account"] = {"checked": True, "chatgpt": True}
    result["model"] = {"checked": True, "astraListedOnce": True, "mediumSupported": True, "pages": 1}
    for p in result["probes"]: p.update(attempted=True, exitCode=min(base.pass_codes(p["name"])), verdict="pass")
    return result


def start_thread():
    return {"thread": {"id": "thread-fixture", "ephemeral": True}, "model": c.MODEL,
            "modelProvider": "openai", "reasoningEffort": c.EFFORT,
            "activePermissionProfile": {"id": c.PROFILE}, "cwd": c.ALLOWED,
            "approvalPolicy": "never"}


def turn(status="inProgress", items=None):
    return {"id": "turn-fixture", "status": status, "items": [] if items is None else items, "error": None}


def agent(text=None):
    return {"id": "agent-fixture", "type": "agentMessage", "text": c.ANSWER if text is None else text}


def event(method, **params):
    return {"method": method, "params": params}


def completion_events(text=None):
    return [event("thread/started", thread={"id": "thread-fixture", "ephemeral": True}),
            event("turn/started", threadId="thread-fixture", turn=turn()),
            event("item/started", threadId="thread-fixture", turnId="turn-fixture", item=agent("")),
            event("item/agentMessage/delta", threadId="thread-fixture", turnId="turn-fixture", itemId="agent-fixture", delta=c.ANSWER if text is None else text),
            event("item/completed", threadId="thread-fixture", turnId="turn-fixture", item=agent(text)),
            event("turn/completed", threadId="thread-fixture", turn=turn("completed", [agent(text)]))]


def fake_process(frames):
    proc = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(b"".join(json.dumps(x).encode() + b"\n" for x in frames)), stderr=io.BytesIO())
    proc.pid = 456
    proc.poll.return_value = 0
    return proc


def model_rpc(base, frames, result):
    proc = fake_process(frames)
    rpc = c.rpc_class(base)(proc, time.monotonic() + .5, result["canary"], result["diagnostic"])
    return rpc, proc


class CanaryTests(unittest.TestCase):
    def setUp(self):
        self.base = c.load_base(BASE_SOURCE)
        self.result = c.base_result(self.base)
        proof = ready_custody(self.base)
        self.result["custody"] = {k: proof[k] for k in c.CUSTODY_KEYS}

    def test_source_binding_and_rebinding_without_mutating_frozen_source(self):
        self.assertEqual(self.base.ROOT, c.ROOT)
        self.assertEqual(self.base.ALLOWED, c.ALLOWED)
        self.assertEqual(self.base.PROFILE, c.PROFILE)
        self.assertEqual(self.base.AUTH_HOME, "/var/lib/decadans-neurobro-codex-auth-v1")
        self.assertIn("/run/decadans-managed-custody-20260910-v2", BASE_SOURCE)
        with self.assertRaises(ValueError): c.load_base(BASE_SOURCE + "\n")

    def test_fixed_one_turn_config_disables_environment_and_fallback(self):
        thread, turn_params = c.thread_params(), c.turn_params("thread-fixture")
        self.assertFalse(thread["allowProviderModelFallback"])
        self.assertTrue(thread["ephemeral"])
        self.assertEqual(thread["dynamicTools"], [])
        for params in (thread, turn_params):
            self.assertEqual(params["model"], "gpt-6-astra")
            self.assertEqual(params["environments"], [])
            self.assertEqual(params["permissions"], c.PROFILE)
            self.assertEqual(params["approvalPolicy"], "never")
            self.assertNotIn("sandboxPolicy", params)
        self.assertEqual(turn_params["effort"], "medium")
        self.assertEqual(turn_params["input"], [{"type": "text", "text": c.PROMPT, "text_elements": []}])
        self.assertEqual(c.PROMPT, "Return exactly the text inside <answer> tags, without tags or any other characters: <answer>NEUROBRO_ASTRA_READY.</answer>")
        argv = c.launch_argv(self.base)
        self.assertIn("features.shell_tool=false", argv)
        self.assertIn("web_search='disabled'", argv)
        self.assertIn("agents.enabled=false", argv)
        self.assertFalse(any("model_providers" in x for x in argv))

    def test_completion_before_turn_response_is_preserved(self):
        frames = [{"id": 1, "result": start_thread()}] + completion_events() + [{"id": 2, "result": {"turn": turn()}}]
        rpc, proc = model_rpc(self.base, frames, self.result)
        c.model_protocol(rpc, self.result)
        self.assertTrue(self.result["canary"]["turnCompleted"])
        self.assertTrue(self.result["canary"]["answerExact"])
        self.assertEqual(self.result["canary"]["answerBytes"], len(c.ANSWER))
        sent = [json.loads(x) for x in proc.stdin.getvalue().splitlines()]
        self.assertEqual([x["method"] for x in sent], ["thread/start", "turn/start"])
        self.assertEqual(len(rpc.notifications), 0)

    def test_failed_custody_prevents_thread_request(self):
        self.result["custody"]["probes"][0]["verdict"] = "refused"
        rpc, proc = model_rpc(self.base, [], self.result)
        with self.assertRaises(c.Stop) as error: c.model_protocol(rpc, self.result)
        self.assertEqual(error.exception.code, "CUSTODY_REFUSED")
        self.assertEqual(proc.stdin.getvalue(), b"")

    def test_model_effort_profile_or_ephemeral_mismatch_prevents_turn(self):
        for key, wrong in (("model", "gpt-5.6-sol"), ("reasoningEffort", "high"), ("activePermissionProfile", {"id": "broad"}), ("thread", {"id": "thread-fixture", "ephemeral": False})):
            result = copy.deepcopy(self.result)
            reply = start_thread()
            reply[key] = wrong
            rpc, proc = model_rpc(self.base, [{"id": 1, "result": reply}], result)
            with self.assertRaises(c.Stop): c.model_protocol(rpc, result)
            self.assertNotIn(b'"turn/start"', proc.stdin.getvalue())

    def test_server_tool_request_never_approved(self):
        frames = [{"id": 1, "result": start_thread()}, {"id": "approval-fixture", "method": "item/commandExecution/requestApproval", "params": {"secret": "private fixture"}}]
        rpc, proc = model_rpc(self.base, frames, self.result)
        with self.assertRaises(c.Stop) as error: c.model_protocol(rpc, self.result)
        self.assertEqual(error.exception.code, "TOOL_REQUEST_REFUSED")
        self.assertEqual(self.result["canary"]["serverRequests"], 1)
        self.assertNotIn(b"approval-fixture", proc.stdin.getvalue())
        self.assertNotIn("private fixture", json.dumps(c.normalize_result(self.result, BASE_SOURCE)))

    def test_tool_notification_and_wrong_turn_refused(self):
        for item in ({"id": "tool", "type": "commandExecution", "command": "private"}, {"id": "tool", "type": "collabAgentToolCall"}):
            result = copy.deepcopy(self.result)
            frames = [{"id": 1, "result": start_thread()}, {"id": 2, "result": {"turn": turn()}}, event("item/started", threadId="thread-fixture", turnId="turn-fixture", item=item)]
            rpc, _ = model_rpc(self.base, frames, result)
            with self.assertRaises(c.Stop) as error: c.model_protocol(rpc, result)
            self.assertEqual(error.exception.code, "TOOL_EVENT_REFUSED")
            self.assertEqual(result["canary"]["toolEvents"], 1)
        observer = c.Observer(self.result["canary"], "thread-fixture", "turn-fixture")
        with self.assertRaises(c.Stop): observer.event(event("turn/completed", threadId="other-thread", turn=turn("completed", [agent()])))

    def test_answer_mismatch_overflow_and_duplicate_agent_refused(self):
        for text, expected in (("wrong private fixture", "ANSWER_REFUSED"), ("x" * 257, "BOUNDS_REFUSED")):
            result = copy.deepcopy(self.result)
            frames = [{"id": 1, "result": start_thread()}, {"id": 2, "result": {"turn": turn()}}] + completion_events(text)
            rpc, _ = model_rpc(self.base, frames, result)
            with self.assertRaises(c.Stop) as error: c.model_protocol(rpc, result)
            self.assertEqual(error.exception.code, expected)
            self.assertNotIn(text, json.dumps(c.normalize_result(result, BASE_SOURCE)))
        observer = c.Observer(self.result["canary"], "thread-fixture", "turn-fixture")
        observer.item(agent(), True)
        second = agent()
        second["id"] = "another-agent-message"
        with self.assertRaises(c.Stop): observer.item(second, True)

    def test_unknown_turn_request_cannot_be_retried(self):
        rpc, proc = model_rpc(self.base, [{"id": 1, "result": start_thread()}], self.result)
        with self.assertRaises(c.Stop): c.model_protocol(rpc, self.result)
        with self.assertRaises(c.Stop): rpc.exchange("turn/start", c.turn_params("thread-fixture"))
        self.assertEqual(proc.stdin.getvalue().count(b'"turn/start"'), 1)

    def test_strict_metadata_refuses_raw_fields_and_forged_success(self):
        for group in (None, "canary", "custody", "limits", "diagnostic"):
            result = copy.deepcopy(self.result)
            (result if group is None else result[group])["raw"] = "private"
            with self.assertRaises(ValueError): c.normalize_result(result, BASE_SOURCE)
        result = copy.deepcopy(self.result)
        result.update(outcome="observed", stage="complete", code="OK")
        with self.assertRaises(ValueError): c.normalize_result(result, BASE_SOURCE)
        self.assertFalse(self.result["limits"]["transportRetriesDisabled"])

    def test_exact_schema_thread_metadata_and_global_warnings_are_handled(self):
        observer = c.Observer(self.result["canary"], "thread-fixture", "turn-fixture", self.result["diagnostic"])
        settings = {"model": c.MODEL, "modelProvider": "openai", "effort": c.EFFORT, "cwd": c.ALLOWED,
                    "approvalPolicy": "never", "approvalsReviewer": "user", "activePermissionProfile": {"id": c.PROFILE}}
        frames = [event("thread/queue/changed", threadId="thread-fixture"),
                  event("thread/settings/updated", threadId="thread-fixture", threadSettings=settings),
                  event("configWarning", summary="private warning content", details="private details", path="private path"),
                  event("deprecationNotice", summary="private notice", details=None),
                  event("warning", message="private message", threadId=None),
                  event("account/updated", authMode="chatgpt", planType="pro"),
                  event("thread/status/changed", threadId="thread-fixture", status={"type": "active", "activeFlags": []})]
        for frame in frames: observer.event(frame)
        counts = self.result["diagnostic"]["metadataCounts"]
        for key in ("queue", "settings", "configWarning", "deprecationNotice", "warning", "account"):
            self.assertEqual(counts[key], 1)
        encoded = json.dumps(c.normalize_result(self.result, BASE_SOURCE))
        self.assertNotIn("private", encoded)
        self.assertNotIn("thread-fixture", encoded)

    def test_metadata_id_and_selected_settings_boundaries_remain_strict(self):
        observer = c.Observer(self.result["canary"], "thread-fixture", "turn-fixture", self.result["diagnostic"])
        for frame in (event("thread/queue/changed", threadId="other-thread"),
                      event("warning", message="private", threadId="other-thread"),
                      event("thread/settings/updated", threadId="thread-fixture", threadSettings={"model": "gpt-5.6-sol"}),
                      event("account/updated", authMode="apikey")):
            with self.assertRaises(c.Stop): observer.event(frame)
        with self.assertRaises(c.Stop) as caught:
            observer.event(event("thread/queue/changed"))
        self.assertEqual(caught.exception.site, "thread_id")
        self.assertEqual(self.result["diagnostic"]["method"], "thread/queue/changed")
        self.assertFalse(self.result["diagnostic"]["shape"]["threadIdPresent"])

    def test_protocol_failure_sites_cover_every_explicit_protocol_raise(self):
        tree = ast.parse((HERE / "rm-0032-astra-canary-client.py").read_text(encoding="utf-8"))
        count = 0
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Stop" and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == "PROTOCOL_REFUSED":
                sites = [k.value.value for k in node.keywords if k.arg == "site" and isinstance(k.value, ast.Constant)]
                self.assertEqual(len(sites), 1)
                self.assertIn(sites[0], c.FAILURE_SITES - {"none"})
                count += 1
        self.assertGreater(count, 25)

    def test_fixed_error_projection_preserves_quota_auth_http_not_message(self):
        cases = [("usageLimitExceeded", "quota", None), ("unauthorized", "auth", None),
                 ({"httpConnectionFailed": {"httpStatusCode": 429}}, "rate_limit", 429),
                 ({"responseTooManyFailedAttempts": {"httpStatusCode": 503}}, "provider", 503),
                 ({"responseStreamConnectionFailed": {"httpStatusCode": None}}, "network", None)]
        for info, category, status in cases:
            diagnostic = c.diagnostic_result()
            observer = c.Observer(self.result["canary"], "thread-fixture", "turn-fixture", diagnostic)
            with self.assertRaises(c.Stop) as caught:
                observer.event(event("error", threadId="thread-fixture", turnId="turn-fixture", willRetry=False,
                                     error={"message": "private failure content", "codexErrorInfo": info, "additionalDetails": "private"}))
            self.assertEqual(caught.exception.code, "TURN_REFUSED")
            self.assertEqual(diagnostic["providerError"]["category"], category)
            self.assertEqual(diagnostic["providerError"]["httpStatus"], status)
            self.assertNotIn("private", json.dumps(diagnostic))

    def test_runtime_error_notice_does_not_authorize_client_retry(self):
        observer = c.Observer(self.result["canary"], "thread-fixture", "turn-fixture", self.result["diagnostic"])
        observer.event(event("error", threadId="thread-fixture", turnId="turn-fixture", willRetry=True,
                             error={"message": "private", "codexErrorInfo": {"responseStreamDisconnected": {"httpStatusCode": None}}}))
        self.assertEqual(self.result["diagnostic"]["metadataCounts"]["retryNotice"], 1)
        self.assertTrue(self.result["diagnostic"]["providerError"]["willRetry"])
        with self.assertRaises(c.Stop): observer.event(event("model/rerouted", threadId="thread-fixture", turnId="turn-fixture", fromModel=c.MODEL, toModel="gpt-5.6-sol", reason="unavailable"))

    def test_metadata_can_arrive_before_turn_rpc_response_without_turn_id(self):
        warning = event("configWarning", summary="private warning")
        queue = event("thread/queue/changed", threadId="thread-fixture")
        frames = [{"id": 1, "result": start_thread()}, warning, queue] + completion_events() + [{"id": 2, "result": {"turn": turn()}}]
        rpc, _ = model_rpc(self.base, frames, self.result)
        c.model_protocol(rpc, self.result)
        self.assertTrue(self.result["canary"]["turnCompleted"])
        self.assertEqual(self.result["diagnostic"]["metadataCounts"]["configWarning"], 1)
        self.assertEqual(self.result["diagnostic"]["metadataCounts"]["queue"], 1)

    def test_whole_fake_appserver_custody_then_one_model_turn(self):
        frames = [{"id": 1, "result": initialized(self.base)},
                  {"id": 2, "result": {"data": [{"id": c.PROFILE, "allowed": True}]}}]
        frames += [{"id": i + 3, "result": {"exitCode": min(self.base.pass_codes(name)), "stdout": "", "stderr": ""}} for i, name in enumerate(self.base.PROBES)]
        frames += [{"id": 12, "result": {"requiresOpenaiAuth": True, "account": {"type": "chatgpt", "email": "private@example.invalid"}}},
                   {"id": 13, "result": {"data": [{"model": c.MODEL, "hidden": False, "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]}]}},
                   {"id": 14, "result": start_thread()}] + completion_events() + [{"id": 15, "result": {"turn": turn()}}]
        proc = fake_process(frames)
        def preflight(result): result["controls"] = dict.fromkeys(result["controls"], True)
        with mock.patch.object(c, "load_base", return_value=self.base), mock.patch.object(self.base, "preflight", side_effect=preflight), mock.patch.object(self.base, "relay_reachable", return_value=True), mock.patch.object(c.subprocess, "Popen", return_value=proc):
            result = c.run(BASE_SOURCE)
        self.assertEqual((result["outcome"], result["code"]), ("observed", "OK"))
        self.assertTrue(result["appServer"]["reaped"])
        self.assertEqual(result["canary"]["events"], 6)
        encoded = json.dumps(result)
        for text in ("private@example", "thread-fixture", "turn-fixture", c.ANSWER): self.assertNotIn(text, encoded)
        proc.terminate.assert_not_called()
        proc.kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
