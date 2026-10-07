"""Trusted Hermes plugin seam; no native core patch or model-owned identity.

The trusted host calls bind_session BEFORE admitting a unique session to Hermes.
Never rebind a session to another admission, including after revocation. The
external broker still checks the token's grant/revision on every call.
"""
from __future__ import annotations

import base64
import json
import re
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable

HERMES_PIN = "8d5e3e412138342e8bf30443e72bd4e6a9abd057"
TOOL_NAME = "neurobro_tool"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_MULTIMODAL_BYTES = 12 * 1024 * 1024
SCHEMA = {
    "name": TOOL_NAME,
    "description": "Use a scoped Neurobro capability. Authority is checked by the broker.",
    "parameters": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "args": {"type": "object"}},
        "required": ["name", "args"],
        "additionalProperties": False,
    },
}


class BindingConflict(ValueError):
    """An admission attempted to replace an immutable trusted session binding."""


@dataclass(frozen=True)
class _Binding:
    admission_key: str
    credential: str = field(repr=False)


def unavailable(reason: str) -> dict[str, Any]:
    return {"ok": False, "error": reason}


def _validated_multimodal(value: dict[str, Any], credential: str) -> dict[str, Any]:
    """Only broker-authorized image bytes; never dereference URL/path fields."""
    if set(value) != {"_multimodal", "content", "text_summary"} or value.get("_multimodal") is not True:
        raise ValueError("Invalid multimodal envelope")
    parts, summary = value.get("content"), value.get("text_summary")
    if not isinstance(summary, str) or len(summary) > 4096 or not isinstance(parts, list) or len(parts) != 2:
        raise ValueError("Invalid multimodal envelope")
    text, image = parts
    if not isinstance(text, dict) or set(text) != {"type", "text"} or text.get("type") != "text" or text.get("text") != summary:
        raise ValueError("Invalid multimodal text")
    if not isinstance(image, dict) or set(image) != {"type", "image_url"} or image.get("type") != "image_url" or not isinstance(image["image_url"], dict) or set(image["image_url"]) != {"url"}:
        raise ValueError("Invalid multimodal image")
    url = image["image_url"].get("url")
    if not isinstance(url, str) or len(url) > (MAX_IMAGE_BYTES + 2) // 3 * 4 + 64:
        raise ValueError("Invalid multimodal image")
    match = re.fullmatch(r"data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})", url)
    if not match:
        raise ValueError("Only inline supported image bytes are accepted")
    raw = base64.b64decode(match.group(2), validate=True)
    if not raw or len(raw) > MAX_IMAGE_BYTES or base64.b64encode(raw).decode() != match.group(2):
        raise ValueError("Invalid multimodal image bytes")
    if credential.encode() in raw:
        raise ValueError("Image bytes contain a broker credential")
    signatures = {"image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"), "image/jpeg": raw.startswith(b"\xff\xd8\xff"),
                  "image/gif": raw.startswith((b"GIF87a", b"GIF89a")), "image/webp": raw.startswith(b"RIFF") and raw[8:12] == b"WEBP"}
    if not signatures[match.group(1)]:
        raise ValueError("Multimodal image MIME mismatch")
    return value


