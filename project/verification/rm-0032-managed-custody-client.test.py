"""Offline-only transport, custody-probe and output-projection checks."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SOURCE = Path(__file__).with_name("rm-0032-managed-custody-client.py")
spec = importlib.util.spec_from_file_location("custody", SOURCE)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class ScriptedRpc:
    def __init__(self, bad_probe=None, medium=True, model_duplicate=False):
        self.calls = []
        self.bad_probe = bad_probe
        self.medium = medium
        self.model_duplicate = model_duplicate
        self.probe_index = 0

    def initialized(self):
        self.calls.append(("initialized", None))

    def exchange(self, method, params, seconds=10):
        self.calls.append((method, params))
        if method == "initialize":
            return {"platformOs": "linux", "platformFamily": "unix", "codexHome": c.AUTH_HOME, "userAgent": c.CLIENT + "/0.153.4 (linux)", "unused": "private fixture text"}, None
        if method == "permissionProfile/list":
            return {"data": [{"id": c.PROFILE, "allowed": True}], "nextCursor": None}, None
        if method == "command/exec":
            name = c.PROBES[self.probe_index]
            self.probe_index += 1
            code = min(c.pass_codes(name))
            return {"exitCode": code, "stdout": "private fixture text" if self.bad_probe == name else "", "stderr": ""}, None
        if method == "account/read":
            return {"requiresOpenaiAuth": True, "account": {"type": "chatgpt", "email": "private@example.invalid", "planType": "pro"}}, None
        if method == "model/list":
            item = {"model": "gpt-6-astra", "hidden": False, "supportedReasoningEfforts": [{"reasoningEffort": "medium" if self.medium else "high"}], "description": "private fixture text"}
            return {"data": [item, copy.deepcopy(item)] if self.model_duplicate else [item], "nextCursor": None}, None
        raise AssertionError("unadmitted method")


def protocol_result(rpc):
    result = c.base_result()
    c.protocol(rpc, result, 1234)
    return result


class ClientTests(unittest.TestCase):
    def run_fd_probe(self, metadata):
        def lookup(path):
            value = metadata[path.rsplit("/", 1)[-1]]
            if isinstance(value, Exception): raise value
            return value
        with mock.patch.object(sys, "argv", ["probe", "fd"]), mock.patch.object(os, "listdir", return_value=list(metadata)), mock.patch.object(os, "stat", side_effect=lookup):
            with self.assertRaises(SystemExit) as caught:
                exec(c.PROBE_SCRIPT, {"__name__": "__main__"})
        return caught.exception.code

    def test_fd_probe_detects_regular_files_even_on_standard_descriptors(self):
        pipe = os.stat_result((stat.S_IFIFO | 0o600, 0, 0, 1, 0, 0, 0, 0, 0, 0))
        baseline = {"0": pipe, "1": pipe, "2": pipe, "3": FileNotFoundError()}
        self.assertEqual(self.run_fd_probe(baseline), 40)
        with tempfile.TemporaryFile() as leaked:
            regular = os.fstat(leaked.fileno())
            for descriptor in ("0", "1", "2", "7"):
                actual = dict(baseline)
                actual[descriptor] = regular
                self.assertEqual(self.run_fd_probe(actual), 41)

    def test_fd_probe_detects_replaced_inode_without_cached_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic-private"
            path.write_bytes(b"old synthetic fixture")
            old = path.stat()
            fresh = Path(directory) / "synthetic-replacement"
            fresh.write_bytes(b"new synthetic fixture")
            os.replace(fresh, path)
            with path.open("rb") as leaked:
                current = os.fstat(leaked.fileno())
                self.assertNotEqual((old.st_dev, old.st_ino), (current.st_dev, current.st_ino))
                self.assertEqual(self.run_fd_probe({"9": current}), 41)
        self.assertEqual(c.probe_argv("fd", 123, 456)[6:], ["fd"])

    def test_fd_probe_refuses_uninspectable_descriptor(self):
        self.assertEqual(self.run_fd_probe({"5": PermissionError()}), 49)

    def test_protocol_order_and_private_projection(self):
        rpc = ScriptedRpc()
        result = protocol_result(rpc)
        methods = [m for m, _ in rpc.calls]
        self.assertEqual(methods, ["initialize", "initialized", "permissionProfile/list"] + ["command/exec"] * len(c.PROBES) + ["account/read", "model/list"])
        self.assertEqual(rpc.calls[-2][1], {"refreshToken": False})
        self.assertTrue(result["account"]["chatgpt"])
        self.assertTrue(result["model"]["mediumSupported"])
        encoded = json.dumps(c.normalize_result(result))
        for secret in ("private fixture", "private@example", "planType", "description"):
            self.assertNotIn(secret, encoded)
        for method, params in rpc.calls:
            if method == "command/exec":
                self.assertEqual(params["permissionProfile"], c.PROFILE)
                self.assertEqual(params["cwd"], c.ALLOWED)
                self.assertEqual(params["timeoutMs"], 3000)
                self.assertNotIn("env", params)
                self.assertNotIn("sandboxPolicy", params)

    def test_any_probe_output_refuses_account_and_catalog(self):
        rpc, result = ScriptedRpc(bad_probe="auth_direct"), c.base_result()
        with self.assertRaises(c.Stop) as caught:
            c.protocol(rpc, result, 1234)
        self.assertEqual(caught.exception.code, "PROBE_REFUSED")
        self.assertEqual(len([m for m, _ in rpc.calls if m == "command/exec"]), len(c.PROBES))
        self.assertFalse(any(m in {"account/read", "model/list"} for m, _ in rpc.calls))
        self.assertEqual(result["probes"][1]["verdict"], "refused")
        self.assertNotIn("private fixture", json.dumps(c.normalize_result(result)))

    def test_rpc_refusal_code_retained_and_never_treated_as_denial(self):
        rpc, result = ScriptedRpc(), c.base_result()
        exchange = rpc.exchange
        def refused(method, params, seconds=10):
            data, error = exchange(method, params, seconds)
            if method == "command/exec": return None, -32001
            return data, error
        rpc.exchange = refused
        with self.assertRaises(c.Stop): c.protocol(rpc, result, 1234)
        self.assertTrue(all(p["rpcCode"] == -32001 and p["verdict"] == "rpc_refused" for p in result["probes"]))
        c.normalize_result(result)

    def test_missing_medium_or_duplicate_model_never_downgrades(self):
        for rpc in (ScriptedRpc(medium=False), ScriptedRpc(model_duplicate=True)):
            with self.assertRaises(c.Stop) as caught: protocol_result(rpc)
            self.assertEqual(caught.exception.code, "MODEL_UNAVAILABLE")
            self.assertEqual([m for m, _ in rpc.calls].count("model/list"), 1)

    def test_strict_network_denial_codes(self):
        self.assertEqual(c.pass_codes("network"), {60, 61})
        for code in (62, 63, 64, 69): self.assertNotIn(code, c.pass_codes("network"))

    def test_exact_argv_paths_and_no_reading_credential_fragment(self):
        for name in c.PROBES:
            argv = c.probe_argv(name, 123, 456)
            self.assertEqual(argv[:6], [c.PYTHON, "-I", "-S", "-B", "-c", c.PROBE_SCRIPT])
        self.assertEqual(c.probe_argv("auth_server_root", 123, 456)[-1], "/proc/123/root" + c.AUTH_FILE)
        self.assertEqual(c.probe_argv("auth_controller_root", 123, 456)[-1], "/proc/456/root" + c.AUTH_FILE)
        self.assertEqual(c.probe_argv("fd", 123, 456)[-1:], ["fd"])
        self.assertNotIn(".read", c.PROBE_SCRIPT.split('if mode=="open":')[1].split('if mode=="fd":')[0])
        self.assertNotIn("os.read", c.PROBE_SCRIPT)

    @unittest.skipUnless(hasattr(__import__("os"), "O_CLOEXEC"), "Linux O_CLOEXEC probe")
    def test_open_probe_on_synthetic_file_emits_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.txt"
            path.write_bytes(b"private fixture never printed")
            completed = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", c.PROBE_SCRIPT, "open", str(path)], capture_output=True, timeout=5)
            self.assertEqual((completed.returncode, completed.stdout, completed.stderr), (23, b"", b""))

    def test_launch_config_and_environment_are_fixed(self):
        argv, env = c.app_server_argv(), c.app_server_env()
        self.assertEqual(argv[0], c.CODEX)
        self.assertEqual(argv[-1], "app-server")
        self.assertIn("respect_system_proxy=true", argv)
        self.assertIn("shell_environment_policy.inherit='none'", argv)
        filesystem = next(x for x in argv if ".filesystem=" in x)
        self.assertIn("':root'='deny'", filesystem)
        self.assertIn("'" + c.AUTH_HOME + "'='deny'", filesystem)
        self.assertIn("'" + c.PACKAGE + "'='read'", filesystem)
        self.assertEqual(set(env), {"HOME", "CODEX_HOME", "LANG", "PATH", "RUST_LOG", "HTTPS_PROXY", "HTTP_PROXY"})
        self.assertEqual(env["HOME"], c.AUTH_HOME)
        self.assertEqual(env["HTTPS_PROXY"], c.PROXY)
        self.assertEqual(env["RUST_LOG"], "off")

    def test_projection_rejects_arbitrary_fields_and_forged_passes(self):
        for group in (None, "account", "appServer", "model", "controls"):
            result = c.base_result()
            (result if group is None else result[group])["raw"] = "private"
            with self.assertRaises(ValueError): c.normalize_result(result)
        result = c.base_result()
        result["probes"][0].update(attempted=True, exitCode=0, stdoutBytes=1, verdict="pass")
        with self.assertRaises(ValueError): c.normalize_result(result)
        result = c.base_result()
        result.update(outcome="observed", code="OK", stage="complete")
        with self.assertRaises(ValueError): c.normalize_result(result)

    def test_fake_stream_notifications_are_discarded(self):
        lines = [{"method": "discard", "params": {"secret": "private fixture"}}, {"id": 1, "result": {"ok": True}}]
        proc = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(b"".join(json.dumps(x).encode() + b"\n" for x in lines)))
        rpc = c.Rpc(proc, time.monotonic() + 5)
        result, error = rpc.exchange("account/read", {"refreshToken": False})
        self.assertEqual((result, error), ({"ok": True}, None))
        self.assertNotIn(b"private", proc.stdin.getvalue())

    def test_fake_stream_bad_frames_refused_and_methods_fenced(self):
        for raw in (b'{"id":true,"result":{}}\n', b'{"id":1,"id":1,"result":{}}\n', b'{"id":1,"method":"approval","params":{}}\n', b'x' * (c.LINE_CAP + 1)):
            proc = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO(raw))
            rpc = c.Rpc(proc, time.monotonic() + .1)
            with self.assertRaises(c.Stop): rpc.exchange("account/read", {"refreshToken": False}, .1)
        proc = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO())
        rpc = c.Rpc(proc, time.monotonic() + 1)
        for method in ("thread/start", "turn/start", "account/login/start", "command/exec/write"):
            with self.assertRaises(c.Stop): rpc.exchange(method, {})
        self.assertEqual(proc.stdin.getvalue(), b"")

    def test_eof_timeout_stays_unknown_no_kill_or_model(self):
        proc = mock.Mock(stdin=mock.Mock(), stderr=io.BytesIO())
        proc.pid = 1234
        proc.wait.side_effect = subprocess.TimeoutExpired("fixed", 35)
        proc.poll.return_value = None
        with mock.patch.object(c, "preflight", return_value=(1, 2)), mock.patch.object(c.subprocess, "Popen", return_value=proc) as launch, mock.patch.object(c, "Rpc"), mock.patch.object(c, "protocol", side_effect=c.Stop("PROBE_REFUSED")):
            result = c.run()
        self.assertEqual(result["code"], "SHUTDOWN_UNKNOWN")
        self.assertFalse(result["appServer"]["reaped"])
        self.assertTrue(launch.call_args.kwargs["close_fds"])
        self.assertNotIn("pass_fds", launch.call_args.kwargs)
        proc.terminate.assert_not_called()
        proc.kill.assert_not_called()
        proc.wait.assert_called_once_with(timeout=35.0)


if __name__ == "__main__":
    unittest.main()
