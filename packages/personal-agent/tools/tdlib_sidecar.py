#!/usr/bin/env python3
"""Pinned TDLib JSON C-interface bridge; Python 3.10+, standard library only.

stdin: one raw TDLib request object per UTF-8 line (@extra is opaque).
stdout: raw TDLib responses/updates, plus reserved neurobroSidecarStatus objects.
stderr: fixed diagnostic codes only, never requests, native errors, or secrets.

--doctor hashes an explicitly supplied file WITHOUT loading native code. It
cannot attest exported symbols, ABI compatibility, authorization, or connectivity.
Normal startup loads the pinned library, disables native logs, and creates one
client. It never supplies TDLib parameters, credentials, or authentication steps.

The main thread exclusively owns td_receive and td_execute; c_char_p copies
returned bytes before the next call invalidates TDLib's returned pointer.
Official contract: https://core.telegram.org/tdlib/docs/td__json__client_8h.html
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import signal
import sys
import threading
import time
from typing import Any

VERSION = "neurobro-tdlib-sidecar/1"
STATUS_TYPE = "neurobroSidecarStatus"
DEFAULT_MAX_LINE_BYTES = 1024 * 1024
RECEIVE_TIMEOUT_SECONDS = 0.05


class SidecarError(Exception):
    """Only fixed, non-sensitive codes may be used as exception arguments."""


def diagnostic(code: str) -> None:
    sys.stderr.write("tdlib_sidecar: " + code + "\n")
    sys.stderr.flush()


def write_object(obj: dict[str, Any]) -> None:
    data = json.dumps(obj, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    sys.stdout.buffer.write(data.encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


def status(state: str, **fields: Any) -> None:
    write_object({"@type": STATUS_TYPE, "state": state, "version": VERSION, **fields})


def reject_constant(_value: str) -> Any:
    raise SidecarError("invalid_json")


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise SidecarError("duplicate_json_key")
        obj[key] = value
    return obj


def decode_object(data: bytes) -> dict[str, Any]:
    try:
        obj = json.loads(data.decode("utf-8"), parse_constant=reject_constant,
                         object_pairs_hook=unique_object)
    except (UnicodeError, ValueError, RecursionError):
        raise SidecarError("invalid_json") from None
    if not isinstance(obj, dict) or not isinstance(obj.get("@type"), str) or not obj["@type"]:
        raise SidecarError("invalid_request_object")
    return obj


def verify_library(library: str, expected_sha256: str) -> tuple[Path, str]:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256):
        raise SidecarError("invalid_expected_sha256")
    try:
        path = Path(library).expanduser().resolve(strict=True)
        if not path.is_file():
            raise SidecarError("library_not_file")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except (OSError, RuntimeError):
        raise SidecarError("library_unreadable") from None
    actual_sha256 = digest.hexdigest()
    if actual_sha256 != expected_sha256.lower():
        raise SidecarError("library_sha256_mismatch")
    return path, actual_sha256


class TdJson:
    """Modern client-id C interface; all signatures come from td_json_client.h."""

    def __init__(self, path: Path) -> None:
        try:
            # Absolute path only; CDLL uses the C calling convention on Windows.
            self.library = ctypes.CDLL(str(path))
            self.create = self.library.td_create_client_id
            self.create.argtypes, self.create.restype = [], ctypes.c_int
            self.send = self.library.td_send
            self.send.argtypes, self.send.restype = [ctypes.c_int, ctypes.c_char_p], None
            self.receive = self.library.td_receive
            self.receive.argtypes, self.receive.restype = [ctypes.c_double], ctypes.c_char_p
            self.execute = self.library.td_execute
            self.execute.argtypes, self.execute.restype = [ctypes.c_char_p], ctypes.c_char_p
        except (OSError, AttributeError):
            raise SidecarError("native_library_or_api_unavailable") from None
        # td_execute is called only here, before the receiving loop starts.
        # logStreamEmpty avoids native diagnostics exposing message/auth payloads.
        result = self.execute(b'{"@type":"setLogStream","log_stream":{"@type":"logStreamEmpty"}}')
        if result is None or decode_object(result).get("@type") != "ok":
            raise SidecarError("native_log_suppression_failed")


def read_input(fd: int, inbox: queue.Queue[tuple[str, bytes | str]],
               stopping: threading.Event, max_line_bytes: int) -> None:
    """OS reads avoid a daemon holding buffered-stdin locks at Python shutdown."""
    def put(kind: str, value: bytes | str = b"") -> bool:
        while not stopping.is_set():
            try:
                inbox.put((kind, value), timeout=0.1)
                return True
            except queue.Full:
                pass
        return False

    pending = bytearray()
    try:
        while not stopping.is_set():
            chunk = os.read(fd, min(65536, max_line_bytes + 1))
            if not chunk:
                if pending:
                    if len(pending) > max_line_bytes:
                        put("error", "input_line_too_large")
                        return
                    if not put("request", bytes(pending)):
                        return
                put("eof")
                return
            pending.extend(chunk)
            while b"\n" in pending:
                offset = pending.index(b"\n")
                if offset > max_line_bytes:
                    put("error", "input_line_too_large")
                    return
                line = bytes(pending[:offset])
                del pending[:offset + 1]
                if not put("request", line):
                    return
            if len(pending) > max_line_bytes:
                put("error", "input_line_too_large")
                return
    except OSError:
        put("error", "stdin_read_failed")


def bridge(native: TdJson, close_timeout_seconds: float, max_line_bytes: int) -> int:
    client_id = native.create()
    if client_id <= 0:
        raise SidecarError("native_client_creation_failed")
    stopping = threading.Event()
    inbox: queue.Queue[tuple[str, bytes | str]] = queue.Queue(maxsize=16)
    reason = "native_closed"
    failure: str | None = None
    close_deadline: float | None = None
    close_sent = False
    first_request_sent = False
    closed = False
    output_available = True

    def on_signal(_signum: int, _frame: Any) -> None:
        stopping.set()

    previous_handlers: dict[int, Any] = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, on_signal)

    reader = threading.Thread(target=read_input, args=(sys.stdin.fileno(), inbox, stopping,
                                                     max_line_bytes), daemon=True,
                              name="tdlib-stdin")
    reader.start()

    def begin_close(new_reason: str) -> None:
        nonlocal close_deadline, close_sent, first_request_sent, reason
        if close_deadline is None:
            reason = new_reason
            stopping.set()
            close_deadline = time.monotonic() + close_timeout_seconds
        if not close_sent:
            close_sent = True
            native.send(client_id, b'{"@type":"close"}')
            first_request_sent = True

    try:
        try:
            status("ready", client_id=client_id)
        except (OSError, ValueError):
            output_available = False
            failure = "stdout_write_failed"
            begin_close(failure)
        while not closed:
            if stopping.is_set() and close_deadline is None:
                begin_close("signal")
            if close_deadline is None:
                # Bound each drain so incoming updates cannot be starved by stdin.
                for _ in range(16):
                    if stopping.is_set():
                        begin_close("signal")
                        break
                    try:
                        kind, value = inbox.get_nowait()
                    except queue.Empty:
                        break
                    if kind != "request":
                        if kind == "error":
                            failure = str(value)
                        begin_close("stdin_eof" if kind == "eof" else str(value))
                        break
                    try:
                        assert isinstance(value, bytes)
                        request = decode_object(value)
                        # Keep log suppression invariant for this dedicated process.
                        # addLogMessage may also force a fatal native abort.
                        if request["@type"] in ("setLogStream", "addLogMessage"):
                            raise SidecarError("native_logging_request_forbidden")
                        # Keep original bytes: numeric IDs and opaque @extra are untouched.
                        native.send(client_id, value)
                        first_request_sent = True
                        if request["@type"] == "close":
                            close_sent = True
                            begin_close("requested_close")
                            break
                    except SidecarError as exc:
                        failure = str(exc)
                        begin_close(failure)
                        break
            if not first_request_sent:
                # td_create_client_id remains dormant until the first request.
                # Do not synthesize authentication or parameter requests here.
                stopping.wait(RECEIVE_TIMEOUT_SECONDS)
                continue
            timeout = RECEIVE_TIMEOUT_SECONDS
            if close_deadline is not None:
                remaining = close_deadline - time.monotonic()
                if remaining <= 0:
                    failure = failure or "close_timeout"
                    break
                timeout = min(timeout, remaining)
            try:
                response = native.receive(timeout)
                if response is None:
                    continue
                obj = decode_object(response)
                # We own one client; accepting another client would mix account streams.
                if obj.get("@client_id") != client_id:
                    raise SidecarError("unexpected_native_client")
                auth = obj.get("authorization_state")
                closed = (obj["@type"] == "updateAuthorizationState" and
                          isinstance(auth, dict) and auth.get("@type") == "authorizationStateClosed")
                if output_available:
                    try:
                        # Native JSON can be pretty-printed. Remove only literal CR/LF;
                        # JSON strings contain escaped controls. Preserve number tokens.
                        sys.stdout.buffer.write(response.replace(b"\r", b"").replace(b"\n", b"") + b"\n")
                        sys.stdout.buffer.flush()
                    except (OSError, ValueError):
                        output_available = False
                        failure = failure or "stdout_write_failed"
                        begin_close(failure)
            except SidecarError as exc:
                failure = failure or str(exc)
                begin_close(failure)
    finally:
        stopping.set()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    if failure:
        diagnostic(failure)
    if output_available:
        try:
            status("closed", client_id=client_id, reason=reason,
                   authorization_closed=closed, close_sent=close_sent,
                   error_code=failure)
        except (OSError, ValueError):
            diagnostic("stdout_write_failed")
            return 2
    return 0 if closed and failure is None else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--library", required=True, help="Explicit existing tdjson shared-library file")
    parser.add_argument("--expected-sha256", required=True, help="Pinned library SHA-256 (64 hex characters)")
    parser.add_argument("--doctor", action="store_true", help="Check file/hash only; do not load native code")
    parser.add_argument("--close-timeout-seconds", type=float, default=10.0)
    parser.add_argument("--max-input-line-bytes", type=int, default=DEFAULT_MAX_LINE_BYTES)
    args = parser.parse_args(argv)
    try:
        if not math.isfinite(args.close_timeout_seconds) or not 0 < args.close_timeout_seconds <= 60:
            raise SidecarError("invalid_close_timeout")
        if not 1 <= args.max_input_line_bytes <= 16 * DEFAULT_MAX_LINE_BYTES:
            raise SidecarError("invalid_max_input_line_bytes")
        path, digest = verify_library(args.library, args.expected_sha256)
        if args.doctor:
            status("doctor", library_path=str(path), sha256=digest,
                   hash_verified=True, native_loaded=False, native_api_verified=False)
            return 0
        return bridge(TdJson(path), args.close_timeout_seconds, args.max_input_line_bytes)
    except SidecarError as exc:
        diagnostic(str(exc))
        try:
            status("failure", error_code=str(exc), authorization_closed=False)
        except (OSError, ValueError):
            pass
        return 2
    except (OSError, ValueError, RuntimeError):
        # Avoid Python tracebacks containing payloads, credentials, or native messages.
        diagnostic("sidecar_runtime_failure")
        try:
            status("failure", error_code="sidecar_runtime_failure", authorization_closed=False)
        except (OSError, ValueError):
            pass
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
