"""Registration-only loopback endpoint, not a broker master capability.

Host authority registers immutable per-admission scoped credentials. This key
cannot execute broker tools. Engine plugin tools hold no Telegram credentials.
Runtime shell/code must be isolated from the plugin process environment and
memory; an all-powerful same-user terminal invalidates that isolation boundary.
"""
from __future__ import annotations

import hmac
import ipaddress
import json
import math
import threading
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .neurobro_bridge import BindingConflict, Bridge, readiness, unavailable


def parse_bind(value: str) -> tuple[str, int]:
    parsed = urlsplit("http://" + value)
    if parsed.hostname != "127.0.0.1" or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("Bridge management must bind numeric IPv4 loopback")
    if not parsed.port or not 1 <= parsed.port <= 65535:
        raise ValueError("Bridge port required")
    return "127.0.0.1", parsed.port


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BrokerHttpClient:
    def __init__(self, url: str, timeout: float | None = None):
        parsed = urlsplit(url)
        try:
            loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
        except ValueError:
            loopback = False
        if (parsed.scheme != "http" or not loopback or parsed.username or parsed.password
                or parsed.query or parsed.fragment or not parsed.port):
            raise ValueError("Broker tool URL must be explicit numeric loopback HTTP")
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
                                    or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError("Broker timeout must be positive and finite")
        self._url = url
        self._timeout = timeout
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    def call(self, credential: str, request: dict) -> dict:
        req = Request(self._url, data=json.dumps(request).encode(), method="POST",
                      headers={"Content-Type": "application/json", "Authorization": "Bearer " + credential})
        # No retry: transport failure may occur after an effect succeeds.
        # Monitoring can read up to sixteen sources with 30s TDLib requests.
        # A finite larger wait avoids abandoning the normal baseline at 20s;
        # slower runs can still expire and require durable state reconciliation.
        # Ordinary tools may await a 30s TDLib request or a 20s artifact read;
        # image generation has a 120s provider budget before artifact storage.
        # An explicit caller deadline always wins, including for these tools.
        timeout = self._timeout if self._timeout is not None else (
            600 if request.get("name") in {"monitors.subscribe", "monitors.collect"}
            else 180 if request.get("name") == "images.generate" else 60)
        try:
            response = self._opener.open(req, timeout=timeout)
        except HTTPError as exc:
            code = exc.code
            exc.close()
            if code == 413:
                # The broker's body limiter rejects before tool dispatch. Do
                # not reflect an arbitrary error body or retry the operation.
                return {"ok": False, "error": "request_too_large", "failure": {
                    "code": "request_too_large",
                    "message": "Tool request exceeds the broker body limit. Read tools.describe before correcting the call.",
                    "outcome": "not_dispatched"}}
            if code in (401, 403):
                return unavailable("broker_scope_denied")
            return unavailable("broker_transport_unknown")
        except (URLError, OSError, HTTPException):
            return unavailable("broker_transport_unknown")
        # Only the authorized image-view response may carry the larger pixel
        # envelope. Ordinary tools and schedule routes retain the 2 MiB cap.
        multimedia = request.get("name") == "artifacts.view_image"
        limit = (12 if multimedia else 2) * 1024 * 1024
        try:
            with response:
                raw = response.read(limit + 1)
                # Bounded urllib reads do not raise IncompleteRead when EOF
                # arrives early. Even valid JSON is not a complete receipt if
                # the HTTP body was truncated after a possible broker effect.
                getheader = getattr(response, "getheader", None)
                declared = getheader("Content-Length") if getheader else None
        except (URLError, OSError, HTTPException):
            return unavailable("broker_transport_unknown")
        if len(raw) > limit:
            return unavailable("broker_result_too_large")
        if declared is not None:
            try:
                if not declared.isascii() or not declared.isdecimal() or int(declared) != len(raw):
                    return unavailable("broker_transport_unknown")
            except (ValueError, TypeError):
                return unavailable("broker_transport_unknown")
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            return unavailable("broker_transport_unknown")
        if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
            return unavailable("broker_result_invalid")
        if len(raw) > 2 * 1024 * 1024 and not (isinstance(result, dict) and result.get("ok") is True and isinstance(result.get("value"), dict) and result["value"].get("_multimodal") is True):
            return unavailable("broker_result_too_large")
        return result


