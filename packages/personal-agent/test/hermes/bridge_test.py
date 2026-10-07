"""Offline scoped bridge tests. No provider/model/Telegram request.

Optional source proof: NEUROBRO_HERMES_SOURCE is a directory with the fetched
pinned source files named tools_registry.py, model_tools.py, etc. Native
registry dispatch is extracted and executed, not reimplemented as a fixture.
"""
from __future__ import annotations

import ast
import base64
import copy
import hashlib
import importlib.util
import inspect
import json
import logging
import os
import pathlib
import sys
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("test_hermes_bridge", ROOT / "tools/hermes/__init__.py",
                                            submodule_search_locations=[str(ROOT / "tools/hermes")])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
from test_hermes_bridge.neurobro_bridge import Bridge, BindingConflict, cron_result, register_plugin
from test_hermes_bridge.management import BrokerHttpClient, ManagementServer, parse_bind

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ9sAAAAASUVORK5CYII=')


def image_envelope(raw=PNG, mime='image/png'):
    summary = 'Authorized image artifact bytes: sha256=' + hashlib.sha256(raw).hexdigest()
    return {'_multimodal': True, 'text_summary': summary, 'content': [
        {'type': 'text', 'text': summary},
        {'type': 'image_url', 'image_url': {'url': 'data:' + mime + ';base64,' + base64.b64encode(raw).decode()}},
    ]}


class MultimodalBridgeTests(unittest.TestCase):
    def invoke(self, envelope, name='artifacts.view_image'):
        bridge = Bridge(lambda *_: {'ok': True, 'value': envelope})
        bridge.bind_session('native-session', 'admission', 'secret-scoped-token')
        return bridge.handle({'name': name, 'args': {'artifactId': 'saved-image-id'}}, task_id='native-session')

    def test_authorized_bytes_remain_native_dict_not_json_text(self):
        envelope = image_envelope()
        result = self.invoke(envelope)
        self.assertIs(result, envelope)
        self.assertIsInstance(result, dict)
        url = result['content'][1]['image_url']['url']
        self.assertEqual(base64.b64decode(url.split(',')[1]), PNG)
        self.assertEqual(json.loads(self.invoke(envelope, 'unrelated.tool'))['error'], 'broker_multimodal_tool_not_allowed')

    def test_remote_paths_mime_extra_authority_and_malformed_blocks_denied(self):
        invalid = []
        for url in ['https://example.invalid/image.png', 'file:///C:/secret.png', 'data:image/png;base64,???', 'data:image/jpeg;base64,' + base64.b64encode(PNG).decode()]:
            value = image_envelope(); value['content'][1]['image_url']['url'] = url; invalid.append(value)
        value = image_envelope(); value['content'][1]['image_url']['task_id'] = 'forged'; invalid.append(value)
        value = image_envelope(); value['authority'] = 'forged'; invalid.append(value)
        value = image_envelope(); value['content'][0]['text'] = 'mismatch'; invalid.append(value)
        value = image_envelope(); value['content'].append(value['content'][1]); invalid.append(value)
        for value in invalid:
            with self.subTest(value=str(value)[:80]):
                self.assertEqual(json.loads(self.invoke(value))['error'], 'broker_multimodal_invalid')

    def test_exact_image_limit_and_credential_hidden_in_pixels(self):
        raw = PNG + b'\0' * (8 * 1024 * 1024 - len(PNG))
        self.assertIsInstance(self.invoke(image_envelope(raw)), dict)
        self.assertEqual(json.loads(self.invoke(image_envelope(raw + b'x')))['error'], 'broker_multimodal_invalid')
        self.assertEqual(json.loads(self.invoke(image_envelope(PNG + b'secret-scoped-token')))['error'], 'broker_multimodal_invalid')


