"""Synthetic preparation tests only; no genuine preflight, probes or process launch.
Linux cases require root's optional-timeout NativeRpc successor before execution.
The fake Popen port uses anonymous pipes and one bounded local thread only.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import types
import unittest

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("native_canary_fixture", ROOT / "rm-0032-native-canary-client.py")
client = importlib.util.module_from_spec(spec); spec.loader.exec_module(client)
PUBLIC_ROOT = ROOT
NAMES = {"custody": "rm-0032-managed-custody-client.py", "canary": "rm-0032-astra-canary-client.py", "engine": "rm-0032-native-conversation.py", "rpc": "rm-0032-native-rpc.py"}
CONFIG = {"root": "/run/decadans-native-canary-fixture", "cwd": "/run/decadans-native-canary-fixture/workspace", "profile": "decadans-native-canary-fixture"}


def sources(): return {name: (PUBLIC_ROOT / filename).read_text(encoding="utf-8") for name, filename in NAMES.items()}


class PortableTests(unittest.TestCase):
    def test_marker_not_in_either_prompt_instructions_or_spec(self):
        self.assertNotIn(client.MARKER, client.INSTRUCTIONS)
        for prompt in client.PROMPTS: self.assertNotIn(client.MARKER, prompt)
        self.assertNotIn(client.MARKER, json.dumps(client.TOOL_SPEC))

    def test_all_sources_and_config_checked_before_injected_ports(self):
        called = []
        ports = {name: lambda *args, **kwargs: called.append(True) for name in ("clock", "popen", "preflight", "relay_reachable")}
        for name in NAMES:
            bundle = sources(); bundle[name] += "\n# changed public source\n"
            value = client.run(bundle, CONFIG, ports)
            self.assertEqual(value["code"], "SOURCE_REFUSED"); self.assertEqual(called, [])
        bad = dict(CONFIG, root="/tmp/outside")
        self.assertEqual(client.run(sources(), bad, ports)["code"], "CONFIG_REFUSED"); self.assertEqual(called, [])

    def test_aggregate_deadline_covers_initialize_notification_and_later_turn(self):
        calls, at = [], [124.75]
        class Raw:
            def initialized(self, seconds): calls.append(("initialized", seconds))
            def exchange(self, method, params, seconds): calls.append((method, seconds)); return {}, None
            def next_frame(self, seconds): calls.append(("next", seconds)); return {"method": "event"}
            def respond(self, request_id, result, seconds): calls.append(("respond", seconds))
        counters = client.result_template()["native"]
        rpc = client.DeadlineRpc(Raw(), 125, lambda: at[0], counters)
        rpc.initialized(); rpc.exchange("turn/start", {}, 20); rpc.next_frame(30); rpc.respond(2**63 - 1, {}, 30)
        self.assertTrue(all(seconds == .25 for _, seconds in calls)); at[0] = 125
        with self.assertRaises(client.Stop): rpc.exchange("turn/start", {}, 20)
        self.assertEqual(counters["turnStartDispatches"], 1)

    def test_normalizer_refuses_raw_output_and_false_settlement(self):
        value = client.result_template(); value["rawAnswer"] = "PRIVATE invented content"
        with self.assertRaises(ValueError): client.normalize_result(value)
        forged = client.result_template(); forged.update(outcome="observed", code="OK", stage="complete")
        with self.assertRaises(ValueError): client.normalize_result(forged)

    def test_constructor_refusal_retains_fixed_cause_before_unconfirmed_cleanup(self):
        proc = types.SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO(), wait=lambda **_: 0, poll=lambda: 0)
        value = client.run(sources(), CONFIG, {"clock": lambda: 0, "popen": lambda *a, **k: proc,
            "preflight": lambda *a: None, "relay_reachable": lambda: True})
        d = value["diagnostics"]
        self.assertEqual(d["originalCode"], "CONFIG_REFUSED"); self.assertEqual(d["rpcCode"], "CONFIG_REFUSED")
        self.assertEqual(d["rpcPhase"], "not_created"); self.assertTrue(d["cleanupUnknown"])
        self.assertEqual(value["native"]["threadStartDispatches"], 0)

    def test_observed_receipt_requires_probe_exit_evidence_not_only_boolean_claims(self):
        value = client.result_template(); value.update(outcome="observed", code="OK", stage="complete")
        value["diagnostics"].update(originalCode="OK", originalStage="complete")
        for key in ("initialize", "profile", "controlsPassed", "relayAfter", "accountChatgpt", "astraMedium"): value["custody"][key] = True
        value["custody"]["probePass"] = [True] * 9
        value["native"].update(admitted=True, threadAcknowledged=True, threadStartDispatches=1, turnStartDispatches=2)
        for index, turn in enumerate(value["native"]["turns"]): turn.update(attempted=True, completed=True, answerExact=True, answerBytes=len(client.MARKER.encode()), toolCallbacks=1-index, toolCalls=1-index, code="OK")
        value["appServer"].update(launched=True, stdinClosed=True, stdoutEof=True, reaped=True, exitCode=0, stderrComplete=True)
        with self.assertRaises(ValueError): client.normalize_result(value)
        value["custody"]["probeExitCodes"] = [0, 20, 20, 22, 22, 20, 40, 30, 61]
        self.assertEqual(client.normalize_result(value)["outcome"], "observed")
        value["custody"]["probeExitCodes"][0] = 20
        with self.assertRaises(ValueError): client.normalize_result(value)


class FakeProcess:
    def __init__(self, test, base, mode, advance):
        self.test, self.base, self.mode, self.advance = test, base, mode, advance
        self.pid, self.turns, self.threads, self.commands = 4242, 0, 0, 0
        self.marker, self.done, self.errors, self.waits = None, False, [], []
        self.last_arguments = {"fromDate": 1, "toDate": 200, "cursor": None}
        ir, iw = os.pipe(); out_r, out_w = os.pipe(); err_r, err_w = os.pipe()
        self.stdin, self.stdout, self.stderr = io.FileIO(iw, "wb"), io.FileIO(out_r, "rb"), io.FileIO(err_r, "rb")
        self.server_in, self.server_out, self.server_err = io.FileIO(ir, "rb"), io.FileIO(out_w, "wb"), io.FileIO(err_w, "wb")
        self.thread = threading.Thread(target=self.serve, daemon=True); self.thread.start()

    def send(self, frame):
        if self.mode == "timestamped" and "method" in frame and "id" not in frame:
            frame = dict(frame, emittedAtMs=123456789)
        data = json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"; offset = 0
        while offset < len(data): offset += os.write(self.server_out.fileno(), data[offset:])

    def complete(self, tool=None):
        text = "PRIVATE wrong answer" if self.mode == "wrong-answer" else self.marker or client.MARKER
        items = [] if tool is None else [tool]
        items.append({"id": "answer-" + str(self.turns), "type": "agentMessage", "phase": "final_answer", "text": text})
        if self.mode == "deadline" and self.turns == 1: self.advance(126)
        if self.mode == "timestamped":
            for item in items: self.send({"method": "item/completed", "params": {"threadId": "synthetic-thread", "turnId": "turn-" + str(self.turns), "completedAtMs": 123456789, "item": item}})
        self.send({"method": "turn/completed", "params": {"threadId": "synthetic-thread", "turn": {"id": "turn-" + str(self.turns), "status": "failed" if self.mode == "failed-turn" else "completed", "items": items}}})

    def serve(self):
        try:
            while True:
                line = self.server_in.readline(3 * 1024 * 1024 + 1)
                if not line: break
                frame = json.loads(line)
                if "method" not in frame:
                    result = frame["result"]
                    if result["success"]: self.marker = json.loads(result["contentItems"][0]["text"])["marker"]
                    tool = {"id": "call-" + str(self.turns), "type": "dynamicToolCall", "tool": "neurobro_read_history", "arguments": self.last_arguments, "status": "completed", **result}
                    self.complete(tool); continue
                method, params = frame["method"], frame.get("params", {})
                if method == "initialized":
                    if self.mode in {"remote-disabled", "remote-connected"}: self.send({"method": "remoteControl/status/changed", "params": {"installationId": "PRIVATE installation", "serverName": "PRIVATE server", "status": "disabled" if self.mode == "remote-disabled" else "connected", "environmentId": None}})
                    if self.mode == "global-metadata": self.send({"method": "skills/changed", "params": {}})
                    if self.mode == "timestamped": self.send({"method": "configWarning", "params": {"summary": "Synthetic configuration warning"}})
                    if self.mode == "extra-init-envelope": self.send({"method": "configWarning", "params": {"message": "PRIVATE value"}, "_meta": {"PRIVATE key": "PRIVATE value"}})
                    continue
                if method == "initialize" and self.mode == "bad-init-json":
                    os.write(self.server_out.fileno(), b'{"id":"PRIVATE invalid",broken-json}\n'); continue
                if method == "initialize" and self.mode == "bad-init-id":
                    self.send({"id": "PRIVATE wrong id", "result": {}}); continue
                if method == "initialize" and self.mode == "bad-init-fields":
                    self.send({"id": frame["id"], "result": {"platformOs": "PRIVATE invalid"}}); continue
                if method == "initialize": result = {"platformOs": "linux", "platformFamily": "unix", "codexHome": self.base.AUTH_HOME, "userAgent": self.base.CLIENT + "/0.153.4 (synthetic)"}
                elif method == "permissionProfile/list": result = {"data": [{"id": CONFIG["profile"], "allowed": True}], "nextCursor": None}
                elif method == "command/exec":
                    name = self.base.base_result()["probes"][self.commands]["name"]; self.commands += 1
                    result = {"exitCode": sorted(self.base.pass_codes(name))[0], "stdout": "", "stderr": ""}
                elif method == "account/read": result = {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": False}
                elif method == "model/list": result = {"data": [{"model": "gpt-6-astra", "hidden": False, "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]}], "nextCursor": None}
                elif method == "thread/start":
                    if self.mode == "global-metadata": self.send({"method": "app/list/updated", "params": {"data": [{"id": "PRIVATE app", "name": "PRIVATE name", "isEnabled": False}]}})
                    if self.mode == "observer-failure":
                        self.send({"method": "configWarning", "params": {"summary": "PRIVATE warning"}})
                        self.send({"method": "thread/started", "params": {"thread": {"id": "PRIVATE mismatch", "ephemeral": True}}})
                    self.threads += 1; self.test.assertEqual(self.commands, 9)
                    self.test.assertEqual(params["model"], "gpt-6-astra"); self.test.assertEqual(params["config"]["model_reasoning_effort"], "medium")
                    self.test.assertNotIn(client.MARKER, params["baseInstructions"]); self.test.assertNotIn(client.MARKER, params["developerInstructions"])
                    self.test.assertEqual(params["dynamicTools"], [client.TOOL_SPEC])
                    result = {"thread": {"id": "synthetic-thread", "ephemeral": True}, "model": "gpt-6-astra", "modelProvider": "openai", "reasoningEffort": "medium", "cwd": CONFIG["cwd"], "approvalPolicy": "never", "approvalsReviewer": "user", "activePermissionProfile": {"id": CONFIG["profile"]}}
                elif method == "turn/start":
                    self.turns += 1; self.test.assertEqual(params["threadId"], "synthetic-thread"); self.test.assertEqual(params["input"][0]["text"], client.PROMPTS[self.turns - 1])
                    self.test.assertNotIn(client.MARKER, params["input"][0]["text"])
                    self.send({"id": frame["id"], "result": {"turn": {"id": "turn-" + str(self.turns), "status": "inProgress", "items": []}}})
                    if self.mode == "global-metadata": self.send({"method": "mcpServer/startupStatus/updated", "params": {"name": "PRIVATE mcp", "status": "ready", "threadId": "synthetic-thread"}})
                    if (self.turns == 1 and self.mode != "missing-tool") or self.mode in {"second-tool", "refused-second-tool"}:
                        self.last_arguments = {"fromDate": "invalid" if self.turns == 2 and self.mode == "refused-second-tool" else 1, "toDate": 200, "cursor": None}
                        self.send({"id": 2**63 - self.turns, "method": "item/tool/call", "params": {"threadId": "synthetic-thread", "turnId": "turn-" + str(self.turns), "callId": "call-" + str(self.turns), "tool": "neurobro_read_history", "arguments": self.last_arguments}})
                    else: self.complete()
                    continue
                else: self.test.fail("unexpected fixture method")
                self.send({"id": frame["id"], "result": result})
        except (BrokenPipeError, OSError): pass
        except BaseException as error: self.errors.append(type(error).__name__)
        finally:
            if self.mode == "stderr": self.server_err.write(b"x" * 65537)
            self.server_out.close(); self.server_err.close(); self.server_in.close(); self.done = True

    def wait(self, timeout):
        self.waits.append(timeout); self.thread.join(timeout)
        if self.thread.is_alive() or self.mode == "not-reaped": raise subprocess.TimeoutExpired("synthetic-fixture", timeout)
        return 0
    def poll(self): return 0 if self.done and self.mode != "not-reaped" else None


@unittest.skipUnless(sys.platform == "linux", "Real anonymous-pipe NativeRpc requires Linux; no genuine process launch")
class ConnectedTests(unittest.TestCase):
    def fixture(self, mode="ok", relay_after=True):
        bundle, made, clock = sources(), [], [0.0]
        modules = client.load_sources(bundle, CONFIG); base = modules["custody"]
        def preflight(b, custody):
            self.assertEqual(b.CODEX_SHA256, base.CODEX_SHA256)
            for name in custody["controls"]: custody["controls"][name] = name != "relayAfter"
        def popen(argv, **kwargs):
            self.assertEqual(argv, modules["canary"].launch_argv(base)); self.assertEqual(kwargs["env"], base.app_server_env())
            self.assertEqual(kwargs["cwd"], CONFIG["cwd"]); self.assertIs(kwargs["close_fds"], True); self.assertEqual(kwargs["bufsize"], 0)
            proc = FakeProcess(self, base, mode, lambda value: clock.__setitem__(0, value)); made.append(proc); return proc
        value = client.run(bundle, CONFIG, {"clock": lambda: clock[0], "popen": popen, "preflight": preflight, "relay_reachable": lambda: relay_after})
        for proc in made:
            proc.thread.join(1); self.assertFalse(proc.thread.is_alive()); self.assertEqual(proc.errors, [])
            proc.stderr.close(); self.assertTrue(all(0 < timeout <= 35 for timeout in proc.waits))
        self.assertNotIn(client.MARKER, json.dumps(value)); self.assertNotIn("PRIVATE wrong", json.dumps(value)); self.assertNotIn("synthetic-thread", json.dumps(value))
        return value, made

    def test_one_thread_two_turns_one_tool_marker_only_and_natural_pipe_process_cleanup(self):
        result, made = self.fixture(); self.assertEqual(result["outcome"], "observed"); self.assertTrue(result["injectedPorts"])
        self.assertEqual(len(made), 1); self.assertEqual(made[0].threads, 1); self.assertEqual(made[0].turns, 2)
        self.assertEqual([t["toolCallbacks"] for t in result["native"]["turns"]], [1, 0])
        self.assertTrue(result["appServer"]["stdoutEof"]); self.assertTrue(result["appServer"]["reaped"])

    def test_initial_refusal_survives_natural_cleanup_without_model_dispatch(self):
        for mode, rpc_code, site, custody_code in (("bad-init-json", "PROTOCOL_REFUSED", "json", "NOT_RUN"),
                ("bad-init-id", "PROTOCOL_REFUSED", "response_id", "NOT_RUN"),
                ("bad-init-fields", "OK", "none", "PROTOCOL_REFUSED")):
            result, made = self.fixture(mode)
            d = result["diagnostics"]
            self.assertFalse(d["cleanupUnknown"]); self.assertEqual(d["originalStage"], "custody")
            self.assertEqual(d["custodyStage"], "initialize"); self.assertEqual(d["custodyCode"], custody_code)
            self.assertEqual(d["rpcCode"], rpc_code); self.assertEqual(d["rpcSite"], site)
            self.assertEqual(result["code"], d["originalCode"]); self.assertNotEqual(result["code"], "SHUTDOWN_UNKNOWN")
            self.assertGreater(d["bytesRead"], 0); self.assertGreater(d["bytesWritten"], 0)
            self.assertTrue(result["appServer"]["reaped"]); self.assertEqual(result["appServer"]["exitCode"], 0)
            self.assertFalse(result["custody"]["initialize"]); self.assertFalse(result["native"]["admitted"])
            self.assertEqual(made[0].commands, 0); self.assertEqual(made[0].threads, 0); self.assertEqual(made[0].turns, 0)
            self.assertNotIn("PRIVATE", json.dumps(result))

    def test_extra_initial_envelope_preserves_only_fixed_shape(self):
        value, made = self.fixture("extra-init-envelope")
        d = value["diagnostics"]
        self.assertEqual(d["rpcSite"], "envelope"); self.assertEqual(d["rpcEnvelopeType"], "object")
        self.assertEqual(d["rpcEnvelopeKeys"], (1 << 1) | (1 << 2) | (1 << 7))
        self.assertEqual(d["rpcEnvelopeMethod"], "configWarning"); self.assertEqual(d["rpcEnvelopeIdType"], "absent")
        self.assertEqual(d["rpcEnvelopeParamsType"], "object"); self.assertFalse(d["cleanupUnknown"])
        self.assertTrue(value["custody"]["initialize"]); self.assertEqual(made[0].turns, 0)
        self.assertNotIn("PRIVATE", json.dumps(value))
        d["rpcEnvelopeMethod"] = "PRIVATE arbitrary method"
        with self.assertRaises(ValueError): client.normalize_result(value)

    def test_timestamped_config_tool_and_final_notifications_survive_native_pipeline(self):
        value, made = self.fixture("timestamped")
        self.assertEqual(value["outcome"], "observed", json.dumps(value, sort_keys=True)); self.assertEqual(made[0].threads, 1); self.assertEqual(made[0].turns, 2)
        self.assertEqual([t["toolCallbacks"] for t in value["native"]["turns"]], [1, 0])
        self.assertTrue(all(t["completed"] and t["answerExact"] for t in value["native"]["turns"]))
        self.assertFalse(value["diagnostics"]["cleanupUnknown"]); self.assertEqual(value["diagnostics"]["rpcCode"], "OK")

    def test_pinned_observer_failure_reaches_final_receipt_without_payload(self):
        value, made = self.fixture("observer-failure")
        turn = value["native"]["turns"][0]
        self.assertEqual(turn["events"], 2); self.assertEqual(turn["code"], "PROTOCOL_REFUSED")
        self.assertEqual(turn["observer"]["site"], "thread_event"); self.assertEqual(turn["observer"]["method"], "thread/started")
        self.assertEqual(turn["toolCallbacks"], 0); self.assertEqual(made[0].turns, 1)
        self.assertFalse(value["diagnostics"]["cleanupUnknown"]); self.assertNotIn("PRIVATE", json.dumps(value))
        turn["observer"]["method"] = "PRIVATE forged method"
        with self.assertRaises(ValueError): client.normalize_result(value)

    def test_global_metadata_before_and_after_ack_preserves_native_tool_memory(self):
        value, made = self.fixture("global-metadata")
        self.assertEqual(value["outcome"], "observed", json.dumps(value, sort_keys=True))
        self.assertEqual(made[0].threads, 1); self.assertEqual(made[0].turns, 2)
        self.assertEqual([x["toolCallbacks"] for x in value["native"]["turns"]], [1, 0])
        self.assertTrue(all(x["completed"] and x["answerExact"] for x in value["native"]["turns"]))
        self.assertNotIn("PRIVATE", json.dumps(value)); self.assertFalse(value["diagnostics"]["cleanupUnknown"])

    def test_initial_remote_disabled_allows_one_tool_and_two_native_answers(self):
        value, made = self.fixture("remote-disabled")
        self.assertEqual(value["outcome"], "observed", json.dumps(value, sort_keys=True))
        self.assertEqual(made[0].threads, 1); self.assertEqual(made[0].turns, 2)
        self.assertEqual([x["toolCallbacks"] for x in value["native"]["turns"]], [1, 0])
        self.assertEqual(value["native"]["turns"][0]["observer"]["remoteControlStatus"], "disabled")
        self.assertNotIn("PRIVATE", json.dumps(value)); self.assertFalse(value["diagnostics"]["cleanupUnknown"])
        value, _ = self.fixture("remote-connected")
        turn = value["native"]["turns"][0]
        self.assertEqual(turn["code"], "CUSTODY_REFUSED"); self.assertEqual(turn["toolCallbacks"], 0)
        self.assertEqual(turn["observer"]["remoteControlStatus"], "connected")
        turn["observer"]["remoteControlStatus"] = "PRIVATE status"
        with self.assertRaises(ValueError): client.normalize_result(value)

    def test_wrong_or_missing_tool_answer_stops_before_second_turn(self):
        for mode in ("wrong-answer", "missing-tool"):
            result, made = self.fixture(mode); self.assertEqual(result["code"], "FIRST_TURN_REFUSED"); self.assertEqual(made[0].turns, 1)

    def test_second_turn_tool_is_not_accepted_as_memory(self):
        result, _ = self.fixture("second-tool"); self.assertNotEqual(result["outcome"], "observed"); self.assertEqual(result["native"]["turns"][1]["toolCallbacks"], 1)
        result, _ = self.fixture("refused-second-tool"); self.assertEqual(result["code"], "SECOND_TURN_REFUSED")
        self.assertEqual(result["native"]["turns"][1]["toolCallbacks"], 0); self.assertEqual(result["native"]["turns"][1]["toolRefusals"], 1)

    def test_failed_completed_notification_preserves_unknown_engine_diagnostics(self):
        result, _ = self.fixture("failed-turn"); self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(result["native"]["turns"][0]["code"], "TURN_REFUSED"); self.assertEqual(result["native"]["turns"][0]["failureSite"], "turn")
        self.assertTrue(result["native"]["turns"][0]["sessionPoisoned"])

    def test_shared_work_deadline_prevents_fresh_second_turn_allowance(self):
        result, made = self.fixture("deadline"); self.assertNotEqual(result["outcome"], "observed"); self.assertEqual(made[0].turns, 1)

    def test_eof_without_process_reap_and_after_control_failure_never_observed(self):
        result, _ = self.fixture("not-reaped"); self.assertTrue(result["appServer"]["stdoutEof"]); self.assertFalse(result["appServer"]["reaped"]); self.assertEqual(result["code"], "SHUTDOWN_UNKNOWN")
        self.assertTrue(result["diagnostics"]["cleanupUnknown"]); self.assertEqual(result["diagnostics"]["originalCode"], "OK")
        result, _ = self.fixture(relay_after=False); self.assertEqual(result["code"], "CONTROL_REFUSED")


if __name__ == "__main__": unittest.main()
