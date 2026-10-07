"""Offline scoped cognition proof using the actual pinned native handler ASTs."""
from __future__ import annotations

import ast
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("cognition_bridge_fixture", ROOT / "tools/hermes/__init__.py", submodule_search_locations=[str(ROOT / "tools/hermes")])
plugin = importlib.util.module_from_spec(spec); sys.modules[spec.name] = plugin; spec.loader.exec_module(plugin)
from cognition_bridge_fixture.cognition import NativeSkills, CognitionError, MAX_READ_BYTES, _frontmatter
from cognition_bridge_fixture.neurobro_bridge import Bridge, BindingConflict
from cognition_bridge_fixture.management import BrokerHttpClient, ManagementServer

SOURCE = ROOT / ".runtime/hermes-agent/tools/skills_tool.py"
SOURCE_BLOB = "2cff382992920bb7a6e65dc2e7473409229fd7c2"
SAFE = b'---\nname: Approved research\ndescription: Owner approved research procedure\n---\n# Procedure\nRead the exact source before reporting.\n'


@unittest.skipUnless(SOURCE.is_file(), "Pinned native source checkout unavailable")
class CognitionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = SOURCE.read_bytes()
        if hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() != SOURCE_BLOB:
            raise AssertionError("Native source pin mismatch")
        cls.tree = ast.parse(raw.decode())
        cls.handlers = [node for node in cls.tree.body if isinstance(node, ast.FunctionDef) and node.name in {"skills_list", "skill_view"}]
        assert len(cls.handlers) == 2

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="neurobro-cognition-")
        self.root = Path(self.tmp.name) / "skills"; self.root.mkdir()
        self.skill = self.root / "approved"; self.skill.mkdir(); (self.skill / "SKILL.md").write_bytes(SAFE)
        self.bridge = Bridge(lambda *_: self.fail("Cognition must never execute broker tools"))
        self.bridge.bind_session("original-native-session", "admission-exact", "never-visible-scoped-token")
        self.calls, self.preprocess_calls = [], []
        logger = types.SimpleNamespace(debug=lambda *_a, **_k: None, warning=lambda *_a, **_k: None)
        namespace = {"Path": Path, "json": json, "logger": logger,
            "_skills_dir": lambda: self.root, "_skill_search_dirs": lambda: ([(1, self.root)], self.root),
            "_skill_lookup_path_error": lambda _name: None, "_LOOKUP_HINT": "fixture",
            "_locate_skill": self.locate, "_read_skill_text": lambda path: path.read_text(encoding="utf-8-sig"),
            "_log_security_warnings": lambda *_a: None, "_safe_frontmatter": lambda *, content: _frontmatter(content),
            "skill_matches_platform": lambda _meta: True, "_is_skill_disabled": lambda *_a: False,
            "_owned_relative": lambda _dir, path, _roots: path.parent.relative_to(self.root).as_posix(),
            "_parse_tags": lambda _value: [], "_skill_linked_files": lambda *_a: {"scripts": ["private.sh"]},
            "_skill_readiness": lambda *_a: ({"required_environment_variables": [{"name": "SECRET", "value": "not-visible"}]}, {"setup_note": "/private/path"}),
            "_preprocess_skill": lambda *_a: self.preprocess_calls.append(True) or self.fail("Native preprocessing denied"),
            "_mark_background_review_read": lambda _path: None,
            "_find_all_skills": lambda: [{"name": "Approved research", "description": "approved", "category": None}, {"name": "UNAPPROVED_INTERNAL", "description": "hidden", "category": "secret"}],
            "_sort_skills": lambda rows: rows, "_json": json.dumps,
            "_fail": lambda message, **_kwargs: json.dumps({"success": False, "error": message}),
            "tool_error": lambda message, **kwargs: json.dumps({"error": message, **kwargs}),
        }
        exec(compile(ast.Module(body=self.handlers, type_ignores=[]), str(SOURCE), "exec"), namespace)
        self.native = types.SimpleNamespace(**namespace)
        for name in ("skills_list", "skill_view"):
            function = namespace[name]
            def wrapped(*args, _name=name, _function=function, **kwargs):
                self.calls.append((_name, args, kwargs)); return _function(*args, **kwargs)
            setattr(self.native, name, wrapped)
        self.reader = NativeSkills(bridge=self.bridge, skills_root=self.root, native=self.native)
        self.allowed = {"id": "skill-record-1", "nativeName": "approved", "sha256": hashlib.sha256(SAFE).hexdigest(), "ownerId": "owner", "accountId": "account", "scope": "task:task-A", "sourceRefs": ["owner-source-version-1"], "state": "approved"}

    def tearDown(self):
        self.tmp.cleanup()

    def locate(self, name, _local, _roots):
        path = self.root / name / "SKILL.md"
        return (None, path.parent, path) if path.is_file() else ("missing", None, None)

    def body(self, operation="view", **updates):
        body = {"session_id": "original-native-session", "operation": operation, "descriptors": [self.allowed]}
        if operation == "view": body["skill_id"] = self.allowed["id"]
        return {**body, **updates}

    def test_pinned_native_view_uses_original_identity_no_preprocess_and_only_safe_response(self):
        references = self.skill / 'references'; references.mkdir(); (references / 'private.md').write_text('Supporting files must not enter the response')
        result = self.reader.read(self.body())
        self.assertEqual(result["value"]["content"], SAFE.decode())
        self.assertEqual(result["value"]["skill"]["sha256"], self.allowed["sha256"])
        self.assertEqual(self.calls, [("skill_view", ("approved",), {"task_id": "original-native-session", "preprocess": False})])
        self.assertEqual(self.preprocess_calls, [])
        raw = json.dumps(result)
        for hidden in ["_source_path", "private.sh", "setup_note", "required_environment", "never-visible-scoped-token", str(self.root)]: self.assertNotIn(hidden, raw)

    def test_list_filters_broad_native_catalog_and_accepts_installed_knowledge_without_telegram_refs(self):
        unrelated = self.root / "unrelated"; unrelated.mkdir()
        (unrelated / "SKILL.md").write_text('---\nname: UNAPPROVED_INTERNAL\ndeps: arbitrary-package\n---\nUnrelated installed skill.\n')
        self.allowed["sourceRefs"] = []; result = self.reader.read(self.body("list"))
        self.assertEqual([item["id"] for item in result["value"]["skills"]], [self.allowed["id"]])
        self.assertNotIn("UNAPPROVED_INTERNAL", json.dumps(result)); self.assertNotIn("categories", json.dumps(result))
        self.assertEqual(self.calls[0][0], "skills_list")

    def test_original_crlf_bom_content_is_returned_after_native_normalized_readback(self):
        raw = b'\xef\xbb\xbf' + SAFE.replace(b'\n', b'\r\n'); (self.skill / 'SKILL.md').write_bytes(raw)
        self.allowed['sha256'] = hashlib.sha256(raw).hexdigest()
        result = self.reader.read(self.body()); self.assertEqual(result['value']['content'].encode(), raw)

    def test_empty_whitelist_never_invokes_global_native_listing(self):
        result = self.reader.read(self.body('list', descriptors=[]))
        self.assertEqual(result, {'ok': True, 'value': {'skills': []}}); self.assertEqual(self.calls, [])

    def test_unregistered_compacted_and_revoked_sessions_fail_before_native(self):
        for session in ["compressed-session", "forged-session"]:
            with self.assertRaises(BindingConflict): self.reader.read(self.body(session_id=session))
        self.bridge.revoke_session("original-native-session")
        with self.assertRaises(BindingConflict): self.reader.read(self.body())
        self.assertEqual(self.calls, [])

    def test_whitelist_is_strict_and_model_paths_support_files_or_state_are_rejected(self):
        for extra in [{"file_path": "scripts/private.sh"}, {"name": "forged"}, {"tool_context": "forged"}]:
            with self.assertRaises(CognitionError): self.reader.read(self.body(**extra))
        for update in [{"nativeName": "../other"}, {"nativeName": "plugin:skill"}, {"nativeName": "C:/outside"}, {"state": "proposed"}, {"scope": "admin"}, {"sourceRefs": [""]}, {"sha256": "0" * 64}]:
            with self.subTest(update=update), self.assertRaises(CognitionError): self.reader.read(self.body(descriptors=[{**self.allowed, **update}]))
        with self.assertRaises(CognitionError): self.reader.read(self.body(skill_id="not-approved"))
        self.assertEqual(self.calls, [])

    def test_activation_frontmatter_never_reaches_native_view(self):
        for activation in ['deps: [ffmpeg]', 'required_environment_variables: [SECRET]', 'required_credential_files: [/secret]', 'metadata: {hermes: {setup: evil}}', 'platforms: [windows]', 'description: duplicate', 'name: |\n  multiline']:
            raw = SAFE.replace(b'---\n# Procedure', activation.encode() + b'\n---\n# Procedure')
            (self.skill / "SKILL.md").write_bytes(raw); self.allowed["sha256"] = hashlib.sha256(raw).hexdigest()
            with self.subTest(activation=activation), self.assertRaises(CognitionError): self.reader.read(self.body())
        self.assertEqual(self.calls, [])
        view = next(node for node in self.handlers if node.name == 'skill_view')
        self.assertTrue(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'ensure' for node in ast.walk(view)), 'Pinned preprocess=False still leaves deps activation; preflight is required')

    def test_root_shadow_resolution_and_native_source_path_mismatch_are_denied(self):
        self.native._skill_search_dirs = lambda: ([(0, self.root.parent), (1, self.root)], self.root)
        with self.assertRaisesRegex(CognitionError, 'roots_not_isolated'): self.reader.read(self.body())
        self.native._skill_search_dirs = lambda: ([(1, self.root)], self.root)
        self.native._locate_skill = lambda *_a: (None, self.root, self.root / 'SKILL.md')
        with self.assertRaisesRegex(CognitionError, 'resolution_mismatch'): self.reader.read(self.body())
        self.assertEqual(self.calls, [])
        self.native._locate_skill = self.locate
        self.native.skill_view = lambda *_a, **_k: json.dumps({'success': True, 'content': SAFE.decode(), '_source_path': str(self.root / 'other' / 'SKILL.md')})
        with self.assertRaisesRegex(CognitionError, 'content_mismatch'): self.reader.read(self.body())

    def test_byte_budget_hardlinks_and_mutation_fail_closed(self):
        (self.skill / "SKILL.md").write_bytes(SAFE + b'x' * MAX_READ_BYTES)
        with self.assertRaisesRegex(CognitionError, 'read_limit'): self.reader.read(self.body())
        (self.skill / "SKILL.md").write_bytes(SAFE)
        linked = self.root / 'linked-copy'; os.link(self.skill / 'SKILL.md', linked)
        with self.assertRaisesRegex(CognitionError, 'path_link'): self.reader.read(self.body())
        linked.unlink()
        original = self.native.skill_view
        def changed(*args, **kwargs):
            result = original(*args, **kwargs); (self.skill / 'SKILL.md').write_bytes(SAFE + b'changed'); return result
        self.native.skill_view = changed
        with self.assertRaisesRegex(CognitionError, 'skill_changed'): self.reader.read(self.body())

    def test_symlink_skill_path_is_denied_before_native(self):
        target = self.skill / 'SKILL.md'; copy = self.root.parent / 'outside-skill.md'; copy.write_bytes(SAFE); target.unlink()
        try: target.symlink_to(copy)
        except OSError as error: self.skipTest('Host cannot create symlink fixture: ' + type(error).__name__)
        with self.assertRaisesRegex(CognitionError, 'path_link'): self.reader.read(self.body())
        self.assertEqual(self.calls, [])

    def test_native_loader_checks_pinned_source_bytes_before_admitting_interface(self):
        from cognition_bridge_fixture.cognition import _PINNED_BLOBS
        checkout = self.root.parent / 'pinned-checkout'
        for relative in _PINNED_BLOBS:
            destination = checkout / relative; destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((SOURCE.parents[1] / relative).read_bytes())
        self.native.__file__ = str(checkout / 'tools/skills_tool.py')
        with patch('cognition_bridge_fixture.cognition.importlib.util.find_spec', return_value=types.SimpleNamespace(origin=self.native.__file__)), patch('cognition_bridge_fixture.cognition.importlib.import_module', return_value=self.native) as importer:
            reader = NativeSkills.load(bridge=self.bridge, skills_root=self.root)
            self.assertTrue(reader.read(self.body())['ok'])
            (checkout / 'tools/skills_tool.py').write_bytes(b'drift')
            with self.assertRaisesRegex(CognitionError, 'pin_mismatch'): NativeSkills.load(bridge=self.bridge, skills_root=self.root)
            self.assertEqual(importer.call_count, 1, 'Drift must fail before importing/evaluating native source')

    def test_binding_guard_serializes_revocation_without_returning_credential(self):
        entered, release, revoked = threading.Event(), threading.Event(), threading.Event()
        original = self.native.skill_view
        def held(*args, **kwargs): entered.set(); self.assertTrue(release.wait(2)); return original(*args, **kwargs)
        self.native.skill_view = held
        output = []; read_thread = threading.Thread(target=lambda: output.append(self.reader.read(self.body())))
        read_thread.start(); self.assertTrue(entered.wait(2))
        revoke_thread = threading.Thread(target=lambda: (self.bridge.revoke_session('original-native-session'), revoked.set()))
        revoke_thread.start(); self.assertFalse(revoked.wait(0.05)); release.set(); read_thread.join(2); revoke_thread.join(2)
        self.assertTrue(revoked.is_set()); self.assertTrue(output[0]['ok']); self.assertNotIn('never-visible', json.dumps(output))
        with self.assertRaises(BindingConflict): self.reader.read(self.body())

    def test_registration_only_http_auth_body_and_optional_readiness(self):
        server = ManagementServer(self.bridge, ('127.0.0.1', 0), 'registration-key-' * 3, cognition=self.reader); server.start()
        opener = build_opener(ProxyHandler({})); base = 'http://127.0.0.1:' + str(server.address[1])
        def request(path, body=None, key='registration-key-' * 3):
            req = Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
            try:
                with opener.open(req, timeout=2) as response: return response.status, json.load(response)
            except HTTPError as response:
                with response: return response.code, json.load(response)
        try:
            self.assertTrue(request('/ready')[1]['cognitionSkills'])
            self.assertEqual(request('/cognition/read', self.body(), key='wrong')[0], 401)
            self.assertEqual(request('/cognition/read', self.body())[1]['value']['content'], SAFE.decode())
            self.assertEqual(request('/cognition/read', self.body(file_path='evil'))[0], 403)
            changed = request('/cognition/read', self.body(descriptors=[{**self.allowed, 'sha256': '0' * 64}]))
            self.assertEqual(changed, (409, {'ok': False, 'error': 'skill_source_changed'}))
            server.cognition = None
            self.assertFalse(request('/ready')[1]['cognitionSkills']); self.assertEqual(request('/cognition/read', self.body())[0], 503)
        finally: server.close()

    def test_nested_real_bridge_broker_management_http_chain_does_not_deadlock(self):
        registration_key = 'nested-registration-key-' * 3
        management = ManagementServer(self.bridge, ('127.0.0.1', 0), registration_key, cognition=self.reader); management.start()
        management_url = 'http://127.0.0.1:' + str(management.address[1])
        received = []; fixture = self
        class HostHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((self.path, self.headers['Authorization'], body))
                request = Request(management_url + '/cognition/read', data=json.dumps(fixture.body()).encode(),
                                  headers={'Authorization': 'Bearer ' + registration_key, 'Content-Type': 'application/json'})
                with build_opener(ProxyHandler({})).open(request, timeout=2) as reply: result = json.load(reply)
                raw = json.dumps(result).encode(); self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
        host = ThreadingHTTPServer(('127.0.0.1', 0), HostHandler); host.daemon_threads = True
        host_thread = threading.Thread(target=host.serve_forever, daemon=True); host_thread.start()
        client = BrokerHttpClient('http://127.0.0.1:' + str(host.server_address[1]) + '/tools/call', timeout=2)
        self.bridge._broker_call = client.call
        try:
            result = json.loads(self.bridge.handle({'name': 'learning.skills.view', 'args': {'skillId': self.allowed['id']}}, task_id='original-native-session'))
            self.assertTrue(result['ok']); self.assertEqual(result['value']['content'], SAFE.decode())
            self.assertEqual(len(received), 1); self.assertEqual(received[0][1], 'Bearer never-visible-scoped-token')
            self.assertEqual(self.calls[0][2]['task_id'], 'original-native-session')
            self.assertNotIn('never-visible-scoped-token', json.dumps(result)); self.assertNotIn(registration_key, json.dumps(result))
        finally:
            host.shutdown(); host.server_close(); host_thread.join(2); management.close()


if __name__ == '__main__':
    unittest.main()