class BrokerReplyLimitTests(unittest.TestCase):
    def call(self, raw, tool):
        # Emulates the urllib stream contract and records the precise bounded
        # read; no unbounded read is hidden behind the JSON parser.
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, amount):
                self.amount = amount
                return raw[:amount]
        response = Response()
        client = BrokerHttpClient('http://127.0.0.1:7777/tools/call')
        client._opener = types.SimpleNamespace(open=lambda *_args, **_kwargs: response)
        return client.call('opaque', {'name': tool, 'args': {}}), response.amount

    def test_only_image_envelope_receives_larger_bounded_read(self):
        raw = json.dumps({'ok': True, 'value': image_envelope(PNG + b'x' * (2 * 1024 * 1024))}).encode()
        result, amount = self.call(raw, 'artifacts.view_image')
        self.assertTrue(result['ok']); self.assertEqual(amount, 12 * 1024 * 1024 + 1)
        result, amount = self.call(raw, 'ordinary.tool')
        self.assertEqual(result['error'], 'broker_result_too_large'); self.assertEqual(amount, 2 * 1024 * 1024 + 1)
        for raw in [json.dumps({'ok': True, 'value': 'x' * (2 * 1024 * 1024)}).encode(), b'x' * (12 * 1024 * 1024 + 1)]:
            result, amount = self.call(raw, 'artifacts.view_image')
            self.assertEqual(result['error'], 'broker_result_too_large'); self.assertEqual(amount, 12 * 1024 * 1024 + 1)


class ScopedBridgeTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def call(token, request):
            self.calls.append((token, request))
            return {"ok": True, "value": "synthetic receipt"}
        self.bridge = Bridge(call)
        self.bridge.bind_session("unique-session-a", "admission-a", "scoped-token-a")

    def test_runtime_context_only(self):
        request = {"name": "telegram.send", "args": {"task_id": "forged", "tool_context": "forged"}}
        result = json.loads(self.bridge.handle(request, task_id="unique-session-a", session_id="compressed-session"))
        self.assertTrue(result["ok"])
        self.assertEqual(self.calls, [("scoped-token-a", request)])
        self.assertNotIn("scoped-token-a", json.dumps(result))

    def test_no_runtime_identity_is_unavailable(self):
        request = {"name": "read", "args": {}}
        result = json.loads(self.bridge.handle(request, session_id="unique-session-a"))
        self.assertEqual(result["error"], "trusted_run_context_unavailable")
        self.assertEqual(self.calls, [])

    def test_extra_model_identity_is_not_accepted(self):
        request = {"name": "read", "args": {}, "task_id": "unique-session-a"}
        self.assertFalse(json.loads(self.bridge.handle(request, task_id="unique-session-a"))["ok"])
        self.assertEqual(self.calls, [])

    def test_replay_exact_registration_and_rebind_denial(self):
        self.bridge.bind_session("unique-session-a", "admission-a", "scoped-token-a")
        for key, token in [("admission-b", "scoped-token-a"), ("admission-a", "scoped-token-b")]:
            with self.assertRaises(BindingConflict):
                self.bridge.bind_session("unique-session-a", key, token)

    def test_revoke_tombstone_cannot_be_reenrolled(self):
        self.bridge.revoke_session("unique-session-a")
        with self.assertRaises(BindingConflict):
            self.bridge.bind_session("unique-session-a", "admission-a", "scoped-token-a")
        self.assertFalse(json.loads(self.bridge.handle({"name": "read", "args": {}}, task_id="unique-session-a"))["ok"])
        self.assertEqual(self.calls, [])

    def test_restart_has_no_ambient_authority(self):
        fresh = Bridge(lambda *_: self.fail("Must not dispatch"))
        self.assertFalse(json.loads(fresh.handle({"name": "read", "args": {}}, task_id="unique-session-a"))["ok"])

    def test_parallel_sessions_do_not_cross_credentials(self):
        self.bridge.bind_session("unique-session-b", "admission-b", "scoped-token-b")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda s: self.bridge.handle({"name": s, "args": {}}, task_id=s),
                                    ["unique-session-a", "unique-session-b"]))
        self.assertTrue(all(json.loads(r)["ok"] for r in results))
        self.assertEqual({(t, r["name"]) for t, r in self.calls}, {
            ("scoped-token-a", "unique-session-a"), ("scoped-token-b", "unique-session-b")})

    def test_transport_ambiguity_no_retry_or_credential_error(self):
        called = []
        def fail(token, request):
            called.append(token)
            raise RuntimeError(token)
        bridge = Bridge(fail)
        bridge.bind_session("s", "k", "secret-token")
        result = bridge.handle({"name": "read", "args": {}}, task_id="s")
        self.assertEqual(json.loads(result)["error"], "broker_transport_unknown")
        self.assertNotIn("secret-token", result)
        self.assertEqual(called, ["secret-token"])

    def test_local_revoke_during_broker_call_discards_late_result_without_retry(self):
        entered, release = threading.Event(), threading.Event()
        calls, output = [], []
        def broker_call(token, request):
            calls.append((token, request)); entered.set()
            self.assertTrue(release.wait(2))
            return {"ok": True, "value": "late authorized data must not be exposed"}
        bridge = Bridge(broker_call); bridge.bind_session("s", "k", "scoped-token")
        thread = threading.Thread(target=lambda: output.append(bridge.handle({"name": "read", "args": {}}, task_id="s")))
        thread.start(); self.assertTrue(entered.wait(2))
        # This must complete while the external broker call is still pending.
        revoked = threading.Event()
        revoker = threading.Thread(target=lambda: (bridge.revoke_session("s"), revoked.set()))
        revoker.start(); self.assertTrue(revoked.wait(0.5)); release.set()
        thread.join(2); revoker.join(2)
        self.assertEqual(json.loads(output[0]), {"ok": False, "error": "trusted_run_context_unavailable"})
        self.assertEqual(len(calls), 1); self.assertNotIn("late authorized data", output[0])

    def test_broker_credential_echo_is_rejected(self):
        for credential in ("secret-token", 'token-"-escaped'):
            bridge = Bridge(lambda token, _: {"ok": True, "value": token})
            bridge.bind_session("s", "k", credential)
            self.assertEqual(json.loads(bridge.handle({"name": "read", "args": {}}, task_id="s"))["error"],
                             "broker_result_contains_credential")

    def test_plugin_supported_registration_has_no_identity_schema(self):
        class Context:
            def register_tool(self, **kwargs):
                self.kwargs = kwargs
        context = Context()
        register_plugin(context, self.bridge)
        self.assertEqual(context.kwargs["name"], "neurobro_tool")
        properties = context.kwargs["schema"]["parameters"]["properties"]
        self.assertEqual(set(properties), {"name", "args"})
        self.assertEqual(inspect.signature(context.kwargs["handler"]).parameters["task_id"].kind,
                         inspect.Parameter.KEYWORD_ONLY)

    def test_cron_output_requires_real_execution_binding(self):
        self.assertEqual(cron_result("job", "execution"),
                         {"ok": False, "error": "cron_execution_output_binding_unavailable"})


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.bridge = Bridge(lambda token, request: self.calls.append((token, request)) or {"ok": True})
        self.server = ManagementServer(self.bridge, ("127.0.0.1", 0), "x" * 32)
        self.server.start()
        self.url = "http://127.0.0.1:" + str(self.server.address[1])
        self.opener = build_opener(ProxyHandler({}))

    def tearDown(self):
        self.server.close()

    def request(self, path, body=None, key="x" * 32):
        req = Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                      headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=2) as response:
                return response.status, json.load(response)
        except HTTPError as response:
            with response:
                return response.code, json.load(response)

    def test_authenticated_registration_exact_replay_conflict(self):
        body = {"session_id": "s", "idempotency_key": "k", "tool_context": "scoped-token"}
        self.assertEqual(self.request("/bindings", body, key="wrong")[0], 401)
        self.assertEqual(self.request("/bindings", body), (200, {"ok": True, "session_id": "s"}))
        self.assertEqual(self.request("/bindings", body)[0], 200)
        self.assertEqual(self.request("/bindings", {**body, "tool_context": "new"})[0], 409)
        self.assertEqual(self.request("/bindings", {**body, "extra": True})[0], 400)
        self.assertEqual(self.calls, [])  # Registration key has no tool execution route.
        self.assertEqual(self.request("/tools/call", {"name": "read", "args": {}})[0], 404)
        self.assertEqual(self.request("/ready")[1]["trustedIdentity"], "native_handler_task_id")

    def test_loopback_only(self):
        for bind in ("0.0.0.0:1111", "example.com:1111", "127.0.0.1:0", "127.0.0.1:1111/path"):
            with self.assertRaises(ValueError):
                parse_bind(bind)
        for url in ("https://127.0.0.1:1111/tools/call", "http://example.com:1111/tools/call",
                    "http://127.0.0.1:1111/tools/call?q=secret"):
            with self.assertRaises(ValueError):
                BrokerHttpClient(url)


