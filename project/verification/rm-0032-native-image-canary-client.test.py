"""Invented public PNG, fake custody replies, anonymous pipes; never a real launch."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("image_canary", ROOT / "rm-0032-native-image-canary-client.py")
client = importlib.util.module_from_spec(spec); spec.loader.exec_module(client)
NAMES = {"custody": "rm-0032-managed-custody-client.py", "canary": "rm-0032-astra-canary-client.py", "native": "rm-0032-native-conversation.py",
         "rpc": "rm-0032-native-rpc.py", "collector": "rm-0032-native-image-collector.py", "imageConversation": "rm-0032-native-image-conversation.py"}
CONFIG = {"root": "/run/decadans-image-fixture", "cwd": "/run/decadans-image-fixture/workspace", "profile": "decadans-image-fixture", "requestRef": client.REQUEST_REF}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")
CAPTION = "An invented friendly robot."

def sources(): return {key: (ROOT / name).read_text(encoding="utf-8") for key, name in NAMES.items()}


class PortableTests(unittest.TestCase):
    def test_all_sources_and_fixed_config_before_any_port(self):
        called = []
        ports = {name: lambda *a, **k: called.append(True) for name in ("clock", "popen", "preflight", "relay_reachable")}
        for name in NAMES:
            bundle = sources(); bundle[name] += "\n# changed\n"
            self.assertEqual(client.run(bundle, CONFIG, ports)["code"], "SOURCE_REFUSED")
        for key, value in (("root", "/tmp/other"), ("requestRef", "different-request")):
            self.assertEqual(client.run(sources(), dict(CONFIG, **{key: value}), ports)["code"], "CONFIG_REFUSED")
        self.assertEqual(called, [])

    def test_only_image_feature_changes_and_one_model_turn(self):
        m = client.load_sources(sources(), CONFIG)
        original = m["canary"].launch_argv(m["custody"])
        actual = client.image_launch_argv(m["canary"], m["custody"])
        changes = [(a, b) for a, b in zip(original, actual) if a != b]
        self.assertEqual(len(actual), len(original))
        self.assertEqual(changes, [("features.image_generation=false", "features.image_generation=true")])
        self.assertIn("features.shell_tool=false", actual)
        self.assertNotIn(CAPTION, client.PROMPT + client.INSTRUCTIONS)
        self.assertEqual(client.result_template()["limits"]["turnLimit"], 1)

    def test_aggregate_deadline_and_single_dispatch_fence(self):
        calls, at = [], [0.0]
        class Raw:
            def initialized(self, seconds): calls.append(seconds)
            def next_frame(self, seconds): calls.append(seconds); return {}
            def exchange(self, *args): calls.append(args[-1]); return {}, None
        rpc = client.DeadlineRpc(Raw(), 300, lambda: at[0], client.result_template()["native"])
        rpc.next_frame(300); at[0] = 299.5; rpc.initialized(); rpc.exchange("turn/start", {}, 20)
        self.assertEqual(calls, [300, .5, .5])
        with self.assertRaises(client.Stop): rpc.exchange("turn/start", {}, 20)
        at[0] = 300
        with self.assertRaises(client.Stop): rpc.next_frame(1)

    def test_failure_counters_saturate_without_losing_disposition(self):
        value = client.result_template()
        value["image"].update(client.project_image_metadata({"evidenceCount": 34, "imageLifecycleBytes": 44000000, "rawImageLifecycleBytes": 50331649}))
        normalized = client.normalize_result(value)
        self.assertEqual(normalized["image"]["evidenceCount"], 33)
        self.assertEqual(normalized["image"]["imageLifecycleBytes"], 33619973)
        self.assertEqual(normalized["image"]["rawImageLifecycleBytes"], 50331649)

    def test_strict_privacy_projection_and_no_forged_success(self):
        for field in ("rawImage", "caption", "path"):
            value = client.result_template(); value[field] = "PRIVATE invented"
            with self.assertRaises(ValueError): client.normalize_result(value)
        value = client.result_template(); value["image"]["sha256"] = "PRIVATE"
        with self.assertRaises(ValueError): client.normalize_result(value)
        value = client.result_template(); value.update(outcome="observed", code="OK", stage="complete")
        with self.assertRaises(ValueError): client.normalize_result(value)


class FakeProcess:
    def __init__(self, test, base, mode, advance):
        self.test, self.base, self.mode, self.advance = test, base, mode, advance
        self.pid, self.commands, self.threads, self.turns, self.caps = 4242, 0, 0, 0, 0
        self.done, self.errors, self.waits = False, [], []
        ir, iw = os.pipe(); rr, rw = os.pipe(); er, ew = os.pipe()
        self.stdin, self.stdout, self.stderr = io.FileIO(iw, "wb"), io.FileIO(rr, "rb"), io.FileIO(er, "rb")
        self.server_in, self.server_out, self.server_err = io.FileIO(ir, "rb"), io.FileIO(rw, "wb"), io.FileIO(ew, "wb")
        self.thread = threading.Thread(target=self.serve, daemon=True); self.thread.start()

    def send(self, value):
        data = json.dumps(value, separators=(",", ":")).encode() + b"\n"
        offset = 0
        while offset < len(data): offset += os.write(self.server_out.fileno(), data[offset:])

    def events(self):
        if self.mode == "history":
            self.send({"id": 2**63-1, "method": "item/tool/call", "params": {"threadId": "synthetic-thread", "turnId": "turn-1", "callId": "call-1", "tool": "neurobro_read_history", "arguments": {"fromDate": 1, "toDate": 200, "cursor": None}}})
            return
        image = {"type": "imageGeneration", "id": "image-1", "status": "completed", "result": base64.b64encode(PNG).decode()}
        if self.mode == "bad-png": image["result"] = base64.b64encode(b"PRIVATE not PNG").decode()
        items = []
        if self.mode != "no-image":
            start = dict(image, status="in_progress", result="")
            for method, stamp, item in (("item/started", "startedAtMs", start), ("item/completed", "completedAtMs", image)):
                self.send({"method": method, "emittedAtMs": 123, "params": {"threadId": "synthetic-thread", "turnId": "turn-1", stamp: 123, "item": item}})
            if self.mode == "image-budget":
                for _ in range(32):
                    self.send({"method": "item/completed", "params": {"threadId": "synthetic-thread", "turnId": "turn-1", "completedAtMs": 123, "item": image}})
            items.append(image)
        items.append({"id": "answer-1", "type": "agentMessage", "phase": "final_answer", "text": " " if self.mode == "empty-caption" else CAPTION})
        if self.mode == "deadline": self.advance(301)
        self.send({"method": "turn/completed", "params": {"threadId": "synthetic-thread", "turn": {"id": "turn-1", "status": "failed" if self.mode == "failed-turn" else "completed", "items": items}}})

    def serve(self):
        try:
            while True:
                line = self.server_in.readline(12 * 1024 * 1024 + 1)
                if not line: break
                frame = json.loads(line)
                self.test.assertIn("method", frame)  # history must not get an approved response
                method, params = frame["method"], frame.get("params", {})
                if method == "initialized": continue
                if method == "initialize": result = {"platformOs": "linux", "platformFamily": "unix", "codexHome": self.base.AUTH_HOME, "userAgent": self.base.CLIENT + "/0.153.4 (synthetic)"}
                elif method == "permissionProfile/list": result = {"data": [{"id": CONFIG["profile"], "allowed": True}], "nextCursor": None}
                elif method == "command/exec":
                    name = self.base.base_result()["probes"][self.commands]["name"]; self.commands += 1
                    result = {"exitCode": sorted(self.base.pass_codes(name))[0], "stdout": "", "stderr": ""}
                elif method == "account/read": result = {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": False}
                elif method == "model/list": result = {"data": [{"model": "gpt-6-astra", "hidden": False, "supportedReasoningEfforts": [{"reasoningEffort": "medium"}]}], "nextCursor": None}
                elif method == "modelProvider/capabilities/read":
                    self.test.assertEqual(self.commands, 9); self.test.assertEqual(self.threads, 0); self.test.assertEqual(params, {}); self.caps += 1
                    result = {"imageGeneration": self.mode != "cap-false", "namespaceTools": False, "webSearch": False}
                    if self.mode == "cap-shape": result["imageGeneration"] = "PRIVATE not boolean"
                elif method == "thread/start":
                    self.test.assertEqual(self.caps, 1); self.threads += 1
                    self.test.assertEqual(params["model"], "gpt-6-astra"); self.test.assertEqual(params["config"]["model_reasoning_effort"], "medium")
                    self.test.assertEqual(params["baseInstructions"], client.INSTRUCTIONS); self.test.assertEqual(params["developerInstructions"], client.INSTRUCTIONS)
                    self.test.assertEqual(params["dynamicTools"], [client.TOOL_SPEC])
                    self.test.assertIs(params["allowProviderModelFallback"], False)
                    result = {"thread": {"id": "synthetic-thread", "ephemeral": True}, "model": "gpt-6-astra", "modelProvider": "openai", "reasoningEffort": "medium", "cwd": CONFIG["cwd"], "approvalPolicy": "never", "approvalsReviewer": "user", "activePermissionProfile": {"id": CONFIG["profile"]}}
                elif method == "turn/start":
                    self.turns += 1; self.test.assertEqual(self.turns, 1)
                    self.test.assertEqual(params["threadId"], "synthetic-thread"); self.test.assertEqual(params["input"][0]["text"], client.PROMPT)
                    self.send({"id": frame["id"], "result": {"turn": {"id": "turn-1", "status": "inProgress", "items": []}}})
                    self.events(); continue
                else: self.test.fail("unexpected fixture method")
                self.send({"id": frame["id"], "result": result})
        except (BrokenPipeError, OSError): pass
        except BaseException as error: self.errors.append(type(error).__name__)
        finally:
            self.server_out.close(); self.server_err.close(); self.server_in.close(); self.done = True

    def wait(self, timeout):
        self.waits.append(timeout); self.thread.join(timeout)
        if self.thread.is_alive() or self.mode == "not-reaped": raise subprocess.TimeoutExpired("synthetic-fixture", timeout)
        return 0

    def poll(self): return 0 if self.done and self.mode != "not-reaped" else None


@unittest.skipUnless(sys.platform == "linux", "NativeRpc owns Linux anonymous pipes; no real subprocess is launched")
class ConnectedTests(unittest.TestCase):
    def fixture(self, mode="ok"):
        bundle, made, clock = sources(), [], [0.0]
        modules = client.load_sources(bundle, CONFIG); base = modules["custody"]
        def preflight(b, custody):
            self.assertEqual(b.CODEX_SHA256, base.CODEX_SHA256)
            for name in custody["controls"]: custody["controls"][name] = name != "relayAfter"
        def popen(argv, **kwargs):
            self.assertEqual(argv, client.image_launch_argv(modules["canary"], base)); self.assertEqual(kwargs["env"], base.app_server_env())
            self.assertTrue(kwargs["close_fds"]); self.assertEqual(kwargs["bufsize"], 0); self.assertEqual(kwargs["cwd"], CONFIG["cwd"])
            proc = FakeProcess(self, base, mode, lambda at: clock.__setitem__(0, at)); made.append(proc); return proc
        result = client.run(bundle, CONFIG, {"clock": lambda: clock[0], "popen": popen, "preflight": preflight, "relay_reachable": lambda: True})
        for proc in made:
            proc.thread.join(1); self.assertFalse(proc.thread.is_alive()); self.assertEqual(proc.errors, []); proc.stderr.close()
            self.assertTrue(all(0 < t <= 35 for t in proc.waits))
        public = json.dumps(result)
        for private in (CAPTION, "synthetic-thread", "image-1", "PRIVATE", base64.b64encode(PNG).decode()): self.assertNotIn(private, public)
        return result, made[0]

    def test_one_png_caption_actual_wrapper_collector_and_natural_settlement(self):
        result, proc = self.fixture()
        self.assertEqual(result["outcome"], "observed"); self.assertTrue(result["injectedPorts"])
        self.assertEqual((proc.commands, proc.caps, proc.threads, proc.turns), (9, 1, 1, 1))
        self.assertEqual(result["image"]["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertEqual(result["image"]["bytes"], len(PNG)); self.assertEqual(result["image"]["width"], 1)
        self.assertTrue(result["image"]["originMatched"]); self.assertTrue(result["appServer"]["stdoutEof"])
        self.assertTrue(result["appServer"]["reaped"])
        for key, replacement in (("originMatched", False), ("png", False), ("bytes", 0)):
            forged = json.loads(json.dumps(result)); forged["image"][key] = replacement
            with self.assertRaises(ValueError): client.normalize_result(forged)

    def test_unavailable_or_malformed_capability_never_admits_model(self):
        for mode in ("cap-false", "cap-shape"):
            result, proc = self.fixture(mode)
            self.assertEqual(result["code"], "CAPABILITIES_REFUSED"); self.assertFalse(result["native"]["admitted"])
            self.assertEqual((proc.threads, proc.turns), (0, 0)); self.assertFalse(result["diagnostics"]["cleanupUnknown"])

    def test_no_image_bad_image_or_blank_caption_never_observed(self):
        for mode in ("no-image", "bad-png", "empty-caption", "failed-turn"):
            result, _ = self.fixture(mode)
            self.assertNotEqual(result["outcome"], "observed"); self.assertEqual(result["code"], "IMAGE_TURN_REFUSED")
            self.assertFalse(result["diagnostics"]["cleanupUnknown"])

    def test_collector_budget_refusal_survives_strict_receipt(self):
        result, _ = self.fixture("image-budget")
        self.assertNotEqual(result["outcome"], "observed")
        self.assertEqual(result["image"]["evidenceCount"], 33)
        self.assertEqual(result["image"]["failureSite"], "budget")
        self.assertFalse(result["diagnostics"]["cleanupUnknown"])

    def test_history_callback_is_never_approved_or_retried(self):
        result, proc = self.fixture("history")
        self.assertNotEqual(result["outcome"], "observed")
        self.assertEqual(result["native"]["turns"][0]["toolCallbacks"], 1); self.assertEqual(proc.turns, 1)

    def test_aggregate_timeout_preserves_failure_before_clean_shutdown(self):
        result, proc = self.fixture("deadline")
        self.assertEqual(result["outcome"], "unknown"); self.assertEqual(proc.turns, 1)
        self.assertFalse(result["diagnostics"]["cleanupUnknown"]); self.assertEqual(result["diagnostics"]["originalStage"], "image-turn")

    def test_image_completion_cannot_substitute_for_process_settlement(self):
        result, _ = self.fixture("not-reaped")
        self.assertEqual(result["code"], "SHUTDOWN_UNKNOWN"); self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(result["diagnostics"]["originalCode"], "OK"); self.assertTrue(result["diagnostics"]["cleanupUnknown"])


if __name__ == "__main__": unittest.main()