class Bridge:
    def __init__(self, broker_call: Callable[[str, dict[str, Any]], dict[str, Any]]):
        self._broker_call = broker_call
        self._bindings: dict[str, _Binding] = {}
        self._revoked: set[str] = set()
        self._lock = threading.RLock()

    def bind_session(self, session_id: str, idempotency_key: str, tool_context: str) -> None:
        """Trusted host API. Credential is opaque, never a prompt/schema field.

        Registration is process-local and intentionally loses availability on
        restart. Host must restore exact immutable bindings before tool calls;
        this store is not a durable task ledger or a scheduler.
        """
        if not all(isinstance(v, str) and v and len(v) <= 8192
                   for v in (session_id, idempotency_key, tool_context)):
            raise ValueError("Invalid trusted binding")
        candidate = _Binding(idempotency_key, tool_context)
        with self._lock:
            previous = self._bindings.get(session_id)
            if session_id in self._revoked or (previous is not None and previous != candidate):
                raise BindingConflict("Session bindings are immutable; use a new native session")
            self._bindings[session_id] = candidate

    def revoke_session(self, session_id: str) -> None:
        with self._lock:
            self._revoked.add(session_id)

    def assert_registered_session(self, session_id: str) -> None:
        """Trusted read seam: prove original identity without disclosing credentials."""
        with self._lock:
            if not isinstance(session_id, str) or session_id not in self._bindings or session_id in self._revoked:
                raise BindingConflict("trusted_run_context_unavailable")

    @contextmanager
    def registered_session(self, session_id: str):
        """Serialize read admission with revocation; yield no token or binding."""
        with self._lock:
            self.assert_registered_session(session_id)
            yield
            self.assert_registered_session(session_id)

    def handle(self, args: dict[str, Any], *, task_id: str = "", session_id: str = "") -> str | dict[str, Any]:
        """Hermes passes task_id as a runtime kwarg, separately from model args.

        Native /v1/runs uses effective_task_id = requested session_id or run_id.
        The agent's separately injected session_id can change during transcript
        compaction; use task_id exclusively, never fallback to a model field.
        """
        if not isinstance(args, dict) or set(args) != {"name", "args"}:
            return json.dumps(unavailable("invalid_tool_request"))
        if not isinstance(args["name"], str) or not args["name"] or not isinstance(args["args"], dict):
            return json.dumps(unavailable("invalid_tool_request"))
        with self._lock:
            binding = self._bindings.get(task_id) if isinstance(task_id, str) else None
            if binding is None or task_id in self._revoked:
                return json.dumps(unavailable("trusted_run_context_unavailable"))
        # The immutable snapshot is safe outside the lock. A broker capability
        # may synchronously call this plugin's management plane on another
        # thread (skills disclosure); holding the lock across HTTP deadlocks it.
        # The host validates current authority before and after every operation.
        # No retry after an ambiguous external result.
        try:
            result = self._broker_call(binding.credential, args)
        except Exception:
            # Exception text may contain transport headers or credentials.
            return json.dumps(unavailable("broker_transport_unknown"))
        if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
            return json.dumps(unavailable("broker_result_invalid"))
        # The broker result is the only model-visible response. It must not echo
        # credentials. Never return a credential from this adapter itself.
        try:
            encoded = json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            return json.dumps(unavailable("broker_result_invalid"))
        escaped_credential = json.dumps(binding.credential, ensure_ascii=False)[1:-1]
        if binding.credential in encoded or escaped_credential in encoded:
            return json.dumps(unavailable("broker_result_contains_credential"))
        value = result.get("value")
        if result["ok"] is True and isinstance(value, dict) and value.get("_multimodal") is True:
            if args["name"] != "artifacts.view_image":
                return json.dumps(unavailable("broker_multimodal_tool_not_allowed"))
            try:
                if len(encoded.encode()) > MAX_MULTIMODAL_BYTES:
                    raise ValueError()
                # Hermes registry preserves this DICT envelope and its executor
                # projects the image blocks into the active model conversation.
                validated = _validated_multimodal(value, binding.credential)
                with self._lock:
                    if task_id in self._revoked or self._bindings.get(task_id) != binding:
                        return json.dumps(unavailable("trusted_run_context_unavailable"))
                    return validated
            except (ValueError, TypeError):
                return json.dumps(unavailable("broker_multimodal_invalid"))
        if len(encoded.encode()) > 2 * 1024 * 1024:
            return json.dumps(unavailable("broker_result_too_large"))
        with self._lock:
            if task_id in self._revoked or self._bindings.get(task_id) != binding:
                return json.dumps(unavailable("trusted_run_context_unavailable"))
            return encoded


def register_plugin(ctx: Any, bridge: Bridge) -> None:
    ctx.register_tool(name=TOOL_NAME, toolset="neurobro", schema=SCHEMA,
                      handler=bridge.handle, description=SCHEMA["description"])


def readiness() -> dict[str, Any]:
    return {
        "hermesPin": HERMES_PIN,
        "trustedIdentity": "native_handler_task_id",
        "registration": "trusted_host_callable",
        "requiresUniqueAdmissionSession": True,
        "nativeHttpContextInjection": False,
        "cronResultManifest": False,
        "cronResultReason": "cron_execution_output_binding_unavailable",
    }


def cron_result(_job_id: str, _execution_id: str) -> dict[str, Any]:
    """Pinned Hermes has no supported completion hook binding ID to output.

    Do not scan timestamp-named cron output or infer identity from mtime.
    """
    return unavailable("cron_execution_output_binding_unavailable")