class ManagementServer:
    def __init__(self, bridge: Bridge, bind: tuple[str, int], registration_key: str, cognition=None):
        if bind[0] != "127.0.0.1" or not isinstance(registration_key, str) or len(registration_key) < 32:
            raise ValueError("Explicit loopback binding and strong registration key required")
        self.bridge = bridge
        self.cognition = cognition
        self._registration_key = registration_key
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *_args):
                pass  # Never log headers, bodies, tokens or request URLs.

            def _reply(self, code: int, body: dict):
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _authorized(self):
                actual = self.headers.get("Authorization", "")
                expected = "Bearer " + outer._registration_key
                if not hmac.compare_digest(actual.encode(), expected.encode()):
                    self._reply(401, unavailable("registration_denied"))
                    return False
                return True

            def do_GET(self):
                if not self._authorized():
                    return
                if self.path == "/ready":
                    from .cognition import readiness as cognition_readiness
                    self._reply(200, {"ok": True, **readiness(), **cognition_readiness(outer.cognition)})
                else:
                    self._reply(404, unavailable("unknown_bridge_route"))

            def do_POST(self):
                if not self._authorized():
                    return
                if self.path not in ("/bindings", "/cognition/read"):
                    self._reply(404, unavailable("unknown_bridge_route"))
                    return
                try:
                    if len(self.headers.get_all("Content-Length", [])) != 1:
                        raise ValueError()
                    length = int(self.headers.get("Content-Length", "0"))
                    maximum = 262144 if self.path == "/cognition/read" else 32768
                    if length <= 0 or length > maximum or self.headers.get("Content-Type") != "application/json" or self.headers.get("Transfer-Encoding") or self.headers.get("Origin"):
                        raise ValueError()
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError()
                    body = json.loads(raw)
                    if self.path == "/cognition/read":
                        if outer.cognition is None:
                            self._reply(503, unavailable("cognition_native_unavailable"))
                            return
                        from .cognition import CognitionError
                        try:
                            result = outer.cognition.read(body)
                        except CognitionError as error:
                            changed = str(error) in {"cognition_skill_hash_mismatch", "cognition_skill_changed", "cognition_native_content_mismatch", "cognition_native_resolution_mismatch"}
                            self._reply(409 if changed else 403, unavailable("skill_source_changed" if changed else str(error)))
                            return
                        except BindingConflict:
                            self._reply(403, unavailable("trusted_run_context_unavailable"))
                            return
                        except Exception:
                            self._reply(503, unavailable("cognition_native_unavailable"))
                            return
                        self._reply(200, result)
                        return
                    if not isinstance(body, dict) or set(body) != {"session_id", "idempotency_key", "tool_context"}:
                        raise ValueError()
                    bridge.bind_session(body["session_id"], body["idempotency_key"], body["tool_context"])
                except BindingConflict:
                    self._reply(409, unavailable("immutable_binding_conflict"))
                    return
                except (OSError, HTTPException):
                    self._reply(408, unavailable("binding_request_incomplete"))
                    return
                except (ValueError, TypeError, KeyError):
                    self._reply(400, unavailable("invalid_binding_request"))
                    return
                self._reply(200, {"ok": True, "session_id": body["session_id"]})

            def setup(self):
                super().setup()
                self.connection.settimeout(10)

        self._server = ThreadingHTTPServer(bind, Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        name="neurobro-bridge-registration", daemon=True)

    @property
    def address(self) -> tuple[str, int]:
        return self._server.server_address

    def start(self):
        self._thread.start()

    def close(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)
