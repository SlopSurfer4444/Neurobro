"""Connected loopback transport regressions; no live broker or profile access."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import socket
import sys
import threading
import unittest
from http.client import HTTPResponse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "test_hermes_management_transport", ROOT / "tools/hermes/__init__.py",
    submodule_search_locations=[str(ROOT / "tools/hermes")])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
from test_hermes_management_transport.management import BrokerHttpClient, ManagementServer
from test_hermes_management_transport.neurobro_bridge import Bridge


class BrokerTransportTests(unittest.TestCase):
    def setUp(self):
        self.received = []
        self.release = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.received.append((self.path, self.headers["Authorization"], request))
                if self.path == "/drop":
                    # The broker accepted the request before losing the reply.
                    self.close_connection = True
                    return
                if self.path == "/timeout":
                    outer.release.wait(1)
                    self.close_connection = True
                    return
                if self.path == "/slow-monitor":
                    # Exercise the historical 20s boundary with the real
                    # urllib socket, rather than only asserting a constant.
                    outer.release.wait(20.1)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/credential-leak")
                    self.end_headers()
                    return
                if self.path == "/denied":
                    self.send_response(403)
                    self.end_headers()
                    return
                if self.path == "/too-large":
                    raw = b'{"ok":false,"error":"arbitrary native exception local-scoped-token"}'
                    self.send_response(413)
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                raw = b'{"ok":true,"value":{"receipt":"local"}}'
                if self.path == "/public-failure":
                    outcome = request["args"]["outcome"]
                    raw = json.dumps({"ok": False, "error": "Inspect saved state before repeating the call.",
                                      "failure": {"code": "operation_failed",
                                                  "message": "Inspect saved state before repeating the call.",
                                                  "outcome": outcome}}).encode()
                if self.path == "/invalid-json":
                    raw = b'{"ok":true'
                elif self.path == "/invalid-envelope":
                    raw = b'[{"ok":true}]'
                self.send_response(200)
                if self.path != "/unframed":
                    self.send_header("Content-Length", str(len(raw) + (7 if self.path == "/truncated" else 0)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_address[1])

    def tearDown(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def call(self, path, timeout=1):
        return BrokerHttpClient(self.base + path, timeout=timeout).call(
            "local-scoped-token", {"name": "effect.synthetic", "args": {}})

    def test_complete_framed_and_eof_framed_receipts(self):
        for path in ("/complete", "/unframed"):
            with self.subTest(path=path):
                self.assertEqual(self.call(path), {"ok": True, "value": {"receipt": "local"}})

    def test_dropped_truncated_and_malformed_replies_remain_unknown_once(self):
        for path in ("/drop", "/truncated", "/invalid-json"):
            with self.subTest(path=path):
                before = len(self.received)
                self.assertEqual(self.call(path), {"ok": False, "error": "broker_transport_unknown"})
                self.assertEqual(len(self.received), before + 1)

    def test_socket_timeout_does_not_retry_possible_effect(self):
        self.assertEqual(self.call("/timeout", timeout=0.05), {"ok": False, "error": "broker_transport_unknown"})
        self.assertEqual([path for path, _, _ in self.received], ["/timeout"])

    def test_invalid_envelope_is_not_receipt(self):
        self.assertEqual(self.call("/invalid-envelope"), {"ok": False, "error": "broker_result_invalid"})

    def test_413_preserves_known_predispatch_outcome_without_error_body_or_retry(self):
        result = self.call("/too-large")
        self.assertEqual(result, {"ok": False, "error": "request_too_large", "failure": {
            "code": "request_too_large",
            "message": "Tool request exceeds the broker body limit. Read tools.describe before correcting the call.",
            "outcome": "not_dispatched"}})
        self.assertNotIn("local-scoped-token", json.dumps(result))
        self.assertNotIn("arbitrary native exception", json.dumps(result))
        self.assertEqual(len(self.received), 1)

    def test_public_failure_envelope_survives_client_and_registered_bridge(self):
        bridge = Bridge(BrokerHttpClient(self.base + "/public-failure").call)
        bridge.bind_session("native-local", "admission-local", "local-scoped-token")
        for outcome in ("not_dispatched", "read_failed", "unknown"):
            with self.subTest(outcome=outcome):
                result = json.loads(bridge.handle({"name": "effect.synthetic", "args": {"outcome": outcome}},
                                                 task_id="native-local"))
                self.assertEqual(result, {"ok": False, "error": "Inspect saved state before repeating the call.",
                                          "failure": {"code": "operation_failed",
                                                      "message": "Inspect saved state before repeating the call.",
                                                      "outcome": outcome}})
        self.assertEqual(len(self.received), 3)

    def test_scope_denial_and_redirect_never_forward_credentials(self):
        self.assertEqual(self.call("/denied"), {"ok": False, "error": "broker_scope_denied"})
        self.assertEqual(self.call("/redirect"), {"ok": False, "error": "broker_transport_unknown"})
        self.assertEqual([path for path, _, _ in self.received], ["/denied", "/redirect"])
        self.assertTrue(all(header == "Bearer local-scoped-token" for _, header, _ in self.received))

    def test_monitor_baseline_receipt_after_old_twenty_second_boundary(self):
        client = BrokerHttpClient(self.base + "/slow-monitor")
        result = client.call("local-scoped-token", {"name": "monitors.subscribe", "args": {}})
        self.assertEqual(result, {"ok": True, "value": {"receipt": "local"}})
        self.assertEqual(len(self.received), 1)

    def test_monitor_budget_and_explicit_override_are_passed_to_real_transport(self):
        for tool, explicit, expected in (("monitors.subscribe", None, 600),
                                         ("monitors.collect", None, 600),
                                         ("monitors.inspect", None, 60),
                                         ("telegram.history", None, 60),
                                         ("images.generate", None, 180),
                                         ("monitors.collect", 0.25, 0.25)):
            with self.subTest(tool=tool, explicit=explicit):
                client = BrokerHttpClient(self.base + "/complete", timeout=explicit)
                opener = client._opener.open
                observed = []
                def open_recorded(request, *, timeout):
                    observed.append(timeout)
                    return opener(request, timeout=timeout)
                client._opener.open = open_recorded
                self.assertTrue(client.call("local-scoped-token", {"name": tool, "args": {}})["ok"])
                self.assertEqual(observed, [expected])

    def test_explicit_short_monitor_deadline_stays_unknown_without_retry(self):
        client = BrokerHttpClient(self.base + "/timeout", timeout=0.05)
        self.assertEqual(client.call("local-scoped-token", {"name": "monitors.subscribe", "args": {}}),
                         {"ok": False, "error": "broker_transport_unknown"})
        self.assertEqual(len(self.received), 1)

    def test_image_timeout_stays_unknown_without_replaying_paid_operation(self):
        client = BrokerHttpClient(self.base + "/timeout", timeout=0.05)
        self.assertEqual(client.call("local-scoped-token", {"name": "images.generate", "args": {}}),
                         {"ok": False, "error": "broker_transport_unknown"})
        self.assertEqual(len(self.received), 1)

    def test_non_finite_or_non_positive_timeout_is_configuration_error(self):
        for value in (0, -1, float("inf"), float("nan"), True, "600"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                BrokerHttpClient(self.base + "/complete", timeout=value)


class RegistrationFramingTests(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge(lambda *_: {"ok": True})
        self.server = ManagementServer(self.bridge, ("127.0.0.1", 0), "x" * 32)
        self.server.start()
        self.body = json.dumps({"session_id": "s", "idempotency_key": "k", "tool_context": "local-token"}).encode()

    def tearDown(self):
        self.server.close()

    def post(self, lengths):
        with socket.create_connection(self.server.address, timeout=2) as connection:
            headers = ("POST /bindings HTTP/1.0\r\nAuthorization: Bearer " + "x" * 32 +
                       "\r\nContent-Type: application/json\r\n" +
                       "".join("Content-Length: " + str(length) + "\r\n" for length in lengths) + "\r\n")
            connection.sendall(headers.encode() + self.body)
            connection.shutdown(socket.SHUT_WR)
            response = HTTPResponse(connection)
            response.begin()
            return response.status, json.loads(response.read())

    def test_truncated_valid_json_does_not_register_binding(self):
        self.assertEqual(self.post([len(self.body) + 7]), (400, {"ok": False, "error": "invalid_binding_request"}))
        self.assertEqual(json.loads(self.bridge.handle({"name": "read", "args": {}}, task_id="s"))["error"],
                         "trusted_run_context_unavailable")

    def test_duplicate_lengths_are_rejected_without_registration(self):
        self.assertEqual(self.post([len(self.body), len(self.body)])[0], 400)
        self.assertEqual(json.loads(self.bridge.handle({"name": "read", "args": {}}, task_id="s"))["error"],
                         "trusted_run_context_unavailable")

    def test_exact_complete_binding_remains_idempotent(self):
        for _ in range(2):
            self.assertEqual(self.post([len(self.body)]), (200, {"ok": True, "session_id": "s"}))


if __name__ == "__main__":
    unittest.main()