class BrokerHttpTests(unittest.TestCase):
    def test_scoped_bearer_no_retry_no_redirect_and_receipt(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                received.append((self.path, self.headers["Authorization"],
                                 json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/leak")
                    self.end_headers()
                    return
                raw = json.dumps({"ok": True, "value": {"receipt": "synthetic"}}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = "http://127.0.0.1:" + str(server.server_address[1])
            request = {"name": "read", "args": {}}
            self.assertTrue(BrokerHttpClient(base + "/tools/call").call("scoped-token", request)["ok"])
            self.assertFalse(BrokerHttpClient(base + "/redirect").call("scoped-token", request)["ok"])
            self.assertEqual([p for p, _, _ in received], ["/tools/call", "/redirect"])
            self.assertTrue(all(header == "Bearer scoped-token" for _, header, _ in received))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


@unittest.skipUnless(os.environ.get("NEUROBRO_HERMES_SOURCE"), "Pinned source path not supplied")
class NativeSourceTests(unittest.TestCase):
    def setUp(self):
        self.source = pathlib.Path(os.environ["NEUROBRO_HERMES_SOURCE"])
        # Blob IDs read from the official Git tree at HERMES_PIN. Verify bytes
        # before extracting methods; another checkout is not this proof.
        expected = {
            "tools_registry.py": "57cffdc89aa83a685e11dd96c54e7a54374345a6",
            "model_tools.py": "138797668fa79eac2b0e41a62638f83375817a47",
            "api_server_runs.py": "8b662cacbdf4a541c7b7b0c0eb8c953d0180001e",
            "agent_tool_executor.py": "50a9e6259991cf611e73607f4299b2af839f8d8c",
            "agent_vision_message_prep.py": "08862dd97d6737f4e388151a16e33e7e031ff146",
            "agent_tool_dispatch_helpers.py": "11a86bc947df3c45709215949c9b6f299291c964",
        }
        for path, digest in expected.items():
            raw = (self.source / path).read_bytes()
            self.assertEqual(hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(), digest)

    def test_native_dispatch_preserves_bridge_pixels_and_executor_persists_only_text(self):
        tree = ast.parse((self.source / 'tools_registry.py').read_text(encoding='utf-8'))
        registry = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ToolRegistry')
        helper = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_kwargs_accepted_by')
        normalizer = next(n for n in registry.body if isinstance(n, ast.FunctionDef) and n.name == '_normalize_handler_result')
        dispatch = next(n for n in registry.body if isinstance(n, ast.FunctionDef) and n.name == 'dispatch')
        normalizer.decorator_list = []; dispatch.name = 'native_dispatch'
        namespace = {'inspect': inspect, 'Callable': object, 'Optional': __import__('typing').Optional}
        exec(compile(ast.Module(body=[helper, normalizer, dispatch], type_ignores=[]), 'pinned_tools_registry.py', 'exec'), namespace)
        envelope = image_envelope()
        bridge = Bridge(lambda *_: {'ok': True, 'value': envelope})
        bridge.bind_session('native-session', 'admission', 'secret-scoped-token')
        instance = types.SimpleNamespace(get_entry=lambda *_args, **_kwargs: types.SimpleNamespace(handler=bridge.handle, is_async=False),
                                         _normalize_handler_result=namespace['_normalize_handler_result'])
        result = namespace['native_dispatch'](instance, 'neurobro_tool', {'name': 'artifacts.view_image', 'args': {'artifactId': 'saved-image'}}, task_id='native-session')
        self.assertIs(result, envelope)  # Native registry retained the actual DICT.
        executor_raw = (self.source / 'agent_tool_executor.py').read_text(encoding='utf-8')
        executor = ast.parse(executor_raw)
        persist = next(n for n in executor.body if isinstance(n, ast.FunctionDef) and n.name == '_persist_multimodal_text_parts')
        touched = []
        def spill(**kwargs):
            touched.append(kwargs['content'])
            return 'persisted text reference'
        namespace = {'BudgetConfig': object, 'maybe_persist_tool_result': spill}
        exec(compile(ast.Module(body=[persist], type_ignores=[]), 'pinned_tool_executor.py', 'exec'), namespace)
        original = copy.deepcopy(result)
        persisted = namespace['_persist_multimodal_text_parts'](result, 'neurobro_tool', 'tool-call', None, types.SimpleNamespace(resolve_threshold=lambda *_: 1))
        self.assertEqual(touched, [original['content'][0]['text']])
        self.assertEqual(persisted['content'][1], original['content'][1])
        self.assertEqual(result, original)  # Native persistence did not mutate history.
        self.assertIn('_tool_content = agent._tool_result_content_for_active_model(function_name, persisted_result)', executor_raw)
        self.assertIn('make_tool_result_message(function_name, _tool_content, tool_call_id', executor_raw)

    def test_native_active_model_projection_requires_vision_and_tool_content_support(self):
        # Execute the pinned projection itself; capability probes are injected
        # outcomes, never a provider/model call during these offline tests.
        helpers = ast.parse((self.source / 'agent_tool_dispatch_helpers.py').read_text(encoding='utf-8'))
        vision = ast.parse((self.source / 'agent_vision_message_prep.py').read_text(encoding='utf-8'))
        mixin = next(n for n in vision.body if isinstance(n, ast.ClassDef) and n.name == 'VisionMessagePrepMixin')
        functions = [n for n in helpers.body if isinstance(n, ast.FunctionDef) and n.name in {'_is_multimodal_tool_result', '_is_text_part', '_multimodal_text_summary'}]
        functions += [n for n in vision.body if isinstance(n, ast.FunctionDef) and n.name in {'_is_image_part', '_provider_model_key'}]
        functions += [n for n in mixin.body if isinstance(n, ast.FunctionDef) and n.name in {'_content_has_image_parts', '_tool_result_content_for_active_model'}]
        for node in functions: node.decorator_list = []
        namespace = {'Any': __import__('typing').Any, 'json': json, 'logger': logging.getLogger('native-vision-test'), '_IMAGE_PART_TYPES': {'image_url', 'input_image'}}
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'pinned_vision_projection.py', 'exec'), namespace)
        instance = types.SimpleNamespace(provider='synthetic', model='fixture', _content_has_image_parts=namespace['_content_has_image_parts'],
                                          _model_supports_vision=lambda: True, _provider_supports_vision_tool_messages=lambda: True)
        envelope = image_envelope()
        project = namespace['_tool_result_content_for_active_model']
        self.assertIs(project(instance, 'neurobro_tool', envelope), envelope['content'])
        instance._provider_supports_vision_tool_messages = lambda: False
        self.assertEqual(project(instance, 'neurobro_tool', envelope), envelope['text_summary'])
        instance._provider_supports_vision_tool_messages = lambda: True
        instance._no_list_tool_content_models = {('synthetic', 'fixture')}
        self.assertEqual(project(instance, 'neurobro_tool', envelope), envelope['text_summary'])
        instance._no_list_tool_content_models = set(); instance._model_supports_vision = lambda: False
        with self.assertLogs('native-vision-test', level='WARNING'):
            self.assertEqual(project(instance, 'neurobro_tool', envelope), envelope['text_summary'])

    def test_native_registry_dispatch_trusted_kwargs(self):
        source = self.source
        raw = (source / "tools_registry.py").read_text(encoding="utf-8")
        tree = ast.parse(raw)
        helper = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_kwargs_accepted_by")
        registry = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "ToolRegistry")
        dispatch = next(n for n in registry.body if isinstance(n, ast.FunctionDef) and n.name == "dispatch")
        namespace = {"inspect": inspect, "Callable": object, "Optional": __import__("typing").Optional}
        dispatch.name = "native_dispatch"
        compiled = ast.Module(body=[helper, dispatch], type_ignores=[])
        exec(compile(compiled, str(source / "tools_registry.py"), "exec"), namespace)
        seen = []
        bridge = Bridge(lambda token, args: seen.append((token, args)) or {"ok": True})
        bridge.bind_session("native-session", "admission", "scoped-native-token")
        entry = types.SimpleNamespace(handler=bridge.handle, is_async=False)
        instance = types.SimpleNamespace(get_entry=lambda *_args, **_kwargs: entry,
                                        _normalize_handler_result=lambda _name, value: value)
        result = namespace["native_dispatch"](instance, "neurobro_tool",
                {"name": "read", "args": {"task_id": "forged"}},
                task_id="native-session", session_id="compacted-session", user_task="untrusted text")
        self.assertTrue(json.loads(result)["ok"])
        self.assertEqual(seen[0][0], "scoped-native-token")
        # Assert connected dispatch source and HTTP run identity, not a guessed plugin interface.
        model = (source / "model_tools.py").read_text(encoding="utf-8")
        self.assertIn('dispatch_kwargs: Dict[str, Any] = {"task_id": ids.task_id, "session_id": ids.session_id}', model)
        run = (source / "api_server_runs.py").read_text(encoding="utf-8")
        self.assertIn("effective_task_id = session_id or run.run_id", run)
        self.assertIn("task_id=effective_task_id, **author_kwargs", run)

    def test_native_cron_has_no_output_correlation_hook(self):
        expected = {
            "hermes_cli_plugins.py": "4fbf7394c85980177b2e3139526bfa4fd45d58cc",
            "cron_executions.py": "b6afa0d3797975cb1d5a5c6e7be45e8b9aea4006",
            "cron_jobs.py": "2e421c7af328f7e9e259713e03c8880e35ccf793",
            "cron_scheduler.py": "4082d766f35ccf9b546654fae8ba8dba4d563747",
        }
        native = {}
        for path, digest in expected.items():
            raw = (self.source / path).read_bytes()
            self.assertEqual(hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(), digest)
            native[path] = ast.parse(raw.decode())
        hooks = next(n for n in native["hermes_cli_plugins.py"].body
                     if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)
                     and n.target.id == "VALID_HOOKS")
        hook_names = ast.literal_eval(hooks.value)
        self.assertFalse(any("cron" in name for name in hook_names))
        jobs = native["cron_jobs.py"]
        save = next(n for n in jobs.body if isinstance(n, ast.FunctionDef) and n.name == "save_job_output")
        self.assertEqual([a.arg for a in save.args.args], ["job_id", "output"])
        self.assertNotIn("execution_id", ast.unparse(save))
        executions = native["cron_executions.py"]
        finish = next(n for n in executions.body if isinstance(n, ast.FunctionDef) and n.name == "finish_execution")
        self.assertNotIn("output_file", ast.unparse(finish))
        self.assertNotIn("sha256", ast.unparse(finish))
        scheduler = native["cron_scheduler.py"]
        save_delivery = next(n for n in scheduler.body if isinstance(n, ast.FunctionDef) and n.name == "_save_compose_deliver")
        self.assertIn("save_job_output(job['id'], output)", ast.unparse(save_delivery))
        self.assertNotIn("invoke_hook", ast.unparse(save_delivery))


if __name__ == "__main__":
    unittest.main()
